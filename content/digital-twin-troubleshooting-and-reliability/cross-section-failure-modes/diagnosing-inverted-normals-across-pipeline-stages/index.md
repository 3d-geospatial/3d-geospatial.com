# Diagnosing Inverted Normals Across Pipeline Stages

This page locates the stage in a pipeline that inverted a mesh's normals — testing signed volume, ray parity and normal-to-face consistency at every handoff, checking the transforms for a negative determinant, and distinguishing the four separate things people mean by "the normals are wrong".

## Why you hit this

A tileset renders with holes in every building, or with roofs visible from inside and invisible from outside, and the symptom appears after a pipeline of eight stages. The mesh was correct when it came off the scanner and it is wrong in the viewer, and the only way to find where is to test at each handoff.

The diagnosis is confused by the fact that "inverted normals" covers four unrelated problems: the face winding order is reversed, the stored vertex normals point the wrong way, the winding and the normals disagree with each other, or nothing is inverted at all and backface culling is disabled. Each has a different fix, and a test that does not distinguish them sends you to the wrong stage.

## Prerequisites

- Python 3.10+ with `numpy`, `trimesh`, `pymeshlab`; the pipeline's intermediate outputs saved.
- The mesh at each stage boundary, or the ability to re-run with intermediates written.
- For the glTF end, `gltf-transform` or `pygltflib`.

## Step-by-Step

### 1. Separate the four distinct problems

```python
import json
import math
from pathlib import Path

import numpy as np
import trimesh

PROBLEMS = {
    "winding_reversed": {
        "what": "face vertex order is clockwise where the convention is "
                "counter-clockwise",
        "detect": "signed volume is negative on a closed mesh; ray parity disagrees",
        "symptom": "backface culling hides the outside and shows the inside",
        "usual_cause": "a transform with a negative determinant, or an exporter "
                       "with the opposite convention",
        "fix": "reverse the face index order",
    },
    "stored_normals_flipped": {
        "what": "the NORMAL attribute points inward while the winding is correct",
        "detect": "face normal from the winding disagrees with the stored vertex "
                  "normal",
        "symptom": "lighting is inverted — surfaces facing the light are dark",
        "usual_cause": "normals estimated with an unoriented method, or negated by "
                       "a conversion",
        "fix": "recompute the normals from the winding, or negate them",
    },
    "winding_and_normals_disagree": {
        "what": "both exist and they contradict each other",
        "detect": "the dot product of the face normal and the stored normal is "
                  "negative on a large share of faces",
        "symptom": "shading and culling disagree, so the result depends on the "
                   "renderer",
        "usual_cause": "one stage flipped the winding and another flipped the "
                       "normals",
        "fix": "pick the winding as authoritative and recompute the normals",
    },
    "nothing_inverted": {
        "what": "the mesh is correct and the material is double-sided or culling "
                "is off",
        "detect": "all the geometric tests pass",
        "symptom": "looks wrong but only in one viewer",
        "usual_cause": "a material with doubleSided true, or a viewer setting",
        "fix": "fix the material, not the geometry",
    },
}

for name, spec in PROBLEMS.items():
    print(f"{name:<32}{spec['symptom']}")
```

Naming the four problems before testing anything is what prevents the usual wasted afternoon. A mesh whose lighting is inverted but whose culling is correct has flipped *normals* and correct *winding*, and reversing the faces makes it worse — it swaps one symptom for the other.

The fourth case is worth taking seriously because it is common and it is not a geometry problem at all. A glTF material with `doubleSided: true` renders both faces, so a mesh with genuinely reversed winding looks acceptable until it reaches a renderer that culls; conversely a correct mesh viewed with culling disabled can look wrong for unrelated reasons.

### 2. Test signed volume and ray parity

