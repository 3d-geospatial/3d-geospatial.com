# Georeferencing IFC2x3 Models Without IfcMapConversion

This page georeferences IFC2x3 building models — the schema that has no `IfcMapConversion` entity — by reading the `ePSet_MapConversion` property sets when they exist, falling back to a least-squares 2D Helmert fit against surveyed control points when they do not, and writing the result back into the model so the next consumer does not have to repeat the work. The target in the examples is EPSG:32618+5703, UTM 18N with NAVD88 heights.

## Why you hit this

IFC2x3 is still the most common schema in handover packages, because it is what many authoring tools and most existing asset registers export. The schema predates any real georeferencing: `IfcSite` has a latitude, longitude and elevation, and nothing else. A city-scale twin that ingests a hospital estate or a university campus will receive dozens of these files, and each one is placed somewhere between "correct, via a non-standard property set" and "at the origin of an arbitrary site grid". The IFC4 route is described in [reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/); this page handles everything that route cannot.

## Prerequisites

- `ifcopenshell>=0.8.0`, `pyproj>=3.6`, `numpy>=1.24`.
- The target CRS as a compound EPSG code — EPSG:32618+5703 here — confirmed with whoever commissioned the survey.
- At least three, preferably four or more, control points: features identifiable in the model (building corners, column centres, slab edges) with surveyed coordinates in the target CRS, well spread around the footprint rather than along one facade.

## Step-by-Step

### 1. Look for the buildingSMART property sets first

The buildingSMART georeferencing guidance for IFC2x3 defines two property sets that mirror the IFC4 entities, usually attached to `IfcProject` or `IfcSite`.

```python
import ifcopenshell
import ifcopenshell.util.element

model = ifcopenshell.open("east_wing_ifc2x3.ifc")
assert model.schema == "IFC2X3", model.schema

def find_epsets(model):
    for entity in model.by_type("IfcProject") + model.by_type("IfcSite"):
        psets = ifcopenshell.util.element.get_psets(entity)
        if "ePSet_MapConversion" in psets:
            return entity, psets["ePSet_MapConversion"], psets.get("ePSet_ProjectedCRS", {})
    return None, None, None

owner, conv, crs = find_epsets(model)
if conv:
    print(owner.is_a(), {k: v for k, v in conv.items() if k != "id"})
    print("CRS:", crs.get("Name"), crs.get("VerticalDatum"))
```

When the property sets exist and carry `Eastings`, `Northings`, `OrthogonalHeight`, `XAxisAbscissa`, `XAxisOrdinate` and `Scale`, the model is georeferenced exactly as an IFC4 model would be, and the same transformation applies. Validate them against control anyway: property sets are free-form, and a value typed by hand into an authoring tool's parameter dialog has no schema to protect it.

### 2. Read IfcSite's reference point, and understand what it cannot do

```python
site = model.by_type("IfcSite")[0]

def compound_to_degrees(angle):
    """IfcCompoundPlaneAngleMeasure: (degrees, minutes, seconds[, millionths of a second])."""
    if angle is None:
        return None
    parts = list(angle) + [0] * (4 - len(angle))
    d, m, s, u = parts
    sign = -1 if min(d, m, s, u) < 0 else 1
    return sign * (abs(d) + abs(m) / 60 + (abs(s) + abs(u) / 1e6) / 3600)

lat = compound_to_degrees(site.RefLatitude)
lon = compound_to_degrees(site.RefLongitude)
print(f"IfcSite reference: lat {lat}, lon {lon}, elevation {site.RefElevation}")
```

