# Spatial Indexing and Tiling Schemes for 3D Data

A digital twin that cannot answer "which tiles cover this bounding box" in single-digit milliseconds is not a twin, it is an archive. Every operation a twin performs at scale — frustum culling, incremental rebuilds, attribute joins, change detection between two survey epochs, serving a viewport — is a spatial range query, and the structure that answers those queries is the spatial index. This guide covers the four schemes a 3D geospatial pipeline actually chooses between (quadkeys, S2, H3, and geohash), the R-tree that complements all of them, and the specific ways each one behaves differently once a Z dimension and a metric CRS are involved.

The choice matters more here than in 2D GIS because a 3D twin uses its index twice, for two incompatible purposes. At build time the index is a partitioning scheme: it decides which features land in which shard, and therefore which shards a change invalidates. At runtime it is a lookup structure: it decides how fast a viewport resolves to a tile set. A scheme that is excellent at one can be poor at the other, and picking without separating the two is how teams end up rebuilding a whole city because one building moved.

These decisions sit on top of the [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) baseline: an index computed in the wrong CRS is wrong in a way no amount of tuning fixes, so the [coordinate reference system](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) has to be settled before the first cell is computed.

## Prerequisites

- **Python 3.10+** with `mercantile>=1.2` (quadkeys and Web Mercator tile maths), `s2sphere>=0.2` or `s2geometry`, `h3>=4.0`, `python-geohash>=0.8`, `rtree>=1.1` (which wraps libspatialindex), `shapely>=2.0` and `pyproj>=3.6`.
- **A settled internal CRS.** Every example here assumes geometry stored in a projected metric CRS — EPSG:32633 (UTM 33N) in the code below — with reprojection to EPSG:4326 happening only where a scheme demands geographic input.
- **A feature set with computed centroids and bounds.** Indexing operates on bounding boxes, not on geometry, so the expensive part of the work is done once at ingest.
- **A stated query profile.** Write down, before choosing, whether your dominant query is "features in this rectangle", "features within N metres of this point", or "which shard does this feature belong to". The three favour different schemes.

## Concept

All four schemes solve the same problem — turning a two-dimensional position into a one-dimensional key that preserves locality — and they differ in the shape of the cell and in what that shape costs.

**Quadkeys** subdivide the Web Mercator plane into a quadtree. Each level splits every cell into four, and the key is the path from the root written in base 4, so `031` is the fourth child of the second child of the first child. Two properties make them the default for tile pipelines: a cell's parent is its key with the last character removed, which makes hierarchy manipulation string arithmetic, and the scheme is the one every web map tiling convention already uses. The cost is Web Mercator's area distortion, which grows as the secant of latitude — a level-14 cell is about 2.4 km across at the equator and about 1.2 km at 60° N.

**S2** projects the sphere onto the six faces of a circumscribed cube, then subdivides each face with a quadtree and orders the cells along a Hilbert curve. Cells stay close to equal-area anywhere on the globe, and because the Hilbert ordering is a single 64-bit integer, a range query becomes an integer range scan that any database can index. The cost is that the cells are not axis-aligned in any projection, so they do not correspond to anything a tiling pipeline already produces.

**H3** subdivides the globe into hexagons on an icosahedral projection. Hexagons have one property the other schemes lack: all six neighbours are equidistant from the centre, so kernel operations, flow accumulation, and any analysis that grows outward from a point behave isotropically. The cost is that hexagons do not tile hierarchically — a resolution-9 cell is not exactly composed of resolution-10 cells — so parent/child relationships are approximate, and twelve pentagons exist at every resolution to close the icosahedron.

**Geohash** interleaves the bits of latitude and longitude and base-32 encodes the result. It is the simplest to implement and the easiest to read, and it inherits two flaws directly from that construction: cells alternate between wide and tall as precision increases, and adjacent locations can differ in the first character wherever a cell boundary falls, so a prefix search near a boundary misses half its neighbours.

