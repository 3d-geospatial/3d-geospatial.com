# Hierarchical LOD Structuring for 3D Geospatial Data & Digital Twin Automation

City-scale digital twins fail in the same predictable way: a flat level-of-detail system that swaps an entire model at a fixed camera distance either floods the GPU with millions of triangles the moment the user zooms in, or pops a blurry placeholder into view the moment they pull back. The fix is to stop treating the model as one object and start treating space itself as the index. Hierarchical LOD structuring partitions a geographic extent into a tree of nested cells — a quadtree for terrain and building footprints, an octree for volumetric infrastructure — where each node carries a progressively refined slice of geometry tagged with a `geometricError` value. The renderer then walks the tree, refining only the branches whose projected error exceeds a screen-space threshold, so memory and bandwidth scale with what is actually visible rather than with the size of the dataset. This page builds that index from scratch in Python, assigns physically meaningful error values, and shows how to validate the result before it reaches a [3D Tiles](/lod-management-optimization-strategies/automated-tile-generation/) writer.

## Prerequisites

This workflow assumes a projected, metric CRS so that bounding-box dimensions are in metres and error metrics map cleanly to ground sample distance. The examples use **EPSG:25832** (ETRS89 / UTM zone 32N), the standard grid for much of central Europe; substitute your local UTM zone or national grid, but never run a quadtree over geographic degrees (EPSG:4326) — a 0.0001° cell is a different ground size at every latitude and the tree splits unevenly.

- **Python 3.11+** with `numpy` 1.26+, `shapely` 2.0+, `scipy` 1.11+, and `trimesh` 4.0+.
- **Input geometry** in a single projected CRS: building footprints as `shapely` polygons (`.geojson`/`.shp`), point clouds as `numpy` arrays of XYZ, or meshes loadable by `trimesh` (`.ply`/`.obj`/`.glb`).
- **A target screen-space error budget** in pixels (commonly 16 px) and a reference viewport height (1080 px) — these turn `geometricError` into a refinement decision at runtime.
- **A metric extent**: know your dataset's bounding box in CRS units before you start. A 4 km × 4 km city extent in EPSG:25832 subdivides to ~1 m leaf cells in 12 quadtree levels.

```python
import numpy as np
import shapely
from shapely.geometry import box
from scipy.spatial import cKDTree
import trimesh

assert shapely.__version__ >= "2.0", "shapely 2.x vectorized API required"
TARGET_SSE_PX = 16.0       # max tolerated screen-space error
VIEWPORT_H_PX = 1080.0     # reference vertical resolution
CRS = "EPSG:25832"         # ETRS89 / UTM 32N — metric, projected
```

## Concept

A hierarchical LOD index answers one question per node every frame: *is this node's detail finer than the screen can show?* If yes, draw the node's coarse geometry and stop; if no, descend to its children. Two design axes govern how you build it.

**Quadtree vs octree.** A quadtree splits each cell into four by halving X and Y, ignoring Z. It is the right structure for terrain and building footprints, where data is effectively a draped surface and vertical extent is small relative to horizontal. An octree splits into eight by halving X, Y, and Z, and earns its extra branching factor only when geometry is genuinely volumetric — dense indoor point clouds, tunnel networks, vegetation canopy, or any scene where two objects stack at the same ground coordinate. Running an octree over flat footprints wastes seven-eighths of every split on empty vertical space.

**Additive vs replacement refinement.** Under *replacement* (REPLACE), a parent node's geometry is the whole region at coarse detail, and loading its children *replaces* it entirely — the parent is hidden once children render. Under *additive* (ADD), the parent stays visible and each child contributes only the *extra* detail, so the renderer accumulates geometry down the tree. REPLACE keeps draw calls flat and is the default for meshes; ADD avoids re-transmitting shared coarse geometry and suits point clouds, at the cost of more simultaneous draw calls.

