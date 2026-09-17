---
title: "Extracting LOD2 Roof Surfaces from CityJSON"
description: "Pull roof surfaces out of LOD2 CityJSON with Python: semantic filtering, true 3D area, slope and aspect"
---
# Extracting LOD2 Roof Surfaces from CityJSON

This page extracts every roof surface from an LOD2 CityJSON model and turns it into an analysis-ready table — filtering by surface semantics, computing true three-dimensional area rather than footprint area, deriving slope and aspect from each surface normal, classifying roof form per building, and exporting the result as GeoJSON in EPSG:25832 for solar or planning workflows.

## Why you hit this

Roof area by orientation is the input to solar potential, green-roof programmes, rainwater retention sizing and rooftop plant assessments, and an LOD2 city model already contains it: the semantics distinguish roof from wall, and the geometry has the real pitched shapes. What goes wrong is arithmetic. A roof measured in plan is 10–25% smaller than its true area on a pitched building, slope computed from an unnormalised cross product is meaningless, and a surface whose normal points into the building reports a north-facing roof as south-facing. The data model behind the semantics is covered in [CityGML and CityJSON processing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).

## Prerequisites

- Python 3.10+ with `numpy>=1.24`, `shapely>=2.0` and `pyproj>=3.6`.
- A CityJSON file with LOD2 (or LOD2.2) geometry *and* semantics — check `info` for both; an LOD1 model has no roof shapes and its "roof" is a flat lid.
- The CRS in the file's `metadata.referenceSystem`; the examples use EPSG:25832 with DHHN2016 heights, and all areas come out in square metres because the CRS is metric.

## Step-by-Step

### 1. Load the model and resolve coordinates

```python
import json
from pathlib import Path
import numpy as np

cj = json.loads(Path("district_lod2.city.json").read_text())
t = cj["transform"]
V = np.asarray(cj["vertices"], dtype=np.float64) * np.asarray(t["scale"]) + np.asarray(t["translate"])

def surfaces(geom):
    """Yield (rings, semantic_index) for a MultiSurface or Solid geometry."""
    b, sem = geom["boundaries"], geom.get("semantics", {}).get("values")
    if geom["type"] in ("MultiSurface", "CompositeSurface"):
        for i, surf in enumerate(b):
            yield surf, (sem[i] if sem else None)
    elif geom["type"] == "Solid":
        for s, shell in enumerate(b):
            for i, surf in enumerate(shell):
                yield surf, (sem[s][i] if sem else None)

print(f"{len(cj['CityObjects'])} objects, {len(V):,} vertices, CRS {cj['metadata']['referenceSystem']}")
```

### 2. Compute area, slope and aspect per surface

```python
def polygon_normal_and_area(pts):
    """Newell's method: robust normal and true 3D area for a planar polygon."""
    n = np.zeros(3)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n += np.cross(a, b)
    area = 0.5 * np.linalg.norm(n)
    return (n / np.linalg.norm(n) if np.linalg.norm(n) > 0 else n), area

def slope_aspect(normal):
    n = normal if normal[2] >= 0 else -normal          # roofs face up by definition
    slope = np.degrees(np.arccos(np.clip(n[2], -1, 1)))
    aspect = (np.degrees(np.arctan2(n[0], n[1])) + 360) % 360   # 0 = north, 90 = east
    return slope, aspect
```

Newell's method sums the cross products around the ring rather than using three arbitrary vertices. That matters on real city models, where a roof surface often has a nearly collinear triple — two vertices a few centimetres apart on a dormer edge — and the three-point normal comes out as noise or zero. It also gives the true area of the planar polygon in the same pass.

Flipping the normal upward is a deliberate simplification for roofs: a roof cannot face downward, so a negative z means the ring was wound clockwise, which happens in plenty of published models. Do not apply the same flip to walls, where orientation carries information.