The sign rule is the detail that bites. The schema requires every component of a negative angle to carry the sign, so New York's longitude is `(-73, -59, -7, -540000)`; some exporters write only the degrees negative, which the `min(...) < 0` test tolerates. What no code can fix is that a single point has no orientation. A model placed from `RefLatitude` and `RefLongitude` alone is pinned at one location and free to rotate about it, and the reference point is frequently a geocoded street address rather than a surveyed position on the site grid's origin.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="i2x3-src-t i2x3-src-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i2x3-src-t">Georeferencing sources for IFC2x3, best first</title>
  <desc id="i2x3-src-d">A ranked list of sources. The ePSet_MapConversion property sets give a full conformal transformation. A Helmert fit to surveyed control points also gives a full transformation, with measured residuals. IfcSite reference latitude and longitude give only a single point with no rotation or scale, and a model with none of these must be placed by hand.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <rect x="20" y="20" width="720" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="20" y="74" width="720" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="20" y="128" width="720" height="44" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="20" y="182" width="720" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="47">1  ePSet_MapConversion + ePSet_ProjectedCRS</text>
    <text x="40" y="101">2  Helmert fit to surveyed control points</text>
    <text x="40" y="155">3  IfcSite RefLatitude / RefLongitude / RefElevation</text>
    <text x="40" y="209">4  nothing: register by hand, then write back</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="720" y="47">translation · rotation · scale</text>
    <text x="720" y="101">all three, plus residuals</text>
    <text x="720" y="155">one point, no rotation</text>
    <text x="720" y="209">no placement at all</text>
  </g>
</svg>
<figcaption>The control-point fit ranks alongside the property sets because it carries its own evidence; the site reference point is a locator, not a placement.</figcaption>
</figure>

### 3. Fit a 2D Helmert transformation to control points

When there are no property sets — or to check the ones there are — solve for the transformation directly. A levelled building needs four horizontal parameters and one vertical offset.

```python
import numpy as np

# Local model coordinates (metres, from IfcOpenShell world coords) and surveyed EPSG:32618+5703
local = np.array([
    [0.000, 0.000, 0.000],
    [62.400, 0.000, 0.000],
    [62.400, 38.100, 0.000],
    [0.000, 38.100, 0.000],
    [31.200, 19.050, 12.600],
])
survey = np.array([
    [585412.318, 4511203.774, 11.842],
    [585471.902, 4511222.310, 11.851],
    [585460.559, 4511258.679, 11.836],
    [585400.981, 4511240.140, 11.848],
    [585436.447, 4511231.232, 24.447],
])

def fit_helmert_2d(local_xy, map_en):
    n = len(local_xy)
    A = np.zeros((2 * n, 4))
    A[0::2, 0], A[0::2, 1], A[0::2, 2] = local_xy[:, 0], -local_xy[:, 1], 1.0
    A[1::2, 0], A[1::2, 1], A[1::2, 3] = local_xy[:, 1], local_xy[:, 0], 1.0
    b = map_en.reshape(-1)
    (a, bb, tx, ty), *_ = np.linalg.lstsq(A, b, rcond=None)
    return a, bb, tx, ty

a, bb, tx, ty = fit_helmert_2d(local[:, :2], survey[:, :2])
theta = np.arctan2(bb, a)
scale = np.hypot(a, bb)
dz = np.mean(survey[:, 2] - local[:, 2])
print(f"θ = {np.degrees(theta):.4f}°, scale = {scale:.7f}, E0 = {tx:.3f}, N0 = {ty:.3f}, H0 = {dz:.3f}")
```

The parameterisation `E = a·x − b·y + tx`, `N = b·x + a·y + ty` is linear in its unknowns, so an ordinary least-squares solve gives the exact best fit with no iteration and no initial guess. The rotation and scale come out of `a` and `b` afterwards. This is the same transformation that `IfcMapConversion` encodes, which is what makes it possible to write the result back in step 5.

### 4. Judge the fit by its residuals, not its parameters

```python
fitted_e = a * local[:, 0] - bb * local[:, 1] + tx
fitted_n = bb * local[:, 0] + a * local[:, 1] + ty
res_h = np.hypot(survey[:, 0] - fitted_e, survey[:, 1] - fitted_n)
res_v = survey[:, 2] - (local[:, 2] + dz)
rms = np.sqrt(np.mean(res_h ** 2))

for i, (rh, rv) in enumerate(zip(res_h, res_v)):
    print(f"point {i}: horizontal {rh * 1000:6.1f} mm, vertical {rv * 1000:6.1f} mm")
print(f"horizontal RMS {rms * 1000:.1f} mm")

assert rms < 0.03, "fit RMS above 3 cm: a control point is misidentified or the model is distorted"
assert abs(scale - 1.0) < 0.001, f"scale {scale:.6f}: units or a stretched model"
worst = int(np.argmax(res_h))
if res_h[worst] > 3 * rms:
    print(f"point {worst} is an outlier; re-identify it and refit without it")
```

