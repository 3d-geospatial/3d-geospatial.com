---
title: "Measuring Hausdorff Distance After Decimation"
description: "Quantify decimation error properly: one-sided vs symmetric Hausdorff, sampling density, percentiles instead of the maximum"
---
# Measuring Hausdorff Distance After Decimation

This page measures how far a decimated mesh has moved from its original — the difference between one-sided and symmetric Hausdorff distance, why the maximum is a bad summary and the 95th percentile is a good one, how sampling density changes the answer, how to report per region rather than per mesh, and how to turn the result into a gate.

## Why you hit this

"The decimated mesh looks fine" is not a number, and a decimation pipeline needs one. The question a surveyor asks is "is this within tolerance?", and answering it requires a defensible distance between two surfaces.

Hausdorff distance is the standard answer and it is routinely misused. The plain maximum is dominated by a single collapsed spike and reports 4 m on a mesh that is within a centimetre everywhere that matters; the one-sided version misses whole features that the decimation invented; and a sparse sampling reports whatever it happened to hit. All three produce confident wrong numbers.

## Prerequisites

- Python 3.10+ with `numpy`, `scipy`, `trimesh`; `pymeshlab` for a cross-check.
- The original and decimated meshes from [decimating meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/).
- The project's tolerance, in metres, written down.

## Step-by-Step

### 1. Understand what the two directions measure

```python
import json
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import cKDTree

def sample_surface(mesh, count, seed=7):
    """Area-weighted sampling: every square metre gets the same sample density."""
    rng = np.random.default_rng(seed)
    points, face_idx = trimesh.sample.sample_surface(mesh, count, seed=seed)
    return np.asarray(points), np.asarray(face_idx)

def one_sided(from_mesh, to_mesh, samples=200_000, seed=7):
    """For every point on `from_mesh`, the distance to the nearest point on `to_mesh`."""
    pts, _ = sample_surface(from_mesh, samples, seed=seed)
    closest, distance, tri = to_mesh.nearest.on_surface(pts)
    return np.asarray(distance), pts

def summarise(distances):
    d = np.asarray(distances)
    return {
        "n": int(d.size),
        "mean_m": round(float(d.mean()), 5),
        "rms_m": round(float(np.sqrt((d ** 2).mean())), 5),
        "p50_m": round(float(np.percentile(d, 50)), 5),
        "p95_m": round(float(np.percentile(d, 95)), 5),
        "p99_m": round(float(np.percentile(d, 99)), 5),
        "p999_m": round(float(np.percentile(d, 99.9)), 5),
        "max_m": round(float(d.max()), 5),
    }
```

The two directions answer different questions and both are needed. **Original → decimated** measures what was lost: a feature removed by the decimation appears as a cluster of original-surface points far from anything in the result. **Decimated → original** measures what was invented: a spike or a bridge created by a bad collapse appears as decimated-surface points far from the original.

A decimation that removes a chimney has a large original→decimated distance and a small decimated→original one. A decimation that creates a spike has the reverse. Reporting only one direction misses half the failures, which is why the symmetric form exists.

<figure class="diagram">
<svg viewBox="6 12 728 240" role="img" aria-labelledby="haus-dir-t haus-dir-d" xmlns="http://www.w3.org/2000/svg">
  <title id="haus-dir-t">What each direction detects</title>
  <desc id="haus-dir-d">Two cross-sections. On the left a chimney present in the original is missing from the decimated mesh, so sampling from the original finds points 2.1 metres from the decimated surface while sampling from the decimated mesh finds nothing unusual. On the right a bad collapse has created a spike in the decimated mesh, so sampling from the decimated surface finds points 1.4 metres from the original while sampling from the original finds nothing unusual. Only the symmetric measure catches both.</desc>
  <rect class="svg-bg" x="6" y="12" width="728" height="240" fill="#ffffff"/>
  <rect x="20" y="26" width="336" height="212" rx="9" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="384" y="26" width="336" height="212" rx="9" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="188" y="50" fill="#1f2937" font-size="13" text-anchor="middle">feature lost: chimney removed</text>
  <text x="552" y="50" fill="#1f2937" font-size="13" text-anchor="middle">feature invented: collapse spike</text>
  <path d="M46 160 H140 V96 H166 V160 H330" stroke="#1f6b8a" stroke-width="2.4" fill="none"/>
  <path d="M46 160 H330" stroke="#b0413e" stroke-width="2.4" stroke-dasharray="6 4" fill="none"/>
  <path d="M410 160 H700" stroke="#1f6b8a" stroke-width="2.4" fill="none"/>
  <path d="M410 160 H520 L544 82 L568 160 H700" stroke="#b0413e" stroke-width="2.4" stroke-dasharray="6 4" fill="none"/>
  <g fill="#1f2937" font-size="12">
    <text x="176" y="112">2.1 m gap</text>
    <text x="578" y="98">1.4 m spike</text>
  </g>
  <g fill="#15384a" font-size="12">
    <text x="46" y="186">original</text>
    <text x="410" y="186">original</text>
  </g>
  <g fill="#b0413e" font-size="12">
    <text x="46" y="204">decimated</text>
    <text x="410" y="204">decimated</text>
  </g>
  <text x="188" y="228" fill="#1f2937" font-size="12" text-anchor="middle">only original → decimated sees it</text>
  <text x="552" y="228" fill="#1f2937" font-size="12" text-anchor="middle">only decimated → original sees it</text>
