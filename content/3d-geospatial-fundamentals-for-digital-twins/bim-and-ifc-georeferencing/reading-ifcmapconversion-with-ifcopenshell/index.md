# Reading IfcMapConversion with IfcOpenShell

This page extracts the georeferencing of an IFC4 or IFC4X3 building model with IfcOpenShell — the `IfcMapConversion` parameters, the `IfcProjectedCRS` it points to, the project length unit and the scaled IFC4X3 variant — into a single normalised record that a pipeline can validate and apply.

## Why you hit this

Every tiling or twin-ingestion job that accepts BIM needs to know where the building is, and the answer is spread over at least three entities with optional attributes, schema-dependent names and a unit system that is not the map's. Code that reads `model.by_type("IfcMapConversion")[0].Eastings` works on the first sample file and fails on the second, because the second has two representation contexts, or a `None` scale, or a CRS name written as `"ETRS89 / UTM zone 32N"` rather than an EPSG code. The theory of what each parameter means is in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/); this page is the defensive reader.

## Prerequisites

- `ifcopenshell>=0.8.0`, `pyproj>=3.6`, Python 3.10+.
- An IFC4, IFC4X1 or IFC4X3 file. IFC2X3 files have no `IfcMapConversion` entity at all — see [georeferencing IFC2x3 models without IfcMapConversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/georeferencing-ifc2x3-models-without-map-conversion/).
- Knowledge of the CRS the project was delivered in, as an EPSG code, so the reader's output can be checked against it — for example EPSG:25832 for ETRS89 / UTM 32N or EPSG:2263 for New York State Plane Long Island in US feet.

## Step-by-Step

### 1. Find the model context the conversion belongs to

A model can carry several `IfcGeometricRepresentationContext` entities — a 3D model context, a 2D plan context, sub-contexts for body and axis. The map conversion hangs off one of them through the inverse attribute `HasCoordinateOperation`.

```python
import ifcopenshell

model = ifcopenshell.open("clinic_block_c.ifc")
assert model.schema.startswith("IFC4"), f"{model.schema}: no IfcMapConversion in this schema"

contexts = [
    c for c in model.by_type("IfcGeometricRepresentationContext")
    if not c.is_a("IfcGeometricRepresentationSubContext")
]
for c in contexts:
    ops = c.HasCoordinateOperation or ()
    print(c.id(), c.ContextType, c.CoordinateSpaceDimension, [o.is_a() for o in ops])
```

Iterating contexts rather than calling `by_type("IfcMapConversion")` directly is what makes the reader correct for files with a second, unrelated conversion — the pattern some authoring tools use when a plan context is georeferenced separately from the model context. Prefer the context whose `ContextType` is `"Model"` and whose dimension is 3.

### 2. Read the conversion into a normalised record

```python
import math
from dataclasses import dataclass

@dataclass(frozen=True)
class MapConversion:
    crs_name: str
    vertical_datum: str | None
    eastings: float
    northings: float
    height: float
    rotation_rad: float
    scale_xy: float
    scale_z: float

def read_map_conversion(model):
    ctx = next(c for c in contexts if c.ContextType == "Model" and c.CoordinateSpaceDimension == 3)
    op = next((o for o in (ctx.HasCoordinateOperation or ()) if o.is_a("IfcMapConversion")), None)
    if op is None:
        return None
    crs = op.TargetCRS
    abscissa = op.XAxisAbscissa if op.XAxisAbscissa is not None else 1.0
    ordinate = op.XAxisOrdinate if op.XAxisOrdinate is not None else 0.0
    if op.is_a("IfcMapConversionScaled"):                 # IFC4X3 only
        base = op.Scale if op.Scale is not None else 1.0
        sx, sy, sz = op.FactorX, op.FactorY, op.FactorZ
        assert abs(sx - sy) < 1e-9, "anisotropic horizontal scale is not a conformal map"
        scale_xy, scale_z = base * sx, base * sz
    else:
        scale_xy = scale_z = op.Scale if op.Scale is not None else 1.0
    return MapConversion(
        crs_name=crs.Name,
        vertical_datum=getattr(crs, "VerticalDatum", None),
        eastings=float(op.Eastings),
        northings=float(op.Northings),
        height=float(op.OrthogonalHeight),
        rotation_rad=math.atan2(ordinate, abscissa),
        scale_xy=scale_xy,
        scale_z=scale_z,
    )

mc = read_map_conversion(model)
print(mc)
```

