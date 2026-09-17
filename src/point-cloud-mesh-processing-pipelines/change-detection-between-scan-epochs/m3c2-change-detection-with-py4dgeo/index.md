---
title: "M3C2 Change Detection with py4dgeo"
description: "Run M3C2 between two LiDAR epochs with py4dgeo: core-point grids, normal and cylinder radii, registration error, levels of detection and reading the uncertainty output."
---
# M3C2 Change Detection with py4dgeo

This page runs M3C2 (Multiscale Model to Model Cloud Comparison) between two LAZ epochs with the `py4dgeo` library — building a regular core-point grid, choosing the normal and cylinder radii from the data rather than by habit, feeding in the measured registration error, and reading the per-point level of detection and sample counts that make the result defensible.

## Why you hit this

A stockpile report, a subsidence alert or a claim that a contractor over-excavated all need a distance with an uncertainty attached, and M3C2 is the standard method that provides one. It is also a method with four parameters that interact, and the defaults in most tutorials are tuned for terrestrial scans of cliffs at hundreds of points per square metre. Run with those settings on 20 pts/m² airborne data and nearly every cylinder is under-sampled: distances come back as `NaN` across half the site, or as confident numbers computed from three points. The broader workflow this sits inside, from registration to change polygons, is in [change detection between LiDAR scan epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).

## Prerequisites

- `py4dgeo>=0.7` (`pip install py4dgeo`), `laspy[lazrs]>=2.5`, `numpy>=1.24`.
- Two epochs in the same CRS, EPSG:32618+5703 in the examples, registered on stable ground, with vegetation and noise classes removed.
- The stable-ground registration residual from the alignment step, in metres — typically 0.01–0.03 m between two airborne surveys.
- A rough idea of the point density of each epoch; `pdal info --metadata` reports it, or see [computing point density from LAZ with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/computing-point-density-from-laz-with-pdal/).

## Step-by-Step

### 1. Load the epochs and build a regular core-point grid

```python
import numpy as np
import py4dgeo

epoch0, epoch1 = py4dgeo.read_from_las("quarry_2025-06_ground.laz", "quarry_2026-06_ground.laz")
print(f"t0 {epoch0.cloud.shape[0]:,} pts, t1 {epoch1.cloud.shape[0]:,} pts")

def grid_corepoints(cloud, spacing=1.0):
    cells = np.floor(cloud[:, :2] / spacing).astype(np.int64)
    _, first = np.unique(cells, axis=0, return_index=True)
    return cloud[np.sort(first)]

corepoints = grid_corepoints(epoch0.cloud, spacing=1.0)
print(f"{len(corepoints):,} core points at 1 m spacing")
```

A grid of core points, one per square metre of the reference epoch, is better than every n-th point for two reasons. Its results can be rasterised and summed per cell without a density weighting, which matters for volumes. And it spends computation evenly across the site instead of concentrating it where overlapping flight lines tripled the density.

### 2. Choose the normal radius from surface roughness

The normal radius D sets the scale at which the surface orientation is estimated. Too small and the normal follows every pebble; too large and it smooths over a real edge.

```python
from scipy.spatial import cKDTree

def roughness_at(cloud, sample, radius):
    tree = cKDTree(cloud)
    out = []
    for p in sample:
        nbrs = cloud[tree.query_ball_point(p, radius)]
        if len(nbrs) < 10:
            continue
        centred = nbrs - nbrs.mean(axis=0)
        out.append(np.sqrt(np.linalg.eigvalsh(centred.T @ centred / len(nbrs))[0]))
    return np.median(out)

sample = corepoints[np.random.default_rng(7).choice(len(corepoints), 2000, replace=False)]
for r in (0.25, 0.5, 1.0, 2.0):
    print(f"radius {r:4.2f} m → roughness σ ≈ {roughness_at(epoch0.cloud, sample, r) * 1000:.1f} mm")
```

The square root of the smallest eigenvalue is the standard deviation of the points about their best-fit plane — the local roughness. The guidance from the method's authors is that the normal scale should be roughly twenty to twenty-five times the roughness, so that surface noise does not tilt the normal. For a quarry floor with 20 mm roughness that points to a normal radius around 0.5 m; for a rubble slope with 80 mm, closer to 2 m. Passing several radii lets py4dgeo pick, per core point, the scale at which the surface is most planar.

