---
title: "glTF LOD Generation With Draco Compression"
description: "Build discrete glTF LOD chains and compress them with KHR_draco_mesh_compression: QEM decimation in trimesh, measured geometricError, quantization bits, gltf-transform, EPSG:4978."
---
# Generating Discrete glTF LOD Chains and Compressing Them With Draco

A single full-resolution building glTF is fine to download once; a city of them is not. The way 3D Tiles keeps a metropolitan twin interactive is to ship each feature as a short chain of discrete glTF levels of detail — a full-resolution mesh at the leaf and a few progressively coarser versions above it — and then to compress every one of those meshes with [Draco](https://google.github.io/draco/) so the bytes on the wire shrink by an order of magnitude without changing the vertex layout the renderer expects. This page is a runnable workflow for exactly that: producing per-level meshes with quadric edge-collapse in `trimesh`, measuring the real `geometricError` each level introduces, encoding each glTF with `KHR_draco_mesh_compression` through the `gltf-transform` CLI, choosing quantization bits that hold sub-centimetre positions, and verifying `extensionsUsed` before the meshes are wrapped as `b3dm` tiles. Geometry here is authored in a local East-North-Up (ENU) metric frame and placed onto the globe by a root transform into **EPSG:4978** (geocentric WGS84, metres) — the frame CesiumJS renders in. This is the encoding half of [LOD management](https://www.3d-geospatial.com/lod-management-optimization-strategies/); the decimation theory behind step 2 lives in [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) and is not repeated here.

## Prerequisites

Pin every component. Draco is a native codec wrapped by several tools, and a mismatch between the encoder that wrote a mesh and the decoder that reads it is a silent corruption, not a loud error. The combinations below are tested together.

| Component | Pinned version | Purpose |
|-----------|----------------|---------|
| Python | 3.10–3.12 | Orchestration, geometry math, subprocess control |
| `trimesh` | 4.4+ | Mesh load, QEM decimation, surface sampling for error |
| `numpy` | 1.26+ | Error arrays, bounding-box math, transform assembly |
| `pyproj` | 3.6+ | Local anchor → EPSG:4979 → EPSG:4978 placement |
| `gltf-transform` (CLI) | 4.0+ (Node 18+) | glTF Draco encode, quantization bit control, inspect |
| `3d-tiles-tools` | 0.4+ (Node 18+) | glTF → `b3dm`, tileset packaging |
| `3d-tiles-validator` | 0.5+ | Schema + extension validation of the tileset |

**Input formats.** Author each feature as a `.glb` (glTF 2.0 binary) or `.ply`/`.obj` that `trimesh` can load with vertex positions, and — where textured — a `TEXCOORD_0` attribute and material. Draco compresses `POSITION`, `TEXCOORD_0`, `NORMAL`, `COLOR_0`, and generic attributes; whatever you want quantized must exist on the primitive before encoding. Meshes must be winding-consistent, or coarse LODs develop shading seams that Draco quantization then bakes in permanently.

**Coordinate reference system — state it, never infer.** Vertices are authored in a **local ENU frame in metres**, with the mesh centred near its own origin so that float32 positions keep their precision (full projected eastings such as EPSG:25832 would waste mantissa bits on the six-figure integer part). The feature is placed onto the WGS84 ellipsoid by the root tile's 4×4 `transform`, which maps that ENU frame into **EPSG:4978 (ECEF)**. The anchor point is computed from the dataset's projected CRS (for a central-European twin, EPSG:25832) through **EPSG:4979 (geographic 3D)** so the vertical datum is handled, then into EPSG:4978. Keeping geometry local and delegating georeferencing to the transform is also what makes Draco quantization predictable: positional error scales with the mesh bounding-box extent, not with an absolute ECEF coordinate in the millions of metres. That relationship is the whole subject of [tuning Draco quantization for building meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/).

## Concept

A discrete LOD chain is an ordered list of independent meshes of the same feature: `LOD0` at full resolution, then `LOD1`, `LOD2`, … each with fewer triangles. It is not progressive mesh streaming — every level is a complete, standalone glTF, which is what 3D Tiles refinement expects, because the runtime swaps whole tiles rather than reconstructing detail incrementally. Each level carries a `geometricError`: the world-space distance in metres between that simplified mesh and the full-resolution source. The renderer projects that error through the camera and refines only when the on-screen error exceeds its budget, so the number must be *measured* per level, never guessed.

Draco is orthogonal to the LOD chain. It compresses one mesh by quantizing each attribute to a fixed number of integer bits over that attribute's range, then entropy-coding the connectivity with the edgebreaker algorithm. Quantization is the only lossy step and the only one that touches accuracy: a POSITION quantized to `n` bits across a bounding box of extent `E` metres carries a worst-case positional error of about `E / 2^n`. For a 30 m building at 14 bits that is roughly 30 / 16384 ≈ 1.8 mm — invisible — while the connectivity coding is lossless. So the two dials are separate: decimation sets how many triangles a level has (and its `geometricError`), and Draco quantization sets how many bytes those triangles cost (and a sub-millimetre floor under the position error). You choose the triangle budget for the screen-space footprint and the quantization bits for the accuracy tolerance, then measure both.

<figure class="diagram">
<svg viewBox="16 41 788 282" role="img" aria-labelledby="gld-chain-t gld-chain-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gld-chain-t">glTF LOD chain with Draco payloads shrinking per level</title>
  <desc id="gld-chain-d">A full-resolution LOD0 mesh is quadric-decimated into LOD1 and LOD2 with falling triangle counts and rising geometricError, and each level is Draco-compressed into a b3dm payload whose byte size shrinks from megabytes to kilobytes.</desc>
  <rect class="svg-bg" x="16" y="41" width="788" height="282" fill="#ffffff"/>
  <defs>
    <marker id="gld-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="30" y="55" width="200" height="72" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="310" y="55" width="200" height="72" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="590" y="55" width="200" height="72" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#gld-arrow)">
    <line x1="230" y1="91" x2="308" y2="91"/>
    <line x1="510" y1="91" x2="588" y2="91"/>
    <line x1="130" y1="127" x2="130" y2="213"/>
    <line x1="410" y1="127" x2="410" y2="213"/>
    <line x1="690" y1="127" x2="690" y2="213"/>
  </g>
  <rect x="30" y="215" width="200" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="310" y="215" width="200" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="590" y="215" width="200" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g font-size="13" text-anchor="middle">
    <text x="130" y="84" fill="#15384a">LOD 0 · 180k tris</text>
    <text x="130" y="105" fill="#1f2937">geometricError 0.0 m</text>
    <text x="410" y="84" fill="#15384a">LOD 1 · 40k tris</text>
    <text x="410" y="105" fill="#1f2937">geometricError 0.35 m</text>
    <text x="690" y="84" fill="#15384a">LOD 2 · 9k tris</text>
    <text x="690" y="105" fill="#1f2937">geometricError 1.40 m</text>
    <text x="130" y="241" fill="#1f2937">Draco b3dm</text>
    <text x="130" y="261" fill="#c46a3d">2.9 MB</text>
    <text x="410" y="241" fill="#1f2937">Draco b3dm</text>
    <text x="410" y="261" fill="#c46a3d">0.72 MB</text>
    <text x="690" y="241" fill="#1f2937">Draco b3dm</text>
    <text x="690" y="261" fill="#c46a3d">0.17 MB</text>
  </g>
  <text x="410" y="305" fill="#5b6471" font-size="12" text-anchor="middle">POSITION 14 bit · TEXCOORD 12 · NORMAL 10 — authored in local ENU metres, placed to EPSG:4978</text>
</svg>
<figcaption>Each level is an independent decimation with a measured geometricError; Draco quantization then shrinks the byte payload per level while holding sub-centimetre positions.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow takes one authored `.glb` per feature, produces a three-level chain, measures each level's error, Draco-encodes each level with explicit quantization bits, verifies the extension landed, and hands the results to the tiling step. Every stage is idempotent and drops into CI.

### 1. Fix the ENU frame and the ECEF placement

Do not bake the ellipsoid position into vertices. Author geometry around a local origin in metres and compute the root transform once, so all LODs share the same placement and Draco quantization sees a small, stable bounding box.

```python
import numpy as np
from pyproj import Transformer

# Dataset anchor in a projected metric CRS (ETRS89 / UTM 32N, EPSG:25832).
# Go via geographic-3D EPSG:4979 so ellipsoidal height is handled, then to ECEF.
to_geographic = Transformer.from_crs("EPSG:25832", "EPSG:4979", always_xy=True)
to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)

anchor_e, anchor_n, anchor_h = 691_500.0, 5_335_800.0, 519.0   # EPSG:25832 metres
lon, lat, h = to_geographic.transform(anchor_e, anchor_n, anchor_h)
cx, cy, cz = to_ecef.transform(lon, lat, h)

def enu_to_ecef_transform(lon_deg, lat_deg, x, y, z):
    """Column-major 4x4 ENU -> ECEF (EPSG:4978) transform for the root tile."""
    lo, la = np.radians(lon_deg), np.radians(lat_deg)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    m = np.identity(4)
    m[:3, 0], m[:3, 1], m[:3, 2] = east, north, up
    m[:3, 3] = [x, y, z]
    return m.flatten(order="F").tolist()          # column-major for tileset.json

root_transform = enu_to_ecef_transform(lon, lat, cx, cy, cz)
assert len(root_transform) == 16
```

### 2. Generate the discrete LOD chain with QEM

Decimate the source once per level with quadric edge-collapse, always from the original mesh — chaining decimations compounds error. `trimesh.simplify_quadric_decimation` wraps a fast QEM implementation and takes an absolute `face_count`, which keeps a heterogeneous batch of buildings on uniform budgets. The algorithmic detail (boundary weighting, degeneracy fallback) belongs to [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/); here we only need the chain of meshes.

```python
import trimesh
from pathlib import Path

def build_lod_chain(source_path, budgets=(40_000, 9_000)):
    """LOD0 = source; each further level is one QEM pass from the source."""
    source = trimesh.load(source_path, force="mesh", process=False)
    assert source.is_winding_consistent, f"{source_path}: inconsistent winding"
    chain = {"LOD0": source}
    for i, face_count in enumerate(budgets, start=1):
        if face_count >= len(source.faces):
            chain[f"LOD{i}"] = source
            continue
        chain[f"LOD{i}"] = source.simplify_quadric_decimation(face_count=face_count)
    return chain

chain = build_lod_chain(Path("building_enu.glb"))
for name, m in chain.items():
    print(f"{name}: {len(m.faces):,} faces")
```

### 3. Measure geometricError per level

Sample the source surface densely and take the nearest-surface distance from those samples to each decimated level. Report the 99th percentile, which is robust to a single bad collapse while still bounding the visible artefact. LOD0 is the source, so its error is exactly 0.

```python
import numpy as np

def geometric_error(source, simplified, n_samples=40_000):
    if simplified is source:
        return 0.0
    samples, _ = trimesh.sample.sample_surface(source, n_samples)
    _, dist, _ = simplified.nearest.on_surface(samples)
    return float(np.percentile(dist, 99))          # metres, in the ENU frame

source = chain["LOD0"]
errors = {name: geometric_error(source, m) for name, m in chain.items()}
for name, ge in errors.items():
    print(f"{name}: geometricError {ge:.3f} m")
# e.g. LOD0 0.000, LOD1 0.35x, LOD2 1.4x  -> monotonic INCREASE toward coarser levels
```

### 4. Export each LOD to a standalone glTF

Write each level to its own `.glb` before Draco encoding. `trimesh` exports glTF 2.0 with positions, normals, and (when present) texture coordinates and materials intact — exactly the attributes Draco will quantize.

```python
def export_levels(chain, out_dir):
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, mesh in chain.items():
        p = out_dir / f"building_{name}.glb"
        mesh.export(p)                             # glTF 2.0 binary, uncompressed
        paths[name] = p
    return paths

raw_paths = export_levels(chain, "lods_raw")
```

### 5. Draco-compress with explicit quantization bits

Drive `gltf-transform draco` through `subprocess`, setting the per-attribute quantization bits explicitly rather than accepting defaults. Positions get 14 bits (sub-centimetre on a building-sized box), texture coordinates 12, normals 10 — the accuracy/size tradeoff is quantified in the [quantization tuning guide](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/). The `edgebreaker` method gives the smallest connectivity payload for closed manifold meshes.

```python
import subprocess

def draco_encode(in_glb, out_glb, pos=14, tex=12, nrm=10):
    """Compress one glTF with KHR_draco_mesh_compression via gltf-transform."""
    subprocess.run(
        ["gltf-transform", "draco", str(in_glb), str(out_glb),
         "--method", "edgebreaker",
         "--quantize-position", str(pos),
         "--quantize-texcoord", str(tex),
         "--quantize-normal", str(nrm)],
        check=True,
    )
    return out_glb

comp_dir = Path("lods_draco"); comp_dir.mkdir(exist_ok=True)
comp_paths = {name: draco_encode(p, comp_dir / p.name)
              for name, p in raw_paths.items()}
```

<figure class="diagram">
<svg viewBox="64 2 651 308" role="img" aria-labelledby="dr-attr-t dr-attr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dr-attr-t">Where Draco's savings actually come from</title>
  <desc id="dr-attr-d">Bytes by attribute for one building mesh before and after Draco encoding, drawn at the same scale. Indices compress hardest because connectivity is highly predictable, and normals nearly as hard because they are quantized onto an octahedral lattice. Positions give back the least, since they carry the coordinates the quantization budget exists to protect.</desc>
  <rect class="svg-bg" x="64" y="2" width="651" height="308" fill="#ffffff"/>
  <text x="380" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">One building mesh: 4.97 MB uncompressed, 0.82 MB after Draco — both bars at the same scale</text>
  <rect x="110" y="208" width="110" height="42" rx="3" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="110" y="157" width="110" height="51" rx="3" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="110" y="106" width="110" height="51" rx="3" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="110" y="72" width="110" height="34" rx="3" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="470" y="244" width="110" height="6" rx="2" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="470" y="233" width="110" height="11" rx="2" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
  <rect x="470" y="229" width="110" height="4" rx="2" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <rect x="470" y="222" width="110" height="7" rx="2" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="start">
    <text x="232" y="233">indices — 1180 kB</text>
    <text x="232" y="186">POSITION — 1420 kB</text>
    <text x="232" y="135">NORMAL — 1420 kB</text>
    <text x="232" y="93">TEXCOORD_0 — 946 kB</text>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="start">
    <text x="596" y="132">indices −86%</text>
    <text x="596" y="154">POSITION −77%</text>
    <text x="596" y="176">NORMAL −92%</text>
    <text x="596" y="198">TEXCOORD_0 −77%</text>
  </g>
  <text x="165" y="270" fill="#5b6471" font-size="12.5" text-anchor="middle">before</text>
  <text x="525" y="270" fill="#5b6471" font-size="12.5" text-anchor="middle">after, 14-bit positions</text>
  <text x="380" y="292" fill="#15384a" font-size="12" text-anchor="middle">Positions give back the least of the four, so raising the position budget costs far less than the ratio suggests</text>
</svg>
<figcaption>The attribute you are most tempted to squeeze is the one that gives back the least. Spend the bits on POSITION and take the savings from connectivity and normals instead.</figcaption>
</figure>

### 6. Verify the extension, then wrap as b3dm

A Draco encode that silently no-ops produces a valid but uncompressed glTF, so assert `KHR_draco_mesh_compression` is actually declared before wrapping the level as a `b3dm` tile. Parse the GLB JSON chunk directly — no extra dependency — then convert with `3d-tiles-tools`.

```python
import struct, json

def gltf_json_chunk(glb_path):
    data = Path(glb_path).read_bytes()
    magic, _version, _length = struct.unpack("<III", data[:12])
    assert magic == 0x46546C67, f"{glb_path}: not a GLB (bad magic)"      # 'glTF'
    chunk_len, chunk_type = struct.unpack("<II", data[12:20])
    assert chunk_type == 0x4E4F534A, f"{glb_path}: first chunk is not JSON"  # 'JSON'
    return json.loads(data[20:20 + chunk_len])

def wrap_b3dm(glb_path, b3dm_path):
    doc = gltf_json_chunk(glb_path)
    used = doc.get("extensionsUsed", [])
    assert "KHR_draco_mesh_compression" in used, f"{glb_path}: Draco not applied"
    subprocess.run(["3d-tiles-tools", "glbToB3dm",
                    "-i", str(glb_path), "-o", str(b3dm_path), "-f"], check=True)
    return b3dm_path

tiles_dir = Path("tiles"); tiles_dir.mkdir(exist_ok=True)
for name, p in comp_paths.items():
    wrap_b3dm(p, tiles_dir / f"building_{name}.b3dm")
```

These `b3dm` payloads, each tagged with its measured `geometricError` from step 3 and placed by `root_transform` from step 1, are the leaf and refinement content the [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) step assembles into a `tileset.json`, and the [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) step encodes in parallel across a whole city.

## Validation & Verification

Never assume the encode worked from its exit code. Confirm three things: the extension is declared and required, decoded positions still match the source within tolerance, and the payload actually shrank. Start with `gltf-transform inspect`, which prints the extensions and per-mesh stats.

```bash
gltf-transform inspect lods_draco/building_LOD0.glb
```

Then assert the invariants in code. Load the encoded glTF back through `trimesh` (which decodes Draco on read) and compare its vertices to the source bounding box, and confirm the extension is both used and required.

```python
def verify_encode(source_path, encoded_path, max_pos_error_m=0.01):
    doc = gltf_json_chunk(encoded_path)
    assert "KHR_draco_mesh_compression" in doc.get("extensionsUsed", [])
    assert "KHR_draco_mesh_compression" in doc.get("extensionsRequired", [])

    src = trimesh.load(source_path, force="mesh", process=False)
    dec = trimesh.load(encoded_path, force="mesh", process=False)   # Draco-decoded

    # Decoded positions must sit within the quantization error of the source surface.
    _, dist, _ = src.nearest.on_surface(dec.vertices)
    worst = float(dist.max())
    assert worst < max_pos_error_m, f"decoded drift {worst*1000:.2f} mm too high"

    raw_kb = Path(source_path).stat().st_size / 1024
    enc_kb = Path(encoded_path).stat().st_size / 1024
    return {"worst_mm": worst * 1000, "raw_kb": raw_kb,
            "enc_kb": enc_kb, "ratio": raw_kb / enc_kb}

print(verify_encode("lods_raw/building_LOD0.glb", "lods_draco/building_LOD0.glb"))
```

**Expected values.** For a 180k-triangle building spanning roughly 30 m, POSITION at 14 bits gives a decoded worst-case drift of a few millimetres (well under the 1 cm gate), and the `.glb` shrinks from tens of megabytes to a few — a 6–12× ratio is typical for closed manifold geometry, higher when normals and texcoords dominate the vertex. A ratio near 1.0 means the extension did not apply; a decoded drift of tens of centimetres means too few position bits for the extent. Finally, run the assembled tileset through `3d-tiles-validator` so the client never receives a `b3dm` whose inner glTF requires an extension the tileset forgot to advertise.

<figure class="diagram">
<svg viewBox="56 2 665 330" role="img" aria-labelledby="dr-lvl-t dr-lvl-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dr-lvl-t">Draco compression level against encode time and output size</title>
  <desc id="dr-lvl-d">Raising the compression level from zero to seven takes most of the size reduction available. Past seven the curve is nearly flat while encode time keeps climbing steeply, so levels nine and ten cost several times the CPU for under one per cent more saving.</desc>
  <rect class="svg-bg" x="56" y="2" width="665" height="330" fill="#ffffff"/>
  <text x="380" y="30" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Level 7 is where the size curve flattens and the time curve does not</text>
  <path d="M70 56 V250 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="80,76 204,160 328,205 452,230 514,237 576,240 638,242 700,243" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="80,246 204,242 328,236 452,225 514,215 576,192 638,150 700,70" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <path d="M514 56 V250" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="514" y="48" fill="#4f7a4d" font-size="12" text-anchor="middle">level 7</text>
  <text x="196" y="112" fill="#1f6b8a" font-size="12" text-anchor="start">output size</text>
  <text x="590" y="120" fill="#c46a3d" font-size="12" text-anchor="middle">encode time</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="80" y="272">0</text>
    <text x="204" y="272">2</text>
    <text x="328" y="272">4</text>
    <text x="452" y="272">6</text>
    <text x="514" y="272">7</text>
    <text x="576" y="272">8</text>
    <text x="638" y="272">9</text>
    <text x="700" y="272">10</text>
  </g>
  <text x="380" y="294" fill="#5b6471" font-size="12" text-anchor="middle">compression level</text>
  <text x="380" y="314" fill="#15384a" font-size="12" text-anchor="middle">Level 10 buys 2.4% over level 7 for five times the encode time — across a city that is hours, not seconds</text>
</svg>
<figcaption>Encode cost is paid once per build and download cost is paid once per viewer, so the trade only favours the high levels for assets that are genuinely static.</figcaption>
</figure>

## Performance & Scale

Draco encoding is CPU-bound and single-threaded per invocation, so the throughput lever at city scale is parallelism across features, not faster encoding of one mesh. Each `gltf-transform` call spawns a Node process; for tens of thousands of features that startup cost is real, so batch by feature and distribute across physical cores.

```python
from concurrent.futures import ProcessPoolExecutor
import os

def encode_one(job):
    raw, out = job
    return draco_encode(raw, out)

jobs = [(p, comp_dir / p.name) for p in raw_paths.values()]
with ProcessPoolExecutor(max_workers=os.cpu_count()) as pool:
    list(pool.map(encode_one, jobs))
```

Two further levers matter. First, **encode once, reuse the level.** A feature's `LOD2` rarely changes between builds, so cache Draco output keyed by the source-mesh hash and re-encode only changed features — incremental rebuilds on a steady twin touch a few percent of tiles. Second, **quantize, do not over-decimate.** Draco's connectivity coder already exploits shared topology, so a level compressed at 14/12/10 bits is often smaller than a more aggressively decimated level left uncompressed, while keeping more triangles and a lower `geometricError`. Measure both paths against your byte budget rather than assuming fewer triangles always wins. For the parallel `b3dm` encode across an entire dataset — merging co-located features into batched tiles and sizing the pool to physical cores — see [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).

## Failure Modes & Gotchas

**Draco silently no-ops and the payload does not shrink.** If a primitive has no indices, or `gltf-transform` cannot find the native Draco module, the `draco` command can pass through geometry uncompressed while still exiting 0. The tell is a compression ratio near 1.0 and an absent `KHR_draco_mesh_compression` in `extensionsUsed`. Always run the step-6 assertion; treat a missing extension as a build failure, not a warning.

**Too few position bits warp a georeferenced building.** POSITION quantization error is roughly `extent / 2^bits`, and the extent that matters is the mesh's own ENU bounding box, not the ECEF magnitude. A 300 m block quantized at 11 bits carries ~15 cm of positional error — enough to bow a facade. Keep geometry local and centred (step 1), size the bit budget to the extent, and confirm decoded drift in the step's verification. The full bit-versus-extent relationship is worked in the [quantization tuning guide](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/).

**Normals quantized too coarsely shade in facets.** NORMAL at 8 bits is visibly banded on smooth curved surfaces under directional light. 10 bits is the safe floor for architectural geometry; drop to 8 only for hard-edged or untextured background assets where the banding never faces the camera.

**geometricError is not monotonic across the chain.** For a Draco chain the error must *increase* from the full-resolution leaf (LOD0, error 0) toward coarser levels, and when those levels are mapped onto a 3D Tiles tree the child (finer) tile must carry the smaller error. Mixing up which level is the leaf produces the classic "detail vanishes as you zoom in" refinement bug. Assign the measured error from step 3 to the tree consistently and assert monotonicity down the tree in the tiling step.

**UV seams smeared by quantization plus decimation.** Aggressive QEM that merges vertices across a texture seam, followed by low TEXCOORD bits, tears the atlas. Split on UV islands before decimating and keep TEXCOORD at 12 bits for textured facades; see [preserving UV seams during mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/).

## Frequently Asked Questions

### Is a discrete glTF LOD chain the same as Draco progressive compression?
No. A discrete chain is several independent, complete glTF meshes at different triangle counts, which is what 3D Tiles refinement swaps between. Draco compresses each of those meshes individually and is not a progressive or streaming codec in this workflow — decoding a Draco primitive gives you the whole mesh at once. Decimation controls the number of levels and their triangle counts; Draco controls the byte size of each level.

### Why encode with gltf-transform instead of gltf-pipeline or draco_encoder directly?
All three call the same Draco library, but they differ in control. `gltf-transform draco` exposes per-attribute quantization bits and the edgebreaker method as first-class flags and round-trips the full glTF material and texture graph, which is what you want for textured building levels. `gltf-pipeline` and the raw `draco_encoder` are viable, but you give up some of that per-attribute control or have to reassemble the glTF yourself. The workflow standardises on `gltf-transform` for that reason.

### How do I confirm Draco actually applied without a viewer?
Parse the GLB JSON chunk and check that `KHR_draco_mesh_compression` appears in both `extensionsUsed` and `extensionsRequired`, then compare file sizes for a real reduction. `gltf-transform inspect` prints the same information for a human. The step-6 and validation snippets do exactly this; a ratio near 1.0 or a missing extension means the encode did not take.

### What quantization bits should I start with for buildings?
POSITION 14, TEXCOORD 12, NORMAL 10 is a sound default that holds sub-centimetre positions on building-sized meshes while still compressing hard. These are starting points tied to the mesh extent, not universal constants — a 5 m kiosk tolerates fewer position bits than a 400 m tower. The [quantization tuning guide](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/) derives the bit budget from the bounding box and an accuracy tolerance.

### Does Draco change the geometricError I measured?
Not meaningfully if you quantize sensibly. `geometricError` is dominated by decimation — the triangles you removed — and is metres in scale, while POSITION quantization at 14 bits adds only millimetres on a building-sized box. Measure `geometricError` on the decimated mesh before Draco, then verify that decoded positions stay within your accuracy tolerance so quantization never becomes the dominant error term.

## Related Guides

- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — assembling these b3dm levels into a tileset.json with correct bounding volumes
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — encoding these Draco levels in parallel across a city-scale dataset
- [Tuning Draco Quantization for Building Meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/) — choosing position/texcoord/normal bits from mesh extent
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the QEM theory behind the LOD chain in step 2
- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — why glTF is the payload Draco compresses inside b3dm

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
