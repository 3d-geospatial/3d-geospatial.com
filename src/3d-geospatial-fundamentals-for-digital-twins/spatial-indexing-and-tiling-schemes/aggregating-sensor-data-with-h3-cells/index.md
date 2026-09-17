---
title: "Aggregating Sensor Data with H3 Cells"
description: "Bin twin sensor readings into H3 hexagons: choose a resolution, aggregate per cell and hour, handle the non-nesting hierarchy and render the result over 3D"
---
# Aggregating Sensor Data with H3 Cells

This page aggregates a digital twin's sensor readings into H3 hexagonal cells — choosing a resolution from the sensor spacing rather than by habit, binning and aggregating per cell and time bucket, coarsening through the hierarchy for zoomed-out views, and rendering the result as an overlay on the tiled city, with source coordinates in EPSG:25832 converted to WGS84 for indexing.

## Why you hit this

A twin with ten thousand sensors — traffic counters, air quality, noise, occupancy, temperature — cannot show them as ten thousand markers, and their raw positions are not what anybody asks about. The questions are aggregate and spatial: which streets are loudest between seven and nine, where does particulate matter exceed a threshold, how does occupancy vary by district. Binning into a fixed cell system answers all of them with one aggregation, and H3's hexagons have the property that matters for this: every neighbour is the same distance away, so a diffusion, a gradient or a neighbourhood average behaves consistently in all directions. The alternatives are compared in [choosing between S2, H3 and geohash for 3D data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/choosing-between-s2-h3-and-geohash-for-3d-data/).

## Prerequisites

- Python 3.10+ with `h3>=4.0`, `pandas>=2.0`, `geopandas>=0.14`, `pyproj>=3.6`, `shapely>=2.0`.
- Sensor readings with a position, a timestamp and a value. Positions in a projected CRS need converting to WGS84, because H3 indexes latitude and longitude.
- A sense of the sensor spacing and of the smallest area a reading should be attributed to — both feed the resolution choice.

## Step-by-Step

### 1. Choose the resolution from the sensor spacing

```python
import h3

def resolution_table(resolutions=range(7, 14)):
    rows = []
    for r in resolutions:
        area_m2 = h3.average_hexagon_area(r, unit="m^2")
        edge_m = h3.average_hexagon_edge_length(r, unit="m")
        rows.append({"resolution": r,
                     "avg_area_m2": round(area_m2, 1),
                     "avg_edge_m": round(edge_m, 1),
                     "cells_per_km2": round(1e6 / area_m2, 1)})
    return rows

for row in resolution_table():
    print(f"res {row['resolution']:>2}  area {row['avg_area_m2']:>12,.1f} m²  "
          f"edge {row['avg_edge_m']:>8.1f} m  {row['cells_per_km2']:>8.1f} cells/km²")
```

The rule that works is to pick the resolution whose edge length is close to the sensor spacing. Cells much smaller than the spacing are mostly empty, so the map becomes a scatter of isolated hexagons; cells much larger average away the variation the sensors were installed to measure. For traffic counters every 200–400 m along streets, resolution 9 or 10 is right; for air quality stations several kilometres apart, resolution 7; for indoor occupancy sensors, resolution 13 or finer.

### 2. Index the readings

```python
import pandas as pd
from pyproj import Transformer

to_wgs84 = Transformer.from_crs(25832, 4326, always_xy=True)
RES = 10

def index_readings(df, res=RES):
    lon, lat = to_wgs84.transform(df["easting"].to_numpy(), df["northing"].to_numpy())
    df = df.assign(lon=lon, lat=lat)
    df["cell"] = [h3.latlng_to_cell(la, lo, res) for la, lo in zip(lat, lon)]
    return df

readings = pd.read_parquet("data/noise_readings_2026-09.parquet")
readings = index_readings(readings)
print(f"{len(readings):,} readings, {readings['cell'].nunique():,} distinct cells at res {RES}")
print(readings.head(3)[["sensor_id", "timestamp", "value_db", "cell"]])
```

H3 takes latitude first and longitude second, which is the opposite order from most projected-coordinate code and the source of a good share of H3 bugs: swap them and every reading lands in the Indian Ocean or the Sahara, both of which are conveniently far from any plausible city and therefore obvious. Less obvious is a partial swap in one code path, which puts a subset of readings somewhere implausible while the rest are fine.

