const path = require("node:path");
const fs = require("node:fs");

const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItTaskLists = require("markdown-it-task-lists");
const Prism = require("prismjs");
const loadLanguages = require("prismjs/components/");
loadLanguages(["python", "json", "bash", "yaml", "javascript", "typescript", "sql", "ini", "docker", "nginx", "toml"]);

const eleventyNavigationPlugin = require("@11ty/eleventy-navigation");

const SITE_TITLE = "3D Geospatial & Digital Twin Automation";

const md = markdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

// Override fence renderer so we fully control the codeblock wrapper
// (markdown-it's default would re-wrap in <pre><code>).
md.renderer.rules.fence = function (tokens, idx) {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const language = info.split(/\s+/)[0].toLowerCase();
  const code = token.content;

  if (language === "mermaid") {
    return `<pre class="mermaid">${escapeHtml(code)}</pre>\n`;
  }

  const langLabel = language || "text";
  let highlighted;
  if (language && Prism.languages[language]) {
    try {
      highlighted = Prism.highlight(code, Prism.languages[language], language);
    } catch (_) {
      highlighted = escapeHtml(code);
    }
  } else {
    highlighted = escapeHtml(code);
  }

  return (
    `<div class="codeblock" data-lang="${langLabel}">` +
      `<div class="codeblock__bar">` +
        `<span class="codeblock__lang">${langLabel}</span>` +
        `<button type="button" class="codeblock__copy" aria-label="Copy code to clipboard">Copy</button>` +
      `</div>` +
      `<pre class="codeblock__pre language-${langLabel}" tabindex="0" role="group" aria-label="${langLabel} code sample"><code class="language-${langLabel}">${highlighted}</code></pre>` +
    `</div>\n`
  );
};

md.use(markdownItAnchor, {
  permalink: markdownItAnchor.permalink.headerLink({
    safariReaderFix: true,
    class: "heading-link",
  }),
  slugify: (s) =>
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-"),
});
md.use(markdownItAttrs);
md.use(markdownItTaskLists, { enabled: true, label: true });

// Wrap tables so they scroll horizontally on small screens.
const defaultTableOpen = md.renderer.rules.table_open || function (tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
  return `<div class="table-wrap">` + defaultTableOpen(tokens, idx, options, env, self);
};
const defaultTableClose = md.renderer.rules.table_close || function (tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
  return defaultTableClose(tokens, idx, options, env, self) + `</div>`;
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = function (eleventyConfig) {
  eleventyConfig.setLibrary("md", md);
  eleventyConfig.addPlugin(eleventyNavigationPlugin);

  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/favicon.ico": "favicon.ico" });
  eleventyConfig.addPassthroughCopy({ "src/manifest.webmanifest": "manifest.webmanifest" });
  eleventyConfig.addPassthroughCopy({ "src/sw.js": "sw.js" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });
  // Cloudflare Pages directives — must land at the deploy root.
  eleventyConfig.addPassthroughCopy({ "src/_headers": "_headers" });
  eleventyConfig.addPassthroughCopy({ "src/_redirects": "_redirects" });

  eleventyConfig.addFilter("readableDate", (d) => {
    const date = new Date(d);
    return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  });

  eleventyConfig.addShortcode("year", () => String(new Date().getFullYear()));

  eleventyConfig.addFilter("titleCase", (s) =>
    String(s || "")
      .replace(/[-_]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((w) => {
        const upper = ["3d", "crs", "lod", "qa", "ci", "cd", "pwa", "gltf", "obj", "wgs84"];
        if (upper.includes(w.toLowerCase())) return w.toUpperCase();
        return w[0].toUpperCase() + w.slice(1);
      })
      .join(" ")
  );

  // Breadcrumb segments from a URL like /a/b/c/ -> [{label, url}, ...]
  eleventyConfig.addFilter("breadcrumbs", function (url) {
    const segments = (url || "/").split("/").filter(Boolean);
    const crumbs = [{ label: "Home", url: "/" }];
    let acc = "";
    for (const seg of segments) {
      acc += "/" + seg;
      crumbs.push({ label: seg.replace(/[-_]+/g, " "), url: acc + "/" });
    }
    return crumbs;
  });

  // Sort an array of page objects alphabetically by title
  eleventyConfig.addFilter("byTitle", (arr) =>
    [...(arr || [])].sort((a, b) => {
      const ta = (a.data && a.data.title) || a.fileSlug || "";
      const tb = (b.data && b.data.title) || b.fileSlug || "";
      return String(ta).localeCompare(String(tb));
    })
  );

  // Find child pages: collection items whose URL starts with this URL but is one segment deeper.
  eleventyConfig.addFilter("childrenOf", function (collection, url) {
    if (!url) return [];
    const depth = url.split("/").filter(Boolean).length;
    return (collection || []).filter((item) => {
      if (!item.url || item.url === url) return false;
      if (!item.url.startsWith(url)) return false;
      const itemDepth = item.url.split("/").filter(Boolean).length;
      return itemDepth === depth + 1;
    });
  });

  // Siblings: same parent URL, exclude self.
  eleventyConfig.addFilter("siblingsOf", function (collection, url) {
    if (!url) return [];
    const segments = url.split("/").filter(Boolean);
    if (segments.length === 0) return [];
    const parent = "/" + segments.slice(0, -1).join("/") + (segments.length > 1 ? "/" : "");
    const depth = segments.length;
    return (collection || []).filter((item) => {
      if (!item.url || item.url === url) return false;
      if (!item.url.startsWith(parent)) return false;
      const itemDepth = item.url.split("/").filter(Boolean).length;
      return itemDepth === depth;
    });
  });

  // Build top-level sections collection (one segment deep)
  eleventyConfig.addCollection("topSections", function (collectionApi) {
    return collectionApi
      .getAll()
      .filter((i) => {
        if (!i.url) return false;
        const depth = i.url.split("/").filter(Boolean).length;
        return depth === 1;
      })
      .sort((a, b) => (a.data.order || 0) - (b.data.order || 0));
  });

  // All content (excludes the homepage)
  eleventyConfig.addCollection("contentPages", function (collectionApi) {
    return collectionApi.getAll().filter((i) => i.url && i.url !== "/" && !i.url.includes("/assets/"));
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html", "11ty.js"],
  };
};
