---
title: "Validating IFC Georeferencing in CI"
description: "Gate every IFC delivery automatically: assert the map conversion, units and CRS, compare against control points and the cadastre"
---
# Validating IFC Georeferencing in CI

This page turns the checks a person would do by hand on a delivered IFC model into a CI job — asserting that a map conversion exists with a compound CRS, that units and scale agree, that the model's footprint lands on its parcel in EPSG:25832, and that surveyed control points reproduce within tolerance — with a report a contractor can act on and an exit code that stops a bad model reaching the twin.

## Why you hit this

A twin programme receives IFC models continuously, from different contractors, produced by different tools, and the georeferencing is wrong often enough that checking by hand becomes the bottleneck. Each failure is also expensive to find late: a model ingested with a missing vertical datum reaches a viewer weeks later as a building 47 m in the air, by which time the delivery has been accepted and the contractor has moved on. The checks themselves are the ones described in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/); this page makes them automatic.

## Prerequisites

- Python 3.10+ with `ifcopenshell>=0.8`, `pyproj>=3.6`, `numpy>=1.24`, `shapely>=2.0`, `geopandas>=0.14`.
- A cadastral parcel layer for the area in the target CRS, and — where available — surveyed control points per project.
- A CI runner with the PROJ grids the target vertical datum needs, or `PROJ_NETWORK=ON`.
- A delivery convention: each model arrives with a small JSON stating its project, expected CRS and control points.

## Step-by-Step

### 1. Read the delivery contract

```python
import json
from pathlib import Path

def load_contract(path):
    c = json.loads(Path(path).read_text())
    required = {"project", "expected_crs", "parcel_ids"}
    missing = required - set(c)
    if missing:
        raise SystemExit(f"delivery contract incomplete: missing {sorted(missing)}")
    c.setdefault("control_points", [])
    c.setdefault("tolerance_m", 0.05)
    return c

contract = load_contract("deliveries/2026-09/klinikum_c/contract.json")
print(contract["project"], contract["expected_crs"], len(contract["control_points"]), "control points")
```

The contract is what makes the gate meaningful. Without a stated expected CRS the job can only check internal consistency, which a wrongly placed model passes; with one it can check placement. Making the contract a required, version-controlled file also moves the conversation about georeferencing to the start of the project, which is where it belongs.

### 2. Assert the map conversion exists and is complete

```python
import math

import ifcopenshell
import ifcopenshell.util.unit
from pyproj import CRS

def check_map_conversion(model, expected_crs):
    findings = []
    if model.schema == "IFC2X3":
        psets = [p for p in model.by_type("IfcPropertySet") if p.Name == "ePSet_MapConversion"]
        if not psets:
            findings.append(("critical", "no ePSet_MapConversion in an IFC2X3 model"))
            return findings, None
        params = {p.Name: p.NominalValue.wrappedValue for p in psets[0].HasProperties}
    else:
        convs = model.by_type("IfcMapConversion")
        if not convs:
            findings.append(("critical", "no IfcMapConversion entity"))
            return findings, None
        if len(convs) > 1:
            findings.append(("warning", f"{len(convs)} map conversions; using the model context's"))
        c = convs[0]
        params = {"Eastings": c.Eastings, "Northings": c.Northings,
                  "OrthogonalHeight": c.OrthogonalHeight,
                  "XAxisAbscissa": c.XAxisAbscissa, "XAxisOrdinate": c.XAxisOrdinate,
                  "Scale": c.Scale, "TargetCRS": c.TargetCRS.Name,
                  "VerticalDatum": getattr(c.TargetCRS, "VerticalDatum", None)}

    for key in ("Eastings", "Northings", "OrthogonalHeight"):
        if params.get(key) is None:
            findings.append(("critical", f"{key} is not set"))

    declared = str(params.get("TargetCRS") or "")
    try:
        crs = CRS.from_user_input(declared)
        epsg = crs.to_epsg()
    except Exception:
        crs, epsg = None, None
        findings.append(("critical", f"TargetCRS {declared!r} is not resolvable"))

    expected = CRS.from_user_input(expected_crs)
    if epsg and expected.sub_crs_list and epsg != expected.sub_crs_list[0].to_epsg():
        findings.append(("critical", f"declared CRS EPSG:{epsg} is not the expected "
                                     f"EPSG:{expected.sub_crs_list[0].to_epsg()}"))
    if not params.get("VerticalDatum") and (not crs or len(getattr(crs, "sub_crs_list", [])) < 2):
        findings.append(("critical", "no vertical datum declared: heights are ambiguous"))

    unit_to_m = ifcopenshell.util.unit.calculate_unit_scale(model)
    scale = params.get("Scale") or 1.0
    effective = scale / unit_to_m
    if not 0.99 < effective < 1.01:
        findings.append(("critical", f"Scale {scale} with project unit {unit_to_m} "
                                     f"gives an effective scale of {effective:.6f}"))
    return findings, params

model = ifcopenshell.open("deliveries/2026-09/klinikum_c/model.ifc")
findings, params = check_map_conversion(model, contract["expected_crs"])
```

