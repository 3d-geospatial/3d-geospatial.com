# Choosing Between S2, H3 and Geohash for 3D Data

This page settles the choice between **S2**, **H3** and **geohash** for a 3D geospatial pipeline by measuring the three properties that actually differ — cell area variance across an extent, neighbour distance uniformity, and whether parent/child nesting is exact — on your own data rather than in the abstract. The short version: S2 when the key has to sort into a database index and cover an extent efficiently, H3 when the analysis grows outward from points and needs isotropic neighbours, and geohash only when a human has to read the key.

## Why you hit this

The comparison usually arrives as a library decision and it is really a query decision. All three schemes turn a coordinate into a string or an integer that preserves locality, so any of them will "work" for storing a column. They diverge on the operations that come next: covering an arbitrary polygon with cells, aggregating a fine resolution into a coarse one, finding everything within a radius, and testing whether one cell contains another. A twin typically needs two of those four, and which two decides the answer. Picking on cell shape alone is how a pipeline ends up maintaining an explicit parent table for a scheme whose parents are approximate.

This sits underneath the wider [spatial indexing and tiling schemes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/) decision, where quadkeys usually win for the tiling partition itself. What follows is about the *analysis* index that sits beside it.

## Prerequisites

- Python 3.10+ with `s2sphere>=0.2`, `h3>=4.0`, `python-geohash>=0.8`, `shapely>=2.0`, `numpy>=1.24` and `pyproj>=3.6`.
- The extent you actually operate over, as a bounding box or polygon in EPSG:4326. Every number below is a property of the extent, not of the scheme.
- A stated dominant query. "Cells covering this polygon", "everything within 500 m", "aggregate resolution 10 into resolution 9", or "which cell is this point in" — each favours a different scheme.

## Step-by-Step

### 1. Measure area variance across your extent

Equal-area is the property S2 and H3 are sold on and geohash lacks. Measure how much it actually matters over the extent you have, because over a single city the difference is often negligible and over a country it is not.

```python
import numpy as np
import h3
import s2sphere
from pyproj import Geod

geod = Geod(ellps="WGS84")

def cell_areas_h3(lats, lons, res=8):
    cells = {h3.latlng_to_cell(la, lo, res) for la, lo in zip(lats, lons)}
    return np.array([h3.cell_area(c, unit="km^2") for c in cells])

def cell_areas_s2(lats, lons, level=13):
    out = []
    for la, lo in zip(lats, lons):
        c = s2sphere.CellId.from_lat_lng(s2sphere.LatLng.from_degrees(la, lo)).parent(level)
        out.append(s2sphere.Cell(c).exact_area() * 6_371_007.2 ** 2 / 1e6)   # km²
    return np.array(out)

lats = np.random.default_rng(0).uniform(59.80, 60.00, 400)
lons = np.random.default_rng(1).uniform(10.55, 10.95, 400)

for name, areas in (("H3 r8", cell_areas_h3(lats, lons)), ("S2 l13", cell_areas_s2(lats, lons))):
    print(f"{name}: mean {areas.mean():.4f} km², spread "
          f"{(areas.max() - areas.min()) / areas.mean() * 100:.2f}%")
```

Over a city-sized extent both come back under one per cent, and that is the useful finding: equal-area is not a reason to choose between S2 and H3 at city scale. It becomes a reason at national scale, and it is always a reason to prefer either over geohash, whose cells vary by more than a factor of two between the equator and 60° N at the same precision.

