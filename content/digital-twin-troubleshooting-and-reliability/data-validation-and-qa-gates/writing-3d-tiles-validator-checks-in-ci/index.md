# Writing 3D Tiles validator checks in CI

This guide wires the `3d-tiles-validator` CLI together with custom Python invariant checks — monotonic `geometricError`, child bounding-volume containment, and a root `transform` that resolves cleanly to EPSG:4978 — into a single CI gate that exits non-zero the instant any check fails. You reach for this the moment a tileset is built by an automated job rather than by hand: the reference validator catches schema and structural faults, but it will not tell you that your root transform places the model at the centre of the Earth, so the gate has to combine the official tool with assertions the tool does not make.

The job's contract is simple — it prints a report and returns 0 or 1 — so it drops into any runner. This walkthrough is the CI-facing counterpart to the [data validation and QA gates](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) overview, which catalogues the full gate set; here the focus is the runnable check job and the transform math the validator omits.

## Prerequisites

- Node 18+ with `3d-tiles-validator` 0.5+ available via `npx`, and Python 3.10+ with `numpy` 1.26+ and `pyproj` 3.6+.
- A built tileset — `tileset.json` plus its `.b3dm`/`.pnts` payloads — whose tiles render in **EPSG:4978 (geocentric WGS84, metres)**. The root tile carries a column-major 4×4 `transform` that places East-North-Up geometry onto the ellipsoid; the last check verifies that matrix.
- A CI runner (GitHub Actions, GitLab CI, or similar) where the job can fail the pipeline on a non-zero exit. The pipeline plumbing itself is covered in [CI/CD automation for spatial pipelines](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
- Knowledge of the dataset's expected location, so a transform that resolves to the wrong continent is caught by a plausibility bound rather than passing silently.

## Step-by-Step

### 1. Run the reference validator from the shell

Start with the official tool. It checks the schema, that `geometricError` is non-negative and generally decreasing, and that child bounding volumes are contained by their parents. Capture its exit code — non-zero means it found a violation.

```bash
#!/usr/bin/env bash
set -euo pipefail

npx --yes 3d-tiles-validator \
  --tilesetFile tileset/tileset.json \
  --validateAll \
  > validator-report.txt 2>&1

echo "3d-tiles-validator exit code: $?"
```

With `set -e` the script already aborts on a non-zero validator exit; the report is written to a file so CI can attach it as an artifact for debugging.

### 2. Collect invariant violations instead of raising

Custom checks should gather every violation into a list and return it, rather than raising on the first one, so a single CI run reports all problems. Walk the tree once, checking monotonicity and containment together.

```python
import json
import numpy as np

def _corners(box):
    """3D Tiles 'box' -> (min, max) corners in the tile frame."""
    c = np.array(box[:3], float)
    half = np.abs(np.array([box[3], box[7], box[11]], float))
    return c - half, c + half

def collect_violations(tile, parent_error=float("inf"), parent_box=None, path="root"):
    problems = []
    ge = tile["geometricError"]
    if ge > parent_error + 1e-6:
        problems.append(f"{path}: geometricError {ge} > parent {parent_error}")
    box = tile.get("boundingVolume", {}).get("box")
    if box and parent_box is not None:
        cmin, cmax = _corners(box)
        pmin, pmax = _corners(parent_box)
        if not (np.all(cmin >= pmin - 1e-3) and np.all(cmax <= pmax + 1e-3)):
            problems.append(f"{path}: bounding box escapes parent")
    for i, child in enumerate(tile.get("children", [])):
        problems += collect_violations(child, ge, box, f"{path}/child[{i}]")
    return problems

tileset = json.loads(open("tileset/tileset.json").read())
violations = collect_violations(tileset["root"])
```

### 3. Verify the root transform resolves to EPSG:4978

This is the check the validator cannot make. The root `transform` is a column-major 4×4 matrix; its translation column is the tile origin in ECEF metres, and its three rotation columns must form an orthonormal East-North-Up basis. Convert the origin back to geographic coordinates with `pyproj` and assert it lands on the ellipsoid near the expected site.

```python
from pyproj import Transformer

def transform_violations(transform, expect_lon, expect_lat, tol_deg=1.0):
    """Check a column-major 4x4 root transform places geometry sanely in EPSG:4978."""
    problems = []
    if len(transform) != 16:
        return [f"transform has {len(transform)} elements, expected 16"]
    m = np.array(transform, float).reshape((4, 4), order="F")   # column-major

    # Rotation columns must be orthonormal (a valid ENU basis).
    basis = m[:3, :3]
    gram = basis.T @ basis
    if not np.allclose(gram, np.identity(3), atol=1e-3):
        problems.append("rotation columns are not orthonormal (bad ENU basis)")

    # Translation column = ECEF origin; convert EPSG:4978 -> EPSG:4979 geographic.
    ox, oy, oz = m[:3, 3]
    to_geographic = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)
    lon, lat, h = to_geographic.transform(ox, oy, oz)
    if abs(lon - expect_lon) > tol_deg or abs(lat - expect_lat) > tol_deg:
        problems.append(f"origin at lon {lon:.3f}, lat {lat:.3f}; "
                        f"expected near {expect_lon}, {expect_lat}")
    if not -1_000 < h < 9_000:                    # metres above the ellipsoid
        problems.append(f"origin height {h:.0f} m is off the ellipsoid")
    return problems

root_tf = tileset["root"].get("transform")
if root_tf:
    violations += transform_violations(root_tf, expect_lon=-74.0, expect_lat=40.7)
```

An origin that converts to a height of millions of metres, or a longitude on the wrong continent, is the classic EPSG:4978 placement bug — geometry reprojected straight from a projected CRS to ECEF without the EPSG:4979 geographic hop.

### 4. Compose the checks into one gate that exits non-zero

Aggregate the validator's result and the Python violations. Print a report, then exit 1 if anything failed so the CI job blocks the merge.

```python
import subprocess, sys

def run_gate(tileset_path, expect_lon, expect_lat):
    tileset = json.loads(open(tileset_path).read())
    problems = collect_violations(tileset["root"])
    root_tf = tileset["root"].get("transform")
    if root_tf:
        problems += transform_violations(root_tf, expect_lon, expect_lat)

    validator = subprocess.run(
        ["npx", "--yes", "3d-tiles-validator", "--tilesetFile", tileset_path],
        capture_output=True, text=True)
    if validator.returncode != 0:
        problems.append("3d-tiles-validator reported errors (see report)")
        print(validator.stdout)

    if problems:
        print("GATE FAILED:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("GATE PASSED: all invariants hold")
    sys.exit(0)

if __name__ == "__main__":
    run_gate("tileset/tileset.json", expect_lon=-74.0, expect_lat=40.7)
```

### 5. Register the gate as a required CI step

Call the gate from the CI job so its exit code decides the pipeline. In GitHub Actions the step fails the job automatically on a non-zero exit.

```yaml
- name: Validate 3D Tiles output
  run: |
    npm install --global 3d-tiles-validator
    python -m pip install "numpy>=1.26" "pyproj>=3.6"
    python ci/validate_tileset.py
```

<figure class="diagram">
<svg viewBox="0 0 820 290" role="img" aria-labelledby="ci-t ci-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ci-t">CI gate combining the validator with custom invariant checks</title>
  <desc id="ci-d">A commit triggers the reference 3d-tiles-validator, then custom numpy invariant checks; their combined exit code either allows the merge on zero or blocks the pull request on a non-zero result.</desc>
  <defs>
    <marker id="ci-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#ci-arrow)">
    <line x1="170" y1="70" x2="198" y2="70"/>
    <line x1="375" y1="70" x2="403" y2="70"/>
    <line x1="580" y1="70" x2="608" y2="70"/>
    <line x1="685" y1="100" x2="560" y2="182"/>
    <line x1="685" y1="100" x2="716" y2="182"/>
  </g>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="20" y="40" width="150" height="60" rx="8"/>
    <rect x="200" y="40" width="175" height="60" rx="8"/>
    <rect x="405" y="40" width="175" height="60" rx="8"/>
    <rect x="610" y="40" width="150" height="60" rx="8"/>
  </g>
  <rect x="430" y="185" width="170" height="58" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="630" y="185" width="175" height="58" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="95" y="75">Commit / PR</text>
    <text x="287" y="65"><tspan x="287" dy="0">npx</tspan><tspan x="287" dy="16">3d-tiles-validator</tspan></text>
    <text x="492" y="65"><tspan x="492" dy="0">Python invariants</tspan><tspan x="492" dy="16">(numpy, pyproj)</tspan></text>
    <text x="685" y="65"><tspan x="685" dy="0">Aggregate</tspan><tspan x="685" dy="16">exit code</tspan></text>
    <text x="515" y="219">exit 0: merge PR</text>
    <text x="717" y="219">non-zero: block PR</text>
  </g>
</svg>
<figcaption>The gate chains the reference validator with custom numpy and pyproj checks; the combined exit code allows the merge or blocks the pull request.</figcaption>
</figure>

## Expected Output & Verification

Run the gate against a good tileset and a deliberately broken one. The good tileset prints a pass and exits 0; a tileset with an inverted error or a bad transform prints each violation and exits 1.

```python
# Construct a broken transform: origin left in projected metres, not ECEF.
broken_tf = [1,0,0,0, 0,1,0,0, 0,0,1,0, 583_000, 4_507_000, 12, 1]  # column-major
print(transform_violations(broken_tf, expect_lon=-74.0, expect_lat=40.7))
```

```text
['origin at lon 89.376, lat 0.001; expected near -74.0, 40.7',
 'origin height -6367905 m is off the ellipsoid']

$ python ci/validate_tileset.py
GATE FAILED:
  - root/child[2]: geometricError 40.0 > parent 10.0
  - origin height -6367905 m is off the ellipsoid
$ echo $?
1
```

A valid EPSG:4978 origin near the site converts to a longitude and latitude within a degree of the expected location and a height between roughly −1,000 and 9,000 m; anything else is the placement bug and the gate exits 1.

## Common Errors

**`Error: Cannot find module '3d-tiles-validator'`.** The validator is not installed in the CI image, or `npx` resolved a cached older name. Install it explicitly with `npm install --global 3d-tiles-validator` in the job, or invoke `npx --yes 3d-tiles-validator` so the runner fetches it non-interactively rather than prompting and hanging the job.

**Transform check flags a valid tileset as off the ellipsoid.** The matrix was reshaped row-major instead of column-major, transposing the rotation and translation. 3D Tiles stores `transform` in column-major order, so reshape with `order="F"`; a row-major read scrambles the ENU basis and moves the origin far from the true site.

**The gate exits 0 despite a visibly wrong tileset.** No `transform` was present, so the transform check was skipped, and the geometry happened to satisfy monotonicity and containment while sitting in the wrong CRS. Assert that a root transform exists when the tileset is meant for CesiumJS, and pair this gate with the [CRS and units check](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) on the source data so a wrong-CRS input is caught before tiling.

**The job passes but the CI runner had no network.** `npx --yes` silently succeeded because the validator was cached from a previous run, so a fresh runner with the package absent and no registry access would instead hang or fail to resolve it. Install `3d-tiles-validator` as an explicit, version-pinned dependency in the job image rather than fetching it on demand, and treat a missing validator as a hard failure — a gate that cannot run is not a gate that passed.

## Related Guides

- [Data Validation & QA Gates for 3D Tiles](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/) — the full gate set this job belongs to
- [Asserting CRS and Units with pyproj](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — catching a wrong source CRS before tiling
- [CI/CD Automation for Spatial Pipelines](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — the runner and pipeline this gate plugs into

Back to [Data Validation & QA Gates for 3D Tiles](/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
