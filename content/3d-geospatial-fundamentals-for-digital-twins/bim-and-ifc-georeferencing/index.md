# BIM and IFC Georeferencing for Digital Twins

A BIM model arrives in engineering coordinates: millimetres, an origin somewhere near the site hut, and an x-axis that follows the building grid rather than any map. A city twin lives in a projected or Earth-centred frame measured in metres. Getting the first into the second is not a file conversion, it is a coordinate transformation with at least five parameters, and every one of them is a place where a hospital ends up rotated eleven degrees across a road or floating forty metres above the terrain. This guide covers how IFC stores georeferencing, how to read and apply it in Python with IfcOpenShell and `pyproj`, how to handle the models that arrive without it, and the validation that proves a building sits where the survey says it does.

The work sits between two areas of this site. Upstream is [coordinate reference systems for 3D assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/), which covers the target frames themselves; downstream is [3D Tiles batch tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/), which expects every building to already be in a known CRS before it is sharded. A BIM model that skips this step is the single most common reason a tiling job produces a building in the Gulf of Guinea, at latitude and longitude zero.

## Prerequisites

- **Python 3.10+** with `ifcopenshell>=0.8.0`, `pyproj>=3.6`, `numpy>=1.24` and `trimesh>=4.0`. IfcOpenShell installs from PyPI (`pip install ifcopenshell`) or conda-forge.
- **PROJ 9.3+** with network grids enabled or the relevant national geoid grid downloaded, because building heights are almost always orthometric.
- **An IFC file in IFC4, IFC4X3 or IFC2X3.** The schema decides where georeferencing lives, so read `model.schema` before anything else.
- **The project's target CRS as an EPSG code**, horizontal and vertical — for example EPSG:25832 with DHHN2016 heights (EPSG:7837), written as the compound EPSG:25832+7837, or EPSG:32618+5703 for UTM 18N with NAVD88.
- **At least three surveyed control points** on the building — corners, a slab edge, a column base — with coordinates in the target CRS. Without them the result can be internally consistent and still wrong.

## Concept

IFC separates the building's own frame from the map frame and connects them with a single conformal transformation. In IFC4 and later that transformation is an `IfcMapConversion` entity, attached to the model's geometric representation context and pointing at an `IfcProjectedCRS` that names the target system.

`IfcMapConversion` carries six numbers. `Eastings`, `Northings` and `OrthogonalHeight` place the IFC origin in the target CRS. `XAxisAbscissa` and `XAxisOrdinate` are the components of the IFC x-axis expressed in the map's easting and northing directions, so the rotation angle is `atan2(XAxisOrdinate, XAxisAbscissa)`. `Scale` converts IFC length units into map units and, where needed, absorbs the projection's scale factor. A local point `(x, y, z)` maps to:

- `E = Scale · (x·cos θ − y·sin θ) + Eastings`
- `N = Scale · (x·sin θ + y·cos θ) + Northings`
- `H = Scale · z + OrthogonalHeight`

That is a Helmert transformation without the out-of-plane rotations, and the missing rotations are deliberate: buildings are levelled to gravity, so tilt is not a free parameter.

