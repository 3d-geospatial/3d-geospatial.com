---
title: "Removing Noise from Terrestrial LiDAR Scans"
description: "Remove noise from terrestrial LiDAR scans with statistical and radius outlier removal in Open3D, laspy, and numpy, preserving CRS and structural edges."
---
# Removing Noise from Terrestrial LiDAR Scans

Removing noise from terrestrial LiDAR (TLS) scans means stripping atmospheric scatter, multipath ghosts, and edge fringe out of a `.laz`/`.ply` scan with statistical outlier removal (SOR) and radius outlier removal in `open3d`, while keeping the surviving points in their original projected coordinate reference system. This page walks the exact `remove_statistical_outlier(nb_neighbors=sor_k, std_ratio=sor_std)` and `remove_radius_outlier` calls, how to load a scan with `laspy` so coordinates stay in metres, and how to verify that you retained a sane fraction of the original points instead of accidentally erasing real geometry.

You hit this because a raw TLS station is never clean. A Faro, Leica, or Riegl scanner fires millions of pulses per second, and every pulse that clips a glass facade, passes through fog, or splits at a sharp corner returns a point that does not belong to any real surface. Feed those points straight into [Poisson surface reconstruction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) and the mesh balloons with floating blobs and spiky artifacts; feed them into registration and the alignment drifts. Cleaning is the cheapest stage to get right and the most expensive to skip — these broader [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) are the precondition for everything downstream.

TLS noise is not one phenomenon, and that is why a single filter never does the job. Atmospheric and particulate scatter — rain, fog, dust, snow — shows up as a sparse diffuse haze scattered evenly through the air, with no local structure. Multipath and edge fringe is the opposite: where the laser beam straddles a sharp edge or reflects off glass or polished metal, returns split between the near and far surface, producing small but internally dense clumps of ghost points offset a few centimetres from the real geometry. Statistical outlier removal is built for the first kind and radius outlier removal for the second, which is why the production answer is a two-stage pass rather than one aggressive filter. The third category — registration and sensor artifacts such as station misalignment or IMU drift — is not noise in the per-point sense and is not solved here; it belongs to the alignment stage, where ICP with robust rejection handles systematic offsets between scan stations.

<figure class="diagram">
<svg viewBox="1 56 758 108" role="img" aria-labelledby="tlsnoise-t tlsnoise-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tlsnoise-t">TLS noise removal stages</title>
  <desc id="tlsnoise-d">A raw scan flows through statistical outlier removal to drop atmospheric scatter, then radius outlier removal to drop isolated multipath clusters, producing a cleaned cloud in the same projected CRS.</desc>
  <rect class="svg-bg" x="1" y="56" width="758" height="108" fill="#ffffff"/>
  <defs>
    <marker id="tlsnoise-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="15" y="70" width="170" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="245" y="70" width="170" height="80" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="475" y="70" width="140" height="80" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="645" y="70" width="100" height="80" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#tlsnoise-arrow)">
    <line x1="186" y1="110" x2="243" y2="110"/>
    <line x1="416" y1="110" x2="473" y2="110"/>
    <line x1="616" y1="110" x2="643" y2="110"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="100" y="105"><tspan x="100" dy="0">Raw TLS scan</tspan><tspan x="100" dy="16">EPSG:32633</tspan></text>
    <text x="330" y="105"><tspan x="330" dy="0">Statistical</tspan><tspan x="330" dy="16">outlier (SOR)</tspan></text>
    <text x="545" y="105"><tspan x="545" dy="0">Radius</tspan><tspan x="545" dy="16">outlier</tspan></text>
    <text x="695" y="105"><tspan x="695" dy="0">Cleaned</tspan><tspan x="695" dy="16">cloud</tspan></text>
  </g>
</svg>
<figcaption>SOR removes diffuse atmospheric scatter; radius filtering removes isolated multipath clusters; the CRS is preserved throughout.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `open3d==0.18.0`, `laspy==2.5.4` (install with `pip install "laspy[lazrs]"` for `.laz` support), and `numpy==1.26.4`.
- A terrestrial scan as `.laz`, `.las`, `.ply`, or `.xyz`. The examples assume a `.laz` station already in a projected, metric CRS — UTM zone 33N (EPSG:32633) is used throughout. If your scan is in geographic WGS84 (EPSG:4326), reproject to a metric CRS first, because SOR and radius thresholds are expressed in metres and are meaningless in degrees.
- Knowledge of your scanner's nominal point spacing at the working range (typically 0.005–0.02 m for TLS). This sets the `radius` parameter.
- Roughly 4–6 GB of free RAM per 50 M points; the radius query builds a KD-tree over every surviving point.

## Step-by-Step

### 1. Load the scan and keep coordinates in metres

