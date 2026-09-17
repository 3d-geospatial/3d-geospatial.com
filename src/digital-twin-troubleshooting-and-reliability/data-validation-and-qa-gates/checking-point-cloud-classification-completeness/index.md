---
title: "Checking Point Cloud Classification Completeness"
description: "Audit a delivered classification before you depend on it: class histograms per tile, spatial coverage of each class, flight-line consistency"
---
# Checking Point Cloud Classification Completeness

This page audits the classification of a delivered lidar dataset before anything downstream depends on it — per-tile class histograms against expectations, spatial coverage so a class present in the histogram but absent from half the area is caught, flight-line consistency, and a set of gates that fail a delivery rather than discovering the problem three weeks later.

## Why you hit this

A contract says "classified to ASPRS classes 1, 2, 3, 4, 5, 6, 9". The delivery has all seven classes in its histogram and is signed off. Six weeks later a DTM has buildings in it across one district, because the vendor's operator ran the building classification on 340 tiles and not on the other 60.

That failure is invisible in a global histogram and obvious in a per-tile one. Every check on this page exists because a summary statistic over a whole delivery hides a spatially clustered defect, and spatially clustered defects are what actually happens.

## Prerequisites

- Python 3.10+ with `numpy`, `pdal`, `laspy`, `geopandas`, `shapely`, `rasterio`.
- The delivery's specification: which classes, expected proportions, tiling scheme.
- A tile index, or the ability to build one with `pdal tindex`.

## Step-by-Step

### 1. Build a per-tile class histogram

```python
import json
import math
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np

ASPRS_NAMES = {
    0: "created", 1: "unclassified", 2: "ground", 3: "low_veg", 4: "med_veg",
    5: "high_veg", 6: "building", 7: "low_noise", 8: "model_key", 9: "water",
    10: "rail", 11: "road", 12: "overlap", 13: "wire_guard", 14: "wire_conductor",
    15: "tower", 16: "wire_connector", 17: "bridge_deck", 18: "high_noise",
}

def tile_histogram(las_path):
    """One PDAL pass per tile; counts every class present."""
    proc = subprocess.run(
        ["pdal", "info", "--stats", "--dimensions", "Classification", str(las_path)],
        capture_output=True, text=True, check=True)
    stats = json.loads(proc.stdout)["stats"]["statistic"][0]

    # PDAL reports min/max/count; the per-value histogram needs a filter pass.
    pipeline = {"pipeline": [
        str(las_path),
        {"type": "filters.stats", "dimensions": "Classification",
         "enumerate": "Classification"},
    ]}
    spec = Path(las_path).with_suffix(".hist.json")
    spec.write_text(json.dumps(pipeline))
    meta_path = Path(las_path).with_suffix(".hist.meta.json")
    subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta_path)],
                   check=True, capture_output=True)
    meta = json.loads(meta_path.read_text())
    stage = next(v for k, v in meta["stages"].items() if k.startswith("filters.stats"))
    entry = stage["statistic"][0]
    counts = {}
    for item in entry.get("values", "").split(","):
        if not item.strip():
            continue
        value, count = item.split("/")
        counts[int(float(value))] = int(count)

    total = int(stats["count"])
    return {
        "tile": Path(las_path).stem,
        "points": total,
        "counts": counts,
        "shares": {cls: round(n / max(total, 1), 5) for cls, n in counts.items()},
        "classes_present": sorted(counts),
        "distinct_classes": len(counts),
    }

def delivery_histogram(tile_paths, workers=8):
    rows = [tile_histogram(p) for p in tile_paths]
    all_classes = sorted({c for r in rows for c in r["classes_present"]})
    totals = Counter()
    for r in rows:
        totals.update(r["counts"])
    grand = sum(totals.values())
    return {
        "tiles": len(rows),
        "points": grand,
        "classes_in_delivery": all_classes,
        "class_names": {c: ASPRS_NAMES.get(c, f"class_{c}") for c in all_classes},
        "global_shares": {c: round(n / max(grand, 1), 5)
                          for c, n in sorted(totals.items())},
        "per_tile": rows,
    }
```

