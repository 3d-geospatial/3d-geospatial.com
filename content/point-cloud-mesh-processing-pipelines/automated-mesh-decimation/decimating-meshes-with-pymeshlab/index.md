# Decimating Meshes with PyMeshLab

This page reduces a 12-million-triangle photogrammetric mesh to a usable size with PyMeshLab — choosing between the quadric collapse variants, setting the parameters that actually change the result, preserving boundaries and UV seams, cleaning the input first so the decimation has something sane to work with, and producing a quality report rather than a guess.

## Why you hit this

Photogrammetry and lidar meshing both produce far more triangles than any downstream use needs. A 12-million-triangle site mesh will not open in a browser, will not tile without a level-of-detail chain, and carries most of its detail in flat surfaces where it buys nothing — a car park is a plane described by 400,000 triangles.

PyMeshLab exposes MeshLab's filter set from Python, which makes it the practical choice when the decimation has to run in a pipeline rather than in a GUI. The quality of the result depends almost entirely on three things: cleaning the mesh first, choosing the texture-aware variant when there are UVs, and pinning the boundary when the mesh is one tile of many.

## Prerequisites

- Python 3.10+ with `pymeshlab>=2023.12` and `numpy`; `trimesh` for the independent checks.
- A mesh with faces and, for the textured path, UVs — the output of [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
- Enough RAM for roughly 200 bytes per input triangle: about 2.5 GB for 12 million.

## Step-by-Step

### 1. Load and report what you have

```python
import json
from pathlib import Path

import numpy as np
import pymeshlab as ml

def describe(path):
    ms = ml.MeshSet()
    ms.load_new_mesh(str(path))
    m = ms.current_mesh()
    ms.apply_filter("compute_topological_measures")
    measures = ms.get_geometric_measures()
    return {
        "file": Path(path).name,
        "vertices": m.vertex_number(),
        "faces": m.face_number(),
        "has_uvs": m.has_wedge_tex_coord() or m.has_vertex_tex_coord(),
        "has_vertex_colour": m.has_vertex_color(),
        "bbox_m": [round(v, 2) for v in (measures["bbox"].max()
                                         - measures["bbox"].min())],
        "surface_area_m2": round(measures.get("surface_area", 0.0), 1),
        "avg_edge_m": round(measures.get("avg_edge_length", 0.0), 4),
    }

info = describe("input/site_mesh.ply")
print(json.dumps(info, indent=2))
print("triangles per m²:", round(info["faces"] / max(info["surface_area_m2"], 1), 1))
```

Triangles per square metre is the number that says how much reduction is available. A photogrammetric mesh at 400 triangles/m² has roughly 5 cm triangles, which is finer than most site documentation needs; reducing to 25/m² — 20 cm triangles — is a 16× reduction that is invisible at a normal viewing distance.

Whether the mesh carries **wedge** or **vertex** texture coordinates changes which filter to use, and the distinction matters: wedge UVs allow a vertex to have different coordinates per face, which is how texture seams are represented. A mesh with wedge UVs decimated by a vertex-UV-aware filter loses its seams.

### 2. Clean before decimating

```python
def clean(ms, merge_threshold_ratio=0.0001, remove_small_components_ratio=0.001):
    """Decimation on a dirty mesh produces dirty results. This is not optional."""
    before = {"v": ms.current_mesh().vertex_number(), "f": ms.current_mesh().face_number()}
    steps = []

    ms.apply_filter("meshing_remove_duplicate_vertices")
    steps.append(("duplicate_vertices", ms.current_mesh().vertex_number()))

    ms.apply_filter("meshing_remove_duplicate_faces")
    steps.append(("duplicate_faces", ms.current_mesh().face_number()))

    ms.apply_filter("meshing_remove_null_faces")
    steps.append(("null_faces", ms.current_mesh().face_number()))

    ms.apply_filter("meshing_remove_unreferenced_vertices")
    steps.append(("unreferenced_vertices", ms.current_mesh().vertex_number()))

    ms.apply_filter("meshing_merge_close_vertices",
                    threshold=ml.PercentageValue(merge_threshold_ratio * 100))
    steps.append(("merge_close", ms.current_mesh().vertex_number()))

    ms.apply_filter("meshing_remove_connected_component_by_diameter",
                    mincomponentdiag=ml.PercentageValue(
                        remove_small_components_ratio * 100),
                    removeunref=True)
    steps.append(("small_components", ms.current_mesh().face_number()))

    after = {"v": ms.current_mesh().vertex_number(), "f": ms.current_mesh().face_number()}
    return {"before": before, "after": after, "steps": steps,
            "removed_faces": before["f"] - after["f"],
            "removed_vertices": before["v"] - after["v"]}
```

Duplicate and degenerate faces are what make quadric decimation produce spikes. The quadric error metric assumes a well-formed neighbourhood; a zero-area face has an undefined normal, so the quadric it contributes is garbage, and the collapse it permits moves a vertex somewhere arbitrary. One spike in a 100,000-triangle result is enough for someone to reject the whole mesh.

Removing small disconnected components matters for a different reason: photogrammetry produces thousands of floating fragments — birds, reflections, moving cars — each a few dozen triangles. They survive decimation because they have no edges worth collapsing, so a mesh reduced to 100,000 triangles can have 20,000 of them in floating debris.

`PercentageValue` is the PyMeshLab wrapper for parameters MeshLab expresses as a percentage of the bounding-box diagonal, and passing a bare float where one is expected is the most common API error with this library.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="pml-clean-t pml-clean-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pml-clean-t">What cleaning removes, and why decimation needs it</title>
  <desc id="pml-clean-d">A table of five cleaning steps on a 12 million triangle photogrammetric mesh. Duplicate vertices removes 41000 vertices. Duplicate and null faces removes 2800 faces. Merging close vertices removes 18400 vertices and closes cracks. Removing small components removes 214000 faces in 9100 floating fragments. Each row states what goes wrong in decimation if the step is skipped.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="226" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="244" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="408" y="20" width="314" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="226" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="244" y="52" width="164" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="408" y="52" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="226" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="244" y="86" width="164" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="408" y="86" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="120" width="226" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="244" y="120" width="164" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="408" y="120" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="154" width="226" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="244" y="154" width="164" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="408" y="154" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="131" y="41">cleaning step</text><text x="326" y="41">removed</text>
    <text x="565" y="41">if skipped</text>
    <text x="131" y="74">duplicate vertices</text><text x="326" y="74">41,000 verts</text>
    <text x="565" y="74">cracks reopen during collapse</text>
    <text x="131" y="108">duplicate + null faces</text><text x="326" y="108">2,800 faces</text>
    <text x="565" y="108">undefined normals → spikes</text>
    <text x="131" y="142">merge close vertices</text><text x="326" y="142">18,400 verts</text>
    <text x="565" y="142">seams stay open, holes appear</text>
    <text x="131" y="176">small components</text><text x="326" y="176">214,000 faces</text>
    <text x="565" y="176">9,100 fragments survive intact</text>
  </g>
  <text x="370" y="216" fill="#1f2937" font-size="12.5" text-anchor="middle">cleaning removes 2.3% of the faces and accounts for most of the visible quality difference</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">the floating fragments are 2% of the input and would be 20% of a 100k-triangle output</text>
</svg>
<figcaption>Small components are the step people skip, and they end up as a fifth of an aggressively decimated result.</figcaption>
</figure>

### 3. Choose the right collapse filter

```python
FILTERS = {
    "plain": "meshing_decimation_quadric_edge_collapse",
    "textured": "meshing_decimation_quadric_edge_collapse_with_texture",
    "clustering": "meshing_decimation_clustering",
}

def pick_filter(ms):
    m = ms.current_mesh()
    if m.has_wedge_tex_coord() or m.has_vertex_tex_coord():
        return FILTERS["textured"], "mesh has UVs; texture-aware collapse preserves seams"
    if m.face_number() > 20_000_000:
        return FILTERS["clustering"], "too large for quadric; cluster first, then quadric"
    return FILTERS["plain"], "no UVs; plain quadric collapse"

def decimate(ms, target_faces, preserve_boundary=True, preserve_normal=True,
             planar_quadric=True, quality_threshold=0.3, boundary_weight=1.0):
    filter_name, reason = pick_filter(ms)
    before = ms.current_mesh().face_number()
    params = dict(
        targetfacenum=int(target_faces),
        preserveboundary=preserve_boundary,
        boundaryweight=float(boundary_weight),
        preservenormal=preserve_normal,
        optimalplacement=True,
        planarquadric=planar_quadric,
        qualitythr=float(quality_threshold),
        autoclean=True,
    )
    if filter_name == FILTERS["plain"]:
        params["preservetopology"] = False
        params["qualityweight"] = False
    ms.apply_filter(filter_name, **params)
    after = ms.current_mesh().face_number()
    return {"filter": filter_name, "reason": reason, "before": before, "after": after,
            "ratio": round(after / max(before, 1), 4),
            "hit_target": abs(after - target_faces) / max(target_faces, 1) < 0.05}
```

`planarquadric=True` is the parameter with the largest effect on a site mesh and the one most often left off. It adds an extra quadric term that resists collapsing across planar regions in a way that would move their boundary — so a car park collapses to a few large triangles that still have straight edges, rather than to a few large triangles with wobbly edges.

`qualitythr` controls how bad an aspect ratio the filter will accept in a resulting triangle. The default of 0.3 is reasonable; raising it towards 1.0 refuses slivers and stops short of the target face count, lowering it towards 0 hits the target with needle triangles that shade badly and break later processing.

`preserveboundary` with `boundaryweight` is the tile-mesh requirement. The weight multiplies the cost of collapsing a boundary edge, so a high value effectively pins the outline; 1.0 with `preserveboundary=True` pins it outright, which is what neighbouring tiles need.

### 4. Decimate in stages for large reductions

```python
def staged_decimate(in_path, out_path, target_faces, stages=None,
                    preserve_boundary=True):
    """Large reductions in one step produce worse results than two or three."""
    ms = ml.MeshSet()
    ms.load_new_mesh(str(in_path))
    clean_report = clean(ms)
    start = ms.current_mesh().face_number()

    ratio = target_faces / max(start, 1)
    if stages is None:
        stages = 1 if ratio > 0.25 else 2 if ratio > 0.04 else 3

    history = []
    for s in range(stages):
        step_target = int(start * (ratio ** ((s + 1) / stages)))
        step_target = max(step_target, target_faces, 4)
        report = decimate(ms, step_target, preserve_boundary=preserve_boundary)
        history.append({"stage": s + 1, "target": step_target, **report})

    ms.apply_filter("meshing_remove_unreferenced_vertices")
    ms.save_current_mesh(str(out_path), save_textures=False)
    return {"clean": clean_report, "stages": history,
            "final_faces": ms.current_mesh().face_number(),
            "final_vertices": ms.current_mesh().vertex_number()}
```

Staging a 100× reduction as three 4.6× steps gives a visibly better result than one 100× step, because the quadric error accumulated at each vertex is re-derived from the current mesh at the start of each stage rather than being propagated through a single long collapse sequence. It costs about 40% more time.

Below about a 4× reduction there is no benefit to staging, and above about 25× there is a clear one, which is what the ratio thresholds encode.

### 5. Simplify the flat parts harder than the detailed parts

```python
def curvature_weighted_decimate(in_path, out_path, target_faces,
                                curvature_percentile=75):
    """Give flat regions a lower cost so detail survives where it matters."""
    ms = ml.MeshSet()
    ms.load_new_mesh(str(in_path))
    clean(ms)

    ms.apply_filter("compute_curvature_principal_directions_per_vertex",
                    method="Quadric Fitting", curvcolormethod="Mean Curvature")
    ms.apply_filter("compute_scalar_by_function_per_vertex", q="abs(q)")

    ms.apply_filter("meshing_decimation_quadric_edge_collapse",
                    targetfacenum=int(target_faces),
                    qualityweight=True,          # use the per-vertex quality as a weight
                    preserveboundary=True,
                    preservenormal=True,
                    planarquadric=True,
                    optimalplacement=True,
                    qualitythr=0.3)
    ms.save_current_mesh(str(out_path), save_textures=False)
    return {"faces": ms.current_mesh().face_number(),
            "vertices": ms.current_mesh().vertex_number(),
            "weighted_by": "absolute mean curvature"}
```

`qualityweight=True` makes the collapse cost proportional to the per-vertex quality field, which the two preceding filters have set to absolute mean curvature. The effect is that a flat wall collapses freely while a cornice, a railing or a kerb keeps its triangles — which is usually what a site mesh should look like after reduction.

The cost is one extra pass over the mesh to compute curvature, roughly 20% of the decimation time, and a result that is harder to predict: the face count still hits the target, but where the triangles end up depends on the geometry rather than on a uniform rule.

<figure class="diagram">
<svg viewBox="4 6 732 210" role="img" aria-labelledby="pml-filters-t pml-filters-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pml-filters-t">Which PyMeshLab decimation filter to use</title>
  <desc id="pml-filters-d">A table of three decimation filters. The texture-aware quadric collapse is required whenever the mesh has UVs, because the plain filter collapses edges along texture seams. The plain quadric collapse suits meshes with no UVs. Clustering decimation is far faster and much lower quality, and is the right first stage above about twenty million triangles before a quadric pass.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="210" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="272" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="290" y="20" width="222" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="512" y="20" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="272" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="54" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="512" y="54" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="272" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="88" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="512" y="88" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="272" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="290" y="122" width="222" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="512" y="122" width="210" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="154" y="42">filter</text><text x="401" y="42">use when</text><text x="617" y="42">cost</text>
    <text x="154" y="76">quadric collapse with texture</text><text x="401" y="76">the mesh has UVs</text><text x="617" y="76">1.6× the plain filter</text>
    <text x="154" y="110">quadric edge collapse</text><text x="401" y="110">no UVs present</text><text x="617" y="110">1–2 M triangles per second</text>
    <text x="154" y="144">clustering decimation</text><text x="401" y="144">above ~20 M triangles</text><text x="617" y="144">fast, much lower quality</text>
  </g>
  <text x="20" y="176" fill="#1f2937" font-size="12.5">The texture-aware variant is not optional on a textured mesh; the plain one smears facades.</text>
  <text x="20" y="198" fill="#5b6471" font-size="12">Clustering is a first stage, not a final answer — follow it with a quadric pass.</text>
</svg>
<figcaption>Three filters, and the texture-aware one is mandatory rather than preferable on anything with UVs.</figcaption>
</figure>

### 6. Report quality, do not assume it

```python
def quality_report(original_path, decimated_path, samples=50_000):
    import trimesh
    from scipy.spatial import cKDTree

    a = trimesh.load(original_path, process=False, force="mesh")
    b = trimesh.load(decimated_path, process=False, force="mesh")

    rng = np.random.default_rng(3)
    idx = rng.choice(len(a.vertices), size=min(samples, len(a.vertices)), replace=False)
    pts = np.asarray(a.vertices)[idx]
    closest, distance, _ = b.nearest.on_surface(pts)

    aspect = triangle_aspect_ratios(b)
    return {
        "faces": {"before": len(a.faces), "after": len(b.faces),
                  "ratio": round(len(b.faces) / len(a.faces), 4)},
        "deviation_m": {
            "mean": round(float(distance.mean()), 4),
            "p95": round(float(np.percentile(distance, 95)), 4),
            "max": round(float(distance.max()), 4),
        },
        "volume_change_pct": round(100.0 * (b.volume - a.volume) / max(abs(a.volume), 1e-9), 3)
            if a.is_watertight and b.is_watertight else None,
        "area_change_pct": round(100.0 * (b.area - a.area) / a.area, 3),
        "worst_aspect_ratio": round(float(aspect.max()), 1),
        "slivers_over_20": int((aspect > 20).sum()),
        "components": int(b.body_count),
        "watertight": bool(b.is_watertight),
    }

def triangle_aspect_ratios(mesh):
    tri = mesh.vertices[mesh.faces]
    e0 = np.linalg.norm(tri[:, 1] - tri[:, 0], axis=1)
    e1 = np.linalg.norm(tri[:, 2] - tri[:, 1], axis=1)
    e2 = np.linalg.norm(tri[:, 0] - tri[:, 2], axis=1)
    longest = np.maximum.reduce([e0, e1, e2])
    s = (e0 + e1 + e2) / 2.0
    area = np.sqrt(np.maximum(s * (s - e0) * (s - e1) * (s - e2), 1e-24))
    inradius = area / np.maximum(s, 1e-12)
    return longest / np.maximum(inradius * 2.0, 1e-12)

print(json.dumps(quality_report("input/site_mesh.ply", "output/site_100k.ply"), indent=2))
```

The deviation p95 and the sliver count are the two numbers that decide whether a decimation is acceptable. A p95 deviation below the survey tolerance means the mesh is still true to the site; a sliver count above a few hundred means the result will shade badly and may break texture projection or a later boolean operation.

Reporting `area_change_pct` catches a specific failure the deviation does not: a decimation that removed a whole feature — a canopy, a wall — has a small deviation almost everywhere and a noticeably smaller surface area.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="pml-params-t pml-params-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pml-params-t">Parameter effect on a 12 M to 100 k reduction</title>
  <desc id="pml-params-d">Four parameter settings compared on the same reduction. Defaults with no cleaning give a p95 deviation of 34 centimetres, 4100 slivers and 9100 floating fragments. Cleaning first gives 21 centimetres, 3800 slivers and no fragments. Adding planar quadric gives 11 centimetres and 900 slivers. Adding curvature weighting gives 7 centimetres and 600 slivers, with detail preserved on kerbs and railings.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="248" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="416" y="20" width="140" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="556" y="20" width="166" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="248" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="266" y="52" width="150" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="416" y="52" width="140" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="556" y="52" width="166" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="248" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="266" y="86" width="150" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="416" y="86" width="140" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="556" y="86" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="120" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="120" width="150" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="416" y="120" width="140" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="120" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="248" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="266" y="154" width="150" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="416" y="154" width="140" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="154" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="142" y="41">settings</text><text x="341" y="41">p95 deviation</text>
    <text x="486" y="41">slivers</text><text x="639" y="41">fragments left</text>
    <text x="142" y="74">defaults, no cleaning</text><text x="341" y="74">34 cm</text>
    <text x="486" y="74">4,100</text><text x="639" y="74">9,100</text>
    <text x="142" y="108">+ cleaning pass</text><text x="341" y="108">21 cm</text>
    <text x="486" y="108">3,800</text><text x="639" y="108">0</text>
    <text x="142" y="142">+ planarquadric</text><text x="341" y="142">11 cm</text>
    <text x="486" y="142">900</text><text x="639" y="142">0</text>
    <text x="142" y="176">+ curvature weighting</text><text x="341" y="176">7 cm</text>
    <text x="486" y="176">600</text><text x="639" y="176">0</text>
  </g>
  <text x="370" y="212" fill="#1f2937" font-size="12.5" text-anchor="middle">same input, same 100,000-triangle target — a 5× difference in deviation from three parameters</text>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">cleaning and planarquadric together account for most of it</text>
</svg>
<figcaption>Identical face count, five times the accuracy: the parameters matter more than the target.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "file": "site_mesh.ply",
  "vertices": 6104882,
  "faces": 12208401,
  "has_uvs": true,
  "has_vertex_colour": false,
  "bbox_m": [1840.44, 1622.1, 96.73],
  "surface_area_m2": 3184402.1,
  "avg_edge_m": 0.0512
}
triangles per m²: 3.8
{
  "clean": {"removed_faces": 216804, "removed_vertices": 59412, …},
  "stages": [
    {"stage": 1, "target": 2551218, "after": 2551204, "ratio": 0.2127, "hit_target": true},
    {"stage": 2, "target": 533012, "after": 533008, "ratio": 0.2089, "hit_target": true},
    {"stage": 3, "target": 100000, "after": 100000, "ratio": 0.1876, "hit_target": true}
  ],
  "final_faces": 100000,
  "final_vertices": 50841
}
{
  "faces": {"before": 12208401, "after": 100000, "ratio": 0.0082},
  "deviation_m": {"mean": 0.0181, "p95": 0.0702, "max": 0.4914},
  "volume_change_pct": null,
  "area_change_pct": -0.412,
  "worst_aspect_ratio": 18.4,
  "slivers_over_20": 0,
  "components": 1,
  "watertight": false
}
```

A 122× reduction with a 7 cm p95 deviation and no slivers is a good result for a photogrammetric site mesh. The 0.41% area loss is the expected consequence of smoothing fine texture into flat triangles; a figure above a few percent would indicate a lost feature.

`watertight: false` and `volume_change_pct: null` are both normal for an open surface mesh — a site mesh is a height field, not a closed solid, so volume is undefined.

Verify the boundary survived, which is the property a tiled workflow depends on:

```python
def boundary_check(original_path, decimated_path, tol_m=0.01):
    import trimesh
    a = trimesh.load(original_path, process=False, force="mesh")
    b = trimesh.load(decimated_path, process=False, force="mesh")

    def boundary_vertices(mesh):
        edges = mesh.edges_sorted
        unique, counts = np.unique(edges, axis=0, return_counts=True)
        border = unique[counts == 1]
        return np.unique(border.ravel())

    va = np.asarray(a.vertices)[boundary_vertices(a)]
    vb = np.asarray(b.vertices)[boundary_vertices(b)]
    if len(va) == 0:
        return {"has_boundary": False, "note": "closed mesh; nothing to preserve"}
    from scipy.spatial import cKDTree
    d_to_b, _ = cKDTree(vb).query(va, k=1) if len(vb) else (np.full(len(va), np.inf), None)
    return {
        "has_boundary": True,
        "boundary_vertices_before": int(len(va)),
        "boundary_vertices_after": int(len(vb)),
        "max_boundary_shift_m": round(float(d_to_b.max()), 4),
        "p95_boundary_shift_m": round(float(np.percentile(d_to_b, 95)), 4),
        "preserved": bool(d_to_b.max() <= tol_m),
    }

