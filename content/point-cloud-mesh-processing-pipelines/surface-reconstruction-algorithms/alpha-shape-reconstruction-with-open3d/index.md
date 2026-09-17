# Alpha Shape Reconstruction with Open3D

This page reconstructs surfaces with genuine concavities — a quarry bench, a bridge soffit, a tunnel portal — using Open3D's alpha shape implementation, choosing alpha from the cloud's point spacing rather than by trial, sweeping several alphas to see which features survive, comparing against ball pivoting and Poisson on the same data, and auditing the holes the method leaves.

## Why you hit this

Delaunay triangulation of terrain produces a height field, which cannot represent an overhang. Poisson reconstruction produces a smooth watertight surface, which invents geometry across openings. Neither is right for a shape with real concavities and real holes — and a quarry face with benches, a bridge with a deck and a soffit, or a structure scanned from outside only all have both.

Alpha shapes are the method that handles this honestly: the reconstruction includes a triangle only where the points support it at the chosen scale, so a genuine gap stays a gap. The cost is that the result is not watertight and the choice of alpha decides everything.

## Prerequisites

- Python 3.10+ with `open3d>=0.18`, `numpy`, `scipy`, `trimesh`.
- A point cloud with reasonably uniform density — alpha shapes are density-sensitive, so [voxel downsampling strategies compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) matters here.
- A cleaned cloud: alpha shapes connect noise to the surface enthusiastically.

## Step-by-Step

### 1. Understand what alpha controls

```python
import json
import math
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

def alpha_meaning(alpha_m, mean_spacing_m):
    """Alpha is a radius: a tetrahedron survives if its circumsphere is smaller."""
    ratio = alpha_m / max(mean_spacing_m, 1e-9)
    if ratio < 1.5:
        behaviour = "fragmented — many points left unconnected"
    elif ratio < 3.0:
        behaviour = "tight — follows the surface, keeps small holes"
    elif ratio < 8.0:
        behaviour = "balanced — usual working range"
    elif ratio < 20.0:
        behaviour = "loose — small concavities and holes filled"
    else:
        behaviour = "approaching the convex hull"
    return {"alpha_m": alpha_m, "mean_spacing_m": round(mean_spacing_m, 4),
            "alpha_over_spacing": round(ratio, 2), "behaviour": behaviour}

def spacing(points, k=2, sample=200_000, seed=7):
    rng = np.random.default_rng(seed)
    tree = cKDTree(points)
    pick = rng.choice(len(points), size=min(sample, len(points)), replace=False)
    d, _ = tree.query(points[pick], k=k, workers=-1)
    nn = d[:, 1]
    return {
        "mean_m": float(nn.mean()),
        "p05_m": float(np.percentile(nn, 5)),
        "p95_m": float(np.percentile(nn, 95)),
        "cv": float(nn.std() / max(nn.mean(), 1e-12)),
        "uniform_enough_for_alpha": float(nn.std() / max(nn.mean(), 1e-12)) < 0.4,
    }

def suggest_alpha(spacing_stats, target="balanced"):
    base = spacing_stats["p95_m"]           # the sparse tail, not the mean
    factors = {"tight": 2.0, "balanced": 4.0, "loose": 10.0}
    return {name: round(base * f, 4) for name, f in factors.items()} | {
        "recommended": round(base * factors[target], 4),
        "derived_from": "95th-percentile nearest-neighbour distance",
    }
```

Alpha is a radius, and the geometric rule is simple: a tetrahedron from the Delaunay tetrahedralisation is kept if its circumscribing sphere has a radius smaller than alpha. Small alpha keeps only tightly packed tetrahedra, so the result hugs the points and leaves holes; large alpha keeps everything and converges on the convex hull.

Deriving alpha from the **95th-percentile** spacing rather than the mean is the same reasoning as in the outlier filters: a value tuned to the dense areas fragments the sparse ones. A cloud with a 0.4 coefficient of variation or worse will not have one good alpha, which is what the `uniform_enough_for_alpha` flag reports.

The four-times-spacing default is a genuinely useful starting point and gets within one sweep of the right answer on most data.

