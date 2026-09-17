---
title: "GeoPackage vs GeoParquet for Twin Attributes"
description: "Choose a store for a twin's attribute tables: GeoPackage for editing and QGIS, GeoParquet for columnar analytics and cloud reads"
---
# GeoPackage vs GeoParquet for Twin Attributes

This page compares GeoPackage and GeoParquet as the attribute store behind a digital twin — a transactional SQLite container against a columnar cloud-native table — on write patterns, query performance, CRS fidelity, cloud access and tooling, with code that writes both from the same GeoDataFrame in EPSG:25832 and measures the difference.

## Why you hit this

A twin's geometry lives in tiles; its attributes live somewhere else, and that somewhere has to serve two very different consumers. A GIS analyst opens the layer in QGIS, edits a few polygons and expects the change to stick. A pipeline scans two million rows to compute roof areas by district, ideally without downloading two million rows. GeoPackage is excellent at the first and mediocre at the second; GeoParquet is the reverse. Choosing one and living with it is how twins end up either with a slow analytics stack or with a data store nobody can edit. The format landscape is in [3D format standards comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).

## Prerequisites

- Python 3.10+ with `geopandas>=0.14`, `pyarrow>=15`, `shapely>=2.0`, `pyproj>=3.6`, and optionally `duckdb>=1.0` with its spatial extension.
- GDAL 3.8+ if you use `ogr2ogr` for conversion; it reads and writes both.
- A layer with a few hundred thousand rows to make the measurements meaningful — the examples use building attributes joined to footprints in EPSG:25832.

## The Structural Difference

**GeoPackage** is a SQLite database with OGC-specified tables: `gpkg_contents` lists the layers, `gpkg_spatial_ref_sys` holds the CRS definitions, each feature table has a geometry column in a binary GeoPackage encoding, and an R-tree index accelerates spatial queries. Because it is SQLite, it supports transactions, `UPDATE`, concurrent readers with one writer, and arbitrary SQL — including joins between feature tables and plain attribute tables in the same file.

**GeoParquet** is Apache Parquet with a `geo` key in the file metadata. Geometry is a column of WKB (or, in newer profiles, a native nested encoding), the CRS is stored as PROJJSON, and the file is columnar: values of one column are stored together, compressed per column, grouped into row groups with per-group statistics. There is no index and no update; a "change" writes a new file. What it buys is that a query reading three of forty columns reads three columns' worth of bytes, and a query filtered on a bounding box can skip whole row groups using their statistics.

<figure class="diagram">
<svg viewBox="6 10 748 268" role="img" aria-labelledby="gpq-layout-t gpq-layout-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gpq-layout-t">Row storage against columnar storage</title>
  <desc id="gpq-layout-d">On the left, a GeoPackage stores each feature's fields together as a row, so reading one column still touches every row's bytes, and an R-tree index points at rows. On the right, GeoParquet stores each column contiguously in row groups with per-group statistics, so a query on three columns reads only those columns and can skip groups whose statistics exclude them.</desc>
  <rect class="svg-bg" x="6" y="10" width="748" height="268" fill="#ffffff"/>
  <rect x="20" y="24" width="340" height="220" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="400" y="24" width="340" height="220" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="1.2">
    <rect x="50" y="70" width="280" height="24" fill="#ffffff"/>
    <rect x="50" y="98" width="280" height="24" fill="#ffffff"/>
    <rect x="50" y="126" width="280" height="24" fill="#ffffff"/>
    <rect x="50" y="154" width="280" height="24" fill="#ffffff"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M120 70 V178 M190 70 V178 M260 70 V178"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.2">
    <rect x="430" y="70" width="60" height="108" fill="#ffffff"/>
    <rect x="495" y="70" width="60" height="108" fill="#ffffff"/>
    <rect x="560" y="70" width="60" height="108" fill="#fdf3e0"/>
    <rect x="625" y="70" width="60" height="108" fill="#fdf3e0"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M430 106 H685 M430 142 H685"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="48">GeoPackage: rows</text>
    <text x="570" y="48">GeoParquet: columns in row groups</text>
    <text x="190" y="200">one feature = one contiguous row</text>
    <text x="190" y="222">R-tree index, transactions, UPDATE</text>
    <text x="570" y="200">read only the columns you need</text>
    <text x="570" y="222">row-group statistics skip whole blocks</text>
  </g>
  <text x="380" y="260" fill="#15384a" font-size="12" text-anchor="middle">Shaded columns are the ones a query touches; the unshaded ones are never read.</text>
</svg>
<figcaption>The layouts optimise opposite operations: editing one feature, and scanning one attribute across millions of features.</figcaption>
</figure>

## Writing Both From the Same Source

