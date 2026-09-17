# Converting GLB to 3D Tiles with 3d-tiles-tools

This page converts a directory of GLB meshes — one per city block, produced upstream — into a valid 3D Tiles 1.1 tileset using the official `3d-tiles-tools` CLI, then validates it, inspects what it produced, and wraps the whole thing in a script that runs the same way on a laptop and in CI.

## Why you hit this

Plenty of pipelines already produce good glTF: a mesh exporter, a photogrammetry run, a BIM conversion. What they do not produce is the tileset structure a streaming client needs — bounding volumes in ECEF, geometric errors per level, and a `tileset.json` that references the content. Writing that by hand is possible and is covered in [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/); reaching for the reference tooling first is usually the better trade, because it computes the bounding volumes from the actual geometry and emits the current spec version.

`3d-tiles-tools` is the Cesium-maintained CLI for exactly this kind of plumbing: creating a tileset from content files, upgrading a 1.0 tileset to 1.1, combining nested tilesets, converting legacy `b3dm`/`i3dm` to glTF content, and reporting what a tileset contains.

## Prerequisites

- Node.js 18+ and the CLI: `npm install -g 3d-tiles-tools` (or `npx 3d-tiles-tools`).
- The validator: `npm install -g 3d-tiles-validator`.
- A directory of GLB files whose vertices are already in the right frame — see [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/).
- Python 3.10+ for the wrapper script and the checks.

## Step-by-Step

### 1. Know what the input has to look like

```bash
npx 3d-tiles-tools --version
ls -1 input/blocks | head -4
# block_0412.glb
# block_0413.glb
# block_0414.glb
# block_0415.glb

npx gltf-transform inspect input/blocks/block_0412.glb | head -24
```

`createTilesetJson` derives each tile's bounding volume from the content's geometry, so the coordinates inside the GLB determine where the tile lands. Two arrangements work and mixing them is the main source of misplacement:

Either every GLB holds vertices in **ECEF metres** and the tileset has no transform, or every GLB holds vertices in a **local ENU frame** near the origin and the tile carries a 4×4 `transform` placing that frame on the ellipsoid. The second is what you want for numerical precision — float32 vertex positions at ECEF magnitudes lose centimetres — and it means the per-tile transform has to come from somewhere, which step 4 handles.

<figure class="diagram">
<svg viewBox="10 10 740 224" role="img" aria-labelledby="g3t-input-t g3t-input-d" xmlns="http://www.w3.org/2000/svg">
  <title id="g3t-input-t">Two valid arrangements for GLB content</title>
  <desc id="g3t-input-d">Left: vertices stored in Earth-centred coordinates with no tile transform, which is simple but loses precision because float32 cannot represent millions of metres finely. Right: vertices stored in a local east-north-up frame near zero with a per-tile four-by-four transform placing the frame on the ellipsoid, which keeps full precision. Mixing the two misplaces tiles by thousands of kilometres.</desc>
  <rect class="svg-bg" x="10" y="10" width="740" height="224" fill="#ffffff"/>
  <rect x="24" y="24" width="330" height="196" rx="10" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="406" y="24" width="330" height="196" rx="10" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g font-size="13" text-anchor="middle">
    <text x="189" y="50" fill="#9a4f26">A — ECEF vertices, no transform</text>
    <text x="571" y="50" fill="#1f2937">B — local vertices + transform</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="189" y="82">vertex: (4045678.2, 618234.9, 4900123.4)</text>
    <text x="189" y="106">float32 step at that magnitude: ≈ 0.25 m</text>
    <text x="189" y="130">transform: absent</text>
    <text x="189" y="160">works; z-fighting and</text>
    <text x="189" y="178">jitter on close zoom</text>
    <text x="571" y="82">vertex: (-118.4, 62.7, 9.3)</text>
    <text x="571" y="106">float32 step at that magnitude: ≈ 1e-5 m</text>
    <text x="571" y="130">transform: ENU → ECEF at tile origin</text>
    <text x="571" y="160">preferred: millimetre</text>
    <text x="571" y="178">precision at any zoom</text>
  </g>
  <g stroke-width="1.5">
    <rect x="52" y="192" width="274" height="18" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="434" y="192" width="274" height="18" fill="#ffffff" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="189" y="206">mixing A and B: tile lands near Earth's centre</text>
    <text x="571" y="206">one arrangement, applied to every block</text>
  </g>
</svg>
<figcaption>Pick one arrangement for the whole dataset; the failure mode of mixing them is a tile 6,000 km from where it belongs.</figcaption>
</figure>

