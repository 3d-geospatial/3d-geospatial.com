# Tuning Tileset Cache Bytes for Memory-Constrained Clients

This page sizes the memory budget of a CesiumJS `Cesium3DTileset` from measurements instead of defaults — estimating the decoded GPU and CPU bytes of each tile offline with `pygltflib`, deriving the working set a typical view needs, choosing `cacheBytes` and `maximumCacheOverflowBytes` per device class, and detecting the cache thrash that shows up as endless re-downloads on phones viewing a city tileset in EPSG:4978.

## Why you hit this

A tileset that runs smoothly on a development laptop crashes a browser tab on a mid-range phone, or never crashes but reloads the same tiles every time the user pans back and forth. Both are memory-budget problems. CesiumJS keeps loaded tiles in a cache up to `cacheBytes` (512 MiB by default) and lets it grow by up to `maximumCacheOverflowBytes` more when the current view genuinely needs it. The defaults are reasonable for a desktop GPU and wrong for a phone with shared memory, and they are wrong in the other direction for a workstation rendering a whole district at a low screen-space error. The traversal settings that decide how many tiles a view needs are in [tuning maximum screen space error in Cesium](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/tuning-maximum-screen-space-error-in-cesium/).

## Prerequisites

- CesiumJS 1.107 or later, where `cacheBytes`, `maximumCacheOverflowBytes` and `memoryAdjustedScreenSpaceError` replaced the older `maximumMemoryUsage` option.
- Python 3.10+ with `pygltflib>=1.16`, `Pillow>=10` and `numpy>=1.24` for the offline estimate.
- A local copy of a representative sample of tile content (`.glb`) from the production tileset, including the texture-heavy districts.

## Step-by-Step

### 1. Estimate decoded bytes per tile

File size is a poor proxy for memory. A 400 KB Draco-compressed tile with a 2048² JPEG decodes to over 20 MB of GPU memory. Estimate what the runtime actually holds.

```python
import io
from pathlib import Path

import numpy as np
from PIL import Image
from pygltflib import GLTF2

COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

def decoded_bytes(path):
    g = GLTF2().load_binary(str(path))
    geometry = sum(a.count * COMPONENT_BYTES[a.componentType] * TYPE_COUNT[a.type] for a in g.accessors)
    blob = g.binary_blob()
    textures = 0
    for img in g.images:
        view = g.bufferViews[img.bufferView]
        data = blob[view.byteOffset or 0:(view.byteOffset or 0) + view.byteLength]
        w, h = Image.open(io.BytesIO(data)).size
        textures += int(w * h * 4 * 4 / 3)          # RGBA8 plus a full mip chain
    return geometry, textures

rows = [decoded_bytes(p) for p in sorted(Path("sample/tiles").glob("*.glb"))]
geo, tex = np.array(rows).T
total = geo + tex
print(f"{len(rows)} tiles | decoded MB per tile: median {np.median(total) / 1e6:.1f}, "
      f"p90 {np.percentile(total, 90) / 1e6:.1f}, max {total.max() / 1e6:.1f} | "
      f"textures are {100 * tex.sum() / total.sum():.0f}% of memory")
```

Accessor counts give uncompressed geometry size regardless of Draco or meshopt, because the runtime decodes them to typed arrays before upload. Texture memory is width × height × 4 bytes, plus a third for mipmaps; KTX2 textures transcoded to a GPU format use less, so treat this as an upper bound for them. The share of memory in textures is usually the most useful number on the page — above 70% it points at texture resolution, not triangle count, as the lever.

### 2. Estimate the working set of a typical view

```python
tiles_in_view = {"street": 220, "district": 480, "overview": 160}   # measured at the target maximumScreenSpaceError
p90 = np.percentile(total, 90)
for view, n in tiles_in_view.items():
    print(f"{view:<9} ≈ {n * np.median(total) / 2**20:6.0f} MiB typical, {n * p90 / 2**20:6.0f} MiB dense")
```

