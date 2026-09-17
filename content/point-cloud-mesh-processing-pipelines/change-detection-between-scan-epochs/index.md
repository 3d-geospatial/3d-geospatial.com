# Change Detection Between LiDAR Scan Epochs

A digital twin that is surveyed once is a model; a twin that is resurveyed is a record of change, and change is usually what the people paying for the twin care about. A new extension on a warehouse, a stockpile that shrank by 4,000 m³, a retaining wall that has moved 30 mm since spring, a block demolished between flights. Every one of those is visible in the difference between two point clouds — and so is registration error, vegetation growth, a parked lorry, a wet roof that returned fewer points and a scanner shadow that only exists in one epoch. This guide covers how to separate the first list from the second: aligning epochs on ground that did not move, choosing between DSM differencing, cloud-to-cloud and M3C2 distances, attaching a statistically defensible level of detection to every number, and turning significant change into polygons a tiling pipeline can act on.

It is written for pipeline engineers who already produce classified, filtered clouds with the methods in [LiDAR classification and ground extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/) and [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/), and who now have a second epoch of the same area.

## Prerequisites

- **Python 3.10+** with `pdal>=3.4` (PDAL 2.6+ underneath), `open3d>=0.18`, `py4dgeo>=0.7`, `laspy>=2.5`, `numpy>=1.24`, `scipy>=1.11`, `rasterio>=1.3` and `shapely>=2.0`.
- **Both epochs in the same compound CRS and the same datum realisation** — for example EPSG:32618+5703, both referenced to the same NAD83 realisation. Two surveys a few years apart in a dynamic frame can differ by centimetres from plate motion alone; the transformations are in [transforming between epoch-based datums](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/transforming-between-epoch-based-datums/).
- **ASPRS classification** in both epochs, at least ground (2), vegetation (3–5) and building (6), so stable surfaces can be selected and vegetation excluded.
- **An estimate of each epoch's vertical accuracy** from its survey report — the RMSEz against check points — because the level of detection depends on it.

## Concept

Change detection is a measurement with an uncertainty, and the uncertainty has three sources that add together: the roughness and sampling of each cloud, the registration error between the two, and the absolute accuracy of each survey. A computed difference is only change when it exceeds the combined uncertainty at the chosen confidence. That threshold is the **level of detection**, and a change map without one is a map of noise with some change in it.

Four distance methods cover nearly all production work.

**DSM differencing** rasterises the highest (or ground) return of each epoch into a grid and subtracts. It is fast, easy to explain, and measures only vertical change — a facade that moved horizontally by a metre shows up as a thin line of large values along the roof edge and nothing else.

**Cloud-to-cloud (C2C)** takes each point in the later epoch and measures the distance to its nearest neighbour in the earlier one. It needs no gridding and works on any geometry, but it is biased by density: where the reference cloud is sparse the nearest neighbour is far away even on an unchanged surface, so C2C reports change wherever point spacing is coarse.

**Cloud-to-mesh (C2M)** measures to a surface reconstructed from the reference epoch, which removes the density bias and inherits every defect of the reconstruction.

**M3C2** — Multiscale Model to Model Cloud Comparison — estimates a local surface normal at a set of core points, projects a cylinder along that normal through both clouds, and measures the distance between the mean positions of the two clouds' points inside the cylinder. It is signed, robust to density and roughness, works on vertical and overhanging surfaces, and returns a per-point level of detection. It is the method to reach for whenever the answer has to be defended.

