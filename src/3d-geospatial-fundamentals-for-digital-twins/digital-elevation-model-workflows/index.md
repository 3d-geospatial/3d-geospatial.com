---
title: "Digital Elevation Model Workflows"
description: "Build DTM, DSM, and DEM rasters from classified point clouds: rasterization, void filling, hydro-flattening, interpolation, edge-matching, and vertical datums."
---
# Digital Elevation Model Workflows

Turning a classified LiDAR point cloud into a clean, analysis-ready elevation raster is deceptively hard: the point cloud is irregular and full of gaps, the output must be a regular grid on a stated cell size, water bodies have to read flat, and the vertical heights must sit on a declared datum or every flood, line-of-sight, and volumetric calculation downstream is quietly wrong. This guide walks the full pipeline — from `.laz` ground returns to a void-filled, hydro-flattened GeoTIFF — using `PDAL`, GDAL, `rasterio`, `numpy`, and `scipy`, with explicit EPSG codes at every step so the surface stays auditable. It sits under the [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) terrain layer, and assumes you already have a classified cloud rather than raw returns.

## Prerequisites

You need a working Python spatial stack and a classified point cloud as input. Pin these versions so PROJ pipelines and the GDAL writer behave consistently across machines:

- **Packages:** `rasterio>=1.3` (ships GDAL 3.6+, COG driver, vertical CRS support), `pdal>=2.5` with the Python bindings, `numpy>=1.24`, `scipy>=1.10` (for `griddata` and `cKDTree`), and `pyproj>=3.5` for datum checks. Install via `conda install -c conda-forge pdal python-pdal rasterio scipy` so GDAL and PROJ are a single matched build.
- **Input data:** Ground-classified airborne LiDAR in `LAS`/`LAZ` (ASPRS class 2 for bare earth, classes 3–6 for vegetation and buildings), or a photogrammetric dense cloud. If your returns are unclassified, run a ground filter first — the [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) guide covers `SMRF` and `CSF`.
- **CRS, stated explicitly:** A projected horizontal CRS in metres — for example EPSG:32618 (UTM zone 18N) or EPSG:6539 (NY State Plane Long Island, metres) — paired with an orthometric vertical CRS such as EPSG:5703 (NAVD88 height). Combine them into a compound EPSG:32618+5703 so one identifier carries both. Never rasterize a geographic cloud (EPSG:4326): the cell size would be in degrees and the surface anisotropic.
- **Reference data:** A handful of surveyed control points (known easting/northing/orthometric height in the same compound CRS) for vertical validation, and tile-boundary polygons if you process by tile.

## Concept

A point cloud stores elevation at scattered XY locations; a DEM stores it on a regular grid. The three products differ only in which returns you keep before gridding. A **DTM** (Digital Terrain Model) uses bare-earth returns only (class 2) and represents the ground beneath vegetation and buildings. A **DSM** (Digital Surface Model) keeps the first/highest return at each location, so it follows rooftops and canopy. **DEM** is the generic word for a rasterized elevation grid and is whichever of the two your filtering produced — so always say which.

<figure class="diagram">
<svg viewBox="6 26 628 228" role="img" aria-labelledby="dem-xsec-t dem-xsec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-xsec-t">DTM versus DSM cross-section</title>
  <desc id="dem-xsec-d">A side view of terrain with a building and a tree: the DSM line follows the tops of the building and canopy while the DTM line follows the bare ground beneath them.</desc>
  <rect class="svg-bg" x="6" y="26" width="628" height="228" fill="#ffffff"/>
  <defs>
    <marker id="dem-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="40" width="600" height="200" rx="8" fill="#ffffff" stroke="#e6e0d4" stroke-width="2"/>
  <path d="M40 200 Q140 190 200 195 L200 120 L300 120 L300 195 Q380 198 430 196" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="200" y="120" width="100" height="75" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M430 196 Q470 150 500 110 Q530 150 560 196 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M40 200 Q140 190 200 195 Q300 200 300 195 Q380 198 430 196 Q500 200 600 198" fill="none" stroke="#1f6b8a" stroke-width="3" stroke-dasharray="6 4"/>
  <path d="M40 200 Q140 190 200 195 L200 120 L300 120 L300 195 Q380 198 430 196 Q500 200 500 110 Q500 200 600 198" fill="none" stroke="#c46a3d" stroke-width="3"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#dem-arrow)">
    <line x1="120" y1="70" x2="120" y2="186"/>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="250" y="165">building</text>
    <text x="500" y="175">tree</text>
    <text x="120" y="62">surface vs ground</text>
  </g>
  <g font-size="14" text-anchor="start">
    <text x="40" y="232" fill="#9a4f26">DSM — top of features</text>
    <text x="360" y="232" fill="#1f6b8a">DTM — bare earth</text>
  </g>
