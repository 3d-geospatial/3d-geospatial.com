# Building Merge-Blocking Schema Validation Gates for Spatial Data

This guide builds the validation gate that stands between a processed tileset and a merge: JSON Schema validation of `tileset.json` and its metadata with `jsonschema`, a `3d-tiles-validator` run, CRS and unit assertions with `pyproj`, LAS header checks with `laspy`, and a runner that exits non-zero so GitHub blocks the pull request. The gate is a plain script whose exit code is the whole point — zero merges, non-zero blocks.

You reach for this the first time a malformed `tileset.json` or a mislabelled EPSG code reaches a client and someone has to explain why the twin loaded underground. A gate turns that class of defect into a red check that never merges. It is the enforcement stage of the [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) workflow, and it complements the [processing job](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) that produces the artifact it inspects.

<figure class="diagram">
<svg viewBox="1 12 773 280" role="img" aria-labelledby="gate-t gate-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gate-t">Validation gate combining four checks into one exit code</title>
  <desc id="gate-d">Four checks — JSON Schema on tileset.json, the 3d-tiles-validator, CRS and unit assertions with pyproj, and LAS header checks with laspy — feed a single gate that exits zero to allow the merge or exits one to block it.</desc>
  <rect class="svg-bg" x="1" y="12" width="773" height="280" fill="#ffffff"/>
  <defs>
    <marker id="gate-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
    <marker id="gate-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="15" y="26" width="215" height="48" rx="8"/>
    <rect x="15" y="94" width="215" height="48" rx="8"/>
    <rect x="15" y="162" width="215" height="48" rx="8"/>
    <rect x="15" y="230" width="215" height="48" rx="8"/>
  </g>
  <rect x="310" y="112" width="170" height="80" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="560" y="58" width="200" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="560" y="188" width="200" height="56" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#gate-arrow)">
    <line x1="230" y1="50" x2="308" y2="132"/>
    <line x1="230" y1="118" x2="308" y2="144"/>
    <line x1="230" y1="186" x2="308" y2="158"/>
    <line x1="230" y1="254" x2="308" y2="170"/>
    <line x1="480" y1="140" x2="558" y2="92"/>
  </g>
  <line x1="480" y1="164" x2="558" y2="212" stroke="#b0413e" stroke-width="2" marker-end="url(#gate-arrow-red)"/>
  <text x="524" y="104" fill="#4f7a4d" font-size="12" text-anchor="middle">pass</text>
  <text x="524" y="184" fill="#b0413e" font-size="12" text-anchor="middle">fail</text>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="122" y="46"><tspan x="122" dy="0">JSON Schema</tspan><tspan x="122" dy="16">tileset.json</tspan></text>
    <text x="122" y="114"><tspan x="122" dy="0">3d-tiles-validator</tspan><tspan x="122" dy="16">schema + volumes</tspan></text>
    <text x="122" y="182"><tspan x="122" dy="0">CRS + units</tspan><tspan x="122" dy="16">pyproj</tspan></text>
    <text x="122" y="250"><tspan x="122" dy="0">LAS header</tspan><tspan x="122" dy="16">laspy</tspan></text>
    <text x="395" y="148"><tspan x="395" dy="0">Aggregate gate</tspan><tspan x="395" dy="16">all must pass</tspan></text>
    <text x="660" y="82"><tspan x="660" dy="0">exit 0</tspan><tspan x="660" dy="16">merge allowed</tspan></text>
    <text x="660" y="212"><tspan x="660" dy="0">exit 1</tspan><tspan x="660" dy="16">block merge</tspan></text>
  </g>
</svg>
<figcaption>Four independent checks feed one aggregate gate; a single failure flips the exit code to 1, which GitHub records as a failed required check and disables the merge button.</figcaption>
</figure>

## Prerequisites

