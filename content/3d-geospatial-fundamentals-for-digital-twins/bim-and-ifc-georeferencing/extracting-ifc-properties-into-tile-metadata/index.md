# Extracting IFC Properties into Tile Metadata

This page carries the properties of an IFC model into the metadata of the tiles built from it — choosing a small schema out of the hundreds of available property sets, normalising units and enumerations, assembling the property-table arrays that `EXT_structural_metadata` expects, and styling the resulting tileset by fire rating, storey or construction type.

## Why you hit this

The geometry is the easy half of ingesting BIM. What makes a twin useful is that clicking a wall returns its fire rating, its storey and its asset identifier, and that a view can colour every element by construction type. All of that exists in the IFC as property sets — and an export that only triangulates geometry discards it, leaving a twin that looks like a building and answers nothing. The georeferencing half of the same ingestion is in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).

## Prerequisites

- Python 3.10+ with `ifcopenshell>=0.8`, `numpy>=1.24`.
- An IFC4 model with populated property sets — check one element before planning a schema, because models vary enormously in what they carry.
- A tiler that accepts a metadata schema and per-feature values, or the ability to write glTF with `EXT_structural_metadata` yourself.

## Step-by-Step

### 1. Survey what the model actually carries

```python
from collections import Counter

import ifcopenshell
import ifcopenshell.util.element

model = ifcopenshell.open("clinic_block_c.ifc")
elements = model.by_type("IfcBuildingElement")
print(f"{len(elements):,} building elements, schema {model.schema}")

pset_names, prop_names = Counter(), Counter()
for el in elements[:5000]:                                  # a sample is enough to survey
    for pset, props in ifcopenshell.util.element.get_psets(el).items():
        pset_names[pset] += 1
        for p in props:
            if p != "id":
                prop_names[f"{pset}.{p}"] += 1

for name, n in pset_names.most_common(8):
    print(f"{n:>6} elements  {name}")
print()
for name, n in prop_names.most_common(12):
    print(f"{n:>6}  {name}")
```

Surveying first prevents the two usual mistakes: designing a schema around properties the model does not populate, and exporting everything. A large IFC model carries tens of thousands of distinct property names across standard `Pset_*` sets, vendor-specific sets and project-specific ones, and almost all of them are irrelevant to a twin. The list of property names sorted by how many elements have them is the shortlist.

### 2. Choose a small schema and declare it

```python
SCHEMA = {
    "id": "clinic_bim_v1",
    "name": "Clinic BIM element metadata",
    "classes": {
        "element": {
            "name": "Building element",
            "properties": {
                "guid":        {"componentType": "STRING", "required": True},
                "ifc_type":    {"componentType": "STRING", "required": True},
                "storey":      {"componentType": "STRING"},
                "name":        {"componentType": "STRING"},
                "fire_rating": {"componentType": "STRING"},
                "is_external": {"type": "BOOLEAN"},
                "load_bearing": {"type": "BOOLEAN"},
                "area_m2":     {"componentType": "FLOAT32"},
                "volume_m3":   {"componentType": "FLOAT32"},
                "thickness_m": {"componentType": "FLOAT32"},
            },
        }
    },
}
```

Ten properties is a good target for a first pass: an identifier, a type, a location in the building, and the handful of values a user will filter or colour by. Everything else stays in the IFC, which remains the system of record — the twin's metadata is a query surface, not a copy of the model. Keeping it small also matters for tile size, since property tables ship inside the tile content.

### 3. Extract and normalise the values

```python
import ifcopenshell.util.unit

UNIT_SCALE = ifcopenshell.util.unit.calculate_unit_scale(model)     # project length → metres

def storey_of(el):
    for rel in getattr(el, "ContainedInStructure", ()) or ():
        s = rel.RelatingStructure
        if s.is_a("IfcBuildingStorey"):
            return s.Name
    return None

def prop(psets, *paths, default=None):
    for path in paths:
        pset, key = path.split(".")
        val = (psets.get(pset) or {}).get(key)
        if val is not None:
            return val
    return default

def as_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().upper() in ("TRUE", "T", "YES", "1")
    return None

def extract(el):
    psets = ifcopenshell.util.element.get_psets(el)
    qto = {k: v for k, v in psets.items() if k.startswith("Qto_")}
    area = prop(qto, *[f"{k}.NetSideArea" for k in qto], *[f"{k}.GrossSideArea" for k in qto])
    volume = prop(qto, *[f"{k}.NetVolume" for k in qto], *[f"{k}.GrossVolume" for k in qto])
    thickness = prop(psets, "Pset_WallCommon.Thickness", "Qto_WallBaseQuantities.Width")
    return {
        "guid": el.GlobalId,
        "ifc_type": el.is_a(),
        "storey": storey_of(el) or "",
        "name": el.Name or "",
        "fire_rating": str(prop(psets, "Pset_WallCommon.FireRating",
                                "Pset_SlabCommon.FireRating", default="") or ""),
        "is_external": as_bool(prop(psets, "Pset_WallCommon.IsExternal",
                                    "Pset_SlabCommon.IsExternal")),
        "load_bearing": as_bool(prop(psets, "Pset_WallCommon.LoadBearing",
                                     "Pset_SlabCommon.LoadBearing")),
        "area_m2": float(area) * UNIT_SCALE ** 2 if area else None,
        "volume_m3": float(volume) * UNIT_SCALE ** 3 if volume else None,
        "thickness_m": float(thickness) * UNIT_SCALE if thickness else None,
    }

rows = [extract(el) for el in elements]
print(f"{len(rows):,} rows; storeys {sorted({r['storey'] for r in rows})[:6]}")
```