</svg>
<figcaption>Same scene, two surfaces: the DSM tracks rooftops and canopy; the DTM is the bare-earth ground the building and tree sit on.</figcaption>
</figure>

Rasterization assigns each return to the grid cell that contains it and reduces the cell to one value (min, max, mean, or IDW of the points inside). The reducer encodes intent: `min` over all returns approximates bare earth where you have no classification, `max` builds a DSM, and `idw` over class 2 returns gives a smooth DTM that respects every nearby ground point rather than just the one that happens to land in the cell. Cells with no points become voids and must be interpolated separately. Resolution is the load-bearing decision: pick the smallest feature the twin must resolve, not the sensor density. A 0.5 m cell suits urban drainage; a 5 m cell suits regional hydrology. As a rule of thumb keep cell size near the mean point spacing — gridding 4 pts/m² data at 0.25 m leaves most cells empty and forces heavy interpolation, while gridding it at 2 m averages away the curbs and channels a drainage model needs.

The vertical reference is as much a part of the product as the heights themselves. A raster of float values means nothing until you know whether 14.62 is metres above the NAVD88 geoid (EPSG:5703) or the WGS84 ellipsoid — the two differ by the geoid undulation, which is roughly −34 m around New York. Carry the vertical CRS in a compound code and in the raster tags from the first write, not as an afterthought at export.

## Step-by-Step Workflow

### 1. Inspect and validate the input cloud

Read the header before trusting anything. Confirm the cloud carries class 2 returns, sits in a projected CRS, and reports a sane bounding box and point spacing. PDAL's `info` is callable from Python:

```python
import pdal
import json

LAS = "tile_18N.laz"
p = pdal.Pipeline(json.dumps([{"type": "readers.las", "filename": LAS}]))
p.execute()
meta = p.metadata["metadata"]["readers.las"]

print("declared horizontal CRS:", meta["srs"].get("horizontal", "")[:60])
print("point count:", meta["count"])
area = (meta["maxx"] - meta["minx"]) * (meta["maxy"] - meta["miny"])
print(f"mean density: {meta['count'] / area:.2f} pts/m^2")
assert meta["srs"]["horizontal"], "cloud has no horizontal CRS — assign EPSG:32618 before gridding"
```

If the header lacks a CRS, assign it explicitly (`filters.reprojection` with `in_srs`/`out_srs`) before going further — gridding an unreferenced cloud bakes in a silent error.

### 2. Rasterize ground returns into a DTM with the GDAL writer

PDAL's `writers.gdal` grids points directly to GeoTIFF. Filter to class 2, set `output_type` to `idw` for a smooth bare-earth surface, and state the resolution and CRS explicitly. The `window_size` lets the writer fill small gaps by radial search during the same pass:

```python
import pdal
import json

DTM = "dtm_18N_0p5m.tif"
RES = 0.5  # metres per cell — matches ~4 pts/m^2 input

pipeline = pdal.Pipeline(json.dumps([
    {"type": "readers.las", "filename": "tile_18N.laz"},
    {"type": "filters.range", "limits": "Classification[2:2]"},  # bare earth only
    {
        "type": "writers.gdal",
        "filename": DTM,
        "resolution": RES,
        "output_type": "idw",
        "window_size": 6,          # search radius (cells) to seed small voids
        "nodata": -9999.0,
        "gdaldriver": "GTiff",
        "data_type": "float32",
        "override_srs": "EPSG:32618+5703",  # horizontal + NAVD88 vertical
    },
]))
pipeline.execute()
```

For a DSM, swap the range filter for `output_type: "max"` over all returns (or first returns via `filters.range` on `ReturnNumber[1:1]`) instead of restricting to class 2. The `override_srs` is doing real work here: it stamps the compound EPSG:32618+5703 into the GeoTIFF so every consumer reads both the horizontal grid and the NAVD88 vertical reference from the header, with no out-of-band agreement. If your cloud's declared CRS is already correct and complete, use `default_srs` instead so the writer only fills it in when missing rather than forcing it. Either way, open the result once and confirm `rasterio` reports the vertical component — a surprising number of pipelines drop it silently and you only notice when a flood depth comes out 34 m wrong.

