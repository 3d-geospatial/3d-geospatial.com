# Asserting CRS and units with pyproj before tiling

This guide uses `pyproj` to assert that a dataset's coordinate reference system is a projected, metric system — not geographic degrees — before a single tile is generated: inspecting `CRS.is_projected` and `axis_info` unit names, round-tripping a control point to prove the transform is metric and lossless, and failing fast when the answer is wrong. EPSG:32618 (UTM 18N, metres) passes; EPSG:4326 (WGS84, degrees) is rejected outright. You hit this whenever data arrives from an upstream source with a CRS you did not set yourself, because a point cloud or mesh silently in degrees produces a `geometricError` measured in fractions of a degree — a number that is meaningless to a renderer and corrupts every downstream LOD decision.

The check is cheap and belongs at the very front of the pipeline, before tiling spends minutes on data it should have rejected in milliseconds. It is the CRS gate from the [data validation and QA gates](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) set, worked in full.

## Prerequisites

- Python 3.10+ with `pyproj` 3.6+ (which bundles a recent PROJ database). Pin it, because different PROJ releases can resolve axis metadata differently.
- A dataset whose CRS you can obtain as an EPSG code, a WKT string, or a PROJ string — from a `.laz` header, a GeoTIFF, or a sidecar `.prj`. The examples use EPSG:32618 as the accepted case and EPSG:4326 as the rejected one.
- A known control point in the dataset's projected CRS to round-trip. Any interior survey point works; the check does not need ground truth, only invertibility and metric spacing.
- The tiling CRS you are targeting downstream — for CesiumJS that is ultimately EPSG:4978 (geocentric WGS84, metres), reached via EPSG:4979. This preflight guards the *source* CRS so the reprojection into EPSG:4978 starts from metres.

## Step-by-Step

### 1. Resolve the declared CRS with pyproj

Accept whatever form the CRS arrives in — EPSG code, WKT, or PROJ string — and normalize it to a `pyproj.CRS` object. `from_user_input` handles all three, so the rest of the checks are form-agnostic.

```python
from pyproj import CRS

def resolve_crs(crs_like):
    """Normalize an EPSG int, WKT, or PROJ string to a pyproj CRS."""
    crs = CRS.from_user_input(crs_like)
    print(f"resolved: {crs.name} (EPSG:{crs.to_epsg()})")
    return crs

source_crs = resolve_crs(32618)          # or a WKT string from a .prj sidecar
```

The resolved CRS also exposes its valid extent through `area_of_use`, which is worth checking against a control point: a dataset whose coordinates fall outside the CRS's declared bounding box is almost always mislabelled. UTM zone 18N is only valid for a six-degree longitude band, so a point that lands in Europe under an EPSG:32618 label signals a wrong tag before any transform runs.

```python
def assert_within_extent(crs, lon, lat):
    aou = crs.area_of_use
    if aou and not (aou.west <= lon <= aou.east and aou.south <= lat <= aou.north):
        raise ValueError(f"lon/lat {lon},{lat} outside {crs.name} extent "
                         f"[{aou.west},{aou.south},{aou.east},{aou.north}]")
    return True

assert_within_extent(source_crs, -74.0, 40.7)   # inside UTM 18N -> passes
```

### 2. Assert the CRS is projected, not geographic

A geographic CRS expresses position in degrees of latitude and longitude, where a degree of longitude shrinks from about 111 km at the equator to zero at the poles — so a distance is not a fixed length. `CRS.is_projected` is the primary gate. Reject anything geographic before going further.

```python
def assert_projected(crs):
    if crs.is_geographic:
        raise ValueError(
            f"{crs.name} (EPSG:{crs.to_epsg()}) is geographic degrees; "
            "tiling needs a projected metric CRS such as EPSG:32618")
    if not crs.is_projected:
        raise ValueError(f"{crs.name} is neither projected nor recognised")
    return True

assert_projected(source_crs)             # EPSG:32618 -> passes
```

### 3. Assert the linear unit is the metre