```python
import time
from pathlib import Path

import geopandas as gpd

gdf = gpd.read_file("source/buildings.gpkg", layer="buildings")
print(f"{len(gdf):,} rows, {len(gdf.columns) - 1} attributes, CRS {gdf.crs.to_epsg()}")

out = Path("build/attributes"); out.mkdir(parents=True, exist_ok=True)

t0 = time.perf_counter()
gdf.to_file(out / "buildings.gpkg", layer="buildings", driver="GPKG")
gpkg_write = time.perf_counter() - t0

t0 = time.perf_counter()
gdf.to_parquet(out / "buildings.parquet", index=False,
               compression="zstd", geometry_encoding="WKB",
               write_covering_bbox=True)          # GeoParquet 1.1 bbox covering columns
parquet_write = time.perf_counter() - t0

sizes = {p.name: p.stat().st_size / 1e6 for p in out.iterdir()}
print(f"write: gpkg {gpkg_write:.1f}s, parquet {parquet_write:.1f}s; sizes (MB) {sizes}")
```

`write_covering_bbox=True` is the option worth knowing. GeoParquet 1.1 allows a struct column holding each geometry's bounding box, and readers use it together with row-group statistics to skip blocks that cannot intersect a query extent. Without it, a spatial filter on a Parquet file has to decode every WKB geometry — which is the source of most "Parquet is slow for spatial" impressions.

## Reading: Where Each Wins

```python
import geopandas as gpd

BBOX = (691000, 5335000, 692000, 5336000)     # EPSG:25832

def time_it(label, fn, repeats=3):
    best = min(_timed(fn) for _ in range(repeats))
    print(f"{label:<44}{best * 1000:8.0f} ms")
    return best

def _timed(fn):
    t0 = time.perf_counter()
    fn()
    return time.perf_counter() - t0

time_it("gpkg: spatial filter, all columns",
        lambda: gpd.read_file(out / "buildings.gpkg", layer="buildings", bbox=BBOX))
time_it("parquet: spatial filter, all columns",
        lambda: gpd.read_parquet(out / "buildings.parquet", bbox=BBOX))
time_it("gpkg: two columns, no filter",
        lambda: gpd.read_file(out / "buildings.gpkg", layer="buildings",
                              columns=["building_id", "measuredHeight"]))
time_it("parquet: two columns, no filter",
        lambda: gpd.read_parquet(out / "buildings.parquet",
                                 columns=["building_id", "measuredHeight"]))
```

The pattern that emerges is consistent across datasets. A small spatial window favours GeoPackage, because its R-tree index finds the rows immediately and the rows are small. A full-table scan of a few columns favours GeoParquet by a wide margin, because it never reads the other columns or the geometry. A full-table scan *including* geometry is roughly even, dominated by WKB decoding in both.

<figure class="diagram">
<svg viewBox="6 6 748 254" role="img" aria-labelledby="gpq-query-t gpq-query-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gpq-query-t">Which store wins which query</title>
  <desc id="gpq-query-d">A table of query patterns. A small bounding-box window favours GeoPackage through its R-tree. Editing a single feature is only possible in GeoPackage. A scan of two columns over millions of rows favours GeoParquet heavily. An aggregate by district favours GeoParquet. A join to a non-spatial table favours GeoPackage because SQL is available in the same file. A cloud read of a subset favours GeoParquet through range requests.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="254" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="380" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="400" y="20" width="170" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="570" y="20" width="170" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="54" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="570" y="54" width="170" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="86" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="86" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="570" y="86" width="170" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="118" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="118" width="170" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="570" y="118" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="150" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="150" width="170" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="570" y="150" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="182" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="182" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="570" y="182" width="170" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="214" width="380" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="400" y="214" width="170" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="570" y="214" width="170" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="210" y="43">query</text><text x="485" y="43">GeoPackage</text><text x="655" y="43">GeoParquet</text>
    <text x="210" y="75">small bounding-box window</text><text x="485" y="75">fast (R-tree)</text><text x="655" y="75">fair (bbox covering)</text>
    <text x="210" y="107">edit one feature</text><text x="485" y="107">yes</text><text x="655" y="107">rewrite the file</text>
    <text x="210" y="139">scan two columns of 2 M rows</text><text x="485" y="139">slow</text><text x="655" y="139">fast</text>
    <text x="210" y="171">aggregate by district</text><text x="485" y="171">fair (SQL)</text><text x="655" y="171">fast</text>
    <text x="210" y="203">join to a non-spatial table</text><text x="485" y="203">SQL in the same file</text><text x="655" y="203">needs an engine</text>
    <text x="210" y="235">read a subset from object storage</text><text x="485" y="235">download it all</text><text x="655" y="235">range requests</text>
  </g>
</svg>
<figcaption>No row is close: each store is decisively better at some queries, which is why twins with both workloads keep both.</figcaption>
</figure>

## CRS Fidelity

