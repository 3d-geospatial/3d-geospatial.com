# Migrating a 1.0 Tileset to 3D Tiles 1.1

This page migrates a working 3D Tiles 1.0 tileset to 1.1 incrementally — unwrapping `b3dm` into plain `glb`, lifting batch tables into a declared schema, converting the deep parts of the tree to implicit tiling, and dual-publishing while clients catch up. The migration is worth doing when the `tileset.json` size or the batch-table duplication is costing you something measurable, and it is worth doing in stages because each stage is independently useful and independently reversible.

## Why you hit this

A 1.0 tileset that works does not need replacing, so the migration is always triggered by a specific cost: a `tileset.json` measured in tens of megabytes that every client parses before drawing anything, a batch table repeated across thousands of tiles, or a viewer team asking for typed metadata the batch table cannot express. Each of those has its own remedy in 1.1, and doing all three at once turns a tractable change into a rewrite.

The target format is described in [tileset metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/); this page is about getting there from something that already ships.

## Prerequisites

- Node 18+ with `3d-tiles-tools` and `3d-tiles-validator` (`npm i -g 3d-tiles-tools 3d-tiles-validator`).
- The existing tileset, its build pipeline, and a way to regenerate it — migration by conversion is a stopgap, not the destination.
- A record of which clients consume the tileset and their versions. CesiumJS below 1.107 reads 1.0 only, and that constraint decides the sequencing.
- An atomic publish mechanism, as in [automated 3D Tiles deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/), so a stage can be rolled back with one alias write.

## Step-by-Step

### 1. Establish the baseline you are migrating from

Measure before changing anything, so each stage can be justified by what it saved.

```python
import glob
import json
import os

ts = json.load(open("tileset/tileset.json"))

def walk(node):
    yield node
    for c in node.get("children", []):
        yield from walk(c)

nodes = list(walk(ts["root"]))
b3dm = glob.glob("tileset/**/*.b3dm", recursive=True)
total_content = sum(os.path.getsize(f) for f in b3dm)

print(f"asset version:      {ts['asset']['version']}")
print(f"tileset.json:       {os.path.getsize('tileset/tileset.json') / 1e6:.2f} MB")
print(f"explicit nodes:     {len(nodes):,}")
print(f"content files:      {len(b3dm):,}  ({total_content / 1e6:.1f} MB)")
```

Record those four numbers. They are what you will point at when the migration takes longer than expected, and the `tileset.json` figure in particular is what decides whether implicit tiling is worth the work at all — under a megabyte, it is not.

### 2. Stage one: unwrap b3dm into glb

3D Tiles 1.1 takes glTF directly as tile content. This stage alone removes the `b3dm` header, feature table and batch table wrapper from every tile, and it is reversible.

```bash
# Converts b3dm content to glb and rewrites the content URIs in tileset.json.
npx 3d-tiles-tools upgrade \
  --input tileset/tileset.json \
  --output tileset_v11/tileset.json \
  --targetVersion 1.1

npx 3d-tiles-validator --tilesetFile tileset_v11/tileset.json
```

The upgrade lifts each tile's batch table into `EXT_structural_metadata` automatically, inferring types from the values. That inference is the part to check rather than trust: a column that happened to hold only integers in the sample tile becomes an integer type, and the first tile containing a decimal then fails.

```python
from pygltflib import GLTF2

g = GLTF2().load("tileset_v11/content/0/0/0.glb")
ext = g.extensions.get("EXT_structural_metadata", {})
cls = list(ext.get("schema", {}).get("classes", {}).values())[0]
for name, prop in cls["properties"].items():
    print(f"{name:<14} {prop.get('type')} {prop.get('componentType', '')}")
```

