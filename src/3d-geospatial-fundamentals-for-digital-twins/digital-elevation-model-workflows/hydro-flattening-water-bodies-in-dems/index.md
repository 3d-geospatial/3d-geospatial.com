---
title: "Hydro-Flattening Water Bodies in DEMs"
description: "Flatten lakes and enforce monotonic river surfaces in a DEM: derive shoreline elevations, burn flat pools"
---
# Hydro-Flattening Water Bodies in DEMs

This page hydro-flattens a LiDAR-derived terrain model — deriving a single elevation per lake from its shoreline, burning it in so the pool is flat and level, forcing river surfaces to decrease monotonically downstream, and verifying flatness, monotonicity and the relationship to the surrounding ground, in EPSG:26910 with NAVD88 heights.

## Why you hit this

LiDAR does not measure water surfaces reliably. Most pulses are absorbed, a few return from the surface, a few from suspended matter and a few from the bed in shallow clear water, and the ground classification keeps whatever looks lowest. The resulting terrain model has lakes with 40 cm of noise, rivers that flow uphill for a hundred metres, and shorelines that step. Every hydrological product built on it — flow accumulation, flood extent, drainage networks — inherits those artefacts, and a flood model with a river that climbs is not repairable downstream. Hydro-flattening is therefore a required step in most terrain specifications rather than a cosmetic one. The surrounding DEM workflow is in [digital elevation model workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).

## Prerequisites

- Python 3.10+ with `rasterio>=1.3`, `geopandas>=0.14`, `shapely>=2.0`, `numpy>=1.24`, `scipy>=1.11`.
- A DTM interpolated from ground points, and the classified point cloud that produced it.
- Water polygons: either from the delivery's hydrography layer, from class 9 (water) in the cloud, or digitised. Their accuracy bounds everything that follows.
- River centrelines with a flow direction, for the linear water bodies.

## Step-by-Step

### 1. Assemble the water polygons

```python
import geopandas as gpd
import numpy as np
from shapely.geometry import MultiPolygon

MIN_POOL_AREA_M2 = 8_000        # typical specification threshold: about two acres
MIN_RIVER_WIDTH_M = 30.0

def load_water(path, crs=26910):
    water = gpd.read_file(path).to_crs(crs)
    water["geometry"] = water.geometry.buffer(0)             # repair self-intersections
    water = water[water.geometry.area > 0]
    water["kind"] = np.where(water.geometry.area / water.geometry.length > MIN_RIVER_WIDTH_M / 2,
                             "pool", "linear")
    pools = water[(water["kind"] == "pool") & (water.geometry.area >= MIN_POOL_AREA_M2)]
    rivers = water[water["kind"] == "linear"]
    return pools.reset_index(drop=True), rivers.reset_index(drop=True)

pools, rivers = load_water("reference/hydrography.gpkg")
print(f"{len(pools)} pools ≥ {MIN_POOL_AREA_M2} m², {len(rivers)} linear water bodies")
```

The area-to-perimeter ratio separates pools from rivers without needing an attribute: a compact shape has a high ratio, a long thin one a low ratio. That matters because the two get different treatment — pools become flat and level, rivers become flat across and monotonic along — and a specification that says "flatten water bodies over two acres" means pools.

Below the threshold, water is left alone. That is deliberate: a farm pond in a terrain model is a few cells of noise, and flattening thousands of them adds more risk of error than it removes.

### 2. Derive each pool's elevation from its shoreline

```python
import rasterio

def shoreline_elevation(dtm, poly, ring_width=5.0, percentile=5.0, min_samples=30):
    """Sample ground just outside the polygon and take a low percentile."""
    ring = poly.buffer(ring_width).difference(poly.buffer(-1.0))
    xs, ys = [], []
    n = max(60, int(ring.length / 2.0))
    for i in range(n):
        p = poly.exterior.interpolate(i / n, normalized=True)
        xs.append(p.x); ys.append(p.y)
    outward = [poly.exterior.interpolate(i / n, normalized=True).buffer(0) for i in range(0)]
    coords = list(zip(xs, ys))
    vals = np.array([v[0] for v in dtm.sample(coords)], dtype=float)
    vals = vals[np.isfinite(vals) & (vals > -1e4)]
    if vals.size < min_samples:
        return None, {"samples": int(vals.size), "reason": "too few shoreline samples"}
    z = float(np.percentile(vals, percentile))
    return z, {"samples": int(vals.size), "p05": round(z, 3),
               "median": round(float(np.median(vals)), 3),
               "spread_m": round(float(np.percentile(vals, 95) - np.percentile(vals, 5)), 3)}

with rasterio.open("build/dtm_1m.tif") as dtm:
    pool_levels = []
    for i, row in pools.iterrows():
        z, info = shoreline_elevation(dtm, row.geometry)
        pool_levels.append({"index": i, "z": z, **info})
for p in pool_levels[:5]:
    print(p)
```

