---
title: "Computing Quadkeys and Tile Bounds in Python"
description: "Convert between lon/lat, XYZ tiles, quadkeys and tile bounds with mercantile and closed-form maths — including parent/child walks and the metre-per-pixel check."
---
# Computing Quadkeys and Tile Bounds in Python

This page shows how to convert between geographic coordinates, XYZ tile indices, quadkeys and tile bounding boxes in Python — with `mercantile` for clarity and the closed-form arithmetic for speed — and how to derive the zoom level from a target cell size in metres rather than picking it by feel. The quadkey is the string form of a Web Mercator quadtree path, and because its parent is the same string with one character removed, every hierarchy operation a tiling pipeline needs becomes string manipulation instead of geometry.

## Why you hit this

The moment a twin is sharded, something has to decide which shard a building belongs to and which shards a viewport touches. Quadkeys are the usual answer because the 3D Tiles tree is already a quadtree and every web mapping tool already speaks the same tile convention, so the partition and the tile tree line up without a translation layer. What trips people up is not the conversion itself but the two facts around it: the maths operates on geographic coordinates while the twin stores projected ones, and a zoom level means a different physical size at every latitude. Both produce indexes that are internally consistent and geographically wrong.

## Prerequisites

- Python 3.10+ with `mercantile>=1.2` (`pip install mercantile`) and `pyproj>=3.6` if your data is projected.
- Coordinates you can state the CRS of. The examples take EPSG:32633 (UTM 33N) as the internal store and reproject to EPSG:4326 for indexing.
- A target shard size in metres. Everything below derives the zoom from it; nothing here picks a zoom directly.

## Step-by-Step

### 1. Reproject to EPSG:4326 and assert the range

Web Mercator tile maths takes longitude and latitude in degrees. Feeding it eastings and northings returns a tile object without an error, so the guard has to be yours.

```python
import numpy as np
from pyproj import Transformer

to_geo = Transformer.from_crs("EPSG:32633", "EPSG:4326", always_xy=True)

easting  = np.array([598120.4, 599402.9])
northing = np.array([6643880.1, 6644110.7])
lon, lat = to_geo.transform(easting, northing)

assert np.abs(lon).max() <= 180, "longitude out of range — coordinates were not reprojected"
assert np.abs(lat).max() <= 85.0511, "latitude beyond the Web Mercator limit"
print(np.round(lon, 5), np.round(lat, 5))
```

The second assertion is the one that surprises people. Web Mercator is undefined at the poles and every tiling convention clips it at ±85.0511°, the latitude at which the projected extent becomes square. A point beyond that has no tile, and libraries differ in whether they clamp, wrap or return nonsense.

### 2. Derive the zoom from a metre target

A zoom level is a count of subdivisions, not a size. Convert a target size into the smallest zoom that satisfies it at your latitude, and record both numbers.

```python
import math

EQUATOR_M = 40_075_016.686          # Web Mercator circumference at the equator

def cell_size_m(zoom: int, latitude: float) -> float:
    return EQUATOR_M * math.cos(math.radians(latitude)) / (2 ** zoom)

def zoom_for(target_m: float, latitude: float) -> int:
    for z in range(25):
        if cell_size_m(z, latitude) <= target_m:
            return z
    raise ValueError(f"{target_m} m is finer than zoom 24 at {latitude}°")

lat = 59.9139                                     # Oslo
z = zoom_for(500.0, lat)
print(f"zoom {z}: {cell_size_m(z, lat):.1f} m at {lat}°, "
      f"{cell_size_m(z, 0.0):.1f} m at the equator")
```