Two defaults matter here. `XAxisAbscissa` and `XAxisOrdinate` are optional, and their absence means no rotation, so they default to `(1, 0)` — not `(0, 0)`, which would make `atan2` return zero by accident and hide a genuinely malformed file behind a plausible value. `Scale` is optional and defaults to 1.0 per the schema, which the reader records honestly; deciding whether 1.0 is *right* is the validation step's job, not the reader's.

<figure class="diagram">
<svg viewBox="6 16 754 248" role="img" aria-labelledby="rmc-ent-t rmc-ent-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rmc-ent-t">The entities a reader has to walk</title>
  <desc id="rmc-ent-d">The IfcProject owns representation contexts. The three-dimensional model context has an inverse HasCoordinateOperation link to IfcMapConversion, which holds the six numeric parameters and points to IfcProjectedCRS through TargetCRS. The project's unit assignment is a separate branch that decides what Scale has to convert.</desc>
  <rect class="svg-bg" x="6" y="16" width="754" height="248" fill="#ffffff"/>
  <defs>
    <marker id="rmc-ent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="96" width="130" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="200" y="30" width="190" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="200" y="164" width="190" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="440" y="30" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="620" y="30" width="126" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="440" y="120" width="306" height="36" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#rmc-ent-arrow)">
    <path d="M150 110 L198 60"/>
    <path d="M150 132 L198 184"/>
    <path d="M390 55 H438"/>
    <path d="M590 55 H618"/>
    <path d="M515 81 V118"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="126">IfcProject</text>
    <text x="295" y="52">Model context, 3D</text>
    <text x="295" y="70">ContextType = Model</text>
    <text x="295" y="186">IfcUnitAssignment</text>
    <text x="295" y="204">LENGTHUNIT: MILLI METRE</text>
    <text x="515" y="60">IfcMapConversion</text>
    <text x="683" y="60">IfcProjectedCRS</text>
    <text x="593" y="143">E · N · H · abscissa · ordinate · Scale</text>
  </g>
  <text x="414" y="48" fill="#5b6471" font-size="11" text-anchor="middle">inverse</text>
  <text x="380" y="246" fill="#15384a" font-size="12.5" text-anchor="middle">The unit branch never touches the conversion, which is why Scale and units disagree so often.</text>
</svg>
<figcaption>Georeferencing lives on the model context, not the project or the site; the length unit that Scale must reconcile lives on a separate branch.</figcaption>
</figure>

### 3. Resolve the CRS name to an EPSG code

`IfcProjectedCRS.Name` should be an EPSG identifier, and in practice is whatever the authoring tool wrote.

```python
from pyproj import CRS
from pyproj.database import query_crs_info
from pyproj.exceptions import CRSError

def resolve_crs(name):
    try:
        crs = CRS.from_user_input(name)          # "EPSG:25832", "epsg:25832"
    except CRSError:
        hits = [i for i in query_crs_info(auth_name="EPSG") if i.name.lower() == name.lower()]
        if len(hits) != 1:
            raise ValueError(f"cannot resolve CRS name {name!r} to exactly one EPSG code")
        crs = CRS.from_epsg(int(hits[0].code))
    epsg = crs.to_epsg()
    if epsg is None or not crs.is_projected:
        raise ValueError(f"{name!r} is not a projected CRS with an EPSG code")
    return epsg, crs

epsg, crs = resolve_crs(mc.crs_name)
print(f"EPSG:{epsg}", crs.name, [a.unit_name for a in crs.axis_info])
```

The name lookup handles the common authoring-tool output — the CRS's descriptive name, such as `"ETRS89 / UTM zone 32N"` — and refuses anything ambiguous. Printing the axis units catches the US case: EPSG:2263 is in US survey feet, so the map-unit side of `Scale` is feet and a metric model needs a scale near 3.2808, not 1.0.

### 4. Reconcile Scale against the project length unit