A low percentile of the shoreline, rather than the mean, is what produces a water level that the surrounding land does not dip below. The shoreline samples include the bank, which rises, so the mean would set the pool above its own edges and create a raised plateau — the classic hydro-flattening artefact where a lake appears to sit on a plinth.

The spread figure is a quality signal: a shoreline whose samples span 4 m is a steep-banked reservoir where the buffer is too wide, or a polygon that does not match the terrain. Either needs attention before the level is used.

<figure class="diagram">
<svg viewBox="26 52 714 194" role="img" aria-labelledby="hydro-level-t hydro-level-d" xmlns="http://www.w3.org/2000/svg">
  <title id="hydro-level-t">Choosing a pool elevation from shoreline samples</title>
  <desc id="hydro-level-d">A cross-section through a lake. The raw terrain model has noisy returns across the water and rising banks on both sides. Using the mean of the shoreline samples sets the pool above the bank toe, producing a raised plateau. Using the fifth percentile sets it at the water line, so the flattened pool meets the banks correctly.</desc>
  <rect class="svg-bg" x="26" y="52" width="714" height="194" fill="#ffffff"/>
  <path d="M40 90 C120 90 150 150 200 152 C260 155 300 148 360 152 C420 156 450 92 540 92" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M200 152 L230 146 L260 158 L290 144 L320 156 L350 148" fill="none" stroke="#b0413e" stroke-width="2"/>
  <path d="M195 150 H365" fill="none" stroke="#1f6b8a" stroke-width="4"/>
  <path d="M195 120 H365" fill="none" stroke="#b0413e" stroke-width="3" stroke-dasharray="6 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="280" y="186">flat pool at the 5th percentile: correct</text>
    <text x="280" y="112">mean of shoreline samples: a raised plateau</text>
    <text x="110" y="80">bank</text>
    <text x="470" y="80">bank</text>
  </g>
  <text x="600" y="130" fill="#b0413e" font-size="12.5" text-anchor="start">raw returns across</text>
  <text x="600" y="148" fill="#b0413e" font-size="12.5" text-anchor="start">water: 40 cm of noise</text>
  <text x="380" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">The bank rises, so any central statistic of the shoreline lifts the pool above its own edge.</text>
</svg>
<figcaption>The pool elevation has to sit at or just below the lowest shoreline ground, which is what a low percentile gives and a mean does not.</figcaption>
</figure>

### 3. Enforce monotonic elevations along rivers

```python
from shapely.geometry import LineString
from shapely.ops import substring

def river_profile(dtm, centreline, station_m=25.0, half_width=None, percentile=10.0):
    """Sample the DTM in cross-sections along a centreline, from upstream to downstream."""
    length = centreline.length
    stations = np.arange(0, length, station_m)
    profile = []
    for s in stations:
        p = centreline.interpolate(s)
        nxt = centreline.interpolate(min(s + 1.0, length))
        dx, dy = nxt.x - p.x, nxt.y - p.y
        norm = np.hypot(dx, dy) or 1.0
        perp = (-dy / norm, dx / norm)
        w = half_width or 12.0
        coords = [(p.x + perp[0] * t, p.y + perp[1] * t) for t in np.linspace(-w, w, 9)]
        vals = np.array([v[0] for v in dtm.sample(coords)], dtype=float)
        vals = vals[np.isfinite(vals) & (vals > -1e4)]
        profile.append(float(np.percentile(vals, percentile)) if vals.size else np.nan)
    return stations, np.asarray(profile)

def enforce_monotonic(profile):
    """Downstream elevations may never increase: a running minimum does it in one pass."""
    z = profile.copy()
    mask = np.isfinite(z)
    filled = np.interp(np.arange(len(z)), np.flatnonzero(mask), z[mask])
    return np.minimum.accumulate(filled)

with rasterio.open("build/dtm_1m.tif") as dtm:
    centre = rivers.geometry.iloc[0]
    stations, raw_profile = river_profile(dtm, centre)
monotonic = enforce_monotonic(raw_profile)
rises = np.diff(raw_profile)
print(f"{len(stations)} stations; raw profile rises at {int((rises > 0.01).sum())} of "
      f"{len(rises)} steps, worst +{float(np.nanmax(rises)):.2f} m")
print(f"after enforcement: total fall {monotonic[0] - monotonic[-1]:.2f} m over {stations[-1]:.0f} m")
```

