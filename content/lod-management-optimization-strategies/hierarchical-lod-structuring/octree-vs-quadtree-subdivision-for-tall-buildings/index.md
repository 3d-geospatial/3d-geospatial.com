# Octree vs Quadtree Subdivision for Tall Buildings

This page compares quadtree and octree subdivision on a city whose skyline ranges from 4 m sheds to 220 m towers — measuring how balanced the resulting tiles are, how much geometry each scheme forces the client to load for a street-level view, and where the hybrid scheme that subdivides vertically only when it helps lands.

## Why you hit this

A quadtree divides the ground plane into four and keeps the full vertical extent in every tile. That is the right structure for terrain, for footprints and for most European cities, where a 200 m tile holds buildings of 10–30 m and the vertical extent is a small fraction of the horizontal.

It stops being right when the vertical extent rivals the horizontal. A 150 m tile containing a 220 m tower has a bounding volume taller than it is wide, so a camera at street level sees the tile — and loads the whole tower, including the 180 m of it that is out of frame. Multiply that by the towers in a business district and the first street-level view pulls tens of megabytes of geometry above the field of view.

The question is whether to subdivide vertically, and the honest answer is "sometimes", which is why this page measures rather than recommends.

## Prerequisites

- A feature inventory with per-feature bounding boxes, including height — the output of a CityGML or footprint-plus-height pipeline.
- Python 3.10+ with `numpy`; `shapely` and `geopandas` for the footprint handling.
- The tileset writer from [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/).

## Step-by-Step

### 1. Measure the vertical extent before choosing

```python
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

@dataclass(frozen=True)
class Feature:
    fid: int
    x: float
    y: float
    z_min: float
    z_max: float
    footprint_m2: float
    triangles: int

def aspect_profile(features, tile_m=150.0, origin=(0.0, 0.0)):
    """The ratio that decides the question: vertical extent over horizontal tile size."""
    cells = {}
    for f in features:
        i = int((f.x - origin[0]) // tile_m)
        j = int((f.y - origin[1]) // tile_m)
        cell = cells.setdefault((i, j), {"z_lo": math.inf, "z_hi": -math.inf,
                                         "features": 0, "triangles": 0})
        cell["z_lo"] = min(cell["z_lo"], f.z_min)
        cell["z_hi"] = max(cell["z_hi"], f.z_max)
        cell["features"] += 1
        cell["triangles"] += f.triangles

    rows = []
    for (i, j), c in cells.items():
        vertical = c["z_hi"] - c["z_lo"]
        rows.append({"cell": f"{i}_{j}", "vertical_m": round(vertical, 1),
                     "aspect": round(vertical / tile_m, 3),
                     "features": c["features"], "triangles": c["triangles"]})
    aspects = np.array([r["aspect"] for r in rows])
    return {
        "cells": len(rows),
        "median_aspect": round(float(np.median(aspects)), 3),
        "p95_aspect": round(float(np.percentile(aspects, 95)), 3),
        "max_aspect": round(float(aspects.max()), 3),
        "cells_over_1": int((aspects > 1.0).sum()),
        "worst": sorted(rows, key=lambda r: -r["aspect"])[:5],
        "recommendation": "quadtree" if float(np.percentile(aspects, 95)) < 0.6
                          else "hybrid" if float(np.percentile(aspects, 95)) < 1.5
                          else "octree",
    }
```

The **aspect ratio** — vertical extent divided by horizontal tile size — is the number that decides this, and it is worth computing before writing any tree code. Below about 0.6 the tile is a flat slab and vertical subdivision buys nothing; above about 1.5 the tile is a column and a quadtree is actively wasteful.

Most cities come out between 0.2 and 0.5 at the median with a handful of cells above 1.0, which is why the hybrid scheme in step 4 tends to win: a uniform octree pays a cost across the whole city to fix a dozen cells.

Computing the profile per cell rather than city-wide matters. A city-wide maximum of 3.0 driven by one tower says nothing about the other 400 cells, and a uniform decision based on it is the wrong decision for 399 of them.