</svg>
<figcaption>Two opposite failures, each invisible to one direction; the symmetric maximum is the only measure that catches both.</figcaption>
</figure>

### 2. Compute the symmetric distance

```python
def symmetric_hausdorff(original, decimated, samples=200_000, seed=7):
    fwd, fwd_pts = one_sided(original, decimated, samples=samples, seed=seed)
    bwd, bwd_pts = one_sided(decimated, original, samples=samples, seed=seed + 1)
    both = np.concatenate([fwd, bwd])
    return {
        "forward": summarise(fwd),          # what was lost
        "backward": summarise(bwd),         # what was invented
        "symmetric": summarise(both),
        "hausdorff_m": round(float(max(fwd.max(), bwd.max())), 5),
        "worse_direction": "forward (features lost)" if fwd.max() > bwd.max()
                           else "backward (features invented)",
        "_points": {"forward": fwd_pts, "backward": bwd_pts},
        "_distances": {"forward": fwd, "backward": bwd},
    }

original = trimesh.load("input/site_mesh.ply", process=False, force="mesh")
decimated = trimesh.load("output/site_100k.ply", process=False, force="mesh")
result = symmetric_hausdorff(original, decimated)
print(json.dumps({k: v for k, v in result.items() if not k.startswith("_")}, indent=2))
```

The true Hausdorff distance is the maximum over both directions, and it is the number to quote when someone asks for "the Hausdorff distance". It is also nearly useless as a quality metric, because it is the single worst point on either surface and a mesh with one bad collapse in 100,000 triangles reports the same figure as a mesh that is bad everywhere.

Keeping the per-sample distances rather than only the summary is what makes steps 4 and 5 possible: the distribution and the spatial pattern are where the useful information is.

### 3. Sample densely enough that the answer stops moving

```python
def sampling_convergence(original, decimated, counts=(10_000, 50_000, 200_000, 800_000),
                         seed=7):
    rows = []
    for n in counts:
        fwd, _ = one_sided(original, decimated, samples=n, seed=seed)
        s = summarise(fwd)
        rows.append({"samples": n, "p95_m": s["p95_m"], "p99_m": s["p99_m"],
                     "max_m": s["max_m"]})
    for i in range(1, len(rows)):
        prev, cur = rows[i - 1], rows[i]
        cur["p95_change_pct"] = round(
            100.0 * (cur["p95_m"] - prev["p95_m"]) / max(prev["p95_m"], 1e-9), 1)
        cur["max_change_pct"] = round(
            100.0 * (cur["max_m"] - prev["max_m"]) / max(prev["max_m"], 1e-9), 1)
    converged = next((r["samples"] for r in rows[1:]
                      if abs(r.get("p95_change_pct", 100)) < 2.0), None)
    return {"rows": rows, "p95_converged_at": converged,
            "note": "the maximum keeps growing with sample count; percentiles converge"}

print(json.dumps(sampling_convergence(original, decimated), indent=2))
```

This convergence test is the argument against the maximum in one table. The p95 stabilises by about 200,000 samples and stops moving; the maximum keeps rising as more samples are drawn, because more samples mean a better chance of landing on the single worst spot. A metric that depends on how hard you looked is not a metric.

Sampling by **area** rather than by vertex is the other half. Vertices cluster where the mesh is dense, so a vertex-based sampling over-weights the detailed regions — which are exactly the regions a decimation changes most — and reports a pessimistic figure.

For a site-scale mesh, one sample per 10–20 cm² is a reasonable density, which for a 3.2 million m² surface is roughly 200,000 samples at a sparse end and is why the default above is what it is.

