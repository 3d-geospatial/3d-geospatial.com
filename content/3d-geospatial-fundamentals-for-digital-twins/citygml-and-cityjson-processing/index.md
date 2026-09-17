# CityGML and CityJSON Processing for Digital Twins

Most municipal 3D city models are delivered as CityGML or CityJSON, and most of what makes them valuable is invisible in a viewer: every wall knows it is a wall, every roof carries its own surface type, every building has an identifier that links it to a register, and levels of detail are declared rather than guessed. A digital twin that converts these models straight to meshes throws that away and keeps the least useful part — the triangles. This guide covers the processing layer that keeps the semantics: converting CityGML into the more tractable CityJSON, reading the compressed vertex list and nested boundary arrays correctly, filtering by level of detail, reprojecting to the twin's CRS, validating the result, and exporting geometry for streaming while preserving identifiers and surface types for everything downstream.

It is written for GIS developers and digital twin engineers who receive city models from a mapping agency or a 3D city database and need to feed them into analysis and [3D Tiles delivery](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/). The trade-offs between the formats themselves are in [CityGML vs 3D Tiles for municipal twin delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/); this page is about working with the data.

## Prerequisites

- **Python 3.10+** with `cjio>=0.9`, `numpy>=1.24`, `shapely>=2.0`, `pyproj>=3.6` and `trimesh>=4.0`.
- **citygml-tools 2.x** (Java 17+) for CityGML-to-CityJSON conversion, and **cjval** (the CityJSON validator, installed with `cargo install cjval` or as a release binary).
- **A city model** in CityGML 2.0/3.0 or CityJSON 1.1/2.0. The examples use a district of the Dutch 3D BAG in CityJSON 2.0, whose CRS is the compound EPSG:7415 (Amersfoort / RD New + NAP height), and a German LOD2 CityGML tile in EPSG:25832 with DHHN2016 heights (EPSG:7837).
- **The twin's target CRS**, for example EPSG:4978 for 3D Tiles or a projected compound CRS for analysis.

## Concept

CityGML and CityJSON share one data model, defined by the OGC CityGML conceptual model; they differ in encoding. CityGML is XML with GML geometry, verbose and deeply nested, and a city of a few hundred thousand buildings routinely runs to tens of gigabytes. CityJSON encodes the same objects in JSON with two structural decisions that make it far easier to process: all vertices live in one shared array, and geometry refers to them by index.

A CityJSON file has three parts that matter for processing. `CityObjects` is a dictionary keyed by identifier, where each object has a `type` (`Building`, `BuildingPart`, `Road`, `SolitaryVegetationObject`…), `attributes`, optional `parents` and `children`, and a list of `geometry` entries. `vertices` is a flat list of integer triplets. `transform` holds a `scale` and `translate` that turn those integers into real coordinates: `x = i * scale[0] + translate[0]`. The CRS is declared once, under `metadata.referenceSystem`, as an OGC URL such as `https://www.opengis.net/def/crs/EPSG/0/7415`.

Each geometry has a `type` (`Solid`, `MultiSurface`, `CompositeSurface`…), a `lod` string such as `"1.2"` or `"2.2"`, and `boundaries` — arrays of vertex indices nested to a depth that depends on the type. A `MultiSurface` is a list of surfaces, each a list of rings; a `Solid` adds a shell level above that. Surface semantics sit alongside in `semantics`: a list of surface descriptions (`RoofSurface`, `WallSurface`, `GroundSurface`…) and a `values` array with the same nesting as the boundaries, pointing each surface at its description.

