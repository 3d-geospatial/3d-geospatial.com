---
title: "Poisson Surface Reconstruction Parameters"
description: "Tune Poisson surface reconstruction in Open3D: depth, point_weight, samples_per_node, linear_fit, and density trimming for LiDAR and UAV digital twins."
---
# Poisson Surface Reconstruction Parameters for Geospatial Meshes

This page shows how to tune the Poisson surface reconstruction parameters in `open3d` — `depth`, `point_weight`, `samples_per_node`, `scale`, `linear_fit`, and density-based trimming — to turn an oriented LiDAR or UAV photogrammetry point cloud into a watertight, manifold mesh for a digital twin. The screened Poisson solver fits an implicit indicator function to your points' oriented normals, then extracts an isosurface from an adaptive octree. Get the parameters wrong and you ship floating "balloon" fragments around the model, over-smoothed rooflines, or a vertex count that stalls 3D Tiles streaming.

## Why you hit this

`create_from_point_cloud_poisson` always returns a closed surface, even where you have no data. That is the algorithm's strength — it never leaves holes — and its trap: it inflates a smooth shell across every gap, so a cloud with a sparse rear facade or a vehicle-occluded courtyard comes back with bulging geometry that does not match reality. The fix is not a different algorithm but the right combination of `depth` (how fine the octree resolves), `point_weight` (how hard the surface is pulled onto the points), `samples_per_node` (how many points constrain each leaf), and a post-hoc `density` trim that deletes the low-confidence vertices the solver invented. The same four knobs move in opposite directions for crisp infrastructure versus organic terrain, so there is no single default that survives across datasets.

## Prerequisites

- `open3d` 0.18+ and `numpy` 1.24+ (`pip install open3d numpy`), Python 3.9+.
- An input cloud already filtered for outliers (see [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/)) and reprojected to a **metric** CRS. Poisson works in local Cartesian space, so reproject WGS84 / EPSG:4326 to a projected metric system such as EPSG:32633 (UTM 33N) and subtract the dataset centroid before solving — absolute coordinates above 10⁶ m cause octree quantization error and solver drift.
- **Oriented normals are mandatory.** Poisson reconstructs from the normal field, not the raw points. Every point needs a unit normal whose direction is globally consistent (all pointing "outward"). A cloud without normals, or with normals that flip between adjacent patches, produces a torn, non-manifold surface regardless of how you tune the rest.

<figure class="diagram">
<svg viewBox="0 0 720 210" role="img" aria-labelledby="psr-flow-t psr-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="psr-flow-t">Poisson reconstruction parameter flow</title>
  <desc id="psr-flow-d">An oriented point cloud feeds the Poisson solver, which is shaped by depth, point_weight and samples_per_node, then a density quantile trim removes low-confidence vertices to yield a watertight mesh.</desc>
  <defs>
    <marker id="psr-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="14" y="70" width="150" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="244" y="70" width="170" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="494" y="70" width="150" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#psr-arrow)">
    <line x1="164" y1="105" x2="242" y2="105"/>
    <line x1="414" y1="105" x2="492" y2="105"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="89" y="100"><tspan x="89" dy="0">Oriented</tspan><tspan x="89" dy="16">point cloud</tspan></text>
    <text x="329" y="92"><tspan x="329" dy="0">Poisson solver</tspan><tspan x="329" dy="16">depth · point_weight</tspan><tspan x="329" dy="16">samples_per_node</tspan></text>
    <text x="569" y="92"><tspan x="569" dy="0">Density trim</tspan><tspan x="569" dy="16">quantile mask</tspan><tspan x="569" dy="16">watertight mesh</tspan></text>
  </g>
</svg>
<figcaption>The four tuning levers and where the density trim removes invented geometry.</figcaption>
</figure>

## Step-by-Step

### 1. Estimate and orient normals

Set the normal search radius to roughly 3–5× the average point spacing. For a 5 cm-spacing UAV cloud that is `radius=0.2`; for a 50 cm aerial LiDAR cloud, `radius=2.0`. `orient_normals_consistent_tangent_plane` propagates a consistent direction across the cloud using a minimum-spanning-tree walk over the k-nearest graph.

