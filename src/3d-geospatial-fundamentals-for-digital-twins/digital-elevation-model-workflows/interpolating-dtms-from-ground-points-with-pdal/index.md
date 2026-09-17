---
title: "Interpolating DTMs from Ground Points with PDAL"
description: "Build a terrain raster from classified ground returns: choose IDW or TIN, match cell size to density, handle voids and edges"
---
# Interpolating DTMs from Ground Points with PDAL

This page interpolates a digital terrain model from classified ground returns with PDAL — choosing between inverse-distance weighting and a Delaunay triangulation, matching the cell size to the point density instead of to a round number, handling voids under buildings and at tile edges, and verifying the surface against checkpoints and its own slope distribution, in EPSG:26910+5703.

## Why you hit this

The interpolation step looks trivial — one PDAL stage — and it decides more about the twin's terrain than any other single choice. Too fine a cell relative to the point density and the raster is a field of interpolation artefacts; too coarse and real breaks disappear. IDW produces characteristic bullseyes around isolated points; a triangulation produces flat triangles across voids that look like real planes. Both are defensible and they are not interchangeable, and a specification that says "1 m DTM" says nothing about either. The wider workflow is in [digital elevation model workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).

## Prerequisites

- PDAL 2.6+ with Python bindings (`pdal>=3.4`), `rasterio>=1.3`, `numpy>=1.24`, `scipy>=1.11`.
- A classified cloud with ground as class 2, noise already removed, in EPSG:26910 with NAVD88 heights.
- The cloud's ground-point density per cell, measured as in [mapping density coverage gaps with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/mapping-density-coverage-gaps-with-pdal/).
- Surveyed checkpoints for the verification step.

## Step-by-Step

### 1. Choose the cell size from the ground density

```python
import math

def cell_size_for(ground_density_per_m2, points_per_cell=4.0):
    """Cell size that puts about `points_per_cell` ground points in each cell."""
    spacing = 1.0 / math.sqrt(ground_density_per_m2)
    return round(spacing * math.sqrt(points_per_cell), 2), round(spacing, 3)

for d in (0.5, 2.0, 4.0, 8.0, 16.0):
    cell, spacing = cell_size_for(d)
    print(f"ground {d:>5} pts/m² → spacing {spacing:.3f} m → cell {cell:.2f} m")
```

The rule behind that table is that a cell needs several points to have an interpolated value rather than a guess. Four is a good target: at 4 pts/m² of *ground* — which a QL2 delivery gives over open terrain and much less under canopy — a 1 m cell holds about four points and a 0.5 m cell about one. Publishing a 0.5 m DTM from that data produces a raster whose every other cell is extrapolated, and whose apparent detail is interpolation noise.

Ground density is the number that matters, not total density. A cloud with 14 pts/m² can have 1.5 pts/m² of ground under forest, and the cell size has to serve the worst area the product covers or be stated per land cover.

### 2. Interpolate with IDW

```python
import json

import pdal

SRC = "deliveries/2026-09/tile_10TFK.laz"
BOUNDS = "([560000, 561000], [5240000, 5241000])"
CELL = 1.0

def idw_dtm(src, out, cell=CELL, bounds=BOUNDS, radius=None, power=2.0, window=0):
    radius = radius if radius is not None else cell * 1.5
    stages = [
        src,
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.gdal", "filename": out, "resolution": cell, "bounds": bounds,
         "output_type": "idw", "radius": radius, "power": power, "window_size": window,
         "data_type": "float32", "nodata": -9999.0, "gdaldriver": "GTiff",
         "override_srs": "EPSG:26910"},
    ]
    n = pdal.Pipeline(json.dumps({"pipeline": stages})).execute()
    return n

n = idw_dtm(SRC, "build/dtm_idw_1m.tif")
print(f"{n:,} ground points interpolated")
```

Three parameters control the result. `radius` is how far a cell looks for points; at 1.5 cells it finds neighbours without smearing across a break. `power` sets how quickly influence falls with distance — 2 is the standard, and higher values approach nearest-neighbour behaviour with visible cell edges. `window_size` fills cells that found nothing by growing a window, which is convenient and produces the flat patches discussed below; leaving it at 0 keeps voids as nodata, which is more honest.

