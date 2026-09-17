---
title: "Detecting Power Lines in Lidar"
description: "Classify conductors and pylons from airborne lidar: height-above-ground filtering, linearity from eigenvalues, catenary fitting per span"
---
# Detecting Power Lines in Lidar

This page classifies overhead conductors and their support structures from an airborne lidar corridor survey — filtering by height above ground, isolating linear point clusters with an eigenvalue test, fitting a catenary per span to separate parallel conductors, detecting pylons, and producing the vegetation-clearance report that is usually the reason for the survey.

## Why you hit this

Utility corridor surveys exist to answer two questions: where are the conductors, and what is too close to them. Both need the conductors classified as conductors, and generic ground-and-vegetation classification does not do it — ASPRS reserves classes 13 and 14 for wire guard and wire conductor precisely because they need their own treatment.

Conductors are also an unusually tractable classification target. They are thin, they are high, they are locally linear, and they hang in a shape with a known equation. That combination means a rule-based classifier works well, which is rarer in point-cloud classification than one would like.

## Prerequisites

- An airborne lidar corridor with ground already classified — see [ground classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/).
- Python 3.10+ with `numpy`, `scipy`, `laspy`, `pdal`.
- Nominal circuit geometry if available: voltage, conductor count, expected span length.

## Step-by-Step

### 1. Reduce to candidates by height above ground

```python
import json
import math
import subprocess
from pathlib import Path

import laspy
import numpy as np
from scipy.spatial import cKDTree

def height_above_ground(las_path, out_path, cell_m=2.0):
    """PDAL's HAG filter writes a HeightAboveGround dimension."""
    stages = [
        str(las_path),
        {"type": "filters.hag_delaunay", "count": 10, "allow_extrapolation": True},
        {"type": "writers.las", "filename": str(out_path),
         "compression": "laszip", "extra_dims": "HeightAboveGround=float32"},
    ]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    return str(out_path)

def load_candidates(las_path, min_hag_m=5.0, max_hag_m=80.0,
                    exclude_classes=(2, 6, 7, 9, 18)):
    las = laspy.read(las_path)
    hag = np.asarray(las.HeightAboveGround, dtype=np.float64)
    cls = np.asarray(las.classification)
    xyz = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])
    keep = (hag >= min_hag_m) & (hag <= max_hag_m) & ~np.isin(cls, exclude_classes)
    return {
        "xyz": xyz[keep],
        "hag": hag[keep],
        "index": np.flatnonzero(keep),
        "total_points": int(len(cls)),
        "candidates": int(keep.sum()),
        "reduction": round(float(keep.mean()), 5),
    }
```

The height filter is what makes everything after it fast. A corridor tile has 40 million points; conductors above 5 m and below 80 m, excluding ground and buildings, is typically 0.2–0.6% of them — under 200,000 points, which every subsequent step can afford to treat individually.

`filters.hag_delaunay` computes height above a Delaunay triangulation of the ground class, which handles varied terrain better than the nearest-neighbour variant. The `allow_extrapolation` option matters at tile edges, where a point can fall outside the ground triangulation's convex hull and would otherwise get no height.

The 5 m floor excludes vegetation up to hedge height and keeps low-voltage distribution lines; raising it to 8 m removes more vegetation and starts losing rural distribution conductors, which is a project-specific trade.

### 2. Test local linearity with eigenvalues

