# Coordinate Reference Systems for 3D Assets

A 3D asset that renders perfectly but sits ten metres below the imagery, or a LiDAR tile whose heights disagree with the survey benchmark by the local geoid undulation, is not a rendering bug — it is a coordinate reference system that was never fully declared. Unlike 2D GIS, where a horizontal EPSG code is usually enough, a 3D digital twin must simultaneously pin down horizontal positioning, a vertical datum, unit scaling, axis order, and (for survey-grade work) a coordinate epoch. This guide gives you the production patterns to define, transform, and validate those references with `pyproj`, `rasterio`, and `laspy` so that misalignment is caught at ingestion rather than discovered three pipeline stages later in a flood simulation that quietly dammed itself behind buildings.

These patterns sit inside the broader [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) baseline: every terrain raster, point cloud, and mesh downstream inherits the CRS decisions made here, so getting the compound CRS and the transformation chain right is the cheapest insurance the twin will ever buy.

## Prerequisites

Pin these versions — the compound-CRS and network-grid behaviour below depends on a modern PROJ data stack:

- **Python 3.9+** with `pyproj>=3.6` (bundles PROJ 9.3+, required for reliable compound-CRS resolution and `Transformer.from_pipeline`), `rasterio>=1.3`, `laspy>=2.4`, and `numpy>=1.24`.
- **PROJ data grids** reachable at runtime: either install `proj-data` locally or enable the PROJ CDN so vertical grids (`us_noaa_g2018u0.tif` for GEOID18, `us_nga_egm2008_1.tif` for EGM2008) download on demand. Without them, vertical transforms silently fall back to ellipsoidal heights.
- **Input formats:** point clouds as LAS/LAZ 1.4 (CRS in a WKT or GeoTIFF VLR), terrain as GeoTIFF with a compound CRS, and mesh/CAD payloads (OBJ, FBX, glTF) that carry CRS only in a companion `.prj`/`.json` sidecar.
- **EPSG codes you will reference here:** EPSG:4326 (WGS84 lat/lon), EPSG:4979 (WGS84 3D geographic, ellipsoidal height), EPSG:32618 (UTM 18N), EPSG:32633 (UTM 33N), EPSG:5703 (NAVD88 height), EPSG:5773 (EGM96 height), EPSG:5712 (EGM2008 height), EPSG:6360 (NAVD88 in US survey feet), and compounds such as EPSG:32618+5703.

Enable network grids before any transform so a missing geoid file fails loudly rather than degrading precision:

```python
import pyproj
pyproj.network.set_network_enabled(active=True)
print("PROJ", pyproj.proj_version_str, "| network:", pyproj.network.is_network_enabled())
```

## Concept

A complete 3D reference is two CRSs fused into one declaration: a horizontal frame that fixes X/Y and a vertical frame that fixes Z. The horizontal half is geographic (EPSG:4326, angular degrees) or projected (EPSG:32618, metric easting/northing). The vertical half references either the **ellipsoid** — a smooth mathematical surface that GNSS receivers report directly — or the **geoid**, an equipotential surface approximating mean sea level that every map, benchmark, and flood model uses. The signed gap between them is the geoid undulation N, ranging roughly −105 m to +85 m worldwide, and it is the single most common source of tens-of-metres vertical error in twins. An ellipsoidal height h and an orthometric height H relate as H = h − N, where N comes from a named geoid model (GEOID18, EGM2008), not a constant.

A compound CRS such as EPSG:32618+5703 names both halves in one string and removes the ambiguity entirely. Why not just keep ellipsoidal heights everywhere and avoid the geoid? Because every product the twin feeds — flood extents, line-of-sight, clearance envelopes, solar irradiance — is referenced to mean sea level, and the analyst comparing your output to a published benchmark or a flood gauge works in orthometric heights. Carry ellipsoidal Z into that comparison and the model is wrong by N, which in parts of the world is larger than the buildings being analysed. The diagram below shows the separation you are reconciling on every Z value, and the transformation chain that carries a GNSS point into a metric, orthometric twin.