`writers.gdal` chooses each cell's value independently, so a single high return that slipped through classification — a low-flying bird marked class 2, a fence post — becomes a one-cell spike in the DTM. Before void-filling, it is worth a fast despike pass: compare each cell to the median of its 3×3 neighbourhood with `scipy.ndimage.median_filter` and replace cells that deviate by more than a metre. Do this on the gridded surface rather than the cloud so it is cheap and idempotent.

### 3. Fill remaining voids by interpolation

`window_size` only reaches small gaps. Larger voids — under water, in occlusion shadows, beyond the cloud edge — stay no-data. Read the raster, interpolate the holes with `scipy.griddata` (linear TIN-style by default; switch to `cubic` for smoother terrain or IDW via `cKDTree` for control over decay), and write back. Keep the transform and CRS untouched:

```python
import numpy as np
import rasterio
from scipy.interpolate import griddata

with rasterio.open("dtm_18N_0p5m.tif") as src:
    dem = src.read(1).astype("float32")
    profile = src.profile
    nodata = src.nodata

mask = dem != nodata
if (~mask).any():
    rows, cols = np.indices(dem.shape)
    known_xy = np.column_stack([rows[mask], cols[mask]])
    known_z = dem[mask]
    hole_xy = np.column_stack([rows[~mask], cols[~mask]])
    # linear handles the interior; nearest backfills the convex-hull exterior
    filled = griddata(known_xy, known_z, hole_xy, method="linear")
    nn = griddata(known_xy, known_z, hole_xy, method="nearest")
    filled = np.where(np.isnan(filled), nn, filled)
    dem[~mask] = filled

profile.update(dtype="float32", compress="deflate", tiled=True,
               blockxsize=256, blockysize=256)
with rasterio.open("dtm_18N_filled.tif", "w", **profile) as dst:
    dst.write(dem, 1)
```

Flag holes wider than your interpolation tolerance (say, voids spanning more than `window_size * 4` cells) rather than filling them blindly — a 40 m interpolated patch under a river is a fiction the flood model will trust. The two-pass structure above is deliberate: `method="linear"` interpolates cleanly inside the convex hull of known cells but returns `NaN` outside it, so the `nearest` pass exists only to backfill the raster's exterior margins. If you let `nearest` fill interior holes too, you get blocky plateaus where a void should have sloped; reserve it strictly for the hull exterior, and consider masking that exterior back to no-data entirely if those cells fall outside your real survey footprint. Where terrain is smooth and you want continuous curvature across filled gaps, `method="cubic"` reads better at the cost of occasional overshoot near steep breaklines — never use it across a cliff edge.

<figure class="diagram">
<svg viewBox="6 -3 758 268" role="img" aria-labelledby="dem-void-t dem-void-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-void-t">How three interpolators fill the same void</title>
  <desc id="dem-void-d">The same terrain profile with the same gap, filled three ways. A triangulated irregular network draws a straight line across the void. Inverse distance weighting sags toward the local mean and flattens the middle. Kriging follows the modelled trend and continues the slope through the gap.</desc>
  <rect class="svg-bg" x="6" y="-3" width="758" height="268" fill="#ffffff"/>
  <text x="385" y="26" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">One void, three fills — and only the measured ends are data</text>
  <g fill="none" stroke="#e6e0d4" stroke-width="2">
    <path d="M20 40 H250 V190 H20 Z"/>
    <path d="M270 40 H500 V190 H270 Z"/>
    <path d="M520 40 H750 V190 H520 Z"/>
  </g>
  <g fill="none" stroke="#e6e0d4" stroke-width="1.5" stroke-dasharray="4 4">
    <path d="M95 112 V178 M175 112 V178"/>
    <path d="M345 112 V178 M425 112 V178"/>
    <path d="M595 112 V178 M675 112 V178"/>
  </g>
  <g fill="none" stroke="#4f7a4d" stroke-width="2.5">
    <path d="M35 150 L95 138"/><path d="M175 128 L235 120"/>
    <path d="M285 150 L345 138"/><path d="M425 128 L485 120"/>
    <path d="M535 150 L595 138"/><path d="M675 128 L735 120"/>
  </g>
  <g fill="none" stroke="#c46a3d" stroke-width="2.5" stroke-dasharray="6 4">
    <path d="M95 138 L175 128"/>
    <path d="M345 138 C 372 148 398 148 425 128"/>
    <path d="M595 138 C 620 133 650 130 675 128"/>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="135" y="106">void</text>
    <text x="385" y="106">void</text>
    <text x="635" y="106">void</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="212"><tspan x="135" dy="0" font-weight="600">TIN</tspan><tspan x="135" dy="17">a straight line between the edges</tspan></text>
    <text x="385" y="212"><tspan x="385" dy="0" font-weight="600">IDW</tspan><tspan x="385" dy="17">sags toward the local mean</tspan></text>
    <text x="635" y="212"><tspan x="635" dy="0" font-weight="600">Kriging</tspan><tspan x="635" dy="17">continues the modelled trend</tspan></text>
  </g>
  <text x="385" y="246" fill="#5b6471" font-size="12" text-anchor="middle">Whichever you pick, the filled span is inference — ship a mask band so a consumer can tell it from measurement</text>