<figure class="diagram">
<svg viewBox="20 -2 666 270" role="img" aria-labelledby="oct-aspect-t oct-aspect-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-aspect-t">Tile aspect ratio and what it implies</title>
  <desc id="oct-aspect-d">Three tile cross-sections at the same horizontal size of 150 metres. A residential cell with 22 metres of vertical extent has an aspect of 0.15 and a quadtree is correct. A mixed cell with 74 metres has an aspect of 0.49 and a quadtree is still fine. A tower cell with 220 metres has an aspect of 1.47, so a street-level camera that sees the tile loads geometry far above the view and vertical subdivision pays.</desc>
  <rect class="svg-bg" x="20" y="-2" width="666" height="270" fill="#ffffff"/>
  <g stroke-width="1.6">
    <rect x="34" y="196" width="150" height="22" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="278" y="144" width="150" height="74" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="522" y="34" width="150" height="184" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <path d="M34 232 H184" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <path d="M278 232 H428" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <path d="M522 232 H672" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <text x="190" y="212" fill="#1f2937" font-size="12.5">22 m</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="353" y="134">74 m</text>
    <text x="597" y="26">220 m</text>
    <text x="109" y="250">aspect 0.15 — quadtree</text>
    <text x="353" y="250">aspect 0.49 — quadtree</text>
    <text x="597" y="250">aspect 1.47 — subdivide</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="109" y="226">150 m tile</text>
    <text x="353" y="226">150 m tile</text>
    <text x="597" y="226">150 m tile</text>
  </g>
  <g stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4" fill="none">
    <path d="M40 200 H690"/>
  </g>
  <text x="44" y="188" fill="#15384a" font-size="12">street-level frustum top</text>
</svg>
<figcaption>The third cell forces a client at street level to load 180 m of tower it cannot see; the first two have nothing above the frustum.</figcaption>
</figure>

### 2. Build the quadtree baseline

```python
def build_quadtree(features, root_extent_m, origin, max_features=1500, max_depth=12):
    """Subdivide in x and y only; every node spans the full vertical extent of its contents."""
    def node(bounds, items, depth):
        x0, y0, x1, y1 = bounds
        z_lo = min(f.z_min for f in items)
        z_hi = max(f.z_max for f in items)
        entry = {"bounds": (x0, y0, x1, y1, z_lo, z_hi),
                 "features": len(items),
                 "triangles": sum(f.triangles for f in items),
                 "depth": depth, "children": []}
        if len(items) <= max_features or depth >= max_depth:
            return entry
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        quads = [(x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)]
        for q in quads:
            inside = [f for f in items
                      if q[0] <= f.x < q[2] and q[1] <= f.y < q[3]]
            if inside:
                entry["children"].append(node(q, inside, depth + 1))
        entry["features"] = 0          # interior nodes hold no content in this scheme
        return entry

    x0, y0 = origin
    return node((x0, y0, x0 + root_extent_m, y0 + root_extent_m), features, 0)

def tree_stats(root):
    nodes, leaves, by_depth = 0, 0, Counter()
    volumes = []
    def walk(n):
        nonlocal nodes, leaves
        nodes += 1
        by_depth[n["depth"]] += 1
        x0, y0, x1, y1, z_lo, z_hi = n["bounds"]
        volumes.append((x1 - x0) * (y1 - y0) * max(z_hi - z_lo, 0.1))
        if not n["children"]:
            leaves += 1
        for c in n["children"]:
            walk(c)
    walk(root)
    return {"nodes": nodes, "leaves": leaves, "max_depth": max(by_depth),
            "median_volume_m3": round(float(np.median(volumes))),
            "by_depth": dict(sorted(by_depth.items()))}
```

Assigning a feature by its centroid, as in the tiling pipeline, keeps each feature in exactly one node — the same reasoning as in [tiling photogrammetry OBJ meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/tiling-photogrammetry-obj-meshes/). It means a tower sitting on a quadrant boundary lands entirely in one child, and that child's vertical extent is the tower's full height.

