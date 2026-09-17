# Generating UV Atlases with xatlas

This page generates a UV atlas for a mesh that has none — running xatlas to segment the surface into charts, parameterise each one and pack them into a texture, choosing the options that control seam count and distortion, sizing the atlas from a texel-density target rather than a round number, and auditing the result for distortion and wasted space.

## Why you hit this

A mesh from CityGML extrusion, from a planar simplification or from a boolean operation has no texture coordinates. Before it can carry a baked texture — from [projecting textures from oriented images](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/projecting-textures-from-oriented-images/), or a baked ambient-occlusion pass, or an analysis result as a property texture — it needs a parameterisation.

Doing it by hand in a modelling tool is not an option for 40,000 buildings. xatlas is the library the industry uses for this: it segments the mesh into charts with low distortion, parameterises each chart and packs them into a rectangle. The results depend heavily on two or three options, and the failure modes — visible seams, wasted atlas space, stretched texels — are all measurable.

## Prerequisites

- Python 3.10+ with `xatlas`, `numpy`, `trimesh`; `Pillow` for the atlas checks.
- A mesh with clean topology: no degenerate faces, no duplicate vertices. See [decimating meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/) for the cleaning.
- A texel-density target, in texels per metre.

## Step-by-Step

### 1. Clean the mesh, because xatlas will not

```python
import json
import math
from pathlib import Path

import numpy as np
import trimesh
import xatlas

def prepare_mesh(path, merge_tol=1e-5):
    mesh = trimesh.load(path, process=False, force="mesh")
    before = {"vertices": int(len(mesh.vertices)), "faces": int(len(mesh.faces))}

    mesh.merge_vertices(merge_tex=False, merge_norm=False)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()

    problems = []
    if not mesh.is_winding_consistent:
        problems.append("inconsistent winding — charts may be parameterised inside out")
    components = mesh.split(only_watertight=False)
    tiny = [c for c in components if len(c.faces) < 4]
    if tiny:
        problems.append(f"{len(tiny)} component(s) with fewer than 4 faces — "
                        f"each becomes its own chart")

    return mesh, {
        "before": before,
        "after": {"vertices": int(len(mesh.vertices)), "faces": int(len(mesh.faces))},
        "components": len(components),
        "problems": problems,
        "surface_area_m2": round(float(mesh.area), 2),
        "is_watertight": bool(mesh.is_watertight),
    }
```

xatlas assumes a valid mesh and produces strange charts from an invalid one. A degenerate face has no well-defined normal, so the chart segmentation puts it in its own chart; a duplicated vertex splits a chart along an edge that should be continuous, adding a seam where none is needed.

Counting components before parameterising is worth doing because each component becomes at least one chart, and a mesh with 2,000 tiny floating fragments produces 2,000 charts that consume atlas space and pack badly. Removing them first, as in the decimation cleaning pass, is the fix.

`merge_tex=False` matters: merging vertices that differ only in existing texture coordinates would destroy a parameterisation you might want to keep, and for a mesh with no UVs it is simply the safe default.

### 2. Size the atlas from a texel density

```python
def atlas_resolution(surface_area_m2, texels_per_m=64, utilisation=0.75,
                     max_dim=8192, min_dim=256):
    """Work out the texture dimension needed for a target texel density."""
    needed_texels = surface_area_m2 * (texels_per_m ** 2)
    with_padding = needed_texels / max(utilisation, 0.01)
    dim = 2 ** math.ceil(math.log2(math.sqrt(with_padding)))
    clamped = min(max(dim, min_dim), max_dim)
    achieved = math.sqrt(clamped ** 2 * utilisation / max(surface_area_m2, 1e-9))
    return {
        "surface_area_m2": round(surface_area_m2, 1),
        "requested_texels_per_m": texels_per_m,
        "ideal_dim": dim,
        "chosen_dim": clamped,
        "clamped": clamped != dim,
        "achieved_texels_per_m": round(achieved, 1),
        "texture_mb_rgba": round(clamped * clamped * 4 / 1e6, 2),
        "gpu_mb_with_mips": round(clamped * clamped * 4 * 1.333 / 1e6, 2),
    }

DENSITY_GUIDANCE = {
    "city_lod2_streaming": 32,
    "building_facade_viewer": 64,
    "inspection_detail": 256,
    "analysis_property_texture": 8,
}

for name, density in DENSITY_GUIDANCE.items():
    print(name, atlas_resolution(1200.0, texels_per_m=density))
```

