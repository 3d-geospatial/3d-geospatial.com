---
title: "Cross-Pillar Failure Modes in Digital Twins"
description: "Debug boundary-contract defects across CRS, LOD, and mesh pipelines: CRS drift seams, unit mismatch, non-manifold holes, and batch-table loss, with pyproj, trimesh, numpy asserts."
---
# Cross-Pillar Failure Modes: Debugging the Boundaries Between Twin Pipelines

A digital twin is assembled by three pipelines that each hand values to the next, and the defects that are hardest to diagnose are the ones whose cause and symptom sit on opposite sides of a hand-off. A coordinate system that validates cleanly in the [fundamentals](/3d-geospatial-fundamentals-for-digital-twins/) stage produces seams once the [LOD](/lod-management-optimization-strategies/) tiler places geometry; a mesh that renders fine at full resolution tears into holes when the [processing pipeline](/point-cloud-mesh-processing-pipelines/) decimates it; an attribute table that survives filtering is dropped during tiling. This guide catalogues those boundary defects — for each one, the root cause, a way to reproduce it deterministically, and the `pyproj`, `trimesh`, or `numpy` assertion that catches it at the hand-off instead of two pipelines downstream.

## Prerequisites

Pin these versions so an assertion that passes today still means the same thing after an upgrade. The failure modes below are reproduced against exactly these libraries.

| Component | Pinned version | Role in these checks |
|-----------|----------------|----------------------|
| Python | 3.10–3.12 | Assertion harness, subprocess control |
| `pyproj` | 3.6+ | CRS round-trips, datum handling, EPSG resolution |
| `trimesh` | 4.4+ | Manifoldness, winding, watertight checks |
| `numpy` | 1.26+ | Residuals, bounds math, monotonicity walks |
| `laspy` | 2.5+ | Point-cloud header CRS and unit inspection |
| `py3dtiles` | 8.0+ | Tileset assembly and batch-table read-back |

**Input formats and CRS notes.** Source geometry arrives as glTF 2.0 / `.glb` per building, classified `.laz`/`.las` for point tiles, or `tileset.json` trees. Every dataset must declare its CRS explicitly — a projected metric system such as EPSG:32618 (UTM 18N) or EPSG:25832 (ETRS89 / UTM 32N) for the working frame, a compound code such as EPSG:32618+5703 when a vertical datum is in play, EPSG:4979 as the geographic-3D hop, and EPSG:4978 (ECEF) as the Cesium render frame. If a file does not carry a CRS, treat that as the first defect, not a detail to infer later.

## Concept

A boundary defect is a violation of an implicit contract between two pipelines. The contract is a set of values one stage guarantees and the next assumes: the CRS is a single projected metric system; the unit is metres; the surface is manifold and winding-consistent; the geometric error is measured in those metres; the attribute table's schema is intact. Each guarantee is trivially true when the producing stage is examined alone, which is exactly why these defects are missed — the producing team sees valid output and the consuming team sees a symptom that looks like their own bug.

Five contracts break most often. **CRS drift** occurs when a transform chain silently swaps a datum or mixes a geographic frame with a projected one, so adjacent tiles land on slightly different coordinates and seam. **Unit mismatch** makes every downstream metric meaningless: a `geometricError` computed in degrees, or a mesh exported in feet and assumed to be metres, produces refinement and measurement numbers that are internally consistent but physically wrong. **Non-manifold widening** turns a tolerated topological flaw into a visible hole once decimation collapses the surrounding edges. **Batch-table loss** drops per-feature attributes — asset IDs, classifications, material keys — during a simplification or tiling step, breaking every downstream analytic join. **Vertical-datum steps** appear when ellipsoidal and orthometric heights are mixed across a survey, producing a Z discontinuity at tile edges. Each has a cheap, deterministic assertion that belongs at the boundary it protects.

