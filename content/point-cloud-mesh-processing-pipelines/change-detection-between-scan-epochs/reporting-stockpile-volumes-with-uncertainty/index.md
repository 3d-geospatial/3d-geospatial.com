# Reporting Stockpile Volumes with Uncertainty

This page measures the volume of a stockpile from a drone survey and reports it with a defensible uncertainty — delineating the toe, choosing and justifying a base surface, integrating by prisms, building an error budget from the base, the surface noise, the toe position and the density assumption, and producing a report a quantity surveyor will accept.

## Why you hit this

A stockpile volume is a payment quantity. Someone is invoicing on it, so the number needs an uncertainty and the uncertainty needs a derivation — "about 4,200 cubic metres" is not a measurement, and "4,218.43 m³" is worse because the two decimal places are a claim of millimetre accuracy nobody can support.

The dominant error source is almost never the survey's point accuracy. It is the base surface: what the ground under the pile is assumed to be. A 2 cm error in the assumed base over a 1,400 m² footprint is 28 m³; a 20 cm error is 280 m³, which is 7% of a 4,000 m³ pile and typically much larger than everything else combined.

## Prerequisites

- A point cloud of the pile, from drone photogrammetry or a scanner, with a known CRS and vertical datum.
- Python 3.10+ with `numpy`, `rasterio`, `scipy`, `shapely`, `pdal`.
- Ideally a pre-stockpile survey of the same ground, or surveyed spot heights around the toe.

## Step-by-Step

### 1. Delineate the toe

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

def surface_grid(las_path, out_tif, cell_m=0.10, statistic="max"):
    pipeline = {"pipeline": [
        str(las_path),
        {"type": "filters.range", "limits": "Classification![7:7]"},
        {"type": "writers.gdal", "filename": str(out_tif), "gdaldriver": "GTiff",
         "output_type": statistic, "resolution": cell_m, "radius": cell_m * 1.5,
         "nodata": -9999.0, "data_type": "float32",
         "gdalopts": "COMPRESS=DEFLATE,PREDICTOR=3,TILED=YES"},
    ]}
    spec = Path(out_tif).with_suffix(".json")
    spec.write_text(json.dumps(pipeline, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    with rasterio.open(out_tif) as ds:
        return ds.read(1, masked=True).astype("float64"), ds.transform, ds.crs, ds.res[0]

def toe_from_slope(z, cell_m, slope_threshold_deg=12.0, min_area_m2=25.0,
                   close_iterations=3):
    """The toe is where the pile's slope drops to the surrounding ground's."""
    filled = np.where(np.isfinite(z) & ~getattr(z, "mask", False), np.asarray(z), np.nan)
    gy, gx = np.gradient(np.nan_to_num(filled, nan=np.nanmedian(filled)), cell_m)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    steep = np.nan_to_num(slope, nan=0.0) >= slope_threshold_deg

    closed = ndimage.binary_closing(steep, iterations=close_iterations)
    filled_holes = ndimage.binary_fill_holes(closed)
    labels, n = ndimage.label(filled_holes)
    if n == 0:
        return None, {"found": False, "reason": "no region above the slope threshold"}
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1))
    min_cells = min_area_m2 / (cell_m ** 2)
    candidates = np.flatnonzero(sizes >= min_cells) + 1
    if candidates.size == 0:
        return None, {"found": False, "reason": "all candidate regions below min area"}
    biggest = candidates[np.argmax(sizes[candidates - 1])]
    mask = labels == biggest
    return mask, {
        "found": True,
        "regions_considered": int(n),
        "candidates_over_min_area": int(candidates.size),
        "footprint_m2": round(float(mask.sum()) * cell_m ** 2, 1),
        "slope_threshold_deg": slope_threshold_deg,
    }
