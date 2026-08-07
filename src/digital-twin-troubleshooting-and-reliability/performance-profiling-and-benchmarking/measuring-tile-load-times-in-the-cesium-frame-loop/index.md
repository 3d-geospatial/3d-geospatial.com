---
title: "Measuring Tile Load Times in the Cesium Frame Loop"
description: "Instrument request, decode and GPU upload separately in CesiumJS, use the Resource Timing API for the network half, and read a frame budget that adds up."
---
# Measuring Tile Load Times in the Cesium Frame Loop

This page instruments a CesiumJS client so that "the tiles are slow" becomes four numbers — request latency, decode time, GPU upload, and draw — measured separately and adding up to the frame budget. The instrumentation is light enough to leave running in production, which matters because the interesting cases happen on a viewer's connection and hardware rather than on yours.

## Why you hit this

A tile's journey has four stages with completely different remedies, and every one of them presents to a user as the same symptom. A slow network means prefetching earlier; a slow decode means different compression settings; a slow upload means smaller or fewer buffers; a slow draw means too many draw calls. Choosing between them by inspection is guesswork, and the browser's default profiler distorts the frame budget it is supposed to be measuring.

The diagnostic framework this feeds is in [streaming and runtime diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/); this page is about producing the numbers it reads.

## Prerequisites

- CesiumJS 1.107+ (earlier versions expose fewer tile events), served over HTTPS so `performance` timing is unthrottled.
- A tileset you can reload, and a repeatable camera path — a scripted flight, not a hand-flown one.
- Chrome or Chromium for `PerformanceObserver` and the Resource Timing API. Both work in Firefox with minor naming differences.
- `Timing-Allow-Origin` set on the tile CDN, or cross-origin resource timings return zeros for everything except duration.

## Step-by-Step

### 1. Capture the network half with Resource Timing

The browser already measures every tile request. You only have to collect it.

```javascript
const netStats = [];

const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (!/\.(b3dm|glb|pnts|subtree)$/.test(e.name)) continue;
    netStats.push({
      url: e.name,
      wait: e.responseStart - e.requestStart,       // server think time
      download: e.responseEnd - e.responseStart,     // transfer
      total: e.duration,
      bytes: e.encodedBodySize,
      cached: e.transferSize === 0,
    });
  }
});
obs.observe({ type: 'resource', buffered: true });

function summariseNetwork() {
  const live = netStats.filter((s) => !s.cached);
  const p = (arr, q) => arr.sort((a, b) => a - b)[Math.floor(arr.length * q)] || 0;
  const totals = live.map((s) => s.total);
  console.table({
    requests: live.length,
    cacheHits: netStats.length - live.length,
    p50_ms: p(totals, 0.5).toFixed(1),
    p95_ms: p(totals, 0.95).toFixed(1),
    medianKB: (p(live.map((s) => s.bytes), 0.5) / 1024).toFixed(1),
  });
}
```

Separating `wait` from `download` is what distinguishes a CDN miss from a fat tile. A p95 wait of 400 ms with a small download means requests are reaching the origin; a small wait with a long download means the tiles are simply large.

### 2. Time decode and upload inside the frame loop

CesiumJS raises events as a tile moves through its lifecycle. Timing between them gives decode and upload separately.

```javascript
const tileset = await Cesium.Cesium3DTileset.fromUrl('/live/tileset.json');
viewer.scene.primitives.add(tileset);

const started = new Map();
const timings = { decode: [], upload: [] };

tileset.tileLoad.addEventListener((tile) => {
  const t = started.get(tile._header.content?.uri);
  if (t) timings.decode.push(performance.now() - t);
});
tileset.tileVisible.addEventListener((tile) => {
  const t = started.get(tile._header.content?.uri);
  if (t) {
    timings.upload.push(performance.now() - t);
    started.delete(tile._header.content?.uri);
  }
});
tileset.tileFailed.addEventListener((e) => console.warn('tile failed', e.url, e.message));

Cesium.RequestScheduler.requestCompletedEvent.addEventListener(() => {
  // nothing here; the hook exists so the scheduler's queue depth can be sampled
});
```

