# Validating glTF Assets with the Khronos Validator

This page runs the Khronos glTF-Validator over the geometry inside a 3D Tiles tileset — extracting GLB payloads from legacy `.b3dm` tiles, validating each in Node with the `gltf-validator` package, aggregating the JSON reports in Python, and failing a CI build according to a severity policy with an explicit allowlist, for tiles whose content sits in EPSG:4978 relative to tile centres.

## Why you hit this

The 3D Tiles validator checks tileset structure: JSON schemas, bounding volumes, tile formats, metadata. It does not look deeply inside the glTF each tile contains, and that is where most rendering defects originate — accessor bounds that do not match the data, so culling removes visible geometry; normals that are not unit length, so lighting is wrong; NaN positions from a failed decimation, which some GPUs draw as spikes to infinity; index buffers referencing vertices that do not exist. The Khronos validator is the reference implementation of the glTF specification and catches all of these. Pairing the two is the subject of this page; the tileset-level checks are in [writing 3D Tiles validator checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/).

## Prerequisites

- Node.js 18+ with `gltf-validator` from npm (the package publishes the same validator used by the online Khronos tool).
- Python 3.10+ with the standard library; `numpy>=1.24` only for summary statistics.
- Tile content as `.glb` or `.b3dm`; `.i3dm` and `.cmpt` follow the same extraction pattern with different headers.

## Step-by-Step

### 1. Extract GLB payloads from b3dm tiles

A `.b3dm` file is a 28-byte header, a feature table, a batch table, and then a complete GLB. Extracting the GLB lets the validator see exactly what the runtime decodes.

```python
import struct
from pathlib import Path

def extract_glb(b3dm_path):
    data = Path(b3dm_path).read_bytes()
    magic, version, byte_len, ft_json, ft_bin, bt_json, bt_bin = struct.unpack_from("<4s6I", data, 0)
    if magic != b"b3dm":
        raise ValueError(f"{b3dm_path}: not b3dm ({magic!r})")
    if byte_len != len(data):
        raise ValueError(f"{b3dm_path}: header says {byte_len} bytes, file has {len(data)}")
    start = 28 + ft_json + ft_bin + bt_json + bt_bin
    glb = data[start:]
    if glb[:4] != b"glTF":
        raise ValueError(f"{b3dm_path}: payload at offset {start} is not GLB")
    return glb

SRC = Path("tiles/city")
WORK = Path("build/validate"); WORK.mkdir(parents=True, exist_ok=True)
manifest = {}
for tile in sorted(SRC.rglob("*.b3dm")) + sorted(SRC.rglob("*.glb")):
    out = WORK / (tile.relative_to(SRC).as_posix().replace("/", "__") + ".glb")
    out.write_bytes(extract_glb(tile) if tile.suffix == ".b3dm" else tile.read_bytes())
    manifest[out.name] = tile.relative_to(SRC).as_posix()
print(f"{len(manifest)} GLB payloads ready")
```

The byte-length check catches truncated uploads before validation reports a confusing buffer error, and the GLB magic check catches the old `.b3dm` layout from the 3D Tiles pre-1.0 era, whose header was 20 or 24 bytes and which some ancient tilers still write.

### 2. Validate each payload in Node

```javascript
// validate.mjs — node validate.mjs build/validate > build/gltf_reports.json
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import validator from "gltf-validator";

const dir = process.argv[2];
const reports = {};
for (const name of readdirSync(dir).filter((f) => f.endsWith(".glb"))) {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  const report = await validator.validateBytes(bytes, {
    uri: name,
    maxIssues: 200,
    externalResourceFunction: (uri) => Promise.reject(new Error(`external resource ${uri} not allowed in tiles`)),
  });
  reports[name] = {
    errors: report.issues.numErrors,
    warnings: report.issues.numWarnings,
    infos: report.issues.numInfos,
    messages: report.issues.messages.map(({ code, severity, pointer, message }) => ({ code, severity, pointer, message })),
    extensions: report.info?.extensionsUsed ?? [],
    triangles: report.info?.totalTriangleCount ?? null,
  };
}
process.stdout.write(JSON.stringify(reports));
```

Rejecting external resources is deliberate for tile content: a GLB inside a tileset should be self-contained, and a tile that references an external `.bin` or texture by URI works on the developer's machine and 404s in production. The validator reports the failed resolution as an error, which is exactly the outcome wanted.

