# Tuning Maximum Screen Space Error in Cesium

`maximumScreenSpaceError` is the single number that decides how much of a tileset a client loads, and it is almost always left at its default of 16. This page picks it from measurement instead — establishing what each value costs in bytes, tiles and frame time, showing why the same number behaves differently on a 4K display, and turning the result into a per-device setting rather than a global constant.

## Why you hit this

The parameter is deceptively simple: refine a tile while its geometric error, projected onto the screen, exceeds this many pixels. Lowering it makes the scene sharper and the download larger, and the relationship between the two is steeply non-linear — halving the threshold roughly quadruples the tile count, because each level of refinement is a fourfold subdivision. Teams discover this when a viewer on a large monitor saturates a connection that was comfortable in development, and the usual response is to lower the value further, which is exactly backwards.

The number it is compared against is derived in [computing geometric error for 3D Tiles levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/).

## Prerequisites

- CesiumJS 1.107+ and a tileset whose geometric errors are measured rather than halved from a guess.
- A scripted camera path, so two settings can be compared on identical input.
- The instrumentation from [measuring tile load times in the Cesium frame loop](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/measuring-tile-load-times-in-the-cesium-frame-loop/) — bytes, tile count and frame percentiles.

## Step-by-Step

### 1. Understand what the number is compared against

The client projects a tile's geometric error onto the screen and refines while the result exceeds the threshold.

```javascript
function screenSpaceError(geometricErrorMetres, distanceMetres, viewportHeightPx, fovYRadians) {
  return (geometricErrorMetres * viewportHeightPx)
       / (2.0 * distanceMetres * Math.tan(fovYRadians / 2.0));
}

const fov = Cesium.Math.toRadians(60);
for (const h of [900, 1440, 2160]) {
  const sse = screenSpaceError(0.51, 800, h, fov);
  console.log(`${h}px viewport → ${sse.toFixed(1)} px error`);
}
```

Two of the four inputs belong to the tileset and two to the client. Geometric error and distance are properties of the data and the camera; viewport height and field of view are properties of the display. That is why the same tileset with the same threshold refines differently on two machines, and why a threshold tuned on one is not a property of the tileset at all.

### 2. Measure the cost curve on your own tileset

Fly the same path at several thresholds and record what each one fetched.

```javascript
async function measure(tileset, viewer, sse, waypoints) {
  tileset.maximumScreenSpaceError = sse;
  const before = performance.getEntriesByType('resource').length;
  const t0 = performance.now();

  const frames = [];
  const onRender = () => frames.push(performance.now());
  viewer.scene.postRender.addEventListener(onRender);
  await flyPath(viewer, waypoints);
  await new Promise((r) => {
    const check = () => (tileset.tilesLoaded ? r() : setTimeout(check, 100));
    check();
  });
  viewer.scene.postRender.removeEventListener(onRender);

  const res = performance.getEntriesByType('resource').slice(before);
  const bytes = res.reduce((a, e) => a + (e.encodedBodySize || 0), 0);
  const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);

  return {
    sse,
    tiles: res.length,
    mb: +(bytes / 1e6).toFixed(1),
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    p95Frame: +deltas[Math.floor(deltas.length * 0.95)].toFixed(1),
  };
}

const results = [];
for (const sse of [4, 8, 16, 24, 32]) results.push(await measure(tileset, viewer, sse, PATH));
console.table(results);
```

<figure class="diagram">
<svg viewBox="55 42 689 228" role="img" aria-labelledby="sse-cost-t sse-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sse-cost-t">Bytes fetched against the screen-space error threshold</title>
  <desc id="sse-cost-d">Lowering the threshold from thirty-two to sixteen roughly doubles the bytes fetched over the same camera path. Lowering it from sixteen to eight doubles them again, and from eight to four again, because each halving of the threshold adds a level of fourfold subdivision over the visible extent.</desc>
  <rect class="svg-bg" x="55" y="42" width="689" height="228" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="150" y="56" width="46" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="94" width="72" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="132" width="148" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="150" y="170" width="304" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="150" y="208" width="580" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="206" y="75">sse 32 — 21 MB, 214 tiles</text>
    <text x="232" y="113">sse 24 — 34 MB, 348 tiles</text>
    <text x="308" y="151">sse 16 — 68 MB, 702 tiles</text>
    <text x="464" y="189">sse 8 — 142 MB, 1 480 tiles</text>
    <text x="470" y="227">sse 4 — 271 MB, 2 906 tiles</text>
  </g>
  <text x="370" y="252" fill="#15384a" font-size="12" text-anchor="middle">Each halving of the threshold roughly doubles the download, because it adds a level of fourfold subdivision</text>
