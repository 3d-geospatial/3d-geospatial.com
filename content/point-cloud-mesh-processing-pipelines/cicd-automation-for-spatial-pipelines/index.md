# CI/CD Automation for GDAL, PDAL, and 3D Tiles Spatial Pipelines

A spatial data pipeline that only runs on one engineer's laptop is a liability, not a product. The moment a second person edits a PDAL pipeline, bumps a GDAL version, or tweaks a decimation target, the output drifts — a reprojection lands in the wrong EPSG, a tileset gains a non-monotonic `geometricError`, or a `tileset.json` ships malformed and a client fails to load it in production. Continuous integration and continuous deployment fix this by making the pipeline itself the thing under version control: every change to processing code runs the same ingest → process → validate → publish sequence in a clean container, blocks the merge if any geometry or schema check fails, and promotes only validated artifacts to a CDN or [Cesium ion](https://cesium.com/platform/cesium-ion/). This page is the orchestration blueprint for that system — containerised GitHub Actions runners with pinned `gdal` and `pdal`, matrix jobs fanned out over tiles, caching, secrets handling, and artifact promotion — with the three deep-dive companions ([GitHub Actions GDAL/PDAL jobs](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/), [schema validation gates](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/), and [automated deployment to a CDN](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/)) covering each stage in runnable detail.

## Prerequisites

Pin every tool that touches geometry. Geospatial libraries change reprojection behaviour, default resampling, and geoid grids across minor versions, so an unpinned runner produces different coordinates on different days. Lock the container image digest, not just the tag.

| Component | Pinned version | Purpose |
|-----------|----------------|---------|
| GitHub Actions runner | `ubuntu-24.04` | Host for the containerised job |
| Container image | `osgeo/gdal:ubuntu-full-3.9.2` | GDAL CLI + libgdal, reproducible reprojection |
| `pdal` | 2.7.x (in-container) | Point-cloud pipeline execution |
| Python | 3.11 (in-container) | Orchestration, validation gates, boto3 deploy |
| `py3dtiles` | 8.0+ | `tileset.json` assembly for the tiling stage |
| `3d-tiles-validator` | 0.5+ (Node 18+) | Schema + bounding-volume validation gate |
| `laspy` / `pyproj` / `jsonschema` | 2.5+ / 3.6+ / 4.x | LAS header, CRS, and JSON Schema assertions |
| `boto3` / `aws-cli` | 1.34+ / 2.x | S3 / Cloudflare R2 sync in the deploy stage |

**Input formats.** The pipeline ingests classified `.laz`/`.las` point clouds and glTF 2.0 `.glb` meshes, and emits `b3dm`/`pnts` tiles plus a `tileset.json`. Fixtures — a small `.laz` tile and a golden `tileset.json` — live in the repository so pull-request runs exercise the real code path without pulling terabytes.

**Coordinate reference systems — assert, never infer.** Declare the source CRS explicitly (for example EPSG:32618 for a UTM zone 18N survey, or EPSG:25832 for central Europe) and the delivery CRS the tiler targets (EPSG:4978 geocentric for Cesium, reached via the EPSG:4979 geographic-3D hop so vertical datums resolve). A CI gate that re-reads the output CRS and fails on a mismatch is the single cheapest defence against silent georeferencing drift.

## Concept

A spatial CI/CD pipeline has four stages, and the contract between them is what CI enforces. **Ingest** pulls the source tile and validates its header — point count, declared EPSG, bounding box. **Process** runs the deterministic transforms: a PDAL pipeline for filtering and reprojection, `gdalwarp` for raster reprojection, a tiler for `b3dm` encoding. **Validate** is the gate — JSON Schema on `tileset.json`, `3d-tiles-validator`, CRS and unit assertions, LAS header checks — and it must exit non-zero to fail the job so a bad artifact can never merge. **Publish** promotes the validated bundle to object storage or a managed host, and only ever runs after the gate is green and only on the default branch.

Two properties make this reliable. First, **containerisation with pinned versions**: the exact `gdal`/`pdal` build runs identically on a contributor's fork and on the release runner, so "works on my machine" stops being a category of bug. Second, **artifact promotion**: the bytes validated on the pull request are the bytes deployed — CI uploads the processed tileset as a build artifact, the gate inspects that artifact, and the deploy stage downloads the same artifact rather than rebuilding, so nothing unreviewed slips between validation and publish. Fan-out is handled by a matrix over tiles, so a thousand-tile city rebuilds in parallel while each tile still passes the same gate.

