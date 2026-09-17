# Simplifying IFC Geometry for Web Tiles

This page reduces an IFC building model to geometry a browser can stream — filtering the element types a twin needs, dropping parts too small to see, merging by material to cut draw calls, instancing repeated components, and decimating what remains without rounding off the flat surfaces that make a building look like a building.

## Why you hit this

A detailed IFC model of one hospital block triangulates to 40–80 million triangles, thousands of materials and tens of thousands of separate meshes. That is a reasonable representation of a construction project and an unreasonable one for a twin, where the same building shares a scene with a city and a budget of a few hundred thousand triangles. Getting from one to the other by "decimating" alone fails: the model's problem is not triangle density but part count, and a quadric simplifier applied to 41,882 separate meshes produces 41,882 rounded blobs. The property side of the same export is in [extracting IFC properties into tile metadata](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/extracting-ifc-properties-into-tile-metadata/).

## Prerequisites

- Python 3.10+ with `ifcopenshell>=0.8`, `numpy>=1.24`, `open3d>=0.18` and `trimesh>=4.0`.
- The model already placed in a real CRS, as in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
- A triangle and draw-call budget for the tile: a few hundred thousand triangles and under about a hundred draw calls per tile is a workable target for a building in a city scene.

## Step-by-Step

### 1. Measure where the triangles are

```python
import multiprocessing
from collections import defaultdict

import ifcopenshell
import ifcopenshell.geom
import numpy as np

model = ifcopenshell.open("clinic_block_c.ifc")
settings = ifcopenshell.geom.settings()
settings.set("use-world-coords", True)

def survey(model, settings):
    stats = defaultdict(lambda: {"count": 0, "triangles": 0, "volume": 0.0})
    it = ifcopenshell.geom.iterator(settings, model, multiprocessing.cpu_count())
    if it.initialize():
        while True:
            shape = it.get()
            v = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
            f = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
            ifc_type = model.by_guid(shape.guid).is_a()
            s = stats[ifc_type]
            s["count"] += 1
            s["triangles"] += len(f)
            s["volume"] += float(np.prod(v.max(axis=0) - v.min(axis=0)))
            if not it.next():
                break
    return stats

stats = survey(model, settings)
total = sum(s["triangles"] for s in stats.values())
for t, s in sorted(stats.items(), key=lambda kv: -kv[1]["triangles"])[:10]:
    print(f"{t:<28}{s['count']:>7,} parts {s['triangles']:>10,} tris "
          f"{100 * s['triangles'] / total:5.1f}%")
print(f"total {total:,} triangles across {sum(s['count'] for s in stats.values()):,} parts")
```

The survey almost always produces the same shape of answer: pipes, fittings, cable trays, fixings and furniture hold most of the triangles and none of the visual value, while walls, slabs, roofs and curtain walls hold the building's appearance in a fraction of the geometry. Deciding what to keep is a content decision informed by that table, not a compression problem.

<figure class="diagram">
<svg viewBox="10 20 675 226" role="img" aria-labelledby="ifcsimp-share-t ifcsimp-share-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcsimp-share-t">Where a detailed BIM model's triangles live</title>
  <desc id="ifcsimp-share-d">Bars of triangle share by element class for a hospital block. Distribution elements such as pipes and ducts hold about forty percent, fittings and accessories about eighteen, furnishing about twelve, while walls, slabs, roofs and curtain walls together hold about twenty percent and carry nearly all of the visible form.</desc>
  <rect class="svg-bg" x="10" y="20" width="675" height="226" fill="#ffffff"/>
  <path d="M190 24 V200" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="190" y="34" width="420" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="190" y="66" width="190" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="190" y="98" width="126" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="190" y="130" width="105" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="190" y="162" width="84" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="24" y="52">distribution (pipes)</text>
    <text x="24" y="84">fittings, accessories</text>
    <text x="24" y="116">furnishing</text>
    <text x="24" y="148">walls, curtain walls</text>
    <text x="24" y="180">slabs, roofs, stairs</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="622" y="52">40%</text><text x="392" y="84">18%</text><text x="328" y="116">12%</text>
    <text x="307" y="148">10%</text><text x="286" y="180">8%</text>
  </g>
  <text x="400" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">The last two rows are what a city twin shows; the first three are what makes it unstreamable.</text>
