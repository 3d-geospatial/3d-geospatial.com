---
title: "Point Cloud Filtering Techniques"
description: "Production point cloud filtering for digital twins: remove LiDAR noise with SOR, radius, voxel downsampling, and ground filtering in PDAL and Open3D."
---
# Point Cloud Filtering Techniques for Digital Twin Pipelines

Raw LiDAR, photogrammetric, and terrestrial laser scanning (TLS) datasets arrive contaminated with acquisition artifacts: floating multipath returns, atmospheric backscatter, birds and dust, vegetation penetration noise, and sensor calibration drift. Feed that data straight into reconstruction and you inherit non-manifold geometry, vegetation spikes baked into the bare-earth surface, and storage costs inflated by points that carry no signal. This guide covers production-ready point cloud filtering — statistical outlier removal, radius outlier removal, voxel downsampling, and ground extraction — implemented in `pdal`, `open3d`, and `laspy` against a metric CRS, with the validation and chunking discipline a digital twin pipeline needs. It sits inside the [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/) work, immediately upstream of surface reconstruction.

## Prerequisites

Filtering is distance-based, so every assumption about scale, units, and neighbourhood radius depends on the coordinate frame being a projected, metric one. Pin your environment and your CRS before tuning a single parameter.

- **Python 3.9+** with `pip` or `conda`.
- **Core libraries**: `open3d>=0.18`, `pdal>=2.6` (with the `python-pdal` bindings), `laspy>=2.5`, `numpy>=1.24`, `pyproj>=3.6`. Install with `pip install "open3d>=0.18" "laspy>=2.5" numpy pyproj` and `conda install -c conda-forge pdal python-pdal` (PDAL's native stack is far easier through conda).
- **Input formats**: LAS/LAZ (ASPRS point format 6 or 7 carry classification and return number), E57 for TLS, or XYZ with an explicit header. LAZ is compressed LAS — `laspy` reads it transparently when `lazrs` or `laszip` is installed.
- **A projected, metric CRS with an explicit EPSG code**. A neighbour radius of `0.5` means 0.5 m in EPSG:32633 (UTM 33N) but 0.5 degrees — roughly 55 km — in EPSG:4326 (WGS84 geographic). Distance filters on geographic coordinates are meaningless. Reproject to the appropriate UTM zone (EPSG:326xx / 327xx) or national grid (e.g. EPSG:25832, EPSG:27700) first, and confirm the vertical component (e.g. compound EPSG:25832+5783 for DHHN2016 height) so the `z` range filter operates in metres.

```bash
pip install "open3d>=0.18" "laspy[lazrs]>=2.5" numpy pyproj
conda install -c conda-forge pdal python-pdal
pdal --version    # confirm filters.outlier, filters.smrf are registered
```

## Concept

Filtering is not one operation but a family of them, each answering a different question about a point. Chaining them in the wrong order — or running one when you needed another — is the most common cause of a "clean" cloud that is actually over-eroded or still noisy.

**Statistical outlier removal (SOR)** asks: *is this point's mean distance to its `k` nearest neighbours an outlier relative to the global distribution?* It computes per-point mean neighbour distance, then drops points whose distance exceeds `mean + std_ratio · σ`. Excellent for sparse floating noise; sensitive to genuine density variation (a thin wire reads as sparse).

**Radius outlier removal** asks: *does this point have at least `min_points` neighbours within radius `r`?* It is a hard local-density threshold — simpler than SOR, predictable, and ideal for isolated specks, but it indiscriminately prunes legitimately sparse features unless `r` is tuned to expected spacing.

**Voxel downsampling** is not noise removal — it is resampling. It overlays a 3D grid of edge `voxel_size` and replaces all points in each occupied cell with their centroid. It thins dense regions to a uniform density, shrinks file size, and stabilizes downstream normal estimation. Run it *after* outlier removal, never before, or you average noise into your centroids.

**Ground filtering** (SMRF, PMF, CSF) is a semantic separation, not a geometric one: it labels bare-earth returns versus everything above them, so you can extract a DTM or strip vegetation. SMRF and PMF approach the problem morphologically — opening the surface with a growing window and rejecting anything that rises faster than a slope threshold — while CSF drapes a simulated cloth over the inverted cloud and keeps the points it settles on. **Pass-through / range filters** clip on an attribute or coordinate band (a `z` window, a classification code, an intensity range); they are O(n) and belong first in the chain because they shrink the working set every later filter must search. **Normals estimation** is the precondition for orientation-aware reconstruction and for some filters; it fits a local plane to each point's neighbourhood and is only meaningful on a cloud that has already been de-noised, since a single outlier inside the search radius tilts the fitted plane.

The decision of which family to run, and in what order, follows from the data and the goal. A floating-noise problem on a clean structural scan needs SOR plus radius removal and nothing else. A bare-earth DTM needs ground filtering and a `Classification[2:2]` clip. A web-streaming twin needs voxel downsampling to hit a point budget. Most production runs need all four in the canonical order — range clip, outlier removal, ground separation, voxel downsample — because each one makes the next cheaper and safer: the range clip shrinks the search space, outlier removal stops noise from poisoning ground classification and voxel centroids, and downsampling comes last so it resamples already-clean geometry.

<figure class="diagram">
<svg viewBox="-2 20 848 192" role="img" aria-labelledby="filt-pipe-t filt-pipe-d" xmlns="http://www.w3.org/2000/svg">
  <title id="filt-pipe-t">Point cloud filtering pipeline</title>
  <desc id="filt-pipe-d">A noisy raw cloud passes through statistical outlier removal to drop floating points, then radius outlier removal to clear isolated specks, then voxel downsampling to a uniform density, producing a clean cloud ready for reconstruction.</desc>
  <rect class="svg-bg" x="-2" y="20" width="848" height="192" fill="#ffffff"/>
  <defs>
    <marker id="filt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="12" y="60" width="160" height="92" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="232" y="60" width="160" height="92" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="452" y="60" width="160" height="92" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="672" y="60" width="160" height="92" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#5b6471">
    <circle cx="40" cy="84" r="2.5"/><circle cx="70" cy="78" r="2.5"/><circle cx="60" cy="100" r="2.5"/>
    <circle cx="95" cy="92" r="2.5"/><circle cx="120" cy="80" r="2.5"/><circle cx="145" cy="104" r="2.5"/>
    <circle cx="30" cy="118" r="2.5"/><circle cx="150" cy="74" r="2.5"/><circle cx="110" cy="116" r="2.5"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="262" cy="92" r="2.5"/><circle cx="292" cy="86" r="2.5"/><circle cx="320" cy="100" r="2.5"/>
    <circle cx="350" cy="90" r="2.5"/><circle cx="378" cy="98" r="2.5"/><circle cx="305" cy="116" r="2.5"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="482" cy="94" r="2.5"/><circle cx="512" cy="94" r="2.5"/><circle cx="542" cy="94" r="2.5"/>
    <circle cx="572" cy="94" r="2.5"/><circle cx="497" cy="116" r="2.5"/><circle cx="527" cy="116" r="2.5"/><circle cx="557" cy="116" r="2.5"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="702" cy="98" r="2.5"/><circle cx="730" cy="98" r="2.5"/><circle cx="758" cy="98" r="2.5"/>
    <circle cx="786" cy="98" r="2.5"/><circle cx="716" cy="118" r="2.5"/><circle cx="744" cy="118" r="2.5"/><circle cx="772" cy="118" r="2.5"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#filt-arrow)">
    <line x1="174" y1="106" x2="228" y2="106"/>
    <line x1="394" y1="106" x2="448" y2="106"/>
    <line x1="614" y1="106" x2="668" y2="106"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="92" y="48">Raw cloud (noisy)</text>
    <text x="312" y="48">SOR</text>
    <text x="532" y="48">Radius filter</text>
    <text x="752" y="48">Voxel downsample</text>
    <text x="312" y="178"><tspan x="312" dy="0">drop floating</tspan><tspan x="312" dy="16">outliers</tspan></text>
    <text x="532" y="178"><tspan x="532" dy="0">clear isolated</tspan><tspan x="532" dy="16">specks</tspan></text>
    <text x="752" y="178"><tspan x="752" dy="0">uniform density,</tspan><tspan x="752" dy="16">clean cloud</tspan></text>
  </g>
</svg>
<figcaption>Order matters: outlier removal first (so noise is not averaged in), uniform downsampling last.</figcaption>
</figure>

## Step-by-Step Workflow

The sequence below ingests a `.laz` scan, normalizes the CRS, removes outliers statistically and by radius, separates ground, downsamples, and exports an auditable result. Each step is runnable in isolation.

### Step 1: Ingest and confirm the CRS

Read the header first. A radius filter tuned for metres applied to a geographic cloud will either delete nearly everything or nothing. Confirm the source EPSG and reproject to a metric frame before any distance operation.

```python
import laspy
import numpy as np
from pyproj import CRS, Transformer

SRC_PATH = "raw_scan.laz"
TARGET_EPSG = 32633   # UTM zone 33N, metres

las = laspy.read(SRC_PATH)
src_crs = las.header.parse_crs()           # None if the header carries no CRS
if src_crs is None:
    raise ValueError("No CRS in header — declare it explicitly before filtering")

xyz = np.vstack((las.x, las.y, las.z)).T.astype(np.float64)

if src_crs.to_epsg() != TARGET_EPSG:
    tf = Transformer.from_crs(src_crs, CRS.from_epsg(TARGET_EPSG), always_xy=True)
    xyz[:, 0], xyz[:, 1], xyz[:, 2] = tf.transform(xyz[:, 0], xyz[:, 1], xyz[:, 2])

print(f"{len(xyz):,} points in EPSG:{TARGET_EPSG}; "
      f"z range {xyz[:,2].min():.2f}..{xyz[:,2].max():.2f} m")
```

### Step 2: Pass-through (range) clip

Cut points that cannot physically belong to the scene before spending compute on neighbourhood searches — a height band is the cheapest filter you have. In a UTM frame the band is in metres.

```python
GROUND_Z, CEILING_Z = -5.0, 300.0          # metres in EPSG:32633
band = (xyz[:, 2] > GROUND_Z) & (xyz[:, 2] < CEILING_Z)
xyz = xyz[band]
print(f"{band.sum():,} points within z-band; {(~band).sum():,} clipped")
```

### Step 3: Statistical outlier removal

SOR in `open3d` returns the surviving cloud and the kept indices. Keep the indices — they are your audit trail for which points were dropped and why.

```python
import open3d as o3d

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(xyz)

clean, keep_idx = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
removed = len(xyz) - len(keep_idx)
print(f"SOR removed {removed:,} ({removed / len(xyz):.1%}) points")
xyz_sor = np.asarray(clean.points)
```

Tune `nb_neighbors` to density: `20` suits dense urban TLS; raise to `40-60` for sparse airborne LiDAR so the neighbour statistic is stable. `std_ratio=2.0` is the default; drop toward `1.5` for aggressive cleaning, but watch for canopy and wire erosion. A removal fraction above ~15% almost always means a CRS scale error or a sensor seam, not real noise.

The same operation is available in PDAL as `filters.outlier` with `method: "statistical"`, `mean_k`, and `multiplier` — useful when you want the whole chain to stay in a single declarative pipeline rather than crossing into `open3d`. The two implementations differ slightly in how they treat the standard-deviation cutoff, so do not assume `std_ratio=2.0` and `multiplier=2.0` produce an identical result; pick one library for a given dataset and record the parameters. Whichever you use, the kept-index array is the audit record that lets you reconstruct exactly which points the filter rejected and replay the decision if a downstream check fails.

<figure class="diagram">
<svg viewBox="6 12 740 298" role="img" aria-labelledby="pf-sor-t pf-sor-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-sor-t">What statistical and radius outlier removal each measure</title>
  <desc id="pf-sor-d">Statistical outlier removal computes each point's mean distance to its k nearest neighbours and drops points whose mean sits more than a set number of standard deviations above the cloud's average. Radius outlier removal instead counts how many neighbours fall inside a fixed sphere and drops points below a threshold. The first adapts to local density; the second does not, which is what makes it predictable.</desc>
  <rect class="svg-bg" x="6" y="12" width="740" height="298" fill="#ffffff"/>
  <g fill="#1f6b8a"><circle cx="137" cy="151" r="2.6"/><circle cx="80" cy="175" r="2.6"/><circle cx="131" cy="160" r="2.6"/><circle cx="127" cy="193" r="2.6"/><circle cx="154" cy="184" r="2.6"/><circle cx="110" cy="138" r="2.6"/><circle cx="84" cy="144" r="2.6"/><circle cx="23" cy="195" r="2.6"/><circle cx="126" cy="153" r="2.6"/><circle cx="152" cy="140" r="2.6"/><circle cx="130" cy="172" r="2.6"/><circle cx="64" cy="199" r="2.6"/><circle cx="126" cy="168" r="2.6"/><circle cx="83" cy="133" r="2.6"/><circle cx="182" cy="136" r="2.6"/><circle cx="106" cy="164" r="2.6"/><circle cx="173" cy="83" r="2.6"/><circle cx="174" cy="158" r="2.6"/><circle cx="153" cy="122" r="2.6"/><circle cx="132" cy="195" r="2.6"/><circle cx="117" cy="133" r="2.6"/><circle cx="105" cy="136" r="2.6"/><circle cx="150" cy="156" r="2.6"/><circle cx="103" cy="173" r="2.6"/><circle cx="81" cy="111" r="2.6"/><circle cx="210" cy="133" r="2.6"/><circle cx="180" cy="148" r="2.6"/><circle cx="113" cy="165" r="2.6"/><circle cx="90" cy="127" r="2.6"/><circle cx="113" cy="140" r="2.6"/><circle cx="147" cy="205" r="2.6"/><circle cx="78" cy="126" r="2.6"/><circle cx="148" cy="165" r="2.6"/><circle cx="162" cy="130" r="2.6"/><circle cx="142" cy="149" r="2.6"/><circle cx="61" cy="163" r="2.6"/><circle cx="64" cy="166" r="2.6"/><circle cx="104" cy="145" r="2.6"/><circle cx="199" cy="193" r="2.6"/><circle cx="136" cy="162" r="2.6"/><circle cx="93" cy="185" r="2.6"/><circle cx="144" cy="127" r="2.6"/><circle cx="60" cy="151" r="2.6"/><circle cx="114" cy="175" r="2.6"/><circle cx="83" cy="126" r="2.6"/><circle cx="136" cy="153" r="2.6"/><circle cx="155" cy="182" r="2.6"/><circle cx="88" cy="85" r="2.6"/><circle cx="123" cy="130" r="2.6"/><circle cx="130" cy="75" r="2.6"/><circle cx="117" cy="153" r="2.6"/><circle cx="100" cy="165" r="2.6"/><circle cx="125" cy="157" r="2.6"/><circle cx="168" cy="187" r="2.6"/><circle cx="165" cy="161" r="2.6"/><circle cx="126" cy="166" r="2.6"/><circle cx="132" cy="130" r="2.6"/><circle cx="135" cy="176" r="2.6"/><circle cx="106" cy="120" r="2.6"/><circle cx="142" cy="130" r="2.6"/><circle cx="67" cy="144" r="2.6"/><circle cx="68" cy="160" r="2.6"/><circle cx="102" cy="153" r="2.6"/><circle cx="162" cy="182" r="2.6"/><circle cx="117" cy="88" r="2.6"/><circle cx="104" cy="118" r="2.6"/><circle cx="153" cy="194" r="2.6"/><circle cx="146" cy="169" r="2.6"/><circle cx="141" cy="170" r="2.6"/><circle cx="107" cy="176" r="2.6"/><circle cx="110" cy="118" r="2.6"/><circle cx="123" cy="195" r="2.6"/><circle cx="114" cy="101" r="2.6"/><circle cx="166" cy="157" r="2.6"/><circle cx="141" cy="138" r="2.6"/><circle cx="138" cy="196" r="2.6"/><circle cx="97" cy="170" r="2.6"/><circle cx="134" cy="127" r="2.6"/><circle cx="128" cy="167" r="2.6"/><circle cx="90" cy="183" r="2.6"/><circle cx="81" cy="183" r="2.6"/><circle cx="144" cy="158" r="2.6"/><circle cx="93" cy="129" r="2.6"/><circle cx="40" cy="150" r="2.6"/><circle cx="116" cy="166" r="2.6"/><circle cx="158" cy="156" r="2.6"/><circle cx="109" cy="178" r="2.6"/><circle cx="121" cy="150" r="2.6"/><circle cx="78" cy="180" r="2.6"/><circle cx="97" cy="205" r="2.6"/></g>
  <g fill="#b0413e"><circle cx="70" cy="70" r="4"/><circle cx="300" cy="76" r="4"/><circle cx="58" cy="236" r="4"/><circle cx="322" cy="220" r="4"/><circle cx="196" cy="58" r="4"/></g>
  <circle cx="70" cy="70" r="30" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="4 3"/>
  <circle cx="120" cy="150" r="30" fill="none" stroke="#4f7a4d" stroke-width="1.5" stroke-dasharray="4 3"/>
  <g fill="#1f6b8a"><circle cx="527" cy="151" r="2.6"/><circle cx="470" cy="175" r="2.6"/><circle cx="521" cy="160" r="2.6"/><circle cx="517" cy="193" r="2.6"/><circle cx="544" cy="184" r="2.6"/><circle cx="500" cy="138" r="2.6"/><circle cx="474" cy="144" r="2.6"/><circle cx="413" cy="195" r="2.6"/><circle cx="516" cy="153" r="2.6"/><circle cx="542" cy="140" r="2.6"/><circle cx="520" cy="172" r="2.6"/><circle cx="454" cy="199" r="2.6"/><circle cx="516" cy="168" r="2.6"/><circle cx="473" cy="133" r="2.6"/><circle cx="572" cy="136" r="2.6"/><circle cx="496" cy="164" r="2.6"/><circle cx="563" cy="83" r="2.6"/><circle cx="564" cy="158" r="2.6"/><circle cx="543" cy="122" r="2.6"/><circle cx="522" cy="195" r="2.6"/><circle cx="507" cy="133" r="2.6"/><circle cx="495" cy="136" r="2.6"/><circle cx="540" cy="156" r="2.6"/><circle cx="493" cy="173" r="2.6"/><circle cx="471" cy="111" r="2.6"/><circle cx="600" cy="133" r="2.6"/><circle cx="570" cy="148" r="2.6"/><circle cx="503" cy="165" r="2.6"/><circle cx="480" cy="127" r="2.6"/><circle cx="503" cy="140" r="2.6"/><circle cx="537" cy="205" r="2.6"/><circle cx="468" cy="126" r="2.6"/><circle cx="538" cy="165" r="2.6"/><circle cx="552" cy="130" r="2.6"/><circle cx="532" cy="149" r="2.6"/><circle cx="451" cy="163" r="2.6"/><circle cx="454" cy="166" r="2.6"/><circle cx="494" cy="145" r="2.6"/><circle cx="589" cy="193" r="2.6"/><circle cx="526" cy="162" r="2.6"/><circle cx="483" cy="185" r="2.6"/><circle cx="534" cy="127" r="2.6"/><circle cx="450" cy="151" r="2.6"/><circle cx="504" cy="175" r="2.6"/><circle cx="473" cy="126" r="2.6"/><circle cx="526" cy="153" r="2.6"/><circle cx="545" cy="182" r="2.6"/><circle cx="478" cy="85" r="2.6"/><circle cx="513" cy="130" r="2.6"/><circle cx="520" cy="75" r="2.6"/><circle cx="507" cy="153" r="2.6"/><circle cx="490" cy="165" r="2.6"/><circle cx="515" cy="157" r="2.6"/><circle cx="558" cy="187" r="2.6"/><circle cx="555" cy="161" r="2.6"/><circle cx="516" cy="166" r="2.6"/><circle cx="522" cy="130" r="2.6"/><circle cx="525" cy="176" r="2.6"/><circle cx="496" cy="120" r="2.6"/><circle cx="532" cy="130" r="2.6"/><circle cx="457" cy="144" r="2.6"/><circle cx="458" cy="160" r="2.6"/><circle cx="492" cy="153" r="2.6"/><circle cx="552" cy="182" r="2.6"/><circle cx="507" cy="88" r="2.6"/><circle cx="494" cy="118" r="2.6"/><circle cx="543" cy="194" r="2.6"/><circle cx="536" cy="169" r="2.6"/><circle cx="531" cy="170" r="2.6"/><circle cx="497" cy="176" r="2.6"/><circle cx="500" cy="118" r="2.6"/><circle cx="513" cy="195" r="2.6"/><circle cx="504" cy="101" r="2.6"/><circle cx="556" cy="157" r="2.6"/><circle cx="531" cy="138" r="2.6"/><circle cx="528" cy="196" r="2.6"/><circle cx="487" cy="170" r="2.6"/><circle cx="524" cy="127" r="2.6"/><circle cx="518" cy="167" r="2.6"/><circle cx="480" cy="183" r="2.6"/><circle cx="471" cy="183" r="2.6"/><circle cx="534" cy="158" r="2.6"/><circle cx="483" cy="129" r="2.6"/><circle cx="430" cy="150" r="2.6"/><circle cx="506" cy="166" r="2.6"/><circle cx="548" cy="156" r="2.6"/><circle cx="499" cy="178" r="2.6"/><circle cx="511" cy="150" r="2.6"/><circle cx="468" cy="180" r="2.6"/><circle cx="487" cy="205" r="2.6"/></g>
  <text x="196" y="40" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">before — 5 isolated returns</text>
  <text x="586" y="40" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">after — same 90 surface points, nothing moved</text>
  <text x="70" y="274" fill="#b0413e" font-size="11.5" text-anchor="start">a fixed-radius sphere here holds 1 neighbour</text>
  <text x="70" y="292" fill="#4f7a4d" font-size="11.5" text-anchor="start">the same sphere on the surface holds 24</text>
  <text x="586" y="274" fill="#5b6471" font-size="11.5" text-anchor="middle">SOR adapts to local density; radius removal uses one</text>
  <text x="586" y="292" fill="#5b6471" font-size="11.5" text-anchor="middle">absolute distance, so it behaves the same everywhere</text>
</svg>
<figcaption>Both tests reject the same five points here. They diverge on a cloud whose density varies — a mobile scan near and far from the trajectory — where SOR follows the density and radius removal does not.</figcaption>
</figure>

### Step 4: Radius outlier removal

Follow SOR with a hard local-density gate to clear isolated specks SOR's global statistic missed. Set `radius` from your expected point spacing — roughly 2–4× the median nearest-neighbour distance.

```python
pcd_sor = o3d.geometry.PointCloud()
pcd_sor.points = o3d.utility.Vector3dVector(xyz_sor)

clean2, keep2 = pcd_sor.remove_radius_outlier(nb_points=8, radius=0.25)   # radius in metres
xyz_rad = np.asarray(clean2.points)
print(f"Radius filter removed {len(xyz_sor) - len(keep2):,} points")
```

### Step 5: Ground separation with PDAL (SMRF)

For DTM extraction, classify ground returns. PDAL's `filters.smrf` (Simple Morphological Filter) is the robust default; `filters.pmf` (Progressive Morphological Filter) and CSF (Cloth Simulation Filter, `filters.csf`) are alternatives for steep or heavily vegetated terrain. This declarative pipeline runs entirely in PDAL — fast and memory-bounded.

```python
import pdal
import json

pipeline = pdal.Pipeline(json.dumps({
    "pipeline": [
        "sor_radius_clean.laz",
        {"type": "filters.assign", "assignment": "Classification[:]=0"},
        {"type": "filters.smrf",
         "scalar": 1.2, "slope": 0.2, "threshold": 0.45, "window": 16.0},
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.las", "filename": "ground_only.laz",
         "a_srs": "EPSG:32633", "compression": "laszip"}
    ]
}))
n_ground = pipeline.execute()
print(f"{n_ground:,} ground points classified and written")
```

`scalar` and `window` scale to feature size: a larger `window` (metres) spans wider non-ground objects such as building footprints; raise `slope` on hilly terrain so true slope is not mistaken for a structure.

### Step 6: Voxel downsample and write

Downsample last, to a uniform density that matches your LOD budget, then write a LAZ with the CRS stamped in the header so the next stage cannot misread it.

```python
pcd_clean = o3d.geometry.PointCloud()
pcd_clean.points = o3d.utility.Vector3dVector(xyz_rad)
down = pcd_clean.voxel_down_sample(voxel_size=0.10)     # 10 cm voxels
xyz_out = np.asarray(down.points)

header = laspy.LasHeader(point_format=6, version="1.4")
header.add_crs(CRS.from_epsg(TARGET_EPSG))
out = laspy.LasData(header)
out.x, out.y, out.z = xyz_out[:, 0], xyz_out[:, 1], xyz_out[:, 2]
out.write("filtered_final.laz")
print(f"{len(xyz_out):,} points written to filtered_final.laz")
```

<figure class="diagram">
<svg viewBox="26 12 688 294" role="img" aria-labelledby="pf-vox-t pf-vox-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pf-vox-t">Voxel downsampling replaces points with cell centroids</title>
  <desc id="pf-vox-d">A voxel grid is laid over the cloud and every occupied cell contributes one point at the centroid of the points it contains. Density becomes uniform, which is what reconstruction wants, but the output is no longer a set of measurements — every surviving point is an average that was never observed.</desc>
  <rect class="svg-bg" x="26" y="12" width="688" height="294" fill="#ffffff"/>
  <path d="M40 60 h300 v180 h-300 Z M100 60 V240 M160 60 V240 M220 60 V240 M280 60 V240 M40 120 H340 M40 180 H340"
        fill="none" stroke="#e6e0d4" stroke-width="1.5"/>
  <g fill="#1f6b8a">
    <circle cx="62" cy="88" r="2.6"/><circle cx="78" cy="104" r="2.6"/><circle cx="70" cy="96" r="2.6"/>
    <circle cx="126" cy="92" r="2.6"/><circle cx="140" cy="110" r="2.6"/>
    <circle cx="186" cy="150" r="2.6"/><circle cx="196" cy="162" r="2.6"/><circle cx="204" cy="140" r="2.6"/><circle cx="176" cy="166" r="2.6"/>
    <circle cx="248" cy="200" r="2.6"/><circle cx="262" cy="214" r="2.6"/>
    <circle cx="304" cy="206" r="2.6"/>
  </g>
  <path d="M400 60 h300 v180 h-300 Z M460 60 V240 M520 60 V240 M580 60 V240 M640 60 V240 M400 120 H700 M400 180 H700"
        fill="none" stroke="#e6e0d4" stroke-width="1.5"/>
  <g fill="#4f7a4d">
    <circle cx="430" cy="96" r="4.5"/><circle cx="493" cy="101" r="4.5"/>
    <circle cx="551" cy="155" r="4.5"/><circle cx="615" cy="207" r="4.5"/><circle cx="664" cy="206" r="4.5"/>
  </g>
  <text x="190" y="40" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">12 measured returns</text>
  <text x="550" y="40" fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">5 cell centroids</text>
  <text x="370" y="268" fill="#15384a" font-size="12.5" text-anchor="middle">Every green point is an average of points that were measured. None of them is itself a measurement.</text>
  <text x="370" y="288" fill="#5b6471" font-size="12" text-anchor="middle">Downsample for reconstruction, never for the archive — and record the voxel size next to the output</text>
</svg>
<figcaption>Voxel downsampling is the one filtering step that manufactures new coordinates. That is fine going into a solver and wrong going into a survey deliverable.</figcaption>
</figure>

### Step 7: Estimate normals (optional, for reconstruction)

If the cleaned cloud feeds Poisson reconstruction, estimate and orient normals now while the data is clean.

```python
down.estimate_normals(
    search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.3, max_nn=30))
down.orient_normals_consistent_tangent_plane(k=15)
```

## Validation & Verification

Every filtering run must be quantified, not eyeballed. Track point counts and the retained ratio at each stage, and assert that nothing physically impossible survived.

```python
def report(stage, before, after):
    ratio = after / before if before else 0
    print(f"{stage:18s} {before:>10,} -> {after:>10,}  retained {ratio:.2%}")
    return after

n0 = len(las.points)
n1 = report("z-band clip", n0, band.sum())
n2 = report("SOR",         n1, len(xyz_sor))
n3 = report("radius",      n2, len(xyz_rad))
n4 = report("voxel",       n3, len(xyz_out))

# Sanity gates — fail loudly rather than ship a corrupted cloud.
assert n4 / n0 > 0.40, "over-filtered: kept <40% of input, re-check params"
assert xyz_out[:, 2].max() < 300.0, "ceiling clip leaked"
```

Expected retained ratios for a typical urban TLS scan: z-band clip removes 1–5%, SOR 2–8%, radius filter 1–3%, voxel downsampling anywhere from 30% to 80% depending on `voxel_size` versus native density. The decisive check is against surveyed control: sample known monument coordinates and confirm the nearest retained point is within your accuracy budget (e.g. < 2 cm horizontal for TLS). A filter that improves visual cleanliness while pushing control residuals up has eroded real geometry.

Beyond counts and control points, verify three structural invariants on the output. First, the axis-aligned bounding box must still cover the project extent — a box that shrank significantly means a filter clipped a real edge of the scene, not just noise. Second, point density should be uniform after voxelization: compute density in a grid of cells and confirm the variance collapsed relative to the input, which is the whole point of downsampling. Third, attribute histograms (intensity, return number) should keep the same shape as the raw sensor profile; a histogram that changed shape signals that filtering correlated with an attribute it should not have touched — for example dropping all low-intensity returns because they happened to be sparse.

```python
import numpy as np

bbox_in  = np.ptp(xyz, axis=0)
bbox_out = np.ptp(xyz_out, axis=0)
assert np.all(bbox_out > 0.95 * bbox_in), "bounding box shrank — a real edge was clipped"

# density uniformity across a 1 m grid
cells = np.floor(xyz_out[:, :2]).astype(int)
_, counts = np.unique(cells, axis=0, return_counts=True)
print(f"per-cell density mean {counts.mean():.1f}, cv {counts.std()/counts.mean():.2f}")
```

## Performance & Scale

City-scale clouds run to billions of points and will not fit in RAM. Never load a multi-gigabyte LAS file whole into an `open3d` `PointCloud`.

- **Chunk spatially with PDAL.** `filters.splitter` (a fixed grid in CRS units) or `filters.chipper` (capacity-balanced tiles) partition the cloud so each tile fits in memory. Process tiles independently, then merge.

```python
chunked = pdal.Pipeline(json.dumps({
    "pipeline": [
        "city_scale.laz",
        {"type": "filters.splitter", "length": 250.0, "origin_x": 0, "origin_y": 0},
        {"type": "filters.outlier", "method": "statistical",
         "mean_k": 12, "multiplier": 2.5},
        {"type": "filters.smrf"},
        {"type": "writers.las", "filename": "tile_#.laz", "a_srs": "EPSG:32633"}
    ]
}))
chunked.execute()    # writes tile_1.laz, tile_2.laz, ... each filtered independently
```

- **Overlap your tiles.** Neighbourhood filters need a buffer; a point near a tile edge has neighbours in the adjacent tile. Splitter without buffer produces seam artifacts where SOR sees artificially sparse edges. Add a small overlap (`buffer` in PDAL, or pad tile extents) and de-duplicate on merge.
- **Stream attributes with `laspy`.** Use `laspy.open(...).chunk_iterator(n)` to read fixed-size point batches rather than `laspy.read`, and back NumPy work with `numpy.memmap` for arrays too large for RAM.
- **Parallelize across tiles** with `multiprocessing` or `dask` — filtering is embarrassingly parallel per tile. As a rough benchmark, `filters.smrf` processes on the order of 1–3M points/second/core; `remove_statistical_outlier` in `open3d` is KD-tree-bound and roughly an order of magnitude slower, which is another reason to clip and tile before SOR.

## Failure Modes & Gotchas

- **Distance filters on a geographic CRS.** Running radius or SOR filters while still in EPSG:4326 treats degrees as metres. A `radius=0.25` "metre" filter becomes a ~27 km neighbourhood — it removes nothing, or the scale mismatch silently corrupts results. Always reproject to a metric EPSG first.
- **Over-filtering thin structures.** SOR's global statistic flags genuinely sparse features — power lines, railings, antenna masts, fence wires — as outliers because their local density is far below the scene mean. Raise `std_ratio`, or mask known linear-asset regions out of the SOR pass and filter them separately.
- **Edge erosion from tiling without overlap.** Points along a tile boundary lose half their true neighbourhood, so SOR over-removes them and you get visible thinning along every seam. Buffer tiles and de-duplicate on merge.
- **Voxel downsampling before outlier removal.** Downsampling first averages noisy points into the centroid of every voxel they touch, baking the noise permanently into the survivors. Outlier removal must precede voxelization.
- **Ground filter parameters mismatched to terrain.** An SMRF `window` smaller than the largest non-ground object (a wide building) leaves roof points classified as ground; too large a `window` on steep terrain over-smooths and eats real micro-topography. Tune `window` to footprint size and `slope` to terrain grade, and validate the bare-earth result against control points, not by eye.

## Frequently Asked Questions

### Should I use statistical or radius outlier removal?

Use both, in that order. SOR catches outliers relative to the global density distribution — good for diffuse atmospheric noise. Radius removal is a hard local-density gate that cleans up isolated specks SOR's statistic misses. SOR struggles where density legitimately varies; radius removal is predictable but blind to context. Running SOR then radius covers both failure modes.

### What voxel size should I pick?

Match it to the smallest feature the twin must resolve and your LOD budget, not the native point spacing. A `voxel_size` of 0.05–0.10 m preserves building edges and curbs for an urban twin; 0.25–0.50 m is fine for regional terrain. Below your native spacing, voxelization does nothing useful; far above it, you erase the features reconstruction needs. Always downsample after outlier removal.

### How do I filter without classification codes?

When the LAS has no usable classification, extract ground geometrically: run `filters.smrf` (or CSF for vegetated terrain) to label ground from raw XYZ, then keep `Classification[2:2]`. For a non-ground/structure split without a full classifier, height-above-ground from a coarse TIN of the SMRF ground gives you a workable `z`-relative band. See [removing noise from terrestrial LiDAR scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) for scanner-specific artifact handling.

### Why did SOR remove 30% of my points?

That is far past the 5–10% you expect from real noise and almost always signals a problem upstream: a geographic CRS feeding distance filters, a unit mismatch (US survey feet read as metres), or `nb_neighbors` set too high for a sparse airborne scan so even valid points fail the neighbour statistic. Check the CRS and units first, then lower `nb_neighbors` or raise `std_ratio`.

### Does filtering change the CRS or coordinates?

No — SOR, radius removal, and range clipping only delete points; surviving coordinates are untouched. Voxel downsampling replaces each cell's points with their centroid, so positions shift by at most half the `voxel_size`. The CRS itself is unchanged by filtering; the only reprojection is the explicit Step 1 transform. Always re-stamp the EPSG into the output header (`a_srs` / `add_crs`) so the next stage reads the correct frame.

## Related Guides

- [Removing Noise from Terrestrial LiDAR Scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) — scanner-specific artifacts: tripod occlusion, atmospheric backscatter
- [Surface Reconstruction for Geospatial Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/) — the stage filtering feeds directly
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — polygon-budget reduction after reconstruction
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — density targets that set your voxel size
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — choosing the metric EPSG filtering depends on
- [Cropping Point Clouds to Polygons with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/cropping-point-clouds-to-polygons-with-pdal/) — clip a point cloud to parcels, corridors or exclusion zones with filters.crop
- [Radius Outlier Removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/) — remove noise without eating real detail
- [Voxel Downsampling Strategies Compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — centroid, nearest-to-centroid, random and Poisson-disk downsampling measured on the same cloud

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
