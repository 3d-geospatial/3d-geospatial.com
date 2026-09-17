---
title: "Detecting Data Drift Between Deliveries"
description: "Catch a delivery that changed shape: profile schema, classes, density and CRS per delivery, compare against the last accepted profile and gate"
---
# Detecting Data Drift Between Deliveries

This page profiles every incoming delivery and compares it with the last accepted one — the schema and attribute names, the classification mix, point density, CRS and vertical datum, coordinate extents and the distribution of values — so that a delivery which is valid but *different* is caught before it propagates into the twin, in EPSG:25832+7837.

## Why you hit this

Validation asks whether a delivery is well formed. Drift detection asks whether it is the same *kind* of data as last time, and the answers diverge more often than anyone expects. A contractor upgrades their classification software and class 5 starts including what used to be class 4. A register adds a column and renames another. An aerial survey is flown at a different altitude, so density halves. Each delivery passes every schema check and each one silently changes what the twin shows — and because the pipeline succeeded, nobody looks until a user notices that all the trees disappeared. The monitoring context is in [pipeline observability and monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).

## Prerequisites

- Python 3.10+ with `laspy[lazrs]>=2.5`, `numpy>=1.24`, `geopandas>=0.14`, `pyproj>=3.6`.
- A place to keep accepted profiles — a JSON file per dataset in the repository is enough, and being in version control is an advantage.
- A convention for what a "delivery" is: one tile, one batch, one nightly extract. The profile is per delivery unit.

## Step-by-Step

### 1. Profile a point cloud delivery

```python
import json
from pathlib import Path

import laspy
import numpy as np

def profile_point_cloud(path, sample=2_000_000):
    with laspy.open(path) as reader:
        h = reader.header
        crs = h.parse_crs()
        las = reader.read()
    n = h.point_count
    idx = (np.random.default_rng(11).choice(n, min(sample, n), replace=False)
           if n > sample else np.arange(n))
    xyz = np.column_stack([las.x, las.y, las.z])[idx]
    cls = np.asarray(las.classification)[idx]
    classes, counts = np.unique(cls, return_counts=True)
    area = float((h.maxs[0] - h.mins[0]) * (h.maxs[1] - h.mins[1]))

    return {
        "kind": "point_cloud",
        "file": Path(path).name,
        "points": int(n),
        "crs": crs.to_string() if crs else None,
        "epsg": crs.to_epsg() if crs else None,
        "has_vertical_crs": bool(crs and len(crs.sub_crs_list) > 1) if crs else False,
        "point_format": int(h.point_format.id),
        "extra_dims": sorted(d.name for d in h.extra_dimensions),
        "density_per_m2": round(n / area, 2) if area else None,
        "class_mix": {int(c): round(float(k) / len(cls), 4) for c, k in zip(classes, counts)},
        "z_percentiles": [round(float(v), 2) for v in np.percentile(xyz[:, 2], [1, 50, 99])],
        "intensity_p99": int(np.percentile(np.asarray(las.intensity)[idx], 99)),
        "returns_max": int(np.asarray(las.number_of_returns)[idx].max()),
    }

profile = profile_point_cloud("deliveries/2026-09/tile_691_5335.laz")
print(json.dumps(profile, indent=2)[:600])
```

The profile is deliberately about *shape* rather than content: proportions instead of counts, percentiles instead of values, sorted names instead of order. That makes it comparable between deliveries of different sizes and different areas, which is the whole requirement — a tile with twice the points is not drift, and a tile whose vegetation share fell from 22% to 3% is.

### 2. Profile a vector delivery

```python
import geopandas as gpd

def profile_vector(path, layer=None):
    gdf = gpd.read_file(path, layer=layer)
    geom_types = gdf.geometry.geom_type.value_counts(normalize=True).round(4).to_dict()
    numeric = {}
    for col in gdf.select_dtypes("number").columns:
        s = gdf[col].dropna()
        if len(s):
            numeric[col] = [round(float(v), 3) for v in np.percentile(s, [1, 50, 99])]
    return {
        "kind": "vector",
        "file": Path(path).name,
        "layer": layer,
        "features": int(len(gdf)),
        "epsg": gdf.crs.to_epsg() if gdf.crs else None,
        "columns": sorted(gdf.columns.drop("geometry").tolist()),
        "dtypes": {c: str(t) for c, t in sorted(gdf.dtypes.astype(str).items()) if c != "geometry"},
        "geom_types": geom_types,
        "null_share": {c: round(float(gdf[c].isna().mean()), 4) for c in gdf.columns if c != "geometry"},
        "numeric_percentiles": numeric,
        "bounds": [round(float(v), 1) for v in gdf.total_bounds],
        "invalid_share": round(float((~gdf.geometry.is_valid).mean()), 4),
    }

vprofile = profile_vector("deliveries/2026-09/buildings.gpkg", layer="buildings")
```