<figure class="diagram">
<svg viewBox="6 6 748 304" role="img" aria-labelledby="cj-model-t cj-model-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cj-model-t">How a CityJSON building refers to its geometry</title>
  <desc id="cj-model-d">A CityObject named by its identifier holds attributes and a geometry entry with a type, a level of detail and nested boundary arrays. The boundaries contain integer indices into the shared vertices array, which holds integer triplets turned into coordinates by the transform's scale and translate. A parallel semantics values array labels each surface as roof, wall or ground.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="304" fill="#ffffff"/>
  <defs>
    <marker id="cj-model-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="250" height="110" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="20" y="160" width="250" height="110" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="330" y="160" width="190" height="110" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="570" y="160" width="170" height="110" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="330" y="20" width="190" height="110" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cj-model-arrow)">
    <path d="M145 131 V158"/>
    <path d="M270 215 H328"/>
    <path d="M520 215 H568"/>
    <path d="M200 131 C260 131 290 75 328 75"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="46">CityObjects["NL.IMBAG…"]</text>
    <text x="145" y="68">type: Building</text>
    <text x="145" y="88">attributes: height, year</text>
    <text x="145" y="108">geometry[0]: lod 2.2</text>
    <text x="145" y="186">boundaries</text>
    <text x="145" y="208">[[[[12, 13, 14, 15]],</text>
    <text x="145" y="228">[[15, 14, 22, 23]], …]]</text>
    <text x="425" y="186">vertices</text>
    <text x="425" y="208">[[84120, 44705, 212],</text>
    <text x="425" y="228">[84133, 44711, 212], …]</text>
    <text x="655" y="186">transform</text>
    <text x="655" y="208">scale 0.001</text>
    <text x="655" y="228">translate x, y, z</text>
    <text x="425" y="46">semantics</text>
    <text x="425" y="68">surfaces: Roof, Wall,</text>
    <text x="425" y="88">Ground</text>
    <text x="425" y="108">values: [[0, 1, 1, 2, …]]</text>
  </g>
  <text x="380" y="292" fill="#15384a" font-size="12.5" text-anchor="middle">Indices → integer triplets → scale and translate → coordinates in metadata.referenceSystem</text>
</svg>
<figcaption>Geometry never stores coordinates directly. Every consumer has to apply the transform, and every edit to the vertex list has to renumber the boundaries.</figcaption>
</figure>

Levels of detail are the other concept worth being precise about. CityGML 2.0 defines LOD0 to LOD4; the refined scheme widely used for CityJSON splits them into sub-levels, so LOD1.2 is a block model with the footprint extruded to a single height, LOD1.3 has different heights per roof part, and LOD2.2 has real roof shapes including dormers. A single building often carries several geometries at different LODs, and a pipeline has to choose one explicitly.

## Step-by-Step Workflow

### 1. Convert CityGML to CityJSON

```python
import subprocess
from pathlib import Path

src = Path("lod2_32691_5336_2_by.gml")
out_dir = Path("cityjson"); out_dir.mkdir(exist_ok=True)

subprocess.run(["citygml-tools", "to-cityjson", str(src)], check=True)
converted = src.with_suffix(".json")
target = out_dir / (src.stem + ".city.json")
converted.rename(target)
print(target, f"{target.stat().st_size / 1e6:.1f} MB (from {src.stat().st_size / 1e6:.1f} MB CityGML)")
```

`citygml-tools to-cityjson` writes the result next to the input with a `.json` extension; renaming to `.city.json` follows the CityJSON file-naming convention that tools use to recognise the format. Expect the CityJSON to be a fifth to a tenth of the CityGML size, mostly from the shared vertex list and integer coordinates. Conversion keeps object identifiers, attributes, semantics, appearances and all LODs present in the source.

### 2. Inspect the model before touching it

```python
import json

def cityjson_summary(path):
    cj = json.loads(Path(path).read_text())
    objs = cj["CityObjects"]
    types, lods, geom_types = {}, {}, {}
    for o in objs.values():
        types[o["type"]] = types.get(o["type"], 0) + 1
        for g in o.get("geometry", []):
            lods[g["lod"]] = lods.get(g["lod"], 0) + 1
            geom_types[g["type"]] = geom_types.get(g["type"], 0) + 1
    return {
        "version": cj["version"],
        "crs": cj.get("metadata", {}).get("referenceSystem"),
        "transform": cj.get("transform"),
        "objects": len(objs),
        "vertices": len(cj["vertices"]),
        "types": types, "lods": lods, "geometry_types": geom_types,
    }

print(json.dumps(cityjson_summary("cityjson/lod2_32691_5336_2_by.city.json"), indent=2))
```