<figure class="diagram">
<svg viewBox="6 26 748 268" role="img" aria-labelledby="bim-frames-t bim-frames-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bim-frames-t">From the IFC building frame to the map frame</title>
  <desc id="bim-frames-d">The building frame has its own origin and an x-axis along the structural grid. IfcMapConversion rotates it by the angle between the building x-axis and grid east, scales millimetres to metres, and translates the origin to the stated easting, northing and height in the projected CRS.</desc>
  <rect class="svg-bg" x="6" y="26" width="748" height="268" fill="#ffffff"/>
  <defs>
    <marker id="bim-frames-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="40" width="230" height="200" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="510" y="40" width="230" height="200" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="280" y="100" width="200" height="84" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path fill="none" d="M60 200 H200" stroke="#c46a3d" stroke-width="2.5" marker-end="url(#bim-frames-arrow)"/>
  <path fill="none" d="M60 200 V80" stroke="#c46a3d" stroke-width="2.5" marker-end="url(#bim-frames-arrow)"/>
  <path d="M90 170 h80 v-60 h-80 Z" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path fill="none" d="M560 205 L690 150" stroke="#1f6b8a" stroke-width="2.5" marker-end="url(#bim-frames-arrow)"/>
  <path fill="none" d="M560 205 H700" stroke="#5b6471" stroke-width="1.2" stroke-dasharray="5 4"/>
  <path fill="none" d="M251 142 H278" stroke="#5b6471" stroke-width="2" marker-end="url(#bim-frames-arrow)"/>
  <path fill="none" d="M481 142 H508" stroke="#5b6471" stroke-width="2" marker-end="url(#bim-frames-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="62">IFC building frame</text>
    <text x="130" y="145">grid A–D</text>
    <text x="135" y="226">x along grid, mm</text>
    <text x="625" y="62">Projected CRS</text>
    <text x="625" y="226">E, N, H in metres</text>
    <text x="380" y="128">IfcMapConversion</text>
    <text x="380" y="148">rotate θ · scale</text>
    <text x="380" y="168">translate E0, N0, H0</text>
  </g>
  <text x="640" y="200" fill="#5b6471" font-size="11.5" text-anchor="middle">grid east</text>
  <text x="640" y="136" fill="#1f6b8a" font-size="11.5" text-anchor="middle">IFC x-axis, θ</text>
  <text x="380" y="276" fill="#15384a" font-size="12.5" text-anchor="middle">Three translations, one rotation, one scale — and nothing tilts.</text>
</svg>
<figcaption>IfcMapConversion is a levelled conformal transformation: the building frame is rotated about the vertical, scaled from project units, and shifted onto the map.</figcaption>
</figure>

Two details cause most of the damage. The first is that the rotation is to **grid north**, the north of the projection, not true north. In a UTM zone the two differ by the meridian convergence, which reaches about three degrees near the zone edge — enough to move a corner of a 100 m building by five metres. IFC separately stores `TrueNorth` on the representation context for solar studies, and models regularly confuse the two. The second is units: an IFC4 model in millimetres needs `Scale = 0.001` to land in metres, and a surprising share of exported files leave `Scale` empty, which the standard defines as 1.0.

IFC2X3 has no `IfcMapConversion`. Georeferencing in those files is either absent, approximated by `IfcSite.RefLatitude`, `RefLongitude` and `RefElevation`, or carried in the `ePSet_MapConversion` and `ePSet_ProjectedCRS` property sets that buildingSMART's georeferencing guidance defined as a stop-gap. A reader has to handle all three.

### Who owns each number

It helps to know where the parameters come from in a real project, because that tells you which of them to distrust. The easting, northing and height of the origin are normally set once, early, by the surveyor who establishes site control, and they are usually right. The rotation is set by whoever aligned the structural grid to the site plan — often an architect working from a drawing with a north arrow — and that is where the grid-north and true-north confusion enters. The scale is set by the export dialog of the authoring tool, which is why it disagrees with the project units so often: the person exporting rarely sees it.

The practical consequence is an order of suspicion. When a model lands in the wrong place, check the scale first, because it fails silently and by factors of a thousand. Check the rotation second, because it fails by the convergence and looks nearly right. Check the translation last, because survey-derived numbers are rarely wrong by more than a typing error, and a typing error in an easting moves the building by a round power of ten that is obvious on a map.

A digital twin programme that ingests many buildings should also decide who is allowed to *change* these numbers. A pipeline that silently corrects a bad rotation fixes the twin and leaves the source model wrong for every other consumer — the facilities team, the energy modeller, the next contractor. The durable fix is to report the discrepancy against the delivery specification and have the model corrected at source, with the pipeline refusing the model until it is.

## Step-by-Step Workflow

### 1. Open the model and find where the georeferencing lives

```python
import ifcopenshell

model = ifcopenshell.open("site_b_hospital.ifc")
print("schema:", model.schema)

def georef_source(model):
    if model.schema != "IFC2X3" and model.by_type("IfcMapConversion"):
        return "IfcMapConversion"
    for pset in model.by_type("IfcPropertySet"):
        if pset.Name == "ePSet_MapConversion":
            return "ePSet_MapConversion"
    site = model.by_type("IfcSite")
    if site and site[0].RefLatitude and site[0].RefLongitude:
        return "IfcSite.RefLatitude"
    return None

source = georef_source(model)
print("georeferencing from:", source)
if source is None:
    raise SystemExit("no georeferencing: register against control points instead")
```

