# Diagnosing CRS Drift That Shows Up as Seams Between LOD Tiles

This guide finds and fixes the coordinate-system drift that appears as visible seams between adjacent LOD tiles, using `pyproj` and `numpy` to verify every tile transform resolves to one EPSG code (EPSG:4978 for a Cesium tileset), diff a control point round-tripped through the pipeline, detect a geographic-versus-projected mix, and assert that tile bounds nest monotonically. It belongs to the [cross-pillar failure modes](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/) area, because the cause lives in the [coordinate reference systems](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) stage while the symptom appears in the [LOD runtime](/lod-management-optimization-strategies/).

You hit this the moment two surveys, two tiling runs, or two teams contribute tiles that should abut but do not: a hairline crack of background shows between neighbouring tiles, or one tile sits a few centimetres proud of the next. The geometry looks correct in isolation, every tile validates, and yet the join is wrong — the signature of a transform chain that drifted somewhere between source and tileset root.

<figure class="diagram">
<svg viewBox="0 0 780 320" role="img" aria-labelledby="cds-t cds-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cds-t">How transform-chain drift becomes a seam between adjacent tiles</title>
  <desc id="cds-d">A transform chain runs from the source frame EPSG:32618 plus 5703, through geographic-3D EPSG:4979, to the ECEF render frame EPSG:4978. If the chain is not self-consistent, adjacent tiles A and B placed by it fail to abut, and the residual drift opens as a seam gap between them.</desc>
  <defs>
    <marker id="cds-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="25" y="45" width="215" height="46" rx="8"/>
    <rect x="25" y="125" width="215" height="46" rx="8"/>
    <rect x="25" y="205" width="215" height="46" rx="8"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#cds-arrow)">
    <line x1="132" y1="91" x2="132" y2="124"/>
    <line x1="132" y1="171" x2="132" y2="204"/>
    <line x1="242" y1="228" x2="466" y2="228"/>
  </g>
  <g fill="#15384a" font-size="12.5" text-anchor="middle">
    <text x="132" y="73">Source · EPSG:32618+5703</text>
    <text x="132" y="153">Geographic-3D · EPSG:4979</text>
    <text x="132" y="233">ECEF · EPSG:4978 (render)</text>
  </g>
  <rect x="470" y="173" width="120" height="110" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="618" y="173" width="120" height="110" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="596" y="173" width="16" height="110" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="530" y="233">Tile A</text>
    <text x="678" y="233">Tile B</text>
  </g>
  <text x="604" y="308" fill="#5b6471" font-size="12" text-anchor="middle">seam = residual drift</text>
  <text x="354" y="218" fill="#5b6471" font-size="11.5" text-anchor="middle">one frame</text>
</svg>
<figcaption>The seam is the transform chain's residual made visible: if EPSG:32618+5703 to EPSG:4978 is not self-consistent, adjacent tiles placed by it drift apart by exactly that residual.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `pyproj` 3.6+ and `numpy` 1.26+: `pip install "pyproj>=3.6" "numpy>=1.26"`. pyproj bundles PROJ 9+, which carries the datum grids these checks rely on.
- A `tileset.json` whose tiles carry `transform` matrices and `boundingVolume` boxes, plus knowledge of the source CRS. Examples assume source data in UTM 18N with NAVD88 heights (compound EPSG:32618+5703), reprojected via geographic-3D EPSG:4979 to the Cesium render frame EPSG:4978 (geocentric WGS84, metres).
- At least one surveyed control point with a known ground-truth coordinate in the source CRS, used as the probe that reveals drift.

## Step-by-Step

### 1. Confirm every tile transform resolves to one EPSG code

Drift begins when tiles are authored against different frames. A Cesium tileset must place all geometry in EPSG:4978, so assert that the declared CRS of every content chunk resolves to that single code before looking at any geometry.

