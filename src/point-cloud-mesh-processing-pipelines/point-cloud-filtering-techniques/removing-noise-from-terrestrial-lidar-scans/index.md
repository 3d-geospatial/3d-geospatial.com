# Removing Noise from Terrestrial LiDAR Scans: Production Pipeline & Tuning Guide

**Removing noise from terrestrial LiDAR scans** requires a staged filtering pipeline that isolates sensor artifacts, atmospheric scatter, and multipath reflections before downstream mesh generation or digital twin ingestion. The most reliable production approach combines statistical outlier removal (SOR) with radius-based neighborhood filtering, followed by voxel grid downsampling to normalize point density. Implement this via Open3D or PDAL, ensuring coordinate reference system (CRS) integrity and preserving structural edges critical for infrastructure modeling. Avoid single-pass aggressive filters; they erase fine architectural details and degrade registration accuracy.

### Noise Taxonomy & Filtering Strategy
Terrestrial laser scanners (TLS) generate three primary noise categories that require distinct handling:
- **Atmospheric/Particulate Scatter:** Rain, fog, or dust creates sparse, randomly distributed points with high variance in return intensity.
- **Multipath/Edge Fringe:** Beam splitting at sharp corners, glass facades, or metallic surfaces produces ghost points offset from true geometry.
- **Sensor/Registration Artifacts:** Misaligned scan stations, IMU drift, or target misplacement introduce systematic planar offsets or striping.

Addressing these requires [Point Cloud Filtering Techniques](/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) that balance aggressive cleanup with geometric fidelity preservation. A robust pipeline processes data sequentially: SOR removes global statistical outliers, radius filtering eliminates isolated clusters, and voxel downsampling enforces uniform sampling density. For digital twin automation, preserve intensity and RGB attributes during filtering to support material classification downstream.

### Production Pipeline (Python/Open3D)
The following script implements a memory-aware, parameterized cleaning routine optimized for structural and urban infrastructure scans. It includes validation, sequential filtering, and normal estimation for subsequent meshing. Open3D natively handles PLY/OBJ formats; for LAS/LAZ workflows with strict CRS requirements, pipe data through PDAL before ingestion.

```python
import open3d as o3d
import sys

def clean_terrestrial_lidar(input_path, output_path, 
                            sor_k=20, sor_std=2.0,
                            radius=0.05, min_neighbors=10,
                            voxel_size=0.01):
    """
    Removes noise from terrestrial LiDAR scans using SOR + Radius + Voxel filtering.
    Preserves RGB/Intensity attributes when present.
    Compatible with PLY/OBJ/XYZ formats. Use PDAL for LAS/LAZ + CRS transforms.
    """
    print(f"Loading: {input_path}")
    pcd = o3d.io.read_point_cloud(input_path)
    if not pcd.has_points():
        raise ValueError("Empty point cloud loaded. Verify file path and format.")
    
    original_count = len(pcd.points)
    print(f"Initial points: {original_count:,}")

    # 1. Statistical Outlier Removal (global scatter/atmospheric noise)
    print("Applying SOR...")
    cl_sor, ind_sor = pcd.remove_statistical_outlier(nb_neighbors=sor_k, std_ratio=sor_std)
    pcd = pcd.select_by_index(ind_sor)
    print(f"Post-SOR points: {len(pcd.points):,} ({len(pcd.points)/original_count:.1%} retained)")

    # 2. Radius Outlier Removal (isolated clusters/multipath fringe)
    print("Applying Radius Filter...")
    cl_rad, ind_rad = pcd.remove_radius_outlier(nb_points=min_neighbors, radius=radius)
    pcd = pcd.select_by_index(ind_rad)
    print(f"Post-Radius points: {len(pcd.points):,} ({len(pcd.points)/original_count:.1%} retained)")

    # 3. Voxel Downsampling (normalize density for meshing)
    print(f"Applying Voxel Grid (size={voxel_size}m)...")
    pcd = pcd.voxel_down_sample(voxel_size)
    print(f"Final points: {len(pcd.points):,}")

    # 4. Normal Estimation (prep for Poisson/TSDF meshing)
    print("Estimating normals...")
    pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(
        radius=voxel_size * 3, max_nn=30))
    pcd.orient_normals_consistent_tangent_plane(100)

    # Export
    o3d.io.write_point_cloud(output_path, pcd)
    print(f"Saved cleaned cloud to: {output_path}")
    return pcd

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python clean_lidar.py <input.ply> <output.ply>")
        sys.exit(1)
    clean_terrestrial_lidar(sys.argv[1], sys.argv[2])
```

### Parameter Tuning for TLS Data
Default parameters rarely generalize across varying scan resolutions or environmental conditions. Tune iteratively using a 10% data subset before full execution:
- **`sor_k` (Neighbors):** 15–30 for high-density TLS. Lower values increase false positives on thin edges like rebar or conduit.
- **`sor_std` (Std Dev Ratio):** 1.5–2.5. Values `<1.0` aggressively prune valid surface points; `>3.0` leaves atmospheric scatter intact. Reference the [Open3D Statistical Outlier Removal documentation](https://www.open3d.org/docs/release/tutorial/geometry/pointcloud.html#Statistical-Outlier-Removal) for algorithmic behavior.
- **`radius` & `min_neighbors`:** Set `radius` to 2–3× your target voxel size. `min_neighbors` should be 5–15 to remove floating debris without clipping architectural details.
- **`voxel_size`:** Match to your scanner’s nominal point spacing (typically 0.005–0.02 m for TLS). Oversampling degrades performance; undersampling blunts structural edges.

Validate output by overlaying the cleaned cloud against raw data in CloudCompare or QGIS. Check for missing façade details, stair nosings, or bolt heads. If critical features disappear, increase `sor_std` or reduce `voxel_size` before reprocessing.

### CRS Integrity & Downstream Integration
Open3D strips coordinate metadata during standard I/O. For geospatial workflows, maintain CRS integrity by transforming coordinates to a local projected system (e.g., UTM or State Plane) before filtering. PDAL’s `filters.reprojection` and `filters.outlier` modules handle LAS/LAZ natively while preserving GeoTIFF tags and ASPRS-compliant point records. See the [PDAL Outlier Filter documentation](https://pdal.io/en/latest/stages/filters.outlier.html) for parameter mapping.

After cleaning, export to PLY or LAZ for ingestion into [Point Cloud & Mesh Processing Pipelines](/point-cloud-mesh-processing-pipelines/) where Poisson surface reconstruction or Delaunay triangulation converts filtered points into watertight digital twins. Always retain intensity, RGB, and classification fields during filtering. These attributes drive downstream semantic segmentation and material mapping. When preparing for mesh generation, run `estimate_normals` with a search radius 2–3× your voxel size, then enforce consistent orientation using tangent-plane alignment. This prevents inverted faces and non-manifold geometry in automated reconstruction workflows.

For large-scale urban scans, chunk data into overlapping tiles, filter independently, and merge using ICP or feature-based registration. Monitor memory usage with `psutil` or Open3D’s `o3d.core.Tensor` backend to avoid swapping during radius calculations.