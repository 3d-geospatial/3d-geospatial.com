---
title: "Tracking Down Z-Fighting Between Terrain and Buildings"
description: "Separate depth-precision flicker from a real vertical datum mismatch: measure the gap, check the depth buffer's resolution at that distance, and fix the right one."
---
# Tracking Down Z-Fighting Between Terrain and Buildings

Flickering where a building meets the ground has two completely different causes that look identical in a viewer: the two surfaces are genuinely coincident and the depth buffer cannot separate them, or they are not coincident at all and a datum mismatch has pushed one through the other. This page measures which one you have, in that order, because the remedies share nothing.

## Why you hit this

Terrain and buildings arrive from separate pipelines with separate vertical references, and they meet at exactly the place a viewer looks first. The flicker is reported as a rendering bug, gets triaged as a depth-buffer problem, and is fixed with a depth-bias tweak — which works, hides a 33 cm datum error, and leaves every clearance and flood result quietly wrong. The check that distinguishes them takes minutes and belongs before any renderer setting is touched.

The datum half of this is covered in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/), and the cross-stage framing in [cross-section failure modes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).

## Prerequisites

- CesiumJS 1.107+ with both layers loaded, and the ability to query terrain height at a coordinate.
- Python 3.10+ with `pyproj>=3.6` and `rasterio>=1.3` for the source-side check.
- The vertical CRS of both the terrain and the building footprints, from their manifests rather than from memory.

## Step-by-Step

### 1. Measure the actual gap, before touching the renderer

Sample terrain height and building base at the same coordinate and difference them.

```javascript
async function footingGap(viewer, lon, lat, buildingBaseHeightM) {
  const carto = Cesium.Cartographic.fromDegrees(lon, lat);
  const [sampled] = await Cesium.sampleTerrainMostDetailed(
    viewer.terrainProvider, [carto]);
  return {
    terrain: sampled.height,
    building: buildingBaseHeightM,
    gap: buildingBaseHeightM - sampled.height,
  };
}

const samples = await Promise.all(FOOTINGS.map((f) =>
  footingGap(viewer, f.lon, f.lat, f.baseHeight)));

const gaps = samples.map((s) => s.gap).sort((a, b) => a - b);
const median = gaps[gaps.length >> 1];
const spread = gaps[gaps.length - 1] - gaps[0];
console.log(`median gap ${(median * 100).toFixed(1)} cm, spread ${(spread * 100).toFixed(1)} cm`);
```

The two numbers decide everything that follows. A median gap near zero with a small spread means the surfaces really are coincident and the flicker is depth precision. A median gap of tens of centimetres, consistent across every footing, is a datum mismatch and no renderer setting should be changed.

<figure class="diagram">
<svg viewBox="35 24 694 238" role="img" aria-labelledby="zf-two-t zf-two-d" xmlns="http://www.w3.org/2000/svg">
  <title id="zf-two-t">Two causes, one symptom</title>
  <desc id="zf-two-d">When the building base and the terrain are genuinely at the same height, the depth buffer cannot separate them at distance and the two surfaces flicker. When a vertical datum mismatch has pushed the terrain a third of a metre above the building base, the surfaces intersect and flicker for an entirely different reason, which a depth bias would hide rather than fix.</desc>
  <rect class="svg-bg" x="35" y="24" width="694" height="238" fill="#ffffff"/>
  <path d="M40 160 H320" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M110 160 h120 v-70 h-120 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="180" y="196" fill="#4f7a4d" font-size="12" text-anchor="middle">gap 0.4 cm — coincident, depth precision</text>
  <path d="M420 160 H700" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <path d="M490 194 h120 v-70 h-120 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="560" y="222" fill="#b0413e" font-size="12" text-anchor="middle">gap −33 cm — terrain above the footing, a datum error</text>
  <text x="180" y="52" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">depth precision</text>
  <text x="560" y="52" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">vertical datum mismatch</text>
  <text x="370" y="244" fill="#15384a" font-size="12.5" text-anchor="middle">Both flicker identically. Only the measured gap tells them apart, and only one of them is a rendering problem.</text>
</svg>
<figcaption>A depth bias suppresses the flicker in both cases, which is exactly why applying it before measuring is how a datum error becomes permanent.</figcaption>
</figure>

### 2. If the gap is a datum offset, confirm it at the source

A gap that matches the local geoid separation is not a coincidence.

