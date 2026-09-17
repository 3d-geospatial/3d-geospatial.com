---
title: "Fixing Tilesets That Never Refine Past the Root"
description: "Find why a 3D Tiles tileset stays at its coarsest level: zero or tiny geometric error, children culled by mis-framed bounding volumes, failed child loads under REPLACE."
---
# Fixing Tilesets That Never Refine Past the Root

This page diagnoses a 3D Tiles tileset that loads, renders its coarsest level and then never shows more detail however close the camera gets — computing the screen-space error the runtime sees for each tile, checking child bounding volumes in the same Earth-centred frame (EPSG:4978) the runtime uses after composing every `transform`, and finding child content that fails to load while a `REPLACE` parent stays on screen.

## Why you hit this

"The tileset only shows the blocky version" is one of the most common reports about a newly generated tileset, and the viewer gives no error because, from its point of view, nothing is wrong: it evaluated the tree and concluded the root was good enough, or that the children were not visible, or it is still waiting for children that will never arrive. There are only four causes that account for nearly every case, and each leaves a distinct signature in the tileset JSON. The general theory of when refinement happens is in [computing geometric error for 3D Tiles levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24` and `requests>=2.31`.
- The tileset URL or a local copy of `tileset.json` and any external tilesets it references.
- A viewer where Cesium's 3D Tiles inspector can be enabled, for confirming what the script finds.

## Step-by-Step

### 1. Compute the screen-space error the root produces

A runtime refines a tile when its screen-space error exceeds `maximumScreenSpaceError` (16 pixels by default in CesiumJS). The error is the tile's geometric error projected to the screen at the camera's distance.

```python
import json
import math
from pathlib import Path

def sse(geometric_error, distance_m, screen_height_px=1080, fov_y_deg=60.0):
    return geometric_error * screen_height_px / (2 * distance_m * math.tan(math.radians(fov_y_deg) / 2))

ts = json.loads(Path("tiles/district/tileset.json").read_text())
root = ts["root"]
ge = root["geometricError"]
for d in (5000, 1000, 200, 50):
    print(f"camera {d:>5} m from root → SSE {sse(ge, d):8.2f} px "
          f"{'refines' if sse(ge, d) > 16 else 'stays'}")
```

A root whose geometric error is 0 produces an SSE of 0 at every distance and never refines — the runtime reads 0 as "this tile is perfect". The same happens, less obviously, with a tiny value such as 0.5 on a tile covering several kilometres: it only refines when the camera is a few tens of metres away, which in practice is under the terrain. Geometric error is in metres; a tiler that wrote it in degrees, or copied the leaf value to every level, produces exactly this.

<figure class="diagram">
<svg viewBox="66 6 668 248" role="img" aria-labelledby="nr-sse-t nr-sse-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nr-sse-t">Screen-space error of the root against camera distance</title>
  <desc id="nr-sse-d">Curves of screen-space error against camera distance for three root geometric errors. A root error of 400 metres crosses the 16 pixel threshold at about 23 kilometres, so it refines as soon as the city is in view. A root error of 2 metres crosses only at about 115 metres. A root error of zero lies on the horizontal axis and never crosses.</desc>
  <rect class="svg-bg" x="66" y="6" width="668" height="248" fill="#ffffff"/>
  <path d="M80 20 V190 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M80 150 H720" fill="none" stroke="#9a4f26" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M100 24 C200 40 300 110 460 150 C560 172 650 180 710 183" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M100 60 C130 130 170 160 240 176 C400 186 600 188 710 189" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M100 189 H710" fill="none" stroke="#b0413e" stroke-width="3"/>
  <text x="712" y="142" fill="#9a4f26" font-size="12" text-anchor="end">maximumScreenSpaceError = 16 px</text>
  <text x="330" y="84" fill="#4f7a4d" font-size="12.5" text-anchor="start">root GE 400 m: refines at ≈ 23 km</text>
  <text x="200" y="138" fill="#1f6b8a" font-size="12.5" text-anchor="start">root GE 2 m: only below ≈ 115 m</text>
  <text x="560" y="178" fill="#b0413e" font-size="12.5" text-anchor="middle">root GE 0: never</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="210">near</text><text x="710" y="210">far</text>
  </g>
  <text x="400" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">camera distance to the tile (log scale), 1080 px viewport, 60° field of view</text>
</svg>
<figcaption>Refinement happens where the curve rises above the threshold. A geometric error of zero keeps the curve flat on the axis at every distance.</figcaption>
</figure>

### 2. Walk the tree and flag geometric-error signatures

```python
def walk(node, parent_ge=None, path="root", depth=0):
    yield path, node, parent_ge, depth
    for i, c in enumerate(node.get("children", [])):
        yield from walk(c, node["geometricError"], f"{path}/{i}", depth + 1)

issues = []
for path, node, parent_ge, depth in walk(root):
    ge = node["geometricError"]
    kids = node.get("children", [])
    if kids and ge == 0:
        issues.append((path, "geometricError 0 on a tile with children: children are never loaded"))
    if parent_ge is not None and ge > parent_ge:
        issues.append((path, f"child error {ge} exceeds parent {parent_ge}"))
    if kids and all(abs(c["geometricError"] - ge) < 1e-9 for c in kids):
        issues.append((path, f"all children share the parent's error {ge}: no reason to refine"))
if ts.get("geometricError", 0) < ge:
    issues.append(("tileset", "top-level geometricError below the root's"))
print(len(issues), "issues", issues[:6])
```

The equal-error signature is common in hand-built or merged tilesets: every level carries the same value, so refinement from a parent to its children changes nothing the runtime can measure, and it may stop at whichever level first satisfies the threshold — usually the root.

### 3. Check that children are where the runtime will look for them

The runtime culls a child whose bounding volume is outside the view. A volume written in the wrong frame is outside every view.

```python
import numpy as np

def mat(t):
    return np.array(t, dtype=float).reshape(4, 4).T if t else np.eye(4)

def box_centre_ecef(box, world):
    return (world @ np.array([box[0], box[1], box[2], 1.0]))[:3]

def region_centre_ecef(region):
    w, s, e, n, lo, hi = region
    lon, lat, h = (w + e) / 2, (s + n) / 2, (lo + hi) / 2
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    N = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return np.array([(N + h) * math.cos(lat) * math.cos(lon),
                     (N + h) * math.cos(lat) * math.sin(lon),
                     (N * (1 - e2) + h) * math.sin(lat)])

def centres(node, world=np.eye(4), path="root"):
    world = world @ mat(node.get("transform"))
    bv = node["boundingVolume"]
    c = box_centre_ecef(bv["box"], world) if "box" in bv else region_centre_ecef(bv["region"]) if "region" in bv else None
    yield path, c
    for i, child in enumerate(node.get("children", [])):
        yield from centres(child, world, f"{path}/{i}")

pts = dict(centres(root))
root_c = pts["root"]
for path, c in pts.items():
    r = np.linalg.norm(c)
    if not 6.30e6 < r < 6.42e6:
        print(f"{path}: bounding volume centre {r / 1000:,.0f} km from Earth's centre — wrong frame")
    elif np.linalg.norm(c - root_c) > 50_000:
        print(f"{path}: {np.linalg.norm(c - root_c) / 1000:.0f} km from the root — outside the tileset")
```

Every tile's bounding volume centre must lie near the Earth's surface — between about 6,300 and 6,420 km from the centre, which covers ocean trenches to mountain tops for the WGS84 ellipsoid. A `box` written in local ENU metres under a child that has *no* `transform`, while the root's transform is not inherited the way the author assumed, sits a few hundred metres from the Earth's centre. A box written in ECEF under a parent that *does* carry a transform ends up twice as far out as it should be. Either way the child is never in view.

<figure class="diagram">
<svg viewBox="115 5 577 259" role="img" aria-labelledby="nr-frame-t nr-frame-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nr-frame-t">Child bounding volumes in the wrong frame</title>
  <desc id="nr-frame-d">The Earth is drawn with the tileset's root box on the surface. A correct child box lies inside the root box. A child box written in local metres without the root's transform sits at the Earth's centre. A child box written in ECEF under a parent transform is translated a second time and sits far out in space. Only the first is ever inside the camera's view.</desc>
  <rect class="svg-bg" x="115" y="5" width="577" height="259" fill="#ffffff"/>
  <path d="M240 130 m-110 0 a110 110 0 1 0 220 0 a110 110 0 1 0 -220 0" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="318" y="44" width="46" height="30" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="330" y="52" width="16" height="12" fill="#ffffff" stroke="#4f7a4d" stroke-width="1.5"/>
  <rect x="232" y="122" width="16" height="16" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="600" y="20" width="16" height="16" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M364 60 L598 30" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="5 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="376" y="80">root box + correct child</text>
  </g>
  <text x="250" y="160" fill="#b0413e" font-size="12.5" text-anchor="middle">local metres, no transform</text>
  <text x="608" y="58" fill="#b0413e" font-size="12.5" text-anchor="middle">ECEF under a transform</text>
  <text x="560" y="150" fill="#15384a" font-size="12.5" text-anchor="middle">|centre| must be 6,300–6,420 km</text>
  <text x="560" y="170" fill="#15384a" font-size="12.5" text-anchor="middle">after composing every transform</text>
  <text x="380" y="246" fill="#15384a" font-size="12.5" text-anchor="middle">not to scale</text>
</svg>
<figcaption>The distance of each bounding volume from the Earth's centre, after applying the accumulated transforms, is a one-line test that catches both frame errors.</figcaption>
</figure>

### 4. Confirm child content actually loads

```python
import requests

BASE = "https://tiles.example.org/district/"

def content_uris(node, base=BASE):
    uri = node.get("content", {}).get("uri")
    if uri:
        yield base + uri
    for c in node.get("children", []):
        yield from content_uris(c, base)

failed = []
for i, url in enumerate(content_uris(root)):
    if i >= 200:
        break
    r = requests.head(url, timeout=15, allow_redirects=True)
    if r.status_code != 200:
        failed.append((url, r.status_code))
print(f"{len(failed)} of the first 200 content URIs fail", failed[:5])
```

Under `REPLACE` refinement, CesiumJS keeps drawing a parent until its children are ready. A child whose content 404s is never ready, so the parent stays — and the tileset looks exactly as though refinement is broken. Case-sensitive storage is a frequent cause: a tiler on macOS wrote `Content/0/0.glb`, the tileset says `content/0/0.glb`, and the Linux-backed object store treats them as different keys. If requests succeed here but fail in the browser, the problem is CORS or encoding, covered in [fixing CORS and content-encoding errors on tile servers](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/fixing-cors-and-content-encoding-errors-on-tile-servers/).

## Expected Output & Verification

For a tileset produced by a script that copied the leaf error upward and wrote child boxes without their transform:

```text
camera  5000 m from root → SSE     0.19 px stays
camera  1000 m from root → SSE     0.94 px stays
camera   200 m from root → SSE     4.68 px stays
camera    50 m from root → SSE    18.71 px refines
3 issues [('root', 'all children share the parent's error 1.0: no reason to refine'), …]
root/0: bounding volume centre 0 km from Earth's centre — wrong frame
0 of the first 200 content URIs fail []
```

Confirm in the runtime with Cesium's inspector, which shows each tile's bounding volume and geometric error live:

```javascript
viewer.extend(Cesium.viewerCesium3DTilesInspectorMixin);
tileset.debugShowBoundingVolume = true;
tileset.debugShowGeometricError = true;
tileset.debugColorizeTiles = true;
```

After the fix, the root's label should show a geometric error in the hundreds of metres, each level's value should roughly halve, and flying towards the city should switch the tile colours level by level. A child bounding volume drawn far from the city, or not at all, confirms a frame problem the script flagged.

<figure class="diagram">
<svg viewBox="6 6 748 228" role="img" aria-labelledby="nr-tri-t nr-tri-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nr-tri-t">Triage order for a tileset that never refines</title>
  <desc id="nr-tri-d">A four-step checklist in order of how quickly each can be tested. First, root and parent geometric errors: zero, tiny, equal to children or larger than parents. Second, child bounding volume centres after composing transforms. Third, HEAD requests for child content. Fourth, in the browser, CORS and content-encoding for the same URLs.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="228" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="20" y="20" width="720" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="72" width="720" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="124" width="720" height="44" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="176" width="720" height="44" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="47">1  geometric error: zero, tiny, equal to children, or larger than the parent</text>
    <text x="40" y="99">2  bounding volume centres 6,300–6,420 km from Earth's centre after transforms</text>
    <text x="40" y="151">3  child content returns 200 (case-sensitive paths)</text>
    <text x="40" y="203">4  in the browser: CORS, Content-Encoding, MIME type</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="end">
    <text x="720" y="47">JSON only</text><text x="720" y="99">JSON only</text>
    <text x="720" y="151">network</text><text x="720" y="203">browser</text>
  </g>
</svg>
<figcaption>The first two checks need nothing but the tileset JSON and find most cases in seconds.</figcaption>
</figure>

## Common Errors

**The root refines only on very large screens.** Screen-space error scales with viewport height, so a geometric error that is marginal on a 1080 px viewport refines on a 4K monitor and never on a phone. Size errors from the geometry, not by trial on one display.

**Refinement works in one viewer and not another.** Runtimes differ in default `maximumScreenSpaceError` and in how they treat an unspecified `refine`. Make `refine` explicit on the root and verify errors against the runtime with the strictest defaults you support.

**Only one quadrant refines.** Three children have correct bounding volumes and one was written in the wrong frame, often because it was produced by a different pipeline stage. The per-node centre check lists exactly which.

## Frequently Asked Questions

### Can a very large maximumScreenSpaceError cause this?

Yes, if the application set it to hundreds of pixels to save memory. The tree is then correct and simply never considered worth refining. Check the value in the running viewer before editing the tileset.

### Does the top-level geometricError matter?

It is the error of the whole tileset when it is referenced as an external tileset, and the runtime uses it to decide whether to load the tileset's root at all. Keep it at least as large as the root's.

### Why does the tileset refine after I zoom in and reload the page?

A restored camera position close to the tiles produces a large enough error to trigger refinement at start-up, while flying in from a distance can leave the root selected if its error is marginal. That is a geometric-error problem showing itself only at some distances.

## Related Guides

- [Choosing ADD vs REPLACE Refinement for 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/choosing-add-vs-replace-refinement/) — how refinement mode changes what stays on screen
- [Tuning Maximum Screen Space Error in Cesium](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/tuning-maximum-screen-space-error-in-cesium/) — the threshold side of the comparison
- [Writing 3D Tiles Validator Checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — catching these before they ship

Back to [Streaming & Runtime Diagnostics for 3D Tiles](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
