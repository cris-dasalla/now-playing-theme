// Injected into VS Code's workbench.html by the Now Playing Theme extension.
// Polls npt/state.json (written by the extension) and shows the current cover art - or the song's
// music video when one has been saved - as a faint overlay. Only fetch / style / media APIs are used:
// none are Trusted Types sinks, and local media is allowed by VS Code's CSP (media-src 'self').
(() => {
    'use strict';
    // This file lives in npt/ itself, so resolve relative to the script (fallback: workbench.html + npt/).
    const base = document.currentScript ? new URL('./', document.currentScript.src) : new URL('./npt/', location.href);
    const POLL_MS = 1000;
    const RESYNC_MS = 5000;
    const DRIFT_SEC = 1.5;
    const LOOP_LEN_SEC = 30;

    const css = `
#npt-bg { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; opacity: 0;
          transition: opacity 0.9s ease; overflow: hidden; }
#npt-bg > * { position: absolute; inset: 0; }
#npt-bg .npt-fill { inset: -10%; background: no-repeat center / cover; filter: blur(40px) saturate(1.3); }
#npt-bg .npt-art  { background: no-repeat right center / contain;
                    -webkit-mask-image: linear-gradient(to left, #000 45%, transparent 95%); }
#npt-bg .npt-video { width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.9s ease; }
#npt-bg[data-style="blurred"] .npt-art { display: none; }
#npt-bg[data-style="sharp"] .npt-fill { display: none; }
#npt-bg[data-style="sharp"] .npt-art { background-size: cover; background-position: center; -webkit-mask-image: none; }
#npt-bg[data-style="poster"] .npt-fill { opacity: 0.6; }
#npt-bg[data-video="on"] .npt-video { opacity: 1; }
#npt-bg[data-video="on"] .npt-fill, #npt-bg[data-video="on"] .npt-art { opacity: 0; transition: opacity 0.9s ease; }`;

    let root, fill, art, video, lastJson = '', current = '', state = null, videoFile = '';

    function ensureDom() {
        if (root && root.isConnected) { return; }
        if (!document.body) { return; }
        if (!document.getElementById('npt-style')) {
            const style = document.createElement('style');
            style.id = 'npt-style';
            style.textContent = css;
            document.head.appendChild(style);
        }
        root = document.createElement('div');
        root.id = 'npt-bg';
        fill = document.createElement('div'); fill.className = 'npt-fill';
        art = document.createElement('div'); art.className = 'npt-art';
        video = document.createElement('video'); video.className = 'npt-video';
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        video.addEventListener('playing', () => { if (state && state.video) { root.dataset.video = 'on'; } });
        video.addEventListener('timeupdate', loopSlice);
        video.addEventListener('error', () => { root.dataset.video = 'off'; });
        root.append(fill, art, video);
        document.body.appendChild(root);
        current = ''; videoFile = '';
        lastJson = ''; // fresh element: force the next poll to re-apply state
    }

    // ---------- cover ----------

    function showCover(s, opacity) {
        if (!s.cover || s.cover === current) { return; }
        // Preload, fade out, swap, fade in - avoids a flash of the old/empty image.
        const url = new URL(s.cover, base).href;
        const img = new Image();
        img.onload = () => {
            const hasVideo = root.dataset.video === 'on';
            if (!hasVideo) { root.style.opacity = '0'; }
            setTimeout(() => {
                const bg = `url("${url}")`;
                fill.style.backgroundImage = bg;
                art.style.backgroundImage = bg;
                current = s.cover;
                root.style.opacity = opacity;
            }, current && !hasVideo ? 500 : 0);
        };
        img.src = url;
    }

    // ---------- video ----------

    /** Where the song is now, in seconds (null when the app reports no position). */
    function songTime(v) {
        if (v.positionMs == null) { return null; }
        return (v.positionMs + (v.playing ? Date.now() - v.capturedAt : 0)) / 1000;
    }

    function loopStart() { return video.duration > LOOP_LEN_SEC * 2 ? video.duration * 0.3 : 0; }

    function loopSlice() {
        const v = state && state.video;
        if (!v || v.mode !== 'loop' || !isFinite(video.duration)) { return; }
        const start = loopStart(), end = Math.min(video.duration - 0.2, start + LOOP_LEN_SEC);
        if (video.currentTime >= end || video.currentTime < start - 1) { video.currentTime = start; }
    }

    function syncVideo() {
        const v = state && state.video;
        if (!v || !video || !isFinite(video.duration) || video.readyState < 1) { return; }
        if (v.mode === 'full') {
            const t = songTime(v);
            if (t != null) {
                const target = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.1));
                if (Math.abs(video.currentTime - target) > DRIFT_SEC) { video.currentTime = target; }
            }
        }
        if (v.playing && video.paused) { video.play().catch(() => { /* retried next resync */ }); }
        if (!v.playing && !video.paused) { video.pause(); }
    }

    function showVideo(s) {
        const v = s.video;
        if (!v) {
            if (videoFile) { video.pause(); video.removeAttribute('src'); video.load(); videoFile = ''; }
            root.dataset.video = 'off';
            return;
        }
        if (v.file !== videoFile) {
            videoFile = v.file;
            root.dataset.video = 'off';            // cover stays up until the first frame plays
            video.src = new URL(v.file, base).href;
            video.addEventListener('loadedmetadata', () => {
                if (v.mode === 'loop') { video.currentTime = loopStart(); }
                syncVideo();
            }, { once: true });
            return;
        }
        syncVideo();
    }

    // ---------- state ----------

    function show(s) {
        ensureDom();
        if (!root) { return; }
        state = s;
        root.dataset.style = s.style || 'poster';
        if (!s.visible) { root.style.opacity = '0'; showVideo({}); return; }
        const opacity = String(Math.min(0.8, Math.max(0.02, Number(s.opacity) || 0.2)));
        if (current || s.video) { root.style.opacity = opacity; }
        showCover(s, opacity);
        showVideo(s);
    }

    async function poll() {
        try {
            const res = await fetch(new URL('state.json?t=' + Date.now(), base).href, { cache: 'no-store' });
            const text = await res.text();
            if (text !== lastJson) { lastJson = text; show(JSON.parse(text)); }
            else { ensureDom(); }
        } catch {
            // state.json missing or mid-write: try again next tick.
        }
        setTimeout(poll, POLL_MS);
    }

    setInterval(syncVideo, RESYNC_MS);
    poll();
})();