Treat the dense figure with some scepticism before designing around it. It assumes every tile in view is a p90 tile, which only happens over the most texture-heavy blocks — a historic centre with photogrammetry, or a campus modelled from BIM with full material sets. If those areas are also where users spend most of their time, the dense figure is the real requirement; if they are a small part of the city, it is the case the overflow allowance and memory-adjusted screen-space error are there to absorb, and sizing the base cache for it wastes memory everywhere else.

The tile counts come from the running application: log `tileset.tilesLoaded`-driven counts or count `tileLoad` events for a scripted camera path at the maximum screen-space error you intend to ship. The median-based figure is what the cache must hold for a typical view without evicting visible tiles; the p90 figure is the dense-district case the overflow allowance exists for.

<figure class="diagram">
<svg viewBox="46 6 688 258" role="img" aria-labelledby="cb-mem-t cb-mem-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cb-mem-t">Tileset memory against the two budgets during a flight</title>
  <desc id="cb-mem-d">Memory usage over a camera flight rises as the user zooms into a district, levels off at cacheBytes while tiles outside the view are evicted, briefly climbs into the overflow allowance over a dense area where the visible set alone exceeds cacheBytes, and falls back once the view simplifies. A dashed line above marks cacheBytes plus maximumCacheOverflowBytes, beyond which memory-adjusted screen-space error coarsens the view instead.</desc>
  <rect class="svg-bg" x="46" y="6" width="688" height="258" fill="#ffffff"/>
  <path d="M60 20 V200 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 110 H720" fill="none" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M60 60 H720" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M60 196 C120 190 160 150 220 118 L300 112 C330 112 360 110 380 108 C410 80 450 72 480 76 C510 84 530 106 560 112 L720 114" fill="none" stroke="#9a4f26" stroke-width="2.5"/>
  <text x="712" y="102" fill="#1f6b8a" font-size="12" text-anchor="end">cacheBytes</text>
  <text x="712" y="52" fill="#b0413e" font-size="12" text-anchor="end">cacheBytes + maximumCacheOverflowBytes</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="140" y="220">zoom in</text>
    <text x="300" y="220">pan: evict, reload</text>
    <text x="450" y="220">dense district: overflow</text>
    <text x="640" y="220">simpler view</text>
  </g>
  <text x="200" y="152" fill="#9a4f26" font-size="12" text-anchor="start">tileset.totalMemoryUsageInBytes</text>
  <text x="390" y="246" fill="#15384a" font-size="12.5" text-anchor="middle">time along a scripted camera path</text>
</svg>
<figcaption>cacheBytes is the level the cache trims back to; the overflow allowance absorbs views whose visible tiles alone exceed it.</figcaption>
</figure>

### 3. Choose budgets per device class

```javascript
// viewer-memory.js
const MiB = 1024 * 1024;

function memoryProfile() {
  const deviceGiB = navigator.deviceMemory ?? 4;            // Chromium only; bucketed, capped at 8
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && deviceGiB <= 4) return { cacheBytes: 256 * MiB, overflow: 128 * MiB, sse: 24 };
  if (touch)                   return { cacheBytes: 384 * MiB, overflow: 192 * MiB, sse: 20 };
  if (deviceGiB <= 4)          return { cacheBytes: 512 * MiB, overflow: 256 * MiB, sse: 16 };
  return { cacheBytes: 1024 * MiB, overflow: 512 * MiB, sse: 12 };
}

const p = memoryProfile();
const tileset = await Cesium.Cesium3DTileset.fromUrl("https://tiles.example.org/city/tileset.json", {
  cacheBytes: p.cacheBytes,
  maximumCacheOverflowBytes: p.overflow,
  memoryAdjustedScreenSpaceError: true,
  maximumScreenSpaceError: p.sse,
});
viewer.scene.primitives.add(tileset);
```

