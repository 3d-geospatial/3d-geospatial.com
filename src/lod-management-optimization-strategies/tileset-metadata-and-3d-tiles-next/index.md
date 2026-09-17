---
title: "Tileset Metadata and 3D Tiles Next"
description: "Implicit tiling, subtree files and EXT_structural_metadata in 3D Tiles 1.1 — what replaces the batch table, what it costs, and how to migrate a 1.0 tileset."
---
# Tileset Metadata and 3D Tiles Next

3D Tiles 1.1 folded the "3D Tiles Next" extensions into the core specification and changed two things that matter to a production pipeline: the tile tree no longer has to be written out node by node, and per-feature attributes no longer live in a JSON batch table bolted onto each `b3dm`. This guide covers implicit tiling and its subtree files, `EXT_structural_metadata` and the schema it demands, what each of them costs, and how to migrate a working 1.0 tileset without a flag day.

The short version of why it matters: a city-scale 1.0 tileset spends a large fraction of its bytes and nearly all of its authoring complexity describing its own tree. Implicit tiling replaces that description with an addressing rule, so a tileset that used to ship a 40 MB `tileset.json` ships a few kilobytes and a handful of binary subtrees. That is a delivery improvement and a build-pipeline simplification at the same time — the [batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) no longer has to serialise a tree at all.

## Prerequisites

- **A working 1.0 tileset** with explicit `children` arrays, produced by `py3dtiles`, Cesium's `3d-tiles-tools`, or your own writer.
- **Node 18+** with `3d-tiles-tools` (`npm i -g 3d-tiles-tools`) and `3d-tiles-validator`, plus Python 3.10+ with `numpy>=1.24` for writing subtree buffers.
- **CesiumJS 1.107+** or another client that reads 1.1. Older clients read 1.0 only, which is the constraint that decides whether you can migrate or must dual-publish.
- **A quadtree or octree with uniform subdivision.** Implicit tiling requires it — a hand-tuned tree where some nodes split and others do not cannot be addressed by rule, and has to stay explicit.

## Concept

**Explicit tiling** writes every node: a `tileset.json` containing a nested structure where each node carries its bounding volume, geometric error, refinement mode and the URI of its content. At depth 12 over a city that is millions of JSON objects, and a client cannot request any tile without first parsing enough of the tree to find it.

**Implicit tiling** replaces the tree with three statements: the subdivision scheme (`QUADTREE` or `OCTREE`), the number of levels, and templated URIs containing `{level}`, `{x}`, `{y}` and optionally `{z}`. The client computes a tile's address arithmetically and requests it directly. What the tileset still has to say is which of those addressable tiles actually exist, and that is what a **subtree** file carries: a bitstream, one bit per node, marking availability.

