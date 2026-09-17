# IFC vs CityGML for Building Twins

This page compares IFC and CityGML for representing buildings in a digital twin — what each standard models, how their notions of detail differ, how each handles georeferencing and attributes, what a conversion between them loses, and why a mature twin usually keeps both rather than choosing, with coordinates in EPSG:25832+7837.

## Why you hit this

Both standards describe buildings, both are ISO-published, both come out of buildingSMART-adjacent or OGC processes, and a twin programme is routinely handed one of each for the same city block: an IFC model from the contractor who built the hospital, and a CityGML tile from the state survey that contains the same hospital as an LOD2 shell. Treating them as interchangeable produces the familiar mess — a twin with two hospitals a metre apart, one with 400,000 components and no CRS, the other with six surfaces and a register key. The formats' delivery characteristics are compared in [3D format standards comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/); this page is about the models behind them.

## Prerequisites

- Python 3.10+ with `ifcopenshell>=0.8`, `numpy>=1.24`, and `cjio>=0.9` plus `citygml-tools` for the CityGML side.
- One IFC4 model and one CityGML/CityJSON tile covering the same building, for the comparison at the end.
- The twin's target CRS as a compound code.

## What Each Standard Models

**IFC describes a building as a construction project.** Its subject is the components: every wall, slab, beam, duct, valve and door, with their materials, types, relationships and the spaces they bound. Geometry is usually a solid model built from extrusions and boolean operations, authored in a local engineering frame in millimetres. The schema is enormous because construction is, and the useful consequence is that an IFC model can answer "what is this wall made of and which space is behind it".

**CityGML describes a city as a set of georeferenced features.** Its subject is the objects a city administers: buildings, building parts, roads, vegetation, water, bridges, tunnels, city furniture — each with a semantic type, an identifier that ties it to a register, and boundary surfaces labelled as roof, wall or ground. Geometry is boundary representation at a declared level of detail, in a real CRS. It can answer "which buildings are in this district, how tall are they and which register entry does each one correspond to".

The distinction that matters in practice is not detail but *subject*. IFC models one building thoroughly as an artefact; CityGML models many buildings shallowly as city objects. A twin needs both kinds of answer.

<figure class="diagram">
<svg viewBox="6 6 748 268" role="img" aria-labelledby="ivc-model-t ivc-model-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ivc-model-t">The same hospital in each model</title>
  <desc id="ivc-model-d">On the left, the IFC model decomposes the building into storeys, spaces and thousands of components with materials and systems, in a local millimetre frame. On the right, the CityGML model has one building with a few boundary surfaces labelled roof, wall and ground, an address, a register identifier and a real coordinate reference system.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="268" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="240" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="240" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.2">
    <rect x="50" y="70" width="280" height="26"/>
    <rect x="70" y="104" width="240" height="22"/>
    <rect x="90" y="134" width="200" height="22"/>
    <rect x="110" y="164" width="160" height="22"/>
    <rect x="130" y="194" width="120" height="22"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="190" y="87">IfcProject</text>
    <text x="190" y="119">IfcBuilding → IfcBuildingStorey</text>
    <text x="190" y="149">IfcSpace, IfcWall, IfcSlab…</text>
    <text x="190" y="179">materials, types, systems</text>
    <text x="190" y="209">400,000 entities</text>
  </g>
  <text x="190" y="46" fill="#1f2937" font-size="12.5" text-anchor="middle">IFC: one building as a construction artefact</text>
  <text x="190" y="240" fill="#9a4f26" font-size="12" text-anchor="middle">local frame, millimetres, no CRS by default</text>
  <path d="M470 200 H670 V120 L570 80 L470 120 Z" fill="#ffffff" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="570" y="112">RoofSurface</text>
    <text x="500" y="165">Wall</text>
    <text x="640" y="165">Wall</text>
    <text x="570" y="215">GroundSurface</text>
  </g>
  <text x="570" y="46" fill="#1f2937" font-size="12.5" text-anchor="middle">CityGML: one of thousands of city objects</text>
  <text x="570" y="240" fill="#1f6b8a" font-size="12" text-anchor="middle">EPSG:25832+7837, register id, address</text>