The budgets come from step 2, not from device RAM divided by a guess. With a typical street view measured at about 300 MiB and a dense district at 520 MiB, a phone budget of 256 MiB plus 128 MiB overflow deliberately cannot hold the densest view at full detail — which is why the phone profile also raises `maximumScreenSpaceError`, and why `memoryAdjustedScreenSpaceError` is enabled, letting the runtime coarsen the view rather than exceed the ceiling. `navigator.deviceMemory` is unavailable in Safari and Firefox, so the fallback of 4 GiB combined with the coarse-pointer test sends every iPhone to a phone profile.

### 4. Detect cache thrash

A budget that is too small does not crash; it reloads. Count how often a tile is loaded again shortly after being unloaded.

```javascript
const unloadedAt = new Map();
let reloads = 0, loads = 0;

tileset.tileUnload.addEventListener((tile) => unloadedAt.set(tile.content?.url ?? tile, performance.now()));
tileset.tileLoad.addEventListener((tile) => {
  loads++;
  const key = tile.content?.url ?? tile;
  const t = unloadedAt.get(key);
  if (t !== undefined && performance.now() - t < 10_000) reloads++;
});

setInterval(() => {
  const mem = tileset.totalMemoryUsageInBytes / MiB;
  const thrash = loads ? (100 * reloads / loads).toFixed(1) : "0.0";
  console.log(`tileset ${mem.toFixed(0)} MiB, ${loads} loads, ${thrash}% reloaded within 10 s`);
  reloads = loads = 0;
}, 5000);
```

A reload rate under a few percent during ordinary navigation is healthy. Above 15–20% the cache is evicting tiles the user is about to look at again, which costs bandwidth, decode time and visible pop-in — the symptom investigated from the other side in [eliminating tile popping and pop-in](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/eliminating-tile-popping-and-pop-in/).

<figure class="diagram">
<svg viewBox="34 6 687 250" role="img" aria-labelledby="cb-thr-t cb-thr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cb-thr-t">Reload rate against cache size for a panning session</title>
  <desc id="cb-thr-d">A curve of the percentage of tile loads that are reloads of recently evicted tiles, plotted against cacheBytes for a scripted panning session. At 128 MiB nearly half of all loads are reloads. The rate falls steeply until the cache reaches the typical working set of about 300 MiB, then flattens near two percent, so extra memory beyond that buys almost nothing.</desc>
  <rect class="svg-bg" x="34" y="6" width="687" height="250" fill="#ffffff"/>
  <path d="M80 20 V190 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="300" y="20" width="400" height="170" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1"/>
  <polyline points="100,40 180,82 260,140 320,174 400,182 520,184 680,185" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="210">128</text><text x="260" y="210">256</text><text x="400" y="210">384</text>
    <text x="520" y="210">512</text><text x="680" y="210">1024 MiB</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="72" y="44">48%</text><text x="72" y="190">0%</text>
  </g>
  <text x="500" y="60" fill="#1f2937" font-size="12.5" text-anchor="middle">working set held: reloads ≈ 2%</text>
  <text x="200" y="140" fill="#b0413e" font-size="12.5" text-anchor="end">thrash</text>
  <text x="390" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">cacheBytes, same camera path and screen-space error</text>
</svg>
<figcaption>Past the working set, a larger cache mainly raises the risk of a tab being killed on constrained devices.</figcaption>
</figure>

## Expected Output & Verification

```text
140 tiles | decoded MB per tile: median 1.3, p90 3.9, max 22.4 | textures are 78% of memory
street    ≈    279 MiB typical,    818 MiB dense
district  ≈    609 MiB typical,   1785 MiB dense
overview  ≈    203 MiB typical,    594 MiB dense
tileset 251 MiB, 142 loads, 2.8% reloaded within 10 s
```

