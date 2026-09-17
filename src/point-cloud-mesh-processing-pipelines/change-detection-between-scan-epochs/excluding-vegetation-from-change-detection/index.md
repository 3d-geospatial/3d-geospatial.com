---
title: "Excluding Vegetation from Change Detection"
description: "Stop seasonal growth appearing as earthworks: classification-based masks, return-number and geometric cues"
---
# Excluding Vegetation from Change Detection

This page removes vegetation from a change-detection run so that a hedge growing 40 cm between epochs does not appear as 40 cm of fill — combining a classification mask, return-number and geometric cues for unclassified data, a union mask that covers vegetation present in *either* epoch, and an audit that proves the exclusion worked without also removing the earthworks.

## Why you hit this

Vegetation is the single largest source of false change on any site with plants on it. Between a June and a September survey, grass grows, a hedge thickens, trees leaf out and a spoil heap sprouts weeds — and every one of those shows up in a DSM difference as positive height change indistinguishable from fill.

On a site where 15% of the area carries vegetation, seasonal growth of 30 cm across that area is 3,600 m³ of fictitious fill on a 80,000 m² site. That is frequently larger than the real movement, which makes vegetation masking not an improvement but a prerequisite.

## Prerequisites

- Two epochs of point cloud, ideally classified; unclassified works with the geometric path.
- Python 3.10+ with `numpy`, `rasterio`, `scipy`, `pdal`.
- The differencing pipeline from [DSM differencing for volume change](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/dsm-differencing-for-volume-change/).

## Step-by-Step

### 1. Use the classification if it is trustworthy

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import rasterio

ASPRS = {
    "unclassified": 1, "ground": 2, "low_veg": 3, "med_veg": 4, "high_veg": 5,
    "building": 6, "low_noise": 7, "water": 9, "rail": 10, "road": 11,
    "wire_guard": 13, "wire_conductor": 14, "bridge": 17, "high_noise": 18,
}
VEGETATION = {3, 4, 5}

def classification_histogram(las_path):
    out = subprocess.run(["pdal", "info", "--stats",
                          "--dimensions", "Classification", str(las_path)],
                         capture_output=True, text=True, check=True)
    stats = json.loads(out.stdout)["stats"]["statistic"][0]
    counts = subprocess.run(["pdal", "info", "--metadata", str(las_path)],
                            capture_output=True, text=True, check=True)
    meta = json.loads(counts.stdout)
    return {"count": int(stats.get("count", 0)),
            "min": stats.get("minimum"), "max": stats.get("maximum"),
            "note": "a max of 2 with no 3/4/5 means the data was never vegetation-classified"}

def classification_is_usable(hist, veg_fraction_threshold=0.005):
    """A cloud with 0.1% vegetation on a green site was not classified properly."""
    return {
        "has_vegetation_classes": (hist.get("max") or 0) >= 3,
        "usable": (hist.get("max") or 0) >= 3,
        "advice": "use the classification mask"
                  if (hist.get("max") or 0) >= 3
                  else "fall back to geometric cues — see step 3",
    }
