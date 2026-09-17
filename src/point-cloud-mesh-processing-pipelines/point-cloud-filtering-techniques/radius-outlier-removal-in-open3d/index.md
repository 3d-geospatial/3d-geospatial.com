---
title: "Radius Outlier Removal in Open3D"
description: "Remove noise without eating real detail: radius and statistical outlier removal compared, density-aware parameters"
---
# Radius Outlier Removal in Open3D

This page removes noise from a point cloud with Open3D's radius and statistical outlier filters — choosing the radius and neighbour count from the cloud's own density rather than from an example, comparing the two filters on the same data, protecting thin structures the filters would otherwise eat, and auditing what was removed so a filter that deletes real geometry is caught.

## Why you hit this

Every point cloud has noise. Photogrammetry produces floating fragments where matching failed; lidar produces returns from birds, dust, rain and reflections; terrestrial scanners produce a haze of mixed pixels at every edge. Left in, that noise becomes spikes in a mesh, false change in a difference calculation and spurious volume in a stockpile.

Removing it is easy to do badly. An outlier filter tuned on a dense area will strip the sparse margins of the same cloud, and one tuned to spare the margins leaves the noise. The filters also do not know the difference between a noise point and a genuinely isolated one — a power-line conductor, a fence wire, a railing — and will happily remove them both.

## Prerequisites

- Python 3.10+ with `open3d>=0.18`, `numpy`, `scipy`, `laspy`.
- A point cloud with known nominal density, or the ability to measure it.
- Knowledge of the thinnest real structure in the scene, in metres.

## Step-by-Step

### 1. Measure the density before choosing any parameter

```python
import json
import math
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

def density_profile(points, sample=200_000, k=8, seed=7):
    """Nearest-neighbour statistics, and how much they vary across the cloud."""
    rng = np.random.default_rng(seed)
    tree = cKDTree(points)
    pick = rng.choice(len(points), size=min(sample, len(points)), replace=False)
    d, _ = tree.query(points[pick], k=k + 1, workers=-1)
    nn1 = d[:, 1]
    nnk = d[:, k]
    return {
        "points": int(len(points)),
        "mean_nn_m": round(float(nn1.mean()), 5),
        "p05_nn_m": round(float(np.percentile(nn1, 5)), 5),
        "p95_nn_m": round(float(np.percentile(nn1, 95)), 5),
        "density_ratio_p95_p05": round(float(np.percentile(nn1, 95)
                                             / max(np.percentile(nn1, 5), 1e-9)), 2),
        f"mean_r_for_{k}_neighbours_m": round(float(nnk.mean()), 5),
        f"p95_r_for_{k}_neighbours_m": round(float(np.percentile(nnk, 95)), 5),
        "uniform": float(np.percentile(nn1, 95) / max(np.percentile(nn1, 5), 1e-9)) < 3.0,
    }

def suggest_radius_parameters(profile, k=8, safety=1.6):
    """A radius large enough that a legitimate point in a sparse area keeps k neighbours."""
    r = profile[f"p95_r_for_{k}_neighbours_m"] * safety
    return {"nb_points": k, "radius_m": round(r, 4),
            "rationale": f"radius covers k={k} neighbours at the 95th-percentile "
                         f"sparsity, times {safety} safety"}
```

Deriving the radius from the 95th-percentile sparsity rather than from the mean is the parameter choice that makes this work on a real cloud. A radius set from the mean spacing removes every point in the sparsest 30% of the cloud — the margins of a flight line, the edges of a scan, the shaded side of a building — because those points legitimately have fewer neighbours.

The `density_ratio_p95_p05` figure says whether a single parameter set can work at all. Below about 3 it can; a lidar strip with a 10× density variation between nadir and swath edge needs either per-region parameters or a filter that normalises for density first.