`open3d` readers discard CRS metadata and choke on `.laz`, so load with `laspy` and hand `open3d` a `numpy` array of projected XYZ in metres. Record the EPSG code yourself — it does not survive the round trip.

```python
import laspy
import numpy as np
import open3d as o3d

SRC_EPSG = "EPSG:32633"  # UTM zone 33N, metres — record it; laspy/open3d won't carry it

las = laspy.read("station_07.laz")
xyz = np.vstack((las.x, las.y, las.z)).T.astype(np.float64)  # already metres in EPSG:32633

# Shift to a local origin so float32 KD-tree math stays precise on large UTM eastings.
origin = xyz.min(axis=0)
pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(xyz - origin)
original_count = len(pcd.points)
print(f"Loaded {original_count:,} points in {SRC_EPSG}")
```

### 2. Statistical outlier removal (`sor_k`, `sor_std`)

SOR computes each point's mean distance to its `sor_k` nearest neighbours, then drops any point whose mean distance lies more than `sor_std` standard deviations above the global average. This sweeps out diffuse atmospheric scatter — fog, rain, dust — that sits sparsely off the surface.

```python
sor_k = 20      # neighbours per point; 15–30 for dense TLS
sor_std = 2.0   # std-dev multiplier; 1.5–2.5 typical, <1.0 over-prunes

pcd_sor, keep_sor = pcd.remove_statistical_outlier(nb_neighbors=sor_k,
                                                   std_ratio=sor_std)
removed_sor = original_count - len(pcd_sor.points)
print(f"SOR removed {removed_sor:,} points "
      f"({len(pcd_sor.points)/original_count:.1%} retained)")
```

`remove_statistical_outlier` returns the filtered cloud and the indices it kept (`keep_sor`). Apply the same index list to intensity or RGB arrays so attributes stay aligned with the points. The two parameters trade off against each other: `sor_k` sets how many neighbours define "local", so a larger value smooths over local density variation and is more forgiving on sparsely sampled facades, while a smaller value reacts to every thin protrusion. `sor_std` sets the cut line on the resulting distribution. On dense, evenly-sampled indoor scans you can run `sor_k=20, sor_std=2.0` confidently; on long-range outdoor stations where point spacing grows with distance, raise `sor_k` toward 30 so the far field is not mistaken for outliers. Tune both on a 10% random subset of the scan first — the statistics are stable enough that subset behaviour predicts full-scan behaviour, and you avoid waiting minutes per iteration on a 15 M-point cloud.

<figure class="diagram">
<svg viewBox="-2 4 744 300" role="img" aria-labelledby="tls-std-t tls-std-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tls-std-t">Where sor_std actually cuts</title>
  <desc id="tls-std-d">A histogram of each point's mean distance to its k nearest neighbours. The threshold sits at the mean plus sor_std standard deviations, so lowering sor_std slides the cut left into the body of the distribution and starts removing surface points rather than noise.</desc>
  <rect class="svg-bg" x="-2" y="4" width="744" height="300" fill="#ffffff"/>
  <text x="370" y="32" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Mean distance to the k nearest neighbours, per point</text>
  <rect x="90" y="212" width="36" height="3" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="138" y="197" width="36" height="18" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="186" y="156" width="36" height="59" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="234" y="102" width="36" height="113" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="282" y="65" width="36" height="150" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="330" y="96" width="36" height="119" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="378" y="146" width="36" height="69" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="426" y="185" width="36" height="30" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="474" y="203" width="36" height="12" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="522" y="210" width="36" height="5" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="570" y="213" width="36" height="2" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="618" y="214" width="36" height="1" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M80 215 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M474 54 V222" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M330 54 V222" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="474" y="48" fill="#b0413e" font-size="12" text-anchor="middle">sor_std = 2.0 — cuts 1.1%</text>
  <text x="300" y="48" fill="#c46a3d" font-size="12" text-anchor="middle">sor_std = 1.0 — cuts 19%</text>
  <g fill="#1f2937" font-size="11" text-anchor="middle">
    <text x="108" y="234">0.02</text>
    <text x="156" y="234">0.04</text>
    <text x="204" y="234">0.06</text>
    <text x="252" y="234">0.08</text>
    <text x="300" y="234">0.10</text>
    <text x="348" y="234">0.12</text>
    <text x="396" y="234">0.14</text>
    <text x="444" y="234">0.16</text>
    <text x="492" y="234">0.18</text>
    <text x="540" y="234">0.20</text>
    <text x="588" y="234">0.24</text>
    <text x="636" y="234">0.30</text>
  </g>
  <text x="370" y="258" fill="#5b6471" font-size="12" text-anchor="middle">mean neighbour distance (m)</text>
  <text x="370" y="286" fill="#15384a" font-size="12" text-anchor="middle">Below about 1.5 the threshold enters the bulk of the distribution, and the filter starts thinning the surface it was meant to clean</text>