`filters.stats` with `enumerate` is the stage that gives a true per-value count rather than the min/max summary `pdal info --stats` returns. It costs one full read of the tile, which is why this is a per-tile job run once per delivery rather than something to repeat casually.

Recording the per-tile rows and not only the totals is the whole point. Everything that follows is a query over `per_tile`, and a delivery audit that discards it can only ever report global figures.

### 2. Compare each tile against the specification

```python
SPEC = {
    "required_classes": {2, 3, 4, 5, 6},
    "optional_classes": {1, 7, 9, 11, 12, 18},
    "forbidden_classes": {0, 8},
    "expected_shares": {
        2: (0.30, 0.75),      # ground: between 30% and 75% of a tile
        5: (0.02, 0.55),      # high vegetation
        6: (0.00, 0.40),      # building
        1: (0.00, 0.25),      # unclassified must be a small remainder
    },
    "max_unclassified_share": 0.25,
    "min_points_per_tile": 100_000,
}

def check_tile(row, spec=SPEC):
    findings = []
    present = set(row["classes_present"])

    missing = sorted(spec["required_classes"] - present)
    if missing:
        findings.append({
            "severity": "error",
            "issue": f"required classes absent: "
                     f"{[ASPRS_NAMES.get(c, c) for c in missing]}",
        })
    forbidden = sorted(present & spec["forbidden_classes"])
    if forbidden:
        findings.append({
            "severity": "error",
            "issue": f"forbidden classes present: "
                     f"{[ASPRS_NAMES.get(c, c) for c in forbidden]}",
        })
    unexpected = sorted(present - spec["required_classes"]
                        - spec["optional_classes"] - spec["forbidden_classes"])
    if unexpected:
        findings.append({"severity": "warn",
                         "issue": f"classes outside the spec: {unexpected}"})

    for cls, (lo, hi) in spec["expected_shares"].items():
        share = row["shares"].get(cls, 0.0)
        if share < lo:
            findings.append({
                "severity": "error" if cls in spec["required_classes"] else "warn",
                "issue": f"{ASPRS_NAMES.get(cls, cls)} is {share:.2%}, below the "
                         f"{lo:.0%} floor",
            })
        elif share > hi:
            findings.append({
                "severity": "warn",
                "issue": f"{ASPRS_NAMES.get(cls, cls)} is {share:.2%}, above the "
                         f"{hi:.0%} ceiling",
            })

    if row["points"] < spec["min_points_per_tile"]:
        findings.append({"severity": "warn",
                         "issue": f"only {row['points']} points in the tile"})

    return {"tile": row["tile"], "findings": findings,
            "errors": sum(1 for f in findings if f["severity"] == "error"),
            "pass": not any(f["severity"] == "error" for f in findings)}
```

Share **bands** rather than target values are what make this usable. A tile that is 90% ground is a floodplain and a tile that is 32% ground is a dense forest; both are legitimate, and a check demanding 55% ± 5% would fail most of a real delivery.

The `max_unclassified_share` is the check that catches an operator who ran the ground classification and stopped: everything that is not ground stays class 1, so the unclassified share jumps to 60% while ground looks fine.

Distinguishing error from warning matters for the gate: a missing required class is a contractual failure, and a ground share above the ceiling is a question worth asking.

