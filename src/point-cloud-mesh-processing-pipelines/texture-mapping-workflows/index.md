---
title: "Texture Mapping Workflows for Digital Twins"
description: "Texture mapping for geospatial meshes: pinhole camera projection, UV vs projective texturing, atlas baking, occlusion handling, and multi-image blending."
---
# Texture Mapping Workflows for Geospatial Digital Twins

Texture mapping is where a metrically accurate mesh stops looking like a grey blob and starts looking like a real city — but it is also where a pipeline silently goes wrong. A single sign error in a camera rotation, an unprojected vertex behind the image plane, or a missing occlusion test, and a wall gets painted with the texture of the building behind it. This guide covers the projection math, deterministic UV assignment, atlas baking, occlusion handling, and multi-image blending needed to turn oriented aerial or terrestrial imagery into a textured mesh that survives municipal QA. It sits downstream of the [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) reconstruction stages, and assumes you already have clean geometry and calibrated cameras in a single explicit coordinate reference system.

## Prerequisites

You need a reconstructed surface mesh, a set of oriented photographs, and the calibration that ties them together. Concretely:

- **Mesh**: a manifold or near-manifold surface in `.ply`, `.obj`, or `.glb`, with consistent outward normals. Run [surface reconstruction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) and topology repair first; non-manifold faces produce ambiguous UVs and texture bleed.
- **Oriented imagery**: undistorted RGB frames (aerial nadir, oblique, or terrestrial), each with a known camera pose. Lens distortion must already be removed or modelled — projection math below assumes a pinhole model.
- **Camera parameters**: per-image intrinsics `K` (focal length `fx`, `fy` in pixels; principal point `cx`, `cy`) and extrinsics — a rotation `R` (3×3, world→camera) and translation `t` (3-vector). These come from a bundle adjustment (e.g. COLMAP, Metashape) or from direct georeferencing with IMU/GNSS.
- **CRS**: mesh vertices and camera centres must live in the *same* metric, projected CRS — for example **EPSG:32633** (UTM zone 33N) for central Europe, or **EPSG:32618** (UTM zone 18N) for the US east coast. Do not texture in geographic EPSG:4326; angular units break the focal-length-in-metres assumptions and the depth comparisons. Reproject cameras with `pyproj` before you start, and record the compound vertical datum (e.g. EPSG:32633+5703) so heights stay consistent.

Package versions: `trimesh>=4.0`, `numpy>=1.24`, `Pillow>=10.0`, and `open3d>=0.17` for ray-cast occlusion. A municipal block (tens of thousands of faces, dozens of 20-megapixel images) fits comfortably in 32 GB of RAM; tiling lets you go larger.

## Concept

Every textured-mesh question reduces to one operation: given a 3D point on the mesh, **which pixel in which photo saw it?** A calibrated pinhole camera answers this in two steps. First the world point `P` (a column vector in the mesh CRS) is moved into the camera's own frame:

```
P_cam = R · P + t
```

`R` and `t` are the extrinsics; `P_cam` is now expressed relative to the camera centre, with `+Z` pointing down the optical axis. The depth is simply `Z_cam`, and a point is only visible if `Z_cam > 0` (in front of the lens). Then the intrinsic matrix `K` projects `P_cam` onto the image plane in pixels:

```
[u]            [fx  0  cx]
[v] ~ K·P_cam, [ 0 fy  cy]   then divide by Z_cam
[w]            [ 0  0   1]
```

The pixel coordinate is `(u/w, v/w)`. That single chain — `R|t` then `K`, then the perspective divide — is the whole of camera projection.

