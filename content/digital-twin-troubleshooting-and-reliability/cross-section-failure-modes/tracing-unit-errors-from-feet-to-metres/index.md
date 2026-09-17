# Tracing Unit Errors from Feet to Metres

This page finds the stage that applied the wrong length unit — recognising the handful of ratios that identify a unit error at a glance, distinguishing the US survey foot from the international foot where the difference matters, reading the unit declarations in IFC, CityGML and glTF, and placing a dimensional check at every pipeline handoff so the culprit is named rather than guessed.

## Why you hit this

A building arrives 3.28 times too small, or a stockpile volume is out by a factor of 35, or a city is placed 600 km from where it belongs. All three are unit errors, and all three are found by recognising a ratio rather than by reading code.

Unit errors are also uniquely likely to survive review. A model that is 3.28× too small still looks like a building; a volume that is 35× too large is still a number; and a coordinate that is 3.28× too large still lands on a map. Nothing about the data looks malformed, so the defect propagates until someone measures a known dimension.

## Prerequisites

- Python 3.10+ with `numpy`, `trimesh`, `ifcopenshell`, `pyproj`.
- The data at each pipeline boundary, or the ability to re-run with intermediates.
- One known dimension: a surveyed baseline, a door height, a parcel frontage.

## Step-by-Step

### 1. Learn the signature ratios

```python
import json
import math
from pathlib import Path

import numpy as np

FOOT_INTERNATIONAL = 0.3048
FOOT_US_SURVEY = 1200.0 / 3937.0        # 0.30480060960121924

RATIOS = {
    "feet_read_as_metres": {
        "ratio": 1.0 / FOOT_INTERNATIONAL,
        "value": 3.2808,
        "symptom": "the model is 3.28× too large, or a metric model is 3.28× too "
                   "small",
        "where": "a length in feet passed to code expecting metres",
    },
    "metres_read_as_feet": {
        "ratio": FOOT_INTERNATIONAL,
        "value": 0.3048,
        "symptom": "the model is 3.28× too small",
        "where": "a metric length multiplied by 0.3048 'to convert'",
    },
    "millimetres_read_as_metres": {
        "ratio": 1000.0,
        "value": 1000.0,
        "symptom": "the model is 1000× too large; a 12 m building spans 12 km",
        "where": "an IFC or CAD file in millimetres with no unit handling",
    },
    "centimetres_read_as_metres": {
        "ratio": 100.0,
        "value": 100.0,
        "symptom": "100× too large",
        "where": "a scanner export in centimetres",
    },
    "inches_read_as_metres": {
        "ratio": 1.0 / 0.0254,
        "value": 39.3701,
        "symptom": "39.4× too large",
        "where": "an imperial CAD drawing",
    },
    "square_feet_read_as_square_metres": {
        "ratio": 1.0 / (FOOT_INTERNATIONAL ** 2),
        "value": 10.7639,
        "symptom": "an area is 10.76× out",
        "where": "a declared footprint area against a computed one",
    },
    "cubic_feet_read_as_cubic_metres": {
        "ratio": 1.0 / (FOOT_INTERNATIONAL ** 3),
        "value": 35.3147,
        "symptom": "a volume is 35.3× out",
        "where": "an earthworks or stockpile quantity",
    },
    "us_survey_vs_international_foot": {
        "ratio": FOOT_US_SURVEY / FOOT_INTERNATIONAL,
        "value": 1.000002,
        "symptom": "2 ppm — 1.2 m over a 600 km state plane easting",
        "where": "a US state plane CRS where the foot definition matters",
    },
}

def identify_ratio(observed, expected, tolerance=0.01):
    """Given a measured and an expected value, name the unit error."""
    if expected == 0:
        return {"identified": False, "reason": "expected value is zero"}
    r = observed / expected
    candidates = []
    for name, spec in RATIOS.items():
        for candidate in (spec["value"], 1.0 / spec["value"]):
            if abs(r - candidate) / candidate <= tolerance:
                candidates.append({
                    "error": name,
                    "ratio_observed": round(r, 6),
                    "ratio_expected": round(candidate, 6),
                    "inverted": candidate != spec["value"],
                    "symptom": spec["symptom"],
                    "where": spec["where"],
                })
    return {
        "observed": observed, "expected": expected,
        "ratio": round(r, 6),
        "identified": bool(candidates),
        "candidates": candidates,
        "note": ("no known unit ratio matches; the error is not a unit error"
                 if not candidates else None),
    }

for name, spec in RATIOS.items():
    print(f"{spec['value']:>10.4f}  {name}")
```

Recognising the ratio is the whole first step and it is faster than reading any code. A factor of 3.28 is feet against metres; 10.76 is square feet against square metres; 35.31 is cubic feet against cubic metres; 1000 is millimetres. Computing `observed / expected` and matching it against that table identifies the error in seconds.