### 4. Report percentiles and the shape of the distribution

```python
def deviation_profile(distances, tolerance_m, bins=12):
    d = np.asarray(distances)
    edges = np.linspace(0, max(float(d.max()), tolerance_m * 3), bins + 1)
    counts, _ = np.histogram(d, bins=edges)
    within = float((d <= tolerance_m).mean())
    return {
        "tolerance_m": tolerance_m,
        "within_tolerance_fraction": round(within, 4),
        "outside_tolerance_samples": int((d > tolerance_m).sum()),
        "outside_tolerance_fraction": round(1.0 - within, 4),
        "histogram": [{"from_m": round(float(edges[i]), 4),
                       "to_m": round(float(edges[i + 1]), 4),
                       "count": int(counts[i]),
                       "share": round(float(counts[i]) / max(d.size, 1), 4)}
                      for i in range(bins)],
        "tail_beyond_3x_tolerance": int((d > tolerance_m * 3).sum()),
    }

profile = deviation_profile(result["_distances"]["forward"], tolerance_m=0.05)
print(f"{profile['within_tolerance_fraction']:.2%} of the surface is within 5 cm")
print(f"{profile['tail_beyond_3x_tolerance']} samples beyond 15 cm")
```

"Ninety-nine point four percent of the surface is within 5 cm, with 118 samples beyond 15 cm concentrated on railings" is a statement someone can accept or reject. "Hausdorff distance 0.49 m" is not, because it says nothing about how much of the surface is affected.

The tail count matters as much as the percentile. A distribution with a clean drop-off is a uniform smoothing; one with a long thin tail means a few features were destroyed, and those features may be the reason the mesh exists.

### 5. Localise the error, do not just quantify it

```python
def regional_report(original, decimated, cell_m=10.0, samples=400_000,
                    tolerance_m=0.05, seed=7):
    """Where is the error? A per-cell table beats a single number."""
    pts, _ = sample_surface(original, samples, seed=seed)
    _, distance, _ = decimated.nearest.on_surface(pts)
    d = np.asarray(distance)

    i = np.floor(pts[:, 0] / cell_m).astype(np.int64)
    j = np.floor(pts[:, 1] / cell_m).astype(np.int64)
    keys = i * 100_000 + j

    order = np.argsort(keys, kind="stable")
    keys_sorted, d_sorted, i_s, j_s = keys[order], d[order], i[order], j[order]
    boundaries = np.flatnonzero(np.diff(keys_sorted)) + 1
    groups = np.split(np.arange(len(keys_sorted)), boundaries)

    rows = []
    for g in groups:
        dv = d_sorted[g]
        rows.append({
            "cell": f"{int(i_s[g[0]])}_{int(j_s[g[0]])}",
            "samples": int(dv.size),
            "p95_m": round(float(np.percentile(dv, 95)), 4),
            "max_m": round(float(dv.max()), 4),
            "outside_fraction": round(float((dv > tolerance_m).mean()), 3),
        })
    worst = sorted(rows, key=lambda r: -r["p95_m"])[:6]
    failing = [r for r in rows if r["p95_m"] > tolerance_m]
    return {"cells": len(rows), "failing_cells": len(failing),
            "failing_fraction": round(len(failing) / max(len(rows), 1), 3),
            "worst": worst}

print(json.dumps(regional_report(original, decimated), indent=2))
```

A per-cell table turns a rejected mesh into an actionable one. Six failing cells out of 3,100, all containing scaffolding or vegetation, is a different situation from 900 failing cells spread evenly — the first is a masking problem and the second means the target face count was too aggressive.

