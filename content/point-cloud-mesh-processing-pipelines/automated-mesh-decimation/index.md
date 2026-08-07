# Automated Mesh Decimation for Geospatial Digital Twins

Raw photogrammetric and LiDAR-derived meshes routinely exceed tens or hundreds of millions of triangles, making them computationally prohibitive for real-time digital twin environments, web-based GIS viewers, and edge-deployed infrastructure models. Automated mesh decimation resolves this bottleneck by algorithmically reducing polygon density while preserving topological integrity, geospatial alignment, and visual fidelity — turning a 40 M-triangle building block into a 400 K-triangle asset that a browser can stream without dropping frames. This page is a runnable, production-grade workflow: it covers quadric edge collapse (QEM) and vertex clustering, target triangle budgets, boundary, UV and normal preservation, the LOD chains that feed a viewer, and how to prove the result with Hausdorff error measurement. It is part of the broader [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) work and assumes you have already reconstructed a surface from your point cloud.

## Prerequisites

Decimation sits late in the pipeline, after [surface reconstruction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) has produced a triangulated mesh. Pin exact versions — the `simplify_quadric_decimation` signature and its keyword arguments changed across Open3D releases, and code written for 0.16 silently breaks on 0.17+.

- **Python 3.9+** in an isolated environment. With `venv`: `python -m venv .venv && source .venv/bin/activate && pip install "open3d>=0.17" "trimesh>=4.0" "numpy>=1.24" scipy`. With `conda`: `conda create -n decim python=3.11 && conda activate decim && pip install "open3d>=0.17" "trimesh>=4.0" numpy scipy`.
- **Core libraries**: `open3d>=0.17` (its `simplify_quadric_decimation` and `simplify_vertex_clustering`), `trimesh>=4.0` (for `trimesh.repair`, watertightness, and Hausdorff sampling), `numpy>=1.24`, and `scipy` (for `scipy.spatial.cKDTree`, used in the error metric).
- **Input formats**: PLY or OBJ as the primary working formats (both round-trip vertex data cleanly through Open3D); GLB/glTF for the final web payload; LAS/LAZ only as the upstream point-cloud source, never as a mesh input.
- **Geospatial context**: a known coordinate reference system, stated explicitly. Decimation must run in a projected metric CRS such as EPSG:32618 (UTM zone 18N) — never in geographic EPSG:4326, where degrees-of-longitude and degrees-of-latitude are anisotropic and QEM's error metric, which assumes isotropic Euclidean distance, will preferentially collapse edges along one axis. Store the CRS in a sidecar `.prj` (WKT) or a `.crs.json` next to the mesh, because PLY and OBJ carry no CRS field.
- **Hardware**: minimum 16 GB RAM for city-block-scale meshes; 64+ GB recommended for district-level datasets processed in a single tile.

Clean input geometry is non-negotiable. Decimation algorithms assume manifold or near-manifold topology. If your source originates from noisy LiDAR returns or unstructured point clouds, apply [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) before reconstruction. Outliers, duplicate vertices, and non-watertight boundaries propagate through decimation, causing UV tearing, texture misalignment, or silent geometry collapse.

## Concept

Two algorithm families dominate geospatial decimation, and choosing between them is the first design decision.

**Quadric Error Metrics (QEM)** — the Garland–Heckbert quadric edge-collapse method — assigns each vertex a 4×4 quadric matrix encoding the sum of squared distances to its incident face planes. The algorithm repeatedly collapses the edge whose merge introduces the least quadric error, placing the new vertex at the error-minimising position. The result preserves silhouettes and high-curvature features (roof ridges, bridge cables, kerb lines) because flat regions accumulate near-zero error and collapse first. It is the right default for architectural facades, bridges, and utility infrastructure where shape fidelity matters. It is order-dependent and slower, scaling with the number of collapses.

**Vertex clustering** overlays a regular voxel grid, snaps every vertex within a cell to a single representative point, and rebuilds triangles. It is fast, bounded by grid resolution rather than triangle count, and tolerant of dirty topology — but it ignores curvature and will flatten a 10 cm kerb if the voxel is 20 cm. Reserve it for terrain, vegetation, or background assets, and as a fallback when QEM degenerates on near-non-manifold input.

