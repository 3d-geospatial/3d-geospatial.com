---
title: "LiDAR Point Density Best Practices"
description: "Set and verify LiDAR point density targets in ppsm for infrastructure corridors with laspy, numpy, and pyarrow — grid binning and sparse-cell flagging."
---
# Best Practices for LiDAR Point Density in Infrastructure

This guide sets best-practice LiDAR point density targets in **ppsm** (points per square metre) for infrastructure corridors — roads, rail, and power lines — and shows how to verify a delivered `.laz` scan against them with `laspy>=2.4`, `numpy`, and `pyarrow`. The target you choose drives every downstream decision: classification confidence, mesh resolution, clearance analysis, and storage cost. Pick it deliberately, then prove the delivered cloud meets it before the data is accepted into the twin.

## Why you hit this

Raw acquisition density almost never equals delivered density. A campaign flown to hit 40 ppsm routinely delivers 28–32 ppsm after outlier rejection, ground classification, and atmospheric-return removal. Corridors compound the problem: vertical surfaces (retaining walls, bridge undersides, utility poles) sit at steep incidence angles where the beam footprint smears and occlusion shadows open up, so the *along-corridor average* can look healthy while the *cross-section* under a structure is far too sparse to measure clearance. Manual spot-checking misses these pockets entirely. You need a grid-based density metric over the full extent, expressed in the same ppsm unit as your acceptance spec, that flags every sparse cell automatically.

A second trap is units. Density is meaningless without an explicit metric coordinate reference system. Compute ppsm on a geographic CRS such as EPSG:4326 and your "square metre" is actually a square degree — the number is off by ten orders of magnitude. Every density check below assumes the cloud is already in a projected metric CRS; for a US east-coast corridor that is EPSG:32618 (UTM zone 18N), where X and Y are eastings and northings in metres.

<figure class="diagram">
<svg viewBox="0 26 720 198" role="img" aria-labelledby="lidens-t lidens-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lidens-t">Corridor density verification flow</title>
  <desc id="lidens-d">A LAZ scan in EPSG:32618 is binned into a one-metre grid, the points-per-square-metre of each cell is compared to the corridor target, and cells below target are flagged and written to a Parquet quality record.</desc>
  <rect class="svg-bg" x="0" y="26" width="720" height="198" fill="#ffffff"/>
  <defs>
    <marker id="lidens-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="14" y="92" width="150" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="206" y="92" width="150" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="398" y="92" width="150" height="66" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="566" y="40" width="140" height="62" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="566" y="148" width="140" height="62" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#lidens-arrow)" fill="none">
    <line x1="164" y1="125" x2="204" y2="125"/>
    <line x1="356" y1="125" x2="396" y2="125"/>
    <line x1="548" y1="115" x2="564" y2="80"/>
    <line x1="548" y1="135" x2="564" y2="172"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="89" y="120"><tspan x="89" dy="0">LAZ scan</tspan><tspan x="89" dy="16">EPSG:32618</tspan></text>
    <text x="281" y="120"><tspan x="281" dy="0">1 m grid bin</tspan><tspan x="281" dy="16">count / area</tspan></text>
    <text x="473" y="120"><tspan x="473" dy="0">compare to</tspan><tspan x="473" dy="16">target ppsm</tspan></text>
    <text x="636" y="66"><tspan x="636" dy="0">PASS</tspan><tspan x="636" dy="16">accept</tspan></text>
    <text x="636" y="174"><tspan x="636" dy="0">sparse cells</tspan><tspan x="636" dy="16">to Parquet</tspan></text>
  </g>
