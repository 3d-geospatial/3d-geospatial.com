# Converting Point Clouds to 3D Tiles with py3dtiles

This page converts classified LAZ point clouds into a streamable 3D Tiles point cloud tileset with `py3dtiles` — preparing the input with PDAL so heights are ellipsoidal before the converter sees them, running the conversion from UTM 18N (EPSG:32618) to Earth-centred EPSG:4978, sizing jobs and cache for the machine, and auditing the output `.pnts` files so every input point is accounted for.

## Why you hit this

A browser cannot open a 40 GB LAZ collection, and a digital twin should not ask it to. Point cloud tilesets split the cloud into an octree of small binary tiles that a viewer streams by screen-space error, which is how Cesium, iTwin and deck.gl display city-scale scans. `py3dtiles` is the most direct open-source route from LAS to that format in a Python pipeline. Its defaults are good; what goes wrong is almost always the input — mixed CRSs across files, orthometric heights treated as ellipsoidal, noise points that stretch the octree's bounding box a kilometre into the sky. The octree addressing underneath the output is covered in [octree indexing point clouds with Morton codes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/octree-indexing-point-clouds-with-morton-codes/).

## Prerequisites

- `py3dtiles>=7.0` with LAZ support (`pip install "py3dtiles[las]"`), `pdal>=3.4` Python bindings on PDAL 2.6+, `pyproj>=3.6`, `numpy>=1.24`.
- Input LAZ in EPSG:32618 with NAVD88 heights (compound EPSG:32618+5703), classified to ASPRS codes.
- The GEOID18 grid available to PROJ (`us_noaa_g2018u0.tif`), via `PROJ_NETWORK=ON` or a local copy.
- Free disk of roughly the input LAZ size: py3dtiles writes uncompressed intermediate node files while it builds the tree.

## Step-by-Step

### 1. Prepare the input with PDAL: drop noise, make heights ellipsoidal

```python
import json
from pathlib import Path
import pdal

RAW = sorted(Path("raw").glob("*.laz"))
PREP = Path("prep"); PREP.mkdir(exist_ok=True)

for src in RAW:
    pipeline = {
        "pipeline": [
            {"type": "readers.las", "filename": str(src), "override_srs": "EPSG:32618+5703"},
            {"type": "filters.range", "limits": "Classification![7:7],Classification![18:18]"},
            {"type": "filters.reprojection",
             "in_srs": "EPSG:32618+5703",
             "out_srs": "+proj=utm +zone=18 +datum=WGS84 +units=m +type=crs"},
            {"type": "writers.las", "filename": str(PREP / src.name),
             "a_srs": "EPSG:32618", "compression": "laszip", "forward": "all",
             "scale_x": 0.001, "scale_y": 0.001, "scale_z": 0.001, "offset_x": "auto",
             "offset_y": "auto", "offset_z": "auto"},
        ]
    }
    count = pdal.Pipeline(json.dumps(pipeline)).execute()
    print(f"{src.name}: {count:,} points written")
```

Two things happen here that py3dtiles cannot do for you. Classes 7 and 18 — low and high noise — are removed, because a single bird return 900 m above the city expands the root bounding volume and pushes every real point one or two octree levels deeper than necessary. And the NAVD88 heights are converted to heights above the WGS84 ellipsoid: the output CRS is UTM 18N with no vertical component, which PROJ treats as ellipsoidal. The converter's transformation to EPSG:4978 then starts from the height it assumes. Skip this and the whole tileset floats or sinks by the geoid separation — about 33 m below where it should be in New York.

