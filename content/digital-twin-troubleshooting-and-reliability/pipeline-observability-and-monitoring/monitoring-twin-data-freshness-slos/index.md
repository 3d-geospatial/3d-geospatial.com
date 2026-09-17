# Monitoring Twin Data Freshness SLOs

This page defines freshness objectives for the layers of a digital twin and measures them — separating data age from pipeline latency, setting a target per layer rather than one for the twin, computing an error budget that survives a missed nightly run, exposing the current age to the viewer so users can see it, and alerting before an objective is breached rather than after.

## Why you hit this

"Is the twin up to date?" is the most common question a twin gets asked and the one it is least equipped to answer. Terrain was flown last spring, buildings come from a register updated nightly, sensor status is a minute old, and the viewer shows all of it in the same scene with no indication of which is which. Without objectives the conversation has no end; with them, each layer has a number, a target and an owner. The wider context is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Python 3.10+ with `prometheus-client>=0.20`; a Prometheus and an alert route.
- For each layer: when its source was captured, and when the pipeline published it. Both have to be recorded by the pipeline — the file's modification time is not a capture date.
- Agreement on targets with whoever owns the twin. This is the part that takes the meetings, and it is the part that makes the rest useful.

## Step-by-Step

### 1. Separate the two intervals

```python
from dataclasses import dataclass
from datetime import datetime, timezone

@dataclass(frozen=True)
class LayerState:
    layer: str
    captured_at: datetime          # when reality was measured
    published_at: datetime         # when the twin started serving it
    source: str                    # "aerial survey 2026-04", "BAG nightly", "sensor gateway"

    @property
    def latency_s(self):           # what the team controls
        return (self.published_at - self.captured_at).total_seconds()

    @property
    def age_s(self):               # what the user experiences
        return (datetime.now(timezone.utc) - self.captured_at).total_seconds()

state = LayerState(
    layer="buildings",
    captured_at=datetime(2026, 9, 15, 3, 0, tzinfo=timezone.utc),
    published_at=datetime(2026, 9, 16, 5, 42, tzinfo=timezone.utc),
    source="BAG nightly extract",
)
print(f"latency {state.latency_s / 3600:.1f} h, age {state.age_s / 86400:.1f} days")
```

Conflating these two is why freshness discussions go in circles. A twin whose buildings come from an annual survey has a data age of months no matter how fast the pipeline is; complaining about the pipeline will not change it, and a survey-frequency decision will. Conversely, a pipeline that takes four days to publish a nightly extract has a latency problem that no amount of surveying fixes.

### 2. Set a target per layer

```python
TARGETS_S = {
    # layer:        (latency target, age target)
    "terrain":      (14 * 86400,  400 * 86400),     # reflown annually, published within a fortnight
    "buildings":    (2 * 86400,    35 * 86400),     # nightly register, published within two days
    "point_cloud":  (7 * 86400,   400 * 86400),
    "orthophoto":   (5 * 86400,   400 * 86400),
    "sensors":      (300,           900),           # five minutes to publish, fifteen minutes old
    "work_zones":   (3600,        7 * 86400),
}

def objective_status(state):
    lat_target, age_target = TARGETS_S[state.layer]
    return {
        "layer": state.layer,
        "latency_s": state.latency_s, "latency_target_s": lat_target,
        "latency_ok": state.latency_s <= lat_target,
        "age_s": state.age_s, "age_target_s": age_target,
        "age_ok": state.age_s <= age_target,
        "source": state.source,
    }

print(objective_status(state))
```

The targets encode how the data actually behaves. A terrain layer reflown yearly gets an age target of 400 days — slightly more than a year, so a survey a few weeks late does not breach it — and a latency target of two weeks, which is what the processing chain needs. Sensor status gets minutes. Writing them in one table, in seconds, makes them reviewable and prevents the drift where every layer silently inherits "nightly".

