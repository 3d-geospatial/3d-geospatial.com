---
title: "Point Cloud & Mesh Processing Pipelines"
description: "End-to-end pipeline for digital twins: LiDAR filtering, surface reconstruction, mesh decimation, and texture mapping with PDAL, Open3D, and trimesh."
---
# Point Cloud & Mesh Processing Pipelines for Digital Twin Automation

A digital twin is born from a point cloud, but a raw cloud is nobody's idea of an analysis-ready asset. It carries scanner noise, vegetation, registration drift, redundant density, and not a single connected surface. The work of turning tens of millions of unstructured returns into a watertight, decimated, textured mesh that a browser can stream is the job of a **point cloud and mesh processing pipeline** — and it is where most digital twin programs either earn their reliability or quietly accumulate the defects that surface months later as leaking volumetrics and z-fighting facades.

This guide is written for digital twin engineers, GIS developers, and spatial Python practitioners who own the path from raw LiDAR or photogrammetry to a deployable 3D asset. It walks the full chain — filtering, surface reconstruction, decimation, and texture mapping — with runnable `PDAL`, `Open3D`, `laspy`, `trimesh`, `numpy`, and `scipy` code, explicit EPSG codes at every hand-off, and a production checklist and troubleshooting matrix you can lift directly into your own ingestion jobs. It assumes the inputs are already correct: a classified, density-validated cloud in an explicit metric CRS, the contract established by [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).

<figure class="diagram">
<svg viewBox="1 46 878 252" role="img" aria-labelledby="pcm-arch-t pcm-arch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pcm-arch-t">Point cloud to mesh processing pipeline</title>
  <desc id="pcm-arch-d">A raw point cloud passes through filtering, surface reconstruction, mesh decimation, and texture mapping, then exports to glTF and 3D Tiles for streaming; the fundamentals layer feeds the raw input and the LOD pipeline consumes the export.</desc>
  <rect class="svg-bg" x="1" y="46" width="878" height="252" fill="#ffffff"/>
  <defs>
    <marker id="pcm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="15" y="60" width="150" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="195" y="60" width="140" height="70" rx="8"/>
    <rect x="365" y="60" width="150" height="70" rx="8"/>
    <rect x="545" y="60" width="140" height="70" rx="8"/>
    <rect x="715" y="60" width="150" height="70" rx="8"/>
  </g>
  <rect x="300" y="220" width="290" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pcm-arrow)">
    <line x1="166" y1="95" x2="193" y2="95"/>
    <line x1="336" y1="95" x2="363" y2="95"/>
    <line x1="516" y1="95" x2="543" y2="95"/>
    <line x1="686" y1="95" x2="713" y2="95"/>
    <line x1="790" y1="131" x2="590" y2="222"/>
    <line x1="90" y1="131" x2="300" y2="245"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="90" y="90"><tspan x="90" dy="0">Raw cloud</tspan><tspan x="90" dy="16">.laz / .e57 / .ply</tspan></text>
    <text x="265" y="90"><tspan x="265" dy="0">Filter</tspan><tspan x="265" dy="16">SOR · voxel</tspan></text>
    <text x="440" y="90"><tspan x="440" dy="0">Reconstruct</tspan><tspan x="440" dy="16">Poisson · BPA</tspan></text>
    <text x="615" y="90"><tspan x="615" dy="0">Decimate</tspan><tspan x="615" dy="16">QEM collapse</tspan></text>
    <text x="790" y="90"><tspan x="790" dy="0">Texture</tspan><tspan x="790" dy="16">UV · ortho</tspan></text>
  </g>
  <text x="445" y="248" fill="#1f2937" font-size="14" font-weight="600" text-anchor="middle">Export: glTF / GLB / 3D Tiles</text>
  <text x="445" y="270" fill="#5b6471" font-size="12" text-anchor="middle">Streams into LOD tiling &amp; web rendering</text>
  <text x="90" y="150" fill="#5b6471" font-size="11" text-anchor="middle">from Fundamentals</text>
</svg>
<figcaption>The processing chain: a classified raw cloud is filtered, reconstructed into a surface, decimated to a polygon budget, textured, and exported to streamable formats that feed the LOD pipeline.</figcaption>
</figure>

