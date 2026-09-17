# Defining Tileset and Group Metadata

This page authors a 3D Tiles 1.1 metadata schema for a city twin and attaches values at every level the specification allows — tileset, group, tile, content and per-feature — so a client can filter, style and query without a side-channel API, and validates the result.

## Why you hit this

A tileset without metadata is geometry with no meaning. The client can draw it and cannot answer "show me buildings built before 1960", "which district does this tile belong to?" or "what is this building's identifier in the property register?". The usual workaround is a separate API keyed by a feature id, which works and adds a service, a deployment and a latency to every interaction.

3D Tiles 1.1 folds the whole structure into the tileset: a schema defines classes and properties, property tables hold per-feature values, and tiles, contents and groups carry their own property values. Once it is in place, `Cesium3DTileStyle` expressions can reference it directly and filtering happens on the GPU.

## Prerequisites

- A 3D Tiles 1.1 tileset — see [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/).
- Feature identifiers in the glTF content, from `EXT_mesh_features` or a `_FEATURE_ID_0` attribute.
- Python 3.10+; `3d-tiles-validator` via `npx`.

## Step-by-Step

### 1. Write the schema before any values

```python
import json
from pathlib import Path

SCHEMA = {
    "id": "city-twin-schema-1",
    "name": "City twin metadata",
    "version": "1.0.0",
    "enums": {
        "buildingFunction": {
            "name": "Building function",
            "valueType": "UINT8",
            "values": [
                {"name": "residential", "value": 0},
                {"name": "commercial", "value": 1},
                {"name": "industrial", "value": 2},
                {"name": "civic", "value": 3},
                {"name": "mixed", "value": 4},
                {"name": "unknown", "value": 255},
            ],
        },
        "dataQuality": {
            "name": "Source data quality",
            "valueType": "UINT8",
            "values": [
                {"name": "surveyed", "value": 0},
                {"name": "photogrammetric", "value": 1},
                {"name": "extruded_footprint", "value": 2},
                {"name": "estimated", "value": 3},
            ],
        },
    },
    "classes": {
        "building": {
            "name": "Building",
            "properties": {
                "registerId":        {"type": "STRING", "required": True},
                "function":          {"type": "ENUM", "enumType": "buildingFunction",
                                      "required": True},
                "yearOfConstruction": {"type": "SCALAR", "componentType": "UINT16",
                                       "required": False, "noData": 0},
                "measuredHeight":    {"type": "SCALAR", "componentType": "FLOAT32",
                                      "required": False, "noData": -1.0},
                "storeysAboveGround": {"type": "SCALAR", "componentType": "UINT8",
                                       "required": False, "noData": 255},
                "quality":           {"type": "ENUM", "enumType": "dataQuality",
                                      "required": True},
                "lastSurveyed":      {"type": "STRING", "required": False},
            },
        },
        "district": {
            "name": "District",
            "properties": {
                "districtCode": {"type": "STRING", "required": True},
                "districtName": {"type": "STRING", "required": True},
                "population":   {"type": "SCALAR", "componentType": "UINT32",
                                 "required": False},
            },
        },
        "tileProvenance": {
            "name": "Tile provenance",
            "properties": {
                "sourceDelivery": {"type": "STRING", "required": True},
                "tiledAt":        {"type": "STRING", "required": True},
                "lodLevel":       {"type": "SCALAR", "componentType": "UINT8",
                                   "required": True},
                "featureCount":   {"type": "SCALAR", "componentType": "UINT32",
                                   "required": False},
            },
        },
    },
}
```

Enums rather than free-text strings for anything with a fixed vocabulary is the decision that pays off most. An enum value is one byte per feature instead of a variable-length string, comparisons in a style expression are integer comparisons, and a typo in the pipeline becomes a validation error rather than a category nobody notices is empty.

`noData` deserves attention. Without it, a building with no recorded construction year has to carry some value, and whatever value is chosen — 0, 1900, −1 — will eventually be plotted on a histogram as if it were real. Declaring it means the client knows to exclude it, and `required: False` means the property may be absent entirely.

Versioning the schema in its `id` and `version` is what lets a client written against version 1 refuse a tileset built against version 2 rather than silently misreading it.

