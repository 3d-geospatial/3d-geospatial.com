---
title: "Incremental Retiling of Changed City Blocks"
description: "Rebuild only the shards a change touches: content hashing, the dirty set, ancestor invalidation up the tree, and proving the untouched tiles are byte-identical."
---
# Incremental Retiling of Changed City Blocks

This page rebuilds only the part of a city tileset that a change actually affects — hashing each shard's inputs, computing the dirty set, propagating invalidation up the tree to the ancestors whose geometry was derived from the changed children, and proving that everything else came out byte-identical. A full city re-tile takes hours; an incremental one takes minutes, and the difference decides whether the twin can track a register that changes daily.

## Why you hit this

A municipal register changes continuously and in small increments: a demolition here, an extension there, twenty corrections after a survey. A pipeline that re-tiles the whole city on every change is both wasteful and slow enough that the twin is always days behind the register. The obvious fix — rebuild only the shards containing changed buildings — is correct and incomplete, because a coarse tile's geometry is derived from its children, so changing a leaf invalidates every ancestor above it.

The shard grid and content hashing this builds on are in [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24` and `shapely>=2.0`, plus whatever tiler you already use.
- A shard grid with stable addresses — quadkeys, as in [computing quadkeys and tile bounds](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/).
- A previous build's manifest on disk or in object storage.
- A deterministic tiler: given the same inputs and parameters, it must produce the same bytes, or none of the comparison below means anything.

## Step-by-Step

### 1. Hash everything that can change the output

The manifest is only trustworthy if the hash covers every input to the bytes.

```python
import hashlib
import json
from pathlib import Path

def shard_hash(shard_id, feature_paths, params, tool_versions):
    h = hashlib.sha256()
    h.update(shard_id.encode())
    for p in sorted(feature_paths):
        h.update(Path(p).name.encode())
        h.update(hashlib.sha256(Path(p).read_bytes()).digest())
    h.update(json.dumps(params, sort_keys=True).encode())
    h.update(json.dumps(tool_versions, sort_keys=True).encode())
    return h.hexdigest()

TOOL_VERSIONS = {"tiler": "py3dtiles 7.0.2", "draco": "1.5.6", "gltf-transform": "4.0.1"}
PARAMS = {"max_per_tile": 2000, "quantize_position": 14, "compression_level": 7}
```

The tool versions are the field teams forget, and their absence is exactly what makes an incremental build unsafe. Upgrade the encoder without them in the hash and the pipeline reports every shard as clean, leaving half the city on the old encoder and half on the new, with nothing recording which is which.

### 2. Compute the dirty set by comparing manifests

```python
import json
from pathlib import Path

def dirty_shards(current, previous_path):
    previous = json.loads(Path(previous_path).read_text()) if Path(previous_path).exists() else {}
    dirty, unchanged, added, removed = set(), set(), set(), set()
    for sid, h in current.items():
        if sid not in previous:
            added.add(sid)
        elif previous[sid] != h:
            dirty.add(sid)
        else:
            unchanged.add(sid)
    removed = set(previous) - set(current)
    return dirty, unchanged, added, removed

current = {sid: shard_hash(sid, paths, PARAMS, TOOL_VERSIONS)
           for sid, paths in shard_inputs.items()}
dirty, unchanged, added, removed = dirty_shards(current, "build/manifest.json")
print(f"dirty {len(dirty)} | unchanged {len(unchanged)} | added {len(added)} | removed {len(removed)}")
```

`removed` matters as much as `dirty`. A demolished block leaves a shard with no features, and a pipeline that only rebuilds what exists leaves the old tile in place — so the building is gone from the register and still standing in the viewer.

### 3. Propagate invalidation up the tree

This is the step that gets missed. A coarse tile is a decimation of its children, so a changed leaf makes every ancestor stale.

```python
def invalidate_ancestors(dirty_leaves):
    """A quadkey's ancestors are its prefixes, so invalidation is string slicing."""
    stale = set(dirty_leaves)
    for qk in dirty_leaves:
        for i in range(1, len(qk)):
            stale.add(qk[:i])
    return stale

stale = invalidate_ancestors(dirty | added | removed)
print(f"{len(dirty | added | removed)} changed leaves → {len(stale)} tiles to rebuild")
```

The multiplier is modest and unavoidable. Twelve changed leaves at depth 14 invalidate at most 12 × 13 ancestors, and in practice far fewer because they share prefixes — a change confined to one district touches one chain of ancestors rather than twelve.

<figure class="diagram">
<svg viewBox="16 26 665 240" role="img" aria-labelledby="ir-anc-t ir-anc-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ir-anc-t">A changed leaf makes every ancestor stale</title>
  <desc id="ir-anc-d">Two changed leaves in the same district invalidate the chain of ancestors above them, because each coarse tile's geometry was decimated from its children. Leaves in a different district share only the root, so the total number of stale tiles is far smaller than the number of leaves times the depth.</desc>
  <rect class="svg-bg" x="16" y="26" width="665" height="240" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="310" y="40" width="120" height="28" rx="5" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="92" width="120" height="28" rx="5" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="450" y="92" width="120" height="28" rx="5" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="144" width="110" height="28" rx="5" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="184" y="144" width="110" height="28" rx="5" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="196" width="86" height="28" rx="5" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="124" y="196" width="86" height="28" rx="5" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="196" width="86" height="28" rx="5" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none">
    <path d="M350 68 L250 90"/><path d="M400 68 L500 90"/>
    <path d="M210 120 L130 142"/><path d="M250 120 L250 142"/>
    <path d="M100 172 L80 194"/><path d="M130 172 L160 194"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="370" y="59">root</text>
    <text x="230" y="111">district A</text>
    <text x="510" y="111">district B</text>
    <text x="115" y="163">block</text>
    <text x="239" y="163">block</text>
    <text x="73" y="215">leaf ✎</text>
    <text x="167" y="215">leaf ✎</text>
    <text x="261" y="215">leaf</text>
  </g>
  <text x="580" y="170" fill="#4f7a4d" font-size="12" text-anchor="middle">untouched — copied forward</text>
  <text x="370" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">Two changed leaves, five stale tiles. District B and its whole subtree are copied forward byte-identical.</text>
</svg>
<figcaption>Invalidation follows the prefix chain, so changes clustered in one district cost far less than the leaf count times the depth suggests.</figcaption>
</figure>

### 4. Rebuild the stale set and copy the rest forward

```python
import shutil
from pathlib import Path

def build_incremental(stale, previous_dir, output_dir, tile_fn):
    out, prev = Path(output_dir), Path(previous_dir)
    out.mkdir(parents=True, exist_ok=True)
    rebuilt = copied = 0

    for qk in all_tiles:
        dst = out / f"{qk}.b3dm"
        if qk in stale:
            tile_fn(qk, dst)
            rebuilt += 1
        else:
            src = prev / f"{qk}.b3dm"
            if src.exists():
                shutil.copy2(src, dst)       # preserves mtime, so the CDN sees no change
                copied += 1
    return rebuilt, copied

rebuilt, copied = build_incremental(stale, "build/prev", "build/next", tile_shard)
print(f"rebuilt {rebuilt}, copied {copied} ({100 * copied / (rebuilt + copied):.1f}% reused)")
```

Copying with `copy2` rather than re-encoding is what makes the reuse real. A pipeline that re-encodes the unchanged shards "to be safe" produces different bytes for identical inputs — because encoders are rarely bit-deterministic across runs — and every CDN cache entry is invalidated for no reason.

### 5. Prove the untouched tiles really are identical

The claim that only the dirty set changed has to be checked, not asserted.

```python
import hashlib
from pathlib import Path

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

drift = []
for qk in all_tiles:
    if qk in stale:
        continue
    a, b = Path("build/prev") / f"{qk}.b3dm", Path("build/next") / f"{qk}.b3dm"
    if a.exists() and b.exists() and digest(a) != digest(b):
        drift.append(qk)

assert not drift, f"{len(drift)} supposedly-unchanged tiles differ, e.g. {drift[:3]}"
print("every non-stale tile is byte-identical to the previous build")
```

A non-empty `drift` list means the hash is missing an input. Run the same shard twice with no changes at all and see whether it comes out identical — if it does not, the tiler is non-deterministic and the whole incremental scheme rests on sand.

<figure class="diagram">
<svg viewBox="56 32 638 220" role="img" aria-labelledby="ir-cost-t ir-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ir-cost-t">Build cost against the fraction of the city that changed</title>
  <desc id="ir-cost-d">A full rebuild costs the same regardless of how much changed. An incremental rebuild costs roughly in proportion to the changed fraction plus a small fixed overhead for hashing and ancestor invalidation, so it wins decisively for the small daily changes a register actually produces.</desc>
  <rect class="svg-bg" x="56" y="32" width="638" height="220" fill="#ffffff"/>
  <path d="M70 46 V190 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M90 70 H660" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="90,182 190,168 290,150 390,130 490,110 590,90 660,76" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <text x="380" y="62" fill="#b0413e" font-size="12" text-anchor="middle">full rebuild — 4 h 10 m, whatever changed</text>
  <text x="230" y="150" fill="#4f7a4d" font-size="12" text-anchor="start">incremental</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="90" y="212">0.1%</text><text x="290" y="212">5%</text>
    <text x="490" y="212">40%</text><text x="660" y="212">100%</text>
  </g>
  <text x="375" y="234" fill="#5b6471" font-size="12" text-anchor="middle">fraction of shards changed</text>
</svg>
<figcaption>The two lines cross near a change of the whole city, which is the case incremental building is not for. Everything to the left of that is where a register actually lives.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="-2 42 744 214" role="img" aria-labelledby="ir-hash-t ir-hash-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ir-hash-t">Everything that must be inside the hash</title>
  <desc id="ir-hash-d">The content hash has to cover the source geometry, the tiling parameters and every tool version, because each of them changes the output bytes. Anything left out makes shards report as clean when their output would in fact differ, which leaves parts of the city built by an older toolchain with nothing recording it.</desc>
  <rect class="svg-bg" x="-2" y="42" width="744" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="180" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="98" width="180" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="140" width="180" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="182" width="180" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="330" y="98" width="180" height="76" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="590" y="98" width="130" height="76" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="120" y="78">source geometry</text>
    <text x="120" y="120">tiling parameters</text>
    <text x="120" y="162">tool versions</text>
    <text x="120" y="204">build timestamp</text>
    <text x="420" y="130"><tspan x="420" dy="0">sha256</tspan><tspan x="420" dy="17">shard hash</tspan></text>
    <text x="655" y="130"><tspan x="655" dy="0">dirty set</tspan><tspan x="655" dy="17">by comparison</tspan></text>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none">
    <path d="M210 72 L328 116"/><path d="M210 114 L328 130"/><path d="M210 156 L328 144"/>
    <path d="M510 136 L588 136"/>
  </g>
  <text x="240" y="204" fill="#b0413e" font-size="12" text-anchor="start">— never this: it makes every shard dirty</text>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Leave the tool versions out and the pipeline reports clean after an encoder upgrade, splitting the city across two encoders</text>
</svg>
<figcaption>The hash defines what &quot;unchanged&quot; means. Anything that affects the bytes and is not in it turns the manifest into a confident lie.</figcaption>
</figure>

## Expected Output & Verification

A representative daily run over a 4,096-shard city:

```text
dirty 11 | unchanged 4083 | added 2 | removed 1
14 changed leaves → 47 tiles to rebuild
rebuilt 47, copied 4051 (98.9% reused)
every non-stale tile is byte-identical to the previous build
```

Three checks make that trustworthy. The reuse percentage should be close to the complement of the changed fraction — a much lower figure means the hash is over-sensitive, usually because it includes a timestamp or an absolute path. The byte-identity assertion must pass. And a determinism check — building one unchanged shard twice and comparing — should be part of the same run, because it is the assumption everything else rests on.

## Common Errors

**Every shard is dirty on every run.** The hash includes something that changes each time: a file mtime, an absolute path, a build timestamp. Hash file *contents* and sorted basenames only.

**A demolished building is still in the viewer.** The `removed` set was not handled, so the old tile was copied forward. Removal has to rebuild the shard as empty, not skip it.

**Coarse tiles show the old geometry after a leaf changed.** Ancestor invalidation is missing. The symptom is distinctive: the building is correct close up and wrong from a distance.

**Reuse works locally and not in CI.** The runner does not have the previous build. Persist the previous output and manifest to object storage and fetch them at the start of the job, or the incremental path silently degrades to a full rebuild.

## Frequently Asked Questions

### How small should shards be?
Small enough that a typical change touches one, large enough that the shard count stays manageable. For building tiles, 500 m to 1 km cells put most changes in a single shard and keep a city in the low thousands.

### Does this work with implicit tiling?
Yes, and better — a subtree file describes a bounded region and a bounded level range, so a change in one district rewrites one small binary rather than a portion of a large JSON tree. See [implicit tiling with subtree files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/).

### What if the tiler is not deterministic?
Then measure the non-determinism before building on it. Some encoders vary only in a timestamp field, which can be normalised after encoding; others vary in the payload, and with those the byte-identity check has to become a tolerance check on the decoded geometry instead.

One organisational consequence is worth planning for. Because the manifest is the contract between two builds, it has to be stored with the same durability as the tiles themselves — losing it does not corrupt anything, but it forces the next build to be full, which on a city is hours. Write it into the build prefix alongside the tiles and fetch it at the start of the next run.

The other is that the incremental path needs the same testing as the full one. A pipeline that is only ever exercised incrementally in production, and full-rebuilt in CI, will eventually diverge — most often because a code path that handles the removed-shard case is never taken in the CI fixture. Run at least one incremental build against a fixture with an added, a changed and a removed shard on every merge.

### How do I handle a change to the tiling parameters themselves?
It dirties everything, correctly — a different `max_per_tile` or quantization budget changes every tile's bytes. That is the case incremental building is not for, and the right response is a full rebuild under a new build prefix rather than an attempt to be clever about which shards were "really" affected.

## Related Guides

- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — the shard grid and manifest this extends
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — the tiling step being made incremental
- [Cache Invalidation for Versioned Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/cache-invalidation-for-versioned-tilesets/) — publishing the result without invalidating everything

Back to [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