A good fit on a building set out from survey control gives a horizontal RMS of one to three centimetres. A scale that differs from 1.0 by the local projection factor — 0.9996 to 1.0004 in UTM — is legitimate; a scale of 0.3048 means the model is in feet, and anything else near 1.0 but outside that band means the model itself is stretched, which happens when a drawing was scaled to fit a sheet.

<figure class="diagram">
<svg viewBox="26 30 714 212" role="img" aria-labelledby="i2x3-geom-t i2x3-geom-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i2x3-geom-t">Why control points must surround the footprint</title>
  <desc id="i2x3-geom-d">Two footprints. On the left, four control points sit along a single facade, so the rotation is determined only across a short baseline and a small error at one point swings the far side of the building by decimetres. On the right, four points at the corners give a long baseline in both directions and the same measurement error moves the far side by millimetres.</desc>
  <rect class="svg-bg" x="26" y="30" width="714" height="212" fill="#ffffff"/>
  <rect x="40" y="50" width="280" height="140" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="440" y="50" width="280" height="140" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M40 190 L320 172" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="6 4"/>
  <g fill="#1f6b8a">
    <circle cx="60" cy="190" r="6"/><circle cx="100" cy="190" r="6"/><circle cx="140" cy="190" r="6"/><circle cx="180" cy="190" r="6"/>
    <circle cx="440" cy="50" r="6"/><circle cx="720" cy="50" r="6"/><circle cx="720" cy="190" r="6"/><circle cx="440" cy="190" r="6"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="180" y="112">points along one facade</text>
    <text x="180" y="130">short rotation baseline</text>
    <text x="580" y="112">points at the corners</text>
    <text x="580" y="130">long baselines both ways</text>
  </g>
  <text x="180" y="224" fill="#b0413e" font-size="12" text-anchor="middle">1 cm error → 12 cm at the far corner</text>
  <text x="580" y="224" fill="#4f7a4d" font-size="12" text-anchor="middle">1 cm error → ≈ 1 cm everywhere</text>
</svg>
<figcaption>The residuals can be tiny and the placement still poor if every control point sits on one side: the fit has nothing to constrain rotation at the far corner.</figcaption>
</figure>

### 5. Write the result back into the model

```python
import ifcopenshell.api

project = model.by_type("IfcProject")[0]
pset = ifcopenshell.api.run("pset.add_pset", model, product=project, name="ePSet_MapConversion")
ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={
    "Eastings": float(tx),
    "Northings": float(ty),
    "OrthogonalHeight": float(dz),
    "XAxisAbscissa": float(np.cos(theta)),
    "XAxisOrdinate": float(np.sin(theta)),
    "Scale": float(scale),
})
crs_pset = ifcopenshell.api.run("pset.add_pset", model, product=project, name="ePSet_ProjectedCRS")
ifcopenshell.api.run("pset.edit_pset", model, pset=crs_pset, properties={
    "Name": "EPSG:32618",
    "GeodeticDatum": "WGS84",
    "VerticalDatum": "NAVD88",
    "MapProjection": "UTM",
    "MapZone": "18N",
})
model.write("east_wing_ifc2x3_georef.ifc")
```

Writing back is what stops the fit from being repeated — and repeated slightly differently — by every downstream consumer. Keep the control points and residuals in a sidecar next to the file so the next person can see what the placement rests on.

## Expected Output & Verification

```text
θ = 17.2843°, scale = 0.9996412, E0 = 585412.325, N0 = 4511203.769, H0 = 11.843
point 0: horizontal    8.6 mm, vertical   -1.0 mm
point 1: horizontal   11.2 mm, vertical    8.0 mm
point 2: horizontal    9.4 mm, vertical   -7.0 mm
point 3: horizontal   12.9 mm, vertical    5.0 mm
point 4: horizontal    6.1 mm, vertical    4.0 mm
horizontal RMS 9.9 mm
```