```python
def local_geometry(points, radius_m=1.0, min_neighbours=6):
    """Per-point eigenvalue features from the neighbourhood covariance."""
    tree = cKDTree(points)
    neighbours = tree.query_ball_point(points, r=radius_m, workers=-1)
    n = len(points)
    linearity = np.zeros(n)
    planarity = np.zeros(n)
    scattering = np.zeros(n)
    verticality = np.zeros(n)
    counts = np.zeros(n, dtype=np.int32)

    for i, idx in enumerate(neighbours):
        counts[i] = len(idx)
        if len(idx) < min_neighbours:
            continue
        local = points[idx]
        centred = local - local.mean(axis=0)
        cov = centred.T @ centred / len(idx)
        w, v = np.linalg.eigh(cov)
        w = np.clip(w[::-1], 1e-12, None)          # descending: l1 >= l2 >= l3
        total = w.sum()
        linearity[i] = (w[0] - w[1]) / w[0]
        planarity[i] = (w[1] - w[2]) / w[0]
        scattering[i] = w[2] / w[0]
        principal = v[:, ::-1][:, 0]
        verticality[i] = abs(float(principal[2]))
    return {"linearity": linearity, "planarity": planarity,
            "scattering": scattering, "verticality": verticality,
            "neighbours": counts}

def conductor_mask(geom, linearity_min=0.92, scattering_max=0.06,
                   verticality_max=0.35, min_neighbours=6):
    return (geom["linearity"] >= linearity_min) \
        & (geom["scattering"] <= scattering_max) \
        & (geom["verticality"] <= verticality_max) \
        & (geom["neighbours"] >= min_neighbours)

def pylon_mask(geom, verticality_min=0.75, scattering_max=0.25, min_neighbours=10):
    return (geom["verticality"] >= verticality_min) \
        & (geom["scattering"] <= scattering_max) \
        & (geom["neighbours"] >= min_neighbours)
```

Linearity from the eigenvalue ratio is the discriminating feature and it is close to 1 for a conductor: the points lie along a line, so the first eigenvalue dominates. Vegetation is scattered — all three eigenvalues comparable — and a roof is planar, with the first two comparable and the third small.

Verticality separates conductors from pylon legs, both of which are linear. A conductor's principal direction is nearly horizontal; a pylon leg's is nearly vertical. That single component of the first eigenvector does the whole job.

The neighbourhood radius is the parameter to tune. Too small and there are not enough neighbours on a sparsely sampled conductor for the covariance to be meaningful; too large and a conductor's neighbourhood picks up the vegetation below it and the linearity collapses. One metre is a reasonable default at 20–40 points/m².

<figure class="diagram">
<svg viewBox="4 6 732 248" role="img" aria-labelledby="pl-eig-t pl-eig-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pl-eig-t">Eigenvalue features by object type</title>
  <desc id="pl-eig-d">A table of eigenvalue-derived features for four object types. A conductor has linearity 0.96, planarity 0.02, scattering 0.02 and verticality 0.08, so it is linear and horizontal. A pylon leg has linearity 0.89 and verticality 0.91, so it is linear and vertical. Tree canopy has linearity 0.31 and scattering 0.34, so it is scattered. A roof has linearity 0.24, planarity 0.71 and scattering 0.05, so it is planar. Two thresholds separate all four.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="248" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="158" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="176" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="294" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="412" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="530" y="20" width="192" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="158" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="176" y="52" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="294" y="52" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="412" y="52" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="52" width="192" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="158" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="176" y="86" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="294" y="86" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="412" y="86" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="530" y="86" width="192" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="120" width="158" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="176" y="120" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="294" y="120" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="412" y="120" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="530" y="120" width="192" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="154" width="158" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="176" y="154" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="294" y="154" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="412" y="154" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="530" y="154" width="192" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="97" y="41">object</text><text x="235" y="41">linearity</text>
    <text x="353" y="41">scattering</text><text x="471" y="41">verticality</text>
    <text x="626" y="41">classified as</text>
    <text x="97" y="74">conductor</text><text x="235" y="74">0.96</text>
    <text x="353" y="74">0.02</text><text x="471" y="74">0.08</text>
    <text x="626" y="74">class 14 — conductor</text>
    <text x="97" y="108">pylon leg</text><text x="235" y="108">0.89</text>
    <text x="353" y="108">0.06</text><text x="471" y="108">0.91</text>
    <text x="626" y="108">class 15 — tower</text>
    <text x="97" y="142">tree canopy</text><text x="235" y="142">0.31</text>
    <text x="353" y="142">0.34</text><text x="471" y="142">0.42</text>
    <text x="626" y="142">rejected: scattered</text>
    <text x="97" y="176">roof</text><text x="235" y="176">0.24</text>
    <text x="353" y="176">0.05</text><text x="471" y="176">0.11</text>
    <text x="626" y="176">rejected: not linear</text>
  </g>
  <text x="370" y="214" fill="#1f2937" font-size="12.5" text-anchor="middle">linearity ≥ 0.92 and scattering ≤ 0.06 keeps conductors and pylon legs</text>
  <text x="370" y="236" fill="#5b6471" font-size="12" text-anchor="middle">verticality ≤ 0.35 then splits them: conductors are horizontal, legs are not</text>