Each assertion maps to a failure that has happened. A missing vertical datum is the most common and the most expensive. An effective scale far from one is the millimetre trap. A declared CRS that resolves but is not the expected one is the contractor who used the neighbouring UTM zone, which puts the building a few hundred kilometres away and looks entirely plausible inside the file.

### 3. Compare the footprint against the cadastre

```python
import geopandas as gpd
import numpy as np
from shapely.geometry import MultiPoint

def model_footprint(model, params):
    import ifcopenshell.geom
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    slabs = model.by_type("IfcSlab") or model.by_type("IfcWall")
    it = ifcopenshell.geom.iterator(settings, model, include=slabs)
    pts = []
    if it.initialize():
        while True:
            v = np.asarray(it.get().geometry.verts, dtype=np.float64).reshape(-1, 3)
            pts.append(v)
            if not it.next():
                break
    local = np.vstack(pts)
    theta = math.atan2(params["XAxisOrdinate"] or 0.0, params["XAxisAbscissa"] or 1.0)
    c, s = math.cos(theta), math.sin(theta)
    e = c * local[:, 0] - s * local[:, 1] + params["Eastings"]
    n = s * local[:, 0] + c * local[:, 1] + params["Northings"]
    return MultiPoint(list(zip(e, n))).convex_hull

def check_against_cadastre(hull, parcel_ids, cadastre_path, epsg):
    parcels = gpd.read_file(cadastre_path).to_crs(epsg)
    target = parcels[parcels["parcel_id"].isin(parcel_ids)]
    if target.empty:
        return [("critical", f"parcels {parcel_ids} not found in the cadastre")]
    union = target.geometry.union_all()
    inter = hull.intersection(union).area
    findings = []
    share = inter / hull.area if hull.area else 0.0
    if share < 0.6:
        findings.append(("critical", f"only {share:.0%} of the model footprint is on its parcels"))
    elif share < 0.9:
        findings.append(("warning", f"{share:.0%} of the model footprint is on its parcels"))
    return findings

hull = model_footprint(model, params) if params else None
if hull is not None:
    findings += check_against_cadastre(hull, contract["parcel_ids"],
                                       "reference/cadastre.gpkg", 25832)
```

The cadastre check is the one that catches errors no internal consistency test can. A model with a perfect map conversion, correct units and a plausible CRS can still be 40 m off because the surveyor's origin was mis-transcribed, and the only way to notice is to compare with something external. Parcel overlap is a blunt instrument and blunt is enough: 95% overlap is right, 30% is a placement error, and the intermediate cases deserve a human.

