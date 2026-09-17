# Memory Profiling Python Pipelines with memray

This page finds where a point-cloud pipeline's memory goes — running it under memray with native tracking so NumPy and PDAL allocations are attributed to your own lines, distinguishing a high watermark from a leak, finding the temporary array copies that multiply peak usage, and turning the result into a per-stage budget the pipeline can be held to.

## Why you hit this

A pipeline that processes a 40-million-point tile in 6 GB fails on a 400-million-point one with 90 GB, and the arithmetic does not work: 400 million points at 24 bytes each is 9.6 GB, so where are the other 80 GB? The answer is almost always temporary copies — an `astype`, a boolean mask, a `column_stack` — each of which allocates a full-size array that stays alive until the name is rebound.

Python's own tooling is poor at finding these. `tracemalloc` misses every allocation made by NumPy's C code, which is all of them; `resource.getrusage` gives one number with no attribution. memray tracks native allocations and attributes them to the Python line that caused them, which is exactly the missing information.

## Prerequisites

- Python 3.10+ with `memray>=1.12` (Linux or macOS; memray does not support Windows).
- The pipeline runnable on a reduced input, because profiling a 90 GB run needs 90 GB.
- `pdal`, `laspy` and `numpy` as the pipeline requires.

## Step-by-Step

### 1. Capture a trace with native allocations attributed

```bash
# The two flags that matter: native tracking, and following forks.
memray run --native --follow-fork \
  --output build/profile/tile.bin \
  -m pipeline.process_tile input/tile_32_598_6643.laz

memray flamegraph build/profile/tile.bin --output build/profile/peak.html
memray flamegraph --leaks build/profile/tile.bin --output build/profile/leaks.html
memray summary build/profile/tile.bin
memray stats build/profile/tile.bin
```

```python
# profile_runner.py
import json
import subprocess
from pathlib import Path

def run_under_memray(module, args, out_dir="build/profile", native=True,
                     follow_fork=True, trace_python_allocators=False):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    binfile = Path(out_dir) / "trace.bin"
    binfile.unlink(missing_ok=True)
    cmd = ["memray", "run", "--output", str(binfile)]
    if native:
        cmd.append("--native")
    if follow_fork:
        cmd.append("--follow-fork")
    if trace_python_allocators:
        cmd.append("--trace-python-allocators")
    cmd.extend(["-m", module, *args])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return {
        "returncode": proc.returncode,
        "trace": str(binfile),
        "stderr_tail": proc.stderr.strip().splitlines()[-6:],
        "flags": {"native": native, "follow_fork": follow_fork,
                  "trace_python_allocators": trace_python_allocators},
        "note": "without --native, every NumPy allocation is attributed to a C "
                "extension and the report is useless",
    }

def read_stats(trace):
    proc = subprocess.run(["memray", "stats", "--json", trace],
                          capture_output=True, text=True, check=True)
    stats = json.loads(proc.stdout)
    peak = int(stats.get("metadata", {}).get("peak_memory", 0))
    allocated = int(stats.get("total_bytes_allocated", 0))
    return {
        "peak_bytes": peak,
        "peak_gb": round(peak / 1e9, 2),
        "total_allocations": int(stats.get("total_num_allocations", 0)),
        "total_allocated_gb": round(allocated / 1e9, 2),
        "churn_ratio": round(allocated / max(peak, 1), 1),
    }
```

`--native` is the flag without which this exercise is pointless. NumPy allocates through C, so a trace without native tracking attributes 13 GB to `numpy/core/multiarray` and tells you nothing about which line asked for it. With it, the flame graph points at `points = np.column_stack([x, y, z])` on line 84.

`--follow-fork` matters for any pipeline using `multiprocessing` or a Dask local cluster, which is most of them. Without it the parent's trace is nearly empty because all the work happened in children.

The **churn ratio** — total bytes allocated divided by the peak — is the first number to read. A ratio near 1 means the pipeline allocates what it needs and holds it; a ratio of 40 means it is allocating and freeing constantly, which is a temporary-copy problem and usually a speed problem too.

