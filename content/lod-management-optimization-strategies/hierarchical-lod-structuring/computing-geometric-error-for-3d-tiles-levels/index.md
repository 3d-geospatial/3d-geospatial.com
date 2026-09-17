# Computing Geometric Error for 3D Tiles Levels

This page derives the `geometricError` value on every node of a 3D Tiles tree from something measurable — the actual deviation between a level's geometry and the source — instead of the usual practice of picking a root value and halving it down the tree. The number is in metres, the client divides it by camera distance to decide whether to refine, and getting it wrong produces either a tileset that never sharpens or one that fetches far more than it draws. Neither failure raises an error anywhere.

## Why you hit this

`geometricError` is the only tuning knob a tileset exposes to a client it has never met. Every runtime decision — refine or stop, fetch or skip, which of two siblings to load first — comes from comparing this one number against a screen-space threshold. Teams usually seed it from the root's bounding-volume diagonal and halve at each level, which is a reasonable prior and is wrong the moment decimation is not uniform: a level that removed 90% of a facade's triangles and 10% of a roof's does not have one error. The result is a city where some blocks refine correctly and others sit blurred at a level the client believes is good enough.

The tree this attaches to is built in [hierarchical LOD structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/); the deviation it is derived from comes out of [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/).

## Prerequisites

- Python 3.10+ with `trimesh>=4.0`, `numpy>=1.24` and `scipy>=1.11` (for the KD-tree behind the deviation measurement).
- A source mesh and the decimated meshes for each LOD level, all on the same local origin and in the same projected metric CRS.
- The tile tree already built, so each node knows its bounding volume and its children.

## Step-by-Step

### 1. Measure the deviation each level actually introduced

Geometric error is defined as the maximum distance between the rendered geometry and the geometry it stands in for. That is a Hausdorff distance, and it is measurable rather than assumable.

```python
import numpy as np
import trimesh
from scipy.spatial import cKDTree

def deviation(source: trimesh.Trimesh, simplified: trimesh.Trimesh, samples: int = 200_000):
    """One-sided Hausdorff: how far the simplified surface strays from the source."""
    pts, _ = trimesh.sample.sample_surface(simplified, samples)
    tree = cKDTree(source.vertices)
    d_vertex, _ = tree.query(pts, k=1)
    # closest_point is exact but slow; run it only on the worst 1% found above.
    worst = pts[np.argsort(d_vertex)[-samples // 100:]]
    closest, d_exact, _ = trimesh.proximity.closest_point(source, worst)
    return float(d_exact.max()), float(np.percentile(d_vertex, 95))

src = trimesh.load("block_lod0.ply", force="mesh")
for level in range(1, 5):
    simp = trimesh.load(f"block_lod{level}.ply", force="mesh")
    hmax, p95 = deviation(src, simp)
    print(f"LOD {level}: Hausdorff {hmax:.3f} m, 95th percentile {p95:.3f} m")
```

Sampling the simplified surface and querying against the source — rather than the reverse — is the direction that matters. It answers "how far is what I am drawing from the truth", which is the question the client's refinement test is implicitly asking. The two-stage approach keeps it affordable: a fast vertex-KD-tree pass over every sample, then the exact point-to-triangle computation on only the worst one per cent.

