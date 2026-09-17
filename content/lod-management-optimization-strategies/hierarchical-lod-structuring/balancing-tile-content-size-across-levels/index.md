# Balancing Tile Content Size Across Levels

This page diagnoses a tileset whose tiles range from 8 KB to 40 MB, works out which levels are unbalanced and why, fixes it by making the subdivision threshold adaptive rather than fixed, splits the remaining outliers, and adds a balance gate so the problem does not come back with the next delivery.

## Why you hit this

A tileset's worst tile determines its worst experience. One 40 MB tile in a district means every camera that looks at that district waits for it, and no amount of good behaviour elsewhere compensates. At the other end, a level made of 8 KB tiles spends more time on request overhead than on geometry.

Fixed subdivision thresholds cause both. "Subdivide when a tile has more than 2,000 features" produces 8 KB tiles in suburbs where features are small and 40 MB tiles in a business district where they are not, because feature count is a poor proxy for payload. The fix is to measure payload and subdivide on that.

## Prerequisites

- A tileset with per-tile content and, ideally, tile metadata recording feature counts — see [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/).
- Python 3.10+ with `numpy`.
- The tree builder from [octree vs quadtree subdivision for tall buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/octree-vs-quadtree-subdivision-for-tall-buildings/).

## Step-by-Step

### 1. Build the per-level payload histogram

```python
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

def collect_tiles(tileset_path, content_root=None):
    """Walk the tileset and record each content tile's depth and payload size."""
    doc = json.loads(Path(tileset_path).read_text())
    root_dir = Path(content_root or Path(tileset_path).parent)
    rows = []

    def walk(tile, depth):
        uri = (tile.get("content") or {}).get("uri")
        if uri and not uri.endswith(".json"):
            path = root_dir / uri
            rows.append({
                "uri": uri,
                "depth": depth,
                "bytes": path.stat().st_size if path.exists() else None,
                "geometric_error": tile.get("geometricError"),
                "features": ((tile.get("metadata") or {}).get("properties") or {})
                            .get("featureCount"),
            })
        for child in tile.get("children", []):
            walk(child, depth + 1)

    walk(doc["root"], 0)
    return [r for r in rows if r["bytes"] is not None]

def level_profile(rows):
    by_depth = defaultdict(list)
    for r in rows:
        by_depth[r["depth"]].append(r["bytes"])
    out = []
    for depth in sorted(by_depth):
        sizes = np.array(by_depth[depth], dtype=np.float64)
        out.append({
            "depth": depth,
            "tiles": len(sizes),
            "total_mb": round(sizes.sum() / 1e6, 1),
            "p50_kb": round(float(np.percentile(sizes, 50)) / 1024, 1),
            "p95_kb": round(float(np.percentile(sizes, 95)) / 1024, 1),
            "max_kb": round(float(sizes.max()) / 1024, 1),
            "min_kb": round(float(sizes.min()) / 1024, 1),
            "spread": round(float(sizes.max() / max(np.percentile(sizes, 50), 1)), 1),
        })
    return out

rows = collect_tiles("output/city/tileset.json")
for level in level_profile(rows):
    print(level)
```

The **spread** — maximum over median — is the single number that says whether a level is balanced. A spread of 2 or 3 is normal and healthy; a spread of 40 means one tile at that level is forty times the typical one, and that tile is the level's real cost.

Reading the sizes from disk rather than from tile metadata is deliberate for the diagnosis, because the metadata records what the pipeline *intended*. A tile whose metadata says 1,800 features and whose file is 38 MB has textures nobody accounted for.

