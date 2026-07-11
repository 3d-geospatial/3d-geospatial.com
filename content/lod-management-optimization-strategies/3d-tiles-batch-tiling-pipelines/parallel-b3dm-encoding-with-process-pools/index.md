# Parallel b3dm Encoding with a ProcessPoolExecutor

This guide parallelises the glTF→`b3dm`+Draco encode across CPU cores using Python's `concurrent.futures.ProcessPoolExecutor`, driving the Node-based `3d-tiles-tools` CLI through `subprocess` while chunking leaf jobs to amortise process startup, sizing workers to physical cores because Draco compression is CPU-bound, collecting per-job failures instead of crashing the batch, and enforcing a deterministic ordering so a CI rerun produces byte-identical tiles.

You hit this the moment a [batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) grows past a few hundred shards: the encode is embarrassingly parallel — each tile is independent — but a naive `for` loop pins one core while the other fifteen idle, and every `3d-tiles-tools` call pays a fresh Node startup. The fix is a bounded process pool over deterministically chunked jobs.

<figure class="diagram">
<svg viewBox="0 0 820 300" role="img" aria-labelledby="ppool-t ppool-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ppool-t">Chunked leaf jobs distributed across per-core worker processes</title>
  <desc id="ppool-d">A sorted list of leaf jobs is split by a chunker into one contiguous chunk per physical core, each chunk is encoded by a worker process running the subprocess batch, and the futures are collected into byte-stable outputs plus a separate failure list.</desc>
  <defs>
    <marker id="ppool-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#ppool-arrow)">
    <line x1="152" y1="150" x2="183" y2="150"/>
    <line x1="307" y1="150" x2="343" y2="77"/>
    <line x1="307" y1="150" x2="343" y2="150"/>
    <line x1="307" y1="150" x2="343" y2="223"/>
    <line x1="507" y1="77" x2="543" y2="145"/>
    <line x1="507" y1="150" x2="543" y2="150"/>
    <line x1="507" y1="223" x2="543" y2="155"/>
    <line x1="657" y1="145" x2="688" y2="105"/>
    <line x1="657" y1="155" x2="688" y2="195"/>
  </g>
  <rect x="20" y="115" width="132" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="86" y="145" fill="#15384a" font-size="12.5" text-anchor="middle">Sorted leaf</text>
  <text x="86" y="163" fill="#15384a" font-size="12.5" text-anchor="middle">jobs (stable)</text>
  <rect x="185" y="115" width="122" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="246" y="145" fill="#1f2937" font-size="12.5" text-anchor="middle">Chunker</text>
  <text x="246" y="163" fill="#1f2937" font-size="12.5" text-anchor="middle">one/core</text>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="345" y="47" width="162" height="60" rx="8"/>
    <rect x="345" y="120" width="162" height="60" rx="8"/>
    <rect x="345" y="193" width="162" height="60" rx="8"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="426" y="72">Worker · core 0</text>
    <text x="426" y="90">subprocess batch</text>
    <text x="426" y="145">Worker · core 1</text>
    <text x="426" y="163">subprocess batch</text>
    <text x="426" y="218">Worker · core N-1</text>
    <text x="426" y="236">subprocess batch</text>
  </g>
  <rect x="545" y="120" width="110" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="600" y="146" fill="#15384a" font-size="12.5" text-anchor="middle">Collect</text>
  <text x="600" y="164" fill="#15384a" font-size="12.5" text-anchor="middle">futures</text>
  <rect x="690" y="72" width="112" height="58" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="746" y="97" fill="#1f2937" font-size="12.5" text-anchor="middle">Byte-stable</text>
  <text x="746" y="115" fill="#1f2937" font-size="12.5" text-anchor="middle">outputs</text>
  <rect x="690" y="170" width="112" height="58" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="746" y="195" fill="#1f2937" font-size="12.5" text-anchor="middle">Failure</text>
  <text x="746" y="213" fill="#1f2937" font-size="12.5" text-anchor="middle">list</text>
