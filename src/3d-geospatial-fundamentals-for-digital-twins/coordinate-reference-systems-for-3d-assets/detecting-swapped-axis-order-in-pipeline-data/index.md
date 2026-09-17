---
title: "Detecting Swapped Axis Order in Pipeline Data"
description: "Catch latitude/longitude and easting/northing swaps automatically: plausibility bounds, extent tests"
---
# Detecting Swapped Axis Order in Pipeline Data

This page detects swapped coordinate axes before they propagate — the latitude-longitude swap that PROJ's authority ordering invites, the easting-northing swap that survey exports introduce, and the y-flip that image and tile conventions produce — with plausibility bounds, extent comparisons, a land test and assertions cheap enough to put in every ingestion step, for data destined for EPSG:25832+7837.

## Why you hit this

A swapped pair of coordinates produces valid numbers, a valid file and a plausible-looking dataset. That is what makes it the most common silent georeferencing failure in a twin: nothing raises an error, the file passes schema validation, and the data sits in the Gulf of Guinea, in the wrong UTM zone, or mirrored about the diagonal. The `always_xy` flag in `pyproj` exists precisely because the authority definition of EPSG:4326 is latitude-first while almost every file format and API is longitude-first, and every boundary between two systems is an opportunity to get it wrong. The theory is covered in [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/); this page is the detector.

## Prerequisites

- Python 3.10+ with `pyproj>=3.6`, `numpy>=1.24`, `shapely>=2.0`, `geopandas>=0.14`.
- The expected CRS for each dataset, as a compound EPSG code, and ideally the expected extent — a bounding box for the project area.
- Optionally a coastline or administrative boundary layer for the land test.

## Step-by-Step

### 1. Bound each axis by what the CRS allows

```python
import numpy as np
from pyproj import CRS

def axis_bounds(epsg):
    """Plausible value ranges per axis for a CRS, from its own area of use."""
    crs = CRS.from_user_input(epsg)
    aou = crs.area_of_use
    if crs.is_geographic:
        return {"axis_0": (-180.0, 180.0), "axis_1": (-90.0, 90.0),
                "geographic": True, "aou": (aou.west, aou.south, aou.east, aou.north) if aou else None}
    # projected: derive from the area of use, transformed into the CRS
    from pyproj import Transformer
    if aou:
        tf = Transformer.from_crs(4326, crs, always_xy=True)
        xs, ys = tf.transform([aou.west, aou.east, aou.west, aou.east],
                              [aou.south, aou.south, aou.north, aou.north])
        return {"axis_0": (float(min(xs)), float(max(xs))),
                "axis_1": (float(min(ys)), float(max(ys))),
                "geographic": False, "aou": (aou.west, aou.south, aou.east, aou.north)}
    return {"axis_0": (-1e7, 1e7), "axis_1": (-1e7, 1e7), "geographic": False, "aou": None}

for epsg in ("EPSG:4326", "EPSG:25832", "EPSG:32618", "EPSG:2263"):
    b = axis_bounds(epsg)
    print(f"{epsg:<12} x/E {b['axis_0'][0]:>12,.0f} … {b['axis_0'][1]:>12,.0f}   "
          f"y/N {b['axis_1'][0]:>12,.0f} … {b['axis_1'][1]:>12,.0f}")
```

Deriving the bounds from the CRS's own area of use, rather than hard-coding them, is what makes the detector portable across a twin that handles several systems. For a UTM zone the easting range is a few hundred thousand metres wide and the northing range is millions — so a swap is detectable from the magnitudes alone, without any knowledge of the project.

### 2. Test for the three swaps that actually happen

