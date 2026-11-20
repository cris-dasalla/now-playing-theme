import * as vscode from 'vscode';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import { extractPalette, buildColors, OWNED_KEYS, Scope } from './palette';
import * as bg from './background';
import * as fs from 'fs';
import { VideoManager, VideoMode, hasYtDlp, downloadYtDlp, YTDLP } from './video';
import { Display, DISPLAYS, DISPLAY_INFO, getDisplay, setDisplay } from './display';

interface NowPlaying {
    running: boolean;
    source?: string;
    playing?: boolean;
    positionMs?: number | null;
    durationMs?: number | null;
    capturedAt?: number;
    title?: string;
    artist?: string;
    album?: string;
    coverHash?: string | null;
    pixels?: string | null;
    coverFile?: string | null;
}

const CFG = 'nowPlayingTheme';
const BACKUP_KEY = 'nowPlayingTheme.backup';     // user's original values for OWNED_KEYS
const LEADER_KEY = 'nowPlayingTheme.leader';     // sessionId of the last-focused window
const SOURCE_PATTERNS: Record<string, string> = {
    spotify: 'Spotify',
    browser: 'Chrome|MSEdge|Firefox|Brave|Opera|Vivaldi', // YouTube Music tab or installed web app
};

let ctx: vscode.ExtensionContext;
let proc: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let statusItem: vscode.StatusBarItem;
let modeItem: vscode.StatusBarItem;      // Video / Cover / Colors switch next to the song
let latest: NowPlaying | undefined;
let appliedKey = '';
let lastBgState = '';
let log: vscode.OutputChannel;
let videos: VideoManager;

export function activate(context: vscode.ExtensionContext) {
    ctx = context;
    log = vscode.window.createOutputChannel('Now Playing Theme');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
    statusItem.command = 'nowPlayingTheme.menu';
    modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100.5); // just right of the song
    modeItem.command = 'nowPlayingTheme.cycleDisplay';
    context.subscriptions.push(log, statusItem, modeItem);
    videos = new VideoManager(log, () => { if (latest && isLeader()) { lastBgState = ''; writeBackground(latest); } });
    context.subscriptions.push({ dispose: () => videos.cancel() });

    if (process.platform !== 'win32') {
        vscode.window.showWarningMessage('Now Playing Theme currently supports Windows only.');
        return;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('nowPlayingTheme.toggle', async () => {
            const cfg = vscode.workspace.getConfiguration(CFG);
            await cfg.update('enabled', !cfg.get<boolean>('enabled'), vscode.ConfigurationTarget.Global);
        }),
        vscode.commands.registerCommand('nowPlayingTheme.restore', () => restoreColors()),
        vscode.commands.registerCommand('nowPlayingTheme.cycleDisplay', () => {
            const cur = getDisplay();
            return chooseDisplay(DISPLAYS[(DISPLAYS.indexOf(cur) + 1) % DISPLAYS.length]);
        }),
        vscode.commands.registerCommand('nowPlayingTheme.menu', showMenu),
        vscode.commands.registerCommand('nowPlayingTheme.enableBackground', enableBackground),
        vscode.commands.registerCommand('nowPlayingTheme.disableBackground', disableBackground),
        vscode.commands.registerCommand('nowPlayingTheme.enableVideo', enableVideo),
        vscode.commands.registerCommand('nowPlayingTheme.disableVideo', async () => {
            await vscode.workspace.getConfiguration(CFG).update('video.enabled', false, vscode.ConfigurationTarget.Global);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(CFG)) { appliedKey = ''; lastBgState = ''; restart(); }
        }),
        vscode.window.onDidChangeWindowState(s => {
            if (s.focused) { claimLeader(); updateModeItem(); if (latest) { handle(latest); } }
        }),
        vscode.window.onDidChangeActiveColorTheme(() => { appliedKey = ''; if (latest) { handle(latest); } }),
        { dispose: stop },
    );
    if (vscode.window.state.focused || !ctx.globalState.get(LEADER_KEY)) { claimLeader(); }
    // Already patched: refresh npt-bg.js (extension upgrades) and the product.json checksum. Idempotent.
    if (bg.isPatched()) {
        const r = bg.patch(ctx.extensionPath);
        if (r.error) { log.appendLine(`Background refresh failed: ${r.error}`); }
        else if (r.scriptChanged) { promptReload('Now Playing Theme updated its background script. Reload the window to use it.'); }
    }
    checkBackgroundAfterUpdate();
    updateYtDlpWeekly();
    restart();
}