</svg>
<figcaption>Filtering by element class removes most of the geometry before any simplification algorithm runs, and loses nothing a twin displays.</figcaption>
</figure>

### 2. Filter by class, then by size

```python
KEEP_TYPES = (
    "IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcSlab", "IfcRoof",
    "IfcColumn", "IfcBeam", "IfcStair", "IfcRamp", "IfcWindow", "IfcDoor",
    "IfcPlate", "IfcMember", "IfcRailing", "IfcCovering",
)
MIN_BBOX_DIAGONAL_M = 0.30          # below this, nothing is visible at city scale

def keepers(model):
    out = []
    for t in KEEP_TYPES:
        out += model.by_type(t)
    return out

def big_enough(verts, min_diag=MIN_BBOX_DIAGONAL_M):
    extent = verts.max(axis=0) - verts.min(axis=0)
    return float(np.linalg.norm(extent)) >= min_diag

elements = keepers(model)
print(f"{len(elements):,} elements kept of {len(model.by_type('IfcProduct')):,} products")
```

Two filters with different jobs. The class filter is about *relevance*: a twin that shows a building's form has no use for its plumbing, and a twin that does need the plumbing should serve it as a separate, separately loadable layer rather than inside the shell. The size filter is about *visibility*: a 4 cm fixing contributes a few hundred triangles and is smaller than a pixel at any distance the building is viewed from.

Keep the thresholds as configuration, because the answer differs by use. A facilities-management twin keeps `IfcFlowTerminal` and `IfcDistributionControlElement`; a city twin does not.

### 3. Merge by material to cut draw calls

```python
import trimesh

def material_key(element, model):
    for rel in getattr(element, "HasAssociations", ()) or ():
        if rel.is_a("IfcRelAssociatesMaterial"):
            m = rel.RelatingMaterial
            name = getattr(m, "Name", None)
            if name:
                return name
            if m.is_a("IfcMaterialLayerSetUsage"):
                layers = m.ForLayerSet.MaterialLayers
                if layers:
                    return layers[0].Material.Name
    return element.is_a()                       # fall back to grouping by class

def build_merged(model, settings, elements):
    groups = defaultdict(list)
    guids = set(e.GlobalId for e in elements)
    it = ifcopenshell.geom.iterator(settings, model, multiprocessing.cpu_count(),
                                    include=elements)
    if it.initialize():
        while True:
            shape = it.get()
            if shape.guid in guids:
                v = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
                f = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
                if big_enough(v):
                    el = model.by_guid(shape.guid)
                    groups[material_key(el, model)].append(
                        trimesh.Trimesh(vertices=v, faces=f, process=False))
            if not it.next():
                break
    merged = {k: trimesh.util.concatenate(v) for k, v in groups.items() if v}
    return merged

merged = build_merged(model, settings, elements)
print(f"{len(merged)} material groups; "
      f"{sum(len(m.faces) for m in merged.values()):,} triangles")
for name, m in sorted(merged.items(), key=lambda kv: -len(kv[1].faces))[:6]:
    print(f"  {name:<28}{len(m.faces):>9,} tris")
```

Draw calls, not triangles, are what makes a BIM tile slow on a phone. Forty thousand separate meshes means forty thousand draw calls even if each has ten triangles; merging into a few dozen material groups is the single largest rendering improvement in this pipeline. The cost is that per-element picking now needs feature identifiers rather than separate meshes — which is exactly what the metadata from the companion guide provides.

### 4. Decimate without flattening the building

