---
title: "Georeferencing Photogrammetric Point Clouds"
description: "Place an arbitrary-scale reconstruction in a real CRS: a 3D similarity fit with SVD, robust rejection, residual diagnosis"
---
# Georeferencing Photogrammetric Point Clouds

This page places a photogrammetric reconstruction that has no scale or datum into a real coordinate reference system — solving the seven-parameter similarity transformation from control points with an SVD, rejecting bad points robustly, reading the residuals for what they say about the reconstruction, converting ellipsoidal heights to DHHN2016, and writing a LAZ in EPSG:25832+7837 that downstream tools can trust.

## Why you hit this

A reconstruction from imagery alone is correct in shape and arbitrary in everything else: its scale, orientation and origin come from whichever image pair the solver started with. Software that consumes GNSS-tagged imagery hides this by solving in an approximate world frame, but the moment a project uses a hand-held sequence, an indoor capture, a legacy dataset or a reconstruction whose EXIF positions were wrong, the cloud has to be placed explicitly. Doing it with a similarity transformation — seven parameters, not a full affine — is what keeps the geometry rigid instead of stretching it to fit the control. The pipeline context is in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`, `laspy[lazrs]>=2.5`, `pyproj>=3.6` on PROJ 9.3+, `open3d>=0.18`.
- A reconstruction in model units — the fused cloud from [sparse and dense reconstruction with COLMAP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/sparse-and-dense-reconstruction-with-colmap/), or any PLY.
- At least four control points identifiable in the model, surveyed in the target CRS; six or more if you want to detect a bad one.
- The geoid grid for the target vertical datum available to PROJ.

## Step-by-Step

### 1. Read the correspondences

```python
import numpy as np
import open3d as o3d

pcd = o3d.io.read_point_cloud("/data/colmap/pier_north/dense/fused.ply")
model_pts = np.asarray(pcd.points)
print(f"{len(model_pts):,} points, model extent {(model_pts.max(0) - model_pts.min(0)).round(3)}")

# Correspondences: the same physical points picked in the model and surveyed in the field
model = np.array([
    [ 1.2043,  0.8821, -0.1043],
    [ 4.8812,  0.9104, -0.0981],
    [ 4.7712,  3.1204, -0.1002],
    [ 1.1902,  3.0884, -0.0955],
    [ 3.0021,  1.9942,  0.5512],
    [ 2.4410,  3.6620, -0.0902],
])
world = np.array([                      # EPSG:25832 + ellipsoidal height for now
    [691204.412, 5335818.221, 566.912],
    [691286.901, 5335836.978, 566.930],
    [691275.305, 5335887.874, 566.922],
    [691192.799, 5335869.108, 566.905],
    [691236.447, 5335853.232, 581.402],
    [691222.118, 5335891.664, 566.918],
])
assert len(model) == len(world) >= 4, "at least four correspondences are needed for a 3D similarity"
```

Four points are the minimum for a seven-parameter fit with one degree of freedom left over; six give enough redundancy to identify an outlier. They must not be coplanar — four points on a flat yard determine scale and rotation about the vertical well and rotation about the horizontal axes badly, so include something with height.

### 2. Solve the similarity transformation

```python
def umeyama(src, dst, with_scale=True):
    """Least-squares similarity transform mapping src → dst (Umeyama / Horn)."""
    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    s, d = src - src_mean, dst - dst_mean
    cov = d.T @ s / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:       # forbid a reflection
        S[2, 2] = -1.0
    R = U @ S @ Vt
    scale = (D * np.diag(S)).sum() / (s ** 2).sum() * len(src) if with_scale else 1.0
    t = dst_mean - scale * R @ src_mean
    return scale, R, t

scale, R, t = umeyama(model, world)
print(f"scale {scale:.6f}  (model units per metre: {1 / scale:.6f})")
print("rotation (deg, ZYX):", np.degrees(
    np.array([np.arctan2(R[1, 0], R[0, 0]),
              np.arcsin(-R[2, 0]),
              np.arctan2(R[2, 1], R[2, 2])])).round(4))