The **squared and cubed** ratios matter because areas and volumes are where unit errors do the most damage and are hardest to spot. A footprint area that is 10.76× out looks like a data-entry error rather than a unit error until the ratio is recognised, and a stockpile volume 35.3× out has already been invoiced.

The US survey foot against the international foot is a 2 ppm difference and is included because it is not negligible where it applies: a state plane easting of 600,000 ft differs by 1.2 m between the two definitions, which exceeds most survey tolerances. It was officially deprecated at the end of 2022 and remains in a great deal of existing data.

<figure class="diagram">
<svg viewBox="4 6 732 254" role="img" aria-labelledby="units-ratios-t units-ratios-d" xmlns="http://www.w3.org/2000/svg">
  <title id="units-ratios-t">The ratios that identify a unit error</title>
  <desc id="units-ratios-d">A table of six signature ratios with what each one means. A ratio of 3.28 is feet treated as metres, affecting lengths and coordinates. 0.305 is the inverse. 10.76 is square feet treated as square metres, affecting areas. 35.31 is cubic feet as cubic metres, affecting volumes. 1000 is millimetres as metres, typical of IFC and CAD. 1.000002 is the US survey foot against the international foot, worth 1.2 metres over a 600 kilometre easting.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="254" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="122" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="140" y="20" width="286" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="426" y="20" width="296" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="122" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="140" y="54" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="426" y="54" width="296" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="122" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="140" y="86" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="426" y="86" width="296" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="118" width="122" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="140" y="118" width="286" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="426" y="118" width="296" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="150" width="122" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="140" y="150" width="286" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="426" y="150" width="296" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="182" width="122" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="140" y="182" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="426" y="182" width="296" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="214" width="122" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="140" y="214" width="286" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="426" y="214" width="296" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="79" y="41">ratio</text><text x="283" y="41">what it is</text>
    <text x="574" y="41">what it affects</text>
    <text x="79" y="75">3.2808</text><text x="283" y="75">feet treated as metres</text>
    <text x="574" y="75">lengths, coordinates, heights</text>
    <text x="79" y="107">0.3048</text><text x="283" y="107">metres treated as feet</text>
    <text x="574" y="107">the same, inverted</text>
    <text x="79" y="139">10.7639</text><text x="283" y="139">square feet as square metres</text>
    <text x="574" y="139">footprint and roof areas</text>
    <text x="79" y="171">35.3147</text><text x="283" y="171">cubic feet as cubic metres</text>
    <text x="574" y="171">earthworks and stockpile volumes</text>
    <text x="79" y="203">1000</text><text x="283" y="203">millimetres as metres</text>
    <text x="574" y="203">IFC and CAD imports</text>
    <text x="79" y="235">1.000002</text><text x="283" y="235">US survey vs international foot</text>
    <text x="574" y="235">1.2 m over a 600 km easting</text>
  </g>
</svg>
<figcaption>Six ratios cover almost every unit error; computing observed over expected and matching the table is faster than reading the code.</figcaption>
</figure>

### 2. Read the unit declaration where the format has one

```python
def ifc_units(ifc_path):
    """IFC declares its units; the file is authoritative and often ignored."""
    import ifcopenshell
    import ifcopenshell.util.unit as unit_util

    model = ifcopenshell.open(str(ifc_path))
    assignments = model.by_type("IfcUnitAssignment")
    declared = []
    for assignment in assignments:
        for u in assignment.Units or []:
            if u.is_a("IfcSIUnit"):
                declared.append({
                    "kind": u.UnitType,
                    "type": "SI",
                    "name": u.Name,
                    "prefix": u.Prefix,
                })
            elif u.is_a("IfcConversionBasedUnit"):
                factor = u.ConversionFactor
                declared.append({
                    "kind": u.UnitType,
                    "type": "conversion",
                    "name": u.Name,
                    "factor_to_si": float(factor.ValueComponent.wrappedValue)
                    if factor else None,
                })
    scale = unit_util.calculate_unit_scale(model)
    return {
        "file": Path(ifc_path).name,
        "declared_units": declared,
        "length_scale_to_metres": round(float(scale), 12),
        "is_metres": abs(scale - 1.0) < 1e-9,
        "is_millimetres": abs(scale - 0.001) < 1e-12,
        "is_feet": abs(scale - FOOT_INTERNATIONAL) < 1e-6,
        "advice": ("multiply every coordinate by length_scale_to_metres; never "
                   "assume millimetres because most files are"),
    }

def citygml_units(gml_path):
    """CityGML inherits units from its CRS; there is no separate unit element."""
    import re
    from pyproj import CRS

    text = Path(gml_path).read_text(errors="replace")[:200_000]
    srs = re.search(r'srsName="([^"]+)"', text)
    if not srs:
        return {"declared": False,
                "advice": "no srsName found; the unit is unknown and must be "
                          "supplied out of band"}
    name = srs.group(1)
    try:
        crs = CRS.from_user_input(name.split("::")[-1] if "::" in name else name)
    except Exception as exc:
        return {"declared": True, "srsName": name, "parsed": False,
                "error": repr(exc)[:120]}
    axis = crs.axis_info[0] if crs.axis_info else None
    return {
        "declared": True,
        "srsName": name,
        "epsg": crs.to_epsg(),
        "crs_name": crs.name,
        "unit": axis.unit_name if axis else None,
        "unit_conversion_factor": axis.unit_conversion_factor if axis else None,
        "is_metre": bool(axis and axis.unit_name in ("metre", "meter")),
        "advice": ("CityGML has no unit element — the CRS decides, so a file in a "
                   "foot-based state plane CRS has foot coordinates"),
    }

def gltf_units(glb_path):
    """glTF is defined to be in metres. There is no unit field, and that is the trap."""
    import struct
    data = Path(glb_path).read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + json_len].decode("utf-8"))
    extras = doc.get("asset", {}).get("extras", {})
    return {
        "file": Path(glb_path).name,
        "generator": doc.get("asset", {}).get("generator"),
        "declared_unit": "metres by specification",
        "extras_unit_hint": extras.get("unit") or extras.get("units"),
        "node_scales": [n.get("scale") for n in doc.get("nodes", [])
                        if n.get("scale")][:4],
        "advice": ("glTF has no unit field: the specification says metres. A node "
                   "scale of 0.3048 or 0.001 is a converter compensating for a "
                   "non-metric source, and it should have been baked in"),
    }
```

