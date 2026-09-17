---
title: "Generating Instanced Tiles for Trees"
description: "Stream a million street trees as GPU instances: EXT_mesh_gpu_instancing in glTF, per-instance rotation and scale, species variants"
---
# Generating Instanced Tiles for Trees

This page turns a municipal tree register of 1.2 million records into instanced 3D Tiles content — one small mesh per species, positioned by `EXT_mesh_gpu_instancing`, with per-instance rotation, scale and colour variation, packed into tiles that respect a draw-call budget, and verified against the register.

## Why you hit this

A city tree layer is the clearest case for instancing there is: a handful of distinct geometries repeated a million times with different transforms. Baking each tree as unique geometry produces hundreds of gigabytes and a viewer that cannot render it. Instancing sends the mesh once and a transform per copy, which turns 1.2 million trees into a few hundred megabytes and one draw call per tile per species.

The same technique applies to street furniture, lamp posts, bollards, hydrants and parked vehicles, and the register-to-tileset shape of the problem is identical. What changes is the mesh count and the attributes.

## Prerequisites

- Python 3.10+ with `geopandas`, `numpy`, `pyproj`, `pygltflib` or direct JSON/GLB writing.
- `gltf-transform` from npm, for inspection and compression.
- One low-poly mesh per species class, Y-up, origin at the trunk base, in metres.
- The tree register with position, species, height and crown diameter.

## Step-by-Step

### 1. Reduce the register to instanceable classes

```python
import json
import math
from collections import Counter
from pathlib import Path

import geopandas as gpd
import numpy as np

SPECIES_TO_MESH = {
    "Tilia cordata": "broadleaf_round",
    "Acer platanoides": "broadleaf_round",
    "Quercus robur": "broadleaf_broad",
    "Betula pendula": "broadleaf_narrow",
    "Pinus sylvestris": "conifer_tall",
    "Picea abies": "conifer_tall",
}
DEFAULT_MESH = "broadleaf_round"

def classify(register_path):
    gdf = gpd.read_file(register_path)
    gdf["mesh"] = gdf["species"].map(SPECIES_TO_MESH).fillna(DEFAULT_MESH)
    gdf["height_m"] = gdf["height_m"].clip(lower=1.5, upper=42.0)
    gdf["crown_m"] = gdf["crown_m"].fillna(gdf["height_m"] * 0.45).clip(lower=0.8, upper=28.0)
    counts = Counter(gdf["mesh"])
    unmapped = sorted(set(gdf.loc[~gdf["species"].isin(SPECIES_TO_MESH), "species"].dropna()))
    return gdf, {"trees": len(gdf), "by_mesh": dict(counts),
                 "unmapped_species": len(unmapped), "examples": unmapped[:5]}

trees, summary = classify("input/tree_register.gpkg")
print(json.dumps(summary, indent=2))
```

Five meshes for 340 species is the right ratio. A viewer at street level cannot distinguish a lime from a maple at any realistic frame budget, and each additional mesh is another draw call in every tile that contains it — so the mapping should collapse species into silhouette classes, not preserve botanical distinctions.

Clipping height and crown diameter matters because registers contain data-entry errors: a 340 m tree from a units mistake will produce a bounding volume covering the district and a scale factor that makes one instance fill the screen.

### 2. Compute the per-instance transform

```python
from pyproj import CRS, Transformer

TO_ECEF = Transformer.from_crs(CRS.from_epsg(25832), CRS.from_epsg(4978), always_xy=True)

def instance_arrays(subset, reference_height_m=8.0, reference_crown_m=4.0, seed=7):
    """Positions relative to the tile centre, plus rotation and non-uniform scale."""
    rng = np.random.default_rng(seed)
    x, y, z = TO_ECEF.transform(subset.geometry.x.values,
                                subset.geometry.y.values,
                                subset["ground_h_m"].values)
    pts = np.column_stack([x, y, z])
    centre = pts.mean(axis=0)
    local = (pts - centre).astype(np.float32)

    yaw = rng.uniform(0.0, 2.0 * math.pi, len(subset)).astype(np.float32)
    rotation = np.zeros((len(subset), 4), dtype=np.float32)
    rotation[:, 1] = np.sin(yaw / 2.0)               # quaternion about Y (up, in glTF)
    rotation[:, 3] = np.cos(yaw / 2.0)

    vert = (subset["height_m"].values / reference_height_m).astype(np.float32)
    horiz = (subset["crown_m"].values / reference_crown_m).astype(np.float32)
    jitter = rng.normal(1.0, 0.035, (len(subset), 3)).astype(np.float32)
    scale = np.column_stack([horiz, vert, horiz]) * jitter

    return {"centre_ecef": centre, "translation": local,
            "rotation": rotation, "scale": scale}
```