<figure class="diagram">
<svg viewBox="6 6 748 282" role="img" aria-labelledby="cd-methods-t cd-methods-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cd-methods-t">C2C and M3C2 measuring the same wall</title>
  <desc id="cd-methods-d">Two epochs of a wall that did not move. On the left, cloud-to-cloud distance goes from each later point to its nearest earlier point, and because the earlier cloud is sparse the distances are several centimetres even though nothing changed. On the right, M3C2 averages the points of each epoch inside a cylinder along the surface normal and measures between the two averages, which returns nearly zero.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="282" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="220" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="220" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M580 60 h60 v140 h-60 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5" stroke-dasharray="5 3"/>
  <g stroke="#5b6471" stroke-width="1.5" fill="none">
    <path d="M150 70 L200 88"/><path d="M150 110 L200 104"/><path d="M150 150 L200 136"/><path d="M150 190 L200 184"/>
    <path d="M540 130 H690"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="150" cy="70" r="5"/><circle cx="150" cy="110" r="5"/><circle cx="150" cy="150" r="5"/><circle cx="150" cy="190" r="5"/>
    <circle cx="600" cy="80" r="5"/><circle cx="600" cy="120" r="5"/><circle cx="600" cy="160" r="5"/><circle cx="600" cy="190" r="5"/>
  </g>
  <g fill="#9a4f26">
    <circle cx="200" cy="88" r="4"/><circle cx="200" cy="104" r="4"/><circle cx="200" cy="120" r="4"/><circle cx="200" cy="136" r="4"/><circle cx="200" cy="152" r="4"/><circle cx="200" cy="168" r="4"/><circle cx="200" cy="184" r="4"/>
    <circle cx="620" cy="88" r="4"/><circle cx="620" cy="104" r="4"/><circle cx="620" cy="120" r="4"/><circle cx="620" cy="136" r="4"/><circle cx="620" cy="152" r="4"/><circle cx="620" cy="168" r="4"/><circle cx="620" cy="184" r="4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="46">C2C: nearest neighbour</text>
    <text x="570" y="46">M3C2: mean in a cylinder</text>
    <text x="190" y="226">reports 2–6 cm on a stable wall</text>
    <text x="570" y="226">reports ≈ 0 ± LoD</text>
  </g>
  <text x="80" y="130" fill="#1f6b8a" font-size="12" text-anchor="middle">sparse t₀</text>
  <text x="275" y="130" fill="#9a4f26" font-size="12" text-anchor="middle">dense t₁</text>
  <text x="380" y="270" fill="#15384a" font-size="12.5" text-anchor="middle">The density difference between epochs is measured as change by C2C, and averaged out by M3C2.</text>
</svg>
<figcaption>Nearest-neighbour distance confuses point spacing with displacement; a normal-aligned cylinder compares surfaces rather than individual points.</figcaption>
</figure>

## Step-by-Step Workflow

### 1. Confirm both epochs share a frame

```python
import laspy
import numpy as np
from pyproj import CRS

def epoch_summary(path):
    las = laspy.read(path)
    crs = las.header.parse_crs()
    return {
        "path": path,
        "crs": crs.to_string() if crs else None,
        "points": las.header.point_count,
        "classes": sorted(np.unique(las.classification).tolist()),
        "bounds": (las.header.mins.round(2).tolist(), las.header.maxs.round(2).tolist()),
    }

t0 = epoch_summary("depot_2025-04.laz")
t1 = epoch_summary("depot_2026-04.laz")
for e in (t0, t1):
    print(e)

assert t0["crs"] and t0["crs"] == t1["crs"], "epochs are not in the same CRS"
assert CRS.from_user_input(t0["crs"]).equals(CRS.from_user_input("EPSG:32618+5703"))
assert {2, 6} <= set(t0["classes"]) and {2, 6} <= set(t1["classes"]), "ground/building classes missing"
```

An equal CRS string is necessary and not sufficient. It says nothing about the datum realisation or the geoid model each contractor used, which is why the next step aligns on stable ground rather than trusting the headers.

### 2. Measure and remove registration error on stable surfaces

Registration error is the largest single contributor to false change, and it can only be estimated on surfaces known not to have moved. Hard ground away from construction — roads, car parks, the tops of long-standing buildings — is the usual choice.

