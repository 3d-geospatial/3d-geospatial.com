# Estimating Point Spacing for Mobile Mapping Scans

This page measures point spacing on a mobile mapping scan properly — per surface and per range, using nearest-neighbour distances rather than a planimetric density — and explains why the points-per-square-metre figure that works for airborne LiDAR is actively misleading here. A mobile scan's density varies by an order of magnitude between a kerb two metres from the vehicle and a facade thirty metres away, and a single ppsm figure averages that away.

## Why you hit this

Mobile mapping specifications are frequently written in the units airborne surveys use, because that is what procurement knows. The result is a contract that is either trivially satisfied or impossible, depending on where you measure: a scanner producing 3,000 points per square metre on the road surface beside the vehicle might produce 40 on a building facade at the far end of the street, and the "average" that gets reported describes neither. Every clearance, gauge and asset-extraction requirement lives on one of those surfaces.

The planimetric approach this replaces is covered in [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/); what follows is what changes when the sensor moves along a trajectory rather than flying over.

## Prerequisites

- Python 3.10+ with `laspy>=2.5`, `numpy>=1.24`, `scipy>=1.11` and `open3d>=0.18`.
- A scan retaining `GpsTime` and, ideally, the trajectory as a separate file. Range is recoverable from the trajectory and cannot be reconstructed without it.
- A metric projected CRS, and outliers already removed — a single stray point ruins a nearest-neighbour statistic.

## Step-by-Step

### 1. Understand why planimetric density fails here

Airborne density works because the sensor looks roughly straight down from a roughly constant height, so a square metre of ground receives a roughly constant number of returns. A mobile scanner rotates about a moving axis, so spacing along the scan line is range times the angular step, and spacing across it is vehicle speed divided by rotation rate.

```python
import numpy as np

def mobile_spacing(range_m, angular_step_deg, speed_mps, rotations_per_s):
    along = range_m * np.radians(angular_step_deg)      # within one rotation
    across = speed_mps / rotations_per_s                # between rotations
    return along, across

for r in (2.0, 8.0, 20.0, 40.0):
    a, c = mobile_spacing(r, 0.03, 8.3, 200.0)
    print(f"range {r:>5.1f} m → along {a*1000:6.1f} mm, across {c*1000:6.1f} mm, "
          f"anisotropy {max(a, c)/min(a, c):.1f}:1")
```

Two facts fall out of that. Spacing along the scan line grows linearly with range, so density falls with the square of it. And the two spacings are independent, so the point pattern is anisotropic — dense in one direction and sparse in the other — which is exactly what a planimetric density cannot express.

<figure class="diagram">
<svg viewBox="14 42 712 202" role="img" aria-labelledby="ms-range-t ms-range-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ms-range-t">Spacing grows with range, so density falls with its square</title>
  <desc id="ms-range-d">At two metres from the vehicle the along-scan spacing is about one millimetre and the pattern is nearly isotropic. At forty metres it is twenty-one millimetres, while the across-scan spacing set by vehicle speed is unchanged at forty-two, so the pattern is both sparse and strongly anisotropic.</desc>
  <rect class="svg-bg" x="14" y="42" width="712" height="202" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="150" y="56" width="16" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="94" width="64" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="132" width="160" height="26" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="150" y="170" width="320" height="26" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="176" y="74">1.0 mm — 2 m range</text>
    <text x="224" y="112">4.2 mm — 8 m</text>
    <text x="320" y="150">10.5 mm — 20 m</text>
    <text x="480" y="188">21.0 mm — 40 m</text>
  </g>
  <text x="140" y="130" fill="#5b6471" font-size="12" text-anchor="end">along-scan</text>
  <text x="140" y="146" fill="#5b6471" font-size="12" text-anchor="end">spacing</text>
  <text x="370" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Across-scan spacing is 42 mm at every range, set by vehicle speed — so the pattern goes from 42:1 anisotropic to 2:1</text>
