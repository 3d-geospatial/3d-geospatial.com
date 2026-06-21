---
title: "Align Photogrammetry Textures with Point Clouds"
description: "Align photogrammetry textures using camera pose R|t: project points with P_cam = R*P + t, reject behind-camera and occluded samples, then bake colour."
---
# Aligning Photogrammetry Textures with Point Clouds: A Technical Guide

Aligning photogrammetry textures means colouring a point cloud or mesh by projecting each 3D point into the oriented images using the camera pose `R|t` — `P_cam = R @ P + t` — sampling the pixel under the projection, and keeping only samples that pass a behind-camera and occlusion test. Camera poses (rotation `R`, translation `t`) and intrinsics `K` come straight out of a structure-from-motion solve in Metashape, RealityCapture, or OpenDroneMap; the point cloud usually comes from LiDAR or dense matching. When both live in the same metric CRS, this projection bakes per-point RGB at sub-centimetre accuracy.

You hit this whenever the photogrammetry block and the geometry were captured or solved separately. The images carry colour but a noisy, partial surface; the LiDAR carries clean geometry but no colour. The join is purely projective: there is no UV unwrap to author, only a pinhole camera to evaluate per point. The two traps are the camera frame's axis convention (a flipped `Z` projects everything behind the lens) and occlusion (a façade point sampling the colour of the wall in front of it). Both are handled below with an explicit depth buffer.

This page assumes a single projected CRS throughout — worked examples use **EPSG:32618** (UTM zone 18N) for points and camera centres, with orthometric height on **EPSG:5703** (NAVD88) when a vertical datum is in play, i.e. compound **EPSG:32618+5703**. Reproject to **EPSG:4326** only at the web-delivery boundary, never during projection — degree-valued coordinates make `P_cam = R @ P + t` meaningless.

## Prerequisites

- Python 3.10+ with `numpy>=1.24`, `open3d>=0.18`, `trimesh>=4.0`, `Pillow>=10.0`.
- A point cloud (`.laz`, `.ply`, or `.e57`) already in **EPSG:32618**. If it is in **EPSG:4326**, reproject with `pyproj` first — projection math requires metres.
- Camera intrinsics `K` (a 3×3 matrix holding focal lengths `f_x`, `f_y` in pixels and principal point `c_x`, `c_y`).
- Camera extrinsics per image: rotation `R` (3×3, world→camera) and translation `t` (3-vector), or equivalently the camera centre `C` with `t = -R @ C`. Confirm which convention your exporter uses — Metashape exports world→camera, OpenDroneMap's `cameras.json` does too, but some tools store camera→world and must be inverted.
- The oriented images, ideally undistorted (lens distortion removed). Residual radial distortion shows up as edge misalignment of a few pixels.

A 3×3 intrinsic matrix for a 4000×3000 image with a 35 mm-equivalent lens looks like `K = [[3200, 0, 2000], [0, 3200, 1500], [0, 0, 1]]` — `f_x ≈ f_y` in pixels, principal point near the image centre.

<figure class="diagram">
<svg viewBox="0 0 720 240" role="img" aria-labelledby="apt-proj-t apt-proj-d" xmlns="http://www.w3.org/2000/svg">
  <title id="apt-proj-t">Pinhole projection of a surface point</title>
  <desc id="apt-proj-d">A world point is transformed by the camera pose into the camera frame, projected through the intrinsic matrix onto the image plane to give a pixel, and the sampled colour is carried back to the point only if it passes the depth test.</desc>
  <defs>
    <marker id="apt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="80" width="150" height="80" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="285" y="80" width="150" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="550" y="80" width="150" height="80" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#apt-arrow)">
    <line x1="170" y1="120" x2="283" y2="120"/>
    <line x1="435" y1="120" x2="548" y2="120"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="95" y="115"><tspan x="95" dy="0">World point P</tspan><tspan x="95" dy="16">EPSG:32618</tspan></text>
    <text x="360" y="115"><tspan x="360" dy="0">Camera frame</tspan><tspan x="360" dy="16">P_cam = R·P + t</tspan></text>
    <text x="625" y="115"><tspan x="625" dy="0">Pixel (u,v)</tspan><tspan x="625" dy="16">via K, depth-tested</tspan></text>
  </g>
  <text x="227" y="60" fill="#5b6471" font-size="12" text-anchor="middle">apply pose R | t</text>
  <text x="492" y="60" fill="#5b6471" font-size="12" text-anchor="middle">project, Z_cam &gt; 0</text>
</svg>
<figcaption>The projection chain: world point to camera frame to image pixel, with colour returning only on a passing depth test.</figcaption>
</figure>