**Screen-space error ties it together.** Each node stores a `geometricError` in metres — roughly the worst-case position deviation between that node's simplified geometry and the true surface. At runtime the engine projects that metre value to pixels: `sse = geometricError × viewport_height / (2 × distance × tan(fov/2))`. When `sse` drops below the budget (16 px), the node is good enough and refinement stops. This is why the index must live in a metric CRS — `geometricError` is meaningless in degrees.

<figure class="diagram">
<svg viewBox="0 0 720 360" role="img" aria-labelledby="hlod-qt-t hlod-qt-d" xmlns="http://www.w3.org/2000/svg">
  <title id="hlod-qt-t">Quadtree subdivision over an urban extent with LOD levels</title>
  <desc id="hlod-qt-d">A square urban extent is recursively divided into quadrants across three levels of detail; the root covers the whole extent at coarse geometric error, while denser building clusters split deeper to finer error, and a side legend maps each level to its geometric error in metres.</desc>
  <defs>
    <marker id="hlod-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="40" y="40" width="280" height="280" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="180" y1="40" x2="180" y2="320" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="40" y1="180" x2="320" y2="180" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="110" y1="40" x2="110" y2="180" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="40" y1="110" x2="180" y2="110" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="180" y1="180" x2="180" y2="320" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="180" y1="250" x2="320" y2="250" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="75" y="75" width="35" height="35" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="40" y="110" width="35" height="35" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="215" y="285" width="35" height="35" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="420" y="60" width="20" height="20" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="420" y="120" width="20" height="20" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="420" y="180" width="20" height="20" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <line x1="330" y1="180" x2="412" y2="180" stroke="#5b6471" stroke-width="2" marker-end="url(#hlod-arrow)"/>
  <text x="180" y="24" fill="#1f2937" font-size="15" text-anchor="middle" font-weight="600">Urban extent · EPSG:25832</text>
  <text x="540" y="40" fill="#1f2937" font-size="14" text-anchor="middle" font-weight="600">LOD / geometricError</text>
  <text x="452" y="75" fill="#1f2937" font-size="13" text-anchor="start">L0 root — 64 m</text>
  <text x="452" y="135" fill="#1f2937" font-size="13" text-anchor="start">L1 split — 16 m</text>
  <text x="452" y="195" fill="#1f2937" font-size="13" text-anchor="start">L2 leaf — 4 m</text>
  <text x="540" y="250" fill="#5b6471" font-size="12" text-anchor="middle">dense clusters</text>
  <text x="540" y="268" fill="#5b6471" font-size="12" text-anchor="middle">split deeper</text>
</svg>
<figcaption>A quadtree refines only where geometry is dense: sparse quadrants stay coarse while building clusters subdivide to finer geometricError.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow below builds a quadtree over building-footprint centroids, assigns `geometricError` per node from a halving rule anchored to the root's diagonal, and emits a structure ready for tile serialization. Every coordinate stays in EPSG:25832.

### 1. Normalize inputs and compute the metric root bounds

Load geometry, confirm it is in a projected CRS, and derive a single square root bounding box. Squaring the root keeps quadrant splits isotropic so a cell's X and Y error stay equal — anisotropic roots produce sliver tiles that break screen-space error assumptions.

```python
import geopandas as gpd
import numpy as np
from shapely.geometry import box

gdf = gpd.read_file("buildings.geojson")
assert gdf.crs is not None and gdf.crs.to_epsg() == 25832, "reproject to EPSG:25832 first"
gdf["geometry"] = gdf.geometry.make_valid()           # fix self-intersections
gdf = gdf[~gdf.geometry.is_empty]

# Representative point per footprint — guaranteed inside the polygon
pts = np.array([(p.x, p.y) for p in gdf.geometry.representative_point()])

minx, miny = pts.min(axis=0)
maxx, maxy = pts.max(axis=0)
side = max(maxx - minx, maxy - miny)                  # square the extent
root_bounds = (minx, miny, minx + side, miny + side)
print(f"root side = {side:.1f} m  ·  {len(pts)} footprints")
```

### 2. Recursively split nodes on a density threshold

Subdivide a node only while it holds more than `max_per_leaf` features and the level is below `max_depth`. This is the node-splitting threshold: it makes the tree *adaptive*, so dense downtown cells reach deep levels while sparse outskirts stop early. Use vectorized `numpy` masks rather than per-point Python loops.