<figure class="diagram">
<svg viewBox="26 26 707 258" role="img" aria-labelledby="m3-geom-t m3-geom-d" xmlns="http://www.w3.org/2000/svg">
  <title id="m3-geom-t">The two radii that define an M3C2 measurement</title>
  <desc id="m3-geom-d">At a core point, the normal is estimated from all points within the normal radius. A cylinder of the projection radius is then extended along that normal through both epochs up to the maximum distance. The distance is the separation of the two epochs' mean positions along the normal, and the spread and count of points in each epoch's slice of the cylinder give the level of detection.</desc>
  <rect class="svg-bg" x="26" y="26" width="707" height="258" fill="#ffffff"/>
  <path d="M40 200 C160 190 260 206 400 196 C500 190 560 200 700 194" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M40 150 C160 140 260 156 400 146 C500 140 560 150 700 144" fill="none" stroke="#9a4f26" stroke-width="2.5"/>
  <path d="M250 230 A120 22 0 0 0 490 230 A120 22 0 0 0 250 230 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M340 40 H410 V250 H340 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5" fill-opacity="0.35"/>
  <path d="M375 250 V36" fill="none" stroke="#1f2937" stroke-width="2"/>
  <circle cx="375" cy="198" r="5" fill="#1f2937"/>
  <path d="M362 198 H388" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M362 147 H388" fill="none" stroke="#9a4f26" stroke-width="3"/>
  <text x="600" y="220" fill="#1f6b8a" font-size="12.5" text-anchor="middle">epoch t₀</text>
  <text x="600" y="132" fill="#9a4f26" font-size="12.5" text-anchor="middle">epoch t₁</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="420" y="60">cylinder radius d</text>
    <text x="420" y="78">≥ 20–30 points per epoch</text>
    <text x="500" y="266">normal radius D ≈ 20–25 × roughness</text>
  </g>
  <text x="330" y="176" fill="#1f2937" font-size="12.5" text-anchor="end">distance</text>
  <text x="160" y="60" fill="#15384a" font-size="12.5" text-anchor="middle">max_distance caps</text>
  <text x="160" y="78" fill="#15384a" font-size="12.5" text-anchor="middle">the cylinder length</text>
</svg>
<figcaption>D decides which way the cylinder points; d decides how many points each epoch contributes to the mean. They are tuned to different properties of the data.</figcaption>
</figure>

### 3. Choose the cylinder radius from point density

The cylinder has to contain enough points in each epoch for the mean position and its spread to be meaningful.

```python
density_t0 = 18.0      # pts/m², from pdal info on the ground-classified tile
density_t1 = 31.0
target = 30
cyl_radius = np.sqrt(target / (np.pi * min(density_t0, density_t1)))
print(f"cylinder radius for ≥{target} pts in the sparser epoch: {cyl_radius:.2f} m")
```

For 18 pts/m² that gives about 0.73 m. The number is set by the *sparser* epoch, because the level of detection is dominated by whichever mean is less certain. Round up rather than down: a cylinder with 25 points gives a slightly smoother distance map; one with 8 gives a level of detection that is itself noisy.

### 4. Run M3C2 with the registration error

```python
m3c2 = py4dgeo.M3C2(
    epochs=(epoch0, epoch1),
    corepoints=corepoints,
    normal_radii=(0.5, 1.0, 2.0),
    cyl_radius=0.75,
    max_distance=15.0,
    registration_error=0.018,
)
distances, uncertainties = m3c2.run()

lod = uncertainties["lodetection"]
n0, n1 = uncertainties["num_samples1"], uncertainties["num_samples2"]
valid = np.isfinite(distances)
print(f"valid {valid.mean() * 100:.1f}% | median LoD {np.nanmedian(lod) * 1000:.0f} mm | "
      f"median samples t0 {np.median(n0[valid]):.0f}, t1 {np.median(n1[valid]):.0f}")
```

`max_distance` bounds how far along the normal the cylinder looks for the second epoch. Set it just above the largest change you expect — 15 m covers a year of quarrying — because a longer cylinder on a steep face can pass through an unrelated surface and return a plausible, wrong distance. `registration_error` is added to the level of detection for every core point, so a well-registered pair gains sensitivity everywhere.

