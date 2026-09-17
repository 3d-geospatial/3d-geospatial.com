# Computing Building Heights and Volumes from CityJSON

This page computes building heights and volumes from a CityJSON city model in a way a planner or energy modeller can defend — choosing between ridge, eave and reference heights, closing LOD2 shells at ground level so a volume exists at all, integrating volume with the divergence theorem, and cross-checking every number against the model's own attributes, in EPSG:25832 with DHHN2016 heights.

## Why you hit this

"How tall is that building and how much volume does it enclose" sounds like a lookup and is not. A city model may carry `measuredHeight` with no statement of what it is measured from, and the answer differs by metres depending on whether you mean the ridge, the eave, the highest point of any superstructure, or the height above the terrain rather than above the datum. Volume is worse: an LOD2 building is usually a set of wall and roof surfaces with no ground surface, so it encloses nothing, and a naive integration over an open shell returns a number that depends on where the coordinate origin happens to be. Both quantities feed real decisions — daylight assessments, heating demand, tax valuation — so they need a stated definition and a check. The geometry access this builds on is in [extracting LOD2 roof surfaces from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/extracting-lod2-roof-surfaces-from-cityjson/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`, `shapely>=2.0`, `trimesh>=4.0`.
- A CityJSON file with LOD1 or LOD2 geometry; semantics are needed to find ground and roof surfaces reliably.
- A terrain model — a DTM raster in the same CRS — if heights above ground rather than above the datum are wanted.

## Step-by-Step

### 1. Decide which height you mean

```python
import json
from pathlib import Path
import numpy as np

cj = json.loads(Path("district_lod2.city.json").read_text())
t = cj["transform"]
V = np.asarray(cj["vertices"], dtype=np.float64) * np.asarray(t["scale"]) + np.asarray(t["translate"])

def surfaces(geom):
    b, sem = geom["boundaries"], geom.get("semantics", {}).get("values")
    if geom["type"] in ("MultiSurface", "CompositeSurface"):
        for i, s in enumerate(b):
            yield s, (sem[i] if sem else None)
    elif geom["type"] == "Solid":
        for k, shell in enumerate(b):
            for i, s in enumerate(shell):
                yield s, (sem[k][i] if sem else None)

def height_profile(obj, lod_prefix="2"):
    zs = {"RoofSurface": [], "WallSurface": [], "GroundSurface": []}
    for g in obj.get("geometry", []):
        if not g["lod"].startswith(lod_prefix):
            continue
        names = [s["type"] for s in g.get("semantics", {}).get("surfaces", [])]
        for rings, si in surfaces(g):
            label = names[si] if (si is not None and names) else None
            if label in zs:
                zs[label].append(V[rings[0]][:, 2])
    out = {}
    for k, v in zs.items():
        if v:
            z = np.concatenate(v)
            out[k] = (float(z.min()), float(z.max()))
    return out

first = next(iter(cj["CityObjects"]))
print(height_profile(cj["CityObjects"][first]))
```

Four definitions cover nearly every requirement, and they come from different parts of the geometry. The **ridge height** is the maximum z of the roof surfaces. The **eave height** is the minimum z of the roof surfaces, which on a pitched roof is where it meets the wall. The **reference height** is the minimum z of the ground surface where one exists, and the minimum z of the walls where it does not. Height *above ground* is the ridge minus the reference; height *above datum* is the ridge itself, in the model's vertical CRS.

<figure class="diagram">
<svg viewBox="46 6 668 264" role="img" aria-labelledby="cjh-def-t cjh-def-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjh-def-t">Four height definitions on one building</title>
  <desc id="cjh-def-d">A gable-roofed building in section on sloping terrain. The ridge height is the top of the roof, the eave height is where the roof meets the wall, and the reference height is the lowest point of the ground surface. Height above ground is ridge minus reference, while height above datum is the ridge value itself. On sloping terrain the reference differs by up to a metre between the uphill and downhill wall.</desc>
  <rect class="svg-bg" x="46" y="6" width="668" height="264" fill="#ffffff"/>
  <path d="M60 200 L300 180 L560 168 L700 172" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M200 190 H420 V90 L310 40 L200 90 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M60 230 H700" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="6 4"/>
  <g stroke="#9a4f26" stroke-width="2">
    <path d="M470 40 V230"/><path d="M462 40 H478"/><path d="M462 230 H478"/>
    <path d="M540 40 V186"/><path d="M532 40 H548"/><path d="M532 186 H548"/>
    <path d="M610 90 V186"/><path d="M602 90 H618"/><path d="M602 186 H618"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="486" y="82">above datum</text>
    <text x="556" y="150">above ground</text>
    <text x="626" y="118">eave height</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="310" y="34">ridge</text>
    <text x="150" y="196">terrain</text>
    <text x="310" y="212">reference: lowest ground surface</text>
    <text x="380" y="252">vertical datum, z = 0 (DHHN2016)</text>
  </g>
</svg>
<figcaption>On sloping ground the reference height is a choice in itself — the lowest, the mean or the entrance-side ground level — and the choice has to be recorded with the number.</figcaption>
</figure>

### 2. Compute heights for every building

```python
def building_heights(cj, dtm_sampler=None):
    rows = {}
    for oid, obj in cj["CityObjects"].items():
        if obj["type"] not in ("Building", "BuildingPart"):
            continue
        prof = height_profile(obj)
        if "RoofSurface" not in prof:
            continue
        ridge = prof["RoofSurface"][1]
        eave = prof["RoofSurface"][0]
        if "GroundSurface" in prof:
            ref = prof["GroundSurface"][0]
        elif "WallSurface" in prof:
            ref = prof["WallSurface"][0]
        else:
            continue
        rows[oid] = {
            "ridge_m": ridge, "eave_m": eave, "reference_m": ref,
            "h_above_ground_m": ridge - ref,
            "h_eave_above_ground_m": eave - ref,
            "declared_m": obj.get("attributes", {}).get("measuredHeight"),
        }
    return rows

heights = building_heights(cj)
hs = np.array([r["h_above_ground_m"] for r in heights.values()])
print(f"{len(heights):,} buildings | height above ground: median {np.median(hs):.1f} m, "
      f"p5 {np.percentile(hs, 5):.1f}, p95 {np.percentile(hs, 95):.1f}")
```

Falling back to the lowest wall vertex when no ground surface exists is the pragmatic choice for LOD2 data and is accurate to a few decimetres, because walls are modelled down to the terrain intersection. Estimating storeys from the result is tempting and should be done explicitly if at all: dividing the eave height by 3.0 m is a convention, not a measurement, and it belongs in a column named for the assumption.

### 3. Close the shell before computing any volume

```python
from shapely.geometry import Polygon
from shapely.ops import unary_union

def footprint(obj, lod_prefix="2"):
    polys = []
    for g in obj.get("geometry", []):
        if not g["lod"].startswith(lod_prefix):
            continue
        for rings, _ in surfaces(g):
            p = Polygon(V[rings[0]][:, :2])
            if p.is_valid and p.area > 0.2:
                polys.append(p)
    return unary_union(polys) if polys else None

def closed_mesh(obj, ref_z, lod_prefix="2"):
    """Triangulate walls and roofs, then cap the building at ref_z with its footprint."""
    import trimesh
    from trimesh.creation import triangulate_polygon

    tris = []
    for g in obj.get("geometry", []):
        if not g["lod"].startswith(lod_prefix):
            continue
        for rings, _ in surfaces(g):
            pts = V[rings[0]]
            n = np.zeros(3)
            for i in range(len(pts)):
                n += np.cross(pts[i], pts[(i + 1) % len(pts)])
            if np.linalg.norm(n) < 1e-9:
                continue
            n /= np.linalg.norm(n)
            drop = int(np.argmax(np.abs(n)))
            keep = [i for i in range(3) if i != drop]
            poly = Polygon(pts[:, keep], [V[r][:, keep] for r in rings[1:]])
            if not poly.is_valid or poly.area < 1e-9:
                continue
            p2, faces = triangulate_polygon(poly, engine="earcut")
            p3 = np.zeros((len(p2), 3))
            p3[:, keep[0]], p3[:, keep[1]] = p2[:, 0], p2[:, 1]
            d = float(n @ pts[0])
            p3[:, drop] = (d - p3[:, keep[0]] * n[keep[0]] - p3[:, keep[1]] * n[keep[1]]) / n[drop]
            tris.append(p3[faces])

    fp = footprint(obj, lod_prefix)
    if fp is None or fp.is_empty:
        return None
    for geom in getattr(fp, "geoms", [fp]):
        p2, faces = triangulate_polygon(geom, engine="earcut")
        p3 = np.column_stack([p2, np.full(len(p2), ref_z)])
        tris.append(p3[faces])

    tri = np.vstack(tris)
    mesh = trimesh.Trimesh(vertices=tri.reshape(-1, 3), faces=np.arange(len(tri) * 3).reshape(-1, 3))
    mesh.merge_vertices()
    mesh.remove_degenerate_faces()
    trimesh.repair.fix_winding(mesh)
    trimesh.repair.fix_inversion(mesh)
    return mesh
```

The cap is what turns a set of surfaces into a solid. Its height is the reference height chosen in step 1, and that choice is now visible in the volume: capping at the lowest ground point on a sloping site adds the wedge of air under the uphill side of the building, which can be several percent. Where that matters, cap at the mean ground level and record it.

### 4. Integrate the volume and check the mesh first

```python
def building_volume(obj, ref_z):
    mesh = closed_mesh(obj, ref_z)
    if mesh is None:
        return None, "no footprint"
    if not mesh.is_volume:
        return None, f"not a closed volume (watertight={mesh.is_watertight}, winding={mesh.is_winding_consistent})"
    return float(mesh.volume), "ok"

results, failures = {}, {}
for oid, h in heights.items():
    vol, status = building_volume(cj["CityObjects"][oid], h["reference_m"])
    if vol is None:
        failures[oid] = status
    else:
        results[oid] = {**h, "volume_m3": vol,
                        "footprint_m2": footprint(cj["CityObjects"][oid]).area}
print(f"{len(results):,} volumes computed, {len(failures)} failed")
```

`trimesh.volume` uses the divergence theorem — it sums signed tetrahedra from the origin to every face — which is exact for a closed, consistently wound mesh and meaningless for anything else. That is why `is_volume` is checked before the number is read rather than after: on an open shell the same call returns a large number that changes if the building is moved, as described in [making meshes watertight for volume calculations](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/making-meshes-watertight-for-volume-calculations/).

<figure class="diagram">
<svg viewBox="66 46 648 212" role="img" aria-labelledby="cjh-cap-t cjh-cap-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjh-cap-t">Capping an LOD2 shell at ground level</title>
  <desc id="cjh-cap-d">On the left, an LOD2 building has walls and a roof but no ground surface, so its shell is open at the bottom and encloses no volume. In the middle, the footprint is triangulated at the reference height and added as a cap, closing the shell. On the right, on sloping terrain, capping at the lowest ground point includes a wedge of air under the uphill wall, which capping at the mean level avoids.</desc>
  <rect class="svg-bg" x="66" y="46" width="648" height="212" fill="#ffffff"/>
  <path d="M40 180 H240" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M80 180 V100 L140 60 L200 100 V180" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <text x="140" y="212" fill="#b0413e" font-size="12.5" text-anchor="middle">open: no volume</text>
  <path d="M300 180 V100 L360 60 L420 100 V180 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M300 180 H420" fill="none" stroke="#4f7a4d" stroke-width="4"/>
  <text x="360" y="212" fill="#4f7a4d" font-size="12.5" text-anchor="middle">capped: closed volume</text>
  <path d="M540 190 L700 160" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M560 186 V100 L620 60 L680 100 V168" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M560 186 H680" fill="none" stroke="#9a4f26" stroke-width="3" stroke-dasharray="6 4"/>
  <path d="M600 178 h60 v-12 h-60 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
  <text x="620" y="212" fill="#9a4f26" font-size="12.5" text-anchor="middle">sloping site: wedge of air</text>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">The cap height is a modelling decision that lands directly in the volume.</text>
</svg>
<figcaption>Volume is only defined once the shell is closed, and the closure height is an assumption worth recording next to the number.</figcaption>
</figure>

### 5. Cross-check against the model's own attributes

```python
declared = np.array([r["declared_m"] for r in results.values() if r["declared_m"] is not None], dtype=float)
computed = np.array([r["h_above_ground_m"] for r in results.values() if r["declared_m"] is not None])
diff = computed - declared
print(f"declared vs computed height: median {np.median(diff):+.2f} m, "
      f"p5 {np.percentile(diff, 5):+.2f}, p95 {np.percentile(diff, 95):+.2f}")

vols = np.array([r["volume_m3"] for r in results.values()])
areas = np.array([r["footprint_m2"] for r in results.values()])
implied = vols / areas
print(f"volume / footprint (mean height) median {np.median(implied):.1f} m")
assert abs(np.median(implied) - np.median(hs) * 0.8) < 3.0, "volume and height disagree structurally"
```

The comparison is the point of the exercise. A median difference near zero means the model's `measuredHeight` uses the same definition you computed. A median difference of one to three metres usually means the attribute is an eave height and you computed a ridge height, or the attribute is measured from a different reference. A difference that grows with building height points at a units problem or a percentile height such as the 3D BAG's `h_dak_50p`, which is the median roof height rather than the maximum.

Volume divided by footprint area is the mean height of the enclosed prism, and on pitched-roof buildings it should land around 75–85% of the ridge height above ground. Well outside that band means either the cap is wrong or the walls and roof do not meet.

### 6. Export a table with its definitions attached

```python
import csv

with open("building_metrics.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["building_id", "ridge_above_datum_m", "ridge_above_ground_m", "eave_above_ground_m",
                "reference_height_m", "footprint_m2", "volume_m3", "declared_height_m",
                "height_definition", "volume_definition", "crs"])
    for oid, r in sorted(results.items()):
        w.writerow([oid, round(r["ridge_m"], 2), round(r["h_above_ground_m"], 2),
                    round(r["h_eave_above_ground_m"], 2), round(r["reference_m"], 2),
                    round(r["footprint_m2"], 1), round(r["volume_m3"], 1),
                    r["declared_m"], "max roof z minus lowest ground z",
                    "closed shell capped at lowest ground z", "EPSG:25832+7837"])
