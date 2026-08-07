---
title: "3D Tiles Batch Tiling Pipelines"
description: "Orchestrate deterministic batch 3D Tiles pipelines: shard a regional dataset into a tile grid, run idempotent glTF→b3dm+Draco jobs, hash-cache rebuilds, assemble and validate tileset.json across EPSG:32618→4978."
---
# Batch Tiling Pipelines for City- and Region-Scale 3D Tiles

Producing one 3D Tiles tileset is a solved problem; producing the same tileset for a 400 km² region every night, deterministically, without re-encoding the 96% of it that did not change, is not. When a survey grows past a few hundred buildings the encode stops fitting in a single process and a single machine's memory, and an ad-hoc loop over glTF files becomes a pipeline that must shard the extent, distribute idempotent encode jobs, skip unchanged work by content hash, and reassemble a valid `tileset.json` at the end — with byte-identical output on every rerun so a CI diff means a real data change, not encoder noise. This guide is the batch-orchestration layer that sits above the single-tileset mechanics in [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/): how to partition a city or region into a deterministic shard grid, run the glTF→`b3dm`→Draco encode as restartable batch jobs across workers, rebuild incrementally from a hash manifest, and stitch the shards into one validated tileset for a CDN.

## Prerequisites

Pin every component. A batch pipeline's entire value is reproducibility, and a floating dependency version silently rewrites the bytes of a `b3dm` payload, breaking the hash-cache invariant that makes incremental rebuilds correct.

| Component | Pinned version | Role in the batch pipeline |
|-----------|----------------|----------------------------|
| Python | 3.10–3.12 | Grid math, manifest, job orchestration, subprocess control |
| `numpy` | 1.26+ | Shard-index assignment, bounding-volume unions |
| `trimesh` | 4.4+ | Per-feature bounds/centroids in the shard-assignment pass |
| `py3dtiles` | 8.0+ | Native `tileset.json` assembly and `pnts` writing |
| `3d-tiles-tools` | 0.4+ (Node 18+) | glTF→`b3dm`, Draco encoding, gzip |
| `3d-tiles-validator` | 0.5+ | Schema, bounding-volume, and `geometricError` validation |
| `pyproj` | 3.6+ | CRS chain EPSG:32618+5703 → EPSG:4979 → EPSG:4978 |

**Input formats.** The pipeline consumes one glTF 2.0 / `.glb` per feature (building, bridge span, parcel) plus a sidecar CSV or GeoParquet of feature centroids so the shard-assignment pass never has to open the geometry. Meshes must be watertight with consistent winding before they enter the queue.

**Coordinate reference systems — declared once, asserted everywhere.** Source geometry here is UTM zone 18N over NAVD88, the compound **EPSG:32618+5703** (metres, orthometric height). Cesium renders in geocentric **EPSG:4978** (ECEF WGS84, metres), so every shard's root transform is built from the survey anchor through the geographic-3D hop **EPSG:4979**, exactly as in the [coordinate reference systems](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) guide. The shard grid itself is defined in the *projected* CRS (EPSG:32618) because only a metric planar grid divides cleanly; the ECEF transform is applied per shard at assembly time, never to the grid.

## Concept

A batch tiling pipeline is a function from `(source features, encoder version)` to `(tileset, hash manifest)` that must be **deterministic**, **idempotent**, and **incremental**. Determinism means the same inputs produce byte-identical `b3dm` files, so it is achieved by sorting every collection before iteration and pinning encoder flags. Idempotency means a job can be killed and rerun without corrupting output, so each shard writes to a temporary path and atomically renames on success. Incrementality means a rebuild touches only changed work, so each shard carries a content hash over its source meshes plus the encoder parameters, and a shard whose hash matches the manifest is skipped entirely.