IFC declares its units and the declaration is authoritative, which makes it the easiest case to get right and a common one to get wrong. `calculate_unit_scale` returns the factor to metres, and multiplying coordinates by it is the whole conversion — but most IFC files are in millimetres, so code that assumes millimetres works until a file in metres or feet arrives.

CityGML has **no** unit element: the units come from the CRS named in `srsName`. A CityGML file in a US state plane CRS defined in feet contains foot coordinates, and nothing in the file says so more directly than the EPSG code — which is why the CRS check in [how to choose CRS for urban digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) also serves as a unit check.

glTF is defined to be in metres and has no unit field, which is the trap in the other direction: a converter handed a millimetre model either bakes the scale into the vertices or writes a node scale of 0.001. A node scale of 0.3048 or 0.001 in tile content is a strong signal that a unit conversion was deferred rather than applied.

### 3. Check dimensions against something known

```python
KNOWN_DIMENSIONS = {
    "door_height_m": (1.9, 2.4),
    "storey_height_m": (2.2, 6.0),
    "residential_building_height_m": (2.5, 40.0),
    "parcel_frontage_m": (4.0, 200.0),
    "road_lane_width_m": (2.5, 4.2),
    "kerb_height_m": (0.08, 0.25),
    "city_extent_km": (2.0, 60.0),
}

def plausibility_report(measurements, known=KNOWN_DIMENSIONS):
    """measurements: {'storey_height_m': 7.87, ...}"""
    rows = []
    for name, value in measurements.items():
        bounds = known.get(name)
        if bounds is None:
            rows.append({"measurement": name, "value": value,
                         "status": "no reference range"})
            continue
        lo, hi = bounds
        if lo <= value <= hi:
            rows.append({"measurement": name, "value": value,
                         "range": bounds, "status": "plausible"})
            continue
        midpoint = (lo + hi) / 2.0
        diagnosis = identify_ratio(value, midpoint, tolerance=0.15)
        rows.append({
            "measurement": name, "value": value, "range": bounds,
            "status": "IMPLAUSIBLE",
            "ratio_to_midpoint": round(value / midpoint, 4),
            "likely_error": (diagnosis["candidates"][0]["error"]
                             if diagnosis["candidates"] else "not a known unit ratio"),
        })
    bad = [r for r in rows if r["status"] == "IMPLAUSIBLE"]
    ratios = [r["ratio_to_midpoint"] for r in bad if "ratio_to_midpoint" in r]
    consistent = (len(ratios) > 1
                  and max(ratios) / max(min(ratios), 1e-9) < 1.3)
    return {
        "rows": rows,
        "implausible": len(bad),
        "ratios": ratios,
        "one_consistent_ratio": consistent,
        "verdict": (f"every implausible measurement is out by about "
                    f"{np.median(ratios):.2f}× — a single unit error upstream"
                    if consistent else
                    "measurements are out by different factors — not one unit error"
                    if bad else "all measurements plausible"),
    }

def measure_from_mesh(mesh_path):
    import trimesh
    mesh = trimesh.load(mesh_path, process=False, force="mesh")
    extents = mesh.extents
    return {
        "residential_building_height_m": round(float(extents[2]), 3),
        "parcel_frontage_m": round(float(max(extents[0], extents[1])), 3),
        "_bbox_m": [round(float(v), 3) for v in extents],
        "_volume_m3": round(float(mesh.volume), 3) if mesh.is_watertight else None,
        "_area_m2": round(float(mesh.area), 3),
    }
```

