# Delaunay Meshing of Terrain with PDAL

This page builds a triangulated irregular network from a ground-classified point cloud using PDAL's `filters.delaunay` — thinning the input so the TIN is usable, removing the long triangles that span data gaps and the convex hull's concavities, respecting breaklines where the terrain has a sharp edge, and verifying the surface against control points.

## Why you hit this

A TIN is the standard terrain deliverable and the honest one: its vertices are the measured points, so the surface interpolates observations rather than smoothing them. A raster DTM is easier to consume and has already made an interpolation decision on your behalf.

The two things that go wrong are both about what Delaunay triangulation does at the edges of the data. It triangulates the **convex hull** of the input, so a river, a building footprint or a survey boundary that is concave gets bridged by long thin triangles spanning the gap — and those triangles look like terrain, get exported, and end up in a volume calculation.

## Prerequisites

- PDAL 2.6+ with `filters.delaunay`; Python 3.10+ with `numpy`, `trimesh`, `shapely`, `scipy`.
- A ground-classified cloud — see [ground classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/).
- Breaklines and a survey boundary, if they exist, as a vector layer.

## Step-by-Step

### 1. Thin the ground points before triangulating

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np

def thin_ground(las_path, out_path, cell_m=1.0, method="voxelcentroidnearestneighbor"):
    """A TIN from every ground point has a triangle per point; thin to the terrain's scale."""
    stages = [
        str(las_path),
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": f"filters.{method}", "cell": float(cell_m)},
        {"type": "writers.las", "filename": str(out_path),
         "compression": "laszip", "forward": "all"},
    ]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    meta = Path(out_path).with_suffix(".meta.json")
    subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta)],
                   check=True, capture_output=True)
    summary = json.loads(subprocess.run(["pdal", "info", "--summary", str(out_path)],
                                        capture_output=True, text=True,
                                        check=True).stdout)["summary"]
    return {"path": str(out_path), "points": int(summary["num_points"]),
            "cell_m": cell_m,
            "triangles_expected": int(summary["num_points"] * 2)}

def thinning_target(density_per_m2, terrain_detail_m=1.0, max_triangles=4_000_000,
                    area_m2=1_000_000):
    """Pick a cell size from the terrain's detail scale and a triangle budget."""
    by_detail = terrain_detail_m / 2.0
    points_at_detail = area_m2 / (by_detail ** 2)
    by_budget = math.sqrt(area_m2 / (max_triangles / 2.0))
    cell = max(by_detail, by_budget)
    return {"cell_from_detail_m": round(by_detail, 3),
            "cell_from_budget_m": round(by_budget, 3),
            "chosen_cell_m": round(cell, 3),
            "expected_points": int(area_m2 / cell ** 2),
            "expected_triangles": int(2 * area_m2 / cell ** 2),
            "limited_by": "triangle budget" if by_budget > by_detail else "terrain detail"}
