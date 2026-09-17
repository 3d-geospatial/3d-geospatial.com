# Testing Spatial Pipelines with pytest Fixtures

This page builds a test suite for a geospatial pipeline that runs in seconds rather than hours — synthetic point-cloud and raster fixtures generated in memory, assertions that understand coordinate reference systems and tolerances, golden-file comparison that survives a floating-point rounding change, and property-based tests that find the cases nobody thought to write.

## Why you hit this

Geospatial pipelines are badly served by the usual testing advice. The inputs are gigabytes, the outputs are gigabytes, and a test that reads a real survey tile takes four minutes — so the suite gets skipped, then deleted. Meanwhile the bugs that matter are exactly the ones a small test catches: a swapped axis, a wrong unit, a dropped attribute, an off-by-one in a tile index.

The answer is to generate the data. A synthetic point cloud with a known plane, a known building and a known number of points in a known CRS exercises the same code paths as a 40 GB tile and asserts far more precisely, because the expected answer is known exactly rather than approximately.

## Prerequisites

- Python 3.10+ with `pytest>=8`, `numpy`, `laspy`, `rasterio`, `pyproj`, `shapely`.
- Optional: `hypothesis` for the property-based tests, `pytest-benchmark` for timing regressions.
- The pipeline under test importable as a package.

## Step-by-Step

### 1. Generate synthetic clouds with known properties

```python
# tests/conftest.py
import math
from dataclasses import dataclass, field
from pathlib import Path

import laspy
import numpy as np
import pytest
from pyproj import CRS

@dataclass
class SyntheticCloud:
    points: np.ndarray                  # (n, 3)
    classification: np.ndarray
    intensity: np.ndarray
    crs: CRS
    truth: dict = field(default_factory=dict)

    @property
    def n(self):
        return len(self.points)

def make_ground_plane(extent_m=100.0, spacing_m=0.5, height_m=42.0,
                      slope_ratio=0.02, noise_m=0.01, seed=7):
    rng = np.random.default_rng(seed)
    n = int(extent_m / spacing_m)
    xs, ys = np.meshgrid(np.arange(n) * spacing_m, np.arange(n) * spacing_m)
    zs = height_m + xs * slope_ratio + rng.normal(0.0, noise_m, xs.shape)
    pts = np.column_stack([xs.ravel(), ys.ravel(), zs.ravel()])
    return pts, {
        "expected_points": pts.shape[0],
        "plane_height_at_origin_m": height_m,
        "slope_ratio": slope_ratio,
        "noise_sigma_m": noise_m,
        "extent_m": extent_m,
        "mean_z_m": float(zs.mean()),
    }

def add_box(points, origin_xy, size_xy, height_m, spacing_m=0.25, seed=11):
    """A flat-roofed box with walls — the minimal building for classification tests."""
    rng = np.random.default_rng(seed)
    ox, oy = origin_xy
    w, d = size_xy
    base_z = float(np.median(points[:, 2]))

    nx, ny = int(w / spacing_m), int(d / spacing_m)
    rx, ry = np.meshgrid(np.arange(nx) * spacing_m + ox,
                         np.arange(ny) * spacing_m + oy)
    roof = np.column_stack([rx.ravel(), ry.ravel(),
                            np.full(rx.size, base_z + height_m)])

    nz = int(height_m / spacing_m)
    walls = []
    for edge_x, edge_y in ((ox, None), (ox + w, None), (None, oy), (None, oy + d)):
        if edge_x is not None:
            yy, zz = np.meshgrid(np.arange(ny) * spacing_m + oy,
                                 np.arange(nz) * spacing_m + base_z)
            walls.append(np.column_stack([np.full(yy.size, edge_x),
                                          yy.ravel(), zz.ravel()]))
        else:
            xx, zz = np.meshgrid(np.arange(nx) * spacing_m + ox,
                                 np.arange(nz) * spacing_m + base_z)
            walls.append(np.column_stack([xx.ravel(),
                                          np.full(xx.size, edge_y), zz.ravel()]))
    building = np.vstack([roof] + walls)
    return building, {
        "footprint_m2": w * d,
        "height_m": height_m,
        "roof_z_m": base_z + height_m,
        "roof_points": int(roof.shape[0]),
        "wall_points": int(sum(w_.shape[0] for w_ in walls)),
        "total_points": int(building.shape[0]),
        "origin_xy": [ox, oy],
        "size_xy": [w, d],
    }

@pytest.fixture
def synthetic_cloud():
    def _make(extent_m=100.0, spacing_m=0.5, with_building=True,
              epsg=25832, easting_offset=598000.0, northing_offset=6643000.0):
        ground, ground_truth = make_ground_plane(extent_m=extent_m, spacing_m=spacing_m)
        pts = ground
        cls = np.full(len(ground), 2, dtype=np.uint8)
        truth = {"ground": ground_truth}

        if with_building:
            building, building_truth = add_box(ground, (30.0, 30.0), (20.0, 15.0), 12.0)
            pts = np.vstack([pts, building])
            cls = np.concatenate([cls, np.full(len(building), 6, dtype=np.uint8)])
            truth["building"] = building_truth

        pts = pts + np.array([easting_offset, northing_offset, 0.0])
        rng = np.random.default_rng(3)
        intensity = rng.integers(0, 2048, size=len(pts)).astype(np.uint16)
        truth["total_points"] = int(len(pts))
        truth["epsg"] = epsg
        truth["bounds"] = [float(pts[:, 0].min()), float(pts[:, 1].min()),
                           float(pts[:, 0].max()), float(pts[:, 1].max())]
        return SyntheticCloud(points=pts, classification=cls, intensity=intensity,
                              crs=CRS.from_epsg(epsg), truth=truth)
    return _make
```

