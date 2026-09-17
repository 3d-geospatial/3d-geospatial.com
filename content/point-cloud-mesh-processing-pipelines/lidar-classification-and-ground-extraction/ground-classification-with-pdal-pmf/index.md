# Ground Classification with PDAL PMF

This page extracts bare-earth ground from an airborne lidar tile using PDAL's progressive morphological filter — what each parameter does to the result, where PMF fails and SMRF does better, how to handle steep terrain and dense urban areas, and how to measure the classification's accuracy against surveyed control rather than eyeballing a hillshade.

## Why you hit this

Everything downstream needs ground. A DTM needs it, contours need it, volume calculations need it, and building extraction needs it as the reference to measure heights against. Deliveries arrive unclassified or badly classified often enough that doing it yourself is a routine task rather than an exception.

The progressive morphological filter is the classical algorithm and it is still a good default: it opens the surface with a growing structuring element, so small objects are removed first and large ones later, and it needs four parameters that all have physical meanings. Understanding those meanings is the difference between a clean DTM and one with buildings in it.

## Prerequisites

- PDAL 2.6+ with the `filters.pmf` and `filters.smrf` stages; Python 3.10+ with `numpy`, `rasterio`.
- A LAS/LAZ tile with a known CRS and, ideally, return-number information.
- A handful of surveyed ground spot heights for the accuracy check.

## Step-by-Step

### 1. Understand the four parameters physically

```python
import json
import math
import subprocess
from pathlib import Path

import numpy as np

PMF_PARAMETERS = {
    "cell_size": {
        "meaning": "grid resolution the morphological operations run on",
        "units": "m",
        "default": 1.0,
        "guidance": "1–2× the mean point spacing; finer wastes time, coarser loses detail",
    },
    "max_window_size": {
        "meaning": "largest structuring element, in cells",
        "units": "cells",
        "default": 33,
        "guidance": "must exceed the widest non-ground object: window_m = cell_size × size",
    },
    "slope": {
        "meaning": "terrain slope tolerated as ground, as a ratio (rise/run)",
        "units": "m/m",
        "default": 1.0,
        "guidance": "0.15 for floodplain, 0.5 for rolling, 1.0+ for mountainous",
    },
    "initial_distance": {
        "meaning": "height tolerance at the smallest window",
        "units": "m",
        "default": 0.15,
        "guidance": "the survey's vertical noise, typically 0.10–0.20 m",
    },
    "max_distance": {
        "meaning": "ceiling on the height tolerance as the window grows",
        "units": "m",
        "default": 2.5,
        "guidance": "the tallest local relief within one max window",
    },
}

def window_metres(cell_size, max_window_size):
    return cell_size * max_window_size

for name, spec in PMF_PARAMETERS.items():
    print(f"{name:<18}{str(spec['default']):>6} {spec['units']:<6}{spec['guidance']}")
print("\nmax window at defaults:", window_metres(1.0, 33), "m")
```

`max_window_size` is the parameter that decides whether buildings survive, and it is the one most often left at the default. The filter can only remove an object narrower than its largest window, so with a 1 m cell and a 33-cell window the widest removable object is 33 m — and a 60 m warehouse stays in the ground class, appearing in the DTM as a plateau.

The height tolerance growing from `initial_distance` to `max_distance` as the window grows is the "progressive" part. At a small window the filter is strict, which removes cars and shrubs without eating a kerb; at a large window it is permissive, which lets real terrain relief through while it removes a building.

`slope` interacts with all of this: the tolerance at each window is also scaled by the slope times the window size, so a high slope value makes the filter accept more height change and therefore keeps more non-ground. On steep terrain that is necessary; on flat terrain it is how buildings survive.