The four stages above are a contract, not a menu. Each one assumes its predecessor delivered clean inputs: reconstruction trusts the filter to have removed birds and scan noise; decimation trusts reconstruction to have produced a manifold surface; texture projection trusts the geometry to sit in the same projected CRS as the orthophoto. Violate a boundary and the failure travels — a single un-removed outlier becomes a spike in the Poisson surface, which becomes a wasted triangle budget after decimation, which becomes a smear in the texture atlas. The sections below take each stage in turn, with a key practice you can enforce in code.

---

## Point Cloud Filtering

Filtering is the first transformation that touches geometry, and it sets the ceiling on everything downstream. A raw airborne or terrestrial scan contains three broad categories of points you do not want: sensor noise (isolated returns from atmospheric particles, birds, multipath), redundant density (overlapping flight lines that triple the point count without adding information), and semantically irrelevant returns (vegetation, if you are reconstructing buildings). The job of [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) is to strip those out while preserving every point that carries real surface structure.

Two operations do most of the work. **Statistical Outlier Removal (SOR)** computes, for each point, the mean distance to its `k` nearest neighbours; points whose mean distance lies more than `multiplier` standard deviations above the global mean are discarded as noise. **Voxel downsampling** overlays a regular 3D grid of a chosen `voxel_size` and collapses every point inside a cell to that cell's centroid, producing a uniform density that reconstruction algorithms strongly prefer. The order matters: run SOR first so outliers cannot pull a voxel centroid off the true surface.

In production the scalable path is a declarative `PDAL` pipeline, which streams from disk rather than loading the whole `.laz` into memory. This example reprojects a UTM zone 33N cloud into a compound CRS with EGM2008 heights, removes statistical outliers, and writes a thinned result:

```python
import pdal
import json

pipeline = pdal.Pipeline(json.dumps({
    "pipeline": [
        "raw_scan.laz",
        {"type": "filters.reprojection",
         "in_srs": "EPSG:32633", "out_srs": "EPSG:32633+3855"},   # UTM 33N + EGM2008
        {"type": "filters.outlier", "method": "statistical",
         "mean_k": 12, "multiplier": 2.5},
        {"type": "filters.range", "limits": "Classification![7:7]"},  # drop low-noise class
        {"type": "filters.voxelcentroidnearest", "cell": 0.10},      # 10 cm uniform grid
        "filtered.laz"
    ]
}))
kept = pipeline.execute()
print(f"{kept:,} points retained after SOR + voxel downsample")
```

For interactive tuning and per-tile work, `Open3D` exposes the same primitives directly on an in-memory cloud, which is convenient when you want to inspect the removed indices:

```python
import open3d as o3d

pcd = o3d.io.read_point_cloud("tile.ply")
pcd_sor, kept_idx = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
pcd_down = pcd_sor.voxel_down_sample(voxel_size=0.10)
print(f"removed {len(pcd.points) - len(kept_idx):,} outliers; "
      f"{len(pcd_down.points):,} points after downsample")
```

The hardest cases are terrestrial laser scans, where uneven range-dependent density means a single SOR threshold over-cleans the far field while leaving near-field clutter. The focused walkthrough on [removing noise from terrestrial LiDAR scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) covers radius-based filtering and range-normalized thresholds for exactly that situation.

**Key Practice:** Always run SOR before voxel downsampling, and validate filtered density against the target standard rather than trusting the parameters blindly. Assert that `voxel_down_sample` did not collapse a sharp feature you needed — compare point counts per square metre in high-value zones (building edges, infrastructure) before and after, and treat a density drop below your reconstruction sampling requirement as a build failure.

---

## Surface Reconstruction

Filtering produces a clean but still discrete cloud; reconstruction is where discrete points become a continuous, queryable surface. There is no single best algorithm — the right choice depends on point density, noise tolerance, and whether the subject has sharp discontinuities. [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) covers three workhorses that between them handle almost every digital twin input.