The order of the checks encodes a preference. `IfcMapConversion` is exact and authoritative; the property sets are exact but non-standard; `RefLatitude` is a single point with no rotation, which pins the model but leaves it free to spin about that point.

### 2. Read the conversion parameters and the target CRS

```python
import math
import ifcopenshell.util.unit

conv = model.by_type("IfcMapConversion")[0]
crs = conv.TargetCRS

params = {
    "epsg": crs.Name,                      # e.g. "EPSG:25832"
    "vertical": crs.VerticalDatum,         # e.g. "DHHN2016"
    "e0": conv.Eastings,
    "n0": conv.Northings,
    "h0": conv.OrthogonalHeight,
    "theta": math.atan2(conv.XAxisOrdinate or 0.0, conv.XAxisAbscissa or 1.0),
    "scale": conv.Scale if conv.Scale is not None else 1.0,
}

unit_to_m = ifcopenshell.util.unit.calculate_unit_scale(model)
print(params, "project length unit → metres:", unit_to_m)
```

`calculate_unit_scale` returns the factor from the project's length unit to metres — 0.001 for a millimetre model. Compare it with `Scale` before trusting either: when the model is in millimetres and `Scale` is 1.0, the conversion was authored assuming the geometry would already be in metres, which is true of IfcOpenShell's geometry output but not of the raw placement coordinates.

### 3. Extract world-coordinate geometry

IfcOpenShell resolves the chain of local placements for you and returns vertices in metres.

```python
import multiprocessing
import numpy as np
import ifcopenshell.geom

settings = ifcopenshell.geom.settings()
settings.set("use-world-coords", True)

iterator = ifcopenshell.geom.iterator(settings, model, multiprocessing.cpu_count())
meshes = {}
if iterator.initialize():
    while True:
        shape = iterator.get()
        verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
        faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
        meshes[shape.guid] = (verts, faces)
        if not iterator.next():
            break

all_v = np.vstack([v for v, _ in meshes.values()])
print(f"{len(meshes)} elements, local bbox {all_v.min(0).round(2)} → {all_v.max(0).round(2)}")
```

The local bounding box is the first sanity check. A hospital should span tens to a few hundred metres. A box a thousand times larger means the geometry came back in millimetres; a box whose minimum is already near `(500000, 5300000)` means the authoring tool baked map coordinates into the placements and the map conversion must not be applied a second time.

### 4. Apply the map conversion

```python
def ifc_to_map(verts_m, p, unit_to_m=unit_to_m):
    """Local IFC coordinates (metres) → projected E, N, orthometric H."""
    s = p["scale"] / unit_to_m     # Scale converts project units; the geometry is already metric
    if not 0.99 < s < 1.01:
        raise ValueError(f"effective scale {s:.6f}: Scale and project units disagree")
    c, sn = math.cos(p["theta"]), math.sin(p["theta"])
    x, y, z = verts_m[:, 0], verts_m[:, 1], verts_m[:, 2]
    e = s * (x * c - y * sn) + p["e0"]
    n = s * (x * sn + y * c) + p["n0"]
    h = s * z + p["h0"]
    return np.column_stack([e, n, h])

mapped = {guid: (ifc_to_map(v, params), f) for guid, (v, f) in meshes.items()}
```

Dividing by the unit factor is the line that earns its keep. `Scale` in IFC4 is documented as the factor between IFC length units and map units, so a millimetre model correctly carries 0.001 — and applying it unchanged to IfcOpenShell's already-metric output shrinks the building a thousandfold, to a point at the origin coordinates. What survives the division is the projection scale factor, if the author included one, and the range check refuses anything that is not plausibly one: an empty `Scale` on a millimetre model yields 1000 and stops the job instead of producing a building the size of a county.

### 5. Check grid north against true north

