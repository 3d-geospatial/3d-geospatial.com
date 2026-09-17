# Choosing Shard Sizes for City-Scale Tiling

This page chooses the shard size for a city-scale tiling job from measurements rather than convention — balancing bytes per tile against request count, rebuild granularity against boundary duplication, and the parallel-build sweet spot against scheduler overhead, using building footprints in EPSG:25832 and a quadkey grid.

## Why you hit this

The shard size is decided once, early, usually by copying whatever the last project used, and it then constrains everything: how long an incremental rebuild takes, how many requests a viewport costs, how well the work parallelises, and how much geometry is duplicated at boundaries. Getting it wrong is not catastrophic and is expensive in aggregate — a city tiled at zoom 18 makes 260,000 shards where 4,000 would do, and one tiled at zoom 12 rebuilds a quarter of the city when one building changes. The pipeline this feeds is in [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).

## Prerequisites

- Python 3.10+ with `geopandas>=0.14`, `mercantile>=1.2`, `numpy>=1.24`, `pandas>=2.0`, `shapely>=2.0`.
- The source features with their footprints and an estimate of bytes per feature — from a pilot tiling of a few shards, or 20–60 kB per LOD2 building as a starting figure.
- The viewer's target: how many tiles a typical viewport should request, and the per-tile byte budget from the client memory work in [tuning tileset cache bytes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/tuning-tileset-cache-bytes-for-memory-constrained-clients/).

## Step-by-Step

### 1. Measure the feature distribution per candidate grid

```python
import geopandas as gpd
import mercantile
import numpy as np
import pandas as pd
from pyproj import Transformer

to_wgs84 = Transformer.from_crs(25832, 4326, always_xy=True)

def assign_shards(gdf, zoom):
    lon, lat = to_wgs84.transform(gdf.geometry.centroid.x.to_numpy(),
                                  gdf.geometry.centroid.y.to_numpy())
    keys = [mercantile.quadkey(mercantile.tile(lo, la, zoom)) for lo, la in zip(lon, lat)]
    return pd.Series(keys, index=gdf.index, name=f"z{zoom}")

def grid_stats(gdf, zooms=range(12, 19), bytes_per_feature=34_000):
    rows = []
    for z in zooms:
        shards = assign_shards(gdf, z)
        counts = shards.value_counts()
        side_m = 40075016.686 * np.cos(np.radians(float(gdf.geometry.centroid.y.mean() and 48.14))) / 2 ** z
        rows.append({
            "zoom": z,
            "shard_side_m": round(side_m, 1),
            "shards": int(len(counts)),
            "features_median": int(counts.median()),
            "features_p95": int(counts.quantile(0.95)),
            "features_max": int(counts.max()),
            "bytes_median_mb": round(counts.median() * bytes_per_feature / 1e6, 2),
            "bytes_p95_mb": round(counts.quantile(0.95) * bytes_per_feature / 1e6, 2),
            "empty_share": round(1 - len(counts) / max(len(counts), 1), 3),
        })
    return pd.DataFrame(rows)

buildings = gpd.read_file("source/footprints.gpkg").to_crs(25832)
stats = grid_stats(buildings)
print(stats.to_string(index=False))
```

The 95th percentile matters more than the median. A city's building density varies by an order of magnitude between a historic centre and a suburb, so a grid whose median shard is a comfortable 2 MB will have dense shards at 20 MB — and those are the ones a user in the centre downloads. Sizing on the median produces a tileset that is fine everywhere except where people actually look.

<figure class="diagram">
<svg viewBox="52 8 662 248" role="img" aria-labelledby="shard-tradeoff-t shard-tradeoff-d" xmlns="http://www.w3.org/2000/svg">
  <title id="shard-tradeoff-t">What gets better and worse as shards shrink</title>
  <desc id="shard-tradeoff-d">Two curves against shard size. Bytes per tile fall as shards shrink, which helps the client, while the number of requests for a fixed viewport rises, which hurts. Rebuild granularity improves with smaller shards and boundary duplication worsens. The workable band is where tile bytes are a few megabytes and a viewport costs tens of requests rather than hundreds.</desc>
  <rect class="svg-bg" x="52" y="8" width="662" height="248" fill="#ffffff"/>
  <path d="M70 30 V190 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="250" y="30" width="200" height="160" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1"/>
  <polyline points="100,40 180,66 250,96 330,124 420,148 520,166 660,180" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="100,182 180,176 250,164 330,140 420,110 520,72 660,36" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="212">1.2 km (z12)</text><text x="250" y="212">300 m (z14)</text>
    <text x="420" y="212">75 m (z16)</text><text x="660" y="212">19 m (z18)</text>
  </g>
  <text x="140" y="36" fill="#1f6b8a" font-size="12.5" text-anchor="start">bytes per tile</text>
  <text x="560" y="58" fill="#b0413e" font-size="12.5" text-anchor="end">requests per viewport</text>
  <text x="350" y="48" fill="#1f2937" font-size="12.5" text-anchor="middle">workable band</text>
  <text x="385" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">shard side length — the band is wide, and both ends of the axis are genuinely bad</text>