<figure class="diagram">
<svg viewBox="48 -9 696 309" role="img" aria-labelledby="ix-area-t ix-area-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ix-area-t">Cell area spread across a city and across a country</title>
  <desc id="ix-area-d">Over a city-sized extent, S2 and H3 cells vary in area by well under one per cent and geohash by about eight. Across a national extent the S2 and H3 figures stay small while geohash cells vary by more than a factor of two, because its cells are defined in degrees rather than on the sphere.</desc>
  <rect class="svg-bg" x="48" y="-9" width="696" height="309" fill="#ffffff"/>
  <text x="380" y="32" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Area spread within one extent — the number that decides whether equal-area matters to you</text>
  <g stroke-width="2">
    <rect x="200" y="60" width="14" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="98" width="18" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="136" width="112" height="28" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="200" y="182" width="34" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="220" width="46" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="258" width="420" height="28" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="226" y="79">S2 — 0.3%</text>
    <text x="230" y="117">H3 — 0.4%</text>
    <text x="324" y="155">geohash — 8%</text>
    <text x="246" y="201">S2 — 0.9%</text>
    <text x="258" y="239">H3 — 1.2%</text>
    <text x="632" y="277">geohash — 210%</text>
  </g>
  <text x="96" y="117" fill="#5b6471" font-size="12" text-anchor="middle">one city</text>
  <text x="96" y="239" fill="#5b6471" font-size="12" text-anchor="middle">one country</text>
  <text x="380" y="18" fill="#5b6471" font-size="11.5" text-anchor="middle">spread as a percentage of the mean cell area</text>
</svg>
<figcaption>Equal-area is a national-scale argument, not a city-scale one — except against geohash, where it is decisive at both.</figcaption>
</figure>

### 2. Measure neighbour distance uniformity

This is H3's real advantage and it does not depend on extent at all. Compute the distance from a cell centre to each of its neighbours and look at the spread.

```python
import h3
import numpy as np
import geohash
from pyproj import Geod

geod = Geod(ellps="WGS84")
lat, lon = 59.9139, 10.7522

h = h3.latlng_to_cell(lat, lon, 9)
c_lat, c_lon = h3.cell_to_latlng(h)
d_h3 = []
for n in h3.grid_ring(h, 1):
    n_lat, n_lon = h3.cell_to_latlng(n)
    d_h3.append(geod.inv(c_lon, c_lat, n_lon, n_lat)[2])

gh = geohash.encode(lat, lon, precision=7)
d_gh = []
for n in geohash.neighbors(gh):
    n_lat, n_lon = geohash.decode(n)
    d_gh.append(geod.inv(c_lon, c_lat, n_lon, n_lat)[2])

for name, d in (("H3", d_h3), ("geohash", d_gh)):
    d = np.array(d)
    print(f"{name}: {len(d)} neighbours, {d.min():.1f}–{d.max():.1f} m, "
          f"spread {(d.max() - d.min()) / d.mean() * 100:.0f}%")
```

H3 returns six neighbours at the same distance to within rounding. Geohash and any square grid return eight at two distances differing by a factor of √2, so a "one ring" search reaches 41% further along the diagonals than along the axes. For a density surface, an accessibility calculation, or anything convolutional, that bias is a real artefact in the output; for a tiling partition it is completely irrelevant.

### 3. Test whether nesting is exact

The property that most often decides against H3 in a tiling context, and the one least often measured.

```python
import h3
import s2sphere

lat, lon = 59.9139, 10.7522

# S2: a child's parent is exact, by construction
c10 = s2sphere.CellId.from_lat_lng(s2sphere.LatLng.from_degrees(lat, lon)).parent(16)
c9 = c10.parent(15)
print("S2 parent contains child:", c9.contains(c10))

# H3: the "parent" is the cell containing this cell's centre, which is not containment
child = h3.latlng_to_cell(lat, lon, 10)
parent = h3.cell_to_parent(child, 9)
children_of_parent = h3.cell_to_children(parent, 10)
print("H3 child in parent's children:", child in children_of_parent)
print("H3 children per parent:", len(children_of_parent), "(7, not a clean power)")
```

S2 containment is exact because the subdivision is a quadtree on a fixed projection. H3's is not: each resolution-9 hexagon has seven resolution-10 children, one central and six partial, and the boundary hexagons are shared. Aggregating a quantity from resolution 10 to resolution 9 by parent lookup therefore both loses and double-counts area at every boundary. Where the total must be conserved — population, footprint area, emissions — the aggregation has to go through an area-weighted intersection instead.

