# Attaching EXT_structural_metadata to Building Tiles

This page attaches per-building attributes to a glTF tile using `EXT_structural_metadata` and `EXT_mesh_features` — declaring a schema with real types, packing a property table, assigning feature IDs to vertices, and verifying that a pick in the viewer returns the attributes of the building that was clicked. It replaces the 1.0 batch table, and the replacement is worth making mostly because the schema turns an implied convention into something a validator and a future reader can check.

## Why you hit this

A tileset without metadata is a picture. The moment a planner clicks a building and expects its construction year, or a query has to select every industrial building above 20 m, the geometry needs attributes attached to it in a form the runtime can index. In 1.0 that was the batch table: a JSON object per tile, positionally joined to features, with types inferred from whatever happened to be in the values. It worked and it carried no contract, so a property that was an integer in one tile and a string in another was perfectly legal and broke consumers at runtime.

The schema-level decisions and the wider 1.1 picture live in [tileset metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).

## Prerequisites

- Node 18+ with `@gltf-transform/cli` (`npm i -g @gltf-transform/cli`) and `3d-tiles-validator`.
- Python 3.10+ with `pygltflib>=1.16` and `numpy>=1.24` for inspection.
- A `.glb` per tile whose primitives are one building each, or a merged primitive where you can compute a per-vertex building index.
- The attribute table itself — typically a GeoPackage or Parquet keyed by the same building id the geometry carries.

## Step-by-Step

### 1. Declare the schema, with types and enums

The schema is the contract. Write it once for the tileset and reference it from every tile.

```python
import json

schema = {
    "id": "city_v3",
    "name": "Municipal building register",
    "version": "3.0.0",
    "classes": {
        "building": {
            "name": "Building",
            "properties": {
                "gml_id":     {"type": "STRING", "required": True},
                "year_built": {"type": "SCALAR", "componentType": "UINT16"},
                "height_m":   {"type": "SCALAR", "componentType": "FLOAT32"},
                "storeys":    {"type": "SCALAR", "componentType": "UINT8"},
                "function":   {"type": "ENUM", "enumType": "buildingFunction", "required": True},
                "heritage":   {"type": "BOOLEAN"},
            },
        }
    },
    "enums": {
        "buildingFunction": {
            "valueType": "UINT8",
            "values": [
                {"name": "residential", "value": 0},
                {"name": "commercial",  "value": 1},
                {"name": "industrial",  "value": 2},
                {"name": "civic",       "value": 3},
                {"name": "mixed",       "value": 4},
            ],
        }
    },
}
json.dump(schema, open("city_v3.schema.json", "w"), indent=2)
```

Three choices in that block are worth defending. `UINT16` for a year is exact and half the size of a float. `FLOAT32` for height is right because the value is a measurement with real uncertainty, not an identifier. And `function` as an enum means the wire format is one byte per building while the reader still sees `"commercial"` — over 400,000 buildings that is 400 KB instead of about 4 MB.

### 2. Build the property table

A property table is columnar: one array per property, indexed by feature id. Variable-length properties such as strings need an offsets array alongside the data.

```python
import numpy as np

buildings = [
    {"gml_id": "BLDG_0041", "year_built": 1974, "height_m": 18.4, "storeys": 6,
     "function": 0, "heritage": False},
    {"gml_id": "BLDG_0042", "year_built": 1908, "height_m": 22.1, "storeys": 7,
     "function": 1, "heritage": True},
    {"gml_id": "BLDG_0043", "year_built": 2011, "height_m": 11.9, "storeys": 3,
     "function": 4, "heritage": False},
]

year = np.array([b["year_built"] for b in buildings], dtype=np.uint16)
height = np.array([b["height_m"] for b in buildings], dtype=np.float32)
storeys = np.array([b["storeys"] for b in buildings], dtype=np.uint8)
function = np.array([b["function"] for b in buildings], dtype=np.uint8)
heritage = np.packbits(
    np.array([b["heritage"] for b in buildings], dtype=np.uint8), bitorder="little")

ids = "".join(b["gml_id"] for b in buildings).encode()
id_offsets = np.cumsum([0] + [len(b["gml_id"]) for b in buildings]).astype(np.uint32)

print("year bytes:", year.nbytes, "| ids bytes:", len(ids),
      "| offsets bytes:", id_offsets.nbytes)
```

The string offsets array has one more entry than there are features — it stores the start of every string plus the end of the last. An off-by-one here truncates the final building's id, which shows up as one unpickable building at the end of every tile.

