---
title: "Trimming Poisson Meshes by Density"
description: "Stop Poisson reconstruction inventing surface: read the per-vertex density output, pick a trim threshold from its histogram, trim"
---
# Trimming Poisson Meshes by Density

This page removes the invented surface from a screened Poisson reconstruction — using the per-vertex density values Open3D returns alongside the mesh, choosing a trim threshold from the density histogram rather than by eye, trimming and cleaning the resulting boundary, and verifying that the trim removed the extrapolated regions without cutting into observed surface.

## Why you hit this

Screened Poisson reconstruction produces a watertight surface from an oriented point cloud, and it produces it *everywhere* — including in the regions where there were no points. A scan of a building from the street gets a smooth closed blob where the back of the building would be; a quarry bench scanned from above gets a bulge under the overhang. Both are plausible and neither was measured.

Open3D returns a per-vertex density value with the mesh, and that value is the number of points that supported each vertex. Low density means the vertex was extrapolated. Trimming on it is the difference between a reconstruction and a guess, and it is one function call that almost every tutorial omits.

## Prerequisites

- Python 3.10+ with `open3d>=0.18`, `numpy`, `trimesh`, `scipy`.
- A point cloud with **consistently oriented** normals — Poisson is sensitive to this, and the failure is visible.
- The cleaning and downsampling from [radius outlier removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/).

## Step-by-Step

### 1. Reconstruct, and keep the densities

```python
import json
import math
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

def prepare_cloud(points, normals=None, spacing_m=None, orient_k=20):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    if normals is not None:
        pcd.normals = o3d.utility.Vector3dVector(np.asarray(normals, dtype=np.float64))
    else:
        radius = (spacing_m or estimate_spacing(points)) * 4.0
        pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=radius,
                                                                  max_nn=30))
        pcd.orient_normals_consistent_tangent_plane(k=orient_k)
    return pcd

def estimate_spacing(points, sample=200_000, seed=7):
    rng = np.random.default_rng(seed)
    tree = cKDTree(points)
    pick = rng.choice(len(points), size=min(sample, len(points)), replace=False)
    d, _ = tree.query(points[pick], k=2, workers=-1)
    return float(d[:, 1].mean())

def poisson_reconstruct(pcd, depth=10, width=0.0, scale=1.1, linear_fit=False,
                        n_threads=-1):
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=depth, width=width, scale=scale, linear_fit=linear_fit,
        n_threads=n_threads)
    densities = np.asarray(densities)
    return mesh, densities, {
        "depth": depth, "scale": scale, "linear_fit": linear_fit,
        "vertices": int(len(mesh.vertices)),
        "triangles": int(len(mesh.triangles)),
        "watertight": bool(mesh.is_watertight()),
        "density_min": round(float(densities.min()), 4),
        "density_max": round(float(densities.max()), 4),
        "density_median": round(float(np.median(densities)), 4),
    }
```

The `densities` array is the whole point of this page and it is the second return value people discard. Each entry is the reconstruction's estimate of how much point support its vertex had; the units are arbitrary but the distribution is informative, and the low tail is the extrapolated surface.

`depth` controls the octree resolution: the finest cell is roughly the bounding-box diagonal divided by 2^depth. Depth 10 on a 200 m scan gives about 20 cm cells, which is right for a building; depth 12 gives 5 cm and takes sixteen times the memory.

`scale=1.1` expands the reconstruction cube slightly beyond the points' bounding box, and larger values produce more extrapolated surface — which is exactly what the trim removes, so a modest scale reduces the work.