<figure class="diagram">
<svg viewBox="-9 2 778 304" role="img" aria-labelledby="si-cells-t si-cells-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-cells-t">The four cell shapes over the same city block</title>
  <desc id="si-cells-d">A quadkey grid is axis-aligned in Web Mercator and hierarchical. S2 cells are near-equal-area quadrilaterals that are not axis-aligned in any projection. H3 hexagons have six equidistant neighbours but do not nest exactly between resolutions. Geohash cells alternate between wide and tall as precision increases.</desc>
  <rect class="svg-bg" x="-9" y="2" width="778" height="304" fill="#ffffff"/>
  <text x="380" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Same extent, four partitions — the shape is the trade-off</text>
  <path d="M30 60 h150 v150 h-150 Z M105 60 V210 M30 135 H180 M67.5 60 V210 M142.5 60 V210 M30 97.5 H180 M30 172.5 H180"
        fill="none" stroke="#1f6b8a" stroke-width="1.5"/>
  <path d="M212 74 L338 60 L352 186 L226 200 Z M275 67 L289 193 M219 137 L345 123"
        fill="none" stroke="#c46a3d" stroke-width="1.5"/>
  <path d="M470 60 l30 17 v34 l-30 17 -30 -17 v-34 Z M530 60 l30 17 v34 l-30 17 -30 -17 v-34 Z M500 112 l30 17 v34 l-30 17 -30 -17 v-34 Z M560 112 l30 17 v34 l-30 17 -30 -17 v-34 Z M440 112 l30 17 v34 l-30 17 -30 -17 v-34 Z"
        fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M620 60 h120 v150 h-120 Z M620 110 H740 M620 160 H740 M680 60 V210"
        fill="none" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">
    <text x="105" y="236">quadkey</text>
    <text x="282" y="236">S2</text>
    <text x="515" y="236">H3</text>
    <text x="680" y="236">geohash</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="105" y="256">exact nesting</text>
    <text x="282" y="256">equal area</text>
    <text x="515" y="256">equal neighbours</text>
    <text x="680" y="256">readable keys</text>
  </g>
  <text x="380" y="288" fill="#15384a" font-size="12" text-anchor="middle">No scheme has all three of exact nesting, equal area and equal neighbour distance — the icosahedron and the cube each give up one</text>
</svg>
<figcaption>The four schemes are not competing implementations of one idea. Each gives up a different property, and which one you can afford to lose is the whole decision.</figcaption>
</figure>

The property that decides most pipelines is exact nesting, because a tiling pipeline is fundamentally hierarchical. A 3D Tiles tree needs a parent whose bounding volume contains its children's; an incremental rebuild needs to know which parent a changed child invalidates; a level-of-detail chain needs each level to correspond to a level of the partition. Quadkeys and S2 give that for free. H3 does not, and the workaround — maintaining an explicit parent table because `h3_to_parent` is approximate at cell boundaries — is real work that has to be maintained forever.

**Key Practice:** Choose the index for the query you run most, then keep the others as derived columns rather than as alternatives. A features table that stores its quadkey, its S2 cell id and its H3 index costs three integers per row and lets each subsystem use the scheme that suits it, without any of them becoming the authoritative partition.

## Step-by-Step Workflow

### 1. Fix the indexing CRS and the level, before anything else

Every scheme except the R-tree operates on geographic coordinates, so an index computed from projected eastings and northings is silently wrong. Reproject explicitly and assert the result is plausible.

```python
import numpy as np
from pyproj import Transformer

# Internal store is EPSG:32633 (UTM 33N, metres); indexing needs EPSG:4326.
to_geo = Transformer.from_crs("EPSG:32633", "EPSG:4326", always_xy=True)

easting  = np.array([598120.4, 599402.9, 600010.7])
northing = np.array([6643880.1, 6644110.7, 6644640.2])

lon, lat = to_geo.transform(easting, northing)
assert (-180 <= lon).all() and (lon <= 180).all(), "longitudes out of range — CRS chain wrong"
assert (-90 <= lat).all() and (lat <= 90).all(), "latitudes out of range — axis order swapped?"
print("indexing at", np.round(lon, 5), np.round(lat, 5))
```

The two assertions catch the two failures that otherwise reach production. Out-of-range longitudes mean the source coordinates were fed in unprojected; latitudes near 600,000 mean `always_xy=True` was omitted somewhere and easting is being read as latitude. Both produce indexes that are internally consistent and geographically meaningless.

### 2. Compute quadkeys and the tile bounds they imply

`mercantile` handles the Web Mercator tile arithmetic. The level determines cell size, and the useful discipline is to derive the level from a target cell size in metres rather than choosing it by feel.