```

Triangulating every ground point is the mistake to avoid. A 1 km tile at 40 points/m² has 22 million ground points, which produces about 44 million triangles — a mesh nothing will open, describing a surface whose real information content is a few hundred thousand triangles.

`filters.voxelcentroidnearestneighbor` is the right thinner here because it keeps original points, as discussed in [voxel downsampling strategies compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — a TIN whose vertices are synthetic averages is no longer an interpolation of observations.

The cell size should come from the terrain's own detail scale, not from a triangle budget, whenever the budget allows it. Terrain features of interest at 1 m need a 0.5 m cell; a flat floodplain is fully described at 2 m and a 0.5 m cell just adds noise-level triangles.

<figure class="diagram">
<svg viewBox="4 6 732 226" role="img" aria-labelledby="tin-thin-t tin-thin-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tin-thin-t">Thinning cell against TIN size and fidelity</title>
  <desc id="tin-thin-d">A table of four thinning cell sizes on a one square kilometre tile with 40 points per square metre. No thinning gives 22 million points and 44 million triangles, unusable, with a vertical accuracy of 2 centimetres. A 0.5 metre cell gives 4 million points and 8 million triangles at 2.4 centimetres. A 1 metre cell gives 1 million points and 2 million triangles at 3.1 centimetres. A 2 metre cell gives 250 thousand points and 500 thousand triangles at 6.8 centimetres, which starts to lose kerbs and ditches.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="226" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="168" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="294" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="20" width="140" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="560" y="20" width="162" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="150" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="168" y="52" width="126" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="294" y="52" width="126" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="420" y="52" width="140" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="52" width="162" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="150" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="168" y="86" width="126" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="294" y="86" width="126" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="420" y="86" width="140" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="86" width="162" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="120" width="150" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="120" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="294" y="120" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="420" y="120" width="140" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="120" width="162" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="150" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="154" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="294" y="154" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="420" y="154" width="140" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="560" y="154" width="162" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="93" y="41">thinning cell</text><text x="231" y="41">points</text>
    <text x="357" y="41">triangles</text><text x="490" y="41">vertical RMSE</text>
    <text x="641" y="41">usable?</text>
    <text x="93" y="74">none</text><text x="231" y="74">22.0 M</text>
    <text x="357" y="74">44.0 M</text><text x="490" y="74">2.0 cm</text><text x="641" y="74">no</text>
    <text x="93" y="108">0.5 m</text><text x="231" y="108">4.0 M</text>
    <text x="357" y="108">8.0 M</text><text x="490" y="108">2.4 cm</text><text x="641" y="108">heavy</text>
    <text x="93" y="142">1.0 m</text><text x="231" y="142">1.0 M</text>
    <text x="357" y="142">2.0 M</text><text x="490" y="142">3.1 cm</text><text x="641" y="142">yes</text>
    <text x="93" y="176">2.0 m</text><text x="231" y="176">250 k</text>
    <text x="357" y="176">500 k</text><text x="490" y="176">6.8 cm</text>
    <text x="641" y="176">yes, loses kerbs</text>
  </g>
  <text x="370" y="214" fill="#5b6471" font-size="12" text-anchor="middle">22× fewer triangles for 1.1 cm of accuracy — the unthinned TIN's extra points describe noise</text>
</svg>
<figcaption>The unthinned TIN is 22 times larger and 1 cm more accurate, and the 1 cm is the survey's own noise.</figcaption>
</figure>

### 2. Triangulate

```python
def delaunay_mesh(thinned_las, out_ply):
    stages = [
        str(thinned_las),
        {"type": "filters.delaunay"},
        {"type": "writers.ply", "filename": str(out_ply),
         "faces": True, "storage_mode": "little endian"},
    ]
    spec = Path(out_ply).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    proc = subprocess.run(["pdal", "pipeline", str(spec)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"pdal failed: {proc.stderr[-400:]}")
    import trimesh
    mesh = trimesh.load(out_ply, process=False, force="mesh")
    return {"path": str(out_ply), "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "bbox_m": [round(float(v), 2) for v in
                       (mesh.vertices.max(axis=0) - mesh.vertices.min(axis=0))]}
```

`filters.delaunay` triangulates in the XY plane and lifts the result to Z, which is exactly right for terrain: the triangulation is 2D, so there is no ambiguity about which points connect, and the surface is single-valued in Z by construction.

`faces: True` on the PLY writer is required; without it the output is a point cloud in PLY clothing and the triangulation is discarded silently.

The count of faces should be close to twice the vertex count for a planar triangulation — a 1-million-vertex TIN has about 2 million triangles — and a figure far from that means the input had duplicate XY positions, which Delaunay handles by dropping them.

### 3. Remove the long triangles

```python
import trimesh

def edge_length_stats(mesh):
    tri = mesh.vertices[mesh.faces]
    e = np.stack([
        np.linalg.norm(tri[:, 1, :2] - tri[:, 0, :2], axis=1),
        np.linalg.norm(tri[:, 2, :2] - tri[:, 1, :2], axis=1),
        np.linalg.norm(tri[:, 0, :2] - tri[:, 2, :2], axis=1),
    ], axis=1)
    longest = e.max(axis=1)
    return {
        "faces": int(len(mesh.faces)),
        "median_longest_edge_m": round(float(np.median(longest)), 3),
        "p95_longest_edge_m": round(float(np.percentile(longest, 95)), 3),
        "p999_longest_edge_m": round(float(np.percentile(longest, 99.9)), 3),
        "max_longest_edge_m": round(float(longest.max()), 3),
        "_longest": longest,
    }