<figure class="diagram">
<svg viewBox="26 24 688 260" role="img" aria-labelledby="ge-haus-t ge-haus-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ge-haus-t">Which surface you sample decides which question you answer</title>
  <desc id="ge-haus-d">Sampling the simplified surface and measuring to the source asks how far the drawn geometry strays from the truth, which is what the client's refinement test needs. Sampling the source and measuring to the simplified surface asks a different question and typically returns a smaller number, because the source has detail the simplification never had to approximate.</desc>
  <rect class="svg-bg" x="26" y="24" width="688" height="260" fill="#ffffff"/>
  <defs>
    <marker id="ge-haus-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <polyline points="40,150 90,146 140,152 180,110 200,110 230,150 280,146 330,150"
            fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="6 4"/>
  <polyline points="40,154 120,150 200,142 280,150 330,152" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="80" cy="151" r="3"/><circle cx="140" cy="148" r="3"/>
    <circle cx="200" cy="142" r="3"/><circle cx="260" cy="147" r="3"/>
  </g>
  <line x1="190" y1="142" x2="190" y2="110" stroke="#b0413e" stroke-width="2" marker-end="url(#ge-haus-a)"/>
  <polyline points="410,150 460,146 510,152 550,110 570,110 600,150 650,146 700,150"
            fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="6 4"/>
  <polyline points="410,154 490,150 570,142 650,150 700,152" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#5b6471">
    <circle cx="450" cy="147" r="3"/><circle cx="510" cy="152" r="3"/>
    <circle cx="560" cy="110" r="3"/><circle cx="630" cy="148" r="3"/>
  </g>
  <text x="185" y="52" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">sample the simplified surface — 0.51 m</text>
  <text x="555" y="52" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">sample the source — 0.19 m</text>
  <text x="185" y="200" fill="#1f2937" font-size="12" text-anchor="middle">&quot;how far is what I draw from the truth&quot;</text>
  <text x="555" y="200" fill="#1f2937" font-size="12" text-anchor="middle">&quot;how well is the source represented on average&quot;</text>
  <text x="370" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Dashed is the source, solid the simplification. Only the left question is the one geometricError is defined as.</text>
  <text x="370" y="266" fill="#5b6471" font-size="12" text-anchor="middle">The collapsed parapet is the entire difference between the two numbers</text>
</svg>
<figcaption>Both are legitimate measurements and only one of them is geometric error. The direction is not a detail — it is a factor of two or three on a typical building.</figcaption>
</figure>

### 2. Take the maximum over the subtree, not the node

A parent node stands in for everything beneath it, so its error is the largest deviation anywhere in its subtree — not the deviation of its own geometry.

```python
def assign_errors(node, measured):
    """Post-order walk: a node's error is max(its own deviation, its children's errors)."""
    if not node["children"]:
        node["geometricError"] = measured[node["id"]]
        return node["geometricError"]
    child_max = max(assign_errors(c, measured) for c in node["children"])
    node["geometricError"] = max(measured[node["id"]], child_max)
    return node["geometricError"]

root = {"id": "r", "children": [
    {"id": "r0", "children": []}, {"id": "r1", "children": []},
    {"id": "r2", "children": []}, {"id": "r3", "children": []},
]}
measured = {"r": 2.10, "r0": 0.42, "r1": 0.51, "r2": 0.38, "r3": 0.47}
assign_errors(root, measured)
print({n["id"]: round(n["geometricError"], 2) for n in [root] + root["children"]})
```

This is where the halving heuristic diverges from reality. A parent whose four children deviate by 0.42, 0.51, 0.38 and 0.47 m has an error of at least 0.51, because refining it must be worthwhile wherever any child is worse. Halving from the root would have produced a number unrelated to any of them.

<figure class="diagram">
<svg viewBox="10 30 718 264" role="img" aria-labelledby="ge-max-t ge-max-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ge-max-t">A parent's error is the worst case beneath it</title>
  <desc id="ge-max-d">Four children deviate from the source by 0.42, 0.51, 0.38 and 0.47 metres. The parent that stands in for all four must declare at least 0.51, the worst of them, because refining it has to be worthwhile wherever any child is worse. Averaging them would understate the error and stop refinement too early.</desc>
  <rect class="svg-bg" x="10" y="30" width="718" height="264" fill="#ffffff"/>
  <defs>
    <marker id="ge-max-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="270" y="44" width="200" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="24" y="170" width="150" height="52" rx="8"/>
    <rect x="204" y="170" width="150" height="52" rx="8"/>
    <rect x="384" y="170" width="150" height="52" rx="8"/>
    <rect x="564" y="170" width="150" height="52" rx="8"/>
  </g>
  <rect x="204" y="170" width="150" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ge-max-a)">
    <path d="M310 96 C 240 124 180 140 108 166"/>
    <path d="M340 96 C 320 124 300 140 278 166"/>
    <path d="M400 96 C 420 124 440 140 460 166"/>
    <path d="M430 96 C 500 124 560 140 632 166"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="370" y="76">parent — 0.51 m</text>
    <text x="99" y="202">0.42 m</text>
    <text x="279" y="202">0.51 m</text>
    <text x="459" y="202">0.38 m</text>
    <text x="639" y="202">0.47 m</text>
  </g>
  <text x="279" y="244" fill="#9a4f26" font-size="12" text-anchor="middle">the worst child sets the parent</text>
  <text x="370" y="276" fill="#15384a" font-size="12.5" text-anchor="middle">Average them (0.45) and the client stops refining while one quarter of the block is still 13% worse than it believes</text>