```python
import math
import mercantile

def level_for_cell_size(target_m: float, latitude: float) -> int:
    """Smallest zoom whose cell is <= target_m across at this latitude."""
    equator_m = 40_075_016.686
    for z in range(0, 25):
        cell_m = equator_m * math.cos(math.radians(latitude)) / (2 ** z)
        if cell_m <= target_m:
            return z
    raise ValueError("target smaller than zoom 24")

lat, lon = 59.9139, 10.7522                      # Oslo
z = level_for_cell_size(500.0, lat)              # ~500 m shards
tile = mercantile.tile(lon, lat, z)
qk = mercantile.quadkey(tile)
bounds = mercantile.bounds(tile)

print(f"zoom {z}  tile {tile.x}/{tile.y}  quadkey {qk}")
print(f"bounds W{bounds.west:.5f} S{bounds.south:.5f} E{bounds.east:.5f} N{bounds.north:.5f}")
print("parent quadkey:", qk[:-1])
```

The last line is the property worth internalising: the parent of any quadkey is the string with its final character removed. Every hierarchy operation a tiling pipeline needs — find the parent, find the four children, test whether one cell contains another — is a string operation with no geometry involved, which is why quadkeys survive as the tiling scheme of choice even where their area distortion is a nuisance.

### 3. Compute S2 and H3 cells for the same points

S2 gives a 64-bit integer whose ordering is spatially coherent, which is what makes it the right key for a database index. H3 gives a hexagonal cell whose neighbours are all equidistant.

```python
import h3
import s2sphere

lat, lon = 59.9139, 10.7522

# S2 — a 64-bit cell id, and its parent at a coarser level
ll = s2sphere.LatLng.from_degrees(lat, lon)
cell = s2sphere.CellId.from_lat_lng(ll).parent(16)     # level 16 ≈ 300 m
print("s2 level 16:", cell.id(), cell.to_token())
print("s2 parent 12:", cell.parent(12).to_token())

# H3 — a resolution 9 cell (~170 m edge) and its six neighbours
h = h3.latlng_to_cell(lat, lon, 9)
ring = h3.grid_ring(h, 1)
print("h3 cell:", h, "| 6 neighbours:", len(ring))
print("h3 area (km²):", round(h3.cell_area(h, unit="km^2"), 4))
```

Note what `grid_ring` returns: exactly six neighbours, each the same distance from the centre. On a quadkey or geohash grid the eight neighbours are at two different distances — four edge-adjacent and four corner-adjacent — and any analysis that treats them as equivalent introduces a directional bias. That is the entire case for H3, and it is a strong one for density, flow and accessibility analysis while being irrelevant for tiling.

<figure class="diagram">
<svg viewBox="86 -4 590 306" role="img" aria-labelledby="si-nbr-t si-nbr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-nbr-t">Neighbour distance on a square grid and a hexagonal one</title>
  <desc id="si-nbr-d">On a square grid the four edge neighbours are one cell width away and the four corner neighbours are about 1.41 cell widths away, so a one-ring search covers an area that is farther in the diagonals than on the axes. On a hexagonal grid all six neighbours sit at exactly one cell width, so the same search is isotropic.</desc>
  <rect class="svg-bg" x="86" y="-4" width="590" height="306" fill="#ffffff"/>
  <path d="M100 60 h180 v180 h-180 Z M160 60 V240 M220 60 V240 M100 120 H280 M100 180 H280"
        fill="none" stroke="#1f6b8a" stroke-width="1.5"/>
  <circle cx="190" cy="150" r="6" fill="#1f6b8a"/>
  <g stroke="#4f7a4d" stroke-width="2">
    <line x1="190" y1="150" x2="190" y2="90"/>
    <line x1="190" y1="150" x2="250" y2="150"/>
  </g>
  <g stroke="#b0413e" stroke-width="2" stroke-dasharray="5 3">
    <line x1="190" y1="150" x2="250" y2="90"/>
    <line x1="190" y1="150" x2="130" y2="210"/>
  </g>
  <path d="M560 90 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M560 10 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M560 170 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M628 50 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M628 130 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M492 50 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M492 130 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <circle cx="560" cy="150" r="6" fill="#4f7a4d"/>
  <g stroke="#4f7a4d" stroke-width="2">
    <line x1="560" y1="150" x2="560" y2="70"/>
    <line x1="560" y1="150" x2="628" y2="110"/>
    <line x1="560" y1="150" x2="628" y2="190"/>
    <line x1="560" y1="150" x2="560" y2="230"/>
    <line x1="560" y1="150" x2="492" y2="190"/>
    <line x1="560" y1="150" x2="492" y2="110"/>
  </g>
  <text x="190" y="266" fill="#1f2937" font-size="12.5" text-anchor="middle">square: 4 at 1.0, 4 at 1.41</text>
  <text x="560" y="266" fill="#1f2937" font-size="12.5" text-anchor="middle">hexagon: 6 at 1.0</text>
  <text x="380" y="284" fill="#5b6471" font-size="12" text-anchor="middle">Which matters for kernels, flow and accessibility, and does not matter at all for tiling</text>