<figure class="diagram">
<svg viewBox="6 10 748 240" role="img" aria-labelledby="ifcci-checks-t ifcci-checks-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcci-checks-t">The gate's checks, in order of cost</title>
  <desc id="ifcci-checks-d">Four tiers. Reading a few entities takes under a second and catches a missing map conversion, a wrong CRS or a scale error. Extracting the footprint takes a minute and catches misplacement against the cadastre. Applying control points takes seconds once geometry is loaded and measures accuracy. Full geometry validation takes many minutes and is left to a separate job.</desc>
  <rect class="svg-bg" x="6" y="10" width="748" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="24" width="180" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="24" width="300" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="24" width="240" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="68" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="68" width="300" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="500" y="68" width="240" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="112" width="180" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="200" y="112" width="300" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="500" y="112" width="240" height="44" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="156" width="180" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="200" y="156" width="300" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="500" y="156" width="240" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="110" y="52">&lt; 1 second</text>
    <text x="350" y="52">map conversion, CRS, units, scale</text>
    <text x="620" y="52">blocks immediately</text>
    <text x="110" y="96">~1 minute</text>
    <text x="350" y="96">footprint against the cadastre</text>
    <text x="620" y="96">blocks below 60% overlap</text>
    <text x="110" y="140">seconds more</text>
    <text x="350" y="140">control-point residuals</text>
    <text x="620" y="140">blocks above tolerance</text>
    <text x="110" y="184">many minutes</text>
    <text x="350" y="184">full geometry validation</text>
    <text x="620" y="184">separate job, not this gate</text>
  </g>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Ordering by cost means most rejections happen in the first second of the job.</text>
</svg>
<figcaption>The cheap checks catch the common failures, so the expensive ones only run on models that have already earned it.</figcaption>
</figure>

### 4. Reproduce the control points

```python
def check_control_points(params, control_points, tolerance_m):
    if not control_points:
        return [("warning", "no control points supplied: placement accuracy unverified")]
    theta = math.atan2(params["XAxisOrdinate"] or 0.0, params["XAxisAbscissa"] or 1.0)
    c, s = math.cos(theta), math.sin(theta)
    findings, residuals = [], []
    for cp in control_points:
        lx, ly, lz = cp["local"]
        e = c * lx - s * ly + params["Eastings"]
        n = s * lx + c * ly + params["Northings"]
        h = lz + params["OrthogonalHeight"]
        de, dn, dh = e - cp["world"][0], n - cp["world"][1], h - cp["world"][2]
        residuals.append((cp["label"], math.hypot(de, dn), dh))
    worst_h = max(r[1] for r in residuals)
    worst_v = max(abs(r[2]) for r in residuals)
    if worst_h > tolerance_m or worst_v > tolerance_m:
        findings.append(("critical", f"control residuals exceed {tolerance_m * 100:.0f} cm: "
                                     f"horizontal {worst_h * 100:.1f} cm, vertical {worst_v * 100:.1f} cm"))
    return findings, residuals

cp_findings, residuals = check_control_points(params, contract["control_points"],
                                              contract["tolerance_m"]) if params else ([], [])
findings += cp_findings
```

Control points measure what the cadastre check cannot: accuracy rather than plausibility. Reading the residual *pattern* also identifies the cause, as in the parent guide — a uniform offset is the translation, a rotation is grid versus true north, and growth with distance is the scale.

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="ifcci-fix-t ifcci-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcci-fix-t">Fixture models that keep the gate honest</title>
  <desc id="ifcci-fix-d">Five small IFC fixtures, each with one deliberate defect, and the finding each must produce: a model with no map conversion, one declaring the neighbouring UTM zone, one with a millimetre scale trap, one without a vertical datum, and one correct model that must produce no critical findings.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="270" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="290" y="20" width="450" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="270" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="290" y="54" width="450" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="88" width="270" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="290" y="88" width="450" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="122" width="270" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="290" y="122" width="450" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="156" width="270" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="290" y="156" width="450" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="190" width="270" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="190" width="450" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="155" y="43">fixture</text><text x="515" y="43">required finding</text>
    <text x="155" y="77">no_map_conversion.ifc</text><text x="515" y="77">critical: no IfcMapConversion entity</text>
    <text x="155" y="111">wrong_zone.ifc</text><text x="515" y="111">critical: declared CRS is not the expected one</text>
    <text x="155" y="145">mm_scale.ifc</text><text x="515" y="145">critical: effective scale far from one</text>
    <text x="155" y="179">no_vertical.ifc</text><text x="515" y="179">critical: no vertical datum declared</text>
    <text x="155" y="213">good.ifc</text><text x="515" y="213">no critical findings at all</text>
  </g>