</svg>
<figcaption>The curve is geometric, not linear. A change from 16 to 8 that sounds modest is a doubling of everything the client fetches.</figcaption>
</figure>

### 3. Decide what the extra detail is actually buying

The measurement that settles it is perceptual rather than numerical: at what threshold does the scene stop visibly improving?

```javascript
async function captureAt(viewer, tileset, sse, waypoint) {
  tileset.maximumScreenSpaceError = sse;
  await flyTo(viewer, waypoint);
  await new Promise((r) => {
    const check = () => (tileset.tilesLoaded ? r() : setTimeout(check, 100));
    check();
  });
  return viewer.canvas.toDataURL('image/png');
}

const shots = {};
for (const sse of [4, 8, 16, 24, 32]) shots[sse] = await captureAt(viewer, tileset, sse, VIEW);
```

Comparing those frames pairwise is the honest test. On most city tilesets viewed at a typical working distance, the difference between 8 and 16 is visible under scrutiny and the difference between 4 and 8 is not — while the second costs twice the first. That is the point where lowering the threshold stops buying anything a viewer perceives.

### 4. Scale the setting to the viewport

Because viewport height is one of the four inputs, a fixed threshold means a different effective quality on every display.

```javascript
function sseForViewport(baseSse, baseHeightPx, viewer) {
  const h = viewer.canvas.clientHeight * window.devicePixelRatio;
  return baseSse * (h / baseHeightPx);
}

// Tuned as 16 against a 1080-tall canvas; scale it to whatever this display is.
tileset.maximumScreenSpaceError = sseForViewport(16, 1080, viewer);

window.addEventListener('resize', () => {
  tileset.maximumScreenSpaceError = sseForViewport(16, 1080, viewer);
});
```

Scaling with the viewport keeps the *perceived* detail constant instead of the pixel-error constant, which is nearly always what is wanted: a 4K display then fetches the same amount of data for a similar-looking image, rather than 2.4 times as much for an image the viewer cannot distinguish at normal viewing distance.

<figure class="diagram">
<svg viewBox="27 42 687 210" role="img" aria-labelledby="sse-vp-t sse-vp-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sse-vp-t">A fixed threshold means different behaviour on every display</title>
  <desc id="sse-vp-d">With a fixed threshold of sixteen, a 4K display refines about two and a half times as aggressively as a 900-pixel laptop and fetches proportionally more, for an image most viewers cannot distinguish at normal viewing distance. Scaling the threshold with viewport height keeps the perceived detail constant instead.</desc>
  <rect class="svg-bg" x="27" y="42" width="687" height="210" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="120" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="94" width="192" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="132" width="288" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="180" width="120" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="190" y="75">fixed 16, 900 px — 68 MB</text>
    <text x="262" y="113">fixed 16, 1440 px — 109 MB</text>
    <text x="358" y="151">fixed 16, 2160 px — 163 MB</text>
    <text x="190" y="199">scaled to 38 at 2160 px — 71 MB</text>
  </g>
  <text x="370" y="234" fill="#15384a" font-size="12.5" text-anchor="middle">Scaling with viewport height holds the download roughly constant and the perceived detail roughly constant too</text>
</svg>
<figcaption>The bottom row is the same display as the row above it, fetching less than half as much for an image a viewer cannot tell apart.</figcaption>
</figure>

### 5. Adapt when the device or the connection cannot keep up

A single value cannot serve a phone on cellular and a workstation on fibre. Adapting from measurement is straightforward and worth more than any static choice.

```javascript
const TARGET_MS = 16.7;
let ema = TARGET_MS;

viewer.scene.postRender.addEventListener(() => {
  const dt = viewer.clock.deltaTimeSeconds * 1000;
  ema = 0.95 * ema + 0.05 * dt;

  const sse = tileset.maximumScreenSpaceError;
  if (ema > TARGET_MS * 1.5 && sse < 48) {
    tileset.maximumScreenSpaceError = Math.min(48, sse * 1.05);   // ease off
  } else if (ema < TARGET_MS * 0.8 && sse > 8) {
    tileset.maximumScreenSpaceError = Math.max(8, sse * 0.98);    // spend the headroom
  }
});
```

Both bounds matter. Without a ceiling the client degrades indefinitely on a slow device and eventually shows nothing but the coarsest level; without a floor it chases quality on a fast one until it saturates the connection. The asymmetric rates — backing off faster than it recovers — keep the value from oscillating around the target.