<figure class="diagram">
<svg viewBox="4 16 732 234" role="img" aria-labelledby="alpha-sweep-t alpha-sweep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="alpha-sweep-t">The same bench profile at four alpha values</title>
  <desc id="alpha-sweep-d">Four cross-sections of a quarry bench with an overhang and a 40 centimetre gap where the scanner saw nothing. At alpha equal to 1.5 times the spacing the surface is fragmented into disconnected patches. At 4 times it follows the bench faces, keeps the overhang and keeps the gap open. At 10 times the gap is bridged but the overhang survives. At 30 times the overhang is filled in and the shape approaches its convex hull.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="30" width="168" height="168" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="200" y="30" width="168" height="168" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="382" y="30" width="168" height="168" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="564" y="30" width="158" height="168" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g font-size="12" text-anchor="middle" fill="#1f2937">
    <text x="102" y="52">α = 1.5 × spacing</text>
    <text x="284" y="52">α = 4 × spacing</text>
    <text x="466" y="52">α = 10 × spacing</text>
    <text x="643" y="52">α = 30 × spacing</text>
  </g>
  <g stroke="#1f6b8a" stroke-width="2.2" fill="none">
    <path d="M34 168 H70"/><path d="M82 168 H104"/><path d="M116 166 V128"/>
    <path d="M128 126 H152"/><path d="M162 124 V84"/>
  </g>
  <path d="M216 168 H286 V126 H322 L340 84 H352" stroke="#4f7a4d" stroke-width="2.4" fill="none"/>
  <path d="M322 126 L308 112" stroke="#4f7a4d" stroke-width="2.4" fill="none"/>
  <path d="M398 168 H468 V126 H504 L522 84 H534" stroke="#c46a3d" stroke-width="2.4" fill="none"/>
  <path d="M504 126 L490 112" stroke="#c46a3d" stroke-width="2.4" fill="none"/>
  <path d="M580 168 H650 L706 84 H710" stroke="#b0413e" stroke-width="2.4" fill="none"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="102" y="216">fragmented</text>
    <text x="284" y="216">bench, overhang</text>
    <text x="284" y="232">and gap all correct</text>
    <text x="466" y="216">gap bridged,</text><text x="466" y="232">overhang kept</text>
    <text x="643" y="216">overhang lost —</text><text x="643" y="232">near convex hull</text>
  </g>
  <text x="284" y="112" fill="#1f2937" font-size="11">overhang</text>
  <text x="240" y="150" fill="#1f2937" font-size="11">gap</text>
</svg>
<figcaption>Four times the spacing keeps the features that matter; ten times starts filling gaps and thirty loses the overhang entirely.</figcaption>
</figure>

### 2. Reconstruct at one alpha

```python
def alpha_shape(points, alpha_m, clean=True):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    tetra, point_map = o3d.geometry.TetraMesh.create_from_point_cloud(pcd)
    mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(
        pcd, alpha_m, tetra, point_map)
    if clean:
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_non_manifold_edges()
        mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    return mesh, {
        "alpha_m": alpha_m,
        "vertices": int(len(mesh.vertices)),
        "triangles": int(len(mesh.triangles)),
        "input_points": int(len(points)),
        "vertex_coverage": round(len(mesh.vertices) / max(len(points), 1), 4),
        "watertight": bool(mesh.is_watertight()),
        "edge_manifold": bool(mesh.is_edge_manifold()),
        "components": len(mesh.cluster_connected_triangles()[2]),
    }
```

Building the `TetraMesh` once and reusing it across several alphas is the key efficiency: the Delaunay tetrahedralisation is the expensive part, and it does not depend on alpha. Open3D's convenience overload rebuilds it every call, which makes a sweep ten times slower than it needs to be.

`vertex_coverage` is the diagnostic that says whether alpha is too small: a coverage of 0.4 means 60% of the input points appear in no surviving tetrahedron, so they are simply absent from the result. A good reconstruction has coverage above about 0.9.

Alpha shapes are never watertight on open scans, and reporting `watertight: false` is expected rather than a failure. `edge_manifold` should be true after cleaning, and a false value means the reconstruction produced edges shared by three or more triangles, which breaks most consumers.

### 3. Sweep several alphas and read what changes