```

The toe is the largest single judgement in a stockpile measurement and it is worth making explicit rather than drawing by hand. A slope threshold is defensible and repeatable: the material's angle of repose is 30–40°, the surrounding hardstanding is near 0°, so anything above 12° is on the pile.

Filling holes matters because the pile's own crest can be flat — a pile that has been driven over has a plateau on top, which the slope test excludes and `binary_fill_holes` restores.

The threshold is also the toe's uncertainty. Moving it from 12° to 15° shrinks the footprint, and the resulting volume difference is a real number that belongs in the error budget; step 5 computes it rather than arguing about it.

<figure class="diagram">
<svg viewBox="46 33 650 227" role="img" aria-labelledby="pile-toe-t pile-toe-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pile-toe-t">Toe delineation and its effect on volume</title>
  <desc id="pile-toe-d">A cross-section of a stockpile on hardstanding. The pile rises at about 34 degrees from a toe at each side. A slope threshold of 12 degrees places the toe close to the true break in slope. A threshold of 20 degrees moves the toe up the flank, cutting 84 cubic metres from the volume. A threshold of 6 degrees extends the toe onto the surrounding apron, adding 61 cubic metres of hardstanding to the pile.</desc>
  <rect class="svg-bg" x="46" y="33" width="650" height="227" fill="#ffffff"/>
  <path d="M40 186 H700" stroke="#5b6471" stroke-width="1.6" fill="none"/>
  <path d="M130 186 L300 72 L430 72 L590 186" stroke="#1f6b8a" stroke-width="2.6" fill="none"/>
  <g stroke-width="2" stroke-dasharray="6 4" fill="none">
    <path d="M130 186 V206" stroke="#4f7a4d"/>
    <path d="M590 186 V206" stroke="#4f7a4d"/>
    <path d="M182 152 V206" stroke="#b0413e"/>
    <path d="M538 152 V206" stroke="#b0413e"/>
    <path d="M92 186 V206" stroke="#c46a3d"/>
    <path d="M628 186 V206" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="360" y="60" text-anchor="middle">plateau — slope test excludes it, fill_holes restores it</text>
    <text x="242" y="132" text-anchor="middle">flank ≈ 34°</text>
  </g>
  <g font-size="12">
    <text x="360" y="224" fill="#4f7a4d" text-anchor="middle">12° threshold — toe at the break in slope</text>
    <text x="360" y="242" fill="#b0413e" text-anchor="middle">20° threshold: −84 m³ · 6° threshold: +61 m³ (apron included)</text>
  </g>
  <text x="60" y="180" fill="#5b6471" font-size="12">hardstanding</text>
  <text x="648" y="180" fill="#5b6471" font-size="12">apron</text>
</svg>
<figcaption>A ±8° swing in the slope threshold is worth ±2% of the volume, which is why the threshold belongs in the error budget rather than in a judgement call.</figcaption>
</figure>

### 2. Choose the base surface, and say which you chose

```python
BASE_METHODS = {
    "prior_survey": "a survey of the same ground before the pile existed — best",
    "surveyed_spots": "levelled spot heights around and under the toe — good",
    "toe_triangulation": "a TIN through the delineated toe ring — usual fallback",
    "best_fit_plane": "a plane fitted to the toe ring — for flat hardstanding",
    "constant_level": "a single level — only for a known flat slab",
}

def base_from_toe_triangulation(z, toe_mask, cell_m):
    """A surface interpolated across the footprint from the toe ring's heights."""
    ring = toe_mask & ~ndimage.binary_erosion(toe_mask, iterations=2)
    ys, xs = np.nonzero(ring)
    heights = np.asarray(z)[ring]
    keep = np.isfinite(heights)
    if keep.sum() < 20:
        return None, {"ok": False, "reason": f"only {int(keep.sum())} toe samples"}
    from scipy.interpolate import griddata
    pts = np.column_stack([xs[keep], ys[keep]])
    grid_y, grid_x = np.mgrid[0:z.shape[0], 0:z.shape[1]]
    base = griddata(pts, heights[keep], (grid_x, grid_y), method="linear")
    nearest = griddata(pts, heights[keep], (grid_x, grid_y), method="nearest")
    base = np.where(np.isfinite(base), base, nearest)
    return base, {"ok": True, "toe_samples": int(keep.sum()),
                  "toe_height_range_m": round(float(np.ptp(heights[keep])), 3),
                  "method": "toe_triangulation"}

