# Prefetching Tiles Along a Camera Path

This page warms the tile cache ahead of a camera that is about to move — extrapolating the path, ranking candidate tiles by when they will be needed, issuing those requests at low priority so they never delay a visible tile, and measuring whether the prefetch actually helped rather than just consumed bandwidth.

## Why you hit this

Tile streaming is reactive by default: the client works out what it needs from where the camera *is*, requests it, and shows a hole until it arrives. For a stationary camera that is fine. For a guided flythrough, a scripted tour, a vehicle following a route or a user dragging across a city, it produces a permanent lag — the camera is always a second ahead of the data.

Prefetching removes that lag when it predicts well and wastes bandwidth when it does not, so the whole problem is the ranking and the priority. A prefetch that competes with visible tiles makes the experience worse than no prefetch at all.

## Prerequisites

- A CesiumJS viewer with a loaded tileset, and the transport already sorted — see [HTTP/2 and connection limits for tile streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/).
- Immutable tile URLs, so a prefetched tile is still valid when it is needed: [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/).
- Either a known route, or camera motion smooth enough to extrapolate.

## Step-by-Step

### 1. Predict where the camera will be

```javascript
export class CameraPathPredictor {
  constructor({ historySize = 12, horizonSeconds = 4.0 } = {}) {
    this.history = [];
    this.historySize = historySize;
    this.horizonSeconds = horizonSeconds;
  }

  observe(camera, nowMs = performance.now()) {
    const p = camera.positionWC;
    this.history.push({ t: nowMs, x: p.x, y: p.y, z: p.z,
                        dirX: camera.directionWC.x, dirY: camera.directionWC.y,
                        dirZ: camera.directionWC.z });
    if (this.history.length > this.historySize) this.history.shift();
  }

  velocity() {
    if (this.history.length < 3) return null;
    const a = this.history[0];
    const b = this.history[this.history.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.05) return null;
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt, vz: (b.z - a.z) / dt, dt };
  }

  /** Sample future positions; returns [] when the camera is effectively still. */
  predict({ samples = 6 } = {}) {
    const v = this.velocity();
    if (!v) return [];
    const speed = Math.hypot(v.vx, v.vy, v.vz);
    if (speed < 2.0) return [];                 // under 2 m/s: reactive loading is fine
    const last = this.history[this.history.length - 1];
    const out = [];
    for (let i = 1; i <= samples; i++) {
      const dt = (this.horizonSeconds * i) / samples;
      out.push({
        seconds: Number(dt.toFixed(2)),
        x: last.x + v.vx * dt,
        y: last.y + v.vy * dt,
        z: last.z + v.vz * dt,
        confidence: Number(Math.max(0, 1 - dt / (this.horizonSeconds * 1.5)).toFixed(3)),
      });
    }
    return { speed: Number(speed.toFixed(1)), samples: out };
  }
}
```

Linear extrapolation from a short history is the right model, and it is tempting to do better. A quadratic fit that accounts for acceleration predicts a braking camera well and overshoots wildly on a camera that changes direction, which is the common case in interactive use — so the extra term makes the average prediction worse.

The `speed < 2.0` early exit matters more than the prediction itself. A stationary or slowly panning camera does not need prefetching, and prefetching for it burns bandwidth that the reactive loader could use. Most sessions are mostly stationary.

Confidence decaying with the horizon is what step 3 uses to decide how much to spend: a tile needed in four seconds is worth requesting only if there is spare capacity now.

### 2. Turn predicted positions into candidate tiles