</svg>
<figcaption>One of the two spacings depends on range and the other does not, which is why the pattern&#39;s shape changes across the scene as well as its density.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="-27 20 795 226" role="img" aria-labelledby="ms-aniso-t ms-aniso-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ms-aniso-t">The point pattern is anisotropic, and its shape changes with range</title>
  <desc id="ms-aniso-d">Close to the vehicle, points are dense along each scan line and far apart between rotations, so the pattern is a set of widely separated dense stripes. Far away the along-scan spacing has grown to match the across-scan spacing and the pattern becomes an even grid, sparse in both directions.</desc>
  <rect class="svg-bg" x="-27" y="20" width="795" height="226" fill="#ffffff"/>
  <g fill="#1f6b8a">
    <circle cx="60" cy="70" r="2"/><circle cx="66" cy="70" r="2"/><circle cx="72" cy="70" r="2"/><circle cx="78" cy="70" r="2"/><circle cx="84" cy="70" r="2"/><circle cx="90" cy="70" r="2"/><circle cx="96" cy="70" r="2"/><circle cx="102" cy="70" r="2"/><circle cx="108" cy="70" r="2"/><circle cx="114" cy="70" r="2"/><circle cx="120" cy="70" r="2"/><circle cx="126" cy="70" r="2"/><circle cx="132" cy="70" r="2"/><circle cx="138" cy="70" r="2"/><circle cx="144" cy="70" r="2"/>
    <circle cx="60" cy="112" r="2"/><circle cx="66" cy="112" r="2"/><circle cx="72" cy="112" r="2"/><circle cx="78" cy="112" r="2"/><circle cx="84" cy="112" r="2"/><circle cx="90" cy="112" r="2"/><circle cx="96" cy="112" r="2"/><circle cx="102" cy="112" r="2"/><circle cx="108" cy="112" r="2"/><circle cx="114" cy="112" r="2"/><circle cx="120" cy="112" r="2"/><circle cx="126" cy="112" r="2"/><circle cx="132" cy="112" r="2"/><circle cx="138" cy="112" r="2"/><circle cx="144" cy="112" r="2"/>
    <circle cx="60" cy="154" r="2"/><circle cx="66" cy="154" r="2"/><circle cx="72" cy="154" r="2"/><circle cx="78" cy="154" r="2"/><circle cx="84" cy="154" r="2"/><circle cx="90" cy="154" r="2"/><circle cx="96" cy="154" r="2"/><circle cx="102" cy="154" r="2"/><circle cx="108" cy="154" r="2"/><circle cx="114" cy="154" r="2"/><circle cx="120" cy="154" r="2"/><circle cx="126" cy="154" r="2"/><circle cx="132" cy="154" r="2"/><circle cx="138" cy="154" r="2"/><circle cx="144" cy="154" r="2"/>
  </g>
  <g fill="#c46a3d">
    <circle cx="460" cy="70" r="2"/><circle cx="502" cy="70" r="2"/><circle cx="544" cy="70" r="2"/><circle cx="586" cy="70" r="2"/><circle cx="628" cy="70" r="2"/><circle cx="670" cy="70" r="2"/>
    <circle cx="460" cy="112" r="2"/><circle cx="502" cy="112" r="2"/><circle cx="544" cy="112" r="2"/><circle cx="586" cy="112" r="2"/><circle cx="628" cy="112" r="2"/><circle cx="670" cy="112" r="2"/>
    <circle cx="460" cy="154" r="2"/><circle cx="502" cy="154" r="2"/><circle cx="544" cy="154" r="2"/><circle cx="586" cy="154" r="2"/><circle cx="628" cy="154" r="2"/><circle cx="670" cy="154" r="2"/>
  </g>
  <text x="102" y="48" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">2 m — 40:1 anisotropic</text>
  <text x="565" y="48" fill="#9a4f26" font-size="12.5" text-anchor="middle" font-weight="600">40 m — 2:1, sparse both ways</text>
  <text x="102" y="192" fill="#1f2937" font-size="12" text-anchor="middle">dense stripes, wide gaps between them</text>
  <text x="565" y="192" fill="#1f2937" font-size="12" text-anchor="middle">an even grid, and nothing small survives it</text>
  <text x="370" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">A planimetric density reports the same number for both patterns, and the left one reconstructs a kerb while the right one does not</text>
</svg>
<figcaption>The two patterns have similar point counts per square metre and completely different reconstruction behaviour, which is the case against reporting density alone.</figcaption>
</figure>

### 2. Measure nearest-neighbour spacing instead

The robust statistic is the distance from each point to its nearest neighbour, which describes the pattern wherever it is measured.