def base_from_plane(z, toe_mask):
    ring = toe_mask & ~ndimage.binary_erosion(toe_mask, iterations=2)
    ys, xs = np.nonzero(ring)
    h = np.asarray(z)[ring]
    keep = np.isfinite(h)
    A = np.column_stack([xs[keep], ys[keep], np.ones(keep.sum())])
    coef, residuals, *_ = np.linalg.lstsq(A, h[keep], rcond=None)
    grid_y, grid_x = np.mgrid[0:z.shape[0], 0:z.shape[1]]
    base = coef[0] * grid_x + coef[1] * grid_y + coef[2]
    fit = A @ coef
    rms = float(np.sqrt(((h[keep] - fit) ** 2).mean()))
    return base, {"ok": True, "method": "best_fit_plane",
                  "toe_samples": int(keep.sum()), "plane_rms_m": round(rms, 4)}

def base_from_prior(prior_tif, z_shape):
    with rasterio.open(prior_tif) as ds:
        base = ds.read(1, masked=True).astype("float64")
    if base.shape != z_shape:
        raise ValueError("prior survey is not on the same grid")
    return np.asarray(base.filled(np.nan)), {"ok": True, "method": "prior_survey"}
```

The base surface ranks the methods by how much they assume, and stating which was used is the single most important line in the report. A prior survey of the same ground measures the base; a toe triangulation *assumes* the ground under the pile follows the toe, which is wrong if the pile sits in a hollow or on a pad built up for it.

The toe height range is the diagnostic for that assumption. A toe ring spanning 12 cm on flat hardstanding is fine; one spanning 1.4 m means the pile is on a slope, and a linear interpolation across the footprint is then a significant assumption that the error budget has to carry.

`plane_rms_m` from the plane fit serves the same purpose: a low RMS confirms the hardstanding is flat and the plane is a good base, while a high one says it is not.

### 3. Integrate by prisms

```python
def prism_volume(z, base, toe_mask, cell_m):
    """Each cell is a prism of area cell² and height (surface − base)."""
    h = np.asarray(z) - np.asarray(base)
    valid = toe_mask & np.isfinite(h)
    if hasattr(z, "mask"):
        valid &= ~z.mask
    heights = np.where(valid, h, 0.0)
    cell_area = cell_m ** 2

    positive = float(np.clip(heights, 0, None).sum()) * cell_area
    negative = float(-np.clip(heights, None, 0).sum()) * cell_area
    return {
        "volume_m3": round(positive - negative, 1),
        "above_base_m3": round(positive, 1),
        "below_base_m3": round(negative, 1),
        "footprint_m2": round(float(valid.sum()) * cell_area, 1),
        "cells": int(valid.sum()),
        "max_height_m": round(float(np.nanmax(np.where(valid, h, np.nan))), 3),
        "mean_height_m": round(float(np.nanmean(np.where(valid, h, np.nan))), 3),
        "nodata_cells_in_footprint": int((toe_mask & ~valid).sum()),
    }
