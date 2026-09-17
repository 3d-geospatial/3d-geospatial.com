# Streaming Live Sensor Updates onto Tilesets

This page drives the live layer of a digital twin — 14,000 building sensors reporting temperature, occupancy and alarm state — onto a static tileset without re-tiling anything: a WebSocket delta feed, a join on feature identifiers, style updates that run on the GPU, backpressure that keeps a burst from freezing the browser, and a staleness indicator that shows when the data stopped rather than pretending it did not.

## Why you hit this

A digital twin's geometry changes monthly and its sensor data changes every few seconds. Re-tiling for a temperature reading is absurd, so the two have to be joined at runtime: the tileset supplies the shapes and the identifiers, the live feed supplies the values, and the client colours the shapes by the values.

The failure modes are all in the joining and the pacing. A feed that sends 14,000 full states every second will saturate the main thread; a join that scans features linearly will cost milliseconds per update; and a viewer that keeps showing the last known colour after the feed dies is worse than one that shows grey, because it looks live and is not.

## Prerequisites

- A tileset whose features carry stable identifiers — see [merging meshes to cut draw calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) for how those ids survive tiling.
- A CesiumJS viewer, and a WebSocket or SSE endpoint carrying sensor updates.
- Ideally 3D Tiles metadata property tables, from [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/).

## Step-by-Step

### 1. Design the feed as deltas with a resync path

```javascript
/**
 * Message shapes:
 *   { type: 'snapshot', seq: 91201, at: 1758067200000,
 *     values: { '4412': { temp: 21.4, occ: 0.62, alarm: 0 }, ... } }
 *   { type: 'delta',    seq: 91202, at: 1758067203000,
 *     changed: { '4412': { temp: 21.6 } }, removed: ['9981'] }
 *   { type: 'heartbeat', seq: 91202, at: 1758067205000 }
 */

export class SensorState {
  constructor({ staleAfterMs = 15_000 } = {}) {
    this.values = new Map();          // featureId -> { temp, occ, alarm, at }
    this.seq = null;
    this.lastMessageAt = 0;
    this.staleAfterMs = staleAfterMs;
    this.gaps = 0;
    this.dirty = new Set();
  }

  applySnapshot(msg) {
    this.values.clear();
    for (const [id, v] of Object.entries(msg.values)) {
      this.values.set(id, { ...v, at: msg.at });
      this.dirty.add(id);
    }
    this.seq = msg.seq;
    this.lastMessageAt = performance.now();
    return { applied: 'snapshot', features: this.values.size };
  }

  applyDelta(msg) {
    if (this.seq !== null && msg.seq !== this.seq + 1) {
      this.gaps += 1;
      return { applied: false, reason: `sequence gap ${this.seq} → ${msg.seq}`,
               needsResync: true };
    }
    let changed = 0;
    for (const [id, patch] of Object.entries(msg.changed ?? {})) {
      const prev = this.values.get(id) ?? {};
      this.values.set(id, { ...prev, ...patch, at: msg.at });
      this.dirty.add(id);
      changed += 1;
    }
    for (const id of msg.removed ?? []) {
      this.values.delete(id);
      this.dirty.add(id);
    }
    this.seq = msg.seq;
    this.lastMessageAt = performance.now();
    return { applied: 'delta', changed, removed: (msg.removed ?? []).length };
  }

  isStale(nowMs = performance.now()) {
    return this.lastMessageAt === 0 || nowMs - this.lastMessageAt > this.staleAfterMs;
  }

  ageSeconds(nowMs = performance.now()) {
    return this.lastMessageAt === 0 ? null
      : Number(((nowMs - this.lastMessageAt) / 1000).toFixed(1));
  }
}
```

Sequence numbers with an explicit resync are what make a delta feed trustworthy. Without them, a dropped message leaves the client's state permanently wrong with no way to detect it — and the reconnection after a network blip is exactly when messages get dropped.

The heartbeat exists so that "no change" and "no connection" are distinguishable. A feed that only sends deltas is silent when nothing changes and silent when it is broken, and step 6 depends on telling those apart.

