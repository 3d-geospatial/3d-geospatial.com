---
title: "3D Format Standards Comparison"
description: "Compare 3D Tiles, glTF, OBJ, CityGML, IFC, GeoPackage, and LAS/LAZ for digital twins: semantics, CRS handling, LOD, streaming, and conversion patterns."
---
# 3D Format Standards Comparison for Digital Twin Automation

Choosing a 3D format is not a file-extension preference — it decides whether your digital twin can carry coordinate reference metadata across a conversion, whether a browser can stream a city without exhausting memory, and whether the construction year baked into a building survives the trip from BIM authoring to a Cesium tileset. No single specification wins everywhere: CityGML and IFC are rich in semantics but blind to streaming; glTF and 3D Tiles stream beautifully but discard most of an IFC model's metadata unless you map it deliberately; LAS/LAZ keep raw measurement fidelity but are not surfaces at all. This guide compares CityGML, IFC, OGC 3D Tiles, glTF 2.0, OBJ, GeoPackage, 3D GeoJSON, and LAS/LAZ on the axes that actually break pipelines — semantics, CRS handling, level of detail, streaming, schema validation, and compression — and gives you runnable conversions with `trimesh`, `pygltflib`, and GDAL/OGR so the comparison is something you can execute, not just read.

## Prerequisites

The conversion snippets below assume a Python 3.11 environment with these packages and the GDAL/OGR command-line tools installed:

- `trimesh==4.4.*` with `pygltflib==1.16.*` for glTF read/write and Draco/meshopt-aware export.
- `numpy==1.26.*`, `shapely==2.0.*` for geometry and attribute handling.
- `pyproj==3.6.*` (PROJ 9.x) for CRS validation and reprojection.
- GDAL/OGR 3.8+ (`ogr2ogr`, `ogrinfo`) for vector format conversion (GeoPackage, 3D GeoJSON).
- `laspy==2.5.*` with the `lazrs` backend for `.las`/`.laz` inspection.
- `IfcOpenShell` 0.7+ and the npm `3d-tiles-validator` (v0.4+) for IFC parsing and tileset validation.

Every input is assumed to declare an explicit CRS. Source meshes from photogrammetry typically arrive in a projected metric system such as UTM zone 18N (EPSG:32618); web outputs target EPSG:4326 for geographic positioning of the tileset, while local geometry inside a tile is kept in a metric east-north-up frame. State the EPSG in metadata at every stage — a format that "supports CRS" still records nothing if the writer was never told the code.

## Concept

Each format optimizes for one thing and pays for it elsewhere. CityGML optimizes for **semantic completeness**: it models a building as a hierarchy of walls, roofs, and rooms with explicit LOD0–LOD4 and a validating XML schema, at the cost of being verbose and un-streamable. IFC optimizes for the **building lifecycle** — phases, materials, IfcPropertySets — but its native coordinates are a project-local frame with no CRS, so georeferencing is something you apply, not something you read. glTF 2.0 optimizes for **GPU upload**: an interleaved binary buffer the renderer maps almost directly to vertex attributes, with semantics demoted to a free-form `extras`/`KHR_materials` payload. OGC 3D Tiles wraps glTF (or `pnts` point tiles) in a **spatial index** with bounding volumes and `geometricError` so a client can page LOD by screen-space error. OBJ optimizes for **nothing but portability** — ASCII triangles, no CRS, no metadata. GeoPackage and 3D GeoJSON optimize for **attribute queries**: a SQLite-backed or JSON feature store you can filter with SQL or a web API.

The resolution to this tension is not a single winning format but a **canonical internal format with derived outputs**: keep semantics and CRS in an authoritative store, and generate each delivery format as a versioned, disposable derivative. The corollary is that conversion direction matters — you should only ever convert from a richer format to a leaner one (CityGML → 3D Tiles, IFC → glTF, LAS → derived mesh), never the reverse, because the lean format physically cannot reconstruct what it never stored. A glTF that has lost its IFC property sets cannot regrow them; an OBJ that dropped its CRS cannot infer one. Treat every arrow in the diagram below as one-way and lossy, and keep the upstream source so you can regenerate when a target spec changes or a Draco bug is found.