```python
def swap_diagnosis(x, y, epsg, expected_extent=None):
    """Return the most likely axis problem for arrays of coordinates."""
    b = axis_bounds(epsg)
    x, y = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    findings = []

    in_x = ((x >= b["axis_0"][0]) & (x <= b["axis_0"][1])).mean()
    in_y = ((y >= b["axis_1"][0]) & (y <= b["axis_1"][1])).mean()
    swapped_x = ((y >= b["axis_0"][0]) & (y <= b["axis_0"][1])).mean()
    swapped_y = ((x >= b["axis_1"][0]) & (x <= b["axis_1"][1])).mean()

    if in_x < 0.5 and in_y < 0.5 and swapped_x > 0.9 and swapped_y > 0.9:
        findings.append(("critical", "axes are swapped: the values fit the opposite axis"))
    elif in_x < 0.9 or in_y < 0.9:
        findings.append(("critical", f"values outside the CRS area of use "
                                     f"(x within {in_x:.0%}, y within {in_y:.0%})"))

    if b["geographic"] and np.abs(x).max() <= 90 and np.abs(y).max() <= 90:
        findings.append(("warning", "both axes are within ±90: a lat/lon swap cannot be "
                                    "ruled out from magnitudes alone"))

    if expected_extent:
        ew, es, ee, en = expected_extent
        inside = ((x >= ew) & (x <= ee) & (y >= es) & (y <= en)).mean()
        flipped = ((y >= ew) & (y <= ee) & (x >= es) & (x <= en)).mean()
        if flipped > inside:
            findings.append(("critical", f"the flipped pair fits the expected extent better "
                                         f"({flipped:.0%} vs {inside:.0%})"))
        elif inside < 0.9:
            findings.append(("warning", f"only {inside:.0%} of points are inside the expected extent"))

    return findings

# a real case: a survey export written northing-first
E = np.array([5335818.221, 5335836.978, 5335887.874])
N = np.array([691204.412, 691286.901, 691275.305])
for sev, msg in swap_diagnosis(E, N, "EPSG:25832"):
    print(f"{sev.upper()}: {msg}")
```

The three tests answer three different questions. Magnitude bounds catch the UTM swap outright, because eastings and northings live in different numeric ranges. The expected-extent comparison catches the swap that magnitudes cannot — a geographic dataset where both values are small numbers — by asking which assignment fits the project area. And the explicit warning for the ambiguous geographic case is deliberate: near the equator and the prime meridian, no magnitude test can distinguish the two, and a detector that stays silent there is lying by omission.

<figure class="diagram">
<svg viewBox="6 6 748 236" role="img" aria-labelledby="axis-cases-t axis-cases-d" xmlns="http://www.w3.org/2000/svg">
  <title id="axis-cases-t">Three swaps and how each is detected</title>
  <desc id="axis-cases-d">A table. A UTM easting and northing swap is detected by magnitude, because the ranges differ by an order of magnitude. A latitude and longitude swap in temperate latitudes is detected by magnitude when longitude exceeds ninety degrees, and otherwise only by the expected extent or a land test. An image y-flip is detected by comparing against the expected extent, since both values remain plausible.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="236" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="220" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="220" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="240" y="56" width="250" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="490" y="56" width="250" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="100" width="220" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="240" y="100" width="250" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="490" y="100" width="250" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="144" width="220" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="240" y="144" width="250" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="490" y="144" width="250" height="44" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="43">swap</text><text x="365" y="43">how it looks</text><text x="615" y="43">detected by</text>
    <text x="130" y="82">easting ↔ northing</text><text x="365" y="82">5.3 M where 691 k belongs</text><text x="615" y="82">magnitude bounds</text>
    <text x="130" y="120">lat ↔ lon, |lon| &gt; 90</text><text x="365" y="120">latitude above 90</text><text x="615" y="120">magnitude bounds</text>
    <text x="130" y="166">lat ↔ lon near 0,0</text><text x="365" y="158">both values plausible</text>
    <text x="365" y="176">on both axes</text>
    <text x="615" y="158">expected extent or</text><text x="615" y="176">a land test only</text>
  </g>
  <text x="380" y="224" fill="#15384a" font-size="12.5" text-anchor="middle">The last row is why a detector needs an expected extent and not only bounds.</text>
</svg>
<figcaption>Two of the three swaps are arithmetic to detect. The third needs external knowledge, which is why the project extent belongs in the ingestion contract.</figcaption>
</figure>

### 3. Add the land test for the ambiguous case

```python
import geopandas as gpd
from shapely.geometry import MultiPoint

def land_test(lon, lat, land_path="reference/land_polygons.gpkg", sample=500):
    """Fraction of points that fall on land, for both axis assignments."""
    land = gpd.read_file(land_path).to_crs(4326).geometry.union_all()
    lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    idx = np.random.default_rng(11).choice(len(lon), min(sample, len(lon)), replace=False)

    def share_on_land(a, b):
        pts = MultiPoint([(float(x), float(y)) for x, y in zip(a[idx], b[idx])])
        return sum(1 for p in pts.geoms if land.covers(p)) / len(pts.geoms)

    as_given = share_on_land(lon, lat)
    as_flipped = share_on_land(lat, lon)
    return {"as_given_on_land": round(as_given, 3),
            "as_flipped_on_land": round(as_flipped, 3),
            "verdict": ("swapped" if as_flipped > as_given + 0.2
                        else "as given" if as_given > as_flipped + 0.2 else "inconclusive")}

print(land_test([11.5730, 11.5760], [48.1381, 48.1402]))
```

