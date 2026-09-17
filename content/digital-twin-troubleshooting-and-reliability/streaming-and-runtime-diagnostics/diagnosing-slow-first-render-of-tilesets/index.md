# Diagnosing Slow First Render of Tilesets

This page breaks the time between a page load and a usable map into its measurable stages — the pointer and root fetch, the tree walk that discovers which tiles are needed, the request burst, the decode on the worker threads and the GPU upload — attributes the seconds to each, and fixes whichever dominates rather than guessing.

## Why you hit this

"The map takes eleven seconds to appear" is a complaint with at least six distinct causes, and the fixes are mutually exclusive. A tileset whose root JSON is 12 MB has a different problem from one whose tiles decode slowly, and both look identical to the user.

The stages are also serialised in a way that makes intuition unreliable: nothing can be requested until the root JSON is parsed, and on a deep tree nothing useful can be requested until several levels of external subtrees have been fetched one after another. Three round trips before the first tile request is common, and on a 200 ms link that is 600 ms nobody attributes correctly.

## Prerequisites

- CesiumJS 1.100 or later; the browser's Performance and Network panels.
- A tileset served with the headers it will have in production, because caching changes the answer.
- A repeatable entry view — the one users land on.

## Step-by-Step

### 1. Instrument the stages

```javascript
const MARKS = {
  navigationStart: 'nav',
  pointerFetched: 'pointer-fetched',
  rootRequested: 'root-requested',
  rootParsed: 'root-parsed',
  firstTileRequested: 'first-tile-requested',
  firstTileArrived: 'first-tile-arrived',
  firstTileReady: 'first-tile-ready',
  firstPaint: 'first-paint',
  settled: 'settled',
};

export function instrument() {
  const marks = new Map();
  const mark = (name) => {
    const t = performance.now();
    marks.set(name, t);
    performance.mark(name);
    return t;
  };
  return { marks, mark };
}

export async function measureFirstRender(viewer, { pointerUrl, view,
                                                   settleTimeoutMs = 30_000 } = {}) {
  const { marks, mark } = instrument();
  mark(MARKS.navigationStart);

  let tilesetUrl = pointerUrl;
  if (pointerUrl.endsWith('current.json')) {
    const res = await fetch(pointerUrl, { cache: 'no-cache' });
    const doc = await res.json();
    tilesetUrl = new URL(doc.tilesetUrl, pointerUrl).href;
    mark(MARKS.pointerFetched);
  }

  mark(MARKS.rootRequested);
  const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
    maximumScreenSpaceError: 16,
    cacheBytes: 1_073_741_824,
    preloadWhenHidden: false,
  });
  mark(MARKS.rootParsed);

  let firstRequest = null;
  let firstReady = null;
  tileset.tileLoad.addEventListener(() => {
    if (firstReady === null) firstReady = mark(MARKS.firstTileReady);
  });
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (firstRequest === null && entry.name.includes('/content/')) {
        firstRequest = marks.get(MARKS.firstTileRequested)
          ?? mark(MARKS.firstTileRequested);
        marks.set(MARKS.firstTileArrived, entry.responseEnd);
      }
    }
  });
  observer.observe({ type: 'resource', buffered: true });

  viewer.scene.primitives.add(tileset);
  viewer.camera.setView(view);

  await new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      if (tileset.statistics.selected > 0 && !marks.has(MARKS.firstPaint)) {
        mark(MARKS.firstPaint);
      }
      if (tileset.tilesLoaded || performance.now() - started > settleTimeoutMs) {
        mark(MARKS.settled);
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  observer.disconnect();

  return { tileset, marks, stages: stageBreakdown(marks) };
}

function stageBreakdown(marks) {
  const at = (k) => marks.get(k) ?? null;
  const span = (a, b) => (at(a) !== null && at(b) !== null
    ? Number((at(b) - at(a)).toFixed(1)) : null);
  return {
    pointerMs: span(MARKS.navigationStart, MARKS.pointerFetched),
    rootFetchParseMs: span(MARKS.rootRequested, MARKS.rootParsed),
    rootToFirstRequestMs: span(MARKS.rootParsed, MARKS.firstTileRequested),
    firstTileNetworkMs: span(MARKS.firstTileRequested, MARKS.firstTileArrived),
    firstTileDecodeMs: span(MARKS.firstTileArrived, MARKS.firstTileReady),
    firstPaintMs: span(MARKS.navigationStart, MARKS.firstPaint),
    settledMs: span(MARKS.navigationStart, MARKS.settled),
  };
}
```

