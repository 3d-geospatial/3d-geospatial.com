# Pipeline Observability and Monitoring

A digital twin pipeline is a long chain of batch jobs that each take minutes to hours, run on a schedule, and fail in ways that do not raise exceptions: a tiling job that silently skipped a district, a delivery whose classification codes changed, a tileset that has been serving 404s from one CDN region for a week. Unit tests do not catch any of that, and neither does a green build. This guide covers making the pipeline observable — logs that carry the spatial context, metrics per stage, traces that link a tile back to the survey it came from, alerts on what users actually experience, and freshness objectives that say out loud how old the twin is allowed to be.

It is written for the engineers who run the pipelines built in [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) and who get the call when a city's twin looks wrong. Examples use EPSG:25832 for the data and Prometheus, OpenTelemetry and CDN logs for the telemetry.

## Prerequisites

- Python 3.10+ with `structlog>=24.1`, `prometheus-client>=0.20`, `opentelemetry-sdk>=1.25` and `opentelemetry-exporter-otlp>=1.25`.
- Somewhere to send telemetry: a Prometheus instance or a push gateway for batch jobs, and an OTLP endpoint for traces. A single-node Prometheus with Grafana is enough to start.
- Access to the CDN's or tile server's access logs.
- Agreement with whoever owns the twin about how fresh it has to be — the number that turns monitoring into an objective rather than a dashboard.

## Concept

Observability for spatial pipelines differs from the usual web-service kind in three ways, and each changes what you instrument.

**The unit of work is a tile or a tile set, not a request.** A job either processes 4,096 shards correctly or processes 4,090 and reports success. So the metric that matters is a *count with an expected value*, and the alert fires on the difference rather than on an error rate.

**Failures are often silent and geographic.** A district missing from a build is invisible in aggregate statistics and obvious on a map. Metrics and logs therefore need the spatial key — the shard, the quadkey, the tile identifier — as a first-class field, not buried in a message string.

**Latency is measured in hours, not milliseconds.** Nobody watches a request trace; the useful trace spans a pipeline run, from the delivery that arrived on Monday to the tileset that published on Tuesday. That makes the data's *age* the headline metric, and the pipeline's duration a secondary one.

<figure class="diagram">
<svg viewBox="-4 46 768 236" role="img" aria-labelledby="obs-arch-t obs-arch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="obs-arch-t">What to instrument along a twin pipeline</title>
  <desc id="obs-arch-d">A pipeline from delivery through classification, meshing, tiling and publishing to the viewer. Each stage emits structured logs with the shard key, counters and duration histograms, and a trace span linked to the run. The CDN emits access logs that feed error-rate alerts, and a freshness metric spans from the delivery date to what the viewer currently serves.</desc>
  <rect class="svg-bg" x="-4" y="46" width="768" height="236" fill="#ffffff"/>
  <defs>
    <marker id="obs-arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="60" width="110" height="54" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="60" width="110" height="54" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="290" y="60" width="110" height="54" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="60" width="110" height="54" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="570" y="60" width="180" height="54" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="150" y="160" width="390" height="46" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="570" y="160" width="180" height="46" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="10" y="226" width="740" height="42" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#obs-arch-arrow)">
    <path d="M120 87 H148"/><path d="M260 87 H288"/><path d="M400 87 H428"/><path d="M540 87 H568"/>
    <path d="M345 158 V118"/>
    <path d="M660 158 V118"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="82">delivery</text><text x="65" y="100">arrives</text>
    <text x="205" y="82">classify</text><text x="205" y="100">and filter</text>
    <text x="345" y="82">mesh and</text><text x="345" y="100">decimate</text>
    <text x="485" y="82">tile and</text><text x="485" y="100">validate</text>
    <text x="660" y="82">publish to CDN</text><text x="660" y="100">and viewer</text>
    <text x="345" y="180">per stage: counters with expected values,</text>
    <text x="345" y="198">duration histograms, logs keyed by shard</text>
    <text x="660" y="180">CDN logs: status codes</text>
    <text x="660" y="198">per tileset version</text>
    <text x="380" y="252">one trace per run, spanning delivery to publish — and a freshness metric across the whole chain</text>
  </g>