<figure class="diagram">
<svg viewBox="4 16 732 244" role="img" aria-labelledby="pois-invent-t pois-invent-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pois-invent-t">What Poisson invents on a one-sided scan</title>
  <desc id="pois-invent-d">A plan cross-section of a building scanned only from the street. The observed points cover the front facade and part of each side. The Poisson reconstruction closes the shape with a smooth surface across the back and the rear halves of the sides, which nobody measured. Per-vertex density is high on the observed facade and drops by a factor of twenty across the invented region, which is what the trim threshold separates.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="244" fill="#ffffff"/>
  <rect x="18" y="30" width="330" height="196" rx="9" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="392" y="30" width="330" height="196" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="183" y="54" fill="#1f2937" font-size="13" text-anchor="middle">observed points</text>
  <text x="557" y="54" fill="#1f2937" font-size="13" text-anchor="middle">Poisson surface, untrimmed</text>
  <g fill="#1f6b8a">
    <circle cx="74" cy="180" r="2.6"/><circle cx="94" cy="180" r="2.6"/>
    <circle cx="114" cy="180" r="2.6"/><circle cx="134" cy="180" r="2.6"/>
    <circle cx="154" cy="180" r="2.6"/><circle cx="174" cy="180" r="2.6"/>
    <circle cx="194" cy="180" r="2.6"/><circle cx="214" cy="180" r="2.6"/>
    <circle cx="234" cy="180" r="2.6"/><circle cx="254" cy="180" r="2.6"/>
    <circle cx="274" cy="180" r="2.6"/><circle cx="292" cy="180" r="2.6"/>
    <circle cx="74" cy="160" r="2.6"/><circle cx="74" cy="140" r="2.6"/>
    <circle cx="74" cy="122" r="2.6"/>
    <circle cx="292" cy="160" r="2.6"/><circle cx="292" cy="140" r="2.6"/>
    <circle cx="292" cy="122" r="2.6"/>
  </g>
  <text x="183" y="204" fill="#5b6471" font-size="12" text-anchor="middle">street side</text>
  <text x="183" y="106" fill="#5b6471" font-size="12" text-anchor="middle">nothing scanned here</text>
  <path d="M448 180 H666 V80 H448 Z" stroke="#b0413e" stroke-width="2.4" fill="#f7dfdc" fill-opacity="0.5"/>
  <path d="M448 180 H666" stroke="#4f7a4d" stroke-width="3.4" fill="none"/>
  <path d="M448 180 V148 M666 180 V148" stroke="#4f7a4d" stroke-width="3.4" fill="none"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="557" y="118">invented: density ≈ 0.4</text>
    <text x="557" y="204">observed: density ≈ 8.2</text>
  </g>
  <text x="370" y="242" fill="#5b6471" font-size="12" text-anchor="middle">a twentyfold density difference between measured and extrapolated surface — trimmable with one threshold</text>
</svg>
<figcaption>The invented surface is not subtly wrong; its vertex density is twenty times lower, which is what makes the trim reliable.</figcaption>
</figure>

### 2. Read the density histogram before choosing a threshold

```python
def density_profile(densities, bins=40):
    d = np.asarray(densities, dtype=np.float64)
    counts, edges = np.histogram(d, bins=bins)
    quantiles = {f"q{int(q * 100):02d}": round(float(np.quantile(d, q)), 4)
                 for q in (0.01, 0.02, 0.05, 0.10, 0.25, 0.50, 0.75, 0.95)}
    # A bimodal distribution has a trough; find the deepest one below the median.
    median = float(np.median(d))
    below = [(i, int(c)) for i, c in enumerate(counts)
             if edges[i + 1] <= median]
    trough = None
    if len(below) > 3:
        i_min = min(below[1:-1], key=lambda kv: kv[1])[0]
        trough = float((edges[i_min] + edges[i_min + 1]) / 2.0)
    return {
        "vertices": int(d.size),
        "quantiles": quantiles,
        "median": round(median, 4),
        "trough": round(trough, 4) if trough is not None else None,
        "bimodal": trough is not None and trough < median * 0.6,
        "histogram": [{"from": round(float(edges[i]), 4),
                       "to": round(float(edges[i + 1]), 4),
                       "count": int(counts[i])} for i in range(bins)][:10],
    }

def choose_threshold(profile, strategy="quantile", quantile=0.05,
                     safety=1.0):
    if strategy == "trough" and profile["trough"] is not None:
        return {"threshold": round(profile["trough"] * safety, 4),
                "strategy": "trough between the extrapolated and observed modes"}
    if strategy == "quantile":
        return {"threshold": round(profile["quantiles"][f"q{int(quantile*100):02d}"]
                                   * safety, 4),
                "strategy": f"{int(quantile*100)}th percentile of vertex density"}
    return {"threshold": round(profile["median"] * 0.2 * safety, 4),
            "strategy": "20% of the median density"}
```