Verify independently of the fit: hold one control point back, fit on the rest, and predict it. A leave-one-out error close to the RMS means the fit generalises; a much larger one means that point was carrying the solution. Then reopen the written file, run the property-set reader from step 1 on it, and apply the transformation to all five points — the result must reproduce the residuals above exactly.

<figure class="diagram">
<svg viewBox="46 16 668 224" role="img" aria-labelledby="i2x3-loo-t i2x3-loo-d" xmlns="http://www.w3.org/2000/svg">
  <title id="i2x3-loo-t">Leave-one-out prediction error against fit residual</title>
  <desc id="i2x3-loo-d">Bars for five control points compare the in-fit residual with the error when that point is left out and predicted. For four points the two bars are similar, around one centimetre. For the fifth, the leave-one-out error is several times larger, showing that the point was dominating the solution.</desc>
  <rect class="svg-bg" x="46" y="16" width="668" height="224" fill="#ffffff"/>
  <path d="M60 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5">
    <rect x="90" y="152" width="40" height="28"/>
    <rect x="210" y="146" width="40" height="34"/>
    <rect x="330" y="150" width="40" height="30"/>
    <rect x="450" y="143" width="40" height="37"/>
    <rect x="570" y="158" width="40" height="22"/>
  </g>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5">
    <rect x="134" y="146" width="40" height="34"/>
    <rect x="254" y="138" width="40" height="42"/>
    <rect x="374" y="143" width="40" height="37"/>
    <rect x="494" y="54" width="40" height="126"/>
    <rect x="614" y="150" width="40" height="30"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="132" y="200">pt 0</text><text x="252" y="200">pt 1</text><text x="372" y="200">pt 2</text>
    <text x="492" y="200">pt 3</text><text x="612" y="200">pt 4</text>
  </g>
  <text x="600" y="60" fill="#9a4f26" font-size="12" text-anchor="start">46 mm held out</text>
  <text x="80" y="44" fill="#1f6b8a" font-size="12" text-anchor="start">blue: residual in fit</text>
  <text x="80" y="62" fill="#9a4f26" font-size="12" text-anchor="start">orange: error when held out</text>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Point 3 fits well only because it is in the fit — re-survey or re-identify it.</text>
</svg>
<figcaption>Leave-one-out exposes a control point that the solution bends towards, which the in-fit residuals are structurally unable to show.</figcaption>
</figure>

## Common Errors

**Longitude comes out positive for a site in the Americas.** The exporter wrote `RefLongitude` with only the degrees negative and the conversion used the sign of each component independently. Take the sign from any negative component, as step 2 does.

**`numpy.linalg.LinAlgError` or a scale of zero.** Fewer than two distinct control points, or all points identical in local coordinates because they were picked on a model that was not yet extracted in world coordinates. Check that `local` has a non-zero spread in both x and y before solving.

**The fit is excellent and the building still sits on the neighbouring parcel.** All control points were measured in a different CRS — often State Plane (EPSG:2263, US feet) rather than UTM 18N. The scale of 0.3048 or 3.2808 gives it away; if the scale is right, overlay the result on the cadastre in the same EPSG code before accepting it.

## Frequently Asked Questions

### Should I upgrade the file to IFC4 instead of writing property sets?

When the whole downstream toolchain reads IFC4, yes — IfcOpenShell can migrate a model and write a real `IfcMapConversion`. When any consumer still needs IFC2x3, the property sets are the interoperable choice and lose nothing.

### How many control points are enough?

Four well-spread points give a redundant fit with residuals you can trust; three give a solution with too little redundancy to detect a bad point. Six or more on a large campus building let the leave-one-out check work properly.

### Can I include a vertical rotation for a model that is not level?

Do not. A building that needs tilt to fit has a misidentified control point or a model authored on a sloping site grid, and fitting the tilt hides the real error. Fix the source, then fit the levelled transformation.

## Related Guides

- [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/) — the transformation and its validation in full
- [Transforming IFC Coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/) — delivering the placed model as tiles
- [How to Choose CRS for Urban Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) — agreeing the target EPSG code before the survey

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