</svg>
<figcaption>Bin to a 1 m grid, convert each cell to ppsm, compare to the corridor target, and route failing cells to a Parquet quality record.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `laspy>=2.4`, `numpy>=1.24`, and `pyarrow>=14` (`pip install "laspy[lazrs]>=2.4" numpy pyarrow`). The `lazrs` backend lets `laspy` read compressed `.laz` directly.
- A delivered point cloud in `.laz` or `.las`, already reprojected to a projected metric CRS — EPSG:32618 in these examples. Confirm the header CRS before trusting any metre-based number.
- A density target per asset class (see the table below). For a rail corridor that is typically 25–40 ppsm.
- A rough cloud extent. A 5 km corridor scanned at 30 ppsm is ~150 M points per kilometre of swath, so plan for chunked reads on anything past a few GB.

## Step-by-Step

### 1. Load the LAZ and confirm a metric CRS

Read the file with `laspy` and verify the header reports a projected CRS in metres before computing anything. The `.x` / `.y` accessors apply the LAS scale and offset automatically, returning real-world coordinates.

```python
import laspy
import numpy as np

las = laspy.read("rail_corridor.laz")          # laspy>=2.4
crs = las.header.parse_crs()                    # from the LAS/LAZ VLRs
assert crs is not None, "no CRS in header; reproject before density checks"
assert crs.is_projected, f"CRS {crs.to_epsg()} is not projected/metric"
print("EPSG:", crs.to_epsg())                   # expect 32618 for UTM 18N

xy = np.column_stack([np.asarray(las.x), np.asarray(las.y)])
print(f"{len(xy):,} points  extent X {xy[:,0].ptp():.1f} m  Y {xy[:,1].ptp():.1f} m")
```

### 2. Bin points into a 1 m grid and compute ppsm

Assign every point to a square cell with a configurable edge (1.0 m gives ppsm directly, since a 1 m × 1 m cell is 1 m²). A flattened `np.bincount` is the fastest vectorised way to count points per cell.

```python
def density_grid(xy: np.ndarray, cell_m: float = 1.0):
    """Return (counts_2d, ppsm_per_occupied_cell, min_xy, shape)."""
    min_xy = xy.min(axis=0)
    ij = ((xy - min_xy) / cell_m).astype(np.int64)
    shape = ij.max(axis=0) + 1
    flat = ij[:, 0] * shape[1] + ij[:, 1]            # row-major linear index
    counts = np.bincount(flat, minlength=int(shape.prod()))
    counts2d = counts.reshape(shape)
    cell_area = cell_m * cell_m
    occupied = counts2d > 0
    ppsm = counts2d[occupied] / cell_area            # points per square metre
    return counts2d, ppsm, min_xy, shape

counts2d, ppsm, min_xy, shape = density_grid(xy, cell_m=1.0)
print(f"mean {ppsm.mean():.1f} ppsm  median {np.median(ppsm):.1f}  p10 {np.percentile(ppsm,10):.1f}")
```

### 3. Compare to the corridor target and flag sparse cells

Pick the target for the asset class, then locate every occupied cell below it. Report the failing fraction over occupied cells only — empty cells outside the swath would otherwise drown the signal.

```python
def flag_sparse(counts2d, min_xy, cell_m, target_ppsm):
    occupied = counts2d > 0
    ppsm_grid = counts2d / (cell_m * cell_m)
    sparse = occupied & (ppsm_grid < target_ppsm)
    rows, cols = np.nonzero(sparse)
    centres = min_xy + (np.column_stack([rows, cols]) + 0.5) * cell_m
    pct = 100.0 * sparse.sum() / occupied.sum()
    return centres, pct, ppsm_grid[sparse]

TARGET_PPSM = 30.0                                   # rail corridor
centres, sparse_pct, sparse_vals = flag_sparse(counts2d, min_xy, 1.0, TARGET_PPSM)
print(f"{sparse_pct:.1f}% of occupied cells below {TARGET_PPSM:.0f} ppsm")
status = "PASS" if sparse_pct <= 5.0 else "FAIL"
print(f"acceptance (<=5% sparse): {status}")
```