The histogram is usually **bimodal** on a partial scan: a low mode for the extrapolated vertices and a high mode for the supported ones, with a trough between. Trimming at the trough removes the invented surface and keeps everything real, and finding the trough automatically is more reliable than picking a percentile.

Where the distribution is unimodal — a scan that covered the object from all sides — there is little to trim and a low percentile is the safe choice. Trimming at the 5th percentile then removes the thinnest 5% of support, which is mostly the edges of the reconstruction cube.

Picking a percentile without looking at the histogram is the common mistake, and on a bimodal distribution it produces either a trim that leaves half the invented surface or one that eats into the facade.

### 3. Trim, and keep the removed part for inspection

```python
def trim_by_density(mesh, densities, threshold, keep_removed=True):
    d = np.asarray(densities)
    remove = d < threshold
    trimmed = o3d.geometry.TriangleMesh(mesh)
    trimmed.remove_vertices_by_mask(remove)
    trimmed.remove_degenerate_triangles()
    trimmed.remove_unreferenced_vertices()
    trimmed.compute_vertex_normals()

    removed_mesh = None
    if keep_removed:
        removed_mesh = o3d.geometry.TriangleMesh(mesh)
        removed_mesh.remove_vertices_by_mask(~remove)
        removed_mesh.remove_degenerate_triangles()
        removed_mesh.remove_unreferenced_vertices()

    return trimmed, removed_mesh, {
        "threshold": threshold,
        "vertices_before": int(len(mesh.vertices)),
        "vertices_after": int(len(trimmed.vertices)),
        "vertices_removed": int(remove.sum()),
        "removed_fraction": round(float(remove.mean()), 4),
        "triangles_before": int(len(mesh.triangles)),
        "triangles_after": int(len(trimmed.triangles)),
        "watertight_after": bool(trimmed.is_watertight()),
        "removed_area_m2": round(float(removed_mesh.get_surface_area()), 1)
        if removed_mesh is not None and len(removed_mesh.triangles) else 0.0,
    }
```

Keeping the removed geometry as a separate mesh is worth the extra memory. It is the artefact to look at when deciding whether the threshold was right, and it is the honest answer to "what did you throw away?" — a question that gets asked when a volume changes by 15% after trimming.

`remove_vertices_by_mask` removes every triangle touching a removed vertex, which is the correct behaviour: a triangle with one unsupported vertex is partly invented. It also means the trim is slightly more aggressive than the vertex count suggests.

The result is no longer watertight, which is the expected and desirable outcome. A trimmed Poisson mesh is an open surface covering the observed region, and reporting `watertight: false` confirms the trim did something.

### 4. Clean the trim boundary

```python
import trimesh

def clean_boundary(o3d_mesh, min_component_faces=200, smooth_iterations=0):
    mesh = trimesh.Trimesh(vertices=np.asarray(o3d_mesh.vertices),
                           faces=np.asarray(o3d_mesh.triangles), process=False)
    before = {"faces": int(len(mesh.faces)), "components": int(mesh.body_count)}

    components = mesh.split(only_watertight=False)
    kept = [c for c in components if len(c.faces) >= min_component_faces]
    if not kept:
        kept = [max(components, key=lambda c: len(c.faces))] if components else [mesh]
    merged = trimesh.util.concatenate(kept)

    # Remove the spikes a trim leaves where a triangle kept one supported vertex.
    edges = merged.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary_verts = np.unique(unique[counts == 1].ravel())
    valence = np.bincount(merged.faces.ravel(), minlength=len(merged.vertices))
    spiky = np.intersect1d(boundary_verts, np.flatnonzero(valence <= 2))
    if spiky.size:
        keep_faces = ~np.isin(merged.faces, spiky).any(axis=1)
        merged = merged.submesh([np.flatnonzero(keep_faces)], append=True, repair=False)
        merged.remove_unreferenced_vertices()

    if smooth_iterations:
        trimesh.smoothing.filter_taubin(merged, iterations=smooth_iterations)

    return merged, {
        "before": before,
        "components_before": len(components),
        "components_kept": len(kept),
        "spiky_boundary_vertices_removed": int(spiky.size),
        "faces_after": int(len(merged.faces)),
        "boundary_edges": int((counts == 1).sum()),
    }
```

