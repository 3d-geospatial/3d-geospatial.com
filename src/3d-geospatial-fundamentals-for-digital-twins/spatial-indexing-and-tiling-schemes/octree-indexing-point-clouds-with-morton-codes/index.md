---
title: "Octree Indexing Point Clouds with Morton Codes"
description: "Build an octree over a LiDAR point cloud in NumPy with 3D Morton codes: quantise to a cube, interleave bits, sort once, and answer node, box and LOD queries by prefix."
---
# Octree Indexing Point Clouds with Morton Codes

This page builds an octree over a LiDAR point cloud using nothing but NumPy and 3D Morton (Z-order) codes — quantising coordinates in EPSG:32618 into a power-of-two cube, interleaving the bits of x, y and z into one 64-bit key, sorting the cloud by that key once, and then answering node membership, box queries and level-of-detail sampling with integer shifts and binary search.

## Why you hit this

Octrees underpin almost every point cloud format built for streaming: COPC and EPT are octrees, Potree is an octree, and 3D Tiles point cloud tilesets are usually generated from one. Understanding how they are addressed is the difference between treating those formats as black boxes and being able to debug a node that never loads, a hierarchy that is unbalanced, or a pipeline that spends an hour building an index a sort could have built in seconds. The formats themselves are compared in [LAZ vs COPC vs EPT for point cloud delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/laz-vs-copc-vs-ept-for-point-cloud-delivery/); this page is the index underneath them.

## Prerequisites

- `numpy>=1.24` and `laspy[lazrs]>=2.5`.
- A point cloud in a projected metric CRS — EPSG:32618+5703 in the examples. An octree over longitude and latitude has cells that are not cubes, which breaks every spacing assumption below.
- Familiarity with the 2D equivalent in [computing quadkeys and tile bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/): a Morton code is a quadkey with a third axis, written in binary instead of base four.

## Step-by-Step

### 1. Quantise the cloud into a cube

```python
import laspy
import numpy as np

las = laspy.read("harbour_block_07.laz")
xyz = np.column_stack([las.x, las.y, las.z])           # EPSG:32618+5703, metres

BITS = 21                                              # 21 bits per axis → 63-bit key
lo = xyz.min(axis=0)
edge = float((xyz.max(axis=0) - lo).max()) * 1.000001  # cube side: the largest extent
cell = edge / (1 << BITS)
q = np.floor((xyz - lo) / cell).astype(np.uint64)
q = np.minimum(q, (1 << BITS) - 1)
print(f"cube edge {edge:.2f} m, finest cell {cell * 1000:.3f} mm, {len(xyz):,} points")
```

An octree splits a *cube*, so the bounding box is expanded to the length of its longest side along all three axes. A 500 m × 500 m block that is only 60 m tall wastes most of its vertical subdivisions on empty air, which is normal — empty nodes cost nothing because they are never materialised. Twenty-one bits per axis gives a finest cell under a tenth of a millimetre on a 500 m cube, far finer than any scanner, and packs three axes into a single `uint64`.

### 2. Interleave the bits into Morton codes

```python
def part1by2(v):
    v = v.astype(np.uint64) & np.uint64(0x1FFFFF)
    v = (v | (v << np.uint64(32))) & np.uint64(0x1F00000000FFFF)
    v = (v | (v << np.uint64(16))) & np.uint64(0x1F0000FF0000FF)
    v = (v | (v << np.uint64(8)))  & np.uint64(0x100F00F00F00F00F)
    v = (v | (v << np.uint64(4)))  & np.uint64(0x10C30C30C30C30C3)
    v = (v | (v << np.uint64(2)))  & np.uint64(0x1249249249249249)
    return v

def morton3(qx, qy, qz):
    return part1by2(qx) | (part1by2(qy) << np.uint64(1)) | (part1by2(qz) << np.uint64(2))

codes = morton3(q[:, 0], q[:, 1], q[:, 2])
order = np.argsort(codes, kind="stable")
codes = codes[order]
xyz = xyz[order]
print("first codes:", [f"{c:#018x}" for c in codes[:3]])
```

`part1by2` spreads the 21 bits of one coordinate out so that two zero bits sit between each original bit; the magic masks do that in six constant-time steps instead of a 21-iteration loop. Shifting y's spread bits by one and z's by two before OR-ing gives the interleaved pattern `…z₁y₁x₁z₀y₀x₀`. Every `np.uint64(...)` wrapper is there for a reason: shifting a `uint64` array by a Python `int` promotes to `float64` in older NumPy versions and silently destroys the high bits.