<figure class="diagram">
<svg viewBox="0 0 860 320" role="img" aria-labelledby="crs-geoid-t crs-geoid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crs-geoid-t">Ellipsoid, geoid, and the CRS transformation chain</title>
  <desc id="crs-geoid-d">A ground point sits at ellipsoidal height h above the ellipsoid and orthometric height H above the geoid; the two differ by the geoid undulation N. The lower row shows the transformation chain from WGS84 geographic through a geoid grid to a compound projected and orthometric CRS.</desc>
  <defs>
    <marker id="crs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M40 70 Q 240 40 440 70 T 820 70" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M40 120 Q 240 150 440 118 T 820 124" fill="none" stroke="#c46a3d" stroke-width="2"/>
  <circle cx="440" cy="48" r="5" fill="#1f2937"/>
  <line x1="440" y1="48" x2="440" y2="70" stroke="#1f6b8a" stroke-width="2"/>
  <line x1="460" y1="48" x2="460" y2="119" stroke="#c46a3d" stroke-width="2"/>
  <line x1="420" y1="70" x2="420" y2="118" stroke="#5b6471" stroke-width="2" stroke-dasharray="4 3"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="30" y="225" width="170" height="62" rx="8"/>
    <rect x="500" y="225" width="200" height="62" rx="8"/>
  </g>
  <rect x="265" y="225" width="170" height="62" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#crs-arrow)">
    <line x1="200" y1="256" x2="263" y2="256"/>
    <line x1="435" y1="256" x2="498" y2="256"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="540" y="64" font-size="12">ground point</text>
    <text x="408" y="98" font-size="12">N</text>
    <text x="115" y="252"><tspan x="115" dy="0">EPSG:4326</tspan><tspan x="115" dy="16">lon, lat, h</tspan></text>
    <text x="350" y="252"><tspan x="350" dy="0">geoid grid</tspan><tspan x="350" dy="16">GEOID18 / EGM2008</tspan></text>
    <text x="600" y="252"><tspan x="600" dy="0">EPSG:32618+5703</tspan><tspan x="600" dy="16">E, N, orthometric H</tspan></text>
  </g>
  <text x="700" y="60" fill="#1f6b8a" font-size="12" text-anchor="middle">ellipsoid</text>
  <text x="700" y="140" fill="#c46a3d" font-size="12" text-anchor="middle">geoid</text>
</svg>
<figcaption>Ellipsoidal height h and orthometric height H differ by the geoid undulation N; the chain below resolves N with a named grid into a compound CRS.</figcaption>
</figure>

There are four practical frame types you will hand to a `Transformer`, and choosing the wrong one is its own failure mode. A geodetic CRS (EPSG:4979) carries lon/lat plus ellipsoidal height and suits global ingestion and satellite-derived data, but distorts distances locally. A projected CRS (EPSG:32618, a UTM zone, or a State Plane / national grid) flattens the ellipsoid into a metric plane and is mandatory for measurement, indexing, and physics. A vertical CRS (EPSG:5703, EPSG:5712) supplies the Z reference independently so it can be paired with any horizontal frame. An engineering or local CRS gives a metric grid around an arbitrary site origin, common in BIM-to-GIS work where relative precision matters more than global position. A compound CRS simply pairs one horizontal with one vertical frame.

Treat the source CRS as immutable metadata and transform only at system boundaries. The rest of this guide builds that boundary transform, then proves it with round-trip residuals and control points.

## Step-by-Step Workflow

### 1. Validate the compound CRS before touching geometry

Resolve both components first. A string that parses as a bare horizontal CRS will silently process Z as ellipsoidal — verify `is_compound` and confirm the vertical sub-CRS by name.

```python
from pyproj import CRS

def validate_compound_crs(crs_string: str) -> CRS:
    crs = CRS.from_user_input(crs_string)
    if not crs.is_compound:
        raise ValueError(f"{crs_string} resolved as {crs.name} — no vertical datum. "
                         "Z will be treated as ellipsoidal.")
    horiz, vert = crs.sub_crs_list[0], crs.sub_crs_list[1]
    print(f"horizontal: {horiz.name} (EPSG:{horiz.to_epsg()})")
    print(f"vertical:   {vert.name} (EPSG:{vert.to_epsg()})")
    return crs

# UTM 18N (EPSG:32618) + NAVD88 height (EPSG:5703)
target = validate_compound_crs("EPSG:32618+5703")
```

The distinction this guard enforces is subtle but expensive. `CRS.from_user_input("EPSG:32618")` returns a perfectly valid projected CRS — `pyproj` will happily transform three-dimensional points into it — but it carries no vertical datum, so the Z coordinate passes through untouched and ends up interpreted as ellipsoidal by whatever reads it next. By rejecting any non-compound target at the door, you convert a class of silent vertical errors into a loud, immediate exception at the one place in the pipeline where the fix is trivial: declaring the correct EPSG code. Run this check on the source CRS too, not just the destination, because a LAS file tagged EPSG:4326 with metre heights is just as ambiguous as a missing one.