</svg>
<figcaption>The dashed diagonals are the whole difference. On a square grid a one-ring search reaches 41% farther along the diagonals than along the axes.</figcaption>
</figure>

### 4. Build an R-tree over real bounding boxes

Cell schemes answer "which partition does this point fall in". They cannot answer "which features overlap this rectangle" without either a scan or a lot of cell arithmetic, because a feature's extent generally spans several cells. That is what an R-tree is for, and it is complementary rather than alternative.

```python
from rtree import index
import numpy as np

# Each entry: (id, (minx, miny, maxx, maxy), payload) in EPSG:32633 metres.
buildings = [
    (0, (598000, 6643800, 598040, 6643860), "BLDG_0041"),
    (1, (598050, 6643810, 598120, 6643890), "BLDG_0042"),
    (2, (599200, 6644000, 599280, 6644070), "BLDG_0043"),
]

p = index.Property()
p.dimension = 2
p.leaf_capacity = 64
idx = index.Index(properties=p)
for fid, bbox, _name in buildings:
    idx.insert(fid, bbox)

viewport = (597990, 6643790, 598130, 6643900)
hits = list(idx.intersection(viewport))
print("features in viewport:", [buildings[i][2] for i in hits])
```

`leaf_capacity` is the parameter worth setting deliberately. The default of 10 produces a deep tree that is fast for point queries and slow to build; 64 to 128 produces a shallower tree that builds faster and answers range queries over many features better, which is the profile a viewport query has. Measure on your own data rather than accepting either default.

### 5. Index the third dimension, or decide explicitly not to

Nothing above has used Z. For most city twins that is correct: buildings are separated horizontally and a 2D index over footprints answers every query. It stops being correct the moment the twin contains genuinely stacked features — a metro tunnel under a street, a multi-storey car park with per-level assets, a bridge deck over a river path.

```python
from rtree import index

p3 = index.Property()
p3.dimension = 3
idx3 = index.Index(properties=p3)

# (minx, miny, minz, maxx, maxy, maxz) — metres, EPSG:32633 + orthometric Z
idx3.insert(0, (598000, 6643800, 12.0, 598040, 6643860, 34.5))   # building
idx3.insert(1, (598010, 6643810, -18.0, 598030, 6643850, -8.0))  # tunnel beneath

overlap_2d = (597990, 6643790, 598050, 6643870)
overlap_3d = (597990, 6643790, 0.0, 598050, 6643870, 40.0)

print("2D query returns:", list(idx3.intersection(overlap_2d + (float("-inf"), float("inf")))))
print("3D query returns:", list(idx3.intersection(overlap_3d)))
```

The distinction is worth being deliberate about, because a 3D R-tree is materially more expensive: node volumes overlap more in three dimensions than in two, so the tree's pruning power falls and query cost rises. Adding the third dimension when only 2% of features are stacked buys nothing and costs every query. The usual answer is a 2D index plus an explicit `level` or `stratum` attribute, with a 3D index only over the subset that genuinely needs it.