```python
from pyproj import CRS, Transformer, Proj

proj = Proj(CRS.from_user_input(params["epsg"]))
to_geo = Transformer.from_crs(params["epsg"], "EPSG:4326", always_xy=True)
lon, lat = to_geo.transform(params["e0"], params["n0"])
convergence = proj.get_factors(lon, lat).meridian_convergence

ctx = next(c for c in model.by_type("IfcGeometricRepresentationContext")
           if c.ContextType == "Model")
true_north = ctx.TrueNorth.DirectionRatios if ctx.TrueNorth else (0.0, 1.0)
tn_angle = math.degrees(math.atan2(-true_north[0], true_north[1]))
print(f"map rotation {math.degrees(params['theta']):.3f}°, true north {tn_angle:.3f}°, "
      f"convergence {convergence:.3f}°")
```

When the map rotation and the true-north angle differ by almost exactly the convergence, the model is consistent. When they are equal, somebody set one from the other and the building is rotated by the convergence — the signature of a model placed against a north arrow rather than a survey.

<figure class="diagram">
<svg viewBox="51 13 703 255" role="img" aria-labelledby="bim-north-t bim-north-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bim-north-t">Grid north, true north and the building axis</title>
  <desc id="bim-north-d">Three directions meet at the building origin: grid north of the projection, true north, which differs from grid north by the meridian convergence, and the building's own y-axis. IfcMapConversion measures its rotation from grid north; TrueNorth on the representation context measures from true north. Mixing them rotates the building by the convergence.</desc>
  <rect class="svg-bg" x="51" y="13" width="703" height="255" fill="#ffffff"/>
  <defs>
    <marker id="bim-north-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path fill="none" d="M200 220 V50" stroke="#1f6b8a" stroke-width="2.5" marker-end="url(#bim-north-arrow)"/>
  <path fill="none" d="M200 220 L225 52" stroke="#4f7a4d" stroke-width="2.5" marker-end="url(#bim-north-arrow)"/>
  <path fill="none" d="M200 220 L290 66" stroke="#c46a3d" stroke-width="2.5" marker-end="url(#bim-north-arrow)"/>
  <rect x="420" y="40" width="320" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="420" y="108" width="320" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="420" y="176" width="320" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="180" y="44" fill="#1f6b8a" font-size="12" text-anchor="middle">grid N</text>
  <text x="240" y="40" fill="#4f7a4d" font-size="12" text-anchor="middle">true N</text>
  <text x="318" y="62" fill="#9a4f26" font-size="12" text-anchor="middle">building y</text>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="580" y="64">Grid north: projection axis</text>
    <text x="580" y="82">IfcMapConversion rotates from here</text>
    <text x="580" y="132">True north: differs by convergence</text>
    <text x="580" y="150">IfcGeometricRepresentationContext.TrueNorth</text>
    <text x="580" y="200">Building y-axis: structural grid</text>
    <text x="580" y="218">what the architect drew</text>
  </g>
  <text x="200" y="250" fill="#15384a" font-size="12" text-anchor="middle">convergence ≈ 1.2° here, 3° at a UTM zone edge</text>
</svg>
<figcaption>The rotation in IfcMapConversion is measured from grid north. A model rotated from true north instead is off by the meridian convergence at the site.</figcaption>
</figure>

### 6. Transform to the delivery frame

Tilesets want Earth-centred coordinates, EPSG:4978, with orthometric heights converted to ellipsoidal ones on the way.

```python
to_ecef_tf = Transformer.from_crs(f"{params['epsg']}+7837", "EPSG:4978", always_xy=True)

def to_ecef(enh):
    x, y, z = to_ecef_tf.transform(enh[:, 0], enh[:, 1], enh[:, 2])
    return np.column_stack([x, y, z])

ecef = {guid: (to_ecef(v), f) for guid, (v, f) in mapped.items()}
centre = np.vstack([v for v, _ in ecef.values()]).mean(axis=0)
print("ECEF centre:", centre.round(3))
```

The vertical datum EPSG code must match what the model's `OrthogonalHeight` was measured against — DHHN2016 (EPSG:7837) in this German example, NAVD88 (EPSG:5703) in the United States. Omit it and PROJ treats the heights as ellipsoidal, which lifts or sinks the building by the local geoid separation: around 47 m in Bavaria, around −33 m in New York. The mechanics of storing the result relative to a tile centre are in [transforming IFC coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/).

