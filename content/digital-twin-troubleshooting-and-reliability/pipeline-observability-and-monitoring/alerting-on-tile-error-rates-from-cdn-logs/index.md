# Alerting on Tile Error Rates from CDN Logs

This page turns a CDN's access logs into the alert that tells you a twin is broken for users — parsing requests per tileset version, separating missing tiles from server failures, watching the cache hit ratio for a build that invalidated everything, and setting thresholds that fire on a bad deploy within minutes rather than after a support ticket.

## Why you hit this

Every pipeline signal can be green while the twin is unusable. The build wrote 4,096 shards, the validator passed, the deploy reported success — and one path prefix is wrong, so every tile at level 16 returns 404 for everyone. Nothing in the pipeline notices, because the pipeline's job ended at upload. The only place that failure is visible is where the requests are served, which makes CDN logs the closest thing a twin has to a user-experience signal. The wider instrumentation context is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Access to CDN or tile-server logs in a parseable form — JSON lines from Cloudflare or Fastly, or the S3/CloudFront format.
- Python 3.10+ with `prometheus-client>=0.20`; `boto3>=1.34` if the logs sit in object storage.
- A URL scheme that contains the tileset version, for example `/tilesets/city/v42/content/16/…`. Without a version in the path, none of the per-version analysis below is possible.
- An alerting route that reaches a person within minutes.

## Step-by-Step

### 1. Parse the log into the dimensions that matter

```python
import gzip
import json
import re
from collections import Counter
from pathlib import Path

TILE_RE = re.compile(r"^/tilesets/(?P<dataset>[^/]+)/(?P<version>v\d+)/(?P<rest>.*)$")
KIND = {".json": "tileset", ".glb": "content", ".b3dm": "content", ".pnts": "content",
        ".subtree": "subtree", ".png": "imagery", ".jpg": "imagery"}

def parse_log(path):
    rows = Counter()
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = TILE_RE.match(rec.get("uri", rec.get("ClientRequestURI", "")))
            if not m:
                continue
            ext = "." + m["rest"].rsplit(".", 1)[-1] if "." in m["rest"] else ""
            key = (
                m["dataset"], m["version"], KIND.get(ext, "other"),
                int(rec.get("status", rec.get("EdgeResponseStatus", 0))),
                rec.get("cache", rec.get("CacheCacheStatus", "unknown")),
                rec.get("region", rec.get("ClientRegionCode", "unknown")),
            )
            rows[key] += 1
    return rows

rows = parse_log("logs/2026-09-17T02.json.gz")
print(f"{sum(rows.values()):,} tile requests across {len({k[1] for k in rows})} versions")
```

Six dimensions carry almost all of the diagnostic value: dataset, version, content kind, status, cache status and region. Everything else in a CDN log — user agent, referrer, bytes — is noise for this purpose. Keeping the content kind separate matters because the failure modes differ: a missing `tileset.json` breaks everything, while a missing deep content tile breaks one building.

### 2. Compute rates per version, not in aggregate

```python
def rates(rows):
    by_version = Counter()
    errors = Counter()
    for (dataset, version, kind, status, cache, region), n in rows.items():
        by_version[(dataset, version)] += n
        if status >= 400:
            errors[(dataset, version, kind, status)] += n
    out = []
    for (dataset, version), total in sorted(by_version.items()):
        for (d, v, kind, status), n in errors.items():
            if (d, v) != (dataset, version):
                continue
            out.append({"dataset": dataset, "version": version, "kind": kind,
                        "status": status, "count": n, "total": total,
                        "rate_pct": round(100 * n / total, 3)})
    return sorted(out, key=lambda r: -r["rate_pct"])

for r in rates(rows)[:8]:
    print(f"{r['dataset']}/{r['version']:>4} {r['kind']:<8} {r['status']} "
          f"{r['count']:>7,} of {r['total']:>9,} = {r['rate_pct']:.3f}%")
```

Per-version rates are the whole point. On the day of a deploy the new version might serve 3% of requests while carrying a 40% error rate, and the site-wide rate — which is what a default dashboard shows — sits at 1.2% and triggers nothing. The version dimension makes the broken build obvious while the old one is still carrying the traffic.

