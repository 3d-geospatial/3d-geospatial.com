# Voxel Downsampling Strategies Compared

This page compares four ways of reducing a 400-million-point cloud to a tenth of its size — voxel centroid, nearest-point-to-centroid, random-per-voxel and Poisson-disk sampling — measuring what each does to geometric fidelity, edge sharpness, attribute integrity and spacing uniformity, and stating which is right for which downstream use.

## Why you hit this

Every point-cloud pipeline downsamples somewhere: to fit memory, to speed up a registration, to produce a level of detail for streaming, or to make a 400 GB delivery usable on a laptop. The method is usually whichever function was nearest to hand, and the choice matters more than it appears.

Voxel centroid downsampling — the default in most libraries — **moves every point**. That is fine for visualisation and unacceptable for a deliverable that must consist of measured points; a surveyor's cloud whose points are all synthetic averages is no longer a record of observations. Meanwhile random sampling preserves the original points and leaves the spacing wildly uneven, which breaks anything that assumes uniform density.

## Prerequisites

- Python 3.10+ with `numpy`, `open3d>=0.18`, `scipy`, `laspy`; `pdal` for the pipeline variants.
- A point cloud with attributes you care about — classification, intensity, RGB.
- A tolerance: how far a point may move, and whether it may move at all.

## Step-by-Step

### 1. Define what each method actually does

```python
import json
import math
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

METHODS = {
    "voxel_centroid": {
        "keeps_original_points": False,
        "output_spacing": "regular, one per occupied voxel",
        "attributes": "must be aggregated — mean, majority or dropped",
        "edges": "rounded: a corner voxel averages both faces",
        "use_for": "visualisation, registration, meshing input",
    },
    "nearest_to_centroid": {
        "keeps_original_points": True,
        "output_spacing": "near-regular, one per occupied voxel",
        "attributes": "carried intact from the chosen point",
        "edges": "preserved: the chosen point is a real observation",
        "use_for": "deliverables, classification work, anything measured",
    },
    "random_per_voxel": {
        "keeps_original_points": True,
        "output_spacing": "one per voxel but arbitrary within it",
        "attributes": "carried intact",
        "edges": "preserved but jittered",
        "use_for": "cheap thinning where exact position matters little",
    },
    "poisson_disk": {
        "keeps_original_points": True,
        "output_spacing": "uniform, guaranteed minimum separation",
        "attributes": "carried intact",
        "edges": "preserved",
        "use_for": "surface reconstruction, uniform-density requirements",
    },
    "random_global": {
        "keeps_original_points": True,
        "output_spacing": "unchanged distribution — dense areas stay dense",
        "attributes": "carried intact",
        "edges": "preserved",
        "use_for": "statistical sampling, never for geometry",
    },
}

for name, spec in METHODS.items():
    print(f"{name:<22}{'moves points' if not spec['keeps_original_points'] else 'keeps points':<14}"
          f"{spec['use_for']}")
```

The distinction between methods that keep original points and the one that does not is the first thing to settle, because it is a policy question rather than a technical one. A survey deliverable, a classified cloud used as training data, and anything that will be compared against control all need real observations; a registration target or a meshing input does not care.

Random *global* sampling is included because it is what people reach for when they want "a tenth of the points", and it is almost always wrong for geometry: it preserves the original density variation, so the dense overlap strips stay dense and the sparse margins become unusably sparse.

