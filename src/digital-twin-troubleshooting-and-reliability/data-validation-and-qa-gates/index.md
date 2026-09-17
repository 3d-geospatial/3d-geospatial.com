---
title: "Data Validation & QA Gates for 3D Tiles"
description: "Blocking QA gates for spatial pipelines: 3d-tiles-validator, JSON Schema on tileset.json, geometricError monotonicity, CRS asserts with pyproj, laspy and trimesh checks."
---
# Data Validation & QA Gates for 3D Geospatial Pipelines

Bad geometry and bad metadata do not announce themselves. A tileset with an inverted `geometricError`, a point cloud silently in EPSG:4326 degrees, or a mesh with a hole where a QEM collapse widened a non-manifold edge will render — badly — and the defect only surfaces when a measurement disagrees with the survey or a client refuses to refine. The remedy is a set of automated gates that run between "tiling finished" and "artifact published," each one asserting a specific invariant and failing the build with a non-zero exit code when the invariant breaks. This guide defines those gates — JSON Schema on `tileset.json` and metadata, `geometricError` monotonicity and bounding-volume containment, CRS and units checks with `pyproj`, LAS header checks with `laspy`, and mesh watertightness with `trimesh` — and shows how to wire them as blocking checks so no defect reaches a CDN. It is the offline counterpart to [streaming and runtime diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/) and belongs under [digital twin troubleshooting and reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/); the CI plumbing that runs these gates lives in [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).

## Prerequisites

Every gate is a Python function or CLI call that returns pass/fail deterministically. Pin the toolchain so a gate's verdict is reproducible across machines — a validator that passes on a developer laptop and fails in CI is worse than no gate at all.

| Component | Pinned version | Gate it powers |
|-----------|----------------|----------------|
| Python | 3.10–3.12 | Orchestration and assertion logic |
| `jsonschema` | 4.21+ | Schema gate on `tileset.json` and metadata |
| `numpy` | 1.26+ | Monotonicity and containment arithmetic |
| `pyproj` | 3.6+ | CRS and units gate |
| `laspy` | 2.5+ | LAS/LAZ header gate |
| `trimesh` | 4.4+ | Mesh watertightness gate |
| `3d-tiles-validator` | 0.5+ (Node 18+) | Reference schema + geometry validation |

**Input formats.** Gates run on the tiling output — `tileset.json` plus `.b3dm`/`.pnts`/`.glb` payloads — and on the source that fed it: classified `.laz`/`.las` for point tiles and glTF/`.ply` meshes for `b3dm`. **State the CRS explicitly and never infer it.** Source data should be a projected metric CRS such as EPSG:32618 (UTM 18N) or EPSG:25832 (UTM 32N central Europe); tiled output for CesiumJS lands in EPSG:4978 (geocentric WGS84, metres). The CRS gate exists precisely because "the data is probably in the right system" is the assumption that ships a twin kilometres off its true location.

## Concept

A validation gate is a check that has the authority to stop the pipeline. It has three properties: it asserts one named invariant, it is deterministic, and it exits non-zero on failure so the surrounding CI job halts. Gates are ordered cheapest-first so a fast schema check rejects a malformed file before an expensive geometry traversal runs. The full set forms a funnel — raw tiling output enters, each gate either passes it through or rejects it, and only output that clears every gate is published.

The invariants worth gating are the ones that render silently wrong. Schema validity catches structural corruption in `tileset.json`. `geometricError` monotonicity (child ≤ parent) catches the inversion that makes a client refine into coarser geometry. Bounding-volume containment (child box inside parent box) catches the culling error that hides visible tiles. CRS and units catch the geographic-versus-projected mistake that makes every distance meaningless. LAS header checks catch scale, offset, and CRS drift in the source cloud. Mesh watertightness catches the holes that decimation turns into gaps. None of these is caught by "it looked fine in the viewer" — they need executable assertions with expected values, which is what the gates provide. Encode the boundary contract as code, not as a wiki page nobody reads at three in the morning.