</svg>
<figcaption>Sorted jobs are split into one contiguous chunk per physical core; each worker runs the subprocess encode, and the collected futures separate byte-stable outputs from a failure list.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ (`concurrent.futures` and `os.cpu_count` are standard library).
- `3d-tiles-tools` 0.4+ on `PATH` (Node 18+), and `trimesh` 4.4+ for the merge step.
- A directory of per-tile `.glb` files already merged and placed in the local ENU frame, produced by the [batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/). Geometry is authored around a survey anchor whose ENU→ECEF transform (source EPSG:32618+5703 → EPSG:4979 → EPSG:4978) lives on the tileset root, so the encode itself is CRS-agnostic — it only rewrites container bytes.
- Physical vs logical core count. `os.cpu_count()` reports logical CPUs (hyperthreads); Draco saturates ALU throughput, so hyperthreads add little. Prefer physical cores where you can detect them.

## Step-by-Step

### 1. Enumerate leaf jobs in a deterministic order

Sort the inputs once. A `ProcessPoolExecutor` may *complete* jobs out of order, but the *submission* order and each job's output path must be fixed so two CI runs over the same inputs write the same files.

```python
from pathlib import Path

SRC_DIR = Path("shards")          # one merged .glb per leaf tile
OUT_DIR = Path("tiles")
OUT_DIR.mkdir(parents=True, exist_ok=True)

jobs = [(glb, OUT_DIR / (glb.stem + ".b3dm"))
        for glb in sorted(SRC_DIR.glob("*.glb"))]   # sorted -> stable order
print(f"{len(jobs)} leaf encode jobs")
```

### 2. Size the pool to physical cores

Draco quantization and connectivity encoding are CPU-bound, so oversubscribing logical cores past the physical count only adds context-switch overhead. Use physical cores when detectable, and cap workers at the job count for small batches.

```python
import os

def physical_workers() -> int:
    """Best-effort physical-core count; fall back to logical, then 1."""
    try:
        return len(os.sched_getaffinity(0))          # respects cgroup/CI limits
    except AttributeError:
        pass
    logical = os.cpu_count() or 1
    return max(1, logical // 2)                       # assume 2 threads/core

workers = min(physical_workers(), len(jobs)) or 1
print(f"encoding with {workers} worker processes")
```

### 3. Chunk jobs to amortise Node startup

Each `3d-tiles-tools` invocation starts a Node runtime (tens to hundreds of milliseconds). For thousands of tiny leaves that startup dwarfs the encode. Split the sorted job list into one contiguous chunk per worker so a worker starts Node a handful of times, not once per tile.

```python
def chunked(seq, n_chunks):
    """Split seq into n_chunks contiguous, near-equal chunks (order preserved)."""
    k, m = divmod(len(seq), n_chunks)
    out, start = [], 0
    for i in range(n_chunks):
        size = k + (1 if i < m else 0)
        out.append(seq[start:start + size])
        start += size
    return [c for c in out if c]                      # drop empty tail chunks

chunks = chunked(jobs, workers)
print(f"{len(chunks)} chunks, sizes {[len(c) for c in chunks]}")
```

### 4. Define the worker: encode a whole chunk, collect failures

The worker runs in a separate process, so it must be a top-level function (picklable) and must not raise on a single bad tile — it returns a result list the parent aggregates. Encode to a temp path and atomically rename so an interrupted run never leaves a half-written `b3dm`.

```python
import os
import subprocess

def encode_chunk(chunk):
    """Encode a list of (glb, out) jobs. Returns (ok_paths, failures)."""
    ok, failures = [], []
    for glb, out in chunk:
        tmp = out.with_suffix(".b3dm.tmp")
        try:
            subprocess.run(["3d-tiles-tools", "glbToB3dm",
                            "-i", str(glb), "-o", str(tmp), "-f"],
                           check=True, capture_output=True, text=True)
            subprocess.run(["3d-tiles-tools", "optimizeB3dm", "-i", str(tmp),
                            "-o", str(tmp), "-f",
                            "--options", "--draco.compressMeshes"],
                           check=True, capture_output=True, text=True)
            os.replace(tmp, out)                      # atomic on POSIX
            ok.append(str(out))
        except subprocess.CalledProcessError as exc:
            failures.append((str(glb), exc.stderr.strip().splitlines()[-1]
                             if exc.stderr else f"exit {exc.returncode}"))
            tmp.unlink(missing_ok=True)
    return ok, failures
```