Marking the stages with `performance.mark` rather than only recording numbers means they appear in the browser's Performance panel timeline alongside the network waterfall, which is where the serialisation becomes visible.

The `rootToFirstRequestMs` span is the one that surprises people. It covers the tree walk and, on a tileset with external subtrees, every subtree fetch needed before a leaf can be identified — so a value of 1,400 ms with a 4 MB root JSON is not parsing time, it is three serialised round trips.

Separating `firstTileNetworkMs` from `firstTileDecodeMs` is what splits a transport problem from a decode problem. They need opposite fixes and the browser's network panel shows only the first.

### 2. Measure the root document honestly

```javascript
export async function rootDocumentReport(tilesetUrl) {
  const res = await fetch(tilesetUrl, { cache: 'no-store' });
  const encoded = Number(res.headers.get('Content-Length') ?? 0);
  const text = await res.text();
  const doc = JSON.parse(text);

  let tiles = 0;
  let externals = 0;
  let maxDepth = 0;
  let contentTiles = 0;
  const walk = (tile, depth) => {
    tiles += 1;
    maxDepth = Math.max(maxDepth, depth);
    const uri = tile.content?.uri;
    if (uri) {
      if (uri.endsWith('.json') || uri.endsWith('.subtree')) externals += 1;
      else contentTiles += 1;
    }
    for (const child of tile.children ?? []) walk(child, depth + 1);
  };
  walk(doc.root, 0);

  const implicit = Boolean(doc.root.implicitTiling);
  return {
    decodedKB: Number((text.length / 1024).toFixed(1)),
    encodedKB: encoded ? Number((encoded / 1024).toFixed(1)) : null,
    compressed: Boolean(encoded && encoded < text.length * 0.7),
    contentEncoding: res.headers.get('Content-Encoding'),
    cacheControl: res.headers.get('Cache-Control'),
    tilesInRoot: tiles,
    contentTilesInRoot: contentTiles,
    externalReferences: externals,
    maxDepthInRoot: maxDepth,
    implicitTiling: implicit,
    findings: [
      ...(text.length > 2e6
        ? [{ severity: 'error',
             finding: `root JSON is ${(text.length / 1e6).toFixed(1)} MB decoded`,
             fix: 'split into external subtrees, or switch to implicit tiling' }]
        : []),
      ...(!encoded || encoded >= text.length * 0.7
        ? [{ severity: 'error', finding: 'root JSON is not gzipped',
             fix: 'enable compression for application/json — it is an 8–12× saving' }]
        : []),
      ...(externals > 0 && maxDepth < 3
        ? [{ severity: 'warn',
             finding: `${externals} external references at depth ${maxDepth}`,
             fix: 'each one is a serialised round trip before any tile can be '
                + 'requested; inline the top two levels' }]
        : []),
    ],
  };
}
```

A root JSON that is not gzipped is the most common single cause of a slow first paint and the easiest to fix. Tileset JSON compresses 8–12×, so a 4 MB document becomes 400 KB — and on a 25 Mbps link that is 1.3 seconds recovered by a server configuration change.

External references near the top of the tree are the second cause, and they are worse than their size suggests because they serialise: the client fetches the root, discovers a subtree reference, fetches that, discovers another, and only then knows which tiles to request. Inlining the top two levels turns three round trips into one.

Measuring the **decoded** size alongside the encoded one is what makes the compression finding visible; the network panel shows the transferred size and a 400 KB transfer looks fine until you know it parses to 4 MB.

