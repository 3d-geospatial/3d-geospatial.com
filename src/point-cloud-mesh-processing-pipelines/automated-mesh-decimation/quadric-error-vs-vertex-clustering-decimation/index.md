---
title: "Quadric Error vs Vertex Clustering Decimation"
description: "Choose between QEM and vertex clustering by measuring both: silhouette preservation, Hausdorff bound, throughput, and where clustering's speed is worth its edges."
---
# Quadric Error vs Vertex Clustering Decimation

This page compares the two decimation families a spatial pipeline actually uses — **quadric error metric** collapse and **vertex clustering** — by running both on the same mesh and measuring what each keeps and what each costs. The short answer is that QEM preserves silhouettes and gives a reportable error bound, clustering is an order of magnitude faster and rounds every corner, and the choice follows from whether the mesh is a building or a terrain patch.

## Why you hit this

Decimation appears once in a pipeline and is chosen once, usually by whichever function the library made easiest. That works until the city contains both photogrammetric terrain, where speed matters and corners do not exist, and building geometry, where the silhouette is the whole point. Running the wrong one on the second produces models that pass every topology check and read as slightly melted, with the defect distributed evenly enough that nobody can point at a specific building.

The budgets and error bounds this feeds are in [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).

## Prerequisites

- Python 3.10+ with `open3d>=0.18`, `trimesh>=4.0`, `numpy>=1.24` and `scipy>=1.11`.
- A manifold mesh on a local origin. Both algorithms behave badly on unmerged geometry, and clustering in particular will weld across a gap that a merge should have closed first.
- A target: either a triangle budget or a maximum deviation. The two algorithms are parameterised differently and only one of them accepts the second directly.

## Step-by-Step

### 1. Understand what each algorithm optimises

**QEM** assigns every vertex a quadric — the sum of squared distances to the planes of its incident faces — and repeatedly collapses the edge whose collapse adds the least error. Because the metric is the exact squared deviation, the algorithm naturally spends its collapses on flat regions and protects creases, and the accumulated error is reportable.

**Vertex clustering** overlays a regular grid, replaces every vertex in a cell with one representative, and rebuilds the faces. It makes no decisions and looks at no geometry beyond the cell, so it runs in one pass at essentially the speed of a hash, and it rounds any feature smaller than a cell out of existence.

```python
import open3d as o3d
import numpy as np

mesh = o3d.io.read_triangle_mesh("building_block.ply")
mesh.compute_vertex_normals()
n0 = len(mesh.triangles)

qem = mesh.simplify_quadric_decimation(target_number_of_triangles=n0 // 8)
clustered = mesh.simplify_vertex_clustering(
    voxel_size=0.35, contraction=o3d.geometry.SimplificationContraction.Quadric)

print(f"source     {n0:>9,} triangles")
print(f"QEM        {len(qem.triangles):>9,}")
print(f"clustering {len(clustered.triangles):>9,}")
```

Note that clustering takes a cell size rather than a triangle count. You cannot ask it for a budget; you ask for a resolution and accept whatever count falls out, which is the first practical difference and the reason it does not fit a tile-budget pipeline without a search.

<figure class="diagram">
<svg viewBox="23 43 729 205" role="img" aria-labelledby="dc-two-t dc-two-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dc-two-t">Where each algorithm spends its simplification</title>
  <desc id="dc-two-d">Quadric error collapse removes vertices from flat regions first because those collapses add almost no error, so a corner survives until the flat regions are exhausted. Vertex clustering replaces every vertex in a grid cell with one representative regardless of what the geometry is doing, so a corner falling inside a cell is rounded off immediately.</desc>
  <rect class="svg-bg" x="23" y="43" width="729" height="205" fill="#ffffff"/>
  <polyline points="40,180 110,178 180,176 250,174 250,90 320,88" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <g fill="#5b6471">
    <circle cx="40" cy="180" r="3"/><circle cx="75" cy="179" r="3"/><circle cx="110" cy="178" r="3"/>
    <circle cx="145" cy="177" r="3"/><circle cx="180" cy="176" r="3"/><circle cx="215" cy="175" r="3"/>
    <circle cx="250" cy="174" r="3"/><circle cx="250" cy="130" r="3"/><circle cx="250" cy="90" r="3"/>
    <circle cx="285" cy="89" r="3"/><circle cx="320" cy="88" r="3"/>
  </g>
  <polyline points="420,180 560,174 560,90 700,88" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#4f7a4d">
    <circle cx="420" cy="180" r="4"/><circle cx="560" cy="174" r="4"/>
    <circle cx="560" cy="90" r="4"/><circle cx="700" cy="88" r="4"/>
  </g>
  <polyline points="420,206 546,202 574,124 700,116" fill="none" stroke="#c46a3d" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="180" y="222" fill="#5b6471" font-size="12" text-anchor="middle">source — 11 vertices</text>
  <text x="490" y="70" fill="#4f7a4d" font-size="12" text-anchor="middle">QEM — 4 vertices, corner intact</text>
  <text x="620" y="230" fill="#c46a3d" font-size="12" text-anchor="middle">clustering — corner rounded into one cell</text>
