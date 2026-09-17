---
title: "Making Tile Output Deterministic"
description: "Get byte-identical tiles from identical inputs: pin versions, sort inputs, remove timestamps, fix float rounding and prove determinism with a double-build"
---
# Making Tile Output Deterministic

This page makes a tiling pipeline produce byte-identical output from identical inputs — pinning tool versions, sorting every input collection, removing embedded timestamps and hostnames, controlling floating-point rounding and thread non-determinism, and proving it with a double build that compares hashes, for a city tiled from EPSG:25832 into EPSG:4978.

## Why you hit this

Determinism sounds like a purity concern and is the foundation of three practical things. Incremental builds rely on it: if re-tiling an unchanged shard produces different bytes, the content hash changes, the CDN cache is invalidated and "incremental" means rebuilding the city. Caching relies on it, because an immutable URL whose content varies is a lie. And debugging relies on it — a difference between two builds is either a real change or noise, and a pipeline with noise cannot tell you which. The incremental machinery that depends on this is in [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`; the tiling pipeline itself and whatever encoders it calls.
- A container image for the build, or at least a lock file pinning every dependency.
- A shard whose inputs you can hold fixed, for the double-build test.

## Step-by-Step

### 1. Find the sources of non-determinism

```python
import hashlib
import json
import os
import subprocess
from pathlib import Path

def file_digest(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()

def tree_digests(root):
    return {str(p.relative_to(root)): file_digest(p)
            for p in sorted(Path(root).rglob("*")) if p.is_file()}

def diff_digests(a, b):
    keys = sorted(set(a) | set(b))
    return [{"path": k, "a": a.get(k, "missing")[:12], "b": b.get(k, "missing")[:12]}
            for k in keys if a.get(k) != b.get(k)]

first = tree_digests("build/run_a/shards/120210233010")
second = tree_digests("build/run_b/shards/120210233010")
differences = diff_digests(first, second)
print(f"{len(differences)} of {len(first)} files differ between two builds of the same shard")
for d in differences[:6]:
    print(f"  {d['path']:<32}{d['a']}  {d['b']}")
```

Running the same shard twice and diffing the hashes is the whole diagnostic. Almost every pipeline fails it the first time, and the files that differ point straight at the cause: a `tileset.json` that differs means a timestamp or a key order, a `.glb` that differs means the encoder or the geometry order, and a difference in every file means a tool version or a path baked into the output.

<figure class="diagram">
<svg viewBox="6 6 748 222" role="img" aria-labelledby="det-sources-t det-sources-d" xmlns="http://www.w3.org/2000/svg">
  <title id="det-sources-t">Where non-determinism comes from</title>
  <desc id="det-sources-d">A table of causes and the file each one changes. An embedded build timestamp changes the tileset JSON. Unsorted input order changes vertex order in the geometry file. Dictionary or set iteration changes JSON key order. Parallel reduction changes floating-point sums. A tool version change alters the encoded bytes. An absolute path recorded in metadata changes with the working directory.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="300" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="320" y="20" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="550" y="20" width="190" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="300" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="54" width="230" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="550" y="54" width="190" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="86" width="300" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="86" width="230" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="550" y="86" width="190" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="118" width="300" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="118" width="230" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="550" y="118" width="190" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="150" width="300" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="150" width="230" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="550" y="150" width="190" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="182" width="300" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="182" width="230" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="550" y="182" width="190" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="43">cause</text><text x="435" y="43">what changes</text><text x="645" y="43">fix</text>
    <text x="170" y="75">build timestamp in metadata</text><text x="435" y="75">tileset.json</text><text x="645" y="75">omit or pin it</text>
    <text x="170" y="107">unsorted input iteration</text><text x="435" y="107">vertex order in .glb</text><text x="645" y="107">sort by a stable key</text>
    <text x="170" y="139">dict or set iteration order</text><text x="435" y="139">JSON key order</text><text x="645" y="139">sort_keys=True</text>
    <text x="170" y="171">parallel float reduction</text><text x="435" y="171">bounding volumes</text><text x="645" y="171">fixed-order sums</text>
    <text x="170" y="203">tool version or path</text><text x="435" y="203">every encoded file</text><text x="645" y="203">pin the image</text>
  </g>
</svg>
<figcaption>Five causes, and the file that differs tells you which one you have before you read any code.</figcaption>
</figure>

### 2. Sort every input, by a key that cannot change

```python
def stable_feature_order(features):
    """Deterministic order: by identifier, which is stable across runs and deliveries."""
    return sorted(features, key=lambda f: (str(f["feature_id"]),))

def stable_shard_order(shard_keys):
    return sorted(shard_keys)                         # quadkeys sort lexicographically

def stable_file_list(root, pattern="*.laz"):
    return sorted(Path(root).glob(pattern), key=lambda p: p.name)
```

Filesystem iteration order is not defined — `Path.glob` and `os.listdir` return entries in whatever order the filesystem provides, which differs between ext4 and XFS, between a local disk and object storage, and sometimes between two runs on the same directory. Sorting by name is one call and removes the whole class of problem.

Sorting features by identifier rather than by position matters for a subtler reason: a spatial sort is stable only if the coordinates are identical, and a delivery that shifts one building by a millimetre reorders everything after it. An identifier sort survives that, so a shard whose contents did not change produces the same vertex order even when a neighbour moved.

### 3. Remove the timestamps and the environment

```python
def deterministic_tileset(root_tile, dataset_version, geometric_error):
    """No build time, no hostname, no absolute paths — only inputs."""
    return {
        "asset": {
            "version": "1.1",
            "tilesetVersion": dataset_version,          # the data's version, not the build's time
        },
        "geometricError": round(geometric_error, 6),
        "root": root_tile,
    }

def write_json_deterministic(path, obj):
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False)
    Path(path).write_text(text, encoding="utf-8", newline="\n")
    return file_digest(path)

def deterministic_zip(out_path, files):
    """A zip with fixed timestamps and order, for packaged outputs."""
    import zipfile
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for arcname, src in sorted(files.items()):
            info = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, Path(src).read_bytes())
    return file_digest(out_path)