```python
def alpha_sweep(points, alphas, reuse_tetra=True):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    tetra, point_map = (o3d.geometry.TetraMesh.create_from_point_cloud(pcd)
                        if reuse_tetra else (None, None))

    rows = []
    for a in alphas:
        if reuse_tetra:
            mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(
                pcd, a, tetra, point_map)
        else:
            mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, a)
        mesh.remove_degenerate_triangles()
        mesh.remove_unreferenced_vertices()
        labels, counts, areas = mesh.cluster_connected_triangles()
        rows.append({
            "alpha_m": round(a, 4),
            "triangles": int(len(mesh.triangles)),
            "vertices": int(len(mesh.vertices)),
            "coverage": round(len(mesh.vertices) / max(len(points), 1), 4),
            "components": int(len(counts)),
            "largest_component_share": round(float(max(counts)) / max(sum(counts), 1), 4)
            if len(counts) else 0.0,
            "surface_area_m2": round(float(sum(areas)), 1),
        })
    for i in range(1, len(rows)):
        prev, cur = rows[i - 1], rows[i]
        cur["area_change_pct"] = round(
            100.0 * (cur["surface_area_m2"] - prev["surface_area_m2"])
            / max(prev["surface_area_m2"], 1e-9), 1)
    return rows

def choose_from_sweep(rows, min_coverage=0.92, max_components=8,
                      area_plateau_pct=4.0):
    """Pick the smallest alpha that covers the points and has stabilised."""
    for i, r in enumerate(rows):
        if r["coverage"] < min_coverage:
            continue
        if r["components"] > max_components:
            continue
        change = r.get("area_change_pct")
        if change is None or abs(change) <= area_plateau_pct:
            return {"chosen_alpha_m": r["alpha_m"], "reason": "first alpha with adequate "
                    "coverage, few components and a stabilised surface area",
                    "row": r}
    return {"chosen_alpha_m": rows[-1]["alpha_m"] if rows else None,
            "reason": "no alpha satisfied the criteria; using the largest tried"}
```

Surface area as a function of alpha is the most informative single curve. At small alpha it rises steeply as more tetrahedra are admitted; it then plateaus over a range where the reconstruction is stable; and it rises again as alpha starts bridging genuine gaps and adding invented surface. The plateau is where the right alpha lies.

Component count tells the same story from the other side. A fragmented reconstruction has hundreds of components; a good one has a handful — the main surface plus a few legitimately separate pieces.

Choosing the **smallest** alpha that satisfies the criteria is the conservative direction: it keeps the genuine holes, and a hole is easier to explain than an invented surface.

### 4. Compare with ball pivoting and Poisson

```python
def ball_pivoting(points, normals=None, radii_multiples=(1.0, 2.0, 4.0),
                  spacing_m=None):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    if normals is not None:
        pcd.normals = o3d.utility.Vector3dVector(np.asarray(normals))
    else:
        pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(
            radius=(spacing_m or 0.1) * 4, max_nn=30))
        pcd.orient_normals_consistent_tangent_plane(k=15)
    radii = [(spacing_m or 0.1) * m for m in radii_multiples]
    mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
        pcd, o3d.utility.DoubleVector(radii))
    mesh.remove_degenerate_triangles()
    mesh.remove_unreferenced_vertices()
    return mesh, {"method": "ball_pivoting", "radii_m": [round(r, 4) for r in radii],
                  "triangles": int(len(mesh.triangles)),
                  "vertices": int(len(mesh.vertices)),
                  "coverage": round(len(mesh.vertices) / max(len(points), 1), 4)}

def poisson(points, normals=None, depth=9, spacing_m=None):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    if normals is not None:
        pcd.normals = o3d.utility.Vector3dVector(np.asarray(normals))
    else:
        pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(
            radius=(spacing_m or 0.1) * 4, max_nn=30))
        pcd.orient_normals_consistent_tangent_plane(k=15)
    mesh, densities = o3d.geometry.TriangleMesh.create_from_poisson_disk_sampling(pcd) \
        if False else o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=depth)
    return mesh, {"method": "poisson", "depth": depth,
                  "triangles": int(len(mesh.triangles)),
                  "vertices": int(len(mesh.vertices)),
                  "watertight": bool(mesh.is_watertight()),
                  "densities": np.asarray(densities)}

METHOD_CHOICE = {
    "open surface with real holes": "alpha shape — keeps holes, never invents",
    "open surface, holes are artefacts": "ball pivoting — follows the surface, "
                                         "smaller holes",
    "closed object, watertight needed": "Poisson — invents across gaps by design",
    "terrain height field": "Delaunay — see the TIN guide",
    "quarry bench or overhang": "alpha shape — the only one that keeps overhangs "
                                "without inventing",
}
```