<figure class="diagram">
<svg viewBox="1 1 858 279" role="img" aria-labelledby="fmt-canon-t fmt-canon-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-canon-t">Canonical internal format with derived outputs</title>
  <desc id="fmt-canon-d">Semantic-rich sources CityGML, IFC, and LAS/LAZ feed a canonical store holding geometry plus attributes plus an explicit CRS, from which streaming, archival, and exchange formats are derived as disposable outputs.</desc>
  <rect class="svg-bg" x="1" y="1" width="858" height="279" fill="#ffffff"/>
  <defs>
    <marker id="fmt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="15" y="40" width="150" height="46" rx="8"/>
    <rect x="15" y="100" width="150" height="46" rx="8"/>
    <rect x="15" y="160" width="150" height="46" rx="8"/>
  </g>
  <rect x="330" y="90" width="200" height="120" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="695" y="40" width="150" height="46" rx="8"/>
    <rect x="695" y="100" width="150" height="46" rx="8"/>
    <rect x="695" y="160" width="150" height="46" rx="8"/>
    <rect x="695" y="220" width="150" height="46" rx="8"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#fmt-arrow)">
    <line x1="166" y1="63" x2="328" y2="120"/>
    <line x1="166" y1="123" x2="328" y2="150"/>
    <line x1="166" y1="183" x2="328" y2="180"/>
    <line x1="531" y1="135" x2="693" y2="63"/>
    <line x1="531" y1="150" x2="693" y2="123"/>
    <line x1="531" y1="160" x2="693" y2="183"/>
    <line x1="531" y1="170" x2="693" y2="243"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="90" y="68">CityGML</text>
    <text x="90" y="128">IFC (BIM)</text>
    <text x="90" y="188">LAS / LAZ</text>
    <text x="430" y="135">Canonical store</text>
    <text x="430" y="155" font-size="12">geometry + attributes</text>
    <text x="430" y="173" font-size="12">+ explicit CRS</text>
    <text x="770" y="68">3D Tiles</text>
    <text x="770" y="128">glTF (Draco)</text>
    <text x="770" y="188">GeoPackage</text>
    <text x="770" y="248">3D GeoJSON</text>
  </g>
  <text x="90" y="28" fill="#5b6471" font-size="12" text-anchor="middle">Authoritative sources</text>
  <text x="770" y="28" fill="#5b6471" font-size="12" text-anchor="middle">Derived outputs</text>
</svg>
<figcaption>A canonical internal store holds semantics and CRS once; every delivery format is a disposable, regenerable derivative.</figcaption>
</figure>

## Comparison Table

The matrix below ranks each format on the axes that decide a pipeline. "Streaming" means native progressive paging, not just chunked reads; "LOD" means an explicit, addressable level-of-detail model rather than ad-hoc decimation. Read it as a capability map, not a ranking — the right cell to optimize for depends on whether your bottleneck is the browser (favour 3D Tiles + Draco glTF), the analyst (favour CityGML/GeoPackage semantics), or the surveyor (favour LAS/LAZ fidelity). Most production twins use three or four of these simultaneously: LAS/LAZ for the raw scan, a canonical GeoPackage for attributes, and 3D Tiles wrapping Draco glTF for delivery.

| Format | Semantics | CRS handling | LOD / streaming | Compression | Best use |
|---|---|---|---|---|---|
| **CityGML** | Rich — building parts, rooms, ADEs, validating XSD | Native (`srsName` with EPSG, e.g. EPSG:25832) | LOD0–LOD4 explicit; no streaming, needs tiling | gzip only | Municipal/regulatory archival, semantic analysis |
| **IFC** | Extensive — phases, materials, property sets | None native; project-local frame, georeference on import | Implicit via spatial structure; no streaming | None (STEP text) or `.ifczip` | BIM/infrastructure exchange, building lifecycle |
| **OGC 3D Tiles** | Feature tables / batch IDs / metadata | Native — root transform + bounding volumes (EPSG:4326 anchoring) | Hierarchical LOD by `geometricError`; full streaming | Inherits glTF (Draco/meshopt) | Browser delivery of city/region twins |
| **glTF 2.0** | Free-form `extras`, `KHR_*` extensions | None native; `CESIUM_RTC` or external transform | None native; LOD via separate nodes | `KHR_draco_mesh_compression`, `EXT_meshopt_compression` | Web/real-time render payload inside tiles |
| **OBJ** | None | None | None | None (ASCII) | CAD interchange, throwaway intermediates |
| **GeoPackage** | Attribute tables (SQL-queryable) | Native (`gpkg_spatial_ref_sys`, EPSG) | No (vector store) | SQLite + optional WKB | Attribute-rich query store, vector twin layers |
| **3D GeoJSON** | Feature properties (JSON) | RFC 7946 mandates EPSG:4326 (CRS84) | No | gzip on the wire | Lightweight API delivery, web feature exchange |
| **LAS / LAZ** | Per-point class/intensity (ASPRS) | Native (VLR/EVLR WKT, EPSG) | Partial — chunked/COPC reads | LAZ (LASzip) ~7–10x | Point-cloud archival, raw measurement fidelity |