For vector data the schema is the first thing that drifts and the easiest to check: a sorted column list and a dtype map catch a renamed field, a new column and a type change from integer to string. The null share per column catches the subtler version, where a column still exists and has stopped being populated.

<figure class="diagram">
<svg viewBox="6 6 748 254" role="img" aria-labelledby="drift-what-t drift-what-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drift-what-t">What drifts, and what it breaks downstream</title>
  <desc id="drift-what-d">A table of drift types. A renamed or added column breaks attribute joins. A changed classification mix breaks ground extraction and vegetation filtering. A density change breaks reconstruction parameters. A CRS or vertical datum change moves everything. A value-range change breaks styling thresholds and sanity checks.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="254" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="20" width="470" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="56" width="470" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="94" width="250" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="270" y="94" width="470" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="132" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="132" width="470" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="170" width="250" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="270" y="170" width="470" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="208" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="208" width="470" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="43">what drifted</text>
    <text x="505" y="43">what it breaks</text>
    <text x="145" y="80">a column renamed or added</text><text x="505" y="80">attribute joins, styling expressions, metadata</text>
    <text x="145" y="118">classification mix</text><text x="505" y="118">ground extraction, vegetation filtering, DTMs</text>
    <text x="145" y="156">point density</text><text x="505" y="156">reconstruction radii, decimation budgets</text>
    <text x="145" y="194">CRS or vertical datum</text><text x="505" y="194">everything, by tens of metres</text>
    <text x="145" y="232">value ranges</text><text x="505" y="232">style thresholds, sanity checks, legends</text>
  </g>
</svg>
<figcaption>Each drift type has a specific downstream victim, which is why the profile records each of them separately rather than as one hash.</figcaption>
</figure>

### 3. Compare against the last accepted profile

```python
def compare(profile, accepted, tolerances=None):
    tol = {"density_per_m2": 0.25, "class_share": 0.05, "features": 0.25,
           "percentile": 0.20, "null_share": 0.05, **(tolerances or {})}
    findings = []

    for key in ("epsg", "point_format", "kind"):
        if key in accepted and profile.get(key) != accepted.get(key):
            findings.append(("critical", key, accepted.get(key), profile.get(key)))

    if accepted.get("has_vertical_crs") and not profile.get("has_vertical_crs"):
        findings.append(("critical", "has_vertical_crs", True, False))

    for key in ("columns", "extra_dims"):
        old, new = set(accepted.get(key) or []), set(profile.get(key) or [])
        if old - new:
            findings.append(("critical", f"{key}:removed", sorted(old - new), None))
        if new - old:
            findings.append(("warning", f"{key}:added", None, sorted(new - old)))

    if accepted.get("density_per_m2") and profile.get("density_per_m2"):
        rel = abs(profile["density_per_m2"] - accepted["density_per_m2"]) / accepted["density_per_m2"]
        if rel > tol["density_per_m2"]:
            findings.append(("warning", "density_per_m2",
                             accepted["density_per_m2"], profile["density_per_m2"]))

    for cls, share in (accepted.get("class_mix") or {}).items():
        new_share = (profile.get("class_mix") or {}).get(str(cls), (profile.get("class_mix") or {}).get(int(cls), 0.0))
        if abs(new_share - share) > tol["class_share"]:
            findings.append(("warning", f"class_{cls}_share", share, round(new_share, 4)))

    for col, pct in (accepted.get("numeric_percentiles") or {}).items():
        new_pct = (profile.get("numeric_percentiles") or {}).get(col)
        if new_pct and pct[1] and abs(new_pct[1] - pct[1]) / max(abs(pct[1]), 1e-9) > tol["percentile"]:
            findings.append(("warning", f"{col}_median", pct[1], new_pct[1]))

    return findings

accepted = json.loads(Path("profiles/city_point_cloud.json").read_text())
findings = compare(profile, accepted)
for sev, key, old, new in findings:
    print(f"{sev.upper():<9}{key:<28}{old} → {new}")
```

The severities encode what can be automated and what cannot. A changed EPSG, a lost vertical CRS or a removed column is a critical finding, because downstream code will either fail or silently misplace data. A density change, a shifted class mix or a new column is a warning: it might be a legitimate change in the survey, and a human has to say so.