</svg>
<figcaption>The parameter is a position on this curve, not a strength setting. Plot the distribution once for a representative scan and the right value stops being a guess.</figcaption>
</figure>

### 3. Radius outlier removal

SOR leaves behind small dense clumps — multipath ghosts at corners and on glass that are internally consistent but isolated from real geometry. Radius filtering drops any point with fewer than `min_neighbors` points inside a sphere of `radius` metres.

```python
radius = 0.04        # metres; set to 2–3x nominal point spacing
min_neighbors = 8    # 5–15; lower keeps thin features like rebar

pcd_clean, keep_rad = pcd_sor.remove_radius_outlier(nb_points=min_neighbors,
                                                    radius=radius)
removed_rad = len(pcd_sor.points) - len(pcd_clean.points)
print(f"Radius filter removed {removed_rad:,} points "
      f"({len(pcd_clean.points)/original_count:.1%} of original retained)")
```

Because `radius` is in metres, this step is only correct on a metric CRS — another reason to reproject geographic scans before filtering. Set `radius` to roughly two to three times your scanner's nominal point spacing at the working range: a TLS station sampling at 0.01 m wants a `radius` near 0.03 m, so a genuine surface point reliably finds its `min_neighbors` while an isolated ghost a few centimetres off the wall does not. Keep `min_neighbors` modest (5–15). Pushing it higher does remove more fringe, but it also clips genuinely thin features — handrails, rebar, conduit, sign posts — that legitimately have few neighbours within the sphere. When in doubt, prefer a slightly larger `radius` over a larger `min_neighbors`; the former tolerates sparse-but-real geometry, the latter punishes it.

<figure class="diagram">
<svg viewBox="-1 48 742 244" role="img" aria-labelledby="tls-ord-t tls-ord-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tls-ord-t">Why statistical removal runs before radius removal</title>
  <desc id="tls-ord-d">Statistical outlier removal computes a mean and standard deviation over the whole cloud, so a cluster of far-field noise inflates both and moves the threshold outward. Removing the isolated points first with a radius test would change those statistics; running the statistical pass first, while the distribution still contains the noise it is meant to describe, is what keeps the threshold meaningful.</desc>
  <rect class="svg-bg" x="-1" y="48" width="742" height="244" fill="#ffffff"/>
  <defs>
    <marker id="tls-ord-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="24" y="62" width="180" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="256" y="62" width="200" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="508" y="62" width="208" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="24" y="166" width="180" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="256" y="166" width="200" height="56" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="508" y="166" width="208" height="56" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#tls-ord-a)">
    <line x1="204" y1="90" x2="254" y2="90"/>
    <line x1="456" y1="90" x2="506" y2="90"/>
    <line x1="204" y1="194" x2="254" y2="194"/>
    <line x1="456" y1="194" x2="506" y2="194"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="114" y="95">raw scan</text>
    <text x="356" y="85"><tspan x="356" dy="0">statistical removal</tspan><tspan x="356" dy="16">threshold set on real noise</tspan></text>
    <text x="612" y="85"><tspan x="612" dy="0">radius removal</tspan><tspan x="612" dy="16">clears the last stragglers</tspan></text>
    <text x="114" y="199">raw scan</text>
    <text x="356" y="189"><tspan x="356" dy="0">radius removal first</tspan><tspan x="356" dy="16">far-field cluster gone</tspan></text>
    <text x="612" y="189"><tspan x="612" dy="0">statistical removal now sees</tspan><tspan x="612" dy="16">a tighter σ and over-cuts</tspan></text>
  </g>
  <text x="370" y="256" fill="#15384a" font-size="12.5" text-anchor="middle">The statistical test describes the distribution it is given. Cleaning the distribution first is what makes it cut into the surface.</text>
  <text x="370" y="274" fill="#5b6471" font-size="12" text-anchor="middle">Same two filters, same parameters, different result — order is part of the configuration</text>
</svg>
<figcaption>Both orders are defensible in isolation and only one is stable across scans. Fix the order in the pipeline definition rather than leaving it to whoever calls the functions.</figcaption>
</figure>

### 4. Restore the origin shift and save

Add the local origin back so the saved points sit at their true EPSG:32633 coordinates, then write out. Use `laspy` to keep a georeferenced `.laz`; use `open3d` for a quick `.ply` headed into meshing.

```python
cleaned_xyz = np.asarray(pcd_clean.points) + origin  # back to absolute EPSG:32633

# Option A: georeferenced .laz via laspy (preserves the LAS header / scaling)
out = laspy.LasData(las.header)
out.x, out.y, out.z = cleaned_xyz[:, 0], cleaned_xyz[:, 1], cleaned_xyz[:, 2]
out.write("station_07_clean.laz")

# Option B: .ply for downstream Open3D meshing
pcd_clean.points = o3d.utility.Vector3dVector(cleaned_xyz)
o3d.io.write_point_cloud("station_07_clean.ply", pcd_clean)
print(f"Saved {len(cleaned_xyz):,} points (EPSG:32633 recorded separately)")
```