```

`sort_keys=True` fixes JSON key order, which in CPython is insertion order and therefore depends on the code path that built the dictionary. `allow_nan=False` turns a NaN — which would serialise as the non-standard `NaN` token — into an error, which is better than a tileset that some parsers reject.

The version string is the substantive change: replacing a build timestamp with the *data's* version means two builds of the same data produce the same file, while a new delivery still changes it. Where a build time is genuinely needed, the standard approach is to honour `SOURCE_DATE_EPOCH` from the environment so a rebuild can reproduce an earlier one.

### 4. Control the arithmetic

```python
import numpy as np

def deterministic_bounds(points):
    """Min/max are exact; means and sums need a fixed reduction order."""
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    centre = (lo + hi) / 2.0                        # from extremes, not from a mean
    half = (hi - lo) / 2.0
    return np.round(centre, 6), np.round(half, 6)

def deterministic_mean(values):
    """Pairwise summation in a fixed order, independent of thread count."""
    v = np.sort(np.asarray(values, dtype=np.float64))   # sorting makes the order reproducible
    return float(v.sum() / len(v)) if len(v) else 0.0

def quantise(values, scale=1e-3):
    """Round to a fixed grid so tiny input differences cannot flip a rounding decision."""
    return np.round(np.asarray(values, dtype=np.float64) / scale).astype(np.int64) * scale
```

Floating-point addition is not associative, so a sum computed by four threads and a sum computed by one differ in the last bits, and a bounding volume derived from a mean differs between runs on machines with different core counts. Deriving the centre from the extremes avoids the reduction entirely. Where a mean is genuinely needed, sorting before summing makes the order reproducible at a small cost.

Quantising before writing is the other half. Two runs that compute a coordinate as `12.000000000000002` and `11.999999999999998` write different bytes unless the value is snapped to a grid first — and the grid is the tile's quantisation step anyway, so nothing is lost.

```python
def set_deterministic_env():
    """Environment variables that remove thread and hash non-determinism."""
    os.environ.setdefault("PYTHONHASHSEED", "0")
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                "NUMEXPR_NUM_THREADS", "GDAL_NUM_THREADS"):
        os.environ.setdefault(var, "1")
    os.environ.setdefault("SOURCE_DATE_EPOCH", "1758067200")
    return {k: os.environ[k] for k in ("PYTHONHASHSEED", "OMP_NUM_THREADS", "SOURCE_DATE_EPOCH")}