<figure class="diagram">
<svg viewBox="26 18 708 236" role="img" aria-labelledby="p3t-h-t p3t-h-d" xmlns="http://www.w3.org/2000/svg">
  <title id="p3t-h-t">Why heights must be ellipsoidal before conversion</title>
  <desc id="p3t-h-d">A cross-section showing the geoid about 33 metres below the WGS84 ellipsoid in New York. A LiDAR point with an orthometric NAVD88 height of 12 metres lies 12 metres above the geoid, which is minus 21 metres relative to the ellipsoid. If the converter treats 12 as an ellipsoidal height, the point is placed 33 metres too high.</desc>
  <rect class="svg-bg" x="26" y="18" width="708" height="236" fill="#ffffff"/>
  <path d="M40 80 C220 72 520 72 720 80" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M40 170 C220 164 520 168 720 172" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M40 206 H720" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="4 4"/>
  <circle cx="330" cy="140" r="7" fill="#1f2937"/>
  <circle cx="330" cy="50" r="7" fill="#b0413e"/>
  <path d="M330 168 V148" fill="none" stroke="#1f2937" stroke-width="2"/>
  <path d="M470 78 V168" fill="none" stroke="#9a4f26" stroke-width="2"/>
  <path d="M330 58 V132" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="700" y="66" fill="#1f6b8a" font-size="12.5" text-anchor="end">WGS84 ellipsoid, h = 0</text>
  <text x="700" y="192" fill="#4f7a4d" font-size="12.5" text-anchor="end">geoid, NAVD88 H = 0</text>
  <text x="484" y="128" fill="#9a4f26" font-size="12.5" text-anchor="start">N ≈ −33 m</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="end">
    <text x="318" y="144">true point: H = 12 m, h = −21 m</text>
  </g>
  <text x="344" y="46" fill="#b0413e" font-size="12.5" text-anchor="start">H read as h: 33 m too high</text>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">not to scale · the geoid lies below the ellipsoid along the US East Coast</text>
</svg>
<figcaption>py3dtiles transforms whatever z it receives as an ellipsoidal height. Converting in PDAL, where the vertical CRS is explicit, is the only place the geoid is applied.</figcaption>
</figure>

### 2. Confirm every prepared file shares one CRS and sensible bounds

```python
import laspy
import numpy as np

mins, maxs, crss = [], [], set()
for f in sorted(PREP.glob("*.laz")):
    with laspy.open(f) as r:
        h = r.header
        crss.add(h.parse_crs().to_epsg())
        mins.append(h.mins); maxs.append(h.maxs)
mins, maxs = np.min(mins, axis=0), np.max(maxs, axis=0)
print("CRS:", crss, "| extent (m):", (maxs - mins).round(1), "| z range:", mins[2].round(1), maxs[2].round(1))
assert crss == {32618}, "all inputs must share one horizontal CRS"
assert maxs[2] - mins[2] < 600, "z range too large: noise survived filtering"
```

The z-range assertion is tuned to the site. A coastal city with buildings under 450 m has no business spanning 600 m vertically; a mountain valley would need a larger limit. The point is to have one, because the bounding volume of the root tile is exactly this extent.

### 3. Run the conversion

```python
import os
import subprocess

jobs = max(1, os.cpu_count() - 2)
cmd = [
    "py3dtiles", "convert", *[str(p) for p in sorted(PREP.glob("*.laz"))],
    "--out", "tiles/harbour_pc",
    "--overwrite",
    "--srs_in", "32618",
    "--srs_out", "4978",
    "--jobs", str(jobs),
    "--cache_size", "6000",
]
print(" ".join(cmd[:4]), "…")
subprocess.run(cmd, check=True)
```

`--srs_out 4978` makes py3dtiles transform points to Earth-centred coordinates and store them relative to per-tile centres, so the viewer needs no further georeferencing. `--jobs` sets the number of worker processes; leave a core or two for the main process that reads and dispatches points, or it becomes the bottleneck. `--cache_size` is in megabytes and bounds how many points are held in memory before nodes are flushed to disk — raise it on a machine with plenty of RAM and the conversion does far less intermediate I/O.