Texels per metre is the parameter to think in, and the atlas dimension follows from it. A facade viewed from across a street resolves about 2 cm per screen pixel, so 50 texels per metre is the point of diminishing returns and 64 is a comfortable choice; 256 is four times the memory for detail nobody sees.

The 0.75 utilisation assumption accounts for packing waste and is realistic — xatlas typically achieves 0.6–0.85 depending on chart shapes. Computing the *achieved* density after clamping is what stops a silently under-textured result: a 1,200 m² building asking for 256 texels/m needs a 16,384 atlas, gets clamped to 8,192, and actually achieves 128.

The GPU figure with mipmaps is the number that matters for a city, as covered in [encoding property textures for per-texel data](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/encoding-property-textures-for-per-texel-data/) — a 4,096 atlas is 89 MB on the GPU as RGBA.

<figure class="diagram">
<svg viewBox="4 6 732 242" role="img" aria-labelledby="xatlas-density-t xatlas-density-d" xmlns="http://www.w3.org/2000/svg">
  <title id="xatlas-density-t">Texel density, atlas size and what it costs</title>
  <desc id="xatlas-density-d">A table for a 1200 square metre building surface at four texel densities. At 8 texels per metre the atlas is 512 pixels, 1 megabyte on the wire and 1.4 on the GPU, suitable for property textures. At 32 it is 2048 pixels, 16 megabytes and 22 on the GPU, suitable for city streaming. At 64 it is 4096 pixels, 67 megabytes and 89 on the GPU, suitable for a facade viewer. At 256 the ideal would be 16384 pixels but it clamps to 8192, achieving only 128 texels per metre.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="242" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="320" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="446" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="572" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="52" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="52" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="446" y="52" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="572" y="52" width="150" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="84" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="84" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="84" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="446" y="84" width="126" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="572" y="84" width="150" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="116" width="176" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="116" width="126" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="116" width="126" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="446" y="116" width="126" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="572" y="116" width="150" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="148" width="176" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="194" y="148" width="126" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="148" width="126" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="446" y="148" width="126" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="572" y="148" width="150" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="41">use</text><text x="257" y="41">texels/m</text>
    <text x="383" y="41">atlas dim</text><text x="509" y="41">GPU MB</text>
    <text x="647" y="41">achieved</text>
    <text x="106" y="73">property texture</text><text x="257" y="73">8</text>
    <text x="383" y="73">512</text><text x="509" y="73">1.4</text><text x="647" y="73">8</text>
    <text x="106" y="105">city streaming</text><text x="257" y="105">32</text>
    <text x="383" y="105">2048</text><text x="509" y="105">22.4</text><text x="647" y="105">32</text>
    <text x="106" y="137">facade viewer</text><text x="257" y="137">64</text>
    <text x="383" y="137">4096</text><text x="509" y="137">89.4</text><text x="647" y="137">64</text>
    <text x="106" y="169">inspection detail</text><text x="257" y="169">256</text>
    <text x="383" y="169">8192 (clamped)</text><text x="509" y="169">357.6</text>
    <text x="647" y="169">128 — short</text>
  </g>
  <text x="370" y="208" fill="#1f2937" font-size="12.5" text-anchor="middle">1,200 m² of surface; the clamped row silently delivers half the requested density</text>
  <text x="370" y="230" fill="#5b6471" font-size="12" text-anchor="middle">above 64 texels/m a single building needs several atlases, which is a per-chart split rather than a bigger texture</text>
</svg>
<figcaption>The clamped row is the trap: the request succeeds and delivers half the density, which nobody notices until the texture looks soft.</figcaption>
</figure>

### 3. Run xatlas with the options that matter