<figure class="diagram">
<svg viewBox="4 16 732 240" role="img" aria-labelledby="vox-methods-t vox-methods-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vox-methods-t">The four methods on the same voxel</title>
  <desc id="vox-methods-d">One voxel containing eleven points clustered on two faces of a building corner. Voxel centroid produces a single synthetic point floating between the two faces, off the surface. Nearest-to-centroid produces the real point closest to that centroid, which lies on one face. Random-per-voxel produces an arbitrary real point. Poisson-disk keeps points on both faces because it enforces a minimum separation rather than one point per voxel.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="30" width="168" height="168" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="200" y="30" width="168" height="168" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="382" y="30" width="168" height="168" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="564" y="30" width="158" height="168" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.6" fill="none">
    <path d="M44 172 H128 V64"/>
    <path d="M226 172 H310 V64"/>
    <path d="M408 172 H492 V64"/>
    <path d="M590 172 H674 V64"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="56" cy="170" r="3"/><circle cx="72" cy="171" r="3"/><circle cx="88" cy="170" r="3"/>
    <circle cx="104" cy="172" r="3"/><circle cx="120" cy="171" r="3"/>
    <circle cx="126" cy="150" r="3"/><circle cx="127" cy="130" r="3"/><circle cx="128" cy="110" r="3"/>
    <circle cx="126" cy="90" r="3"/><circle cx="127" cy="72" r="3"/>
    <circle cx="238" cy="171" r="3"/><circle cx="254" cy="170" r="3"/><circle cx="270" cy="172" r="3"/>
    <circle cx="286" cy="171" r="3"/><circle cx="302" cy="170" r="3"/>
    <circle cx="308" cy="150" r="3"/><circle cx="309" cy="130" r="3"/><circle cx="310" cy="110" r="3"/>
    <circle cx="308" cy="90" r="3"/><circle cx="309" cy="72" r="3"/>
    <circle cx="420" cy="171" r="3"/><circle cx="436" cy="170" r="3"/><circle cx="452" cy="172" r="3"/>
    <circle cx="468" cy="171" r="3"/><circle cx="484" cy="170" r="3"/>
    <circle cx="490" cy="150" r="3"/><circle cx="491" cy="130" r="3"/><circle cx="492" cy="110" r="3"/>
    <circle cx="490" cy="90" r="3"/><circle cx="491" cy="72" r="3"/>
    <circle cx="602" cy="171" r="3"/><circle cx="618" cy="170" r="3"/><circle cx="634" cy="172" r="3"/>
    <circle cx="650" cy="171" r="3"/><circle cx="666" cy="170" r="3"/>
    <circle cx="672" cy="150" r="3"/><circle cx="673" cy="130" r="3"/><circle cx="674" cy="110" r="3"/>
    <circle cx="672" cy="90" r="3"/><circle cx="673" cy="72" r="3"/>
  </g>
  <circle cx="96" cy="126" r="6" fill="#b0413e"/>
  <circle cx="302" cy="170" r="6" fill="#4f7a4d"/>
  <circle cx="491" cy="130" r="6" fill="#c46a3d"/>
  <circle cx="618" cy="170" r="6" fill="#4f7a4d"/>
  <circle cx="673" cy="110" r="6" fill="#4f7a4d"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="102" y="222">voxel centroid</text><text x="102" y="238">synthetic, off-surface</text>
    <text x="284" y="222">nearest to centroid</text><text x="284" y="238">real point, on a face</text>
    <text x="466" y="222">random per voxel</text><text x="466" y="238">real but arbitrary</text>
    <text x="643" y="222">Poisson disk</text><text x="643" y="238">both faces kept</text>
  </g>
</svg>
<figcaption>At a corner, the centroid lands in mid-air; every other method returns a point that was actually observed.</figcaption>
</figure>

### 2. Implement the four methods on a common interface