## Step-by-Step

### 1. Load camera poses and confirm the convention

Read the intrinsics and extrinsics. The single most common defect is an inverted or transposed `R`, so validate immediately: the camera centre `C = -R.T @ t` should land near the survey position you expect in **EPSG:32618**, not kilometres away or below ground.

```python
import json
import numpy as np

with open("cameras.json") as f:
    raw = json.load(f)

cameras = []
for cam in raw["cameras"]:
    K = np.array(cam["K"], dtype=np.float64)          # 3x3 intrinsics
    R = np.array(cam["R"], dtype=np.float64)           # 3x3 world->camera
    t = np.array(cam["t"], dtype=np.float64)           # 3-vector
    centre = -R.T @ t                                  # camera centre in EPSG:32618
    assert 500_000 < centre[0] < 800_000, f"easting {centre[0]:.0f} off UTM 18N grid"
    cameras.append({"K": K, "R": R, "t": t, "image": cam["image"]})

print(f"loaded {len(cameras)} cameras, first centre = {(-cameras[0]['R'].T @ cameras[0]['t']).round(2)}")
```

### 2. Transform points into the camera frame

Apply `P_cam = R @ P + t` to every point at once. With points stored row-wise as an `(N, 3)` array, the vectorised form is `(R @ points.T + t[:, None]).T`. The third column of the result is `Z_cam`, the depth along the optical axis.

```python
import open3d as o3d

pcd = o3d.io.read_point_cloud("scan_utm18n.ply")     # already in EPSG:32618
points = np.asarray(pcd.points)                       # (N, 3), metres
n = len(points)

def to_camera_frame(points, R, t):
    return (R @ points.T + t.reshape(3, 1)).T          # (N, 3): X_cam, Y_cam, Z_cam
```

### 3. Reject points behind the camera, then project with K

Drop every point with `Z_cam <= 0` — these sit behind the lens and would otherwise project to a mirrored, garbage pixel. Project the survivors through `K`: `u = f_x * X_cam / Z_cam + c_x` and `v = f_y * Y_cam / Z_cam + c_y`. Then reject pixels outside the image rectangle.

```python
def project(P_cam, K, width, height):
    front = P_cam[:, 2] > 1e-6                          # reject Z_cam <= 0 (behind camera)
    idx = np.where(front)[0]
    Xc, Yc, Zc = P_cam[idx, 0], P_cam[idx, 1], P_cam[idx, 2]
    u = (K[0, 0] * Xc / Zc + K[0, 2])
    v = (K[1, 1] * Yc / Zc + K[1, 2])
    in_frame = (u >= 0) & (u < width) & (v >= 0) & (v < height)
    idx = idx[in_frame]
    return idx, u[in_frame].astype(np.int32), v[in_frame].astype(np.int32), Zc[in_frame]
```

### 4. Resolve occlusion with a per-point depth buffer

Two points can land on the same pixel — one on the visible façade, one on the wall behind it. Keep a depth buffer per point and only accept a sample when its `Z_cam` is the smallest seen so far for that point, so the nearer surface wins and colour does not bleed through occluders.

```python
colors = np.zeros((n, 3), dtype=np.float64)
depth = np.full(n, np.inf, dtype=np.float64)
hits = np.zeros(n, dtype=np.int32)

from PIL import Image

for cam in cameras:
    img = np.asarray(Image.open(cam["image"]).convert("RGB"), dtype=np.float64) / 255.0
    h, w = img.shape[:2]
    P_cam = to_camera_frame(points, cam["R"], cam["t"])
    idx, u, v, z = project(P_cam, cam["K"], w, h)

    closer = z < depth[idx]                             # occlusion: nearer surface wins
    idx, u, v, z = idx[closer], u[closer], v[closer], z[closer]
    colors[idx] = img[v, u]
    depth[idx] = z
    hits[idx] += 1
```

### 5. Bake the result and write a coloured asset

The loop above keeps the single nearest colour per point. To soften residual seams from pose drift, blend the nearest few views instead by accumulating colour weighted by `1/Z_cam` and dividing by the weight sum. Either way, attach the colours and write the cloud back in **EPSG:32618**.

```python
covered = hits > 0
print(f"coverage: {covered.sum()}/{n} = {100 * covered.mean():.1f}%")

pcd.colors = o3d.utility.Vector3dVector(np.clip(colors, 0.0, 1.0))
o3d.io.write_point_cloud("scan_textured_utm18n.ply", pcd)
```

For a mesh, the same projection applies to `trimesh` vertices — load with `trimesh.load("model.ply")`, feed `mesh.vertices` through steps 2–4, and write vertex colours to `mesh.visual.vertex_colors` (scaled to 0–255 `uint8`).