</svg>
<figcaption>Two thresholds isolate the linear objects and one more separates conductors from towers.</figcaption>
</figure>

### 3. Group candidate points into conductor segments

```python
def cluster_candidates(points, mask, link_m=1.6, min_cluster=30):
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return [], {"clusters": 0, "reason": "no candidate points"}
    pts = points[idx]
    tree = cKDTree(pts)
    pairs = tree.query_pairs(link_m, output_type="ndarray")
    n = len(pts)
    graph = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    count, labels = connected_components(graph, directed=False)

    clusters = []
    for label in range(count):
        sel = labels == label
        if sel.sum() < min_cluster:
            continue
        member = idx[sel]
        p = points[member]
        extent = p.max(axis=0) - p.min(axis=0)
        horizontal_length = float(math.hypot(extent[0], extent[1]))
        clusters.append({"indices": member, "points": int(sel.sum()),
                         "length_m": round(horizontal_length, 2),
                         "vertical_extent_m": round(float(extent[2]), 2)})
    clusters.sort(key=lambda c: -c["length_m"])
    return clusters, {"clusters": len(clusters),
                      "discarded_small": int(count - len(clusters)),
                      "longest_m": clusters[0]["length_m"] if clusters else 0.0}
```

The linking distance has to exceed the along-conductor point spacing and stay below the conductor-to-conductor separation. On a corridor scanned at 30 points/m², a conductor has a point every 20–40 cm along its length, and phases are separated by 4–8 m — so 1.6 m links a conductor to itself without bridging to its neighbour.

Where phases are closer than the link distance, as on a compact distribution pole, this step merges them and step 4's catenary fit is what separates them again.

### 4. Fit a catenary per span