</svg>
<figcaption>The two costs move in opposite directions, so the choice is a band rather than an optimum, and the band is set by the client's limits.</figcaption>
</figure>

### 2. Estimate the viewport request count

```python
def requests_per_viewport(zoom, viewport_m=1200, levels=3):
    """How many shards a viewport spans, across the levels a camera loads."""
    side_m = 40075016.686 * np.cos(np.radians(48.14)) / 2 ** zoom
    across = max(1, int(np.ceil(viewport_m / side_m)))
    per_level = across ** 2
    return {"zoom": zoom, "shard_side_m": round(side_m, 1),
            "shards_across_viewport": across,
            "requests_one_level": per_level,
            "requests_all_levels": per_level * levels}

for z in range(12, 19):
    r = requests_per_viewport(z)
    print(f"z{z}  side {r['shard_side_m']:>7.1f} m  {r['shards_across_viewport']:>3} across  "
          f"{r['requests_all_levels']:>6,} requests for a 1.2 km view")
```

A viewport of about a kilometre is the normal working view for a city twin, and the request count for it is the number to keep in the tens. HTTP/2 multiplexes well, so a hundred requests is survivable and a thousand is not — connection limits, per-request overhead and the browser's own scheduling turn it into visible stalling, which is the subject of [HTTP/2 and connection limits for tile streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/).

### 3. Quantify boundary duplication

```python
from shapely.geometry import box

def boundary_cost(gdf, zoom, buffer_m=5.0, sample=4000):
    """Share of features that straddle a shard boundary and must be duplicated or clipped."""
    idx = np.random.default_rng(5).choice(len(gdf), min(sample, len(gdf)), replace=False)
    sub = gdf.iloc[idx]
    lon, lat = to_wgs84.transform(sub.geometry.centroid.x.to_numpy(),
                                  sub.geometry.centroid.y.to_numpy())
    straddling = 0
    for geom, lo, la in zip(sub.geometry, lon, lat):
        t = mercantile.tile(lo, la, zoom)
        b = mercantile.bounds(t)
        x0, y0 = Transformer.from_crs(4326, 25832, always_xy=True).transform(b.west, b.south)
        x1, y1 = Transformer.from_crs(4326, 25832, always_xy=True).transform(b.east, b.north)
        cell = box(x0, y0, x1, y1)
        if not cell.buffer(-buffer_m).contains(geom):
            straddling += 1
    return {"zoom": zoom, "sampled": len(sub),
            "straddling_share": round(straddling / len(sub), 4)}

for z in (13, 14, 15, 16, 17):
    print(boundary_cost(buildings, z))
```

Every feature that crosses a shard boundary has to be either duplicated into both shards or clipped, and both cost something: duplication inflates bytes and creates double-drawn edges, clipping produces open geometry that no longer bounds a volume. The share grows as shards shrink — at 19 m shards most buildings straddle a boundary — and that is the hard floor on how small a building-tile shard can usefully be.

