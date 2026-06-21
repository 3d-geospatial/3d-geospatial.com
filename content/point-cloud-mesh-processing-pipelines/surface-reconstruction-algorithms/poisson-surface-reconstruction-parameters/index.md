# Poisson Surface Reconstruction Parameters for Geospatial Meshes

**Poisson surface reconstruction parameters** control the implicit function solver that converts unoriented or partially oriented point clouds into watertight, manifold meshes. For digital twin and geospatial automation, tuning these values directly dictates topology quality, semantic segmentation accuracy, and 3D tile streaming performance. The three critical controls are `depth` (octree resolution), `width` (bounding-box expansion that indirectly affects sampling density), and `scale` (ratio by which the solver's bounding box extends beyond the point cloud extent). Start with `depth=8`, `width=0`, and `scale=1.1` for aerial LiDAR or UAV photogrammetry datasets. Increase `depth` for finer infrastructure detail, and lower the density quantile cutoff when normals are noisy or derived from uncalibrated SfM pipelines. The solver assumes locally consistent normals; improper parameterization produces non-manifold artifacts, floating fragments, or excessive smoothing of sharp architectural edges.

### Open3D Poisson API Parameters

The Open3D function `TriangleMesh.create_from_point_cloud_poisson` exposes the following parameters:

| Parameter | Default | Geospatial Range | Effect on Digital Twin Mesh |
|-----------|---------|------------------|-----------------------------|
| `depth` | 8 | 7–12 | Octree max depth. Controls vertex density and solver granularity. `depth=9` suits city blocks; `depth=11–12` required for bridge/pipe detail. Memory scales roughly as `O(8^depth)` octree nodes at full density. |
| `width` | 0 | 0–5 | Target width of the finest octree level (in world units). When `0`, the solver sets it automatically from the point cloud bounding box. Non-zero values allow coarser or finer leaf nodes independent of `depth`. |
| `scale` | 1.1 | 1.0–1.5 | Ratio by which the bounding box is expanded beyond the point cloud extent. Values above `1.3` encourage surface closure at boundaries but increase floating artifact area outside the data hull. |
| `linear_fit` | False | True/False | Enables linear least-squares normal fitting per octree cell. Improves planar infrastructure (roads, facades, flat roofs). Disable for organic or undulating terrain. |

### Density-Based Fragment Removal
A density array is returned alongside the mesh. Low-density vertices correspond to boundary regions where the solver extrapolated beyond real data. Remove them using a quantile threshold—typically the bottom 1–5%—to eliminate floating fragments without eroding valid geometry:

```python
vertices_to_remove = densities < np.quantile(densities, 0.01)
mesh.remove_vertices_by_mask(vertices_to_remove)
```

Raising this threshold (e.g., to `0.05`) aggressively prunes boundary artefacts at the cost of clipping legitimate surface edges. Keep enabled for urban scans with moving vehicles or sparse canopy returns; set to `0.0` only for controlled survey grids with complete coverage.

### Geospatial Tuning Guidelines

The Poisson solver reconstructs surfaces by solving a screened Poisson equation over an adaptive octree. When designing [Point Cloud & Mesh Processing Pipelines](/point-cloud-mesh-processing-pipelines/), parameter selection dictates downstream topology quality, semantic segmentation accuracy, and 3D tile streaming performance.

**Octree Depth (`depth`)** governs spatial resolution. Each increment roughly doubles linear voxel resolution, quadrupling memory consumption and solver time. For municipal-scale twins, cap at `depth=10` unless targeting sub-centimeter infrastructure. Beyond `depth=12`, floating-point precision degradation and solver divergence become common without coordinate normalization.

**Bounding Box Width (`width`)** allows explicit control over the finest-level leaf size in world units. Leave at `0` to let Open3D derive it from the point cloud extent. Specify a non-zero value when you need consistent voxel granularity across multiple scan sessions that differ in spatial extent.

**Scale Factor (`scale`)** controls how much the solver extends its octree past the point cloud bounds. Values of `1.1–1.2` are typical. Higher values encourage the solver to close surfaces near scan boundaries but generate more phantom triangles outside the real data region, requiring a tighter density cutoff.

**Normal Consistency** is non-negotiable. Poisson reconstruction fails catastrophically when normals flip across adjacent patches. Always run a normal re-orientation pass (e.g., minimum spanning tree propagation) before reconstruction. For algorithmic alternatives when normals are unreliable, review [Surface Reconstruction Algorithms](/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) to compare Delaunay, ball-pivoting, and screened Poisson trade-offs.

**Coordinate System Precision** must be addressed before solver execution. Poisson reconstruction operates in a local Cartesian coordinate system; always project WGS84/EPSG:4326 data to a metric CRS (e.g., EPSG:32633) and translate coordinates to the dataset centroid before running the solver. Large absolute coordinate values (>10⁶) cause octree quantization errors and solver instability.

### Working Python Implementation

The following snippet uses Open3D's `create_from_point_cloud_poisson` with accurate parameter mapping, normal estimation, and density-based cleanup. It is optimized for Python 3.9+ and geospatial point clouds under 50M points.

```python
import open3d as o3d
import numpy as np

def reconstruct_poisson_geospatial(
    pcd_path: str,
    depth: int = 8,
    scale: float = 1.1,
    linear_fit: bool = True,
    density_quantile: float = 0.01,
    output_path: str = "reconstructed_mesh.ply"
) -> o3d.geometry.TriangleMesh:
    """
    Run Poisson surface reconstruction optimized for geospatial/digital twin data.

    Open3D API mapping:
      depth          -> controls octree resolution (primary quality lever)
      width          -> leaf node size in world units (0 = auto from bounding box)
      scale          -> bounding box expansion ratio (1.1 is a safe default)
      linear_fit     -> enables linear normal fitting per octree cell
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

    # 2. Run Poisson solver with documented Open3D parameters
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd,
        depth=depth,
        width=0,           # 0 = derive leaf size automatically from extent
        scale=scale,
        linear_fit=linear_fit
    )

    # 3. Density-based fragment removal
    if density_quantile > 0:
        vertices_to_remove = densities < np.quantile(densities, density_quantile)
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
- **Downstream Compatibility:** Export to `.ply` or `.obj` for GIS ingestion. For real-time streaming, convert to 3D Tiles using `py3dtiles` after validating manifold topology with `trimesh.is_watertight`.
- **Solver Theory:** The screened Poisson formulation minimizes the difference between the gradient of the indicator function and the input normal field. For mathematical details, see the original [Screened Poisson Surface Reconstruction paper (Kazhdan & Hoppe, SGP 2013)](https://dl.acm.org/doi/10.1145/2487228.2487237) and the official [Open3D Poisson API documentation](https://www.open3d.org/docs/latest/python_api/open3d.geometry.TriangleMesh.html#open3d.geometry.TriangleMesh.create_from_point_cloud_poisson).
