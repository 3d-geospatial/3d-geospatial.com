# Automated Tile Generation for 3D Geospatial Data & Digital Twin Automation

A city-scale mesh or a multi-billion-point LiDAR survey cannot be handed to a browser as a single file — the client would block for minutes and exhaust GPU memory long before the first frame. Automated tile generation solves this by partitioning a monolithic dataset into a hierarchy of small, self-describing tiles (`b3dm`, `pnts`, or `glb`) indexed by a `tileset.json` tree, where each node carries a bounding volume and a `geometricError` that tells the renderer when to fetch its higher-resolution children. This page is a runnable workflow for producing that hierarchy with `py3dtiles` and the `3d-tiles-tools` CLI, computing a correct per-level `geometricError`, placing tiles in Earth-Centered Earth-Fixed coordinates (EPSG:4978) for CesiumJS, and validating the result before it reaches a CDN. It assumes you already have manifold meshes or classified point clouds in a known CRS and want a deterministic, CI-friendly tiling step inside [LOD management](https://www.3d-geospatial.com/lod-management-optimization-strategies/).

## Prerequisites

Version-lock every component so a tileset rebuilt six months from now is byte-comparable. The combinations below are tested together; mixing a newer `3d-tiles-tools` with an older glTF exporter is the most common source of silent validation failures.

| Component | Pinned version | Purpose |
|-----------|----------------|---------|
| Python | 3.10–3.12 | Orchestration, geometry math, subprocess control |
| `py3dtiles` | 8.0+ | Native `pnts`/`b3dm` writing and `tileset.json` assembly |
| `trimesh` | 4.4+ | Mesh load, bounds, decimation feed into glTF export |
| `pyproj` | 3.6+ | CRS transforms, including geographic → ECEF EPSG:4978 |
| `numpy` | 1.26+ | Bounding-volume math, geometricError arrays |
| `3d-tiles-tools` | 0.4+ (Node 18+) | glTF→`b3dm`, Draco encoding, gzip, upgrade 1.0→1.1 |
| `3d-tiles-validator` | 0.5+ | Schema + bounding-volume + geometricError validation |

**Input formats.** Geometry must arrive as glTF 2.0 / `.glb` per building or block (for `b3dm` tiles) or as classified `.laz`/`.las` (for `pnts` tiles). Meshes must be watertight with consistent winding — non-manifold input survives tiling but breaks picking and silhouette LOD later.

**Coordinate reference systems — state them, never infer.** Source data is typically a projected metric CRS such as UTM zone 18N over NAVD88 (compound EPSG:32618+5703) or a national grid like EPSG:27700. CesiumJS, however, renders in a right-handed Earth-Centered Earth-Fixed frame: **EPSG:4978 (geocentric WGS84, metres)**. Every tile's vertices and bounding volume must end up in EPSG:4978, and the root tile carries a 4×4 `transform` that places local-origin geometry onto the WGS84 ellipsoid. The reprojection chain for this workflow is EPSG:32618+5703 → EPSG:4979 (geographic 3D) → EPSG:4978 (ECEF). Skipping the geographic-3D hop and transforming a projected CRS straight to ECEF is the single most common reason a tileset renders kilometres underground.

## Concept

A 3D Tiles tileset is a tree. The root `tileset.json` declares an `asset.version`, a `geometricError` for the whole tileset, and a `root` tile; every tile has a `boundingVolume`, its own `geometricError`, an optional `content` (the `.b3dm`/`.pnts`/`.glb` payload), and `children`. The renderer walks the tree top-down: for each tile it estimates the on-screen pixel error implied by that tile's `geometricError` at the current camera distance, and if that error exceeds the screen-space error budget (Cesium's `maximumScreenSpaceError`, default 16), it refines — fetching the children — otherwise it stops and renders the current tile.

This makes `geometricError` the load-bearing number in the whole system. It is the **world-space distance, in metres, between this tile's simplified geometry and the ground truth it approximates.** It must decrease monotonically with depth: the root is coarse (large error, e.g. 512 m for a city), each level roughly halves it, and leaves hold the full-resolution geometry at `geometricError` 0. Get the scale wrong and you either over-refine (every tile loads at once, defeating the purpose) or under-refine (blurry geometry that never sharpens). Because tiles live in EPSG:4978, that distance is a true metric distance on the ellipsoid, not a pixel or a projected unit.

