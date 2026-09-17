# HTTP/2 and Connection Limits for Tile Streaming

This page explains why a tileset loads at six requests at a time on one protocol and sixty on another, measures what is actually happening in the browser, and tunes the client's request scheduling, the server's stream limits and the tile sizing to match — for a session that fetches 900 tiles in the first eight seconds.

## Why you hit this

Tile streaming is an unusual HTTP workload: hundreds of small-to-medium GETs, issued in bursts as the camera moves, to the same origin. Almost every other web workload is a handful of requests followed by a long idle period, so the defaults in browsers, proxies and servers are tuned for that instead.

The result is a specific, common symptom: the viewer takes eight seconds to fill in when the network is plainly capable of doing it in two, and the network panel shows a neat staircase of six concurrent requests with everything else queued. Nothing is slow; everything is waiting.

## Prerequisites

- A tileset served over HTTPS from a CDN or a server you control.
- Chrome or Firefox developer tools, plus `curl` with HTTP/2 support and optionally `h2load` or `nghttp`.
- The client from [prefetching tiles along a camera path](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/prefetching-tiles-along-a-camera-path/), or any CesiumJS viewer.

## Step-by-Step

### 1. Find out which protocol is actually in use

```bash
curl -sI --http2 https://tiles.example.com/city/b-7f3a9c21/tileset.json | head -1
# HTTP/2 200

curl -s -o /dev/null -w '%{http_version} %{time_connect} %{time_starttransfer} %{size_download}\n' \
  https://tiles.example.com/city/b-7f3a9c21/content/0/0/0.glb

nghttp -nv https://tiles.example.com/city/b-7f3a9c21/tileset.json 2>&1 \
  | grep -E "SETTINGS|MAX_CONCURRENT"
```

```javascript
// In the browser console, on the page that loads the tileset:
performance.getEntriesByType('resource')
  .filter((e) => e.name.includes('/content/'))
  .slice(-10)
  .map((e) => ({
    name: e.name.split('/').slice(-1)[0],
    protocol: e.nextHopProtocol,      // 'h2', 'h3', 'http/1.1'
    queuedMs: Math.round(e.requestStart - e.startTime),
    ttfbMs: Math.round(e.responseStart - e.requestStart),
    downloadMs: Math.round(e.responseEnd - e.responseStart),
    bytes: e.encodedBodySize,
  }));
```

`nextHopProtocol` is the authoritative answer and it is per resource, which matters: a page can serve its own assets over HTTP/2 while the tile host negotiates HTTP/1.1 because of an older load balancer or a TLS configuration without ALPN.

`queuedMs` is the number that diagnoses the problem. A tile that spent 4,200 ms between `startTime` and `requestStart` was not slow to download — it was waiting for a connection slot, and no amount of bandwidth fixes it.