</svg>
<figcaption>The last row matters as much as the others: a gate that rejects everything is as useless as one that accepts everything.</figcaption>
</figure>

### 5. Report in a form the contractor can act on

```python
def write_report(path, contract, findings, residuals, params):
    severity = "fail" if any(s == "critical" for s, _ in findings) else (
        "warn" if findings else "pass")
    lines = [
        f"# IFC georeferencing report — {contract['project']}", "",
        f"- result: **{severity}**",
        f"- expected CRS: `{contract['expected_crs']}`",
        f"- declared CRS: `{(params or {}).get('TargetCRS', 'none')}`",
        f"- vertical datum: `{(params or {}).get('VerticalDatum', 'none')}`", "",
    ]
    if findings:
        lines += ["## Findings", ""]
        for sev, msg in findings:
            lines.append(f"- **{sev}**: {msg}")
        lines.append("")
    if residuals:
        lines += ["## Control points", "", "| point | horizontal | vertical |", "|---|---|---|"]
        for label, h, v in residuals:
            lines.append(f"| {label} | {h * 100:.1f} cm | {v * 100:+.1f} cm |")
    Path(path).write_text("\n".join(lines) + "\n")
    return severity

severity = write_report("build/georef_report.md", contract, findings, residuals, params)
print(Path("build/georef_report.md").read_text())
```

A report that names the parameter and the expected value is the difference between a rejected delivery that gets fixed and one that gets re-sent unchanged. Writing it as Markdown means CI systems render it in the job summary, and it can be attached to the rejection e-mail without editing.

### 6. Wire it into the pipeline

```yaml
name: ifc-georeferencing
on:
  push:
    paths: ["deliveries/**/model.ifc", "deliveries/**/contract.json"]
jobs:
  validate:
    runs-on: ubuntu-latest
    env:
      PROJ_NETWORK: "ON"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install ifcopenshell pyproj numpy shapely geopandas
      - run: python tools/validate_georeferencing.py deliveries/2026-09/klinikum_c
      - if: always()
        run: cat build/georef_report.md >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: georef-report, path: build/georef_report.md }
```

Triggering on the delivery paths means the check runs when a model arrives rather than on a schedule, and the `always()` steps publish the report whether the job passed or failed — which matters, because a passing report with warnings is the one somebody should read.

<figure class="diagram">
<svg viewBox="-4 12 758 220" role="img" aria-labelledby="ifcci-flow-t ifcci-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifcci-flow-t">Delivery to decision</title>
  <desc id="ifcci-flow-d">A delivery folder containing the model and its contract triggers the job. The job reads the contract, asserts the map conversion, compares the footprint with the cadastre and reproduces the control points, then writes a Markdown report. A critical finding fails the build and the model is not ingested; warnings pass with the report attached.</desc>
  <rect class="svg-bg" x="-4" y="12" width="758" height="220" fill="#ffffff"/>
  <defs>
    <marker id="ifcci-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="80" width="130" height="58" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="180" y="80" width="150" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="370" y="80" width="150" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="560" y="26" width="180" height="52" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="560" y="96" width="180" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="560" y="166" width="180" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ifcci-flow-arrow)">
    <path d="M140 109 H178"/><path d="M330 109 H368"/>
    <path d="M520 100 L558 62"/><path d="M520 112 H558"/><path d="M520 124 L558 180"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="75" y="104">model.ifc +</text><text x="75" y="124">contract.json</text>
    <text x="255" y="104">assert conversion,</text><text x="255" y="124">CRS, units</text>
    <text x="445" y="104">cadastre overlap,</text><text x="445" y="124">control residuals</text>
    <text x="650" y="48">critical → fail,</text><text x="650" y="66">not ingested</text>
    <text x="650" y="118">warning → pass</text><text x="650" y="136">with the report</text>
    <text x="650" y="188">clean → ingest</text><text x="650" y="206">into the twin</text>
  </g>