<figure class="diagram">
<svg viewBox="4 16 732 234" role="img" aria-labelledby="pmf-window-t pmf-window-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pmf-window-t">Why max_window_size decides whether buildings survive</title>
  <desc id="pmf-window-d">Three cross-sections of the same terrain with a 22 metre house and a 58 metre warehouse. With a 15-cell window at 1 metre cells the maximum removable width is 15 metres, so both buildings stay in the ground class. With a 33-cell window the house is removed and the warehouse remains as a plateau in the DTM. With a 65-cell window both are removed, but a genuine 50 metre terrace in the terrain is also flattened.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="30" width="228" height="180" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="256" y="30" width="228" height="180" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="494" y="30" width="228" height="180" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g font-size="12.5" text-anchor="middle" fill="#1f2937">
    <text x="132" y="52">window 15 cells = 15 m</text>
    <text x="370" y="52">window 33 cells = 33 m</text>
    <text x="608" y="52">window 65 cells = 65 m</text>
  </g>
  <path d="M34 168 H78 V132 H122 V168 H150 V120 H230 V168" stroke="#1f6b8a" stroke-width="2.2" fill="none"/>
  <path d="M272 168 H388 V120 H468 V168" stroke="#1f6b8a" stroke-width="2.2" fill="none"/>
  <path d="M510 168 H710" stroke="#1f6b8a" stroke-width="2.2" fill="none"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="100" y="124">house</text>
    <text x="190" y="112">warehouse</text>
    <text x="428" y="112">warehouse survives</text>
    <text x="608" y="158">both removed</text>
  </g>
  <g fill="#b0413e" font-size="11.5" text-anchor="middle">
    <text x="132" y="192">both buildings in the DTM</text>
    <text x="370" y="192">58 m plateau in the DTM</text>
  </g>
  <text x="608" y="192" fill="#9a4f26" font-size="11.5" text-anchor="middle">a real 50 m terrace flattened too</text>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">max removable width = cell_size × max_window_size; set it above the widest building and below the narrowest real landform</text>
</svg>
<figcaption>The window has to be wider than the widest building and narrower than the narrowest genuine landform — in a city that band can be empty, which is when a building mask is needed.</figcaption>
</figure>

### 2. Run PMF with parameters derived from the data

```python
def point_spacing(las_path):
    info = json.loads(subprocess.run(["pdal", "info", "--summary", str(las_path)],
                                     capture_output=True, text=True, check=True).stdout)
    s = info["summary"]
    b = s["bounds"]
    area = (b["maxx"] - b["minx"]) * (b["maxy"] - b["miny"])
    n = s["num_points"]
    return {"points": n, "area_m2": round(area, 1),
            "density_per_m2": round(n / max(area, 1), 2),
            "mean_spacing_m": round(math.sqrt(max(area, 1) / max(n, 1)), 3)}

def pmf_parameters(spacing_m, widest_building_m, terrain_slope_ratio,
                   vertical_noise_m, local_relief_m):
    cell = max(round(spacing_m * 1.5, 2), 0.5)
    window_cells = int(math.ceil(widest_building_m * 1.3 / cell))
    return {
        "cell_size": cell,
        "max_window_size": window_cells,
        "slope": round(terrain_slope_ratio, 3),
        "initial_distance": round(vertical_noise_m, 3),
        "max_distance": round(local_relief_m, 2),
        "max_removable_width_m": round(cell * window_cells, 1),
    }

def run_pmf(las_path, out_path, params, keep_last_return_only=True):
    stages = [str(las_path)]
    if keep_last_return_only:
        stages.append({"type": "filters.range",
                       "limits": "ReturnNumber[ReturnNumber:ReturnNumber]"})
    stages.append({"type": "filters.range", "limits": "Classification![7:7]"})
    stages.append({
        "type": "filters.pmf",
        "cell_size": params["cell_size"],
        "max_window_size": params["max_window_size"],
        "slope": params["slope"],
        "initial_distance": params["initial_distance"],
        "max_distance": params["max_distance"],
        "exponential": True,
    })
    stages.append({"type": "writers.las", "filename": str(out_path),
                   "compression": "laszip", "extra_dims": "all"})
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    proc = subprocess.run(["pdal", "pipeline", str(spec), "--metadata",
                           str(Path(out_path).with_suffix(".meta.json"))],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"pdal failed: {proc.stderr[-500:]}")
    return {"output": str(out_path), "params": params}
```

Filtering to last returns before PMF is a cheap and large improvement on multi-return data. A first return from a tree canopy is definitely not ground; the last return from the same pulse may be. Removing the intermediate returns reduces the work and removes the points most likely to confuse the morphological opening.

`exponential: True` makes the window sizes grow as powers of two rather than linearly, which is the behaviour described in the original algorithm and is considerably faster: seven windows instead of thirty-three, each one an opening over the whole grid.

Deriving `max_window_size` from the widest building on the tile, rather than from a default, is the step that makes this work in an urban area. It requires knowing that width, which is a one-off look at a map.

### 3. Know when to use SMRF instead