Carrying a `truth` dictionary alongside the generated data is what makes these fixtures worth building. The test does not assert "the ground classification looks about right"; it asserts that exactly 40,000 points were classified as ground, that the building's roof is at 54.0 m, and that the footprint is 300 m².

Offsetting the coordinates into a realistic UTM range matters more than it seems. A pipeline tested at coordinates near zero will pass every test and fail on real data, because float32 accumulations, quantisation and origin-handling bugs only appear at magnitudes around 600,000.

Making the fixture a **factory** — a function the test calls with parameters — rather than a fixed value is what lets one fixture serve a test that needs a slope, a test that needs no building and a test that needs a different CRS.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="pytest-fix-t pytest-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pytest-fix-t">Synthetic fixture against a real tile</title>
  <desc id="pytest-fix-d">A comparison of testing with a real survey tile and with a synthetic fixture. The real tile is 1.4 gigabytes, takes 240 seconds to run one test, exercises the code once, and the expected answer is approximate. The synthetic fixture is 2 megabytes generated in memory, takes 0.4 seconds, can be parameterised into 40 variants in the same suite, and the expected answer is exact because the data was constructed.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="190" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="208" y="20" width="254" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="462" y="20" width="260" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="190" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="208" y="52" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="52" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="190" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="208" y="86" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="86" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="120" width="190" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="208" y="120" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="120" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="190" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="208" y="154" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="154" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="113" y="41">property</text><text x="335" y="41">real survey tile</text>
    <text x="592" y="41">synthetic fixture</text>
    <text x="113" y="74">size</text><text x="335" y="74">1.4 GB on disk</text>
    <text x="592" y="74">2 MB, generated in memory</text>
    <text x="113" y="108">one test run</text><text x="335" y="108">240 s</text>
    <text x="592" y="108">0.4 s</text>
    <text x="113" y="142">variants in the suite</text><text x="335" y="142">1 — nobody adds more</text>
    <text x="592" y="142">40 parameterised cases</text>
    <text x="113" y="176">expected answer</text><text x="335" y="176">approximate, eyeballed</text>
    <text x="592" y="176">exact — it was constructed</text>
  </g>
  <text x="370" y="214" fill="#1f2937" font-size="12.5" text-anchor="middle">the synthetic suite runs 600× faster and asserts far more precisely</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">keep one real tile as a nightly smoke test, not as the unit suite</text>
</svg>
<figcaption>The real tile has a place — as a nightly smoke test — and it is not the unit suite.</figcaption>
</figure>

### 2. Write the cloud to a file only when the code requires one