<figure class="diagram">
<svg viewBox="46 11 728 355" role="img" aria-labelledby="tile-tree-t tile-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tile-tree-t">Tileset quadtree with geometricError decreasing by depth</title>
  <desc id="tile-tree-d">A root tile with a large geometric error refines into four children with half the error, which refine again into leaf tiles with zero error holding full-resolution content; the renderer stops refining once a tile's screen-space error falls below the budget.</desc>
  <rect class="svg-bg" x="46" y="11" width="728" height="355" fill="#ffffff"/>
  <defs>
    <marker id="tile-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <line x1="410" y1="70" x2="230" y2="150" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <line x1="410" y1="70" x2="590" y2="150" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <line x1="230" y1="200" x2="140" y2="280" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <line x1="230" y1="200" x2="320" y2="280" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <line x1="590" y1="200" x2="500" y2="280" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <line x1="590" y1="200" x2="680" y2="280" stroke="#5b6471" stroke-width="2" marker-end="url(#tile-arrow)"/>
  <rect x="330" y="25" width="160" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="150" y="153" width="160" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="510" y="153" width="160" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="60" y="282" width="160" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="240" y="282" width="160" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="420" y="282" width="160" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="600" y="282" width="160" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="410" y="44" fill="#1f2937" font-size="13" text-anchor="middle">Root tile</text>
  <text x="410" y="61" fill="#15384a" font-size="13" text-anchor="middle">geometricError 512 m</text>
  <text x="230" y="172" fill="#1f2937" font-size="13" text-anchor="middle">Internal tile</text>
  <text x="230" y="189" fill="#15384a" font-size="13" text-anchor="middle">error 256 m</text>
  <text x="590" y="172" fill="#1f2937" font-size="13" text-anchor="middle">Internal tile</text>
  <text x="590" y="189" fill="#15384a" font-size="13" text-anchor="middle">error 256 m</text>
  <text x="140" y="301" fill="#1f2937" font-size="13" text-anchor="middle">Leaf .b3dm</text>
  <text x="140" y="318" fill="#15384a" font-size="13" text-anchor="middle">error 0</text>
  <text x="320" y="301" fill="#1f2937" font-size="13" text-anchor="middle">Leaf .b3dm</text>
  <text x="320" y="318" fill="#15384a" font-size="13" text-anchor="middle">error 0</text>
  <text x="500" y="301" fill="#1f2937" font-size="13" text-anchor="middle">Leaf .b3dm</text>
  <text x="500" y="318" fill="#15384a" font-size="13" text-anchor="middle">error 0</text>
  <text x="680" y="301" fill="#1f2937" font-size="13" text-anchor="middle">Leaf .b3dm</text>
  <text x="680" y="318" fill="#15384a" font-size="13" text-anchor="middle">error 0</text>
  <text x="410" y="348" fill="#5b6471" font-size="12" text-anchor="middle">Refine deeper only while screen-space error &gt; budget (default 16 px)</text>
</svg>
<figcaption>Each depth halves geometricError; leaves hold full-resolution content at error 0, and the client stops refining once a tile is sharp enough on screen.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow takes a directory of per-building `.glb` files, projects their footprints into ECEF, groups them into a quadtree, computes a `geometricError` per level, encodes each leaf to `b3dm` with Draco, and assembles a `tileset.json`. Every step is idempotent so the whole thing drops into CI.

### 1. Resolve the CRS chain and build the ECEF transform

The root tile's `transform` is a column-major 4×4 matrix that moves geometry authored around a local origin onto the WGS84 geocentric frame. Compute it once from the dataset's anchor point.