<figure class="diagram">
<svg viewBox="4 12 732 224" role="img" aria-labelledby="memray-flags-t memray-flags-d" xmlns="http://www.w3.org/2000/svg">
  <title id="memray-flags-t">The same run traced with and without native tracking</title>
  <desc id="memray-flags-d">Two attribution tables for the same 40-million-point run with a 5.8 gigabyte peak. Without native tracking, 5.4 gigabytes is attributed to numpy multiarray and 0.4 to Python code, which identifies nothing. With native tracking, 2.4 gigabytes is attributed to the laspy read, 0.96 to a column-stack call, 0.96 to an astype conversion and 0.5 to a boolean mask, each with a file and line number.</desc>
  <rect class="svg-bg" x="4" y="12" width="732" height="224" fill="#ffffff"/>
  <rect x="18" y="26" width="330" height="196" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="392" y="26" width="330" height="196" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="183" y="50" fill="#1f2937" font-size="13" text-anchor="middle">without --native</text>
  <text x="557" y="50" fill="#1f2937" font-size="13" text-anchor="middle">with --native</text>
  <g stroke-width="1.4">
    <rect x="40" y="66" width="286" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="40" y="98" width="286" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="414" y="66" width="286" height="26" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="414" y="98" width="286" height="26" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="414" y="130" width="286" height="26" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="414" y="162" width="286" height="26" fill="#ffffff" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="11.5">
    <text x="50" y="84">numpy/core/multiarray — 5.4 GB</text>
    <text x="50" y="116">pipeline/process.py — 0.4 GB</text>
    <text x="424" y="84">lasreader.py:212 laspy.read — 2.41 GB</text>
    <text x="424" y="116">process.py:84 column_stack — 0.96 GB</text>
    <text x="424" y="148">process.py:91 astype(float64) — 0.96 GB</text>
    <text x="424" y="180">process.py:103 mask indexing — 0.50 GB</text>
  </g>
  <text x="183" y="204" fill="#b0413e" font-size="12" text-anchor="middle">identifies nothing actionable</text>
  <text x="557" y="204" fill="#1f2937" font-size="12" text-anchor="middle">four lines to fix, with line numbers</text>
</svg>
<figcaption>Native tracking is the difference between "NumPy used 5.4 GB" and four specific lines to change.</figcaption>
</figure>

### 2. Distinguish the high watermark from a leak

```python
def peak_vs_leak(trace):
    """memray reports both; they are different problems with different fixes."""
    peak = subprocess.run(["memray", "summary", "--json", trace],
                          capture_output=True, text=True, check=True)
    leaks = subprocess.run(["memray", "summary", "--leaks", "--json", trace],
                           capture_output=True, text=True, check=True)
    peak_rows = json.loads(peak.stdout).get("allocations", [])
    leak_rows = json.loads(leaks.stdout).get("allocations", [])

    def top(rows, n=5):
        return [{"location": r.get("location", "?"),
                 "size_gb": round(r.get("size", 0) / 1e9, 3),
                 "count": int(r.get("count", 0))}
                for r in sorted(rows, key=lambda r: -r.get("size", 0))[:n]]

    peak_total = sum(r.get("size", 0) for r in peak_rows)
    leak_total = sum(r.get("size", 0) for r in leak_rows)
    return {
        "peak_gb": round(peak_total / 1e9, 2),
        "still_allocated_at_exit_gb": round(leak_total / 1e9, 2),
        "leak_share": round(leak_total / max(peak_total, 1), 4),
        "top_at_peak": top(peak_rows),
        "top_still_allocated": top(leak_rows),
        "diagnosis": (
            "a genuine leak: most of the peak is still held at exit — look for a "
            "cache, a module-level list, or a closure holding arrays"
            if leak_total > peak_total * 0.5 else
            "a high watermark, not a leak: memory is freed but the peak is too high "
            "— look for simultaneous temporaries"),
    }
```