Deriving each node's vertical extent from its contents rather than from a fixed root range is what keeps a quadtree usable at all. A tree where every node claims 0–250 m because the root does gives the client no information to cull with.

### 3. Build the octree, and see what it costs

```python
def build_octree(features, root_extent_m, origin, z_range, max_features=1500,
                 max_depth=12, min_cell_m=8.0):
    """Subdivide in x, y and z. Features spanning a z boundary go to the parent."""
    def node(bounds, items, depth):
        x0, y0, z0, x1, y1, z1 = bounds
        entry = {"bounds": (x0, y0, x1, y1, z0, z1),
                 "features": len(items),
                 "triangles": sum(f.triangles for f in items),
                 "depth": depth, "children": [], "straddlers": 0}
        if len(items) <= max_features or depth >= max_depth \
                or (x1 - x0) <= min_cell_m:
            return entry
        mx, my, mz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2

        # A feature whose vertical extent crosses mz cannot be assigned to one octant.
        straddling = [f for f in items if f.z_min < mz <= f.z_max]
        assignable = [f for f in items if f not in straddling]
        entry["straddlers"] = len(straddling)

        octants = []
        for ox in ((x0, mx), (mx, x1)):
            for oy in ((y0, my), (my, y1)):
                for oz in ((z0, mz), (mz, z1)):
                    octants.append((ox[0], oy[0], oz[0], ox[1], oy[1], oz[1]))
        for o in octants:
            inside = [f for f in assignable
                      if o[0] <= f.x < o[3] and o[1] <= f.y < o[4]
                      and o[2] <= f.z_min < o[5]]
            if inside:
                entry["children"].append(node(o, inside, depth + 1))
        entry["features"] = len(straddling)      # the parent keeps what it cannot split
        entry["triangles"] = sum(f.triangles for f in straddling)
        return entry

    x0, y0 = origin
    z0, z1 = z_range
    return node((x0, y0, z0, x0 + root_extent_m, y0 + root_extent_m, z1), features, 0)
```

The **straddler** problem is what makes octrees awkward for buildings and unproblematic for point clouds. A point has no extent, so it always falls in exactly one octant; a 220 m tower crosses every vertical boundary in the tree and cannot be assigned to any octant without splitting the geometry.

Keeping straddlers in the parent, as above, is the simplest correct answer and it concentrates the tall geometry at shallow depths — which is precisely the geometry the street-level camera did not want. So a naive octree can make the original problem *worse*, and the numbers in the verification section show it doing exactly that.

The alternative is to split the geometry at each z boundary, which produces the balanced tree the scheme promises at the cost of cutting every tower into slices, new vertices at every cut, and a seam per slice. For a tower with a continuous glass facade those seams are visible.

### 4. The hybrid: quadtree with vertical splits where they pay

```python
def build_hybrid(features, root_extent_m, origin, max_features=1500,
                 max_depth=12, aspect_threshold=0.8, z_split_min_m=60.0):
    """Quadtree by default; split a node vertically only when its aspect justifies it."""
    def node(bounds, items, depth, allow_z=True):
        x0, y0, x1, y1 = bounds
        z_lo = min(f.z_min for f in items)
        z_hi = max(f.z_max for f in items)
        extent = x1 - x0
        aspect = (z_hi - z_lo) / max(extent, 1e-6)
        entry = {"bounds": (x0, y0, x1, y1, z_lo, z_hi), "depth": depth,
                 "features": len(items), "triangles": sum(f.triangles for f in items),
                 "aspect": round(aspect, 3), "split": None, "children": []}

        if len(items) <= max_features or depth >= max_depth:
            return entry

        if allow_z and aspect > aspect_threshold and (z_hi - z_lo) > z_split_min_m:
            # Split the *features* by height class, not the geometry by a plane.
            mid = z_lo + (z_hi - z_lo) / 2
            low = [f for f in items if f.z_max <= mid]
            high = [f for f in items if f.z_max > mid]
            if low and high:
                entry["split"] = "height_class"
                entry["features"] = 0
                entry["triangles"] = 0
                entry["children"] = [node(bounds, low, depth + 1, allow_z=False),
                                     node(bounds, high, depth + 1, allow_z=False)]
                return entry

        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        entry["split"] = "quad"
        entry["features"] = 0
        entry["triangles"] = 0
        for q in [(x0, y0, mx, my), (mx, y0, x1, my), (x0, my, mx, y1), (mx, my, x1, y1)]:
            inside = [f for f in items if q[0] <= f.x < q[2] and q[1] <= f.y < q[3]]
            if inside:
                entry["children"].append(node(q, inside, depth + 1, allow_z=True))
        return entry

    x0, y0 = origin
    return node((x0, y0, x0 + root_extent_m, y0 + root_extent_m), features, 0)
```