```python
def run_smrf(las_path, out_path, cell=1.0, scalar=1.25, slope=0.15,
             threshold=0.45, window=18):
    stages = [
        str(las_path),
        {"type": "filters.range", "limits": "Classification![7:7]"},
        {"type": "filters.smrf",
         "cell": cell, "scalar": scalar, "slope": slope,
         "threshold": threshold, "window": window},
        {"type": "writers.las", "filename": str(out_path), "compression": "laszip"},
    ]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    return {"output": str(out_path),
            "params": {"cell": cell, "scalar": scalar, "slope": slope,
                       "threshold": threshold, "window": window}}

CHOICE = {
    "flat_rural": ("pmf", "fast, and PMF's assumptions hold"),
    "rolling_rural": ("smrf", "SMRF's slope handling is better on varied terrain"),
    "steep_mountain": ("smrf", "PMF removes ridges; SMRF's net is more forgiving"),
    "dense_urban": ("smrf + building mask", "neither handles wide buildings alone"),
    "forest": ("smrf", "handles sparse ground returns under canopy better"),
    "quarry_benches": ("neither, alone", "vertical faces violate both algorithms' models"),
}
for terrain, (algo, why) in CHOICE.items():
    print(f"{terrain:<16}{algo:<22}{why}")
```

SMRF — the simple morphological filter with a progressive net — handles varied slope better than PMF because it fits a surface that is allowed to follow the terrain rather than applying a global slope tolerance. On rolling or steep ground that difference is decisive: PMF with a slope value high enough to keep the ridges also keeps the buildings.

PMF remains the better choice on flat ground because it is faster and its parameters are easier to reason about. It is also the more predictable of the two, which matters in a pipeline that has to produce the same result on every tile.

Neither handles a quarry face, where the terrain is genuinely vertical. Both algorithms assume the ground is a height field with bounded slope, and a bench face violates that — so the honest answer there is a manual classification or a different method entirely.

### 4. Handle the urban case with a building mask

```python
def building_footprint_mask(las_path, footprints_geojson, out_path,
                            pmf_params, buffer_m=1.5):
    """Classify inside footprints as building first, so PMF never sees them."""
    stages = [
        str(las_path),
        {"type": "filters.range", "limits": "Classification![7:7]"},
        {"type": "filters.overlay", "dimension": "Classification",
         "datasource": str(footprints_geojson), "column": "class_value",
         "layer": "footprints"},
        # Ground-classify only the points that are not inside a footprint.
        {"type": "filters.expression", "expression": "Classification != 6",
         "tag": "candidates"},
        {"type": "filters.pmf", **{k: v for k, v in pmf_params.items()
                                   if k in {"cell_size", "max_window_size", "slope",
                                            "initial_distance", "max_distance"}},
         "inputs": ["candidates"]},
        {"type": "writers.las", "filename": str(out_path), "compression": "laszip"},
    ]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    return {"output": str(out_path), "mask": str(footprints_geojson),
            "buffer_m": buffer_m}
```

Using the cadastral building footprints as a mask sidesteps the whole window-size dilemma: the widest building is no longer PMF's problem, so `max_window_size` can be set from the widest *non-building* object — a truck, a container, a hedge — which is typically under 20 m.

`filters.overlay` writes an attribute from a polygon layer onto the points, and using it to pre-set `Classification` to 6 inside footprints means those points are never candidates for ground. The footprints need a buffer, because a building's eaves overhang its footprint and a scanner sees the eaves.

Where footprints are unavailable or stale, a planarity-and-height filter over the non-ground points gives a usable approximate mask, at the cost of another tuning exercise.

### 5. Rasterise and look at the result

