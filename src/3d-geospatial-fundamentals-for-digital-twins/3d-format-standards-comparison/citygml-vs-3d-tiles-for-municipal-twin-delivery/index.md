---
title: "CityGML vs 3D Tiles for Municipal Twin Delivery"
description: "When to author in CityGML (LOD0–4, EPSG:25832) and stream via 3D Tiles: convert with py3dtiles, reproject to EPSG:4978, and preserve semantics into batch tables"
---
# CityGML vs 3D Tiles for Municipal Digital-Twin Delivery

This page settles a decision municipal twin teams face constantly: should a city model live as **CityGML** or as **OGC 3D Tiles**? The short answer is that they are not competitors — CityGML is the semantic city model you author, store, and query (LOD0–LOD4 building parts, application domain extensions, per-feature attributes), while 3D Tiles is the runtime format you stream to a browser. You keep the authoritative model in CityGML, then derive a 3D Tiles tileset for delivery. This guide compares the two on the axes that decide a municipal pipeline, then walks the CityGML → 3D Tiles conversion end to end with `lxml`, `pyproj`, and `py3dtiles`, carrying the semantic attributes into the tileset's batch table so a click on a building in Cesium still returns its `gml:id`, function code, and construction year.

You hit this the moment a planning department that has invested years in a CityGML register — stored in EPSG:25832 (ETRS89 / UTM zone 32N), the standard grid across much of central Europe — wants it live in a web viewer. CityGML has no streaming path: a single municipal export can be gigabytes of verbose XML that no browser will parse. The resolution is a one-way derivation, and the two formats' respective strengths make the split natural rather than a compromise.

<figure class="diagram">
<svg viewBox="0 0 840 320" role="img" aria-labelledby="cgml-3dt-t cgml-3dt-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cgml-3dt-t">Store in CityGML, stream via 3D Tiles</title>
  <desc id="cgml-3dt-d">A CityGML store in EPSG:25832 holding building semantics and LOD0 to LOD4 geometry is converted by a reprojection and tiling step into a 3D Tiles tileset in EPSG:4978, whose batch table preserves the per-feature attributes for a streaming Cesium client.</desc>
  <defs>
    <marker id="cgml-3dt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="70" width="190" height="150" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="325" y="95" width="190" height="100" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="630" y="70" width="190" height="150" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#cgml-3dt-arrow)">
    <line x1="210" y1="145" x2="323" y2="145"/>
    <line x1="515" y1="145" x2="628" y2="145"/>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="115" y="100" font-size="14">CityGML store</text>
    <text x="115" y="132"><tspan x="115" dy="0">EPSG:25832</tspan><tspan x="115" dy="16">LOD0–LOD4 parts</tspan><tspan x="115" dy="16">attributes + ADEs</tspan></text>
    <text x="420" y="130" font-size="14">Convert</text>
    <text x="420" y="158"><tspan x="420" dy="0">reproject + tile</tspan><tspan x="420" dy="16">py3dtiles</tspan></text>
    <text x="725" y="100" font-size="14">3D Tiles</text>
    <text x="725" y="132"><tspan x="725" dy="0">EPSG:4978 ECEF</tspan><tspan x="725" dy="16">b3dm + batch table</tspan><tspan x="725" dy="16">streams to Cesium</tspan></text>
  </g>
  <text x="115" y="245" fill="#5b6471" font-size="12" text-anchor="middle">Authoritative source</text>
  <text x="725" y="245" fill="#5b6471" font-size="12" text-anchor="middle">Disposable derivative</text>
  <text x="420" y="285" fill="#1f2937" font-size="13" text-anchor="middle">Author and analyse once; regenerate the tileset whenever the register changes</text>
</svg>
<figcaption>CityGML holds the semantics and CRS; the 3D Tiles tileset is a regenerable derivative that streams the same features to the browser.</figcaption>
</figure>

## Decision Table

Read this as a division of labour, not a ranking — most municipal twins run both, with CityGML as the register and 3D Tiles as the front end. The wider format landscape (IFC, glTF, OBJ, GeoPackage) is mapped in the [3D format standards comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).

| Criterion | CityGML | OGC 3D Tiles |
|---|---|---|
| Primary role | Author / store / analyse | Stream / visualize |
| Semantic model | Rich — walls, roofs, rooms, ADEs, validating XSD | Feature table / batch IDs only |
| Level of detail | Explicit LOD0–LOD4 per feature | Hierarchical `geometricError` refinement |
| CRS handling | Native `srsName`, e.g. EPSG:25832 | Root transform to EPSG:4978 (ECEF) |
| Streaming | None — parse the whole document | Native progressive paging by screen-space error |
| Attribute query | XPath / 3DCityDB SQL | Batch-table pick at runtime |
| Payload | Verbose gzipped XML | Draco-compressed b3dm |
| Best at | Regulatory archival, city-wide analysis | Browser delivery of the whole city |

