# Implementing quadtree LOD for urban models

This guide builds a quadtree LOD index for urban 3D models in Python using `numpy` and `shapely` — recursively subdividing a projected city extent into four quadrants per level, assigning a `geometricError` to each depth, and querying the visible nodes for a viewport. The result is the spatial backbone that drives runtime detail selection: a tree where every node maps to a deterministic ground footprint and carries the screen-space error budget a renderer needs to decide whether to draw it or descend into its children.

You hit this problem the moment a digital twin outgrows a single mesh. A city covers tens of square kilometres, and you cannot ship every building at full detail to a browser or game engine — you need an index that answers "which tiles matter for *this* camera" in microseconds. A quadtree gives you that index, but only if it is built in a metric CRS, with a `geometricError` ladder that decreases predictably toward the leaves and bounding boxes that strictly nest. Get any of those wrong and you inherit popping artifacts, distorted tiles, or a 3D Tiles tileset the validator rejects. This page walks the construction end to end so the tree you produce is directly compatible with [hierarchical LOD structuring](/lod-management-optimization-strategies/hierarchical-lod-structuring/) and the [OGC 3D Tiles](https://www.ogc.org/standard/3dtiles/) `geometricError` model.

<figure class="diagram">
<svg viewBox="0 0 760 300" role="img" aria-labelledby="qtlod-t qtlod-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qtlod-t">Quadtree subdivision and geometricError ladder</title>
  <desc id="qtlod-d">A square root node subdivides into four quadrants, each of which subdivides again, while the geometricError value drops by half at each deeper level from root to leaf.</desc>
  <defs>
    <marker id="qtlod-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="40" y="40" width="220" height="220" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="150" y1="40" x2="150" y2="260" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="40" y1="150" x2="260" y2="150" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="40" y="40" width="110" height="110" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <line x1="95" y1="40" x2="95" y2="150" stroke="#c46a3d" stroke-width="2"/>
  <line x1="40" y1="95" x2="150" y2="95" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#qtlod-arrow)">
    <line x1="470" y1="70" x2="470" y2="120"/>
    <line x1="470" y1="155" x2="470" y2="205"/>
  </g>
  <rect x="360" y="45" width="320" height="30" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="360" y="125" width="320" height="30" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="360" y="210" width="320" height="30" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="150" y="285">Recursive 2D subdivision</text>
    <text x="520" y="65">depth 0 · geometricError 512 m</text>
    <text x="520" y="145">depth 2 · geometricError 128 m</text>
    <text x="520" y="230">depth 4 (leaf) · geometricError 32 m</text>
  </g>
</svg>
<figcaption>Each level splits a node into four quadrants while the geometricError budget halves, giving the renderer a per-depth detail threshold.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `numpy` (1.24+) and `shapely` (2.0+): `pip install "numpy>=1.24" "shapely>=2.0"`. Shapely 2.0 changed several APIs, so pin it.
- An urban extent already in a **projected, metric CRS**. The examples use EPSG:25832 (ETRS89 / UTM zone 32N), the standard grid for much of central Europe; for a US twin substitute EPSG:32618 (WGS 84 / UTM zone 18N). Never build the tree in geographic EPSG:4326 — degrees are not metres, and a degree of longitude shrinks toward the poles, so quadrant areas and distance thresholds become meaningless.
- A set of building or tile meshes whose 2D footprints you can express as `shapely` geometries (a centroid plus a bounding box is enough). If your meshes carry coordinates, confirm they share the same EPSG code as the extent before you start.
- Familiarity with the 3D Tiles notion of `geometricError`: the world-space error, in metres, introduced by rendering a node instead of its children. The renderer descends when the on-screen projection of that error exceeds a pixel threshold.

## Step-by-Step

### 1. Define the city bounds in a projected CRS

Start from an explicit extent in EPSG:25832. Snapping the root to a square keeps every quadrant a square, which is what makes the depth-to-size relationship and the `geometricError` ladder clean.

```python
import numpy as np
from shapely.geometry import box

# Munich-area extent, ETRS89 / UTM zone 32N (EPSG:25832), metres.
MINX, MINY, MAXX, MAXY = 690_000.0, 5_330_000.0, 698_192.0, 5_338_192.0
CRS_EPSG = 25832

# Force a square root so quadrant areas stay uniform across the tree.
side = max(MAXX - MINX, MAXY - MINY)
root_bounds = box(MINX, MINY, MINX + side, MINY + side)

print(f"root side = {side:.0f} m  area = {root_bounds.area / 1e6:.2f} km^2  EPSG:{CRS_EPSG}")
```

A side of 8192 m (`2**13`) is deliberate: a power-of-two extent halves cleanly at every level, so leaf tiles land on round metric sizes instead of accumulating floating-point drift.

### 2. Build the quadtree by recursive subdivision

The builder halves the X and Y extents at each recursion, stopping at a maximum depth or a minimum tile area. Each node records its depth so later steps can derive `geometricError` and select detail.

```python
from dataclasses import dataclass, field
from shapely.geometry import Polygon
from typing import List, Tuple

@dataclass
class QuadNode:
    bounds: Polygon
    depth: int
    center: Tuple[float, float]
    geometric_error: float = 0.0
    mesh_ids: List[int] = field(default_factory=list)
    children: List["QuadNode"] = field(default_factory=list)

    @property
    def is_leaf(self) -> bool:
        return not self.children

def build_quadtree(bounds: Polygon, max_depth: int = 5,
                   min_area: float = 250.0, depth: int = 0) -> QuadNode:
    """Recursively partition a projected urban extent into a quadtree."""
    minx, miny, maxx, maxy = bounds.bounds
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    node = QuadNode(bounds=bounds, depth=depth, center=(cx, cy))

    if depth >= max_depth or bounds.area <= min_area:
        return node  # leaf

    quadrants = [
        box(minx, miny, cx, cy),   # SW
        box(cx, miny, maxx, cy),   # SE
        box(cx, cy, maxx, maxy),   # NE
        box(minx, cy, cx, maxy),   # NW
    ]
    node.children = [
        build_quadtree(q, max_depth, min_area, depth + 1) for q in quadrants
    ]
    return node

root = build_quadtree(root_bounds, max_depth=5, min_area=250.0)
```

The four-quadrant order (SW, SE, NE, NW) is fixed so a Morton/Z-order tile key can be derived later if you export to a tiled format.

### 3. Assign geometricError by depth

`geometricError` should fall geometrically from root to leaf so that descending one level roughly halves the visible error. A clean rule ties it to tile size: the root carries the largest error, and each child gets half its parent's. Walk the tree once and stamp the value in.

```python
def assign_geometric_error(node: QuadNode, root_error: float = 512.0) -> None:
    """geometricError halves at each deeper level: root_error / 2**depth."""
    node.geometric_error = root_error / (2 ** node.depth)
    for child in node.children:
        assign_geometric_error(child, root_error)

assign_geometric_error(root, root_error=512.0)
```

Leaves should reach a `geometric_error` near 0 only if they hold final, full-detail geometry; with `root_error=512.0` and `max_depth=5`, depth-5 leaves carry 512 / 32 = 16 m. Set the leaf to `0.0` explicitly if a leaf is genuinely the most detailed representation, because a non-zero leaf error tells the renderer there is still finer geometry to fetch — and there is not.

### 4. Assign meshes to nodes by footprint

Each mesh drops into the deepest node whose bounds fully contain its footprint. Containment (not mere intersection) keeps a building inside exactly one branch, so it never renders twice across a quadrant seam. `numpy` vectorizes the centroid math when you have thousands of footprints.

```python
def assign_mesh(node: QuadNode, mesh_id: int, footprint: Polygon) -> bool:
    """Place a mesh in the deepest node that fully contains its footprint."""
    if not node.bounds.contains(footprint):
        return False
    for child in node.children:
        if assign_mesh(child, mesh_id, footprint):
            return True
    node.mesh_ids.append(mesh_id)  # deepest container
    return True

# Example footprints (centroids + 30 m boxes), all in EPSG:25832.
rng = np.random.default_rng(42)
centers = rng.uniform([MINX, MINY], [MINX + side, MINY + side], size=(2000, 2))
footprints = [box(x - 15, y - 15, x + 15, y + 15) for x, y in centers]

placed = sum(assign_mesh(root, i, fp) for i, fp in enumerate(footprints))
print(f"placed {placed}/{len(footprints)} meshes")
```

Footprints that straddle a quadrant boundary settle at a higher (coarser) node — the deepest one that still contains them whole — which is the correct behaviour: a building spanning two tiles belongs to their shared parent.

### 5. Query the visible nodes for a viewport

At runtime you walk the tree, skip nodes outside the viewport rectangle (frustum culling, simplified to a 2D extent here), and descend while the projected `geometric_error` exceeds a pixel tolerance. The screen-space error proxy uses `numpy` for the distance and projection math.

```python
def query_visible(node: QuadNode, viewport: Polygon, camera: np.ndarray,
                  px_tolerance: float = 16.0, screen_height_px: int = 1080,
                  fov_deg: float = 60.0) -> List[QuadNode]:
    """Return the nodes a renderer should draw for this viewport."""
    if not node.bounds.intersects(viewport):
        return []  # frustum cull

    dist = float(np.linalg.norm(np.array(node.center) - camera)) or 0.1
    # Project world-space geometricError to pixels.
    px_per_metre = screen_height_px / (2.0 * dist * np.tan(np.radians(fov_deg / 2)))
    screen_error = node.geometric_error * px_per_metre

    if node.is_leaf or screen_error <= px_tolerance:
        return [node]  # this node is good enough — draw it

    drawn: List[QuadNode] = []
    for child in node.children:
        drawn += query_visible(child, viewport, camera, px_tolerance,
                               screen_height_px, fov_deg)
    return drawn

camera = np.array([694_096.0, 5_334_096.0])          # EPSG:25832
viewport = box(693_000, 5_333_000, 695_200, 5_335_200)  # 2.2 km window
visible = query_visible(root, viewport, camera, px_tolerance=16.0)
print(f"{len(visible)} nodes selected for the viewport")
```

This is the same descent logic 3D Tiles runtimes use, so the tree slots straight into the broader [LOD management workflow](/lod-management-optimization-strategies/) and the related [automated tile generation](/lod-management-optimization-strategies/automated-tile-generation/) and [streaming sync patterns](/lod-management-optimization-strategies/streaming-sync-patterns/).

## Expected Output & Verification

For a 5-level tree, node counts per depth follow the quadtree series 4^depth, and the `geometric_error` ladder halves each level. Verify both with a single traversal:

```python
from collections import defaultdict

def summarize(node, per_depth=None):
    per_depth = per_depth if per_depth is not None else defaultdict(lambda: [0, 0.0])
    per_depth[node.depth][0] += 1
    per_depth[node.depth][1] = node.geometric_error
    for c in node.children:
        summarize(c, per_depth)
    return per_depth

for depth, (count, ge) in sorted(summarize(root).items()):
    assert count == 4 ** depth, f"depth {depth}: expected {4**depth} nodes"
    print(f"depth {depth}: {count:>4} nodes  geometricError = {ge:6.1f} m")
```

Expected output:

```
depth 0:    1 nodes  geometricError =  512.0 m
depth 1:    4 nodes  geometricError =  256.0 m
depth 2:   16 nodes  geometricError =  128.0 m
depth 3:   64 nodes  geometricError =   64.0 m
depth 4:  256 nodes  geometricError =   32.0 m
depth 5: 1024 nodes  geometricError =   16.0 m
```

Three invariants must hold. First, total nodes for `max_depth=5` is (4^6 − 1) / 3 = 1365. Second, every child's `geometric_error` is exactly half its parent's. Third, every node's bounds must be contained by its parent's — assert it explicitly, because a containment break silently corrupts the viewport query:

```python
def check_containment(node):
    for c in node.children:
        assert node.bounds.contains(c.bounds.buffer(1e-6)), "child escapes parent"
        check_containment(c)
check_containment(root)
print("containment OK; total nodes:", sum(c for _, (c, _) in summarize(root).items()))
```

## Common Errors

**`TopologyException: side location conflict` (or empty viewport results).** Building the tree from EPSG:4326 coordinates, then querying with EPSG:25832 camera positions, mixes degrees and metres. `node.bounds.intersects(viewport)` returns `False` everywhere because the geometries occupy disjoint numeric ranges. Fix: reproject the extent, footprints, and camera to one projected EPSG code (here EPSG:25832) before any tree operation, and assert the ranges overlap.

**`AssertionError: child escapes parent` from the containment check.** This appears when the root is non-square and you split on the geometric center: rectangular quadrants accumulate rounding error and a child box can poke past the parent edge by a few microns. Fix: snap the root to a square power-of-two side (step 1) so halving is exact, or wrap the containment assert in a small `buffer(1e-6)` tolerance as shown.

**`RecursionError: maximum recursion depth exceeded`.** A `min_area` of `0` (or a `max_depth` above ~12) lets subdivision run until floating-point area underflows, blowing the Python stack. A 14-level tree is 4^14 ≈ 268 million leaves — never intended. Fix: cap `max_depth` to 6–8 for city blocks and keep `min_area` at the smallest meaningful tile (250 m² isolates street-level assets in the original deployment).

## Frequently Asked Questions

### Why a quadtree instead of an octree for urban models?

Cities are overwhelmingly 2.5D: buildings sit on a terrain surface and rarely stack into independent vertical layers, so subdividing the Z axis wastes nodes on empty air. A quadtree partitions only the ground plane (X/Y) and lets each node hold the full-height geometry above its footprint, which matches how 3D Tiles structures most city tilesets. Reserve octrees for genuinely volumetric data — dense point clouds, subsurface utilities, or interiors with many floors — where vertical subdivision earns its keep.

### How do I pick the root geometricError and pixel tolerance?

Set `root_error` to roughly the diagonal extent of your largest renderable feature at the root — a few hundred metres for a city block tree, which is why 512 m works for an 8192 m extent. The pixel tolerance (`px_tolerance`) is a quality dial: 16 px is a common default, lower values force deeper descent and sharper images at higher bandwidth, higher values trade fidelity for fewer draw calls. Tune the tolerance per device class rather than rebuilding the tree.

### Can I export this tree directly to a 3D Tiles tileset?

Yes — the structure maps one-to-one. Each `QuadNode` becomes a tile with a `boundingVolume` (its `bounds` reprojected to EPSG:4326 region coordinates or kept as a box), the `geometric_error` you assigned, and a `content` URI pointing at the node's decimated mesh (the `mesh_ids` you placed in step 4). The descent rule in step 5 is exactly the `geometricError` refinement 3D Tiles runtimes apply, so a tileset built this way refines predictably. See [automated tile generation](/lod-management-optimization-strategies/automated-tile-generation/) for the export mechanics.

## Related Guides

- [Hierarchical LOD Structuring for Digital Twins](/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the broader tree-design patterns this index plugs into
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — turning quadtree nodes into a streamable tileset
- [Streaming Sync Patterns for 3D Geospatial](/lod-management-optimization-strategies/streaming-sync-patterns/) — fetching and evicting tiles as the camera moves
- [LOD Management & Optimization Strategies](/lod-management-optimization-strategies/) — the optimization area overall
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — picking and enforcing the projected CRS the tree depends on

Back to [Hierarchical LOD Structuring for Digital Twins](/lod-management-optimization-strategies/hierarchical-lod-structuring/).
