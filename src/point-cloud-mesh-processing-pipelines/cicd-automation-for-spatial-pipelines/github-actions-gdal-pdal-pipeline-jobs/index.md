---
title: "GitHub Actions GDAL and PDAL Pipeline Jobs"
description: "Run a PDAL pipeline (reader.las to filters.range/outlier to writer.las) plus gdalwarp reprojection to EPSG:4979 in a pinned container on push/PR, with caching and artifacts."
---
# Running GDAL and PDAL Processing Jobs in GitHub Actions

This guide writes a GitHub Actions workflow that runs a PDAL point-cloud pipeline and a `gdalwarp` raster reprojection on every push and pull request, inside a container with pinned `pdal` and `gdal`, then caches the toolchain and uploads the processed tile as a build artifact. The processing is a PDAL pipeline JSON — `readers.las` → `filters.range` → `filters.outlier` → `writers.las` — followed by a `gdalwarp` reprojection with an explicit EPSG code.

You hit this the moment point-cloud processing needs to be reproducible: a teammate edits a filter threshold, and you want CI to re-run the exact same `pdal` build on the exact same fixture and prove the output still validates before the change can merge. This is the process stage of the broader [CI/CD automation for spatial pipelines](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) workflow.

<figure class="diagram">
<svg viewBox="0 0 820 300" role="img" aria-labelledby="gha-pdal-t gha-pdal-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gha-pdal-t">PDAL stage chain and gdalwarp reprojection in a CI job</title>
  <desc id="gha-pdal-d">A PDAL pipeline reads a LAS tile, applies a range filter then a statistical outlier filter, and writes a clean LAS; the result flows into a gdalwarp reprojection to EPSG:4979 and is uploaded as a build artifact.</desc>
  <defs>
    <marker id="gha-pdal-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="15" y="50" width="120" height="56" rx="8"/>
    <rect x="160" y="50" width="130" height="56" rx="8"/>
    <rect x="315" y="50" width="145" height="56" rx="8"/>
    <rect x="485" y="50" width="120" height="56" rx="8"/>
  </g>
  <rect x="210" y="190" width="200" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="470" y="190" width="170" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#gha-pdal-arrow)">
    <line x1="135" y1="78" x2="158" y2="78"/>
    <line x1="290" y1="78" x2="313" y2="78"/>
    <line x1="460" y1="78" x2="483" y2="78"/>
    <line x1="545" y1="106" x2="330" y2="188"/>
    <line x1="410" y1="218" x2="468" y2="218"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="75" y="74"><tspan x="75" dy="0">readers.las</tspan><tspan x="75" dy="16">.laz tile</tspan></text>
    <text x="225" y="74"><tspan x="225" dy="0">filters.range</tspan><tspan x="225" dy="16">Z limits</tspan></text>
    <text x="387" y="74"><tspan x="387" dy="0">filters.outlier</tspan><tspan x="387" dy="16">statistical</tspan></text>
    <text x="545" y="74"><tspan x="545" dy="0">writers.las</tspan><tspan x="545" dy="16">clean .laz</tspan></text>
    <text x="310" y="214"><tspan x="310" dy="0">gdalwarp</tspan><tspan x="310" dy="16">EPSG:4979</tspan></text>
    <text x="555" y="214"><tspan x="555" dy="0">upload-artifact</tspan><tspan x="555" dy="16">clean tile</tspan></text>
  </g>
</svg>
<figcaption>The PDAL stage chain reads, range-filters, and outlier-filters the cloud, writes a clean LAS, then gdalwarp reprojects the companion raster to EPSG:4979 and CI uploads the result.</figcaption>
</figure>

## Prerequisites

