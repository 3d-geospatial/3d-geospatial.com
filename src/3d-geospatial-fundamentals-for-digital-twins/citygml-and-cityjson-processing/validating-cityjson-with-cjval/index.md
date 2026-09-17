---
title: "Validating CityJSON with cjval"
description: "Gate city models in CI with cjval and val3dity: schema and structure versus geometric validity, error codes worth failing on, tolerances"
---
# Validating CityJSON with cjval

This page builds a validation gate for CityJSON city models from two tools that check different things — `cjval` for the schema and the file's internal structure, and `val3dity` for geometric validity of the solids and surfaces — with a severity policy, sensible tolerances for LOD2 data in EPSG:25832, and a per-building report a modeller can act on.

## Why you hit this

A city model can be perfectly valid JSON, load in every viewer, and still be unusable: a solid that is not closed has no volume, a non-planar "planar" surface triangulates differently in every tool, a semantics array one element short silently mislabels every surface after it, and a `parents` reference to a building that is not in the file breaks any join to a register. None of that is visible on screen. Validating is how a pipeline stops a bad delivery at the door rather than discovering it three stages later in a mesh that will not close — the problem chased from the other end in [making meshes watertight for volume calculations](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/making-meshes-watertight-for-volume-calculations/).

## Prerequisites

- `cjval` (the CityJSON validator; `cargo install cjval` or a release binary) and `val3dity` 2.x.
- Python 3.10+ with `numpy>=1.24` for the reporting step.
- A CityJSON 1.1 or 2.0 file in a metric CRS — tolerances below are in metres and assume EPSG:25832 with DHHN2016 heights.

## Step-by-Step

### 1. Run cjval and read what it checks

```python
import subprocess
from pathlib import Path

src = Path("district_lod2.city.json")
res = subprocess.run(["cjval", str(src)], capture_output=True, text=True)
print(res.stdout[-1800:])
print("exit code:", res.returncode)
```

`cjval` works through a fixed list: the file parses as JSON; it validates against the CityJSON schema for the version it declares; any `extensions` it references resolve and their schemas validate; every `parents` and `children` reference points at an object that exists; `semantics` `values` arrays have the same shape as the boundaries they label; the `geographicalExtent` matches the vertices; and it reports duplicate and orphan vertices. The first four are errors — the file is not CityJSON. The last three are warnings: the file is valid but something is inconsistent or wasteful.

<figure class="diagram">
<svg viewBox="6 6 748 248" role="img" aria-labelledby="cjval-scope-t cjval-scope-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjval-scope-t">What each validator covers</title>
  <desc id="cjval-scope-d">Two columns. cjval covers JSON syntax, the CityJSON schema, extension schemas, parent and child references, semantic array shapes, the declared extent and duplicate or orphan vertices. val3dity covers ring closure and self-intersection, polygon planarity, whether shells are closed and two-manifold, normal orientation, self-intersecting solids and intersecting solids. Nothing overlaps, so both are needed.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="248" fill="#ffffff"/>
  <rect x="20" y="20" width="350" height="220" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="390" y="20" width="350" height="220" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="48">cjval — is it CityJSON?</text>
    <text x="40" y="76">· JSON syntax</text>
    <text x="40" y="98">· schema for the declared version</text>
    <text x="40" y="120">· extension schemas resolve</text>
    <text x="40" y="142">· parents / children references exist</text>
    <text x="40" y="164">· semantics values match boundaries</text>
    <text x="40" y="186">· geographicalExtent matches vertices</text>
    <text x="40" y="208">· duplicate and orphan vertices (warning)</text>
    <text x="410" y="48">val3dity — is the geometry valid?</text>
    <text x="410" y="76">· rings closed, not self-intersecting</text>
    <text x="410" y="98">· polygons planar within a tolerance</text>
    <text x="410" y="120">· shells closed and 2-manifold</text>
    <text x="410" y="142">· normals oriented outward</text>
    <text x="410" y="164">· solids not self-intersecting</text>
    <text x="410" y="186">· solids not intersecting each other</text>
    <text x="410" y="208">· reports per object with error codes</text>
  </g>
</svg>
<figcaption>The two tools do not overlap. A file that passes cjval can be geometrically nonsense, and a geometrically perfect model can have a broken semantics array.</figcaption>
</figure>