`cjio <file> info` prints much of the same, and is quicker for a look at the command line. The Python version is useful because its output can be asserted in a pipeline: the CRS must be present, the version must be one the next tool supports, and the LODs must include the one the twin needs. A model that reports `"crs": null` is the most common trap — CityJSON allows a missing reference system, and a converter that did not find `srsName` in the CityGML will leave it out.

### 3. Resolve vertices and walk surfaces with their semantics

```python
import numpy as np

def real_vertices(cj):
    v = np.asarray(cj["vertices"], dtype=np.float64)
    t = cj.get("transform")
    if t:
        v = v * np.asarray(t["scale"]) + np.asarray(t["translate"])
    return v

def surfaces(geom):
    """Yield (ring_list, semantic_index) for every surface in a geometry, whatever its nesting."""
    b, sem = geom["boundaries"], geom.get("semantics", {}).get("values")
    if geom["type"] in ("MultiSurface", "CompositeSurface"):
        for i, surf in enumerate(b):
            yield surf, (sem[i] if sem else None)
    elif geom["type"] == "Solid":
        for s, shell in enumerate(b):
            for i, surf in enumerate(shell):
                yield surf, (sem[s][i] if sem else None)
    elif geom["type"] in ("MultiSolid", "CompositeSolid"):
        for k, solid in enumerate(b):
            for s, shell in enumerate(solid):
                for i, surf in enumerate(shell):
                    yield surf, (sem[k][s][i] if sem else None)

cj = json.loads(Path("cityjson/lod2_32691_5336_2_by.city.json").read_text())
V = real_vertices(cj)
counts = {}
for oid, obj in cj["CityObjects"].items():
    for g in obj.get("geometry", []):
        if g["lod"] != "2":
            continue
        names = [s["type"] for s in g.get("semantics", {}).get("surfaces", [])]
        for rings, si in surfaces(g):
            label = names[si] if si is not None else "unlabelled"
            counts[label] = counts.get(label, 0) + 1
print(counts)
```

The nesting table in `surfaces` is the part people get wrong. A `Solid`'s boundaries are shells of surfaces of rings, so the semantic values are indexed by shell then surface; applying `MultiSurface` indexing to a `Solid` silently labels every surface with the semantics of its shell's first entry. A surface is a list of rings — the first is the exterior, the rest are holes such as window openings in an LOD3 wall.

<figure class="diagram">
<svg viewBox="6 6 748 248" role="img" aria-labelledby="cj-nest-t cj-nest-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cj-nest-t">Boundary nesting depth by geometry type</title>
  <desc id="cj-nest-d">A table of nesting levels. MultiSurface and CompositeSurface boundaries are surfaces of rings of vertex indices. Solid boundaries add a shell level above the surfaces. MultiSolid and CompositeSolid add a solid level above the shells. The semantics values array has the same nesting minus the ring and vertex levels.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="248" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="220" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="300" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="540" y="20" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="60" width="220" height="50" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="60" width="300" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="540" y="60" width="200" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="110" width="220" height="50" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="110" width="300" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="540" y="110" width="200" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="160" width="220" height="50" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="160" width="300" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="540" y="160" width="200" height="50" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="45">geometry type</text>
    <text x="390" y="45">boundaries</text>
    <text x="640" y="45">semantics.values</text>
    <text x="130" y="90">MultiSurface</text>
    <text x="390" y="90">surface → ring → index</text>
    <text x="640" y="90">[surface]</text>
    <text x="130" y="140">Solid</text>
    <text x="390" y="140">shell → surface → ring → index</text>
    <text x="640" y="140">[shell][surface]</text>
    <text x="130" y="190">MultiSolid</text>
    <text x="390" y="190">solid → shell → surface → ring → idx</text>
    <text x="640" y="190">[solid][shell][surface]</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Semantic values stop at the surface; rings and vertex indices have no semantics of their own.</text>
</svg>
<figcaption>Index the semantics with the same depth as the geometry type, or every surface of a solid quietly inherits the wrong label.</figcaption>
</figure>

### 4. Filter to one LOD and subset to an area

```python
subprocess.run([
    "cjio", "cityjson/lod2_32691_5336_2_by.city.json",
    "lod_filter", "2",
    "subset", "--bbox", "691200", "5335800", "691700", "5336300",
    "save", "cityjson/district_lod2.city.json",
], check=True)
print(cityjson_summary("cityjson/district_lod2.city.json")["lods"])
```