```python
def parameterise(mesh, resolution=4096, padding=4, texels_per_unit=0.0,
                 max_chart_area=0.0, max_boundary_length=0.0,
                 normal_deviation_weight=2.0, roundness_weight=0.01,
                 straightness_weight=6.0, normal_seam_weight=4.0,
                 texture_seam_weight=0.5, max_cost=2.0, max_iterations=1,
                 brute_force=False, block_align=True):
    atlas = xatlas.Atlas()
    atlas.add_mesh(np.asarray(mesh.vertices, dtype=np.float32),
                   np.asarray(mesh.faces, dtype=np.uint32))

    chart_options = xatlas.ChartOptions()
    chart_options.max_chart_area = max_chart_area
    chart_options.max_boundary_length = max_boundary_length
    chart_options.normal_deviation_weight = normal_deviation_weight
    chart_options.roundness_weight = roundness_weight
    chart_options.straightness_weight = straightness_weight
    chart_options.normal_seam_weight = normal_seam_weight
    chart_options.texture_seam_weight = texture_seam_weight
    chart_options.max_cost = max_cost
    chart_options.max_iterations = max_iterations

    pack_options = xatlas.PackOptions()
    pack_options.resolution = int(resolution)
    pack_options.padding = int(padding)
    pack_options.texels_per_unit = float(texels_per_unit)
    pack_options.bilinear = True
    pack_options.block_align = bool(block_align)
    pack_options.brute_force = bool(brute_force)
    pack_options.create_image = False

    atlas.generate(chart_options=chart_options, pack_options=pack_options)
    vmapping, indices, uvs = atlas[0]
    return {
        "vmapping": np.asarray(vmapping),
        "indices": np.asarray(indices),
        "uvs": np.asarray(uvs),
        "stats": {
            "charts": int(atlas.chart_count),
            "atlas_count": int(atlas.atlas_count),
            "width": int(atlas.width), "height": int(atlas.height),
            "utilisation": round(float(atlas.utilization[0]), 4)
            if atlas.atlas_count else 0.0,
            "texels_per_unit": round(float(atlas.texels_per_unit), 3),
            "vertices_before": int(len(mesh.vertices)),
            "vertices_after": int(len(vmapping)),
            "vertex_growth": round(len(vmapping) / max(len(mesh.vertices), 1), 3),
        },
    }
```

`max_cost` is the option with the largest effect on chart count. It caps the parameterisation distortion xatlas will tolerate before splitting a chart: at 2.0 a facade with a slight curve stays one chart with a little stretching, and at 1.05 it splits into several charts with almost none. More charts mean more seams and worse packing; higher distortion means stretched texels.

`normal_seam_weight` and `texture_seam_weight` control where xatlas prefers to put seams. Raising the normal-seam weight makes it cut along sharp creases, which is usually what you want on architecture — a seam at a building's corner is invisible, a seam in the middle of a wall is not.

`texels_per_unit` is the alternative to `resolution`: set it and xatlas chooses the atlas size to achieve that density, which is often more useful than fixing the dimension. Setting both means the resolution wins and the density is whatever fits.

Vertex growth is expected and worth watching. A parameterisation splits vertices along every seam, so a 10,000-vertex mesh typically becomes 12,000–18,000 — and a growth factor above about 2.0 means far too many charts.

### 4. Apply the parameterisation back to the mesh

```python
def apply_parameterisation(mesh, result):
    vmapping = result["vmapping"]
    indices = result["indices"]
    uvs = result["uvs"]

    new_vertices = np.asarray(mesh.vertices)[vmapping]
    new_mesh = trimesh.Trimesh(vertices=new_vertices,
                               faces=indices.reshape(-1, 3),
                               process=False)
    new_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs)

    # Face attributes survive because xatlas preserves face order.
    if hasattr(mesh.visual, "face_colors") and mesh.visual.face_colors is not None:
        new_mesh.visual.face_colors = mesh.visual.face_colors

    area_before = float(mesh.area)
    area_after = float(new_mesh.area)
    return new_mesh, {
        "vertices": int(len(new_mesh.vertices)),
        "faces": int(len(new_mesh.faces)),
        "faces_preserved": int(len(new_mesh.faces)) == int(len(mesh.faces)),
        "area_before_m2": round(area_before, 3),
        "area_after_m2": round(area_after, 3),
        "area_change_pct": round(100.0 * (area_after - area_before)
                                 / max(area_before, 1e-9), 4),
        "uv_range": [round(float(uvs.min()), 5), round(float(uvs.max()), 5)],
        "uvs_in_unit_square": bool(uvs.min() >= -1e-6 and uvs.max() <= 1.0 + 1e-6),
    }
```

