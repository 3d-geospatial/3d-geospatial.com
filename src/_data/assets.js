// Content-hash versions for cache-busting mutable assets (CSS/JS).
//
// styles.css / site.js ship under stable, NON-fingerprinted filenames but are
// served with `immutable, max-age=31536000` (see src/_headers). Without a
// version marker the Cloudflare edge keeps serving a stale copy after a deploy
// that changes them. We append `?v=<hash>` in the templates so each change
// produces a fresh URL (a new cache key) while unchanged files stay cached.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

function hashFile(relFromSrc) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, "..", relFromSrc));
    return crypto.createHash("md5").update(buf).digest("hex").slice(0, 10);
  } catch (_) {
    // Fall back to a build-unique marker so we never serve a stale URL.
    return crypto.randomBytes(5).toString("hex");
  }
}

module.exports = {
  cssVersion: hashFile("assets/css/styles.css"),
  jsVersion: hashFile("assets/js/site.js"),
};