A target triangle budget is the input QEM needs: rather than a fixed ratio, you usually decimate to a **chain** of budgets — one mesh per level of detail. Each tile in a 3D Tiles tree carries the right LOD for its screen-space footprint, so a distant city block streams as a few thousand triangles while the block under the camera streams the full-resolution mesh. Three preservation constraints turn a naive collapse into a usable geospatial asset: **boundary preservation** pins the open edges of a tile so neighbouring tiles stay watertight against each other; **UV preservation** stops collapses from merging vertices across a texture seam and smearing the atlas; and **normal preservation** keeps shading consistent so a decimated facade does not develop faceting artefacts under directional light. QEM handles the first through edge weighting and the third through post-collapse normal recomputation; the second usually requires splitting the mesh on its UV islands before decimating.

<figure class="diagram">
<svg viewBox="6 46 714 218" role="img" aria-labelledby="decim-lod-t decim-lod-d" xmlns="http://www.w3.org/2000/svg">
  <title id="decim-lod-t">QEM decimation LOD chain</title>
  <desc id="decim-lod-d">A high-resolution source mesh is quadric-edge-collapsed into three successive levels of detail with decreasing triangle counts, each selected by screen-space distance, and the error of each level is bounded by a Hausdorff distance check.</desc>
  <rect class="svg-bg" x="6" y="46" width="714" height="218" fill="#ffffff"/>
  <defs>
    <marker id="decim-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="170" height="90" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="232" y="70" width="150" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="424" y="78" width="130" height="54" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="596" y="84" width="110" height="42" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#decim-arrow)">
    <line x1="190" y1="105" x2="230" y2="105"/>
    <line x1="382" y1="105" x2="422" y2="105"/>
    <line x1="554" y1="105" x2="594" y2="105"/>
  </g>
  <rect x="20" y="200" width="686" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#decim-arrow)">
    <line x1="105" y1="150" x2="105" y2="198"/>
    <line x1="307" y1="140" x2="307" y2="198"/>
    <line x1="489" y1="132" x2="489" y2="198"/>
    <line x1="651" y1="126" x2="651" y2="198"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="105" y="100">Source mesh</text>
    <text x="105" y="120">40 M tris</text>
    <text x="307" y="100">LOD 0</text>
    <text x="307" y="120">4 M tris</text>
    <text x="489" y="100">LOD 1</text>
    <text x="489" y="118">800 K</text>
    <text x="651" y="100">LOD 2</text>
    <text x="651" y="118">120 K</text>
  </g>
  <text x="363" y="222" fill="#1f2937" font-size="13" font-weight="600" text-anchor="middle">QEM edge collapse, EPSG:32618</text>
  <text x="363" y="240" fill="#1f2937" font-size="12" text-anchor="middle">each level bounded by a Hausdorff distance check</text>
</svg>
<figcaption>QEM produces a level-of-detail chain: each level is a coarser decimation of the source, selected by screen distance and validated against a Hausdorff error budget.</figcaption>
</figure>

## Step-by-Step Workflow

A robust automated decimation pipeline is a deterministic sequence with a validation gate after each stage, so a batch run fails loudly on one tile instead of silently corrupting downstream assets.

### 1. Mesh ingestion and baseline metrics

Load the mesh and capture baseline metrics — vertex and triangle counts, bounding box, and the local-origin offset you will need to fight floating-point precision loss. Subtract the mesh centroid so that QEM operates near the origin rather than on full UTM eastings (which run into the hundreds of thousands of metres in EPSG:32618 and waste float32 precision on the integer part).

```python
import numpy as np
import open3d as o3d
import logging

logging.basicConfig(level=logging.INFO)


def ingest_and_validate(filepath: str):
    mesh = o3d.io.read_triangle_mesh(filepath)
    if mesh.is_empty():
        raise ValueError(f"Failed to load mesh: {filepath}")

    verts, tris = len(mesh.vertices), len(mesh.triangles)
    logging.info(f"Loaded {filepath}: {verts:,} vertices, {tris:,} triangles")

    # Shift to a local origin so QEM runs near (0,0,0), not at UTM eastings.
    origin = mesh.get_center()
    mesh.translate(-origin)

    if not mesh.has_vertex_normals():
        mesh.compute_vertex_normals()
    return mesh, origin
```