Random yaw is what stops an instanced avenue looking like a wallpaper pattern; it costs four floats per instance and is the single largest visual improvement available. The 3.5% scale jitter does the same job for silhouette, breaking up the identical outlines that otherwise read as artificial at a glance.

Non-uniform scale — crown diameter horizontally, height vertically — is what makes one mesh serve a young lime and a mature oak. It requires the source mesh to be modelled at a known reference size, which is why `reference_height_m` is explicit rather than assumed.

Storing translations relative to the tile centre keeps them small enough for float32, exactly as in [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/). Absolute ECEF translations in float32 would quantise tree positions to about 25 cm.

<figure class="diagram">
<svg viewBox="6 8 748 222" role="img" aria-labelledby="inst-what-t inst-what-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inst-what-t">What instancing sends versus baked geometry</title>
  <desc id="inst-what-d">A comparison table. Baked geometry for 4200 trees in one tile sends 4200 copies of a 900-triangle mesh, about 3.8 million triangles and 96 megabytes, in up to 4200 draw calls. Instanced content sends five meshes once, 4500 triangles total, plus 4200 transforms of 40 bytes each, giving 0.36 megabytes and five draw calls.</desc>
  <rect class="svg-bg" x="6" y="8" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="22" width="240" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="22" width="250" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="510" y="22" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="240" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="260" y="56" width="250" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="56" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="90" width="240" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="260" y="90" width="250" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="90" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="124" width="240" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="260" y="124" width="250" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="124" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="158" width="240" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="260" y="158" width="250" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="158" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="140" y="45">4200 trees in one tile</text><text x="385" y="45">baked geometry</text><text x="625" y="45">instanced</text>
    <text x="140" y="78">mesh data sent</text><text x="385" y="78">4200 × 900 triangles</text><text x="625" y="78">5 × 900 triangles, once</text>
    <text x="140" y="112">triangles in memory</text><text x="385" y="112">3.8 M</text><text x="625" y="112">4.5 k + GPU instancing</text>
    <text x="140" y="146">tile payload</text><text x="385" y="146">96 MB</text><text x="625" y="146">0.36 MB</text>
    <text x="140" y="180">draw calls</text><text x="385" y="180">up to 4200</text><text x="625" y="180">5</text>
  </g>
  <text x="380" y="212" fill="#5b6471" font-size="12" text-anchor="middle">40 bytes per instance: translation, rotation quaternion, scale</text>
</svg>
<figcaption>Two orders of magnitude on payload and three on draw calls, for the same scene.</figcaption>
</figure>

### 3. Write the glTF with EXT_mesh_gpu_instancing

```python
import struct

def build_instanced_glb(mesh_gltf_path, arrays, out_path):
    """Attach instance attributes to every node that has a mesh."""
    doc = json.loads(Path(mesh_gltf_path).read_text())
    buffers, views, accessors = [], list(doc.get("bufferViews", [])), list(doc.get("accessors", []))
    blob = bytearray()

    def add(array, comp_type, type_str):
        data = np.ascontiguousarray(array, dtype=np.float32).tobytes()
        offset = len(blob)
        blob.extend(data)
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data)})
        acc = {"bufferView": len(views) - 1, "componentType": comp_type,
               "count": int(len(array)), "type": type_str}
        if type_str == "VEC3":
            acc["min"] = [float(v) for v in np.min(array, axis=0)]
            acc["max"] = [float(v) for v in np.max(array, axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    t = add(arrays["translation"], 5126, "VEC3")
    r = add(arrays["rotation"], 5126, "VEC4")
    s = add(arrays["scale"], 5126, "VEC3")

    doc["bufferViews"] = views
    doc["accessors"] = accessors
    doc.setdefault("extensionsUsed", [])
    if "EXT_mesh_gpu_instancing" not in doc["extensionsUsed"]:
        doc["extensionsUsed"].append("EXT_mesh_gpu_instancing")
    doc.setdefault("extensionsRequired", [])
    if "EXT_mesh_gpu_instancing" not in doc["extensionsRequired"]:
        doc["extensionsRequired"].append("EXT_mesh_gpu_instancing")

    for node in doc["nodes"]:
        if "mesh" in node:
            node.setdefault("extensions", {})["EXT_mesh_gpu_instancing"] = {
                "attributes": {"TRANSLATION": t, "ROTATION": r, "SCALE": s}}

    doc["buffers"] = [{"byteLength": len(blob)}]
    write_glb(doc, bytes(blob), out_path)
    return {"instances": int(len(arrays["translation"])), "bytes": out_path and Path(out_path).stat().st_size}

def write_glb(gltf_json, bin_blob, out_path):
    js = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    bin_pad = bin_blob + b"\x00" * ((4 - len(bin_blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_pad)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(bin_pad), 0x004E4942)); f.write(bin_pad)
```