`cjio` chains operators left to right, so this loads the file, keeps only LOD2 geometry, keeps objects inside the bounding box and saves. The bounding box is in the file's own CRS, EPSG:25832 here. Subsetting before any heavier operation — reprojection, triangulation, export — is the cheapest performance improvement available, and `cjio` removes vertices no longer referenced so the output is genuinely smaller rather than a copy with fewer objects.

### 5. Reproject to the twin's CRS

```python
subprocess.run([
    "cjio", "cityjson/district_lod2.city.json",
    "crs_reproject", "7415",
    "save", "cityjson/district_lod2_7415.city.json",
], check=True)

from pyproj import Transformer
cj = json.loads(Path("cityjson/district_lod2_7415.city.json").read_text())
print(cj["metadata"]["referenceSystem"], real_vertices(cj)[:2].round(3))
```

`crs_reproject` transforms every vertex with PROJ, recomputes the transform and updates `metadata.referenceSystem`. Reprojecting a German model into a Dutch compound CRS is only sensible for a cross-border twin, but the pattern is identical for the usual case of a projected source going to EPSG:4978 before tiling. Two cautions apply. Heights must carry a vertical CRS on both sides or PROJ treats them as ellipsoidal — a CityJSON whose `referenceSystem` names only EPSG:25832 has ambiguous heights, and the fix is to assign the compound CRS with `crs_assign` before reprojecting. And reprojection changes coordinate precision: going to EPSG:4978 with the default millimetre scale is fine, going to geographic degrees with a millimetre scale collapses every building to a point.

### 6. Validate before and after every change

```python
result = subprocess.run(["cjval", "cityjson/district_lod2_7415.city.json"], capture_output=True, text=True)
print(result.stdout[-1500:])
if result.returncode != 0 or "INVALID" in result.stdout:
    raise SystemExit("CityJSON failed schema or geometry validation")
```

`cjval` checks the file against the CityJSON schema for its version and runs structural checks — parent and child references that resolve, semantic values arrays shaped like their boundaries, vertices that are all used, and more. Running it after conversion and again after every transformation localises a problem to the step that introduced it. The mechanics and the full list of checks are in [validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/).

### 7. Export geometry while keeping identifiers and semantics

```python
import trimesh
from shapely.geometry import Polygon
from trimesh.creation import triangulate_polygon

def triangulate_surface(V, rings):
    """Triangulate one planar surface (exterior ring + holes) and return 3D triangles."""
    ext = V[rings[0]]
    normal = np.cross(ext[1] - ext[0], ext[2] - ext[0])
    n_len = np.linalg.norm(normal)
    if n_len < 1e-12:
        return None
    normal = normal / n_len
    drop = int(np.argmax(np.abs(normal)))                 # project onto the plane it faces most
    keep = [i for i in range(3) if i != drop]
    poly = Polygon(ext[:, keep], [V[r][:, keep] for r in rings[1:]])
    if not poly.is_valid or poly.area < 1e-9:
        return None
    pts2, faces = triangulate_polygon(poly, engine="earcut")

    # Lift each 2D point back onto the surface plane: normal · p = normal · ext[0]
    d = float(normal @ ext[0])
    pts3 = np.zeros((len(pts2), 3))
    pts3[:, keep[0]], pts3[:, keep[1]] = pts2[:, 0], pts2[:, 1]
    pts3[:, drop] = (d - pts3[:, keep[0]] * normal[keep[0]] - pts3[:, keep[1]] * normal[keep[1]]) / normal[drop]
    return pts3[faces]

def building_mesh(cj, oid, lod="2"):
    V = real_vertices(cj)
    tris, face_semantic = [], []
    for g in cj["CityObjects"][oid].get("geometry", []):
        if g["lod"] != lod:
            continue
        names = [s["type"] for s in g.get("semantics", {}).get("surfaces", [])]
        for rings, si in surfaces(g):
            t = triangulate_surface(V, rings)
            if t is None:
                continue
            tris.append(t)
            face_semantic += [names[si] if si is not None else "unlabelled"] * len(t)
    return np.vstack(tris), face_semantic

tris, sem = building_mesh(cj, next(iter(cj["CityObjects"])))
mesh = trimesh.Trimesh(vertices=tris.reshape(-1, 3), faces=np.arange(len(tris) * 3).reshape(-1, 3))
mesh.merge_vertices()
print(len(mesh.faces), "triangles;", {s: sem.count(s) for s in set(sem)})
```