print(boundary_check("input/site_mesh.ply", "output/site_100k.ply"))
```

The boundary vertex count will fall — collinear boundary vertices are legitimately removable — but the maximum shift must stay at or near zero. A shift of centimetres means `preserveboundary` did not take effect, and the tiles will not meet.

Then verify nothing was silently lost, by comparing coverage on a grid:

```python
def coverage_check(original_path, decimated_path, cell_m=5.0):
    """Cells with geometry before and none after are lost features."""
    import trimesh
    a = trimesh.load(original_path, process=False, force="mesh")
    b = trimesh.load(decimated_path, process=False, force="mesh")

    def occupancy(mesh):
        c = mesh.triangles_center
        i = np.floor(c[:, 0] / cell_m).astype(np.int64)
        j = np.floor(c[:, 1] / cell_m).astype(np.int64)
        return set(map(tuple, np.column_stack([i, j])))

    oa, ob = occupancy(a), occupancy(b)
    lost = oa - ob
    return {"cells_before": len(oa), "cells_after": len(ob),
            "cells_lost": len(lost), "lost_area_m2": len(lost) * cell_m ** 2,
            "lost_fraction": round(len(lost) / max(len(oa), 1), 4),
            "examples": sorted(lost)[:5]}
```

A handful of lost cells at the mesh's edge is rounding; a cluster of lost cells in the middle is a removed feature, and it is worth looking at before the mesh goes downstream.

## Performance Notes

- **Quadric collapse runs at roughly 1–2 million triangles per second** on one core for the plain filter, about half that for the texture-aware variant. 12 million triangles is 10–25 seconds per stage.
- **PyMeshLab is single-threaded per `MeshSet`.** Parallelise across meshes or tiles, not within one.
- **Memory is about 200 bytes per input triangle.** A 40-million-triangle mesh needs 8 GB and will swap on a 16 GB machine once the OS and Python are accounted for.
- **`meshing_decimation_clustering` is the escape hatch** above about 20 million triangles: it is far faster, much lower quality, and a reasonable first stage before a quadric pass.
- **Staging costs 40% more time for a visibly better result** above about 25× reduction.
- **Curvature computation adds roughly 20%** and is worth it on meshes with a mix of flat and detailed regions.

## Common Errors

**`TypeError: expected PercentageValue`.** MeshLab percentage parameters need `ml.PercentageValue(x)`, not a float.

**Spikes in the output.** Degenerate faces in the input. Run the cleaning pass.

**Texture smears across surfaces.** The plain filter was used on a mesh with UVs. Use the texture-aware variant.

**Cracks between neighbouring tiles.** `preserveboundary` off, or the mesh was merged with its neighbours before decimation so the shared edge was not a boundary.

**Target face count not reached.** `qualitythr` too high, so the filter refuses the remaining collapses. Lower it, or accept the count.

**Filter name not found.** PyMeshLab renamed most filters in 2022; `simplification_quadric_edge_collapse_decimation` is now `meshing_decimation_quadric_edge_collapse`. Print `ml.filter_list()` to check against your version.

**The result has 20,000 tiny components.** Small components were not removed before decimation, and they do not decimate.

## Frequently Asked Questions

### PyMeshLab or meshoptimizer?

`meshoptimizer` is an order of magnitude faster and integrates with glTF directly, which makes it right inside a tiling loop — see [generating LOD chains with meshoptimizer](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/generating-lod-chains-with-meshoptimizer/). PyMeshLab has the cleaning filters, curvature weighting and the texture-aware collapse, which makes it right for preparing a mesh before that loop.

### Should I decimate before or after texturing?

Before, if the texture is projected from images afterwards — a coarser mesh needs fewer texels. After, if the mesh already has a baked atlas you want to keep, in which case the texture-aware filter is mandatory.

### How much reduction is safe?

Judge it by deviation against the survey tolerance, not by ratio. A 100× reduction on a 3 triangle/m² mesh is usually fine; a 4× reduction on an already sparse mesh may not be.

## Related Guides

- [Measuring Hausdorff Distance After Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/measuring-hausdorff-distance-after-decimation/) — the rigorous version of the deviation check
- [Planar Region Simplification for Facades](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/planar-region-simplification-for-facades/) — a structure-aware alternative for buildings
- [Generating LOD Chains with meshoptimizer](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/generating-lod-chains-with-meshoptimizer/) — decimation inside the tiling loop

Back to [Automated Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).