Splitting by **height class** rather than by a geometric plane is the move that makes the hybrid work. The low-rise features and the high-rise features become two sibling tiles occupying the same footprint with different vertical extents — so a street-level camera loads the low-rise tile and culls the high-rise one on its bounding volume, without any geometry being cut.

Setting `allow_z=False` on the children prevents a chain of vertical splits, which would produce a tree with many thin tiles and poor locality. One vertical split per quadtree level is enough.

The 60 m minimum stops the rule from firing on a cell whose aspect is high only because the cell is small — a 20 m cell containing a 25 m building has an aspect of 1.25 and nothing to gain from splitting.

### 5. Measure what a street-level view has to load

```python
def frustum_load(root, camera_xy, camera_z, fov_deg=60.0, pitch_deg=5.0,
                 far_m=800.0, sse_px=16.0, screen_px=1080):
    """Triangles the client must load for one view, per scheme."""
    k = screen_px / (2.0 * math.tan(math.radians(fov_deg) / 2.0))
    top_at = lambda d: camera_z + d * math.tan(math.radians(pitch_deg + fov_deg / 2))
    loaded_tris, loaded_tiles, wasted_tris = 0, 0, 0

    def visible(bounds):
        x0, y0, x1, y1, z_lo, z_hi = bounds
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        d = math.hypot(cx - camera_xy[0], cy - camera_xy[1])
        if d > far_m:
            return False, d, 0.0
        ceiling = top_at(d)
        overlap = max(0.0, min(z_hi, ceiling) - z_lo)
        return overlap > 0, d, overlap / max(z_hi - z_lo, 1e-6)

    def walk(n, geometric_error):
        nonlocal loaded_tris, loaded_tiles, wasted_tris
        seen, d, useful_fraction = visible(n["bounds"])
        if not seen:
            return
        sse = geometric_error * k / max(d, 1.0)
        if n["children"] and sse > sse_px:
            for c in n["children"]:
                walk(c, geometric_error / 2.0)
            return
        loaded_tiles += 1
        loaded_tris += n["triangles"]
        wasted_tris += int(n["triangles"] * (1.0 - useful_fraction))

    walk(root, 512.0)
    return {"tiles": loaded_tiles, "triangles": loaded_tris,
            "above_frustum_triangles": wasted_tris,
            "waste_fraction": round(wasted_tris / max(loaded_tris, 1), 3)}
```

`waste_fraction` is the metric this whole page exists to reduce: the share of loaded triangles that sit above the frustum's top at their distance. A quadtree over a tower district reaches 0.5 and higher, meaning half the downloaded geometry is invisible.