### 3. Interpolate with a triangulation

```python
def tin_dtm(src, out, cell=CELL, bounds=BOUNDS):
    stages = [
        src,
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "filters.delaunay"},
        {"type": "filters.faceraster", "resolution": cell,
         "origin_x": 560000, "origin_y": 5240000, "width": int(1000 / cell), "height": int(1000 / cell)},
        {"type": "writers.raster", "filename": out, "data_type": "float32", "nodata": -9999.0},
    ]
    return pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

n_tin = tin_dtm(SRC, "build/dtm_tin_1m.tif")
print(f"{n_tin:,} points triangulated and rasterised")
```

A triangulation interpolates linearly inside each triangle, which has two consequences worth knowing. Within the data it is faithful: a plane through three ground points is a better estimate than a distance-weighted average, and ridges stay sharp. Across a void it produces one large flat triangle, so a building footprint with no ground returns becomes a tilted plane that looks entirely plausible and is invented.

<figure class="diagram">
<svg viewBox="42 46 719 190" role="img" aria-labelledby="dtm-methods-t dtm-methods-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dtm-methods-t">IDW and triangulation on the same ground points</title>
  <desc id="dtm-methods-d">A profile with sparse ground points and a gap where a building stood. Inverse-distance weighting produces a smooth curve that sags in the gap and shows small bullseye bumps at isolated points. The triangulation produces straight segments between points, which is faithful within the data and spans the gap as one flat plane.</desc>
  <rect class="svg-bg" x="42" y="46" width="719" height="190" fill="#ffffff"/>
  <g fill="#1f2937">
    <circle cx="60" cy="150" r="4"/><circle cx="110" cy="140" r="4"/><circle cx="160" cy="146" r="4"/>
    <circle cx="210" cy="126" r="4"/><circle cx="330" cy="120" r="4"/><circle cx="380" cy="112" r="4"/>
    <circle cx="430" cy="118" r="4"/><circle cx="480" cy="104" r="4"/>
  </g>
  <path d="M60 150 C90 138 100 136 110 140 C130 148 145 150 160 146 C185 138 195 130 210 126 C250 122 290 140 330 120 C355 108 368 108 380 112 C405 120 418 122 430 118 C455 110 468 104 480 104"
        fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M60 150 L110 140 L160 146 L210 126 L330 120 L380 112 L430 118 L480 104"
        fill="none" stroke="#4f7a4d" stroke-width="2.5" stroke-dasharray="7 4"/>
  <rect x="215" y="60" width="110" height="66" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <text x="270" y="96" fill="#1f2937" font-size="12" text-anchor="middle">building</text>
  <text x="270" y="152" fill="#b0413e" font-size="12" text-anchor="middle">no ground returns</text>
  <text x="560" y="120" fill="#1f6b8a" font-size="12.5" text-anchor="start">IDW: smooth, sags in the void</text>
  <text x="560" y="144" fill="#4f7a4d" font-size="12.5" text-anchor="start">TIN: faithful, one plane across it</text>
  <text x="380" y="218" fill="#15384a" font-size="12.5" text-anchor="middle">Both invent a surface under the building; they differ in how the invention looks.</text>
</svg>
<figcaption>Inside the data, the triangulation is the more faithful interpolator. Across a void, neither is right and both are confident.</figcaption>
</figure>

### 4. Handle voids honestly

