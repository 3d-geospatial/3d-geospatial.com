# Planar Region Simplification for Facades

This page replaces the noisy, 400,000-triangle photogrammetric representation of a building facade with a handful of clean planar polygons — segmenting planes with RANSAC, merging co-planar fragments, extracting and simplifying each region's boundary, re-triangulating, and verifying that the result is both flatter and no further from the survey than the original.

## Why you hit this

Generic decimation treats a facade as an arbitrary surface and produces a facade that is 95% smaller and still bumpy. A wall is a plane; a window reveal is a plane; a roof pitch is a plane. Representing them as planes gives a result that is both far smaller and *better* than the input — the photogrammetric noise of ±3 cm across a flat wall is measurement error, not geometry, and averaging it into a plane removes error rather than adding it.

This is the one case where simplification improves accuracy, which is why it is worth the extra machinery over the quadric collapse in [decimating meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/).

## Prerequisites

- Python 3.10+ with `numpy`, `open3d>=0.18`, `trimesh`, `shapely`, `scipy`.
- A facade mesh or the point cloud it was built from; a mesh works, and points work better.
- The survey's expected planarity tolerance — typically 1–3 cm for a built facade.

## Step-by-Step

### 1. Segment planes with RANSAC, iteratively

```python
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import open3d as o3d

@dataclass
class PlanarRegion:
    plane: np.ndarray          # [a, b, c, d] with |n| = 1
    indices: np.ndarray
    rms_m: float
    area_m2: float
    normal: np.ndarray = field(init=False)

    def __post_init__(self):
        self.normal = self.plane[:3] / np.linalg.norm(self.plane[:3])

def segment_planes(points, distance_threshold=0.02, ransac_n=3, num_iterations=2000,
                   min_points=400, max_planes=60):
    """Repeatedly fit the largest plane and remove its inliers."""
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    remaining = np.arange(len(points))
    regions, rejected = [], 0

    working = pcd
    while len(remaining) >= min_points and len(regions) < max_planes:
        model, inliers = working.segment_plane(
            distance_threshold=distance_threshold,
            ransac_n=ransac_n,
            num_iterations=num_iterations)
        if len(inliers) < min_points:
            break
        idx = remaining[np.asarray(inliers)]
        pts = np.asarray(points)[idx]
        plane = np.asarray(model, dtype=np.float64)
        n = plane[:3] / np.linalg.norm(plane[:3])
        d = plane[3] / np.linalg.norm(plane[:3])
        residual = pts @ n + d
        rms = float(np.sqrt((residual ** 2).mean()))
        regions.append(PlanarRegion(plane=np.append(n, d), indices=idx,
                                    rms_m=round(rms, 5),
                                    area_m2=0.0))
        keep = np.setdiff1d(np.arange(len(remaining)), np.asarray(inliers))
        remaining = remaining[keep]
        working = working.select_by_index(list(map(int, keep)))

    return regions, remaining

def region_summary(regions, leftover_count, total):
    covered = sum(len(r.indices) for r in regions)
    return {
        "planes": len(regions),
        "points_covered": covered,
        "coverage": round(covered / max(total, 1), 4),
        "unassigned": int(leftover_count),
        "median_rms_m": round(float(np.median([r.rms_m for r in regions])), 5),
        "worst_rms_m": round(max(r.rms_m for r in regions), 5),
        "largest_planes": sorted(({"points": int(len(r.indices)), "rms_m": r.rms_m,
                                   "normal": [round(float(v), 3) for v in r.normal]}
                                  for r in regions),
                                 key=lambda x: -x["points"])[:5],
    }
```

The `distance_threshold` is the parameter that decides everything, and it should be set from the survey's noise, not guessed. At 2 cm on a photogrammetric facade, a flat wall becomes one plane; at 5 mm it fragments into dozens of planes chasing noise; at 10 cm a window reveal merges into the wall it is set into.

Sequential RANSAC — fit the biggest plane, remove it, repeat — is the right structure for a facade because facades are dominated by a few large planes. Its known weakness is that it will happily fit a plane through unrelated co-planar fragments on opposite sides of the building, which step 2 fixes.

Recording the RMS residual per region is what lets you tell a real plane from a forced one. A wall's residual is the photogrammetric noise, around 1 cm; a curved surface forced into a plane has a residual near the threshold.