The land test is the fallback when magnitudes and extents cannot decide, and it is decisive for terrestrial data: a city dataset read with swapped axes lands in the sea with high probability, because most of the globe at swapped coordinates is water. It is not decisive for marine or coastal data, which is why the function returns "inconclusive" rather than guessing — an honest non-answer is better than a confident coin flip.

<figure class="diagram">
<svg viewBox="26 26 708 224" role="img" aria-labelledby="axis-land-t axis-land-d" xmlns="http://www.w3.org/2000/svg">
  <title id="axis-land-t">The same coordinates read both ways</title>
  <desc id="axis-land-d">A world outline. Read as longitude 11.57 and latitude 48.14 the point lands in southern Germany, on land. Read with the axes swapped, as longitude 48.14 and latitude 11.57, it lands in the Arabian Sea, in water. The land test uses that asymmetry, and it is inconclusive for coastal and marine datasets where both assignments could be water.</desc>
  <rect class="svg-bg" x="26" y="26" width="708" height="224" fill="#ffffff"/>
  <rect x="40" y="40" width="680" height="150" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <path d="M150 60 C210 55 260 70 300 65 C340 60 380 80 420 78 C460 76 500 92 540 96 C580 100 620 120 660 116 L660 160 C600 156 540 150 480 154 C420 158 360 150 300 148 C240 146 190 140 150 132 Z"
        fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <circle cx="330" cy="92" r="7" fill="#4f7a4d"/>
  <circle cx="560" cy="170" r="7" fill="#b0413e"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="344" y="86">lon 11.57, lat 48.14 — on land</text>
    <text x="440" y="200">lon 48.14, lat 11.57 — in the sea</text>
  </g>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Most of the globe at swapped coordinates is water, which is what makes the test decisive on land.</text>
</svg>
<figcaption>The land test works because the Earth is mostly ocean; for a marine survey it decides nothing and the detector says so.</figcaption>
</figure>

### 4. Assert at every boundary

```python
from pyproj import Transformer

class AxisOrderError(ValueError):
    pass

def assert_axis_order(x, y, epsg, expected_extent=None, context=""):
    findings = swap_diagnosis(x, y, epsg, expected_extent)
    critical = [m for s, m in findings if s == "critical"]
    if critical:
        raise AxisOrderError(f"{context}: " + "; ".join(critical))
    return [m for s, m in findings if s == "warning"]

def transform_checked(x, y, src_epsg, dst_epsg, src_extent=None, dst_extent=None):
    assert_axis_order(x, y, src_epsg, src_extent, context=f"input in {src_epsg}")
    tf = Transformer.from_crs(src_epsg, dst_epsg, always_xy=True)
    out_x, out_y = tf.transform(np.asarray(x, dtype=float), np.asarray(y, dtype=float))
    assert_axis_order(out_x, out_y, dst_epsg, dst_extent, context=f"output in {dst_epsg}")
    return out_x, out_y

MUNICH = (11.30, 48.00, 11.80, 48.30)
lon = np.array([11.5730216, 11.5768])
lat = np.array([48.1381190, 48.1379])
e, n = transform_checked(lon, lat, "EPSG:4326", "EPSG:25832",
                         src_extent=MUNICH, dst_extent=(690000, 5330000, 700000, 5340000))
print("transformed:", np.round(e, 3), np.round(n, 3))
```

Asserting on both sides of a transformation is the pattern worth adopting everywhere. Checking the input catches a file that was already wrong; checking the output catches a transformer constructed without `always_xy`, which is the single most common way to introduce the problem rather than to inherit it. Both checks are microseconds on arrays, so there is no performance reason to skip them.

### 5. Check whole files at ingestion