def remove_long_triangles(mesh, max_edge_m=None, percentile=99.5, factor=4.0):
    """Two thresholds: an absolute one, or a multiple of the typical edge."""
    stats = edge_length_stats(mesh)
    longest = stats["_longest"]
    if max_edge_m is None:
        max_edge_m = max(stats["median_longest_edge_m"] * factor,
                         float(np.percentile(longest, percentile)))
    keep = longest <= max_edge_m
    trimmed = mesh.submesh([np.flatnonzero(keep)], append=True, repair=False)
    trimmed.remove_unreferenced_vertices()
    return trimmed, {
        "threshold_m": round(float(max_edge_m), 3),
        "faces_before": int(len(mesh.faces)),
        "faces_after": int(len(trimmed.faces)),
        "faces_removed": int((~keep).sum()),
        "removed_fraction": round(float((~keep).mean()), 5),
        "removed_area_m2": round(float(mesh.area_faces[~keep].sum()), 1),
    }
```

Removing triangles by longest **horizontal** edge, not by 3D edge length, is the detail that makes this work on sloped terrain. A steep embankment has genuinely long 3D edges and short horizontal ones; a gap-spanning triangle has a long horizontal edge whatever its slope.

A threshold of four times the median edge is a reasonable automatic choice and errs towards keeping triangles. The absolute alternative — "no edge longer than 8 m" — is better when the thinning cell is known, because a 1 m cell means a legitimate triangle has edges of about 1–2 m and anything over 6 m spans a gap.

The `removed_area_m2` figure is the one to report: it is the area of the surface that was a fiction, and on a tile with a river it can be tens of thousands of square metres.

### 4. Trim to the real boundary, not the convex hull

```python
from shapely.geometry import MultiPoint, Point, Polygon
from shapely.prepared import prep

def concave_boundary(points_xy, alpha_m=3.0, simplify_m=0.5):
    """Morphological closing gives a concave hull with holes."""
    mp = MultiPoint([tuple(p) for p in points_xy])
    hull = mp.buffer(alpha_m).buffer(-alpha_m)
    if hull.is_empty:
        return None
    if hull.geom_type == "MultiPolygon":
        hull = max(hull.geoms, key=lambda g: g.area)
    return hull.simplify(simplify_m, preserve_topology=True)

def trim_to_boundary(mesh, boundary_polygon, sample_centroids=True):
    centroids = mesh.triangles_center[:, :2]
    prepared = prep(boundary_polygon)
    inside = np.array([prepared.contains(Point(c)) for c in centroids])
    trimmed = mesh.submesh([np.flatnonzero(inside)], append=True, repair=False)
    trimmed.remove_unreferenced_vertices()
    return trimmed, {
        "faces_before": int(len(mesh.faces)),
        "faces_after": int(len(trimmed.faces)),
        "faces_outside_boundary": int((~inside).sum()),
        "boundary_area_m2": round(float(boundary_polygon.area), 1),
        "hull_area_m2": round(float(MultiPoint(
            [tuple(p) for p in mesh.vertices[:, :2][::100]]).convex_hull.area), 1),
    }

def trim_to_supplied_boundary(mesh, boundary_gpkg, layer=None, buffer_m=0.0):
    import geopandas as gpd
    gdf = gpd.read_file(boundary_gpkg, layer=layer)
    poly = gdf.geometry.union_all()
    if buffer_m:
        poly = poly.buffer(buffer_m)
    return trim_to_boundary(mesh, poly)