### 2. Create a tileset from the content

```bash
npx 3d-tiles-tools createTilesetJson \
  -i input/blocks \
  -o output/city/tileset.json \
  --cartographicPositionDegrees 10.7522 59.9139 24.0 \
  --geometricError 2048

npx 3d-tiles-tools analyze -i output/city/tileset.json -o output/analysis
```

`createTilesetJson` walks the input directory, makes one leaf tile per content file, computes each bounding volume from the geometry and writes a root tile that contains them all. The `--cartographicPositionDegrees` option gives the root an ENU-to-ECEF transform at that longitude, latitude and height, which is arrangement B above: the GLBs stay local, the root places them.

The `--geometricError` is the root's value — the screen-space error at which the client decides the root is no longer good enough. A common starting point is the diagonal extent of the dataset in metres, halved per level; the tool assigns children by halving down to zero at the leaves.

`analyze` writes a JSON report of what the tileset contains, and reading it is faster than reading the tileset by eye.

### 3. Validate before anything else consumes it

```bash
npx 3d-tiles-validator --tilesetFile output/city/tileset.json \
  --reportFile output/city/validation.json

python3 - <<'PY'
import json, pathlib
report = json.loads(pathlib.Path("output/city/validation.json").read_text())
issues = report.get("issues") or []
by_sev = {}
for i in issues:
    by_sev.setdefault(i.get("severity", "UNKNOWN"), []).append(i)
print({k: len(v) for k, v in sorted(by_sev.items())})
for i in by_sev.get("ERROR", [])[:5]:
    print(" ", i.get("type"), "-", i.get("message", "")[:120])
PY
```

Running the validator as a gate rather than a diagnostic is the single highest-value habit here. It catches bounding volumes that do not contain their content, geometric errors that increase with depth, missing content URIs, and glTF that is itself invalid — all of which a viewer will render partially and without complaint, so they reach production easily.

Treat `ERROR` as failing and `WARNING` as a review item; the common warnings are about unused glTF accessors and non-power-of-two textures, neither of which breaks streaming.

### 4. Place each block at its own origin

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from pyproj import CRS, Transformer

WGS84 = CRS.from_epsg(4979)
ECEF = CRS.from_epsg(4978)
TO_ECEF = Transformer.from_crs(WGS84, ECEF, always_xy=True)

def enu_to_ecef_matrix(lon_deg, lat_deg, height_m):
    """Column-major 4x4 for the 3D Tiles `transform` property."""
    x, y, z = TO_ECEF.transform(lon_deg, lat_deg, height_m)
    lon, lat = math.radians(lon_deg), math.radians(lat_deg)
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.array([-math.sin(lat) * math.cos(lon),
                      -math.sin(lat) * math.sin(lon),
                      math.cos(lat)])
    up = np.array([math.cos(lat) * math.cos(lon),
                   math.cos(lat) * math.sin(lon),
                   math.sin(lat)])
    m = np.identity(4)
    m[:3, 0], m[:3, 1], m[:3, 2] = east, north, up
    m[:3, 3] = (x, y, z)
    return [float(v) for v in m.T.flatten()]        # column-major, as the spec requires

def place_leaves(tileset_path, origins_path):
    """Give every leaf its own ENU transform, taken from the block's own origin."""
    ts = json.loads(Path(tileset_path).read_text())
    origins = json.loads(Path(origins_path).read_text())    # {"block_0412.glb": [lon, lat, h], ...}
    placed, unmatched = 0, []
    for tile in ts["root"].get("children", []):
        uri = tile.get("content", {}).get("uri", "")
        key = Path(uri).name
        if key in origins:
            lon, lat, h = origins[key]
            tile["transform"] = enu_to_ecef_matrix(lon, lat, h)
            placed += 1
        else:
            unmatched.append(key)
    ts["root"].pop("transform", None)               # the leaves carry it now
    Path(tileset_path).write_text(json.dumps(ts, indent=2, sort_keys=True))
    return {"placed": placed, "unmatched": unmatched[:5], "leaves": len(ts["root"].get("children", []))}

