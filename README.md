# Now Playing Theme

Makes VS Code follow the song you're playing on **Spotify** (desktop app) or **YouTube Music** (browser tab or installed web app). **Windows only.** Preview.

- **Colors** – the title bar, activity bar, status bar and (optionally) editor background take the album art's colors, and change with every song.
- **Album art background** (opt-in) – the cover shows faintly behind your code.
<!-- personal -->
- **Music video background** (opt-in, personal build only) – the song's music video plays muted behind your code, synced to the song.
<!-- /personal -->

No Spotify login, API key or account needed: it reads what Windows already shows in its media controls.

## Getting started
1. Install, then play something on Spotify or YouTube Music. The colors follow the song straight away.
2. The song appears in the status bar. Click it for options.
3. Want the cover behind your code? Run **Now Playing Theme: Enable Album Art Background** (see below), then use the button next to the song to switch between the background and **Colors** only.

## How it works
- A small PowerShell script reads Windows' media session (the same info shown in the volume flyout).
- Colors are written to `workbench.colorCustomizations` in your user settings. Your original values are backed up and restored when the music app closes, or via **Now Playing Theme: Restore My Original Colors**.
- **The background modifies VS Code's own files**, because VS Code has no API for backgrounds. It adds one `<script>` tag to `workbench.html` and updates that file's checksum in `product.json`, so VS Code doesn't report a "corrupt" install. Originals are backed up.
  - Every VS Code update removes it; the extension notices and offers **Re-apply**.
  - Run **Disable Album Art Background** before uninstalling the extension, to put VS Code's files back.
<!-- personal -->
- The music video uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) (downloaded on first use to `%LOCALAPPDATA%\now-playing-theme`, self-updates weekly). Run **Now Playing Theme: Enable Music Video Background**.
  - After a song plays for `video.delaySeconds`, it searches YouTube (top 5 results, picks the one whose length matches the song) and saves a muted 360p H.264 copy into the background folder. VS Code's bundled ffmpeg can't play VP9/AV1, hence H.264.
  - The video follows the song's position (seeks, pauses) using the timeline Windows reports. The cover shows until the video is ready.
  - Cache is capped at `video.cacheMB`; least-recently-played videos are deleted first. Replayed songs start instantly.
  - Saving YouTube videos is against YouTube's Terms of Service, which is why this isn't in the Marketplace build.
<!-- /personal -->

## Settings
| Setting | Default | |
|---|---|---|
| `nowPlayingTheme.enabled` | `true` | Master switch (also in the status-bar menu). |
| `nowPlayingTheme.sources` | `["spotify","browser"]` | `browser` also catches regular YouTube videos. |
| `nowPlayingTheme.colors.enabled` | `true` | |
| `nowPlayingTheme.scope` | `full` | `frame` = title/activity/status bars only. |
| `nowPlayingTheme.background.style` | `poster` | `poster` (sharp cover on the right + blurred fill), `blurred`, `sharp`. |
| `nowPlayingTheme.background.opacity` | `0.2` | 0.1 subtle – 0.35 bold. |
| `nowPlayingTheme.minTrackSeconds` | `60` | Ignores shorter "tracks" (YouTube ads). `0` = follow everything. |
| `nowPlayingTheme.restoreWhenStopped` | `true` | |
| `nowPlayingTheme.pollIntervalMs` | `1500` | |
<!-- personal -->

Music video (personal build only):

| Setting | Default | |
|---|---|---|
| `nowPlayingTheme.video.enabled` | `true` | Only active once yt-dlp is installed via the Enable command. |
| `nowPlayingTheme.video.mode` | `full` | `loop` = tiny copy looping a 30 s slice, not synced. |
| `nowPlayingTheme.video.delaySeconds` | `10` | Skip protection. |
| `nowPlayingTheme.video.cacheMB` | `300` | |
<!-- /personal -->

## Notes
- If you use Settings Sync, add `"settingsSync.ignoredSettings": ["workbench.colorCustomizations"]` so every song change isn't synced.
- The last VS Code window you focused does the updating, so colors keep following the music while you're in Spotify.
- `browser` sources pick up whatever the browser is playing, including ordinary YouTube videos.
- With several players open (e.g. Spotify and a browser) it follows the one Windows treats as current, the one your media keys control.

<!-- personal -->
## Build
```
npm install
npm run package                                  # personal build (includes the music-video feature)
npm run package:public -- --publisher <your-id>  # Marketplace build: no video code, Windows targets -> dist/
```
<!-- /personal -->