<figure class="diagram">
<svg viewBox="0 0 760 320" role="img" aria-labelledby="tex-proj-t tex-proj-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tex-proj-t">Pinhole camera projection onto a mesh</title>
  <desc id="tex-proj-d">A camera centre projects a ray through the image plane to a point on the mesh surface; the world point is transformed by R and t into the camera frame, then by the intrinsic matrix K into pixel coordinates u and v.</desc>
  <defs>
    <marker id="tex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <circle cx="90" cy="160" r="9" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="300" y="80" width="120" height="160" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M600 70 Q650 160 600 250 L660 260 Q700 160 660 60 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <circle cx="360" cy="135" r="5" fill="#1f6b8a"/>
  <circle cx="632" cy="150" r="6" fill="#4f7a4d"/>
  <line x1="99" y1="160" x2="628" y2="151" stroke="#5b6471" stroke-width="2" marker-end="url(#tex-arrow)"/>
  <line x1="150" y1="250" x2="150" y2="190" stroke="#5b6471" stroke-width="2" marker-end="url(#tex-arrow)"/>
  <line x1="150" y1="250" x2="210" y2="250" stroke="#5b6471" stroke-width="2" marker-end="url(#tex-arrow)"/>
  <text x="90" y="135" fill="#1f2937" font-size="13" text-anchor="middle">camera centre</text>
  <text x="360" y="70" fill="#1f2937" font-size="13" text-anchor="middle">image plane</text>
  <text x="360" y="160" fill="#1f2937" font-size="12" text-anchor="middle">(u, v)</text>
  <text x="655" y="290" fill="#1f2937" font-size="13" text-anchor="middle">mesh point P</text>
  <text x="150" y="180" fill="#5b6471" font-size="12" text-anchor="middle">Z</text>
  <text x="225" y="254" fill="#5b6471" font-size="12" text-anchor="start">X</text>
  <text x="380" y="305" fill="#1f2937" font-size="13" text-anchor="middle">P_cam = R·P + t,  then  K projects to pixels</text>
</svg>
<figcaption>Projecting a mesh vertex through the camera: extrinsics R and t bring it into the camera frame, intrinsics K map it to a pixel.</figcaption>
</figure>

There are two ways to *use* this. **Projective texturing** keeps no UVs at all — at render time each fragment is projected back into the source images, like a slide projector. It is exact but ties the asset to its camera set forever. **UV texturing** runs the projection once, bakes the sampled colour into a flat texture atlas, and stores per-vertex UV coordinates. The atlas is self-contained, streams cleanly through 3D Tiles, and is what every production digital twin ships. The workflow below bakes UVs.

One subtlety worth internalising before you write code: the camera centre `C` in world coordinates is *not* `t`. Because `P_cam = R·P + t`, the centre is the world point that maps to the origin of the camera frame, which solves to `C = -Rᵀ·t`. Confusing `t` for the camera position is the single most common reason a freshly-imported bundle adjustment projects everything backwards, and it is why every visibility and distance computation below derives the centre explicitly. The rotation `R` is orthonormal, so its inverse is its transpose — `Rᵀ` rotates a direction from the camera frame back into the world CRS, which is exactly what you need to turn a pixel ray into a world ray for occlusion testing.

## Step-by-Step Workflow

### 1. Load mesh and camera parameters

Load the mesh and assemble each camera as a small dataclass holding `K`, `R`, `t`, and its undistorted image. Keep everything in the same projected CRS (here EPSG:32633).

```python
import numpy as np
import trimesh
from PIL import Image

class Camera:
    def __init__(self, K, R, t, image_path):
        self.K = np.asarray(K, dtype=np.float64)      # 3x3 intrinsics
        self.R = np.asarray(R, dtype=np.float64)      # 3x3 world->cam rotation
        self.t = np.asarray(t, dtype=np.float64).reshape(3)  # translation
        self.image = np.asarray(Image.open(image_path).convert("RGB"))
        self.height, self.width = self.image.shape[:2]

mesh = trimesh.load("city_block.ply", force="mesh")
mesh.fix_normals()                 # ensure outward-facing normals
assert mesh.is_winding_consistent, "repair topology before texturing"

# Cameras already reprojected into EPSG:32633 (mesh CRS).
cameras = [
    Camera(K0, R0, t0, "img_0001.jpg"),
    Camera(K1, R1, t1, "img_0002.jpg"),
    # ...
]
```

### 2. Project vertices into a camera

The core routine: transform vertices with `R|t`, reject anything behind the lens (`Z_cam <= 0`), apply `K`, and divide. Return pixel coordinates plus a per-vertex validity mask.

