---
title: "Exporting Prometheus Metrics from Tiling Jobs"
description: "Instrument batch tiling with Prometheus: the metric set, label cardinality limits, push gateway grouping for jobs that exit"
---
# Exporting Prometheus Metrics from Tiling Jobs

This page instruments a batch tiling job with Prometheus metrics that are actually alertable — a small metric set with useful label dimensions, a hard rule about cardinality, pushing from processes that exit, and alert rules that compare what a run produced against what its plan expected, for a city tileset built from EPSG:25832 data.

## Why you hit this

Prometheus is built for long-running services that get scraped. A tiling job runs for twenty minutes and exits, so there is nothing to scrape, and the naive fix — a gauge pushed at the end — loses everything about how the run went. Worse, the obvious labelling instinct, one series per shard, produces four thousand series per run and a Prometheus that falls over within a month. The pattern that works is small: a handful of metrics, labels only for dimensions you alert on, and a push per stage. The surrounding approach is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Python 3.10+ with `prometheus-client>=0.20`.
- A Prometheus server, and a Pushgateway reachable from the build machines.
- Grafana or any alerting front end for the rules at the end.
- A build plan: the number of shards, features or tiles the run is *supposed* to produce.

## Step-by-Step

### 1. Define a small metric set

```python
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

def build_registry():
    reg = CollectorRegistry()
    m = {
        "shards_expected": Gauge(
            "twin_shards_expected", "shards in the build plan", ["dataset"], registry=reg),
        "shards_written": Counter(
            "twin_shards_written_total", "shards successfully written", ["dataset"], registry=reg),
        "shards_failed": Counter(
            "twin_shards_failed_total", "shards that raised", ["dataset", "reason"], registry=reg),
        "stage_seconds": Histogram(
            "twin_stage_duration_seconds", "stage wall-clock duration", ["dataset", "stage"],
            buckets=(1, 5, 15, 60, 180, 600, 1800, 3600), registry=reg),
        "shard_seconds": Histogram(
            "twin_shard_duration_seconds", "per-shard duration", ["dataset"],
            buckets=(0.5, 1, 2, 5, 10, 30, 120), registry=reg),
        "output_bytes": Gauge(
            "twin_output_bytes", "size of the published output", ["dataset", "kind"], registry=reg),
        "triangles": Gauge(
            "twin_output_triangles", "triangles in the published output", ["dataset"], registry=reg),
        "run_timestamp": Gauge(
            "twin_run_completed_timestamp_seconds", "unix time of run completion", ["dataset"], registry=reg),
    }
    return reg, m

registry, M = build_registry()
```

Eight metrics is enough for a tiling job, and each one answers a question somebody has actually asked: did the run finish, did it produce everything, what failed and why, how long did it take, how big is the result, and when did it last succeed. Counters end in `_total`, durations in `_seconds`, and sizes in `_bytes` — the conventions matter because they are what makes the rate and histogram functions behave as expected.

The `reason` label on failures is the one exception to keeping labels minimal: a handful of values (`invalid_geometry`, `missing_dtm`, `timeout`) turns an alert from "something failed" into "the same thing failed forty times".

### 2. Respect cardinality

```python
# WRONG: one series per shard is 4,096 series per run, and they never expire
M["shard_seconds"].labels(dataset="city", shard=shard).observe(4.2)      # do not do this

# RIGHT: the shard identity lives in logs and traces; the metric keeps the distribution
M["shard_seconds"].labels(dataset="city").observe(4.2)
```

A Prometheus series is defined by its label values, so a label with high cardinality — a shard key, a building identifier, a file name, a timestamp — multiplies the storage and the query cost of everything that touches it. The rule is that labels are for dimensions you group or alert by, of which there are usually three or four: dataset, stage, and a small enumeration of outcomes.