The distinction decides where to look. A **high watermark** means the pipeline holds several large arrays at the same moment and then frees them, so the fix is to avoid holding them simultaneously. A **leak** means memory is still held at exit, so the fix is to find what holds the reference.

In point-cloud pipelines the high watermark is far more common, and it is regularly misdiagnosed as a leak because the process's resident memory never comes back down — which is usually the allocator retaining freed pages rather than a leak.

memray's `--leaks` mode reports what was still allocated when the trace ended, which for a clean exit should be close to zero apart from the returned result. A leak share above about 0.5 is a real reference-holding bug.

### 3. Find the temporary copies

```python
import laspy
import numpy as np

def read_points_wasteful(path):
    """Five full-size temporaries: the version people write first."""
    las = laspy.read(path)                         # 1: every dimension, not just xyz
    x = np.asarray(las.x)                          # 2: scaled float64 copy
    y = np.asarray(las.y)
    z = np.asarray(las.z)
    points = np.column_stack([x, y, z])            # 3: another full copy
    points = points.astype(np.float64)             # 4: float64 to float64, a no-op copy
    classification = np.asarray(las.classification)
    mask = classification == 2
    return points[mask]                            # 5: fancy-index copy

def read_points_lean(path, chunk=5_000_000, origin=None):
    """Chunked, filtered before conversion, float32 relative to an origin."""
    kept = []
    with laspy.open(path) as reader:
        if origin is None:
            header = reader.header
            origin = np.floor(np.array([header.mins[0], header.mins[1],
                                        header.mins[2]]))
        for block in reader.chunk_iterator(chunk):
            mask = block.classification == 2
            if not mask.any():
                continue
            xs = block.x[mask] - origin[0]
            ys = block.y[mask] - origin[1]
            zs = block.z[mask] - origin[2]
            kept.append(np.column_stack([xs, ys, zs]).astype(np.float32, copy=False))
    if not kept:
        return np.zeros((0, 3), dtype=np.float32), origin
    return np.concatenate(kept, axis=0), origin

def copy_audit(n_points, dtype_in=np.float64, dtype_out=np.float32,
               simultaneous=4.2):
    """Predict the peak from the number of simultaneous full-size arrays."""
    bytes_in = np.dtype(dtype_in).itemsize
    bytes_out = np.dtype(dtype_out).itemsize
    single_xyz = n_points * 3 * bytes_in
    lean = n_points * 3 * bytes_out * 1.15
    return {
        "points": n_points,
        "one_xyz_array_gb": round(single_xyz / 1e9, 2),
        "wasteful_peak_gb": round(single_xyz * simultaneous / 1e9, 2),
        "lean_peak_gb": round(lean / 1e9, 2),
        "ratio": round(single_xyz * simultaneous / max(lean, 1), 1),
        "note": "column_stack, astype and boolean indexing each allocate a full copy "
                "that lives until the name is rebound",
    }

print(copy_audit(400_000_000))
```

The five numbered allocations in `read_points_wasteful` are the whole problem, and each is a line people write without thinking. `laspy.read` loads every dimension including intensity, return number and GPS time; `np.asarray(las.x)` materialises the scaled float64 coordinates; `column_stack` copies them again; `astype(np.float64)` copies float64 to float64 for nothing; and the boolean index copies the survivors.

At 400 million points one xyz array in float64 is 9.6 GB, so holding four simultaneously is 38 GB — and adding PDAL's own buffers and the classification array is how a run reaches 90.

The lean version reads in chunks, filters before converting, subtracts a tile origin and narrows to float32. The predicted ratio of about 13× is what the profile in step 6 confirms.

### 4. Attribute memory per pipeline stage