<figure class="diagram">
<svg viewBox="70 27 704 239" role="img" aria-labelledby="fresh-targets-t fresh-targets-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fresh-targets-t">Freshness targets by layer, on a log time axis</title>
  <desc id="fresh-targets-d">A log-scale time axis from minutes to a year. Sensor layers target minutes for both latency and age. Work zones target an hour of latency and a week of age. Buildings target two days of latency and about a month of age. Terrain, point clouds and orthophotos target one to two weeks of latency and a bit over a year of age, because they are reflown annually.</desc>
  <rect class="svg-bg" x="70" y="27" width="704" height="239" fill="#ffffff"/>
  <path d="M60 200 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="222">5 min</text><text x="230" y="222">1 h</text><text x="360" y="222">1 day</text>
    <text x="490" y="222">1 month</text><text x="640" y="222">1 year</text>
  </g>
  <g stroke-width="8" fill="none">
    <path d="M100 50 H150" stroke="#4f7a4d"/>
    <path d="M230 80 H430" stroke="#4f7a4d"/>
    <path d="M330 110 H500" stroke="#1f6b8a"/>
    <path d="M400 140 H660" stroke="#9a4f26"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="164" y="55">sensors: publish in 5 min, age &lt; 15 min</text>
    <text x="444" y="85">work zones: publish in 1 h, age &lt; 1 week</text>
    <text x="514" y="115">buildings: publish in 2 days, age &lt; 35 days</text>
    <text x="400" y="170">terrain, point cloud, orthophoto:</text>
    <text x="400" y="188">publish in 1–2 weeks, age &lt; 400 days</text>
  </g>
  <text x="380" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">One target for the whole twin would be wrong for every layer in it.</text>
</svg>
<figcaption>Targets differ by three orders of magnitude between layers, which is why a single "is the twin fresh?" indicator cannot be meaningful.</figcaption>
</figure>

### 3. Publish the metrics

```python
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

def publish_freshness(states, gateway="pushgw.internal:9091"):
    reg = CollectorRegistry()
    age = Gauge("twin_layer_age_seconds", "age of the newest published data",
                ["dataset", "layer", "source"], registry=reg)
    lat = Gauge("twin_layer_publish_latency_seconds", "capture to publish",
                ["dataset", "layer"], registry=reg)
    age_t = Gauge("twin_layer_age_target_seconds", "age objective", ["dataset", "layer"], registry=reg)
    lat_t = Gauge("twin_layer_latency_target_seconds", "latency objective", ["dataset", "layer"], registry=reg)

    for s in states:
        lat_target, age_target = TARGETS_S[s.layer]
        age.labels("city", s.layer, s.source).set(s.age_s)
        lat.labels("city", s.layer).set(s.latency_s)
        age_t.labels("city", s.layer).set(age_target)
        lat_t.labels("city", s.layer).set(lat_target)
    push_to_gateway(gateway, job="twin-freshness", registry=reg, grouping_key={"dataset": "city"})

publish_freshness([state])
```

Publishing the target as its own series, next to the measurement, is what makes the alert rule independent of the code: the rule compares two series and never needs updating when a target changes. It also puts the objective on the same dashboard as the value, so a viewer of the graph does not need to remember what "good" is.

Note that `age` carries the source as a label. It is low cardinality — a handful of survey campaigns — and it answers the immediate follow-up question, which is always "old according to what?".

### 4. Alert before the breach, not after

```yaml
groups:
  - name: twin-freshness
    rules:
      - alert: TwinLayerAgeApproachingTarget
        expr: |
          twin_layer_age_seconds > 0.85 * twin_layer_age_target_seconds
        for: 1h
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.layer }} is at {{ $value | humanizeDuration }}, near its age objective"

      - alert: TwinLayerAgeBreached
        expr: twin_layer_age_seconds > twin_layer_age_target_seconds
        for: 1h
        labels: { severity: critical }

      - alert: TwinLayerPublishSlow
        expr: |
          twin_layer_publish_latency_seconds > twin_layer_latency_target_seconds
        for: 30m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.layer }}: capture-to-publish exceeded its target"

      - alert: TwinFreshnessMetricsMissing
        expr: |
          absent(twin_layer_age_seconds{layer="buildings"})
          or time() - twin_layer_age_seconds{layer="sensors"} < 0
        for: 2h
        labels: { severity: critical }
```

The 85% warning is the rule that earns its place. An age objective of 35 days breached at day 36 is a surprise; a warning at day 30 is a week of notice, which is exactly enough time to chase a delayed delivery. For sensor layers, where the target is minutes, the same fraction gives minutes of notice, which is also right.

The last rule guards the monitoring itself: a freshness metric that stops being published makes every other rule stop firing, and that is indistinguishable from "everything is fine".

### 5. Compute an error budget rather than a streak

