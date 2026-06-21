#!/usr/bin/env node
// Mirror each src index.md article body into content/ (frontmatter stripped).
//
// src/ is the Eleventy build source of truth (markdown + YAML frontmatter). The
// shared QA gates term_lint.py and mermaid_check.py, plus the Django word-count,
// read content/ — a body-only mirror. This regenerates content/ from src/ so the
// two never drift. Run after editing any page and before the QA gates / refresh.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC = "src";
const OUT = "content";

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "assets" || entry === "_includes" || entry === "_data") continue;
      walk(p, acc);
    } else if (entry === "index.md") {
      acc.push(p);
    }
  }
  return acc;
}

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const after = text.indexOf("\n", end + 1);
      return text.slice(after + 1).replace(/^\s+/, "");
    }
  }
  return text;
}

let n = 0;
for (const srcPath of walk(SRC)) {
  const rel = srcPath.slice(SRC.length + 1); // e.g. a/b/index.md
  const outPath = join(OUT, rel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stripFrontmatter(readFileSync(srcPath, "utf8")));
  n++;
}
console.log(`sync-content: wrote ${n} body files to ${OUT}/`);