```python
import open3d as o3d

def decimate_group(mesh, target_ratio=0.35, min_faces=200):
    if len(mesh.faces) <= min_faces:
        return mesh
    o3d_mesh = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(mesh.vertices),
        o3d.utility.Vector3iVector(mesh.faces))
    o3d_mesh.remove_duplicated_vertices()
    o3d_mesh.remove_degenerate_triangles()
    target = max(min_faces, int(len(mesh.faces) * target_ratio))
    simplified = o3d_mesh.simplify_quadric_decimation(target_number_of_triangles=target)
    out = trimesh.Trimesh(np.asarray(simplified.vertices),
                          np.asarray(simplified.triangles), process=False)
    return out

def planarity_error(before, after, samples=20_000):
    """Max distance from sampled points of the original surface to the simplified one."""
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(
        o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(after.vertices),
                                  o3d.utility.Vector3iVector(after.faces))))
    pts, _ = trimesh.sample.sample_surface(before, min(samples, len(before.faces) * 3))
    d = scene.compute_distance(o3d.core.Tensor(pts.astype(np.float32))).numpy()
    return float(np.percentile(d, 99))

simplified, report = {}, []
for name, m in merged.items():
    s = decimate_group(m)
    simplified[name] = s
    report.append((name, len(m.faces), len(s.faces), planarity_error(m, s)))

for name, before, after, err in sorted(report, key=lambda r: -r[1])[:6]:
    print(f"{name:<28}{before:>9,} → {after:>8,}  p99 deviation {err * 1000:6.1f} mm")
```

Quadric decimation preserves planar regions well, because collapsing an edge inside a flat area costs nothing in its error metric — which is why a wall stays flat and its corners stay sharp while the triangle count falls. What it does damage is small curved detail: a handrail, a moulding, a door handle. Measuring the deviation per group rather than trusting the ratio is what catches that: a wall group at 5 mm deviation is fine, a railing group at 80 mm has been destroyed and should be excluded from decimation instead.

<figure class="diagram">
<svg viewBox="26 42 609 216" role="img" aria-labelledby="ifcsimp-dec-t ifcsimp-dec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcsimp-dec-t">What decimation does to flat and curved geometry</title>
  <desc id="ifcsimp-dec-d">On the left, a wall with a window reveal keeps its shape after decimation because the flat faces collapse internally and the corner edges are preserved by the error metric. On the right, a curved railing loses its profile at the same ratio, because every edge collapse there costs real geometric error and the metric spends its budget evenly.</desc>
  <rect class="svg-bg" x="26" y="42" width="609" height="216" fill="#ffffff"/>
  <path d="M40 60 H300 V190 H40 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M120 100 h100 v60 h-100 Z" fill="#ffffff" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="0.6" fill="none">
    <path d="M40 90 H120 M40 120 H120 M40 150 H120 M220 90 H300 M220 120 H300 M220 150 H300"/>
    <path d="M70 60 V100 M70 160 V190 M170 60 V100 M170 160 V190 M260 60 V190"/>
  </g>
  <text x="170" y="216" fill="#4f7a4d" font-size="12.5" text-anchor="middle">wall: 2,400 → 320 triangles, 4 mm deviation</text>
  <path d="M420 170 C460 90 560 90 600 170" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M420 170 L510 108 L600 170" fill="none" stroke="#b0413e" stroke-width="3" stroke-dasharray="6 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="510" y="70">original profile</text>
  </g>
  <text x="510" y="216" fill="#b0413e" font-size="12.5" text-anchor="middle">railing: 1,800 → 240, 81 mm deviation</text>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">One ratio does not fit both; measure the deviation per material group.</text>
</svg>
<figcaption>Quadric error spends its budget where curvature is, so flat building fabric survives aggressive ratios and small curved detail does not.</figcaption>
</figure>

### 5. Instance the repeats instead of duplicating them

A building has one door type used four hundred times. Exporting four hundred copies of its geometry is four hundred times the bytes for one shape.

