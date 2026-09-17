---
title: "DSM Differencing for Volume Change"
description: "Compute earthwork volumes from two epochs of surface models: rasterise both to one grid, align them on stable ground, difference"
---
# DSM Differencing for Volume Change

This page computes cut and fill volumes between two survey epochs of a construction site — rasterising both point clouds to one identical grid, co-registering them on ground that did not move, differencing, masking the cells where the difference is indistinguishable from noise, and integrating cut and fill separately with a stated uncertainty.

## Why you hit this

Volume from two surveys is the most-requested number in earthworks and the easiest to get wrong. The failure is rarely the arithmetic; it is that the two epochs are not on the same grid, or not on the same vertical datum, or one includes vegetation that grew, or the difference is integrated over cells where it is pure noise. Each of those produces a confident number that is wrong by a margin nobody can see.

Differencing digital surface models is the standard method because it is simple, auditable and works on any pair of surfaces. Making it trustworthy is a matter of doing five specific things before the subtraction.

## Prerequisites

- Two point clouds or DSMs covering the same area, with a known CRS including the vertical datum.
- Python 3.10+ with `numpy`, `rasterio`, `pdal` (or the `pdal` CLI), `scipy`.
- Stable ground within the survey extent — a road, a hardstanding, a building roof — for the alignment check.

## Step-by-Step

### 1. Rasterise both epochs to one identical grid

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

def common_grid(bounds_a, bounds_b, cell_m=0.25, snap=True):
    """One grid definition both epochs share. Snapping avoids half-cell offsets."""
    west = max(bounds_a[0], bounds_b[0])
    south = max(bounds_a[1], bounds_b[1])
    east = min(bounds_a[2], bounds_b[2])
    north = min(bounds_a[3], bounds_b[3])
    if east <= west or north <= south:
        raise ValueError("epochs do not overlap")
    if snap:
        west = math.floor(west / cell_m) * cell_m
        south = math.floor(south / cell_m) * cell_m
        east = math.ceil(east / cell_m) * cell_m
        north = math.ceil(north / cell_m) * cell_m
    width = int(round((east - west) / cell_m))
    height = int(round((north - south) / cell_m))
    return {"west": west, "south": south, "east": east, "north": north,
            "cell_m": cell_m, "width": width, "height": height,
            "transform": from_origin(west, north, cell_m, cell_m)}