### 3. Aggregate per cell and time bucket

```python
def aggregate(df, freq="1h", value="value_db"):
    df = df.copy()
    df["bucket"] = pd.to_datetime(df["timestamp"]).dt.floor(freq)
    grouped = df.groupby(["cell", "bucket"]).agg(
        n=(value, "size"),
        mean=(value, "mean"),
        p95=(value, lambda s: s.quantile(0.95)),
        max=(value, "max"),
        sensors=("sensor_id", "nunique"),
    ).reset_index()
    grouped["mean"] = grouped["mean"].round(2)
    grouped["p95"] = grouped["p95"].round(2)
    return grouped

agg = aggregate(readings)
print(agg.sort_values("p95", ascending=False).head(5))
print(f"{len(agg):,} cell-hour rows")
```

Keeping the sensor count per cell alongside the statistics is what makes the result honest. A cell with one sensor and a mean of 71 dB reports that sensor; a cell with six sensors and the same mean reports a neighbourhood. Rendering both identically invites a reader to over-interpret the first, and a map that greys out single-sensor cells at coarse resolutions is usually the right presentation.

### 4. Coarsen carefully: the hierarchy does not nest exactly

```python
def coarsen(agg, from_res=RES, to_res=8):
    a = agg.copy()
    a["parent"] = [h3.cell_to_parent(c, to_res) for c in a["cell"]]
    out = a.groupby(["parent", "bucket"]).agg(
        n=("n", "sum"),
        mean=("mean", "mean"),               # unweighted: see the caveat below
        weighted_mean=("mean", lambda s: None),
        p95=("p95", "max"),
        child_cells=("cell", "nunique"),
    ).reset_index()
    # weight the mean by reading count, which the naive mean of means does not
    wm = (a.assign(prod=a["mean"] * a["n"]).groupby(["parent", "bucket"])
            .agg(num=("prod", "sum"), den=("n", "sum")).reset_index())
    out = out.merge(wm, on=["parent", "bucket"])
    out["weighted_mean"] = (out["num"] / out["den"]).round(2)
    return out.drop(columns=["num", "den"])

coarse = coarsen(agg)
print(coarse.sort_values("n", ascending=False).head(4))
```

Two traps live in that function. The first is the mean of means, which is wrong whenever cells have different reading counts — the weighted version is one extra group-by and is the number to publish. The second is H3's hierarchy itself: hexagons cannot tile a hexagon, so a resolution-9 cell is *not* exactly the union of seven resolution-10 cells. `cell_to_parent` gives the cell whose centre contains the child's centre, and a child straddling a parent boundary is assigned wholly to one parent. For aggregation of point readings that is harmless; for aggregating *areas* — a land-cover share, a footprint total — it introduces an error of a few percent per level, and the right approach there is to re-aggregate from the source rather than to roll up.

<figure class="diagram">
<svg viewBox="110 23 574 233" role="img" aria-labelledby="h3-nest-t h3-nest-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h3-nest-t">Why H3 parents and children do not nest exactly</title>
  <desc id="h3-nest-d">A coarse hexagon overlaid with the seven finer hexagons whose centres fall inside it. The finer cells cover most of the parent and spill over its edges, and slivers of the parent are covered by cells assigned to neighbouring parents. Point readings are unaffected because each point has one cell at each resolution, while area quantities acquire a few percent of error per level.</desc>
  <rect class="svg-bg" x="110" y="23" width="574" height="233" fill="#ffffff"/>
  <path d="M250 40 L370 40 L430 125 L370 210 L250 210 L190 125 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="none" stroke="#4f7a4d" stroke-width="1.6">
    <path d="M292 95 L328 95 L346 125 L328 155 L292 155 L274 125 Z"/>
    <path d="M292 37 L328 37 L346 67 L328 97 L292 97 L274 67 Z"/>
    <path d="M292 153 L328 153 L346 183 L328 213 L292 213 L274 183 Z"/>
    <path d="M232 66 L268 66 L286 96 L268 126 L232 126 L214 96 Z"/>
    <path d="M232 124 L268 124 L286 154 L268 184 L232 184 L214 154 Z"/>
    <path d="M352 66 L388 66 L406 96 L388 126 L352 126 L334 96 Z"/>
    <path d="M352 124 L388 124 L406 154 L388 184 L352 184 L334 154 Z"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="470" y="70">a parent hexagon and the seven</text>
    <text x="470" y="92">children whose centres it contains</text>
    <text x="470" y="126">children spill outside the parent;</text>
    <text x="470" y="148">slivers belong to neighbours</text>
    <text x="470" y="182">points: exact at every resolution</text>
    <text x="470" y="204">areas: a few percent per level</text>
  </g>
  <text x="310" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Roll up point counts freely; re-aggregate areas from the source.</text>
