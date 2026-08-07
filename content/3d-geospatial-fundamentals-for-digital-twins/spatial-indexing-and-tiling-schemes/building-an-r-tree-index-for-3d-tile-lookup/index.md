# Building an R-tree Index for 3D Tile Lookup

This page builds the structure that answers "which tiles overlap this rectangle" — an R-tree over tile bounding volumes, using `rtree` and libspatialindex — and covers the three things that decide whether it is fast: bulk loading instead of per-item insertion, a leaf capacity chosen for range queries rather than point queries, and adding the third dimension only for the features that genuinely stack. A cell scheme such as a quadkey tells you which partition a point falls in; only a tree over real extents tells you which features a viewport touches.

## Why you hit this

A viewport query takes a rectangle and needs the set of tiles that intersect it, in under a frame. Cell keys cannot answer that efficiently, because a tile's extent generally spans several cells and a feature near a boundary belongs to more than one — so the cell-based answer is either incomplete or requires enumerating a covering and unioning the results. An R-tree indexes the extents themselves, so the query is one descent through a tree whose nodes are bounding boxes. Every twin ends up with one, whether in PostGIS as a GiST index or in the tile server as an in-memory structure.

## Prerequisites

- Python 3.10+ with `rtree>=1.1`, which needs libspatialindex present (`pip install rtree` bundles it on most platforms; `apt install libspatialindex-dev` otherwise).
- Tile or feature bounding boxes in one projected metric CRS. The examples use EPSG:32633 (UTM 33N) with orthometric Z, consistent with the rest of the [coordinate reference system](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) guidance.
- A decision about persistence: in-memory for a hot service, on-disk and memory-mapped for a batch job that touches each region once.

## Step-by-Step

### 1. Build the smallest useful index and query it

Start here to confirm the install and the coordinate order. `rtree` takes `(minx, miny, maxx, maxy)` and returns the ids you inserted.

```python
from rtree import index

tiles = [
    (0, (598000, 6643800, 598512, 6644312), "12022001101131"),
    (1, (598512, 6643800, 599024, 6644312), "12022001101133"),
    (2, (598000, 6644312, 598512, 6644824), "12022001101132"),
]

idx = index.Index()
for tid, bbox, _qk in tiles:
    idx.insert(tid, bbox)

viewport = (598400, 6644200, 598700, 6644400)
hits = sorted(idx.intersection(viewport))
print("tiles in viewport:", [tiles[i][2] for i in hits])
```

Two things to confirm before going further. The bounding boxes must be in the same CRS as the query rectangle — mixing a metric index with a geographic query returns an empty set rather than an error — and `intersection` is inclusive of touching edges, so a viewport that ends exactly on a tile boundary returns the tile on both sides. Both behaviours are what you want; both surprise people once.

### 2. Bulk load instead of inserting

Per-item insertion rebalances the tree on every call. Bulk loading through the generator interface uses Sort-Tile-Recursive packing, which is both far faster to build and produces a better-balanced tree.

```python
from rtree import index

def stream(items):
    for tid, bbox, payload in items:
        yield (tid, bbox, payload)

props = index.Property()
props.leaf_capacity = 96
props.index_capacity = 96
props.fill_factor = 0.9

packed = index.Index(stream(tiles), properties=props)
print("bulk-loaded", packed.get_size(), "entries")
```

The difference is not marginal. Over a million entries, per-item insertion typically takes minutes; the packed build takes seconds and answers subsequent range queries meaningfully faster, because STR packing groups entries that are spatially close rather than in whatever order they arrived.