```

Prism integration over a grid is exact for the grid it is given and is the standard method. A TIN-based integration gives a slightly different answer on the same data — typically within 0.3% — because it interpolates the surface differently, and neither is more correct.

`below_base_m3` is a useful diagnostic that a single volume number hides. A pile with 40 m³ below its base either has a base that is too high, or sits in a depression that the toe triangulation could not see. Either way it is information.

`nodata_cells_in_footprint` is the other one to watch: cells inside the toe with no surface data, usually from a reflective or steep face the photogrammetry could not reconstruct. Those cells contribute zero, which understates the volume, and the count says by how much it might.

### 4. Build the error budget

```python
def error_budget(z, base, toe_mask, cell_m, surface_sigma_m,
                 base_sigma_m, toe_sensitivity_m3, correlation_length_m=2.0,
                 confidence=1.96):
    """Four independent contributions, combined in quadrature."""
    cell_area = cell_m ** 2
    footprint = float(toe_mask.sum()) * cell_area
    n_cells = int(toe_mask.sum())

    # 1. Surface noise: partly random, correlated over a few metres.
    corr_cells = max((correlation_length_m / cell_m) ** 2, 1.0)
    independent = max(n_cells / corr_cells, 1.0)
    surface_term = surface_sigma_m * cell_area * math.sqrt(independent)

    # 2. Base surface: a systematic offset over the whole footprint.
    base_term = base_sigma_m * footprint

    # 3. Toe position: from re-running the delineation at a different threshold.
    toe_term = toe_sensitivity_m3

    # 4. Grid discretisation: half a cell of horizontal ambiguity at the perimeter.
    perimeter_cells = int((toe_mask & ~ndimage.binary_erosion(toe_mask)).sum())
    perimeter_m = perimeter_cells * cell_m
    mean_edge_height = 0.35
    grid_term = perimeter_m * (cell_m / 2.0) * mean_edge_height

    total = math.sqrt(surface_term ** 2 + base_term ** 2
                      + toe_term ** 2 + grid_term ** 2)
    return {
        "footprint_m2": round(footprint, 1),
        "terms_m3": {
            "surface_noise": round(surface_term, 1),
            "base_surface": round(base_term, 1),
            "toe_position": round(toe_term, 1),
            "grid_discretisation": round(grid_term, 1),
        },
        "dominant": max({"surface_noise": surface_term, "base_surface": base_term,
                         "toe_position": toe_term,
                         "grid_discretisation": grid_term}.items(),
                        key=lambda kv: kv[1])[0],
        "combined_1sigma_m3": round(total, 1),
        "expanded_m3": round(total * confidence, 1),
        "confidence": f"{int(confidence * 100 / 1.96 * 0.95)}%",
    }

def toe_sensitivity(z, base_fn, cell_m, thresholds=(9.0, 12.0, 16.0, 20.0)):
    """Re-run the whole measurement at several toe thresholds; the spread is the term."""
    results = []
    for t in thresholds:
        mask, info = toe_from_slope(z, cell_m, slope_threshold_deg=t)
        if mask is None:
            continue
        base, binfo = base_fn(z, mask, cell_m)
        if base is None:
            continue
        vol = prism_volume(z, base, mask, cell_m)
        results.append({"threshold_deg": t, "volume_m3": vol["volume_m3"],
                        "footprint_m2": vol["footprint_m2"]})
    if len(results) < 2:
        return 0.0, {"measurable": False}
    vols = [r["volume_m3"] for r in results]
    spread = (max(vols) - min(vols)) / 2.0
    return spread, {"measurable": True, "runs": results,
                    "half_range_m3": round(spread, 1)}
```

Combining in quadrature is right because the four contributions are independent, and the point of writing them out separately is to see which dominates. On almost every real pile it is the base surface, which tells you where to spend effort: another hour surveying spot heights under the toe is worth more than a better camera.

The toe term measured by re-running the delineation, rather than assumed, is what makes this an error budget rather than a guess. It costs three extra runs of a fast calculation and produces a number nobody can argue with.

The grid term is usually small and is included because it is the one a reviewer will ask about: a half-cell horizontal ambiguity around a 140 m perimeter at 35 cm mean edge height is about 2.5 m³ at a 10 cm cell, which is negligible, and demonstrating that it is negligible is worth the three lines.

### 5. Convert to tonnes only with a stated density

```python
def to_tonnes(volume_m3, bulk_density_t_per_m3, density_sigma,
              volume_sigma_m3, moisture_pct=None):
    mass = volume_m3 * bulk_density_t_per_m3
    rel_v = volume_sigma_m3 / max(volume_m3, 1e-9)
    rel_d = density_sigma / max(bulk_density_t_per_m3, 1e-9)
    rel_total = math.hypot(rel_v, rel_d)
    out = {
        "volume_m3": round(volume_m3, 1),
        "bulk_density_t_per_m3": bulk_density_t_per_m3,
        "mass_t": round(mass, 1),
        "mass_uncertainty_t": round(mass * rel_total, 1),
        "relative_from_volume_pct": round(rel_v * 100, 2),
        "relative_from_density_pct": round(rel_d * 100, 2),
        "dominant": "density" if rel_d > rel_v else "volume",
    }
    if moisture_pct is not None:
        out["dry_mass_t"] = round(mass / (1 + moisture_pct / 100.0), 1)
        out["moisture_pct"] = moisture_pct
    return out