Projected does not guarantee metres — some state-plane and legacy systems use US survey feet, which silently scales every coordinate by 0.3048. Inspect each axis's `unit_name` via `axis_info` and require metres on the horizontal axes.

```python
def assert_metric(crs):
    horizontal = [ax for ax in crs.axis_info
                  if ax.abbrev.upper() in {"E", "N", "X", "Y"}]
    units = {ax.unit_name for ax in horizontal}
    if not units <= {"metre", "meter"}:
        raise ValueError(f"{crs.name} horizontal units are {units}, need metres")
    return True

assert_metric(source_crs)                # EPSG:32618 axes are 'metre' -> passes
```

### 4. Round-trip a control point to prove the transform is metric and lossless

Introspection tells you what the CRS *claims*; a round-trip proves the transform *behaves*. Send a control point to geographic EPSG:4326 and back, assert the residual is sub-millimetre, and confirm that a known metric offset stays metric — two points 100 m apart must remain 100 m apart in the projected frame.

```python
import numpy as np
from pyproj import Transformer

def assert_roundtrip(crs, easting, northing):
    fwd = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    inv = Transformer.from_crs("EPSG:4326", crs, always_xy=True)

    lon, lat = fwd.transform(easting, northing)
    e2, n2 = inv.transform(lon, lat)
    residual = float(np.hypot(e2 - easting, n2 - northing))
    if residual > 1e-3:                              # > 1 mm means a broken transform
        raise ValueError(f"round-trip residual {residual*1e3:.3f} mm too large")

    # A 100 m offset in the projected frame must survive as ~100 m.
    span = float(np.hypot(*(np.array(inv.transform(*fwd.transform(
        easting + 100.0, northing))) - [easting, northing])))
    if not 99.5 < span < 100.5:
        raise ValueError(f"100 m offset became {span:.2f} m; units are not metres")
    return residual

r = assert_roundtrip(source_crs, 583_000.0, 4_507_000.0)   # interior UTM 18N point
print(f"round-trip residual {r*1e3:.4f} mm")
```

### 5. Compose a fail-fast preflight

Chain the checks into one function that raises on the first failure, and call it before tiling. EPSG:32618 clears every check; EPSG:4326 is rejected at the projection check and never reaches the tiler.

```python
def crs_preflight(crs_like, control_e, control_n):
    crs = resolve_crs(crs_like)
    assert_projected(crs)
    assert_metric(crs)
    assert_roundtrip(crs, control_e, control_n)
    print(f"CRS preflight passed: EPSG:{crs.to_epsg()} is projected metres")
    return crs

crs_preflight(32618, 583_000.0, 4_507_000.0)     # accepted
# crs_preflight(4326, -74.0, 40.7)               # ValueError: geographic degrees
```

<figure class="diagram">
<svg viewBox="0 0 760 320" role="img" aria-labelledby="crs-t crs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crs-t">CRS preflight accepting EPSG:32618 and rejecting EPSG:4326</title>
  <desc id="crs-d">EPSG:32618 passes the projected, metric-unit, and round-trip checks and is accepted for tiling, while EPSG:4326 fails the projected check immediately and is rejected without tiling.</desc>
  <defs>
    <marker id="crs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#crs-arrow)">
    <line x1="195" y1="74" x2="195" y2="88"/>
    <line x1="195" y1="132" x2="195" y2="146"/>
    <line x1="195" y1="190" x2="195" y2="204"/>
    <line x1="195" y1="242" x2="195" y2="256"/>
    <line x1="565" y1="74" x2="565" y2="88"/>
    <line x1="565" y1="132" x2="565" y2="146"/>
  </g>
  <rect x="60" y="30" width="270" height="42" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="90" y="90" width="210" height="40" rx="8"/>
    <rect x="90" y="148" width="210" height="40" rx="8"/>
    <rect x="90" y="206" width="210" height="40" rx="8"/>
    <rect x="90" y="258" width="210" height="46" rx="8"/>
  </g>
  <rect x="430" y="30" width="270" height="42" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="460" y="90" width="210" height="40" rx="8"/>
    <rect x="460" y="148" width="210" height="46" rx="8"/>
  </g>
  <g fill="#15384a" font-size="13" text-anchor="middle">
    <text x="195" y="56">EPSG:32618 — UTM 18N, metres</text>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="565" y="56">EPSG:4326 — WGS84, degrees</text>
    <text x="195" y="115">is_projected: True</text>
    <text x="195" y="173">axis unit: metre</text>
    <text x="195" y="231">round-trip: 0.0 mm</text>
    <text x="195" y="286">Accept — proceed to tile</text>
    <text x="565" y="115">is_projected: False</text>
    <text x="565" y="176">Reject — fail fast, do not tile</text>
  </g>