The three methods differ in what they do about missing data, which is the only question that matters for a partial scan. Alpha shapes leave a hole; ball pivoting leaves a smaller hole and follows the surface more smoothly; Poisson closes it with a plausible surface that was never observed.

For a quarry bench, an alpha shape is the correct answer and Poisson is actively wrong — it will produce a smooth bulge where the overhang's underside was not scanned, and a volume computed from it will be wrong by however much that bulge encloses.

Ball pivoting requires oriented normals and is sensitive to their consistency; on a scan with sections seen from opposite directions, `orient_normals_consistent_tangent_plane` frequently gets it wrong and the result has inverted patches, as described in [diagnosing inverted normals across pipeline stages](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-inverted-normals-across-pipeline-stages/).

### 5. Audit the holes

```python
import trimesh

def hole_audit(o3d_mesh, min_hole_area_m2=0.05):
    mesh = trimesh.Trimesh(vertices=np.asarray(o3d_mesh.vertices),
                           faces=np.asarray(o3d_mesh.triangles), process=False)
    edges = mesh.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary_edges = unique[counts == 1]
    if len(boundary_edges) == 0:
        return {"holes": 0, "watertight": True}

    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components
    verts = np.unique(boundary_edges.ravel())
    remap = {int(v): i for i, v in enumerate(verts)}
    rows = np.array([remap[int(a)] for a, _ in boundary_edges])
    cols = np.array([remap[int(b)] for _, b in boundary_edges])
    graph = csr_matrix((np.ones(len(rows)), (rows, cols)),
                       shape=(len(verts), len(verts)))
    count, labels = connected_components(graph, directed=False)

    loops = []
    for label in range(count):
        sel = verts[labels == label]
        pts = mesh.vertices[sel]
        if len(pts) < 3:
            continue
        centred = pts - pts.mean(axis=0)
        u, s, vh = np.linalg.svd(centred, full_matrices=False)
        planar = centred @ vh[:2].T
        from shapely.geometry import Polygon
        try:
            area = float(Polygon(planar).convex_hull.area)
        except Exception:
            area = 0.0
        perimeter = float(np.linalg.norm(np.diff(pts, axis=0, append=pts[:1]),
                                         axis=1).sum())
        loops.append({"vertices": int(len(sel)),
                      "approx_area_m2": round(area, 3),
                      "perimeter_m": round(perimeter, 2),
                      "significant": area >= min_hole_area_m2})
    loops.sort(key=lambda l: -l["approx_area_m2"])
    return {
        "holes": len(loops),
        "significant_holes": sum(1 for l in loops if l["significant"]),
        "total_hole_area_m2": round(sum(l["approx_area_m2"] for l in loops), 2),
        "largest": loops[:4],
        "outer_boundary_is_largest": bool(loops and loops[0]["perimeter_m"]
                                          > 2 * (loops[1]["perimeter_m"]
                                                 if len(loops) > 1 else 0)),
    }
```

Distinguishing the outer boundary from interior holes is what makes this audit useful. An open scan has one very large boundary loop — the edge of the scanned region — and a number of interior loops, which are the holes proper. The outer loop is expected; the interior ones need a reason.

The total interior hole area is the number to report alongside the reconstruction, because it is the area the surface does not cover. A quarry face with 340 m² of holes is either under-scanned or has genuine overhangs that could not be seen, and the distinction matters for what happens next.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="alpha-read-t alpha-read-d" xmlns="http://www.w3.org/2000/svg">
  <title id="alpha-read-t">Reading an alpha sweep</title>
  <desc id="alpha-read-d">A table of four sweep signals and what each one means. Vertex coverage below 0.9 means alpha is too small and points are absent from the result. A component count in the hundreds means the reconstruction is fragmented. A surface-area plateau across two alpha values is where the right alpha lies. Area growth above ten percent after the plateau means alpha has started bridging genuine gaps.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="230" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="406" y="20" width="316" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="212" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="54" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="406" y="54" width="316" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="88" width="212" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="88" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="406" y="88" width="316" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="122" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="122" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="406" y="122" width="316" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="212" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="156" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="406" y="156" width="316" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="124" y="42">signal</text><text x="318" y="42">value</text><text x="564" y="42">meaning</text>
    <text x="124" y="76">vertex coverage</text><text x="318" y="76">below 0.90</text><text x="564" y="76">alpha too small; points excluded</text>
    <text x="124" y="110">component count</text><text x="318" y="110">in the hundreds</text><text x="564" y="110">fragmented reconstruction</text>
    <text x="124" y="144">surface-area change</text><text x="318" y="144">under 4% per step</text><text x="564" y="144">the plateau — the right alpha</text>
    <text x="124" y="178">surface-area change</text><text x="318" y="178">above 10% per step</text><text x="564" y="178">alpha is bridging real gaps</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Pick the smallest alpha that reaches the plateau; it keeps the genuine holes as holes.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">A hole is easier to explain to a client than an invented surface.</text>
