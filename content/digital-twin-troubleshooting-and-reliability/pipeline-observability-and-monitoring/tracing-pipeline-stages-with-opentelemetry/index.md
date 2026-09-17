# Tracing Pipeline Stages with OpenTelemetry

This page traces a spatial pipeline that spans several processes and hours — one span per run, per stage and per shard, context propagated across process and scheduler boundaries, spatial keys and delivery identifiers as span attributes, failures recorded as span status, and trace identifiers written into the structured logs so the two views join.

## Why you hit this

Metrics tell you a stage took forty minutes. Logs tell you which shards it processed. Neither tells you that thirty of those minutes were one shard waiting on an object-store read, inside a worker started by a different process, on a run triggered by Monday's delivery. A trace does, and for a pipeline whose stages run as separate jobs it is the only artefact that shows the whole shape of a run. The division of labour between the three signals is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Python 3.10+ with `opentelemetry-sdk>=1.25`, `opentelemetry-exporter-otlp>=1.25`, and `opentelemetry-instrumentation-requests` if the pipeline calls HTTP APIs.
- A collector endpoint: an OpenTelemetry Collector forwarding to Tempo, Jaeger or a hosted backend. A local Jaeger container is enough to start.
- The structured logging from [structured logging for spatial pipelines](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/structured-logging-for-spatial-pipelines/), so trace identifiers can be added to log events.

## Step-by-Step

### 1. Set up the tracer with resource attributes

```python
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

def init_tracing(service_name, dataset):
    resource = Resource.create({
        "service.name": service_name,                 # "twin-tiler", "twin-classifier"
        "service.version": os.environ.get("GIT_SHA", "dev"),
        "deployment.environment": os.environ.get("ENV", "prod"),
        "twin.dataset": dataset,
    })
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # endpoint from OTEL_EXPORTER_OTLP_ENDPOINT
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service_name)

tracer = init_tracing("twin-tiler", "city")
```

Resource attributes describe the *process*, so they belong here rather than on every span: the service, its version and the dataset it works on. Putting the pipeline's git SHA in `service.version` is what lets a backend answer "did runs get slower after the deploy on Tuesday", which is one of the few questions traces answer better than metrics.

A batch processor is the right exporter for a pipeline: spans are buffered and sent in the background, so instrumentation never blocks the work, and a flush at exit sends what is left.

### 2. One span per level that matters

```python
def run_pipeline(dataset, delivery, shards):
    with tracer.start_as_current_span("pipeline.run") as run:
        run.set_attribute("twin.dataset", dataset)
        run.set_attribute("twin.delivery_id", delivery["id"])
        run.set_attribute("twin.delivery_captured", delivery["captured"])
        run.set_attribute("twin.crs", "EPSG:25832+7837")
        run.set_attribute("twin.shards_planned", len(shards))

        classified = stage_classify(dataset, delivery)
        meshed = stage_mesh(dataset, classified)
        written = stage_tile(dataset, meshed, shards)

        run.set_attribute("twin.shards_written", written)
        return written

def stage_tile(dataset, meshes, shards):
    with tracer.start_as_current_span("stage.tile") as stage:
        stage.set_attribute("twin.stage", "tile")
        written = 0
        for shard in shards:
            with tracer.start_as_current_span("shard.tile") as s:
                s.set_attribute("twin.shard", shard)
                try:
                    res = tile_shard(shard, meshes)
                except Exception as exc:
                    s.record_exception(exc)
                    s.set_status(trace.Status(trace.StatusCode.ERROR, str(exc)))
                    continue
                s.set_attribute("twin.triangles", res.triangles)
                s.set_attribute("twin.bytes", res.bytes)
                written += 1
        stage.set_attribute("twin.shards_written", written)
        return written
```

Three levels — run, stage, unit of work — is the structure that makes a trace readable. Deeper nesting is tempting and rarely pays off; a span per PDAL filter inside a shard produces a trace nobody can scan.

`record_exception` plus `set_status` is the pair that makes failures visible in a backend's UI, where an errored span is highlighted and searchable. Setting only the status loses the stack; recording only the exception leaves the span looking successful.

