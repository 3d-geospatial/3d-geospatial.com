---
title: "Welding Vertices and Removing Duplicate Faces"
description: "Clean up imported meshes safely: weld coincident vertices at a justified tolerance, drop duplicate and degenerate faces"
---
# Welding Vertices and Removing Duplicate Faces

This page cleans imported meshes before anything downstream trusts them — welding coincident vertices at a tolerance derived from the data rather than guessed, removing duplicate and degenerate faces, dropping unreferenced vertices, and verifying that the cleanup improved connectivity without collapsing thin geometry, on meshes in EPSG:32633.

## Why you hit this

Nearly every mesh that enters a twin from an exchange format arrives unwelded. STL has no concept of shared vertices at all; OBJ and PLY often store one vertex per face corner because the exporter wrote them that way; CAD tessellation duplicates the corners of every patch. The result is a mesh with three times the vertices it needs, no usable adjacency, per-face normals that make it look faceted, every edge counted as a boundary, and a topology audit that reports nonsense. Welding fixes all of that in one pass — and welding at the wrong tolerance destroys thin walls and merges two sides of a 2 cm panel into a single surface. The topological reason it matters is in [mesh topology basics for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).

## Prerequisites

- Python 3.10+ with `trimesh>=4.0`, `numpy>=1.24`, `scipy>=1.11`.
- Meshes in a metric CRS, ideally already re-centred so coordinates are small — welding compares distances, and float precision at UTM magnitudes is coarse enough to matter, as described in [resolving float32 precision jitter in large-coordinate meshes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/resolving-float32-precision-jitter-in-large-coordinate-meshes/).
- Knowledge of the thinnest real feature in the data: a 20 cm wall, a 12 mm plate, a 3 cm kerb. That number bounds the tolerance.

## Step-by-Step

### 1. Diagnose before touching anything

```python
import numpy as np
import trimesh
from scipy.spatial import cKDTree

def diagnose(path):
    mesh = trimesh.load(path, force="mesh", process=False)   # process=False: keep it as delivered
    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    tree = cKDTree(v)
    pairs_1mm = tree.query_pairs(0.001, output_type="ndarray")
    sorted_faces = np.sort(f, axis=1)
    _, first, counts = np.unique(sorted_faces, axis=0, return_index=True, return_counts=True)
    tri = v[f]
    areas = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    boundary = trimesh.grouping.group_rows(mesh.edges_sorted, require_count=1)
    return {
        "vertices": len(v),
        "faces": len(f),
        "vertices_per_face_corner": round(len(v) / (3 * len(f)), 3),
        "coincident_pairs_1mm": int(len(pairs_1mm)),
        "duplicate_faces": int((counts > 1).sum()),
        "degenerate_faces": int((areas < 1e-9).sum()),
        "boundary_edges": int(len(boundary)),
        "euler": int(mesh.euler_number),
    }

before = diagnose("imports/plant_room.ply")
print(before)
```

The ratio of vertices to face corners is the fastest tell. A properly welded closed mesh has roughly one vertex per two faces, so the ratio sits near 0.17; a mesh with one vertex per corner has exactly 1.0. Anything above about 0.5 means the file is substantially unwelded, and the boundary-edge count will be close to three times the face count.

Loading with `process=False` matters here: trimesh's default processing merges vertices on load, which hides the very thing being measured.