<figure class="diagram">
<svg viewBox="0 26 802 197" role="img" aria-labelledby="fmt-ratchet-t fmt-ratchet-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-ratchet-t">Format conversion is a one-way ratchet</title>
  <desc id="fmt-ratchet-d">CityGML converts to 3D Tiles, losing rooms, application domain extensions and schema validation. 3D Tiles converts to glTF, losing the batch table unless every attribute was mapped. glTF converts to OBJ, losing the CRS note in extras. No arrow points back, because a leaner format cannot reconstruct what it never stored.</desc>
  <rect class="svg-bg" x="0" y="26" width="802" height="197" fill="#ffffff"/>
  <defs>
    <marker id="fmt-ratchet-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="14" y="40" width="150" height="76" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="222" y="40" width="150" height="76" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="40" width="150" height="76" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="638" y="40" width="150" height="76" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#fmt-ratchet-a)">
    <line x1="164" y1="78" x2="220" y2="78"/>
    <line x1="372" y1="78" x2="428" y2="78"/>
    <line x1="580" y1="78" x2="636" y2="78"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="89" y="72"><tspan x="89" dy="0" font-weight="600">CityGML</tspan><tspan x="89" dy="17">semantics, CRS,</tspan><tspan x="89" dy="16">LOD0–4, schema</tspan></text>
    <text x="297" y="72"><tspan x="297" dy="0" font-weight="600">3D Tiles</tspan><tspan x="297" dy="17">batch metadata,</tspan><tspan x="297" dy="16">CRS, LOD tree</tspan></text>
    <text x="505" y="72"><tspan x="505" dy="0" font-weight="600">glTF / GLB</tspan><tspan x="505" dy="17">materials, geometry,</tspan><tspan x="505" dy="16">free-form extras</tspan></text>
    <text x="713" y="72"><tspan x="713" dy="0" font-weight="600">OBJ</tspan><tspan x="713" dy="17">triangles and</tspan><tspan x="713" dy="16">a material name</tspan></text>
  </g>
  <g fill="#b0413e" font-size="11.5" text-anchor="middle">
    <text x="193" y="150"><tspan x="193" dy="0">drops rooms, ADEs</tspan><tspan x="193" dy="15">and schema validation</tspan></text>
    <text x="401" y="150"><tspan x="401" dy="0">drops the batch table unless</tspan><tspan x="401" dy="15">every attribute was mapped</tspan></text>
    <text x="609" y="150"><tspan x="609" dy="0">drops the CRS note that</tspan><tspan x="609" dy="15">generic tools never read</tspan></text>
  </g>
  <text x="400" y="204" fill="#15384a" font-size="12.5" text-anchor="middle">No arrow points left. Keep the upstream source, because the derivative cannot regrow what the step above discarded.</text>
</svg>
<figcaption>Each conversion is a deliberate discard, and the discard is silent. Naming what each hop drops is what turns &quot;we can regenerate it&quot; from a hope into a plan.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow takes a photogrammetry-derived building mesh in UTM 18N (EPSG:32618), attaches semantics, and produces both a streaming glTF payload and a query-able vector layer — the two derivatives most twins need. Each step ends in a state you can assert on, so the pipeline can run unattended in CI and fail loudly the moment a conversion drops a CRS or an attribute rather than shipping a silently corrupted tile.

### 1. Load and inspect the source mesh

Confirm the geometry is sane and metric before converting. `trimesh` reports vertex/face counts and watertightness; the units must be metres in EPSG:32618, not the dimensionless coordinates OBJ often carries.

```python
import trimesh
import numpy as np

mesh = trimesh.load("building_block.obj", file_type="obj", process=False)
print("vertices:", len(mesh.vertices), "faces:", len(mesh.faces))
print("watertight:", mesh.is_watertight, "winding ok:", mesh.is_winding_consistent)

# Source is in UTM 18N metres (EPSG:32618). Sanity-check the extent is metric.
extent = mesh.bounds[1] - mesh.bounds[0]
assert np.all(extent < 1000.0), "extent looks non-metric; check source CRS"
print(f"bbox extent (m): {extent.round(2)}")
```

