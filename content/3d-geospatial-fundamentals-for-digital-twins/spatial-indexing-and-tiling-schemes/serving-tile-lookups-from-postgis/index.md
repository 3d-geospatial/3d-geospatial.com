# Serving Tile Lookups from PostGIS

This page builds the lookup service behind a twin's viewer — a PostGIS schema keyed by quadkey with GiST indexes over 3D bounding boxes, queries that answer "which tiles intersect this viewport" and "which building is at this point" in single-digit milliseconds, partitioning by tile level, and an HTTP endpoint that returns a tile list for a camera frustum, all in EPSG:25832 with a WGS84 projection for delivery.

## Why you hit this

A tileset answers spatial questions by traversal: the runtime walks the tree, tests bounding volumes and decides what to load. That is exactly right for rendering and useless for everything else a twin needs — which buildings are in this district, which tiles cover the area a user has drawn, which asset is under the cursor, which tiles changed since Tuesday. Those are database questions, and answering them by scanning a tileset JSON or a directory listing is what makes a twin's API slow. A small PostGIS table alongside the tiles answers all of them. The addressing it builds on is in [computing quadkeys and tile bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/).

## Prerequisites

- PostgreSQL 15+ with PostGIS 3.4+; `psycopg[binary]>=3.1`, `mercantile>=1.2`, `shapely>=2.0`, `pyproj>=3.6` on the Python side.
- The tileset's shard grid and quadkeys, and per-shard metadata: bounds, geometric error, content URI, build version.
- A decision about the query CRS. The examples store geometry in EPSG:25832 for metric queries and keep a WGS84 geography column for viewport intersection.

## Step-by-Step

### 1. Create a schema that matches the questions

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE tile (
    quadkey       text PRIMARY KEY,
    level         smallint     NOT NULL,
    content_uri   text         NOT NULL,
    geometric_error double precision NOT NULL,
    build_version text         NOT NULL,
    built_at      timestamptz  NOT NULL DEFAULT now(),
    feature_count integer      NOT NULL DEFAULT 0,
    bytes         bigint       NOT NULL DEFAULT 0,
    min_z         double precision NOT NULL,
    max_z         double precision NOT NULL,
    geom_25832    geometry(Polygon, 25832) NOT NULL,
    geog_4326     geography(Polygon, 4326) NOT NULL
);

CREATE INDEX tile_geom_gix   ON tile USING GIST (geom_25832);
CREATE INDEX tile_geog_gix   ON tile USING GIST (geog_4326);
CREATE INDEX tile_level_idx  ON tile (level);
CREATE INDEX tile_built_idx  ON tile (built_at DESC);
CREATE INDEX tile_qk_prefix  ON tile (quadkey text_pattern_ops);

CREATE TABLE feature (
    feature_id  text PRIMARY KEY,
    quadkey     text        NOT NULL REFERENCES tile(quadkey) ON DELETE CASCADE,
    kind        text        NOT NULL,
    height_m    double precision,
    attrs       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    geom_25832  geometry(Polygon, 25832) NOT NULL
);

CREATE INDEX feature_geom_gix  ON feature USING GIST (geom_25832);
CREATE INDEX feature_tile_idx  ON feature (quadkey);
CREATE INDEX feature_attrs_gin ON feature USING GIN (attrs jsonb_path_ops);
```

Two geometry columns look redundant and are not. Metric queries — distances, areas, buffers in metres — want the projected column, where PostGIS operators are exact and fast. Viewport queries arrive from a viewer in longitude and latitude, and converting each request to EPSG:25832 is both slower and a place for an error; the `geography` column takes them directly. The storage cost is a few dozen bytes per tile.

The `text_pattern_ops` index on the quadkey is the one people omit. It makes prefix queries — "everything under this ancestor" — index-assisted, which turns the most natural hierarchical question into a fast one.

<figure class="diagram">
<svg viewBox="6 16 692 238" role="img" aria-labelledby="pg-schema-t pg-schema-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-schema-t">Two tables and the indexes that matter</title>
  <desc id="pg-schema-d">The tile table is keyed by quadkey and holds the level, content URI, geometric error, build version, timestamp, counts and two geometry columns: projected for metric queries and geography for viewport queries. The feature table references it by quadkey and holds per-feature geometry and JSON attributes. Five indexes cover the viewport, the hierarchy, the point query, recency and attribute filters.</desc>
  <rect class="svg-bg" x="6" y="16" width="692" height="238" fill="#ffffff"/>
  <defs>
    <marker id="pg-schema-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="270" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="360" y="30" width="250" height="140" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M290 100 H358" fill="none" stroke="#5b6471" stroke-width="2" marker-end="url(#pg-schema-arrow)"/>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="36" y="54">tile</text>
    <text x="36" y="76">quadkey (PK)</text>
    <text x="36" y="96">level, content_uri</text>
    <text x="36" y="116">geometric_error, build_version</text>
    <text x="36" y="136">built_at, feature_count, bytes</text>
    <text x="36" y="156">min_z, max_z</text>
    <text x="36" y="176">geom_25832 · geog_4326</text>
    <text x="36" y="200">GiST ×2, level, built_at, prefix</text>
    <text x="376" y="54">feature</text>
    <text x="376" y="76">feature_id (PK)</text>
    <text x="376" y="96">quadkey (FK)</text>
    <text x="376" y="116">kind, height_m, attrs (jsonb)</text>
    <text x="376" y="136">geom_25832</text>
    <text x="376" y="158">GiST, quadkey, GIN on attrs</text>
  </g>
  <text x="640" y="100" fill="#15384a" font-size="12" text-anchor="middle">no tile bytes</text>
  <text x="640" y="118" fill="#15384a" font-size="12" text-anchor="middle">in the database</text>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Two geometry columns: metres for analysis, geography for viewports.</text>
</svg>
<figcaption>The schema is deliberately small — metadata and one geometry per row — so the whole index stays in memory.</figcaption>
</figure>

### 2. Load the tile index from the build

```python
import json
from pathlib import Path

