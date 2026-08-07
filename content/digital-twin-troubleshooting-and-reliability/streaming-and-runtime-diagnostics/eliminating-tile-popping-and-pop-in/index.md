# Eliminating tile popping and pop-in during camera movement

This guide removes the visible snap of 3D Tiles appearing or sharpening a beat too late — using velocity-based predictive prefetch, a lower `maximumScreenSpaceError`, an LOD crossfade blend, and cache tuning that keeps tiles warm — with the prefetch set and screen-space error (SSE) math worked in `numpy` against tile centres in EPSG:4978. You hit this the moment a camera moves quickly through a streamed city twin: the renderer only requests a tile once it is already visible, so a fly-through or a fast orbit constantly outruns the request queue and geometry flashes in after the fact.

Popping and pop-in are two faces of the same lag. Popping is a tile going from absent to present in one frame; pop-in is a coarse tile snapping to a finer LOD as its SSE crosses the refinement threshold. Both are cured by requesting geometry earlier and transitioning it more gently. This walkthrough sits under [streaming and runtime diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/), which shows how to instrument the lag; here we fix it.

## Prerequisites

- Python 3.10+ with `numpy` 1.26+ to model the prefetch set and SSE offline before wiring it into the client.
- A served 3D Tiles tileset whose tiles carry a `geometricError` in metres and a centre in **EPSG:4978 (geocentric WGS84, metres)** — the frame the client renders in. Camera pose and velocity must be in the same frame; a velocity logged in a projected CRS such as EPSG:32618 will point the prefetch cone the wrong way.
- Access to the client's per-frame camera state (position and either a velocity vector or the previous position and frame time) and its tile cache size (`cacheBytes` in CesiumJS).
- A rough target frame time — the prefetch horizon is expressed in seconds of look-ahead, so you need to know how long a fetch takes relative to a frame.

## Step-by-Step

### 1. Estimate camera velocity from consecutive poses

If the client does not expose a velocity, derive it from the last two camera positions and the frame delta. Smooth it lightly so a single jittery frame does not swing the prefetch direction.

```python
import numpy as np

def camera_velocity(prev_pos, curr_pos, dt, prev_velocity=None, smoothing=0.6):
    """Metres/second in EPSG:4978, exponentially smoothed."""
    raw = (np.asarray(curr_pos, float) - np.asarray(prev_pos, float)) / max(dt, 1e-3)
    if prev_velocity is None:
        return raw
    return smoothing * np.asarray(prev_velocity, float) + (1 - smoothing) * raw

prev = np.array([1_334_050, -4_651_180, 4_140_120], float)
curr = np.array([1_334_120, -4_651_140, 4_140_180], float)
vel = camera_velocity(prev, curr, dt=1/60)      # ~60 fps frame
print("speed:", round(float(np.linalg.norm(vel)), 1), "m/s")
```

### 2. Extrapolate the predicted pose along the velocity

Project the camera forward by a look-ahead time. Scale the horizon by speed so a fast fly-through warms tiles proportionally further ahead than a slow pan — a fixed distance under-prefetches at speed and over-prefetches at rest.

```python
def predicted_pose(curr_pos, velocity, look_ahead_s=0.8):
    """Where the camera will be after look_ahead_s seconds."""
    return np.asarray(curr_pos, float) + np.asarray(velocity, float) * look_ahead_s

future = predicted_pose(curr, vel, look_ahead_s=0.8)
print("predicted metres ahead:",
      round(float(np.linalg.norm(future - curr)), 1))
```

An 0.6–1.0 s horizon covers the typical time to fetch and decode a tile at broadband speeds; raise it on high-latency links so the request still completes before the tile is needed.

### 3. Build the prefetch set from both poses

Compute SSE against the current pose and the predicted pose, then take the union of tiles that need refinement under either. Tiles that only the predicted pose demands are the prefetch — requested now, before they are strictly visible.