<figure class="diagram">
<svg viewBox="6 26 858 232" role="img" aria-labelledby="qa-t qa-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qa-t">Validation gate funnel from raw tiling output to publish</title>
  <desc id="qa-d">Raw tiling output passes through a schema gate, a geometry gate, and a CRS gate in sequence; output that clears all three is published to the CDN, while any gate that fails rejects the build with a non-zero exit code and blocks publishing.</desc>
  <rect class="svg-bg" x="6" y="26" width="858" height="232" fill="#ffffff"/>
  <defs>
    <marker id="qa-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#qa-arrow)">
    <line x1="170" y1="72" x2="193" y2="72"/>
    <line x1="345" y1="72" x2="368" y2="72"/>
    <line x1="520" y1="72" x2="543" y2="72"/>
    <line x1="695" y1="72" x2="718" y2="72"/>
    <line x1="270" y1="104" x2="270" y2="192"/>
    <line x1="445" y1="104" x2="445" y2="192"/>
    <line x1="620" y1="104" x2="620" y2="192"/>
  </g>
  <rect x="20" y="40" width="150" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="195" y="40" width="150" height="64" rx="8"/>
    <rect x="370" y="40" width="150" height="64" rx="8"/>
    <rect x="545" y="40" width="150" height="64" rx="8"/>
  </g>
  <rect x="720" y="40" width="130" height="64" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="150" y="196" width="580" height="48" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="95" y="68"><tspan x="95" dy="0">Raw tiling</tspan><tspan x="95" dy="16">output</tspan></text>
    <text x="785" y="77">Publish to CDN</text>
    <text x="440" y="225">Rejected: exit non-zero, block the publish step</text>
  </g>
  <g fill="#15384a" font-size="13" text-anchor="middle">
    <text x="270" y="68"><tspan x="270" dy="0">Schema</tspan><tspan x="270" dy="16">gate</tspan></text>
    <text x="445" y="68"><tspan x="445" dy="0">Geometry</tspan><tspan x="445" dy="16">gate</tspan></text>
    <text x="620" y="68"><tspan x="620" dy="0">CRS + units</tspan><tspan x="620" dy="16">gate</tspan></text>
  </g>
</svg>
<figcaption>Each gate asserts one invariant and passes or rejects the build; only output clearing the schema, geometry, and CRS gates reaches the CDN.</figcaption>
</figure>

Every gate here shares a design that is worth stating plainly, because it is what separates a gate from a warning. A gate has a single, binary outcome that the build system can act on; it reports every violation it found rather than the first; it prints the expected value beside the observed one, so a failure is actionable without re-running anything; and it is registered as a required check, so a merge cannot route around it. A check missing any one of those four is a diagnostic, which is useful, but it will not stop a bad artifact from shipping.

The second design question is what a gate should do about a violation it cannot classify. The temptation is to warn and continue, on the grounds that a false positive blocking a release is worse than a real defect reaching one. In practice that reasoning inverts within a quarter: warnings accumulate, the log stops being read, and the gate becomes decorative. The more durable pattern is to fail on everything and maintain an explicit, dated allowlist of known exceptions with an owner against each — so the exceptions are visible, countable, and uncomfortable enough to get fixed.

Finally, a gate is only worth what its last failure proved. An assertion that has never rejected anything has not been shown to work; it has only been shown not to complain. Feeding each gate a deliberately broken fixture — a tileset with an inverted geometric error, a LAS file with no CRS, a mesh with a hole — and requiring it to refuse them is the cheapest way to keep the suite honest, and it costs one extra test file per gate.

## Step-by-Step Workflow

Order the gates cheapest-first. Schema parsing is milliseconds, geometry traversal is seconds, and a full `3d-tiles-validator` run is the most expensive, so run them in that sequence and short-circuit on the first failure.

### 1. Schema gate on tileset.json and metadata

Validate `tileset.json` against a JSON Schema before touching geometry. This catches missing `asset.version`, malformed `boundingVolume`, or metadata whose type does not match its declared class.

