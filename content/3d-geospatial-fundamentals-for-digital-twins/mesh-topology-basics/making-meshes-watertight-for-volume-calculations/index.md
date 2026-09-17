# Making Meshes Watertight for Volume Calculations

This page makes reconstructed building and terrain meshes fit for volume calculation with `trimesh` — diagnosing open boundaries, duplicate vertices and inconsistent winding, repairing what can be repaired, and computing a correct volume for surfaces that should never be closed, such as a stockpile or excavation modelled as a height field in EPSG:32633.

## Why you hit this

`mesh.volume` returns a number for any mesh, closed or not. For a watertight mesh with consistent outward normals it is the enclosed volume. For anything else it is the signed volume of the cones from the coordinate origin to every face, which depends on where the origin is — move the mesh 100 m east and the "volume" changes. Photogrammetry and Poisson reconstructions are rarely watertight, a scanned building has no floor, and a stockpile surface has no base at all. A volume report built on those numbers is wrong by an amount nobody can predict, and the error is silent. The topological rules behind this are in [mesh topology basics for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

## Prerequisites

- `trimesh>=4.0`, `numpy>=1.24`, `shapely>=2.0`; optionally `pymeshfix>=0.16` for large holes.
- A mesh in a projected, metric CRS with an explicit vertical datum — EPSG:32633 with EGM2008 heights (EPSG:3855) in the examples — because volume in cubic degrees is not a volume.
- Knowledge of what the mesh represents: a closed solid (a building, a tank) or an open surface over a base (a stockpile, a pit, terrain). The repair strategy differs.

## Step-by-Step

### 1. Diagnose before repairing

```python
import numpy as np
import trimesh

mesh = trimesh.load("stockpile_b_2026-08.ply", force="mesh", process=False)

def diagnose(m):
    boundary = trimesh.grouping.group_rows(m.edges_sorted, require_count=1)
    return {
        "vertices": len(m.vertices),
        "faces": len(m.faces),
        "watertight": m.is_watertight,
        "winding_consistent": m.is_winding_consistent,
        "is_volume": m.is_volume,
        "boundary_edges": len(boundary),
        "components": len(m.split(only_watertight=False)),
        "euler": m.euler_number,
    }

print(diagnose(mesh))
```

`process=False` matters for diagnosis: with the default processing, trimesh merges duplicate vertices on load, which hides one of the most common reasons a mesh is not watertight. Load raw, measure, then clean. The boundary-edge count is the most informative single number — an edge used by exactly one face lies on a hole or an open border. `is_volume` is trimesh's strictest test: watertight, consistently wound, and with outward-facing normals, which is exactly the condition under which `mesh.volume` means something.

### 2. Merge vertices and remove degenerate faces

```python
mesh.merge_vertices(digits_vertex=4)                  # snap within 0.1 mm in a metric CRS
mesh.update_faces(mesh.nondegenerate_faces(height=1e-6))
mesh.update_faces(mesh.unique_faces())
mesh.remove_unreferenced_vertices()
print(diagnose(mesh))
```

Many "holes" are not holes. Exporters that write each face with its own copy of the vertices produce a mesh where every edge is a boundary edge, and merging at a tolerance appropriate to the coordinate units closes the whole thing. `digits_vertex=4` rounds to 0.1 mm, which is right for metres; the same setting on a model in millimetres would merge vertices a tenth of a millimetre apart and leave real gaps open. Zero-area faces from reconstruction are removed next, because they have undefined normals and poison the winding repair.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="wt-defects-t wt-defects-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wt-defects-t">Three defects that break a volume</title>
  <desc id="wt-defects-d">Three small mesh patches. In the first, two triangles share an edge position but not vertex indices, so the edge counts as two boundary edges until vertices are merged. In the second, one triangle is wound the opposite way to its neighbour, so its normal points inward and its volume contribution has the wrong sign. In the third, a real hole leaves a loop of boundary edges that no merging can close.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <rect x="20" y="20" width="230" height="180" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="265" y="20" width="230" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="510" y="20" width="230" height="180" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M60 160 L130 60 L128 160 Z" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M136 160 L134 60 L210 160 Z" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M305 160 L380 60 L380 160 Z" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M380 160 L380 60 L455 160 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <path d="M550 150 L600 60 L680 70 L700 150 Z" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M600 110 L640 96 L660 126 L618 136 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M340 130 A14 14 0 1 1 354 116" fill="none" stroke="#1f6b8a" stroke-width="1.5"/>
  <path d="M424 116 A14 14 0 1 0 410 130" fill="none" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="44">duplicate vertices</text>
    <text x="380" y="44">flipped winding</text>
    <text x="625" y="44">real hole</text>
    <text x="135" y="222">merge_vertices</text>
    <text x="380" y="222">fix_winding</text>
    <text x="625" y="222">fill or cap</text>
  </g>
</svg>
<figcaption>Only the third defect is a missing surface. The first two are bookkeeping errors that look identical in a boundary-edge count until they are cleaned.</figcaption>
</figure>

### 3. Make winding consistent and normals outward

```python
trimesh.repair.fix_winding(mesh)
trimesh.repair.fix_inversion(mesh, multibody=True)
trimesh.repair.fix_normals(mesh, multibody=True)
print("winding consistent:", mesh.is_winding_consistent, "| volume sign:", np.sign(mesh.volume))
```

`fix_winding` makes neighbouring faces agree with each other; `fix_inversion` and `fix_normals` then flip whole bodies whose normals point inward. The order matters, because an outward test on a mesh with mixed winding gives a mixed answer. On a closed mesh, a negative volume after this step means the fix could not decide which side is outside — usually because the mesh is not closed after all.

### 4. Decide: close the surface, or measure it as a height field

A building or a tank is a closed solid with holes in it. A stockpile, an excavation or a terrain patch is an open surface that only has a volume *relative to a base*. Forcing a height-field surface closed by filling its outer boundary produces a flat lid at an arbitrary height and a meaningless volume.

```python
boundary = trimesh.grouping.group_rows(mesh.edges_sorted, require_count=1)
loops = mesh.outline().entities if len(boundary) else []
loop_lengths = sorted((len(e.points) for e in loops), reverse=True)
print(f"{len(loops)} boundary loops, largest {loop_lengths[:3]}")

normals_up = (mesh.face_normals[:, 2] > 0).mean()
is_height_field = len(loops) >= 1 and normals_up > 0.95
print("treat as height field:", is_height_field)
```

A single large outer loop with nearly all normals facing upward is a height field. A mesh with only small loops scattered over walls and roofs is a solid with holes.

<figure class="diagram">
<svg viewBox="6 6 748 236" role="img" aria-labelledby="wt-route-t wt-route-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wt-route-t">Choosing the repair route</title>
  <desc id="wt-route-d">After merging and winding repair, a mesh with no boundary edges goes straight to volume. A mesh whose boundary is one large outer loop with upward normals is a height field and is measured with prism volumes against a base surface. A mesh with small scattered loops is a solid with holes: small holes are filled with trimesh and large ones with pymeshfix, then the mesh is re-checked.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="236" fill="#ffffff"/>
  <defs>
    <marker id="wt-route-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="96" width="150" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="230" y="20" width="200" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="230" y="99" width="200" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="230" y="178" width="200" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="490" y="99" width="250" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="490" y="178" width="250" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#wt-route-arrow)">
    <path d="M170 112 L228 48"/>
    <path d="M170 124 H228"/>
    <path d="M170 136 L228 200"/>
    <path d="M430 124 H488"/>
    <path d="M430 203 H488"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="120">boundary</text>
    <text x="95" y="138">edges?</text>
    <text x="330" y="50">none: mesh.volume</text>
    <text x="330" y="120">one outer loop,</text>
    <text x="330" y="137">normals up</text>
    <text x="330" y="199">small loops on</text>
    <text x="330" y="216">walls and roofs</text>
    <text x="615" y="129">prism volume against a base</text>
    <text x="615" y="199">fill_holes, then pymeshfix,</text>
    <text x="615" y="216">then check is_volume again</text>
  </g>
</svg>
<figcaption>Closing an open height field manufactures a lid; filling a solid's holes restores surface that was actually there. The shape of the boundary tells you which you have.</figcaption>
</figure>

### 5a. Solids: fill holes and re-check

```python
if not is_height_field and not mesh.is_watertight:
    trimesh.repair.fill_holes(mesh)                      # closes triangular and quad holes only
    if not mesh.is_watertight:
        import pymeshfix
        v, f = pymeshfix.clean_from_arrays(mesh.vertices, mesh.faces)
        mesh = trimesh.Trimesh(v, f, process=True)
        trimesh.repair.fix_normals(mesh)
    assert mesh.is_volume, "mesh still does not bound a volume"
    print(f"solid volume: {mesh.volume:,.1f} m³")
```

`fill_holes` in trimesh is deliberately conservative: it closes holes of three or four edges, the ones left by a missing triangle or a dropped quad, and nothing larger. `pymeshfix` closes arbitrary holes and removes self-intersections, and in doing so may slightly alter geometry near the repair. Record the vertex count before and after; a change of more than a percent or two is a sign it rebuilt a region rather than patching it.

### 5b. Height fields: integrate prisms against a base

For an open surface, the volume between it and a base plane is the sum over faces of the face's horizontal area times its mean height above the base.

```python
def prism_volume(m, base_z):
    tri = m.triangles                                         # (n, 3, 3)
    xy = tri[:, :, :2]
    area_xy = 0.5 * np.abs(
        (xy[:, 1, 0] - xy[:, 0, 0]) * (xy[:, 2, 1] - xy[:, 0, 1])
        - (xy[:, 2, 0] - xy[:, 0, 0]) * (xy[:, 1, 1] - xy[:, 0, 1])
    )
    mean_h = tri[:, :, 2].mean(axis=1) - base_z
    facing = np.sign(m.face_normals[:, 2])                    # downward faces subtract
    return float(np.sum(area_xy * mean_h * facing))

toe_heights = mesh.outline().vertices[:, 2]                   # boundary loop vertex coordinates
base_z = float(np.percentile(toe_heights, 10))
vol = prism_volume(mesh, base_z)
print(f"base {base_z:.3f} m (EGM2008), stockpile volume {vol:,.1f} m³")
```

The prism formula is exact for a triangulated height field and needs no watertightness. The base is the choice that deserves scrutiny: the 10th percentile of the boundary heights is a reasonable flat base for a pile on level ground, but a pile on a slope needs a base *surface* — a plane fitted through the toe points, or the pre-placement terrain from an earlier survey — in which case `mean_h` becomes the difference between the surface and the base surface under each face.

## Expected Output & Verification

```text
{'vertices': 2412088, 'faces': 804028, 'watertight': False, 'winding_consistent': False, 'is_volume': False, 'boundary_edges': 2412084, 'components': 804028, 'euler': 804028}
{'vertices': 402611, 'faces': 803990, 'watertight': False, 'winding_consistent': True, 'is_volume': False, 'boundary_edges': 1230, 'components': 1, 'euler': 1}
1 boundary loops, largest [1231]
treat as height field: True
base 212.418 m (EGM2008), stockpile volume 18,742.6 m³
```

The first diagnosis is the signature of a face-soup export — every edge a boundary and one component per face — and a single merge turns it into one component with one boundary loop. Verify the volume two independent ways. Translate the mesh by 1,000 m in x and y and recompute: the prism volume must not change, while `mesh.volume` on the open mesh will. Then voxelise and count:

```python
shifted = mesh.copy()
shifted.apply_translation([1000.0, 1000.0, 0.0])
assert abs(prism_volume(shifted, base_z) - vol) < 1e-6 * abs(vol)

pitch = 0.25
grid = mesh.voxelized(pitch)
cols = grid.sparse_indices
heights = {}
for i, j, k in cols:
    heights[(i, j)] = max(heights.get((i, j), -1), k)
top = np.array(list(heights.values())) * pitch + grid.translation[2]
voxel_vol = float(np.sum(np.clip(top - base_z, 0, None)) * pitch * pitch)
print(f"voxel estimate {voxel_vol:,.0f} m³ vs prism {vol:,.0f} m³")
```

<figure class="diagram">
<svg viewBox="86 -5 578 257" role="img" aria-labelledby="wt-vol-t wt-vol-d" xmlns="http://www.w3.org/2000/svg">
  <title id="wt-vol-t">Volume estimates for the same open stockpile mesh</title>
  <desc id="wt-vol-d">Bar chart of four volume estimates. trimesh volume on the open mesh at its original coordinates gives a large negative number, and after shifting the mesh by one kilometre it gives a completely different large number. The prism volume gives 18,743 cubic metres at both positions, and a quarter-metre voxel count agrees within about one percent.</desc>
  <rect class="svg-bg" x="86" y="-5" width="578" height="257" fill="#ffffff"/>
  <path d="M60 120 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="100" y="120" width="100" height="80" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <rect x="250" y="30" width="100" height="90" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <rect x="400" y="84" width="100" height="36" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <rect x="550" y="85" width="100" height="35" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="150" y="218">mesh.volume</text>
    <text x="150" y="234">original position</text>
    <text x="300" y="138">mesh.volume</text>
    <text x="300" y="154">shifted 1 km</text>
    <text x="450" y="138">prism volume</text>
    <text x="450" y="154">either position</text>
    <text x="600" y="138">voxel count</text>
    <text x="600" y="154">0.25 m pitch</text>
    <text x="450" y="76">18,743 m³</text>
    <text x="600" y="76">18,590 m³</text>
  </g>
  <text x="150" y="112" fill="#b0413e" font-size="12" text-anchor="middle">−2.1 × 10⁹</text>
  <text x="300" y="22" fill="#b0413e" font-size="12" text-anchor="middle">+3.4 × 10⁹</text>
</svg>
<figcaption>On an open mesh, trimesh's volume is a property of where the origin is. The prism and voxel estimates depend only on the surface and the base.</figcaption>
</figure>

## Common Errors

**`mesh.volume` is negative on a mesh that `is_watertight`.** Normals point inward. `fix_normals` corrects it for a single closed body; for many bodies pass `multibody=True`, or split and fix each component.

**Volume changes when the file is reloaded.** The default `process=True` merged vertices on one load path and not another, or the mesh was re-exported through a tool that re-centred it. Pin `process` explicitly and use a translation-invariant method for open surfaces.

**`pymeshfix` returns a much smaller mesh.** It discards every component except the largest. On a building made of disconnected parts — a roof shell and separate walls — repair each component on its own, or merge touching parts first with a vertex merge at a looser tolerance.

## Frequently Asked Questions

### Is a watertight mesh always a valid volume?

No. It also has to be free of self-intersections and consistently wound with outward normals, which is what `is_volume` checks. Self-intersecting closed meshes are covered in [detecting and repairing self-intersecting geometry](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/detecting-and-repairing-self-intersecting-geometry/).

### Should I decimate before or after computing volume?

After. Decimation can open tiny holes and shift the surface by its error tolerance, which changes the volume in proportion to the surface area. Compute the reportable volume on the full-resolution repaired mesh, then decimate for display.

### Can I compute a cut-and-fill volume this way?

Yes — use the earlier survey's surface as the base instead of a plane, sample it under each face centroid, and keep positive and negative prisms separate. The sums are fill and cut respectively.

## Related Guides

- [Fixing Non-Manifold Edges in 3D Meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/) — the defect that stops winding repair working
- [Detecting and Repairing Self-Intersecting Geometry](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/detecting-and-repairing-self-intersecting-geometry/) — the last condition for a valid solid
- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — producing surfaces that need less repair

Back to [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).