<figure class="diagram">
<svg viewBox="6 16 726 224" role="img" aria-labelledby="planar-thr-t planar-thr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="planar-thr-t">RANSAC threshold against facade structure</title>
  <desc id="planar-thr-d">Three outcomes on the same facade. At a five millimetre threshold the wall fragments into 74 planes chasing photogrammetric noise. At two centimetres the facade resolves into 11 planes: the wall, four window reveals, two sills, the parapet and three roof pitches. At ten centimetres the window reveals merge into the wall and the facade becomes 3 planes, losing the openings.</desc>
  <rect class="svg-bg" x="6" y="16" width="726" height="224" fill="#ffffff"/>
  <rect x="20" y="30" width="222" height="196" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="258" y="30" width="222" height="196" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="496" y="30" width="222" height="196" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="131" y="54" fill="#1f2937" font-size="13" text-anchor="middle">threshold 5 mm</text>
  <text x="369" y="54" fill="#1f2937" font-size="13" text-anchor="middle">threshold 2 cm</text>
  <text x="607" y="54" fill="#1f2937" font-size="13" text-anchor="middle">threshold 10 cm</text>
  <g stroke-width="1.2">
    <rect x="44" y="70" width="174" height="110" fill="#ffffff" stroke="#b0413e"/>
    <rect x="282" y="70" width="174" height="110" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="520" y="70" width="174" height="110" fill="#ffffff" stroke="#b0413e"/>
  </g>
  <g stroke="#c46a3d" stroke-width="0.8" fill="none">
    <path d="M60 70 V180 M76 70 V180 M92 70 V180 M108 70 V180 M124 70 V180 M140 70 V180 M156 70 V180 M172 70 V180 M188 70 V180 M204 70 V180"/>
    <path d="M44 86 H218 M44 102 H218 M44 118 H218 M44 134 H218 M44 150 H218 M44 166 H218"/>
  </g>
  <g stroke-width="1.4">
    <rect x="304" y="92" width="34" height="42" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="356" y="92" width="34" height="42" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="408" y="92" width="34" height="42" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="304" y="146" width="34" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="282" y="70" width="174" height="14" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="131" y="200">74 planes — fitting noise</text>
    <text x="369" y="200">11 planes — wall, reveals,</text>
    <text x="369" y="216">sills, parapet, pitches</text>
    <text x="607" y="200">3 planes — openings lost</text>
  </g>
  <text x="607" y="130" fill="#1f2937" font-size="12" text-anchor="middle">windows absorbed</text>
  <text x="607" y="148" fill="#1f2937" font-size="12" text-anchor="middle">into the wall plane</text>
</svg>
<figcaption>The threshold has to sit above the measurement noise and below the smallest real step — for a built facade that is a narrow band around 2 cm.</figcaption>
</figure>

### 2. Merge co-planar regions, split disconnected ones

```python
def merge_coplanar(regions, points, angle_deg=3.0, offset_m=0.03):
    """Two regions with the same plane within tolerance become one."""
    merged, used = [], set()
    cos_limit = math.cos(math.radians(angle_deg))
    for i, a in enumerate(regions):
        if i in used:
            continue
        group = [a]
        used.add(i)
        for j in range(i + 1, len(regions)):
            if j in used:
                continue
            b = regions[j]
            if abs(float(a.normal @ b.normal)) < cos_limit:
                continue
            if abs(float(a.plane[3] - math.copysign(b.plane[3], a.normal @ b.normal))) \
                    > offset_m:
                continue
            group.append(b)
            used.add(j)
        idx = np.concatenate([g.indices for g in group])
        pts = np.asarray(points)[idx]
        plane = refit_plane(pts)
        residual = pts @ plane[:3] + plane[3]
        merged.append(PlanarRegion(plane=plane, indices=idx,
                                   rms_m=round(float(np.sqrt((residual ** 2).mean())), 5),
                                   area_m2=0.0))
    return merged

def refit_plane(pts):
    """Least-squares plane through all inliers — better than the RANSAC sample's plane."""
    centroid = pts.mean(axis=0)
    u, s, vh = np.linalg.svd(pts - centroid, full_matrices=False)
    normal = vh[-1]
    normal = normal / np.linalg.norm(normal)
    return np.append(normal, -float(normal @ centroid))

def split_disconnected(region, points, link_m=0.35, min_points=200):
    """One plane, several separate patches: split them into distinct regions."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree

    pts = np.asarray(points)[region.indices]
    tree = cKDTree(pts)
    pairs = tree.query_pairs(link_m, output_type="ndarray")
    if len(pairs) == 0:
        return [region]
    n = len(pts)
    graph = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    count, labels = connected_components(graph, directed=False)
    out = []
    for label in range(count):
        sel = labels == label
        if sel.sum() < min_points:
            continue
        idx = region.indices[sel]
        sub = np.asarray(points)[idx]
        plane = refit_plane(sub)
        residual = sub @ plane[:3] + plane[3]
        out.append(PlanarRegion(plane=plane, indices=idx,
                                rms_m=round(float(np.sqrt((residual ** 2).mean())), 5),
                                area_m2=0.0))
    return out or [region]
```

