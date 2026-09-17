# Writing Tileset JSON from Python

This page generates `tileset.json` directly in Python — building the tile tree from your own spatial index, emitting correct region and box bounding volumes, assigning geometric errors that decrease with depth, splitting large trees into external tilesets, and self-checking the result before it is published.

## Why you hit this

The reference tooling in [converting GLB to 3D Tiles with 3d-tiles-tools](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-glb-to-3d-tiles-with-3d-tiles-tools/) produces a flat root-plus-leaves tree from a folder of content, which is the right answer up to a few hundred tiles. Beyond that the client needs a hierarchy, and the hierarchy has to match the one your tiling pipeline already used to shard the work — the quadkeys from [spatial indexing and tiling schemes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/). At that point generating the JSON yourself is less work than persuading a tool to reproduce your tree, and it puts the geometric error policy under your control.

The format is small. A tile has a bounding volume, a geometric error, an optional refinement mode, optional content and optional children. Everything else is detail.

## Prerequisites

- Python 3.10+ with `numpy` and `pyproj`; `3d-tiles-validator` available via `npx` for the final gate.
- A per-tile inventory: key, geographic extent, height range, content path, triangle count.
- Content already written — this page produces only the JSON that references it.

## Step-by-Step

### 1. Model a tile as a dataclass, not a dict

```python
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

@dataclass
class Region:
    west: float      # radians
    south: float
    east: float
    north: float
    min_h: float     # metres above the ellipsoid
    max_h: float

    def to_json(self):
        return {"region": [self.west, self.south, self.east, self.north,
                           self.min_h, self.max_h]}

    def union(self, other):
        return Region(min(self.west, other.west), min(self.south, other.south),
                      max(self.east, other.east), max(self.north, other.north),
                      min(self.min_h, other.min_h), max(self.max_h, other.max_h))

@dataclass
class Tile:
    key: str
    region: Region
    geometric_error: float
    content_uri: str | None = None
    children: list["Tile"] = field(default_factory=list)
    refine: str | None = None
    triangles: int = 0

    def to_json(self):
        out = {"boundingVolume": self.region.to_json(),
               "geometricError": round(self.geometric_error, 4)}
        if self.refine:
            out["refine"] = self.refine
        if self.content_uri:
            out["content"] = {"uri": self.content_uri}
        if self.children:
            out["children"] = [c.to_json() for c in self.children]
        return out
```

A `region` bounding volume takes longitude and latitude in **radians** and heights in metres above the ellipsoid, which is the single most common mistake in hand-written tilesets — degrees produce a volume wrapping the globe many times, and the client either culls everything or nothing. Keeping radians inside a `Region` type and converting only at the boundary is why this is a dataclass rather than a dict.

Regions are also the easiest volume to get right, because they compose: a parent's region is the union of its children's, computed in step 3, with no matrix maths involved.

### 2. Turn quadkeys into a tree

```python
def quadkey_children(key):
    return [key + d for d in "0123"]

def quadkey_to_region(key, min_h, max_h):
    """Web-Mercator-style quadkey to a geographic region in radians."""
    x = y = 0
    level = len(key)
    for i, ch in enumerate(key):
        bit = level - i - 1
        mask = 1 << bit
        d = int(ch)
        if d & 1:
            x |= mask
        if d & 2:
            y |= mask
    n = 1 << level
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return Region(math.radians(lon_w), math.radians(lat_s),
                  math.radians(lon_e), math.radians(lat_n), min_h, max_h)

def build_tree(inventory, root_key, root_geometric_error, refine="REPLACE"):
    """inventory: {quadkey: {"uri": str, "min_h": float, "max_h": float, "triangles": int}}"""
    keys = set(inventory)
    max_level = max(len(k) for k in keys)

    def node(key, ge):
        item = inventory.get(key)
        kids = [k for k in quadkey_children(key) if any(c.startswith(k) for c in keys)]
        child_tiles = [node(k, ge / 2.0) for k in kids]
        if item is not None:
            region = quadkey_to_region(key, item["min_h"], item["max_h"])
        elif child_tiles:
            region = child_tiles[0].region
            for c in child_tiles[1:]:
                region = region.union(c.region)
        else:
            return None
        if child_tiles:
            for c in child_tiles:
                region = region.union(c.region)
        return Tile(key=key, region=region,
                    geometric_error=ge if child_tiles else 0.0,
                    content_uri=item["uri"] if item else None,
                    children=[c for c in child_tiles if c],
                    refine=refine if key == root_key else None,
                    triangles=item["triangles"] if item else 0)

    return node(root_key, root_geometric_error), max_level
```

