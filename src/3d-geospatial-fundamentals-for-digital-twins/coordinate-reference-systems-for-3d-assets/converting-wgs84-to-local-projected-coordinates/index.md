---
title: "Converting WGS84 to Local Projected Coordinates"
description: "Convert WGS84 (EPSG:4326) to a local projected CRS with pyproj: UTM EPSG:32618, axis order, compound vertical CRS, batch arrays, and round-trip checks."
---
# Converting WGS84 to Local Projected Coordinates

This page shows how to convert WGS84 geographic coordinates (EPSG:4326) into a local projected CRS such as UTM zone 18N (EPSG:32618) or a national grid using `pyproj`, including the compound vertical case (EPSG:32618+5703) and the axis-order rules that silently corrupt results. The production-standard path uses a `pyproj.Transformer` built from explicit EPSG codes, applies the datum shift and projection mathematics through the [PROJ engine](https://proj.org/usage/transformation.html), and verifies the result with a sub-millimetre round-trip residual before any of those points reach a mesh, a tileset, or a survey-control comparison.

## Why You Hit This

Almost every 3D acquisition begins in EPSG:4326. GNSS receivers, RTK base corrections, drone flight logs, IoT sensor feeds, and web map clicks all emit longitude/latitude on the WGS84 ellipsoid. But a digital twin runs in a metric Cartesian plane: CAD/BIM geometry, point clouds, and simulation meshes expect uniform metres, not degrees that shrink toward the poles. One degree of longitude is roughly 111 km at the equator and about 85 km at 40° N — distances, areas, and normals computed on raw EPSG:4326 are meaningless. Projecting to a metric CRS (a UTM zone, State Plane, or a national grid such as British National Grid / EPSG:27700) is the step that makes the geometry usable.

The economic case is sharper than it first appears. Once geometry is anchored to a projected CRS like EPSG:32618, a one-metre offset in the data is a one-metre offset on the ground — the units are isometric and uniform across the whole tile, so registration, clash detection, and volumetric queries behave linearly. Left in EPSG:4326, the same operations need spherical trigonometry on every call, lose precision near the poles, and break the moment a rendering or physics engine assumes its axes are equal-scale. Picking a projection whose scale-factor deviation stays under 1:10,000 across your site keeps cumulative drift below the centimetre tolerances that survey-grade twins are held to.

Two failure classes dominate this conversion: silent axis-order swaps (PROJ's CRS database declares EPSG:4326 as latitude-first, so the naive call flips your coordinates) and ignored vertical datums (GNSS gives ellipsoidal height; your twin almost certainly wants orthometric height relative to a geoid). Both produce output that looks plausible and is wrong by metres. The steps below close off both. For the broader question of which target CRS to pick, see [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).

<figure class="diagram">
<svg viewBox="1 36 758 192" role="img" aria-labelledby="wgs84-conv-t wgs84-conv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wgs84-conv-t">WGS84 to projected transform pipeline</title>
  <desc id="wgs84-conv-d">WGS84 longitude, latitude and ellipsoidal height in EPSG:4326 pass through a pyproj Transformer with always_xy true, producing easting, northing and orthometric height in the compound CRS EPSG:32618 plus 5703, then an inverse transform verifies the round trip.</desc>
  <rect class="svg-bg" x="1" y="36" width="758" height="192" fill="#ffffff"/>
  <defs>
    <marker id="wgs84-conv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="15" y="50" width="200" height="90" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="285" y="50" width="190" height="90" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="545" y="50" width="200" height="90" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="285" y="170" width="190" height="44" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#wgs84-conv-arrow)">
    <line x1="216" y1="95" x2="283" y2="95"/>
    <line x1="476" y1="95" x2="543" y2="95"/>
    <line x1="645" y1="142" x2="645" y2="192" stroke-dasharray="5 4"/>
    <line x1="475" y1="192" x2="125" y2="192" stroke-dasharray="5 4"/>
    <line x1="115" y1="190" x2="115" y2="142" stroke-dasharray="5 4"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="115" y="82"><tspan x="115" dy="0">EPSG:4326</tspan><tspan x="115" dy="16">lon, lat, ellip. h</tspan></text>
    <text x="380" y="82"><tspan x="380" dy="0">pyproj Transformer</tspan><tspan x="380" dy="16">always_xy=True</tspan></text>
    <text x="645" y="82"><tspan x="645" dy="0">EPSG:32618+5703</tspan><tspan x="645" dy="16">E, N, ortho h</tspan></text>
    <text x="380" y="197">inverse round-trip check</text>
  </g>
</svg>
<figcaption>The forward transform and the inverse round-trip residual that proves the chain is correct.</figcaption>
</figure>

## Prerequisites

- Python 3.9+ with `pyproj>=3.6` (ships PROJ 9.x, which auto-downloads grid shift files when network access to the PROJ CDN is allowed).
- `numpy>=1.24` for vectorized batch transforms.
- `laspy>=2.5` only if you are reprojecting the coordinates stored in a `.las`/`.laz` file.
- Your **source** CRS: EPSG:4326 (WGS84 longitude/latitude, ellipsoidal height).
- Your **target** CRS chosen explicitly, e.g. EPSG:32618 (UTM 18N), or the compound EPSG:32618+5703 (UTM 18N + NAVD88 orthometric height).
- Optional: set `PROJ_NETWORK=ON` so PROJ fetches geoid grids (for example `us_noaa_g2018u0.tif` behind EPSG:5703) on demand.

Confirm the install resolves a transformation before writing pipeline code:

```python
import pyproj
print("pyproj", pyproj.__version__, "| PROJ", pyproj.proj_version_str)
print("network:", pyproj.network.is_network_enabled())
```

## Step-by-Step

### 1. Build a Transformer with explicit EPSG codes and `always_xy=True`

Construct one `Transformer` per direction and reuse it — PROJ caches the resolved pipeline internally, so repeated calls are cheap. The `always_xy=True` flag is mandatory: it forces longitude/latitude (and easting/northing) order regardless of what the CRS authority declares, eliminating the latitude-first trap of EPSG:4326.

```python
from pyproj import Transformer

# WGS84 geographic (EPSG:4326) -> UTM zone 18N (EPSG:32618)
fwd = Transformer.from_crs("EPSG:4326", "EPSG:32618", always_xy=True)

lon, lat = -73.985428, 40.748817          # Empire State Building
easting, northing = fwd.transform(lon, lat)
print(f"E={easting:.3f}  N={northing:.3f}")
```

The flag matters because nothing downstream will tell you it was missing. Both orderings produce two finite numbers in the right units, both survive a JSON schema, and both write cleanly into a LAS header. Only the position is wrong, and the amount it is wrong by depends on the site — which is why a fixture near the equator can pass while the same code puts a northern city two time zones east.

<figure class="diagram">
<svg viewBox="6 2 708 290" role="img" aria-labelledby="wgs-axis-t wgs-axis-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wgs-axis-t">The same two numbers under both axis orders</title>
  <desc id="wgs-axis-d">With always_xy set to true, the pair minus 73.985 and 40.749 is read as longitude then latitude and projects onto Manhattan. Without it, PROJ applies EPSG:4326's authority order of latitude then longitude, the same pair is read backwards, and the point lands thousands of kilometres away with no error raised.</desc>
  <rect class="svg-bg" x="6" y="2" width="708" height="290" fill="#ffffff"/>
  <path d="M20 46 H340 V226 H20 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M380 46 H700 V226 H380 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#e6e0d4" stroke-width="1.5">
    <path fill="none" d="M100 46 V226 M180 46 V226 M260 46 V226"/>
    <path fill="none" d="M20 96 H340 M20 136 H340 M20 176 H340"/>
    <path fill="none" d="M460 46 V226 M540 46 V226 M620 46 V226"/>
    <path fill="none" d="M380 96 H700 M380 136 H700 M380 176 H700"/>
  </g>
  <circle cx="180" cy="136" r="8" fill="#1f6b8a"/>
  <circle cx="646" cy="86" r="8" fill="#b0413e"/>
  <text x="180" y="30" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">always_xy=True — read as (lon, lat)</text>
  <text x="540" y="30" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">default order — read as (lat, lon)</text>
  <text x="180" y="164" fill="#1f2937" font-size="11.5" text-anchor="middle">Manhattan, as intended</text>
  <text x="600" y="112" fill="#1f2937" font-size="11.5" text-anchor="middle">nowhere near the site</text>
  <text x="180" y="252" fill="#1f2937" font-size="12" text-anchor="middle">E 585 016 · N 4 511 322</text>
  <text x="540" y="252" fill="#1f2937" font-size="12" text-anchor="middle">E 6 721 013 · N 4 520 459</text>
  <text x="360" y="274" fill="#5b6471" font-size="12" text-anchor="middle">Both calls return two finite numbers in metres. Only one of them is a place.</text>
</svg>
<figcaption>The axis-order bug never raises. It returns plausible eastings and northings, which is precisely why it reaches production and is discovered by an analyst rather than a test.</figcaption>
</figure>

### 2. Transform whole arrays in one vectorized call

Never loop over points. Pass NumPy arrays straight into `transform()` — PROJ processes them in its C backend, which is 100x+ faster than per-point Python calls on a typical 10k-point batch. The transformer accepts and returns parallel 1-D arrays.

```python
import numpy as np

# (N, 3): lon, lat, ellipsoidal height (metres)
coords_wgs84 = np.array([
    [-73.9857, 40.7484, 15.2],
    [-74.0060, 40.7128,  8.5],
    [-73.9650, 40.7820, 22.1],
])

easting, northing = fwd.transform(coords_wgs84[:, 0], coords_wgs84[:, 1])
local_2d = np.column_stack((easting, northing))
print(local_2d)
```

### 3. Carry the vertical component through a compound CRS

To convert ellipsoidal height to orthometric height in the same pass, target a compound CRS that pairs the horizontal EPSG:32618 with vertical EPSG:5703 (NAVD88). PROJ applies the geoid grid behind EPSG:5703 automatically; the third argument and third return value become height.

```python
# WGS84 ellipsoidal (EPSG:4326) -> UTM 18N + NAVD88 (compound EPSG:32618+5703)
fwd3d = Transformer.from_crs("EPSG:4326", "EPSG:32618+5703", always_xy=True)

e3, n3, ortho_h = fwd3d.transform(
    coords_wgs84[:, 0], coords_wgs84[:, 1], coords_wgs84[:, 2]
)
local_3d = np.column_stack((e3, n3, ortho_h))
print(local_3d)
```

### 4. Verify with a round-trip residual

Build the inverse transformer (EPSG:32618 → EPSG:4326), run it on your projected output, and assert the residual is sub-millimetre in degrees. A non-trivial residual means the chain is misconfigured — usually a missing grid or a flipped axis.

```python
inv = Transformer.from_crs("EPSG:32618", "EPSG:4326", always_xy=True)
lon_rt, lat_rt = inv.transform(easting, northing)

residual = np.hypot(lon_rt - coords_wgs84[:, 0], lat_rt - coords_wgs84[:, 1])
assert residual.max() < 1e-9, f"round-trip drift {residual.max():.2e} deg"
print("round-trip OK, max residual:", residual.max())
```

### 5. Reproject the coordinates inside a LiDAR file with `laspy`

When the points live in a `.laz`, read the scaled X/Y/Z, transform them, write them back, and update the header CRS so downstream tools read the right EPSG. Note `laspy` exposes `las.x/y/z` as real-world coordinates already decoded from the integer storage.

```python
import laspy
from pyproj import Transformer

las = laspy.read("survey_wgs84.laz")          # stored as EPSG:4326
t = Transformer.from_crs("EPSG:4326", "EPSG:32618+5703", always_xy=True)

e, n, z = t.transform(las.x, las.y, las.z)
las.x, las.y, las.z = e, n, z
las.header.add_crs("EPSG:32618+5703")          # stamp the new CRS
las.write("survey_utm18n_navd88.laz")
```

The `add_crs()` call in the last line is the part teams skip, and it is what makes the file self-describing. A LAS 1.4 file can carry its CRS in either of two variable-length records — the legacy GeoTIFF key VLR that older producers write, or the OGC WKT VLR that LAS 1.4 prefers — and a bit in the public header block (`global_encoding` bit 4) declares which one is authoritative. Write new coordinates without updating those records and you ship a file whose points are UTM/NAVD88 and whose header still swears they are WGS84; every reader then does something defensible and different.

<figure class="diagram">
<svg viewBox="10 12 740 276" role="img" aria-labelledby="wgs-vlr-t wgs-vlr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wgs-vlr-t">Where a LAS file keeps its CRS, and which record wins</title>
  <desc id="wgs-vlr-d">A LAS 1.4 file holds its public header block, then optionally a legacy GeoTIFF key variable-length record, an OGC WKT variable-length record, and finally the point records. Readers prefer the WKT record when global encoding bit 4 is set; if both records exist and disagree, different readers pick differently and the file becomes ambiguous.</desc>
  <rect class="svg-bg" x="10" y="12" width="740" height="276" fill="#ffffff"/>
  <defs>
    <marker id="wgs-vlr-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="24" y="26" width="250" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="24" y="94" width="250" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="24" y="162" width="250" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="24" y="230" width="250" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="430" y="40" width="306" height="76" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <rect x="430" y="166" width="306" height="76" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#wgs-vlr-a)">
    <path d="M274 52 C 340 52 360 68 428 78"/>
    <path d="M274 188 C 340 188 360 196 428 204"/>
    <path d="M274 120 C 340 120 360 150 428 196"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="149" y="47"><tspan x="149" dy="0">public header block</tspan><tspan x="149" dy="16">global_encoding bit 4 → WKT</tspan></text>
    <text x="149" y="115"><tspan x="149" dy="0">VLR: GeoTIFF keys</tspan><tspan x="149" dy="16">legacy producers</tspan></text>
    <text x="149" y="183"><tspan x="149" dy="0">VLR: OGC WKT</tspan><tspan x="149" dy="16">LAS 1.4 preferred</tspan></text>
    <text x="149" y="257">point records — X, Y, Z</text>
    <text x="583" y="66"><tspan x="583" dy="0">header.parse_crs() returns the WKT record</tspan><tspan x="583" dy="16">when the bit is set, and otherwise falls</tspan><tspan x="583" dy="16">back to the GeoTIFF keys</tspan></text>
    <text x="583" y="192"><tspan x="583" dy="0">Both present and disagreeing: readers split.</tspan><tspan x="583" dy="16">add_crs() rewrites the WKT record — set the</tspan><tspan x="583" dy="16">bit and drop the stale GeoTIFF keys.</tspan></text>
  </g>
</svg>
<figcaption>Two records can describe the CRS and a header bit decides which one counts. Rewriting coordinates without rewriting both is how a file ends up meaning two things at once.</figcaption>
</figure>

## Expected Output & Verification

For the Empire State Building input (lon −73.985428, lat 40.748817), step 1 prints easting/northing close to:

```
E=585015.637  N=4511322.207
```

UTM 18N eastings for the New York City area fall in the 580000–590000 m band and northings near 4.51 million m — if your output is off by a UTM zone (500000 m false easting jumps) or has E and N swapped, you have an axis-order bug. The full batch from step 2 should land every point in the same band.

The round-trip in step 4 must satisfy `residual.max() < 1e-9` degrees (well under 0.1 mm on the ground). For the 3D case, sanity-check the geoid correction: in the NYC area the NAVD88 geoid undulation is roughly −33 m, so an ellipsoidal height of 15.2 m should yield an orthometric height near 48 m. If `ortho_h` equals the input height unchanged, the vertical transform did not run — confirm with:

```python
print(round(coords_wgs84[0, 2] - ortho_h[0], 1), "m geoid separation")  # ~ +33.x
```

Beyond the automated checks, validate against ground truth before trusting a batch in production. Transform three to five surveyed control points (GCPs) whose local easting/northing you already know and compare; for engineering-grade twins the discrepancy should stay within ±2 cm horizontally. You can also inspect the projection's distortion directly with `projinfo -o PROJ EPSG:32618` to read the scale factor and false easting/northing that PROJ will apply, and record the source EPSG, target EPSG, PROJ version, and grid-file names alongside the dataset so the transformation is reproducible and auditable later.

## Common Errors

**Coordinates land in the ocean / off by thousands of km.** You omitted `always_xy=True`, so PROJ used EPSG:4326's authority axis order (latitude, longitude) and you fed it (longitude, latitude). The easting/northing come out transposed or wildly wrong. Fix: always pass `always_xy=True` to `Transformer.from_crs`, and order your tuples as (lon, lat).

**`pyproj.exceptions.ProjError: Cannot find ... us_noaa_g2018u0.tif`** when targeting the compound EPSG:32618+5703. PROJ needs the NAVD88 geoid grid and cannot reach it offline. Fix: enable network resolution with `pyproj.network.set_network_enabled(True)` (or env var `PROJ_NETWORK=ON`), or pre-download the grid into your `PROJ_DATA` directory with `projsync --file us_noaa_g2018u0.tif`.

**`pyproj.exceptions.CRSError: Invalid projection: EPSG:32618+5703`** on older stacks. Compound EPSG codes joined with `+` require `pyproj>=3.0` and PROJ 7+. Fix: upgrade to `pyproj>=3.6`, or build the compound explicitly with `CRS.from_epsg(32618) + CRS.from_epsg(5703)` if your version predates the string syntax.

## Frequently Asked Questions

### How do I pick the right UTM zone (and EPSG code) for my site?

UTM zones are 6° wide; the zone number is `floor((longitude + 180) / 6) + 1`, with EPSG:326xx for the northern hemisphere and EPSG:327xx for the south. Longitude −73.99 gives zone 18N → EPSG:32618. For sites that straddle a zone boundary or span more than a degree or two, a single UTM zone introduces scale distortion at the edges — prefer a national grid or a custom Transverse Mercator. See [how to choose a CRS for urban digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) for the full decision.

### Do I always need the compound vertical CRS, or can I project 2D and fix height later?

If your twin only needs horizontal alignment (footprints, plan-view tiling), the 2D EPSG:4326 → EPSG:32618 transform is enough and you can leave Z as the stored ellipsoidal height. The moment you do elevation-dependent analysis — flood, line-of-sight, solar, volumetrics — you must convert to orthometric height via a compound CRS like EPSG:32618+5703, because mixing ellipsoidal and orthometric heights introduces tens of metres of error from geoid undulation.

### Why is `always_xy=True` necessary if my coordinates look fine without it?

They look fine only by coincidence of your test data, or because the target CRS happens to be easting-first. EPSG:4326 is officially latitude-first in the PROJ database, so the default behaviour expects `(lat, lon)`. Setting `always_xy=True` makes both the source and target use longitude/easting-first order, which matches how nearly all GIS data and code is written and removes the ambiguity entirely.

## Related Guides

- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — datum management and transformation strategy
- [How to Choose CRS for Urban Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) — selecting the target projection
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — density targets for the LiDAR you reproject
- [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) — the spatial baseline this fits into

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
