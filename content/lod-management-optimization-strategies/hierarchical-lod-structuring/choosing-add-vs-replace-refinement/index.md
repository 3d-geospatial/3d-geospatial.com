# Choosing ADD vs REPLACE Refinement for 3D Tiles

This page decides between the two refinement modes in 3D Tiles — `ADD`, where a tile's children are drawn on top of it, and `REPLACE`, where they are drawn instead of it — for each kind of content a digital twin streams, and audits an existing `tileset.json` for the failure each mode invites: holes under `REPLACE` when children do not cover their parent, and duplicated geometry under `ADD` when a child repeats what its parent already drew.

## Why you hit this

Refinement is one word in a tile's JSON and it changes what the runtime draws, how much memory it holds and what visual defects appear. Point cloud tilers emit `ADD` because a coarse node holds a sample and children hold the rest. Mesh tilers emit `REPLACE` because a coarse node is a simplified copy of what its children contain. Trouble starts when content is merged, hand-edited or produced by a pipeline that did not think about it: a building tileset marked `ADD` that draws every LOD at once and z-fights with itself, or a `REPLACE` tileset with an empty child quadrant that leaves a hole in the city as soon as the camera comes close. The hierarchy these settings apply to is built in [implementing quadtree LOD for urban models](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`; the audit reads tileset JSON and glTF with the standard library plus `pygltflib>=1.16`.
- A tileset whose bounding volumes are `region`s in radians (EPSG:4979) or `box`es in a consistent frame; the audit converts both to axis-aligned extents for coverage checks.
- Content that carries stable feature identifiers — `EXT_mesh_features` feature IDs or a batch table `building_id` — if you want the duplicate check to name the duplicated objects.

## What Each Mode Draws

With `REPLACE`, once the runtime decides a tile is not detailed enough, it loads the children and stops drawing the parent. CesiumJS by default keeps drawing the parent until *all* renderable children are loaded, so the view never shows a gap during loading; the price is that a child that fails to load keeps its parent on screen indefinitely. With `ADD`, the parent keeps drawing and each child adds its content on top as it arrives, which suits content where the parent is a genuine subset of the final picture.

`refine` is inherited: a tile without its own value uses its parent's, and the root must declare one. A single tileset can therefore switch modes between subtrees — `REPLACE` for building meshes, `ADD` for a subtree of vegetation instances attached under the same parent.

<figure class="diagram">
<svg viewBox="6 6 748 256" role="img" aria-labelledby="ar-draw-t ar-draw-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ar-draw-t">What is drawn after refinement in each mode</title>
  <desc id="ar-draw-d">Two panels showing a parent tile and four children after refinement. Under REPLACE, only the four children are drawn and the parent's simplified geometry disappears. Under ADD, the parent's sparse sample stays on screen and each child adds more points in its quadrant, so the final picture is the union of all levels.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="256" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="200" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="200" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="1.5" fill="#ffffff">
    <rect x="60" y="60" width="130" height="70"/><rect x="190" y="60" width="130" height="70"/>
    <rect x="60" y="130" width="130" height="70"/><rect x="190" y="130" width="130" height="70"/>
    <rect x="440" y="60" width="130" height="70"/><rect x="570" y="60" width="130" height="70"/>
    <rect x="440" y="130" width="130" height="70"/><rect x="570" y="130" width="130" height="70"/>
  </g>
  <g fill="#1f6b8a">
    <path d="M80 110 h30 v-30 h20 v30 h40 v-15 h-10 v15 Z"/><path d="M210 110 h40 v-35 h30 v35 Z"/>
    <path d="M80 180 h60 v-25 h30 v25 Z"/><path d="M210 180 h25 v-40 h45 v40 Z"/>
  </g>
  <g fill="#1f2937">
    <circle cx="470" cy="80" r="3"/><circle cx="530" cy="110" r="3"/><circle cx="610" cy="90" r="3"/><circle cx="660" cy="170" r="3"/><circle cx="480" cy="170" r="3"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="455" cy="95" r="2"/><circle cx="500" cy="75" r="2"/><circle cx="545" cy="120" r="2"/><circle cx="590" cy="75" r="2"/><circle cx="640" cy="110" r="2"/>
    <circle cx="680" cy="80" r="2"/><circle cx="460" cy="150" r="2"/><circle cx="520" cy="185" r="2"/><circle cx="600" cy="150" r="2"/><circle cx="690" cy="190" r="2"/>
    <circle cx="555" cy="160" r="2"/><circle cx="625" cy="185" r="2"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="44">REPLACE: children only</text>
    <text x="570" y="44">ADD: parent sample + children</text>
  </g>
  <text x="190" y="244" fill="#15384a" font-size="12.5" text-anchor="middle">parent mesh hidden once children load</text>
  <text x="570" y="244" fill="#15384a" font-size="12.5" text-anchor="middle">black: parent points · green: child points</text>