`tileLoad` fires when the content has been parsed and decoded; `tileVisible` fires on the first frame the tile is actually drawn, which is after the GPU upload. The difference between them is the upload cost, and it is frequently larger than people expect for texture-heavy tiles.

<figure class="diagram">
<svg viewBox="16 56 721 166" role="img" aria-labelledby="ct-events-t ct-events-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ct-events-t">Which Cesium event marks which boundary</title>
  <desc id="ct-events-d">The request begins when the scheduler admits a tile, the Resource Timing entry ends when the bytes arrive, tileLoad fires once the content is parsed and decoded, and tileVisible fires on the first frame the tile is drawn. Each interval between those marks is one of the four costs, and each has a different remedy.</desc>
  <rect class="svg-bg" x="16" y="56" width="721" height="166" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="70" width="150" height="34" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="70" width="230" height="34" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="414" y="70" width="180" height="34" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="596" y="70" width="120" height="34" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="105" y="92">queued</text>
    <text x="297" y="92">network — Resource Timing</text>
    <text x="504" y="92">decode — to tileLoad</text>
    <text x="656" y="92">upload — to tileVisible</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="105" y="128">backpressure</text>
    <text x="297" y="128">CDN, tile size</text>
    <text x="504" y="128">Draco settings</text>
    <text x="656" y="128">buffer count, textures</text>
  </g>
  <text x="380" y="176" fill="#15384a" font-size="12.5" text-anchor="middle">Four intervals, four remedies — and the user reports all four as &quot;the tiles are slow&quot;</text>
  <text x="380" y="204" fill="#5b6471" font-size="12" text-anchor="middle">The sum should account for the observed latency; a large unexplained remainder means the scheduler queue, not the tile</text>
</svg>
<figcaption>Each boundary has an event or a timing entry behind it, so the split costs a few listeners rather than a profiler.</figcaption>
</figure>

### 3. Sample the scheduler's queue depth

Time spent queued is invisible in every per-tile measurement, and it is often the largest component when the camera moves quickly.

```javascript
const queueSamples = [];
viewer.scene.postRender.addEventListener(() => {
  queueSamples.push({
    t: performance.now(),
    inFlight: Cesium.RequestScheduler.statistics.numberOfActiveRequests,
    pending: Cesium.RequestScheduler.statistics.numberOfPendingRequests,
    tilesLoading: viewer.scene.primitives.get(0).tilesLoaded ? 0 : 1,
  });
  if (queueSamples.length > 3600) queueSamples.shift();      // keep one minute at 60 fps
});
```

A pending count that sits at hundreds while `inFlight` sits at six is the browser's per-host connection limit doing the scheduling for you, which is the case [backpressure](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) exists to prevent.

### 4. Measure the frame itself, cheaply

`performance.measure` around the render is enough, and unlike the DevTools profiler it does not change what it measures.

```javascript
let frames = 0;
const frameTimes = [];

viewer.scene.preUpdate.addEventListener(() => performance.mark('f0'));
viewer.scene.postRender.addEventListener(() => {
  performance.mark('f1');
  performance.measure('frame', 'f0', 'f1');
  const m = performance.getEntriesByName('frame').pop();
  frameTimes.push(m.duration);
  performance.clearMarks(); performance.clearMeasures();

  if (++frames % 600 === 0) {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    console.log(
      `frames ${frames} | p50 ${sorted[sorted.length >> 1].toFixed(1)} ms` +
      ` | p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} ms` +
      ` | over 16.7ms: ${(100 * frameTimes.filter((d) => d > 16.7).length / frameTimes.length).toFixed(1)}%`);
    frameTimes.length = 0;
  }
});
```

Report the p95 and the fraction over budget rather than the mean. A mean of 12 ms with 8% of frames over 30 ms feels considerably worse than a steady 16 ms, and only the distribution shows it.

### 5. Fly a scripted path so runs are comparable

A hand-flown camera makes every measurement incomparable with the last one.