</svg>
<figcaption>The hierarchy is approximate by construction, which is a property to plan around rather than a bug to work around.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="-4 56 768 162" role="img" aria-labelledby="h3-flow-t h3-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h3-flow-t">From readings to an overlay</title>
  <desc id="h3-flow-d">Readings with projected coordinates are transformed to longitude and latitude, indexed to cells at the working resolution, aggregated per cell and hour with a sensor count, optionally coarsened for zoomed-out views, converted to hexagon polygons and rendered as an extruded overlay on the tiled city. Area quantities are re-aggregated from the readings rather than rolled up.</desc>
  <rect class="svg-bg" x="-4" y="56" width="768" height="162" fill="#ffffff"/>
  <defs>
    <marker id="h3-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="70" width="110" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="70" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="300" y="70" width="140" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="470" y="70" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="620" y="70" width="130" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="160" width="290" height="44" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#h3-flow-arrow)">
    <path d="M120 98 H148"/><path d="M270 98 H298"/><path d="M440 98 H468"/><path d="M590 98 H618"/>
    <path d="M370 158 V128"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="94">readings</text><text x="65" y="112">E, N, value</text>
    <text x="210" y="94">to lat/lon,</text><text x="210" y="112">index at res 10</text>
    <text x="370" y="94">aggregate per</text><text x="370" y="112">cell and hour</text>
    <text x="530" y="94">coarsen for</text><text x="530" y="112">zoomed views</text>
    <text x="685" y="94">hexagon</text><text x="685" y="112">overlay</text>
    <text x="445" y="180">area quantities: re-aggregate from readings,</text>
    <text x="445" y="198">never roll up through the hierarchy</text>
  </g>
</svg>
<figcaption>One indexing pass serves every later view; the only branch is whether a quantity may be rolled up or must be recomputed.</figcaption>
</figure>

### 5. Turn cells into geometry for the overlay

```python
import geopandas as gpd
from shapely.geometry import Polygon

def cells_to_gdf(rows, cell_col="cell", crs=4326):
    geoms, records = [], []
    for row in rows.itertuples(index=False):
        cell = getattr(row, cell_col)
        boundary = h3.cell_to_boundary(cell)             # [(lat, lon), …]
        geoms.append(Polygon([(lon, lat) for lat, lon in boundary]))
        records.append(row._asdict())
    gdf = gpd.GeoDataFrame(records, geometry=geoms, crs=crs)
    gdf["area_m2"] = gdf.to_crs(25832).geometry.area.round(1)
    return gdf

peak = agg[agg["bucket"] == agg["bucket"].max()]
hexes = cells_to_gdf(peak)
hexes.to_file("web/noise_hex_res10.geojson", driver="GeoJSON")
print(hexes[["cell", "n", "mean", "p95", "area_m2"]].head(4))
print(f"area range {hexes['area_m2'].min():,.0f}–{hexes['area_m2'].max():,.0f} m²")
```

`cell_to_boundary` returns latitude-longitude pairs, so building a Shapely polygon needs them reversed — the same order trap as indexing, in the opposite direction. The area range printed at the end is worth looking at once: H3 cells vary in area with latitude and position within the icosahedral face, typically by a few percent within a city and much more across a country. Any per-area quantity — a density, a rate per hectare — has to divide by each cell's own area rather than by the resolution's average.

### 6. Render it over the tiled city

```javascript
const hexes = await Cesium.GeoJsonDataSource.load("/web/noise_hex_res10.geojson", {
  clampToGround: false,
});
viewer.dataSources.add(hexes);

const ramp = [[55, "#1f6b8a"], [60, "#4f7a4d"], [65, "#c46a3d"], [70, "#b0413e"]];
for (const entity of hexes.entities.values) {
  const p95 = entity.properties.p95.getValue();
  const stop = ramp.findLast(([threshold]) => p95 >= threshold) ?? ramp[0];
  entity.polygon.material = Cesium.Color.fromCssColorString(stop[1]).withAlpha(0.55);
  entity.polygon.extrudedHeight = 4 + (p95 - 50) * 2.5;      // exaggerate for readability
  entity.polygon.height = 0;
  entity.polygon.outline = false;
}
```

