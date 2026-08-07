# Caching PROJ and GDAL Layers in CI

This page removes the setup cost from a spatial CI job — the conda solve, the GDAL and PROJ install, and the transformation-grid download — by pinning and caching each of them with a key that changes only when the thing itself changes. On a typical PDAL and GDAL job that is six minutes of every run, and removing it also removes a source of non-reproducibility, because a cached PROJ release is a pinned PROJ release.

## Why you hit this

A spatial CI job spends most of its wall clock before it touches any data. Resolving a conda environment containing GDAL, PROJ and PDAL takes minutes on its own, and `projsync` pulling transformation grids adds more. Teams notice the time and reach for a faster runner, which does not help because the cost is I/O and network rather than CPU. What does help is not doing the work twice, and the same change happens to pin the geodetic behaviour — which is the more valuable half.

The wider job structure is in [GitHub Actions GDAL/PDAL pipeline jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/).

## Prerequisites

- A CI system with a cache action — the examples use GitHub Actions, and the same keying logic applies to GitLab, Buildkite and CircleCI.
- A lockfile for the environment: `conda-lock`, `environment.yml` with pinned versions, or a container image.
- Somewhere to put a container image if you take that path — GHCR, ECR or Docker Hub.

## Step-by-Step

### 1. Prefer a pinned container over installing at job time

The largest single win is not installing GDAL at all.

```yaml
jobs:
  process:
    runs-on: ubuntu-latest
    container:
      # Pin by DIGEST, never by tag — a tag is mutable and silently changes the toolchain.
      image: ghcr.io/example/spatial-base@sha256:9f2c1ab4e6d0c73a1b8e5f2d4a6c8e0b2d4f6a8c0e2f4a6c8e0b2d4f6a8c0e2f
    steps:
      - uses: actions/checkout@v4
      - run: pdal --version && gdalinfo --version && projinfo --searchpaths
```

A digest is the only reference that guarantees the same bytes. A tag such as `:3.8` moves whenever the publisher rebuilds, which means a job that passed last week can fail today with no change in your repository — and, worse, can silently produce different coordinates because PROJ moved.

### 2. Cache the PROJ data directory, keyed on the release

Transformation grids are large, static, and versioned. That combination is exactly what a cache is for.

```yaml
      - name: Resolve the PROJ data release
        id: proj
        run: echo "release=$(projinfo --searchpaths >/dev/null 2>&1; \
                    python -c 'import pyproj; print(pyproj.__proj_version__)')" >> "$GITHUB_OUTPUT"

      - name: Cache PROJ grids
        uses: actions/cache@v4
        with:
          path: ~/.local/share/proj
          key: proj-data-${{ steps.proj.outputs.release }}-v2
          restore-keys: proj-data-${{ steps.proj.outputs.release }}-

      - name: Fetch any missing grids
        run: projsync --system-directory --list-files >/dev/null && projsync --all --quiet
```

Keying on the PROJ release rather than on the workflow file is the important detail. The grids belong to PROJ, not to your pipeline, so a cache keyed on the workflow invalidates whenever anyone edits an unrelated step, and one keyed on `latest` never invalidates when it should.

<figure class="diagram">
<svg viewBox="6 42 728 198" role="img" aria-labelledby="cc-key-t cc-key-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cc-key-t">A cache key should name what the cache contains</title>
  <desc id="cc-key-d">Keying the PROJ grid cache on a hash of the workflow file invalidates it whenever any unrelated step is edited. Keying it on a constant never invalidates it, so a PROJ upgrade quietly reuses the old grids. Keying it on the PROJ release invalidates exactly when the grids change.</desc>
  <rect class="svg-bg" x="6" y="42" width="728" height="198" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="250" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="102" width="250" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="148" width="250" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="185" y="78">hash(workflow.yml)</text>
    <text x="185" y="124">proj-data-latest</text>
    <text x="185" y="170">proj-data-9.3.1</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="330" y="78">invalidates on every unrelated edit</text>
    <text x="330" y="124">never invalidates — a PROJ upgrade reuses old grids</text>
    <text x="330" y="170">invalidates exactly when the grids change</text>
  </g>
  <text x="370" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">The middle row is the dangerous one: it is fast, it looks correct, and it silently pins geodesy to whatever was cached first</text>
</svg>
<figcaption>Two of the three keys produce a working cache. Only one of them invalidates when the thing it caches has actually changed.</figcaption>
</figure>

