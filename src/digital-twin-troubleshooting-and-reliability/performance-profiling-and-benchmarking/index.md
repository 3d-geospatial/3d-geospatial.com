---
title: "Performance Profiling and Benchmarking"
description: "Measure a spatial pipeline instead of guessing: cProfile and py-spy on PDAL jobs, frame profiling in Cesium, decode benchmarks, and a regression harness that holds."
---
# Performance Profiling and Benchmarking

Almost every performance decision in a digital twin pipeline is made from intuition, and almost every intuition is wrong in the same direction: teams optimise the code they wrote and ignore the I/O, the decode and the driver upload that surround it. This guide covers the three places a twin actually spends time — the batch pipeline, the client frame loop, and the GPU — the tools that measure each without distorting it, and the regression harness that turns a one-off measurement into something that keeps being true.

The organising idea is that a measurement is only useful if it is attributable and repeatable. A profile that says "the job took eleven minutes" tells you nothing; one that says "62% of wall clock was in `readers.las`, and that share is stable across three runs" tells you where to look and lets you prove the fix worked. Everything below is arranged around producing the second kind.

## Prerequisites

- **Python 3.10+** with `cProfile` and `pstats` (standard library), `py-spy>=0.3` (`pip install py-spy`), `psutil>=5.9`, and `pytest-benchmark>=4.0` for the regression harness.
- **Chrome or Chromium** with DevTools for client-side frame profiling, plus CesiumJS 1.107+ if the twin uses it.
- **A representative workload.** Profiling a 500-point test tile answers nothing about a 40-million-point one, because the bottleneck moves from function-call overhead to memory bandwidth somewhere between them.
- **A quiet machine.** A profile taken while a browser and a build are running measures contention, not your code.

## Concept

Three kinds of measurement answer three different questions, and using one for another's job is the usual source of misleading numbers.

**Deterministic profiling** — `cProfile` — instruments every function call and counts them exactly. It is precise about call counts and relative cost, and it inflates absolute time substantially, sometimes by a factor of two or more, with the inflation concentrated in functions called very often. Use it to find *which* function dominates; do not quote its wall-clock numbers.

**Sampling profiling** — `py-spy` — interrupts the process at a fixed rate and records the stack. It costs almost nothing, so the absolute times are trustworthy, and it can attach to a process that is already running, including one inside a container. Its weakness is the opposite of `cProfile`'s: rare-but-expensive calls can be missed entirely at a low sample rate.

**Benchmarking** — timing a bounded operation repeatedly under controlled conditions — answers "is this faster than it was", which neither profiler answers well. It is the only one of the three that belongs in CI.

<figure class="diagram">
<svg viewBox="6 36 748 240" role="img" aria-labelledby="pp-three-t pp-three-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pp-three-t">Three measurement tools and the question each answers</title>
  <desc id="pp-three-d">Deterministic profiling counts every call exactly and distorts absolute time. Sampling profiling costs almost nothing and gives trustworthy wall-clock shares but can miss rare expensive calls. Benchmarking answers whether something got slower, and is the only one of the three suited to continuous integration.</desc>
  <rect class="svg-bg" x="6" y="36" width="748" height="240" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="20" y="50" width="230" height="150" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="265" y="50" width="230" height="150" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="510" y="50" width="230" height="150" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="80"><tspan x="135" dy="0" font-weight="600">cProfile</tspan><tspan x="135" dy="20">exact call counts</tspan><tspan x="135" dy="18">inflates absolute time</tspan><tspan x="135" dy="18">answers: which function?</tspan><tspan x="135" dy="18">never in CI</tspan></text>
    <text x="380" y="80"><tspan x="380" dy="0" font-weight="600">py-spy</tspan><tspan x="380" dy="20">near-zero overhead</tspan><tspan x="380" dy="18">attaches to a live process</tspan><tspan x="380" dy="18">answers: where is the time?</tspan><tspan x="380" dy="18">misses rare calls</tspan></text>
    <text x="625" y="80"><tspan x="625" dy="0" font-weight="600">benchmark</tspan><tspan x="625" dy="20">bounded, repeated</tspan><tspan x="625" dy="18">comparable across runs</tspan><tspan x="625" dy="18">answers: did it regress?</tspan><tspan x="625" dy="18">belongs in CI</tspan></text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Quoting cProfile's wall clock, or trying to find a hot function from a benchmark, are the two ways this goes wrong</text>
  <text x="380" y="258" fill="#5b6471" font-size="12" text-anchor="middle">Use the first two to decide what to change, and the third to prove it stayed changed</text>