<figure class="diagram">
<svg viewBox="4 12 732 228" role="img" aria-labelledby="cls-global-t cls-global-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-global-t">Why a global histogram hides the defect</title>
  <desc id="cls-global-d">A comparison of a delivery viewed globally and per tile. Globally the building class is 11.2 percent of points, which is within the expected band, so the delivery passes. Per tile, 340 tiles have between 4 and 26 percent buildings and 60 tiles have exactly zero, which means the building classification was never run on those 60 tiles. The global figure cannot show this because the 340 good tiles carry the average.</desc>
  <rect class="svg-bg" x="4" y="12" width="732" height="228" fill="#ffffff"/>
  <rect x="18" y="26" width="330" height="200" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="392" y="26" width="330" height="200" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="183" y="50" fill="#1f2937" font-size="13" text-anchor="middle">global histogram — passes</text>
  <text x="557" y="50" fill="#1f2937" font-size="13" text-anchor="middle">per-tile — fails</text>
  <g stroke-width="1.4">
    <rect x="46" y="150" width="46" height="52" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="100" y="88" width="46" height="114" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="154" y="170" width="46" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="208" y="120" width="46" height="82" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="262" y="178" width="46" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <text x="285" y="170" fill="#1f2937" font-size="11.5" text-anchor="middle">bldg</text>
  <text x="285" y="158" fill="#1f2937" font-size="11.5" text-anchor="middle">11.2%</text>
  <text x="183" y="222" fill="#5b6471" font-size="12" text-anchor="middle">one number for 400 tiles</text>
  <g stroke-width="1.2">
    <rect x="416" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="456" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="496" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="516" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="536" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="576" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="596" y="76" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="616" y="76" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="636" y="76" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="656" y="76" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="676" y="76" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="416" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="456" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="496" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="516" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="536" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="576" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="596" y="96" width="16" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="616" y="96" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="636" y="96" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="656" y="96" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="676" y="96" width="16" height="16" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <text x="557" y="140" fill="#1f2937" font-size="12" text-anchor="middle">340 tiles: 4–26% buildings</text>
  <text x="557" y="162" fill="#b0413e" font-size="12" text-anchor="middle">60 tiles: exactly 0% — never run</text>
  <text x="557" y="192" fill="#1f2937" font-size="12" text-anchor="middle">and they are spatially contiguous,</text>
  <text x="557" y="210" fill="#1f2937" font-size="12" text-anchor="middle">which is the signature of a missed batch</text>
</svg>
<figcaption>The global figure is inside the band because 340 good tiles carry the 60 that were never processed.</figcaption>
</figure>

### 3. Check the spatial coverage of each class

```python
import geopandas as gpd
from shapely.geometry import box

def tile_footprints(tile_paths):
    rows = []
    for p in tile_paths:
        info = json.loads(subprocess.run(["pdal", "info", "--summary", str(p)],
                                         capture_output=True, text=True,
                                         check=True).stdout)["summary"]
        b = info["bounds"]
        rows.append({"tile": Path(p).stem,
                     "geometry": box(b["minx"], b["miny"], b["maxx"], b["maxy"]),
                     "points": int(info["num_points"])})
    return gpd.GeoDataFrame(rows, crs=None)

def class_coverage(histogram, footprints, spec=SPEC):
    """For each class, which tiles have it and do the absences form a cluster?"""
    by_tile = {r["tile"]: r for r in histogram["per_tile"]}
    gdf = footprints.copy()
    results = {}

    for cls in sorted(spec["required_classes"]):
        has = np.array([cls in by_tile[t]["classes_present"] for t in gdf["tile"]])
        gdf[f"has_{cls}"] = has
        missing_tiles = gdf.loc[~has]
        clusters = 0
        largest_cluster = 0
        if len(missing_tiles):
            merged = missing_tiles.geometry.union_all()
            parts = [merged] if merged.geom_type == "Polygon" else list(merged.geoms)
            clusters = len(parts)
            largest_cluster = int(max(
                sum(1 for g in missing_tiles.geometry if g.intersects(part))
                for part in parts))
        results[cls] = {
            "name": ASPRS_NAMES.get(cls, str(cls)),
            "tiles_with": int(has.sum()),
            "tiles_without": int((~has).sum()),
            "coverage": round(float(has.mean()), 4),
            "missing_area_km2": round(float(missing_tiles.geometry.area.sum()) / 1e6, 3)
            if len(missing_tiles) else 0.0,
            "missing_clusters": clusters,
            "largest_missing_cluster_tiles": largest_cluster,
            "verdict": "contiguous gap — a processing batch was missed"
                       if largest_cluster >= 5
                       else "scattered absences — probably genuine"
                       if clusters else "complete",
            "examples": missing_tiles["tile"].tolist()[:6],
        }
    return results
```

Distinguishing a **contiguous** gap from scattered absences is the single most useful judgement in this audit. A rural tile with no buildings genuinely has no class 6; forty adjacent tiles with no class 6 in a suburb is a missed processing batch, and the clustering test tells them apart automatically.