</svg>
<figcaption>Neither is a subset of the other: IFC has components CityGML cannot express, CityGML has city context and georeferencing IFC lacks.</figcaption>
</figure>

## Levels of Detail Are Not Comparable

CityGML's LOD is a statement about *geometric abstraction* of the exterior and, at LOD4 in version 2.0, the interior. IFC has no LOD; its detail follows the discipline model and the project stage, so an "LOD" comparison between the two is a category error that appears in half the procurement documents in the field.

| Question | CityGML | IFC |
|---|---|---|
| Building footprint | LOD0 | derived from the geometry |
| Extruded block | LOD1 | not a concept |
| Roof shapes | LOD2 | derived from roof elements |
| Windows, doors, facade detail | LOD3 | native, as components |
| Rooms and interior | LOD4 (2.0) | native, `IfcSpace` |
| Ducts, valves, cable trays | not expressible | native |
| Material of a specific wall layer | not expressible | native |
| Register identifier and address | native | usually absent |
| Coordinate reference system | native | optional, often missing |

The practical reading is that a twin needing façade and interior detail for one building wants IFC, and a twin needing consistent city-wide geometry with register links wants CityGML. Asking for "CityGML LOD3 converted from IFC" is possible and throws away most of what the IFC was for.

## Georeferencing

CityGML carries its CRS as a document-level declaration, and every coordinate is in it. IFC places geometry in a local frame and connects it to the world with `IfcMapConversion` — when the exporter wrote one, which is far from guaranteed. This asymmetry is the single largest source of misplacement in twin ingestion and is covered in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).

```python
import ifcopenshell
import json
from pathlib import Path

def georeferencing_status(ifc_path, cityjson_path):
    model = ifcopenshell.open(ifc_path)
    has_conversion = bool(model.schema != "IFC2X3" and model.by_type("IfcMapConversion"))
    cj = json.loads(Path(cityjson_path).read_text())
    return {
        "ifc_schema": model.schema,
        "ifc_map_conversion": has_conversion,
        "ifc_units": model.by_type("IfcUnitAssignment")[0].Units[0].is_a() if model.by_type("IfcUnitAssignment") else None,
        "citygml_crs": cj.get("metadata", {}).get("referenceSystem"),
        "citygml_objects": len(cj["CityObjects"]),
    }

print(georeferencing_status("hospital.ifc", "district_lod2.city.json"))
```

## Attributes and Identity

CityGML objects carry a `gml:id` and, in national profiles, the register key that makes a twin joinable to everything else a city knows — ownership, permits, energy certificates, addresses. IFC entities carry a GUID that is stable across revisions of the *model* and means nothing outside it. Neither is a substitute for the other, and a twin that ingests IFC without mapping its building to a register identifier has a beautiful model that no administrative query can reach.

```python
def building_identity(ifc_path):
    model = ifcopenshell.open(ifc_path)
    b = model.by_type("IfcBuilding")[0]
    psets = {}
    for rel in getattr(b, "IsDefinedBy", ()) or ():
        if rel.is_a("IfcRelDefinesByProperties"):
            ps = rel.RelatingPropertyDefinition
            if ps.is_a("IfcPropertySet"):
                psets[ps.Name] = {p.Name: getattr(p, "NominalValue", None) for p in ps.HasProperties}
    return {"guid": b.GlobalId, "name": b.Name, "property_sets": sorted(psets)}

print(building_identity("hospital.ifc"))
```