### 2. Topology pre-processing

Raw meshes from photogrammetry or [surface reconstruction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) often contain degenerate faces, overlapping vertices, or inconsistent normals. Pre-processing normalises the geometry so the QEM heuristic operates predictably — degenerate triangles produce zero-area face planes whose quadrics are ill-defined.

```python
def preprocess_topology(mesh: o3d.geometry.TriangleMesh) -> o3d.geometry.TriangleMesh:
    mesh.remove_duplicated_vertices()
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    mesh.compute_triangle_normals()
    return mesh
```

### 3. QEM decimation to a triangle budget

Decimate to an absolute triangle count, not a ratio — your viewer cares about the budget, not the source size, and an absolute target makes a heterogeneous batch produce uniformly weighted tiles. Open3D 0.17+ exposes `boundary_weight` on `simplify_quadric_decimation`: a high weight pins open boundary loops (tile edges, building footprints) in place so adjacent tiles stay watertight against each other, while `preserve_volume` keeps the decimated hull from shrinking inward on thin features. The signature is the common breakage point across versions — pre-0.17 builds used a different keyword set and will raise `TypeError` on `boundary_weight`, which is exactly why the prerequisites pin `open3d>=0.17`. Fall back to vertex clustering only when QEM degenerates.

```python
def decimate_qem(
    mesh: o3d.geometry.TriangleMesh,
    target_triangles: int,
    boundary_weight: float = 100.0,
) -> o3d.geometry.TriangleMesh:
    """Quadric edge-collapse to an absolute triangle budget."""
    if target_triangles >= len(mesh.triangles):
        return mesh

    simplified = mesh.simplify_quadric_decimation(
        target_number_of_triangles=target_triangles,
        boundary_weight=boundary_weight,   # high = pin tile/footprint edges
    )

    # QEM can degenerate on near-non-manifold input; fall back to clustering.
    if len(simplified.triangles) == 0 or len(simplified.vertices) < 4:
        logging.warning("QEM degenerated, falling back to vertex clustering")
        extent = mesh.get_axis_aligned_bounding_box().get_extent()
        voxel_size = float(extent.max()) * 0.01
        simplified = mesh.simplify_vertex_clustering(
            voxel_size=voxel_size,
            contraction=o3d.geometry.SimplificationContraction.Average,
        )

    simplified.compute_vertex_normals()
    logging.info(
        f"Decimated {len(mesh.triangles):,} -> {len(simplified.triangles):,} triangles"
    )
    return simplified
```

<figure class="diagram">
<svg viewBox="4 62 732 230" role="img" aria-labelledby="dc-qem-t dc-qem-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dc-qem-t">What a quadric error metric is measuring</title>
  <desc id="dc-qem-d">Each vertex accumulates the squared distance to the planes of the faces around it. Collapsing an edge costs the accumulated error at the position the collapse would move to, so collapses in the middle of a flat wall cost almost nothing and collapses across a corner cost a great deal. The cheapest collapse is always taken first.</desc>
  <rect class="svg-bg" x="4" y="62" width="732" height="230" fill="#ffffff"/>
  <path d="M60 200 H320" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="110" cy="200" r="5"/><circle cx="170" cy="200" r="5"/><circle cx="230" cy="200" r="5"/>
  </g>
  <path d="M155 200 h30 v0" fill="none" stroke="#4f7a4d" stroke-width="6"/>
  <path d="M430 200 H560 L640 110" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="500" cy="200" r="5"/><circle cx="560" cy="200" r="5"/><circle cx="608" cy="146" r="5"/>
  </g>
  <path d="M545 200 L590 165" fill="none" stroke="#b0413e" stroke-width="6"/>
  <text x="190" y="90" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">collapse inside a plane</text>
  <text x="190" y="112" fill="#1f2937" font-size="12" text-anchor="middle">every face shares one plane, so the</text>
  <text x="190" y="130" fill="#1f2937" font-size="12" text-anchor="middle">squared distance stays zero — cost ≈ 0</text>
  <text x="560" y="90" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">collapse across a corner</text>
  <text x="560" y="112" fill="#1f2937" font-size="12" text-anchor="middle">two planes disagree, so any merged position</text>
  <text x="560" y="130" fill="#1f2937" font-size="12" text-anchor="middle">is off both of them — cost is large</text>
  <text x="370" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">This is why QEM keeps building silhouettes for free: the flat wall between them is where all the cheap collapses are</text>
  <text x="370" y="274" fill="#5b6471" font-size="12" text-anchor="middle">And why an aggressive budget eventually eats the corners — once the flat regions are gone, only expensive collapses remain</text>