<figure class="diagram">
<svg viewBox="2 52 756 206" role="img" aria-labelledby="mg-stage-t mg-stage-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mg-stage-t">Four stages, each independently shippable</title>
  <desc id="mg-stage-d">Unwrapping b3dm to glb, replacing inferred metadata types with a declared schema, converting deep subtrees to implicit tiling, and finally retiring the 1.0 output. Each stage produces a valid tileset that can be published and rolled back on its own, and each has its own trigger for being worth doing.</desc>
  <rect class="svg-bg" x="2" y="52" width="756" height="206" fill="#ffffff"/>
  <defs>
    <marker id="mg-stage-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="2">
    <rect x="16" y="66" width="164" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="204" y="66" width="164" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="392" y="66" width="164" height="66" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="580" y="66" width="164" height="66" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#mg-stage-a)">
    <line x1="180" y1="99" x2="202" y2="99"/>
    <line x1="368" y1="99" x2="390" y2="99"/>
    <line x1="556" y1="99" x2="578" y2="99"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="98" y="90"><tspan x="98" dy="0" font-weight="600">1 · b3dm → glb</tspan><tspan x="98" dy="16">wrapper removed</tspan><tspan x="98" dy="15">types inferred</tspan></text>
    <text x="286" y="90"><tspan x="286" dy="0" font-weight="600">2 · declared schema</tspan><tspan x="286" dy="16">types and enums fixed</tspan><tspan x="286" dy="15">by hand, once</tspan></text>
    <text x="474" y="90"><tspan x="474" dy="0" font-weight="600">3 · implicit subtrees</tspan><tspan x="474" dy="16">deep levels only</tspan><tspan x="474" dy="15">upper tree stays explicit</tspan></text>
    <text x="662" y="90"><tspan x="662" dy="0" font-weight="600">4 · retire 1.0</tspan><tspan x="662" dy="16">once every client</tspan><tspan x="662" dy="15">reads 1.1</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="98" y="164">trigger: batch-table bloat</text>
    <text x="286" y="164">trigger: a type surprise</text>
    <text x="474" y="164">trigger: tileset.json size</text>
    <text x="662" y="164">trigger: client fleet upgraded</text>
  </g>
  <text x="380" y="212" fill="#15384a" font-size="12.5" text-anchor="middle">Each stage is a valid tileset on its own, so a stall at stage two is a stable state rather than a half-migration</text>
  <text x="380" y="240" fill="#b0413e" font-size="12" text-anchor="middle">Doing all four in one change means one rollback unit and one very large diff</text>
</svg>
<figcaption>The stages are ordered by cost and by how reversible they are. Stage three is the only one that changes how a client addresses tiles.</figcaption>
</figure>

### 3. Stage two: replace inferred types with a declared schema

The automatic upgrade gives you a schema per tile, inferred. Replace it with one schema for the tileset, written deliberately.

```python
import json
import glob
from pygltflib import GLTF2

# Survey what the inference produced across every tile, and find the disagreements.
seen = {}
for path in glob.glob("tileset_v11/content/**/*.glb", recursive=True):
    g = GLTF2().load(path)
    ext = g.extensions.get("EXT_structural_metadata")
    if not ext:
        continue
    for cls in ext["schema"]["classes"].values():
        for name, prop in cls["properties"].items():
            key = (prop.get("type"), prop.get("componentType"))
            seen.setdefault(name, set()).add(key)

for name, kinds in sorted(seen.items()):
    flag = "  <-- inconsistent" if len(kinds) > 1 else ""
    print(f"{name:<14} {sorted(kinds)}{flag}")
```

Every inconsistent row is a property whose type varied by tile — legal under a batch table, and exactly what a declared schema exists to prevent. Pick the widest correct type, write it into a single schema file, and rebuild the property tables against it rather than patching the inferred ones.

### 4. Stage three: make the deep subtrees implicit

Convert only the levels where the node count actually hurts. The upper tree stays explicit, which keeps hand-authored bounding volumes and per-region refinement intact.

```python
import json

def uniform_below(node, depth, scheme="QUADTREE"):
    """True when every node at or below `depth` has the full child count."""
    expect = 4 if scheme == "QUADTREE" else 8
    def walk(n, d):
        kids = n.get("children", [])
        if not kids:
            return True
        if d >= depth and len(kids) != expect:
            return False
        return all(walk(k, d + 1) for k in kids)
    return walk(node, 0)

ts = json.load(open("tileset_v11/tileset.json"))
for cut in range(2, 8):
    print(f"implicit from level {cut}: {uniform_below(ts['root'], cut)}")
```

Choose the shallowest level at which the tree becomes uniform, and root the implicit subtrees there. Every node above it stays as it is; every node below it disappears from the JSON and is replaced by subtree bitstreams, as described in [implicit tiling with subtree files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/).