```python
import json
from jsonschema import Draft202012Validator

# Minimal structural schema for a 3D Tiles 1.1 tileset root.
TILESET_SCHEMA = {
    "type": "object",
    "required": ["asset", "geometricError", "root"],
    "properties": {
        "asset": {"type": "object", "required": ["version"],
                  "properties": {"version": {"enum": ["1.0", "1.1"]}}},
        "geometricError": {"type": "number", "minimum": 0},
        "root": {"type": "object",
                 "required": ["boundingVolume", "geometricError"]},
    },
}

def schema_gate(tileset_path):
    tileset = json.loads(open(tileset_path).read())
    errors = sorted(Draft202012Validator(TILESET_SCHEMA).iter_errors(tileset),
                    key=lambda e: e.path)
    for e in errors:
        print(f"SCHEMA FAIL {list(e.path)}: {e.message}")
    return not errors

assert schema_gate("tileset/tileset.json"), "schema gate failed"
```

### 2. Geometry gate: monotonic geometricError and bounding-volume containment

Walk the tree and assert that no child's `geometricError` exceeds its parent's and that every child box sits inside its parent box. Both are invariants the client trusts and the schema does not enforce.

```python
import numpy as np

def _box_extent(box):
    """3D Tiles 'box' -> (min_corner, max_corner) in the tile's frame."""
    c = np.array(box[:3]); hx, hy, hz = box[3], box[7], box[11]
    half = np.array([abs(hx), abs(hy), abs(hz)])
    return c - half, c + half

def geometry_gate(tile, parent_error=float("inf"), parent_box=None):
    ge = tile["geometricError"]
    if ge > parent_error + 1e-6:
        raise AssertionError(f"geometricError increased: {ge} > {parent_error}")
    box = tile.get("boundingVolume", {}).get("box")
    if box and parent_box is not None:
        cmin, cmax = _box_extent(box)
        pmin, pmax = _box_extent(parent_box)
        if not (np.all(cmin >= pmin - 1e-3) and np.all(cmax <= pmax + 1e-3)):
            raise AssertionError("child bounding volume escapes parent")
    for child in tile.get("children", []):
        geometry_gate(child, ge, box)
    return True

tileset = json.loads(open("tileset/tileset.json").read())
geometry_gate(tileset["root"])
```

The monotonicity invariant is the single most common silent failure in tiling; the deep dive on wiring it, plus the transform check, is [writing 3d-tiles-validator checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/).

<figure class="diagram">
<svg viewBox="24 8 712 290" role="img" aria-labelledby="dv-mono-t dv-mono-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dv-mono-t">The two tree invariants a validator will not check for you</title>
  <desc id="dv-mono-d">Geometric error must fall strictly from parent to child, and each parent's bounding volume must contain every child's. Both are properties of a pair of nodes rather than of any single node, so a per-node schema check cannot express either, and the reference validator only checks the second.</desc>
  <rect class="svg-bg" x="24" y="8" width="712" height="290" fill="#ffffff"/>
  <defs>
    <marker id="dv-mono-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="120" y="48" width="180" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="40" y="150" width="150" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="230" y="150" width="150" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#dv-mono-a)">
    <path d="M180 92 C 160 116 140 128 118 146"/>
    <path d="M250 92 C 268 116 288 128 306 146"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="210" y="76">parent — error 128 m</text>
    <text x="115" y="178">child — 64 m</text>
    <text x="305" y="178">child — 140 m</text>
  </g>
  <text x="210" y="234" fill="#b0413e" font-size="12" text-anchor="middle">larger than its parent — refinement stops here</text>
  <path d="M440 48 h260 v146 h-260 Z" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M462 74 h100 v96 h-100 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M582 74 h140 v96 h-140 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="570" y="36" fill="#1f2937" font-size="12.5" text-anchor="middle">bounding-volume containment</text>
  <text x="570" y="234" fill="#b0413e" font-size="12" text-anchor="middle">a child crossing the boundary is culled with it</text>
  <text x="370" y="258" fill="#15384a" font-size="12.5" text-anchor="middle">Both are pairwise properties, so no per-node schema can express them — they need their own pass over the tree</text>
  <text x="370" y="280" fill="#5b6471" font-size="12" text-anchor="middle">And both fail silently: no error, no missing file, just geometry that refuses to appear or refine</text>