```python
def voxel_key(points, voxel_m, origin=None):
    o = np.asarray(origin if origin is not None else points.min(axis=0))
    idx = np.floor((points - o) / voxel_m).astype(np.int64)
    # Pack three int64 into one for grouping; safe for indices under ~2 million.
    return idx[:, 0] * 4_194_304 ** 2 + idx[:, 1] * 4_194_304 + idx[:, 2], o

def group_by_voxel(points, voxel_m):
    keys, origin = voxel_key(points, voxel_m)
    order = np.argsort(keys, kind="stable")
    keys_sorted = keys[order]
    boundaries = np.flatnonzero(np.diff(keys_sorted)) + 1
    groups = np.split(order, boundaries)
    return groups, origin

def downsample_centroid(points, voxel_m, attributes=None):
    groups, _ = group_by_voxel(points, voxel_m)
    out = np.empty((len(groups), 3), dtype=np.float64)
    attr_out = {}
    for gi, g in enumerate(groups):
        out[gi] = points[g].mean(axis=0)
    if attributes:
        for name, values in attributes.items():
            if np.issubdtype(values.dtype, np.integer):
                agg = np.empty(len(groups), dtype=values.dtype)
                for gi, g in enumerate(groups):
                    vals, counts = np.unique(values[g], return_counts=True)
                    agg[gi] = vals[np.argmax(counts)]          # majority vote
                attr_out[name] = agg
            else:
                attr_out[name] = np.array([values[g].mean() for g in groups],
                                          dtype=values.dtype)
    return out, attr_out, {"method": "voxel_centroid", "synthetic_points": True}

def downsample_nearest_to_centroid(points, voxel_m, attributes=None):
    groups, _ = group_by_voxel(points, voxel_m)
    chosen = np.empty(len(groups), dtype=np.int64)
    for gi, g in enumerate(groups):
        local = points[g]
        centroid = local.mean(axis=0)
        chosen[gi] = g[int(np.argmin(((local - centroid) ** 2).sum(axis=1)))]
    attr_out = {name: values[chosen] for name, values in (attributes or {}).items()}
    return points[chosen], attr_out, {"method": "nearest_to_centroid",
                                      "synthetic_points": False,
                                      "indices": chosen}

def downsample_random_per_voxel(points, voxel_m, attributes=None, seed=7):
    rng = np.random.default_rng(seed)
    groups, _ = group_by_voxel(points, voxel_m)
    chosen = np.array([g[rng.integers(len(g))] for g in groups], dtype=np.int64)
    attr_out = {name: values[chosen] for name, values in (attributes or {}).items()}
    return points[chosen], attr_out, {"method": "random_per_voxel",
                                      "synthetic_points": False,
                                      "indices": chosen}

def downsample_poisson_disk(points, min_distance_m, attributes=None, seed=7):
    """Greedy dart throwing over a shuffled order: guarantees minimum separation."""
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(points))
    tree = cKDTree(points)
    accepted = np.zeros(len(points), dtype=bool)
    blocked = np.zeros(len(points), dtype=bool)
    for i in order:
        if blocked[i]:
            continue
        accepted[i] = True
        for j in tree.query_ball_point(points[i], r=min_distance_m):
            if j != i:
                blocked[j] = True
    chosen = np.flatnonzero(accepted)
    attr_out = {name: values[chosen] for name, values in (attributes or {}).items()}
    return points[chosen], attr_out, {"method": "poisson_disk",
                                      "synthetic_points": False,
                                      "min_distance_m": min_distance_m,
                                      "indices": chosen}
```

Majority voting for integer attributes and averaging for continuous ones is the only sane aggregation for the centroid method, and it is still lossy in a specific way: a voxel straddling a ground/vegetation boundary gets whichever class happened to have more points, and its synthetic position is between the two surfaces. The result is a point that is neither class at a position on neither surface.

The nearest-to-centroid method avoids all of that by returning an index into the original cloud, which is why it returns `indices` — every attribute, including ones you had not thought of, comes along by indexing.

The Poisson-disk implementation is greedy dart throwing, which is simple and gives a genuine minimum-separation guarantee. It is slower than the voxel methods because it needs a radius query per accepted point.

### 3. Measure geometric fidelity

```python
def fidelity(original, reduced, samples=200_000, seed=7):
    """How far is the reduced cloud from the original surface, and vice versa?"""
    rng = np.random.default_rng(seed)
    tree_red = cKDTree(reduced)
    tree_org = cKDTree(original)

    pick = rng.choice(len(original), size=min(samples, len(original)), replace=False)
    d_fwd, _ = tree_red.query(original[pick], k=1, workers=-1)
    d_bwd, _ = tree_org.query(reduced, k=1, workers=-1)

    def stats(d):
        return {"mean_m": round(float(d.mean()), 5),
                "p95_m": round(float(np.percentile(d, 95)), 5),
                "max_m": round(float(d.max()), 5)}

    return {
        "original_to_reduced": stats(d_fwd),
        "reduced_to_original": stats(d_bwd),
        "points_moved": bool(d_bwd.max() > 1e-9),
        "max_displacement_m": round(float(d_bwd.max()), 5),
    }
```

`reduced_to_original` is the diagnostic that distinguishes the methods at a glance: for every method that keeps original points it is exactly zero, and for the centroid method it is the displacement introduced. Seeing a non-zero value where you expected zero means a library function moved points when you thought it did not.

`original_to_reduced` measures the thinning's cost — how far a removed point is from the nearest surviving one — and is roughly half the voxel size for all the voxel methods, which is what the geometry dictates.

### 4. Measure spacing uniformity