```python
import numpy as np
from pyproj import Transformer

# Source data: UTM 18N + NAVD88 (compound EPSG:32618+5703).
# Cesium renders in geocentric ECEF WGS84 (EPSG:4978, metres).
# Go via geographic 3D (EPSG:4979) so the vertical datum is handled.
to_geographic = Transformer.from_crs("EPSG:32618+5703", "EPSG:4979", always_xy=True)
to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)

# Dataset anchor (centre of the survey) in EPSG:32618+5703.
anchor_e, anchor_n, anchor_h = 583_000.0, 4_507_000.0, 12.0
lon, lat, h = to_geographic.transform(anchor_e, anchor_n, anchor_h)
cx, cy, cz = to_ecef.transform(lon, lat, h)

def ecef_enu_transform(lon_deg, lat_deg, x, y, z):
    """Column-major 4x4 East-North-Up -> ECEF transform for the root tile."""
    lo, la = np.radians(lon_deg), np.radians(lat_deg)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    m = np.identity(4)
    m[:3, 0], m[:3, 1], m[:3, 2] = east, north, up
    m[:3, 3] = [x, y, z]
    return m.flatten(order="F").tolist()   # column-major for tileset.json

root_transform = ecef_enu_transform(lon, lat, cx, cy, cz)
assert len(root_transform) == 16
```

### 2. Load geometry and compute per-tile bounding volumes

Each `.glb` gets an axis-aligned `box` bounding volume expressed in the tile's local (East-North-Up) frame: a 12-element array `[cx, cy, cz, hx,0,0, 0,hy,0, 0,0,hz]` — centre plus three half-axis vectors. `trimesh` gives the bounds directly.

```python
from pathlib import Path
import trimesh

def box_volume(bounds):
    """3D Tiles 'box' = center xyz + three half-axis vectors."""
    (minx, miny, minz), (maxx, maxy, maxz) = bounds
    cx, cy, cz = (minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2
    hx, hy, hz = (maxx - minx) / 2, (maxy - miny) / 2, (maxz - minz) / 2
    return [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz]

leaves = []
for glb in sorted(Path("blocks_enu").glob("*.glb")):
    mesh = trimesh.load(glb, force="mesh")
    assert mesh.is_winding_consistent, f"{glb.name}: inconsistent winding"
    leaves.append({
        "content": glb.name,
        "box": box_volume(mesh.bounds),
        "centroid": mesh.bounds.mean(axis=0),
        "diagonal": float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0])),
    })
```

<figure class="diagram">
<svg viewBox="32 1 725 307" role="img" aria-labelledby="at-bv-t at-bv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="at-bv-t">Three bounding volumes over the same cluster of buildings</title>
  <desc id="at-bv-d">A geographic region is axis-aligned in longitude and latitude, so a diagonal block of buildings leaves a large amount of empty volume inside it. An oriented bounding box rotates to the cluster and encloses far less air. A sphere is the cheapest volume to test against but the loosest fit of the three.</desc>
  <rect class="svg-bg" x="32" y="1" width="725" height="307" fill="#ffffff"/>
  <path d="M46 70 h186 v126 h-186 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M280 130 L465 55 L498 136 L313 211 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <circle cx="639" cy="133" r="104" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.5">
    <rect x="60" y="148" width="22" height="16" rx="2"/>
    <rect x="94" y="132" width="22" height="16" rx="2"/>
    <rect x="128" y="116" width="22" height="16" rx="2"/>
    <rect x="162" y="100" width="22" height="16" rx="2"/>
    <rect x="196" y="84" width="22" height="16" rx="2"/>
    <rect x="76" y="166" width="22" height="16" rx="2"/>
    <rect x="110" y="150" width="22" height="16" rx="2"/>
    <rect x="144" y="134" width="22" height="16" rx="2"/>
    <rect x="178" y="118" width="22" height="16" rx="2"/>
    <rect x="310" y="148" width="22" height="16" rx="2"/>
    <rect x="344" y="132" width="22" height="16" rx="2"/>
    <rect x="378" y="116" width="22" height="16" rx="2"/>
    <rect x="412" y="100" width="22" height="16" rx="2"/>
    <rect x="446" y="84" width="22" height="16" rx="2"/>
    <rect x="326" y="166" width="22" height="16" rx="2"/>
    <rect x="360" y="150" width="22" height="16" rx="2"/>
    <rect x="394" y="134" width="22" height="16" rx="2"/>
    <rect x="428" y="118" width="22" height="16" rx="2"/>
    <rect x="560" y="148" width="22" height="16" rx="2"/>
    <rect x="594" y="132" width="22" height="16" rx="2"/>
    <rect x="628" y="116" width="22" height="16" rx="2"/>
    <rect x="662" y="100" width="22" height="16" rx="2"/>
    <rect x="696" y="84" width="22" height="16" rx="2"/>
    <rect x="576" y="166" width="22" height="16" rx="2"/>
    <rect x="610" y="150" width="22" height="16" rx="2"/>
    <rect x="644" y="134" width="22" height="16" rx="2"/>
    <rect x="678" y="118" width="22" height="16" rx="2"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="139" y="256"><tspan x="139" dy="0" font-weight="600">region</tspan><tspan x="139" dy="17">axis-aligned in lon/lat</tspan><tspan x="139" dy="16">loosest on a diagonal block</tspan></text>
    <text x="389" y="256"><tspan x="389" dy="0" font-weight="600">box</tspan><tspan x="389" dy="17">oriented to the cluster</tspan><tspan x="389" dy="16">tightest, 12 floats to store</tspan></text>
    <text x="639" y="256"><tspan x="639" dy="0" font-weight="600">sphere</tspan><tspan x="639" dy="17">cheapest frustum test</tspan><tspan x="639" dy="16">loosest fit of the three</tspan></text>
  </g>
  <text x="390" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">The volume you pick decides how much empty space a client loads before it can reject a tile</text>