import mercantile
import psycopg
from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform as shapely_transform

to_25832 = Transformer.from_crs(4326, 25832, always_xy=True).transform

def tile_rows(tileset_dir, build_version):
    rows = []
    for shard in sorted(Path(tileset_dir).glob("*/tileset.json")):
        meta = json.loads(shard.read_text())
        qk = shard.parent.name
        t = mercantile.quadkey_to_tile(qk)
        b = mercantile.bounds(t)
        wgs = box(b.west, b.south, b.east, b.north)
        rows.append({
            "quadkey": qk,
            "level": t.z,
            "content_uri": f"{qk}/tileset.json",
            "geometric_error": float(meta["geometricError"]),
            "build_version": build_version,
            "feature_count": int(meta.get("extras", {}).get("featureCount", 0)),
            "bytes": sum(p.stat().st_size for p in shard.parent.rglob("*") if p.is_file()),
            "min_z": float(meta["root"]["boundingVolume"]["region"][4]),
            "max_z": float(meta["root"]["boundingVolume"]["region"][5]),
            "wkt_4326": wgs.wkt,
            "wkt_25832": shapely_transform(to_25832, wgs).wkt,
        })
    return rows

UPSERT = """
INSERT INTO tile (quadkey, level, content_uri, geometric_error, build_version,
                  feature_count, bytes, min_z, max_z, geom_25832, geog_4326)
VALUES (%(quadkey)s, %(level)s, %(content_uri)s, %(geometric_error)s, %(build_version)s,
        %(feature_count)s, %(bytes)s, %(min_z)s, %(max_z)s,
        ST_GeomFromText(%(wkt_25832)s, 25832),
        ST_GeogFromText('SRID=4326;' || %(wkt_4326)s))
ON CONFLICT (quadkey) DO UPDATE SET
    content_uri = EXCLUDED.content_uri,
    geometric_error = EXCLUDED.geometric_error,
    build_version = EXCLUDED.build_version,
    built_at = now(),
    feature_count = EXCLUDED.feature_count,
    bytes = EXCLUDED.bytes,
    min_z = EXCLUDED.min_z,
    max_z = EXCLUDED.max_z
"""

with psycopg.connect("postgresql:///twin") as conn:
    rows = tile_rows("build/tiles/city/shards", "city-2026-09-17")
    with conn.cursor() as cur:
        cur.executemany(UPSERT, rows)
    conn.commit()
print(f"{len(rows):,} tiles upserted")
```

An upsert keyed on the quadkey is what makes the index survive incremental builds: a rebuild of forty shards updates forty rows and leaves the rest, including their `built_at`, untouched. That timestamp is then the answer to "what changed since Tuesday", which a directory listing cannot give reliably.

### 3. Answer the viewport query

```sql
-- Tiles intersecting a viewport, at the levels the camera needs
PREPARE tiles_in_view (geography, smallint, smallint) AS
SELECT quadkey, content_uri, geometric_error, level, bytes
FROM tile
WHERE geog_4326 && $1
  AND ST_Intersects(geog_4326, $1)
  AND level BETWEEN $2 AND $3