<figure class="diagram">
<svg viewBox="16 16 728 238" role="img" aria-labelledby="shard-straddle-t shard-straddle-d" xmlns="http://www.w3.org/2000/svg">
  <title id="shard-straddle-t">Buildings straddling shard boundaries at two grid sizes</title>
  <desc id="shard-straddle-d">The same block on two grids. On a 400 metre grid, one building in ten crosses a boundary and must be duplicated or clipped. On a 100 metre grid, most buildings cross a boundary, so duplication inflates the tiles and clipped geometry no longer bounds a volume.</desc>
  <rect class="svg-bg" x="16" y="16" width="728" height="238" fill="#ffffff"/>
  <g stroke="#5b6471" stroke-width="1.2" fill="none">
    <path d="M30 30 H330 V190 H30 Z M180 30 V190 M30 110 H330"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.2" fill="none">
    <path d="M430 30 H730 V190 H430 Z M505 30 V190 M580 30 V190 M655 30 V190
             M430 70 H730 M430 110 H730 M430 150 H730"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.6">
    <rect x="60" y="50" width="60" height="40"/><rect x="210" y="50" width="70" height="40"/>
    <rect x="60" y="130" width="70" height="40"/><rect x="240" y="130" width="60" height="40"/>
    <rect x="460" y="50" width="60" height="40"/><rect x="610" y="50" width="70" height="40"/>
    <rect x="460" y="130" width="70" height="40"/><rect x="640" y="130" width="60" height="40"/>
  </g>
  <rect x="150" y="90" width="70" height="40" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="550" y="90" width="70" height="40" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M486 94 H528 V130 H486 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M664 96 H716 V126 H664 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="180" y="212">400 m grid: ~9% straddle</text>
    <text x="580" y="212">100 m grid: most straddle</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12" text-anchor="middle">Red buildings cross a boundary and must be duplicated into both shards or clipped.</text>
</svg>
<figcaption>Straddling is the hard floor on shard size for building tiles: below the size of a city block, most features belong to two shards.</figcaption>
</figure>

### 4. Check the parallel-build shape

```python
def build_shape(stats_row, workers=16, seconds_per_feature=0.012, overhead_s=2.5):
    shards = stats_row["shards"]
    median = stats_row["features_median"]
    p95 = stats_row["features_p95"]
    per_shard_median = median * seconds_per_feature + overhead_s
    per_shard_p95 = p95 * seconds_per_feature + overhead_s
    total_work = shards * per_shard_median
    return {
        "zoom": int(stats_row["zoom"]),
        "shards": shards,
        "median_shard_s": round(per_shard_median, 1),
        "p95_shard_s": round(per_shard_p95, 1),
        "wall_clock_min": round(total_work / workers / 60, 1),
        "overhead_share": round(shards * overhead_s / total_work, 3),
    }

for _, row in stats.iterrows():
    print(build_shape(row))
```

Per-shard overhead is the cost that punishes tiny shards. A tiling job spends two or three seconds per shard on process start, reading inputs, writing outputs and updating the manifest, regardless of whether the shard holds two buildings or two hundred. At zoom 18 that overhead is most of the build: a quarter of a million shards at 2.5 s each is 170 core-hours before any geometry is processed.

<figure class="diagram">
<svg viewBox="58 20 666 216" role="img" aria-labelledby="shard-overhead-t shard-overhead-d" xmlns="http://www.w3.org/2000/svg">
  <title id="shard-overhead-t">Build time split between work and per-shard overhead</title>
  <desc id="shard-overhead-d">Stacked bars for four zoom levels. At zoom 13 the geometry work dominates and overhead is a few percent. At zoom 15 overhead is about a fifth. At zoom 17 overhead and work are comparable. At zoom 18 overhead is three quarters of the build, so most of the machine time is spent starting and finishing shards rather than tiling.</desc>
  <rect class="svg-bg" x="58" y="20" width="666" height="216" fill="#ffffff"/>
  <path d="M110 24 V190" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="110" y="34" width="300" height="28" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="410" y="34" width="14" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="110" y="74" width="290" height="28" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="400" y="74" width="72" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="110" y="114" width="280" height="28" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="390" y="114" width="250" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="110" y="154" width="150" height="28" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="154" width="450" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="72" y="53">z13</text><text x="72" y="93">z15</text><text x="72" y="133">z17</text><text x="72" y="173">z18</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="150" y="53">geometry work</text>
    <text x="482" y="93">overhead 20%</text>
    <text x="650" y="133">47%</text>
    <text x="480" y="173">overhead 75%</text>
  </g>
  <text x="400" y="218" fill="#15384a" font-size="12.5" text-anchor="middle">Per-shard overhead of about 2.5 s is what makes very small shards expensive to build.</text>
</svg>
<figcaption>Below a few hundred features per shard, a tiling job stops being a geometry problem and becomes a scheduling one.</figcaption>
</figure>

