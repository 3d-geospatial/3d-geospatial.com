# Load Testing Tile Servers with Locust

This page load-tests a 3D Tiles server with Locust using a request pattern that resembles what viewers actually do — bursts of tile requests driven by simulated camera movement, a realistic mix of cache hits and misses, correct HTTP/2 concurrency — and reads the result as a capacity number with a stated confidence rather than a requests-per-second figure nobody can act on.

## Why you hit this

A tile server's load profile is unlike a web application's. A session opens with a burst of 400 requests in two seconds, goes quiet while the user reads the map, then bursts again when they pan. Average throughput is meaningless; what matters is whether the burst is served inside the user's patience, and whether the burst from the hundredth concurrent user is served as fast as the first.

Load testing with a flat request rate measures something the server never experiences. The number it produces — "4,200 requests per second" — cannot answer "how many concurrent users can we support?", which is the only question anyone is asking.

## Prerequisites

- Python 3.10+ with `locust>=2.29`; the tile server reachable from the load generator.
- A tileset's URL and a way to enumerate real tile paths — the manifest from [resuming failed tiling runs from checkpoints](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/resuming-failed-tiling-runs-from-checkpoints/), or a crawl of the tileset JSON.
- A load generator with more bandwidth than the server's expected capacity, or the test measures the generator.

## Step-by-Step

### 1. Enumerate real tile paths with their sizes

```python
# tilepaths.py
import json
import random
from collections import defaultdict
from pathlib import Path

import requests

def crawl_tileset(base_url, tileset_path="tileset.json", max_tiles=20_000,
                  session=None):
    """Walk the tileset tree and collect content URIs with their depth."""
    session = session or requests.Session()
    root = session.get(f"{base_url}/{tileset_path}", timeout=30)
    root.raise_for_status()
    doc = root.json()

    tiles, external = [], []

    def recurse(tile, depth, prefix):
        uri = (tile.get("content") or {}).get("uri")
        if uri:
            full = uri if uri.startswith("http") else f"{prefix}/{uri}".replace("//", "/")
            if uri.endswith(".json"):
                external.append((full, depth))
            else:
                tiles.append({"path": full, "depth": depth,
                              "geometric_error": tile.get("geometricError")})
        for child in tile.get("children") or []:
            recurse(child, depth + 1, prefix)

    recurse(doc["root"], 0, base_url.rstrip("/"))
    for url, depth in external[:200]:
        try:
            sub = session.get(url, timeout=30)
            sub.raise_for_status()
            recurse(sub.json()["root"], depth, url.rsplit("/", 1)[0])
        except Exception:
            continue
        if len(tiles) >= max_tiles:
            break

    by_depth = defaultdict(list)
    for t in tiles[:max_tiles]:
        by_depth[t["depth"]].append(t["path"])
    return {"tiles": tiles[:max_tiles], "by_depth": dict(by_depth),
            "depths": sorted(by_depth), "count": len(tiles[:max_tiles])}

def measure_sizes(paths, session=None, sample=200):
    session = session or requests.Session()
    sizes = []
    for path in random.sample(paths, min(sample, len(paths))):
        try:
            head = session.head(path, timeout=20)
            length = int(head.headers.get("Content-Length", 0))
            if length:
                sizes.append(length)
        except Exception:
            continue
    if not sizes:
        return {"measured": 0}
    import statistics
    return {"measured": len(sizes),
            "median_kb": round(statistics.median(sizes) / 1024, 1),
            "p95_kb": round(sorted(sizes)[int(len(sizes) * 0.95)] / 1024, 1),
            "total_mb": round(sum(sizes) / 1e6, 1)}
```

Testing against **real** tile paths rather than a synthetic URL pattern is what makes the numbers transferable. A synthetic path hits the same file repeatedly, so the server's OS page cache serves everything from memory and the test measures the network stack; real paths spread across thousands of files exercise the storage layer the way a session does.

Grouping by depth matters for step 2, because a session does not request tiles uniformly: it requests a few coarse tiles and many fine ones, and the fine ones are the small numerous files that stress a server's request handling rather than its bandwidth.

Measuring the size distribution up front gives the bandwidth figure the results need to be interpreted against — a server saturating a 1 Gbps link at 200 requests per second with 600 KB tiles is bandwidth-bound, not compute-bound, and no amount of tuning helps.

### 2. Model the session, not the request