`EXT_mesh_gpu_instancing` is the 3D Tiles 1.1 way to do this, and it replaces the older `i3dm` tile format entirely: the content is ordinary glTF that any glTF tool can read, with instance attributes hanging off the node. The three attributes are optional individually — a tileset with only `TRANSLATION` is valid and is the right choice for bollards, which need neither rotation nor scale.

Listing the extension in `extensionsRequired` is deliberate. A client that ignores it would draw one tree at the tile origin and nothing else, which looks like a data problem rather than a capability problem; declaring it required makes the failure explicit.

Instance attributes must not be Draco-compressed — the extension's accessors are read as instance data, and Draco applies to mesh primitives. Quantising them with `KHR_mesh_quantization` is supported and halves the transform payload.

### 4. Pack instances into tiles

```python
def pack_tiles(gdf, tile_m=250.0, max_instances=6000):
    """Grid the register, then split dense cells so no tile exceeds the budget."""
    xs = gdf.geometry.x.values
    ys = gdf.geometry.y.values
    i = np.floor((xs - xs.min()) / tile_m).astype(np.int64)
    j = np.floor((ys - ys.min()) / tile_m).astype(np.int64)
    gdf = gdf.assign(_i=i, _j=j)
    tiles = []
    for (ti, tj), cell in gdf.groupby(["_i", "_j"]):
        if len(cell) <= max_instances:
            tiles.append({"key": f"{ti}_{tj}", "rows": cell})
            continue
        parts = math.ceil(len(cell) / max_instances)
        order = np.argsort(cell.geometry.x.values, kind="stable")
        for p, chunk in enumerate(np.array_split(order, parts)):
            tiles.append({"key": f"{ti}_{tj}_p{p}", "rows": cell.iloc[chunk]})
    sizes = [len(t["rows"]) for t in tiles]
    return tiles, {"tiles": len(tiles), "max": max(sizes), "median": int(np.median(sizes)),
                   "empty_cells_skipped": True}

tiles, pack_stats = pack_tiles(trees)
print(pack_stats)
```

The instance count per tile is the real budget, not the byte count: 40 bytes per instance means even 20,000 trees is under a megabyte, but the vertex shader still transforms every instance in a visible tile whether or not it covers a pixel. Six thousand per tile keeps a dense park tile within a frame at 60 Hz on integrated graphics.

Splitting a dense cell by sorted x rather than by another grid level keeps the sub-tiles spatially coherent, so frustum culling still works on them — a random split would give every part a bounding volume covering the whole cell.

### 5. Write one content file per mesh class per tile

```python
def emit_tile(tile, out_dir="output/content", meshes_dir="assets/meshes"):
    written = []
    for mesh_name, subset in tile["rows"].groupby("mesh"):
        arrays = instance_arrays(subset)
        out = Path(out_dir) / f"{tile['key']}__{mesh_name}.glb"
        out.parent.mkdir(parents=True, exist_ok=True)
        stats = build_instanced_glb(Path(meshes_dir) / f"{mesh_name}.gltf", arrays, out)
        written.append({"uri": out.name, "mesh": mesh_name,
                        "instances": stats["instances"], "bytes": stats["bytes"],
                        "centre_ecef": [float(v) for v in arrays["centre_ecef"]],
                        "max_height_m": float(subset["height_m"].max())})
    return written

def tile_bounding_sphere(entries, crown_margin_m=14.0):
    """One sphere covering every instance group in the tile."""
    centres = np.array([e["centre_ecef"] for e in entries])
    c = centres.mean(axis=0)
    spread = float(np.linalg.norm(centres - c, axis=1).max()) if len(centres) > 1 else 0.0
    reach = max(e["max_height_m"] for e in entries) + crown_margin_m
    return [*map(float, c), spread + reach]
```

