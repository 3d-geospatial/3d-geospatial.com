---
title: "Merging and Mosaicking DEM Tiles with GDAL"
description: "Mosaic DEM tiles with gdalbuildvrt and gdalwarp without seams: matching CRS and nodata, choosing the overlap rule, feathering, and verifying the join numerically."
---
# Merging and Mosaicking DEM Tiles with GDAL

This page merges a set of delivered DEM tiles into one continuous surface with `gdalbuildvrt` and `gdalwarp`, and covers the four decisions that determine whether the result has visible seams: whether every input truly shares a CRS and a vertical datum, what the nodata value is, which tile wins where two overlap, and whether the join needs feathering. A mosaic is trivial to produce and easy to produce wrongly — the wrong version renders fine and puts a ridge through every derived hillshade.

## Why you hit this

Elevation arrives as tiles because that is how surveys are flown and delivered, and almost nothing downstream wants tiles. A terrain mesh, a flood model, a viewshed and a 3D Tiles terrain layer all want one surface. The merge itself is one command; what makes it a task rather than a step is that delivered tiles routinely disagree about the things a merge assumes they agree on. Two batches flown a year apart, or supplied by two contractors, will differ in nodata convention, in vertical datum, and sometimes in cell alignment — and `gdalbuildvrt` will happily combine all of it.

The datum half of that problem is covered in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/); what follows assumes it is settled and deals with the raster mechanics.

## Prerequisites

- GDAL 3.6+ on the path (`gdalinfo --version`), plus `rasterio>=1.3` and `numpy>=1.24` for the verification steps.
- DEM tiles in one directory, ideally GeoTIFF, with their CRS in the header rather than in a sidecar.
- A decision recorded somewhere about the target CRS, the target cell size and the nodata value. All three should come from the twin's manifest, not from whichever tile happens to be first.

## Step-by-Step

### 1. Audit the inputs before merging anything

The merge cannot tell you that two tiles disagree, so ask first. Three properties matter: CRS, cell size, and nodata.

```python
import glob
import rasterio
from collections import Counter

crs, res, nodata, dtypes = Counter(), Counter(), Counter(), Counter()
for path in sorted(glob.glob("tiles/*.tif")):
    with rasterio.open(path) as ds:
        crs[str(ds.crs)] += 1
        res[(round(ds.res[0], 4), round(ds.res[1], 4))] += 1
        nodata[ds.nodata] += 1
        dtypes[ds.dtypes[0]] += 1

for name, c in (("CRS", crs), ("cell size", res), ("nodata", nodata), ("dtype", dtypes)):
    print(f"{name}: {dict(c)}")
    assert len(c) == 1, f"inputs disagree on {name} — fix before mosaicking"
```

A `nodata` of `None` in that output is the single most common cause of a bad mosaic. GDAL then treats the fill value — often `0`, sometimes `-32768` — as real elevation, so voids become a sea-level plateau or a trench, and both of them merge cleanly into the neighbours.

### 2. Build a VRT rather than a merged file

`gdalbuildvrt` writes an XML index that references the tiles in place. It costs no disk, takes seconds on thousands of tiles, and every GDAL tool reads it as if it were one raster.

```bash
gdalbuildvrt \
  -resolution highest \
  -srcnodata -9999 -vrtnodata -9999 \
  -r bilinear \
  dem_mosaic.vrt tiles/*.tif

gdalinfo dem_mosaic.vrt | head -20
```

`-resolution highest` is deliberate: the default `average` invents a cell size that matches none of the inputs and resamples everything. `-srcnodata` and `-vrtnodata` have to be given separately — the first tells GDAL what to treat as void in the sources, the second what to write as void in the output — and omitting either is how a nodata value survives into the mosaic as data.

<figure class="diagram">
<svg viewBox="26 32 709 264" role="img" aria-labelledby="dm-nodata-t dm-nodata-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dm-nodata-t">What an undeclared nodata value becomes</title>
  <desc id="dm-nodata-d">A tile whose voids are filled with minus nine thousand nine hundred and ninety-nine, merged without declaring that value as nodata, produces a mosaic with a trench wherever the void was. Declaring it produces a mosaic with a genuine hole, which downstream code can see and handle.</desc>
  <rect class="svg-bg" x="26" y="32" width="709" height="264" fill="#ffffff"/>
  <polyline points="40,120 100,116 160,122 175,215 235,215 250,118 310,114 340,118"
            fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="410,120 470,116 530,122 545,122" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="605,118 620,118 680,114 710,118" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M545 100 h60 v40 h-60 Z" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text x="190" y="60" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">nodata undeclared</text>
  <text x="560" y="60" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">nodata declared as −9999</text>
  <text x="205" y="248" fill="#1f2937" font-size="12" text-anchor="middle">a −9999 m trench that every derived product inherits</text>
  <text x="575" y="248" fill="#1f2937" font-size="12" text-anchor="middle">a hole, which a consumer can see and decide about</text>
  <text x="575" y="160" fill="#5b6471" font-size="11.5" text-anchor="middle">void</text>
  <text x="370" y="278" fill="#15384a" font-size="12.5" text-anchor="middle">Flow accumulation, hillshade and contours all run happily over the trench and none of them reports anything</text>
