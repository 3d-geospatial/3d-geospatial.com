---
title: "Ball Pivoting Reconstruction for Building Facades"
description: "Mesh building facades from terrestrial or mobile LiDAR with Open3D ball pivoting: uniform density, oriented normals, radii from spacing, cleanup and a fit check."
---
# Ball Pivoting Reconstruction for Building Facades

This page reconstructs building facade meshes from terrestrial or mobile-mapping LiDAR with Open3D's ball pivoting algorithm (BPA) — isolating the facade plane, evening out point density, orienting normals towards the street, deriving pivot radii from measured point spacing, cleaning the resulting mesh and checking its fit to the points, in a local frame offset from EPSG:32633.

## Why you hit this

Facades are where Poisson reconstruction is least suited to a digital twin. Poisson solves for a closed, smooth implicit surface, so it bridges every window and doorway, rounds off sills and reveals, and grows a balloon into the unscanned interior behind the glass. Ball pivoting does the opposite: it only connects points that are genuinely close, keeps sharp edges where the data has them, and leaves an opening where the scan has one — which, on a facade, is usually a window. Its weakness is sensitivity to density and normals, and both are controllable. The broader comparison of the two approaches is in [Poisson vs Delaunay surface reconstruction trade-offs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-vs-delaunay-surface-reconstruction-trade-offs/).

## Prerequisites

- `open3d>=0.18`, `laspy[lazrs]>=2.5`, `numpy>=1.24`.
- A classified, registered scan of the street in EPSG:32633 with heights in EGM2008 (EPSG:3855), noise already removed as in [removing noise from terrestrial LiDAR scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/).
- The scanner trajectory or at least the street centreline, used to orient normals.
- Point spacing on facades of 1–3 cm; BPA on sparser airborne facade returns produces fragments rather than surfaces.

## Step-by-Step

### 1. Isolate one facade and move to a local frame

```python
import laspy
import numpy as np
import open3d as o3d

las = laspy.read("street_42_mls.laz")
building = las.classification == 6
xyz = np.column_stack([las.x, las.y, las.z])[building]

origin = np.floor(xyz.min(axis=0))
pcd = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz - origin))

plane, inliers = pcd.segment_plane(distance_threshold=0.15, ransac_n=3, num_iterations=2000)
facade = pcd.select_by_index(inliers)
a, b, c, d = plane
print(f"{len(facade.points):,} facade points, plane normal ({a:.3f}, {b:.3f}, {c:.3f}), "
      f"verticality {abs(c):.3f}")
assert abs(c) < 0.05, "dominant plane is not vertical: a roof or the ground was picked"
```

Working one facade at a time keeps BPA's memory bounded and makes every later parameter — spacing, normal orientation, radii — a property of one surface rather than an average over a street. The 15 cm RANSAC threshold is generous on purpose: it collects window reveals, pilasters and balconies within a relief of 15 cm either side of the wall plane. Deeper features such as bay windows need a larger threshold or a second pass. The local origin is not optional; Open3D's reconstruction runs in double precision internally but several of its geometric predicates are tuned for coordinates near zero.

### 2. Even out density

```python
spacing_before = np.asarray(facade.compute_nearest_neighbor_distance())
facade = facade.voxel_down_sample(voxel_size=0.02)
spacing = np.asarray(facade.compute_nearest_neighbor_distance())
print(f"spacing before: median {np.median(spacing_before) * 100:.1f} cm, "
      f"p95 {np.percentile(spacing_before, 95) * 100:.1f} cm | after: median {np.median(spacing) * 100:.1f} cm, "
      f"p95 {np.percentile(spacing, 95) * 100:.1f} cm")
```

Mobile scans are dense near the ground floor and sparse at the eaves, and overlapping passes double the density in stripes. BPA picks one set of radii for the whole cloud, so uneven density leaves either holes in the sparse parts or a waste of triangles in the dense ones. A 2 cm voxel grid caps the density without inventing points; the spread between median and p95 spacing after downsampling is the number to watch, and it should shrink substantially.

