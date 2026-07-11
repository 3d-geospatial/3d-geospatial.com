#!/usr/bin/env python3
"""Regenerate the frontmatter-stripped `content/` mirror from the build source `src/`.

The build reads `src/`; several shared QA gates (term_lint, svg_check static lint,
mermaid_check) scan `content/`. This keeps the two in sync: for every `src/**/index.md`
(excluding the homepage and non-content templates) write `content/<same rel path>` with the
leading `---\n...\n---\n` frontmatter block removed. Removes stray content/ files whose src
counterpart no longer exists.
"""
import os
import re
import sys

ROOT = "/home/martin/WebstormProjects/3d-geospatial.com"
SRC = os.path.join(ROOT, "src")
CONTENT = os.path.join(ROOT, "content")
FM = re.compile(r"^---\n.*?\n---\n", re.S)

# Only mirror real content pages: those living under a top-level section dir with an index.md.
def content_md_files():
    out = []
    for r, _, files in os.walk(SRC):
        for f in files:
            if f != "index.md":
                continue
            ap = os.path.join(r, f)
            rel = os.path.relpath(ap, SRC)
            # skip anything not under a section (e.g. src/index.njk is not .md anyway)
            out.append((ap, rel))
    return out

def main():
    written, removed = 0, 0
    wanted = set()
    for ap, rel in content_md_files():
        wanted.add(rel)
        body = FM.sub("", open(ap, encoding="utf-8").read(), count=1)
        dest = os.path.join(CONTENT, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        old = open(dest, encoding="utf-8").read() if os.path.isfile(dest) else None
        if old != body:
            open(dest, "w", encoding="utf-8").write(body)
            written += 1
    # prune stray content/ index.md files with no src counterpart
    for r, _, files in os.walk(CONTENT):
        for f in files:
            if f != "index.md":
                continue
            rel = os.path.relpath(os.path.join(r, f), CONTENT)
            if rel not in wanted:
                os.remove(os.path.join(r, f))
                removed += 1
    print(f"sync-content-mirror: {written} written/updated, {removed} removed, "
          f"{len(wanted)} total content pages")

if __name__ == "__main__":
    sys.exit(main())