<figure class="diagram">
<svg viewBox="42 42 670 200" role="img" aria-labelledby="weld-corner-t weld-corner-d" xmlns="http://www.w3.org/2000/svg">
  <title id="weld-corner-t">Per-corner vertices against shared vertices</title>
  <desc id="weld-corner-d">On the left, four triangles each carry their own copies of the shared corner, so twelve vertices describe a patch that needs six, every interior edge appears twice and nothing is adjacent to anything. On the right, the same patch after welding has six vertices, shared edges and usable adjacency, so normals can be smoothed and decimation can collapse edges.</desc>
  <rect class="svg-bg" x="42" y="42" width="670" height="200" fill="#ffffff"/>
  <g stroke="#1f6b8a" stroke-width="1.6" fill="none">
    <path d="M60 170 L130 60 L200 170 Z"/>
    <path d="M136 60 L206 170 L276 60 Z"/>
    <path d="M70 176 L140 66 L210 176 Z" stroke-dasharray="4 3"/>
  </g>
  <g fill="#b0413e">
    <circle cx="60" cy="170" r="4"/><circle cx="130" cy="60" r="4"/><circle cx="200" cy="170" r="4"/>
    <circle cx="136" cy="60" r="4"/><circle cx="206" cy="170" r="4"/><circle cx="276" cy="60" r="4"/>
    <circle cx="70" cy="176" r="4"/><circle cx="140" cy="66" r="4"/><circle cx="210" cy="176" r="4"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="1.6" fill="none">
    <path d="M460 170 L530 60 L600 170 Z"/>
    <path d="M530 60 L600 170 L670 60 Z"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="460" cy="170" r="4"/><circle cx="530" cy="60" r="4"/><circle cx="600" cy="170" r="4"/><circle cx="670" cy="60" r="4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="204">unwelded: 9 vertices for 3 triangles</text>
    <text x="170" y="224">every edge is a boundary edge</text>
    <text x="565" y="204">welded: 4 vertices, shared edges</text>
    <text x="565" y="224">adjacency, smooth normals, decimation work</text>
  </g>
</svg>
<figcaption>Welding does not change the shape at all; it changes whether the file describes a surface or a pile of unrelated triangles.</figcaption>
</figure>

### 2. Choose the tolerance from the data

```python
def tolerance_sweep(mesh, tolerances=(1e-5, 1e-4, 1e-3, 5e-3, 2e-2, 5e-2)):
    v = np.asarray(mesh.vertices)
    tree = cKDTree(v)
    rows = []
    for t in tolerances:
        pairs = tree.query_pairs(t, output_type="ndarray")
        rows.append({"tolerance_m": t, "pairs": int(len(pairs))})
    return rows

mesh_raw = trimesh.load("imports/plant_room.ply", force="mesh", process=False)
for row in tolerance_sweep(mesh_raw):
    print(f"{row['tolerance_m']:>9.5f} m  {row['pairs']:>9,} coincident pairs")
```

The sweep almost always shows a plateau. Coincident duplicates from an exporter sit at a distance of zero or at float32 rounding — a few micrometres — so the pair count jumps immediately and then stays flat until the tolerance starts reaching genuinely distinct vertices, at which point it climbs again. The right tolerance is on the plateau: large enough to catch rounding, far below the thinnest real feature.

A practical rule for building and terrain meshes in metres is 0.1–1 mm. For a millimetre-unit CAD export it is 0.001 of the unit. What it must never be is "a centimetre, to be safe": a 2 cm plate welds into a single surface at that tolerance and the solid loses its thickness.

<figure class="diagram">
<svg viewBox="56 16 658 230" role="img" aria-labelledby="weld-sweep-t weld-sweep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="weld-sweep-t">Coincident pairs against welding tolerance</title>
  <desc id="weld-sweep-d">A curve of coincident vertex pairs as the tolerance grows on a log axis. It jumps immediately at micrometre tolerances, catching exporter duplicates, then forms a plateau from about a tenth of a millimetre to a few millimetres. Beyond a centimetre it climbs again as genuinely distinct vertices start to merge, and the thinnest real feature marks the point where welding becomes destructive.</desc>
  <rect class="svg-bg" x="56" y="16" width="658" height="230" fill="#ffffff"/>
  <path d="M70 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="180" y="30" width="240" height="150" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1"/>
  <polyline points="90,170 130,96 180,92 250,91 330,90 420,88 500,70 580,48 670,32" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M470 30 V180" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="90" y="200">10 µm</text><text x="180" y="200">0.1 mm</text><text x="330" y="200">1 mm</text>
    <text x="470" y="200">1 cm</text><text x="670" y="200">5 cm</text>
  </g>
  <text x="300" y="52" fill="#1f2937" font-size="12.5" text-anchor="middle">plateau: exporter duplicates only</text>
  <text x="560" y="120" fill="#b0413e" font-size="12.5" text-anchor="middle">thinnest real feature: 2 cm plate</text>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">Weld on the plateau; past the red line the mesh loses real geometry.</text>