<figure class="diagram">
<svg viewBox="6 26 688 270" role="img" aria-labelledby="mg-hybrid-t mg-hybrid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mg-hybrid-t">A hybrid tree: explicit above, implicit below</title>
  <desc id="mg-hybrid-d">The upper levels of the tree stay explicit, so hand-tuned bounding volumes and region-specific refinement survive. Below a chosen cut level, where subdivision is uniform, each node roots an implicit subtree and its descendants vanish from the JSON entirely.</desc>
  <rect class="svg-bg" x="6" y="26" width="688" height="270" fill="#ffffff"/>
  <defs>
    <marker id="mg-hy-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="300" y="40" width="140" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="140" y="102" width="140" height="34" rx="6"/>
    <rect x="460" y="102" width="140" height="34" rx="6"/>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="60" y="180" width="140" height="46" rx="6"/>
    <rect x="220" y="180" width="140" height="46" rx="6"/>
    <rect x="380" y="180" width="140" height="46" rx="6"/>
    <rect x="540" y="180" width="140" height="46" rx="6"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#mg-hy-a)">
    <path fill="none" d="M340 74 C 300 84 250 90 212 100"/>
    <path fill="none" d="M400 74 C 440 84 490 90 528 100"/>
    <path fill="none" d="M180 136 C 160 152 150 162 132 178"/>
    <path fill="none" d="M240 136 C 260 152 272 162 288 178"/>
    <path fill="none" d="M500 136 C 480 152 468 162 452 178"/>
    <path fill="none" d="M560 136 C 580 152 592 162 608 178"/>
  </g>
  <path d="M20 158 H720" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="7 4"/>
  <text x="20" y="150" fill="#9a4f26" font-size="12" text-anchor="start">cut level — implicit below here</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="370" y="62">root, explicit</text>
    <text x="210" y="124">district, explicit</text>
    <text x="530" y="124">district, explicit</text>
    <text x="130" y="200"><tspan x="130" dy="0">implicitTiling</tspan><tspan x="130" dy="15">6 levels</tspan></text>
    <text x="290" y="200"><tspan x="290" dy="0">implicitTiling</tspan><tspan x="290" dy="15">6 levels</tspan></text>
    <text x="450" y="200"><tspan x="450" dy="0">implicitTiling</tspan><tspan x="450" dy="15">6 levels</tspan></text>
    <text x="610" y="200"><tspan x="610" dy="0">implicitTiling</tspan><tspan x="610" dy="15">6 levels</tspan></text>
  </g>
  <text x="370" y="256" fill="#15384a" font-size="12.5" text-anchor="middle">Seven explicit nodes instead of 22 million, with the hand-tuned upper tree untouched</text>
  <text x="370" y="278" fill="#5b6471" font-size="12" text-anchor="middle">And each district&#39;s subtree regenerates independently when that district changes</text>
</svg>
<figcaption>The hybrid is usually the destination rather than a waypoint. The upper levels are where human judgement lives, and they are also where there are too few nodes for implicit addressing to save anything.</figcaption>
</figure>

### 5. Dual-publish under two aliases until the clients move

Publish both formats side by side and let each client resolve the one it can read.

```bash
# Both builds land under their own immutable prefixes.
aws s3 sync tileset/      s3://twin/builds/${GIT_SHA}-v10/ --cache-control "public,max-age=31536000,immutable"
aws s3 sync tileset_v11/  s3://twin/builds/${GIT_SHA}-v11/ --cache-control "public,max-age=31536000,immutable"

# Two aliases, swapped independently.
aws s3 cp s3://twin/builds/${GIT_SHA}-v10/tileset.json s3://twin/live-v10/tileset.json --cache-control "no-cache"
aws s3 cp s3://twin/builds/${GIT_SHA}-v11/tileset.json s3://twin/live-v11/tileset.json --cache-control "no-cache"
```

Generate both from the same intermediate rather than converting one into the other on each build. A conversion step is a second pipeline that has to be kept correct, and the two outputs drift the first time somebody fixes one of them.

### 6. Retire 1.0 when the client fleet has moved

The trigger is measurable, so measure it rather than guessing.