print(to_tonnes(4218.4, bulk_density_t_per_m3=1.62, density_sigma=0.08,
                volume_sigma_m3=48.2, moisture_pct=6.5))
```

Tonnage is what gets invoiced and the density is almost always the larger uncertainty. A bulk density of 1.62 ± 0.08 t/m³ is a 4.9% relative uncertainty against roughly 1.1% from the volume — so a survey accurate to 1% delivers a tonnage accurate to 5%, and reporting the tonnage without the density uncertainty misrepresents the measurement entirely.

Saying so explicitly is also the professional move: it moves the conversation from "is your survey accurate?" to "where did the density figure come from?", which is the question that actually matters.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="pile-base-t pile-base-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pile-base-t">Base surface methods ranked by what they assume</title>
  <desc id="pile-base-d">A table of five base surface methods ordered by how much each assumes. A prior survey of the same ground measures the base and assumes nothing, giving an uncertainty of one to two centimetres. Levelled spot heights under the toe are nearly as good. A triangulated toe ring assumes the ground under the pile follows its toe. A best-fit plane assumes the hardstanding is flat. A single constant level assumes a known slab.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="268" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="286" y="20" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="522" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="268" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="54" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="522" y="54" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="268" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="88" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="522" y="88" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="268" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="286" y="122" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="522" y="122" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="268" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="286" y="156" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="522" y="156" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="190" width="268" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="286" y="190" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="522" y="190" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="152" y="42">method</text><text x="404" y="42">assumes</text><text x="622" y="42">base sigma</text>
    <text x="152" y="76">prior survey of the ground</text><text x="404" y="76">nothing</text><text x="622" y="76">0.01–0.02 m</text>
    <text x="152" y="110">levelled spot heights</text><text x="404" y="110">interpolation between them</text><text x="622" y="110">0.02–0.03 m</text>
    <text x="152" y="144">triangulated toe ring</text><text x="404" y="144">ground follows the toe</text><text x="622" y="144">0.05 m</text>
    <text x="152" y="178">best-fit plane through the toe</text><text x="404" y="178">the hardstanding is flat</text><text x="622" y="178">0.05–0.08 m</text>
    <text x="152" y="212">single constant level</text><text x="404" y="212">a known flat slab</text><text x="622" y="212">0.10 m or worse</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">The base is the dominant error term on almost every pile, so this choice decides the uncertainty.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">An hour surveying spot heights under the toe is worth more than a better camera.</text>
</svg>
<figcaption>The base surface dominates the error budget, so the method chosen decides the reported uncertainty.</figcaption>
</figure>

### 6. Produce the report

```python
def stockpile_report(las_path, out_dir="build/stockpile", cell_m=0.10,
                     base_method="toe_triangulation", prior_tif=None,
                     surface_sigma_m=0.025, base_sigma_m=0.05,
                     bulk_density=None, density_sigma=None):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    z, transform, crs, res = surface_grid(las_path, f"{out_dir}/surface.tif", cell_m=cell_m)

    toe_mask, toe_info = toe_from_slope(z, res)
    if toe_mask is None:
        raise RuntimeError(f"toe delineation failed: {toe_info['reason']}")

    base_fn = {"toe_triangulation": base_from_toe_triangulation,
               "best_fit_plane": lambda zz, mm, cc: base_from_plane(zz, mm)}[base_method]
    base, base_info = (base_from_prior(prior_tif, z.shape) if prior_tif
                       else base_fn(z, toe_mask, res))
    vol = prism_volume(z, base, toe_mask, res)
    toe_term, toe_detail = toe_sensitivity(z, base_fn, res)
    budget = error_budget(z, base, toe_mask, res, surface_sigma_m, base_sigma_m, toe_term)

    report = {
        "survey": {"source": Path(las_path).name, "cell_m": res,
                   "crs": str(crs), "surface_statistic": "max"},
        "toe": toe_info,
        "base": {**base_info, "declared_method": base_info.get("method", base_method),
                 "assumed_sigma_m": base_sigma_m},
        "volume": vol,
        "toe_sensitivity": toe_detail,
        "uncertainty": budget,
        "headline": f"{vol['volume_m3']:.0f} ± {budget['expanded_m3']:.0f} m³ "
                    f"({budget['expanded_m3'] / max(vol['volume_m3'], 1) * 100:.1f}%), "
                    f"base from {base_info.get('method', base_method)}",
    }
    if bulk_density:
        report["mass"] = to_tonnes(vol["volume_m3"], bulk_density, density_sigma or 0.08,
                                   budget["expanded_m3"])
    Path(f"{out_dir}/report.json").write_text(json.dumps(report, indent=2))
    return report