</svg>
<figcaption>Each tool is precise about something different. The failures come from asking one of them the question another was built for.</figcaption>
</figure>

**Key Practice:** Record the machine alongside every number. Core count, RAM, disk type and whether the run was containerised change results by more than most optimisations do, and a benchmark history without that context cannot distinguish a regression from a change of runner.

## The measurement discipline

Three habits separate profiling that changes something from profiling that produces a document nobody reads.

**Measure the workload you ship.** A profile of a reduced input is a profile of a different program: at forty million points a PDAL job is bound by decompression and memory bandwidth, and at four million it is bound by per-call overhead in exactly the functions a deterministic profiler makes most visible. Halving the input to make the loop faster therefore relocates the bottleneck rather than revealing it, and the optimisation that follows targets something that does not exist at production scale. If the real workload is too slow to iterate on, profile a full-size tile once to establish where the time goes, then iterate on the specific stage that dominates.

**Establish a baseline before changing anything.** Without a stored "before", a change that made things worse is indistinguishable from one that made them better, and both feel like progress because the code is now different and attention has been paid. The baseline does not need to be elaborate: total wall clock, the share of the top stage, peak resident memory, and the machine's core count, written into the build artifact. Four numbers per run make the next investigation a lookup instead of an argument.

**Attribute the whole clock.** A profile that explains sixty per cent of the elapsed time and leaves forty unaccounted has not found the bottleneck; it has found the largest of the things it could see. In spatial pipelines the unattributed remainder is nearly always one of three things — native frames the sampler was not asked to resolve, blocking I/O the sampler records as idle, or time queued behind a lock or a connection limit — and each of them is a different problem from the one the visible profile suggests. Comparing attributed time against wall clock is one subtraction and it decides whether the rest of the analysis is worth doing.

## Where the time actually goes

It is worth stating the shape of a typical twin's cost, because it is consistently different from where teams look first.

On the batch side, reading dominates. For a PDAL job over compressed LAZ, decompression and disk together account for half to two thirds of wall clock on a typical tile, and the filters — the part with the interesting parameters — account for a quarter. That ratio is why format and storage decisions outrank filter tuning, and why a chunked or cloud-optimised reader is usually the largest single improvement available.

On the client side, the frame budget is spent before anything is drawn. A tile that takes 45 ms to fetch, 18 ms to decode and 6 ms to upload has consumed four frames' worth of budget before its first triangle reaches the rasteriser, and reducing the triangle count changes none of those three numbers. The corollary is that draw-call count, not triangle count, is the geometry-side lever that matters: merging four hundred small meshes into forty typically saves several milliseconds per frame where halving every triangle saves about one.

And on both sides, parallelism stops helping at the physical core count and then reverses, because the constraint becomes memory bandwidth rather than instruction throughput. That knee is cheap to measure and expensive to assume.

## Step-by-Step Workflow

### 1. Establish where wall clock actually goes, before profiling anything

The cheapest useful measurement is a stopwatch around each stage. It costs nothing, it is exact, and it very often makes the profiler unnecessary.

```python
import time
import contextlib

@contextlib.contextmanager
def stage(name, log):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        log[name] = log.get(name, 0.0) + time.perf_counter() - t0

timings = {}
with stage("read", timings):
    cloud = read_laz("tile.laz")
with stage("filter", timings):
    cloud = filter_outliers(cloud)
with stage("classify", timings):
    cloud = classify_ground(cloud)
with stage("write", timings):
    write_laz(cloud, "out.laz")

total = sum(timings.values())
for name, secs in sorted(timings.items(), key=lambda kv: -kv[1]):
    print(f"{name:<10} {secs:7.2f}s  {100 * secs / total:5.1f}%")
```

Run it three times and look at the variance before believing any of it. A stage whose share moves by more than a few points between runs is contending with something outside the process, and profiling it will chase that contention rather than the code.

### 2. Profile the dominant stage deterministically

Only once a stage is known to dominate is a function-level profile worth taking.