<figure class="diagram">
<svg viewBox="26 26 805 226" role="img" aria-labelledby="cdn-ver-t cdn-ver-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-ver-t">Why the aggregate error rate hides a bad deploy</title>
  <desc id="cdn-ver-d">On the day of a deploy, version 41 serves ninety-seven percent of requests with a tiny error rate while version 42 serves three percent with a forty percent error rate. The aggregate rate is about one point two percent, below a typical alert threshold, while the per-version rate for version 42 is unmistakable.</desc>
  <rect class="svg-bg" x="26" y="26" width="805" height="226" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="40" y="40" width="580" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="96" width="20" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="170" width="20" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="170" width="8" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="632" y="64">v41 · 97% of traffic · 0.1% errors</text>
    <text x="72" y="120">v42 · 3% of traffic · 40% errors</text>
    <text x="80" y="192">aggregate · 1.2% errors — under most thresholds</text>
  </g>
  <text x="380" y="234" fill="#15384a" font-size="12.5" text-anchor="middle">The broken version is a small slice of traffic and a complete failure for the users on it.</text>
</svg>
<figcaption>Alerting per version catches a bad deploy in its first minutes, while the version still serves a small share of requests.</figcaption>
</figure>

### 3. Treat 404 and 5xx as different problems

```python
def classify_errors(rows):
    buckets = Counter()
    for (dataset, version, kind, status, cache, region), n in rows.items():
        if status == 404:
            buckets[(dataset, version, "missing", kind)] += n
        elif status == 403:
            buckets[(dataset, version, "forbidden", kind)] += n
        elif 500 <= status < 600:
            buckets[(dataset, version, "server", kind)] += n
        elif status == 206 or status == 200:
            buckets[(dataset, version, "ok", kind)] += n
    return buckets

for (dataset, version, cls, kind), n in sorted(classify_errors(rows).items()):
    if cls != "ok":
        print(f"{dataset}/{version} {cls:<9} {kind:<8} {n:,}")
```

A 404 means the pipeline did not publish what the tileset references: a path prefix error, a missing shard, a URL template using `{y}` where the tiles are `{reverseY}`. A 403 usually means object-store permissions or a signed-URL expiry, and it is the failure that appears hours after a deploy rather than immediately. A 5xx is the origin or the CDN failing, which is an operations problem rather than a build problem. Alerting on "errors" as one number sends all three to the same person with no information about which it is.

<figure class="diagram">
<svg viewBox="6 10 728 244" role="img" aria-labelledby="cdn-kind-t cdn-kind-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-kind-t">How much damage a 404 does, by content kind</title>
  <desc id="cdn-kind-d">A ranking. A missing root tileset.json breaks the whole layer for every user. A missing subtree file breaks a whole region. A missing external tileset breaks a district. A missing content tile breaks one building or one terrain patch. A missing imagery tile leaves a grey square. Alert thresholds should be tightest for the kinds at the top.</desc>
  <rect class="svg-bg" x="6" y="10" width="728" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="24" width="700" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="66" width="560" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="108" width="420" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="150" width="240" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="192" width="140" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="36" y="48">root tileset.json — the whole layer, every user</text>
    <text x="36" y="90">subtree file — a whole region of an implicit tileset</text>
    <text x="36" y="132">external tileset — one district</text>
    <text x="36" y="174">content tile — one building</text>
    <text x="172" y="216">imagery tile — a grey square</text>
  </g>
  <text x="380" y="236" fill="#15384a" font-size="12" text-anchor="middle">Bar length is the blast radius, which is why the alert splits by content kind.</text>
</svg>
<figcaption>A 0.1% 404 rate on root tilesets is an outage; the same rate on imagery tiles is cosmetic. One threshold cannot serve both.</figcaption>
</figure>

### 4. Watch the cache hit ratio as a cost and a signal

```python
def cache_ratio(rows):
    per_version = Counter()
    hits = Counter()
    for (dataset, version, kind, status, cache, region), n in rows.items():
        if status not in (200, 206):
            continue
        per_version[(dataset, version)] += n
        if str(cache).lower() in ("hit", "revalidated"):
            hits[(dataset, version)] += n
    return {k: round(100 * hits[k] / v, 1) for k, v in per_version.items() if v}

print(cache_ratio(rows))
```

A tileset served from immutable, versioned URLs should sit above 90% hits once it is warm. Two patterns are worth alerting on. A sudden drop across all versions means something invalidated the cache — a purge, or a change in cache headers — and the origin is about to carry the full load. A permanently low ratio for one version means its URLs are not cacheable at all, usually a query string that varies per request or a `Cache-Control: no-store` that slipped into the deploy.