<figure class="diagram">
<svg viewBox="1 18 722 272" role="img" aria-labelledby="si-rtree-t si-rtree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-rtree-t">Why a third dimension costs an R-tree its pruning power</title>
  <desc id="si-rtree-d">In two dimensions node rectangles can be packed with little overlap, so a query descends one branch. Adding height makes the node volumes overlap far more for the same data, because features that are separated horizontally now share vertical extent, and a query has to descend several branches instead of one.</desc>
  <rect class="svg-bg" x="1" y="18" width="722" height="272" fill="#ffffff"/>
  <path d="M40 70 h130 v110 h-130 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M180 70 h130 v110 h-130 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M420 60 h170 v130 h-170 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M500 84 h170 v130 h-170 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="175" y="46" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">2D nodes — disjoint, one branch descended</text>
  <text x="545" y="46" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">3D nodes — overlapping, several branches descended</text>
  <text x="175" y="220" fill="#4f7a4d" font-size="12" text-anchor="middle">a query in the left rectangle never visits the right subtree</text>
  <text x="545" y="240" fill="#b0413e" font-size="12" text-anchor="middle">a query in the overlap has to visit both</text>
  <text x="370" y="272" fill="#15384a" font-size="12" text-anchor="middle">Add Z only for the features that genuinely stack; keep everything else in a 2D index with an explicit stratum attribute</text>
</svg>
<figcaption>Dimensionality is not free in a tree that prunes by bounding volume. Every dimension added makes the volumes overlap more for the same set of features.</figcaption>
</figure>

**Key Practice:** Store the index keys as columns, not as a separate structure. A `features` table carrying `quadkey_z14 TEXT`, `s2_l16 BIGINT`, `h3_r9 TEXT` and a spatial index on the geometry gives every consumer the scheme it wants, keeps them all derived from one geometry column, and makes a mismatch impossible to hide.

## Validation & Verification

Three checks catch essentially every indexing fault.

The first is a round-trip: take a cell, recover its bounds, and confirm the original point falls inside them. This catches CRS errors, level mismatches and axis swaps in one assertion.

```python
import mercantile

lon, lat, z = 10.7522, 59.9139, 14
qk = mercantile.quadkey(mercantile.tile(lon, lat, z))
b = mercantile.bounds(mercantile.quadkey_to_tile(qk))

assert b.west <= lon <= b.east, "longitude outside its own cell"
assert b.south <= lat <= b.north, "latitude outside its own cell"
print("round-trip OK for", qk)
```

The second is a coverage check: the union of the cells you assign features to must contain every feature, and the count of features must be preserved. A feature that falls in no cell is not an error any scheme reports.

```python
from collections import Counter

assigned = Counter()
for fid, (minx, miny, maxx, maxy), name in buildings:
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    lonc, latc = to_geo.transform(cx, cy)
    assigned[mercantile.quadkey(mercantile.tile(lonc, latc, 14))] += 1

assert sum(assigned.values()) == len(buildings), "features lost during assignment"
print(dict(assigned))
```

The third is an agreement check between the index and a brute-force scan, run on a sample. Query the R-tree for a hundred random rectangles, compute the same answer by testing every bounding box directly, and require the two sets to be identical. This is the only check that catches an index that was built correctly and then went stale — the most common index fault in a pipeline that mutates data in place.

Expected outcome: round-trips pass for every cell, assignment preserves the feature count exactly, and the sampled agreement check finds no discrepancy. A discrepancy in the third check with the first two passing means the index and the geometry have diverged, which is a lifecycle problem rather than a spatial one — rebuild the index from the geometry and add an assertion at the point where the geometry is written.

## Performance & Scale

Cell computation is cheap and vectorizes badly. `mercantile.tile` is a pure-Python call at roughly 200,000 points per second; H3 and S2 are compiled and reach several million. For a survey with a hundred million features this is the difference between eight minutes and twenty seconds, so on a large ingest it is worth computing quadkeys with the closed-form arithmetic directly rather than through the library's per-point API.

R-tree construction is the dominant cost at scale, and bulk loading is the lever. Inserting a million entries one at a time takes minutes and produces a poorly balanced tree; loading the same entries through `rtree`'s generator interface uses the Sort-Tile-Recursive packing algorithm, takes seconds, and produces a tree with materially better query performance.

```python
from rtree import index

def stream(entries):
    for fid, bbox, _name in entries:
        yield (fid, bbox, None)

p = index.Property()
p.leaf_capacity = 96
packed = index.Index(stream(buildings), properties=p)   # bulk-loaded, STR-packed
```

Memory is the remaining constraint. A `rtree` index over ten million 2D entries occupies roughly 700 MB in memory; the same index persisted to disk through `index.Index("path", ...)` is memory-mapped and costs almost nothing resident, at the price of page faults on cold queries. For a service that answers viewport queries continuously, the in-memory index wins; for a batch job that touches each region once, the on-disk index is strictly better.