<figure class="diagram">
<svg viewBox="44 6 652 284" role="img" aria-labelledby="qk-size-t qk-size-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qk-size-t">One zoom level, four latitudes, four cell sizes</title>
  <desc id="qk-size-d">A zoom-14 cell measures about 2445 metres across at the equator, 2119 at thirty degrees, 1729 at forty-five degrees and 1223 at sixty degrees. The same shard configuration therefore produces shards half the size in a northern city as in an equatorial one.</desc>
  <rect class="svg-bg" x="44" y="6" width="652" height="284" fill="#ffffff"/>
  <text x="370" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">A zoom-14 cell, measured at four latitudes</text>
  <g stroke-width="2">
    <rect x="120" y="60" width="300" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="120" y="102" width="260" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="120" y="144" width="212" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="120" y="186" width="150" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="432" y="80">0° equator — 2445 m</text>
    <text x="392" y="122">30° N — 2119 m</text>
    <text x="344" y="164">45° N — 1729 m</text>
    <text x="282" y="206">60° N — 1223 m</text>
  </g>
  <text x="370" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">Copying a shard configuration between cities halves or doubles the shard size without changing a line of it</text>
  <text x="370" y="272" fill="#5b6471" font-size="12" text-anchor="middle">Derive the zoom from a metre target per deployment, and record the resulting size in the manifest</text>
</svg>
<figcaption>Zoom is a subdivision count. Treating it as a size is what makes a tiling configuration silently unportable between deployments.</figcaption>
</figure>

### 3. Convert a point to a tile and a quadkey

`mercantile` is the readable path. `tile` gives XYZ indices, `quadkey` encodes them, and both round-trip.

```python
import mercantile

lon, lat, z = 10.7522, 59.9139, 14

tile = mercantile.tile(lon, lat, z)
qk = mercantile.quadkey(tile)
back = mercantile.quadkey_to_tile(qk)

print(f"tile x={tile.x} y={tile.y} z={tile.z}  quadkey={qk}")
assert back == tile, "quadkey round-trip failed"
```

Two conventions are worth stating because they cause real confusion. The Y axis increases southward in the XYZ scheme, so tile `(x, 0, z)` is the northernmost row — the TMS convention flips this, and a tileset built under one convention and served under the other is mirrored vertically. And a quadkey's length always equals its zoom, so `len(qk)` is a free integrity check on any key you receive.

### 4. Recover the tile's bounds, in degrees and in metres

Bounds in degrees come straight from `mercantile`. Bounds in metres need a reprojection, and that is what most downstream code actually wants.

```python
import mercantile
from pyproj import Transformer

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32633", always_xy=True)

b = mercantile.bounds(mercantile.quadkey_to_tile("12022001101131"))
print(f"W {b.west:.6f}  S {b.south:.6f}  E {b.east:.6f}  N {b.north:.6f}")

minx, miny = to_utm.transform(b.west, b.south)
maxx, maxy = to_utm.transform(b.east, b.north)
print(f"metric bounds: {minx:.1f} {miny:.1f} {maxx:.1f} {maxy:.1f}")
print(f"width {maxx - minx:.1f} m, height {maxy - miny:.1f} m")
```

The projected width and height will not be exactly equal even though the tile is square in Web Mercator, because the two projections disagree about shape. That difference is real and it is the reason a shard scheme defined in Web Mercator produces slightly non-square shards in the twin's own CRS — usually harmless, and worth knowing before someone reports it as a bug.

### 5. Walk parents and children

This is where quadkeys earn their place. No geometry is involved in any of it.

```python
qk = "12022001101131"

parent = qk[:-1]
children = [qk + d for d in "0123"]
ancestors = [qk[:i] for i in range(1, len(qk))]

def contains(outer: str, inner: str) -> bool:
    """True when `outer` is an ancestor of (or equal to) `inner`."""
    return inner.startswith(outer)

print("parent:", parent)
print("children:", children)
print("contains:", contains("1202", qk), contains("1203", qk))
```

`contains` is a prefix test, which makes a containment query over a million keys a single vectorised string operation. The equivalent test on S2 requires integer range arithmetic and on H3 is not exactly expressible at all.