<figure class="diagram">
<svg viewBox="21 34 708 220" role="img" aria-labelledby="bpa-piv-t bpa-piv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bpa-piv-t">How the ball pivots along a facade section</title>
  <desc id="bpa-piv-d">A cross-section of facade points. A ball of the chosen radius rests on two points and pivots around the edge between them until it touches a third point, creating a triangle. Where points are closer than the ball's diameter the ball keeps rolling and the surface continues. At a window opening, the gap is wider than the ball, so the ball falls through and the mesh leaves the opening open.</desc>
  <rect class="svg-bg" x="21" y="34" width="708" height="220" fill="#ffffff"/>
  <path d="M40 170 L110 168 L180 170 L250 168 L320 170" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M500 170 L570 168 L640 170 L710 168" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#1f2937">
    <circle cx="40" cy="170" r="5"/><circle cx="110" cy="168" r="5"/><circle cx="180" cy="170" r="5"/><circle cx="250" cy="168" r="5"/><circle cx="320" cy="170" r="5"/>
    <circle cx="500" cy="170" r="5"/><circle cx="570" cy="168" r="5"/><circle cx="640" cy="170" r="5"/><circle cx="710" cy="168" r="5"/>
  </g>
  <circle cx="215" cy="125" r="50" fill="none" stroke="#9a4f26" stroke-width="2"/>
  <circle cx="410" cy="125" r="50" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M410 180 V225" fill="none" stroke="#b0413e" stroke-width="2"/>
  <path d="M404 215 L410 225 L416 215" fill="none" stroke="#b0413e" stroke-width="2"/>
  <text x="215" y="62" fill="#9a4f26" font-size="12.5" text-anchor="middle">ball of radius r pivots</text>
  <text x="410" y="62" fill="#b0413e" font-size="12.5" text-anchor="middle">gap &gt; 2r: falls through</text>
  <text x="180" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">wall: triangles</text>
  <text x="600" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">wall: triangles</text>
  <text x="470" y="236" fill="#15384a" font-size="12.5" text-anchor="start">window: stays open</text>
</svg>
<figcaption>The largest radius sets the widest gap the surface will bridge. Keep it below the width of the openings that should stay open.</figcaption>
</figure>

### 3. Estimate normals and orient them towards the street

```python
facade.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.10, max_nn=30))

trajectory = np.loadtxt("street_42_trajectory.csv", delimiter=",", skiprows=1)[:, 1:4] - origin
tree = o3d.geometry.KDTreeFlann(o3d.geometry.PointCloud(o3d.utility.Vector3dVector(trajectory)))
pts = np.asarray(facade.points)
normals = np.asarray(facade.normals)
for i, p in enumerate(pts):
    _, idx, _ = tree.search_knn_vector_3d(p, 1)
    if np.dot(normals[i], trajectory[idx[0]] - p) < 0:
        normals[i] = -normals[i]
facade.normals = o3d.utility.Vector3dVector(normals)
```

BPA uses normals to decide which side of the surface the ball rolls on. Normals that flip between neighbouring points make the ball switch sides and abandon the surface, leaving a patchwork of small disconnected pieces. Orienting every normal towards the nearest trajectory position is exact for a facade scanned from the street, and much more reliable on a planar wall than Open3D's generic `orient_normals_consistent_tangent_plane`, which propagates orientation through a graph and can flip whole regions across a window.

### 4. Derive radii from spacing and reconstruct

```python
median_spacing = float(np.median(np.asarray(facade.compute_nearest_neighbor_distance())))
radii = [median_spacing * f for f in (1.5, 3.0, 6.0)]
print("radii (cm):", [round(r * 100, 1) for r in radii])

mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
    facade, o3d.utility.DoubleVector(radii)
)
print(f"{len(mesh.triangles):,} triangles from {len(facade.points):,} points")
```