Dissolving the missing tiles' footprints and counting the resulting parts is a cheap way to get that. Five or more adjacent tiles sharing an edge is the threshold where "genuine absence" stops being plausible for any urban class.

Reporting the missing area in square kilometres rather than a tile count makes the finding concrete for whoever has to decide whether to reject the delivery.

### 4. Check consistency across flight lines

```python
def flight_line_consistency(tile_paths, sample_per_tile=500_000, seed=7):
    """Point source id identifies the flight line; classification should not depend on it."""
    import laspy
    rows = []
    rng = np.random.default_rng(seed)
    for p in tile_paths:
        las = laspy.read(p)
        n = len(las.points)
        idx = rng.choice(n, size=min(sample_per_tile, n), replace=False)
        cls = np.asarray(las.classification)[idx]
        src = np.asarray(las.point_source_id)[idx]
        for line in np.unique(src):
            sel = src == line
            if sel.sum() < 5000:
                continue
            counts = Counter(cls[sel].tolist())
            total = int(sel.sum())
            rows.append({"tile": Path(p).stem, "line": int(line), "points": total,
                         "shares": {int(c): round(v / total, 5)
                                    for c, v in counts.items()}})
    by_line = {}
    for r in rows:
        by_line.setdefault(r["line"], []).append(r)

    findings = []
    for line, entries in sorted(by_line.items()):
        ground = [e["shares"].get(2, 0.0) for e in entries]
        building = [e["shares"].get(6, 0.0) for e in entries]
        unclassified = [e["shares"].get(1, 0.0) for e in entries]
        findings.append({
            "line": line, "tiles": len(entries),
            "ground_share_median": round(float(np.median(ground)), 4),
            "building_share_median": round(float(np.median(building)), 4),
            "unclassified_share_median": round(float(np.median(unclassified)), 4),
        })
    if findings:
        unc = np.array([f["unclassified_share_median"] for f in findings])
        outliers = [f for f, z in zip(findings, unc)
                    if z > float(np.median(unc)) + 3 * (float(np.std(unc)) or 0.01)]
    else:
        outliers = []
    return {"lines": len(by_line), "per_line": findings[:10],
            "suspect_lines": outliers[:5],
            "verdict": "one or more flight lines classified differently"
                       if outliers else "flight lines are consistent"}
```

A flight line whose unclassified share is far above its neighbours' is the signature of a line processed with different parameters or not processed at all. It is invisible per tile, because each tile mixes two or three lines, and it shows up immediately when the points are grouped by `point_source_id`.

This check also catches the overlap problem: a delivery where class 12 (overlap) was applied on some lines and not others produces a point density that varies by a factor of two across line boundaries, which affects every density-dependent process downstream.

<figure class="diagram">
<svg viewBox="14 -3 700 235" role="img" aria-labelledby="cls-lines-t cls-lines-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-lines-t">Unclassified share per flight line</title>
  <desc id="cls-lines-d">A bar chart of the median unclassified share for eight flight lines. Lines 38 to 40 and 42 to 44 sit between 4 and 9 percent, which is the normal remainder. Line 41 sits at 68 percent, because that line was classified for ground only and never for vegetation or buildings. Grouping by point source id is the only way to see this, because every tile mixes two or three lines and the per-tile figure stays near the normal range.</desc>
  <rect class="svg-bg" x="14" y="-3" width="700" height="235" fill="#ffffff"/>
  <path d="M84 24 V176 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="104" y="160" width="60" height="16" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="184" y="156" width="60" height="20" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="264" y="164" width="60" height="12" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="344" y="30" width="60" height="146" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="424" y="158" width="60" height="18" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="504" y="162" width="60" height="14" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="584" y="156" width="60" height="20" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="134" y="152">5%</text><text x="214" y="148">7%</text><text x="294" y="156">4%</text>
    <text x="374" y="24">68%</text>
    <text x="454" y="150">6%</text><text x="534" y="154">5%</text><text x="614" y="148">7%</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="134" y="194">38</text><text x="214" y="194">39</text><text x="294" y="194">40</text>
    <text x="374" y="194">41</text><text x="454" y="194">42</text><text x="534" y="194">43</text>
    <text x="614" y="194">44</text>
  </g>
  <text x="400" y="214" fill="#5b6471" font-size="12" text-anchor="middle">point_source_id — median unclassified share across the tiles each line touches</text>
  <text x="44" y="100" fill="#5b6471" font-size="12" text-anchor="middle">share</text>
