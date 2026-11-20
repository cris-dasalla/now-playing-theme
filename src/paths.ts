import * as path from 'path';

/** Shared, outside VS Code's install: every profile/window and VS Code updates see the same files. */
export const TOOL_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'now-playing-theme');