</svg>
<figcaption>The area curve's plateau is the answer, and the smallest alpha that reaches it is the conservative choice.</figcaption>
</figure>

### 6. Build the pipeline

```python
def reconstruct(points, target="balanced", sweep_multiples=(1.5, 2.5, 4.0, 6.0, 10.0),
                min_coverage=0.92):
    stats = spacing(points)
    if not stats["uniform_enough_for_alpha"]:
        note = (f"spacing CV {stats['cv']:.2f} — consider Poisson-disk downsampling "
                f"before the alpha shape")
    else:
        note = "density uniform enough for a single alpha"

    base = stats["p95_m"]
    alphas = [base * m for m in sweep_multiples]
    sweep = alpha_sweep(points, alphas)
    chosen = choose_from_sweep(sweep, min_coverage=min_coverage)

    mesh, info = alpha_shape(points, chosen["chosen_alpha_m"])
    holes = hole_audit(mesh)
    return {
        "spacing": {k: round(v, 4) if isinstance(v, float) else v
                    for k, v in stats.items()},
        "note": note,
        "suggested": suggest_alpha(stats, target=target),
        "sweep": sweep,
        "chosen": chosen,
        "mesh": info,
        "holes": holes,
    }

def export(mesh, out_path):
    o3d.io.write_triangle_mesh(str(out_path), mesh,
                               write_vertex_normals=True, compressed=True)
    return {"path": str(out_path),
            "bytes": Path(out_path).stat().st_size}
```

<figure class="diagram">
<svg viewBox="4 6 732 238" role="img" aria-labelledby="alpha-methods-t alpha-methods-d" xmlns="http://www.w3.org/2000/svg">
  <title id="alpha-methods-t">Three methods on the same partial scan</title>
  <desc id="alpha-methods-d">A table comparing alpha shape, ball pivoting and Poisson reconstruction on a quarry bench scanned from one side. Alpha shape keeps the overhang, leaves 340 square metres of holes where nothing was scanned, and is not watertight. Ball pivoting keeps the overhang, leaves 118 square metres of holes and is not watertight, but needs oriented normals and produced 14 inverted patches. Poisson is watertight with no holes, but invented 410 cubic metres of volume behind the unscanned overhang.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="238" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="20" width="170" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="352" y="20" width="170" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="522" y="20" width="200" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="164" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="52" width="170" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="352" y="52" width="170" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="522" y="52" width="200" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="92" width="164" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="92" width="170" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="352" y="92" width="170" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="522" y="92" width="200" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="132" width="164" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="132" width="170" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="352" y="132" width="170" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="522" y="132" width="200" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="41">property</text><text x="267" y="41">alpha shape</text>
    <text x="437" y="41">ball pivoting</text><text x="622" y="41">Poisson</text>
    <text x="100" y="78">overhang kept</text>
    <text x="267" y="78">yes</text><text x="437" y="78">yes</text><text x="622" y="78">filled in</text>
    <text x="100" y="118">unscanned area</text>
    <text x="267" y="118">340 m² of holes</text><text x="437" y="118">118 m² of holes</text>
    <text x="622" y="118">closed — 410 m³ invented</text>
    <text x="100" y="158">needs normals</text>
    <text x="267" y="158">no</text><text x="437" y="158">yes — 14 inverted patches</text>
    <text x="622" y="158">yes, but tolerant</text>
  </g>
  <text x="370" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">for a volume calculation on a partial scan, the honest hole beats the plausible surface</text>
  <text x="370" y="226" fill="#5b6471" font-size="12" text-anchor="middle">Poisson is right when the object is genuinely closed and was scanned from all sides</text>