<figure class="diagram">
<svg viewBox="4 6 732 262" role="img" aria-labelledby="bal-prof-t bal-prof-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bal-prof-t">Payload spread per level, before and after</title>
  <desc id="bal-prof-d">A comparison of six tileset levels. Before the fix, median payloads are 6, 41, 180, 410, 520 and 380 kilobytes, with maximums of 18, 210, 3100, 41000, 8800 and 2100 kilobytes, giving spreads up to 100 at level 3. After making subdivision adaptive on payload and splitting outliers, medians are similar but maximums fall to 22, 96, 340, 980, 1100 and 890 kilobytes, with every spread under 3.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="262" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="96" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="114" y="20" width="152" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="20" width="152" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="418" y="20" width="152" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="570" y="20" width="152" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g stroke-width="1.4">
    <rect x="18" y="52" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="52" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="52" width="152" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="52" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="52" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="82" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="82" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="82" width="152" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="82" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="82" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="112" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="112" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="112" width="152" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="112" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="112" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="142" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="142" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="142" width="152" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="142" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="142" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="172" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="172" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="172" width="152" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="418" y="172" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="172" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="202" width="96" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="114" y="202" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="266" y="202" width="152" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="418" y="202" width="152" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="570" y="202" width="152" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="66" y="41">level</text><text x="190" y="41">median before</text>
    <text x="342" y="41">max before</text><text x="494" y="41">median after</text><text x="646" y="41">max after</text>
    <text x="66" y="72">0</text><text x="190" y="72">6 KB</text><text x="342" y="72">18 KB</text><text x="494" y="72">8 KB</text><text x="646" y="72">22 KB</text>
    <text x="66" y="102">1</text><text x="190" y="102">41 KB</text><text x="342" y="102">210 KB</text><text x="494" y="102">44 KB</text><text x="646" y="102">96 KB</text>
    <text x="66" y="132">2</text><text x="190" y="132">180 KB</text><text x="342" y="132">3.1 MB</text><text x="494" y="132">172 KB</text><text x="646" y="132">340 KB</text>
    <text x="66" y="162">3</text><text x="190" y="162">410 KB</text><text x="342" y="162">41.0 MB</text><text x="494" y="162">398 KB</text><text x="646" y="162">980 KB</text>
    <text x="66" y="192">4</text><text x="190" y="192">520 KB</text><text x="342" y="192">8.8 MB</text><text x="494" y="192">505 KB</text><text x="646" y="192">1.1 MB</text>
    <text x="66" y="222">5</text><text x="190" y="222">380 KB</text><text x="342" y="222">2.1 MB</text><text x="494" y="222">372 KB</text><text x="646" y="222">890 KB</text>
  </g>
  <text x="370" y="250" fill="#5b6471" font-size="12" text-anchor="middle">medians barely move; the maximums fall by up to 40× — the whole problem was the outliers</text>
</svg>
<figcaption>Level 3's 41 MB tile is the tileset's worst experience, and the median says nothing about it.</figcaption>
</figure>

### 2. Find out what makes the outliers big

```python
import subprocess

def outlier_anatomy(rows, top_n=6, content_root="output/city"):
    """For the biggest tiles, is the cost geometry or texture?"""
    biggest = sorted(rows, key=lambda r: -r["bytes"])[:top_n]
    out = []
    for r in biggest:
        path = Path(content_root) / r["uri"]
        proc = subprocess.run(["npx", "gltf-transform", "inspect", "--format", "json",
                               str(path)], capture_output=True, text=True)
        doc = json.loads(proc.stdout) if proc.returncode == 0 else {}
        textures = doc.get("textures", [])
        meshes = doc.get("meshes", [])
        tex_bytes = sum(t.get("size", 0) for t in textures)
        out.append({
            "uri": r["uri"], "depth": r["depth"],
            "mb": round(r["bytes"] / 1e6, 2),
            "texture_mb": round(tex_bytes / 1e6, 2),
            "texture_share": round(tex_bytes / max(r["bytes"], 1), 2),
            "textures": len(textures),
            "largest_texture": max((t.get("resolution") for t in textures), default=None),
            "primitives": sum(m.get("primitives", 0) for m in meshes),
            "vertices": sum(m.get("vertices", 0) for m in meshes),
            "features": r["features"],
            "cause": None,
        })
    for o in out:
        if o["texture_share"] > 0.7:
            o["cause"] = "texture-dominated — resize or recompress"
        elif o["features"] and o["vertices"] / max(o["features"], 1) > 3000:
            o["cause"] = "few very detailed features — split by feature, not by area"
        elif o["features"] and o["features"] > 6000:
            o["cause"] = "too many features — lower the subdivision threshold"
        else:
            o["cause"] = "dense geometry — subdivide further"
    return out

for o in outlier_anatomy(rows):
    print(f"{o['uri']:<34}{o['mb']:>7} MB  tex {o['texture_share']:.0%}  {o['cause']}")
```

