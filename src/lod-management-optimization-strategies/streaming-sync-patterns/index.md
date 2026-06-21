---
title: "Streaming Sync Patterns for 3D Geospatial"
description: "Viewport-driven tile streaming and state sync for digital twins: predictive prefetch, LRU/LFU eviction, backpressure, and reconciliation in Python asyncio."
---
# Streaming Sync Patterns for 3D Geospatial Data & Digital Twin Automation

A city-scale digital twin holds far more geometry than any client can resolve at once — a single 3D Tiles dataset for a mid-size metropolitan area routinely exceeds 200 GB on disk, while a browser's WebGL context has a practical budget of a few hundred megabytes of GPU memory. Streaming sync patterns close that gap by treating the dataset as a live stream keyed to the camera: tiles are fetched as the viewport approaches them, prioritized by screen-space contribution, held in a bounded cache, and evicted as they fall out of view. This page builds a server-side prefetch and eviction model in Python `asyncio` with `numpy` scoring, defines the tile state machine that keeps client and server in agreement, and describes how the CesiumJS client consumes the result. All world-space math here assumes a single projected metric CRS — EPSG:32618 (UTM zone 18N) is used throughout — with geographic EPSG:4326 reserved for the camera longitude/latitude that arrives over the wire.

## Prerequisites

This workflow targets a server that scores and prefetches tiles ahead of a thin rendering client. Pin these versions so the async scheduling and array math behave identically across machines:

- **Python 3.11+** — required for `asyncio.TaskGroup` and `asyncio.timeout()`, both used below for structured cancellation.
- **`numpy` 1.26+** — vectorized priority scoring over candidate tile arrays.
- **`aiohttp` 3.9+** or equivalent async HTTP client — for fetching tile payloads from origin or object storage. The examples stub the network call so they run without a server.
- **A 3D Tiles 1.1 tileset** following the [OGC 3D Tiles specification](https://www.ogc.org/standard/3dtiles/) — an implicit quadtree or explicit bounding-volume hierarchy with `geometricError` per tile. The streaming logic assumes you have already produced this with [automated tile generation](/lod-management-optimization-strategies/automated-tile-generation/).
- **Tile bounding volumes in EPSG:32618** (UTM 18N, metres). Distances, frustum tests, and eviction margins are all metric; mixing in EPSG:4326 degrees here would make the priority scores meaningless.
- **A camera telemetry feed** delivering position, look direction, field of view, and viewport pixel dimensions at 30–60 Hz. Camera position is converted from EPSG:4326 to EPSG:32618 once per frame before scoring.

Input format for the tile index is a flat table — `tile_id`, centre (x, y, z) in EPSG:32618, bounding-sphere radius in metres, `geometricError`, and quadtree depth. Keep it in a `numpy` structured array or a Parquet file loaded into one; row-wise Python loops will not keep up with a 60 Hz camera over tens of thousands of tiles.

## Concept

A streaming tile is never simply "there" or "not there" — it moves through a small, explicit lifecycle, and every reliable sync system is really an enforcement of that lifecycle. A tile begins **unloaded** (known to the index, not in memory). When the camera brings it into view and its priority score clears the admission threshold, it transitions to **fetching**: a network task is in flight. On a validated response it becomes **loaded** (bytes decoded, in RAM or GPU buffer) and then **visible** once the renderer actually draws it. When the camera moves on, a visible or loaded tile is marked **evicted** and its memory is reclaimed — returning to unloaded. The hard part is that camera motion can invalidate a tile while it is still `fetching`; the state machine must cancel that task cleanly rather than wait for it, decode it, and immediately evict it.

Priority is what decides admission order. Each candidate tile is scored by a weighted combination of distance to the camera, screen-space projected size (a tile's `geometricError` divided by its distance, scaled by viewport height), and frustum membership. Tiles outside the frustum score zero and are never admitted; tiles that fill more pixels at lower distance score highest and are fetched first. Because the camera updates continuously, the score is recomputed each frame and the fetch queue is reordered — a tile queued three frames ago at low priority may now sit at the front, or may have dropped out of view entirely and be cancelled. The eviction side mirrors this: the cache is bounded, and when it is full the lowest-value resident tile (by recency for LRU, by access frequency for LFU) is dropped to make room.

<figure class="diagram">
<svg viewBox="0 0 820 250" role="img" aria-labelledby="sync-sm-t sync-sm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sync-sm-t">Tile streaming state machine</title>
  <desc id="sync-sm-d">A tile moves from unloaded to fetching when its priority clears the admission threshold, to loaded on a validated response, to visible when drawn, then to evicted when the camera moves away, returning to unloaded; a fetching tile can be cancelled straight back to unloaded.</desc>
  <defs>
    <marker id="sync-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="2" rx="8">
    <rect x="20" y="95" width="130" height="60" rx="8" fill="#ffffff" stroke="#5b6471"/>
    <rect x="200" y="95" width="130" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="380" y="95" width="130" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="560" y="95" width="130" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="10" width="130" height="55" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#sync-arrow)">
    <line x1="150" y1="125" x2="198" y2="125"/>
    <line x1="330" y1="125" x2="378" y2="125"/>
    <line x1="510" y1="125" x2="558" y2="125"/>
    <path d="M625 95 L625 67"/>
    <path d="M560 37 C 300 -20 70 30 80 93"/>
    <path d="M265 95 C 200 40 130 60 95 93"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="85" y="130">unloaded</text>
    <text x="265" y="130">fetching</text>
    <text x="445" y="130">loaded</text>
    <text x="625" y="130">visible</text>
    <text x="625" y="42">evicted</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="174" y="116">admit</text>
    <text x="354" y="116">200 OK</text>
    <text x="534" y="116">draw</text>
    <text x="180" y="58">cancel</text>
    <text x="330" y="20">camera moves on</text>
  </g>
</svg>
<figcaption>The tile lifecycle: priority admits a tile to fetching, a validated response loads it, the renderer makes it visible, and camera motion evicts it back to unloaded — with cancellation short-circuiting an in-flight fetch.</figcaption>
</figure>

This page extends [LOD Management & Optimization Strategies](/lod-management-optimization-strategies/) by adding temporal coordination on top of spatial structure. The hierarchy itself — parent/child tile relationships and refinement rules — comes from [hierarchical LOD structuring](/lod-management-optimization-strategies/hierarchical-lod-structuring/), and the priority scorer below depends on each candidate carrying a correct `geometricError`, so the two layers must agree on the quadtree.

## Step-by-Step Workflow

The model has three concurrent loops: a scorer that ranks candidates each frame, a prefetch scheduler that admits the top candidates under a concurrency cap, and an eviction policy that keeps the cache bounded. They communicate through a shared registry keyed by `tile_id`.

### 1. Load the tile index and define the state machine

Load the spatial index into a `numpy` structured array once at startup so per-frame scoring is vectorized. Model tile state as an explicit enum and a registry record — the registry is the single source of truth both loops read and write.

```python
import asyncio
import time
import logging
from enum import Enum
from dataclasses import dataclass, field
import numpy as np

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("sync")

class TileStatus(Enum):
    UNLOADED = "unloaded"
    FETCHING = "fetching"
    LOADED = "loaded"
    VISIBLE = "visible"
    EVICTED = "evicted"

# Tile index in EPSG:32618 (UTM 18N, metres). Loaded once from Parquet/GeoJSON.
TILE_DTYPE = np.dtype([
    ("tile_id", "U24"), ("cx", "f8"), ("cy", "f8"), ("cz", "f8"),
    ("radius", "f8"), ("geometric_error", "f8"), ("depth", "i4"),
])

# Example index: a 4-tile patch around Lower Manhattan in EPSG:32618.
index = np.array([
    ("18N-0-0-0", 583000.0, 4507000.0, 30.0, 220.0, 32.0, 0),
    ("18N-1-0-0", 583220.0, 4507000.0, 25.0, 110.0, 16.0, 1),
    ("18N-1-1-0", 583000.0, 4507220.0, 25.0, 110.0, 16.0, 1),
    ("18N-2-0-0", 583330.0, 4507110.0, 12.0,  55.0,  8.0, 2),
], dtype=TILE_DTYPE)

@dataclass
class TileRecord:
    tile_id: str
    status: TileStatus = TileStatus.UNLOADED
    priority: float = 0.0
    last_access: float = field(default_factory=time.monotonic)
    hits: int = 0          # access count, for LFU
    nbytes: int = 0        # payload size once loaded, for the byte budget

registry: dict[str, TileRecord] = {
    row["tile_id"]: TileRecord(row["tile_id"]) for row in index
}
```

### 2. Score candidates against the camera each frame

The scorer is pure `numpy`: it computes distance and screen-space error for every tile in one pass, zeroes out tiles behind the camera or outside the frustum, and returns the ranked candidate IDs. Camera position arrives as EPSG:4326 and is reprojected to EPSG:32618 by the caller before this runs.

```python
def score_tiles(cam_xy: np.ndarray, view_dir: np.ndarray,
                viewport_h: int, fov_y: float, idx: np.ndarray) -> np.ndarray:
    """Return priority scores (higher = fetch sooner) for every tile in idx.
    cam_xy: (2,) camera position in EPSG:32618 metres. view_dir: (2,) unit vector."""
    centres = np.column_stack((idx["cx"], idx["cy"]))
    delta = centres - cam_xy                      # vector camera -> tile centre
    dist = np.linalg.norm(delta, axis=1) + 1e-6   # avoid div-by-zero

    # Screen-space error: geometricError projected to pixels (3D Tiles SSE formula).
    sse = (idx["geometric_error"] * viewport_h) / (2.0 * dist * np.tan(fov_y / 2.0))

    # Frustum gate: drop tiles behind the camera (dot of view_dir and direction < 0).
    forward = (delta @ view_dir) > -idx["radius"]
    score = np.where(forward, sse, 0.0)
    order = np.argsort(score)[::-1]               # descending
    return idx["tile_id"][order][score[order] > 1.0]   # 1 px admission threshold
```

### 3. Run the async prefetch scheduler with backpressure

The scheduler admits the highest-scoring candidates up to a concurrency cap enforced by a semaphore. Each fetch is a structured task; when the camera invalidates a tile mid-flight, the task is cancelled rather than awaited. Backpressure falls out naturally — the semaphore blocks new admissions until in-flight fetches drain.

```python
class PrefetchScheduler:
    def __init__(self, max_concurrent: int = 8, byte_budget: int = 256 * 1024 * 1024):
        self.sem = asyncio.Semaphore(max_concurrent)
        self.tasks: dict[str, asyncio.Task] = {}
        self.byte_budget = byte_budget
        self.bytes_resident = 0

    async def reconcile(self, ranked_ids: np.ndarray):
        wanted = set(ranked_ids.tolist())
        # Cancel in-flight fetches for tiles that left the candidate set.
        for tid, task in list(self.tasks.items()):
            if tid not in wanted:
                task.cancel()
        # Admit new candidates in priority order.
        for tid in ranked_ids:
            rec = registry[tid]
            rec.last_access = time.monotonic()
            rec.hits += 1
            if rec.status is TileStatus.UNLOADED and tid not in self.tasks:
                self.tasks[tid] = asyncio.create_task(self._fetch(tid))

    async def _fetch(self, tid: str):
        rec = registry[tid]
        async with self.sem:                      # backpressure: cap concurrency
            rec.status = TileStatus.FETCHING
            try:
                async with asyncio.timeout(5.0):  # network resilience
                    payload = await self._http_get(tid)
                rec.nbytes = len(payload)
                self.bytes_resident += rec.nbytes
                rec.status = TileStatus.LOADED
                await self._evict_if_needed()
            except asyncio.CancelledError:
                rec.status = TileStatus.UNLOADED  # clean rollback, no decode
                raise
            except (asyncio.TimeoutError, OSError) as exc:
                rec.status = TileStatus.UNLOADED
                log.warning("fetch %s failed: %s", tid, exc)
            finally:
                self.tasks.pop(tid, None)

    async def _http_get(self, tid: str) -> bytes:
        await asyncio.sleep(0.05)                  # replace with aiohttp GET of the .glb
        return b"\x00" * (180_000 + registry[tid].hits)
```

### 4. Apply LRU / LFU eviction against the byte budget

Eviction keeps resident bytes under budget. The policy ranks resident tiles by recency (LRU) or access frequency (LFU) and drops the weakest until the budget clears. Visible tiles are protected — evicting what the renderer is currently drawing causes the worst popping.

```python
    async def _evict_if_needed(self, policy: str = "lru"):
        if self.bytes_resident <= self.byte_budget:
            return
        resident = [r for r in registry.values()
                    if r.status is TileStatus.LOADED]   # never evict VISIBLE
        if policy == "lfu":
            resident.sort(key=lambda r: (r.hits, r.last_access))
        else:  # lru
            resident.sort(key=lambda r: r.last_access)
        for rec in resident:
            if self.bytes_resident <= self.byte_budget:
                break
            self.bytes_resident -= rec.nbytes
            rec.status = TileStatus.EVICTED
            log.info("evicted %s (%d KB)", rec.tile_id, rec.nbytes // 1024)
            rec.status = TileStatus.UNLOADED        # ready to re-admit later
```

### 5. Drive the loop from camera telemetry

Each telemetry frame, reproject the camera, score, and reconcile. On the client, CesiumJS performs the symmetric job: its `Cesium3DTileset` traverses the same bounding-volume hierarchy, computes screen-space error with `maximumScreenSpaceError`, and issues its own fetches — so this server-side model is a prefetch warm-up that puts hot tiles in cache before the client asks, not a replacement for the client's own selection.

```python
from pyproj import Transformer

to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32618", always_xy=True)

async def stream_loop(cam_feed):
    sched = PrefetchScheduler(max_concurrent=8)
    async for frame in cam_feed:                   # frame: lon, lat, heading_rad
        x, y = to_utm.transform(frame["lon"], frame["lat"])
        view_dir = np.array([np.cos(frame["heading"]), np.sin(frame["heading"])])
        ranked = score_tiles(np.array([x, y]), view_dir,
                             viewport_h=1080, fov_y=np.radians(60), idx=index)
        await sched.reconcile(ranked)
```

## Validation & Verification

Verify the scorer and state machine before trusting them under a live camera. The scorer must rank a near, large-error tile above a far, small one and must reject tiles behind the camera:

```python
cam = np.array([583000.0, 4506800.0])              # EPSG:32618, south of the patch
ranked = score_tiles(cam, np.array([0.0, 1.0]),    # looking north (+y)
                     viewport_h=1080, fov_y=np.radians(60), idx=index)
assert ranked[0] == "18N-0-0-0", "nearest high-error tile must rank first"
# A camera looking away (south) should admit nothing in front of it:
empty = score_tiles(cam, np.array([0.0, -1.0]),
                    viewport_h=1080, fov_y=np.radians(60), idx=index)
assert empty.size == 0, "no tile should be admitted when looking away"
```

For the lifecycle, assert no tile ever decodes after cancellation and that a cancelled tile returns to `UNLOADED`:

```python
async def test_cancel_rolls_back():
    sched = PrefetchScheduler(max_concurrent=2)
    await sched.reconcile(np.array(["18N-2-0-0"]))
    await asyncio.sleep(0)                          # let the task enter FETCHING
    await sched.reconcile(np.array([]))             # camera moves: invalidate it
    await asyncio.sleep(0.1)
    assert registry["18N-2-0-0"].status is TileStatus.UNLOADED
```

Expected steady-state values worth logging: concurrent fetches should hover at or below `max_concurrent`; `bytes_resident` should track just under `byte_budget`; and the eviction count per second should be roughly proportional to camera speed. A resident-byte count that climbs monotonically means eviction is not firing — usually because every tile is being marked `VISIBLE` and thus protected.

## Performance & Scale

The priority scorer is the per-frame hot path, so keep it vectorized: scoring 50,000 tiles with the `numpy` formula above runs in well under a millisecond, while the equivalent Python loop would blow the 16 ms frame budget on its own. Pre-cull to the tiles within the current quadtree neighbourhood before scoring rather than scoring the entire dataset — feed `score_tiles` a sliced view of the index, not the whole array, at city scale.

Bandwidth budgeting is the binding constraint in the field. If the link sustains 10 Mbit/s and the average tile is 180 KB, the pipeline can admit roughly 7 tiles per second; setting `max_concurrent` higher than that just fills socket buffers and inflates latency without raising throughput. Size the concurrency cap to `sustained_bandwidth / (avg_tile_bytes × target_fetch_latency)` and let the semaphore enforce it. Pair the byte budget with GPU-side texture compression (KTX2/Basis Universal, ASTC, or ETC2) so the resident-byte accounting in `_evict_if_needed` reflects actual VRAM, not decoded RGBA.

Choose the eviction policy to match navigation pattern. LRU suits free-flying camera tours where the user rarely revisits a tile; LFU suits orbit-and-inspect workflows where a handful of hero tiles are revisited constantly and should survive transient pans. Set the eviction margin to 1.5–2.0× the viewport bounds so a small camera jitter does not evict a tile that is about to be needed again, which is the most common cause of cache thrashing. When the byte budget and bandwidth both saturate, degrade by raising the screen-space-error threshold in `score_tiles` — admit fewer, coarser tiles — rather than dropping frames.

## Failure Modes & Gotchas

- **Visual popping at LOD boundaries.** A tile pops in abruptly because its parent was evicted before the child loaded, leaving a one-frame hole. Keep the parent resident until all four children reach `LOADED`, and never evict a `VISIBLE` tile — the eviction code above filters to `LOADED` for exactly this reason. Geometric-error mismatch with [hierarchical LOD structuring](/lod-management-optimization-strategies/hierarchical-lod-structuring/) makes this worse, since the scorer admits children too early or too late.
- **Cache thrashing under camera jitter.** A camera hovering on a tile boundary repeatedly admits and evicts the same tiles, saturating the link with re-fetches of data that was just dropped. Add hysteresis: a margin between the admission threshold and the eviction threshold (admit at 1 px SSE, evict only below 0.5 px) so a tile must clearly leave relevance before it is dropped.
- **Cancelled fetches that still mutate state.** If a `CancelledError` is swallowed instead of re-raised, the task can fall through to the `LOADED` assignment and leave a ghost tile counted against the byte budget. Always re-raise `CancelledError` after rolling back to `UNLOADED`, as shown in `_fetch`, and account bytes only after a fully validated response.
- **Backpressure that becomes head-of-line blocking.** A single slow origin response holds a semaphore slot, starving higher-priority tiles queued behind it. Bound every fetch with `asyncio.timeout()` (5 s above) so a stalled request releases its slot, and re-score on the next frame rather than waiting on the stalled tile.
- **Mixing EPSG:4326 and EPSG:32618 in scoring.** Feeding the scorer camera coordinates in degrees while tile centres are in metres produces distances around 0 and ranks every tile identically. Reproject the camera to EPSG:32618 once per frame before scoring, and assert the camera ordinate magnitude (UTM eastings are 6-digit metres) to catch the mistake early.

## Frequently Asked Questions

### Should the server prefetch tiles, or leave selection entirely to CesiumJS?

Both, in layers. CesiumJS owns the authoritative selection — its `Cesium3DTileset` decides what to draw from `maximumScreenSpaceError` and the bounding-volume hierarchy. The server-side model here is a warm cache that predicts where the camera is heading and pulls those tiles into edge or origin cache before the client requests them, cutting time-to-first-byte. The two must score against the same `geometricError` values or the prefetch misses.

### LRU or LFU — which eviction policy is right?

Match it to how users navigate. LRU (drop the least recently touched) is the safe default for fly-through tours where tiles are seen once. LFU (drop the least frequently accessed) wins when a few tiles are revisited constantly — an inspector orbiting one building — because it protects those hot tiles through transient pans. A segmented LRU that promotes a tile to a protected tier after its second access captures most of LFU's benefit without its cold-start bias.

### How do I keep client and server tile state in agreement?

Reconcile against the candidate set each frame rather than tracking deltas. The client sends its current viewport; the server recomputes the ranked candidate list and cancels any in-flight fetch not in it — exactly what `reconcile()` does. Because the registry is recomputed from camera state, a dropped telemetry frame or a missed message is self-healing: the next frame reconverges both sides without an explicit resync handshake.

### What happens to in-flight fetches when the camera moves suddenly?

They are cancelled. `reconcile()` diffs the new candidate set against active tasks and calls `task.cancel()` on any tile that left view; the `CancelledError` handler in `_fetch` rolls the record back to `UNLOADED` without decoding the partial payload. This is why the fetch never commits bytes to the budget until after the response is fully validated — a half-downloaded, cancelled tile must leave no trace.

### How small should tiles be for smooth streaming?

Target 100–500 KB per tile payload. Smaller tiles raise request overhead and HTTP round-trips until the connection cap dominates; larger tiles increase the granularity of popping and waste bandwidth when only a corner is visible. Tune the split during [automated tile generation](/lod-management-optimization-strategies/automated-tile-generation/) so the average tile fits a single congestion window, and let the byte budget and concurrency cap here do the rest.

## Related Guides

- [Hierarchical LOD Structuring for Digital Twins](/lod-management-optimization-strategies/hierarchical-lod-structuring/) — the parent/child tile relationships the scorer depends on
- [Implementing Quadtree LOD for Urban Models](/lod-management-optimization-strategies/hierarchical-lod-structuring/implementing-quadtree-lod-for-urban-models/) — building the spatial index that feeds streaming
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — producing the 3D Tiles payloads and metadata this pipeline streams
- [3D Geospatial Fundamentals for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/) — the CRS and mesh contracts streaming assumes upstream

Back to [LOD Management & Optimization Strategies](/lod-management-optimization-strategies/).
