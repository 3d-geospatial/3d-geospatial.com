---
title: "Fusing LiDAR and Photogrammetry Point Clouds"
description: "Combine LiDAR and photogrammetric clouds without double surfaces: align on stable planes, measure the bias"
---
# Fusing LiDAR and Photogrammetry Point Clouds

This page combines a LiDAR survey and a photogrammetric reconstruction of the same site into one cloud that is better than either — aligning them on surfaces both measured reliably, quantifying the systematic bias between them, deciding which source is authoritative for which surface type, transferring colour to the LiDAR points, and tagging every point with its provenance, all in EPSG:25832+7837.

## Why you hit this

The two sources fail in opposite places. LiDAR penetrates vegetation, gives trustworthy bare earth and has good absolute accuracy, and carries no colour and little facade detail from the air. Photogrammetry gives dense colour and facade geometry and cannot see the ground under a tree. A twin that has both and uses them separately ends up with two versions of every roof, differing by a few centimetres, and a mesh pipeline that reconstructs a doubled surface. Fusing them properly is mostly bookkeeping — which source owns which surface, and what the offset between them is — and the payoff is one cloud with no duplicated geometry. The pipeline context is in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).

## Prerequisites

- Python 3.10+ with `laspy[lazrs]>=2.5`, `numpy>=1.24`, `scipy>=1.11`, `open3d>=0.18`, `pdal>=3.4`.
- Both clouds in the same compound CRS — reproject first, and check the vertical datum on both, since photogrammetric output is frequently ellipsoidal.
- Classification on the LiDAR (ground, building, vegetation) and colour on the photogrammetric cloud.
- Overlapping coverage of at least a few hard, planar surfaces: roads, car parks, flat roofs.

## Step-by-Step

### 1. Load both and confirm the frames match

```python
import laspy
import numpy as np

def load(path):
    las = laspy.read(path)
    crs = las.header.parse_crs()
    xyz = np.column_stack([las.x, las.y, las.z])
    rgb = (np.column_stack([las.red, las.green, las.blue]) / 65535.0
           if hasattr(las, "red") else None)
    cls = np.asarray(las.classification)
    return {"xyz": xyz, "rgb": rgb, "cls": cls, "crs": crs.to_epsg() if crs else None,
            "n": len(xyz), "path": path}

lidar = load("survey_2026_lidar.laz")
photo = load("flight_2026_photo_georef.laz")
for c in (lidar, photo):
    print(f"{c['path']}: {c['n']:,} points, EPSG {c['crs']}, "
          f"z {c['xyz'][:, 2].min():.1f}–{c['xyz'][:, 2].max():.1f} m, colour: {c['rgb'] is not None}")
assert lidar["crs"] == photo["crs"], "reproject to a common CRS before fusing"
```

The z ranges are the quick test for a vertical datum mismatch: two clouds of the same site whose ranges differ by a constant 40–50 m are in different height systems, and no amount of alignment will fix that — it has to be transformed properly.

### 2. Align on surfaces both sources measured well

```python
import open3d as o3d

OFFSET = np.floor(lidar["xyz"].min(axis=0))

def stable_subset(cloud, classes=(2, 6), z_band=None):
    m = np.isin(cloud["cls"], classes) if cloud["cls"] is not None else np.ones(cloud["n"], bool)
    xyz = cloud["xyz"][m]
    if z_band is not None:
        xyz = xyz[(xyz[:, 2] > z_band[0]) & (xyz[:, 2] < z_band[1])]
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz - OFFSET))
    return pc.voxel_down_sample(0.25)

ref = stable_subset(lidar)                       # ground and buildings from LiDAR
src = stable_subset(photo, classes=(1, 2, 6))    # photogrammetric classes are often unset
for p in (ref, src):
    p.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=1.0, max_nn=30))

reg = o3d.pipelines.registration.registration_icp(
    src, ref, max_correspondence_distance=0.6, init=np.eye(4),
    estimation_method=o3d.pipelines.registration.TransformationEstimationPointToPlane(),
    criteria=o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=80))
print(f"fitness {reg.fitness:.3f}, inlier RMSE {reg.inlier_rmse * 100:.1f} cm")
print("translation (cm):", (reg.transformation[:3, 3] * 100).round(1))

photo["xyz"] = (reg.transformation @ np.column_stack(
    [photo["xyz"] - OFFSET, np.ones(photo["n"])]).T).T[:, :3] + OFFSET
```