</svg>
<figcaption>Instrumentation follows the pipeline's own shape: per-stage counts and durations, one trace per run, and a freshness measure that spans everything.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="6 6 748 224" role="img" aria-labelledby="obs-three-t obs-three-d" xmlns="http://www.w3.org/2000/svg">
  <title id="obs-three-t">What each signal is for in a spatial pipeline</title>
  <desc id="obs-three-d">Three columns. Logs answer what happened to one shard, are queried by field and kept for weeks. Metrics answer whether the run produced everything and how long stages take, are alerted on and kept for months. Traces answer where a long run spent its time and are kept for weeks. The run summary answers what produced this tileset and is kept forever.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="224" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="175" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="195" y="20" width="175" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="370" y="20" width="175" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="545" y="20" width="195" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="175" height="120" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="195" y="56" width="175" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="370" y="56" width="175" height="120" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="545" y="56" width="195" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="107" y="43">logs</text>
    <text x="282" y="43">metrics</text>
    <text x="457" y="43">traces</text>
    <text x="642" y="43">run summary</text>
    <text x="107" y="84">what happened</text><text x="107" y="102">to this shard</text>
    <text x="282" y="84">did the run make</text><text x="282" y="102">everything, how fast</text>
    <text x="457" y="84">where the hours</text><text x="457" y="102">actually went</text>
    <text x="642" y="84">what produced</text><text x="642" y="102">this tileset</text>
    <text x="107" y="140">queried by field</text><text x="107" y="160">weeks</text>
    <text x="282" y="140">alerted on</text><text x="282" y="160">months</text>
    <text x="457" y="140">read after incidents</text><text x="457" y="160">weeks</text>
    <text x="642" y="140">stored with the output</text><text x="642" y="160">forever</text>
  </g>
  <text x="380" y="212" fill="#15384a" font-size="12.5" text-anchor="middle">The retention row is the one usually forgotten: only the summary answers questions a year later.</text>
</svg>
<figcaption>Four artefacts with four jobs and four lifetimes; using one for another's purpose is what makes observability feel expensive.</figcaption>
</figure>

## Structured Logs with Spatial Context

A log line that says `processing failed` is a dead end. One that carries the run, the stage, the shard and the counts is a query.

```python
import structlog

structlog.configure(processors=[
    structlog.contextvars.merge_contextvars,
    structlog.processors.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

structlog.contextvars.bind_contextvars(run_id="2026-09-17T02:00Z", crs="EPSG:25832+7837")
log.info("shard.tiled", shard="120210233010", buildings=311, triangles=12408,
         bytes=982_144, duration_s=4.2)
```

**Key Practice:** Bind the run identifier and the CRS once per run in context variables, and put the shard key on every line that concerns one. Then "which shards did this run touch and how long did each take" is a log query rather than an archaeology exercise, and a district that vanished from a build can be found by its absence. The details are in [structured logging for spatial pipelines](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/structured-logging-for-spatial-pipelines/).

## Metrics with Expected Values

The single most valuable metric in a spatial pipeline is not a rate or a latency. It is a pair: how many units were processed, and how many should have been.

```python
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, push_to_gateway

registry = CollectorRegistry()
shards_expected = Gauge("twin_shards_expected", "shards in the build plan", ["dataset"], registry=registry)
shards_written = Counter("twin_shards_written_total", "shards written", ["dataset"], registry=registry)
stage_seconds = Histogram("twin_stage_duration_seconds", "stage duration", ["dataset", "stage"],
                          buckets=(1, 5, 15, 60, 300, 900, 3600), registry=registry)

shards_expected.labels("city").set(4096)
with stage_seconds.labels("city", "tiling").time():
    written = run_tiling()
shards_written.labels("city").inc(written)
push_to_gateway("pushgw.internal:9091", job="twin-tiling", registry=registry)
```

Batch jobs need the push gateway rather than a scrape endpoint, because they exit; a pipeline that pushes at the end of each stage gives the same series a service would produce. The alert then compares the two series: `twin_shards_written_total < twin_shards_expected` for the latest run is a real, specific failure, and it catches the silent partial build that nothing else does.

