// Album-art background: VS Code has no API for this, so we add one <script> tag to its workbench.html.
// The script (media/npt-bg.js) polls npt/state.json next to it; the extension writes that file + cover images.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FIX_CHECKSUM } from './features';

const MARK_START = '<!-- now-playing-theme -->';
const MARK_END = '<!-- /now-playing-theme -->';
// ?v=<content hash> makes each script version a new URL; otherwise Chromium keeps running a cached old copy.
const tagFor = (version: string) => `${MARK_START}<script src="./npt/npt-bg.js?v=${version}"></script>${MARK_END}`;
const BLOCK_RE = /<!-- now-playing-theme -->[\s\S]*?<!-- \/now-playing-theme -->/;

export interface BackgroundState {
    visible: boolean;
    cover: string | null;   // file name inside npt/
    style: string;          // poster | blurred | sharp
    opacity: number;
    video: null | {
        file: string;        // relative to npt/, e.g. "videos/abc.full.mp4"
        positionMs: number | null;
        capturedAt: number;  // epoch ms when positionMs was measured
        playing: boolean;
        mode: string;        // full | loop
    };
}

/** Folder holding workbench.html - "electron-browser" on current VS Code, "electron-sandbox" on older builds. */
function workbenchDir(): string | undefined {
    for (const sub of ['electron-browser', 'electron-sandbox']) {
        const dir = path.join(vscode.env.appRoot, 'out', 'vs', 'code', sub, 'workbench');
        if (fs.existsSync(path.join(dir, 'workbench.html'))) { return dir; }
    }
    return undefined;
}

export function nptDir(): string | undefined {
    const dir = workbenchDir();
    return dir && path.join(dir, 'npt');
}

export function isPatched(): boolean {
    const dir = workbenchDir();
    return !!dir && fs.readFileSync(path.join(dir, 'workbench.html'), 'utf8').includes(MARK_START)
        && fs.existsSync(path.join(dir, 'npt', 'npt-bg.js'));
}

export interface PatchResult { error?: string; scriptChanged?: boolean }

/** Installs/refreshes the script and its tag. scriptChanged = open windows need a reload to pick it up. */
export function patch(extensionPath: string): PatchResult {
    const dir = workbenchDir();
    if (!dir) { return { error: 'Could not find VS Code\'s workbench.html in ' + vscode.env.appRoot }; }
    const html = path.join(dir, 'workbench.html');
    const npt = path.join(dir, 'npt');
    if (!isWritable(dir)) {
        return { error: `No write access to ${dir}. VS Code is installed for all users - run VS Code as administrator once to enable the background.` };
    }
    fs.mkdirSync(npt, { recursive: true });
    const script = fs.readFileSync(path.join(extensionPath, 'media', 'npt-bg.js'));
    fs.writeFileSync(path.join(npt, 'npt-bg.js'), script);
    const tag = tagFor(crypto.createHash('sha1').update(script).digest('hex').slice(0, 10));

    const original = fs.readFileSync(html, 'utf8');
    let text = original;
    if (!text.includes(MARK_START)) {
        const backup = html + '.npt-original';
        if (!fs.existsSync(backup)) { fs.writeFileSync(backup, text); }
        text = text.replace(/<\/html>\s*$/i, `\t${tag}\n</html>\n`);
        if (!text.includes(MARK_START)) { return { error: 'workbench.html has an unexpected layout; not patched.' }; }
    } else {
        text = text.replace(BLOCK_RE, tag);
    }
    const scriptChanged = text !== original;
    if (scriptChanged) { fs.writeFileSync(html, text); }
    syncChecksum(html);
    return { scriptChanged };
}

// Checksum fix-up lives in integrity.ts, which only the personal build ships (see features.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const integrity: typeof import('./integrity') | undefined = FIX_CHECKSUM ? require('./integrity') : undefined;
function syncChecksum(html: string) { integrity?.syncChecksum(html); }
function restoreProduct() { integrity?.restoreProduct(); }

export function unpatch(): string | undefined {
    const dir = workbenchDir();
    if (!dir) { return undefined; }
    const html = path.join(dir, 'workbench.html');
    if (!isWritable(dir)) { return `No write access to ${dir}.`; }
    // The backup lives in the same version folder, so it always matches this install exactly.
    const backup = html + '.npt-original';
    if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, html);
        fs.rmSync(backup);
    } else {
        const text = fs.readFileSync(html, 'utf8');
        fs.writeFileSync(html, text.replace(/[ \t]*<!-- now-playing-theme -->[\s\S]*?<!-- \/now-playing-theme -->\r?\n?/, '')); // fallback if backup is gone
    }
    restoreProduct();
    fs.rmSync(path.join(dir, 'npt'), { recursive: true, force: true });
    return undefined;
}

export function writeState(state: BackgroundState) {
    const npt = nptDir();
    if (!npt || !fs.existsSync(npt)) { return; }
    const file = path.join(npt, 'state.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file); // atomic swap: the page never reads half a file
    pruneCovers(npt, state.cover);
}

/** Delete covers older than 10 minutes that aren't on screen. */
function pruneCovers(npt: string, keep: string | null) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const f of fs.readdirSync(npt)) {
        if (!f.startsWith('cover-') || f === keep) { continue; }
        const full = path.join(npt, f);
        if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { force: true }); }
    }
}

function isWritable(dir: string): boolean {
    const probe = path.join(dir, `.npt-probe-${process.pid}`);
    // fs has no "can I write" check that honours ACLs on Windows; a probe file is the reliable test.
    try { fs.writeFileSync(probe, ''); fs.rmSync(probe); return true; } catch { return false; }
}