**Poisson surface reconstruction** solves a screened Poisson equation over the cloud's oriented normals to produce a smooth, watertight, manifold surface. It is the default for dense, uniformly sampled data — terrain, organic shapes, full-building scans — but it requires reliable normals and tends to balloon over holes, so the output needs trimming by sampling density. **Delaunay triangulation with alpha shapes** builds a surface from point proximity and is faster and more topology-faithful for architectural scans with planar faces, at the cost of an `alpha` parameter you must tune to the point spacing. **Ball-pivoting (BPA)** rolls a virtual sphere of a chosen radius across the points, connecting any triple the ball rests on; it preserves crisp detail in terrestrial scans but is sensitive to non-uniform density, which is exactly why the filtering stage's voxel grid matters.

Poisson reconstruction in `Open3D` requires normals first, and the post-reconstruction density trim is what separates a usable mesh from a bloated blob:

```python
import open3d as o3d
import numpy as np

pcd = o3d.io.read_point_cloud("filtered.ply")
pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=0.30, max_nn=30))
pcd.orient_normals_consistent_tangent_plane(k=30)

mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    pcd, depth=10, scale=1.1, linear_fit=False)

# Trim the low-density "balloon" the solver invents over sparse regions.
densities = np.asarray(densities)
keep = densities > np.quantile(densities, 0.04)
mesh.remove_vertices_by_mask(~keep)
mesh.compute_vertex_normals()
print(f"{len(mesh.triangles):,} triangles after density trim")
```

The single most consequential parameter is the octree `depth`: each increment roughly quadruples triangle count and sharpens detail, but past the data's true sampling resolution it only amplifies noise. The dedicated guide on [Poisson surface reconstruction parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) works through choosing `depth`, `scale`, and the density-trim quantile against measured point spacing.

**Key Practice:** Validate manifold integrity immediately after reconstruction, before any downstream stage trusts the surface. A `trimesh` check catches the defects that Poisson and BPA routinely introduce — non-manifold edges where the ball pivoted across a gap, or self-intersections from over-deep octrees:

```python
import trimesh

m = trimesh.load("reconstructed.ply")
print("watertight:", m.is_watertight,
      "| winding consistent:", m.is_winding_consistent,
      "| euler:", m.euler_number)
assert len(trimesh.repair.broken_faces(m)) == 0, "non-manifold faces present"
```

Fail the pipeline here rather than carrying a leaking surface into the polygon budget. The manifold rules themselves are detailed in [Mesh Topology Basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) and the repair walkthrough on [fixing non-manifold edges](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/).

---

## Automated Mesh Decimation

A reconstructed surface is faithful but far too heavy to render — a Poisson mesh of a single city block can run to several million triangles. Decimation reduces that count to a stated polygon budget while preserving the silhouette and curvature a viewer actually perceives. The technique behind [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) is, almost universally, **quadric error metric (QEM) edge collapse**: each candidate edge is assigned a cost equal to the squared distance the collapse would introduce against the planes meeting at its vertices, and the cheapest collapses are applied first. The result aggressively removes triangles from flat regions while protecting sharp edges and corners where the quadric cost is high.

`Open3D` and `trimesh` both wrap QEM decimation; the key is to drive it from a target triangle count tied to the asset's role in the LOD chain, not a fixed ratio:

```python
import open3d as o3d

mesh = o3d.io.read_triangle_mesh("reconstructed.ply")
mesh.compute_vertex_normals()
print(f"input: {len(mesh.triangles):,} triangles")

lod0 = mesh.simplify_quadric_decimation(target_number_of_triangles=120_000)
lod1 = mesh.simplify_quadric_decimation(target_number_of_triangles=30_000)
lod2 = mesh.simplify_quadric_decimation(target_number_of_triangles=8_000)

for name, m in (("lod0", lod0), ("lod1", lod1), ("lod2", lod2)):
    m.remove_degenerate_triangles()
    m.remove_duplicated_vertices()
    o3d.io.write_triangle_mesh(f"{name}.glb", m)
    print(f"{name}: {len(m.triangles):,} triangles")
```