### 5. Run the pool and aggregate results deterministically

Submit one future per chunk, then merge results in a fixed order (sorted by output path) so the aggregated report and any manifest written from it are identical across runs regardless of which worker finished first.

```python
from concurrent.futures import ProcessPoolExecutor

encoded, failed = [], []
with ProcessPoolExecutor(max_workers=workers) as pool:
    for ok, failures in pool.map(encode_chunk, chunks):   # map preserves input order
        encoded.extend(ok)
        failed.extend(failures)

encoded.sort()                                            # deterministic report
failed.sort()
print(f"encoded {len(encoded)}/{len(jobs)} tiles, {len(failed)} failed")
for glb, msg in failed:
    print(f"  FAIL {glb}: {msg}")

if failed:
    raise SystemExit(1)                                   # fail the CI job
```

### 6. Verify byte-stability across reruns

The determinism contract is what lets the parent [batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) trust its hash cache. Re-encode one tile in isolation and compare bytes to the pooled output.

```python
import hashlib

def digest(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

sample_glb, sample_out = jobs[0]
before = digest(sample_out)
encode_chunk([(sample_glb, OUT_DIR / "_recheck.b3dm")])
after = digest(OUT_DIR / "_recheck.b3dm")
assert before == after, "encode is non-deterministic — CI reruns will churn"
print("byte-stable:", before[:12])
```

## Expected Output & Verification

On a 16-logical-core (8 physical) machine encoding 480 leaf tiles, the pool reports physical sizing, a handful of chunks, and a byte-stable sample:

```text
480 leaf encode jobs
encoding with 8 worker processes
8 chunks, sizes [60, 60, 60, 60, 60, 60, 60, 60]
encoded 480/480 tiles, 0 failed
byte-stable: 3f9a1c7e0b52
```

Wall-clock scales close to linearly with physical cores until the Node startup floor and disk I/O dominate. Confirm the speedup and the core sizing from the shell:

```bash
nproc --all                                   # logical cores visible to the process
python -c "import os; print(len(os.sched_getaffinity(0)))"   # honored affinity
time python encode_pool.py                    # compare against a serial baseline
```

Expect roughly a 6–7x speedup on 8 physical cores (not the full 8x — Node startup and the final `os.replace` are serial per tile), and identical `sha256` sums for every `b3dm` across two runs.

## Common Errors

**`BrokenProcessPool: A process in the process pool was terminated abruptly`.** A worker was killed by the OS out-of-memory reaper because too many Node encoders ran at once on large meshes, or a worker segfaulted. `ProcessPoolExecutor` cannot recover and the whole pool dies. Fix: size workers to physical cores (step 2), cap peak resident meshes by chunking rather than submitting one future per tile, and set your CI runner's memory limit above `workers × peak-Node-RSS`.

**`AttributeError: Can't pickle local object` when submitting jobs.** The worker function or an object it closes over was defined inside another function, so `ProcessPoolExecutor` cannot pickle it to send to the child process. Fix: define `encode_chunk` at module top level and pass only picklable arguments (strings and `Path` objects), never open file handles or lambdas.

**`FileNotFoundError: [Errno 2] No such file or directory: '3d-tiles-tools'`.** The child process inherited a `PATH` that does not include the Node bin directory — common when the pool is spawned (macOS/Windows default) rather than forked, or inside a minimal CI container. Fix: install `3d-tiles-tools` globally on `PATH`, or pass an absolute path to the executable in the `subprocess.run` argument list so every worker resolves it identically.

## Related Guides

- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — the sharding, hash-cache, and assembly layer this encode step plugs into
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — the single-tileset encode and geometricError model each job produces
- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — running the parallel encode as a cached, reproducible CI job

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