xatlas preserves face order and face count, which is the property that lets face attributes — material assignments, per-face classifications, feature identifiers — carry through unchanged. Only the vertex array grows, and `vmapping` says which original vertex each new one came from, so vertex attributes carry through by indexing.

Surface area must be unchanged: parameterisation does not move vertices in 3D, only assigns them 2D coordinates. A non-zero `area_change_pct` means something other than xatlas modified the geometry.

UVs outside the unit square mean either multiple atlases were generated — `atlas_count > 1` — or the packing overflowed, and both need handling before the mesh is textured.

### 5. Audit the distortion

```python
def distortion_audit(mesh_with_uv, atlas_dim):
    """Per-triangle ratio of UV area to 3D area: how much each texel is stretched."""
    verts = np.asarray(mesh_with_uv.vertices)
    faces = np.asarray(mesh_with_uv.faces)
    uv = np.asarray(mesh_with_uv.visual.uv)

    tri3d = verts[faces]
    tri2d = uv[faces] * atlas_dim

    a3 = np.linalg.norm(np.cross(tri3d[:, 1] - tri3d[:, 0],
                                 tri3d[:, 2] - tri3d[:, 0]), axis=1) / 2.0
    e0 = tri2d[:, 1] - tri2d[:, 0]
    e1 = tri2d[:, 2] - tri2d[:, 0]
    a2 = np.abs(e0[:, 0] * e1[:, 1] - e0[:, 1] * e1[:, 0]) / 2.0

    valid = (a3 > 1e-12) & (a2 > 1e-12)
    texels_per_m2 = np.zeros(len(faces))
    texels_per_m2[valid] = a2[valid] / a3[valid]
    density = np.sqrt(np.maximum(texels_per_m2, 0.0))          # texels per metre

    # Anisotropy: how differently the two UV axes are scaled.
    l0 = np.linalg.norm(tri3d[:, 1] - tri3d[:, 0], axis=1)
    l1 = np.linalg.norm(tri3d[:, 2] - tri3d[:, 0], axis=1)
    u0 = np.linalg.norm(e0, axis=1)
    u1 = np.linalg.norm(e1, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        s0 = np.where(l0 > 1e-9, u0 / l0, np.nan)
        s1 = np.where(l1 > 1e-9, u1 / l1, np.nan)
        anisotropy = np.where(np.isfinite(s0) & np.isfinite(s1) & (s1 > 1e-9),
                              np.maximum(s0 / s1, s1 / s0), np.nan)

    d = density[valid]
    an = anisotropy[np.isfinite(anisotropy)]
    return {
        "faces": int(len(faces)),
        "faces_measured": int(valid.sum()),
        "texels_per_m": {
            "p05": round(float(np.percentile(d, 5)), 2),
            "p50": round(float(np.percentile(d, 50)), 2),
            "p95": round(float(np.percentile(d, 95)), 2),
            "ratio_p95_p05": round(float(np.percentile(d, 95)
                                         / max(np.percentile(d, 5), 1e-9)), 2),
        },
        "anisotropy": {
            "p50": round(float(np.percentile(an, 50)), 3),
            "p95": round(float(np.percentile(an, 95)), 3),
            "max": round(float(an.max()), 3),
            "faces_over_2x": int((an > 2.0).sum()),
        },
        "uniform": float(np.percentile(d, 95) / max(np.percentile(d, 5), 1e-9)) < 3.0,
        "verdict": "usable" if float(np.percentile(an, 95)) < 1.6
                   and float(np.percentile(d, 95)
                             / max(np.percentile(d, 5), 1e-9)) < 3.0
                   else "distorted — lower max_cost to split more charts",
    }
```