### 2. Attach semantic attributes as glTF extras

glTF has no semantic schema, so map building metadata into `metadata` on the `trimesh` object, which the exporter serializes into the node `extras`. This is the explicit field mapping that prevents silent attribute loss.

```python
mesh.metadata.update({
    "asset_id": "BLDG-18N-00427",
    "construction_year": 1962,
    "source_crs": "EPSG:32618",
    "lod": "LOD2",
})
```

### 3. Export Draco-compressed glTF with pygltflib

`trimesh` exports a `.glb`; for explicit Draco control and to verify the buffer, round-trip through `pygltflib`. Draco compression is what makes the payload streamable inside a 3D Tile.

```python
import trimesh, pygltflib

# trimesh writes a binary glTF; Draco is applied when the optional encoder is present.
mesh.export("building_block.glb")

gltf = pygltflib.GLTF2().load("building_block.glb")
assert gltf.asset.version == "2.0"
# Confirm the semantic payload survived the export.
node_extras = gltf.nodes[0].extras or {}
print("embedded extras:", node_extras)
print("draco ext:", "KHR_draco_mesh_compression" in (gltf.extensionsUsed or []))
```

### 4. Derive a query-able vector layer with GDAL/OGR

The building footprint and attributes belong in a GeoPackage for SQL queries, and in 3D GeoJSON (EPSG:4326) for web delivery. `ogr2ogr` reprojects explicitly — never rely on its defaults.

```python
import subprocess

# Footprint is authored in GeoPackage (EPSG:32618); derive WGS84 GeoJSON for the web.
subprocess.run([
    "ogr2ogr", "-f", "GeoJSON",
    "-s_srs", "EPSG:32618", "-t_srs", "EPSG:4326",
    "-dim", "XYZ", "buildings_4326.geojson", "buildings.gpkg",
], check=True)

# Confirm the output CRS and dimensionality.
info = subprocess.run(
    ["ogrinfo", "-so", "-al", "buildings_4326.geojson"],
    capture_output=True, text=True, check=True,
).stdout
assert "WGS 84" in info or "4326" in info, "GeoJSON CRS is not EPSG:4326"
```

### 5. Wrap glTF in a 3D Tiles tileset

The streaming derivative anchors the metric glTF at its EPSG:4326 origin via the tile transform, and declares a `geometricError` so clients can page LOD.

```python
import json, numpy as np
from pyproj import Transformer

# Tile origin: place the metric mesh at its geographic position (EPSG:4326).
to_ecef = Transformer.from_crs("EPSG:4326", "EPSG:4978", always_xy=True)
lon, lat, h = -73.9857, 40.7484, 14.0   # tile anchor
x, y, z = to_ecef.transform(lon, lat, h)

tileset = {
    "asset": {"version": "1.1"},
    "geometricError": 70.0,
    "root": {
        "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x, y, z, 1],
        "boundingVolume": {"region": [
            np.radians(-73.986), np.radians(40.748),
            np.radians(-73.985), np.radians(40.749), 0, 80]},
        "geometricError": 0.0,
        "content": {"uri": "building_block.glb"},
    },
}
with open("tileset.json", "w") as f:
    json.dump(tileset, f, indent=2)
```

## Validation & Verification