<figure class="diagram">
<svg viewBox="15 46 730 230" role="img" aria-labelledby="sm-table-t sm-table-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sm-table-t">A property table is columnar and joined by position</title>
  <desc id="sm-table-d">Each property is a separate typed array indexed by feature id. Fixed-width properties are read directly at index times component size. Variable-length strings need an offsets array with one more entry than there are features, giving the start of each string and the end of the last.</desc>
  <rect class="svg-bg" x="15" y="46" width="730" height="230" fill="#ffffff"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="30" y="60" width="80" height="34" rx="4"/>
    <rect x="30" y="98" width="80" height="34" rx="4"/>
    <rect x="30" y="136" width="80" height="34" rx="4"/>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="130" y="60" width="90" height="34" rx="4"/>
    <rect x="130" y="98" width="90" height="34" rx="4"/>
    <rect x="130" y="136" width="90" height="34" rx="4"/>
    <rect x="240" y="60" width="90" height="34" rx="4"/>
    <rect x="240" y="98" width="90" height="34" rx="4"/>
    <rect x="240" y="136" width="90" height="34" rx="4"/>
  </g>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="400" y="60" width="150" height="34" rx="4"/>
    <rect x="400" y="98" width="150" height="34" rx="4"/>
    <rect x="400" y="136" width="150" height="34" rx="4"/>
  </g>
  <rect x="580" y="60" width="150" height="110" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="70" y="82">id 0</text><text x="70" y="120">id 1</text><text x="70" y="158">id 2</text>
    <text x="175" y="82">1974</text><text x="175" y="120">1908</text><text x="175" y="158">2011</text>
    <text x="285" y="82">18.4</text><text x="285" y="120">22.1</text><text x="285" y="158">11.9</text>
    <text x="475" y="82">BLDG_0041</text><text x="475" y="120">BLDG_0042</text><text x="475" y="158">BLDG_0043</text>
    <text x="655" y="98"><tspan x="655" dy="0">offsets</tspan><tspan x="655" dy="17">0, 9, 18, 27</tspan><tspan x="655" dy="17">four entries</tspan><tspan x="655" dy="17">for three strings</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="70" y="196">feature id</text>
    <text x="175" y="196">year, UINT16</text>
    <text x="285" y="196">height, FLOAT32</text>
    <text x="475" y="196">gml_id, STRING</text>
  </g>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Fixed-width columns are read at index × size; variable-length ones need the offsets array to find where each value starts</text>
  <text x="380" y="258" fill="#b0413e" font-size="12" text-anchor="middle">An offsets array with N entries instead of N+1 truncates the last string — one unpickable building per tile</text>
</svg>
<figcaption>The columnar layout is what makes a property cheap to read without decoding the others. It is also why the string offsets have to be exactly one longer than the feature count.</figcaption>
</figure>

### 3. Assign feature IDs to the geometry

`EXT_mesh_features` connects vertices to rows in the table. For per-building tiles the simplest form is a per-vertex attribute holding the building index.

```python
import numpy as np
from pygltflib import GLTF2

g = GLTF2().load("block_0_0.glb")
prim = g.meshes[0].primitives[0]

# One value per vertex, naming which building that vertex belongs to.
n_vertices = g.accessors[prim.attributes.POSITION].count
feature_ids = np.zeros(n_vertices, dtype=np.float32)
feature_ids[1200:2400] = 1
feature_ids[2400:] = 2

prim.extensions = prim.extensions or {}
prim.extensions["EXT_mesh_features"] = {
    "featureIds": [{"featureCount": 3, "attribute": 0, "propertyTable": 0}]
}
print("feature ids:", np.unique(feature_ids).astype(int).tolist())
```

`attribute: 0` refers to the `_FEATURE_ID_0` vertex attribute, and `propertyTable: 0` names which table in the tile's `EXT_structural_metadata` those ids index. Both are indices, not names, so inserting a table at the front of the list silently rewires every primitive that referenced index 0.

### 4. Wire the extension into the glTF

`gltf-transform` writes both extensions and keeps the buffer layout valid, which is worth more than hand-editing the JSON.

```bash
npx @gltf-transform/cli meta \
  --schema city_v3.schema.json \
  --class building \
  --table block_0_0_table.json \
  block_0_0.glb block_0_0_meta.glb

npx @gltf-transform/cli inspect block_0_0_meta.glb | head -30
```

