/* Check that every internal href in _site resolves (HEAD 200). */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../_site/", import.meta.url).pathname;
const BASE = process.env.BASE || "http://127.0.0.1:8765";

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".html")) yield p;
  }
}

const links = new Map(); // href -> Set(pages)
for await (const file of walk(ROOT)) {
  const html = await readFile(file, "utf8");
  const rel = "/" + file.replace(ROOT, "");
  const re = /href="([^"#]+?)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!href.startsWith("/")) continue; // skip external & relative
    if (!links.has(href)) links.set(href, new Set());
    links.get(href).add(rel);
  }
}

let bad = 0;
for (const [href, pages] of links) {
  const url = BASE + href;
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    if (res.status !== 200) {
      bad++;
      console.error(`✗ ${res.status} ${href}  (from: ${[...pages].slice(0, 3).join(", ")})`);
    }
  } catch (e) {
    bad++;
    console.error(`✗ ERR ${href}: ${e.message}`);
  }
}

console.log(`\nChecked ${links.size} unique internal hrefs; ${bad} broken.`);
process.exit(bad > 0 ? 1 : 0);
