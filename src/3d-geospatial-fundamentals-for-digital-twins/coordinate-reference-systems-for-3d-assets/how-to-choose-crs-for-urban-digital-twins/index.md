---
title: "How to Choose CRS for Urban Digital Twins"
description: "A decision guide for picking the internal CRS of an urban digital twin: projected metric system, vertical datum, scale-factor/distortion checks in pyproj, EPSG codes."
---
# How to choose CRS for urban digital twins

Choosing a CRS for an urban digital twin means selecting one authoritative **projected metric system** plus an explicit **orthometric vertical datum** to store all geometry in, then reprojecting to WGS84 only at the web-delivery boundary. This guide walks the decision end to end — shortlisting candidate EPSG codes for your city, measuring the scale factor and linear distortion with `pyproj`, picking the vertical datum, choosing between a UTM zone, a national grid, and a local engineering grid, and recording the result so every downstream stage inherits the same frame.

## Why you hit this

The internal CRS is the one decision that touches every layer of a twin — point cloud ingest, terrain rasters, mesh tiling, spatial queries, and the rendering matrix. Get it wrong and the symptoms appear late: assets that drift a metre against orthophotos, distances that are off by a consistent few centimetres per hundred metres, or floating-point jitter in WebGL when Easting values cross 6,000,000. Teams default to WGS84 (EPSG:4326) because that is how data arrives, or to Web Mercator (EPSG:3857) because the map renders, and both are wrong for engineering-grade storage. A projected grid with a known, small scale factor across your bounding box fixes all of these at once, but only if you measure the distortion for *your* location rather than trusting the zone label.

## Prerequisites

- Python 3.10+ with `pyproj>=3.6` (which bundles PROJ 9.x) and `numpy>=1.24`.
- The city's approximate bounding box in geographic coordinates (WGS84 / EPSG:4326), e.g. min/max longitude and latitude.
- A known horizontal candidate or two to test — typically a UTM zone (EPSG:326xx / 327xx), a national grid (EPSG:25832, EPSG:2154, EPSG:27700, EPSG:2056), and any local low-distortion engineering grid your survey team already uses.
- The relevant vertical datum for the region (NAVD88 / EPSG:5703, EVRF2007 / EPSG:5621, or a geoid model such as EGM2008).
- PROJ transformation grids installed (`projsync --source-id all` or your packaged grids) so datum shifts are accurate rather than approximate.

## Step-by-Step

### 1. Shortlist candidate EPSG codes from the city's location

Start from the bounding box and let `pyproj` enumerate the projected CRS that officially cover it. This turns "which UTM zone?" into a verified list instead of a guess.

```python
from pyproj.database import query_utm_crs_info, query_crs_info
from pyproj.aoi import AreaOfInterest

# Bounding box for the city (WGS84 / EPSG:4326): west, south, east, north
oslo_aoi = AreaOfInterest(west_lon_degree=10.55, south_lat_degree=59.80,
                          east_lon_degree=10.95, north_lat_degree=60.00)

utm = query_utm_crs_info(datum_name="WGS 84", area_of_interest=oslo_aoi)
for c in utm:
    print(c.auth_name, c.code, "-", c.name)
# -> EPSG 32632 - WGS 84 / UTM zone 32N  (Oslo falls in zone 32N)
```

Note the candidates that come back, then add the national grid you know applies (for Norway, EPSG:25832 = ETRS89 / UTM zone 32N) and any local engineering grid. You now have three contenders to measure.

### 2. Compute the scale factor and linear distortion with pyproj

The defining number for an urban twin is how much the projection stretches or shrinks ground distances across your extent. For a Transverse Mercator zone, the point scale factor is 1.0 only on a couple of lines; elsewhere it deviates. Measure it at several points across the bounding box.