print(json.dumps(stockpile_report("input/pile_a.laz", bulk_density=1.62), indent=2))
```

<figure class="diagram">
<svg viewBox="26 12 688 230" role="img" aria-labelledby="pile-budget-t pile-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pile-budget-t">Where the uncertainty comes from</title>
  <desc id="pile-budget-d">A bar chart of the four error terms for a 4218 cubic metre pile with a 1412 square metre footprint. The base surface contributes 71 cubic metres and dominates. Toe position contributes 42. Surface noise contributes 9. Grid discretisation contributes 2.5. Combined in quadrature the one-sigma uncertainty is 83 cubic metres and the expanded 95 percent figure is 163, about 3.9 percent of the volume.</desc>
  <rect class="svg-bg" x="26" y="12" width="688" height="230" fill="#ffffff"/>
  <path d="M40 26 V176 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="284" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="70" width="168" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="106" width="36" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="142" width="10" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="334" y="52">base surface: 71 m³ (5 cm over 1,412 m²)</text>
    <text x="218" y="88">toe position: 42 m³ (re-run at 9°–20°)</text>
    <text x="86" y="124">surface noise: 9 m³ (2.5 cm, 141k cells)</text>
    <text x="60" y="160">grid discretisation: 2.5 m³</text>
  </g>
  <text x="40" y="200" fill="#1f2937" font-size="12.5">combined 1σ: 83 m³ · expanded 95%: 163 m³ · headline 4,218 ± 163 m³ (3.9%)</text>
  <text x="40" y="224" fill="#5b6471" font-size="12">the survey's own point accuracy is the smallest term; the base assumption is 8× larger</text>
</svg>
<figcaption>Better survey accuracy would move the smallest bar; surveying the ground under the pile before it was built would remove the largest.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "survey": {"source": "pile_a.laz", "cell_m": 0.1, "crs": "EPSG:25832",
             "surface_statistic": "max"},
  "toe": {"found": true, "regions_considered": 14, "candidates_over_min_area": 1,
          "footprint_m2": 1412.4, "slope_threshold_deg": 12.0},
  "base": {"ok": true, "toe_samples": 1184, "toe_height_range_m": 0.184,
           "method": "toe_triangulation", "declared_method": "toe_triangulation",
           "assumed_sigma_m": 0.05},
  "volume": {"volume_m3": 4218.4, "above_base_m3": 4226.1, "below_base_m3": 7.7,
             "footprint_m2": 1412.4, "cells": 141240, "max_height_m": 8.412,
             "mean_height_m": 2.987, "nodata_cells_in_footprint": 184},
  "toe_sensitivity": {"measurable": true, "half_range_m3": 42.1, "runs": [
     {"threshold_deg": 9.0, "volume_m3": 4279.8, "footprint_m2": 1508.2},
     {"threshold_deg": 12.0, "volume_m3": 4218.4, "footprint_m2": 1412.4},
     {"threshold_deg": 16.0, "volume_m3": 4212.0, "footprint_m2": 1364.1},
     {"threshold_deg": 20.0, "volume_m3": 4195.6, "footprint_m2": 1298.4}]},
  "uncertainty": {"terms_m3": {"surface_noise": 9.2, "base_surface": 70.6,
                               "toe_position": 42.1, "grid_discretisation": 2.5},
                  "dominant": "base_surface",
                  "combined_1sigma_m3": 82.9, "expanded_m3": 162.5},
  "headline": "4218 ± 163 m³ (3.9%), base from toe_triangulation",
  "mass": {"volume_m3": 4218.4, "bulk_density_t_per_m3": 1.62, "mass_t": 6833.8,
           "mass_uncertainty_t": 352.1, "relative_from_volume_pct": 3.85,
           "relative_from_density_pct": 4.94, "dominant": "density"}
}
```