</svg>
<figcaption>The three fills disagree most where the void is widest, which is exactly where a hydrological model is most sensitive to them.</figcaption>
</figure>

### 4. Hydro-flatten water bodies

Lakes and wide rivers should read as flat (or monotonically downhill for rivers). Burn a constant pool elevation into each waterbody polygon using `rasterio.features.rasterize`. The polygons come from a hydrography layer reprojected into the same EPSG:32618:

```python
import numpy as np
import rasterio
from rasterio.features import rasterize
import geopandas as gpd

with rasterio.open("dtm_18N_filled.tif") as src:
    dem = src.read(1)
    profile = src.profile
    transform = src.transform

water = gpd.read_file("hydro.gpkg").to_crs("EPSG:32618")

for _, poly in water.iterrows():
    poolmask = rasterize(
        [(poly.geometry, 1)], out_shape=dem.shape, transform=transform,
        fill=0, dtype="uint8",
    ).astype(bool)
    if poolmask.any():
        # flatten to the 10th-percentile shoreline elevation (avoids spikes)
        pool_z = np.percentile(dem[poolmask], 10)
        dem[poolmask] = pool_z

with rasterio.open("dtm_18N_hydroflat.tif", "w", **profile) as dst:
    dst.write(dem, 1)
```

For drainage-correct surfaces, follow flattening with a sink-fill (Wang & Liu via `richdem.FillDepressions`) so flow routing has no spurious internal basins. The 10th-percentile pool elevation is a guard against two common errors: taking the mean drags the pool surface upward wherever the polygon overstreams onto the bank, and taking the minimum can latch onto a stray deep-water spike. For rivers, flattening to a single elevation is wrong — water flows downhill — so split the river polygon into reaches and enforce a monotonically decreasing pool level per reach, or burn a smoothed channel centreline gradient. Bridges and overpasses deserve special handling too: a DTM should carry the ground *under* the deck, so the deck returns must already be classified out (class 17 in ASPRS) before you grid, or the surface will show a phantom dam across the valley.

### 5. Edge-match adjacent tiles

When you grid by tile, neighbouring tiles must share identical elevations along the shared edge or 3D engines render visible cracks. The fix is to grid with an overlap buffer and average the overlap. Read both tiles, blend the shared column, and write the seam back:

```python
import numpy as np
import rasterio

with rasterio.open("dtm_tileA.tif") as a, rasterio.open("dtm_tileB.tif") as b:
    arr_a, arr_b = a.read(1), b.read(1)
    prof_a, prof_b = a.profile, b.profile

# tileB is the eastern neighbour; average the last/first overlap column pair
seam_a = arr_a[:, -1]
seam_b = arr_b[:, 0]
blend = np.where((seam_a != prof_a["nodata"]) & (seam_b != prof_b["nodata"]),
                 (seam_a + seam_b) / 2.0, seam_a)
arr_a[:, -1] = blend
arr_b[:, 0] = blend

for path, arr, prof in [("dtm_tileA.tif", arr_a, prof_a), ("dtm_tileB.tif", arr_b, prof_b)]:
    with rasterio.open(path, "w", **prof) as dst:
        dst.write(arr, 1)
```

The durable fix is to grid every tile from a cloud clipped with a one-tile-width buffer, then crop to the nominal extent after filling — that way interpolation near the edge sees real neighbouring points, not a hard boundary.