```python
def instancing_candidates(model, min_instances=8):
    """Group elements by their IfcTypeObject: same type means identical geometry."""
    by_type = defaultdict(list)
    for el in model.by_type("IfcElement"):
        for rel in getattr(el, "IsTypedBy", ()) or ():
            by_type[rel.RelatingType.GlobalId].append(el)
    return {k: v for k, v in by_type.items() if len(v) >= min_instances}

candidates = instancing_candidates(model)
saved = 0
for type_guid, instances in sorted(candidates.items(), key=lambda kv: -len(kv[1]))[:8]:
    type_obj = model.by_guid(type_guid)
    print(f"{(type_obj.Name or type_obj.is_a()):<36}{len(instances):>5} instances")
    saved += len(instances) - 1
print(f"{len(candidates)} instanceable types; {saved:,} duplicate geometries avoidable")
```

`IsTypedBy` is the relation that identifies genuine repeats: elements sharing an `IfcTypeObject` were placed from the same definition, so their geometry is identical up to a placement. Exporting one mesh plus a transform per instance — through `EXT_mesh_gpu_instancing` in glTF — turns four hundred doors into one mesh and four hundred matrices, which is both smaller and faster to render.

<figure class="diagram">
<svg viewBox="6 10 748 230" role="img" aria-labelledby="ifcsimp-inst-t ifcsimp-inst-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcsimp-inst-t">Duplicated geometry against one mesh and many transforms</title>
  <desc id="ifcsimp-inst-d">On the left, four hundred doors placed from the same type each carry their own copy of the geometry, so the export holds four hundred times the vertices. On the right, one mesh is stored with four hundred instance matrices, which is a fraction of the bytes and one draw call on the GPU.</desc>
  <rect class="svg-bg" x="6" y="10" width="748" height="230" fill="#ffffff"/>
  <rect x="20" y="24" width="340" height="170" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="24" width="340" height="170" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.2">
    <rect x="50" y="70" width="34" height="56"/><rect x="94" y="70" width="34" height="56"/>
    <rect x="138" y="70" width="34" height="56"/><rect x="182" y="70" width="34" height="56"/>
    <rect x="226" y="70" width="34" height="56"/><rect x="270" y="70" width="34" height="56"/>
    <rect x="314" y="70" width="34" height="56"/>
  </g>
  <rect x="430" y="70" width="44" height="72" fill="#ffffff" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.2">
    <rect x="510" y="70" width="210" height="18"/><rect x="510" y="94" width="210" height="18"/>
    <rect x="510" y="118" width="210" height="18"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="48">400 copies of one door mesh</text>
    <text x="190" y="160">400 × 900 vertices</text>
    <text x="570" y="48">one mesh + 400 matrices</text>
    <text x="452" y="164">mesh</text>
    <text x="615" y="84">matrix 1</text><text x="615" y="108">matrix 2</text><text x="615" y="132">… 400</text>
    <text x="570" y="180">900 vertices + 400 × 16 floats</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Elements sharing an IfcTypeObject are exactly the candidates for this.</text>
</svg>
<figcaption>Instancing turns repeated components from a bytes problem into a handful of matrices, and gives the GPU one draw call for the whole set.</figcaption>
</figure>

### 6. Check the result against the budget

```python
def budget_report(groups, triangle_budget=350_000, draw_call_budget=100):
    tris = sum(len(m.faces) for m in groups.values())
    calls = len(groups)
    return {
        "triangles": tris, "triangle_budget": triangle_budget,
        "within_triangles": tris <= triangle_budget,
        "draw_calls": calls, "draw_call_budget": draw_call_budget,
        "within_draw_calls": calls <= draw_call_budget,
        "bytes_estimate_mb": round(tris * 3 * 3 * 4 / 1e6, 1),   # positions + normals, float32
    }

print(budget_report(simplified))
```

## Expected Output & Verification

