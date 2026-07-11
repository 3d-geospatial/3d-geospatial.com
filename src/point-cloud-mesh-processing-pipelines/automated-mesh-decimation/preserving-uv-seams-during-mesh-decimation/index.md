---
title: "Preserving UV Seams During Mesh Decimation"
description: "Keep UV/texture seams and material boundaries intact while decimating a textured mesh: lock seam vertices, decimate per material with trimesh, open3d, gltfpack"
---
# Preserving UV Seams During Mesh Decimation

Preserving UV seams during mesh decimation means reducing a textured mesh's triangle count without letting an edge collapse merge two vertices that sit on opposite sides of a texture seam or material boundary — the collapse that smears a facade's window texture across its brick or wraps one material's atlas onto another. This page locks seam and boundary vertices with `open3d`'s `boundary_weight`, splits the mesh on its UV islands and materials with `trimesh`, drives an attribute-aware pass with `gltfpack` from the `meshoptimizer` toolchain, and verifies the result by measuring per-triangle UV area distortion, all on a georeferenced building block in EPSG:32618 (UTM zone 18N).

You hit this the moment a textured web asset comes back from decimation looking scrambled: the geometry is fine but the texture crawls, because the [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) pass treated UV-seam edges as ordinary interior edges and collapsed them. A UV seam is a curve where the texture atlas is cut so a 3D surface can be flattened; along it, one spatial vertex owns two or more different texture coordinates. Merge across it and there is no single UV that can be right, so the atlas tears.

<figure class="diagram">
<svg viewBox="0 0 820 260" role="img" aria-labelledby="uvs-t uvs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="uvs-t">Seam-preserving decimation pipeline</title>
  <desc id="uvs-d">A textured mesh with UVs and materials is split into per-material UV islands, each island is decimated with its seam and boundary vertices pinned, and the islands are merged back into a low-poly textured mesh whose atlas is intact.</desc>
  <defs>
    <marker id="uvs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="66" width="176" height="94" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="232" y="66" width="176" height="94" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="448" y="66" width="176" height="94" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="664" y="66" width="140" height="94" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#uvs-arrow)">
    <line x1="192" y1="113" x2="230" y2="113"/>
    <line x1="408" y1="113" x2="446" y2="113"/>
    <line x1="624" y1="113" x2="662" y2="113"/>
  </g>
  <g text-anchor="middle" font-size="13" fill="#1f2937">
    <text x="104" y="107"><tspan x="104" dy="0">Textured mesh</tspan><tspan x="104" dy="16">UVs + materials</tspan></text>
    <text x="320" y="107"><tspan x="320" dy="0">Split per</tspan><tspan x="320" dy="16">material / island</tspan></text>
    <text x="536" y="107"><tspan x="536" dy="0">Decimate,</tspan><tspan x="536" dy="16">seams pinned</tspan></text>
    <text x="734" y="107"><tspan x="734" dy="0">Merge, atlas</tspan><tspan x="734" dy="16">intact</tspan></text>
  </g>
  <text x="410" y="210" text-anchor="middle" font-size="13" fill="#1f2937" font-weight="600">Seam and material-boundary vertices are locked so no collapse crosses them</text>
  <text x="410" y="232" text-anchor="middle" font-size="12" fill="#5b6471">EPSG:32618, local-origin shifted before simplification</text>
