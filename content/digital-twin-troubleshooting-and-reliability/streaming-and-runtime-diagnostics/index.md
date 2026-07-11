# Streaming & Runtime Diagnostics for 3D Tiles Clients

A tileset can pass every offline check and still misbehave the moment a camera moves through it. Tiles flash into view a beat too late, the network fetches ten times the geometry the frame needs, VRAM climbs until the tab reloads itself, or detail simply refuses to sharpen no matter how close you fly. These are runtime faults, and they live in the interaction between the authored `geometricError`, the client's screen-space error (SSE) calculation, the request queue, and a fixed memory budget. This guide instruments that interaction so each symptom maps to a measured number rather than a hunch, and pairs every diagnosis with a concrete fix — predictive prefetch, an SSE threshold change, LRU eviction, or queue backpressure. It assumes a served 3D Tiles tileset (built via [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/)) and a client whose frame loop you can log, and it sits under [digital twin troubleshooting and reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/) as the runtime counterpart to the offline [data validation and QA gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).

## Prerequisites

You need read access to the client's per-frame tile state (visible set, each tile's `geometricError`, distance, byte size, and residency) and a Python environment to reproduce the SSE math offline against the same `tileset.json`. The instrumentation snippets below run against a captured frame trace; the fixes belong in the client, but every threshold is derived and verified in Python first.

| Component | Pinned version | Purpose |
|-----------|----------------|---------|
| Python | 3.10–3.12 | Reproduce SSE math, model the request queue offline |
| `numpy` | 1.26+ | Vectorized distance, SSE, and memory arithmetic |
| `requests` | 2.31+ | Replay tile fetches to measure over-fetch ratio |
| CesiumJS | 1.118+ | Reference runtime for `maximumScreenSpaceError`, `cacheBytes` |
| `3d-tiles-validator` | 0.5+ | Confirm the geometry, not the client, is at fault first |

**Input assumptions.** The tileset renders in Earth-Centered Earth-Fixed coordinates, **EPSG:4978 (geocentric WGS84, metres)**, so every distance the client computes between the camera and a tile centre is a true metric distance. `geometricError` is likewise metres in EPSG:4978. If your capture logs distances in a projected CRS such as EPSG:32618 or, worse, degrees from EPSG:4326, the SSE numbers below are meaningless — reconcile the frame trace to the render CRS before diagnosing anything.

## Concept

Every 3D Tiles runtime executes the same loop each frame: derive the view frustum from the camera, cull tiles whose bounding volume falls outside it, compute each survivor's screen-space error, and refine (fetch children) while that error exceeds `maximumScreenSpaceError`. Screen-space error is the authored `geometricError` projected through the camera into pixels — it shrinks with distance, so a distant tile is "good enough" and a near tile is not. Refinement requests flow into a priority queue; the queue drains into GPU uploads; a cache of resident tiles is bounded by a memory budget and trimmed by an eviction policy.

Almost every runtime fault is one of those stages disagreeing with another. Popping is the queue draining slower than the camera reveals tiles. Over-fetching is the SSE threshold or the bounding volumes admitting tiles the frame never needed. OOM is the cache accepting more than the budget because eviction is absent or too lazy. "Never refines" and "loads all at once" are both `geometricError`-scale faults — the projected error never crosses, or always crosses, the pixel threshold regardless of distance. Diagnosis therefore means instrumenting each stage's inputs and outputs, then comparing them against what the SSE equation says should happen. Because the equation is deterministic, you can replay a captured frame in Python and prove which stage is lying before you touch the client.