<figure class="diagram">
<svg viewBox="6 12 738 226" role="img" aria-labelledby="otel-tree-t otel-tree-d" xmlns="http://www.w3.org/2000/svg">
  <title id="otel-tree-t">A run trace, three levels deep</title>
  <desc id="otel-tree-d">A Gantt-style span tree. The run span covers the whole duration. Under it, classify, mesh and tile stages run in sequence. Under the tile stage, shard spans run in parallel across workers, and one of them is marked as errored and much longer than its siblings, which is what a trace makes immediately visible.</desc>
  <rect class="svg-bg" x="6" y="12" width="738" height="226" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="130" y="26" width="600" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="150" y="58" width="130" height="22" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="285" y="58" width="180" height="22" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="470" y="58" width="250" height="22" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="475" y="90" width="60" height="18" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="475" y="114" width="52" height="18" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="540" y="90" width="58" height="18" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="532" y="114" width="64" height="18" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="600" y="90" width="55" height="18" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="475" y="138" width="230" height="18" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="20" y="43">pipeline.run</text>
    <text x="20" y="74">stages</text>
    <text x="20" y="104">shard.tile</text>
    <text x="20" y="151">errored shard</text>
    <text x="160" y="74">classify</text>
    <text x="295" y="74">mesh</text>
    <text x="480" y="74">tile</text>
  </g>
  <text x="475" y="174" fill="#b0413e" font-size="12">retried three times, then failed</text>
  <text x="380" y="196" fill="#15384a" font-size="12.5" text-anchor="middle">The long red span is invisible in metrics — the stage total barely moved — and obvious here.</text>
  <text x="380" y="220" fill="#5b6471" font-size="12" text-anchor="middle">time →</text>
</svg>
<figcaption>A trace shows distribution and concurrency, which is exactly what an average duration hides.</figcaption>
</figure>

### 3. Propagate context across processes

Stages usually run as separate jobs, so the trace has to be carried between them. OpenTelemetry does that with a text carrier — in a pipeline, an environment variable or a field in the job payload.

```python
from opentelemetry.propagate import inject, extract

def launch_next_stage(stage_cmd, env=None):
    carrier = {}
    inject(carrier)                                   # writes "traceparent" from the current span
    env = {**(env or os.environ), **{f"OTEL_CARRIER_{k.upper()}": v for k, v in carrier.items()}}
    subprocess.run(stage_cmd, env=env, check=True)

def resume_trace():
    carrier = {k[len("OTEL_CARRIER_"):].lower(): v
               for k, v in os.environ.items() if k.startswith("OTEL_CARRIER_")}
    return extract(carrier)                           # a Context to use as the parent

# in the child process:
parent = resume_trace()
with tracer.start_as_current_span("stage.tile", context=parent) as stage:
    ...
```

`traceparent` is the W3C header that carries the trace and span identifiers, and injecting it into the child's environment is the pipeline equivalent of an HTTP header. Without propagation each job produces its own disconnected trace, which is still useful and loses the ability to see a whole run.

For a scheduler that passes JSON payloads — Airflow, Argo, a queue — put the carrier in the payload instead; it is two string fields and survives retries.

<figure class="diagram">
<svg viewBox="6 26 748 182" role="img" aria-labelledby="otel-prop-t otel-prop-d" xmlns="http://www.w3.org/2000/svg">
  <title id="otel-prop-t">Carrying trace context between jobs</title>
  <desc id="otel-prop-d">The first job creates the run span and injects a traceparent value into the environment or payload it passes on. Each subsequent job extracts it and starts its stage span as a child, so all three jobs appear in one trace. Without the carrier, each job produces a separate trace with no link between them.</desc>
  <rect class="svg-bg" x="6" y="26" width="748" height="182" fill="#ffffff"/>
  <defs>
    <marker id="otel-prop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="40" width="190" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="285" y="40" width="190" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="550" y="40" width="190" height="66" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#otel-prop-arrow)">
    <path d="M210 73 H283"/><path d="M475 73 H548"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="115" y="66">job 1: classify</text><text x="115" y="88">creates the run span</text>
    <text x="380" y="66">job 2: mesh</text><text x="380" y="88">extracts, starts a child</text>
    <text x="645" y="66">job 3: tile</text><text x="645" y="88">extracts, starts a child</text>
  </g>
  <g fill="#5b6471" font-size="11.5">
    <text x="214" y="62">traceparent</text>
    <text x="479" y="62">traceparent</text>
  </g>
  <rect x="20" y="150" width="720" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="380" y="170" fill="#1f2937" font-size="12.5" text-anchor="middle">without the carrier: three unrelated traces, no way to see the run as one thing</text>
  <text x="380" y="188" fill="#1f2937" font-size="12.5" text-anchor="middle">and no way to attribute the run's total duration to its stages</text>