- Python 3.11 with `jsonschema>=4`, `laspy>=2.5`, and `pyproj>=3.6`, plus Node 18+ for the `3d-tiles-validator` CLI.
- A processed `tileset.json` and the source `.laz` tiles from the process stage, staged in a `dist/` directory the gate reads.
- The delivery CRS declared explicitly: tiles render in EPSG:4978 (geocentric WGS 84) reached from a projected source such as EPSG:32618 via EPSG:4979, and the gate asserts exactly those codes.
- A JSON Schema file describing your tileset metadata contract — the per-feature attributes your batch tables must carry (asset IDs, classification codes) — kept in the repository so the schema is versioned alongside the code.

## Step-by-Step

### 1. Validate tileset metadata against a JSON Schema

Author a schema for the metadata your downstream tools depend on, then validate the tileset's `metadata` block. `jsonschema` raises `ValidationError` with a JSON path to the offending node, which you surface as a gate failure rather than a stack trace.

```python
import json
from jsonschema import Draft202012Validator

TILESET_METADATA_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["asset", "geometricError", "root"],
    "properties": {
        "asset": {
            "type": "object",
            "required": ["version"],
            "properties": {"version": {"enum": ["1.0", "1.1"]}},
        },
        "geometricError": {"type": "number", "minimum": 0},
        "root": {"type": "object", "required": ["boundingVolume", "geometricError"]},
    },
}

def check_schema(tileset_path: str) -> list[str]:
    tileset = json.loads(open(tileset_path).read())
    validator = Draft202012Validator(TILESET_METADATA_SCHEMA)
    return [f"schema: {e.json_path} {e.message}"
            for e in validator.iter_errors(tileset)]
```

### 2. Run the official 3d-tiles-validator

The JSON Schema catches your metadata contract; the `3d-tiles-validator` catches spec violations you did not encode — non-monotonic `geometricError`, bounding volumes that escape their parent, malformed `b3dm` payloads. Run it as a subprocess and treat any non-zero exit as a gate failure.

```python
import subprocess

def check_3d_tiles_validator(tileset_path: str) -> list[str]:
    result = subprocess.run(
        ["npx", "3d-tiles-validator", "--tilesetFile", tileset_path],
        capture_output=True, text=True)
    if result.returncode != 0:
        return [f"3d-tiles-validator: {result.stdout.strip()[:400]}"]
    return []
```

<figure class="diagram">
<svg viewBox="-2 6 764 296" role="img" aria-labelledby="sv-layer-t sv-layer-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sv-layer-t">Four layers of validation, and what each one cannot see</title>
  <desc id="sv-layer-d">JSON Schema proves the document is shaped correctly but knows nothing about geometry. The reference validator proves the tileset obeys the specification but not that it describes your city. Domain assertions prove the CRS, units and bounds are the ones you intended. Only a rendered comparison catches a tileset that is valid, correct, and of the wrong dataset.</desc>
  <rect class="svg-bg" x="-2" y="6" width="764" height="296" fill="#ffffff"/>
  <rect x="40" y="52" width="680" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="80" y="106" width="600" height="46" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="120" y="160" width="520" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="160" y="214" width="440" height="46" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="380" y="81">JSON Schema — is the document shaped like a tileset?</text>
    <text x="380" y="135">3d-tiles-validator — does it obey the specification?</text>
    <text x="380" y="189">domain assertions — is it in EPSG:4978, in metres, over this city?</text>
    <text x="380" y="243">rendered comparison — is it this city, this week?</text>
  </g>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Each layer catches a class the layer above it cannot express</text>
  <text x="380" y="284" fill="#15384a" font-size="12" text-anchor="middle">A tileset can pass all three upper layers and still be last month's build — which is why the cheapest layer is not the last one you add</text>
</svg>
<figcaption>The layers narrow: syntax, then specification, then intent, then identity. Most pipelines stop after two and are surprised by the third.</figcaption>
</figure>

### 3. Assert CRS and units with pyproj

A tileset can be structurally perfect and still ship in the wrong coordinate system. Use `pyproj` to confirm the declared CRS is the expected geocentric metric frame — projected or geographic, and crucially in metres, not degrees. The unit check is what stops a EPSG:4326 (degrees) tileset from masquerading as valid. This mirrors the deeper treatment in [asserting CRS and units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/).

