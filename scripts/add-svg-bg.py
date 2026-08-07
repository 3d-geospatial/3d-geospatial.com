#!/usr/bin/env python3
"""Give every hand-authored diagram a full-canvas background rect.

The theme remap recolours diagram interiors by exact palette hex. A label with
no shape behind it has nothing to recolour against, so on the night surface it
would be measured against the page rather than the diagram. A `svg-bg` rect
fixes the label's background in both themes; the QA checks know the class and
exclude it from card/overlap geometry.
"""
import re
import sys
import pathlib

SVG_OPEN = re.compile(r'<svg\b[^>]*>', re.I)
VIEWBOX = re.compile(r'viewBox\s*=\s*"\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*"', re.I)

def process(text):
    out, pos, added = [], 0, 0
    for m in SVG_OPEN.finditer(text):
        end = text.find('</svg>', m.end())
        if end == -1:
            continue
        body = text[m.end():end]
        if 'svg-bg' in body:
            continue
        vb = VIEWBOX.search(m.group(0))
        if not vb:
            continue
        x, y, w, h = (float(v) for v in vb.groups())
        if min(w, h) < 64:          # nav/UI glyph, not a diagram
            continue
        # Paint order is document order, so the background must precede every
        # shape — but keep <title>/<desc> first so the accessible name is.
        anchor = m.end()
        for tag in ('</desc>', '</title>'):
            i = text.find(tag, m.end(), end)
            if i != -1:
                anchor = max(anchor, i + len(tag))
        fmt = lambda v: ('%g' % v)
        rect = ('\n  <rect class="svg-bg" x="%s" y="%s" width="%s" height="%s" fill="#ffffff"/>'
                % (fmt(x), fmt(y), fmt(w), fmt(h)))
        out.append(text[pos:anchor])
        out.append(rect)
        pos = anchor
        added += 1
    out.append(text[pos:])
    return ''.join(out), added

def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'src')
    total_files = total_svgs = 0
    for f in sorted(root.rglob('*.md')):
        text = f.read_text(encoding='utf-8')
        new, n = process(text)
        if n:
            f.write_text(new, encoding='utf-8')
            total_files += 1
            total_svgs += n
    print(f'added {total_svgs} background rect(s) across {total_files} file(s)')

if __name__ == '__main__':
    main()