```python
import numpy as np
from pyproj import CRS, Transformer
from pyproj import Proj

def distortion_grid(epsg, west, south, east, north, n=4):
    proj = Proj(CRS.from_epsg(epsg))
    lons = np.linspace(west, east, n)
    lats = np.linspace(south, north, n)
    rows = []
    for lat in lats:
        for lon in lons:
            factors = proj.get_factors(lon, lat)
            k = factors.meridional_scale          # point scale factor
            ppm = (k - 1.0) * 1e6                  # distortion in parts per million
            rows.append((lon, lat, k, ppm))
    return np.array(rows)

g = distortion_grid(32632, 10.55, 59.80, 10.95, 60.00)
print("scale factor range:", g[:, 2].min().round(6), "-", g[:, 2].max().round(6))
print("max |distortion| ppm:", np.abs(g[:, 3]).max().round(1))
# A spread under ~200 ppm (1:5000) across the city is comfortable for a metric twin.
```

A scale factor within roughly 1:10,000 (100 ppm) over the whole footprint is the usual engineering target; UTM near a zone edge can exceed that, which is the signal to consider a local grid (step 4).

<figure class="diagram">
<svg viewBox="100 -10 540 322" role="img" aria-labelledby="crs-zone-t crs-zone-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crs-zone-t">Where a city sits inside a UTM zone decides its distortion</title>
  <desc id="crs-zone-d">A six-degree UTM zone with its central meridian at scale factor 0.9996 and two standard lines where the scale factor is exactly one. A city near the central meridian carries about minus forty parts per million of distortion; a city near the zone edge carries about plus three hundred and ninety.</desc>
  <rect class="svg-bg" x="100" y="-10" width="540" height="322" fill="#ffffff"/>
  <defs>
    <marker id="crs-zone-a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <line x1="120" y1="26" x2="600" y2="26" stroke="#5b6471" stroke-width="1.5"
        marker-start="url(#crs-zone-a)" marker-end="url(#crs-zone-a)"/>
  <text x="360" y="18" fill="#5b6471" font-size="12" text-anchor="middle">6° of longitude</text>
  <rect x="120" y="40" width="480" height="200" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <line x1="360" y1="40" x2="360" y2="240" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4"/>
  <line x1="270" y1="40" x2="270" y2="240" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="450" y1="40" x2="450" y2="240" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="330" y="150" width="60" height="40" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="528" y="86" width="60" height="40" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="360" y="62" fill="#1f6b8a" font-size="11.5" text-anchor="middle">central meridian · k₀ = 0.9996</text>
  <text x="270" y="228" fill="#4f7a4d" font-size="11.5" text-anchor="middle">k = 1</text>
  <text x="450" y="228" fill="#4f7a4d" font-size="11.5" text-anchor="middle">k = 1</text>
  <text x="240" y="268" fill="#4f7a4d" font-size="12" text-anchor="middle">City A, astride the central meridian: −40 ppm</text>
  <text x="520" y="268" fill="#9a4f26" font-size="12" text-anchor="middle">City B, near the zone edge: +390 ppm</text>
  <text x="360" y="294" fill="#5b6471" font-size="12" text-anchor="middle">Distortion is a property of where you sit in the zone, never of the zone's name</text>
</svg>
<figcaption>Two cities, one zone, an order of magnitude between their distortions. This is why the number has to be measured at your bounding box rather than inferred from the EPSG code.</figcaption>
</figure>

The asymmetry in those numbers is worth reading carefully. Transverse Mercator shrinks distances between the two standard lines and stretches them outside, so a city straddling the central meridian sits in a shallow negative trough while a city near the zone edge climbs a steep positive slope. Because the slope steepens toward the edge, a footprint near the boundary sees a much wider *spread* of distortion across itself, not merely a larger average — and it is the spread, not the mean, that shows up as inconsistent measurements between neighbourhoods. A constant scale correction can absorb an offset; it cannot absorb a gradient.

### 3. Check the vertical datum and pair it as a compound CRS

Horizontal choice is only half the frame. Decide the vertical datum explicitly and bind it to the horizontal one so a single EPSG identifier carries both.