Deltas plus a periodic snapshot is the right shape for 14,000 sensors: the snapshot is perhaps 700 KB and arrives once on connect or after a gap, while the deltas are a few hundred bytes every few seconds.

### 2. Join the feed to the tileset's features

```javascript
export class FeatureIndex {
  constructor() {
    this.byId = new Map();            // externalId -> [{ tile, batchId }]
    this.built = false;
  }

  /** Build once per tileset, from the property table's id column. */
  build(tileset, idProperty = 'sensorId') {
    tileset.tileLoad.addEventListener((tile) => this.#indexTile(tile, idProperty));
    tileset.tileUnload.addEventListener((tile) => this.#deindexTile(tile));
    this.built = true;
    return this;
  }

  #indexTile(tile, idProperty) {
    const content = tile.content;
    if (!content || typeof content.featuresLength !== 'number') return;
    for (let i = 0; i < content.featuresLength; i++) {
      const feature = content.getFeature(i);
      const externalId = feature.getProperty(idProperty);
      if (externalId === undefined || externalId === null) continue;
      const key = String(externalId);
      const list = this.byId.get(key) ?? [];
      list.push({ tile, batchId: i });
      this.byId.set(key, list);
    }
  }

  #deindexTile(tile) {
    for (const [key, list] of this.byId) {
      const kept = list.filter((ref) => ref.tile !== tile);
      if (kept.length) this.byId.set(key, kept);
      else this.byId.delete(key);
    }
  }

  lookup(externalId) {
    return this.byId.get(String(externalId)) ?? [];
  }

  coverage(sensorIds) {
    const missing = [...sensorIds].filter((id) => !this.byId.has(String(id)));
    return { sensors: sensorIds.size ?? sensorIds.length,
             matched: (sensorIds.size ?? sensorIds.length) - missing.length,
             missing: missing.slice(0, 5), missingCount: missing.length };
  }
}
```

The index has to be maintained on tile load and unload, not built once, because a streaming tileset does not have all its features in memory at any moment. A feature the feed has a value for may not be loaded yet, and one that was loaded may be unloaded when the camera moves — so the join is inherently partial and the code has to treat a miss as normal.

Indexing on `tileLoad` also means a tile arriving later automatically picks up whatever state the feed has already delivered, provided the style is re-evaluated, which step 3 handles.

<figure class="diagram">
<svg viewBox="4 14 732 246" role="img" aria-labelledby="live-join-t live-join-d" xmlns="http://www.w3.org/2000/svg">
  <title id="live-join-t">Joining a live feed to a static tileset</title>
  <desc id="live-join-d">A static tileset supplies geometry and a property table containing a sensor identifier per feature. A WebSocket feed supplies values keyed by the same identifier. A feature index built on tile load maps each identifier to the tiles and batch ids holding it. A style expression reads the joined values and is re-evaluated when values change, so nothing is re-tiled and no geometry is re-uploaded.</desc>
  <rect class="svg-bg" x="4" y="14" width="732" height="246" fill="#ffffff"/>
  <defs>
    <marker id="live-join-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="18" y="28" width="178" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="18" y="152" width="178" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="268" y="90" width="176" height="70" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <rect x="516" y="90" width="206" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#live-join-arrow)">
    <path d="M196 70 L266 106"/>
    <path d="M196 182 L266 146"/>
    <path d="M444 125 H514"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="107" y="52">tileset (static)</text><text x="107" y="70">geometry + property</text><text x="107" y="88">table: sensorId</text>
    <text x="107" y="176">WebSocket feed</text><text x="107" y="194">deltas keyed by</text><text x="107" y="212">the same sensorId</text>
    <text x="356" y="114">feature index</text><text x="356" y="132">id → [tile, batchId]</text><text x="356" y="150">rebuilt on tile load</text>
    <text x="619" y="114">style expression reads</text><text x="619" y="132">the joined value; colour</text><text x="619" y="150">changes on the GPU</text>
  </g>
  <text x="370" y="242" fill="#5b6471" font-size="12" text-anchor="middle">no re-tiling, no geometry re-upload — only a style re-evaluation per batch of changes</text>
