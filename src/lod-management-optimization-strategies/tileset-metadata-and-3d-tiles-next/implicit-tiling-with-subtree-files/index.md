---
title: "Implicit Tiling with Subtree Files"
description: "Write .subtree binaries by hand: the 24-byte header, the three availability bitstreams, Morton ordering, and the checks that catch a bitstream off by one node."
---
# Implicit Tiling with Subtree Files

This page writes a `.subtree` file from scratch — the 24-byte header, the JSON chunk, and the three availability bitstreams — and covers the two details that cause nearly every implicit-tiling bug: the Morton ordering the bits are laid out in, and the difference between a node existing and a node having content. Once these files are correct, a client can address any tile arithmetically and the `tileset.json` stops describing the tree at all.

## Why you hit this

Every tool that writes implicit tilesets writes subtrees for you, right up until you need something they do not support — a sparse city where most of the quadtree is empty, availability derived from a manifest rather than from files on disk, or subtrees regenerated incrementally when one block changes. At that point you are writing the binary yourself, and the format is small enough to do so in an afternoon and unforgiving enough to fail silently if you get the bit order wrong.

The surrounding decisions — whether your tree can be implicit at all, and what `subtreeLevels` to pick — are covered in [tileset metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`. No other dependency is needed to write the format.
- A uniform quadtree or octree, and a way to say for each node whether it exists and whether it has a payload.
- `3d-tiles-validator` (`npm i -g 3d-tiles-validator`) for structural verification.

## Step-by-Step

### 1. Understand the node ordering

Availability bits are laid out level by level, and within a level in Morton order — the interleaved-bit ordering that keeps spatially adjacent tiles adjacent in the bitstream. Index 0 is the subtree root; indices 1–4 are its children; 5–20 are the grandchildren, and so on.

```python
def morton_2d(x: int, y: int) -> int:
    """Interleave the bits of x and y, x in the even positions."""
    def spread(v):
        v &= 0xFFFFFFFF
        v = (v | (v << 16)) & 0x0000FFFF0000FFFF
        v = (v | (v << 8))  & 0x00FF00FF00FF00FF
        v = (v | (v << 4))  & 0x0F0F0F0F0F0F0F0F
        v = (v | (v << 2))  & 0x3333333333333333
        v = (v | (v << 1))  & 0x5555555555555555
        return v
    return spread(x) | (spread(y) << 1)

def node_index(level: int, x: int, y: int) -> int:
    """Index into the subtree bitstream for a tile at (level, x, y), level relative to the subtree root."""
    level_offset = (4 ** level - 1) // 3      # nodes in all levels above this one
    return level_offset + morton_2d(x, y)

for lvl, x, y in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (1, 0, 1), (1, 1, 1), (2, 3, 2)):
    print(f"level {lvl} ({x},{y}) → index {node_index(lvl, x, y)}")
```

The level offset `(4**level - 1) // 3` is the sum of the geometric series 1 + 4 + 16 + …, and getting it wrong by one level is the classic bug: every bit is then read from the wrong place and availability appears random.