Three normalisations happen there and all three matter. Lengths are multiplied by the project unit scale, and areas and volumes by its square and cube — a millimetre model reports areas in square millimetres, so a wall comes out as 12,400,000 until it is converted. Booleans in IFC property sets are frequently strings, because exporters write `.T.` or `"TRUE"`. And quantity sets are named per element type (`Qto_WallBaseQuantities`, `Qto_SlabBaseQuantities`), so a lookup has to search across them rather than hard-coding one.

<figure class="diagram">
<svg viewBox="6 16 748 228" role="img" aria-labelledby="ifcmeta-map-t ifcmeta-map-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcmeta-map-t">From property sets to a tile metadata schema</title>
  <desc id="ifcmeta-map-d">An IFC element carries several property sets: a common set with fire rating and external flags, a quantity set with areas and volumes in project units, and vendor-specific sets. A selection of ten properties is normalised into metres and booleans and mapped into one metadata class with declared component types, which is what ships inside the tile.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="228" fill="#ffffff"/>
  <defs>
    <marker id="ifcmeta-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.5">
    <rect x="20" y="30" width="230" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="82" width="230" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="134" width="230" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="186" width="230" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="82" width="150" height="96" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="540" y="60" width="200" height="140" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none" marker-end="url(#ifcmeta-map-arrow)">
    <path d="M250 52 L318 110"/><path d="M250 104 H318"/><path d="M250 156 L318 150"/>
    <path d="M470 130 H538"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="135" y="48">Pset_WallCommon</text><text x="135" y="66">FireRating, IsExternal</text>
    <text x="135" y="100">Qto_WallBaseQuantities</text><text x="135" y="118">NetSideArea (mm²)</text>
    <text x="135" y="152">storey containment</text><text x="135" y="170">IfcBuildingStorey.Name</text>
    <text x="135" y="204">vendor psets</text><text x="135" y="222">not carried</text>
    <text x="395" y="118">normalise:</text><text x="395" y="136">units, booleans,</text><text x="395" y="154">missing values</text>
    <text x="640" y="86">metadata class</text>
    <text x="640" y="110">guid, ifc_type: STRING</text>
    <text x="640" y="134">is_external: BOOLEAN</text>
    <text x="640" y="158">area_m2: FLOAT32</text>
    <text x="640" y="182">ten properties, declared</text>
  </g>
</svg>
<figcaption>The schema is a deliberate selection, not an export: ten declared properties per element, normalised, with the IFC remaining the system of record.</figcaption>
</figure>

### 4. Assemble the property-table arrays

`EXT_structural_metadata` stores each property as a binary array parallel to the feature IDs. Numeric properties are a plain array; strings need an offsets array because they vary in length.

```python
import numpy as np

def build_property_table(rows, schema_class):
    n = len(rows)
    table = {"class": "element", "count": n, "properties": {}}
    buffers = {}

    for name, spec in schema_class["properties"].items():
        values = [r.get(name) for r in rows]
        ctype = spec.get("componentType") or spec.get("type")
        if ctype == "STRING":
            encoded = [(v or "").encode("utf-8") for v in values]
            offsets = np.zeros(n + 1, dtype=np.uint32)
            offsets[1:] = np.cumsum([len(b) for b in encoded])
            buffers[f"{name}_values"] = b"".join(encoded)
            buffers[f"{name}_offsets"] = offsets.tobytes()
            table["properties"][name] = {"values": f"{name}_values",
                                         "stringOffsets": f"{name}_offsets",
                                         "stringOffsetType": "UINT32"}
        elif ctype == "BOOLEAN":
            bits = np.zeros((n + 7) // 8, dtype=np.uint8)
            for i, v in enumerate(values):
                if v:
                    bits[i // 8] |= 1 << (i % 8)
            buffers[f"{name}_values"] = bits.tobytes()
            table["properties"][name] = {"values": f"{name}_values"}
        else:
            arr = np.array([np.nan if v is None else v for v in values], dtype=np.float32)
            buffers[f"{name}_values"] = arr.tobytes()
            table["properties"][name] = {"values": f"{name}_values"}
    return table, buffers

table, buffers = build_property_table(rows, SCHEMA["classes"]["element"])
print(f"{table['count']:,} features; buffers: "
      f"{sum(len(b) for b in buffers.values()) / 1e6:.2f} MB across {len(buffers)} arrays")
```

Two details of the encoding cause most of the trouble. String offsets are cumulative *byte* positions with `n + 1` entries, so the last entry is the total length — an off-by-one here shifts every string by one feature, which produces metadata that looks populated and is wrong. Booleans are bit-packed, one bit per feature, least significant bit first within each byte.

<figure class="diagram">
<svg viewBox="46 46 628 194" role="img" aria-labelledby="ifcmeta-str-t ifcmeta-str-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcmeta-str-t">String property encoding with offsets</title>
  <desc id="ifcmeta-str-d">Three storey names are concatenated into one byte buffer without separators. A parallel offsets array of four unsigned integers gives the start of each string and the total length, so the reader slices the buffer. If the offsets array has only three entries, the last string has no end and the reader either truncates or overruns.</desc>
  <rect class="svg-bg" x="46" y="46" width="628" height="194" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="60" y="60" width="180" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="60" width="150" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="390" y="60" width="210" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="150" y="84">LevelB1</text>
    <text x="315" y="84">Level00</text>
    <text x="495" y="84">Level01Tech</text>
    <text x="150" y="124">0</text><text x="240" y="124">7</text><text x="390" y="124">14</text><text x="600" y="124">25</text>
  </g>
  <g stroke="#5b6471" stroke-width="1.2" fill="none">
    <path d="M60 100 V118 M240 100 V118 M390 100 V118 M600 100 V118"/>
  </g>
  <text x="330" y="152" fill="#1f2937" font-size="12.5" text-anchor="middle">offsets: [0, 7, 14, 25] — four entries for three strings</text>
  <text x="330" y="186" fill="#b0413e" font-size="12.5" text-anchor="middle">three entries would leave the last string unbounded</text>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Byte offsets, not character offsets: a non-ASCII name breaks a character-based implementation.</text>
</svg>
<figcaption>The offsets array is the whole mechanism for variable-length properties, and its length is one more than the feature count.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="16 26 728 228" role="img" aria-labelledby="ifcmeta-style-t ifcmeta-style-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcmeta-style-t">One tileset, three views from the same metadata</title>
  <desc id="ifcmeta-style-d">The same building tileset rendered three ways from the metadata that shipped with it: coloured by fire rating, filtered to load-bearing elements only, and with one storey hidden. None of the three requires a rebuild, because the values are already in the tiles and the styling happens in the client.</desc>
  <rect class="svg-bg" x="16" y="26" width="728" height="228" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="40" width="200" height="130" fill="#ffffff" stroke="#5b6471"/>
    <rect x="280" y="40" width="200" height="130" fill="#ffffff" stroke="#5b6471"/>
    <rect x="530" y="40" width="200" height="130" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g stroke="#5b6471" stroke-width="1">
    <rect x="50" y="60" width="160" height="26" fill="#f7dfdc"/>
    <rect x="50" y="90" width="160" height="26" fill="#fdf3e0"/>
    <rect x="50" y="120" width="160" height="26" fill="#e3f0f4"/>
    <rect x="300" y="60" width="160" height="26" fill="#e3f0f4"/>
    <rect x="300" y="120" width="160" height="26" fill="#e3f0f4"/>
    <rect x="550" y="60" width="160" height="26" fill="#eef5e9"/>
    <rect x="550" y="90" width="160" height="26" fill="#eef5e9"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="192">colour by fire_rating</text>
    <text x="380" y="192">show load_bearing only</text>
    <text x="630" y="192">hide storey LevelB1</text>
    <text x="130" y="212">EI90 · EI60 · none</text>
    <text x="380" y="212">others hidden</text>
    <text x="630" y="212">two storeys remain</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12" text-anchor="middle">All three are client-side style expressions over the property table.</text>
</svg>
<figcaption>The payoff for shipping ten properties is that every one of these views is a style change rather than a tiling run.</figcaption>
</figure>

### 5. Style the tileset by the metadata

```javascript
const clinic = await Cesium.Cesium3DTileset.fromUrl("/tiles/clinic/tileset.json");
viewer.scene.primitives.add(clinic);

clinic.style = new Cesium.Cesium3DTileStyle({
  color: {
    conditions: [
      ["${fire_rating} === 'EI90'", "color('#b0413e')"],
      ["${fire_rating} === 'EI60'", "color('#c46a3d')"],
      ["${load_bearing} === true", "color('#1f6b8a')"],
      ["${is_external} === true", "color('#4f7a4d')"],
      ["true", "color('#e6e0d4')"],
    ],
  },
  show: "${storey} !== 'LevelB1'",
});

const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction((m) => {
  const f = viewer.scene.pick(m.position);
  if (f instanceof Cesium.Cesium3DTileFeature) {
    console.log(Object.fromEntries(f.getPropertyIds().map((k) => [k, f.getProperty(k)])));
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

The styling expressions are the return on the whole exercise: colouring by fire rating, hiding a basement level, or filtering to load-bearing elements happens in the client with no rebuild. `getPropertyIds` on a picked feature is also the quickest way to confirm the metadata arrived — if it returns an empty list, the property table did not make it into the tile.

## Expected Output & Verification

```text
41,882 building elements, schema IFC4
 38104 elements  Pset_WallCommon
 22841 elements  Qto_WallBaseQuantities
 18402 elements  Pset_SlabCommon
  9120 elements  Pset_DoorCommon
 41,882 rows; storeys ['LevelB1', 'Level00', 'Level01', 'Level01Tech', 'Level02']
41,882 features; buffers: 3.84 MB across 16 arrays
```

Verify the table round-trips before it goes into tiles, by decoding it exactly as a client will:

```python
def decode_string_property(buffers, table, name, index):
    offs = np.frombuffer(buffers[table["properties"][name]["stringOffsets"]], dtype=np.uint32)
    data = buffers[table["properties"][name]["values"]]
    return data[offs[index]:offs[index + 1]].decode("utf-8")

def decode_bool_property(buffers, table, name, index):
    bits = np.frombuffer(buffers[table["properties"][name]["values"]], dtype=np.uint8)
    return bool(bits[index // 8] >> (index % 8) & 1)

for i in (0, 1, len(rows) // 2, len(rows) - 1):
    assert decode_string_property(buffers, table, "guid", i) == rows[i]["guid"]
    assert decode_string_property(buffers, table, "storey", i) == rows[i]["storey"]
    assert decode_bool_property(buffers, table, "is_external", i) == bool(rows[i]["is_external"])
print("property table decodes back to the source rows")

areas = np.frombuffer(buffers["area_m2_values"], dtype=np.float32)
valid = np.isfinite(areas)
print(f"area_m2: {valid.sum():,} populated, median {np.median(areas[valid]):.1f} m², "
      f"max {areas[valid].max():.1f} m²")
assert np.nanmax(areas) < 10_000, "implausible area: unit scaling missed"
```

Decoding the first, second, middle and last feature catches the off-by-one in the offsets array, which is invisible if only the first feature is checked. The area sanity bound catches the unit-scale error: a wall with an area of 12 million is a millimetre model that was not converted.

## Common Errors

**Every string property is shifted by one feature.** The offsets array has `n` entries instead of `n + 1`, or starts at the first string's length rather than at zero. The multi-index assertion above is the guard.

**Areas and volumes are absurdly large or small.** The unit scale was applied linearly to an area, or not at all. Areas need the square of the scale and volumes the cube.

**Booleans are all true.** The IFC values were strings such as `"F"` or `.F.`, and a truthiness test on a non-empty string returns true. Parse them explicitly, as `as_bool` does.

**`getPropertyIds()` returns nothing in the viewer.** The property table was written but not referenced from the mesh's feature IDs, or the tiler dropped the extension. Check that the glTF declares `EXT_structural_metadata` and that the primitive has a feature-ID set.

**Storey is empty for most elements.** Containment is expressed through `IfcRelContainedInSpatialStructure` on the element, but some elements are nested in an aggregate — a curtain wall's panels, for instance — and inherit their parent's storey. Walk up through `Decomposes` when the direct lookup fails.

## Frequently Asked Questions

### How many properties is too many?

Tile size is the limit: property tables ship with the geometry, so a hundred properties on a hundred thousand features is tens of megabytes spread across the tiles. Ten to twenty properties covers filtering and colouring; anything else belongs behind an API keyed by the GUID.

### Should the property values be strings or enumerations?

Declared enumerations are better where the value set is known and small — fire ratings, element types — because they encode as integers and the schema documents the allowed values. Strings are the pragmatic choice when the model's values are inconsistent, which they often are.

### Can properties be updated without re-tiling?

Not if they are in the tiles. That is the argument for keeping only stable properties in the metadata and serving volatile ones from an API, as described in [streaming live sensor updates onto tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/).

## Related Guides

- [Attaching EXT_structural_metadata to Building Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/) — the extension in depth
- [Simplifying IFC Geometry for Web Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/simplifying-ifc-geometry-for-web-tiles/) — the geometry half of the same export
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — expressions over these properties

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
