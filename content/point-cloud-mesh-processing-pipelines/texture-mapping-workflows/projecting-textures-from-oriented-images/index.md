# Projecting Textures from Oriented Images

This page bakes a texture onto a mesh from a set of oriented photographs — reading the camera poses and intrinsics, testing each texel for visibility against the mesh itself, scoring the candidate views by angle and resolution, blending the winners with a seam-aware weighting, and auditing which parts of the surface ended up with no photograph at all.

## Why you hit this

Photogrammetry software produces a textured mesh, and then the mesh gets simplified, retopologised or replaced by a CityGML model — and the texture does not come with it. Re-projecting from the original images is how a clean mesh gets a photographic texture, and it is also how a building model gets facade imagery from a separate oblique survey.

The hard part is not the projection, which is a matrix multiply. It is deciding, for each texel, which of forty overlapping photographs to use: the ones where the surface is visible, seen at a good angle, at high resolution, and not obscured by a tree. Get that wrong and the texture has trees printed on walls, blurred patches and hard colour steps.

## Prerequisites

- Python 3.10+ with `numpy`, `trimesh`, `Pillow`, `scipy`; a ray-tracing backend (`pyembree` or `trimesh`'s built-in).
- A mesh with a UV atlas — see [generating UV atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/).
- Oriented images: external orientation (position and rotation) and internal orientation (focal length, principal point, distortion) in the mesh's coordinate frame.

## Step-by-Step

### 1. Read the camera model exactly

```python
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

@dataclass
class Camera:
    name: str
    position: np.ndarray        # (3,) in the mesh's frame
    rotation: np.ndarray        # (3, 3) world -> camera
    focal_px: float
    principal_px: np.ndarray    # (2,) cx, cy
    width: int
    height: int
    distortion: np.ndarray      # (5,) k1 k2 p1 p2 k3, Brown-Conrady
    image_path: Path

    @property
    def forward(self):
        return self.rotation[2, :]

    def project(self, points_world, apply_distortion=True):
        """World points to pixel coordinates; returns pixels and a validity mask."""
        rel = np.asarray(points_world) - self.position
        cam = rel @ self.rotation.T
        in_front = cam[:, 2] > 1e-6
        z = np.where(in_front, cam[:, 2], 1.0)
        x = cam[:, 0] / z
        y = cam[:, 1] / z
        if apply_distortion:
            x, y = self._distort(x, y)
        px = self.focal_px * x + self.principal_px[0]
        py = self.focal_px * y + self.principal_px[1]
        inside = (px >= 0) & (px < self.width) & (py >= 0) & (py < self.height)
        return np.column_stack([px, py]), in_front & inside, cam[:, 2]

    def _distort(self, x, y):
        k1, k2, p1, p2, k3 = self.distortion
        r2 = x * x + y * y
        radial = 1.0 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
        xd = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
        yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
        return xd, yd

def load_cameras(json_path, image_dir):
    """Expects a list of {name, position, rotation (row-major 3x3), f, cx, cy, w, h, dist}."""
    raw = json.loads(Path(json_path).read_text())
    cams = []
    for c in raw["cameras"]:
        cams.append(Camera(
            name=c["name"],
            position=np.asarray(c["position"], dtype=np.float64),
            rotation=np.asarray(c["rotation"], dtype=np.float64).reshape(3, 3),
            focal_px=float(c["f"]),
            principal_px=np.asarray([c["cx"], c["cy"]], dtype=np.float64),
            width=int(c["w"]), height=int(c["h"]),
            distortion=np.asarray(c.get("dist", [0, 0, 0, 0, 0]), dtype=np.float64),
            image_path=Path(image_dir) / c["name"],
        ))
    return cams, {"cameras": len(cams),
                  "missing_images": [c.name for c in cams if not c.image_path.exists()][:5]}
```

Applying the lens distortion is not optional and is the most commonly skipped step. A wide-angle drone camera with a k1 of −0.02 displaces a point at the image edge by 30–60 pixels, which at 1 cm per pixel is half a metre of texture misplacement — visible as a facade whose windows do not line up with the geometry.

Getting the rotation convention right is the other half. A world-to-camera rotation and a camera-to-world rotation are transposes of each other, and using the wrong one produces a projection that works near the image centre and fails increasingly towards the edges — which looks like a distortion problem and is not.

Verifying the convention on one known point before processing 40,000 texels is ten seconds of work, and step 6 does it.

<figure class="diagram">
<svg viewBox="4 6 732 242" role="img" aria-labelledby="proj-dist-t proj-dist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="proj-dist-t">Effect of skipping the lens distortion</title>
  <desc id="proj-dist-d">A table of texture misplacement at four positions across a wide-angle drone image with a k1 coefficient of minus 0.02. At the image centre the error is zero. At a quarter of the way to the corner it is 4 pixels or 4 centimetres on the ground. At half way it is 17 pixels or 17 centimetres. At the corner it is 58 pixels or 58 centimetres, which places window frames most of a metre from where the geometry puts them.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="242" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="206" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="224" y="20" width="160" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="384" y="20" width="160" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="544" y="20" width="178" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="206" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="224" y="52" width="160" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="384" y="52" width="160" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="544" y="52" width="178" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="84" width="206" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="224" y="84" width="160" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="384" y="84" width="160" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="544" y="84" width="178" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="116" width="206" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="224" y="116" width="160" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="384" y="116" width="160" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="544" y="116" width="178" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="148" width="206" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="224" y="148" width="160" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="384" y="148" width="160" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="544" y="148" width="178" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="121" y="41">position in the image</text><text x="304" y="41">radial distance</text>
    <text x="464" y="41">error in pixels</text><text x="633" y="41">error on the ground</text>
    <text x="121" y="73">centre</text><text x="304" y="73">0.00</text>
    <text x="464" y="73">0</text><text x="633" y="73">0 cm</text>
    <text x="121" y="105">quarter to the corner</text><text x="304" y="105">0.25</text>
    <text x="464" y="105">4</text><text x="633" y="105">4 cm</text>
    <text x="121" y="137">half way</text><text x="304" y="137">0.50</text>
    <text x="464" y="137">17</text><text x="633" y="137">17 cm</text>
    <text x="121" y="169">corner</text><text x="304" y="169">1.00</text>
    <text x="464" y="169">58</text><text x="633" y="169">58 cm</text>
  </g>
  <text x="370" y="208" fill="#1f2937" font-size="12.5" text-anchor="middle">k1 = −0.02, 1 cm per pixel on the ground — the corner error is most of a metre</text>
  <text x="370" y="230" fill="#5b6471" font-size="12" text-anchor="middle">the centre is correct, which is why a skipped distortion looks like a calibration problem</text>
</svg>
<figcaption>Skipping the distortion is correct at the image centre and half a metre wrong at the corners, which is why it is hard to spot.</figcaption>
</figure>

### 2. Enumerate the texels and their 3D positions

```python
def texel_positions(mesh, atlas_dim, supersample=1):
    """For each atlas texel covered by a triangle, its 3D position and normal."""
    uv = np.asarray(mesh.visual.uv)
    faces = np.asarray(mesh.faces)
    verts = np.asarray(mesh.vertices)
    normals = np.asarray(mesh.face_normals)

    positions = np.full((atlas_dim, atlas_dim, 3), np.nan, dtype=np.float64)
    face_id = np.full((atlas_dim, atlas_dim), -1, dtype=np.int64)

    step = 1.0 / supersample
    for fi in range(len(faces)):
        tri_uv = uv[faces[fi]] * atlas_dim
        tri_xyz = verts[faces[fi]]
        lo = np.floor(tri_uv.min(axis=0)).astype(int) - 1
        hi = np.ceil(tri_uv.max(axis=0)).astype(int) + 1
        lo = np.maximum(lo, 0)
        hi = np.minimum(hi, atlas_dim)
        if hi[0] <= lo[0] or hi[1] <= lo[1]:
            continue

        yy, xx = np.mgrid[lo[1]:hi[1], lo[0]:hi[0]]
        px = xx + 0.5
        py = yy + 0.5
        a, b, c = tri_uv
        denom = ((b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]))
        if abs(denom) < 1e-12:
            continue
        w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / denom
        w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / denom
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        pts = (w0[inside, None] * tri_xyz[0]
               + w1[inside, None] * tri_xyz[1]
               + w2[inside, None] * tri_xyz[2])
        positions[yy[inside], xx[inside]] = pts
        face_id[yy[inside], xx[inside]] = fi

    covered = face_id >= 0
    return {
        "positions": positions,
        "face_id": face_id,
        "normals": np.where(covered[..., None],
                            normals[np.clip(face_id, 0, None)], np.nan),
        "covered": covered,
        "covered_texels": int(covered.sum()),
        "coverage_fraction": round(float(covered.mean()), 4),
    }
```

Rasterising the atlas rather than iterating over image pixels is the right direction for this problem: every texel needs exactly one colour, and driving from the texels means each one is decided once. The alternative — projecting each image onto the mesh and accumulating — leaves texels seen by no image undecided and texels seen by many accumulated in arrival order.

The barycentric interpolation gives each texel its exact 3D position, which is what the visibility and angle tests need. Recording the face identifier alongside lets the per-texel work be grouped by face, which matters for the blending in step 5.

Expanding each triangle's bounding box by one texel and testing with a small negative tolerance fills the texels that a strict test would leave as gaps along triangle edges — the same one-texel seam problem as everywhere else in texturing.

### 3. Test visibility against the mesh

```python
def visibility(mesh, positions, covered, camera, epsilon_m=0.02,
               batch=200_000):
    """A texel is visible if the ray to the camera hits nothing before the camera."""
    idx = np.flatnonzero(covered.ravel())
    pts = positions.reshape(-1, 3)[idx]
    direction = camera.position - pts
    distance = np.linalg.norm(direction, axis=1)
    unit = direction / np.maximum(distance[:, None], 1e-9)
    origins = pts + unit * epsilon_m

    visible = np.zeros(len(idx), dtype=bool)
    for start in range(0, len(idx), batch):
        sl = slice(start, start + batch)
        hits = mesh.ray.intersects_first(origins[sl], unit[sl])
        # No hit at all, or the hit is beyond the camera.
        no_hit = hits < 0
        if no_hit.all():
            visible[sl] = True
            continue
        locations, index_ray, _ = mesh.ray.intersects_location(
            origins[sl], unit[sl], multiple_hits=False)
        hit_distance = np.full(sl.stop - sl.start if sl.stop else len(idx) - start,
                               np.inf)
        if len(index_ray):
            d = np.linalg.norm(locations - origins[sl][index_ray], axis=1)
            hit_distance[index_ray] = d
        visible[sl] = hit_distance >= distance[sl] - epsilon_m

    out = np.zeros(covered.shape, dtype=bool).ravel()
    out[idx] = visible
    return out.reshape(covered.shape), {
        "camera": camera.name,
        "candidate_texels": int(len(idx)),
        "visible_texels": int(visible.sum()),
        "occluded_texels": int((~visible).sum()),
        "visible_fraction": round(float(visible.mean()), 4),
    }
```

Ray-casting against the mesh itself catches self-occlusion: a texel on the back of a chimney is projected into the image by the camera model, lands on a plausible pixel, and that pixel shows the front of the chimney. Without the visibility test that pixel's colour is painted onto the back — which is how a texture ends up with a window on a blank wall.

The epsilon offset along the ray is required. Starting the ray exactly on the surface hits the surface itself at distance zero, so every texel reads as occluded; 2 cm is enough to clear the originating triangle and small enough not to skip a nearby occluder.

What this test does **not** catch is occlusion by objects absent from the mesh — a tree in front of a building that was removed during modelling. That needs either the tree in an occlusion-only mesh or the outlier rejection in step 5.

### 4. Score the candidate views per texel

```python
def view_scores(positions, normals, covered, visible, camera):
    """Higher is better: facing the camera, close, and away from the image edge."""
    shape = covered.shape
    idx = np.flatnonzero(covered.ravel() & visible.ravel())
    pts = positions.reshape(-1, 3)[idx]
    nrm = normals.reshape(-1, 3)[idx]

    to_camera = camera.position - pts
    distance = np.linalg.norm(to_camera, axis=1)
    unit = to_camera / np.maximum(distance[:, None], 1e-9)
    cos_incidence = np.einsum("ij,ij->i", nrm, unit)

    pixels, inside, depth = camera.project(pts)
    centre = np.asarray([camera.width / 2.0, camera.height / 2.0])
    radial = np.linalg.norm(pixels - centre, axis=1) / np.linalg.norm(centre)

    # Ground resolution: metres per pixel at this distance and incidence.
    metres_per_pixel = distance / camera.focal_px / np.maximum(cos_incidence, 1e-3)

    score = (np.clip(cos_incidence, 0.0, 1.0) ** 2
             * np.clip(1.0 - radial * 0.4, 0.2, 1.0)
             / np.maximum(metres_per_pixel, 1e-6))
    score = np.where(inside & (cos_incidence > 0.15), score, -np.inf)

    out_score = np.full(shape, -np.inf).ravel()
    out_px = np.full((shape[0] * shape[1], 2), np.nan)
    out_res = np.full(shape, np.nan).ravel()
    out_score[idx] = score
    out_px[idx] = pixels
    out_res[idx] = metres_per_pixel

    return {
        "score": out_score.reshape(shape),
        "pixels": out_px.reshape(shape + (2,)),
        "metres_per_pixel": out_res.reshape(shape),
        "stats": {
            "camera": camera.name,
            "scored_texels": int(np.isfinite(score).sum()),
            "median_incidence_deg": round(float(np.degrees(np.arccos(
                np.clip(np.median(cos_incidence[np.isfinite(score)]), -1, 1)))), 1),
            "median_gsd_m": round(float(np.median(
                metres_per_pixel[np.isfinite(score)])), 4),
        },
    }
```

The incidence term squared, divided by the ground sample distance, is the core of the score and it encodes the two things that matter: a surface seen face-on is sharper than one seen obliquely, and a camera close to the surface resolves more detail than a distant one.

The 0.15 cosine cut-off — about 81° of incidence — discards views that graze the surface. Those views technically see the texel and contribute a smeared, heavily foreshortened sample, and including them is a common source of blurred patches.

The radial term penalises the image edge mildly, which helps because lens distortion residuals, vignetting and chromatic aberration are all worst there even after calibration.

### 5. Blend the best views

```python
def bake_texture(mesh, cameras, atlas_dim=4096, top_k=3, blend="weighted",
                 outlier_sigma=2.0, epsilon_m=0.02):
    geom = texel_positions(mesh, atlas_dim)
    covered = geom["covered"]

    best_scores = np.full((atlas_dim, atlas_dim, top_k), -np.inf)
    best_colour = np.zeros((atlas_dim, atlas_dim, top_k, 3), dtype=np.float32)
    per_camera = []

    for cam in cameras:
        vis, vis_stats = visibility(mesh, geom["positions"], covered, cam,
                                    epsilon_m=epsilon_m)
        scored = view_scores(geom["positions"], geom["normals"], covered, vis, cam)
        per_camera.append({**vis_stats, **scored["stats"]})

        with Image.open(cam.image_path) as img:
            pix = np.asarray(img.convert("RGB"), dtype=np.float32)

        sel = np.isfinite(scored["score"]) & (scored["score"] > -np.inf)
        ys, xs = np.nonzero(sel)
        if len(ys) == 0:
            continue
        px = scored["pixels"][ys, xs]
        # Bilinear sample.
        x0 = np.clip(np.floor(px[:, 0]).astype(int), 0, cam.width - 2)
        y0 = np.clip(np.floor(px[:, 1]).astype(int), 0, cam.height - 2)
        fx = px[:, 0] - x0
        fy = px[:, 1] - y0
        c = (pix[y0, x0] * ((1 - fx) * (1 - fy))[:, None]
             + pix[y0, x0 + 1] * (fx * (1 - fy))[:, None]
             + pix[y0 + 1, x0] * ((1 - fx) * fy)[:, None]
             + pix[y0 + 1, x0 + 1] * (fx * fy)[:, None])

        s = scored["score"][ys, xs]
        for rank in range(top_k):
            better = s > best_scores[ys, xs, rank]
            if not better.any():
                continue
            for shift in range(top_k - 1, rank, -1):
                move = better
                best_scores[ys[move], xs[move], shift] = \
                    best_scores[ys[move], xs[move], shift - 1]
                best_colour[ys[move], xs[move], shift] = \
                    best_colour[ys[move], xs[move], shift - 1]
            best_scores[ys[better], xs[better], rank] = s[better]
            best_colour[ys[better], xs[better], rank] = c[better]
            break

    valid = np.isfinite(best_scores) & (best_scores > -np.inf)
    counts = valid.sum(axis=2)

    if blend == "best":
        texture = best_colour[:, :, 0, :]
    else:
        weights = np.where(valid, np.maximum(best_scores, 0.0), 0.0)
        # Reject a view whose colour is far from the median of the others.
        if outlier_sigma:
            med = np.nanmedian(np.where(valid[..., None], best_colour, np.nan), axis=2)
            dev = np.linalg.norm(best_colour - med[:, :, None, :], axis=3)
            spread = np.nanstd(np.where(valid, dev, np.nan), axis=2, keepdims=True)
            keep = valid & (dev <= np.nan_to_num(spread, nan=1e9) * outlier_sigma + 12.0)
            weights = np.where(keep, weights, 0.0)
        total = weights.sum(axis=2, keepdims=True)
        texture = np.where(total > 0,
                           (best_colour * weights[..., None]).sum(axis=2)
                           / np.maximum(total, 1e-9),
                           0.0)[:, :, :]

    return {
        "texture": np.clip(texture, 0, 255).astype(np.uint8),
        "counts": counts,
        "covered": covered,
        "per_camera": per_camera,
        "stats": {
            "atlas_dim": atlas_dim,
            "covered_texels": int(covered.sum()),
            "textured_texels": int((counts > 0).sum()),
            "unseen_texels": int((covered & (counts == 0)).sum()),
            "median_views_per_texel": int(np.median(counts[covered])),
            "coverage_of_surface": round(float((counts > 0).sum()
                                               / max(covered.sum(), 1)), 4),
        },
    }
```

Blending the top three views with score weighting, rather than taking the single best, is what removes the hard colour steps. A texel at the boundary between two images' coverage takes the best view on one side and the next-best on the other, and if only one view is used the exposure difference between the two images becomes a visible line.

The outlier rejection is what handles the tree that is not in the mesh. Two views see the wall and one sees leaves; the leaf colour is far from the median of the three, so it is dropped and the wall colour survives. This is the cheapest available defence against occluders absent from the geometry, and it works surprisingly well with three or more views.

Keeping the top *k* scores and colours rather than all views bounds the memory: a 4,096 atlas with three views is 400 MB of float32, which is manageigable, while forty views would be 5 GB.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="proj-score-t proj-score-d" xmlns="http://www.w3.org/2000/svg">
  <title id="proj-score-t">What the view score weighs, and why</title>
  <desc id="proj-score-d">A table of four terms in the per-texel view score. The squared cosine of incidence favours surfaces seen face-on because they are sharper. The inverse ground sample distance favours close, high-resolution views. A mild radial penalty avoids the image edge where distortion residuals and vignetting are worst. A hard cut-off at eighty-one degrees of incidence discards grazing views that contribute only smeared samples.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="218" y="20" width="234" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="452" y="20" width="270" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="218" y="54" width="234" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="452" y="54" width="270" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="218" y="88" width="234" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="452" y="88" width="270" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="218" y="122" width="234" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="452" y="122" width="270" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="156" width="234" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="452" y="156" width="270" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="118" y="42">term</text><text x="335" y="42">form</text><text x="587" y="42">why</text>
    <text x="118" y="76">incidence</text><text x="335" y="76">cos squared</text><text x="587" y="76">face-on surfaces are sharper</text>
    <text x="118" y="110">ground resolution</text><text x="335" y="110">1 / metres per pixel</text><text x="587" y="110">closer views resolve more</text>
    <text x="118" y="144">radial position</text><text x="335" y="144">mild penalty to the edge</text><text x="587" y="144">distortion residual and vignetting</text>
    <text x="118" y="178">grazing cut-off</text><text x="335" y="178">cos below 0.15 rejected</text><text x="587" y="178">smeared, foreshortened samples</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">The grazing cut-off at about 81 degrees is what removes the blurred patches from a baked texture.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Keeping the top three scored views is what lets colour outlier rejection remove an unmodelled tree.</text>
</svg>
<figcaption>Two terms reward sharpness, one avoids the lens edge, and the cut-off removes the blurred contributors.</figcaption>
</figure>

### 6. Audit coverage and verify the geometry

```python
def coverage_audit(result, mesh, atlas_dim):
    covered = result["covered"]
    counts = result["counts"]
    unseen = covered & (counts == 0)

    from scipy import ndimage
    labels, n = ndimage.label(unseen)
    sizes = ndimage.sum(np.ones_like(labels), labels,
                        index=np.arange(1, n + 1)) if n else np.array([])

    # Map unseen texels back to faces so the gap can be located in 3D.
    face_id = np.full(covered.shape, -1)
    unseen_faces = np.unique(face_id[unseen]) if unseen.any() else np.array([])
    surface_area = float(mesh.area)
    texel_area = surface_area / max(int(covered.sum()), 1)

    return {
        "covered_texels": int(covered.sum()),
        "unseen_texels": int(unseen.sum()),
        "unseen_fraction": round(float(unseen.sum() / max(covered.sum(), 1)), 5),
        "unseen_area_m2": round(float(unseen.sum()) * texel_area, 2),
        "unseen_patches": int(n),
        "largest_patch_texels": int(sizes.max()) if sizes.size else 0,
        "largest_patch_m2": round(float(sizes.max()) * texel_area, 2)
        if sizes.size else 0.0,
        "views_per_texel": {
            "p05": int(np.percentile(counts[covered], 5)),
            "p50": int(np.percentile(counts[covered], 50)),
            "single_view_fraction": round(float((counts[covered] == 1).mean()), 4),
        },
        "acceptable": float(unseen.sum() / max(covered.sum(), 1)) < 0.02,
    }

def fill_unseen(texture, covered, counts, iterations=8):
    """Inpaint the unseen texels from their neighbours so they are not black."""
    from scipy import ndimage
    out = texture.astype(np.float32).copy()
    known = (counts > 0)
    for _ in range(iterations):
        if known[covered].all():
            break
        grown = ndimage.binary_dilation(known)
        fill = grown & covered & ~known
        if not fill.any():
            break
        for ch in range(3):
            smooth = ndimage.uniform_filter(
                np.where(known, out[:, :, ch], 0.0), size=5)
            weight = ndimage.uniform_filter(known.astype(np.float32), size=5)
            out[fill, ch] = smooth[fill] / np.maximum(weight[fill], 1e-6)
        known = grown & covered
    return np.clip(out, 0, 255).astype(np.uint8), {
        "filled_texels": int((known & covered).sum() - (counts > 0).sum()),
        "still_unseen": int((covered & ~known).sum()),
    }
```

Reporting the unseen area in square metres rather than in texels is what makes the audit meaningful to whoever commissioned the texture. "2.4 m² of the north facade has no photograph" is a statement they can act on — fly again, or accept it.

The distinction between many small unseen patches and one large one matters. Small patches are the shadowed sides of window reveals and are fine to inpaint; a 40 m² patch is a facade nobody photographed, and inpainting it produces a smooth invention that looks like data.

`single_view_fraction` is the quality warning: texels with only one view got no blending and no outlier rejection, so they are the ones most likely to have a tree printed on them.

<figure class="diagram">
<svg viewBox="2 26 736 226" role="img" aria-labelledby="proj-pipeline-t proj-pipeline-d" xmlns="http://www.w3.org/2000/svg">
  <title id="proj-pipeline-t">Per-texel decision pipeline</title>
  <desc id="proj-pipeline-d">For one texel, the pipeline runs five tests across all forty cameras. Projection inside the image frame leaves 18 candidates. The visibility ray test against the mesh removes 7 that are self-occluded, leaving 11. The incidence cut-off at 81 degrees removes 4 grazing views, leaving 7. Scoring by incidence and ground resolution ranks them and the top 3 are kept. Colour outlier rejection drops 1 that saw a tree, and the remaining 2 are blended by score weight.</desc>
  <rect class="svg-bg" x="2" y="26" width="736" height="226" fill="#ffffff"/>
  <defs>
    <marker id="proj-pipeline-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.8">
    <rect x="16" y="40" width="118" height="52" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="168" y="40" width="118" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="40" width="118" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="472" y="40" width="118" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="624" y="40" width="100" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="152" width="270" height="52" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#proj-pipeline-arrow)">
    <path d="M134 66 H166"/><path d="M286 66 H318"/><path d="M438 66 H470"/>
    <path d="M590 66 H622"/>
    <path d="M531 92 V126 H455 V150"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="75" y="60">40 cameras</text><text x="75" y="78">all considered</text>
    <text x="227" y="54">in frame</text><text x="227" y="72">and in front:</text><text x="227" y="90">18 left</text>
    <text x="379" y="54">visibility ray</text><text x="379" y="72">vs the mesh:</text><text x="379" y="90">11 left</text>
    <text x="531" y="54">incidence</text><text x="531" y="72">&lt; 81°:</text><text x="531" y="90">7 left</text>
    <text x="674" y="54">score, keep</text><text x="674" y="72">top 3</text>
    <text x="455" y="172">colour outlier rejection drops 1 (a tree)</text>
    <text x="455" y="192">the other 2 blend by score weight</text>
  </g>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">the visibility test removes self-occlusion; the outlier test removes occluders absent from the mesh</text>
</svg>
<figcaption>Five filters per texel, and the last one is what saves a texture when a tree was removed from the geometry but not from the photographs.</figcaption>
</figure>

## Expected Output & Verification

```text
{'cameras': 41, 'missing_images': []}
{'positions': ..., 'covered_texels': 12184402, 'coverage_fraction': 0.7268}
{
  "stats": {
    "atlas_dim": 4096, "covered_texels": 12184402, "textured_texels": 12061884,
    "unseen_texels": 122518, "median_views_per_texel": 6,
    "coverage_of_surface": 0.98995
  }
}
{
  "covered_texels": 12184402, "unseen_texels": 122518, "unseen_fraction": 0.01006,
  "unseen_area_m2": 12.11, "unseen_patches": 214,
  "largest_patch_texels": 18412, "largest_patch_m2": 1.82,
  "views_per_texel": {"p05": 2, "p50": 6, "single_view_fraction": 0.0184},
  "acceptable": true
}
{'filled_texels': 122102, 'still_unseen': 416}
```

A 99% coverage with a median of six views per texel is a well-flown survey. The 12.1 m² of unseen surface spread over 214 patches, none larger than 1.8 m², is the shape to hope for — window reveals and under-eaves, all safely inpaintable.

The 1.8% of texels with a single view is the quality caveat worth recording: those texels had no blending and no outlier rejection.

Verify the camera model and the coordinate convention before trusting any of it:

```python
def camera_calibration_check(cameras, mesh, control_points, tolerance_px=3.0):
    """Project points with known image coordinates and compare."""
    rows = []
    for cp in control_points:
        cam = next((c for c in cameras if c.name == cp["image"]), None)
        if cam is None:
            rows.append({"id": cp["id"], "status": "camera not found"})
            continue
        pixels, valid, depth = cam.project(np.asarray([cp["world"]]))
        if not valid[0]:
            rows.append({"id": cp["id"], "status": "projects outside the image",
                         "computed": [round(float(v), 1) for v in pixels[0]]})
            continue
        err = float(np.linalg.norm(pixels[0] - np.asarray(cp["pixel"])))
        rows.append({"id": cp["id"], "image": cp["image"],
                     "computed_px": [round(float(v), 2) for v in pixels[0]],
                     "measured_px": cp["pixel"],
                     "error_px": round(err, 2),
                     "within": err <= tolerance_px})
    measured = [r for r in rows if "error_px" in r]
    if not measured:
        return {"measurable": False, "rows": rows}
    errors = np.array([r["error_px"] for r in measured])
    return {
        "measurable": True,
        "points": len(measured),
        "rmse_px": round(float(np.sqrt((errors ** 2).mean())), 2),
        "max_px": round(float(errors.max()), 2),
        "within_tolerance": int((errors <= tolerance_px).sum()),
        "all_within": bool((errors <= tolerance_px).all()),
        "worst": sorted(measured, key=lambda r: -r["error_px"])[:3],
        "diagnosis": "rotation convention is probably transposed"
                     if float(errors.mean()) > 200 else
                     "distortion not applied" if float(errors.mean()) > 20 else
                     "calibration consistent",
    }
```

A mean error above 200 pixels means the rotation is transposed; 20 to 60 pixels means the distortion is not being applied; under three pixels means the model is right. That diagnostic ladder saves an afternoon, because all three failures produce a texture that is recognisably wrong and not obviously why.

Then verify the baked texture against the images it came from, rather than looking at it:

```python
def reprojection_consistency(result, mesh, cameras, atlas_dim, samples=20_000,
                             seed=7):
    """Sample the baked texture and compare with what each camera sees there."""
    texture = result["texture"]
    covered = result["covered"]
    geom = texel_positions(mesh, atlas_dim)
    rng = np.random.default_rng(seed)
    ys, xs = np.nonzero(covered & (result["counts"] > 1))
    pick = rng.choice(len(ys), size=min(samples, len(ys)), replace=False)
    ys, xs = ys[pick], xs[pick]
    pts = geom["positions"][ys, xs]
    baked = texture[ys, xs].astype(np.float32)

    deltas = []
    for cam in cameras:
        pixels, valid, _ = cam.project(pts)
        if not valid.any():
            continue
        with Image.open(cam.image_path) as img:
            pix = np.asarray(img.convert("RGB"), dtype=np.float32)
        px = np.clip(pixels[valid].astype(int), 0,
                     [cam.width - 1, cam.height - 1])
        seen = pix[px[:, 1], px[:, 0]]
        deltas.append(np.linalg.norm(seen - baked[valid], axis=1))
    if not deltas:
        return {"measurable": False}
    d = np.concatenate(deltas)
    return {
        "samples": int(len(d)),
        "mean_colour_distance": round(float(d.mean()), 2),
        "p95_colour_distance": round(float(np.percentile(d, 95)), 2),
        "consistent": float(np.percentile(d, 95)) < 60.0,
        "note": "large distances mean the blend is dominated by one exposure, or "
                "the projection is misaligned",
    }
```

A p95 colour distance under about 60 (out of a 441 maximum in RGB space) means the baked texture agrees with the source photographs where they overlap. A much larger figure with a correct calibration check means the exposures differ substantially between images, which is a radiometric problem rather than a geometric one and needs colour balancing before blending.

## Performance Notes

- **The visibility ray-casting dominates**: roughly 100,000–400,000 rays per second with `pyembree`, an order of magnitude slower without it. A 12-million-texel atlas across 41 cameras is 500 million rays, so install `pyembree` or process per chart.
- **Cull cameras per chart by frustum first.** Most cameras cannot see most of the mesh, and a bounding-sphere test against the camera frustum removes 80–90% of the work before any ray is cast.
- **Load each image once** and sample all its texels in one pass; re-opening a 45 MP image per texel is the classic accidental slowdown.
- **Memory is `atlas_dim² × top_k × 3` floats** for the colour buffer — 400 MB at 4,096 and three views. Reduce `top_k` or tile the atlas for larger textures.
- **Supersampling the atlas 2× then downsampling** reduces aliasing on high-frequency facade detail at four times the cost.
- **Bake per building, in parallel.** Each building is independent, and the per-building camera cull makes each one fast.

## Common Errors

**Texture is offset by tens of centimetres at the edges of each image.** Lens distortion not applied.

**Texture is nonsense but correct at the image centres.** Rotation transposed.

**Windows appear on blank walls.** No visibility test, so self-occluded texels took the colour of whatever was in front.

**Trees printed on facades.** Occluders absent from the mesh and only one view per texel. Raise `top_k` and rely on the outlier rejection.

**Hard colour steps across the facade.** Single-best-view selection instead of blending, or genuinely different exposures between images.

**Blurred patches.** Grazing views included. Raise the incidence cut-off.

**Black patches in the atlas.** Unseen texels. Inpaint them, and report the area.

**Every texel reads as occluded.** The ray epsilon is zero, so each ray hits its own triangle.

## Frequently Asked Questions

### Should I colour-balance the images first?

Yes, if they were taken across changing light. Score-weighted blending hides small exposure differences and cannot hide a two-stop change; a global colour balance or a per-image gain solved against the overlaps is the fix.

### How many views per texel are enough?

Two for blending, three for outlier rejection to work. Below two, the texel is at the mercy of whatever that one image contains.

### Can this handle a mesh much coarser than the photographs?

Up to a point. A simplified mesh's surface is a few centimetres from the true geometry, and the projection error scales with that offset divided by the viewing distance — so a 10 cm geometric error at 30 m is about 2 pixels and invisible, while the same error at 3 m is 20 pixels and shows as doubled edges.

## Related Guides

- [Generating UV Atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/) — the parameterisation this bakes into
- [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/) — where the oriented images come from
- [Tiling Photogrammetry OBJ Meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/tiling-photogrammetry-obj-meshes/) — packing the baked textures for delivery

Back to [Texture Mapping Workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