Aligning on ground and roofs excludes exactly the surfaces where the two sources legitimately disagree — vegetation, where one sees canopy and the other sees through it, and water, where photogrammetry sees nothing stable. Point-to-plane ICP on those surfaces converges quickly because both clouds are locally planar there.

Treat the resulting translation as information, not just as a correction. A vertical shift of a few centimetres is normal survey-to-survey disagreement. A vertical shift of 10–30 cm with a small horizontal component usually means the photogrammetric heights carry a scale or calibration bias, and the fix belongs in the reconstruction, not here.

### 3. Measure the residual bias per surface type

```python
from scipy.spatial import cKDTree

tree = cKDTree(lidar["xyz"][np.isin(lidar["cls"], (2,))])          # LiDAR ground
def signed_dz(points, k=8):
    d, idx = tree.query(points[:, :2], k=k)
    z_ref = lidar["xyz"][np.isin(lidar["cls"], (2,))][idx][:, :, 2].mean(axis=1)
    return points[:, 2] - z_ref

sample = photo["xyz"][np.random.default_rng(3).choice(photo["n"], 200_000, replace=False)]
dz = signed_dz(sample)
print(f"photogrammetry minus LiDAR ground: median {np.median(dz) * 100:+.1f} cm, "
      f"p5 {np.percentile(dz, 5) * 100:+.1f}, p95 {np.percentile(dz, 95) * 100:+.1f}")
```

Comparing each photogrammetric point with the mean height of its nearest LiDAR ground neighbours gives a signed bias distribution rather than a single number. On open ground the median should be within a couple of centimetres of zero after alignment. The p95 tail is mostly vegetation and cars — points where the two sources measured different things, which is the next step's problem.

<figure class="diagram">
<svg viewBox="86 24 618 222" role="img" aria-labelledby="fuse-bias-t fuse-bias-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fuse-bias-t">Height difference between sources by surface type</title>
  <desc id="fuse-bias-d">Distributions of photogrammetric minus LiDAR height for three surface types. On asphalt the difference is a narrow distribution centred near zero. On flat roofs it is similar but slightly wider. Over vegetation the photogrammetric surface sits systematically one to six metres higher, because it measures the canopy while LiDAR measures the ground beneath it.</desc>
  <rect class="svg-bg" x="86" y="24" width="618" height="222" fill="#ffffff"/>
  <path d="M60 180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M170 30 V180" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="M120 180 C155 180 158 60 170 60 C182 60 185 180 220 180" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M100 180 C150 180 152 96 170 96 C188 96 190 180 240 180" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M330 180 C420 180 430 70 520 70 C610 70 620 180 690 180" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="204">0</text>
    <text x="520" y="204">+3 m</text>
    <text x="380" y="228">photogrammetric height minus LiDAR ground height</text>
  </g>
  <text x="250" y="52" fill="#4f7a4d" font-size="12.5" text-anchor="start">asphalt: ±3 cm</text>
  <text x="252" y="110" fill="#1f6b8a" font-size="12.5" text-anchor="start">flat roofs: ±6 cm</text>
  <text x="520" y="52" fill="#9a4f26" font-size="12.5" text-anchor="middle">vegetation: canopy, not ground</text>
</svg>
<figcaption>The vegetation offset is not an error to correct; it is the two sources measuring different surfaces, and it decides which one owns those areas.</figcaption>
</figure>

### 4. Split authority by surface type