</svg>
<figcaption>These are the two checks worth writing yourself. Everything else in a tileset gate is available off the shelf.</figcaption>
</figure>

### 3. CRS and units gate with pyproj

Assert the source CRS is projected and metric before anything is tiled, because `geometricError` is meaningless in degrees. Inspect the CRS with `pyproj` rather than trusting a filename or a sidecar.

```python
from pyproj import CRS

def crs_gate(epsg_code):
    crs = CRS.from_epsg(epsg_code)
    if not crs.is_projected:
        raise AssertionError(f"EPSG:{epsg_code} is geographic, need a projected CRS")
    units = {ax.unit_name for ax in crs.axis_info}
    if not units <= {"metre", "meter"}:
        raise AssertionError(f"EPSG:{epsg_code} axis units are {units}, need metres")
    return True

crs_gate(32618)          # UTM 18N, projected metres -> passes
# crs_gate(4326)         # WGS84 degrees -> raises, correctly rejected
```

The full treatment — round-tripping a control point and rejecting EPSG:4326 while accepting EPSG:32618 — is in [asserting CRS and units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/).

### 4. LAS header gate with laspy

For point-cloud sources, read the LAS header and assert scale, offset, and CRS are sane before the cloud is thinned into `pnts`. A wrong scale factor multiplies every coordinate.

```python
import laspy

def las_header_gate(las_path, expected_epsg=32618):
    with laspy.open(las_path) as reader:
        header = reader.header
        if header.point_count == 0:
            raise AssertionError(f"{las_path}: empty point cloud")
        if not all(s > 0 for s in header.scales):
            raise AssertionError(f"{las_path}: non-positive scale {header.scales}")
        crs = header.parse_crs()
        if crs is None or crs.to_epsg() != expected_epsg:
            got = None if crs is None else crs.to_epsg()
            raise AssertionError(f"{las_path}: CRS EPSG:{got}, expected {expected_epsg}")
    return True

las_header_gate("survey/block_12.laz", expected_epsg=32618)
```

### 5. Mesh watertightness gate with trimesh

For `b3dm` sources, assert the mesh is watertight and winding-consistent, because a hole that survives into tiling becomes a visible gap at coarse LODs after decimation.

```python
import trimesh

def watertight_gate(mesh_path):
    mesh = trimesh.load(mesh_path, force="mesh", process=False)
    if not mesh.is_winding_consistent:
        raise AssertionError(f"{mesh_path}: inconsistent winding")
    if not mesh.is_watertight:
        broken = trimesh.repair.broken_faces(mesh)
        raise AssertionError(f"{mesh_path}: not watertight, {len(broken)} broken faces")
    return True

watertight_gate("blocks/tower_a.ply")
```

### 6. Run 3d-tiles-validator and wire every gate as a blocking check

Finish with the reference validator, then compose all gates into one runner that exits non-zero the moment any gate fails, so the CI job stops before the publish step.

```python
import subprocess, sys

def official_validator(tileset_path):
    result = subprocess.run(
        ["npx", "3d-tiles-validator", "--tilesetFile", tileset_path],
        capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout, result.stderr)
    return result.returncode == 0

def run_gates(tileset_path, las_paths, mesh_paths, epsg=32618):
    checks = [
        ("schema",     lambda: schema_gate(tileset_path)),
        ("geometry",   lambda: geometry_gate(json.loads(open(tileset_path).read())["root"])),
        ("crs",        lambda: crs_gate(epsg)),
        ("las",        lambda: all(las_header_gate(p, epsg) for p in las_paths)),
        ("mesh",       lambda: all(watertight_gate(p) for p in mesh_paths)),
        ("validator",  lambda: official_validator(tileset_path)),
    ]
    for name, check in checks:
        try:
            if not check():
                print(f"GATE FAILED: {name}"); sys.exit(1)
        except AssertionError as err:
            print(f"GATE FAILED: {name}: {err}"); sys.exit(1)
    print("all gates passed")

# run_gates("tileset/tileset.json", laz_files, mesh_files, epsg=32618)
```

## Validation & Verification

The gates validate the data; a small self-test validates the gates. Confirm each rejects a known-bad input and accepts a known-good one — a gate that never fails is not a gate.

