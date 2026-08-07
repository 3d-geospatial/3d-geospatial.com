# Profiling PDAL Pipelines with cProfile and py-spy

This page finds where a PDAL job actually spends its time — using the pipeline's own stage metadata first, `py-spy --native` when that is not enough, and `cProfile` only for the Python that surrounds the pipeline. The recurring finding is that reading and decompressing dominates, and the filters teams spend their time tuning are a minority of the cost, which changes what is worth optimising.

## Why you hit this

A PDAL pipeline is a Python object wrapping a C++ execution graph, and that boundary is where naive profiling fails. `cProfile` sees one call to `execute()` taking eleven minutes and reports nothing else, because everything below it is native. The result is that people optimise the Python around the pipeline — the file listing, the JSON construction — which is measured in milliseconds, while the eleven minutes stay exactly where they were.

## Prerequisites

- PDAL 2.6+ with Python bindings, plus `py-spy>=0.3` (`pip install py-spy`) and `psutil>=5.9`.
- Debug symbols available for native frames. The conda-forge PDAL builds carry enough for `py-spy --native` to resolve stage names.
- A representative tile — tens of millions of points, not a test fixture.
- On Linux, either root or `sysctl kernel.yama.ptrace_scope=0` so `py-spy` can attach to a running process.

## Step-by-Step

### 1. Read the stage timings PDAL already reports

Before reaching for a profiler, ask the pipeline. PDAL records per-stage metadata including how long each stage ran.

```python
import json
import pdal

spec = {"pipeline": [
    "tile_utm33n.laz",
    {"type": "filters.outlier", "method": "statistical", "mean_k": 12, "multiplier": 2.5},
    {"type": "filters.smrf", "window": 18.0, "slope": 0.2, "threshold": 0.45},
    {"type": "filters.range", "limits": "Classification[2:2]"},
    {"type": "writers.las", "filename": "ground.laz", "forward": "all"},
]}

p = pdal.Pipeline(json.dumps(spec))
n = p.execute()

meta = p.metadata["metadata"]
for stage, m in meta.items():
    if isinstance(m, dict) and "stage_wall_time" in m:
        print(f"{stage:<28} {m['stage_wall_time']:8.2f}s")
print(f"{n:,} points through the pipeline")
```

This costs nothing and answers the question most of the time. A stage taking 60% of the run is the one to think about, and no flame graph is needed to establish that.

### 2. Separate I/O from computation

The reader's time is decompression plus disk, and those respond to completely different fixes. Separating them takes one extra run against an uncompressed copy.

```python
import time
import json
import pdal

def time_read(path):
    t0 = time.perf_counter()
    p = pdal.Pipeline(json.dumps({"pipeline": [path]}))
    n = p.execute()
    return time.perf_counter() - t0, n

laz_s, n = time_read("tile_utm33n.laz")
las_s, _ = time_read("tile_utm33n.las")          # same data, uncompressed
print(f"LAZ {laz_s:.1f}s | LAS {las_s:.1f}s | decompression ≈ {laz_s - las_s:.1f}s "
      f"({100 * (laz_s - las_s) / laz_s:.0f}% of the read)")
```

If decompression dominates, the fix is COPC or a chunked reader that decompresses only the extent you need. If raw I/O dominates, the fix is faster storage or reading from object storage in parallel — and the two are frequently confused, with teams switching formats to solve a disk problem.

<figure class="diagram">
<svg viewBox="13 46 714 208" role="img" aria-labelledby="pf-io-t pf-io-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-io-t">Splitting a reader's time into disk and decompression</title>
  <desc id="pf-io-d">Reading a compressed LAZ tile takes 214 seconds. Reading the same data uncompressed takes 61, so decompression accounts for about seventy per cent of the read. The two halves respond to different remedies: faster storage helps the disk half and a chunked or COPC reader helps the decompression half.</desc>
  <rect class="svg-bg" x="13" y="46" width="714" height="208" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="470" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="98" width="134" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="150" width="336" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="540" y="80">LAZ read — 214 s</text>
    <text x="204" y="118">LAS read — 61 s (disk only)</text>
    <text x="406" y="170">decompression — 153 s, 71% of the read</text>
  </g>
  <text x="370" y="212" fill="#15384a" font-size="12.5" text-anchor="middle">Faster storage would recover at most 61 s; a chunked reader that decompresses one extent recovers most of the 153</text>
  <text x="370" y="236" fill="#5b6471" font-size="12" text-anchor="middle">Two runs and a subtraction, and the optimisation stops being a guess</text>
</svg>
<figcaption>Two numbers separate two remedies that are routinely confused. The measurement takes one extra run against an uncompressed copy.</figcaption>
</figure>

### 3. Take a native flame graph when a stage needs opening up