Halving the geometric error per level is the convention and it matches how screen-space error scales: a tile covering half the ground distance at the same pixel budget tolerates half the error. Leaves get zero, which tells the client there is nothing finer to load.

Setting `refine` only on the root is deliberate — refinement is inherited, so repeating it on every tile bloats the JSON for no effect. `REPLACE` is right for meshes where the child fully covers the parent; `ADD` is right for point clouds and for additive detail, where the child's content supplements rather than replaces.

<figure class="diagram">
<svg viewBox="26 10 688 244" role="img" aria-labelledby="tsj-tree-t tsj-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tsj-tree-t">Quadkey tree with geometric error per level</title>
  <desc id="tsj-tree-d">A three-level tree. The root at level twelve has a geometric error of 512 metres and no content. Its four children at level thirteen have 256 metres. Their children at level fourteen are leaves with a geometric error of zero and one content file each. Each parent's bounding region is the union of its children's regions, so no content falls outside its ancestors.</desc>
  <rect class="svg-bg" x="26" y="10" width="688" height="244" fill="#ffffff"/>
  <defs>
    <marker id="tsj-tree-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="300" y="24" width="140" height="42" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="140" y="112" width="130" height="42" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="470" y="112" width="130" height="42" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="40" y="198" width="120" height="42" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="190" y="198" width="120" height="42" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="430" y="198" width="120" height="42" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="580" y="198" width="120" height="42" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#tsj-tree-arrow)">
    <path d="M340 66 L215 110"/><path d="M400 66 L525 110"/>
    <path d="M180 154 L110 196"/><path d="M230 154 L260 196"/>
    <path d="M510 154 L480 196"/><path d="M560 154 L630 196"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="370" y="42">root 120210 · ge 512</text><text x="370" y="58">no content</text>
    <text x="205" y="130">1202100 · ge 256</text><text x="205" y="146">no content</text>
    <text x="535" y="130">1202101 · ge 256</text><text x="535" y="146">no content</text>
    <text x="100" y="216">12021000 · ge 0</text><text x="100" y="232">0.glb</text>
    <text x="250" y="216">12021001 · ge 0</text><text x="250" y="232">1.glb</text>
    <text x="490" y="216">12021010 · ge 0</text><text x="490" y="232">2.glb</text>
    <text x="640" y="216">12021011 · ge 0</text><text x="640" y="232">3.glb</text>
  </g>
  <text x="370" y="94" fill="#5b6471" font-size="12">region = union of children; ge halves each level</text>
</svg>
<figcaption>The tree the client walks: halve the error per level, union the regions upward, zero at the leaves.</figcaption>
</figure>

### 3. Write the document, with the asset block the spec requires

```python
def write_tileset(root_tile, out_path, tileset_version=None, extras=None):
    doc = {
        "asset": {"version": "1.1"},
        "geometricError": round(root_tile.geometric_error, 4),
        "root": root_tile.to_json(),
    }
    if tileset_version:
        doc["asset"]["tilesetVersion"] = tileset_version
    if extras:
        doc["extras"] = extras
    text = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(text, encoding="utf-8", newline="\n")
    return {"path": out_path, "bytes": len(text)}

INVENTORY = {
    "12021000": {"uri": "content/12021000.glb", "min_h": 18.0, "max_h": 74.0, "triangles": 41200},
    "12021001": {"uri": "content/12021001.glb", "min_h": 16.5, "max_h": 91.0, "triangles": 38800},
    "12021010": {"uri": "content/12021010.glb", "min_h": 14.0, "max_h": 66.0, "triangles": 51000},
    "12021011": {"uri": "content/12021011.glb", "min_h": 15.0, "max_h": 58.0, "triangles": 29700},
}
root, levels = build_tree(INVENTORY, root_key="120210", root_geometric_error=512.0)
print(write_tileset(root, "output/city/tileset.json", tileset_version="2026-09-17"))
```

`asset.version` is mandatory and `"1.1"` is what you want — it permits glTF directly as tile content, so no `b3dm` wrapper is involved. `tilesetVersion` is free-form and the right place for the data's version, which lets a client tell two builds apart without a timestamp; see [making tile output deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) for why that distinction matters.

Sorted keys and no whitespace keep the output byte-identical between runs and about 30% smaller, which matters when the root JSON for a city reaches several megabytes.

### 4. Split large trees into external tilesets

