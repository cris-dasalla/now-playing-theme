// Turns cover-art pixels into a small palette, then into VS Code color customizations.

export type RGB = [number, number, number];
interface HSL { h: number; s: number; l: number }

export interface Palette {
    dominant: RGB; // most common meaningful color
    accent: RGB;   // most vivid color that still covers a decent area
}

export type Scope = 'frame' | 'full';

/** Every key this extension may write - used to back up and restore the user's own values. */
export const OWNED_KEYS = [
    'titleBar.activeBackground', 'titleBar.activeForeground', 'titleBar.inactiveBackground', 'titleBar.inactiveForeground',
    'activityBar.background', 'activityBar.foreground', 'activityBar.inactiveForeground',
    'activityBarBadge.background', 'activityBarBadge.foreground', 'activityBar.activeBorder',
    'statusBar.background', 'statusBar.foreground', 'statusBarItem.hoverBackground', 'statusBar.border',
    'editor.background', 'editorGutter.background', 'sideBar.background', 'sideBarSectionHeader.background',
    'panel.background', 'terminal.background', 'editorGroupHeader.tabsBackground',
    'tab.inactiveBackground', 'tab.activeBackground', 'tab.activeBorderTop',
    'editor.selectionBackground', 'editorCursor.foreground', 'focusBorder', 'list.activeSelectionBackground',
] as const;

// ---------- color math ----------

function rgbToHsl([r, g, b]: RGB): HSL {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) { return { h: 0, s: 0, l }; }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const hue = (p: number, q: number, t: number) => {
        if (t < 0) { t += 1; } if (t > 1) { t -= 1; }
        if (t < 1 / 6) { return p + (q - p) * 6 * t; }
        if (t < 1 / 2) { return q; }
        if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; }
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map(v => Math.round(v * 255)) as RGB;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hex = (c: RGB, alpha?: number) =>
    '#' + c.map(v => v.toString(16).padStart(2, '0')).join('') +
    (alpha === undefined ? '' : Math.round(alpha * 255).toString(16).padStart(2, '0'));

/** Same hue, lightness forced to `l`, saturation capped so dark tints don't look neon. */
function tone(c: RGB, l: number, maxS = 1): RGB {
    const hsl = rgbToHsl(c);
    return hslToRgb({ h: hsl.h, s: Math.min(hsl.s, maxS), l });
}

function luminance(c: RGB): number {
    const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black text, whichever reads better on `bg` (WCAG contrast). */
function readableOn(bg: RGB): string {
    const L = luminance(bg);
    return (1.05) / (L + 0.05) >= (L + 0.05) / (0.0137 + 0.05) ? '#ffffff' : '#1e1e1e';
}

// ---------- palette extraction ----------

export function extractPalette(rgb: Uint8Array): Palette {
    // Bucket at 4 bits/channel and average the real colors inside each bucket.
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i + 2 < rgb.length; i += 3) {
        const key = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
        const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += rgb[i]; e.g += rgb[i + 1]; e.b += rgb[i + 2];
        buckets.set(key, e);
    }
    const colors = [...buckets.values()].map(e => {
        const c: RGB = [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
        return { c, n: e.n, hsl: rgbToHsl(c) };
    });
    const total = rgb.length / 3;

    // Dominant: skip near-black/near-white (letterbox bars, paper backgrounds) unless that's all there is.
    const meaningful = colors.filter(x => x.hsl.l > 0.07 && x.hsl.l < 0.93);
    const pool = meaningful.length && meaningful.reduce((a, x) => a + x.n, 0) > total * 0.05 ? meaningful : colors;
    const dominant = pool.reduce((a, x) => (x.n > a.n ? x : a)).c;

    // Accent: vivid, mid-lightness, and not a single stray pixel.
    let best: RGB | undefined, bestScore = 0;
    for (const x of colors) {
        if (x.hsl.s < 0.25 || x.n < total * 0.004) { continue; }
        const score = Math.sqrt(x.n) * x.hsl.s * x.hsl.s * (1 - Math.abs(x.hsl.l - 0.5) * 1.4);
        if (score > bestScore) { bestScore = score; best = x.c; }
    }
    // Grayscale cover: fall back to a lighter dominant.
    const accent = best ?? tone(dominant, clamp(rgbToHsl(dominant).l + 0.3, 0.45, 0.75));
    return { dominant, accent };
}

// ---------- palette -> workbench.colorCustomizations ----------

export function buildColors(p: Palette, scope: Scope, darkTheme: boolean): Record<string, string> {
    const frame = darkTheme ? tone(p.dominant, 0.16, 0.6) : tone(p.dominant, 0.82, 0.6);
    const frameInactive = darkTheme ? tone(p.dominant, 0.12, 0.4) : tone(p.dominant, 0.88, 0.4);
    const accentHsl = rgbToHsl(p.accent);
    const status = tone(p.accent, clamp(accentHsl.l, darkTheme ? 0.3 : 0.45, darkTheme ? 0.45 : 0.6));
    const bright = tone(p.accent, darkTheme ? clamp(accentHsl.l, 0.55, 0.7) : clamp(accentHsl.l, 0.35, 0.45));
    const frameFg = readableOn(frame);

    const colors: Record<string, string> = {
        'titleBar.activeBackground': hex(frame),
        'titleBar.activeForeground': frameFg,
        'titleBar.inactiveBackground': hex(frameInactive),
        'titleBar.inactiveForeground': frameFg + '99',
        'activityBar.background': hex(frame),
        'activityBar.foreground': frameFg,
        'activityBar.inactiveForeground': frameFg + '80',
        'activityBar.activeBorder': hex(bright),
        'activityBarBadge.background': hex(bright),
        'activityBarBadge.foreground': readableOn(bright),
        'statusBar.background': hex(status),
        'statusBar.foreground': readableOn(status),
        'statusBarItem.hoverBackground': hex(tone(p.accent, clamp(accentHsl.l + 0.1, 0.35, 0.7))),
        'statusBar.border': hex(status),
        'focusBorder': hex(bright, 0.8),
    };
    if (scope === 'full') {
        // Editor surfaces: very dark (or very light) tint of the cover so code stays readable.
        const editor = darkTheme ? tone(p.dominant, 0.085, 0.35) : tone(p.dominant, 0.97, 0.3);
        const side = darkTheme ? tone(p.dominant, 0.11, 0.35) : tone(p.dominant, 0.94, 0.3);
        Object.assign(colors, {
            'editor.background': hex(editor),
            'editorGutter.background': hex(editor),
            'terminal.background': hex(editor),
            'panel.background': hex(editor),
            'tab.activeBackground': hex(editor),
            'sideBar.background': hex(side),
            'sideBarSectionHeader.background': hex(side),
            'editorGroupHeader.tabsBackground': hex(side),
            'tab.inactiveBackground': hex(side),
            'tab.activeBorderTop': hex(bright),
            'editor.selectionBackground': hex(bright, 0.3),
            'editorCursor.foreground': hex(bright),
            'list.activeSelectionBackground': hex(bright, 0.25),
        });
    }
    return colors;
}