## Validation & Verification

Georeferencing is proven against independent measurements, never against the parameters that produced it.

```python
import numpy as np

# Control points: IFC local coordinates (metres) and surveyed E, N, H in EPSG:25832+7837
local = np.array([[0.0, 0.0, 0.0], [84.6, 0.0, 0.0], [84.6, 52.2, 0.0], [0.0, 52.2, 0.0]])
survey = np.array([
    [691204.412, 5335818.221, 519.31],
    [691286.901, 5335836.978, 519.29],
    [691275.305, 5335887.874, 519.33],
    [691192.799, 5335869.108, 519.30],
])

residuals = ifc_to_map(local, params) - survey
horiz = np.hypot(residuals[:, 0], residuals[:, 1])
print("horizontal residuals (m):", horiz.round(3))
print("vertical residuals (m):", residuals[:, 2].round(3))
assert horiz.max() < 0.05, "horizontal misfit exceeds 5 cm"
assert np.abs(residuals[:, 2]).max() < 0.05, "vertical misfit exceeds 5 cm"
```

Read the residual pattern as well as its size. Uniform offsets point at the translation. Residuals that grow with distance from the origin and rotate around it point at θ — usually the convergence. Residuals that grow radially outward mean `Scale` is wrong, often by the projection's scale factor, 0.9996 on a UTM central meridian, which is 4 cm per 100 m.

<figure class="diagram">
<svg viewBox="6 16 748 240" role="img" aria-labelledby="bim-resid-t bim-resid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bim-resid-t">Residual patterns and what they diagnose</title>
  <desc id="bim-resid-d">Three panels of control-point residual arrows. Equal parallel arrows mean a translation error. Arrows perpendicular to the direction from the origin, growing with distance, mean a rotation error. Arrows pointing radially outward and growing with distance mean a scale error.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="240" fill="#ffffff"/>
  <defs>
    <marker id="bim-resid-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="220" height="160" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="270" y="30" width="220" height="160" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="520" y="30" width="220" height="160" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#b0413e" stroke-width="2" marker-end="url(#bim-resid-arrow)">
    <path fill="none" d="M70 80 l24 -10"/><path fill="none" d="M180 80 l24 -10"/><path fill="none" d="M70 150 l24 -10"/><path fill="none" d="M180 150 l24 -10"/>
    <path fill="none" d="M330 80 l-8 -14"/><path fill="none" d="M430 80 l14 -8"/><path fill="none" d="M430 150 l8 14"/><path fill="none" d="M330 150 l-14 8"/>
    <path fill="none" d="M580 80 l-18 -12"/><path fill="none" d="M680 80 l18 -12"/><path fill="none" d="M680 150 l18 12"/><path fill="none" d="M580 150 l-18 12"/>
  </g>
  <g fill="#5b6471">
    <circle cx="130" cy="115" r="4"/><circle cx="380" cy="115" r="4"/><circle cx="630" cy="115" r="4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="212">translation: E0, N0, H0</text>
    <text x="380" y="212">rotation: θ or convergence</text>
    <text x="630" y="212">scale: units or k</text>
  </g>
  <text x="380" y="238" fill="#15384a" font-size="12" text-anchor="middle">Four well-spread control points are enough to tell these apart.</text>
</svg>
<figcaption>The shape of the control-point residuals names the wrong parameter, which is faster than re-deriving all six.</figcaption>
</figure>

Two further checks belong in the same job. Drape the building footprint over the terrain model and confirm the ground-floor slab sits within a few centimetres of the DTM at its entrances. And overlay the footprint on the municipal cadastre in the same EPSG code: a building that fits its survey points but straddles a parcel boundary has a control-point problem, not a model problem.

## Performance & Scale

Geometry extraction dominates. IfcOpenShell's iterator triangulates every element through OpenCASCADE, and a 400 MB hospital model with detailed MEP can take ten to twenty minutes on eight cores; the transformation itself is a vectorised affine map that runs over tens of millions of vertices in under a second.