### 5. Verify a pick returns the right building

The check that matters is end to end: pick a vertex, resolve its feature id, read the row, and compare against the source register.

```python
import numpy as np
from pygltflib import GLTF2

g = GLTF2().load("block_0_0_meta.glb")
ext = g.extensions["EXT_structural_metadata"]
table = ext["propertyTables"][0]

print("schema:", ext["schema"]["id"], "| class:", table["class"],
      "| features:", table["count"])

# Resolve one feature the way a runtime does.
def read_scalar(prop_name, feature_id, dtype):
    view_idx = table["properties"][prop_name]["values"]
    view = g.bufferViews[view_idx]
    blob = g.binary_blob()[view.byteOffset : view.byteOffset + view.byteLength]
    return np.frombuffer(blob, dtype=dtype)[feature_id]

fid = 1
print("year_built:", int(read_scalar("year_built", fid, np.uint16)))
print("height_m:", float(read_scalar("height_m", fid, np.float32)))
```

<figure class="diagram">
<svg viewBox="6 66 748 200" role="img" aria-labelledby="sm-pick-t sm-pick-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sm-pick-t">The chain a pick actually follows</title>
  <desc id="sm-pick-d">A click resolves to a triangle, the triangle to its vertices, the vertices to a feature id attribute, the feature id to a row index in a property table, and the row to typed values interpreted through the schema. Every link is positional, so a re-sort anywhere in the build rewires the whole chain silently.</desc>
  <rect class="svg-bg" x="6" y="66" width="748" height="200" fill="#ffffff"/>
  <defs>
    <marker id="sm-pick-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="2">
    <rect x="20" y="80" width="128" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="172" y="80" width="128" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="324" y="80" width="128" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="476" y="80" width="128" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="628" y="80" width="112" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#sm-pick-a)">
    <line x1="148" y1="106" x2="170" y2="106"/>
    <line x1="300" y1="106" x2="322" y2="106"/>
    <line x1="452" y1="106" x2="474" y2="106"/>
    <line x1="604" y1="106" x2="626" y2="106"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="84" y="102"><tspan x="84" dy="0">click</tspan><tspan x="84" dy="15">→ triangle</tspan></text>
    <text x="236" y="102"><tspan x="236" dy="0">_FEATURE_ID_0</tspan><tspan x="236" dy="15">per vertex</tspan></text>
    <text x="388" y="102"><tspan x="388" dy="0">propertyTable</tspan><tspan x="388" dy="15">row index</tspan></text>
    <text x="540" y="102"><tspan x="540" dy="0">typed column</tspan><tspan x="540" dy="15">values array</tspan></text>
    <text x="684" y="102"><tspan x="684" dy="0">schema</tspan><tspan x="684" dy="15">gives meaning</tspan></text>
  </g>
  <text x="380" y="178" fill="#b0413e" font-size="12.5" text-anchor="middle">Every arrow is a positional index. Nothing in the file records which building a row belongs to.</text>
  <text x="380" y="206" fill="#15384a" font-size="12.5" text-anchor="middle">So the build must write geometry and table in one pass, and assert count equality before the tile is written</text>
  <text x="380" y="248" fill="#5b6471" font-size="12" text-anchor="middle">The schema is the only link in the chain that carries names — which is exactly why it is worth versioning</text>
</svg>
<figcaption>Five positional hops from a click to a value. The schema is the only one of them that would notice if the meaning changed underneath.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="10 42 744 228" role="img" aria-labelledby="sm-ver-t sm-ver-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sm-ver-t">Why the schema id has to change when a type does</title>
  <desc id="sm-ver-d">Consumers cache a schema by its id. Widening a property from an eight-bit to a sixteen-bit integer under the same id leaves a cached reader decoding two-byte values as one-byte ones, which produces plausible wrong numbers rather than an error. Bumping the id forces the reader to fetch the new schema.</desc>
  <rect class="svg-bg" x="10" y="42" width="744" height="228" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="56" width="200" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="140" width="200" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="300" y="56" width="200" height="52" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="300" y="140" width="200" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="56" width="180" height="52" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="560" y="140" width="180" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="124" y="78"><tspan x="124" dy="0">storeys: UINT8</tspan><tspan x="124" dy="16">schema id &quot;city_v3&quot;</tspan></text>
    <text x="124" y="162"><tspan x="124" dy="0">storeys: UINT16</tspan><tspan x="124" dy="16">schema id &quot;city_v3&quot;</tspan></text>
    <text x="400" y="78"><tspan x="400" dy="0">id unchanged — reader keeps</tspan><tspan x="400" dy="16">its cached UINT8 layout</tspan></text>
    <text x="400" y="162"><tspan x="400" dy="0">id bumped to &quot;city_v4&quot; —</tspan><tspan x="400" dy="16">reader refetches the schema</tspan></text>
    <text x="650" y="78"><tspan x="650" dy="0">a 6-storey building</tspan><tspan x="650" dy="16">reads as 1536</tspan></text>
    <text x="650" y="162"><tspan x="650" dy="0">values decode</tspan><tspan x="650" dy="16">correctly</tspan></text>
  </g>
  <text x="380" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">The failure is silent and directional — every value is wrong by a factor that looks like a unit error</text>
  <text x="380" y="252" fill="#5b6471" font-size="12" text-anchor="middle">Treat the schema id as a version number and change it whenever any property&#39;s type or enum changes</text>