```python
def fit_catenary(points, ransac_trials=200, inlier_m=0.25, seed=5):
    """A conductor hangs as z = z0 + a·(cosh((s − s0)/a) − 1) along its horizontal run."""
    rng = np.random.default_rng(seed)
    p = np.asarray(points, dtype=np.float64)
    centre = p[:, :2].mean(axis=0)
    xy = p[:, :2] - centre
    u, s_vals, vh = np.linalg.svd(xy - xy.mean(axis=0), full_matrices=False)
    direction = vh[0]
    s = xy @ direction
    z = p[:, 2]

    best = None
    for _ in range(ransac_trials):
        pick = rng.choice(len(p), size=3, replace=False)
        try:
            params = solve_catenary(s[pick], z[pick])
        except (ValueError, np.linalg.LinAlgError):
            continue
        if params is None:
            continue
        residual = z - catenary_z(s, *params)
        inliers = np.abs(residual) <= inlier_m
        score = int(inliers.sum())
        if best is None or score > best["inliers"]:
            best = {"params": params, "inliers": score, "mask": inliers}

    if best is None:
        return None
    m = best["mask"]
    refined = refine_catenary(s[m], z[m], best["params"])
    residual = z - catenary_z(s, *refined)
    return {
        "direction": [round(float(v), 6) for v in direction],
        "centre_xy": [round(float(v), 3) for v in centre],
        "a": round(float(refined[0]), 3),
        "s0": round(float(refined[1]), 3),
        "z0": round(float(refined[2]), 3),
        "span_m": round(float(s.max() - s.min()), 2),
        "sag_m": round(float(catenary_z(np.array([s.min()]), *refined)[0]
                             - catenary_z(np.array([refined[1]]), *refined)[0]), 3),
        "inliers": int(m.sum()), "points": int(len(p)),
        "inlier_fraction": round(float(m.mean()), 4),
        "rms_m": round(float(np.sqrt((residual[m] ** 2).mean())), 4),
    }

def catenary_z(s, a, s0, z0):
    a = max(abs(a), 1.0)
    return z0 + a * (np.cosh((s - s0) / a) - 1.0)

def solve_catenary(s3, z3):
    from scipy.optimize import least_squares
    guess = [max(float(np.ptp(s3)) ** 2 / max(8.0 * max(np.ptp(z3), 0.1), 1.0), 50.0),
             float(s3.mean()), float(z3.min())]
    res = least_squares(lambda p: catenary_z(s3, *p) - z3, guess,
                        bounds=([20.0, -1e5, -1e4], [1e5, 1e5, 1e4]), max_nfev=200)
    return res.x if res.success else None

def refine_catenary(s, z, guess):
    from scipy.optimize import least_squares
    res = least_squares(lambda p: catenary_z(s, *p) - z, guess,
                        bounds=([20.0, -1e5, -1e4], [1e5, 1e5, 1e4]), max_nfev=500)
    return res.x
```

Fitting a catenary rather than a line or a parabola matters for the clearance calculation. A 300 m span with 8 m of sag deviates from a straight line by 8 m at midspan and from a parabola by a few centimetres — so a parabola is close enough for many purposes and a catenary is the correct model, costs nothing extra, and removes the argument.

The RANSAC wrapper is what separates two conductors that clustered together. The first fit finds one conductor's catenary and marks the other's points as outliers; running the fit again on the outliers finds the second. Iterating until the remaining points are too few to fit decomposes a bundled cluster into its phases.

The `a` parameter is the catenary constant, equal to the horizontal tension divided by the weight per unit length. Extracting it means the fit produces a physically meaningful number that an engineer can sanity-check against the circuit's design tension.

### 5. Detect pylons and split the corridor into spans

```python
def detect_pylons(points, geom, min_height_m=12.0, cluster_m=3.0, min_points=60):
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    mask = pylon_mask(geom)
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return [], {"pylons": 0}
    pts = points[idx]
    tree = cKDTree(pts[:, :2])
    pairs = tree.query_pairs(cluster_m, output_type="ndarray")
    graph = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])),
                       shape=(len(pts), len(pts)))
    count, labels = connected_components(graph, directed=False)

    pylons = []
    for label in range(count):
        sel = labels == label
        if sel.sum() < min_points:
            continue
        p = pts[sel]
        height = float(p[:, 2].max() - p[:, 2].min())
        if height < min_height_m:
            continue
        pylons.append({
            "centre_xy": [round(float(v), 2) for v in p[:, :2].mean(axis=0)],
            "top_z": round(float(p[:, 2].max()), 2),
            "height_m": round(height, 2),
            "points": int(sel.sum()),
            "footprint_m": round(float(np.hypot(*(p[:, :2].max(axis=0)
                                                  - p[:, :2].min(axis=0)))), 2),
        })
    pylons.sort(key=lambda t: (t["centre_xy"][0], t["centre_xy"][1]))
    return pylons, {"pylons": len(pylons),
                    "mean_height_m": round(float(np.mean([t["height_m"] for t in pylons])), 2)
                    if pylons else 0.0}

def spans_from_pylons(pylons, tolerance_m=40.0):
    if len(pylons) < 2:
        return [], {"spans": 0}
    centres = np.array([t["centre_xy"] for t in pylons])
    spans = []
    for i in range(len(centres) - 1):
        d = float(np.linalg.norm(centres[i + 1] - centres[i]))
        spans.append({"from": i, "to": i + 1, "length_m": round(d, 1)})
    lengths = np.array([s["length_m"] for s in spans])
    return spans, {"spans": len(spans),
                   "median_m": round(float(np.median(lengths)), 1),
                   "min_m": round(float(lengths.min()), 1),
                   "max_m": round(float(lengths.max()), 1),
                   "suspicious": [s for s in spans
                                  if abs(s["length_m"] - float(np.median(lengths)))
                                  > tolerance_m * 3][:3]}
```