<figure class="diagram">
<svg viewBox="0 0 860 340" role="img" aria-labelledby="srd-t srd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="srd-t">Per-frame runtime diagnostic loop for a 3D Tiles client</title>
  <desc id="srd-d">Each frame the client reads camera pose and velocity, culls tiles against the frustum, computes screen-space error per tile, orders refinement requests in a priority queue, and passes them through a memory-budget gate that either uploads to the GPU within budget or evicts the least-recently-used tile when over budget, repeating every frame.</desc>
  <defs>
    <marker id="srd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#srd-arrow)">
    <line x1="182" y1="72" x2="208" y2="72"/>
    <line x1="372" y1="72" x2="398" y2="72"/>
    <line x1="562" y1="72" x2="588" y2="72"/>
    <line x1="670" y1="106" x2="670" y2="148"/>
    <line x1="558" y1="180" x2="502" y2="180"/>
    <line x1="670" y1="212" x2="670" y2="248"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="20" y="40" width="162" height="64" rx="8"/>
    <rect x="210" y="40" width="162" height="64" rx="8"/>
    <rect x="400" y="40" width="162" height="64" rx="8"/>
  </g>
  <rect x="588" y="40" width="162" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="560" y="150" width="220" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="150" width="200" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="560" y="250" width="220" height="48" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="101" y="68"><tspan x="101" dy="0">Camera pose</tspan><tspan x="101" dy="16">+ velocity</tspan></text>
    <text x="291" y="68"><tspan x="291" dy="0">Frustum cull</tspan><tspan x="291" dy="16">visible set</tspan></text>
    <text x="481" y="68"><tspan x="481" dy="0">SSE compute</tspan><tspan x="481" dy="16">per tile</tspan></text>
    <text x="400" y="186"><tspan x="400" dy="0">GPU upload</tspan><tspan x="400" dy="16">+ render</tspan></text>
  </g>
  <g fill="#15384a" font-size="13" text-anchor="middle">
    <text x="669" y="68"><tspan x="669" dy="0">Priority queue</tspan><tspan x="669" dy="16">max SSE first</tspan></text>
  </g>
  <text x="670" y="185" fill="#1f2937" font-size="13" text-anchor="middle">Memory-budget gate (VRAM)</text>
  <text x="670" y="278" fill="#1f2937" font-size="13" text-anchor="middle">LRU evict oldest tile</text>
  <text x="529" y="172" fill="#5b6471" font-size="11" text-anchor="middle">within budget</text>
  <text x="700" y="238" fill="#5b6471" font-size="11" text-anchor="middle">over budget</text>
  <rect x="20" y="306" width="760" height="26" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="400" y="323" fill="#1f2937" font-size="12" text-anchor="middle">Per-frame loop: cull, compute SSE, queue, and gate against the budget every rendered frame</text>
</svg>
<figcaption>The runtime frame loop, and where each fault lives: popping in the queue drain, over-fetching in the SSE gate, OOM in the budget gate, and refinement faults in the SSE compute itself.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow below instruments one stage at a time. Capture a frame trace as a list of per-tile records — `geometricError`, tile-centre in EPSG:4978, byte size, and whether the tile was resident — then run each diagnostic against it.

### 1. Reproduce the SSE calculation the client uses

Before blaming any stage, confirm your offline SSE matches the runtime's. The 3D Tiles SSE is `geometricError * viewportHeight / (2 * distance * tan(fovY/2))`. Compute it vectorized so you can screen thousands of tiles per frame.

```python
import numpy as np

def screen_space_error(geometric_error, distance, viewport_h=1080,
                       fov_y=np.radians(60.0)):
    """3D Tiles SSE in pixels; distance in metres (EPSG:4978)."""
    distance = np.maximum(distance, 1e-3)          # avoid divide-by-zero at the camera
    sse_per_metre = viewport_h / (2.0 * distance * np.tan(fov_y / 2.0))
    return np.asarray(geometric_error) * sse_per_metre

# Frame trace: parallel arrays pulled from the client's per-tile state.
geo_err = np.array([512.0, 256.0, 128.0, 64.0, 32.0])      # metres
centers = np.array([[1_334_010, -4_651_120, 4_140_090]] * 5, dtype=float)
camera  = np.array([1_334_400, -4_651_400, 4_140_500], dtype=float)
dist    = np.linalg.norm(centers - camera, axis=1)

sse = screen_space_error(geo_err, dist)
print(np.round(sse, 1))          # compare against the client's logged SSE per tile
```