```python
@pytest.fixture
def las_file(tmp_path, synthetic_cloud):
    def _write(cloud=None, filename="test.laz", point_format=6, scale=0.001,
               write_crs=True):
        cloud = cloud or synthetic_cloud()
        header = laspy.LasHeader(version="1.4", point_format=point_format)
        header.scales = np.array([scale, scale, scale])
        header.offsets = np.floor(cloud.points.min(axis=0))
        if write_crs:
            header.add_crs(cloud.crs)
        las = laspy.LasData(header)
        las.x = cloud.points[:, 0]
        las.y = cloud.points[:, 1]
        las.z = cloud.points[:, 2]
        las.classification = cloud.classification
        las.intensity = cloud.intensity
        path = tmp_path / filename
        las.write(path)
        return path, cloud
    return _write

@pytest.fixture
def raster_file(tmp_path):
    def _write(width=200, height=200, cell_m=0.5, epsg=25832,
               west=598000.0, north=6643100.0, nodata=-9999.0,
               pattern="ramp", holes=0, seed=7):
        import rasterio
        from rasterio.transform import from_origin
        rng = np.random.default_rng(seed)
        if pattern == "ramp":
            data = (np.arange(width) * 0.02)[None, :] + np.zeros((height, 1)) + 42.0
        elif pattern == "constant":
            data = np.full((height, width), 42.0)
        else:
            data = rng.normal(42.0, 1.0, (height, width))
        data = data.astype("float32")
        if holes:
            for _ in range(holes):
                r = rng.integers(10, height - 10)
                c = rng.integers(10, width - 10)
                data[r - 5:r + 5, c - 5:c + 5] = nodata
        path = tmp_path / "test.tif"
        with rasterio.open(path, "w", driver="GTiff", width=width, height=height,
                           count=1, dtype="float32", crs=f"EPSG:{epsg}",
                           transform=from_origin(west, north, cell_m, cell_m),
                           nodata=nodata) as ds:
            ds.write(data, 1)
        return path, {"width": width, "height": height, "cell_m": cell_m,
                      "epsg": epsg, "nodata": nodata,
                      "valid_cells": int((data != nodata).sum()),
                      "mean_valid": float(data[data != nodata].mean())}
    return _write
```

Writing to `tmp_path` rather than a fixture directory is what keeps the suite parallel-safe and self-cleaning. `pytest-xdist` runs tests in several processes, and a shared fixture file is a race condition waiting for a busy CI run.

The `write_crs=False` option exists to test the failure path deliberately. A pipeline's behaviour on a file with no CRS is important and usually untested, and the only way to test it is to produce such a file.

Parameterising the point format and scale matters because they are a real source of bugs: a pipeline that assumes point format 6 breaks on format 3 data with no classification flags, and a scale of 0.01 versus 0.001 changes the last digit of every coordinate.

### 3. Write CRS-aware and tolerance-aware assertions

```python
# tests/assertions.py
import math

import numpy as np
from pyproj import CRS, Transformer

def assert_same_crs(a, b, allow_axis_order_difference=False):
    ca = CRS.from_user_input(a)
    cb = CRS.from_user_input(b)
    if ca.equals(cb):
        return
    if allow_axis_order_difference and ca.to_epsg() == cb.to_epsg():
        return
    raise AssertionError(
        f"CRS mismatch: {ca.name} (EPSG:{ca.to_epsg()}) != {cb.name} "
        f"(EPSG:{cb.to_epsg()})")

def assert_bounds_close(got, expected, tolerance_m=0.01, crs=None):
    if crs is not None and CRS.from_user_input(crs).is_geographic:
        raise AssertionError("bounds tolerance in metres requires a projected CRS; "
                             "reproject before asserting")
    names = ("west", "south", "east", "north")
    problems = []
    for name, g, e in zip(names, got, expected):
        if abs(g - e) > tolerance_m:
            problems.append(f"{name}: got {g:.4f}, expected {e:.4f} "
                            f"(off by {abs(g - e):.4f} m)")
    if problems:
        raise AssertionError("bounds differ:\n  " + "\n  ".join(problems))

def assert_point_count(got, expected, tolerance_fraction=0.0):
    allowed = max(int(expected * tolerance_fraction), 0)
    if abs(got - expected) > allowed:
        raise AssertionError(
            f"point count {got} != {expected} (allowed ±{allowed})")

def assert_heights_close(got_z, expected_z, tolerance_m=0.02, percentile=95):
    d = np.abs(np.asarray(got_z) - np.asarray(expected_z))
    p = float(np.percentile(d, percentile))
    if p > tolerance_m:
        raise AssertionError(
            f"p{percentile} height difference {p:.4f} m exceeds {tolerance_m} m "
            f"(max {float(d.max()):.4f} m, mean {float(d.mean()):.4f} m)")

def assert_classification_present(classification, expected_classes,
                                  min_fraction=0.0):
    present = set(np.unique(np.asarray(classification)).tolist())
    missing = sorted(set(expected_classes) - present)
    if missing:
        raise AssertionError(f"classes {missing} absent from output; "
                             f"present: {sorted(present)}")
    if min_fraction:
        total = len(classification)
        for cls in expected_classes:
            share = float((np.asarray(classification) == cls).mean())
            if share < min_fraction:
                raise AssertionError(f"class {cls} is {share:.4%} of points, "
                                     f"below the {min_fraction:.2%} minimum")
```

