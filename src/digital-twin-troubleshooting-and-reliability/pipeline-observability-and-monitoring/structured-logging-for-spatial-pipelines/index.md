---
title: "Structured Logging for Spatial Pipelines"
description: "Log spatial batch jobs so failures are queryable: JSON events, run and shard context, CRS and count fields"
---
# Structured Logging for Spatial Pipelines

This page makes a spatial pipeline's logs queryable — emitting JSON events with `structlog`, binding the run identifier and the CRS once per run, putting the shard key and the counts in fields rather than in message text, sampling the per-tile chatter so a 4,096-shard job does not produce a million lines, and writing a run summary that outlives the log retention.

## Why you hit this

When a district goes missing from a twin, the investigation starts in the logs, and what is usually there is a few thousand lines of `Processing tile 120210233010... done` interleaved from eight workers. Answering "was that shard processed, and how long did it take?" means grep and guesswork; answering "which shards did this run skip?" is impossible. Structured events fix both, and they cost nothing at write time. The wider instrumentation picture is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Python 3.10+ with `structlog>=24.1`. The standard library's `logging` works too, with a JSON formatter, at the cost of more boilerplate.
- Somewhere to send the output: a file per run is enough to start; a log system with field queries — Loki, OpenSearch, CloudWatch — is what makes it pay off.
- A stable spatial key for the unit of work: a quadkey, a tile index, a delivery tile name.

## Step-by-Step

### 1. Configure once, JSON out

```python
import logging
import sys
import structlog

def configure_logging(level="INFO", json_output=True):
    shared = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    renderer = (structlog.processors.JSONRenderer() if json_output
                else structlog.dev.ConsoleRenderer(colors=True))
    structlog.configure(
        processors=shared + [renderer],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level)),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    return structlog.get_logger()

log = configure_logging(json_output=not sys.stdout.isatty())
```

One switch decides the renderer: JSON when the output is a pipe or a file, human-readable colours when a developer is watching a terminal. That keeps the same call sites useful in both settings, which is what stops people adding `print` statements alongside the logger.

`format_exc_info` matters more than it looks. It turns an exception into structured fields rather than a multi-line traceback embedded in a JSON string, so a failure is searchable by exception type across runs.

### 2. Bind the run context, not every call

```python
import os
import uuid
from datetime import datetime, timezone

def start_run(dataset, crs, delivery_date):
    run_id = os.environ.get("CI_JOB_ID") or uuid.uuid4().hex[:12]
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        run_id=run_id,
        dataset=dataset,
        crs=crs,
        delivery_date=delivery_date,
        pipeline_version=os.environ.get("GIT_SHA", "dev"),
        host=os.uname().nodename,
        started=datetime.now(timezone.utc).isoformat(),
    )
    log.info("run.start")
    return run_id

run_id = start_run("city", "EPSG:25832+7837", "2026-09-15")
```

Context variables attach these fields to every subsequent event in the same task or thread, so no call site has to remember them. The CRS is in there deliberately: half the confusing incidents in a spatial pipeline come down to coordinates in an unexpected system, and having it on every line means the question "what CRS was this run in?" is never open.

Using the CI job identifier when there is one links logs to the build that produced them without a separate correlation step.

### 3. Name events like data, not like sentences

```python
def tile_shard(shard, features):
    bound = log.bind(shard=shard, feature_count=len(features))
    bound.info("shard.start")
    try:
        result = do_tiling(shard, features)
    except Exception:
        bound.exception("shard.failed")           # exc_info captured as fields
        raise
    bound.info("shard.done", triangles=result.triangles, bytes=result.bytes,
               duration_s=round(result.seconds, 2), geometric_error=result.geometric_error)
    return result
```

An event name like `shard.done` is a stable key that can be counted, filtered and alerted on; `Finished tiling shard 120210233010 in 4.2s` is prose that cannot. The convention that pays off across a pipeline is `noun.verb` in the past tense, one name per meaningful outcome, and every variable part in a field.

`log.bind` returns a logger with extra fields, which is the right tool for a scope narrower than the run — a shard, a delivery file, a retry attempt.