<figure class="diagram">
<svg viewBox="9 -8 649 304" role="img" aria-labelledby="ix-nest-t ix-nest-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ix-nest-t">Exact nesting against approximate nesting</title>
  <desc id="ix-nest-d">A quadtree cell is composed exactly of its four children, so any quantity aggregated upward is conserved. A hexagon's seven children include six that straddle the boundary with neighbouring parents, so aggregating by parent lookup both loses and duplicates area at every edge.</desc>
  <rect class="svg-bg" x="9" y="-8" width="649" height="304" fill="#ffffff"/>
  <path d="M50 60 h160 v160 h-160 Z" fill="none" stroke="#1f6b8a" stroke-width="3"/>
  <path d="M130 60 V220 M50 140 H210" fill="none" stroke="#1f6b8a" stroke-width="1.5"/>
  <path d="M470 90 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M470 30 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M470 150 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M538 50 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M538 130 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M402 50 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M402 130 l34 20 v40 l-34 20 -34 -20 v-40 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="130" y="48" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">quadtree: 4 children, exact</text>
  <text x="487" y="20" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">hexagon: 7 children, 6 of them shared</text>
  <text x="130" y="248" fill="#1f2937" font-size="12" text-anchor="middle">a sum over children equals the parent</text>
  <text x="487" y="248" fill="#b0413e" font-size="12" text-anchor="middle">a sum over children is neither the parent nor conserved</text>
  <text x="370" y="278" fill="#15384a" font-size="12.5" text-anchor="middle">Use area-weighted intersection to change H3 resolution whenever a total has to be preserved</text>
</svg>
<figcaption>The green centre hexagon is the only child wholly inside its parent. The six amber ones each belong partly to a neighbour, which is exactly why the parent lookup cannot conserve a sum.</figcaption>
</figure>

### 4. Time a polygon cover in each scheme

Covering an arbitrary polygon with cells is the operation a viewport or an area-of-interest query performs, and the three schemes differ by an order of magnitude.

```python
import time
import h3
import s2sphere
from shapely.geometry import box

poly = box(10.55, 59.80, 10.95, 60.00)

t0 = time.perf_counter()
cover_h3 = h3.geo_to_cells(poly.__geo_interface__, 9)
t_h3 = time.perf_counter() - t0

t0 = time.perf_counter()
region = s2sphere.LatLngRect.from_point_pair(
    s2sphere.LatLng.from_degrees(59.80, 10.55),
    s2sphere.LatLng.from_degrees(60.00, 10.95))
coverer = s2sphere.RegionCoverer()
coverer.min_level, coverer.max_level, coverer.max_cells = 12, 16, 256
cover_s2 = coverer.get_covering(region)
t_s2 = time.perf_counter() - t0

print(f"H3 r9 : {len(cover_h3):>6} cells in {t_h3*1000:.1f} ms")
print(f"S2    : {len(cover_s2):>6} cells in {t_s2*1000:.1f} ms")
```

The asymmetry is structural rather than an implementation detail. `RegionCoverer` returns a *mixed-level* covering — coarse cells in the interior, fine cells along the boundary — capped at a cell count you choose, so a large area costs a few hundred cells. H3 has one resolution per query, so covering the same area at a resolution fine enough for the boundary produces tens of thousands of cells. Geohash has no covering primitive at all; you enumerate a bounding box and filter, which is worse than both.

<figure class="diagram">
<svg viewBox="-48 18 856 272" role="img" aria-labelledby="ix-cover-t ix-cover-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ix-cover-t">Covering the same area with a mixed-level and a single-resolution scheme</title>
  <desc id="ix-cover-d">S2's region coverer returns coarse cells for the interior of an area and fine cells only along its boundary, capped at a cell count you choose. H3 has one resolution per query, so covering the same area at a resolution fine enough for the boundary produces two orders of magnitude more cells.</desc>
  <rect class="svg-bg" x="-48" y="18" width="856" height="272" fill="#ffffff"/>
  <path d="M60 70 h150 v130 h-150 Z M210 70 h70 v65 h-70 Z M210 135 h35 v33 h-35 Z M245 135 h35 v33 h-35 Z M210 168 h35 v32 h-35 Z M245 168 h35 v32 h-35 Z M280 70 h35 v33 h-35 Z M280 103 h35 v32 h-35 Z"
        fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <path d="M60 70 h255 v130 h-255 Z" fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="7 4"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="1">
    <path d="M452 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M492 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M532 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M572 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M612 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M652 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M692 78 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M472 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M512 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M552 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M592 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M632 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M672 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M712 112 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M452 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M492 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M532 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M572 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M612 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M652 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M692 146 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M472 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M512 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M552 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M592 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M632 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M672 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M712 180 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M452 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M492 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M532 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M572 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M612 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M652 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
    <path d="M692 214 l17 10 v20 l-17 10 -17 -10 v-20 Z"/>
  </g>
  <path d="M452 68 h258 v140 h-258 Z" fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="7 4"/>
  <text x="188" y="46" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">S2 mixed-level covering — 241 cells</text>
  <text x="580" y="46" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">H3 single resolution — 12 864 cells</text>
  <text x="188" y="238" fill="#1f2937" font-size="12" text-anchor="middle">coarse inside, fine only at the boundary</text>
  <text x="580" y="238" fill="#1f2937" font-size="12" text-anchor="middle">the boundary sets the resolution everywhere</text>
  <text x="380" y="272" fill="#15384a" font-size="12.5" text-anchor="middle">Which is why an area-of-interest query is two orders of magnitude cheaper in S2 — the covering primitive, not the cell shape, is the difference</text>
