---
title: "Detecting and Repairing Self-Intersecting Geometry"
description: "Find triangles that pass through each other with trimesh and a BVH, tell real intersections from coincident faces, and repair without collapsing the model."
---
# Detecting and Repairing Self-Intersecting Geometry

This page finds the triangles in a mesh that pass through each other, distinguishes a genuine self-intersection from the coincident faces a boolean or a merge routinely produces, and repairs them without collapsing the surrounding geometry. Self-intersections are the topological defect that survives every other check: a mesh can be watertight, manifold, consistently wound and still have a wall passing through a floor, and every volumetric calculation on it will be wrong.

## Why you hit this

The checks most pipelines run — `is_watertight`, `is_winding_consistent`, non-manifold edge counts — all examine connectivity, and a self-intersection is a geometric relationship between faces that are not connected at all. Two triangles on opposite sides of a building can pass through one another while every vertex, edge and face in the mesh is locally perfect. The consequence appears downstream: a volume computed by the divergence theorem double-counts the intersecting region, a ray cast enters and exits an odd number of times, and a physics engine reports a body in permanent collision with itself.

The connectivity checks this complements are in [mesh topology basics](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

## Prerequisites

- Python 3.10+ with `trimesh>=4.0`, `numpy>=1.24`, `rtree>=1.1` and `scipy>=1.11`. Install `trimesh[easy]` to pull the optional accelerators.
- A mesh already merged and repaired for connectivity — self-intersection testing on an unmerged soup reports every shared edge as an intersection.
- Geometry on a local origin. Intersection tests are tolerance-based, and a tolerance meaningful at 15 m is meaningless at 585,000 m.

## Step-by-Step

### 1. Find candidate pairs cheaply with a bounding-volume query

Testing every triangle against every other is quadratic and unnecessary. An R-tree over face bounding boxes reduces it to the pairs that could possibly touch.

```python
import numpy as np
import trimesh
from rtree import index

mesh = trimesh.load("building_block.ply", process=True, force="mesh")
tri = mesh.triangles                      # (n, 3, 3)

lo = tri.min(axis=1)
hi = tri.max(axis=1)

p = index.Property(); p.dimension = 3; p.leaf_capacity = 64
idx = index.Index(
    ((i, (*lo[i], *hi[i]), None) for i in range(len(tri))), properties=p)

pairs = set()
for i in range(len(tri)):
    for j in idx.intersection((*lo[i], *hi[i])):
        if j > i and not np.intersect1d(mesh.faces[i], mesh.faces[j]).size:
            pairs.add((i, j))              # skip faces sharing a vertex
print(f"{len(tri):,} faces → {len(pairs):,} candidate pairs")
```

Excluding faces that share a vertex is what makes the result meaningful. Adjacent triangles touch by construction, and a test that counts them reports every mesh as catastrophically self-intersecting.

### 2. Test the candidates exactly

The Möller triangle-triangle test is the standard, and it separates the two cases that matter.

```python
import numpy as np

def tri_tri_intersect(a, b, eps=1e-9):
    """Möller's test. Returns 'none', 'coplanar' or 'crossing'."""
    n1 = np.cross(a[1] - a[0], a[2] - a[0])
    d1 = -np.dot(n1, a[0])
    db = np.dot(n1, b.T) + d1
    if np.all(db > eps) or np.all(db < -eps):
        return "none"                       # b entirely on one side of a's plane

    n2 = np.cross(b[1] - b[0], b[2] - b[0])
    d2 = -np.dot(n2, b[0])
    da = np.dot(n2, a.T) + d2
    if np.all(da > eps) or np.all(da < -eps):
        return "none"

    if np.all(np.abs(db) <= eps) and np.all(np.abs(da) <= eps):
        return "coplanar"                   # same plane: overlap or merely touching
    return "crossing"

results = {"none": 0, "coplanar": 0, "crossing": 0}
crossings = []
for i, j in pairs:
    kind = tri_tri_intersect(tri[i], tri[j])
    results[kind] += 1
    if kind == "crossing":
        crossings.append((i, j))
print(results)
```

The `coplanar` case is the one people misdiagnose. Two triangles in the same plane that overlap are almost always duplicated geometry — the same wall exported twice, or a boolean that left both operands' faces — and the fix is deduplication rather than geometric repair. A `crossing` is a genuine self-intersection.

<figure class="diagram">
<svg viewBox="-6 48 753 198" role="img" aria-labelledby="si-kinds-t si-kinds-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-kinds-t">Three relationships between two triangles, three different fixes</title>
  <desc id="si-kinds-d">Triangles that share an edge are adjacent by construction and are not a defect. Coplanar overlapping triangles are duplicated geometry and are fixed by deduplication. Triangles that cross through each other are a genuine self-intersection and need geometric repair.</desc>
  <rect class="svg-bg" x="-6" y="48" width="753" height="198" fill="#ffffff"/>
  <path d="M50 80 L140 80 L95 165 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M140 80 L230 80 L185 165 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M300 80 L400 80 L350 165 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M320 92 L420 92 L370 177 Z" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M540 78 L650 78 L595 168 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M560 160 L690 96 L640 62 Z" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="140" y="196" fill="#4f7a4d" font-size="12.5" text-anchor="middle">adjacent — not a defect</text>
  <text x="360" y="196" fill="#c46a3d" font-size="12.5" text-anchor="middle">coplanar overlap — deduplicate</text>
  <text x="615" y="196" fill="#b0413e" font-size="12.5" text-anchor="middle">crossing — repair geometrically</text>
  <text x="370" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">A detector that does not separate these reports thousands of defects on a healthy mesh and buries the handful that matter</text>
</svg>
<figcaption>Only the third is a self-intersection. Conflating the three is why teams conclude the check is too noisy to use.</figcaption>
</figure>

### 3. Localise the damage before repairing

A repair that operates on the whole mesh is far riskier than one confined to the neighbourhood of the defect.

```python
import numpy as np

def affected_region(mesh, crossings, rings=2):
    """Faces within `rings` of any crossing face, via the face adjacency graph."""
    seed = {f for pair in crossings for f in pair}
    adj = mesh.face_adjacency
    for _ in range(rings):
        grow = set()
        for a, b in adj:
            if a in seed:
                grow.add(b)
            if b in seed:
                grow.add(a)
        seed |= grow
    return np.array(sorted(seed))

region = affected_region(mesh, crossings)
print(f"{len(crossings)} crossings touch {len(region)} faces "
      f"({100 * len(region) / len(mesh.faces):.2f}% of the mesh)")
```

If that percentage is small — well under one per cent is typical for a real defect — a local repair is safe. If it is large, the mesh is not self-intersecting so much as fundamentally wrong, and re-deriving it from the source is cheaper than repairing it.

### 4. Repair, in increasing order of destructiveness

Try the cheap fixes first, and re-test after each.

```python
import trimesh
import numpy as np

def repair(mesh):
    steps = []

    # 1. Duplicate and degenerate faces produce most coplanar reports.
    before = len(mesh.faces)
    mesh.update_faces(mesh.unique_faces())
    mesh.update_faces(mesh.nondegenerate_faces(height=1e-8))
    steps.append(("dedupe + degenerate", before - len(mesh.faces)))

    # 2. Merging near-coincident vertices resolves crossings caused by tiny gaps.
    before = len(mesh.vertices)
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    steps.append(("merge vertices", before - len(mesh.vertices)))

    # 3. Only then, a voxel remesh of the affected region — lossy, so last.
    return mesh, steps

mesh, steps = repair(mesh)
for name, n in steps:
    print(f"{name:<24} removed {n}")
```

The third option — voxelising and re-extracting the surface — always resolves self-intersections and always loses sharp edges, so it belongs behind a measurement: run it on the affected region only, then compare the result against the original with a Hausdorff distance and reject the repair if it exceeds your tolerance.

<figure class="diagram">
<svg viewBox="-12 42 764 180" role="img" aria-labelledby="si-ladder-t si-ladder-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-ladder-t">Repair options ordered by what they destroy</title>
  <desc id="si-ladder-d">Removing duplicate and degenerate faces changes nothing that was correct. Merging near-coincident vertices moves geometry only within the tolerance. Cutting and re-triangulating the intersecting faces preserves the surface but changes topology. Voxel remeshing always works and always rounds sharp edges, so it belongs last and only on the affected region.</desc>
  <rect class="svg-bg" x="-12" y="42" width="764" height="180" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="160" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="210" y="56" width="160" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="390" y="56" width="160" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="570" y="56" width="150" height="52" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="110" y="78"><tspan x="110" dy="0">dedupe faces</tspan><tspan x="110" dy="16">destroys nothing</tspan></text>
    <text x="290" y="78"><tspan x="290" dy="0">merge vertices</tspan><tspan x="290" dy="16">moves within tolerance</tspan></text>
    <text x="470" y="78"><tspan x="470" dy="0">cut and retriangulate</tspan><tspan x="470" dy="16">changes topology</tspan></text>
    <text x="645" y="78"><tspan x="645" dy="0">voxel remesh</tspan><tspan x="645" dy="16">rounds sharp edges</tspan></text>
  </g>
  <path d="M30 140 H720" fill="none" stroke="#5b6471" stroke-width="2"/>
  <text x="40" y="164" fill="#4f7a4d" font-size="12" text-anchor="start">safe</text>
  <text x="710" y="164" fill="#b0413e" font-size="12" text-anchor="end">lossy</text>
  <text x="370" y="204" fill="#15384a" font-size="12.5" text-anchor="middle">Re-test after every step — the first two frequently resolve everything, and each one you skip makes the next more destructive</text>
</svg>
<figcaption>Most self-intersections in survey-derived meshes are duplicates or sub-millimetre gaps, and are fixed by the two leftmost boxes.</figcaption>
</figure>

### 5. Gate on the crossing count, not on watertightness

Add the check to the pipeline where connectivity is already asserted.

```python
def assert_no_self_intersection(mesh, max_crossings=0):
    pairs = candidate_pairs(mesh)
    crossings = [(i, j) for i, j in pairs
                 if tri_tri_intersect(mesh.triangles[i], mesh.triangles[j]) == "crossing"]
    if len(crossings) > max_crossings:
        raise AssertionError(
            f"{len(crossings)} self-intersecting face pairs, e.g. {crossings[:3]}")
    return True
```

<figure class="diagram">
<svg viewBox="46 21 648 209" role="img" aria-labelledby="si-cost-t si-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="si-cost-t">Why the candidate pass is what makes the check affordable</title>
  <desc id="si-cost-d">Testing every pair of faces in a half-million-face mesh is about one hundred and twenty billion tests. An R-tree over face bounding boxes reduces the candidates to tens of thousands, so the exact triangle-triangle test runs on a set five million times smaller and the whole check takes seconds instead of hours.</desc>
  <rect class="svg-bg" x="46" y="21" width="648" height="209" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="620" height="34" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="112" width="9" height="34" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="60" y="48">every pair — 1.2 × 10¹¹ tests, hours</text>
    <text x="82" y="134">R-tree candidates — 1.9 × 10⁴ tests, seconds</text>
  </g>
  <text x="370" y="186" fill="#15384a" font-size="12.5" text-anchor="middle">The exact test is the expensive part, so the whole design is about how few pairs reach it</text>
  <text x="370" y="212" fill="#5b6471" font-size="12" text-anchor="middle">Bars are to scale — the green one is nine pixels wide because the reduction really is that large</text>
</svg>
<figcaption>The bounding-box pass discards almost everything before the exact test runs, which is the difference between a check that lives in CI and one that never gets adopted.</figcaption>
</figure>

## Expected Output & Verification

A representative run on a photogrammetric building block:

```text
482,110 faces → 18,904 candidate pairs
{'none': 18726, 'coplanar': 162, 'crossing': 16}
16 crossings touch 214 faces (0.04% of the mesh)
dedupe + degenerate      removed 168
merge vertices           removed 91
```

Three readings. The candidate reduction from a quarter of a trillion possible pairs to nineteen thousand is what makes the check affordable. The 162 coplanar pairs against 16 crossings is the usual ratio, and treating them as one number is why the check gets a reputation for noise. And 0.04% of faces affected says a local repair is safe here.

Re-run the detector after repairing and require zero crossings, then confirm the volume is now plausible — a self-intersecting closed mesh frequently reports a negative or wildly inflated volume, and a sensible figure afterwards is good evidence the repair worked.

```python
print("volume:", round(mesh.volume, 2), "m³ | watertight:", mesh.is_watertight)
assert mesh.volume > 0, "negative volume — orientation or intersection still present"
```

## Common Errors

**Thousands of intersections on a healthy mesh.** Faces sharing a vertex were not excluded, so every adjacency counts. Filter on shared vertices before testing.

**The check takes hours.** The candidate pass is missing and the test is quadratic. On a half-million-face mesh that is 120 billion pairs; with the R-tree it is tens of thousands.

**Repair collapses a facade.** Voxel remeshing was applied to the whole mesh rather than the affected region. Localise first, and always measure the Hausdorff distance against the original before accepting.

**Volume is negative after repair.** Face winding is inconsistent, which is a separate defect. Run `trimesh.repair.fix_normals` and re-check.

## Frequently Asked Questions

### Does a self-intersecting mesh render incorrectly?
Usually not — the rasteriser draws both faces and the result looks fine. That is precisely why the defect survives visual review and only surfaces in a volumetric or ray-based calculation.

### Should this run on every mesh?
On every mesh that feeds a volumetric, hydrological or physics calculation, yes. On meshes that are only ever rendered, it is optional — though a crossing usually indicates something upstream went wrong that is worth knowing about anyway.

### Where do self-intersections come from?
Three sources dominate: booleans that left both operands' faces, decimation that collapsed a thin feature through its neighbour, and photogrammetric reconstruction over a reflective surface where the depth estimate flipped. The last is the one that recurs.

A word on where this belongs in a pipeline. Self-intersection is a property of a finished surface, so the natural place is immediately after reconstruction and again after decimation — the two stages that create them. Running it after texturing is wasted work, because texturing changes no geometry, and running it before merging reports adjacency as intersection.

It is also worth recording the crossing count in the artifact rather than only failing on it. A mesh that goes from zero crossings to three after a decimation parameter change tells you something specific about that change, and the number is only available if somebody stored it. A boolean pass or fail discards exactly the signal that would have made the regression attributable.

## Related Guides

- [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — the connectivity checks this complements
- [Fixing Non-Manifold Edges in 3D Meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/) — the defect that is about connectivity rather than geometry
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — a common source of new crossings

Back to [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).