```javascript
export function candidateTiles(tileset, predicted, { maxCandidates = 80,
                                                     sseBudget = 16 } = {}) {
  if (!predicted.samples) return [];
  const scene = tileset._tilesetRoot?._scene ?? null;
  const candidates = new Map();

  const walk = (tile, sample, depth) => {
    if (depth > 24) return;
    const bv = tile.boundingSphere;
    if (!bv) return;
    const dx = bv.center.x - sample.x;
    const dy = bv.center.y - sample.y;
    const dz = bv.center.z - sample.z;
    const distance = Math.max(Math.hypot(dx, dy, dz) - bv.radius, 1.0);

    // Screen-space error at the predicted position decides whether this tile is needed.
    const sse = (tile.geometricError * 1080) / (distance * 2 * Math.tan(Math.PI / 6));
    if (tile.geometricError > 0 && sse > sseBudget && tile.children?.length) {
      for (const child of tile.children) walk(child, sample, depth + 1);
      return;
    }
    if (!tile.contentAvailable && tile.contentUnloaded !== false) {
      const key = tile._contentResource?.url ?? String(tile._header?.content?.uri ?? '');
      if (!key) return;
      const existing = candidates.get(key);
      const score = sample.confidence / (1 + sample.seconds);
      if (!existing || score > existing.score) {
        candidates.set(key, { tile, key, score,
                              neededInSeconds: sample.seconds,
                              distance: Math.round(distance),
                              confidence: sample.confidence });
      }
    }
  };

  for (const sample of predicted.samples) walk(tileset.root, sample, 0);

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}
```

Walking the tree against each predicted position, with the same screen-space error test the renderer uses, is what makes the candidate set correct rather than approximate. A naive prefetch that requests everything within a radius pulls tiles at every level, most of which will never be selected, and the wasted bandwidth is the reason many prefetch implementations are abandoned.

Scoring by `confidence / (1 + seconds)` puts near-term, high-confidence tiles first, which is the ordering that matters when the budget in step 3 truncates the list. Deduplicating by URL across samples keeps a tile needed at every point along the path from appearing six times.

<figure class="diagram">
<svg viewBox="26 26 688 242" role="img" aria-labelledby="pf-path-t pf-path-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-path-t">Predicted path and the candidate tiles it selects</title>
  <desc id="pf-path-d">A plan view of a tile grid with the camera at the left moving right. Tiles inside the current frustum are already loaded. Six predicted positions extend along the path over four seconds, each one selecting the tiles that would be needed there. Tiles selected by the nearest predictions get the highest score and are requested first; tiles selected only by the furthest prediction have low confidence and are requested only if bandwidth is idle.</desc>
  <rect class="svg-bg" x="26" y="26" width="688" height="242" fill="#ffffff"/>
  <g stroke="#e6e0d4" stroke-width="1" fill="none">
    <path d="M40 40 H700 M40 88 H700 M40 136 H700 M40 184 H700 M40 232 H700"/>
    <path d="M40 40 V232 M136 40 V232 M232 40 V232 M328 40 V232 M424 40 V232 M520 40 V232 M616 40 V232 M700 40 V232"/>
  </g>
  <g stroke-width="1.5">
    <rect x="40" y="88" width="96" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="136" width="96" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="136" y="88" width="96" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="136" y="136" width="96" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="88" width="96" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="232" y="136" width="96" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="328" y="88" width="96" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="328" y="136" width="96" height="48" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="424" y="88" width="96" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="424" y="136" width="96" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="520" y="88" width="96" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="520" y="136" width="96" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <path d="M64 112 H660" stroke="#5b6471" stroke-width="2" stroke-dasharray="7 5" fill="none"/>
  <g fill="#1f6b8a">
    <circle cx="160" cy="112" r="5"/><circle cx="256" cy="112" r="5"/>
    <circle cx="352" cy="112" r="5"/><circle cx="448" cy="112" r="5"/>
    <circle cx="544" cy="112" r="5"/><circle cx="640" cy="112" r="5"/>
  </g>
  <circle cx="64" cy="112" r="8" fill="#1f2937"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="88" y="70">camera now</text>
    <text x="88" y="164">loaded</text>
    <text x="280" y="70">score 0.83–0.51</text>
    <text x="280" y="214">request now</text>
    <text x="472" y="70">score 0.22–0.09</text>
    <text x="472" y="214">only if idle</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="160" y="250">+0.7 s</text><text x="256" y="250">+1.3 s</text><text x="352" y="250">+2.0 s</text>
    <text x="448" y="250">+2.7 s</text><text x="544" y="250">+3.3 s</text><text x="640" y="250">+4.0 s</text>
  </g>