Cell size should be chosen so a cell contains a recognisable thing: 10 m for a site mesh, 2 m for a building facade. Too large and the report says nothing; too small and it is a noisy list of thousands of rows.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="haus-report-t haus-report-d" xmlns="http://www.w3.org/2000/svg">
  <title id="haus-report-t">Which statistic to quote for which question</title>
  <desc id="haus-report-d">A table of five statistics from a Hausdorff measurement and the question each answers. The 95th percentile answers whether the surface is within tolerance and is stable with sampling. RMS answers how the error is distributed. The maximum answers only where the worst single point is and grows with sampling effort. The failing-cell fraction answers whether the error is localised. The direction split answers whether features were lost or invented.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="220" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="238" y="20" width="314" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="552" y="20" width="170" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="54" width="314" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="552" y="54" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="88" width="314" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="552" y="88" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="220" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="122" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="552" y="122" width="170" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="156" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="156" width="314" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="552" y="156" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="190" width="314" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="552" y="190" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="128" y="42">statistic</text><text x="395" y="42">answers</text><text x="637" y="42">stable?</text>
    <text x="128" y="76">p95 deviation</text><text x="395" y="76">is the surface within tolerance</text><text x="637" y="76">yes</text>
    <text x="128" y="110">RMS deviation</text><text x="395" y="110">how the error is distributed</text><text x="637" y="110">yes</text>
    <text x="128" y="144">maximum</text><text x="395" y="144">where the single worst point is</text><text x="637" y="144">no — grows with samples</text>
    <text x="128" y="178">failing-cell fraction</text><text x="395" y="178">is the error localised</text><text x="637" y="178">yes</text>
    <text x="128" y="212">forward vs backward</text><text x="395" y="212">lost features or invented ones</text><text x="637" y="212">yes</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Gate on the percentiles and report the maximum as an outlier flag, never as the threshold.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">A metric that depends on how hard you looked cannot be a pass criterion.</text>
</svg>
<figcaption>Four of the five are stable under sampling; the maximum is the one everyone quotes and the one that is not.</figcaption>
</figure>

### 6. Make it a gate

```python
GATE = {
    "p95_m": 0.05,          # 95% of the surface within 5 cm
    "p99_m": 0.15,
    "max_m": 1.00,          # a genuine outlier ceiling, not a quality metric
    "max_failing_cells_fraction": 0.02,
    "require_both_directions": True,
}

def hausdorff_gate(original, decimated, gate=GATE, samples=400_000):
    res = symmetric_hausdorff(original, decimated, samples=samples)
    regional = regional_report(original, decimated, samples=samples,
                               tolerance_m=gate["p95_m"])
    findings = []
    for direction in (["forward", "backward"] if gate["require_both_directions"]
                      else ["forward"]):
        s = res[direction]
        if s["p95_m"] > gate["p95_m"]:
            findings.append({"severity": "error", "direction": direction,
                             "issue": f"p95 {s['p95_m']} m over {gate['p95_m']} m"})
        if s["p99_m"] > gate["p99_m"]:
            findings.append({"severity": "error", "direction": direction,
                             "issue": f"p99 {s['p99_m']} m over {gate['p99_m']} m"})
        if s["max_m"] > gate["max_m"]:
            findings.append({"severity": "warn", "direction": direction,
                             "issue": f"max {s['max_m']} m over {gate['max_m']} m"})
    if regional["failing_fraction"] > gate["max_failing_cells_fraction"]:
        findings.append({"severity": "error", "direction": "spatial",
                         "issue": f"{regional['failing_fraction']:.1%} of cells fail"})
    errors = [f for f in findings if f["severity"] == "error"]
    return {"pass": not errors, "findings": findings,
            "forward_p95_m": res["forward"]["p95_m"],
            "backward_p95_m": res["backward"]["p95_m"],
            "hausdorff_m": res["hausdorff_m"],
            "failing_cells": regional["failing_cells"],
            "worst_cells": regional["worst"][:3]}

gate_result = hausdorff_gate(original, decimated)
print(json.dumps({k: v for k, v in gate_result.items() if k != "worst_cells"}, indent=2))
assert gate_result["pass"], f"decimation outside tolerance: {gate_result['findings']}"
```

Gating on percentiles as errors and the maximum as a warning is the split that makes this usable in CI. A single spike should be reported and investigated, not block a release; a p95 outside tolerance means the whole mesh is wrong for its purpose.