If these numbers do not match the client's logged SSE within rounding, the fault is a units or CRS mismatch, not a queue or budget problem — stop and reconcile the frame CRS to EPSG:4978 first.

### 2. Diagnose tile popping and pop-in

Popping is a tile that becomes visible and is still not resident several frames later. Instrument it by recording, per tile, the frame it entered the frustum and the frame it finished uploading; the gap is the pop latency.

```python
from collections import defaultdict

def pop_latency(frame_events):
    """frame_events: list of (frame_idx, tile_id, event) where event in
    {'visible', 'resident'}. Returns tiles whose residency lagged visibility."""
    first_visible, became_resident = {}, {}
    for frame_idx, tile_id, event in frame_events:
        if event == "visible":
            first_visible.setdefault(tile_id, frame_idx)
        elif event == "resident":
            became_resident.setdefault(tile_id, frame_idx)
    lag = {}
    for tile_id, vf in first_visible.items():
        rf = became_resident.get(tile_id)
        if rf is None or rf - vf > 2:              # >2 frames = perceptible pop
            lag[tile_id] = None if rf is None else rf - vf
    return lag

popping = pop_latency(captured_events)
print(f"{len(popping)} tiles popped (>2 frame lag or never resident)")
```

The fix is predictive prefetch: extend the visible set by projecting the camera forward along its velocity so tiles are requested before they are strictly visible. The full treatment lives in [eliminating tile popping and pop-in](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/eliminating-tile-popping-and-pop-in/); the short version is to enqueue tiles for the predicted pose, not only the current one.

### 3. Diagnose over-fetching

Over-fetching is bytes fetched that the frame never renders. Measure the ratio of requested tile bytes to rendered tile bytes; a healthy client sits near 1.2–1.5, and 3× or more means the SSE threshold is too aggressive or bounding volumes are loose.

```python
def over_fetch_ratio(requested_bytes, rendered_bytes):
    rendered = max(rendered_bytes, 1)
    return requested_bytes / rendered

requested = 240_000_000          # bytes the queue pulled this second
rendered  = 41_000_000           # bytes actually drawn
ratio = over_fetch_ratio(requested, rendered)
print(f"over-fetch ratio {ratio:.2f}x")

# If ratio is high, model the effect of raising the SSE threshold.
for max_sse in (8, 16, 24, 32):
    refined = int((sse > max_sse).sum())
    print(f"maximumScreenSpaceError={max_sse}: {refined} tiles would refine")
```

Raising `maximumScreenSpaceError` from 16 toward 24–32 cuts refinement count directly. If the ratio stays high even at a coarse threshold, the cause is loose bounding volumes admitting off-screen tiles — re-tile with tight boxes, since the cull runs on the bounds the tiler wrote.

### 4. Diagnose tiles that never refine or load all at once

Both are `geometricError`-scale faults. If a leaf's projected SSE never exceeds the threshold even at point-blank range, the authored error is too small and detail never loads; if the root's SSE always exceeds it, every tile refines immediately. Sweep the SSE across a distance range to see which regime you are in.

```python
distances = np.array([2000, 1000, 500, 200, 100, 50, 20])   # metres to tile
leaf_error, root_error = 0.5, 512.0

leaf_sse = screen_space_error(leaf_error, distances)
root_sse = screen_space_error(root_error, distances)
print("leaf SSE:", np.round(leaf_sse, 2))   # if all < 16, leaf never refines
print("root SSE:", np.round(root_sse, 1))   # if all >> 16 at range, over-refines
```

A leaf with `geometricError` so small that its SSE never reaches 16 px is starved geometry — re-measure the error against the source surface as in [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) rather than hard-coding a tiny constant. A root error large enough to force every tile in at once means the client cannot stream progressively; anchor the root error to the extent diagonal and halve per level.

### 5. Diagnose VRAM OOM and GC stalls

