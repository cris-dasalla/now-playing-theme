// Music-video background: find the song's video on YouTube, save a small muted H.264 copy with yt-dlp,
// and keep a size-capped cache. VS Code's bundled ffmpeg plays H.264/VP8 but NOT VP9/AV1, hence avc1.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { TOOL_DIR } from './paths';

export type VideoMode = 'full' | 'loop';

export interface TrackInfo { title?: string; artist?: string; source?: string; durationMs?: number | null }

/** From "id|durationSec" search lines, pick the one whose length best matches the song (within 20 s), else the top hit. */
export function pickBest(lines: string[], durationMs?: number | null): string | undefined {
    const hits = lines.map(l => l.trim().split('|')).filter(p => /^[\w-]{11}$/.test(p[0]))
        .map(p => ({ id: p[0], dur: Number(p[1]) }));
    if (!hits.length) { return undefined; }
    if (durationMs) {
        const song = durationMs / 1000;
        const close = hits.filter(h => isFinite(h.dur) && Math.abs(h.dur - song) <= 20)
            .sort((a, b) => Math.abs(a.dur - song) - Math.abs(b.dur - song));
        if (close.length) { return close[0].id; }
    }
    return hits[0].id;
}

export const YTDLP = path.join(TOOL_DIR, 'yt-dlp.exe');
const INDEX = path.join(TOOL_DIR, 'video-index.json');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

const FORMATS: Record<VideoMode, string> = {
    full: 'bv*[height<=360][vcodec^=avc1]/bv*[height<=480][vcodec^=avc1]',
    loop: 'bv*[height<=144][vcodec^=avc1]/bv*[height<=240][vcodec^=avc1]/bv*[height<=360][vcodec^=avc1]',
};

export function hasYtDlp() { return fs.existsSync(YTDLP); }

/** Downloads yt-dlp.exe from its official GitHub release (follows redirects). */
export async function downloadYtDlp(): Promise<void> {
    fs.mkdirSync(TOOL_DIR, { recursive: true });
    const tmp = YTDLP + '.download';
    await new Promise<void>((resolve, reject) => {
        const get = (url: string, hops: number) => https.get(url, { headers: { 'user-agent': 'now-playing-theme' } }, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
                res.resume(); get(res.headers.location, hops + 1); return;
            }
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const file = fs.createWriteStream(tmp);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
            file.on('error', reject);
        }).on('error', reject);
        get(YTDLP_URL, 0);
    });
    fs.renameSync(tmp, YTDLP);
}

/** Asks before downloading yt-dlp (with the ToS note). Returns true when yt-dlp is ready to use. */
export async function ensureYtDlp(): Promise<boolean> {
    if (hasYtDlp()) { return true; }
    const ok = await vscode.window.showInformationMessage(
        'The music-video background uses yt-dlp (free, open source, ~20 MB) to find each song\'s video on YouTube ' +
        'and save a small muted copy (about 2-6 MB per song, auto-deleted past the cache limit). ' +
        'Note: saving YouTube videos is against YouTube\'s Terms of Service. Download yt-dlp now?',
        { modal: true }, 'Download yt-dlp');
    if (ok !== 'Download yt-dlp') { return false; }
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Downloading yt-dlp…' },
            () => downloadYtDlp());
        return true;
    } catch (e) {
        vscode.window.showErrorMessage(`yt-dlp download failed: ${String(e)}`);
        return false;
    }
}

/** YouTube changes often; stale yt-dlp builds stop working. Self-update at most once a week. */
export function updateYtDlpWeekly(log: vscode.OutputChannel) {
    // throwIfNoEntry: another window's `yt-dlp -U` may be swapping the exe right now - never fail activation over it.
    const stat = fs.statSync(YTDLP, { throwIfNoEntry: false });
    if (!stat || Date.now() - stat.mtimeMs < 7 * 24 * 3600 * 1000) { return; }
    const p = spawn(YTDLP, ['-U'], { windowsHide: true });
    p.on('close', code => {
        log.appendLine(`yt-dlp self-update exited (${code})`);
        const now = new Date();
        try { fs.utimesSync(YTDLP, now, now); } catch { /* next start retries */ }
    });
}

/** "MalcolmToddVEVO" / "Artist - Topic" -> clean artist; adds "official music video" when the title isn't already a video title. */
export function buildQuery(t: TrackInfo): string {
    const artist = (t.artist ?? '').replace(/VEVO$/i, '').replace(/\s*-\s*Topic$/i, '').trim();
    const title = (t.title ?? '').trim();
    const looksLikeVideo = /official|music video|\bmv\b|visualizer|lyric/i.test(title);
    const hasArtist = artist && title.toLowerCase().includes(artist.toLowerCase());
    return [hasArtist ? '' : artist, title, looksLikeVideo ? '' : 'official music video'].filter(Boolean).join(' ');
}

export class VideoManager {
    private trackKey = '';
    private file: string | undefined;           // file name inside videosDir, ready to play
    private timer: NodeJS.Timeout | undefined;
    private proc: ChildProcess | undefined;
    private index: Record<string, string> = {};  // query -> video id