```python
import ifcopenshell.util.unit

unit_to_m = ifcopenshell.util.unit.calculate_unit_scale(model)
map_unit_to_m = crs.axis_info[0].unit_conversion_factor     # 1.0 for metres, 0.3048006 for US ft

expected = unit_to_m / map_unit_to_m
ratio = mc.scale_xy / expected
print(f"project unit→m {unit_to_m}, map unit→m {map_unit_to_m:.7f}, "
      f"Scale {mc.scale_xy}, expected ≈ {expected:.7f}, ratio {ratio:.6f}")

if abs(ratio - 1.0) < 0.001:
    verdict = "consistent"
elif abs(ratio * 1000 - 1.0) < 0.001 or abs(ratio / 1000 - 1.0) < 0.001:
    verdict = "off by 1000: Scale ignores the millimetre project unit"
else:
    verdict = "unexplained: check for a projection scale factor or a wrong unit"
print(verdict)
```

A ratio within a few parts per ten thousand of 1.0 is consistent — the residual is the projection scale factor, which some authors fold into `Scale` and some do not, and 0.9996 at a UTM central meridian is legitimate. A ratio of 1000 or 0.001 is the classic millimetre mistake. Anything else needs a human.

<figure class="diagram">
<svg viewBox="46 53 668 179" role="img" aria-labelledby="rmc-scale-t rmc-scale-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rmc-scale-t">Reading the Scale ratio</title>
  <desc id="rmc-scale-d">A number line of the ratio between the stored Scale and the unit-derived expected scale. Values within a part per thousand of one are consistent, including the 0.9996 UTM scale factor. Values near one thousandth or one thousand indicate a millimetre unit mismatch. Anything else is unexplained and should stop the job.</desc>
  <rect class="svg-bg" x="46" y="53" width="668" height="179" fill="#ffffff"/>
  <path d="M40 120 H720" fill="none" stroke="#5b6471" stroke-width="2"/>
  <rect x="60" y="92" width="130" height="56" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="300" y="92" width="160" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="570" y="92" width="130" height="56" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="125" y="116">≈ 0.001</text>
    <text x="125" y="134">mm ignored</text>
    <text x="380" y="116">1.000 ± 0.001</text>
    <text x="380" y="134">consistent</text>
    <text x="635" y="116">≈ 1000</text>
    <text x="635" y="134">mm applied twice</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="245" y="80">unexplained</text>
    <text x="515" y="80">unexplained</text>
  </g>
  <text x="380" y="180" fill="#4f7a4d" font-size="12" text-anchor="middle">0.9996 on a UTM central meridian falls here, legitimately</text>
  <text x="380" y="214" fill="#15384a" font-size="12.5" text-anchor="middle">ratio = Scale ÷ (project unit in metres ÷ map unit in metres), on a log axis</text>
</svg>
<figcaption>Only the middle band is safe to apply automatically. The outer bands have a known cause and a known fix; the gaps between them go to a person.</figcaption>
</figure>

### 5. Emit the record as a sidecar

```python
import json
from dataclasses import asdict
from pathlib import Path

record = asdict(mc) | {
    "epsg": epsg,
    "project_unit_to_m": unit_to_m,
    "scale_verdict": verdict,
    "rotation_deg": math.degrees(mc.rotation_rad),
    "source_file": "clinic_block_c.ifc",
    "schema": model.schema,
}
Path("clinic_block_c.georef.json").write_text(json.dumps(record, indent=2))
```

Writing the normalised record next to the model makes the georeferencing reviewable in a pull request and diffable between model revisions — a rotation that changes by 0.8° between two deliveries of the same building is visible at a glance in JSON and invisible in a 300 MB STEP file.

The record is also the right place to stop a delivery. A CI job that runs the reader on every incoming revision can compare the new sidecar with the last accepted one and fail when any parameter moves by more than its tolerance — a centimetre on the translation, a hundredth of a degree on the rotation, a part per million on the scale. Genuine changes to georeferencing are rare once a project is set out, so an alert on movement catches the far more common case of an export setting that changed between two authors, or a model re-saved from a template with a different origin. Keeping the tolerances in the same repository as the sidecars means a deliberate re-survey is recorded as a reviewed change rather than an override.

## Expected Output & Verification