```python
import cProfile
import pstats
import io

pr = cProfile.Profile()
pr.enable()
classify_ground(cloud)
pr.disable()

buf = io.StringIO()
pstats.Stats(pr, stream=buf).sort_stats("cumulative").print_stats(15)
print(buf.getvalue())
```

Read `cumulative` first to find the subtree that dominates, then `tottime` to find where the work actually happens inside it. A function with high cumulative and negligible `tottime` is a dispatcher, and optimising it does nothing.

### 3. Sample a long or already-running job

`py-spy` attaches to a live process, which makes it the right tool for a job that is already three hours into a six-hour run.

```bash
# Flame graph of a running pipeline, sampled for 60 seconds at 100 Hz.
py-spy record --pid $(pgrep -f 'pipeline.py') --duration 60 --rate 100 --output flame.svg

# Or a live top-style view, useful for spotting a stage transition.
py-spy top --pid $(pgrep -f 'pipeline.py')

# Native frames matter for PDAL and GDAL, which do most of the work in C++.
py-spy record --pid $(pgrep -f 'pipeline.py') --native --duration 60 --output flame_native.svg
```

`--native` is the flag that matters for spatial work. Without it, a PDAL pipeline shows a single Python frame calling `execute()` and nothing beneath, because all the real time is in C++. With it, the flame graph resolves into the individual filter stages.

<figure class="diagram">
<svg viewBox="16 42 728 214" role="img" aria-labelledby="pp-native-t pp-native-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pp-native-t">What --native changes about a PDAL profile</title>
  <desc id="pp-native-d">Without native frames a sampled profile of a PDAL pipeline shows one Python frame calling execute and nothing below it, so ninety-four per cent of the time is unattributed. With native frames the same profile resolves into the reader, the outlier filter, the ground filter and the writer, each with its own share.</desc>
  <rect class="svg-bg" x="16" y="42" width="728" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="300" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="30" y="86" width="282" height="26" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="start">
    <text x="38" y="74">pipeline.execute()  6%</text>
    <text x="38" y="104">unattributed native time  94%</text>
  </g>
  <g stroke-width="2">
    <rect x="430" y="56" width="300" height="22" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="430" y="82" width="176" height="22" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="430" y="108" width="72" height="22" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="430" y="134" width="42" height="22" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="430" y="160" width="28" height="22" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="start">
    <text x="438" y="72">pipeline.execute()</text>
    <text x="614" y="98">readers.las  59%</text>
    <text x="510" y="124">filters.smrf  24%</text>
    <text x="480" y="150">filters.outlier  14%</text>
    <text x="466" y="176">writers.las  9%</text>
  </g>
  <text x="180" y="140" fill="#b0413e" font-size="12" text-anchor="middle">without --native</text>
  <text x="580" y="206" fill="#4f7a4d" font-size="12" text-anchor="middle">with --native</text>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">The finding — that reading dominates and the filter does not — is invisible without native frames</text>
</svg>
<figcaption>A Python profile of a C++ pipeline attributes almost nothing. The flag costs a symbol lookup and changes what the profile is for.</figcaption>
</figure>

### 4. Profile the client frame loop

The browser side has its own tooling and its own trap: the profiler's own overhead changes the frame budget it is measuring.

```javascript
// Per-frame timing that survives being left in production.
const marks = { cull: 0, request: 0, decode: 0, upload: 0, draw: 0 };
let frames = 0;

viewer.scene.preUpdate.addEventListener(() => { performance.mark('frame-start'); });
viewer.scene.postRender.addEventListener(() => {
  performance.measure('frame', 'frame-start');
  const entries = performance.getEntriesByName('frame');
  marks.draw += entries[entries.length - 1].duration;
  performance.clearMeasures('frame');
  if (++frames % 300 === 0) {
    console.table(Object.fromEntries(
      Object.entries(marks).map(([k, v]) => [k, (v / frames).toFixed(2) + ' ms'])));
  }
});
```

Read it alongside the numbers CesiumJS already exposes — `scene.globe.tilesLoaded`, `scene.primitives.length`, and the frame rate from `viewer.scene.debugShowFramesPerSecond` — because a frame time that rises while tiles are still loading is a different problem from one that is high in a steady state.