<figure class="diagram">
<svg viewBox="4 6 732 254" role="img" aria-labelledby="ror-density-t ror-density-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ror-density-t">Why a radius from the mean spacing strips the sparse areas</title>
  <desc id="ror-density-d">Three regions of the same lidar strip with different densities. The nadir region has 4 centimetre spacing, the mid-swath 9 centimetres and the swath edge 21 centimetres. A radius of 12 centimetres derived from the mean spacing leaves 14 neighbours at nadir, 5 at mid-swath and 1 at the edge, so a minimum of 6 neighbours deletes the entire swath edge. A radius of 34 centimetres derived from the 95th-percentile sparsity leaves 6 or more neighbours everywhere.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="254" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="186" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="204" y="20" width="140" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="344" y="20" width="184" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="528" y="20" width="194" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="186" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="204" y="54" width="140" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="344" y="54" width="184" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="528" y="54" width="194" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="92" width="186" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="204" y="92" width="140" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="344" y="92" width="184" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="528" y="92" width="194" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="130" width="186" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="204" y="130" width="140" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="344" y="130" width="184" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="528" y="130" width="194" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="111" y="41">region</text><text x="274" y="41">spacing</text>
    <text x="436" y="41">neighbours at r = 12 cm</text>
    <text x="625" y="41">neighbours at r = 34 cm</text>
    <text x="111" y="78">nadir</text><text x="274" y="78">4 cm</text>
    <text x="436" y="78">14 — kept</text><text x="625" y="78">96 — kept</text>
    <text x="111" y="116">mid-swath</text><text x="274" y="116">9 cm</text>
    <text x="436" y="116">5 — deleted</text><text x="625" y="116">19 — kept</text>
    <text x="111" y="154">swath edge</text><text x="274" y="154">21 cm</text>
    <text x="436" y="154">1 — deleted</text><text x="625" y="154">6 — kept</text>
  </g>
  <text x="370" y="196" fill="#b0413e" font-size="12.5" text-anchor="middle">a 12 cm radius with nb_points = 6 deletes two-thirds of the strip's area</text>
  <text x="370" y="220" fill="#1f2937" font-size="12.5" text-anchor="middle">34 cm comes from the 95th-percentile radius for 8 neighbours, times 1.6</text>
  <text x="370" y="242" fill="#5b6471" font-size="12" text-anchor="middle">measure the density first; it is two lines and it is the difference between a filter and a deletion</text>
</svg>
<figcaption>The same filter parameters keep the dense area and delete the sparse one, and the sparse area is where the useful edge coverage is.</figcaption>
</figure>

### 2. Run radius outlier removal

```python
def radius_outlier_removal(points, radius_m, nb_points, attributes=None):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    kept_pcd, kept_idx = pcd.remove_radius_outlier(nb_points=int(nb_points),
                                                   radius=float(radius_m))
    kept = np.asarray(kept_idx, dtype=np.int64)
    removed = np.setdiff1d(np.arange(len(points)), kept, assume_unique=False)
    attr_out = {name: values[kept] for name, values in (attributes or {}).items()}
    return {
        "kept_indices": kept,
        "removed_indices": removed,
        "attributes": attr_out,
        "stats": {
            "input": int(len(points)),
            "kept": int(len(kept)),
            "removed": int(len(removed)),
            "removed_fraction": round(float(len(removed)) / max(len(points), 1), 5),
            "radius_m": radius_m, "nb_points": int(nb_points),
        },
    }
```

Open3D's `remove_radius_outlier` deletes any point with fewer than `nb_points` neighbours inside `radius`. It is a direct, absolute density test, which makes it predictable and makes it density-sensitive — the two properties this page keeps returning to.

Keeping the removed indices rather than only the kept ones is what makes the audit in step 5 possible. It costs one `setdiff1d` and turns "the filter removed 1.4%" into "here is exactly what it removed, and here is why that is or is not acceptable".

### 3. Compare against the statistical filter