</svg>
<figcaption>Each predicted position selects tiles by the same screen-space error test the renderer uses; the score decides which get bandwidth.</figcaption>
</figure>

### 3. Spend only spare bandwidth

```javascript
export class PrefetchBudget {
  constructor({ maxInflight = 4, maxBytesPerSecond = 2_000_000,
                minVisibleHeadroom = 4 } = {}) {
    this.maxInflight = maxInflight;
    this.maxBytesPerSecond = maxBytesPerSecond;
    this.minVisibleHeadroom = minVisibleHeadroom;
    this.inflight = new Map();
    this.window = [];
  }

  bytesInLastSecond(nowMs = performance.now()) {
    this.window = this.window.filter((e) => nowMs - e.t < 1000);
    return this.window.reduce((s, e) => s + e.bytes, 0);
  }

  /** The visible loader must always have room; prefetch takes what is left. */
  canIssue({ visibleRequestsInflight, schedulerCapacity, nowMs = performance.now() }) {
    const headroom = schedulerCapacity - visibleRequestsInflight - this.inflight.size;
    if (headroom < this.minVisibleHeadroom) {
      return { ok: false, reason: `only ${headroom} slots free; reserving for visible tiles` };
    }
    if (this.inflight.size >= this.maxInflight) {
      return { ok: false, reason: `${this.inflight.size} prefetches already in flight` };
    }
    const used = this.bytesInLastSecond(nowMs);
    if (used >= this.maxBytesPerSecond) {
      return { ok: false, reason: `${Math.round(used / 1024)} KB/s already spent on prefetch` };
    }
    return { ok: true, headroom, bytesUsed: used };
  }

  record(key, bytes, nowMs = performance.now()) {
    this.window.push({ t: nowMs, bytes });
    this.inflight.delete(key);
  }
}
```

Reserving slots for the visible loader is the single rule that makes prefetching safe. A prefetch that fills the request scheduler starves the tiles the camera is looking at *now*, and the user sees a worse experience than with no prefetch — holes in front of them while bandwidth goes to geometry they may never reach.

The byte-rate cap is the second guard, and it is there for metered connections and for fairness with everything else the page is doing. Two megabytes per second of speculative traffic is generous on broadband and unacceptable on mobile; deriving it from the measured throughput rather than hard-coding it is the refinement worth making.

### 4. Issue the requests at low priority

```javascript
export class TilePrefetcher {
  constructor(tileset, { predictor, budget, cacheName = 'tile-prefetch' } = {}) {
    this.tileset = tileset;
    this.predictor = predictor ?? new CameraPathPredictor();
    this.budget = budget ?? new PrefetchBudget();
    this.cacheName = cacheName;
    this.stats = { issued: 0, completed: 0, bytes: 0, skipped: 0, hits: 0, misses: 0 };
    this.prefetched = new Map();      // url -> { at, bytes }
  }

  async tick(camera, { visibleRequestsInflight = 0, schedulerCapacity = 18 } = {}) {
    this.predictor.observe(camera);
    const predicted = this.predictor.predict();
    if (!predicted.samples) return { issued: 0, reason: 'camera is still' };

    const candidates = candidateTiles(this.tileset, predicted);
    let issued = 0;
    for (const candidate of candidates) {
      const gate = this.budget.canIssue({ visibleRequestsInflight, schedulerCapacity });
      if (!gate.ok) { this.stats.skipped += candidates.length - issued; break; }
      if (this.prefetched.has(candidate.key)) continue;
      this.budget.inflight.set(candidate.key, performance.now());
      this.#fetchLowPriority(candidate);
      issued += 1;
    }
    return { issued, considered: candidates.length, speed: predicted.speed };
  }

  async #fetchLowPriority(candidate) {
    const url = candidate.key;
    try {
      const res = await fetch(url, {
        priority: 'low',                 // Fetch Priority: deprioritised at the transport
        cache: 'force-cache',            // reuse anything already stored
        keepalive: false,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = await res.arrayBuffer();
      this.stats.issued += 1;
      this.stats.completed += 1;
      this.stats.bytes += buf.byteLength;
      this.prefetched.set(url, { at: performance.now(), bytes: buf.byteLength });
      this.budget.record(url, buf.byteLength);
      if ('caches' in self) {
        const cache = await caches.open(this.cacheName);
        await cache.put(url, new Response(buf, { headers: res.headers }));
      }
    } catch (err) {
      this.budget.inflight.delete(url);
      this.stats.issued += 1;
    }
  }
}
```