print(Path("building_metrics.csv").stat().st_size, "bytes")
```

Writing the definitions into the table, rather than into an email, is what keeps the numbers usable a year later. Two analysts with the same model and different definitions will otherwise produce different answers and no way to tell which is which.

## Expected Output & Verification

```text
{'RoofSurface': (512.44, 519.86), 'WallSurface': (498.21, 519.86), 'GroundSurface': (498.21, 499.02)}
4,731 buildings | height above ground: median 9.8 m, p5 4.1, p95 21.6
4,402 volumes computed, 329 failed
declared vs computed height: median +0.04 m, p5 -1.12, p95 +1.35
volume / footprint (mean height) median 7.9 m
```

The 7% of buildings whose volume failed are the interesting output. Inspect the failure reasons rather than dropping them:

```python
from collections import Counter
print(Counter(failures.values()).most_common())
```

Most will be `not a closed volume` on buildings whose walls do not reach the footprint outline — terraced houses sharing a party wall modelled only once, or a building part whose neighbour carries the shared surface. Those need the geometry repaired or the parts merged before a volume means anything, and reporting them is more honest than substituting the footprint times the height.

<figure class="diagram">
<svg viewBox="40 46 694 198" role="img" aria-labelledby="cjh-diff-t cjh-diff-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjh-diff-t">Interpreting the declared minus computed height distribution</title>
  <desc id="cjh-diff-d">Three sketch distributions of declared minus computed height. A narrow distribution centred on zero means the same definition. A distribution centred near minus two metres means the attribute is an eave height while a ridge height was computed. A distribution that widens with building height means a percentile roof height or a unit problem.</desc>
  <rect class="svg-bg" x="40" y="46" width="694" height="198" fill="#ffffff"/>
  <path d="M40 170 H240" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M140 170 V40" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="M90 170 C120 170 125 60 140 60 C155 60 160 170 190 170" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="140" y="196" fill="#1f2937" font-size="12.5" text-anchor="middle">centred on 0: same definition</text>
  <path d="M290 170 H490" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M390 170 V40" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="M300 170 C330 170 335 70 350 70 C365 70 370 170 400 170" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <text x="390" y="196" fill="#1f2937" font-size="12.5" text-anchor="middle">offset: eave vs ridge</text>
  <path d="M540 170 H740" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M640 170 V40" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="M560 170 C610 170 600 90 640 90 C680 90 670 170 720 170" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="640" y="196" fill="#1f2937" font-size="12.5" text-anchor="middle">wide: percentile or units</text>
  <text x="380" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">declared minus computed height, metres</text>
</svg>
<figcaption>The shape of the disagreement identifies which definition the model's attribute actually uses, which no documentation reliably states.</figcaption>
</figure>

## Performance Notes

- **Triangulation dominates.** Heights are a pass over vertex z values and run over a city in seconds; closed-mesh volumes need triangulation per surface and run at roughly a thousand buildings per minute in pure Python.
- **Skip the mesh for LOD1.** An LOD1 building is a prism, so its volume is footprint area times height — exact, and thousands of times faster than meshing.
- **Cache per building identifier and geometry checksum**, because the metrics are deterministic and city models change one building at a time.
- **Parallelise per tile, not per building**, so each worker holds one vertex array rather than one per task.

## Common Errors

**Volumes are negative.** Normals point inward after triangulation. `fix_winding` then `fix_inversion` as in step 3, and re-check `is_volume` rather than taking the absolute value, which hides a real defect.

**Heights are 40–50 m larger than expected.** The model's heights are ellipsoidal while the expectation is orthometric, or vice versa. Heights above ground are unaffected, which is a good reason to prefer them when comparing datasets.

**Every building on a slope has an implausibly large volume.** The cap sits at the lowest ground vertex on a steep site. Cap at the mean ground level, or subtract the wedge explicitly, and say which in the output table.

**`measuredHeight` and the geometry disagree by a constant on every building.** The attribute is measured from a different reference — often the terrain intersection curve rather than the lowest ground vertex. That is a definition difference, not an error; record both.

## Frequently Asked Questions

### Which height should go into a planning report?

The one the regulation names, which is usually eave and ridge height above the ground at a defined point. Compute both and keep the reference explicit; a single "height" column is what makes reports impossible to reconcile.

### Is gross volume from LOD2 good enough for energy modelling?

For stock-level screening, yes. For a single building, the enclosed volume from LOD2 overestimates heated volume because it includes unheated roof space and excludes nothing for walls, so energy models apply a correction factor or use an LOD3 model.

### How do I get volumes for buildings that fail the closure check?

Merge the building with its parts and neighbours that share surfaces, re-run, and if it still fails, repair the geometry. Reporting a footprint-times-height estimate is acceptable only if the column says that is what it is.

## Related Guides

- [Extracting LOD2 Roof Surfaces from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/extracting-lod2-roof-surfaces-from-cityjson/) — the other standard derived measure
- [Making Meshes Watertight for Volume Calculations](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/making-meshes-watertight-for-volume-calculations/) — closure and volume in general
- [Validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/) — catching the shells that will fail before you compute

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