```python
def statistical_outlier_removal(points, nb_neighbors=20, std_ratio=2.0,
                                attributes=None):
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    kept_pcd, kept_idx = pcd.remove_statistical_outlier(
        nb_neighbors=int(nb_neighbors), std_ratio=float(std_ratio))
    kept = np.asarray(kept_idx, dtype=np.int64)
    removed = np.setdiff1d(np.arange(len(points)), kept)
    attr_out = {name: values[kept] for name, values in (attributes or {}).items()}
    return {
        "kept_indices": kept, "removed_indices": removed, "attributes": attr_out,
        "stats": {"input": int(len(points)), "kept": int(len(kept)),
                  "removed": int(len(removed)),
                  "removed_fraction": round(float(len(removed)) / max(len(points), 1), 5),
                  "nb_neighbors": int(nb_neighbors), "std_ratio": std_ratio},
    }

FILTER_CHARACTER = {
    "radius": {
        "test": "absolute: fewer than N neighbours within r",
        "density_sensitive": True,
        "removes": "isolated points and sparse regions alike",
        "good_for": "birds, stray returns, floating photogrammetry fragments",
        "risk": "deletes legitimate sparse areas and thin structures",
    },
    "statistical": {
        "test": "relative: mean neighbour distance more than k σ above the cloud mean",
        "density_sensitive": True,
        "removes": "points whose local spacing is unusual for this cloud",
        "good_for": "edge noise and mixed pixels in a uniform-density cloud",
        "risk": "on a cloud with two density regimes, deletes the sparser one wholesale",
    },
}
```

The statistical filter is often described as density-adaptive and is not: it compares each point's mean neighbour distance against a **global** mean and standard deviation, so on a cloud with a dense core and a sparse margin the entire margin sits above the threshold and is removed. It adapts to the cloud, not to the neighbourhood.

Where it genuinely wins is edge noise in a uniform cloud. Terrestrial scan data has a haze of mixed-pixel points a few centimetres off every edge, and those points have slightly larger neighbour distances than the surface — enough for a 2σ test to catch them and not enough for an absolute neighbour count.

Running both and comparing what each removed, rather than picking one, is the approach that makes the choice on evidence.

### 4. Protect the thin structures

```python
def protect_thin_structures(points, removed_indices, linearity_min=0.9,
                            radius_m=0.5, min_cluster=12):
    """Re-examine removed points: a linear cluster is a wire or railing, not noise."""
    if len(removed_indices) == 0:
        return {"rescued": np.array([], dtype=np.int64), "clusters_rescued": 0}

    pts = points[removed_indices]
    tree = cKDTree(pts)
    pairs = tree.query_pairs(radius_m, output_type="ndarray")
    if len(pairs) == 0:
        return {"rescued": np.array([], dtype=np.int64), "clusters_rescued": 0}

    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components
    graph = csr_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])),
                       shape=(len(pts), len(pts)))
    count, labels = connected_components(graph, directed=False)

    rescued, details = [], []
    for label in range(count):
        sel = labels == label
        if sel.sum() < min_cluster:
            continue
        local = pts[sel]
        centred = local - local.mean(axis=0)
        w = np.linalg.eigvalsh(centred.T @ centred / len(local))[::-1]
        w = np.clip(w, 1e-12, None)
        linearity = (w[0] - w[1]) / w[0]
        if linearity >= linearity_min:
            rescued.append(removed_indices[sel])
            details.append({"points": int(sel.sum()),
                            "linearity": round(float(linearity), 3),
                            "extent_m": round(float(np.linalg.norm(
                                local.max(axis=0) - local.min(axis=0))), 2)})
    return {
        "rescued": np.concatenate(rescued) if rescued else np.array([], dtype=np.int64),
        "clusters_rescued": len(rescued),
        "rescued_points": int(sum(d["points"] for d in details)),
        "details": sorted(details, key=lambda d: -d["points"])[:5],
    }
```

Rescuing linear clusters from the removed set is the safeguard that keeps an outlier filter usable on infrastructure data. A fence wire, a catenary, a handrail and a lightning conductor are all sparse, isolated and linear — exactly the profile of a noise point by the filter's test, and exactly the geometry noise does not have.

Noise is scattered by nature. A cluster of a dozen removed points with linearity above 0.9 over a metre or more is a structure, and the eigenvalue test that finds conductors in [detecting power lines in lidar](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/detecting-power-lines-in-lidar/) works equally well here.

The same idea extends to other protected geometry: a planarity test rescues thin fences and signboards, and a class-based exemption rescues anything already classified as a structure.

### 5. Audit what was removed