```python
AUTHORITY = {
    "ground_open": "lidar",       # both see it; LiDAR has better absolute accuracy
    "ground_vegetated": "lidar",  # only LiDAR sees it at all
    "roofs": "photo",             # denser, and carries colour
    "facades": "photo",           # airborne LiDAR barely sees them
    "vegetation": "lidar",        # structure through the canopy
    "water": "lidar",             # photogrammetry has no stable features
}

veg_tree = cKDTree(lidar["xyz"][np.isin(lidar["cls"], (3, 4, 5))][:, :2]) if (
    np.isin(lidar["cls"], (3, 4, 5)).any()) else None

def photo_keep_mask(photo_xyz, lidar_ground_z, veg_radius=2.0):
    keep = np.ones(len(photo_xyz), bool)
    above_ground = photo_xyz[:, 2] - lidar_ground_z
    keep &= above_ground > 1.5                              # below that, LiDAR owns the ground
    if veg_tree is not None:
        near_veg = veg_tree.query_ball_point(photo_xyz[:, :2], veg_radius)
        keep &= np.array([len(n) == 0 for n in near_veg])   # LiDAR owns vegetated areas
    return keep

ground_z = np.empty(photo["n"])
step = 1_000_000
for i in range(0, photo["n"], step):
    ground_z[i:i + step] = photo["xyz"][i:i + step, 2] - signed_dz(photo["xyz"][i:i + step])
keep = photo_keep_mask(photo["xyz"], ground_z)
print(f"keeping {keep.sum():,} of {photo['n']:,} photogrammetric points "
      f"({100 * keep.mean():.1f}%)")
```

The authority table is the substance of the fusion, and writing it down explicitly is what makes the result reviewable. The height threshold keeps photogrammetric points that are on structures and drops the ones that duplicate LiDAR ground; the vegetation test drops the canopy surface that would otherwise sit above LiDAR points that describe the same trees properly.

<figure class="diagram">
<svg viewBox="6 16 616 208" role="img" aria-labelledby="fuse-prov-t fuse-prov-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fuse-prov-t">Provenance kept as an extra dimension</title>
  <desc id="fuse-prov-d">The fused file's point record carries the usual fields plus a one-byte source dimension where zero means LiDAR and one means photogrammetry. That lets a later query select only LiDAR heights for a measurement, replace only the photogrammetric points after a reprocessing run, and report what share of a product came from which sensor.</desc>
  <rect class="svg-bg" x="6" y="16" width="616" height="208" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="30" width="90" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="110" y="30" width="90" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="30" width="110" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="310" y="30" width="140" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="450" y="30" width="130" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="53">x, y, z</text>
    <text x="155" y="53">rgb</text>
    <text x="255" y="53">classification</text>
    <text x="380" y="53">intensity, returns</text>
    <text x="515" y="53">source: 0 | 1</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="104">source == 0 → heights for measurement, ground under canopy</text>
    <text x="40" y="132">source == 1 → colour, roofs, facade detail</text>
    <text x="40" y="160">replace source == 1 after a reflight without touching the LiDAR</text>
  </g>
  <text x="380" y="206" fill="#15384a" font-size="12.5" text-anchor="middle">One byte per point, and every later question about provenance is answerable.</text>
</svg>
<figcaption>The extra dimension costs a byte per point and is what keeps a fused product auditable years later.</figcaption>
</figure>

### 5. Transfer colour to the LiDAR points

```python
photo_kd = cKDTree(photo["xyz"])
d, idx = photo_kd.query(lidar["xyz"], k=4, distance_upper_bound=0.5, workers=-1)
valid = np.isfinite(d).all(axis=1)
lidar_rgb = np.zeros((lidar["n"], 3))
w = 1.0 / np.maximum(d[valid], 1e-3)
lidar_rgb[valid] = (photo["rgb"][idx[valid]] * w[:, :, None]).sum(axis=1) / w.sum(axis=1)[:, None]
print(f"{valid.mean() * 100:.1f}% of LiDAR points coloured from photogrammetry")
```

Inverse-distance weighting over four neighbours gives a smoother result than nearest-neighbour colour and avoids the speckle that a single nearest point produces where the two clouds have different densities. Points with no photogrammetric neighbour within half a metre — under canopy, inside courtyards the flight never saw — stay uncoloured, which is honest and better than stretching a colour from two metres away.

### 6. Merge with provenance and write