Decimation must run after manifold repair, never before — collapsing edges around a non-manifold junction produces degenerate triangles and inverted normals that no later stage can cleanly fix. It should also be spatially aware: for urban twins, partition the mesh so building facades and infrastructure nodes keep a higher triangle budget than ground planes, rather than applying one global target that smears the features people came to inspect. Because decimation directly determines payload size and frame rate, the most rendering-specific guidance lives in [optimizing mesh triangle count for web rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/), which ties triangle budgets to draw calls and GPU memory.

**Key Practice:** Decimate to an explicit per-LOD triangle budget and verify the simplification preserved volume and silhouette within tolerance. After each collapse pass, assert the mesh is still watertight and that its bounding volume has not shifted — a `trimesh` volume comparison flags a decimation that ate through a thin wall:

```python
import trimesh

hi = trimesh.load("reconstructed.ply")
lo = trimesh.load("lod1.glb")
drift = abs(hi.volume - lo.volume) / hi.volume
assert drift < 0.02, f"decimation changed volume by {drift:.1%} — budget too aggressive"
```

The generated LOD chain is the raw material for tiling, which is where the [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/) section takes over.

---

<figure class="diagram">
<svg viewBox="36 8 653 270" role="img" aria-labelledby="pm-haus-t pm-haus-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pm-haus-t">Mean deviation and Hausdorff distance disagree about the same mesh</title>
  <desc id="pm-haus-d">A decimated profile follows the source surface closely across most of its length, so the mean deviation is small. One collapsed feature — a parapet — deviates by twenty-two centimetres, and that single worst case is the Hausdorff distance. Averaging hides exactly the failure a clearance calculation depends on.</desc>
  <rect class="svg-bg" x="36" y="8" width="653" height="270" fill="#ffffff"/>
  <defs>
    <marker id="pm-haus-a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <polyline points="50,170 110,166 170,168 230,162 290,88 320,88 350,164 410,160 470,164 530,158 590,162 650,158"
            fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="6 4"/>
  <polyline points="50,172 110,168 170,170 230,164 290,150 320,150 350,166 410,162 470,166 530,160 590,164 650,160"
            fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <line x1="305" y1="88" x2="305" y2="150" stroke="#b0413e" stroke-width="2"
        marker-start="url(#pm-haus-a)" marker-end="url(#pm-haus-a)"/>
  <text x="318" y="118" fill="#b0413e" font-size="12" text-anchor="start">0.22 m — the parapet collapsed</text>
  <text x="50" y="212" fill="#1f6b8a" font-size="12.5" text-anchor="start">mean deviation 0.014 m — comfortably inside any budget</text>
  <text x="50" y="234" fill="#b0413e" font-size="12.5" text-anchor="start">Hausdorff distance 0.22 m — the number the clearance check actually needs</text>
  <text x="370" y="36" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Dashed is the source surface; solid is the decimated one</text>
  <text x="370" y="260" fill="#5b6471" font-size="12" text-anchor="middle">Accept decimation on the worst case, and log where the worst case is — it is nearly always a thin, tall feature</text>
</svg>
<figcaption>A single collapsed parapet barely moves the mean and completely determines whether the mesh can answer a clearance question.</figcaption>
</figure>

## Texture Mapping

A decimated mesh is geometrically correct but visually grey; texture mapping is what makes a digital twin recognisable. The stage has two halves: **UV unwrapping**, which assigns every triangle a position in a 2D texture space with minimal distortion, and **orthophoto projection**, which samples real imagery — drone orthomosaics, satellite tiles, or per-image photogrammetry frames — onto those UVs. The work of [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) is to do both without visible seams, GPU-busting atlas sizes, or misregistration between imagery and geometry.

The registration is the part that fails silently. An orthophoto delivered in EPSG:32633 must be sampled against a mesh in the same EPSG:32633, with the same vertical datum, or the texture slides off the geometry by exactly the CRS offset — a problem that looks like a slightly blurry building until you measure it. The robust approach computes UVs by projecting mesh vertices through the orthophoto's georeferencing transform, read straight from the raster:

```python
import trimesh
import rasterio
import numpy as np

mesh = trimesh.load("lod0.glb")                       # vertices in EPSG:32633
with rasterio.open("ortho_32633.tif") as src:
    assert src.crs.to_epsg() == 32633, "ortho CRS must match mesh CRS"
    inv = ~src.transform                              # world (E,N) -> pixel (col,row)
    w, h = src.width, src.height

E, N = mesh.vertices[:, 0], mesh.vertices[:, 1]       # top-down planar projection
cols, rows = inv * (E, N)
uv = np.column_stack([cols / w, 1.0 - rows / h])      # normalize, flip V for image space
mesh.visual = trimesh.visual.TextureVisuals(
    uv=uv, image=trimesh.load_image("ortho_32633.tif"))
mesh.export("textured.glb")
print("UV range:", uv.min(axis=0), uv.max(axis=0))
```

For oblique surfaces — building facades that a top-down ortho cannot see — planar projection breaks down and you need per-image alignment via feature matching and homography, blending overlapping frames with seam-removal to hide the joins. That alignment problem, including how to recover camera poses and snap textures back onto the point cloud, is the subject of [aligning photogrammetry textures with point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/aligning-photogrammetry-textures-with-point-clouds/). At city scale, pack textures into multi-resolution atlases so the GPU loads a single bounded image per tile rather than thousands of small ones.

**Key Practice:** Assert CRS parity between the mesh and every imagery source before sampling, and store semantic attributes alongside the texture rather than baking them into pixels. Confirm `src.crs.to_epsg()` equals the mesh's projected EPSG and that vertical datums agree; then attach classification codes, asset IDs, and material tags as glTF extras or a sidecar JSON keyed by face, so the twin stays queryable after it is textured.

---

## Cross-Section Integration

This pipeline is the middle link in a three-stage chain. It consumes the outputs of the fundamentals and feeds the LOD pipeline, and almost every production failure traces back to one of those two boundaries being crossed with unvalidated data.