export function deactivate() { stop(); }

// ---------- which window writes ----------
// Settings and the background are shared by every VS Code window. Only the last-focused one writes,
// but it keeps writing while you're in Spotify/the browser, so colors follow the song live.

function claimLeader() { ctx.globalState.update(LEADER_KEY, vscode.env.sessionId); }
function isLeader() {
    return vscode.window.state.focused || ctx.globalState.get(LEADER_KEY) === vscode.env.sessionId;
}

// ---------- reader process ----------

function stop() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    if (proc) { proc.removeAllListeners('exit'); proc.kill(); proc = undefined; }
}

// The patch is shared by every VS Code profile (one install), but settings are per profile -
// so "patched" is the source of truth; the setting only drives the re-apply-after-update prompt.
function backgroundOn() { return bg.isPatched(); }

function restart() {
    stop();
    const cfg = vscode.workspace.getConfiguration(CFG);
    if (!cfg.get<boolean>('enabled', true)) {
        statusItem.text = '$(mute) Now Playing: off';
        statusItem.tooltip = 'Click for Now Playing Theme options';
        statusItem.show();
        modeItem.hide();
        restoreColors();
        writeBackground({ running: false });
        return;
    }
    const sources = cfg.get<string[]>('sources', ['spotify', 'browser'])
        .map(s => SOURCE_PATTERNS[s]).filter(Boolean).join('|') || SOURCE_PATTERNS.spotify;
    const script = path.join(ctx.extensionPath, 'media', 'now-playing.ps1');
    const interval = Math.max(500, cfg.get<number>('pollIntervalMs', 1500));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-IntervalMs', String(interval), '-Sources', sources];
    if (backgroundOn()) { args.push('-CoverDir', bg.nptDir()!); }

    proc = spawn('powershell.exe', args, { windowsHide: true });
    readline.createInterface({ input: proc.stdout! }).on('line', line => {
        try { handle(JSON.parse(line)); } catch (e) { log.appendLine(`Bad line: ${String(e)}`); }
    });
    proc.stderr!.on('data', d => log.appendLine(String(d).trim()));
    proc.on('exit', code => {
        log.appendLine(`Reader exited (${code}); restarting in 5s`);
        restartTimer = setTimeout(restart, 5000);
    });
}

function handle(np: NowPlaying) {
    latest = np;
    updateStatus(np);
    if (!isLeader()) { return; }

    if (videoOn()) {
        const v = vscode.workspace.getConfiguration(CFG);
        videos.track(np.running ? np : {}, path.join(bg.nptDir()!, 'videos'),
            v.get<VideoMode>('video.mode', 'full'), v.get<number>('video.delaySeconds', 10), v.get<number>('video.cacheMB', 300));
    } else {
        videos.track({}, '', 'full', 0, 0); // clears any pending work
    }
    writeBackground(np);
    if (!np.running) {
        if (vscode.workspace.getConfiguration(CFG).get<boolean>('restoreWhenStopped', true)) { restoreColors(); }
        return;
    }
    if (!np.pixels || !np.coverHash) { return; } // cover not loaded yet; keep current colors

    const cfg = vscode.workspace.getConfiguration(CFG);
    if (!cfg.get<boolean>('colors.enabled', true)) { return; }
    const scope = cfg.get<Scope>('scope', 'full');
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const key = `${np.coverHash}|${scope}|${dark}`;
    if (key === appliedKey) { return; }
    appliedKey = key;

    const palette = extractPalette(Buffer.from(np.pixels, 'base64'));
    applyColors(buildColors(palette, scope, dark));
}

function updateStatus(np: NowPlaying) {
    if (!np.running || !np.title) { statusItem.hide(); modeItem.hide(); return; }
    const icon = np.playing ? '$(play)' : '$(debug-pause)';
    const who = np.artist ? `${np.artist} — ` : '';
    const text = `${who}${np.title}`;
    statusItem.text = `${icon} ${text.length > 50 ? text.slice(0, 49) + '…' : text}`;
    const app = /spotify/i.test(np.source ?? '') ? 'Spotify' : 'Browser (YouTube Music)';
    statusItem.tooltip = `${text}${np.album ? `\n${np.album}` : ''}\nfrom ${app}\n\nClick for Now Playing Theme options`;
    statusItem.show();
    updateModeItem();
}

