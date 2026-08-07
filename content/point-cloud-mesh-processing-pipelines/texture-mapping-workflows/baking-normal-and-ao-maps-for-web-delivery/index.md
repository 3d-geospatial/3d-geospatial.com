# Baking Normal and AO Maps for Web Delivery

Baking normal and ambient-occlusion maps means transferring the surface detail of a high-poly mesh onto a decimated low-poly mesh as two textures — a tangent-space normal map that fakes the fine relief the decimation discarded, and an occlusion map that darkens crevices — so a web/glTF asset looks detailed while streaming a fraction of the triangles. This page unwraps the low-poly with `xatlas`, cage-projects and ray-casts against the high-poly with `trimesh` and `numpy`, encodes tangent-space normals, and packs the result into a glTF `normalTexture` and `occlusionTexture`, working throughout in EPSG:32618 (UTM zone 18N).

You hit this the moment [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) takes a 40 M-triangle photogrammetric facade down to a web budget and the rooflines, mullions, and stone relief vanish with the triangles. Baking is how that detail survives: it is measured once, at build time, from the high-poly source and stored as an image the GPU samples per pixel, so the low-poly mesh shades as if the geometry were still there. It sits at the end of the [texture mapping workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/), after the diffuse atlas is produced.

<figure class="diagram">
<svg viewBox="2 26 816 246" role="img" aria-labelledby="bake-t bake-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bake-t">Normal and AO baking from high-poly to low-poly glTF</title>
  <desc id="bake-d">A high-poly mesh and a decimated low-poly mesh with a cage feed a ray-cast sampling stage, which emits a tangent-space normal map and an ambient-occlusion map that are packed into a glTF normalTexture and occlusionTexture.</desc>
  <rect class="svg-bg" x="2" y="26" width="816" height="246" fill="#ffffff"/>
  <defs>
    <marker id="bake-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="40" width="176" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="16" y="188" width="176" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="250" y="108" width="180" height="82" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="488" y="46" width="154" height="64" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="488" y="188" width="154" height="64" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="690" y="108" width="114" height="82" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#bake-arrow)">
    <line x1="192" y1="80" x2="248" y2="132"/>
    <line x1="192" y1="218" x2="248" y2="166"/>
    <line x1="430" y1="135" x2="486" y2="82"/>
    <line x1="430" y1="163" x2="486" y2="216"/>
    <line x1="642" y1="82" x2="688" y2="134"/>
    <line x1="642" y1="216" x2="688" y2="164"/>
  </g>
  <g text-anchor="middle" font-size="13" fill="#1f2937">
    <text x="104" y="80"><tspan x="104" dy="0">High-poly</tspan><tspan x="104" dy="16">source detail</tspan></text>
    <text x="104" y="228"><tspan x="104" dy="0">Low-poly</tspan><tspan x="104" dy="16">+ cage</tspan></text>
    <text x="340" y="143"><tspan x="340" dy="0">Cage ray-cast</tspan><tspan x="340" dy="16">sample high-poly</tspan></text>
    <text x="565" y="72"><tspan x="565" dy="0">Tangent-space</tspan><tspan x="565" dy="16">normal map</tspan></text>
    <text x="565" y="214"><tspan x="565" dy="0">Ambient</tspan><tspan x="565" dy="16">occlusion map</tspan></text>
    <text x="747" y="140"><tspan x="747" dy="0">glTF</tspan><tspan x="747" dy="16">normal +</tspan><tspan x="747" dy="16">occlusion</tspan></text>
  </g>
</svg>
<figcaption>A cage over the low-poly casts rays to the high-poly surface; the sampled normals and occlusion become two glTF textures.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `xatlas>=0.0.9`, `trimesh>=4.0`, `numpy>=1.24`, `Pillow>=10.0`: `pip install xatlas "trimesh>=4.0" "numpy>=1.24" Pillow`. Install `rtree` and `pyembree` (or `trimesh[easy]`) so `trimesh`'s ray caster is fast.
- A high-poly source mesh and a decimated low-poly mesh of the same asset, both in EPSG:32618. Preserve UV seams through decimation first — see [preserving UV seams during mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/) — because the bake writes into the low-poly's UV layout. Shift both to a shared local origin so ray math stays precise on six-figure UTM eastings.
- Blender's `bpy` is a capable alternative baker (`Cycles` bake type `NORMAL`/`AO`); this page stays in pure Python so the bake runs headless in CI without a Blender install.

## Step-by-Step

### 1. Load both meshes on a shared local origin

