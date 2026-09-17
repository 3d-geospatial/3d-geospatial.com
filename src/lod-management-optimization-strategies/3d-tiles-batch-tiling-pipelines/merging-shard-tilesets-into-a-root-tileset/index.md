---
title: "Merging Shard Tilesets into a Root Tileset"
description: "Combine thousands of independently built shard tilesets into one 3D Tiles root: external tileset references, region unions, geometric error ordering and a grouped hierarchy."
---
# Merging Shard Tilesets into a Root Tileset

This page combines independently built shard tilesets — one `tileset.json` per city block or quadkey cell — into a single root tileset that a viewer loads with one URL, using 3D Tiles external tileset references, bounding regions unioned in radians on the WGS84 ellipsoid (EPSG:4979), geometric errors that decrease strictly down the tree, and an intermediate grouping level so the root never has thousands of direct children.

## Why you hit this

Batch tiling pipelines shard a city so that shards can be built in parallel and rebuilt independently — the pattern in [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/). The viewer, though, wants one entry point. The naive merge writes a root with every shard as a direct child, and it works in a demo with twelve shards. With four thousand, the runtime evaluates four thousand bounding volumes every frame before it refines anything, the root tileset is several megabytes of JSON downloaded before the first tile appears, and one shard with a bad bounding volume or an oversized geometric error makes the whole city refine too early or never.

## Prerequisites

- Python 3.10+ with the standard library `json` and `math` modules, plus `numpy>=1.24`.
- Shard tilesets on disk or object storage, each with a root `boundingVolume` as a `region` in radians. Shards that only have a `box` under a `transform` need a region computed for them first — see step 1.
- Node.js 18+ for `npx 3d-tiles-validator`, used in verification.

## Step-by-Step

### 1. Read every shard's root bounds and geometric error

```python
import json
import math
from pathlib import Path

SHARDS = Path("build/shards")

def shard_summary(path):
    ts = json.loads(path.read_text())
    root = ts["root"]
    bv = root["boundingVolume"]
    if "region" not in bv:
        raise ValueError(f"{path}: root bounding volume must be a region for merging, got {list(bv)}")
    return {
        "uri": path.relative_to(SHARDS.parent).as_posix(),
        "region": bv["region"],                     # [west, south, east, north, minH, maxH]
        "geometric_error": ts["geometricError"],
        "version": ts["asset"]["version"],
    }

shards = [shard_summary(p) for p in sorted(SHARDS.glob("*/tileset.json"))]
versions = {s["version"] for s in shards}
print(f"{len(shards)} shards, asset versions {versions}")
assert len(versions) == 1, "mixed 3D Tiles versions: migrate before merging"
```

The merge works in regions — longitude, latitude and height bounds on the ellipsoid — because a region means the same thing at every level of the tree regardless of any `transform` in a child. A shard whose root is a `box` under an ENU transform describes its bounds in a local frame; putting that box under a parent without the same transform places it at the centre of the Earth. Convert such shards once, by transforming the box's eight corners to longitude and latitude and taking their extremes plus a small margin.

### 2. Group shards into an intermediate level

```python
from collections import defaultdict

def quadkey_prefix(uri, length):
    return Path(uri).parent.name[:length]           # shard directories are named by quadkey

GROUP_PREFIX = 12                                   # shards are z16; group at z12 → up to 256 per group
groups = defaultdict(list)
for s in shards:
    groups[quadkey_prefix(s["uri"], GROUP_PREFIX)].append(s)

sizes = sorted(len(g) for g in groups.values())
print(f"{len(groups)} groups, children per group: min {sizes[0]}, median {sizes[len(sizes) // 2]}, max {sizes[-1]}")
```

Grouping by quadkey prefix is free when shard directories are already named by quadkey, and it produces spatially compact groups whose regions barely overlap. A few hundred children per group and a few dozen groups under the root keeps every node's child list short enough that culling it costs nothing measurable.