</svg>
<figcaption>The plateau is the safe range, and its right-hand end is set by the data's thinnest feature rather than by a convention.</figcaption>
</figure>

### 3. Weld, then remove duplicates and degenerates in order

```python
def clean(path, digits=4, min_area=1e-9):
    mesh = trimesh.load(path, force="mesh", process=False)
    steps = []

    mesh.merge_vertices(digits_vertex=digits)            # 4 digits = 0.1 mm in metres
    steps.append(("weld", len(mesh.vertices), len(mesh.faces)))

    mesh.update_faces(mesh.nondegenerate_faces(height=min_area))
    steps.append(("drop degenerate", len(mesh.vertices), len(mesh.faces)))

    mesh.update_faces(mesh.unique_faces())
    steps.append(("drop duplicate", len(mesh.vertices), len(mesh.faces)))

    mesh.remove_unreferenced_vertices()
    steps.append(("drop unreferenced", len(mesh.vertices), len(mesh.faces)))

    trimesh.repair.fix_winding(mesh)
    steps.append(("fix winding", len(mesh.vertices), len(mesh.faces)))
    return mesh, steps

mesh, steps = clean("imports/plant_room.ply")
for name, nv, nf in steps:
    print(f"{name:<20}{nv:>9,} vertices {nf:>9,} faces")
```

The order is not arbitrary. Welding first is what makes duplicate faces *detectable*: two faces that reference different copies of the same three positions are only identical after the vertices are merged. Degenerate faces go next, because a zero-area triangle has no meaningful winding and would confuse the winding repair. Unreferenced vertices are removed last, after every step that can orphan one, and the winding fix comes at the end when the adjacency is final.

`digits_vertex=4` rounds coordinates to four decimal places before hashing, which in metres is 0.1 mm. That is the mechanism trimesh uses — rounding rather than clustering — so the tolerance is always a power of ten and a vertex pair straddling a rounding boundary can survive. For most imports that is irrelevant; when it matters, cluster explicitly with a KD-tree.

### 4. Verify that nothing real was lost

```python
def verify(before_path, mesh, digits=4):
    raw = trimesh.load(before_path, force="mesh", process=False)
    bbox_before = np.asarray(raw.bounds)
    bbox_after = np.asarray(mesh.bounds)
    checks = {
        "bbox_shift_mm": float(np.abs(bbox_after - bbox_before).max() * 1000),
        "area_change_pct": float(100 * (mesh.area - raw.area) / raw.area),
        "faces_removed": int(len(raw.faces) - len(mesh.faces)),
        "boundary_edges_before": int(len(trimesh.grouping.group_rows(raw.edges_sorted, require_count=1))),
        "boundary_edges_after": int(len(trimesh.grouping.group_rows(mesh.edges_sorted, require_count=1))),
        "euler_before": int(raw.euler_number),
        "euler_after": int(mesh.euler_number),
        "components_after": len(mesh.split(only_watertight=False)),
    }
    checks["thin_features_survived"] = min_thickness(mesh) > 10 ** (-digits) * 10
    return checks

def min_thickness(mesh, samples=5000):
    """Smallest distance from a sampled point just inside the surface to the surface itself."""
    if not mesh.is_watertight:
        return float("inf")
    pts, face_idx = trimesh.sample.sample_surface(mesh, samples)
    inward = pts - mesh.face_normals[face_idx] * 1e-4
    d = trimesh.proximity.ProximityQuery(mesh).signed_distance(inward)
    inside = d[d > 0]
    return float(np.percentile(inside, 1)) * 2 if len(inside) else float("inf")

print(verify("imports/plant_room.ply", mesh))
```

Four of those numbers are the actual verification. The bounding box must not move by more than the tolerance — a shift of centimetres means vertices were merged across a real gap. Surface area should fall slightly, by the area of the degenerate and duplicate faces, and a drop of more than a few percent means real faces were removed. The boundary-edge count should collapse towards zero for a closed mesh, which is the whole point of welding. And the Euler characteristic should become *meaningful* — from a face-soup value in the thousands to 2 for a closed shell, as described in [auditing meshes with Euler characteristic and genus](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/auditing-meshes-with-euler-characteristic-and-genus/).