```

Checking whether the classification exists before relying on it saves a confusing afternoon. Deliveries described as "classified" frequently contain only classes 1 and 2, because the vendor's ground classification ran and the vegetation classification did not — and a mask built from classes 3, 4 and 5 on that data excludes nothing.

Where classes do exist, their quality still varies. A quick sanity check is the vegetation fraction against what the site looks like on an aerial image: 0.3% vegetation on a site that is visibly a third grass means the classification is not usable for masking.

### 2. Build the mask from the union of both epochs

```python
def vegetation_raster(las_path, grid, out_tif, classes=VEGETATION, cell_m=0.25):
    """Rasterise a presence mask: 1 where any vegetation point falls in the cell."""
    limits = ",".join(f"Classification[{c}:{c}]" for c in sorted(classes))
    pipeline = {"pipeline": [
        str(las_path),
        {"type": "filters.expression",
         "expression": " || ".join(f"Classification == {c}" for c in sorted(classes))},
        {"type": "writers.gdal", "filename": str(out_tif), "gdaldriver": "GTiff",
         "output_type": "count", "resolution": cell_m,
         "origin_x": grid["west"], "origin_y": grid["south"],
         "width": grid["width"], "height": grid["height"],
         "nodata": 0, "data_type": "uint16",
         "gdalopts": "COMPRESS=DEFLATE,TILED=YES"},
    ]}
    spec = Path(out_tif).with_suffix(".json")
    spec.write_text(json.dumps(pipeline, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    with rasterio.open(out_tif) as ds:
        counts = ds.read(1)
    return counts

def union_mask(counts_a, counts_b, min_points=2, dilate_cells=2):
    """Exclude a cell if either epoch had vegetation there."""
    from scipy import ndimage
    veg = (counts_a >= min_points) | (counts_b >= min_points)
    if dilate_cells:
        veg = ndimage.binary_dilation(veg, iterations=dilate_cells)
    return veg, {
        "cells_a": int((counts_a >= min_points).sum()),
        "cells_b": int((counts_b >= min_points).sum()),
        "cells_union": int(((counts_a >= min_points) | (counts_b >= min_points)).sum()),
        "cells_after_dilation": int(veg.sum()),
        "fraction_excluded": round(float(veg.mean()), 4),
    }
```

Taking the **union** rather than the intersection is the decision that matters here, and it is counter-intuitive. A tree that was felled between epochs is vegetation in epoch A and bare ground in epoch B; the difference there is a real 8 m drop that is not earthworks, so it must be excluded — and an intersection mask would keep it.

Dilating the mask by a couple of cells accounts for the fact that a vegetation point's influence extends beyond its own cell: a hedge's canopy overhangs, and the DSM cell at its edge takes a maximum from a leaf. Two cells at 25 cm is 50 cm of buffer, which covers most of it without eating the adjacent ground.

The cost of the union plus dilation is that more area is excluded, which is the right trade: an excluded area is reported as "not measured" while a contaminated area is reported as a volume.

<figure class="diagram">
<svg viewBox="4 6 732 258" role="img" aria-labelledby="veg-union-t veg-union-d" xmlns="http://www.w3.org/2000/svg">
  <title id="veg-union-t">Union versus intersection of the two epochs' vegetation</title>
  <desc id="veg-union-d">Three cases across two epochs. A hedge present in both epochs that grew 40 centimetres is caught by either mask. A tree present in epoch A and felled before epoch B produces an 8 metre drop and is caught only by the union mask. New planting present only in epoch B produces a 2 metre rise and is also caught only by the union. The intersection mask leaves both of the latter in the volume calculation.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="258" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="180" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="198" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="324" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="450" y="20" width="136" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="586" y="20" width="136" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="180" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="198" y="52" width="126" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="324" y="52" width="126" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="52" width="136" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="586" y="52" width="136" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="94" width="180" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="198" y="94" width="126" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="324" y="94" width="126" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="450" y="94" width="136" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="586" y="94" width="136" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="136" width="180" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="198" y="136" width="126" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="324" y="136" width="126" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="136" width="136" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="586" y="136" width="136" height="42" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="108" y="41">case</text><text x="261" y="41">veg in A</text>
    <text x="387" y="41">veg in B</text><text x="518" y="41">union masks it</text>
    <text x="654" y="41">intersection does</text>
    <text x="108" y="70">hedge grew 40 cm</text><text x="108" y="86">both epochs</text>
    <text x="261" y="78">yes</text><text x="387" y="78">yes</text>
    <text x="518" y="78">yes</text><text x="654" y="78">yes</text>
    <text x="108" y="112">tree felled</text><text x="108" y="128">−8 m apparent cut</text>
    <text x="261" y="120">yes</text><text x="387" y="120">no</text>
    <text x="518" y="120">yes</text><text x="654" y="120">no — counted as cut</text>
    <text x="108" y="154">new planting</text><text x="108" y="170">+2 m apparent fill</text>
    <text x="261" y="162">no</text><text x="387" y="162">yes</text>
    <text x="518" y="162">yes</text><text x="654" y="162">no — counted as fill</text>
  </g>
  <text x="370" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">an intersection mask leaves the two largest single-cell errors in the calculation</text>
  <text x="370" y="226" fill="#5b6471" font-size="12" text-anchor="middle">the union excludes more area, which is reported as unmeasured rather than as volume</text>
  <text x="370" y="246" fill="#5b6471" font-size="12" text-anchor="middle">a felled tree is real change and real information — it is just not earthworks</text>
</svg>
<figcaption>The felled tree and the new planting are the expensive cases, and only the union mask catches them.</figcaption>
</figure>

### 3. Fall back to geometric cues when there is no classification

```python
def geometric_vegetation_mask(las_path, grid, out_prefix, cell_m=0.25):
    """Three cues that separate vegetation from hard surfaces, none needing a classifier."""
    products = {}

    # (a) Multiple returns: vegetation is penetrable, hard surfaces are not.
    multi_pipeline = {"pipeline": [
        str(las_path),
        {"type": "filters.expression", "expression": "NumberOfReturns > 1"},
        {"type": "writers.gdal", "filename": f"{out_prefix}_multi.tif",
         "output_type": "count", "resolution": cell_m, "nodata": 0,
         "origin_x": grid["west"], "origin_y": grid["south"],
         "width": grid["width"], "height": grid["height"], "data_type": "uint16"},
    ]}

    # (b) Height spread within a cell: a canopy has vertical structure, tarmac does not.
    spread_pipeline = {"pipeline": [
        str(las_path),
        {"type": "writers.gdal", "filename": f"{out_prefix}_max.tif",
         "output_type": "max", "resolution": cell_m, "nodata": -9999.0,
         "origin_x": grid["west"], "origin_y": grid["south"],
         "width": grid["width"], "height": grid["height"], "data_type": "float32"},
        {"type": "writers.gdal", "filename": f"{out_prefix}_min.tif",
         "output_type": "min", "resolution": cell_m, "nodata": -9999.0,
         "origin_x": grid["west"], "origin_y": grid["south"],
         "width": grid["width"], "height": grid["height"], "data_type": "float32"},
    ]}

    # (c) Total return count per cell, for normalising (a).
    all_pipeline = {"pipeline": [
        str(las_path),
        {"type": "writers.gdal", "filename": f"{out_prefix}_all.tif",
         "output_type": "count", "resolution": cell_m, "nodata": 0,
         "origin_x": grid["west"], "origin_y": grid["south"],
         "width": grid["width"], "height": grid["height"], "data_type": "uint16"},
    ]}

    for name, pipe in (("multi", multi_pipeline), ("spread", spread_pipeline),
                       ("all", all_pipeline)):
        spec = Path(f"{out_prefix}_{name}.json")
        spec.write_text(json.dumps(pipe, indent=2))
        subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
        products[name] = spec.name
    return products

def combine_geometric_cues(out_prefix, multi_fraction=0.25, spread_m=0.35,
                           roughness_m=0.12, cell_m=0.25):
    def read(name, fill=0.0):
        with rasterio.open(f"{out_prefix}_{name}.tif") as ds:
            a = ds.read(1).astype("float64")
            nd = ds.nodata
            if nd is not None:
                a = np.where(np.isclose(a, nd), fill, a)
            return a

    multi = read("multi")
    total = np.maximum(read("all"), 1.0)
    zmax = read("max", fill=np.nan)
    zmin = read("min", fill=np.nan)

    penetrable = (multi / total) >= multi_fraction
    structured = np.nan_to_num(zmax - zmin, nan=0.0) >= spread_m

    # Local roughness of the top surface: vegetation is rough at cell scale.
    from scipy import ndimage
    smooth = ndimage.uniform_filter(np.nan_to_num(zmax, nan=0.0), size=5)
    rough = np.abs(np.nan_to_num(zmax, nan=0.0) - smooth) >= roughness_m

    votes = penetrable.astype(np.uint8) + structured.astype(np.uint8) + rough.astype(np.uint8)
    veg = votes >= 2
    return veg, {
        "penetrable_cells": int(penetrable.sum()),
        "structured_cells": int(structured.sum()),
        "rough_cells": int(rough.sum()),
        "two_of_three": int(veg.sum()),
        "fraction": round(float(veg.mean()), 4),
    }
```

Requiring two of the three cues to agree is what keeps the geometric path usable. Each cue alone has a clear failure case: multiple returns also occur at building edges, height spread is large on a kerb or a stockpile edge, and roughness is high on rip-rap and on gravel. Two agreeing cues eliminates most of those, because the failure cases differ.

The `NumberOfReturns > 1` cue is the strongest of the three for airborne lidar and is unavailable for photogrammetry, which has no returns at all. A photogrammetric site has to rely on roughness and height spread, plus colour if the cloud carries RGB — an excess-green index is a cheap and effective fourth cue there.

### 4. Add a seasonal buffer where vegetation is unavoidable

```python
def seasonal_buffer_mask(veg_mask, difference, epoch_gap_months, growth_rate_m_per_month=0.06,
                         cell_m=0.25):
    """Cells adjacent to vegetation get a raised detection threshold rather than exclusion."""
    from scipy import ndimage
    near_veg = ndimage.binary_dilation(veg_mask, iterations=4) & ~veg_mask
    plausible_growth = growth_rate_m_per_month * epoch_gap_months
    suspicious = near_veg & (difference > 0) & (difference < plausible_growth * 1.5)
    return suspicious, {
        "near_vegetation_cells": int(near_veg.sum()),
        "plausible_growth_m": round(plausible_growth, 3),
        "flagged_as_probable_growth": int(suspicious.sum()),
        "flagged_area_m2": round(float(suspicious.sum()) * cell_m ** 2, 1),
    }
```

A buffer zone treated as suspicious rather than excluded is the middle path for the cells just outside the mask, where a canopy's edge influences the surface without any vegetation point landing in the cell. Raising the detection threshold there to the plausible seasonal growth means a 15 cm change next to a hedge is discarded while a 2 m change next to the same hedge is kept.

The growth rate is a site-specific number — 6 cm per month is a reasonable figure for grass and shrubs in a temperate growing season and far too low for a spring flush or for bamboo. Getting it roughly right matters more than getting it exactly right.

### 5. Report what was excluded, not just the volume

```python
def masked_volumes(difference, significant, veg_mask, suspicious, cell_m):
    cell_area = cell_m * cell_m
    usable = significant & ~veg_mask & ~suspicious
    vals = np.where(usable, difference, 0.0)
    fill = float(np.nansum(np.clip(vals, 0, None))) * cell_area
    cut = float(-np.nansum(np.clip(vals, None, 0))) * cell_area

    excluded_change = np.where(significant & (veg_mask | suspicious), difference, 0.0)
    excl_fill = float(np.nansum(np.clip(excluded_change, 0, None))) * cell_area
    excl_cut = float(-np.nansum(np.clip(excluded_change, None, 0))) * cell_area

    return {
        "measured": {
            "fill_m3": round(fill, 1), "cut_m3": round(cut, 1),
            "net_m3": round(fill - cut, 1),
            "area_m2": round(float(usable.sum()) * cell_area, 1),
        },
        "excluded_as_vegetation": {
            "would_have_been_fill_m3": round(excl_fill, 1),
            "would_have_been_cut_m3": round(excl_cut, 1),
            "area_m2": round(float((veg_mask | suspicious).sum()) * cell_area, 1),
            "share_of_site": round(float((veg_mask | suspicious).mean()), 4),
        },
        "unmeasured_fraction": round(float((veg_mask | suspicious).mean()), 4),
    }
```

Reporting the volume that *would* have been counted is what makes the masking auditable and is the number that convinces a sceptical reader. "3,612 m³ of apparent fill excluded as vegetation across 11,840 m²" tells them the masking mattered; silently excluding it tells them nothing and invites the question "did you account for the trees?".

It also functions as a check on the mask itself. If the excluded volume is a few cubic metres, the mask is not doing anything and probably is not needed; if it exceeds the measured volume, the site is too vegetated for DSM differencing and needs a different method.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="veg-cues-t veg-cues-d" xmlns="http://www.w3.org/2000/svg">
  <title id="veg-cues-t">Geometric cues when there is no classification</title>
  <desc id="veg-cues-d">A table of three geometric vegetation cues with their reliability and failure case. Multiple returns per pulse is the strongest cue for airborne lidar and is unavailable for photogrammetry. Height spread within a cell is reliable and also fires on kerbs and stockpile edges. Local roughness of the top surface is reliable and also fires on rip-rap and gravel. Requiring two of the three to agree eliminates most of the false positives because the failure cases differ.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="248" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="20" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="476" y="20" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="54" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="54" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="88" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="88" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="122" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="122" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="248" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="156" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="476" y="156" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="142" y="42">cue</text><text x="371" y="42">strength</text><text x="599" y="42">also fires on</text>
    <text x="142" y="76">multiple returns per pulse</text><text x="371" y="76">strongest, lidar only</text><text x="599" y="76">building edges</text>
    <text x="142" y="110">height spread in a cell</text><text x="371" y="110">reliable</text><text x="599" y="110">kerbs, stockpile edges</text>
    <text x="142" y="144">local surface roughness</text><text x="371" y="144">reliable</text><text x="599" y="144">rip-rap, gravel</text>
    <text x="142" y="178">two of the three agreeing</text><text x="371" y="178">the working rule</text><text x="599" y="178">very little</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Each cue alone has a clear false positive; the three fail on different things, which is why voting works.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Photogrammetry has no returns at all, so an excess-green index becomes the third cue.</text>
</svg>
<figcaption>No single cue is trustworthy alone; requiring two of three works because their failure cases differ.</figcaption>
</figure>

### 6. Audit for residual vegetation signal

```python
def residual_audit(difference, significant, veg_mask, cell_m, epoch_gap_months,
                   growth_rate_m_per_month=0.06):
    """After masking, the surviving change should not look like growth."""
    usable = significant & ~veg_mask
    vals = difference[usable]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return {"measurable": False}

    plausible = growth_rate_m_per_month * epoch_gap_months
    small_positive = (vals > 0) & (vals < plausible * 1.5)
    from scipy import ndimage
    labels, n = ndimage.label(usable & (difference > 0)
                              & (difference < plausible * 1.5))
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) \
        if n else np.array([])

    return {
        "measurable": True,
        "usable_cells": int(usable.sum()),
        "positive_share": round(float((vals > 0).mean()), 3),
        "small_positive_share": round(float(small_positive.mean()), 3),
        "plausible_growth_m": round(plausible, 3),
        "small_positive_clusters": int(n),
        "median_cluster_cells": int(np.median(sizes)) if sizes.size else 0,
        "verdict": "residual vegetation likely — many small positive patches"
                   if float(small_positive.mean()) > 0.35 and n > 200
                   else "no obvious residual vegetation signal",
    }
```

The signature of residual vegetation is a large number of small, uniformly positive patches with a magnitude near the plausible growth. Earthworks look different: fewer, larger patches, with both signs and magnitudes well above the growth rate.

Computing that signature after masking is what catches an inadequate mask before the volume is published — which is more useful than checking the mask's coverage, because the coverage can look good while missing the one hedge that matters.

<figure class="diagram">
<svg viewBox="40 12 684 232" role="img" aria-labelledby="veg-effect-t veg-effect-d" xmlns="http://www.w3.org/2000/svg">
  <title id="veg-effect-t">Volume before and after vegetation masking</title>
  <desc id="veg-effect-d">A bar comparison on one site between a June and a September survey. Without masking, apparent fill is 7830 cubic metres and apparent cut is 1962. With classification-based masking of the union of both epochs plus a seasonal buffer, measured fill is 4218 and cut is 1804. The difference, 3612 cubic metres of fill and 158 of cut, is reported as excluded vegetation across 11840 square metres, which is 14.8 percent of the site.</desc>
  <rect class="svg-bg" x="40" y="12" width="684" height="232" fill="#ffffff"/>
  <path d="M120 26 V176 H710" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="150" y="34" width="228" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="150" y="70" width="57" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="150" y="112" width="123" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="146" width="53" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="386" y="54">apparent fill 7,830 m³</text>
    <text x="215" y="90">apparent cut 1,962 m³</text>
    <text x="281" y="132">measured fill 4,218 m³</text>
    <text x="211" y="165">measured cut 1,804 m³</text>
  </g>
  <g fill="#5b6471" font-size="12">
    <text x="114" y="54" text-anchor="end">unmasked</text>
    <text x="114" y="90" text-anchor="end">unmasked</text>
    <text x="114" y="132" text-anchor="end">masked</text>
    <text x="114" y="165" text-anchor="end">masked</text>
  </g>
  <text x="120" y="204" fill="#1f2937" font-size="12.5">excluded as vegetation: 3,612 m³ apparent fill, 158 m³ apparent cut</text>
  <text x="120" y="226" fill="#5b6471" font-size="12">over 11,840 m² — 14.8% of the site, reported as unmeasured rather than as volume</text>
</svg>
<figcaption>Three months of growth accounted for 46% of the apparent fill; reporting the excluded figure is what makes the remainder credible.</figcaption>
</figure>

## Expected Output & Verification

```text
{'has_vegetation_classes': True, 'usable': True, 'advice': 'use the classification mask'}
{'cells_a': 148204, 'cells_b': 171882, 'cells_union': 184118,
 'cells_after_dilation': 189440, 'fraction_excluded': 0.1452}
{'penetrable_cells': 174118, 'structured_cells': 201884, 'rough_cells': 168402,
 'two_of_three': 181204, 'fraction': 0.1409}
{'near_vegetation_cells': 61204, 'plausible_growth_m': 0.18,
 'flagged_as_probable_growth': 14882, 'flagged_area_m2': 930.1}
{
  "measured": {"fill_m3": 4218.4, "cut_m3": 1804.2, "net_m3": 2414.2, "area_m2": 68415.9},
  "excluded_as_vegetation": {"would_have_been_fill_m3": 3611.8,
                             "would_have_been_cut_m3": 157.9,
                             "area_m2": 11840.5, "share_of_site": 0.1475},
  "unmeasured_fraction": 0.1475
}
{'measurable': True, 'usable_cells': 172104, 'positive_share': 0.712,
 'small_positive_share': 0.184, 'plausible_growth_m': 0.18,
 'small_positive_clusters': 82, 'median_cluster_cells': 34,
 'verdict': 'no obvious residual vegetation signal'}
```

The classification mask at 14.5% and the geometric mask at 14.1% agreeing closely is a good sign that both are finding the same vegetation — which is worth checking even when the classification is usable, because agreement between independent methods is the only available validation.

The residual audit's 18% small-positive share with 82 clusters is the "clean" pattern. Above about 35% with several hundred clusters, the mask has missed something.

Verify the mask did not eat the earthworks, which is the failure that a coverage check cannot see:

```python
def overmasking_check(veg_mask, difference, significant, cell_m,
                      large_change_m=0.5):
    """Large changes inside the vegetation mask are suspicious: veg does not move 2 m."""
    inside = veg_mask & significant
    big_inside = inside & (np.abs(difference) > large_change_m)
    from scipy import ndimage
    labels, n = ndimage.label(big_inside)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) \
        if n else np.array([])
    big_clusters = int((sizes >= 64).sum()) if sizes.size else 0
    return {
        "masked_cells_with_significant_change": int(inside.sum()),
        "masked_cells_with_large_change": int(big_inside.sum()),
        "large_change_clusters_over_4m2": big_clusters,
        "volume_hidden_m3": round(float(np.nansum(np.abs(
            np.where(big_inside, difference, 0.0)))) * cell_m ** 2, 1),
        "review_needed": big_clusters > 0,
        "note": "a 4 m² patch of 2 m change under the vegetation mask is probably "
                "earthworks that happened to have plants on it",
    }