</svg>
<figcaption>The identifier is the whole contract between the monthly geometry pipeline and the three-second sensor feed.</figcaption>
</figure>

### 3. Push values into the style, not into per-feature colour calls

```javascript
export class LiveStyle {
  constructor(tileset, { property = 'sensorId' } = {}) {
    this.tileset = tileset;
    this.property = property;
    this.lut = new Map();             // sensorId -> numeric value for the style
  }

  /** One style, re-created when the value set changes. Cesium evaluates it on the GPU. */
  apply(state, { field = 'temp', domain = [16, 30] } = {}) {
    const [lo, hi] = domain;
    const conditions = [];
    // Bucket into 8 bands rather than 14,000 conditions.
    const bands = 8;
    for (let b = 0; b < bands; b++) {
      const from = lo + ((hi - lo) * b) / bands;
      const to = lo + ((hi - lo) * (b + 1)) / bands;
      const t = b / (bands - 1);
      const colour = `color('rgb(${Math.round(40 + 200 * t)}, `
                   + `${Math.round(110 - 60 * t)}, ${Math.round(190 - 150 * t)})')`;
      conditions.push([`\${liveValue} >= ${from.toFixed(2)} && `
                       + `\${liveValue} < ${to.toFixed(2)}`, colour]);
    }
    conditions.push(['${liveValue} === undefined', "color('#9aa3ad')"]);   // no data
    conditions.push(['true', "color('#9aa3ad')"]);

    this.tileset.style = new Cesium.Cesium3DTileStyle({
      color: { conditions },
      show: 'true',
    });
    return { bands, conditions: conditions.length, field, domain };
  }

  /** Write the joined value onto each feature so the style expression can read it. */
  pushValues(index, state, { field = 'temp', onlyDirty = true } = {}) {
    const ids = onlyDirty ? state.dirty : state.values.keys();
    let written = 0, unmatched = 0;
    for (const id of ids) {
      const refs = index.lookup(id);
      if (!refs.length) { unmatched += 1; continue; }
      const v = state.values.get(id);
      const value = v ? v[field] : undefined;
      for (const { tile, batchId } of refs) {
        const feature = tile.content?.getFeature(batchId);
        if (!feature) continue;
        feature.setProperty('liveValue', value);
        written += 1;
      }
    }
    if (onlyDirty) state.dirty.clear();
    return { written, unmatched };
  }
}
```

Writing a per-feature property and letting one style expression read it is the approach that scales. The alternative — setting `feature.color` directly per feature — works and costs a JavaScript call plus a batch-table write per feature per update, which at 14,000 features is tens of milliseconds of main-thread time every few seconds.

Bucketing into eight colour bands rather than generating a condition per sensor keeps the style expression small. A style with 14,000 conditions is compiled to a shader that will either fail to compile or run appallingly; eight conditions compile to a handful of comparisons.

`setProperty` on a `Cesium3DTileFeature` writes into the tile's batch table, which is a typed array upload rather than a geometry change — so the cost is proportional to the number of *changed* features, which is why `onlyDirty` matters.

### 4. Pace the updates against the frame budget

```javascript
export class UpdatePacer {
  constructor({ maxMsPerFrame = 4, minIntervalMs = 250 } = {}) {
    this.maxMsPerFrame = maxMsPerFrame;
    this.minIntervalMs = minIntervalMs;
    this.queue = [];
    this.lastRunAt = 0;
    this.dropped = 0;
    this.coalesced = 0;
  }

  enqueue(message) {
    // Coalesce: a newer value for the same feature supersedes an older queued one.
    if (message.type === 'delta' && this.queue.length) {
      const tail = this.queue[this.queue.length - 1];
      if (tail.type === 'delta') {
        Object.assign(tail.changed, message.changed ?? {});
        tail.removed = [...(tail.removed ?? []), ...(message.removed ?? [])];
        tail.seq = message.seq;
        this.coalesced += 1;
        return { queued: false, coalesced: true };
      }
    }
    if (this.queue.length > 32) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(message);
    return { queued: true, depth: this.queue.length };
  }