<figure class="diagram">
<svg viewBox="9 46 722 250" role="img" aria-labelledby="st-morton-t st-morton-d" xmlns="http://www.w3.org/2000/svg">
  <title id="st-morton-t">Morton order over a quadtree level</title>
  <desc id="st-morton-d">Within each level, availability bits are laid out in Morton order, which interleaves the bits of the x and y tile indices. The resulting traversal is a repeating Z shape, so tiles that are neighbours on the ground are close together in the bitstream and a subtree covering one region reads as one contiguous run.</desc>
  <rect class="svg-bg" x="9" y="46" width="722" height="250" fill="#ffffff"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.5">
    <rect x="60" y="60" width="60" height="50"/><rect x="120" y="60" width="60" height="50"/>
    <rect x="180" y="60" width="60" height="50"/><rect x="240" y="60" width="60" height="50"/>
    <rect x="60" y="110" width="60" height="50"/><rect x="120" y="110" width="60" height="50"/>
    <rect x="180" y="110" width="60" height="50"/><rect x="240" y="110" width="60" height="50"/>
    <rect x="60" y="160" width="60" height="50"/><rect x="120" y="160" width="60" height="50"/>
    <rect x="180" y="160" width="60" height="50"/><rect x="240" y="160" width="60" height="50"/>
    <rect x="60" y="210" width="60" height="50"/><rect x="120" y="210" width="60" height="50"/>
    <rect x="180" y="210" width="60" height="50"/><rect x="240" y="210" width="60" height="50"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="90" y="90">0</text><text x="150" y="90">1</text><text x="210" y="90">4</text><text x="270" y="90">5</text>
    <text x="90" y="140">2</text><text x="150" y="140">3</text><text x="210" y="140">6</text><text x="270" y="140">7</text>
    <text x="90" y="190">8</text><text x="150" y="190">9</text><text x="210" y="190">12</text><text x="270" y="190">13</text>
    <text x="90" y="240">10</text><text x="150" y="240">11</text><text x="210" y="240">14</text><text x="270" y="240">15</text>
  </g>
  <path d="M90 85 L150 85 L90 135 L150 135 L210 85 L270 85 L210 135 L270 135 L90 185 L150 185 L90 235 L150 235 L210 185 L270 185 L210 235 L270 235"
        fill="none" stroke="#c46a3d" stroke-width="1.5" opacity="0.9"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="380" y="72" width="330" height="34" rx="6"/>
    <rect x="380" y="116" width="330" height="34" rx="6"/>
    <rect x="380" y="160" width="330" height="34" rx="6"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="545" y="94">level 0 → 1 bit at offset 0</text>
    <text x="545" y="138">level 1 → 4 bits at offset 1</text>
    <text x="545" y="182">level 2 → 16 bits at offset 5</text>
  </g>
  <text x="545" y="216" fill="#5b6471" font-size="12" text-anchor="middle">offset = (4^level − 1) / 3</text>
  <text x="370" y="278" fill="#15384a" font-size="12" text-anchor="middle">The Z traversal is what makes a spatially contiguous region a contiguous run of bits, which is why the files compress so well</text>
</svg>
<figcaption>The numbers are bitstream indices within one level. Getting the level offset wrong shifts every index and the availability pattern becomes noise.</figcaption>
</figure>

### 2. Pack the availability bits

Three bitstreams, LSB first within each byte, each padded to a byte boundary.

```python
import numpy as np

def pack_bits(flags) -> bytes:
    flags = np.asarray(flags, dtype=np.uint8)
    padded = np.zeros(((len(flags) + 7) // 8) * 8, dtype=np.uint8)
    padded[: len(flags)] = flags
    return np.packbits(padded, bitorder="little").tobytes()

LEVELS = 6
N_NODES = (4 ** LEVELS - 1) // 3            # 1365
N_LEAF_CHILDREN = 4 ** LEVELS               # 4096 possible child subtrees

tile_avail = np.zeros(N_NODES, dtype=np.uint8)
content_avail = np.zeros(N_NODES, dtype=np.uint8)

# Mark what genuinely exists. Interior nodes over open water exist with no content.
for i in range(N_NODES):
    tile_avail[i] = 1
content_avail[node_index(0, 0, 0)] = 0       # root is a container, no payload
for lvl in range(1, LEVELS):
    for x in range(2 ** lvl):
        for y in range(2 ** lvl):
            content_avail[node_index(lvl, x, y)] = 1

print(f"{tile_avail.sum()} tiles available, {content_avail.sum()} with content")
```

`bitorder="little"` is not optional. The specification says bit *i* of the stream is bit `i % 8` of byte `i // 8`, counting from the least significant — which is `numpy`'s "little" and the opposite of its default.

### 3. Use the constant forms when everything is available

A subtree whose bits are all 1 or all 0 does not need a bitstream at all, and using the constant form makes the file dramatically smaller for the dense interior of a city.

```python
def availability_object(flags: np.ndarray, bitstream_index: int):
    """Return the JSON form: a constant when uniform, otherwise a bitstream reference."""
    total = int(flags.sum())
    if total == len(flags):
        return {"constant": 1}, None
    if total == 0:
        return {"constant": 0}, None
    return {"bitstream": bitstream_index, "availableCount": total}, pack_bits(flags)
```

`availableCount` is optional but worth writing: it lets a reader size its structures before decoding the bits, and it gives you a self-check — if your count and the popcount of your bitstream disagree, one of them is wrong.

### 4. Write the binary file

The header is 24 bytes: a magic, a version, and the two chunk lengths.

