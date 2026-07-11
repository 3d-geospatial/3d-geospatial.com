# Computing Point Density and Coverage Gaps from LAZ with PDAL

This page measures **point density** (points per square metre) and coverage uniformity from a `.laz` file with `PDAL` — using `filters.hexbin` to estimate density and trace the survey boundary, reading the EPSG code straight from the LAS header (EPSG:32618 in the examples), and reporting a median density plus the fraction of the extent that falls into gaps. The pipeline is a PDAL JSON stage list driven from the `pdal` Python bindings, with `numpy` only for the final reduction, so the same logic runs unchanged in a batch job over a whole delivery.

You hit this when a survey lands and you need one authoritative density figure before it enters the twin — and, more importantly, a map of where the cloud is too thin to trust. A headline mean hides dropped flight lines and occlusion shadows; PDAL's `filters.hexbin` is purpose-built for both jobs because it estimates density and emits a boundary polygon whose interior holes are exactly the voids you care about. This complements the standalone `laspy`/`numpy` binning in the [point cloud density standards](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) reference and the per-asset targets in [LiDAR point density best practices for infrastructure](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/); here the tool is PDAL end to end.

<figure class="diagram">
<svg viewBox="0 0 780 300" role="img" aria-labelledby="pdalhex-t pdalhex-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pdalhex-t">PDAL hexbin density and boundary with a coverage gap</title>
  <desc id="pdalhex-d">Scattered LAZ points in EPSG:32618 are aggregated by filters.hexbin into hexagonal cells; occupied hexagons yield a density in points per square metre while an unfilled hexagon in the interior is reported as a hole in the boundary polygon.</desc>
  <defs>
    <marker id="pdalhex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="200" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#15384a"><circle cx="55" cy="95" r="2.5"/><circle cx="90" cy="110" r="2.5"/><circle cx="130" cy="90" r="2.5"/><circle cx="170" cy="120" r="2.5"/><circle cx="70" cy="160" r="2.5"/><circle cx="120" cy="180" r="2.5"/><circle cx="180" cy="200" r="2.5"/><circle cx="95" cy="210" r="2.5"/><circle cx="150" cy="150" r="2.5"/></g>
  <g stroke="#4f7a4d" stroke-width="2" fill="#eef5e9">
    <polygon points="400,80 430,97 430,131 400,148 370,131 370,97"/>
    <polygon points="460,80 490,97 490,131 460,148 430,131 430,97"/>
    <polygon points="400,148 430,165 430,199 400,216 370,199 370,165"/>
    <polygon points="460,148 490,165 490,199 460,216 430,199 430,165"/>
  </g>
  <polygon points="520,148 550,165 550,199 520,216 490,199 490,165" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2" stroke-dasharray="4 3"/>
  <rect x="600" y="95" width="160" height="110" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pdalhex-arrow)">
    <line x1="220" y1="150" x2="365" y2="150"/>
    <line x1="558" y1="150" x2="598" y2="150"/>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="120" y="265">LAZ points · EPSG:32618</text>
    <text x="445" y="255">hexbin aggregate</text>
    <text x="680" y="135"><tspan x="680" dy="0">density (ppsm)</tspan><tspan x="680" dy="18">+ boundary</tspan><tspan x="680" dy="18">with holes</tspan></text>
  </g>
  <text x="520" y="245" fill="#c46a3d" font-size="12" text-anchor="middle">gap = hole</text>
</svg>
<figcaption>filters.hexbin aggregates points into hexagons, reports density per square metre, and returns a boundary polygon whose interior holes are the coverage gaps.</figcaption>
</figure>

## Prerequisites

