// Compute fields shared by every template. Eleventy evaluates these
// after frontmatter so we can fall back to parsing the markdown body.
const fs = require("node:fs");

module.exports = {
  title: (data) => {
    if (data.title) return data.title;
    const raw = data.page && data.page.rawInput;
    if (raw) {
      const m = raw.match(/^#\s+(.+?)\s*$/m);
      if (m) return m[1].trim();
    }
    if (data.page && data.page.fileSlug) {
      return data.page.fileSlug
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return null;
  },

  description: (data) => {
    if (data.description) return data.description;
    const raw = data.page && data.page.rawInput;
    if (!raw) return null;
    // skip the H1, take the first paragraph
    const lines = raw.split(/\r?\n/);
    let started = false;
    const collected = [];
    for (const line of lines) {
      if (!started) {
        if (line.startsWith("#")) {
          started = true;
        }
        continue;
      }
      if (collected.length === 0 && line.trim() === "") continue;
      if (line.trim() === "") break;
      if (line.startsWith("#")) break;
      collected.push(line.trim());
    }
    if (!collected.length) return null;
    const text = collected
      .join(" ")
      .replace(/\*\*|__|`|\[|\]\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 200 ? text.slice(0, 197) + "…" : text;
  },

  hasMermaid: (data) => {
    const raw = data.page && data.page.rawInput;
    if (!raw) return false;
    return /```mermaid/.test(raw);
  },

  // Absolute URL of the current page (used in canonical, og:url, JSON-LD)
  canonicalUrl: (data) => {
    const base = (data.site && data.site.url) || "";
    const path = (data.page && data.page.url) || "/";
    return base.replace(/\/$/, "") + path;
  },

  // Last-modified ISO date — use frontmatter override, else file mtime, else build time
  dateModified: (data) => {
    if (data.dateModified) return new Date(data.dateModified).toISOString();
    const path = data.page && data.page.inputPath;
    if (path) {
      try {
        const stat = fs.statSync(path);
        return stat.mtime.toISOString();
      } catch (_) {}
    }
    return new Date().toISOString();
  },
};