<figure class="diagram">
<svg viewBox="26 7 597 251" role="img" aria-labelledby="first-serial-t first-serial-d" xmlns="http://www.w3.org/2000/svg">
  <title id="first-serial-t">What happens before the first tile is requested</title>
  <desc id="first-serial-d">A timeline of the first 2.6 seconds. The pointer document takes 180 milliseconds. The root JSON takes 1240 milliseconds because it is 4 megabytes uncompressed. Two levels of external subtree fetches take 240 and 210 milliseconds, serialised one after the other. Only then, at 1.87 seconds, is the first tile requested. The tile itself arrives 210 milliseconds later and decodes in 140. Nothing is drawn for the first 1.87 seconds and no tile request has even been issued.</desc>
  <rect class="svg-bg" x="26" y="7" width="597" height="251" fill="#ffffff"/>
  <path d="M40 176 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.4">
    <rect x="40" y="60" width="46" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="86" y="60" width="316" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="402" y="60" width="62" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="464" y="60" width="54" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="518" y="60" width="54" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="572" y="60" width="36" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="63" y="52">180 ms</text>
    <text x="244" y="52">1,240 ms — 4 MB root, ungzipped</text>
    <text x="433" y="108">240</text>
    <text x="491" y="126">210</text>
    <text x="545" y="108">210</text>
    <text x="590" y="126">140</text>
  </g>
  <g fill="#5b6471" font-size="11" text-anchor="middle">
    <text x="63" y="196">pointer</text>
    <text x="244" y="196">root JSON</text>
    <text x="433" y="150">subtree 1</text>
    <text x="491" y="164">subtree 2</text>
    <text x="545" y="150">tile fetch</text>
    <text x="590" y="164">decode</text>
  </g>
  <path d="M518 40 V60" stroke="#b0413e" stroke-width="2" fill="none"/>
  <text x="518" y="34" fill="#b0413e" font-size="12" text-anchor="middle">first tile requested at 1.87 s</text>
  <text x="370" y="222" fill="#1f2937" font-size="12.5" text-anchor="middle">1.87 of the 2.6 seconds is spent before any tile has been asked for</text>
  <text x="370" y="240" fill="#5b6471" font-size="12" text-anchor="middle">gzip alone recovers 1.1 s; inlining the top two subtree levels recovers another 0.45 s</text>
</svg>
<figcaption>Two thirds of the delay happens before the first tile request, and none of it is visible as slow tile loading.</figcaption>
</figure>

### 3. Measure the request burst

```javascript
export function burstReport(windowMs = 12_000) {
  const now = performance.now();
  const entries = performance.getEntriesByType('resource')
    .filter((e) => e.name.includes('/content/') && now - e.startTime < windowMs);
  if (!entries.length) return { measurable: false };

  const events = [];
  for (const e of entries) {
    events.push({ t: e.startTime, d: +1 });
    events.push({ t: e.responseEnd, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let inflight = 0;
  let peak = 0;
  for (const ev of events) {
    inflight += ev.d;
    peak = Math.max(peak, inflight);
  }

  const queued = entries.map((e) => e.requestStart - e.startTime);
  const ttfb = entries.map((e) => e.responseStart - e.requestStart);
  const download = entries.map((e) => e.responseEnd - e.responseStart);
  const q = (arr, f) => arr.slice().sort((a, b) => a - b)[Math.floor(f * arr.length)];
  const bytes = entries.reduce((s, e) => s + (e.encodedBodySize || 0), 0);
  const span = Math.max(...entries.map((e) => e.responseEnd))
    - Math.min(...entries.map((e) => e.startTime));

  return {
    measurable: true,
    requests: entries.length,
    protocol: entries[0].nextHopProtocol,
    peakConcurrency: peak,
    medianQueuedMs: Math.round(q(queued, 0.5)),
    p95QueuedMs: Math.round(q(queued, 0.95)),
    medianTtfbMs: Math.round(q(ttfb, 0.5)),
    medianDownloadMs: Math.round(q(download, 0.5)),
    burstSeconds: Number((span / 1000).toFixed(2)),
    effectiveMbps: Number(((bytes * 8) / span / 1000).toFixed(1)),
    fromCache: entries.filter((e) => e.transferSize === 0
      && e.decodedBodySize > 0).length,
    findings: [
      ...(peak <= 6
        ? [{ severity: 'error', finding: 'peak concurrency is 6',
             fix: 'HTTP/1.1 connection limit — fix the transport first' }]
        : []),
      ...(q(queued, 0.95) > 500
        ? [{ severity: 'error',
             finding: `p95 queue time ${Math.round(q(queued, 0.95))} ms`,
             fix: 'requests are waiting for a slot; raise the scheduler concurrency' }]
        : []),
      ...(q(ttfb, 0.5) > 200
        ? [{ severity: 'warn',
             finding: `median time to first byte ${Math.round(q(ttfb, 0.5))} ms`,
             fix: 'the origin is far or slow; check the CDN is serving these paths' }]
        : []),
    ],
  };
}
```

Peak concurrency of exactly six is conclusive and is the finding to check before anything else, for the reasons in [HTTP/2 and connection limits for tile streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/). No amount of tile-size tuning helps a first paint that is serialised six at a time.