### 3. Cache the environment itself when a container is not an option

Where the job must install at run time, cache the package layer and key it on the lockfile.

```yaml
      - uses: conda-incubator/setup-miniconda@v3
        with:
          miniforge-version: latest
          use-mamba: true
          environment-file: environment.lock.yml
          activate-environment: spatial

      - name: Cache conda packages
        uses: actions/cache@v4
        with:
          path: ~/conda_pkgs_dir
          key: conda-${{ runner.os }}-${{ hashFiles('environment.lock.yml') }}
          restore-keys: conda-${{ runner.os }}-
```

`hashFiles` on the *lockfile* is what makes this correct. Hashing `environment.yml` with loose version specifiers produces a stable key across a solve that resolved differently, so the cache returns packages that do not match the environment the job then builds.

### 4. Cache the source data too, when it is stable

Test fixtures and reference tiles change far less often than code.

```yaml
      - name: Cache test fixtures
        uses: actions/cache@v4
        with:
          path: fixtures/
          key: fixtures-${{ hashFiles('fixtures/manifest.sha256') }}

      - name: Fetch anything missing
        run: |
          test -f fixtures/tile_utm33n.laz || \
            aws s3 cp s3://twin-fixtures/tile_utm33n.laz fixtures/
          sha256sum -c fixtures/manifest.sha256
```

The checksum verification after restore is not optional. A partially restored cache is indistinguishable from a complete one to the job, and a truncated LAZ produces a confusing failure several steps later rather than at the point it was restored.

### 5. Measure what each cache actually saved

Otherwise a cache that stopped working goes unnoticed, because a slow job looks like a busy runner.

```yaml
      - name: Record step timings
        if: always()
        run: |
          echo "::notice title=timings::proj=${PROJ_S}s conda=${CONDA_S}s process=${PROC_S}s"
```

```python
import json
import subprocess

runs = json.loads(subprocess.run(
    ["gh", "run", "list", "--workflow", "process.yml", "--limit", "30",
     "--json", "conclusion,createdAt,updatedAt"],
    capture_output=True, text=True).stdout)

import datetime as dt
durations = []
for r in runs:
    if r["conclusion"] != "success":
        continue
    a = dt.datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
    b = dt.datetime.fromisoformat(r["updatedAt"].replace("Z", "+00:00"))
    durations.append((b - a).total_seconds())

durations.sort()
print(f"median {durations[len(durations)//2]:.0f}s | "
      f"p90 {durations[int(len(durations)*0.9)]:.0f}s | n={len(durations)}")
```

A median that creeps upward over weeks is a cache that stopped hitting — most often because a key started including something volatile, or because the cache exceeded the size limit and is being evicted between runs.

<figure class="diagram">
<svg viewBox="35 20 670 224" role="img" aria-labelledby="cc-time-t cc-time-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cc-time-t">Where the nine minutes went, and what each change removed</title>
  <desc id="cc-time-d">A cold run spends four minutes ten on the conda solve and install, two minutes on grid download and three and a half on processing. Pinning a container removes the first, caching PROJ data removes the second, and the run becomes almost entirely the work it exists to do.</desc>
  <rect class="svg-bg" x="35" y="20" width="670" height="224" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="230" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="290" y="56" width="110" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="400" y="56" width="192" height="28" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="110" width="22" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="82" y="110" width="110" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="192" y="110" width="192" height="28" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="164" width="22" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="82" y="164" width="14" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="96" y="164" width="192" height="28" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="602" y="75">cold — 9m 40s</text>
    <text x="394" y="129">pinned container — 5m 30s</text>
    <text x="298" y="183">plus cached PROJ data — 4m 10s</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="175" y="46">install</text>
    <text x="345" y="46">grids</text>
    <text x="496" y="46">processing</text>
  </g>
  <text x="370" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">The processing bar never moves — everything removed was setup, and removing it also pinned the toolchain</text>