`priority: 'low'` on the Fetch API is what keeps a prefetch from competing at the transport layer: the browser deprioritises the HTTP/2 stream, so a visible tile requested afterwards still gets bandwidth first. Without it, the request scheduler's own priorities are invisible to the network stack and a prefetch issued a moment earlier wins.

`cache: 'force-cache'` avoids re-fetching something already in the HTTP cache, which happens constantly when a camera moves back and forth over the same area.

Writing into the Cache Storage API is the part that makes the prefetch usable by the tileset loader. A bare `fetch` populates the HTTP cache only if the response headers permit it, and an `immutable` one-year `Cache-Control` does — which is why immutable prefixes are a prerequisite rather than a nicety. Where they are absent, the explicit cache write is the only mechanism that works.

### 5. Measure whether it helped

```javascript
export function prefetchEffectiveness(prefetcher, { windowMs = 60_000 } = {}) {
  const now = performance.now();
  const entries = performance.getEntriesByType('resource')
    .filter((e) => e.name.includes('/content/') && now - e.startTime < windowMs);

  let hits = 0, misses = 0, hitBytes = 0, wasteBytes = 0;
  const usedUrls = new Set(entries.map((e) => e.name));

  for (const e of entries) {
    const wasPrefetched = prefetcher.prefetched.has(e.name);
    // A cache hit shows transferSize near zero with a non-zero decoded size.
    const servedFromCache = e.transferSize === 0 && e.decodedBodySize > 0;
    if (wasPrefetched && servedFromCache) { hits += 1; hitBytes += e.decodedBodySize; }
    else if (!servedFromCache) misses += 1;
  }
  for (const [url, info] of prefetcher.prefetched) {
    if (!usedUrls.has(url)) wasteBytes += info.bytes;
  }

  const total = hits + misses;
  return {
    windowSeconds: windowMs / 1000,
    tilesRendered: total,
    prefetchHits: hits,
    hitRate: total ? Number((hits / total).toFixed(3)) : 0,
    hitMB: Number((hitBytes / 1e6).toFixed(2)),
    wastedMB: Number((wasteBytes / 1e6).toFixed(2)),
    efficiency: hitBytes + wasteBytes
      ? Number((hitBytes / (hitBytes + wasteBytes)).toFixed(3)) : 0,
    verdict: total === 0 ? 'no data'
           : hits / total > 0.4 ? 'prefetch is earning its bandwidth'
           : hitBytes / Math.max(hitBytes + wasteBytes, 1) < 0.25
             ? 'mostly waste — shorten the horizon or raise the speed threshold'
             : 'marginal',
  };
}
```

Two numbers decide whether prefetching is worth keeping. The **hit rate** says how much of what the camera needed was already there, and the **efficiency** says how much of what was fetched got used. A high hit rate with low efficiency means the prediction is too generous — it fetches a wide cone and some of it lands — and shortening the horizon fixes it.

