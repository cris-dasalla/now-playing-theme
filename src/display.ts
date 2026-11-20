// What the background shows: the music video, the cover, or nothing (colors only).
// Stored in a shared file (not a setting) so every VS Code profile/window agrees - settings are per profile.
import * as fs from 'fs';
import * as path from 'path';
import { TOOL_DIR } from './video';

export type Display = 'video' | 'cover' | 'colors';
export const DISPLAYS: Display[] = ['video', 'cover', 'colors'];

const FILE = path.join(TOOL_DIR, 'display.json');

export const DISPLAY_INFO: Record<Display, { icon: string; label: string; detail: string }> = {
    video:  { icon: '$(device-camera-video)', label: 'Video',  detail: 'Music video behind your code + colors' },
    cover:  { icon: '$(file-media)',          label: 'Cover',  detail: 'Album art behind your code + colors' },
    colors: { icon: '$(symbol-color)',        label: 'Colors', detail: 'Only tint the title/status bars and editor' },
};

export function getDisplay(): Display {
    try {
        const mode = JSON.parse(fs.readFileSync(FILE, 'utf8')).mode;
        if (DISPLAYS.includes(mode)) { return mode; }
    } catch { /* no file yet -> default */ }
    return 'video';
}

export function setDisplay(mode: Display) {
    fs.mkdirSync(TOOL_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ mode }));
}