</svg>
<figcaption>Both reach four vertices. Only one of them still has a corner, and on a facade that corner is what the building looks like.</figcaption>
</figure>

### 2. Measure what each one kept

The comparison that decides it is deviation, and specifically the worst case rather than the mean.

```python
import numpy as np
import trimesh
from scipy.spatial import cKDTree

def deviation(source: trimesh.Trimesh, simplified: trimesh.Trimesh, n=200_000):
    pts, _ = trimesh.sample.sample_surface(simplified, n)
    tree = cKDTree(source.vertices)
    d, _ = tree.query(pts, k=1)
    worst = pts[np.argsort(d)[-n // 100:]]
    _, exact, _ = trimesh.proximity.closest_point(source, worst)
    return float(exact.max()), float(np.percentile(d, 50)), float(np.percentile(d, 95))

src = trimesh.load("building_block.ply", force="mesh")
for name, path in (("QEM", "qem.ply"), ("clustering", "clustered.ply")):
    m = trimesh.load(path, force="mesh")
    hmax, p50, p95 = deviation(src, m)
    print(f"{name:<12} faces {len(m.faces):>8,} | Hausdorff {hmax:6.3f} m "
          f"| p50 {p50:6.4f} | p95 {p95:6.4f}")
```

The p50 will be similar between the two and the Hausdorff will not. That gap is the entire comparison: clustering's typical error is competitive and its worst case is bounded only by the cell diagonal, which is exactly where the corners were.

### 3. Time them, because the difference is large

```python
import time
import open3d as o3d

def timed(fn, rounds=3):
    ts = []
    for _ in range(rounds):
        t0 = time.perf_counter()
        out = fn()
        ts.append(time.perf_counter() - t0)
    return min(ts), out

t_qem, _ = timed(lambda: mesh.simplify_quadric_decimation(len(mesh.triangles) // 8))
t_vc, _ = timed(lambda: mesh.simplify_vertex_clustering(0.35))
print(f"QEM {t_qem:6.2f}s | clustering {t_vc:6.2f}s | ratio {t_qem / t_vc:.0f}x")
```

The ratio is typically ten to thirty on a mesh of a few million faces, and it grows with size because QEM maintains a priority queue over edges while clustering is a single pass. On a city where every building is decimated independently the absolute difference is minutes; on a terrain patch of a hundred million faces it is the difference between an hour and three minutes.

<figure class="diagram">
<svg viewBox="5 42 730 214" role="img" aria-labelledby="dc-trade-t dc-trade-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dc-trade-t">The measured trade on one building block</title>
  <desc id="dc-trade-d">At the same face count, quadric error collapse takes eighteen times as long as vertex clustering and holds the worst-case deviation to five centimetres against clustering's twenty-nine. The median deviations are nearly identical, so an average-based comparison would report the two as equivalent.</desc>
  <rect class="svg-bg" x="5" y="42" width="730" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="52" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="94" width="440" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="140" width="90" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="178" width="16" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="122" y="75">time: clustering 0.9 s</text>
    <text x="510" y="113">time: QEM 16.2 s</text>
    <text x="160" y="159">Hausdorff: clustering 0.29 m</text>
    <text x="86" y="197">Hausdorff: QEM 0.05 m</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Median deviation was 0.011 m for both — which is why a comparison on the mean concludes there is nothing to choose</text>
</svg>
<figcaption>Eighteen times the runtime for six times the worst-case accuracy. Which side of that trade is right depends entirely on whether the mesh has corners worth keeping.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="15 24 710 236" role="img" aria-labelledby="dc-cell-t dc-cell-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dc-cell-t">The cell size has to be smaller than the smallest gap, not the smallest feature</title>
  <desc id="dc-cell-d">A clustering cell that spans a light well merges the two walls either side of it into one surface, because both sets of vertices fall in the same cell and are replaced by one representative. The constraint is therefore the narrowest gap in the geometry, which in dense urban blocks is tighter than any feature-size rule would suggest.</desc>
  <rect class="svg-bg" x="15" y="24" width="710" height="236" fill="#ffffff"/>
  <path d="M60 70 h70 v130 h-70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M160 70 h70 v130 h-70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M126 66 h108 v20 h-108 Z" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="145" y="222" fill="#5b6471" font-size="11.5" text-anchor="middle">0.3 m light well</text>
  <path d="M420 70 h180 v130 h-180 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="510" y="222" fill="#b0413e" font-size="11.5" text-anchor="middle">welded into one wall</text>
  <text x="145" y="52" fill="#1f6b8a" font-size="12.5" text-anchor="middle">source</text>
  <text x="510" y="52" fill="#b0413e" font-size="12.5" text-anchor="middle">clustered at 0.35 m</text>
  <text x="370" y="242" fill="#15384a" font-size="12.5" text-anchor="middle">Both walls survive at a 0.25 m cell and merge at 0.35 — the threshold is the gap, and nothing in the output reports it</text>
</svg>
<figcaption>The merge is silent, watertight and topologically valid. Only a comparison against the source finds it, which is why the cell size has to come from measuring the gaps.</figcaption>
</figure>