Grouping by mesh class inside the tile is what keeps the draw calls at five rather than one: each content file holds one mesh and its instances, and the client issues one instanced draw per file. It also means a tile with only limes ships one file, not five.

The bounding volume has to include the crown reach above the trunk base, and forgetting that is a common cause of trees disappearing when the camera looks up at them — the volume covers the ground positions, the camera frustum misses it, and the tile is culled while its geometry is on screen.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="inst-attrs-t inst-attrs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inst-attrs-t">The three instance attributes and what each one buys</title>
  <desc id="inst-attrs-d">A table of the three EXT_mesh_gpu_instancing attributes. TRANSLATION is twelve bytes per instance and is mandatory in practice. ROTATION is a sixteen-byte quaternion and is what stops an avenue of trees looking like wallpaper. SCALE is twelve bytes and lets one mesh serve a young lime and a mature oak. All three together are forty bytes per instance.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="152" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="170" y="20" width="168" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="20" width="84" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="422" y="20" width="300" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="54" width="168" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="54" width="84" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="422" y="54" width="300" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="88" width="168" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="88" width="84" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="422" y="88" width="300" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="122" width="168" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="122" width="84" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="422" y="122" width="300" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="152" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="170" y="156" width="168" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="156" width="84" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="422" y="156" width="300" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="94" y="42">attribute</text><text x="254" y="42">type</text><text x="380" y="42">bytes</text><text x="572" y="42">what it buys</text>
    <text x="94" y="76">TRANSLATION</text><text x="254" y="76">VEC3 float</text><text x="380" y="76">12</text><text x="572" y="76">position — always needed</text>
    <text x="94" y="110">ROTATION</text><text x="254" y="110">VEC4 quaternion</text><text x="380" y="110">16</text><text x="572" y="110">random yaw breaks the pattern</text>
    <text x="94" y="144">SCALE</text><text x="254" y="144">VEC3 float</text><text x="380" y="144">12</text><text x="572" y="144">height and crown from one mesh</text>
    <text x="94" y="178">all three</text><text x="254" y="178">—</text><text x="380" y="178">40</text><text x="572" y="178">1.2 M trees in 48 MB of transforms</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Bollards need only TRANSLATION, at 12 bytes per instance.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">KHR_mesh_quantization halves all three and is visually indistinguishable for trees.</text>
</svg>
<figcaption>Forty bytes per instance for the full set, and the rotation is the one that stops the avenue looking artificial.</figcaption>
</figure>

### 6. Assemble the tileset with a sensible refinement policy

```python
def build_tileset(tiles, out="output/trees/tileset.json", tile_m=250.0):
    children = []
    for tile in tiles:
        entries = emit_tile(tile)
        if not entries:
            continue
        sphere = tile_bounding_sphere(entries)
        for entry in entries:
            children.append({
                "boundingVolume": {"sphere": sphere},
                "geometricError": 0.0,
                "content": {"uri": f"content/{entry['uri']}"},
                "extras": {"instances": entry["instances"], "mesh": entry["mesh"]},
            })
    all_c = np.array([c["boundingVolume"]["sphere"][:3] for c in children])
    root_c = all_c.mean(axis=0)
    root_r = float(np.linalg.norm(all_c - root_c, axis=1).max() + tile_m)
    doc = {"asset": {"version": "1.1"},
           "geometricError": 1024.0,
           "root": {"boundingVolume": {"sphere": [*map(float, root_c), root_r]},
                    "geometricError": 1024.0, "refine": "ADD", "children": children}}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")))
    return {"tiles": len(children), "instances": sum(c["extras"]["instances"] for c in children)}

print(build_tileset(tiles))
```

`ADD` refinement with a flat tree is right for a tree layer: there is no coarse version of a tree worth showing, so the behaviour you want is "load trees within this distance, show nothing beyond it". The root's geometric error of 1024 m sets that distance — with a 16-pixel error budget on a 1080-pixel viewport, trees start loading at roughly 60 km, which is too far; 256 m is a better starting value and brings them in at about 15 km.