</svg>
<figcaption>Two changes take the job from mostly setup to almost entirely work, and the same two changes make the run reproducible.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="10 42 668 214" role="img" aria-labelledby="cc-layer-t cc-layer-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cc-layer-t">Four things to cache, and what each should be keyed on</title>
  <desc id="cc-layer-d">The container image is pinned by digest rather than cached. PROJ grids are keyed on the PROJ release. Conda packages are keyed on a hash of the lockfile. Test fixtures are keyed on a checksum manifest. Each key names the thing the cache contains rather than the workflow that uses it.</desc>
  <rect class="svg-bg" x="10" y="42" width="668" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="56" width="200" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="98" width="200" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="140" width="200" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="182" width="200" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="124" y="78">container image</text>
    <text x="124" y="120">PROJ grids</text>
    <text x="124" y="162">conda packages</text>
    <text x="124" y="204">test fixtures</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="246" y="78">pinned by sha256 digest — not cached, fixed</text>
    <text x="246" y="120">keyed on the PROJ release, e.g. 9.3.1</text>
    <text x="246" y="162">keyed on hashFiles(environment.lock.yml)</text>
    <text x="246" y="204">keyed on hashFiles(manifest.sha256)</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Every key names its own contents, so each cache invalidates exactly when what it holds has changed</text>
</svg>
<figcaption>Four caches, four different keys. The common mistake is one key for all of them, which makes every cache as volatile as the most volatile input.</figcaption>
</figure>

## Expected Output & Verification

A representative before and after on a matrix of twenty shards:

```text
median 578s | p90 641s | n=30       # before
median 249s | p90 288s | n=30       # after
proj=3s conda=0s process=211s
```

Two checks confirm the caches are real rather than apparently real. The PROJ step should report seconds rather than minutes on a hit, and `projinfo --searchpaths` should list the cached directory first. And the pipeline's own numeric output — a transformed control point, a point count — must be identical to the pre-caching run, because a cache that changed the geodetic behaviour has broken something far more important than the runtime.

```bash
projinfo --searchpaths
python - <<'PY'
from pyproj import Transformer
t = Transformer.from_crs("EPSG:4326+5773", "EPSG:32618+5703", always_xy=True)
print(t.description)
print([round(v, 6) for v in t.transform(-73.985428, 40.748817, 12.30)])
PY
```

## Common Errors

**The cache never hits.** The key includes something that changes every run — a timestamp, a run number, or `hashFiles` over a directory the job writes into. Print the resolved key and compare it across two runs.

**Cache hits and the job still installs everything.** The cached path is not the one the tool actually uses. `conda` respects `CONDA_PKGS_DIRS`, and PROJ looks at `PROJ_DATA` and its compiled-in search path — check with `projinfo --searchpaths` rather than assuming.

**Results changed after adding caching.** A different PROJ data release was restored than the one the previous runs used. This is the failure worth taking seriously: pin the release explicitly and re-verify a control point.

**Cache uploads fail on large directories.** Most CI caches have a size ceiling in the low gigabytes. Cache only the grids you use — `projsync --area-of-use` fetches a bounding box rather than the world.

## Frequently Asked Questions

### Container or cached environment?
Container, where you can. It pins the whole toolchain in one digest, it starts in seconds, and it is the same artifact developers can run locally. Cached environments are the fallback when the CI system cannot run containers.

### Should the PROJ data cache be shared between repositories?
If the CI system allows it, yes — the grids are identical and large. Where caches are per-repository, publishing a container that already contains them is the equivalent.

### Does this affect reproducibility?
It improves it, provided the keys are right. A pinned container digest plus a PROJ release in the cache key means the geodetic behaviour is fixed, which is one of the inputs an [incremental rebuild's content hash](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) depends on.

One caveat about restore-keys. A prefix fallback is useful for the conda cache, where a partially matching package set still saves most of the download. It is actively harmful for the PROJ cache, because a fallback restores grids from a *different* PROJ release, which is precisely the silent change of geodetic behaviour the exact key was there to prevent. Use `restore-keys` where a partial hit is a saving and omit it where a partial hit is a correctness risk.

The second caveat is about verifying a restore rather than trusting it. Cache actions report a hit when they found and extracted an archive, not when the contents are complete — a truncated upload from a previous run restores cleanly and is missing files. A checksum pass over the restored directory costs a second and converts a confusing mid-job failure into an explicit one at the point of restore.

Finally, treat the cache as an optimisation and never as a dependency. A job that cannot run with every cache cold is not cached, it is broken in a way that happens not to show — and it will show on the first run in a new fork, a new runner pool, or after a cache eviction.

## Related Guides

- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — the pipeline this speeds up
- [GitHub Actions GDAL/PDAL Pipeline Jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the job structure being cached
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the check that catches a changed PROJ release

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