### 5. Put the criteria together

```python
def score_grid(stats, max_tile_mb=6.0, max_requests=120, max_straddle=0.15,
               max_overhead=0.25, boundary=None):
    rows = []
    for _, r in stats.iterrows():
        z = int(r["zoom"])
        req = requests_per_viewport(z)["requests_all_levels"]
        shape = build_shape(r)
        straddle = boundary.get(z) if boundary else None
        checks = {
            "tile_bytes": r["bytes_p95_mb"] <= max_tile_mb,
            "requests": req <= max_requests,
            "straddling": (straddle is None) or (straddle <= max_straddle),
            "overhead": shape["overhead_share"] <= max_overhead,
        }
        rows.append({"zoom": z, "p95_mb": r["bytes_p95_mb"], "requests": req,
                     "straddling": straddle, "overhead": shape["overhead_share"],
                     "passes": sum(checks.values()), "ok": all(checks.values()),
                     "failing": [k for k, v in checks.items() if not v]})
    return pd.DataFrame(rows)

boundary = {z: boundary_cost(buildings, z)["straddling_share"] for z in range(13, 18)}
scored = score_grid(stats, boundary=boundary)
print(scored.to_string(index=False))
best = scored[scored["ok"]]
print(f"\nworkable zooms: {list(best['zoom'])}")
```

Four criteria, and the answer is usually a range of two or three zoom levels rather than one. Within that range the tie-breaker is rebuild granularity: the smallest workable shard rebuilds the least when a building changes, which matters for a twin tracking a register that changes daily, as in [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).

### 6. Handle the dense outliers separately

```python
def split_dense_shards(gdf, zoom, max_features=400):
    """Subdivide only the shards that exceed the feature limit, one level deeper."""
    shards = assign_shards(gdf, zoom)
    counts = shards.value_counts()
    dense = set(counts[counts > max_features].index)
    finer = assign_shards(gdf, zoom + 1)
    assignment = np.where(shards.isin(dense), finer, shards)
    out = pd.Series(assignment, index=gdf.index, name="shard")
    final = out.value_counts()
    return out, {"base_zoom": zoom, "dense_shards_split": len(dense),
                 "shards_total": int(len(final)),
                 "features_max_after": int(final.max()),
                 "features_p95_after": int(final.quantile(0.95))}

assignment, info = split_dense_shards(buildings, 15)
print(info)
```

Splitting only the dense shards is what resolves the median-versus-p95 tension without penalising the whole city. The result is a mixed grid — most shards at one level, the historic centre a level deeper — which the tileset expresses naturally, because a quadkey child is just a longer key and the merge step in [merging shard tilesets into a root tileset](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/merging-shard-tilesets-into-a-root-tileset/) groups by prefix regardless.

## Expected Output & Verification

```text
 zoom  shard_side_m  shards  features_median  features_p95  features_max  bytes_median_mb  bytes_p95_mb
   12        6538.4      12             4204         11208         14882           142.94        381.07
   13        3269.2      41             1204          3410          4802            40.94        115.94
   14        1634.6     142              384          1024          1488            13.06         34.82
   15         817.3     498              104           308           442             3.54         10.47
   16         408.7    1742               30            92           148             1.02          3.13
   17         204.3    5884                9            28            48             0.31          0.95
   18         102.2   18402                3            10            18             0.10          0.34
z12  side  6538.4 m    1 across       3 requests for a 1.2 km view
z15  side   817.3 m    2 across      12 requests for a 1.2 km view
z16  side   408.7 m    3 across      27 requests for a 1.2 km view
z17  side   204.3 m    6 across     108 requests for a 1.2 km view
z18  side   102.2 m   12 across     432 requests for a 1.2 km view
{'zoom': 13, 'sampled': 4000, 'straddling_share': 0.0142}
{'zoom': 16, 'sampled': 4000, 'straddling_share': 0.0904}
{'zoom': 17, 'sampled': 4000, 'straddling_share': 0.1882}
 zoom  p95_mb  requests  straddling  overhead  passes     ok            failing
   15   10.47        12      0.0402     0.104       3  False       [tile_bytes]
   16    3.13        27      0.0904     0.212       4   True                 []
   17    0.95       108      0.1882     0.471       2  False  [straddling, overhead]
{'base_zoom': 15, 'dense_shards_split': 38, 'shards_total': 612,
 'features_max_after': 388, 'features_p95_after': 281}
```