An alternative worth considering for very large registers is a two-level tree where the upper level holds only the largest 5% of trees, so a distant view shows the canopy structure without a million instances.

<figure class="diagram">
<svg viewBox="21 -4 694 260" role="img" aria-labelledby="inst-budget-t inst-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inst-budget-t">Instances per tile against frame cost</title>
  <desc id="inst-budget-d">A chart relating instance count per tile to measured frame time on integrated graphics, with 24 tiles visible. At 2000 instances per tile frame time is 9 milliseconds. At 6000 it is 14 milliseconds, still inside the 16.7 millisecond budget for 60 frames per second. At 12000 it is 23 milliseconds and at 20000 it is 38 milliseconds, both over budget.</desc>
  <rect class="svg-bg" x="21" y="-4" width="694" height="260" fill="#ffffff"/>
  <path d="M96 26 V198 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M96 118 H700" stroke="#b0413e" stroke-width="1.6" stroke-dasharray="7 5" fill="none"/>
  <text x="700" y="112" fill="#b0413e" font-size="12" text-anchor="end">16.7 ms — 60 fps budget</text>
  <g stroke-width="1.5">
    <rect x="130" y="152" width="80" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="130" width="80" height="66" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="86" width="80" height="110" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="550" y="30" width="80" height="166" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="146">9 ms</text>
    <text x="310" y="124">14 ms</text>
    <text x="450" y="80">23 ms</text>
    <text x="590" y="24">38 ms</text>
    <text x="170" y="216">2 000</text><text x="310" y="216">6 000</text>
    <text x="450" y="216">12 000</text><text x="590" y="216">20 000</text>
  </g>
  <text x="400" y="238" fill="#5b6471" font-size="12" text-anchor="middle">instances per tile, 24 tiles in view</text>
  <text x="52" y="112" fill="#5b6471" font-size="12" text-anchor="middle">frame</text>
  <text x="52" y="128" fill="#5b6471" font-size="12" text-anchor="middle">time</text>
</svg>
<figcaption>Six thousand instances per tile leaves headroom on integrated graphics; twelve thousand does not.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "trees": 1204418,
  "by_mesh": {"broadleaf_round": 702118, "broadleaf_broad": 214005,
              "broadleaf_narrow": 168820, "conifer_tall": 119475},
  "unmapped_species": 334,
  "examples": ["Aesculus hippocastanum", "Alnus glutinosa", "Carpinus betulus"]
}
{'tiles': 412, 'max': 6000, 'median': 2864, 'empty_cells_skipped': True}
{'tiles': 1188, 'instances': 1204418}
```

The instance total in the tileset must equal the register count exactly, and that equality is the main correctness check — 1,188 content files for 412 tiles means about three mesh classes per tile, which is what you expect from a mixed urban register.

Verify the instance data round-trips through the glTF, because a wrong accessor count or type produces trees at the origin rather than an error:

```python
import subprocess

def inspect_instances(glb_path):
    proc = subprocess.run(["npx", "gltf-transform", "inspect", glb_path],
                          capture_output=True, text=True)
    doc_json = subprocess.run(["npx", "gltf-transform", "copy", glb_path, "/dev/stdout", "--format", "gltf"],
                              capture_output=True, text=True)
    doc = json.loads(doc_json.stdout) if doc_json.returncode == 0 else {}
    rows = []
    for node in doc.get("nodes", []):
        ext = node.get("extensions", {}).get("EXT_mesh_gpu_instancing")
        if not ext:
            continue
        attrs = ext["attributes"]
        counts = {k: doc["accessors"][v]["count"] for k, v in attrs.items()}
        types = {k: doc["accessors"][v]["type"] for k, v in attrs.items()}
        rows.append({"node": node.get("name", "?"), "counts": counts, "types": types,
                     "consistent": len(set(counts.values())) == 1,
                     "types_ok": types.get("ROTATION") in (None, "VEC4")
                                 and types.get("TRANSLATION") in (None, "VEC3")})
    return {"nodes_with_instancing": len(rows), "rows": rows[:3],
            "required": "EXT_mesh_gpu_instancing" in doc.get("extensionsRequired", [])}