The organising unit is the **shard**: a rectangular cell of the projected extent that owns every feature whose centroid falls inside it. Sharding turns one intractable job into thousands of independent ones — the property that lets the encode fan out across processes and machines, and lets an incremental rebuild re-encode a single city block without re-reading the region. Each shard becomes an *external* tileset (`tileset.json` + its `b3dm` leaves), and a thin root tileset references those shard tilesets by URI — the "tileset of tilesets" pattern. This keeps the root index tiny (one entry per shard, not per building) and lets the CDN cache unchanged shard tilesets independently. The single-tileset internals — `geometricError` ladders, box bounding volumes, the ENU→ECEF root transform — are unchanged from [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/); this guide is only about how thousands of them are scheduled, cached, and merged.

<figure class="diagram">
<svg viewBox="6 33 828 323" role="img" aria-labelledby="batch-lane-t batch-lane-d" xmlns="http://www.w3.org/2000/svg">
  <title id="batch-lane-t">Batch tiling pipeline swimlane from shard grid to validated publish</title>
  <desc id="batch-lane-d">A projected shard grid feeds independent encode workers that each run the glTF to b3dm and Draco step; their outputs converge into a tileset-of-tilesets assembly, which is validated and published. A content-hash cache below the lane skips shards whose source is unchanged and streams bounds before loading geometry.</desc>
  <rect class="svg-bg" x="6" y="33" width="828" height="323" fill="#ffffff"/>
  <defs>
    <marker id="batch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#batch-arrow)">
    <line x1="172" y1="150" x2="248" y2="77"/>
    <line x1="172" y1="172" x2="248" y2="172"/>
    <line x1="172" y1="194" x2="248" y2="267"/>
    <line x1="412" y1="77" x2="488" y2="160"/>
    <line x1="412" y1="172" x2="488" y2="172"/>
    <line x1="412" y1="267" x2="488" y2="184"/>
    <line x1="642" y1="172" x2="688" y2="172"/>
  </g>
  <rect x="20" y="108" width="150" height="128" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#1f6b8a" stroke-width="2">
    <rect x="52" y="120" width="86" height="60" fill="#ffffff"/>
    <line x1="52" y1="140" x2="138" y2="140"/>
    <line x1="52" y1="160" x2="138" y2="160"/>
    <line x1="81" y1="120" x2="81" y2="180"/>
    <line x1="109" y1="120" x2="109" y2="180"/>
  </g>
  <text x="95" y="205" fill="#15384a" font-size="13" text-anchor="middle">Shard grid</text>
  <text x="95" y="223" fill="#15384a" font-size="13" text-anchor="middle">EPSG:32618</text>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="250" y="47" width="160" height="60" rx="8"/>
    <rect x="250" y="142" width="160" height="60" rx="8"/>
    <rect x="250" y="237" width="160" height="60" rx="8"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="330" y="72">Encode worker</text>
    <text x="330" y="90">glTF→b3dm+Draco</text>
    <text x="330" y="167">Encode worker</text>
    <text x="330" y="185">glTF→b3dm+Draco</text>
    <text x="330" y="262">Encode worker</text>
    <text x="330" y="280">glTF→b3dm+Draco</text>
  </g>
  <rect x="490" y="118" width="152" height="108" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="566" y="166" fill="#15384a" font-size="13" text-anchor="middle">Assemble root</text>
  <text x="566" y="184" fill="#15384a" font-size="13" text-anchor="middle">tileset of tilesets</text>
  <rect x="690" y="128" width="130" height="88" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="755" y="166" fill="#1f2937" font-size="13" text-anchor="middle">Validate</text>
  <text x="755" y="184" fill="#1f2937" font-size="13" text-anchor="middle">+ publish</text>
  <rect x="20" y="296" width="800" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="420" y="324" fill="#15384a" font-size="13" text-anchor="middle">Content-hash cache skips unchanged shards · stream feature bounds first, load geometry lazily in the encode pass</text>
</svg>
<figcaption>Shards fan out to independent encode workers, converge into a tileset-of-tilesets root, and pass the validator before publish; a content-hash cache underneath re-encodes only shards whose source changed.</figcaption>
</figure>

## Step-by-Step Workflow

The pipeline runs in five deterministic passes: define the grid, assign features to shards, build a hash manifest, encode changed shards as batch jobs, then assemble and validate. Every pass sorts its inputs so reruns are byte-stable.