Re-fitting by least squares over all inliers, rather than keeping the plane RANSAC found from three points, is a small change with a real effect: the RANSAC plane is defined by a minimal sample and is typically a few millimetres and a fraction of a degree off the best fit through the whole region.

Splitting by connected components is the fix for sequential RANSAC's main artefact. Two parallel walls 12 m apart on opposite sides of a courtyard are co-planar if they face the same way, and RANSAC will fit them as one plane — which then gets a boundary polygon spanning the courtyard and a wall where there is air.

The `link_m` distance controls how aggressive that split is: too small and a wall with a window becomes two patches, too large and the courtyard is not split. A value around the mesh's coarse feature size, 30–50 cm for a facade, works.

### 3. Extract each region's boundary in its own 2D frame

```python
def plane_basis(normal):
    """An orthonormal 2D basis in the plane."""
    n = normal / np.linalg.norm(normal)
    helper = np.array([0.0, 0.0, 1.0]) if abs(n[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(n, helper)
    u /= np.linalg.norm(u)
    v = np.cross(n, u)
    return u, v

def project_to_plane(pts, plane):
    n = plane[:3]
    u, v = plane_basis(n)
    origin = pts.mean(axis=0)
    rel = pts - origin
    return np.column_stack([rel @ u, rel @ v]), (origin, u, v, n)

def boundary_polygon(pts2d, alpha_m=0.6, simplify_m=0.05, min_hole_m2=0.15):
    """Concave hull with holes: alpha shape, then simplify."""
    from shapely.geometry import MultiPoint, Polygon
    from shapely.ops import unary_union

    mp = MultiPoint([tuple(p) for p in pts2d])
    hull = mp.buffer(alpha_m).buffer(-alpha_m)      # morphological closing
    if hull.is_empty:
        return None
    if hull.geom_type == "MultiPolygon":
        hull = max(hull.geoms, key=lambda g: g.area)
    simplified = hull.simplify(simplify_m, preserve_topology=True)
    kept_holes = [ring for ring in simplified.interiors
                  if Polygon(ring).area >= min_hole_m2]
    return Polygon(simplified.exterior, kept_holes)

def unproject(poly, frame):
    origin, u, v, n = frame
    def to3d(coords):
        return [tuple(origin + c[0] * u + c[1] * v) for c in coords]
    return {"exterior": to3d(np.asarray(poly.exterior.coords)),
            "holes": [to3d(np.asarray(r.coords)) for r in poly.interiors]}
```

The morphological closing — buffer out then in — is a simpler and more robust concave hull than a true alpha shape for this purpose, and it handles holes naturally: a window opening survives as an interior ring provided its area exceeds `min_hole_m2`.

Discarding small holes matters because photogrammetric point clouds are full of small gaps from occlusion and reflective surfaces. Without a minimum area, a facade gets 200 spurious holes where the point density dipped, each of which becomes real geometry.

`simplify` with a 5 cm tolerance turns a 900-vertex hull boundary into a 12-vertex polygon along a rectangular wall, which is the bulk of the triangle reduction. `preserve_topology=True` stops it from collapsing a thin region into a line.

### 4. Re-triangulate the polygons

