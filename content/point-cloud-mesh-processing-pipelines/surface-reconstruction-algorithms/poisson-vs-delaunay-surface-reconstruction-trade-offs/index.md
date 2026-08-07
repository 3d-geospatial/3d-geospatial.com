# Poisson vs Delaunay Surface Reconstruction Trade-offs

Screened Poisson and the Delaunay family — ball-pivoting (BPA) and alpha shapes — reconstruct a surface from the same oriented point cloud but answer fundamentally different questions. Poisson fits a single continuous implicit function and returns a watertight, noise-averaged shell that may invent geometry over gaps; Delaunay/BPA interpolates the exact measured points and returns an open surface with honest holes and preserved sharp edges. This page decides between them for LiDAR and photogrammetry meshes in a metric CRS such as EPSG:32618 (UTM zone 18N), weighing their behaviour on noise, holes, sharp edges, and non-uniform density, comparing the parameters that control each (`depth` for Poisson, ball radii for BPA), and closing with a verdict on which wins for which asset class.

You reach this decision after cleaning a cloud and before committing a reconstruction algorithm to your pipeline. The single-parameter tuning of one algorithm belongs in [Poisson surface reconstruction parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/); the question here is prior to that — which of the two philosophies your data and your downstream use actually want.

<figure class="diagram">
<svg viewBox="26 6 768 326" role="img" aria-labelledby="pvd-t pvd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pvd-t">Decision diagram for Poisson versus Delaunay reconstruction</title>
  <desc id="pvd-d">A top decision node asks what the surface must guarantee; a left branch to closure selects screened Poisson with a depth ladder and density trimming, and a right branch to fidelity selects Delaunay or ball-pivoting with spacing-derived radii and open holes.</desc>
  <rect class="svg-bg" x="26" y="6" width="768" height="326" fill="#ffffff"/>
  <defs>
    <marker id="pvd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="290" y="20" width="240" height="58" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pvd-arrow)">
    <line x1="360" y1="78" x2="220" y2="146"/>
    <line x1="460" y1="78" x2="620" y2="146"/>
  </g>
  <rect x="40" y="150" width="320" height="64" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="460" y="150" width="320" height="64" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pvd-arrow)">
    <line x1="200" y1="214" x2="200" y2="256"/>
    <line x1="620" y1="214" x2="620" y2="256"/>
  </g>
  <rect x="40" y="258" width="320" height="60" rx="8" fill="#ffffff" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="460" y="258" width="320" height="60" rx="8" fill="#ffffff" stroke="#c46a3d" stroke-width="2"/>
  <g text-anchor="middle" font-size="13" fill="#15384a">
    <text x="410" y="45">What must the surface</text>
    <text x="410" y="63">guarantee?</text>
  </g>
  <g text-anchor="middle" font-size="13" fill="#1f2937">
    <text x="200" y="176">Closure — simulation,</text>
    <text x="200" y="194">volumetrics, watertight</text>
    <text x="200" y="210">&#8594; screened Poisson</text>
    <text x="620" y="176">Fidelity — as-built,</text>
    <text x="620" y="194">sharp edges, honest holes</text>
    <text x="620" y="210">&#8594; Delaunay / BPA</text>
  </g>
  <g text-anchor="middle" font-size="12" fill="#1f2937">
    <text x="200" y="284">depth ladder averages noise,</text>
    <text x="200" y="302">trim low-density bubbles</text>
    <text x="620" y="284">radii/alpha from point spacing,</text>
    <text x="620" y="302">gaps stay open, edges kept</text>
  </g>
</svg>
<figcaption>The choice hinges on what the twin needs: a guaranteed-closed shell (Poisson) or a surface faithful to the exact measured points (Delaunay/BPA).</figcaption>
</figure>

## Prerequisites

- `open3d>=0.17` with `numpy>=1.24` and `scipy>=1.10`: `pip install "open3d>=0.17" "numpy>=1.24" "scipy>=1.10"`.
- A filtered cloud with oriented normals, already in a projected metric CRS. Every radius, `alpha`, and voxel size below is in metres because the cloud is in EPSG:32618; in geographic EPSG:4326 the same numbers are degrees and both algorithms collapse.
- One shared input for a fair comparison. The examples reconstruct the identical `pcd` two ways so the trade-off is about the algorithm, not the data.

```python
import open3d as o3d
import numpy as np

pcd = o3d.io.read_point_cloud("facade_filtered_epsg32618.ply")  # metres, EPSG:32618
pcd.estimate_normals(
    search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.2, max_nn=30))
pcd.orient_normals_consistent_tangent_plane(k=30)
avg_spacing = float(np.mean(pcd.compute_nearest_neighbor_distance()))
print(f"mean spacing {avg_spacing:.4f} m — drives the BPA radii")
```

