---
title: "Poisson Surface Reconstruction Parameters"
description: "Tune Poisson surface reconstruction for geospatial meshes: depth, point_weight, samples_per_node settings for LiDAR, UAV, and infrastructure digital twins."
---
# Poisson Surface Reconstruction Parameters for Geospatial Meshes

**Poisson surface reconstruction parameters** control the implicit function solver that converts unoriented or partially oriented point clouds into watertight, manifold meshes. For digital twin and geospatial automation, tuning these values directly dictates topology quality, semantic segmentation accuracy, and 3D tile streaming performance. The three critical controls are `depth` (octree resolution), `point_weight` (normal confidence scaling), and `samples_per_node` (surface sampling density). Start with `depth=8`, `point_weight=4.0`, and `samples_per_node=1.5` for aerial LiDAR or UAV photogrammetry datasets. Increase `depth` logarithmically for infrastructure-scale detail, and lower `point_weight` when normals are noisy or derived from uncalibrated SfM pipelines. The solver assumes locally consistent normals; improper parameterization produces non-manifold artifacts, floating fragments, or excessive smoothing of sharp architectural edges.

### Parameter Reference & Geospatial Tuning

| Parameter | Default | Geospatial Range | Effect on Digital Twin Mesh |
|-----------|---------|------------------|-----------------------------|
| `depth` | 8 | 7–12 | Octree max depth. Controls vertex density and solver granularity. `depth=9` suits city blocks; `depth=11–12` required for bridge/pipe detail. Memory scales cubically with depth (`O(2^(3×depth))` nodes). |
| `point_weight` | 4.0 | 2.0–6.0 | Scales attraction to input points. Higher values preserve sharp rooflines and curb edges but amplify LiDAR multipath noise. Lower values smooth vegetation/ground transitions. |
| `samples_per_node` | 1.5 | 1.0–2.5 | Controls surface extraction density. `>1.5` increases triangle count without improving topology; `1.0` is optimal for GIS export (OBJ/GLTF/3D Tiles). |
| `linear_fit` | False | True/False | Enables linear least-squares normal fitting. Critical for planar infrastructure (roads, facades, flat roofs). Disable for organic terrain. |
| `density_filter` | True | True/False | Removes low-confidence fragments. Keep enabled for urban scans with moving vehicles or sparse canopy returns. Disable only for controlled survey grids. |

### Geospatial Tuning Guidelines

The Poisson solver reconstructs surfaces by solving a screened Poisson equation over an adaptive octree. When designing [Point Cloud & Mesh Processing Pipelines](/point-cloud-mesh-processing-pipelines/), parameter selection dictates downstream topology quality, semantic segmentation accuracy, and 3D tile streaming performance. 

**Octree Depth (`depth`)** governs spatial resolution. Each increment doubles the voxel edge length, quadrupling memory consumption and solver time. For municipal-scale twins, cap at `depth=10` unless targeting sub-centimeter infrastructure. Beyond `depth=12`, floating-point precision degradation and solver divergence become common without coordinate normalization.

**Point Weight (`point_weight`)** acts as a regularization term balancing data fidelity against smoothness. High-confidence TLS scans tolerate `point_weight=5.0–6.0`. UAV photogrammetry with inconsistent normals or reflective surfaces (glass, water) should drop to `2.5–3.5` to prevent overfitting to noise.

**Sampling Density (`samples_per_node`)** determines how many triangles are extracted per octree leaf. Values above `2.0` rarely improve geometric accuracy but drastically inflate file sizes. For 3D Tiles or Cesium streaming, `1.0–1.5` yields optimal LOD generation without sacrificing silhouette fidelity.

**Normal Consistency** is non-negotiable. Poisson reconstruction fails catastrophically when normals flip across adjacent patches. Always run a normal re-orientation pass (e.g., minimum spanning tree propagation) before reconstruction. For algorithmic alternatives when normals are unreliable, review [Surface Reconstruction Algorithms](/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) to compare Delaunay, ball-pivoting, and screened Poisson trade-offs.