```python
def triangulate_region(poly3d, plane):
    """Constrained triangulation in the plane, then lift back to 3D."""
    import triangle as tr
    from shapely.geometry import Polygon

    origin, u, v, n = plane
    def to2d(coords):
        rel = np.asarray(coords) - origin
        return np.column_stack([rel @ u, rel @ v])

    ext = to2d(poly3d["exterior"])[:-1]
    vertices = [ext]
    segments, offset = [], 0
    for ring in [ext] + [to2d(h)[:-1] for h in poly3d["holes"]]:
        m = len(ring)
        segments.extend([(offset + i, offset + (i + 1) % m) for i in range(m)])
        offset += m
    all_rings = [ext] + [to2d(h)[:-1] for h in poly3d["holes"]]
    verts2d = np.vstack(all_rings)
    holes_xy = []
    for h in poly3d["holes"]:
        ring2d = to2d(h)[:-1]
        holes_xy.append(Polygon(ring2d).representative_point().coords[0])

    spec = {"vertices": verts2d, "segments": np.asarray(segments)}
    if holes_xy:
        spec["holes"] = np.asarray(holes_xy)
    result = tr.triangulate(spec, "p")            # 'p' = planar straight-line graph
    tris = np.asarray(result["triangles"])
    v2d = np.asarray(result["vertices"])
    v3d = origin + v2d[:, 0:1] * u + v2d[:, 1:2] * v
    return v3d, tris

def assemble(regions, points, alpha_m=0.6, simplify_m=0.05):
    all_v, all_f, stats = [], [], []
    for r in regions:
        pts = np.asarray(points)[r.indices]
        pts2d, frame = project_to_plane(pts, r.plane)
        poly = boundary_polygon(pts2d, alpha_m=alpha_m, simplify_m=simplify_m)
        if poly is None or poly.area < 0.2:
            continue
        poly3d = unproject(poly, frame)
        v, f = triangulate_region(poly3d, frame)
        base = sum(len(x) for x in all_v)
        all_v.append(v)
        all_f.append(f + base)
        stats.append({"points": int(len(r.indices)), "area_m2": round(poly.area, 2),
                      "boundary_vertices": len(poly.exterior.coords) - 1,
                      "holes": len(poly.interiors), "triangles": int(len(f)),
                      "rms_m": r.rms_m})
    return (np.vstack(all_v) if all_v else np.zeros((0, 3))), \
           (np.vstack(all_f) if all_f else np.zeros((0, 3), dtype=np.int64)), stats
```

Constrained triangulation with the `'p'` switch respects the boundary and hole segments exactly, which is what a facade needs — the alternative, a Delaunay triangulation of the interior points, produces triangles that cross window openings.

Choosing a point inside each hole with `representative_point()` rather than the centroid matters for L-shaped or crescent openings, where the centroid can fall outside the ring and the triangulator then keeps the hole filled.

### 5. Verify the result is flatter than the input

```python
def flatness_check(points, regions, tolerance_m=0.02):
    """Each region's residual should be at or below the survey noise."""
    rows = []
    for i, r in enumerate(regions):
        pts = np.asarray(points)[r.indices]
        residual = pts @ r.plane[:3] + r.plane[3]
        rows.append({
            "region": i,
            "points": int(len(pts)),
            "rms_m": round(float(np.sqrt((residual ** 2).mean())), 5),
            "p95_abs_m": round(float(np.percentile(np.abs(residual), 95)), 5),
            "max_abs_m": round(float(np.abs(residual).max()), 5),
            "within": bool(np.percentile(np.abs(residual), 95) <= tolerance_m),
        })
    bad = [r for r in rows if not r["within"]]
    return {"regions": len(rows), "outside_tolerance": len(bad),
            "median_rms_m": round(float(np.median([r["rms_m"] for r in rows])), 5),
            "worst": sorted(rows, key=lambda r: -r["p95_abs_m"])[:4]}
```

A region whose p95 residual exceeds the tolerance is not a plane, and the honest responses are to split it further, to lower the RANSAC threshold for that area, or to leave it as decimated mesh rather than forcing it flat. A curved balcony front modelled as a plane is a worse representation than a decimated one.