<figure class="diagram">
<svg viewBox="-12 34 784 250" role="img" aria-labelledby="tn-impl-t tn-impl-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tn-impl-t">An explicit tree against an addressing rule plus availability bits</title>
  <desc id="tn-impl-d">An explicit tileset writes one JSON object per node, so the file grows with the number of tiles. An implicit tileset states the subdivision scheme, the level count and a templated URI, then carries one bit per node in a binary subtree to say which tiles exist. The second form is constant-size in JSON and grows only in the bitstream.</desc>
  <rect class="svg-bg" x="-12" y="34" width="784" height="250" fill="#ffffff"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="120" y="48" width="120" height="30" rx="5"/>
    <rect x="40" y="98" width="120" height="30" rx="5"/>
    <rect x="200" y="98" width="120" height="30" rx="5"/>
    <rect x="20" y="148" width="80" height="30" rx="5"/>
    <rect x="110" y="148" width="80" height="30" rx="5"/>
    <rect x="200" y="148" width="80" height="30" rx="5"/>
    <rect x="290" y="148" width="60" height="30" rx="5"/>
  </g>
  <g fill="#1f2937" font-size="11" text-anchor="middle">
    <text x="180" y="68">root object</text>
    <text x="100" y="118">child object</text>
    <text x="260" y="118">child object</text>
    <text x="60" y="168">leaf</text>
    <text x="150" y="168">leaf</text>
    <text x="240" y="168">leaf</text>
    <text x="320" y="168">leaf</text>
  </g>
  <text x="185" y="204" fill="#b0413e" font-size="12.5" text-anchor="middle">explicit: one JSON object per node</text>
  <text x="185" y="226" fill="#5b6471" font-size="12" text-anchor="middle">a depth-12 city is ~22 million of them</text>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="430" y="48" width="290" height="34" rx="6"/>
    <rect x="430" y="92" width="290" height="34" rx="6"/>
    <rect x="430" y="136" width="290" height="42" rx="6"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="575" y="70">subdivisionScheme: QUADTREE, 12 levels</text>
    <text x="575" y="114">content/{level}/{x}/{y}.glb</text>
    <text x="575" y="154"><tspan x="575" dy="0">subtrees/{level}/{x}/{y}.subtree</tspan><tspan x="575" dy="15">1 availability bit per node</tspan></text>
  </g>
  <text x="575" y="204" fill="#4f7a4d" font-size="12.5" text-anchor="middle">implicit: a rule, plus a bitstream</text>
  <text x="575" y="226" fill="#5b6471" font-size="12" text-anchor="middle">the same city is ~2.8 MB of bits</text>
  <text x="380" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">The client computes an address instead of traversing a document, so it can request a deep tile without reading the levels above it</text>
</svg>
<figcaption>The saving is not only in bytes. Addressing by rule lets a client jump straight to the tiles a viewport needs, which an explicit tree cannot do without walking down to them.</figcaption>
</figure>

**Structural metadata** is the other half. In 1.0, per-feature attributes travelled in a batch table — a JSON blob plus an optional binary body, positionally joined to features and typed only by convention. `EXT_structural_metadata` replaces it with a declared schema: named classes, named properties, explicit component types, optional enums, and units. The join is still positional, but the *meaning* is now written down in one place instead of being implied by a column name in every tile.

**Key Practice:** Treat the schema as the contract and version it. A batch table is self-describing only to whoever wrote it; a structural-metadata schema is a machine-readable statement of what every property is, and it is the artifact that lets a consumer written next year read a tileset built today.

<figure class="diagram">
<svg viewBox="46 36 634 220" role="img" aria-labelledby="tn-size-t tn-size-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tn-size-t">Where the bytes go, before and after</title>
  <desc id="tn-size-d">For a city of four hundred thousand buildings, the explicit tileset JSON and the per-tile batch tables together come to about one hundred and thirty megabytes of description. The same information as an implicit root, subtree bitstreams and property tables against one shared schema comes to about thirty-seven.</desc>
  <rect class="svg-bg" x="46" y="36" width="634" height="220" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="50" width="380" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="88" width="92" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="140" width="264" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="178" width="98" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="450" y="70">tree: 40 MB — explicit tileset.json</text>
    <text x="162" y="108">tree: 2.8 MB — implicit root + subtrees</text>
    <text x="334" y="160">metadata: 92 MB — per-tile batch tables</text>
    <text x="168" y="198">metadata: 34 MB — property tables, one schema</text>
  </g>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">132 MB of description becomes 37 MB, and the tree half of it stops being parsed before first paint</text>
</svg>
<figcaption>The metadata saving comes mostly from enums and from stating the schema once; the tree saving comes from not writing the tree at all.</figcaption>
</figure>

## Step-by-Step Workflow

### 1. Decide whether your tree can be implicit at all

Implicit tiling requires uniform subdivision — every node either splits into exactly four (quadtree) or eight (octree) children, or is a leaf. A tree that was pruned by density, or that mixes subdivision depths by region, cannot be addressed by rule.