```python
import rasterio

def dtm_from_ground(classified_las, out_tif, cell_m=0.5):
    stages = [
        str(classified_las),
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.gdal", "filename": str(out_tif), "gdaldriver": "GTiff",
         "output_type": "idw", "resolution": cell_m, "radius": cell_m * 3,
         "nodata": -9999.0, "data_type": "float32",
         "gdalopts": "COMPRESS=DEFLATE,PREDICTOR=3,TILED=YES"},
    ]
    spec = Path(out_tif).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    subprocess.run(["pdal", "pipeline", str(spec)], check=True, capture_output=True)
    with rasterio.open(out_tif) as ds:
        z = ds.read(1, masked=True).astype("float64")
        res = ds.res[0]
    return z, res

def artefact_scan(z, cell_m, plateau_slope_deg=1.0, min_plateau_m2=150.0,
                  pit_depth_m=0.6):
    """Two signatures of a bad ground classification: plateaux and pits."""
    from scipy import ndimage
    arr = np.asarray(z.filled(np.nan) if hasattr(z, "filled") else z)
    gy, gx = np.gradient(np.nan_to_num(arr, nan=np.nanmedian(arr)), cell_m)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))

    flat = np.nan_to_num(slope, nan=90.0) <= plateau_slope_deg
    labels, n = ndimage.label(flat)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) \
        if n else np.array([])
    min_cells = min_plateau_m2 / cell_m ** 2
    plateaux = int((sizes >= min_cells).sum()) if sizes.size else 0

    smooth = ndimage.median_filter(np.nan_to_num(arr, nan=np.nanmedian(arr)), size=9)
    pits = int((np.nan_to_num(smooth - arr, nan=0.0) > pit_depth_m).sum())

    return {
        "large_flat_regions": plateaux,
        "largest_flat_m2": round(float(sizes.max()) * cell_m ** 2, 1) if sizes.size else 0,
        "pit_cells": pits,
        "pit_area_m2": round(pits * cell_m ** 2, 1),
        "verdict": "buildings likely still in ground" if plateaux > 2
                   else "pits suggest over-filtering" if pits > 500
                   else "no obvious artefacts",
    }
```

Plateaux and pits are the two diagnostic artefacts, and they point in opposite directions. A large perfectly flat region in a DTM is a building roof that survived, which means the window was too small or the slope too high. A pattern of pits is over-filtering: genuine ground points were removed, and the interpolation pulled the surface down into the gaps.

Scanning for both automatically is worth far more than looking at a hillshade, because a hillshade makes plateaux obvious and pits almost invisible.

<figure class="diagram">
<svg viewBox="4 6 732 312" role="img" aria-labelledby="pmf-choice-t pmf-choice-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pmf-choice-t">PMF, SMRF or neither, by terrain</title>
  <desc id="pmf-choice-d">A table of six terrain types with the filter to use and the reason. Flat rural ground suits PMF because its assumptions hold and it is faster. Rolling and steep terrain suit SMRF because its slope handling is better. Dense urban areas need SMRF plus a building footprint mask because neither filter handles wide buildings alone. Forest suits SMRF for sparse ground returns under canopy. Quarry benches suit neither because vertical faces violate both models.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="312" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="170" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="188" y="20" width="216" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="404" y="20" width="318" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="188" y="54" width="216" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="404" y="54" width="318" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="188" y="88" width="216" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="404" y="88" width="318" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="188" y="122" width="216" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="404" y="122" width="318" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="170" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="188" y="156" width="216" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="404" y="156" width="318" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="190" width="170" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="188" y="190" width="216" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="404" y="190" width="318" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="224" width="170" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="188" y="224" width="216" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="404" y="224" width="318" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="103" y="42">terrain</text><text x="296" y="42">filter</text><text x="563" y="42">reason</text>
    <text x="103" y="76">flat rural</text><text x="296" y="76">PMF</text><text x="563" y="76">assumptions hold; faster and predictable</text>
    <text x="103" y="110">rolling rural</text><text x="296" y="110">SMRF</text><text x="563" y="110">better slope handling</text>
    <text x="103" y="144">steep mountain</text><text x="296" y="144">SMRF</text><text x="563" y="144">PMF removes ridges</text>
    <text x="103" y="178">dense urban</text><text x="296" y="178">SMRF + footprint mask</text><text x="563" y="178">neither handles wide buildings alone</text>
    <text x="103" y="212">forest</text><text x="296" y="212">SMRF</text><text x="563" y="212">sparse ground returns under canopy</text>
    <text x="103" y="246">quarry benches</text><text x="296" y="246">neither, alone</text><text x="563" y="246">vertical faces violate both models</text>
  </g>
  <text x="20" y="278" fill="#1f2937" font-size="12.5">A footprint mask beats every pure-parameter setting, because it removes the constraint they fight.</text>
  <text x="20" y="300" fill="#5b6471" font-size="12">Both filters assume the ground is a height field with bounded slope; a bench face is not.</text>
</svg>
<figcaption>SMRF for varied terrain, PMF for flat and predictable, and a footprint mask wherever buildings are wide.</figcaption>
</figure>

### 6. Measure accuracy against control