```python
import memray

def profile_stages(input_path, out_dir="build/profile"):
    """A separate trace per stage, so each stage's peak is attributable."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    stages, data, origin = {}, None, None

    def stage(name, fn):
        nonlocal data
        trace = Path(out_dir) / f"{name}.bin"
        trace.unlink(missing_ok=True)
        with memray.Tracker(str(trace), native_traces=True):
            data = fn(data)
        stats = read_stats(str(trace))
        output_gb = round(getattr(data, "nbytes", 0) / 1e9, 3)
        stages[name] = {
            "peak_gb": stats["peak_gb"],
            "allocations": stats["total_allocations"],
            "churn_ratio": stats["churn_ratio"],
            "output_gb": output_gb,
            "overhead_ratio": round(stats["peak_gb"] / max(output_gb, 1e-9), 1),
        }

    stage("read", lambda _: read_points_lean(input_path)[0])
    stage("classify", lambda points: classify_ground(points))
    stage("thin", lambda points: voxel_thin(points, 1.0))
    stage("mesh", lambda points: delaunay_mesh(points))

    worst = max(stages.items(), key=lambda kv: kv[1]["peak_gb"])
    return {
        "stages": stages,
        "pipeline_peak_gb": max(s["peak_gb"] for s in stages.values()),
        "worst_stage": worst[0],
        "worst_overhead_ratio": worst[1]["overhead_ratio"],
        "note": "overhead_ratio is peak memory divided by the stage's output size; "
                "anything above 3 has temporaries worth removing",
    }
```

Using `memray.Tracker` as a context manager per stage, rather than one trace for the whole run, is what makes the attribution clean. A single trace over the whole pipeline shows the global peak and merges call paths that happened at different times, which makes it hard to say which stage caused it.

The **overhead ratio** is the metric to hold a stage to: peak memory divided by the size of what the stage produces. A thinning stage that outputs 240 MB and peaks at 4.8 GB has a ratio of 20, and all of that is temporaries.

Chaining the stages through `data` means each stage's trace includes the input it was handed, which is correct — that memory is genuinely resident during the stage.

<figure class="diagram">
<svg viewBox="9 9 695 249" role="img" aria-labelledby="memray-copies-t memray-copies-d" xmlns="http://www.w3.org/2000/svg">
  <title id="memray-copies-t">Simultaneous temporaries at the peak</title>
  <desc id="memray-copies-d">A timeline of resident memory through the wasteful read of 40 million points. The laspy read holds 2.4 gigabytes of all dimensions. Converting x, y and z to float64 arrays brings the total to 3.4. Column-stack brings it to 4.3 while the three arrays are still alive. The redundant astype brings it to the 5.8 gigabyte peak. Boolean indexing then drops it to 5.3, and the returned output is 0.24 gigabytes. Nothing leaks; four full-size arrays simply coexist.</desc>
  <rect class="svg-bg" x="9" y="9" width="695" height="249" fill="#ffffff"/>
  <path d="M60 196 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M60 30 V196" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.4">
    <rect x="76" y="140" width="94" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="180" y="108" width="94" height="88" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="284" y="76" width="94" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="388" y="44" width="94" height="152" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="492" y="60" width="94" height="136" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="596" y="182" width="94" height="14" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="123" y="132">2.4 GB</text>
    <text x="227" y="100">3.4 GB</text>
    <text x="331" y="68">4.3 GB</text>
    <text x="435" y="36">5.8 GB</text>
    <text x="539" y="52">5.3 GB</text>
    <text x="643" y="174">0.24 GB</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="123" y="214">laspy.read</text>
    <text x="227" y="214">asarray x,y,z</text>
    <text x="331" y="214">column_stack</text>
    <text x="435" y="214">astype</text>
    <text x="539" y="214">mask index</text>
    <text x="643" y="214">return</text>
  </g>
  <text x="380" y="240" fill="#1f2937" font-size="12.5" text-anchor="middle">the peak is 24× the output because four full-size arrays are alive at once</text>
  <text x="34" y="110" fill="#5b6471" font-size="12" text-anchor="middle">RSS</text>
</svg>
<figcaption>Nothing leaks; the peak is four full-size arrays coexisting, and the output is a twenty-fourth of it.</figcaption>
</figure>

### 5. Set a budget and enforce it