For a millimetre IFC4 model delivered in ETRS89 / UTM 32N with the projection scale folded in:

```text
EPSG:25832 ETRS89 / UTM zone 32N ['metre', 'metre']
project unit→m 0.001, map unit→m 1.0000000, Scale 0.0009996, expected ≈ 0.0010000, ratio 0.999600
consistent
```

Verify the record rather than the reader. Load the sidecar in a fresh process, apply it to four surveyed corners in the model's local coordinates and require every horizontal residual under 5 cm; then check that `rotation_deg` agrees with the angle of a long, straight facade measured on the cadastral map in the same EPSG code, to within a tenth of a degree.

<figure class="diagram">
<svg viewBox="6 6 748 210" role="img" aria-labelledby="rmc-flow-t rmc-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rmc-flow-t">Reader output and its independent checks</title>
  <desc id="rmc-flow-d">The reader turns an IFC file into a JSON sidecar. Two independent checks consume the sidecar: surveyed control points test the translation and scale, and a facade bearing measured on the cadastral map tests the rotation. Only when both pass is the sidecar applied to the geometry.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="210" fill="#ffffff"/>
  <defs>
    <marker id="rmc-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="70" width="110" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="170" y="70" width="130" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="340" y="20" width="200" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="340" y="120" width="200" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="590" y="70" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#rmc-flow-arrow)">
    <path d="M130 95 H168"/>
    <path d="M300 88 L338 50"/>
    <path d="M300 102 L338 140"/>
    <path d="M540 45 L588 85"/>
    <path d="M540 145 L588 105"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="75" y="100">.ifc</text>
    <text x="235" y="92">georef.json</text>
    <text x="235" y="109">sidecar</text>
    <text x="440" y="42">control points</text>
    <text x="440" y="59">E0 · N0 · Scale</text>
    <text x="440" y="142">facade bearing</text>
    <text x="440" y="159">rotation θ</text>
    <text x="665" y="92">apply to</text>
    <text x="665" y="109">geometry</text>
  </g>
  <text x="380" y="198" fill="#15384a" font-size="12.5" text-anchor="middle">Neither check reads the IFC file, so neither can agree with a wrong reader by construction.</text>
</svg>
<figcaption>The sidecar is tested against evidence that did not come from the model, which is the only kind of test that can catch a model that is wrong.</figcaption>
</figure>

## Common Errors

**`AttributeError: entity instance of type 'IFC4.IfcGeometricRepresentationSubContext' has no attribute 'HasCoordinateOperation'`.** Sub-contexts inherit from the context entity but do not carry the inverse in every IfcOpenShell build. Filter them out as step 1 does before reading the inverse.

**`StopIteration` on the model context.** The file has only a `"Plan"` context, typical of exports from 2D-first tools, or a context whose `ContextType` is `None`. Fall back to the first context with `CoordinateSpaceDimension == 3` and log that the model context was unnamed.

**`CRSError: Invalid projection: ETRS89 / UTM zone 32N`.** The authoring tool wrote the descriptive name rather than an identifier. The database lookup in step 3 resolves it; if it returns several candidates, the name is genuinely ambiguous and the project's delivery specification has to supply the code.

## Frequently Asked Questions

### Can a model legitimately have more than one IfcMapConversion?

Yes — one per representation context, for instance a georeferenced plan context alongside the model context. They should agree. When they do not, the model context wins for 3D work, and the disagreement belongs in the validation report.

### Why not use ifcopenshell.util.geolocation instead of writing a reader?

Use it for the arithmetic if it suits your IfcOpenShell version; its helpers have changed names between releases. The reader above exists for the defensive part — context selection, defaults, CRS resolution and the scale verdict — which a transform helper does not do for you.

### Does the reader need the geometry at all?

No, and it should not load it. Opening a 400 MB model and reading a handful of entities takes seconds; triangulating it takes minutes. Keep the reader fast so it can run as a pre-flight check on every delivered revision.

## Related Guides

- [Transforming IFC Coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/) — applying the record to geometry
- [Georeferencing IFC2x3 Models Without IfcMapConversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/georeferencing-ifc2x3-models-without-map-conversion/) — the older schema's options
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — turning the verdict into a CI gate

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