The **queue time** — the gap between a resource's `startTime` and its `requestStart` — is what distinguishes "the tiles are slow" from "the tiles are waiting". A median queue of 4 ms with a 200 ms time to first byte is a distance problem; a 2,400 ms queue with a 40 ms time to first byte is a concurrency problem.

The `fromCache` count matters for a second load: on a warm cache a first paint should be dominated by decode, and a `fromCache` count of zero on a repeat visit means the `Cache-Control` headers are not doing their job.

### 4. Separate decode from upload

```javascript
export async function decodeReport(viewer, tileset, view, { samples = 40 } = {}) {
  const arrivals = [];
  const ready = [];

  const onLoad = (tile) => {
    ready.push({ t: performance.now(), uri: tile._contentResource?.url ?? '?' });
  };
  tileset.tileLoad.addEventListener(onLoad);

  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name.includes('/content/')) {
        arrivals.push({ t: e.responseEnd, uri: e.name,
                        bytes: e.encodedBodySize || 0 });
      }
    }
  });
  observer.observe({ type: 'resource', buffered: true });

  viewer.camera.setView(view);
  await new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      if (tileset.tilesLoaded || performance.now() - started > 30_000) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  observer.disconnect();
  tileset.tileLoad.removeEventListener(onLoad);

  const byUri = new Map(arrivals.map((a) => [a.uri, a]));
  const pairs = [];
  for (const r of ready) {
    const match = [...byUri.entries()].find(([uri]) => uri.endsWith(r.uri)
      || r.uri.endsWith(uri.split('/').slice(-3).join('/')));
    if (match) pairs.push({ arrivedAt: match[1].t, readyAt: r.t,
                            bytes: match[1].bytes });
  }
  const latencies = pairs.map((p) => p.readyAt - p.arrivedAt).filter((v) => v > 0);
  const q = (arr, f) => arr.slice().sort((a, b) => a - b)[Math.floor(f * arr.length)];

  const longTasks = performance.getEntriesByType('longtask') ?? [];
  return {
    paired: pairs.length,
    medianDecodeMs: latencies.length ? Math.round(q(latencies, 0.5)) : null,
    p95DecodeMs: latencies.length ? Math.round(q(latencies, 0.95)) : null,
    totalDecodeMs: Math.round(latencies.reduce((a, b) => a + b, 0)),
    longTasks: longTasks.length,
    longestTaskMs: longTasks.length
      ? Math.round(Math.max(...longTasks.map((t) => t.duration))) : 0,
    mainThreadBlockedMs: Math.round(longTasks
      .reduce((s, t) => s + Math.max(t.duration - 50, 0), 0)),
    findings: [
      ...(latencies.length && q(latencies, 0.5) > 150
        ? [{ severity: 'error',
             finding: `median decode ${Math.round(q(latencies, 0.5))} ms per tile`,
             fix: 'Draco decode is the bottleneck — switch to meshopt, or make '
                + 'tiles smaller' }]
        : []),
      ...(longTasks.length > 20
        ? [{ severity: 'error',
             finding: `${longTasks.length} long tasks blocking the main thread`,
             fix: 'decode is happening on the main thread — check the worker '
                + 'configuration' }]
        : []),
    ],
  };
}
```

The gap between a tile's `responseEnd` and its `tileLoad` event is the decode plus upload time, and it is the stage the network panel cannot see. A median of 40 ms is normal for a Draco-compressed tile; 300 ms means either the tiles are very large or the decode is not running on workers.

Long tasks are the signal that decode has fallen back to the main thread, which happens when the worker pool fails to initialise — a common consequence of a misconfigured `CESIUM_BASE_URL` or a Content Security Policy blocking the worker script. The symptom is a first paint that is slow *and* an unresponsive page, which distinguishes it from every other cause here.

`mainThreadBlockedMs` sums the blocking beyond the 50 ms long-task threshold, which is the total-blocking-time metric and the closest single number to "the page felt frozen".