print(json.dumps(inspect_instances("output/content/12_9__broadleaf_round.glb"), indent=2))
```

All three attributes must have identical counts; a mismatch is accepted by the parser and produces undefined placement for the surplus instances. The `types_ok` check catches the most common authoring bug, writing rotation as a VEC3 of Euler angles instead of a VEC4 quaternion.

Then verify the geographic placement against the register independently of the glTF:

```python
def placement_check(tileset_path, register, sample=2000, tol_m=0.25):
    from pyproj import Transformer
    to_geo = Transformer.from_crs(CRS.from_epsg(4978), CRS.from_epsg(4326), always_xy=True)
    doc = json.loads(Path(tileset_path).read_text())
    spheres = np.array([c["boundingVolume"]["sphere"] for c in doc["root"]["children"]])
    reg = register.sample(min(sample, len(register)), random_state=3)
    to_ecef = Transformer.from_crs(CRS.from_epsg(25832), CRS.from_epsg(4978), always_xy=True)
    x, y, z = to_ecef.transform(reg.geometry.x.values, reg.geometry.y.values,
                                reg["ground_h_m"].values)
    pts = np.column_stack([x, y, z])
    inside = np.zeros(len(pts), dtype=bool)
    for s in spheres:
        d = np.linalg.norm(pts - s[:3], axis=1)
        inside |= d <= s[3]
    return {"sampled": len(pts), "covered": int(inside.sum()),
            "uncovered": int((~inside).sum()),
            "all_covered": bool(inside.all())}

print(placement_check("output/trees/tileset.json", trees))
```

Every sampled register position must fall inside at least one tile's bounding sphere. An uncovered tree means either a tile was dropped during emission or its sphere is too tight — both of which produce trees that never appear, and neither of which the validator detects.

## Performance Notes

- **40 bytes per instance** with all three attributes; 12 bytes with translation only. A million trees is 40 MB of transform data across the whole tileset.
- **Quantise with `KHR_mesh_quantization`** to halve that: translations to unsigned short relative to the tile, rotations to signed byte. Visually indistinguishable for trees.
- **Keep the source mesh under 1,000 triangles.** The mesh cost is paid per instance in the rasteriser even though the vertices are sent once; a 20,000-triangle tree model is what actually kills frame rate.
- **Alpha-blended foliage is expensive.** Prefer alpha-cutout over blending for crown cards — it avoids the sorting and the overdraw.
- **One content file per mesh class per tile**, not one per species. Draw calls scale with files in view.
- **Writing 1,188 GLB files takes about 4 minutes** single-threaded, almost all of it in `np.tobytes` and disk. It shards per tile if needed.

## Common Errors

**All trees appear at one point.** The client ignored the extension, or the instance accessors are not attached to a node that has a mesh. Declare the extension as required and attach to mesh nodes.

**Trees are 25 cm off their surveyed positions.** Translations stored as absolute ECEF in float32. Store relative to the tile centre and put the centre in the tile transform.

**Trees disappear when the camera tilts up.** The bounding volume covers ground positions only. Add the crown reach.

**Some trees are enormous.** An unclipped height value from a register error, multiplied into the scale attribute. Clip on read.

**Every tree faces the same way.** Rotation attribute omitted or all-identity. Add random yaw.

**The GLB is rejected as invalid.** Instance accessors need no `bufferView` target, but they do need correct `count`, `type` and byte alignment. Every buffer view offset must be a multiple of 4.

**Draco compression breaks the instancing.** Draco applies to mesh primitives, not instance attributes. Compress the mesh, leave the instance accessors alone.

## Frequently Asked Questions

### Should I use i3dm instead?

No. `i3dm` is the legacy 1.0 format; `EXT_mesh_gpu_instancing` in glTF content is the 1.1 equivalent, is readable by ordinary glTF tooling, and is what current viewers prefer.

### Can instances have per-instance colour?

Yes, through a custom attribute such as `_FEATURE_ID` plus a metadata property table, or a per-instance `_COLOR_0` where the client supports it. Feature IDs are the portable route and also give you picking.

### How do I make trees pickable?

Assign a feature ID per instance and a property table with the register's identifier, using the 3D Tiles metadata system. The client then resolves a click to a row in the register.

## Related Guides

- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — the tileset structure these tiles go into
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — driving appearance from register attributes
- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — the non-instanced side of the same budget

Back to [Automated Tile Generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