### 5. Benchmark the operations you care about, in CI

A benchmark is a bounded operation, repeated, with the variance reported. `pytest-benchmark` handles the statistics and the comparison against a stored baseline.

```python
import pytest
import numpy as np

@pytest.fixture(scope="module")
def cloud():
    rng = np.random.default_rng(0)
    return rng.normal(size=(2_000_000, 3)).astype(np.float64)

def test_voxel_downsample(benchmark, cloud):
    result = benchmark(voxel_downsample, cloud, voxel_size=0.25)
    assert len(result) < len(cloud)

def test_ground_classify(benchmark, cloud):
    benchmark.pedantic(classify_ground, args=(cloud,), rounds=5, iterations=1)
```

```bash
pytest --benchmark-autosave --benchmark-min-rounds=5 bench/
pytest --benchmark-compare=0001 --benchmark-compare-fail=mean:10%
```

The `--benchmark-compare-fail` threshold is what makes it a gate rather than a report. Ten per cent is a reasonable starting point on a dedicated runner and far too tight on a shared one, where run-to-run variance alone can exceed it.

<figure class="diagram">
<svg viewBox="18 46 705 224" role="img" aria-labelledby="pp-var-t pp-var-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pp-var-t">A threshold has to sit outside the runner's own noise</title>
  <desc id="pp-var-d">On a dedicated runner the same benchmark varies by about three per cent between runs, so a ten per cent regression threshold is comfortably outside the noise. On a shared runner the same benchmark varies by eighteen per cent, so the threshold fires on scheduling luck and the team learns to ignore it.</desc>
  <rect class="svg-bg" x="18" y="46" width="705" height="224" fill="#ffffff"/>
  <path d="M60 60 V196 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 100 H700" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="700" y="94" fill="#b0413e" font-size="12" text-anchor="end">10% regression threshold</text>
  <polyline points="100,150 160,146 220,152 280,148 340,151 400,147 460,150 520,149 580,152 640,148"
            fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="100,152 160,118 220,168 280,110 340,172 400,124 460,164 520,106 580,170 640,130"
            fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <text x="120" y="186" fill="#4f7a4d" font-size="12" text-anchor="start">dedicated runner — ±3%</text>
  <text x="120" y="88" fill="#9a4f26" font-size="12" text-anchor="start">shared runner — ±18%, crosses the line on noise alone</text>
  <text x="380" y="224" fill="#5b6471" font-size="12" text-anchor="middle">consecutive CI runs of the same commit</text>
  <text x="370" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">Measure your runner's variance first, then set the threshold above it — otherwise the gate trains people to ignore it</text>
</svg>
<figcaption>The threshold is a property of the runner, not of the code. Setting it from a blog post rather than from measured variance is why most benchmark gates end up disabled.</figcaption>
</figure>

## Validation & Verification

A profiling result is trustworthy when three things hold, and it is worth checking all three before acting on it.

The first is repeatability: three runs of the same workload on the same machine agree within the runner's measured variance. If they do not, the measurement is of the environment.

The second is that the profile's total accounts for the wall clock. A sampled profile that attributes 60% of the time and leaves 40% unexplained is usually missing native frames, or the process is blocked on I/O that the sampler records as idle.

```python
import subprocess, json, time

t0 = time.perf_counter()
proc = subprocess.Popen(["python", "pipeline.py", "tile.laz"])
subprocess.run(["py-spy", "record", "--pid", str(proc.pid), "--native",
                "--duration", "120", "--format", "speedscope",
                "--output", "profile.json"], check=True)
proc.wait()
wall = time.perf_counter() - t0

prof = json.load(open("profile.json"))
sampled = sum(p["endValue"] - p["startValue"] for p in prof["profiles"])
print(f"wall {wall:.1f}s | sampled {sampled:.1f}s | attributed {100 * sampled / wall:.0f}%")
```

The third is that the fix moves the number you profiled. Optimising the function a profile identified and seeing no change in wall clock means the profile was measuring something other than the bottleneck — usually because the real constraint is I/O or memory bandwidth, which appears in a CPU profile as time spent in whatever function happened to be waiting.

## Performance & Scale

Three findings recur often enough across spatial pipelines to be worth stating as priors, each of which the tooling above will confirm or refute on your own workload.