<figure class="diagram">
<svg viewBox="5 32 661 222" role="img" aria-labelledby="first-split-t first-split-d" xmlns="http://www.w3.org/2000/svg">
  <title id="first-split-t">Queue, network and decode for one tile</title>
  <desc id="first-split-d">A single tile request broken into three spans and three diagnoses. A long queue span with a short network span means requests are waiting for a connection slot, fixed by raising concurrency or the protocol. A short queue with a long time to first byte means the origin is far away or the CDN is not serving that path. A short queue and network with a long gap before the tile load event means the decode is the bottleneck, which no network change affects.</desc>
  <rect class="svg-bg" x="5" y="32" width="661" height="222" fill="#ffffff"/>
  <g stroke-width="1.4">
    <rect x="130" y="46" width="240" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="46" width="60" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="430" y="46" width="40" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="130" y="102" width="30" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="160" y="102" width="250" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="410" y="102" width="40" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="130" y="158" width="30" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="160" y="158" width="60" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="158" width="250" height="26" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="20" y="64">queue-bound</text>
    <text x="20" y="120">network-bound</text>
    <text x="20" y="176">decode-bound</text>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="480" y="64">raise concurrency / fix HTTP/2</text>
    <text x="460" y="120">check the CDN is serving this path</text>
    <text x="480" y="176">meshopt instead of Draco</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="250" y="212">queue</text>
    <text x="400" y="212">network</text>
    <text x="500" y="212">decode + upload</text>
  </g>
  <text x="370" y="236" fill="#5b6471" font-size="12" text-anchor="middle">the network panel shows only the middle span, which is why two of the three are misdiagnosed</text>
</svg>
<figcaption>All three rows take the same total time; only splitting the span identifies which fix will work.</figcaption>
</figure>

### 5. Attribute the total and find the dominant stage

```javascript
export function attribute(stages, root, burst, decode) {
  const total = stages.firstPaintMs ?? 0;
  const parts = {
    'pointer fetch': stages.pointerMs ?? 0,
    'root fetch + parse': stages.rootFetchParseMs ?? 0,
    'tree walk + subtree fetches': stages.rootToFirstRequestMs ?? 0,
    'first tile network': stages.firstTileNetworkMs ?? 0,
    'first tile decode + upload': stages.firstTileDecodeMs ?? 0,
  };
  const accounted = Object.values(parts).reduce((a, b) => a + b, 0);
  parts['unattributed'] = Math.max(total - accounted, 0);

  const ranked = Object.entries(parts)
    .map(([stage, ms]) => ({ stage, ms: Number(ms.toFixed(1)),
                             share: Number((ms / Math.max(total, 1)).toFixed(3)) }))
    .sort((a, b) => b.ms - a.ms);

  const allFindings = [
    ...(root.findings ?? []), ...(burst.findings ?? []), ...(decode.findings ?? []),
  ];
  return {
    firstPaintMs: Number(total.toFixed(1)),
    settledMs: stages.settledMs,
    breakdown: ranked,
    dominantStage: ranked[0]?.stage,
    dominantShare: ranked[0]?.share,
    findings: allFindings,
    errors: allFindings.filter((f) => f.severity === 'error').length,
    advice: ranked[0]
      ? STAGE_ADVICE[ranked[0].stage] ?? 'investigate with the Performance panel'
      : null,
  };
}

const STAGE_ADVICE = {
  'pointer fetch': 'the pointer should be a few hundred bytes with a short '
    + 'Cache-Control; check it is not being redirected',
  'root fetch + parse': 'gzip the JSON and split the tree into external subtrees, '
    + 'or switch to implicit tiling',
  'tree walk + subtree fetches': 'inline the top two levels of the tree so the '
    + 'first tile request does not wait on serialised fetches',
  'first tile network': 'check the protocol and the CDN; a 200 ms time to first '
    + 'byte means the origin is being hit',
  'first tile decode + upload': 'switch Draco to meshopt for faster decode, or '
    + 'reduce the leaf tile size',
  'unattributed': 'time is going somewhere the marks do not cover — usually the '
    + 'page\'s own JavaScript before Cesium starts',
};
```

Attributing the total and reporting the **dominant** stage is what makes this a diagnosis rather than a dashboard. Every one of the five stages has a different fix, and fixing the second-largest while the largest is 60% of the time produces no perceptible improvement and a strong sense that the effort was wasted.

The `unattributed` bucket is deliberately included and often large on a real application: the page's own bundle parse, framework startup and any authentication round trip all happen before Cesium is asked for anything, and none of it is the tileset's fault.

### 6. Fix the dominant stage and re-measure