```python
import open3d as o3d
import numpy as np

pcd = o3d.io.read_point_cloud("facade_utm33n_centered.ply")
assert not pcd.is_empty(), "empty or unreadable point cloud"

# radius ~= 4x mean spacing; tune per sensor (here, 0.2 m for ~5 cm UAV spacing)
pcd.estimate_normals(
    search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.2, max_nn=30)
)
pcd.orient_normals_consistent_tangent_plane(k=15)
assert pcd.has_normals(), "normals required before Poisson reconstruction"
```

### 2. Run the solver and tune `depth`

`depth` is the maximum octree depth and the single biggest lever. Each increment halves the finest voxel edge, so vertex count and memory grow roughly cubically — node count scales as O(2^(3×depth)). Use `depth=8` as a baseline, `depth=9` for city blocks, and `depth=11–12` only for bridge or pipe detail where you genuinely have the point density to support it. The function returns the mesh **and** a per-vertex `densities` array you need in step 4.

```python
mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    pcd, depth=9, width=0, scale=1.1, linear_fit=True, n_threads=-1
)
densities = np.asarray(densities)
print(f"vertices={len(mesh.vertices)} triangles={len(mesh.triangles)}")
```

### 3. Set `point_weight` (the `width` argument) and `samples_per_node`

In Open3D the screened-Poisson interpolation weight — what most documentation calls `point_weight` — is passed as `width` only when you leave the API's depth-driven sizing; the more portable control is the standalone Poisson library's `--pointWeight`. In the Open3D Python API, `samples_per_node` is a direct argument controlling the minimum number of points constraining each octree node. Raise `samples_per_node` to 5–15 for noisy SfM clouds so the solver averages out jitter; keep it near 1.5 for clean TLS where you want fidelity. `point_weight` near 4.0 preserves sharp curbs and rooflines; drop toward 2.0 when normals are noisy.

```python
mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    pcd,
    depth=9,
    width=0,               # let depth drive octree width
    scale=1.1,             # bounding-box padding; 1.1 limits balloon inflation
    linear_fit=True,       # least-squares normal fit — better for planar facades
    n_threads=-1,
)
densities = np.asarray(densities)
```

`linear_fit=True` enables a linear least-squares fit of the iso-value and noticeably sharpens planar infrastructure (roads, flat roofs, facades); leave it `False` for organic terrain where the extra sharpening just amplifies noise.

### 4. Trim low-confidence vertices by density quantile

`densities` records how many points supported each vertex. The balloon geometry the solver invents over gaps has the lowest density, so masking out a low quantile deletes it cleanly. Start at the 1st–4th percentile and inspect; raise it if hollow shells remain, lower it if you start eating real wall.

```python
q = np.quantile(densities, 0.03)          # drop the lowest-confidence 3%
mesh.remove_vertices_by_mask(densities < q)
mesh.remove_unreferenced_vertices()

mesh.remove_duplicated_vertices()
mesh.remove_duplicated_triangles()
mesh.remove_degenerate_triangles()
mesh.compute_vertex_normals()

o3d.io.write_triangle_mesh("facade_mesh.ply", mesh, write_ascii=False)
print(f"after trim: triangles={len(mesh.triangles)}")
```

### Parameter reference

| Parameter | Effect on the mesh | Typical range |
|-----------|--------------------|---------------|
| `depth` | Octree max depth — vertex density and solver granularity; memory ~O(2^(3×depth)). | 7–12 (8 baseline, 9 city blocks, 11–12 infrastructure detail) |
| `width` (`point_weight`) | Screened interpolation weight pulling the surface onto points. Higher keeps sharp edges; lower smooths and tolerates noisy normals. | 2.0–6.0 (4.0 default); `0` defers to depth |
| `samples_per_node` | Minimum points constraining each octree leaf. Higher averages out SfM noise; lower keeps fine detail. | 1.0–2.5 clean scans, 5–15 noisy SfM |
| `scale` | Reconstruction bounding-box padding relative to the cloud. Larger inflates balloon geometry in gaps. | 1.0–1.3 (1.1 typical) |
| `linear_fit` | Linear least-squares iso-fit. Sharpens planar facades/roads; amplifies noise on terrain. | `True` for built structure, `False` for terrain |
| density quantile | Post-solve trim threshold removing invented low-confidence vertices. | 0.01–0.05 |