```

The convex hull problem is the main reason a raw Delaunay TIN is not a deliverable. A survey following a road produces an L-shaped or crescent-shaped point set, and the convex hull fills in the concavity with triangles that interpolate across ground nobody surveyed.

Where a survey boundary exists, use it — it is authoritative and the recipient expects the deliverable to match it. Where one does not, the morphological closing produces a concave hull that follows the data, and the `alpha_m` parameter controls how tightly: 3 m follows the outline of a 1 m-thinned cloud closely, and 20 m produces something near the convex hull.

Testing the triangle **centroid** rather than its vertices keeps the result clean at the boundary: a triangle with two vertices inside and one outside is a boundary triangle, and whether to keep it is decided by where most of it lies.

### 5. Respect the breaklines

```python
def constrained_triangulation(points_xyz, breaklines, boundary=None):
    """Delaunay honours no edges; a constrained triangulation does."""
    import triangle as tr
    import geopandas as gpd
    from shapely.geometry import LineString

    vertices = list(points_xyz[:, :2])
    z_values = list(points_xyz[:, 2])
    segments = []

    for line in breaklines:
        coords = list(line.coords)
        start = len(vertices)
        for i, (x, y, *rest) in enumerate(
                (c if len(c) == 3 else (c[0], c[1], np.nan) for c in coords)):
            vertices.append((x, y))
            z_values.append(rest[0] if rest else np.nan)
            if i > 0:
                segments.append((start + i - 1, start + i))

    spec = {"vertices": np.asarray(vertices, dtype=np.float64)}
    if segments:
        spec["segments"] = np.asarray(segments, dtype=np.int32)
    result = tr.triangulate(spec, "p" if segments else "")

    verts2d = np.asarray(result["vertices"])
    faces = np.asarray(result["triangles"])
    z = np.asarray(z_values, dtype=np.float64)
    if len(z) < len(verts2d):
        z = np.concatenate([z, np.full(len(verts2d) - len(z), np.nan)])
    missing = ~np.isfinite(z)
    if missing.any():
        from scipy.interpolate import griddata
        known = np.isfinite(z)
        z[missing] = griddata(verts2d[known], z[known], verts2d[missing],
                             method="linear")
        still = ~np.isfinite(z)
        if still.any():
            z[still] = griddata(verts2d[known], z[known], verts2d[still],
                                method="nearest")
    verts3d = np.column_stack([verts2d, z])
    return trimesh.Trimesh(vertices=verts3d, faces=faces, process=False), {
        "input_points": int(len(points_xyz)),
        "breakline_vertices": int(len(vertices) - len(points_xyz)),
        "segments_enforced": len(segments),
        "faces": int(len(faces)),
    }
```

A plain Delaunay triangulation has no concept of a required edge, so a kerb line running diagonally across the point pattern gets triangulated *across*, rounding the kerb into a ramp. A constrained triangulation forces the breakline's segments to appear as mesh edges, which preserves the discontinuity.

Breaklines matter most for exactly the features a terrain model is used to check: kerbs, retaining walls, ditch inverts, top and toe of embankments. Without them the TIN's own vertical accuracy can be 3 cm while a kerb is 8 cm out of position.

PDAL's `filters.delaunay` does not accept constraints, which is why this step drops to the `triangle` library. That is a reasonable trade for the small number of tiles where breaklines exist.

<figure class="diagram">
<svg viewBox="4 6 732 210" role="img" aria-labelledby="tin-trim-t tin-trim-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tin-trim-t">Two trimming steps and what each removes</title>
  <desc id="tin-trim-d">A table of three trimming approaches for a Delaunay TIN. Long-edge removal by horizontal edge length removes most of the convex-hull fill and also removes genuine triangles across data gaps. Trimming to a supplied survey boundary removes exactly the invented area. A concave hull from morphological closing is the fallback when no boundary exists, and its tightness is controlled by the alpha value.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="210" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="244" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="262" y="20" width="248" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="510" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="244" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="262" y="54" width="248" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="510" y="54" width="212" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="88" width="244" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="262" y="88" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="88" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="244" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="262" y="122" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="122" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="140" y="42">step</text><text x="386" y="42">removes</text><text x="616" y="42">leaves behind</text>
    <text x="140" y="76">long horizontal edges</text><text x="386" y="76">most hull fill and gap spans</text><text x="616" y="76">a fringe at the concavity</text>
    <text x="140" y="110">supplied survey boundary</text><text x="386" y="110">exactly the invented area</text><text x="616" y="110">nothing — it is authoritative</text>
    <text x="140" y="144">concave hull, alpha closing</text><text x="386" y="144">area the data does not cover</text><text x="616" y="144">depends on the alpha value</text>
  </g>
  <text x="20" y="176" fill="#1f2937" font-size="12.5">Test the triangle centroid rather than its vertices, so boundary triangles are decided by where most of them lie.</text>
  <text x="20" y="198" fill="#5b6471" font-size="12">Remove by horizontal edge length, not 3D length: a steep embankment has long 3D edges legitimately.</text>
</svg>
<figcaption>Long-edge removal gets most of the way; only a real boundary gets the extent exactly right.</figcaption>
</figure>

### 6. Verify against control and against the points

```python
def vertical_accuracy(mesh, control_points, tolerance_m=0.10):
    """Sample the TIN at surveyed positions."""
    origins = np.array([[cp["x"], cp["y"], 1e5] for cp in control_points])
    directions = np.tile(np.array([0.0, 0.0, -1.0]), (len(control_points), 1))
    locations, index_ray, _ = mesh.ray.intersects_location(origins, directions,
                                                           multiple_hits=False)
    rows = []
    hit = {int(i): loc for i, loc in zip(index_ray, locations)}
    for i, cp in enumerate(control_points):
        if i not in hit:
            rows.append({"id": cp["id"], "status": "outside the TIN"})
            continue
        z = float(hit[i][2])
        rows.append({"id": cp["id"], "tin_m": round(z, 3), "control_m": cp["z"],
                     "residual_m": round(z - cp["z"], 3)})
    resid = np.array([r["residual_m"] for r in rows if "residual_m" in r])
    if resid.size == 0:
        return {"measurable": False, "rows": rows}
    return {
        "measurable": True, "points": len(rows), "with_value": int(resid.size),
        "mean_m": round(float(resid.mean()), 4),
        "rmse_m": round(float(np.sqrt((resid ** 2).mean())), 4),
        "p95_abs_m": round(float(np.percentile(np.abs(resid), 95)), 4),
        "within_tolerance": int((np.abs(resid) <= tolerance_m).sum()),
        "worst": sorted((r for r in rows if "residual_m" in r),
                        key=lambda r: -abs(r["residual_m"]))[:3],
    }