<figure class="diagram">
<svg viewBox="6 -3 744 309" role="img" aria-labelledby="fmt-crsslot-t fmt-crsslot-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-crsslot-t">Where each container keeps its coordinate reference system</title>
  <desc id="fmt-crsslot-d">CityGML, LAS or LAZ, and GeoTIFF each hold an EPSG-identified CRS in a defined field. 3D Tiles holds a geocentric root transform but no EPSG string. glTF has no standard slot and relies on a convention in asset extras. OBJ has nowhere at all to record one.</desc>
  <rect class="svg-bg" x="6" y="-3" width="744" height="309" fill="#ffffff"/>
  <text x="110" y="24" fill="#5b6471" font-size="12" text-anchor="middle">container</text>
  <text x="476" y="24" fill="#5b6471" font-size="12" text-anchor="middle">where the CRS actually lives</text>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="20" y="34" width="180" height="38" rx="8"/>
    <rect x="216" y="34" width="520" height="38" rx="8"/>
    <rect x="20" y="78" width="180" height="38" rx="8"/>
    <rect x="216" y="78" width="520" height="38" rx="8"/>
    <rect x="20" y="122" width="180" height="38" rx="8"/>
    <rect x="216" y="122" width="520" height="38" rx="8"/>
  </g>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="20" y="166" width="180" height="38" rx="8"/>
    <rect x="216" y="166" width="520" height="38" rx="8"/>
    <rect x="20" y="210" width="180" height="38" rx="8"/>
    <rect x="216" y="210" width="520" height="38" rx="8"/>
  </g>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="2">
    <rect x="20" y="254" width="180" height="38" rx="8"/>
    <rect x="216" y="254" width="520" height="38" rx="8"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="110" y="58">CityGML</text>
    <text x="110" y="102">LAS / LAZ</text>
    <text x="110" y="146">GeoTIFF</text>
    <text x="110" y="190">3D Tiles</text>
    <text x="110" y="234">glTF 2.0</text>
    <text x="110" y="278">OBJ</text>
    <text x="476" y="58">gml:Envelope srsName=&quot;EPSG:25832&quot; — declared and schema-validated</text>
    <text x="476" y="102">WKT or GeoTIFF-key VLR, with global_encoding bit 4 naming the winner</text>
    <text x="476" y="146">GeoKeyDirectory plus ModelTiepoint tags in the file header</text>
    <text x="476" y="190">root transform into geocentric EPSG:4978 — a matrix, not an EPSG string</text>
    <text x="476" y="234">no standard slot; asset.extras by convention, which no viewer acts on</text>
    <text x="476" y="278">nowhere — the CRS has to travel in a sidecar or be lost</text>
  </g>
</svg>
<figcaption>Three containers state the CRS, one implies it as a matrix, and two cannot hold it at all. A conversion that crosses those tiers needs the CRS carried out of band.</figcaption>
</figure>

Every conversion crosses a format boundary where CRS metadata and semantics can be dropped. Assert parity rather than trust the writer.

Validate the tileset structure and CRS-anchored root with the official validator and a `pyproj` round-trip:

```python
import subprocess, json
from pyproj import Transformer

# Schema validation via the OGC 3d-tiles-validator (npm).
subprocess.run(["3d-tiles-validator", "--tilesetFile", "tileset.json"], check=True)

# CRS parity: the root transform origin must round-trip back to the source lon/lat.
with open("tileset.json") as f:
    t = json.load(f)["root"]["transform"]
x, y, z = t[12], t[13], t[14]
from_ecef = Transformer.from_crs("EPSG:4978", "EPSG:4326", always_xy=True)
lon, lat, _ = from_ecef.transform(x, y, z)
assert abs(lon - (-73.9857)) < 1e-4 and abs(lat - 40.7484) < 1e-4, "tile anchor CRS drift"
```

Verify the vector derivative preserved both attributes and CRS — `ogrinfo` should report EPSG:4326 and the original field set:

```python
import subprocess
out = subprocess.run(
    ["ogrinfo", "-so", "-al", "buildings_4326.geojson"],
    capture_output=True, text=True, check=True,
).stdout
for field in ("asset_id", "construction_year"):
    assert field in out, f"attribute '{field}' lost in conversion"
```

Expected results: the validator exits 0, the anchor round-trips to within 1e-4 degrees (~10 m at this latitude is far looser than the 1e-4° assertion, which is ~11 m — tighten to 1e-6 for survey work), and every authored field appears in `ogrinfo`. A non-zero validator exit or a missing field must fail the build.

## Performance & Scale

Format choice dominates payload size and client memory. For a 50,000-triangle textured building, an uncompressed `.glb` runs ~3.4 MB; the same mesh with `KHR_draco_mesh_compression` drops to ~0.4–0.6 MB — a 6–8x reduction — at the cost of ~15–40 ms decode per tile on the client. `EXT_meshopt_compression` trades a slightly larger payload (~0.7 MB) for near-zero decode latency, which is the better choice when the client is GPU-bound rather than bandwidth-bound.

LAS to LAZ compression with LASzip is lossless and typically 7–10x; a 1 km² urban tile at 16 pts/m² is ~120 MB as `.las` and ~14 MB as `.laz`, and Cloud-Optimized Point Cloud (COPC) layout adds spatial chunking so a client reads only the octree nodes in view.