```python
import open3d as o3d

def stable_cloud(path, classes=(2,), exclude_polygon_mask=None):
    las = laspy.read(path)
    keep = np.isin(las.classification, classes)
    xyz = np.column_stack([las.x, las.y, las.z])[keep]
    pcd = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz - OFFSET))
    return pcd.voxel_down_sample(0.25)

OFFSET = np.array([585000.0, 4511000.0, 0.0])      # keep Open3D in a small-coordinate frame
src = stable_cloud("depot_2026-04.laz")
dst = stable_cloud("depot_2025-04.laz")
for p in (src, dst):
    p.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=1.0, max_nn=30))

reg = o3d.pipelines.registration.registration_icp(
    src, dst, max_correspondence_distance=0.5, init=np.eye(4),
    estimation_method=o3d.pipelines.registration.TransformationEstimationPointToPlane(),
    criteria=o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=60),
)
print("fitness", round(reg.fitness, 3), "inlier RMSE (m)", round(reg.inlier_rmse, 4))
print("translation (m):", reg.transformation[:3, 3].round(4))
```

Look at the translation before applying it. A few millimetres to two centimetres is normal survey-to-survey disagreement and is worth removing. A vertical shift of several decimetres with no horizontal component is almost always a geoid-model or datum difference, and should be fixed by transforming heights properly rather than by ICP. A shift of metres means the stable mask included something that moved. The ICP mechanics, including robust kernels for noisy stable sets, are in [registering multi-epoch scans with ICP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/registering-multi-epoch-scans-with-icp/).

Record `reg.inlier_rmse` — after alignment, the residual on stable ground is the registration term in the level of detection. Then apply the accepted transformation to the *full* later epoch, not just its stable subset, and write it out as `depot_2026-04_aligned.laz` with PDAL's `filters.transformation` — remembering that the matrix was estimated in the offset frame, so shift by `-OFFSET`, transform, and shift back.

### 3. Get a fast vertical overview with DSM differencing

Before any per-point method, a DSM difference shows where to look and takes seconds.

```python
import json
import pdal
import rasterio

def dsm(path, out, resolution=0.5):
    pipeline = {
        "pipeline": [
            path,
            {"type": "filters.range", "limits": "Classification![7:7],Classification![18:18]"},
            {"type": "writers.gdal", "filename": out, "resolution": resolution,
             "output_type": "max", "data_type": "float32", "nodata": -9999,
             "gdaldriver": "GTiff", "override_srs": "EPSG:32618+5703"},
        ]
    }
    pdal.Pipeline(json.dumps(pipeline)).execute()

dsm("depot_2025-04.laz", "dsm_t0.tif")
dsm("depot_2026-04_aligned.laz", "dsm_t1.tif")

with rasterio.open("dsm_t0.tif") as a, rasterio.open("dsm_t1.tif") as b:
    assert a.transform == b.transform and a.shape == b.shape, "grids differ: set bounds explicitly"
    z0, z1 = a.read(1, masked=True), b.read(1, masked=True)
    dz = z1 - z0
print(f"dZ p1 {np.percentile(dz.compressed(), 1):.2f} m, p99 {np.percentile(dz.compressed(), 99):.2f} m")
```

Two epochs rarely produce identical grid extents from `writers.gdal` defaults, so pass explicit `bounds` in practice; the assertion exists to catch the case where you did not. The result is a vertical-only picture: excellent for stockpiles, roofs and demolitions, blind to walls.

### 4. Compute M3C2 distances with a level of detection

```python
import py4dgeo

epoch0, epoch1 = py4dgeo.read_from_las("depot_2025-04.laz", "depot_2026-04_aligned.laz")
corepoints = epoch0.cloud[::50]

m3c2 = py4dgeo.M3C2(
    epochs=(epoch0, epoch1),
    corepoints=corepoints,
    cyl_radius=1.0,
    normal_radii=(0.5, 1.0, 2.0),
    max_distance=10.0,
    registration_error=reg.inlier_rmse,
)
distances, uncertainties = m3c2.run()

lod = uncertainties["lodetection"]
significant = np.abs(distances) > lod
print(f"{np.isfinite(distances).sum()} core points, "
      f"{significant.sum()} significant ({100 * significant.mean():.1f}%), "
      f"median LoD {np.nanmedian(lod) * 1000:.0f} mm")
```