### 5. Classify each core point

```python
MIN_SAMPLES = 10
reliable = valid & (n0 >= MIN_SAMPLES) & (n1 >= MIN_SAMPLES)
significant = reliable & (np.abs(distances) > lod)

status = np.full(len(corepoints), "unknown", dtype=object)
status[reliable & ~significant] = "no detectable change"
status[significant & (distances > 0)] = "gain"
status[significant & (distances < 0)] = "loss"

for s in ("gain", "loss", "no detectable change", "unknown"):
    print(f"{s:>22}: {(status == s).mean() * 100:5.1f}%")
```

Three outcomes are not enough; there have to be four. A core point with no second-epoch points in its cylinder, or too few, is not "no change" — it is unmeasured, and reporting it as stable is how an occluded area behind a new building ends up certified as unchanged.

<figure class="diagram">
<svg viewBox="6 6 752 258" role="img" aria-labelledby="m3-class-t m3-class-d" xmlns="http://www.w3.org/2000/svg">
  <title id="m3-class-t">Four outcomes for every core point</title>
  <desc id="m3-class-d">A decision tree. If either epoch has too few samples in the cylinder, or the distance is not finite, the core point is unknown. Otherwise, if the absolute distance is at most the level of detection, there is no detectable change. If it exceeds the level of detection, the sign of the distance decides between gain and loss.</desc>
  <rect class="svg-bg" x="6" y="6" width="752" height="258" fill="#ffffff"/>
  <defs>
    <marker id="m3-class-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="90" width="190" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="270" y="20" width="170" height="44" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="270" y="150" width="170" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="500" y="110" width="110" height="40" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="500" y="200" width="110" height="40" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="650" y="170" width="94" height="36" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="650" y="214" width="94" height="36" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#m3-class-arrow)">
    <path d="M210 104 L268 50"/>
    <path d="M210 132 L268 172"/>
    <path d="M440 168 L498 136"/>
    <path d="M440 192 L498 216"/>
    <path d="M610 214 L648 190"/>
    <path d="M610 226 L648 230"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="115" y="114">samples ≥ 10 in</text>
    <text x="115" y="132">both epochs?</text>
    <text x="355" y="47">unknown</text>
    <text x="355" y="174">|distance|</text>
    <text x="355" y="192">&gt; LoD?</text>
    <text x="555" y="135">no change</text>
    <text x="555" y="225">change</text>
    <text x="697" y="193">gain</text>
    <text x="697" y="237">loss</text>
  </g>
  <text x="232" y="68" fill="#5b6471" font-size="11.5" text-anchor="middle">no</text>
  <text x="232" y="166" fill="#5b6471" font-size="11.5" text-anchor="middle">yes</text>
</svg>
<figcaption>"Unknown" is a result. Folding it into "no change" turns every occlusion shadow into a false certificate of stability.</figcaption>
</figure>

### 6. Compute volume change per cell

Because core points sit on a 1 m grid, each significant distance on near-horizontal ground represents one square metre of change.

```python
horizontal = np.abs(m3c2.directions()[:, 2]) > 0.9            # normal within ~25° of vertical
cell_area = 1.0
gain_m3 = (distances[significant & horizontal & (distances > 0)]).sum() * cell_area
loss_m3 = -(distances[significant & horizontal & (distances < 0)]).sum() * cell_area
lod_vol = np.sqrt((lod[significant & horizontal] ** 2).sum()) * cell_area
print(f"gain {gain_m3:,.0f} m³, loss {loss_m3:,.0f} m³, ± {lod_vol:,.0f} m³ (quadrature LoD)")
```

Restricting volume to near-horizontal normals avoids counting a quarry face twice — once as horizontal retreat along its normal and again in the floor below it. Summing levels of detection in quadrature assumes independent cells, which is optimistic for registration error shared by the whole site; for a conservative bound, add `registration_error × area` linearly.

## Expected Output & Verification

```text
t0 7,204,611 pts, t1 12,388,092 pts
181,442 core points at 1 m spacing
cylinder radius for ≥30 pts in the sparser epoch: 0.73 m
valid 96.4% | median LoD 61 mm | median samples t0 29, t1 52
                  gain:   3.8%
                  loss:  21.6%
  no detectable change:  70.9%
               unknown:   3.7%
gain 1,420 m³, loss 38,915 m³, ± 312 m³ (quadrature LoD)
```