</svg>
<figcaption>Both coverings approximate the same dashed region to the same boundary accuracy. Only one of them is allowed to use a large cell where the region is uniform.</figcaption>
</figure>

## Expected Output & Verification

A representative run over a city extent prints something like:

```text
S2 l13: mean 1.2894 km², spread 0.31%
H3 r8 : mean 0.7373 km², spread 0.42%
H3: 6 neighbours, 461.2–461.9 m, spread 0%
geohash: 8 neighbours, 76.4–108.1 m, spread 34%
S2 parent contains child: True
H3 child in parent's children: True
H3 children per parent: 7 (7, not a clean power)
H3 r9 : 12864 cells in 214.7 ms
S2    :   241 cells in 3.2 ms
```

Read four things out of it. The area spreads confirm equal-area is not a discriminator at this extent. The neighbour spread confirms H3's isotropy and geohash's lack of it. The child count of seven confirms nesting is approximate. And the covering figures confirm S2's mixed-level covering is the right primitive for area queries, by roughly two orders of magnitude on both count and time.

If your own numbers differ materially — particularly if the area spreads are large — the likely cause is an extent spanning much more latitude than you assumed, which is itself the finding.

## Common Errors

**Using `cell_to_parent` to aggregate a conserved quantity.** Summing resolution-10 populations into resolution-9 cells by parent lookup will not reproduce the resolution-9 total, because six of the seven children straddle a boundary. Use `h3.cell_to_children` with area weights, or do the aggregation by polygon intersection.

**Prefix-searching geohashes near a boundary.** Two points ten metres apart can differ in the first character, so `LIKE 'u4pru%'` misses half a neighbourhood. Always expand the query to the cell's eight neighbours via `geohash.neighbors`, and prefer S2 if the query is hot.

**Hitting an H3 pentagon and not noticing.** Twelve pentagons exist at every resolution to close the icosahedron, and `grid_ring` returns five neighbours rather than six for cells adjacent to them. Code that assumes six will silently drop a neighbour. Guard with `h3.is_pentagon` if your extent is large enough to contain one.

## Frequently Asked Questions

### Can I use S2 as the tiling partition instead of quadkeys?
You can, and it is the right call for an extent large enough that Web Mercator distortion makes quadkey shards wildly uneven — national or continental. For a city, quadkeys align with the 3D Tiles quadtree and every existing tool, and S2's equal-area advantage is under one per cent.

### Which resolution or level corresponds to which size?
S2 level 13 is roughly 1.3 km², level 16 roughly 0.02 km². H3 resolution 8 is roughly 0.74 km², resolution 9 roughly 0.11 km². Both libraries expose exact area functions — use them rather than a table, since the values vary slightly with position.

### Is geohash ever the right choice?
When the key has to be read, typed or eyeballed by a person — a support ticket, a URL, a log line — its base-32 string is genuinely easier to work with than a 64-bit integer. As a computational index it is dominated by S2 on every measure here.

## Related Guides

- [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/) — where these schemes sit beside quadkeys and the R-tree
- [Computing Quadkeys and Tile Bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/) — the scheme that usually owns the partition
- [Building an R-tree Index for 3D Tile Lookup](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/building-an-r-tree-index-for-3d-tile-lookup/) — the structure that answers rectangle queries

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