## Expected Output & Verification

Two numbers tell you whether the bake worked: **coverage** (fraction of points that received colour) and **reprojection error** (how well known control points land on their imaged pixels).

Coverage prints directly from step 5. For a building captured from the ground with good overlap, expect 85–98% of front-facing points coloured; sky-facing and occluded points stay uncoloured (`hits == 0`) and that is correct. A sudden drop to single digits almost always means a flipped axis sent everything behind the camera — see Common Errors.

Reprojection error checks the pose against ground control. Take a surveyed point you can also click in an image, project it, and measure the pixel gap:

```python
gcp_world = np.array([583251.420, 4507890.115, 18.640])  # EPSG:32618 + 5703 (NAVD88)
gcp_pixel = np.array([2014.0, 1502.0])                    # clicked in the image

cam = cameras[0]
P_cam = (cam["R"] @ gcp_world + cam["t"])
assert P_cam[2] > 0, "GCP projected behind camera — pose convention wrong"
u = cam["K"][0, 0] * P_cam[0] / P_cam[2] + cam["K"][0, 2]
v = cam["K"][1, 1] * P_cam[1] / P_cam[2] + cam["K"][1, 2]
err = np.hypot(u - gcp_pixel[0], v - gcp_pixel[1])
print(f"reprojection error = {err:.2f} px")
assert err < 2.0, "pose error exceeds 2 px — refine extrinsics before baking"
```

Under 1 px is excellent, under 2 px is acceptable for infrastructure work. At 4000-px width and a typical 10 m standoff, 2 px is roughly 1 cm on the surface. Errors of tens of pixels indicate the camera centre is wrong or distortion was never removed.

## Common Errors

**`assert P_cam[2] > 0` fails / coverage collapses to near zero.** The camera frame's `Z` axis points the wrong way — your exporter uses an OpenGL-style frame (camera looks down `-Z`) while the projection assumes a computer-vision frame (camera looks down `+Z`). Flip with a diagonal sign matrix: `R = np.diag([1, -1, -1]) @ R` and recompute `t` consistently, or negate `Z_cam` before the `> 0` test. Validate by confirming a point you know is in front of the camera now has positive depth.

**`IndexError: index 3001 is out of bounds for axis 0 with size 3000` when sampling `img[v, u]`.** A point projected just outside the frame slipped through because the bounds test used `<=` instead of `<`, or `u`/`v` were swapped when indexing — remember NumPy images are row-major, so the row index is `v` and the column is `u`: write `img[v, u]`, never `img[u, v]`. Clamp defensively only after the strict `in_frame` mask, never instead of it.

**Colour bleeds through walls (a façade tinted by the building behind it).** The occlusion test was skipped or applied per image instead of across all images. Keep one global `depth` buffer across the whole camera loop and only overwrite when `z < depth[idx]`. If bleed persists at grazing angles where LiDAR is sparse, raise point density or add a small depth bias so coincident surfaces resolve deterministically.

## Frequently Asked Questions

### Do the point cloud and cameras have to be in the same CRS?

Yes — both must be in one projected, metric CRS such as **EPSG:32618** before any projection. `P_cam = R @ P + t` is a rigid Euclidean operation that only makes sense in metres; feeding it **EPSG:4326** degrees produces nonsense depths. Reproject the cloud with `pyproj` first if needed, and reproject to **EPSG:4326** only when exporting for web delivery.

### My cameras come from Metashape — what do I export?

Export the calibrated cameras (intrinsics `K` plus per-image world→camera `R` and `t`) and the dense or sparse cloud in the same projected CRS. Confirm Metashape wrote a right-handed, computer-vision camera frame; if a quick reprojection test puts known points behind the camera, apply the axis flip from Common Errors before baking.

### How do I fix visible seams when poses drift?

Drift between the LiDAR geometry and the photogrammetry block creates seams no projection can hide. Register the photogrammetry sparse cloud to the LiDAR with point-to-plane ICP in `open3d`, apply the resulting transform to every camera pose, then re-bake. Where survey control exists, a GCP-constrained bundle adjustment in the photogrammetry software is the more rigorous fix. Aim for a check-point mean absolute error under 0.03 m.

## Related Guides

- [Texture Mapping Workflows for Digital Twins](/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — the broader texturing workflow this page sits in
- [Point Cloud Filtering Techniques](/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — clean the cloud before you colour it
- [Surface Reconstruction for Geospatial Twins](/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — turn the coloured cloud into a mesh
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — get points and cameras into one EPSG

Back to [Texture Mapping Workflows for Digital Twins](/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