Verify against something the pipeline did not produce. Swap the epochs and rerun: gain and loss should exchange, and each core point's distance should change sign within its LoD. Then compare the loss against the site's extraction records — weighbridge tonnage divided by the material's bulk density — and expect agreement within a few percent; a larger gap usually traces back to a stockpile outside the surveyed extent.

<figure class="diagram">
<svg viewBox="56 6 658 248" role="img" aria-labelledby="m3-rad-t m3-rad-d" xmlns="http://www.w3.org/2000/svg">
  <title id="m3-rad-t">Effect of cylinder radius on level of detection and resolution</title>
  <desc id="m3-rad-d">As the cylinder radius grows from 0.25 to 2 metres on an 18 points per square metre survey, the median number of samples per cylinder rises and the level of detection falls quickly at first and then flattens, while the smallest resolvable feature grows linearly. The useful range is where the level of detection has flattened but features are still small, around 0.6 to 1 metre.</desc>
  <rect class="svg-bg" x="56" y="6" width="658" height="248" fill="#ffffff"/>
  <path d="M70 20 V190 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="250" y="20" width="160" height="170" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1"/>
  <polyline points="100,40 180,100 260,136 340,152 420,160 540,166 660,169" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="100,182 180,172 260,160 340,148 420,136 540,112 660,90" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="210">0.25</text><text x="260" y="210">0.6</text><text x="420" y="210">1.0</text>
    <text x="540" y="210">1.5</text><text x="660" y="210">2.0 m</text>
  </g>
  <text x="190" y="56" fill="#1f6b8a" font-size="12.5" text-anchor="start">level of detection</text>
  <text x="560" y="88" fill="#b0413e" font-size="12.5" text-anchor="end">smallest resolvable feature</text>
  <text x="330" y="44" fill="#1f2937" font-size="12" text-anchor="middle">useful range</text>
  <text x="385" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">cylinder radius, for an 18 pts/m² airborne survey</text>
</svg>
<figcaption>Beyond about 30 samples per cylinder, a larger radius buys almost no sensitivity and keeps costing spatial resolution.</figcaption>
</figure>

## Common Errors

**Most distances are `NaN`.** The cylinder radius is too small for the density, or `max_distance` is shorter than the change. Check `num_samples2` on a known-changed area: zero samples with a large expected change means `max_distance`; a handful of samples everywhere means the radius.

**The level of detection is implausibly small, a few millimetres.** `registration_error` was left at its default of zero, so only the roughness term is counted. Two independent surveys never agree to a few millimetres; pass the measured stable-ground residual.

**Distances have the wrong sign on some slopes.** Normals are oriented by default towards positive z, and on overhanging or near-vertical faces that flips between neighbouring core points. For cliffs and walls, orient normals towards the scanner position or a known viewpoint using py4dgeo's orientation options for your version before comparing signs.

## Frequently Asked Questions

### How is this different from CloudCompare's M3C2 plugin?

Same algorithm and the same parameters, run from Python, which is what a pipeline needs: reproducible settings in version control, tiles processed in a batch job and results written straight into the next step. Use CloudCompare to explore a pair of epochs interactively and to sanity-check parameters.

### Should core points come from the earlier or later epoch?

Conventionally the earlier one, so distances describe what happened *to* the reference surface. For a newly built area with no earlier points, use a regular XY grid lifted to the later epoch's surface; otherwise the new structure has no core points at all.

### Can M3C2 run on a whole city at once?

Not in one call on one machine. Tile both epochs on the same grid with an overlap at least the size of the largest radius, run tiles in parallel and keep only each tile's interior core points.

## Related Guides

- [Cloud-to-Cloud Distance with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/cloud-to-cloud-distance-with-open3d/) — fast screening before M3C2
- [Flagging Changed Buildings for Retiling](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/flagging-changed-buildings-for-retiling/) — turning significant change into rebuild work
- [Registering Multi-Epoch Scans with ICP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/registering-multi-epoch-scans-with-icp/) — producing the registration error this page consumes

Back to [Change Detection Between LiDAR Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