```python
def signed_volume(mesh):
    """Sum of tetrahedra from the origin: positive for outward-facing winding."""
    tri = mesh.vertices[mesh.faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    volumes = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0
    return float(volumes.sum())

def winding_report(mesh):
    closed = bool(mesh.is_watertight)
    vol = signed_volume(mesh)
    report = {
        "faces": int(len(mesh.faces)),
        "watertight": closed,
        "winding_consistent": bool(mesh.is_winding_consistent),
        "signed_volume_m3": round(vol, 4),
        "trimesh_volume_m3": round(float(mesh.volume), 4) if closed else None,
    }
    if closed:
        report["winding_outward"] = vol > 0
        report["verdict"] = ("winding is outward" if vol > 0
                             else "winding is INVERTED — signed volume is negative")
    else:
        report["winding_outward"] = None
        report["verdict"] = ("mesh is open; signed volume is not decisive — use ray "
                             "parity or the normal-consistency test")
    return report

def ray_parity_report(mesh, samples=2000, seed=7):
    """For a closed mesh, a point inside must have an odd crossing count."""
    if not mesh.is_watertight:
        return {"applicable": False,
                "reason": "ray parity requires a watertight mesh"}
    rng = np.random.default_rng(seed)
    lo, hi = mesh.bounds
    pts = rng.uniform(lo, hi, size=(samples, 3))
    inside = mesh.contains(pts)

    # Independent check: the centroid of a convex-ish solid should be inside.
    centroid_inside = bool(mesh.contains(mesh.centroid.reshape(1, 3))[0])
    volume_fraction = float(inside.mean())
    bbox_volume = float(np.prod(hi - lo))
    expected_fraction = abs(mesh.volume) / max(bbox_volume, 1e-12)

    return {
        "applicable": True,
        "sampled": samples,
        "inside_fraction": round(volume_fraction, 4),
        "expected_fraction_from_volume": round(expected_fraction, 4),
        "centroid_reported_inside": centroid_inside,
        "consistent": abs(volume_fraction - expected_fraction) < 0.08
                      and centroid_inside,
        "verdict": ("parity agrees with the volume — winding is coherent"
                    if abs(volume_fraction - expected_fraction) < 0.08
                    and centroid_inside
                    else "parity disagrees with the volume — winding is inverted or "
                         "inconsistent"),
    }
```

Signed volume is the decisive test for a **closed** mesh and says nothing about an open one. The sum of signed tetrahedra from the origin is positive when faces wind counter-clockwise as seen from outside, and a negative total on a watertight mesh is conclusive.

Ray parity is the cross-check that catches a mesh whose winding is *inconsistent* rather than uniformly reversed — where signed volume can land near zero and look ambiguous. If the fraction of sampled bounding-box points reported inside disagrees with the fraction implied by the volume, the inside-outside test itself is unreliable, which means the winding is not coherent.

Most surveyed meshes are open — a facade, a terrain patch, a scanned surface — so both tests report "not applicable" and the normal-consistency test in step 3 becomes the primary tool. That is the usual case and it is worth expecting.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="normals-four-t normals-four-d" xmlns="http://www.w3.org/2000/svg">
  <title id="normals-four-t">Four problems, four symptoms, four fixes</title>
  <desc id="normals-four-d">A table of the four distinct problems. Reversed winding shows as backface culling hiding the outside, detected by a negative signed volume, fixed by reversing the face order. Flipped stored normals show as inverted lighting with correct culling, detected by comparing face normals against stored normals, fixed by recomputing the normals. Winding and normals disagreeing shows as shading and culling contradicting each other, fixed by taking the winding as authoritative. Nothing inverted shows as a problem in one viewer only, fixed in the material rather than the geometry.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="394" y="20" width="164" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="558" y="20" width="164" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="194" y="54" width="200" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="394" y="54" width="164" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="558" y="54" width="164" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="100" width="176" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="100" width="200" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="394" y="100" width="164" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="558" y="100" width="164" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="146" width="176" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="194" y="146" width="200" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="394" y="146" width="164" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="558" y="146" width="164" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="192" width="176" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="192" width="200" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="394" y="192" width="164" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="558" y="192" width="164" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="41">problem</text><text x="294" y="41">symptom</text>
    <text x="476" y="41">detected by</text><text x="640" y="41">fix</text>
    <text x="106" y="74">winding</text><text x="106" y="92">reversed</text>
    <text x="294" y="74">culling hides the</text><text x="294" y="92">outside</text>
    <text x="476" y="74">signed volume</text><text x="476" y="92">is negative</text>
    <text x="640" y="74">reverse the</text><text x="640" y="92">face order</text>
    <text x="106" y="120">stored normals</text><text x="106" y="138">flipped</text>
    <text x="294" y="120">lighting inverted,</text><text x="294" y="138">culling correct</text>
    <text x="476" y="120">face vs stored</text><text x="476" y="138">normal dot &lt; 0</text>
    <text x="640" y="120">recompute from</text><text x="640" y="138">the winding</text>
    <text x="106" y="166">the two</text><text x="106" y="184">disagree</text>
    <text x="294" y="166">shading and culling</text><text x="294" y="184">contradict</text>
    <text x="476" y="166">both tests fail</text><text x="476" y="184">in opposite ways</text>
    <text x="640" y="166">winding wins;</text><text x="640" y="184">recompute normals</text>
    <text x="106" y="212">nothing</text><text x="106" y="230">inverted</text>
    <text x="294" y="212">wrong in one</text><text x="294" y="230">viewer only</text>
    <text x="476" y="212">every geometric</text><text x="476" y="230">test passes</text>
    <text x="640" y="212">the material,</text><text x="640" y="230">not the geometry</text>
  </g>