  run(state, applyFn, nowMs = performance.now()) {
    if (nowMs - this.lastRunAt < this.minIntervalMs) {
      return { ran: false, reason: 'rate limited' };
    }
    const started = performance.now();
    let applied = 0;
    while (this.queue.length && performance.now() - started < this.maxMsPerFrame) {
      const msg = this.queue.shift();
      applyFn(state, msg);
      applied += 1;
    }
    this.lastRunAt = nowMs;
    return { ran: true, applied, remaining: this.queue.length,
             tookMs: Number((performance.now() - started).toFixed(2)) };
  }
}
```

Coalescing is the mechanism that makes a burst survivable. When a feed catches up after a reconnect and sends forty deltas at once, applying them one at a time in forty frames shows forty intermediate states nobody needs; merging them into one and applying it once shows the final state immediately for a fraction of the cost.

The 4 ms per-frame budget is the number to defend. A 16.7 ms frame with 4 ms of live-data work leaves 12 ms for rendering, which is enough; letting the update loop run to completion is how a live layer turns a smooth viewer into a stuttering one.

Dropping the oldest queued messages past a depth of 32 is correct for sensor data, where only the current value matters. It would be wrong for an event stream where every message has meaning, and that distinction is worth being explicit about.

### 5. Handle disconnection and resync

```javascript
export class SensorConnection {
  constructor(url, { state, pacer, onStatus } = {}) {
    this.url = url;
    this.state = state;
    this.pacer = pacer;
    this.onStatus = onStatus ?? (() => {});
    this.ws = null;
    this.backoffMs = 500;
    this.maxBackoffMs = 30_000;
    this.attempts = 0;
    this.closedByUs = false;
  }