print("translation:", t.round(3))
```

The reflection guard is the detail that separates a working implementation from one that occasionally mirrors the model. The SVD of the cross-covariance gives the best rotation, but if the determinant works out negative the "best" solution is a mirror image — geometrically optimal, physically impossible — so the third singular direction is flipped. A mirrored georeferencing looks almost right and has every facade on the wrong side.

Scale is solved jointly rather than fixed to 1, because a photogrammetric model has no metric meaning. When the reconstruction *was* solved with RTK positions, fit with `with_scale=False` and check that the residuals stay small: a forced unit scale that fits well confirms the RTK solution, and one that fits badly means the RTK scale was wrong.

<figure class="diagram">
<svg viewBox="6 16 748 242" role="img" aria-labelledby="pgeo-seven-t pgeo-seven-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pgeo-seven-t">The seven parameters, and what each one absorbs</title>
  <desc id="pgeo-seven-d">A breakdown of the similarity transformation: three translations place the origin, three rotations orient the model, and one scale sizes it. A full affine transformation would add three shears and two extra scales, which would let the fit absorb genuine reconstruction deformation and hide it.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="242" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="20" y="30" width="220" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="30" width="220" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="520" y="30" width="220" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="130" y="150" width="500" height="70" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="60">3 translations</text>
    <text x="130" y="82">place the origin</text>
    <text x="380" y="60">3 rotations</text>
    <text x="380" y="82">orient the model</text>
    <text x="630" y="60">1 scale</text>
    <text x="630" y="82">size the model</text>
    <text x="380" y="178">a full affine adds shears and axis-wise scales —</text>
    <text x="380" y="200">it would absorb real deformation and hide it</text>
  </g>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Seven parameters can move a rigid model; they cannot straighten a bent one.</text>
</svg>
<figcaption>Keeping the fit to seven parameters is what makes the residuals informative: anything they cannot absorb is a property of the reconstruction.</figcaption>
</figure>

### 3. Reject bad correspondences robustly

```python
def robust_umeyama(src, dst, max_iter=10, k=2.5):
    keep = np.ones(len(src), dtype=bool)
    for _ in range(max_iter):
        scale, R, t = umeyama(src[keep], dst[keep])
        resid = np.linalg.norm((scale * (R @ src.T).T + t) - dst, axis=1)
        sigma = 1.4826 * np.median(np.abs(resid[keep] - np.median(resid[keep]))) + 1e-9
        new_keep = resid < np.median(resid[keep]) + k * sigma
        if new_keep.sum() < 4 or np.array_equal(new_keep, keep):
            break
        keep = new_keep
    return umeyama(src[keep], dst[keep]), keep, resid

(scale, R, t), keep, resid = robust_umeyama(model, world)
for i, (r, k) in enumerate(zip(resid, keep)):
    print(f"point {i}: residual {r * 1000:7.1f} mm {'' if k else '  ← rejected'}")
print(f"{keep.sum()} of {len(keep)} points used, scale {scale:.6f}")
```

The rejection uses a median-absolute-deviation estimate of spread rather than a standard deviation, because one badly mismarked point inflates a standard deviation enough to keep itself inside the threshold. Two or three iterations are usually enough; a set where the loop keeps rejecting points has a systematic problem — the wrong CRS, a mislabelled pair — that no robust estimator should paper over.

### 4. Read the residuals before applying anything

```python
fitted = scale * (R @ model.T).T + t
d = fitted - world
print("residual components (mm):")
for i, row in enumerate(d * 1000):
    print(f"  point {i}: dE {row[0]:7.1f}  dN {row[1]:7.1f}  dH {row[2]:7.1f}")
rms = np.sqrt((np.linalg.norm(d[keep], axis=1) ** 2).mean())
print(f"3D RMS over used points: {rms * 1000:.1f} mm")