The registration error passed in is the stable-ground RMSE from step 2, which is exactly what the parameter is for: it is added to the spatially variable roughness term when py4dgeo computes `lodetection` at 95% confidence. Core points every fiftieth point keep the run tractable; the cylinder still averages all points of both epochs within `cyl_radius`, so subsampling core points loses resolution, not statistical support. The parameter choices are worked through in [M3C2 change detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/).

<figure class="diagram">
<svg viewBox="46 16 688 250" role="img" aria-labelledby="cd-lod-t cd-lod-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cd-lod-t">What adds up to the level of detection</title>
  <desc id="cd-lod-d">A stacked bar shows the level of detection for three surface types. Each bar has a roughness term from the local spread of points in both epochs and a registration term from stable-ground residuals. Smooth asphalt has a level of detection around two centimetres, a gravel stockpile around six, and low vegetation around twenty, so the same measured distance can be significant on one surface and noise on another.</desc>
  <rect class="svg-bg" x="46" y="16" width="688" height="250" fill="#ffffff"/>
  <path d="M60 30 V200 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 170 H720" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="6 4"/>
  <g stroke-width="1.5">
    <rect x="120" y="186" width="90" height="14" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="120" y="178" width="90" height="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="330" y="152" width="90" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="330" y="144" width="90" height="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="540" y="44" width="90" height="156" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="540" y="36" width="90" height="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="165" y="220">asphalt</text>
    <text x="375" y="220">gravel stockpile</text>
    <text x="585" y="220">low vegetation</text>
    <text x="165" y="166">2 cm</text>
    <text x="375" y="134">6 cm</text>
    <text x="700" y="120">20 cm</text>
  </g>
  <text x="700" y="164" fill="#b0413e" font-size="12" text-anchor="end">measured 4 cm</text>
  <text x="240" y="60" fill="#1f6b8a" font-size="12" text-anchor="start">blue: roughness of both epochs</text>
  <text x="240" y="78" fill="#9a4f26" font-size="12" text-anchor="start">orange: registration error</text>
  <text x="380" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">A 4 cm difference is change on asphalt and noise on a stockpile.</text>
</svg>
<figcaption>The level of detection is local. A single global threshold either misses change on smooth surfaces or floods rough ones with false positives.</figcaption>
</figure>

### 5. Turn significant change into polygons

A change map is useful to people; a set of polygons with areas and volumes is useful to pipelines.

```python
from scipy.spatial import cKDTree
from shapely.geometry import MultiPoint
from shapely.ops import unary_union

sig_xyz = corepoints[significant]
sig_d = distances[significant]

def cluster_points(xy, radius=1.5, min_points=20):
    tree = cKDTree(xy)
    pairs = tree.query_pairs(radius, output_type="ndarray")
    parent = np.arange(len(xy))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    roots = np.array([find(i) for i in range(len(xy))])
    return [np.flatnonzero(roots == r) for r in np.unique(roots)
            if (roots == r).sum() >= min_points]

polygons = []
for idx in cluster_points(sig_xyz[:, :2]):
    hull = MultiPoint(sig_xyz[idx, :2]).convex_hull.buffer(0.75)
    polygons.append({"geometry": hull, "mean_dz": float(np.mean(sig_d[idx])),
                     "area_m2": hull.area, "n": len(idx)})
print(f"{len(polygons)} change regions; largest {max(p['area_m2'] for p in polygons):.0f} m²")
```

The minimum-points filter is what removes the isolated significant core points that survive any threshold — a pedestrian, a parked car, a bird. The buffer makes adjacent fragments of the same change merge cleanly. Convex hulls are deliberately generous for a change *region*; when the exact outline matters, as for a new building footprint, use the concave-hull approach from [extracting building footprints from classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/).

### 6. Hand the regions to the tiling pipeline