<figure class="diagram">
<svg viewBox="60 62 710 222" role="img" aria-labelledby="roof-geom-t roof-geom-d" xmlns="http://www.w3.org/2000/svg">
  <title id="roof-geom-t">Slope, aspect and the difference between plan and true area</title>
  <desc id="roof-geom-d">A gable roof in section. The pitched surface has a normal tilted from vertical by the slope angle, and its horizontal projection is shorter than the surface itself, so plan area underestimates true area by the cosine of the slope. Aspect is the compass direction of the normal projected onto the horizontal plane, measured clockwise from north.</desc>
  <rect class="svg-bg" x="60" y="62" width="710" height="222" fill="#ffffff"/>
  <defs>
    <marker id="roof-geom-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M60 200 H360" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M100 180 L220 90 L340 180 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M160 135 L214 108" fill="none" stroke="#9a4f26" stroke-width="2.5" marker-end="url(#roof-geom-arrow)"/>
  <path d="M160 135 V95" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M100 216 H220" fill="none" stroke="#4f7a4d" stroke-width="5"/>
  <path d="M100 224 L100 236 M220 224 L220 236" fill="none" stroke="#4f7a4d" stroke-width="1.5"/>
  <text x="196" y="90" fill="#9a4f26" font-size="12.5" text-anchor="start">surface normal</text>
  <text x="130" y="112" fill="#1f2937" font-size="12.5" text-anchor="middle">slope</text>
  <text x="160" y="252" fill="#4f7a4d" font-size="12.5" text-anchor="middle">plan width = true × cos(slope)</text>
  <path d="M560 180 m-70 0 a70 70 0 1 0 140 0 a70 70 0 1 0 -140 0" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <path d="M560 180 V110" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M560 180 L620 145" fill="none" stroke="#9a4f26" stroke-width="2.5" marker-end="url(#roof-geom-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="560" y="100">N = 0°</text>
    <text x="660" y="140">aspect 120°</text>
    <text x="560" y="266">aspect: normal projected onto the horizontal, clockwise from north</text>
  </g>
</svg>
<figcaption>Slope is the tilt of the normal from vertical; aspect is its compass bearing. Plan area divided by the cosine of the slope gives the surface a panel would cover.</figcaption>
</figure>

### 3. Collect roof surfaces per building

```python
from collections import defaultdict

roofs = defaultdict(list)
skipped = {"no_semantics": 0, "degenerate": 0}

for oid, obj in cj["CityObjects"].items():
    root = obj.get("parents", [oid])[0]                    # attribute roofs of parts to the parent
    for g in obj.get("geometry", []):
        if not g["lod"].startswith("2"):
            continue
        names = [s["type"] for s in g.get("semantics", {}).get("surfaces", [])]
        if not names:
            skipped["no_semantics"] += 1
            continue
        for rings, si in surfaces(g):
            if si is None or names[si] != "RoofSurface":
                continue
            pts = V[rings[0]]
            normal, area = polygon_normal_and_area(pts)
            if area < 0.5 or not np.isfinite(normal).all():
                skipped["degenerate"] += 1
                continue
            slope, aspect = slope_aspect(normal)
            hole_area = sum(polygon_normal_and_area(V[r])[1] for r in rings[1:])
            roofs[root].append({
                "area_m2": area - hole_area,
                "slope_deg": slope,
                "aspect_deg": aspect,
                "z_min": float(pts[:, 2].min()),
                "z_max": float(pts[:, 2].max()),
                "ring": pts,
            })

print(f"{sum(len(v) for v in roofs.values()):,} roof surfaces on {len(roofs):,} buildings; skipped {skipped}")
```

Subtracting hole areas matters on models that represent roof openings — courtyards in a perimeter block, light wells, or an atrium — as inner rings. Attributing surfaces to the parent building rather than the `BuildingPart` keeps totals comparable with the building register, where an address has one building.

### 4. Classify roof form

```python
def roof_form(surfs):
    slopes = np.array([s["slope_deg"] for s in surfs])
    areas = np.array([s["area_m2"] for s in surfs])
    aspects = np.array([s["aspect_deg"] for s in surfs])
    pitched = slopes > 7.0
    if not pitched.any():
        return "flat"
    steep_area = areas[pitched].sum() / areas.sum()
    if steep_area < 0.3:
        return "flat with superstructure"
    # cluster the aspects of pitched faces into 10° bins to count distinct orientations
    bins = np.unique(np.round(aspects[pitched] / 10).astype(int) % 36)
    dominant = len([b for b in bins if areas[pitched][np.round(aspects[pitched] / 10).astype(int) % 36 == b].sum() > 0.1 * areas.sum()])
    if dominant <= 1:
        return "shed"
    if dominant == 2:
        return "gable"
    return "hip or complex"

forms = {oid: roof_form(s) for oid, s in roofs.items()}
tally = {f: list(forms.values()).count(f) for f in set(forms.values())}
print(tally)
```

The thresholds encode ordinary building sense: below 7° a roof is flat for any practical purpose, faces holding less than a tenth of the roof area are noise (dormers, plant screens), and the number of significant orientations separates shed from gable from hip. They are heuristics and should be tuned against a sample the local building stock — a region of mansard roofs will need a fourth category.