## Expected Output & Verification

A correctly tuned pass on a clean indoor or facade scan removes roughly 1–5% of points; an outdoor scan shot in fog or rain can lose 10–20%. If you are dropping more than ~30%, the filter is too aggressive and is eating real surfaces. The console trace should look like this:

```text
Loaded 14,820,331 points in EPSG:32633
SOR removed 412,556 points (97.2% retained)
Radius filter removed 188,004 points (95.9% of original retained)
Saved 14,219,771 points (EPSG:32633 recorded separately)
```

Assert the invariants in code so a bad parameter set fails loudly instead of shipping a hollowed-out cloud:

```python
retained_ratio = len(pcd_clean.points) / original_count
assert 0.0 < retained_ratio < 1.0, "filter must remove some but not all points"
assert retained_ratio > 0.70, f"over-pruned: only {retained_ratio:.1%} retained"
print(f"Removed {original_count - len(pcd_clean.points):,} points, "
      f"retained {retained_ratio:.1%}")
```

For a visual check, write the removed points to a second file (`pcd.select_by_index(keep_sor, invert=True)`) and overlay both in CloudCompare or QGIS. Real noise looks like a diffuse halo and isolated specks; if the removed set traces stair nosings, bolt heads, or window mullions, raise `sor_std` and re-run. This inverted-set inspection is the single most useful diagnostic in tuning — the retained cloud rarely reveals what you have over-removed, but the discarded cloud does so immediately. Keep the removed file from each run so you can compare parameter sets side by side instead of judging from memory.

Quantify the result rather than eyeballing it where you can. If you have surveyed control points or a known planar reference (a flat wall, a calibration board), fit a plane to the cleaned points in that region with `numpy.linalg.lstsq` and check that the residual standard deviation has dropped versus the raw cloud and now sits near the scanner's rated range noise. A clean facade pass should leave plane residuals in the low millimetres; if they are still centimetre-scale, scatter survived the filter and `sor_std` is too high.

## Common Errors

**`RuntimeError: [Open3D ERROR] ... read_point_cloud ... Unknown file extension for file (station_07.laz)`** — `open3d` cannot read `.laz`/`.las`. Load with `laspy.read()` and build the `PointCloud` from a `numpy` array as in Step 1, rather than calling `o3d.io.read_point_cloud` on the LAS file directly.

**`ModuleNotFoundError: No module named 'lazrs'`** (or `laspy.errors.LaspyException: No LazBackend selected`) — plain `laspy` reads `.las` but not compressed `.laz`. Reinstall with a backend: `pip install "laspy[lazrs]"` or `pip install "laspy[laszip]"`.

**Filter removes almost nothing, or removes nearly everything.** If `removed_sor` is near zero, your coordinates are probably not in metres — a scan still in EPSG:4326 has neighbour distances of ~1e-5 degrees, so `std_ratio` thresholds never trigger. If it removes the bulk of the cloud, the local-origin shift in Step 1 was skipped and large UTM eastings (~500000 m) lost float precision in the KD-tree. Reproject to a metric CRS and subtract the origin before filtering.

## Frequently Asked Questions

### What is the difference between sor_std values below and above 1.0?
`sor_std` (the `std_ratio`) is how many standard deviations above the mean neighbour-distance a point may sit before it is dropped. Below 1.0 you are pruning points that are barely above average — that includes valid surface points on thin or sparsely-sampled features, so detail vanishes. Above ~3.0 you only catch extreme outliers and leave most atmospheric scatter behind. Start at 2.0 and tune on a subset.

### Should I run SOR or radius removal first?
Run SOR first. SOR is a global statistical pass that clears the broad haze of scatter cheaply, which shrinks the cloud before the more expensive per-point radius query runs. Radius removal then mops up the dense isolated clumps SOR leaves intact. Reversing the order works but wastes time building a KD-tree over points SOR would have deleted anyway.

### How do I keep intensity and RGB aligned after filtering?
Both `remove_statistical_outlier` and `remove_radius_outlier` return the kept indices as their second value. Apply those same indices to your `numpy` attribute arrays — `intensity = intensity[keep_sor][keep_rad]` — so every attribute row still matches its point. If you save via `laspy`, slice the original `las.intensity`/`las.red` arrays by the composed index before writing.

## Related Guides

- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — the full filtering toolkit this fits into
- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — the meshing step a cleaned cloud feeds
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — choosing the density your filter should preserve
- [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) — the processing section this belongs to

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