### 4. Use clustering where its weakness does not apply

Terrain, vegetation and organic photogrammetry have no creases to protect, so clustering's rounding costs nothing and its speed is free.

```python
import open3d as o3d

def decimate(mesh, kind, target_faces=None, cell=None):
    if kind == "structured":               # buildings, infrastructure, anything with edges
        return mesh.simplify_quadric_decimation(target_number_of_triangles=target_faces)
    return mesh.simplify_vertex_clustering(   # terrain, canopy, rubble
        voxel_size=cell,
        contraction=o3d.geometry.SimplificationContraction.Quadric)

terrain = decimate(terrain_mesh, "organic", cell=0.5)
building = decimate(building_mesh, "structured", target_faces=12_000)
```

The `Quadric` contraction option is worth setting even in clustering: it places each cell's representative at the quadric-optimal position rather than at the centroid, which recovers a useful fraction of the corner fidelity for almost no extra time.

### 5. Hit a triangle budget with clustering by searching the cell size

Where clustering is the right algorithm but the pipeline needs a budget, a short bisection gets there.

```python
def cluster_to_budget(mesh, target_faces, lo=0.05, hi=5.0, tol=0.05, max_iter=12):
    for _ in range(max_iter):
        mid = (lo + hi) / 2
        out = mesh.simplify_vertex_clustering(voxel_size=mid)
        n = len(out.triangles)
        if abs(n - target_faces) / target_faces < tol:
            return out, mid
        lo, hi = (lo, mid) if n < target_faces else (mid, hi)
    return out, mid

out, cell = cluster_to_budget(terrain_mesh, 40_000)
print(f"{len(out.triangles):,} faces at cell {cell:.3f} m")
```

Twelve iterations of a single-pass algorithm is still far cheaper than one QEM run, so the search does not erase the speed advantage.

## Expected Output & Verification

A representative comparison on a photogrammetric building block:

```text
source      1,842,116 triangles
QEM           230,264
clustering    228,911
QEM          faces  230,264 | Hausdorff  0.051 m | p50 0.0108 | p95 0.0294
clustering   faces  228,911 | Hausdorff  0.291 m | p50 0.0112 | p95 0.0381
QEM  16.24s | clustering  0.91s | ratio 18x
```

The near-identical p50 and the six-fold gap in Hausdorff is the result to expect and the reason to report the worst case. Verify further by locating where clustering's worst error landed — it will be on a corner, a parapet or a window reveal, and confirming that is what turns the number into a decision rather than a statistic.

```python
import numpy as np
pts, _ = trimesh.sample.sample_surface(trimesh.load("clustered.ply", force="mesh"), 200_000)
_, d, _ = trimesh.proximity.closest_point(src, pts)
print("worst error at:", np.round(pts[np.argmax(d)], 2))
```

## Common Errors

**Clustering welds two walls into one.** The cell size exceeded the gap between them — a light well, a party wall, a narrow alley. Cell size has to be smaller than the smallest gap you need preserved, which on dense urban geometry is a tighter constraint than the feature size.

**QEM leaves a triangle count far above the target.** The mesh is not manifold, so many collapses are refused. Merge vertices and repair topology first; QEM on a triangle soup barely decimates at all.

**Both algorithms destroy UV seams.** Neither is attribute-aware by default. Lock the seams or split on UV islands first, as in [preserving UV seams during mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/).

**The Hausdorff figure is enormous for both.** The comparison is against the wrong source, or the meshes are on different origins. Check that both bound boxes coincide before believing any deviation number.

## Frequently Asked Questions

### Can I use clustering as a pre-pass before QEM?
Yes, and on very large meshes it is the practical approach: cluster at a fine cell to remove the bulk of the redundancy cheaply, then run QEM to the budget on the much smaller result. The combined error is bounded by the sum, so measure it rather than assuming.

### Does clustering preserve topology?
Not reliably. Cells that contain parts of two disconnected surfaces merge them, which creates non-manifold edges. Run a topology check afterwards rather than assuming the output is as clean as the input.

### Which one do the tile pipelines use?
Most use QEM, because tilesets are budget-driven and QEM accepts a budget directly. Clustering appears in terrain pipelines and as a pre-pass, where speed is the constraint and the geometry has no creases to lose.

A closing practical note. Because the two algorithms are parameterised differently — a budget against a resolution — a pipeline that uses both needs a single place where that difference is reconciled, or the two paths drift apart in what they guarantee. The arrangement that holds up is to make the pipeline's contract a *maximum deviation* rather than a triangle count: QEM accepts it directly through a bisection on the budget, clustering accepts it through a bisection on the cell size, and both then report the same kind of number to whatever consumes the mesh.

That also makes the choice between them reversible. A terrain patch that starts on clustering and later turns out to contain a retaining wall worth keeping can move to QEM without renegotiating the budget, because the contract was never expressed in triangles.

## Related Guides

- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — budgets, error bounds and the LOD chain
- [Preserving UV Seams During Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/) — the attribute problem both algorithms share
- [Computing Geometric Error for 3D Tiles Levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) — where the measured deviation is consumed

Back to [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).