```python
def removal_audit(points, removed_indices, attributes=None, cell_m=5.0):
    if len(removed_indices) == 0:
        return {"removed": 0, "verdict": "nothing removed"}

    pts = points[removed_indices]
    tree = cKDTree(points)
    d_to_kept, _ = tree.query(pts, k=2, workers=-1)
    isolation = d_to_kept[:, 1]

    keys = np.floor(pts[:, :2] / cell_m).astype(np.int64)
    packed = keys[:, 0] * 1_000_003 + keys[:, 1]
    unique, counts = np.unique(packed, return_counts=True)

    by_class = {}
    if attributes and "classification" in attributes:
        cls = attributes["classification"][removed_indices]
        for value, count in zip(*np.unique(cls, return_counts=True)):
            by_class[int(value)] = int(count)

    height_profile = {
        "min_z": round(float(pts[:, 2].min()), 2),
        "p50_z": round(float(np.percentile(pts[:, 2], 50)), 2),
        "max_z": round(float(pts[:, 2].max()), 2),
    }
    return {
        "removed": int(len(removed_indices)),
        "median_isolation_m": round(float(np.median(isolation)), 4),
        "p05_isolation_m": round(float(np.percentile(isolation, 5)), 4),
        "spatial_clustering": {
            "cells_touched": int(len(unique)),
            "max_removed_in_one_cell": int(counts.max()),
            "cells_with_over_50": int((counts > 50).sum()),
        },
        "by_classification": by_class,
        "height_profile": height_profile,
        "verdict": "suspicious: removals are spatially clustered, "
                   "likely a sparse region rather than noise"
                   if int((counts > 50).sum()) > 5
                   else "consistent with scattered noise",
    }
```

Spatially clustered removals are the signature of over-filtering. Genuine noise is scattered: a bird here, a stray return there, distributed across the cloud with a handful of points per cell. A cell with 400 removed points is not a cell full of birds — it is a sparse region the filter decided was all noise.

The `p05_isolation_m` figure is the other tell. Real noise points are far from everything; if the 5th percentile of removed points' distance to the nearest kept point is a few centimetres, the filter removed points that were sitting on a surface.

Breaking removals down by classification catches the worst case immediately: any removal from class 14 or class 6 is almost certainly a mistake.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="ror-choice-t ror-choice-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ror-choice-t">Radius against statistical outlier removal</title>
  <desc id="ror-choice-d">A table contrasting the two Open3D outlier filters. The radius filter applies an absolute test, fewer than N neighbours within a radius, and is predictable and density-sensitive. The statistical filter compares each point's mean neighbour distance against a global mean and standard deviation, which adapts to the cloud rather than to the neighbourhood and removes a sparse regime wholesale. Only the radius filter should run on a non-uniform cloud.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="192" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="210" y="20" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="464" y="20" width="258" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="192" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="210" y="54" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="464" y="54" width="258" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="88" width="192" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="210" y="88" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="464" y="88" width="258" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="192" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="210" y="122" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="464" y="122" width="258" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="192" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="210" y="156" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="464" y="156" width="258" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="114" y="42">property</text><text x="337" y="42">radius filter</text><text x="593" y="42">statistical filter</text>
    <text x="114" y="76">test</text><text x="337" y="76">absolute: N neighbours in r</text><text x="593" y="76">relative: k sigma from the mean</text>
    <text x="114" y="110">predictable</text><text x="337" y="110">yes — parameters are physical</text><text x="593" y="110">less so</text>
    <text x="114" y="144">good for</text><text x="337" y="144">birds, strays, fragments</text><text x="593" y="144">edge noise, mixed pixels</text>
    <text x="114" y="178">non-uniform cloud</text><text x="337" y="178">usable with a sparse-tail radius</text><text x="593" y="178">removes the sparse regime</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">The statistical filter is often described as density-adaptive and compares against a global mean.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Run radius first as the default; add statistical only when the cloud is uniform.</text>
</svg>
<figcaption>Both are density-sensitive; only the radius filter can be made safe on a cloud with two density regimes.</figcaption>
</figure>

### 6. Put it together with the right ordering