The information that is genuinely per shard goes where per-item detail belongs: [structured logs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/structured-logging-for-spatial-pipelines/) and [traces](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/tracing-pipeline-stages-with-opentelemetry/). The histogram keeps the shape of the distribution, which is what an alert needs.

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="prom-card-t prom-card-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prom-card-t">Label cardinality and series count</title>
  <desc id="prom-card-d">A table of label choices and the resulting number of time series. Dataset alone gives a handful of series. Dataset and stage gives tens. Dataset, stage and a failure reason gives a few hundred, which is fine. Adding a shard label gives four thousand series per run and they accumulate, which is what overwhelms a Prometheus instance.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="360" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="20" width="180" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="560" y="20" width="180" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="360" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="56" width="180" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="56" width="180" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="98" width="360" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="98" width="180" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="560" y="98" width="180" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="140" width="360" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="380" y="140" width="180" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="560" y="140" width="180" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="182" width="360" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="380" y="182" width="180" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="560" y="182" width="180" height="42" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="200" y="43">labels</text>
    <text x="470" y="43">series per metric</text>
    <text x="650" y="43">verdict</text>
    <text x="200" y="82">dataset</text><text x="470" y="82">~5</text><text x="650" y="82">ideal</text>
    <text x="200" y="124">dataset, stage</text><text x="470" y="124">~40</text><text x="650" y="124">ideal</text>
    <text x="200" y="166">dataset, stage, reason</text><text x="470" y="166">~300</text><text x="650" y="166">acceptable</text>
    <text x="200" y="208">dataset, stage, shard</text><text x="470" y="208">4,096 per run, cumulative</text><text x="650" y="208">never</text>
  </g>
</svg>
<figcaption>Every label multiplies. The identity of an individual unit of work belongs in logs and traces, where it costs nothing.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="prom-types-t prom-types-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prom-types-t">Which metric type for which quantity</title>
  <desc id="prom-types-d">A table. A counter only goes up and suits shards written or failures. A gauge can move in either direction and suits the plan size, output bytes and the last successful run timestamp. A histogram records a distribution and suits stage and per-shard durations. A summary is avoided because its quantiles cannot be aggregated across jobs.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="150" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="170" y="20" width="270" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="440" y="20" width="300" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="150" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="56" width="270" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="56" width="300" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="98" width="150" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="98" width="270" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="98" width="300" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="140" width="150" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="140" width="270" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="140" width="300" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="182" width="150" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="182" width="270" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="440" y="182" width="300" height="42" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="43">type</text>
    <text x="305" y="43">behaviour</text>
    <text x="590" y="43">use it for</text>
    <text x="95" y="82">counter</text><text x="305" y="82">only increases</text><text x="590" y="82">shards written, failures by reason</text>
    <text x="95" y="124">gauge</text><text x="305" y="124">moves either way</text><text x="590" y="124">plan size, output bytes, last success time</text>
    <text x="95" y="166">histogram</text><text x="305" y="166">bucketed distribution</text><text x="590" y="166">stage and per-shard durations</text>
    <text x="95" y="208">summary</text><text x="305" y="208">pre-computed quantiles</text><text x="590" y="208">avoid: cannot be aggregated across jobs</text>
  </g>
</svg>
<figcaption>Three types cover a pipeline. Summaries look convenient and cannot be combined across parallel workers, which is exactly what a tiling job has.</figcaption>
</figure>

### 3. Push from a job that exits

```python
import time
from prometheus_client import push_to_gateway, delete_from_gateway

GATEWAY = "pushgw.internal:9091"
JOB = "twin-tiling"

def push(dataset, stage):
    """Grouping key includes the dataset so two datasets do not overwrite each other."""
    push_to_gateway(GATEWAY, job=JOB, registry=registry,
                    grouping_key={"dataset": dataset, "stage": stage})

def run_stage(dataset, stage, work):
    with M["stage_seconds"].labels(dataset, stage).time():
        result = work()
    push(dataset, stage)
    return result
```

The grouping key is the part people get wrong. A push with only `job=` replaces whatever was there, so two datasets tiled in parallel overwrite each other's metrics and the alert sees whichever finished last. Including the dataset and the stage in the grouping key gives each combination its own group, which is what makes the series meaningful.

Pushing after each stage rather than once at the end means a job that dies halfway still leaves evidence — the stages that completed are recorded, and the missing stage is itself the signal.

### 4. Record counts against the plan