```python
def is_uniform(node, scheme="QUADTREE"):
    """A tree is implicit-compatible when every internal node has the full child count."""
    expect = 4 if scheme == "QUADTREE" else 8
    kids = node.get("children", [])
    if not kids:
        return True
    if len(kids) != expect:
        return False
    return all(is_uniform(k, scheme) for k in kids)

import json
ts = json.load(open("tileset.json"))
print("implicit-compatible:", is_uniform(ts["root"]))
```

If this returns `False`, the honest options are to rebuild the tree uniformly and mark the empty nodes unavailable — which is what implicit tiling is designed for — or to keep the tileset explicit. Forcing a non-uniform tree into an implicit scheme by inventing intermediate nodes produces a tree whose geometric errors no longer decrease monotonically, which is a [refinement inversion](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) and stops the client refining.

### 2. Write the implicit root

The root tile carries the `implicitTiling` object and templated URIs. Everything below it disappears from the JSON.

```python
import json

tileset = {
    "asset": {"version": "1.1"},
    "geometricError": 512.0,
    "root": {
        "boundingVolume": {"region": [0.1875, 1.0453, 0.1918, 1.0489, 0.0, 420.0]},
        "geometricError": 512.0,
        "refine": "REPLACE",
        "content": {"uri": "content/{level}/{x}/{y}.glb"},
        "implicitTiling": {
            "subdivisionScheme": "QUADTREE",
            "subtreeLevels": 6,
            "availableLevels": 13,
            "subtrees": {"uri": "subtrees/{level}/{x}/{y}.subtree"},
        },
    },
}
with open("tileset.json", "w") as f:
    json.dump(tileset, f, indent=2)
print("implicit root written —", len(json.dumps(tileset)), "bytes")
```

`subtreeLevels` is the parameter worth thinking about. It sets how many levels each subtree file describes, and therefore how large each one is: a quadtree subtree covering 6 levels holds 4⁰+4¹+…+4⁵ = 1365 availability bits, which is 171 bytes. Larger values mean fewer, bigger fetches; smaller values mean the client pulls availability information it does not need. Six to eight is the usual band.

### 3. Write the availability bitstreams

A subtree is a small binary file: a 24-byte header, a JSON chunk describing its buffers, and a binary chunk holding the bits.

```python
import json
import struct
import numpy as np

def pack_bits(flags: np.ndarray) -> bytes:
    """Availability is one bit per node, LSB first within each byte."""
    padded = np.zeros(((len(flags) + 7) // 8) * 8, dtype=np.uint8)
    padded[: len(flags)] = flags.astype(np.uint8)
    return np.packbits(padded, bitorder="little").tobytes()

def write_subtree(path, tile_available, content_available, child_subtree_available):
    tile_bits = pack_bits(tile_available)
    content_bits = pack_bits(content_available)
    child_bits = pack_bits(child_subtree_available)
    binary = tile_bits + content_bits + child_bits

    subtree = {
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(tile_bits)},
            {"buffer": 0, "byteOffset": len(tile_bits), "byteLength": len(content_bits)},
            {"buffer": 0, "byteOffset": len(tile_bits) + len(content_bits),
             "byteLength": len(child_bits)},
        ],
        "tileAvailability": {"bitstream": 0},
        "contentAvailability": [{"bitstream": 1}],
        "childSubtreeAvailability": {"bitstream": 2},
    }
    js = json.dumps(subtree).encode()
    js += b" " * (-len(js) % 8)                      # 8-byte align
    binary += b"\x00" * (-len(binary) % 8)

    with open(path, "wb") as f:
        f.write(struct.pack("<4sIQQ", b"subt", 1, len(js), len(binary)))
        f.write(js)
        f.write(binary)
    return 24 + len(js) + len(binary)

n_nodes = sum(4 ** i for i in range(6))              # 1365 for 6 quadtree levels
avail = np.ones(n_nodes, dtype=np.uint8)
avail[900:] = 0                                       # tiles that hold no geometry
size = write_subtree("subtrees/0/0/0.subtree", avail, avail, np.zeros(4 ** 6, dtype=np.uint8))
print(f"subtree written, {size} bytes for {n_nodes} nodes")
```