```python
from pyproj import CRS, Transformer

# ETRS89 / UTM 32N (EPSG:25832) horizontal + NN2000 / EVRF-style orthometric height.
# Build a compound CRS from horizontal + vertical components:
horizontal = CRS.from_epsg(25832)
vertical   = CRS.from_epsg(5941)          # NN2000 height (Norway); EVRF2007 = 5621
compound   = CRS.from_user_input(f"{horizontal.to_epsg()}+{vertical.to_epsg()}")
print(compound.is_compound, "->", compound.name)

# Confirm a transform exists from your ingest CRS (e.g. ellipsoidal WGS84 3D, EPSG:4979)
t = Transformer.from_crs("EPSG:4979", compound, always_xy=True)
lon, lat, ell_h = 10.75, 59.91, 60.0       # ellipsoidal height from GNSS/RTK
e, n, ortho = t.transform(lon, lat, ell_h)
print(f"E={e:.3f} N={n:.3f} orthometric_h={ortho:.3f}")
```

If `is_compound` is false or the transform raises, the vertical component is missing or its geoid grid is not installed — fix that before any elevation-dependent data lands.

### 4. Decide between UTM, national grid, and a local engineering grid

With distortion numbers in hand, choose using the table below. The deciding factor is almost always the distortion spread across your footprint weighed against your need for national interoperability.

| Criterion | UTM zone (e.g. EPSG:32632) | National grid (e.g. EPSG:25832, EPSG:2154) | Local engineering grid (custom TM) |
|---|---|---|---|
| Scale distortion across a city | Up to ~400 ppm; worse near zone edges | Tuned for the country, often <250 ppm | Designed for ~0 ppm at site (lowest) |
| Datum currency | WGS84-realised, drifts with plates | ETRS89/national, plate-fixed and stable | Whatever you anchor it to |
| National data interoperability | Good (global, well-known) | Best (matches open-data portals, cadastre) | Poor (bespoke, needs published params) |
| Spans multiple zones cleanly | No — breaks at 6° boundaries | Yes within the country | Yes within the project extent |
| Setup effort | None (off the shelf) | None (off the shelf) | High (define & publish projection params) |
| Best for | Single-zone cities, quick start | Most municipal twins in-country | High-precision survey/BIM, edge cities |

<figure class="diagram">
<svg viewBox="2 0 754 294" role="img" aria-labelledby="crs-tree-t crs-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crs-tree-t">Decision tree for an urban twin's internal horizontal CRS</title>
  <desc id="crs-tree-d">If a single national grid covers the extent and cadastre alignment is required, pick the national grid. If alignment is not required and measured distortion is within tolerance, a plain UTM zone is enough. When no single grid covers the extent or distortion exceeds tolerance, design a local low-distortion Transverse Mercator anchored at the city centroid.</desc>
  <rect class="svg-bg" x="2" y="0" width="754" height="294" fill="#ffffff"/>
  <defs>
    <marker id="crs-tree-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="122" width="190" height="64" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="250" y="34" width="190" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="250" y="206" width="190" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="490" y="14" width="252" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="490" y="118" width="252" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="490" y="224" width="252" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#crs-tree-a)">
    <path d="M206 140 C 226 106 226 88 248 70"/>
    <path d="M206 168 C 226 202 226 220 248 238"/>
    <path d="M440 56 C 460 50 468 46 488 42"/>
    <path d="M440 82 C 462 100 466 118 488 136"/>
    <path d="M440 228 C 462 202 466 172 488 152"/>
    <line x1="440" y1="252" x2="488" y2="252"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="111" y="148"><tspan x="111" dy="0">Does one national grid</tspan><tspan x="111" dy="16">cover the whole extent?</tspan></text>
    <text x="345" y="60"><tspan x="345" dy="0">Must it align with the</tspan><tspan x="345" dy="16">cadastre / open data?</tspan></text>
    <text x="345" y="232"><tspan x="345" dy="0">Measured distortion</tspan><tspan x="345" dy="16">under 250 ppm?</tspan></text>
    <text x="616" y="38"><tspan x="616" dy="0">National grid — EPSG:25832,</tspan><tspan x="616" dy="16">2154, 27700, 2056</tspan></text>
    <text x="616" y="142"><tspan x="616" dy="0">UTM zone — EPSG:326xx / 327xx</tspan><tspan x="616" dy="16">off the shelf, no setup</tspan></text>
    <text x="616" y="248"><tspan x="616" dy="0">Local low-distortion TM</tspan><tspan x="616" dy="16">anchored at the centroid</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="228" y="106">yes</text>
    <text x="228" y="200">no</text>
    <text x="465" y="42">yes</text>
    <text x="465" y="104">no</text>
    <text x="465" y="196">yes</text>
    <text x="465" y="244">no</text>
  </g>