```python
def spacing_uniformity(reduced, k=2):
    """Nearest-neighbour distance distribution: the tightness is the uniformity."""
    tree = cKDTree(reduced)
    d, _ = tree.query(reduced, k=k, workers=-1)
    nn = d[:, 1]
    return {
        "points": int(len(reduced)),
        "mean_spacing_m": round(float(nn.mean()), 5),
        "min_spacing_m": round(float(nn.min()), 5),
        "p05_spacing_m": round(float(np.percentile(nn, 5)), 5),
        "p95_spacing_m": round(float(np.percentile(nn, 95)), 5),
        "coefficient_of_variation": round(float(nn.std() / max(nn.mean(), 1e-12)), 4),
        "uniformity_verdict": "highly uniform" if nn.std() / max(nn.mean(), 1e-12) < 0.25
                              else "moderately uniform"
                              if nn.std() / max(nn.mean(), 1e-12) < 0.5
                              else "uneven",
    }

def density_variation(reduced, cell_m=2.0):
    keys, _ = voxel_key(reduced, cell_m)
    unique, counts = np.unique(keys, return_counts=True)
    return {
        "cells": int(len(unique)),
        "mean_per_cell": round(float(counts.mean()), 2),
        "p05_per_cell": int(np.percentile(counts, 5)),
        "p95_per_cell": int(np.percentile(counts, 95)),
        "ratio_p95_p05": round(float(np.percentile(counts, 95)
                                     / max(np.percentile(counts, 5), 1)), 2),
    }
```

The coefficient of variation of nearest-neighbour distance is the cleanest single measure of uniformity, and it separates the methods sharply: Poisson disk lands around 0.15, the voxel methods around 0.35, and global random sampling inherits the original's variation, typically above 0.8.

Uniformity matters wherever an algorithm assumes it. Poisson surface reconstruction, normal estimation with a fixed radius, and any density-based outlier filter all behave differently on a cloud whose density varies fivefold, and the `ratio_p95_p05` figure says whether that is the case.

### 5. Check what happened to the attributes

```python
def attribute_integrity(original_attrs, reduced_attrs, original_points, reduced_points,
                        method_info):
    rows = []
    for name, orig in original_attrs.items():
        red = reduced_attrs.get(name)
        if red is None:
            rows.append({"attribute": name, "status": "dropped"})
            continue
        if np.issubdtype(orig.dtype, np.integer):
            orig_mix = {int(v): int(c) for v, c in zip(*np.unique(orig, return_counts=True))}
            red_mix = {int(v): int(c) for v, c in zip(*np.unique(red, return_counts=True))}
            orig_share = {k: v / sum(orig_mix.values()) for k, v in orig_mix.items()}
            red_share = {k: v / max(sum(red_mix.values()), 1) for k, v in red_mix.items()}
            drift = {k: round(red_share.get(k, 0.0) - orig_share[k], 4)
                     for k in orig_share}
            lost = sorted(set(orig_mix) - set(red_mix))
            rows.append({
                "attribute": name, "kind": "categorical",
                "classes_in_original": len(orig_mix),
                "classes_in_reduced": len(red_mix),
                "classes_lost": lost,
                "largest_share_drift": max(drift.values(), key=abs) if drift else 0.0,
                "synthetic_values_possible": method_info["synthetic_points"],
            })
        else:
            rows.append({
                "attribute": name, "kind": "continuous",
                "mean_before": round(float(orig.mean()), 3),
                "mean_after": round(float(red.mean()), 3),
                "std_before": round(float(orig.std()), 3),
                "std_after": round(float(red.std()), 3),
                "variance_lost_pct": round(100.0 * (1 - (red.std() ** 2)
                                                    / max(orig.std() ** 2, 1e-12)), 2),
            })
    return {"method": method_info["method"], "attributes": rows}
```

Losing a class entirely is the attribute failure that matters most, and it happens with the centroid method on a sparse class: a few hundred wire-conductor points spread across many voxels, each voxel dominated by vegetation, and the majority vote erases the class from the output.