```python
# locustfile.py
import json
import random
import time
from pathlib import Path

from locust import FastHttpUser, LoadTestShape, between, events, task

TILES = json.loads(Path("tiles.json").read_text())
BY_DEPTH = TILES["by_depth"]
DEPTHS = sorted(int(d) for d in BY_DEPTH)

SESSION_PROFILE = {
    "initial_burst_tiles": 380,
    "pan_burst_tiles": 120,
    "pans_per_session": 6,
    "read_seconds": (4.0, 14.0),
    "coarse_share": 0.08,        # fraction of requests at the shallowest levels
    "revisit_share": 0.35,       # fraction of a pan burst already seen this session
}

def pick_tiles(n, seen, profile=SESSION_PROFILE):
    """A burst: mostly deep tiles, a few coarse ones, some already-seen ones."""
    out = []
    coarse_n = int(n * profile["coarse_share"])
    shallow = [d for d in DEPTHS if d <= DEPTHS[len(DEPTHS) // 3]]
    deep = [d for d in DEPTHS if d > DEPTHS[len(DEPTHS) // 3]]

    for _ in range(coarse_n):
        d = random.choice(shallow)
        out.append(random.choice(BY_DEPTH[str(d)]))
    revisit_n = int((n - coarse_n) * profile["revisit_share"])
    if seen and revisit_n:
        out.extend(random.sample(list(seen), min(revisit_n, len(seen))))
    while len(out) < n:
        d = random.choice(deep)
        out.append(random.choice(BY_DEPTH[str(d)]))
    random.shuffle(out)
    return out

class ViewerUser(FastHttpUser):
    """One user = one browser session looking at the tileset."""
    wait_time = between(*SESSION_PROFILE["read_seconds"])
    concurrency = 18                 # matches a browser's HTTP/2 scheduling
    network_timeout = 30.0
    connection_timeout = 10.0

    def on_start(self):
        self.seen = set()
        self.client.get("/tileset.json", name="tileset.json")
        self._burst(SESSION_PROFILE["initial_burst_tiles"], name="initial burst")

    @task(SESSION_PROFILE["pans_per_session"])
    def pan(self):
        self._burst(SESSION_PROFILE["pan_burst_tiles"], name="pan burst")

    @task(1)
    def idle(self):
        time.sleep(random.uniform(*SESSION_PROFILE["read_seconds"]))

    def _burst(self, count, name):
        paths = pick_tiles(count, self.seen)
        started = time.time()
        for path in paths:
            headers = {}
            if path in self.seen:
                # A revisit: the browser would send a conditional request or hit
                # its own cache. Immutable URLs mean no request at all.
                continue
            with self.client.get(path, name=f"tile {name}", headers=headers,
                                 catch_response=True) as response:
                if response.status_code == 200:
                    response.success()
                    self.seen.add(path)
                elif response.status_code == 404:
                    response.failure("404 — tile path does not exist")
                else:
                    response.failure(f"status {response.status_code}")
        events.request.fire(
            request_type="BURST", name=name,
            response_time=(time.time() - started) * 1000.0,
            response_length=0, exception=None, context={},
        )
```

`FastHttpUser` rather than `HttpUser` is not optional at this scale. The default requests-based user costs about 1.5 ms of Python per request, so a single worker saturates at roughly 600 requests per second and the test measures Locust; `FastHttpUser` uses geventhttpclient and reaches several thousand.

Skipping the request entirely on a revisit is the modelling decision that most affects the result. With the immutable URLs from [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/), a browser that has seen a tile does not ask again — not even conditionally — so a load test that re-requests revisited tiles overstates the server's load by the revisit share, which is 35% here.

Firing a custom `BURST` event with the whole burst's wall-clock duration is what turns per-request latency into the metric users feel. A burst of 380 tiles where every request takes 40 ms is fine if they are concurrent and catastrophic if they are serialised, and only the burst duration distinguishes those.