```python
import laspy
import numpy as np
from scipy.spatial import cKDTree

las = laspy.read("mobile_scan_utm33n.laz")
xyz = np.column_stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)])

rng = np.random.default_rng(0)
sample = xyz[rng.choice(len(xyz), size=min(500_000, len(xyz)), replace=False)]

tree = cKDTree(xyz)
d, _ = tree.query(sample, k=2)                # k=2: self plus nearest neighbour
nn = d[:, 1]

print(f"nearest-neighbour spacing: median {np.median(nn)*1000:.1f} mm, "
      f"p10 {np.percentile(nn, 10)*1000:.1f}, p90 {np.percentile(nn, 90)*1000:.1f}")
```

The p10-to-p90 span is the number worth quoting alongside the median. On an airborne scan it is typically within a factor of two; on a mobile scan a factor of fifteen is normal, and that ratio is the honest description of what the survey delivered.

### 3. Stratify by surface, because that is what the requirement is about

A specification says "resolve a 25 mm conductor" or "measure kerb height to 10 mm", and those live on specific surfaces.

```python
import numpy as np

def spacing_by_class(las, xyz, tree, codes=(2, 6, 11)):
    cls = np.asarray(las.classification)
    out = {}
    for c in codes:
        m = cls == c
        if m.sum() < 1000:
            continue
        sub = xyz[m]
        d, _ = tree.query(sub[np.random.default_rng(1).choice(len(sub), 50_000)], k=2)
        out[c] = np.median(d[:, 1])
    return out

names = {2: "ground", 6: "building facade", 11: "road surface"}
for c, s in spacing_by_class(las, xyz, tree).items():
    print(f"{names.get(c, c):<18} median spacing {s*1000:6.1f} mm")
```

### 4. Recover range from the trajectory

Range is what explains the variation, and it is recoverable if the trajectory was delivered.

```python
import numpy as np
from scipy.interpolate import interp1d

traj = np.loadtxt("trajectory.txt")            # gps_time, x, y, z
fx = interp1d(traj[:, 0], traj[:, 1], bounds_error=False, fill_value="extrapolate")
fy = interp1d(traj[:, 0], traj[:, 2], bounds_error=False, fill_value="extrapolate")
fz = interp1d(traj[:, 0], traj[:, 3], bounds_error=False, fill_value="extrapolate")

t = np.asarray(las.gps_time)
sensor = np.column_stack([fx(t), fy(t), fz(t)])
rng_m = np.linalg.norm(xyz - sensor, axis=1)

for lo, hi in ((0, 5), (5, 15), (15, 30), (30, 60)):
    m = (rng_m >= lo) & (rng_m < hi)
    if m.sum() < 1000:
        continue
    d, _ = tree.query(xyz[m][:20_000], k=2)
    print(f"range {lo:>2}–{hi:<2} m: {m.sum():>10,} points, "
          f"median spacing {np.median(d[:, 1])*1000:6.1f} mm")
```

<figure class="diagram">
<svg viewBox="39 42 662 207" role="img" aria-labelledby="ms-strat-t ms-strat-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ms-strat-t">One scan, one ppsm figure, four very different surfaces</title>
  <desc id="ms-strat-d">A mobile scan reported as two thousand points per square metre resolves to a four millimetre spacing on the road surface beside the vehicle, eleven on the near kerb, thirty-one on a facade across the street and eighty-four on an overhead conductor. Only the last two decide whether the survey meets a clearance requirement.</desc>
  <rect class="svg-bg" x="39" y="42" width="662" height="207" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="34" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="94" width="92" height="28" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="60" y="132" width="260" height="28" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="170" width="420" height="28" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="104" y="75">4 mm — road, 2 m away</text>
    <text x="162" y="113">11 mm — near kerb, 6 m</text>
    <text x="330" y="151">31 mm — facade, 18 m</text>
    <text x="490" y="189">84 mm — conductor, 34 m</text>
  </g>
  <text x="370" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">A 25 mm conductor needs roughly 8 mm spacing to be reconstructed — this scan misses it by a factor of ten</text>
</svg>
<figcaption>The scan-wide figure passes every specification. The surface the specification was written about fails by an order of magnitude.</figcaption>
</figure>

### 5. Write the acceptance criterion in the units the work needs

The useful specification names a surface, a distance and a spacing.