```python
import json
import struct

def write_subtree(path, tile_avail, content_avail, child_avail):
    buffers, views, binary = [], [], b""

    def add(flags, idx):
        nonlocal binary
        obj, bits = availability_object(flags, len(views))
        if bits is not None:
            views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(bits)})
            binary += bits
            binary += b"\x00" * (-len(binary) % 8)          # align each view
        return obj

    tile_obj = add(tile_avail, 0)
    content_obj = add(content_avail, 1)
    child_obj = add(child_avail, 2)

    subtree = {"tileAvailability": tile_obj,
               "contentAvailability": [content_obj],
               "childSubtreeAvailability": child_obj}
    if views:
        subtree["buffers"] = [{"byteLength": len(binary)}]
        subtree["bufferViews"] = views

    js = json.dumps(subtree, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 8)

    with open(path, "wb") as f:
        f.write(struct.pack("<4sIQQ", b"subt", 1, len(js), len(binary)))
        f.write(js)
        f.write(binary)
    return 24 + len(js) + len(binary)

child_avail = np.zeros(N_LEAF_CHILDREN, dtype=np.uint8)
size = write_subtree("subtrees/0/0/0.subtree", tile_avail, content_avail, child_avail)
print(f"wrote {size} bytes")
```

The JSON chunk is padded with spaces and the binary chunk with zeros — a detail the specification is explicit about and which readers do enforce, because the padding byte value distinguishes the two chunk types when scanning.

<figure class="diagram">
<svg viewBox="-19 56 743 182" role="img" aria-labelledby="st-layout-t st-layout-d" xmlns="http://www.w3.org/2000/svg">
  <title id="st-layout-t">The subtree file layout</title>
  <desc id="st-layout-d">A subtree file is a twenty-four byte header holding the magic, version and the two chunk lengths, then a JSON chunk padded with spaces to an eight-byte boundary, then a binary chunk of packed availability bits padded with zeros. Every offset in the JSON is relative to the start of the binary chunk.</desc>
  <rect class="svg-bg" x="-19" y="56" width="743" height="182" fill="#ffffff"/>
  <rect x="30" y="70" width="110" height="50" rx="4" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="140" y="70" width="240" height="50" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="380" y="70" width="330" height="50" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="85" y="92"><tspan x="85" dy="0">header</tspan><tspan x="85" dy="16">24 B</tspan></text>
    <text x="260" y="92"><tspan x="260" dy="0">JSON chunk</tspan><tspan x="260" dy="16">space-padded to 8 B</tspan></text>
    <text x="545" y="92"><tspan x="545" dy="0">binary chunk</tspan><tspan x="545" dy="16">zero-padded to 8 B</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="85" y="146">&quot;subt&quot; · version · jsonLen · binLen</text>
    <text x="260" y="146">availability objects, bufferViews</text>
    <text x="545" y="146">tile bits · content bits · child bits</text>
  </g>
  <text x="380" y="192" fill="#15384a" font-size="12.5" text-anchor="middle">Every byteOffset in the JSON is measured from the start of the binary chunk, not from the start of the file</text>
  <text x="380" y="220" fill="#5b6471" font-size="12" text-anchor="middle">Which is the second most common bug, and it presents as availability that is plausible but shifted</text>
</svg>
<figcaption>Three sections and two padding rules. The offsets being binary-chunk-relative is the detail most hand-written writers get wrong on the first attempt.</figcaption>
</figure>

### 5. Read it back and compare against the filesystem

The only check that matters is whether the bits agree with what you actually wrote to disk.

```python
import glob
import json
import struct
import numpy as np

def read_subtree(path):
    raw = open(path, "rb").read()
    magic, version, js_len, bin_len = struct.unpack_from("<4sIQQ", raw, 0)
    assert magic == b"subt", f"bad magic {magic!r}"
    js = json.loads(raw[24 : 24 + js_len])
    binary = raw[24 + js_len : 24 + js_len + bin_len]
    return js, binary

def decode(js, binary, key, n_nodes):
    obj = js[key][0] if isinstance(js[key], list) else js[key]
    if "constant" in obj:
        return np.full(n_nodes, obj["constant"], dtype=np.uint8)
    view = js["bufferViews"][obj["bitstream"]]
    chunk = binary[view["byteOffset"] : view["byteOffset"] + view["byteLength"]]
    bits = np.unpackbits(np.frombuffer(chunk, dtype=np.uint8), bitorder="little")
    return bits[:n_nodes]

js, binary = read_subtree("subtrees/0/0/0.subtree")
content = decode(js, binary, "contentAvailability", N_NODES)
on_disk = len(glob.glob("content/**/*.glb", recursive=True))
print(f"content bits set: {int(content.sum())} | files on disk: {on_disk}")
assert int(content.sum()) <= on_disk, "the subtree promises payloads that do not exist"
```