def rasterise(las_path, out_tif, grid, crs="EPSG:25832", statistic="max",
              window_radius=1.0):
    """PDAL writers.gdal, with an explicit origin so both epochs align exactly."""
    pipeline = {
        "pipeline": [
            str(las_path),
            {"type": "filters.range", "limits": "Classification![7:7]"},
            {
                "type": "writers.gdal",
                "filename": str(out_tif),
                "gdaldriver": "GTiff",
                "output_type": statistic,
                "resolution": grid["cell_m"],
                "radius": window_radius,
                "origin_x": grid["west"],
                "origin_y": grid["south"],
                "width": grid["width"],
                "height": grid["height"],
                "nodata": -9999.0,
                "data_type": "float32",
                "gdalopts": "COMPRESS=DEFLATE,PREDICTOR=3,TILED=YES",
            },
        ]
    }
    spec = Path(out_tif).with_suffix(".json")
    spec.write_text(json.dumps(pipeline, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    with rasterio.open(out_tif) as ds:
        band = ds.read(1, masked=True)
        return {"path": str(out_tif), "size": [ds.width, ds.height],
                "valid_pct": round(100.0 * band.count() / band.size, 2),
                "min": round(float(band.min()), 3), "max": round(float(band.max()), 3)}
```

Passing `origin_x`, `origin_y`, `width` and `height` explicitly is the step that makes the two rasters comparable cell for cell. Without them, PDAL derives the grid from each cloud's own bounds, and two epochs with slightly different extents produce grids offset by a fraction of a cell — which the subtraction then interprets as a real height difference along every slope.

`output_type: max` is right for a DSM of a working site: it captures the top surface including stockpiles and plant. `min` gives something closer to ground, and `idw` gives a smoother surface that is better for visual comparison and worse for volume, because it spreads sharp stockpile edges.

The cell size trades resolution against noise. At 25 cm, a 0.02 m³ volume error per cell across 100,000 cells is 2,000 m³ of noise; averaging over larger cells reduces the per-cell noise as the square root of the count, which is why 0.25–0.5 m is the usual band for earthworks rather than the survey's full resolution.

### 2. Co-register on ground that did not move

```python
def read_pair(path_a, path_b):
    with rasterio.open(path_a) as a, rasterio.open(path_b) as b:
        if (a.width, a.height) != (b.width, b.height):
            raise ValueError(f"grid mismatch: {a.shape} vs {b.shape}")
        if a.transform != b.transform:
            raise ValueError("transforms differ; re-rasterise on a common grid")
        za = a.read(1, masked=True).astype("float64")
        zb = b.read(1, masked=True).astype("float64")
        return za, zb, a.transform, a.crs

def vertical_bias(za, zb, stable_mask, robust=True):
    """The systematic offset between epochs, measured where nothing changed."""
    diff = (zb - za)
    sel = diff[stable_mask & ~diff.mask] if hasattr(diff, "mask") else diff[stable_mask]
    sel = np.asarray(sel.compressed() if hasattr(sel, "compressed") else sel)
    sel = sel[np.isfinite(sel)]
    if sel.size < 200:
        return {"measurable": False, "reason": f"only {sel.size} stable cells"}
    centre = float(np.median(sel)) if robust else float(sel.mean())
    spread = float(1.4826 * np.median(np.abs(sel - centre))) if robust else float(sel.std())
    return {
        "measurable": True,
        "stable_cells": int(sel.size),
        "bias_m": round(centre, 4),
        "noise_sigma_m": round(spread, 4),
        "p95_abs_m": round(float(np.percentile(np.abs(sel - centre), 95)), 4),
        "significant": abs(centre) > spread / math.sqrt(sel.size) * 3,
    }

def stable_ground_mask(za, zb, roads_raster=None, slope_limit_deg=8.0, cell_m=0.25):
    """Flat, low-slope cells present in both epochs, optionally restricted to roads."""
    valid = ~za.mask & ~zb.mask if hasattr(za, "mask") else np.isfinite(za) & np.isfinite(zb)
    gy, gx = np.gradient(np.where(valid, np.asarray(za), np.nan), cell_m)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    flat = np.nan_to_num(slope, nan=90.0) <= slope_limit_deg
    mask = valid & flat
    if roads_raster is not None:
        with rasterio.open(roads_raster) as ds:
            roads = ds.read(1) > 0
        mask &= roads
    return mask
```

Measuring the bias on stable ground is the step that separates a defensible volume from a plausible one. Two epochs flown by different crews, processed with different GNSS base positions, routinely differ by 2–8 cm in the vertical — and a 5 cm bias over a 40,000 m² site is 2,000 m³ of fictitious volume, which is often larger than the movement being measured.

Using the median and a robust spread estimate rather than the mean and standard deviation matters because the "stable" mask is never perfectly stable: a parked vehicle, a new pile of materials or a patch of vegetation will contaminate it, and a median is unmoved by a few percent of outliers.

The `noise_sigma_m` this produces is the input to the significance mask in step 4 and to the uncertainty in step 6. It is measured from the data rather than assumed, which is what makes the final uncertainty honest.

<figure class="diagram">
<svg viewBox="129 1 453 261" role="img" aria-labelledby="dsm-bias-t dsm-bias-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dsm-bias-t">Vertical bias between epochs, and what it costs</title>
  <desc id="dsm-bias-d">A histogram of the height difference measured on stable road surface between two epochs. The distribution is centred on plus 5.1 centimetres rather than zero, with a robust spread of 2.4 centimetres. Over the 41000 square metre site that 5.1 centimetre offset integrates to 2091 cubic metres of fictitious fill, which is comparable to the 2400 cubic metres of real movement being measured.</desc>
  <rect class="svg-bg" x="129" y="1" width="453" height="261" fill="#ffffff"/>
  <path d="M60 186 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M260 34 V196" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4" fill="none"/>
  <path d="M400 34 V196" stroke="#b0413e" stroke-width="2" fill="none"/>
  <g stroke-width="1.2" fill="#e3f0f4" stroke="#1f6b8a">
    <rect x="300" y="174" width="18" height="12"/>
    <rect x="320" y="160" width="18" height="26"/>
    <rect x="340" y="132" width="18" height="54"/>
    <rect x="360" y="96" width="18" height="90"/>
    <rect x="380" y="62" width="18" height="124"/>
    <rect x="400" y="54" width="18" height="132"/>
    <rect x="420" y="70" width="18" height="116"/>
    <rect x="440" y="104" width="18" height="82"/>
    <rect x="460" y="140" width="18" height="46"/>
    <rect x="480" y="166" width="18" height="20"/>
    <rect x="500" y="178" width="18" height="8"/>
  </g>
  <text x="260" y="28" fill="#15384a" font-size="12" text-anchor="middle">zero</text>
  <text x="400" y="28" fill="#b0413e" font-size="12" text-anchor="middle">median +5.1 cm</text>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="260" y="204">0</text><text x="400" y="204">+5</text><text x="540" y="204">+10 cm</text>
    <text x="150" y="204">−5</text>
  </g>
  <text x="380" y="226" fill="#1f2937" font-size="12.5" text-anchor="middle">robust spread 2.4 cm — this becomes the significance threshold</text>
  <text x="380" y="244" fill="#1f2937" font-size="12.5" text-anchor="middle">5.1 cm × 41,000 m² = 2,091 m³ of fill that did not happen</text>
</svg>
<figcaption>Measured on road surface that nobody touched: the offset alone is comparable to the movement being reported.</figcaption>
</figure>

### 3. Difference, after correcting the bias

```python
def difference(za, zb, bias_m=0.0):
    d = (np.asarray(zb) - bias_m) - np.asarray(za)
    valid = np.isfinite(d)
    if hasattr(za, "mask"):
        valid &= ~za.mask & ~zb.mask
    out = np.where(valid, d, np.nan)
    return out, valid

def difference_summary(d, valid, cell_m):
    vals = d[valid]
    cell_area = cell_m * cell_m
    return {
        "cells": int(valid.sum()),
        "area_m2": round(float(valid.sum()) * cell_area, 1),
        "mean_m": round(float(np.nanmean(vals)), 4),
        "p05_m": round(float(np.nanpercentile(vals, 5)), 3),
        "p95_m": round(float(np.nanpercentile(vals, 95)), 3),
        "min_m": round(float(np.nanmin(vals)), 3),
        "max_m": round(float(np.nanmax(vals)), 3),
    }
```

Subtracting the bias before anything else is what makes every subsequent number meaningful. Reporting the bias alongside the volume, rather than silently correcting it, is what makes the result auditable — a reviewer needs to know that a 5.1 cm correction was applied and why.

### 4. Mask the cells where the difference is noise

```python
def significance_mask(d, valid, sigma_m, confidence=1.96, min_change_m=None):
    """A cell's change is real only if it exceeds the detection limit."""
    lod = confidence * sigma_m * math.sqrt(2.0)      # two epochs, independent noise
    if min_change_m is not None:
        lod = max(lod, min_change_m)
    significant = valid & (np.abs(d) > lod)
    return significant, {
        "sigma_m": round(sigma_m, 4),
        "level_of_detection_m": round(lod, 4),
        "significant_cells": int(significant.sum()),
        "insignificant_cells": int((valid & ~significant).sum()),
        "significant_fraction": round(float(significant.sum()) / max(int(valid.sum()), 1), 4),
    }

def clean_significance(significant, min_cluster_cells=16):
    """Remove isolated significant cells: real earthworks are contiguous."""
    from scipy import ndimage
    labels, count = ndimage.label(significant)
    sizes = ndimage.sum(significant, labels, index=np.arange(1, count + 1))
    keep = np.isin(labels, np.flatnonzero(sizes >= min_cluster_cells) + 1)
    return keep, {"clusters_before": int(count),
                  "clusters_after": int(np.unique(labels[keep]).size),
                  "cells_removed": int(significant.sum() - keep.sum())}
```

The **level of detection** is the threshold below which a cell's difference cannot be distinguished from measurement noise. The `sqrt(2)` accounts for both epochs contributing independent noise, and the 1.96 factor makes it a 95% confidence threshold — so with a 2.4 cm sigma the detection limit is 6.7 cm, and every cell that changed by less than that is excluded.

Excluding them rather than integrating them is the important choice. Noise integrates to something near zero over a large area only if it is truly unbiased; in practice it is not, and integrating 200,000 insignificant cells adds a few hundred cubic metres of unpredictable sign.

Removing isolated significant cells is the second filter, and it encodes something true about earthworks: material moves in contiguous patches. Sixteen cells at 25 cm is one square metre, below which a "change" is almost certainly a bird, a vehicle or a registration artefact.

### 5. Integrate cut and fill separately

```python
def volumes(d, mask, cell_m, sigma_m, confidence=1.96):
    cell_area = cell_m * cell_m
    vals = np.where(mask, d, 0.0)
    fill = float(np.nansum(np.clip(vals, 0, None))) * cell_area
    cut = float(-np.nansum(np.clip(vals, None, 0))) * cell_area

    n_fill = int((mask & (d > 0)).sum())
    n_cut = int((mask & (d < 0)).sum())
    # Uncertainty: per-cell noise is partly random, partly spatially correlated.
    def uncertainty(n_cells, correlation_length_cells=8):
        independent = max(n_cells / max(correlation_length_cells ** 2, 1), 1.0)
        return confidence * sigma_m * math.sqrt(2.0) * cell_area * math.sqrt(independent)

    return {
        "fill_m3": round(fill, 1),
        "cut_m3": round(cut, 1),
        "net_m3": round(fill - cut, 1),
        "fill_cells": n_fill, "cut_cells": n_cut,
        "fill_area_m2": round(n_fill * cell_area, 1),
        "cut_area_m2": round(n_cut * cell_area, 1),
        "fill_uncertainty_m3": round(uncertainty(n_fill), 1),
        "cut_uncertainty_m3": round(uncertainty(n_cut), 1),
        "net_uncertainty_m3": round(math.hypot(uncertainty(n_fill),
                                               uncertainty(n_cut)), 1),
    }
```

Reporting cut and fill separately, not just the net, is what the site actually needs. A net of zero can mean nothing happened or that 4,000 m³ was moved from one end to the other, and those are different invoices.

The uncertainty calculation deliberately does not assume independent per-cell noise. Photogrammetric and lidar height errors are spatially correlated over a few metres — a systematic tilt in one flight line, a patch of poor matching — so dividing by the correlation area rather than by the cell count gives a realistic figure, typically several times larger than the naive one.

A correlation length of 8 cells at 25 cm is 2 m, which is a reasonable default for aerial survey and worth estimating from the data where the stable-ground residuals are large enough to compute a variogram.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="dsm-stats-t dsm-stats-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dsm-stats-t">What each rasterisation statistic gives you</title>
  <desc id="dsm-stats-d">A table of four PDAL rasterisation statistics and what each produces. Max captures the top surface including stockpiles and plant and is the right choice for a working site. Min approximates ground and removes plant. Mean smooths and is unsuitable for volume. Inverse distance weighting gives a smooth surface that is better for visual comparison and worse for volume because it spreads sharp stockpile edges.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="168" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="186" y="20" width="276" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="462" y="20" width="260" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="168" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="186" y="54" width="276" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="54" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="168" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="186" y="88" width="276" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="462" y="88" width="260" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="168" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="186" y="122" width="276" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="122" width="260" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="156" width="168" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="186" y="156" width="276" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="462" y="156" width="260" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="102" y="42">statistic</text><text x="324" y="42">captures</text><text x="592" y="42">use for volume?</text>
    <text x="102" y="76">max</text><text x="324" y="76">top surface, plant included</text><text x="592" y="76">yes — the site as built</text>
    <text x="102" y="110">min</text><text x="324" y="110">approximate ground</text><text x="592" y="110">only with plant excluded</text>
    <text x="102" y="144">mean</text><text x="324" y="144">a smoothed average</text><text x="592" y="144">no</text>
    <text x="102" y="178">idw</text><text x="324" y="178">smooth interpolated surface</text><text x="592" y="178">no — spreads pile edges</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Max is the choice for earthworks; idw looks better and measures worse.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Whichever is chosen must be identical for both epochs, or the difference is the statistic's.</text>
</svg>
<figcaption>Max for volume, idw for a picture, and the same choice for both epochs whichever it is.</figcaption>
</figure>

### 6. Write the difference raster and a report

```python
def write_difference(d, mask, transform, crs, out_path):
    out = np.where(mask, d, -9999.0).astype("float32")
    with rasterio.open(out_path, "w", driver="GTiff", height=out.shape[0],
                       width=out.shape[1], count=1, dtype="float32",
                       crs=crs, transform=transform, nodata=-9999.0,
                       compress="deflate", predictor=3, tiled=True) as ds:
        ds.write(out, 1)
    return {"path": out_path, "significant_cells": int(mask.sum())}

def run(epoch_a_las, epoch_b_las, out_dir="build/volume", cell_m=0.25,
        roads_raster=None, min_change_m=None):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    grid = common_grid(bounds_of(epoch_a_las), bounds_of(epoch_b_las), cell_m=cell_m)
    ra = rasterise(epoch_a_las, f"{out_dir}/epoch_a.tif", grid)
    rb = rasterise(epoch_b_las, f"{out_dir}/epoch_b.tif", grid)

    za, zb, transform, crs = read_pair(ra["path"], rb["path"])
    stable = stable_ground_mask(za, zb, roads_raster=roads_raster, cell_m=cell_m)
    bias = vertical_bias(za, zb, stable)
    if not bias["measurable"]:
        raise RuntimeError(f"cannot co-register: {bias['reason']}")

    d, valid = difference(za, zb, bias_m=bias["bias_m"])
    summary = difference_summary(d, valid, cell_m)
    sig, sig_stats = significance_mask(d, valid, bias["noise_sigma_m"],
                                       min_change_m=min_change_m)
    sig, cluster_stats = clean_significance(sig)
    vol = volumes(d, sig, cell_m, bias["noise_sigma_m"])
    write_difference(d, sig, transform, crs, f"{out_dir}/difference.tif")

    return {"grid": {k: grid[k] for k in ("cell_m", "width", "height")},
            "epoch_a": ra, "epoch_b": rb, "alignment": bias,
            "difference": summary, "significance": sig_stats,
            "clusters": cluster_stats, "volumes": vol}

def bounds_of(las_path):
    info = json.loads(subprocess.run(["pdal", "info", "--summary", str(las_path)],
                                     capture_output=True, text=True, check=True).stdout)
    b = info["summary"]["bounds"]
    return (b["minx"], b["miny"], b["maxx"], b["maxy"])

print(json.dumps(run("input/epoch_2026_06.laz", "input/epoch_2026_09.laz",
                     roads_raster="input/hardstanding.tif"), indent=2))
```

<figure class="diagram">
<svg viewBox="4 20 730 248" role="img" aria-labelledby="dsm-flow-t dsm-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dsm-flow-t">Five things that happen before the subtraction</title>
  <desc id="dsm-flow-d">A pipeline. Both epochs are rasterised onto one explicitly defined grid so cells correspond. A stable-ground mask is derived from low-slope hardstanding. The vertical bias and noise sigma are measured on that mask. The bias is removed and the epochs differenced. Cells below the level of detection and isolated clusters are masked out. Only then are cut and fill integrated separately with an uncertainty derived from the measured noise.</desc>
  <rect class="svg-bg" x="4" y="20" width="730" height="248" fill="#ffffff"/>
  <defs>
    <marker id="dsm-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.8">
    <rect x="18" y="34" width="132" height="50" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="104" width="132" height="50" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="196" y="69" width="132" height="50" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="374" y="69" width="132" height="50" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="552" y="69" width="168" height="50" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="374" y="176" width="346" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#dsm-flow-arrow)">
    <path d="M150 58 L194 82"/><path d="M150 130 L194 108"/>
    <path d="M328 94 H372"/><path d="M506 94 H550"/>
    <path d="M636 119 V152 H547 V174"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="84" y="54">epoch A → grid</text><text x="84" y="72">explicit origin</text>
    <text x="84" y="124">epoch B → same</text><text x="84" y="142">grid, same size</text>
    <text x="262" y="84">stable-ground</text><text x="262" y="102">mask from slope</text>
    <text x="440" y="84">measure bias</text><text x="440" y="102">and noise σ</text>
    <text x="636" y="84">remove bias,</text><text x="636" y="102">difference</text>
    <text x="547" y="198">mask |d| below 1.96·σ·√2, drop clusters &lt; 1 m²</text>
    <text x="547" y="218">integrate cut and fill separately, with uncertainty</text>
  </g>
  <text x="370" y="250" fill="#5b6471" font-size="12" text-anchor="middle">the subtraction is one line; the four steps before it are what make the number defensible</text>
</svg>
<figcaption>Every step before the subtraction exists to stop a specific class of fictitious volume.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "grid": {"cell_m": 0.25, "width": 1284, "height": 1016},
  "epoch_a": {"valid_pct": 98.41, "min": 12.104, "max": 41.882},
  "epoch_b": {"valid_pct": 97.88, "min": 12.088, "max": 46.214},
  "alignment": {"measurable": true, "stable_cells": 41208, "bias_m": 0.0512,
                "noise_sigma_m": 0.0241, "p95_abs_m": 0.0468, "significant": true},
  "difference": {"cells": 1284102, "area_m2": 80256.4, "mean_m": 0.0184,
                 "p05_m": -0.412, "p95_m": 0.884, "min_m": -4.118, "max_m": 6.204},
  "significance": {"sigma_m": 0.0241, "level_of_detection_m": 0.0668,
                   "significant_cells": 184102, "insignificant_cells": 1100000,
                   "significant_fraction": 0.1434},
  "clusters": {"clusters_before": 8412, "clusters_after": 214, "cells_removed": 11840},
  "volumes": {"fill_m3": 4218.4, "cut_m3": 1804.2, "net_m3": 2414.2,
              "fill_cells": 128104, "cut_cells": 44158,
              "fill_area_m2": 8006.5, "cut_area_m2": 2759.9,
              "fill_uncertainty_m3": 36.8, "cut_uncertainty_m3": 21.6,
              "net_uncertainty_m3": 42.7}
}
```

The numbers to report are "4,218 ± 37 m³ fill and 1,804 ± 22 m³ cut, net 2,414 ± 43 m³, after removing a 5.1 cm vertical offset between epochs". The 5.1 cm correction is worth 2,000 m³ on this site, so stating it is not pedantry.

Only 14% of cells were significant, and the cluster filter removed 8,198 tiny clusters containing 11,840 cells — the vehicles, birds and matching artefacts that a naive integration would have counted.

Verify the alignment is genuinely good after correction, not just centred:

```python
def alignment_verification(za, zb, stable, bias_m, cell_m, tiles=4):
    """A single global bias hides a tilt. Check per quadrant."""
    d = (np.asarray(zb) - bias_m) - np.asarray(za)
    h, w = d.shape
    rows = []
    for ti in range(tiles):
        for tj in range(tiles):
            sl = (slice(ti * h // tiles, (ti + 1) * h // tiles),
                  slice(tj * w // tiles, (tj + 1) * w // tiles))
            m = stable[sl]
            vals = d[sl][m]
            vals = vals[np.isfinite(vals)]
            if vals.size < 50:
                rows.append({"tile": f"{ti}_{tj}", "cells": int(vals.size),
                             "status": "too few stable cells"})
                continue
            rows.append({"tile": f"{ti}_{tj}", "cells": int(vals.size),
                         "residual_bias_m": round(float(np.median(vals)), 4)})
    measured = [r for r in rows if "residual_bias_m" in r]
    spread = (max(r["residual_bias_m"] for r in measured)
              - min(r["residual_bias_m"] for r in measured)) if measured else None
    return {"tiles": rows, "tiles_measured": len(measured),
            "bias_spread_m": round(spread, 4) if spread is not None else None,
            "planar_tilt_suspected": spread is not None and spread > 0.03,
            "worst": sorted(measured, key=lambda r: -abs(r["residual_bias_m"]))[:3]}
```

A residual bias that varies across the site means the epochs differ by a tilt, not just an offset, and a single constant correction leaves half the site high and half low. That is the case for fitting a plane rather than a constant, and the spread above 3 cm is the signal to do it.

Then verify against an independent measurement, because a volume with no external check is an assertion:

```python
def truck_count_reconciliation(volumes, truck_loads, load_m3=12.0, bulking_factor=1.25):
    """Compare the surface-derived volume with haulage records."""
    hauled_in_place = truck_loads * load_m3 / bulking_factor
    reported = volumes["fill_m3"]
    diff = reported - hauled_in_place
    return {
        "truck_loads": truck_loads,
        "hauled_loose_m3": round(truck_loads * load_m3, 1),
        "hauled_in_place_m3": round(hauled_in_place, 1),
        "surface_fill_m3": reported,
        "difference_m3": round(diff, 1),
        "difference_pct": round(100.0 * diff / max(hauled_in_place, 1), 1),
        "within_uncertainty": abs(diff) <= volumes["fill_uncertainty_m3"] * 3,
        "note": "a persistent gap usually means the bulking factor, not the survey",
    }

print(truck_count_reconciliation(result["volumes"], truck_loads=436))
```

Haulage records are the available external check on most sites, and reconciling to within a few percent is achievable. The bulking factor — loose volume in the truck against compacted volume in place — is usually the largest unknown, so a systematic gap points there before it points at the survey.

## Performance Notes

- **Rasterising is the slow step**: PDAL's `writers.gdal` handles roughly 2–5 million points per second, so a 400-million-point epoch takes a few minutes.
- **The difference and integration are trivial** — a 1,284 × 1,016 grid is 1.3 million cells and the whole calculation is well under a second.
- **Cell size drives the noise, not the runtime.** Halving the cell quadruples the cells and doubles the per-cell noise contribution to the volume.
- **`float32` is sufficient** for heights in metres; `float64` doubles the memory for no accuracy that matters.
- **Store the difference raster.** It is small, compresses well and is the artefact people want to look at when they question the number.
- **The connected-component filter is O(cells)** and costs milliseconds.

## Common Errors

**`grid mismatch` on read.** The two rasterisations derived their own extents. Pass the explicit grid to both.

**Volume is large and the site looks unchanged.** An uncorrected vertical bias. Measure it on stable ground.

**Net volume is plausible and cut and fill are both enormous.** Vegetation or plant included in the surface. Mask it, as in [excluding vegetation from change detection](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/excluding-vegetation-from-change-detection/).

**Volume changes when the cell size changes.** Expected to a small degree from resampling; a change of more than a few percent means the surface has features finer than the cell.

**`cannot co-register: only 84 stable cells`.** The stable mask is too restrictive, or the site genuinely has no unchanged ground. Widen the slope limit or supply a hardstanding raster.

**Uncertainty is implausibly small.** The naive independent-cell assumption. Use a correlation length.

**Difference raster shows stripes.** Flight-line systematic error in one epoch. That is a survey problem, not a differencing one, and it invalidates the volume until corrected.

## Frequently Asked Questions

### Should I use DSM differencing or point-to-point comparison?

DSM differencing for volumes, point-based methods for movement of surfaces that are not height fields — a wall, a cliff face, a tunnel. A 2.5D grid cannot represent an overhang, so a quarry face needs a point-based method.

### What cell size should I use?

Coarse enough that per-cell noise is small relative to the change, fine enough to resolve the smallest feature whose volume matters. 0.25–0.5 m covers most earthworks.

### How do I handle areas with no data in one epoch?

Exclude them. Interpolating across a gap and integrating the result invents volume; reporting the excluded area alongside the volume is the honest alternative.

## Related Guides

- [Excluding Vegetation from Change Detection](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/excluding-vegetation-from-change-detection/) — removing the largest source of false change
- [Reporting Stockpile Volumes with Uncertainty](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/reporting-stockpile-volumes-with-uncertainty/) — volume against a base plane rather than a second epoch
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the other reason two epochs disagree vertically

Back to [Change Detection Between Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