print(json.dumps(overmasking_check(veg, d, sig, 0.25), indent=2))
```

This is the check that keeps the union mask honest. Vegetation does not change by 2 m in three months, so a large contiguous change inside the mask is either an earthwork that was previously vegetated — which is real volume being discarded — or a felled tree, which is not. The two are distinguishable by sign and by looking at the aerial image, and both deserve a human glance.

Then verify by measuring an area that should be unchanged:

```python
def control_area_check(difference, veg_mask, significant, control_polygons_raster,
                       cell_m, tolerance_m3=50.0):
    """A fenced-off area with vegetation should net to zero after masking."""
    with rasterio.open(control_polygons_raster) as ds:
        control = ds.read(1) > 0
    usable = control & significant & ~veg_mask
    vals = np.where(usable, difference, 0.0)
    net = float(np.nansum(vals)) * cell_m ** 2
    unmasked_net = float(np.nansum(np.where(control & significant, difference, 0.0))) \
        * cell_m ** 2
    return {
        "control_area_m2": round(float(control.sum()) * cell_m ** 2, 1),
        "net_after_masking_m3": round(net, 1),
        "net_without_masking_m3": round(unmasked_net, 1),
        "improvement_m3": round(abs(unmasked_net) - abs(net), 1),
        "passes": abs(net) <= tolerance_m3,
    }