Extruding the hexagons by the value turns the overlay into a readable surface over the city rather than a flat choropleth competing with the buildings for attention. Stating the exaggeration in the legend matters, because a 60 m tall hexagon representing 68 dB will otherwise be read as a building.

For a layer that changes continuously — live sensor feeds rather than an hourly aggregate — the geometry should be built once and only the values updated, as in [streaming live sensor updates onto tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/).

<figure class="diagram">
<svg viewBox="16 26 728 232" role="img" aria-labelledby="h3-res-t h3-res-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h3-res-t">Matching resolution to sensor spacing</title>
  <desc id="h3-res-d">Three panels of the same street network. At resolution 8, with cells about 1.2 kilometres across, all sensors fall into two cells and the variation is averaged away. At resolution 10, with cells about 130 metres across, each cell holds one to three sensors and street-level variation is visible. At resolution 13, with cells nine metres across, almost every cell is empty and the map is a scatter of dots.</desc>
  <rect class="svg-bg" x="16" y="26" width="728" height="232" fill="#ffffff"/>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M30 60 H230 M30 110 H230 M30 160 H230 M80 40 V190 M150 40 V190"/>
    <path d="M280 60 H480 M280 110 H480 M280 160 H480 M330 40 V190 M400 40 V190"/>
    <path d="M530 60 H730 M530 110 H730 M530 160 H730 M580 40 V190 M650 40 V190"/>
  </g>
  <path d="M60 60 L170 60 L200 115 L170 170 L60 170 L30 115 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2" fill-opacity="0.5"/>
  <g fill="none" stroke="#4f7a4d" stroke-width="1.6">
    <path d="M300 70 L330 70 L345 95 L330 120 L300 120 L285 95 Z"/>
    <path d="M345 70 L375 70 L390 95 L375 120 L345 120 L330 95 Z"/>
    <path d="M322 120 L352 120 L367 145 L352 170 L322 170 L307 145 Z"/>
    <path d="M390 95 L420 95 L435 120 L420 145 L390 145 L375 120 Z"/>
  </g>
  <g fill="#c46a3d">
    <circle cx="560" cy="62" r="3"/><circle cx="600" cy="110" r="3"/><circle cx="660" cy="86" r="3"/><circle cx="700" cy="158" r="3"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="212">res 8: one cell, no variation</text>
    <text x="380" y="212">res 10: street-level variation</text>
    <text x="630" y="212">res 13: mostly empty</text>
  </g>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">The useful resolution has an edge length close to the sensor spacing.</text>
</svg>
<figcaption>Resolution is not a quality setting: too fine is as unreadable as too coarse, and the sensor spacing decides which is which.</figcaption>
</figure>

## Expected Output & Verification

```text
res  7  area    5,161,293.4 m²  edge  1406.5 m       0.2 cells/km²
res  8  area      737,327.6 m²  edge   531.4 m       1.4 cells/km²
res  9  area      105,332.5 m²  edge   200.8 m       9.5 cells/km²
res 10  area       15,047.5 m²  edge    75.9 m      66.5 cells/km²
res 11  area        2,149.6 m²  edge    28.7 m     465.2 cells/km²
res 12  area          307.1 m²  edge    10.8 m   3,256.2 cells/km²
res 13  area           43.9 m²  edge     4.1 m  22,793.6 cells/km²
1,204,882 readings, 3,118 distinct cells at res 10
        cell              bucket   n   mean    p95   max  sensors
0  8a1fb46622dffff 2026-09-15 08:00  84  71.42  78.10  81.2        3
3,118 distinct cells at res 10
104,204 cell-hour rows
area range 14,802–15,244 m²
```

Verify the indexing before trusting any aggregate, because a coordinate-order error produces a perfectly consistent map of the wrong place:

