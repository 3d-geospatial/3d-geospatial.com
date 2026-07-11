# Surface Reconstruction Algorithms for Geospatial Digital Twins

Surface reconstruction turns an unstructured point cloud into a connected mesh you can render, query, and simulate against. The choice of algorithm is not cosmetic: feed the same building scan to Poisson, ball-pivoting (BPA), and a Delaunay alpha shape and you get three meshes with different watertightness, different noise behaviour, and different polygon counts. Pick the wrong one for your data and you spend the next week patching holes in facades or sanding off bubbles that the solver hallucinated. This guide shows how to reconstruct surfaces with [`open3d`](https://www.open3d.org/), how the three algorithm families trade off, and how to choose per data type — all on point clouds that already live in an explicit metric CRS such as EPSG:32618 (UTM zone 18N). For where this step sits in the wider workflow, see the [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) overview.

## Prerequisites

Reconstruction is unforgiving of bad inputs, so the contract for entering this stage is strict:

- **Tooling:** `open3d>=0.17` (the `create_from_point_cloud_poisson` and `create_from_point_cloud_ball_pivoting` APIs and the density return are stable from 0.17), plus `numpy>=1.24` and `scipy>=1.10` for the post-processing and nearest-neighbour spacing estimates. Install with `pip install "open3d>=0.17" "numpy>=1.24" "scipy>=1.10"`.
- **A projected, metric CRS — stated explicitly.** Every algorithm here measures distances and radii in the point cloud's own units, so the cloud must be in a metric projected system such as EPSG:32618 (UTM 18N) or EPSG:25832 (ETRS89 / UTM 32N), not geographic EPSG:4326. A radius of `0.05` means five centimetres in EPSG:32618; in EPSG:4326 it means 0.05 degrees — roughly 5.5 km — and the reconstruction silently collapses. Reproject before you reach this page; the mechanics are in [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/).
- **Oriented normals.** Poisson and BPA both consume per-point normals, and the orientation (which way "outward" points) matters as much as the direction. A cloud with consistent vectors but flipped orientation produces an inside-out surface. Normals are estimated and oriented as the first workflow step below.
- **A filtered cloud.** Outliers, vegetation returns, and birds become real triangles if you leave them in — implicit solvers cannot tell a measurement artefact from a wall. Run statistical outlier removal and ground classification first; see [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
- **Roughly uniform density**, ideally 10–20 points/m² for architectural and infrastructure features. BPA in particular fails on the sparse patches that occlusion leaves behind.

## Concept

The three algorithm families answer the same question — "what surface explains these points?" — with fundamentally different machinery, and that machinery is what determines whether you get a watertight shell or an open shell with honest holes.

**Poisson** treats the oriented normals as samples of a gradient field and solves a screened Poisson equation over an octree to recover an implicit indicator function; the mesh is the function's zero level-set. Because it fits a single continuous function, the output is always closed (watertight) and tolerates noise well — but it *extrapolates* into empty regions, inventing surface where there was no data (the "bubbles" you trim later). **Ball-pivoting (BPA)** is the opposite philosophy: a virtual ball of fixed radius rolls across the points and connects any three it touches without falling through. It only ever connects real points, so it never invents geometry — meaning it produces open surfaces with genuine holes wherever density drops below what the ball can bridge. **Delaunay / alpha shapes** compute a tetrahedralisation of the points and carve away simplices larger than the alpha radius, preserving sharp boundaries and explicit edges but rarely closing a surface without manual hole-filling.

So the trade-off is essentially: do you want a guaranteed-closed surface that may guess (Poisson), or a surface that only ever touches real data and leaves holes honest (BPA / alpha shapes)? Watertight terrain and building envelopes lean Poisson; CAD-aligned facades with crisp breaks lean alpha shapes; clean, uniformly sampled mechanical scans suit BPA.

The reason this matters in a geospatial twin specifically is that the *meaning* of a hole is data-dependent. For a flood or volumetrics model, a hole in a terrain surface is a defect — water leaks through it — so you want Poisson's guaranteed closure even at the cost of a few extrapolated triangles you trim afterwards. For an as-built inspection where the question is "what did the scanner actually measure?", an extrapolated Poisson bubble is a lie, and BPA's honest hole is the correct answer. The same point cloud therefore deserves a different algorithm depending on what the twin is *for*, which is why production pipelines key the algorithm choice off asset class rather than picking one solver globally.

<figure class="diagram">
<svg viewBox="0 0 860 320" role="img" aria-labelledby="recon-flow-t recon-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="recon-flow-t">Normals to reconstruct to trim flow, with three algorithm choices</title>
  <desc id="recon-flow-d">An oriented point cloud feeds a reconstruction stage offering three algorithms — Poisson which is watertight, ball pivoting which is open, and Delaunay alpha shapes which is open with sharp edges — and the result is trimmed and cleaned into a production mesh.</desc>
  <defs>
    <marker id="recon-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="15" y="120" width="150" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="690" y="120" width="155" height="80" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="270" y="20" width="320" height="74" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="270" y="123" width="320" height="74" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="270" y="226" width="320" height="74" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#recon-arrow)" fill="none">
    <path d="M165 150 L270 57"/>
    <path d="M165 160 L268 160"/>
    <path d="M165 170 L270 263"/>
    <path d="M590 57 L690 150"/>
    <path d="M590 160 L688 160"/>
    <path d="M590 263 L690 170"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="90" y="155"><tspan x="90" dy="0">Oriented</tspan><tspan x="90" dy="16">point cloud</tspan></text>
    <text x="430" y="50"><tspan x="430" dy="0">Poisson — screened equation</tspan><tspan x="430" dy="16">watertight, may extrapolate</tspan></text>
    <text x="430" y="153"><tspan x="430" dy="0">Ball pivoting (BPA)</tspan><tspan x="430" dy="16">open, only real points</tspan></text>
    <text x="430" y="256"><tspan x="430" dy="0">Delaunay / alpha shape</tspan><tspan x="430" dy="16">open, sharp edges</tspan></text>
    <text x="767" y="155"><tspan x="767" dy="0">Trim + clean</tspan><tspan x="767" dy="16">production mesh</tspan></text>
  </g>
</svg>
<figcaption>Reconstruction flow: oriented normals feed one of three algorithms (Poisson watertight, BPA or alpha-shape open), then trimming and cleanup produce the final mesh.</figcaption>
</figure>

| Algorithm | Watertight output | Noise tolerance | Best data |
|---|---|---|---|
| Poisson (screened) | Yes — always closed | High (averages noise into the field) | Terrain, building envelopes, organic/continuous surfaces |
| Ball-pivoting (BPA) | No — open, honest holes | Low (connects noise as real points) | Clean, uniformly sampled mechanical and CAD scans |
| Delaunay / alpha shape | No — needs hole-filling | Low–moderate | Facades with sharp breaks, explicit boundaries, footprints |

## Step-by-Step Workflow

The workflow below loads a filtered cloud already in EPSG:32618, estimates and orients normals, then reconstructs with both Poisson and BPA so you can compare on your own data before committing.

### 1. Load and downsample to uniform spacing

Reconstruction quality depends on roughly even point spacing. Voxel-downsample first so dense scan overlaps do not dominate the octree, and record the resulting spacing — BPA radii are derived from it.

```python
import open3d as o3d
import numpy as np

# Cloud is already filtered and in EPSG:32618 (UTM 18N, metres).
pcd = o3d.io.read_point_cloud("facade_filtered_epsg32618.ply")

voxel_size = 0.05  # 5 cm in EPSG:32618 metric units
pcd = pcd.voxel_down_sample(voxel_size)
print(f"{len(pcd.points)} points after voxel downsample")

# Mean nearest-neighbour spacing drives the BPA ball radii later.
dists = pcd.compute_nearest_neighbor_distance()
avg_spacing = float(np.mean(dists))
print(f"mean point spacing = {avg_spacing:.4f} m")
```

### 2. Estimate and orient normals

This is the prerequisite both solvers depend on. Estimate from a local neighbourhood, then *orient* consistently — direction alone is not enough.

```python
pcd.estimate_normals(
    search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=voxel_size * 4, max_nn=30)
)
# Propagate a consistent outward orientation across the cloud.
pcd.orient_normals_consistent_tangent_plane(k=30)
assert pcd.has_normals(), "normals missing — Poisson/BPA will fail"
```

### 3. Reconstruct with Poisson (watertight path)

`depth` sets the octree resolution; 9 suits most urban-scale data. Keep the per-vertex `densities` array — it drives the trim in the next step.

```python
mesh_poisson, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    pcd, depth=9, scale=1.1, linear_fit=False
)
densities = np.asarray(densities)
print(f"Poisson mesh: {len(mesh_poisson.triangles)} triangles")
```

### 4. Trim Poisson bubbles by density

Poisson invents surface in empty regions, and those triangles are supported by few input points — i.e. low density. Trim the lowest-density quantile to delete the bubbles without touching well-sampled walls.

```python
trim_quantile = 0.04  # raise toward 0.10 if bubbles persist
to_remove = densities < np.quantile(densities, trim_quantile)
mesh_poisson.remove_vertices_by_mask(to_remove)
mesh_poisson.remove_degenerate_triangles()
mesh_poisson.remove_duplicated_vertices()
mesh_poisson.remove_non_manifold_edges()
```

### 5. Reconstruct with ball-pivoting (open / sharp path)

BPA needs explicit radii in metres. A multi-radius list — anchored on the measured spacing — lets the ball bridge both dense and slightly sparser regions.

```python
radii = [avg_spacing * r for r in (1.5, 2.0, 3.0)]
mesh_bpa = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
    pcd, o3d.utility.DoubleVector(radii)
)
mesh_bpa.remove_degenerate_triangles()
mesh_bpa.remove_duplicated_vertices()
print(f"BPA mesh: {len(mesh_bpa.triangles)} triangles, "
      f"watertight={mesh_bpa.is_watertight()}")
```

### 6. Reconstruct with a Delaunay alpha shape (sharp-boundary path)

When the asset is a facade or footprint with crisp breaks, an alpha shape preserves the explicit edges that Poisson rounds off. `open3d` exposes it directly; `alpha` is a radius in metres, so it is anchored on the measured spacing for the same reason the BPA radii were.

```python
alpha = avg_spacing * 2.5  # metres in EPSG:32618; smaller = tighter to the points
mesh_alpha = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, alpha)
mesh_alpha.remove_degenerate_triangles()
mesh_alpha.remove_duplicated_vertices()
print(f"alpha-shape mesh: {len(mesh_alpha.triangles)} triangles, "
      f"watertight={mesh_alpha.is_watertight()}")
```

Expect `is_watertight()` to be `False` here — alpha shapes leave the open boundaries and concavities intact by design, which is exactly what makes them faithful to a flat facade. If you need closure, hole-fill afterwards rather than reaching for a larger `alpha`, which bridges across real gaps and reintroduces the over-smoothing you switched away from Poisson to avoid.

### 7. Persist with CRS provenance

`open3d` does not write CRS into PLY, so record EPSG:32618 in a sidecar so downstream tiling and decimation re-project against the right system.

```python
import json
o3d.io.write_triangle_mesh("facade_poisson_epsg32618.ply", mesh_poisson)
with open("facade_poisson_epsg32618.json", "w") as fh:
    json.dump({"crs": "EPSG:32618", "algorithm": "poisson",
               "depth": 9, "trim_quantile": trim_quantile}, fh)
```

## Validation & Verification

Never ship a reconstruction unvalidated. The checks below catch the defects that silently break ray-casting and simulation downstream.

```python
mesh = mesh_poisson
mesh.compute_vertex_normals()

# Poisson must be watertight; if not, the trim was too aggressive.
print("watertight:", mesh.is_watertight())
print("edge-manifold:", mesh.is_edge_manifold())
print("vertex-manifold:", mesh.is_vertex_manifold())

# Euler characteristic V - E + F = 2 for a closed genus-0 shell.
V = np.asarray(mesh.vertices).shape[0]
F = np.asarray(mesh.triangles).shape[0]
E = F * 3 // 2  # each triangle edge shared by exactly two faces when watertight
print("euler V-E+F =", V - E + F)

# Bounding box must match the source extent (no scale drift in EPSG:32618).
src = o3d.io.read_point_cloud("facade_filtered_epsg32618.ply")
assert np.allclose(mesh.get_axis_aligned_bounding_box().get_extent(),
                   src.get_axis_aligned_bounding_box().get_extent(), atol=0.5), \
    "bounding-box drift — check normal orientation / octree scale"
```

Expected values for a clean genus-0 Poisson shell: `is_watertight()` is `True`, both manifold checks are `True`, and `V - E + F` equals `2`. If `is_watertight()` is `False` after trimming, lower `trim_quantile` — over-aggressive trimming punches holes in the very shell you wanted closed. A `euler` value far from 2 signals handles or holes; the genus of the surface is `(2 - (V - E + F)) / 2`, so a Euler number of 0 means one handle (a tunnel through the mesh), which on a building usually traces back to two walls meeting through an occluded gap. Inspect with the BPA mesh, whose open boundaries make missing-data regions visible at a glance.

The bounding-box extents (in metres, EPSG:32618) should match the source cloud to within a voxel; a large mismatch almost always means flipped or inconsistent normals, because an inside-out Poisson surface balloons outward past the data. It is worth folding these assertions into the pipeline as a hard gate rather than a print, so a malformed tile fails the batch loudly instead of flowing downstream into [mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) and tiling, where the same defect is far more expensive to diagnose. For the full set of manifold and orientation rules these checks enforce, see [Mesh Topology Basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

## Performance & Scale

Poisson cost is dominated by octree `depth`: each increment roughly multiplies memory and runtime by up to 8x. Depth 9 on a few-million-point urban tile fits comfortably in 8–16 GB; depth 11 on the same data can exceed 32 GB. Treat depth as the primary memory dial and only raise it when validation shows you are losing real detail, not noise.

For city-scale runs, tile spatially — process ~250 m or ~1 km² blocks in EPSG:32618 independently, then merge — rather than reconstructing a whole municipality in one solve. Overlap tiles by a few metres and snap shared boundaries so seams do not open at tile edges. The overlap is not optional: Poisson's octree behaves differently near the convex hull of a tile, so a building straddling a tile boundary reconstructs cleanly only if both tiles see it with margin. A practical pattern is a 5 m skirt on every side, reconstruct, then clip each mesh back to the tile's true extent before merging so the skirt geometry is discarded and only one copy of each boundary feature survives.

BPA scales more gently with point count than Poisson scales with depth, but its KD-tree queries dominate; pre-downsampling to uniform spacing (step 1) is the single biggest BPA speed-up. As a rough benchmark on a 3-million-point urban tile in EPSG:32618, depth-9 Poisson runs in tens of seconds in single-digit gigabytes, depth-10 in a few minutes and 16–24 GB, and a three-radius BPA pass in roughly the same wall-clock as depth-9 Poisson but with far lower peak memory because there is no dense octree to hold. Checkpoint after the normal-estimation step: orientation via `orient_normals_consistent_tangent_plane` is expensive — it builds a Riemannian graph and a minimum spanning tree over the whole cloud — and caching the oriented cloud to disk lets you sweep `depth`, `trim_quantile`, and BPA radii without paying that cost again. When sweeping parameters across many tiles, parallelise with `multiprocessing`: each tile is independent, so reconstruction is embarrassingly parallel, and you can pin one worker per physical core without contention since the heavy work is CPU-bound rather than I/O-bound.

## Failure Modes & Gotchas

**Bad or unoriented normals produce inside-out or lumpy surfaces.** If `estimate_normals` runs but you skip `orient_normals_consistent_tangent_plane`, half the normals point inward and Poisson folds the surface back on itself. Symptom: a mesh that looks crumpled or whose faces flicker (back-faces showing). Fix: always orient, and increase the `k` in orientation propagation for noisy clouds. Verify with `mesh.is_orientable()` and a visual back-face check.

**Poisson bubbles in open or occluded areas.** Because Poisson always closes the surface, any region the scanner could not see gets filled with a smooth blob extrapolated from surrounding normals — classic on building undersides and behind street furniture. Fix: raise `trim_quantile` (0.04 → 0.10) to delete the low-density extrapolated vertices, or switch that asset class to BPA, which leaves the gap as an honest hole.

**Over-smoothing erases sharp architectural edges.** Poisson's continuous field rounds off corners, parapets, and window reveals, especially at low `depth`. Symptom: crisp facade breaks become soft ridges. Fix: increase `depth` for those tiles, or reconstruct facades with an alpha shape / BPA path that preserves explicit edges and reserve Poisson for terrain and organic surfaces.

**BPA produces a riddled, hole-filled mesh on sparse data.** A single ball radius cannot bridge density variation, so occluded or thinned regions drop out entirely. Symptom: a lacy mesh missing whole panels. Fix: supply a multi-radius list anchored on the measured `avg_spacing` (step 5), or upsample/re-register additional scans before reconstructing.

**Reconstructing in a geographic CRS collapses the mesh.** With the cloud in EPSG:4326, point spacing is ~1e-5 degrees and any metric radius or voxel size is meaningless — Poisson returns a degenerate blob and BPA returns nothing. Fix: confirm the cloud is in a metric projected CRS (EPSG:32618, EPSG:25832, etc.) before this stage and assert it in the sidecar metadata.

## Frequently Asked Questions

### When should I use Poisson versus ball-pivoting?

Use Poisson when you need a watertight surface for simulation or volumetrics and can tolerate (and trim) extrapolated bubbles — terrain, building envelopes, anything continuous. Use ball-pivoting when fidelity to real measurements matters more than closure and your data is clean and uniformly sampled — mechanical parts, CAD-aligned scans — and you would rather see an honest hole than a guessed surface. For watertight requirements on noisy LiDAR, Poisson is almost always the right default.

### Why is my Poisson mesh full of balloon-like bubbles?

Those are regions Poisson extrapolated into empty space because it must close the surface. They are supported by very few input points, so they show up as low values in the `densities` array returned by `create_from_point_cloud_poisson`. Trim them with a density quantile mask (step 4); start at `0.04` and raise toward `0.10` until the bubbles disappear without eating into well-sampled geometry.

### Do I really need oriented normals, or just normals?

Both algorithms need *oriented* normals — direction and a consistent outward sense. `estimate_normals` gives you directions but with arbitrary, locally inconsistent orientation. Without `orient_normals_consistent_tangent_plane`, Poisson can build an inside-out surface and BPA can pivot incorrectly. Orientation is the cheapest insurance against the most common reconstruction failure.

### What depth should I pass to Poisson?

`depth` controls octree resolution. 8–9 covers most municipal and urban datasets; go to 10 only when validation shows you are smoothing away real detail. Each step up roughly multiplies memory and time, and high depth overfits to noise, so raise it deliberately. Tile-specific tuning, the `scale` and `linear_fit` parameters, and density-trim interactions are covered in depth in [Poisson surface reconstruction parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/).

### How do I keep my reconstructed mesh in the right coordinate system?

`open3d` reconstructs in whatever units the input points carry and does not store a CRS in PLY/OBJ. If the cloud is in EPSG:32618, the mesh is too — but nothing in the file records that. Write a sidecar JSON declaring the EPSG code (step 6) and re-assert it before tiling or decimation, and validate bounding-box extents against the source to catch any scale drift.

## Related Guides

- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — depth, scale, and density-trim tuning in detail
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — outlier removal and classification before reconstruction
- [Automated Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — reduce reconstructed triangle counts to a polygon budget
- [Texture Mapping Workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — apply photogrammetry textures to the reconstructed mesh
- [Mesh Topology Basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — manifold rules and repair for the validation step

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