```python
def clean_cloud(points, attributes=None, target_k=8, safety=1.6,
                protect_linear=True, statistical_pass=True):
    profile = density_profile(points, k=target_k)
    params = suggest_radius_parameters(profile, k=target_k, safety=safety)

    radius_result = radius_outlier_removal(points, params["radius_m"],
                                           params["nb_points"], attributes)
    removed = radius_result["removed_indices"]

    rescue = {"rescued": np.array([], dtype=np.int64), "clusters_rescued": 0}
    if protect_linear:
        rescue = protect_thin_structures(points, removed)
        removed = np.setdiff1d(removed, rescue["rescued"])

    kept = np.setdiff1d(np.arange(len(points)), removed)
    audit = removal_audit(points, removed, attributes)

    stage_two = None
    if statistical_pass and profile["uniform"]:
        stage_two = statistical_outlier_removal(points[kept], nb_neighbors=20,
                                                std_ratio=2.5)
        kept = kept[stage_two["kept_indices"]]

    return {
        "density": profile,
        "parameters": params,
        "radius_pass": radius_result["stats"],
        "rescued": {"clusters": rescue["clusters_rescued"],
                    "points": int(len(rescue["rescued"]))},
        "statistical_pass": stage_two["stats"] if stage_two else
                            {"skipped": "cloud is not uniform enough"},
        "final_points": int(len(kept)),
        "total_removed_fraction": round(1.0 - len(kept) / max(len(points), 1), 5),
        "audit": audit,
        "kept_indices": kept,
    }
```

Filtering **before** downsampling is the ordering that matters. A voxel downsample computed over noisy data pulls the surviving point towards the noise — with the centroid method it produces a synthetic point displaced towards a bird — whereas filtering first means the downsample sees only real surface.

Running the statistical pass only when the cloud is uniform is the other conditional worth having. On a non-uniform cloud it removes the sparse regime wholesale, so the honest behaviour is to skip it and say why.

<figure class="diagram">
<svg viewBox="2 22 618 246" role="img" aria-labelledby="ror-order-t ror-order-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ror-order-t">Filter order and what each stage removes</title>
  <desc id="ror-order-d">A pipeline over 41 million points. Density measurement sets the radius at 34 centimetres for 8 neighbours. The radius pass removes 612000 points, 1.5 percent. A linear-cluster rescue returns 18400 of them belonging to 31 conductor and railing clusters. An audit confirms the remaining removals are scattered rather than clustered. A statistical pass then removes a further 84000 edge-noise points. Downsampling runs last, on clean data.</desc>
  <rect class="svg-bg" x="2" y="22" width="618" height="246" fill="#ffffff"/>
  <defs>
    <marker id="ror-order-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.8">
    <rect x="16" y="36" width="122" height="54" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="172" y="36" width="122" height="54" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="328" y="36" width="122" height="54" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="484" y="36" width="122" height="54" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="16" y="150" width="122" height="54" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="172" y="150" width="122" height="54" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#ror-order-arrow)">
    <path d="M138 63 H170"/><path d="M294 63 H326"/><path d="M450 63 H482"/>
    <path d="M545 90 V124 H77 V148"/>
    <path d="M138 177 H170"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="77" y="58">measure density</text><text x="77" y="76">r = 0.34 m, k = 8</text>
    <text x="233" y="58">radius pass</text><text x="233" y="76">−612 k (1.5%)</text>
    <text x="389" y="58">rescue linear</text><text x="389" y="76">+18.4 k (31)</text>
    <text x="545" y="58">audit removals</text><text x="545" y="76">scattered ✓</text>
    <text x="77" y="172">statistical pass</text><text x="77" y="190">−84 k edge noise</text>
    <text x="233" y="172">downsample</text><text x="233" y="190">on clean data</text>
  </g>
  <text x="20" y="232" fill="#1f2937" font-size="12.5">downsampling before filtering pulls surviving points towards the noise</text>
  <text x="20" y="250" fill="#5b6471" font-size="12">and the rescue step runs before the audit, or the audit flags the conductors</text>