<figure class="diagram">
<svg viewBox="24 18 700 284" role="img" aria-labelledby="rt-pack-t rt-pack-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rt-pack-t">Insertion order against sort-tile-recursive packing</title>
  <desc id="rt-pack-d">Inserting entries in arrival order produces nodes whose bounding boxes overlap heavily, because entries that arrived together are not necessarily near each other. Sort-tile-recursive packing sorts by coordinate first, so each node covers a compact region and a query descends far fewer branches.</desc>
  <rect class="svg-bg" x="24" y="18" width="700" height="284" fill="#ffffff"/>
  <path d="M40 60 h180 v120 h-180 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M120 90 h190 v120 h-190 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M80 110 h180 v110 h-180 Z" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M440 60 h130 v100 h-130 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M580 60 h130 v100 h-130 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M440 172 h130 v90 h-130 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M580 172 h130 v90 h-130 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="175" y="46" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">inserted in arrival order</text>
  <text x="575" y="46" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">STR-packed</text>
  <text x="175" y="244" fill="#1f2937" font-size="12" text-anchor="middle">nodes overlap; a query descends three branches</text>
  <text x="575" y="284" fill="#1f2937" font-size="12" text-anchor="middle">nodes are disjoint; a query descends one</text>
  <text x="175" y="268" fill="#5b6471" font-size="12" text-anchor="middle">and the build rebalances on every insert</text>
</svg>
<figcaption>Overlap between sibling nodes is what an R-tree query pays for. Packing removes most of it before the first query is ever asked.</figcaption>
</figure>

### 3. Tune the leaf capacity to the query shape

Capacity sets how many entries a leaf holds. Small capacities make a deep tree that suits point lookups; large capacities make a shallow one that suits rectangle queries returning many results — which is what a viewport does.

```python
import time
from rtree import index

def build_and_time(entries, capacity, queries):
    p = index.Property()
    p.leaf_capacity = capacity
    p.index_capacity = capacity
    t0 = time.perf_counter()
    ix = index.Index(((i, b, None) for i, b, _ in entries), properties=p)
    build = time.perf_counter() - t0

    t0 = time.perf_counter()
    total = sum(len(list(ix.intersection(q))) for q in queries)
    query = time.perf_counter() - t0
    return build, query, total

for cap in (10, 32, 64, 128, 256):
    b, q, n = build_and_time(tiles, cap, [viewport] * 1000)
    print(f"capacity {cap:>4}: build {b*1000:6.1f} ms   1000 queries {q*1000:6.1f} ms   {n} hits")
```

The curve is flat-bottomed rather than sharply peaked, which is good news: anywhere between 64 and 128 is close to optimal for viewport-shaped queries, and the default of 10 is usually two to three times slower. What matters is measuring on your own extents, because the optimum moves with how much the boxes overlap.

### 4. Decide about the third dimension deliberately

A 3D R-tree is available and it is not free. Node volumes overlap far more in three dimensions than in two for the same features, so the tree prunes less and every query costs more — including the vast majority of queries that never needed Z.

```python
from rtree import index

p3 = index.Property()
p3.dimension = 3
idx3 = index.Index(properties=p3)

# (minx, miny, minz, maxx, maxy, maxz) in metres, EPSG:32633 + orthometric Z
idx3.insert(0, (598000, 6643800, 12.0, 598040, 6643860, 34.5))    # building
idx3.insert(1, (598010, 6643810, -18.0, 598030, 6643850, -8.0))   # tunnel beneath it
idx3.insert(2, (598100, 6643900, 8.0, 598160, 6643960, 21.0))     # neighbour

above_ground = (597900, 6643700, 0.0, 598300, 6644000, 60.0)
below_ground = (597900, 6643700, -40.0, 598300, 6644000, 0.0)

print("above ground:", sorted(idx3.intersection(above_ground)))
print("below ground:", sorted(idx3.intersection(below_ground)))
```

The practical rule: index in 2D and carry an explicit `stratum` attribute (`surface`, `subsurface`, `elevated`) unless more than roughly a tenth of your features are vertically coincident with another. Filtering a 2D result by stratum costs one comparison per hit; a 3D tree costs every query.