### 2. Attach values at the tileset level

```python
def tileset_metadata(doc, schema, statistics=None):
    """Properties that describe the whole dataset."""
    doc["schema"] = schema
    doc["metadata"] = {
        "class": "district",
        "properties": {
            "districtCode": "OSL-ALL",
            "districtName": "Oslo municipality",
            "population": 709037,
        },
    }
    if statistics:
        doc["statistics"] = statistics
    return doc

def build_statistics(features):
    """Optional but valuable: lets a client build legends without scanning content."""
    years = [f["yearOfConstruction"] for f in features if f.get("yearOfConstruction")]
    heights = [f["measuredHeight"] for f in features if f.get("measuredHeight", -1) > 0]
    from collections import Counter
    fn = Counter(f["function"] for f in features)
    return {
        "classes": {
            "building": {
                "count": len(features),
                "properties": {
                    "yearOfConstruction": {"min": min(years), "max": max(years),
                                           "mean": round(sum(years) / len(years), 1)},
                    "measuredHeight": {"min": round(min(heights), 2),
                                       "max": round(max(heights), 2),
                                       "mean": round(sum(heights) / len(heights), 2)},
                    "function": {"occurrences": dict(fn)},
                },
            }
        }
    }
```

The `statistics` block is optional and worth writing, because it is what lets a client choose a sensible colour ramp without downloading the city. A viewer that must scan every tile to find the minimum and maximum building height cannot draw a legend until the whole tileset is loaded — which is never.

Tileset-level metadata is the right home for anything that is true of the dataset: the licence, the coordinate reference system in human terms, the delivery it came from, the municipality it covers.

### 3. Use groups for properties shared by many contents

```python
def add_groups(doc, districts):
    """A group is a named bucket of contents sharing one set of property values."""
    doc["groups"] = []
    index = {}
    for i, d in enumerate(sorted(districts, key=lambda x: x["code"])):
        doc["groups"].append({
            "class": "district",
            "properties": {
                "districtCode": d["code"],
                "districtName": d["name"],
                "population": int(d["population"]),
            },
        })
        index[d["code"]] = i
    return doc, index

def assign_content_to_group(tile, group_index, district_code):
    content = tile.get("content")
    if content is None:
        return False
    content["group"] = group_index[district_code]
    return True
```

Groups exist so that a property shared by 400 tiles is stored once. Putting `districtName` on every tile costs 400 copies of a string and, worse, makes it impossible for a client to enumerate the districts without walking the whole tree; a group makes it one array lookup.

The other use for groups is visibility control. A client can hide a whole group with one style condition — `${districtCode} !== 'OSL-04'` — which is a cheaper and more reliable way to filter by administrative area than testing every feature.

<figure class="diagram">
<svg viewBox="10 10 720 258" role="img" aria-labelledby="meta-levels-t meta-levels-d" xmlns="http://www.w3.org/2000/svg">
  <title id="meta-levels-t">The five levels metadata can attach to</title>
  <desc id="meta-levels-d">A hierarchy of metadata scopes. Tileset-level metadata describes the whole dataset and is stored once. Group metadata describes a set of contents, such as a district, and is stored once per group. Tile metadata describes one tile, typically its provenance and level of detail. Content metadata describes one content file. Feature metadata, held in property tables inside the glTF, describes each individual building. Choosing the highest level that fits avoids storing the same value thousands of times.</desc>
  <rect class="svg-bg" x="10" y="10" width="720" height="258" fill="#ffffff"/>
  <g stroke-width="1.6">
    <rect x="24" y="24" width="692" height="38" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="70" y="72" width="600" height="38" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="116" y="120" width="508" height="38" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="162" y="168" width="416" height="38" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="208" y="216" width="324" height="38" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="370" y="48">tileset — licence, CRS, statistics · stored once</text>
    <text x="370" y="96">group — district code and name · once per district (12)</text>
    <text x="370" y="144">tile — provenance, LOD level · once per tile (6,147)</text>
    <text x="370" y="192">content — per content file, when a tile has several</text>
    <text x="370" y="240">feature — register id, year, height · per building (412k)</text>
  </g>
</svg>
<figcaption>Every value belongs at the highest level where it is still true; pushing a district name down to features costs 412,000 copies.</figcaption>
</figure>