The GUID goes into the twin as provenance; the register key has to come from somewhere else — a property set the project agreed to populate, or a spatial join against the cadastre.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="ivc-choose-t ivc-choose-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ivc-choose-t">Which standard answers which question</title>
  <desc id="ivc-choose-d">A table of twin questions against the standard that answers them. City-wide geometry, register joins and district analysis go to CityGML. Component inventories, materials, spaces and systems go to IFC. Facade detail for one building can come from either. Nothing about a city's other objects can come from IFC.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="400" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="20" width="160" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="580" y="20" width="160" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="400" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="420" y="56" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="580" y="56" width="160" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="90" width="400" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="420" y="90" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="580" y="90" width="160" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="124" width="400" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="420" y="124" width="160" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="580" y="124" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="158" width="400" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="420" y="158" width="160" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="580" y="158" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="192" width="400" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="420" y="192" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="580" y="192" width="160" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="220" y="43">question</text>
    <text x="500" y="43">CityGML</text>
    <text x="660" y="43">IFC</text>
    <text x="220" y="78">how tall are the buildings in this district?</text><text x="500" y="78">yes</text><text x="660" y="78">no</text>
    <text x="220" y="112">which register entry is this building?</text><text x="500" y="112">yes</text><text x="660" y="112">no</text>
    <text x="220" y="146">what is this wall made of?</text><text x="500" y="146">no</text><text x="660" y="146">yes</text>
    <text x="220" y="180">which room is behind this door?</text><text x="500" y="180">no</text><text x="660" y="180">yes</text>
    <text x="220" y="214">what does the facade look like?</text><text x="500" y="214">LOD3</text><text x="660" y="214">yes</text>
  </g>
</svg>
<figcaption>Only one row can be answered by both, which is why the choice is usually "both, for different purposes" rather than one or the other.</figcaption>
</figure>

## Converting Between Them

Conversion is possible in both directions and lossy in both. **IFC to CityGML** is the common one: geometry is triangulated, classified into roof, wall and ground by normal orientation, and collapsed into an LOD2 or LOD3 shell, discarding components, materials and systems. **CityGML to IFC** is rarer and produces a shell with no construction meaning — a "building" made of surfaces that no discipline model recognises.

```python
import numpy as np
import ifcopenshell.geom

def ifc_to_boundary_surfaces(ifc_path, up_threshold=0.85, down_threshold=-0.85):
    """Classify IFC triangles into roof / wall / ground the way an LOD2 conversion does."""
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    model = ifcopenshell.open(ifc_path)
    counts = {"roof": 0, "wall": 0, "ground": 0}
    area = {"roof": 0.0, "wall": 0.0, "ground": 0.0}

    it = ifcopenshell.geom.iterator(settings, model, include=model.by_type("IfcWall")
                                    + model.by_type("IfcSlab") + model.by_type("IfcRoof"))
    if it.initialize():
        while True:
            shape = it.get()
            v = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
            f = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
            tri = v[f]
            n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
            a = 0.5 * np.linalg.norm(n, axis=1)
            nz = np.divide(n[:, 2], np.linalg.norm(n, axis=1), out=np.zeros(len(n)), where=a > 0)
            for label, mask in (("roof", nz > up_threshold), ("ground", nz < down_threshold),
                                ("wall", np.abs(nz) <= up_threshold)):
                counts[label] += int(mask.sum())
                area[label] += float(a[mask].sum())
            if not it.next():
                break
    return counts, {k: round(v, 1) for k, v in area.items()}

counts, area = ifc_to_boundary_surfaces("hospital.ifc")
print(counts, area)
```

<figure class="diagram">
<svg viewBox="6 10 748 240" role="img" aria-labelledby="ivc-loss-t ivc-loss-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ivc-loss-t">What survives a conversion in each direction</title>
  <desc id="ivc-loss-d">Converting IFC to CityGML keeps the exterior geometry, classified into roof, wall and ground surfaces, and a single building object with its identifier; it discards components, materials, spaces and systems. Converting CityGML to IFC keeps the shell as surfaces and produces no components, no materials and no spaces, so the result has no construction meaning.</desc>
  <rect class="svg-bg" x="6" y="10" width="748" height="240" fill="#ffffff"/>
  <defs>
    <marker id="ivc-loss-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="200" height="86" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="540" y="30" width="200" height="86" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="270" y="24" width="220" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="270" y="78" width="220" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="270" y="150" width="220" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ivc-loss-arrow)">
    <path d="M220 60 H268"/>
    <path d="M490 46 H538"/>
    <path d="M540 100 H492" />
    <path d="M268 172 H222" />
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="62">IFC</text>
    <text x="120" y="84">components, materials,</text>
    <text x="120" y="104">spaces, systems</text>
    <text x="640" y="62">CityGML</text>
    <text x="640" y="84">boundary surfaces,</text>
    <text x="640" y="104">identifier, CRS</text>
    <text x="380" y="52">kept: exterior shell, roof/wall/ground</text>
    <text x="380" y="106">lost: components, materials, spaces</text>
    <text x="380" y="168">the reverse direction produces</text>
    <text x="380" y="186">no components at all</text>
  </g>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Only the top path is worth automating, and only as a derived product.</text>