</svg>
<figcaption>REPLACE swaps one representation for a finer one; ADD accumulates, so every level has to contain only what the levels above it do not.</figcaption>
</figure>

## Step-by-Step

### 1. Match the mode to how the content was built

| Content | Built as | Mode | Why |
|---|---|---|---|
| Point clouds | disjoint samples per octree node | `ADD` | each node holds different points |
| Building meshes with decimated parents | simplified copies of children | `REPLACE` | parent duplicates child geometry |
| Photogrammetry meshes | simplified copies | `REPLACE` | as above |
| Terrain meshes | simplified copies | `REPLACE` | as above |
| Instanced trees, street furniture | new objects per level | `ADD` | finer levels add smaller objects |
| Coarse massing + detailed façades | façade detail only in children | `ADD` | child adds what parent lacks |

The rule behind the table is a single question: does the parent's content still belong on screen when the children are visible? If the parent is a lower-detail *version* of the children, the answer is no and the mode is `REPLACE`. If the parent is a *part* of the final picture, the answer is yes and the mode is `ADD`.

### 2. Load the tree and resolve inherited refinement

```python
import json
from pathlib import Path

def walk(node, parent_refine=None, depth=0, base=Path("."), path="root"):
    refine = node.get("refine", parent_refine)
    assert refine in ("ADD", "REPLACE"), f"{path}: no refine and nothing to inherit"
    yield path, node, refine, depth, base
    for i, child in enumerate(node.get("children", [])):
        yield from walk(child, refine, depth + 1, base, f"{path}/{i}")

tileset_path = Path("tiles/city/tileset.json")
ts = json.loads(tileset_path.read_text())
nodes = list(walk(ts["root"], base=tileset_path.parent))
modes = {}
for _, _, refine, depth, _ in nodes:
    modes.setdefault(depth, set()).add(refine)
print({d: sorted(m) for d, m in sorted(modes.items())})
```

Seeing modes per depth is a quick sanity check. A mesh tileset should report `REPLACE` at every depth; a point cloud `ADD` at every depth; a mixed tileset should switch at an identifiable level, not flicker between modes at random nodes, which usually means two tools wrote parts of the tree.

### 3. Check REPLACE nodes for coverage holes

```python
import math

def extent(bv):
    if "region" in bv:
        w, s, e, n, lo, hi = bv["region"]
        return (w, s, e, n)
    raise ValueError("audit expects region bounding volumes")

def covered_fraction(parent, children, samples=40):
    w, s, e, n = extent(parent["boundingVolume"])
    boxes = [extent(c["boundingVolume"]) for c in children if "content" in c or c.get("children")]
    hit = 0
    for i in range(samples):
        for j in range(samples):
            lon = w + (i + 0.5) * (e - w) / samples
            lat = s + (j + 0.5) * (n - s) / samples
            if any(b[0] <= lon <= b[2] and b[1] <= lat <= b[3] for b in boxes):
                hit += 1
    return hit / samples ** 2

holes = []
for path, node, refine, depth, _ in nodes:
    kids = node.get("children", [])
    if refine == "REPLACE" and "content" in node and kids:
        frac = covered_fraction(node, kids)
        if frac < 0.98:
            holes.append((path, depth, round(frac, 3)))
print(f"{len(holes)} REPLACE nodes whose children leave part of the parent uncovered", holes[:5])
```