- **Filter elements before triangulating.** A city twin rarely needs ducts, fasteners or furniture. Passing `exclude=model.by_type("IfcDistributionElement") + model.by_type("IfcFurnishingElement")` to `ifcopenshell.geom.iterator` cuts extraction time by half or more on MEP-heavy models.
- **Cache per GUID.** Element GUIDs are stable between model revisions, so hash each element's geometry and reuse the triangulation for unchanged elements — the same content-hashing idea as [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).
- **Transform in float64, store in float32 relative to a centre.** Projected coordinates need eight significant digits before the decimal point; float32 has seven. Subtract a local centre before downcasting.
- **Run pyproj once per building, not per element.** Stack vertices, transform once, split by offsets. Per-element transformer calls on a model with 60,000 elements cost more than the geometry.

## Failure Modes & Gotchas

**The building is at the right place and 1,000 times too small.** `Scale = 0.001` was applied to IfcOpenShell's metric output without dividing by the project unit factor. Step 4 exists for exactly this.

**The building is rotated by one to three degrees.** θ was derived from `TrueNorth` instead of `XAxisAbscissa` and `XAxisOrdinate`, or the authoring tool wrote true north into the map conversion. The residual pattern is a pure rotation around the origin; the correction is the meridian convergence.

**The building floats 40–50 m above the terrain.** `OrthogonalHeight` is orthometric and was treated as ellipsoidal in the ECEF transform. Add the vertical EPSG code to the source CRS so PROJ applies the geoid.

**The building sits correctly but its interior is offset.** Some authoring tools write a site placement with a non-zero offset *and* a map conversion that assumes a zero origin, double-counting the translation for elements placed relative to the site. Compare the world-coordinate bounding box from step 3 with the local one: if its minimum is already hundreds of metres from zero, a placement offset is in play.

**IFC2X3 models placed from `RefLatitude` spin.** A single reference point has no rotation, so the model is pinned at one corner and free to rotate. Use the property-set route or register against control points — see [georeferencing IFC2x3 models without IfcMapConversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/georeferencing-ifc2x3-models-without-map-conversion/).

## Frequently Asked Questions

### Should the IFC model or the pipeline own the georeferencing?

The model, whenever possible. A map conversion written into the file travels with every revision and every consumer; one applied only in a pipeline is lost the moment someone opens the file in another tool. Pipelines should read and verify it, and write it back when they have to derive it from control points.

### Can I use the site's latitude and longitude from IfcSite directly?

Only as a coarse locator. It carries no rotation and is often the address geocode rather than a surveyed point. Use it to confirm the map conversion is in the right city, not to place geometry.

### What accuracy should I expect from a well-georeferenced model?

Two to five centimetres horizontally at control points is typical for a model set out from a survey, which is also the tolerance at which facades stop visibly disagreeing with photogrammetry. Anything above 20 cm is a parameter error, not measurement noise.

### Does IFC4X3 change any of this?

It adds `IfcMapConversionScaled`, with separate `FactorX`, `FactorY` and `FactorZ`, and `IfcRigidOperation` for non-projected targets. The reading code needs a branch for the scaled variant; the transformation logic is unchanged.

### How do I handle a model delivered in a local site grid rather than a national CRS?

Treat the site grid as an engineering CRS and register it to the national one with a Helmert fit against the survey control, then write the resulting parameters into `IfcMapConversion`. A site grid never belongs in the delivered tileset.

## Related Guides

- [Reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/) — every schema variant of the parameters
- [Transforming IFC Coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/) — from map coordinates to a tile transform
- [Georeferencing IFC2x3 Models Without IfcMapConversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/georeferencing-ifc2x3-models-without-map-conversion/) — property sets and control-point fits
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the height half of the problem
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — where the placed building goes next
- [Extracting IFC Properties into Tile Metadata](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/extracting-ifc-properties-into-tile-metadata/) — carry IFC property sets into 3D Tiles metadata
- [Simplifying IFC Geometry for Web Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/simplifying-ifc-geometry-for-web-tiles/) — cut a BIM model down to streamable geometry
- [Validating IFC Georeferencing in CI](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/validating-ifc-georeferencing-in-ci/) — gate every IFC delivery automatically

Back to [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/).