```javascript
async function flyPath(viewer, waypoints, secondsEach = 4) {
  for (const wp of waypoints) {
    await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
        orientation: { heading: Cesium.Math.toRadians(wp.heading), pitch: Cesium.Math.toRadians(-35) },
        duration: secondsEach,
        complete: resolve,
      });
    });
  }
}

await flyPath(viewer, [
  { lon: 10.7522, lat: 59.9139, height: 1800, heading: 0 },
  { lon: 10.7601, lat: 59.9210, height: 600,  heading: 45 },
  { lon: 10.7480, lat: 59.9165, height: 250,  heading: 190 },
]);
summariseNetwork();
```

<figure class="diagram">
<svg viewBox="5 46 730 198" role="img" aria-labelledby="ct-budget-t ct-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ct-budget-t">A frame budget that adds up, and one that does not</title>
  <desc id="ct-budget-d">When the measured stages sum to close to the observed frame time, the instrumentation is complete and the largest stage is the one to attack. When a large remainder is unaccounted for, the time is being spent somewhere not instrumented — usually queued in the request scheduler or blocked on the browser's connection limit.</desc>
  <rect class="svg-bg" x="5" y="46" width="730" height="198" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="60" height="28" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="120" y="60" width="150" height="28" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="60" width="90" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="60" width="40" height="28" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="128" width="60" height="28" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="120" y="128" width="150" height="28" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="128" width="90" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="128" width="40" height="28" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="400" y="128" width="240" height="28" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="start">
    <text x="410" y="80">sum ≈ observed — instrumentation complete</text>
    <text x="650" y="148">unaccounted</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="90" y="106">queue</text>
    <text x="195" y="106">network</text>
    <text x="315" y="106">decode</text>
    <text x="380" y="106">upload</text>
  </g>
  <text x="370" y="196" fill="#b0413e" font-size="12.5" text-anchor="middle">A large remainder means the time is somewhere you are not measuring — usually the scheduler queue</text>
  <text x="370" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Chasing the largest measured bar while a bigger unmeasured one exists is the most common wasted optimisation here</text>
</svg>
<figcaption>The completeness check comes before the optimisation. A budget that does not add up is pointing at the wrong bar.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="42 30 715 228" role="img" aria-labelledby="ct-dist-t ct-dist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ct-dist-t">Why the mean frame time hides the problem</title>
  <desc id="ct-dist-d">Two clients with the same mean frame time feel completely different. A tight distribution around eleven milliseconds is smooth. A distribution with the same mean but a long tail past thirty milliseconds stutters visibly, and only the ninety-fifth percentile and the fraction over budget distinguish them.</desc>
  <rect class="svg-bg" x="42" y="30" width="715" height="228" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="120" y="60" width="26" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="52" width="26" height="34" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="180" y="44" width="26" height="42" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="210" y="52" width="26" height="34" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="240" y="62" width="26" height="24" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="120" y="150" width="26" height="34" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="150" y="144" width="26" height="40" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="180" y="152" width="26" height="32" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="240" y="168" width="26" height="16" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="330" y="172" width="26" height="12" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="420" y="176" width="26" height="8" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="178" width="26" height="6" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <path d="M100 86 H620 M100 184 H620" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M296 40 V96" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="4 4"/>
  <path d="M296 138 V194" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="4 4"/>
  <text x="640" y="72" fill="#4f7a4d" font-size="12" text-anchor="start">p50 11.2, p95 14.1</text>
  <text x="640" y="170" fill="#c46a3d" font-size="12" text-anchor="start">p50 11.4, p95 28.9</text>
  <text x="296" y="112" fill="#5b6471" font-size="11" text-anchor="middle">16.7 ms</text>
  <text x="296" y="214" fill="#5b6471" font-size="11" text-anchor="middle">16.7 ms</text>
  <text x="370" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Same mean, and only the second one stutters. Report p95 and the fraction over budget, never the average.</text>
</svg>
<figcaption>Frame time is a distribution, and its tail is what a viewer notices. A mean is the one summary that hides exactly the thing being complained about.</figcaption>
</figure>

## Expected Output & Verification

A representative run over a scripted three-waypoint path on a city tileset:

```text
┌──────────────┬────────┐
│ requests     │  412   │
│ cacheHits    │  1104  │
│ p50_ms       │  38.2  │
│ p95_ms       │ 214.7  │
│ medianKB     │  86.4  │
└──────────────┴────────┘
frames 600 | p50 11.4 ms | p95 28.9 ms | over 16.7ms: 12.3%
decode p50 17.9 ms | upload p50 5.2 ms
pending p95 186 | inFlight p95 6
```

Two findings fall out of that immediately. `inFlight` pegged at six with a p95 pending of 186 is the browser's connection limit scheduling the work, so the client needs backpressure before anything else is worth tuning. And a decode p50 of 17.9 ms against an upload of 5.2 ms says the Draco settings, not the geometry size, are what cost the frame.

Verify by re-flying the same path twice and comparing. Anything that moves by more than about ten per cent between identical flights is measuring the network's mood rather than the client.

## Common Errors

**Every Resource Timing entry has zeros except `duration`.** The tile CDN is cross-origin and does not send `Timing-Allow-Origin`. Add it, or the network split is unavailable and only the total remains.

**Decode times look impossibly small.** The tiles came from the HTTP cache, so there was nothing to fetch and little to parse. Filter on `transferSize === 0` and report cached and live separately.

**The DevTools profiler shows a completely different frame time.** It is instrumenting every call and inflating the budget. Use it to find a hot function once, and take the numbers you quote from `performance.measure`.

**`tileVisible` never fires for some tiles.** Those tiles were culled after loading, which is normal near the frustum edge and pathological if it is most of them — that is the [over-fetch signature](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).

## Frequently Asked Questions

### Can this instrumentation stay in production?
Yes. Four event listeners and a `performance.measure` per frame cost well under a tenth of a millisecond, and the data is exactly what you need when a user reports a problem you cannot reproduce.

### How do I get these numbers off a user's machine?
Batch the summary — percentiles, not per-tile records — and post it to your own endpoint every few minutes. Per-tile detail is large, largely uninteresting, and carries the user's navigation path with it.

### Does the camera path need to be identical between runs?
Yes, if the runs are to be compared. Scripted `flyTo` waypoints with fixed durations are reproducible; a hand-flown path is not, and the difference between two hand-flown runs routinely exceeds the effect being measured.

One practical caveat about where these numbers come from. Everything above measures the client you are sitting at, and the interesting cases are almost never that client — they are a viewer on a throttled connection, on a device three years old, at a time of day when your CDN's nearest edge is saturated. That is why the instrumentation is designed to be cheap enough to leave running: the summary it emits every few minutes is the only evidence you will have about a problem you cannot reproduce.

When you do collect from real viewers, send percentiles rather than per-tile records. A per-tile stream is large, dominated by uninteresting successes, and carries the viewer's navigation path with it — which is both a privacy consideration and a needless volume of data. Five numbers per session, batched, answer every question the detail would have.

Finally, keep the scripted flight path in version control next to the client. A performance comparison between two releases is only meaningful if both flew the same route, and a route that lives in somebody's browser history is not reproducible by anyone else.

### Do these listeners affect the frame budget they measure?
Marginally. Four event listeners and one `performance.measure` per frame cost well under a tenth of a millisecond, which is inside the noise of the numbers being reported and orders of magnitude below what the DevTools profiler adds.


### What is a reasonable target for the fraction of frames over budget?
Under about two per cent on the device class you are targeting. Above five per cent the stutter is perceptible to most viewers even when the median frame time looks healthy, and above ten it reads as a broken client regardless of what the average says.

### Should the summary include tiles that failed?
Yes, separately. A `tileFailed` rate that is non-zero but small usually means a handful of availability bits disagree with what was published, and it is invisible in every timing statistic because a failed tile has no load time at all.


## Related Guides

- [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/) — where client profiling fits
- [Streaming & Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — turning these numbers into a diagnosis
- [Benchmarking Draco Decode on Mobile GPUs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/benchmarking-draco-decode-on-mobile-gpus/) — when decode is the dominant bar

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