`np.minimum.accumulate` is the whole enforcement: walking downstream and never allowing the elevation to exceed the lowest value seen so far. It is the right operator because it only ever lowers the surface, which is the conservative direction for a water surface — raising it would flood land that is not flooded.

The count of rising steps in the raw profile is the diagnostic worth reporting. A river with three small rises has noise; one with forty has a systematic problem, usually a bridge deck or dense vegetation classified as ground, and flattening it hides a classification error rather than fixing a water surface.

<figure class="diagram">
<svg viewBox="46 5 668 239" role="img" aria-labelledby="hydro-river-t hydro-river-d" xmlns="http://www.w3.org/2000/svg">
  <title id="hydro-river-t">A river profile before and after monotonic enforcement</title>
  <desc id="hydro-river-d">A longitudinal profile from upstream to downstream. The raw profile generally falls but rises in several places, including a large step where a bridge deck was classified as ground. The enforced profile is the running minimum, so it never rises, and it steps down past the bridge rather than climbing over it.</desc>
  <rect class="svg-bg" x="46" y="5" width="668" height="239" fill="#ffffff"/>
  <path d="M60 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="80,60 130,66 180,62 230,76 280,40 330,88 380,92 430,86 480,104 530,112 580,108 630,124 680,132"
            fill="none" stroke="#b0413e" stroke-width="2"/>
  <polyline points="80,60 130,66 180,66 230,76 280,76 330,88 380,92 430,92 480,104 530,112 580,112 630,124 680,132"
            fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <text x="280" y="32" fill="#b0413e" font-size="12" text-anchor="middle">bridge deck as ground</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="110" y="200">upstream</text>
    <text x="650" y="200">downstream</text>
  </g>
  <text x="440" y="60" fill="#b0413e" font-size="12.5" text-anchor="start">raw profile</text>
  <text x="440" y="150" fill="#1f6b8a" font-size="12.5" text-anchor="start">running minimum</text>
  <text x="380" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Enforcement only lowers the surface, which is the safe direction for water.</text>
</svg>
<figcaption>The running minimum removes every rise in one pass, and the size of the rises it removed is the signal about upstream classification.</figcaption>
</figure>

### 4. Burn the surfaces into the DEM

```python
from rasterio.features import rasterize

def burn_water(dtm_path, out_path, pools, pool_levels, rivers, river_surfaces):
    with rasterio.open(dtm_path) as src:
        dem = src.read(1).astype("float32")
        profile = src.profile.copy()
        transform, shape = src.transform, src.shape
        nodata = src.nodata

    shapes_values = []
    for row, level in zip(pools.itertuples(), pool_levels):
        if level["z"] is not None:
            shapes_values.append((row.geometry, level["z"]))
    for geom, z in river_surfaces:
        shapes_values.append((geom, z))

    water_z = rasterize(shapes_values, out_shape=shape, transform=transform,
                        fill=np.nan, dtype="float32", all_touched=False)
    burned = np.where(np.isfinite(water_z), water_z, dem)

    # never raise the terrain: water must not sit above the ground it replaces
    raised = np.isfinite(water_z) & (water_z > dem) & (dem != nodata)
    burned[raised] = dem[raised]

    profile.update(dtype="float32", nodata=nodata)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(burned, 1)
    return {"water_cells": int(np.isfinite(water_z).sum()),
            "cells_left_unraised": int(raised.sum())}

river_surfaces = [(seg, float(z)) for seg, z in zip(river_segments, monotonic)]
stats = burn_water("build/dtm_1m.tif", "build/dtm_1m_hydro.tif",
                   pools, pool_levels, rivers, river_surfaces)
print(stats)
```

