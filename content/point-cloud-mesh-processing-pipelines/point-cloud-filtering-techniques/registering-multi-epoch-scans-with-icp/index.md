# Registering Multi-Epoch Scans with ICP

This page aligns two survey epochs of the same site with iterative closest point, and does the one thing that makes multi-epoch registration different from ordinary registration: it restricts the fit to surfaces that did not change, so the algorithm cannot absorb real ground movement into the transform. An ICP run over everything will happily rotate a subsidence signal out of existence and report an excellent fitness score while doing it.

## Why you hit this

Two surveys of the same site never share a datum realisation exactly. Different base stations, different GNSS constellations, a plate that moved, a control network that was readjusted — the result is a rigid offset of a few centimetres that has nothing to do with the ground. Removing it is necessary before any comparison. The trap is that ICP has no way to distinguish that offset from a real change, so given a scene where a quarry face retreated ten metres, it will split the difference and put part of the retreat into the transform.

The epoch-level part of this is in [transforming between epoch-based datums](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/transforming-between-epoch-based-datums/); what follows removes what is left after that.

## Prerequisites

- Python 3.10+ with `open3d>=0.18`, `numpy>=1.24`, `laspy>=2.5` and `scipy>=1.11`.
- Both epochs in the same projected metric CRS and, ideally, already propagated to a common coordinate epoch.
- Both filtered for outliers, per [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — ICP is a least-squares fit and a stray point pulls it.
- Some knowledge of what is expected to be stable: buildings, road surfaces, hard standing.

## Step-by-Step

### 1. Load both epochs and shift to a shared local origin

```python
import laspy
import numpy as np
import open3d as o3d

def load(path, origin=None):
    las = laspy.read(path)
    xyz = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])
    cls = np.asarray(las.classification)
    if origin is None:
        origin = xyz.mean(axis=0)
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz - origin)
    return pcd, cls, origin

target, cls_t, origin = load("epoch_2019.laz")
source, cls_s, _ = load("epoch_2025.laz", origin=origin)
print(f"target {len(target.points):,} | source {len(source.points):,}")
```

Both clouds must use the *same* origin, or the transform ICP finds includes the difference between two origins and is meaningless outside this script. Passing the target's origin into the source load is the whole precaution.

### 2. Mask to surfaces you expect to be stable

This is the step that separates multi-epoch registration from ordinary registration.

```python
import numpy as np
import open3d as o3d

STABLE_CLASSES = (6, 11)          # buildings and road surface

def stable_subset(pcd, cls, keep=STABLE_CLASSES, voxel=0.25):
    mask = np.isin(cls, keep)
    sub = pcd.select_by_index(np.flatnonzero(mask))
    return sub.voxel_down_sample(voxel)

t_stable = stable_subset(target, cls_t)
s_stable = stable_subset(source, cls_s)
print(f"stable subset: target {len(t_stable.points):,}, source {len(s_stable.points):,} "
      f"({100 * len(t_stable.points) / len(target.points):.1f}% of the cloud)")
```

Buildings and hard standing are the right default: they are rigid, they are planar enough for point-to-plane ICP to converge quickly, and they are the parts of a site least likely to have moved. Vegetation is the worst possible choice — it changes seasonally and its returns are not repeatable between flights.

<figure class="diagram">
<svg viewBox="22 25 698 223" role="img" aria-labelledby="ic-mask-t ic-mask-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ic-mask-t">Fitting on everything absorbs real change into the transform</title>
  <desc id="ic-mask-d">When the fit includes a quarry face that genuinely retreated, ICP minimises total distance by shifting the whole cloud toward it, so part of the real movement disappears into the transform and the buildings end up misaligned. Restricting the fit to buildings and hard standing leaves the retreat entirely in the residual, where it belongs.</desc>
  <rect class="svg-bg" x="22" y="25" width="698" height="223" fill="#ffffff"/>
  <path d="M50 170 h120 v-70 h-120 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M210 170 L260 120 L320 170 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M226 170 L276 120 L336 170 Z" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M56 170 h120 v-70 h-120 Z" fill="none" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="5 4"/>
  <text x="110" y="196" fill="#1f6b8a" font-size="12" text-anchor="middle">building</text>
  <text x="275" y="216" fill="#b0413e" font-size="12" text-anchor="middle">quarry face, retreated</text>
  <path d="M420 170 h120 v-70 h-120 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M580 170 L630 120 L690 170 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M596 170 L646 120 L706 170 Z" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="5 4"/>
  <text x="480" y="196" fill="#4f7a4d" font-size="12" text-anchor="middle">aligned exactly</text>
  <text x="645" y="216" fill="#4f7a4d" font-size="12" text-anchor="middle">retreat preserved</text>
  <text x="200" y="52" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">fit on everything</text>
  <text x="560" y="52" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">fit on stable classes only</text>
  <text x="370" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">The left fit reports better fitness, because it minimised total distance — including the distance that was the finding</text>
</svg>
<figcaption>ICP has no concept of &quot;should not have moved&quot;. Supplying it is the mask, and without it a better fitness score means a worse answer.</figcaption>
</figure>

### 3. Run a coarse-to-fine registration

Starting fine on a cloud that is decimetres out converges slowly or to a local minimum. A voxel ladder fixes both.

```python
import numpy as np
import open3d as o3d

def register(source, target, voxels=(1.0, 0.5, 0.25, 0.1), max_corr_factor=3.0):
    T = np.eye(4)
    for v in voxels:
        s = source.voxel_down_sample(v)
        t = target.voxel_down_sample(v)
        for p in (s, t):
            p.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=v * 3, max_nn=30))
        res = o3d.pipelines.registration.registration_icp(
            s, t, max_correspondence_distance=v * max_corr_factor, init=T,
            estimation_method=o3d.pipelines.registration.TransformationEstimationPointToPlane(),
            criteria=o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=60))
        T = res.transformation
        print(f"voxel {v:4.2f}  fitness {res.fitness:.4f}  rmse {res.inlier_rmse*1000:6.1f} mm")
    return T, res

T, result = register(s_stable, t_stable)
```

Point-to-plane rather than point-to-point is the right estimator here and converges in a fraction of the iterations, because both clouds are dominated by planar surfaces — roofs, walls, roads — and the plane constraint gives each correspondence far more information than a point does.

<figure class="diagram">
<svg viewBox="-10 42 760 204" role="img" aria-labelledby="ic-ladder-t ic-ladder-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ic-ladder-t">Why the voxel ladder converges where a single fine pass does not</title>
  <desc id="ic-ladder-d">A fine correspondence distance applied to a cloud that is decimetres out finds correspondences only within that distance, so most points have no partner and the fit converges to a local minimum. Starting coarse admits the true correspondences, and each finer rung refines a fit that is already close.</desc>
  <rect class="svg-bg" x="-10" y="42" width="760" height="204" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="52" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="94" width="124" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="132" width="240" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="170" width="380" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="122" y="75">voxel 1.00 m — fitness 0.914, rmse 184 mm</text>
    <text x="194" y="113">voxel 0.50 m — fitness 0.939, rmse 93 mm</text>
    <text x="310" y="151">voxel 0.25 m — fitness 0.951, rmse 42 mm</text>
    <text x="450" y="189">voxel 0.10 m — fitness 0.960, rmse 15 mm</text>
  </g>
  <text x="370" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">Fitness rising while RMSE falls is convergence. Fitness that falls at a finer rung means the ladder needs another step above it.</text>
</svg>
<figcaption>Each rung hands the next a fit already inside its correspondence distance, which is what keeps the search out of a local minimum.</figcaption>
</figure>

### 4. Read the transform before applying it

A rigid transform between two epochs of the same site should be small. If it is not, something upstream is wrong and applying it will hide that.

```python
import numpy as np

def describe(T):
    R, t = T[:3, :3], T[:3, 3]
    angle = np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1)))
    return {"translation_mm": np.round(t * 1000, 1),
            "magnitude_mm": round(float(np.linalg.norm(t)) * 1000, 1),
            "rotation_deg": round(float(angle), 5)}

d = describe(T)
print(d)
assert d["magnitude_mm"] < 500, "half a metre of shift — check the CRS and epoch first"
assert d["rotation_deg"] < 0.05, "measurable rotation between epochs — check the control network"
```

A rotation above a few thousandths of a degree is not a datum offset; it is a control-network problem or a trajectory error, and registering it away removes the evidence. A translation above a few decimetres usually means the epochs are in different vertical datums, which belongs in the [datum work](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) rather than in ICP.

<figure class="diagram">
<svg viewBox="16 42 605 214" role="img" aria-labelledby="ic-read-t ic-read-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ic-read-t">What the recovered transform is telling you</title>
  <desc id="ic-read-d">A translation of a few centimetres with negligible rotation is the expected datum offset between two epochs. A translation of tens of centimetres suggests different vertical datums. Any measurable rotation points at the control network or the trajectory, and registering it away removes the evidence rather than the problem.</desc>
  <rect class="svg-bg" x="16" y="42" width="605" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="250" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="98" width="250" height="34" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="30" y="140" width="250" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="30" y="182" width="250" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="155" y="78">&lt; 50 mm, no rotation</text>
    <text x="155" y="120">100–500 mm vertical</text>
    <text x="155" y="162">rotation &gt; 0.05°</text>
    <text x="155" y="204">&gt; 1 m in any axis</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="300" y="78">expected datum offset — apply it</text>
    <text x="300" y="120">different vertical datums — fix upstream</text>
    <text x="300" y="162">control network or trajectory — investigate</text>
    <text x="300" y="204">wrong CRS or wrong tile — do not apply</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Only the top row is ICP&#39;s job. The other three are problems it will happily conceal.</text>
</svg>
<figcaption>The transform is a diagnostic before it is a correction. Applying it without reading it is how an upstream fault becomes permanent.</figcaption>
</figure>

### 5. Compute residuals on everything, not on the stable subset

The fit used the stable classes. The comparison uses the whole cloud, and that is where the change lives.

```python
import numpy as np
import open3d as o3d

source.transform(T)
tree = o3d.geometry.KDTreeFlann(target)

pts = np.asarray(source.points)
rng = np.random.default_rng(0)
sample = rng.choice(len(pts), size=min(500_000, len(pts)), replace=False)

residual = np.empty(len(sample))
for i, idx in enumerate(sample):
    _, nn, d2 = tree.search_knn_vector_3d(pts[idx], 1)
    residual[i] = np.sqrt(d2[0])

stable_mask = np.isin(cls_s[sample], STABLE_CLASSES)
print(f"stable surfaces : median {np.median(residual[stable_mask])*1000:6.1f} mm")
print(f"everything else : median {np.median(residual[~stable_mask])*1000:6.1f} mm, "
      f"p99 {np.percentile(residual[~stable_mask], 99)*1000:.0f} mm")
```

The two numbers are the result. A small residual on the stable classes says the registration succeeded; a much larger one elsewhere says the site changed, and the spatial distribution of that residual is the change map.

## Expected Output & Verification

A representative run over two epochs of a quarry site:

```text
target 412,118,904 | source 398,220,116
stable subset: target 8,204,118, source 7,988,402 (2.0% of the cloud)
voxel 1.00  fitness 0.9142  rmse  184.2 mm
voxel 0.50  fitness 0.9388  rmse   92.6 mm
voxel 0.25  fitness 0.9511  rmse   41.8 mm
voxel 0.10  fitness 0.9604  rmse   14.7 mm
{'translation_mm': array([ 18.4, -11.2,  31.7]), 'magnitude_mm': 38.6, 'rotation_deg': 0.0021}
stable surfaces : median   12.8 mm
everything else : median   61.4 mm, p99 9840 mm
```

Read four things. Fitness rising and RMSE falling monotonically down the ladder is convergence; a fitness that falls at a finer voxel means the correspondence distance is now smaller than the residual offset and the ladder needs another rung. The 38.6 mm translation with negligible rotation is a textbook datum offset. The 12.8 mm stable residual is the registration's real accuracy. And the 9.84 m p99 elsewhere is the quarry face — the finding, preserved intact because it was never in the fit.

## Common Errors

**Fitness is high and the buildings are visibly misaligned.** The fit included changed ground, so ICP traded building alignment for total distance. Restrict to stable classes.

**ICP converges to something absurd.** The initial offset exceeded the coarsest correspondence distance. Add a coarser rung, or seed with a rough alignment from control points or from `registration_ransac_based_on_feature_matching`.

**Every residual is large and uniform.** The two epochs are in different vertical datums, so the whole cloud is offset. ICP will absorb it into the translation and hide a datum problem that should have been fixed explicitly.

**The result is not reproducible.** The clouds were downsampled with different origins, or `voxel_down_sample` was applied after the transform in one run and before in another. Fix the origin once and the ladder deterministically.

## Frequently Asked Questions

### How much of the cloud should the stable subset be?
Enough to constrain six degrees of freedom well — a few per cent of a city scan is ample, provided it is spatially distributed. Stable surfaces clustered in one corner constrain rotation poorly however many points they contain.

### Should I use ICP at all if both epochs have good control?
Often not. If both surveys tie to the same control network to a centimetre, the residual offset is already inside your tolerance and registering will move real change. Measure the offset on stable surfaces first and only register if it is material.

### Can this detect change directly?
The residual field is a change map, and for many purposes that is enough. Where a signed distance is needed — subsidence in millimetres, volume gained or lost — a normal-projected distance such as M3C2 is the better measure, because a nearest-neighbour residual is unsigned and biased on sloped surfaces.

A final note on what to record. The transform, the stable-class mask, the voxel ladder and the resulting stable-surface residual together are the provenance of every comparison made afterwards — and a change map produced from an unrecorded registration cannot be defended or reproduced. Four small values in the artifact's metadata are enough, and they are the difference between "the quarry lost 9.8 metres" and "the quarry lost 9.8 metres, measured against a registration accurate to 13 millimetres on stable surfaces".

## Related Guides

- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — the outlier removal that must precede a least-squares fit
- [Transforming Between Epoch-Based Datums](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/transforming-between-epoch-based-datums/) — removing plate motion before ICP sees it
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — the cause of a large uniform vertical residual

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