Approximating the frustum by its vertical extent at each distance, rather than doing exact plane tests, is deliberate — the question is how much *vertical* geometry is wasted, and the horizontal culling is identical between the schemes.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="oct-decide-t oct-decide-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-decide-t">Reading the aspect profile into a decision</title>
  <desc id="oct-decide-d">A table mapping the 95th-percentile aspect ratio of a city's cells to the subdivision scheme to use. Below 0.6 a quadtree is correct and simplest. Between 0.6 and 1.5 the hybrid earns its extra code. Above 1.5 vertical subdivision is necessary. For point clouds an octree is right at any aspect because points have no extent and never straddle a boundary.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="168" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="186" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="386" y="20" width="336" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="168" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="186" y="54" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="386" y="54" width="336" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="168" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="186" y="88" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="386" y="88" width="336" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="168" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="186" y="122" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="386" y="122" width="336" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="156" width="168" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="186" y="156" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="386" y="156" width="336" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="102" y="42">p95 aspect</text><text x="286" y="42">scheme</text><text x="554" y="42">reason</text>
    <text x="102" y="76">below 0.6</text><text x="286" y="76">quadtree</text><text x="554" y="76">tiles are flat slabs; nothing to gain</text>
    <text x="102" y="110">0.6 to 1.5</text><text x="286" y="110">hybrid</text><text x="554" y="110">a few cells need it, most do not</text>
    <text x="102" y="144">above 1.5</text><text x="286" y="144">vertical split needed</text><text x="554" y="144">street views load unseen towers</text>
    <text x="102" y="178">any, point cloud</text><text x="286" y="178">octree</text><text x="554" y="178">points never straddle a boundary</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Compute the profile per cell before writing any tree code; the city-wide maximum tells you nothing.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">A naive octree on buildings can load more than a quadtree, because straddlers pile up in shallow nodes.</text>
</svg>
<figcaption>One number computed per cell decides the scheme, and for point clouds the answer is different.</figcaption>
</figure>

### 6. Compare the three on real geometry

```python
def compare_schemes(features, root_extent_m, origin, z_range, views):
    schemes = {
        "quadtree": build_quadtree(features, root_extent_m, origin),
        "octree": build_octree(features, root_extent_m, origin, z_range),
        "hybrid": build_hybrid(features, root_extent_m, origin),
    }
    report = {}
    for name, root in schemes.items():
        stats = tree_stats(root)
        loads = [frustum_load(root, (vx, vy), vz) for vx, vy, vz in views]
        report[name] = {
            **stats,
            "mean_tiles_per_view": round(float(np.mean([l["tiles"] for l in loads])), 1),
            "mean_triangles_per_view": int(np.mean([l["triangles"] for l in loads])),
            "mean_waste": round(float(np.mean([l["waste_fraction"] for l in loads])), 3),
        }
    best = min(report, key=lambda k: report[k]["mean_triangles_per_view"])
    return {"report": report, "best_by_triangles": best}
```

<figure class="diagram">
<svg viewBox="6 10 728 240" role="img" aria-labelledby="oct-hyb-t oct-hyb-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-hyb-t">The hybrid split, in cross-section</title>
  <desc id="oct-hyb-d">One 150 metre cell in cross-section. On the left, a quadtree leaf spans 0 to 220 metres because it contains a tower, so a street-level camera loads all of it. On the right, the hybrid splits the features into a low-rise tile spanning 0 to 34 metres and a high-rise tile spanning 0 to 220 metres containing only the towers. The street-level camera loads the low-rise tile and culls the high-rise one, and no geometry was cut to achieve it.</desc>
  <rect class="svg-bg" x="6" y="10" width="728" height="240" fill="#ffffff"/>
  <rect x="20" y="24" width="330" height="212" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="390" y="24" width="330" height="212" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="185" y="46" fill="#1f2937" font-size="13" text-anchor="middle">quadtree leaf: one tile, 0–220 m</text>
  <text x="555" y="46" fill="#1f2937" font-size="13" text-anchor="middle">hybrid: two sibling tiles</text>
  <g stroke-width="1.6">
    <rect x="58" y="58" width="254" height="148" fill="#ffffff" stroke="#b0413e"/>
    <rect x="78" y="176" width="46" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="132" y="168" width="40" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="70" width="34" height="136" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="226" y="180" width="38" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="272" y="86" width="30" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="418" y="164" width="254" height="42" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="438" y="176" width="46" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="492" y="168" width="40" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="586" y="180" width="38" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <path d="M542 58 H576 V206 H542 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-dasharray="5 4"/>
    <path d="M632 74 H662 V206 H632 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-dasharray="5 4"/>
  </g>
  <path d="M40 152 H336" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4" fill="none"/>
  <path d="M400 152 H710" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4" fill="none"/>
  <g fill="#15384a" font-size="12">
    <text x="64" y="146">frustum top</text>
    <text x="422" y="146">frustum top</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="185" y="228">all 268 k triangles loaded; 54% above the frustum</text>
    <text x="555" y="228">low-rise tile loaded, high-rise culled: 71 k triangles</text>
  </g>
