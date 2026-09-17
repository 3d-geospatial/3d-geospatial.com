# Validating Density Against USGS Quality Levels

This page determines which USGS 3DEP quality level a LiDAR delivery actually meets — computing density the way the Lidar Base Specification does, from single-swath first returns rather than all returns, deriving nominal pulse spacing, computing non-vegetated and vegetated vertical accuracy from checkpoints, and producing a verdict with the evidence attached.

## Why you hit this

"QL2" appears in procurement documents, project specifications and metadata records as if it were a single number, and it is a compound requirement: a density *and* a spacing *and* two vertical accuracies, each assessed in a prescribed way. A delivery whose all-returns density is 12 pts/m² can fail QL1's density requirement, because the assessment counts first returns from one swath and the 12 came from overlap between three. A delivery with an excellent RMSE over open ground can fail on vegetated accuracy. Determining the level from the data, rather than repeating what the metadata claims, is the only way a twin knows what its terrain is worth. The density concepts are in [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).

## Prerequisites

- PDAL 2.6+ with Python bindings, `laspy[lazrs]>=2.5`, `numpy>=1.24`, `rasterio>=1.3`.
- A delivery with `PointSourceId` populated per swath and `ReturnNumber` intact — both are required by the specification and both are occasionally stripped by processing.
- Surveyed checkpoints in open terrain and in vegetation, in the delivery's compound CRS (EPSG:26910+5703 in the examples).
- The current revision of the Lidar Base Specification for the exact assessment procedure; the quality-level thresholds below are stable across recent revisions, while the assessment details have been refined.

## The Quality Levels

| Level | Aggregate nominal pulse density | Aggregate nominal pulse spacing | RMSEz (non-vegetated) |
|---|---|---|---|
| QL0 | ≥ 8 pts/m² | ≤ 0.35 m | ≤ 5 cm |
| QL1 | ≥ 8 pts/m² | ≤ 0.35 m | ≤ 10 cm |
| QL2 | ≥ 2 pts/m² | ≤ 0.71 m | ≤ 10 cm |
| QL3 | ≥ 0.5 pts/m² | ≤ 1.41 m | ≤ 20 cm |

Two things about that table are routinely missed. QL0 and QL1 have the same density requirement and differ only in vertical accuracy, so "we need QL1 density" is the same statement as "we need QL0 density". And the spacing column is not an independent requirement — it is the density expressed as a distance, `spacing = 1/√density` — so a delivery cannot satisfy one and fail the other unless the assessment areas differ.

Vertical accuracy is specified twice. **Non-vegetated vertical accuracy (NVA)** is computed at 95% confidence as `1.96 × RMSEz` over open, hard surfaces, where errors are approximately normal. **Vegetated vertical accuracy (VVA)** is the 95th percentile of absolute error under canopy, because errors there are not normal and a mean-based statistic understates the tail.

<figure class="diagram">
<svg viewBox="6 12 708 250" role="img" aria-labelledby="ql-levels-t ql-levels-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ql-levels-t">Quality levels on density and vertical accuracy</title>
  <desc id="ql-levels-d">A grid with density on one axis and vertical accuracy on the other. QL0 requires eight points per square metre and five centimetre accuracy. QL1 requires the same density with ten centimetre accuracy. QL2 requires two points per square metre with ten centimetres. QL3 requires half a point per square metre with twenty centimetres. A delivery lands in the best cell it satisfies on both axes.</desc>
  <rect class="svg-bg" x="6" y="12" width="708" height="250" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="160" y="26" width="180" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="340" y="26" width="180" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="520" y="26" width="180" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="60" width="140" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="160" y="60" width="180" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="340" y="60" width="180" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="520" y="60" width="180" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="20" y="116" width="140" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="160" y="116" width="180" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="340" y="116" width="180" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="520" y="116" width="180" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="20" y="172" width="140" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="160" y="172" width="180" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="340" y="172" width="180" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="520" y="172" width="180" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="250" y="48">RMSEz ≤ 5 cm</text>
    <text x="430" y="48">≤ 10 cm</text>
    <text x="610" y="48">≤ 20 cm</text>
    <text x="90" y="94">≥ 8 pts/m²</text>
    <text x="90" y="150">≥ 2 pts/m²</text>
    <text x="90" y="206">≥ 0.5 pts/m²</text>
    <text x="250" y="94">QL0</text>
    <text x="430" y="94">QL1</text>
    <text x="430" y="150">QL2</text>
    <text x="610" y="206">QL3</text>
  </g>
  <text x="380" y="244" fill="#15384a" font-size="12" text-anchor="middle">A delivery must satisfy both axes; density alone names no level.</text>