</svg>
<figcaption>Six stages, and the two that people skip are the rescue and the audit — which are the two that catch a filter deleting real geometry.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "density": {"points": 41820418, "mean_nn_m": 0.0684, "p05_nn_m": 0.0312,
              "p95_nn_m": 0.2104, "density_ratio_p95_p05": 6.74,
              "mean_r_for_8_neighbours_m": 0.1418,
              "p95_r_for_8_neighbours_m": 0.2118, "uniform": false},
  "parameters": {"nb_points": 8, "radius_m": 0.3389,
                 "rationale": "radius covers k=8 neighbours at the 95th-percentile sparsity, times 1.6"},
  "radius_pass": {"input": 41820418, "kept": 41208418, "removed": 612000,
                  "removed_fraction": 0.01463, "radius_m": 0.3389, "nb_points": 8},
  "rescued": {"clusters": 31, "points": 18412},
  "statistical_pass": {"skipped": "cloud is not uniform enough"},
  "final_points": 41226830,
  "total_removed_fraction": 0.0142,
  "audit": {
    "removed": 593588,
    "median_isolation_m": 0.842, "p05_isolation_m": 0.3512,
    "spatial_clustering": {"cells_touched": 38412, "max_removed_in_one_cell": 41,
                           "cells_with_over_50": 0},
    "by_classification": {1: 581204, 5: 12384},
    "verdict": "consistent with scattered noise"
  }
}
```

A 1.4% removal with a median isolation of 84 cm, no cell holding more than 41 removed points, and removals almost entirely from the unclassified class is the shape of a well-tuned filter. The 31 rescued clusters are the conductors and railings that the radius test would have deleted.

The statistical pass being skipped is the correct behaviour on a cloud with a 6.7× density ratio, and stating the reason is better than running it and quietly losing the swath edges.

Verify the filter did not remove points from a surface, which is the failure the removal count cannot show:

```python
def surface_preservation_check(points, removed_indices, kept_indices,
                               plane_radius_m=0.5, planarity_min=0.6):
    """A removed point whose neighbourhood in the KEPT cloud is planar was on a surface."""
    if len(removed_indices) == 0:
        return {"checked": 0, "on_surface": 0}
    kept_pts = points[kept_indices]
    tree = cKDTree(kept_pts)
    rng = np.random.default_rng(3)
    sample = rng.choice(removed_indices,
                        size=min(20_000, len(removed_indices)), replace=False)

    on_surface, rows = 0, []
    for i in sample:
        neigh = tree.query_ball_point(points[i], r=plane_radius_m)
        if len(neigh) < 8:
            continue
        local = kept_pts[neigh]
        centred = local - local.mean(axis=0)
        w = np.linalg.eigvalsh(centred.T @ centred / len(local))[::-1]
        w = np.clip(w, 1e-12, None)
        planarity = (w[1] - w[2]) / w[0]
        normal_dist = abs(float((points[i] - local.mean(axis=0))
                                @ np.linalg.eigh(centred.T @ centred)[1][:, 0]))
        if planarity >= planarity_min and normal_dist < 0.05:
            on_surface += 1
            rows.append({"xyz": [round(float(v), 2) for v in points[i]],
                         "planarity": round(float(planarity), 3),
                         "distance_to_plane_m": round(normal_dist, 4)})
    return {
        "checked": int(len(sample)),
        "on_surface": on_surface,
        "on_surface_fraction": round(on_surface / max(len(sample), 1), 4),
        "examples": rows[:4],
        "acceptable": on_surface / max(len(sample), 1) < 0.02,
        "note": "a removed point within 5 cm of a planar neighbourhood of kept points "
                "was almost certainly real",
    }