```python
import json
from pathlib import Path

def check_dataset(path, epsg, expected_extent, kind="vector"):
    if kind == "vector":
        gdf = gpd.read_file(path)
        declared = gdf.crs.to_epsg() if gdf.crs else None
        xs = gdf.geometry.representative_point().x.to_numpy()
        ys = gdf.geometry.representative_point().y.to_numpy()
    elif kind == "pointcloud":
        import laspy
        las = laspy.read(path)
        crs = las.header.parse_crs()
        declared = crs.to_epsg() if crs else None
        xs, ys = np.asarray(las.x), np.asarray(las.y)
    elif kind == "cityjson":
        cj = json.loads(Path(path).read_text())
        ref = (cj.get("metadata", {}) or {}).get("referenceSystem", "")
        declared = int(ref.rstrip("/").split("/")[-1]) if ref else None
        v = np.asarray(cj["vertices"], dtype=float)
        t = cj.get("transform", {"scale": [1, 1, 1], "translate": [0, 0, 0]})
        xs = v[:, 0] * t["scale"][0] + t["translate"][0]
        ys = v[:, 1] * t["scale"][1] + t["translate"][1]
    else:
        raise ValueError(kind)

    result = {"path": str(path), "declared_epsg": declared,
              "expected_epsg": CRS.from_user_input(epsg).to_epsg(),
              "findings": swap_diagnosis(xs, ys, epsg, expected_extent)}
    result["ok"] = not any(s == "critical" for s, _ in result["findings"])
    return result

MUNICH_25832 = (690000, 5330000, 700000, 5340000)
for path, kind in (("deliveries/footprints.gpkg", "vector"),
                   ("deliveries/tile_691_5335.laz", "pointcloud"),
                   ("deliveries/district.city.json", "cityjson")):
    r = check_dataset(path, "EPSG:25832+7837", MUNICH_25832, kind=kind)
    print(f"{'OK  ' if r['ok'] else 'FAIL'} {Path(r['path']).name:<28} "
          f"declared EPSG:{r['declared_epsg']} — "
          f"{'; '.join(m for _, m in r['findings']) or 'no findings'}")
```

Running the same diagnosis over every format at ingestion is what turns a known trap into a solved problem. Using a representative point per feature rather than every vertex keeps it fast on large vector layers, and for point clouds the header's extent alone is usually enough — a swapped cloud has a bounding box whose axes are obviously wrong.

<figure class="diagram">
<svg viewBox="-4 46 678 194" role="img" aria-labelledby="axis-where-t axis-where-d" xmlns="http://www.w3.org/2000/svg">
  <title id="axis-where-t">Where to assert, and what each boundary catches</title>
  <desc id="axis-where-d">A pipeline with four assertion points. At ingestion, the check catches a delivery that is already swapped. Before a transformation, it catches an input the pipeline itself produced wrongly. After a transformation, it catches a transformer built without the explicit axis-order flag. Before publishing, it catches anything introduced in between.</desc>
  <rect class="svg-bg" x="-4" y="46" width="678" height="194" fill="#ffffff"/>
  <defs>
    <marker id="axis-where-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="60" width="120" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="180" y="60" width="130" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="360" y="60" width="130" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="540" y="60" width="120" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#axis-where-arrow)">
    <path d="M130 85 H178"/><path d="M310 85 H358"/><path d="M490 85 H538"/>
  </g>
  <g stroke="#b0413e" stroke-width="2" fill="none">
    <path d="M70 118 V150"/><path d="M245 118 V150"/><path d="M425 118 V150"/><path d="M600 118 V150"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="70" y="82">delivery</text><text x="70" y="100">arrives</text>
    <text x="245" y="82">processing</text><text x="245" y="100">stage</text>
    <text x="425" y="82">reprojection</text><text x="425" y="100">to the twin CRS</text>
    <text x="600" y="82">publish</text><text x="600" y="100">tiles</text>
  </g>
  <g fill="#b0413e" font-size="12" text-anchor="middle">
    <text x="70" y="168">already</text><text x="70" y="184">swapped</text>
    <text x="245" y="168">produced</text><text x="245" y="184">wrongly here</text>
    <text x="425" y="168">no always_xy</text><text x="425" y="184">on the transformer</text>
    <text x="600" y="168">anything</text><text x="600" y="184">in between</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Four assertions, four distinct causes; each is microseconds on an array.</text>
</svg>
<figcaption>The same check at four boundaries distinguishes a bad delivery from a bug in the pipeline, which a single check at the end cannot.</figcaption>
</figure>

## Expected Output & Verification

```text
EPSG:4326         x/E         -180 …          180   y/N          -90 …           90
EPSG:25832        x/E      -1,877,994 …    1,626,381   y/N    3,804,640 …   9,329,006
EPSG:32618        x/E        166,021 …      833,978   y/N            0 …   9,329,005
EPSG:2263         x/E        278,450 …    1,049,900   y/N       38,700 …      323,600
CRITICAL: axes are swapped: the values fit the opposite axis
{'as_given_on_land': 1.0, 'as_flipped_on_land': 0.0, 'verdict': 'as given'}
transformed: [691204.41  691252.58] [5335818.22 5335795.6 ]
OK   footprints.gpkg              declared EPSG:25832 — no findings
FAIL tile_691_5335.laz            declared EPSG:25832 — axes are swapped: the values fit the opposite axis
OK   district.city.json           declared EPSG:25832 — no findings
```