```python
import numpy as np
import rasterio
from rasterio.features import rasterize
import geopandas as gpd

def mark_voids(dtm_path, out_path, footprints_path=None, max_fill_cells=3):
    with rasterio.open(dtm_path) as src:
        dem = src.read(1, masked=True)
        profile, transform, shape = src.profile.copy(), src.transform, src.shape

    void = np.ma.getmaskarray(dem)
    under_building = np.zeros(shape, dtype=bool)
    if footprints_path:
        gdf = gpd.read_file(footprints_path).to_crs(profile["crs"])
        under_building = rasterize([g for g in gdf.geometry], out_shape=shape,
                                   transform=transform, fill=0, default_value=1,
                                   dtype="uint8").astype(bool)

    from scipy import ndimage
    labels, n = ndimage.label(void)
    sizes = ndimage.sum(void, labels, index=range(1, n + 1))
    small = np.isin(labels, 1 + np.flatnonzero(sizes <= max_fill_cells))

    filled = np.ma.filled(dem, np.nan)
    if small.any():                                   # fill only speckle, by local mean
        mean = ndimage.generic_filter(np.nan_to_num(filled, nan=0.0), np.nanmean, size=5)
        filled[small] = mean[small]

    profile.update(dtype="float32", nodata=-9999.0, count=2)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(np.nan_to_num(filled, nan=-9999.0).astype("float32"), 1)
        dst.write((void & ~small).astype("float32"), 2)      # a mask band: 1 = interpolated void
    return {"void_cells": int(void.sum()), "speckle_filled": int(small.sum()),
            "voids_under_buildings": int((void & under_building).sum())}

print(mark_voids("build/dtm_tin_1m.tif", "build/dtm_1m_masked.tif",
                 footprints_path="reference/footprints.gpkg"))
```

Shipping a mask band alongside the elevation band is the honest answer to voids. Speckle — a cell or two where a wet patch absorbed the pulse — is filled from its neighbours and is genuinely interpolated terrain. A building footprint or a lake is not terrain at all, and a consumer needs to know which cells are measurement and which are invention. Both PDAL's `window_size` and a triangulation will silently fill both kinds if allowed to.

<figure class="diagram">
<svg viewBox="6 6 748 222" role="img" aria-labelledby="dtm-void-t dtm-void-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dtm-void-t">Three kinds of empty cell and what to do with each</title>
  <desc id="dtm-void-d">A table. Speckle of one to three cells from absorbed pulses is filled from neighbours and counts as interpolated terrain. A building footprint has no terrain at all and is left as nodata with a mask band. A water body is handled by hydro-flattening rather than interpolation. A tile edge is filled by interpolating with a buffer of neighbouring points.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="250" y="20" width="490" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="54" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="94" width="230" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="250" y="94" width="490" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="134" width="230" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="250" y="134" width="490" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="174" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="174" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="43">empty cells</text><text x="495" y="43">treatment</text>
    <text x="135" y="79">speckle, 1–3 cells</text><text x="495" y="79">fill from neighbours; it is interpolated terrain</text>
    <text x="135" y="119">building footprint</text><text x="495" y="119">leave nodata, record it in a mask band</text>
    <text x="135" y="159">water body</text><text x="495" y="159">hydro-flatten, not interpolate</text>
    <text x="135" y="199">tile edge</text><text x="495" y="199">interpolate with a buffer, then clip</text>
  </g>
</svg>
<figcaption>Only the first and last are interpolation problems; the middle two are decisions about what the product claims to contain.</figcaption>
</figure>

### 5. Compare the two surfaces

```python
def compare_surfaces(a_path, b_path):
    with rasterio.open(a_path) as a, rasterio.open(b_path) as b:
        assert a.transform == b.transform and a.shape == b.shape, "grids differ"
        za, zb = a.read(1, masked=True), b.read(1, masked=True)
    diff = (zb - za).compressed()
    def slope_stats(z, cell=CELL):
        gy, gx = np.gradient(np.ma.filled(z, np.nan), cell)
        s = np.degrees(np.arctan(np.hypot(gx, gy)))
        s = s[np.isfinite(s)]
        return round(float(np.median(s)), 2), round(float(np.percentile(s, 99)), 2)
    return {
        "cells_compared": int(diff.size),
        "rmse_between_m": round(float(np.sqrt((diff ** 2).mean())), 4),
        "p95_abs_m": round(float(np.percentile(np.abs(diff), 95)), 4),
        "idw_slope_median_p99": slope_stats(za),
        "tin_slope_median_p99": slope_stats(zb),
    }

print(compare_surfaces("build/dtm_idw_1m.tif", "build/dtm_tin_1m.tif"))
```

The 99th percentile of slope is the artefact detector. Real terrain in a given landscape has a slope distribution with a known upper end; a surface whose p99 slope is 70° in gently rolling country has spikes, and those come from interpolation across voids or from un-removed noise rather than from the ground. Comparing the two methods' slope distributions is more informative than comparing their elevations, because they agree on elevation almost everywhere and disagree exactly where the artefacts are.