<figure class="diagram">
<svg viewBox="0 0 860 340" role="img" aria-labelledby="cicd-flow-t cicd-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cicd-flow-t">CI/CD gate flow for a spatial tileset pipeline</title>
  <desc id="cicd-flow-d">A pull request triggers a build-and-process stage running GDAL and PDAL, whose output passes through validation gates; when the gates pass the tileset deploys to a CDN or Cesium ion, and when any gate fails a red branch blocks the merge with no deploy.</desc>
  <defs>
    <marker id="cicd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
    <marker id="cicd-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <rect x="20" y="120" width="120" height="64" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="185" y="120" width="150" height="64" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="380" y="120" width="150" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="700" y="120" width="150" height="64" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="380" y="250" width="200" height="64" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#cicd-arrow)">
    <line x1="140" y1="152" x2="183" y2="152"/>
    <line x1="335" y1="152" x2="378" y2="152"/>
    <line x1="530" y1="152" x2="698" y2="152"/>
  </g>
  <line x1="455" y1="184" x2="455" y2="248" stroke="#b0413e" stroke-width="2" marker-end="url(#cicd-arrow-red)"/>
  <text x="614" y="142" fill="#4f7a4d" font-size="12" text-anchor="middle">pass</text>
  <text x="474" y="222" fill="#b0413e" font-size="12" text-anchor="middle">fail</text>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="80" y="148"><tspan x="80" dy="0">Pull request</tspan><tspan x="80" dy="16">push / PR</tspan></text>
    <text x="260" y="148"><tspan x="260" dy="0">Build + process</tspan><tspan x="260" dy="16">GDAL · PDAL</tspan></text>
    <text x="455" y="148"><tspan x="455" dy="0">Validation gates</tspan><tspan x="455" dy="16">schema · CRS</tspan></text>
    <text x="775" y="148"><tspan x="775" dy="0">Deploy tileset</tspan><tspan x="775" dy="16">CDN · Cesium ion</tspan></text>
    <text x="480" y="278"><tspan x="480" dy="0">Gate fails:</tspan><tspan x="480" dy="16">block merge, no deploy</tspan></text>
  </g>
</svg>
<figcaption>The four-stage pipeline: a pull request processes tiles with GDAL and PDAL, the validation gates decide the outcome, and only a green gate promotes the artifact to a CDN or Cesium ion — a failed gate blocks the merge.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow below is one `.github/workflows/tiles.yml` file plus the Python glue it drives. It runs the whole pipeline in a pinned container, fans out over tiles, gates the merge, and promotes artifacts only from the default branch.

### 1. Pin the container and trigger

Run the job *inside* the GDAL image so the CLI, `libgdal`, and PROJ grids are the pinned build — not whatever `apt` installs on the runner that week. Trigger on pull requests (validate) and on pushes to `main` (validate + deploy).

```yaml
name: spatial-pipeline
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  process:
    runs-on: ubuntu-24.04
    container:
      image: osgeo/gdal:ubuntu-full-3.9.2   # pin the digest in production
    steps:
      - uses: actions/checkout@v4
      - name: Install PDAL and Python deps
        run: |
          apt-get update && apt-get install -y pdal python3-pip
          pip3 install "py3dtiles>=8.0" "laspy>=2.5" "pyproj>=3.6" "jsonschema>=4"
```

### 2. Ingest: validate the source header before processing

Never spend runner minutes processing a tile whose header is already wrong. Read the LAS header with `laspy`, confirm the point count and declared CRS, and fail fast. The full ingest checks live in the [GitHub Actions GDAL/PDAL jobs](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) guide.

```python
import sys
import laspy

las = laspy.read("tiles/tile_18_3312.laz")
declared = las.header.parse_crs()          # reads the LAS 1.4 WKT/GeoTIFF VLR
if declared is None or declared.to_epsg() != 32618:
    sys.exit(f"ingest: expected EPSG:32618, got {declared}")
if las.header.point_count == 0:
    sys.exit("ingest: empty tile")
print(f"ingest OK: {las.header.point_count} pts, EPSG:32618")
```

### 3. Process: run the deterministic PDAL + GDAL transforms

The process stage is pure function: same input tile, same versions, same output bytes. Here `pdal pipeline` filters and reprojects a cloud, then `gdalwarp` reprojects a companion terrain raster into the same EPSG. Drive both through `subprocess` so a non-zero exit fails the job.

```python
import subprocess

def process_tile(tile_id: str) -> None:
    # PDAL: filter outliers + reproject EPSG:32618 -> EPSG:4979 (geographic 3D).
    subprocess.run(
        ["pdal", "pipeline", "pipelines/filter_reproject.json",
         "--readers.las.filename", f"tiles/{tile_id}.laz",
         "--writers.las.filename", f"work/{tile_id}_clean.laz"],
        check=True)
    # GDAL: reproject the terrain tile to the same target CRS, explicit EPSG.
    subprocess.run(
        ["gdalwarp", "-t_srs", "EPSG:4979", "-r", "bilinear",
         "-overwrite", f"terrain/{tile_id}.tif", f"work/{tile_id}_4979.tif"],
        check=True)

process_tile("tile_18_3312")
```