</svg>
<figcaption>Reversing the faces fixes the first row and makes the second worse, which is why the tests have to run before the fix.</figcaption>
</figure>

### 3. Compare the stored normals against the winding

```python
def normal_consistency_report(mesh, sample=200_000, seed=7):
    """The test that works on open meshes: do stored normals agree with the winding?"""
    faces = np.asarray(mesh.faces)
    verts = np.asarray(mesh.vertices)
    tri = verts[faces]
    geometric = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(geometric, axis=1)
    valid = lengths > 1e-12
    geometric = geometric[valid] / lengths[valid, None]

    result = {
        "faces": int(len(faces)),
        "degenerate_faces": int((~valid).sum()),
        "has_vertex_normals": bool(mesh.vertex_normals is not None
                                   and len(mesh.vertex_normals) == len(verts)),
    }

    if not result["has_vertex_normals"]:
        result["verdict"] = ("no stored normals; only the winding matters and the "
                             "renderer will derive normals from it")
        return result

    vn = np.asarray(mesh.vertex_normals)
    stored = vn[faces[valid]].mean(axis=1)
    slen = np.linalg.norm(stored, axis=1)
    ok = slen > 1e-12
    stored = stored[ok] / slen[ok, None]
    geometric = geometric[ok]

    dots = np.einsum("ij,ij->i", geometric, stored)
    rng = np.random.default_rng(seed)
    if len(dots) > sample:
        dots = dots[rng.choice(len(dots), size=sample, replace=False)]

    opposed = dots < -0.2
    aligned = dots > 0.2
    result.update({
        "faces_compared": int(len(dots)),
        "mean_dot": round(float(dots.mean()), 4),
        "opposed_share": round(float(opposed.mean()), 4),
        "aligned_share": round(float(aligned.mean()), 4),
        "ambiguous_share": round(float((~opposed & ~aligned).mean()), 4),
    })
    if float(opposed.mean()) > 0.9:
        result["verdict"] = ("stored normals oppose the winding on nearly every "
                             "face — one of the two was flipped wholesale")
    elif float(opposed.mean()) > 0.05:
        result["verdict"] = (f"{opposed.mean():.1%} of faces disagree — the mesh has "
                             f"mixed winding or patchwise flipped normals")
    else:
        result["verdict"] = "stored normals agree with the winding"
    return result

def outward_orientation_report(mesh, sample=20_000, seed=7):
    """Does the winding face away from the local surface interior?"""
    rng = np.random.default_rng(seed)
    centres = mesh.triangles_center
    normals = mesh.face_normals
    n = len(centres)
    idx = rng.choice(n, size=min(sample, n), replace=False)

    # Offset each centre slightly along its normal and check which side is denser.
    step = float(np.linalg.norm(mesh.extents)) * 0.002
    forward = centres[idx] + normals[idx] * step
    backward = centres[idx] - normals[idx] * step

    from scipy.spatial import cKDTree
    tree = cKDTree(centres)
    d_forward, _ = tree.query(forward, k=8, workers=-1)
    d_backward, _ = tree.query(backward, k=8, workers=-1)
    # On a surface, moving outward increases the distance to other faces.
    outward = d_forward.mean(axis=1) > d_backward.mean(axis=1)

    return {
        "sampled": int(len(idx)),
        "outward_share": round(float(outward.mean()), 4),
        "verdict": ("winding faces outward" if float(outward.mean()) > 0.6
                    else "winding faces INWARD" if float(outward.mean()) < 0.4
                    else "ambiguous — the surface is too thin or too flat for this "
                         "test"),
        "note": "a heuristic for open meshes; the closed-mesh tests are decisive",
    }
```

The normal-consistency test is the workhorse because it works on open meshes, which is most surveyed geometry. It compares the normal derived from each face's winding against the stored vertex normals averaged over that face, and the sign of the dot product says whether they agree.

An `opposed_share` near 1.0 means one of the two was flipped wholesale and the mesh is internally contradictory — the third problem in the table. A share around 0.3 is more interesting: it means the flip is patchwise, which happens when normals were oriented by a propagation algorithm that got a region's sign wrong, as discussed in [alpha shape reconstruction with Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/alpha-shape-reconstruction-with-open3d/).

The outward-orientation heuristic is explicitly labelled a heuristic. It works by testing whether stepping along the normal moves away from the rest of the surface, which is reliable on a curved shell and ambiguous on a flat plate — hence the three-way verdict.