</svg>
<figcaption>Two questions decide it in almost every case: whether one published grid covers the extent, and whether the measured distortion fits inside your survey tolerance.</figcaption>
</figure>

For most in-country municipal twins, the national grid (EPSG:25832 in much of central Europe, EPSG:2154 / RGF93 Lambert-93 in France, EPSG:27700 in Great Britain, EPSG:2056 in Switzerland) is the right default: stable datum, low distortion, and alignment with the cadastre and open data. Reach for a local engineering grid only when distortion or survey tolerance demands it; accept a plain UTM zone (EPSG:32632, EPSG:32633) when a single zone covers the city and quick interoperability outranks the last few ppm.

### 5. Document the authoritative CRS and the reprojection boundary

Record the chosen compound EPSG as the single source of truth and state where reprojection happens. Storage and analysis stay in the projected grid; conversion to WGS84 3D (EPSG:4979) or EPSG:4326 happens only when generating 3D Tiles or a CesiumJS scene.

```python
import json
from pyproj import CRS

manifest = {
    "internal_crs": "EPSG:25832+5941",        # ETRS89/UTM32N + NN2000 height
    "internal_crs_name": CRS.from_user_input("EPSG:25832+5941").name,
    "web_delivery_crs": "EPSG:4979",          # reproject ONLY at the tiling layer
    "max_distortion_ppm": 230,
    "vertical_is_orthometric": True,
    "proj_grids_required": ["no_kv_NN2000.tif", "eur_nkg_NKG2008.tif"],
}
with open("crs_manifest.json", "w") as f:
    json.dump(manifest, f, indent=2)
print("authoritative CRS pinned:", manifest["internal_crs"])
```

Commit this manifest alongside the pipeline so every ingest, query, and export job reads the CRS from one place rather than hard-coding it.

<figure class="diagram">
<svg viewBox="1 6 758 178" role="img" aria-labelledby="crscrs-t crscrs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crscrs-t">CRS decision and reprojection boundary</title>
  <desc id="crscrs-d">Candidate EPSG codes are filtered by scale-factor distortion and vertical datum into one authoritative projected compound CRS used for storage and analysis, which is reprojected to WGS84 3D only at the web-tiling layer.</desc>
  <rect class="svg-bg" x="1" y="6" width="758" height="178" fill="#ffffff"/>
  <defs>
    <marker id="crscrs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="15" y="40" width="180" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="290" y="40" width="180" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="565" y="20" width="180" height="55" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="565" y="115" width="180" height="55" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#crscrs-arrow)">
    <line x1="195" y1="75" x2="288" y2="75"/>
    <line x1="470" y1="62" x2="563" y2="47"/>
    <line x1="470" y1="88" x2="563" y2="140"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="105" y="68"><tspan x="105" dy="0">Candidate EPSG</tspan><tspan x="105" dy="16">(UTM / national / local)</tspan></text>
    <text x="380" y="62"><tspan x="380" dy="0">Authoritative projected</tspan><tspan x="380" dy="16">compound CRS</tspan></text>
    <text x="655" y="44">Storage &amp; analysis</text>
    <text x="655" y="139"><tspan x="655" dy="0">Web tiling →</tspan><tspan x="655" dy="16">EPSG:4979</tspan></text>
  </g>
  <text x="380" y="135" fill="#5b6471" font-size="12" text-anchor="middle">filter by scale factor + vertical datum</text>