Two distortion measures matter and they are different. **Density variation** — the ratio between the 95th and 5th percentile texels per metre — says whether some parts of the surface get much more texture than others; a ratio above about 3 means a facade is sharp in one place and soft in another.

**Anisotropy** says whether individual texels are stretched: a value of 2 means a texel is twice as long in one direction as the other, which shows as directional blurring. Above 1.6 at the p95 is visible on architectural detail.

Both are fixed the same way — lower `max_cost` so xatlas splits charts rather than stretching them — at the cost of more seams and worse packing. The audit is what makes that trade a measurement rather than a guess.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="xatlas-audit-t xatlas-audit-d" xmlns="http://www.w3.org/2000/svg">
  <title id="xatlas-audit-t">The three audit numbers and their limits</title>
  <desc id="xatlas-audit-d">A table of three audit measurements for a UV atlas with their acceptable limits and the fix when exceeded. Atlas utilisation should be above 0.65 and is raised by allowing fewer, larger charts. Texel density variation between the 95th and 5th percentile should stay under three and is reduced by splitting charts. Anisotropy at the 95th percentile should stay under 1.6 and is also reduced by splitting charts.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="254" y="20" width="156" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="410" y="20" width="312" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="54" width="156" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="54" width="312" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="88" width="156" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="88" width="312" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="122" width="156" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="122" width="312" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="254" y="156" width="156" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="410" y="156" width="312" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="136" y="42">measurement</text><text x="332" y="42">acceptable</text><text x="566" y="42">fix if exceeded</text>
    <text x="136" y="76">atlas utilisation</text><text x="332" y="76">above 0.65</text><text x="566" y="76">raise max_cost — fewer charts</text>
    <text x="136" y="110">density ratio p95/p05</text><text x="332" y="110">under 3.0</text><text x="566" y="110">lower max_cost — more charts</text>
    <text x="136" y="144">anisotropy p95</text><text x="332" y="144">under 1.6</text><text x="566" y="144">lower max_cost — more charts</text>
    <text x="136" y="178">the trade</text><text x="332" y="178">—</text><text x="566" y="178">utilisation against distortion</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">The first pulls max_cost up and the other two pull it down; the usable band is narrow and findable.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Optimise for utilisation among the settings whose distortion is within tolerance.</text>
</svg>
<figcaption>Three numbers pulling in two directions, which is why the sweep finds the answer faster than intuition.</figcaption>
</figure>

### 6. Sweep the options and pick from the audit

```python
def option_sweep(mesh, resolution=4096, max_costs=(1.05, 1.5, 2.0, 4.0),
                 normal_seam_weights=(1.0, 4.0)):
    rows = []
    for cost in max_costs:
        for nsw in normal_seam_weights:
            result = parameterise(mesh, resolution=resolution, max_cost=cost,
                                  normal_seam_weight=nsw)
            uvmesh, applied = apply_parameterisation(mesh, result)
            audit = distortion_audit(uvmesh, resolution)
            rows.append({
                "max_cost": cost,
                "normal_seam_weight": nsw,
                "charts": result["stats"]["charts"],
                "utilisation": result["stats"]["utilisation"],
                "vertex_growth": result["stats"]["vertex_growth"],
                "density_ratio": audit["texels_per_m"]["ratio_p95_p05"],
                "anisotropy_p95": audit["anisotropy"]["p95"],
                "usable": audit["verdict"] == "usable",
            })
    usable = [r for r in rows if r["usable"]]
    best = max(usable, key=lambda r: r["utilisation"]) if usable else None
    return {"sweep": rows, "recommended": best,
            "reason": "highest atlas utilisation among the settings whose distortion "
                      "is within tolerance"}

def export_for_texturing(uvmesh, out_path, atlas_dim):
    uvmesh.export(out_path)
    return {"path": str(out_path),
            "atlas_dim": atlas_dim,
            "next_step": "bake a texture at this resolution; see the texture "
                         "projection guide",
            "bytes": Path(out_path).stat().st_size}
```