### 4. Check the transforms for a negative determinant

```python
def transform_report(matrices):
    """matrices: {stage_name: 4x4 array}. A negative determinant reverses winding."""
    rows = []
    cumulative = np.identity(4)
    for name, m in matrices.items():
        m = np.asarray(m, dtype=np.float64)
        if m.shape == (16,):
            m = m.reshape(4, 4).T          # 3D Tiles column-major
        linear = m[:3, :3]
        det = float(np.linalg.det(linear))
        cumulative = cumulative @ m
        cum_det = float(np.linalg.det(cumulative[:3, :3]))
        scales = np.linalg.norm(linear, axis=0)
        rows.append({
            "stage": name,
            "determinant": round(det, 6),
            "flips_winding": det < 0,
            "cumulative_determinant": round(cum_det, 6),
            "cumulative_flips": cum_det < 0,
            "scales": [round(float(s), 6) for s in scales],
            "uniform_scale": bool(np.allclose(scales, scales[0], rtol=1e-4)),
            "has_mirror": bool(det < 0 and np.all(scales > 0)),
        })
    flipping = [r for r in rows if r["flips_winding"]]
    return {
        "stages": rows,
        "stages_that_flip": [r["stage"] for r in flipping],
        "net_flip": bool(rows and rows[-1]["cumulative_flips"]),
        "verdict": (f"{len(flipping)} stage(s) flip the winding; net effect is "
                    f"{'a flip' if rows and rows[-1]['cumulative_flips'] else 'no flip'}"
                    if flipping else "no stage flips the winding"),
    }

COMMON_FLIPPING_TRANSFORMS = {
    "y_up_to_z_up_wrong_sign": np.array([[1, 0, 0, 0], [0, 0, 1, 0],
                                         [0, 1, 0, 0], [0, 0, 0, 1]],
                                        dtype=float),
    "mirror_x": np.diag([-1.0, 1.0, 1.0, 1.0]),
    "left_to_right_handed": np.diag([1.0, 1.0, -1.0, 1.0]),
    "correct_y_up_to_z_up": np.array([[1, 0, 0, 0], [0, 0, -1, 0],
                                      [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float),
}

for name, m in COMMON_FLIPPING_TRANSFORMS.items():
    det = float(np.linalg.det(m[:3, :3]))
    print(f"{name:<32}det {det:+.1f}  {'FLIPS' if det < 0 else 'ok'}")
```

A transform with a negative determinant reverses winding, and that is the mechanical cause of most inversions in a multi-stage pipeline. A mirror, a left-handed-to-right-handed conversion, and an axis swap done with the wrong sign all have determinant −1, and applying one silently turns every outward face inward.

The Y-up to Z-up conversion is the specific trap. The correct matrix has determinant +1 and the naive one — swapping Y and Z without negating — has determinant −1, so a pipeline that "fixes" the up axis by exchanging two rows reverses every face in the process.

Checking the **cumulative** determinant matters because two flips cancel. A pipeline with a mirror at stage 3 and another at stage 6 produces correct output, and fixing only one breaks it — which is exactly the kind of change that makes a "fix" produce a new bug report.

<figure class="diagram">
<svg viewBox="4 6 732 240" role="img" aria-labelledby="normals-det-t normals-det-d" xmlns="http://www.w3.org/2000/svg">
  <title id="normals-det-t">Transforms that reverse winding, and the cumulative effect</title>
  <desc id="normals-det-d">A table of four transform matrices with their determinants. The correct Y-up to Z-up rotation has determinant plus one and preserves winding. The naive version that swaps rows without negating one has determinant minus one and flips it. A mirror on the X axis has determinant minus one. A left-handed to right-handed conversion has determinant minus one. The cumulative row shows that two flips in a pipeline cancel, so fixing only one of them breaks output that currently looks correct.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="286" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="304" y="20" width="130" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="434" y="20" width="288" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="286" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="304" y="52" width="130" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="434" y="52" width="288" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="84" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="304" y="84" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="434" y="84" width="288" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="116" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="304" y="116" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="434" y="116" width="288" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="148" width="286" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="304" y="148" width="130" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="434" y="148" width="288" height="32" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="161" y="41">transform</text><text x="369" y="41">determinant</text>
    <text x="578" y="41">effect on winding</text>
    <text x="161" y="73">correct Y-up to Z-up rotation</text>
    <text x="369" y="73">+1</text><text x="578" y="73">preserved</text>
    <text x="161" y="105">Y and Z swapped, neither negated</text>
    <text x="369" y="105">−1</text><text x="578" y="105">reversed — the classic mistake</text>
    <text x="161" y="137">mirror on X</text>
    <text x="369" y="137">−1</text><text x="578" y="137">reversed</text>
    <text x="161" y="169">left-handed to right-handed</text>
    <text x="369" y="169">−1</text><text x="578" y="169">reversed</text>
  </g>
  <text x="18" y="206" fill="#1f2937" font-size="12.5">two flipping stages in one pipeline cancel: the cumulative determinant returns to +1</text>
  <text x="18" y="228" fill="#5b6471" font-size="12">so fixing one of them breaks output that currently looks correct — fix all or none</text>
