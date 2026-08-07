# Fixing non-manifold edges in 3D meshes

Fixing non-manifold edges in 3D meshes means finding every edge that is shared by a number of faces other than exactly two — the formal manifold rule is that each interior edge belongs to precisely two faces — and then merging, splitting, or removing the offending geometry until the count is exactly two everywhere. This page walks through detecting those edges with `trimesh` and `open3d`, repairing them with `numpy`-driven topological surgery, and re-validating the result with `is_watertight` and the Euler characteristic `V − E + F`.

You hit non-manifold edges constantly when assembling a digital twin from heterogeneous sources: LiDAR-derived surfaces stitched against CAD exports, photogrammetry tiles meeting at a shared boundary, or two building shells fused at a wall. Wherever three faces collapse onto one edge — or a single dangling face leaves an edge with only one — the mesh stops being a clean two-sided surface. The root cause is almost always coordinate rounding and overlapping boundaries: when two tiles in EPSG:32618 are clipped along a shared seam, vertices that are nominally identical land a few microns apart, and a third face welds to the same edge instead of pairing cleanly with the second.

That single defect breaks watertightness, so `is_watertight` returns `False`; it makes Boolean operations (union, difference for footprint clipping) produce garbage because the algorithm cannot decide which side of the surface is interior; it crashes slicers when you 3D-print a model for fabrication review; and it leaves CityGML LOD2 ingestion rejecting the geometry outright, since the OGC schema requires manifold solids for building volumes. Downstream, the same ambiguity corrupts ray-casting for shadow and line-of-sight analysis, because a ray crossing a triple-shared edge has no well-defined entry or exit. The fix is cheap at mesh time and expensive once the twin is in production, so it belongs in your ingestion gate, not your incident backlog.

<figure class="diagram">
<svg viewBox="-44 1 520 263" role="img" aria-labelledby="nme-t nme-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nme-t">A non-manifold edge shared by three faces</title>
  <desc id="nme-d">A manifold edge on the left is shared by exactly two faces, while a non-manifold edge on the right has a third face joined along the same edge, making it shared by three faces.</desc>
  <rect class="svg-bg" x="-44" y="1" width="520" height="263" fill="#ffffff"/>
  <defs>
    <marker id="nme-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M60 40 L60 180 L150 150 L150 70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M60 40 L60 180 L-30 150 L-30 70 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2" transform="translate(120,0)"/>
  <line x1="60" y1="40" x2="60" y2="180" stroke="#1f2937" stroke-width="4"/>
  <path d="M370 40 L370 180 L460 150 L460 70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M370 40 L370 180 L280 150 L280 70 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M370 40 L370 180 L420 250 L420 110 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <line x1="370" y1="40" x2="370" y2="180" stroke="#c46a3d" stroke-width="4"/>
  <text x="148" y="215" fill="#1f2937" font-size="13" text-anchor="middle">Manifold: edge in 2 faces</text>
  <text x="370" y="30" fill="#1f2937" font-size="13" text-anchor="middle">Non-manifold: edge in 3 faces</text>
</svg>
<figcaption>Left: a clean edge shared by exactly two faces. Right: a third face joined along the same edge raises the shared-face count to three, violating the manifold rule.</figcaption>
</figure>

This guide sits under [Mesh Topology Basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/), which covers the half-edge data structures and manifold constraints these repairs rely on.

## Prerequisites

You need Python 3.10+ and the following packages, pinned to versions whose APIs match the snippets below:

```bash
pip install "trimesh==4.4.*" "open3d==0.18.*" "numpy>=1.26,<2.1"
```

Inputs and assumptions:

- A triangle mesh in `.ply`, `.obj`, or `.stl` — the routines assume triangulated faces (quads must be triangulated first with `mesh.triangulate()` or an upstream step).
- The mesh carries projected, metric coordinates (for example UTM zone 18N, EPSG:32618). Large eastings/northings (hundreds of thousands of metres) lose precision when hashed as float32, so plan to subtract a `crs_offset` before repair and add it back afterward.
- Vertical heights are orthometric in EPSG:32618+5703 if you care about volumetrics, but topology repair itself is CRS-agnostic once coordinates are metric and origin-shifted.

## Step-by-Step