```python
# The CRS gate must reject geographic degrees and accept projected metres.
try:
    crs_gate(4326); raised = False
except AssertionError:
    raised = True
assert raised, "CRS gate failed to reject EPSG:4326"
assert crs_gate(32618)

# The geometry gate must reject an inverted geometricError.
bad = {"geometricError": 10.0, "boundingVolume": {"box": [0,0,0, 5,0,0, 0,5,0, 0,0,5]},
       "children": [{"geometricError": 40.0,
                     "boundingVolume": {"box": [0,0,0, 2,0,0, 0,2,0, 0,0,2]},
                     "children": []}]}
try:
    geometry_gate(bad); raised = False
except AssertionError:
    raised = True
assert raised, "geometry gate failed to catch inversion"
print("gate self-tests passed")
```

```text
SCHEMA FAIL []: 'root' is a required property   # example rejection message
GATE FAILED: crs: EPSG:4326 is geographic, need a projected CRS
gate self-tests passed
all gates passed
```

Expected verdicts: EPSG:4326 rejected, EPSG:32618 accepted, an inverted `geometricError` raised, an empty `.laz` rejected, and a non-watertight `.ply` flagged with a broken-face count. The runner exits 0 only when all six clear.

<figure class="diagram">
<svg viewBox="8 6 744 312" role="img" aria-labelledby="dv-order-t dv-order-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dv-order-t">Gate cost, and therefore gate order</title>
  <desc id="dv-order-d">The static checks cost seconds and the browser-based ones cost minutes. Ordering the gate cheapest first means a build with a broken CRS fails in four seconds instead of after a ten-minute render, and the expensive checks only ever run on artifacts that already passed everything cheap.</desc>
  <rect class="svg-bg" x="8" y="6" width="744" height="312" fill="#ffffff"/>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Run them cheapest first — the expensive ones then only ever see plausible artifacts</text>
  <rect x="300" y="58" width="18" height="22" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="90" width="18" height="22" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="122" width="18" height="22" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="154" width="18" height="22" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="186" width="50" height="22" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="300" y="218" width="220" height="22" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="300" y="250" width="399" height="22" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12">
    <text x="290" y="74" text-anchor="end">term / schema lint</text>
    <text x="328" y="74" text-anchor="start" font-size="11.5">2 s</text>
    <text x="290" y="106" text-anchor="end">geometry invariants</text>
    <text x="328" y="106" text-anchor="start" font-size="11.5">6 s</text>
    <text x="290" y="138" text-anchor="end">CRS and unit assertions</text>
    <text x="328" y="138" text-anchor="start" font-size="11.5">4 s</text>
    <text x="290" y="170" text-anchor="end">LAS header checks</text>
    <text x="328" y="170" text-anchor="start" font-size="11.5">9 s</text>
    <text x="290" y="202" text-anchor="end">3d-tiles-validator</text>
    <text x="360" y="202" text-anchor="start" font-size="11.5">48 s</text>
    <text x="290" y="234" text-anchor="end">watertightness over all meshes</text>
    <text x="530" y="234" text-anchor="start" font-size="11.5">210 s</text>
    <text x="290" y="266" text-anchor="end">headless render + screenshot diff</text>
    <text x="709" y="266" text-anchor="start" font-size="11.5">380 s</text>
  </g>
  <text x="380" y="300" fill="#15384a" font-size="12" text-anchor="middle">Total 659 s if everything runs, 21 s to fail a build whose CRS is wrong — the ordering is worth more than any single optimisation</text>
</svg>
<figcaption>Ordering is free and compounding. Every cheap gate you put in front of the render is a class of failure the render never has to reproduce.</figcaption>
</figure>

## Performance & Scale

The cost ordering matters at city scale. Schema validation and the CRS gate are effectively free and should run on every commit. The geometry traversal is linear in tile count — a few hundred thousand tiles validate in seconds if `_box_extent` stays vectorized and the walk is iterative rather than deeply recursive. The `3d-tiles-validator` and the per-mesh watertightness checks dominate, so scope them: validate the whole tileset structure every run, but only re-run the watertightness gate on meshes whose source hash changed, cached the same way incremental tiling caches its `.b3dm` outputs. LAS header checks are header-only reads, so they scale to thousands of tiles cheaply — never parse the full point records to check a header. Run the cheap gates as a fast pre-commit hook and the expensive ones in the CI job, so a developer gets the schema and CRS verdict in under a second and the full funnel runs before publish.