```text
IfcFlowSegment                 18,204 parts  16,884,102 tris  39.8%
IfcFlowFitting                 24,118 parts   7,642,008 tris  18.0%
IfcFurnishingElement            2,884 parts   5,101,442 tris  12.0%
IfcWallStandardCase             9,204 parts   4,204,118 tris   9.9%
IfcSlab                         1,442 parts   3,402,884 tris   8.0%
total 42,418,204 triangles across 68,204 parts
14,882 elements kept of 68,204 products
38 material groups; 8,204,118 triangles
  Concrete C30/37                2,884,102 tris
  Gypsum board                   1,442,008 tris
Concrete C30/37             2,884,102 →  1,009,435  p99 deviation    5.2 mm
Gypsum board                1,442,008 →    504,702  p99 deviation    3.8 mm
Steel railing                  84,204 →     29,471  p99 deviation   81.4 mm
41 instanceable types; 1,884 duplicate geometries avoidable
{'triangles': 2871441, 'triangle_budget': 350000, 'within_triangles': False,
 'draw_calls': 38, 'draw_call_budget': 100, 'within_draw_calls': True,
 'bytes_estimate_mb': 103.4}
```

That report is the honest intermediate state: draw calls are fixed, triangles are still eight times the budget, and the railing group has been visibly damaged. The response is a second pass — a lower ratio on the large planar groups, exclusion of the railing from decimation, and an LOD chain so the full-detail version is only fetched close up:

```python
LOD_RATIOS = (0.35, 0.12, 0.04)
NO_DECIMATE = {"Steel railing", "Aluminium profile"}

chain = []
for level, ratio in enumerate(LOD_RATIOS):
    level_groups = {}
    for name, m in merged.items():
        level_groups[name] = m if name in NO_DECIMATE and level == 0 else decimate_group(m, ratio)
    chain.append(budget_report(level_groups))
for level, rep in enumerate(chain):
    print(f"LOD{level}: {rep['triangles']:>9,} tris, {rep['draw_calls']} calls, "
          f"{rep['bytes_estimate_mb']:>6.1f} MB, within budget: {rep['within_triangles']}")
```

Verify visually as well as numerically. Render the simplified building against the original at three distances and compare silhouettes; a deviation report that passes while the roof line has moved by 20 cm means the sampling missed a small, important group.

## Common Errors

**The tile is small and still slow.** Draw calls, not bytes. Check the group count before blaming triangles.

**Walls develop visible waviness.** The decimation ratio is too aggressive for a group that contains both flat panels and curved elements. Split the group, or raise the ratio and rely on the LOD chain.

**Openings disappear and walls become solid.** The geometry iterator was run without the settings that apply openings, or a boolean subtraction failed and IfcOpenShell fell back to the un-cut body. Check a wall with a door against the original model.

**Instancing produces doors in the wrong places.** The instance transform was taken from the element's own placement while the geometry was already in world coordinates. Instancing needs geometry in the type's local frame plus a per-instance matrix.

**Merging loses per-element picking.** Expected: merged meshes have no element boundaries. Carry feature identifiers in the metadata, as in the companion guide, so picking still resolves to an element.

## Frequently Asked Questions

### How many triangles should one building get in a city twin?

At city scale, a building that is one of thousands can look right with 5,000–50,000 triangles. A hero building the user will walk around justifies a few hundred thousand across an LOD chain. Either way the budget comes from the scene, not from the model.

### Should MEP be discarded or served separately?

Separately, if anybody needs it. A distribution-systems layer as its own tileset, loaded on demand, keeps the shell streamable and still answers maintenance questions — and it can carry the detail that would be pointless in the shell.

### Is `gltfpack` or `gltf-transform` a substitute for this?

They do the last mile — quantisation, compression, instancing of identical meshes — very well, and they cannot make the content decisions: which classes matter, which parts are too small, which groups must not be decimated. Run them after this pipeline, not instead of it.

## Related Guides

- [Extracting IFC Properties into Tile Metadata](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/extracting-ifc-properties-into-tile-metadata/) — keeping identity after merging
- [Optimizing Mesh Triangle Count for Web Rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — budgets and measurement in general
- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — the glTF-side equivalent

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
