---
title: "Cloud-to-Cloud Distance with Open3D"
description: "Compute cloud-to-cloud distances between two LiDAR epochs with Open3D and SciPy: nearest-neighbour C2C, signed local-plane distances, and the density bias to correct."
---
# Cloud-to-Cloud Distance with Open3D

This page computes cloud-to-cloud (C2C) distances between two LAZ epochs of the same site with Open3D's `compute_point_cloud_distance`, then improves on it with a signed, local-plane distance built on a SciPy KD-tree — the correction that removes most of the density bias raw nearest-neighbour distances carry.

## Why you hit this

C2C is the first comparison most people run when a second survey arrives, because it is one function call and needs no parameters. It answers "where are the two clouds far apart?" in seconds, which is exactly the right first question. It also answers it with a systematic error: on a surface that did not move, the nearest point in a sparse reference cloud can be several centimetres away purely because of point spacing. Knowing the size of that error, and removing most of it cheaply, is what turns C2C from a picture into a usable screening step before the full [M3C2 change detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/).

## Prerequisites

- `open3d>=0.18`, `laspy[lazrs]>=2.5`, `numpy>=1.24`, `scipy>=1.11`.
- Two epochs in the same CRS — EPSG:32618+5703 in the examples — already aligned on stable ground as described in [change detection between LiDAR scan epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
- Enough memory for both clouds as float64 arrays plus a KD-tree: about 80 bytes per point, so a 30-million-point pair of tiles needs 5 GB.

## Step-by-Step

### 1. Load both epochs into a small-coordinate frame

```python
import laspy
import numpy as np
import open3d as o3d

def load_xyz(path, drop_classes=(3, 4, 5, 7, 18)):
    las = laspy.read(path)
    keep = ~np.isin(las.classification, drop_classes)
    return np.column_stack([las.x, las.y, las.z])[keep]

ref_xyz = load_xyz("yard_2025-10.laz")          # t0, EPSG:32618+5703
cmp_xyz = load_xyz("yard_2026-03_aligned.laz")  # t1, same CRS, registered to t0

origin = np.floor(ref_xyz.min(axis=0))
ref = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(ref_xyz - origin))
cmp = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(cmp_xyz - origin))
print(f"reference {len(ref.points):,} pts, compared {len(cmp.points):,} pts, origin {origin}")
```

The choice of which cloud is the reference is not cosmetic either. The reference is the surface distances are measured *to*, so it should be the denser and cleaner of the two when there is a choice; measuring a dense cloud against a sparse one inflates every distance by the sparse cloud's spacing, which is the bias this page spends most of its effort removing. When the later survey is denser, as it usually is because sensors improve, it is legitimate to measure the earlier epoch against it and flip the sign of the result, as long as the report says which way round the comparison ran.

Vegetation (classes 3–5) and noise (7 and 18) are dropped before anything is measured, because both generate large distances that are not the change being looked for. Subtracting a common origin matters more than it looks: Open3D stores points as float64, but several of its internals — normal estimation and some KD-tree paths — lose precision on coordinates in the millions, and a shared origin keeps the two clouds exactly comparable.

### 2. Run the built-in nearest-neighbour distance

```python
d_nn = np.asarray(cmp.compute_point_cloud_distance(ref))

print(f"C2C nearest-neighbour: median {np.median(d_nn) * 100:.1f} cm, "
      f"p95 {np.percentile(d_nn, 95) * 100:.1f} cm, max {d_nn.max():.2f} m")
```

`compute_point_cloud_distance` returns, for each point of the calling cloud, the Euclidean distance to the nearest point of the argument cloud. The direction matters: `cmp` against `ref` finds material that is new or moved in the later epoch, because a point on a new structure has no near neighbour in the reference. The reverse call finds material that disappeared. A demolition shows up only in the reverse direction, so run both.

<figure class="diagram">
<svg viewBox="6 6 748 264" role="img" aria-labelledby="c2c-dir-t c2c-dir-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-dir-t">Why C2C has to be run in both directions</title>
  <desc id="c2c-dir-d">A site where a shed was demolished and a container was added. Measuring later points against the earlier cloud lights up the new container but says nothing about the shed, because the later epoch has no points where the shed was. Measuring earlier points against the later cloud lights up the demolished shed. Only the pair of runs shows both changes.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="264" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="200" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="200" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M40 180 H340" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M420 180 H720" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M70 180 V120 H150 V180" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <rect x="230" y="136" width="90" height="44" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="450" y="120" width="80" height="60" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M610 180 V136 H700 V180" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="44">t₁ measured against t₀</text>
    <text x="570" y="44">t₀ measured against t₁</text>
    <text x="110" y="108">shed gone</text>
    <text x="275" y="124">container</text>
    <text x="490" y="108">shed</text>
    <text x="655" y="124">container</text>
  </g>
  <text x="110" y="204" fill="#5b6471" font-size="12" text-anchor="middle">invisible</text>
  <text x="275" y="204" fill="#b0413e" font-size="12" text-anchor="middle">large distance</text>
  <text x="490" y="204" fill="#b0413e" font-size="12" text-anchor="middle">large distance</text>
  <text x="655" y="204" fill="#5b6471" font-size="12" text-anchor="middle">invisible</text>
  <text x="380" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">Each direction is blind to exactly the change the other one sees.</text>
</svg>
<figcaption>Nearest-neighbour distance is asymmetric: additions appear when the later cloud is measured, removals when the earlier one is.</figcaption>
</figure>

### 3. Replace nearest-point distance with a signed local-plane distance

The density bias comes from measuring to a *point*. Measuring to the local *surface* — a plane fitted through the few nearest reference points — removes most of it and adds a sign.

```python
from scipy.spatial import cKDTree

def c2c_local_plane(query, reference, k=8):
    tree = cKDTree(reference)
    _, idx = tree.query(query, k=k, workers=-1)
    nbrs = reference[idx]                                   # (n, k, 3)
    centroid = nbrs.mean(axis=1)
    centred = nbrs - centroid[:, None, :]
    cov = np.einsum("nki,nkj->nij", centred, centred) / k
    _, eigvecs = np.linalg.eigh(cov)
    normal = eigvecs[:, :, 0]                               # smallest eigenvalue → plane normal
    normal *= np.sign(normal[:, 2:3] + 1e-12)               # point normals upward for a stable sign
    return np.einsum("ni,ni->n", query - centroid, normal)

ref_small = np.asarray(ref.points)
cmp_small = np.asarray(cmp.points)
d_plane = c2c_local_plane(cmp_small, ref_small)

print(f"local-plane: median |d| {np.median(np.abs(d_plane)) * 100:.1f} cm, "
      f"p95 |d| {np.percentile(np.abs(d_plane), 95) * 100:.1f} cm")
```

`np.linalg.eigh` returns eigenvalues in ascending order, so the first eigenvector is the direction of least spread — the normal of the best-fit plane. Orienting every normal upward gives the distance a consistent meaning on horizontal surfaces: positive is growth, negative is loss. On vertical walls the upward flip is arbitrary, which is one reason to move to M3C2 once walls matter.

### 4. Map distances back to points and write a review file

```python
las_out = laspy.create(point_format=3, file_version="1.4")
las_out.header.offsets = origin
las_out.header.scales = [0.001, 0.001, 0.001]
las_out.header.add_crs(laspy.read("yard_2025-10.laz").header.parse_crs())
las_out.x, las_out.y, las_out.z = (cmp_small + origin).T
las_out.add_extra_dim(laspy.ExtraBytesParams(name="c2c_nn", type=np.float32))
las_out.add_extra_dim(laspy.ExtraBytesParams(name="c2c_plane", type=np.float32))
las_out.c2c_nn = d_nn.astype(np.float32)
las_out.c2c_plane = d_plane.astype(np.float32)
las_out.write("yard_c2c_2025-10_2026-03.laz")
```

Storing both distances as extra dimensions lets a reviewer colour the cloud by either in any LAS viewer and see the density bias directly: `c2c_nn` shows a faint speckle across every flat surface, `c2c_plane` does not.

Keep the review file even after the pipeline has moved on to M3C2. It is small relative to the source epochs, it opens in any viewer without Python, and it is the fastest way to answer the question a site manager actually asks — "what is that red patch?" — without rerunning anything. Name it after both epoch dates rather than a run identifier, so that a folder of comparisons sorts into a readable history of the site.

## Expected Output & Verification

On a yard surveyed at 12 pts/m² in October and 25 pts/m² in March, with a new container stack and some regraded gravel:

```text
reference 4,812,334 pts, compared 9,906,120 pts, origin [ 585000. 4511000.     8.]
C2C nearest-neighbour: median 8.1 cm, p95 19.4 cm, max 3.12 m
local-plane: median |d| 1.6 cm, p95 |d| 6.8 cm
```

The median is the number to watch. Across a mostly unchanged site the median distance should approach the survey noise — one to two centimetres — and the nearest-neighbour median here is five times that, which is the density bias. Verify it on a surface that certainly did not change:

```python
carpark = (cmp_small[:, 0] > 120) & (cmp_small[:, 0] < 180) & (cmp_small[:, 1] > 40) & (cmp_small[:, 1] < 90)
nn_bias = np.median(d_nn[carpark])
plane_bias = np.median(d_plane[carpark])
expected_nn = 0.5 * np.sqrt(1 / 12)                       # ≈ half the mean point spacing at 12 pts/m²
print(f"car park: NN {nn_bias * 100:.1f} cm (spacing predicts ≈ {expected_nn * 100:.1f}), "
      f"plane {plane_bias * 100:.1f} cm")
assert abs(plane_bias) < 0.02
```

<figure class="diagram">
<svg viewBox="24 16 690 250" role="img" aria-labelledby="c2c-bias-t c2c-bias-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-bias-t">Median distance on a stable surface against reference density</title>
  <desc id="c2c-bias-d">A chart of median distance on an unchanged car park as the reference cloud density falls from 40 to 4 points per square metre. Nearest-neighbour distance rises steeply as density falls, from about 4 to about 14 centimetres. Local-plane distance stays near 1.5 centimetres throughout, close to the survey noise.</desc>
  <rect class="svg-bg" x="24" y="16" width="690" height="250" fill="#ffffff"/>
  <path d="M80 30 V200 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="120,176 240,168 360,156 480,136 600,104 680,64" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="120,186 240,186 360,185 480,184 600,183 680,181" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="120" y="220">40</text><text x="240" y="220">25</text><text x="360" y="220">16</text>
    <text x="480" y="220">10</text><text x="600" y="220">6</text><text x="680" y="220">4</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="72" y="190">0 cm</text><text x="72" y="120">8 cm</text><text x="72" y="50">16 cm</text>
  </g>
  <text x="560" y="72" fill="#b0413e" font-size="12.5" text-anchor="end">nearest neighbour</text>
  <text x="440" y="172" fill="#4f7a4d" font-size="12.5" text-anchor="middle">local plane, k = 8</text>
  <text x="390" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">reference density, points per m² — nothing on this surface moved</text>
</svg>
<figcaption>Nearest-neighbour distance measures point spacing as much as displacement; fitting a plane through the neighbours removes the dependence on density.</figcaption>
</figure>

## Common Errors

**`MemoryError` or the process is killed in `tree.query`.** The `(n, k, 3)` neighbour array for ten million points at `k=8` is 1.9 GB before the covariance array is built. Process the query cloud in chunks of one to two million points against a single tree; the tree itself is small.

**Every distance is around a metre or more.** The later epoch was never aligned, or it was aligned in an offset frame and written back without the offset. Compare the median distance on stable ground before and after alignment; if they match, the aligned file is not the one being loaded.

**Distances look fine but the sign flips across a roof.** Upward orientation on a steep or overhanging surface is ambiguous, and the plane fit through eight neighbours on a ridge line straddles both slopes. Increase `k` or exclude class 6 from the signed map and use unsigned values on buildings.

## Classifying the Result

Distances alone are a continuous field; a screening step needs a decision. Without a statistically derived level of detection, use a threshold tied to the stable-surface measurement rather than a round number.

```python
stable_p95 = np.percentile(np.abs(d_plane[carpark]), 95)
threshold = max(3 * stable_p95, 0.05)
changed = np.abs(d_plane) > threshold
print(f"threshold {threshold * 100:.1f} cm → {changed.mean() * 100:.2f}% of points flagged")
```

Three times the 95th percentile on stable ground keeps false positives rare without a formal uncertainty model, and the 5 cm floor stops a very clean survey from producing a threshold below the absolute accuracy of either epoch. Treat the flagged set as a list of places to run M3C2, not as the change result.

<figure class="diagram">
<svg viewBox="46 6 688 240" role="img" aria-labelledby="c2c-thr-t c2c-thr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-thr-t">Screening threshold from the stable-surface distribution</title>
  <desc id="c2c-thr-d">A histogram of absolute local-plane distances on the whole site, with most points in the first few centimetre bins and a long tail. The 95th percentile on the stable car park sits at about two centimetres; three times that gives a screening threshold near six centimetres, and only the tail beyond it is flagged for M3C2.</desc>
  <rect class="svg-bg" x="46" y="6" width="688" height="240" fill="#ffffff"/>
  <path d="M60 20 V180 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.2">
    <rect x="80" y="40" width="50" height="140"/>
    <rect x="135" y="84" width="50" height="96"/>
    <rect x="190" y="132" width="50" height="48"/>
    <rect x="245" y="156" width="50" height="24"/>
  </g>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="1.2">
    <rect x="300" y="166" width="50" height="14"/>
    <rect x="355" y="170" width="50" height="10"/>
    <rect x="410" y="168" width="50" height="12"/>
    <rect x="465" y="172" width="50" height="8"/>
    <rect x="520" y="174" width="50" height="6"/>
  </g>
  <path d="M190 20 V180" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M298 20 V180" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="182" y="34" fill="#4f7a4d" font-size="12" text-anchor="end">stable p95</text>
  <text x="306" y="34" fill="#b0413e" font-size="12" text-anchor="start">3 × p95 → flag for M3C2</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="80" y="200">0</text><text x="190" y="200">2 cm</text><text x="298" y="200">6 cm</text><text x="570" y="200">15 cm+</text>
  </g>
  <text x="390" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">|local-plane distance| across the whole site</text>
</svg>
<figcaption>The threshold comes from a surface known not to have changed, so it adapts to each survey pair instead of being a number chosen once and forgotten.</figcaption>
</figure>

## Frequently Asked Questions

### Is Open3D's distance faster than SciPy's KD-tree?

For the plain nearest-neighbour query they are within a factor of two of each other; `cKDTree.query` with `workers=-1` is often faster on many cores. Open3D earns its place for normals, registration and visualisation, and the two libraries interoperate through NumPy arrays at no cost.

### Why k = 8 for the local plane?

It is the smallest neighbourhood that fits a stable plane at typical airborne densities while staying local enough not to bridge a kerb or a roof edge. Terrestrial scans at hundreds of points per square metre tolerate `k=16` or more and give smoother results.

### Can C2C measure volume change?

Not reliably. Summing distances over points double-counts dense areas and ignores sparse ones. Grid the change into a DSM difference or use M3C2 core points on a regular grid, then integrate per cell area.

## Related Guides

- [M3C2 Change Detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/) — the defensible measurement after screening
- [Flagging Changed Buildings for Retiling](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/flagging-changed-buildings-for-retiling/) — acting on detected change
- [PDAL vs Open3D for Point Cloud Filtering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/pdal-vs-open3d-for-point-cloud-filtering/) — choosing the right library for the preparation step

Back to [Change Detection Between LiDAR Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