### 1. Detect non-manifold edges by counting face adjacency

The definition is mechanical: build the edge-to-face map, count faces per edge, and flag every edge whose count is not 2. `trimesh` exposes the raw `(3 * n_faces, 2)` edge array; sorting each edge's vertex pair makes opposite-direction half-edges hash identically.

```python
import trimesh
import numpy as np

mesh = trimesh.load("building_block.ply", force="mesh", process=False)

# Shift large GIS coordinates to the origin to protect float precision.
crs_offset = mesh.vertices.mean(axis=0)
mesh.vertices -= crs_offset

sorted_edges = np.sort(mesh.edges, axis=1)
unique_edges, inverse = np.unique(sorted_edges, axis=0, return_inverse=True)
edge_counts = np.bincount(inverse)

non_manifold = unique_edges[edge_counts != 2]
print(f"non-manifold edges: {len(non_manifold)}")
print(f"  boundary (1 face): {(edge_counts == 1).sum()}")
print(f"  over-shared (>2):  {(edge_counts > 2).sum()}")
```

Edges with count 1 are open boundaries (holes or dangling faces); edges with count `>2` are the classic non-manifold over-sharing the diagram shows. Both must reach exactly 2 before the mesh is watertight.

<figure class="diagram">
<svg viewBox="78 3 691 299" role="img" aria-labelledby="nm-hist-t nm-hist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nm-hist-t">Edges grouped by how many faces use them</title>
  <desc id="nm-hist-d">Counting faces per edge sorts a mesh's edges into four groups. Edges used by one face are boundaries. Edges used by two faces are manifold and should be the overwhelming majority. Edges used by three or more faces are non-manifold and leave surface orientation undefined. Bar lengths are on a logarithmic scale.</desc>
  <rect class="svg-bg" x="78" y="3" width="691" height="299" fill="#ffffff"/>
  <text x="390" y="32" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">One pass over the edge–face table classifies every edge in the mesh</text>
  <rect x="150" y="60" width="184" height="30" rx="6" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="112" width="300" height="30" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="150" y="164" width="123" height="30" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="150" y="216" width="67" height="30" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5">
    <text x="140" y="80" text-anchor="end">1 face</text>
    <text x="140" y="132" text-anchor="end">2 faces</text>
    <text x="140" y="184" text-anchor="end">3 faces</text>
    <text x="140" y="236" text-anchor="end">4+ faces</text>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="344" y="80" text-anchor="start">3,120 edges — boundary edge — a hole, or the patch's own rim</text>
    <text x="460" y="132" text-anchor="start">486,400 edges — manifold — the only healthy count</text>
    <text x="283" y="184" text-anchor="start">214 edges — non-manifold — orientation is undefined here</text>
    <text x="227" y="236" text-anchor="start">18 edges — usually a duplicated patch welded onto the surface</text>
  </g>
  <text x="390" y="284" fill="#5b6471" font-size="12" text-anchor="middle">Bar length is logarithmic — the 232 broken edges that matter would be invisible on a linear axis</text>
</svg>
<figcaption>The distribution is the diagnosis. A healthy closed mesh has almost everything in the two-face bar; anything in the three-plus bars has to be resolved before the surface has a well-defined inside.</figcaption>
</figure>

### 2. Merge coincident vertices and drop degenerate faces

The most common cause of phantom non-manifold edges is duplicate vertices: two faces that *look* like they share an edge actually reference different vertex indices at the same coordinate, so the adjacency map never pairs them. `merge_vertices()` welds vertices within a tolerance, collapsing those duplicates. Removing zero-area (degenerate) faces eliminates edges that exist only because of a sliver triangle.

```python
mesh.merge_vertices(digits_vertex=5)          # weld near-coincident vertices
mesh.update_faces(mesh.nondegenerate_faces()) # drop zero-area slivers

sorted_edges = np.sort(mesh.edges, axis=1)
_, inverse = np.unique(sorted_edges, axis=0, return_inverse=True)
print("remaining non-manifold:", (np.bincount(inverse) != 2).sum())
```

In typical photogrammetry-meets-CAD merges this step alone resolves the majority of defects, because most were T-junctions and split seams rather than true triple-shared edges.

### 3. Remove duplicate faces and conservatively delete true over-sharing