**Reading usually dominates.** On a typical PDAL job over compressed LAZ, decompression and I/O account for half to two thirds of wall clock, and the filters people spend their time tuning account for a quarter. That is why [caching the layers in CI](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) and streaming from object storage move the needle more than filter parameters do.

**Parallelism runs out at the physical core count**, and then reverses, because the constraint becomes memory bandwidth rather than instruction throughput. Measuring the knee takes ten minutes and is the difference between a pool that is fast and one that is merely busy.

**On the client, decode and upload frequently exceed draw time.** A frame that spends 18 ms decoding Draco and 2 ms drawing is not a geometry problem, and reducing the triangle count will not fix it.

## Failure Modes & Gotchas

- **Quoting `cProfile`'s wall clock.** The instrumentation overhead lands disproportionately on frequently-called functions, so it both inflates the total and distorts the ranking. Use it for relative cost and take absolute times from a sampler.
- **Profiling a toy workload.** The bottleneck at 500,000 points is function-call overhead; at 50 million it is memory bandwidth. A profile of the first tells you nothing actionable about the second.
- **Sampling without `--native`.** For any pipeline whose real work is in C++ — PDAL, GDAL, Open3D — the profile shows a single opaque frame. The flag is not optional for this domain.
- **Benchmarking on a shared runner without measuring its variance.** A threshold tighter than the noise fires constantly and gets muted, at which point the gate is worse than none because it creates false confidence.
- **Optimising before establishing a baseline.** Without a stored "before", a change that made things worse is indistinguishable from one that made them better, and both feel like progress.

## Frequently Asked Questions

### Should profiling run in CI?
No — benchmarking should. A profile is a diagnostic taken when something is known to be slow; a benchmark is a regression check that runs every build. Running a profiler in CI produces artifacts nobody reads and adds minutes to every run.

### How do I profile inside a container?
`py-spy` attaches from the host given the container's PID, or from inside with `SYS_PTRACE` granted. The second is usually simpler in CI: add `--cap-add SYS_PTRACE` to the run and invoke `py-spy` as a sidecar process.

### What sample rate should I use?
100 Hz is a good default. Higher rates resolve short functions better and cost more; below about 50 Hz a stage that runs for a second or two can be missed entirely. If a known stage is absent from the flame graph, that is the first thing to raise.

### How many rounds does a benchmark need?
Enough that the reported standard deviation stabilises — typically five to ten for operations taking a second or more, and hundreds for microsecond operations. `pytest-benchmark` will choose for you and report the variance, which is the number to look at rather than the mean.

### Does the GPU need its own approach?
Yes. CPU-side timers measure when a command was submitted, not when it completed, because the driver is asynchronous. Use timestamp queries through `EXT_disjoint_timer_query_webgl2`, or infer from steady-state frame rate under a controlled camera path.

### Should I trust a profile taken inside a container?
For CPU shares, yes — the sampler sees the same stacks. For wall clock, only if the container's CPU and memory limits match production, because a job that is throttled by a cgroup quota reports time in whatever function happened to be running when the quota expired.

### How often should the benchmark suite run?
On every merge to the default branch, and on any pull request that touches the pipeline. It costs minutes, and the value comes entirely from the history rather than from any single run.


## Related Guides

- [Profiling PDAL Pipelines with cProfile and py-spy](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/profiling-pdal-pipelines-with-cprofile-and-py-spy/) — the batch side in detail
- [Measuring Tile Load Times in the Cesium Frame Loop](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/measuring-tile-load-times-in-the-cesium-frame-loop/) — the client side in detail
- [Benchmarking Draco Decode on Mobile GPUs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/benchmarking-draco-decode-on-mobile-gpus/) — where the frame budget usually goes
- [Streaming & Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — turning these measurements into a diagnosis
- [Load Testing Tile Servers with Locust](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/load-testing-tile-servers-with-locust/) — load-test a tile server with a realistic request pattern
- [Memory Profiling Python Pipelines with memray](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/memory-profiling-python-pipelines-with-memray/) — find why a point-cloud pipeline needs 90 GB
- [Profiling WebGL with Spector.js](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/profiling-webgl-with-spector-js/) — capture and read a WebGL frame from a 3D Tiles viewer

Back to [Digital Twin Troubleshooting & Reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/).