Checking against known dimensions is what turns "something is wrong" into a ratio. A storey height of 7.87 m is implausible, and 7.87 divided by a 2.4 m expectation is 3.28 — which names the error without looking at any code.

The `one_consistent_ratio` test is the useful refinement. If every implausible measurement is out by the same factor, there is a single unit error upstream; if the height is out by 3.28 and the footprint by 10.76, there are two — and the second is the *square* of the first, which means an area was computed after the length error rather than being separately wrong.

Storey height is the best single check for building models because its plausible range is narrow and universal. Building height varies enormously; a storey does not.

### 4. Probe every pipeline handoff

```python
def stage_measurement(path, label, kind="mesh"):
    if kind == "mesh":
        m = measure_from_mesh(path)
    elif kind == "ifc":
        u = ifc_units(path)
        m = {"_length_scale": u["length_scale_to_metres"],
             "_declared": u["declared_units"][:2]}
    elif kind == "gml":
        u = citygml_units(path)
        m = {"_srs": u.get("srsName"), "_unit": u.get("unit"),
             "_factor": u.get("unit_conversion_factor")}
    elif kind == "glb":
        u = gltf_units(path)
        m = {"_generator": u["generator"], "_node_scales": u["node_scales"],
             "_hint": u["extras_unit_hint"]}
    else:
        m = {}
    return {"stage": label, "path": str(path), "kind": kind, **m}

def bisect_units(stage_specs, reference_measurement, reference_value,
                 tolerance=0.02):
    """stage_specs: [(label, path, kind), ...] in pipeline order."""
    probes = []
    for label, path, kind in stage_specs:
        probe = stage_measurement(path, label, kind)
        measured = probe.get(reference_measurement)
        if measured is not None:
            ratio = measured / max(reference_value, 1e-12)
            probe["ratio_to_reference"] = round(ratio, 6)
            probe["correct"] = abs(ratio - 1.0) <= tolerance
            if not probe["correct"]:
                diag = identify_ratio(measured, reference_value)
                probe["likely_error"] = (diag["candidates"][0]["error"]
                                         if diag["candidates"] else "unknown ratio")
        probes.append(probe)

    measured_probes = [p for p in probes if "correct" in p]
    first_bad = next((i for i, p in enumerate(measured_probes)
                      if not p["correct"]), None)
    if first_bad is None:
        return {"probes": probes, "culprit": None,
                "verdict": "every measurable stage is correct; the error is in a "
                           "stage this reference cannot measure"}
    culprit = measured_probes[first_bad]
    previous = measured_probes[first_bad - 1] if first_bad > 0 else None
    return {
        "probes": probes,
        "culprit_stage": culprit["stage"],
        "ratio": culprit["ratio_to_reference"],
        "likely_error": culprit.get("likely_error"),
        "last_correct_stage": previous["stage"] if previous else None,
        "verdict": (f"'{culprit['stage']}' introduced a factor of "
                    f"{culprit['ratio_to_reference']} "
                    f"({culprit.get('likely_error')})"),
    }
```

Bisecting on a **single known dimension** is the method, and the dimension has to be something measurable at every stage. Building height works for a mesh pipeline; a parcel frontage works for a vector one; a tile's bounding-volume extent works once the data is a tileset.

Taking the first failing stage is the same discipline as in [diagnosing inverted normals across pipeline stages](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-inverted-normals-across-pipeline-stages/): every stage after the culprit inherits the error and is not at fault.

The "no measurable stage failed" outcome is worth handling explicitly, because a unit error can hide in a stage whose output the chosen reference cannot measure — an attribute-only transformation, for instance, where a declared area was converted and the geometry was not.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="units-declare-t units-declare-d" xmlns="http://www.w3.org/2000/svg">
  <title id="units-declare-t">Where each format declares its units</title>
  <desc id="units-declare-d">A table of four formats and how each one declares length units. IFC has an explicit unit assignment element and a calculable scale factor, so the file is authoritative. CityGML has no unit element at all and inherits units from the coordinate reference system named in srsName. LAS declares units in its coordinate system record, which is frequently absent. glTF is defined by specification to be in metres and has no unit field, so a node scale of 0.001 means a converter deferred the conversion.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="118" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="20" width="266" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="402" y="20" width="320" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="118" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="136" y="54" width="266" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="402" y="54" width="320" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="100" width="118" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="136" y="100" width="266" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="402" y="100" width="320" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="146" width="118" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="136" y="146" width="266" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="402" y="146" width="320" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="192" width="118" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="136" y="192" width="266" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="402" y="192" width="320" height="46" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="77" y="41">format</text><text x="269" y="41">how units are declared</text>
    <text x="562" y="41">what to do</text>
    <text x="77" y="82">IFC</text>
    <text x="269" y="72">IfcUnitAssignment, with a</text>
    <text x="269" y="90">calculable scale to metres</text>
    <text x="562" y="72">read the scale and apply it once;</text>
    <text x="562" y="90">create_shape already applies it</text>
    <text x="77" y="128">CityGML</text>
    <text x="269" y="118">no unit element — inherited</text>
    <text x="269" y="136">from the srsName CRS</text>
    <text x="562" y="118">resolve the EPSG code and read</text>
    <text x="562" y="136">its axis unit</text>
    <text x="77" y="174">LAS / LAZ</text>
    <text x="269" y="164">coordinate system record,</text>
    <text x="269" y="182">frequently absent</text>
    <text x="562" y="164">check the header; if absent, the</text>
    <text x="562" y="182">unit must come out of band</text>
    <text x="77" y="220">glTF</text>
    <text x="269" y="210">none — metres by</text>
    <text x="269" y="228">specification</text>
    <text x="562" y="210">a node scale of 0.001 or 0.3048</text>
    <text x="562" y="228">means the conversion was deferred</text>
  </g>