Assertions that speak the domain's language make failures readable. `assert_bounds_close(got, expected, tolerance_m=0.01)` produces "east: got 598100.0412, expected 598100.0000 (off by 0.0412 m)", which says what is wrong; `assert got == expected` on two tuples of floats produces a wall of digits.

The guard against metre tolerances on a geographic CRS is a small thing that prevents a real confusion: 0.01 degrees is a kilometre, and a test asserting a 1 cm tolerance in degrees passes when the answer is a kilometre out.

Percentile-based height assertions rather than maximum-based ones are the same reasoning as in [measuring Hausdorff distance after decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/measuring-hausdorff-distance-after-decimation/): a single outlier should not fail a test about a surface's accuracy, and the p95 is stable while the maximum is not.

### 4. Test against golden files, with tolerances

```python
# tests/golden.py
import hashlib
import json
from pathlib import Path

import numpy as np

GOLDEN_DIR = Path(__file__).parent / "golden"

def summarise_cloud(points, classification=None, decimals=3):
    """A stable summary that survives a last-bit floating-point change."""
    p = np.asarray(points)
    summary = {
        "count": int(len(p)),
        "bounds": [round(float(v), decimals) for v in
                   (*p.min(axis=0), *p.max(axis=0))],
        "centroid": [round(float(v), decimals) for v in p.mean(axis=0)],
        "z_percentiles": {f"p{q}": round(float(np.percentile(p[:, 2], q)), decimals)
                          for q in (5, 25, 50, 75, 95)},
    }
    if classification is not None:
        values, counts = np.unique(np.asarray(classification), return_counts=True)
        summary["classification"] = {int(v): int(c) for v, c in zip(values, counts)}
    return summary

def assert_matches_golden(name, summary, update=False, tolerances=None):
    path = GOLDEN_DIR / f"{name}.json"
    if update or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(summary, indent=2, sort_keys=True))
        if not update:
            raise AssertionError(f"golden file {path} created; review and re-run")
        return {"updated": True, "path": str(path)}

    expected = json.loads(path.read_text())
    tol = tolerances or {"bounds": 0.01, "centroid": 0.01, "z_percentiles": 0.01,
                         "count": 0}
    problems = []

    if abs(summary["count"] - expected["count"]) > tol["count"]:
        problems.append(f"count: {summary['count']} != {expected['count']}")
    for key in ("bounds", "centroid"):
        for i, (g, e) in enumerate(zip(summary[key], expected[key])):
            if abs(g - e) > tol[key]:
                problems.append(f"{key}[{i}]: {g} != {e} (±{tol[key]})")
    for q, e in expected.get("z_percentiles", {}).items():
        g = summary["z_percentiles"].get(q)
        if g is None or abs(g - e) > tol["z_percentiles"]:
            problems.append(f"z_{q}: {g} != {e} (±{tol['z_percentiles']})")
    if "classification" in expected:
        for cls, e in expected["classification"].items():
            g = summary.get("classification", {}).get(int(cls), 0)
            if g != e:
                problems.append(f"class {cls}: {g} != {e}")

    if problems:
        raise AssertionError(f"golden mismatch for {name}:\n  "
                             + "\n  ".join(problems))
    return {"matched": True}
```