```javascript
export async function beforeAfter(viewer, variants, view) {
  const rows = [];
  for (const [label, pointerUrl] of Object.entries(variants)) {
    const { tileset, stages } = await measureFirstRender(viewer,
                                                         { pointerUrl, view });
    const root = await rootDocumentReport(tileset.resource.url);
    const burst = burstReport();
    const decode = await decodeReport(viewer, tileset, view);
    rows.push({ label, ...attribute(stages, root, burst, decode),
                rootEncodedKB: root.encodedKB, rootDecodedKB: root.decodedKB });
    viewer.scene.primitives.remove(tileset);
    performance.clearResourceTimings();
  }
  const [before, after] = rows;
  return {
    rows,
    firstPaintImprovementMs: before && after
      ? Number((before.firstPaintMs - after.firstPaintMs).toFixed(1)) : null,
    improvementShare: before && after
      ? Number(((before.firstPaintMs - after.firstPaintMs)
        / Math.max(before.firstPaintMs, 1)).toFixed(3)) : null,
    dominantStageChanged: before && after
      ? before.dominantStage !== after.dominantStage : null,
    note: 'when the dominant stage changes, the previous bottleneck is fixed and '
        + 'the next one is now the limit',
  };
}

const TARGETS = {
  firstPaintMs: 2500,
  rootDecodedKB: 2048,
  peakConcurrency: 12,
  medianDecodeMs: 120,
  mainThreadBlockedMs: 500,
};

export function firstRenderGate(report, burst, decode, targets = TARGETS) {
  const breaches = [];
  if (report.firstPaintMs > targets.firstPaintMs) {
    breaches.push({ metric: 'firstPaintMs', value: report.firstPaintMs,
                    limit: targets.firstPaintMs,
                    dominant: report.dominantStage });
  }
  if (burst.peakConcurrency < targets.peakConcurrency) {
    breaches.push({ metric: 'peakConcurrency', value: burst.peakConcurrency,
                    limit: targets.peakConcurrency });
  }
  if (decode.medianDecodeMs && decode.medianDecodeMs > targets.medianDecodeMs) {
    breaches.push({ metric: 'medianDecodeMs', value: decode.medianDecodeMs,
                    limit: targets.medianDecodeMs });
  }
  if (decode.mainThreadBlockedMs > targets.mainThreadBlockedMs) {
    breaches.push({ metric: 'mainThreadBlockedMs',
                    value: decode.mainThreadBlockedMs,
                    limit: targets.mainThreadBlockedMs });
  }
  return { breaches, pass: breaches.length === 0,
           summary: breaches.length
             ? `${breaches.length} breach(es); dominant stage is `
               + `${report.dominantStage}`
             : 'first render within targets' };
}
```

`dominantStageChanged` is the signal that a fix landed. When the root JSON is gzipped and the dominant stage moves from "root fetch + parse" to "first tile decode + upload", the first bottleneck is gone and the next one is now the limit — which is progress, and it is also the point at which the next fix becomes worth doing.

<figure class="diagram">
<svg viewBox="6 17 742 239" role="img" aria-labelledby="first-stages-t first-stages-d" xmlns="http://www.w3.org/2000/svg">
  <title id="first-stages-t">First-paint attribution before and after two fixes</title>
  <desc id="first-stages-d">Two stacked bars for the same tileset. Before, the 2600 millisecond first paint is 180 for the pointer, 1240 for the ungzipped root JSON, 450 for serialised subtree fetches, 210 for the first tile network and 140 for decode, with 380 unattributed. After gzipping the root and inlining the top two tree levels, the first paint is 1090 milliseconds: 180 pointer, 140 root, 60 tree walk, 210 network, 140 decode and 360 unattributed. The dominant stage has moved from the root fetch to the unattributed page startup.</desc>
  <rect class="svg-bg" x="6" y="17" width="742" height="239" fill="#ffffff"/>
  <g stroke-width="1.3">
    <rect x="96" y="52" width="40" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="52" width="276" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="412" y="52" width="100" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="512" y="52" width="47" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="559" y="52" width="31" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="590" y="52" width="85" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="96" y="128" width="40" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="128" width="31" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="167" y="128" width="13" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="180" y="128" width="47" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="227" y="128" width="31" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="258" y="128" width="80" height="34" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="20" y="73">before</text>
    <text x="20" y="149">after</text>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="683" y="73">2,600 ms</text>
    <text x="346" y="149">1,090 ms</text>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="274" y="44">root JSON 1,240 ms — ungzipped</text>
    <text x="462" y="104">subtrees 450</text>
  </g>
  <g font-size="11.5">
    <text x="96" y="192" fill="#15384a">blue: pointer and network</text>
    <text x="272" y="192" fill="#b0413e">red: root JSON</text>
    <text x="392" y="192" fill="#9a4f26">orange: subtree fetches</text>
    <text x="566" y="192" fill="#4f7a4d">green: decode</text>
  </g>
  <text x="96" y="216" fill="#5b6471" font-size="12">grey: unattributed — the page's own startup, unchanged by either fix</text>
  <text x="96" y="238" fill="#1f2937" font-size="12.5">gzip plus inlining removed 1,510 ms; the dominant stage is now page startup</text>