```python
BUDGET = {
    "peak_gb_per_million_points": 0.03,     # measured, not aspirational
    "max_overhead_ratio": 3.0,
    "max_churn_ratio": 8.0,
    "max_leak_share": 0.05,
}

def memory_gate(stage_report, leak_report, point_count, budget=BUDGET):
    findings = []
    millions = max(point_count / 1e6, 1e-9)
    per_million = stage_report["pipeline_peak_gb"] / millions

    if per_million > budget["peak_gb_per_million_points"]:
        findings.append({
            "severity": "error",
            "issue": f"{per_million:.4f} GB per million points, above the "
                     f"{budget['peak_gb_per_million_points']} GB budget",
            "implication": f"a 400 M-point tile would need {per_million * 400:.0f} GB",
        })
    for name, stage in stage_report["stages"].items():
        if stage["overhead_ratio"] > budget["max_overhead_ratio"]:
            findings.append({
                "severity": "warn",
                "issue": f"stage '{name}' peaks at {stage['overhead_ratio']}× its "
                         f"output size",
                "implication": "look for column_stack, astype and boolean indexing "
                               "on full-size arrays",
            })
        if stage["churn_ratio"] > budget["max_churn_ratio"]:
            findings.append({
                "severity": "warn",
                "issue": f"stage '{name}' allocates {stage['churn_ratio']}× its peak",
                "implication": "repeated temporaries in a loop — preallocate or "
                               "operate in place",
            })
    if leak_report["leak_share"] > budget["max_leak_share"]:
        findings.append({
            "severity": "error",
            "issue": f"{leak_report['leak_share']:.1%} of the peak is still held at exit",
            "implication": leak_report["diagnosis"],
        })

    errors = [f for f in findings if f["severity"] == "error"]
    return {
        "point_count": point_count,
        "peak_gb": stage_report["pipeline_peak_gb"],
        "gb_per_million_points": round(per_million, 4),
        "projected_for_400m_gb": round(per_million * 400, 1),
        "findings": findings,
        "errors": len(errors),
        "pass": not errors,
    }
```

Expressing the budget **per million points** is what makes a profile on a small tile predictive. Profiling a 400-million-point run needs a 90 GB machine; profiling a 20-million-point extract needs 4 GB, and the per-million figure projects to the full tile — which is the only practical way to work on this.

The projection is also the finding that gets action. "0.22 GB per million points, so a 400 M-point tile needs 88 GB" is a statement about next month's delivery; "the peak was 4.4 GB" is not.

Keeping the overhead and churn ratios as warnings is right: they are optimisation findings, and a stage with a ratio of 4 that fits the budget is acceptable.

### 6. Verify the fix on the same input

```python
def before_after(input_path, out_dir="build/profile"):
    results = {}
    for label, fn in (("wasteful", lambda p: read_points_wasteful(p)),
                      ("lean", lambda p: read_points_lean(p)[0])):
        trace = Path(out_dir) / f"{label}.bin"
        trace.unlink(missing_ok=True)
        with memray.Tracker(str(trace), native_traces=True):
            out = fn(input_path)
        stats = read_stats(str(trace))
        results[label] = {
            "peak_gb": stats["peak_gb"],
            "allocations": stats["total_allocations"],
            "total_allocated_gb": stats["total_allocated_gb"],
            "churn_ratio": stats["churn_ratio"],
            "output_points": int(len(out)),
            "output_gb": round(out.nbytes / 1e9, 3),
            "output_dtype": str(out.dtype),
        }
    w, l = results["wasteful"], results["lean"]
    return {
        "results": results,
        "peak_reduction": round(w["peak_gb"] / max(l["peak_gb"], 1e-9), 1),
        "allocation_reduction": round(w["allocations"] / max(l["allocations"], 1), 1),
        "same_point_count": w["output_points"] == l["output_points"],
        "dtype_changed": w["output_dtype"] != l["output_dtype"],
        "verdict": ("fix confirmed"
                    if w["output_points"] == l["output_points"]
                    and l["peak_gb"] < w["peak_gb"] * 0.5
                    else "point counts differ — the two versions are not equivalent"),
    }
```