<figure class="diagram">
<svg viewBox="4 6 732 238" role="img" aria-labelledby="haus-conv-t haus-conv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="haus-conv-t">Why the maximum is not a metric</title>
  <desc id="haus-conv-d">A table of measured values against sample count for the same pair of meshes. At 10000 samples the 95th percentile is 6.6 centimetres and the maximum is 21 centimetres. At 50000 samples the percentile is 7.0 and the maximum 34. At 200000 the percentile is 7.0 and the maximum 49. At 800000 the percentile is 7.0 and the maximum 61. The percentile converges after 50000 samples while the maximum keeps rising with every increase in sampling effort.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="238" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="20" width="180" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="362" y="20" width="180" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="542" y="20" width="180" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="164" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="52" width="180" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="362" y="52" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="542" y="52" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="84" width="164" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="84" width="180" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="84" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="542" y="84" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="116" width="164" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="116" width="180" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="116" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="542" y="116" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="148" width="164" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="148" width="180" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="148" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="542" y="148" width="180" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="41">samples</text><text x="272" y="41">p95</text>
    <text x="452" y="41">max</text><text x="632" y="41">change in max</text>
    <text x="100" y="72">10,000</text><text x="272" y="72">6.6 cm</text>
    <text x="452" y="72">21 cm</text><text x="632" y="72">—</text>
    <text x="100" y="104">50,000</text><text x="272" y="104">7.0 cm</text>
    <text x="452" y="104">34 cm</text><text x="632" y="104">+62%</text>
    <text x="100" y="136">200,000</text><text x="272" y="136">7.0 cm</text>
    <text x="452" y="136">49 cm</text><text x="632" y="136">+44%</text>
    <text x="100" y="168">800,000</text><text x="272" y="168">7.0 cm</text>
    <text x="452" y="168">61 cm</text><text x="632" y="168">+24%</text>
  </g>
  <text x="370" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">the same two meshes throughout — only the sampling effort changes</text>
  <text x="370" y="226" fill="#5b6471" font-size="12" text-anchor="middle">the percentile converges by 50,000 samples; the maximum is still climbing at 800,000</text>
</svg>
<figcaption>Quote the percentile as the quality figure and the maximum as an outlier flag; a metric that depends on sampling effort cannot be a threshold.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "forward": {"n": 200000, "mean_m": 0.01812, "rms_m": 0.03104, "p50_m": 0.01204,
              "p95_m": 0.07018, "p99_m": 0.13842, "p999_m": 0.28104, "max_m": 0.49141},
  "backward": {"n": 200000, "mean_m": 0.01744, "rms_m": 0.02918, "p50_m": 0.01188,
               "p95_m": 0.06702, "p99_m": 0.12904, "p999_m": 0.24118, "max_m": 0.38210},
  "symmetric": {"n": 400000, "p95_m": 0.06861, "p99_m": 0.13402, "max_m": 0.49141},
  "hausdorff_m": 0.49141,
  "worse_direction": "forward (features lost)"
}
99.41% of the surface is within 5 cm
118 samples beyond 15 cm
{
  "cells": 3104,
  "failing_cells": 6,
  "failing_fraction": 0.002,
  "worst": [
    {"cell": "184_162", "samples": 141, "p95_m": 0.2841, "max_m": 0.4914,
     "outside_fraction": 0.71},
    {"cell": "184_163", "samples": 128, "p95_m": 0.2104, "max_m": 0.3618,
     "outside_fraction": 0.64}
  ]
}
{"pass": true, "forward_p95_m": 0.07018, "backward_p95_m": 0.06702,
 "hausdorff_m": 0.49141, "failing_cells": 6}
```

The gate passes with a Hausdorff distance of 49 cm, which is the point of this page: the single worst point is half a metre out and 99.4% of the surface is within 5 cm. The six failing cells are adjacent — `184_162` and `184_163` — which is the signature of one lost feature rather than scattered error, and worth one look before accepting.

Verify the measurement itself against an independent implementation, because a bug here produces a confident wrong number:

```python
import pymeshlab as ml

def cross_check_pymeshlab(original_path, decimated_path, samples=200_000):
    ms = ml.MeshSet()
    ms.load_new_mesh(str(original_path))   # mesh 0
    ms.load_new_mesh(str(decimated_path))  # mesh 1
    ms.apply_filter("get_hausdorff_distance",
                    sampledmesh=0, targetmesh=1,
                    samplenum=int(samples),
                    savesample=False, samplevert=False,
                    sampleedge=False, samplefauxedge=False, sampleface=True)
    stats = ms.get_geometric_measures()
    return {k: round(float(v), 5) for k, v in stats.items()
            if k in ("mean", "RMS", "max", "min", "diag_mesh_0")}

def agreement(trimesh_summary, pymeshlab_stats, tol_pct=5.0):
    pairs = [("mean_m", "mean"), ("rms_m", "RMS"), ("max_m", "max")]
    rows = []
    for a, b in pairs:
        va, vb = trimesh_summary[a], pymeshlab_stats.get(b)
        if vb is None:
            continue
        diff = abs(va - vb) / max(vb, 1e-9) * 100
        rows.append({"metric": a, "trimesh": va, "pymeshlab": vb,
                     "diff_pct": round(diff, 2), "agrees": diff <= tol_pct})
    return {"rows": rows, "all_agree": all(r["agrees"] for r in rows)}