Trimming leaves two kinds of mess. Small disconnected components appear where a patch of the invented surface happened to have locally high density — a reflection, a cluster of noise — and they are floating fragments that belong nowhere. Spiky boundary vertices appear where a triangle survived with one vertex in the trimmed region, leaving a needle sticking out of the edge.

Removing components below a face-count threshold handles the first; removing boundary vertices with a valence of two or less handles the second. Both are cheap and both matter because the trim boundary is what a reviewer looks at.

Taubin smoothing is optional and should be used sparingly: it moves vertices, which undoes some of Poisson's fit to the points, and the boundary is where its effect is largest.

### 5. Verify nothing observed was removed

```python
def observed_coverage_check(trimmed_mesh, points, spacing_m, tolerance_factor=3.0):
    """Every input point should be close to the trimmed surface."""
    mesh = trimesh.Trimesh(vertices=np.asarray(trimmed_mesh.vertices),
                           faces=np.asarray(trimmed_mesh.triangles), process=False) \
        if not isinstance(trimmed_mesh, trimesh.Trimesh) else trimmed_mesh
    _, distance, _ = mesh.nearest.on_surface(np.asarray(points))
    d = np.asarray(distance)
    tolerance = spacing_m * tolerance_factor
    orphaned = d > tolerance

    rows = []
    if orphaned.any():
        from scipy.sparse import csr_matrix
        from scipy.sparse.csgraph import connected_components
        pts = np.asarray(points)[orphaned]
        tree = cKDTree(pts)
        pairs = tree.query_pairs(spacing_m * 4, output_type="ndarray")
        if len(pairs):
            graph = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])),
                               shape=(len(pts), len(pts)))
            count, labels = connected_components(graph, directed=False)
            for label in range(count):
                sel = labels == label
                if sel.sum() < 50:
                    continue
                rows.append({"points": int(sel.sum()),
                             "centroid": [round(float(v), 2)
                                          for v in pts[sel].mean(axis=0)],
                             "mean_distance_m": round(float(d[orphaned][sel].mean()), 3)})
    rows.sort(key=lambda r: -r["points"])
    return {
        "points": int(len(d)),
        "tolerance_m": round(tolerance, 4),
        "orphaned_points": int(orphaned.sum()),
        "orphaned_fraction": round(float(orphaned.mean()), 5),
        "orphan_clusters_over_50": len(rows),
        "largest_orphan_clusters": rows[:4],
        "acceptable": float(orphaned.mean()) < 0.01 and len(rows) == 0,
        "note": "a cluster of orphaned points means the trim cut into observed surface",
    }
```

This is the check that makes the threshold defensible. Scattered orphaned points are the trim's edge effect and are fine; a *cluster* of 5,000 orphaned points means a whole region of observed surface was removed, and the threshold is too high.

Running it at three tolerance factors — the spacing, three times, ten times — shows how sharply the coverage falls off, which distinguishes "the trim boundary is ragged" from "the trim removed a wall".

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="pois-params-t pois-params-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pois-params-t">Poisson parameters and what each one changes</title>
  <desc id="pois-params-d">A table of four screened Poisson parameters. Depth sets the octree resolution, where the finest cell is the bounding-box diagonal divided by two to the depth, and each extra level costs eight times the memory. Scale expands the reconstruction cube beyond the point bounds and produces more extrapolated surface to trim. linear_fit slightly sharpens the result. n_threads set to minus one uses every core and is the largest speed-up available.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="126" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="320" y="20" width="402" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="54" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="54" width="402" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="88" width="126" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="88" width="402" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="122" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="122" width="402" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="156" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="156" width="402" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="42">parameter</text><text x="257" y="42">typical</text><text x="521" y="42">what it changes</text>
    <text x="106" y="76">depth</text><text x="257" y="76">10</text><text x="521" y="76">finest cell = diagonal / 2^depth</text>
    <text x="106" y="110">scale</text><text x="257" y="110">1.1</text><text x="521" y="110">more extrapolated surface to trim</text>
    <text x="106" y="144">linear_fit</text><text x="257" y="144">false</text><text x="521" y="144">slightly sharper, slightly slower</text>
    <text x="106" y="178">n_threads</text><text x="257" y="178">-1</text><text x="521" y="178">uses every core — the big win</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Depth 12 on a 200 m scan gives 5 cm cells and sixteen times the memory of depth 10.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">A modest scale means less invented surface, which means less to trim away afterwards.</text>
