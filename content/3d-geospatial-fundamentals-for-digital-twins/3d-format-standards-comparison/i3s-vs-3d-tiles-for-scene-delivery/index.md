# I3S vs 3D Tiles for Scene Delivery

This page compares the two OGC community standards for streaming large 3D scenes — Indexed 3D Scene Layers (I3S, delivered as a scene layer package or a REST service) and 3D Tiles — on the properties that decide a twin's delivery: how each structures its hierarchy, which layer types each supports, how attributes travel, which clients read which, and how to serve both from one pipeline without maintaining two.

## Why you hit this

The choice usually arrives as a constraint rather than a preference. A city has an ArcGIS-based portal and its data arrives as scene layer packages; a twin team builds on CesiumJS and produces 3D Tiles; a procurement document names one of them because someone copied a paragraph. Both are OGC community standards, both stream the same kinds of content, and converting between them is routine — so the real question is which one a given pipeline should treat as its primary product. The format landscape around them is in [3D format standards comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24` and `requests>=2.31` for the inspection code.
- One I3S service URL or `.slpk` file and one 3D Tiles tileset covering comparable content.
- For conversion: Cesium's `3d-tiles-tools` and an I3S converter — Esri's `i3s_converter` or the open-source `pyslpk`-style tooling, depending on the direction.

## How Each Structures a Scene

**3D Tiles** is a tree of tiles. Each tile has a bounding volume, a geometric error and optional content — glTF for meshes, `.pnts` for points — and children that refine it. The tree is described by `tileset.json`, which can reference other tilesets, and 3D Tiles 1.1 adds implicit tiling so a regular quadtree or octree needs no explicit JSON per node. Refinement is per tile and declared as `ADD` or `REPLACE`.

**I3S** is a layer with a node index. A scene layer has a typed profile — `3DObject` for buildings, `IntegratedMesh` for photogrammetry, `Point`, `PointCloud`, `Building` for BIM — and a node hierarchy where each node carries its geometry, its textures, its attribute data and a "lod selection" metric analogous to geometric error. A node is a directory of resources in a REST service or entries in a `.slpk` zip.

The structural difference that matters is how much is declared up front. I3S nodes carry richer, self-describing metadata per node, including attribute storage; 3D Tiles keeps the tree lean and pushes metadata into the glTF content or into implicit-tiling subtree files.

<figure class="diagram">
<svg viewBox="6 6 748 268" role="img" aria-labelledby="i3s-struct-t i3s-struct-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i3s-struct-t">Node and tile structures side by side</title>
  <desc id="i3s-struct-d">On the left, a 3D Tiles tileset is a tree of tiles, each with a bounding volume, a geometric error and glTF content, described by one tileset JSON with optional implicit subtrees. On the right, an I3S scene layer has a layer description and a node index, where each node bundles geometry, textures, attributes and a level of detail selection metric as separate resources.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="268" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="240" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="240" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="140" y="56" width="100" height="30" rx="5" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.2">
    <rect x="60" y="120" width="80" height="26"/><rect x="150" y="120" width="80" height="26"/><rect x="240" y="120" width="80" height="26"/>
    <rect x="60" y="176" width="80" height="26"/><rect x="150" y="176" width="80" height="26"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M190 86 L100 118 M190 86 L190 118 M190 86 L280 118"/>
    <path d="M100 146 L100 174 M100 146 L190 174"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="190" y="75">tileset.json</text>
    <text x="100" y="137">tile</text><text x="190" y="137">tile</text><text x="280" y="137">tile</text>
    <text x="100" y="193">tile</text><text x="190" y="193">tile</text>
    <text x="190" y="44">3D Tiles: a tree of tiles</text>
    <text x="190" y="228">each: bounding volume, geometric</text>
    <text x="190" y="246">error, glTF or pnts content</text>
  </g>
  <rect x="440" y="56" width="120" height="30" rx="5" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="600" y="56" width="110" height="30" rx="5" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.2">
    <rect x="430" y="120" width="130" height="26"/><rect x="430" y="152" width="130" height="26"/>
    <rect x="430" y="184" width="130" height="26"/><rect x="600" y="120" width="110" height="90"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="500" y="75">layer description</text>
    <text x="655" y="75">node index</text>
    <text x="495" y="137">geometry buffers</text>
    <text x="495" y="169">textures</text>
    <text x="495" y="201">attribute data</text>
    <text x="655" y="160">node pages:</text>
    <text x="655" y="180">lod metric,</text>
    <text x="655" y="200">obb, children</text>
    <text x="570" y="44">I3S: a layer with node pages</text>
    <text x="570" y="246">per-node resources, typed layer profile</text>
  </g>
</svg>
<figcaption>Both are hierarchies of georeferenced content; I3S bundles more per node, 3D Tiles keeps the tree thin and puts detail in the content.</figcaption>
</figure>

## Layer Types and What Each Handles

| Content | 3D Tiles | I3S |
|---|---|---|
| Buildings as discrete features | glTF with feature metadata | `3DObject` layer |
| Photogrammetric city mesh | glTF tiles | `IntegratedMesh` layer |
| Point clouds | `.pnts` tiles | `PointCloud` layer |
| Points of interest | glTF instances or i3dm | `Point` layer |
| BIM with disciplines | glTF plus metadata | `Building` layer with sublayers |
| Terrain | separate (quantized-mesh or similar) | separate (elevation service) |

Neither standard covers terrain: both leave it to a companion service, which is why a twin's terrain decision is independent of this choice. The I3S `Building` profile is the one genuinely distinct capability — it models BIM disciplines and sublayer filtering natively, where 3D Tiles expresses the same thing through metadata and client-side styling.

## Attributes

Attributes are where the two differ most in practice. I3S stores attribute values in per-node binary attribute resources with a declared schema in the layer description, so a client can filter and query without reading geometry. 3D Tiles 1.1 carries metadata in the glTF through `EXT_structural_metadata`, with property tables per tile, and styling expressions read it in the client — the approach in [attaching EXT_structural_metadata to building tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/).

```python
import json
import requests

def i3s_layer_summary(service_url):
    layer = requests.get(f"{service_url}/layers/0", params={"f": "json"}, timeout=30).json()
    fields = layer.get("attributeStorageInfo", []) or layer.get("fields", [])
    return {
        "name": layer.get("name"),
        "profile": layer.get("layerType") or layer.get("profile"),
        "version": layer.get("store", {}).get("version"),
        "crs": layer.get("spatialReference", {}),
        "attribute_count": len(fields),
        "attributes": [f.get("name") for f in fields][:10],
        "lod_metric": layer.get("nodePages", {}).get("lodSelectionMetricType")
                      or layer.get("store", {}).get("lodType"),
    }

def tileset_summary(tileset_url):
    ts = requests.get(tileset_url, timeout=30).json()
    root = ts["root"]
    return {
        "version": ts["asset"]["version"],
        "geometric_error": ts["geometricError"],
        "refine": root.get("refine"),
        "bounding_volume": next(iter(root["boundingVolume"])),
        "has_implicit": "implicitTiling" in root,
        "children": len(root.get("children", [])),
    }

print(i3s_layer_summary("https://services.example.org/SceneServer"))
print(tileset_summary("https://tiles.example.org/city/tileset.json"))
```

Inspecting both before choosing is worth the ten lines: the layer type, the attribute count and the level-of-detail metric tell you what a client will be able to do with the data, which is more informative than any specification comparison.

<figure class="diagram">
<svg viewBox="6 16 748 238" role="img" aria-labelledby="i3s-attr-t i3s-attr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i3s-attr-t">Where attributes live in each standard</title>
  <desc id="i3s-attr-d">In I3S, the layer description declares an attribute schema and each node carries binary attribute resources alongside its geometry, so a client can read values without decoding meshes. In 3D Tiles, property tables travel inside the glTF content through the structural metadata extension, so values arrive with the geometry and are read by styling expressions.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="238" fill="#ffffff"/>
  <rect x="20" y="30" width="340" height="180" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="400" y="30" width="340" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.3">
    <rect x="50" y="70" width="130" height="34"/>
    <rect x="200" y="70" width="130" height="34"/>
    <rect x="50" y="130" width="130" height="34"/>
    <rect x="200" y="130" width="130" height="34"/>
    <rect x="430" y="100" width="280" height="34"/>
    <rect x="450" y="150" width="240" height="34"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="115" y="91">attribute schema</text>
    <text x="265" y="91">node geometry</text>
    <text x="115" y="151">attribute binaries</text>
    <text x="265" y="151">node textures</text>
    <text x="570" y="121">glTF content</text>
    <text x="570" y="171">property tables inside it</text>
    <text x="190" y="54">I3S: attributes beside the geometry</text>
    <text x="570" y="54">3D Tiles: attributes inside the content</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">I3S can answer an attribute query without decoding meshes; 3D Tiles ships values with the geometry that uses them.</text>
</svg>
<figcaption>The difference shows up in filtering: separate attribute resources suit server-side queries, embedded property tables suit client-side styling.</figcaption>
</figure>

## Client Support

This is usually the deciding factor and it changes, so verify against the versions you ship rather than trusting a table. As of current releases: CesiumJS reads 3D Tiles natively and I3S through an adapter that translates node pages into tiles; ArcGIS clients read I3S natively and 3D Tiles with varying completeness; deck.gl reads both through loaders; Unreal and Unity plugins in the Cesium ecosystem read 3D Tiles. Most web twins therefore find 3D Tiles the shorter path, and most ArcGIS-centred organisations find I3S the shorter path — which is an organisational fact rather than a technical one.

## Serving Both From One Pipeline

The productive answer for a programme that needs both is to keep one authoritative source and generate both deliveries, rather than converting one delivery into the other repeatedly.

```python
import subprocess
from pathlib import Path

def build_deliveries(source_dir, out_dir):
    """One source of truth → 3D Tiles and I3S, each generated, neither converted from the other."""
    out = Path(out_dir)
    (out / "3dtiles").mkdir(parents=True, exist_ok=True)
    (out / "i3s").mkdir(parents=True, exist_ok=True)

    # 3D Tiles from the canonical glTF-per-feature export
    subprocess.run(["python", "tools/tile_from_gltf.py", "--src", str(source_dir),
                    "--out", str(out / "3dtiles")], check=True)

    # I3S from the same export via a converter
    subprocess.run(["i3s_converter", "--input", str(source_dir),
                    "--output", str(out / "i3s" / "city.slpk"),
                    "--layer-type", "3DObject"], check=True)

    return {p.name: sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            for p in (out / "3dtiles", out / "i3s")}

print(build_deliveries("build/canonical_gltf", "build/deliveries"))
```

The principle is the same as for any dual-format delivery: the canonical form is the one with the most information — here, per-feature glTF with metadata and a full attribute table — and both public formats are derived. Converting 3D Tiles to I3S or back loses a little each time and leaves neither side able to say which is authoritative. There is a conversion route through `3d-tiles-tools` and Esri's converters when a one-off is needed, and it should stay a one-off.

<figure class="diagram">
<svg viewBox="6 6 748 212" role="img" aria-labelledby="i3s-dual-t i3s-dual-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i3s-dual-t">Dual delivery from one canonical source</title>
  <desc id="i3s-dual-d">A canonical per-feature export with attributes feeds two generators, one producing 3D Tiles and one producing an I3S scene layer package. The alternative, converting one delivery format into the other, is shown as a chain that loses information at each step and leaves no authoritative source.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="212" fill="#ffffff"/>
  <defs>
    <marker id="i3s-dual-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="170" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="280" y="20" width="170" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="280" y="108" width="170" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#i3s-dual-arrow)">
    <path d="M190 82 L278 52"/>
    <path d="M190 98 L278 130"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="105" y="84">canonical glTF</text><text x="105" y="104">+ attributes</text>
    <text x="365" y="42">3D Tiles delivery</text><text x="365" y="60">generated</text>
    <text x="365" y="130">I3S delivery</text><text x="365" y="148">generated</text>
  </g>
  <rect x="520" y="60" width="220" height="60" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="630" y="84" fill="#1f2937" font-size="12.5" text-anchor="middle">converting delivery → delivery</text>
  <text x="630" y="104" fill="#1f2937" font-size="12.5" text-anchor="middle">loses metadata each pass</text>
  <text x="380" y="200" fill="#15384a" font-size="12.5" text-anchor="middle">Generate both from the source; convert only for a one-off hand-over.</text>
</svg>
<figcaption>Two generated deliveries stay consistent because they share an origin; a converted pair diverges with every rebuild.</figcaption>
</figure>

## Expected Output & Verification

```text
{'name': 'Buildings_LOD2', 'profile': '3DObject', 'version': '2.0',
 'crs': {'wkid': 25832, 'vcsWkid': 7837}, 'attribute_count': 14,
 'attributes': ['building_id', 'function', 'measuredHeight', 'yearOfConstruction'],
 'lod_metric': 'maxScreenThresholdSQ'}
{'version': '1.1', 'geometric_error': 1612.4, 'refine': 'ADD',
 'bounding_volume': 'region', 'has_implicit': False, 'children': 16}
{'3dtiles': 1204884102, 'i3s': 1388204471}
```

Verify the two deliveries describe the same content, because a dual-delivery pipeline's characteristic failure is one side silently missing a district.

```python
def compare_deliveries(tiles_root, slpk_path):
    import zipfile
    tiles_bytes = sum(f.stat().st_size for f in Path(tiles_root).rglob("*") if f.is_file())
    with zipfile.ZipFile(slpk_path) as z:
        nodes = {n.split("/")[1] for n in z.namelist() if n.startswith("nodes/")}
        slpk_bytes = sum(i.file_size for i in z.infolist())
    return {"tiles_bytes": tiles_bytes, "slpk_bytes": slpk_bytes,
            "i3s_nodes": len(nodes),
            "ratio": round(slpk_bytes / tiles_bytes, 2)}

print(compare_deliveries("build/deliveries/3dtiles", "build/deliveries/i3s/city.slpk"))
```

A size ratio between roughly 0.8 and 1.5 is normal — the formats compress textures and geometry differently. A ratio of 0.3 or 3.0 means one side dropped content or one side kept textures the other discarded. Then check feature counts: the number of distinct feature identifiers in the 3D Tiles metadata should equal the attribute row count in the I3S layer, and any difference is a district or a class of objects that one generator filtered out.

## Common Errors

**Assuming a `.slpk` can be served as static files.** It is a zip archive with a specific internal layout; serving it requires either an indexed service or unpacking it into the REST layout. A twin that copies the archive onto a CDN and expects a client to read it will get nothing.

**Expecting attribute filtering to behave the same.** I3S clients can filter on attributes the server exposes; 3D Tiles clients style on metadata they have downloaded. A "filter" that works in one portal is a different mechanism from the visually identical one in the other.

**Converting repeatedly in both directions.** Each pass loses metadata fidelity and texture quality. Convert once for a hand-over, generate for anything ongoing.

**Ignoring the vertical CRS in the I3S layer description.** `vcsWkid` is a separate field from `wkid` and is frequently unset, which puts the layer's heights on the ellipsoid — the same failure as everywhere else in twin ingestion.

## Frequently Asked Questions

### Which standard is more widely supported?

3D Tiles has broader support among web and game-engine clients; I3S has deeper support inside the ArcGIS ecosystem. Both are OGC community standards, so neither is a lock-in risk at the specification level — the risk is in tooling.

### Can one tileset serve both types of client?

Through adapters, mostly. CesiumJS can consume I3S, and several loaders read both. Adapters lag the specifications, so a twin that must serve both audiences reliably generates both.

### Is there an equivalent of implicit tiling in I3S?

I3S node pages serve a similar purpose: they describe many nodes compactly so a client does not fetch one document per node. The mechanisms differ; the goal — avoid a request per node — is the same.

### What about terrain?

Out of scope for both. Terrain is delivered by a separate service in either architecture, which is why the choice here does not constrain the terrain decision described in [generating quantized-mesh terrain tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/generating-quantized-mesh-terrain-tiles/).

## Related Guides

- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — the content-level comparison
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — source versus delivery
- [Attaching EXT_structural_metadata to Building Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/) — how attributes travel in 3D Tiles

Back to [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