Distinguishing texture-dominated from geometry-dominated outliers is the branch that matters, because the fixes are completely different. A 41 MB tile that is 94% texture is fixed by resizing the atlas, as in [gltfpack settings for 3D Tiles content](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/gltfpack-settings-for-3d-tiles-content/), and subdividing it further would produce four 10 MB tiles that are still too big.

The `vertices / features` ratio catches the case that fixed thresholds handle worst: a tile with 40 features and 8 million vertices, which happens when one photogrammetric mesh or one heavily modelled landmark lands in a cell. No feature-count threshold will ever split it.

### 3. Make the subdivision threshold adaptive

```python
from dataclasses import dataclass

@dataclass
class BalanceTargets:
    target_kb: float = 400.0        # the payload you want per tile
    max_kb: float = 1200.0          # the hard ceiling
    min_kb: float = 40.0            # below this, merging is better than splitting
    max_features: int = 8000        # a safety net, not the primary criterion

def estimate_payload_kb(features, texture_budget_kb_per_m2=0.0):
    """Predict a tile's payload from its contents, before tiling it."""
    tris = sum(f.triangles for f in features)
    verts = tris * 0.55                             # typical after welding
    geometry_kb = (verts * 14) / 1024               # quantised + compressed, empirical
    footprint = sum(f.footprint_m2 for f in features)
    texture_kb = footprint * texture_budget_kb_per_m2
    return geometry_kb + texture_kb

def subdivide_decision(features, targets, depth, max_depth=12,
                       texture_budget_kb_per_m2=0.0):
    payload = estimate_payload_kb(features, texture_budget_kb_per_m2)
    if depth >= max_depth:
        return {"split": False, "reason": "max depth", "payload_kb": round(payload, 1)}
    if payload > targets.max_kb:
        return {"split": True, "reason": f"payload {payload:.0f} KB over ceiling",
                "payload_kb": round(payload, 1)}
    if len(features) > targets.max_features:
        return {"split": True, "reason": f"{len(features)} features over safety net",
                "payload_kb": round(payload, 1)}
    if payload > targets.target_kb * 1.5:
        return {"split": True, "reason": f"payload {payload:.0f} KB over 1.5× target",
                "payload_kb": round(payload, 1)}
    return {"split": False, "reason": f"payload {payload:.0f} KB within target",
            "payload_kb": round(payload, 1)}
```

Predicting payload from triangle count and footprint, calibrated once against a real tiling run, is what makes this adaptive rather than iterative. The alternative — tile, measure, re-tile — is correct and costs several full passes over the city.

The 14 bytes per vertex figure is empirical and worth recalibrating per project: it depends on the quantisation bits, the compression choice and how regular the meshes are. Measuring it from an existing run takes one division.

The three-tier decision — hard ceiling, safety net, soft target — is what stops the tree from either exploding or leaving outliers. The ceiling is non-negotiable; the soft target at 1.5× allows some variance so the tree does not subdivide for a 10% overshoot.

### 4. Split the outliers that subdivision cannot fix