<figure class="diagram">
<svg viewBox="26 36 617 268" role="img" aria-labelledby="qk-tree-t qk-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qk-tree-t">A quadkey is the path from the root, written down</title>
  <desc id="qk-tree-d">Each character of a quadkey names which of four quadrants the cell falls in at that level, so the key spells the path from the root. Removing the last character gives the parent, appending one of zero to three gives a child, and testing whether one key is a prefix of another tests containment.</desc>
  <rect class="svg-bg" x="26" y="36" width="617" height="268" fill="#ffffff"/>
  <path d="M40 50 h240 v240 h-240 Z M160 50 V290 M40 170 H280" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M160 170 h120 v120 h-120 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M160 170 h60 v60 h-60 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#5b6471" font-size="13" text-anchor="middle">
    <text x="100" y="115">0</text>
    <text x="220" y="115">1</text>
    <text x="100" y="235">2</text>
  </g>
  <text x="250" y="285" fill="#1f6b8a" font-size="13" text-anchor="middle" font-weight="600">3</text>
  <text x="190" y="200" fill="#1f2937" font-size="12" text-anchor="middle" font-weight="600">30</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="340" y="88">the shaded cell at level 1 is quadkey &quot;3&quot;</text>
    <text x="340" y="118">its first child at level 2 is &quot;30&quot;</text>
    <text x="340" y="148">parent of &quot;30&quot; is &quot;30&quot;[:-1] = &quot;3&quot;</text>
    <text x="340" y="178">children of &quot;3&quot; are &quot;30&quot;, &quot;31&quot;, &quot;32&quot;, &quot;33&quot;</text>
    <text x="340" y="208">&quot;3&quot; contains &quot;30221&quot; because it is a prefix</text>
  </g>
  <text x="370" y="272" fill="#15384a" font-size="12.5" text-anchor="middle">Every hierarchy operation is a string operation — no geometry, no floating point, no CRS</text>
</svg>
<figcaption>The key <em>is</em> the path. That is the whole reason quadkeys outlive schemes with better geometric properties.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="-3 16 746 266" role="img" aria-labelledby="qk-edge-t qk-edge-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qk-edge-t">A footprint on a shard boundary belongs to two shards</title>
  <desc id="qk-edge-d">Assignment by centroid puts a straddling building entirely in one shard, so the other shard's rebuild does not include it and its geometry disappears from that side. Assignment by bounding-box overlap puts it in both, which duplicates the bytes but keeps each shard independently complete.</desc>
  <rect class="svg-bg" x="-3" y="16" width="746" height="266" fill="#ffffff"/>
  <path d="M40 60 h140 v140 h-140 Z" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M180 60 h140 v140 h-140 Z" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M180 60 V200" fill="none" stroke="#b0413e" stroke-width="3"/>
  <path d="M140 100 h80 v46 h-80 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <circle cx="180" cy="123" r="5" fill="#1f6b8a"/>
  <path d="M420 60 h140 v140 h-140 Z" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M560 60 h140 v140 h-140 Z" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M560 60 V200" fill="none" stroke="#4f7a4d" stroke-width="3"/>
  <path d="M520 100 h80 v46 h-80 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="180" y="44" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">assign by centroid</text>
  <text x="560" y="44" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">assign by bounding-box overlap</text>
  <text x="180" y="228" fill="#1f2937" font-size="12" text-anchor="middle">one shard owns it; the other rebuilds without it</text>
  <text x="560" y="228" fill="#1f2937" font-size="12" text-anchor="middle">both shards own it; each stays complete alone</text>
  <text x="370" y="264" fill="#15384a" font-size="12.5" text-anchor="middle">Centroid assignment is cheaper and correct only if shards are never rebuilt independently — which is the reason they exist</text>
</svg>
<figcaption>The centroid rule is the default in most tiling code and the wrong one for an incremental pipeline. Overlap assignment costs duplicated geometry at the seams and buys independent rebuilds.</figcaption>
</figure>

### 6. Use the closed form when the point count is large

`mercantile.tile` is a Python function call per point. On tens of millions of features that dominates the ingest, and the closed form vectorises over NumPy.