At city scale, never hold the full model in memory. Tile to ~1 km² footprints, generate one tileset per district, and reference them from a parent `tileset.json` so the client streams by frustum. CityGML and IFC have no streaming path — convert them to 3D Tiles offline in a CI/CD job, chunking by feature with `numpy.memmap`-backed buffers or a `dask` bag when a single source file exceeds RAM. The detailed tiling step is covered under [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) within [LOD management](https://www.3d-geospatial.com/lod-management-optimization-strategies/).

Schema validation cost is also a scale factor that teams underestimate. Validating a CityGML file against its full XSD is O(document size) and can take tens of seconds for a large municipal export, so run it once at ingestion rather than on every CI build. The `3d-tiles-validator` is comparatively cheap per tile but multiplies across thousands of tiles — validate a representative sample plus every tile touched by a change set, not the entire pyramid, to keep build times bounded. For LAS/LAZ, prefer COPC's spatial chunking so validation and rendering both read only the octree nodes a query needs, which keeps verification linear in the viewport rather than in the full cloud.

## Failure Modes & Gotchas

- **Attribute loss on glTF export.** glTF has no semantic schema, so any field not explicitly written to `extras` or a `KHR_*` extension is silently dropped. A building's `construction_year` and `asset_id` vanish unless you map them — assert their presence after every export, treating a missing field as a build failure.
- **IFC has no CRS.** IfcOpenShell returns coordinates in IFC's project-local frame. If you export to glTF or 3D Tiles without applying the `IfcMapConversion`/`IfcProjectedCRS` (or an externally supplied EPSG transform), the building lands at the origin of the map or floats kilometres off. Always georeference explicitly on import.
- **3D GeoJSON forces EPSG:4326.** RFC 7946 mandates WGS84 (CRS84) and ignores any embedded `crs` member. Writing metric UTM coordinates into a `.geojson` and assuming readers honour a custom CRS produces points off the coast of Africa. Reproject with `ogr2ogr -t_srs EPSG:4326` before serializing.
- **OBJ silently strips units and CRS.** OBJ is dimensionless ASCII with no spatial reference. A mesh exported to OBJ and re-imported loses its metric scale and EPSG entirely; treat OBJ only as a throwaway intermediate, never as an authoritative store.
- **Draco quantization clobbers precision.** Default Draco position quantization (11–14 bits) is fine for visual meshes but can shift survey-grade vertices by centimetres. For metrology, raise the quantization bits or keep an uncompressed canonical copy and ship Draco only as a derived web payload.

## Frequently Asked Questions

### Which format should be my single internal source of truth?

None of the delivery formats. Keep a canonical store that holds geometry, attributes, and an explicit CRS — commonly a GeoPackage for attributes plus uncompressed glTF or the original survey product for geometry — and generate 3D Tiles, Draco glTF, and 3D GeoJSON as versioned, disposable derivatives. That way a quantization or schema bug in one output never corrupts your authoritative data.

### How do I convert CityGML or IFC to 3D Tiles without losing semantics?

Map the source attributes explicitly into the tileset's feature-table/metadata or each glTF node's `extras` during conversion. For IFC, parse property sets with IfcOpenShell and apply the georeferencing (`IfcMapConversion` or an external EPSG transform) before export. For CityGML, carry the `gml:id` and ADE attributes into batch IDs. Then assert every required field survives — see the [Validation & Verification](#validation-verification) checks above.

### Is glTF or 3D Tiles the right choice for a web twin?

They are complementary, not alternatives. glTF is the geometry payload; 3D Tiles is the spatial index and streaming wrapper around glTF. A single building can ship as glTF; a city must ship as 3D Tiles so the client pages by screen-space error. The full trade-off, including OBJ, is in [glTF vs 3D Tiles vs OBJ for spatial data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/).

### Does LAZ lose any data compared to LAS?

No. LAZ (LASzip) is lossless — it reconstructs every coordinate, classification, and intensity value bit-for-bit, typically at 7–10x compression. The lossy trade-off only appears if you reduce coordinate scale/offset precision in the LAS header before compressing, which is a separate decision from the LAZ encoding itself.

### How do I keep CRS metadata intact across every conversion?

Declare the EPSG code at each stage and verify it on the other side. Use `ogr2ogr -s_srs/-t_srs` with explicit codes for vector formats, anchor 3D Tiles via a transform you can round-trip with `pyproj`, and write `source_crs` into glTF `extras`. The transformation mechanics are covered in [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) and the practical step of [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/).

## Related Guides

- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — the head-to-head on the three web-delivery formats
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — CRS and datum handling that every conversion depends on
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — terrain raster generation and registration
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — turning canonical geometry into streamable tilesets
- [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) — producing the meshes these formats carry

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