```python
REQUIREMENTS = [
    {"surface": "road", "class": 11, "max_range_m": 8.0,  "max_spacing_mm": 10.0},
    {"surface": "kerb", "class": 2,  "max_range_m": 12.0, "max_spacing_mm": 15.0},
    {"surface": "conductor", "class": 14, "max_range_m": 40.0, "max_spacing_mm": 8.0},
]

def check(las, xyz, tree, rng_m, reqs):
    cls = np.asarray(las.classification)
    failures = []
    for r in reqs:
        m = (cls == r["class"]) & (rng_m <= r["max_range_m"])
        if m.sum() < 500:
            failures.append(f"{r['surface']}: only {m.sum()} points in range")
            continue
        d, _ = tree.query(xyz[m][:50_000], k=2)
        got = float(np.median(d[:, 1])) * 1000
        if got > r["max_spacing_mm"]:
            failures.append(f"{r['surface']}: {got:.1f} mm > {r['max_spacing_mm']} mm")
    return failures
```

## Expected Output & Verification

A representative mobile scan of an urban street:

```text
range  2.0 m → along    1.0 mm, across   41.5 mm, anisotropy 39.6:1
range 40.0 m → along   20.9 mm, across   41.5 mm, anisotropy  2.0:1
nearest-neighbour spacing: median 12.4 mm, p10 2.1, p90 68.9
road surface       median spacing    4.1 mm
building facade    median spacing   31.4 mm
range  0–5  m:  84,220,118 points, median spacing    3.8 mm
range 30–60 m:   4,102,884 points, median spacing   79.2 mm
```

The p10-to-p90 ratio of 33 is the headline finding, and it is what makes a single figure meaningless. Verify by checking that the measured spacing at a given range agrees with the geometric prediction from step 1 to within about 20% — a large disagreement means the trajectory interpolation is wrong, usually a GPS time offset between the scan and the trajectory file.

## Common Errors

**Range comes out implausibly large for every point.** The trajectory and the scan use different GPS time conventions — adjusted standard GPS time versus week seconds. Check that the two time ranges overlap before interpolating.

**Nearest-neighbour spacing is near zero everywhere.** Duplicate points, usually from merging overlapping passes without deduplication. Deduplicate on exact coordinates first, or the statistic measures the duplication rather than the scan.

**Spacing on facades looks better than the geometry predicts.** Multiple passes covered the same facade from different positions, so the effective spacing is better than any single pass achieved. That is legitimate coverage, and it is worth reporting per pass as well as combined.

## Frequently Asked Questions

### Should I ever quote points per square metre for a mobile scan?
Only alongside the surface and the range it was measured on. Quoted alone it is a number that no downstream requirement can use.

### How many points do I need to sample?
Fifty thousand per stratum is ample for a median and a robust p10/p90. The `cKDTree` query is the cost, and it scales with the sample rather than with the cloud.

### Does this apply to terrestrial static scans too?
Partly. A static scan has the same range-dependent along-scan spacing, but no vehicle motion, so the across-scan spacing is also range-dependent and the pattern stays isotropic. The nearest-neighbour approach is still the right measurement.

A last note on procurement. The most useful thing this measurement produces is not a pass or a fail but a specification that can be met: naming the surface, the maximum range at which it must be met, and the spacing in millimetres turns an argument about averages into a check either party can run. A contract written in points per square metre over a mobile scan is, in practice, unenforceable in both directions — the surveyor cannot demonstrate compliance and the client cannot demonstrate breach, because neither can say where the number was measured.

The second use is planning. Because spacing along the scan line is range times the angular step, and across it is speed over rotation rate, the specification determines the survey: a conductor at 34 m needing 8 mm spacing implies either a finer angular step or a second pass from closer. That calculation is worth doing before the vehicle is booked rather than after the data is rejected.

### What about multiple passes over the same street?
Report both. The combined cloud is what downstream work consumes, so its spacing is the operative number, but the per-pass figure is what tells you whether a single pass would have sufficed — which is the question that decides the next survey's cost.

## Related Guides

- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — the planimetric approach and where it does apply
- [Best Practices for LiDAR Point Density in Infrastructure](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/) — per-asset density targets
- [Removing Noise from Terrestrial LiDAR Scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) — the cleanup that must precede any spacing statistic

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