For bulk export, `cjio <file> export glb out.glb` is faster and handles appearances; the Python route above exists for when the pipeline needs per-triangle semantics — to colour roofs separately, to attach `RoofSurface` identifiers to feature IDs in [EXT_structural_metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/), or to compute roof areas for solar analysis. Projecting each planar surface onto its dominant axis plane before triangulating is what makes vertical walls triangulate correctly; triangulating every surface in XY collapses walls to lines.

<figure class="diagram">
<svg viewBox="-4 6 768 212" role="img" aria-labelledby="cj-flow-t cj-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cj-flow-t">Processing chain for a semantic city model</title>
  <desc id="cj-flow-d">CityGML is converted to CityJSON, inspected, filtered to one level of detail and subset to an area, reprojected to the twin's CRS, validated with cjval, and exported either as glTF for streaming or as triangles with per-face semantics for analysis and metadata. Validation runs after conversion and after each transformation.</desc>
  <rect class="svg-bg" x="-4" y="6" width="768" height="212" fill="#ffffff"/>
  <defs>
    <marker id="cj-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="60" width="100" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="140" y="60" width="110" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="280" y="60" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="60" width="110" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="570" y="20" width="180" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="570" y="110" width="180" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="200" y="160" width="280" height="44" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cj-flow-arrow)">
    <path d="M110 88 H138"/><path d="M250 88 H278"/><path d="M400 88 H428"/>
    <path d="M540 80 L568 52"/><path d="M540 96 L568 134"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none" stroke-dasharray="4 4">
    <path d="M195 117 V158"/><path d="M340 117 V158"/><path d="M485 117 V158"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="60" y="84">CityGML</text><text x="60" y="101">to-cityjson</text>
    <text x="195" y="84">inspect</text><text x="195" y="101">CRS · LODs</text>
    <text x="340" y="84">lod_filter</text><text x="340" y="101">subset</text>
    <text x="485" y="84">crs_reproject</text><text x="485" y="101">compound CRS</text>
    <text x="660" y="44">export glb</text><text x="660" y="61">for streaming</text>
    <text x="660" y="134">triangles + semantics</text><text x="660" y="151">for analysis, metadata</text>
    <text x="340" y="187">cjval after each step</text>
  </g>
</svg>
<figcaption>Filtering and subsetting come before reprojection and export because they shrink every later step; validation runs between steps so a failure points at its cause.</figcaption>
</figure>

## Validation & Verification

Three checks prove a processed city model is fit for a twin.

- **Schema and structure.** `cjval` reports no errors on the final file.
- **Object and attribute preservation.** Every identifier in the source that falls in the subset area is present in the output, with the same attribute keys.
- **Positional agreement.** A handful of building corners, compared with cadastral footprints or surveyed points in the same CRS, agree within the stated accuracy of the model — typically 0.3–1 m horizontally for LOD2 models derived from aerial data.

```python
src = json.loads(Path("cityjson/lod2_32691_5336_2_by.city.json").read_text())
out = json.loads(Path("cityjson/district_lod2.city.json").read_text())

missing_attrs = []
for oid, obj in out["CityObjects"].items():
    if oid not in src["CityObjects"]:
        raise AssertionError(f"{oid} appeared from nowhere")
    if set(src["CityObjects"][oid].get("attributes", {})) != set(obj.get("attributes", {})):
        missing_attrs.append(oid)
print(f"{len(out['CityObjects'])} objects kept, {len(missing_attrs)} with changed attribute keys")

buildings = [o for o in out["CityObjects"].values() if o["type"] == "Building"]
heights = [o["attributes"].get("measuredHeight") for o in buildings if "measuredHeight" in o.get("attributes", {})]
assert all(2.0 < h < 250.0 for h in heights), "implausible building heights: check units or height reference"
```

## Performance & Scale