Both formats can carry a compound CRS, and both are routinely written without one.

```python
import json

import pyarrow.parquet as pq
from pyproj import CRS

def parquet_crs(path):
    meta = pq.read_schema(path).metadata[b"geo"]
    geo = json.loads(meta)
    col = geo["columns"][geo["primary_column"]]
    crs = CRS.from_json_dict(col["crs"]) if col.get("crs") else None
    return {
        "geoparquet_version": geo.get("version"),
        "encoding": col.get("encoding"),
        "crs": crs.to_string() if crs else None,
        "is_compound": bool(crs and len(crs.sub_crs_list) > 1) if crs else False,
        "covering": bool(col.get("covering")),
        "geometry_types": col.get("geometry_types"),
    }

def gpkg_crs(path, layer="buildings"):
    import sqlite3
    con = sqlite3.connect(path)
    row = con.execute("""
        SELECT s.srs_id, s.organization, s.organization_coordsys_id, s.definition
        FROM gpkg_contents c JOIN gpkg_spatial_ref_sys s ON c.srs_id = s.srs_id
        WHERE c.table_name = ?""", (layer,)).fetchone()
    con.close()
    crs = CRS.from_wkt(row[3]) if row else None
    return {"srs_id": row[0] if row else None,
            "authority": f"{row[1]}:{row[2]}" if row else None,
            "is_compound": bool(crs and len(crs.sub_crs_list) > 1) if crs else False}

print(parquet_crs("build/attributes/buildings.parquet"))
print(gpkg_crs("build/attributes/buildings.gpkg"))
```

GeoParquet stores PROJJSON, which round-trips a compound CRS faithfully, and GeoPackage stores a WKT definition plus an authority code, which also handles compound systems in recent GDAL versions. The practical risk is the same in both: a writer that only had a horizontal CRS to hand records only that, and the heights in the table become ambiguous. Asserting the compound code after writing is the fix, as in [asserting CRS and units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/).

## Querying GeoParquet Without Loading It

```python
import duckdb

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
rows = con.execute("""
    SELECT district,
           count(*) AS buildings,
           round(avg(measuredHeight), 1) AS mean_height,
           round(sum(ST_Area(geometry)) / 1e4, 1) AS footprint_ha
    FROM read_parquet('build/attributes/buildings.parquet')
    WHERE yearOfConstruction < 1945
    GROUP BY district
    ORDER BY buildings DESC
    LIMIT 5
""").fetchall()
for r in rows:
    print(r)
```

This is the capability that decides the choice for analytics: the query reads four columns out of forty, skips row groups whose statistics rule them out, and never materialises a GeoDataFrame. The same query against a GeoPackage is valid SQL and reads every row. Against a Parquet file on object storage, DuckDB issues range requests and transfers a fraction of the file — which is why cloud-hosted twin attribute tables have largely moved to this shape.

<figure class="diagram">
<svg viewBox="-10 20 759 218" role="img" aria-labelledby="gpq-bars-t gpq-bars-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gpq-bars-t">Size and scan time for 1.8 million building rows</title>
  <desc id="gpq-bars-d">Bars comparing the two stores on the same table. On disk, the GeoPackage is about 1,184 megabytes and the zstd-compressed Parquet about 269 megabytes. Scanning two columns takes about 21 seconds from the GeoPackage and under one second from Parquet. A small bounding-box window is faster from the GeoPackage at about 0.4 seconds against 0.7.</desc>
  <rect class="svg-bg" x="-10" y="20" width="759" height="218" fill="#ffffff"/>
  <path d="M150 24 V200" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="150" y="34" width="520" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="62" width="118" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="150" y="104" width="520" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="132" width="21" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="150" y="172" width="120" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="200" width="200" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="4" y="51">size: gpkg</text>
    <text x="4" y="79">size: parquet</text>
    <text x="4" y="121">2-col scan: gpkg</text>
    <text x="4" y="149">2-col scan: parquet</text>
    <text x="4" y="189">bbox window: gpkg</text>
    <text x="4" y="217">bbox: parquet</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="682" y="51">1,184 MB</text>
    <text x="280" y="79">269 MB</text>
    <text x="682" y="121">21.4 s</text>
    <text x="183" y="149">0.84 s</text>
    <text x="282" y="189">0.41 s</text>
    <text x="362" y="217">0.69 s</text>
  </g>
</svg>
<figcaption>Bar lengths are not comparable across the three measurements; within each pair, the shorter bar is the better result.</figcaption>
</figure>

## Migrating Between Them

