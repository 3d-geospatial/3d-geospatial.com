#!/usr/bin/env bash
# Build, retighten every diagram viewBox to its content, rebuild, refresh the
# content/ mirror the static gates read, then report svg_check.
set -e
cd "$(dirname "$0")/.."
npm run build >/dev/null
(cd /home/martin/WebstormProjects/_qa && node _geo_trim.mjs "$OLDPWD" | tail -1)
npm run build >/dev/null
python3 scripts/sync-content-mirror.py >/dev/null
python3 /home/martin/WebstormProjects/_qa/svg_check.py 3d-geospatial.com 2>&1 | grep -E "^(WARN|FAIL|static|svg_page_check|svg_check)|✗|!"