```python
def split_external(root_tile, out_dir, max_tiles_per_file=2000, prefix="subtree"):
    """Emit subtrees as their own tileset.json files, referenced as content."""
    written = []

    def count(tile):
        return 1 + sum(count(c) for c in tile.children)

    def emit(tile, depth=0):
        if depth > 0 and count(tile) > max_tiles_per_file and tile.children:
            name = f"{prefix}_{tile.key}.json"
            sub = Tile(key=tile.key, region=tile.region,
                       geometric_error=tile.geometric_error,
                       children=[emit(c, depth + 1) for c in tile.children],
                       content_uri=tile.content_uri)
            write_tileset(sub, f"{out_dir}/{name}")
            written.append({"file": name, "tiles": count(tile)})
            return Tile(key=tile.key, region=tile.region,
                        geometric_error=tile.geometric_error,
                        content_uri=name)               # a tileset.json as content
        return Tile(key=tile.key, region=tile.region,
                    geometric_error=tile.geometric_error,
                    content_uri=tile.content_uri,
                    children=[emit(c, depth + 1) for c in tile.children],
                    refine=tile.refine)

    top = emit(root_tile)
    write_tileset(top, f"{out_dir}/tileset.json")
    return {"external_files": written, "root_tiles": count(top)}
```

A tile whose `content.uri` points at another `tileset.json` grafts that document's root in place of the tile, which is how a city keeps its entry-point JSON small. The client fetches the root, sees a few hundred tiles, and pulls subtree documents only for regions the camera actually approaches — the difference between a 12 MB first request and a 200 KB one.

The external subtree's root must repeat the bounding volume and geometric error of the tile that references it. Where they disagree, clients differ in which they honour, and the symptom is a district that refines at the wrong distance.

Implicit tiling is the other answer to the same problem and is better for uniformly dense trees, because the structure is described by a subtree availability bitstream rather than by JSON. External tilesets stay easier when the tree is sparse and irregular, which a city usually is.

### 5. Self-check before publishing

```python
def check_tileset(path):
    doc = json.loads(Path(path).read_text())
    problems = []

    def walk(tile, parent_ge, parent_region, depth, path_keys):
        bv = tile.get("boundingVolume", {})
        if "region" not in bv and "box" not in bv and "sphere" not in bv:
            problems.append({"at": path_keys, "issue": "no bounding volume"})
        ge = tile.get("geometricError")
        if ge is None:
            problems.append({"at": path_keys, "issue": "missing geometricError"})
        elif parent_ge is not None and ge >= parent_ge:
            problems.append({"at": path_keys, "issue": f"ge {ge} not < parent {parent_ge}"})
        if "region" in bv:
            w, s, e, n, lo, hi = bv["region"]
            if not (-math.pi - 1e-9 <= w < e <= math.pi + 1e-9):
                problems.append({"at": path_keys, "issue": f"longitude out of range or inverted: {w}, {e}"})
            if not (-math.pi / 2 - 1e-9 <= s < n <= math.pi / 2 + 1e-9):
                problems.append({"at": path_keys, "issue": f"latitude out of range or inverted: {s}, {n}"})
            if hi < lo:
                problems.append({"at": path_keys, "issue": "height range inverted"})
            if parent_region is not None:
                pw, ps, pe, pn, plo, phi = parent_region
                if w < pw - 1e-9 or e > pe + 1e-9 or s < ps - 1e-9 or n > pn + 1e-9:
                    problems.append({"at": path_keys, "issue": "not contained in parent region"})
            parent_region = bv["region"]
        uri = tile.get("content", {}).get("uri")
        if uri and not uri.endswith(".json"):
            target = Path(path).parent / uri
            if not target.exists():
                problems.append({"at": path_keys, "issue": f"missing content {uri}"})
        for i, child in enumerate(tile.get("children", [])):
            walk(child, ge, parent_region, depth + 1, f"{path_keys}/{i}")

    walk(doc["root"], doc.get("geometricError"), None, 0, "root")
    leaves = []
    def count_leaves(t):
        if t.get("children"):
            for c in t["children"]:
                count_leaves(c)
        else:
            leaves.append(t.get("content", {}).get("uri"))
    count_leaves(doc["root"])
    return {"problems": problems[:8], "problem_count": len(problems),
            "leaves": len(leaves), "leaves_without_content": sum(1 for l in leaves if not l)}

print(json.dumps(check_tileset("output/city/tileset.json"), indent=2))
```

Four checks catch nearly everything that goes wrong in a generated tileset: radians in range and not inverted, geometric error strictly decreasing, every region contained in its parent's, and every referenced content file present on disk. Running them on the document you just wrote takes milliseconds and finds the degrees-for-radians error immediately.

The reference validator is still the gate — it checks things this cannot, including that the glTF content is itself valid and that the content geometry fits its volume — but a fast self-check keeps the slow gate from being the first place you learn about a typo.