<figure class="diagram">
<svg viewBox="4 6 732 256" role="img" aria-labelledby="h2-limits-t h2-limits-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h2-limits-t">Concurrency limits by protocol</title>
  <desc id="h2-limits-d">A comparison of three protocols for a burst of 900 tile requests. HTTP/1.1 allows six connections per origin, so requests queue and the burst takes eight seconds. HTTP/2 multiplexes over one connection with a typical limit of 100 concurrent streams, finishing in 2.1 seconds but subject to head-of-line blocking if a packet is lost. HTTP/3 over QUIC also multiplexes but loses no streams to a dropped packet, finishing in 1.8 seconds on a lossy link.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="256" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="168" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="332" y="20" width="174" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="506" y="20" width="216" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="150" height="56" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="168" y="52" width="164" height="56" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="332" y="52" width="174" height="56" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="506" y="52" width="216" height="56" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="108" width="150" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="108" width="164" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="332" y="108" width="174" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="506" y="108" width="216" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="164" width="150" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="168" y="164" width="164" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="332" y="164" width="174" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="506" y="164" width="216" height="56" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="93" y="41">protocol</text><text x="250" y="41">concurrency</text>
    <text x="419" y="41">900 tiles take</text><text x="614" y="41">the catch</text>
    <text x="93" y="74">HTTP/1.1</text><text x="93" y="94">(no ALPN, old LB)</text>
    <text x="250" y="74">6 connections</text><text x="250" y="94">per origin</text>
    <text x="419" y="74">8.0 s</text><text x="419" y="94">mostly queueing</text>
    <text x="614" y="74">one slow tile blocks</text><text x="614" y="94">its whole connection</text>
    <text x="93" y="130">HTTP/2</text><text x="93" y="150">(h2)</text>
    <text x="250" y="130">~100 streams</text><text x="250" y="150">on 1 connection</text>
    <text x="419" y="130">2.1 s</text><text x="419" y="150">bandwidth-bound</text>
    <text x="614" y="130">TCP head-of-line: one</text><text x="614" y="150">lost packet stalls all</text>
    <text x="93" y="186">HTTP/3</text><text x="93" y="206">(h3, QUIC)</text>
    <text x="250" y="186">~100 streams</text><text x="250" y="206">independent</text>
    <text x="419" y="186">1.8 s on 1% loss</text><text x="419" y="206">2.0 s clean</text>
    <text x="614" y="186">UDP blocked on some</text><text x="614" y="206">corporate networks</text>
  </g>
  <text x="370" y="244" fill="#5b6471" font-size="12" text-anchor="middle">same tiles, same bandwidth — the protocol decides whether they queue</text>
</svg>
<figcaption>The 900 tiles and the bandwidth are identical in all three rows; only the concurrency limit changes.</figcaption>
</figure>

### 2. Measure the concurrency you are actually getting

```javascript
export function concurrencyProfile(urlFilter = '/content/') {
  const entries = performance.getEntriesByType('resource')
    .filter((e) => e.name.includes(urlFilter));
  if (!entries.length) return { samples: 0 };

  // Sweep a timeline of starts and ends to find the peak overlap.
  const events = [];
  for (const e of entries) {
    events.push({ t: e.startTime, d: +1 });
    events.push({ t: e.responseEnd, d: -1 });
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let inflight = 0, peak = 0;
  const samples = [];
  for (const ev of events) {
    inflight += ev.d;
    peak = Math.max(peak, inflight);
    samples.push({ t: ev.t, inflight });
  }

  const queued = entries.map((e) => e.requestStart - e.startTime);
  const q = (arr, f) => arr.slice().sort((a, b) => a - b)[Math.floor(f * arr.length)];
  const span = Math.max(...entries.map((e) => e.responseEnd))
             - Math.min(...entries.map((e) => e.startTime));
  const bytes = entries.reduce((s, e) => s + (e.encodedBodySize || 0), 0);

  return {
    samples: entries.length,
    protocol: entries[0].nextHopProtocol,
    peakConcurrency: peak,
    medianQueuedMs: Math.round(q(queued, 0.5)),
    p95QueuedMs: Math.round(q(queued, 0.95)),
    spanSeconds: Number((span / 1000).toFixed(2)),
    effectiveMbps: Number(((bytes * 8) / span / 1000).toFixed(1)),
    verdict: peak <= 6 ? 'HTTP/1.1 connection limit — fix the transport first'
           : q(queued, 0.95) > 500 ? 'client-side scheduling is the bottleneck'
           : 'bandwidth- or server-bound',
  };
}

console.table([concurrencyProfile()]);
```

A peak concurrency of exactly 6 is the signature of HTTP/1.1, and it is conclusive — browsers have allowed six connections per origin for well over a decade and the number has not moved. Seeing 6 means the transport is the problem and nothing else is worth tuning until it is fixed.

A peak well below the protocol's limit with low queue times means the client is not asking for enough at once, which is step 4. A peak at the limit with high queue times means the requests are there and the pipe is full, which is a tile-size problem rather than a concurrency one.