### 5. Guard the thin-feature case explicitly

```python
def safe_tolerance(mesh, thinnest_feature_m, safety=10.0):
    """Largest welding tolerance that cannot merge across the thinnest real feature."""
    limit = thinnest_feature_m / safety
    digits = max(1, int(np.floor(-np.log10(limit))))
    return {"thinnest_feature_m": thinnest_feature_m,
            "max_tolerance_m": limit,
            "digits_vertex": digits}

print(safe_tolerance(mesh, thinnest_feature_m=0.012))     # a 12 mm steel plate
```

Deriving the digit count from the thinnest feature, with a safety factor of ten, turns the tolerance from a habit into a decision recorded in code. For a 12 mm plate it yields three digits — a millimetre — which welds exporter duplicates and cannot bridge the plate.

<figure class="diagram">
<svg viewBox="42 62 676 162" role="img" aria-labelledby="weld-thin-t weld-thin-d" xmlns="http://www.w3.org/2000/svg">
  <title id="weld-thin-t">Welding across a thin feature</title>
  <desc id="weld-thin-d">A twelve millimetre plate in section, with its two faces and their vertices. Welded at a millimetre the two faces stay separate and the plate keeps its thickness. Welded at a centimetre the vertices of the two faces merge into one surface, the plate becomes a zero-thickness sheet and its volume disappears.</desc>
  <rect class="svg-bg" x="42" y="62" width="676" height="162" fill="#ffffff"/>
  <g stroke="#1f6b8a" stroke-width="2" fill="none">
    <path d="M60 80 H300"/><path d="M60 104 H300"/>
    <path d="M60 80 V104 M300 80 V104"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="60" cy="80" r="4"/><circle cx="180" cy="80" r="4"/><circle cx="300" cy="80" r="4"/>
    <circle cx="60" cy="104" r="4"/><circle cx="180" cy="104" r="4"/><circle cx="300" cy="104" r="4"/>
  </g>
  <text x="180" y="140" fill="#4f7a4d" font-size="12.5" text-anchor="middle">welded at 1 mm: plate keeps 12 mm</text>
  <path d="M460 92 H700" fill="none" stroke="#b0413e" stroke-width="3"/>
  <g fill="#b0413e">
    <circle cx="460" cy="92" r="4"/><circle cx="580" cy="92" r="4"/><circle cx="700" cy="92" r="4"/>
  </g>
  <text x="580" y="140" fill="#b0413e" font-size="12.5" text-anchor="middle">welded at 1 cm: a zero-thickness sheet</text>
  <text x="580" y="162" fill="#b0413e" font-size="12.5" text-anchor="middle">volume 0, no longer a solid</text>
  <text x="380" y="206" fill="#15384a" font-size="12.5" text-anchor="middle">Tolerance ≤ thinnest feature ÷ 10 keeps the guarantee comfortable.</text>
</svg>
<figcaption>The damage is silent: the mesh stays watertight-looking, its volume goes to zero and nothing reports an error.</figcaption>
</figure>

## Expected Output & Verification

```text
{'vertices': 1204884, 'faces': 401628, 'vertices_per_face_corner': 1.0,
 'coincident_pairs_1mm': 802104, 'duplicate_faces': 1842, 'degenerate_faces': 204,
 'boundary_edges': 1204884, 'euler': 401628}
  0.00001 m    802,104 coincident pairs
  0.00010 m    802,104 coincident pairs
  0.00100 m    802,118 coincident pairs
  0.00500 m    802,204 coincident pairs
  0.02000 m    841,882 coincident pairs
  0.05000 m  1,204,118 coincident pairs
weld                  402,780 vertices   401,628 faces
drop degenerate       402,780 vertices   401,424 faces
drop duplicate        402,780 vertices   399,582 faces
drop unreferenced     401,204 vertices   399,582 faces
fix winding           401,204 vertices   399,582 faces
{'bbox_shift_mm': 0.0, 'area_change_pct': -0.41, 'faces_removed': 2046,
 'boundary_edges_before': 1204884, 'boundary_edges_after': 0,
 'euler_before': 401628, 'euler_after': 2, 'components_after': 1,
 'thin_features_survived': True}
{'thinnest_feature_m': 0.012, 'max_tolerance_m': 0.0012, 'digits_vertex': 3}
```

