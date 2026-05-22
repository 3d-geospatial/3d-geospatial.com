/* SEO audit for every built HTML page in _site/.
   Checks each page has:
     - <title>, meta description (with length sanity)
     - canonical link, og:url, og:title, og:description, og:image, og:type
     - twitter:card, twitter:title, twitter:description, twitter:image
     - robots meta
     - exactly one <h1>
     - lang attribute on <html>
     - viewport meta
     - JSON-LD <script type="application/ld+json"> that parses, contains required types
     - favicon link, manifest link
   Also: title uniqueness across the site.
*/
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../_site/", import.meta.url).pathname;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".html")) yield p;
  }
}

function pickAttr(html, tag, attrName, attrVal, returnAttr) {
  // crude but adequate for our generator's stable output
  const re = new RegExp(
    `<${tag}\\b[^>]*\\b${attrName}\\s*=\\s*"${attrVal}"[^>]*>`,
    "i"
  );
  const m = html.match(re);
  if (!m) return null;
  const tagText = m[0];
  const re2 = new RegExp(`\\b${returnAttr}\\s*=\\s*"([^"]*)"`, "i");
  const m2 = tagText.match(re2);
  return m2 ? m2[1] : "";
}

function getMeta(html, name) {
  const v =
    pickAttr(html, "meta", "name", name, "content") ??
    pickAttr(html, "meta", "property", name, "content");
  return v == null ? v : decodeEntities(v);
}

function getLink(html, rel) {
  return pickAttr(html, "link", "rel", rel, "href");
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function getTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : null;
}

function countH1(html) {
  return (html.match(/<h1\b/gi) || []).length;
}

function getJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch (e) {
      out.push({ __parseError: e.message, __raw: m[1].slice(0, 200) });
    }
  }
  return out;
}

const REQ_META = [
  "description",
  "viewport",
  "robots",
  "theme-color",
  "twitter:card",
  "twitter:title",
  "twitter:description",
  "twitter:image",
  "og:type",
  "og:title",
  "og:description",
  "og:url",
  "og:image",
  "og:site_name",
];

const REQ_LINKS = ["canonical", "icon", "manifest", "apple-touch-icon"];

let pages = 0;
let failingPages = 0;
const titleMap = new Map(); // title -> [files]
const descMap = new Map();

for await (const file of walk(ROOT)) {
  pages++;
  const rel = "/" + file.replace(ROOT, "");
  const html = await readFile(file, "utf8");
  const problems = [];

  // <html lang="">
  const langOk = /<html\b[^>]*\blang\s*=\s*"[a-z-]+"/i.test(html);
  if (!langOk) problems.push("html lang missing");

  // Title
  const title = getTitle(html);
  if (!title) problems.push("no <title>");
  else if (title.length < 10 || title.length > 80)
    problems.push(`title length ${title.length} (target 10–80)`);

  // H1
  const h1 = countH1(html);
  if (h1 === 0) problems.push("no <h1>");
  if (h1 > 1) problems.push(`multiple <h1> (${h1})`);

  // Required meta tags
  for (const name of REQ_META) {
    const v = getMeta(html, name);
    if (!v) problems.push(`missing meta ${name}`);
    else if (name === "description" && (v.length < 50 || v.length > 200))
      problems.push(`description length ${v.length} (target 50–200)`);
  }

  // Required links
  for (const rel of REQ_LINKS) {
    const v = getLink(html, rel);
    if (!v) problems.push(`missing link rel="${rel}"`);
  }

  // JSON-LD
  const jsonld = getJsonLd(html);
  if (jsonld.length === 0) problems.push("no JSON-LD");
  for (const ld of jsonld) {
    if (ld.__parseError) {
      problems.push(`JSON-LD parse: ${ld.__parseError}`);
      continue;
    }
    const graph = ld["@graph"] || (Array.isArray(ld) ? ld : [ld]);
    const types = graph.map((n) => n && n["@type"]).filter(Boolean);
    if (!types.includes("Organization")) problems.push("JSON-LD: no Organization");
    if (!types.includes("WebSite")) problems.push("JSON-LD: no WebSite");
    const isContent = rel !== "/index.html" && !rel.includes("/assets/");
    if (isContent) {
      if (!types.includes("TechArticle") && !types.includes("Article"))
        problems.push("JSON-LD: no TechArticle/Article (content page)");
      if (!types.includes("BreadcrumbList"))
        problems.push("JSON-LD: no BreadcrumbList (content page)");
    }
  }

  if (title) {
    if (!titleMap.has(title)) titleMap.set(title, []);
    titleMap.get(title).push(rel);
  }
  const desc = getMeta(html, "description");
  if (desc) {
    if (!descMap.has(desc)) descMap.set(desc, []);
    descMap.get(desc).push(rel);
  }

  if (problems.length) {
    failingPages++;
    console.error(`\n✗ ${rel}`);
    problems.forEach((p) => console.error("    - " + p));
  }
}

// Uniqueness
const dupTitles = [...titleMap.entries()].filter(([, v]) => v.length > 1);
const dupDescs = [...descMap.entries()].filter(([, v]) => v.length > 1);
if (dupTitles.length) {
  console.error("\n⚠ duplicate titles:");
  for (const [t, files] of dupTitles) {
    console.error(`  "${t}"`);
    files.forEach((f) => console.error("    " + f));
  }
}
if (dupDescs.length) {
  console.error("\n⚠ duplicate descriptions:");
  for (const [d, files] of dupDescs) {
    console.error(`  "${d.slice(0, 80)}…"`);
    files.forEach((f) => console.error("    " + f));
  }
}

console.log(
  `\nScanned ${pages} pages — ${pages - failingPages} clean, ${failingPages} with issues.`
);
console.log(
  `Unique titles: ${titleMap.size} / ${pages}. Unique descriptions: ${descMap.size} / ${pages}.`
);

// File presence
const required = ["robots.txt", "sitemap.xml", "favicon.ico", "manifest.webmanifest", "sw.js", "assets/img/og-cover.png"];
let missing = 0;
for (const f of required) {
  try {
    await readFile(join(ROOT, f));
  } catch {
    missing++;
    console.error(`✗ missing: /${f}`);
  }
}
if (missing === 0) console.log(`Required SEO files: ${required.length}/${required.length} present.`);

const exit = failingPages + dupTitles.length + dupDescs.length + missing;
process.exit(exit > 0 ? 1 : 0);