Optimising for **utilisation** among the settings that pass the distortion check is the right objective. Utilisation is wasted memory made measurable: an atlas at 0.45 utilisation is throwing away half its texels, so a 4,096 texture is delivering the coverage of a 2,896 one.

`brute_force=True` on the pack options improves utilisation by a few percent at a large cost in time, and is worth enabling for a hero asset and not for 40,000 buildings.

<figure class="diagram">
<svg viewBox="4 6 732 250" role="img" aria-labelledby="xatlas-sweep-t xatlas-sweep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="xatlas-sweep-t">max_cost against charts, utilisation and distortion</title>
  <desc id="xatlas-sweep-d">A table of four max_cost values on the same building mesh. At 1.05, xatlas produces 184 charts, atlas utilisation is 0.52, vertex growth 2.9 times and anisotropy 1.04, so distortion is minimal but packing is poor. At 1.5 there are 68 charts, utilisation 0.71, growth 1.7 and anisotropy 1.18, which is the recommendation. At 2.0 there are 34 charts, utilisation 0.79 and anisotropy 1.44. At 4.0 there are 11 charts, utilisation 0.84 but anisotropy 2.81, which is visibly stretched.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="250" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="20" width="110" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="246" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="376" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="506" y="20" width="118" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="624" y="20" width="98" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="136" y="52" width="110" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="246" y="52" width="130" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="376" y="52" width="130" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="506" y="52" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="624" y="52" width="98" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="86" width="118" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="136" y="86" width="110" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="246" y="86" width="130" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="376" y="86" width="130" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="506" y="86" width="118" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="624" y="86" width="98" height="38" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="18" y="124" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="136" y="124" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="246" y="124" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="376" y="124" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="506" y="124" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="624" y="124" width="98" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="158" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="136" y="158" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="246" y="158" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="376" y="158" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="506" y="158" width="118" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="624" y="158" width="98" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="77" y="41">max_cost</text><text x="191" y="41">charts</text>
    <text x="311" y="41">utilisation</text><text x="441" y="41">vertex growth</text>
    <text x="565" y="41">anisotropy p95</text><text x="673" y="41">verdict</text>
    <text x="77" y="74">1.05</text><text x="191" y="74">184</text>
    <text x="311" y="74">0.52</text><text x="441" y="74">2.9×</text>
    <text x="565" y="74">1.04</text><text x="673" y="74">wasteful</text>
    <text x="77" y="110">1.5</text><text x="191" y="110">68</text>
    <text x="311" y="110">0.71</text><text x="441" y="110">1.7×</text>
    <text x="565" y="110">1.18</text><text x="673" y="110">best</text>
    <text x="77" y="146">2.0</text><text x="191" y="146">34</text>
    <text x="311" y="146">0.79</text><text x="441" y="146">1.4×</text>
    <text x="565" y="146">1.44</text><text x="673" y="146">acceptable</text>
    <text x="77" y="180">4.0</text><text x="191" y="180">11</text>
    <text x="311" y="180">0.84</text><text x="441" y="180">1.1×</text>
    <text x="565" y="180">2.81</text><text x="673" y="180">stretched</text>
  </g>
  <text x="370" y="216" fill="#1f2937" font-size="12.5" text-anchor="middle">fewer charts pack better and distort more — the usable band is narrow and findable</text>
  <text x="370" y="238" fill="#5b6471" font-size="12" text-anchor="middle">1.05 wastes half the atlas on padding between 184 charts; 4.0 stretches texels almost threefold</text>