### 1. Define the shard grid in the projected CRS

Anchor the grid to a fixed origin and a fixed cell size in EPSG:32618 metres. Snapping the origin to a round coordinate (not the data's min corner) keeps cell boundaries stable when the survey extent grows in a later rebuild — a feature never migrates shards just because a new building widened the bounding box.

```python
import numpy as np

# Fixed grid in EPSG:32618 (UTM 18N, metres). Origin is a round anchor,
# NOT the data min corner, so the grid is stable across rebuilds.
GRID_ORIGIN = np.array([580_000.0, 4_505_000.0])   # EPSG:32618 easting, northing
CELL_SIZE_M = 250.0                                # 250 m shards

def shard_index(easting: np.ndarray, northing: np.ndarray) -> np.ndarray:
    """Map projected centroids to integer (col, row) shard keys."""
    cols = np.floor((easting - GRID_ORIGIN[0]) / CELL_SIZE_M).astype(np.int64)
    rows = np.floor((northing - GRID_ORIGIN[1]) / CELL_SIZE_M).astype(np.int64)
    return np.stack([cols, rows], axis=1)

def shard_bounds(col: int, row: int) -> tuple[float, float, float, float]:
    """Projected (minx, miny, maxx, maxy) of one shard in EPSG:32618."""
    minx = GRID_ORIGIN[0] + col * CELL_SIZE_M
    miny = GRID_ORIGIN[1] + row * CELL_SIZE_M
    return minx, miny, minx + CELL_SIZE_M, miny + CELL_SIZE_M
```

### 2. Assign features to shards from the centroid sidecar

Read only the centroid table, never the geometry, so this pass over a million features stays in seconds and megabytes. Group feature paths by shard key and sort within each group for determinism.

```python
from collections import defaultdict
import csv
from pathlib import Path

shards: dict[tuple[int, int], list[str]] = defaultdict(list)
east, north, paths = [], [], []
with open("feature_centroids.csv", newline="") as fh:          # EPSG:32618 centroids
    for row in csv.DictReader(fh):
        east.append(float(row["easting"]))
        north.append(float(row["northing"]))
        paths.append(row["glb_path"])

keys = shard_index(np.array(east), np.array(north))
for (col, rw), p in zip(keys, paths):
    shards[(int(col), int(rw))].append(p)

for key in shards:
    shards[key].sort()          # deterministic feature order within a shard
print(f"{len(paths)} features -> {len(shards)} shards")
```

### 3. Build the content-hash manifest for incremental rebuilds

Each shard's hash covers the *sorted* source-mesh bytes plus the encoder parameters. A shard whose hash matches the previous manifest is skipped; anything else is queued. This is what turns a nightly full build into a two-minute delta.

```python
import hashlib
import json

ENCODER_PARAMS = {"tool": "3d-tiles-tools@0.4", "draco": "compressMeshes", "level": 7}

def shard_hash(glb_paths: list[str]) -> str:
    """Stable hash over sorted source bytes + encoder params."""
    h = hashlib.sha256()
    h.update(json.dumps(ENCODER_PARAMS, sort_keys=True).encode())
    for p in glb_paths:                         # already sorted in step 2
        h.update(p.encode())
        h.update(Path(p).read_bytes())
    return h.hexdigest()

manifest = {f"{c}_{r}": shard_hash(paths) for (c, r), paths in shards.items()}
prev = json.loads(Path("manifest.prev.json").read_text()) if Path(
    "manifest.prev.json").exists() else {}

dirty = [k for k, digest in manifest.items() if prev.get(k) != digest]
print(f"{len(dirty)}/{len(manifest)} shards changed -> re-encoding only those")
```

<figure class="diagram">
<svg viewBox="38 16 696 296" role="img" aria-labelledby="bt-hash-t bt-hash-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bt-hash-t">Only the shards whose content hash moved get rebuilt</title>
  <desc id="bt-hash-d">Each shard's inputs are hashed into a manifest. On the next run the hashes are recomputed and compared, and only the two shards whose hash differs are re-encoded. The remaining seven are copied forward untouched, so a small edit costs a small build.</desc>
  <rect class="svg-bg" x="38" y="16" width="696" height="296" fill="#ffffff"/>
  <text x="240" y="44" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">shard grid, EPSG:32633</text>
  <text x="240" y="272" fill="#b0413e" font-size="12" text-anchor="middle">shards 0-1 and 2-2: content hash changed</text>
    <rect x="60" y="70" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="156" y="70" width="84" height="52" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
    <rect x="252" y="70" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="60" y="132" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="156" y="132" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="252" y="132" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="60" y="194" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="156" y="194" width="84" height="52" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
    <rect x="252" y="194" width="84" height="52" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="102" y="96">0-0</text>
    <text x="198" y="96">0-1</text>
    <text x="294" y="96">0-2</text>
    <text x="102" y="158">1-0</text>
    <text x="198" y="158">1-1</text>
    <text x="294" y="158">1-2</text>
    <text x="102" y="220">2-0</text>
    <text x="198" y="220">2-1</text>
    <text x="294" y="220">2-2</text>
  </g>
  <g text-anchor="middle">
  </g>
  <path d="M470 70 h250 v56 h-250 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M470 148 h250 v56 h-250 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M470 226 h250 v56 h-250 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="595" y="92"><tspan x="595" dy="0">hash(source geometry +</tspan><tspan x="595" dy="16">encoder version + params)</tspan></text>
    <text x="595" y="170"><tspan x="595" dy="0">compare against</tspan><tspan x="595" dy="16">manifest.json from last run</tspan></text>
    <text x="595" y="248"><tspan x="595" dy="0">re-encode 2 shards,</tspan><tspan x="595" dy="16">copy 7 forward unchanged</tspan></text>
  </g>
  <text x="370" y="294" fill="#5b6471" font-size="12" text-anchor="middle">The encoder version belongs in the hash — otherwise a toolchain upgrade leaves half the city on the old encoder</text>
</svg>
<figcaption>Incremental rebuilds are a hashing problem, not a scheduling one. Everything that can change the output bytes has to be inside the hash, or the manifest lies.</figcaption>
</figure>

### 4. Encode each dirty shard as an idempotent batch job

One shard becomes one external tileset. Merge the shard's features into a single batched `.glb` (a `b3dm` is batched by design — one tile, many features, a `_BATCHID` per vertex), encode once through `3d-tiles-tools`, and write to a temp path renamed atomically on success so a killed job never leaves a half-written tile. Parallelising these jobs across cores is covered in [parallel b3dm encoding with process pools](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/).

```python
import os
import subprocess
import trimesh

def merge_shard(glb_paths: list[str]) -> trimesh.Scene:
    """Combine a shard's features into one batched scene with per-feature IDs."""
    scene = trimesh.Scene()
    for bid, p in enumerate(glb_paths):                 # sorted -> stable batch IDs
        mesh = trimesh.load(p, force="mesh")
        assert mesh.is_winding_consistent, f"{p}: inconsistent winding"
        scene.add_geometry(mesh, node_name=f"feature_{bid}")
    return scene

def encode_shard(key: str, glb_paths: list[str], out_dir: Path) -> Path:
    """Idempotent: temp-write then atomic rename. Returns the shard b3dm path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    merged_glb = out_dir / f"{key}.glb"
    merge_shard(glb_paths).export(merged_glb)

    tmp = out_dir / f".{key}.b3dm.tmp"
    final = out_dir / f"{key}.b3dm"
    subprocess.run(["3d-tiles-tools", "glbToB3dm",
                    "-i", str(merged_glb), "-o", str(tmp), "-f"], check=True)
    subprocess.run(["3d-tiles-tools", "optimizeB3dm", "-i", str(tmp), "-o", str(tmp),
                    "-f", "--options", "--draco.compressMeshes"], check=True)
    os.replace(tmp, final)                               # atomic on POSIX
    merged_glb.unlink()
    return final

out_root = Path("tiles")
for key in sorted(dirty):
    col, rw = map(int, key.split("_"))
    encode_shard(key, shards[(col, rw)], out_root / key)
```

### 5. Assemble the tileset-of-tilesets and write the manifest

The root `tileset.json` references each shard's own `tileset.json` as external content. Compute each shard's box bounding volume in the local ENU frame, carry the survey-anchor ENU→ECEF transform on the root (EPSG:4979→EPSG:4978), and set a coarse root `geometricError` so the client fetches shard indices lazily. Use `py3dtiles` or write the tree directly.

```python
from pyproj import Transformer

to_geographic = Transformer.from_crs("EPSG:32618+5703", "EPSG:4979", always_xy=True)
to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)
lon, lat, h = to_geographic.transform(*GRID_ORIGIN, 0.0)     # survey anchor
cx, cy, cz = to_ecef.transform(lon, lat, h)

def enu_to_ecef(lon_deg, lat_deg, x, y, z) -> list[float]:
    lo, la = np.radians(lon_deg), np.radians(lat_deg)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la)*np.cos(lo), -np.sin(la)*np.sin(lo), np.cos(la)])
    up = np.array([np.cos(la)*np.cos(lo), np.cos(la)*np.sin(lo), np.sin(la)])
    m = np.identity(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = east, north, up, [x, y, z]
    return m.flatten(order="F").tolist()                    # column-major

def shard_box_enu(col: int, row: int, z_half: float = 60.0) -> list[float]:
    """Box volume in the local ENU frame, relative to the grid origin."""
    minx, miny, maxx, maxy = shard_bounds(col, row)
    ex = (minx + maxx) / 2 - GRID_ORIGIN[0]
    ny = (miny + maxy) / 2 - GRID_ORIGIN[1]
    return [ex, ny, z_half, CELL_SIZE_M/2, 0, 0, 0, CELL_SIZE_M/2, 0, 0, 0, z_half]

children = []
for key in sorted(manifest):                                 # ALL shards, not just dirty
    col, rw = map(int, key.split("_"))
    children.append({
        "boundingVolume": {"box": shard_box_enu(col, rw)},
        "geometricError": CELL_SIZE_M,
        "content": {"uri": f"{key}/tileset.json"},           # external shard tileset
    })

root = {"asset": {"version": "1.1"},
        "geometricError": 4096.0,
        "root": {"transform": enu_to_ecef(lon, lat, cx, cy, cz),
                 "boundingVolume": {"box": shard_box_enu(0, 0, 4096.0)},
                 "geometricError": 4096.0, "refine": "REPLACE",
                 "children": children}}
(out_root / "tileset.json").write_text(json.dumps(root, indent=2, sort_keys=True))
Path("manifest.prev.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
```

<figure class="diagram">
<svg viewBox="26 26 688 286" role="img" aria-labelledby="bt-tree-t bt-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bt-tree-t">A tileset of tilesets keeps each shard independently publishable</title>
  <desc id="bt-tree-d">The root tileset.json holds only bounding volumes and geometric errors, and points at one external tileset.json per shard. Each shard owns its own subtree and content files, so rebuilding one shard rewrites one small file and leaves the rest of the city byte-identical.</desc>
  <rect class="svg-bg" x="26" y="26" width="688" height="286" fill="#ffffff"/>
  <defs>
    <marker id="bt-tree-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="240" y="40" width="260" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="2">
    <rect x="40" y="140" width="180" height="56" rx="8"/>
    <rect x="280" y="140" width="180" height="56" rx="8"/>
    <rect x="520" y="140" width="180" height="56" rx="8"/>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="40" y="232" width="180" height="44" rx="8"/>
    <rect x="280" y="232" width="180" height="44" rx="8"/>
    <rect x="520" y="232" width="180" height="44" rx="8"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#bt-tree-a)">
    <path d="M320 96 C 260 112 190 120 132 138"/>
    <path d="M370 96 V138"/>
    <path d="M420 96 C 480 112 550 120 608 138"/>
    <path d="M130 196 V230"/>
    <path d="M370 196 V230"/>
    <path d="M610 196 V230"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="370" y="64"><tspan x="370" dy="0" font-weight="600">root tileset.json</tspan><tspan x="370" dy="16">bounds and errors only, no content</tspan></text>
    <text x="130" y="164"><tspan x="130" dy="0">shard 0-0/tileset.json</tspan><tspan x="130" dy="16">own subtree, own errors</tspan></text>
    <text x="370" y="164"><tspan x="370" dy="0">shard 0-1/tileset.json</tspan><tspan x="370" dy="16">rebuilt this run</tspan></text>
    <text x="610" y="164"><tspan x="610" dy="0">shard 0-2/tileset.json</tspan><tspan x="610" dy="16">byte-identical to last run</tspan></text>
    <text x="130" y="260">*.b3dm content</text>
    <text x="370" y="260">*.b3dm content</text>
    <text x="610" y="260">*.b3dm content</text>
  </g>
  <text x="370" y="294" fill="#5b6471" font-size="12" text-anchor="middle">The root file is the only shared artefact, so two shards can be rebuilt concurrently without a write conflict</text>
</svg>
<figcaption>External tilesets turn the city into independently deployable units. The alternative — one monolithic tileset.json — serialises every rebuild through a single file.</figcaption>
</figure>

## Validation & Verification

Never publish a batch whose root or any shard tileset has not passed the official validator. Run it over the assembled root; the validator follows external `content` references into each shard tileset.

```bash
npx 3d-tiles-validator --tilesetFile tiles/tileset.json
```

Then assert the batch-specific invariants the validator does not enforce: every referenced shard file exists, and re-encoding an unchanged shard yields byte-identical output (the determinism contract the hash cache relies on).

```python
# 1. Every external content URI resolves.
for child in root["root"]["children"]:
    ref = out_root / child["content"]["uri"]
    assert ref.exists(), f"dangling shard reference: {ref}"

# 2. Determinism: re-encode one shard and compare bytes.
sample = sorted(manifest)[0]
c, r = map(int, sample.split("_"))
first = (out_root / sample / f"{sample}.b3dm").read_bytes()
encode_shard(sample + "_check", shards[(c, r)], out_root / "_verify")
second = (out_root / "_verify" / f"{sample}_check.b3dm").read_bytes()
assert first == second, "non-deterministic encode — hash cache is unsafe"
print("batch verified: references resolve and encode is byte-stable")
```

**Expected values.** For a 250 m grid over a 4 km² downtown, expect roughly 60–70 occupied shards, each `b3dm` in the 0.5–4 MB range after Draco, and a root `tileset.json` under 50 KB because it holds one entry per shard rather than per building. A rerun with no source change must report `0/N shards changed` and leave every `b3dm` mtime untouched.

## Performance & Scale

At regional scale the pipeline is bound by three things, in order: redundant re-encoding, Node process startup, and memory.

**Incremental rebuild is the biggest lever.** A steady twin changes under 5% of shards per day. The hash manifest turns a six-hour full region build into a rebuild proportional to the delta — the single optimisation that makes nightly builds viable. Keep the manifest hash over *sorted* source bytes plus encoder params so a reordered directory listing never invalidates the whole cache.

**Amortise Node startup.** `3d-tiles-tools` spins up a Node runtime per invocation; at tens of thousands of shards that startup cost dominates wall-clock time. Merging co-located features into one batched `.glb` per shard (step 4) already collapses thousands of features into hundreds of shard encodes; parallelising and chunking those encodes across physical cores is the next multiplier, detailed in [parallel b3dm encoding with process pools](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/).

**Stream bounds, not geometry.** The shard-assignment pass (step 2) touches only the centroid sidecar, so peak memory is independent of region size. Geometry is loaded lazily and only for dirty shards during the encode pass, and each merged `.glb` is deleted immediately after its `b3dm` is written. This keeps a region build inside a few gigabytes regardless of how many terabytes the source occupies. When this pipeline runs inside CI, the same discipline — cache the manifest between runs, shard the matrix across runners — is covered in [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).

## Failure Modes & Gotchas

**Features migrate shards after the extent grows, invalidating the whole cache.** Anchoring the grid to the data's min corner means adding one building on the north edge shifts every cell boundary and re-hashes every shard. Fix: anchor `GRID_ORIGIN` to a fixed round coordinate in EPSG:32618 and never derive it from the current dataset bounds, so a feature's shard key depends only on its own position.

**A killed job leaves a truncated `b3dm` that the next run trusts.** Writing the encoder output straight to the final path means an interrupted `optimizeB3dm` leaves a partial file whose presence makes the pipeline think the shard is done. Fix: encode to a temp path and `os.replace` onto the final name only after both subprocess steps return success — `os.replace` is atomic on POSIX, so the final file is always either absent or complete.

**Hash cache silently ships stale tiles after a dependency bump.** Upgrading `3d-tiles-tools` or Draco changes the encoded bytes, but a hash taken only over source geometry stays constant, so no shard is re-encoded and the region freezes at the old encoder's output. Fix: fold the encoder version and every Draco flag into `ENCODER_PARAMS` and hash them alongside the mesh bytes, so an encoder change invalidates the entire cache exactly once.

**Non-deterministic merge order corrupts incremental diffs.** `trimesh.Scene` and directory globs do not guarantee order, so an unsorted merge assigns different `_BATCHID`s on each run and produces different bytes for identical input, defeating the byte-stability assertion. Fix: sort feature paths in step 2 and iterate that sorted list everywhere, so batch IDs and merged geometry are reproducible.

**Shard seams show a Z step between adjacent cells.** Mixing ellipsoidal and NAVD88 orthometric heights across shards produces a vertical discontinuity at cell edges. Fix: declare the compound source CRS (EPSG:32618+5703) once and transform through EPSG:4979 so the geoid separation is applied identically to every shard, never re-derived per cell — the same discipline as [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/).

## Frequently Asked Questions

### Why shard into external tilesets instead of one big tileset.json?

An external-tileset-per-shard root stays small — one entry per cell rather than one per building — so the client's first request is a lightweight index, and each shard tileset caches on the CDN independently. When a rebuild touches five shards, only those five shard tilesets change URL-for-URL; the root and every other shard keep their cache entries. A single monolithic `tileset.json` would be rewritten on any change and force a full re-fetch of the index.

### How large should each shard cell be?

Size the cell so a shard's merged, Draco-compressed `b3dm` decodes in well under a frame — typically a few hundred thousand triangles. For dense downtown data a 200–300 m grid balances payload size against index overhead; sparse suburban or infrastructure corridors tolerate larger cells. Profile the initial load in Cesium and adjust `CELL_SIZE_M` rather than the geometric-error scale, because the cell size is what governs both payload weight and how many jobs the batch fans out into.

### What exactly goes into the content hash?

The sorted source-mesh bytes for the shard plus every parameter that affects the output: the encoder tool and version, all Draco flags, and the merge order. Anything that changes a byte of the `b3dm` must be in the hash, and anything that does not — a wall-clock timestamp, the absolute working directory — must be excluded, or unchanged shards re-encode needlessly.

### Can I run this incrementally in CI without a persistent disk?

Yes. Persist only two small artifacts between runs: `manifest.prev.json` and the shard output directory, both cacheable by your CI system's key-value cache. The centroid sidecar and source `.glb` files come from object storage. Restore the previous manifest, compute the delta, encode the dirty shards, and re-upload only the changed shard directories, as described in [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).

## Related Guides

- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — the single-tileset internals (geometricError, box volumes, ECEF transform) this pipeline schedules at scale
- [Parallel b3dm Encoding with Process Pools](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/) — fanning the per-shard encode across CPU cores deterministically
- [Implementing Quadtree LOD for Urban Models](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/) — the within-shard tree each external tileset carries
- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — running the batch as cached, sharded jobs in CI
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the EPSG:32618+5703 → EPSG:4979 → EPSG:4978 chain the assembly depends on

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