```python
def screen_space_error(geometric_error, distance, viewport_h=1080,
                       fov_y=np.radians(60.0)):
    distance = np.maximum(distance, 1e-3)
    return np.asarray(geometric_error) * viewport_h / (2.0 * distance * np.tan(fov_y / 2.0))

def prefetch_set(tiles, curr_pos, future_pos, max_sse=12.0):
    """Tiles whose SSE exceeds the threshold for the current OR predicted pose."""
    centers = np.array([t["center"] for t in tiles], float)
    err = np.array([t["geometricError"] for t in tiles], float)
    d_now = np.linalg.norm(centers - curr_pos, axis=1)
    d_future = np.linalg.norm(centers - future_pos, axis=1)
    need_now = screen_space_error(err, d_now) > max_sse
    need_future = screen_space_error(err, d_future) > max_sse
    warm_ahead = need_future & ~need_now          # only the predicted pose wants these
    return {
        "visible": [tiles[i]["id"] for i in np.where(need_now)[0]],
        "prefetch": [tiles[i]["id"] for i in np.where(warm_ahead)[0]],
    }

sets = prefetch_set(frame_tiles, curr, future, max_sse=12.0)
print(f"{len(sets['visible'])} visible, {len(sets['prefetch'])} prefetched ahead")
```

<figure class="diagram">
<svg viewBox="-6 21 752 283" role="img" aria-labelledby="tp-sse-t tp-sse-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tp-sse-t">Lowering the screen-space error threshold alone does not fix popping</title>
  <desc id="tp-sse-d">As the maximum screen-space error falls, pop events per minute drop steeply at first and then flatten, while bandwidth climbs without limit. The remaining pops are a latency problem rather than a threshold problem, and only prefetching or a crossfade removes them.</desc>
  <rect class="svg-bg" x="-6" y="21" width="752" height="283" fill="#ffffff"/>
  <path d="M70 56 V216 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="100,80 180,110 260,142 340,168 420,182 500,188 580,190 650,191" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="100,200 180,194 260,184 340,168 420,144 500,110 580,80 650,62" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <path d="M420 56 V222" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="420" y="48" fill="#b0413e" font-size="12" text-anchor="middle">past here you are paying for nothing</text>
  <text x="180" y="132" fill="#4f7a4d" font-size="12" text-anchor="start">pop events / min</text>
  <text x="530" y="140" fill="#c46a3d" font-size="12" text-anchor="middle">bandwidth</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="100" y="238">32</text><text x="180" y="238">24</text><text x="260" y="238">16</text>
    <text x="340" y="238">12</text><text x="420" y="238">8</text><text x="500" y="238">6</text>
    <text x="580" y="238">4</text><text x="650" y="238">2</text>
  </g>
  <text x="380" y="262" fill="#5b6471" font-size="12" text-anchor="middle">maximum screen-space error (pixels)</text>
  <text x="370" y="286" fill="#15384a" font-size="12" text-anchor="middle">The residual pops are tiles arriving late, not tiles chosen wrongly — which is why prefetch and crossfade are the remaining levers</text>
</svg>
<figcaption>Turning the threshold down is the first thing everyone tries and it works, briefly. The flat part of the green curve is where the real fix starts.</figcaption>
</figure>

### 4. Lower the SSE threshold and keep prefetched tiles warm

A lower `maximumScreenSpaceError` refines earlier, so a tile is already resident when it becomes visible. Pair it with a cache large enough that a prefetched tile is not evicted before the camera arrives — size the cache to at least the visible set plus the prefetch set, and mark prefetched tiles as recently used so LRU keeps them.

```python
from collections import OrderedDict

def warm_cache(cache, prefetch_ids, tile_sizes, budget_bytes):
    """Admit prefetched tiles and keep them warm without breaching the budget."""
    resident = sum(tile_sizes[t] for t in cache)
    for tid in prefetch_ids:
        size = tile_sizes[tid]
        while resident + size > budget_bytes and cache:
            old, _ = cache.popitem(last=False)           # evict coldest first
            resident -= tile_sizes[old]
        cache[tid] = True
        cache.move_to_end(tid)                           # freshly warmed
        resident += size
    return resident

cache = OrderedDict()
used = warm_cache(cache, sets["prefetch"], tile_sizes, budget_bytes=1_536*1024*1024)
print(f"warm cache holds {len(cache)} tiles, {used/1e6:.0f} MB resident")
```