The three bitstreams answer three different questions and conflating them is the usual bug. `tileAvailability` says the node exists in the tree; `contentAvailability` says it has a payload; `childSubtreeAvailability` says a further subtree file continues below this one's last level. An interior node with children but no geometry of its own is available with no content — perfectly normal, and a writer that sets both from the same array will make the client request payloads that are not there.

<figure class="diagram">
<svg viewBox="10 38 744 252" role="img" aria-labelledby="tn-avail-t tn-avail-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tn-avail-t">The three availability bitstreams answer three different questions</title>
  <desc id="tn-avail-d">Tile availability says a node exists in the tree. Content availability says that node has a payload to fetch. Child subtree availability says another subtree file continues below this one's deepest level. A node can exist without content, and setting both from one array makes the client request files that were never written.</desc>
  <rect class="svg-bg" x="10" y="38" width="744" height="252" fill="#ffffff"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="24" y="52" width="220" height="52" rx="8"/>
    <rect x="24" y="118" width="220" height="52" rx="8"/>
    <rect x="24" y="184" width="220" height="52" rx="8"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="134" y="74"><tspan x="134" dy="0" font-weight="600">tileAvailability</tspan><tspan x="134" dy="17">does this node exist?</tspan></text>
    <text x="134" y="140"><tspan x="134" dy="0" font-weight="600">contentAvailability</tspan><tspan x="134" dy="17">does it have a payload?</tspan></text>
    <text x="134" y="206"><tspan x="134" dy="0" font-weight="600">childSubtreeAvailability</tspan><tspan x="134" dy="17">does a subtree continue below?</tspan></text>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="330" y="52" width="410" height="52" rx="8"/>
    <rect x="330" y="118" width="410" height="52" rx="8"/>
  </g>
  <rect x="330" y="184" width="410" height="52" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="535" y="74"><tspan x="535" dy="0">interior node over open water: exists, no content</tspan><tspan x="535" dy="16">tile 1 · content 0 · child 1</tspan></text>
    <text x="535" y="140"><tspan x="535" dy="0">leaf with buildings: exists, has content, ends here</tspan><tspan x="535" dy="16">tile 1 · content 1 · child 0</tspan></text>
    <text x="535" y="206"><tspan x="535" dy="0">both set from one array: client fetches a payload that</tspan><tspan x="535" dy="16">was never written — 404 on every empty interior node</tspan></text>
  </g>
  <text x="380" y="272" fill="#15384a" font-size="12" text-anchor="middle">The 404s are the giveaway, and they only appear where the camera happens to descend through an empty region</text>
</svg>
<figcaption>Three independent bitstreams, one common shortcut. The failure is intermittent by construction, because it only fires where a node exists without geometry.</figcaption>
</figure>

### 4. Declare a structural-metadata schema

The schema names the classes and properties every feature carries, with types the client can rely on.

```python
schema = {
    "id": "city_schema_v2",
    "classes": {
        "building": {
            "name": "Building",
            "properties": {
                "gml_id":      {"type": "STRING", "required": True},
                "year_built":  {"type": "SCALAR", "componentType": "UINT16"},
                "height_m":    {"type": "SCALAR", "componentType": "FLOAT32"},
                "function":    {"type": "ENUM", "enumType": "buildingFunction"},
                "heritage":    {"type": "BOOLEAN", "required": False},
            },
        }
    },
    "enums": {
        "buildingFunction": {
            "valueType": "UINT8",
            "values": [
                {"name": "residential", "value": 0},
                {"name": "commercial", "value": 1},
                {"name": "industrial", "value": 2},
                {"name": "civic", "value": 3},
            ],
        }
    },
}
```

Two properties of this are worth calling out against the batch table it replaces. `required` lets a validator reject a tile that omits a property, which a batch table could never express. And `ENUM` means the value on the wire is a single byte while the reader still sees `"commercial"` — a batch table would have carried the string on every feature of every tile.

### 5. Attach the metadata to the glTF payload