**Coordinate System Precision** must be addressed before solver execution. Poisson reconstruction operates in a local Cartesian coordinate system; always project WGS84/EPSG:4326 data to a metric CRS (e.g., EPSG:32633) and translate coordinates to the dataset centroid. Large absolute coordinate values (>10⁶) cause octree quantization errors and solver instability.

### Working Python Implementation

The following snippet uses Open3D's `create_from_point_cloud_poisson` with explicit parameter mapping, normal estimation, and density-based cleanup. It is optimized for Python 3.9+ and geospatial point clouds under 50M points. Note that Open3D maps `point_weight` to the `width` argument and controls sampling density via `scale` and octree depth.

```python
import open3d as o3d
import numpy as np

def reconstruct_poisson_geospatial(
    pcd_path: str,
    depth: int = 8,
    point_weight: float = 4.0,
    samples_per_node: float = 1.5,
    linear_fit: bool = True,
    density_threshold: float = 0.01,
    output_path: str = "reconstructed_mesh.ply"
) -> o3d.geometry.TriangleMesh:
    """
    Run Poisson surface reconstruction optimized for geospatial/digital twin data.
    Maps conceptual parameters to Open3D's API:
      - point_weight -> width (regularization strength)
      - samples_per_node -> implicit via scale & depth
    """
    pcd = o3d.io.read_point_cloud(pcd_path)
    if pcd.is_empty():
        raise ValueError(f"Point cloud at {pcd_path} is empty or unreadable.")

    # 1. Estimate & orient normals if missing
    if not pcd.has_normals():
        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.5, max_nn=30)
        )
        pcd.orient_normals_consistent_tangent_plane(k=15)

    # 2. Run Poisson solver
    # Open3D 'scale' parameter controls bounding box expansion, indirectly affecting sampling density
    scale_factor = 1.0 + (samples_per_node - 1.0) * 0.2
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd,
        depth=depth,
        width=point_weight,
        scale=scale_factor,
        linear_fit=linear_fit
    )

    # 3. Density-based fragment removal
    if density_threshold > 0:
        vertices_to_remove = densities < np.quantile(densities, density_threshold)
        mesh.remove_vertices_by_mask(vertices_to_remove)
        mesh.remove_unreferenced_vertices()

    # 4. Cleanup & export
    mesh.compute_vertex_normals()
    mesh.remove_duplicated_vertices()
    mesh.remove_duplicated_triangles()
    mesh.remove_degenerate_triangles()

    o3d.io.write_triangle_mesh(output_path, mesh, write_ascii=False)
    print(f"Exported {len(mesh.triangles)} triangles to {output_path}")
    return mesh
```

### Precision & Pipeline Integration Notes

- **Memory Limits:** `depth=12` typically requires 16–32 GB RAM for 10M+ points. Use chunked processing or downsample to `depth=10` for regional-scale twins.
- **Normal Estimation Radius:** Set `radius` in `estimate_normals` to 3–5× the average point spacing. Overly large radii blur architectural edges; overly small radii amplify sensor noise.
- **Downstream Compatibility:** Export to `.ply` or `.obj` for GIS ingestion. For real-time streaming, convert to 3D Tiles using `py3dtiles` or `Cesium ion` after validating manifold topology with `trimesh.is_watertight`.
- **Solver Theory:** The screened Poisson formulation minimizes the difference between the gradient of the indicator function and the input normal field. For mathematical details, see the original [Screened Poisson Surface Reconstruction paper (Kazhdan et al., SGP 2006)](https://www.cs.jhu.edu/~misha/MyPapers/SGP06.pdf) and the official [Open3D Poisson API documentation](https://www.open3d.org/docs/latest/python_api/open3d.geometry.TriangleMesh.html#open3d.geometry.TriangleMesh.create_from_point_cloud_poisson).