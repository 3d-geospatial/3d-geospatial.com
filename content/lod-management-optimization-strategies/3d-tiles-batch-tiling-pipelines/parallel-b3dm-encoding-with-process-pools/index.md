# Parallel b3dm Encoding with a ProcessPoolExecutor

This guide parallelises the glTF→`b3dm`+Draco encode across CPU cores using Python's `concurrent.futures.ProcessPoolExecutor`, driving the Node-based `3d-tiles-tools` CLI through `subprocess` while chunking leaf jobs to amortise process startup, sizing workers to physical cores because Draco compression is CPU-bound, collecting per-job failures instead of crashing the batch, and enforcing a deterministic ordering so a CI rerun produces byte-identical tiles.

You hit this the moment a [batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) grows past a few hundred shards: the encode is embarrassingly parallel — each tile is independent — but a naive `for` loop pins one core while the other fifteen idle, and every `3d-tiles-tools` call pays a fresh Node startup. The fix is a bounded process pool over deterministically chunked jobs.

<figure class="diagram">
<svg viewBox="6 33 810 234" role="img" aria-labelledby="ppool-t ppool-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ppool-t">Chunked leaf jobs distributed across per-core worker processes</title>
  <desc id="ppool-d">A sorted list of leaf jobs is split by a chunker into one contiguous chunk per physical core, each chunk is encoded by a worker process running the subprocess batch, and the futures are collected into byte-stable outputs plus a separate failure list.</desc>
  <rect class="svg-bg" x="6" y="33" width="810" height="234" fill="#ffffff"/>
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

<figure class="diagram">
<svg viewBox="5 4 710 328" role="img" aria-labelledby="pb-pool-t pb-pool-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pb-pool-t">Encoding throughput against process-pool size</title>
  <desc id="pb-pool-d">Throughput rises almost linearly up to the number of physical cores, gains only a few per cent from the hyperthreads above that, and then falls as workers contend for memory bandwidth and disk. The best pool size is the count of physical cores, not of logical processors.</desc>
  <rect class="svg-bg" x="5" y="4" width="710" height="328" fill="#ffffff"/>
  <text x="370" y="32" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Adding workers past the physical core count costs throughput, it does not buy it</text>
  <path d="M60 60 V250 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="70,225 110,202 190,158 270,120 350,90 430,82 510,84 590,95 670,111" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="70" cy="225" r="4"/>
    <circle cx="110" cy="202" r="4"/>
    <circle cx="190" cy="158" r="4"/>
    <circle cx="270" cy="120" r="4"/>
    <circle cx="350" cy="90" r="4"/>
    <circle cx="430" cy="82" r="4"/>
    <circle cx="510" cy="84" r="4"/>
    <circle cx="590" cy="95" r="4"/>
    <circle cx="670" cy="111" r="4"/>
  </g>
  <path d="M350 60 V250" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M510 60 V250" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="350" y="52" fill="#4f7a4d" font-size="12" text-anchor="middle">8 physical cores</text>
  <text x="556" y="52" fill="#b0413e" font-size="12" text-anchor="middle">16 logical — throughput falling</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="70" y="272">1</text>
    <text x="110" y="272">2</text>
    <text x="190" y="272">4</text>
    <text x="270" y="272">6</text>
    <text x="350" y="272">8</text>
    <text x="430" y="272">10</text>
    <text x="510" y="272">12</text>
    <text x="590" y="272">14</text>
    <text x="670" y="272">16</text>
  </g>
  <text x="380" y="294" fill="#5b6471" font-size="12" text-anchor="middle">worker processes</text>
  <text x="34" y="150" fill="#5b6471" font-size="12" text-anchor="middle">tiles</text>
  <text x="34" y="166" fill="#5b6471" font-size="12" text-anchor="middle">/ min</text>
  <text x="370" y="314" fill="#15384a" font-size="12" text-anchor="middle">Measure it on the target machine — the knee moves with mesh size, because the limit is memory bandwidth, not CPU</text>
</svg>
<figcaption>The curve is flat, then negative. Sizing the pool from <code>os.cpu_count()</code> lands on the far side of the knee on every hyperthreaded machine.</figcaption>
</figure>

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