A `REPLACE` parent is hidden when it refines, so any area of the parent's footprint that no child covers disappears from the screen. Children without content and without descendants are ignored in the coverage test, because they contribute nothing to draw. The sampling approach is coarse and fast; a flagged node is worth a closer look, not an automatic failure — a parent whose content genuinely stops at a coastline can have uncovered water.

<figure class="diagram">
<svg viewBox="26 16 688 224" role="img" aria-labelledby="ar-hole-t ar-hole-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ar-hole-t">A REPLACE hole from a missing child</title>
  <desc id="ar-hole-d">At a distance, the parent tile draws the whole district. After refinement under REPLACE, three children draw their quadrants but the fourth child was never written because the tiler found no buildings above its minimum size there. The parent is hidden, so the small buildings in that quadrant vanish as the camera approaches.</desc>
  <rect class="svg-bg" x="26" y="16" width="688" height="224" fill="#ffffff"/>
  <rect x="40" y="30" width="260" height="160" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#1f6b8a" stroke-width="2">
    <rect x="440" y="30" width="130" height="80" fill="#e3f0f4"/>
    <rect x="570" y="30" width="130" height="80" fill="#e3f0f4"/>
    <rect x="440" y="110" width="130" height="80" fill="#e3f0f4"/>
  </g>
  <rect x="570" y="110" width="130" height="80" fill="#f7dfdc" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M320 110 H420" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M410 104 L420 110 L410 116" fill="none" stroke="#5b6471" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="114">parent: whole district</text>
    <text x="505" y="74">child 0</text><text x="635" y="74">child 1</text><text x="505" y="154">child 2</text>
  </g>
  <text x="635" y="146" fill="#b0413e" font-size="12.5" text-anchor="middle">no child 3</text>
  <text x="635" y="164" fill="#b0413e" font-size="12.5" text-anchor="middle">→ hole</text>
  <text x="370" y="96" fill="#5b6471" font-size="12" text-anchor="middle">refine</text>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Fix: write child 3 containing the parent's content for that quadrant, even if it is small.</text>
</svg>
<figcaption>Under REPLACE, a quadrant with too little content to justify its own tile still needs one, or its content exists only at the coarser level.</figcaption>
</figure>

### 4. Check ADD subtrees for duplicated content

```python
from collections import Counter
from pygltflib import GLTF2

def feature_ids(glb_path):
    g = GLTF2().load_binary(str(glb_path))
    ids = []
    for mesh in g.meshes:
        for prim in mesh.primitives:
            if prim.extras and "building_ids" in prim.extras:
                ids.extend(prim.extras["building_ids"])
    return ids

seen = Counter()
for path, node, refine, depth, base in nodes:
    uri = node.get("content", {}).get("uri")
    if refine == "ADD" and uri and uri.endswith(".glb"):
        for bid in set(feature_ids(base / uri)):
            seen[bid] += 1
dupes = {bid: n for bid, n in seen.items() if n > 1}
print(f"{len(dupes)} objects appear in more than one ADD level", list(dupes.items())[:5])
```

Under `ADD`, an object present in both a parent and a child is drawn twice at the same position — a reliable source of z-fighting and of doubled triangle counts. The script looks for identifiers stored in primitive `extras`; adapt `feature_ids` to wherever your pipeline records them, such as a property table in `EXT_structural_metadata`, described in [attaching EXT_structural_metadata to building tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/).

## Expected Output & Verification