/** The Video / Cover / Colors switch. Hidden until the background is installed (colors are all there is before that). */
function updateModeItem() {
    if (!bg.isPatched() || !latest?.running || !latest.title ||
        !vscode.workspace.getConfiguration(CFG).get<boolean>('enabled', true)) { modeItem.hide(); return; }
    const mode = getDisplay();
    const next = DISPLAYS[(DISPLAYS.indexOf(mode) + 1) % DISPLAYS.length];
    modeItem.text = `${DISPLAY_INFO[mode].icon} ${DISPLAY_INFO[mode].label}`;
    modeItem.tooltip = `Background: ${DISPLAY_INFO[mode].detail}\nClick to switch to ${DISPLAY_INFO[next].label}`;
    modeItem.show();
}

async function chooseDisplay(mode: Display) {
    if (mode !== 'colors' && !bg.isPatched()) { await enableBackground(); if (!bg.isPatched()) { return; } }
    if (mode === 'video' && !hasYtDlp()) { await enableVideo(); if (!hasYtDlp()) { return; } }
    setDisplay(mode);
    claimLeader();
    lastBgState = '';
    updateModeItem();
    if (latest) { handle(latest); }
}

async function showMenu() {
    const cfg = vscode.workspace.getConfiguration(CFG);
    const on = cfg.get<boolean>('enabled', true);
    const current = getDisplay();
    type Item = vscode.QuickPickItem & { run: () => unknown };
    const items: Item[] = on ? [
        ...DISPLAYS.map(m => ({
            label: `${DISPLAY_INFO[m].icon} ${DISPLAY_INFO[m].label}${m === current ? '  (current)' : ''}`,
            detail: DISPLAY_INFO[m].detail,
            run: () => chooseDisplay(m),
        })),
        { label: '$(mute) Turn off', detail: 'Stop following the music and restore your colors', run: () => cfg.update('enabled', false, vscode.ConfigurationTarget.Global) },
    ] : [
        { label: '$(unmute) Turn on', detail: 'Follow the music again', run: () => cfg.update('enabled', true, vscode.ConfigurationTarget.Global) },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Now Playing Theme — what should follow the music?' });
    await pick?.run();
}

// ---------- background ----------

function writeBackground(np: NowPlaying) {
    if (!bg.isPatched()) { return; }
    const cfg = vscode.workspace.getConfiguration(CFG);
    const videoFile = videoOn() && np.running ? videos.fileFor(np) : undefined;
    const state: bg.BackgroundState = {
        visible: getDisplay() !== 'colors' && np.running && (!!np.coverFile || !!videoFile),
        cover: np.coverFile ?? null,
        style: cfg.get<string>('background.style', 'poster'),
        opacity: cfg.get<number>('background.opacity', 0.2),
        video: videoFile ? {
            file: videoFile,
            positionMs: np.positionMs ?? null,
            capturedAt: np.capturedAt ?? Date.now(),
            playing: !!np.playing,
            mode: cfg.get<string>('video.mode', 'full'),
        } : null,
    };
    const json = JSON.stringify(state);
    if (json === lastBgState) { return; }
    lastBgState = json;
    try { bg.writeState(state); } catch (e) { log.appendLine(`Background write failed: ${String(e)}`); }
}

async function enableBackground() {
    const ok = await vscode.window.showWarningMessage(
        'The album-art background works by adding one script tag to VS Code\'s own workbench.html ' +
        '(and updating its checksum so VS Code doesn\'t report a corrupt install). ' +
        'VS Code updates remove it - you\'ll be offered to re-apply. Use "Disable Album Art Background" to undo.',
        { modal: true }, 'Enable');
    if (ok !== 'Enable') { return; }
    const r = bg.patch(ctx.extensionPath);
    if (r.error) { vscode.window.showErrorMessage(r.error); return; }
    await vscode.workspace.getConfiguration(CFG).update('background.enabled', true, vscode.ConfigurationTarget.Global);
    promptReload('Album-art background installed. Reload the window to see it.');
}

async function disableBackground() {
    await vscode.workspace.getConfiguration(CFG).update('background.enabled', false, vscode.ConfigurationTarget.Global);
    const err = bg.unpatch();
    if (err) { vscode.window.showErrorMessage(err); return; }
    promptReload('Album-art background removed. Reload the window to finish.');
}

// ---------- music video ----------

function videoOn() {
    return getDisplay() === 'video' && bg.isPatched() && hasYtDlp()
        && vscode.workspace.getConfiguration(CFG).get<boolean>('video.enabled', true);
}

async function enableVideo() {
    if (!bg.isPatched()) {
        await enableBackground();
        if (!bg.isPatched()) { return; }
    }
    if (!hasYtDlp()) {
        const ok = await vscode.window.showInformationMessage(
            'The music-video background uses yt-dlp (free, open source, ~20 MB) to find each song\'s video on YouTube ' +
            'and save a small muted copy (about 2-6 MB per song, auto-deleted past the cache limit). ' +
            'Note: saving YouTube videos is against YouTube\'s Terms of Service. Download yt-dlp now?',
            { modal: true }, 'Download yt-dlp');
        if (ok !== 'Download yt-dlp') { return; }
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Downloading yt-dlp…' },
                () => downloadYtDlp());
        } catch (e) {
            vscode.window.showErrorMessage(`yt-dlp download failed: ${String(e)}`);
            return;
        }
    }
    await vscode.workspace.getConfiguration(CFG).update('video.enabled', true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Music-video background on. Each new song\'s video appears after it has played for a few seconds.');
}