<figure class="diagram">
<svg viewBox="-4 46 768 136" role="img" aria-labelledby="p3t-flow-t p3t-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="p3t-flow-t">From raw LAZ to a validated point cloud tileset</title>
  <desc id="p3t-flow-d">Raw LAZ files in EPSG:32618 plus NAVD88 go through PDAL, which removes noise classes and converts heights to ellipsoidal. A CRS and bounds check follows. py3dtiles converts to 3D Tiles in EPSG:4978 with a pnts file per octree node. A point-count audit compares the sum of points in all pnts files with the prepared input before publishing.</desc>
  <rect class="svg-bg" x="-4" y="46" width="768" height="136" fill="#ffffff"/>
  <defs>
    <marker id="p3t-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="60" width="120" height="66" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="160" y="60" width="130" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="320" y="60" width="120" height="66" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="470" y="60" width="130" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="630" y="60" width="120" height="66" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#p3t-flow-arrow)">
    <path d="M130 93 H158"/><path d="M290 93 H318"/><path d="M440 93 H468"/><path d="M600 93 H628"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="70" y="86">raw LAZ</text><text x="70" y="104">32618+5703</text>
    <text x="225" y="86">PDAL: noise out,</text><text x="225" y="104">h ellipsoidal</text>
    <text x="380" y="86">CRS + bounds</text><text x="380" y="104">assertions</text>
    <text x="535" y="86">py3dtiles</text><text x="535" y="104">→ EPSG:4978</text>
    <text x="690" y="86">point-count</text><text x="690" y="104">audit</text>
  </g>
  <text x="380" y="164" fill="#15384a" font-size="12.5" text-anchor="middle">Only the fourth box is the converter; the other four decide whether its output is right.</text>
</svg>
<figcaption>The conversion itself is one command. Preparation before it and an audit after it are what make the tileset trustworthy.</figcaption>
</figure>

### 4. Audit the output: every point accounted for

```python
import struct

def pnts_points(path):
    with open(path, "rb") as f:
        header = f.read(28)
        magic, version, byte_len, ft_json_len, ft_bin_len, bt_json_len, bt_bin_len = struct.unpack("<4s6I", header)
        assert magic == b"pnts", f"{path}: not a pnts file"
        feature_table = json.loads(f.read(ft_json_len).rstrip(b" \x00"))
    return feature_table["POINTS_LENGTH"], "RTC_CENTER" in feature_table

out = Path("tiles/harbour_pc")
tiles = list(out.rglob("*.pnts"))
counts = [pnts_points(p) for p in tiles]
total = sum(c for c, _ in counts)

prepared = 0
for f in PREP.glob("*.laz"):
    with laspy.open(f) as r:
        prepared += r.header.point_count

tileset = json.loads((out / "tileset.json").read_text())
print(f"{len(tiles):,} pnts files, {total:,} points in tiles, {prepared:,} prepared, "
      f"refine={tileset['root'].get('refine')}, all RTC: {all(r for _, r in counts)}")
assert total == prepared, "points were lost or duplicated during conversion"
```

A `.pnts` file starts with a 28-byte header — the magic, a version and five byte lengths — followed by a JSON feature table whose `POINTS_LENGTH` gives the count. py3dtiles builds an additive octree: every input point is written exactly once, in one node, with coarse nodes holding a sparse subset and finer nodes the remainder. That makes the audit exact. A total below the prepared count means a worker failed quietly or the disk filled; above it means an input file was listed twice.

## Expected Output & Verification

```text
h_2026_0412.laz: 18,402,110 points written
CRS: {32618} | extent (m): [2488.4 2490.1  311.7] | z range: -38.2 273.5
14,862 pnts files, 212,730,556 points in tiles, 212,730,556 prepared, refine=ADD, all RTC: True
```

The negative minimum z is the check that the datum conversion ran: ground at a few metres above NAVD88 near the harbour becomes around −30 m above the ellipsoid. Then verify placement against something independent. Pick a surveyed control point — a benchmark or a corner of a known building — and confirm its ECEF position, computed with `pyproj` from EPSG:32618+5703, lies within a few centimetres of the nearest point in the tile that contains it after applying that tile's `RTC_CENTER`.