```python
from pyproj import CRS

RENDER_EPSG = 4978   # geocentric WGS84 (ECEF), the only frame Cesium renders in

def assert_single_frame(tile_crs_codes):
    resolved = {CRS.from_user_input(c).to_epsg() for c in tile_crs_codes}
    assert resolved == {RENDER_EPSG}, (
        f"tiles span multiple frames {resolved}; expected only EPSG:{RENDER_EPSG}")
    return resolved

# CRS each tile's geometry was reprojected into, collected during tiling.
tile_crs_codes = ["EPSG:4978", "EPSG:4978", "EPSG:4978"]
assert_single_frame(tile_crs_codes)
print("all tiles resolve to one frame")
```

If even one tile resolves to EPSG:4979 or a projected UTM code, that tile is the seam — it was never reprojected into the render frame.

### 2. Diff a control point round-tripped through the pipeline

The definitive drift probe: push a known control point through the exact transform chain the pipeline uses, then invert it, and measure how far it lands from where it started. A sound chain returns sub-millimetre.

```python
import numpy as np
from pyproj import Transformer

# Known control point in the source frame (EPSG:32618+5703): easting, northing, height.
control = (583_142.55, 4_507_311.20, 11.84)

# The pipeline's real chain: source -> geographic-3D -> ECEF, and back.
fwd = Transformer.from_pipeline(
    "+proj=pipeline "
    "+step +proj=utm +zone=18 +ellps=GRS80 +inv "     # UTM 18N -> geographic
    "+step +proj=cart +ellps=WGS84")                   # geographic -> ECEF
inv = Transformer.from_crs("EPSG:4978", "EPSG:32618+5703", always_xy=True)

ecef = fwd.transform(*control)
back = inv.transform(*ecef)
residual = np.linalg.norm(np.subtract(back, control))
assert residual < 1e-3, f"transform chain drifts {residual*1000:.3f} mm — seam source"
print(f"control point round-trip residual {residual*1000:.4f} mm")
```

A residual of centimetres or metres localises the drift to this chain; a clean residual clears the coordinate math and points you at the geometric bounds check in step 4.

### 3. Detect a geographic-versus-projected mix

A frequent, subtle cause is one stage treating degrees as metres — mixing a geographic frame (EPSG:4326 / EPSG:4979) with a projected one (EPSG:32618). The numeric ranges are wildly different, so a units check on the axis metadata catches it deterministically.

```python
from pyproj import CRS

def classify_frame(epsg):
    crs = CRS.from_epsg(epsg)
    unit = {ax.unit_name for ax in crs.axis_info}
    kind = "geographic" if crs.is_geographic else (
           "geocentric" if crs.is_geocentric else "projected")
    return kind, unit

for epsg in (32618, 4979, 4978):
    kind, unit = classify_frame(epsg)
    print(f"EPSG:{epsg}: {kind}, units {unit}")

# The tiler must consume metres, never degrees.
src_kind, src_unit = classify_frame(32618)
assert src_unit <= {"metre", "meter"}, f"source frame is not metric: {src_unit}"
```

Expect `EPSG:32618` projected in metres, `EPSG:4979` geographic in degrees, `EPSG:4978` geocentric in metres. A degree-based frame reaching the tiler is the mix that produces seams scaled by latitude.

### 4. Assert tile bounds are monotonic and nested

Even with a clean CRS, drift in per-tile transforms shows up as bounding volumes that no longer nest — a child pokes outside its parent, and the gap between them renders as a seam. Walk the tree and assert containment in the render frame.

```python
import numpy as np

def box_min_max(box):
    """3D Tiles 'box' [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz] -> (min, max) corners."""
    c = np.array(box[:3])
    half = np.array([box[3], box[7], box[11]])
    return c - half, c + half

def assert_nested(tile, parent_box=None, path="root"):
    lo, hi = box_min_max(tile["boundingVolume"]["box"])
    if parent_box is not None:
        plo, phi = box_min_max(parent_box)
        assert (lo >= plo - 1e-3).all() and (hi <= phi + 1e-3).all(), (
            f"{path}: child bounds escape parent — seam-prone drift")
    for i, child in enumerate(tile.get("children", [])):
        assert_nested(child, tile["boundingVolume"]["box"], f"{path}.children[{i}]")

import json
tileset = json.loads(open("tileset/tileset.json").read())
assert_nested(tileset["root"])
print("bounding volumes nest cleanly")
```