<figure class="diagram">
<svg viewBox="0 0 820 360" role="img" aria-labelledby="cpf-t cpf-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cpf-t">Boundary-contract checkpoints between the three twin pipelines</title>
  <desc id="cpf-d">Fundamentals hands values to LOD, which hands values to mesh and point-cloud processing. At the first hand-off a checkpoint asserts one EPSG, metric units, and a manifold surface. At the second checkpoint it asserts measured geometric error, an intact batch table, and consistent vertical datum. A failed checkpoint localises the defect to that exact hand-off.</desc>
  <defs>
    <marker id="cpf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="140" width="180" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="320" y="140" width="180" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="620" y="140" width="180" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#cpf-arrow)">
    <line x1="200" y1="180" x2="318" y2="180"/>
    <line x1="500" y1="180" x2="618" y2="180"/>
  </g>
  <g fill="#1f2937" font-size="14" text-anchor="middle">
    <text x="110" y="176"><tspan x="110" dy="0" font-weight="600">Fundamentals</tspan><tspan x="110" dy="18" font-size="12">CRS · topology</tspan></text>
    <text x="410" y="176"><tspan x="410" dy="0" font-weight="600">LOD</tspan><tspan x="410" dy="18" font-size="12">tiling · error</tspan></text>
    <text x="710" y="176"><tspan x="710" dy="0" font-weight="600">Mesh / point cloud</tspan><tspan x="710" dy="18" font-size="12">decimation</tspan></text>
  </g>
  <rect x="205" y="30" width="110" height="76" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="505" y="30" width="110" height="76" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2">
    <line x1="260" y1="106" x2="260" y2="138"/>
    <line x1="560" y1="106" x2="560" y2="138"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="260" y="52"><tspan x="260" dy="0" font-weight="600">Checkpoint A</tspan><tspan x="260" dy="15">one EPSG</tspan><tspan x="260" dy="15">metric units</tspan><tspan x="260" dy="15">manifold</tspan></text>
    <text x="560" y="52"><tspan x="560" dy="0" font-weight="600">Checkpoint B</tspan><tspan x="560" dy="15">measured error</tspan><tspan x="560" dy="15">batch table</tspan><tspan x="560" dy="15">datum</tspan></text>
  </g>
  <rect x="20" y="280" width="780" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="410" y="311" fill="#1f2937" font-size="13.5" font-weight="600" text-anchor="middle">A failed checkpoint names the hand-off — the defect is localised, not hunted across three pipelines</text>
</svg>
<figcaption>Each hand-off carries a contract. Checkpoint A guards CRS, units, and topology; checkpoint B guards the error metric, attribute schema, and vertical datum. A failing assert names the boundary that broke it.</figcaption>
</figure>

## Step-by-Step Workflow

Each step below isolates one contract: reproduce the defect, then assert it away. Run these at the boundary indicated, in ingestion code and in CI.

### 1. Catch CRS drift with a round-tripped control point

CRS drift is a transform chain that is not self-consistent — a datum swap or a lost axis order. Reproduce it by round-tripping a known point and measuring the residual; a clean chain returns sub-millimetre, a drifting one does not.

```python
import numpy as np
from pyproj import Transformer

# Control point in the source working frame: UTM 18N + NAVD88 (EPSG:32618+5703).
control = (583_000.0, 4_507_000.0, 12.0)

fwd = Transformer.from_crs("EPSG:32618+5703", "EPSG:4978", always_xy=True)  # -> ECEF
inv = Transformer.from_crs("EPSG:4978", "EPSG:32618+5703", always_xy=True)

x, y, z = fwd.transform(*control)
residual = np.linalg.norm(np.subtract(inv.transform(x, y, z), control))
assert residual < 1e-3, f"CRS chain drifts by {residual*1000:.3f} mm"
print(f"round-trip residual {residual*1000:.4f} mm")
```

The step-by-step form of this check, extended to per-tile transforms and seam detection, is in [diagnosing CRS drift causing LOD seams](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/diagnosing-crs-drift-causing-lod-seams/).

### 2. Assert the CRS is projected and metric before it reaches the tiler

A geographic CRS in degrees (EPSG:4326) makes every geometric-error and distance computation meaningless. Interrogate the CRS object directly rather than trusting a filename.

```python
from pyproj import CRS

crs = CRS.from_user_input("EPSG:32618")   # the declared working frame
axis_units = {ax.unit_name for ax in crs.axis_info}

assert crs.is_projected, f"{crs.to_epsg()} is geographic — tile in a projected metric CRS"
assert axis_units <= {"metre", "meter"}, f"non-metric axis units: {axis_units}"
print(f"working CRS EPSG:{crs.to_epsg()} is projected, units {axis_units}")
```

The reasoning behind picking such a CRS is covered in [how to choose CRS for urban digital twins](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) and the conversion mechanics in [converting WGS84 to local projected coordinates](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/).

### 3. Assert manifoldness before decimation so holes cannot widen