Lowering `maximumScreenSpaceError` from 16 to about 10–12 measurably cuts pop-in but raises the tile count, which is exactly why the prefetch set uses the same lower threshold — the two dials must agree or you refine tiles you never warmed.

### 5. Crossfade the LOD transition on arrival

Even with a warm tile ready, swapping a coarse tile for a fine one in a single frame is a visible pop. Ramp an alpha over a few frames so the finer LOD fades in over its parent, and only free the parent once the blend completes.

```python
def crossfade_alpha(frames_since_load, blend_frames=8):
    """Linear 0->1 opacity ramp for the incoming finer LOD."""
    return float(np.clip(frames_since_load / blend_frames, 0.0, 1.0))

for f in range(0, 10):
    a = crossfade_alpha(f, blend_frames=8)
    parent_alpha = 1.0 - a                     # coarse tile fades out as child fades in
    if a >= 1.0:
        parent_alpha = 0.0                     # safe to release the parent now
    print(f"frame {f}: child {a:.2f}, parent {parent_alpha:.2f}")
```

<figure class="diagram">
<svg viewBox="6 16 808 266" role="img" aria-labelledby="pop-t pop-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pop-t">Velocity-based predictive prefetch feeding a warm cache and crossfade</title>
  <desc id="pop-d">The camera pose and velocity extrapolate a predicted future pose; the current pose yields the current visible set and the predicted pose yields the predicted visible set, whose union warms the cache, and arriving tiles are crossfaded to avoid a visible pop.</desc>
  <rect class="svg-bg" x="6" y="16" width="808" height="266" fill="#ffffff"/>
  <defs>
    <marker id="pop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pop-arrow)">
    <line x1="172" y1="150" x2="206" y2="150"/>
    <line x1="372" y1="138" x2="416" y2="66"/>
    <line x1="372" y1="162" x2="416" y2="234"/>
    <line x1="592" y1="66" x2="626" y2="138"/>
    <line x1="592" y1="234" x2="626" y2="162"/>
    <line x1="715" y1="185" x2="715" y2="208"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="20" y="115" width="152" height="70" rx="8"/>
    <rect x="210" y="115" width="162" height="70" rx="8"/>
  </g>
  <rect x="418" y="30" width="172" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="418" y="204" width="172" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="630" y="115" width="170" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="630" y="210" width="170" height="54" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="96" y="145"><tspan x="96" dy="0">Camera pose</tspan><tspan x="96" dy="16">+ velocity</tspan></text>
    <text x="291" y="145"><tspan x="291" dy="0">Extrapolate</tspan><tspan x="291" dy="16">pose t + Δt</tspan></text>
    <text x="504" y="67">Predicted visible set</text>
    <text x="504" y="241">Current visible set</text>
    <text x="715" y="146"><tspan x="715" dy="0">Prefetch union</tspan><tspan x="715" dy="16">warm cache</tspan></text>
    <text x="715" y="241">Crossfade on arrival</text>
  </g>
</svg>
<figcaption>Velocity extrapolation produces a predicted visible set; its union with the current set warms the cache ahead of time, and a crossfade smooths each LOD swap on arrival.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="-21 25 782 269" role="img" aria-labelledby="tp-fade-t tp-fade-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tp-fade-t">A crossfade turns one visible frame into twelve invisible ones</title>
  <desc id="tp-fade-d">Swapping level of detail in a single frame produces a step change the eye reads as a pop. Ramping the outgoing tile's opacity down and the incoming tile's up over about twelve frames spreads the same change across two hundred milliseconds, below the threshold at which it registers as an event.</desc>
  <rect class="svg-bg" x="-21" y="25" width="782" height="269" fill="#ffffff"/>
  <path d="M70 60 V196 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="90,74 300,74 300,190 660,190" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="90,190 260,190 380,74 660,74" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M260 60 V200 M380 60 V200" fill="none" stroke="#e6e0d4" stroke-width="1.5" stroke-dasharray="4 4"/>
  <text x="320" y="52" fill="#5b6471" font-size="12" text-anchor="middle">12 frames ≈ 200 ms</text>
  <text x="160" y="66" fill="#b0413e" font-size="12" text-anchor="middle">outgoing LOD</text>
  <text x="560" y="66" fill="#4f7a4d" font-size="12" text-anchor="middle">incoming LOD</text>
  <text x="44" y="80" fill="#5b6471" font-size="11.5" text-anchor="middle">1.0</text>
  <text x="44" y="194" fill="#5b6471" font-size="11.5" text-anchor="middle">0.0</text>
  <text x="380" y="226" fill="#5b6471" font-size="12" text-anchor="middle">frames</text>
  <text x="370" y="256" fill="#15384a" font-size="12.5" text-anchor="middle">Both tiles are resident during the ramp, so a crossfade costs memory for its duration — budget for it rather than being surprised</text>
  <text x="370" y="276" fill="#5b6471" font-size="12" text-anchor="middle">Skip the fade when the reader has asked for reduced motion; an instant swap is preferable to a ramp they did not want</text>