<figure class="diagram">
<svg viewBox="26 2 688 252" role="img" aria-labelledby="locust-shape-t locust-shape-d" xmlns="http://www.w3.org/2000/svg">
  <title id="locust-shape-t">A flat request rate against a realistic session shape</title>
  <desc id="locust-shape-d">Two request-rate timelines over 60 seconds for the same total number of requests. The flat profile issues a steady 40 requests per second, which the server handles with a 24 millisecond median and no queueing. The session profile issues a 380-request burst in the first two seconds, then quiet periods with 120-request bursts every 10 seconds. The peak instantaneous rate is 190 per second, queueing appears during each burst, and the 95th percentile latency is 310 milliseconds.</desc>
  <rect class="svg-bg" x="26" y="2" width="688" height="252" fill="#ffffff"/>
  <path d="M40 112 H700" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <path d="M40 210 H700" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <rect x="40" y="88" width="660" height="24" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.4"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.4">
    <rect x="40" y="130" width="34" height="80"/>
    <rect x="148" y="176" width="26" height="34"/>
    <rect x="256" y="176" width="26" height="34"/>
    <rect x="364" y="176" width="26" height="34"/>
    <rect x="472" y="176" width="26" height="34"/>
    <rect x="580" y="176" width="26" height="34"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="48" y="80">flat: 40 req/s steady</text>
    <text x="48" y="124">session: 380-tile burst, then 120 every 10 s</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="698" y="80">p95 latency 31 ms — "the server is fine"</text>
    <text x="698" y="236">p95 latency 310 ms — what users get</text>
  </g>
  <text x="57" y="226" fill="#1f2937" font-size="11.5" text-anchor="middle">190/s</text>
  <text x="370" y="30" fill="#1f2937" font-size="13" text-anchor="middle">same total requests over 60 seconds, two profiles</text>
  <text x="370" y="50" fill="#5b6471" font-size="12" text-anchor="middle">the flat profile never produces the queueing the burst does, so it cannot find the limit</text>
</svg>
<figcaption>Identical total throughput; only the burst profile reproduces the queueing that decides whether a session feels fast.</figcaption>
</figure>

### 3. Shape the load to find the capacity, not a number

```python
class StepToFailure(LoadTestShape):
    """Ramp concurrent sessions in steps and hold each long enough to measure."""
    steps = [
        {"users": 10, "hold": 90},
        {"users": 25, "hold": 90},
        {"users": 50, "hold": 120},
        {"users": 100, "hold": 120},
        {"users": 200, "hold": 120},
        {"users": 400, "hold": 120},
        {"users": 800, "hold": 120},
    ]

    def __init__(self):
        super().__init__()
        self._plan = []
        t = 0
        for step in self.steps:
            t += step["hold"]
            self._plan.append((t, step["users"]))

    def tick(self):
        run_time = self.get_run_time()
        for until, users in self._plan:
            if run_time < until:
                spawn = max(users // 10, 1)
                return users, spawn
        return None

SLO = {
    "burst_p95_seconds": 3.0,        # a 380-tile burst inside 3 s
    "tile_p95_ms": 250,
    "error_rate": 0.005,
}

def capacity_from_history(history, slo=SLO):
    """history: [{users, burst_p95_s, tile_p95_ms, error_rate, rps}]"""
    passing = [h for h in history
               if h["burst_p95_s"] <= slo["burst_p95_seconds"]
               and h["tile_p95_ms"] <= slo["tile_p95_ms"]
               and h["error_rate"] <= slo["error_rate"]]
    failing = [h for h in history if h not in passing]
    best = max(passing, key=lambda h: h["users"]) if passing else None
    first_fail = min(failing, key=lambda h: h["users"]) if failing else None
    return {
        "slo": slo,
        "max_passing_users": best["users"] if best else 0,
        "throughput_at_capacity_rps": best["rps"] if best else 0,
        "first_failing_users": first_fail["users"] if first_fail else None,
        "first_failure_reason": (
            "burst latency" if first_fail and first_fail["burst_p95_s"] > slo["burst_p95_seconds"]
            else "tile latency" if first_fail and first_fail["tile_p95_ms"] > slo["tile_p95_ms"]
            else "errors" if first_fail else None),
        "headroom_note": "quote the passing figure, not the failing one",
    }
```

Stepping and holding, rather than ramping continuously, is what makes each measurement attributable. A continuous ramp gives one blurred curve; steps give a table where each row is a steady state with its own percentiles, and the capacity is the last row that met the objective.

Defining the objective in terms of the **burst** rather than the request is what makes the answer meaningful. "250 ms at the 95th percentile per tile" is a server metric; "a 380-tile opening burst completes within 3 seconds" is what a user experiences, and the two diverge exactly when the server starts queueing.

Reporting the first failing step and *why* it failed is the other half. A capacity that ends in errors is a different problem from one that ends in latency: errors mean a connection or worker limit, latency means saturation.