The headline is the deliverable: "4,218 ± 163 m³ (3.9%), base from toe triangulation". The 0.184 m toe height range confirms the hardstanding is flat enough for the triangulated base to be reasonable, and the 184 nodata cells inside the footprint are 1.84 m² — small enough to ignore and worth stating.

The mass line is where the conversation usually goes, and there the density's 4.94% dominates the volume's 3.85%.

Verify the volume against an independent integration method, since a bug in the masking or the base would not be visible in the number:

```python
def tin_cross_check(las_path, toe_mask, base, transform, cell_m, tolerance_pct=1.0):
    """Integrate the same surface as a TIN and compare with the prism result."""
    import trimesh
    from scipy.spatial import Delaunay

    ys, xs = np.nonzero(toe_mask)
    z_surf = np.asarray(surface_z)[toe_mask]
    z_base = np.asarray(base)[toe_mask]
    keep = np.isfinite(z_surf) & np.isfinite(z_base)
    east = transform.c + (xs[keep] + 0.5) * cell_m
    north = transform.f - (ys[keep] + 0.5) * cell_m
    pts2d = np.column_stack([east, north])
    tri = Delaunay(pts2d)

    a = pts2d[tri.simplices[:, 0]]
    b = pts2d[tri.simplices[:, 1]]
    c = pts2d[tri.simplices[:, 2]]
    area = 0.5 * np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1])
                        - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1]))
    h = (z_surf[keep] - z_base[keep])
    mean_h = (h[tri.simplices[:, 0]] + h[tri.simplices[:, 1]]
              + h[tri.simplices[:, 2]]) / 3.0
    tin_volume = float((area * mean_h).sum())

    diff_pct = 100.0 * (tin_volume - prism_result["volume_m3"]) \
        / max(prism_result["volume_m3"], 1e-9)
    return {"tin_m3": round(tin_volume, 1),
            "prism_m3": prism_result["volume_m3"],
            "difference_pct": round(diff_pct, 3),
            "agrees": abs(diff_pct) <= tolerance_pct,
            "note": "TIN and prism differ by their surface interpolation; "
                    "under 1% is expected"}
```

Prism and TIN integration agreeing within 1% is a genuine check that the footprint, the base and the surface are all being read consistently. A 15% disagreement means one of them is including cells the other is not — usually nodata handling.

Then verify against the physical geometry, which catches a whole class of unit and datum errors:

```python
def plausibility_check(report, angle_of_repose_deg=(28.0, 42.0)):
    """A pile's volume, footprint and height are geometrically related."""
    v = report["volume"]["volume_m3"]
    a = report["volume"]["footprint_m2"]
    h_max = report["volume"]["max_height_m"]
    h_mean = report["volume"]["mean_height_m"]

    # A cone of this footprint and height would have volume A·h/3; a flat-topped
    # pile lies between A·h/3 and A·h.
    cone = a * h_max / 3.0
    prism = a * h_max
    equivalent_radius = math.sqrt(a / math.pi)
    implied_angle = math.degrees(math.atan(h_max / max(equivalent_radius, 1e-6)))

    return {
        "volume_m3": round(v, 1),
        "cone_bound_m3": round(cone, 1),
        "prism_bound_m3": round(prism, 1),
        "within_geometric_bounds": cone * 0.9 <= v <= prism * 1.1,
        "mean_over_max_height": round(h_mean / max(h_max, 1e-9), 3),
        "implied_flank_angle_deg": round(implied_angle, 1),
        "angle_plausible": angle_of_repose_deg[0] <= implied_angle <= angle_of_repose_deg[1],
        "verdict": "geometry consistent"
                   if (cone * 0.9 <= v <= prism * 1.1)
                   else "volume inconsistent with footprint and height — check units",
    }

print(json.dumps(plausibility_check(report), indent=2))
```

A volume outside the cone-to-prism bounds for its own footprint and height cannot be right, and this check catches a metre/foot mix-up, a wrong cell size and a base surface at the wrong datum — all of which produce a volume that looks like a number and fails basic geometry.

## Performance Notes

- **A 10 cm grid over a 1,400 m² pile is 141,000 cells**, so every step after rasterisation is milliseconds.
- **Rasterisation at 10 cm from a 40-million-point cloud takes about a minute.** That is the only slow step.
- **Use 5–10 cm cells for a stockpile**, not the 25–50 cm used for site-wide differencing: the pile's perimeter is where the grid term lives, and a finer cell shrinks it.
- **The toe sensitivity run costs four full integrations**, which is seconds. Always run it.
- **`griddata` with `linear` over 141,000 cells from 1,184 toe samples is under a second.** For much larger footprints, a coarser base grid interpolated up is faster and no less accurate.
- **Store the surface, base and footprint rasters.** A disputed volume is re-examined, not re-surveyed.

## Common Errors

**Toe delineation picks up a neighbouring pile.** The largest connected region won. Restrict to a supplied boundary polygon, or raise `min_area_m2` and select by proximity to a seed point.

**Volume is negative.** The base is above the surface — a prior survey from the wrong epoch, or a datum mismatch.

**`below_base_m3` is large.** The base assumption is wrong, or the pile sits in a hollow. Investigate before reporting.

**Uncertainty is under 1%.** The base sigma was set optimistically. A triangulated base on unknown ground is rarely better than 5 cm.

**Tonnage disputed.** The density, almost always. Ask for the source of the figure and its uncertainty.

**Volume differs from the contractor's by 8%.** Compare footprints first: toe definition accounts for most inter-surveyor disagreement, and comparing the two toe polygons settles it faster than comparing methods.

**Nodata cells inside the footprint.** Steep or reflective faces the survey missed. Report the area; consider a second flight with more oblique imagery.

## Frequently Asked Questions

### What uncertainty should I expect?

For a well-flown drone survey on flat hardstanding with a triangulated base, 2–5% expanded is typical. With a prior survey of the ground, 1–2%. Anyone quoting better than 1% on a triangulated base is not counting the base.

### Should the report include the raw volume without uncertainty?

No. A volume without an uncertainty invites false precision, and the uncertainty is the part that lets a surveyor decide whether the number supports a payment.

### How do I handle a pile against a wall?

The toe ring is incomplete, so the base cannot be triangulated across the footprint from it alone. Survey spot heights along the wall line, or use the prior survey — and if neither is available, say the base is assumed and raise its sigma accordingly.

## Related Guides

- [DSM Differencing for Volume Change](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/dsm-differencing-for-volume-change/) — volume between two epochs rather than against a base
- [Excluding Vegetation from Change Detection](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/excluding-vegetation-from-change-detection/) — the mask a vegetated pile needs
- [Delaunay Meshing of Terrain with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/delaunay-meshing-of-terrain-with-pdal/) — the TIN used in the cross-check

Back to [Change Detection Between Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