radial = np.linalg.norm(model[keep] - model[keep].mean(axis=0), axis=1)
corr = np.corrcoef(radial, np.linalg.norm(d[keep], axis=1))[0, 1]
print(f"correlation of residual with distance from the centre: {corr:+.2f}")
```

The correlation in the last line is the diagnostic that matters for photogrammetry. Residuals that grow with distance from the centre of the control set mean the reconstruction is deformed — doming or a scale gradient — and a similarity transformation cannot fix that. The right response is to reprocess with better control or obliques, not to accept a fit whose residuals are 5 cm in the middle and 20 cm at the edges.

<figure class="diagram">
<svg viewBox="6 16 748 228" role="img" aria-labelledby="pgeo-resid-t pgeo-resid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pgeo-resid-t">Reading residuals after the fit</title>
  <desc id="pgeo-resid-d">Three patterns. Small random residuals mean a good fit and a rigid model. Residuals growing outward from the centre mean the reconstruction is domed or scaled non-uniformly, which seven parameters cannot absorb. One large residual against small ones means a single mismarked or mis-surveyed point.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="228" fill="#ffffff"/>
  <defs>
    <marker id="pgeo-resid-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="220" height="150" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="270" y="30" width="220" height="150" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="520" y="30" width="220" height="150" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#b0413e" stroke-width="1.8" fill="none" marker-end="url(#pgeo-resid-arrow)">
    <path d="M70 70 l8 6"/><path d="M180 70 l-6 8"/><path d="M70 150 l7 -7"/><path d="M180 150 l6 6"/><path d="M125 110 l-7 5"/>
    <path d="M320 70 l-16 -12"/><path d="M430 70 l16 -12"/><path d="M320 150 l-16 12"/><path d="M430 150 l16 12"/><path d="M375 110 l3 2"/>
    <path d="M570 70 l6 5"/><path d="M680 70 l-5 6"/><path d="M570 150 l5 -6"/><path d="M680 150 l30 26"/><path d="M625 110 l-5 4"/>
  </g>
  <g fill="#5b6471">
    <circle cx="125" cy="110" r="3"/><circle cx="375" cy="110" r="3"/><circle cx="625" cy="110" r="3"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="204">random, small</text>
    <text x="380" y="204">growing outward</text>
    <text x="630" y="204">one point apart</text>
    <text x="130" y="226">good fit</text>
    <text x="380" y="226">deformed model</text>
    <text x="630" y="226">bad correspondence</text>
  </g>
</svg>
<figcaption>A similarity fit's residuals are a diagnosis of the reconstruction, which is lost as soon as extra parameters are allowed to absorb them.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="26 46 688 208" role="img" aria-labelledby="pgeo-affine-t pgeo-affine-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pgeo-affine-t">A similarity transformation against a full affine</title>
  <desc id="pgeo-affine-d">A square grid on the left. Under a similarity transformation it is rotated and scaled uniformly, so angles are preserved and the shape is still a square. Under a full affine transformation it is sheared into a parallelogram, which would let the fit absorb a deformed reconstruction and report small residuals.</desc>
  <rect class="svg-bg" x="26" y="46" width="688" height="208" fill="#ffffff"/>
  <g stroke="#1f6b8a" stroke-width="1.5" fill="none">
    <path d="M40 60 h120 v120 h-120 Z"/>
    <path d="M80 60 V180 M120 60 V180 M40 100 H160 M40 140 H160"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="1.5" fill="none">
    <path d="M300 80 l104 26 l-26 104 l-104 -26 Z"/>
    <path d="M326 86 l-26 104 M352 93 l-26 104 M294 106 l104 26 M287 132 l104 26"/>
  </g>
  <g stroke="#b0413e" stroke-width="1.5" fill="none">
    <path d="M540 60 h120 l40 120 h-120 Z"/>
    <path d="M580 60 l13 120 M620 60 l13 120 M553 100 H673 M567 140 H687"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="212">model grid</text>
    <text x="350" y="212">similarity: rotate + scale</text>
    <text x="620" y="212">affine: shear as well</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Only the middle transformation preserves angles, which is why it cannot hide doming.</text>
</svg>
<figcaption>A similarity fit can move a rigid model. An affine fit can also distort it into agreement, which destroys the diagnostic value of the residuals.</figcaption>
</figure>

### 5. Convert the vertical component, then apply to everything

```python
from pyproj import Transformer

# The control heights above were ellipsoidal; the twin wants DHHN2016
to_orthometric = Transformer.from_crs("EPSG:25832+4979", "EPSG:25832+7837", always_xy=True)

def apply_transform(points, scale, R, t, to_vertical=None):
    out = scale * (R @ points.T).T + t
    if to_vertical is not None:
        x, y, z = to_vertical.transform(out[:, 0], out[:, 1], out[:, 2])
        out = np.column_stack([x, y, z])
    return out

world_pts = apply_transform(model_pts, scale, R, t, to_orthometric)
print("georeferenced extent:", world_pts.min(axis=0).round(2), world_pts.max(axis=0).round(2))

colors = (np.asarray(pcd.colors) * 65535).astype(np.uint16) if pcd.has_colors() else None
```

Doing the vertical conversion after the similarity fit, and not before, keeps the fit in one consistent height system — mixing ellipsoidal control with orthometric control inside one adjustment produces a tilt equal to the geoid gradient across the site, which is a centimetre or two over a kilometre and enough to matter.

### 6. Write a LAZ with the CRS attached

```python
import laspy
from pyproj import CRS

header = laspy.LasHeader(point_format=7, version="1.4")
header.offsets = np.floor(world_pts.min(axis=0))
header.scales = [0.001, 0.001, 0.001]
header.add_crs(CRS.from_user_input("EPSG:25832+7837"))

las = laspy.LasData(header)
las.x, las.y, las.z = world_pts[:, 0], world_pts[:, 1], world_pts[:, 2]
if colors is not None:
    las.red, las.green, las.blue = colors[:, 0], colors[:, 1], colors[:, 2]
las.write("pier_north_georef.laz")