Load the high- and low-poly meshes and subtract one common origin from both, so a ray cast from the low-poly lands in the high-poly's coordinate frame.

```python
import trimesh
import numpy as np

high = trimesh.load("facade_highpoly.ply", process=False)   # EPSG:32618, metres
low = trimesh.load("facade_lowpoly.glb", force="mesh", process=False)

origin = low.vertices.mean(axis=0)          # shared local origin, EPSG:32618
high.vertices -= origin
low.vertices -= origin
print(f"high {len(high.faces):,} tris  ->  low {len(low.faces):,} tris")
```

### 2. Unwrap the low-poly with xatlas

The bake targets the low-poly's UV space, so it needs a clean, non-overlapping atlas. `xatlas` produces one and returns the vertex remapping you apply to keep positions aligned with the new UVs.

```python
import xatlas

vmapping, indices, uvs = xatlas.parametrize(low.vertices, low.faces)
low_v = low.vertices[vmapping]     # positions re-indexed to the new UV vertices
low_f = indices                    # faces into low_v
print(f"xatlas produced {len(uvs):,} UV verts, {len(low_f):,} faces")
```

### 3. Build a cage and per-texel sample points

Cage/ray-cast baking offsets the low-poly outward along its normals to form a *cage* that fully encloses the high-poly, then casts a ray from each texel inward. For every atlas texel, find which triangle owns it, compute the barycentric world position and interpolated normal, and push the ray origin out along that normal by the cage distance.

```python
TEX = 1024
low_vn = trimesh.geometry.mean_vertex_normals(len(low_v), low_f,
                                              trimesh.Trimesh(low_v, low_f).face_normals)
cage = 0.25   # metres of outward offset in EPSG:32618; > max high-poly relief

# Rasterise the atlas: for each texel, the owning face + barycentric coords.
px = (uvs * TEX).astype(np.int32)
origins, normals, texel_xy = [], [], []
for f in low_f:
    a, b, c = px[f]
    x0, y0 = np.minimum.reduce([a, b, c]); x1, y1 = np.maximum.reduce([a, b, c])
    for y in range(max(y0, 0), min(y1 + 1, TEX)):
        for x in range(max(x0, 0), min(x1 + 1, TEX)):
            bary = trimesh.triangles.points_to_barycentric(
                low_v[f][None], np.array([[x + .5, y + .5, 0]]) )  # UV-plane bary
            if (bary < -1e-4).any():
                continue                              # texel outside the triangle
            w = bary[0]
            origins.append(w @ low_v[f])
            normals.append(w @ low_vn[f])
            texel_xy.append((x, y))
origins = np.asarray(origins); normals = np.asarray(normals)
normals /= np.linalg.norm(normals, axis=1, keepdims=True)
```

<figure class="diagram">
<svg viewBox="46 93 648 187" role="img" aria-labelledby="bk-cage-t bk-cage-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bk-cage-t">The cage decides how far a bake ray may travel</title>
  <desc id="bk-cage-d">Rays are cast from the low-poly surface along its normals to find the high-poly detail. A cage that is too tight stops short of recessed detail and leaves holes in the map. One that is too loose lets a ray reach past the intended feature and pick up a neighbouring surface, which shows up as a smeared patch.</desc>
  <rect class="svg-bg" x="46" y="93" width="648" height="187" fill="#ffffff"/>
  <defs>
    <marker id="bk-cage-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M60 190 H680" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M60 154 C 140 150 180 168 220 152 C 260 136 300 176 340 150 C 400 112 440 178 500 148 C 560 120 620 168 680 152"
        fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <path d="M60 128 H680" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <g stroke="#5b6471" stroke-width="1.5" marker-end="url(#bk-cage-a)">
    <path d="M120 188 V132"/>
    <path d="M240 188 V132"/>
    <path d="M360 188 V132"/>
    <path d="M480 188 V132"/>
    <path d="M600 188 V132"/>
  </g>
  <text x="66" y="208" fill="#1f6b8a" font-size="12" text-anchor="start">low-poly surface — where the UVs live</text>
  <text x="66" y="146" fill="#c46a3d" font-size="12" text-anchor="start">high-poly detail</text>
  <text x="66" y="120" fill="#4f7a4d" font-size="12" text-anchor="start">cage — the maximum ray distance</text>
  <text x="370" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Too tight and recessed detail never gets hit; too loose and a ray finds the wall behind the balcony</text>
  <text x="370" y="262" fill="#5b6471" font-size="12" text-anchor="middle">Start at 1.5× the largest peak-to-valley distance you measured between the two meshes, then tighten</text>