- A GitHub repository with a small `.laz` fixture committed (a few thousand points is enough to exercise the pipeline in CI without a large checkout).
- The source cloud in a known projected CRS — the examples use EPSG:32618 (WGS 84 / UTM zone 18N) — reprojected to EPSG:4979 (geographic 3D, WGS 84) so ellipsoidal height is carried explicitly for a downstream Cesium tiler.
- Familiarity with PDAL pipeline JSON: an array of stages where the reader, filters, and writer execute in order, each stage a JSON object with a `type`.
- The `osgeo/gdal:ubuntu-full-3.9.2` container image, which ships `gdalwarp` and `libgdal`; PDAL is installed on top with `apt`. Pin the image by digest in production so PROJ grids never drift.

## Step-by-Step

### 1. Write the PDAL pipeline JSON

The pipeline reads the LAS tile, clips implausible Z returns with `filters.range` (removing birds and low multipath before statistics run), removes statistical outliers with `filters.outlier`, and writes a clean LAS. `filters.outlier` only *flags* noise as classification 7; the trailing `filters.range` on `Classification![7:7]` is what actually drops it.

```json
{
  "pipeline": [
    {
      "type": "readers.las",
      "filename": "tiles/tile_18_3312.laz",
      "default_srs": "EPSG:32618"
    },
    {
      "type": "filters.range",
      "limits": "Z[-20:800]"
    },
    {
      "type": "filters.outlier",
      "method": "statistical",
      "mean_k": 8,
      "multiplier": 2.5
    },
    {
      "type": "filters.range",
      "limits": "Classification![7:7]"
    },
    {
      "type": "writers.las",
      "filename": "work/tile_18_3312_clean.laz",
      "compression": "laszip",
      "a_srs": "EPSG:32618"
    }
  ]
}
```

### 2. Reproject the companion raster with gdalwarp

Terrain that accompanies the cloud must land in the same delivery CRS. Reproject with an explicit `-t_srs`, name the source CRS with `-s_srs` when the file lacks one, and pick a resampler suited to continuous elevation (`bilinear`), never the default nearest-neighbour which stair-steps a DEM.

```bash
gdalwarp \
  -s_srs EPSG:32618 -t_srs EPSG:4979 \
  -r bilinear -of GTiff \
  -co TILED=YES -co COMPRESS=DEFLATE \
  -overwrite \
  terrain/tile_18_3312.tif work/tile_18_3312_4979.tif
```

### 3. Drive both tools from the workflow YAML

Run the job in the pinned container, install PDAL, execute the PDAL pipeline with `pdal pipeline`, then the `gdalwarp` step. Trigger on push and pull request so every change is exercised.

```yaml
name: gdal-pdal-process
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  process:
    runs-on: ubuntu-24.04
    container:
      image: osgeo/gdal:ubuntu-full-3.9.2
    steps:
      - uses: actions/checkout@v4

      - name: Cache apt + PDAL install marker
        uses: actions/cache@v4
        with:
          path: /var/cache/apt/archives
          key: apt-pdal-${{ runner.os }}-2.7

      - name: Install PDAL
        run: |
          apt-get update
          apt-get install -y --no-install-recommends pdal
          pdal --version

      - name: Run PDAL pipeline (filter + reproject-ready clean LAS)
        run: |
          mkdir -p work
          pdal pipeline pipelines/filter_reproject.json

      - name: Reproject terrain with gdalwarp to EPSG:4979
        run: bash scripts/warp_terrain.sh

      - name: Upload processed tile
        uses: actions/upload-artifact@v4
        with:
          name: processed-tile_18_3312
          path: work/
          retention-days: 7
```

### 4. Override pipeline options from the command line

Committing one pipeline JSON and overriding its stage options at call time keeps a single reviewed pipeline while letting the workflow point it at different tiles or thresholds. `pdal pipeline` accepts `--stage.option value` overrides that patch the JSON in place, so the same `filter_reproject.json` drives every tile in a matrix without a templated file per tile.

```bash
TILE="tile_18_3312"
pdal pipeline pipelines/filter_reproject.json \
  --readers.las.filename="tiles/${TILE}.laz" \
  --writers.las.filename="work/${TILE}_clean.laz" \
  --filters.outlier.multiplier=2.5 \
  --filters.outlier.mean_k=8
```