</svg>
<figcaption>Poisson's watertight result is its selling point and its hazard: it encloses 410 m³ nobody measured.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "spacing": {"mean_m": 0.0418, "p05_m": 0.0212, "p95_m": 0.0884, "cv": 0.3412,
              "uniform_enough_for_alpha": true},
  "note": "density uniform enough for a single alpha",
  "suggested": {"tight": 0.1768, "balanced": 0.3536, "loose": 0.884,
                "recommended": 0.3536,
                "derived_from": "95th-percentile nearest-neighbour distance"},
  "sweep": [
    {"alpha_m": 0.1326, "triangles": 418204, "coverage": 0.4184, "components": 1842,
     "surface_area_m2": 1841.2},
    {"alpha_m": 0.221, "triangles": 1204118, "coverage": 0.8412, "components": 214,
     "surface_area_m2": 4218.4, "area_change_pct": 129.1},
    {"alpha_m": 0.3536, "triangles": 1841204, "coverage": 0.9612, "components": 7,
     "surface_area_m2": 5104.8, "area_change_pct": 21.0},
    {"alpha_m": 0.5304, "triangles": 1904118, "coverage": 0.9841, "components": 4,
     "surface_area_m2": 5218.4, "area_change_pct": 2.2},
    {"alpha_m": 0.884, "triangles": 1918402, "coverage": 0.9912, "components": 2,
     "surface_area_m2": 5884.1, "area_change_pct": 12.8}
  ],
  "chosen": {"chosen_alpha_m": 0.5304,
             "reason": "first alpha with adequate coverage, few components and a stabilised surface area"},
  "mesh": {"alpha_m": 0.5304, "vertices": 1884102, "triangles": 1904118,
           "vertex_coverage": 0.9841, "watertight": false, "edge_manifold": true,
           "components": 4},
  "holes": {"holes": 41, "significant_holes": 12,
            "total_hole_area_m2": 344.8,
            "outer_boundary_is_largest": true}
}
```

The area plateau is visible in the sweep: 21% growth to alpha 0.35, 2.2% to 0.53, then 12.8% to 0.88. The 2.2% step is the plateau and 0.53 m is the right alpha — the 12.8% jump after it is the reconstruction starting to bridge genuine gaps.

The 12 significant interior holes totalling 345 m² are the honest statement about this scan: those areas were not observed. A Poisson reconstruction would have reported none and covered them.

Verify the reconstruction stays close to the points, because an alpha shape can be locally wrong where tetrahedra span a thin feature:

```python
def fidelity_to_points(o3d_mesh, points, samples=100_000, seed=7):
    mesh = trimesh.Trimesh(vertices=np.asarray(o3d_mesh.vertices),
                           faces=np.asarray(o3d_mesh.triangles), process=False)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(points), size=min(samples, len(points)), replace=False)
    _, d_point_to_mesh, _ = mesh.nearest.on_surface(points[pick])
    surface_pts = trimesh.sample.sample_surface(mesh, min(samples, 100_000), seed=seed)[0]
    tree = cKDTree(points)
    d_mesh_to_point, _ = tree.query(surface_pts, k=1, workers=-1)
    return {
        "points_to_mesh": {
            "mean_m": round(float(np.asarray(d_point_to_mesh).mean()), 5),
            "p95_m": round(float(np.percentile(d_point_to_mesh, 95)), 5),
            "max_m": round(float(np.asarray(d_point_to_mesh).max()), 5),
        },
        "mesh_to_points": {
            "mean_m": round(float(d_mesh_to_point.mean()), 5),
            "p95_m": round(float(np.percentile(d_mesh_to_point, 95)), 5),
            "max_m": round(float(d_mesh_to_point.max()), 5),
        },
        "interpolates_points": float(np.percentile(d_point_to_mesh, 95)) < 1e-6,
        "note": "an alpha shape's vertices ARE input points, so points-to-mesh should "
                "be near zero for covered points; mesh-to-points shows where the "
                "surface spans a gap",
    }
