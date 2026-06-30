// ==UserScript==
// @name         KHinsider Console Catalogue Downloader
// @namespace    https://downloads.khinsider.com/
// @version      1.4
// @description  Download an ENTIRE console's catalogue from KHinsider, one ZIP per album. Runs inside your real browser so it passes Cloudflare. MP3 preferred, FLAC/OGG selectable. Resumable.
// @author       voyd (built on Lolen10's batch downloader)
// @match        https://downloads.khinsider.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      vgmsite.com
// @connect      *.vgmsite.com
// @connect      vgmtreasurechest.com
// @connect      *.vgmtreasurechest.com
// @connect      downloads.khinsider.com
// @connect      self
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// ==/UserScript==

(function () {
    'use strict';
    console.log('[KHI] Console Downloader v1.4 loaded on', location.href);

    // ---- Tunables -----------------------------------------------------------
    const SONG_WORKERS = 4;        // concurrent song downloads within one album
    const ALBUM_DELAY_MS = 1500;   // pause between albums (be polite to the server)
    const PAGE_DELAY_MS = 5000;    // pause between listing-page fetches (avoid Cloudflare rate-limit)
    const PAGE_RETRY_BACKOFF = [8000, 18000, 35000]; // waits before each retry on a failed page
    const PAGE_CAP = 300;          // safety cap on pagination pages
    const ZIP_LEVEL = 0;           // 0 = store (audio is already compressed)
    const REQUEST_TIMEOUT = 60000;

    // ---- Low-level fetch (rides your Cloudflare-cleared session) -------------
    function gmFetch(url, responseType = 'text', referer = location.href) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType,
                timeout: REQUEST_TIMEOUT,
                onload: (r) => (r.status >= 200 && r.status < 400) ? resolve(r) : reject(new Error('HTTP ' + r.status + ' for ' + url)),
                onerror: () => reject(new Error('Network error for ' + url)),
                ontimeout: () => reject(new Error('Timeout for ' + url)),
            });
        });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const parseHtml = (text) => new DOMParser().parseFromString(text, 'text/html');
    const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

    // ---- Console-page parsing (the only "new" logic; Scan verifies it) -------
    function isConsolePage() {
        if (/\/game-soundtracks\/album\//.test(location.pathname)) return false;
        return document.querySelectorAll('a[href*="/game-soundtracks/album/"]').length >= 3;
    }

    function albumLinksFrom(doc, base) {
        const out = new Map(); // url -> name
        doc.querySelectorAll('a[href*="/game-soundtracks/album/"]').forEach((a) => {
            const url = abs(a.getAttribute('href'), base);
            if (!url) return;
            // normalise (drop hash/query)
            const clean = url.split('#')[0].split('?')[0];
            if (!/\/game-soundtracks\/album\//.test(clean)) return;
            if (!out.has(clean)) out.set(clean, (a.textContent || '').trim());
        });
        return out;
    }

    // Fetch a listing page with the PAGE's own fetch() (credentials included), which
    // rides the Cloudflare clearance for same-origin requests. Note: GM_xmlhttpRequest
    // gets 403 on `?page=` listing URLs and same-origin iframing is blocked, but a
    // plain same-origin fetch passes — verified against downloads.khinsider.com.
    async function fetchListingDoc(url) {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return parseHtml(await r.text());
    }

    // Fetch a listing page, backing off and retrying on a (likely rate-limit) failure.
    async function fetchListingWithRetry(url, n, log) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fetchListingDoc(url);
            } catch (e) {
                if (attempt >= PAGE_RETRY_BACKOFF.length) throw e;
                const wait = PAGE_RETRY_BACKOFF[attempt];
                log(`  page ${n}: ${e.message} — backing off ${wait / 1000}s and retrying…`);
                await sleep(wait);
            }
        }
    }

    function looksBlocked(doc) {
        const t = (doc.title || '').toLowerCase();
        return /just a moment|attention required|sorry, you have been blocked|cloudflare|forbidden/.test(t);
    }

    // Walk ?page=1,2,3,… until a page adds no NEW albums. This needs no pager markup
    // and is robust to whatever the site does past the last page (empty / repeat /
    // wrap) — all of those add zero new albums after dedup, so the loop stops.
    async function scanConsole(log) {
        const albums = new Map();
        const base = location.origin + location.pathname;                 // strip any ?page
        const onPageOne = (new URL(location.href).searchParams.get('page') || '1') === '1';
        let lastPage = 0;

        for (let n = 1; n <= PAGE_CAP; n++) {
            const url = n === 1 ? base : `${base}?page=${n}`;
            let doc;
            if (n === 1 && onPageOne) {
                doc = document;          // already loaded & Cloudflare-cleared
            } else {
                await sleep(PAGE_DELAY_MS);   // pace requests so Cloudflare doesn't rate-limit us
                try {
                    doc = await fetchListingWithRetry(url, n, log);
                } catch (e) {
                    log(`  page ${n}: fetch failed (${e.message}); stopping here.`);
                    break;
                }
            }
            if (looksBlocked(doc)) { log(`  page ${n}: blocked/empty; stopping here.`); break; }

            const before = albums.size;
            for (const [u, name] of albumLinksFrom(doc, url)) if (!albums.has(u)) albums.set(u, name);
            const added = albums.size - before;
            lastPage = n;
            log(`  page ${n}: +${added} albums (total ${albums.size})`);
            if (added === 0) { log('  no new albums — reached the end.'); break; }
        }
        return { albums: Array.from(albums.entries()), pages: lastPage };
    }

    // ---- Album / song parsing (reused from the proven batch downloader) ------
    function songPageLinks(albumDoc) {
        const table = albumDoc.getElementById('songlist');
        if (!table) return [];
        const rows = Array.from(table.querySelectorAll('tbody tr'))
            .filter((r) => r.id !== 'songlist_header' && r.id !== 'songlist_footer');
        const SONG_COL = 3;
        return rows.map((row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length <= SONG_COL) return null;
            const a = cells[SONG_COL].querySelector('a');
            return a ? abs(a.getAttribute('href'), location.origin) : null;
        }).filter((u) => u && new URL(u).origin === location.origin);
    }

    function fileUrlForFormat(songHtml, extOrder) {
        for (const ext of extOrder) {
            const m = songHtml.match(new RegExp(`href="([^"]*?\\.${ext})"`, 'i'));
            if (m) return { url: m[1], ext };
        }
        return null;
    }

    function fileNameFromUrl(fileUrl) {
        return decodeURIComponent(fileUrl.split('/').pop())
            .replace(/%25(\w{2})/g, (m, code) => '%' + code);
    }

    async function parallel(items, concurrency, worker, shouldStop) {
        const queue = [...items];
        const run = async () => {
            while (queue.length && !shouldStop()) await worker(queue.shift());
        };
        await Promise.all(Array(concurrency).fill(0).map(run));
    }

    // ---- Download one album into a single ZIP -------------------------------
    async function downloadAlbum(albumUrl, extOrder, consoleName, ui, shouldStop) {
        const res = await gmFetch(albumUrl, 'text');
        const albumDoc = parseHtml(res.responseText);
        const h2 = albumDoc.querySelector('h2');
        const albumName = (h2 ? h2.textContent : albumUrl.split('/').pop()).trim();

        const songs = songPageLinks(albumDoc);
        if (!songs.length) return { albumName, files: 0, errors: 0, skipped: true };

        const zipFiles = {};
        const seen = new Set();
        let files = 0, errors = 0, done = 0;

        await parallel(songs, SONG_WORKERS, async (songUrl) => {
            try {
                const page = await gmFetch(songUrl, 'text', albumUrl);
                const found = fileUrlForFormat(page.responseText, extOrder);
                done++;
                if (!found) { ui.song(albumName, done, songs.length, files, errors); return; }
                if (seen.has(found.url)) return;
                seen.add(found.url);
                const bin = await gmFetch(found.url, 'arraybuffer', songUrl);
                zipFiles[fileNameFromUrl(found.url)] = new Uint8Array(bin.response);
                files++;
                ui.song(albumName, done, songs.length, files, errors);
            } catch (e) {
                console.error('[KHI] song failed', songUrl, e);
                errors++; done++;
                ui.song(albumName, done, songs.length, files, errors);
            }
        }, shouldStop);

        if (files === 0) return { albumName, files: 0, errors, skipped: true };

        const zipData = fflate.zipSync(zipFiles, { level: ZIP_LEVEL });
        const blob = new Blob([zipData], { type: 'application/zip' });
        const safe = (s) => s.replace(/[\/\\:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 120);
        triggerDownload(blob, `${safe(consoleName)}__${safe(albumName)}_${extOrder[0]}.zip`);
        return { albumName, files, errors, skipped: false };
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    // ---- Resume state -------------------------------------------------------
    const doneKey = () => 'khi_done::' + location.pathname;
    const loadDone = () => new Set(JSON.parse(GM_getValue(doneKey(), '[]')));
    const saveDone = (set) => GM_setValue(doneKey(), JSON.stringify(Array.from(set)));

    // ---- UI -----------------------------------------------------------------
    function buildUI() {
        const panel = document.createElement('div');
        panel.id = 'khi-console-dl';
        Object.assign(panel.style, {
            position: 'fixed', top: '12px', right: '12px', zIndex: 999999,
            width: '320px', background: '#fff', border: '2px solid #333',
            borderRadius: '8px', padding: '12px', font: '13px/1.4 sans-serif',
            color: '#111', boxShadow: '0 4px 16px rgba(0,0,0,.25)',
        });
        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px;">KHinsider Console Downloader</div>
            <label>Format:
              <select id="khi-fmt">
                <option value="mp3">MP3</option>
                <option value="flac">FLAC (fall back to MP3)</option>
                <option value="ogg">OGG (fall back to MP3)</option>
              </select>
            </label>
            <div style="margin:8px 0;">
              <button id="khi-scan">1. Scan console</button>
              <button id="khi-start" disabled>2. Download all</button>
              <button id="khi-stop" disabled>Stop</button>
            </div>
            <div id="khi-status" style="white-space:pre-wrap;max-height:220px;overflow:auto;
                 background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:6px;font-family:monospace;font-size:11px;"></div>
            <div style="margin-top:6px;">
              <button id="khi-reset" style="font-size:11px;">Reset resume progress for this console</button>
            </div>`;
        document.body.appendChild(panel);
        return panel;
    }

    function makeLogger(el) {
        const lines = [];
        return {
            log: (s) => { lines.push(s); el.textContent = lines.slice(-200).join('\n'); el.scrollTop = el.scrollHeight; },
            set: (s) => { el.textContent = s; },
        };
    }

    // ---- Wire up ------------------------------------------------------------
    function init() {
        if (!isConsolePage() || document.getElementById('khi-console-dl')) return;

        const panel = buildUI();
        const statusEl = panel.querySelector('#khi-status');
        const logger = makeLogger(statusEl);
        const $ = (id) => panel.querySelector(id);

        let scanned = null;     // { albums, pages }
        let stopFlag = false;
        const shouldStop = () => stopFlag;

        const consoleName = (document.querySelector('h2')?.textContent
            || document.title.replace(/\s*-\s*.*$/, '')).trim();

        logger.log(`Console: ${consoleName}`);
        logger.log('Click "Scan console" to enumerate albums.');

        $('#khi-scan').onclick = async () => {
            $('#khi-scan').disabled = true;
            logger.log('\nScanning…');
            try {
                scanned = await scanConsole((s) => logger.log(s));
                logger.log(`\nFound ${scanned.albums.length} albums across ${scanned.pages} page(s).`);
                logger.log('First few:');
                scanned.albums.slice(0, 8).forEach(([, n], i) => logger.log(`  ${i + 1}. ${n || '(untitled)'}`));
                const already = loadDone().size;
                if (already) logger.log(`\n${already} already completed (will be skipped). Use Reset to redo.`);
                $('#khi-start').disabled = scanned.albums.length === 0;
            } catch (e) {
                logger.log('Scan failed: ' + e.message);
            } finally {
                $('#khi-scan').disabled = false;
            }
        };

        $('#khi-start').onclick = async () => {
            if (!scanned) return;
            const fmt = $('#khi-fmt').value;
            const extOrder = fmt === 'mp3' ? ['mp3'] : [fmt, 'mp3'];
            stopFlag = false;
            $('#khi-start').disabled = true; $('#khi-scan').disabled = true;
            $('#khi-stop').disabled = false;

            const done = loadDone();
            const todo = scanned.albums.filter(([u]) => !done.has(u));
            logger.log(`\n=== Downloading ${todo.length} album(s) as ${extOrder[0].toUpperCase()} ===`);

            let i = 0, totalFiles = 0, totalErr = 0;
            const ui = {
                song: (album, d, total, f, e) =>
                    logger.set(`[${i}/${todo.length}] ${album}\n  songs ${d}/${total} | files ${f} | errors ${e}` +
                               `\n\nTotal so far: ${totalFiles} files, ${totalErr} errors`),
            };

            for (const [url, name] of todo) {
                if (stopFlag) { logger.log('\nStopped by user.'); break; }
                i++;
                logger.log(`\n[${i}/${todo.length}] ${name || url}`);
                try {
                    const r = await downloadAlbum(url, extOrder, consoleName, ui, shouldStop);
                    if (stopFlag && r.files === 0) { logger.log('  (stopped mid-album, not marked done)'); break; }
                    totalFiles += r.files; totalErr += r.errors;
                    logger.log(`  -> ${r.skipped ? 'no files' : r.files + ' files zipped'}${r.errors ? ' (' + r.errors + ' errors)' : ''}`);
                    if (!r.skipped) { done.add(url); saveDone(done); }
                } catch (e) {
                    totalErr++;
                    logger.log('  album failed: ' + e.message);
                }
                if (!stopFlag) await sleep(ALBUM_DELAY_MS);
            }

            logger.log(`\nDone. ${totalFiles} files across albums, ${totalErr} errors.`);
            $('#khi-stop').disabled = true; $('#khi-scan').disabled = false;
            $('#khi-start').disabled = false;
        };

        $('#khi-stop').onclick = () => { stopFlag = true; logger.log('\nStopping after current downloads…'); };

        $('#khi-reset').onclick = () => {
            GM_deleteValue(doneKey());
            logger.log('\nResume progress cleared for this console.');
        };
    }

    // ---- Bootstrap (robust against Tampermonkey document-idle timing) -------
    function bootstrap() {
        if (document.getElementById('khi-console-dl')) return true;
        const albumLinks = document.querySelectorAll('a[href*="/game-soundtracks/album/"]').length;
        console.log(`[KHI] bootstrap: path=${location.pathname} readyState=${document.readyState} albumLinks=${albumLinks} isConsolePage=${isConsolePage()}`);
        if (isConsolePage()) { init(); return true; }
        return false;
    }

    if (!bootstrap()) {
        // Content may not be present yet on first pass; retry briefly, then stop.
        let n = 0;
        const iv = setInterval(() => { if (bootstrap() || ++n > 10) clearInterval(iv); }, 500);
        window.addEventListener('load', bootstrap);
    }
})();