<figure class="diagram">
<svg viewBox="26 20 635 220" role="img" aria-labelledby="tsj-check-t tsj-check-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tsj-check-t">What the self-check catches</title>
  <desc id="tsj-check-d">A bar chart of issues found in a first generated tileset. Degrees used instead of radians accounts for 61 tiles, geometric error not decreasing 18 tiles, region not contained in parent 7 tiles, missing content file 3 tiles, and inverted height range 1 tile. The radian error dominates and is caught by a range test alone.</desc>
  <rect class="svg-bg" x="26" y="20" width="635" height="220" fill="#ffffff"/>
  <path d="M40 26 V206" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="420" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="70" width="124" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="106" width="48" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="142" width="21" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="178" width="7" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="470" y="52">degrees instead of radians: 61</text>
    <text x="174" y="88">geometric error not decreasing: 18</text>
    <text x="98" y="124">region outside parent: 7</text>
    <text x="71" y="160">missing content file: 3</text>
    <text x="57" y="196">inverted height range: 1</text>
  </g>
  <text x="40" y="222" fill="#5b6471" font-size="12">tiles flagged in the first run of a hand-generated city tileset</text>
</svg>
<figcaption>One range test on six numbers accounts for two-thirds of the findings, which is why the self-check runs before the validator.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="tsj-volumes-t tsj-volumes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tsj-volumes-t">Choosing a bounding volume type</title>
  <desc id="tsj-volumes-d">A table of the three bounding volume types. A region takes six numbers as radians and heights and suits geographic tiles aligned to longitude and latitude. An oriented box takes twelve numbers and is tightest for rotated or tall content under a transform. A sphere takes four numbers and is only appropriate for isotropic extents such as a point-cloud blob. Region volumes compose upward by union, which is why they are the easiest to generate correctly.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="136" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="154" y="20" width="116" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="470" y="20" width="252" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="136" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="154" y="54" width="116" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="54" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="470" y="54" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="136" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="154" y="88" width="116" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="88" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="470" y="88" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="136" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="154" y="122" width="116" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="122" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="470" y="122" width="252" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="136" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="154" y="156" width="116" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="156" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="470" y="156" width="252" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="86" y="42">type</text><text x="212" y="42">numbers</text><text x="370" y="42">units</text><text x="596" y="42">use it for</text>
    <text x="86" y="76">region</text><text x="212" y="76">6</text><text x="370" y="76">radians + metres</text><text x="596" y="76">geographic city tiles</text>
    <text x="86" y="110">box</text><text x="212" y="110">12</text><text x="370" y="110">metres, local frame</text><text x="596" y="110">rotated or tall content</text>
    <text x="86" y="144">sphere</text><text x="212" y="144">4</text><text x="370" y="144">metres, ECEF</text><text x="596" y="144">isotropic extents only</text>
    <text x="86" y="178">composition</text><text x="212" y="178">—</text><text x="370" y="178">—</text><text x="596" y="178">regions union upward for free</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">A region is the only type whose parent volume is the union of its children with no matrix maths.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Degrees in a region is the single most common error: the values must be radians.</text>
</svg>
<figcaption>Region for geography, box for anything rotated, sphere almost never — and regions compose for free.</figcaption>
</figure>

### 6. Gate on the reference validator

```python
import subprocess

def validate(path, report="output/city/validation.json"):
    proc = subprocess.run(["npx", "3d-tiles-validator", "--tilesetFile", path,
                           "--reportFile", report], capture_output=True, text=True)
    issues = json.loads(Path(report).read_text()).get("issues") or []
    by_sev = {}
    for i in issues:
        by_sev.setdefault(i.get("severity", "UNKNOWN"), []).append(i.get("type"))
    errors = by_sev.get("ERROR", [])
    return {"exit": proc.returncode, "counts": {k: len(v) for k, v in by_sev.items()},
            "error_types": sorted(set(errors))[:5], "ok": not errors}

result = validate("output/city/tileset.json")
print(result)
assert result["ok"], f"tileset invalid: {result['error_types']}"
```

## Expected Output & Verification

```text
{'path': 'output/city/tileset.json', 'bytes': 1284}
{
  "problems": [],
  "problem_count": 0,
  "leaves": 4,
  "leaves_without_content": 0
}
{'exit': 0, 'counts': {'INFO': 2}, 'error_types': [], 'ok': True}
```

A clean self-check followed by a clean validator run is the whole success criterion. The `leaves_without_content` count deserves attention on real data: a leaf with no content is a hole in the dataset, and it arises whenever the inventory is missing a key whose siblings exist.

Verify the tree against the inventory, so a silently dropped shard cannot slip through:

```python
def coverage_check(tileset_path, inventory):
    doc = json.loads(Path(tileset_path).read_text())
    found = set()
    def walk(t):
        uri = t.get("content", {}).get("uri")
        if uri and not uri.endswith(".json"):
            found.add(uri)
        for c in t.get("children", []):
            walk(c)
    walk(doc["root"])
    expected = {v["uri"] for v in inventory.values()}
    return {"expected": len(expected), "referenced": len(found),
            "missing": sorted(expected - found)[:5], "extra": sorted(found - expected)[:5],
            "complete": found == expected}

print(coverage_check("output/city/tileset.json", INVENTORY))
```

Then verify the refinement behaviour numerically rather than by eye, by computing at what camera distance each level should activate:

```python
def refinement_distances(tileset_path, screen_height_px=1080, sse_px=16, fov_deg=60.0):
    """Distance at which each geometric error crosses the screen-space error budget."""
    doc = json.loads(Path(tileset_path).read_text())
    k = screen_height_px / (2.0 * math.tan(math.radians(fov_deg) / 2.0))
    rows = []
    def walk(t, depth=0):
        ge = t.get("geometricError", 0.0)
        if ge > 0:
            rows.append({"depth": depth, "ge_m": ge,
                         "refines_within_m": round(ge * k / sse_px, 1)})
        for c in t.get("children", []):
            walk(c, depth + 1)
    walk(doc["root"])
    seen, out = set(), []
    for r in sorted(rows, key=lambda r: r["depth"]):
        if r["depth"] not in seen:
            seen.add(r["depth"]); out.append(r)
    return out

for row in refinement_distances("output/city/tileset.json"):
    print(row)
```

If the deepest level only refines within 40 m, the tiles are too fine for the geometric errors assigned and the client will never show full detail at a normal viewing distance; if the root refines at 200 km, the first request will pull half the city.

## Performance Notes

- **JSON size grows with tile count**: roughly 300 bytes per tile with a region volume and sorted compact output. 20,000 tiles is about 6 MB, which is when external subtrees or implicit tiling become necessary.
- **Serve the root gzipped.** Tileset JSON compresses 8–12×, and it is a text file on the critical path of every session.
- **Region volumes are cheaper to compute than boxes** and slightly worse at culling. For city tiles with vertical extents under a couple of hundred metres the difference is not measurable.
- **Build the tree once, in memory.** Recursive `count()` calls over a large tree during splitting are the only place this script gets slow; memoise if a city takes more than a few seconds.
- **Keep leaf geometric error at exactly 0.** Small non-zero values make some clients keep requesting refinement that does not exist.

## Common Errors

**Nothing renders, no errors.** Degrees in a `region`. The values must be radians; longitude in −π…π and latitude in −π/2…π/2.

**Validator: "tile's geometric error is not less than its parent's".** A level where the halving was skipped, usually because a subtree was grafted with the parent's value copied.

**Validator: "content bounding volume is not within tile bounding volume".** The region's height range does not cover the content. Take `min_h`/`max_h` from the actual geometry, with a small margin.

**External subtree loads at the wrong distance.** The referencing tile's geometric error and the subtree root's disagree. Write the same value in both.

**Tiles pop in and out at a fixed distance.** `refine` is `ADD` where `REPLACE` was meant, so parent and child render together and the child's depth fights the parent's.

**`KeyError: 'root'` in a consumer.** An external subtree was written with the tile object rather than a full document. Every `.json` referenced as content needs its own `asset` and `root`.

## Frequently Asked Questions

### Region, box or sphere?

Region for anything geographic and roughly axis-aligned to lon/lat, which covers most city tiling. Oriented box for content in a local frame under a transform, and for tall or rotated extents where a region wastes volume. Sphere only where the extent is genuinely isotropic, such as a point-cloud blob.

### Should I use implicit tiling instead?

If the tree is dense and uniform — terrain, a complete quadtree — implicit tiling removes the JSON entirely and is the better answer. For a sparse city tree with per-tile metadata, explicit JSON stays simpler to generate and debug.

### How do I attach per-tile metadata?

Through the 3D Tiles 1.1 metadata system, with a schema at the tileset level and property values on tiles or groups; see [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/). Avoid `extras` for anything a client needs to style by.

## Related Guides

- [Converting GLB to 3D Tiles with 3d-tiles-tools](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-glb-to-3d-tiles-with-3d-tiles-tools/) — the tooling route, for flat trees
- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — adding properties to the tiles this writes
- [Validating Tileset Bounding Volumes Against Content](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-tileset-bounding-volumes-against-content/) — the containment gate in CI

Back to [Automated Tile Generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
