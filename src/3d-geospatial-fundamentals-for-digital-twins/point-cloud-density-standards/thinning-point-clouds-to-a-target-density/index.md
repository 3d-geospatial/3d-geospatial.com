---
title: "Thinning Point Clouds to a Target Density"
description: "Reduce a dense cloud to a target density without losing structure: compare PDAL sample, voxel centre and decimation"
---
# Thinning Point Clouds to a Target Density

This page reduces an over-dense point cloud to a target density — comparing PDAL's Poisson-disk `filters.sample`, voxel-centre selection and naive decimation, preserving the class balance and the points that carry structure, and verifying that the thinned cloud still supports the products built from it, in EPSG:25832+7837.

## Why you hit this

Modern sensors over-deliver. A mobile-mapping pass produces 2,000 points per square metre on a facade, an airborne survey flown with 70% side overlap gives 40 pts/m² where the specification asked for 8, and a photogrammetric reconstruction hands over 200 million points for a city block. None of that extra density improves a terrain model at 1 m resolution or a mesh decimated to 50,000 triangles; all of it costs memory, processing time and storage at every later stage. Thinning is therefore a normal pipeline step — and doing it with the wrong method destroys exactly the structure the downstream stages need. The targets and their meaning are in [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).

## Prerequisites

- PDAL 2.6+ with Python bindings (`pdal>=3.4`), `laspy[lazrs]>=2.5`, `numpy>=1.24`, `scipy>=1.11`.
- A classified cloud whose density you have already measured per cell, as in [mapping density coverage gaps with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/mapping-density-coverage-gaps-with-pdal/).
- A stated target: a density in points per square metre, or a minimum spacing in metres. They are equivalent — spacing ≈ 1/√density — and the spacing form is the one the thinning methods take.

## The Three Methods Are Not Interchangeable

**Decimation** (`filters.decimation`) keeps every n-th point in file order. It is the fastest and the only one that preserves nothing: file order follows the sensor's acquisition order, so a decimated cloud is thinned along the flight line and untouched across it, and returns from one scanner in a dual-head system can be removed preferentially.

**Voxel selection** (`filters.voxelcentroidnearest` or `filters.voxeldownsize`) divides space into a grid and keeps one point per occupied cell. It gives a bounded, predictable spacing and aligns every surviving point to a grid, which introduces a subtle regularity that reconstruction algorithms can key on.

**Poisson-disk sampling** (`filters.sample`) keeps points greedily subject to a minimum distance, so no two survivors are closer than the radius and the result is irregular but uniformly dense. It is the best-behaved for reconstruction and the slowest, because it is a neighbourhood search rather than a hash.

<figure class="diagram">
<svg viewBox="33 33 700 223" role="img" aria-labelledby="thin-methods-t thin-methods-d" xmlns="http://www.w3.org/2000/svg">
  <title id="thin-methods-t">What each thinning method keeps</title>
  <desc id="thin-methods-d">The same dense patch thinned three ways. Decimation keeps every fourth point in acquisition order, leaving stripes along the scan direction. Voxel selection keeps one point per grid cell, producing a regular lattice. Poisson-disk sampling keeps points no closer than a radius, producing an irregular but evenly spaced set that follows the surface.</desc>
  <rect class="svg-bg" x="33" y="33" width="700" height="223" fill="#ffffff"/>
  <g fill="#b0413e">
    <circle cx="50" cy="60" r="3"/><circle cx="70" cy="60" r="3"/><circle cx="90" cy="60" r="3"/><circle cx="110" cy="60" r="3"/><circle cx="130" cy="60" r="3"/><circle cx="150" cy="60" r="3"/><circle cx="170" cy="60" r="3"/><circle cx="190" cy="60" r="3"/><circle cx="210" cy="60" r="3"/>
    <circle cx="50" cy="120" r="3"/><circle cx="70" cy="120" r="3"/><circle cx="90" cy="120" r="3"/><circle cx="110" cy="120" r="3"/><circle cx="130" cy="120" r="3"/><circle cx="150" cy="120" r="3"/><circle cx="170" cy="120" r="3"/><circle cx="190" cy="120" r="3"/><circle cx="210" cy="120" r="3"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="300" cy="55" r="3"/><circle cx="340" cy="55" r="3"/><circle cx="380" cy="55" r="3"/><circle cx="420" cy="55" r="3"/><circle cx="460" cy="55" r="3"/>
    <circle cx="300" cy="95" r="3"/><circle cx="340" cy="95" r="3"/><circle cx="380" cy="95" r="3"/><circle cx="420" cy="95" r="3"/><circle cx="460" cy="95" r="3"/>
    <circle cx="300" cy="135" r="3"/><circle cx="340" cy="135" r="3"/><circle cx="380" cy="135" r="3"/><circle cx="420" cy="135" r="3"/><circle cx="460" cy="135" r="3"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="560" cy="52" r="3"/><circle cx="604" cy="68" r="3"/><circle cx="648" cy="50" r="3"/><circle cx="700" cy="66" r="3"/>
    <circle cx="576" cy="100" r="3"/><circle cx="628" cy="108" r="3"/><circle cx="676" cy="94" r="3"/><circle cx="716" cy="110" r="3"/>
    <circle cx="558" cy="142" r="3"/><circle cx="606" cy="150" r="3"/><circle cx="660" cy="138" r="3"/><circle cx="706" cy="152" r="3"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="188">decimation</text>
    <text x="380" y="188">voxel selection</text>
    <text x="638" y="188">Poisson-disk</text>
    <text x="130" y="210">stripes along the scan</text>
    <text x="380" y="210">regular lattice</text>
    <text x="638" y="210">irregular, evenly spaced</text>
  </g>
  <text x="380" y="238" fill="#15384a" font-size="12" text-anchor="middle">All three keep about the same number of points; only the third preserves an isotropic sample.</text>