  connect() {
    this.closedByUs = false;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.attempts = 0;
      this.backoffMs = 500;
      this.onStatus({ status: 'connected', at: Date.now() });
      this.ws.send(JSON.stringify({ type: 'subscribe', wantSnapshot: true }));
    };
    this.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); }
      catch { this.onStatus({ status: 'bad_message' }); return; }
      if (msg.type === 'heartbeat') { this.state.lastMessageAt = performance.now(); return; }
      this.pacer.enqueue(msg);
    };
    this.ws.onclose = () => {
      this.onStatus({ status: 'disconnected', attempts: this.attempts });
      if (!this.closedByUs) this.#scheduleReconnect();
    };
    this.ws.onerror = () => this.onStatus({ status: 'error' });
    return this;
  }

  #scheduleReconnect() {
    this.attempts += 1;
    const jitter = Math.random() * this.backoffMs * 0.3;
    const delay = Math.min(this.backoffMs + jitter, this.maxBackoffMs);
    setTimeout(() => this.connect(), delay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  requestResync() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', wantSnapshot: true }));
      return { requested: true };
    }
    return { requested: false, reason: 'socket not open' };
  }

  close() { this.closedByUs = true; this.ws?.close(); }
}
```

Exponential backoff with jitter is not optional when a twin has many viewers. A backend restart disconnects every client simultaneously, and without jitter they all reconnect at the same instant and knock it over again — the thundering herd, and it is entirely avoidable with one multiplication.

Asking for a snapshot on every connect, rather than trying to resume from the last sequence number, keeps the client simple and costs one 700 KB transfer per reconnect. Resumable streams are worth building only when reconnects are frequent and the state is large.

<figure class="diagram">
<svg viewBox="4 6 732 210" role="img" aria-labelledby="live-msgs-t live-msgs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="live-msgs-t">The three message types and why each exists</title>
  <desc id="live-msgs-d">A table of three feed message types. A snapshot carries every sensor value and is sent on connect or after a sequence gap, costing about 700 kilobytes for 14000 sensors. A delta carries only what changed and is a few hundred bytes every few seconds. A heartbeat carries nothing but the sequence number and exists so that no change and no connection are distinguishable.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="210" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="138" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="156" y="20" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="366" y="20" width="110" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="476" y="20" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="138" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="156" y="54" width="210" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="366" y="54" width="110" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="476" y="54" width="246" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="88" width="138" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="156" y="88" width="210" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="366" y="88" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="476" y="88" width="246" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="138" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="156" y="122" width="210" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="366" y="122" width="110" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="476" y="122" width="246" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="87" y="42">message</text><text x="261" y="42">carries</text><text x="421" y="42">size</text><text x="599" y="42">why it exists</text>
    <text x="87" y="76">snapshot</text><text x="261" y="76">every value</text><text x="421" y="76">~700 KB</text><text x="599" y="76">on connect and after a gap</text>
    <text x="87" y="110">delta</text><text x="261" y="110">changed values only</text><text x="421" y="110">~300 B</text><text x="599" y="110">the steady state</text>
    <text x="87" y="144">heartbeat</text><text x="261" y="144">sequence number only</text><text x="421" y="144">~80 B</text><text x="599" y="144">tells silence from a dead feed</text>
  </g>
  <text x="20" y="176" fill="#1f2937" font-size="12.5">Without the heartbeat, a quiet feed and a broken feed look identical to the client.</text>
  <text x="20" y="198" fill="#5b6471" font-size="12">Sequence numbers on the deltas are what make a dropped message detectable at all.</text>
</svg>
<figcaption>The heartbeat is the cheapest of the three and the one that makes the staleness indicator possible.</figcaption>
</figure>

### 6. Tell the truth about staleness

```javascript
export function stalenessBanner(state, connection, { warnAfterMs = 15_000,
                                                     failAfterMs = 60_000 } = {}) {
  const age = state.ageSeconds();
  const connected = connection.ws?.readyState === WebSocket.OPEN;
  const ageMs = age === null ? Infinity : age * 1000;

  let level, text;
  if (age === null) { level = 'unknown'; text = 'No sensor data received yet'; }
  else if (!connected && ageMs > failAfterMs) {
    level = 'error';
    text = `Sensor feed disconnected — values are ${Math.round(age)} s old`;
  } else if (ageMs > failAfterMs) {
    level = 'error'; text = `No update for ${Math.round(age)} s — values may be wrong`;
  } else if (ageMs > warnAfterMs) {
    level = 'warn'; text = `Last update ${Math.round(age)} s ago`;
  } else {
    level = 'ok'; text = `Live · updated ${age.toFixed(0)} s ago`;
  }
  return { level, text, ageSeconds: age, connected,
           sequenceGaps: state.gaps, features: state.values.size };
}

