---
title: "Resampling DEMs Without Stair-Step Artifacts"
description: "Resample elevation rasters with rasterio without terraces or blocks: detect integer quantisation, pick resampling per direction, handle nodata and dequantise within bounds."
---
# Resampling DEMs Without Stair-Step Artifacts

This page resamples digital elevation models with `rasterio` without producing the terraces, blocks and banded hillshades that make a twin's terrain look like a contour map — detecting integer-quantised heights, choosing the resampling method separately for upsampling and downsampling, keeping nodata from bleeding into valid cells, and removing quantisation steps without inventing relief, on a DEM in EPSG:26910 with NAVD88 heights (EPSG:5703).

## Why you hit this

Terrain for a digital twin almost never arrives at the resolution the renderer wants. A national 10 m DEM has to be upsampled to meet 1 m building footprints; a 0.5 m LiDAR DEM has to be downsampled for a regional overview or for [generating quantized-mesh terrain tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/generating-quantized-mesh-terrain-tiles/). Both directions have a characteristic artifact. Upsampling a DEM stored as whole metres produces flat terraces separated by one-metre cliffs, clearly visible once lit. Downsampling with nearest-neighbour aliases ridges into jagged steps. Neither shows up in summary statistics, and both show up the moment someone orbits the camera over a hillside.

## Prerequisites

- `rasterio>=1.3`, `numpy>=1.24`, `scipy>=1.11`.
- A single-band elevation GeoTIFF with a defined CRS — EPSG:26910 here, heights in NAVD88 — and a known nodata value.
- For verification, a set of surveyed check points in the same horizontal and vertical CRS, or a higher-resolution DEM of part of the area.

## Step-by-Step

### 1. Inspect storage type and quantisation

```python
import numpy as np
import rasterio

with rasterio.open("county_dem_10m.tif") as src:
    print(src.crs.to_epsg(), src.res, src.dtypes[0], "nodata", src.nodata,
          "scale", src.scales[0], "offset", src.offsets[0])
    dem = src.read(1, masked=True).astype("float64")
    dem = dem * src.scales[0] + src.offsets[0]

vals = dem.compressed()
frac = np.abs(vals - np.round(vals))
step_guess = {s: np.mean(np.abs(vals / s - np.round(vals / s)) < 1e-6) for s in (1.0, 0.5, 0.1, 0.01)}
print("fraction of cells on each quantisation grid:", {k: round(v, 3) for k, v in step_guess.items()})
```

A DEM stored as `int16` is quantised to its storage unit, and one stored as `float32` can still be quantised if it was produced from integer data upstream. The test that matters is how many cell values sit exactly on a grid of 1 m, 0.5 m, 0.1 m or 1 cm. A result of `{1.0: 1.0, ...}` means every height is a whole metre; on terrain with a 5% slope and 10 m cells that is a one-metre step every two cells — a staircase before any resampling happens. Apply `scales` and `offsets` before testing, because some producers store decimetres as integers with a scale of 0.1.

### 2. Measure the terracing directly

```python
from scipy import ndimage

def terrace_index(z, cell):
    gy, gx = np.gradient(np.ma.filled(z, np.nan), cell)
    slope = np.hypot(gx, gy)
    sloped = np.isfinite(slope)
    flat_on_slope = (slope < 1e-6)
    regional = ndimage.uniform_filter(np.nan_to_num(slope), size=15) > 0.03   # hillside, not a plain
    return float(np.mean(flat_on_slope[sloped & regional]))

print(f"terrace index: {terrace_index(dem, 10.0):.2f}")
```

The index is the share of cells that are perfectly flat while sitting on a hillside whose regional slope exceeds 3%. Real terrain almost never has exactly zero local slope on a hillside, so a value above a few percent is quantisation. It is a better gate than eyeballing a hillshade, because it runs in CI and gives a number to compare before and after.