with laspy.open("pier_north_georef.laz") as f:
    print(f"written: {f.header.point_count:,} points, CRS {f.header.parse_crs().to_epsg()}")
```

Writing the CRS into the file, rather than into a README, is what makes the cloud usable by PDAL, QGIS and every other consumer without a per-project instruction. Point format 7 carries RGB, which preserves the one thing photogrammetry has that LiDAR does not.

## Expected Output & Verification

```text
41,204,882 points, model extent [ 5.214  4.882  1.104]
scale 16.402118  (model units per metre: 0.060968)
rotation (deg, ZYX): [ -12.8842   0.1021  -0.0884]
translation: [691192.104 5335812.884 566.981]
point 0: residual    11.4 mm
point 1: residual     9.8 mm
point 2: residual    14.2 mm
point 3: residual    12.6 mm
point 4: residual    19.4 mm
point 5: residual   184.2 mm   ← rejected
5 of 6 points used, scale 16.402118
3D RMS over used points: 13.8 mm
correlation of residual with distance from the centre: +0.12
georeferenced extent: [691191.98 5335811.44 519.02] [691287.12 5335892.01 533.88]
written: 41,204,882 points, CRS 25832
```

Three things in that output are the verification. The residual RMS of 14 mm is consistent with the survey accuracy and the GSD, so the fit is as good as the inputs allow. The near-zero correlation says the model is rigid rather than domed. And the rejected point, at 184 mm, is a correspondence to re-check rather than a reason to loosen the threshold.

Then verify independently, on a measurement the fit never saw:

```python
tape = {(0, 1): 84.612, (1, 2): 52.204}      # distances measured on site, metres
for (i, j), measured in tape.items():
    fitted_d = np.linalg.norm(apply_transform(model[[i, j]], scale, R, t)[0]
                              - apply_transform(model[[i, j]], scale, R, t)[1])
    print(f"points {i}-{j}: fitted {fitted_d:.3f} m vs measured {measured:.3f} m "
          f"({(fitted_d - measured) * 1000:+.0f} mm)")
```

A tape or total-station distance is the cleanest independent scale check there is, and scale is the parameter that a reconstruction from imagery gets wrong most often.

## Performance Notes

- **The fit is instantaneous; applying it is a matrix multiply** over tens of millions of points and takes seconds. Neither is a bottleneck.
- **Transform in float64 and write scaled integers.** LAZ stores integers with a scale, so a millimetre scale keeps the precision without the file size of doubles.
- **Convert heights in one vectorised PROJ call**, not per point; the difference on 40 million points is minutes against hours.
- **Apply the same transformation to the mesh, the cameras and any derived rasters** in the same run, from the same stored parameters, so all products share a frame. Store the seven parameters in a JSON sidecar next to the outputs.

## Common Errors

**Every facade is on the wrong side of the building.** The rotation included a reflection because the determinant guard was missing. Check `np.linalg.det(R)` is `+1`.

**The scale comes out around 3.28 or 0.3048.** The control coordinates are in feet and the model was fitted against metres, or vice versa. Check the survey's units before the fit.

**Heights are 47 m out.** Ellipsoidal and orthometric heights were mixed, either between control points or between the fit and the output CRS. Convert once, after the fit.

**Residuals are excellent and the cloud sits 2 m from the building in the twin.** The control points were surveyed in a different realisation of the datum than the twin uses. Both are internally consistent; the transformation between realisations is described in [transforming between epoch-based datums](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/transforming-between-epoch-based-datums/).

## Frequently Asked Questions

### Can I align to a LiDAR cloud instead of to control points?

Yes, and it is often more practical: fit a coarse similarity from a few picked correspondences, then refine with ICP against the LiDAR as described in [fusing LiDAR and photogrammetry point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/fusing-lidar-and-photogrammetry-point-clouds/). The LiDAR then defines the frame, so its own accuracy becomes the project's.

### Should scale ever be fixed?

Fix it when the reconstruction already has metric scale from RTK or from a calibrated rig, and use the fit only to place it. Then a poor fit is informative rather than absorbed.

### How many control points for a large site?

Enough that the residual correlation with distance is measurable — six to ten, spread to the edges and with height variation. On sites over a few hundred metres, a similarity fit is not the right tool at all: control belongs inside the bundle adjustment, as in [preparing ground control point files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/).

## Related Guides

- [Sparse and Dense Reconstruction with COLMAP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/sparse-and-dense-reconstruction-with-colmap/) — producing the model this places
- [Preparing Ground Control Point Files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/) — the better route when the software supports it
- [Registering Multi-Epoch Scans with ICP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/registering-multi-epoch-scans-with-icp/) — refinement after a coarse fit

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