Duplicate faces — the same triangle stored twice, common after a naive shell union — push an edge's count to 3 or 4. Drop them first with `unique_faces()`. For edges still shared by more than two faces, conservative face deletion guarantees manifold validity at the cost of a little surface area, which is acceptable for geospatial bounding volumes.

```python
mesh.update_faces(mesh.unique_faces())        # remove exact duplicate triangles

sorted_edges = np.sort(mesh.edges, axis=1)
unique_edges, inverse = np.unique(sorted_edges, axis=0, return_inverse=True)
edge_counts = np.bincount(inverse)

over_shared = np.where(edge_counts > 2)[0]
if len(over_shared):
    bad_edge_rows = np.where(np.isin(inverse, over_shared))[0]
    bad_faces = np.unique(bad_edge_rows // 3)  # 3 edges per face
    keep = np.ones(len(mesh.faces), dtype=bool)
    keep[bad_faces] = False
    mesh.update_faces(keep)
    print(f"removed {len(bad_faces)} faces on over-shared edges")
```

### 4. Fill the resulting boundary holes

Deleting faces (and any pre-existing dangling triangles) leaves count-1 boundary edges. `trimesh.repair` fills small holes by triangulating their loops; combined with consistent normal orientation this restores the closed surface.

```python
trimesh.repair.fill_holes(mesh)
trimesh.repair.fix_normals(mesh)              # outward-facing, winding-consistent

mesh.vertices += crs_offset                    # restore real-world coordinates
```

Only fill holes whose area is below a sane threshold (for example `< 0.5 m²` for a building footprint). A gaping hole signals missing input data, not a topology defect, and triangulating it fabricates geometry that misrepresents the real asset.

### 5. Re-validate with the Euler characteristic V − E + F

A closed, genus-0 manifold satisfies `V − E + F = 2`. Computing it from the deduplicated edge set is an independent check that no over-sharing survived — `is_watertight` can be fooled by some pathologies, but the Euler count cannot be if you build it from unique edges.

```python
V = len(mesh.vertices)
F = len(mesh.faces)
E = len(np.unique(np.sort(mesh.edges, axis=1), axis=0))
euler = V - E + F
print(f"V={V} E={E} F={F}  ->  V-E+F = {euler}")
assert euler == 2, f"expected Euler 2 for closed genus-0, got {euler}"
mesh.export("building_block_repaired.ply")
```

A cross-check in `open3d` is worth running for a second opinion, since it computes non-manifold edges with an independent half-edge implementation:

```python
import open3d as o3d

m = o3d.io.read_triangle_mesh("building_block_repaired.ply")
print("non-manifold edges:", len(m.get_non_manifold_edges()))
print("watertight:", m.is_watertight())
```

<figure class="diagram">
<svg viewBox="29 2 682 274" role="img" aria-labelledby="nm-euler-t nm-euler-d" xmlns="http://www.w3.org/2000/svg">
  <title id="nm-euler-t">What the Euler characteristic should come out at</title>
  <desc id="nm-euler-d">Vertices minus edges plus faces equals two for a closed surface with no handles, one for a surface with a single boundary such as an open patch, and zero for a torus or any surface carrying one handle. Each additional hole lowers the value by one, and each additional handle lowers it by two.</desc>
  <rect class="svg-bg" x="29" y="2" width="682" height="274" fill="#ffffff"/>
  <text x="370" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">χ = V − E + F, and what each value is telling you</text>
  <circle cx="120" cy="120" r="52" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M300 68 h104 v104 h-104 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M300 68 h104" fill="none" stroke="#c46a3d" stroke-width="4" stroke-dasharray="7 4"/>
  <ellipse cx="600" cy="120" rx="62" ry="46" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2.5"/>
  <ellipse cx="600" cy="120" rx="22" ry="14" fill="#ffffff" stroke="#c46a3d" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">
    <text x="120" y="206">χ = 2</text>
    <text x="352" y="206">χ = 1</text>
    <text x="600" y="206">χ = 0</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="120" y="228">closed, no handles</text>
    <text x="352" y="228">one open boundary</text>
    <text x="600" y="228">one handle (torus)</text>
  </g>
  <text x="370" y="258" fill="#15384a" font-size="12" text-anchor="middle">Each extra boundary loop costs 1; each extra handle costs 2 — so an arcaded building at χ = −4 can be perfectly valid</text>