### 4. Model the CDN, or state that you did not

```python
CACHE_PROFILE = {
    "edge_hit_rate": 0.92,       # measured from CDN logs, not guessed
    "origin_share": 0.08,
}

class OriginUser(ViewerUser):
    """Only the requests a CDN would forward — this is what the origin must survive."""
    def _burst(self, count, name):
        paths = pick_tiles(count, self.seen)
        misses = [p for p in paths
                  if p not in self.seen
                  and random.random() > CACHE_PROFILE["edge_hit_rate"]]
        started = time.time()
        for path in misses:
            with self.client.get(path, name=f"origin {name}",
                                 catch_response=True) as response:
                if response.status_code == 200:
                    response.success()
                    self.seen.add(path)
                else:
                    response.failure(f"status {response.status_code}")
        events.request.fire(request_type="BURST", name=f"origin {name}",
                            response_time=(time.time() - started) * 1000.0,
                            response_length=0, exception=None, context={})

def interpret_with_cdn(origin_capacity_users, cache_profile=CACHE_PROFILE):
    amplification = 1.0 / max(cache_profile["origin_share"], 1e-9)
    return {
        "origin_capacity_sessions": origin_capacity_users,
        "assumed_edge_hit_rate": cache_profile["edge_hit_rate"],
        "implied_total_sessions": int(origin_capacity_users * amplification),
        "caveat": "this multiplication is only valid if the hit rate holds at scale; "
                  "a cold edge after a deploy sees a 0% hit rate",
        "cold_edge_capacity_sessions": origin_capacity_users,
    }
```

Load-testing the origin behind a CDN with a full session profile measures a situation that never happens, because the edge absorbs 90%+ of the requests. Testing only the miss stream gives the origin's real requirement, and multiplying by the amplification gives the total session capacity.

The caveat in that function is the important part and is routinely forgotten: immediately after a deploy the edge is cold, so the origin briefly sees every request. A system sized on a 92% hit rate will fall over in the first minute after a release unless the deploy warms the cache or the origin has the headroom — which is a strong argument for the immutable-prefix scheme, where old tiles stay cached and only changed tiles are cold.

Measuring the hit rate from the CDN's own logs rather than assuming it is the difference between a capacity figure and a guess.

<figure class="diagram">
<svg viewBox="4 20 697 220" role="img" aria-labelledby="locust-cdn-t locust-cdn-d" xmlns="http://www.w3.org/2000/svg">
  <title id="locust-cdn-t">Testing the origin behind a CDN</title>
  <desc id="locust-cdn-d">A session issues 380 tile requests. The CDN edge serves 92 percent of them from cache and forwards 30 to the origin. Testing the origin with the full session profile measures a load it never sees. Testing it with the miss stream only gives the origin's real requirement, and multiplying by the amplification factor of 12.5 gives the total session capacity. Immediately after a deploy the edge is cold, so the origin briefly sees all 380.</desc>
  <rect class="svg-bg" x="4" y="20" width="697" height="220" fill="#ffffff"/>
  <defs>
    <marker id="locust-cdn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="18" y="72" width="134" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="232" y="72" width="134" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="446" y="34" width="150" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="446" y="118" width="150" height="52" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#locust-cdn-arrow)">
    <path d="M152 100 H230"/>
    <path d="M366 92 L444 64"/>
    <path d="M366 110 L444 138"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="94">one session:</text><text x="85" y="112">380 requests</text>
    <text x="299" y="86">CDN edge</text><text x="299" y="104">92% hit rate</text>
    <text x="299" y="122">(measured)</text>
    <text x="521" y="56">warm edge: 30</text><text x="521" y="74">reach the origin</text>
    <text x="521" y="140">cold edge after a</text><text x="521" y="158">deploy: all 380</text>
  </g>
  <text x="628" y="56" fill="#1f2937" font-size="12">×12.5</text>
  <text x="628" y="74" fill="#1f2937" font-size="12">sessions</text>
  <text x="628" y="146" fill="#b0413e" font-size="12">no</text>
  <text x="628" y="164" fill="#b0413e" font-size="12">headroom</text>
  <text x="370" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">size the origin for the miss stream, then check it survives a cold edge</text>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">immutable prefixes keep unchanged tiles cached, so only changed tiles are cold</text>