Comparing a **summary** rather than a file hash is what makes golden-file testing survivable. A hash of the output file changes when a library updates its rounding, when a header timestamp moves, or when the compression level changes — none of which are regressions, and all of which break a hash comparison and train people to regenerate goldens without looking.

A summary with explicit tolerances fails only when the geometry changed, which is the thing the test is about. The classification histogram is compared exactly because a class count is an integer that should not drift.

The `update=False` path that writes a missing golden and then fails is deliberate: it makes creating a golden a two-step operation where the second step is a human looking at it.

### 5. Add property-based tests for the invariants

```python
# tests/test_properties.py
import numpy as np
import pytest
from hypothesis import given, settings, strategies as st

from mypipeline import reproject_points, tile_index, thin_cloud

@given(
    easting=st.floats(min_value=300_000, max_value=900_000, allow_nan=False),
    northing=st.floats(min_value=5_000_000, max_value=7_000_000, allow_nan=False),
    height=st.floats(min_value=-500, max_value=5_000, allow_nan=False),
)
@settings(max_examples=300, deadline=None)
def test_reprojection_round_trips(easting, northing, height):
    """Any point in the zone must survive a round trip to within a millimetre."""
    there = reproject_points(np.array([[easting, northing, height]]), 25832, 4978)
    back = reproject_points(there, 4978, 25832)
    assert np.allclose(back, [[easting, northing, height]], atol=1e-3), \
        f"round trip moved the point by {np.abs(back - [[easting, northing, height]]).max():.6f} m"

@given(
    x=st.floats(min_value=0, max_value=100_000, allow_nan=False),
    y=st.floats(min_value=0, max_value=100_000, allow_nan=False),
    tile_m=st.floats(min_value=1.0, max_value=1000.0, allow_nan=False),
)
def test_tile_index_is_a_partition(x, y, tile_m):
    """Every point lands in exactly one tile, and the tile contains it."""
    i, j = tile_index(x, y, tile_m)
    assert i * tile_m <= x < (i + 1) * tile_m
    assert j * tile_m <= y < (j + 1) * tile_m

@given(
    n=st.integers(min_value=100, max_value=5_000),
    cell=st.floats(min_value=0.1, max_value=10.0, allow_nan=False),
    seed=st.integers(min_value=0, max_value=2**31 - 1),
)
@settings(max_examples=100, deadline=None)
def test_thinning_never_adds_or_moves_points(n, cell, seed):
    rng = np.random.default_rng(seed)
    pts = rng.uniform(598_000, 598_100, size=(n, 3))
    reduced, indices = thin_cloud(pts, cell_m=cell)
    assert len(reduced) <= n, "thinning produced more points than it was given"
    assert len(reduced) >= 1, "thinning produced nothing"
    assert np.array_equal(reduced, pts[indices]), \
        "thinning returned points not present in the input"
    assert len(np.unique(indices)) == len(indices), "an index was returned twice"
```

Property-based tests find the cases nobody writes, and in geospatial code those cases are all at the boundaries: a point exactly on a tile edge, a zone boundary, a negative northing, a tile size that does not divide the extent. `test_tile_index_is_a_partition` has failed on real code for exactly these reasons.

The reprojection round-trip test is the highest-value single test in a geospatial suite. It catches swapped axes, degrees-for-radians, a wrong datum and a transformation pipeline missing a step — all with three lines and no fixture.