<figure class="diagram">
<svg viewBox="16 6 731 264" role="img" aria-labelledby="dem-seam-t dem-seam-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dem-seam-t">Interpolating tile by tile builds a ridge at every boundary</title>
  <desc id="dem-seam-d">On the left, two tiles are interpolated in isolation, so neither has data past its own edge and the profile across their shared boundary shows a ridge. On the right, both tiles are interpolated with a shared overlap buffer, so each has real points beyond its edge and the profile crosses the boundary smoothly.</desc>
  <rect class="svg-bg" x="16" y="6" width="731" height="264" fill="#ffffff"/>
  <g fill="none" stroke="#5b6471" stroke-width="2">
    <path d="M30 46 H190 V166 H30 Z"/><path d="M190 46 H350 V166 H190 Z"/>
    <path d="M410 46 H570 V166 H410 Z"/><path d="M570 46 H730 V166 H570 Z"/>
  </g>
  <path d="M540 46 H600 V166 H540 Z" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M190 46 V166" fill="none" stroke="#b0413e" stroke-width="3.5"/>
  <path d="M570 46 V166" fill="none" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M30 226 L150 220 L190 202 L230 220 L350 214" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <path d="M410 226 L530 220 L570 218 L610 220 L730 214" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="34">each tile interpolated alone</text>
    <text x="570" y="34">shared overlap buffer on both tiles</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="190" y="186">profile across the boundary</text>
    <text x="570" y="186">profile across the boundary</text>
  </g>
  <text x="190" y="252" fill="#b0413e" font-size="12" text-anchor="middle">a permanent ridge in every derived hillshade</text>
  <text x="570" y="252" fill="#4f7a4d" font-size="12" text-anchor="middle">continuous — the buffer supplies the missing neighbours</text>
</svg>
<figcaption>The ridge is not a rendering artefact. Each tile's edge cells were interpolated from one side only, so both surfaces bend upward as they run out of neighbours.</figcaption>
</figure>

## Validation & Verification

A DEM is only trustworthy once it is checked against independent data. Run three assertions before promoting the surface.

First, **vertical accuracy** against control. Sample the raster at each control point and compute RMSE; airborne LiDAR DTMs should land near 0.1–0.2 m RMSE in open terrain:

```python
import numpy as np
import rasterio

control = [  # easting, northing (EPSG:32618), orthometric h (EPSG:5703)
    (583120.4, 4507880.1, 14.62),
    (583402.9, 4508110.7, 11.08),
]
with rasterio.open("dtm_18N_hydroflat.tif") as src:
    sampled = np.array([v[0] for v in src.sample([(e, n) for e, n, _ in control])])
truth = np.array([z for *_, z in control])
rmse = np.sqrt(np.mean((sampled - truth) ** 2))
print(f"vertical RMSE: {rmse:.3f} m")
assert rmse < 0.30, "vertical accuracy outside spec — check geoid/datum"
```

Second, **no-data integrity**: after filling, no interior cell should remain no-data, and the filled fraction should be small. Assert `(dem == nodata).mean() < 0.001` and log the figure. A high fill fraction means the cloud was too sparse for the chosen resolution — coarsen the cell size rather than interpolate a guess.

Third, **derivative sanity**: compute slope with `numpy.gradient` and check the distribution. Slopes pinned at exactly 0 over large areas signal over-flattening; slopes above ~80° outside cliffs signal classification bleed or interpolation spikes. Render a hillshade at two azimuths and eyeball for terracing and striping, which assertions miss.

## Performance & Scale

Whole-county clouds do not fit in memory, so process by tile and stream. PDAL's `writers.gdal` already streams points, so step 2 scales to large `.laz` without loading the cloud — keep tiles at roughly 1 km² (a 0.5 m grid is then 2000×2000 cells, ~16 MB as float32). The memory-heavy step is `griddata` in step 3: it builds a Delaunay triangulation over every known cell, which is O(n log n) in points and can blow past RAM on a full tile of mostly-valid data.

Three levers keep it bounded. Chunk the fill with `rasterio.windows` so you interpolate one block at a time, padding each window by `window_size` cells so holes near block edges see neighbours. Use `numpy.memmap` or read windows lazily rather than loading the full array. And cap the interpolation neighbourhood — replacing global `griddata` with a `scipy.spatial.cKDTree` IDW over the nearest 8–12 known cells turns the fill from a global solve into a local one and parallelizes cleanly across tiles with `multiprocessing` or `dask`. Benchmark on one representative tile first: if the fill dominates wall-clock, the KD-tree IDW path is usually 5–10× faster than `griddata` for sparse voids. Write final tiles as Cloud Optimized GeoTIFF (`driver="COG"` in `rasterio>=1.3`) with internal overviews so web clients stream by resolution instead of pulling the whole raster.