```

Alpha-shape vertices are input points, so the points-to-mesh distance should be essentially zero for every covered point — a non-zero p95 means points were excluded, which the coverage figure should already have shown. The mesh-to-points direction is the informative one: a large value means a triangle spans an area with no points under it, which is alpha bridging a gap.

Then verify the overhangs survived, which is the reason this method was chosen:

```python
def overhang_check(o3d_mesh, min_overhang_area_m2=1.0):
    """Faces whose normal points downwards are overhangs — a height field has none."""
    mesh = trimesh.Trimesh(vertices=np.asarray(o3d_mesh.vertices),
                           faces=np.asarray(o3d_mesh.triangles), process=False)
    nz = mesh.face_normals[:, 2]
    down = nz < -0.2
    areas = mesh.area_faces
    from scipy.sparse.csgraph import connected_components
    adjacency = mesh.face_adjacency
    keep_edges = adjacency[down[adjacency[:, 0]] & down[adjacency[:, 1]]]
    labels = np.full(len(mesh.faces), -1)
    if len(keep_edges):
        from scipy.sparse import csr_matrix
        graph = csr_matrix((np.ones(len(keep_edges)),
                            (keep_edges[:, 0], keep_edges[:, 1])),
                           shape=(len(mesh.faces), len(mesh.faces)))
        count, comp = connected_components(graph, directed=False)
        labels = np.where(down, comp, -1)
    patches = []
    for label in np.unique(labels[labels >= 0]):
        sel = labels == label
        patches.append({"faces": int(sel.sum()),
                        "area_m2": round(float(areas[sel].sum()), 2)})
    patches.sort(key=lambda p: -p["area_m2"])
    significant = [p for p in patches if p["area_m2"] >= min_overhang_area_m2]
    return {
        "downward_facing_faces": int(down.sum()),
        "downward_area_m2": round(float(areas[down].sum()), 1),
        "overhang_patches": len(patches),
        "significant_patches": len(significant),
        "largest": significant[:4],
        "height_field_impossible": bool(down.sum() > 0),
    }
```

Counting downward-facing area is the direct test that the reconstruction represents something a raster or a TIN could not. A quarry bench reconstruction with zero downward area means either the scan never saw the undersides or alpha was large enough to fill them — and in both cases the method's advantage was not realised.

## Performance Notes

- **The Delaunay tetrahedralisation dominates**: about 2–5 seconds per million points, and it is done once. Reuse it across the sweep.
- **Each alpha extraction is fast** — under a second per million tetrahedra — which is what makes a five-point sweep cheap.
- **Memory is the constraint.** A tetrahedralisation of 5 million points needs several gigabytes; downsample to 1–3 million for a sweep and reconstruct at full density once alpha is chosen.
- **Non-uniform density is the real limitation.** Poisson-disk downsampling first, at the cost of a slower reduction, gives a cloud where one alpha works everywhere.
- **Clean before reconstructing.** A single noise point 2 m off the surface creates a tetrahedron that reaches it and a spike in the result.
- **Ball pivoting is slower than an alpha sweep** and needs normals; try alpha first.

## Common Errors

**Coverage of 0.4 and thousands of components.** Alpha too small. Multiply by two or three.

**The result is a convex hull.** Alpha too large. The sweep's area curve shows where this begins.

**Spikes reaching away from the surface.** Noise points. Filter first — see [radius outlier removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/).

**Overhangs disappeared.** Alpha large enough to fill them; or the scan never saw them, which the hole audit distinguishes.

**`edge_manifold: false`.** Non-manifold edges from the extraction. `remove_non_manifold_edges` handles most; a persistent case means duplicate input points.

**Out of memory on a 20-million-point cloud.** The tetrahedralisation. Downsample.

**Two alphas give the same result.** The sweep values are too close together relative to the spacing; use multiplicative steps.

## Frequently Asked Questions

### Is there one alpha for a whole site?

Only if the density is uniform. A site scanned with both a terrestrial scanner and a drone has two density regimes and needs either separate reconstructions or a Poisson-disk downsample to a common spacing first.

### Alpha shape or ball pivoting?

Ball pivoting produces a tidier surface with fewer spurious holes when the normals are good. Alpha shapes need no normals and are more predictable. For a first reconstruction of unfamiliar data, alpha.

### Can I fill the holes afterwards?

Yes, and it should be a separate, visible step — `trimesh`'s hole filling or a Poisson pass over the alpha result. Keeping the fill separate means the deliverable can state which surface was measured and which was interpolated.

## Related Guides

- [Trimming Poisson Meshes by Density](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/trimming-poisson-meshes-by-density/) — making Poisson honest about unobserved regions
- [Delaunay Meshing of Terrain with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/delaunay-meshing-of-terrain-with-pdal/) — the right method when the surface is a height field
- [Radius Outlier Removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/) — the cleaning this depends on

Back to [Surface Reconstruction Algorithms](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