</svg>
<figcaption>The point counts match and the spatial properties do not, which is why the method matters more than the ratio.</figcaption>
</figure>

## Step-by-Step

### 1. Convert the target into a radius

```python
import math

def target_to_radius(target_per_m2=None, min_spacing_m=None, safety=1.0):
    """Poisson-disk radius that yields approximately the requested density."""
    if min_spacing_m:
        return min_spacing_m * safety
    if not target_per_m2:
        raise ValueError("give a density or a spacing")
    # a Poisson-disk set of radius r has about 0.7 / r² points per unit area
    return math.sqrt(0.7 / target_per_m2) * safety

for target in (8, 20, 50, 200):
    r = target_to_radius(target_per_m2=target)
    print(f"target {target:>4} pts/m² → radius {r:.3f} m (≈ {0.7 / r ** 2:.1f} pts/m² achieved)")
```

The 0.7 factor is the packing density of a maximal Poisson-disk set, and it is the reason a radius equal to the nominal spacing under-delivers: at radius `r` the achievable density is about `0.7 / r²`, not `1 / r²`. Setting the radius from the density rather than the other way round is what makes the result land on the target instead of 30% below it.

### 2. Thin with Poisson-disk sampling, per class

```python
import json

import pdal

SRC = "deliveries/2026-09/tile_691_5335.laz"

def thin_poisson(src, out, radius, classes=None):
    stages = [src]
    if classes:
        stages.append({"type": "filters.range",
                       "limits": ",".join(f"Classification[{c}:{c}]" for c in classes)})
    stages += [
        {"type": "filters.sample", "radius": radius},
        {"type": "writers.las", "filename": out, "compression": "laszip",
         "forward": "all", "minor_version": 4, "dataformat_id": 6},
    ]
    return pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

radius = target_to_radius(target_per_m2=8)
kept = thin_poisson(SRC, "build/thin_all_8.laz", radius)
print(f"{kept:,} points kept at radius {radius:.3f} m")
```

`filters.sample` is PDAL's Poisson-disk implementation and it operates in three dimensions, which matters on vertical surfaces: a 2D thinning that keeps one point per square metre of ground keeps one point per square metre of *plan* on a facade, which is almost nothing. The 3D radius keeps the facade sampled at the same spacing as the ground.

### 3. Thin classes independently when they have different requirements

```python
CLASS_TARGETS = {
    2: 8.0,        # ground: the terrain model's requirement
    6: 20.0,       # buildings: roof detail for reconstruction
    5: 4.0,        # high vegetation: canopy structure, coarser is fine
    (3, 4): 2.0,   # low and medium vegetation: rarely needed at density
}

def thin_by_class(src, out_dir, class_targets):
    outputs = {}
    for classes, target in class_targets.items():
        cls = (classes,) if isinstance(classes, int) else classes
        name = "_".join(str(c) for c in cls)
        out = f"{out_dir}/thin_class_{name}.laz"
        r = target_to_radius(target_per_m2=target)
        n = thin_poisson(src, out, r, classes=cls)
        outputs[name] = {"target_per_m2": target, "radius_m": round(r, 3), "points": n}
    return outputs

outs = thin_by_class(SRC, "build", CLASS_TARGETS)
for name, info in outs.items():
    print(f"class {name:<6} target {info['target_per_m2']:>5} pts/m²  "
          f"radius {info['radius_m']:.3f} m  kept {info['points']:,}")
```