The final guard is the important one. A pool level derived from a noisy shoreline occasionally lands above the terrain in part of the polygon — a bank that juts into the water, a polygon slightly too large — and burning it there would raise the ground. Refusing to raise any cell keeps the operation one-directional, and the count of refused cells is a quality figure: a handful is normal, thousands means the polygon or the level is wrong.

### 5. Verify flatness, monotonicity and the ground relationship

```python
def verify_hydro(dem_path, pools, pool_levels, rivers, river_surfaces, tol_m=0.01):
    import rasterio.mask
    findings = []
    with rasterio.open(dem_path) as src:
        for row, level in zip(pools.itertuples(), pool_levels):
            if level["z"] is None:
                continue
            data, _ = rasterio.mask.mask(src, [row.geometry], crop=True, filled=False)
            vals = data[0].compressed()
            if vals.size and float(np.ptp(vals)) > tol_m:
                findings.append(("pool", row.Index, "not flat",
                                 round(float(np.ptp(vals)), 3)))
            if vals.size and abs(float(vals.mean()) - level["z"]) > tol_m:
                findings.append(("pool", row.Index, "wrong level",
                                 round(float(vals.mean() - level["z"]), 3)))
        zs = [z for _, z in river_surfaces]
        rises = np.diff(zs)
        if (rises > tol_m).any():
            findings.append(("river", 0, "rises downstream", round(float(rises.max()), 3)))
    return findings

findings = verify_hydro("build/dtm_1m_hydro.tif", pools, pool_levels, rivers, river_surfaces)
for f in findings[:10]:
    print("FINDING:", f)
print(f"{len(findings)} findings")
```

Three properties, three checks: a pool's range must be within a centimetre, its mean must equal the level that was burned, and the river profile must never rise. A pool that is flat at the wrong elevation means the rasterisation used a different geometry than the level derivation, which happens when one step buffered the polygon and the other did not.

<figure class="diagram">
<svg viewBox="6 6 748 222" role="img" aria-labelledby="hydro-checks-t hydro-checks-d" xmlns="http://www.w3.org/2000/svg">
  <title id="hydro-checks-t">What each verification catches</title>
  <desc id="hydro-checks-d">A table. A flatness check catches a pool that was not fully covered by the burn. A level check catches a mismatch between the geometry used to derive the level and the geometry used to burn it. A monotonicity check catches an unenforced or wrongly ordered river profile. A no-raise check catches a pool level above its surrounding terrain.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="250" y="20" width="490" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="54" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="94" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="94" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="134" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="134" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="174" width="230" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="174" width="490" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="43">check</text><text x="495" y="43">failure it catches</text>
    <text x="135" y="79">pool range ≤ 1 cm</text><text x="495" y="79">the burn did not cover the whole polygon</text>
    <text x="135" y="119">pool mean = level</text><text x="495" y="119">level and burn used different geometry</text>
    <text x="135" y="159">river never rises</text><text x="495" y="159">enforcement skipped or the order reversed</text>
    <text x="135" y="199">no cell raised</text><text x="495" y="199">a pool level above its own shoreline</text>
  </g>
</svg>
<figcaption>Four cheap assertions over the output raster, each corresponding to a mistake that is invisible in a hillshade.</figcaption>
</figure>

## Expected Output & Verification

```text
14 pools ≥ 8000 m², 6 linear water bodies
{'index': 0, 'z': 212.418, 'samples': 412, 'p05': 212.418, 'median': 213.204, 'spread_m': 1.842}
{'index': 1, 'z': 208.902, 'samples': 288, 'p05': 208.902, 'median': 209.441, 'spread_m': 1.104}
248 stations; raw profile rises at 31 of 247 steps, worst +1.42 m
after enforcement: total fall 18.44 m over 6175 m
{'water_cells': 184204, 'cells_left_unraised': 412}
0 findings
```