```python
from pyproj import CRS

merged_xyz = np.vstack([lidar["xyz"], photo["xyz"][keep]])
merged_rgb = np.vstack([lidar_rgb, photo["rgb"][keep]])
merged_cls = np.concatenate([lidar["cls"], np.full(keep.sum(), 6, dtype=np.uint8)])
source = np.concatenate([np.zeros(lidar["n"], np.uint8), np.ones(keep.sum(), np.uint8)])

header = laspy.LasHeader(point_format=7, version="1.4")
header.offsets = np.floor(merged_xyz.min(axis=0))
header.scales = [0.001, 0.001, 0.001]
header.add_crs(CRS.from_user_input("EPSG:25832+7837"))
header.add_extra_dim(laspy.ExtraBytesParams(name="source", type=np.uint8,
                                            description="0=lidar 1=photogrammetry"))
out = laspy.LasData(header)
out.x, out.y, out.z = merged_xyz.T
out.red, out.green, out.blue = (merged_rgb * 65535).astype(np.uint16).T
out.classification = merged_cls
out.source = source
out.write("site_fused.laz")
print(f"written {len(merged_xyz):,} points; {100 * source.mean():.1f}% from photogrammetry")
```

The `source` dimension is what makes the fused cloud defensible a year later. Every measurement taken from it can be traced to the sensor that produced it, a disputed height can be checked against the source with the better vertical accuracy, and a reprocessed photogrammetric flight can replace its own points without touching the LiDAR.

<figure class="diagram">
<svg viewBox="43 59 653 199" role="img" aria-labelledby="fuse-auth-t fuse-auth-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fuse-auth-t">Which source owns which surface</title>
  <desc id="fuse-auth-d">A street section. LiDAR points own the open ground, the ground under trees, the tree structure and the water. Photogrammetric points own the roofs and the facades above one and a half metres from the ground. In the overlap on open ground, photogrammetric points are dropped so no doubled surface remains.</desc>
  <rect class="svg-bg" x="43" y="59" width="653" height="199" fill="#ffffff"/>
  <path d="M30 200 H730" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <rect x="120" y="110" width="120" height="90" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="420" y="80" width="140" height="120" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M300 200 C300 150 340 140 350 150 C360 140 400 150 400 200 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M600 196 H730" fill="none" stroke="#1f6b8a" stroke-width="5"/>
  <g fill="#9a4f26">
    <circle cx="140" cy="106" r="3"/><circle cx="170" cy="106" r="3"/><circle cx="200" cy="106" r="3"/><circle cx="230" cy="106" r="3"/>
    <circle cx="440" cy="76" r="3"/><circle cx="480" cy="76" r="3"/><circle cx="520" cy="76" r="3"/><circle cx="556" cy="76" r="3"/>
    <circle cx="116" cy="140" r="3"/><circle cx="116" cy="170" r="3"/><circle cx="564" cy="120" r="3"/><circle cx="564" cy="160" r="3"/>
  </g>
  <g fill="#1f2937">
    <circle cx="60" cy="198" r="3"/><circle cx="90" cy="198" r="3"/><circle cx="270" cy="198" r="3"/><circle cx="330" cy="198" r="3"/>
    <circle cx="370" cy="198" r="3"/><circle cx="410" cy="198" r="3"/><circle cx="580" cy="198" r="3"/>
    <circle cx="340" cy="168" r="3"/><circle cx="360" cy="180" r="3"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="180" y="240">roofs and facades: photogrammetry</text>
    <text x="560" y="240">ground, canopy, water: LiDAR</text>
  </g>
  <text x="350" y="130" fill="#4f7a4d" font-size="12" text-anchor="middle">LiDAR sees under the crown</text>
  <text x="665" y="184" fill="#1f6b8a" font-size="12" text-anchor="middle">water</text>
</svg>
<figcaption>Each surface has exactly one owner, which is what prevents the doubled geometry that breaks meshing.</figcaption>
</figure>

## Expected Output & Verification