</svg>
<figcaption>Almost every bad bake is a cage problem rather than a sampling one. Measuring the actual displacement between the meshes turns the parameter into arithmetic.</figcaption>
</figure>

### 4. Bake the tangent-space normal map

Cast each cage ray into the high-poly, read the hit triangle's interpolated normal, and rotate it into the low-poly surface's tangent frame (T, B, N). Tangent-space normals are what glTF expects, because they stay valid as the mesh moves and animates. Encode the unit vector into the 0–255 RGB range.

```python
ray_origins = origins + normals * cage
ray_dirs = -normals                                  # cast back inward toward high-poly
locs, ray_idx, tri_idx = high.ray.intersects_location(
    ray_origins, ray_dirs, multiple_hits=False)

nmap = np.zeros((TEX, TEX, 3), dtype=np.uint8)
nmap[..., 2] = 255                                   # default flat normal (0,0,1)
hi_fn = high.face_normals
for loc_i, r, t in zip(range(len(ray_idx)), ray_idx, tri_idx):
    n_world = hi_fn[t]
    # Tangent frame of the low-poly texel: T from UV gradient, N its normal.
    N = normals[r]
    T = np.cross(N, [0, 0, 1]); T /= (np.linalg.norm(T) + 1e-9)
    B = np.cross(N, T)
    n_tan = np.array([n_world @ T, n_world @ B, n_world @ N])
    n_tan /= np.linalg.norm(n_tan) + 1e-9
    x, y = texel_xy[r]
    nmap[y, x] = ((n_tan * 0.5 + 0.5) * 255).astype(np.uint8)
```

### 5. Bake the ambient-occlusion map

AO measures how much of the hemisphere above each point is blocked by nearby geometry. Fire a batch of hemisphere rays from every sample point against the high-poly and store the unoccluded fraction — 1.0 is open sky, 0.0 is a sealed crevice.

```python
def hemisphere_dirs(normal, k=64, rng=np.random.default_rng(0)):
    v = rng.normal(size=(k, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    v[(v @ normal) < 0] *= -1                         # flip into the upper hemisphere
    return v

aomap = np.full((TEX, TEX), 255, dtype=np.uint8)
for i, (o, n) in enumerate(zip(origins, normals)):
    dirs = hemisphere_dirs(n, k=64)
    starts = np.repeat((o + n * 1e-3)[None], len(dirs), axis=0)   # bias off surface
    hit = high.ray.intersects_any(starts, dirs)
    ao = 1.0 - hit.mean()                             # fraction of open sky
    x, y = texel_xy[i]
    aomap[y, x] = int(np.clip(ao, 0, 1) * 255)
```

<figure class="diagram">
<svg viewBox="19 14 702 288" role="img" aria-labelledby="bk-space-t bk-space-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bk-space-t">Why the normal map has to be tangent space</title>
  <desc id="bk-space-d">An object-space normal map stores directions in the model's own frame, so it is only correct while the model never rotates and never reuses a UV island. A tangent-space map stores directions relative to the surface, so the same map stays correct under any rotation and can be shared by mirrored or repeated islands.</desc>
  <rect class="svg-bg" x="19" y="14" width="702" height="288" fill="#ffffff"/>
  <path d="M56 70 h280 v70 h-280 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M56 160 h280 v70 h-280 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M404 70 h280 v70 h-280 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M404 160 h280 v70 h-280 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="196" y="98"><tspan x="196" dy="0" font-weight="600">object space</tspan><tspan x="196" dy="17">directions in the model frame</tspan></text>
    <text x="196" y="188"><tspan x="196" dy="0">rotate the building 90°</tspan><tspan x="196" dy="17">and every normal is wrong</tspan></text>
    <text x="544" y="98"><tspan x="544" dy="0" font-weight="600">tangent space</tspan><tspan x="544" dy="17">directions relative to the surface</tspan></text>
    <text x="544" y="188"><tspan x="544" dy="0">rotation-invariant, and mirrored</tspan><tspan x="544" dy="17">islands can share one region</tspan></text>
  </g>
  <text x="370" y="42" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">glTF's normalTexture is defined as tangent space — an object-space map is not a variant, it is wrong</text>
  <text x="370" y="264" fill="#5b6471" font-size="12" text-anchor="middle">Which means the mesh must carry TANGENT, or the runtime has to derive it from the UVs and get the handedness right</text>
  <text x="370" y="284" fill="#b0413e" font-size="12" text-anchor="middle">A flipped green channel is the usual symptom: lighting looks inverted on every recess</text>
