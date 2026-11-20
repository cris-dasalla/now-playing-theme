// Build switches. `npm run package:public` flips both to false and leaves the matching files
// (out/video.js, out/integrity.js) out of the Marketplace package. Personal builds keep them.
export const VIDEO_FEATURE: boolean = true;   // music-video background (yt-dlp)
export const FIX_CHECKSUM: boolean = true;    // update product.json so VS Code doesn't report a "corrupt" install