print(json.dumps(surface_preservation_check(points, removed, kept), indent=2))
```

This check answers the question the removal count cannot: were the deleted points on a surface? A removed point sitting within 5 cm of a plane defined by its surviving neighbours was not noise, it was a point the filter happened to find isolated — and more than about 2% of those means the parameters are too aggressive.

Then verify the filter's effect on the downstream product rather than on the cloud:

```python
def downstream_effect_check(points, kept_indices, mesh_fn, tolerance_m=0.02):
    """Reconstruct a small patch before and after, and compare the surfaces."""
    import trimesh
    rng = np.random.default_rng(5)
    centre = points[rng.integers(len(points))]
    tree_all = cKDTree(points)
    patch_all = np.asarray(tree_all.query_ball_point(centre, r=15.0))
    kept_set = set(kept_indices.tolist())
    patch_kept = np.array([i for i in patch_all if i in kept_set], dtype=np.int64)

    mesh_before = mesh_fn(points[patch_all])
    mesh_after = mesh_fn(points[patch_kept])
    if mesh_before is None or mesh_after is None:
        return {"comparable": False}

    sample = trimesh.sample.sample_surface(mesh_after, 20_000, seed=5)[0]
    _, d, _ = mesh_before.nearest.on_surface(sample)
    spikes_before = int((mesh_before.vertices[:, 2]
                         > np.percentile(mesh_before.vertices[:, 2], 99.9) + 0.5).sum())
    spikes_after = int((mesh_after.vertices[:, 2]
                        > np.percentile(mesh_after.vertices[:, 2], 99.9) + 0.5).sum())
    return {
        "comparable": True,
        "patch_points_before": int(len(patch_all)),
        "patch_points_after": int(len(patch_kept)),
        "mean_surface_shift_m": round(float(np.asarray(d).mean()), 4),
        "spike_vertices_before": spikes_before,
        "spike_vertices_after": spikes_after,
        "spikes_removed": spikes_before - spikes_after,
        "improved": spikes_after < spikes_before,
    }
```

Counting spikes in a reconstructed patch before and after is the most convincing demonstration that the filter helped, because spikes are the concrete harm noise causes. A filter that removes 1.4% of points and no spikes was not needed; one that removes the same 1.4% and eliminates 40 spikes has earned its place.

## Performance Notes

- **`remove_radius_outlier` is O(n log n)** and runs at roughly 1–2 million points per second in Open3D. 41 million points is 20–40 seconds.
- **`remove_statistical_outlier` needs a k-NN query per point** and is about twice as slow for the same cloud.
- **Density profiling on a 200,000-point sample is under a second** and is always worth doing first.
- **Memory is the real limit.** Open3D holds the cloud as float64, so 41 million points is 1 GB for positions alone; process per tile.
- **The rescue step only examines removed points** — 612,000 rather than 41 million — so it costs seconds.
- **Filter before downsampling, and filter before normal estimation.** Both are corrupted by noise in ways that are hard to undo.

## Common Errors

**A third of the cloud was removed.** The radius came from the mean spacing, not the sparse tail. Measure the density.

**The swath edges are gone.** Same cause, or the statistical filter ran on a non-uniform cloud.

**Conductors and railings disappeared.** No linear rescue. Add it, or exempt the relevant classes.

**`MemoryError` on a large cloud.** Open3D copies to float64. Tile the input.

**The filter removed nothing.** `nb_points` is below the minimum any point has. Check the density profile's neighbour counts.

**Removals are concentrated in one area.** The audit's spatial clustering test catches this; it means a sparse region, not noise.

**Mesh still has spikes after filtering.** The spikes come from points that are *near* a surface but wrong — mixed pixels — which a density filter cannot catch. A statistical filter or a normal-consistency filter is the tool for those.

## Frequently Asked Questions

### Radius or statistical?

Radius as the default, because its behaviour is predictable and its parameters have physical meanings. Statistical as a second pass on uniform clouds to catch edge noise the radius test misses.

### Should I filter before or after classification?

After, where a classification exists: it lets you exempt structural classes from removal and makes the audit far more informative. Before, if the classifier itself is being confused by the noise.

### What removal fraction is normal?

0.1–2% for airborne lidar, 1–5% for photogrammetry, higher for terrestrial scans with a lot of edge noise. Above about 5%, check the audit before believing it.

## Related Guides

- [Voxel Downsampling Strategies Compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — the step that must come after filtering
- [Detecting Power Lines in Lidar](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/detecting-power-lines-in-lidar/) — the linearity test the rescue step borrows
- [Cropping Point Clouds to Polygons with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/cropping-point-clouds-to-polygons-with-pdal/) — removing by extent rather than by density

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