**Verdict.** Do not choose one. Keep CityGML as the single source of truth for the municipal register — it is the only format here that stores building semantics, LOD0–LOD4, and a validating schema together — and treat 3D Tiles as a disposable, versioned derivative generated in CI. Convert in the direction CityGML → 3D Tiles only, never the reverse, because the tileset physically cannot reconstruct the ADE attributes or the LOD4 interior geometry it never stored. When a planner edits the register, regenerate the affected tiles; the authoritative model and the streamed one stay in lockstep because one is computed from the other.

## Prerequisites

- Python 3.11 with `lxml>=5.0` for namespaced CityGML parsing, `pyproj>=3.6` (PROJ 9.x) for the reprojection chain, `numpy>=1.24`, and `py3dtiles>=8.0` for tileset assembly. Install with `pip install "lxml>=5.0" "pyproj>=3.6" numpy "py3dtiles>=8.0"`.
- A CityGML 2.0 or 3.0 dataset with an explicit `srsName`. The examples use EPSG:25832 (ETRS89 / UTM 32N, metres), the standard German/central-European store; substitute your national grid but state it.
- For heavy production conversion, the Java `citygml-tools` CLI (`citygml-tools to-cityjson`) or FME's CityGML reader handle full LOD4 solids and ADEs more completely than a hand-rolled parser; the `lxml` path below is for LOD1/LOD2 building shells and for understanding exactly what crosses the boundary.
- Familiarity with why Cesium needs EPSG:4978 — the geocentric Earth-Centered Earth-Fixed frame — is assumed; the [coordinate reference systems](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) guide covers the reprojection theory.

## Step-by-Step

### 1. Parse the CityGML and read its declared CRS

CityGML is namespaced XML. Read the `srsName` off the envelope first — never assume it — then enumerate the `bldg:Building` features and their attributes with explicit namespace maps.

```python
from lxml import etree

NS = {
    "gml": "http://www.opengis.net/gml",
    "bldg": "http://www.opengis.net/citygml/building/2.0",
    "core": "http://www.opengis.net/citygml/2.0",
}

tree = etree.parse("dresden_lod2.gml")
root = tree.getroot()

srs = root.find(".//gml:Envelope", NS).get("srsName")
print("declared CRS:", srs)                 # expect EPSG:25832 (or urn:...::25832)
assert "25832" in srs, "unexpected source CRS — state it explicitly before tiling"

buildings = root.findall(".//bldg:Building", NS)
print("building features:", len(buildings))
```

### 2. Extract per-building geometry and the semantic attributes

Each building carries a `gml:id` plus attributes the twin must keep — function code, roof type, measured height, construction year. Pull the exterior `gml:posList` (LOD2 wall/roof surfaces) as a flat coordinate array in EPSG:25832, and collect the attributes into a record that becomes one batch-table row later.

```python
import numpy as np

def building_records(buildings):
    for b in buildings:
        gml_id = b.get("{http://www.opengis.net/gml}id")
        attrs = {
            "gml_id": gml_id,
            "function": (b.findtext("bldg:function", default="", namespaces=NS)),
            "year_built": (b.findtext("bldg:yearOfConstruction", default="", namespaces=NS)),
            "roof_type": (b.findtext("bldg:roofType", default="", namespaces=NS)),
            "measured_height": (b.findtext("bldg:measuredHeight", default="", namespaces=NS)),
        }
        pos = []
        for pl in b.findall(".//gml:posList", NS):
            vals = [float(v) for v in pl.text.split()]
            pos.append(np.asarray(vals, dtype=np.float64).reshape(-1, 3))  # X,Y,Z in EPSG:25832
        if pos:
            yield attrs, np.vstack(pos)

records = list(building_records(buildings))
print("extracted", len(records), "buildings with geometry")
```

### 3. Reproject EPSG:25832 → EPSG:4979 → EPSG:4978 for Cesium

Cesium renders in geocentric ECEF (EPSG:4978). Go through geographic-3D EPSG:4979 so the ellipsoidal height is handled explicitly rather than transforming a projected CRS straight to ECEF — the classic mistake that lands a tileset kilometres underground.

