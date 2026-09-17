---
title: "Auditing Meshes with Euler Characteristic and Genus"
description: "Use Euler characteristic and genus to audit twin meshes in trimesh: what the numbers mean, how to compute them per component"
---
# Auditing Meshes with Euler Characteristic and Genus

This page audits reconstructed and converted meshes with two integers — the Euler characteristic and the genus — computed per connected component with `trimesh`, and shows what each value implies about holes, tunnels, duplicated shells and non-manifold joins in building and terrain geometry.

## Why you hit this

Most mesh quality checks are thresholds: a distance, an area, an angle. The Euler characteristic is different — it is an integer that cannot drift, so it either matches the shape you expect or the mesh is not the shape you think it is. A closed building shell has χ = 2; a shell with a tunnel through it has χ = 0; a surface with three holes has χ = −1. That makes it the cheapest possible audit for a pipeline that produces thousands of meshes, and it catches the defects that survive every other check: a roof that closed into a torus, two coincident shells counted as one solid, a terrain patch with holes nobody noticed. The topology rules it rests on are in [mesh topology basics for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

## Prerequisites

- Python 3.10+ with `trimesh>=4.0`, `numpy>=1.24`, `networkx>=3.0` (trimesh uses it for graph operations).
- Meshes in a metric CRS — EPSG:32633 in the examples — from reconstruction, CityJSON conversion or BIM export.
- An expectation of what each mesh *should* be: a closed solid, an open height field, or a set of disconnected parts. Without that, the numbers have nothing to be compared against.

## The Two Numbers

The Euler characteristic of a mesh is `χ = V − E + F`: vertices minus edges plus faces. For a closed, connected, orientable surface it depends only on the shape's topology, not on how finely it is triangulated — decimating a cube from a million triangles to twelve leaves χ unchanged at 2.

The genus follows from it for a closed surface: `g = (2 − χ) / 2`, the number of "handles" or tunnels. A sphere or a cube has genus 0. A torus, or a building with a through-passage, has genus 1. A block of flats with three archways through it has genus 3.

For a surface *with boundary* — an open terrain patch, a facade without a base — the relation includes the number of boundary loops: `χ = 2 − 2g − b`, where `b` counts the loops. That is what makes the number diagnostic: a terrain patch that should be a disc has χ = 1, and χ = −2 means three unexpected holes.

<figure class="diagram">
<svg viewBox="26 26 729 226" role="img" aria-labelledby="euler-shapes-t euler-shapes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="euler-shapes-t">Euler characteristic for the shapes a twin produces</title>
  <desc id="euler-shapes-d">Four shapes with their values. A closed building shell is a sphere topologically, with Euler characteristic two and genus zero. A building with an archway is a torus, with characteristic zero and genus one. An open terrain patch is a disc, with characteristic one and one boundary loop. A terrain patch with two holes has characteristic minus one and three boundary loops.</desc>
  <rect class="svg-bg" x="26" y="26" width="729" height="226" fill="#ffffff"/>
  <path d="M40 150 H190 V70 L115 40 L40 70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M230 150 H380 V70 L305 40 L230 70 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M275 150 V110 h60 v40" fill="#ffffff" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M420 90 C470 60 540 60 580 90 C560 140 460 140 420 90 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M620 90 C670 60 740 60 740 90 C720 140 640 140 620 90 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <ellipse cx="660" cy="98" rx="14" ry="9" fill="#ffffff" stroke="#4f7a4d" stroke-width="2"/>
  <ellipse cx="704" cy="106" rx="11" ry="7" fill="#ffffff" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="115" y="180">closed shell</text><text x="115" y="200">χ = 2, g = 0</text>
    <text x="305" y="180">shell with an archway</text><text x="305" y="200">χ = 0, g = 1</text>
    <text x="500" y="180">terrain patch</text><text x="500" y="200">χ = 1, b = 1</text>
    <text x="680" y="180">patch with two holes</text><text x="680" y="200">χ = −1, b = 3</text>
  </g>
  <text x="380" y="234" fill="#15384a" font-size="12.5" text-anchor="middle">Triangle count does not appear anywhere: these are properties of the shape, not the tessellation.</text>
</svg>
<figcaption>Four expectations, four integers. An audit compares the computed value with the expected one and needs no tolerance.</figcaption>
</figure>

## Step-by-Step

### 1. Compute the numbers per component

```python
import numpy as np
import trimesh

def topology_report(path, min_faces=8):
    mesh = trimesh.load(path, force="mesh", process=False)
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()

    rows = []
    for i, part in enumerate(mesh.split(only_watertight=False)):
        if len(part.faces) < min_faces:
            continue
        boundary = trimesh.grouping.group_rows(part.edges_sorted, require_count=1)
        loops = len(part.outline().entities) if len(boundary) else 0
        chi = part.euler_number
        closed = part.is_watertight
        genus = (2 - chi) // 2 if closed else (2 - chi - loops) // 2
        rows.append({
            "component": i,
            "faces": len(part.faces),
            "vertices": len(part.vertices),
            "euler": int(chi),
            "watertight": bool(closed),
            "boundary_loops": loops,
            "genus": int(genus),
            "volume_m3": round(float(part.volume), 2) if part.is_volume else None,
        })
    return mesh, rows

mesh, rows = topology_report("meshes/block_07.ply")
for r in rows[:8]:
    print(r)
print(f"{len(rows)} components, {len(mesh.faces):,} faces total")
```

Splitting into components first is essential. The Euler characteristic of a mesh with several disconnected parts is the sum of the parts' values, so a file containing twelve closed buildings reports χ = 24, which is meaningless as a shape statement and easy to misread as a defect. Per component, each number describes one object.

`merge_vertices` runs before anything else for the reason given in the parent guide: an unmerged mesh has every edge as a boundary edge, and its Euler characteristic counts a face soup rather than a surface.

### 2. Compare against expectations

```python
EXPECTED = {
    "building": {"watertight": True, "genus": 0, "euler": 2},
    "building_with_passage": {"watertight": True, "genus": 1, "euler": 0},
    "terrain_patch": {"watertight": False, "genus": 0, "boundary_loops": 1, "euler": 1},
}

def audit(rows, kind, min_volume=20.0):
    spec = EXPECTED[kind]
    findings = []
    for r in rows:
        for key, want in spec.items():
            got = r.get(key)
            if got != want:
                findings.append((r["component"], key, want, got))
        if spec["watertight"] and r["volume_m3"] is not None and r["volume_m3"] < min_volume:
            findings.append((r["component"], "volume_m3", f">{min_volume}", r["volume_m3"]))
    return findings

for comp, key, want, got in audit(rows, "building")[:10]:
    print(f"component {comp}: {key} expected {want}, got {got}")
```

The audit is a table lookup. That is the appeal: adding a new mesh kind means adding a row, and the check has no thresholds to tune, no sampling and no tolerance drift.

### 3. Read what each mismatch means

| Observed | Expected `building` | Likely cause |
|---|---|---|
| χ = 2, watertight | — | correct |
| χ = 0, watertight | χ = 2 | a tunnel: a courtyard closed over, or two walls fused |
| χ = −2, watertight | χ = 2 | two tunnels, often an arcade |
| χ = 1, one loop | χ = 2 | open at the base: no ground surface |
| χ = 4, watertight | χ = 2 | two coincident shells counted as one component |
| χ large and odd | χ = 2 | non-manifold edges; the surface is not orientable |
| genus > 0 on terrain | genus 0 | a hole bridged into a tunnel by reconstruction |

The two-shells case is worth dwelling on, because it is the one that silently doubles volumes. A model exported with both an outer and an inner wall surface, coincident or a few centimetres apart, has χ = 4 and passes every watertightness test; its volume is the sum of two enclosed regions and its surface area is double. Only the topology number gives it away cheaply.

<figure class="diagram">
<svg viewBox="16 56 718 204" role="img" aria-labelledby="euler-diag-t euler-diag-d" xmlns="http://www.w3.org/2000/svg">
  <title id="euler-diag-t">Three defects and the value each produces</title>
  <desc id="euler-diag-d">Three cross-sections. A courtyard whose roof closed over becomes a tunnel with Euler characteristic zero. A shell open at its base has characteristic one and one boundary loop. Two coincident shells give characteristic four and a doubled volume, while still passing a watertightness test.</desc>
  <rect class="svg-bg" x="16" y="56" width="718" height="204" fill="#ffffff"/>
  <path d="M30 170 H230 V70 H30 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M90 170 V110 h80 v60" fill="#ffffff" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M90 110 H170" fill="none" stroke="#b0413e" stroke-width="3"/>
  <text x="130" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">courtyard roofed over</text>
  <text x="130" y="220" fill="#b0413e" font-size="12.5" text-anchor="middle">χ = 0 — a tunnel</text>
  <path d="M290 70 H490 V170 M290 70 V170" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <text x="390" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">no ground surface</text>
  <text x="390" y="220" fill="#9a4f26" font-size="12.5" text-anchor="middle">χ = 1, one boundary loop</text>
  <path d="M560 170 H720 V70 H560 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M572 162 H708 V80 H572 Z" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="5 4"/>
  <text x="640" y="200" fill="#1f2937" font-size="12.5" text-anchor="middle">two coincident shells</text>
  <text x="640" y="220" fill="#b0413e" font-size="12.5" text-anchor="middle">χ = 4, volume doubled</text>
  <text x="380" y="242" fill="#15384a" font-size="12" text-anchor="middle">All three are watertight; only the characteristic distinguishes them.</text>
</svg>
<figcaption>Watertightness is necessary and not sufficient. The characteristic separates a valid solid from a topologically wrong one.</figcaption>
</figure>

### 4. Locate the defect the number found

An integer says something is wrong; finding where takes one more step.

```python
def locate_handles(part, max_report=5):
    """Candidate tunnels: pairs of nearby faces whose normals oppose across a thin gap."""
    if part.euler_number >= 2:
        return []
    centres = part.triangles_center
    normals = part.face_normals
    tree = trimesh.proximity.ProximityQuery(part)
    hits = []
    for i in np.random.default_rng(5).choice(len(centres), min(4000, len(centres)), replace=False):
        p = centres[i] - normals[i] * 0.02              # step just inside the surface
        d = tree.signed_distance([p])[0]
        if d > 0 and d < 0.4:                            # thin solid: a wall between two voids
            hits.append((float(d), centres[i].tolist()))
    hits.sort()
    return hits[:max_report]

def locate_boundaries(part, max_report=5):
    loops = part.outline().entities
    out = []
    for e in loops[:max_report]:
        pts = part.outline().vertices[e.points]
        out.append({"length_m": round(float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()), 2),
                    "centre": [round(float(v), 2) for v in pts.mean(axis=0)]})
    return sorted(out, key=lambda d: -d["length_m"])

part = mesh.split(only_watertight=False)[0]
print("thin-wall candidates:", locate_handles(part))
print("boundary loops:", locate_boundaries(part))
```

Reporting the coordinates is what makes the audit actionable. A modeller given "component 7 has genus 1" shrugs; given "component 7 has genus 1, and there is a 12 cm thin wall at 412688, 5335904, 18.4" they can open that spot and see the courtyard that closed over.

<figure class="diagram">
<svg viewBox="46 5 668 239" role="img" aria-labelledby="euler-inv-t euler-inv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="euler-inv-t">Triangle count falls, the characteristic does not move</title>
  <desc id="euler-inv-d">A building shell is decimated in three steps from 18,402 faces to 1,840. The triangle count falls by ninety percent while the Euler characteristic stays at two at every step. In a fourth step an over-aggressive decimation collapses a courtyard and the characteristic drops to zero, which is how the audit detects that the topology changed.</desc>
  <rect class="svg-bg" x="46" y="5" width="668" height="239" fill="#ffffff"/>
  <path d="M60 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5" fill="#e3f0f4" stroke="#1f6b8a">
    <rect x="90" y="40" width="70" height="140"/>
    <rect x="240" y="96" width="70" height="84"/>
    <rect x="390" y="130" width="70" height="50"/>
    <rect x="540" y="152" width="70" height="28"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="125" y="200">18,402</text><text x="275" y="200">6,120</text>
    <text x="425" y="200">1,840</text><text x="575" y="200">620</text>
    <text x="125" y="32">χ = 2</text><text x="275" y="88">χ = 2</text><text x="425" y="122">χ = 2</text>
  </g>
  <text x="575" y="144" fill="#b0413e" font-size="12.5" text-anchor="middle">χ = 0</text>
  <text x="660" y="120" fill="#b0413e" font-size="12" text-anchor="middle">courtyard</text>
  <text x="660" y="136" fill="#b0413e" font-size="12" text-anchor="middle">collapsed</text>
  <text x="380" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">faces per level — the audit compares χ before and after every simplification step</text>
</svg>
<figcaption>Invariance under decimation is what makes the characteristic a regression test for the whole simplification stage.</figcaption>
</figure>

### 5. Gate a pipeline on it

```python
import sys
from pathlib import Path

def gate_meshes(folder, kind="building"):
    failures = {}
    for p in sorted(Path(folder).glob("*.ply")):
        _, rows = topology_report(p)
        bad = audit(rows, kind)
        if bad:
            failures[p.name] = bad
    for name, bad in failures.items():
        print(f"FAIL {name}: " + "; ".join(f"c{c} {k} {w}≠{g}" for c, k, w, g in bad[:4]))
    print(f"{len(failures)} of {len(list(Path(folder).glob('*.ply')))} meshes failed the topology audit")
    return 1 if failures else 0

sys.exit(gate_meshes("meshes/block_07_parts"))
```

## Expected Output & Verification

```text
{'component': 0, 'faces': 18402, 'vertices': 9204, 'euler': 2, 'watertight': True, 'boundary_loops': 0, 'genus': 0, 'volume_m3': 14208.42}
{'component': 1, 'faces': 12044, 'vertices': 6026, 'euler': 0, 'watertight': True, 'boundary_loops': 0, 'genus': 1, 'volume_m3': 8104.19}
{'component': 2, 'faces': 9120, 'vertices': 4568, 'euler': 1, 'watertight': False, 'boundary_loops': 1, 'genus': 0, 'volume_m3': None}
12 components, 184,204 faces total
component 1: euler expected 2, got 0
component 1: genus expected 0, got 1
component 2: watertight expected True, got False
component 2: euler expected 2, got 1
thin-wall candidates: [(0.118, [412688.4, 5335904.1, 18.42])]
boundary loops: [{'length_m': 84.6, 'centre': [412701.2, 5335888.4, 8.1]}]
```

Verify the computation against shapes whose answers are known, which takes four lines and protects the audit from a library change:

```python
import trimesh

CASES = {
    "box": (trimesh.creation.box(extents=(4, 6, 3)), 2, 0),
    "torus": (trimesh.creation.torus(major_radius=3.0, minor_radius=1.0), 0, 1),
    "sphere": (trimesh.creation.icosphere(subdivisions=3), 2, 0),
}
for name, (m, chi, g) in CASES.items():
    m.merge_vertices()
    got_chi = int(m.euler_number)
    got_g = (2 - got_chi) // 2
    assert (got_chi, got_g) == (chi, g), f"{name}: expected χ={chi} g={g}, got χ={got_chi} g={got_g}"
print("Euler computation verified on box, torus and sphere")
```

Then verify invariance, which is the property that makes the number trustworthy: decimate a mesh by 90% and confirm the characteristic is unchanged. If it moves, the decimator has changed the topology — collapsed a tunnel, or opened a hole — which is itself a finding worth having.

## Performance Notes

- **The computation is linear and trivially cheap**: vertices, edges and faces are already known to trimesh, so a city of thousands of meshes audits in seconds.
- **Component splitting dominates.** `split` builds an adjacency graph; on a mesh of millions of faces it takes a few seconds and can be skipped when the file is known to hold one object.
- **Run the audit before decimation and after**, and compare. Two integers per mesh is a cheap regression test for the whole simplification stage.
- **Cache per file hash.** Topology is deterministic, so a mesh whose bytes have not changed does not need re-auditing.
- **Locating defects is the expensive part** — proximity queries on a sampled subset — so run it only for components that failed.

## Common Errors

**Every component reports a huge Euler characteristic.** Vertices were not merged, so the "mesh" is a face soup: V and F are both three times the face count and E has no shared edges.

**A correct terrain patch reports χ = 1 and the audit expects 2.** The expectation is wrong, not the mesh. Open surfaces have `χ = 2 − 2g − b`; a disc is 1.

**Genus comes out negative.** The formula was applied to a non-orientable or non-manifold mesh, where the relation does not hold. Repair non-manifold edges first, as in [fixing non-manifold edges in 3D meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/).

**The number is right and the mesh is still wrong.** Topology says nothing about geometry: a building with its roof at ground level and its floor in the air has χ = 2. The audit is one check among several, not a substitute for the geometric ones.

## Frequently Asked Questions

### Is a genus above zero ever correct?

Yes. Buildings with archways, bridges, and terrain with natural arches all have genuine handles. That is exactly why the audit compares against an expectation per mesh kind rather than demanding genus 0 everywhere.

### Does this catch self-intersections?

No. A self-intersecting surface can be perfectly closed and have χ = 2. Self-intersections need the separate check in [detecting and repairing self-intersecting geometry](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/detecting-and-repairing-self-intersecting-geometry/).

### Should an audit fail the build, or warn?

Fail for meshes with a declared expectation — building shells that must be solids for volume work. Warn for reconstructed surfaces whose topology is inherently uncertain, and record the distribution so a change in it is visible.

## Related Guides

- [Fixing Non-Manifold Edges in 3D Meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/) — the defect that invalidates the formula
- [Making Meshes Watertight for Volume Calculations](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/making-meshes-watertight-for-volume-calculations/) — what a valid χ = 2 lets you compute
- [Welding Vertices and Removing Duplicate Faces](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/welding-vertices-and-removing-duplicate-faces/) — the cleanup that has to come first

Back to [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).