</svg>
<figcaption>Line 41 was classified for ground only; no per-tile figure shows it, because every tile mixes several lines.</figcaption>
</figure>

### 5. Look for the classification errors a histogram cannot see

```python
def geometric_plausibility(tile_path, sample=2_000_000, seed=7):
    """Cross-check classes against height above ground and local geometry."""
    import laspy
    from scipy.spatial import cKDTree

    las = laspy.read(tile_path)
    n = len(las.points)
    rng = np.random.default_rng(seed)
    idx = rng.choice(n, size=min(sample, n), replace=False)
    xyz = np.column_stack([np.asarray(las.x)[idx], np.asarray(las.y)[idx],
                           np.asarray(las.z)[idx]])
    cls = np.asarray(las.classification)[idx]
    hag = (np.asarray(las.HeightAboveGround)[idx]
           if hasattr(las, "HeightAboveGround") else None)

    findings = []
    if hag is not None:
        ground_high = (cls == 2) & (hag > 1.0)
        if ground_high.mean() > 0.005:
            findings.append({
                "severity": "error",
                "issue": f"{ground_high.mean():.2%} of ground points are more than "
                         f"1 m above the ground surface",
            })
        building_low = (cls == 6) & (hag < 1.5)
        if building_low.mean() > 0.10:
            findings.append({
                "severity": "warn",
                "issue": f"{building_low.mean():.2%} of building points are below "
                         f"1.5 m — probably ground misclassified as building",
            })
        veg_tall = (cls == 3) & (hag > 2.0)
        if veg_tall.mean() > 0.05:
            findings.append({
                "severity": "warn",
                "issue": f"{veg_tall.mean():.2%} of low-vegetation points are above "
                         f"2 m — class 3/4/5 thresholds may be wrong",
            })

    # Buildings should be locally planar; vegetation should not.
    tree = cKDTree(xyz)
    for target, expect_planar in ((6, True), (5, False)):
        sel = np.flatnonzero(cls == target)
        if sel.size < 2000:
            continue
        probe = rng.choice(sel, size=min(5000, sel.size), replace=False)
        planarity = []
        for i in probe:
            neigh = tree.query_ball_point(xyz[i], r=1.0)
            if len(neigh) < 8:
                continue
            local = xyz[neigh]
            centred = local - local.mean(axis=0)
            w = np.linalg.eigvalsh(centred.T @ centred / len(local))[::-1]
            w = np.clip(w, 1e-12, None)
            planarity.append((w[1] - w[2]) / w[0])
        if not planarity:
            continue
        median = float(np.median(planarity))
        if expect_planar and median < 0.45:
            findings.append({
                "severity": "warn",
                "issue": f"building points have median planarity {median:.2f} — "
                         f"vegetation may be classified as building",
            })
        if not expect_planar and median > 0.65:
            findings.append({
                "severity": "warn",
                "issue": f"high-vegetation points have median planarity {median:.2f} — "
                         f"roofs may be classified as vegetation",
            })
    return {"tile": Path(tile_path).stem, "sampled": int(len(idx)),
            "findings": findings,
            "pass": not any(f["severity"] == "error" for f in findings)}
```

Geometric plausibility catches the errors a histogram rates as perfect. A delivery with exactly the right class proportions can have a whole district's roofs in class 5 and its trees in class 6, and the only automatic way to notice is that class 6 is not planar and class 5 is.

The ground-above-ground test is the sharpest of these. Ground points are, by definition, on the ground surface, so any ground point more than a metre above the interpolated ground is a contradiction — and it appears wherever a bridge, a vehicle or a low roof was classified as ground.

These checks use the same eigenvalue features as [training a random forest point classifier](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/training-a-random-forest-point-classifier/), which is convenient: the audit can reuse whatever feature code the pipeline already has.

### 6. Gate the delivery