<figure class="diagram">
<svg viewBox="46 28 664 234" role="img" aria-labelledby="pb-chunk-t pb-chunk-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pb-chunk-t">Node startup cost, per job and per chunk</title>
  <desc id="pb-chunk-d">Dispatching one job per worker invocation pays the Node interpreter's startup cost before every tile, which for small tiles is most of the wall clock. Sending a chunk of jobs to a single invocation pays that cost once and amortises it across the whole chunk.</desc>
  <rect class="svg-bg" x="46" y="28" width="664" height="234" fill="#ffffff"/>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5">
    <rect x="60" y="70" width="46" height="30" rx="3"/>
    <rect x="166" y="70" width="46" height="30" rx="3"/>
    <rect x="272" y="70" width="46" height="30" rx="3"/>
    <rect x="378" y="70" width="46" height="30" rx="3"/>
    <rect x="484" y="70" width="46" height="30" rx="3"/>
    <rect x="590" y="70" width="46" height="30" rx="3"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5">
    <rect x="106" y="70" width="60" height="30" rx="3"/>
    <rect x="212" y="70" width="60" height="30" rx="3"/>
    <rect x="318" y="70" width="60" height="30" rx="3"/>
    <rect x="424" y="70" width="60" height="30" rx="3"/>
    <rect x="530" y="70" width="60" height="30" rx="3"/>
    <rect x="636" y="70" width="60" height="30" rx="3"/>
  </g>
  <rect x="60" y="160" width="46" height="30" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5">
    <rect x="106" y="160" width="60" height="30" rx="3"/>
    <rect x="166" y="160" width="60" height="30" rx="3"/>
    <rect x="226" y="160" width="60" height="30" rx="3"/>
    <rect x="286" y="160" width="60" height="30" rx="3"/>
    <rect x="346" y="160" width="60" height="30" rx="3"/>
    <rect x="406" y="160" width="60" height="30" rx="3"/>
  </g>
  <text x="60" y="56" fill="#1f2937" font-size="12.5" text-anchor="start" font-weight="600">one job per invocation — 696 ms for six tiles</text>
  <text x="60" y="146" fill="#1f2937" font-size="12.5" text-anchor="start" font-weight="600">one chunk per invocation — 466 ms for the same six</text>
  <text x="60" y="122" fill="#b0413e" font-size="11.5" text-anchor="start">red blocks are interpreter startup: paid six times</text>
  <text x="60" y="212" fill="#4f7a4d" font-size="11.5" text-anchor="start">paid once, then six encodes back to back</text>
  <text x="380" y="244" fill="#15384a" font-size="12" text-anchor="middle">The saving grows as tiles get smaller, which is exactly when a city has the most of them</text>
</svg>
<figcaption>Chunking is not about parallelism at all — it is about how often you pay for a cold interpreter. Size chunks so a worker runs for seconds, not milliseconds.</figcaption>
</figure>

The pool size and the chunk size answer different questions, and it is worth keeping them apart. Pool size is a contention question: how many encodes can run at once before they start competing for the same memory bandwidth and the same disk queue. Chunk size is an overhead question: how much work each invocation must carry before the fixed cost of starting it stops mattering. Tuning one to compensate for the other produces a configuration that stops working the moment the tile size changes.

There is also a determinism cost to get right. A pool returns results in completion order, which varies run to run, so anything that consumes the results — a manifest, a tileset index, a content hash — has to re-sort them into the job order before writing. The cheapest way to guarantee that is to have each worker return its input index alongside its output, then sort on that index before serialising. Skipping the sort produces builds that are byte-different on every run for no reason other than scheduling jitter, which in turn defeats the content-hash comparison the incremental pipeline depends on.

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

Keep the encoder's stdout out of the parent process. A pool of eight workers each streaming progress lines through a shared pipe will spend real time serialising on that pipe, and on a slow terminal it can dominate the run. Redirect worker output to per-job log files and surface only the failures; the logs are more useful afterwards anyway, because they are attributable to a specific tile.

## Common Errors

**`BrokenProcessPool: A process in the process pool was terminated abruptly`.** A worker was killed by the OS out-of-memory reaper because too many Node encoders ran at once on large meshes, or a worker segfaulted. `ProcessPoolExecutor` cannot recover and the whole pool dies. Fix: size workers to physical cores (step 2), cap peak resident meshes by chunking rather than submitting one future per tile, and set your CI runner's memory limit above `workers × peak-Node-RSS`.

**`AttributeError: Can't pickle local object` when submitting jobs.** The worker function or an object it closes over was defined inside another function, so `ProcessPoolExecutor` cannot pickle it to send to the child process. Fix: define `encode_chunk` at module top level and pass only picklable arguments (strings and `Path` objects), never open file handles or lambdas.

**`FileNotFoundError: [Errno 2] No such file or directory: '3d-tiles-tools'`.** The child process inherited a `PATH` that does not include the Node bin directory — common when the pool is spawned (macOS/Windows default) rather than forked, or inside a minimal CI container. Fix: install `3d-tiles-tools` globally on `PATH`, or pass an absolute path to the executable in the `subprocess.run` argument list so every worker resolves it identically.

## Related Guides

- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — the sharding, hash-cache, and assembly layer this encode step plugs into
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — the single-tileset encode and geometricError model each job produces
- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — running the parallel encode as a cached, reproducible CI job

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