### 4. Fan out over tiles with a matrix

A city is thousands of independent tiles. Emit the tile list in one job, then run the process step as a matrix so tiles build in parallel — each shard is isolated, so one bad tile fails only its own leg. This is the same fan-out that the [3D Tiles batch tiling pipelines](/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) guide parallelises at the encoding layer.

```yaml
  process-tiles:
    needs: list-tiles
    runs-on: ubuntu-24.04
    container: { image: osgeo/gdal:ubuntu-full-3.9.2 }
    strategy:
      fail-fast: false                      # one bad tile must not cancel the rest
      max-parallel: 8
      matrix:
        tile: ${{ fromJSON(needs.list-tiles.outputs.tiles) }}
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/process_tile.py "${{ matrix.tile }}"
      - uses: actions/upload-artifact@v4
        with: { name: "tile-${{ matrix.tile }}", path: "work/" }
```

### 5. Gate: validate and exit non-zero on any failure

The gate is the point of the whole exercise. It runs `3d-tiles-validator` and the CRS/schema assertions, and a non-zero exit is what GitHub converts into a failed required check that blocks the merge. The assertion library is developed in the [schema validation gates](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) guide.

```yaml
      - name: Validate tileset (blocks merge on failure)
        run: |
          npx 3d-tiles-validator --tilesetFile out/tileset.json
          python3 scripts/gates.py out/tileset.json  # exits non-zero on any gate
```

### 6. Promote the validated artifact to the CDN

The deploy job `needs:` the gate, runs only on `push` to `main`, downloads the *validated* artifact, and syncs it. Secrets are injected from the repository store, never hard-coded. The atomic prefix-swap and content-type handling are covered in the [automated deployment to a CDN](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) guide.

```yaml
  deploy:
    needs: [process-tiles, gate]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v4
        with: { path: dist/ }
      - name: Sync validated tileset to R2
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET }}
        run: python3 scripts/deploy.py dist/ --bucket twin-tiles --release "${{ github.sha }}"
```

## Validation & Verification

Prove the pipeline is deterministic before you trust its gate. Run the process stage twice on the same input and diff the outputs — a reproducible pipeline is byte-stable except for embedded timestamps, which you strip.

```bash
# Determinism check: two clean runs must produce identical geometry.
python3 scripts/process_tile.py tile_18_3312 && sha256sum work/tile_18_3312_clean.laz > a.sha
rm -rf work && python3 scripts/process_tile.py tile_18_3312 && sha256sum work/tile_18_3312_clean.laz > b.sha
diff <(cut -d' ' -f1 a.sha) <(cut -d' ' -f1 b.sha) && echo "deterministic OK"
```

Then confirm the gate actually blocks. Assert that `gates.py` returns non-zero on a deliberately corrupted fixture, because a gate that never fails is worse than no gate — it grants false confidence.

```python
import subprocess

# The gate MUST fail on the bad fixture and pass on the good one.
bad = subprocess.run(["python3", "scripts/gates.py", "fixtures/bad_tileset.json"])
good = subprocess.run(["python3", "scripts/gates.py", "fixtures/good_tileset.json"])
assert bad.returncode != 0, "gate did not reject the bad tileset"
assert good.returncode == 0, "gate rejected a valid tileset"
print("gate polarity verified")
```

**Expected values.** The determinism check prints `deterministic OK`; a non-deterministic result usually traces to an unpinned PROJ grid or a thread-count-dependent PDAL filter. The gate check must print `gate polarity verified`; if the bad fixture passes, the JSON Schema is too loose. In the Actions UI the `gate` job shows as a required status check, and the merge button is disabled on a red gate.

## Performance & Scale

For city- and region-scale twins the runner-minutes bill is dominated by two things: repeated dependency installation and redundant reprocessing of unchanged tiles.

**Cache the toolchain and the tiles.** Installing PDAL and pip wheels on every matrix leg wastes minutes per shard. Cache the pip wheel directory keyed on the lockfile hash, and cache a content-addressed tile store so only tiles whose source hash changed are reprocessed. On a steady twin, a typical pull request touches under 5% of tiles, so a hash-keyed cache turns a two-hour full rebuild into a few minutes.

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.cache/pip
          key: pip-${{ hashFiles('requirements.lock') }}
      - uses: actions/cache@v4
        with:
          path: tile-cache
          key: tiles-${{ hashFiles('tiles/**/*.laz') }}