</svg>
<figcaption>Four levels over two axes, which is why "QL1 density" and "QL1" are different claims.</figcaption>
</figure>

## Step-by-Step

### 1. Confirm the fields the assessment needs

```python
import laspy
import numpy as np

def assessment_readiness(path):
    las = laspy.read(path)
    swaths = np.unique(las.point_source_id)
    returns = np.unique(las.return_number)
    crs = las.header.parse_crs()
    return {
        "points": int(las.header.point_count),
        "swaths": int(len(swaths)),
        "swath_ids": [int(s) for s in swaths[:8]],
        "return_numbers": [int(r) for r in returns],
        "has_first_returns": bool((las.return_number == 1).any()),
        "crs": crs.to_string() if crs else None,
        "epsg": crs.to_epsg() if crs else None,
        "gps_time_present": bool(hasattr(las, "gps_time") and np.ptp(las.gps_time) > 0),
    }

info = assessment_readiness("deliveries/2026-09/tile_10TFK.laz")
print(info)
assert info["swaths"] > 1, "PointSourceId is constant: single-swath assessment is impossible"
assert info["has_first_returns"], "ReturnNumber is missing or all zero"
```

The assessment is defined on single-swath first returns, so a delivery with a constant `PointSourceId` cannot be assessed as specified — and that is common, because some processing chains rewrite the field. It is a finding in itself: the delivery does not contain the information the specification requires, which is a compliance failure rather than a density one.

### 2. Compute density from single-swath first returns

```python
import json

import pdal
import rasterio

def swath_first_return_density(src, swath_id, cell, out_tif, bounds):
    stages = [
        src,
        {"type": "filters.range",
         "limits": f"PointSourceId[{swath_id}:{swath_id}],ReturnNumber[1:1]"},
        {"type": "writers.gdal", "filename": out_tif, "resolution": cell,
         "bounds": bounds, "output_type": "count", "data_type": "uint16",
         "nodata": 0, "gdaldriver": "GTiff"},
    ]
    n = pdal.Pipeline(json.dumps({"pipeline": stages})).execute()
    with rasterio.open(out_tif) as r:
        counts = r.read(1)
    occupied = counts[counts > 0]
    return {
        "swath": swath_id,
        "first_returns": int(n),
        "cells_occupied": int(occupied.size),
        "density_per_m2": round(float(occupied.mean() / (cell * cell)), 2),
        "p05_density": round(float(np.percentile(occupied, 5) / (cell * cell)), 2),
    }

BOUNDS = "([560000, 561000], [5240000, 5241000])"
CELL = 1.0
per_swath = [swath_first_return_density("deliveries/2026-09/tile_10TFK.laz", s, CELL,
                                        f"build/dens_swath_{s}.tif", BOUNDS)
             for s in info["swath_ids"]]
for row in per_swath:
    print(row)

anpd = float(np.median([r["density_per_m2"] for r in per_swath]))
anps = 1.0 / np.sqrt(anpd) if anpd else float("inf")
print(f"aggregate nominal pulse density {anpd:.2f} pts/m², spacing {anps:.3f} m")
```

Restricting to one swath and to first returns is the entire difference between the specification's number and the naive one. First returns approximate pulses — one pulse produces one first return — and a single swath removes the inflation from overlap. A delivery flown with 50% side overlap has roughly double the all-returns density of its per-swath figure, which is why a cloud that reports 14 pts/m² can be a QL2 delivery.