export function applyStalenessStyling(tileset, banner) {
  // Desaturate the live layer when the data is stale, so it cannot be mistaken for current.
  if (banner.level === 'error' || banner.level === 'unknown') {
    tileset.style = new Cesium.Cesium3DTileStyle({
      color: "color('#9aa3ad')",
      show: 'true',
    });
    return { desaturated: true, reason: banner.text };
  }
  return { desaturated: false };
}
```

Desaturating the layer when the feed dies is the behaviour that earns trust. A twin showing a confident heat map from data that stopped forty minutes ago will eventually be the basis of a wrong decision, and the operator has no way to know. Grey geometry with "no update for 2,400 s" is unhelpful and honest, which is the better failure.

The thresholds should come from the sensors' own reporting interval — warn at three intervals, fail at twelve — rather than from round numbers, so a feed that reports hourly is not permanently marked stale.

<figure class="diagram">
<svg viewBox="4 12 728 228" role="img" aria-labelledby="live-pace-t live-pace-d" xmlns="http://www.w3.org/2000/svg">
  <title id="live-pace-t">Applying a burst with and without pacing</title>
  <desc id="live-pace-d">Two timelines after a reconnect delivers forty queued deltas. Without pacing, each delta is applied as it arrives and the main thread spends 38 milliseconds in one frame, dropping frames and showing forty intermediate states. With coalescing and a four millisecond per frame budget, the forty deltas merge into one update applied in 3.1 milliseconds, showing the final state immediately with no dropped frames.</desc>
  <rect class="svg-bg" x="4" y="12" width="728" height="228" fill="#ffffff"/>
  <rect x="18" y="26" width="700" height="94" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="18" y="132" width="700" height="94" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="368" y="50" fill="#1f2937" font-size="13" text-anchor="middle">without pacing: 40 deltas applied as they arrive</text>
  <text x="368" y="156" fill="#1f2937" font-size="13" text-anchor="middle">with coalescing and a 4 ms frame budget</text>
  <g stroke-width="1.4">
    <rect x="46" y="66" width="286" height="34" fill="#ffffff" stroke="#b0413e"/>
    <rect x="340" y="66" width="30" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="378" y="66" width="30" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="46" y="172" width="54" height="34" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="108" y="172" width="30" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="146" y="172" width="30" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="184" y="172" width="30" height="34" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="60" y="88">38 ms of main-thread work — 2 frames dropped</text>
    <text x="60" y="194">3.1 ms</text>
    <text x="152" y="194">frames continue normally</text>
  </g>
  <g fill="#5b6471" font-size="12">
    <text x="340" y="114">frames resume</text>
    <text x="108" y="220">one merged update, final state shown at once</text>
  </g>
</svg>
<figcaption>The same forty messages, applied once instead of forty times — twelve times less main-thread work and no dropped frames.</figcaption>
</figure>

## Expected Output & Verification

```text
{ applied: 'snapshot', features: 14022 }
{ bands: 8, conditions: 10, field: 'temp', domain: [16, 30] }
{ written: 2841, unmatched: 11181 }
{ ran: true, applied: 1, remaining: 0, tookMs: 3.14 }
{ sensors: 14022, matched: 13987, missing: ['SN-99814', 'SN-99822'], missingCount: 35 }
{ level: 'ok', text: 'Live · updated 2 s ago', ageSeconds: 2.1, connected: true,
  sequenceGaps: 0, features: 14022 }