```python
from pyproj import CRS

def check_crs(epsg_code: int, expected: int = 4978) -> list[str]:
    errors = []
    crs = CRS.from_epsg(epsg_code)
    if epsg_code != expected:
        errors.append(f"crs: expected EPSG:{expected}, got EPSG:{epsg_code}")
    # Cesium delivery must be metric geocentric, never a degree-based CRS.
    axis_units = {ax.unit_name for ax in crs.axis_info}
    if not axis_units.issubset({"metre", "meter"}):
        errors.append(f"crs: non-metric units {axis_units} on EPSG:{epsg_code}")
    return errors
```

### 4. Check LAS headers with laspy

Guard the source cloud too. Read each `.laz` header with `laspy` and assert the point count, declared EPSG, and bounding box are sane before the tile is trusted, so a truncated or mislabelled upload fails at the gate rather than in a client.

```python
import laspy

def check_las_header(las_path: str, expected_epsg: int = 32618) -> list[str]:
    errors = []
    with laspy.open(las_path) as reader:
        header = reader.header
        crs = header.parse_crs()
        if crs is None or crs.to_epsg() != expected_epsg:
            errors.append(f"las: {las_path} CRS {crs} != EPSG:{expected_epsg}")
        if header.point_count == 0:
            errors.append(f"las: {las_path} has zero points")
        if header.x_max <= header.x_min or header.y_max <= header.y_min:
            errors.append(f"las: {las_path} degenerate bounding box")
    return errors
```

### 5. Aggregate the checks and exit non-zero

The runner collects every error string from every check, prints them, and calls `sys.exit(1)` if any exist. Aggregating first — rather than exiting on the first failure — reports all problems in one CI run so a contributor fixes them in a single push.

```python
import sys

def main() -> None:
    errors: list[str] = []
    errors += check_schema("dist/tileset.json")
    errors += check_3d_tiles_validator("dist/tileset.json")
    errors += check_crs(4978, expected=4978)
    errors += check_las_header("dist/tiles/tile_18_3312.laz", expected_epsg=32618)

    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)          # non-zero -> GitHub blocks the merge
    print("VALIDATION PASSED: all gates green")

if __name__ == "__main__":
    main()
```

<figure class="diagram">
<svg viewBox="10 16 718 242" role="img" aria-labelledby="sv-exit-t sv-exit-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sv-exit-t">Collect every failure, then exit once</title>
  <desc id="sv-exit-d">A gate that raises on the first failed check reports one problem per run, so a build with four faults takes four cycles to clear. Collecting all failures into a list and exiting non-zero once at the end reports all four in the first run, at no extra cost.</desc>
  <rect class="svg-bg" x="10" y="16" width="718" height="242" fill="#ffffff"/>
  <defs>
    <marker id="sv-exit-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="24" y="60" width="110" height="40" rx="6"/>
    <rect x="24" y="164" width="110" height="40" rx="6"/>
    <rect x="164" y="164" width="110" height="40" rx="6"/>
    <rect x="304" y="164" width="110" height="40" rx="6"/>
    <rect x="444" y="164" width="110" height="40" rx="6"/>
  </g>
  <rect x="164" y="60" width="110" height="40" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="584" y="164" width="130" height="40" rx="6" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#sv-exit-a)">
    <line x1="134" y1="80" x2="162" y2="80"/>
    <line x1="134" y1="184" x2="162" y2="184"/>
    <line x1="274" y1="184" x2="302" y2="184"/>
    <line x1="414" y1="184" x2="442" y2="184"/>
    <line x1="554" y1="184" x2="582" y2="184"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="79" y="85">schema</text>
    <text x="219" y="85">raise</text>
    <text x="79" y="189">schema</text>
    <text x="219" y="189">validator</text>
    <text x="359" y="189">CRS</text>
    <text x="499" y="189">LAS header</text>
    <text x="649" y="189">exit 1, 4 faults</text>
  </g>
  <text x="24" y="44" fill="#b0413e" font-size="12.5" text-anchor="start" font-weight="600">fail fast — one fault per CI cycle</text>
  <text x="24" y="148" fill="#4f7a4d" font-size="12.5" text-anchor="start" font-weight="600">collect and exit once — every fault in the first run</text>
  <text x="370" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">The checks are independent, so there is no reason to serialise the feedback the way the code happens to be written</text>