`same_point_count` is the assertion that keeps this honest. A memory "fix" that drops points is not a fix, and chunked reading with a filter is exactly the change that can silently lose a partial final chunk.

`dtype_changed` being true is expected and must be deliberate: float32 coordinates *relative to a tile origin* are accurate to about a micrometre at a kilometre, which is fine, while float32 *absolute* UTM coordinates quantise to about 6 cm, which is not. That is why `read_points_lean` subtracts an origin before narrowing, and the reasoning is the same as in [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/).

<figure class="diagram">
<svg viewBox="4 6 732 240" role="img" aria-labelledby="memray-budget-t memray-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="memray-budget-t">Per-stage peak against output size</title>
  <desc id="memray-budget-d">A table of four pipeline stages with their peak memory, output size and overhead ratio. The read stage peaks at 0.44 gigabytes for a 0.245 gigabyte output, a ratio of 1.8, which is good. Classification peaks at 1.1 for 0.31, a ratio of 3.5, marginal. Thinning peaks at 0.62 for 0.06, a ratio of 10.3, which needs work. Meshing peaks at 3.8 for 1.2, a ratio of 3.2. The pipeline peak of 3.8 gigabytes comes from the meshing stage, but the worst overhead is in thinning.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="168" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="298" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="428" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="558" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="150" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="52" width="130" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="298" y="52" width="130" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="428" y="52" width="130" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="558" y="52" width="164" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="84" width="150" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="168" y="84" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="298" y="84" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="428" y="84" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="558" y="84" width="164" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="116" width="150" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="168" y="116" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="298" y="116" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="428" y="116" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="558" y="116" width="164" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="148" width="150" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="168" y="148" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="298" y="148" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="428" y="148" width="130" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="558" y="148" width="164" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="93" y="41">stage</text><text x="233" y="41">peak</text>
    <text x="363" y="41">output</text><text x="493" y="41">overhead</text>
    <text x="640" y="41">verdict</text>
    <text x="93" y="73">read</text><text x="233" y="73">0.44 GB</text>
    <text x="363" y="73">0.245 GB</text><text x="493" y="73">1.8×</text>
    <text x="640" y="73">good</text>
    <text x="93" y="105">classify</text><text x="233" y="105">1.10 GB</text>
    <text x="363" y="105">0.310 GB</text><text x="493" y="105">3.5×</text>
    <text x="640" y="105">marginal</text>
    <text x="93" y="137">thin</text><text x="233" y="137">0.62 GB</text>
    <text x="363" y="137">0.060 GB</text><text x="493" y="137">10.3×</text>
    <text x="640" y="137">worst overhead</text>
    <text x="93" y="169">mesh</text><text x="233" y="169">3.80 GB</text>
    <text x="363" y="169">1.200 GB</text><text x="493" y="169">3.2×</text>
    <text x="640" y="169">sets the peak</text>
  </g>
  <text x="370" y="208" fill="#1f2937" font-size="12.5" text-anchor="middle">the pipeline's peak comes from meshing; the worst waste is in thinning</text>
  <text x="370" y="228" fill="#5b6471" font-size="12" text-anchor="middle">budget the peak per stage, and fix the ratio where it is highest</text>
</svg>
<figcaption>The stage that sets the peak and the stage with the worst overhead are different, which is why both numbers belong in the report.</figcaption>
</figure>

## Expected Output & Verification