- **Fundamentals → this pipeline:** Filtering and reconstruction assume a correctly classified, density-validated cloud in an explicit metric CRS — the contract set by [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/). Feed reconstruction an unclassified cloud and vegetation returns become spikes in the Poisson surface; feed it a geographic CRS like EPSG:4326 and the `voxel_size` you specified in metres is silently interpreted in degrees, collapsing the entire cloud to a handful of cells. The density target this pipeline depends on is governed by [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/), and the CRS discipline by [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
- **This pipeline → LOD management:** The decimated, manifold, textured LOD chain produced here is the direct input to [hierarchical LOD structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) and [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/). A non-manifold mesh cannot be cleanly split at tile boundaries, and a CRS mismatch reappears as visible seams between adjacent tiles, so the manifold and EPSG assertions in the sections above are precisely what make downstream [streaming sync patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) deterministic.
- **Closing the loop:** The exported glTF and 3D Tiles are re-validated against the same EPSG codes and geoid model declared in the fundamentals, so a twin that round-trips through filtering, reconstruction, decimation, and texturing remains positionally identical to the survey it came from.

**Key Practice:** Make the boundary contract executable. At ingestion, assert the cloud's CRS is projected and metric and its classification codes are present; at export, assert the mesh is watertight and tagged with the horizontal and vertical EPSG it was built in. A contract enforced only in a wiki is a contract that will be violated on the first rushed delivery.

---

<figure class="diagram">
<svg viewBox="-30 46 820 262" role="img" aria-labelledby="pm-inv-t pm-inv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pm-inv-t">What each stage of the pipeline is allowed to change</title>
  <desc id="pm-inv-d">Filtering removes points but must not move them. Reconstruction creates geometry and may invent surface across gaps. Decimation moves and removes vertices within a stated tolerance. Texturing changes no geometry at all. Naming the permitted change per stage is what makes a regression attributable.</desc>
  <rect class="svg-bg" x="-30" y="46" width="820" height="262" fill="#ffffff"/>
  <defs>
    <marker id="pm-inv-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="164" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="212" y="60" width="164" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="404" y="60" width="164" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="596" y="60" width="144" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pm-inv-a)">
    <line x1="184" y1="90" x2="210" y2="90"/>
    <line x1="376" y1="90" x2="402" y2="90"/>
    <line x1="568" y1="90" x2="594" y2="90"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="102" y="96">filter</text>
    <text x="294" y="96">reconstruct</text>
    <text x="486" y="96">decimate</text>
    <text x="668" y="96">texture</text>
  </g>
  <rect x="20" y="150" width="164" height="86" rx="8" fill="#ffffff" stroke="#e6e0d4" stroke-width="2"/>
  <rect x="212" y="150" width="164" height="86" rx="8" fill="#ffffff" stroke="#e6e0d4" stroke-width="2"/>
  <rect x="404" y="150" width="164" height="86" rx="8" fill="#ffffff" stroke="#e6e0d4" stroke-width="2"/>
  <rect x="596" y="150" width="144" height="86" rx="8" fill="#ffffff" stroke="#e6e0d4" stroke-width="2"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="102" y="174"><tspan x="102" dy="0">removes points</tspan><tspan x="102" dy="15">never moves one</tspan><tspan x="102" dy="15">CRS unchanged</tspan><tspan x="102" dy="15">count only falls</tspan></text>
    <text x="294" y="174"><tspan x="294" dy="0">creates geometry</tspan><tspan x="294" dy="15">may invent surface</tspan><tspan x="294" dy="15">across real gaps</tspan><tspan x="294" dy="15">trim by density</tspan></text>
    <text x="486" y="174"><tspan x="486" dy="0">moves vertices</tspan><tspan x="486" dy="15">inside a stated</tspan><tspan x="486" dy="15">Hausdorff bound</tspan><tspan x="486" dy="15">topology preserved</tspan></text>
    <text x="668" y="174"><tspan x="668" dy="0">changes no</tspan><tspan x="668" dy="15">geometry at all</tspan><tspan x="668" dy="15">UVs and images</tspan><tspan x="668" dy="15">only</tspan></text>
  </g>
  <text x="380" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">A vertex that moved during filtering, or a texture stage that changed a triangle count, is a bug regardless of how good the output looks</text>
  <text x="380" y="290" fill="#5b6471" font-size="12" text-anchor="middle">Assert the invariant after each stage and a regression names its own stage</text>
</svg>
<figcaption>The pipeline's stages are separated by what they are permitted to change, not by which library runs them. That is what makes a fault attributable to one step.</figcaption>
</figure>

## Production Checklist

Use this as a release gate before any pipeline output is promoted to a staging or production twin:

- [ ] Input cloud is in a projected, metric CRS with explicit horizontal and vertical EPSG codes
- [ ] Statistical outlier removal runs before voxel downsampling, with parameters in config not code
- [ ] Filtered density is validated against the target standard in high-value zones
- [ ] Normals are estimated and consistently oriented before Poisson reconstruction
- [ ] Poisson output is density-trimmed; reconstruction algorithm matched to point density and sharpness
- [ ] Manifold validation (`is_watertight`, broken-face count) passes before decimation
- [ ] Decimation targets an explicit per-LOD triangle budget, run after topology repair
- [ ] Post-decimation volume drift is asserted within tolerance (e.g. < 2%)
- [ ] Orthophoto and mesh share the same EPSG and vertical datum before texture sampling
- [ ] Semantic attributes stored as glTF extras or sidecar JSON, not baked into pixels
- [ ] Each stage is idempotent and intermediate artifacts are content-addressed for caching
- [ ] Pipeline configuration and library versions are pinned and tracked alongside the data

---

## Troubleshooting Matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Poisson surface has bubbles or spikes over empty areas | Density balloon not trimmed; vegetation not filtered | Apply the density-quantile mask; re-run SOR and classification before reconstruction |
| Voxel downsample collapses the cloud to a few points | `voxel_size` in metres applied to a geographic CRS (EPSG:4326) | Reproject to a metric projected CRS (e.g. EPSG:32633) before downsampling |
| Ball-pivoting leaves holes across flat regions | Ball radius smaller than local point spacing after thinning | Increase radius to ~2× the voxel size, or run a second pass with a larger ball |
| Decimated mesh shows inverted normals / spikes | Decimation run before manifold repair | Repair topology, reorient normals, then decimate; assert watertight after each pass |
| Texture slides off the geometry by a fixed offset | Ortho and mesh in different CRS or vertical datum | Assert `src.crs.to_epsg()` equals the mesh EPSG; align vertical datums before sampling |
| Visible seams between textured tiles | Per-image textures blended without seam removal | Use multi-band blending / seam-removal; pack into a multi-resolution atlas |
| Reconstruction job exhausts memory | Whole cloud loaded into Poisson at high octree depth | Tile to ~1 km² chunks; stream filtering through `PDAL`; lower `depth` to data resolution |
| Tiles misalign at LOD boundaries downstream | CRS drift or non-manifold edges carried from this pipeline | Pin one EPSG through the chain; fail the build on a non-manifold export |

---

## Frequently Asked Questions

### Which surface reconstruction algorithm should I use for building scans?
For dense, uniformly sampled terrestrial scans of buildings with planar faces, Delaunay triangulation with a tuned alpha shape or ball-pivoting preserves sharp edges better than Poisson, which tends to round corners. For organic terrain or full-coverage aerial data, Poisson's watertight output is usually worth the smoothing. The deciding factors are density uniformity (favours BPA) and the presence of sharp discontinuities (favours Delaunay/alpha over Poisson). See [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) for the full decision matrix.

### Should I filter before or after reprojection?
Reproject first, into a projected metric CRS such as EPSG:32633, then filter. Statistical outlier removal and voxel downsampling both reason about distances in the cloud's units, and those distances are only meaningful in metres. Running a 10 cm `voxel_size` against a geographic CRS in degrees collapses the entire cloud, because 0.10 degrees is roughly 11 km.

### How aggressively can I decimate before quality suffers?
There is no universal ratio — QEM decimation can remove 90%+ of triangles from a flat-heavy mesh with no perceptible change, but the same target will destroy a mesh that is mostly fine geometric detail. Drive decimation by a target triangle count tied to the LOD level and verify with a volume-drift assertion; if drift exceeds about 2%, the budget is too aggressive for that asset. Triangle budgets for browser rendering are covered in [optimizing mesh triangle count for web rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/).

### Why does my texture look slightly blurred or offset on the buildings?
Almost always a CRS or vertical-datum mismatch between the orthophoto and the mesh. If the ortho is EPSG:32633 and the mesh was exported in a different zone or with ellipsoidal rather than orthometric heights, the projection samples imagery from the wrong pixels, smearing the result. Assert CRS parity before sampling and confirm both use the same geoid model; for oblique facades, switch from planar projection to per-image alignment.

### Can I run this whole pipeline on terabyte-scale city datasets?
Yes, but only by tiling. Split the extent into roughly 1 km² tiles, stream filtering through `PDAL` so you never load a full tile into memory, reconstruct and decimate each tile independently, then stitch at shared boundaries. Orchestrate the per-tile jobs with `concurrent.futures`, Dask, or a batch system, cache content-addressed intermediates so re-runs are cheap, and keep one EPSG pinned across every tile to prevent boundary seams.

### Do I still need the point cloud after I have a mesh?
Often, yes. The mesh is the optimized, renderable representation, but the classified point cloud remains the measurement of record for change detection, volumetrics, and re-deriving surfaces when a better reconstruction algorithm or a denser scan arrives. Most production twins keep both, with the cloud archived in `.laz` and the mesh deployed as glTF or 3D Tiles.

---

A closing word on sequencing. The stages above are presented in order because each one's output is the next one's input, but the ordering is not merely conventional — it is what keeps each stage's job tractable. Filtering before reconstruction means the solver never has to distinguish noise from geometry. Reconstructing before decimation means the decimator has a manifold surface to reason about. Decimating before texturing means the texture is baked against the geometry that will actually ship. Reorder any two of them and the later stage inherits a problem the earlier one was there to remove.

## Related Guides

- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — SOR, voxel downsampling, and ground separation
- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — Poisson, Delaunay, and ball-pivoting trade-offs
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — QEM edge collapse and LOD chains
- [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — UV unwrapping and orthophoto projection
- [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/) — where the decimated LOD chain gets tiled and streamed

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) — the input contract for this pipeline.