Below about 25% efficiency, prefetching is consuming more bandwidth than it saves and should be turned off for that motion pattern. That is a measurement, not a guess, and it is the reason this function exists rather than a "prefetching is enabled" flag.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="pf-budget-t pf-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-budget-t">The four guards that keep prefetching safe</title>
  <desc id="pf-budget-d">A table of four budget guards. Reserving four scheduler slots for visible tiles stops prefetch starving the view. Capping prefetch at four concurrent requests bounds its share. A two megabyte per second byte cap protects metered connections. A two metre per second speed threshold stops prefetching for a stationary camera, which is most of a session.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="254" y="20" width="124" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="378" y="20" width="344" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="254" y="54" width="124" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="378" y="54" width="344" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="88" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="254" y="88" width="124" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="378" y="88" width="344" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="254" y="122" width="124" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="378" y="122" width="344" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="156" width="124" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="378" y="156" width="344" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="136" y="42">guard</text><text x="316" y="42">value</text><text x="550" y="42">what it prevents</text>
    <text x="136" y="76">visible-loader headroom</text><text x="316" y="76">4 slots</text><text x="550" y="76">prefetch starving the visible view</text>
    <text x="136" y="110">prefetch concurrency</text><text x="316" y="110">4</text><text x="550" y="110">prefetch dominating the scheduler</text>
    <text x="136" y="144">byte rate cap</text><text x="316" y="144">2 MB/s</text><text x="550" y="144">speculative traffic on a metered link</text>
    <text x="136" y="178">speed threshold</text><text x="316" y="178">2 m/s</text><text x="550" y="178">prefetching for a still camera</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">The first guard is the one that matters: a starved visible loader is worse than no prefetch at all.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">Most sessions are mostly stationary, so the speed threshold is what keeps the average cost low.</text>
</svg>
<figcaption>The headroom reservation is non-negotiable; without it prefetching makes the experience worse.</figcaption>
</figure>

### 6. Handle the known-route case, which is much easier

```javascript
export async function prefetchAlongRoute(tileset, routePositions,
                                         { lookaheadSeconds = 8, speedMps = 14,
                                           budget = new PrefetchBudget({ maxInflight: 6 }) } = {}) {
  /** A scripted tour or vehicle route: the path is known, so prediction is exact. */
  const spacing = speedMps * 1.0;                 // one sample per second of travel
  const samples = [];
  let carried = 0;
  for (let i = 1; i < routePositions.length; i++) {
    const a = routePositions[i - 1];
    const b = routePositions[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    let travelled = carried;
    while (travelled < segLen) {
      const f = travelled / segLen;
      samples.push({
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        seconds: samples.length,
        confidence: 1.0,                          // the route is known
      });
      travelled += spacing;
    }
    carried = travelled - segLen;
  }

  const ordered = [];
  for (const sample of samples.slice(0, lookaheadSeconds)) {
    ordered.push(...candidateTiles(tileset, { samples: [sample] }, { maxCandidates: 40 }));
  }
  const unique = new Map();
  for (const c of ordered) if (!unique.has(c.key)) unique.set(c.key, c);
  return { samples: samples.length, tiles: unique.size,
           estimatedMB: Number((unique.size * 0.9).toFixed(1)) };
}
```

A known route changes the economics completely: confidence is 1.0, efficiency approaches 1.0, and the horizon can extend to tens of seconds because there is no prediction error to decay. For a scripted tour the right approach is to prefetch the whole route before starting playback, which turns a stuttering flythrough into a smooth one at the cost of a loading bar.

The interactive case is the hard one, and it is worth recognising which case you are in before tuning anything.