<figure class="diagram">
<svg viewBox="61 9 703 227" role="img" aria-labelledby="ql-swath-t ql-swath-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ql-swath-t">All-returns density against single-swath first-return density</title>
  <desc id="ql-swath-d">Bars for one tile. All returns from all swaths give 14.2 points per square metre. All returns from one swath give 7.1. First returns only from one swath give 4.3, which is the figure the specification assesses, and it places the delivery in QL2 rather than QL1.</desc>
  <rect class="svg-bg" x="61" y="9" width="703" height="227" fill="#ffffff"/>
  <path d="M230 24 V190" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="230" y="40" width="440" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="88" width="220" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="136" width="133" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="76" y="62">all returns, all swaths</text>
    <text x="76" y="110">all returns, one swath</text>
    <text x="76" y="158">first returns, one swath</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="682" y="62">14.2 pts/m²</text>
    <text x="462" y="110">7.1</text>
    <text x="375" y="158">4.3 — the assessed figure</text>
  </g>
  <path d="M478 24 V190" fill="none" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="486" y="36" fill="#1f6b8a" font-size="12" text-anchor="start">QL1/QL0 threshold: 8</text>
  <text x="400" y="218" fill="#15384a" font-size="12.5" text-anchor="middle">The same tile passes on the first row and fails on the third.</text>
</svg>
<figcaption>Three defensible-sounding ways to count give three different answers; only the bottom one is what the level means.</figcaption>
</figure>

### 3. Compute the two vertical accuracies

```python
def vertical_accuracy(dtm_path, checkpoints_csv):
    """checkpoints_csv: easting, northing, height, land_cover (open|vegetated)"""
    import csv
    rows = list(csv.DictReader(open(checkpoints_csv)))
    with rasterio.open(dtm_path) as dtm:
        coords = [(float(r["easting"]), float(r["northing"])) for r in rows]
        sampled = np.array([v[0] for v in dtm.sample(coords)], dtype=float)
    truth = np.array([float(r["height"]) for r in rows])
    cover = np.array([r["land_cover"] for r in rows])
    err = sampled - truth
    ok = np.isfinite(err)

    open_err = err[ok & (cover == "open")]
    veg_err = err[ok & (cover == "vegetated")]
    rmse = float(np.sqrt((open_err ** 2).mean())) if open_err.size else float("nan")
    return {
        "open_checkpoints": int(open_err.size),
        "rmse_z_open_m": round(rmse, 3),
        "nva_95_m": round(1.96 * rmse, 3),
        "mean_bias_open_m": round(float(open_err.mean()), 3) if open_err.size else None,
        "vegetated_checkpoints": int(veg_err.size),
        "vva_95pct_m": round(float(np.percentile(np.abs(veg_err), 95)), 3) if veg_err.size else None,
    }

acc = vertical_accuracy("build/dtm_1m.tif", "reference/checkpoints.csv")
print(acc)
```

Using a mean-based statistic for open ground and a percentile for vegetation is not an arbitrary asymmetry: under canopy the error distribution has a long tail of points where the ground was never seen and the interpolation guessed, and an RMSE computed over those understates how wrong the worst areas are. The specification's choice of the 95th percentile for VVA reflects that, and a report that quotes an RMSE for vegetated accuracy is quoting the wrong statistic.

The mean bias deserves its own line. A bias of +7 cm with an RMSE of 8 cm is a systematic vertical offset — a datum or a calibration problem, fixable — while a bias near zero with the same RMSE is noise at the sensor's level.

### 4. Determine the level

```python
QL = [
    ("QL0", 8.0, 0.35, 0.05),
    ("QL1", 8.0, 0.35, 0.10),
    ("QL2", 2.0, 0.71, 0.10),
    ("QL3", 0.5, 1.41, 0.20),
]

def determine_level(anpd, anps, rmse_open):
    achieved, reasons = None, {}
    for name, min_density, max_spacing, max_rmse in QL:
        checks = {
            "density": anpd >= min_density,
            "spacing": anps <= max_spacing,
            "rmse": rmse_open <= max_rmse,
        }
        reasons[name] = checks
        if all(checks.values()) and achieved is None:
            achieved = name
    return achieved, reasons

level, reasons = determine_level(anpd, anps, acc["rmse_z_open_m"])
print(f"achieved level: {level or 'below QL3'}")
for name, checks in reasons.items():
    failed = [k for k, v in checks.items() if not v]
    print(f"  {name}: {'pass' if not failed else 'fails on ' + ', '.join(failed)}")
```