<figure class="diagram">
<svg viewBox="6 6 748 228" role="img" aria-labelledby="dtm-cell-t dtm-cell-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dtm-cell-t">Cell size against ground density</title>
  <desc id="dtm-cell-d">A table of ground point density against the cell size that puts about four points in each cell. Half a point per square metre needs a 2.8 metre cell. Two points per square metre need 1.4 metres. Four need 1 metre. Eight need 0.7 metres. Sixteen need half a metre. Publishing a finer cell than the density supports produces interpolation noise rather than detail.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="228" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="240" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="20" width="240" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="500" y="20" width="240" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="54" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="54" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="86" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="86" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="86" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="118" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="118" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="118" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="150" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="150" width="240" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="150" width="240" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="140" y="43">ground density</text><text x="380" y="43">nominal spacing</text><text x="620" y="43">cell for ~4 pts/cell</text>
    <text x="140" y="75">0.5 pts/m²</text><text x="380" y="75">1.41 m</text><text x="620" y="75">2.8 m</text>
    <text x="140" y="107">2 pts/m²</text><text x="380" y="107">0.71 m</text><text x="620" y="107">1.4 m</text>
    <text x="140" y="139">4 pts/m²</text><text x="380" y="139">0.50 m</text><text x="620" y="139">1.0 m</text>
    <text x="140" y="171">16 pts/m²</text><text x="380" y="171">0.25 m</text><text x="620" y="171">0.5 m</text>
  </g>
  <text x="380" y="216" fill="#15384a" font-size="12.5" text-anchor="middle">Under canopy the ground density is a fraction of the total, and it is the one that binds.</text>
</svg>
<figcaption>The cell size is a property of the data, and stating it without stating the ground density it came from is how "1 m DTM" became meaningless.</figcaption>
</figure>

### 6. Verify against checkpoints and the edges

```python
def verify_dtm(dtm_path, checkpoints_csv, cell=CELL):
    import csv
    rows = list(csv.DictReader(open(checkpoints_csv)))
    coords = [(float(r["easting"]), float(r["northing"])) for r in rows]
    truth = np.array([float(r["height"]) for r in rows])
    with rasterio.open(dtm_path) as src:
        sampled = np.array([v[0] for v in src.sample(coords)], dtype=float)
        dem = src.read(1, masked=True)
        edge = np.ma.getmaskarray(dem)[[0, -1], :].mean() + np.ma.getmaskarray(dem)[:, [0, -1]].mean()
    ok = np.isfinite(sampled) & (sampled > -1e4)
    err = sampled[ok] - truth[ok]
    return {
        "checkpoints_used": int(ok.sum()),
        "rmse_m": round(float(np.sqrt((err ** 2).mean())), 3),
        "bias_m": round(float(err.mean()), 3),
        "max_abs_m": round(float(np.abs(err).max()), 3),
        "edge_nodata_share": round(float(edge / 2), 4),
    }

print(verify_dtm("build/dtm_tin_1m.tif", "reference/checkpoints.csv"))
```

The edge figure catches the artefact nobody looks for. A tile interpolated from its own points only has a border where the triangulation has no neighbours on one side, so the outermost cells are extrapolated or empty. Interpolating with a buffer of the neighbouring tiles' points and then clipping to the tile is the fix, and the edge nodata share is how you know whether it was applied.

## Expected Output & Verification

```text
ground   0.5 pts/m² → spacing 1.414 m → cell 2.83 m
ground   2.0 pts/m² → spacing 0.707 m → cell 1.41 m
ground   4.0 pts/m² → spacing 0.500 m → cell 1.00 m
ground   8.0 pts/m² → spacing 0.354 m → cell 0.71 m
ground  16.0 pts/m² → spacing 0.250 m → cell 0.50 m
6,204,882 ground points interpolated
6,204,882 points triangulated and rasterised
{'void_cells': 184204, 'speckle_filled': 2104, 'voids_under_buildings': 178402}
{'cells_compared': 815808, 'rmse_between_m': 0.041, 'p95_abs_m': 0.078,
 'idw_slope_median_p99': (2.41, 38.8), 'tin_slope_median_p99': (2.38, 31.2)}
{'checkpoints_used': 24, 'rmse_m': 0.061, 'bias_m': 0.008, 'max_abs_m': 0.118}
```