</svg>
<figcaption>The amplification factor is only valid while the edge is warm; the minute after a deploy is when the origin meets the unmultiplied load.</figcaption>
</figure>

### 5. Run it and collect the right metrics

```python
# runner.py
import json
import subprocess
from pathlib import Path

def run_locust(host, users, spawn_rate, run_time, out_prefix,
               locustfile="locustfile.py", workers=4):
    args = [
        "locust", "-f", locustfile, "--headless",
        "--host", host,
        "--users", str(users), "--spawn-rate", str(spawn_rate),
        "--run-time", run_time,
        "--csv", out_prefix, "--csv-full-history",
        "--html", f"{out_prefix}.html",
        "--only-summary",
    ]
    if workers > 1:
        args.extend(["--processes", str(workers)])
    proc = subprocess.run(args, capture_output=True, text=True)
    return {"returncode": proc.returncode,
            "stderr_tail": proc.stderr.strip().splitlines()[-6:]}

def read_results(out_prefix):
    import csv
    rows = list(csv.DictReader(Path(f"{out_prefix}_stats.csv").open()))
    by_name = {r["Name"]: r for r in rows}
    total = by_name.get("Aggregated") or rows[-1]

    def num(row, key, default=0.0):
        try:
            return float(row.get(key, default) or default)
        except ValueError:
            return default

    tiles = [r for r in rows if r["Name"].startswith("tile ")]
    bursts = [r for r in rows if r["Name"].endswith("burst")
              and r["Type"] == "BURST"]
    requests_total = sum(num(r, "Request Count") for r in tiles)
    failures = sum(num(r, "Failure Count") for r in tiles)

    return {
        "requests": int(requests_total),
        "failures": int(failures),
        "error_rate": round(failures / max(requests_total, 1), 5),
        "rps": round(num(total, "Requests/s"), 1),
        "tile_p50_ms": round(max((num(r, "50%") for r in tiles), default=0.0), 1),
        "tile_p95_ms": round(max((num(r, "95%") for r in tiles), default=0.0), 1),
        "tile_p99_ms": round(max((num(r, "99%") for r in tiles), default=0.0), 1),
        "burst_p50_s": round(max((num(r, "50%") for r in bursts), default=0.0) / 1000, 2),
        "burst_p95_s": round(max((num(r, "95%") for r in bursts), default=0.0) / 1000, 2),
        "bytes_total_mb": round(num(total, "Total Response Length") / 1e6, 1),
    }

def step_campaign(host, steps, run_time_per_step="2m", out_dir="build/loadtest"):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    history = []
    for users in steps:
        prefix = f"{out_dir}/step_{users}"
        run_locust(host, users=users, spawn_rate=max(users // 10, 1),
                   run_time=run_time_per_step, out_prefix=prefix)
        result = read_results(prefix)
        history.append({"users": users, **result})
        if result["error_rate"] > 0.05:
            break                          # no point continuing past collapse
    return {"history": history, "capacity": capacity_from_history(history)}
```

Reading the **percentiles** from Locust's CSV rather than the average response time is what makes the result honest. The average hides the tail, and the tail is the experience: a server with a 40 ms average and a 2.4 s p99 delivers a visibly broken map to one session in a hundred.

Stopping the campaign once the error rate passes 5% avoids spending twenty minutes measuring a collapsed server, which produces no information beyond "it collapsed".

`--processes` is what lets one machine drive a meaningful load: Locust is single-threaded per process, so a four-core generator needs four worker processes to use the hardware.

### 6. Check that the generator is not the bottleneck

```python
def generator_sanity_check(host, tile_paths, sample=200):
    """Measure single-request latency and generator CPU before trusting any result."""
    import os
    import statistics
    import time

    import requests

    session = requests.Session()
    latencies = []
    for path in tile_paths[:sample]:
        t0 = time.perf_counter()
        try:
            r = session.get(path, timeout=20)
            if r.status_code == 200:
                latencies.append((time.perf_counter() - t0) * 1000)
        except Exception:
            continue
    load1, load5, load15 = os.getloadavg()
    cores = os.cpu_count() or 1
    return {
        "unloaded_p50_ms": round(statistics.median(latencies), 1) if latencies else None,
        "unloaded_p95_ms": round(sorted(latencies)[int(len(latencies) * 0.95)], 1)
        if latencies else None,
        "generator_cores": cores,
        "load_average_1m": round(load1, 2),
        "generator_saturated": load1 > cores * 0.8,
        "advice": "add load-generator machines or raise --processes"
                  if load1 > cores * 0.8
                  else "generator has headroom",
    }

def bandwidth_check(results, link_gbps=1.0, duration_s=120):
    served_gbit = results["bytes_total_mb"] * 8 / 1000.0
    used_gbps = served_gbit / max(duration_s, 1)
    return {
        "served_mb": results["bytes_total_mb"],
        "average_gbps": round(used_gbps, 3),
        "link_gbps": link_gbps,
        "link_utilisation": round(used_gbps / max(link_gbps, 1e-9), 3),
        "bandwidth_bound": used_gbps > link_gbps * 0.7,
        "note": "above 70% of the link, the test measures the network rather than "
                "the server",
    }
```