Multiple radii run as successive passes: the smallest builds the surface wherever density is good, and each larger radius fills gaps the previous one left, pivoting only from the existing boundary. Starting at 1.5× the median spacing ensures a ball can rest on neighbouring points; stopping at 6× — 12 cm here — bridges missing returns on dark or wet patches while leaving a 60 cm window pane open. The largest radius is the one to tune, and the right value comes from the smallest opening that must stay open, not from a default.

It is worth measuring that opening rather than assuming it. Historic facades often have narrow slit windows, ventilation grilles or gaps between pilasters well under half a metre, and modern curtain walls may have no openings in the scan at all because glass returned a surface. A few measurements on the point cloud in any viewer, taken before the pipeline is configured for a district, set the upper bound for the radius list and avoid a whole street of bridged windows being discovered only after texturing.

### 5. Clean the mesh

```python
mesh.remove_degenerate_triangles()
mesh.remove_duplicated_triangles()
mesh.remove_duplicated_vertices()
mesh.remove_non_manifold_edges()

clusters, cluster_tris, _ = mesh.cluster_connected_triangles()
clusters, cluster_tris = np.asarray(clusters), np.asarray(cluster_tris)
small = cluster_tris[clusters] < 200
mesh.remove_triangles_by_mask(small)
mesh.remove_unreferenced_vertices()
mesh.compute_vertex_normals()
print(f"after cleanup: {len(mesh.triangles):,} triangles, edge-manifold {mesh.is_edge_manifold()}")
```

BPA produces a few non-manifold edges where two passes meet and a scatter of tiny islands around residual noise and reflections. Islands under 200 triangles — roughly 20 cm² at this density — are removed; on a facade they are almost never real geometry. The manifold check matters downstream, because decimation and UV unwrapping both assume it; the repair techniques for anything that survives are in [fixing non-manifold edges in 3D meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/).

<figure class="diagram">
<svg viewBox="6 6 748 248" role="img" aria-labelledby="bpa-vs-t bpa-vs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bpa-vs-t">A window bay reconstructed by ball pivoting and by Poisson</title>
  <desc id="bpa-vs-d">Two panels of the same window bay in cross-section. Ball pivoting follows the wall, the reveal and the sill with sharp corners and leaves the glass opening empty. Poisson reconstruction rounds the reveal and sill, spans the opening with a smooth membrane and bulges into the unscanned room behind it.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="248" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="190" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="190" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M60 60 H150 V90 H180" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M180 150 H150 V170 H320" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M440 60 H520 C535 60 540 70 540 90 C560 110 610 115 640 120 C610 125 560 130 540 150 C540 165 535 170 520 170 H700" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="44">ball pivoting</text>
    <text x="570" y="44">Poisson, depth 10</text>
    <text x="250" y="124">opening stays open</text>
    <text x="620" y="196">membrane bulges inward</text>
  </g>
  <text x="95" y="124" fill="#1f2937" font-size="12" text-anchor="middle">sharp reveal</text>
  <text x="190" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">faithful to what was measured</text>
  <text x="570" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">closed, smooth, partly invented</text>
</svg>
<figcaption>Neither result is wrong in general; for a facade that will be textured from street imagery, the measured openings are usually what the twin needs.</figcaption>
</figure>

## Expected Output & Verification

```text
512,338 facade points, plane normal (0.412, -0.911, 0.004), verticality 0.004
spacing before: median 0.8 cm, p95 3.9 cm | after: median 1.7 cm, p95 2.4 cm
radii (cm): [2.6, 5.1, 10.2]
806,114 triangles from 402,902 points
after cleanup: 791,560 triangles, edge-manifold True
```

Verify the fit rather than the triangle count. Measure the distance from every input point to the mesh with Open3D's raycasting scene, and report how many points are covered:

```python
tmesh = o3d.t.geometry.TriangleMesh.from_legacy(mesh)
scene = o3d.t.geometry.RaycastingScene()
scene.add_triangles(tmesh)
query = o3d.core.Tensor(np.asarray(facade.points), dtype=o3d.core.Dtype.Float32)
dist = scene.compute_distance(query).numpy()
print(f"point-to-mesh: median {np.median(dist) * 1000:.1f} mm, p95 {np.percentile(dist, 95) * 1000:.1f} mm, "
      f"covered within 1 cm {np.mean(dist < 0.01) * 100:.1f}%")
assert np.median(dist) < 0.003 and np.mean(dist < 0.01) > 0.95
```