</svg>
<figcaption>Fail-fast is right for dependent steps and wrong for independent checks. These are independent, and a four-cycle turnaround is entirely self-inflicted.</figcaption>
</figure>

### 6. Wire the gate into the workflow as a required check

Add the gate as a job step; its exit code becomes the status check. Mark it required in branch protection so the merge button stays disabled until it is green.

```yaml
      - name: Schema + CRS validation gate
        run: |
          npm install -g 3d-tiles-validator
          python3 scripts/gates.py     # exits non-zero on any violation
```

## Expected Output & Verification

A clean tileset prints a single pass line and exits zero; a broken one lists every failure and exits one. The exit code — visible as `echo $?` locally and as the check status in CI — is what the merge protection reads.

```text
$ python3 scripts/gates.py && echo "exit $?"
VALIDATION PASSED: all gates green
exit 0

$ python3 scripts/gates.py; echo "exit $?"
VALIDATION FAILED:
  - schema: $.root.geometricError 'geometricError' is a required property
  - crs: expected EPSG:4978, got EPSG:4326
  - las: dist/tiles/tile_18_3312.laz CRS EPSG:25832 != EPSG:32618
exit 1
```

Verify gate *polarity* in the test suite: run the gate against a known-good fixture and a deliberately corrupted one, asserting the exit codes. A gate that never fails is worse than none, so this test is as important as the gate itself. Writing these checks against the reference validator is covered in [writing 3d-tiles-validator checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/).

A word on maintaining the gate itself. Schemas drift: a new attribute is added to the source register, a tiler upgrade starts emitting an extra property, a spec revision makes a previously required field optional. A gate that rejects anything it has not seen before will start failing valid builds within a quarter, and a gate that accepts anything it does not recognise stops catching the case it exists for. The workable middle is to fail on missing required properties and on type mismatches, but to allow additional properties while logging them — so a new field surfaces in the build output as a line to review rather than as either a block or a silence.

The second maintenance question is fixtures. Each check in the gate should have one artifact it must accept and one it must refuse, both committed next to the gate. The refusal fixture is the important half: it is the only evidence that the check is still wired up, still reachable, and still comparing what it claims to compare. Checks decay quietly — an assertion against a field that was renamed simply stops being evaluated — and a refusal fixture converts that decay into a failing test.

Keep both fixtures small. A twelve-building tileset exercises every structural check that a city-scale one does, runs in under a second, and can be read by a human when the gate's verdict is surprising.

## Common Errors

**`jsonschema.exceptions.ValidationError: 512.0 is not of type 'integer'`.** The schema declared `geometricError` as `integer`, but a measured Hausdorff error is a float. A too-strict type rejects valid tilesets and trains the team to ignore the gate. Fix: use `"type": "number"` for any measured metric quantity, reserving `integer` for genuinely discrete fields like tile counts.

**`pyproj.exceptions.CRSError: Invalid projection: EPSG:0` in the CRS check.** The tileset carried no CRS and your code defaulted the EPSG to `0`, which `pyproj` cannot construct. A missing CRS is itself a failure, not a crash. Fix: treat a `None` or unparseable CRS as an explicit gate error string returned from the check, so it reports as a clean failure rather than an exception that masks the other checks.

**The gate passes in CI but the merge still ships a bad tileset.** The step exited zero because `3d-tiles-validator` was invoked but its non-zero return was swallowed — for example wrapped in a shell pipe that reports the last command's status. Fix: capture `returncode` explicitly as in step 2, avoid piping the validator into another command, and confirm the job is marked a *required* status check in branch protection.

## Related Guides

- [GitHub Actions GDAL/PDAL Pipeline Jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the process stage that produces the artifact this gate inspects
- [Automated 3D Tiles Deployment to a CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — the deploy that runs only after this gate is green
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the CRS-assertion patterns in depth
- [Writing 3D Tiles Validator Checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — extending the validator step with custom checks

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