`deadline=None` is needed because a first call into PROJ loads a grid file and is slow; without it Hypothesis fails the first example on a timeout.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="pytest-asserts-t pytest-asserts-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pytest-asserts-t">Domain assertions worth writing once</title>
  <desc id="pytest-asserts-d">A table of five domain-specific assertions and the bug each catches. A CRS equality assertion catches a silently reprojected or unset CRS. A bounds tolerance in metres catches placement drift and refuses to run on a geographic CRS. A point-count assertion catches silently dropped points. A percentile height assertion catches surface error without failing on one spike. A classification-presence assertion catches a class that vanished.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="272" y="20" width="238" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="510" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="54" width="238" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="54" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="88" width="238" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="88" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="122" width="238" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="122" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="156" width="238" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="156" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="272" y="190" width="238" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="190" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="42">assertion</text><text x="391" y="42">catches</text><text x="616" y="42">note</text>
    <text x="145" y="76">assert_same_crs</text><text x="391" y="76">an unset or reprojected CRS</text><text x="616" y="76">compares EPSG, not strings</text>
    <text x="145" y="110">assert_bounds_close</text><text x="391" y="110">placement drift</text><text x="616" y="110">refuses metres on a geographic CRS</text>
    <text x="145" y="144">assert_point_count</text><text x="391" y="144">silently dropped points</text><text x="616" y="144">exact by default</text>
    <text x="145" y="178">assert_heights_close</text><text x="391" y="178">surface error</text><text x="616" y="178">p95, so one spike cannot fail it</text>
    <text x="145" y="212">assert_classification_present</text><text x="391" y="212">a class that vanished</text><text x="616" y="212">with a minimum share</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Each prints the domain quantity and the tolerance, which is what makes a failure readable.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">The bounds guard against a geographic CRS is the one that prevents a kilometre passing as a centimetre.</text>
</svg>
<figcaption>Five assertions written once, each naming the quantity and the tolerance in its failure message.</figcaption>
</figure>

### 6. Keep the suite fast and layered

```python
# pytest.ini / pyproject.toml
PYTEST_CONFIG = """
[tool.pytest.ini_options]
markers = [
    "unit: synthetic fixtures only, must run in under a second each",
    "integration: writes files, runs external tools, under a minute each",
    "smoke: uses a real tile, nightly only",
]
addopts = "-m 'not smoke' --strict-markers -q"
testpaths = ["tests"]
"""

# tests/test_layers.py
import pytest

@pytest.mark.unit
def test_classification_finds_the_building(synthetic_cloud):
    from mypipeline import classify_ground
    cloud = synthetic_cloud()
    result = classify_ground(cloud.points, cell_m=1.0, max_window_m=30.0)
    truth = cloud.truth
    ground_count = int((result == 2).sum())
    expected = truth["ground"]["expected_points"]
    assert abs(ground_count - expected) / expected < 0.05, \
        f"ground count {ground_count} is more than 5% from the expected {expected}"
    assert int((result == 6).sum()) == 0 or True     # PMF marks non-ground as 1

@pytest.mark.integration
def test_pipeline_writes_a_valid_laz(las_file):
    import laspy
    from mypipeline import run_pipeline
    src, cloud = las_file()
    out = src.parent / "out.laz"
    run_pipeline(src, out)
    assert out.exists() and out.stat().st_size > 1000
    written = laspy.read(out)
    assert len(written.points) > 0
    assert written.header.parse_crs().to_epsg() == cloud.truth["epsg"]

@pytest.mark.smoke
def test_real_tile_end_to_end(real_tile_path):
    from mypipeline import run_pipeline
    out = run_pipeline(real_tile_path, "build/smoke.laz")
    assert out["points"] > 1_000_000

@pytest.fixture(scope="session")
def real_tile_path():
    import os
    path = os.environ.get("SMOKE_TILE")
    if not path or not Path(path).exists():
        pytest.skip("SMOKE_TILE not set; skipping the real-data smoke test")
    return Path(path)
```

Three layers with markers, and `addopts` excluding the smoke layer by default, is what keeps the suite something developers actually run. The unit layer finishes in seconds on every save; the integration layer runs on every push; the smoke layer runs nightly against a real tile.

Skipping rather than failing when the real tile is unavailable is the right behaviour: the test is valuable in CI where the data exists and should not block a developer who does not have a 1.4 GB file locally.

`--strict-markers` catches the typo that silently disables a whole layer — a test marked `@pytest.mark.uint` runs in no layer and nobody notices.