When one stage dominates and you need to know why, sample it with native frames.

```bash
python pipeline.py tile_utm33n.laz &
PID=$!
py-spy record --pid $PID --native --rate 100 --duration 120 \
              --format speedscope --output profile.json
wait $PID
```

Then read the profile programmatically rather than only in a viewer, so the finding can go into a commit message:

```python
import collections
import json

prof = json.load(open("profile.json"))
frames = prof["shared"]["frames"]
weights = collections.Counter()

for p in prof["profiles"]:
    for ev in p["events"]:
        if ev["type"] == "C":                      # close: a frame finished
            weights[frames[ev["frame"]]["name"]] += ev["at"]

total = sum(weights.values()) or 1
for name, w in weights.most_common(12):
    print(f"{100 * w / total:5.1f}%  {name[:70]}")
```

### 4. Use cProfile only for the Python around the pipeline

There is real Python cost in a batch job — tile enumeration, manifest hashing, result aggregation — and `cProfile` is the right tool for exactly that.

```python
import cProfile
import pstats

pr = cProfile.Profile()
pr.enable()
manifest = build_manifest(tile_paths)          # hashing, globbing, JSON
dirty = select_dirty(manifest, previous)
pr.disable()

pstats.Stats(pr).sort_stats("tottime").print_stats(10)
```

Keep it off the `execute()` call itself. Wrapping a native call in a deterministic profiler adds overhead to the wrapper and measures nothing inside.

### 5. Watch memory alongside time

A job that is slow because it is swapping looks in a CPU profile like a job that is slow in whatever function happened to touch memory. Sampling RSS separates the two.

```python
import threading
import time
import psutil

def watch(pid, out, interval=1.0):
    proc = psutil.Process(pid)
    while proc.is_running():
        try:
            out.append((time.perf_counter(), proc.memory_info().rss / 1e9))
        except psutil.NoSuchProcess:
            break
        time.sleep(interval)

samples = []
t = threading.Thread(target=watch, args=(os.getpid(), samples), daemon=True)
t.start()

run_pipeline("tile_utm33n.laz")
peak = max(rss for _, rss in samples)
print(f"peak RSS {peak:.2f} GB over {len(samples)} samples")
```

A monotonically climbing curve is accumulation, a sawtooth is streaming working correctly, and a plateau at the machine's limit with a slow run is swapping — three different problems that a CPU profile alone reports identically.

<figure class="diagram">
<svg viewBox="36 26 679 230" role="img" aria-labelledby="pf-shape-t pf-shape-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-shape-t">Three memory shapes, three different problems</title>
  <desc id="pf-shape-d">A resident-set curve that climbs monotonically means something is accumulating. A sawtooth means streaming is working and the peak is one chunk. A flat plateau at the machine limit with a slow run means the process is swapping, which a CPU profile misattributes to whichever function touched memory.</desc>
  <rect class="svg-bg" x="36" y="26" width="679" height="230" fill="#ffffff"/>
  <path d="M50 40 V190 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M50 70 H700" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="5 4"/>
  <polyline points="70,182 120,168 170,150 220,132 260,112 290,92 310,74" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="360,180 380,148 382,178 402,146 404,176 424,148 426,178 446,146 448,176 468,150"
            fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="530,120 560,74 600,72 650,73 690,72" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <text x="700" y="64" fill="#b0413e" font-size="11.5" text-anchor="end">machine RAM</text>
  <text x="190" y="212" fill="#b0413e" font-size="12" text-anchor="middle">accumulating</text>
  <text x="414" y="212" fill="#4f7a4d" font-size="12" text-anchor="middle">streaming correctly</text>
  <text x="610" y="212" fill="#c46a3d" font-size="12" text-anchor="middle">swapping</text>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">A CPU profile reports all three as &quot;slow in some function&quot; — the RSS curve names which one you have</text>
</svg>
<figcaption>One extra sampling thread distinguishes three failures that a CPU profile cannot tell apart.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="10 38 720 168" role="img" aria-labelledby="pf-order-t pf-order-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-order-t">The order to reach for each tool</title>
  <desc id="pf-order-d">Start with stage timings the pipeline already reports, which are free and answer the question most of the time. Escalate to a native sampled profile only when one stage dominates and you need to know why. Reach for a deterministic profiler only for the Python surrounding the pipeline, and never for the pipeline itself.</desc>
  <rect class="svg-bg" x="10" y="38" width="720" height="168" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="52" width="216" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="262" y="52" width="216" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="500" y="52" width="216" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="132" y="74"><tspan x="132" dy="0" font-weight="600">1 · stage metadata</tspan><tspan x="132" dy="17">free, exact, usually enough</tspan><tspan x="132" dy="16">answers: which stage?</tspan></text>
    <text x="370" y="74"><tspan x="370" dy="0" font-weight="600">2 · py-spy --native</tspan><tspan x="370" dy="17">cheap, attaches live</tspan><tspan x="370" dy="16">answers: why that stage?</tspan></text>
    <text x="608" y="74"><tspan x="608" dy="0" font-weight="600">3 · cProfile</tspan><tspan x="608" dy="17">Python around the pipeline</tspan><tspan x="608" dy="16">never on execute()</tspan></text>
  </g>
  <text x="370" y="160" fill="#15384a" font-size="12.5" text-anchor="middle">Most investigations end at step one, and every investigation that starts at step three measures the wrong thing</text>
  <text x="370" y="188" fill="#5b6471" font-size="12" text-anchor="middle">Add the RSS sampler alongside whichever step you are on — it costs one thread and rules out an entire class of cause</text>