In 1.1 the per-feature data lives in the glTF itself, as a property table referenced by feature IDs.

```bash
# gltf-transform writes EXT_structural_metadata and EXT_mesh_features
npx @gltf-transform/cli meta \
  --schema city_schema_v2.json \
  --class building \
  --table buildings_table.json \
  block_0_0.glb block_0_0_meta.glb

npx 3d-tiles-validator --tilesetFile tileset.json
```

### 6. Verify what a client will actually see

The validator checks conformance. It does not check that your metadata means anything, so read a feature back.

```python
import json
from pygltflib import GLTF2

g = GLTF2().load("content/0/0/0_meta.glb")
ext = g.extensions.get("EXT_structural_metadata", {})
print("schema id:", ext.get("schema", {}).get("id"))
tables = ext.get("propertyTables", [])
print("property tables:", len(tables))
if tables:
    t = tables[0]
    print("class:", t["class"], "| features:", t["count"],
          "| properties:", sorted(t["properties"]))
```

## Validation & Verification

Three checks, in increasing cost.

The first is structural: run `3d-tiles-validator` and require a clean exit. It verifies the subtree headers, the bitstream lengths against the node counts implied by `subtreeLevels`, and the schema's internal consistency.

The second is arithmetic: confirm that the number of available tiles in the bitstreams equals the number of content files you actually wrote. A mismatch here is the single most common implicit-tiling bug and it produces 404s rather than an error.

```python
import glob
import numpy as np

def available_count(bits: bytes, n_nodes: int) -> int:
    flags = np.unpackbits(np.frombuffer(bits, dtype=np.uint8), bitorder="little")
    return int(flags[:n_nodes].sum())

n_nodes = sum(4 ** i for i in range(6))
declared = available_count(open("subtrees/0/0/0.subtree", "rb").read()[-256:], n_nodes)
on_disk = len(glob.glob("content/**/*.glb", recursive=True))
print(f"declared available: {declared} | files on disk: {on_disk}")
assert declared <= on_disk, "the subtree promises content that was never written"
```

The third is behavioural: load the tileset in a client, fly a path over it, and count 404s. Zero is the only acceptable number, and any non-zero count maps directly to an availability bit that disagrees with the filesystem.

## Performance & Scale

The JSON saving is dramatic and it is not the main benefit. A depth-13 quadtree over a city is about 22 million nodes; explicit, that is roughly 40 MB of `tileset.json` that every client parses before it can draw anything. Implicit, the root is under 2 KB and the client fetches only the subtrees covering where the camera is.

The subtree fetch pattern is what to size for. With `subtreeLevels: 6`, a camera descending 13 levels touches three subtree files: levels 0–5, 6–11, 12. Each is a few hundred bytes to a few kilobytes. With `subtreeLevels: 3` the same descent touches five, and the extra round trips cost more than the bytes saved.

Structural metadata is smaller than a batch table for the same data, mostly because of enums and because the schema is stated once for the tileset rather than repeated per tile. On a city of 400,000 buildings with eight attributes each, the batch tables came to roughly 92 MB across all tiles; the same data as property tables with a shared schema is about 34 MB.

## Failure Modes & Gotchas

- **Content availability copied from tile availability.** Interior nodes that exist without geometry then advertise a payload, and the client 404s wherever it descends through them. Set the two arrays independently from what you actually wrote.
- **A non-uniform tree forced into an implicit scheme.** Inventing intermediate nodes to fill the subdivision breaks the strict decrease of geometric error, and the client stops refining at the invented level. Keep such trees explicit.
- **Bitstream padding mistaken for data.** The final byte of a bitstream contains bits beyond the node count. Always slice to `n_nodes` before summing, or the count comes out high and the mismatch check passes when it should not.
- **Publishing 1.1 to a 1.0-only client.** CesiumJS before 1.107 and most third-party readers ignore `implicitTiling` entirely and render nothing. Either pin the client version or dual-publish during the transition.
- **Schema changed without a version bump.** Consumers cache the schema. Changing a property's type under the same `id` produces readers that decode old values with new types, which is silent corruption rather than an error.