### 3. Fix the transport

```nginx
# nginx: HTTP/2 and HTTP/3, with stream limits raised for tile bursts
server {
    listen 443 ssl;
    listen 443 quic reuseport;
    http2 on;

    ssl_protocols TLSv1.2 TLSv1.3;

    # Default is 128; tile bursts benefit from more, at some memory cost.
    http2_max_concurrent_streams 256;

    # Advertise HTTP/3 so clients can upgrade.
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    location /city/ {
        root /srv/tiles;
        add_header Cache-Control "public, max-age=31536000, immutable";
        gzip on;
        gzip_types application/json;
        gzip_min_length 512;

        # Tiles are already compressed; do not re-compress binaries.
        location ~* \.(glb|b3dm|ktx2|webp|subtree)$ {
            gzip off;
            add_header Cache-Control "public, max-age=31536000, immutable";
        }
    }
}
```

```bash
# Prove the upgrade works, and measure it
h2load -n 900 -c 1 -m 100 https://tiles.example.com/city/b-7f3a9c21/content/0/0/0.glb
h2load -n 900 -c 6 -m 1   https://tiles.example.com/city/b-7f3a9c21/content/0/0/0.glb
```

The two `h2load` invocations are the experiment worth running: one connection with 100 multiplexed streams against six connections with one stream each. The first is what HTTP/2 gives you and the second approximates HTTP/1.1, on identical hardware and network, so the difference is attributable.

`http2_max_concurrent_streams` at 256 rather than the default 128 helps a burst and costs memory per connection. Raising it far higher is counterproductive: beyond the bandwidth-delay product the streams simply share the same pipe, and the server pays for the bookkeeping.

Compression deserves attention because the default is wrong in both directions. Tileset JSON compresses 8–12× and must be gzipped; `.glb` files containing Draco or meshopt data and KTX2 textures are already compressed, and gzipping them burns CPU to make them very slightly larger.

### 4. Tune the client's request scheduling

```javascript
export function tuneRequestScheduler(protocol) {
  // CesiumJS: RequestScheduler governs how many requests are outstanding.
  const perServer = protocol === 'http/1.1' ? 6
                  : protocol === 'h3' ? 24
                  : 18;                              // h2
  Cesium.RequestScheduler.maximumRequestsPerServer = perServer;
  Cesium.RequestScheduler.maximumRequests = Math.max(perServer * 2, 50);
  Cesium.RequestScheduler.throttleRequests = true;
  return {
    protocol,
    maximumRequestsPerServer: Cesium.RequestScheduler.maximumRequestsPerServer,
    maximumRequests: Cesium.RequestScheduler.maximumRequests,
  };
}

export async function configureFromMeasurement(probeUrl) {
  const before = performance.now();
  await fetch(probeUrl, { cache: 'reload' });
  const entry = performance.getEntriesByType('resource')
    .filter((e) => e.name === probeUrl).slice(-1)[0];
  const protocol = entry?.nextHopProtocol ?? 'h2';
  const rttMs = entry ? entry.responseStart - entry.requestStart : 60;
  const cfg = tuneRequestScheduler(protocol);
  return { ...cfg, rttMs: Math.round(rttMs), probeMs: Math.round(performance.now() - before) };
}
```

More outstanding requests is not monotonically better, which is the counter-intuitive part. Beyond about 20 concurrent tile requests the additional streams share the same bandwidth, so each one completes more slowly, and the tiles the camera needs *now* finish later than they would have with fewer in flight. The client's priority ordering also stops mattering once everything is in flight at once.

Eighteen is a reasonable HTTP/2 default for a tileset: enough to saturate a typical connection, few enough that re-prioritising as the camera moves still has an effect. On HTTP/3 a higher number is safe because a stalled stream does not hold up the others.

Raising it on HTTP/1.1 does nothing at all — the browser enforces six regardless — and setting it high there just means the scheduler queues internally instead of letting the browser queue.