</svg>
<figcaption>Propagation is two string fields passed along with the work; it is the difference between three traces and one run.</figcaption>
</figure>

### 4. Put the trace identifier in the logs

```python
import structlog
from opentelemetry import trace as otel_trace

def add_trace_ids(logger, method_name, event_dict):
    span = otel_trace.get_current_span()
    ctx = span.get_span_context()
    if ctx and ctx.is_valid:
        event_dict["trace_id"] = format(ctx.trace_id, "032x")
        event_dict["span_id"] = format(ctx.span_id, "016x")
    return event_dict

structlog.configure(processors=[
    structlog.contextvars.merge_contextvars,
    add_trace_ids,
    structlog.processors.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.JSONRenderer(),
])
```

This single processor is what makes the two systems one. From a slow span in the trace UI, the `trace_id` filters the logs to exactly that unit of work; from a suspicious log line, the same identifier opens the trace. Without it, correlating them means comparing timestamps across machines.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="otel-attr-t otel-attr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="otel-attr-t">Where each piece of context belongs</title>
  <desc id="otel-attr-d">A table. The service name, version and environment belong on the resource, set once per process. The dataset, delivery identifier and CRS belong on the run span. The stage name belongs on the stage span. The shard key, triangle count and byte count belong on the unit-of-work span. Retries and cache misses belong on span events rather than on new spans.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="520" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="56" width="520" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="90" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="90" width="520" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="124" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="124" width="520" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="158" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="158" width="520" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="192" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="220" y="192" width="520" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="43">carrier</text>
    <text x="480" y="43">what goes there</text>
    <text x="120" y="78">resource</text><text x="480" y="78">service.name, service.version, deployment.environment</text>
    <text x="120" y="112">run span</text><text x="480" y="112">twin.dataset, twin.delivery_id, twin.crs, shards planned</text>
    <text x="120" y="146">stage span</text><text x="480" y="146">twin.stage, shards written by that stage</text>
    <text x="120" y="180">unit span</text><text x="480" y="180">twin.shard, triangles, bytes, status</text>
    <text x="120" y="214">span events</text><text x="480" y="214">retries, cache misses, fallbacks — not new spans</text>
  </g>
</svg>
<figcaption>Putting context at the right level keeps span counts low and makes every attribute searchable at the granularity it belongs to.</figcaption>
</figure>

### 5. Add span events for things that are not spans

```python
def tile_shard_with_retries(shard, meshes, attempts=3):
    span = otel_trace.get_current_span()
    for attempt in range(1, attempts + 1):
        try:
            return tile_shard(shard, meshes)
        except TransientStorageError as exc:
            span.add_event("retry", {"attempt": attempt, "reason": type(exc).__name__})
            time.sleep(2 ** attempt)
    span.set_status(otel_trace.Status(otel_trace.StatusCode.ERROR, "exhausted retries"))
    raise RuntimeError(f"{shard}: exhausted retries")
```

Span events are timestamped annotations inside a span — retries, cache misses, a fallback path taken. They keep the span count low while preserving the detail that explains a long span, which is usually "it retried twice against object storage".

### 6. Flush before the process exits

```python
import atexit

def flush_tracing(timeout_ms=30_000):
    provider = otel_trace.get_tracer_provider()
    if hasattr(provider, "force_flush"):
        provider.force_flush(timeout_ms)
    if hasattr(provider, "shutdown"):
        provider.shutdown()

atexit.register(flush_tracing)
```

A batch processor holds spans in memory for a few seconds. A pipeline job that exits immediately after its last span loses them, which produces traces that end abruptly and stages that appear to have no children. Flushing at exit is one line and the most common omission in batch tracing.

## Expected Output & Verification