```python
def project_points(cam, points):
    """World points (N,3) in EPSG:32633 -> pixel (N,2) and visibility mask."""
    P_cam = (cam.R @ points.T).T + cam.t          # P_cam = R*P + t
    z = P_cam[:, 2]
    in_front = z > 1e-6                            # reject Z_cam <= 0
    z_safe = np.where(in_front, z, 1.0)            # avoid divide-by-zero
    uvw = (cam.K @ P_cam.T).T
    pix = uvw[:, :2] / z_safe[:, None]
    inside = (
        in_front
        & (pix[:, 0] >= 0) & (pix[:, 0] < cam.width)
        & (pix[:, 1] >= 0) & (pix[:, 1] < cam.height)
    )
    return pix, inside
```

### 3. Score each camera per face and handle occlusion

A face may be seen by several cameras. Pick the best one per face — favour cameras viewing the face head-on (normal aligned with the view direction) and close by — but only after an occlusion test so a foreground wall does not get the texture of the building behind it. Open3D's ray caster gives cheap visibility.

```python
import open3d as o3d

scene = o3d.t.geometry.RaycastingScene()
scene.add_triangles(
    o3d.t.geometry.TriangleMesh.from_legacy(mesh.as_open3d)
)

face_centers = mesh.triangles_center
face_normals = mesh.face_normals
best_cam = np.full(len(mesh.faces), -1, dtype=np.int64)
best_score = np.zeros(len(mesh.faces))

for ci, cam in enumerate(cameras):
    cam_center = -cam.R.T @ cam.t                 # camera centre in world CRS
    view_dir = face_centers - cam_center
    dist = np.linalg.norm(view_dir, axis=1)
    view_unit = view_dir / dist[:, None]

    facing = -np.einsum("ij,ij->i", face_normals, view_unit)  # >0 if front-facing
    _, visible = project_points(cam, face_centers)
    candidate = visible & (facing > 0.1)

    # Occlusion: does an unobstructed ray reach the face centre?
    origins = np.repeat(cam_center[None, :], len(face_centers), axis=0)
    rays = np.hstack([origins, view_unit]).astype(np.float32)
    hit = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
    unoccluded = hit > (dist - 0.05)              # 5 cm tolerance
    candidate &= unoccluded

    score = facing / (dist + 1.0)                 # head-on + near = best
    take = candidate & (score > best_score)
    best_cam[take] = ci
    best_score[take] = score[take]
```

### 4. Bake into a texture atlas

Allocate an atlas, give each triangle a small fixed cell, and for every face sample its chosen camera at the three corners to set the corner colours (a flat-shaded bake; subdivide the cell for full per-texel sampling). Write per-vertex UVs that index the atlas.

```python
ATLAS = 4096
cols = int(np.ceil(np.sqrt(len(mesh.faces))))
cell = ATLAS // cols
atlas = np.zeros((ATLAS, ATLAS, 3), dtype=np.uint8)
uv = np.zeros((len(mesh.faces), 3, 2), dtype=np.float32)

for fi, face in enumerate(mesh.faces):
    ci = best_cam[fi]
    r, c = divmod(fi, cols)
    x0, y0 = c * cell, r * cell
    if ci < 0:                                    # no camera saw this face
        atlas[y0:y0 + cell, x0:x0 + cell] = (40, 40, 40)
        corners = np.array([[0, 0], [1, 0], [0, 1]], np.float32)
    else:
        verts = mesh.vertices[face]
        pix, _ = project_points(cameras[ci], verts)
        px = np.clip(pix[:, 0].astype(int), 0, cameras[ci].width - 1)
        py = np.clip(pix[:, 1].astype(int), 0, cameras[ci].height - 1)
        colors = cameras[ci].image[py, px]
        atlas[y0:y0 + cell, x0:x0 + cell] = colors.mean(axis=0).astype(np.uint8)
        corners = np.array([[0.1, 0.1], [0.9, 0.1], [0.1, 0.9]], np.float32)
    uv[fi] = (np.array([x0, y0]) + corners * cell) / ATLAS

# Flip V for image-origin-top-left convention used by glTF.
flat_uv = uv.reshape(-1, 2)
flat_uv[:, 1] = 1.0 - flat_uv[:, 1]
```