<figure class="diagram">
<svg viewBox="46 6 642 202" role="img" aria-labelledby="oct-bits-t oct-bits-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-bits-t">Interleaving three coordinates into one Morton code</title>
  <desc id="oct-bits-d">The two lowest bits of x, y and z, shown as separate rows, are interleaved into a single row ordered z1 y1 x1 z0 y0 x0. Each group of three bits selects one of eight child octants, so the highest group chooses the child of the root and each lower group chooses a child one level deeper.</desc>
  <rect class="svg-bg" x="46" y="6" width="642" height="202" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="60" y="20" width="44" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="104" y="20" width="44" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="64" width="44" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="104" y="64" width="44" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="108" width="44" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="104" y="108" width="44" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="330" y="64" width="54" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="384" y="64" width="54" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="438" y="64" width="54" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="512" y="64" width="54" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="566" y="64" width="54" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="620" y="64" width="54" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <path d="M170 81 H320" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M312 75 L322 81 L312 87" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M330 112 H492" fill="none" stroke="#1f2937" stroke-width="1.5"/>
  <path d="M512 112 H674" fill="none" stroke="#1f2937" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="82" y="42">x₁</text><text x="126" y="42">x₀</text>
    <text x="82" y="86">y₁</text><text x="126" y="86">y₀</text>
    <text x="82" y="130">z₁</text><text x="126" y="130">z₀</text>
    <text x="357" y="86">z₁</text><text x="411" y="86">y₁</text><text x="465" y="86">x₁</text>
    <text x="539" y="86">z₀</text><text x="593" y="86">y₀</text><text x="647" y="86">x₀</text>
  </g>
  <g fill="#15384a" font-size="12.5" text-anchor="middle">
    <text x="411" y="134">octant at level 1</text>
    <text x="593" y="134">octant at level 2</text>
  </g>
  <text x="380" y="190" fill="#15384a" font-size="12.5" text-anchor="middle">Dropping the last 3 × k bits of a code gives the node that contains the point, k levels up.</text>
</svg>
<figcaption>A Morton code is a path from the root: each triple of bits names one of eight children, most significant level first.</figcaption>
</figure>

### 3. Address nodes by shifting

```python
def node_key(codes, level, bits=BITS):
    """Octree node at `level` (0 = root) containing each code."""
    return codes >> np.uint64(3 * (bits - level))

for level in (4, 6, 8):
    keys, counts = np.unique(node_key(codes, level), return_counts=True)
    size = edge / (1 << level)
    print(f"level {level}: node edge {size:6.2f} m, {len(keys):6,} occupied nodes, "
          f"max {counts.max():,} pts, median {int(np.median(counts)):,} pts")
```

Because the cloud is sorted by code and a node key is a prefix of the code, every point in a node sits in one contiguous run of the sorted arrays. That is the property the rest of the index relies on: a node's points are a slice, found by binary search, with no tree structure stored anywhere.

### 4. Fetch a node's points by binary search

```python
def node_slice(codes, key, level, bits=BITS):
    shift = np.uint64(3 * (bits - level))
    start_code = np.uint64(key) << shift
    end_code = (np.uint64(key) + np.uint64(1)) << shift
    return slice(np.searchsorted(codes, start_code, "left"), np.searchsorted(codes, end_code, "left"))

level = 6
keys, counts = np.unique(node_key(codes, level), return_counts=True)
busiest = keys[np.argmax(counts)]
s = node_slice(codes, busiest, level)
print(f"node {busiest} at level {level}: points {s.start:,}–{s.stop:,} ({s.stop - s.start:,})")
assert s.stop - s.start == counts.max()
```

Two `searchsorted` calls on a sorted array of 50 million codes take microseconds. The assertion is the cheapest correctness test there is: the slice length has to equal the count from `np.unique`, and if the codes were not sorted, or a shift was computed in the wrong dtype, it will not.