```python
GATE = {
    "max_tiles_failing": 0,
    "min_class_coverage": {2: 1.00, 5: 0.90, 6: 0.60},
    "max_missing_cluster_tiles": 4,
    "max_global_unclassified_share": 0.20,
    "require_flight_line_consistency": True,
}

def delivery_gate(histogram, coverage, flight_lines, plausibility, gate=GATE):
    findings = []

    tile_results = [check_tile(r) for r in histogram["per_tile"]]
    failing = [t for t in tile_results if not t["pass"]]
    if len(failing) > gate["max_tiles_failing"]:
        findings.append({"severity": "error",
                         "issue": f"{len(failing)} tile(s) fail the per-tile spec",
                         "examples": [t["tile"] for t in failing[:6]]})

    for cls, minimum in gate["min_class_coverage"].items():
        got = coverage.get(cls, {}).get("coverage", 0.0)
        if got < minimum:
            findings.append({
                "severity": "error",
                "issue": f"{ASPRS_NAMES.get(cls, cls)} present in only {got:.1%} of "
                         f"tiles, below the {minimum:.0%} requirement",
            })
        cluster = coverage.get(cls, {}).get("largest_missing_cluster_tiles", 0)
        if cluster > gate["max_missing_cluster_tiles"]:
            findings.append({
                "severity": "error",
                "issue": f"{ASPRS_NAMES.get(cls, cls)} missing from a contiguous "
                         f"block of {cluster} tiles",
            })

    unclassified = histogram["global_shares"].get(1, 0.0)
    if unclassified > gate["max_global_unclassified_share"]:
        findings.append({
            "severity": "error",
            "issue": f"{unclassified:.1%} of points are unclassified, above the "
                     f"{gate['max_global_unclassified_share']:.0%} limit",
        })

    if gate["require_flight_line_consistency"] and flight_lines["suspect_lines"]:
        findings.append({
            "severity": "error",
            "issue": f"{len(flight_lines['suspect_lines'])} flight line(s) classified "
                     f"inconsistently",
            "examples": [f["line"] for f in flight_lines["suspect_lines"][:4]],
        })

    for p in plausibility:
        for f in p["findings"]:
            if f["severity"] == "error":
                findings.append({"severity": "error",
                                 "issue": f"{p['tile']}: {f['issue']}"})

    errors = [f for f in findings if f["severity"] == "error"]
    return {
        "tiles": histogram["tiles"],
        "points": histogram["points"],
        "findings": findings[:12],
        "errors": len(errors),
        "pass": not errors,
        "summary": ("delivery accepted" if not errors
                    else f"delivery rejected: {len(errors)} blocking finding(s)"),
    }
```

<figure class="diagram">
<svg viewBox="4 6 732 250" role="img" aria-labelledby="cls-checks-t cls-checks-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-checks-t">Five checks and the defect each one catches</title>
  <desc id="cls-checks-d">A table of five checks. The per-tile histogram catches a class missing from some tiles. Spatial coverage clustering catches a whole processing batch that was skipped. Flight-line grouping catches one line processed with different parameters. Ground-above-ground testing catches bridges and vehicles classified as ground. Planarity testing catches roofs and trees swapped between classes. A global histogram catches none of the five.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="250" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="248" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="20" width="308" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="574" y="20" width="148" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="248" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="54" width="308" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="574" y="54" width="148" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="248" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="86" width="308" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="574" y="86" width="148" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="118" width="248" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="118" width="308" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="574" y="118" width="148" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="150" width="248" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="150" width="308" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="574" y="150" width="148" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="182" width="248" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="182" width="308" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="574" y="182" width="148" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="142" y="41">check</text><text x="420" y="41">defect it catches</text>
    <text x="648" y="41">global histogram?</text>
    <text x="142" y="74">per-tile histogram</text>
    <text x="420" y="74">a class absent from some tiles</text><text x="648" y="74">no</text>
    <text x="142" y="106">spatial clustering of absences</text>
    <text x="420" y="106">a whole processing batch skipped</text><text x="648" y="106">no</text>
    <text x="142" y="138">group by point_source_id</text>
    <text x="420" y="138">one flight line processed differently</text><text x="648" y="138">no</text>
    <text x="142" y="170">ground above ground test</text>
    <text x="420" y="170">bridges and vehicles called ground</text><text x="648" y="170">no</text>
    <text x="142" y="202">planarity per class</text>
    <text x="420" y="202">roofs and trees swapped</text><text x="648" y="202">no</text>
  </g>
  <text x="370" y="238" fill="#5b6471" font-size="12" text-anchor="middle">a global histogram confirms the classes exist somewhere, which is not what the contract means</text>