A non-manifold edge is a latent hole. Full-resolution rendering hides it, but QEM edge collapse during decimation removes the surrounding edges and the flaw opens into a visible gap at coarse LOD. Assert topology before the mesh crosses into the tiler.

```python
import trimesh

mesh = trimesh.load("block_0_3_12.glb", force="mesh", process=False)

assert mesh.is_winding_consistent, "inconsistent winding — normals will flip on decimation"
assert mesh.is_watertight, "non-watertight — holes will widen at coarse LOD"
# Edges shared by exactly two faces are manifold; a watertight+consistent mesh has none open.
open_edges = len(mesh.edges) - 2 * len(mesh.edges_unique)
print(f"faces {len(mesh.faces)}, watertight {mesh.is_watertight}, open edges {open_edges}")
```

When this fails, repair before tiling — the procedure is in [fixing non-manifold edges in 3D meshes](/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/), part of the broader [mesh topology basics](/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

### 4. Diff the attribute schema across the tiling hand-off

Batch-table loss is silent: geometry survives, attributes vanish. Capture the source schema before decimation and assert parity on the tiled output so a dropped key fails the build.

```python
import numpy as np

# Per-feature attributes carried alongside geometry into the tiler.
source_schema = {"feature_id": np.int64, "classification": np.uint8, "material": "U16"}

def read_back_batch_table(b3dm_batch):
    """Attribute names + dtypes recovered from the emitted tile's batch table."""
    return {name: arr.dtype.str.lstrip("<>|") for name, arr in b3dm_batch.items()}

emitted = {"feature_id": np.zeros(3, np.int64),
           "classification": np.zeros(3, np.uint8),
           "material": np.array(["brick", "glass", "steel"])}

emitted_schema = read_back_batch_table(emitted)
missing = set(source_schema) - set(emitted_schema)
assert not missing, f"batch table dropped keys across tiling: {missing}"
print(f"attribute parity held: {sorted(emitted_schema)}")
```

### 5. Assert a single consistent vertical datum

A Z step at tile seams comes from mixing ellipsoidal heights with orthometric (geoid) heights across a survey. Route every height through the geographic-3D frame so geoid separation is applied once, uniformly, and assert the declared compound CRS resolves.

```python
from pyproj import CRS, Transformer

compound = CRS.from_user_input("EPSG:32618+5703")   # UTM 18N + NAVD88 height
assert len(compound.sub_crs_list) == 2, "expected a compound horizontal+vertical CRS"

# Heights must pass through geographic-3D (EPSG:4979) so the geoid model applies.
to_geo3d = Transformer.from_crs(compound, "EPSG:4979", always_xy=True)
lon, lat, h_ellip = to_geo3d.transform(583_000.0, 4_507_000.0, 12.0)
print(f"orthometric 12.0 m -> ellipsoidal {h_ellip:.3f} m via EPSG:4979")
```

Consistent handling of these datums end to end is detailed in [handling vertical datums and geoid separation](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/).

## Validation & Verification

Bundle the five asserts into one gate that runs on every rebuild. Each check is metadata-cheap, so the whole gate costs milliseconds.

```bash
python -m pytest tests/test_boundary_contracts.py -v
```

```python
def test_boundary_contracts(dataset):
    assert dataset.crs_roundtrip_residual_mm < 1.0        # step 1
    assert dataset.working_crs.is_projected               # step 2
    assert dataset.mesh_is_watertight                     # step 3
    assert dataset.attribute_schema_parity                # step 4
    assert dataset.vertical_datum_resolved                # step 5
```

**Expected values.** A healthy dataset returns a CRS round-trip residual under 1 mm (typically well under 0.01 mm), `is_projected` True with metre axis units, watertight meshes, zero dropped attribute keys, and a compound CRS with exactly two sub-CRSs. Any deviation names the failing boundary, so the fix is routed to the pipeline that owns it rather than becoming a cross-team investigation.

## Performance & Scale

These checks are metadata operations, not geometry passes, so they scale trivially — but wiring them into a city-scale build still rewards a little care. Run the CRS and datum asserts once per dataset, not per tile; the transform chain is identical for every tile, so a single control-point round-trip covers the whole survey. Run the manifoldness and attribute checks per tile, because those are per-mesh properties, but read only the header and topology, never the full vertex buffer, when you only need the invariant. For surveys of tens of thousands of tiles, sample the manifoldness check on incremental rebuilds — assert every changed tile plus a random audit sample of the unchanged ones — and run the full sweep only on release candidates. The one check that genuinely costs geometry time, a Hausdorff distance to verify measured error, belongs in the tiling job that already loads the mesh, not in a separate validation pass that would load it twice. Memory discipline for the heaviest of these passes is covered in [fixing memory OOM in city-scale decimation](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/fixing-memory-oom-in-city-scale-decimation/).

## Failure Modes & Gotchas

**A clean round-trip residual does not prove the CRS is correct, only self-consistent.** A control point can round-trip perfectly through a chain that uses the wrong-but-internally-consistent datum, so the numbers agree while the geometry sits in the wrong place. Pair the round-trip with an absolute check: transform a surveyed control point of known ground truth and assert the result lands within tolerance of its published coordinate, not merely back on itself.

**Axis order silently corrupts transforms when `always_xy` is omitted.** pyproj honours the CRS's declared axis order, which for many geographic systems is latitude-longitude, not longitude-latitude. Forgetting `always_xy=True` swaps the two and moves geometry hundreds of kilometres while every assert that only checks self-consistency still passes. Set `always_xy=True` on every `Transformer.from_crs` and assert a known point lands where expected.

**Watertight is not the same as manifold-and-oriented.** `trimesh.is_watertight` can return True for a mesh with inconsistent winding, which decimation will still damage by flipping normals. Check `is_winding_consistent` alongside `is_watertight`; both must hold before a mesh is safe to collapse.

**Attribute parity by key name misses dtype narrowing.** A batch table can keep every key while silently narrowing a 64-bit feature ID to 32 bits or truncating a string, which corrupts joins without dropping a column. Diff dtypes, not just key sets, and assert the emitted width is at least the source width.

**Vertical-datum errors hide inside a valid horizontal CRS.** A dataset can carry a correct EPSG:32618 horizontal frame and still mix height references, because the vertical component is separate. Always declare and assert the compound code (EPSG:32618+5703) so the vertical datum is a checked value, not an assumption.

## Frequently Asked Questions

### How do I know which pipeline a seam actually comes from?
Start with the control-point round-trip. If the residual is above a millimetre the seam is a coordinate defect and belongs to the fundamentals stage; if the residual is clean, the coordinate chain is sound and you should look at LOD bounding-volume tightness and tile-edge sharing instead. This one cheap test decides which pipeline to open first and stops the common mistake of tuning the LOD runtime to compensate for a CRS bug it can never fix.

### Why does a mesh that renders perfectly develop holes only after decimation?
Full-resolution rendering tolerates non-manifold edges because the surrounding dense geometry visually fills any gap. Quadric edge collapse during decimation removes those surrounding edges, and where the topology was non-manifold there is nothing left to close the surface, so the latent flaw opens into a visible hole at coarse detail levels. Asserting watertightness and winding consistency before the mesh reaches the tiler prevents it, which is why the topology check belongs at the boundary, not after tiling.

### Can I skip the compound CRS and just use a horizontal EPSG code?
Only if your data has no meaningful heights, which is rarely true for a twin. A horizontal-only code leaves the vertical datum undeclared, so ellipsoidal and orthometric heights can be mixed without any check catching it, producing Z steps at tile seams. Declaring the compound code makes the vertical datum an asserted value and lets pyproj apply geoid separation consistently through EPSG:4979 for every tile.

### Where should these assertions live — in the pipeline or in CI?
Both. Run them inline in the ingestion and tiling code so a bad dataset fails fast at the boundary it violated, and run the same assertions as CI gates so an incremental rebuild cannot reintroduce a defect a previous fix removed. The checks are cheap metadata operations, so there is no performance reason to run them in only one place; correctness comes from running them everywhere a value crosses a boundary.

## Related Guides

- [Diagnosing CRS Drift Causing LOD Seams](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/diagnosing-crs-drift-causing-lod-seams/) — the seam defect, step by step with pyproj
- [Fixing Memory OOM in City-Scale Decimation](/digital-twin-troubleshooting-and-reliability/cross-pillar-failure-modes/fixing-memory-oom-in-city-scale-decimation/) — streaming and bounded workers for large surveys
- [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the CRS contract these checks enforce
- [Mesh Topology Basics](/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — manifoldness and the non-manifold repair path
- [Automated Mesh Decimation for Digital Twins](/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the stage that widens topological flaws if unchecked

Back to [Digital Twin Troubleshooting & Reliability](/digital-twin-troubleshooting-and-reliability/).