<figure class="diagram">
<svg viewBox="6 6 748 256" role="img" aria-labelledby="mst-tree-t mst-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mst-tree-t">Flat and grouped root tilesets</title>
  <desc id="mst-tree-d">On the left, a root tileset has four thousand shard tilesets as direct children, so every frame tests four thousand bounding volumes. On the right, the root has sixteen group nodes, each with up to two hundred and fifty-six shard references, so a typical view tests sixteen groups and then only the children of the two or three groups in view.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="256" fill="#ffffff"/>
  <rect x="20" y="20" width="330" height="190" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="410" y="20" width="330" height="190" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="135" y="40" width="100" height="30" rx="5" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="525" y="40" width="100" height="30" rx="5" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.2">
    <rect x="40" y="150" width="24" height="18"/><rect x="70" y="150" width="24" height="18"/><rect x="100" y="150" width="24" height="18"/><rect x="130" y="150" width="24" height="18"/>
    <rect x="160" y="150" width="24" height="18"/><rect x="190" y="150" width="24" height="18"/><rect x="220" y="150" width="24" height="18"/><rect x="250" y="150" width="24" height="18"/>
    <rect x="280" y="150" width="24" height="18"/><rect x="310" y="150" width="24" height="18"/>
    <rect x="440" y="100" width="60" height="24"/><rect x="545" y="100" width="60" height="24"/><rect x="650" y="100" width="60" height="24"/>
    <rect x="430" y="160" width="20" height="16"/><rect x="455" y="160" width="20" height="16"/><rect x="480" y="160" width="20" height="16"/>
    <rect x="645" y="160" width="20" height="16"/><rect x="670" y="160" width="20" height="16"/><rect x="695" y="160" width="20" height="16"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M185 70 L52 148"/><path d="M185 70 L112 148"/><path d="M185 70 L172 148"/><path d="M185 70 L232 148"/><path d="M185 70 L292 148"/><path d="M185 70 L322 148"/>
    <path d="M575 70 L470 98"/><path d="M575 70 L575 98"/><path d="M575 70 L680 98"/>
    <path d="M470 124 L440 158"/><path d="M470 124 L490 158"/><path d="M680 124 L655 158"/><path d="M680 124 L705 158"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="185" y="60">root</text>
    <text x="575" y="60">root</text>
    <text x="185" y="192">4,096 children tested per frame</text>
    <text x="575" y="200">16 groups, then only visible ones</text>
  </g>
  <text x="380" y="244" fill="#15384a" font-size="12.5" text-anchor="middle">One extra level turns a linear scan into a two-step lookup.</text>
</svg>
<figcaption>The grouped hierarchy costs one additional small JSON per group and removes the per-frame cost of culling thousands of siblings at the root.</figcaption>
</figure>

### 3. Union regions and choose geometric errors

```python
def union_regions(regions):
    w = min(r[0] for r in regions); s = min(r[1] for r in regions)
    e = max(r[2] for r in regions); n = max(r[3] for r in regions)
    lo = min(r[4] for r in regions); hi = max(r[5] for r in regions)
    assert e - w < math.pi, "group crosses the antimeridian or spans half the globe"
    return [w, s, e, n, lo, hi]

def region_diagonal_m(region, radius=6378137.0):
    w, s, e, n, lo, hi = region
    dx = (e - w) * radius * math.cos((s + n) / 2)
    dy = (n - s) * radius
    return math.sqrt(dx * dx + dy * dy + (hi - lo) ** 2)

group_nodes = []
for prefix, members in sorted(groups.items()):
    region = union_regions([m["region"] for m in members])
    child_max_ge = max(m["geometric_error"] for m in members)
    group_ge = max(child_max_ge * 2.0, region_diagonal_m(region) / 20.0)
    group_nodes.append({
        "boundingVolume": {"region": region},
        "geometricError": group_ge,
        "refine": "ADD",
        "children": [
            {"boundingVolume": {"region": m["region"]},
             "geometricError": m["geometric_error"],
             "content": {"uri": m["uri"]}}
            for m in members
        ],
    })
```