Because the reader and writer filenames are injected here, the checked-in JSON can carry placeholder paths and the workflow stays the single source of truth for which tile runs. Keep the *filter thresholds* in the JSON, though — they are the reviewed parameters that a gate later asserts against, so they belong under version control rather than scattered across workflow steps.

### 5. Verify the PDAL result in the same job

Add a `pdal info` step so the job asserts the clean cloud is non-empty and carries the expected CRS before the artifact is uploaded. Piping through `python3` turns the JSON summary into a hard exit code.

```bash
pdal info work/tile_18_3312_clean.laz --metadata \
  | python3 -c '
import json, sys
meta = json.load(sys.stdin)["metadata"]
count = meta["count"]
srs = meta["srs"]["horizontal"]
assert count > 0, "clean cloud is empty"
assert "32618" in srs, f"unexpected CRS: {srs[:40]}"
print(f"PDAL OK: {count} points, EPSG:32618")
'
```

## Expected Output & Verification

A successful run prints the PDAL version, the point count surviving the filters, and the reprojection summary. The outlier filter typically drops 1–4% of a terrestrial tile as noise; a much larger drop means `multiplier` is too aggressive.

```text
PDAL 2.7.1 (git-version: ...)
pdal pipeline pipelines/filter_reproject.json
  readers.las:   1 482 905 points in
  filters.range (Z):     1 482 118 points
  filters.outlier:       flagged 31 774 as class 7
  filters.range (!7):    1 450 344 points out
Creating output file that is 2048P x 2048L.
Processing terrain/tile_18_3312.tif [1/1] - done.
PDAL OK: 1450344 points, EPSG:32618
```

Confirm the reprojected raster carries the target CRS with `gdalsrsinfo`, which should report the EPSG:4979 authority code rather than the source UTM zone:

```bash
gdalsrsinfo -o epsg work/tile_18_3312_4979.tif   # -> EPSG:4979
```

In the Actions run summary the `Upload processed tile` step lists `processed-tile_18_3312` as a downloadable artifact, and re-running the job on an unchanged fixture restores the apt cache so the PDAL install step reports a cache hit.

## Common Errors

**`PDAL: readers.las: Global encoding WKT flag not set for point format 6 - 10.`** The `.laz` is LAS 1.4 with a point format that requires a WKT CRS VLR, but the file only carries a legacy GeoTIFF key or none. PDAL cannot infer the CRS, so downstream reprojection is meaningless. Fix: set `default_srs` on `readers.las` (as in step 1) or repair the header with `pdal translate --writers.las.a_srs=EPSG:32618`, and never rely on an unstated CRS.

**`ERROR 1: PROJ: proj_create_from_database: crs not found` from gdalwarp.** The container's PROJ database predates the EPSG code you passed, or a typo turned `EPSG:4979` into a non-existent code. Fix: pin a GDAL image recent enough to know the code, verify with `projinfo EPSG:4979`, and pass the authority-qualified string (`EPSG:4979`) rather than a bare number.

**`filters.outlier` removes almost everything, leaving a near-empty cloud.** A `multiplier` set too low (for example `1.0`) combined with a small `mean_k` on a sparse tile flags dense-edge points as outliers. Fix: raise `multiplier` toward 2.5–3.0 and `mean_k` to 8–16, and inspect the flagged fraction in the `pdal info` step — a healthy terrestrial tile loses single-digit percentages, not the bulk of its points.

## Related Guides

- [Schema Validation Gates for Spatial Data](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — turning the processed tile into a merge-blocking check
- [Automated 3D Tiles Deployment to a CDN](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — promoting the validated artifact
- [Removing Noise from Terrestrial LiDAR Scans](/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) — the filtering theory behind the PDAL stages here

Back to [CI/CD Automation for Spatial Pipelines](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