## Frequently Asked Questions

### Do I have to migrate to 1.1?
No. 1.0 remains valid and widely readable. Migrate when the `tileset.json` size or the tree-authoring complexity is actually costing you — for a tileset of a few thousand tiles, neither is.

### Can a tileset mix implicit and explicit subtrees?
Yes. A node with `implicitTiling` roots an implicit subtree; its ancestors can be explicit. That is the practical migration path: keep the hand-authored upper levels explicit and make each city block's deep subtree implicit.

### What replaces the batch table's `_BATCHID`?
`EXT_mesh_features` provides feature IDs, either as a vertex attribute or as a texture, and `EXT_structural_metadata` provides the property table those IDs index. The join is still positional, so the same discipline about build order applies.

### Is `subtreeLevels` a performance knob?
Mildly. It trades the number of subtree requests against their size. Six to eight is a good default; below four the request count starts to matter and above ten the files get large enough to delay first paint.

### How do I keep a 1.0 and a 1.1 tileset in sync?
Generate both from the same intermediate rather than converting one into the other. Converting is a lossy, one-way step that has to be repeated on every rebuild, and the two outputs drift the first time somebody patches only one.

### What happens to a tile that has no metadata at all?
Nothing breaks. `EXT_structural_metadata` is optional per tile, so a terrain layer or a decorative mesh simply omits it and the client renders the geometry without a pick target. What is not optional is consistency within a class: a tile that declares the `building` class must provide every property that class marks `required`, or the validator rejects it.

### Does implicit tiling change how content is authored?
No. The payloads are the same glTF they were, and the encoder, decimation and quantization steps are untouched. What changes is who decides a tile's URI: under explicit tiling the writer chose it and recorded it, under implicit tiling the addressing rule determines it, so the writer's job becomes putting the file at the address the rule implies.

### Can I keep the tile tree explicit and adopt only the metadata half?
Yes, and it is a common resting point. The two halves of 1.1 are independent: a tileset can use `EXT_structural_metadata` with a fully explicit tree, or implicit tiling with no metadata at all. Adopting the metadata half alone gives you typed properties and a shared schema without changing how any client addresses tiles, which makes it the lower-risk of the two.

One organisational point before the sub-guides. The migration is easier to justify and far easier to sequence if the pipeline can emit both formats from one intermediate representation, rather than converting a finished 1.0 tileset into a 1.1 one. A conversion step is a second pipeline: it has to be kept correct as the first one changes, it runs on every build, and the two outputs diverge the first time somebody fixes a bug in only one of them. Emitting both from a shared tree description costs a writer rather than a converter, and it makes dual-publishing during the client transition free.

The second point concerns what implicit tiling does to your debugging. An explicit tileset is inspectable with a text editor: a missing tile is a missing object, and a wrong bounding volume is visible in a diff. Once the tree is a bitstream, none of that is true — a missing tile is a cleared bit somewhere inside a binary file, and the only practical way to inspect it is to decode the subtree back into a list of available addresses. Write that decoder as part of the migration rather than after the first incident, and keep it next to the writer so the two stay consistent.

## Related Guides

- [Implicit Tiling with Subtree Files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/) — the bitstream format in full
- [Attaching EXT_structural_metadata to Building Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/) — schemas, enums and property tables
- [Migrating a 1.0 Tileset to 3D Tiles 1.1](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/migrating-a-1-0-tileset-to-3d-tiles-1-1/) — the incremental path
- [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the tree that has to be uniform for any of this to apply
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — where the subtrees get written
- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — author a 3D Tiles 1.1 metadata schema and attach values at tileset, group, tile and content level
- [Encoding Property Textures for Per-Texel Data](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/encoding-property-textures-for-per-texel-data/) — store analysis results per texel instead of per feature
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — write Cesium3DTileStyle expressions that colour, filter and size 3D Tiles features by metadata

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