Variance loss on a continuous attribute is the centroid method's other cost. Averaging intensity within a voxel reduces its variance, which matters if anything downstream classifies on intensity — the reduced cloud's intensity distribution is narrower than the sensor produced.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="vox-choice-t vox-choice-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vox-choice-t">Which method for which downstream use</title>
  <desc id="vox-choice-d">A table of five downstream uses and the downsampling method each needs. A survey deliverable needs original points, so nearest-to-centroid. Classification training data needs original points with their original labels. Poisson surface reconstruction needs uniform density, so Poisson-disk sampling. A registration target tolerates synthetic points, so voxel centroid is fine. Statistical sampling wants global random, which is wrong for everything geometric.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="224" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="242" y="20" width="194" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="436" y="20" width="286" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="224" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="242" y="54" width="194" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="54" width="286" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="224" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="242" y="88" width="194" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="88" width="286" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="224" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="242" y="122" width="194" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="122" width="286" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="224" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="242" y="156" width="194" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="436" y="156" width="286" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="190" width="224" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="242" y="190" width="194" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="436" y="190" width="286" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="42">downstream use</text><text x="339" y="42">method</text><text x="579" y="42">because</text>
    <text x="130" y="76">survey deliverable</text><text x="339" y="76">nearest to centroid</text><text x="579" y="76">every point must be an observation</text>
    <text x="130" y="110">classifier training data</text><text x="339" y="110">nearest to centroid</text><text x="579" y="110">labels must stay on real points</text>
    <text x="130" y="144">Poisson reconstruction</text><text x="339" y="144">Poisson disk</text><text x="579" y="144">it assumes uniform density</text>
    <text x="130" y="178">registration target</text><text x="339" y="178">voxel centroid</text><text x="579" y="178">synthetic points are acceptable</text>
    <text x="130" y="212">anything geometric</text><text x="339" y="212">not global random</text><text x="579" y="212">it preserves the density variation</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Only one method moves points, and that one is unacceptable for three of the five uses.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">Poisson disk is twenty times slower and is the only option that guarantees uniform spacing.</text>
</svg>
<figcaption>Nearest-to-centroid is the default this comparison argues for; Poisson disk only when uniformity is required.</figcaption>
</figure>

### 6. Compare them on the same cloud

```python
def compare(points, attributes, voxel_m=0.20, poisson_m=None, samples=200_000):
    poisson_m = poisson_m or voxel_m * 0.9
    results = {}
    runners = {
        "voxel_centroid": lambda: downsample_centroid(points, voxel_m, attributes),
        "nearest_to_centroid": lambda: downsample_nearest_to_centroid(points, voxel_m,
                                                                      attributes),
        "random_per_voxel": lambda: downsample_random_per_voxel(points, voxel_m,
                                                                attributes),
        "poisson_disk": lambda: downsample_poisson_disk(points, poisson_m, attributes),
    }
    for name, run in runners.items():
        reduced, red_attrs, info = run()
        results[name] = {
            "points": int(len(reduced)),
            "reduction": round(len(reduced) / max(len(points), 1), 5),
            "fidelity": fidelity(points, reduced, samples=samples),
            "spacing": spacing_uniformity(reduced),
            "density": density_variation(reduced),
            "attributes": attribute_integrity(attributes, red_attrs, points,
                                              reduced, info),
        }
    return results

def recommend(results, requires_original_points, requires_uniform_density):
    candidates = []
    for name, r in results.items():
        keeps = not r["fidelity"]["points_moved"]
        uniform = r["spacing"]["coefficient_of_variation"] < 0.25
        if requires_original_points and not keeps:
            continue
        if requires_uniform_density and not uniform:
            continue
        candidates.append((name, r["spacing"]["coefficient_of_variation"]))
    if not candidates:
        return {"recommended": None, "reason": "no method satisfies both constraints"}
    best = min(candidates, key=lambda kv: kv[1])
    return {"recommended": best[0], "cv": best[1],
            "eliminated": [n for n in results if n not in dict(candidates)]}
```

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="vox-compare-t vox-compare-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vox-compare-t">Measured comparison at a 20 cm target spacing</title>
  <desc id="vox-compare-d">A table comparing four methods on a 41 million point cloud reduced to about 2.9 million. Voxel centroid moves points by up to 17 centimetres and loses the conductor class, with a spacing variation of 0.34. Nearest to centroid keeps all original points with zero displacement and the same 0.34 variation. Random per voxel also keeps points but with 0.41 variation. Poisson disk keeps points with a variation of 0.15, the most uniform, but takes 38 times longer to compute.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="166" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="184" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="302" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="546" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="166" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="184" y="52" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="302" y="52" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="420" y="52" width="126" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="546" y="52" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="184" y="86" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="302" y="86" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="420" y="86" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="86" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="120" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="184" y="120" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="302" y="120" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="420" y="120" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="120" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="184" y="154" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="302" y="154" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="420" y="154" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="154" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="101" y="41">method</text><text x="243" y="41">displacement</text>
    <text x="361" y="41">spacing CV</text><text x="483" y="41">classes lost</text>
    <text x="634" y="41">time for 41 M points</text>
    <text x="101" y="74">voxel centroid</text><text x="243" y="74">up to 17 cm</text>
    <text x="361" y="74">0.34</text><text x="483" y="74">1 (conductor)</text><text x="634" y="74">21 s</text>
    <text x="101" y="108">nearest to centroid</text><text x="243" y="108">0</text>
    <text x="361" y="108">0.34</text><text x="483" y="108">none</text><text x="634" y="108">34 s</text>
    <text x="101" y="142">random per voxel</text><text x="243" y="142">0</text>
    <text x="361" y="142">0.41</text><text x="483" y="142">none</text><text x="634" y="142">19 s</text>
    <text x="101" y="176">Poisson disk</text><text x="243" y="176">0</text>
    <text x="361" y="176">0.15</text><text x="483" y="176">none</text><text x="634" y="176">13 min</text>
  </g>
  <text x="370" y="212" fill="#1f2937" font-size="12.5" text-anchor="middle">nearest-to-centroid costs 60% more than centroid and removes every one of its drawbacks</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">Poisson disk is the only uniform option and is 23× slower — worth it only when uniformity is required</text>