### 4. Put per-feature values in a property table

```python
import struct

import numpy as np

def build_property_table(features, schema_class="building"):
    """Column-oriented: one buffer per property, indexed by feature id."""
    n = len(features)
    order = sorted(features, key=lambda f: f["featureId"])
    assert [f["featureId"] for f in order] == list(range(n)), \
        "feature ids must be contiguous from 0"

    columns = {}

    # STRING: a data buffer plus offsets.
    for name in ("registerId", "lastSurveyed"):
        blob, offsets = bytearray(), [0]
        for f in order:
            blob.extend(str(f.get(name) or "").encode("utf-8"))
            offsets.append(len(blob))
        columns[name] = {
            "kind": "string",
            "values": bytes(blob),
            "offsets": np.asarray(offsets, dtype=np.uint32).tobytes(),
            "offsetType": "UINT32",
        }

    # ENUM: one byte per feature.
    enum_maps = {
        "function": {v["name"]: v["value"]
                     for v in SCHEMA["enums"]["buildingFunction"]["values"]},
        "quality": {v["name"]: v["value"]
                    for v in SCHEMA["enums"]["dataQuality"]["values"]},
    }
    for name, mapping in enum_maps.items():
        vals = np.asarray([mapping.get(f.get(name), mapping.get("unknown", 255))
                           for f in order], dtype=np.uint8)
        columns[name] = {"kind": "enum", "values": vals.tobytes()}

    # SCALAR columns, with the declared noData for absent values.
    scalars = {
        "yearOfConstruction": (np.uint16, 0),
        "storeysAboveGround": (np.uint8, 255),
        "measuredHeight": (np.float32, -1.0),
    }
    for name, (dtype, no_data) in scalars.items():
        vals = np.asarray([f.get(name, no_data) if f.get(name) is not None else no_data
                           for f in order], dtype=dtype)
        columns[name] = {"kind": "scalar", "values": vals.tobytes(),
                         "componentType": str(np.dtype(dtype).name).upper()}

    return {"class": schema_class, "count": n, "columns": columns}

def property_table_bytes(table):
    return sum(len(c["values"]) + len(c.get("offsets", b"")) for c in table["columns"].values())
```

Column-oriented storage is not an implementation detail — it is what makes the format usable. A style expression that colours by `yearOfConstruction` reads one contiguous `uint16` array of 412,000 values, 824 KB, and ignores every other property. A row-oriented layout would require touching all of it.

Feature ids must be contiguous from zero, because they are array indices. The assertion is there because a pipeline that filters features after assigning ids leaves gaps, and the resulting tileset reads the wrong row for every feature after the first gap — which looks like plausible but wrong data, the hardest kind of bug to notice.

The property table lives inside the glTF content, under `EXT_structural_metadata`, with the feature ids supplied by `EXT_mesh_features`. That is a change from 1.0's batch table and it is the reason standard glTF tools can now read tile metadata.

### 5. Attach tile-level provenance

```python
def add_tile_metadata(tile, delivery, tiled_at, lod_level, feature_count=None):
    tile["metadata"] = {
        "class": "tileProvenance",
        "properties": {
            "sourceDelivery": delivery,
            "tiledAt": tiled_at,
            "lodLevel": int(lod_level),
            **({"featureCount": int(feature_count)} if feature_count is not None else {}),
        },
    }
    return tile

def walk_and_annotate(doc, delivery, tiled_at, counts_by_uri):
    annotated = 0
    def walk(tile, depth=0):
        nonlocal annotated
        uri = (tile.get("content") or {}).get("uri")
        if uri:
            add_tile_metadata(tile, delivery, tiled_at, depth,
                              counts_by_uri.get(uri))
            annotated += 1
        for child in tile.get("children", []):
            walk(child, depth + 1)
    walk(doc["root"])
    return {"tiles_annotated": annotated}
```

Tile-level provenance is the metadata that saves the most time during an incident. When a district looks wrong, the question is always "which delivery produced this, and when was it tiled?", and having the answer in the tile itself means a viewer can show it on click rather than someone correlating timestamps in a build log.

