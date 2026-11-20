// Personal build only: keeps VS Code from reporting a "corrupt" install after the background patch,
// by recording the patched workbench.html's hash in product.json (original kept as a backup).
// The Marketplace build leaves this file out - users dismiss VS Code's one-time notice instead.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export function syncChecksum(html: string) {
    const outDir = path.join(vscode.env.appRoot, 'out');
    const product = path.join(vscode.env.appRoot, 'product.json');
    const key = path.relative(outDir, html).split(path.sep).join('/');
    const json = JSON.parse(fs.readFileSync(product, 'utf8'));
    if (!json.checksums || !(key in json.checksums)) { return; }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(html)).digest('base64').replace(/=+$/, '');
    if (json.checksums[key] === hash) { return; }
    const backup = product + '.npt-original';
    if (!fs.existsSync(backup)) { fs.copyFileSync(product, backup); }
    json.checksums[key] = hash;
    // Several windows may activate at once; a torn product.json would stop VS Code from starting.
    const tmp = `${product}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(json, null, '\t'));
    fs.renameSync(tmp, product);
}

export function restoreProduct() {
    const product = path.join(vscode.env.appRoot, 'product.json');
    const backup = product + '.npt-original';
    if (fs.existsSync(backup)) { fs.copyFileSync(backup, product); fs.rmSync(backup); }
}