</svg>
<figcaption>The metric is not a heuristic about importance; it is the exact squared deviation the collapse introduces. That is what makes the error bound reportable.</figcaption>
</figure>

### 4. Building the LOD chain

Most twins need several levels, not one. Generate each LOD from the source (not from the previous level — chaining decimations compounds error) at a halving cadence that matches the 3D Tiles geometric-error doubling between levels. The budgets in the example below step by roughly 5× per level, which keeps the on-screen triangle density of a tile near-constant as the camera pulls back and the tile shrinks to a quarter of its screen area. Tag each level with the Hausdorff error you measured for it, because the 3D Tiles `geometricError` field that drives LOD switching expects a real metric distance, not an arbitrary level index.

```python
def build_lod_chain(mesh, budgets=(4_000_000, 800_000, 120_000)):
    """One QEM decimation per LOD, each from the original source mesh."""
    return {f"LOD{i}": decimate_qem(mesh, n) for i, n in enumerate(budgets)}
```

### 5. UV and seam preservation with trimesh

When a mesh carries a texture atlas, QEM that merges vertices across a UV seam tears the texture. `trimesh` exposes the UV island structure; decimating per-island, or splitting on seams first, keeps texture coordinates coherent. This matters most for the CAD-derived and photogrammetric facades feeding [texture mapping workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).

```python
import trimesh


def has_uv_seams(path: str) -> bool:
    tm = trimesh.load(path, process=False)
    if not hasattr(tm.visual, "uv") or tm.visual.uv is None:
        return False
    # More UV vertices than spatial vertices implies seams.
    return len(tm.visual.uv) > len(tm.vertices)
```

### 6. Export with CRS sidecar and origin restored

Open3D strips any CRS during I/O, so re-apply the local-origin offset (back into EPSG:32618) and write the WKT to a sidecar.

```python
import json


def export_with_crs(mesh, origin, output_path: str, crs_wkt: str):
    mesh.translate(origin)  # restore true UTM position
    o3d.io.write_triangle_mesh(output_path, mesh, write_ascii=False)
    meta = output_path.rsplit(".", 1)[0] + ".crs.json"
    with open(meta, "w") as f:
        json.dump({"crs_wkt": crs_wkt, "epsg": "EPSG:32618",
                   "source": "automated_decimation_pipeline"}, f, indent=2)
    logging.info(f"Exported {output_path} (+ {meta})")
```

<figure class="diagram">
<svg viewBox="9 6 705 296" role="img" aria-labelledby="dc-bud-t dc-bud-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dc-bud-t">Deviation against triangle budget for one building</title>
  <desc id="dc-bud-d">Reducing a two hundred thousand triangle building to fifty thousand costs almost no measurable deviation, because the removed triangles were subdividing flat walls. Below about twelve thousand the curve turns sharply upward as the decimator starts collapsing the silhouette itself.</desc>
  <rect class="svg-bg" x="9" y="6" width="705" height="296" fill="#ffffff"/>
  <path d="M80 56 V214 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="120,208 200,206 280,203 360,198 440,188 500,168 560,128 610,92 660,66"
            fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M500 56 V220" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="500" y="48" fill="#4f7a4d" font-size="12" text-anchor="middle">the knee — about 12 k triangles</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="120" y="234">200 k</text>
    <text x="280" y="234">80 k</text>
    <text x="440" y="234">25 k</text>
    <text x="560" y="234">8 k</text>
    <text x="660" y="234">2 k</text>
  </g>
  <text x="390" y="258" fill="#5b6471" font-size="12" text-anchor="middle">triangle budget</text>
  <text x="40" y="128" fill="#5b6471" font-size="12" text-anchor="middle">Haus-</text>
  <text x="40" y="144" fill="#5b6471" font-size="12" text-anchor="middle">dorff</text>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Most of the reduction is free; all of the damage is in the last stretch</text>
  <text x="380" y="284" fill="#15384a" font-size="12" text-anchor="middle">Find the knee once per building archetype, then set budgets from it rather than from a uniform percentage</text>