```python
def verify_indexing(df, res=RES, sample=2000, tolerance_m=200.0):
    from pyproj import Geod
    geod = Geod(ellps="WGS84")
    s = df.sample(min(sample, len(df)), random_state=7)
    dists = []
    for row in s.itertuples(index=False):
        lat_c, lon_c = h3.cell_to_latlng(row.cell)
        _, _, d = geod.inv(row.lon, row.lat, lon_c, lat_c)
        dists.append(d)
    dists = pd.Series(dists)
    return {"checked": len(dists), "max_offset_m": round(float(dists.max()), 1),
             "median_offset_m": round(float(dists.median()), 1),
             "within_cell": bool(dists.max() < tolerance_m)}

check = verify_indexing(readings)
print(check)
assert check["within_cell"], "readings are not inside their cells: latitude/longitude swapped?"
```

Every reading must lie within its own cell, so the distance from the reading to its cell centre cannot exceed the cell's circumradius — about 76 m at resolution 10. A median offset of thousands of kilometres is the swapped-order bug; an offset of a few hundred metres on some readings means those were indexed at a different resolution.

Then verify the aggregation preserves the data:

```python
assert int(agg["n"].sum()) == len(readings), "readings lost in aggregation"
recomputed = (readings.assign(bucket=pd.to_datetime(readings["timestamp"]).dt.floor("1h"))
              .groupby(["cell", "bucket"])["value_db"].mean().round(2))
merged = agg.set_index(["cell", "bucket"])["mean"]
assert merged.sub(recomputed).abs().max() < 0.011, "aggregated means do not reproduce"
print("aggregation reproduces the source readings")
```

## Performance Notes

- **Indexing is about a microsecond per point** in the C-backed library, so a million readings index in a second or two. Vectorise by list comprehension rather than `apply`, which is several times slower.
- **Aggregate in the database when the data lives there.** DuckDB and PostGIS both have H3 extensions, and grouping ten million rows in SQL beats moving them into pandas.
- **Store the cell as a string or a 64-bit integer, not both.** The integer form is half the size and sorts usefully; the string form is what most APIs expect. Pick one for storage and convert at the edges.
- **Pre-compute the boundary geometry per cell once** and cache it: it is fixed for a given cell, and re-deriving it per render is wasted work.
- **Coarsen from the source for area quantities**, from the aggregate for counts and means. The first is correct and slower; the second is fast and approximate.

## Common Errors

**Every reading lands in the ocean.** Latitude and longitude were passed in the wrong order. H3 takes latitude first.

**Cell areas differ from the resolution's average.** Expected: H3 cells vary in area. Divide by each cell's own area for any per-area statistic.

**A coarse view shows higher values than any fine cell.** The coarse layer used `max` of the children's `p95`, which is a legitimate choice and not the same statistic as the parent's own p95. Name the statistic in the legend.

**Twelve pentagons behave oddly.** H3 has twelve pentagonal cells per resolution, inherited from the icosahedron, and they have five neighbours instead of six. Any neighbourhood computation has to tolerate that; `grid_disk` does it correctly, and hand-rolled neighbour arithmetic does not.

**Counts do not add up after a roll-up.** Cells were rolled up twice, or a cell straddling a parent boundary was double-counted by a manual containment test. Use `cell_to_parent`, which assigns each child to exactly one parent.

## Frequently Asked Questions

### H3 or a square grid?

H3 for anything involving neighbourhoods, flow or diffusion, because all six neighbours are equidistant. A square grid — or the quadkey scheme the tiling already uses — for anything that has to align with tiles, imagery or existing raster products. Mixing them in one twin is normal: hexagons for analysis, quadkeys for delivery.

### Can H3 index three dimensions?

No. It is a surface tessellation, so a sensor at street level and one on a roof in the same hexagon share a cell. Where the vertical matters, carry the height as an attribute and bin it separately, or use a 3D scheme as discussed in [octree indexing point clouds with Morton codes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/octree-indexing-point-clouds-with-morton-codes/).

### How do I join hexagon aggregates to buildings?

By spatial join, not by cell arithmetic: a building can overlap several cells, and attributing it to the cell containing its centroid is a choice worth stating. For per-building values, aggregate to buildings directly and use hexagons only for the area view.

## Related Guides

- [Choosing Between S2, H3 and Geohash for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/choosing-between-s2-h3-and-geohash-for-3d-data/) — why hexagons, and when not
- [Serving Tile Lookups from PostGIS](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/serving-tile-lookups-from-postgis/) — doing the aggregation in the database
- [Rendering Thousands of Labels and Billboards](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/rendering-thousands-of-labels-and-billboards/) — the alternative when individual sensors must be shown

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