```text
pipeline.run            2h 14m   twin.dataset=city  twin.delivery_id=DLV-2026-0915  twin.shards_planned=4096
├─ stage.classify         18m    twin.stage=classify
├─ stage.mesh             41m    twin.stage=mesh
└─ stage.tile           1h 13m   twin.stage=tile  twin.shards_written=4096
   ├─ shard.tile          4.2s   twin.shard=120210233010  twin.triangles=12408
   ├─ shard.tile          4.8s   twin.shard=120210233011
   └─ shard.tile         42.0s   twin.shard=120210233012  events: retry×2   ERROR
```

Verify the trace is complete and connected, which is the property that breaks silently:

```python
from collections import Counter

import requests

def trace_summary(tempo_url, trace_id):
    r = requests.get(f"{tempo_url}/api/traces/{trace_id}", timeout=20)
    r.raise_for_status()
    spans = [s for batch in r.json()["batches"] for ss in batch["scopeSpans"] for s in ss["spans"]]
    names = Counter(s["name"] for s in spans)
    roots = [s for s in spans if not s.get("parentSpanId")]
    errored = [s for s in spans if s.get("status", {}).get("code") == 2]
    return {"spans": len(spans), "names": dict(names), "roots": len(roots), "errors": len(errored)}

summary = trace_summary("http://tempo:3200", trace_id)
print(summary)
assert summary["roots"] == 1, "more than one root span: context was not propagated"
assert summary["names"].get("stage.tile", 0) == 1, "the tiling stage is missing from the trace"
```

Exactly one root span is the test that propagation worked. Three roots means each job traced itself, which is the default failure and is invisible unless asserted. The error count gives the run's failed shards without touching the logs.

## Performance Notes

- **Span creation is sub-microsecond**; the export is asynchronous. A span per shard on four thousand shards is negligible against the tiling itself.
- **Do not span per feature.** Forty thousand spans in a run make traces unusable and start to cost real memory in the batch queue. Use span events or metrics for that granularity.
- **Sample everything.** Pipelines produce a handful of traces a day, so head sampling at 100% is correct — the sampling defaults tuned for web traffic would throw away the only trace you have.
- **Bound the attribute values.** An attribute holding a list of four thousand shard identifiers is a span that no backend will render; put the count on the span and the identities in logs.
- **Flush at exit**, and set a timeout so a collector outage delays the job by seconds rather than blocking it.

## Common Errors

**Each job appears as its own trace.** The carrier was not injected, or the child read it before `init_tracing` ran. Extract first, then start the span with that context.

**Spans disappear for short-lived jobs.** No flush at exit. Register `atexit`, and prefer `force_flush` over relying on interpreter shutdown ordering.

**The trace has thousands of spans and the UI will not open it.** A span per feature or per file. Collapse to one span per unit of work and use events.

**Attributes are dropped by the backend.** Most backends limit attribute count and value length. Keep to a dozen short attributes per span; anything larger belongs in logs or the run summary.

**`OTEL_EXPORTER_OTLP_ENDPOINT` is set and nothing arrives.** The exporter defaults to gRPC on port 4317 while the collector listens for HTTP on 4318, or TLS is expected. Try the HTTP exporter explicitly when in doubt.

## Frequently Asked Questions

### Is tracing worth it for a nightly batch pipeline?

Yes, for two specific questions: where a long run spent its time, and what happened to one shard. Both are painful with logs alone and immediate with a trace. It is not worth instrumenting below the unit of work.

### Jaeger, Tempo or a hosted backend?

Any of them; the instrumentation is identical because it is OTLP. Tempo is convenient when Grafana is already in place, Jaeger is the simplest to run locally, and a hosted backend saves operating it. Retention of a few weeks is plenty.

### Can traces replace the run summary?

No. A backend's retention is weeks, and the run summary has to answer questions months later. They serve different time horizons; keep both.

### How do traces interact with retries at the scheduler level?

A retried job re-extracts the same carrier and produces a second set of stage spans under the same run, which is exactly what you want to see. Tag the attempt number as a span attribute so the two are distinguishable.

## Related Guides

- [Structured Logging for Spatial Pipelines](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/structured-logging-for-spatial-pipelines/) — the per-unit detail traces link to
- [Exporting Prometheus Metrics from Tiling Jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) — the aggregate view
- [Profiling PDAL Pipelines with cProfile and py-spy](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/profiling-pdal-pipelines-with-cprofile-and-py-spy/) — when a span says where but not why

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
