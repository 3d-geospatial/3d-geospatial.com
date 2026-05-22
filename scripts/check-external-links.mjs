/* Extract every external http(s) link from src/**\/*.md and verify it loads.
   - Strategy: HEAD first (many sites block HEAD → fall back to GET, abort on first byte)
   - Reports status, redirects, content-type
   - Uses a realistic User-Agent so anti-bot pages don't 403 us
*/
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../src/", import.meta.url).pathname;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT_MS = 20000;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

function* extractLinks(md) {
  // [text](url)
  const reMd = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = reMd.exec(md)) !== null) yield m[1];
  // Bare URLs
  const reBare = /(?<![("\[])\bhttps?:\/\/[^\s<>"`)]+/g;
  while ((m = reBare.exec(md)) !== null) yield m[0];
}

function cleanUrl(u) {
  // Strip trailing markdown punctuation
  return u.replace(/[.,;:!?)>\]]+$/, "");
}

async function probe(url, method = "HEAD") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    // Drain body if GET so the connection can be reused
    if (method === "GET" && res.body) {
      try { await res.body.cancel(); } catch (_) {}
    }
    return { status: res.status, finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

async function check(url) {
  // Try HEAD, then GET on common HEAD-rejection statuses or network errors
  try {
    const r = await probe(url, "HEAD");
    if (r.status >= 200 && r.status < 400) return r;
    if ([401, 403, 405, 501, 999].includes(r.status)) {
      const r2 = await probe(url, "GET");
      return r2;
    }
    // Retry once on 429 / 5xx
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      await new Promise((res) => setTimeout(res, 1200));
      const r2 = await probe(url, "GET");
      return r2;
    }
    return r;
  } catch (e) {
    try {
      const r2 = await probe(url, "GET");
      return r2;
    } catch (e2) {
      return { status: 0, error: e2.message || String(e2) };
    }
  }
}

const links = new Map(); // url -> Set(pages)
for await (const file of walk(ROOT)) {
  const md = await readFile(file, "utf8");
  const rel = file.replace(ROOT, "");
  for (const raw of extractLinks(md)) {
    const u = cleanUrl(raw);
    if (!links.has(u)) links.set(u, new Set());
    links.get(u).add(rel);
  }
}

console.log(`Found ${links.size} unique external URLs across content.\n`);

const results = [];
const queue = [...links.keys()];
const CONCURRENCY = 6;
let inFlight = 0;
let idx = 0;

await new Promise((resolve) => {
  function pump() {
    if (idx >= queue.length && inFlight === 0) return resolve();
    while (inFlight < CONCURRENCY && idx < queue.length) {
      const url = queue[idx++];
      inFlight++;
      check(url)
        .then((r) => results.push({ url, ...r }))
        .catch((e) => results.push({ url, status: 0, error: String(e) }))
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  }
  pump();
});

results.sort((a, b) => a.url.localeCompare(b.url));

let ok = 0;
let bad = 0;
const broken = [];
for (const r of results) {
  const tag = r.status >= 200 && r.status < 400 ? "OK " : "BAD";
  if (tag === "OK ") ok++;
  else {
    bad++;
    broken.push(r);
  }
  const note =
    r.error ? `  ${r.error}` :
    r.finalUrl && r.finalUrl !== r.url ? `  → ${r.finalUrl}` : "";
  console.log(`${tag} ${String(r.status).padStart(3, " ")}  ${r.url}${note}`);
}

console.log(`\n${ok} OK, ${bad} BAD.`);
if (bad > 0) {
  console.log("\nBroken links (and source pages):");
  for (const r of broken) {
    const pages = [...links.get(r.url)].join(", ");
    console.log(`  ${r.url}\n    used in: ${pages}\n    status: ${r.status}${r.error ? " — " + r.error : ""}`);
  }
}
process.exit(bad > 0 ? 1 : 0);