</svg>
<figcaption>The fade does not make the transition better; it makes it slower than the eye&#39;s change-detection threshold. That is a different and much cheaper goal.</figcaption>
</figure>

## Expected Output & Verification

Verify the prefetch actually leads the camera and the crossfade reaches full opacity. A correct prefetch set is non-empty while moving and collapses to zero at rest; the alpha ramp must hit 1.0 by the blend length.

```python
# At rest, velocity is ~0, so nothing should be prefetched.
still_future = predicted_pose(curr, np.zeros(3), look_ahead_s=0.8)
still = prefetch_set(frame_tiles, curr, still_future, max_sse=12.0)
assert still["prefetch"] == [], "no prefetch expected when stationary"

# While moving, some tiles are warmed ahead of visibility.
assert len(sets["prefetch"]) > 0, "expected prefetch during motion"

# The crossfade completes.
assert crossfade_alpha(8, blend_frames=8) == 1.0
print("prefetch and crossfade verified")
```

```text
speed: 5.2 m/s
predicted metres ahead: 4.2
18 visible, 6 prefetched ahead
warm cache holds 24 tiles, 512 MB resident
prefetch and crossfade verified
```

Measure pop events rather than judging them by eye. Counting the frames in which a rendered tile's level changed, and logging the rate per minute of camera motion, turns "does this look better" into a number that survives a code review and a change of reviewer.

## Common Errors

**`ValueError: operands could not be broadcast together with shapes (3,) (n,3)`.** The camera position was passed as a list of scalars while tile centres are an `(n, 3)` array, or the two are in different coordinate frames. Force both to `np.asarray(..., float)` and confirm the camera and tile centres are both EPSG:4978 before subtracting; a camera left in EPSG:32618 metres will not broadcast cleanly and, even if it did, would compute nonsense distances.

**Prefetch fires but tiles still pop.** The look-ahead is shorter than the fetch time, so the request completes after the tile is already visible. Measure the actual round-trip for a tile and set `look_ahead_s` above it; on a high-latency connection 0.8 s is often too short, and the horizon must exceed fetch latency plus decode time.

**Crossfade flickers or the parent disappears early.** The parent tile is released before the child reaches alpha 1.0, leaving a one-frame hole. Gate the parent release on `crossfade_alpha(...) >= 1.0` rather than on the child merely starting to load, so the coarse geometry covers the transition until the finer LOD is fully opaque.

**Prefetched tiles are evicted before the camera reaches them.** The cache is too small for the working set plus the prefetch horizon, so an LRU pass drops a warmed tile to admit a currently visible one and the pop returns despite the prefetch. Size the cache to at least the visible set plus the predicted set, and shorten the look-ahead if the budget genuinely cannot hold both — prefetching further than the cache can retain only wastes bandwidth re-fetching tiles you already warmed.

## Related Guides

- [Streaming & Runtime Diagnostics for 3D Tiles](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) — instrumenting pop latency and the request queue this fix targets
- [Streaming Sync Patterns for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) — the prefetch and eviction model in its rendering context
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — producing the geometricError that drives SSE and refinement

Back to [Streaming & Runtime Diagnostics for 3D Tiles](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