### 2. Run val3dity with tolerances that match the data

```python
report = Path("build/val3dity_report.json")
report.parent.mkdir(exist_ok=True)

subprocess.run([
    "val3dity", str(src),
    "--report", str(report),
    "--planarity_d2p_tol", "0.05",       # 5 cm from the best-fit plane
    "--planarity_n_tol", "20",           # 20° between triangle normals
    "--snap_tol", "0.001",               # vertices within 1 mm are the same vertex
    "--overlap_tol", "0.05",             # tolerate 5 cm of solid interpenetration
], check=False)
print(report.stat().st_size, "bytes of report")
```

Every one of those tolerances is a statement about the data, not a way to silence the tool. LOD2 models produced from aerial photogrammetry have roof planes fitted to noisy points, so 5 cm from the plane and 20° between adjacent triangle normals is realistic; a CAD-derived model should be held to millimetres. The snap tolerance has to exceed the quantisation grid of the file's `transform` — with a millimetre grid, coincident vertices can differ by a millimetre — and `overlap_tol` matters because neighbouring terraced houses in a city model routinely share a party wall that is modelled twice, a few centimetres apart.

### 3. Summarise the report by error code

```python
import json
from collections import Counter

rep = json.loads(report.read_text())
codes = Counter()
per_object = {}
for feat in rep.get("features", []):
    errs = [e["code"] for e in feat.get("errors", [])]
    for prim in feat.get("primitives", []):
        errs += [e["code"] for e in prim.get("errors", [])]
    if errs:
        per_object[feat.get("id")] = errs
        codes.update(errs)

print(f"{rep.get('features_valid')} of {rep.get('features_total')} features valid")
for code, n in codes.most_common():
    print(f"  {code}: {n}")
```

The report's exact shape varies between val3dity versions, so print one feature before relying on field names. What is stable is the error-code vocabulary, and it is worth knowing by heart because the codes map to distinct causes: 1xx are ring problems, 2xx polygon problems, 3xx shell problems, 4xx solid problems.

<figure class="diagram">
<svg viewBox="6 6 748 266" role="img" aria-labelledby="cjval-codes-t cjval-codes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjval-codes-t">val3dity error families and what usually causes them</title>
  <desc id="cjval-codes-d">A table of error families. The 100 series covers rings with too few points, repeated consecutive points, unclosed rings and self-intersecting rings, usually from a bad export. The 200 series covers intersecting inner rings and non-planar polygons, usually from noisy roof fitting. The 300 series covers shells that are not closed, not two-manifold, or have badly oriented normals, usually from missing ground surfaces. The 400 series covers self-intersecting and mutually intersecting solids, usually from shared party walls.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="266" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="110" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="130" y="20" width="330" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="460" y="20" width="280" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="110" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="130" y="58" width="330" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="460" y="58" width="280" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="108" width="110" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="130" y="108" width="330" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="460" y="108" width="280" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="158" width="110" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="130" y="158" width="330" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="460" y="158" width="280" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="208" width="110" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="130" y="208" width="330" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="460" y="208" width="280" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="75" y="44">family</text>
    <text x="295" y="44">typical members</text>
    <text x="600" y="44">usual cause</text>
    <text x="75" y="88">1xx rings</text>
    <text x="295" y="80">too few points, repeated points,</text>
    <text x="295" y="98">ring not closed, ring self-intersects</text>
    <text x="600" y="88">faulty export</text>
    <text x="75" y="138">2xx polygons</text>
    <text x="295" y="130">inner rings intersect,</text>
    <text x="295" y="148">non-planar beyond tolerance</text>
    <text x="600" y="138">noisy roof plane fitting</text>
    <text x="75" y="188">3xx shells</text>
    <text x="295" y="180">not closed, not 2-manifold,</text>
    <text x="295" y="198">normals badly oriented</text>
    <text x="600" y="188">missing ground surface</text>
    <text x="75" y="238">4xx solids</text>
    <text x="295" y="230">self-intersecting,</text>
    <text x="295" y="248">intersecting other solids</text>
    <text x="600" y="238">shared party walls</text>
  </g>