def fidelity_to_input(mesh, original_ground_points, samples=100_000, seed=7):
    """The TIN must be close to the points it was thinned from, not just its own vertices."""
    from scipy.spatial import cKDTree
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(original_ground_points),
                      size=min(samples, len(original_ground_points)), replace=False)
    pts = original_ground_points[pick]
    origins = np.column_stack([pts[:, 0], pts[:, 1], np.full(len(pts), 1e5)])
    directions = np.tile(np.array([0.0, 0.0, -1.0]), (len(pts), 1))
    locations, index_ray, _ = mesh.ray.intersects_location(origins, directions,
                                                           multiple_hits=False)
    resid = np.full(len(pts), np.nan)
    for i, loc in zip(index_ray, locations):
        resid[i] = loc[2] - pts[i, 2]
    valid = np.isfinite(resid)
    return {
        "sampled": int(len(pts)), "hit": int(valid.sum()),
        "missed_fraction": round(float((~valid).mean()), 4),
        "mean_m": round(float(resid[valid].mean()), 4),
        "rmse_m": round(float(np.sqrt((resid[valid] ** 2).mean())), 4),
        "p95_abs_m": round(float(np.percentile(np.abs(resid[valid]), 95)), 4),
        "max_abs_m": round(float(np.abs(resid[valid]).max()), 4),
    }