ORDER BY level, quadkey;
```

```python
def tiles_in_view(conn, west, south, east, north, min_level, max_level):
    wkt = box(west, south, east, north).wkt
    with conn.cursor() as cur:
        cur.execute("""
            SELECT quadkey, content_uri, geometric_error, level, bytes
            FROM tile
            WHERE geog_4326 && ST_GeogFromText(%s)
              AND ST_Intersects(geog_4326, ST_GeogFromText(%s))
              AND level BETWEEN %s AND %s
            ORDER BY level, quadkey
        """, (f"SRID=4326;{wkt}", f"SRID=4326;{wkt}", min_level, max_level))
        return cur.fetchall()

with psycopg.connect("postgresql:///twin") as conn:
    rows = tiles_in_view(conn, 11.560, 48.130, 11.580, 48.142, 14, 16)
print(f"{len(rows)} tiles in view; total {sum(r[4] for r in rows) / 1e6:.1f} MB")
```

The `&&` operator before `ST_Intersects` is not redundant. `&&` is the index-assisted bounding-box test that narrows the candidate set; `ST_Intersects` is the exact test applied to those candidates. PostGIS's planner usually combines them itself, and writing both makes the intent explicit and protects against a planner that chooses a sequential scan when statistics are stale.

### 4. Answer the hierarchy and point queries

```sql
-- Everything under an ancestor: a prefix match, index-assisted
SELECT quadkey, level FROM tile
WHERE quadkey LIKE '1202102%'
ORDER BY level, quadkey;

-- The feature at a clicked point, with its tile
SELECT f.feature_id, f.kind, f.height_m, f.attrs, t.quadkey, t.content_uri
FROM feature f
JOIN tile t ON t.quadkey = f.quadkey
WHERE ST_Intersects(f.geom_25832, ST_SetSRID(ST_MakePoint(%s, %s), 25832))
LIMIT 1;

-- Tiles that changed since a timestamp, for a client-side cache refresh
SELECT quadkey, content_uri, build_version, built_at
FROM tile
WHERE built_at > %s
ORDER BY built_at;

-- The five densest tiles, for a build report
SELECT quadkey, feature_count, bytes,
       round((bytes / GREATEST(feature_count, 1))::numeric, 1) AS bytes_per_feature