```python
def split_dense_tile(features, targets, max_parts=8):
    """When one cell holds a few enormous features, split by feature, not by area."""
    payload = estimate_payload_kb(features, 0.0)
    if payload <= targets.max_kb:
        return [features]

    ordered = sorted(features, key=lambda f: -f.triangles)
    parts = [[] for _ in range(min(max_parts,
                                   max(2, math.ceil(payload / targets.target_kb))))]
    loads = [0.0] * len(parts)
    for f in ordered:                              # greedy: heaviest into lightest bin
        i = int(np.argmin(loads))
        parts[i].append(f)
        loads[i] += f.triangles
    return [p for p in parts if p]

def split_by_texture(features, targets, texture_kb_per_m2):
    """Texture-dominated: reduce resolution instead of splitting."""
    footprint = sum(f.footprint_m2 for f in features)
    current = footprint * texture_kb_per_m2
    if current <= targets.target_kb:
        return {"action": "none", "texture_kb": round(current, 1)}
    factor = math.sqrt(current / targets.target_kb)
    new_dim = 2 ** math.floor(math.log2(2048 / factor))
    return {"action": "resize_texture", "from_px": 2048,
            "to_px": max(int(new_dim), 256),
            "predicted_texture_kb": round(current / (2048 / max(new_dim, 256)) ** 2, 1)}
```

Splitting by feature with a greedy bin-packing, rather than by area, is the fix for the `vertices / features` outlier. Three 2-million-triangle landmarks in one cell become three tiles sharing a bounding volume — which costs a little culling efficiency and removes a 40 MB download.

The texture case gets a resize rather than a split, because splitting a texture-dominated tile spatially reproduces the atlas in every part. The factor calculation says how far to reduce: a tile four times the target needs half the texture dimension in each axis.

<figure class="diagram">
<svg viewBox="10 -2 720 238" role="img" aria-labelledby="bal-thr-t bal-thr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bal-thr-t">Fixed feature threshold against adaptive payload threshold</title>
  <desc id="bal-thr-d">Two rows of cells across a city transect from suburb to business district. With a fixed threshold of 2000 features, the suburban cells produce 9 kilobyte tiles and the business-district cells produce a 41 megabyte tile, because feature count does not track payload. With an adaptive threshold that predicts payload, the suburb cells stop subdividing earlier and produce 180 kilobyte tiles while the business district subdivides two levels further and produces 390 kilobyte tiles.</desc>
  <rect class="svg-bg" x="10" y="-2" width="720" height="238" fill="#ffffff"/>
  <text x="370" y="26" fill="#1f2937" font-size="13" text-anchor="middle">one transect: suburb → mixed → business district</text>
  <g stroke-width="1.5">
    <rect x="24" y="44" width="160" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="188" y="44" width="160" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="352" y="44" width="160" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="516" y="44" width="200" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="24" y="130" width="160" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="188" y="130" width="160" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="352" y="130" width="160" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="516" y="130" width="200" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="104" y="64">1840 features</text><text x="104" y="80">9 KB tile</text>
    <text x="268" y="64">1920 features</text><text x="268" y="80">140 KB tile</text>
    <text x="432" y="64">1960 features</text><text x="432" y="80">1.8 MB tile</text>
    <text x="616" y="64">1990 features</text><text x="616" y="80">41 MB tile</text>
    <text x="104" y="150">stopped 2 levels earlier</text><text x="104" y="166">180 KB tile</text>
    <text x="268" y="150">unchanged</text><text x="268" y="166">310 KB tile</text>
    <text x="432" y="150">1 extra level</text><text x="432" y="166">420 KB tile</text>
    <text x="616" y="150">2 extra levels + texture resize</text><text x="616" y="166">390 KB tile</text>
  </g>
  <text x="24" y="108" fill="#1f2937" font-size="12.5">fixed: subdivide above 2000 features — spread 4,600×</text>
  <text x="24" y="196" fill="#1f2937" font-size="12.5">adaptive: subdivide above a predicted 600 KB payload — spread 2.3×</text>
  <text x="24" y="218" fill="#5b6471" font-size="12">the feature counts are almost identical across the transect; the payloads differ by four orders of magnitude</text>
</svg>
<figcaption>Feature count is nearly constant across the transect while payload varies 4,600-fold, which is why a fixed threshold cannot balance anything.</figcaption>
</figure>

### 5. Detect and merge the too-small tiles

