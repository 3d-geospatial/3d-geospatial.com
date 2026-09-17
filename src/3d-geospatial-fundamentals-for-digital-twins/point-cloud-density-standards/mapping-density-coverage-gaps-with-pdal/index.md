---
title: "Mapping Density Coverage Gaps with PDAL"
description: "Find where a LiDAR delivery is too thin: rasterise point counts with PDAL, separate real voids from coverage gaps"
---
# Mapping Density Coverage Gaps with PDAL

This page turns a density requirement into a map — rasterising point counts per cell with PDAL's `writers.gdal`, distinguishing genuine voids such as water from coverage gaps caused by flight-line spacing, and reporting the deficient area as a percentage and as polygons a contractor can be shown, for a delivery in EPSG:25832+7837.

## Why you hit this

A delivery specification says "8 points per square metre, minimum". The delivered file reports a mean of 11.4 and passes. Then a terrain model built from it has stripes, a building extraction misses the north side of a street, and a reflight is needed. The mean was never the requirement: a cloud with 20 pts/m² over half the area and 2 over the other half averages 11. What matters is the *distribution* and specifically where it falls below the target, which is a raster question rather than a statistic. The targets themselves are in [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).

## Prerequisites

- PDAL 2.6+ with Python bindings (`pdal>=3.4`), plus `rasterio>=1.3`, `numpy>=1.24`, `shapely>=2.0`, `geopandas>=0.14`.
- A classified LAZ delivery in EPSG:25832 with NAVD-equivalent heights — DHHN2016 here — and its delivery extent as a polygon.
- The density target and the aggregation cell size from the specification. Both matter: 8 pts/m² assessed on 1 m cells is a much stricter requirement than the same figure on 10 m cells.

## Step-by-Step

### 1. Rasterise the point count, not the mean

```python
import json
from pathlib import Path

import pdal

TILE = "deliveries/2026-09/tile_691_5335.laz"
CELL = 1.0                     # metres; the specification's assessment cell
BOUNDS = "([691000, 692000], [5335000, 5336000])"

def density_raster(src, out_tif, cell=CELL, bounds=BOUNDS, classes=None):
    stages = [src]
    if classes:
        limits = ",".join(f"Classification[{c}:{c}]" for c in classes)
        stages.append({"type": "filters.range", "limits": limits})
    stages.append({
        "type": "writers.gdal",
        "filename": out_tif,
        "resolution": cell,
        "bounds": bounds,
        "output_type": "count",          # points per cell, the quantity the spec means
        "data_type": "uint16",
        "nodata": 0,
        "gdaldriver": "GTiff",
        "override_srs": "EPSG:25832",
    })
    count = pdal.Pipeline(json.dumps({"pipeline": stages})).execute()
    return count

n_all = density_raster(TILE, "build/density_all.tif")
n_ground = density_raster(TILE, "build/density_ground.tif", classes=[2])
print(f"{n_all:,} points rasterised; {n_ground:,} ground points")
```

`output_type: "count"` is the whole trick. The instinct is to compute a mean density from the header — total points divided by area — and that number is exactly the one that hides the problem. A count raster at the specification's cell size *is* the requirement, rendered.

Passing explicit `bounds` matters too: without them, `writers.gdal` sizes the grid to the data, so an area with no points at all simply falls outside the raster and never appears as a gap.

### 2. Separate real voids from coverage gaps

Not every empty cell is a failure. Water absorbs the pulse, building interiors have no returns, and a cell under a bridge deck is legitimately empty at ground level.

```python
import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize

def void_mask(shape, transform, water_path=None, buildings_path=None, crs=25832):
    mask = np.zeros(shape, dtype=bool)
    for path, buffer_m in ((water_path, 1.0), (buildings_path, 0.0)):
        if not path:
            continue
        gdf = gpd.read_file(path).to_crs(crs)
        geoms = [g.buffer(buffer_m) for g in gdf.geometry if g is not None and not g.is_empty]
        if geoms:
            mask |= rasterize(geoms, out_shape=shape, transform=transform,
                              fill=0, default_value=1, dtype="uint8").astype(bool)
    return mask

with rasterio.open("build/density_all.tif") as src:
    counts = src.read(1).astype(np.int32)
    transform, shape, crs = src.transform, src.shape, src.crs

legit_void = void_mask(shape, transform,
                       water_path="reference/water.gpkg",
                       buildings_path="reference/footprints.gpkg")
print(f"{100 * legit_void.mean():.1f}% of the tile is water or building interior")
```

Excluding known voids is what makes the resulting number defensible. A tile with a lake covering 12% of it can never reach the target everywhere, and reporting 12% deficiency against a specification that did not intend it wastes everyone's time. Buffering water outward by a metre also absorbs the shoreline, where partial returns produce genuinely low counts.