```text
{'returncode': 0, 'trace': 'build/profile/trace.bin',
 'flags': {'native': True, 'follow_fork': True, 'trace_python_allocators': False}}
{'peak_bytes': 5841204118, 'peak_gb': 5.84, 'total_allocations': 184102,
 'total_allocated_gb': 24.18, 'churn_ratio': 4.1}
{
  "peak_gb": 5.84,
  "still_allocated_at_exit_gb": 0.24,
  "leak_share": 0.0411,
  "top_at_peak": [
    {"location": "lasreader.py:212 laspy.read", "size_gb": 2.41, "count": 1},
    {"location": "process.py:84 read_points_wasteful", "size_gb": 0.96, "count": 3},
    {"location": "process.py:91 read_points_wasteful", "size_gb": 0.96, "count": 1}
  ],
  "diagnosis": "a high watermark, not a leak: memory is freed but the peak is too high — look for simultaneous temporaries"
}
{'points': 400000000, 'one_xyz_array_gb': 9.6, 'wasteful_peak_gb': 40.32,
 'lean_peak_gb': 5.52, 'ratio': 7.3}
{
  "results": {
    "wasteful": {"peak_gb": 5.84, "allocations": 184102, "churn_ratio": 4.1,
                 "output_points": 20418204, "output_gb": 0.49,
                 "output_dtype": "float64"},
    "lean": {"peak_gb": 0.44, "allocations": 1284, "churn_ratio": 1.3,
             "output_points": 20418204, "output_gb": 0.245,
             "output_dtype": "float32"}
  },
  "peak_reduction": 13.3, "allocation_reduction": 143.4,
  "same_point_count": true, "dtype_changed": true,
  "verdict": "fix confirmed"
}
{'point_count': 40836408, 'peak_gb': 0.44, 'gb_per_million_points': 0.0108,
 'projected_for_400m_gb': 4.3, 'errors': 0, 'pass': true}
```

A 13.3× peak reduction with an identical point count is the result, and the projection is what matters operationally: 0.0108 GB per million points means a 400-million-point tile needs about 4.3 GB rather than the 88 GB the original code implied.

The `leak_share` of 4.1% is the returned array itself, still referenced when the trace ended, which is correct rather than a leak — and the diagnosis identifies the situation as a high watermark, which is where the fix was.

Verify the accuracy cost of the float32 change, because that is the one part of the fix that is not free:

```python
def precision_check(input_path, origin=None, tolerance_m=0.001):
    """float32 relative to a tile origin is fine; absolute UTM is not."""
    las = laspy.read(input_path)
    xyz64 = np.column_stack([np.asarray(las.x), np.asarray(las.y),
                             np.asarray(las.z)]).astype(np.float64)
    origin = np.asarray(origin if origin is not None
                        else np.floor(xyz64.min(axis=0)))

    absolute32 = xyz64.astype(np.float32).astype(np.float64)
    relative32 = (xyz64 - origin).astype(np.float32).astype(np.float64) + origin

    def error(candidate):
        d = np.linalg.norm(candidate - xyz64, axis=1)
        return {"mean_mm": round(float(d.mean()) * 1000, 4),
                "p95_mm": round(float(np.percentile(d, 95)) * 1000, 4),
                "max_mm": round(float(d.max()) * 1000, 4)}

    abs_err, rel_err = error(absolute32), error(relative32)
    return {
        "origin": [float(v) for v in origin],
        "absolute_float32": abs_err,
        "relative_to_origin_float32": rel_err,
        "absolute_acceptable": abs_err["max_mm"] / 1000 <= tolerance_m,
        "relative_acceptable": rel_err["max_mm"] / 1000 <= tolerance_m,
        "advice": "subtract a tile origin before narrowing to float32; absolute UTM "
                  "in float32 quantises to centimetres",
    }

print(json.dumps(precision_check("input/tile_32_598_6643.laz"), indent=2))
```

This is the check that makes the dtype change defensible. Absolute UTM eastings near 598,000 in float32 quantise to about 6 cm; the same coordinates relative to a tile origin quantise to under a micrometre. The memory saving is identical and only one of them is acceptable for survey data.

Then verify the projection is linear, because a super-linear stage makes a small-extract profile misleading:

```python
def scaled_validation(pipeline_fn, input_paths, out_dir="build/profile"):
    """Profile at three sizes and check that GB per million points is constant."""
    rows = []
    for path in sorted(input_paths, key=lambda p: Path(p).stat().st_size):
        trace = Path(out_dir) / f"scale_{Path(path).stem}.bin"
        trace.unlink(missing_ok=True)
        with memray.Tracker(str(trace), native_traces=True):
            pipeline_fn(path)
        stats = read_stats(str(trace))
        info = json.loads(subprocess.run(["pdal", "info", "--summary", str(path)],
                                         capture_output=True, text=True,
                                         check=True).stdout)["summary"]
        points = int(info["num_points"])
        rows.append({"input": Path(path).name,
                     "points_millions": round(points / 1e6, 1),
                     "peak_gb": stats["peak_gb"],
                     "gb_per_million": round(stats["peak_gb"]
                                             / max(points / 1e6, 1e-9), 4)})
    ratios = [r["gb_per_million"] for r in rows]
    return {
        "rows": rows,
        "gb_per_million_spread": round(max(ratios) / max(min(ratios), 1e-9), 2),
        "scales_linearly": max(ratios) / max(min(ratios), 1e-9) < 1.3,
        "note": "a spread above 1.3 means a stage is super-linear — usually a "
                "pairwise distance matrix or an unchunked sort",
    }
```

A per-million figure that grows with input size means a stage is super-linear, and the projection from a small extract will understate the full tile badly. The usual culprits are a pairwise distance computation or a sort that is not chunked, and both show up as a spread well above 1.3.

## Performance Notes

- **memray adds 10–40% runtime overhead** with `--native`, and more with `--trace-python-allocators`. Profile a reduced input rather than production scale.
- **The trace file grows with allocation count**, not with memory held. A pipeline with 50 million small allocations produces a multi-gigabyte trace; reduce the input rather than the tracking.
- **`--trace-python-allocators` is rarely needed** for array-heavy pipelines because the interesting allocations are native. Enable it when chasing a pure-Python object leak.
- **`memray tree` is faster to read than a flame graph** when a few large allocations dominate, which is the usual case here.
- **The high watermark is what the machine must fit**, so the peak is the number to budget rather than the total allocated.
- **Chunk size trades memory for speed.** Five million points per chunk is a good default: small enough to bound the peak, large enough that per-chunk overhead is negligible.

## Common Errors

**Everything is attributed to `numpy/core/multiarray`.** `--native` was omitted.

**The trace is empty.** The work happened in a forked child; add `--follow-fork`.

**`memray: command not found` inside a container.** memray is a separate install; add it to the image used for profiling, not to the production image.

**The peak is far lower than the observed memory.** A subprocess — `pdal` invoked via `subprocess` — is not traced. Profile the Python and measure the subprocess with `/usr/bin/time -v` separately.

**Resident memory never falls after the peak.** Usually the allocator retaining freed pages rather than a leak. Check `leak_share` before assuming.

**The flame graph blames a library, not your code.** memray attributes to the allocating frame; read one level up the stack and it is usually yours.

**`MemoryError` while profiling.** The overhead pushed a run that just fitted over the limit. Reduce the input.

## Frequently Asked Questions

### memray, tracemalloc or scalene?

memray, because the allocations are native. `tracemalloc` sees only Python-level allocations and misses essentially everything here. Scalene combines CPU and memory attribution well and is less precise on native peaks.

### Can I profile in production?

memray is usable in production and the overhead is real. A better pattern is to profile a reduced input in CI, enforce the per-million budget there, and use `resource.getrusage` in production for a cheap peak figure.

### What per-million-points budget is reasonable?

For a read-filter-write pipeline, 0.01–0.03 GB per million points. Anything building a KD-tree or a mesh is higher — a Delaunay triangulation is roughly 0.2 GB per million points — so the budget belongs per stage rather than per pipeline.

## Related Guides

- [Running PDAL Pipelines in Docker](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/running-pdal-pipelines-in-docker/) — the memory limit that turns a slow death into a fast failure
- [Voxel Downsampling Strategies Compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — the stage whose temporaries are largest
- [Testing Spatial Pipelines with pytest Fixtures](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/testing-spatial-pipelines-with-pytest-fixtures/) — where the memory budget gate belongs

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