```python
def accuracy_against_control(dtm_tif, control_points, tolerance_m=0.15):
    """control_points: [{'id':…, 'x':…, 'y':…, 'z':…}], in the DTM's CRS."""
    rows = []
    with rasterio.open(dtm_tif) as ds:
        for cp in control_points:
            try:
                val = next(ds.sample([(cp["x"], cp["y"])], indexes=1))[0]
            except StopIteration:
                rows.append({"id": cp["id"], "status": "outside raster"})
                continue
            if ds.nodata is not None and np.isclose(val, ds.nodata):
                rows.append({"id": cp["id"], "status": "nodata"})
                continue
            rows.append({"id": cp["id"], "dtm_m": round(float(val), 3),
                         "control_m": cp["z"],
                         "residual_m": round(float(val) - cp["z"], 3)})
    resid = np.array([r["residual_m"] for r in rows if "residual_m" in r])
    if resid.size == 0:
        return {"measurable": False, "rows": rows}
    return {
        "measurable": True,
        "points": len(rows), "with_value": int(resid.size),
        "mean_m": round(float(resid.mean()), 4),
        "rmse_m": round(float(np.sqrt((resid ** 2).mean())), 4),
        "p95_abs_m": round(float(np.percentile(np.abs(resid), 95)), 4),
        "max_abs_m": round(float(np.abs(resid).max()), 4),
        "within_tolerance": int((np.abs(resid) <= tolerance_m).sum()),
        "outliers": sorted((r for r in rows if "residual_m" in r),
                           key=lambda r: -abs(r["residual_m"]))[:4],
        "bias_significant": abs(float(resid.mean())) > float(resid.std()) / math.sqrt(resid.size) * 3,
    }

def classification_confusion(reference_las, test_las, sample=200_000):
    """If a reference classification exists, compare class 2 assignment directly."""
    import laspy
    ref = laspy.read(reference_las)
    test = laspy.read(test_las)
    n = min(len(ref.points), len(test.points), sample)
    idx = np.random.default_rng(5).choice(min(len(ref.points), len(test.points)),
                                          size=n, replace=False)
    ref_ground = np.asarray(ref.classification)[idx] == 2
    test_ground = np.asarray(test.classification)[idx] == 2
    tp = int((ref_ground & test_ground).sum())
    fp = int((~ref_ground & test_ground).sum())
    fn = int((ref_ground & ~test_ground).sum())
    tn = int((~ref_ground & ~test_ground).sum())
    return {
        "sampled": n,
        "true_positive": tp, "false_positive": fp,
        "false_negative": fn, "true_negative": tn,
        "precision": round(tp / max(tp + fp, 1), 4),
        "recall": round(tp / max(tp + fn, 1), 4),
        "type_i_pct": round(100.0 * fn / max(tp + fn, 1), 2),   # ground called non-ground
        "type_ii_pct": round(100.0 * fp / max(fp + tn, 1), 2),  # non-ground called ground
    }
```

Type I and type II error rates are the standard way this is reported in the literature and they are the right frame. Type I — real ground rejected — shows up as pits and as a thin DTM; type II — non-ground accepted — shows up as plateaux. A good classification on mixed terrain runs at a few percent type I and under 2% type II.

Control-point residuals measure something slightly different and equally important: whether the *surface* is right where it matters. A classification with 4% type I error can still produce a DTM with a 3 cm RMSE against control, because the remaining ground points are enough to define the surface.