Checking the generator's load average during the run is the step that prevents the most common wrong conclusion. A Locust run that reports a 3 s p95 on a generator at 100% CPU is measuring Locust, and the server may be entirely idle.

The bandwidth check is the same guard from the other direction. Tiles are large, so a test that serves 40 GB in two minutes is using 2.7 Gbps — and on a 1 Gbps link the latency is the queueing in the network, not the server.

Recording the **unloaded** latency before the campaign gives the baseline every later percentile is compared against. A p50 that starts at 180 ms unloaded means the server is far away or slow at rest, and the load test will only ever add to that.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="locust-steps-t locust-steps-d" xmlns="http://www.w3.org/2000/svg">
  <title id="locust-steps-t">Step campaign result and where capacity lies</title>
  <desc id="locust-steps-d">A table of six load steps. At 10 concurrent sessions the burst 95th percentile is 1.1 seconds and tile latency 38 milliseconds, passing. At 50 sessions it is 1.4 seconds and 52 milliseconds, passing. At 100 sessions it is 2.2 seconds and 118 milliseconds, passing. At 200 sessions it is 4.8 seconds and 384 milliseconds, failing on burst latency. At 400 sessions errors reach 3.1 percent. Capacity is therefore 100 sessions, not the 2100 requests per second the 400-session step achieved.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="110" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="128" y="20" width="120" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="248" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="378" y="20" width="120" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="498" y="20" width="110" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="608" y="20" width="114" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="110" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="128" y="52" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="248" y="52" width="130" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="378" y="52" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="498" y="52" width="110" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="608" y="52" width="114" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="82" width="110" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="128" y="82" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="248" y="82" width="130" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="378" y="82" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="498" y="82" width="110" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="608" y="82" width="114" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="112" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="128" y="112" width="120" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="248" y="112" width="130" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="378" y="112" width="120" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="498" y="112" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="608" y="112" width="114" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
    <rect x="18" y="146" width="110" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="128" y="146" width="120" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="248" y="146" width="130" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="378" y="146" width="120" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="498" y="146" width="110" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="608" y="146" width="114" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="176" width="110" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="128" y="176" width="120" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="248" y="176" width="130" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="378" y="176" width="120" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="498" y="176" width="110" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="608" y="176" width="114" height="30" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="73" y="41">sessions</text><text x="188" y="41">burst p95</text>
    <text x="313" y="41">tile p95</text><text x="438" y="41">errors</text>
    <text x="553" y="41">req/s</text><text x="665" y="41">verdict</text>
    <text x="73" y="72">10</text><text x="188" y="72">1.1 s</text>
    <text x="313" y="72">38 ms</text><text x="438" y="72">0.0%</text>
    <text x="553" y="72">210</text><text x="665" y="72">pass</text>
    <text x="73" y="102">50</text><text x="188" y="102">1.4 s</text>
    <text x="313" y="102">52 ms</text><text x="438" y="102">0.0%</text>
    <text x="553" y="102">880</text><text x="665" y="102">pass</text>
    <text x="73" y="134">100</text><text x="188" y="134">2.2 s</text>
    <text x="313" y="134">118 ms</text><text x="438" y="134">0.1%</text>
    <text x="553" y="134">1,540</text><text x="665" y="134">capacity</text>
    <text x="73" y="166">200</text><text x="188" y="166">4.8 s</text>
    <text x="313" y="166">384 ms</text><text x="438" y="166">0.4%</text>
    <text x="553" y="166">1,980</text><text x="665" y="166">fail: burst</text>
    <text x="73" y="196">400</text><text x="188" y="196">11.2 s</text>
    <text x="313" y="196">1,840 ms</text><text x="438" y="196">3.1%</text>
    <text x="553" y="196">2,100</text><text x="665" y="196">fail: errors</text>
  </g>
  <text x="370" y="232" fill="#1f2937" font-size="12.5" text-anchor="middle">capacity is 100 concurrent sessions — the 2,100 req/s at 400 sessions is a broken server working hard</text>