```python
import numpy as np

def tiles_vectorized(lon, lat, z):
    lat_rad = np.radians(lat)
    n = 2.0 ** z
    x = ((lon + 180.0) / 360.0 * n).astype(np.int64)
    y = ((1.0 - np.log(np.tan(lat_rad) + 1.0 / np.cos(lat_rad)) / np.pi) / 2.0 * n).astype(np.int64)
    return np.clip(x, 0, int(n) - 1), np.clip(y, 0, int(n) - 1)

def quadkeys(x, y, z):
    out = np.zeros(x.shape, dtype=f"U{z}")
    for i in range(z, 0, -1):
        mask = 1 << (i - 1)
        digit = ((x & mask) > 0).astype(np.int64) + 2 * ((y & mask) > 0).astype(np.int64)
        out = np.char.add(out, digit.astype(str))
    return out

lon = np.array([10.7522, 10.7601])
lat = np.array([59.9139, 59.9210])
tx, ty = tiles_vectorized(lon, lat, 14)
print(quadkeys(tx, ty, 14))
```

## Expected Output & Verification

For Oslo at zoom 14 the calls above print a tile near `x=8800 y=4680` and a fourteen-character quadkey. Verify three things rather than eyeballing the string:

```python
import mercantile

lon, lat, z = 10.7522, 59.9139, 14
qk = mercantile.quadkey(mercantile.tile(lon, lat, z))

# 1. the key's length is its zoom
assert len(qk) == z, f"quadkey length {len(qk)} != zoom {z}"

# 2. the point falls inside the bounds its own key implies
b = mercantile.bounds(mercantile.quadkey_to_tile(qk))
assert b.west <= lon <= b.east and b.south <= lat <= b.north, "point outside its own cell"

# 3. the vectorised path agrees with the library
tx, ty = tiles_vectorized(np.array([lon]), np.array([lat]), z)
assert quadkeys(tx, ty, z)[0] == qk, "closed form disagrees with mercantile"
print("all three checks pass:", qk)
```

The third check matters because the closed form is the version that will run in production. Any disagreement is a boundary case — a point exactly on a cell edge, where floating-point rounding sends the two implementations different ways — and it is worth knowing which side your pipeline lands on before a building sits on a shard boundary.

## Common Errors

**Every feature lands in one or two tiles.** The coordinates were projected, not geographic. `(598120, 6643880)` clamps to the far corner of the world at any zoom, so an entire city collapses into a single cell. Reproject and assert the range as in step 1.

**The tileset is mirrored north to south.** XYZ and TMS disagree about the Y axis direction: XYZ counts rows southward from the top, TMS northward from the bottom. Convert with `y_tms = 2**z - 1 - y_xyz` at the boundary between the two conventions, and state which one your manifest uses.

**`ValueError: math domain error` near the poles.** `math.tan` and `math.cos` blow up as latitude approaches ±90°, and Web Mercator is undefined there anyway. Clamp latitude to ±85.0511° before converting, and treat anything beyond it as out of the tiling extent rather than as a point to be placed.

## Frequently Asked Questions

### Should I store the quadkey or the XYZ triple?
Store the quadkey. It is one column instead of three, it sorts into spatial locality, and prefix comparison gives containment for free. Convert back to XYZ only at the point where a library demands it.

### What zoom should a city-scale shard grid use?
Derive it, do not pick it. Choose a target shard size — 500 m to 1 km is typical for building tiles, because it keeps a shard's rebuild cheap while keeping the shard count in the low thousands — and use `zoom_for` to find the level. In mid-latitudes that lands around zoom 14 to 15.

### Does the quadkey have to match my 3D Tiles tree depth?
No, and it usually should not. The shard grid decides what rebuilds together; the tile tree decides what streams together. Sharding at zoom 14 and letting each shard carry its own four- or five-level subtree is the common arrangement, and it keeps the two concerns independent.

## Related Guides

- [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/) — how quadkeys compare with S2, H3 and geohash
- [Choosing Between S2, H3 and Geohash for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/choosing-between-s2-h3-and-geohash-for-3d-data/) — when a different scheme is worth the loss of exact nesting
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — the shard grid these keys drive

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