```

The `unmatched: 11181` figure looks alarming and is correct: only 2,841 of the 14,022 sensors are in tiles currently loaded, because the camera is looking at part of the city. Treating an unmatched id as an error would produce eleven thousand false alarms per update.

The 35 sensors that match nothing in the *whole* index are the real finding — sensors whose building was demolished or renamed between the monthly tiling run and now — and they are worth reporting to whoever owns the register.

Verify the join is correct and not merely populated, by round-tripping a known value:

```javascript
export async function joinCorrectnessCheck(index, state, sampleSize = 20) {
  const ids = [...state.values.keys()].filter((id) => index.lookup(id).length);
  const sample = ids.sort(() => Math.random() - 0.5).slice(0, sampleSize);
  const rows = [];
  for (const id of sample) {
    const expected = state.values.get(id);
    const refs = index.lookup(id);
    for (const { tile, batchId } of refs) {
      const feature = tile.content?.getFeature(batchId);
      if (!feature) { rows.push({ id, status: 'feature missing' }); continue; }
      const idOnFeature = String(feature.getProperty('sensorId'));
      const liveValue = feature.getProperty('liveValue');
      rows.push({
        id,
        idMatches: idOnFeature === String(id),
        valueMatches: liveValue === expected.temp,
        onFeature: liveValue, expected: expected.temp,
      });
    }
  }
  const bad = rows.filter((r) => r.idMatches === false || r.valueMatches === false);
  return { sampled: rows.length, mismatches: bad.length, examples: bad.slice(0, 3),
           correct: bad.length === 0 };
}
```

Checking that the identifier on the feature matches the key it was indexed under catches the off-by-one that an index built from batch ids is prone to — a wrong `batchId` colours the neighbouring building, which is indistinguishable from correct behaviour unless the values are checked.

Then verify the frame budget is being respected under a synthetic burst:

```javascript
export async function burstResilienceCheck(pacer, state, applyFn,
                                           { deltas = 200, featuresPerDelta = 80 } = {}) {
  const frameTimes = [];
  let seq = state.seq ?? 0;
  for (let i = 0; i < deltas; i++) {
    const changed = {};
    for (let f = 0; f < featuresPerDelta; f++) {
      changed[`SN-${Math.floor(Math.random() * 14000)}`] = { temp: 16 + Math.random() * 14 };
    }
    pacer.enqueue({ type: 'delta', seq: ++seq, at: Date.now(), changed });
  }
  for (let frame = 0; frame < 60; frame++) {
    const t0 = performance.now();
    pacer.run(state, applyFn, performance.now() + frame * 16.7);
    frameTimes.push(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const sorted = frameTimes.slice().sort((a, b) => a - b);
  return {
    frames: frameTimes.length,
    medianMs: Number(sorted[30].toFixed(2)),
    p95Ms: Number(sorted[57].toFixed(2)),
    maxMs: Number(sorted[59].toFixed(2)),
    coalesced: pacer.coalesced,
    dropped: pacer.dropped,
    withinBudget: sorted[57] <= pacer.maxMsPerFrame * 1.5,
  };
}
```

The p95 must stay near the configured budget. A max far above it means a single message was too large to apply in one slice, which argues for chunking a snapshot rather than applying it whole.

## Performance Notes

- **`setProperty` costs roughly 2–5 µs per feature.** 3,000 changed features is about 10 ms, which is why the per-frame budget and `onlyDirty` both exist.
- **Style re-evaluation is a shader uniform update**, not a recompile, as long as the style *expression* does not change. Re-creating the style object on every update forces a recompile and costs tens of milliseconds.
- **Keep style conditions under about 16.** They become branches in a shader.
- **Deltas at 14,000 sensors are a few hundred bytes**; snapshots are hundreds of kilobytes. Send snapshots only on connect and after a gap.
- **Binary framing beats JSON above a few thousand values per second** — a typed-array payload keyed by index removes the parse cost entirely.
- **Rebuilding the feature index on every tile load is O(features in tile).** The `tileUnload` handler as written scans the whole map; for large indexes keep a per-tile list to remove instead.
- **Do the join in a worker** if the feed exceeds a few thousand changes per second, and post only the resulting typed array to the main thread.

## Common Errors

**Colours never change.** The style expression references a property the features do not have. Confirm `liveValue` is written before the style is applied, and that the property name matches exactly.

**The wrong buildings light up.** The feature index maps identifiers to the wrong `batchId`, usually from assuming batch ids are stable across tile reloads. Rebuild the index on `tileLoad`.

**Frame rate collapses when the feed is busy.** Updates are applied without pacing. Add the per-frame budget and coalescing.

**Values drift wrong over hours.** A dropped delta with no sequence check. Add sequence numbers and resync on a gap.

**Every client reconnects at once after a backend restart.** No jitter in the backoff.

**The map looks live after the feed died.** No staleness handling. Desaturate and say how old the data is.

**Memory grows over a day.** The `values` map retains sensors that no longer report, and the index retains references to unloaded tiles. Expire both.

**Style recompiles on every update.** A new `Cesium3DTileStyle` per message. Create it once per *domain* change and push values as properties.

## Frequently Asked Questions

### WebSocket or server-sent events?

SSE is simpler, works over plain HTTP/2 and is sufficient when the client never sends anything but a subscribe. WebSocket is the better fit once the client filters by viewport or requests resyncs, which most twins eventually do.

### Should live values go into the tileset metadata instead?

No — metadata is baked at tiling time. The property table holds the stable identifier and the static attributes; live values belong in the batch table at runtime.

### Can this drive geometry changes, not just colour?

For small changes, yes: `feature.show` and per-feature translation via a style are both possible. Anything that changes shape needs new geometry, which means a separate live primitive layer rather than the static tileset.

## Related Guides

- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — the style language this drives
- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — where the join identifier lives
- [Detecting Stale Tiles After Deploy](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/detecting-stale-tiles-after-deploy/) — the geometry-side equivalent of a staleness check

Back to [Streaming Sync Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