Thinning uniformly across classes is the mistake that makes a thinned delivery unusable. Ground needs the specification's density because the terrain model depends on it; roofs often need more, because reconstruction quality scales with sample spacing relative to roof features; vegetation needs far less, and is usually most of the points. A per-class pass typically removes 70% of a cloud while leaving every product's input unchanged.

Merging the per-class outputs back into one file preserves the ability to serve them separately as well:

```python
def merge(parts, out):
    stages = list(parts) + [
        {"type": "filters.merge"},
        {"type": "writers.las", "filename": out, "compression": "laszip",
         "forward": "all", "minor_version": 4, "dataformat_id": 6,
         "a_srs": "EPSG:25832+7837"},
    ]
    return pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

total = merge([f"build/thin_class_{k}.laz" for k in outs], "build/tile_thinned.laz")
print(f"merged {total:,} points")
```

<figure class="diagram">
<svg viewBox="46 4 668 236" role="img" aria-labelledby="thin-class-t thin-class-d" xmlns="http://www.w3.org/2000/svg">
  <title id="thin-class-t">Per-class thinning against uniform thinning</title>
  <desc id="thin-class-d">Two stacked bars for the same tile. Before thinning, vegetation holds most of the points, with ground and buildings smaller shares. Uniform thinning to eight points per square metre keeps the same proportions and leaves buildings under-sampled for reconstruction. Per-class thinning keeps buildings denser, ground at the specification and vegetation much sparser, for a smaller total.</desc>
  <rect class="svg-bg" x="46" y="4" width="668" height="236" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="60" y="40" width="200" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="40" width="120" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="40" width="320" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="100" width="80" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="140" y="100" width="48" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="188" y="100" width="128" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="160" width="80" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="140" y="160" width="96" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="236" y="160" width="40" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="60" y="32">delivered: 18.4 M points</text>
    <text x="60" y="92">uniform thinning: 5.1 M — buildings under-sampled</text>
    <text x="60" y="152">per-class thinning: 4.2 M — every product's input intact</text>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="160" y="60">ground</text><text x="320" y="60">buildings</text><text x="540" y="60">vegetation</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Fewer points in total, more where reconstruction needs them.</text>
</svg>
<figcaption>Uniform thinning preserves the delivered proportions, which are set by what the sensor saw rather than by what the products need.</figcaption>
</figure>

### 4. Compare the methods on the same tile

```python
import time

def thin_voxel(src, out, cell):
    stages = [src,
              {"type": "filters.voxelcentroidnearest", "cell": cell},
              {"type": "writers.las", "filename": out, "compression": "laszip", "forward": "all"}]
    return pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

def thin_decimate(src, out, step):
    stages = [src,
              {"type": "filters.decimation", "step": step},
              {"type": "writers.las", "filename": out, "compression": "laszip", "forward": "all"}]
    return pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

results = []
for label, fn, arg in (("poisson r=0.30", thin_poisson, 0.296),
                       ("voxel c=0.30", thin_voxel, 0.30),
                       ("decimate n=5", thin_decimate, 5)):
    out = f"build/cmp_{label.split()[0]}.laz"
    t0 = time.perf_counter()
    n = fn(SRC, out, arg)
    results.append((label, n, round(time.perf_counter() - t0, 1)))
for label, n, secs in results:
    print(f"{label:<16}{n:>10,} points  {secs:>6.1f} s")
```

### 5. Measure what the thinning did to the spacing

```python
import laspy
import numpy as np
from scipy.spatial import cKDTree

def spacing_stats(path, sample=300_000, k=2):
    las = laspy.read(path)
    xyz = np.column_stack([las.x, las.y, las.z])
    if len(xyz) > sample:
        xyz = xyz[np.random.default_rng(3).choice(len(xyz), sample, replace=False)]
    d, _ = cKDTree(xyz).query(xyz, k=k, workers=-1)
    nn = d[:, 1]
    return {
        "points": int(len(las.points)),
        "nn_median_m": round(float(np.median(nn)), 3),
        "nn_p05_m": round(float(np.percentile(nn, 5)), 3),
        "nn_p95_m": round(float(np.percentile(nn, 95)), 3),
        "anisotropy": round(float(np.percentile(nn, 95) / max(np.percentile(nn, 5), 1e-6)), 2),
    }

for path in ("build/cmp_poisson.laz", "build/cmp_voxel.laz", "build/cmp_decimate.laz"):
    print(f"{path.split('_')[-1][:-4]:<10}{spacing_stats(path)}")
```