</svg>
<figcaption>Two server-side changes removed 58% of the first paint, and the dominant stage moved to the page's own bundle.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "decodedKB": 4102.4, "encodedKB": 4108.1, "compressed": false,
  "contentEncoding": null, "cacheControl": "public, max-age=31536000, immutable",
  "tilesInRoot": 6147, "contentTilesInRoot": 4812, "externalReferences": 12,
  "maxDepthInRoot": 2, "implicitTiling": false,
  "findings": [
    {"severity": "error", "finding": "root JSON is 4.1 MB decoded",
     "fix": "split into external subtrees, or switch to implicit tiling"},
    {"severity": "error", "finding": "root JSON is not gzipped",
     "fix": "enable compression for application/json — it is an 8–12× saving"},
    {"severity": "warn", "finding": "12 external references at depth 2",
     "fix": "each one is a serialised round trip before any tile can be requested; inline the top two levels"}
  ]
}
{
  "measurable": true, "requests": 412, "protocol": "h2",
  "peakConcurrency": 18, "medianQueuedMs": 6, "p95QueuedMs": 84,
  "medianTtfbMs": 41, "medianDownloadMs": 118,
  "burstSeconds": 3.84, "effectiveMbps": 22.8, "fromCache": 0,
  "findings": []
}
{
  "paired": 384, "medianDecodeMs": 38, "p95DecodeMs": 112,
  "totalDecodeMs": 16104, "longTasks": 6, "longestTaskMs": 84,
  "mainThreadBlockedMs": 108, "findings": []
}
{
  "firstPaintMs": 2604.8, "settledMs": 6441.2,
  "breakdown": [
    {"stage": "root fetch + parse", "ms": 1240.4, "share": 0.476},
    {"stage": "tree walk + subtree fetches", "ms": 450.1, "share": 0.173},
    {"stage": "unattributed", "ms": 382.6, "share": 0.147},
    {"stage": "first tile network", "ms": 210.4, "share": 0.081},
    {"stage": "pointer fetch", "ms": 180.2, "share": 0.069},
    {"stage": "first tile decode + upload", "ms": 141.1, "share": 0.054}
  ],
  "dominantStage": "root fetch + parse",
  "dominantShare": 0.476,
  "errors": 2,
  "advice": "gzip the JSON and split the tree into external subtrees, or switch to implicit tiling"
}
```

The dominant stage is the root JSON at 48% of the first paint, and the transport and decode are both healthy — peak concurrency of 18 on HTTP/2, a 6 ms median queue and a 38 ms median decode. Tuning tile sizes or the request scheduler would have achieved nothing.

The root document is 4.1 MB decoded and 4.1 MB encoded, which is the finding: the server is not compressing `application/json`. Note the `Cache-Control` is correct, so this is purely a compression configuration.

Verify the fix moves the number rather than assuming it:

```javascript
export async function verifyGzip(tilesetUrl) {
  const plain = await fetch(tilesetUrl, {
    cache: 'no-store', headers: { 'Accept-Encoding': 'identity' } });
  const plainText = await plain.text();
  const compressed = await fetch(tilesetUrl, { cache: 'no-store' });
  const encodedLength = Number(compressed.headers.get('Content-Length') ?? 0);
  const compressedText = await compressed.text();

  return {
    decodedBytes: plainText.length,
    transferredBytes: encodedLength || compressedText.length,
    contentEncoding: compressed.headers.get('Content-Encoding'),
    ratio: encodedLength
      ? Number((plainText.length / encodedLength).toFixed(1)) : 1.0,
    identicalContent: plainText.length === compressedText.length,
    working: Boolean(compressed.headers.get('Content-Encoding'))
      && encodedLength < plainText.length * 0.4,
    savedMsAt25Mbps: Number((((plainText.length - (encodedLength
      || plainText.length)) * 8) / 25e6 * 1000).toFixed(0)),
  };
}
```

`identicalContent` guards against the case where compression is enabled and a proxy is serving a different (often truncated) document to clients that accept encoding — which does happen and produces a tileset that parses on one machine and not another.

The `savedMsAt25Mbps` figure converts the byte saving into the number the complaint was about, which is what makes the change easy to justify.

Then verify the measurement on a cold cache, because a warm one hides everything:

```javascript
export async function coldVsWarm(viewer, pointerUrl, view) {
  const rows = [];
  for (const label of ['cold', 'warm']) {
    if (label === 'cold' && 'caches' in window) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
    performance.clearResourceTimings();
    const { tileset, stages } = await measureFirstRender(viewer,
                                                         { pointerUrl, view });
    const burst = burstReport();
    rows.push({
      label,
      firstPaintMs: stages.firstPaintMs,
      settledMs: stages.settledMs,
      requests: burst.requests,
      fromCache: burst.fromCache,
      cacheHitShare: Number((burst.fromCache
        / Math.max(burst.requests, 1)).toFixed(3)),
    });
    viewer.scene.primitives.remove(tileset);
  }
  const [cold, warm] = rows;
  return {
    rows,
    warmSpeedup: Number((cold.firstPaintMs
      / Math.max(warm.firstPaintMs, 1)).toFixed(1)),
    cachingWorking: warm.cacheHitShare > 0.8,
    note: warm.cacheHitShare <= 0.8
      ? 'a warm load still re-requests most tiles — the Cache-Control headers or '
        + 'the URL scheme are not immutable'
      : 'caching is working; quote the cold figure as the user experience',
  };
}
```

The cold figure is what a first-time visitor experiences and is the number to optimise; the warm figure tests that the caching headers work. A warm load with a cache hit share below 0.8 means the immutable-prefix scheme in [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) is not in place, and a repeat visit is paying the full cold cost.

## Performance Notes

- **Gzip the tileset JSON.** It is an 8–12× reduction on the one file that gates every session, and it is a server configuration change.
- **Do not gzip `.glb`, `.ktx2` or `.subtree`** — they are compressed already, and the CPU cost buys nothing.
- **`preloadWhenHidden: false`** stops a hidden viewer from loading tiles, which matters on a page with a tabbed layout.
- **Inline the top two tree levels** so the first tile request does not wait on serialised subtree fetches. Below that, external subtrees are a benefit.
- **`<link rel="preconnect">` to the tile origin** removes the TLS handshake from the critical path, typically 100–200 ms.
- **Implicit tiling removes the root JSON problem entirely** for uniformly dense trees, because availability is a bitstream rather than megabytes of JSON.
- **Measure on a throttled connection.** A first paint that is fine on a LAN and eleven seconds on 4G is the common case, and only the throttled measurement finds it.

## Common Errors

**First paint is slow and every tile request looks fast.** The time is before the first request. Read `rootToFirstRequestMs`.

**Peak concurrency is 6.** HTTP/1.1. Fix the transport before anything else.

**Long tasks and an unresponsive page during loading.** Decode is on the main thread; check `CESIUM_BASE_URL` and any Content Security Policy blocking workers.

**The root JSON is small and the first paint is still slow.** Serialised subtree fetches. Count the external references near the root.

**A repeat visit is as slow as the first.** The caching headers are wrong, or the URLs are not immutable.

**`decodeReport` pairs nothing.** The URL matching between resource timings and tile events failed; compare on the last two path segments rather than the full URL.

**The measurement varies by seconds between runs.** The cache was not cleared, or the CDN edge was cold on one run and warm on the next. Use the cold/warm comparison deliberately.

## Frequently Asked Questions

### What is a reasonable first paint?

Under 2.5 seconds on a typical broadband connection for a city tileset, and under 4 on 4G. Below about 1.5 seconds the page's own startup usually dominates and further tileset work is wasted.

### Should the first view load a coarse level deliberately?

Yes — a root tile with a low-detail representation of the whole area gives something to look at in the first second while detail arrives. That is what a sensible root geometric error achieves, and it is the cheapest perceived-performance win available.

### Does prefetching help the first paint?

No. Prefetching helps the *next* view, as described in [prefetching tiles along a camera path](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/prefetching-tiles-along-a-camera-path/); the first paint has nothing to prefetch from.

## Related Guides

- [HTTP/2 and Connection Limits for Tile Streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/) — the transport stage in detail
- [Debugging with the Cesium 3D Tiles Inspector](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/debugging-with-the-cesium-3d-tiles-inspector/) — the loading counters read live
- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — splitting a large root into external subtrees

Back to [Streaming and Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