<figure class="diagram">
<svg viewBox="6 16 748 238" role="img" aria-labelledby="slog-fields-t slog-fields-d" xmlns="http://www.w3.org/2000/svg">
  <title id="slog-fields-t">The same failure as prose and as fields</title>
  <desc id="slog-fields-d">On the left, a prose log line stating that tiling failed for a shard with an exception message. On the right, the same event as JSON fields: event name, run identifier, dataset, CRS, shard, feature count, exception type and message. Only the second can answer which shards failed, in which run, with which exception.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="238" fill="#ffffff"/>
  <rect x="20" y="30" width="340" height="180" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="30" width="340" height="180" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="36" y="60">ERROR Failed to tile shard</text>
    <text x="36" y="80">120210233010: ValueError:</text>
    <text x="36" y="100">invalid geometry at index 42</text>
    <text x="416" y="60">"event": "shard.failed"</text>
    <text x="416" y="80">"run_id": "ci-88421"</text>
    <text x="416" y="100">"dataset": "city"</text>
    <text x="416" y="120">"crs": "EPSG:25832+7837"</text>
    <text x="416" y="140">"shard": "120210233010"</text>
    <text x="416" y="160">"feature_count": 311</text>
    <text x="416" y="180">"exception": "ValueError"</text>
  </g>
  <text x="190" y="140" fill="#b0413e" font-size="12.5" text-anchor="middle">greppable, not queryable</text>
  <text x="190" y="164" fill="#b0413e" font-size="12.5" text-anchor="middle">counts need regexes</text>
  <text x="190" y="188" fill="#b0413e" font-size="12.5" text-anchor="middle">no run or CRS context</text>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Fields cost nothing to write and turn every incident question into a filter.</text>
</svg>
<figcaption>The information content is nearly the same; the difference is whether a log system can group, count and alert on it.</figcaption>
</figure>

### 4. Sample the chatter, keep the outcomes

```python
import random

class Sampler:
    """Log every event for failures and slow work, a fraction of the routine ones."""
    def __init__(self, rate=0.02, slow_s=30.0, seed=7):
        self.rate, self.slow_s, self.rng = rate, slow_s, random.Random(seed)

    def should_log(self, duration_s=0.0, failed=False):
        return failed or duration_s >= self.slow_s or self.rng.random() < self.rate

sampler = Sampler()

for shard in shards:
    res = tile_shard_quiet(shard)
    if sampler.should_log(res.seconds, res.failed):
        log.info("shard.done", shard=shard, duration_s=round(res.seconds, 2),
                 triangles=res.triangles, sampled=True)
    totals.add(res)
log.info("stage.done", stage="tiling", shards=totals.count, failed=totals.failed,
         triangles=totals.triangles, duration_s=round(totals.seconds, 1),
         p95_shard_s=round(totals.p95, 2))
```

A per-shard line for 4,096 shards across twenty runs a month is a million events that nobody reads and somebody pays to store. Sampling keeps a representative few percent, always keeps failures and slow outliers, and relies on the stage summary for the totals — which is the line that actually gets queried. Seeding the sampler keeps a run reproducible, so re-running a build produces the same log volume.

### 5. Write a run summary that outlives the logs

```python
import json
from pathlib import Path

def write_run_summary(path, run_id, stages, gate_results, outputs):
    summary = {
        "run_id": run_id,
        "finished": datetime.now(timezone.utc).isoformat(),
        "pipeline_version": os.environ.get("GIT_SHA", "dev"),
        "dataset": "city",
        "crs": "EPSG:25832+7837",
        "stages": stages,                       # {"tiling": {"shards": 4096, "failed": 0, "seconds": 812}}
        "gates": gate_results,                  # {"jsonld": "pass", "validator": "pass"}
        "outputs": outputs,                     # {"tileset": "s3://…/tileset.json", "bytes": 1.2e9}
    }
    Path(path).write_text(json.dumps(summary, indent=2))
    log.info("run.summary_written", path=str(path), stages=list(stages))
    return summary

write_run_summary("build/run_summary.json", run_id,
                  stages={"tiling": {"shards": 4096, "failed": 0, "seconds": 812}},
                  gate_results={"validator": "pass", "wordcount": "n/a"},
                  outputs={"tileset": "s3://twin-tiles/city/v42/tileset.json"})
```