Recording `featureCount` per tile is also what makes the balance check in [balancing tile content size across levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/balancing-tile-content-size-across-levels/) possible without opening every content file.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="meta-types-t meta-types-d" xmlns="http://www.w3.org/2000/svg">
  <title id="meta-types-t">Property types and what each costs per feature</title>
  <desc id="meta-types-d">A table of five metadata property types with their per-feature cost and when to use each. A string costs ten to fifteen bytes plus a four-byte offset and is only justified for an identifier. An enum costs one byte and should replace every closed vocabulary. UINT16 costs two bytes and suits years and counts. FLOAT32 costs four and suits measured values. A boolean costs one bit in a packed array.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="424" y="20" width="298" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="196" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="214" y="54" width="210" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="424" y="54" width="298" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="88" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="88" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="424" y="88" width="298" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="122" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="424" y="122" width="298" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="156" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="424" y="156" width="298" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="190" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="424" y="190" width="298" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="42">type</text><text x="319" y="42">bytes per feature</text><text x="573" y="42">use it for</text>
    <text x="116" y="76">STRING</text><text x="319" y="76">10–15 + 4 offset</text><text x="573" y="76">identifiers only</text>
    <text x="116" y="110">ENUM</text><text x="319" y="110">1</text><text x="573" y="110">every closed vocabulary</text>
    <text x="116" y="144">SCALAR UINT16</text><text x="319" y="144">2</text><text x="573" y="144">years, storey counts</text>
    <text x="116" y="178">SCALAR FLOAT32</text><text x="319" y="178">4</text><text x="573" y="178">measured heights and areas</text>
    <text x="116" y="212">BOOLEAN</text><text x="319" y="212">1 bit packed</text><text x="573" y="212">flags</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Across 412,000 buildings, replacing one string property with an enum saves about 5 MB.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">Every referenced property column is downloaded with the tile, whether the style reads it or not.</text>
</svg>
<figcaption>One byte against fifteen is the whole argument for enums, and it is worth 5 MB on a city.</figcaption>
</figure>

### 6. Assemble and validate

```python
def assemble(tileset_path, out_path, features, districts, delivery, tiled_at):
    doc = json.loads(Path(tileset_path).read_text())
    doc = tileset_metadata(doc, SCHEMA, build_statistics(features))
    doc, group_index = add_groups(doc, districts)

    counts = {}
    def walk(tile):
        uri = (tile.get("content") or {}).get("uri")
        if uri:
            counts[uri] = counts.get(uri, 0)
            code = uri.split("/")[1] if "/" in uri else "OSL-ALL"
            if code in group_index:
                assign_content_to_group(tile, group_index, code)
        for c in tile.get("children", []):
            walk(c)
    walk(doc["root"])

    walk_and_annotate(doc, delivery, tiled_at, counts)
    Path(out_path).write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")))
    return {"path": out_path,
            "bytes": Path(out_path).stat().st_size,
            "groups": len(doc["groups"]),
            "classes": len(doc["schema"]["classes"]),
            "enums": len(doc["schema"]["enums"])}

import subprocess

def validate(path):
    proc = subprocess.run(["npx", "3d-tiles-validator", "--tilesetFile", path,
                           "--reportFile", "build/metadata_validation.json"],
                          capture_output=True, text=True)
    report = json.loads(Path("build/metadata_validation.json").read_text())
    issues = report.get("issues") or []
    metadata_issues = [i for i in issues
                       if "METADATA" in (i.get("type") or "")
                       or "SCHEMA" in (i.get("type") or "")]
    return {"exit": proc.returncode, "total_issues": len(issues),
            "metadata_issues": [i.get("type") for i in metadata_issues][:5],
            "ok": not [i for i in issues if i.get("severity") == "ERROR"]}
```

The validator checks the parts of this that are easy to get wrong and hard to notice: that every property referenced by a metadata entity exists in its class, that enum values are declared, that required properties are present, and that a `group` index points at a group that exists. All four are the kind of mistake a pipeline makes once and repeats 6,000 times.