Verify the detector itself with fixtures, because a check that cannot fail is not a check:

```python
CASES = [
    ("correct UTM", [691204.4, 691286.9], [5335818.2, 5335836.9], "EPSG:25832", False),
    ("swapped UTM", [5335818.2, 5335836.9], [691204.4, 691286.9], "EPSG:25832", True),
    ("correct lon/lat", [11.573, 11.576], [48.138, 48.140], "EPSG:4326", False),
    ("swapped lon/lat", [48.138, 48.140], [11.573, 11.576], "EPSG:4326", True),
    ("wrong UTM zone", [291204.4, 291286.9], [5335818.2, 5335836.9], "EPSG:25832", True),
]
for name, x, y, epsg, should_fail in CASES:
    extent = MUNICH if epsg == "EPSG:4326" else MUNICH_25832
    findings = swap_diagnosis(x, y, epsg, extent)
    failed = any(s == "critical" for s, _ in findings)
    status = "detected" if failed == should_fail else "MISSED"
    print(f"{status:<9}{name:<18}{'; '.join(m for _, m in findings) or '—'}")
    assert failed == should_fail, f"{name}: expected fail={should_fail}"
print("axis-order detector behaves correctly on all fixtures")
```

The "swapped lon/lat" case is the interesting one: 48.138 is a valid longitude and 11.573 a valid latitude, so magnitudes alone cannot reject it — the expected extent is what catches it, which is exactly why the fixture set includes it. The "wrong UTM zone" case is included because it is the failure most often mistaken for a swap: the magnitudes are plausible for the CRS and wrong for the project, and only the extent test distinguishes them.

## Performance Notes

- **The magnitude and extent tests are vectorised** and cost microseconds on a million coordinates, so they belong in every step rather than in a separate validation job.
- **Sample for the land test.** A point-in-polygon test against a coastline is milliseconds per point; five hundred points give a decisive answer and take well under a second.
- **Use representative points for vector data** rather than every vertex: one per feature is enough to detect a swap and orders of magnitude cheaper.
- **Read only the header for point clouds** when possible. A swapped cloud has an obviously wrong bounding box, and reading 20 million coordinates to learn that is unnecessary.
- **Cache the area-of-use bounds** per EPSG code; deriving them involves a transformation and is worth doing once per process.

## Common Errors

**A dataset near the equator passes every test and is still swapped.** No magnitude or land test can decide there. The expected extent is the only detector, which is why an ingestion contract should always carry one.

**The detector fires on a legitimately global dataset.** Area-of-use bounds are wrong for data that genuinely spans the world. Skip the bounds test for global layers and rely on the extent and on format conventions.

**`always_xy=True` is set and the output is still swapped.** The flag controls the transformer, not the file. A writer that emits latitude first will do so regardless, and GeoJSON, shapefiles and most point-cloud formats are longitude-first by specification.

**Heights end up in the northing.** A three-column export read as two columns, or a `(lat, lon, h)` tuple unpacked as `(x, y, z)`. Check the vertical range as well: a "northing" of 519.31 is a height.

## Frequently Asked Questions

### Is `always_xy` always the right setting?

For pipeline code that works with files and APIs, yes — it makes `pyproj` agree with the longitude-first convention those use. Code that deliberately implements an authority-ordered interface should say so loudly, in one place, and convert at its boundary.

### What about EPSG:4326 versus OGC:CRS84?

`OGC:CRS84` is the same datum with longitude-first axis order declared explicitly, which removes the ambiguity. Using it in metadata for longitude-first data is more honest than declaring EPSG:4326 and relying on a convention.

### Should a swap be corrected automatically?

No. A detected swap means the producer's assumptions differ from the consumer's, and silently flipping the axes hides that — the next delivery will be correct and the pipeline will flip it wrongly. Fail, report which axis assignment fits, and fix the producer or the declared CRS.

## Related Guides

- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — why the ambiguity exists
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the wider set of CRS assertions
- [Tracing Unit Errors from Feet to Metres](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracing-unit-errors-from-feet-to-metres/) — the other silent coordinate failure

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