OOM and garbage-collection stalls come from a cache that accepts tiles past the budget. Track resident bytes as a running counter and evict the least-recently-used tile the instant a load would breach the ceiling.

```python
from collections import OrderedDict

class TileCache:
    """LRU cache bounded by a hard byte budget (the VRAM pool)."""
    def __init__(self, budget_bytes):
        self.budget = budget_bytes
        self.resident = 0
        self._store = OrderedDict()             # tile_id -> byte size

    def touch(self, tile_id):
        if tile_id in self._store:
            self._store.move_to_end(tile_id)    # mark most-recently-used

    def admit(self, tile_id, size):
        while self.resident + size > self.budget and self._store:
            old_id, old_size = self._store.popitem(last=False)   # evict LRU
            self.resident -= old_size
        self._store[tile_id] = size
        self.resident += size
        return self.resident

cache = TileCache(budget_bytes=1_536 * 1024 * 1024)   # 1.5 GiB pool
for tid, size in resident_loads:                       # replay the frame's loads
    cache.touch(tid)
    cache.admit(tid, size)
print(f"resident {cache.resident/1e6:.0f} MB of {cache.budget/1e6:.0f} MB budget")
assert cache.resident <= cache.budget
```

If the client has no such ceiling, the browser's own allocator triggers the GC stalls you see as periodic frame hitches. Set `cacheBytes`/`maximumCacheOverflowBytes` in CesiumJS to the same pool and the stalls disappear.

### 6. Diagnose request-queue saturation

Saturation is an unbounded queue that keeps issuing fetches while the network is already maxed, so latency climbs and frames stall waiting on a socket. Cap in-flight requests and order by descending SSE, dropping the tail when the queue is full — backpressure, not the browser's connection pool, should bound concurrency.

```python
import heapq

def build_request_queue(candidates, camera_pos, max_in_flight=6, max_sse=16.0):
    """candidates: list of dicts with 'id','geometricError','center','size'.
    Returns the highest-priority tiles to fetch this frame under backpressure."""
    heap = []
    for t in candidates:
        d = float(np.linalg.norm(np.asarray(t["center"], float) - camera_pos))
        s = float(screen_space_error(t["geometricError"], d))
        if s > max_sse:
            heapq.heappush(heap, (-s, t["id"], t["size"]))   # max-SSE first
    dispatch = []
    while heap and len(dispatch) < max_in_flight:            # bounded concurrency
        neg_s, tid, size = heapq.heappop(heap)
        dispatch.append(tid)
    return dispatch                                          # rest deferred to next frame

fetch_now = build_request_queue(frame_candidates, camera, max_in_flight=6)
print(f"dispatching {len(fetch_now)} tiles; {len(frame_candidates)} candidates seen")
```

A `max_in_flight` of 4–8 matches typical browser per-host connection limits; deferring the tail to the next frame keeps the socket pool from thrashing and lets the highest-SSE tiles win the bandwidth.

## Validation & Verification

Confirm each fix with a measured before/after, not a visual impression. SSE must fall monotonically with distance for a fixed error, the cache must never exceed its budget, and the over-fetch ratio must drop after a threshold change.

```python
# 1. SSE is strictly decreasing with distance for a fixed geometricError.
d = np.array([50, 100, 200, 400, 800], float)
s = screen_space_error(128.0, d)
assert np.all(np.diff(s) < 0), "SSE must shrink as tiles recede"

# 2. Cache residency never breaches the budget after admission.
assert cache.resident <= cache.budget

# 3. Raising the threshold reduces the refined-tile count.
assert (sse > 24).sum() <= (sse > 16).sum()
print("runtime invariants hold")
```

Expected values for a 1.5 GiB pool over a 1 km² urban tileset: resident bytes plateau just under the budget, over-fetch ratio settles at 1.2–1.6 with `maximumScreenSpaceError` near 16, and pop latency drops under two frames once prefetch is enabled.