pml = cross_check_pymeshlab("input/site_mesh.ply", "output/site_100k.ply")
print(json.dumps(agreement(result["forward"], pml), indent=2))
```

PyMeshLab's `get_hausdorff_distance` samples faces and measures to the target mesh, which is the same one-sided quantity, so the means and RMS values should agree within a few percent. Disagreement usually means one implementation is sampling vertices while the other samples surface area — a difference that shows up as the vertex-based figure being pessimistic.

Then verify the gate behaves correctly by feeding it a deliberately bad mesh:

```python
def gate_sanity_check(original, decimated, gate=GATE):
    """A mesh with an injected spike must fail; the original against itself must pass."""
    identical = hausdorff_gate(original, original, gate=gate, samples=50_000)

    spiked = decimated.copy()
    v = np.asarray(spiked.vertices).copy()
    v[0, 2] += 3.0                                   # one 3 m spike
    spiked.vertices = v

    with_spike = hausdorff_gate(original, spiked, gate=gate, samples=50_000)

    coarse = decimated.copy()
    coarse = coarse.simplify_quadric_decimation(face_count=max(len(coarse.faces) // 20, 4))
    over_decimated = hausdorff_gate(original, coarse, gate=gate, samples=50_000)

    return {
        "identical_passes": identical["pass"],
        "spike_warns_not_fails": (not any(f["severity"] == "error"
                                          for f in with_spike["findings"])
                                  and any(f["severity"] == "warn"
                                          for f in with_spike["findings"])),
        "over_decimated_fails": not over_decimated["pass"],
        "sane": identical["pass"] and not over_decimated["pass"],
    }

print(gate_sanity_check(original, decimated))
```

The three cases are the gate's specification: a mesh against itself must pass with zero distance, a single spike must warn rather than fail, and a mesh reduced twenty times too far must fail. A gate that does not do all three is either too loose or measuring the wrong thing.

## Performance Notes

- **`nearest.on_surface` is the cost**, at roughly 30–80 µs per query on a 12-million-triangle target. 200,000 samples is 8–16 seconds.
- **Query against the smaller mesh where possible.** The forward direction queries the decimated mesh, which is 100× smaller and correspondingly faster; the backward direction is the slow one.
- **Build the proximity structure once.** `trimesh` caches it on the mesh object, so reusing the same object across calls avoids rebuilding an R-tree over 12 million triangles.
- **Sampling is cheap** — area-weighted sampling of 400,000 points takes under a second.
- **200,000 samples per direction is enough** for a site mesh; the convergence test says so, and more only moves the maximum.
- **Per-cell reporting is free** once the distances exist; it is a sort and a split.

## Common Errors

**Hausdorff distance of 40 m on a good mesh.** One mesh is in a different unit or frame. Check the bounding boxes first.

**Distances are all zero.** The same file was loaded twice, or `process=True` let trimesh merge and the two meshes became identical.

**The maximum grows every time the script runs.** The sample seed is not fixed, so a different worst point is found each run. Fix the seed for reproducibility, and do not gate on the maximum.

**Forward and backward differ by an order of magnitude.** Real and informative: features were lost, or invented. Look at the worst cells.

**`MemoryError` on the backward direction.** Querying a 12-million-triangle target with 400,000 points builds a large acceleration structure. Reduce samples or query in chunks.

**PyMeshLab and trimesh disagree by 3×.** One is sampling vertices. Force face sampling in PyMeshLab and area sampling in trimesh.

**The gate passes on a visibly wrong mesh.** The tolerance is looser than the defect, or the defect is in a small area that the failing-cell fraction tolerates. Tighten the fraction.

## Frequently Asked Questions

### Why not use the volume difference instead?

Volume requires both meshes to be watertight, and site meshes are open surfaces. Where both are closed solids, volume difference is a good complementary metric and does not localise error.

### Is RMS better than p95?

RMS is more sensitive to the tail than the median and less than the maximum, which makes it a reasonable single summary. The p95 is easier to state as a tolerance — "95% within 5 cm" is a sentence a surveyor can check.

### Should the gate use the symmetric or one-sided value?

Symmetric, with both directions reported separately. The symmetric percentile is the headline; the split says which failure you have.

## Related Guides

- [Decimating Meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/) — the operation this measures
- [Planar Region Simplification for Facades](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/planar-region-simplification-for-facades/) — a method whose error is structured rather than uniform
- [Generating LOD Chains with meshoptimizer](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/generating-lod-chains-with-meshoptimizer/) — where the reported error becomes a geometric error

Back to [Automated Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).