/** YouTube changes often; stale yt-dlp builds stop working. Self-update at most once a week. */
function updateYtDlpWeekly() {
    if (!hasYtDlp() || !vscode.window.state.focused) { return; }
    const age = Date.now() - fs.statSync(YTDLP).mtimeMs;
    if (age < 7 * 24 * 3600 * 1000) { return; }
    const p = spawn(YTDLP, ['-U'], { windowsHide: true });
    p.on('close', code => {
        log.appendLine(`yt-dlp self-update exited (${code})`);
        const now = new Date();
        try { fs.utimesSync(YTDLP, now, now); } catch { /* next start retries */ }
    });
}

/** A VS Code update replaces workbench.html, silently dropping the patch - offer to re-apply. */
async function checkBackgroundAfterUpdate() {
    if (!vscode.workspace.getConfiguration(CFG).get<boolean>('background.enabled', false) || bg.isPatched()) { return; }
    const pick = await vscode.window.showInformationMessage(
        'VS Code was updated, which removed the album-art background.', 'Re-apply', 'Turn Off');
    if (pick === 'Re-apply') {
        const r = bg.patch(ctx.extensionPath);
        if (r.error) { vscode.window.showErrorMessage(r.error); return; }
        promptReload('Album-art background re-applied. Reload the window to see it.');
    } else if (pick === 'Turn Off') {
        await vscode.workspace.getConfiguration(CFG).update('background.enabled', false, vscode.ConfigurationTarget.Global);
    }
}

async function promptReload(message: string) {
    if (await vscode.window.showInformationMessage(message, 'Reload Window') === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

// ---------- settings writes ----------

function currentGlobal(): Record<string, unknown> {
    const inspected = vscode.workspace.getConfiguration('workbench').inspect<Record<string, unknown>>('colorCustomizations');
    return { ...(inspected?.globalValue ?? {}) };
}

async function applyColors(colors: Record<string, string>) {
    const current = currentGlobal();
    // First takeover: remember the user's own values for every key we might touch.
    if (!ctx.globalState.get(BACKUP_KEY)) {
        const backup: Record<string, unknown> = {};
        for (const k of OWNED_KEYS) { backup[k] = k in current ? current[k] : null; }
        await ctx.globalState.update(BACKUP_KEY, backup);
    }
    for (const k of OWNED_KEYS) { delete current[k]; } // drop keys the new scope no longer uses
    await vscode.workspace.getConfiguration('workbench')
        .update('colorCustomizations', { ...current, ...colors }, vscode.ConfigurationTarget.Global);
}

async function restoreColors() {
    const backup = ctx.globalState.get<Record<string, unknown>>(BACKUP_KEY);
    if (!backup) { return; }
    const current = currentGlobal();
    for (const k of OWNED_KEYS) {
        if (backup[k] === null || backup[k] === undefined) { delete current[k]; } else { current[k] = backup[k]; }
    }
    await vscode.workspace.getConfiguration('workbench').update('colorCustomizations',
        Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
    await ctx.globalState.update(BACKUP_KEY, undefined);
    appliedKey = '';
}