</svg>
<figcaption>The report is produced on every path, so a delivery that passes with warnings still leaves a record of what was tolerated.</figcaption>
</figure>

## Expected Output & Verification

```text
Klinikum Nord Haus C EPSG:25832+7837 4 control points

# IFC georeferencing report — Klinikum Nord Haus C

- result: **fail**
- expected CRS: `EPSG:25832+7837`
- declared CRS: `EPSG:25832`
- vertical datum: `none`

## Findings

- **critical**: no vertical datum declared: heights are ambiguous
- **warning**: 87% of the model footprint is on its parcels

## Control points

| point | horizontal | vertical |
|---|---|---|
| gcp_A | 1.2 cm | +0.9 cm |
| gcp_B | 1.4 cm | +1.1 cm |
| gcp_C | 1.1 cm | +0.8 cm |
| gcp_D | 1.8 cm | +1.0 cm |
```

That is a realistic result: the placement is excellent, the footprint is slightly off its parcel because a canopy overhangs the pavement, and the delivery is rejected for one line of missing metadata. The rejection is cheap for the contractor to fix and expensive for the twin to discover later.

Verify the gate against fixtures rather than trusting it:

```python
FIXTURES = {
    "no_map_conversion.ifc": "no IfcMapConversion entity",
    "wrong_zone.ifc": "is not the expected",
    "mm_scale.ifc": "effective scale",
    "no_vertical.ifc": "no vertical datum",
    "good.ifc": None,
}
for name, expected in FIXTURES.items():
    m = ifcopenshell.open(f"tests/fixtures/{name}")
    f, _ = check_map_conversion(m, "EPSG:25832+7837")
    msgs = " | ".join(msg for _, msg in f)
    if expected is None:
        assert not any(s == "critical" for s, _ in f), f"{name}: unexpected critical: {msgs}"
    else:
        assert expected in msgs, f"{name}: expected {expected!r}, got {msgs!r}"
print("gate behaves correctly on all fixtures")
```

Five small IFC files, each with one deliberate defect, are enough to keep the gate honest through refactors and library upgrades. They are also the fastest way to onboard the next person: reading the fixtures explains what the gate is for.

## Common Errors

**The job passes everything because `params` is `None`.** When the map conversion is missing, later checks have nothing to work with and silently skip. Return early with a critical finding, and assert in tests that a missing conversion produces exactly one failure rather than none.

**The cadastre comparison fails for a legitimate model.** Canopies, balconies and basements extend beyond the parcel. Use the ground-floor slab outline rather than all geometry, and set the threshold from a sample of accepted models.

**PROJ cannot find the geoid grid on the runner.** Vertical checks then silently use a ballpark transformation. Set `PROJ_NETWORK=ON` or install the grid, and assert that the transformation PROJ chose names the grid.

**Control points are in the contract but in the wrong frame.** A contract listing coordinates without their CRS is as ambiguous as the model. Require the CRS in the contract and validate it against the expected one.

## Frequently Asked Questions

### Should the gate reject or quarantine?

Quarantine: fail the ingestion but keep the file, with the report, in a holding area. A rejected delivery that is deleted has to be re-sent; one that is held can be re-validated the moment a corrected parameter arrives.

### What tolerance should control residuals have?

Whatever the project's specification says, typically 2–5 cm for a building set out from survey. Put the number in the contract per project rather than in the code, since a heritage survey and a warehouse have different expectations.

### Can this run without control points?

Yes, and it then verifies consistency and plausibility but not accuracy. The report says so explicitly, which is the point: "unverified" is a different state from "accurate".

## Related Guides

- [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/) — the checks and their meaning
- [Reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/) — the defensive reader this gate uses
- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the same pattern for other formats

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