## How the two families differ, property by property

**Noise.** Poisson treats the normals as samples of a gradient field and solves for the surface that best fits them globally, so random per-point jitter averages out — the shell is smooth even on a noisy structure-from-motion cloud. Delaunay/BPA does the opposite: every retained vertex *is* an input point, so a noisy point becomes a noisy bump. On raw photogrammetry this is decisive — Poisson smooths, BPA reproduces the noise as real triangles.

**Holes and gaps.** Poisson must close the surface, so an occluded courtyard or a sparse rear facade comes back as a smooth extrapolated "bubble" you trim afterwards by density. BPA and alpha shapes only connect points a ball of finite radius can bridge, so a gap wider than the radius simply stays open. Whether that is a defect or the correct answer depends entirely on the twin: a flood model needs Poisson's closure, an as-built inspection needs the honest hole.

**Sharp edges.** Poisson's continuous field rounds off parapets, window reveals, and kerbs — the sharper the break, the more `depth` you must spend to keep it. Delaunay/BPA interpolates the actual corner points, so crisp architectural breaks survive without a resolution penalty. For CAD-aligned facades and footprints this favours the Delaunay family strongly.

**Non-uniform density.** Poisson's adaptive octree tolerates density variation gracefully; dense and sparse regions both resolve at the depth their point support allows. A single-radius ball, by contrast, cannot bridge both a dense wall and a thinned overlap, producing a lacy mesh — which is why BPA needs a *multi-radius* list anchored on the measured spacing to cope with the density variation Poisson absorbs for free.

## Reconstructing both to compare on your own data

### Poisson: the watertight, noise-averaging path

`depth` sets the octree resolution and is the primary lever; keep the per-vertex `densities` array to trim the extrapolated bubbles.

```python
mesh_p, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    pcd, depth=9, scale=1.1, linear_fit=False)
densities = np.asarray(densities)

# Trim the low-density skin Poisson invents over gaps.
mesh_p.remove_vertices_by_mask(densities < np.quantile(densities, 0.04))
mesh_p.remove_degenerate_triangles()
mesh_p.remove_non_manifold_edges()
print(f"Poisson: {len(mesh_p.triangles):,} tris, "
      f"watertight={mesh_p.is_watertight()}")
```

### Ball-pivoting: the interpolating, sharp-edge path

BPA radii are explicit distances in metres, derived from `avg_spacing` so the ball bridges both dense and slightly sparser regions.

```python
radii = [avg_spacing * r for r in (1.5, 2.0, 3.0)]
mesh_b = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
    pcd, o3d.utility.DoubleVector(radii))
mesh_b.remove_degenerate_triangles()
mesh_b.remove_duplicated_vertices()
print(f"BPA: {len(mesh_b.triangles):,} tris, "
      f"watertight={mesh_b.is_watertight()}")   # expect False by design
```

### A metric that tells you which one your data prefers

Rather than eyeball the two meshes, quantify the split. Count how much of the Poisson surface is low-density extrapolation (empty regions it had to fill) versus how much of the cloud BPA failed to connect. A high extrapolation fraction argues for BPA's honesty; a high unconnected fraction argues for Poisson's closure.

```python
from scipy.spatial import cKDTree

# Fraction of Poisson vertices supported by few points = invented surface.
extrapolated = float((densities < np.quantile(densities, 0.10)).mean())

# Fraction of input points BPA left unmeshed (no nearby BPA vertex).
bpa_v = np.asarray(mesh_b.vertices)
d, _ = cKDTree(bpa_v).query(np.asarray(pcd.points), k=1)
unconnected = float((d > radii[-1]).mean())

print(f"Poisson extrapolated ~{extrapolated:.1%} | "
      f"BPA left ~{unconnected:.1%} of points unmeshed")
```