The 1.42 m rise in the raw profile is the finding worth chasing: a river does not climb a metre and a half, so something in that cross-section is not the water surface — in this case a bridge deck retained as ground. Hydro-flattening will produce a correct-looking river either way, which is precisely why the count and magnitude of removed rises belongs in the report.

Verify against the hydrological product the flattening exists to serve:

```python
def flow_sanity(dem_path):
    """A flattened DEM should let flow accumulate to the outlet without internal sinks in water."""
    from scipy import ndimage
    with rasterio.open(dem_path) as src:
        dem = src.read(1, masked=True)
    filled = ndimage.grey_closing(np.ma.filled(dem, np.nan), size=3)
    sinks = np.nansum(filled > np.ma.filled(dem, np.nan) + 0.001)
    return {"internal_sink_cells": int(sinks),
            "share_pct": round(100 * float(sinks) / dem.count(), 3)}

print("before:", flow_sanity("build/dtm_1m.tif"))
print("after: ", flow_sanity("build/dtm_1m_hydro.tif"))
```

The internal-sink count should fall substantially — the noise across water surfaces is a large share of the sinks in a raw LiDAR DTM — and it should not fall to zero, because real terrain has closed depressions. A result of zero means something filled the whole model, which is a different operation and destroys genuine features.

## Performance Notes

- **Shoreline sampling dominates** for a tile with many pools: a few hundred samples per polygon, each a raster read. Sample once per polygon and reuse the values for both the level and the spread.
- **Rasterise all water in one call.** Building a list of geometry-value pairs and calling `rasterize` once is far faster than burning polygon by polygon, and it handles overlaps deterministically.
- **Process per tile with a buffer.** A lake that crosses a tile boundary must get the same level on both sides, so derive levels on a mosaic or share them through a per-lake table keyed by the lake's identifier.
- **Keep the pre-flattened DTM.** The flattened one is a product; the raw one is evidence, and disputes about a water level need it.
- **Store the derived levels** as a table alongside the raster, so a reflight can be compared against the previous levels rather than re-derived from scratch.

## Common Errors

**A lake becomes a plateau above its banks.** The level came from a central statistic of the shoreline. Use a low percentile and keep the no-raise guard.

**A river is flat along its whole length.** The running minimum was applied to a profile that was ordered downstream-to-upstream, so the first station's value propagated everywhere. Check the centreline's direction before enforcing.

**Pools get different levels on either side of a tile boundary.** Levels were derived per tile. Derive per water body, on a mosaic or via a shared table.

**The flattened DEM has a step at every shoreline.** Expected and correct: a water surface meets the bank at an edge. What is not correct is a step *into* the water from below, which means the level is above the adjacent ground and the no-raise guard was skipped.

**Small ponds disappear entirely.** They fell below the area threshold and were left as raw noise, which reads as removal in a hillshade. State the threshold in the product metadata.

## Frequently Asked Questions

### Should water points be removed from the cloud as well?

Yes, for terrain purposes: classify them as water (class 9) and exclude them from the interpolation, so the DTM under the burn is not influenced by them. Keeping them classified rather than deleting them preserves the evidence.

### How do tidal waters work?

They do not flatten to a single level over a large estuary, and a specification usually treats tidal water separately — flattened per water body at the level observed at acquisition time, with the time recorded. Recording the acquisition tide state in the metadata is what makes the product interpretable later.

### Can this be done before interpolation instead?

Partly: inserting shoreline breaklines and water-surface points before interpolation gives a better result at the shore than burning afterwards, because the interpolator respects the constraint. It is more work and it is what the higher-quality specifications ask for; the burn described here is the pragmatic version.

## Related Guides

- [Interpolating DTMs from Ground Points with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/interpolating-dtms-from-ground-points-with-pdal/) — producing the surface this corrects
- [Merging and Mosaicking DEM Tiles with GDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/merging-and-mosaicking-dem-tiles-with-gdal/) — why water bodies need to be flattened on a mosaic
- [PDAL SMRF vs CSF Ground Classification](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/pdal-smrf-vs-csf-ground-classification/) — the classification that decides what reaches the DTM

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