- PDAL 2.5+ with the Python bindings and `numpy>=1.24`. Install the whole stack from conda-forge so the LAZ backend and GEOS (which `filters.hexbin` needs for the boundary polygon) are matched: `conda install -c conda-forge pdal python-pdal numpy`.
- A `.laz` or `.las` tile whose header declares a projected metric CRS. The examples assume EPSG:32618 (UTM 18N, metres); density computed in a geographic CRS such as EPSG:4326 is wrong by orders of magnitude because a degree is not a metre.
- A density target to check against — for example a QL1 floor of 8 ppsm for urban work. The Quality Level table lives in the [point cloud density standards](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) reference.
- The authoritative `filters.hexbin` and pipeline documentation at [pdal.io](https://pdal.io/) if you need the full option list.

## Step-by-Step

### 1. Read the CRS from the LAS header with PDAL

Run a metadata-only pipeline and pull the horizontal CRS from the reader stage. Refuse to proceed unless it is projected and metric — every density figure downstream depends on it.

```python
import pdal
import json

LAZ = "survey_18N.laz"
info = pdal.Pipeline(json.dumps([{"type": "readers.las", "filename": LAZ}]))
info.execute()
meta = info.metadata["metadata"]["readers.las"]

srs_wkt = meta["srs"]["horizontal"]
print("declared CRS:", srs_wkt[:70])
assert "32618" in srs_wkt or "UTM zone 18N" in srs_wkt, \
    "expected EPSG:32618; reproject to a projected metric CRS before density"
print("header point count:", meta["count"])
```

### 2. Estimate density and boundary with filters.hexbin

`filters.hexbin` lays a hexagonal grid over the cloud, keeps hexagons holding at least `threshold` points, and reports an average density plus a boundary polygon. Set `edge_size` to the resolution you care about (1 m gives density directly comparable to a ppsm target).

```python
import pdal
import json

pipeline = pdal.Pipeline(json.dumps([
    {"type": "readers.las", "filename": "survey_18N.laz"},
    {"type": "filters.hexbin", "edge_size": 1.0, "threshold": 1},
]))
pipeline.execute()

hb = pipeline.metadata["metadata"]["filters.hexbin"]
print("avg density (pts/m^2):", round(hb["density"], 2))
print("covered area (m^2):", round(hb["area"], 1))
print("avg point spacing (m):", round(hb.get("avg_pt_spacing", 0.0), 3))
```

### 3. Turn the boundary into a coverage gap fraction

The hexbin `boundary` is a WKT polygon; interior rings (holes) are voids the survey never covered. Compare the polygon's net area against its outer-ring area with `shapely` to get the fraction of the footprint lost to gaps.

```python
from shapely import wkt

poly = wkt.loads(hb["boundary"])              # POLYGON, holes = coverage gaps
from shapely.geometry import Polygon
outer = Polygon(poly.exterior)                 # footprint ignoring holes

gap_fraction = 1.0 - (poly.area / outer.area)
print(f"coverage gaps: {gap_fraction:.2%} of the footprint")
print("gap (hole) count:", len(list(poly.interiors)))
```

### 4. Compute a median density and empty-cell fraction over a grid

The hexbin average is a single number; acceptance also needs the median and the worst served regions. Read the point coordinates PDAL already streamed, bin them into a metric grid, and reduce over occupied cells. This uses PDAL as the reader and keeps the reduction to a compact `numpy` step — the standalone binning routine is detailed in the density standards reference.

```python
import numpy as np

arr = pipeline.arrays[0]                        # structured array from the executed pipeline
x, y = np.asarray(arr["X"]), np.asarray(arr["Y"])   # metres, EPSG:32618

cell = 1.0
minx, miny = x.min(), y.min()
cols = int(np.ceil((x.max() - minx) / cell)) + 1
rows = int(np.ceil((y.max() - miny) / cell)) + 1
ci = np.clip(((x - minx) / cell).astype(np.int64), 0, cols - 1)
ri = np.clip(((y - miny) / cell).astype(np.int64), 0, rows - 1)

counts = np.zeros((rows, cols), dtype=np.int64)
np.add.at(counts, (ri, ci), 1)
occupied = counts[counts > 0] / (cell * cell)   # ppsm

print("median density:", round(float(np.median(occupied)), 2), "ppsm")
print("p05 density:", round(float(np.percentile(occupied, 5)), 2), "ppsm")
print("empty-cell fraction:", round(float((counts == 0).mean()), 4))
```

### 5. Gate the result against the acquisition target

Fold the figures into a pass/fail a CI job can act on: the median must clear the contracted density and the gaps must stay under an acceptance threshold.

```python
TARGET_PPSM = 8.0          # QL1 urban floor
MAX_GAP = 0.02             # 2% of footprint

median = float(np.median(occupied))
status = "PASS" if (median >= TARGET_PPSM and gap_fraction <= MAX_GAP) else "FAIL"
print(f"median {median:.1f} ppsm, gaps {gap_fraction:.2%} -> {status}")
```

## Expected Output & Verification

A healthy QL1 urban tile in EPSG:32618 should print an average and median near or above target with a small gap fraction:

```text
declared CRS: PROJCS["WGS 84 / UTM zone 18N", ...
header point count: 41880233
avg density (pts/m^2): 11.4
covered area (m^2): 998840.0
avg point spacing (m): 0.29
coverage gaps: 0.8% of the footprint
median density: 11.1 ppsm
p05 density: 6.9 ppsm
empty-cell fraction: 0.0121
median 11.1 ppsm, gaps 0.80% -> PASS
```

Cross-check the two independent estimates: the hexbin `avg_pt_spacing` (~0.29 m) and the grid median (~11 ppsm) should agree through `spacing ≈ 1/√density` — here 1/√11.1 ≈ 0.30 m, a match that confirms the figure is real rather than an artifact of one method's cell geometry. If the hexbin density and the grid median disagree by more than a few percent, the cloud is clustered along flight lines; if either comes back near zero, the CRS is still geographic — recheck step 1.

## Common Errors

**`PDAL: filters.hexbin: Unable to compute boundary` or a missing `boundary` key.** PDAL was built without GEOS, so hexbin can estimate density but cannot trace the polygon. Install the conda-forge `pdal` build (which links GEOS), or drop step 3 and rely on the grid empty-cell fraction from step 4 for gap detection.

**Density reported as a tiny fraction such as 0.000004 pts/m².** The header CRS is geographic (EPSG:4326), so PDAL measured area in square degrees. The assertion in step 1 is meant to catch this; reproject with `filters.reprojection` (`in_srs`/`out_srs` set to explicit EPSG codes, e.g. to EPSG:32618) before the hexbin stage.

**`KeyError: 'filters.hexbin'` when reading metadata.** The pipeline was constructed but never executed, or the stage name was misspelled, so no metadata block exists. Call `pipeline.execute()` before touching `pipeline.metadata`, and read the block under the exact stage key `filters.hexbin`.

## Related Guides

- [Point Cloud Density Standards](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — ppsm, Quality Levels, and the standalone numpy binning routine
- [LiDAR Point Density Best Practices](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/) — per-asset density targets and sparse-cell flagging
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — reproject to EPSG:32618 before any metric measurement
- [Digital Elevation Model Workflows](/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — where density gaps surface as raster voids

Back to [Point Cloud Density Standards](/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