<figure class="diagram">
<svg viewBox="-1 56 714 250" role="img" aria-labelledby="pv-noise-t pv-noise-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pv-noise-t">The one measurement that decides the family</title>
  <desc id="pv-noise-d">Compare the residual noise amplitude in the filtered cloud against the smallest feature the model must keep. When noise is well below the feature size, an interpolating method reproduces both. When noise approaches the feature size, no interpolating method can separate them and the averaging behaviour of an implicit solver is the only way through.</desc>
  <rect class="svg-bg" x="-1" y="56" width="714" height="250" fill="#ffffff"/>
  <path d="M60 210 H690" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 210 V70" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M60 210 L690 70" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M84 92 h250 v90 h-250 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M400 116 h270 v82 h-270 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="209" y="128"><tspan x="209" dy="0" font-weight="600">noise ≪ feature</tspan><tspan x="209" dy="17">ball pivoting or alpha shape</tspan><tspan x="209" dy="16">keeps the corner and the detail</tspan></text>
    <text x="535" y="146"><tspan x="535" dy="0" font-weight="600">noise ≈ feature</tspan><tspan x="535" dy="17">Poisson — averaging is the only</tspan><tspan x="535" dy="16">way to separate them</tspan></text>
  </g>
  <text x="375" y="240" fill="#5b6471" font-size="12" text-anchor="middle">residual noise amplitude after filtering (m)</text>
  <text x="34" y="140" fill="#5b6471" font-size="12" text-anchor="middle">feature</text>
  <text x="34" y="156" fill="#5b6471" font-size="12" text-anchor="middle">size</text>
  <text x="370" y="270" fill="#15384a" font-size="12.5" text-anchor="middle">Both numbers are measurable: noise from the plane-fit residual on a flat wall, feature size from the specification</text>
  <text x="370" y="288" fill="#5b6471" font-size="12" text-anchor="middle">Everything else — watertightness, speed, parameter count — follows from that one comparison</text>
</svg>
<figcaption>The debate is usually conducted in preferences. It resolves in one measurement per dataset, and the answer changes between a TLS scan and a UAV block.</figcaption>
</figure>

## Parameters that control each

Poisson exposes a smooth continuum of resolution through `depth` (each step roughly multiplies memory and runtime by up to 8x) plus `scale`, `linear_fit`, and the density-trim quantile — a coherent knob set covered in the [parameter-tuning guide](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/). BPA is controlled almost entirely by its radius list: too small and the ball falls through sparse patches leaving holes, too large and it bridges across real gaps and reintroduces the over-smoothing you switched away from Poisson to avoid. Alpha shapes have the single `alpha` radius with the same trade-off. The practical consequence is that Poisson degrades gracefully as you tune one number, while BPA is bimodal — a radius is either sufficient for a region or it is not — which is why BPA needs the multi-radius list and Poisson does not.

<figure class="diagram">
<svg viewBox="53 24 668 256" role="img" aria-labelledby="pv-hole-t pv-hole-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pv-hole-t">A real gap, reconstructed by each family</title>
  <desc id="pv-hole-d">A doorway with no returns behind it. Poisson always closes the surface, so it stretches a low-confidence shell across the opening that has to be trimmed away afterwards. Ball pivoting leaves the opening as a boundary, which is faithful but produces a mesh that is not watertight and cannot be used for volumetrics without a separate capping step.</desc>
  <rect class="svg-bg" x="53" y="24" width="668" height="256" fill="#ffffff"/>
  <g fill="#1f6b8a">
    <circle cx="70" cy="180" r="3"/><circle cx="104" cy="178" r="3"/><circle cx="138" cy="182" r="3"/>
    <circle cx="172" cy="176" r="3"/><circle cx="206" cy="180" r="3"/>
    <circle cx="300" cy="180" r="3"/><circle cx="334" cy="176" r="3"/>
  </g>
  <path d="M70 180 L206 178 M300 180 L334 176" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <path d="M206 178 C 240 150 268 150 300 180" fill="none" stroke="#c46a3d" stroke-width="2.5" stroke-dasharray="6 4"/>
  <g fill="#1f6b8a">
    <circle cx="440" cy="180" r="3"/><circle cx="474" cy="178" r="3"/><circle cx="508" cy="182" r="3"/>
    <circle cx="542" cy="176" r="3"/><circle cx="576" cy="180" r="3"/>
    <circle cx="670" cy="180" r="3"/><circle cx="704" cy="176" r="3"/>
  </g>
  <path d="M440 180 L576 178 M670 180 L704 176" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <text x="200" y="52" fill="#c46a3d" font-size="12.5" text-anchor="middle" font-weight="600">Poisson — always closes</text>
  <text x="570" y="52" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">ball pivoting — leaves the boundary</text>
  <text x="253" y="132" fill="#c46a3d" font-size="11.5" text-anchor="middle">invented shell</text>
  <text x="623" y="200" fill="#4f7a4d" font-size="11.5" text-anchor="middle">open</text>
  <text x="200" y="230" fill="#1f2937" font-size="12" text-anchor="middle">watertight, but the doorway is now a wall</text>
  <text x="570" y="230" fill="#1f2937" font-size="12" text-anchor="middle">faithful, but no volume can be computed from it</text>
  <text x="370" y="262" fill="#15384a" font-size="12.5" text-anchor="middle">Both need a second step: one to trim the invention away, the other to cap the opening deliberately</text>