### 2. Build a grid-aware Transformer with locked axis order

Always pass `always_xy=True`. Geographic CRSs in the EPSG registry are formally lat/lon (axis order Y,X), so without this flag `pyproj` will swap your easting and northing. Inspect the chosen operation to confirm a grid was used, not a 3-parameter approximation.

```python
from pyproj import Transformer

# EPSG:4326 + EGM96 height (EPSG:5773)  ->  UTM 18N + NAVD88 (EPSG:32618+5703)
transformer = Transformer.from_crs("EPSG:4326+5773", "EPSG:32618+5703", always_xy=True)

op = transformer.transformer_group.transformers[0] if hasattr(transformer, "transformer_group") else None
print("operation:", transformer.description)          # names the grid(s) PROJ selected
print("grids available:", all(g.available for g in transformer.get_grids_used() or []))
```

PROJ selects a transformation pipeline by searching its operation database for the most accurate path between the two CRSs, ranking candidates by stated accuracy and grid availability. When the ideal grid is missing it does not fail — it falls back to a lower-accuracy operation, often a 3-parameter or null transformation, and reports a larger accuracy figure that nobody reads. Inspecting `transformer.description` and `get_grids_used()` turns that hidden downgrade into an assertion you can fail a build on. For datum transformations that span a national extent, a 7-parameter Helmert or a grid shift (NADCON5, OSTN15, the GEOID18 grids) is the difference between sub-centimetre and multi-metre fidelity, so confirming the operation by name is worth the two extra lines.

### 3. Transform survey points in a vectorized batch

Pass NumPy arrays for X, Y, and Z so the whole point set transforms in one call. The vertical grid is applied per-point, so heights shift correctly across regions of varying undulation.

```python
import numpy as np
from pyproj import Transformer

transformer = Transformer.from_crs("EPSG:4326+5773", "EPSG:32618+5703", always_xy=True)

lon = np.array([-73.985428, -73.968285, -73.961704])   # Manhattan control points
lat = np.array([ 40.748817,  40.785091,  40.797490])
h   = np.array([ 12.30,      18.74,       9.55])         # ellipsoidal, metres

easting, northing, ortho = transformer.transform(lon, lat, h)
for e, n, z in zip(easting, northing, ortho):
    print(f"E={e:11.3f}  N={n:12.3f}  orthometric_H={z:7.3f}")
```

### 4. Read and rewrite the CRS on a LAS/LAZ point cloud

LiDAR stores its CRS in a VLR. Read it with `laspy`, transform the coordinates, and write the new compound CRS back into the header so the next stage cannot misread the frame.

```python
import laspy
import numpy as np
from pyproj import CRS, Transformer

las = laspy.read("raw_scan.laz")
src = CRS.from_user_input(las.header.parse_crs() or "EPSG:4326+5773")
dst = CRS.from_user_input("EPSG:32618+5703")

tf = Transformer.from_crs(src, dst, always_xy=True)
x, y, z = tf.transform(las.x, las.y, las.z)

las.x, las.y, las.z = x, y, z
las.header.add_crs(dst)                 # writes a WKT VLR for the compound CRS
las.write("scan_utm18n_navd88.laz")
print("rewrote", len(las.points), "points to EPSG:32618+5703")
```

Two details make this round-trip safe. First, `las.header.parse_crs()` reads whichever VLR the producer wrote — older tools embed a GeoTIFF-key VLR, newer ones a WKT VLR — and returns `None` if neither exists, which is your cue to halt rather than guess. Second, `add_crs()` writes the *destination* compound CRS back so the file is self-describing; skipping that step leaves a point cloud whose coordinates are UTM/NAVD88 but whose header still claims WGS84, the worst of both worlds. For LAS 1.4 you should also confirm the `global_encoding` WKT bit is set so downstream readers prefer the WKT VLR over any stale GeoTIFF keys. The point density that this reprojected cloud must satisfy is governed by the [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/), which only stay deterministic when every tile shares one CRS grid.

### 5. Align a DEM raster to the same compound vertical datum

A terrain surface must share the point cloud's vertical datum or you get Z-shearing where the two meet. Reproject GeoTIFF elevations with `rasterio` and a `pyproj` chain rather than trusting a default warp.