**Key Practice:** Every count needs an expected value recorded next to it in the same run. A count on its own can only be compared with history, which fails on the first legitimate change of scope — a new district, a smaller delivery — while a count against a plan is correct on the first run. The full metric set is in [exporting Prometheus metrics from tiling jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/).

## Tracing a Run End to End

Metrics say a stage was slow; traces say which shard and which sub-step. For a pipeline that runs for hours across several processes, a trace is also the only artefact that ties a published tile back to the delivery it came from.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

trace.set_tracer_provider(TracerProvider())
trace.get_tracer_provider().add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
tracer = trace.get_tracer("twin.pipeline")

with tracer.start_as_current_span("run") as run_span:
    run_span.set_attribute("twin.dataset", "city")
    run_span.set_attribute("twin.delivery_date", "2026-09-15")
    for shard in shards:
        with tracer.start_as_current_span("shard.tile") as s:
            s.set_attribute("twin.shard", shard)
            tile_shard(shard)
```

**Key Practice:** Put the spatial key and the source delivery on the span attributes, not just in the span name. A trace backend can then answer "show me every stage that touched shard 1202… in the last month", which is the question asked when one district looks wrong. The instrumentation across process boundaries is covered in [tracing pipeline stages with OpenTelemetry](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/tracing-pipeline-stages-with-opentelemetry/).

## Alerting on What Users Experience

Pipeline health is a means; what users experience is the end. For a twin, that is almost entirely about whether tiles load.

```python
import gzip
import json
from collections import Counter

def cdn_status_summary(log_path):
    per_version, statuses = Counter(), Counter()
    with gzip.open(log_path, "rt") as f:
        for line in f:
            rec = json.loads(line)
            if "/tilesets/" not in rec["uri"]:
                continue
            version = rec["uri"].split("/tilesets/")[1].split("/")[0]
            statuses[(version, rec["status"])] += 1
            per_version[version] += 1
    for (version, status), n in sorted(statuses.items()):
        if status >= 400:
            print(f"{version} {status}: {n} ({100 * n / per_version[version]:.2f}% of that version)")
    return statuses, per_version
```

**Key Practice:** Alert on the 4xx and 5xx *rate per tileset version*, not in aggregate. A new version with a 3% 404 rate is a broken build even while the overall rate stays under 1% because the old version is still serving most of the traffic — and that is exactly the situation a deploy creates. The alerting thresholds are in [alerting on tile error rates from CDN logs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/alerting-on-tile-error-rates-from-cdn-logs/).

## Freshness as an Objective

"How old is the twin?" is the question stakeholders actually ask, and it deserves a number with a target.

```python
import time
from prometheus_client import Gauge

freshness = Gauge("twin_data_age_seconds", "age of the newest published data", ["dataset", "layer"],
                  registry=registry)

def publish_freshness(dataset, layer, source_captured_at, published_at):
    freshness.labels(dataset, layer).set(time.time() - source_captured_at)
    log.info("layer.published", dataset=dataset, layer=layer,
             capture_to_publish_s=published_at - source_captured_at)