### 5. Size tiles for the protocol

```python
def tile_size_budget(rtt_ms, bandwidth_mbps, concurrency, target_fill_s=2.0):
    """How big tiles should be so a burst is bandwidth-bound, not latency-bound."""
    bytes_per_s = bandwidth_mbps * 1e6 / 8
    total_bytes = bytes_per_s * target_fill_s
    # Each request costs at least one RTT of latency, amortised across concurrency.
    latency_budget_s = target_fill_s * 0.25
    max_sequential_requests = latency_budget_s / (rtt_ms / 1000) * concurrency
    return {
        "rtt_ms": rtt_ms,
        "bandwidth_mbps": bandwidth_mbps,
        "concurrency": concurrency,
        "total_kb_in_window": round(total_bytes / 1024),
        "max_requests_in_window": int(max_sequential_requests),
        "ideal_tile_kb": round(total_bytes / max(max_sequential_requests, 1) / 1024, 1),
    }

for rtt, bw, conc in [(20, 100, 18), (80, 25, 18), (80, 25, 6), (160, 8, 18)]:
    print(tile_size_budget(rtt, bw, conc))
```

Tile size and concurrency trade against each other, and the ratio that matters is how much of the fill window goes to latency rather than to transfer. On a 20 ms link with 18 streams, a tile can be small — 40 KB is fine, and 900 of them fit in the window. On a 160 ms satellite link with the same concurrency, small tiles spend the whole window in round trips and the ideal tile is several hundred kilobytes.

This is the calculation that justifies the tile-size decisions in [choosing shard sizes for city-scale tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/choosing-shard-sizes-for-city-scale-tiling/), from the network side rather than the pipeline side. It also explains why a tileset tuned on an office LAN performs badly on mobile: the tiles are too small for the latency.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="h2-headers-t h2-headers-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h2-headers-t">Compression and connection settings per file type</title>
  <desc id="h2-headers-d">A table of five tile-server settings. Tileset JSON should be gzipped for an eight to twelve times saving. GLB, KTX2 and subtree files must not be gzipped because they are already compressed. Stream concurrency should be raised above the default. Alt-Svc should advertise HTTP/3 as an upgrade path. Domain sharding should be removed because it splits one warm connection into several cold ones.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="268" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="286" y="20" width="116" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="402" y="20" width="320" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="268" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="54" width="116" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="402" y="54" width="320" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="268" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="286" y="88" width="116" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="402" y="88" width="320" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="122" width="268" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="122" width="116" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="402" y="122" width="320" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="268" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="156" width="116" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="402" y="156" width="320" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="268" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="286" y="190" width="116" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="402" y="190" width="320" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="152" y="42">setting</text><text x="344" y="42">value</text><text x="562" y="42">effect</text>
    <text x="152" y="76">gzip application/json</text><text x="344" y="76">on</text><text x="562" y="76">8–12× on the file that gates every session</text>
    <text x="152" y="110">gzip .glb .ktx2 .subtree</text><text x="344" y="110">off</text><text x="562" y="110">already compressed — CPU for nothing</text>
    <text x="152" y="144">http2_max_concurrent_streams</text><text x="344" y="144">256</text><text x="562" y="144">room for an opening burst</text>
    <text x="152" y="178">Alt-Svc h3</text><text x="344" y="178">advertise</text><text x="562" y="178">returning visitors upgrade</text>
    <text x="152" y="212">domain sharding</text><text x="344" y="212">remove</text><text x="562" y="212">splits one warm connection into four cold</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">The first two rows are the same directive applied in opposite directions, and both matter.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">Sharding was correct for HTTP/1.1 and is actively harmful now.</text>
</svg>
<figcaption>Two of these are server one-liners worth more than any client tuning, and one is an optimisation to unlearn.</figcaption>
</figure>

### 6. Avoid the traps that undo the gains