```python
import subprocess

# GeoPackage → GeoParquet, keeping the layer's CRS
subprocess.run(["ogr2ogr", "-f", "Parquet",
                "build/attributes/from_gpkg.parquet",
                "build/attributes/buildings.gpkg", "buildings",
                "-lco", "COMPRESSION=ZSTD",
                "-lco", "GEOMETRY_ENCODING=WKB"], check=True)

# GeoParquet → GeoPackage for editing in QGIS
subprocess.run(["ogr2ogr", "-f", "GPKG",
                "build/attributes/for_editing.gpkg",
                "build/attributes/buildings.parquet",
                "-nln", "buildings"], check=True)
```

Both directions are lossless for geometry and attributes, which makes the migration question less loaded than it looks: a twin can keep GeoParquet as the analytical store and generate a GeoPackage extract whenever someone needs to edit, then fold the edits back. What does not survive is GeoPackage-specific machinery — triggers, views, custom SQL, styling tables — so a workflow that lives inside a GeoPackage's SQL is not portable.

## Expected Output & Verification

```text
1,842,204 rows, 38 attributes, CRS 25832
write: gpkg 71.4s, parquet 9.8s; sizes (MB) {'buildings.gpkg': 1184.2, 'buildings.parquet': 268.7}
gpkg: spatial filter, all columns                    412 ms
parquet: spatial filter, all columns                 690 ms
gpkg: two columns, no filter                       21400 ms
parquet: two columns, no filter                      840 ms
{'geoparquet_version': '1.1.0', 'encoding': 'WKB', 'crs': 'EPSG:25832', 'is_compound': False,
 'covering': True, 'geometry_types': ['Polygon', 'MultiPolygon']}
{'srs_id': 25832, 'authority': 'EPSG:25832', 'is_compound': False}
```

Two things in that output deserve attention. Parquet is four times smaller and seven times faster to write, which is typical for wide attribute tables with repetitive values. And both stores report `is_compound: False` — the source had a horizontal CRS only, so the heights in this table have no declared datum, which is a finding to fix rather than a curiosity.

Verify a migration preserved the data rather than assuming it:

```python
a = gpd.read_file("build/attributes/buildings.gpkg", layer="buildings")
b = gpd.read_parquet("build/attributes/buildings.parquet")

assert len(a) == len(b), f"row count changed: {len(a)} vs {len(b)}"
assert set(a.columns) == set(b.columns), f"columns differ: {set(a.columns) ^ set(b.columns)}"
assert a.crs == b.crs, "CRS changed in migration"
num = [c for c in a.select_dtypes("number").columns]
for c in num:
    assert abs(a[c].sum(skipna=True) - b[c].sum(skipna=True)) < 1e-6 * max(abs(a[c].sum()), 1)
areas = (a.geometry.area.sum(), b.geometry.area.sum())
print(f"row counts, columns, CRS and numeric sums match; total area {areas[0]:.1f} vs {areas[1]:.1f}")
assert abs(areas[0] - areas[1]) < 1e-3 * areas[0]
```

Comparing numeric column sums and total geometry area catches the failures a row count misses: a column that came through as strings, or geometries that lost their inner rings.

## Common Errors

**A GeoParquet spatial filter is slower than expected.** The file has no covering bbox column, so every geometry is decoded. Rewrite with `write_covering_bbox=True`, and sort rows spatially before writing so row-group statistics are selective.

**Row groups are the whole file.** A Parquet file written as one row group cannot skip anything. Aim for row groups of a few hundred thousand rows, and sort by a spatial key — a quadkey or a Hilbert index — so nearby features share groups.

**Editing a GeoPackage while a pipeline reads it.** SQLite allows one writer and many readers, but a long-running write locks the file. Snapshot for reading, or move the editing copy aside.

**`Mixed geometry types are not supported`.** Some Parquet writers reject a column with both polygons and points. Split by geometry type into separate files, which is also better for the analytics that follow.

## Frequently Asked Questions

### Which should be the twin's system of record?

Neither, strictly — the system of record is usually a database (PostGIS) or the register the data came from. Of the two file formats, GeoParquet is the better archival and analytical copy, and GeoPackage is the better working and exchange copy.

### Is GeoPackage obsolete?

No. It is the format every desktop GIS opens, it supports editing and it is a single portable file. For hand-over, field work and anything a human will open, it remains the right choice.

### Can GeoParquet be partitioned?

Yes, using directory-based partitioning — for example by district or by tile — which lets a query skip whole directories. That is how city-scale attribute tables stay queryable, and it pairs naturally with the shard grid a tiling pipeline already uses.

### What about FlatGeobuf?

It sits between the two: streamable, indexed, single-file, good for serving features over HTTP. For a twin's attribute analytics it lacks the columnar advantage; for serving vector features to a client it is a reasonable choice.

## Related Guides

- [IFC vs CityGML for Building Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/ifc-vs-citygml-for-building-twins/) — where the attributes come from
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the CRS assertion this page recommends
- [Serving Tile Lookups from PostGIS](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/serving-tile-lookups-from-postgis/) — the database option for the same job

Back to [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
