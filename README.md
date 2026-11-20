# Now Playing Theme

Makes VS Code follow the song you're playing on **Spotify** (desktop app) or **YouTube Music** (browser tab or installed web app). Windows only.

- **Colors** – title bar, activity bar, status bar (and optionally editor/sidebar backgrounds) take the album art's colors.
- **Album art background** (opt-in) – the cover shows faintly behind your code and changes with every song.
- **Music video background** (opt-in) – the song's music video plays muted behind your code, synced to the song.

## Install
Not on the Marketplace yet. Build the `.vsix` (see [Build](#build)) or grab one from Releases, then:
```
code --install-extension now-playing-theme-<version>.vsix
```
Click the song in the status bar for options, or the **Video / Cover / Colors** button next to it to switch what's behind your code.

## How it works
- A small PowerShell script reads Windows' media session (the same info shown in the volume flyout) – no Spotify login or API key.
- Colors are written to `workbench.colorCustomizations` in your user settings. Your original values are backed up and restored when the music app closes, or via **Now Playing Theme: Restore My Original Colors**.
- The background needs one `<script>` tag added to VS Code's own `workbench.html` (VS Code has no API for backgrounds). Run **Now Playing Theme: Enable Album Art Background**, then reload.
  - The extension also updates the file's checksum in `product.json`, so VS Code doesn't report a "corrupt" install (originals are backed up and restored on Disable).
  - Every VS Code update removes the patch; the extension notices and offers **Re-apply**.
  - Run **Disable Album Art Background** before uninstalling the extension to put `workbench.html` back.
- The music video uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) (downloaded on first use to `%LOCALAPPDATA%\now-playing-theme`, self-updates weekly). Run **Now Playing Theme: Enable Music Video Background**.
  - After a song plays for `video.delaySeconds`, it searches YouTube (top 5 results, picks the one whose length matches the song) and saves a muted 360p H.264 copy into the background folder. VS Code's bundled ffmpeg can't play VP9/AV1, hence H.264.
  - The video follows the song's position (seeks, pauses) using the timeline Windows reports. The cover shows until the video is ready.
  - Cache is capped at `video.cacheMB`; least-recently-played videos are deleted first. Replayed songs start instantly.
  - Saving YouTube videos is against YouTube's Terms of Service – your call.

## Settings
| Setting | Default | |
|---|---|---|
| `nowPlayingTheme.enabled` | `true` | Master switch – also toggled by clicking the song in the status bar. |
| `nowPlayingTheme.sources` | `["spotify","browser"]` | `browser` also catches regular YouTube videos. |
| `nowPlayingTheme.colors.enabled` | `true` | |
| `nowPlayingTheme.scope` | `full` | `frame` = title/activity/status bars only. |
| `nowPlayingTheme.background.enabled` | `false` | Set by the Enable/Disable commands. |
| `nowPlayingTheme.background.style` | `poster` | `poster` (sharp cover on the right + blurred fill), `blurred`, `sharp`. |
| `nowPlayingTheme.background.opacity` | `0.2` | 0.1 subtle – 0.35 bold. |
| `nowPlayingTheme.video.enabled` | `true` | Only active once yt-dlp is installed via the Enable command. |
| `nowPlayingTheme.video.mode` | `full` | `loop` = tiny copy looping a 30 s slice, not synced. |
| `nowPlayingTheme.video.delaySeconds` | `10` | Skip protection. |
| `nowPlayingTheme.video.cacheMB` | `300` | |
| `nowPlayingTheme.restoreWhenStopped` | `true` | |
| `nowPlayingTheme.pollIntervalMs` | `1500` | |

## Notes
- If you use Settings Sync, add `"settingsSync.ignoredSettings": ["workbench.colorCustomizations"]` so every song change isn't synced.
- The last VS Code window you focused does the updating, so colors keep following the music while you're in Spotify.

## Build
```
npm install
npm run compile
npm run package   # -> now-playing-theme-<version>.vsix
```