```

**Right-size the matrix.** GDAL and PDAL filters are CPU-bound, so `max-parallel` should track the concurrency your Actions plan allows, not the tile count — oversubscribing just queues jobs. For very large fans, group tiles into batches of a few dozen per matrix leg so per-job container startup (10–20 s of image pull and dependency setup) does not dominate the actual processing. Push the heaviest encoding, such as parallel Draco compression, into a process pool inside each leg rather than into more matrix legs.

**Separate validate from deploy runners.** Keep the deploy job on a lightweight runner without the multi-gigabyte GDAL image; it only needs `boto3`/`aws-cli` and the downloaded artifact. This shaves image-pull time off the critical publish path and keeps deploy secrets off the heavier processing runners.

## Failure Modes & Gotchas

**The gate passes locally but the merge deploys a broken tileset.** Almost always the deploy job did not `needs:` the gate, so the two ran in parallel and the deploy raced ahead. Make `deploy` depend on `gate` explicitly, mark the gate a *required* status check in branch protection, and guard deploy with `if: github.ref == 'refs/heads/main'` so a green pull request never publishes.

**Reprojection results differ between the runner and a laptop.** The container tag floated to a newer GDAL/PROJ with an updated geoid grid, so `gdalwarp` and `pyproj` transform EPSG:32618 → EPSG:4979 to slightly different heights. Pin the image by digest, not tag, and vendor the PROJ grids you depend on so grid availability is not environment-specific.

**Secrets leak into logs or forks.** Echoing an `AWS_SECRET_ACCESS_KEY` or running the deploy job on `pull_request` from a fork exposes credentials. Reference secrets only through `env:` and `${{ secrets.* }}`, never interpolate them into a `run:` string, and gate every deploy on `github.event_name == 'push'` so fork pull requests cannot reach the credentials at all.

**A matrix leg fails and cancels the whole city rebuild.** The default `fail-fast: true` cancels sibling tiles the instant one errors, so a single corrupt tile wastes the entire run. Set `fail-fast: false` on the tile matrix so healthy tiles finish and the report pinpoints exactly which tiles failed.

**Artifacts balloon and the run is throttled.** Uploading every intermediate `.laz` and `.tif` as an artifact exhausts storage quota and slows the deploy download. Upload only the final tileset bundle for promotion, keep intermediates in the cache instead, and set a short artifact `retention-days` on debug outputs.

## Frequently Asked Questions

### Should I run GDAL and PDAL in a container or install them on the runner?

Use a container image such as `osgeo/gdal` pinned by digest. Installing GDAL and PDAL through `apt` on a bare runner picks up whatever the distro currently ships, which drifts across weeks and changes reprojection output. A pinned container gives every contributor and every release the identical `libgdal`, PROJ grid set, and PDAL build, which is the precondition for a deterministic pipeline and a trustworthy gate.

### How do validation gates actually block a merge?

The gate is an ordinary job that exits non-zero when a check fails, which GitHub records as a failed status check. In branch-protection settings you mark that job a required check, so the merge button stays disabled until it turns green. The mechanism is entirely in the exit code — your Python gate must call `sys.exit(1)` (or raise) on any violation, because a job that always exits zero is treated as passing no matter what it printed.

### Can I deploy to Cesium ion instead of my own CDN from CI?

Yes, and the choice is operational, not technical. Self-hosting on S3 or Cloudflare R2 gives you full control of caching, content-type, and atomic prefix swaps, which the CDN deploy guide covers. A managed host removes that maintenance — see [Cesium ion upload automation](/lod-management-optimization-strategies/cesium-ion-upload-automation/) and [automating ion tileset uploads with the REST API](/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/) for the managed path. Either way the same validation gate runs first; only the publish step differs.

### How do I keep CI fast on a thousand-tile city?

Combine three levers: a hash-keyed cache so only changed tiles reprocess, a matrix sized to your real concurrency rather than the tile count, and batching so container startup does not dominate short per-tile work. Together these turn a full multi-hour rebuild into an incremental run that touches only the small fraction of tiles a pull request actually changed.

### Where should the source CRS be asserted in the pipeline?

At both ends. Assert the declared input EPSG during ingest so a mislabelled tile fails before any processing, and assert the output CRS in the validation gate so a reprojection bug cannot ship. Pinning one projected EPSG (for example EPSG:32618) through the source and one delivery CRS (EPSG:4978 via EPSG:4979) through the tiler, and checking both in code, is what keeps measurements on the streamed tileset consistent with the original survey.

## Related Guides

- [GitHub Actions GDAL/PDAL Pipeline Jobs](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the containerised process stage in full
- [Schema Validation Gates for Spatial Data](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the merge-blocking checks in detail
- [Automated 3D Tiles Deployment to a CDN](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — the artifact promotion and CDN sync stage
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — the tiling step this pipeline wraps in CI
- [3D Tiles Batch Tiling Pipelines](/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — parallel encoding inside each matrix leg
- [Cesium ion Upload Automation](/lod-management-optimization-strategies/cesium-ion-upload-automation/) — the managed-hosting alternative to a self-hosted CDN

Back to [Point Cloud & Mesh Processing Pipelines](/point-cloud-mesh-processing-pipelines/).