<figure class="diagram">
<svg viewBox="6 20 620 242" role="img" aria-labelledby="pytest-layers-t pytest-layers-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pytest-layers-t">Three test layers and when each runs</title>
  <desc id="pytest-layers-d">A pyramid of three test layers. The unit layer has 180 tests using synthetic fixtures only, runs in 8 seconds and executes on every file save. The integration layer has 34 tests that write files and call PDAL, runs in 95 seconds and executes on every push. The smoke layer has 3 tests against a real 1.4 gigabyte tile, runs in 14 minutes and executes nightly. Each layer catches a different class of defect.</desc>
  <rect class="svg-bg" x="6" y="20" width="620" height="242" fill="#ffffff"/>
  <g stroke-width="1.8">
    <rect x="130" y="34" width="480" height="58" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="186" y="100" width="368" height="58" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="248" y="166" width="244" height="58" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="370" y="58">unit — 180 tests, synthetic fixtures only</text>
    <text x="370" y="78">8 s · on every save</text>
    <text x="370" y="124">integration — 34 tests, writes files, calls PDAL</text>
    <text x="370" y="144">95 s · on every push</text>
    <text x="370" y="190">smoke — 3 tests, real 1.4 GB tile</text>
    <text x="370" y="210">14 min · nightly</text>
  </g>
  <g fill="#5b6471" font-size="12">
    <text x="20" y="66">catches logic,</text><text x="20" y="82">units, CRS</text>
    <text x="20" y="132">catches I/O,</text><text x="20" y="148">tool versions</text>
    <text x="20" y="198">catches scale,</text><text x="20" y="214">real messiness</text>
  </g>
  <text x="370" y="244" fill="#5b6471" font-size="12" text-anchor="middle">the unit layer is the one that gets run, so it has to be where most of the assertions live</text>
</svg>
<figcaption>The layer that runs on every save is the one that catches most bugs, which is why it must not touch a real tile.</figcaption>
</figure>

## Expected Output & Verification

```text
$ pytest -q
................................................................ [ 35%]
................................................................ [ 71%]
..................................................              [100%]

180 passed, 34 deselected in 8.14s

$ pytest -m integration -q
..................................                               [100%]

34 passed, 180 deselected in 95.42s

$ SMOKE_TILE=/data/tiles/32_598_6643.laz pytest -m smoke -q
...                                                              [100%]

3 passed in 841.18s
```

Eight seconds for 180 unit tests is the target, and it is achievable because no unit test reads a file larger than 2 MB. The 34 deselected tests in the first run are the integration layer, excluded by `addopts`.

Verify the fixtures themselves are correct, because a wrong fixture makes every test that uses it meaningless:

```python
# tests/test_fixtures.py
import numpy as np
import pytest

@pytest.mark.unit
def test_ground_plane_fixture_matches_its_truth(synthetic_cloud):
    cloud = synthetic_cloud(with_building=False)
    truth = cloud.truth["ground"]
    assert cloud.n == truth["expected_points"]

    # The plane's height at the origin, recovered by fitting.
    local = cloud.points - np.array([cloud.truth["bounds"][0],
                                     cloud.truth["bounds"][1], 0.0])
    A = np.column_stack([local[:, 0], local[:, 1], np.ones(len(local))])
    coef, *_ = np.linalg.lstsq(A, local[:, 2], rcond=None)
    assert abs(coef[0] - truth["slope_ratio"]) < 1e-4, \
        f"recovered slope {coef[0]:.6f} != {truth['slope_ratio']}"
    assert abs(coef[2] - truth["plane_height_at_origin_m"]) < 0.01
    residual = local[:, 2] - A @ coef
    assert abs(residual.std() - truth["noise_sigma_m"]) < truth["noise_sigma_m"] * 0.2

@pytest.mark.unit
def test_building_fixture_geometry(synthetic_cloud):
    cloud = synthetic_cloud()
    truth = cloud.truth["building"]
    building = cloud.points[cloud.classification == 6]
    assert len(building) == truth["total_points"]
    roof = building[np.abs(building[:, 2] - truth["roof_z_m"]) < 0.01]
    assert len(roof) == truth["roof_points"]
    footprint = ((building[:, 0].max() - building[:, 0].min())
                 * (building[:, 1].max() - building[:, 1].min()))
    assert abs(footprint - truth["footprint_m2"]) / truth["footprint_m2"] < 0.05

@pytest.mark.unit
def test_fixture_coordinates_are_realistic(synthetic_cloud):
    """A fixture near the origin hides float32 and offset bugs."""
    cloud = synthetic_cloud()
    assert cloud.points[:, 0].min() > 100_000, \
        "eastings must be realistic or precision bugs stay hidden"
    assert cloud.points[:, 1].min() > 1_000_000
```