Log retention is typically weeks; a twin's questions arrive after months. A summary JSON stored alongside the outputs is small, permanent and enough to answer most of them — which version of the pipeline produced this tileset, how many shards it had, whether the gates passed. It is also what makes the metrics in [exporting Prometheus metrics from tiling jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) reconstructible if the metrics backend loses a day.

<figure class="diagram">
<svg viewBox="6 26 748 178" role="img" aria-labelledby="slog-path-t slog-path-d" xmlns="http://www.w3.org/2000/svg">
  <title id="slog-path-t">From the job's stdout to a query</title>
  <desc id="slog-path-d">The job writes JSON lines to standard output. The platform's collector ships them to a log store, where fields are indexed and can be filtered by run identifier, shard or event name. In parallel, the run summary JSON is written next to the outputs in object storage, where it stays after the logs expire.</desc>
  <rect class="svg-bg" x="6" y="26" width="748" height="178" fill="#ffffff"/>
  <defs>
    <marker id="slog-path-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="40" width="130" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="200" y="40" width="130" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="380" y="40" width="150" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="580" y="40" width="160" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="200" y="140" width="330" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#slog-path-arrow)">
    <path d="M150 68 H198"/><path d="M330 68 H378"/><path d="M530 68 H578"/>
    <path d="M85 96 C85 165 150 165 198 165"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="64">job stdout</text><text x="85" y="82">JSON lines</text>
    <text x="265" y="64">collector</text><text x="265" y="82">ships lines</text>
    <text x="455" y="64">log store</text><text x="455" y="82">fields indexed</text>
    <text x="660" y="64">filter by run,</text><text x="660" y="82">shard, event</text>
    <text x="365" y="162">run summary JSON, stored with the outputs</text>
    <text x="365" y="180">— outlives the log retention</text>
  </g>
</svg>
<figcaption>Writing to stdout and letting the platform ship it keeps the job simple; the summary takes the separate path that survives retention.</figcaption>
</figure>

### 6. Query it

```python
import json
from collections import Counter

def shards_missing(log_path, expected):
    seen, failed = set(), Counter()
    for line in Path(log_path).read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("event") == "shard.done":
            seen.add(rec["shard"])
        elif rec.get("event") == "shard.failed":
            failed[rec["shard"]] += 1
    return sorted(set(expected) - seen - set(failed)), failed

missing, failed = shards_missing("build/run.log", expected_shards)
print(f"{len(missing)} shards with no outcome logged, {len(failed)} failed")
```

With sampling in place, `shard.done` is not emitted for every shard, so this query works against a run with sampling disabled — which is exactly what you turn on when investigating. Keeping a `--log-every-shard` flag in the pipeline, off by default, is the cheapest debugging affordance available.

<figure class="diagram">
<svg viewBox="26 32 648 186" role="img" aria-labelledby="slog-vol-t slog-vol-d" xmlns="http://www.w3.org/2000/svg">
  <title id="slog-vol-t">Log volume with and without sampling</title>
  <desc id="slog-vol-d">Bars comparing log lines per run. Logging every shard event produces about twelve thousand lines. Sampling two percent of routine events while always keeping failures and slow outliers produces about three hundred, plus one stage summary. The queries that matter run against the summary and the kept outliers.</desc>
  <rect class="svg-bg" x="26" y="32" width="648" height="186" fill="#ffffff"/>
  <path d="M40 30 V170" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="40" y="46" width="620" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="110" width="26" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="60" y="70">every shard: ~12,000 lines per run</text>
    <text x="78" y="134">sampled: ~300 lines + 1 stage summary</text>
  </g>
  <text x="380" y="200" fill="#15384a" font-size="12.5" text-anchor="middle">Failures and slow outliers are never sampled away, so nothing diagnostic is lost.</text>
</svg>
<figcaption>Sampling is what makes per-unit logging affordable at city scale without giving up the events an incident needs.</figcaption>
</figure>

## Expected Output & Verification