## Failure Modes & Gotchas

**A gate passes locally and fails in CI.** The toolchain drifted — a newer `3d-tiles-validator` tightened a rule, or `pyproj` shipped a different PROJ database that resolves an EPSG code differently. Pin every version in the table above and run the gates in the same container locally and in CI so the verdict is identical.

**The schema gate passes but the tileset still renders wrong.** JSON Schema only checks structure, not semantics — it cannot know that a `geometricError` inverted between parent and child, or that a box is placed in the wrong frame. That is exactly why the geometry and CRS gates exist alongside it; never treat schema validity as sufficient.

**The CRS gate accepts a compound CRS you did not expect.** `is_projected` is true for the horizontal component of some compound systems, so a check that only inspects projection can miss a vertical-datum problem. Assert the specific EPSG code you expect (for example EPSG:32618, or the compound EPSG:32618+5703 when heights matter), not merely that some projection exists.

**Watertightness fails on a mesh that looks closed.** `trimesh` reports non-watertight when winding is inconsistent or duplicate vertices leave edges unmerged, even if the surface appears sealed. Run `mesh.merge_vertices()` and `trimesh.repair.fix_winding()` in the source pipeline before the gate, and treat a persistent failure as a real topology defect to fix upstream, not a gate to relax.

## Frequently Asked Questions

### Should these gates block the build or just warn?

Block. A gate that only warns is ignored within a week, and the defects it catches — an inverted `geometricError`, a geographic CRS, a hole in a mesh — render silently wrong rather than crashing, so nobody notices the warning until a measurement is disputed. Exit non-zero and stop the publish step; make passing the gates the only path to a CDN.

### Is 3d-tiles-validator enough on its own?

No. The official validator checks the schema, non-negative and generally decreasing `geometricError`, and bounding-volume containment, which is a strong baseline. It does not check your source CRS, your LAS headers, or your mesh watertightness, and it cannot know your project's expected EPSG code. Run it as one gate among several, not as the whole QA story.

### How do I gate metadata as well as geometry?

Extend the JSON Schema in step 1 to cover the 3D Metadata schema classes your tileset declares — assert that each property's type, componentType, and enum values match the class definition. A metadata property whose type drifts from its schema breaks styling and querying downstream just as surely as bad geometry breaks rendering.

### Where do these gates run in a real pipeline?

In CI, between the tiling job and the deploy job, as a required check. The cheap gates also belong in a pre-commit hook for fast local feedback. The CI wiring — caching, matrix jobs, and artifact promotion — is covered in the CI/CD automation guide linked below; this page defines what each gate asserts, not the runner it executes in.

One last practical point: keep the gate runnable outside CI. A developer who can run the same command locally and get the same verdict will fix the fault before opening a pull request; one who has to push and wait six minutes to see the result will start disabling checks. The gate and the CI step should differ only in who invokes them.

## Related Guides

- [Validating glTF Assets with the Khronos Validator](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-gltf-assets-with-the-khronos-validator/) — run the Khronos glTF-Validator over tile content in CI
- [Writing 3D Tiles Validator Checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — the geometry and transform gates as a CI job
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the CRS gate in full, EPSG:32618 versus EPSG:4326
- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — the runner that executes these gates before deploy
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — the tiling step whose output these gates validate
- [Checking Point Cloud Classification Completeness](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/checking-point-cloud-classification-completeness/) — audit a delivered classification before you depend on it
- [Validating Attribute Tables with Pandera](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-attribute-tables-with-pandera/) — catch bad building attributes before they reach a tileset
- [Validating Tileset Bounding Volumes Against Content](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-tileset-bounding-volumes-against-content/) — prove every tile's bounding volume contains its geometry

Back to [Digital Twin Troubleshooting & Reliability](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/).