<figure class="diagram">
<svg viewBox="16 16 718 238" role="img" aria-labelledby="dem-terr-t dem-terr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-terr-t">A hillside profile stored as whole metres, then upsampled</title>
  <desc id="dem-terr-d">A smooth hillside profile is stored as whole-metre integers, which turns it into a staircase with a one-metre riser every two cells. Upsampling with bilinear interpolation smooths only the corners of each step and keeps the flat treads. Constrained dequantisation before upsampling recovers a profile within half a metre of the original everywhere.</desc>
  <rect class="svg-bg" x="16" y="16" width="718" height="238" fill="#ffffff"/>
  <path d="M60 30 V200 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M80 190 L700 50" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M80 190 H160 V168 H240 V150 H320 V132 H400 V114 H480 V96 H560 V78 H640 V60 H700" fill="none" stroke="#b0413e" stroke-width="2"/>
  <path d="M80 186 C130 186 150 176 170 168 C200 162 220 154 250 150 C280 146 300 136 330 132 C360 128 380 118 410 114 C440 110 460 100 490 96 C520 92 540 82 570 78 C600 74 620 64 650 60 L700 58" fill="none" stroke="#9a4f26" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="600" y="100" fill="#4f7a4d" font-size="12.5" text-anchor="start">true surface</text>
  <text x="330" y="170" fill="#b0413e" font-size="12.5" text-anchor="start">stored as int16 metres</text>
  <text x="150" y="130" fill="#9a4f26" font-size="12.5" text-anchor="middle">bilinear upsample</text>
  <text x="390" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">distance along the slope — interpolation rounds the corners and keeps the treads</text>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="52" y="194">0 m</text><text x="52" y="54">8 m</text>
  </g>
</svg>
<figcaption>Interpolation cannot remove steps that are in the data. Quantisation has to be dealt with before the resolution changes, not after.</figcaption>
</figure>

### 3. Downsample with averaging, masked

```python
from rasterio.enums import Resampling
from rasterio.warp import reproject

def resample(src_path, dst_path, factor, method):
    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        dst_h, dst_w = int(src.height / factor), int(src.width / factor)
        transform = src.transform * src.transform.scale(src.width / dst_w, src.height / dst_h)
        profile.update(height=dst_h, width=dst_w, transform=transform, dtype="float32", nodata=-9999.0)
        data = src.read(1).astype("float32")
        out = np.full((dst_h, dst_w), -9999.0, dtype="float32")
        reproject(
            source=data, destination=out,
            src_transform=src.transform, src_crs=src.crs, src_nodata=src.nodata,
            dst_transform=transform, dst_crs=src.crs, dst_nodata=-9999.0,
            resampling=method,
        )
    with rasterio.open(dst_path, "w", **profile) as dst:
        dst.write(out, 1)

resample("lidar_dem_0p5m.tif", "overview_dem_5m.tif", factor=10, method=Resampling.average)
```

`Resampling.average` takes the mean of every source cell under each destination cell, which is what a coarser sensor would have measured and what prevents aliasing. Nearest-neighbour picks one source cell out of a hundred at a factor of ten, so a ridge that happens to fall between sampled cells vanishes in one row and reappears in the next. Passing `src_nodata` is essential: without it, a nodata value of −9999 inside a lake is averaged into its neighbours and drags the shoreline several hundred metres below sea level.

### 4. Upsample with an interpolating kernel, clamped at breaklines

```python
def upsample_clamped(src_path, dst_path, factor):
    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        dst_h, dst_w = src.height * factor, src.width * factor
        transform = src.transform * src.transform.scale(1 / factor, 1 / factor)
        data = src.read(1, masked=True).astype("float32")
        filled = np.ma.filled(data, np.nan)

        smooth = np.full((dst_h, dst_w), np.nan, dtype="float32")
        reproject(filled, smooth, src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=transform, dst_crs=src.crs, dst_nodata=np.nan,
                  resampling=Resampling.cubic_spline)
        lo = np.full_like(smooth, np.nan)
        hi = np.full_like(smooth, np.nan)
        local_min = ndimage.minimum_filter(np.nan_to_num(filled, nan=np.inf), size=3)
        local_max = ndimage.maximum_filter(np.nan_to_num(filled, nan=-np.inf), size=3)
        reproject(local_min, lo, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=transform, dst_crs=src.crs, resampling=Resampling.nearest)
        reproject(local_max, hi, src_transform=src.transform, src_crs=src.crs,
                  dst_transform=transform, dst_crs=src.crs, resampling=Resampling.nearest)
        out = np.clip(smooth, lo, hi)
        profile.update(height=dst_h, width=dst_w, transform=transform, dtype="float32", nodata=np.nan)
    with rasterio.open(dst_path, "w", **profile) as dst:
        dst.write(out, 1)
```