Splitting by pylon is what makes the catenary fits correct. A catenary describes one span between two supports; fitting one across three spans produces a curve that matches nowhere, and the resulting sag and clearance numbers are meaningless.

A suspiciously short span between detected pylons usually means one pylon was detected twice — a lattice tower with widely separated legs can cluster into two — and a suspiciously long one means a pylon was missed, often because it is partly occluded.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="pl-classes-t pl-classes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pl-classes-t">The ASPRS classes a corridor survey should write</title>
  <desc id="pl-classes-d">A table of four reserved ASPRS classes for utility corridors and what belongs in each. Class 14 is the conductor itself. Class 13 is the shield or guard wire above it. Class 15 is the transmission tower. Class 16 is the wire-structure connector. Using the reserved classes rather than custom values is what makes the result readable by downstream tools.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="108" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="126" y="20" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="372" y="20" width="350" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="126" y="54" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="372" y="54" width="350" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="126" y="88" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="372" y="88" width="350" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="126" y="122" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="372" y="122" width="350" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="126" y="156" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="372" y="156" width="350" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="72" y="42">class</text><text x="249" y="42">name</text><text x="547" y="42">what goes in it</text>
    <text x="72" y="76">14</text><text x="249" y="76">wire conductor</text><text x="547" y="76">the current-carrying conductors</text>
    <text x="72" y="110">13</text><text x="249" y="110">wire guard / shield</text><text x="547" y="110">the earth wire above the phases</text>
    <text x="72" y="144">15</text><text x="249" y="144">transmission tower</text><text x="547" y="144">lattice legs and cross-arms</text>
    <text x="72" y="178">16</text><text x="249" y="178">wire-structure connector</text><text x="547" y="178">insulator strings and fittings</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Writing the reserved classes means downstream tools recognise the result without configuration.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Classes 7 and 18 — low and high noise — should be dropped from rendering rather than coloured.</text>
</svg>
<figcaption>Four reserved classes cover a corridor survey, and using them means no downstream tool needs configuring.</figcaption>
</figure>

### 6. Produce the clearance report

```python
def vegetation_clearance(catenaries, las_path, corridor_half_width_m=25.0,
                         thresholds_m=(2.0, 3.5, 5.0)):
    las = laspy.read(las_path)
    cls = np.asarray(las.classification)
    veg = np.isin(cls, (3, 4, 5))
    pts = np.column_stack([np.asarray(las.x)[veg], np.asarray(las.y)[veg],
                           np.asarray(las.z)[veg]])
    if len(pts) == 0:
        return {"measurable": False, "reason": "no vegetation points"}

    tree = cKDTree(pts)
    findings = []
    for ci, cat in enumerate(catenaries):
        direction = np.array(cat["direction"])
        centre = np.array(cat["centre_xy"])
        s_samples = np.linspace(-cat["span_m"] / 2, cat["span_m"] / 2, 400) + cat["s0"]
        z_samples = catenary_z(s_samples, cat["a"], cat["s0"], cat["z0"])
        xy = centre + np.outer(s_samples - cat["s0"], direction)
        wire = np.column_stack([xy, z_samples])

        d, nearest = tree.query(wire, k=1, workers=-1)
        worst = int(np.argmin(d))
        findings.append({
            "conductor": ci,
            "min_clearance_m": round(float(d.min()), 3),
            "at_xy": [round(float(v), 2) for v in wire[worst, :2]],
            "wire_z_m": round(float(wire[worst, 2]), 2),
            "vegetation_z_m": round(float(pts[nearest[worst], 2]), 2),
            "breaches": {f"under_{t}m": int((d < t).sum()) for t in thresholds_m},
            "samples": int(len(d)),
        })

    worst_overall = min(findings, key=lambda f: f["min_clearance_m"])
    return {
        "measurable": True,
        "conductors": len(findings),
        "worst_clearance_m": worst_overall["min_clearance_m"],
        "worst_location_xy": worst_overall["at_xy"],
        "conductors_breaching_2m": sum(1 for f in findings
                                       if f["min_clearance_m"] < 2.0),
        "findings": sorted(findings, key=lambda f: f["min_clearance_m"])[:5],
    }
```