print(place_leaves("output/city/tileset.json", "input/blocks/origins.json"))
```

A single root transform is fine for a neighbourhood and wrong for a city: a local ENU frame is tangent to the ellipsoid at one point, and 15 km away the surface has dropped about 18 metres below that tangent plane, so distant blocks float or sink. Giving each block its own transform, taken from its own centroid, removes the error entirely at the cost of one matrix per tile.

The transform must be **column-major**, which is why the code transposes before flattening. A row-major matrix produces a tile rotated into nonsense, and it is the most common mistake in hand-built tilesets.

### 5. Recompute the bounding volumes after moving anything

```python
def bounding_sphere_from_region(lon_deg, lat_deg, height_m, radius_m):
    x, y, z = TO_ECEF.transform(lon_deg, lat_deg, height_m)
    return [float(x), float(y), float(z), float(radius_m)]

def refresh_bounds(tileset_path, origins_path, block_radius_m=140.0):
    ts = json.loads(Path(tileset_path).read_text())
    origins = json.loads(Path(origins_path).read_text())
    pts, radii = [], []
    for tile in ts["root"].get("children", []):
        key = Path(tile.get("content", {}).get("uri", "")).name
        if key not in origins:
            continue
        lon, lat, h = origins[key]
        tile["boundingVolume"] = {"sphere": bounding_sphere_from_region(lon, lat, h, block_radius_m)}
        tile.pop("box", None)
        pts.append(TO_ECEF.transform(lon, lat, h))
        radii.append(block_radius_m)
    if pts:
        arr = np.asarray(pts)
        centre = arr.mean(axis=0)
        span = float(np.linalg.norm(arr - centre, axis=1).max() + max(radii))
        ts["root"]["boundingVolume"] = {"sphere": [*map(float, centre), span]}
    Path(tileset_path).write_text(json.dumps(ts, indent=2, sort_keys=True))
    return {"leaves": len(pts), "root_radius_m": round(span, 1) if pts else 0.0}

print(refresh_bounds("output/city/tileset.json", "input/blocks/origins.json"))
```

Once a transform is edited, the bounding volume computed by `createTilesetJson` no longer describes where the content actually is, and the client culls tiles that are on screen or loads tiles that are not. A bounding volume in 3D Tiles is expressed in the tile's *own* coordinate system after its transform is applied, so the safest approach after any manual placement is to recompute spheres in ECEF, where no transform ambiguity exists, and re-run the validator — it explicitly checks containment.

A sphere is conservative and simple; an oriented box is tighter and culls better, and is worth the extra code once the tileset is otherwise correct.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="g3t-ops-t g3t-ops-d" xmlns="http://www.w3.org/2000/svg">
  <title id="g3t-ops-t">Which 3d-tiles-tools operation to reach for</title>
  <desc id="g3t-ops-d">A table of five operations. createTilesetJson builds a tileset from a folder of content. upgrade converts a 1.0 tileset to 1.1 with glTF content. merge keeps several tilesets as external references under one root. combine inlines external tilesets into a single document. analyze reports what a tileset contains without opening a viewer.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="250" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="444" y="20" width="278" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="54" width="250" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="444" y="54" width="278" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="88" width="250" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="444" y="88" width="278" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="122" width="250" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="444" y="122" width="278" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="156" width="250" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="444" y="156" width="278" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="190" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="190" width="250" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="444" y="190" width="278" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="42">operation</text><text x="319" y="42">what it does</text><text x="583" y="42">reach for it when</text>
    <text x="106" y="76">createTilesetJson</text><text x="319" y="76">one leaf per content file</text><text x="583" y="76">the tree is flat and small</text>
    <text x="106" y="110">upgrade</text><text x="319" y="110">1.0 b3dm to 1.1 glTF</text><text x="583" y="110">the tileset predates 1.1</text>
    <text x="106" y="144">merge</text><text x="319" y="144">districts as external refs</text><text x="583" y="144">districts rebuild separately</text>
    <text x="106" y="178">combine</text><text x="319" y="178">inlines externals into one</text><text x="583" y="178">the city ships as one unit</text>
    <text x="106" y="212">analyze</text><text x="319" y="212">reports tile and content stats</text><text x="583" y="212">before reading any JSON</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Prefer merge while districts are independent; combine once the whole city ships together.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">analyze is the fastest way to answer what is actually in a delivered tileset.</text>
</svg>
<figcaption>Five operations cover almost every tileset plumbing task; analyze is the one to run first.</figcaption>
</figure>

### 6. Upgrade, combine, and script the whole thing

```bash
# A 1.0 tileset with b3dm content becomes 1.1 with glTF content
npx 3d-tiles-tools upgrade -i legacy/tileset.json -o output/upgraded/tileset.json --targetVersion 1.1

# Several district tilesets become one tree
npx 3d-tiles-tools merge -i output/district_a/tileset.json -i output/district_b/tileset.json \
  -o output/city_merged/tileset.json