</svg>
<figcaption>Fit and test cost pull in opposite directions. Regions are the default because they are trivial to compute, and they are also the reason a diagonal street grid over-fetches.</figcaption>
</figure>

### 3. Group leaves into a quadtree and assign depth

Partition the dataset extent recursively in the local East-North plane until each cell holds at most `max_per_tile` leaves. The depth of each cell drives its `geometricError`.

```python
def quadtree(items, x0, y0, x1, y1, depth=0, max_per_tile=8, max_depth=6):
    node = {"depth": depth, "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "items": items, "children": []}
    if len(items) <= max_per_tile or depth >= max_depth:
        return node
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    quads = [(x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)]
    node["items"] = []  # internal nodes hold no leaf content here
    for qx0, qy0, qx1, qy1 in quads:
        bucket = [it for it in items
                  if qx0 <= it["centroid"][0] < qx1 and qy0 <= it["centroid"][1] < qy1]
        if bucket:
            node["children"].append(
                quadtree(bucket, qx0, qy0, qx1, qy1, depth + 1, max_per_tile, max_depth))
    return node

ex = np.array([it["centroid"][:2] for it in leaves])
tree = quadtree(leaves, ex[:, 0].min(), ex[:, 1].min(),
                ex[:, 0].max(), ex[:, 1].max())
```

### 4. Compute geometricError per level

Anchor the error scale to the dataset's physical extent so it is meaningful in EPSG:4978 metres. The root error is the diagonal of the whole extent; each deeper level halves it; leaves are 0.

```python
extent_diag = float(np.linalg.norm(
    [ex[:, 0].max() - ex[:, 0].min(), ex[:, 1].max() - ex[:, 1].min()]))

def geometric_error(node):
    if not node["children"]:
        return 0.0                      # leaf: full resolution
    return extent_diag / (2 ** node["depth"])  # halves each level, metres
```

### 5. Encode each leaf to b3dm with Draco, then assemble tileset.json

Use the `3d-tiles-tools` CLI through `subprocess` to convert `.glb` → `.b3dm` and apply Draco mesh compression, then write the tree.