<figure class="diagram">
<svg viewBox="26 6 708 252" role="img" aria-labelledby="oct-z-t oct-z-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-z-t">Z-order on a 4 × 4 slice and contiguous node runs</title>
  <desc id="oct-z-d">A four by four grid of cells numbered in Z order, with the path drawn through them. The four cells of each two by two quadrant are consecutive in the order, so the quadrant is one contiguous run in the sorted list shown on the right. The same holds in three dimensions for each octree node.</desc>
  <rect class="svg-bg" x="26" y="6" width="708" height="252" fill="#ffffff"/>
  <rect x="40" y="20" width="100" height="100" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="140" y="20" width="100" height="100" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="40" y="120" width="100" height="100" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="140" y="120" width="100" height="100" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M65 195 L115 195 L65 145 L115 145 L165 195 L215 195 L165 145 L215 145 L65 95 L115 95 L65 45 L115 45 L165 95 L215 95 L165 45 L215 45" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="320" y="100" width="100" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="420" y="100" width="100" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="520" y="100" width="100" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="620" y="100" width="100" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="65" y="190">0</text><text x="115" y="190">1</text><text x="65" y="140">2</text><text x="115" y="140">3</text>
    <text x="165" y="190">4</text><text x="215" y="190">5</text><text x="165" y="140">6</text><text x="215" y="140">7</text>
    <text x="65" y="90">8</text><text x="115" y="90">9</text><text x="65" y="40">10</text><text x="115" y="40">11</text>
    <text x="165" y="90">12</text><text x="215" y="90">13</text><text x="165" y="40">14</text><text x="215" y="40">15</text>
    <text x="370" y="123">0–3</text><text x="470" y="123">4–7</text><text x="570" y="123">8–11</text><text x="670" y="123">12–15</text>
  </g>
  <text x="520" y="84" fill="#15384a" font-size="12.5" text-anchor="middle">sorted codes: one slice per quadrant</text>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Consecutive codes share a prefix, so every node is a range, never a scattered set.</text>
</svg>
<figcaption>Z-order visits each quadrant — and in 3D each octant — completely before moving on, which is why a sort is all the index needs.</figcaption>
</figure>

### 5. Sample a level of detail per node

Streaming formats store a thinned subset of points at each coarse node and the rest deeper down. With a sorted Morton array, a simple, deterministic version is one point per finer grid cell per node.

```python
def lod_sample(codes, level, per_axis_bits=4, bits=BITS):
    """Keep the first point in each of 8**per_axis_bits sub-cells of every node at `level`."""
    sub_level = level + per_axis_bits
    sub_keys = node_key(codes, sub_level, bits)
    first = np.concatenate([[True], sub_keys[1:] != sub_keys[:-1]])
    return np.flatnonzero(first)

for level in (2, 4, 6):
    idx = lod_sample(codes, level)
    spacing = edge / (1 << (level + 4))
    print(f"LOD for level {level}: {len(idx):,} points, nominal spacing {spacing:.2f} m")
```

Because the array is sorted, "the first point in each sub-cell" is just every position where the sub-cell key changes — one vectorised comparison. At level `L` the sample has a nominal spacing of the node edge divided by 16, which gives a coarse-to-fine sequence whose spacing halves at each level, the structure a renderer's screen-space-error test expects. Production writers like PDAL's COPC writer choose the retained point more carefully, but the addressing is the same.

## Expected Output & Verification

```text
cube edge 512.37 m, finest cell 0.244 mm, 48,302,117 points
level 4: node edge  32.02 m,    214 occupied nodes, max 1,873,002 pts, median 188,404 pts
level 6: node edge   8.01 m,  3,120 occupied nodes, max 198,441 pts, median 11,907 pts
level 8: node edge   2.00 m, 39,516 occupied nodes, max 18,220 pts, median 891 pts
node 190472 at level 6: points 21,004,318–21,202,759 (198,441)
LOD for level 2: 38,114 points, nominal spacing 8.01 m
LOD for level 4: 402,882 points, nominal spacing 2.00 m
LOD for level 6: 4,118,760 points, nominal spacing 0.50 m
```

Verify that decoding a code returns the quantised coordinates exactly, and that each node's points lie inside its geometric bounds:

```python
def compact1by2(v):
    v = v & np.uint64(0x1249249249249249)
    v = (v ^ (v >> np.uint64(2)))  & np.uint64(0x10C30C30C30C30C3)
    v = (v ^ (v >> np.uint64(4)))  & np.uint64(0x100F00F00F00F00F)
    v = (v ^ (v >> np.uint64(8)))  & np.uint64(0x1F0000FF0000FF)
    v = (v ^ (v >> np.uint64(16))) & np.uint64(0x1F00000000FFFF)
    v = (v ^ (v >> np.uint64(32))) & np.uint64(0x1FFFFF)
    return v

qs = q[order]
assert np.array_equal(compact1by2(codes), qs[:, 0])
assert np.array_equal(compact1by2(codes >> np.uint64(1)), qs[:, 1])
assert np.array_equal(compact1by2(codes >> np.uint64(2)), qs[:, 2])

k = node_key(np.array([codes[s.start]]), level)[0]
nq = np.array([compact1by2(np.uint64(k) >> np.uint64(i)) for i in range(3)], dtype=np.float64)
node_lo = lo + nq * (edge / (1 << level))
pts = xyz[s]
assert np.all(pts >= node_lo - 1e-6) and np.all(pts <= node_lo + edge / (1 << level) + 1e-6)
print("round trip and node bounds verified")
```

<figure class="diagram">
<svg viewBox="66 6 648 244" role="img" aria-labelledby="oct-bal-t oct-bal-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oct-bal-t">Points per occupied node by level on an urban block</title>
  <desc id="oct-bal-d">For octree levels four, six and eight, bars compare the median and maximum number of points per occupied node. The maximum is roughly ten to twenty times the median at every level, because dense facades and trees concentrate points, which is why production writers split nodes by point count rather than stopping at a fixed depth.</desc>
  <rect class="svg-bg" x="66" y="6" width="648" height="244" fill="#ffffff"/>
  <path d="M80 20 V190 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="130" y="150" width="60" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="195" y="30" width="60" height="160" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="330" y="160" width="60" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="395" y="64" width="60" height="126" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="530" y="170" width="60" height="20" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="595" y="98" width="60" height="92" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="192" y="210">level 4</text><text x="392" y="210">level 6</text><text x="592" y="210">level 8</text>
  </g>
  <text x="470" y="40" fill="#1f6b8a" font-size="12" text-anchor="start">blue: median points per node</text>
  <text x="470" y="58" fill="#9a4f26" font-size="12" text-anchor="start">orange: maximum (log scale)</text>
  <text x="390" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">A fixed-depth octree over a city is always unbalanced.</text>
</svg>
<figcaption>Point density follows surfaces, not space; a facade node holds twenty times the median, so node size limits belong in point counts.</figcaption>
</figure>

## Common Errors

**Codes are not unique and neighbouring points get the same code.** Quantisation was too coarse — `BITS` set low to save space, or the cube edge computed from one axis only. Duplicates are legitimate at the finest level for coincident returns, but more than a fraction of a percent means the grid is coarser than the data.

**`OverflowError` or codes wrapping to small values.** A shift was applied with a Python integer to a `uint64` array, or the quantised values exceeded 21 bits because the maximum coordinate was not clamped. Keep every shift and mask as `np.uint64` and clamp to `(1 << BITS) - 1`.

**Node slices are empty for nodes that `np.unique` reports.** The arrays were sorted by code but `xyz` was not reordered with the same permutation, or the codes array was re-sorted after the points were. Sort once, apply the same `order` to everything, and keep the assertion from step 4 in the pipeline.

## Frequently Asked Questions

### How does this relate to COPC and EPT keys?

Both address nodes by level and integer x, y, z within that level — `D-X-Y-Z` — which is the same information as a Morton node key, unpacked. Decoding a node key with `compact1by2` at a given level yields exactly those X, Y, Z values.

### Can Morton codes answer nearest-neighbour queries?

Approximately. Points close in code are close in space, but not every spatially close point is close in code, because Z-order jumps at node boundaries. Use the Morton sort to partition the data, then a KD-tree within and across adjacent nodes for exact neighbours.

### Why not just use a KD-tree for everything?

A KD-tree is excellent in memory and has no natural serialisation into streamable, independently loadable chunks. An octree over Morton codes maps directly onto files and byte ranges, which is what delivery formats need.

## Related Guides

- [Building an R-Tree Index for 3D Tile Lookup](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/building-an-r-tree-index-for-3d-tile-lookup/) — indexing tiles rather than points
- [Choosing Between S2, H3 and Geohash for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/choosing-between-s2-h3-and-geohash-for-3d-data/) — global cell systems compared
- [Converting Point Clouds to 3D Tiles with py3dtiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-point-clouds-to-3d-tiles-with-py3dtiles/) — an octree-based tiler in practice

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