</svg>
<figcaption>EPSG:32618 clears the projected, metric, and round-trip checks and is tiled; EPSG:4326 fails the first check and is rejected before any tiling work begins.</figcaption>
</figure>

## Expected Output & Verification

Run the preflight on the accepted and rejected cases and confirm the verdicts. The projected metric CRS prints a residual near zero and passes; the geographic CRS raises with a clear message.

```python
# Accepted case.
crs_preflight(32618, 583_000.0, 4_507_000.0)

# Rejected case — capture the failure to prove the gate fires.
try:
    crs_preflight(4326, -74.0, 40.7)
    print("ERROR: EPSG:4326 should have been rejected")
except ValueError as err:
    print("correctly rejected:", err)
```

```text
resolved: WGS 84 / UTM zone 18N (EPSG:32618)
round-trip residual 0.0001 mm
CRS preflight passed: EPSG:32618 is projected metres
resolved: WGS 84 (EPSG:4326)
correctly rejected: WGS 84 (EPSG:4326) is geographic degrees; tiling needs a projected metric CRS such as EPSG:32618
```

The round-trip residual for a well-formed projected CRS is sub-micron in practice; anything above a millimetre signals a malformed transform. The 100 m offset check returns a span within half a metre of 100 for a true metric CRS and collapses to a tiny fraction of a degree for a geographic one.

## Common Errors

**`CRSError: Invalid projection: unknown`.** The CRS string handed to `from_user_input` is malformed or empty — often a missing `.prj` sidecar read as an empty string. Confirm the dataset actually carries a CRS before asserting anything about it; treat a missing CRS as a hard failure, not a default to EPSG:4326, because assuming a CRS is exactly the silent error this gate exists to prevent.

**A projected CRS in US survey feet passes `is_projected` but tiles at the wrong scale.** `is_projected` is true for foot-based state-plane systems, so projection alone is insufficient. The `assert_metric` check catches it by reading `axis_info` unit names, which report `US survey foot` rather than `metre`; keep that check in the chain and never rely on `is_projected` by itself.

**The round-trip residual is large for a legitimate CRS.** Usually an axis-order mistake — `always_xy=True` was omitted, so `pyproj` returned coordinates in the CRS's declared latitude-longitude order and the round-trip mixed easting with northing. Always pass `always_xy=True` to the transformers so the code consistently uses (x, y) / (lon, lat) order, and the residual falls back to sub-millimetre.

**A compound CRS passes the horizontal checks but hides a vertical-datum surprise.** A system like EPSG:32618+5703 carries a projected horizontal component in metres and a separate vertical datum; `is_projected` and the metre check pass on the horizontal axes while the height axis follows its own reference surface. When elevations matter, assert the specific compound EPSG code you expect rather than only the horizontal one, so an ellipsoidal height is never mistaken for an orthometric one downstream — the vertical side of this is covered in [handling vertical datums and geoid separation](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/).

## Related Guides

- [Data Validation & QA Gates for 3D Tiles](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) — the full set of blocking gates this preflight joins
- [Writing 3D Tiles Validator Checks in CI](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — verifying the output transform resolves to EPSG:4978
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — choosing and enforcing the projected CRS this gate assumes

Back to [Data Validation & QA Gates for 3D Tiles](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