### 5. Multi-image blending and color balancing

Hard per-face camera selection leaves visible tonal patches where two cameras meet. Before baking, normalise exposure across the set: compute each image's mean in linear RGB, pick a global target, and apply a per-image gain. For faces near a camera boundary, blend the two highest-scoring cameras weighted by their scores rather than taking the single best.

```python
def linear(img):                                  # sRGB -> linear
    x = img.astype(np.float64) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)

means = np.array([linear(c.image).reshape(-1, 3).mean(0) for c in cameras])
target = means.mean(axis=0)                        # global grey target
for cam, m in zip(cameras, means):
    gain = target / np.clip(m, 1e-4, None)
    bal = np.clip(linear(cam.image) * gain, 0, 1)
    cam.image = (np.where(bal <= 0.0031308, bal * 12.92,
                          1.055 * bal ** (1 / 2.4) - 0.055) * 255).astype(np.uint8)
```

### 6. Attach UVs and export

Write the atlas, wrap it in a `trimesh` material, and export a self-contained `.glb`.

```python
Image.fromarray(atlas).save("city_block_atlas.png")
mesh_uv = mesh.unwrap() if False else mesh        # keep our baked UVs
mat = trimesh.visual.material.PBRMaterial(
    baseColorTexture=Image.fromarray(atlas)
)
mesh.visual = trimesh.visual.TextureVisuals(uv=flat_uv, material=mat)
mesh.export("city_block_textured.glb")
```

## Validation & Verification

Texture quality is measurable, not a matter of taste. Run two checks before shipping.

**Reprojection error.** Pick surveyed control points visible in multiple images, project each into every camera that should see it, and compare against the manually marked pixel. The RMS reprojection residual should sit below 1.5 px for a well-calibrated set; larger means the extrinsics or intrinsics are off and every texture will be smeared.

```python
def reprojection_rmse(cam, world_pts, marked_px):
    pix, inside = project_points(cam, world_pts)
    err = np.linalg.norm(pix[inside] - marked_px[inside], axis=1)
    return float(np.sqrt(np.mean(err ** 2)))

rmse = reprojection_rmse(cameras[0], gcp_world, gcp_pixels)
assert rmse < 1.5, f"reprojection RMSE {rmse:.2f}px too high — recheck K, R, t"
```

**Coverage.** Count faces that no camera saw. A few percent of untextured faces (filled grey above) is normal for occluded courtyards; more than ~5% means a gap in capture geometry, not a software bug.

```python
covered = (best_cam >= 0).mean()
assert covered > 0.95, f"only {covered:.1%} of faces textured — capture gaps"
print(f"coverage {covered:.1%}, atlas size {ATLAS}px")
```

A useful third check is the per-face Jacobian of the UV mapping: the ratio of a triangle's area in UV space to its area on the mesh should be roughly constant across an island. Values far from uniform reveal stretched charts that will look sharp in one direction and blurry in the other under magnification — a classic symptom of planar-projecting a steep facade along the wrong axis.

Bake validation into CI so a bad commit never reaches the tileset. A practical gate fails the build when reprojection RMSE exceeds 1.5 px, coverage drops below 95%, or any UV island stretches by more than 15%. Tie those thresholds to your survey class: a twin certified to ±5 cm horizontal cannot tolerate a 3 px reprojection error if each pixel covers 4 cm on the ground, because that error alone already exceeds the spec. Record the camera CRS, the atlas resolution, and the coverage fraction in the asset's metadata so a reviewer can audit the bake without re-running it.

## Performance & Scale

The projection itself is cheap — `project_points` is pure NumPy and vectorises over all vertices at once. The two costs that matter are the occlusion ray casts and the image memory. A 20-megapixel RGB image is ~60 MB decoded; thirty of them is 1.8 GB before you have touched the mesh. Decode images lazily and release each camera's array after its faces are baked, or memory-map them.