<figure class="diagram">
<svg viewBox="26 12 688 240" role="img" aria-labelledby="meta-cost-t meta-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="meta-cost-t">Storage cost per property representation</title>
  <desc id="meta-cost-d">A bar chart of bytes per feature for different property representations across 412000 buildings. A variable-length string for building function averages 11.4 bytes per feature, or 4.7 megabytes. The same information as an enum costs 1 byte, or 0.41 megabytes. A construction year as a string costs 5 bytes; as UINT16 it costs 2. A district name repeated per feature costs 14 bytes; held once per group it costs effectively zero.</desc>
  <rect class="svg-bg" x="26" y="12" width="688" height="240" fill="#ffffff"/>
  <path d="M40 26 V194 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="290" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="68" width="26" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="102" width="128" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="136" width="51" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="170" width="358" height="26" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="340" y="52">function as STRING: 11.4 B/feature — 4.70 MB</text>
    <text x="76" y="86">function as ENUM: 1 B/feature — 0.41 MB</text>
    <text x="178" y="120">year as STRING: 5 B/feature — 2.06 MB</text>
    <text x="101" y="154">year as UINT16: 2 B/feature — 0.82 MB</text>
    <text x="408" y="188">district name per feature: 14 B — 5.77 MB</text>
  </g>
  <text x="40" y="216" fill="#1f2937" font-size="12.5">district name held once per group: 12 strings total — 0.0002 MB</text>
  <text x="40" y="234" fill="#5b6471" font-size="12">412,000 buildings — enums and the right scope save 12 MB across the tileset</text>
</svg>
<figcaption>The representation choices are worth about 12 MB on a city, and the district name is worth most of it.</figcaption>
</figure>

## Expected Output & Verification

```text
{'path': 'output/city/tileset.json', 'bytes': 2284117, 'groups': 12, 'classes': 3, 'enums': 2}
{'exit': 0, 'total_issues': 3, 'metadata_issues': [], 'ok': True}
property table: building, 412418 features, 3.94 MB
```

Three informational issues and no metadata issues is the expected result. A 3.94 MB property table for 412,000 buildings is about 10 bytes per feature, which is what the enum and integer choices buy — the same data as strings would be closer to 40.

Verify the schema and the values agree, which the validator checks structurally but not semantically:

```python
def schema_conformance_check(tileset_path, features):
    doc = json.loads(Path(tileset_path).read_text())
    schema = doc["schema"]
    problems = []

    for class_name, cls in schema["classes"].items():
        for prop_name, prop in cls["properties"].items():
            if prop.get("type") == "ENUM":
                enum_name = prop.get("enumType")
                if enum_name not in schema.get("enums", {}):
                    problems.append(f"{class_name}.{prop_name} references unknown enum "
                                    f"{enum_name}")

    building = schema["classes"]["building"]["properties"]
    allowed_functions = {v["name"] for v in schema["enums"]["buildingFunction"]["values"]}
    allowed_quality = {v["name"] for v in schema["enums"]["dataQuality"]["values"]}
    bad_function = {f["function"] for f in features if f.get("function") not in allowed_functions}
    bad_quality = {f["quality"] for f in features if f.get("quality") not in allowed_quality}
    missing_required = [f["featureId"] for f in features
                        if any(building[p].get("required") and f.get(p) in (None, "")
                               for p in building)]

    for entity, where in [(doc.get("metadata"), "tileset"),
                          *[(g, f"group[{i}]") for i, g in enumerate(doc.get("groups", []))]]:
        if not entity:
            continue
        cls = schema["classes"].get(entity["class"])
        if cls is None:
            problems.append(f"{where} references unknown class {entity['class']}")
            continue
        for prop in entity.get("properties", {}):
            if prop not in cls["properties"]:
                problems.append(f"{where} sets undeclared property {prop}")
        for prop, spec in cls["properties"].items():
            if spec.get("required") and prop not in entity.get("properties", {}):
                problems.append(f"{where} missing required property {prop}")

    return {"schema_problems": problems[:5],
            "undeclared_function_values": sorted(bad_function)[:5],
            "undeclared_quality_values": sorted(bad_quality)[:5],
            "features_missing_required": len(missing_required),
            "clean": not problems and not bad_function and not bad_quality
                     and not missing_required}

print(json.dumps(schema_conformance_check("output/city/tileset.json", FEATURES), indent=2))
```