```python
import collections
import re

# CDN access log: count requests per alias and per client version.
counts = collections.Counter()
for line in open("cdn_access.log"):
    if "/live-v10/" in line:
        m = re.search(r"CesiumJS/([\d.]+)", line)
        counts[m.group(1) if m else "unknown"] += 1

for version, n in counts.most_common(10):
    print(f"CesiumJS {version:<10} {n:>8,} requests against the 1.0 alias")
```

## Expected Output & Verification

A representative migration of a mid-sized city tileset:

```text
asset version:      1.0
tileset.json:       38.42 MB
explicit nodes:     221,184
content files:      221,184  (14.2 GB)

after stage 1:  content 12.9 GB (b3dm wrapper removed)
after stage 2:  content 12.6 GB (enums replace repeated strings)
after stage 3:  tileset.json 0.006 MB, 7 explicit nodes, 48 subtree files (2.1 MB)
```

Verify at each stage rather than at the end. `3d-tiles-validator` must exit clean; the content-file count must be unchanged by stages one and two; and after stage three the number of content-available bits across all subtrees must equal the number of content files on disk. That last check is the one that catches a migration which validates and 404s.

<figure class="diagram">
<svg viewBox="40 38 748 232" role="img" aria-labelledby="mg-size-t mg-size-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mg-size-t">What each stage actually saved</title>
  <desc id="mg-size-d">Unwrapping b3dm removed about nine per cent of the content bytes. Replacing repeated strings with enums removed a further two. Converting the deep tree to implicit tiling reduced the tileset JSON from thirty-eight megabytes to six kilobytes, replaced by two megabytes of subtree files.</desc>
  <rect class="svg-bg" x="40" y="38" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="230" y="52" width="400" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="88" width="364" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="124" width="355" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="172" width="380" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="208" width="21" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="640" y="72">14.2 GB content, before</text>
    <text x="604" y="108">12.9 GB after stage 1</text>
    <text x="595" y="144">12.6 GB after stage 2</text>
    <text x="620" y="192">38.4 MB tileset.json, before</text>
    <text x="261" y="228">2.1 MB of subtrees after stage 3</text>
  </g>
  <text x="370" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">Content shrinks by a tenth; the tree description shrinks by a factor of eighteen and stops blocking first paint</text>
</svg>
<figcaption>Two of the three stages are worth a few per cent. The third is worth an order of magnitude, and it is the only one that needs dual-publishing.</figcaption>
</figure>

## Common Errors

**A property that validated in the sample tile fails elsewhere.** The automatic type inference saw only integers in the tiles it looked at. Survey every tile as in stage two before fixing the schema, and choose the widest correct type.

**The 1.1 tileset renders nothing in a client that reads 1.0.** Expected — `implicitTiling` is ignored and there are no explicit children to fall back to. This is why stage three is the one that needs dual-publishing, and stages one and two do not.

**Content 404s only in some regions after stage three.** `contentAvailability` was derived from `tileAvailability` rather than from the files that exist. Interior nodes without geometry then advertise a payload.

**The upgraded tileset is larger than the original.** The batch tables were lifted into per-tile schemas, so the schema is now repeated in every tile. Stage two fixes this by hoisting one schema to the tileset; skipping it leaves the migration worse than where it started.

## Frequently Asked Questions

### Can I skip straight to implicit tiling?
Only if the tree is already uniform. Most 1.0 trees produced by a density-driven tiler are not, and forcing uniformity is a rebuild rather than a migration — at which point regenerating from source is cheaper than converting.

### How long should dual-publishing run?
Until the access log shows the 1.0 alias below whatever residual traffic you are willing to break. Measuring it takes one query and removes the argument entirely.

### Does 1.1 change how geometric error works?
No. The refinement model is unchanged, so a [geometric error inversion](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) behaves exactly as it did in 1.0 — and is harder to spot, because the offending node is no longer written out anywhere.

## Related Guides

- [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/) — what you are migrating to
- [Implicit Tiling with Subtree Files](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/implicit-tiling-with-subtree-files/) — stage three in detail
- [Attaching EXT_structural_metadata to Building Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/) — stage two in detail
- [Automated 3D Tiles Deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — the alias mechanism dual-publishing relies on

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