<figure class="diagram">
<svg viewBox="-80 46 900 238" role="img" aria-labelledby="rt-dim-t rt-dim-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rt-dim-t">Two ways to answer a query that involves height</title>
  <desc id="rt-dim-d">A full three-dimensional R-tree indexes every feature by height and makes every query pay for the extra overlap. A two-dimensional index with a stratum attribute answers the same question by filtering the hits, which costs one comparison per result and leaves the tree's pruning power intact.</desc>
  <rect class="svg-bg" x="-80" y="46" width="900" height="238" fill="#ffffff"/>
  <defs>
    <marker id="rt-dim-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="24" y="60" width="160" height="54" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="234" y="60" width="200" height="54" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="484" y="60" width="230" height="54" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="24" y="170" width="160" height="54" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="234" y="170" width="200" height="54" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="484" y="170" width="230" height="54" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#rt-dim-a)">
    <line x1="184" y1="87" x2="232" y2="87"/>
    <line x1="434" y1="87" x2="482" y2="87"/>
    <line x1="184" y1="197" x2="232" y2="197"/>
    <line x1="434" y1="197" x2="482" y2="197"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="104" y="92">viewport query</text>
    <text x="334" y="82"><tspan x="334" dy="0">3D tree — every query</tspan><tspan x="334" dy="16">pays for the extra overlap</tspan></text>
    <text x="599" y="82"><tspan x="599" dy="0">correct, and slower for the</tspan><tspan x="599" dy="16">95% that never needed Z</tspan></text>
    <text x="104" y="202">viewport query</text>
    <text x="334" y="192"><tspan x="334" dy="0">2D tree — full pruning,</tspan><tspan x="334" dy="16">then filter by stratum</tspan></text>
    <text x="599" y="192"><tspan x="599" dy="0">correct, and one comparison</tspan><tspan x="599" dy="16">per hit instead of per node</tspan></text>
  </g>
  <text x="370" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">Reach for three dimensions when features genuinely stack in bulk — a metro network, a multi-level structure — not because the data has a Z column</text>
</svg>
<figcaption>Dimensionality is a cost paid on every query and a benefit gained on a few. Count the stacked features before choosing.</figcaption>
</figure>

### 5. Persist the index, and detect when it goes stale

An on-disk index is memory-mapped, so a large one costs almost no resident memory. The trade is a page fault on cold access, which is right for batch work and wrong for a latency-sensitive service.

```python
from rtree import index

p = index.Property()
p.leaf_capacity = 96
p.storage = index.RT_Disk

disk = index.Index("city_tiles", ((i, b, None) for i, b, _ in tiles), properties=p)
disk.flush()

reopened = index.Index("city_tiles", properties=p)
print("reopened with", reopened.get_size(), "entries")
```

Staleness is the failure mode that matters here, because nothing detects it. An R-tree records the bounding boxes it was given; if a geometry is edited in place afterwards, the tree keeps returning the old extent and the query silently returns the wrong set. Two remedies work: rebuild the index whenever geometry is written, or make geometry immutable and version it. The second is usually less discipline for the same guarantee.

<figure class="diagram">
<svg viewBox="-40 43 820 231" role="img" aria-labelledby="rt-stale-t rt-stale-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rt-stale-t">A stale index answers confidently and wrongly</title>
  <desc id="rt-stale-d">The tree stores the bounding box a feature had when it was indexed. After the geometry is edited in place the feature has moved, but the tree still holds the old extent, so a query over the new position misses it and a query over the old position returns it. Nothing in the tree or the query reports a problem.</desc>
  <rect class="svg-bg" x="-40" y="43" width="820" height="231" fill="#ffffff"/>
  <defs>
    <marker id="rt-stale-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M60 80 h110 v80 h-110 Z" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M250 110 h110 v80 h-110 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M180 120 L246 145" fill="none" stroke="#5b6471" stroke-width="2" marker-end="url(#rt-stale-a)"/>
  <text x="115" y="70" fill="#b0413e" font-size="12" text-anchor="middle">what the tree holds</text>
  <text x="305" y="100" fill="#1f6b8a" font-size="12" text-anchor="middle">where the geometry is</text>
  <path d="M470 100 h90 v70 h-90 Z" fill="none" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M580 100 h90 v70 h-90 Z" fill="none" stroke="#b0413e" stroke-width="2"/>
  <text x="515" y="90" fill="#4f7a4d" font-size="12" text-anchor="middle">query here: hit</text>
  <text x="625" y="90" fill="#b0413e" font-size="12" text-anchor="middle">query here: miss</text>
  <text x="570" y="196" fill="#1f2937" font-size="12" text-anchor="middle">both answers are wrong, and both are returned without error</text>
  <text x="370" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Nothing in an R-tree observes the geometry after insertion — staleness has to be prevented, because it cannot be detected from inside</text>
  <text x="370" y="256" fill="#5b6471" font-size="12" text-anchor="middle">Either rebuild on every write, or make geometry immutable and version it; the second needs less discipline for the same guarantee</text>