```python
from dataclasses import dataclass, field

@dataclass
class QNode:
    bounds: tuple          # (minx, miny, maxx, maxy) in EPSG:25832 metres
    level: int
    idx: np.ndarray        # indices of features in this node
    geometric_error: float = 0.0
    refine: str = "REPLACE"
    children: list = field(default_factory=list)

def split(pts, bounds, idx, level, max_depth=12, max_per_leaf=64):
    node = QNode(bounds=bounds, level=level, idx=idx)
    if level >= max_depth or len(idx) <= max_per_leaf:
        return node                                   # leaf — splitting threshold met
    minx, miny, maxx, maxy = bounds
    mx, my = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    sx, sy = pts[idx, 0], pts[idx, 1]
    quads = {
        (minx, my, mx, maxy): (sx < mx) & (sy >= my),   # NW
        (mx, my, maxx, maxy): (sx >= mx) & (sy >= my),  # NE
        (minx, miny, mx, my): (sx < mx) & (sy < my),    # SW
        (mx, miny, maxx, my): (sx >= mx) & (sy < my),   # SE
    }
    for cb, mask in quads.items():
        child_idx = idx[mask]
        if child_idx.size:
            node.children.append(split(pts, cb, child_idx, level + 1,
                                       max_depth, max_per_leaf))
    return node

all_idx = np.arange(len(pts))
root = split(pts, root_bounds, all_idx, 0)
```

### 3. Assign geometricError from the root diagonal

The cleanest `geometricError` scheme is a geometric series anchored to the root: error at level *L* is the root's diagonal divided by `2^(L+1)`, scaled by a quality factor. Because each quadtree level halves cell size, halving the error per level keeps screen-space error roughly constant as the camera approaches. Leaves get error `0.0` so the engine always refines down to them when they are close enough.

```python
diag = float(np.hypot(root_bounds[2] - root_bounds[0],
                      root_bounds[3] - root_bounds[1]))

def assign_error(node, root_diag, quality=0.5):
    if not node.children:
        node.geometric_error = 0.0                    # finest available detail
    else:
        node.geometric_error = quality * root_diag / (2 ** (node.level + 1))
        for c in node.children:
            assign_error(c, root_diag, quality)

assign_error(root, diag)
print(f"root geometricError = {root.geometric_error:.2f} m  (diag {diag:.1f} m)")
```

### 4. Convert error to a screen-space refinement test

Mirror the runtime test in Python so you can validate thresholds offline. This projects each node's metre error to pixels at a given camera distance and FOV, exactly as a 3D Tiles engine does, letting you confirm the tree refines and stops where you expect.

```python
def screen_space_error(geometric_error, distance_m, fov_rad=np.radians(60),
                       viewport_h=VIEWPORT_H_PX):
    if distance_m <= 0:
        return float("inf")
    return geometric_error * viewport_h / (2.0 * distance_m * np.tan(fov_rad / 2.0))

# Will the root refine when viewed from 800 m away?
sse = screen_space_error(root.geometric_error, distance_m=800.0)
print(f"root SSE at 800 m = {sse:.1f} px  ->",
      "refine" if sse > TARGET_SSE_PX else "stop")
```

### 5. Build a bounding-volume hierarchy for fast culling

Engines cull spherical bounds faster than boxes. Precompute a minimal enclosing sphere per node from its metric bounds and store it alongside the box; this is the BVH the runtime walks for frustum culling. For volumetric data, swap the 2D centroid logic for an octree by halving Z as well, and compute the sphere from the 3D extent.

```python
def attach_bvh(node):
    minx, miny, maxx, maxy = node.bounds
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    radius = 0.5 * np.hypot(maxx - minx, maxy - miny)  # encloses the AABB
    node.sphere = (cx, cy, radius)                     # centre + radius, metres
    for c in node.children:
        attach_bvh(c)

attach_bvh(root)
```

## Validation & Verification