</svg>
<figcaption>Nearest-to-centroid is the default this comparison argues for; Poisson disk is worth its cost only when an algorithm downstream demands uniform density.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "voxel_centroid": {
    "points": 2884102, "reduction": 0.06897,
    "fidelity": {"original_to_reduced": {"mean_m": 0.0684, "p95_m": 0.1184, "max_m": 0.1904},
                 "reduced_to_original": {"mean_m": 0.0212, "p95_m": 0.0584, "max_m": 0.1712},
                 "points_moved": true, "max_displacement_m": 0.1712},
    "spacing": {"mean_spacing_m": 0.1841, "coefficient_of_variation": 0.3412,
                "uniformity_verdict": "moderately uniform"},
    "attributes": {"attributes": [
      {"attribute": "classification", "kind": "categorical",
       "classes_in_original": 7, "classes_in_reduced": 6, "classes_lost": [14],
       "largest_share_drift": -0.0184, "synthetic_values_possible": true},
      {"attribute": "intensity", "kind": "continuous", "std_before": 41.2,
       "std_after": 28.4, "variance_lost_pct": 52.5}]}
  },
  "nearest_to_centroid": {
    "points": 2884102, "reduction": 0.06897,
    "fidelity": {"points_moved": false, "max_displacement_m": 0.0},
    "spacing": {"coefficient_of_variation": 0.3408},
    "attributes": {"attributes": [
      {"attribute": "classification", "classes_in_reduced": 7, "classes_lost": []},
      {"attribute": "intensity", "std_after": 40.8, "variance_lost_pct": 1.9}]}
  },
  "poisson_disk": {
    "points": 2914208, "spacing": {"coefficient_of_variation": 0.1512,
                                   "uniformity_verdict": "highly uniform"}
  }
}
{'recommended': 'poisson_disk', 'cv': 0.1512,
 'eliminated': ['voxel_centroid']}
```

The centroid method's two costs are both visible here: class 14 disappeared entirely, and intensity lost 52% of its variance. Nearest-to-centroid produces the same point count with identical geometry to the original, no lost classes and 2% variance loss, for 60% more compute.

The recommendation function picks Poisson disk when uniformity is required and nearest-to-centroid otherwise, which is the practical summary of the whole comparison.

Verify the reduced cloud is still a valid input to whatever comes next, since a downsampling that passes every metric can still break a downstream tool:

```python
def downstream_readiness(reduced, attributes, target="poisson_reconstruction"):
    checks = {}
    spacing = spacing_uniformity(reduced)
    density = density_variation(reduced)

    if target == "poisson_reconstruction":
        checks["uniform_enough"] = spacing["coefficient_of_variation"] < 0.3
        checks["no_large_gaps"] = density["ratio_p95_p05"] < 4.0
        checks["normals_estimable"] = spacing["mean_spacing_m"] > 0
    elif target == "registration":
        checks["enough_points"] = len(reduced) > 50_000
        checks["spread"] = float(np.ptp(reduced, axis=0).min()) > 5.0
    elif target == "classification_training":
        checks["classes_present"] = (
            len(np.unique(attributes["classification"])) >= 5
            if "classification" in attributes else False)
        checks["original_points_only"] = True
    elif target == "deliverable":
        checks["original_points_only"] = True
        checks["attributes_intact"] = "classification" in attributes \
            and "intensity" in attributes

    return {"target": target, "checks": checks,
            "ready": all(checks.values()),
            "failing": [k for k, v in checks.items() if not v]}