<figure class="diagram">
<svg viewBox="4 6 732 252" role="img" aria-labelledby="pmf-tune-t pmf-tune-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pmf-tune-t">Parameter effect on error rates</title>
  <desc id="pmf-tune-d">A table of four parameter sets on the same suburban tile. Defaults give 1.2 percent type one error and 6.8 percent type two, with three building plateaux in the DTM. Raising the window to 78 cells gives 4.1 and 0.9 percent, with no plateaux but a flattened terrace. Lowering the slope to 0.2 gives 2.8 and 1.4 percent. Using a building footprint mask with a 24-cell window gives 1.1 and 0.4 percent with no plateaux and the terrace preserved.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="252" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="242" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="20" width="118" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="378" y="20" width="118" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="496" y="20" width="226" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="242" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="260" y="54" width="118" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="378" y="54" width="118" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="496" y="54" width="226" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="94" width="242" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="260" y="94" width="118" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="378" y="94" width="118" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="496" y="94" width="226" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="134" width="242" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="260" y="134" width="118" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="378" y="134" width="118" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="496" y="134" width="226" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="174" width="242" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="174" width="118" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="378" y="174" width="118" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="496" y="174" width="226" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="139" y="41">parameters</text><text x="319" y="41">type I</text>
    <text x="437" y="41">type II</text><text x="609" y="41">DTM artefacts</text>
    <text x="139" y="78">defaults: 1 m cell, 33 cells, slope 1.0</text>
    <text x="319" y="78">1.2%</text><text x="437" y="78">6.8%</text><text x="609" y="78">3 building plateaux</text>
    <text x="139" y="110">window 78 cells</text><text x="139" y="126">(78 m removable)</text>
    <text x="319" y="118">4.1%</text><text x="437" y="118">0.9%</text>
    <text x="609" y="110">no plateaux, but a real</text><text x="609" y="126">50 m terrace flattened</text>
    <text x="139" y="150">slope 0.2, window 33</text><text x="139" y="166">initial_distance 0.12</text>
    <text x="319" y="158">2.8%</text><text x="437" y="158">1.4%</text>
    <text x="609" y="150">mild pitting on the</text><text x="609" y="166">steepest embankment</text>
    <text x="139" y="190">footprint mask +</text><text x="139" y="206">24-cell window</text>
    <text x="319" y="198">1.1%</text><text x="437" y="198">0.4%</text>
    <text x="609" y="190">none — terrace preserved,</text><text x="609" y="206">no pitting</text>
  </g>
  <text x="370" y="240" fill="#5b6471" font-size="12" text-anchor="middle">the footprint mask beats every pure-parameter setting, because it removes the constraint the parameters were fighting</text>
</svg>
<figcaption>Every parameter-only setting trades one error against the other; the footprint mask removes the trade.</figcaption>
</figure>

## Expected Output & Verification

```text
{'points': 41820418, 'area_m2': 1000000.0, 'density_per_m2': 41.82, 'mean_spacing_m': 0.155}
{'cell_size': 0.5, 'max_window_size': 24, 'slope': 0.2, 'initial_distance': 0.12,
 'max_distance': 3.5, 'max_removable_width_m': 12.0}
{'large_flat_regions': 0, 'largest_flat_m2': 88.5, 'pit_cells': 142,
 'pit_area_m2': 35.5, 'verdict': 'no obvious artefacts'}
{
  "measurable": true,
  "points": 34, "with_value": 34,
  "mean_m": -0.0121, "rmse_m": 0.0418, "p95_abs_m": 0.0784, "max_abs_m": 0.1142,
  "within_tolerance": 34,
  "bias_significant": false
}
{'sampled': 200000, 'true_positive': 88412, 'false_positive': 412,
 'false_negative': 984, 'true_negative': 110192,
 'precision': 0.9954, 'recall': 0.989, 'type_i_pct': 1.1, 'type_ii_pct': 0.37}
```

A 4.2 cm RMSE against control with all 34 points inside tolerance and no significant bias is a good result for airborne lidar. The 1.1% type I and 0.37% type II rates are the numbers to quote when someone asks how good the classification is.

The 142 pit cells covering 35 m² are worth a glance and are not a problem at this scale — they are typically at the base of dense hedges where genuine ground returns are sparse.

Verify the parameters were actually applied, since a typo in a pipeline stage is silently ignored by some PDAL versions:

```python
def pipeline_verification(meta_json_path, expected_params):
    meta = json.loads(Path(meta_json_path).read_text())
    stages = meta.get("stages", {})
    pmf = next((v for k, v in stages.items() if k.startswith("filters.pmf")), None)
    if pmf is None:
        return {"applied": False, "reason": "no filters.pmf stage in metadata"}
    mismatches = []
    for key, expected in expected_params.items():
        if key not in pmf:
            continue
        got = pmf[key]
        if isinstance(expected, float) and not math.isclose(float(got), expected, rel_tol=1e-6):
            mismatches.append({"param": key, "expected": expected, "got": got})
        elif not isinstance(expected, float) and got != expected:
            mismatches.append({"param": key, "expected": expected, "got": got})
    return {"applied": True, "mismatches": mismatches,
            "matches": not mismatches,
            "effective": {k: pmf.get(k) for k in expected_params if k in pmf}}

print(json.dumps(pipeline_verification("build/ground.meta.json",
                                       {"cell_size": 0.5, "max_window_size": 24,
                                        "slope": 0.2}), indent=2))
```