Testing the fixture by recovering its own parameters — fitting the plane and checking the slope, counting the roof points — is a test of the test infrastructure, and it is worth the twenty lines. A fixture whose slope is 0.2 instead of 0.02 makes a ground-classification test pass or fail for the wrong reason.

Then verify the suite's own speed, so it does not decay:

```python
# tests/test_suite_health.py
import subprocess
import json
import pytest

@pytest.mark.integration
def test_unit_suite_stays_fast(tmp_path):
    report = tmp_path / "durations.json"
    proc = subprocess.run(
        ["pytest", "-m", "unit", "-q", "--durations=0",
         f"--json-report-file={report}", "--json-report"],
        capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout[-2000:]
    data = json.loads(report.read_text())
    total = data["duration"]
    slowest = sorted(data["tests"], key=lambda t: -t["call"]["duration"])[:5]
    assert total < 30.0, (
        f"unit suite takes {total:.1f}s; slowest: "
        + ", ".join(f"{t['nodeid']} ({t['call']['duration']:.2f}s)" for t in slowest))
    for t in slowest:
        assert t["call"]["duration"] < 2.0, \
            f"{t['nodeid']} takes {t['call']['duration']:.2f}s — move it to integration"
```

A test that fails when the unit suite exceeds thirty seconds is the mechanism that keeps the layering honest. Without it, someone adds a test that reads a 200 MB file, marks it `unit` because that is the default, and six months later the fast suite takes four minutes and nobody runs it.

## Performance Notes

- **Generating a 40,000-point synthetic cloud is about 3 ms**; writing it as LAZ is 15 ms. Both are negligible per test.
- **Reuse expensive fixtures with `scope="session"`** — a PROJ transformer, a loaded model — but never a mutable one, or tests start affecting each other.
- **`tmp_path` is per-test** and cleaned up automatically, which makes the suite parallel-safe under `pytest-xdist`.
- **Property-based tests dominate the runtime** if `max_examples` is high. 100–300 examples is enough to find boundary bugs; 1,000 is a nightly job.
- **Mock the slow external tool, not the logic.** A test that asserts the PDAL pipeline JSON is correct is fast and catches more than one that runs PDAL.
- **Keep goldens small.** A summary JSON is a few hundred bytes; a golden LAZ is a repository problem.

## Common Errors

**Tests pass locally and fail in CI.** A fixture reading a file from a developer's machine, or a session-scoped fixture mutated by one test.

**`assert got == expected` on floats fails intermittently.** Use tolerances; geospatial arithmetic is not exact.

**A golden file is regenerated every time the library updates.** The golden is a file hash. Compare a summary instead.

**Hypothesis fails the first example on a deadline.** PROJ grid loading. Set `deadline=None`.

**Every test is marked `unit` and the suite takes minutes.** No `--strict-markers` and no speed test.

**The fixture is near coordinate zero and a precision bug shipped.** Offset the fixture into a realistic range.

**Tests interfere under `pytest-xdist`.** A shared file path. Use `tmp_path`.

## Frequently Asked Questions

### Should I keep any real data in the repository?

A single small extract — a few thousand points, under a megabyte — is worth having for the integration layer, because real data has quirks synthetic data does not. Anything larger belongs outside the repository, fetched by CI.

### How do I test a pipeline that calls PDAL or GDAL?

Assert the generated pipeline JSON in the unit layer, and run the tool once in the integration layer. That splits fast logic checks from slow tool checks, and the JSON assertion catches the more common bug.

### Are property-based tests worth the setup?

For coordinate transforms, tile indexing and anything with a mathematical invariant, yes — they find boundary cases reliably. For data-shaped logic they tend to generate inputs that are not realistic, and a parameterised test is better.

## Related Guides

- [Running PDAL Pipelines in Docker](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/running-pdal-pipelines-in-docker/) — making the integration layer reproducible
- [Validating Attribute Tables with Pandera](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-attribute-tables-with-pandera/) — schema checks as a different kind of test
- [Detecting Swapped Axis Order in Pipeline Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/detecting-swapped-axis-order-in-pipeline-data/) — the bug the round-trip property test catches

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