</svg>
<figcaption>Splitting on UV islands turns every seam into an open boundary, which a high boundary weight then pins in place through the collapse.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `open3d>=0.17`, `trimesh>=4.0`, `numpy>=1.24`: `pip install "open3d>=0.17" "trimesh>=4.0" "numpy>=1.24"`.
- The `meshoptimizer` `gltfpack` CLI (Node/npm or a prebuilt binary): `npm install -g gltfpack`, used for the attribute-aware [glTF](https://www.khronos.org/gltf/) path in step 4. Confirm with `gltfpack -h`.
- A textured mesh in `.glb`/`.obj` with per-vertex or per-corner UVs and one or more materials, in EPSG:32618. As with all decimation, shift to a local origin before simplifying so float32 precision survives; PLY/OBJ carry no CRS, so record EPSG:32618 in a sidecar.

## Step-by-Step

### 1. Detect seams and enumerate materials

Before touching geometry, confirm the mesh actually has seams and find its material boundaries. A reliable seam test is that a seamed mesh carries more UV coordinates than spatial vertices, because seam vertices are duplicated in UV space.

```python
import trimesh
import numpy as np

tm = trimesh.load("block_textured.glb", process=False)
# A Scene means multiple materials/geometries; a single Trimesh means one.
geoms = list(tm.geometry.values()) if isinstance(tm, trimesh.Scene) else [tm]

for name, g in (tm.geometry.items() if isinstance(tm, trimesh.Scene)
                else [("mesh", tm)]):
    uv = getattr(g.visual, "uv", None)
    has_seams = uv is not None and len(uv) > len(g.vertices)
    print(f"{name}: {len(g.faces):,} faces, "
          f"{'seamed' if has_seams else 'no seams'}, "
          f"material={type(g.visual).__name__}")
```

Each distinct material is decimated separately in step 3 — merging vertices across a material boundary is as damaging as crossing a UV seam, because the two sides index different textures.

### 2. Split the mesh on its UV islands

Splitting the mesh into connected UV islands converts every internal seam into an *open boundary* of a submesh. That is the trick that makes the rest work: the decimator already knows how to protect open boundaries, so once seams are boundaries, seam preservation is free.

```python
def split_uv_islands(g):
    """Return submeshes whose open boundaries are the original UV seams."""
    if getattr(g.visual, "uv", None) is None:
        return [g]
    # Group faces by UV connectivity so each group is one atlas island.
    islands = g.split(only_watertight=False)
    return [isl for isl in islands if len(isl.faces) > 0]

submeshes = []
for g in geoms:
    submeshes.extend(split_uv_islands(g))
print(f"{len(submeshes)} island/material submeshes to decimate")
```

### 3. Decimate each submesh with seam vertices locked

Convert each submesh to `open3d`, shift to a local origin, and run `simplify_quadric_decimation` with a high `boundary_weight`. Because the seams are now boundaries, the high weight pins them: no collapse can move a seam vertex, so the UV mapping on either side stays coherent.

```python
import open3d as o3d

def decimate_island(isl: "trimesh.Trimesh", keep_fraction=0.25):
    verts = np.asarray(isl.vertices, dtype=np.float64)
    origin = verts.mean(axis=0)                       # local origin, EPSG:32618
    mesh = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(verts - origin),
        o3d.utility.Vector3iVector(np.asarray(isl.faces)))
    mesh.compute_vertex_normals()

    target = max(4, int(len(isl.faces) * keep_fraction))
    simplified = mesh.simplify_quadric_decimation(
        target_number_of_triangles=target,
        boundary_weight=1000.0,      # pin seam/boundary loops hard
    )
    simplified.translate(origin)                      # restore true UTM position
    return simplified

decimated = [decimate_island(isl, keep_fraction=0.25) for isl in submeshes]
kept = sum(len(m.triangles) for m in decimated)
print(f"decimated to {kept:,} triangles across {len(decimated)} islands")
```

A `boundary_weight` of `1000` makes collapsing a seam edge astronomically expensive relative to an interior edge, so the solver exhausts every flat interior collapse first and only touches a seam if there is no alternative — which, at a 4× reduction, there always is.

### 4. Attribute-aware alternative: gltfpack simplification

When you would rather keep everything in one glTF and let a single tool handle seams, materials, and UVs together, `gltfpack` from the `meshoptimizer` project runs an attribute-aware simplifier that already understands UV seams and material groups. It is the fastest route for a web asset and pairs naturally with Draco or meshopt compression.

```python
import subprocess

def gltfpack_simplify(src_glb: str, out_glb: str, ratio: float = 0.25):
    # -si: simplify to a target ratio; -sa: aggressive; meshopt keeps UV/seam attrs.
    subprocess.run(
        ["gltfpack", "-i", src_glb, "-o", out_glb,
         "-si", str(ratio), "-sa", "-noq"],   # -noq: skip quantization for a plain compare
        check=True)

gltfpack_simplify("block_textured.glb", "block_lod1.glb", ratio=0.25)
```

`gltfpack` preserves seam and material-boundary vertices internally, so it is the pragmatic default; the `open3d` island route in steps 2–3 is what you reach for when you need explicit per-island control or the mesh is not glTF.

### 5. Reassemble and export

Merge the decimated islands back into one mesh (or scene), reattach the original material textures — the atlas image itself is untouched, only the geometry changed — and export a self-contained `.glb`.

```python
combined = o3d.geometry.TriangleMesh()
for m in decimated:
    combined += m
combined.compute_vertex_normals()
o3d.io.write_triangle_mesh("block_lod1_islands.glb", combined,
                           write_triangle_uvs=True)
print(f"wrote block_lod1_islands.glb, {len(combined.triangles):,} triangles")
```

## Expected Output & Verification

The decisive check is **UV area distortion**: the ratio of each triangle's area in UV space to its area on the mesh should stay roughly constant across an island. A collapse that crossed a seam spikes that ratio on the offending triangles, so a distortion histogram catches smearing that the eye would miss until the texture is applied.

```python
def uv_area_ratio(g: "trimesh.Trimesh"):
    tri3d = g.vertices[g.faces]                        # (F,3,3) metres, EPSG:32618
    a3 = np.linalg.norm(np.cross(tri3d[:, 1] - tri3d[:, 0],
                                 tri3d[:, 2] - tri3d[:, 0]), axis=1) / 2
    uv = g.visual.uv[g.faces]                          # (F,3,2)
    a2 = np.abs(np.cross(uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0])) / 2
    return a2 / np.clip(a3, 1e-9, None)

low = trimesh.load("block_lod1.glb", process=False)
low = list(low.geometry.values())[0] if isinstance(low, trimesh.Scene) else low
ratio = uv_area_ratio(low)
cv = ratio.std() / ratio.mean()
print(f"UV-area-ratio CV = {cv:.2f}  (seam tears push this up)")

seam_verts = len(low.visual.uv) - len(low.vertices)
assert seam_verts >= 0, "UVs desynced from vertices — export dropped seams"
assert cv < 0.6, f"UV distortion CV {cv:.2f} too high — seams were collapsed"
```

Sample console output for a facade block decimated 4×:

```text
block: 812,440 faces, seamed, material=TextureVisuals
5 island/material submeshes to decimate
decimated to 203,110 triangles across 5 islands
UV-area-ratio CV = 0.24  (seam tears push this up)
```

A coefficient of variation near the input's is the pass signal; a jump to 0.8 or higher means a seam was collapsed. Confirm the glTF is still valid and its accessors line up with `gltf-validator block_lod1.glb`, which reports the UV accessor count so you can check it did not desync from the position count.

## Common Errors

**Textures appear scrambled or swim after decimation.** `boundary_weight` was left at `0` (or the default), so `open3d` collapsed UV-seam edges like any interior edge. Set it high (100–1000) and split on UV islands first (steps 2–3) so seams are boundaries; re-verify the UV-area-ratio CV did not spike.

**`ValueError: UV array length does not match vertices` on export.** A collapse merged two vertices that carried different UVs, so the per-corner UV array no longer maps 1:1 to the geometry. This is the desync a crossed seam produces — decimate per island so no collapse spans a seam, and assert `len(visual.uv) >= len(vertices)` before writing.

**One material's texture bleeds onto another.** The mesh was decimated as a single object, so a collapse merged vertices across a material boundary. Enumerate materials in step 1 and decimate each material group separately, exactly as you do for UV islands — a material boundary is a hard seam even when the UVs look continuous.

## Related Guides

- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the full QEM decimation workflow this refines
- [Optimizing Mesh Triangle Count for Web Rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — triangle budgets and glTF export for the decimated tile
- [Baking Normal and AO Maps for Web Delivery](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/baking-normal-and-ao-maps-for-web-delivery/) — moving high-poly detail onto the decimated mesh as textures
- [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — how the atlas and UVs you are protecting were produced

Back to [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).
