---
title: "PDAL vs Open3D for Point Cloud Filtering"
description: "Choose between PDAL and Open3D for point cloud filtering: declarative pipeline JSON with CRS-aware LAS readers vs an in-memory numpy API, with EPSG:32618 code"
---
# PDAL vs Open3D for Point Cloud Filtering: Choosing the Right Tool

Both [PDAL](https://pdal.io/) and [Open3D](https://www.open3d.org/) can strip outliers, thin density, and classify ground on a LiDAR scan, but they are built on opposite philosophies: PDAL is a declarative, CRS-aware pipeline engine that reads `.laz` headers and streams tiles through a JSON stage graph, while Open3D is an in-memory research library that hands you a `numpy`-backed `PointCloud` and expects you to manage coordinates and metadata yourself. This page decides between them for a filtering step — comparing outlier removal, ground classification, and voxel downsampling in each, their behaviour on large `.laz`, and how each treats a coordinate reference system such as EPSG:32618 (UTM zone 18N) — and ends with a verdict on when to reach for one, the other, or both.

You hit this decision the moment your filtering step outgrows a one-off script. If you already have both installed after reading the broader [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) guide, the question is no longer *how* to run statistical outlier removal but *which engine owns the stage* — because the choice dictates whether your CRS is preserved automatically, whether a billion-point survey fits in RAM, and whether the run is reproducible from a committed JSON file or a Python notebook.

<figure class="diagram">
<svg viewBox="2 34 796 308" role="img" aria-labelledby="pdvo-t pdvo-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pdvo-t">Capability matrix: PDAL versus Open3D per filtering task</title>
  <desc id="pdvo-d">A three-column table lists five filtering tasks and the corresponding PDAL stage and Open3D method for each: statistical outlier removal, radius outlier removal, voxel downsampling, ground classification, and reading a CRS from a LAS header.</desc>
  <rect class="svg-bg" x="2" y="34" width="796" height="308" fill="#ffffff"/>
  <rect x="16" y="48" width="232" height="40" rx="8" fill="#1f6b8a" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="264" y="48" width="256" height="40" rx="8" fill="#1f6b8a" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="536" y="48" width="248" height="40" rx="8" fill="#1f6b8a" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="16" y="96" width="232" height="40" rx="8"/>
    <rect x="16" y="144" width="232" height="40" rx="8"/>
    <rect x="16" y="192" width="232" height="40" rx="8"/>
    <rect x="16" y="240" width="232" height="40" rx="8"/>
    <rect x="16" y="288" width="232" height="40" rx="8"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="264" y="96" width="256" height="40" rx="8"/>
    <rect x="264" y="144" width="256" height="40" rx="8"/>
    <rect x="264" y="192" width="256" height="40" rx="8"/>
    <rect x="264" y="240" width="256" height="40" rx="8"/>
    <rect x="264" y="288" width="256" height="40" rx="8"/>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="536" y="96" width="248" height="40" rx="8"/>
    <rect x="536" y="144" width="248" height="40" rx="8"/>
    <rect x="536" y="192" width="248" height="40" rx="8"/>
    <rect x="536" y="240" width="248" height="40" rx="8"/>
    <rect x="536" y="288" width="248" height="40" rx="8"/>
  </g>
  <g font-size="13" text-anchor="middle">
    <text x="132" y="73" fill="#ffffff">Filtering task</text>
    <text x="392" y="73" fill="#ffffff">PDAL stage</text>
    <text x="660" y="73" fill="#ffffff">Open3D method</text>
  </g>
  <g font-size="12" text-anchor="middle" fill="#1f2937">
    <text x="132" y="121">SOR outlier</text>
    <text x="132" y="169">Radius outlier</text>
    <text x="132" y="217">Voxel downsample</text>
    <text x="132" y="265">Ground classify</text>
    <text x="132" y="313">Read CRS from LAS</text>
    <text x="392" y="121">filters.outlier statistical</text>
    <text x="392" y="169">filters.outlier radius</text>
    <text x="392" y="217">filters.voxelcentroid</text>
    <text x="392" y="265">filters.smrf</text>
    <text x="392" y="313">readers.las (automatic)</text>
    <text x="660" y="121">remove_statistical_outlier</text>
    <text x="660" y="169">remove_radius_outlier</text>
    <text x="660" y="217">voxel_down_sample</text>
    <text x="660" y="265">none built in</text>
    <text x="660" y="313">CRS-agnostic (you track it)</text>
  </g>
</svg>
<figcaption>The same five tasks in each library: PDAL exposes them as declarative stages that carry the CRS; Open3D exposes numpy methods that do not.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with both stacks: `conda install -c conda-forge pdal python-pdal` (PDAL's native GDAL/PROJ chain installs far more reliably through conda) and `pip install "open3d>=0.18" "laspy[lazrs]>=2.5" "numpy>=1.24" "pyproj>=3.6"`.
- A test scan in LAS/LAZ (ASPRS point format 6 or 7) carrying a valid CRS in its header. The worked examples use EPSG:32618 (UTM zone 18N, metres) throughout; every distance parameter below is in metres because of it.
- Confirm the PDAL stage registry: `pdal --drivers | grep filters.outlier` should list the outlier filter, and `pdal --version` should report a PROJ build so CRS reprojection stages resolve.

## The core difference: declarative pipeline vs in-memory API

PDAL models filtering as a directed graph of stages serialised to JSON. You name a reader, a chain of `filters.*` stages, and a writer; PDAL streams points through them, and — critically — the [GDAL](https://gdal.org/)/PROJ machinery underneath reads the source EPSG straight from the LAS header and can reproject inside the same pipeline. Nothing about the CRS is your job unless you want to change it. The whole run is a text document you commit to version control, which is why PDAL is the natural fit for a CI-driven ingestion stage.

Open3D takes the opposite stance. `o3d.io.read_point_cloud` and the LAS-via-`laspy` path both discard georeferencing; you get a `PointCloud` wrapping a `numpy` array of raw XYZ and nothing else. That is a feature when your next step is normal estimation, registration, or reconstruction — the data is already a numpy array you can hand to any scientific library — but it means the EPSG code lives only in your head (or a sidecar you write yourself), and a whole survey must fit in memory because there is no streaming layer.

### PDAL: one declarative pipeline, CRS carried end to end

The following pipeline reads a `.laz` in EPSG:32618, runs statistical then radius outlier removal, classifies ground with SMRF, voxel-thins, and writes a LAZ with the CRS re-stamped — all without a line of coordinate handling on your side.

```python
import pdal
import json

pipeline = pdal.Pipeline(json.dumps({
    "pipeline": [
        {"type": "readers.las", "filename": "block_utm18n.laz"},
        {"type": "filters.outlier", "method": "statistical",
         "mean_k": 20, "multiplier": 2.0},
        {"type": "filters.outlier", "method": "radius",
         "radius": 0.25, "min_k": 8},
        {"type": "filters.range", "limits": "Classification![7:7]"},  # drop flagged noise
        {"type": "filters.smrf", "scalar": 1.2, "slope": 0.2,
         "threshold": 0.45, "window": 16.0},
        {"type": "filters.voxelcentroid", "cell": 0.10},
        {"type": "writers.las", "filename": "block_filtered.laz",
         "a_srs": "EPSG:32618", "compression": "laszip"}
    ]
}))
n_points = pipeline.execute()
meta = pipeline.metadata           # stage-by-stage counts, bounds, SRS
print(f"{n_points:,} points written in EPSG:32618")
```

`filters.outlier` flags outliers by setting `Classification` to 7 rather than deleting them, so the subsequent `filters.range` is what actually removes them — an audit-friendly separation the declarative model makes explicit. The `a_srs` on the writer guarantees the output header carries EPSG:32618 forward.

### Open3D: numpy in memory, CRS is yours to track

Open3D cannot read `.laz`, so `laspy` loads it and you build the cloud from a numpy array, recording the EPSG yourself. The same filters are one method call each, returning the surviving cloud and the kept indices.

```python
import laspy
import numpy as np
import open3d as o3d

SRC_EPSG = "EPSG:32618"                    # you record this — Open3D will not
las = laspy.read("block_utm18n.laz")
xyz = np.vstack((las.x, las.y, las.z)).T.astype(np.float64)

# Shift to a local origin so KD-tree math stays precise on 6-figure UTM eastings.
origin = xyz.min(axis=0)
pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(xyz - origin)

pcd, keep_sor = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
pcd, keep_rad = pcd.remove_radius_outlier(nb_points=8, radius=0.25)   # metres, EPSG:32618
pcd = pcd.voxel_down_sample(voxel_size=0.10)

out_xyz = np.asarray(pcd.points) + origin  # restore absolute EPSG:32618 coordinates
print(f"{len(out_xyz):,} points; EPSG {SRC_EPSG} tracked out of band")
```

Notice what Open3D forces you to do that PDAL did for free: subtract a local origin to protect float precision, and thread `SRC_EPSG` through by hand. Notice also what Open3D gives you that PDAL does not — `keep_sor` and `keep_rad` are numpy index arrays you can immediately apply to intensity or RGB, and `pcd` is one call away from `estimate_normals` for reconstruction.

## Ground classification: PDAL wins outright

Ground/bare-earth separation is the sharpest capability gap. PDAL ships `filters.smrf` (Simple Morphological Filter), `filters.pmf`, and `filters.csf` as first-class stages that write ASPRS class 2 into the point record. Open3D has no ground filter at all — you would reimplement a morphological or cloth-simulation algorithm on the numpy array yourself, or shell out to PDAL. If your filtering step needs a DTM or a vegetation strip, that alone decides it.

```python
# PDAL: ground stays a one-liner in the graph.
ground = pdal.Pipeline(json.dumps({
    "pipeline": [
        "block_filtered.laz",
        {"type": "filters.smrf", "slope": 0.2, "window": 18.0, "threshold": 0.45},
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.las", "filename": "ground_dtm.laz", "a_srs": "EPSG:32618"}
    ]
}))
ground.execute()
```

## Performance on large .laz

<figure class="diagram">
<svg viewBox="29 2 685 300" role="img" aria-labelledby="po-mem-t po-mem-d" xmlns="http://www.w3.org/2000/svg">
  <title id="po-mem-t">Streaming stages against a whole-cloud array</title>
  <desc id="po-mem-d">PDAL moves points through its stage chain in fixed-size views, so peak memory is set by the view size rather than by the file. Open3D materialises the entire cloud as numpy arrays and every filter allocates another copy, so peak memory scales with the survey and crosses the machine's limit somewhere around a billion points.</desc>
  <rect class="svg-bg" x="29" y="2" width="685" height="300" fill="#ffffff"/>
  <path d="M70 60 V218 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="90,212 200,208 310,205 420,203 530,201 640,200" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="90,206 200,180 310,150 420,120 530,88 640,66" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <path d="M70 96 H700" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="700" y="90" fill="#b0413e" font-size="12" text-anchor="end">machine RAM</text>
  <text x="392" y="196" fill="#4f7a4d" font-size="12" text-anchor="middle">PDAL — flat, set by the view size</text>
  <text x="440" y="112" fill="#9a4f26" font-size="12" text-anchor="middle">Open3D — one array per filter, per cloud</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="90" y="238">50 M</text>
    <text x="200" y="238">100 M</text>
    <text x="310" y="238">250 M</text>
    <text x="420" y="238">500 M</text>
    <text x="530" y="238">1 B</text>
    <text x="640" y="238">2 B</text>
  </g>
  <text x="380" y="262" fill="#5b6471" font-size="12" text-anchor="middle">points in the survey</text>
  <text x="370" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Peak memory as the survey grows — the axis that decides the choice</text>
  <text x="370" y="284" fill="#15384a" font-size="12" text-anchor="middle">Open3D is not slower; it simply has to hold the cloud, so above a few hundred million points it stops being an option</text>
</svg>
<figcaption>Both libraries filter at similar speed per point. What separates them at survey scale is whether the whole cloud has to be resident to do it.</figcaption>
</figure>

PDAL streams. Stages such as `filters.range`, `filters.voxelcentroid`, and the outlier filters run in a streaming mode that processes points in fixed-size buffers, and `filters.splitter` or `filters.chipper` tile a multi-billion-point survey so nothing exceeds memory. A national-grid `.laz` that would never fit in RAM flows through a PDAL pipeline on a modest machine.

Open3D holds everything resident. A `PointCloud` over 50 M points already wants several gigabytes, and `remove_statistical_outlier` builds a KD-tree over the whole array, so you must tile the cloud yourself — read with `laspy.open(...).chunk_iterator(n)`, filter each chunk, buffer the tile edges, and merge — reproducing by hand the chunking PDAL does declaratively. Where PDAL is memory-bounded by design, Open3D is memory-bounded by your discipline.

<figure class="diagram">
<svg viewBox="10 12 720 262" role="img" aria-labelledby="po-crs-t po-crs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="po-crs-t">Which library carries the coordinate reference system for you</title>
  <desc id="po-crs-d">A PDAL pipeline reads the CRS from the LAS header, threads it through every stage, and writes it back into the output header. Open3D reads only the coordinates, so the CRS exists solely in whatever variable the caller kept, and the written file carries none unless the caller writes it separately.</desc>
  <rect class="svg-bg" x="10" y="12" width="720" height="262" fill="#ffffff"/>
  <defs>
    <marker id="po-crs-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="24" y="54" width="150" height="50" rx="8"/>
    <rect x="224" y="54" width="150" height="50" rx="8"/>
    <rect x="424" y="54" width="150" height="50" rx="8"/>
    <rect x="600" y="54" width="116" height="50" rx="8"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="24" y="164" width="150" height="50" rx="8"/>
    <rect x="424" y="164" width="150" height="50" rx="8"/>
  </g>
  <rect x="224" y="164" width="150" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="600" y="164" width="116" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#po-crs-a)">
    <line x1="174" y1="79" x2="222" y2="79"/>
    <line x1="374" y1="79" x2="422" y2="79"/>
    <line x1="574" y1="79" x2="598" y2="79"/>
    <line x1="174" y1="189" x2="222" y2="189"/>
    <line x1="374" y1="189" x2="422" y2="189"/>
    <line x1="574" y1="189" x2="598" y2="189"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="99" y="84">readers.las</text>
    <text x="299" y="84">filters.outlier</text>
    <text x="499" y="84">filters.smrf</text>
    <text x="658" y="84">writers.las</text>
    <text x="99" y="184"><tspan x="99" dy="0">read_point_cloud</tspan><tspan x="99" dy="15">coordinates only</tspan></text>
    <text x="299" y="184"><tspan x="299" dy="0">CRS lives in your</tspan><tspan x="299" dy="15">own variable now</tspan></text>
    <text x="499" y="184"><tspan x="499" dy="0">numpy operations</tspan><tspan x="499" dy="15">unaware of it</tspan></text>
    <text x="658" y="184"><tspan x="658" dy="0">written file</tspan><tspan x="658" dy="15">has no CRS</tspan></text>
  </g>
  <text x="24" y="40" fill="#4f7a4d" font-size="12.5" text-anchor="start" font-weight="600">PDAL — the header travels with the points</text>
  <text x="24" y="150" fill="#b0413e" font-size="12.5" text-anchor="start" font-weight="600">Open3D — the header stops at the reader</text>
  <text x="370" y="256" fill="#5b6471" font-size="12" text-anchor="middle">Neither behaviour is wrong; only one of them survives being handed to a colleague six months later</text>
</svg>
<figcaption>This is the difference that decides most pipelines. Open3D's speed is real, and so is the fact that its output is a bag of numbers whose frame is documented nowhere.</figcaption>
</figure>

## Decision table

| Criterion | PDAL | Open3D |
|---|---|---|
| Programming model | Declarative JSON stage graph | Imperative numpy method calls |
| CRS handling | Reads EPSG from LAS, reprojects in-pipeline via PROJ | CRS-agnostic; you track EPSG:32618 yourself |
| LAS/LAZ I/O | Native `readers.las` / `writers.las` | None; needs `laspy` to load, discards header |
| SOR / radius outlier | `filters.outlier` (statistical, radius) | `remove_statistical_outlier`, `remove_radius_outlier` |
| Voxel downsample | `filters.voxelcentroid` / `filters.voxeldownsize` | `voxel_down_sample` |
| Ground classification | `filters.smrf` / `pmf` / `csf` built in | Not available |
| Large-file scaling | Streaming + `filters.splitter`/`chipper` | In-memory; manual chunking required |
| Reproducibility | Whole run is a committable JSON document | Lives in a Python script/notebook |
| Bridge to meshing | Exports LAS/PLY for the next tool | One step from normals + reconstruction |
| Audit trail | Stage metadata + classification flags | Kept-index numpy arrays per filter |

## Verdict

Choose **PDAL** when the filtering step is part of an ingestion pipeline: it reads and preserves the CRS automatically, ground-classifies natively, streams `.laz` far larger than RAM, and reduces to a JSON document you gate in CI. Choose **Open3D** when filtering is the front of a geometry-processing chain that stays in memory — outlier removal followed by normal estimation and [surface reconstruction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — where having the cloud as a live numpy array and the kept-index arrays for attribute alignment is worth managing the EPSG yourself.

In practice most production twins use **both**, and the seam is clean: let PDAL own ingestion — read the header, reproject to EPSG:32618, classify ground, clip, and tile — then hand each tile to Open3D for the in-memory geometry work. The [terrestrial LiDAR noise-removal walkthrough](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) is a pure-Open3D example of that second half; a PDAL splitter feeding it is the pairing that scales to a city. The one rule that spans both tools is to keep every distance parameter in a metric CRS — a `radius` of `0.25` is 25 cm in EPSG:32618 and a meaningless 0.25 degrees in EPSG:4326.

## Expected Output & Verification

Run both paths on the same scan and the surviving point counts should agree to within a couple of percent; the small gap comes from the two libraries computing the statistical cutoff slightly differently, not from a bug. Report the retained ratio from each so a parameter drift fails loudly:

```python
def retained(before, after, tag):
    print(f"{tag:14s} {before:>12,} -> {after:>12,}  ({after/before:.1%})")

retained(len(las.points), n_points, "PDAL")
retained(len(las.points), len(out_xyz), "Open3D")

assert abs(n_points - len(out_xyz)) / len(las.points) < 0.05, \
    "PDAL and Open3D diverged >5% — check radius units and CRS"
```

Sample console output for a 12 M-point urban tile:

```text
PDAL            12,140,551 ->   11,402,338  (93.9%)
Open3D          12,140,551 ->   11,318,090  (93.2%)
```

Confirm the CRS actually survived the PDAL side — the most common silent defect is a writer without `a_srs`:

```bash
pdal info block_filtered.laz --metadata | grep -i srs
```

## Common Errors

**`RuntimeError: Unable to convert ... no SRS` or an empty output SRS from PDAL.** The `readers.las` found no CRS in the source header, or the `writers.las` omitted `a_srs`. PDAL cannot reproject or stamp a frame it was never given. Set `"a_srs": "EPSG:32618"` on the writer, and if the source header is blank, add `"spatialreference": "EPSG:32618"` to the reader so every downstream stage — and every distance filter — runs in metres.

**`RuntimeError: [Open3D ERROR] ... Unknown file extension for file (block_utm18n.laz)`.** Open3D has no LAS/LAZ reader. Load with `laspy.read` and build the `PointCloud` from a numpy array as shown; never call `o3d.io.read_point_cloud` on a `.laz` directly.

**Open3D radius filter removes almost everything (or nothing).** Either the cloud is still in geographic EPSG:4326 so a `radius=0.25` "metre" is really 0.25 degrees, or the local-origin shift was skipped and large UTM eastings lost float precision in the KD-tree. Reproject to EPSG:32618 and subtract `origin` before filtering — the step PDAL performs for you and Open3D does not.

## Related Guides

- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — the full SOR, radius, voxel, and ground toolkit both libraries implement
- [Removing Noise from Terrestrial LiDAR Scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) — a pure-Open3D noise-removal walkthrough for the in-memory half
- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — where an Open3D-filtered cloud goes next
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — choosing the metric EPSG both tools depend on

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
