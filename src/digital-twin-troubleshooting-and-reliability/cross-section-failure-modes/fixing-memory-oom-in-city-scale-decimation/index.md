---
title: "Fixing Memory OOM in City-Scale Decimation"
description: "Prevent out-of-memory in city-scale mesh decimation and point processing: tile-by-tile streaming, chunked laspy reads, bounded ProcessPoolExecutor workers, and RSS measured with psutil."
---
# Fixing Out-of-Memory Failures in City-Scale Mesh Decimation

This guide prevents the `MemoryError` and OOM-killer terminations that strike when [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) and point-cloud processing scale from a few buildings to a whole city, using tile-by-tile streaming instead of whole-survey loads, chunked `laspy` reads, a bounded `ProcessPoolExecutor`, explicit freeing of intermediates, and resident-set measurement with `psutil`. It sits in the [cross-section failure modes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/) area because the failure spans the boundary between the [processing pipeline](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) and the [LOD tiler](https://www.3d-geospatial.com/lod-management-optimization-strategies/) that consumes its output.

You hit this the first time a pipeline that ran fine on a test block is pointed at a full survey: a job that decimated ten buildings in seconds tries to load a 40 GB `.laz` or a directory of thousands of meshes at once, resident memory climbs past the machine's RAM, and the process is killed with no traceback or a bare `MemoryError`. The fix is architectural — never hold the whole survey — and it is the same discipline whether the payload is points or triangles.

<figure class="diagram">
<svg viewBox="11 26 758 220" role="img" aria-labelledby="oom-t oom-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oom-t">Whole-survey load versus streamed tile-by-tile processing</title>
  <desc id="oom-d">The top path loads the entire survey into memory at once and crosses the RAM budget, triggering the out-of-memory killer. The bottom path streams one chunk or tile at a time through a bounded pool of workers, holding resident memory flat below the budget line regardless of survey size.</desc>
  <rect class="svg-bg" x="11" y="26" width="758" height="220" fill="#ffffff"/>
  <defs>
    <marker id="oom-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="25" y="40" width="150" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="315" y="40" width="180" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="600" y="40" width="155" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <line x1="175" y1="70" x2="313" y2="70" stroke="#5b6471" stroke-width="2" marker-end="url(#oom-arrow)"/>
  <line x1="495" y1="70" x2="598" y2="70" stroke="#5b6471" stroke-width="2" marker-end="url(#oom-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="66"><tspan x="100" dy="0" font-weight="600">Whole survey</tspan><tspan x="100" dy="16" font-size="11">40 GB .laz</tspan></text>
    <text x="405" y="66"><tspan x="405" dy="0">load all points</tspan><tspan x="405" dy="16" font-size="11">RSS &gt; RAM budget</tspan></text>
    <text x="677" y="74" font-weight="600">OOM kill (137)</text>
  </g>
  <rect x="25" y="140" width="150" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="315" y="140" width="180" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="600" y="140" width="155" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="175" y1="170" x2="313" y2="170" stroke="#5b6471" stroke-width="2" marker-end="url(#oom-arrow)"/>
  <line x1="495" y1="170" x2="598" y2="170" stroke="#5b6471" stroke-width="2" marker-end="url(#oom-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="166"><tspan x="100" dy="0" font-weight="600">chunk_iterator</tspan><tspan x="100" dy="16" font-size="11">one chunk / tile</tspan></text>
    <text x="405" y="166"><tspan x="405" dy="0">bounded pool</tspan><tspan x="405" dy="16" font-size="11">del + gc.collect</tspan></text>
    <text x="677" y="166"><tspan x="677" dy="0" font-weight="600">flat RSS</tspan><tspan x="677" dy="16" font-size="11">under budget</tspan></text>
  </g>
  <text x="390" y="228" fill="#5b6471" font-size="12" text-anchor="middle">Peak memory tracks one chunk times worker count — not the survey size</text>
</svg>
<figcaption>Loading the whole survey crosses the RAM budget and invites the OOM killer; streaming one chunk or tile through a memory-bounded pool holds resident set flat no matter how large the survey grows.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `laspy` 2.5+ (with the `lazrs` or `laszip` backend for `.laz`), `numpy` 1.26+, `trimesh` 4.4+, and `psutil` 5.9+: `pip install "laspy[lazrs]>=2.5" "numpy>=1.26" "trimesh>=4.4" "psutil>=5.9"`.
- Source data as classified `.laz`/`.las` point clouds or per-tile `.glb`/`.ply` meshes in a projected metric CRS — the examples use EPSG:32618 (UTM 18N) so that chunk extents and point counts are in metres and are directly comparable across tiles.
- A machine whose RAM you know: the whole point of the exercise is to keep peak resident-set size (RSS) below that ceiling with headroom for the OS, so measure it (`psutil.virtual_memory().total`) rather than assuming.

## Step-by-Step

### 1. Measure peak RSS so "out of memory" becomes a number

Before changing anything, instrument the job. Without a measured RSS you are guessing, and the fix cannot be verified. `psutil` reads the process's resident set; sample it around the heavy call.

```python
import os, psutil

proc = psutil.Process(os.getpid())

def rss_mb():
    return proc.memory_info().rss / 1024**2

budget_mb = psutil.virtual_memory().total / 1024**2 * 0.6   # leave 40% headroom
print(f"RSS at start {rss_mb():.0f} MB, soft budget {budget_mb:.0f} MB")
```

Keep the soft budget well below total RAM — decimation allocates temporary index and normal arrays several times the size of the geometry, so 60% of physical memory is a safe working ceiling.

### 2. Stream a large point cloud in fixed-size chunks

The core fix for point data: never call `laspy.read`, which materialises every point. Open the file and iterate fixed-size chunks so resident memory is bounded by the chunk, not the survey.

```python
import laspy
import numpy as np

CHUNK = 5_000_000   # points per chunk; ~120 MB for XYZ float64 + attributes

def stream_ground_points(path):
    """Yield decimated ground points chunk by chunk, holding one chunk at a time."""
    with laspy.open(path) as reader:          # header only — no points loaded yet
        assert reader.header.parse_crs().to_epsg() == 32618, "expected EPSG:32618"
        for chunk in reader.chunk_iterator(CHUNK):
            xyz = np.vstack((chunk.x, chunk.y, chunk.z)).T      # this chunk only
            ground = xyz[chunk.classification == 2]             # ASPRS ground class
            keep = ground[::4]                                  # 4x voxel-free thin
            yield keep
            del xyz, ground                                    # free before next chunk
```

Each `yield` hands downstream a small array; the `del` drops the chunk's working buffers so the next iteration starts from the header cursor, not a growing accumulation.

<figure class="diagram">
<svg viewBox="9 6 706 288" role="img" aria-labelledby="oom-rss-t oom-rss-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oom-rss-t">Resident memory over the life of a job</title>
  <desc id="oom-rss-d">Loading the whole survey produces a resident set that climbs monotonically until it crosses the machine limit and the process is killed. Streaming one chunk at a time produces a sawtooth that peaks at one chunk plus the worker count, and never approaches the limit however large the survey grows.</desc>
  <rect class="svg-bg" x="9" y="6" width="706" height="288" fill="#ffffff"/>
  <path d="M70 60 V216 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M70 92 H700" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="700" y="84" fill="#b0413e" font-size="12" text-anchor="end">RAM limit</text>
  <polyline points="80,212 150,196 220,176 290,152 360,126 420,100 452,92" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <circle cx="452" cy="92" r="6" fill="#b0413e"/>
  <text x="466" y="88" fill="#b0413e" font-size="12" text-anchor="start">killed — exit 137</text>
  <polyline points="80,206 110,184 112,204 145,182 147,203 180,181 182,204 215,182 217,203 250,181 252,204 285,182 287,203 320,181 322,204 355,182 357,203 390,181 392,204 425,182 427,203 460,181 462,204 495,182 497,203 530,181 532,204 565,182 567,203 600,181 602,204 635,182 637,203 670,182"
            fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <text x="600" y="170" fill="#4f7a4d" font-size="12" text-anchor="middle">one chunk × workers, flat forever</text>
  <text x="385" y="244" fill="#5b6471" font-size="12" text-anchor="middle">elapsed time</text>
  <text x="34" y="130" fill="#5b6471" font-size="12" text-anchor="middle">RSS</text>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">The two shapes are diagnostic on their own — a climbing line is never a tuning problem</text>
  <text x="380" y="276" fill="#15384a" font-size="12" text-anchor="middle">Log RSS every few seconds and the distinction costs nothing; without it, both failures read as &quot;the job died&quot;</text>
</svg>
<figcaption>A monotonic climb means something is being accumulated that should not be. A sawtooth that is simply too tall means the chunk is too large. The remedies are unrelated.</figcaption>
</figure>

### 3. Decimate one tile at a time, freeing intermediates

For meshes, the same rule applies per file. Load one tile, decimate, export, and explicitly drop every intermediate before the next tile — do not build a list of loaded meshes.

```python
import gc, trimesh
from pathlib import Path

def decimate_tile(glb_path: Path, out_dir: Path, ratio=0.125):
    mesh = trimesh.load(glb_path, force="mesh", process=False)
    target = max(500, int(len(mesh.faces) * ratio))
    simplified = mesh.simplify_quadric_decimation(target)
    out = out_dir / (glb_path.stem + "_lod1.glb")
    simplified.export(out)
    faces_in, faces_out = len(mesh.faces), len(simplified.faces)
    del mesh, simplified          # drop both meshes' vertex/face/index buffers
    gc.collect()                  # reclaim before the next tile is loaded
    return out, faces_in, faces_out
```

Calling `gc.collect()` after `del` forces trimesh's numpy-backed buffers to be reclaimed immediately rather than at the next allocation pressure, which is what keeps RSS flat across thousands of tiles.

<figure class="diagram">
<svg viewBox="46 56 636 232" role="img" aria-labelledby="oom-copy-t oom-copy-d" xmlns="http://www.w3.org/2000/svg">
  <title id="oom-copy-t">Where the copies come from in one decimation step</title>
  <desc id="oom-copy-d">A single decimation of a two gigabyte mesh holds the source arrays, the library's internal copy, the output arrays and, until the reference is released, the previous iteration's result. Four live copies of nearly the same data is the normal peak, not a leak.</desc>
  <rect class="svg-bg" x="46" y="56" width="636" height="232" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="70" width="140" height="120" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="216" y="70" width="140" height="120" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="372" y="70" width="140" height="120" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="528" y="70" width="140" height="120" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="118"><tspan x="130" dy="0" font-weight="600">source arrays</tspan><tspan x="130" dy="18">2.0 GB</tspan></text>
    <text x="286" y="118"><tspan x="286" dy="0" font-weight="600">library copy</tspan><tspan x="286" dy="18">2.0 GB</tspan></text>
    <text x="442" y="118"><tspan x="442" dy="0" font-weight="600">output arrays</tspan><tspan x="442" dy="18">0.6 GB</tspan></text>
    <text x="598" y="110"><tspan x="598" dy="0" font-weight="600">previous result</tspan><tspan x="598" dy="18">still referenced</tspan><tspan x="598" dy="17">0.6 GB</tspan></text>
  </g>
  <text x="370" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Peak is 5.2 GB for a 2.0 GB mesh — and the only one you can delete is the fourth</text>
  <text x="370" y="248" fill="#5b6471" font-size="12" text-anchor="middle">del the previous result before the next call, not after it, or both live at once for the duration</text>
  <text x="370" y="270" fill="#5b6471" font-size="12" text-anchor="middle">Budget from the peak, never from the file size</text>
</svg>
<figcaption>Sizing a job from the input file is the most common way to under-provision it by a factor of two or three. The peak is what has to fit.</figcaption>
</figure>

Both figures point at the same discipline: measure rather than estimate. Peak resident set is one call to `resource.getrusage` at the end of a run, or a background thread sampling `psutil.Process().memory_info().rss` every few seconds if you want the shape as well as the maximum. Logging that number alongside the chunk size and worker count turns capacity planning into interpolation, and turns "it OOMs on the big city" into a ratio you can act on.

### 4. Parallelise with a bounded process pool

Decimation is CPU-bound and embarrassingly parallel per tile, but an unbounded pool multiplies peak memory by the worker count and re-triggers the OOM you just fixed. Size the pool to fit within the budget: each worker holds roughly one tile's footprint, so `workers ≤ budget / per_tile_peak`.

```python
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
import os

PER_TILE_PEAK_MB = 700          # measured peak RSS of one decimate_tile call
max_workers = max(1, min(os.cpu_count(), int(budget_mb // PER_TILE_PEAK_MB)))

def run(tiles, out_dir):
    out_dir = Path(out_dir); out_dir.mkdir(exist_ok=True)
    results = []
    with ProcessPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(decimate_tile, t, out_dir): t for t in tiles}
        for fut in as_completed(futures):        # collect as they finish, not all at once
            results.append(fut.result())
    return results

print(f"using {max_workers} workers within {budget_mb:.0f} MB budget")
```

Submitting all futures up front is fine — they queue — but bounding `max_workers` by the memory budget, not just the core count, is what prevents the pool from over-committing RAM.

### 5. Aggregate streamed results without reloading

When a downstream step needs all the thinned points (for example to build one tileset extent), accumulate running statistics or write to a memory-mapped array, never a growing Python list of full chunks.

```python
import numpy as np

def survey_bounds(paths):
    """Fold streamed chunks into a bounds accumulator — O(1) memory in survey size."""
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    total = 0
    for path in paths:
        for keep in stream_ground_points(path):
            lo = np.minimum(lo, keep.min(axis=0))
            hi = np.maximum(hi, keep.max(axis=0))
            total += len(keep)
    return lo, hi, total

lo, hi, total = survey_bounds([Path("survey") / f for f in ("n.laz", "s.laz")])
print(f"kept {total:,} points, extent {(hi - lo)[:2]} m (EPSG:32618)")
```

## Expected Output & Verification

A correctly streamed run holds RSS roughly flat regardless of survey size — resident memory tracks one chunk or one tile plus the worker multiple, not the total data volume.

```text
RSS at start 92 MB, soft budget 19660 MB
using 12 workers within 19660 MB budget
tile block_0003.glb: 214880 -> 26860 faces
tile block_0004.glb: 198122 -> 24765 faces
kept 41,203,588 points, extent [1188.4 1421.7] m (EPSG:32618)
peak RSS 8140 MB (budget 19660 MB) — OK
```

Verify the fix by asserting peak RSS stayed under budget across the whole run, and by confirming peak is independent of survey size — process a survey twice as large and peak RSS should barely move.

```python
peak = rss_mb()
assert peak < budget_mb, f"peak RSS {peak:.0f} MB exceeded budget {budget_mb:.0f} MB"
print(f"peak RSS {peak:.0f} MB (budget {budget_mb:.0f} MB) — OK")
```

If peak scales with survey size, an intermediate is still being accumulated — a list of chunks, an un-`del`-eted mesh, or an unbounded pool — and the offending step is the one whose output grows.

Log the peak resident set alongside the chunk size and worker count on every run. Capacity planning then becomes interpolation from your own numbers rather than a guess, and a regression in memory behaviour shows up as a trend instead of as an outage.

## Common Errors

**`MemoryError` or a silent kill with exit code 137.** Exit 137 is the Linux OOM killer (128 + SIGKILL), which leaves no Python traceback, so the job just vanishes from the scheduler. It means resident memory crossed the physical ceiling, almost always because `laspy.read` or `trimesh.load` was called on the whole survey. Switch to `laspy.open(...).chunk_iterator` and per-tile loading as in steps 2 and 3, and cap the pool by memory in step 4.

**`laspy` raises `LaspyException: laszip is not available` on `.laz`.** The compressed reader backend is missing, so `chunk_iterator` cannot decode the file. Install a backend with `pip install "laspy[lazrs]"` (pure-Rust, no system dependency) or `laspy[laszip]`, and confirm with `laspy.LazBackend.detect_available()` before the run. Reading `.las` uncompressed masks this but multiplies disk and memory cost.

**Peak RSS climbs slowly across thousands of tiles despite per-tile loading.** numpy-backed buffers from trimesh are not always reclaimed at the moment the Python reference drops, so memory creeps until an allocation forces collection. Add an explicit `del` of every mesh and intermediate followed by `gc.collect()` at the end of each tile (step 3); without the forced collection, the drift eventually crosses the budget on a long enough run.

## Related Guides

- [Cross-Section Failure Modes in Digital Twins](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/) — the boundary defects this OOM failure belongs to
- [Diagnosing CRS Drift Causing LOD Seams](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-crs-drift-causing-lod-seams/) — the other common city-scale reliability failure
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the decimation stage whose memory this bounds
- [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) — the broader processing context for streamed reads

Back to [Cross-Section Failure Modes in Digital Twins](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).