</svg>
<figcaption>Chart count trades directly against distortion; the audit turns the choice into a number rather than an opinion.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "before": {"vertices": 8412, "faces": 16804},
  "after": {"vertices": 8390, "faces": 16792},
  "components": 3, "problems": [],
  "surface_area_m2": 1204.82, "is_watertight": false
}
{'surface_area_m2': 1204.8, 'requested_texels_per_m': 64, 'ideal_dim': 4096,
 'chosen_dim': 4096, 'clamped': false, 'achieved_texels_per_m': 102.2,
 'texture_mb_rgba': 67.11, 'gpu_mb_with_mips': 89.46}
{
  "charts": 68, "atlas_count": 1, "width": 4096, "height": 4096,
  "utilisation": 0.7114, "texels_per_unit": 102.184,
  "vertices_before": 8390, "vertices_after": 14218, "vertex_growth": 1.695
}
{
  "vertices": 14218, "faces": 16792, "faces_preserved": true,
  "area_before_m2": 1204.82, "area_after_m2": 1204.82, "area_change_pct": 0.0,
  "uv_range": [0.00049, 0.99951], "uvs_in_unit_square": true
}
{
  "faces": 16792, "faces_measured": 16792,
  "texels_per_m": {"p05": 74.12, "p50": 101.84, "p95": 118.42, "ratio_p95_p05": 1.6},
  "anisotropy": {"p50": 1.041, "p95": 1.182, "max": 2.84, "faces_over_2x": 12},
  "uniform": true, "verdict": "usable"
}
```

Zero area change with faces preserved is the structural confirmation that the parameterisation did what it should: the geometry is untouched and only the vertex array grew, by 1.7× across 68 chart seams.

A 1.6 density ratio and a 1.18 p95 anisotropy is a good parameterisation. The 12 faces with anisotropy above 2 are the corners of charts and will not be noticed.

Verify the seams fall where they should, because an invisible seam and a visible one differ only in placement:

```python
def seam_placement_audit(original_mesh, uvmesh, result, crease_angle_deg=40.0):
    """Seams on sharp creases are invisible; seams across flat surfaces are not."""
    vmapping = result["vmapping"]
    # A vertex split by the parameterisation appears more than once in vmapping.
    counts = np.bincount(vmapping, minlength=len(original_mesh.vertices))
    split_vertices = np.flatnonzero(counts > 1)

    face_adjacency = original_mesh.face_adjacency
    angles = np.degrees(original_mesh.face_adjacency_angles)
    sharp_edges = original_mesh.face_adjacency_edges[angles >= crease_angle_deg]
    flat_edges = original_mesh.face_adjacency_edges[angles < crease_angle_deg]

    sharp_verts = set(np.unique(sharp_edges).tolist())
    flat_verts = set(np.unique(flat_edges).tolist()) - sharp_verts

    on_crease = sum(1 for v in split_vertices if int(v) in sharp_verts)
    on_flat = sum(1 for v in split_vertices if int(v) in flat_verts)
    return {
        "split_vertices": int(len(split_vertices)),
        "on_sharp_crease": on_crease,
        "on_flat_surface": on_flat,
        "crease_fraction": round(on_crease / max(len(split_vertices), 1), 3),
        "good_placement": on_crease / max(len(split_vertices), 1) > 0.7,
        "advice": "raise normal_seam_weight to pull seams onto creases"
                  if on_crease / max(len(split_vertices), 1) <= 0.7 else "seams are "
                  "mostly on creases, which is where they are least visible",
    }