</svg>
<figcaption>A flat percentage applied across a city lands different archetypes on different sides of their own knee. The curve is cheap to measure and the budget should come from it.</figcaption>
</figure>

## Validation & Verification

A decimation is only acceptable if you can bound how far the simplified surface drifts from the original. The **Hausdorff distance** — the maximum over all points on one surface of the nearest distance to the other — is the standard metric, expressed in the same metric units as the CRS (metres in EPSG:32618). The one-sided Hausdorff distance is asymmetric, so a surface that lies entirely inside another can report zero in one direction while the reverse direction reveals the real drift; always compute it symmetrically. Pure maximum Hausdorff is sensitive to a single bad collapse, so report the mean and 95th percentile alongside it: the maximum tells you the worst-case visual artefact, while the mean tells you the average positional accuracy a downstream measurement tool will inherit. Sample both surfaces densely and take a symmetric nearest-neighbour distance with a KD-tree.

```python
import numpy as np
import trimesh
from scipy.spatial import cKDTree


def hausdorff_distance(orig_path, decimated_path, n_samples=200_000):
    a = trimesh.load(orig_path, process=False)
    b = trimesh.load(decimated_path, process=False)
    pa = a.sample(n_samples)
    pb = b.sample(n_samples)

    d_ab = cKDTree(pb).query(pa)[0]   # a -> b nearest distances (metres)
    d_ba = cKDTree(pa).query(pb)[0]   # b -> a nearest distances (metres)

    return {
        "hausdorff_m": float(max(d_ab.max(), d_ba.max())),
        "mean_m": float((d_ab.mean() + d_ba.mean()) / 2),
        "p95_m": float(np.percentile(np.concatenate([d_ab, d_ba]), 95)),
    }
```

Pin a tolerance to the asset class and assert it, so a bad budget fails the batch instead of shipping. For LOD 0 of building geometry a 5 cm mean and 15 cm Hausdorff is typical; coarser LODs relax proportionally. Also re-check topology after decimation — QEM can open small holes near collapsed boundaries.

```python
err = hausdorff_distance("source.ply", "lod0.ply")
assert err["mean_m"] < 0.05,      f"mean error {err['mean_m']:.3f} m too high"
assert err["hausdorff_m"] < 0.15, f"max error {err['hausdorff_m']:.3f} m too high"

import trimesh
decim = trimesh.load("lod0.ply")
print("watertight:", decim.is_watertight, "| euler:", decim.euler_number)
print(f"mean={err['mean_m']*100:.1f} cm  p95={err['p95_m']*100:.1f} cm")
```

Expected console output for a clean facade decimated 40 M → 4 M:

```
watertight: True | euler: 2
mean=2.1 cm  p95=6.8 cm
```

## Performance & Scale

QEM cost scales with the number of edge collapses, so reduction depth dominates runtime more than input size — taking a mesh to 1% of its triangles is far more than ten times the work of taking it to 10%, because the priority queue of candidate collapses must be re-sorted after every merge. Memory is the harder ceiling: Open3D holds the full vertex array, triangle array, and per-vertex quadric matrices in RAM at once, so a 40 M-triangle mesh can sit at 6–8 GB before decimation even begins. Indicative single-threaded benchmarks on a 32 GB machine: 1 M → 100 K triangles (QEM) in roughly 2.4 s; 5 M → 500 K (QEM) in roughly 9 s; 10 M → 1 M via vertex clustering in roughly 4 s. The Hausdorff check at 200 K samples adds about 1–2 s per pair, dominated by building the two KD-trees.