<figure class="diagram">
<svg viewBox="26 -9 708 267" role="img" aria-labelledby="dens-kinds-t dens-kinds-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dens-kinds-t">Three reasons a cell is empty or thin</title>
  <desc id="dens-kinds-d">A tile in plan. A lake and the interior of a building are legitimate voids with no returns and are excluded from assessment. A strip between two flight lines has low but non-zero counts and is a coverage gap that fails the specification. A dense overlap between flight lines has double the target density and inflates the mean.</desc>
  <rect class="svg-bg" x="26" y="-9" width="708" height="267" fill="#ffffff"/>
  <rect x="40" y="30" width="680" height="170" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M90 90 C140 60 200 70 230 100 C250 130 200 160 150 155 C100 150 70 120 90 90 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="300" y="60" width="80" height="60" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <rect x="430" y="30" width="40" height="170" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="560" y="30" width="60" height="170" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="155" y="180">water: excluded</text>
    <text x="340" y="140">building: excluded</text>
    <text x="450" y="222">gap between</text>
    <text x="450" y="240">flight lines: fails</text>
    <text x="590" y="222">overlap: inflates</text>
    <text x="590" y="240">the mean</text>
  </g>
  <text x="380" y="18" fill="#15384a" font-size="12" text-anchor="middle">The mean over this tile passes; two thin strips still fail the specification.</text>
</svg>
<figcaption>Only the third region is a delivery defect, and it is invisible in any aggregate statistic that includes the fourth.</figcaption>
</figure>

### 3. Measure the deficiency

```python
TARGET = 8.0                              # points per m², from the specification

def deficiency(counts, cell, target, legit_void):
    density = counts / (cell * cell)
    assessable = ~legit_void
    deficient = assessable & (density < target)
    empty = assessable & (counts == 0)
    return {
        "target_per_m2": target,
        "cell_m": cell,
        "assessable_cells": int(assessable.sum()),
        "deficient_cells": int(deficient.sum()),
        "deficient_pct": round(100 * deficient.sum() / max(assessable.sum(), 1), 2),
        "empty_cells": int(empty.sum()),
        "median_density": float(np.median(density[assessable])),
        "p05_density": float(np.percentile(density[assessable], 5)),
        "mean_density": float(density[assessable].mean()),
    }, deficient

report, deficient = deficiency(counts, CELL, TARGET, legit_void)
print(json.dumps(report, indent=2))
```

Reporting the fifth percentile next to the mean is what makes the difference visible in one line. A healthy delivery has a p05 above the target; the failing delivery in the output below has a mean of 11.4 and a p05 of 2.1, which is the whole story.

### 4. Turn deficient cells into polygons

A percentage starts a discussion; a map of where ends it.

```python
from rasterio.features import shapes
from shapely.geometry import shape as to_shape

def deficiency_polygons(deficient, transform, crs, min_area_m2=200.0):
    geoms = []
    for geom, value in shapes(deficient.astype("uint8"), mask=deficient, transform=transform):
        poly = to_shape(geom)
        if poly.area >= min_area_m2:
            geoms.append(poly)
    gdf = gpd.GeoDataFrame({"area_m2": [round(g.area, 1) for g in geoms]},
                           geometry=geoms, crs=crs)
    return gdf.sort_values("area_m2", ascending=False).reset_index(drop=True)

gaps = deficiency_polygons(deficient, transform, crs)
gaps.to_file("build/density_gaps.gpkg", layer="gaps", driver="GPKG")
print(gaps.head(5))
print(f"{len(gaps)} gap polygons ≥ 200 m², total {gaps['area_m2'].sum() / 1e4:.2f} ha")
```

The minimum-area filter removes the speckle of individual cells that any real survey has — a wet patch of asphalt, a dark roof — and keeps the contiguous regions that indicate a systematic problem. A long, straight, narrow polygon is a flight-line gap; a compact one under a canopy is vegetation absorbing the pulse; a large irregular one is a missing pass.

### 5. Classify each gap by its likely cause

```python
def classify_gap(poly, counts, transform, legit_void):
    minx, miny, maxx, maxy = poly.bounds
    aspect = (maxx - minx) / max(maxy - miny, 1e-6)
    elongated = aspect > 4 or aspect < 0.25
    return {
        "area_m2": round(poly.area, 1),
        "aspect": round(aspect, 2),
        "shape": "strip" if elongated else "patch",
        "likely_cause": ("flight-line spacing" if elongated
                         else "absorption or occlusion" if poly.area < 2000
                         else "missing pass"),
    }

for i, row in gaps.head(6).iterrows():
    print(classify_gap(row.geometry, counts, transform, legit_void))
```