Zoom 16 is the answer for this city: 3 MB at the 95th percentile, 27 requests for a working view, 9% of buildings straddling a boundary and a fifth of the build in overhead. Zoom 15 fails only on dense-shard bytes, which the split in step 6 fixes — and the split grid at base 15 has a 281-feature 95th percentile, which is the better arrangement if rebuild granularity matters less than request count.

Verify the choice against a pilot build rather than against the estimate:

```python
from pathlib import Path

def pilot_verify(tileset_dir, expected_p95_mb, tolerance=1.5):
    sizes = []
    for shard in Path(tileset_dir).glob("*/"):
        total = sum(p.stat().st_size for p in shard.rglob("*") if p.is_file())
        if total:
            sizes.append(total / 1e6)
    sizes = np.array(sizes)
    p95 = float(np.percentile(sizes, 95))
    return {"shards_built": len(sizes), "median_mb": round(float(np.median(sizes)), 2),
            "p95_mb": round(p95, 2), "max_mb": round(float(sizes.max()), 2),
            "estimate_ratio": round(p95 / expected_p95_mb, 2),
            "within_tolerance": p95 <= expected_p95_mb * tolerance}

print(pilot_verify("build/pilot_z16", expected_p95_mb=3.13))
```

The bytes-per-feature figure the estimate rests on is the one most likely to be wrong — textures, metadata and compression all move it — so a pilot of twenty or thirty shards before committing to a grid is worth the hour. A ratio outside about 1.5 means the estimate needs updating and the whole table recomputing, which takes seconds once the real figure is known.

## Performance Notes

- **Compute the grid statistics on centroids, not geometry.** Assigning a million footprints to a grid by centroid takes seconds; doing it by intersection takes minutes and changes nothing about the answer.
- **Sample for the boundary cost.** Four thousand features give a stable straddling share to within a fraction of a percent.
- **Do the pilot at the two candidate zooms**, not at one. The comparison is what makes the decision defensible later.
- **Record the chosen zoom in the tileset metadata**, so a later incremental build cannot silently use a different grid — a mixed-grid tileset with two conventions is very hard to reason about.
- **Revisit the choice when the source changes materially**: a new LOD3 dataset with textures moves bytes per feature by a factor of five, and the previous grid may no longer pass.

## Common Errors

**Shard side lengths are computed without the latitude cosine.** Web Mercator tiles shrink towards the poles, and a zoom-16 tile is 611 m at the equator and 409 m at 48° N. Using the equatorial figure overestimates the features per shard by more than a factor of two.

**Sizing on the median.** The dense shards are the ones users load. Size on the 95th percentile and split the outliers.

**Ignoring per-shard overhead.** A grid that looks ideal on tile bytes can triple the build time. Include the overhead share in the decision.

**Changing the grid without re-merging.** The root tileset references shards by path and geometric error; a new grid invalidates all of it. Rebuild the root, as in the merge guide.

**Assuming one grid for every layer.** Terrain, buildings and point clouds have very different bytes per unit area, and there is no reason for them to share a shard size. Choose per layer and let the merge step reconcile them.

## Frequently Asked Questions

### Should shards align with administrative boundaries instead?

Only if the twin's workflows are administrative — per-district publishing, per-district permissions. Administrative units vary in size by orders of magnitude, which breaks every property this page optimises. A regular grid with a district attribute on each shard usually serves both needs.

### What about implicit tiling — does the shard size still matter?

Yes, for the same reasons: bytes per tile, requests per viewport and rebuild granularity are unchanged. Implicit tiling removes the per-shard JSON, which reduces the overhead term and shifts the workable band one level finer.

### How does this interact with the LOD hierarchy inside a shard?

They are independent. The shard grid decides the horizontal partitioning of the work and the requests; the levels inside each shard decide what a camera loads at distance. A shard holding 100 buildings across three internal levels is a normal arrangement.

## Related Guides

- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — the pipeline this configures
- [Merging Shard Tilesets into a Root Tileset](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/merging-shard-tilesets-into-a-root-tileset/) — assembling whatever grid you chose
- [Orchestrating Tiling Jobs with Dask](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/orchestrating-tiling-jobs-with-dask/) — running the resulting shard list in parallel

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