<figure class="diagram">
<svg viewBox="26 6 584 242" role="img" aria-labelledby="p3t-add-t p3t-add-d" xmlns="http://www.w3.org/2000/svg">
  <title id="p3t-add-t">Points per octree level in an additive tileset</title>
  <desc id="p3t-add-d">Stacked horizontal bars show where points end up by octree level. The root and first levels hold a small, evenly spaced subset, and each deeper level holds more, with most points in the deepest few levels. Because refinement is additive, the sum across all levels equals the input count exactly.</desc>
  <rect class="svg-bg" x="26" y="6" width="584" height="242" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="40" y="20" width="8" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="52" width="30" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="84" width="96" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="116" width="250" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="148" width="470" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="180" width="330" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="58" y="37">level 0 · 0.2 M</text>
    <text x="80" y="69">level 2 · 1.4 M</text>
    <text x="146" y="101">level 4 · 9 M</text>
    <text x="300" y="133">level 6 · 44 M</text>
    <text x="520" y="165">level 8 · 96 M</text>
    <text x="380" y="197">level 10+ · 62 M</text>
  </g>
  <text x="340" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">sum of all levels = 212.7 M = input count, because each point is stored once</text>
</svg>
<figcaption>Additive refinement is what makes an exact count audit possible: coarse levels are samples of the data, not copies of it.</figcaption>
</figure>

## Common Errors

**The tileset renders 33 m in the air, or under the terrain.** Heights reached py3dtiles as NAVD88 orthometric values. Confirm the PDAL step ran with the compound `in_srs` and that PROJ found the GEOID18 grid — `projinfo -s EPSG:32618+5703 -t EPSG:4979` should list a GEOID18 operation, not a ballpark one.

**`pyproj.exceptions.CRSError` or points placed at the wrong zone.** Some inputs carry no CRS in their header and py3dtiles was not told `--srs_in`. Always pass it explicitly, and assert header CRSs in step 2 so missing ones fail before a two-hour conversion.

**Conversion slows to a crawl halfway through.** The cache filled and workers are flushing to a slow disk. Raise `--cache_size`, reduce `--jobs` so the dispatcher keeps up, or put the output directory on local SSD rather than network storage.

## Frequently Asked Questions

### Should I use py3dtiles or PDAL's writers.copc for streaming?

They target different viewers. COPC is a single LAZ file streamed by byte range, read by Potree, QGIS and web COPC viewers; 3D Tiles is what Cesium-family runtimes and many twin platforms load natively. Pipelines serving both often write both from the same prepared input.

### How do I keep classification and intensity?

py3dtiles writes classification and intensity into the batch table by default in recent versions; check the flags on your installed version with `py3dtiles convert --help`, and confirm by reading a `.pnts` batch table JSON after conversion.

### Can I convert tile by tile and merge later?

Yes, and for very large collections it is easier to operate. Convert each shard to its own tileset and combine them as described in [merging shard tilesets into a root tileset](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/merging-shard-tilesets-into-a-root-tileset/). Expect slightly more points at shard edges to be visible at coarse levels, because each shard builds its own sample.

### How long should a city-scale conversion take?

Throughput is dominated by LAZ decompression and disk writes, not by the tree building. As a planning figure, a 16-core machine with local NVMe converts in the region of 20 to 40 million points per minute from prepared LAZ; a 200-million-point district is a ten-minute job, and a whole city of several billion points is an overnight one. If a run is an order of magnitude slower than that, look at the storage first — network file systems and container overlay filesystems are the usual culprits.

### Does the output need Draco or other compression?

Point cloud tiles compress well, and Cesium supports Draco-compressed `.pnts` through the `3DTILES_draco_point_compression` extension. py3dtiles writes uncompressed tiles, which are simple to audit; compress in a separate post-processing step once the count audit has passed, so the audit always runs on tiles you can read with twenty lines of Python.

## Related Guides

- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — rebuilding only what changed
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the height conversion in depth
- [Reclassifying Noise and Overlap Points with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/reclassifying-noise-and-overlap-points-with-pdal/) — making classes 7 and 18 trustworthy

Back to [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