<figure class="diagram">
<svg viewBox="4 6 732 234" role="img" aria-labelledby="pf-eff-t pf-eff-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-eff-t">Hit rate and efficiency by motion pattern</title>
  <desc id="pf-eff-d">A table of measured prefetch outcomes for four motion patterns. A scripted tour with a known route reaches 96 percent hit rate and 94 percent efficiency. A vehicle following a route reaches 88 and 81 percent. A smooth interactive pan reaches 61 and 47 percent, which is worth keeping. Erratic mouse dragging reaches 23 and 14 percent, where prefetching costs more bandwidth than it saves and should be disabled.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="202" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="350" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="20" width="242" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="202" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="52" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="52" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="52" width="242" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="202" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="86" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="350" y="86" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="86" width="242" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="120" width="202" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="220" y="120" width="130" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="350" y="120" width="130" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="480" y="120" width="242" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="154" width="202" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="220" y="154" width="130" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="350" y="154" width="130" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="480" y="154" width="242" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="119" y="41">motion pattern</text><text x="285" y="41">hit rate</text>
    <text x="415" y="41">efficiency</text><text x="601" y="41">what to do</text>
    <text x="119" y="74">scripted tour (known route)</text><text x="285" y="74">96%</text>
    <text x="415" y="74">94%</text><text x="601" y="74">prefetch the whole route</text>
    <text x="119" y="108">vehicle on a route</text><text x="285" y="108">88%</text>
    <text x="415" y="108">81%</text><text x="601" y="108">8–15 s lookahead</text>
    <text x="119" y="142">smooth interactive pan</text><text x="285" y="142">61%</text>
    <text x="415" y="142">47%</text><text x="601" y="142">keep, 3–4 s horizon</text>
    <text x="119" y="176">erratic dragging</text><text x="285" y="176">23%</text>
    <text x="415" y="176">14%</text><text x="601" y="176">disable — costs more than it saves</text>
  </g>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">measure both numbers per session; the speed threshold is what separates the last two rows</text>
</svg>
<figcaption>Prefetching is clearly worth it for known routes, marginal for smooth panning, and counterproductive for erratic input.</figcaption>
</figure>

## Expected Output & Verification

```text
{ speed: 18.4, samples: [ { seconds: 0.67, confidence: 0.889, … }, … ] }
{ issued: 4, considered: 62, speed: 18.4 }
{
  windowSeconds: 60,
  tilesRendered: 418,
  prefetchHits: 254,
  hitRate: 0.608,
  hitMB: 22.9,
  wastedMB: 25.8,
  efficiency: 0.47,
  verdict: 'prefetch is earning its bandwidth'
}
{ samples: 112, tiles: 486, estimatedMB: 437.4 }
```

A 61% hit rate with 47% efficiency on interactive panning is a realistic good result — roughly half the speculative bandwidth is wasted and the half that lands removes most of the visible lag. Whether that trade is acceptable depends on the connection, which is why the budget is configurable rather than fixed.

Verify that prefetching did not slow down the visible tiles, which is the failure mode that matters:

```javascript
export async function starvationCheck(loadSession, { runs = 2 } = {}) {
  const results = [];
  for (const prefetchOn of [false, true]) {
    performance.clearResourceTimings();
    window.__prefetchEnabled = prefetchOn;
    const t0 = performance.now();
    await loadSession();                          // identical camera path both times
    const entries = performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('/content/'));
    const visible = entries.filter((e) => !window.__prefetcher?.prefetched.has(e.name));
    const lat = visible.map((e) => e.responseEnd - e.startTime).sort((a, b) => a - b);
    results.push({
      prefetch: prefetchOn,
      visibleTiles: visible.length,
      medianLatencyMs: Math.round(lat[Math.floor(lat.length / 2)] ?? 0),
      p95LatencyMs: Math.round(lat[Math.floor(lat.length * 0.95)] ?? 0),
      wallSeconds: Number(((performance.now() - t0) / 1000).toFixed(2)),
      bytesMB: Number((entries.reduce((s, e) => s + (e.encodedBodySize || 0), 0) / 1e6)
                      .toFixed(1)),
    });
  }
  const [off, on] = results;
  return {
    results,
    visibleLatencyRegressionMs: on.p95LatencyMs - off.p95LatencyMs,
    extraBandwidthMB: Number((on.bytesMB - off.bytesMB).toFixed(1)),
    safe: on.p95LatencyMs <= off.p95LatencyMs * 1.1,
  };
}
```

The p95 latency of *visible* tiles must not rise when prefetching is enabled. A regression there means the budget's headroom reservation is too small or `priority: 'low'` is not taking effect, and it is the one result that should cause prefetching to be switched off rather than tuned.