</svg>
<figcaption>Only IFC states its units directly; CityGML inherits them from the CRS and glTF simply assumes metres, which is where a deferred conversion hides.</figcaption>
</figure>

### 5. Watch for the error that only affects one field

```python
def cross_field_unit_check(records, geometry_area_key="computed_area_m2",
                           declared_area_key="footprint_area_m2",
                           height_key="measured_height_m",
                           storeys_key="storeys_above_ground"):
    """A unit error often lands on one attribute and not the geometry."""
    rows = []
    for r in records:
        computed = r.get(geometry_area_key)
        declared = r.get(declared_area_key)
        height = r.get(height_key)
        storeys = r.get(storeys_key)

        entry = {"id": r.get("register_id", "?")}
        if computed and declared:
            entry["area_ratio"] = round(declared / max(computed, 1e-9), 4)
        if height and storeys:
            entry["per_storey_m"] = round(height / max(storeys, 1e-9), 3)
        rows.append(entry)

    area_ratios = [r["area_ratio"] for r in rows if "area_ratio" in r]
    per_storey = [r["per_storey_m"] for r in rows if "per_storey_m" in r]

    findings = []
    if area_ratios:
        median = float(np.median(area_ratios))
        diag = identify_ratio(median, 1.0, tolerance=0.03)
        if abs(median - 1.0) > 0.03:
            findings.append({
                "field": declared_area_key,
                "median_ratio": round(median, 4),
                "likely_error": (diag["candidates"][0]["error"]
                                 if diag["candidates"] else "unknown"),
                "note": "the declared area disagrees with the geometry, so only the "
                        "attribute was converted",
            })
    if per_storey:
        median = float(np.median(per_storey))
        if not 2.2 <= median <= 6.0:
            diag = identify_ratio(median, 3.0, tolerance=0.2)
            findings.append({
                "field": height_key,
                "median_per_storey_m": round(median, 3),
                "likely_error": (diag["candidates"][0]["error"]
                                 if diag["candidates"] else "unknown"),
                "note": "height and storey count disagree, so the height alone was "
                        "converted or not converted",
            })
    return {
        "records": len(rows),
        "median_area_ratio": round(float(np.median(area_ratios)), 4)
        if area_ratios else None,
        "median_per_storey_m": round(float(np.median(per_storey)), 3)
        if per_storey else None,
        "findings": findings,
        "clean": not findings,
    }
```

A unit error that lands on **one field** is the hardest kind to find and the most common in attribute pipelines. A converter that multiplies the geometry by 0.3048 and leaves the declared area alone produces a table where every building's area is 10.76× its footprint — and no single-column check notices, because both values are individually plausible.

The area ratio and the per-storey height are the two cross-field tests that catch this, and they are the same ones the schema in [validating attribute tables with Pandera](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-attribute-tables-with-pandera/) enforces. Here they are used diagnostically: the *value* of the ratio names the error rather than merely flagging it.

Taking the median across many records rather than testing each one is what distinguishes a systematic unit error from scattered data-entry mistakes. A median ratio of 10.76 across 400,000 buildings is a conversion; a handful of outliers at 10.76 is coincidence.

### 6. Fix at the boundary and assert the unit