Reading the parameters back from PDAL's own metadata output is the only way to be sure the stage ran with what you intended. A misspelled option name — `cellsize` for `cell_size` — is accepted by some builds and ignored, leaving the default in force.

Then verify the ground coverage is dense enough to define a surface everywhere:

```python
def ground_coverage_check(classified_las, cell_m=2.0, min_points_per_cell=1):
    stages = [
        str(classified_las),
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.gdal", "filename": "build/ground_count.tif",
         "output_type": "count", "resolution": cell_m, "nodata": 0,
         "data_type": "uint16"},
    ]
    Path("build/ground_count.json").write_text(json.dumps({"pipeline": stages}))
    subprocess.run(["pdal", "pipeline", "build/ground_count.json"],
                   check=True, capture_output=True)
    with rasterio.open("build/ground_count.tif") as ds:
        counts = ds.read(1)
    empty = counts < min_points_per_cell
    from scipy import ndimage
    labels, n = ndimage.label(empty)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) \
        if n else np.array([])
    return {
        "cells": int(counts.size),
        "empty_cells": int(empty.sum()),
        "empty_fraction": round(float(empty.mean()), 4),
        "gap_clusters": int(n),
        "largest_gap_m2": round(float(sizes.max()) * cell_m ** 2, 1) if sizes.size else 0,
        "acceptable": float(empty.mean()) < 0.05
                      and (not sizes.size or float(sizes.max()) * cell_m ** 2 < 400),
    }
```

Gaps in ground coverage are where the DTM is interpolated rather than measured, and a gap larger than a few hundred square metres — under a building, under dense canopy — is a region where the DTM is a guess. Reporting the largest gap is more useful than reporting the fraction, because one 2,000 m² gap matters more than 200 small ones.

## Performance Notes

- **PMF with `exponential: True` runs in roughly 15–40 seconds per 40-million-point tile** on one core; linear window growth is several times slower for the same result.
- **Cell size drives the cost quadratically.** A 0.25 m cell on a 1 km tile is 16 million grid cells and is rarely worth it over 0.5 m.
- **SMRF is 2–4× slower than PMF** and usually worth it on varied terrain.
- **Filter to last returns first.** On 5-return data that removes 60% of the points before the expensive stage.
- **Tile with overlap.** A morphological filter needs context beyond the tile edge; a 50–100 m buffer, classified and then clipped, avoids a seam of misclassification along every boundary.
- **`filters.overlay` is cheap** — a point-in-polygon test per point against a spatial index.

## Common Errors

**Buildings in the DTM as flat plateaux.** `max_window_size` too small for the widest building. Raise it or use a footprint mask.

**Real terraces and embankments flattened.** `max_window_size` too large. This is the other half of the same trade.

**Pits across the DTM.** Over-filtering: `initial_distance` below the survey noise, or `slope` too low for the terrain.

**A seam of bad classification along every tile edge.** No overlap buffer. Classify with a buffer and clip after.

**`filters.pmf` had no effect.** A misspelled parameter name, or the stage received no points because an earlier `filters.range` excluded everything. Read the metadata back.

**Ground class is empty.** PDAL's PMF sets `Classification` to 2 for ground and 1 for non-ground; a later `writers.las` without `extra_dims` can drop custom dimensions but not classification — so an empty class 2 means the filter rejected everything, usually from a `max_distance` far too small.

**Steep slopes classified as non-ground.** PMF's global slope tolerance. Use SMRF.

## Frequently Asked Questions

### PMF or SMRF as a default?

SMRF for mixed and varied terrain, which is most real projects. PMF where the terrain is flat, the tiles are many and predictability matters.

### Should I trust a vendor's classification?

Verify it with the same artefact scan and control-point check. Vendor classifications are usually good and occasionally have a systematic problem — a whole flight line misclassified — that is cheap to detect and expensive to discover late.

### How do I classify a quarry or a cliff?

Not with a morphological filter. Those need a method that does not assume a height field: region growing on normals, or a manual classification with the faces explicitly delineated.

## Related Guides

- [Detecting Power Lines in Lidar](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/detecting-power-lines-in-lidar/) — classifying the linear features PMF leaves behind
- [Training a Random Forest Point Classifier](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/training-a-random-forest-point-classifier/) — when rules are not enough
- [Delaunay Meshing of Terrain with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/delaunay-meshing-of-terrain-with-pdal/) — turning the ground class into a surface

Back to [Lidar Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