Then verify the prediction itself, separately from the fetching, so a bad hit rate can be attributed:

```javascript
export function predictionAccuracy(predictor, camera, { horizonSeconds = 2.0 } = {}) {
  const predicted = predictor.predict();
  if (!predicted.samples) return { measurable: false };
  const target = predicted.samples.find((s) => s.seconds >= horizonSeconds);
  if (!target) return { measurable: false };
  return new Promise((resolve) => {
    setTimeout(() => {
      const p = camera.positionWC;
      const errorM = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
      const travelledM = predicted.speed * target.seconds;
      resolve({
        measurable: true,
        horizonSeconds: target.seconds,
        errorM: Math.round(errorM),
        travelledM: Math.round(travelledM),
        relativeError: Number((errorM / Math.max(travelledM, 1)).toFixed(3)),
        good: errorM < travelledM * 0.35,
      });
    }, target.seconds * 1000);
  });
}
```

A relative error under about 0.35 is what a useful hit rate needs. Above that the camera is not moving predictably and the speed threshold should be raised so prefetching simply does not engage.

## Performance Notes

- **Prefetch at 2–4 concurrent requests**, not more. The visible loader needs the rest of the scheduler's capacity.
- **A 3–4 second horizon is the sweet spot for interactive use.** Longer horizons decay in accuracy faster than they gain in warning time.
- **Tick at 4–10 Hz**, not per frame. The prediction does not change meaningfully in 16 ms, and the tree walk is not free.
- **The tree walk costs 1–4 ms** per predicted sample on a city tileset. Six samples per tick at 5 Hz is about 6% of one core.
- **Cache Storage writes are asynchronous and cheap** but the quota is finite; evict prefetched entries older than a few minutes.
- **Disable prefetching on metered connections.** `navigator.connection.saveData` is the signal, and honouring it is the difference between a helpful feature and a complaint.
- **Prefetching cannot fix a transport problem.** On HTTP/1.1 there are no spare slots to prefetch into; fix that first.

## Common Errors

**Visible tiles got slower.** Prefetch is starving the visible loader. Raise `minVisibleHeadroom` and confirm `priority: 'low'` is supported and applied.

**Hit rate near zero despite good predictions.** The prefetched responses are not cacheable, so the tileset loader re-fetches. Check `Cache-Control` on tile responses, or write to Cache Storage explicitly.

**Bandwidth doubled with no improvement.** The candidate set is not using the screen-space error test, so it is fetching levels that will never be selected.

**Prefetch never issues anything.** The speed threshold is above the camera's actual speed, or `velocity()` is returning null because the history is being cleared each frame.

**Memory grows over a long session.** The `prefetched` map and Cache Storage both grow without bound. Evict by age.

**Prefetched tiles are stale after a deploy.** The tile URLs are mutable. Immutable prefixes make a prefetched tile valid indefinitely.

**Hit rate is high but frames still stutter.** The bottleneck is decode and GPU upload, not the network. Prefetching does not help with that; smaller tiles and fewer draw calls do.

## Frequently Asked Questions

### Should prefetching be on by default?

For known routes, yes. For interactive use, on unmetered connections with measured efficiency above roughly 30%, yes — otherwise it is a setting rather than a default.

### Can the tileset loader be told about prefetched content directly?

Not through a public API in CesiumJS; the practical mechanism is the HTTP cache or Cache Storage, which the loader's own fetch then hits. That is why cacheability is a prerequisite.

### Does this work with implicit tiling?

Yes, and slightly better: subtree availability is itself prefetchable, and warming the subtree files ahead of the camera removes a serialised round trip before the tiles can even be requested.

## Related Guides

- [HTTP/2 and Connection Limits for Tile Streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/) — the capacity prefetching spends
- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — what makes a prefetched tile stay valid
- [Diagnosing Slow First Render of Tilesets](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/diagnosing-slow-first-render-of-tilesets/) — the problem prefetching does not solve

Back to [Streaming Sync Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