```text
{"event": "run.start", "level": "info", "timestamp": "2026-09-17T02:00:04Z", "run_id": "ci-88421", "dataset": "city", "crs": "EPSG:25832+7837", "delivery_date": "2026-09-15", "pipeline_version": "1f6e183", "host": "build-07"}
{"event": "shard.done", "level": "info", "timestamp": "2026-09-17T02:11:52Z", "run_id": "ci-88421", "dataset": "city", "crs": "EPSG:25832+7837", "shard": "120210233010", "feature_count": 311, "triangles": 12408, "bytes": 982144, "duration_s": 4.2, "sampled": true}
{"event": "stage.done", "level": "info", "timestamp": "2026-09-17T02:14:16Z", "run_id": "ci-88421", "stage": "tiling", "shards": 4096, "failed": 0, "triangles": 50104882, "duration_s": 812.4, "p95_shard_s": 6.8}
```

Verify that the logs answer the questions they exist for. Three assertions, run against a real log file in CI, are enough:

```python
lines = [json.loads(l) for l in Path("build/run.log").read_text().splitlines() if l.startswith("{")]
events = Counter(r["event"] for r in lines)

assert events["run.start"] == 1, "exactly one run.start per run"
assert all({"run_id", "dataset", "crs"} <= set(r) for r in lines), "context missing from some events"
stage = next(r for r in lines if r["event"] == "stage.done" and r["stage"] == "tiling")
assert stage["shards"] == 4096 and stage["failed"] == 0
print("log contract satisfied:", dict(events))
```

Asserting the *contract* rather than the content is what keeps logging useful over time. A refactor that drops the context binding, or renames an event, breaks a test instead of quietly removing the field an alert depends on.

## Performance Notes

- **JSON rendering costs microseconds**, which is irrelevant next to any spatial operation. Do not optimise logging; optimise log *volume*.
- **Bind once, not per call.** Context variables are cheap to read and the alternative — passing fields through every function — is what leads people back to prose messages.
- **Write to stdout and let the platform ship it.** A pipeline that writes its own log files, rotates them and uploads them is reinventing the part of the stack that already works.
- **Sample per unit of work, never per stage.** Losing a stage summary costs the query that matters most.
- **Keep the summary JSON small** — kilobytes — so it can live next to the outputs forever without anyone deciding to clean it up.

## Common Errors

**Every worker logs the same shard.** Multiprocessing workers inherit the parent's context variables at fork and then bind their own; if a shard key is bound before the fan-out, every child carries it. Bind inside the worker.

**Context disappears in a thread pool.** `contextvars` do not propagate into threads started before the binding. Bind inside the thread's entry point, or pass the fields explicitly to the worker.

**Logs are JSON but unsearchable.** The fields are nested inside one `message` string because a formatter serialised the event dict into text. Check that the collector is parsing JSON rather than treating the line as a message.

**Timestamps are in local time.** Comparing runs across a daylight-saving change becomes guesswork. Use ISO 8601 in UTC, as the configuration above does.

## Frequently Asked Questions

### Is `structlog` necessary, or will `logging` do?

`logging` with `python-json-logger` and a `LoggerAdapter` produces the same output with more code. `structlog`'s context variables and `bind` are the parts worth having; if a project already standardises on `logging`, keep it and add a JSON formatter.

### How long should logs be kept?

Long enough to investigate what users report, which is usually 30–90 days. The permanent record is the run summary, not the log stream.

### Should logs carry geometry?

No. A bounding box as four numbers is useful; a WKT polygon in a log line is not, and a log line per feature will bury everything else. Geometry belongs in the outputs and in the change report.

### What about logging from inside PDAL or GDAL?

Their native logs go to stderr and are not structured. Capture them per stage, attach the tail to a `stage.failed` event when something goes wrong, and do not attempt to parse them routinely.

## Related Guides

- [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/) — how logs, metrics and traces divide the work
- [Exporting Prometheus Metrics from Tiling Jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) — the numeric counterpart to the stage summary
- [Tracing Pipeline Stages with OpenTelemetry](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/tracing-pipeline-stages-with-opentelemetry/) — linking events across processes

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