</svg>
<figcaption>Escalate rather than starting at the most powerful tool. The free measurement answers the question far more often than its cost suggests.</figcaption>
</figure>

## Expected Output & Verification

A representative profile of a 42-million-point tile:

```text
readers.las                   214.31s
filters.outlier                31.88s
filters.smrf                   47.02s
filters.range                   2.14s
writers.las                    38.77s
42,118,904 points through the pipeline

LAZ 214.1s | LAS 61.3s | decompression ≈ 152.8s (71% of the read)
peak RSS 3.84 GB over 334 samples
```

Read three things out of that. Reading is 64% of the run and decompression is most of it, so a chunked reader is the highest-value change available. `filters.smrf` at 14% is worth tuning only after that. And a peak RSS well under the machine's RAM means the run is not memory-bound, so parallelism is likely to help — which the [pool-sizing measurement](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/) will confirm.

Verify the finding before acting on it by re-running three times and checking the shares are stable within a couple of points. A share that moves by ten points between runs is measuring contention.

## Common Errors

**The flame graph is one frame deep.** `--native` was omitted, so everything below the Python boundary is invisible. For PDAL, GDAL and Open3D that is the entire workload.

**`Permission denied` attaching to a process.** Linux `ptrace_scope` blocks attaching to a non-child. Either run `py-spy` as root, set `sysctl kernel.yama.ptrace_scope=0`, or add `SYS_PTRACE` to the container.

**`cProfile` reports the whole run inside `execute`.** That is correct and useless. Move the profiler to the Python surrounding the pipeline and sample the pipeline itself.

**The profile attributes far less time than the wall clock.** The process is blocked on I/O, which a sampler records as time in whatever frame is waiting, or the sample rate is too low to catch a stage. Compare attributed time against wall clock explicitly and investigate any large gap.

## Frequently Asked Questions

### Can I profile a pipeline running in a container in CI?
Yes. Add `--cap-add SYS_PTRACE` to the container and run `py-spy` as a second process against the pipeline's PID. It is worth doing once when a CI job is unexpectedly slow, and not worth doing on every build.

### Does `--native` slow the pipeline down?
Marginally — symbol resolution costs a little per sample, and at 100 Hz that is negligible against a job measured in minutes. It is far cheaper than the distortion `cProfile` introduces.

### How do I profile a streaming pipeline?
The same way. `py-spy` samples whatever the process is doing, so a streaming pipeline shows its steady-state distribution directly, which is usually more informative than a whole-run profile of a batch job.

One more habit is worth building in. Store each profile's headline numbers — total wall clock, the share of the top stage, peak RSS, and the machine's core count — in the build artifact next to the output. Profiles are usually taken during an incident and discarded afterwards, so the next incident starts from nothing; a four-line record per run costs nothing and turns "is this slower than it used to be" into a lookup rather than an argument.

The related discipline is to profile the workload you actually run, not a reduced version of it. Halving the tile size to make the profiling loop faster moves the bottleneck: at forty million points the run is bound by decompression and memory bandwidth, and at four million it is bound by per-call overhead in exactly the functions a profiler makes most visible. The reduced profile is not a faster version of the real one; it is a profile of a different program.

### Should the RSS sampler run in production jobs?
Yes. It is one thread, one syscall per second, and it converts "the job died" into a shape that names the cause. Log the peak alongside the chunk size and the worker count and capacity planning becomes interpolation from your own history.


### Can I compare profiles taken on different machines?
Only as shares, never as absolute times. Core count, memory bandwidth and disk type move wall clock by more than most optimisations do, so a cross-machine comparison of totals says nothing. The share of the top stage is comparable and is usually the number you actually wanted.


## Related Guides

- [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/) — which tool answers which question
- [Fixing Memory OOM in City-Scale Decimation](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/fixing-memory-oom-in-city-scale-decimation/) — when the RSS curve is the finding
- [Parallel b3dm Encoding with Process Pools](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/) — sizing a pool once the bottleneck is known

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