Measuring clearance from the **fitted** catenary rather than from the conductor points is the right choice for two reasons: the fit interpolates across gaps where the scanner missed the wire, and it can be evaluated at any temperature by adjusting the sag — which matters because a conductor at maximum operating temperature hangs lower than it did during the survey.

Sampling the wire at 400 points along the span and querying the nearest vegetation point at each is both simple and fast, and the worst-case location it reports is what a vegetation-management crew needs.

<figure class="diagram">
<svg viewBox="46 21 624 239" role="img" aria-labelledby="pl-clear-t pl-clear-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pl-clear-t">Clearance measured from the fitted catenary</title>
  <desc id="pl-clear-d">A cross-section of one 280 metre span between two pylons. The conductor hangs in a catenary with 7.4 metres of sag. Two trees rise into the corridor. The clearance is measured from 400 sample points along the fitted curve to the nearest vegetation point, giving a minimum of 1.8 metres at 164 metres along the span, which breaches the 2 metre threshold. Using only the scanned conductor points would have missed the worst location because of a gap in the returns there.</desc>
  <rect class="svg-bg" x="46" y="21" width="624" height="239" fill="#ffffff"/>
  <path d="M40 196 H700" stroke="#5b6471" stroke-width="1.6" fill="none"/>
  <path d="M90 196 V56" stroke="#5b6471" stroke-width="3" fill="none"/>
  <path d="M650 196 V56" stroke="#5b6471" stroke-width="3" fill="none"/>
  <path d="M90 56 Q370 176 650 56" stroke="#1f6b8a" stroke-width="2.6" fill="none"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.6">
    <path d="M250 196 L268 140 L286 196 Z"/>
    <path d="M380 196 L402 118 L424 196 Z"/>
  </g>
  <path d="M402 118 V150" stroke="#b0413e" stroke-width="2.4" fill="none"/>
  <g fill="#1f2937" font-size="12">
    <text x="412" y="112">tree crown</text>
    <text x="430" y="140">1.8 m — breach</text>
    <text x="370" y="192" text-anchor="middle">span 280 m · sag 7.4 m</text>
  </g>
  <g fill="#5b6471" font-size="12">
    <text x="60" y="48">pylon</text>
    <text x="624" y="48">pylon</text>
  </g>
  <g stroke="#1f6b8a" stroke-width="1" stroke-dasharray="3 3" fill="none">
    <path d="M300 196 V158 M340 196 V168 M440 196 V162 M480 196 V150"/>
  </g>
  <text x="370" y="226" fill="#1f2937" font-size="12.5" text-anchor="middle">clearance sampled at 400 points along the fitted curve, not at the scanned returns</text>
  <text x="370" y="242" fill="#5b6471" font-size="12" text-anchor="middle">the scanner missed the wire near the worst point; the fit covers the gap</text>
</svg>
<figcaption>The fitted curve is evaluated where the returns are missing, which is frequently exactly where the vegetation is closest.</figcaption>
</figure>

## Expected Output & Verification