```

A control area — a landscaped strip, a fenced compound, anything on the site that certainly did not move — is the most convincing validation available. Its net volume after masking should be near zero, and comparing it against the unmasked net shows the masking working on data where the truth is known.

## Performance Notes

- **Rasterising four products per epoch** (max, min, count, multi-return count) is four PDAL passes; combining them into one pipeline with several `writers.gdal` stages runs a single read.
- **Binary dilation is milliseconds** on a 1.3-million-cell grid.
- **The geometric path costs roughly twice the classification path** in rasterisation, and it is the only option on unclassified or photogrammetric data.
- **Dilation of 2 cells at 25 cm excludes about 3% more area** than the raw mask on a typical site; at 8 cells it is closer to 12%.
- **Store both masks.** The union mask is what the volume used; the per-epoch masks explain why a specific cell was excluded.
- **Run the audit every time.** It is a few array operations and it is the only automatic check on mask quality.

## Common Errors

**Mask excludes nothing.** The delivery has no vegetation classes. Check the classification histogram and use the geometric path.

**Apparent fill barely changed after masking.** The mask is the intersection rather than the union, or the dilation is zero and canopy-edge cells survive.

**Half the site is excluded.** The geometric cues are firing on gravel or rip-rap. Require two of three, and raise the roughness threshold.

**A real stockpile was masked out.** It was vegetated in the earlier epoch. The overmasking check finds these; handle them by hand.

**Residual audit says vegetation remains and the mask looks complete.** Low grass produces few multiple returns and little height spread. A colour index or a lower spread threshold catches it.

**Volumes differ between two runs.** The dilation iteration count or the `min_points` threshold changed. Both belong in a recorded configuration.

**The felled tree shows as 8 m of cut in the measured volume.** It was in the epoch-A mask only and the union was not used.

## Frequently Asked Questions

### Should I exclude vegetation or use a ground-only surface?

Using ground-classified points only — a DTM difference rather than a DSM difference — is cleaner where the classification is reliable, and it also removes plant, vehicles and stockpiles, which is usually not what earthworks measurement wants. A DSM difference with a vegetation mask keeps the stockpiles.

### What about surveys in different seasons?

Avoid comparing across a growing season where possible; where it is unavoidable, the union mask plus the seasonal buffer is the mitigation, and the excluded volume should be stated prominently.

### Can I use NDVI from imagery instead?

Yes, and it is the strongest cue available when there is multispectral imagery from both epochs. The union logic and the dilation stay exactly the same; only the mask's source changes.

## Related Guides

- [DSM Differencing for Volume Change](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/dsm-differencing-for-volume-change/) — the pipeline this masks
- [Ground Classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) — producing the classification this relies on
- [Reporting Stockpile Volumes with Uncertainty](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/reporting-stockpile-volumes-with-uncertainty/) — stating the excluded area alongside the result

Back to [Change Detection Between Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