Classifying by shape is crude and useful: flight-line gaps are long and straight because they follow the aircraft's track, absorption patches are compact and scattered, and a missing pass is a large block. Handing a contractor a list of three strips at a consistent spacing is a different conversation from handing them a percentage.

<figure class="diagram">
<svg viewBox="56 16 658 230" role="img" aria-labelledby="dens-dist-t dens-dist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dens-dist-t">Why the mean passes and the delivery fails</title>
  <desc id="dens-dist-d">A histogram of per-cell density for a delivery with a target of eight points per square metre. A large mode sits near eighteen in the flight-line overlaps, a second mode sits near nine, and a tail below the target holds about nine percent of the assessable cells. The mean of 11.4 lies above the target while the fifth percentile is 2.1.</desc>
  <rect class="svg-bg" x="56" y="16" width="658" height="230" fill="#ffffff"/>
  <path d="M70 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.2">
    <rect x="90" y="150" width="34" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="126" y="140" width="34" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="162" y="158" width="34" height="22" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="198" y="120" width="34" height="60" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="234" y="80" width="34" height="100" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="96" width="34" height="84" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="306" y="120" width="34" height="60" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="342" y="132" width="34" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="414" y="60" width="34" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="450" y="44" width="34" height="136" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="486" y="70" width="34" height="110" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="522" y="110" width="34" height="70" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <path d="M196 30 V180" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="190" y="46" fill="#b0413e" font-size="12" text-anchor="end">target 8</text>
  <path d="M340 30 V180" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="348" y="46" fill="#4f7a4d" font-size="12" text-anchor="start">mean 11.4</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="200">2</text><text x="250" y="200">9</text><text x="450" y="200">18</text><text x="620" y="200">30 pts/m²</text>
  </g>
  <text x="380" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">9% of assessable cells are below target; the overlap mode pulls the mean above it</text>
</svg>
<figcaption>The two upper modes are flight-line coverage and overlap; the failing tail is the delivery defect the mean conceals.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="dens-gate-t dens-gate-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dens-gate-t">Three acceptance criteria and what each catches</title>
  <desc id="dens-gate-d">A table. A limit on the share of deficient cells catches diffuse thinness across a tile. A floor on the fifth percentile catches a distribution whose tail is below target even when its area is small. A limit on the largest single gap catches one large hole that passes the percentage test. A delivery has to satisfy all three.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="20" width="470" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="250" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="56" width="470" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="100" width="250" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="100" width="470" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="144" width="250" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="144" width="470" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="43">criterion</text><text x="505" y="43">the failure it catches</text>
    <text x="145" y="83">deficient cells ≤ 2%</text><text x="505" y="83">thinness spread thinly across the whole tile</text>
    <text x="145" y="127">p05 density ≥ target</text><text x="505" y="127">a below-target tail with a small area share</text>
    <text x="145" y="171">largest gap ≤ 0.5 ha</text><text x="505" y="171">one big hole inside an acceptable percentage</text>
  </g>
  <text x="380" y="220" fill="#15384a" font-size="12.5" text-anchor="middle">Any one criterion alone can be satisfied by a delivery that fails the other two.</text>
</svg>
<figcaption>Three criteria because thinness has three shapes: everywhere a little, somewhere a lot, and one hole.</figcaption>
</figure>

### 6. Gate the delivery

```python
import sys

MAX_DEFICIENT_PCT = 2.0
MAX_SINGLE_GAP_HA = 0.5

def gate(report, gaps):
    failures = []
    if report["deficient_pct"] > MAX_DEFICIENT_PCT:
        failures.append(f"{report['deficient_pct']}% of assessable cells below "
                        f"{report['target_per_m2']} pts/m² (limit {MAX_DEFICIENT_PCT}%)")
    if report["p05_density"] < report["target_per_m2"]:
        failures.append(f"p05 density {report['p05_density']:.1f} is below the target")
    if len(gaps) and gaps["area_m2"].max() / 1e4 > MAX_SINGLE_GAP_HA:
        failures.append(f"largest gap {gaps['area_m2'].max() / 1e4:.2f} ha exceeds "
                        f"{MAX_SINGLE_GAP_HA} ha")
    for f in failures:
        print("FAIL:", f)
    return 1 if failures else 0

sys.exit(gate(report, gaps))
```

Three criteria, because one is never enough. A percentage limit catches diffuse thinness; a fifth-percentile floor catches a distribution whose tail is below target even when its area share is small; and a single-gap limit catches the case where 1.8% of the tile is deficient and all of it is one 2-hectare hole.

## Expected Output & Verification