</svg>
<figcaption>χ is a shape statement, not a pass mark. Assert the value your model should have — an open terrain patch is never going to reach two, and forcing it there means capping a hole that belongs.</figcaption>
</figure>

## Expected Output & Verification

Running the full sequence on a defective building shell produces something like this:

```text
non-manifold edges: 47
  boundary (1 face): 12
  over-shared (>2):  35
remaining non-manifold: 8
removed 8 faces on over-shared edges
V=2184 E=6546 F=4364  ->  V-E+F = 2
non-manifold edges: 0
watertight: True
```

The pass criteria are unambiguous:

- `len(mesh.get_non_manifold_edges()) == 0` in `open3d`, and `(np.bincount(inverse) != 2).sum() == 0` in `trimesh`.
- `mesh.is_watertight` is `True`.
- `V − E + F == 2` for a single closed genus-0 shell (for a model with `h` handles/tunnels the target is `2 − 2h`, so a torus correctly yields 0).

A compact assertion block you can drop straight into a CI gate:

```python
edges = np.sort(mesh.edges, axis=1)
counts = np.bincount(np.unique(edges, axis=0, return_inverse=True)[1])
assert (counts != 2).sum() == 0, "non-manifold edges remain"
assert mesh.is_watertight, "mesh is not watertight"
```

## Common Errors

**`numpy.core._exceptions._ArrayMemoryError` (or vertices snapping together) on large UTM meshes.** Coordinates like `(583204.71, 4507811.93, 41.2)` lose ~2–3 cm of precision in float32, so `merge_vertices()` either welds vertices that should stay separate or fails to weld true duplicates, leaving the non-manifold count stubbornly above zero. Fix: subtract `crs_offset = mesh.vertices.mean(axis=0)` before repair and add it back after export, exactly as in step 1.

**`AttributeError: 'Trimesh' object has no attribute 'remove_duplicate_faces'`.** `trimesh` 4.x removed the old in-place `remove_duplicate_faces()` and `remove_degenerate_faces()` methods. Use the boolean-mask form instead: `mesh.update_faces(mesh.unique_faces())` and `mesh.update_faces(mesh.nondegenerate_faces())`.

**`is_watertight` stays `False` after `fill_holes`, even with zero non-manifold edges.** This usually means non-manifold *vertices* — a bow-tie where two shells touch at a single point without sharing an edge. `fill_holes` cannot resolve these. Split the surface first with `mesh.split(only_watertight=False)`, repair each component, and recombine, or call `open3d`'s `remove_non_manifold_edges()` followed by `remove_unreferenced_vertices()`.

## Frequently Asked Questions

### Why count faces per edge instead of trusting `is_watertight`?
`is_watertight` answers a yes/no question and can be misled by certain non-manifold-vertex pathologies, whereas counting faces per unique edge tells you exactly how many edges are wrong and whether they are boundaries (count 1) or over-shared (count >2). That breakdown drives which repair to apply — hole-filling versus face deletion — so the count is both the diagnosis and the verification.

### Should I delete faces or split the edge to fix over-sharing?
Edge splitting preserves surface area but can introduce new T-junctions and is hard to make deterministic across an automated pipeline. For digital twin bounding volumes, where minor area loss is irrelevant to volumetrics and analysis, conservative face deletion followed by `fill_holes` is the safer, reproducible choice. Reserve splitting for cases where every triangle is semantically meaningful, such as textured heritage models.

### What Euler value should an open or multi-tunnel mesh have?
The `V − E + F == 2` test assumes a single closed surface with no handles. An open surface (a terrain patch with a boundary) will not equal 2 and that is correct — use the non-manifold edge count, not Euler, to validate it. A closed surface with `h` tunnels satisfies `V − E + F = 2 − 2h`, so a single-handle (torus-like) shell yields 0. Confirm the expected genus before asserting a specific number.

## Related Guides

- [Mesh Topology Basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — manifold rules, half-edge structures, and normal validation
- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — generating meshes that need less repair
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — reducing triangle count after topology is clean
- [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) — where mesh integrity fits in the wider ingestion contract

Back to [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).