Evaluating every level rather than just the claimed one is what makes the report useful. A delivery sold as QL1 that fails only on density is a different conversation from one that fails on accuracy: the first may be acceptable for a terrain product at QL2, the second is a calibration problem that affects everything.

### 5. Write the determination with its evidence

```python
from pathlib import Path

def write_determination(path, tile, level, anpd, anps, acc, per_swath, claimed=None):
    lines = [
        f"# Quality level determination — {tile}", "",
        f"- claimed: **{claimed or 'not stated'}**",
        f"- determined: **{level or 'below QL3'}**",
        f"- aggregate nominal pulse density: {anpd:.2f} pts/m² (single-swath first returns)",
        f"- aggregate nominal pulse spacing: {anps:.3f} m",
        f"- RMSEz open: {acc['rmse_z_open_m']:.3f} m → NVA(95%) {acc['nva_95_m']:.3f} m",
        f"- VVA(95th percentile): {acc['vva_95pct_m']} m",
        f"- vertical bias (open): {acc['mean_bias_open_m']:+.3f} m",
        f"- checkpoints: {acc['open_checkpoints']} open, {acc['vegetated_checkpoints']} vegetated",
        "", "## Per-swath density", "", "| swath | first returns | density | p05 |", "|---|---|---|---|",
    ]
    for r in per_swath:
        lines.append(f"| {r['swath']} | {r['first_returns']:,} | "
                     f"{r['density_per_m2']:.2f} | {r['p05_density']:.2f} |")
    Path(path).write_text("\n".join(lines) + "\n")
    return level

write_determination("build/ql_determination.md", "10TFK", level, anpd, anps, acc,
                    per_swath, claimed="QL1")
print(Path("build/ql_determination.md").read_text()[:600])
```

<figure class="diagram">
<svg viewBox="96 36 633 208" role="img" aria-labelledby="ql-acc-t ql-acc-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ql-acc-t">Why vegetated accuracy uses a percentile</title>
  <desc id="ql-acc-d">Two error distributions. Over open ground the errors are roughly normal and narrow, so the root mean square error describes them and the 95 percent confidence figure is 1.96 times it. Under vegetation the distribution is skewed with a long tail of large errors where no ground return existed, so a root mean square error understates the tail and the 95th percentile of absolute error is reported instead.</desc>
  <rect class="svg-bg" x="96" y="36" width="633" height="208" fill="#ffffff"/>
  <path d="M60 180 H360" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M110 180 C170 180 175 50 210 50 C245 50 250 180 310 180" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M210 180 V44" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <text x="210" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">open ground: normal</text>
  <text x="210" y="226" fill="#4f7a4d" font-size="12.5" text-anchor="middle">RMSEz × 1.96 = NVA</text>
  <path d="M420 180 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M440 180 C490 180 490 60 520 60 C550 60 560 140 620 156 C660 166 690 172 715 176" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M660 180 V120" fill="none" stroke="#b0413e" stroke-width="2"/>
  <text x="660" y="112" fill="#b0413e" font-size="12" text-anchor="middle">95th pct</text>
  <text x="570" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">vegetated: skewed tail</text>
  <text x="570" y="226" fill="#9a4f26" font-size="12.5" text-anchor="middle">VVA = 95th percentile of |error|</text>
</svg>
<figcaption>The statistic follows the distribution: a symmetric error gets a standard deviation, a tailed one gets a percentile.</figcaption>
</figure>

## Expected Output & Verification

```text
{'points': 18402118, 'swaths': 6, 'swath_ids': [101, 102, 103, 104, 105, 106],
 'return_numbers': [1, 2, 3, 4, 5], 'has_first_returns': True,
 'crs': 'NAD83 / UTM zone 10N + NAVD88 height', 'epsg': None, 'gps_time_present': True}
{'swath': 101, 'first_returns': 1204882, 'cells_occupied': 284102, 'density_per_m2': 4.24, 'p05_density': 2.0}
{'swath': 102, 'first_returns': 1188204, 'cells_occupied': 281044, 'density_per_m2': 4.23, 'p05_density': 2.0}
aggregate nominal pulse density 4.28 pts/m², spacing 0.483 m
{'open_checkpoints': 24, 'rmse_z_open_m': 0.062, 'nva_95_m': 0.122,
 'mean_bias_open_m': 0.011, 'vegetated_checkpoints': 18, 'vva_95pct_m': 0.181}
achieved level: QL2
  QL0: fails on density, spacing, rmse
  QL1: fails on density, spacing
  QL2: pass
  QL3: pass
```