Verify three invariants before serialization: error is strictly decreasing down every path, the tree partitions all features without loss, and each child's bounds nest inside its parent. A tree that fails any of these will refine incorrectly or drop geometry at runtime.

```python
def validate(node, parent_error=float("inf"), parent_bounds=None):
    # 1. geometricError must strictly decrease toward leaves (3D Tiles requirement)
    assert node.geometric_error < parent_error or node.geometric_error == 0.0, \
        f"non-decreasing error at level {node.level}"
    # 2. child bounds must nest inside parent bounds (with float tolerance)
    if parent_bounds is not None:
        pminx, pminy, pmaxx, pmaxy = parent_bounds
        bminx, bminy, bmaxx, bmaxy = node.bounds
        assert bminx >= pminx - 1e-6 and bmaxx <= pmaxx + 1e-6, "x bounds escape parent"
        assert bminy >= pminy - 1e-6 and bmaxy <= pmaxy + 1e-6, "y bounds escape parent"
    leaf_count = 0 if node.children else len(node.idx)
    for c in node.children:
        leaf_count += validate(c, node.geometric_error, node.bounds)
    return leaf_count

total_in_leaves = validate(root)
assert total_in_leaves == len(pts), \
    f"feature loss: {total_in_leaves} in leaves vs {len(pts)} input"
print(f"OK — {total_in_leaves} features partitioned, no loss")
```

Expected output for a 4 km extent of ~50 000 footprints with `max_per_leaf=64`: a root `geometricError` near 2828 m (`0.5 × 5657 m diagonal / 2`), leaf levels reaching 9–11, and `total_in_leaves` exactly equal to the input count. If the leaf total is short, a `representative_point()` fell on a shared boundary and a strict `<`/`>=` split sent it nowhere — confirm every mask is mutually exclusive and collectively exhaustive.

## Performance & Scale

Recursion depth is the first scaling limit. At `max_depth=12` the tree holds up to 4^12 ≈ 16.7 M leaves, far more than any urban dataset needs; in practice the adaptive `max_per_leaf` threshold caps real depth at 9–11. Keep the centroid array as a single contiguous `float64` `numpy` array (8 bytes × 2 × N) — 50 000 footprints cost under 1 MB, so the index itself is never the bottleneck.

The expensive stage is point-to-node assignment when N grows into the millions (dense point clouds rather than footprints). Replace repeated boolean masking with a `scipy.spatial.cKDTree` so a node can query the points inside its bounds in `O(log N)` rather than scanning the full array at every level:

```python
tree = cKDTree(pts)                                   # build once, query many
def points_in_bounds(bounds):
    minx, miny, maxx, maxy = bounds
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    r = 0.5 * np.hypot(maxx - minx, maxy - miny)
    cand = tree.query_ball_point([cx, cy], r)         # coarse spherical prefilter
    cand = np.asarray(cand)
    sub = pts[cand]
    keep = (sub[:, 0] >= minx) & (sub[:, 0] < maxx) & \
           (sub[:, 1] >= miny) & (sub[:, 1] < maxy)
    return cand[keep]
```

For datasets that exceed RAM, back the coordinate array with `numpy.memmap` and serialize each leaf to a tile in the recursion's termination branch so node geometry never all resides in memory at once — the same streaming discipline used in [automated tile generation](/lod-management-optimization-strategies/automated-tile-generation/). For mesh leaves, simplify with `trimesh` before writing so each tile carries a triangle budget proportional to its `geometricError`:

```python
leaf_mesh = trimesh.load("block_0421.ply")
target_faces = max(500, int(len(leaf_mesh.faces) * 0.25))
simplified = leaf_mesh.simplify_quadric_decimation(target_faces)
```

## Failure Modes & Gotchas

**Geographic CRS poisons every error metric.** Building the tree over EPSG:4326 degrees makes `geometricError` and cell size latitude-dependent, so the same numeric threshold subdivides Oslo differently than Naples. Reproject to a metric CRS (EPSG:25832 here) *before* computing root bounds, and assert the EPSG code in code, not in a comment.