```text
{'total_points': 41820418, 'candidates': 148204, 'reduction': 0.00354}
{'clusters': 38, 'discarded_small': 412, 'longest_m': 284.1}
{
  "direction": [0.9841, 0.1774, 0.0], "centre_xy": [598412.44, 6643188.91],
  "a": 1284.4, "s0": 2.18, "z0": 38.104,
  "span_m": 281.4, "sag_m": 7.412,
  "inliers": 1841, "points": 1904, "inlier_fraction": 0.9669, "rms_m": 0.0412
}
{'pylons': 9, 'mean_height_m': 34.18}
{'spans': 8, 'median_m': 281.0, 'min_m': 268.4, 'max_m': 294.8, 'suspicious': []}
{
  "measurable": true, "conductors": 24, "worst_clearance_m": 1.812,
  "worst_location_xy": [598574.12, 6643217.88],
  "conductors_breaching_2m": 2,
  "findings": [{"conductor": 11, "min_clearance_m": 1.812,
                "wire_z_m": 32.104, "vegetation_z_m": 30.402,
                "breaches": {"under_2.0m": 4, "under_3.5m": 31, "under_5.0m": 88}}]
}
```

A 4 cm RMS on the catenary fit with 97% inliers is the signature of a clean single-conductor fit. An inlier fraction near 0.5 means two conductors are in the cluster, and the fit should be repeated on the outliers.

Twenty-four conductors over eight spans is three per span, which is a single three-phase circuit — consistent with nine pylons at roughly 280 m spacing. That internal consistency is worth checking because it catches missed or duplicated detections.

Verify the conductor count and geometry against the circuit's nominal configuration:

```python
def circuit_consistency_check(catenaries, pylons, expected_conductors_per_span=3,
                              expected_span_m=None, tolerance=0.2):
    spans = max(len(pylons) - 1, 1)
    per_span = len(catenaries) / spans
    lengths = np.array([c["span_m"] for c in catenaries])
    sags = np.array([c["sag_m"] for c in catenaries])
    a_values = np.array([c["a"] for c in catenaries])

    findings = []
    if abs(per_span - expected_conductors_per_span) > tolerance * expected_conductors_per_span:
        findings.append(f"{per_span:.1f} conductors per span, expected "
                        f"{expected_conductors_per_span}")
    if expected_span_m and abs(float(np.median(lengths)) - expected_span_m) \
            > expected_span_m * tolerance:
        findings.append(f"median span {np.median(lengths):.0f} m, expected "
                        f"{expected_span_m} m")
    sag_cv = float(sags.std() / max(sags.mean(), 1e-9))
    if sag_cv > 0.35:
        findings.append(f"sag varies by {sag_cv:.0%} — mixed spans or bad fits")
    a_cv = float(a_values.std() / max(a_values.mean(), 1e-9))
    if a_cv > 0.4:
        findings.append(f"catenary constant varies by {a_cv:.0%} — inconsistent tension")

    return {"conductors": len(catenaries), "spans": spans,
            "per_span": round(per_span, 2),
            "median_span_m": round(float(np.median(lengths)), 1),
            "sag_mean_m": round(float(sags.mean()), 2),
            "sag_cv": round(sag_cv, 3),
            "catenary_constant_cv": round(a_cv, 3),
            "findings": findings, "consistent": not findings}

print(json.dumps(circuit_consistency_check(cats, pylons, expected_span_m=280), indent=2))
```

The catenary constant should be similar across every conductor of the same circuit, because they are strung at the same tension. A large spread means either the fits are unreliable or two different circuits have been merged — both worth resolving before a clearance report is issued.

Then verify against a sample of manually classified points, which is the only way to know the type II rate:

```python
def manual_sample_check(las_path, conductor_indices, sample=400, seed=9):
    """Sample classified conductors and their neighbourhoods for a visual audit list."""
    las = laspy.read(las_path)
    xyz = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])
    hag = np.asarray(las.HeightAboveGround)
    rng = np.random.default_rng(seed)
    picks = rng.choice(conductor_indices, size=min(sample, len(conductor_indices)),
                       replace=False)
    tree = cKDTree(xyz)
    rows = []
    for i in picks[:20]:
        neigh = tree.query_ball_point(xyz[i], r=2.0)
        local = xyz[neigh]
        centred = local - local.mean(axis=0)
        w = np.linalg.eigvalsh(centred.T @ centred / max(len(neigh), 1))[::-1]
        rows.append({"x": round(float(xyz[i, 0]), 2), "y": round(float(xyz[i, 1]), 2),
                     "z": round(float(xyz[i, 2]), 2),
                     "hag_m": round(float(hag[i]), 2),
                     "neighbours_2m": len(neigh),
                     "linearity": round(float((w[0] - w[1]) / max(w[0], 1e-12)), 3)})
    return {"sampled": len(picks), "audit_rows": rows[:6],
            "median_hag_m": round(float(np.median(hag[picks])), 2),
            "median_linearity": round(float(np.median([r["linearity"] for r in rows])), 3)}
```

## Performance Notes

- **The height filter does the heavy lifting**: reducing 41 million points to 148,000 candidates makes every per-point eigenvalue computation affordable.
- **The eigenvalue loop is the slowest Python step** at roughly 20 µs per point — 3 seconds for 148,000. Vectorising with a fixed neighbour count is 5× faster and slightly less accurate on sparse conductors.
- **`query_ball_point` with `workers=-1`** parallelises the neighbour search and is the single easiest speed-up.
- **RANSAC with 200 trials per cluster is milliseconds.** The `least_squares` refinement dominates and is still under 10 ms.
- **The clearance query is 400 points per conductor** against a vegetation tree of a few million — under a second for 24 conductors.
- **Process by corridor segment with overlap.** A conductor crossing a tile boundary must be clustered whole, so a 400 m buffer is needed.

## Common Errors

**No candidates.** `HeightAboveGround` was not written, or the classification excluded everything. Check `extra_dims` on the writer.

**Conductors merged into one cluster.** Link distance exceeds phase separation. Reduce it, and rely on RANSAC to separate what remains.

**Catenary fit has 50% inliers.** Two conductors in the cluster. Fit again on the outliers.

**Catenary fit fails entirely.** The cluster spans more than one span, so no single catenary fits. Split by pylon first.

**Pylons detected twice.** A lattice tower's legs cluster separately. Increase the clustering distance in plan, or merge detections within 15 m.

**Vegetation classified as conductor.** A dense linear hedge can reach linearity 0.9. Raise the height floor and tighten the scattering threshold.

**Clearance looks generous and the field crew disagrees.** The survey was flown in cool weather; conductors sag further when hot. Adjust the catenary's `a` for maximum operating temperature before reporting.

## Frequently Asked Questions

### Which ASPRS classes should I write?

14 for conductors, 13 for wire guard or shield wire, 15 for transmission towers, 16 for wire-structure connectors. Using the reserved classes means downstream tools recognise the result.

### Does this work for distribution lines on poles?

Partly. Distribution conductors are lower, thinner and closer together, so the height floor has to drop and the link distance has to shrink — and at typical airborne densities there may be too few returns per conductor to fit a catenary. Mobile or UAV lidar is the better source there.

### How do I handle the sag temperature correction?

The catenary constant `a` scales with tension, which falls as the conductor heats and lengthens. The circuit owner supplies a sag table; re-evaluating `catenary_z` with the hot-weather `a` gives the clearance at maximum operating temperature, which is the figure regulations use.

## Related Guides

- [Ground Classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) — the ground this measures height above
- [Training a Random Forest Point Classifier](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/training-a-random-forest-point-classifier/) — the same eigenvalue features as machine-learning inputs
- [Radius Outlier Removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/) — cleaning the noise that mimics thin linear features

Back to [Lidar Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