</svg>
<figcaption>The undeclared case is worse than a crash, because every downstream product treats −9999 as terrain and produces plausible output from it.</figcaption>
</figure>

### 3. Decide which tile wins where they overlap

Deliveries usually overlap by a buffer. `gdalbuildvrt` resolves overlaps by file order — the last file listed wins — which means the answer depends on shell glob ordering unless you take control of it.

```bash
# Newest acquisition wins: list the tiles in ascending date order.
ls -1 tiles/*.tif | sort -t_ -k2 > order.txt
gdalbuildvrt -input_file_list order.txt -srcnodata -9999 -vrtnodata -9999 dem_mosaic.vrt

# Or, to prefer whichever tile has data at each cell regardless of order:
gdalbuildvrt -input_file_list order.txt -srcnodata -9999 -vrtnodata -9999 \
             -addalpha dem_alpha.vrt
```

The choice is a data-quality decision, not a technical one. Newest-wins is right when the later survey is better. Highest-density-wins is right when two contractors flew to different specifications. What is never right is leaving it to `ls`, because the resulting mosaic changes between machines and nothing records which tile supplied any given cell.

<figure class="diagram">
<svg viewBox="15 32 710 262" role="img" aria-labelledby="dm-order-t dm-order-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dm-order-t">Overlap is resolved by file order unless you decide otherwise</title>
  <desc id="dm-order-d">Two deliveries overlap by a buffer. Whichever tile is listed last supplies the overlapping cells, so shell glob ordering silently decides which survey wins. Listing the files explicitly in acquisition order makes the newest survey win deterministically, and the same command then produces the same mosaic on every machine.</desc>
  <rect class="svg-bg" x="15" y="32" width="710" height="262" fill="#ffffff"/>
  <path d="M40 76 h200 v110 h-200 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M180 76 h150 v110 h-150 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M410 76 h200 v110 h-200 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M550 76 h150 v110 h-150 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="185" y="60" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">glob order — undefined winner</text>
  <text x="555" y="60" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">explicit list — newest wins</text>
  <text x="210" y="214" fill="#5b6471" font-size="11.5" text-anchor="middle">overlap buffer</text>
  <text x="580" y="214" fill="#5b6471" font-size="11.5" text-anchor="middle">overlap buffer</text>
  <text x="185" y="242" fill="#1f2937" font-size="12" text-anchor="middle">the mosaic differs between machines</text>
  <text x="555" y="242" fill="#1f2937" font-size="12" text-anchor="middle">the mosaic is reproducible and recorded</text>
  <text x="370" y="276" fill="#15384a" font-size="12.5" text-anchor="middle">This is a data-quality decision — newest, or densest, or highest-accuracy — and it belongs in a file, not in a shell glob</text>
</svg>
<figcaption>Nothing in the mosaic records which delivery supplied a given cell. Fixing the order in a committed file is the cheapest way to make that answerable later.</figcaption>
</figure>

### 4. Warp to the target grid, with the right resampling

Now materialise it. The resampling choice matters more for elevation than for imagery, because elevation is a continuous field and nearest-neighbour introduces a staircase that shows up as terracing in every hillshade.

```bash
gdalwarp \
  -t_srs EPSG:32633 \
  -tr 1.0 1.0 \
  -tap \
  -r bilinear \
  -dstnodata -9999 \
  -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BIGTIFF=IF_SAFER \
  -multi -wo NUM_THREADS=ALL_CPUS \
  dem_mosaic.vrt dem_utm33n_1m.tif
```

Three flags earn their place. `-tap` snaps the output grid to whole multiples of the cell size, so this mosaic aligns exactly with the next one rather than being offset by a fraction of a cell. `PREDICTOR=3` is the floating-point predictor and typically halves the compressed size of an elevation raster — it is wrong for integer data and free for float. And `-r bilinear` is the floor for elevation; `cubic` is smoother but overshoots at breaks of slope, which puts a small ridge on the downhill side of every kerb.

### 5. Check the seams numerically, not visually

A hillshade shows you a seam once it is bad enough to see. A profile across the join shows you one before that.

```python
import numpy as np
import rasterio

with rasterio.open("dem_utm33n_1m.tif") as ds:
    band = ds.read(1, masked=True)

    # Sample a transect crossing a known tile boundary at easting 599000.
    col = ds.index(599000, 6644000)[1]
    window = band[:, col - 40:col + 40]

left = window[:, :40].mean(axis=1)
right = window[:, 40:].mean(axis=1)
step = np.ma.median(right - left)

print(f"median step across the join: {step * 100:.1f} cm")
print(f"spread of the step along the seam: {np.ma.std(right - left) * 100:.1f} cm")
assert abs(step) < 0.05, "systematic offset across the seam — check the vertical datum"
```

The two numbers separate the two causes. A median step with a small spread is a datum or a systematic-bias problem, identical everywhere along the seam. A median near zero with a large spread is an interpolation problem, where each tile's edge cells were interpolated from one side only.