### 5. Export the numbers as metrics and alert

```python
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

def publish_metrics(rows, gateway="pushgw.internal:9091"):
    reg = CollectorRegistry()
    err = Gauge("twin_tile_error_rate", "share of tile requests returning 4xx or 5xx",
                ["dataset", "version", "kind", "class"], registry=reg)
    req = Gauge("twin_tile_requests", "tile requests in the window",
                ["dataset", "version"], registry=reg)
    hit = Gauge("twin_tile_cache_hit_ratio", "cache hit ratio", ["dataset", "version"], registry=reg)

    totals = Counter()
    for (dataset, version, kind, status, cache, region), n in rows.items():
        totals[(dataset, version)] += n
    for (dataset, version), total in totals.items():
        req.labels(dataset, version).set(total)
    for (dataset, version, cls, kind), n in classify_errors(rows).items():
        if cls == "ok":
            continue
        err.labels(dataset, version, kind, cls).set(n / max(totals[(dataset, version)], 1))
    for (dataset, version), ratio in cache_ratio(rows).items():
        hit.labels(dataset, version).set(ratio / 100.0)

    push_to_gateway(gateway, job="twin-cdn-logs", registry=reg,
                    grouping_key={"window": "hourly"})
    return totals

publish_metrics(rows)
```

```yaml
groups:
  - name: twin-tiles-serving
    rules:
      - alert: TileVersionMissingContent
        expr: |
          twin_tile_error_rate{class="missing"} > 0.02
          and on (dataset, version) twin_tile_requests > 500
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.dataset }}/{{ $labels.version }}: {{ $value | humanizePercentage }} of {{ $labels.kind }} requests are 404"

      - alert: TileServerErrors
        expr: twin_tile_error_rate{class="server"} > 0.005
        for: 5m
        labels: { severity: critical }

      - alert: TileForbiddenSpike
        expr: twin_tile_error_rate{class="forbidden"} > 0.01
        for: 15m
        labels: { severity: warning }

      - alert: TileCacheHitRatioDropped
        expr: twin_tile_cache_hit_ratio < 0.7
        for: 30m
        labels: { severity: warning }
```

The `and on (dataset, version) twin_tile_requests > 500` clause is what stops a version with eleven requests and one 404 from paging somebody at three in the morning. Every rate alert on low-volume dimensions needs a volume guard, and versioned tilesets are the definition of a low-volume dimension in their first minutes.

<figure class="diagram">
<svg viewBox="6 6 748 240" role="img" aria-labelledby="cdn-class-t cdn-class-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-class-t">Status code to cause to owner</title>
  <desc id="cdn-class-d">A table mapping status classes to their usual cause and the team that fixes them. 404 means the build published the wrong paths, owned by the pipeline team. 403 means permissions or an expired signature, owned by platform. 5xx means the origin or CDN is failing, owned by operations. A low cache hit ratio means cache headers or purges, owned by whoever runs the deploy.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="150" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="170" y="20" width="360" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="530" y="20" width="210" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="150" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="56" width="360" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="530" y="56" width="210" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="100" width="150" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="170" y="100" width="360" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="530" y="100" width="210" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="144" width="150" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="144" width="360" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="530" y="144" width="210" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="188" width="150" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="188" width="360" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="188" width="210" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="43">signal</text>
    <text x="350" y="43">usual cause</text>
    <text x="635" y="43">who fixes it</text>
    <text x="95" y="83">404</text><text x="350" y="83">wrong paths or a missing shard in the build</text><text x="635" y="83">pipeline team</text>
    <text x="95" y="127">403</text><text x="350" y="127">bucket permissions, expired signature</text><text x="635" y="127">platform</text>
    <text x="95" y="171">5xx</text><text x="350" y="171">origin or CDN failing</text><text x="635" y="171">operations</text>
    <text x="95" y="215">low hit ratio</text><text x="350" y="215">cache headers, a purge, query strings</text><text x="635" y="215">deploy owner</text>
  </g>
</svg>
<figcaption>Splitting the classes is what makes the alert actionable: each one has a different cause and a different first responder.</figcaption>
</figure>

### 6. Diagnose a 404 spike down to a path

```python
def missing_paths(path, version, limit=20):
    counts = Counter()
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            uri = rec.get("uri", "")
            if int(rec.get("status", 0)) == 404 and f"/{version}/" in uri:
                counts[uri] += 1
    return counts.most_common(limit)

for uri, n in missing_paths("logs/2026-09-17T02.json.gz", "v42"):
    print(f"{n:>6,}  {uri}")
```