<figure class="diagram">
<svg viewBox="4 11 732 287" role="img" aria-labelledby="pd-corr-t pd-corr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pd-corr-t">Where a corridor survey loses density, and why</title>
  <desc id="pd-corr-d">A density strip along a transmission corridor. Two cells beneath a bridge deck hold no returns because the deck occludes the sensor, and two cells in the conductor's shadow are thin because the wire itself intercepts pulses. Both are contiguous runs rather than scattered speckle, so both trace to a physical cause.</desc>
  <rect class="svg-bg" x="4" y="11" width="732" height="287" fill="#ffffff"/>
  <defs>
    <marker id="pd-corr-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M40 62 C 220 44 480 44 700 62" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <path d="M40 74 C 220 56 480 56 700 74" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <path d="M214 46 h72 v22 h-72 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
    <rect x="40" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="70" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="100" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="130" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="160" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="190" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="220" y="120" width="26" height="54" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="250" y="120" width="26" height="54" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="280" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="310" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="340" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="370" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="400" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="430" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="460" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="490" y="120" width="26" height="54" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="520" y="120" width="26" height="54" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="550" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="580" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="610" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="640" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="670" y="120" width="26" height="54" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M250 70 V116" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#pd-corr-a)"/>
  <path d="M520 60 V116" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#pd-corr-a)"/>
  <text x="250" y="38" fill="#1f6b8a" font-size="12" text-anchor="middle">bridge deck</text>
  <text x="560" y="42" fill="#5b6471" font-size="12" text-anchor="middle">conductor pair</text>
  <text x="250" y="200" fill="#b0413e" font-size="12" text-anchor="middle">0 returns — the deck occludes the sensor</text>
  <text x="520" y="222" fill="#c46a3d" font-size="12" text-anchor="middle">thin — the wire intercepts the pulses beneath it</text>
  <text x="370" y="256" fill="#1f2937" font-size="12.5" text-anchor="middle">Neither run is a density problem. One needs an oblique pass, the other needs the clearance measured off the wire itself.</text>
  <text x="370" y="280" fill="#5b6471" font-size="12" text-anchor="middle">1 m cells along the corridor centreline</text>
</svg>
<figcaption>A corridor's sparse cells cluster around exactly the assets the survey exists to measure, which is why a corridor-wide average passes while the clearance calculation fails.</figcaption>
</figure>

### 4. Persist flagged cells as Parquet for the QA record

Write the sparse-cell centres and their ppsm to a columnar `pyarrow` table. Parquet keeps the audit artefact small and lets the GIS team load failing zones directly into QGIS or a corridor overlay without re-running the scan.

```python
import pyarrow as pa
import pyarrow.parquet as pq

table = pa.table({
    "easting":  pa.array(centres[:, 0], pa.float64()),
    "northing": pa.array(centres[:, 1], pa.float64()),
    "ppsm":     pa.array(sparse_vals,   pa.float32()),
    "epsg":     pa.array([32618] * len(centres), pa.int32()),
})
pq.write_table(table, "rail_corridor_sparse_cells.parquet", compression="zstd")
print(f"wrote {table.num_rows} flagged cells")
```

### 5. Chunk large corridors to bound memory

A multi-kilometre corridor will not fit one `laspy.read`. Stream with `laspy.open(...).chunk_iterator()` and accumulate counts into a fixed grid sized from the header bounds, so memory stays flat regardless of swath length.

```python
def density_grid_chunked(path, cell_m=1.0, chunk=5_000_000):
    with laspy.open(path) as f:
        mins = np.array([f.header.x_min, f.header.y_min])
        maxs = np.array([f.header.x_max, f.header.y_max])
        shape = (((maxs - mins) / cell_m).astype(np.int64) + 1)
        counts = np.zeros(int(shape.prod()), dtype=np.int64)
        for pts in f.chunk_iterator(chunk):
            xy = np.column_stack([np.asarray(pts.x), np.asarray(pts.y)])
            ij = np.clip(((xy - mins) / cell_m).astype(np.int64), 0, shape - 1)
            flat = ij[:, 0] * shape[1] + ij[:, 1]
            counts += np.bincount(flat, minlength=counts.size)
    return counts.reshape(shape)
```