```python
def convert_to_metres(values, from_unit, us_survey_foot=False):
    factors = {
        "m": 1.0, "metre": 1.0, "meter": 1.0,
        "mm": 0.001, "millimetre": 0.001,
        "cm": 0.01, "centimetre": 0.01,
        "km": 1000.0,
        "ft": FOOT_US_SURVEY if us_survey_foot else FOOT_INTERNATIONAL,
        "foot": FOOT_US_SURVEY if us_survey_foot else FOOT_INTERNATIONAL,
        "in": 0.0254, "inch": 0.0254,
        "yd": 0.9144, "yard": 0.9144,
    }
    key = from_unit.strip().lower()
    if key not in factors:
        raise ValueError(f"unknown unit {from_unit!r}; declare it explicitly")
    return np.asarray(values, dtype=np.float64) * factors[key], {
        "from_unit": key,
        "factor": factors[key],
        "us_survey_foot": us_survey_foot and key in ("ft", "foot"),
    }

class Metres:
    """A boundary type: once inside the pipeline, everything is metres."""
    __slots__ = ("values", "provenance")

    def __init__(self, values, provenance):
        self.values = np.asarray(values, dtype=np.float64)
        self.provenance = provenance

    @classmethod
    def from_unit(cls, values, unit, us_survey_foot=False):
        converted, prov = convert_to_metres(values, unit,
                                            us_survey_foot=us_survey_foot)
        return cls(converted, prov)

    def assert_plausible(self, expected_range, label="length"):
        lo, hi = expected_range
        span = float(np.ptp(self.values)) if self.values.size > 1 else \
            float(self.values.max())
        if not lo <= span <= hi:
            diag = identify_ratio(span, (lo + hi) / 2.0)
            raise AssertionError(
                f"{label} span {span:.3f} m is outside {expected_range}; "
                f"likely {diag['candidates'][0]['error'] if diag['candidates'] else 'not a unit error'}"
                f" (converted from {self.provenance['from_unit']})")
        return {"label": label, "span_m": round(span, 3),
                "range": expected_range, "ok": True,
                "provenance": self.provenance}

def ingest_ifc(ifc_path, expected_height_range=(2.5, 400.0)):
    """Convert once, at the boundary, and assert before anything else runs."""
    import ifcopenshell
    import ifcopenshell.util.unit as unit_util
    import numpy as np

    model = ifcopenshell.open(str(ifc_path))
    scale = float(unit_util.calculate_unit_scale(model))
    if not 0.0001 <= scale <= 1000.0:
        raise ValueError(f"implausible unit scale {scale} in {ifc_path}")

    # Collect a height from the model's own extent for the assertion.
    import ifcopenshell.geom
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    zs = []
    for product in model.by_type("IfcBuildingElement")[:200]:
        if not product.Representation:
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
        except Exception:
            continue
        verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
        if verts.size:
            zs.extend(verts[:, 2].tolist())
    if not zs:
        raise ValueError("no geometry read; cannot assert the unit")

    heights = Metres.from_unit(np.asarray(zs), "m")   # geometry is already scaled
    heights.values *= 1.0                              # explicit: no double scaling
    check = heights.assert_plausible(expected_height_range, label="building height")
    return {"ifc": Path(ifc_path).name, "declared_scale_to_metres": scale,
            "assertion": check,
            "note": "ifcopenshell's create_shape already applies the unit scale; "
                    "multiplying again is the commonest double-conversion bug"}
```

Converting **once, at the boundary**, and carrying a type that says "these are metres" is the structural fix. The alternative — converting where it is convenient — produces the double-conversion bug, where two stages each apply a 0.3048 factor and the result is out by 0.0929.

`ifcopenshell.geom.create_shape` already applies the file's unit scale, which is the specific double-conversion trap in IFC work: code that reads the scale, calls `create_shape`, and then multiplies by the scale again produces a model 1,000× too small from a millimetre file.

Asserting plausibility at the boundary is what makes the error loud. A pipeline that raises `building height span 39.37 m is outside (2.5, 400.0); likely inches_read_as_metres` at ingest costs nothing and prevents the whole class of downstream confusion.