```

Checking the TIN against the **full** ground cloud, not only against control, is what quantifies the thinning's cost. The control points say whether the surface is correct where it was measured independently; the full-cloud residual says how much detail the thinning discarded, and the two answer different questions.

The `missed_fraction` from the ray casting is a useful by-product: a ground point with no TIN above or below it is in a region the trimming removed, which is either correct — the point was outside the boundary — or a sign the trimming was too aggressive.

<figure class="diagram">
<svg viewBox="4 16 732 246" role="img" aria-labelledby="tin-hull-t tin-hull-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tin-hull-t">Convex hull, long-edge removal and boundary trimming</title>
  <desc id="tin-hull-d">Three plan views of an L-shaped road survey. The raw Delaunay triangulation fills the concave notch of the L with long triangles, adding 14200 square metres of invented surface. Removing triangles with a horizontal edge over six metres removes most of the notch but leaves a fringe and also removes genuine triangles across a data gap in the road. Trimming to the supplied survey boundary removes exactly the invented area and keeps everything inside it.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="30" width="224" height="196" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="258" y="30" width="224" height="196" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="498" y="30" width="224" height="196" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g font-size="12.5" text-anchor="middle" fill="#1f2937">
    <text x="130" y="52">raw Delaunay</text>
    <text x="370" y="52">long-edge removal</text>
    <text x="610" y="52">boundary trim</text>
  </g>
  <path d="M46 196 H214 V150 H120 V72 H46 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.8"/>
  <path d="M120 72 L214 150" stroke="#b0413e" stroke-width="1.6" fill="none"/>
  <path d="M120 72 L214 196" stroke="#b0413e" stroke-width="1.6" fill="none"/>
  <path d="M46 72 L214 150" stroke="#b0413e" stroke-width="1.6" fill="none"/>
  <path d="M286 196 H454 V150 H360 V72 H286 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.8"/>
  <path d="M360 100 L392 132" stroke="#c46a3d" stroke-width="1.6" fill="none"/>
  <path d="M526 196 H694 V150 H600 V72 H526 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.8"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="244">+14,200 m² invented</text>
    <text x="370" y="244">+340 m² fringe left</text>
    <text x="610" y="244">exact — 0 m² invented</text>
  </g>
  <text x="182" y="120" fill="#b0413e" font-size="11.5" text-anchor="middle">hull fill</text>
  <text x="404" y="124" fill="#9a4f26" font-size="11.5" text-anchor="middle">fringe</text>
</svg>
<figcaption>Long-edge removal gets most of the way; only a real boundary gets the extent exactly right.</figcaption>
</figure>

## Expected Output & Verification

```text
{'cell_from_detail_m': 0.5, 'cell_from_budget_m': 0.707, 'chosen_cell_m': 0.707,
 'expected_points': 2000000, 'expected_triangles': 4000000,
 'limited_by': 'triangle budget'}
{'path': 'work/ground_thin.laz', 'points': 1004182, 'cell_m': 1.0,
 'triangles_expected': 2008364}
{'path': 'work/tin_raw.ply', 'vertices': 1004182, 'faces': 2008218,
 'bbox_m': [1000.02, 1000.04, 84.12]}
{'threshold_m': 6.412, 'faces_before': 2008218, 'faces_after': 1984104,
 'faces_removed': 24114, 'removed_fraction': 0.01201, 'removed_area_m2': 14842.4}
{'faces_before': 1984104, 'faces_after': 1978842, 'faces_outside_boundary': 5262,
 'boundary_area_m2': 984218.4, 'hull_area_m2': 999104.2}
{
  "measurable": true, "points": 34, "with_value": 34,
  "mean_m": -0.0084, "rmse_m": 0.0312, "p95_abs_m": 0.0588,
  "within_tolerance": 34
}
{'sampled': 100000, 'hit': 99418, 'missed_fraction': 0.0058,
 'mean_m': 0.0012, 'rmse_m': 0.0308, 'p95_abs_m': 0.0604, 'max_abs_m': 0.3812}
```

Removing 1.2% of the faces recovered 14,842 m² of invented surface, which is 1.5% of the tile — and that is the number worth quoting, because it would otherwise have contributed to any area or volume computed from this TIN.

The 3.1 cm RMSE against control and the 3.1 cm RMSE against the full ground cloud agreeing closely is a good sign: the thinning cost roughly the same as the survey's own noise, so the TIN is as accurate as its input allows.

Verify the mesh is topologically sound, since a TIN with duplicate or degenerate faces breaks downstream consumers:

```python
def topology_check(mesh, min_area_m2=1e-6):
    areas = mesh.area_faces
    tri = mesh.vertices[mesh.faces]
    e = np.stack([
        np.linalg.norm(tri[:, 1] - tri[:, 0], axis=1),
        np.linalg.norm(tri[:, 2] - tri[:, 1], axis=1),
        np.linalg.norm(tri[:, 0] - tri[:, 2], axis=1),
    ], axis=1)
    s = e.sum(axis=1) / 2.0
    inradius = np.divide(areas, np.maximum(s, 1e-12))
    aspect = e.max(axis=1) / np.maximum(inradius * 2.0, 1e-12)

    vertical = np.abs(mesh.face_normals[:, 2]) < 1e-6
    return {
        "faces": int(len(mesh.faces)),
        "degenerate_faces": int((areas < min_area_m2).sum()),
        "vertical_faces": int(vertical.sum()),
        "duplicate_faces": int(len(mesh.faces)
                               - len(np.unique(np.sort(mesh.faces, axis=1), axis=0))),
        "unreferenced_vertices": int(len(mesh.vertices)
                                     - len(np.unique(mesh.faces))),
        "worst_aspect_ratio": round(float(aspect.max()), 1),
        "slivers_over_50": int((aspect > 50).sum()),
        "components": int(mesh.body_count),
        "clean": bool((areas >= min_area_m2).all() and vertical.sum() == 0),
    }