</svg>
<figcaption>The maximum is not a conservative choice, it is the definition. A parent stands in for its whole subtree, so its error is the subtree's worst case.</figcaption>
</figure>

### 3. Assert strict monotonicity down the tree

The client refines while the parent's error exceeds the threshold and the child's does not. If a child's error is greater than or equal to its parent's, that comparison never becomes favourable and the subtree is never fetched.

```python
def assert_monotonic(node, path="root"):
    for i, child in enumerate(node["children"]):
        pe, ce = node["geometricError"], child["geometricError"]
        assert ce < pe, (
            f"{path}/{i}: child error {ce:.3f} >= parent {pe:.3f} — "
            "refinement stops here and the subtree is unreachable")
        assert_monotonic(child, f"{path}/{i}")
    return True

assert_monotonic(root)
print("geometricError decreases strictly at every edge")
```

Run this in CI, not by hand. The reference validator does not check it, the tileset stays perfectly valid with an inversion in it, and the only symptom is a region of the city that refuses to sharpen however close the camera gets.

### 4. Convert the number into pixels before trusting it

`geometricError` is in metres. What decides refinement is its projection onto the screen, which depends on viewport height and field of view — so the same tileset behaves differently on a laptop and a 4K display.

```python
import math

def screen_space_error(geometric_error_m, distance_m, viewport_h_px, fov_y_deg=60.0):
    return (geometric_error_m * viewport_h_px) / (2.0 * distance_m * math.tan(math.radians(fov_y_deg) / 2.0))

for h in (900, 1440, 2160):
    for d in (200, 800, 3000):
        sse = screen_space_error(0.51, d, h)
        verdict = "refine" if sse > 16 else "stop"
        print(f"viewport {h}px  distance {d:>4} m  ->  {sse:5.1f} px  {verdict}")
```

The output is the check worth doing before shipping. A `maxScreenSpaceError` of 16 tuned against a 900-pixel viewport refines roughly 2.4× more aggressively at 2160 pixels, which is the usual explanation for a tileset that streams comfortably in development and saturates a connection on a large monitor.

<figure class="diagram">
<svg viewBox="72 6 628 284" role="img" aria-labelledby="ge-px-t ge-px-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ge-px-t">The same tileset on three viewport heights</title>
  <desc id="ge-px-d">A tile with half a metre of geometric error, viewed from eight hundred metres, projects to about seven pixels of error on a 900-pixel viewport, eleven on a 1440-pixel one and seventeen on a 2160-pixel one. A threshold of sixteen pixels therefore stops refining on two of the three and keeps going on the third.</desc>
  <rect class="svg-bg" x="72" y="6" width="628" height="284" fill="#ffffff"/>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">geometricError 0.51 m at 800 m, under a 16-pixel threshold</text>
  <g stroke-width="2">
    <rect x="180" y="66" width="140" height="34" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="180" y="116" width="220" height="34" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="180" y="166" width="340" height="34" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <path d="M500 56 V212" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="500" y="48" fill="#b0413e" font-size="12" text-anchor="middle">maxScreenSpaceError = 16 px</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="332" y="88">900 px viewport — 7.1 px, stops</text>
    <text x="412" y="138">1440 px viewport — 11.3 px, stops</text>
    <text x="532" y="188">2160 px — 17.0 px, refines</text>
  </g>
  <text x="380" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">Nothing about the tileset changed. The viewport did, and it moved the tile across the threshold.</text>
  <text x="380" y="272" fill="#5b6471" font-size="12" text-anchor="middle">Tune maxScreenSpaceError against the largest display you intend to support, then verify on the smallest</text>