Two rules decide the geometric errors. A child reference in the parent must carry the shard's *own* root geometric error, because that is the value the runtime compares against when deciding whether to load the external tileset. And every node must have a geometric error strictly larger than any of its children, or the runtime can decide to refine a child before its parent — the familiar symptom being a group that stays blank until the camera is very close. The group has no content of its own, so its error only controls *when* its children are considered; a fraction of the group's diagonal is a sensible scale. The derivation of geometric error from real geometry is in [computing geometric error for 3D Tiles levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/).

### 4. Write group tilesets and the root

```python
OUT = Path("build")

def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))

root_children = []
for prefix, node in zip(sorted(groups), group_nodes):
    group_path = OUT / "groups" / f"{prefix}.json"
    for child in node["children"]:
        child["content"]["uri"] = "../" + child["content"]["uri"]
    write_json(group_path, {
        "asset": {"version": "1.1"},
        "geometricError": node["geometricError"],
        "root": node,
    })
    root_children.append({
        "boundingVolume": node["boundingVolume"],
        "geometricError": node["geometricError"],
        "content": {"uri": f"groups/{prefix}.json"},
    })

city_region = union_regions([c["boundingVolume"]["region"] for c in root_children])
root_ge = max(c["geometricError"] for c in root_children) * 2.0
write_json(OUT / "tileset.json", {
    "asset": {"version": "1.1", "tilesetVersion": "city-2026-09-17"},
    "geometricError": root_ge,
    "root": {"boundingVolume": {"region": city_region}, "geometricError": root_ge,
             "refine": "ADD", "children": root_children},
})
print(f"root: {len(root_children)} groups, geometricError {root_ge:.1f} m")
```

Content URIs in an external tileset resolve relative to *that* tileset's location, not to the root's. The `../` prefix is there because group files live one directory below the shards' parent. Getting this wrong produces a tileset that validates structurally and 404s every shard at runtime. `refine: "ADD"` on the empty grouping nodes is deliberate: with no content of their own, replacement has nothing to replace, and `ADD` avoids a runtime waiting for a parent that will never render.

<figure class="diagram">
<svg viewBox="66 16 658 240" role="img" aria-labelledby="mst-ge-t mst-ge-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mst-ge-t">Geometric error must fall strictly down the tree</title>
  <desc id="mst-ge-d">A ladder of four levels: root at 1,600 metres, group at 800 metres, shard reference and shard root at 120 metres, and shard leaves at 2 metres. Each level's geometric error is larger than every child's. A red example shows a group at 60 metres above a shard at 120, which the runtime refines in the wrong order.</desc>
  <rect class="svg-bg" x="66" y="16" width="658" height="240" fill="#ffffff"/>
  <path d="M72 30 V210" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="2">
    <rect x="80" y="30" width="300" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="80" y="78" width="240" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="80" y="126" width="180" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="80" y="174" width="120" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="470" y="78" width="240" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="470" y="126" width="240" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="94" y="52">root · 1,600 m</text>
    <text x="94" y="100">group · 800 m</text>
    <text x="94" y="148">shard root · 120 m</text>
    <text x="94" y="196">leaves · 2 m</text>
    <text x="484" y="100">group · 60 m</text>
    <text x="484" y="148">shard root · 120 m</text>
  </g>
  <text x="590" y="186" fill="#b0413e" font-size="12" text-anchor="middle">child larger than parent:</text>
  <text x="590" y="204" fill="#b0413e" font-size="12" text-anchor="middle">refinement order breaks</text>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">The merge only chooses the upper two rows; the lower ones come from the shard builds.</text>
</svg>
<figcaption>The merge step owns the geometric errors above the shards, and the only hard constraint on them is that they stay above whatever the shards report.</figcaption>
</figure>

## Expected Output & Verification

```text
4096 shards, asset versions {'1.1'}
16 groups, children per group: min 188, median 256, max 256
root: 16 groups, geometricError 1612.4 m
```

Validate the structure with the official validator, then check the relationships it does not know about:

```bash
npx 3d-tiles-validator --tilesetFile build/tileset.json --reportFile build/validation.json
```