```text
survey_2026_lidar.laz: 42,118,004 points, EPSG 25832, z 498.1–556.8 m, colour: False
flight_2026_photo_georef.laz: 78,412,006 points, EPSG 25832, z 498.4–557.2 m, colour: True
fitness 0.914, inlier RMSE 4.8 cm
translation (cm): [ 1.4 -2.2  3.9]
photogrammetry minus LiDAR ground: median +1.2 cm, p5 -4.8, p95 +182.4
keeping 26,884,551 of 78,412,006 photogrammetric points (34.3%)
92.4% of LiDAR points coloured from photogrammetry
written 69,002,555 points; 39.0% from photogrammetry
```

Verify that the fusion removed the double surface rather than hiding it. Compute the local thickness of the merged cloud on flat roofs:

```python
roof = merged_xyz[(merged_cls == 6) & (merged_xyz[:, 2] > np.percentile(merged_xyz[:, 2], 80))]
cell = 0.5
keys = np.floor(roof[:, :2] / cell).astype(np.int64)
order = np.lexsort((keys[:, 1], keys[:, 0]))
roof, keys = roof[order], keys[order]
bounds = np.flatnonzero(np.any(np.diff(keys, axis=0) != 0, axis=1)) + 1
thick = [np.ptp(r[:, 2]) for r in np.split(roof, bounds) if len(r) > 6]
print(f"roof cell thickness: median {np.median(thick) * 100:.1f} cm, p95 {np.percentile(thick, 95) * 100:.1f} cm")
assert np.median(thick) < 0.15, "double surface remains: authority split is not removing duplicates"
```

A median thickness of a few centimetres on flat roofs is single-surface noise. A median near the alignment offset — or a bimodal distribution — means both sources still contribute to the same roof, which is the failure this whole procedure exists to prevent.

## Performance Notes

- **KD-tree queries dominate.** Build trees on the smaller cloud and query with `workers=-1`; a 40-million-point tree takes a minute and a few gigabytes.
- **Chunk the queries**, as the ground-height loop does, so peak memory stays bounded — a `(80e6, 8)` index array is 5 GB on its own.
- **Voxel-downsample before ICP.** Alignment on 0.25 m samples of the stable classes converges to the same transformation as the full clouds and takes seconds.
- **Tile large sites.** Fusion is local, so process 500 m tiles with a 50 m overlap and keep each tile's interior; the alignment transformation should be computed once for the whole site, not per tile.
- **Keep both sources.** The fused cloud is a derived product; regenerating it after a reprocessing run is cheap only if the inputs are still there.

## Common Errors

**The fused cloud has two roofs everywhere.** The authority split was not applied, or the height threshold was too low so photogrammetric ground points survived. Check the roof-thickness metric above.

**ICP converges to a translation of several metres.** The stable subsets do not overlap — often because one cloud is in a different CRS or the classes selected were empty. Print the extents of both subsets before registering.

**Colour transfer leaves grey patches across whole streets.** The photogrammetric cloud has no points there: water, glass, or a gap in the flight. Leave them uncoloured and record it; interpolating colour across a gap invents appearance.

**Vegetation looks worse after fusion.** Photogrammetric canopy points were kept alongside LiDAR vegetation, producing a shell over a structure. Widen the vegetation exclusion radius.

## Frequently Asked Questions

### Should fusion happen before or after classification?

Classify the LiDAR first — the authority rules depend on it — and classify the fused cloud afterwards if downstream tools need consistent classes, using the `source` dimension to keep the two sets distinguishable.

### Can I fuse clouds from different years?

Only if nothing changed, which is rarely true. Between epochs, the right operation is change detection rather than fusion; running both is how a twin gets an updated surface *and* a record of what moved, as in [change detection between LiDAR scan epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).

### Is it better to fuse the clouds or mesh them separately and combine meshes?

Fuse the clouds. Meshes combine badly — two surfaces of the same roof produce self-intersections that no repair fixes cleanly — while clouds combine by selection, which is exactly what the authority split does.

## Related Guides

- [Georeferencing Photogrammetric Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/georeferencing-photogrammetric-point-clouds/) — getting both sources into one frame
- [Registering Multi-Epoch Scans with ICP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/registering-multi-epoch-scans-with-icp/) — the alignment step in depth
- [Colorizing LiDAR from Orthophotos with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/colorizing-lidar-from-orthophotos-with-pdal/) — the raster alternative to colour transfer

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