```text
{0: ['REPLACE'], 1: ['REPLACE'], 2: ['REPLACE'], 3: ['REPLACE'], 4: ['ADD'], 5: ['ADD']}
3 REPLACE nodes whose children leave part of the parent uncovered [('root/2/1/3', 3, 0.75), ('root/0/3/0', 3, 0.5), ('root/3/3/2', 3, 0.875)]
0 objects appear in more than one ADD level []
```

Verify visually and numerically in the runtime. For each flagged `REPLACE` node, fly the camera to the uncovered quadrant and step in until the parent refines; content that disappears confirms the hole. For `ADD` subtrees, compare the triangle count the runtime reports for a view with the sum of unique triangles in the loaded tiles — a ratio well above 1 means duplication the identifier check missed.

<figure class="diagram">
<svg viewBox="26 36 548 182" role="img" aria-labelledby="ar-cost-t ar-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ar-cost-t">Triangles drawn for the same view under each mode</title>
  <desc id="ar-cost-d">Bars compare triangles drawn for a close-up street view of a building mesh tileset. With correct REPLACE refinement, about 1.1 million triangles are drawn. The same tileset wrongly marked ADD draws every ancestor as well, about 1.9 million triangles, and shows z-fighting where ancestor and child surfaces coincide.</desc>
  <rect class="svg-bg" x="26" y="36" width="548" height="182" fill="#ffffff"/>
  <path d="M40 30 V170" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="40" y="50" width="300" height="44" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="40" y="120" width="300" height="44" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="340" y="120" width="220" height="44" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="77">REPLACE — leaves: 1.1 M</text>
    <text x="190" y="147">wrongly ADD — leaves: 1.1 M</text>
    <text x="450" y="147">ancestors: +0.8 M</text>
  </g>
  <text x="300" y="200" fill="#15384a" font-size="12.5" text-anchor="middle">Every ancestor of a visible leaf is drawn again, at the same place.</text>
</svg>
<figcaption>A mesh hierarchy marked ADD pays for every level at once and gets z-fighting in return.</figcaption>
</figure>

## Common Errors

**Buildings flicker between two shapes when zooming.** A mesh subtree is marked `ADD`, so a decimated parent and its detailed child overlap. Set `REPLACE` on the subtree root and let children inherit it.

**A district stays coarse forever in one corner.** One child of a `REPLACE` node fails to load — a 404 or a decode error — and CesiumJS keeps the parent visible until all children are ready. Check the network panel for the missing child; the refinement setting is doing its job.

**Point cloud density jumps when the camera moves slightly.** The point cloud was written with `REPLACE`, so every refinement drops the parent's sample and draws only the child's. Point cloud octrees built as disjoint samples need `ADD`.

## Frequently Asked Questions

### Does skipLevelOfDetail change how REPLACE behaves?

Yes. With `skipLevelOfDetail` enabled, CesiumJS may jump directly to deeper descendants without loading intermediate levels and can briefly draw a mix of levels. It reduces bandwidth for fast zooms and makes coverage holes and loading gaps more visible, so audit coverage before enabling it.

### Can implicit tilesets mix modes?

An implicit tileset's refinement is declared once at the implicit root and applies to the whole generated subtree. To mix modes, place separate implicit subtrees under explicit parent tiles with different `refine` values.

### Is ADD always cheaper in bandwidth?

Only when levels are truly disjoint. A point cloud stored with `ADD` transmits each point once; a mesh wrongly stored with `ADD` still transmits every level and then draws them all.

## Related Guides

- [Computing Geometric Error for 3D Tiles Levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) — when each level refines
- [Tuning Maximum Screen Space Error in Cesium](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/tuning-maximum-screen-space-error-in-cesium/) — how far refinement goes
- [Tracking Down Z-Fighting Between Terrain and Buildings](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracking-down-z-fighting-between-terrain-and-buildings/) — the other common source of flicker

Back to [Hierarchical LOD Structuring for Digital Twins](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/).