    constructor(private log: vscode.OutputChannel, private onReady: () => void) {
        try { this.index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { this.index = {}; }
    }

    /** Ready-to-play file for this track, if any (relative to npt/, e.g. "videos/abc.mp4"). */
    fileFor(t: TrackInfo): string | undefined {
        return this.keyOf(t) === this.trackKey && this.file ? `videos/${this.file}` : undefined;
    }

    /** Called on every reader event; starts work only when the track actually changes. */
    track(t: TrackInfo, videosDir: string, mode: VideoMode, delaySec: number, cacheMB: number) {
        const key = this.keyOf(t);
        if (key === this.trackKey) { return; }
        this.cancel();
        this.trackKey = key;
        this.file = undefined;
        if (!t.title) { return; }

        const query = buildQuery(t);
        const cachedId = this.index[query];
        const cached = cachedId && this.findFile(videosDir, cachedId, mode);
        if (cached) {                       // replayed song: instant, no delay, no download
            this.touch(path.join(videosDir, cached));
            this.file = cached;
            this.onReady();
            return;
        }
        // Wait a bit so skipped songs don't cost a download.
        this.timer = setTimeout(() => this.fetch(key, query, t.durationMs, videosDir, mode, cacheMB), Math.max(0, delaySec) * 1000);
    }

    cancel() {
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        if (this.proc) { this.proc.kill(); this.proc = undefined; }
    }

    private keyOf(t: TrackInfo) { return `${t.artist ?? ''}|${t.title ?? ''}`; }

    private async fetch(key: string, query: string, durationMs: number | null | undefined, videosDir: string, mode: VideoMode, cacheMB: number) {
        if (!hasYtDlp()) { return; }
        fs.mkdirSync(videosDir, { recursive: true });
        let id = this.index[query];
        if (!id) {
            // Top 5 results; the one matching the song's length is almost always the right video.
            const out = await this.run(['--flat-playlist', '--print', '%(id)s|%(duration)s', `ytsearch5:${query}`]);
            if (key !== this.trackKey) { return; }
            id = pickBest(out.split(/\r?\n/), durationMs) ?? '';
            if (!id) { this.log.appendLine(`No video found for "${query}"`); return; }
            this.index[query] = id;
            this.saveIndex();
        }
        let file = this.findFile(videosDir, id, mode);
        if (!file) {
            this.log.appendLine(`Downloading video ${id} for "${query}" (${mode})`);
            const out = path.join(videosDir, `${id}.${mode}.%(ext)s`);
            await this.run(['--no-playlist', '-f', FORMATS[mode], '-o', out, `https://www.youtube.com/watch?v=${id}`]);
            if (key !== this.trackKey) { return; }
            file = this.findFile(videosDir, id, mode);
            if (!file) { this.log.appendLine(`Download failed for ${id}`); return; }
        }
        this.touch(path.join(videosDir, file));
        this.prune(videosDir, cacheMB, file);
        this.file = file;
        this.onReady();
    }

    /** Runs yt-dlp; the first attempt has no JS runtime (works best today), the retry lends it VS Code's Electron as Node. */
    private async run(args: string[]): Promise<string> {
        const base = ['--ignore-config', '--no-warnings', '--no-progress'];
        let res = await this.exec([...base, ...args], false);
        if (res.code !== 0 && res.code !== null) {
            this.log.appendLine(`yt-dlp failed (${res.code}), retrying with JS runtime: ${res.err.trim().split('\n').pop()}`);
            res = await this.exec([...base, '--js-runtimes', `node:${process.execPath}`, ...args], true);
            if (res.code !== 0) { this.log.appendLine(`yt-dlp failed again: ${res.err.trim().split('\n').pop()}`); }
        }
        return res.out;
    }

    private exec(args: string[], electronAsNode: boolean): Promise<{ code: number | null; out: string; err: string }> {
        return new Promise(resolve => {
            const env = { ...process.env };
            if (electronAsNode) { env.ELECTRON_RUN_AS_NODE = '1'; } else { delete env.ELECTRON_RUN_AS_NODE; }
            const p = spawn(YTDLP, args, { windowsHide: true, env });
            this.proc = p;
            let out = '', err = '';
            p.stdout.on('data', d => out += d);
            p.stderr.on('data', d => err += d);
            p.on('error', e => { err += String(e); });
            p.on('close', code => { if (this.proc === p) { this.proc = undefined; } resolve({ code, out, err }); });
        });
    }

    private findFile(dir: string, id: string, mode: VideoMode): string | undefined {
        if (!fs.existsSync(dir)) { return undefined; }
        const prefix = `${id}.${mode}.`;
        return fs.readdirSync(dir).find(f => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
    }

    private touch(full: string) { const now = new Date(); try { fs.utimesSync(full, now, now); } catch { /* best effort */ } }

    /** Keep the cache under cacheMB by deleting least-recently-played videos. */
    private prune(dir: string, cacheMB: number, keep: string) {
        const files = fs.readdirSync(dir)
            .filter(f => /\.(mp4|webm)$/.test(f))
            .map(f => { const s = fs.statSync(path.join(dir, f)); return { f, size: s.size, t: s.mtimeMs }; })
            .sort((a, b) => a.t - b.t);
        let total = files.reduce((a, x) => a + x.size, 0);
        for (const x of files) {
            if (total <= cacheMB * 1024 * 1024) { break; }
            if (x.f === keep) { continue; }
            fs.rmSync(path.join(dir, x.f), { force: true });
            total -= x.size;
        }
    }

    private saveIndex() {
        const keys = Object.keys(this.index);
        if (keys.length > 2000) { for (const k of keys.slice(0, keys.length - 2000)) { delete this.index[k]; } }
        fs.mkdirSync(TOOL_DIR, { recursive: true });
        fs.writeFileSync(INDEX, JSON.stringify(this.index));
    }
}