### 5. Localise the seam to a specific tile pair

With the invariants in place, pinpoint which neighbours drift apart by comparing the shared edge of adjacent tiles in the render frame. A gap above the data's positional tolerance names the pair to re-tile.

```python
import numpy as np

def shared_edge_gap(box_a, box_b):
    """Signed gap between two axis-aligned tile boxes along their nearest faces."""
    (alo, ahi), (blo, bhi) = box_min_max(box_a), box_min_max(box_b)
    # Positive component = a gap on that axis; negative = overlap.
    return np.maximum(blo - ahi, alo - bhi).max()

TOLERANCE_M = 0.01   # 1 cm positional tolerance for abutting tiles
gap = shared_edge_gap(tileset["root"]["children"][0]["boundingVolume"]["box"],
                      tileset["root"]["children"][1]["boundingVolume"]["box"])
assert gap <= TOLERANCE_M, f"adjacent tiles gap by {gap*100:.2f} cm — re-tile this pair"
print(f"neighbour gap {gap*1000:.2f} mm")
```

## Expected Output & Verification

A drift-free tileset produces clean output at every step: one resolved frame, a sub-millimetre round-trip, a metric source frame, nested bounds, and neighbour gaps within tolerance.

```text
all tiles resolve to one frame
control point round-trip residual 0.0003 mm
EPSG:32618: projected, units {'metre'}
EPSG:4979: geographic, units {'degree'}
EPSG:4978: geocentric, units {'metre'}
bounding volumes nest cleanly
neighbour gap 0.31 mm
```

A drifting tileset breaks exactly one of these first: multiple frames in step 1, a residual in millimetres-to-metres in step 2, a degree-based source in step 3, escaping bounds in step 4, or a centimetre gap in step 5. The step that trips names the layer that drifted — coordinate chain, units, or per-tile transform — so the fix is targeted rather than a full re-tile of the survey.

## Common Errors

**`CRSError: Invalid projection: EPSG:32618+5703` or a silently wrong height.** The compound code fails to resolve when the installed PROJ build lacks the vertical datum grid, so pyproj falls back and the height component is dropped, tilting the whole survey. Confirm PROJ has the grids with `pyproj.datadir.get_data_dir()` and install the datum grids (`projsync --all` or the `proj-data` package), then re-run the step 2 round-trip and confirm the height component survives.

**Round-trip residual is zero but the seam persists.** A perfect round-trip only proves the chain is self-consistent, not correct — it can round-trip cleanly through the wrong datum. Add an absolute check: transform your surveyed control point forward and assert the ECEF result lands within tolerance of its independently known EPSG:4978 coordinate, not merely back onto the input. Self-consistency plus absolute agreement together rule out drift.

**Axis order swaps latitude and longitude, moving tiles by hundreds of kilometres.** Omitting `always_xy=True` lets pyproj honour a geographic CRS's native latitude-first axis order, so a lon/lat pair is read as lat/lon and the tile lands in the wrong hemisphere while every self-consistency check still passes. Pass `always_xy=True` on every `Transformer.from_crs`, and assert a known control point lands where expected after the forward transform.

## Related Guides

- [Cross-Pillar Failure Modes in Digital Twins](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/) — the full catalogue of boundary defects this seam belongs to
- [Fixing Memory OOM in City-Scale Decimation](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/fixing-memory-oom-in-city-scale-decimation/) — the other common city-scale reliability failure
- [Converting WGS84 to Local Projected Coordinates](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the transform chain that drifts when misbuilt
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — where the per-tile transforms and bounds are written

Back to [Cross-Pillar Failure Modes in Digital Twins](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/).