An undeclared enum value is the most common real failure: a delivery introduces `"agricultural"` as a building function, the pipeline maps it to nothing, and every such building silently becomes `unknown`. Reporting the undeclared values rather than swallowing them is what turns that into a schema update.

Then verify the feature ids line up with the property table rows, which nothing else checks:

```python
def feature_id_alignment_check(content_paths, table_counts, sample=8):
    """Every content file's max feature id must be inside its table's row count."""
    import subprocess
    rows = []
    for path in sorted(content_paths)[:sample]:
        doc = json.loads(subprocess.run(
            ["npx", "gltf-transform", "copy", path, "/dev/stdout", "--format", "gltf"],
            capture_output=True, text=True).stdout)
        ext = doc.get("extensions", {}).get("EXT_structural_metadata", {})
        tables = ext.get("propertyTables", [])
        declared = tables[0]["count"] if tables else None
        max_id = None
        for mesh in doc.get("meshes", []):
            for prim in mesh.get("primitives", []):
                acc_idx = (prim.get("attributes") or {}).get("_FEATURE_ID_0")
                if acc_idx is None:
                    continue
                acc = doc["accessors"][acc_idx]
                if "max" in acc:
                    max_id = max(max_id or 0, int(acc["max"][0]))
        rows.append({"file": Path(path).name, "table_rows": declared,
                     "max_feature_id": max_id,
                     "ok": declared is not None and max_id is not None
                           and max_id < declared})
    return {"checked": len(rows), "bad": [r for r in rows if not r["ok"]][:3],
            "aligned": all(r["ok"] for r in rows)}
```

A feature id at or above the table's row count reads past the end of the array, which some clients report as an error and others silently clamp — producing every out-of-range feature showing the last row's values.

## Performance Notes

- **Metadata adds to the tileset JSON**, and tile-level metadata on 6,147 tiles is roughly 400 KB before gzip. Gzip takes it to about 40 KB; serve it compressed.
- **Property tables are fetched with their content**, so a property nobody styles by still costs bandwidth. Keep the schema to properties the client actually uses.
- **Enums cost one byte**; the equivalent strings cost 10–15 plus an offset each. Use enums for anything with a closed vocabulary.
- **Strings need an offsets array** of 4 bytes per feature on top of the data. A per-feature identifier is unavoidable; other strings usually are not.
- **Group metadata is free at scale** — 12 districts is 12 entries regardless of tile count.
- **Statistics are computed once in the pipeline** and save the client a full scan. Always write them.

## Common Errors

**Validator: "property is not defined in class".** A metadata entity sets a property the class does not declare. The schema is authoritative; add the property or remove the value.

**Validator: "enum value not found".** A property table holds an integer with no matching enum entry, usually from a delivery introducing a new category.

**Every feature shows the same values.** Feature ids are all zero, or the `_FEATURE_ID_0` accessor was dropped by an optimisation pass. Keep `extras` and feature attributes through the packer.

**Features past a certain point show wrong values.** Non-contiguous feature ids, from filtering after id assignment. Assign ids last.

**`group` index out of range.** Groups were reordered after contents were assigned. Build the index and assign in one pass.

**Styling by a property returns undefined.** The style references the property name from the schema while the client expects the property table's name — they must match exactly, including case.

**Tileset JSON is 12 MB.** Tile-level metadata on every tile with long string values. Move shared values to groups and keep tile metadata to a few small fields.

## Frequently Asked Questions

### Does this replace the 1.0 batch table?

Yes. `EXT_structural_metadata` with `EXT_mesh_features` is the 1.1 mechanism, and it is richer — typed properties, enums, several tables per content — as well as readable by standard glTF tooling.

### Can I add metadata without re-tiling?

Tileset, group and tile metadata live in the tileset JSON, so those can be added or changed by rewriting one file. Per-feature property tables live in the content, so changing those means rewriting the GLB files.

### What about `extras`?

`extras` is free-form and unvalidated, which makes it fine for pipeline bookkeeping and wrong for anything a client styles by. Use the metadata system for anything the client needs.

## Related Guides

- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — consuming what this defines
- [Encoding Property Textures for Per-Texel Data](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/encoding-property-textures-for-per-texel-data/) — metadata finer than a feature
- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — the document this extends

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