```python
def merge_undersized(tree_leaves, targets):
    """Siblings that together stay under the target should be one tile."""
    by_parent = defaultdict(list)
    for leaf in tree_leaves:
        by_parent[leaf["parent_key"]].append(leaf)

    merges, kept = [], []
    for parent, siblings in by_parent.items():
        total = sum(s["payload_kb"] for s in siblings)
        if len(siblings) > 1 and total <= targets.target_kb:
            merges.append({"parent": parent, "merged": len(siblings),
                           "payload_kb": round(total, 1),
                           "saved_requests": len(siblings) - 1})
        else:
            kept.extend(siblings)
    return {"merges": merges, "tiles_before": len(tree_leaves),
            "tiles_after": len(kept) + len(merges),
            "requests_saved": sum(m["saved_requests"] for m in merges)}
```

Undersized tiles are the less visible half of the imbalance and they cost real time. Four 9 KB siblings are four requests, four bounding-volume tests and four glTF parses for 36 KB of geometry — and on a high-latency link the four round trips dominate.

Merging is safe when the union stays under the target, and the loss is culling granularity: the merged tile is loaded whenever any of its former children would have been. At these sizes that is a good trade.

### 6. Gate on balance in CI

```python
BALANCE_GATE = {
    "max_tile_mb": 1.5,
    "max_spread_per_level": 6.0,
    "min_median_kb": 40.0,
    "max_undersized_fraction": 0.15,
}

def balance_gate(rows, gate=BALANCE_GATE):
    findings = []
    profile = level_profile(rows)
    for level in profile:
        if level["max_kb"] / 1024 > gate["max_tile_mb"]:
            findings.append({"level": level["depth"], "severity": "error",
                             "issue": f"largest tile {level['max_kb'] / 1024:.1f} MB "
                                      f"over {gate['max_tile_mb']} MB"})
        if level["spread"] > gate["max_spread_per_level"]:
            findings.append({"level": level["depth"], "severity": "error",
                             "issue": f"spread {level['spread']} over "
                                      f"{gate['max_spread_per_level']}"})
        if level["tiles"] > 8 and level["p50_kb"] < gate["min_median_kb"] \
                and level["depth"] > 0:
            findings.append({"level": level["depth"], "severity": "warn",
                             "issue": f"median {level['p50_kb']} KB — tiles too small"})
    undersized = sum(1 for r in rows if r["bytes"] < gate["min_median_kb"] * 1024)
    frac = undersized / max(len(rows), 1)
    if frac > gate["max_undersized_fraction"]:
        findings.append({"level": "all", "severity": "warn",
                         "issue": f"{frac:.0%} of tiles under "
                                  f"{gate['min_median_kb']} KB"})
    errors = [f for f in findings if f["severity"] == "error"]
    return {"tiles": len(rows), "levels": len(profile), "findings": findings[:8],
            "errors": len(errors), "pass": not errors}

result = balance_gate(rows)
print(json.dumps(result, indent=2))
assert result["pass"], "tileset balance gate failed"
```

Gating on the **spread** rather than only on the maximum is what catches a regression early. A new delivery that adds one large landmark raises the maximum by a lot and the median not at all, so a spread test fires while an absolute-size test might still pass if the ceiling was generous.

<figure class="diagram">
<svg viewBox="4 6 732 250" role="img" aria-labelledby="bal-fix-t bal-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bal-fix-t">Which fix an outlier needs</title>
  <desc id="bal-fix-d">A decision table for oversized tiles. A tile that is more than seventy percent texture needs the texture resized, not subdivision. A tile with fewer than a hundred features but millions of vertices needs splitting by feature with bin packing. A tile with many thousands of features needs a lower subdivision threshold. A tile that is merely dense needs one more level of subdivision. Groups of siblings that are all tiny need merging instead.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="250" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="320" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="20" width="384" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="320" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="338" y="52" width="384" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="86" width="320" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="338" y="86" width="384" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="120" width="320" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="120" width="384" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="154" width="320" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="154" width="384" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="188" width="320" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="188" width="384" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="178" y="41">symptom</text><text x="530" y="41">fix</text>
    <text x="178" y="74">texture is &gt; 70% of the payload</text>
    <text x="530" y="74">resize the atlas; subdividing reproduces it in every part</text>
    <text x="178" y="108">&lt; 100 features, millions of vertices</text>
    <text x="530" y="108">split by feature with bin packing, not by area</text>
    <text x="178" y="142">&gt; 6000 features, each small</text>
    <text x="530" y="142">lower the subdivision threshold for this branch</text>
    <text x="178" y="176">dense but otherwise ordinary</text>
    <text x="530" y="176">one more level of subdivision</text>
    <text x="178" y="210">siblings all under 40 KB</text>
    <text x="530" y="210">merge them — four requests for 36 KB is waste</text>
  </g>
  <text x="370" y="238" fill="#5b6471" font-size="12" text-anchor="middle">subdividing further is the right answer for only one of these five</text>