## Recommended Density by Asset Class

Targets are stated in ppsm for the delivered, classified cloud — not raw returns. Tolerance is the geometric accuracy the density must support; tighten the target one band when the corridor carries safety-critical clearance measurements.

| Asset class | Target (ppsm) | Typical corridor | Critical tolerance |
|---|---|---|---|
| Structural (bridges, tunnels, substations) | 50–100 | Deck soffits, tunnel linings, switchgear, clearance envelopes | ±2–5 cm |
| Road corridor | 25–40 | Carriageway geometry, kerbs, drainage, sign faces | ±5–8 cm |
| Rail corridor | 25–40 | Track centreline, ballast, OLE masts, platform edges | ±3–6 cm |
| Power-line corridor | 20–35 | Conductor catenary, pylon steelwork, vegetation encroachment | ±5–10 cm |
| Broad terrain / right-of-way | 8–15 | Earthwork volumes, watershed, regional planning | ±10–15 cm |

These bands sit inside the wider [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) framework. For authoritative accuracy benchmarks, cross-reference the [USGS 3DEP Lidar Base Specification](https://pubs.usgs.gov/tm/11b4/) and the ASPRS Positional Accuracy Standards.

<figure class="diagram">
<svg viewBox="-23 2 806 304" role="img" aria-labelledby="pd-ladder-t pd-ladder-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pd-ladder-t">From points per square metre to the feature size it actually resolves</title>
  <desc id="pd-ladder-d">Nominal point spacing is one over the square root of the density, and a feature needs roughly three spacings across it before it is reliably reconstructed. Two points per square metre resolves landform, eight resolves kerbs and roof planes, twenty resolves signage and bearings, and fifty is what conductors and bolts require.</desc>
  <rect class="svg-bg" x="-23" y="2" width="806" height="304" fill="#ffffff"/>
  <text x="380" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">spacing = 1 / √density · a feature needs about three spacings across it to survive</text>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="95" y="54">points per m²</text>
    <text x="251" y="54">nominal spacing</text>
    <text x="422" y="54">smallest resolved</text>
    <text x="618" y="54">what that buys you</text>
  </g>
    <rect x="30" y="70" width="130" height="40" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
    <rect x="176" y="70" width="150" height="40" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
    <rect x="342" y="70" width="160" height="40" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="518" y="70" width="200" height="40" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
    <rect x="30" y="122" width="130" height="40" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
    <rect x="176" y="122" width="150" height="40" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
    <rect x="342" y="122" width="160" height="40" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="518" y="122" width="200" height="40" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
    <rect x="30" y="174" width="130" height="40" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
    <rect x="176" y="174" width="150" height="40" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
    <rect x="342" y="174" width="160" height="40" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="518" y="174" width="200" height="40" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
    <rect x="30" y="226" width="130" height="40" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
    <rect x="176" y="226" width="150" height="40" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
    <rect x="342" y="226" width="160" height="40" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="518" y="226" width="200" height="40" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="95">2 /m²</text>
    <text x="251" y="95">0.71 m</text>
    <text x="422" y="95">≈ 2.1 m</text>
    <text x="618" y="95">landform, flood extent</text>
    <text x="95" y="147">8 /m²</text>
    <text x="251" y="147">0.35 m</text>
    <text x="422" y="147">≈ 1.1 m</text>
    <text x="618" y="147">kerbs, ditch banks, roof planes</text>
    <text x="95" y="199">20 /m²</text>
    <text x="251" y="199">0.22 m</text>
    <text x="422" y="199">≈ 0.67 m</text>
    <text x="618" y="199">signage, bearings, parapets</text>
    <text x="95" y="251">50 /m²</text>
    <text x="251" y="251">0.14 m</text>
    <text x="422" y="251">≈ 0.42 m</text>
    <text x="618" y="251">conductors, bolts, expansion joints</text>
  </g>
  <text x="380" y="288" fill="#5b6471" font-size="12" text-anchor="middle">Write the specification against the smallest asset the twin must measure, then read the density off this relation — not the other way round</text>
</svg>
<figcaption>Density is a means, not a requirement. Naming the feature first makes the number defensible and stops corridor specs from being copied between projects with different assets.</figcaption>
</figure>

## Expected Output & Verification

Run the workflow on a healthy 30 ppsm rail acquisition and step 2 should print a mean near or above target with a median close behind:

```text
mean 32.4 ppsm  median 31.0  p10 24.7
4.1% of occupied cells below 30 ppsm
acceptance (<=5% sparse): PASS
```

Verify three things, not just the mean. First, the **p10** (tenth-percentile ppsm) should stay above roughly 0.7× target — here 24.7 against a 30 ppsm target is acceptable, since flight-line edges always thin out. Second, the **sparse fraction** must clear your acceptance gate (≤5% is a common corridor threshold). Third, plot the `easting`/`northing` of flagged cells from the Parquet file against flight-line overlap: clusters under bridges or beside cuttings are real occlusion gaps to re-fly, while a thin scatter along water bodies is a legitimate void. A quick assertion turns the check into a pipeline gate:

```python
assert ppsm.mean() >= TARGET_PPSM, f"mean {ppsm.mean():.1f} below {TARGET_PPSM} ppsm"
assert sparse_pct <= 5.0, f"{sparse_pct:.1f}% sparse cells exceeds 5% gate"
```

## Common Errors

**`laspy.errors.LaspyException: Could not find a laz backend`** — you opened a `.laz` without a decompression backend. `laspy` reads `.las` natively but needs `lazrs` or `laszip` for compressed files. Fix with `pip install "laspy[lazrs]>=2.4"`, or convert to `.las` first.

**Density off by ~10¹⁰ (e.g. 0.000003 ppsm)** — the cloud is still in a geographic CRS such as EPSG:4326, so coordinates are degrees and each "cell" spans roughly 111 km. The `crs.is_projected` assertion in step 1 catches this. Reproject to a metric CRS like EPSG:32618 with `pdal`/`pyproj` before binning.

**`ValueError: minlength must not be negative` or a `MemoryError` on `np.bincount`** — the grid `shape.prod()` overflowed because `cell_m` was set too small (e.g. 0.05 m) over a multi-kilometre extent, demanding billions of cells. Use a 0.5–1.0 m cell for corridor density and switch to the chunked variant in step 5 for large swaths.

## Frequently Asked Questions

### Why measure in ppsm instead of average point spacing?
Average point spacing (in metres) and ppsm describe the same data, but ppsm is additive across a grid cell and survives non-uniform sampling, which corridors always have. A cell at 30 ppsm tells you directly how many returns a 1 m² clearance measurement can draw on, whereas a quoted "nominal pulse spacing" hides the cross-section thinning under structures. Acceptance specs in ppsm also bin cleanly with `np.bincount`, so the metric and the verification code stay in lockstep.

### What cell size should I use for the density grid?
Use 1.0 m for general corridor acceptance — it makes the count equal the ppsm and matches most spec language. Drop to 0.5 m when verifying fine structural elements (bridge soffits, switchgear) where a 1 m cell would average over the feature you care about. Going below ~0.25 m mostly measures sensor noise and inflates the cell count, so reserve it for targeted patches rather than the whole swath.

### My mean ppsm passes but clearances still fail — what's wrong?
A passing mean hides localised sparsity. Clearance failures almost always come from occlusion: the conductor underside or bridge soffit sits in a shadow where the airborne sensor never had line of sight. Inspect the flagged-cell Parquet, isolate clusters at structures, and fill them with terrestrial or mobile scanning rather than re-flying the whole corridor — see the broader [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) treatment of how density feeds mesh accuracy.

## Related Guides

- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — the density framework and per-class baselines
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — how density drives raster resolution
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — the classification step that reduces delivered density
- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — getting into a metric CRS before binning

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/)