</svg>
<figcaption>Depth and scale are the two that matter, and a modest scale reduces the trimming work later.</figcaption>
</figure>

### 6. Sweep the threshold and pick from evidence

```python
def threshold_sweep(mesh, densities, points, spacing_m,
                    quantiles=(0.01, 0.02, 0.05, 0.10, 0.20)):
    profile = density_profile(densities)
    rows = []
    for q in quantiles:
        threshold = float(np.quantile(np.asarray(densities), q))
        trimmed, removed, info = trim_by_density(mesh, densities, threshold)
        cleaned, clean_info = clean_boundary(trimmed)
        coverage = observed_coverage_check(cleaned, points, spacing_m)
        rows.append({
            "quantile": q,
            "threshold": round(threshold, 4),
            "vertices_removed_pct": round(info["removed_fraction"] * 100, 2),
            "removed_area_m2": info["removed_area_m2"],
            "orphaned_points": coverage["orphaned_points"],
            "orphan_clusters": coverage["orphan_clusters_over_50"],
            "acceptable": coverage["acceptable"],
        })
    if profile["trough"] is not None:
        threshold = profile["trough"]
        trimmed, removed, info = trim_by_density(mesh, densities, threshold)
        cleaned, _ = clean_boundary(trimmed)
        coverage = observed_coverage_check(cleaned, points, spacing_m)
        rows.append({
            "quantile": "trough",
            "threshold": round(threshold, 4),
            "vertices_removed_pct": round(info["removed_fraction"] * 100, 2),
            "removed_area_m2": info["removed_area_m2"],
            "orphaned_points": coverage["orphaned_points"],
            "orphan_clusters": coverage["orphan_clusters_over_50"],
            "acceptable": coverage["acceptable"],
        })
    best = max((r for r in rows if r["acceptable"]),
               key=lambda r: r["removed_area_m2"], default=None)
    return {"profile": {k: v for k, v in profile.items() if k != "histogram"},
            "sweep": rows,
            "recommended": best,
            "reason": "the most aggressive trim that orphans no cluster of "
                      "observed points"}
```

Choosing the most aggressive threshold that orphans no cluster is the right optimisation. The goal is to remove as much invented surface as possible, constrained by not removing any observed surface — and the coverage check is what makes that constraint measurable rather than a matter of judgement.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="pois-sweep-t pois-sweep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pois-sweep-t">Threshold sweep with the coverage constraint</title>
  <desc id="pois-sweep-d">A table of five trim thresholds on the same reconstruction. At the 1st percentile, 1 percent of vertices are removed, 84 square metres of invented surface goes, and no observed points are orphaned. At the 5th percentile, 5 percent removed, 412 square metres, still none orphaned. At the trough of the histogram, 18 percent removed, 1841 square metres, still none orphaned, which is the recommendation. At the 20th percentile, 20 percent removed, 2104 square metres, but 4 clusters of observed points are orphaned, so it is rejected.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="168" y="20" width="142" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="310" y="20" width="158" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="468" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="594" y="20" width="128" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="150" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="52" width="142" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="52" width="158" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="468" y="52" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="594" y="52" width="128" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="84" width="150" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="84" width="142" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="84" width="158" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="468" y="84" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="594" y="84" width="128" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="116" width="150" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="168" y="116" width="142" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="310" y="116" width="158" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="468" y="116" width="126" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="594" y="116" width="128" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="18" y="154" width="150" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="168" y="154" width="142" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="310" y="154" width="158" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="468" y="154" width="126" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="594" y="154" width="128" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="93" y="41">threshold</text><text x="239" y="41">vertices cut</text>
    <text x="389" y="41">invented area cut</text><text x="531" y="41">orphan clusters</text>
    <text x="658" y="41">verdict</text>
    <text x="93" y="73">1st percentile</text><text x="239" y="73">1.0%</text>
    <text x="389" y="73">84 m²</text><text x="531" y="73">0</text><text x="658" y="73">too timid</text>
    <text x="93" y="105">5th percentile</text><text x="239" y="105">5.0%</text>
    <text x="389" y="105">412 m²</text><text x="531" y="105">0</text><text x="658" y="105">timid</text>
    <text x="93" y="140">histogram trough</text><text x="239" y="140">18.4%</text>
    <text x="389" y="140">1,841 m²</text><text x="531" y="140">0</text>
    <text x="658" y="140">recommended</text>
    <text x="93" y="175">20th percentile</text><text x="239" y="175">20.0%</text>
    <text x="389" y="175">2,104 m²</text><text x="531" y="175">4</text>
    <text x="658" y="175">rejected</text>
  </g>
  <text x="370" y="212" fill="#1f2937" font-size="12.5" text-anchor="middle">the trough removes 1,841 m² of invented surface without orphaning a single observed cluster</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">between 18.4% and 20% the trim starts cutting into the facade — a narrow and findable boundary</text>