# Flatten external tilesets referenced by the root into a single file
npx 3d-tiles-tools combine -i output/city_merged/tileset.json -o output/city_flat/tileset.json
```

```python
def build(input_dir="input/blocks", out_dir="output/city", root_ge=2048.0):
    steps = []
    def run(name, args):
        proc = subprocess.run(args, capture_output=True, text=True)
        steps.append({"step": name, "code": proc.returncode,
                      "tail": (proc.stderr or proc.stdout).strip().splitlines()[-1:] })
        if proc.returncode != 0:
            raise RuntimeError(f"{name} failed: {proc.stderr[-400:]}")
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    run("createTilesetJson", ["npx", "3d-tiles-tools", "createTilesetJson",
                              "-i", input_dir, "-o", f"{out_dir}/tileset.json",
                              "--geometricError", str(root_ge)])
    place_leaves(f"{out_dir}/tileset.json", f"{input_dir}/origins.json")
    refresh_bounds(f"{out_dir}/tileset.json", f"{input_dir}/origins.json")
    run("validate", ["npx", "3d-tiles-validator", "--tilesetFile", f"{out_dir}/tileset.json",
                     "--reportFile", f"{out_dir}/validation.json"])
    return steps

for s in build():
    print(s["step"], "->", s["code"], *(s["tail"] or []))
```

`upgrade` is worth running on any tileset older than a year: 1.1 replaces `b3dm` with plain glTF content, which removes a wrapper format from the pipeline and lets standard glTF tools inspect and optimise tile content directly. `merge` keeps district tilesets as external references, `combine` inlines them — prefer `merge` while districts are rebuilt independently, `combine` once the whole city ships as one unit.

<figure class="diagram">
<svg viewBox="2 46 756 150" role="img" aria-labelledby="g3t-flow-t g3t-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="g3t-flow-t">The conversion pipeline and its gate</title>
  <desc id="g3t-flow-d">A folder of GLB files goes through createTilesetJson to produce a draft tileset. Per-leaf transforms are then applied from a block origins file, bounding volumes are recomputed in Earth-centred coordinates, and the validator runs as a gate. Errors send the run back to the transform and bounds step; a clean report publishes the tileset.</desc>
  <rect class="svg-bg" x="2" y="46" width="756" height="150" fill="#ffffff"/>
  <defs>
    <marker id="g3t-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="18" y="62" width="118" height="58" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="172" y="62" width="130" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="338" y="62" width="130" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="504" y="62" width="112" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="652" y="62" width="94" height="58" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#g3t-flow-arrow)">
    <path d="M136 91 H170"/><path d="M302 91 H336"/><path d="M468 91 H502"/><path d="M616 91 H650"/>
    <path d="M560 120 V162 H403 V122"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="77" y="86">GLB per</text><text x="77" y="104">block</text>
    <text x="237" y="86">createTileset-</text><text x="237" y="104">Json</text>
    <text x="403" y="86">place leaves,</text><text x="403" y="104">refresh bounds</text>
    <text x="560" y="86">validator</text><text x="560" y="104">as a gate</text>
    <text x="699" y="86">publish</text><text x="699" y="104">tileset</text>
  </g>
  <text x="482" y="180" fill="#b0413e" font-size="12.5" text-anchor="middle">ERROR: containment or transform — fix and re-run</text>
</svg>
<figcaption>Four commands and one gate; the loop back from the validator is where the transform and bounding-volume mistakes get caught.</figcaption>
</figure>

## Expected Output & Verification

```text
3d-tiles-tools 0.5.x
{'INFO': 4, 'WARNING': 2, 'ERROR': 0}
{'placed': 412, 'unmatched': [], 'leaves': 412}
{'leaves': 412, 'root_radius_m': 8240.6}
createTilesetJson -> 0
validate -> 0
```

Zero errors and two warnings — both about unused glTF texture coordinates in blocks exported with an unused UV set — is the expected shape of a healthy run. All 412 blocks matched an origin, which is the check that catches a renamed or missing GLB before the viewer does.

Verify placement independently of the validator, by comparing each tile's transform translation against the origin it was supposed to get:

```python
def placement_check(tileset_path, origins_path, tol_m=0.05):
    ts = json.loads(Path(tileset_path).read_text())
    origins = json.loads(Path(origins_path).read_text())
    rows = []
    for tile in ts["root"].get("children", []):
        key = Path(tile["content"]["uri"]).name
        if key not in origins or "transform" not in tile:
            rows.append({"block": key, "status": "no transform"})
            continue
        m = np.asarray(tile["transform"], dtype=float).reshape(4, 4).T
        expect = np.asarray(TO_ECEF.transform(*origins[key]), dtype=float)
        err = float(np.linalg.norm(m[:3, 3] - expect))
        rows.append({"block": key, "offset_m": round(err, 4),
                     "status": "ok" if err <= tol_m else "MISPLACED"})
    bad = [r for r in rows if r["status"] != "ok"]
    return {"tiles": len(rows), "bad": len(bad), "worst": sorted(
        (r for r in rows if "offset_m" in r), key=lambda r: -r["offset_m"])[:3]}