```python
def error_budget(samples, target_s, window_days=30):
    """samples: [(timestamp, age_seconds)] at a regular interval over the window."""
    if not samples:
        return None
    breaching = sum(1 for _, age in samples if age > target_s)
    allowed = 0.05 * len(samples)                       # a 95% objective
    return {
        "samples": len(samples),
        "breaching": breaching,
        "allowed": round(allowed, 1),
        "budget_used_pct": round(100 * breaching / allowed, 1) if allowed else None,
        "objective": "95% of the window within the age target",
        "window_days": window_days,
    }

budget = error_budget(hourly_samples, TARGETS_S["buildings"][1])
print(budget)
```

A hard objective — "never older than 35 days" — fails on the first legitimately delayed delivery and then stays failed, which teaches everyone to ignore it. An objective with a budget — "within target 95% of the time over 30 days" — absorbs a missed run and still flags a pattern of them. The budget also gives the team a defensible answer to a request for a tighter target: it costs this much of the budget, here is what that means.

<figure class="diagram">
<svg viewBox="46 13 688 237" role="img" aria-labelledby="fresh-budget-t fresh-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fresh-budget-t">Age against target over a month, with the error budget</title>
  <desc id="fresh-budget-d">A sawtooth curve of building-layer age over a month: it rises daily and drops each time a delivery is published. Two short periods exceed the target line when deliveries were delayed. Together they consume about sixty percent of the five percent error budget, so the objective holds while showing that two more delays would breach it.</desc>
  <rect class="svg-bg" x="46" y="13" width="688" height="237" fill="#ffffff"/>
  <path d="M60 30 V180 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 70 H720" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M70 160 L110 120 L110 165 L150 125 L150 160 L190 118 L190 162 L230 60 L230 158 L270 122 L270 160 L310 124 L310 158 L350 120 L350 162 L390 126 L390 158 L430 56 L430 160 L470 124 L470 158 L510 120 L510 162 L550 126 L550 158 L590 122 L590 160 L630 124 L630 158 L670 120 L670 162 L710 128" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <text x="712" y="62" fill="#b0413e" font-size="12" text-anchor="end">age target</text>
  <g fill="#9a4f26" font-size="12" text-anchor="middle">
    <text x="230" y="44">delayed</text>
    <text x="430" y="40">delayed</text>
  </g>
  <text x="380" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">30 days of hourly samples · 2 breaches · 60% of the 5% budget used</text>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">A budget tolerates the delay that a hard target turns into a permanent red light.</text>
</svg>
<figcaption>The sawtooth is normal: age grows between deliveries and resets at each publish. What matters is how often the peaks cross the line.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="6 6 748 224" role="img" aria-labelledby="fresh-own-t fresh-own-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fresh-own-t">Who owns a breach, by which interval broke</title>
  <desc id="fresh-own-d">A two by two grid. Latency within target and age within target is healthy. Latency breached with age within target is a pipeline problem owned by the engineering team. Latency within target with age breached means no new delivery arrived, owned by the data programme. Both breached means a delivery is late and the pipeline is behind as well.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="224" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="200" y="20" width="260" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="460" y="20" width="280" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="180" height="80" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="56" width="260" height="80" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="460" y="56" width="280" height="80" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="136" width="180" height="80" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="136" width="260" height="80" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="460" y="136" width="280" height="80" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="330" y="43">age within target</text>
    <text x="600" y="43">age breached</text>
    <text x="110" y="90">latency</text><text x="110" y="110">within target</text>
    <text x="110" y="170">latency</text><text x="110" y="190">breached</text>
    <text x="330" y="96">healthy</text>
    <text x="600" y="88">no new delivery arrived</text><text x="600" y="108">→ data programme</text>
    <text x="330" y="168">pipeline is behind</text><text x="330" y="188">→ engineering team</text>
    <text x="600" y="168">late delivery and a</text><text x="600" y="188">slow pipeline → both</text>
  </g>
</svg>
<figcaption>Splitting the two intervals turns a freshness alert into a routing decision instead of a discussion.</figcaption>
</figure>

### 6. Show it to users

```python
import json
from pathlib import Path

def write_freshness_endpoint(states, out="build/freshness.json"):
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "layers": [
            {
                "layer": s.layer,
                "source": s.source,
                "captured": s.captured_at.isoformat(),
                "published": s.published_at.isoformat(),
                "age_days": round(s.age_s / 86400, 2),
                "within_objective": s.age_s <= TARGETS_S[s.layer][1],
            }
            for s in states
        ],
    }
    Path(out).write_text(json.dumps(payload, indent=2))
    return payload

write_freshness_endpoint([state])
```