</svg>
<figcaption>Two sibling tiles over the same footprint: the towers are a separate, cullable tile and no geometry was cut.</figcaption>
</figure>

## Expected Output & Verification

```text
{'cells': 418, 'median_aspect': 0.163, 'p95_aspect': 0.887, 'max_aspect': 1.467,
 'cells_over_1': 11, 'recommendation': 'hybrid',
 'worst': [{'cell': '14_9', 'vertical_m': 220.1, 'aspect': 1.467, 'features': 84,
            'triangles': 268412}, …]}
{
  "report": {
    "quadtree": {"nodes": 1841, "leaves": 1402, "max_depth": 7,
                 "mean_tiles_per_view": 38.4, "mean_triangles_per_view": 1184220,
                 "mean_waste": 0.311},
    "octree":   {"nodes": 3904, "leaves": 2988, "max_depth": 9,
                 "mean_tiles_per_view": 91.2, "mean_triangles_per_view": 1402881,
                 "mean_waste": 0.287},
    "hybrid":   {"nodes": 2016, "leaves": 1544, "max_depth": 8,
                 "mean_tiles_per_view": 42.1, "mean_triangles_per_view": 742104,
                 "mean_waste": 0.104}
  },
  "best_by_triangles": "hybrid"
}
```

The octree result is the finding worth dwelling on: it loads **more** geometry than the quadtree despite a lower waste fraction, because the straddling towers were pushed into shallow parent nodes that every view has to load. It also more than doubles the tile count, which costs request overhead and draw calls.

The hybrid cuts loaded triangles by 37% against the quadtree and waste by two-thirds, for an 9% increase in node count. That is the shape of result that justifies the extra code.

Verify the trees are correct before trusting the comparison, since a tree that loses features will look wonderfully efficient:

```python
def conservation_check(features, root):
    """Every feature must appear in exactly one node, and bounds must nest."""
    seen = Counter()
    problems = []

    def walk(n, parent_bounds=None):
        x0, y0, x1, y1, z_lo, z_hi = n["bounds"]
        if parent_bounds is not None:
            px0, py0, px1, py1, pz_lo, pz_hi = parent_bounds
            if x0 < px0 - 1e-6 or x1 > px1 + 1e-6 or y0 < py0 - 1e-6 or y1 > py1 + 1e-6:
                problems.append(f"depth {n['depth']}: horizontal bounds escape parent")
            if z_lo < pz_lo - 1e-6 or z_hi > pz_hi + 1e-6:
                problems.append(f"depth {n['depth']}: vertical bounds escape parent")
        seen[n["depth"]] += n["features"]
        for c in n["children"]:
            walk(c, n["bounds"])

    walk(root)
    total_in_tree = sum(seen.values())
    return {"features_in": len(features), "features_in_tree": total_in_tree,
            "conserved": total_in_tree == len(features),
            "by_depth": dict(sorted(seen.items())),
            "bounds_problems": problems[:5]}

print(conservation_check(FEATURES, build_hybrid(FEATURES, 4800, (0, 0))))
```

Bounds nesting is the other correctness property and the one the 3D Tiles validator will check anyway. A child whose vertical extent exceeds its parent's makes the parent's volume a lie, so the client culls the parent and never reaches the child — geometry that is simply missing.

Then verify the improvement holds across views, not just the one that motivated it:

```python
def view_sweep(features, root_extent_m, origin, z_range, n=48, seed=5):
    """Random street-level and aerial views; the hybrid must not lose anywhere."""
    rng = np.random.default_rng(seed)
    views = []
    for _ in range(n // 2):
        views.append((rng.uniform(0, root_extent_m), rng.uniform(0, root_extent_m), 1.7))
    for _ in range(n - n // 2):
        views.append((rng.uniform(0, root_extent_m), rng.uniform(0, root_extent_m), 400.0))

    trees = {"quadtree": build_quadtree(features, root_extent_m, origin),
             "hybrid": build_hybrid(features, root_extent_m, origin)}
    rows = []
    for i, v in enumerate(views):
        q = frustum_load(trees["quadtree"], (v[0], v[1]), v[2])
        h = frustum_load(trees["hybrid"], (v[0], v[1]), v[2])
        rows.append({"view": i, "street": v[2] < 50,
                     "quad_tris": q["triangles"], "hybrid_tris": h["triangles"],
                     "ratio": round(h["triangles"] / max(q["triangles"], 1), 3)})
    street = [r for r in rows if r["street"]]
    aerial = [r for r in rows if not r["street"]]
    return {
        "street_mean_ratio": round(float(np.mean([r["ratio"] for r in street])), 3),
        "aerial_mean_ratio": round(float(np.mean([r["ratio"] for r in aerial])), 3),
        "views_where_hybrid_worse": sum(1 for r in rows if r["ratio"] > 1.02),
        "worst_regression": max(rows, key=lambda r: r["ratio"]),
    }
```

The aerial ratio is the check that keeps this honest. A scheme that helps street-level views by 60% and costs aerial views 20% may still be the right trade, but the trade has to be visible — and `views_where_hybrid_worse` counting more than a handful means the aspect threshold is firing too eagerly.

## Performance Notes

- **Building any of these trees is seconds** for 400,000 features; the cost is entirely in tiling the content afterwards.
- **The octree's node count is the hidden cost.** More than double the tiles means more than double the requests, and the request count often matters more than the bytes.
- **The hybrid adds one level of depth** in the cells that need it and none elsewhere, which keeps the tree's fan-out comparable to the quadtree's.
- **Vertical splitting only helps oblique and street-level views.** A top-down city view sees everything anyway, so measure with the views your users actually use.
- **Do not split geometry at a z plane** unless the content is a point cloud. The seams and the extra vertices cost more than the culling gains for buildings.
- **Point clouds are the opposite case**: points have no extent, straddling does not exist, and a pure octree is the right structure.

## Common Errors

**Octree loads more than the quadtree.** Straddling features accumulated in shallow nodes. Expected; use the hybrid or split the geometry.

**Towers disappear at some camera angles.** A child's vertical extent exceeds its parent's, so the parent culls first. Check bounds nesting.

**Feature count does not match after building the tree.** A feature fell outside every octant — usually a `z_min` exactly on a boundary with a half-open interval on the wrong side.

**The hybrid splits every cell.** The aspect threshold is too low, or `z_split_min_m` is absent so small cells qualify. Raise both.

**Tile count exploded.** `min_cell_m` is missing from the octree, so it subdivides down to metre-scale cells in dense areas.

**Street-level views improved and aerial views got worse.** The high-rise tile is being loaded alongside the low-rise one in top-down views, which is correct — confirm the regression is small and bounded.

## Frequently Asked Questions

### Does implicit tiling support octrees?

Yes — 3D Tiles implicit tiling defines both `QUADTREE` and `OCTREE` subdivision schemes, and an octree subtree is the natural fit for a point cloud. The hybrid described here is not expressible implicitly, because its structure is data-dependent; it needs explicit tileset JSON.

### What about splitting towers into vertical slices as separate features?

It works and it is a data-modelling decision rather than a tiling one: a tower represented as five stacked features tiles beautifully in an octree. The cost is that "the tower" is no longer one feature for picking, styling or metadata.

### Is 150 m the right tile size?

It is a reasonable city default. The aspect profile is the thing to check: if the p95 aspect is above 1, either subdivide vertically or use larger horizontal tiles, which lowers the aspect and raises the per-tile payload.

## Related Guides

- [Balancing Tile Content Size Across Levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/balancing-tile-content-size-across-levels/) — the other half of tree quality
- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — emitting whichever tree wins
- [Choosing Shard Sizes for City-Scale Tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/choosing-shard-sizes-for-city-scale-tiling/) — the pipeline-side view of the same choice

Back to [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/).