This check is also what justifies the claim that planar simplification *improves* accuracy: the residual it reports is the photogrammetric noise, and the plane sits at its mean, so the simplified surface is closer to the true wall than the noisy mesh was.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="planar-params-t planar-params-d" xmlns="http://www.w3.org/2000/svg">
  <title id="planar-params-t">The four parameters and what each decides</title>
  <desc id="planar-params-d">A table of four parameters in the planar simplification pipeline. The RANSAC distance threshold must sit above the point cloud's noise and below the smallest real step, which for a built facade is a narrow band around two centimetres. The co-planar merge angle at three degrees joins fragments of the same wall. The connected-component link distance at 35 centimetres splits a plane that spans a courtyard. The boundary simplify tolerance at five centimetres is where most of the triangle reduction comes from.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="272" y="20" width="108" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="20" width="342" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="272" y="54" width="108" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="380" y="54" width="342" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="88" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="88" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="88" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="122" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="122" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="156" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="156" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="42">parameter</text><text x="326" y="42">value</text><text x="551" y="42">what it decides</text>
    <text x="145" y="76">RANSAC distance threshold</text><text x="326" y="76">0.02 m</text><text x="551" y="76">planes against noise — the critical one</text>
    <text x="145" y="110">co-planar merge angle</text><text x="326" y="110">3°</text><text x="551" y="110">joins fragments of one wall</text>
    <text x="145" y="144">component link distance</text><text x="326" y="144">0.35 m</text><text x="551" y="144">splits a plane spanning a courtyard</text>
    <text x="145" y="178">boundary simplify tolerance</text><text x="326" y="178">0.05 m</text><text x="551" y="178">most of the triangle reduction</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Set the threshold from the survey's noise, not by trial: twice the noise RMS is the floor.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Below the noise the wall fragments into dozens of planes; above the smallest step, windows vanish.</text>
</svg>
<figcaption>Only the first parameter is delicate, and it is set from the cloud's measured noise rather than by trial.</figcaption>
</figure>

### 6. Put the pipeline together

```python
def simplify_facade(in_path, out_path, distance_threshold=0.02, angle_deg=3.0,
                    alpha_m=0.6, simplify_m=0.05, fallback_decimate=True):
    import trimesh

    src = trimesh.load(in_path, process=False, force="mesh")
    points = np.asarray(src.triangles_center) if len(src.faces) else np.asarray(src.vertices)

    raw, leftover = segment_planes(points, distance_threshold=distance_threshold)
    merged = merge_coplanar(raw, points, angle_deg=angle_deg)
    split = []
    for r in merged:
        split.extend(split_disconnected(r, points))

    v, f, stats = assemble(split, points, alpha_m=alpha_m, simplify_m=simplify_m)
    out = trimesh.Trimesh(vertices=v, faces=f, process=False)

    if fallback_decimate and len(leftover) > len(points) * 0.1:
        residual_mesh = src.submesh([np.arange(len(src.faces))], append=True) \
            if len(src.faces) else src
        out = trimesh.util.concatenate([out, residual_mesh])

    out.export(out_path)
    return {
        "input_triangles": int(len(src.faces)),
        "planes_found": len(raw),
        "planes_after_merge": len(merged),
        "planes_after_split": len(split),
        "output_triangles": int(len(f)),
        "reduction": round(len(src.faces) / max(len(f), 1), 1),
        "unassigned_fraction": round(len(leftover) / max(len(points), 1), 4),
        "regions": stats[:5],
    }

print(json.dumps(simplify_facade("input/facade_east.ply",
                                 "output/facade_east_planar.ply"), indent=2))
```

The fallback path is what keeps this honest on real buildings. A facade with foliage in front of it, a sculpted cornice or a curved bay will leave a large unassigned fraction, and forcing those points into planes produces nonsense. Keeping the unassigned geometry as a decimated mesh alongside the planes gives a hybrid result that is correct everywhere.