```text
18,402,118 points rasterised; 6,204,882 ground points
0.4% of the tile is water or building interior
{
  "target_per_m2": 8.0,
  "cell_m": 1.0,
  "assessable_cells": 996012,
  "deficient_cells": 89204,
  "deficient_pct": 8.96,
  "empty_cells": 1204,
  "median_density": 12.0,
  "p05_density": 2.1,
  "mean_density": 11.42
}
   area_m2                                           geometry
0  18420.0  POLYGON ((691204.000 5335000.000, 691204.000 5...
1   9204.0  POLYGON ((691680.000 5335000.000, 691680.000 5...
2    884.0  POLYGON ((691402.000 5335612.000, 691402.000 5...
5 gap polygons ≥ 200 m², total 2.94 ha
{'area_m2': 18420.0, 'aspect': 0.02, 'shape': 'strip', 'likely_cause': 'flight-line spacing'}
FAIL: 8.96% of assessable cells below 8.0 pts/m² (limit 2.0%)
FAIL: p05 density 2.1 is below the target
FAIL: largest gap 1.84 ha exceeds 0.5 ha
```

Verify the raster before trusting the report, because an incorrectly georeferenced or wrongly scaled count raster produces confident nonsense:

```python
with rasterio.open("build/density_all.tif") as src:
    assert src.crs.to_epsg() == 25832, "density raster CRS is wrong"
    assert abs(src.res[0] - CELL) < 1e-9 and abs(src.res[1] - CELL) < 1e-9, "cell size mismatch"
    total_in_raster = int(src.read(1).astype(np.int64).sum())

print(f"points in raster {total_in_raster:,} vs points rasterised {n_all:,} "
      f"({100 * total_in_raster / n_all:.2f}%)")
assert total_in_raster >= 0.98 * n_all, "points lost: raster bounds do not cover the data"
```

The sum of the count raster must equal the number of points PDAL processed, within the handful that fall exactly on a boundary. A total that is 60% of the point count means the explicit bounds do not cover the tile, and every gap the report found is an artefact of the grid rather than of the survey.

Then verify the gap polygons against the flight-line geometry if the delivery includes trajectory data: a strip gap should fall exactly between two adjacent lines, which both confirms the diagnosis and gives the contractor the line numbers.

## Performance Notes

- **Rasterising is a single pass over the points** and is fast: a 20-million-point tile at 1 m cells takes seconds and the output raster is a few megabytes.
- **Assess per delivery tile, aggregate afterwards.** A city-wide raster at 1 m is large and unnecessary; per-tile reports summed into one table answer the same question.
- **Keep the count rasters.** They are small, and they are the evidence behind an acceptance decision; regenerating them years later needs the original LAZ.
- **Rasterise ground separately** when the specification sets a ground-point target, as most do for terrain products. A cloud can pass overall and fail on ground under canopy.
- **Use `uint16` and guard against overflow.** At 1 m cells a dense terrestrial scan can exceed 65,535 points in a cell; switch to `uint32` for mobile-mapping data.

## Common Errors

**Every cell reports zero.** The bounds are in the wrong CRS or the wrong order. PDAL's `bounds` syntax is `([minx, maxx], [miny, maxy])`, which is easy to confuse with the more common min/max-pair ordering.

**Deficiency is 100% at a plausible-looking mean.** The cell size and the target disagree in units — a 0.5 m cell with a per-square-metre target means each cell's count has to be divided by 0.25, which the code above does and a hand calculation often does not.

**Building roofs appear as gaps.** The building mask excluded roofs as well as interiors. Mask only what genuinely has no returns: water, and building *interiors* if assessing ground points. Roofs are a legitimate part of an all-returns assessment.

**Gaps appear along every tile edge.** Neighbouring tiles' points are missing, so the edge cells are half-empty. Assess with a buffer of neighbouring data, or exclude a one-cell border from the statistics.

## Frequently Asked Questions

### What cell size should a specification use?

The one the product needs. A 1 m cell is right for terrain at 1 m resolution; a 2 m cell is more forgiving and appropriate for regional mapping. State it in the specification, because the same point cloud passes at 5 m and fails at 1 m.

### Should overlap be counted towards the target?

It is genuinely there, so yes for an all-returns assessment. It should not be allowed to *compensate* for a gap elsewhere, which is exactly what a mean does and what the percentile and per-cell criteria prevent.

### Is nominal point spacing a better requirement than density?

They are two views of the same quantity — spacing is roughly the inverse square root of density — and spacing is more intuitive for judging whether a feature will be resolved. Assessing either one per cell is what matters; the conversion is in [estimating point spacing for mobile mapping scans](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/estimating-point-spacing-for-mobile-mapping-scans/).

## Related Guides

- [Computing Point Density from LAZ with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/computing-point-density-from-laz-with-pdal/) — the per-file statistics this builds on
- [Validating Density Against USGS Quality Levels](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/validating-density-against-usgs-quality-levels/) — mapping the numbers to a published standard
- [Thinning Point Clouds to a Target Density](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/thinning-point-clouds-to-a-target-density/) — the opposite problem, too many points

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