</svg>
<figcaption>The distinction only matters once the asset is instanced, mirrored, or rotated — which is exactly what a city of repeated building types does.</figcaption>
</figure>

### 6. Pack into a glTF with normalTexture and occlusionTexture

Attach both maps to a `trimesh` PBR material. glTF stores relief in [`KHR` `normalTexture`](https://www.khronos.org/gltf/) and shading occlusion in `occlusionTexture` (its red channel), so a compliant viewer applies them automatically. Save the maps and export a self-contained `.glb` in EPSG:32618 (restore the origin first).

```python
from PIL import Image

Image.fromarray(nmap).save("facade_normal.png")
Image.fromarray(aomap, mode="L").save("facade_ao.png")

low_out = trimesh.Trimesh(low_v + origin, low_f, process=False)   # back to EPSG:32618
low_out.visual = trimesh.visual.TextureVisuals(
    uv=uvs,
    material=trimesh.visual.material.PBRMaterial(
        normalTexture=Image.open("facade_normal.png"),
        occlusionTexture=Image.open("facade_ao.png"),
    ))
low_out.export("facade_baked.glb")
print("wrote facade_baked.glb with normal + occlusion textures")
```

For production web delivery, transcode both PNGs to KTX2 (`toktx --genmipmap --t2 facade_normal.ktx2 facade_normal.png`) and reference them through `KHR_texture_basisu`, which cuts GPU memory 60–80% versus PNG; keep the normal map in a linear, high-quality UASTC mode so relief does not band.

## Expected Output & Verification

A correct bake covers nearly every texel that maps to a triangle and leaves the flat default only where a ray missed the high-poly. Report the hit fraction and confirm the normal map is dominated by the +Z (flat) blue that a valid tangent-space map should show, with detail as local perturbation:

```python
hit_fraction = len(ray_idx) / max(len(origins), 1)
mean_blue = nmap[..., 2].mean()
print(f"normal-bake hit fraction {hit_fraction:.1%}, mean B channel {mean_blue:.0f}/255")
print(f"AO mean {aomap.mean():.0f}/255 (lower = more occluded relief)")

assert hit_fraction > 0.9, "cage too small or misaligned — high-poly not being hit"
assert mean_blue > 140, "normal map not +Z dominant — tangent frame is wrong"
```

Sample console output for a facade baked at 1024 px:

```text
high 38,402,551 tris  ->  low 96,204 tris
xatlas produced 121,880 UV verts, 96,204 faces
normal-bake hit fraction 97.4%, mean B channel 203/255
AO mean 214/255 (lower = more occluded relief)
wrote facade_baked.glb with normal + occlusion textures
```

Validate the container with `gltf-validator facade_baked.glb`; it confirms the `normalTexture` and `occlusionTexture` references resolve and that the UV accessor matches the position count. Then load in a glTF viewer and rake a light across the facade — the mullions and stone relief should catch the light despite the low triangle count. A muddy, flat result means the tangent frame or the V-flip is wrong.

## Common Errors

**Normal map is mostly red/green instead of blue.** The sampled normals were stored in world space, not rotated into the low-poly tangent frame, so glTF reads them as extreme relief. Multiply each world normal by the texel's (T, B, N) basis before encoding, as step 4 does, and confirm the mean blue channel exceeds ~140.

**Large flat patches where detail should be (low hit fraction).** The cage offset is smaller than the high-poly's relief, so rays start inside the detail and miss, or the two meshes were not shifted to a shared origin. Raise `cage` above the deepest displacement and verify both meshes share the local origin from step 1.

**Occlusion looks inverted — crevices are bright, open faces dark.** The glTF `occlusionTexture` reads occlusion from the red channel where 1.0 means fully lit; you stored the occluded fraction instead of the open-sky fraction. Store `1.0 - hit.mean()` so open faces are bright, and bias ray starts off the surface to avoid self-intersection noise.

## Related Guides

- [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — the diffuse-atlas pipeline this baking step extends
- [Aligning Photogrammetry Textures with Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/aligning-photogrammetry-textures-with-point-clouds/) — projecting source imagery before you bake maps
- [Preserving UV Seams During Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/) — keeping the low-poly UV layout the bake writes into
- [Optimizing Mesh Triangle Count for Web Rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — producing the low-poly the maps rescue
- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — the container the baked textures ship in

Back to [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