The top missing paths name the bug directly. A list dominated by `/content/16/…` with levels 0–15 absent means the deepest level was never uploaded. A list of `/content/…/*.b3dm` when the build produced `.glb` means the tileset JSON was not regenerated. A single `tileset.json` at the top means the whole version is unreachable and the deploy did not complete.

## Expected Output & Verification

```text
4,918,204 tile requests across 2 versions
city/ v41 content  404      412 of 4,762,118 = 0.009%
city/ v42 content  404   62,004 of   156,086 = 39.725%
city/ v41 server   500       88 of 4,762,118 = 0.002%
{('city', 'v41'): 94.2, ('city', 'v42'): 41.8}
  38,204  /tilesets/city/v42/content/16/34212/22418.glb
  21,118  /tilesets/city/v42/content/16/34212/22419.glb
```

That output is a diagnosis: version 42 is missing its level-16 content, its cache hit ratio is low because nothing can be cached, and version 41 is healthy. The fix is in the deploy, and the alert fired ten minutes after it started rather than when a user complained.

Verify the pipeline that produces these numbers, not only the numbers. Two checks matter:

```python
FIXTURE = "tests/fixtures/cdn_sample.json.gz"
rows = parse_log(FIXTURE)
assert sum(rows.values()) == 1000, "parser dropped or duplicated lines"
r = {(x["version"], x["class"] if "class" in x else x["status"]): x for x in rates(rows)}
assert any(x["status"] == 404 and x["version"] == "v42" for x in rates(rows)), "known 404s not detected"
print("log parser verified against the fixture")
```

A fixture of a thousand known lines, with a known number of 404s in a known version, is what stops a log-format change from silently turning the alert off. CDNs do change their field names, and an alert that stops firing looks exactly like an alert that has nothing to report.

## Performance Notes

- **Parse incrementally.** Hourly log files for a busy twin are hundreds of megabytes gzipped; a streaming parse with a `Counter` uses a few megabytes of memory regardless of size.
- **Aggregate before storing.** Keep the six-dimension counters, not the raw lines, for history. A month of hourly aggregates is a few megabytes.
- **Run the job hourly, alert on the last two windows.** A ten-minute alert delay is fine for this signal; a per-request stream is unnecessary complexity for a tile service.
- **Sample only if you must.** Most CDNs offer sampled logs at a fraction of the cost; a 1% sample is enough for rates but will not show a single missing `tileset.json`, so keep unsampled logs for the tileset kind if the CDN allows it.
- **Guard every rate with a volume threshold**, or a quiet version will page somebody over three requests.

## Common Errors

**No alert fires although users see failures.** The URL scheme has no version, so the broken build's errors are diluted into the aggregate. Version the paths; it also makes rollback trivial, as in [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/).

**404 rate is permanently a few percent.** The viewer requests tiles that legitimately do not exist — an imagery layer without a `rectangle`, or a terrain provider probing for levels beyond the data. Set the layer bounds, and exclude known-probing paths from the alert rather than raising the threshold.

**The parser silently matches nothing after a CDN change.** Field names moved. The fixture assertion above is the guard; without it, silence looks like success.

**Alerts fire during every deploy and are ignored.** The threshold is too tight for the first minutes of a version, when a handful of requests can produce a high rate. Use the volume guard and a `for:` duration of ten minutes.

## Frequently Asked Questions

### Should this alert page someone at night?

A 404 rate above a couple of percent on a version with real traffic means the twin is broken for its users, so yes for critical datasets. A 403 spike or a cache-ratio drop can wait for the morning.

### Can I use the CDN's own analytics instead?

For dashboards, often yes. For alerting per tileset version and per content kind, most built-in analytics cannot slice the URL path that finely, which is why the parse above exists.

### What about the viewer's own error reporting?

It is a useful complement — it sees CORS failures and decode errors that the CDN considers successful responses, as described in [fixing CORS and content-encoding errors on tile servers](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/fixing-cors-and-content-encoding-errors-on-tile-servers/). It also only sees the users who stayed.

## Related Guides

- [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/) — where this signal fits
- [Exporting Prometheus Metrics from Tiling Jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) — the build-side counterpart
- [Detecting Stale Tiles After Deploy](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/detecting-stale-tiles-after-deploy/) — when tiles load but are the wrong version

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