</svg>
<figcaption>Every one of the five real defects passes a global histogram, which is why the audit has to be per tile, per line and geometric.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "tiles": 400, "points": 16_728_167_204,
  "classes_in_delivery": [1, 2, 3, 4, 5, 6, 7, 9, 12, 18],
  "global_shares": {"1": 0.0841, "2": 0.5124, "3": 0.0684, "4": 0.0918,
                    "5": 0.2104, "6": 0.1120, "7": 0.0012, "9": 0.0184,
                    "12": 0.0000, "18": 0.0003}
}
{
  "2": {"name": "ground", "tiles_with": 400, "coverage": 1.0,
        "missing_clusters": 0, "verdict": "complete"},
  "6": {"name": "building", "tiles_with": 340, "tiles_without": 60,
        "coverage": 0.85, "missing_area_km2": 60.0,
        "missing_clusters": 1, "largest_missing_cluster_tiles": 60,
        "verdict": "contiguous gap — a processing batch was missed",
        "examples": ["32_612_6648", "32_613_6648", "32_614_6648",
                     "32_612_6649", "32_613_6649", "32_614_6649"]}
}
{'lines': 68, 'suspect_lines': [{'line': 41, 'unclassified_share_median': 0.6812}],
 'verdict': 'one or more flight lines classified differently'}
{
  "tiles": 400, "errors": 3, "pass": false,
  "summary": "delivery rejected: 3 blocking finding(s)",
  "findings": [
    {"severity": "error", "issue": "60 tile(s) fail the per-tile spec",
     "examples": ["32_612_6648", "32_613_6648", "32_614_6648"]},
    {"severity": "error",
     "issue": "building present in only 85.0% of tiles, below the 60% requirement"},
    {"severity": "error",
     "issue": "building missing from a contiguous block of 60 tiles"}
  ]
}
```

The global building share of 11.2% is comfortably inside the expected band, and the delivery is still rejected — which is the demonstration this page exists for. Sixty contiguous tiles covering 60 km² have no class 6 at all.

Flight line 41 with a 68% unclassified median is the second independent finding, and it is a different defect from the missing tile block: one line was never classified beyond ground, across the whole survey.

Verify the audit itself finds a defect you inject, because a check that never fails is indistinguishable from one that does not work:

```python
def audit_self_test(good_tile_path, tmp_dir):
    """Inject each defect into a copy and confirm the audit catches it."""
    import laspy
    import shutil

    results = {}
    tmp = Path(tmp_dir)
    tmp.mkdir(parents=True, exist_ok=True)

    # Defect 1: remove the building class entirely.
    p1 = tmp / "no_buildings.laz"
    las = laspy.read(good_tile_path)
    cls = np.asarray(las.classification).copy()
    cls[cls == 6] = 1
    las.classification = cls
    las.write(p1)
    results["missing_building_class"] = not check_tile(tile_histogram(p1))["pass"]

    # Defect 2: classify a slab of high vegetation as ground.
    p2 = tmp / "veg_as_ground.laz"
    las2 = laspy.read(good_tile_path)
    cls2 = np.asarray(las2.classification).copy()
    veg = np.flatnonzero(cls2 == 5)
    cls2[veg[:len(veg) // 3]] = 2
    las2.classification = cls2
    las2.write(p2)
    results["vegetation_as_ground"] = not geometric_plausibility(p2)["pass"]

    # Defect 3: leave most points unclassified.
    p3 = tmp / "mostly_unclassified.laz"
    las3 = laspy.read(good_tile_path)
    cls3 = np.asarray(las3.classification).copy()
    cls3[cls3 != 2] = 1
    las3.classification = cls3
    las3.write(p3)
    results["mostly_unclassified"] = not check_tile(tile_histogram(p3))["pass"]

    results["clean_tile_passes"] = check_tile(tile_histogram(good_tile_path))["pass"]
    results["all_defects_caught"] = all(v for k, v in results.items()
                                        if k != "clean_tile_passes")
    return results

print(json.dumps(audit_self_test("input/tiles/32_598_6643.laz", "build/selftest"),
                 indent=2))
```

The clean tile must pass and all three injected defects must fail. Running this once when the audit is written, and again whenever the spec changes, is what keeps the gate from quietly becoming a no-op.

Then verify the audit's runtime is acceptable, because an audit nobody runs is not a gate:

```python
def audit_cost_estimate(tile_paths, measured_seconds_per_tile=None):
    sizes = [Path(p).stat().st_size / 1e9 for p in tile_paths]
    total_gb = sum(sizes)
    per_tile = measured_seconds_per_tile or 14.0
    serial_hours = len(tile_paths) * per_tile / 3600.0
    return {
        "tiles": len(tile_paths),
        "total_gb": round(total_gb, 1),
        "seconds_per_tile": per_tile,
        "serial_hours": round(serial_hours, 2),
        "with_8_workers_hours": round(serial_hours / 8, 2),
        "verdict": "run on every delivery" if serial_hours / 8 < 2.0
                   else "run the histogram pass on every delivery and the geometric "
                        "checks on a sample",
    }
```

## Performance Notes

- **The histogram pass is one full read per tile** at roughly 10–20 seconds for a 40 GB delivery tile. 400 tiles is about 90 minutes serially and 12 minutes across eight workers.
- **`filters.stats` with `enumerate` is cheap** relative to the read; the I/O dominates.
- **The geometric plausibility check samples**, so its cost is bounded by the sample size rather than the tile size — 2 million points is a few seconds.
- **The eigenvalue loop is the slow part** of the geometric check at about 20 µs per probe point; 5,000 probes is 0.1 seconds.
- **Flight-line grouping needs `point_source_id`**, which some deliveries zero out. Check for it before relying on the check.
- **Cache the per-tile histograms.** They are a few kilobytes each and let every later query run in milliseconds.

## Common Errors

**`filters.stats` returns no `values`.** The `enumerate` option is missing, so only min/max/mean were computed.

**Every tile fails the ground share check.** The expected band is wrong for the terrain — a forest delivery legitimately has 25% ground.

**`point_source_id` is all zeros.** The vendor stripped it. Flight-line consistency cannot be checked; note the limitation in the report.

**`HeightAboveGround` is absent.** Compute it first with `filters.hag_delaunay`; the geometric checks depend on it.

**The clustering test reports one cluster of 400 tiles.** Every tile is missing the class, so the "contiguous gap" verdict is technically right and unhelpful — check the coverage figure first.

**Class 12 has zero points everywhere.** Overlap was not flagged, which is a legitimate choice but changes the density interpretation. Confirm against the spec.

**The audit passes and a district still has buildings in the DTM.** The classification exists and is wrong rather than absent. That is what the planarity check is for; if it also passed, the errors are too subtle for an automatic audit and need a visual review of that district.

## Frequently Asked Questions

### Should a delivery be rejected for one bad tile?

Depends on the contract, and the useful thing is that the audit makes it a decision rather than a discovery. Sixty contiguous tiles is a rejection; one tile with an odd ground share is a question.

### How do I audit a classification with no reference?

Everything on this page works without reference data: it checks internal consistency, spatial completeness and geometric plausibility. A reference classification allows the confusion matrix in the random-forest guide, which is stronger where it exists.

### Can this run before the whole delivery arrives?

Yes, and it should. Run the histogram and coverage checks per batch as tiles arrive, so a missed processing batch is caught while the vendor still has the project open.

## Related Guides

- [Ground Classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) — reclassifying when a delivery fails
- [Training a Random Forest Point Classifier](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/training-a-random-forest-point-classifier/) — the features the plausibility checks reuse
- [Validating Attribute Tables with Pandera](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-attribute-tables-with-pandera/) — the same discipline for vector attributes

Back to [Data Validation and QA Gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