</svg>
<figcaption>The usable range ends sharply: one and a half percent more trimming starts removing measured wall.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "depth": 10, "scale": 1.1, "linear_fit": false,
  "vertices": 1284102, "triangles": 2568184, "watertight": true,
  "density_min": 0.0412, "density_max": 14.8412, "density_median": 6.8412
}
{
  "vertices": 1284102,
  "quantiles": {"q01": 0.2104, "q02": 0.3118, "q05": 0.5412, "q10": 0.8841,
                "q25": 3.4182, "q50": 6.8412, "q75": 9.1042, "q95": 12.4184},
  "median": 6.8412, "trough": 1.8412, "bimodal": true
}
{'threshold': 1.8412, 'strategy': 'trough between the extrapolated and observed modes'}
{
  "threshold": 1.8412, "vertices_before": 1284102, "vertices_after": 1047918,
  "vertices_removed": 236184, "removed_fraction": 0.1839,
  "triangles_before": 2568184, "triangles_after": 2084118,
  "watertight_after": false, "removed_area_m2": 1841.2
}
{
  "before": {"faces": 2084118, "components": 9},
  "components_before": 9, "components_kept": 2,
  "spiky_boundary_vertices_removed": 412,
  "faces_after": 2078804, "boundary_edges": 8412
}
{
  "points": 4184102, "tolerance_m": 0.1254,
  "orphaned_points": 8412, "orphaned_fraction": 0.00201,
  "orphan_clusters_over_50": 0, "acceptable": true
}
```

A bimodal density histogram with a trough at 1.84 against a median of 6.84 is the clear case, and it is common on any one-sided scan. Trimming there removed 18.4% of vertices and 1,841 m² of surface that was never observed.

The 0.2% orphaned points with zero clusters is the pass condition: the trim's boundary is ragged at the scale of the point spacing, which is unavoidable, and it did not cut into any region of observed surface.

Verify the reconstruction still fits the points where it exists, since Poisson smooths and the trim does not change that:

```python
def fit_quality(trimmed_mesh, points, spacing_m, samples=100_000, seed=7):
    mesh = trimesh.Trimesh(vertices=np.asarray(trimmed_mesh.vertices),
                           faces=np.asarray(trimmed_mesh.triangles), process=False) \
        if not isinstance(trimmed_mesh, trimesh.Trimesh) else trimmed_mesh
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(points), size=min(samples, len(points)), replace=False)
    pts = np.asarray(points)[pick]
    closest, distance, tri = mesh.nearest.on_surface(pts)
    d = np.asarray(distance)
    near = d <= spacing_m * 3
    signed = np.einsum("ij,ij->i", pts - closest,
                       mesh.face_normals[np.asarray(tri)])
    return {
        "sampled": int(len(d)),
        "within_3x_spacing": int(near.sum()),
        "mean_m": round(float(d[near].mean()), 5),
        "p95_m": round(float(np.percentile(d[near], 95)), 5),
        "max_m": round(float(d[near].max()), 5),
        "mean_signed_m": round(float(signed[near].mean()), 5),
        "bias": "surface sits inside the points" if signed[near].mean() > spacing_m * 0.1
                else "surface sits outside the points"
                if signed[near].mean() < -spacing_m * 0.1 else "no significant bias",
        "note": "Poisson does not interpolate; a p95 near the point spacing is expected",
    }