```

Two intervals matter and they are different. **Data age** is now minus when the source was captured — the number a user cares about. **Pipeline latency** is publish time minus capture time, which is the part the team controls. A twin whose buildings are surveyed annually has a data age measured in months and a latency measured in days, and only the second is a performance problem.

**Key Practice:** Set an explicit objective per layer — buildings within 90 days of survey, terrain within 30, sensor status within 5 minutes — and publish the current age against it. An objective converts an endless "is it up to date?" conversation into a metric anybody can read, and the objectives themselves are usually the most useful thing the exercise produces. The mechanics are in [monitoring twin data freshness SLOs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/monitoring-twin-data-freshness-slos/).

<figure class="diagram">
<svg viewBox="12 32 659 208" role="img" aria-labelledby="obs-fresh-t obs-fresh-d" xmlns="http://www.w3.org/2000/svg">
  <title id="obs-fresh-t">Data age against pipeline latency</title>
  <desc id="obs-fresh-d">A timeline. The source is captured, then the pipeline takes two days to publish, which is the pipeline latency. From publication onwards the data ages until the next capture. Data age is measured from capture to now and is dominated by the survey interval, while pipeline latency is the only part the team controls.</desc>
  <rect class="svg-bg" x="12" y="32" width="659" height="208" fill="#ffffff"/>
  <path d="M40 150 H720" fill="none" stroke="#5b6471" stroke-width="2"/>
  <g fill="#1f2937">
    <circle cx="120" cy="150" r="7"/><circle cx="200" cy="150" r="7"/><circle cx="620" cy="150" r="7"/>
  </g>
  <path d="M120 110 H200" fill="none" stroke="#1f6b8a" stroke-width="4"/>
  <path d="M120 70 H520" fill="none" stroke="#9a4f26" stroke-width="4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="182">capture</text>
    <text x="205" y="182">publish</text>
    <text x="520" y="182">now</text>
    <text x="620" y="182">next capture</text>
    <text x="160" y="100">pipeline latency: 2 days — the team's number</text>
    <text x="320" y="60">data age: 74 days — the user's number</text>
  </g>
  <path d="M520 150 V80" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">An objective on the first is a team commitment; an objective on the second is a survey budget.</text>
</svg>
<figcaption>Separating the two stops a monitoring conversation from turning into an argument about survey frequency.</figcaption>
</figure>

## Cross-Section Integration

Observability touches every other part of the twin, and the integration points are specific.

- **With validation gates.** The gates in [data validation and QA gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) produce pass/fail results per build; exporting their counts as metrics turns a one-off decision into a trend, and a slowly rising number of tolerated warnings becomes visible before it becomes a problem.
- **With performance work.** The profiling in [performance profiling and benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/) explains why a stage is slow; the stage duration histogram tells you when it changed, which is usually the more useful half.
- **With change detection.** A pipeline that knows what changed can report it: the dirty shard count from [flagging changed buildings for retiling](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/flagging-changed-buildings-for-retiling/) is both a metric and an explanation for a long run.

**Key Practice:** Emit one machine-readable run summary per pipeline execution — counts, durations, gate results, versions, digests — and store it with the outputs. Dashboards come and go; a JSON file next to the tiles is what lets someone reconstruct what happened a year later.

## Who Reads What

Observability produces artefacts for four different audiences, and a signal with no audience is a cost.

**The on-call engineer** needs alerts that name a specific, actionable failure and a first step. Four or five alerts cover a twin pipeline: an incomplete build, a pipeline that stopped running, a tileset version serving errors, and a freshness objective breached. Anything beyond that becomes noise, and noise is why incidents get missed.

**The pipeline team** needs trends. Stage durations against input size, tolerated warnings per gate, dirty shards per run, and the ratio of reprocessed to new data — all reviewed weekly rather than watched. The pattern these expose is the one nobody notices day to day: a stage whose duration has doubled over three months, a validator whose allowlist keeps growing.

**The twin's owner** needs freshness and coverage. How old is each layer, how much of the city is covered at which level of detail, and how many buildings are missing attributes. These are properties of the *data*, not of the pipeline, and they are what a steering meeting actually asks about.

**The next engineer, a year from now** needs the run summary. Which pipeline version produced this tileset, what its inputs were, which gates passed, how long it took. Everything else will have expired.

**Key Practice:** Write down which audience each signal serves before adding it, and delete signals that serve none. An observability stack with forty dashboards and four alerts nobody trusts is a common and expensive failure mode; the fix is subtraction, not more instrumentation.

## Production Checklist

- [ ] Every log line is JSON with a run identifier, a stage and, where applicable, a shard key.
- [ ] Every stage emits a duration histogram and a processed count with an expected value.
- [ ] Batch jobs push metrics before exiting, and a missing push is itself alerted.
- [ ] One trace per run, with spatial keys and the source delivery on the spans.
- [ ] Tile error rates are tracked per tileset version, with an alert on a new version's rate.
- [ ] Freshness objectives exist per layer, are published as metrics and are reviewed.
- [ ] A run summary JSON is written next to the outputs for every execution.
- [ ] Alerts route to somebody, with a documented first action for each.
- [ ] Dashboards distinguish "pipeline is broken" from "data is old" — they have different owners.

## Starting From Nothing

A twin pipeline with no instrumentation does not need a project to fix it. The order below reaches most of the value in a day's work, and each step is useful on its own.

**First, make the logs JSON and bind the run identifier.** Half an hour of work, and it turns every future incident from a scroll through interleaved worker output into a query. Nothing else on this page helps as much per hour spent.

**Second, count what the run produced against what it planned.** One gauge, one counter and one alert rule. This is the check that catches the silent partial build — the failure mode that has cost every twin programme at least one embarrassing week — and it needs no history to work.

**Third, record the freshness of each layer.** Two timestamps per layer and an objective per layer. It answers the question stakeholders ask most often and ends the recurring argument about whether the twin is current.

**Fourth, alert on tile error rates per version.** This is the only signal that reflects what users experience, and it catches the deploy that broke one path prefix while every pipeline signal stayed green.

**Fifth, write a run summary next to the outputs.** A few kilobytes of JSON that will still be there when the logs, the dashboards and the monitoring vendor have all been replaced.

Tracing comes after all of those, because it answers a narrower question — where a long run spent its time — and it is the most work to set up across process boundaries. A team that has done the first five and skipped tracing is in good shape; one that has a trace backend and no expected-value check is not.

**Key Practice:** Add instrumentation in the order of what an incident would have needed, and stop when the next signal has no audience. Observability work has diminishing returns, and the returns diminish fast after the first five items.

## Troubleshooting Matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| A district is missing from the twin and the build was green | count not checked against an expected value | add the expected-value gauge and alert on the difference |
| Tiles 404 for some users only | one CDN region cached a bad deploy | alert on error rate per version and per region |
| A stage is suddenly twice as slow | input grew, or a dependency changed | compare the duration histogram with the input-size metric |
| Nobody can say how old the data is | no freshness metric | publish data age per layer against an objective |
| A failure is discovered by a user | no alert on the user-facing signal | alert on tile error rates, not only on job exit codes |
| Logs cannot answer which shards ran | shard key inside the message text | put it in a field; the query is then trivial |
| Metrics stop arriving during incidents | the job died before pushing | push per stage, and alert on absence of a push |

## Frequently Asked Questions

### Is Prometheus the right tool for batch pipelines?

With a push gateway, yes, and its query language suits the count-against-expected pattern well. The alternative — writing the same numbers into a database table per run — is also perfectly reasonable and easier to keep for years.

### How much instrumentation is too much?

The test is whether anybody has ever looked at a signal. Three metrics per stage that get read beat thirty that do not. Start with counts, durations and freshness, and add only what an actual incident showed you were missing.

### Should traces cover the whole pipeline or one job?

The whole run, with each job as a child span, linked by a shared run identifier passed through the scheduler. That is more work than instrumenting one job and is the only way to see where a twelve-hour pipeline actually spent its time.

### Do we need to monitor the viewer as well?

The tile error rate covers most of it. Beyond that, client-side timing of first render and tile load, as in [measuring tile load times in the Cesium frame loop](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/measuring-tile-load-times-in-the-cesium-frame-loop/), tells you whether the experience matches what the pipeline thinks it published.

### What belongs in an alert versus a report?

Alert on what needs action within hours: a build that lost a district, a version serving errors, a freshness objective breached. Report weekly on trends — durations, tolerated warnings, dirty-shard counts — because those need attention, not urgency.

## Related Guides

- [Structured Logging for Spatial Pipelines](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/structured-logging-for-spatial-pipelines/) — fields, context and querying
- [Exporting Prometheus Metrics from Tiling Jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) — the metric set and the push gateway
- [Tracing Pipeline Stages with OpenTelemetry](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/tracing-pipeline-stages-with-opentelemetry/) — spans across processes
- [Alerting on Tile Error Rates from CDN Logs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/alerting-on-tile-error-rates-from-cdn-logs/) — the user-facing signal
- [Monitoring Twin Data Freshness SLOs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/monitoring-twin-data-freshness-slos/) — objectives per layer
- [Detecting Data Drift Between Deliveries](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/detecting-data-drift-between-deliveries/) — when the input changes shape

Back to [Digital Twin Troubleshooting & Reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/).