```python
from pyproj import Transformer
import rasterio

with rasterio.open("dem_wgs84.tif") as ds:
    print("terrain CRS:", ds.crs, "| compound:", ds.crs.is_compound if hasattr(ds.crs, "is_compound") else "unknown")

to_ellip = Transformer.from_crs("EPSG:32633+5941", "EPSG:4979", always_xy=True)
e, n, ortho = 598120.4, 6643880.1, 42.6
_, _, ellip = to_ellip.transform(e, n, ortho)
print(f"geoid separation here: {ellip - ortho:.3f} m")
```

If the measured gap and the separation agree to a few centimetres, the diagnosis is settled: one layer is on ellipsoidal heights and the other on orthometric. The fix is to convert the offending layer through a compound CRS, and the flicker disappears as a side effect.

### 3. If the surfaces really are coincident, look at the depth buffer

Depth precision is not uniform — it is concentrated near the camera, and the near plane sets how quickly it degrades.

```javascript
function depthResolutionMetres(distanceM, near, far, bits = 24) {
  // Non-logarithmic depth: resolution degrades with the square of distance.
  const n = 2 ** bits;
  return (distanceM * distanceM * (far - near)) / (near * far * n);
}

for (const near of [0.1, 1.0, 10.0]) {
  const r = depthResolutionMetres(2000, near, 1e7);
  console.log(`near ${near} m → ${(r * 1000).toFixed(2)} mm resolution at 2 km`);
}
console.log('logarithmic depth enabled:', viewer.scene.logarithmicDepthBuffer);
```

Two settings dominate. A near plane of 0.1 m throws away most of the buffer's range on the first metre in front of the camera; raising it to 1 m improves resolution at distance by an order of magnitude and costs nothing unless the camera genuinely goes that close to geometry. And a logarithmic depth buffer, which CesiumJS enables by default where supported, distributes precision far better across a planetary range — a scene that flickers with it enabled is usually a datum problem after all.

<figure class="diagram">
<svg viewBox="46 46 686 212" role="img" aria-labelledby="zf-depth-t zf-depth-d" xmlns="http://www.w3.org/2000/svg">
  <title id="zf-depth-t">The near plane decides how much precision is left at distance</title>
  <desc id="zf-depth-d">With a near plane of a tenth of a metre, the depth buffer resolves about six millimetres at two kilometres. Raising the near plane to one metre improves that to under a millimetre, and to ten metres to a fraction of that, because most of the buffer's range was being spent on the space immediately in front of the camera.</desc>
  <rect class="svg-bg" x="46" y="46" width="686" height="212" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="480" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="106" width="52" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="152" width="10" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="552" y="80">near 0.1 m — 6.1 mm at 2 km</text>
    <text x="124" y="126">near 1 m — 0.61 mm at 2 km</text>
    <text x="82" y="172">near 10 m — 0.06 mm at 2 km</text>
  </g>
  <text x="370" y="216" fill="#15384a" font-size="12.5" text-anchor="middle">A tenfold rise in the near plane buys a tenfold improvement in depth resolution everywhere beyond it</text>
  <text x="370" y="240" fill="#5b6471" font-size="12" text-anchor="middle">And costs nothing unless the camera is genuinely expected within that distance of geometry</text>
</svg>
<figcaption>The near plane is usually set to a small value out of caution and is the cheapest fix available when the surfaces really are coincident.</figcaption>
</figure>

### 4. Separate the surfaces deliberately where they must touch

Where a building genuinely sits on the terrain, a small deliberate offset is more honest than a renderer trick.

```python
import numpy as np

CLEARANCE_M = 0.05        # 5 cm — below survey tolerance, above depth resolution

def sink_footings(building_vertices, terrain_height_fn, clearance=CLEARANCE_M):
    """Lower each building so its base sits `clearance` below the terrain surface."""
    base_z = building_vertices[:, 2].min()
    x, y = building_vertices[:, 0].mean(), building_vertices[:, 1].mean()
    ground = terrain_height_fn(x, y)
    shift = (ground - clearance) - base_z
    out = building_vertices.copy()
    out[:, 2] += shift
    return out, shift
```

Sinking the building slightly *into* the terrain is preferable to floating it above: a building whose base is five centimetres below the ground surface is hidden by the terrain and looks correct from every angle, while one floating five centimetres above shows a visible gap at a grazing view. Five centimetres is comfortably below survey tolerance and comfortably above the depth resolution at any distance a viewer will look from.

### 5. Gate the gap so it cannot recur