<figure class="diagram">
<svg viewBox="6 0 598 244" role="img" aria-labelledby="roof-form-t roof-form-d" xmlns="http://www.w3.org/2000/svg">
  <title id="roof-form-t">Roof form from slope and orientation counts</title>
  <desc id="roof-form-d">A decision path. If no surface exceeds seven degrees of slope the roof is flat. If pitched surfaces hold less than thirty percent of the area it is flat with superstructure. Otherwise the number of orientations holding more than a tenth of the area decides: one is a shed, two a gable, three or more a hip or complex roof.</desc>
  <rect class="svg-bg" x="6" y="0" width="598" height="244" fill="#ffffff"/>
  <defs>
    <marker id="roof-form-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="100" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="220" y="20" width="170" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="220" y="100" width="170" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="220" y="186" width="170" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="440" y="14" width="150" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="440" y="76" width="150" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="440" y="138" width="150" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#roof-form-arrow)">
    <path d="M170 114 L218 52"/>
    <path d="M170 125 H218"/>
    <path d="M170 140 L218 200"/>
    <path d="M390 118 L438 44"/>
    <path d="M390 125 L438 100"/>
    <path d="M390 135 L438 158"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="120">max slope</text><text x="95" y="138">&gt; 7°?</text>
    <text x="305" y="40">no → flat</text><text x="305" y="57">a single lid surface</text>
    <text x="305" y="120">pitched area</text><text x="305" y="138">≥ 30%?</text>
    <text x="305" y="206">no → flat with</text><text x="305" y="223">superstructure</text>
    <text x="515" y="34">1 orientation: shed</text>
    <text x="515" y="96">2: gable</text>
    <text x="515" y="158">3+: hip or complex</text>
  </g>
</svg>
<figcaption>Area-weighted orientation counting is what keeps a dormer from turning every gable roof into a complex one.</figcaption>
</figure>

### 5. Export roof polygons as GeoJSON

```python
from shapely.geometry import Polygon, mapping

features = []
for oid, surfs in roofs.items():
    attrs = cj["CityObjects"].get(oid, {}).get("attributes", {})
    for i, s in enumerate(surfs):
        plan = Polygon(s["ring"][:, :2])
        if not plan.is_valid or plan.area < 0.5:
            continue
        features.append({
            "type": "Feature",
            "geometry": mapping(plan),
            "properties": {
                "building_id": oid, "surface": i,
                "area_m2": round(s["area_m2"], 2),
                "plan_area_m2": round(plan.area, 2),
                "slope_deg": round(s["slope_deg"], 1),
                "aspect_deg": round(s["aspect_deg"], 1),
                "ridge_height_m": round(s["z_max"], 2),
                "roof_form": forms[oid],
                "function": attrs.get("function"),
            },
        })

Path("roof_surfaces.geojson").write_text(json.dumps({
    "type": "FeatureCollection",
    "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::25832"}},
    "features": features,
}))
print(f"{len(features):,} roof polygons written")
```

Exporting the plan-view polygon with the true area as an attribute is the combination most GIS workflows want: the geometry joins to parcels and footprints in 2D, while the area column is the one to multiply by an irradiance figure. Keeping both areas makes the pitch correction auditable.

## Expected Output & Verification

```text
4812 objects, 1,842,119 vertices, CRS https://www.opengis.net/def/crs/EPSG/0/25832
38,204 roof surfaces on 4,731 buildings; skipped {'no_semantics': 12, 'degenerate': 341}
{'gable': 2904, 'hip or complex': 1188, 'flat': 512, 'shed': 96, 'flat with superstructure': 31}
36,918 roof polygons written
```

Three checks make the numbers trustworthy:

```python
total_true = sum(s["area_m2"] for v in roofs.values() for s in v)
total_plan = sum(Polygon(s["ring"][:, :2]).area for v in roofs.values() for s in v
                 if Polygon(s["ring"][:, :2]).is_valid)
print(f"true {total_true:,.0f} m² vs plan {total_plan:,.0f} m² → pitch factor {total_true / total_plan:.3f}")
assert 1.0 <= total_true / total_plan < 1.4, "pitch factor implausible: check normals and units"

by_aspect = {}
for v in roofs.values():
    for s in v:
        if s["slope_deg"] > 7:
            octant = int(((s["aspect_deg"] + 22.5) % 360) // 45)
            by_aspect[octant] = by_aspect.get(octant, 0) + s["area_m2"]
names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
print({names[k]: round(v) for k, v in sorted(by_aspect.items())})
```