Two surfaces that agree to 4 cm RMSE, with the triangulation showing a lower 99th-percentile slope, is the normal outcome: they describe the same terrain and IDW's bullseyes show up in the slope tail. Nearly all of the void cells are under buildings, which is exactly right for an urban tile and is the reason the mask band exists.

Verify the interpolation is not inventing detail, by comparing against a coarser version of itself:

```python
def detail_check(dtm_path, factor=3):
    from rasterio.enums import Resampling
    with rasterio.open(dtm_path) as src:
        fine = src.read(1, masked=True)
        coarse = src.read(1, masked=True,
                          out_shape=(1, src.height // factor, src.width // factor),
                          resampling=Resampling.average)
        back = src.read(1, masked=True,
                        out_shape=(1, src.height, src.width), resampling=Resampling.bilinear)
    resid = (fine - back).compressed()
    return {"std_of_detail_m": round(float(resid.std()), 4),
            "p99_detail_m": round(float(np.percentile(np.abs(resid), 99)), 4)}

print(detail_check("build/dtm_tin_1m.tif"))
```

The residual between a surface and a smoothed version of itself is the "detail" the fine resolution adds. On real terrain it correlates with landform — larger on slopes and breaks, small on flats. When it is uniformly distributed and close to the interpolator's noise level, the fine cell size is adding no information, which is the quantitative version of the cell-size rule.

## Performance Notes

- **IDW is a single pass with a neighbourhood search** and handles tens of millions of points per minute; the triangulation is slower and memory-hungry, roughly 2 GB per 10 million points.
- **Tile with a buffer of at least three cells** — more for the triangulation — and clip afterwards, so tile edges have neighbours.
- **Interpolate ground only.** Passing the full cloud and relying on the interpolator to prefer low points is slower and produces a surface influenced by vegetation.
- **Write float32, not float64.** Terrain heights need millimetre precision over a few hundred metres, which float32 gives comfortably, and the raster is half the size.
- **Keep the ground point cloud.** A DTM is a derived product and the cell size will be revisited; re-interpolating takes minutes.

## Common Errors

**The raster is empty outside a small area.** `bounds` was omitted, so the grid was sized to the data, or the bounds are in the wrong order. PDAL uses `([minx, maxx], [miny, maxy])`.

**Terrain under buildings looks like a smooth hill.** Voids were filled by `window_size` or by the triangulation and nothing recorded it. Ship the mask band.

**The surface has pits at isolated low points.** Un-removed noise below the ground: a single low return pulls its cell down. Remove outliers before interpolating, as in [removing noise from terrestrial LiDAR scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/).

**Tile edges show a seam in the hillshade.** Each tile was interpolated from its own points. Buffer, interpolate, clip.

**A 0.5 m DTM looks noisy where a 1 m one looked clean.** The ground density does not support 0.5 m cells. That is not a bug in the interpolator.

## Frequently Asked Questions

### IDW or TIN for a twin's terrain?

TIN for accuracy within the data and for keeping breaks sharp, which matters where terrain meets buildings and roads. IDW for a smoother surface that is cheaper to compute and more forgiving of irregular density. Many programmes use TIN for the product and IDW for quick looks.

### What about natural-neighbour or spline interpolation?

Both are available through GDAL and both are better than IDW at avoiding bullseyes, at more computational cost. They do not change the void problem or the cell-size rule, which are the two decisions that matter most.

### Should breaklines be used?

Where they exist, yes: inserting road edges, kerbs and water boundaries as constraints produces a surface that respects them instead of smoothing across. It requires a constrained triangulation rather than the plain Delaunay above, and it is what higher-quality terrain specifications ask for.

## Related Guides

- [Hydro-Flattening Water Bodies in DEMs](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/hydro-flattening-water-bodies-in-dems/) — correcting water surfaces afterwards
- [Resampling DEMs Without Stair-Step Artifacts](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/resampling-dems-without-stair-step-artifacts/) — changing resolution after interpolation
- [Generating Terrain Meshes from DEM Rasters](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/generating-terrain-meshes-from-dem-rasters/) — turning the result into geometry

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