</svg>
<figcaption>Index staleness is the one R-tree fault with no signature at all — no exception, no empty result, just a plausible answer computed from a coordinate that no longer exists.</figcaption>
</figure>

## Expected Output & Verification

The definitive check is agreement with a brute-force scan over a sample of random rectangles. It catches a stale index, a CRS mismatch and a coordinate-order error in one test.

```python
import random
from rtree import index

def brute(entries, q):
    qminx, qminy, qmaxx, qmaxy = q
    return {i for i, (a, b, c, d), _ in entries
            if not (c < qminx or a > qmaxx or d < qminy or b > qmaxy)}

rng = random.Random(0)
mismatches = 0
for _ in range(200):
    x = rng.uniform(597800, 599200)
    y = rng.uniform(6643600, 6645000)
    q = (x, y, x + rng.uniform(50, 600), y + rng.uniform(50, 600))
    if set(idx.intersection(q)) != brute(tiles, q):
        mismatches += 1

assert mismatches == 0, f"{mismatches}/200 queries disagree with a brute-force scan"
print("index agrees with brute force on 200 random rectangles")
```

Expected output is a clean pass. A small number of mismatches concentrated on rectangles that touch a boundary points at an inclusive/exclusive edge convention rather than at a broken index. Mismatches spread evenly across the sample mean the index and the geometry have diverged, and the fix is in the write path rather than in the query.

## Common Errors

**`OSError: Unable to open index file`.** The on-disk index is two files, `name.idx` and `name.dat`, and both must be present and writable. Copying only one, or copying them between machines with different libspatialindex builds, produces this. Rebuild rather than trying to repair.

**Every query returns everything.** The bounding boxes were inserted as `(minx, maxx, miny, maxy)` rather than `(minx, miny, maxx, maxy)`. The tree accepts it and every box becomes enormous. Assert `bbox[0] <= bbox[2] and bbox[1] <= bbox[3]` at insertion time.

**Queries slow down over a session.** The index is being inserted into while it is being queried, and each insertion rebalances. Build once, query many; if the data really is changing continuously, keep a small delta index alongside the packed one and merge periodically.

## Frequently Asked Questions

### Should the R-tree live in the database or in the service?
In the database when the data lives there and the queries are ad hoc — PostGIS with a GiST index gets you the same structure with no code to maintain. In the service when viewport resolution is a hot path, because a memory-resident tree answers in microseconds and a round trip to the database cannot.

### How large does an index get?
Roughly 70 bytes per 2D entry in memory, so ten million tiles is about 700 MB resident. The on-disk form is memory-mapped and costs almost nothing resident, at the price of a page fault on cold access.

### Does the index need rebuilding when a tileset is re-deployed?
Only if the extents changed. Re-encoding the same geometry produces the same bounding boxes, so a rebuild driven by content hash rather than by deployment avoids most of the work.

## Related Guides

- [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/) — where the R-tree sits beside cell schemes
- [Computing Quadkeys and Tile Bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/) — the partition keys these boxes come from
- [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the bounding-volume hierarchy the runtime uses for the same job

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