```python
import numpy as np
import rasterio
from pyproj import Transformer

with rasterio.open("terrain_egm2008.tif") as ds:
    band = ds.read(1)
    rows, cols = np.indices(band.shape)
    xs, ys = rasterio.transform.xy(ds.transform, rows.ravel(), cols.ravel())

# Shift heights EGM2008 (EPSG:5712) -> NAVD88 (EPSG:5703), horizontal already EPSG:32618
vtf = Transformer.from_crs("EPSG:32618+5712", "EPSG:32618+5703", always_xy=True)
_, _, z_navd88 = vtf.transform(np.asarray(xs), np.asarray(ys), band.ravel())
band_aligned = z_navd88.reshape(band.shape).astype("float32")
print("median datum shift:", float(np.nanmedian(band_aligned - band)), "m")
```

The mechanics of pushing a geographic source into a metric grid are covered in depth in [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/), and the trade-offs behind *which* projected frame to pick are the subject of [how to choose a CRS for urban digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/).

## Validation & Verification

Two checks separate a correct transform from a plausible-looking one: a round-trip residual and an independent control point.

A round-trip back to the source CRS must return to the input within numerical precision. Horizontal residuals should be sub-millimetre; vertical residuals depend on grid interpolation but should sit well under a centimetre.

```python
import numpy as np
from pyproj import Transformer

fwd = Transformer.from_crs("EPSG:4326+5773", "EPSG:32618+5703", always_xy=True)
inv = Transformer.from_crs("EPSG:32618+5703", "EPSG:4326+5773", always_xy=True)

lon, lat, h = -73.985428, 40.748817, 12.30
e, n, z = fwd.transform(lon, lat, h)
lon2, lat2, h2 = inv.transform(e, n, z)

assert abs(lon - lon2) < 1e-9 and abs(lat - lat2) < 1e-9, "horizontal round-trip drift"
assert abs(h - h2)   < 1e-3, "vertical round-trip drift > 1 mm — grid mismatch"
print("round-trip OK")
```

Then check against a surveyed benchmark whose published orthometric height you trust. The residual is your real accuracy figure; if it equals the local geoid undulation (tens of metres), you transformed ellipsoidal heights without a geoid grid.

```python
known_ortho = 38.512          # NAVD88 height of a published benchmark, metres
computed_ortho = z            # from the transform above
residual = computed_ortho - known_ortho
assert abs(residual) < 0.05, f"vertical residual {residual:.3f} m — check geoid grid"
print(f"control-point vertical residual: {residual*1000:.1f} mm")
```

Expected outcome: round-trip residuals below 1 mm horizontal and 1 mm vertical, and a control-point residual within your survey tolerance (commonly 2–5 cm). A residual near a round 30–100 m is the unmistakable signature of a missing vertical grid; a residual that is a clean swap of magnitude between easting and northing means `always_xy=True` was dropped somewhere in the chain. Run both checks in CI against a small fixture of published benchmarks so a PROJ data upgrade or a grid removal surfaces as a failing test rather than a silently shifted twin. Log the operation name, the grid file, and its version alongside the residuals, because reproducing a transform six months later requires knowing not just the EPSG codes but which geoid grid revision produced the numbers.

## Performance & Scale

`pyproj` transforms are vectorized over NumPy arrays, so the dominant cost on large clouds is I/O and grid sampling, not the projection math. A single `Transformer` instance is reusable and thread-safe for reads — construct it once and apply it to every chunk rather than rebuilding it per tile, which re-runs PROJ's expensive operation search.

For billion-point datasets, chunk the LAZ by VLR-declared extent and transform tiles independently; a transform on 50 million points runs in a few seconds once the grids are cached locally. Pre-download grids with `pyproj sync` (or `projsync --all`) into `PROJ_DATA` so production workers never block on a CDN fetch mid-job. Cache the geoid grid in memory across tiles — repeated network resolution of `us_noaa_g2018u0.tif` is the most common hidden cost in batch reprojection.

Memory is the second constraint. Transforming a tile in place over `numpy` arrays roughly triples peak footprint (input X/Y/Z plus output), so for a tile that already fills RAM, either reduce the chunk size in the helper below or stream coordinates from a memory-mapped LAZ reader rather than loading the whole file. Because a single `Transformer` is thread-safe for transforms, fan tiles out across a process or thread pool with one shared instance per worker; the operation search that dominates construction cost then happens once, not once per tile. Benchmark on your own hardware before parallelizing — for purely horizontal reprojections the per-point cost is low enough that I/O dominates, and adding processes only multiplies disk contention.