<figure class="diagram">
<svg viewBox="-8 20 737 224" role="img" aria-labelledby="drift-tol-t drift-tol-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drift-tol-t">Tolerance bands per profile field</title>
  <desc id="drift-tol-d">Bands showing how much change is tolerated per field. The CRS, point format and schema have zero tolerance: any change is critical. Point density tolerates about twenty-five percent. Class shares tolerate five percentage points. Numeric medians tolerate twenty percent. Feature counts tolerate twenty-five percent because delivery extents vary.</desc>
  <rect class="svg-bg" x="-8" y="20" width="737" height="224" fill="#ffffff"/>
  <path d="M170 24 V200" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="170" y="34" width="6" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="74" width="6" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="170" y="114" width="120" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="170" y="154" width="480" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="6" y="53">CRS, point format</text>
    <text x="6" y="93">schema columns</text>
    <text x="6" y="133">class shares</text>
    <text x="6" y="173">density, counts, medians</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="188" y="53">zero: any change blocks</text>
    <text x="188" y="93">removals block, additions warn</text>
    <text x="302" y="133">±5 percentage points</text>
    <text x="662" y="173">±20–25%</text>
  </g>
  <text x="400" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Tolerances come from observed variation between good deliveries, not from round numbers.</text>
</svg>
<figcaption>The fields with zero tolerance are the ones downstream code cannot compensate for; the wide bands are where real surveys legitimately vary.</figcaption>
</figure>

### 4. Gate the pipeline, and record the decision

```python
import sys

def gate_on_drift(findings, allow_file="profiles/accepted_drift.json"):
    allowed = json.loads(Path(allow_file).read_text()) if Path(allow_file).exists() else {}
    blocking, noted = [], []
    for sev, key, old, new in findings:
        note = allowed.get(key)
        if note and str(note.get("new")) == str(new):
            noted.append((key, note["reason"]))
        elif sev == "critical":
            blocking.append((key, old, new))
        else:
            noted.append((key, "warning, not blocking"))
    for key, reason in noted:
        print(f"noted: {key} — {reason}")
    if blocking:
        for key, old, new in blocking:
            print(f"BLOCKING: {key} changed {old} → {new}")
        sys.exit(2)
    return noted

gate_on_drift(findings)
```

The allow file is the mechanism that keeps this from becoming noise. When a delivery legitimately changes — the contractor's new classifier really is better — the change is recorded with its reason and the new value, and the gate stops complaining about that specific change while still catching the next one. It is a short JSON file, reviewed in a pull request, which is exactly where a decision about data semantics belongs.

### 5. Promote a profile once a delivery is accepted

```python
def accept_profile(profile, path, note):
    record = {**profile, "accepted_at": datetime.now(timezone.utc).isoformat(), "note": note}
    Path(path).write_text(json.dumps(record, indent=2, sort_keys=True))
    print(f"profile accepted: {path}")
    return record

accept_profile(profile, "profiles/city_point_cloud.json",
               note="2026-09 delivery; classifier upgraded, class 4/5 split reviewed")
```

Promoting the profile is the step that closes the loop, and it must be deliberate rather than automatic — a pipeline that overwrites the accepted profile on every run has no baseline and detects nothing. Keeping the file in the repository means each promotion is a reviewable commit with a note explaining what changed.

<figure class="diagram">
<svg viewBox="-4 6 758 204" role="img" aria-labelledby="drift-flow-t drift-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drift-flow-t">Profile, compare, gate, promote</title>
  <desc id="drift-flow-d">A delivery is profiled and compared with the accepted profile. Critical findings block the pipeline. Warnings are noted and the run continues. When a human accepts the delivery, the new profile is promoted into version control with a note, and becomes the baseline for the next comparison.</desc>
  <rect class="svg-bg" x="-4" y="6" width="758" height="204" fill="#ffffff"/>
  <defs>
    <marker id="drift-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="80" width="110" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="160" y="80" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="320" y="20" width="150" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="320" y="146" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="520" y="146" width="220" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#drift-flow-arrow)">
    <path d="M120 108 H158"/>
    <path d="M280 96 L318 60"/>
    <path d="M280 120 L318 158"/>
    <path d="M470 171 H518"/>
  </g>
  <path d="M630 144 C630 60 430 60 285 92" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#drift-flow-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="104">delivery</text><text x="65" y="122">arrives</text>
    <text x="220" y="104">profile and</text><text x="220" y="122">compare</text>
    <text x="395" y="42">critical:</text><text x="395" y="60">block the run</text>
    <text x="395" y="168">warnings:</text><text x="395" y="186">note and continue</text>
    <text x="630" y="168">human accepts →</text><text x="630" y="186">promote the profile</text>
  </g>
  <text x="430" y="82" fill="#4f7a4d" font-size="11.5" text-anchor="middle">new baseline</text>