</svg>
<figcaption>The conversion is asymmetric: one direction abstracts, the other invents nothing and keeps a name.</figcaption>
</figure>

The normal-threshold classification is exactly what automated IFC-to-CityGML tools do, and its failure modes are worth knowing: a flat roof with a parapet contributes wall area above the roof plane, a sloped glazed atrium is classified as roof, and an overhang produces ground-facing triangles that are not ground. Any conversion needs a review of the classified areas against expectations, which is what the numbers above are for.

## Expected Output & Verification

```text
{'ifc_schema': 'IFC4', 'ifc_map_conversion': True, 'ifc_units': 'IfcSIUnit',
 'citygml_crs': 'https://www.opengis.net/def/crs/EPSG/0/25832', 'citygml_objects': 4812}
{'guid': '1hqB2xJ$H8QBrGz0Kk1vLt', 'name': 'Klinikum Nord Haus C', 'property_sets': ['Pset_BuildingCommon']}
{'roof': 18402, 'wall': 214880, 'ground': 9204} {'roof': 4821.4, 'wall': 18204.9, 'ground': 4788.2}
```

Verify the two representations describe the same building before using either as ground truth. The cheapest check is footprint agreement:

```python
from shapely.geometry import MultiPoint
from shapely.ops import unary_union

def footprint_agreement(ifc_world_xy, citygml_ground_xy):
    a = MultiPoint(list(map(tuple, ifc_world_xy))).convex_hull
    b = MultiPoint(list(map(tuple, citygml_ground_xy))).convex_hull
    inter, union = a.intersection(b).area, unary_union([a, b]).area
    return {"ifc_area": round(a.area, 1), "citygml_area": round(b.area, 1),
            "iou": round(inter / union, 3) if union else None}

print(footprint_agreement(ifc_xy, cj_ground_xy))
```

An intersection-over-union above about 0.9 means the two agree on where the building is, and the differences are detail. Below 0.7 means one of them is misplaced — almost always the IFC, via its map conversion — and the twin should not ingest either until that is resolved. A roof area from IFC that differs from the CityGML roof area by more than about 15% usually means the IFC includes canopies or plant enclosures the LOD2 shell does not.

## Common Errors

**Treating CityGML LOD4 as equivalent to an IFC model.** LOD4 adds interior *geometry*; it does not add components, materials or systems. A room in LOD4 is a volume, not a space with a function, a fire rating and an air handling unit.

**Converting IFC to CityGML to "simplify" and then discarding the IFC.** The conversion is one-way. Keep the IFC as the source for component questions, and treat the CityGML shell as a derived product for city-scale work.

**Assuming an IFC model is in metres.** Millimetres are the norm. The unit assignment has to be read, as in [reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/).

**Joining IFC to the register by name.** Building names are free text and change between revisions. Join by a register key populated in a property set, or spatially, and record which was used.

## Frequently Asked Questions

### Which one should a city ask for in a handover?

Both, for different reasons: IFC as the record of what was built, CityGML or CityJSON as the city-scale representation the twin serves. Specifying the georeferencing requirements for the IFC — a populated `IfcMapConversion` with a compound CRS — is the single most valuable clause in the handover specification.

### Is IFC4X3 changing this?

It extends IFC towards infrastructure — alignments, roads, rail — which overlaps territory CityGML also covers. The underlying difference in subject remains: IFC models the asset as constructed, CityGML models the city's inventory.

### What about delivering the twin itself?

Neither. Both are exchange and archival formats, too heavy for a browser. The twin's delivery format is 3D Tiles or similar, generated from whichever source is authoritative for that layer — see [CityGML vs 3D Tiles for municipal twin delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/).

## Related Guides

- [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/) — placing the IFC side correctly
- [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/) — working with the CityGML side
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — the delivery question

Back to [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