```python
def tile_dataset(dataset, plan):
    M["shards_expected"].labels(dataset).set(len(plan))
    written = 0
    for shard in plan:
        t0 = time.perf_counter()
        try:
            res = tile_shard(shard)
        except InvalidGeometry:
            M["shards_failed"].labels(dataset, "invalid_geometry").inc()
            continue
        except MissingTerrain:
            M["shards_failed"].labels(dataset, "missing_dtm").inc()
            continue
        M["shard_seconds"].labels(dataset).observe(time.perf_counter() - t0)
        M["shards_written"].labels(dataset).inc()
        written += 1
    M["run_timestamp"].labels(dataset).set(time.time())
    push(dataset, "tiling")
    return written

written = run_stage("city", "tiling", lambda: tile_dataset("city", build_plan))
print(f"{written} of {len(build_plan)} shards written")
```

`shards_expected` next to `shards_written_total` is the pattern the whole page exists for. It makes a partial build detectable on the first run, without a baseline and without history, and it survives legitimate changes of scope — a district added to the plan raises both numbers.

### 5. Publish output facts too

```python
from pathlib import Path

def record_outputs(dataset, tileset_dir):
    total = sum(p.stat().st_size for p in Path(tileset_dir).rglob("*") if p.is_file())
    M["output_bytes"].labels(dataset, "tileset").set(total)
    M["triangles"].labels(dataset).set(count_triangles(tileset_dir))
    push(dataset, "publish")
    return total

record_outputs("city", "build/tiles/city")
```

Output size and triangle count are the cheapest regression detectors available. A build whose bytes fall by 30% with an unchanged shard count has lost content — an empty district, a texture step that silently skipped — and a build whose triangles double has lost a decimation step. Neither shows up in exit codes.

### 6. Write the alert rules

```yaml
groups:
  - name: twin-pipeline
    rules:
      - alert: TwinBuildIncomplete
        expr: |
          twin_shards_written_total < twin_shards_expected
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.dataset }}: build wrote fewer shards than planned"

      - alert: TwinBuildStale
        expr: |
          time() - twin_run_completed_timestamp_seconds > 36 * 3600
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.dataset }}: no successful run in 36 hours"

      - alert: TwinStageSlowdown
        expr: |
          histogram_quantile(0.95, sum by (le, dataset, stage) (rate(twin_stage_duration_seconds_bucket[6h])))
          > 2 * histogram_quantile(0.95, sum by (le, dataset, stage) (rate(twin_stage_duration_seconds_bucket[7d] offset 7d)))
        for: 1h
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.dataset }}/{{ $labels.stage }}: p95 duration doubled against last week"

      - alert: TwinOutputShrank
        expr: |
          twin_output_bytes < 0.7 * (twin_output_bytes offset 1d)
        for: 30m
        labels: { severity: critical }
        annotations:
          summary: "{{ $labels.dataset }}: output is 30% smaller than yesterday"
```

Four rules cover the failure modes that matter: an incomplete build, a pipeline that stopped running at all, a stage that got much slower, and an output that shrank. `TwinBuildStale` is the one most often missing and most often needed — a scheduler that silently stops firing produces no errors anywhere, and a twin quietly freezes.

<figure class="diagram">
<svg viewBox="6 6 748 224" role="img" aria-labelledby="prom-alert-t prom-alert-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prom-alert-t">What each alert catches</title>
  <desc id="prom-alert-d">Four alerts against four failure modes. Written fewer shards than planned catches a partial build. No successful run in thirty-six hours catches a scheduler that stopped. A doubled stage duration catches a performance regression or a growing input. An output thirty percent smaller than yesterday catches lost content that still produced a valid tileset.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="224" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="330" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="350" y="20" width="390" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="330" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="350" y="56" width="390" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="96" width="330" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="350" y="96" width="390" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="136" width="330" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="350" y="136" width="390" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="176" width="330" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="350" y="176" width="390" height="40" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="185" y="43">alert</text>
    <text x="545" y="43">failure it catches</text>
    <text x="185" y="81">written &lt; expected</text><text x="545" y="81">a district silently missing from the build</text>
    <text x="185" y="121">no run in 36 h</text><text x="545" y="121">the scheduler stopped firing</text>
    <text x="185" y="161">p95 duration doubled</text><text x="545" y="161">regression, or the input grew</text>
    <text x="185" y="201">output 30% smaller</text><text x="545" y="201">content lost in a stage that still succeeded</text>
  </g>