</svg>
<figcaption>One projected compound CRS holds all geometry; reprojection to WGS84 3D happens only at the web-tiling boundary.</figcaption>
</figure>

## Expected Output & Verification

Run the distortion check and confirm the spread is within tolerance, then assert the compound CRS resolves and round-trips:

```python
from pyproj import CRS, Transformer

crs = CRS.from_user_input("EPSG:25832+5941")
assert crs.is_compound, "vertical datum not bound — compound CRS expected"

fwd = Transformer.from_crs("EPSG:4979", crs, always_xy=True)
inv = Transformer.from_crs(crs, "EPSG:4979", always_xy=True)
e, n, h = fwd.transform(10.75, 59.91, 60.0)
lon2, lat2, h2 = inv.transform(e, n, h)
assert abs(10.75 - lon2) < 1e-8 and abs(59.91 - lat2) < 1e-8, "round-trip drift"
print(f"OK  E={e:.3f}  N={n:.3f}  ortho_h={h:.3f}")
```

Expected console output resembles:

```
scale factor range: 0.99966 - 1.00012
max |distortion| ppm: 130.4
OK  E=599094.357  N=6643221.518  ortho_h=18.214
```

A distortion figure comfortably under your target (here ~130 ppm against a 100–250 ppm budget), a true `is_compound`, and a sub-microdegree round-trip residual together confirm the CRS is fit to store the twin.

## Common Errors

**`pyproj.exceptions.CRSError: Invalid projection: EPSG:25832+5941`** — the `+` compound syntax needs a horizontal *and* a valid vertical code; one of them is wrong, or your PROJ build predates compound-from-EPSG support. Fix by confirming each code resolves alone (`CRS.from_epsg(5941)`) and upgrading to `pyproj>=3.4` / PROJ 9.

**`Inverse transformation has not been found, ... ballpark`** plus heights off by 30–50 m — the geoid/vertical grid is missing, so PROJ fell back to an approximate (ballpark) transform. Run `projsync --source-id all` or place the named grid (e.g. `eur_nkg_NKG2008.tif`) where PROJ can find it, and pass `only_best=True` to refuse ballpark results.

**Easting/Northing swapped, points land in the ocean** — axis order. Geographic CRS in PROJ are lat/lon by authority, but most tooling expects lon/lat. Always build transformers with `always_xy=True` so coordinates stay (x=easting/lon, y=northing/lat).

## Frequently Asked Questions

### Should I use UTM or my national grid for a city twin?

If your city sits inside one UTM zone and you want zero setup, a UTM zone such as EPSG:32632 or EPSG:32633 is fine. For a twin that must align with the national cadastre, open-data portals, or neighbouring municipalities, prefer the national grid (EPSG:25832, EPSG:2154, EPSG:27700, EPSG:2056) — it uses a plate-fixed datum and typically lower distortion. Only move to a local engineering grid when measured distortion exceeds your tolerance.

### Why not just store everything in WGS84 (EPSG:4326)?

Geographic degrees are not metric: a degree of longitude shrinks toward the poles, so spatial indexing, buffering, and volumetric math are all non-linear, and large coordinate magnitudes cause floating-point jitter in rendering. Keep WGS84 for the web-delivery boundary only and store geometry in a projected metric CRS.

### How small does the scale-factor distortion need to be?

Aim for the point scale factor to stay within about 1:10,000 (≈100 ppm) across the whole footprint, with up to ~250 ppm acceptable for many municipal twins. If a single projection cannot hold that across a large or edge-of-zone city, design a local low-distortion Transverse Mercator anchored at the city centroid, or split the twin by zone.

## Related Guides

- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the transform mechanics once the CRS is chosen
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — datum management and transformation strategy
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — where the vertical datum decision lands in terrain
- [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) — how CRS choice fits the full ingestion baseline

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/)