BPA interpolates the points, so the median distance should be close to zero and the 95th percentile a few millimetres. Coverage is the more informative number: points farther than a centimetre from the mesh lie in regions the ball never reached, and if they cluster in one area of the wall — usually the upper storeys — the density there is below what the largest radius can bridge.

<figure class="diagram">
<svg viewBox="56 6 658 240" role="img" aria-labelledby="bpa-rad-t bpa-rad-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bpa-rad-t">Coverage and bridged openings against the largest radius</title>
  <desc id="bpa-rad-d">As the largest pivot radius grows from 3 to 30 centimetres, the share of points covered by the mesh rises from about 80 percent and plateaus near 98 percent at 10 centimetres. Meanwhile the number of window openings wrongly bridged stays at zero until about 20 centimetres and then climbs quickly. The useful setting is where coverage has plateaued and no openings are bridged.</desc>
  <rect class="svg-bg" x="56" y="6" width="658" height="240" fill="#ffffff"/>
  <path d="M70 20 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="250" y="20" width="160" height="160" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1"/>
  <polyline points="90,120 170,70 250,40 330,34 410,32 530,31 680,31" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="90,178 170,178 250,178 330,177 410,172 530,130 680,60" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="90" y="200">3 cm</text><text x="250" y="200">10 cm</text><text x="410" y="200">20 cm</text><text x="680" y="200">30 cm</text>
  </g>
  <text x="150" y="60" fill="#1f6b8a" font-size="12.5" text-anchor="end">coverage</text>
  <text x="600" y="84" fill="#b0413e" font-size="12.5" text-anchor="end">windows bridged</text>
  <text x="330" y="110" fill="#1f2937" font-size="12.5" text-anchor="middle">use this range</text>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">largest pivot radius, facade at 1.7 cm median spacing</text>
</svg>
<figcaption>Coverage saturates well before the radius reaches window size, which leaves a comfortable range where the wall is complete and the openings are not.</figcaption>
</figure>

## Common Errors

**The result is thousands of disconnected strips.** Normals are inconsistently oriented. Check the fraction of normals pointing towards the trajectory after step 3; anything short of nearly all means the trajectory is in a different frame from the points — typically the local origin was not subtracted from it.

**Reconstruction takes hours or exhausts memory.** The cloud was not downsampled and the largest radius is large relative to spacing, so every pivot searches thousands of neighbours. Downsample first and keep the largest radius under about eight times the spacing.

**Windows are bridged by thin, stretched triangles.** The largest radius exceeds half the width of the narrowest opening. Reduce it, or remove points classified as glass reflections behind the facade plane before reconstruction, since those give the ball something to land on inside the opening.

## Frequently Asked Questions

### Should I use BPA for whole buildings rather than single facades?

For full terrestrial scans of a building with roofs captured from a drone, yes, with per-surface density normalisation first. For airborne-only data, facades are too sparse and a model-driven approach — extruded footprints with roof shapes — gives better LOD2 geometry.

### How does BPA interact with texture mapping?

Well. Because vertices are the measured points, texture projection from co-registered street imagery lands where the camera saw the surface, without the offsets smoothing introduces. The alignment itself is covered in [aligning photogrammetry textures with point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/aligning-photogrammetry-textures-with-point-clouds/).

### Do I need to decimate the result?

Almost certainly. Nearly 800,000 triangles for one facade is right for analysis and far too many for streaming. Decimate with a planarity-aware method that preserves reveals and edges, then generate the LOD chain.

## Related Guides

- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — the closed-surface alternative
- [Preserving UV Seams During Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/) — reducing the mesh after texturing
- [Estimating Point Spacing for Mobile Mapping Scans](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/estimating-point-spacing-for-mobile-mapping-scans/) — the spacing the radii are derived from

Back to [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