<figure class="diagram">
<svg viewBox="46 46 579 210" role="img" aria-labelledby="sse-split-t sse-split-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sse-split-t">Terrain and buildings do not want the same threshold</title>
  <desc id="sse-split-d">Terrain error is smooth and its silhouette is rarely what a viewer is judging, so it tolerates a threshold two or three times higher than buildings. Setting both to the same value spends most of the download budget refining ground that nobody is looking at.</desc>
  <rect class="svg-bg" x="46" y="46" width="579" height="210" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="300" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="98" width="220" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="146" width="110" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="184" width="220" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="370" y="80">terrain at sse 16 — 41 MB</text>
    <text x="290" y="118">buildings at sse 16 — 27 MB</text>
    <text x="180" y="166">terrain at sse 40 — 14 MB</text>
    <text x="290" y="204">buildings at sse 16 — 27 MB</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Raising terrain alone cuts the download by 40% with nothing a viewer can point at</text>
</svg>
<figcaption>The two layers are judged on completely different things, so tuning them together spends the budget where it is least visible.</figcaption>
</figure>

## Expected Output & Verification

A representative sweep over a scripted city path on a 1080-tall canvas:

```text
┌─────┬───────┬───────┬─────────┬──────────┐
│ sse │ tiles │  mb   │ seconds │ p95Frame │
├─────┼───────┼───────┼─────────┼──────────┤
│  4  │ 2906  │ 271.4 │  84.2   │   41.2   │
│  8  │ 1480  │ 142.1 │  43.8   │   28.6   │
│ 16  │  702  │  68.3 │  21.4   │   17.9   │
│ 24  │  348  │  33.9 │  11.2   │   14.1   │
│ 32  │  214  │  20.8 │   7.1   │   12.8   │
└─────┴───────┴───────┴─────────┴──────────┘
```

Read three things. The doubling per halving confirms the tileset's tree is well formed — a curve that flattens instead means refinement is stopping early, which is a [geometric error inversion](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) rather than a tuning result. The p95 frame time crossing the 16.7 ms budget somewhere between 16 and 8 sets the practical floor for this device. And the seconds column is what a viewer experiences as "the city is still loading", which is usually the constraint that actually decides the value.

## Common Errors

**Lowering the threshold does not sharpen the scene.** Refinement is stopping for another reason — an inverted geometric error, a missing child tile, or a memory budget that is evicting as fast as it loads. Check `tileset.statistics` before tuning further.

**A value that works in development saturates a viewer's connection.** It was tuned on a smaller viewport. Scale with viewport height, or tune on the largest display you intend to support.

**The adaptive loop oscillates visibly.** The adjustment rates are symmetric or too large. Back off faster than you recover, cap both ends, and smooth the frame time with an exponential moving average rather than reacting to single frames.

**Bytes do not fall when the threshold rises.** The client is fetching for a larger region than it draws, which is over-fetching from loose bounding volumes rather than a threshold problem.

## Frequently Asked Questions

### Is 16 a bad default?
It is a reasonable default and a poor final answer. It was chosen for a typical desktop viewport, and whether it suits your tileset depends on your geometric errors, your tile sizes and your viewers' displays — all of which are measurable in an afternoon.

### Should terrain and buildings share a threshold?
No. Terrain tolerates a much higher value because its error is smooth and its silhouette is rarely the subject, while buildings are judged on their outlines. Setting terrain two to three times higher than buildings typically halves the total download with no perceptible loss.

### Does raising the threshold help a memory-constrained client?
Yes, and it is the most direct lever available. Fewer refined tiles means fewer resident buffers, so a device evicting constantly usually stabilises with a higher threshold rather than a larger cache.

One last framing that helps the conversation with whoever owns the product. `maximumScreenSpaceError` is not a quality setting in any sense a stakeholder would recognise; it is a statement about how much of the data the client is allowed to fetch before it stops. Presenting the measured table — bytes, tiles and seconds against the threshold — turns "make it sharper" into a priced choice, and the choice is nearly always made differently once the price is on the same page as the picture.

The corollary is that the number belongs in configuration rather than in code. Different deployments of the same tileset legitimately want different values — a kiosk on a wired connection, a field tablet on cellular, an embedded view in a planning portal — and none of them is the tileset's business.

## Related Guides

- [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the tree and the refinement test
- [Computing Geometric Error for 3D Tiles Levels](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/computing-geometric-error-for-3d-tiles-levels/) — the metres this pixel budget is compared against
- [Streaming & Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — separating a threshold problem from an over-fetch

Back to [Hierarchical LOD Structuring](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/).
