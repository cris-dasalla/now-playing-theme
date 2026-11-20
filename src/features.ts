// Build switch. `npm run package:public` flips this to false and leaves out/video.js out of the package,
// so the Marketplace build has no YouTube download code. Personal builds keep it.
export const VIDEO_FEATURE: boolean = true;