```python
import json
import subprocess

def glb_to_b3dm(glb_path: Path, out_path: Path):
    subprocess.run(["3d-tiles-tools", "glbToB3dm",
                    "-i", str(glb_path), "-o", str(out_path), "-f"], check=True)
    # Re-encode with Draco for ~5-10x smaller payloads.
    subprocess.run(["3d-tiles-tools", "optimizeB3dm", "-i", str(out_path),
                    "-o", str(out_path), "-f",
                    "--options", "--draco.compressMeshes"], check=True)

def union_box(boxes):
    """Axis-aligned union of child box volumes for an internal tile."""
    mins, maxs = [], []
    for b in boxes:
        c = np.array(b[:3]); hx, hy, hz = b[3], b[7], b[11]
        mins.append(c - [hx, hy, hz]); maxs.append(c + [hx, hy, hz])
    lo, hi = np.min(mins, axis=0), np.max(maxs, axis=0)
    ctr, half = (lo + hi) / 2, (hi - lo) / 2
    return [*ctr, half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]]

out_dir = Path("tileset"); out_dir.mkdir(exist_ok=True)

def build_tile(node):
    ge = geometric_error(node)
    if not node["children"]:                       # leaf with content
        boxes, children = [], []
        for it in node["items"]:
            b3dm = out_dir / (Path(it["content"]).stem + ".b3dm")
            glb_to_b3dm(Path("blocks_enu") / it["content"], b3dm)
            boxes.append(it["box"])
            children.append({"boundingVolume": {"box": it["box"]},
                             "geometricError": 0.0,
                             "content": {"uri": b3dm.name}})
        return {"boundingVolume": {"box": union_box(boxes)},
                "geometricError": ge, "refine": "REPLACE", "children": children}
    child_tiles = [build_tile(c) for c in node["children"]]
    boxes = [c["boundingVolume"]["box"] for c in child_tiles]
    return {"boundingVolume": {"box": union_box(boxes)},
            "geometricError": ge, "refine": "ADD", "children": child_tiles}

root = build_tile(tree)
root["transform"] = root_transform                 # ENU -> ECEF EPSG:4978

tileset = {"asset": {"version": "1.1"},
           "geometricError": extent_diag,
           "root": root}
(out_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))
```

<figure class="diagram">
<svg viewBox="26 -3 734 245" role="img" aria-labelledby="at-b3dm-t at-b3dm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="at-b3dm-t">The byte layout of a b3dm tile</title>
  <desc id="at-b3dm-d">A b3dm file is a twenty-eight byte header followed by the feature table JSON and binary, the batch table JSON and binary, and finally the embedded glTF payload. Every section length is declared in the header, and each section must start on an eight-byte boundary.</desc>
  <rect class="svg-bg" x="26" y="-3" width="734" height="245" fill="#ffffff"/>
  <text x="390" y="26" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">b3dm — five small sections and one large one, all located by lengths in the header</text>
  <rect x="40" y="80" width="60" height="52" rx="4" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="100" y="80" width="96" height="52" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="196" y="80" width="56" height="52" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="252" y="80" width="110" height="52" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="362" y="80" width="64" height="52" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="426" y="80" width="320" height="52" rx="4" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="70" y="60">header</text>
    <text x="148" y="44">feature table JSON</text>
    <text x="224" y="60">feature table binary</text>
    <text x="307" y="44">batch table JSON</text>
    <text x="394" y="60">batch table binary</text>
    <text x="586" y="44">glTF (GLB) payload</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="70" y="152">28 B</text>
    <text x="148" y="168">96 B</text>
    <text x="224" y="152">40 B</text>
    <text x="307" y="168">220 B</text>
    <text x="394" y="152">64 B</text>
    <text x="586" y="168">318,000 B</text>
  </g>
  <text x="390" y="200" fill="#b0413e" font-size="12.5" text-anchor="middle">Get one declared length wrong and the glTF starts one byte late — the tile fails to parse with no clue where</text>
  <text x="390" y="224" fill="#5b6471" font-size="12" text-anchor="middle">Pad each JSON section with spaces and each binary section with zeros to the next 8-byte boundary before writing the header</text>
</svg>
<figcaption>The payload is 99% of the bytes and none of the difficulty. Everything that breaks lives in the five short sections in front of it.</figcaption>
</figure>

### 6. (Optional) Automate the Cesium ion upload

For hosted delivery, push the validated tileset to Cesium ion with its REST API rather than the web UI, so the publish step is reproducible in CI.

```python
import os, requests

def upload_to_ion(tileset_dir: Path, name: str):
    token = os.environ["CESIUM_ION_TOKEN"]
    headers = {"Authorization": f"Bearer {token}"}
    asset = requests.post("https://api.cesium.com/v1/assets", headers=headers, json={
        "name": name, "type": "3DTILES",
        "options": {"sourceType": "3DTILES"},
    }).json()
    creds = asset["uploadLocation"]
    # creds carry temporary S3 credentials; upload the tileset directory, then:
    requests.post(asset["onComplete"]["url"], headers=headers,
                  json=asset["onComplete"].get("fields", {}))
    return asset["assetMetadata"]["id"]
```