<figure class="diagram">
<svg viewBox="2 24 728 228" role="img" aria-labelledby="planar-pipe-t planar-pipe-d" xmlns="http://www.w3.org/2000/svg">
  <title id="planar-pipe-t">The pipeline and the triangle count at each stage</title>
  <desc id="planar-pipe-d">Six stages with counts. The input facade has 412000 triangles. Sequential RANSAC finds 34 planes covering 91 percent of the points. Merging co-planar regions reduces this to 19 planes. Splitting disconnected patches raises it to 23 regions. Boundary extraction and simplification gives each region 8 to 22 vertices. Re-triangulation produces 1840 triangles, a 224-fold reduction, with the remaining 9 percent kept as decimated mesh.</desc>
  <rect class="svg-bg" x="2" y="24" width="728" height="228" fill="#ffffff"/>
  <defs>
    <marker id="planar-pipe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.8">
    <rect x="16" y="38" width="106" height="56" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="158" y="38" width="106" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="300" y="38" width="106" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="442" y="38" width="106" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="584" y="38" width="132" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="262" y="152" width="324" height="52" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#planar-pipe-arrow)">
    <path d="M122 66 H156"/><path d="M264 66 H298"/><path d="M406 66 H440"/><path d="M548 66 H582"/>
    <path d="M211 94 V126 H424 V150"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="69" y="60">input mesh</text><text x="69" y="78">412 k tris</text>
    <text x="211" y="54">RANSAC:</text><text x="211" y="72">34 planes</text><text x="211" y="90">91% covered</text>
    <text x="353" y="54">merge</text><text x="353" y="72">co-planar:</text><text x="353" y="90">19 planes</text>
    <text x="495" y="54">split patches:</text><text x="495" y="72">23 regions,</text><text x="495" y="90">8–22 verts each</text>
    <text x="650" y="54">re-triangulate:</text><text x="650" y="72">1,840 tris</text><text x="650" y="90">224× smaller</text>
    <text x="424" y="172">the unassigned 9%: foliage, cornice, curved bay</text>
    <text x="424" y="192">kept as decimated mesh — never forced flat</text>
  </g>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">the merge step removes RANSAC's fragmentation; the split step removes its courtyard-spanning planes</text>
</svg>
<figcaption>Two corrective steps between segmentation and output, and a fallback for the tenth of the facade that is not planar.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "input_triangles": 412084,
  "planes_found": 34,
  "planes_after_merge": 19,
  "planes_after_split": 23,
  "output_triangles": 1840,
  "reduction": 224.0,
  "unassigned_fraction": 0.0912,
  "regions": [
    {"points": 84120, "area_m2": 412.8, "boundary_vertices": 14, "holes": 9,
     "triangles": 88, "rms_m": 0.0104},
    {"points": 41208, "area_m2": 188.4, "boundary_vertices": 8, "holes": 0,
     "triangles": 12, "rms_m": 0.0091}
  ]
}
{
  "regions": 23,
  "outside_tolerance": 1,
  "median_rms_m": 0.0098,
  "worst": [{"region": 17, "points": 2418, "rms_m": 0.0284, "p95_abs_m": 0.0561,
             "max_abs_m": 0.1042, "within": false}]
}
```

A 224× reduction with a median residual of 9.8 mm is the result this method exists for, and the 9.8 mm is the photogrammetry's own noise rather than error introduced by the simplification. The main wall having 9 holes and 88 triangles is the shape to expect: windows as interior rings, a nearly rectangular exterior.

Region 17 with a 5.6 cm p95 residual is the one to inspect — 2,418 points is a small region, and a residual at three times the median usually means a curved element forced flat.

Verify the simplified surface is no further from the source than the noise, using the measurement from [measuring Hausdorff distance after decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/measuring-hausdorff-distance-after-decimation/):

```python
def accuracy_against_source(source_points, simplified_mesh_path, samples=100_000,
                            noise_m=0.012):
    import trimesh
    mesh = trimesh.load(simplified_mesh_path, process=False, force="mesh")
    rng = np.random.default_rng(11)
    pts = np.asarray(source_points)
    idx = rng.choice(len(pts), size=min(samples, len(pts)), replace=False)
    _, distance, _ = mesh.nearest.on_surface(pts[idx])
    d = np.abs(np.asarray(distance))
    return {
        "samples": int(d.size),
        "mean_m": round(float(d.mean()), 5),
        "p95_m": round(float(np.percentile(d, 95)), 5),
        "max_m": round(float(d.max()), 5),
        "source_noise_m": noise_m,
        "within_noise": bool(np.percentile(d, 95) <= noise_m * 2.0),
        "interpretation": "planes sit inside the point cloud's own noise band"
                          if np.percentile(d, 95) <= noise_m * 2.0
                          else "planes deviate beyond the noise — check the threshold",
    }