<figure class="diagram">
<svg viewBox="28 6 686 284" role="img" aria-labelledby="dm-seam-t dm-seam-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dm-seam-t">Two seam signatures, measured along the join</title>
  <desc id="dm-seam-d">Plotting the height difference between the two sides at every point along a tile boundary separates the causes. A constant offset with little scatter is a datum or systematic bias. A near-zero mean with wide scatter is an interpolation artefact at the tile edges, where each side ran out of neighbours.</desc>
  <rect class="svg-bg" x="28" y="6" width="686" height="284" fill="#ffffff"/>
  <path d="M70 40 V210 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M70 150 H700" fill="none" stroke="#e6e0d4" stroke-width="1.5" stroke-dasharray="4 4"/>
  <polyline points="90,96 150,98 210,95 270,97 330,96 390,98 450,95 510,97 570,96 650,97"
            fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="90,182 150,124 210,176 270,132 330,168 390,126 450,180 510,134 570,172 650,140"
            fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <text x="672" y="92" fill="#b0413e" font-size="12" text-anchor="end">datum: +33 cm everywhere</text>
  <text x="672" y="206" fill="#c46a3d" font-size="12" text-anchor="end">edge interpolation: mean ≈ 0, spread ±25 cm</text>
  <text x="46" y="152" fill="#5b6471" font-size="11.5" text-anchor="middle">0</text>
  <text x="385" y="240" fill="#5b6471" font-size="12" text-anchor="middle">position along the seam</text>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Height difference across the join, sampled along its whole length</text>
  <text x="380" y="272" fill="#15384a" font-size="12" text-anchor="middle">The mean names the cause and the spread confirms it — a single sample at one point cannot distinguish them</text>
</svg>
<figcaption>One measurement, two very different remedies: re-transform one batch, or re-interpolate both with a shared overlap buffer.</figcaption>
</figure>

## Expected Output & Verification

A clean run over a 400-tile city delivery prints something like:

```text
CRS: {'EPSG:25832': 400}
cell size: {(1.0, 1.0): 400}
nodata: {-9999.0: 400}
dtype: {'float32': 400}
median step across the join: 1.2 cm
spread of the step along the seam: 3.4 cm
```

Then confirm the mosaic covers what it should and contains no surprise values:

```python
import rasterio
import numpy as np

with rasterio.open("dem_utm33n_1m.tif") as ds:
    a = ds.read(1, masked=True)
    print("extent:", [round(v, 1) for v in ds.bounds])
    print("valid cells:", int(a.count()), "of", a.size,
          f"({100 * a.count() / a.size:.1f}%)")
    print("range:", float(a.min()), "to", float(a.max()), "m")
    assert -50 < a.min() and a.max() < 3000, "elevations outside a plausible range"
```

The range assertion is worth keeping even though it looks crude. A vertical unit error, an undeclared nodata, and a datum mistake all announce themselves in it, and none of them announces itself anywhere else in the pipeline.

## Common Errors

**A grid of hairline seams across the whole mosaic.** The tiles were interpolated independently before delivery, so each one's edge cells were extrapolated from one side. `gdalwarp` cannot repair that — the fix is upstream, re-interpolating each tile with an overlap buffer, or accepting a light feather along the joins with `gdal_fillnodata` on a mask of the seam cells.

**The mosaic is enormous and slow.** No `-co TILED=YES` and no compression, so a 40,000 × 40,000 float32 raster is 6.4 GB of untiled scanlines that every read has to seek through. Add `TILED=YES`, `COMPRESS=DEFLATE` and `PREDICTOR=3`, and consider `-co BLOCKXSIZE=512 -co BLOCKYSIZE=512` to match how the twin reads it.

**`ERROR 1: Too many points (…) failed to transform`.** One tile's CRS is not what its header claims, or a tile has no CRS at all and GDAL is guessing. The audit in step 1 catches this before the warp; after the fact, `gdalinfo` on the offending tile usually shows a missing or truncated projection string.

## Frequently Asked Questions

### Should I mosaic at all, or keep the tiles?
Keep the tiles on disk and mosaic through a VRT. The VRT gives every consumer one continuous raster while leaving the delivery intact, so a re-flown tile is a one-file replacement rather than a full rebuild. Materialise a real GeoTIFF only where a consumer cannot read a VRT.

### Which resampling method for elevation?
Bilinear as the default. Cubic and Lanczos are smoother on gently varying terrain and overshoot at breaks of slope, which puts a small artificial ridge alongside every kerb, wall and ditch bank. Nearest is only right when the raster is categorical — a classification mask rather than a height.

### How do I keep the mosaic aligned with the one I built last year?
Use `-tap` and pin the cell size explicitly. Together they snap the grid origin to whole multiples of the cell size, so any two mosaics built with the same `-tr` share a grid regardless of their extents. Without `-tap` the origin follows the input extent and two mosaics can be offset by a fraction of a cell — enough to make a difference raster meaningless.

## Related Guides

- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — the full ingest from classified returns to a finished raster
- [Generating Terrain Meshes from DEM Rasters](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/generating-terrain-meshes-from-dem-rasters/) — turning the mosaic into geometry
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the cause behind a constant step at a seam

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