For district-scale data, never load the whole model into one process. Tile the mesh into spatially coherent chunks on a quadtree or octree aligned to the same EPSG:32618 grid your [LOD management](https://www.3d-geospatial.com/lod-management-optimization-strategies/) tiling uses, decimate each chunk independently, and merge at the viewer. This is embarrassingly parallel — distribute tiles across CPU cores with `ProcessPoolExecutor`, keeping I/O single-threaded to avoid file-lock contention, and expect roughly a 3× speedup on four cores at ~85% utilisation. Make each task idempotent and cache intermediate LODs so a failed tile is retried, not rerun from scratch.

```python
import os, glob
from concurrent.futures import ProcessPoolExecutor, as_completed


def process_single(inp, out_dir, budgets, crs_wkt):
    mesh, origin = ingest_and_validate(inp)
    mesh = preprocess_topology(mesh)
    for name, m in build_lod_chain(mesh, budgets).items():
        out = os.path.join(out_dir, f"{os.path.basename(inp)[:-4]}_{name}.ply")
        export_with_crs(m, origin, out, crs_wkt)


def batch_decimate(input_dir, output_dir, budgets, crs_wkt, workers=4):
    os.makedirs(output_dir, exist_ok=True)
    files = glob.glob(os.path.join(input_dir, "*.ply"))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(process_single, f, output_dir, budgets, crs_wkt)
                   for f in files]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception as e:
                logging.error(f"Tile failed: {e}")
```

## Failure Modes & Gotchas

- **Boundary collapse opening tile seams.** With a low `boundary_weight`, QEM treats open edges like any other and collapses them, so adjacent tiles no longer share a watertight border and the viewer shows cracks at LOD edges. Pin boundaries with a high `boundary_weight` (100+) and decimate tiles with their shared edges identical, ideally with a shared vertex strip.
- **UV tearing across texture seams.** Aggressive vertex merging across a UV seam pulls texture coordinates apart, smearing the atlas. Detect seams first (more UV vertices than spatial vertices), enable boundary preservation, and decimate per UV island rather than globally.
- **CRS drift from float precision.** Running QEM directly on full UTM eastings in EPSG:32618 burns float32 mantissa bits on the six-figure integer part, so vertices jitter by centimetres. Always translate to a local origin before simplification and restore the offset on export.
- **Silent geometry collapse on non-manifold input.** Non-manifold edges and overlapping faces give QEM undefined quadrics; it can return an empty or 3-vertex mesh. Run `trimesh.repair` and `remove_non_manifold_edges` before decimating, and assert a non-empty result as a gate.
- **Compounded error from chained LODs.** Generating LOD 2 from LOD 1 instead of from the source stacks each level's Hausdorff error. Always decimate every level from the original mesh.

## Frequently Asked Questions

### When should I use vertex clustering instead of QEM?
Use QEM by default for any asset where shape matters — buildings, bridges, infrastructure — because it preserves silhouettes and curvature. Reach for vertex clustering when speed beats fidelity (terrain, vegetation, far-distance background tiles) or when the input is too dirty for QEM to converge. In production, run QEM first and fall back to clustering only when it degenerates.

### What triangle budget should a web tile target?
Browser-based viewers are typically comfortable around 1–2 million triangles per visible tile, while desktop digital twins tolerate 5–10 million. Drive the budget by screen-space footprint through the LOD chain rather than one global number, and confirm thresholds against your target hardware in [optimizing mesh triangle count for web rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/).

### How do I keep decimation from shifting my coordinates?
Decimation itself does not move geometry, but float precision does when you operate on raw UTM coordinates. Translate the mesh to a local origin (subtract the centroid) before decimating in EPSG:32618, then add the offset back on export and write the CRS to a sidecar, since PLY and OBJ store no CRS.

### What Hausdorff distance is acceptable?
It depends on the asset and the LOD. For the highest-detail level of building geometry, a sub-5 cm mean and sub-15 cm maximum (Hausdorff) distance in metric CRS units is a common gate; coarser levels relax in step with their geometric error. Always assert the tolerance in code so a bad budget fails the batch.

### Can I decimate before reconstructing a surface?
No — decimation operates on triangulated meshes, so the surface must already exist. Clean the point cloud with [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/), reconstruct, then decimate. Decimating a noisy reconstruction just bakes the noise into a smaller, cheaper-to-render mesh.

## Related Guides

- [Optimizing Mesh Triangle Count for Web Rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — platform triangle thresholds and LOD selection
- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — generating the mesh that decimation reduces
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — cleaning the cloud before reconstruction
- [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — preserving UVs through decimation
- [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/) — tiling and streaming the decimated chain

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