```python
from pyproj import Transformer

to_geographic = Transformer.from_crs("EPSG:25832", "EPSG:4979", always_xy=True)
to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)

def to_ecef_coords(xyz):
    lon, lat, h = to_geographic.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2])
    x, y, z = to_ecef.transform(lon, lat, h)
    return np.column_stack([x, y, z])

ecef_geoms = [to_ecef_coords(geom) for _, geom in records]
# Sanity-check: every vertex must sit on the ellipsoid (~6.38e6 m from the geocentre).
radii = np.linalg.norm(np.vstack(ecef_geoms), axis=1)
assert (6.3e6 < radii).all() and (radii < 6.5e6).all(), "vertices not on the ellipsoid — CRS chain wrong"
```

### 4. Tile with py3dtiles and preserve attributes in the batch table

`py3dtiles` writes the `tileset.json` tree and the `b3dm` payloads. The load-bearing step for a municipal twin is mapping each CityGML attribute record onto the tile's batch table, keyed by the same feature order as the geometry, so `gml_id` and `year_built` survive into the runtime pick. For large registers, drive `citygml-tools` first to normalise LOD and then feed the result to `py3dtiles`.

```python
import json, subprocess
from pathlib import Path

# Batch table: one row per building, column-major, aligned with the b3dm feature order.
batch_table = {
    "gml_id": [a["gml_id"] for a, _ in records],
    "function": [a["function"] for a, _ in records],
    "year_built": [a["year_built"] for a, _ in records],
    "roof_type": [a["roof_type"] for a, _ in records],
}
Path("batch_table.json").write_text(json.dumps(batch_table))

# Production path: convert via CityJSON, then tile. py3dtiles reads the intermediate.
subprocess.run(["citygml-tools", "to-cityjson", "dresden_lod2.gml"], check=True)
subprocess.run([
    "py3dtiles", "convert", "dresden_lod2.city.json",
    "--srs_in", "25832", "--srs_out", "4978",
    "--out", "tileset/",
], check=True)
print("wrote tileset/tileset.json in EPSG:4978 with", len(records), "batched features")
```

## Expected Output & Verification

A correct run leaves a `tileset/tileset.json` whose root sits on the ellipsoid and whose leaves carry the batched attributes. Assert the CRS placement and the semantic survival, then validate the schema:

```python
import json, numpy as np

ts = json.load(open("tileset/tileset.json"))
tx, ty, tz = ts["root"]["transform"][12:15]
print("root ECEF radius:", round(np.linalg.norm([tx, ty, tz])), "m")   # ~6.38e6, not ~0

bt = json.load(open("batch_table.json"))
assert bt["gml_id"], "no features batched"
assert all(bt["year_built"]), "year_built dropped in conversion"
```

Expected console output for a small LOD2 export:

```text
declared CRS: urn:ogc:def:crs,crs:EPSG::25832,crs:EPSG::5783
building features: 1284
extracted 1284 buildings with geometry
wrote tileset/tileset.json in EPSG:4978 with 1284 batched features
root ECEF radius: 6371207 m
```

Then run the official validator and load in Cesium; a pick should return the `gml_id`:

```bash
npx 3d-tiles-validator --tilesetFile tileset/tileset.json
```

The [OGC 3D Tiles specification](https://www.ogc.org/standard/3dtiles/) requires a non-negative, monotonically decreasing `geometricError` and parent-contained bounding volumes — the validator checks both.

## Common Errors

**`AttributeError: 'NoneType' object has no attribute 'get'` on the envelope.** The `srsName` was read with the wrong namespace, or the CityGML uses a `urn:ogc:def:crs` compound identifier rather than a bare `EPSG:25832`. Parse the URN and pull the horizontal code (`25832`) out of it before handing it to `pyproj`; never hard-code the CRS.

**Tileset renders at the centre of the Earth or several kilometres below terrain.** You reprojected EPSG:25832 straight to EPSG:4978 without the EPSG:4979 hop, so the projected height was fed to a geocentric frame that expects an ellipsoidal height. Chain EPSG:25832 → EPSG:4979 → EPSG:4978 as in step 3, and assert every vertex radius lands near 6.38e6 m.

**Clicking a building in Cesium returns nothing.** The batch table was written but not aligned to the b3dm feature order, so `_BATCHID` indices point at the wrong rows or none at all. Build the batch table in the same iteration order as the geometry, and confirm the feature count in `tileset.json` equals `len(records)` before shipping.

## Related Guides

- [glTF vs 3D Tiles vs OBJ for Spatial Data](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — the web-delivery formats that sit inside a tileset
- [3D Format Standards Comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — the full CityGML/IFC/glTF/LAS trade-off matrix
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the EPSG:25832 → EPSG:4978 chain in depth
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — building the tileset hierarchy at city scale

Back to [3D Format Standards Comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