</svg>
<figcaption>Four of the five oversized cases are not fixed by more subdivision, which is why the anatomy step comes before the fix.</figcaption>
</figure>

## Expected Output & Verification

```text
{'depth': 0, 'tiles': 1, 'total_mb': 0.0, 'p50_kb': 6.0, 'p95_kb': 6.0, 'max_kb': 18.0,
 'min_kb': 6.0, 'spread': 3.0}
{'depth': 3, 'tiles': 412, 'total_mb': 214.8, 'p50_kb': 410.2, 'p95_kb': 1840.5,
 'max_kb': 41984.0, 'min_kb': 9.1, 'spread': 102.3}
content/3/14/9.glb                   41.98 MB  tex 94%  texture-dominated — resize or recompress
content/3/12/7.glb                    8.60 MB  tex 11%  few very detailed features — split by feature, not by area
content/4/28/19.glb                   3.12 MB  tex 62%  dense geometry — subdivide further
{'action': 'resize_texture', 'from_px': 2048, 'to_px': 512, 'predicted_texture_kb': 2464.0}
{'merges': [...], 'tiles_before': 1402, 'tiles_after': 1188, 'requests_saved': 214}
{
  "tiles": 1188,
  "levels": 6,
  "findings": [],
  "errors": 0,
  "pass": true
}
```

Level 3's spread of 102 before the fix and the 41.98 MB tile at 94% texture are the same finding seen two ways. The merge pass removed 214 requests by consolidating undersized siblings, which is a latency win that the payload histogram does not show.

Verify the tree is still correct after splitting and merging, because both operations move features between tiles:

```python
def integrity_check(tileset_path, expected_features, content_root="output/city"):
    doc = json.loads(Path(tileset_path).read_text())
    root_dir = Path(content_root)
    seen_features = 0
    problems = []

    def walk(tile, depth, parent_ge, parent_region):
        nonlocal seen_features
        ge = tile.get("geometricError")
        if parent_ge is not None and ge is not None and ge >= parent_ge:
            problems.append(f"depth {depth}: geometricError {ge} >= parent {parent_ge}")
        bv = (tile.get("boundingVolume") or {}).get("region")
        if bv and parent_region:
            for i, (v, p) in enumerate(zip(bv[:4], parent_region[:4])):
                if (i < 2 and v < p - 1e-9) or (i >= 2 and v > p + 1e-9):
                    problems.append(f"depth {depth}: region escapes parent")
                    break
        count = ((tile.get("metadata") or {}).get("properties") or {}).get("featureCount")
        uri = (tile.get("content") or {}).get("uri")
        if uri and not uri.endswith(".json"):
            if not (root_dir / uri).exists():
                problems.append(f"missing content {uri}")
            seen_features += count or 0
        for child in tile.get("children", []):
            walk(child, depth + 1, ge, bv or parent_region)

    walk(doc["root"], 0, doc.get("geometricError"), None)
    return {"features_expected": expected_features, "features_in_tileset": seen_features,
            "conserved": seen_features == expected_features,
            "problems": problems[:5], "clean": not problems}

print(integrity_check("output/city/tileset.json", 412418))
```

Feature conservation is the property both fixes threaten. A bin-packing split that drops the last bin, or a merge that writes one content file and forgets to remove its siblings' entries, both produce a tileset that validates and is missing buildings.