print(json.dumps(seam_placement_audit(mesh, uvmesh, result), indent=2))
```

A crease fraction above 0.7 means most seams are on edges where a texture discontinuity is expected anyway — a building's corner, a roof ridge. Below that, seams are crossing flat walls, where a one-texel colour mismatch reads as a line, and raising `normal_seam_weight` is the fix.

Then verify the atlas packs without bleed at the resolution you intend to use:

```python
def padding_check(uvmesh, atlas_dim, padding_texels=4):
    """Charts closer than the padding will bleed into each other under bilinear filtering."""
    uv = np.asarray(uvmesh.visual.uv) * atlas_dim
    faces = np.asarray(uvmesh.faces)

    # Rasterise each triangle's bounding box into an occupancy grid at atlas resolution.
    grid = np.zeros((atlas_dim, atlas_dim), dtype=np.int32)
    tri = uv[faces]
    lo = np.floor(tri.min(axis=1)).astype(int)
    hi = np.ceil(tri.max(axis=1)).astype(int)
    for (x0, y0), (x1, y1) in zip(lo, hi):
        x0 = max(x0, 0); y0 = max(y0, 0)
        x1 = min(x1, atlas_dim); y1 = min(y1, atlas_dim)
        if x1 > x0 and y1 > y0:
            grid[y0:y1, x0:x1] += 1

    occupied = grid > 0
    from scipy import ndimage
    dilated = ndimage.binary_dilation(occupied, iterations=padding_texels)
    overlap_after_dilation = int((grid > 1).sum())

    return {
        "atlas_dim": atlas_dim,
        "occupied_texels": int(occupied.sum()),
        "utilisation_measured": round(float(occupied.mean()), 4),
        "texels_claimed_by_multiple_triangles": overlap_after_dilation,
        "padding_texels": padding_texels,
        "dilated_utilisation": round(float(dilated.mean()), 4),
        "bleed_risk": float(dilated.mean()) > 0.98,
        "note": "a dilated utilisation near 1.0 means charts are packed tighter than "
                "the filter footprint and will bleed",
    }
```

Measuring utilisation from the rasterised triangles rather than trusting xatlas's figure is a useful cross-check, and the dilation test is what predicts bleed: if growing every chart by the filter's footprint fills the atlas, neighbouring charts are within sampling distance of each other and colours will leak across seams at coarse mip levels.

## Performance Notes

- **xatlas runs at roughly 20,000–60,000 faces per second** for chart generation plus packing. A 17,000-face building is under a second; a 2-million-face mesh is a minute.
- **`brute_force=True` on packing is 5–20× slower** for a few percent of utilisation. Reserve it for hero assets.
- **`max_iterations` above 1 refines charts** at a proportional cost and rarely changes the audit numbers by much.
- **Parameterise per building, not per city tile.** A whole tile in one atlas gives poor per-building texel density and makes a single building's texture un-reusable.
- **The distortion audit is vectorised NumPy** and costs milliseconds; run it on every mesh.
- **Cache the parameterisation.** It depends only on the geometry, so a re-texture with new imagery reuses the same UVs.

## Common Errors

**Hundreds of charts on a simple mesh.** Degenerate faces or unmerged duplicate vertices. Clean first.

**UVs outside 0–1.** More than one atlas was generated. Either raise the resolution or handle `atlas_count > 1` by writing several textures.

**Visible lines across flat walls.** Seams placed badly. Raise `normal_seam_weight`.

**Texture looks soft in places and sharp in others.** Density variation. Lower `max_cost` so charts split instead of stretching.

**Directional blurring on facades.** Anisotropy. Same fix.

**Colour bleeding across seams at a distance.** Padding too small for the mip chain. Raise `padding`, or generate mips per chart.

**`atlas.utilization` is empty.** `atlas.generate()` was not called, or it produced no atlas because the mesh had no valid faces.

**Vertex count tripled.** Far too many charts; check the sweep.

## Frequently Asked Questions

### One atlas per building or one per tile?

Per building, for city data. A per-tile atlas makes the texel density depend on how much surface happens to be in the tile, and it prevents reusing a building's texture when the tiling changes.

### What padding should I use?

Four texels for a non-mipmapped atlas, and enough for the deepest mip level you intend to generate — which for a 4,096 atlas with a full chain is impractical, so per-chart mip generation or a dilation pass on the baked texture is the usual answer.

### Can I keep an existing partial parameterisation?

xatlas will re-parameterise everything it is given. To keep existing UVs on part of a mesh, split the mesh, parameterise only the part that needs it, and merge the atlases afterwards — which is more work than re-parameterising the whole thing.

## Related Guides

- [Projecting Textures from Oriented Images](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/projecting-textures-from-oriented-images/) — baking a texture into the atlas this produces
- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — remapping these UVs when meshes are combined
- [Encoding Property Textures for Per-Texel Data](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/encoding-property-textures-for-per-texel-data/) — the other consumer of a UV atlas

Back to [Texture Mapping Workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