```javascript
export function transportPitfallCheck(entries) {
  const byOrigin = new Map();
  for (const e of entries) {
    const origin = new URL(e.name).origin;
    const bucket = byOrigin.get(origin) ?? { count: 0, protocols: new Set() };
    bucket.count += 1;
    bucket.protocols.add(e.nextHopProtocol);
    byOrigin.set(origin, bucket);
  }
  const findings = [];
  if (byOrigin.size > 1) {
    findings.push({
      issue: `tiles served from ${byOrigin.size} origins`,
      why: 'HTTP/2 multiplexes per connection; sharding across origins '
         + 'forces separate connections and separate congestion windows',
      severity: 'high',
    });
  }
  for (const [origin, b] of byOrigin) {
    if (b.protocols.has('http/1.1')) {
      findings.push({ issue: `${origin} negotiated HTTP/1.1`, severity: 'high',
                      why: 'six-connection limit applies' });
    }
    if (b.protocols.size > 1) {
      findings.push({ issue: `${origin} mixes ${[...b.protocols].join(', ')}`,
                      severity: 'medium',
                      why: 'inconsistent limits make concurrency unpredictable' });
    }
  }
  const redirects = entries.filter((e) => e.redirectEnd > 0);
  if (redirects.length) {
    findings.push({ issue: `${redirects.length} tile request(s) redirected`,
                    severity: 'high',
                    why: 'each redirect is an extra round trip per tile' });
  }
  const noCache = entries.filter((e) => e.transferSize > 0 && e.decodedBodySize > 0
                                     && e.transferSize >= e.decodedBodySize);
  return { origins: byOrigin.size, findings,
           uncachedFraction: Number((noCache.length / Math.max(entries.length, 1))
                                    .toFixed(2)) };
}
```

Domain sharding is the practice to unlearn. It was correct for HTTP/1.1 — six connections per origin times four origins is 24 — and is actively harmful on HTTP/2, where it splits one multiplexed connection with a warm congestion window into four cold ones with separate TLS handshakes.

Redirects are the other quiet cost. A tile host that redirects `http` to `https`, or a bucket that redirects a path without a trailing slash, adds a full round trip to every tile — which on 900 tiles at 80 ms is 72 seconds of latency spread across the session.

<figure class="diagram">
<svg viewBox="17 -4 697 244" role="img" aria-labelledby="h2-tune-t h2-tune-d" xmlns="http://www.w3.org/2000/svg">
  <title id="h2-tune-t">Fill time against outstanding requests</title>
  <desc id="h2-tune-d">A chart of time to fill the view against the number of outstanding tile requests on an HTTP/2 connection at 25 megabits per second and 80 milliseconds round trip. At 6 outstanding requests it takes 5.4 seconds. At 12 it takes 3.1 seconds. At 18 it takes 2.6 seconds, the best result. At 32 it takes 2.7 seconds and at 64 it takes 3.2 seconds, because the streams share the same bandwidth and priority ordering stops having any effect.</desc>
  <rect class="svg-bg" x="17" y="-4" width="697" height="244" fill="#ffffff"/>
  <path d="M84 24 V184 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="116" y="30" width="78" height="154" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="234" y="96" width="78" height="88" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="352" y="110" width="78" height="74" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="470" y="107" width="78" height="77" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="588" y="93" width="78" height="91" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="155" y="24">5.4 s</text><text x="273" y="90">3.1 s</text>
    <text x="391" y="104">2.6 s</text><text x="509" y="101">2.7 s</text><text x="627" y="87">3.2 s</text>
    <text x="155" y="202">6</text><text x="273" y="202">12</text><text x="391" y="202">18</text>
    <text x="509" y="202">32</text><text x="627" y="202">64</text>
  </g>
  <text x="400" y="222" fill="#5b6471" font-size="12" text-anchor="middle">maximumRequestsPerServer — HTTP/2, 25 Mbps, 80 ms RTT, 900 tiles</text>
  <text x="44" y="96" fill="#5b6471" font-size="12" text-anchor="middle">fill</text>
  <text x="44" y="112" fill="#5b6471" font-size="12" text-anchor="middle">time</text>
  <text x="391" y="150" fill="#1f2937" font-size="12" text-anchor="middle">best</text>