The delivery was sold as QL1 and is a good QL2: its accuracy meets QL1 and QL2 (6.2 cm RMSE), and its assessed density of 4.3 pts/m² is half the QL1 requirement. That is a specific, evidenced finding — the flight was flown at QL2 line spacing — rather than a dispute about whether the data is "good".

Verify the assessment itself, because every step of it can be wrong in a way that changes the verdict:

```python
def sanity_check_assessment(per_swath, anpd, all_returns_density):
    ratios = [r["density_per_m2"] / anpd for r in per_swath]
    return {
        "swath_consistency": round(float(max(ratios) / min(ratios)), 2),
        "overlap_inflation": round(all_returns_density / anpd, 2),
        "swaths_assessed": len(per_swath),
    }

all_ret = 14.2      # from the naive all-returns raster
print(sanity_check_assessment(per_swath, anpd, all_ret))
assert 1.0 <= sanity_check_assessment(per_swath, anpd, all_ret)["swath_consistency"] < 1.3
```

Per-swath densities should agree within a few percent, since the aircraft flew the same configuration on every line; a swath 40% below the others is a line flown higher or with a different pulse rate, and it should be reported rather than averaged away. The overlap inflation figure — all returns divided by the assessed density — is normally between 2 and 4, and a value near 1 means either no overlap or a `PointSourceId` that does not actually distinguish swaths.

## Performance Notes

- **Rasterise per swath in parallel.** Each swath is an independent PDAL pipeline, and a six-swath tile assesses in about the time of one.
- **Assess a sample of tiles, not all of them.** A delivery of 400 tiles flown in one campaign has one quality level; assessing 20 tiles spread across it, plus any tile a user complains about, is proportionate.
- **Keep the per-swath rasters** as the evidence behind the determination; they are small and they are what a dispute comes back to.
- **Cache checkpoint sampling.** The terrain model changes between processing runs; the checkpoints do not, so store the sampled values with the run that produced them.

## Common Errors

**Every swath reports the same density as the whole tile.** `PointSourceId` is constant. The delivery cannot be assessed as specified, which is itself the finding.

**Assessed density is higher than the all-returns density.** The `ReturnNumber` filter was inverted, or the cell size and the target units disagree. First returns are a strict subset of all returns.

**VVA is better than NVA.** Almost always a mislabelled checkpoint set — open checkpoints marked as vegetated. Under canopy the accuracy is worse, sometimes much worse, and a result that says otherwise should be investigated rather than celebrated.

**The verdict changes with the cell size.** Density assessed on 1 m cells and on 2 m cells differ, because occupancy interacts with the grid. Use the cell size the specification's revision names, and record it in the determination.

## Frequently Asked Questions

### Does a twin need QL1 data?

For building extraction and street-level detail, yes — 8 pts/m² is roughly the threshold where roof planes and kerbs are resolved. For regional terrain, drainage and flood modelling, QL2 is the normal standard and QL1 buys little. Deciding per product rather than per programme is what keeps survey budgets sane.

### Can a QL2 delivery be upgraded by combining swaths?

Not in the specification's terms, because the assessment is single-swath by design — it measures what one pass delivered, which is what determines whether features are resolved consistently. Combined density genuinely helps some products, and it does not change the level.

### What about non-US projects?

The quality levels are a USGS construct, and they have become a convenient shorthand elsewhere. A European delivery specified in points per square metre with a stated RMSEz can be mapped onto the table for communication, as long as the assessment method is stated — because, as the numbers above show, the method changes the answer by a factor of three.

## Related Guides

- [Mapping Density Coverage Gaps with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/mapping-density-coverage-gaps-with-pdal/) — where the density falls short within a tile
- [Best Practices for LiDAR Point Density in Infrastructure](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/) — choosing a target per asset class
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the usual cause of a vertical bias

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