```python
def assert_footings_seated(samples, max_gap_m=0.15, max_spread_m=0.10):
    gaps = sorted(s["gap"] for s in samples)
    median = gaps[len(gaps) // 2]
    spread = gaps[-1] - gaps[0]
    problems = []
    if abs(median) > max_gap_m:
        problems.append(f"median footing gap {median*100:.1f} cm — likely a datum mismatch")
    if spread > max_spread_m:
        problems.append(f"footing gap spread {spread*100:.1f} cm — terrain and buildings disagree locally")
    return problems
```

The two thresholds catch different things. A large median with a small spread is a uniform datum offset. A small median with a large spread is a terrain resolution problem — the DEM is too coarse to follow the ground under each footing, which is a different fix again.

<figure class="diagram">
<svg viewBox="16 42 604 214" role="img" aria-labelledby="zf-tri-t zf-tri-d" xmlns="http://www.w3.org/2000/svg">
  <title id="zf-tri-t">What the median and the spread say together</title>
  <desc id="zf-tri-d">A large median gap with a small spread is a uniform datum offset. A small median with a large spread means the terrain is too coarse to follow the ground under each footing. Both small is a genuine coincident-surface case and the only one where a renderer setting is the right response.</desc>
  <rect class="svg-bg" x="16" y="42" width="604" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="200" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="30" y="98" width="200" height="34" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="30" y="140" width="200" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="182" width="200" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="78">large median, small spread</text>
    <text x="130" y="120">small median, large spread</text>
    <text x="130" y="162">both small</text>
    <text x="130" y="204">both large</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="252" y="78">uniform datum offset — convert the layer</text>
    <text x="252" y="120">terrain too coarse under the footings</text>
    <text x="252" y="162">genuinely coincident — near plane, or sink 5 cm</text>
    <text x="252" y="204">two unrelated faults; fix the datum first</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Only the third row is a rendering problem, and it is the least common of the four</text>
</svg>
<figcaption>Two numbers, four diagnoses. Reaching for a depth bias answers one of them and conceals the other three.</figcaption>
</figure>

## Expected Output & Verification

A representative check over forty footings:

```text
median gap -33.4 cm, spread 4.1 cm
geoid separation here: -33.412 m
near 0.1 m → 6.10 mm resolution at 2 km
logarithmic depth enabled: true
```

That is a settled diagnosis: the median gap matches the geoid separation to within a centimetre, the spread is small, and the depth buffer is already logarithmic. The problem is a datum mismatch and no renderer change would have addressed it.

After the fix, the same check should read a median within a few centimetres of zero and a spread under ten, and the flicker should be gone without any depth setting having changed. If flicker persists once the gap is genuinely zero, that is when the near plane and the deliberate clearance in step 4 apply.

## Common Errors

**A depth bias made it go away, so it was a rendering problem.** It made the *symptom* go away. Measure the gap first; a bias applied over a datum error hides the evidence and leaves every elevation-dependent product wrong.

**The gap varies wildly between footings.** The terrain is too coarse to follow the ground beneath each building, so each footing sits on an interpolated cell rather than on measured ground. That needs a finer DEM under the built area, not a datum fix.

**Flicker only at certain camera angles.** The two surfaces intersect rather than being merely coincident, which is the datum case seen from a grazing view. The gap measurement will show a sign change across the site.

**Everything is correct and the flicker persists on one machine.** That device fell back to a non-logarithmic depth buffer. Check `scene.logarithmicDepthBuffer` on the affected client rather than on yours.

## Frequently Asked Questions

### Should buildings always be sunk into the terrain?
Where they sit on it, yes, by a few centimetres. It is invisible, it is inside survey tolerance, and it removes the whole class of coincident-surface flicker without any renderer configuration.

### Does raising the near plane have a downside?
Only if the camera goes closer to geometry than the new value, at which point geometry disappears. For a city viewer whose camera stays above street level, a near plane of one metre is safe and buys an order of magnitude of depth precision.

### Can this be checked without a browser?
The gap can, and that is the check that matters. Sample the DEM at each footing coordinate with `rasterio` and difference it against the building base height from the footprint layer — no renderer involved.

A closing note on where this check belongs. It is cheap enough to run on every build — forty terrain samples and forty differences — and it catches a class of fault that no other gate sees, because both layers are individually valid and the defect exists only in their relationship. Running it as part of the tileset gate, alongside the bounding-volume containment check, costs a second and turns a datum mismatch from something a viewer reports into something a build refuses.

## Related Guides

- [Cross-Section Failure Modes in Digital Twins](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/) — why this fault spans two pipelines
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the underlying cause in most cases
- [Streaming & Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — the wider runtime symptom framework

Back to [Cross-Section Failure Modes in Digital Twins](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).