FROM tile
WHERE level = 16
ORDER BY feature_count DESC
LIMIT 5;
```

Those four queries are most of what a twin's API needs, and each is a few milliseconds against an indexed table of a hundred thousand tiles. The changed-since query is the one that unlocks a well-behaved client: instead of guessing at cache lifetimes, a viewer asks what has changed and invalidates exactly those tiles — which pairs with the versioning in [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/).

<figure class="diagram">
<svg viewBox="6 6 748 222" role="img" aria-labelledby="pg-queries-t pg-queries-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-queries-t">Four questions, four access paths</title>
  <desc id="pg-queries-d">A table mapping questions to the index that answers them. Which tiles are in this viewport uses the geography GiST index. What is under this ancestor uses the quadkey prefix index. Which feature is at this point uses the feature geometry GiST index. What changed since a timestamp uses the built-at index. Each is milliseconds on a hundred thousand rows.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="330" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="350" y="20" width="250" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="600" y="20" width="140" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="330" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="54" width="250" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="600" y="54" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="94" width="330" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="94" width="250" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="600" y="94" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="134" width="330" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="134" width="250" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="600" y="134" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="174" width="330" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="174" width="250" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="600" y="174" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="185" y="43">question</text><text x="475" y="43">index used</text><text x="670" y="43">typical time</text>
    <text x="185" y="79">tiles in this viewport</text><text x="475" y="79">GiST on geography</text><text x="670" y="79">2–5 ms</text>
    <text x="185" y="119">everything under an ancestor</text><text x="475" y="119">quadkey prefix (text_pattern_ops)</text><text x="670" y="119">&lt; 2 ms</text>
    <text x="185" y="159">feature at this point</text><text x="475" y="159">GiST on feature geometry</text><text x="670" y="159">1–3 ms</text>
    <text x="185" y="199">tiles changed since …</text><text x="475" y="199">B-tree on built_at</text><text x="670" y="199">&lt; 1 ms</text>
  </g>
</svg>
<figcaption>Each question has one index that makes it cheap; the schema exists to make sure every question has one.</figcaption>
</figure>

### 5. Partition when the index grows

```sql
CREATE TABLE tile_part (
    LIKE tile INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY LIST (level);

CREATE TABLE tile_l14 PARTITION OF tile_part FOR VALUES IN (14);
CREATE TABLE tile_l15 PARTITION OF tile_part FOR VALUES IN (15);
CREATE TABLE tile_l16 PARTITION OF tile_part FOR VALUES IN (16);
CREATE TABLE tile_l17 PARTITION OF tile_part FOR VALUES IN (17);

CREATE INDEX ON tile_l16 USING GIST (geog_4326);
CREATE INDEX ON tile_l17 USING GIST (geog_4326);
```

Partitioning by level is the right axis because almost every query constrains the level: a viewer asks for two or three levels at a time, a build report asks for one. With list partitioning on `level`, the planner prunes the rest before touching an index. It becomes worthwhile somewhere around a few million tiles — a country-scale twin — and is unnecessary complexity below that.

### 6. Put an endpoint in front of it

```python
from fastapi import FastAPI, Query
import psycopg_pool

pool = psycopg_pool.ConnectionPool("postgresql:///twin", min_size=2, max_size=16)
app = FastAPI()

@app.get("/tiles/in-view")
def in_view(west: float, south: float, east: float, north: float,
            min_level: int = Query(14, ge=0, le=24),
            max_level: int = Query(17, ge=0, le=24),
            max_bytes: int = Query(200_000_000, ge=0)):
    wkt = f"SRID=4326;{box(west, south, east, north).wkt}"
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT quadkey, content_uri, geometric_error, level, bytes
            FROM tile
            WHERE geog_4326 && ST_GeogFromText(%s)
              AND ST_Intersects(geog_4326, ST_GeogFromText(%s))
              AND level BETWEEN %s AND %s
            ORDER BY level, bytes DESC
        """, (wkt, wkt, min_level, max_level))
        rows = cur.fetchall()

    kept, total = [], 0
    for qk, uri, ge, level, size in rows:
        if total + size > max_bytes:
            continue
        kept.append({"quadkey": qk, "uri": uri, "geometricError": ge, "level": level, "bytes": size})
        total += size
    return {"tiles": kept, "bytes": total, "truncated": len(kept) < len(rows)}
```

The byte budget in the response is the feature that makes this endpoint useful rather than decorative: a client asking for a wide viewport at a deep level gets a list it can actually load, and a flag telling it the list was truncated. Returning everything and letting the client discover it cannot afford it is how a viewer ends up stalling on a query it should never have made.

<figure class="diagram">
<svg viewBox="6 16 748 228" role="img" aria-labelledby="pg-arch-t pg-arch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-arch-t">Where the lookup service sits</title>
  <desc id="pg-arch-d">The tiling build writes tiles to object storage and upserts one row per tile into PostGIS. The viewer fetches tile content directly from the CDN and asks the lookup endpoint for tile lists, point queries and changed-tile lists. The database never serves tile bytes, and the CDN never answers spatial questions.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="228" fill="#ffffff"/>
  <defs>
    <marker id="pg-arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="90" width="120" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="220" y="30" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="220" y="150" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="450" y="150" width="140" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="640" y="90" width="100" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#pg-arch-arrow)">
    <path d="M140 108 L218 62"/>
    <path d="M140 128 L218 168"/>
    <path d="M370 175 H448"/>
    <path d="M590 168 L638 130"/>
    <path d="M370 55 C500 55 560 90 638 104"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="80" y="114">tiling build</text><text x="80" y="132">per shard</text>
    <text x="295" y="50">object storage</text><text x="295" y="68">+ CDN: tile bytes</text>
    <text x="295" y="170">PostGIS</text><text x="295" y="188">one row per tile</text>
    <text x="520" y="170">lookup API</text><text x="520" y="188">lists, points, diffs</text>
    <text x="690" y="114">viewer</text><text x="690" y="132">and clients</text>
  </g>
  <text x="380" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Bytes come from the CDN, answers come from the database; neither does the other's job.</text>
</svg>
<figcaption>Keeping the index out of the tile-serving path is what lets the tiles stay immutable and cacheable while the answers stay current.</figcaption>
</figure>

## Expected Output & Verification

```text
4,096 tiles upserted
38 tiles in view; total 412.8 MB
```

Verify the query plans, because an index that is not used is an index that does not exist:

```python
def explain(conn, sql, params):
    with conn.cursor() as cur:
        cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params)
        plan = cur.fetchone()[0][0]
    node = plan["Plan"]
    used = []
    def walk(n):
        if "Index Name" in n:
            used.append(n["Index Name"])
        for child in n.get("Plans", []):
            walk(child)
    walk(node)
    return {"ms": round(plan["Execution Time"], 2), "indexes": used,
            "rows": node["Actual Rows"], "node": node["Node Type"]}

wkt = f"SRID=4326;{box(11.56, 48.13, 11.58, 48.142).wkt}"
with psycopg.connect("postgresql:///twin") as conn:
    print(explain(conn, """
        SELECT quadkey FROM tile
        WHERE geog_4326 && ST_GeogFromText(%s) AND level BETWEEN %s AND %s
    """, (wkt, 14, 16)))
    print(explain(conn, "SELECT quadkey FROM tile WHERE quadkey LIKE %s", ("1202102%",)))
```

Both plans must name an index. A `Seq Scan` on the viewport query means the GiST index is missing, disabled, or the statistics are stale after a bulk load — run `ANALYZE tile` after every large upsert, which is the step most commonly forgotten and the one that turns a 3 ms query into a 300 ms one.

Then verify the index agrees with the tiles on disk, which is the failure that produces 404s in a viewer:

```python
from pathlib import Path

def audit_index(conn, tileset_dir):
    with conn.cursor() as cur:
        cur.execute("SELECT quadkey, content_uri FROM tile")
        rows = cur.fetchall()
    missing_on_disk = [qk for qk, uri in rows if not (Path(tileset_dir) / uri).exists()]
    on_disk = {p.parent.name for p in Path(tileset_dir).glob("*/tileset.json")}
    missing_in_db = sorted(on_disk - {qk for qk, _ in rows})
    return {"rows": len(rows), "missing_on_disk": missing_on_disk[:5],
            "missing_in_db": missing_in_db[:5],
            "consistent": not missing_on_disk and not missing_in_db}

with psycopg.connect("postgresql:///twin") as conn:
    result = audit_index(conn, "build/tiles/city/shards")
print(result)
assert result["consistent"], "the index and the tiles disagree"
```

## Performance Notes

- **`ANALYZE` after bulk loads.** Without current statistics the planner mis-estimates selectivity and falls back to sequential scans on exactly the queries that matter.
- **Use a connection pool.** A lookup endpoint that opens a connection per request spends more time on handshakes than on queries.
- **Keep the index table narrow.** The tile row is metadata; content never belongs in the database. A hundred thousand rows at a few hundred bytes fits comfortably in memory and every query is served from cache.
- **Prepare or parameterise the hot queries** so the planner reuses a plan, and avoid string-interpolating geometry into SQL — it is both slower and an injection risk.
- **Cluster on the quadkey** (`CLUSTER tile USING tile_qk_prefix`) after a full rebuild: spatially adjacent tiles then share pages, which halves the buffer reads for a viewport query.

## Common Errors

**The viewport query returns nothing.** The bounding box was built as `(minx, miny, maxx, maxy)` in the wrong order, or the coordinates are projected metres being passed to a geography column. Geography takes longitude and latitude.

**Prefix queries do not use the index.** The column has the default `text_ops` operator class, which does not support `LIKE 'prefix%'` in a non-C locale. Add the `text_pattern_ops` index, as the schema does.

**Point queries return the wrong feature at overlaps.** Two features genuinely overlap — a building and its canopy — and `LIMIT 1` picks arbitrarily. Order by something meaningful, such as descending height or ascending area, and say so in the API.

**The index drifts from the tiles.** A build wrote tiles and failed before the upsert, or an upsert ran against the wrong database. Make the upsert part of the same transactional step as publishing, and run the audit above in CI.

## Frequently Asked Questions

### Why not store the tiles themselves in PostGIS?

Because tiles are immutable binary blobs served by a CDN, and a database is the worst place to serve them from: no edge caching, connection limits, and backup volumes measured in terabytes. The database holds the *answers*, the CDN holds the bytes.

### Should the feature table hold every building in the city?

It can — a few million polygons with GiST indexes is unremarkable for PostGIS — and it is what makes attribute and spatial queries possible without touching tiles. Keep the geometry simplified for query purposes and let the tiles carry the detailed version.

### Does this replace the tileset's own hierarchy?

No. The runtime still traverses the tileset to decide what to render; the database answers questions the traversal cannot. Both describe the same tiles, which is why the consistency audit matters.

## Related Guides

- [Computing Quadkeys and Tile Bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/) — the keys this schema is built on
- [Building an R-Tree Index for 3D Tile Lookup](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/building-an-r-tree-index-for-3d-tile-lookup/) — the in-process alternative
- [GeoPackage vs GeoParquet for Twin Attributes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/geopackage-vs-geoparquet-for-twin-attributes/) — file-based stores for the same data

Back to [Spatial Indexing and Tiling Schemes for 3D Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/).