print(json.dumps(topology_check(tin), indent=2))
```

A **vertical** face in a terrain TIN is impossible by construction — the triangulation is 2D in XY — so any face with a zero Z normal component means two of its vertices share an XY position, which happens when the thinning left duplicate horizontal coordinates at different heights. Those faces break contouring and volume calculation.

Then verify the TIN's own consistency as a height field, which a TIN can violate after trimming:

```python
def height_field_check(mesh, samples=50_000, seed=7):
    """A terrain TIN must be single-valued: one Z per XY."""
    rng = np.random.default_rng(seed)
    lo = mesh.vertices[:, :2].min(axis=0)
    hi = mesh.vertices[:, :2].max(axis=0)
    xy = rng.uniform(lo, hi, size=(samples, 2))
    origins = np.column_stack([xy, np.full(len(xy), 1e5)])
    directions = np.tile(np.array([0.0, 0.0, -1.0]), (len(xy), 1))
    locations, index_ray, _ = mesh.ray.intersects_location(origins, directions,
                                                           multiple_hits=True)
    counts = np.bincount(index_ray, minlength=len(xy))
    return {
        "sampled": int(len(xy)),
        "no_hit": int((counts == 0).sum()),
        "single_hit": int((counts == 1).sum()),
        "multiple_hits": int((counts > 1).sum()),
        "single_valued": int((counts > 1).sum()) == 0,
        "note": "multiple hits mean overlapping triangles — usually duplicate XY "
                "points or a merge of two TINs",
    }
```

Multiple ray hits at one XY position mean the surface folds over itself, which for terrain is always an error. It appears after merging two tiles' TINs without removing the overlap, and it makes every downstream height query ambiguous.

## Performance Notes

- **`filters.delaunay` is fast** — about 1–2 million points per second — so the triangulation is rarely the bottleneck.
- **Thinning is the important performance decision.** A 1 m cell on a 1 km tile gives a 2-million-triangle TIN that loads anywhere; no thinning gives 44 million and does not.
- **PLY with `faces: True` is the only PDAL writer that emits triangles.** Converting to another format afterwards is a `trimesh` call.
- **Ray casting for verification is the slow step** at roughly 20,000 rays per second on a 2-million-face mesh. Sample rather than testing every point.
- **Constrained triangulation via `triangle` is C** and handles a million points in seconds, but it holds everything in memory.
- **Tile with overlap and merge after trimming**, so triangles near a tile edge are formed with the neighbour's points rather than against a straight boundary.

## Common Errors

**The PLY has no faces.** `faces: True` missing on the writer.

**Long thin triangles across a river.** The convex hull. Remove long edges and trim to a boundary.

**A kerb is rounded off.** No breakline constraint. Use a constrained triangulation.

**Vertical faces in the output.** Duplicate XY coordinates at different heights. The thinner should have removed them; `filters.merge` plus a voxel thin does.

**44 million triangles.** No thinning.

**The TIN is missing a district.** Boundary trimming with a boundary in the wrong CRS, or an over-tight `alpha_m`.

**Multiple ray hits.** Two TINs merged with overlapping extents. Trim each to its own tile before merging.

## Frequently Asked Questions

### TIN or raster DTM?

TIN where the deliverable must interpolate measured points and where breaklines matter — engineering and survey work. Raster where the consumer wants a grid, which is most GIS analysis. Producing both from the same thinned ground class is straightforward and avoids the argument.

### How does this compare to Poisson reconstruction?

Poisson produces a smooth, watertight surface and is right for objects; Delaunay produces an interpolating height field and is right for terrain. A Poisson surface does not pass through the input points, which makes it unsuitable for a survey deliverable.

### Should I keep the TIN or a set of contours?

Keep the TIN as the primary; contours are derived and can be regenerated at any interval. Contours from a raster and from a TIN differ slightly, and the TIN's are the ones that follow the measurements.

## Related Guides

- [Alpha Shape Reconstruction with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/alpha-shape-reconstruction-with-open3d/) — the concave-hull technique used here for boundaries
- [Trimming Poisson Meshes by Density](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/trimming-poisson-meshes-by-density/) — the equivalent problem for the other reconstruction family
- [Ground Classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) — producing the input this needs

Back to [Surface Reconstruction Algorithms](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