## Validation & Verification

Never ship a tileset that has not passed the official validator. It checks the schema, that every `geometricError` is non-negative and decreases toward the leaves, and that each child's bounding volume is contained by its parent's.

```bash
npx 3d-tiles-validator --tilesetFile tileset/tileset.json
```

Then assert the two invariants that the validator is least strict about but that break rendering hardest — monotonic error and bounding-volume containment.

```python
def assert_monotonic(tile, parent_error=float("inf")):
    ge = tile["geometricError"]
    assert ge <= parent_error + 1e-6, f"geometricError increased: {ge} > {parent_error}"
    for child in tile.get("children", []):
        assert_monotonic(child, ge)

assert_monotonic(tileset["root"])

# A leaf box must sit inside the survey extent (sanity-check the ECEF placement).
root_c = np.array(tileset["root"]["boundingVolume"]["box"][:3])
root_half = np.array([tileset["root"]["boundingVolume"]["box"][3],
                      tileset["root"]["boundingVolume"]["box"][7],
                      tileset["root"]["boundingVolume"]["box"][11]])
print("root half-extents (m):", root_half)   # expect tens-to-hundreds of metres, not 1e6
assert (root_half < 5_000).all(), "box too large — likely a CRS/units error"
```

**Expected values.** For a 1 km² urban block survey, the root `geometricError` should land in the hundreds of metres, leaf `geometricError` is exactly 0, and root half-extents are on the order of 500 m. Half-extents in the millions of metres mean geometry was placed in ECEF without the local transform — the classic EPSG:4978 mistake. Load the result in CesiumJS with `Cesium.Cesium3DTileset.fromUrl` and confirm the tiles snap onto the globe at the survey location, not at the planet centre.

## Performance & Scale

For city- or national-scale twins, the bottleneck is the per-tile glTF→`b3dm`+Draco encode, not the tree assembly. Three levers move the needle.

**Batch the encode, not just the loop.** `glbToB3dm` spins up a Node process per call; for tens of thousands of leaves that process-startup cost dominates. Pre-merge co-located buildings into a single `.glb` per leaf tile (a `b3dm` is *batched* by design — one tile holds many features with a `_BATCHID` per vertex), so you encode hundreds of tiles instead of tens of thousands.

```python
import trimesh, numpy as np

def merge_batch(glb_paths):
    """Merge several building meshes into one batched glTF with per-feature batch IDs."""
    scene = trimesh.Scene()
    batch_ids = []
    for bid, p in enumerate(glb_paths):
        m = trimesh.load(p, force="mesh")
        scene.add_geometry(m, node_name=f"feature_{bid}")
        batch_ids.append(np.full(len(m.vertices), bid, dtype=np.uint16))
    return scene, np.concatenate(batch_ids)
```

**Parallelize the leaves.** Leaf encoding is embarrassingly parallel — each tile is independent. Use a process pool sized to physical cores; Draco is CPU-bound, so oversubscribing hurts.

```python
from concurrent.futures import ProcessPoolExecutor
import os

with ProcessPoolExecutor(max_workers=os.cpu_count()) as pool:
    list(pool.map(encode_leaf, leaf_jobs))   # encode_leaf wraps glb_to_b3dm
```

**Stream memory, don't hold the survey.** Never load all `.glb` files at once. The quadtree only needs each leaf's bounds and centroid (a few floats), so compute those in a first pass and load full geometry lazily during the encode pass. With Draco enabled, a 200-building block compresses from roughly 180 MB of raw glTF to 20–30 MB of `b3dm`, and gzipping the `tileset.json` (`3d-tiles-tools gzip`) shaves another order of magnitude off the index for the initial request. Cache the `.b3dm` outputs by source-mesh hash and re-encode only changed leaves — incremental rebuilds on a steady twin typically touch under 5% of tiles.

## Failure Modes & Gotchas