</svg>
<figcaption>Grouping by family turns a wall of codes into three or four conversations: fix the exporter, loosen the planarity tolerance, or accept the party walls.</figcaption>
</figure>

### 4. Turn it into a gate with an explicit policy

```python
import sys

FAIL_CODES = {
    101, 102, 103, 104,        # rings — always a defect
    201, 202,                  # intersecting rings
    301, 302, 303,             # shells: not 2-manifold, not closed, bad orientation
    305,                       # self-intersecting shell
}
TOLERATED = {
    203: "non-planar beyond 5 cm — photogrammetric roof planes, accepted",
    204: "normal deviation — same cause as 203",
    401: "intersecting solids — shared party walls in terraced blocks",
}

violations = {oid: [c for c in errs if c in FAIL_CODES] for oid, errs in per_object.items()}
violations = {k: v for k, v in violations.items() if v}
tolerated = Counter(c for errs in per_object.values() for c in errs if c in TOLERATED)

print(f"{len(violations)} objects violate the policy; tolerated: {dict(tolerated)}")
for oid, errs in list(violations.items())[:10]:
    print(f"  FAIL {oid}: {sorted(set(errs))}")

unknown = {c for errs in per_object.values() for c in errs} - FAIL_CODES - set(TOLERATED)
if unknown:
    print("codes with no policy decision:", sorted(unknown))
sys.exit(1 if violations or unknown else 0)
```

Two properties make this a policy rather than a filter. Every tolerated code carries a written reason, so the next person knows it was a decision. And any code that appears without a decision fails the build — which is what stops a new class of defect from slipping through a gate that was tuned for the defects of a year ago.

### 5. Report per building so it can be fixed

```python
out = Path("build/validation_report.md")
lines = ["# CityJSON validation", "",
         f"- source: `{src.name}`",
         f"- features: {rep.get('features_total')}, valid: {rep.get('features_valid')}",
         f"- policy violations: {len(violations)}", "",
         "| building | codes | plan |", "|---|---|---|"]
for oid, errs in sorted(violations.items()):
    codes_s = ", ".join(str(c) for c in sorted(set(errs)))
    plan = "re-export" if any(c < 200 for c in errs) else "repair shell"
    lines.append(f"| `{oid}` | {codes_s} | {plan} |")
out.write_text("\n".join(lines))
print(out.read_text()[:400])
```

A report keyed by the building identifier is what makes validation actionable: the identifier is the same one in the register and in the source CityGML, so a modeller can open exactly those buildings. A report that says "1,204 errors" produces nothing.

## Expected Output & Verification

```text
district_lod2.city.json is valid
  warning: 341 duplicate vertices
  warning: 12 orphan vertices
exit code: 0
4731 of 4812 features valid
  203: 2884
  401: 512
  302: 44
  104: 3
44 objects violate the policy; tolerated: {203: 2884, 401: 512}
  FAIL DEBY_LOD2_4959323: [302]
  FAIL DEBY_LOD2_4959871: [104, 302]
```

Verify the gate the way any test is verified — with known-bad input. Keep three small fixtures in the repository: a file with an unclosed ring, one with a solid missing its ground surface, and one with a semantics array one element short. Assert that `cjval` rejects the third and `val3dity` reports 103 and 302 for the first two. A validation step nobody has watched fail is not known to work.

```python
FIXTURES = {"unclosed_ring.city.json": 103, "open_shell.city.json": 302}
for name, expected in FIXTURES.items():
    r = subprocess.run(["val3dity", f"tests/fixtures/{name}", "--report", "/tmp/fx.json"], check=False)
    got = {e["code"] for f in json.loads(Path("/tmp/fx.json").read_text()).get("features", [])
           for e in f.get("errors", [])}
    assert expected in got, f"{name}: expected code {expected}, got {sorted(got)}"
print("gate detects every fixture defect")
```