```python
import json
from shapely.geometry import mapping

features = [{"type": "Feature", "geometry": mapping(p["geometry"]),
             "properties": {k: v for k, v in p.items() if k != "geometry"}} for p in polygons]
with open("changes_2025-04_2026-04.geojson", "w") as f:
    json.dump({"type": "FeatureCollection",
               "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32618"}},
               "features": features}, f)
```

This file is the contract between change detection and everything downstream. The retiling job intersects it with its shard grid to decide what to rebuild — the mechanics are in [flagging changed buildings for retiling](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/flagging-changed-buildings-for-retiling/) — and an asset register can attach each polygon to the building it overlaps.

<figure class="diagram">
<svg viewBox="-4 -4 768 220" role="img" aria-labelledby="cd-flow-t cd-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cd-flow-t">Change detection pipeline from two epochs to retiling</title>
  <desc id="cd-flow-d">Two classified epochs are aligned on stable ground, compared first with a fast DSM difference and then with M3C2 distances and levels of detection. Significant points are clustered into change polygons, which drive retiling and the asset register.</desc>
  <rect class="svg-bg" x="-4" y="-4" width="768" height="220" fill="#ffffff"/>
  <defs>
    <marker id="cd-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="60" width="110" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="160" y="60" width="120" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="320" y="10" width="120" height="60" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="320" y="110" width="120" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="480" y="110" width="120" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="640" y="60" width="110" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cd-flow-arrow)">
    <path d="M120 90 H158"/>
    <path d="M280 80 L318 50"/>
    <path d="M280 100 L318 130"/>
    <path d="M440 140 H478"/>
    <path d="M600 130 L638 104"/>
    <path d="M380 71 V108" stroke-dasharray="5 4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="86">epochs t₀, t₁</text>
    <text x="65" y="104">classified</text>
    <text x="220" y="86">align on</text>
    <text x="220" y="104">stable ground</text>
    <text x="380" y="36">DSM difference</text>
    <text x="380" y="54">where to look</text>
    <text x="380" y="136">M3C2 + LoD</text>
    <text x="380" y="154">per core point</text>
    <text x="540" y="136">cluster into</text>
    <text x="540" y="154">polygons</text>
    <text x="695" y="86">retile ·</text>
    <text x="695" y="104">register</text>
  </g>
  <text x="380" y="198" fill="#15384a" font-size="12.5" text-anchor="middle">The registration residual from the second box is an input to the level of detection in the fourth.</text>
</svg>
<figcaption>The DSM difference is a scout, not a result: it narrows attention and sets expectations before the slower, defensible per-point measurement.</figcaption>
</figure>

## Validation & Verification

A change-detection pipeline is validated on places where the truth is known in both directions: surfaces that did not change, and changes that were measured independently.

- **Stable-surface test.** On a car park or road excluded from the registration, the fraction of core points flagged significant should be close to 5% at a 95% level of detection — the false-positive rate the statistic promises. Much higher means the LoD is underestimated, usually because the registration error was left out.
- **Known-change test.** A stockpile volume from the site's weighbridge records, a demolition date from the planning register, a monitoring prism on a retaining wall. Compare the pipeline's number against it and record the difference as the pipeline's measured accuracy.
- **Symmetry test.** Swap the epochs and rerun. Every M3C2 distance should change sign and keep its magnitude within the LoD; asymmetry points at a density or normal-estimation problem.

```python
stable = np.load("carpark_corepoint_mask.npy")          # boolean, same order as corepoints
fp_rate = significant[stable].mean()
print(f"false-positive rate on stable asphalt: {100 * fp_rate:.1f}%")
assert fp_rate < 0.10, "level of detection is too optimistic"
```

### Reporting change to people who did not run the pipeline

The output of this workflow is usually read by a site manager, a planning officer or an asset owner, not a point-cloud engineer, and the way the numbers are presented decides whether they are trusted. Report every distance or volume with its level of detection in the same sentence — "38,900 m³ removed, ± 310 m³" — rather than in an appendix. Show unknown areas explicitly on the map in a neutral colour, with a note on why they are unknown, instead of leaving them blank where a reader will assume no change. And state the two survey dates and their vertical accuracies at the top, because a change of 6 cm between a survey accurate to 5 cm and one accurate to 10 cm is not the same finding as 6 cm between two 2 cm surveys. A report that makes its uncertainty easy to see is argued with less, not more.