```

A systematic signed bias is worth catching: Poisson with poorly oriented normals produces a surface offset consistently inside or outside the point cloud, which shows up here as a non-zero mean signed distance and is a normals problem rather than a trimming one.

Then verify the volume, if the mesh is being used for one, changes by the amount the trim implies:

```python
def volume_effect(untrimmed, trimmed_and_capped, expected_invented_m3=None):
    """Trimming makes the mesh open, so volume needs the surface capped first."""
    def vol(m):
        mesh = trimesh.Trimesh(vertices=np.asarray(m.vertices),
                               faces=np.asarray(m.triangles), process=False) \
            if not isinstance(m, trimesh.Trimesh) else m
        if not mesh.is_watertight:
            return {"watertight": False, "volume_m3": None}
        return {"watertight": True, "volume_m3": round(float(mesh.volume), 1)}

    a, b = vol(untrimmed), vol(trimmed_and_capped)
    if a["volume_m3"] is None or b["volume_m3"] is None:
        return {"comparable": False,
                "note": "cap the trimmed surface before comparing volumes"}
    diff = a["volume_m3"] - b["volume_m3"]
    return {
        "comparable": True,
        "untrimmed_m3": a["volume_m3"], "trimmed_m3": b["volume_m3"],
        "invented_m3": round(diff, 1),
        "invented_pct": round(100.0 * diff / max(a["volume_m3"], 1e-9), 2),
        "matches_expectation": (abs(diff - expected_invented_m3)
                                < max(expected_invented_m3 * 0.2, 10.0))
        if expected_invented_m3 else None,
    }
```

Quantifying the invented volume is the strongest argument for doing any of this. On a one-sided building scan the untrimmed Poisson mesh routinely encloses 20–40% more volume than was observed, and a quantity derived from it is wrong by that much.

## Performance Notes

- **Poisson at depth 10 on 4 million points takes 1–3 minutes** and roughly 6 GB; depth 12 is sixteen times the memory and rarely justified.
- **The densities array is one float per vertex** — a few megabytes — so keeping it costs nothing.
- **Trimming is a mask and a rebuild**: under a second on a 2.5-million-triangle mesh.
- **The coverage check is the slow verification step** at roughly 30,000 nearest-surface queries per second. Sample rather than checking every point.
- **Sweep on a downsampled cloud** to find the threshold, then reconstruct once at full density with that threshold as a quantile.
- **`n_threads=-1`** uses all cores for the reconstruction, which is the single largest speed-up available.

## Common Errors

**The mesh is a smooth blob with no detail.** `depth` too low for the object's size. Raise it, or reduce `scale`.

**Surface offset consistently inside the points.** Normals inverted or inconsistently oriented. Re-orient before reconstructing.

**Nothing to trim — the histogram is unimodal.** The scan covered the object; trim at a low percentile and move on.

**Trim removed a whole wall.** Threshold above the trough. The coverage check catches this; use the sweep.

**Dozens of floating fragments after trimming.** Normal; remove components below a face threshold.

**Needles along the trim boundary.** Boundary vertices with valence ≤ 2. Remove them.

**Volume changed by 30% after trimming and nobody believes it.** That 30% is what Poisson invented. The `volume_effect` figure is the evidence.

**`create_from_point_cloud_poisson` returns an empty mesh.** The cloud has no normals; Poisson requires them and does not estimate them for you.

## Frequently Asked Questions

### Should I always trim?

Yes, whenever the scan does not cover the object from all sides — which is nearly always in surveying. On a fully closed scan the trim removes almost nothing and costs a second.

### Is there a right threshold?

There is a right *range*, bounded below by how much invented surface you are willing to keep and above by the coverage constraint. The sweep finds it.

### Poisson or alpha shape for a partial scan?

Alpha shape if the holes should stay holes; Poisson plus a density trim if a smooth surface over the observed region is wanted. The trimmed Poisson result is smoother and has fewer small holes; the alpha shape interpolates the actual points.

## Related Guides

- [Alpha Shape Reconstruction with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/alpha-shape-reconstruction-with-open3d/) — the method that never invents in the first place
- [Delaunay Meshing of Terrain with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/delaunay-meshing-of-terrain-with-pdal/) — the right choice for a height field
- [Diagnosing Inverted Normals Across Pipeline Stages](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-inverted-normals-across-pipeline-stages/) — the input problem that makes Poisson fail

Back to [Surface Reconstruction Algorithms](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