print(placement_check("output/city/tileset.json", "input/blocks/origins.json"))
```

A row-major/column-major mix-up shows up here as offsets in the millions of metres, which is unmistakable, and a wrong ellipsoid height shows up as a consistent offset of exactly the geoid separation — both far easier to read from this table than from a viewer.

Then check that the geometric errors decrease monotonically with depth, which the client relies on:

```python
def geometric_error_check(tileset_path):
    ts = json.loads(Path(tileset_path).read_text())
    problems = []
    def walk(tile, parent_ge, depth=0):
        ge = tile.get("geometricError")
        if ge is None:
            problems.append({"depth": depth, "issue": "missing geometricError"})
        elif parent_ge is not None and ge >= parent_ge:
            problems.append({"depth": depth, "issue": f"ge {ge} >= parent {parent_ge}"})
        for child in tile.get("children", []):
            walk(child, ge, depth + 1)
    walk(ts["root"], ts.get("geometricError"))
    return {"problems": problems[:5], "count": len(problems)}

print(geometric_error_check("output/city/tileset.json"))
```

## Performance Notes

- **`createTilesetJson` is I/O-bound**: it opens every GLB to compute bounds. 412 blocks at 4 MB each take about 30 seconds on SSD, minutes over a network mount.
- **Validation is the slow step** at roughly 50–150 ms per tile including its glTF, so a 6,000-tile city takes several minutes. Run it fully in CI and on a sample locally.
- **`combine` loads every external tileset into memory.** For thousands of districts, keep `merge` and external references.
- **Optimise the GLBs before tiling**, not after — `gltfpack` or Draco on the content files is where the bandwidth win is, and the tileset structure is unaffected.
- **Avoid one tile per building.** A few hundred triangles per request makes the request count the bottleneck; aim for tens of thousands of triangles per tile.

## Common Errors

**`Error: Could not read input`.** `createTilesetJson` wants a directory of content files; pointing it at a single GLB or at a directory of directories produces this.

**Validator: "bounding volume does not contain content".** Either the transform was edited without recomputing bounds, or the GLB's vertices are in ECEF while the tile also has a transform, so the content is transformed twice.

**Tiles appear near Earth's centre.** Content in a local frame with no transform. The magnitude — about 6,378 km off — is the giveaway.

**The tileset renders rotated by 90°.** A row-major transform, or Y-up/Z-up confusion. glTF is Y-up, 3D Tiles content is Z-up, and the tools handle it; a hand-written transform usually does not.

**`upgrade` leaves b3dm files in place.** `--targetVersion 1.1` converts the tileset JSON; content conversion needs `convert` or the `b3dmToGlb` operation on the files.

**Everything validates and nothing is visible.** The geometric errors are too small, so the client considers the root adequate at any distance and never refines. Check the monotonicity report and the root value.

## Frequently Asked Questions

### When should I write the tileset myself instead?

When the tree structure matters — a hierarchy driven by your own spatial index, implicit tiling, or metadata groups. `3d-tiles-tools` produces a flat root-plus-leaves tree, which is fine up to a few hundred tiles and needs restructuring beyond that.

### Is 1.1 glTF content ready to use?

Yes, and it is the better target: viewers released in the last few years read it, and it removes the `b3dm` wrapper so `gltf-transform` and `gltfpack` can operate on tile content directly.

### Can this run without Node in the pipeline?

The CLI needs Node. If that is unacceptable, generate the tileset JSON in Python and keep only the validator as a containerised check — it is the part worth keeping either way.

## Related Guides

- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — when the tree structure is yours to choose
- [Inspecting glTF with gltf-transform](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/inspecting-gltf-with-gltf-transform/) — checking the content before it becomes a tile
- [Validating Tileset Bounding Volumes Against Content](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-tileset-bounding-volumes-against-content/) — the containment check as a standing gate

Back to [Automated Tile Generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