<figure class="diagram">
<svg viewBox="42 58 666 188" role="img" aria-labelledby="cjval-plan-t cjval-plan-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjval-plan-t">What the planarity tolerances measure</title>
  <desc id="cjval-plan-d">A roof polygon in section whose vertices do not lie exactly on one plane. The distance-to-plane tolerance measures the largest gap between any vertex and the best-fit plane through all of them. The normal-deviation tolerance measures the largest angle between the normals of the triangles the polygon is split into. A photogrammetric roof typically needs five centimetres and twenty degrees; a CAD model needs millimetres.</desc>
  <rect class="svg-bg" x="42" y="58" width="666" height="188" fill="#ffffff"/>
  <path d="M60 150 H420" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="6 4"/>
  <path d="M60 156 L150 140 L240 152 L330 138 L420 148" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="60" cy="156" r="4"/><circle cx="150" cy="140" r="4"/><circle cx="240" cy="152" r="4"/><circle cx="330" cy="138" r="4"/><circle cx="420" cy="148" r="4"/>
  </g>
  <path d="M330 150 V138" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="344" y="132" fill="#b0413e" font-size="12.5" text-anchor="start">largest distance to plane</text>
  <text x="240" y="186" fill="#1f2937" font-size="12.5" text-anchor="middle">best-fit plane through all vertices</text>
  <path d="M520 150 L600 116 L680 142" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M560 133 L575 100" fill="none" stroke="#9a4f26" stroke-width="2"/>
  <path d="M640 129 L650 96" fill="none" stroke="#9a4f26" stroke-width="2"/>
  <text x="600" y="86" fill="#9a4f26" font-size="12.5" text-anchor="middle">angle between triangle normals</text>
  <text x="600" y="186" fill="#1f2937" font-size="12.5" text-anchor="middle">same polygon, triangulated</text>
  <text x="380" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">Both tolerances describe the same defect; a photogrammetric roof needs 5 cm and 20°.</text>
</svg>
<figcaption>Planarity is not a yes or no property of real data. The tolerances say how far from flat a surface may be before it stops being usable.</figcaption>
</figure>

## Performance Notes

- **`cjval` is fast** — a second or two for a 40 MB tile, because it is schema and index work. Run it on every file, every time.
- **`val3dity` is geometric and much slower**, especially the solid-intersection checks, which are quadratic in the number of solids in a neighbourhood. Expect minutes for a district and hours for a city; disable the 4xx checks for routine runs and enable them on release.
- **Validate per tile in parallel processes.** Both tools are single-threaded per file.
- **Keep reports as build artefacts** with the tile name and source checksum, so the same delivery is never validated twice and a regression can be traced to a specific delivery.

## Common Errors

**`cjval` cannot resolve an extension schema.** The file references an extension by URL and the build machine has no network access. Vendor the extension schema and point the validator at the local copy, or validate extensions in a separate networked step.

**Thousands of 203 errors on a model that looks fine.** The planarity tolerance is tighter than the data's noise. Measure the actual deviation on a sample of roofs before choosing; do not set tolerances to whatever silences the tool.

**Every building reports 302, shell not closed.** LOD2 models often omit the ground surface, so their shells are open by construction. Either treat 302 as expected for that dataset and document it, or close the shells by adding the footprint as a `GroundSurface` before validating.

**`val3dity` reports nothing at all.** It validated no primitives, usually because the geometries are `MultiSurface` rather than `Solid` and the run asked only for solid checks. Surfaces get ring and planarity checks; only solids get shell and volume checks.

## Frequently Asked Questions

### Which errors should block a delivery being accepted?

Ring-level errors and unclosed or non-manifold shells, because no downstream tool can compensate for them. Planarity and solid-intersection findings are usually inherent to city models and belong in a report rather than a rejection.

### Can I repair the geometry automatically?

Partly. Snapping vertices within a tolerance fixes many ring problems, and adding a ground surface closes most shells. Anything beyond that — a self-intersecting roof, a wall that misses its neighbour by a metre — needs the model corrected at source, because a repair invents geometry nobody surveyed.

### Does a valid CityJSON guarantee a valid mesh after export?

No. Triangulation, decimation and quantisation all introduce their own defects, which is why the mesh gate exists separately in [validating glTF assets with the Khronos validator](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-gltf-assets-with-the-khronos-validator/).

## Related Guides

- [Converting CityGML to CityJSON with citygml-tools](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/converting-citygml-to-cityjson-with-citygml-tools/) — the step whose output this validates
- [Reprojecting and Upgrading CityJSON Files](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reprojecting-and-upgrading-cityjson-files/) — the other step that needs validating afterwards
- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the same pattern across formats

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