</svg>
<figcaption>A determinant of −1 is the mechanical cause; checking the cumulative product is what stops a fix from becoming a regression.</figcaption>
</figure>

### 5. Test at every handoff and bisect

```python
def stage_probe(path, label, expected_closed=None):
    mesh = trimesh.load(path, process=False, force="mesh")
    winding = winding_report(mesh)
    normals = normal_consistency_report(mesh)
    parity = ray_parity_report(mesh) if mesh.is_watertight else {"applicable": False}
    heuristic = (outward_orientation_report(mesh)
                 if not mesh.is_watertight else {"skipped": "closed mesh"})

    inverted = None
    if winding.get("winding_outward") is False:
        inverted = "winding_reversed"
    elif normals.get("opposed_share", 0.0) > 0.9:
        inverted = "winding_and_normals_disagree"
    elif normals.get("opposed_share", 0.0) > 0.05:
        inverted = "patchwise_normals_flipped"
    elif heuristic.get("verdict", "").endswith("INWARD"):
        inverted = "winding_reversed_open_mesh"

    return {
        "stage": label,
        "path": str(path),
        "faces": winding["faces"],
        "watertight": winding["watertight"],
        "signed_volume_m3": winding["signed_volume_m3"],
        "opposed_share": normals.get("opposed_share"),
        "parity_consistent": parity.get("consistent"),
        "heuristic": heuristic.get("verdict"),
        "inverted": inverted,
        "clean": inverted is None,
    }

def bisect_pipeline(stage_paths):
    """stage_paths: ordered [(label, path), ...] from source to output."""
    probes = [stage_probe(path, label) for label, path in stage_paths]
    first_bad = next((i for i, p in enumerate(probes) if not p["clean"]), None)
    if first_bad is None:
        return {"probes": probes, "culprit": None,
                "verdict": "no stage inverted anything; look at the material and "
                           "the renderer's culling"}
    culprit = probes[first_bad]
    previous = probes[first_bad - 1] if first_bad > 0 else None
    return {
        "probes": probes,
        "culprit_stage": culprit["stage"],
        "culprit_index": first_bad,
        "problem": culprit["inverted"],
        "was_clean_before": previous["stage"] if previous else "source is already bad",
        "verdict": (f"'{culprit['stage']}' introduced {culprit['inverted']}"
                    if previous
                    else f"the source mesh already has {culprit['inverted']}"),
    }
```

Probing at every handoff and taking the **first** failing stage is the whole method. A pipeline of eight stages has eight candidate culprits, and testing the output tells you only that something went wrong; testing each boundary tells you which one.

Saving intermediates is the prerequisite and is worth the disk. A pipeline that writes `stage_1_cleaned.ply`, `stage_2_decimated.ply` and so on can be bisected in one run of this function, and one that writes only its final output cannot be diagnosed at all without re-running it repeatedly.

The "source is already bad" case is worth calling out separately, because it happens and it redirects the investigation entirely — to the scanner's export settings or the vendor's delivery rather than to your code.

### 6. Fix the identified problem, and only that one