<figure class="diagram">
<svg viewBox="-4 56 768 142" role="img" aria-labelledby="gv-flow-t gv-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gv-flow-t">Validation pipeline for tile content</title>
  <desc id="gv-flow-d">Tiles in b3dm or glb format are unpacked by Python into plain GLB payloads. A Node script validates each payload with the Khronos gltf-validator and writes a combined JSON report. Python then applies a severity policy and an allowlist of issue codes and exits non-zero if any tile violates the policy, which fails the CI job.</desc>
  <rect class="svg-bg" x="-4" y="56" width="768" height="142" fill="#ffffff"/>
  <defs>
    <marker id="gv-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="70" width="120" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="170" y="70" width="140" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="350" y="70" width="150" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="540" y="70" width="210" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#gv-flow-arrow)">
    <path d="M130 100 H168"/><path d="M310 100 H348"/><path d="M500 100 H538"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="70" y="96">.b3dm / .glb</text><text x="70" y="113">tiles</text>
    <text x="240" y="96">Python</text><text x="240" y="113">extract GLB</text>
    <text x="425" y="96">Node</text><text x="425" y="113">gltf-validator</text>
    <text x="645" y="96">Python: policy</text><text x="645" y="113">+ allowlist → exit code</text>
  </g>
  <text x="380" y="180" fill="#15384a" font-size="12.5" text-anchor="middle">The validator runs where it was written; policy lives where the rest of the pipeline does.</text>
</svg>
<figcaption>Using the validator's own JavaScript build avoids re-implementing the specification checks, and keeps the pass/fail rules in reviewable Python.</figcaption>
</figure>

### 3. Apply a severity policy with an allowlist

```python
import json
import subprocess
import sys
from collections import Counter

raw = subprocess.run(["node", "validate.mjs", str(WORK)], capture_output=True, text=True, check=True).stdout
reports = json.loads(raw)

SEVERITY = {0: "error", 1: "warning", 2: "info", 3: "hint"}
FAIL_ON = {"error"}
FAIL_ON_CODES = {"ACCESSOR_NON_UNIT", "ACCESSOR_INVALID_FLOAT", "ACCESSOR_MIN_MISMATCH", "ACCESSOR_MAX_MISMATCH"}
ALLOW = {
    "UNSUPPORTED_EXTENSION": "CESIUM_RTC and EXT_structural_metadata are handled by the runtime, not the validator",
    "UNUSED_OBJECT": "tilers emit unused samplers; harmless",
}

violations, codes = [], Counter()
for name, rep in reports.items():
    for m in rep["messages"]:
        codes[m["code"]] += 1
        sev = SEVERITY[m["severity"]]
        if m["code"] in ALLOW:
            continue
        if sev in FAIL_ON or m["code"] in FAIL_ON_CODES:
            violations.append((manifest[name], m["code"], m["pointer"], m["message"]))

print("most frequent codes:", codes.most_common(8))
for tile, code, pointer, message in violations[:20]:
    print(f"FAIL {tile}: {code} at {pointer} — {message}")
print(f"{len(violations)} violations in {len({v[0] for v in violations})} of {len(reports)} tiles")
sys.exit(1 if violations else 0)
```

The policy has three layers. Every error fails. A short list of warnings that correspond to visible rendering defects also fails: non-unit normals break lighting, invalid floats produce spikes, and accessor min/max mismatches break culling, because runtimes use those bounds to decide whether geometry is on screen. Everything else is reported but tolerated, and the allowlist carries a written reason for each code it suppresses, so the next person to see `UNSUPPORTED_EXTENSION` knows it was a decision rather than an oversight.

<figure class="diagram">
<svg viewBox="6 6 748 244" role="img" aria-labelledby="gv-pol-t gv-pol-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gv-pol-t">Severity policy for tile content</title>
  <desc id="gv-pol-d">A layered policy. All errors fail the build. A named set of warnings that cause visible defects also fail: non-unit normals, invalid floats, and accessor minimum or maximum mismatches. Other warnings, infos and hints are reported. Codes on the allowlist, each with a written reason, are ignored.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="244" fill="#ffffff"/>
  <rect x="20" y="20" width="720" height="48" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="20" y="76" width="720" height="48" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="20" y="132" width="720" height="48" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="20" y="188" width="720" height="48" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="49">every error</text>
    <text x="40" y="105">warnings: ACCESSOR_NON_UNIT · ACCESSOR_INVALID_FLOAT · ACCESSOR_MIN/MAX_MISMATCH</text>
    <text x="40" y="161">other warnings, infos, hints</text>
    <text x="40" y="217">allowlisted codes, each with a written reason</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="end">
    <text x="720" y="49">fail</text>
    <text x="720" y="161">report</text>
    <text x="720" y="217">ignore</text>
  </g>
  <text x="720" y="105" fill="#1f2937" font-size="12.5" text-anchor="end">fail</text>
</svg>
<figcaption>Promoting a handful of warnings to failures targets the defects a user would actually see, without failing builds over cosmetic issues.</figcaption>
</figure>

### 4. Validate a sample on every build, everything on release

```python
import random

def select_tiles(all_names, changed, sample_frac=0.02, seed=20260917):
    rng = random.Random(seed)
    sample = {n for n in all_names if rng.random() < sample_frac}
    return sorted(sample | set(changed))

changed = [n for n, src in manifest.items() if src.startswith("content/16/")]   # from the incremental build manifest
subset = select_tiles(list(manifest), changed)
print(f"validating {len(subset)} of {len(manifest)} tiles on this build")
```

A city tileset with half a million tiles takes hours to validate fully in one process. Validating every changed tile plus a fixed-seed random sample on each build keeps CI fast while still catching regressions that affect unchanged content, such as a tiler upgrade; a full run belongs on release branches or a nightly schedule. The changed set comes from the manifest described in [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).