print(set_deterministic_env())
```

`PYTHONHASHSEED` matters because set iteration order depends on it, and a pipeline that iterates a set of feature identifiers anywhere produces a different order on every run. Setting the thread counts to one is a blunt instrument that guarantees reproducible reductions; the alternative is to keep threads and make every reduction order-independent, which is more work and faster.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="det-env-t det-env-d" xmlns="http://www.w3.org/2000/svg">
  <title id="det-env-t">Environment variables that decide whether a build repeats</title>
  <desc id="det-env-d">A table of four environment settings and what each one fixes. PYTHONHASHSEED set to zero fixes set and dictionary iteration order. The OpenMP and BLAS thread counts set to one fix the order of floating-point reductions. SOURCE_DATE_EPOCH fixes any timestamp a format requires. GDAL_NUM_THREADS set to one fixes raster block ordering. Each is one line and each removes a whole class of non-reproducible output.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="96" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="310" y="20" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="556" y="20" width="166" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="54" width="96" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="54" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="54" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="88" width="96" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="88" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="88" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="122" width="96" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="122" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="122" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="156" width="96" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="310" y="156" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="556" y="156" width="166" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="42">setting</text><text x="262" y="42">value</text><text x="433" y="42">what it fixes</text><text x="639" y="42">cost</text>
    <text x="116" y="76">PYTHONHASHSEED</text><text x="262" y="76">0</text><text x="433" y="76">set and dict iteration order</text><text x="639" y="76">none</text>
    <text x="116" y="110">OMP_NUM_THREADS</text><text x="262" y="110">1</text><text x="433" y="110">float reduction order</text><text x="639" y="110">single-threaded maths</text>
    <text x="116" y="144">SOURCE_DATE_EPOCH</text><text x="262" y="144">fixed</text><text x="433" y="144">timestamps a format demands</text><text x="639" y="144">none</text>
    <text x="116" y="178">GDAL_NUM_THREADS</text><text x="262" y="178">1</text><text x="433" y="178">raster block ordering</text><text x="639" y="178">slower raster I/O</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Four lines in the container's environment, and three of them cost nothing.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">The thread counts are the only trade: reproducible reductions against parallel speed.</text>
</svg>
<figcaption>The cheapest determinism available: four environment variables, set once in the build image.</figcaption>
</figure>

### 5. Record what produced the output

```python
def provenance(params, tool_versions, inputs):
    """Everything that affects the bytes, hashed into one value."""
    payload = {
        "params": params,
        "tools": tool_versions,
        "inputs": {name: file_digest(path) for name, path in sorted(inputs.items())},
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return {"provenance": payload,
            "provenance_hash": hashlib.sha256(canonical.encode()).hexdigest()}

TOOLS = {
    "python": subprocess.run(["python", "-VV"], capture_output=True, text=True).stdout.strip(),
    "tiler": "twin-tiler 4.2.1",
    "draco": "1.5.6",
    "gltf-transform": "4.0.1",
    "image": "ghcr.io/example/twin-tiler@sha256:3f0a…",
}
prov = provenance({"max_per_tile": 2000, "quantize_position": 14},
                  TOOLS, {"footprints": "source/footprints.gpkg"})
print(prov["provenance_hash"][:16], "…")
```

The provenance hash is what makes determinism useful rather than merely satisfying. Two tiles with the same provenance hash and different content hashes mean the pipeline is non-deterministic; the same content hash with a different provenance hash means something irrelevant changed. Storing it per shard turns the incremental build's "is this shard up to date?" into a comparison of two strings.

### 6. Prove it with a double build in CI

```python
def double_build_check(build_fn, shard, work_root="build/determinism"):
    digests = []
    for run in ("a", "b"):
        out = Path(work_root) / run
        if out.exists():
            import shutil
            shutil.rmtree(out)
        out.mkdir(parents=True)
        build_fn(shard, out)                        # the real pipeline, twice
        digests.append(tree_digests(out))
    diffs = diff_digests(*digests)
    return {"files": len(digests[0]), "differing": len(diffs), "deterministic": not diffs,
            "first_differences": diffs[:5]}

result = double_build_check(build_shard_to, "120210233010")
print(json.dumps(result, indent=2))
assert result["deterministic"], "tiling is not deterministic; see first_differences"
```

Running the check on one representative shard in CI, on every merge, is enough: non-determinism is almost never shard-specific, and one shard takes seconds. Adding a second shard with textures is worthwhile, because image encoders are a common source — several JPEG and Basis encoders embed a library version or vary with thread count.

<figure class="diagram">
<svg viewBox="6 20 748 194" role="img" aria-labelledby="det-loop-t det-loop-d" xmlns="http://www.w3.org/2000/svg">
  <title id="det-loop-t">The double-build check in CI</title>
  <desc id="det-loop-d">One shard is built twice from identical inputs in the same container image. The two output trees are hashed file by file and compared. Identical hashes pass the check. Any difference fails the build and names the first files that differ, which identifies the cause without further investigation.</desc>
  <rect class="svg-bg" x="6" y="20" width="748" height="194" fill="#ffffff"/>
  <defs>
    <marker id="det-loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="90" width="130" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="210" y="34" width="140" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="210" y="150" width="140" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="410" y="90" width="150" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="620" y="34" width="120" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="620" y="150" width="120" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#det-loop-arrow)">
    <path d="M150 106 L208 70"/><path d="M150 130 L208 168"/>
    <path d="M350 60 L408 100"/><path d="M350 176 L408 138"/>
    <path d="M560 106 L618 66"/><path d="M560 130 L618 170"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="112">fixed inputs</text><text x="85" y="132">+ pinned image</text>
    <text x="280" y="54">build run A</text><text x="280" y="72">output tree</text>
    <text x="280" y="170">build run B</text><text x="280" y="188">output tree</text>
    <text x="485" y="112">hash every file,</text><text x="485" y="132">compare</text>
    <text x="680" y="54">identical:</text><text x="680" y="72">pass</text>
    <text x="680" y="170">differs: fail,</text><text x="680" y="188">name the files</text>
  </g>
</svg>
<figcaption>A few seconds per merge, and the check that keeps every incremental build and every cache header honest.</figcaption>
</figure>

## Expected Output & Verification

```text
3 of 5 files differ between two builds of the same shard
  tileset.json                    a41f0c2b9e14  7d2e88b41c03
  content/0/0/0.glb               9b02c4e7f1aa  1c8e4470a9d2
  content/0/0/1.glb               44a1e0b9c83f  2fe70c1ab884
{'PYTHONHASHSEED': '0', 'OMP_NUM_THREADS': '1', 'SOURCE_DATE_EPOCH': '1758067200'}
c41d9f8a2b703e55 …
{
  "files": 5,
  "differing": 0,
  "deterministic": true,
  "first_differences": []
}
```

The first block is the before state and the last is the after. Three of five files differed: `tileset.json` from a build timestamp, and the two `.glb` files from unsorted feature iteration — which is the typical pair, and both are fixed by the changes above.

Verify that determinism survives the things that legitimately vary, which is the property that makes it useful:

```python
def determinism_matrix(build_fn, shard):
    """Same inputs must give the same bytes across worker counts and working directories."""
    import shutil
    cases = {
        "baseline": {"workers": 1, "cwd": "build/case_a"},
        "more_workers": {"workers": 8, "cwd": "build/case_b"},
        "other_cwd": {"workers": 1, "cwd": "build/case_c/nested/deeper"},
    }
    digests = {}
    for name, cfg in cases.items():
        out = Path(cfg["cwd"]) / "out"
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        build_fn(shard, out, workers=cfg["workers"])
        digests[name] = tree_digests(out)
    base = digests["baseline"]
    return {name: {"identical": d == base, "differing": len(diff_digests(base, d))}
            for name, d in digests.items()}

print(json.dumps(determinism_matrix(build_shard_to, "120210233010"), indent=2))
```

Worker count and working directory are the two variables that differ between a developer's laptop and the build server, so a pipeline that is deterministic only at one worker count will still produce cache-invalidating output in production. Testing the matrix rather than a single repeat is what catches the parallel-reduction and absolute-path cases.

Then verify that a *real* change does change the bytes, which is the other half of the contract:

```python
def change_detection_check(build_fn, shard, out_root="build/change"):
    base = Path(out_root) / "base"; base.mkdir(parents=True, exist_ok=True)
    build_fn(shard, base)
    moved = Path(out_root) / "moved"; moved.mkdir(parents=True, exist_ok=True)
    build_fn(shard, moved, nudge_one_building_m=0.02)      # 2 cm on one building
    diffs = diff_digests(tree_digests(base), tree_digests(moved))
    return {"differing_files": len(diffs), "detects_change": len(diffs) > 0}

print(change_detection_check(build_shard_to, "120210233010"))
```

A pipeline so aggressively quantised that a 2 cm move produces identical bytes is deterministic and useless, because the incremental build will never notice the change. The quantisation grid has to be finer than the smallest change the twin must reflect.

## Performance Notes

- **Determinism costs a few percent**, almost all of it in sorting inputs and in single-threaded reductions. On a city job that is minutes against hours, and it is repaid the first time an incremental build skips 4,000 unchanged shards.
- **Sorting is cheap; re-sorting is not.** Sort once, at the point the collection is formed, and keep the order through the pipeline.
- **Single-threaded native libraries are the expensive part.** Where a stage is reduction-heavy, prefer an order-independent algorithm over disabling threads.
- **Hash with `sha256` and be done.** Hashing a 1 MB tile takes microseconds, and a faster non-cryptographic hash saves nothing measurable while making collisions a conversation.
- **Run the double-build check on one shard**, not the city. It is a property of the code, not of the data.

## Common Errors

**Only the tileset JSON differs.** A timestamp, a hostname or a key order. The three fixes in step 3 cover all of them.

**Only the compressed geometry differs.** The encoder is non-deterministic, or its version changed. Pin the encoder in the image and check whether it has a deterministic flag; several accept a fixed random seed.

**Output differs between the laptop and CI but not between two CI runs.** An absolute path, a locale, or a different library build. The pinned image removes all three, which is why the double build must run in the same image the pipeline uses.

**Everything is identical and the incremental build still rebuilds everything.** The provenance hash includes something that changes per run — a build timestamp, a run identifier, an absolute path. It should contain only inputs, parameters and tool versions.

**A textured tile is deterministic on one machine and not another.** Image encoders vary with SIMD availability. Either pin the encoder's instruction-set level or accept per-machine variation and always build on one class of runner.

## Frequently Asked Questions

### Is bit-for-bit determinism necessary, or is "semantically equal" enough?

For caching and incremental builds it must be bit-for-bit, because the comparison is a hash. For validation, semantic equality is enough — and a pipeline that can only manage the second cannot have immutable URLs.

### What about `SOURCE_DATE_EPOCH`?

It is the reproducible-builds convention for injecting a fixed timestamp, and honouring it is the right way to keep a build time in the output without losing determinism. Any format with a mandatory timestamp field — zip archives, some image containers — should read it.

### Does quantisation hide real changes?

It can, which is why the change-detection check exists. Choose the grid from the smallest change the twin must reflect — a centimetre for building geometry — and verify that a change at that scale alters the bytes.

## Related Guides

- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — what determinism makes possible
- [Resuming Failed Tiling Runs from Checkpoints](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/resuming-failed-tiling-runs-from-checkpoints/) — the manifest that records the hashes
- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — the caching contract this underwrites

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
