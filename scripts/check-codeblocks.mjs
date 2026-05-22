/* QA pass over every fenced codeblock in src/**\/*.md.
   - Reports the language label
   - Validates JSON via JSON.parse
   - Validates Python syntax via `python3 -c "ast.parse(...)"`
   - Lints Python with pyflakes (unused/undefined/duplicate)
   - Validates Bash via `bash -n`, then lints with shellcheck
   - Flags blocks whose minimum indent mixes tabs and spaces
*/
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

const ROOT = new URL("../src/", import.meta.url).pathname;
const VENV_PY = "/tmp/qa-venv/bin/python";

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

function extractBlocks(md) {
  const blocks = [];
  const lines = md.split(/\n/);
  let inBlock = false;
  let lang = "";
  let startLine = 0;
  let buf = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!inBlock) {
      const m = ln.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
      if (m) {
        inBlock = true;
        lang = m[1].trim().toLowerCase();
        startLine = i + 2; // 1-indexed, after fence
        buf = [];
      }
    } else if (ln.startsWith("```")) {
      blocks.push({ lang, code: buf.join("\n"), startLine });
      inBlock = false;
    } else {
      buf.push(ln);
    }
  }
  return blocks;
}

function checkIndentation(code) {
  const lines = code.split(/\n/);
  let hasTab = false;
  let hasSpace = false;
  for (const ln of lines) {
    const lead = ln.match(/^([\t ]+)/);
    if (!lead) continue;
    if (lead[1].includes("\t")) hasTab = true;
    if (lead[1].includes(" ")) hasSpace = true;
  }
  return hasTab && hasSpace ? "mixed tabs and spaces in leading whitespace" : null;
}

function checkPythonSyntax(code) {
  const res = spawnSync(
    "python3",
    ["-c", "import sys, ast; ast.parse(sys.stdin.read())"],
    { input: code, encoding: "utf8" }
  );
  if (res.status === 0) return null;
  const msg = (res.stderr || "").split(/\r?\n/).slice(-3).join(" | ").trim();
  return msg || "syntax error";
}

function pyflakes(code) {
  // pyflakes 3.x doesn't read stdin via '-'; write to a temp file.
  const tmp = "/tmp/qa-block-" + Math.random().toString(36).slice(2) + ".py";
  writeFileSync(tmp, code);
  try {
    const res = spawnSync(VENV_PY, ["-m", "pyflakes", tmp], { encoding: "utf8" });
    const out = ((res.stdout || "") + (res.stderr || "")).trim();
    if (!out) return null;
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(new RegExp("^" + tmp + ":"), "line "))
      .join("\n      ");
  } finally {
    try { unlinkSync(tmp); } catch (_) {}
  }
}

function checkJSON(code) {
  try {
    JSON.parse(code);
    return null;
  } catch (e) {
    return e.message;
  }
}

function checkBashSyntax(code) {
  const res = spawnSync("bash", ["-n"], { input: code, encoding: "utf8" });
  if (res.status === 0) return null;
  return (res.stderr || "").trim();
}

function shellcheck(code) {
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const res = spawnSync(
    "shellcheck",
    ["-s", "bash", "-S", "warning", "--color=never", "-"],
    { input: code, encoding: "utf8" }
  );
  const out = (res.stdout || "").trim();
  if (!out) return null;
  return out
    .split(/\r?\n/)
    .slice(0, 20)
    .join("\n      ");
}

let total = 0;
let issues = 0;
let pyfilesScanned = 0;
let pyfilesWithIssues = 0;

for await (const file of walk(ROOT)) {
  const md = await readFile(file, "utf8");
  const blocks = extractBlocks(md);
  if (!blocks.length) continue;
  const rel = file.replace(ROOT, "");

  // Per-block checks (syntax/indentation/JSON/bash)
  for (const [i, b] of blocks.entries()) {
    total++;
    const problems = [];
    const indent = checkIndentation(b.code);
    if (indent) problems.push(indent);
    if (b.lang === "json") {
      const r = checkJSON(b.code);
      if (r) problems.push("JSON: " + r);
    }
    if (b.lang === "python" || b.lang === "py") {
      const r = checkPythonSyntax(b.code);
      if (r) problems.push("Python syntax: " + r);
    }
    if (b.lang === "bash" || b.lang === "sh" || b.lang === "shell") {
      const r = checkBashSyntax(b.code);
      if (r) problems.push("Bash syntax: " + r);
      else {
        const sc = shellcheck(b.code);
        if (sc) problems.push("shellcheck:\n      " + sc);
      }
    }
    if (problems.length) {
      issues++;
      console.error(`\n✗ ${rel}:${b.startLine} (block ${i + 1}, lang=${b.lang || "text"})`);
      problems.forEach((p) => console.error("    - " + p));
    }
  }

  // pyflakes on the concatenated Python blocks for this file (tutorial-chain mode).
  // Each block is separated by a blank line so line numbers stay close to source.
  const pyBlocks = blocks.filter((b) => b.lang === "python" || b.lang === "py");
  if (pyBlocks.length > 0) {
    pyfilesScanned++;
    const combined = pyBlocks.map((b) => b.code).join("\n\n# ----- next block -----\n\n");
    let pf = pyflakes(combined);
    if (pf) {
      // Concatenation artifact: each block is independently runnable, so the
      // same module may be imported in multiple blocks. Pyflakes flags this as
      // 'redefinition of unused …' once they're combined — drop those lines.
      pf = pf
        .split("\n")
        .filter((l) => !/redefinition of unused/.test(l))
        .join("\n")
        .trim();
    }
    if (pf) {
      pyfilesWithIssues++;
      console.error(`\n✗ ${rel} (combined python blocks)`);
      pf.split("\n").forEach((l) => console.error("    " + l));
    }
  }
}

console.log(
  `\nScanned ${total} codeblocks per-block; ${issues} with per-block issues.`
);
console.log(
  `Scanned ${pyfilesScanned} python-bearing files (combined); ${pyfilesWithIssues} with issues.`
);
process.exit(issues + pyfilesWithIssues > 0 ? 1 : 0);