```text
over-fetch ratio 1.43x
resident 1502 MB of 1536 MB budget
12 tiles popped (>2 frame lag) before prefetch -> 0 after
runtime invariants hold
```

## Performance & Scale

At city scale the per-frame candidate set can reach tens of thousands of tiles, so the diagnostics themselves must stay cheap. Keep the SSE computation vectorized in `numpy` — a Python loop over 20,000 tiles blows the frame budget on its own. The priority queue should only ever hold tiles above the SSE threshold, not the full visible set; pre-filtering with the boolean mask keeps the heap small. For memory accounting, stamp each tile's decompressed byte size into its metadata during tiling so the client sums residency without decoding, which is the same discipline the offline pipeline enforces at ingestion. When a twin serves multiple device tiers, calibrate `maximumScreenSpaceError` and the budget per tier rather than shipping one profile — a mid-range phone tolerates a coarser threshold and a smaller pool than a workstation, and the streaming behaviour follows directly from those two dials.

## Failure Modes & Gotchas

**SSE looks right but tiles still never refine.** The client is clamping `maximumScreenSpaceError` internally, or the tile has no children to refine into. Confirm the tileset tree actually branches below the tile in question; a leaf with a non-zero `geometricError` advertises detail that does not exist, so the client keeps the leaf and the geometry never sharpens. Set genuine leaves to `geometricError` 0.

**Over-fetch ratio is low but the network is still saturated.** The bytes are needed but arriving too slowly — this is a queue-concurrency and payload-size problem, not an SSE one. Check whether tiles are Draco-compressed and gzipped; an uncompressed leaf can be 5–10× larger than it needs to be, saturating the socket even when the tile count is correct.

**Cache thrashes at the budget boundary.** Residency oscillates as the same tiles are evicted and immediately re-requested because the budget is barely larger than the working set. Raise the pool or lower `maximumScreenSpaceError` so fewer tiles are resident at once; a cache smaller than one frame's visible set can never stabilize.

**Pop latency spikes only during fast camera moves.** The prefetch horizon is too short for the camera speed. Scale the forward projection by the measured velocity rather than a fixed distance, so a fast fly-through warms tiles proportionally further ahead.

## Frequently Asked Questions

### Why do my SSE numbers not match what CesiumJS logs?

Almost always a CRS or units mismatch. CesiumJS computes distance in EPSG:4978 metres; if your frame trace logged camera and tile positions in a projected CRS like EPSG:32618 or in degrees from EPSG:4326, the distances differ and so does every derived SSE. Reproject the trace to EPSG:4978 before comparing, and confirm `geometricError` is also in metres.

### Is popping a tiling problem or a client problem?

Usually a client problem, provided the tileset itself is valid. Popping means resident geometry lags the visible set, which is a queue-drain and prefetch issue rather than a geometry issue. The exception is a `geometricError` scale error that forces a large refinement all at once; rule that out with the distance sweep in step 4 before tuning prefetch.

### What memory budget should I set?

Start below the device's available GPU memory with headroom for textures and the framebuffer — roughly 1–1.5 GiB for a desktop tile pool, far less on mobile. The exact number matters less than enforcing it as a hard ceiling with LRU eviction, so the cache trims itself before the driver's out-of-memory killer intervenes.

### Can I diagnose these faults without touching the client source?

Yes. Capture the client's per-tile state as a frame trace and run every diagnostic in this guide offline in Python. The SSE equation, over-fetch ratio, and cache model are all deterministic, so you can prove which stage is at fault and validate a threshold change before implementing it in the runtime.

## Related Guides

- [Eliminating Tile Popping and Pop-In](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/eliminating-tile-popping-and-pop-in/) — predictive prefetch and LOD crossfade in depth
- [Data Validation & QA Gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) — proving the geometry is sound before blaming the client
- [Streaming Sync Patterns for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) — the SSE queue, prefetch, and eviction model these diagnostics probe
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — where a correct, measured geometricError is produced

Back to [Digital Twin Troubleshooting & Reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/).