```python
def fix_winding(mesh_path, out_path):
    mesh = trimesh.load(mesh_path, process=False, force="mesh")
    before = winding_report(mesh)
    faces = np.asarray(mesh.faces)[:, ::-1]
    fixed = trimesh.Trimesh(vertices=mesh.vertices, faces=faces, process=False)
    fixed.export(out_path)
    return {"before": before, "after": winding_report(fixed),
             "action": "reversed the face index order"}

def fix_normals_from_winding(mesh_path, out_path):
    mesh = trimesh.load(mesh_path, process=False, force="mesh")
    before = normal_consistency_report(mesh)
    fixed = trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces,
                            process=False)
    fixed.rezero() if False else None
    fixed.vertex_normals = None                 # force recomputation
    _ = fixed.vertex_normals                     # trimesh recomputes from winding
    fixed.export(out_path)
    return {"before": before, "after": normal_consistency_report(fixed),
             "action": "recomputed vertex normals from the face winding"}

def fix_with_pymeshlab(mesh_path, out_path, reorient=True):
    """For a patchwise problem, propagate a consistent orientation."""
    import pymeshlab as ml
    ms = ml.MeshSet()
    ms.load_new_mesh(str(mesh_path))
    ms.apply_filter("meshing_remove_duplicate_vertices")
    ms.apply_filter("meshing_remove_null_faces")
    if reorient:
        ms.apply_filter("meshing_re_orient_faces_coherently")
    ms.apply_filter("compute_normal_per_vertex")
    ms.save_current_mesh(str(out_path))
    mesh = trimesh.load(out_path, process=False, force="mesh")
    return {"action": "re-oriented faces coherently and recomputed normals",
            "winding": winding_report(mesh),
            "normals": normal_consistency_report(mesh)}

FIX_FOR = {
    "winding_reversed": fix_winding,
    "winding_reversed_open_mesh": fix_winding,
    "winding_and_normals_disagree": fix_normals_from_winding,
    "patchwise_normals_flipped": fix_with_pymeshlab,
}

def apply_fix(bisect_result, stage_paths, out_dir="build/fixed"):
    problem = bisect_result.get("problem")
    if problem is None:
        return {"action": "none", "reason": bisect_result["verdict"]}
    fixer = FIX_FOR.get(problem)
    if fixer is None:
        return {"action": "none", "reason": f"no automatic fix for {problem}"}
    label, path = stage_paths[bisect_result["culprit_index"]]
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    out = Path(out_dir) / f"{label}_fixed{Path(path).suffix}"
    result = fixer(path, out)
    return {"problem": problem, "stage": label, "output": str(out), **result}
```

Applying the fix that matches the diagnosed problem — and not a different one — is the discipline this page exists to enforce. `fix_winding` on a mesh whose problem is flipped stored normals converts a lighting bug into a culling bug, and the report says the geometry changed, so it looks like progress.

Fixing at the **culprit stage** rather than at the output is the other half. Reversing the winding on the final GLB works and leaves the bug in the pipeline, so it returns with the next delivery; fixing the stage that introduced it fixes it permanently.

`meshing_re_orient_faces_coherently` in PyMeshLab is the right tool for the patchwise case, because it propagates a consistent orientation across the mesh rather than applying a uniform flip — which is what a patchwise problem needs and what a wholesale reversal cannot do.