**Tileset renders at the centre of the Earth (or kilometres underground).** The root `transform` is missing, transposed, or row-major instead of column-major, or geometry was reprojected straight from a projected CRS to ECEF without the EPSG:4979 hop. Symptom: root half-extents in the millions. Fix: build the East-North-Up→ECEF matrix from the dataset anchor as in step 1, flatten it `order="F"`, and chain EPSG:32618+5703 → EPSG:4979 → EPSG:4978.

**geometricError increases with depth, or every tile loads at once.** If a child's error is larger than its parent's, the validator may pass but Cesium refines unpredictably. If the root error is set too small (e.g. left at a constant `2.0`), the client requests every leaf immediately and the streaming benefit evaporates. Anchor the error to the extent diagonal and halve per level; assert monotonicity in code.

**Vertical datum drift between adjacent tiles.** Mixing ellipsoidal heights with NAVD88 orthometric heights across the survey produces a step in Z at tile seams. Declare the compound CRS (EPSG:32618+5703) once and transform through EPSG:4979 so the geoid separation is applied consistently to every tile, not baked per-batch.

**Draco-compressed tiles render as garbage or fail to load.** The viewer lacks the Draco decoder, or `b3dm` was Draco-encoded with a glTF extension the client doesn't advertise. Confirm `KHR_draco_mesh_compression` is in the glTF `extensionsUsed`, and that the CesiumJS version predates none of the features used. When in doubt, validate the inner glTF separately before wrapping it as `b3dm`.

**Bounding volume not contained by its parent.** Computing an internal tile's `box` from tile centroids instead of the union of child boxes lets a child poke outside the parent volume, so Cesium culls geometry that should be visible. Always union the actual child bounding volumes (step 5's `union_box`), never approximate from points.

## Frequently Asked Questions

### Should I use py3dtiles or 3d-tiles-tools to build the tileset?
Use both — they cover different stages. `py3dtiles` is strongest for writing `pnts` point-cloud tiles and assembling a `tileset.json` natively in Python, while the Node-based `3d-tiles-tools` CLI is the reference implementation for glTF→`b3dm` conversion, Draco optimization, gzip, and upgrading a 1.0 tileset to 1.1. The workflow above drives `3d-tiles-tools` through `subprocess` for the encode steps and writes the tree in Python.

### What exactly is geometricError measured in?
It is a world-space distance in the tileset's CRS units — for a Cesium-bound tileset that is metres in EPSG:4978. It represents how far the tile's simplified geometry deviates from the ground truth. The renderer converts it to a screen-space pixel error using the camera distance and refines while that pixel error exceeds `maximumScreenSpaceError`. A leaf holding full-resolution geometry has `geometricError` 0.

### Why convert to ECEF EPSG:4978 instead of just leaving data in UTM?
CesiumJS positions everything on the WGS84 ellipsoid in a geocentric frame, so tile vertices and bounding volumes ultimately live in EPSG:4978. You author geometry in a convenient local East-North-Up frame and let the root tile's `transform` place that frame onto the globe. Leaving vertices in a projected CRS like EPSG:32618 would put the model on a flat plane tangent to nowhere on the round Earth.

### Can I mix b3dm meshes and pnts point clouds in one tileset?
Yes. A single `tileset.json` tree can reference `b3dm` content in some tiles and `pnts` in others, or wrap mixed content in a composite `cmpt` tile. A common pattern serves point-cloud `pnts` tiles at coarse levels for fast context and refines to meshed `b3dm` buildings at the leaves. Keep the `geometricError` progression consistent across both so refinement stays predictable.

### How big should max_per_tile and max_depth be?
Aim for a few hundred thousand triangles or points per leaf tile after Draco — small enough to decode in well under a frame, large enough that you are not paying HTTP overhead on tiny payloads. For dense urban data, 8–16 buildings per leaf and a `max_depth` of 5–7 over a 1 km² extent is a sound starting point; profile the initial load in Cesium and adjust the split threshold rather than the error scale.

## Related Guides

- [Hierarchical LOD Structuring for Digital Twins](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the parent-child refinement model the tileset tree implements
- [Implementing Quadtree LOD for Urban Models](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/) — the partitioning strategy behind step 3
- [Streaming Sync Patterns for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) — how clients request tiles by screen-space error
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — generating the simplified geometry each LOD level needs
- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — why glTF is the payload inside b3dm tiles

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