</svg>
<figcaption>The loop only works if promotion is a deliberate, reviewed act; an automatic baseline update detects nothing.</figcaption>
</figure>

## Expected Output & Verification

```text
CRITICAL has_vertical_crs            True → False
WARNING  class_5_share               0.2184 → 0.0312
WARNING  class_4_share               0.0421 → 0.2203
WARNING  density_per_m2              18.4 → 31.2
noted: class_4_share — 2026-09: classifier now splits medium/high vegetation differently
noted: class_5_share — 2026-09: classifier now splits medium/high vegetation differently
BLOCKING: has_vertical_crs changed True → False
```

That is the drift report doing its job on a real pattern: the vegetation classes swapped proportions, which was expected and recorded, while the delivery quietly lost its vertical CRS — which would have put every height in the twin 47 m out and passed every other check.

Verify the detector with a synthetic delivery, because a drift check nobody has seen fire is not known to work:

```python
import copy

base = json.loads(Path("profiles/city_point_cloud.json").read_text())
mutated = copy.deepcopy(base)
mutated["epsg"] = 32632                                  # wrong UTM zone
mutated["class_mix"]["2"] = base["class_mix"]["2"] + 0.3

findings = compare(mutated, base)
keys = {k for _, k, _, _ in findings}
assert "epsg" in keys, "CRS change not detected"
assert any(k.startswith("class_2_share") for k in keys), "class mix change not detected"
print("drift detector catches the synthetic mutations")
```

## Performance Notes

- **Profiling reads headers and a sample**, not the whole file: a 2-million-point sample of a 200-million-point tile takes seconds and is statistically ample for shares and percentiles.
- **Seed the sampler** so re-profiling the same delivery gives the same numbers; unseeded sampling produces spurious drift of a few tenths of a percent.
- **Profile per delivery unit, compare per unit.** A city-wide average hides a single tile that came from a different flight.
- **Keep profiles small** — a few kilobytes — so a year of them lives in the repository without thought.
- **Run the profile before the expensive stages.** A blocked delivery should cost seconds, not the three hours of tiling that would have consumed it.

## Common Errors

**Every delivery reports drift in the percentiles.** The tolerance is tighter than natural variation between areas. Calibrate the tolerances on a handful of known-good deliveries rather than picking round numbers.

**Class shares compare as strings against integers.** JSON object keys are strings, so a profile round-tripped through a file has `"2"` where the fresh one has `2`. The comparison above checks both; forgetting this silently reports every class as changed.

**A renamed column is reported as one removal and one addition.** That is correct and is exactly what it is; the allow file should record the rename as a pair with the reason, and downstream code has to be updated before the delivery is accepted.

**The baseline drifts along with the data.** Something promotes the profile automatically — a script, or a well-meaning cleanup job. Promotion belongs in a reviewed commit, and a test that the profile file is unchanged in CI is a reasonable guard.

## Frequently Asked Questions

### Is this not what schema validation does?

Schema validation checks that a delivery conforms to a contract. Drift detection checks that it resembles the last one. A delivery can satisfy the schema and have half the vegetation class it had last month; only the comparison catches that.

### How is this different from change detection?

Change detection measures how the *world* changed between two epochs, which is the product. Drift detection measures how the *data about the world* changed, which is usually an artefact of the production process. Confusing the two produces reports of buildings that grew by two metres when a vertical datum moved.

### Should drift block or warn?

Block on anything that would make downstream code wrong — CRS, units, schema, missing vertical datum. Warn on distributions, which need judgement. The allow file is what keeps the warnings from becoming background noise.

### What about drift in imagery?

The same idea with different fields: resolution, band count and order, bit depth, nodata value, and the percentiles of each band. A CIR product delivered where RGB was expected is the classic case, and it is caught by band statistics rather than by any schema.

## Related Guides

- [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/) — the signal set this belongs to
- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the conformance half of the problem
- [Checking Point Cloud Classification Completeness](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/checking-point-cloud-classification-completeness/) — a deeper look at the class mix

Back to [Pipeline Observability and Monitoring](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/).