**Boundary points vanish at split lines.** A footprint centroid landing exactly on a mid-line satisfies neither `< mx` nor — if you wrote both conditions as `<` — `>= mx`. The validation step catches this as feature loss. Use the half-open convention consistently (`< mx` and `>= mx`, `< my` and `>= my`) so every cell owns its lower-left edge and no point falls through.

**Non-decreasing geometricError breaks refinement.** If a child's error is greater than or equal to its parent's, a compliant 3D Tiles engine treats the subtree as already refined and never descends, silently freezing detail. The `validate()` assertion enforces strict decrease; the halving rule in step 3 guarantees it as long as `quality` is constant down the tree.

**Over-deep splitting overwhelms the request queue.** A `max_per_leaf` set too low (say 4) produces tens of thousands of tiny tiles, and the resulting flood of HTTP requests stalls under HTTP/2 stream limits during a flyover. Tune `max_per_leaf` against your engine's draw-call budget — 64 features or ~30k triangles per leaf is a sane starting point — and watch the request graph, not just the visual result.

**Anisotropic roots create sliver tiles.** Skipping the squaring step in step 1 yields rectangular cells whose X and Y error diverge, so a node can be acceptable horizontally but blurry vertically at the same distance. Always square the root extent, or compute `geometricError` from the larger of the two cell dimensions rather than the diagonal.

## Frequently Asked Questions

### When should I use an octree instead of a quadtree?
Use an octree only when geometry stacks vertically at the same ground coordinate — dense indoor scans, multi-level interchanges, tunnel networks, or volumetric vegetation. For terrain, building footprints, and most city models the surface is effectively 2.5D, and a quadtree gives the same culling quality at a quarter of the branching factor. Splitting flat data with an octree wastes seven of every eight child slots on empty air and inflates the tileset JSON.

### How do I choose a geometricError value that looks right at runtime?
Anchor it to the root diagonal and halve per level, then verify with the screen-space error function in step 4. The numeric target is whatever pixel budget your engine uses for refinement (16 px is typical). Project a few representative node errors at the distances your camera actually flies, confirm the nodes you want visible refine and the rest stop, and adjust the `quality` factor — not the per-tile values — until the transitions land where you want.

### What is the practical difference between additive and replacement refinement here?
Replacement (REPLACE) means a node's geometry is the complete region at its level, and loading children hides the parent — draw-call count stays flat and it is the right choice for the mesh tiles this workflow produces. Additive (ADD) means each node adds only incremental detail on top of its ancestors, which avoids retransmitting shared coarse geometry and suits point clouds, at the cost of more simultaneously rendered nodes. Set the `refine` field per node; do not mix the two along a single path.

### Why must everything stay in a projected CRS during tree construction?
Because `geometricError`, cell size, and bounding-sphere radius are all distances, and a distance is only meaningful in a metric system. In EPSG:4326 a degree of longitude shrinks from ~111 km at the equator toward zero at the poles, so a fixed-threshold quadtree partitions unevenly and the runtime error projection is wrong. Reproject to your local UTM zone or national grid first; reproject back to WGS84 only at the web-delivery boundary, after the tree is built.

### How deep should the tree go for a city-scale twin?
Let the `max_per_leaf` density threshold decide depth rather than forcing a fixed `max_depth`. For a 4 km × 4 km extent at `max_per_leaf=64`, dense cores typically reach levels 9–11 (≈1–4 m leaf cells) while parks and water stop at levels 3–5. Cap `max_depth` at 12–14 purely as a safety stop against degenerate input, not as the intended leaf level.

## Related Guides

- [Implementing Quadtree LOD for Urban Models](/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/) — the concrete building-clustering walkthrough that extends this index
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — serializing this tree to a 3D Tiles tileset
- [Streaming Sync Patterns for 3D Geospatial](/lod-management-optimization-strategies/streaming-sync-patterns/) — runtime cache eviction and request batching for the tiles produced here
- [3D Format Standards Comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — how glTF and 3D Tiles carry the geometry each node holds

Back to [LOD Management & Optimization Strategies](/lod-management-optimization-strategies/).