<figure class="diagram">
<svg viewBox="0 48 740 208" role="img" aria-labelledby="normals-bisect-t normals-bisect-d" xmlns="http://www.w3.org/2000/svg">
  <title id="normals-bisect-t">Bisecting an eight-stage pipeline</title>
  <desc id="normals-bisect-d">Eight pipeline stages tested in order. The source scan, cleaning, decimation and planar simplification all pass. The coordinate conversion stage fails with a negative signed volume, because its Y-up to Z-up matrix has determinant minus one. The texture projection, glTF export and tiling stages inherit the problem. The first failing stage is the culprit, and fixing the matrix there fixes every stage after it.</desc>
  <rect class="svg-bg" x="0" y="48" width="740" height="208" fill="#ffffff"/>
  <defs>
    <marker id="normals-bisect-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.6">
    <rect x="16" y="64" width="80" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="106" y="64" width="80" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="196" y="64" width="80" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="64" width="80" height="52" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="376" y="64" width="96" height="52" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2.6"/>
    <rect x="482" y="64" width="80" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="572" y="64" width="72" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="654" y="64" width="72" height="52" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.6" fill="none" marker-end="url(#normals-bisect-arrow)">
    <path d="M96 90 H104"/><path d="M186 90 H194"/><path d="M276 90 H284"/>
    <path d="M366 90 H374"/><path d="M472 90 H480"/><path d="M562 90 H570"/>
    <path d="M644 90 H652"/>
  </g>
  <g fill="#1f2937" font-size="11" text-anchor="middle">
    <text x="56" y="86">scan</text><text x="56" y="102">✓</text>
    <text x="146" y="86">clean</text><text x="146" y="102">✓</text>
    <text x="236" y="86">decimate</text><text x="236" y="102">✓</text>
    <text x="326" y="86">planar</text><text x="326" y="102">✓</text>
    <text x="424" y="80">CRS convert</text><text x="424" y="96">✗ det −1</text>
    <text x="522" y="86">texture</text><text x="522" y="102">✗</text>
    <text x="608" y="86">glTF</text><text x="608" y="102">✗</text>
    <text x="690" y="86">tile</text><text x="690" y="102">✗</text>
  </g>
  <path d="M424 122 V148" stroke="#b0413e" stroke-width="2" fill="none"/>
  <text x="424" y="166" fill="#b0413e" font-size="12.5" text-anchor="middle">first failing stage — the culprit</text>
  <text x="424" y="188" fill="#1f2937" font-size="12.5" text-anchor="middle">its Y-up to Z-up matrix swaps rows without negating one</text>
  <text x="370" y="220" fill="#1f2937" font-size="12.5" text-anchor="middle">the three stages after it inherit the problem and are not at fault</text>
  <text x="370" y="240" fill="#5b6471" font-size="12" text-anchor="middle">fixing the output instead of the culprit leaves the bug for the next delivery</text>
</svg>
<figcaption>Four stages pass, one fails and three inherit; only the first failure is worth fixing.</figcaption>
</figure>

## Expected Output & Verification

```text
correct_y_up_to_z_up            det +1.0  ok
y_up_to_z_up_wrong_sign         det -1.0  FLIPS
mirror_x                        det -1.0  FLIPS
left_to_right_handed            det -1.0  FLIPS
{
  "stages": [
    {"stage": "scan_export", "determinant": 1.0, "flips_winding": false,
     "cumulative_determinant": 1.0, "cumulative_flips": false},
    {"stage": "crs_convert", "determinant": -1.0, "flips_winding": true,
     "cumulative_determinant": -1.0, "cumulative_flips": true},
    {"stage": "tile_transform", "determinant": 1.0, "flips_winding": false,
     "cumulative_determinant": -1.0, "cumulative_flips": true}
  ],
  "stages_that_flip": ["crs_convert"],
  "net_flip": true,
  "verdict": "1 stage(s) flip the winding; net effect is a flip"
}
{
  "probes": [
    {"stage": "scan", "faces": 412084, "watertight": false,
     "signed_volume_m3": 18412.4, "opposed_share": 0.0012,
     "heuristic": "winding faces outward", "inverted": null, "clean": true},
    {"stage": "clean", "faces": 411802, "opposed_share": 0.0011,
     "heuristic": "winding faces outward", "inverted": null, "clean": true},
    {"stage": "decimate", "faces": 100000, "opposed_share": 0.0014,
     "heuristic": "winding faces outward", "inverted": null, "clean": true},
    {"stage": "planar", "faces": 1840, "opposed_share": 0.0000,
     "heuristic": "winding faces outward", "inverted": null, "clean": true},
    {"stage": "crs_convert", "faces": 1840, "signed_volume_m3": -18398.1,
     "opposed_share": 0.9984, "heuristic": "winding faces INWARD",
     "inverted": "winding_and_normals_disagree", "clean": false}
  ],
  "culprit_stage": "crs_convert",
  "culprit_index": 4,
  "problem": "winding_and_normals_disagree",
  "was_clean_before": "planar",
  "verdict": "'crs_convert' introduced winding_and_normals_disagree"
}
```

The transform report and the bisect agree, which is the confirmation worth having: a determinant of −1 at `crs_convert` and the first failing probe at the same stage. The matrix swaps Y and Z without negating one of them, which is the naive Y-up to Z-up conversion.

The `opposed_share` of 0.9984 identifies the problem as the third kind — winding and normals contradicting — because the transform reversed the winding while leaving the stored normals untouched. Reversing the faces would leave the normals still wrong; recomputing the normals from the corrected winding is the fix.

Verify the fix at every stage, not just at the culprit:

```python
def verify_after_fix(stage_paths, fixed_stage_index, out_dir="build/fixed"):
    """Re-run the whole pipeline probe after fixing the culprit."""
    probes = [stage_probe(path, label) for label, path in stage_paths]
    still_bad = [p for p in probes if not p["clean"]]
    return {
        "stages": len(probes),
        "still_failing": [p["stage"] for p in still_bad],
        "fixed_stage": stage_paths[fixed_stage_index][0],
        "all_clean": not still_bad,
        "verdict": ("every stage is clean" if not still_bad
                    else f"{len(still_bad)} stage(s) still fail — either the fix was "
                         f"applied to the output rather than the pipeline, or there "
                         f"is a second flip downstream"),
    }

def double_flip_check(matrices):
    """Two flips cancel; fixing one of them breaks a pipeline that worked."""
    report = transform_report(matrices)
    flipping = report["stages_that_flip"]
    return {
        "flipping_stages": flipping,
        "count": len(flipping),
        "net_flip": report["net_flip"],
        "warning": ("two or more stages flip the winding and they cancel — fixing "
                    "one of them will break output that currently looks correct; "
                    "fix all of them or none"
                    if len(flipping) >= 2 and not report["net_flip"] else None),
        "advice": ("remove every negative-determinant transform and re-test"
                   if len(flipping) >= 2 else "fix the single flipping stage"),
    }
```

The double-flip warning is the one that saves a regression. A pipeline with two cancelling flips produces correct output, and a well-meaning fix to one of them introduces the bug — so the check reports the situation explicitly rather than letting someone discover it.

Then verify the renderer's own view, because the geometric tests and the visible result can still disagree:

```javascript
export async function rendererVerification(viewer, tilesetUrl) {
  const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
    maximumScreenSpaceError: 16,
  });
  viewer.scene.primitives.add(tileset);
  await new Promise((r) => {
    const tick = () => (tileset.tilesLoaded ? r() : requestAnimationFrame(tick));
    tick();
  });

  const materials = [];
  for (const tile of tileset._selectedTiles ?? []) {
    const gltf = tile.content?._model?.gltf ?? tile.content?.gltf;
    for (const material of gltf?.materials ?? []) {
      materials.push({
        name: material.name ?? '(unnamed)',
        doubleSided: Boolean(material.doubleSided),
        alphaMode: material.alphaMode ?? 'OPAQUE',
      });
    }
  }
  const doubleSidedShare = materials.length
    ? materials.filter((m) => m.doubleSided).length / materials.length : 0;

  viewer.scene.primitives.remove(tileset);
  return {
    materials: materials.length,
    doubleSidedShare: Number(doubleSidedShare.toFixed(3)),
    backFaceCulling: viewer.scene.globe?.backFaceCulling ?? null,
    finding: doubleSidedShare > 0.5
      ? 'most materials are double-sided, so a winding error would be invisible '
        + 'here and visible in a renderer that culls'
      : 'materials cull backfaces, so the geometric tests match what is rendered',
  };
}
```

A tileset whose materials are mostly `doubleSided` hides a winding error completely, which is the fourth problem in the table seen from the other direction: the geometry is wrong and the renderer forgives it. That matters because the next consumer — a game engine, an analysis tool, a different viewer — will not.

## Performance Notes

- **Signed volume is O(faces)** and vectorised; a 400,000-face mesh takes milliseconds.
- **`mesh.contains` builds a ray-tracing structure** and is the slow test at roughly 20,000 queries per second. Two thousand samples is enough.
- **The normal-consistency test is pure NumPy** and handles millions of faces in under a second; sample only for very large meshes.
- **The outward heuristic needs a KD-tree query per sample**, so 20,000 samples is about a second.
- **Probe at every handoff, not every operation.** Eight probes on a pipeline is seconds; probing inside a decimation loop is not useful.
- **Write intermediates during development and turn them off in production.** The disk cost is real and the diagnostic value only matters when something is wrong.

## Common Errors

**Reversing the faces made the lighting wrong.** The problem was flipped stored normals, not winding. Recompute the normals instead.

**Signed volume is near zero on a closed mesh.** The winding is inconsistent rather than uniformly reversed; use `meshing_re_orient_faces_coherently`.

**Every stage reports `watertight: false`.** Normal for surveyed surfaces. Rely on the normal-consistency test and the heuristic.

**The heuristic says "ambiguous".** The surface is flat or thin, where stepping along the normal does not change the distance to other faces. Not a failure of the mesh.

**The fix works and the next delivery is broken again.** The fix was applied to the output, not to the culprit stage.

**Fixing one flip broke everything.** Two flips were cancelling. Run the double-flip check first.

**The geometric tests pass and the viewer still looks wrong.** Check the material's `doubleSided` flag and the renderer's culling; the geometry is not the problem.

## Frequently Asked Questions

### Which is authoritative, the winding or the normals?

The winding, for tile content. Renderers cull on winding, and glTF's own convention is counter-clockwise front faces — so the winding is the ground truth and the normals should be recomputed to match it.

### Should I just make every material double-sided?

No. It doubles the rasterisation cost, defeats backface culling entirely and hides the underlying defect from every consumer downstream. It is a legitimate choice for genuinely single-surface geometry such as a fence panel.

### How do I stop this recurring?

Add the stage probe to the pipeline's tests, as in [testing spatial pipelines with pytest fixtures](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/testing-spatial-pipelines-with-pytest-fixtures/): a synthetic closed mesh through every stage with a signed-volume assertion catches a new negative-determinant transform on the commit that introduces it.

## Related Guides

- [Tracing Unit Errors from Feet to Metres](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracing-unit-errors-from-feet-to-metres/) — the same bisect method for a different cross-cutting defect
- [Trimming Poisson Meshes by Density](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/trimming-poisson-meshes-by-density/) — the reconstruction that fails visibly on inconsistent normals
- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — where a flatten step can introduce a flip

Back to [Cross-Section Failure Modes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).
