/* Dump every fenced codeblock in src/**\/*.md with file path, line number, and lang. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../src/", import.meta.url).pathname;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

for await (const file of walk(ROOT)) {
  const md = await readFile(file, "utf8");
  const lines = md.split(/\n/);
  let inBlock = false;
  let lang = "";
  let start = 0;
  let buf = [];
  const rel = file.replace(ROOT, "");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!inBlock) {
      const m = ln.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
      if (m) {
        inBlock = true;
        lang = m[1].trim().toLowerCase();
        start = i + 1;
        buf = [];
      }
    } else {
      if (ln === "```" || ln.startsWith("```")) {
        console.log(`\n=== ${rel}:${start} lang=${lang || "text"} ===`);
        console.log(buf.join("\n"));
        inBlock = false;
      } else {
        buf.push(ln);
      }
    }
  }
}