The anisotropy figure — the ratio of the 95th to the 5th percentile nearest-neighbour distance — is the number that separates the methods. A Poisson-disk set has a hard lower bound at its radius and a narrow spread, so the ratio is close to 2. A decimated set keeps the original's within-scanline spacing while stretching across lines, so the ratio is 5 or more. That anisotropy is what makes surface reconstruction produce striped artefacts from a decimated cloud.

### 6. Verify the products, not just the cloud

```python
def dtm_difference(dense_path, thin_path, cell=1.0, bounds=None):
    for src, out in ((dense_path, "build/dtm_dense.tif"), (thin_path, "build/dtm_thin.tif")):
        stages = [src,
                  {"type": "filters.range", "limits": "Classification[2:2]"},
                  {"type": "writers.gdal", "filename": out, "resolution": cell,
                   "output_type": "idw", "nodata": -9999, "data_type": "float32",
                   **({"bounds": bounds} if bounds else {})}]
        pdal.Pipeline(json.dumps({"pipeline": stages})).execute()

    import rasterio
    with rasterio.open("build/dtm_dense.tif") as a, rasterio.open("build/dtm_thin.tif") as b:
        da, db = a.read(1, masked=True), b.read(1, masked=True)
        diff = (db - da).compressed()
    return {"cells": int(diff.size),
            "rmse_m": round(float(np.sqrt((diff ** 2).mean())), 4),
            "p95_abs_m": round(float(np.percentile(np.abs(diff), 95)), 4),
            "max_abs_m": round(float(np.abs(diff).max()), 4)}

print(dtm_difference(SRC, "build/tile_thinned.laz", bounds=BOUNDS))
```

This is the acceptance test that matters: not "how many points did we keep" but "did the product change". A terrain model built from the thinned ground points should differ from the dense one by a few millimetres RMSE, which is the interpolation noise. A difference of centimetres means the ground class was thinned below what the interpolation needs, and the target should be revisited.

<figure class="diagram">
<svg viewBox="56 9 667 237" role="img" aria-labelledby="thin-verify-t thin-verify-d" xmlns="http://www.w3.org/2000/svg">
  <title id="thin-verify-t">Terrain model difference against ground-class thinning target</title>
  <desc id="thin-verify-d">A curve of terrain model root mean square difference against the ground thinning target. At twenty and twelve points per square metre the difference is under five millimetres. At eight it is about nine millimetres, still below the survey's own accuracy. At four it rises to four centimetres and at two to eleven, where the thinning is visibly degrading the product.</desc>
  <rect class="svg-bg" x="56" y="9" width="667" height="237" fill="#ffffff"/>
  <path d="M70 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M70 120 H700" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <polyline points="660,172 540,170 420,166 300,150 180,86 110,44" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="110" y="200">2</text><text x="180" y="200">4</text><text x="300" y="200">8</text>
    <text x="420" y="200">12</text><text x="540" y="200">16</text><text x="660" y="200">20 pts/m²</text>
  </g>
  <text x="708" y="112" fill="#4f7a4d" font-size="12" text-anchor="end">survey accuracy</text>
  <text x="130" y="36" fill="#b0413e" font-size="12" text-anchor="start">11 cm</text>
  <text x="330" y="142" fill="#1f6b8a" font-size="12" text-anchor="start">9 mm at the specification</text>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">ground thinning target — the product stops caring above about 8 pts/m²</text>
</svg>
<figcaption>The curve shows where thinning becomes free: above the specification's density, extra ground points change the terrain model by less than its own accuracy.</figcaption>
</figure>

## Expected Output & Verification

```text
target    8 pts/m² → radius 0.296 m (≈ 8.0 pts/m² achieved)
target   20 pts/m² → radius 0.187 m (≈ 20.0 pts/m² achieved)
6,204,118 points kept at radius 0.296 m
class 2      target   8.0 pts/m²  radius 0.296 m  kept 2,104,882
class 6      target  20.0 pts/m²  radius 0.187 m  kept 1,402,118
class 5      target   4.0 pts/m²  radius 0.418 m  kept   604,204
class 3_4    target   2.0 pts/m²  radius 0.592 m  kept   102,884
merged 4,214,088 points
poisson r=0.30    6,204,118 points    94.2 s
voxel c=0.30      6,880,204 points    31.8 s
decimate n=5      3,680,424 points     8.4 s
poisson   {'points': 6204118, 'nn_median_m': 0.318, 'nn_p05_m': 0.297, 'nn_p95_m': 0.512, 'anisotropy': 1.72}
voxel     {'points': 6880204, 'nn_median_m': 0.301, 'nn_p05_m': 0.204, 'nn_p95_m': 0.424, 'anisotropy': 2.08}
decimate  {'points': 3680424, 'nn_median_m': 0.208, 'nn_p05_m': 0.031, 'nn_p95_m': 0.884, 'anisotropy': 28.52}
{'cells': 996012, 'rmse_m': 0.0091, 'p95_abs_m': 0.0162, 'max_abs_m': 0.184}
```