```python
from pyproj import Transformer
import numpy as np

tf = Transformer.from_crs("EPSG:4326+5773", "EPSG:32618+5703", always_xy=True)

def transform_chunked(lon, lat, h, chunk=5_000_000):
    out = np.empty((3, lon.size), dtype="float64")
    for i in range(0, lon.size, chunk):
        s = slice(i, i + chunk)
        out[0, s], out[1, s], out[2, s] = tf.transform(lon[s], lat[s], h[s])
    return out
```

## Failure Modes & Gotchas

- **Silent ellipsoidal fallback.** When the geoid grid is missing and the network is disabled, PROJ does not error — it returns ellipsoidal heights, producing a uniform 30–100 m vertical offset. Always call `pyproj.network.set_network_enabled(active=True)` and assert `Transformer.get_grids_used()` reports `available=True`.
- **Axis-order swap.** Omitting `always_xy=True` makes geographic CRSs emit lat/lon (Y,X) order, so easting and northing arrive transposed — points land hundreds of kilometres away. Lock the order on every `Transformer` and round-trip-test.
- **Bare CRS posing as compound.** `EPSG:32618` and `EPSG:32618+5703` both parse cleanly, but only the second carries a vertical datum. A horizontal-only target throws Z away as ellipsoidal. Gate every ingestion through `crs.is_compound`.
- **Unit and datum-epoch drift.** Mixing metres with US survey feet (EPSG:6360 vs EPSG:5703) or applying a static transform to dynamic NAD83(2011)/ETRS89 data without an epoch introduces scale and millimetre-to-centimetre drift. Normalize to metres and pass an explicit coordinate epoch for survey-grade multi-year data.
- **Z-up versus Y-up handoff.** CAD/BIM is right-handed Z-up; many WebGL renderers expect Y-up. The CRS transform fixes georeferencing but not the renderer's axis convention — record the axis swap matrix in the sidecar so the [3D format conversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) stage applies it deterministically.

## Frequently Asked Questions

### Why do my GNSS heights disagree with my benchmark heights by tens of metres?
You are mixing ellipsoidal (GNSS) and orthometric (benchmark/MSL) heights, and the gap is the geoid undulation N. Apply a named geoid model as an explicit vertical transformation — for example chain through EPSG:5703 (NAVD88) or EPSG:5712 (EGM2008) with the matching PROJ grid. Never subtract a single constant; N varies continuously across the extent.

### What is a compound CRS and why can't I just use EPSG:4326?
A compound CRS (such as EPSG:32618+5703) bundles a horizontal and a vertical CRS into one identifier so both X/Y and Z are unambiguous. EPSG:4326 defines only horizontal lat/lon with no vertical datum, so any height you attach is implicitly ellipsoidal — fine for global ingestion, wrong for clearance, flood, or structural analysis that needs orthometric Z.

### How do I store a CRS in formats that have no native support, like OBJ or glTF?
Write the CRS and a local origin offset into a companion `.prj` or `.json` sidecar and document the axis convention (Z-up vs Y-up) and units. Keep the full geometry in a metric projected CRS internally and treat the mesh export as derived, so the authoritative reference always lives in the LAS VLR or GeoTIFF header, never only in the mesh.

### Do I need to worry about coordinate epochs?
For most static city twins, no. But survey-grade data on dynamic datums (NAD83(2011), ETRS89, ITRF) drifts millimetres to centimetres per year from plate motion. If you fuse multi-year acquisitions or need centimetre vertical accuracy, transform with an explicit epoch using `pyproj`'s epoch-aware operations and version the CRS alongside each data release.

### Which CRS should the twin use internally versus for web delivery?
Use a single projected, metric, compound CRS internally (a UTM zone or national grid plus an orthometric vertical datum) so distances, indexing, and physics stay accurate. Reproject to EPSG:4326 / EPSG:4979 only at the web-delivery boundary for Cesium and 3D Tiles. [How to choose a CRS for urban digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) walks through selecting that internal frame.

## Related Guides

- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the EPSG:4326 → UTM transform in depth
- [How to Choose CRS for Urban Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) — selecting the internal metric frame
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — aligning raster terrain to the same vertical datum
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — density targets that depend on a consistent CRS grid
- [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — how each container preserves or discards CRS metadata

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