## Failure Modes & Gotchas

- **Indexing projected coordinates as if they were geographic.** `mercantile.tile(598120, 6643880, 14)` returns a tile without complaining. Every downstream query then works and returns nothing. Assert the coordinate ranges before indexing, as in step 1.
- **Geohash prefix search near a cell boundary.** Two points ten metres apart can have geohashes that differ in the first character, so a prefix query centred on one misses the other entirely. Always expand a geohash query to the cell's eight neighbours; every geohash library ships a `neighbors` function for exactly this reason.
- **Treating H3 parents as exact.** `h3.cell_to_parent` returns the cell whose centre contains this cell's centre, which is not the same as containment. Aggregating a resolution-10 quantity into resolution-9 cells via parents loses and duplicates area at every boundary. If the aggregation must conserve a total, do it by area-weighted intersection, not by parent lookup.
- **A stale index after an in-place edit.** Nothing in an R-tree notices that a geometry moved. Either rebuild the index whenever geometry is written, or make geometry immutable and version it — the second is usually cheaper than the discipline the first requires.
- **Choosing the level from cell counts rather than from cell size.** "Zoom 14" means different physical sizes at different latitudes, so a shard scheme tuned in one city is wrong in another. Derive the level from a metre target, as in step 2, and record the resulting cell size in the manifest.

## Frequently Asked Questions

### Which scheme should a 3D Tiles pipeline use for sharding?
Quadkeys, in almost every case. The tiling tree is already a quadtree, the parent/child arithmetic is string manipulation, and every tool in the ecosystem already speaks the same tile convention. S2 is the better choice only when the twin spans enough latitude for Web Mercator's area distortion to make shard sizes wildly uneven — a national or continental extent rather than a city.

### Is H3 ever the right partitioning scheme for tiles?
Rarely, because hexagons do not nest exactly and a tiling tree needs them to. H3 is an excellent *analysis* index — density surfaces, accessibility, flow accumulation, anything with a kernel — and the usual arrangement is a quadkey partition for tiles alongside an H3 column for analysis, computed from the same geometry.

### Do I need an R-tree if I already have quadkeys?
Yes, for any query whose input is a rectangle rather than a point. A cell scheme tells you which cell a point is in; it does not efficiently tell you which features overlap a viewport, because features span cells. The two are complementary and the storage cost of keeping both is trivial.

### How do I pick the R-tree leaf capacity?
Start at 64 and measure. Small capacities favour point queries and deep trees; large capacities favour range queries and fast bulk loading. Viewport queries in a twin are range queries over many features, which pushes toward 64–128. The difference between a well-chosen and a default capacity is commonly 2–3× on query time.

### What changes when the twin has genuinely stacked geometry?
Add a 3D index only over the stacked subset. A full 3D R-tree over every feature makes all queries slower because node volumes overlap far more in three dimensions, and in a typical city twin under five per cent of features are vertically coincident with another. A 2D index plus an explicit level attribute answers most of it; a small 3D index handles the rest.

### Should the index live in the database or in the application?
In the database if the data lives there and queries are ad hoc; in the application if the index serves a hot path like viewport resolution. PostGIS with a GiST index and an S2 or quadkey column covers the first case well. A memory-resident R-tree in the tile server covers the second at a latency the database cannot match.

## Related Guides

- [Octree Indexing Point Clouds with Morton Codes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/octree-indexing-point-clouds-with-morton-codes/) — build an octree over a LiDAR point cloud in NumPy with 3D Morton codes
- [Computing Quadkeys and Tile Bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/) — the tile arithmetic in full
- [Choosing Between S2, H3 and Geohash for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/choosing-between-s2-h3-and-geohash-for-3d-data/) — the decision, measured on real extents
- [Building an R-tree Index for 3D Tile Lookup](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/building-an-r-tree-index-for-3d-tile-lookup/) — bulk loading, capacity tuning and staleness
- [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — where the partition becomes a tile tree
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — sharding and incremental rebuilds against these keys
- [Aggregating Sensor Data with H3 Cells](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/aggregating-sensor-data-with-h3-cells/) — bin twin sensor readings into H3 hexagons
- [Serving Tile Lookups from PostGIS](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/serving-tile-lookups-from-postgis/) — answer viewport and tile queries from PostGIS

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