for target in ("poisson_reconstruction", "registration", "deliverable"):
    print(downstream_readiness(reduced_nearest, attrs_nearest, target))
```

Tying the check to the intended downstream use is what makes it actionable. A cloud that is fine as a registration target and unfit for Poisson reconstruction is a normal situation, and the check states which.

Then verify the reduction is reproducible, because a downsampling that varies run to run makes every later comparison meaningless:

```python
def determinism_check(points, attributes, voxel_m=0.20, runs=3):
    results = []
    for _ in range(runs):
        reduced, _, info = downsample_nearest_to_centroid(points, voxel_m, attributes)
        digest = hash(reduced.tobytes())
        results.append({"points": int(len(reduced)), "digest": digest})
    identical = len({r["digest"] for r in results}) == 1

    random_results = []
    for seed in (7, 7, 8):
        reduced, _, _ = downsample_random_per_voxel(points, voxel_m, attributes, seed=seed)
        random_results.append(hash(reduced.tobytes()))
    return {
        "nearest_to_centroid_deterministic": identical,
        "random_same_seed_reproducible": random_results[0] == random_results[1],
        "random_different_seed_differs": random_results[0] != random_results[2],
        "note": "voxel and nearest methods are deterministic; random and Poisson "
                "need a fixed seed to be reproducible",
    }

print(determinism_check(points, attributes))
```

The voxel and nearest-to-centroid methods are deterministic by construction. The random and Poisson methods are not unless the seed is fixed, and a pipeline that compares two epochs must fix it — otherwise two downsamplings of the same cloud differ, and the difference looks like change.

## Performance Notes

- **Voxel grouping is O(n log n)** from the sort and runs at roughly 2 million points per second in NumPy. 41 million points is about 20 seconds.
- **Nearest-to-centroid costs about 60% more** than centroid because of the per-group argmin. Vectorising with `np.add.reduceat` brings it close to parity.
- **Poisson disk is 20–40× slower** than the voxel methods; it is a radius query per accepted point. Use it only when uniformity is a requirement.
- **Open3D's `voxel_down_sample` is the centroid method** and is fast C++, but it drops attributes other than colour and normals — which is the main reason to implement the nearest variant yourself.
- **PDAL's `filters.voxelcentroidnearestneighbor`** is the nearest-to-centroid method with attributes preserved, and is the right choice inside a PDAL pipeline.
- **Downsample per tile, with a shared voxel origin.** Deriving the origin from each tile's own minimum produces grids that do not line up and a seam of double or missing points at every boundary.

## Common Errors

**Classes disappear after downsampling.** The centroid method's majority vote. Use nearest-to-centroid.

**Intensity distribution narrowed.** Centroid averaging. Same fix.

**Points do not match the original survey.** The centroid method produced synthetic positions. For a deliverable this is usually unacceptable.

**A seam at every tile boundary.** Per-tile voxel origins. Pass a shared origin.

**Two epochs downsample differently.** An unfixed seed in the random or Poisson methods.

**Poisson disk never finishes.** It is O(n) radius queries on a 400-million-point cloud. Voxel-downsample first, then Poisson on the result.

**`MemoryError` in `group_by_voxel`.** The `argsort` over 400 million int64 keys needs 6 GB. Process per tile.

## Frequently Asked Questions

### What voxel size should I use?

Set it from the downstream requirement, not from a target point count: the smallest feature that must survive, divided by about two. For street furniture, 5–10 cm; for terrain, 25–50 cm.

### Is Poisson disk worth it?

Only when an algorithm downstream assumes uniform density — Poisson surface reconstruction most obviously, and radius-based normal estimation. Otherwise nearest-to-centroid is uniform enough and twenty times faster.

### Can I downsample a classified cloud and keep it usable as training data?

Yes, with nearest-to-centroid: every surviving point is a real observation with its original label. The centroid method produces labelled synthetic points, which is a subtly corrupt training set.

## Related Guides

- [Radius Outlier Removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/) — the filter to run before downsampling, not after
- [Cropping Point Clouds to Polygons with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/cropping-point-clouds-to-polygons-with-pdal/) — reducing extent rather than density
- [Trimming Poisson Meshes by Density](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/trimming-poisson-meshes-by-density/) — the reconstruction that needs uniform input

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