</svg>
<figcaption>Neither family gives a gap the treatment you want by default. What differs is whether the correction is a deletion or an addition — and deletions are far easier to bound.</figcaption>
</figure>

## Decision table

| Criterion | Poisson (screened) | Delaunay / BPA |
|---|---|---|
| Output topology | Always watertight, closed | Open, honest holes |
| Vertices | New, on the fitted isosurface | Exactly the input points |
| Noise behaviour | Averages jitter into a smooth field | Reproduces jitter as real bumps |
| Gaps / occlusion | Fills with extrapolated bubbles (trim later) | Left open where density is too low |
| Sharp edges | Rounded unless `depth` is high | Preserved — interpolates corner points |
| Non-uniform density | Handled by adaptive octree | Needs multi-radius list; can go lacy |
| Primary parameter | `depth` (+ density-trim quantile) | Ball radii / `alpha`, from point spacing |
| Best data | Terrain, building envelopes, organic surfaces | CAD-aligned facades, footprints, clean scans |
| Downstream fit | Simulation, volumetrics, flood, line-of-sight | As-built QA, exact-measurement inspection |

## Verdict

Use **Poisson** whenever the twin needs a watertight surface and can tolerate trimming a few invented triangles: terrain, building envelopes, and any continuous surface headed for volumetrics, flood, or line-of-sight analysis, where a hole is a defect that leaks water. Its noise-averaging also makes it the safer default on raw photogrammetry. Use **Delaunay/BPA** when fidelity to the exact measured points beats closure — as-built inspection asking "what did the scanner actually see?", CAD-aligned facades with crisp breaks, and clean, uniformly sampled mechanical scans — where an extrapolated Poisson bubble is a lie and an honest BPA hole is the correct answer.

The mature pipeline uses **both, keyed off asset class rather than picked globally**: Poisson for terrain and massing, an alpha-shape or BPA path for facades and footprints that must keep their edges, and the extrapolation/unconnected metric above to flag the ambiguous tiles a reviewer should look at. Whichever you pick, reconstruct in a metric CRS like EPSG:32618, validate watertightness and the Euler characteristic before shipping, and pass the result into [automated mesh decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the decimator inherits whatever holes or bubbles you leave behind.

## Expected Output & Verification

On a clean genus-0 facade tile the two runs should look sharply different, and that difference is the whole point. Assert the invariants each algorithm promises so a swapped input fails loudly:

```python
# Poisson must close; BPA must not.
assert mesh_p.is_watertight(), "Poisson lost closure — lower the trim quantile"
assert not mesh_b.is_watertight(), "BPA unexpectedly closed — check radii/density"

V = len(mesh_p.vertices); F = len(mesh_p.triangles); E = F * 3 // 2
print("Poisson Euler V-E+F =", V - E + F)      # expect 2 for a closed genus-0 shell
```

Sample console trace for a 2 M-point facade in EPSG:32618:

```text
mean spacing 0.0180 m — drives the BPA radii
Poisson: 512,340 tris, watertight=True
BPA: 388,905 tris, watertight=False
Poisson extrapolated ~7.2% | BPA left ~4.1% of points unmeshed
Poisson Euler V-E+F = 2
```

An extrapolated fraction climbing toward 20% means Poisson is guessing large regions — prefer BPA for that asset or capture more coverage. A BPA unconnected fraction above ~10% means the radii cannot span the density variation — widen the list or switch to Poisson.

## Common Errors

**Poisson returns a smooth balloon far larger than the scan.** Normals are present but inconsistently oriented, so the implicit function has no stable inside/outside and inflates outward. Re-run `orient_normals_consistent_tangent_plane` with a larger `k` before comparing — this is a Poisson-specific failure; BPA does not care about orientation the same way.

**BPA returns an almost-empty or lacy mesh.** A single radius, or radii not anchored on the measured `avg_spacing`, cannot bridge the density variation Poisson absorbs. Supply the multi-radius list derived from `compute_nearest_neighbor_distance`, or downsample to uniform spacing first so one ball size fits the whole tile.

**Both collapse to a degenerate blob or return nothing.** The cloud is still in geographic EPSG:4326, so point spacing is ~1e-5 degrees and every metric radius, `alpha`, and voxel size is meaningless. Reproject to a metric CRS such as EPSG:32618 before reconstruction and assert it in a sidecar.

## Related Guides

- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — the parent workflow with the full three-algorithm toolkit
- [Poisson Surface Reconstruction Parameters](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/poisson-surface-reconstruction-parameters/) — deep tuning of depth, scale, and density trimming
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — cleaning and orienting normals before either algorithm
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — reducing whichever mesh you reconstruct

Back to [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/).