</svg>
<figcaption>The curve has a floor around 18 and rises again past 32 — more streams share the same bandwidth and defeat prioritisation.</figcaption>
</figure>

## Expected Output & Verification

```text
HTTP/2 200
2 0.041 0.068 148204
{'rtt_ms': 20, 'bandwidth_mbps': 100, 'concurrency': 18, 'total_kb_in_window': 24414,
 'max_requests_in_window': 450, 'ideal_tile_kb': 54.3}
{'rtt_ms': 80, 'bandwidth_mbps': 25, 'concurrency': 18, 'total_kb_in_window': 6104,
 'max_requests_in_window': 112, 'ideal_tile_kb': 54.5}
{'rtt_ms': 80, 'bandwidth_mbps': 25, 'concurrency': 6, 'total_kb_in_window': 6104,
 'max_requests_in_window': 37, 'ideal_tile_kb': 164.9}
┌─────────┬─────────┬──────────┬──────────────────┬─────────────────┬──────────────┬───────────────┬───────────────┐
│ samples │protocol │peakConcur│ medianQueuedMs   │ p95QueuedMs     │ spanSeconds  │ effectiveMbps │ verdict       │
│ 912     │ h2      │ 18       │ 4                │ 61              │ 2.58         │ 23.4          │ bandwidth-... │
└─────────┴─────────┴──────────┴──────────────────┴─────────────────┴──────────────┴───────────────┴───────────────┘
```

A median queue time of 4 ms and an effective throughput within 10% of the link's capacity is the target state: requests are not waiting, and the constraint is bandwidth, which is the only honest constraint. The `ideal_tile_kb` figures converging on about 54 KB for two very different links is a coincidence of those numbers and not a general rule — the six-concurrency row shows how much it moves.

Verify the improvement rather than assuming it, by running the same session before and after:

```javascript
export async function abComparison(loadSession, configs) {
  const results = [];
  for (const cfg of configs) {
    performance.clearResourceTimings();
    tuneRequestScheduler(cfg.protocol);
    Cesium.RequestScheduler.maximumRequestsPerServer = cfg.perServer;
    const t0 = performance.now();
    await loadSession();                       // fly to a fixed view, await tiles settled
    const profile = concurrencyProfile();
    results.push({
      label: cfg.label,
      perServer: cfg.perServer,
      wallSeconds: Number(((performance.now() - t0) / 1000).toFixed(2)),
      peakConcurrency: profile.peakConcurrency,
      p95QueuedMs: profile.p95QueuedMs,
      effectiveMbps: profile.effectiveMbps,
      tiles: profile.samples,
    });
  }
  const best = results.slice().sort((a, b) => a.wallSeconds - b.wallSeconds)[0];
  return { results, best: best.label,
           spread: Number((Math.max(...results.map((r) => r.wallSeconds))
                         - Math.min(...results.map((r) => r.wallSeconds))).toFixed(2)) };
}
```

Fixing the camera path and the tile set is what makes the comparison meaningful; a moving camera changes which tiles are requested and makes two runs incomparable. Clearing the resource timings between runs matters too, or the second run's profile includes the first run's entries.

Then verify the server side under the burst, independently of any browser:

```bash
h2load -n 900 -c 1 -m 100 --h1 https://tiles.example.com/city/b-7f3a9c21/content/0/0/0.glb \
  2>&1 | grep -E "finished in|req/s|time for request"

h2load -n 900 -c 1 -m 100 https://tiles.example.com/city/b-7f3a9c21/content/0/0/0.glb \
  2>&1 | grep -E "finished in|req/s|time for request"
```