</svg>
<figcaption>Pixels, not metres, are what the runtime compares. A threshold that has never been checked against a large display is a bandwidth surprise waiting for a demo.</figcaption>
</figure>

### 5. Write the values into the tileset and record the derivation

The tileset carries the number; the manifest should carry where it came from, so a later rebuild can reproduce it.

```python
import json

def to_tileset(node):
    out = {
        "boundingVolume": {"box": node["box"]},
        "geometricError": round(node["geometricError"], 4),
        "refine": "REPLACE",
    }
    if node["children"]:
        out["children"] = [to_tileset(c) for c in node["children"]]
    else:
        out["content"] = {"uri": f"{node['id']}.b3dm"}
    return out

tileset = {
    "asset": {"version": "1.1"},
    "geometricError": round(root["geometricError"], 4),
    "root": to_tileset(root),
    "extras": {
        "errorDerivation": "one-sided Hausdorff, 200k surface samples, max over subtree",
        "sourceMesh": "block_lod0.ply",
        "measuredAt": "2026-08-07",
    },
}
print(json.dumps(tileset, indent=2)[:400])
```

## Expected Output & Verification

A healthy run prints a strictly decreasing sequence, roughly but not exactly halving:

```text
LOD 1: Hausdorff 0.104 m, 95th percentile 0.021 m
LOD 2: Hausdorff 0.238 m, 95th percentile 0.049 m
LOD 3: Hausdorff 0.511 m, 95th percentile 0.118 m
LOD 4: Hausdorff 1.207 m, 95th percentile 0.284 m
geometricError decreases strictly at every edge
```

Two things to read out of it. The Hausdorff figure is consistently four to five times the 95th percentile, which is normal — the maximum is set by a handful of collapsed features while the bulk of the surface is far closer. And the ratio between levels is around 2.2 rather than exactly 2, which is why deriving beats halving: the real decimation did not produce a clean factor of two, and a tileset that claims it did is misinforming the client at every level.

If the sequence is not strictly decreasing, the decimation chain is at fault rather than the measurement — a level that removed fewer triangles than its parent, or a mesh that was decimated from the wrong source.

## Common Errors

**`geometricError` of 0 on an interior node.** Zero means "this geometry is exact", so the client stops refining immediately and never loads the children. Only a leaf whose content is the source geometry should be zero, and even then only if it genuinely is.

**Error measured on the wrong side.** Sampling the source and querying the simplified surface answers a different question and typically returns a smaller number. Sample the simplified surface, query the source.

**Values derived before the local-origin shift.** Deviation computed against raw UTM coordinates in float32 inherits the coordinate quantum — several centimetres at a 585,000 m easting — and reports it as geometric error. Shift to a local origin first.

## Frequently Asked Questions

### Can I keep using the halving heuristic?
As a starting point, yes; as the shipped value, only if you have confirmed the decimation really is uniform across archetypes. It rarely is. Deriving costs one measurement pass at build time and removes an entire class of "some blocks never sharpen" reports.

### What root geometricError should a city tileset use?
Whatever the measurement gives you — typically a few hundred metres for a city-wide root, because the root's geometry stands in for everything. Setting it artificially high makes the first refinement fire immediately; setting it low makes the tileset appear empty until the camera is close.

### Does Draco compression change the number?
Slightly. Quantization moves vertices onto a lattice, so it adds its own deviation on top of the decimation's. If the quantization lattice is fine relative to the decimation error — which it should be — the addition is negligible; if you are quantizing aggressively, measure after encoding rather than before.

## Related Guides

- [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the tree these values attach to
- [Implementing Quadtree LOD for Urban Models](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/) — building the tree itself
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — where the deviation comes from
- [Streaming & Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — diagnosing an inversion from the client side

Back to [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/).