Cubic spline gives smooth, continuous slopes, which is what lighting needs. Its weakness is overshoot: next to a quarry wall or a dam face it rings, producing a lip above the crest and a trench below the toe that do not exist. Clamping every output cell to the range of its 3 × 3 source neighbourhood removes the ringing while keeping the smooth interior. Nodata is carried as NaN so the kernel never blends a real height with a sentinel value.

<figure class="diagram">
<svg viewBox="6 6 748 240" role="img" aria-labelledby="dem-meth-t dem-meth-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-meth-t">Which resampling method for which direction</title>
  <desc id="dem-meth-d">A matrix of four resampling methods against downsampling and upsampling. Nearest is poor in both directions, aliasing when downsampling and producing blocks when upsampling. Average is the right choice for downsampling and does nothing useful when upsampling. Bilinear is acceptable for upsampling but leaves a faceted look under lighting. Cubic spline gives the smoothest upsampling but must be clamped near breaklines.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="200" y="20" width="270" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="470" y="20" width="270" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="56" width="270" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="470" y="56" width="270" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="100" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="100" width="270" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="470" y="100" width="270" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="20" y="144" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="144" width="270" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="470" y="144" width="270" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="188" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="188" width="270" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="470" y="188" width="270" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="335" y="43">downsampling</text>
    <text x="605" y="43">upsampling</text>
    <text x="110" y="83">nearest</text><text x="335" y="83">aliases ridges</text><text x="605" y="83">square blocks</text>
    <text x="110" y="127">average</text><text x="335" y="127">use this</text><text x="605" y="127">no effect</text>
    <text x="110" y="171">bilinear</text><text x="335" y="171">mild aliasing</text><text x="605" y="171">faceted under light</text>
    <text x="110" y="215">cubic_spline</text><text x="335" y="215">ringing, slow</text><text x="605" y="215">use this, clamped</text>
  </g>
</svg>
<figcaption>There is no single best resampling method for elevation. Averaging is right when cells merge; a smooth kernel is right when they split.</figcaption>
</figure>

### 5. Remove quantisation steps without inventing relief

When the source is integer-quantised, smooth it before upsampling — but never by more than the quantisation could have hidden.

```python
def dequantise(z, step, sigma_cells=1.5, iterations=4):
    """Smooth an integer-quantised DEM while keeping every cell inside its original bin."""
    valid = ~np.ma.getmaskarray(z)
    base = np.ma.filled(z, 0.0).astype("float64")
    lo, hi = base - step / 2, base + step / 2
    cur = base.copy()
    weights = ndimage.gaussian_filter(valid.astype("float64"), sigma_cells)
    for _ in range(iterations):
        blurred = ndimage.gaussian_filter(np.where(valid, cur, 0.0), sigma_cells)
        cur = np.where(valid, np.clip(blurred / np.maximum(weights, 1e-9), lo, hi), cur)
    return np.ma.array(cur, mask=~valid)

dem_smooth = dequantise(dem, step=1.0)
print(f"terrace index before {terrace_index(dem, 10.0):.2f}, after {terrace_index(dem_smooth, 10.0):.2f}")
print(f"max change {np.max(np.abs(dem_smooth - dem)):.3f} m (bound 0.5 m)")
```

The constraint is what makes this defensible. A cell stored as 214 m could have been anything from 213.5 to 214.5 m, so moving it anywhere inside that interval is consistent with the data, and moving it outside is fabrication. Normalising the blur by the blurred validity mask stops nodata areas from pulling the edges of valid terrain towards zero, and a few iterations let the smoothing propagate across wide treads without ever leaving the bin.

## Expected Output & Verification

```text
26910 (10.0, -10.0) int16 nodata -32768 scale 1.0 offset 0.0
fraction of cells on each quantisation grid: {1.0: 1.0, 0.5: 1.0, 0.1: 1.0, 0.01: 1.0}
terrace index: 0.41
terrace index before 0.41, after 0.03
max change 0.500 m (bound 0.5 m)
```

Every grid reports 1.0 because integers are also multiples of 0.5, 0.1 and 0.01 — read the coarsest step that still reports 1.0. Verify the result against independent heights rather than against the input:

```python
from rasterio.transform import rowcol

checks = np.loadtxt("check_points_navd88.csv", delimiter=",", skiprows=1)   # easting, northing, height
with rasterio.open("dem_1m_dequantised.tif") as ds:
    rows, cols = rowcol(ds.transform, checks[:, 0], checks[:, 1])
    z = ds.read(1)[rows, cols]
residual = z - checks[:, 2]
print(f"RMSEz {np.sqrt(np.nanmean(residual ** 2)):.3f} m on {np.isfinite(residual).sum()} points")
```

The RMSEz after dequantisation and upsampling should be no worse than the source DEM's published accuracy, and is usually slightly better on slopes because the treads no longer bias heights by up to half a step.

<figure class="diagram">
<svg viewBox="86 2 568 220" role="img" aria-labelledby="dem-bin-t dem-bin-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-bin-t">Constrained smoothing stays inside each quantisation bin</title>
  <desc id="dem-bin-d">Five neighbouring cells stored as 212, 212, 213, 213 and 214 metres, each drawn with its half-metre bin above and below. An unconstrained blur moves the second cell below its bin. Constrained smoothing moves each cell towards a smooth line but stops at the bin edge, so the result is still consistent with the stored integers.</desc>
  <rect class="svg-bg" x="86" y="2" width="568" height="220" fill="#ffffff"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5">
    <rect x="100" y="130" width="60" height="50"/>
    <rect x="220" y="130" width="60" height="50"/>
    <rect x="340" y="90" width="60" height="50"/>
    <rect x="460" y="90" width="60" height="50"/>
    <rect x="580" y="50" width="60" height="50"/>
  </g>
  <path d="M130 172 L250 146 L370 118 L490 96 L610 70" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#4f7a4d">
    <circle cx="130" cy="172" r="5"/><circle cx="250" cy="146" r="5"/><circle cx="370" cy="118" r="5"/><circle cx="490" cy="96" r="5"/><circle cx="610" cy="70" r="5"/>
  </g>
  <circle cx="250" cy="192" r="6" fill="#b0413e"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="200">212</text><text x="370" y="160">213</text><text x="490" y="160">213</text><text x="610" y="120">214</text>
  </g>
  <text x="300" y="204" fill="#b0413e" font-size="12" text-anchor="start">unconstrained blur leaves the bin</text>
  <text x="380" y="30" fill="#15384a" font-size="12.5" text-anchor="middle">boxes: ±0.5 m around each stored value · green: constrained result</text>
</svg>
<figcaption>Every constrained value would round back to the integer that was stored, so the smoothing adds no information the data did not permit.</figcaption>
</figure>

## Common Errors

**A dark ring appears around lakes and voids after resampling.** Nodata was not passed as `src_nodata`, so the sentinel value was averaged or interpolated into valid neighbours. Pass it explicitly, or read masked and carry NaN.

**The output is shifted by half a cell.** The destination transform was built from the bounds without accounting for pixel-is-area versus pixel-is-point registration, or the dimensions were rounded without scaling the transform to match. Derive the transform with `src.transform * src.transform.scale(...)` from the exact ratio of old to new dimensions, as above.

**`CPLE_AppDefinedError: Too many points failed to transform`.** The source has no CRS or a different CRS from the destination. Check `src.crs` is EPSG:26910 before calling `reproject`; resampling within one CRS should never need a coordinate transformation.

## Frequently Asked Questions

### Should I store the resampled DEM as float32 or keep int16?

Float32. Writing a carefully dequantised surface back to whole metres restores every terrace. If storage matters, use a float32 GeoTIFF with a predictor and DEFLATE compression, which typically costs little more than the original integers.

### Is Lanczos better than cubic spline for elevation?

It is sharper and rings more. For terrain meant to be lit and viewed, clamped cubic spline is the safer default; Lanczos is worth trying on very smooth surfaces where preserving subtle curvature matters more than breaklines.

### Does this apply to DSMs with buildings?

Only with care. Smoothing or cubic interpolation across a roof edge creates sloped walls. Resample a DSM with `Resampling.max` when downsampling for obstruction analysis, and with nearest or clamped bilinear when upsampling, so building edges stay vertical.

## Related Guides

- [Merging and Mosaicking DEM Tiles with GDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/merging-and-mosaicking-dem-tiles-with-gdal/) — assembling the input before resampling
- [Generating Terrain Meshes from DEM Rasters](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/generating-terrain-meshes-from-dem-rasters/) — where the artifacts become visible
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — getting NAVD88 heights right before resampling

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