The pitch factor across a district of pitched roofs should land between 1.05 and 1.25; a factor of exactly 1.000 means every surface came out horizontal, which points at a model that is really LOD1. The orientation histogram should be roughly symmetric between opposite octants — a street grid gives two dominant pairs — and a histogram concentrated in one octant means aspects were computed with the x and y arguments of `arctan2` swapped.

<figure class="diagram">
<svg viewBox="26 7 688 239" role="img" aria-labelledby="roof-asp-t roof-asp-d" xmlns="http://www.w3.org/2000/svg">
  <title id="roof-asp-t">Pitched roof area by orientation for one district</title>
  <desc id="roof-asp-d">Bars of pitched roof area by compass octant. North-east and south-west dominate with about 61 and 64 thousand square metres, reflecting a street grid, while north-west and south-east hold about 24 and 26 thousand. North and south are small. The near symmetry between opposite octants is the check that aspects were computed correctly.</desc>
  <rect class="svg-bg" x="26" y="7" width="688" height="239" fill="#ffffff"/>
  <path d="M40 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5" fill="#e3f0f4" stroke="#1f6b8a">
    <rect x="70" y="160" width="50" height="20"/>
    <rect x="150" y="48" width="50" height="132"/>
    <rect x="230" y="150" width="50" height="30"/>
    <rect x="310" y="124" width="50" height="56"/>
    <rect x="390" y="156" width="50" height="24"/>
    <rect x="470" y="42" width="50" height="138"/>
    <rect x="550" y="152" width="50" height="28"/>
    <rect x="630" y="128" width="50" height="52"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="95" y="200">N</text><text x="175" y="200">NE</text><text x="255" y="200">E</text><text x="335" y="200">SE</text>
    <text x="415" y="200">S</text><text x="495" y="200">SW</text><text x="575" y="200">W</text><text x="655" y="200">NW</text>
    <text x="175" y="40">61k</text><text x="495" y="34">64k</text><text x="335" y="116">26k</text><text x="655" y="120">24k</text>
  </g>
  <text x="370" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">pitched roof area per octant, m² — opposite octants should roughly match</text>
</svg>
<figcaption>Gable roofs contribute to two opposite octants, so a lopsided histogram is a sign of an aspect sign error rather than unusual architecture.</figcaption>
</figure>

## Performance Notes

- **Cost is linear in surfaces, not buildings.** A district of 5,000 LOD2 buildings has tens of thousands of roof surfaces and runs in seconds; a city of 500,000 buildings runs in minutes per tile and should be tiled rather than loaded whole.
- **Vectorise Newell's method** when the city is large: pad rings to equal length in an array and compute all cross products at once, which is roughly ten times faster than the per-ring loop above.
- **Skip `Solid` shells beyond the first** unless the model uses inner shells for courtyards; walking them doubles the work and yields duplicate roofs on some datasets.
- **Cache the result per source tile with the tile's checksum**, because roof extraction is deterministic and re-running it on unchanged data is pure waste.

## Common Errors

**Every roof reports a slope near 90°.** The ring was not planar, or the geometry is a wall labelled as roof. Check `z_max - z_min` against the surface's plan extent; a "roof" taller than it is wide is a wall.

**Total roof area exceeds the building footprint by a factor of two.** Surfaces were counted twice, usually because both the `Building` and its `BuildingPart` carry LOD2 geometry and both were walked. Prefer part geometry where it exists and skip the parent's, or vice versa, but never both.

**`RoofSurface` returns nothing on a file that clearly has roofs.** The geometry is `Solid` and the semantics were indexed as if it were a `MultiSurface`, so every lookup landed on the wrong entry. The nesting rules are in the topic page.

## Frequently Asked Questions

### Is LOD2 accurate enough for solar analysis?

For screening a whole city, yes — orientation and area are usually within a few percent of reality, which is far better than the assumptions a desk study would make. For sizing a specific installation, use a detailed roof survey: LOD2 has no chimneys, vents or small dormers, and shading from neighbours needs the surrounding geometry too.

### How do I add shading?

Rasterise the district's geometry into a height model and run a sun-path calculation per roof surface, or use a viewer's shadow map. Either way the roof polygons from this page are the units to accumulate irradiance onto.

### Can I get the same from LOD1?

No. An LOD1 model extrudes a footprint to a single height, so its roof is a horizontal lid and every aspect is undefined. It is fine for volume and massing, useless for orientation.

## Related Guides

- [Reading and Filtering CityJSON with cjio](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reading-and-filtering-cityjson-with-cjio/) — selecting the district first
- [Computing Building Heights and Volumes from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/computing-building-heights-and-volumes-from-cityjson/) — the other standard derived measure
- [Extracting Building Footprints from Classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/) — when there is no city model to start from

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