</svg>
<figcaption>Throughput keeps rising past the capacity limit, which is why a requests-per-second figure alone always overstates what a server can serve.</figcaption>
</figure>

## Expected Output & Verification

```text
{'tiles': 18412, 'depths': [0, 1, 2, 3, 4, 5], 'count': 18412}
{'measured': 200, 'median_kb': 412.4, 'p95_kb': 1180.2, 'total_mb': 98.4}
{'unloaded_p50_ms': 22.4, 'unloaded_p95_ms': 41.8, 'generator_cores': 8,
 'load_average_1m': 0.42, 'generator_saturated': False,
 'advice': 'generator has headroom'}
{
  "history": [
    {"users": 10, "rps": 210.4, "tile_p95_ms": 38.0, "burst_p95_s": 1.1,
     "error_rate": 0.0, "bytes_total_mb": 10412.8},
    {"users": 50, "rps": 880.2, "tile_p95_ms": 52.0, "burst_p95_s": 1.4,
     "error_rate": 0.0, "bytes_total_mb": 42184.1},
    {"users": 100, "rps": 1540.8, "tile_p95_ms": 118.0, "burst_p95_s": 2.2,
     "error_rate": 0.001, "bytes_total_mb": 74188.4},
    {"users": 200, "rps": 1980.1, "tile_p95_ms": 384.0, "burst_p95_s": 4.8,
     "error_rate": 0.004, "bytes_total_mb": 92104.8},
    {"users": 400, "rps": 2100.4, "tile_p95_ms": 1840.0, "burst_p95_s": 11.2,
     "error_rate": 0.031, "bytes_total_mb": 96412.2}
  ],
  "capacity": {
    "max_passing_users": 100,
    "throughput_at_capacity_rps": 1540.8,
    "first_failing_users": 200,
    "first_failure_reason": "burst latency",
    "headroom_note": "quote the passing figure, not the failing one"
  }
}
{'served_mb': 74188.4, 'average_gbps': 4.946, 'link_gbps': 10.0,
 'link_utilisation': 0.495, 'bandwidth_bound': False}
```

The capacity is 100 concurrent sessions, and the throughput at that point is 1,541 requests per second. The 400-session step achieved a *higher* throughput of 2,100 requests per second while delivering an 11-second opening burst and 3% errors — which is why quoting the peak throughput as capacity is misleading.

The failure mode is burst latency rather than errors, which points at saturation rather than a connection limit: the server is keeping up with the request count and taking too long per request.

At 49% link utilisation the test is not bandwidth-bound, so the finding is about the server. Had that figure been 85%, the whole campaign would have been measuring the network.

Verify the load profile resembles production, using the server's own logs:

```python
def compare_with_production_logs(log_path, generated_history,
                                 window_seconds=60):
    """Do the generated bursts look like real sessions?"""
    import re
    from collections import Counter

    pattern = re.compile(r'"GET (?P<path>\S+)".*?(?P<status>\d{3})')
    per_second = Counter()
    paths = Counter()
    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            m = pattern.search(line)
            if not m:
                continue
            paths[m.group("path")] += 1
            per_second[i // 1000] += 1

    rates = sorted(per_second.values())
    if not rates:
        return {"comparable": False, "reason": "no requests parsed from the log"}
    peak = rates[-1]
    median = rates[len(rates) // 2]
    burstiness = peak / max(median, 1)

    generated_peak = max(h["rps"] for h in generated_history)
    generated_median = sorted(h["rps"] for h in generated_history)[
        len(generated_history) // 2]

    return {
        "production_burstiness": round(burstiness, 2),
        "generated_burstiness": round(generated_peak / max(generated_median, 1), 2),
        "distinct_paths_in_log": len(paths),
        "top_path_share": round(paths.most_common(1)[0][1] / sum(paths.values()), 4),
        "profile_matches": abs(burstiness - generated_peak
                               / max(generated_median, 1)) < burstiness * 0.5,
        "note": "a top-path share above 0.05 means production re-requests tiles the "
                "test assumes are cached — check the Cache-Control headers",
    }
```