<figure class="diagram">
<svg viewBox="2 52 714 206" role="img" aria-labelledby="units-bisect-t units-bisect-d" xmlns="http://www.w3.org/2000/svg">
  <title id="units-bisect-t">Bisecting on one known dimension</title>
  <desc id="units-bisect-d">Six pipeline stages measured against a known 14.2 metre building height. The IFC source declares millimetres and measures correctly at 14.2 after scaling. The geometry extraction and the simplification both measure 14.2. The coordinate conversion measures 46.59, a factor of 3.28, which is feet treated as metres. The glTF export and the tiling stage inherit 46.59. The first failing stage is the culprit and the ratio names the error.</desc>
  <rect class="svg-bg" x="2" y="52" width="714" height="206" fill="#ffffff"/>
  <defs>
    <marker id="units-bisect-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.6">
    <rect x="16" y="66" width="104" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="130" y="66" width="104" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="244" y="66" width="104" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="358" y="66" width="116" height="56" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2.6"/>
    <rect x="484" y="66" width="104" height="56" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="598" y="66" width="104" height="56" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.6" fill="none" marker-end="url(#units-bisect-arrow)">
    <path d="M120 94 H128"/><path d="M234 94 H242"/><path d="M348 94 H356"/>
    <path d="M474 94 H482"/><path d="M588 94 H596"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="68" y="86">IFC source</text><text x="68" y="104">14.20 m ✓</text>
    <text x="182" y="86">extract</text><text x="182" y="104">14.20 m ✓</text>
    <text x="296" y="86">simplify</text><text x="296" y="104">14.20 m ✓</text>
    <text x="416" y="80">CRS convert</text><text x="416" y="98">46.59 m ✗</text>
    <text x="416" y="114">×3.28</text>
    <text x="536" y="86">glTF export</text><text x="536" y="104">46.59 m ✗</text>
    <text x="650" y="86">tile</text><text x="650" y="104">46.59 m ✗</text>
  </g>
  <path d="M416 128 V152" stroke="#b0413e" stroke-width="2" fill="none"/>
  <text x="416" y="170" fill="#b0413e" font-size="12.5" text-anchor="middle">culprit: a foot-based state plane CRS treated as metric</text>
  <text x="370" y="196" fill="#1f2937" font-size="12.5" text-anchor="middle">the ratio 3.2808 names the error before any code is read</text>
  <text x="370" y="220" fill="#5b6471" font-size="12" text-anchor="middle">the two stages after it inherit the factor and are not at fault</text>
  <text x="370" y="240" fill="#5b6471" font-size="12" text-anchor="middle">one known dimension measured at every handoff is the whole method</text>
</svg>
<figcaption>One known dimension, six measurements, and the ratio at the first failure names the error.</figcaption>
</figure>

## Expected Output & Verification

```text
    3.2808  feet_read_as_metres
    0.3048  metres_read_as_feet
 1000.0000  millimetres_read_as_metres
  100.0000  centimetres_read_as_metres
   39.3701  inches_read_as_metres
   10.7639  square_feet_read_as_square_metres
   35.3147  cubic_feet_read_as_cubic_metres
    1.0000  us_survey_vs_international_foot
{
  "file": "building_a.ifc",
  "declared_units": [{"kind": "LENGTHUNIT", "type": "SI", "name": "METRE",
                      "prefix": "MILLI"}],
  "length_scale_to_metres": 0.001,
  "is_metres": false, "is_millimetres": true, "is_feet": false
}
{
  "rows": [
    {"measurement": "residential_building_height_m", "value": 46.59,
     "range": [2.5, 40.0], "status": "IMPLAUSIBLE",
     "ratio_to_midpoint": 2.1925, "likely_error": "not a known unit ratio"},
    {"measurement": "parcel_frontage_m", "value": 118.4,
     "range": [4.0, 200.0], "status": "plausible"}
  ],
  "implausible": 1,
  "verdict": "measurements are out by different factors — not one unit error"
}
{
  "observed": 46.59, "expected": 14.2, "ratio": 3.280282,
  "identified": true,
  "candidates": [
    {"error": "feet_read_as_metres", "ratio_observed": 3.280282,
     "ratio_expected": 3.2808, "inverted": false,
     "symptom": "the model is 3.28× too large, or a metric model is 3.28× too small",
     "where": "a length in feet passed to code expecting metres"}
  ]
}
{
  "culprit_stage": "crs_convert",
  "ratio": 3.280282,
  "likely_error": "feet_read_as_metres",
  "last_correct_stage": "simplify",
  "verdict": "'crs_convert' introduced a factor of 3.280282 (feet_read_as_metres)"
}
```

The plausibility report against a *range* was inconclusive — 46.59 m is a legal building height, so the range test only flags it against a residential expectation. Against the **known** 14.2 m height the ratio is 3.2803 and the error is named immediately, which is why a known dimension beats a plausible range.

The bisect places the error at `crs_convert` with `simplify` still correct, and the cause is the one the ratio implies: a foot-based state plane CRS whose coordinates were passed through as if they were metres.

Verify the fix does not double-convert, which is the failure a fix most often introduces:

```python
def double_conversion_check(stage_specs, reference_measurement, reference_value,
                            tolerance=0.02):
    """After fixing, no stage should apply the factor a second time."""
    probes = []
    for label, path, kind in stage_specs:
        probe = stage_measurement(path, label, kind)
        measured = probe.get(reference_measurement)
        if measured is None:
            probes.append({**probe, "measurable": False})
            continue
        ratio = measured / max(reference_value, 1e-12)
        probes.append({**probe, "measurable": True,
                       "ratio": round(ratio, 6),
                       "correct": abs(ratio - 1.0) <= tolerance})

    measurable = [p for p in probes if p.get("measurable")]
    ratios = [p["ratio"] for p in measurable]
    changes = []
    for a, b in zip(measurable, measurable[1:]):
        step = b["ratio"] / max(a["ratio"], 1e-12)
        if abs(step - 1.0) > tolerance:
            diag = identify_ratio(step, 1.0, tolerance=0.05)
            changes.append({
                "from": a["stage"], "to": b["stage"],
                "step_ratio": round(step, 6),
                "likely": (diag["candidates"][0]["error"]
                           if diag["candidates"] else "unknown"),
            })
    return {
        "stages_measured": len(measurable),
        "ratios": [round(r, 4) for r in ratios],
        "all_correct": all(p["correct"] for p in measurable),
        "unit_changes_between_stages": changes,
        "double_conversion": len(changes) > 1,
        "verdict": ("one conversion at one boundary — correct"
                    if len(changes) <= 1 and all(p["correct"] for p in measurable)
                    else f"{len(changes)} unit changes detected; a conversion is "
                         f"being applied more than once"),
    }
```

Counting the stage-to-stage **steps** rather than the absolute ratios is what catches a double conversion. A pipeline where the ratio goes 1.0, 3.28, 1.0 has two conversions that cancel and is correct by accident; one where it goes 1.0, 0.3048, 0.0929 has applied the same factor twice.

Then verify the survey-foot distinction where it applies, because the 2 ppm difference is easy to dismiss and occasionally matters:

```python
def survey_foot_check(easting_ft, northing_ft, epsg_code, tolerance_m=0.05):
    """For a US state plane CRS in feet, which foot definition was intended?"""
    from pyproj import CRS

    crs = CRS.from_epsg(epsg_code)
    axis = crs.axis_info[0] if crs.axis_info else None
    declared = axis.unit_name if axis else "unknown"
    factor = axis.unit_conversion_factor if axis else None

    as_international = np.array([easting_ft, northing_ft]) * FOOT_INTERNATIONAL
    as_survey = np.array([easting_ft, northing_ft]) * FOOT_US_SURVEY
    difference_m = float(np.linalg.norm(as_survey - as_international))

    return {
        "epsg": epsg_code,
        "crs_name": crs.name,
        "declared_unit": declared,
        "declared_factor": factor,
        "matches_international": factor is not None
        and abs(factor - FOOT_INTERNATIONAL) < 1e-9,
        "matches_us_survey": factor is not None
        and abs(factor - FOOT_US_SURVEY) < 1e-12,
        "position_difference_m": round(difference_m, 4),
        "matters": difference_m > tolerance_m,
        "advice": ("use the factor the CRS declares; the US survey foot was "
                   "deprecated at the end of 2022 but remains in existing data, "
                   "and mixing the two is a 2 ppm error"
                   if difference_m > tolerance_m
                   else "the difference is below tolerance at this coordinate "
                        "magnitude"),
    }

print(json.dumps(survey_foot_check(2_184_120.4, 618_402.8, 2229), indent=2))
```

At an easting of 2.18 million feet the two foot definitions differ by 1.3 m, which is well beyond any survey tolerance — so the check reports `matters: true` and the CRS's own declared factor is the one to use. At a local coordinate of a few thousand feet the difference is millimetres and the check says so, which stops the distinction from becoming a distraction where it is irrelevant.

## Performance Notes

- **Every check on this page is arithmetic** and costs nothing; the expense is reading the intermediates.
- **`ifcopenshell.geom.create_shape` is the slow operation** at roughly 20–80 ms per element. Sample 200 elements for a unit assertion rather than processing the model.
- **Measure the bounding box, not the geometry.** A unit error affects every coordinate uniformly, so the extent is a sufficient probe and is free.
- **Assert at the boundary, not throughout.** One conversion and one assertion per ingest is cheaper and safer than defensive conversions at every call.
- **Keep the known dimension in the repository** alongside the pipeline, as a fixture: a surveyed building height with its source is worth more than any amount of range checking.
- **Store units in the data where the format allows it.** A `unit` field in the metadata schema costs nothing and turns a future diagnosis into a lookup.

## Common Errors

**A model 1,000× too small after "fixing" the units.** Double conversion — `create_shape` already applied the scale.

**The ratio is 0.0929.** That is 0.3048 squared: the foot factor applied twice.

**Everything is correct except the declared areas.** Only the attribute was converted, not the geometry, or vice versa. The cross-field check finds this.

**A US state plane model is out by about a metre.** The survey-foot versus international-foot distinction at a large easting.

**CityGML coordinates are in feet and nothing says so.** CityGML has no unit element; read the CRS.

**A glTF node has `scale: [0.001, 0.001, 0.001]`.** A converter deferred the unit conversion instead of baking it in; consumers that ignore node scales will be 1,000× out.

**The ratio matches no known unit.** It is probably not a unit error — check for a projection scale factor or an erroneous geometric transform.

## Frequently Asked Questions

### How do I stop this happening again?

Convert once at the ingest boundary, carry a type that names the unit, and assert a known dimension immediately. The assertion is one line and it converts a silent factor-of-3.28 into a failed ingest.

### Is the US survey foot still relevant?

Its use was officially discontinued at the end of 2022, and it remains in a very large body of existing data and in many state plane CRS definitions. Always use the factor the CRS declares rather than assuming either definition.

### What about the scale factor in a projected CRS?

A projection's scale factor — about 0.9996 for a UTM central meridian — is a real geometric effect, not a unit error, and a ratio near 0.9996 or 1.0004 points there rather than at units. It matters for distance measurement and not for placement.

## Related Guides

- [Diagnosing Inverted Normals Across Pipeline Stages](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-inverted-normals-across-pipeline-stages/) — the same bisect method for a different defect
- [Validating Attribute Tables with Pandera](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-attribute-tables-with-pandera/) — the cross-field checks that catch an attribute-only conversion
- [Reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/) — where an IFC model's scale and placement are declared

Back to [Cross-Section Failure Modes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).