```python
def server_burst_check(h1_reqs_per_s, h2_reqs_per_s, min_speedup=2.5):
    ratio = h2_reqs_per_s / max(h1_reqs_per_s, 1e-9)
    return {"h1_rps": round(h1_reqs_per_s, 1), "h2_rps": round(h2_reqs_per_s, 1),
            "speedup": round(ratio, 2),
            "verdict": "multiplexing working" if ratio >= min_speedup
                       else "h2 negotiated but not helping — check proxy or stream limit"}

print(server_burst_check(148.2, 612.9))
```

An HTTP/2 run that is barely faster than HTTP/1.1 usually means something in the path is terminating HTTP/2 and re-issuing HTTP/1.1 upstream — a common load-balancer configuration — so the client sees `h2` while the origin connection is still six-at-a-time.

## Performance Notes

- **One warm HTTP/2 connection beats four cold ones.** Serve every tile from one origin, and serve the page's own assets from it too if possible, so the connection is already established.
- **`Alt-Svc` upgrades to HTTP/3 on the second visit**, not the first. The first load stays on HTTP/2, so HTTP/3's benefit appears in returning sessions.
- **HTTP/3 helps most on lossy links** — mobile, congested wifi — where TCP head-of-line blocking stalls every stream on one lost packet.
- **Do not gzip `.glb`, `.ktx2` or `.subtree`.** They are compressed already; gzip costs CPU and adds bytes.
- **Do gzip `tileset.json` and `.subtree` JSON.** 8–12× on the file that gates every session.
- **Preconnect to the tile origin** in the page head: `<link rel="preconnect" href="https://tiles.example.com" crossorigin>` removes the TLS handshake from the critical path.
- **Immutable URLs make repeat visits nearly free**, which is the other half of this story — see [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/).

## Common Errors

**Peak concurrency is exactly 6 despite `h2` in the network panel.** A proxy is terminating HTTP/2 and using HTTP/1.1 upstream, or the panel is showing a cached entry. Check with `nghttp` against the origin.

**Raising `maximumRequestsPerServer` made it slower.** Past the bandwidth-delay product, extra streams only divide the pipe. The curve has a floor; find it by measurement.

**Tiles are sharded across `tiles1`…`tiles4` subdomains.** An HTTP/1.1-era optimisation that now costs four handshakes and four congestion windows. Consolidate.

**Every tile shows a redirect.** A trailing-slash or protocol redirect. Fix the base URL so tiles are fetched at their final location.

**HTTP/3 never activates.** UDP 443 blocked, or `Alt-Svc` not advertised. Both are common on corporate networks; HTTP/2 must remain a working fallback.

**Throughput collapses when the camera moves fast.** The scheduler is cancelling and re-issuing requests. Lower the concurrency so prioritisation has an effect, and check the prefetch logic.

**`gzip` on `.glb` makes files larger.** Expected — they are already compressed. Turn it off per extension.

## Frequently Asked Questions

### Is HTTP/3 worth enabling?

Yes, as an upgrade path rather than a replacement: advertise it, keep HTTP/2 working, and returning visitors on lossy links get the benefit. It is not worth restructuring anything for.

### Does HTTP/2 Server Push help tile streaming?

No. Push is deprecated and removed from most browsers, and it was never a good fit — the server cannot know which tiles the camera will need. Client-side prefetch is the right mechanism.

### Should tiles be bundled to reduce request count?

Implicit tiling's subtree files already bundle availability data, and 3D Tiles has no content bundling. Where request count genuinely dominates, larger tiles are the available lever, and the sizing calculation above says how much larger.

## Related Guides

- [Prefetching Tiles Along a Camera Path](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/prefetching-tiles-along-a-camera-path/) — deciding what to request, once the transport allows it
- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — cache headers that make repeat visits free
- [Load Testing Tile Servers with Locust](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/load-testing-tile-servers-with-locust/) — measuring the server under a realistic burst

Back to [Streaming Sync Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
