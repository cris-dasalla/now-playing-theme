// Builds the Marketplace package: no music-video code/settings/docs, Windows-only targets, Preview flag.
// Usage: npm run package:public -- --publisher <id>
// Works in a temporary copy of the project, so the real files are never modified (safe to Ctrl+C).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const argPublisher = process.argv.indexOf('--publisher');
const publisher = argPublisher > 0 ? process.argv[argPublisher + 1] : undefined;
const TARGETS = ['win32-x64', 'win32-arm64'];
const SKIP = new Set(['node_modules', 'out', 'dist', '.git']);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'npt-public-'));
const nodeModulesLink = path.join(work, 'node_modules');
const at = f => path.join(work, f);
const run = cmd => execSync(cmd, { cwd: work, stdio: 'inherit' });

try {
    // Copy the project (minus build output/deps) and link node_modules instead of copying it.
    for (const entry of fs.readdirSync(root)) {
        if (SKIP.has(entry) || entry.endsWith('.vsix')) { continue; }
        fs.cpSync(path.join(root, entry), at(entry), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), nodeModulesLink, 'junction');

    // package.json: drop video commands/settings, mark preview, set publisher.
    const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
    if (publisher) { pkg.publisher = publisher; }
    pkg.preview = true;
    pkg.description = 'Tints VS Code with the album art of the song playing on Spotify or YouTube Music, with an optional cover background (Windows).';
    pkg.contributes.commands = pkg.contributes.commands
        .filter(c => !/Video$/.test(c.command))
        .map(c => c.command === 'nowPlayingTheme.cycleDisplay' ? { ...c, title: 'Now Playing Theme: Switch Background (Cover / Colors)' } : c);
    const props = pkg.contributes.configuration.properties;
    for (const k of Object.keys(props)) { if (k.startsWith('nowPlayingTheme.video.')) { delete props[k]; } }
    fs.writeFileSync(at('package.json'), JSON.stringify(pkg, null, 2) + '\n');

    // README: strip personal-only sections.
    const readme = fs.readFileSync(at('README.md'), 'utf8');
    fs.writeFileSync(at('README.md'), readme.replace(/<!-- personal -->[\s\S]*?<!-- \/personal -->\r?\n?/g, ''));

    // Code: compile without the video feature and don't ship out/video.js.
    const features = fs.readFileSync(at('src/features.ts'), 'utf8');
    const flipped = features.replace(/VIDEO_FEATURE: boolean = true/, 'VIDEO_FEATURE: boolean = false');
    if (flipped === features) { throw new Error('could not flip VIDEO_FEATURE'); }
    fs.writeFileSync(at('src/features.ts'), flipped);
    fs.appendFileSync(at('.vscodeignore'), '\nout/video.js\n');

    run('npx tsc -p .');
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const outputs = TARGETS.map(t => path.join(dist, `${pkg.name}-${t}-${pkg.version}.vsix`));
    TARGETS.forEach((t, i) => run(`npx vsce package --target ${t} -o "${outputs[i]}"`));
    console.log(`\nPublic packages (publisher: ${pkg.publisher}). Publish with:\n  npx vsce publish --packagePath ${outputs.map(o => path.relative(root, o)).join(' ')}`);
} finally {
    // Remove the junction FIRST (unlink only removes the link), so cleanup can never touch the real node_modules.
    if (fs.existsSync(nodeModulesLink)) { fs.unlinkSync(nodeModulesLink); }
    fs.rmSync(work, { recursive: true, force: true });
}