The `top_path_share` figure is the check that validates the revisit model. If one path is 12% of production requests, browsers are re-requesting it rather than caching it, and the test's assumption that revisits cost nothing is wrong — which usually means the `Cache-Control` headers are not what the versioning scheme intended.

Then verify the server's behaviour at capacity is graceful rather than a cliff:

```python
def degradation_shape(history, slo=SLO):
    """A gentle degradation is manageable; a cliff needs a queue or a limiter."""
    rows = sorted(history, key=lambda h: h["users"])
    deltas = []
    for a, b in zip(rows, rows[1:]):
        user_ratio = b["users"] / max(a["users"], 1)
        latency_ratio = b["tile_p95_ms"] / max(a["tile_p95_ms"], 1e-9)
        deltas.append({
            "from_users": a["users"], "to_users": b["users"],
            "user_ratio": round(user_ratio, 2),
            "latency_ratio": round(latency_ratio, 2),
            "elasticity": round(latency_ratio / max(user_ratio, 1e-9), 2),
        })
    worst = max(deltas, key=lambda d: d["elasticity"]) if deltas else None
    return {
        "steps": deltas,
        "worst_step": worst,
        "cliff": bool(worst and worst["elasticity"] > 2.5),
        "advice": "add a concurrency limiter so excess sessions queue rather than "
                  "degrading everyone" if worst and worst["elasticity"] > 2.5
                  else "degradation is proportional; scaling horizontally will work",
    }
```

Elasticity above about 2.5 — latency rising more than 2.5× faster than load — is a cliff, and it means the server has a contention point that a horizontal scale-out will hit at the same ratio. Below that, degradation is proportional and adding capacity works linearly, which is a much easier operational position.

## Performance Notes

- **`FastHttpUser` handles roughly 3,000–5,000 requests per second per process**; `HttpUser` manages about 600. Use the fast one and `--processes`.
- **Set `concurrency` on the user to match a browser**, around 18 for HTTP/2. Leaving it at 1 serialises each session's burst and measures nothing real.
- **The generator needs more bandwidth than the server.** A 10 Gbps link is the practical minimum for testing a tile server with 400 KB tiles.
- **Hold each step for at least 90 seconds.** Shorter steps measure the ramp, not the steady state.
- **Disable Locust's web UI with `--headless`** for reproducible runs, and keep `--csv-full-history` for the per-step percentiles.
- **Test the origin separately from the CDN**, with the miss stream only, and record the hit rate the conclusion depends on.

## Common Errors

**Throughput plateaus and the generator is at 100% CPU.** The test is measuring Locust. Add processes or machines.

**Every request returns 404.** The crawled paths are relative and the host is set separately, so they are being concatenated wrongly. Print one resolved URL before the campaign.

**Latency is flat and then collapses instantly.** A connection limit rather than saturation — check the server's worker count and the OS file-descriptor limit.

**Results are much better than production.** The test is hitting a warm OS page cache because the path set is too small, or the CDN is in front of the endpoint being tested.

**Results are much worse than production.** The revisit model is missing, so the test re-requests tiles browsers would have cached.

**The burst event never appears in the CSV.** `events.request.fire` needs the `request_type` to be included in the stats; check the name matches what the reader filters on.

**Errors appear at low load.** Rate limiting or a WAF reacting to the load generator's IP. Whitelist it, or the test measures the WAF.

## Frequently Asked Questions

### Locust or k6?

Either works; Locust wins here because the session model is Python and can reuse the tileset-crawling code. k6 is better at very high request rates from a single machine.

### Should I test against production?

Against a production-identical environment, ideally. Testing the real production origin is defensible out of hours with the CDN in front, and it is the only way to find a limit that only exists in the real configuration.

### What capacity figure should I report?

Concurrent sessions at a stated service objective, with the objective written down: "100 concurrent sessions with the opening burst inside 3 seconds at the 95th percentile". A requests-per-second number without an objective is unfalsifiable.

## Related Guides

- [HTTP/2 and Connection Limits for Tile Streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/) — the client-side concurrency this test models
- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — the caching the revisit model assumes
- [Diagnosing Slow First Render of Tilesets](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/diagnosing-slow-first-render-of-tilesets/) — the client-side view of the same burst

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