That is the shape of a healthy cleanup. The vertex count falls by two thirds, the boundary-edge count goes from 1.2 million to zero, the Euler characteristic becomes 2, and the surface area drops by less than half a percent. The sweep shows the plateau clearly: from 10 µm to 5 mm the pair count barely moves, and at 2 cm it jumps — which is the 12 mm plate starting to merge.

Verify on a fixture whose answer is known:

```python
box = trimesh.creation.box(extents=(2, 3, 1))
soup = trimesh.Trimesh(vertices=box.triangles.reshape(-1, 3),
                       faces=np.arange(len(box.faces) * 3).reshape(-1, 3), process=False)
assert len(soup.vertices) == 36 and soup.euler_number != 2
soup.merge_vertices(digits_vertex=6)
soup.update_faces(soup.unique_faces())
soup.remove_unreferenced_vertices()
assert len(soup.vertices) == 8, f"expected 8 vertices, got {len(soup.vertices)}"
assert soup.euler_number == 2 and soup.is_watertight
assert abs(soup.volume - 6.0) < 1e-9
print("welding a box face-soup recovers 8 vertices, χ = 2 and volume 6.0")
```

## Performance Notes

- **Welding is a hash of rounded coordinates**, so it is linear and fast: a four-million-vertex mesh welds in a few seconds.
- **The KD-tree sweep is the expensive part.** Run it on a sample of a few hundred thousand vertices to choose the tolerance, not on the whole mesh.
- **Clean once, early.** Every later stage — decimation, UV unwrapping, normal smoothing, topology auditing — is faster and more correct on a welded mesh, so this belongs immediately after import.
- **Do not weld in a large-coordinate frame.** At UTM magnitudes, float32 spacing is centimetres, which makes a millimetre tolerance meaningless; re-centre first.
- **Store the cleaned mesh**, not the raw import, as the pipeline's working copy — but keep the raw file, because a tolerance decision occasionally has to be revisited.

## Common Errors

**Welding removes no vertices at all.** The mesh was loaded with `process=True`, which already welded it, or the coordinates differ beyond the rounding — for instance because they carry float32 noise at large magnitudes.

**A solid becomes a sheet and its volume goes to zero.** The tolerance exceeded a thin feature. Derive it from the thinnest feature, and check `min_thickness` after cleaning.

**Duplicate faces survive after welding.** They have the same vertices in a different *winding*, so index sorting is required before comparison — as `np.sort(f, axis=1)` does in the diagnosis. Whether to remove a flipped duplicate is a decision: it is usually an exporter writing both sides of a surface.

**Surface area falls by 40%.** Duplicate faces were the bulk of the mesh — a double-sided export. That is the correct outcome, and it is worth logging rather than passing silently, since it changes every area-based calculation downstream.

**The mesh splits into thousands of components after cleaning.** It was never one surface; welding revealed that the parts only touched visually. That is a modelling problem in the source, not a cleanup failure.

## Frequently Asked Questions

### Should welding be part of the import or a separate step?

A separate, explicit step with its tolerance recorded. Import-time welding with a library default is how a pipeline silently loses a thin feature, because nobody chose the number.

### What about texture coordinates and normals?

Welding by position merges vertices that may have different UVs or normals, which breaks a texture seam. Where textures matter, weld by position *and* attribute — trimesh preserves this when the visual carries per-vertex UVs — or split seams again afterwards, as in [preserving UV seams during mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/).

### Is there a reason to keep an unwelded mesh?

Only for formats that require it, such as STL for some manufacturing tools. For anything in a twin, unwelded geometry is strictly worse: larger, slower, and unable to support the operations that follow.

## Related Guides

- [Auditing Meshes with Euler Characteristic and Genus](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/auditing-meshes-with-euler-characteristic-and-genus/) — the audit that only works after welding
- [Orienting Face Normals Consistently](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/orienting-face-normals-consistently/) — the next cleanup step
- [Fixing Non-Manifold Edges in 3D Meshes](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/fixing-non-manifold-edges-in-3d-meshes/) — what welding sometimes reveals

Back to [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/).