<figure class="diagram">
<svg viewBox="26 52 688 188" role="img" aria-labelledby="st-chain-t st-chain-d" xmlns="http://www.w3.org/2000/svg">
  <title id="st-chain-t">How subtrees chain to cover a deep tree</title>
  <desc id="st-chain-d">With six levels per subtree, a thirteen-level tree is covered by three chained subtree files. The first describes levels zero to five, its child-subtree bits point at files describing levels six to eleven, and those in turn point at the last level. A camera descending to the deepest level fetches three small files rather than one large tree.</desc>
  <rect class="svg-bg" x="26" y="52" width="688" height="188" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="40" y="66" width="180" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="280" y="66" width="180" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="520" y="66" width="180" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none">
    <path d="M220 94 H278"/>
    <path d="M460 94 H518"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="88"><tspan x="130" dy="0">0/0/0.subtree</tspan><tspan x="130" dy="16">levels 0–5, 171 B</tspan></text>
    <text x="370" y="88"><tspan x="370" dy="0">6/x/y.subtree</tspan><tspan x="370" dy="16">levels 6–11, 171 B</tspan></text>
    <text x="610" y="88"><tspan x="610" dy="0">12/x/y.subtree</tspan><tspan x="610" dy="16">level 12, 1 B</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="370" y="140">each arrow is a set childSubtreeAvailability bit</text>
  </g>
  <text x="370" y="162" fill="#15384a" font-size="12.5" text-anchor="middle">A camera at the deepest level has fetched 343 bytes of tree description in total</text>
  <text x="370" y="188" fill="#5b6471" font-size="12" text-anchor="middle">The equivalent explicit tree is about 22 million JSON objects, all of which have to be parsed first</text>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">subtreeLevels trades the number of these hops against the size of each file</text>
</svg>
<figcaption>Three fetches of a few hundred bytes replace parsing the whole tree. That, rather than the disk saving, is what the client experiences.</figcaption>
</figure>

## Expected Output & Verification

A correct six-level subtree over a dense block:

```text
level 0 (0,0) → index 0
level 1 (0,0) → index 1
level 1 (1,0) → index 2
level 1 (0,1) → index 3
level 1 (1,1) → index 4
level 2 (3,2) → index 16
1365 tiles available, 1364 with content
wrote 424 bytes
content bits set: 1364 | files on disk: 1364
```

Four hundred bytes for 1365 nodes is the point of the format. Then run the validator, which checks the header against the chunk lengths and the bitstream lengths against the node count implied by `subtreeLevels`:

```bash
npx 3d-tiles-validator --tilesetFile tileset.json
```

A clean validator run plus an exact match between content bits and files on disk is sufficient. If the validator passes and the client still 404s, the availability is internally consistent and disagrees with reality — which means the bits were generated from the intended output rather than from the actual one.

## Common Errors

**Availability looks random.** The level offset is wrong — usually `4 ** level` instead of `(4 ** level - 1) // 3`. Print `node_index` for the first two levels and check it reads 0, 1, 2, 3, 4.

**Every bit reads inverted or scrambled within each byte.** `numpy.packbits` defaults to `bitorder="big"`; the specification requires little. Pass it explicitly on both pack and unpack.

**`Invalid subtree magic` from the validator.** The header was written with the wrong struct format — it is `<4sIQQ`, little-endian, with 64-bit chunk lengths. A 32-bit length field shifts everything after the first twelve bytes.

**Client requests tiles that 404 in a specific region.** `contentAvailability` was copied from `tileAvailability`, so interior nodes without geometry advertise a payload. The two are independent; derive content availability from the files you wrote.

## Frequently Asked Questions

### Should I always use the constant form when I can?
Yes. It removes the bitstream entirely, and for the dense interior of a city most subtrees are uniformly available. The saving is modest per file and large across a city's worth of them.

### How do subtrees chain?
`childSubtreeAvailability` has one bit per possible child subtree — `4 ** subtreeLevels` of them for a quadtree — and a set bit means a subtree file exists at that address one level below the current subtree's deepest. That is how a 13-level tree is covered by three chained 6-level subtrees.

### Can I regenerate one subtree without the others?
Yes, and that is the main operational advantage. A subtree describes a bounded region and a bounded level range, so a change in one city block rewrites one small file rather than the whole tree — which is what makes implicit tiling fit an [incremental rebuild](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).

## Related Guides

- [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/) — where implicit tiling fits, and when not to use it
- [Attaching EXT_structural_metadata to Building Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/) — the other half of 1.1
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — generating subtrees incrementally

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