</svg>
<figcaption>Each rule corresponds to an incident that has happened to somebody; none of them is detectable from exit codes alone.</figcaption>
</figure>

## Expected Output & Verification

```text
4096 of 4096 shards written
```

Verify the metrics arrive and mean what you think. Query the gateway directly and assert on the exposition text, which is the contract between the job and Prometheus:

```python
import requests

text = requests.get(f"http://{GATEWAY}/metrics", timeout=10).text
def value(name, **labels):
    needle = name + "{" if labels else name
    for line in text.splitlines():
        if line.startswith(needle) and all(f'{k}="{v}"' in line for k, v in labels.items()):
            return float(line.rsplit(" ", 1)[1])
    raise AssertionError(f"{name}{labels} not found in the gateway")

expected = value("twin_shards_expected", dataset="city")
written = value("twin_shards_written_total", dataset="city")
print(f"gateway reports {written:.0f} of {expected:.0f} shards")
assert written == expected, "incomplete build recorded in metrics"
assert value("twin_run_completed_timestamp_seconds", dataset="city") > time.time() - 3600
```

Also verify the alerts themselves, which is the step almost always skipped. `promtool` evaluates rules against synthetic series, so an incomplete-build alert can be proved to fire:

```bash
promtool test rules alerts_test.yml
```

Keeping a rule test file with one case per alert — a series that should fire and one that should not — is what stops a refactor of the metric names from silently disabling monitoring.

## Performance Notes

- **A push is a single HTTP request** with a few kilobytes of text; pushing once per stage is free relative to any spatial work.
- **Histograms cost buckets × label combinations.** Eight buckets on two labels is nothing; eight buckets on a shard label is the cardinality problem again.
- **Delete stale groups** when a dataset is retired, with `delete_from_gateway`, or its last values linger forever and keep satisfying staleness alerts.
- **Push before a long stage as well as after**, with a zeroed counter, so a job that dies mid-stage is visibly mid-stage rather than absent.
- **Keep the registry per run**, not global, so a retry inside the same process does not double-count a counter.

## Common Errors

**Metrics from two datasets overwrite each other.** The grouping key did not include the dataset. Push with `grouping_key={"dataset": …, "stage": …}`.

**A counter resets to zero mid-run in the graphs.** A new `CollectorRegistry` was created per stage, so the counter started again. Build the registry once per run.

**`rate()` returns nothing for pushed counters.** Pushed metrics update at push time, not continuously, so short rate windows see no change. Alert on the value against a plan, as above, rather than on rates.

**The staleness alert never fires even though the pipeline is dead.** The Pushgateway keeps serving the last values indefinitely, so `up`-style absence checks do not work. Alert on the age of `twin_run_completed_timestamp_seconds`, which the job itself sets.

## Frequently Asked Questions

### Pushgateway or a textfile exporter?

Pushgateway when jobs run on ephemeral runners; the node exporter's textfile collector when jobs run on a machine with a node exporter already scraping it. The textfile route avoids the staleness trap because the file's own timestamps are visible, and it does not work for containers that disappear.

### Should the run's exit code be a metric?

Record success as a timestamp gauge, as above, rather than as a boolean — a boolean tells you nothing about *when*, and "when did this last succeed" is the question during an incident.

### How do these metrics relate to the QA gates?

The gates decide whether a build is publishable; the metrics record what the gates decided and how the run behaved. Exporting a gate result as a gauge per gate turns a pass/fail into a trend, which is where a slowly degrading dataset shows up.

## Related Guides

- [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/) — how this fits with logs and traces
- [Monitoring Twin Data Freshness SLOs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/monitoring-twin-data-freshness-slos/) — the freshness metric in depth
- [Alerting on Tile Error Rates from CDN Logs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/alerting-on-tile-error-rates-from-cdn-logs/) — the user-facing alert to pair with these

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