## Expected Output & Verification

For a ~2 M-point cleaned facade at `depth=9`, expect on the order of 300 k–900 k triangles before trimming and a 5–20% vertex reduction after a 3% density trim. Check the density distribution and the topology explicitly rather than eyeballing the render:

```python
import numpy as np

print("density min/median/max:",
      densities.min(), np.median(densities), densities.max())
hist, edges = np.histogram(densities, bins=10)
print("histogram:", hist)        # left bins are the balloon vertices the trim removes

# topology sanity check
mesh.remove_non_manifold_edges()
print("vertices:", len(mesh.vertices), "triangles:", len(mesh.triangles))
print("edge-manifold:", mesh.is_edge_manifold(),
      "vertex-manifold:", mesh.is_vertex_manifold())
```

A healthy result has a clearly bimodal-leaning density histogram (a low spike of invented vertices, then the bulk of supported geometry), `is_edge_manifold()` returning `True`, and a triangle count that lands inside your tile budget. If `densities.min()` is far below the median and the lowest histogram bin holds thousands of vertices, the solver inflated significant gap geometry — raise the trim quantile.

## Common Errors

**`RuntimeError: [Open3D ERROR] ... PointCloud does not contain normals`** — you called `create_from_point_cloud_poisson` on a cloud with no normals. Run `estimate_normals` followed by `orient_normals_consistent_tangent_plane` (step 1) first; the solver cannot infer orientation on its own.

**Output mesh is a smooth bubble far larger than the scan** — normals are present but inconsistently oriented (flipping between patches), so the indicator function has no stable inside/outside. Re-run `orient_normals_consistent_tangent_plane` with a larger `k`, or for closed scanned objects use `orient_normals_towards_camera_location`. Lowering `scale` to 1.0–1.1 also curbs inflation.

**`std::bad_alloc` / the process is killed at high `depth`** — `depth=11–12` on a multi-million-point cloud can demand 16–32 GB of RAM because node count grows cubically. Downsample with `pcd.voxel_down_sample(voxel_size=0.05)`, tile the cloud into ~1 km² chunks, or drop to `depth=10` for regional-scale twins.

## Frequently Asked Questions

### How is `point_weight` related to Open3D's `width` argument?
Open3D's `create_from_point_cloud_poisson` does not expose a literal `point_weight`; the screened-Poisson interpolation weight is the `width` argument (and `--pointWeight` in Kazhdan's reference C++ tool). Passing `width=0` lets the octree `depth` drive node sizing, which is the common path. When you do set `width` explicitly, treat it like `point_weight`: higher pulls the surface harder onto the data, preserving sharp edges at the cost of amplifying noise.

### Why does my reconstruction fill holes I wanted left open?
Poisson always produces a closed, watertight surface — leaving holes is not an option it offers. The low-density "skin" it stretches across genuine gaps is exactly what the density quantile trim removes, so raise the quantile until the unwanted fill disappears. If you need true open boundaries, ball-pivoting or alpha shapes are better fits; compare them in [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).

### What CRS should the cloud be in before reconstruction?
A projected metric CRS with coordinates translated to the dataset centroid. Reproject EPSG:4326 to a UTM zone such as EPSG:32633, then subtract the mean XYZ so values stay near the origin. Solving in geographic degrees or with raw million-metre eastings produces octree quantization artifacts and unstable normals.

## Related Guides

- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — Delaunay, ball-pivoting, and Poisson trade-offs
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — outlier removal that precedes reconstruction
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — bring the dense Poisson mesh down to a polygon budget
- [Optimizing Mesh Triangle Count for Web](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — tile-budget targets for streaming
- [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) — the full processing section

Back to [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