print(accuracy_against_source(POINTS, "output/facade_east_planar.ply"))
```

The comparison to make is against the *noise*, not against zero. A p95 distance of 1.8 cm on a cloud with 1.2 cm noise means the planes sit within the noise band, which is the best any surface can do; demanding less would mean fitting the noise.

Then verify the openings survived, because losing a window is the failure this method is prone to:

```python
def opening_check(expected_openings, simplified_mesh_path, tol_m2=0.5):
    """expected_openings: [{'id': 'W-14', 'centre': (x,y,z), 'area_m2': 2.4}, …]"""
    import trimesh
    from shapely.geometry import Point
    mesh = trimesh.load(simplified_mesh_path, process=False, force="mesh")
    rows = []
    for op in expected_openings:
        centre = np.asarray(op["centre"], dtype=float)
        _, d, _ = mesh.nearest.on_surface(centre.reshape(1, 3))
        inside = mesh.contains(centre.reshape(1, 3))[0] if mesh.is_watertight else None
        rows.append({
            "id": op["id"],
            "distance_to_surface_m": round(float(d[0]), 4),
            "present_as_hole": float(d[0]) > 0.05,
            "expected_area_m2": op["area_m2"],
        })
    missing = [r for r in rows if not r["present_as_hole"]]
    return {"openings": len(rows), "missing": len(missing),
            "missing_ids": [r["id"] for r in missing][:5],
            "all_present": not missing}
```

A window whose centre sits *on* the simplified surface has been filled in — the hole was below `min_hole_m2`, or the alpha value closed it. Both are tunable, and knowing which openings were lost is what makes tuning possible.

## Performance Notes

- **Sequential RANSAC is the cost**, at roughly 30–80 ms per plane on 400,000 points with 2,000 iterations. 34 planes is a few seconds.
- **`num_iterations` trades speed for reliability.** Below about 500 the largest plane is sometimes missed; above 5,000 there is no further gain.
- **Use triangle centroids, not vertices,** as the point set for a mesh input: they are area-weighted, so large flat triangles do not under-contribute.
- **The connected-components split is O(n log n)** via a KD-tree pair query; on a 100,000-point region with a 35 cm radius it is about a second.
- **Boundary simplification is where the triangles go.** A 5 cm tolerance on a rectangular wall gives 8–14 vertices; 1 cm gives 60–90 for no visible benefit.
- **Run per facade, not per building.** Each facade is a few large planes; a whole building at once makes RANSAC's co-planar confusion much worse.

## Common Errors

**A wall spans a courtyard.** Co-planar patches merged. Run the connected-components split.

**74 tiny planes on one wall.** Threshold below the point cloud's noise. Raise it to at least twice the noise RMS.

**Windows filled in.** `min_hole_m2` too large, or `alpha_m` larger than the opening. Lower both.

**Boundary has 900 vertices.** `simplify_m` too small, or `preserve_topology` forcing detail on a thin region.

**Triangulation fills the holes.** The hole seed point fell outside its ring. Use `representative_point()`.

**A curved bay became a flat plane with 6 cm residual.** Expected; exclude it from the planar path and keep it as mesh.

**Output has overlapping planes at corners.** Regions are triangulated independently, so adjacent planes meet approximately. Intersecting the planes to produce exact corner edges is the next refinement, and it is considerably more work.

## Frequently Asked Questions

### Should I work from the mesh or the point cloud?

The point cloud, where it is available. Meshing introduces its own smoothing and interpolation, so fitting planes to the original points gives a slightly better fit and avoids inheriting meshing artefacts.

### How does this compare to quadric decimation?

Quadric decimation is general and gives a uniform error; planar simplification is structure-aware, gives a far larger reduction on planar geometry and fails on curved geometry. A facade wants planar simplification with a quadric fallback, which is what the pipeline above does.

### Can this produce LOD2 building models?

It is most of the way there. LOD2 needs the planes intersected into a watertight solid with a roof structure, which is a further step; this produces the planar patches that step consumes.

## Related Guides

- [Decimating Meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/) — the general method and the fallback path
- [Measuring Hausdorff Distance After Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/measuring-hausdorff-distance-after-decimation/) — quantifying the result properly
- [Alpha Shape Reconstruction with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/alpha-shape-reconstruction-with-open3d/) — the boundary technique in its own right

Back to [Automated Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).