## Performance & Scale

- **Tile both epochs on the same grid.** Process 500 m tiles with a 20 m overlap and keep only core points in each tile's interior, so every core point is computed once with full cylinder support at the edges.
- **Core-point spacing sets the cost.** M3C2 cost scales with core points times neighbours in the normal and cylinder radii. A 1 m core-point grid over a 4 km² city district is four million core points and runs in minutes on eight cores; every point of a 60 pts/m² cloud would take hours and add nothing a 1 m grid cannot show.
- **Keep coordinates small.** Subtract a tile origin before handing arrays to Open3D; single-precision internals lose centimetres at UTM magnitudes.
- **Cache the aligned epoch.** Registration is the slowest step per tile and its result is stable once accepted. Write the aligned cloud and the transformation, and reuse both when change parameters are tuned.

## Failure Modes & Gotchas

**Every tree is a change.** Vegetation grows, drops leaves and moves in wind; its roughness term is large but not always large enough. Exclude classes 3–5 before M3C2 unless vegetation change is the product.

**Change appears along the edges of every building.** The two epochs were flown from different directions, so each has occlusion shadows the other does not. C2C and DSM differencing report the shadows as change; M3C2 with a sensible `max_distance` returns no value there, which is correct. Treat no-value as "unknown", never as "no change".

**A uniform vertical offset of 30–40 cm across the site.** One contractor delivered ellipsoidal heights, the other orthometric, or they used different geoid models. The fix is a proper vertical transformation, not ICP.

**Stockpile volumes are consistently low.** DSM differencing at a coarse resolution with `output_type="max"` underestimates cut from the pile's slopes, and a wet surface on the second flight returned fewer points. Grid at no more than the point spacing and check the point count per cell in both epochs.

**Significant change on a stable roof after a re-flight.** The roof is sheet metal and the second flight was in rain: specular returns are missing and the remaining points are biased towards the ridge. Flag low-point-count cylinders using `uncertainties["num_samples1"]` and `["num_samples2"]` rather than trusting the distance.

## Frequently Asked Questions

### Should I use M3C2 or C2C?

M3C2 when the result will be reported or acted on; C2C for a quick look at two clouds with similar density. C2C cannot provide a level of detection and is biased where density differs, which is the normal situation between two contractors' surveys.

### How often can a site usefully be resurveyed?

As often as the expected change exceeds the level of detection. With airborne LiDAR at an 8–10 cm LoD, monthly flights over a construction site are informative; over a stable neighbourhood they measure only noise, and annual or event-driven resurveys are the better investment.

### Can I compare a LiDAR epoch with a photogrammetric one?

Yes, with care. Photogrammetric clouds are smoother on textured surfaces and noisier on uniform ones, and they have no penetration through vegetation. Use M3C2 so the roughness difference enters the level of detection, and expect a larger LoD than between two LiDAR epochs.

### Does the change detection need the mesh or the tiles?

No — work on the point clouds, which carry the measurement. Meshes and tiles are derived products, and differencing them adds reconstruction and decimation error to the uncertainty budget.

### What about horizontal movement of a structure?

M3C2 measures along the local normal, so a wall that moved sideways is detected on the wall and not on the roof. For monitoring deformation of a specific structure, track features or targets instead; area-based change detection finds *where* things changed, not the full displacement vector.

## Related Guides

- [Cloud-to-Cloud Distance with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/cloud-to-cloud-distance-with-open3d/) — the fast, biased first look
- [M3C2 Change Detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/) — parameters and levels of detection
- [Flagging Changed Buildings for Retiling](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/flagging-changed-buildings-for-retiling/) — from change polygons to a rebuild list
- [Registering Multi-Epoch Scans with ICP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/registering-multi-epoch-scans-with-icp/) — the alignment every comparison depends on
- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — where detected change becomes new tiles

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