## Expected Output & Verification

```text
18342 GLB payloads ready
most frequent codes: [('UNSUPPORTED_EXTENSION', 18342), ('UNUSED_OBJECT', 9120), ('ACCESSOR_NON_UNIT', 214), ('MESH_PRIMITIVE_GENERATED_TANGENT_SPACE', 88)]
FAIL content/15/17622/11263.b3dm: ACCESSOR_NON_UNIT at /accessors/2 — 12 accessor elements not of unit length: 0.93…
…
214 violations in 31 of 18342 tiles
```

Verify the gate itself with known-bad fixtures. Keep three small GLB files in the repository — one with a NaN position, one with a normal of length 0.9, one with an accessor `max` smaller than the data — and assert that the policy fails each with the expected code. A validation step that has never been seen to fail is not known to work.

The fixtures earn their keep most when the validator itself is upgraded. New releases occasionally rename a code, split one check into two, or change a severity, and a policy keyed on code names then silently stops matching. Running the fixture assertions in the same job as the real validation turns a renamed code into a red build on the day of the upgrade, instead of a quiet gap discovered months later when a spiky tile reaches production. Pin the validator version in the lockfile, and treat a bump as a change that has to pass the fixtures before it merges.

```python
fixtures = {"nan_position.glb": "ACCESSOR_INVALID_FLOAT", "short_normal.glb": "ACCESSOR_NON_UNIT",
            "bad_max.glb": "ACCESSOR_MAX_MISMATCH"}
fx = json.loads(subprocess.run(["node", "validate.mjs", "tests/fixtures"], capture_output=True,
                               text=True, check=True).stdout)
for name, code in fixtures.items():
    assert any(m["code"] == code for m in fx[name]["messages"]), f"{name} did not report {code}"
print("gate detects every fixture defect")
```

<figure class="diagram">
<svg viewBox="26 16 574 210" role="img" aria-labelledby="gv-codes-t gv-codes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gv-codes-t">Where failing tiles come from</title>
  <desc id="gv-codes-d">A bar chart of failing issue codes by pipeline stage that introduced them in a city build. Decimation produced most non-unit normals and all invalid floats. The tiler's quantisation produced accessor minimum and maximum mismatches. Texture baking produced a small number of generated tangent-space warnings, which are reported but do not fail.</desc>
  <rect class="svg-bg" x="26" y="16" width="574" height="210" fill="#ffffff"/>
  <path d="M40 20 V180" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="40" y="30" width="300" height="36" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <rect x="40" y="80" width="120" height="36" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
  <rect x="40" y="130" width="60" height="36" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="352" y="53">decimation: NON_UNIT, INVALID_FLOAT</text>
    <text x="172" y="103">quantisation: MIN/MAX_MISMATCH</text>
    <text x="112" y="153">texture baking: tangent space (report only)</text>
  </g>
  <text x="360" y="208" fill="#15384a" font-size="12.5" text-anchor="middle">failing codes, grouped by the pipeline stage that introduced them</text>
</svg>
<figcaption>Grouping issue codes by the stage that emits them turns a validation report into a to-do list for a specific team.</figcaption>
</figure>

## Common Errors

**`Error: Cannot find module 'gltf-validator'`.** The package was installed in a different directory from the script, or CI cached `node_modules` from another job. Install it in the job with `npm ci` against a lockfile that pins the validator version, so a validator upgrade is a reviewed change.

**Every tile reports `BUFFER_VIEW_TOO_BIG` or `GLB_UNEXPECTED_END_OF_CHUNK_DATA`.** The GLB was extracted from the wrong offset: a batch table length was ignored, or the file used the legacy b3dm header. Print the four header lengths for one failing tile and compare them against the file size.

**The validator process runs out of memory on large tiles.** `validateBytes` holds the full report and resources in memory. Validate files one per call as the script does, rather than collecting all bytes first, and increase Node's heap with `--max-old-space-size` for photogrammetry tiles above a few hundred megabytes.

## Frequently Asked Questions

### Does validation replace visual QA?

No. A valid glTF can still be a wrong model: misplaced, mis-scaled or decimated to mush. Validation removes a class of silent specification defects so that visual review can concentrate on content.

### Should extension-related infos ever fail the build?

Only when an extension is *required* and your runtime does not support it — then it is a real failure the validator cannot judge. Check `extensionsRequired` against the list your viewer supports as a separate, explicit rule.

### Can I validate Draco- or meshopt-compressed tiles?

Yes. The validator checks the glTF structure and extension declarations; for deep checks of the decoded data, validate the uncompressed output of the stage before compression as well, where accessor bounds and normals can be checked directly.

## Related Guides

- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the same gate pattern for vector and point data
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — the checks glTF validation cannot do
- [Draco vs Meshopt Compression for glTF Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/draco-vs-meshopt-compression-for-gltf-tiles/) — the compression stage validated here

Back to [Data Validation & QA Gates for 3D Tiles](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