The decimation row is the argument for not using it: it kept fewer points and its nearest-neighbour distances span 3 cm to 88 cm, an anisotropy of 28. The Poisson result has an anisotropy of 1.7 and a 5th percentile exactly at its radius, which is the definition of the method working.

Verify that the thinning preserved classes and metadata, which a thinning step frequently loses:

```python
def compare_headers(a_path, b_path):
    a, b = laspy.read(a_path), laspy.read(b_path)
    ca = dict(zip(*np.unique(a.classification, return_counts=True)))
    cb = dict(zip(*np.unique(b.classification, return_counts=True)))
    return {
        "crs_preserved": a.header.parse_crs() == b.header.parse_crs(),
        "classes_before": {int(k): int(v) for k, v in ca.items()},
        "classes_after": {int(k): int(v) for k, v in cb.items()},
        "classes_lost": sorted(set(ca) - set(cb)),
        "extra_dims_preserved": ([d.name for d in a.header.extra_dimensions]
                                 == [d.name for d in b.header.extra_dimensions]),
    }

print(compare_headers(SRC, "build/tile_thinned.laz"))
assert compare_headers(SRC, "build/tile_thinned.laz")["crs_preserved"], "CRS lost in thinning"
```

A class present before and absent afterwards means a rare class — water, bridge decks, noise — was thinned out of existence by a radius appropriate for ground. Classes with few points should be passed through untouched rather than thinned.

## Performance Notes

- **Poisson-disk sampling is the slow one**: it is a neighbourhood query per point, roughly 15–20 million points per minute per core. Tile the work and run tiles in parallel.
- **Voxel selection is three to five times faster** and is a reasonable default when the output feeds rasterisation rather than reconstruction, where the lattice regularity does not matter.
- **Thin early, once.** Thinning before classification biases the classifier; thinning immediately after is the right point, and thinning again later compounds the sampling artefacts.
- **Keep the dense original.** Thinning is lossy and the target sometimes changes; re-thinning from the archive costs minutes, recovering lost points costs a reflight.
- **Do not thin what you will not process.** Dropping vegetation entirely, where a product does not need it, is cheaper and more honest than thinning it to 2 pts/m².

## Common Errors

**The achieved density is 30% below the target.** The radius was set equal to the nominal spacing rather than derived from the packing factor. Use the 0.7 relation in step 1.

**Facades come out far sparser than the ground.** A 2D thinning was used, or a voxel cell that is large relative to the facade's sampling. `filters.sample` in 3D treats all surfaces alike.

**A rare class disappears.** It was thinned with the same radius as everything else. Exclude classes with fewer than a few thousand points from thinning.

**The terrain model changes by centimetres.** The ground class was thinned below the interpolation's needs, or the thinning removed the breakline-defining points. Raise the ground target, and keep points flagged as key points or model key points unconditionally.

**Output loses the CRS or the extra dimensions.** `writers.las` without `forward: "all"` writes a header from defaults. Forward everything, and assert the CRS afterwards.

## Frequently Asked Questions

### Should thinning happen before or after classification?

After. Classifiers use local density and neighbourhood geometry, and a thinned cloud gives them less to work with — ground filters in particular degrade noticeably. Classify at full density, then thin per class.

### Is thinning the same as level-of-detail generation?

No. Thinning produces one cloud at one density; a level-of-detail structure keeps all the points and organises them so a viewer can request progressively more, which is what [converting point clouds to 3D Tiles with py3dtiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-point-clouds-to-3d-tiles-with-py3dtiles/) builds. A twin usually wants both: a thinned cloud for processing and an octree for viewing.

### How do I thin a photogrammetric cloud?

The same way, with two caveats: its noise is higher, so thinning removes some of it and a filtering pass first is better; and it has no classification, so per-class targets are unavailable until a classifier has run.

## Related Guides

- [Mapping Density Coverage Gaps with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/mapping-density-coverage-gaps-with-pdal/) — measuring before thinning
- [Voxel Downsampling Strategies Compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — the Open3D side of the same choice
- [Validating Density Against USGS Quality Levels](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/validating-density-against-usgs-quality-levels/) — what target to thin to

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