```python
def check_node(node, parent_ge, parent_region, base):
    ge = node["geometricError"]
    assert parent_ge is None or ge < parent_ge, f"geometric error {ge} not below parent {parent_ge}"
    r = node["boundingVolume"]["region"]
    if parent_region:
        eps = 1e-9
        assert (r[0] >= parent_region[0] - eps and r[1] >= parent_region[1] - eps and
                r[2] <= parent_region[2] + eps and r[3] <= parent_region[3] + eps), "child outside parent"
    uri = node.get("content", {}).get("uri")
    if uri:
        target = (base / uri).resolve()
        assert target.exists(), f"missing content {target}"
        if target.suffix == ".json":
            ext = json.loads(target.read_text())
            check_node(ext["root"], ge + 1e-6, r, target.parent)
    for child in node.get("children", []):
        check_node(child, ge, r, base)

root = json.loads((OUT / "tileset.json").read_text())
check_node(root["root"], None, None, OUT)
print("hierarchy, containment and every external reference verified")
```

The recursive check follows external references into each group and each shard, which the validator only does when asked to, and it enforces containment of child regions in parent regions — a property that lets a runtime cull a whole group without ever looking inside it.

<figure class="diagram">
<svg viewBox="6 16 748 192" role="img" aria-labelledby="mst-uri-t mst-uri-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mst-uri-t">How content URIs resolve through external tilesets</title>
  <desc id="mst-uri-d">The root tileset in build references groups/0231.json. That group file lives in build/groups, so its reference to a shard must be written as ../shards/023103220112/tileset.json. The shard's own content URIs, such as leaf glb files, resolve relative to the shard directory.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="192" fill="#ffffff"/>
  <defs>
    <marker id="mst-uri-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="70" width="170" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="270" y="70" width="210" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="560" y="70" width="180" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#mst-uri-arrow)">
    <path d="M190 105 H268"/>
    <path d="M480 105 H558"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="105" y="98">build/</text>
    <text x="105" y="116">tileset.json</text>
    <text x="375" y="98">build/groups/</text>
    <text x="375" y="116">0231.json</text>
    <text x="650" y="98">build/shards/</text>
    <text x="650" y="116">…/tileset.json</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="229" y="60">groups/0231.json</text>
    <text x="519" y="42">../shards/</text>
    <text x="519" y="58">…/tileset.json</text>
  </g>
  <text x="380" y="190" fill="#15384a" font-size="12.5" text-anchor="middle">Each URI is relative to the file that contains it, never to the root.</text>
</svg>
<figcaption>Relative resolution is per file. A group written one directory deeper than the shards needs a parent-directory prefix on every reference.</figcaption>
</figure>

## Common Errors

**The city loads, then only some districts ever appear.** Those groups' geometric errors are below their shards' root errors, so the runtime never considers the external tileset worth loading. The recursive check above catches it; the fix is to derive group errors from the maximum child error, as step 3 does.

**`404` for every shard in the browser network panel.** Content URIs were written relative to the root rather than to the group file. Resolve each URI against the containing file's directory and compare with what the server actually serves.

**Assertion `group crosses the antimeridian`.** A naive min/max union of longitudes across ±180° produces a region spanning the whole globe. Groups near the antimeridian need their longitudes unwrapped before the union and split into two groups when written, because a 3D Tiles region's west must be less than its east.

## Frequently Asked Questions

### Should the merged root use implicit tiling instead?

For a regular quadtree of shards, implicit tiling is more compact and is the direction 3D Tiles 1.1 encourages — see [implicit tiling with subtree files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/). Explicit external references remain the simpler choice when shards are irregular, were built by different tools, or are rebuilt and versioned independently.

### How often does the root need rewriting?

Only when a shard's bounds or root geometric error change, or a shard is added or removed. An incremental rebuild that leaves those untouched can leave the root and group files byte-identical, which keeps their CDN cache entries valid.

### Is there a limit on children per node?

Not in the specification. The practical limit is runtime cost and JSON size; a few hundred children per node is comfortable, a few thousand is measurable in frame time on mobile devices.

## Related Guides

- [Parallel b3dm Encoding with Process Pools](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/parallel-b3dm-encoding-with-process-pools/) — producing the shards being merged
- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — rebuilding shards without touching the root
- [Writing 3D Tiles Validator Checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — running the verification on every build

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