## Failure Modes & Gotchas

- **Gridding an unclassified or geographic cloud.** Restrict to `Classification[2:2]` for a DTM and confirm the CRS is projected metres (EPSG:32618, not EPSG:4326) before `writers.gdal`. A degree-based `resolution` produces a stretched, unusable grid.
- **Silent vertical-datum mismatch.** If the cloud is on ellipsoidal heights but you label the output NAVD88 (EPSG:5703), every elevation is off by the geoid undulation (tens of metres). Apply the geoid as an explicit `pyproj` vertical transform; never subtract a constant. Store the geoid model name (`GEOID18`) in the raster tags.
- **Voids filled past the data.** `griddata` with `method="nearest"` happily extrapolates beyond the cloud's convex hull, inventing terrain. Mask the exterior to no-data after filling, and flag large interior voids instead of trusting them.
- **Hydro-flattening to the wrong pool level.** Using the mean elevation inside a waterbody polygon drags the pool up where the polygon overlaps bank. Flatten to a low percentile of the in-polygon elevations, and clip the polygon to the wetted channel.
- **Tile seams from independent gridding.** Tiles gridded with no overlap and filled independently rarely match at the edge. Grid with a buffer, fill, then crop — or at minimum average the shared seam as in step 5.

## Frequently Asked Questions

### Should I build a DTM or a DSM for my twin?
It depends on the analysis. Flood, drainage, and earthwork models need bare earth, so build a DTM from class 2 returns. Solar, line-of-sight, viewshed, and urban-heat models need the top of features, so build a DSM from first/highest returns. Many twins keep both, derived from the same cloud, and pick per query. State which one a given raster is in its metadata so a flood model never silently runs on a DSM and dams itself behind buildings.

### Which interpolation method should I use to fill voids — TIN, IDW, or kriging?
For most production DTMs, linear interpolation over a Delaunay triangulation (TIN, the default in `scipy.griddata`) is the right default: it preserves breaklines and is fast. IDW (via `cKDTree`) gives you explicit control over the decay exponent and a bounded neighbourhood, which matters for performance on big tiles. Kriging is statistically optimal and gives an error surface, but it is far slower and rarely justified unless you need the uncertainty estimate. Reserve it for sparse data where quantified confidence is a deliverable.

### What cell size should I choose?
Drive it from the smallest feature the twin must resolve and keep it near the mean point spacing. Open the cloud, compute density (points ÷ area), and set cell size to roughly the inverse square root of density — about 0.5 m for 4 pts/m². Gridding finer than the data supports just multiplies interpolation; gridding coarser throws away resolution you paid to capture. The [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) guide maps densities to achievable resolutions.

### How do I handle the vertical datum and geoid correctly?
Declare the vertical CRS explicitly in a compound code (EPSG:32618+5703 for UTM 18N + NAVD88). If your source heights are GNSS-ellipsoidal, transform them to orthometric with `pyproj` using the correct geoid grid (`GEOID18`, `EGM2008`) — a real grid-shift, not a constant. Keep the geoid model named in the raster tags so the surface can be re-derived when a national geoid is updated. The [coordinate reference systems guide](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) covers the transformation mechanics, including [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/).

### Why do adjacent tiles show cracks in the 3D engine?
The tiles do not share identical elevations along their common edge, usually because each was gridded and interpolated in isolation. Grid each tile from a cloud clipped with a one-tile-width buffer so edge cells see real neighbouring points, fill, then crop to the nominal extent — or average the shared seam column as a patch. Aligning tile boundaries to a fixed grid origin and a power-of-two cell count also keeps LOD transitions seamless downstream.

## Related Guides

- [Resampling DEMs Without Stair-Step Artifacts](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/resampling-dems-without-stair-step-artifacts/) — resample elevation rasters with rasterio without terraces or blocks
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — vertical datum and geoid handling for the heights in your DEM
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — pick a cell size the cloud can actually support
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — ground-classify raw returns before rasterizing
- [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — exporting terrain as COG, glTF, or 3D Tiles for delivery
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — streaming the finished terrain at multiple resolutions

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