Then verify the balance improvement translates into a better worst-case view:

```python
def worst_view_check(rows, tileset_path, views, content_root="output/city"):
    """The metric users feel: bytes to fill the worst view."""
    doc = json.loads(Path(tileset_path).read_text())
    by_uri = {r["uri"]: r["bytes"] for r in rows}
    results = []
    for name, uris in views.items():
        total = sum(by_uri.get(u, 0) for u in uris)
        biggest = max(((u, by_uri.get(u, 0)) for u in uris),
                      key=lambda kv: kv[1], default=("none", 0))
        results.append({"view": name, "tiles": len(uris),
                        "total_mb": round(total / 1e6, 2),
                        "largest_tile_mb": round(biggest[1] / 1e6, 2),
                        "largest_share": round(biggest[1] / max(total, 1), 2)})
    worst = max(results, key=lambda r: r["total_mb"])
    return {"views": results, "worst_view": worst["view"],
            "worst_mb": worst["total_mb"],
            "dominated_by_one_tile": worst["largest_share"] > 0.4}

print(json.dumps(worst_view_check(rows, "output/city/tileset.json", VIEWS), indent=2))
```

`dominated_by_one_tile` is the check that says whether the balancing worked from the user's side. A view whose payload is 60% one tile has not been balanced, whatever the histogram says.

## Performance Notes

- **400 KB per tile is a good target** for city geometry on a broadband link: large enough that latency is amortised, small enough that a single tile never blocks a frame.
- **1.5 MB is a reasonable ceiling.** Above that, a tile's parse time alone becomes visible as a hitch.
- **Below 40 KB, merge.** The request overhead exceeds the payload.
- **Recalibrate the bytes-per-vertex constant** from a real run; it varies by a factor of two between quantisation settings.
- **The gate runs on file sizes**, so it costs a directory walk — seconds on a 6,000-tile city, cheap enough for every build.
- **Balance matters more than total size.** A 20 GB tileset with a 1.2 MB ceiling streams better than a 12 GB one with a 40 MB outlier.

## Common Errors

**Subdivision runs forever on one cell.** A feature larger than the cell keeps the payload above the ceiling at every depth. Add the depth cap and the feature-split path.

**Splitting a texture-dominated tile made things worse.** Each part carries the same atlas. Resize instead.

**Merging broke culling.** Merged tiles span the union of their children's volumes, so a camera seeing any part loads all. Only merge when the union stays under the target.

**Feature count no longer matches.** A bin-packing split dropped an empty bin, or a merge left orphaned tileset entries. Check conservation.

**Spread is fine and the tileset still streams badly.** The problem is level *depth*, not balance — too few levels means the first view loads leaf detail. Check the geometric errors.

**The gate fails on the root tile.** The root often has no content or a tiny one. Exclude depth 0 from the median test, as above.

## Frequently Asked Questions

### Should every level have the same target payload?

Roughly, yes. A level whose tiles are much larger than another's means the geometric errors are mismatched to the content, and the client will refine unevenly.

### Does implicit tiling help with balance?

No — implicit tiling fixes the *structure*, so it cannot adapt the subdivision to payload. It is the right choice for uniformly dense data and the wrong choice for a city with a business district.

### How do I balance a point-cloud tileset?

By points per tile rather than bytes, and the mechanism is the same: measure the distribution, subdivide where the count exceeds the ceiling, and merge sparse siblings. Point payloads are far more predictable than mesh payloads, so a fixed threshold works better there.

## Related Guides

- [Octree vs Quadtree Subdivision for Tall Buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/octree-vs-quadtree-subdivision-for-tall-buildings/) — the structural choice this tunes
- [gltfpack Settings for 3D Tiles Content](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/gltfpack-settings-for-3d-tiles-content/) — fixing texture-dominated outliers
- [Choosing Shard Sizes for City-Scale Tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/choosing-shard-sizes-for-city-scale-tiling/) — the same balance question for build work

Back to [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/).