- **Use CityJSONSeq for large extents.** CityJSON 2.0 defines a line-delimited form, `.city.jsonl`, with one metadata line followed by one feature per line, each with its own vertex list. `cjio` exports it with `export jsonl`. It streams: a process can read one building at a time and never hold the whole city in memory, which matters above a few gigabytes.
- **Subset early, reproject once.** Reprojection of 50 million vertices takes a minute; loading the JSON takes longer. Tile the source by area and process tiles independently.
- **Keep integer vertices.** Converting all vertices to float64 arrays is necessary for geometry work but multiplies memory by three compared with the integer list; apply the transform per object when streaming.
- **Triangulate in bulk with a compiled tool** for export at city scale, and reserve Python triangulation for analytic subsets where per-face semantics are needed.

## Failure Modes & Gotchas

**Buildings appear hundreds of kilometres away or at the origin.** The consumer ignored `transform` and used raw integer vertices. Any tool that reads CityJSON directly must apply scale and translate.

**Roofs are labelled as walls in analysis.** Semantic values were indexed with the wrong nesting depth for `Solid` geometry. Test the semantic counts on a known building before running a city.

**Heights are 40–50 m off after reprojection.** The source CRS was horizontal-only, so PROJ treated NAP or DHHN2016 heights as ellipsoidal. Assign the compound CRS first; the vertical theory is in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/).

**`cjval` fails on a file that loads everywhere.** Many tools are lenient about duplicate vertices, unused vertices and malformed semantics arrays. Fix the file rather than the validator: downstream code that is not lenient will fail on the same defects later.

**LOD mismatch between neighbouring tiles.** One tile of a national dataset has LOD2.2 and its neighbour only LOD1.2, so filtering to `"2.2"` leaves a hole. Filter with a preference order and record which LOD each building used.

## Frequently Asked Questions

### Should a twin store CityGML, CityJSON or neither?

Store CityJSON (or a 3D city database) as the semantic source of truth and generate 3D Tiles from it for delivery. CityGML remains the exchange format many agencies publish, and conversion is lossless in the direction that matters.

### Is CityJSON 1.1 still worth supporting?

Yes, for reading. Much published data is 1.1; `cjio <file> upgrade` brings it to 2.0, and the changes are small enough that upgrade-then-process is safer than maintaining two code paths.

### Can CityJSON carry textures?

Yes, through `appearance`, with texture coordinates per ring. Textured city models are rarer and heavier; many pipelines drop textures for analysis with `textures_remove` and keep them only for the visual export.

### How do I get from CityJSON to 3D Tiles?

Export glTF per building or per tile with identifiers preserved, then tile as described in [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/). Keep the CityJSON identifier as the feature ID so a click in the viewer resolves to the source object.

### Do I need a 3D city database?

For a one-off conversion, no. For a twin that ingests updated city models several times a year and has to answer attribute queries across a whole city, a database such as 3DCityDB earns its keep: it holds the semantics relationally, supports incremental updates per building, and exports CityGML or CityJSON for the extents a pipeline asks for. The processing steps on this page then run against exports rather than against delivered tiles.

### What about CityGML 3.0?

citygml-tools reads CityGML 3.0, and CityJSON 2.0 follows the 3.0 conceptual model closely. The main processing difference is new object types and space/boundary concepts; geometry handling is unchanged.

## Related Guides

- [Converting CityGML to CityJSON with citygml-tools](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/converting-citygml-to-cityjson-with-citygml-tools/) — the first step in detail
- [Extracting LOD2 Roof Surfaces from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/extracting-lod2-roof-surfaces-from-cityjson/) — semantics put to work
- [Validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/) — the gate between every step
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — choosing the delivery format
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — where exported geometry goes next
- [Computing Building Heights and Volumes from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/computing-building-heights-and-volumes-from-cityjson/) — derive defensible building heights and volumes from CityJSON
- [Reading and Filtering CityJSON with cjio](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reading-and-filtering-cityjson-with-cjio/) — subset and clean CityJSON city models with cjio
- [Reprojecting and Upgrading CityJSON Files](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reprojecting-and-upgrading-cityjson-files/) — move CityJSON models between CRSs and versions safely

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