</svg>
<figcaption>Nothing in the format prevents reusing an id after a type change, and no reader reports it. The discipline has to come from the build.</figcaption>
</figure>

## Expected Output & Verification

A correct tile inspects as:

```text
schema: city_v3 | class: building | features: 3
year_built: 1908
height_m: 22.100000381469727
year bytes: 6 | ids bytes: 27 | offsets bytes: 16
```

Then assert the two counts agree before the tile ships — the feature count declared in `EXT_mesh_features` must equal the property table's `count`, and both must equal the number of buildings the geometry step wrote.

```python
prim_ext = g.meshes[0].primitives[0].extensions["EXT_mesh_features"]
declared = prim_ext["featureIds"][0]["featureCount"]
table_count = g.extensions["EXT_structural_metadata"]["propertyTables"][0]["count"]
assert declared == table_count, f"{declared} feature ids vs {table_count} table rows"
print("feature ids and table rows agree:", declared)
```

Finally validate and pick in a real client. `3d-tiles-validator` will catch a malformed extension; only a pick catches a table whose rows are in a different order from the geometry, which is valid and wrong.

## Common Errors

**Every building returns the same attributes.** The `_FEATURE_ID_0` attribute is all zeros, usually because it was declared but never populated. Check `np.unique` on the attribute before writing the tile.

**The last building in each tile cannot be picked.** The string offsets array has N entries instead of N+1, so the final id is truncated to zero length. Build offsets with `np.cumsum([0] + lengths)`.

**A pick returns a neighbour's attributes.** The geometry and the property table were built in different orders. Build them in one pass, and if a sort is unavoidable, sort both with the same permutation and assert on a known id afterwards.

**`Unknown extension EXT_structural_metadata` in an older viewer.** The client predates 1.1. Either pin a newer CesiumJS or keep publishing a 1.0 tileset with batch tables alongside during the transition.

## Frequently Asked Questions

### Can I keep using the batch table?
Yes — 1.0 tilesets remain valid and CesiumJS still reads them. The reasons to move are the declared types, the enum compression, and having one schema instead of an implied convention repeated per tile.

### How large should a property table be?
One per tile, covering the features in that tile. A single table for the whole city forces every tile to carry it, which defeats the point of tiling the metadata alongside the geometry.

### Can properties be per-vertex or per-texel instead of per-feature?
Yes. `EXT_structural_metadata` supports property attributes (per-vertex) and property textures (per-texel), which suit continuous quantities like temperature or material index. Per-feature tables are the right form for register attributes.

One further practice is worth adopting early, because retrofitting it is painful. Keep the schema in its own file, under version control, and generate both the tileset's copy and any consumer's decoding code from it. The schema is small, it changes rarely, and it is the only artifact in the whole chain that carries names rather than positions — so it is the natural place for the contract between whoever builds tiles and whoever reads them to live. A schema that exists only inside the tiles is a contract that can only be discovered by decoding an artifact.

Finally, decide deliberately what happens to a building with a missing attribute. `required: true` makes the validator reject the tile, which is right for an identifier and wrong for an optional survey field. For optional properties, the choice is between omitting the property from the table entirely and encoding a sentinel — and a sentinel is almost always the wrong answer, because every consumer then has to know which value means "absent" and one of them will not.

## Related Guides

- [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/) — the wider 1.1 picture
- [Implicit Tiling with Subtree Files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/) — the other half of the change
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — where these attributes come from

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