Occlusion ray casting is `O(faces × cameras)`; for a city it dominates. Two levers: cull cameras per face by a bounding-box test before casting (most cameras cannot see most faces), and tile the mesh into ~500 m × 500 m blocks in the projected CRS so each tile only loads the cameras whose frustum intersects it. Process tiles in parallel with `concurrent.futures.ProcessPoolExecutor`. Cache the per-face `best_cam` assignment so a re-bake after a color-balance tweak skips the ray casting entirely. As a rule of thumb, a 50k-face block against 30 images bakes in well under a minute on a single core once cameras are culled; without culling the ray casts alone can take ten times that.

## Failure Modes & Gotchas

- **Z_cam ≤ 0 wraparound.** If you skip the `in_front` mask, points behind the camera still produce finite pixel coordinates after the divide (the sign flips twice) and land *inside* the image. They get textured with garbage. Always reject `Z_cam <= 0` before clamping pixels, as `project_points` does.
- **Occlusion bleed.** Without the ray-cast test, a wall facing the camera but hidden behind a nearer building samples the nearer building's facade. The symptom is a "ghost" of one structure printed on another. Keep the 5 cm ray tolerance generous enough to survive mesh noise but tight enough to reject real occluders.
- **Atlas seams.** Adjacent faces baked from different cameras meet at a visible tonal step. Color-balance globally first (step 5), then blend the top-two cameras near boundaries. Padding each atlas cell by a couple of texels and dilating the colour into the padding stops mip-mapping from sampling black gutters at oblique angles.
- **CRS / unit mismatch.** Cameras georeferenced in EPSG:4326 (degrees) against a mesh in EPSG:32633 (metres) produce focal lengths and depths in incompatible units — every point projects to nonsense. Reproject cameras to the mesh CRS first; assert the camera centres fall inside the mesh bounding box as a sanity gate.
- **Axis-order and V-flip.** glTF expects the texture origin at top-left and V increasing downward, while many image libraries treat the origin as bottom-left. Forget the `1.0 - v` flip and your textures appear vertically mirrored. Test on a single asymmetric facade before batching a city.

## Frequently Asked Questions

### Should I use projective texturing or bake to a UV atlas?

Bake to a UV atlas for any asset you intend to ship, stream, or hand to another team. Projective texturing is exact and avoids resampling loss, but it requires the original images at render time and ties the model to that exact camera set forever. A baked atlas is a single self-contained texture that streams through 3D Tiles and renders anywhere. Keep projective texturing only for inspection tools where you are comparing the mesh against ground-truth imagery.

### Why are some of my faces textured with the wrong building?

That is occlusion bleed: a face was assigned a camera that geometrically projects onto it but is actually blocked by closer geometry. The fix is the ray-cast visibility test in step 3 — cast a ray from the camera centre to the face centre and reject the face if the ray hits something nearer. If it still happens, your mesh has gaps the ray passes through, or your tolerance is too loose.

### How do I get rid of the patchwork of different exposures?

Color-balance before baking. Convert every image to linear RGB, compute a global mean, and apply a per-image gain so all images share the same average brightness, then convert back to sRGB (step 5). For the remaining hard edges, blend the two best cameras per face weighted by their view scores instead of picking a single winner. Histogram matching against a reference image is a stronger alternative when exposures vary wildly.

### What CRS should the mesh and cameras be in?

A single shared, metric, projected CRS — a UTM zone such as EPSG:32633 or EPSG:32618, ideally with an explicit vertical datum (EPSG:32633+5703). Never texture in geographic EPSG:4326: the projection math assumes linear metric units, and depth comparisons (`Z_cam`) are meaningless in degrees. Reproject camera centres and orientations into the mesh CRS with `pyproj` before projecting anything.

### How dense should the mesh be relative to the imagery?

Match triangle size to the ground sampling distance (GSD) of the source photos. If each pixel covers 3 cm on the ground, triangles much smaller than a few centimetres waste atlas space without adding detail, while triangles spanning many pixels lose resolution and look faceted. Run [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) to a target edge length near the GSD before texturing.

## Related Guides

- [Aligning Photogrammetry Textures with Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/aligning-photogrammetry-textures-with-point-clouds/) — registering imagery to 3D point data before projection
- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — generating the mesh you texture
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — matching triangle density to image GSD
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — cleaning input data so textures don't smear
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — keeping mesh and cameras in one CRS

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