```javascript
const fresh = await (await fetch("/freshness.json")).json();
for (const layer of fresh.layers) {
  const el = document.querySelector(`[data-layer="${layer.layer}"] .age`);
  if (!el) continue;
  el.textContent = layer.age_days < 2
    ? `${Math.round(layer.age_days * 24)} h old`
    : `${Math.round(layer.age_days)} days old`;
  el.classList.toggle("stale", !layer.within_objective);
}
```

Putting the age next to the layer switch is the cheapest trust-building feature a twin has. It stops users inferring that everything is current because it is on screen, and it converts "the twin is wrong" reports into "the buildings layer is 40 days old, which explains it" — which is a different and far more productive conversation.

## Expected Output & Verification

```text
latency 26.7 h, age 2.1 days
{'layer': 'buildings', 'latency_s': 96120.0, 'latency_target_s': 172800, 'latency_ok': True,
 'age_s': 183720.0, 'age_target_s': 3024000, 'age_ok': True, 'source': 'BAG nightly extract'}
{'samples': 720, 'breaching': 21, 'allowed': 36.0, 'budget_used_pct': 58.3,
 'objective': '95% of the window within the age target', 'window_days': 30}
```

Verify the measurement, because a freshness metric that reads the wrong timestamp is worse than none — it asserts currency that does not exist.

```python
from datetime import timedelta

def verify_capture_dates(states, max_future_s=3600):
    now = datetime.now(timezone.utc)
    for s in states:
        assert s.captured_at <= now + timedelta(seconds=max_future_s), f"{s.layer}: capture in the future"
        assert s.published_at >= s.captured_at, f"{s.layer}: published before captured"
        assert s.age_s >= s.latency_s, f"{s.layer}: age below latency — inconsistent clocks"
    print(f"{len(states)} layer states are internally consistent")

verify_capture_dates([state])
```

Three assertions catch the three ways this goes wrong: a capture date in the future, which means a file timestamp was used instead of a capture date; a publish before the capture, which means two different clocks or time zones; and an age below the latency, which is arithmetically impossible and indicates a mixed-up pair of fields.

Then spot-check against reality once: pick a building that was demolished on a known date and confirm the twin's state matches what the freshness figure claims.

## Performance Notes

- **The whole calculation is arithmetic on a handful of timestamps** and runs in milliseconds. Publish it every few minutes for fast-moving layers and hourly for slow ones.
- **Store the capture date with the data, not in a dashboard.** A layer's capture date belongs in its metadata — the tileset's `tilesetVersion`, the LAZ header, the CityJSON metadata — so the age survives a monitoring migration.
- **Sample history at a fixed interval** for the error budget; irregular samples make the percentage meaningless.
- **Keep the freshness endpoint tiny and cacheable** for a minute. It is requested by every viewer session.

## Common Errors

**Age uses the publish time, not the capture time.** The metric then reports the pipeline's promptness and calls it freshness. Users care when reality was measured.

**Every layer shares one target.** The sensor layer breaches constantly and the terrain layer never does, so the alerts get muted. One table, one target per layer.

**Time zones mixed between pipeline and source.** A capture recorded in local time and published in UTC produces an hour or two of apparent negative latency in summer. Store both as UTC ISO strings.

**A layer with no pipeline is invisible.** A static layer that was loaded once and never updated has no freshness metric at all, so it never appears in the alerts. Publish a state for it too, with its real capture date, and let it breach honestly.

## Frequently Asked Questions

### Who owns a breached age objective?

Whoever owns the source, not the pipeline team — the usual cause is a delivery that has not arrived. That is precisely why the two intervals are separated: latency is the team's number and age is the programme's.

### What is a reasonable objective percentage?

95% over 30 days is a good starting point for slow layers, and 99% for sensor layers where a breach means minutes. Anything above 99.5% on a layer that depends on external deliveries is a promise about someone else's schedule.

### Should freshness gate a publish?

Not usually — publishing stale-but-newer data is better than publishing nothing. The exception is a layer where staleness is dangerous, such as work zones or closures, where an out-of-date layer should be hidden rather than shown.

### How does this relate to the run-level metrics?

The run metrics say whether the last build worked; freshness says whether the *data* is current, which can be false even when every build succeeds — because no new delivery arrived. Both are needed, and they alert different people.

## Related Guides

- [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/) — the signal set this belongs to
- [Exporting Prometheus Metrics from Tiling Jobs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/exporting-prometheus-metrics-from-tiling-jobs/) — the build-side metrics
- [Detecting Data Drift Between Deliveries](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/detecting-data-drift-between-deliveries/) — when new data arrives but is not what it was

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