Verify on real devices, not emulation. Run the same scripted camera path on a low-end Android phone and an older iPhone with each profile, record `totalMemoryUsageInBytes`, the reload rate and whether the tab survives. The profile is right when memory stays below `cacheBytes + maximumCacheOverflowBytes` for the whole path, the reload rate is under 5%, and a ten-minute soak test — the path on loop — ends with the tab alive and memory flat rather than climbing.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="cb-prof-t cb-prof-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cb-prof-t">Memory profiles by device class</title>
  <desc id="cb-prof-d">A table of four device classes with cache bytes, overflow bytes and maximum screen-space error. Low-memory phones get 256 and 128 MiB with an error of 24. Other phones get 384 and 192 with 20. Low-memory desktops get 512 and 256 with 16. Other desktops get 1024 and 512 with 12.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="240" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="20" width="160" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="20" width="160" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="580" y="20" width="160" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="720" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="92" width="720" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="128" width="720" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="164" width="720" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="140" y="43">device class</text><text x="340" y="43">cacheBytes</text><text x="500" y="43">overflow</text><text x="660" y="43">max SSE</text>
    <text x="140" y="79">phone, ≤ 4 GiB</text><text x="340" y="79">256 MiB</text><text x="500" y="79">128 MiB</text><text x="660" y="79">24</text>
    <text x="140" y="115">phone, other</text><text x="340" y="115">384 MiB</text><text x="500" y="115">192 MiB</text><text x="660" y="115">20</text>
    <text x="140" y="151">desktop, ≤ 4 GiB</text><text x="340" y="151">512 MiB</text><text x="500" y="151">256 MiB</text><text x="660" y="151">16</text>
    <text x="140" y="187">desktop, other</text><text x="340" y="187">1024 MiB</text><text x="500" y="187">512 MiB</text><text x="660" y="187">12</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Starting values for a texture-heavy building tileset; replace with your own measurements.</text>
</svg>
<figcaption>Memory budget and screen-space error move together: a smaller cache only works if the view it has to hold is also coarser.</figcaption>
</figure>

## Common Errors

**`maximumMemoryUsage` has no effect.** It was deprecated in favour of `cacheBytes` and removed in later releases. Replace it; note that the old option was in megabytes and the new ones are in bytes, so a direct copy of the number sets a cache of a few hundred bytes.

**Memory keeps rising past the overflow allowance.** The growth is not in the tileset cache — imagery layers, terrain, entities, or a leak in application code. `totalMemoryUsageInBytes` covers only this tileset; compare it with the browser's own memory tooling to see where the rest is.

**The phone profile never activates on iOS.** `navigator.deviceMemory` is undefined in Safari and the coarse-pointer media query was not checked, so every iPhone got the desktop profile. Always combine the two signals as step 3 does.

## Frequently Asked Questions

### Should several tilesets share one budget?

Each `Cesium3DTileset` has its own cache, so three tilesets at 512 MiB can reach 1.5 GiB. Divide the device budget between them in proportion to their measured working sets, and give the tileset the user is focused on the largest share.

### Does reducing texture size help more than reducing cacheBytes?

Usually, when textures dominate memory as in the example. Halving texture resolution cuts their memory by four and lets a smaller cache hold the same view; reducing the cache without it just increases reloads. KTX2 textures that stay GPU-compressed reduce memory further still.

### Is `memoryAdjustedScreenSpaceError` safe to enable everywhere?

Yes, with the understanding that on constrained devices the view becomes visibly coarser under pressure rather than exceeding the budget. That is almost always the better failure mode for a twin, where a coarser district is acceptable and a crashed tab is not.

## Related Guides

- [Cache Invalidation for Versioned Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/cache-invalidation-for-versioned-tilesets/) — the network cache, as opposed to the in-memory one
- [Tuning Maximum Screen Space Error in Cesium](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/tuning-maximum-screen-space-error-in-cesium/) — setting the view detail the budget must hold
- [Measuring Tile Load Times in the Cesium Frame Loop](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/measuring-tile-load-times-in-the-cesium-frame-loop/) — instrumenting the scripted camera path

Back to [Streaming Sync Patterns for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
