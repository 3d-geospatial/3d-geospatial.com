# Reclassifying Noise and Overlap Points with PDAL

This page covers the two ASPRS classes that are routinely mishandled and quietly corrupt every downstream statistic — **class 7 (low/high noise)** and **class 12 (overlap)** — and the withheld bit that is not a class at all. Getting these right is what makes a density figure mean something, stops a stray return two metres underground from dragging the terrain surface with it, and prevents flight-line overlap from reporting twice the coverage a survey actually achieved.

## Why you hit this

Noise and overlap are the classes nobody specifies and everybody assumes. A delivery may arrive with noise already marked, marked as class 1 (unclassified), silently deleted, or flagged with the withheld bit and left in class 2. Each of those needs different handling, and treating them the same means either discarding real measurements or keeping returns that do not correspond to any surface. The overlap case is worse because it is invisible: a cloud with unmarked flight-line overlap looks like a denser survey, and a [density acceptance check](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) run over it passes a specification the survey did not meet.

## Prerequisites

- PDAL 2.6+ with Python bindings, plus `laspy>=2.5` and `numpy>=1.24`.
- LAS 1.4 point format 6 or 7. Formats 0–5 store classification in a 5-bit field with the synthetic, key-point and withheld flags packed into the same byte, which is the origin of most of the confusion below.
- A cloud in a projected metric CRS, with `PointSourceId` populated — it identifies the flight line and is what makes overlap detectable.

## Step-by-Step

### 1. Find out what the delivery actually did

Before changing anything, count what is there. The withheld bit and the classification field are separate, and a file can use either, both or neither.

```python
import laspy
import numpy as np

las = laspy.read("survey_delivery.laz")
cls = np.asarray(las.classification)
codes, counts = np.unique(cls, return_counts=True)

print("point format:", las.header.point_format.id)
for c, n in zip(codes, counts):
    print(f"  class {c:>3}: {n:>12,}")

# The withheld bit lives outside the classification field.
if hasattr(las, "withheld"):
    w = np.asarray(las.withheld).astype(bool)
    print(f"withheld flag set on {w.sum():,} points "
          f"({100 * w.mean():.2f}%), of which class 7: {(cls[w] == 7).sum():,}")
```

Three outcomes are common and each means something different. Class 7 present with no withheld bits means the producer classified noise and left it in — good, and you decide whether to drop it. Withheld bits set with everything in class 1 means the producer flagged noise without classifying it — the flag is authoritative and the class field is not. Neither present, in a delivery that has clearly been cleaned, means the noise was deleted, which is a data-loss decision somebody made on your behalf.

<figure class="diagram">
<svg viewBox="26 46 708 248" role="img" aria-labelledby="rn-fields-t rn-fields-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rn-fields-t">Classification and the withheld bit are different fields</title>
  <desc id="rn-fields-d">The classification field says what a point is. The withheld bit says whether it should be used. A point can be class 2 ground and withheld, class 7 noise and not withheld, or any other combination, and code that reads only one of the two fields will act on a subset of what the producer meant.</desc>
  <rect class="svg-bg" x="26" y="46" width="708" height="248" fill="#ffffff"/>
  <rect x="40" y="70" width="300" height="48" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="40" y="134" width="300" height="48" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="92"><tspan x="190" dy="0" font-weight="600">classification</tspan><tspan x="190" dy="16">what the point IS — ground, building, noise</tspan></text>
    <text x="190" y="156"><tspan x="190" dy="0" font-weight="600">withheld bit</tspan><tspan x="190" dy="16">whether the point SHOULD BE USED</tspan></text>
  </g>
  <g stroke-width="2">
    <rect x="420" y="60" width="300" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="420" y="102" width="300" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="420" y="144" width="300" height="34" rx="6" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="420" y="186" width="300" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="570" y="82">class 2, not withheld — use it</text>
    <text x="570" y="124">class 2, withheld — do not use it</text>
    <text x="570" y="166">class 7, not withheld — noise, still present</text>
    <text x="570" y="208">class 7, withheld — noise, excluded</text>
  </g>
  <text x="380" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">All four combinations occur in real deliveries, and only reading both fields tells you which one you have</text>
  <text x="380" y="276" fill="#5b6471" font-size="12" text-anchor="middle">In LAS 1.4 formats 6+ they are separate bytes; in formats 0–5 they share one, which is where the confusion started</text>
</svg>
<figcaption>Two independent statements about the same point. A filter that reads classification alone will happily consume points the producer marked as unusable.</figcaption>
</figure>

### 2. Classify noise by height relative to the ground surface

Absolute elevation thresholds do not survive a hilly site. Height above ground does.

```python
import json
import pdal

noise = {
    "pipeline": [
        "classified_smrf.laz",
        {"type": "filters.hag_nn"},
        # Below the ground surface by more than the survey's vertical accuracy: noise.
        {"type": "filters.assign",
         "value": ["Classification = 7 WHERE HeightAboveGround < -0.30"]},
        # Absurdly high returns — birds, cloud, multipath off water.
        {"type": "filters.assign",
         "value": ["Classification = 7 WHERE HeightAboveGround > 120.0"]},
        {"type": "writers.las", "filename": "noise_marked.laz", "forward": "all"},
    ]
}
print(pdal.Pipeline(json.dumps(noise)).execute(), "points processed")
```

The two thresholds are asymmetric on purpose. Below the surface, anything past the survey's stated vertical accuracy is physically impossible and can be marked confidently. Above it, the ceiling has to clear the tallest real thing in the extent — a 120 m cutoff is right for a low-rise city and wrong for one with towers, so it belongs in the site manifest rather than hard-coded.

<figure class="diagram">
<svg viewBox="42 99 656 193" role="img" aria-labelledby="rn-noise-t rn-noise-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rn-noise-t">Why one sub-surface return costs a whole neighbourhood of terrain</title>
  <desc id="rn-noise-d">A ground filter estimates the terrain as the lower envelope of the cloud, so a single multipath return two metres beneath the true surface becomes the local minimum. The estimated ground is pulled down toward it across the filter's whole window, not just at the offending point.</desc>
  <rect class="svg-bg" x="42" y="99" width="656" height="193" fill="#ffffff"/>
  <g fill="#1f6b8a">
    <circle cx="80" cy="150" r="3"/><circle cx="130" cy="148" r="3"/><circle cx="180" cy="152" r="3"/>
    <circle cx="230" cy="149" r="3"/><circle cx="280" cy="151" r="3"/><circle cx="330" cy="148" r="3"/>
    <circle cx="380" cy="150" r="3"/><circle cx="430" cy="152" r="3"/><circle cx="480" cy="149" r="3"/>
    <circle cx="530" cy="151" r="3"/><circle cx="580" cy="150" r="3"/><circle cx="630" cy="149" r="3"/>
  </g>
  <circle cx="330" cy="206" r="5" fill="#b0413e"/>
  <text x="344" y="212" fill="#b0413e" font-size="12" text-anchor="start">one multipath return, 2 m below the surface</text>
  <path d="M80 152 L630 151" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M80 152 L180 156 L260 180 L330 204 L400 180 L480 158 L630 152"
        fill="none" stroke="#b0413e" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="150" y="126" fill="#4f7a4d" font-size="12" text-anchor="start">true ground, from the real returns</text>
  <text x="370" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">Which is why noise has to be marked before the ground filter runs, not cleaned out of its output afterwards</text>
  <text x="370" y="274" fill="#5b6471" font-size="12" text-anchor="middle">Dashed red is what the filter returns once the low point is in scope</text>
</svg>
<figcaption>The estimated surface bends over the filter&#39;s whole window, not at one cell, and removing the point afterwards does not undo it: the surrounding ground points were already rejected for sitting too far above a surface that should never have dipped.</figcaption>
</figure>

### 3. Mark flight-line overlap as class 12, do not delete it

Overlap is real measurement collected twice. It should be identifiable and excludable, not discarded.

```python
overlap = {
    "pipeline": [
        "noise_marked.laz",
        # Points seen by more than one flight line within a small radius.
        {"type": "filters.radialdensity", "radius": 1.0},
        {"type": "filters.assign",
         "value": ["Classification = 12 WHERE RadialDensity > 18.0 && Classification == 2"]},
        {"type": "writers.las", "filename": "overlap_marked.laz", "forward": "all"},
    ]
}
print(pdal.Pipeline(json.dumps(overlap)).execute(), "points processed")
```

A density threshold is the crude version and it works where the flight plan is regular. The precise version uses `PointSourceId` directly: group points into cells, and where a cell contains returns from two or more source ids, the returns from all but the nearest-nadir line are overlap. That is more code and it is the right implementation for a survey whose lines vary in altitude or speed.

```python
import numpy as np
import laspy

las = laspy.read("noise_marked.laz")
x, y = np.asarray(las.x), np.asarray(las.y)
src = np.asarray(las.point_source_id)
cls = np.asarray(las.classification)

cell = 2.0
key = ((x // cell).astype(np.int64) << 32) + (y // cell).astype(np.int64)
order = np.argsort(key, kind="stable")
key_s, src_s = key[order], src[order]

# Cells whose returns come from more than one flight line.
boundaries = np.flatnonzero(np.diff(key_s)) + 1
multi = np.zeros(len(key_s), dtype=bool)
for start, end in zip(np.r_[0, boundaries], np.r_[boundaries, len(key_s)]):
    if len(np.unique(src_s[start:end])) > 1:
        multi[start:end] = True

in_overlap = np.zeros(len(key), dtype=bool)
in_overlap[order] = multi
print(f"{in_overlap.sum():,} points in multi-line cells "
      f"({100 * in_overlap.mean():.1f}% of the cloud)")
```

<figure class="diagram">
<svg viewBox="12 6 716 274" role="img" aria-labelledby="rn-ovl-t rn-ovl-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rn-ovl-t">Why unmarked overlap passes a density specification the survey missed</title>
  <desc id="rn-ovl-d">Two adjacent flight lines overlap by about thirty per cent of their swath width. In the overlap strip the point count is the sum of both lines, so a density check over the whole tile reports a figure well above what either line achieved. Marking the overlap as class 12 lets the check measure single-coverage density instead.</desc>
  <rect class="svg-bg" x="12" y="6" width="716" height="274" fill="#ffffff"/>
  <path d="M60 70 h300 v70 h-300 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M270 70 h300 v70 h-300 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M270 70 h90 v70 h-90 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="165" y="112" fill="#1f2937" font-size="12" text-anchor="middle">line 1 — 9 pts/m²</text>
  <text x="465" y="112" fill="#1f2937" font-size="12" text-anchor="middle">line 2 — 9 pts/m²</text>
  <text x="315" y="160" fill="#b0413e" font-size="12" text-anchor="middle">overlap — 18 pts/m²</text>
  <text x="315" y="196" fill="#1f2937" font-size="12.5" text-anchor="middle">tile mean: 11.7 pts/m² — comfortably above a 10 pts/m² specification</text>
  <text x="315" y="222" fill="#b0413e" font-size="12.5" text-anchor="middle">single-coverage density: 9 pts/m² — the specification was missed</text>
  <text x="370" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">The same cloud, two defensible density figures</text>
  <text x="370" y="262" fill="#15384a" font-size="12" text-anchor="middle">Class 12 is what lets the acceptance check exclude the double-counted strip and measure what each line actually delivered</text>
</svg>
<figcaption>Overlap is not an error and it is not extra coverage. Marking it is what lets a density figure answer the question the specification was written about.</figcaption>
</figure>

### 4. Set the withheld bit rather than deleting

Deleting is irreversible and the file loses the record that anything was removed. The withheld bit is reversible and self-documenting.

```python
import laspy
import numpy as np

las = laspy.read("overlap_marked.laz")
cls = np.asarray(las.classification)

las.withheld = (cls == 7)          # noise excluded by default, still present
las.write("final_flagged.laz")

check = laspy.read("final_flagged.laz")
print("withheld:", int(np.asarray(check.withheld).sum()),
      "| class 7 retained:", int((np.asarray(check.classification) == 7).sum()))
```

Class 12 deliberately does not get the withheld bit here. Overlap points are valid measurements — a strip-adjustment or an accuracy assessment wants them — so the right default is "identifiable but included", with the exclusion applied by whichever consumer needs single coverage.

### 5. Consume the flags correctly downstream

Every consumer has to state its own policy, and PDAL makes that explicit.

```python
import json
import pdal

# Terrain: ground only, noise and overlap excluded.
terrain = {"pipeline": [
    "final_flagged.laz",
    {"type": "filters.range", "limits": "Classification[2:2]"},
    {"type": "filters.expression", "expression": "Withheld == 0"},
    {"type": "writers.gdal", "filename": "dtm.tif", "resolution": 1.0,
     "output_type": "idw", "gdaldriver": "GTiff"},
]}

# Density acceptance: single coverage, so overlap is dropped.
density = {"pipeline": [
    "final_flagged.laz",
    {"type": "filters.expression", "expression": "Classification != 12 && Withheld == 0"},
    {"type": "filters.hexbin", "edge_size": 10.0},
]}

for name, spec in (("terrain", terrain), ("density", density)):
    p = pdal.Pipeline(json.dumps(spec))
    print(name, p.execute(), "points")
```

## Expected Output & Verification

A typical delivery after the full pass:

```text
point format: 6
  class   1:    4,102,338
  class   2:   28,441,902
  class   5:   11,204,776
  class   6:    9,880,145
  class   7:      142,006
  class  12:    6,318,440
withheld flag set on 142,006 points (0.23%), of which class 7: 142,006
1,204,882 points in multi-line cells (2.0% of the cloud)
```

Three sanity checks on those numbers. Noise above roughly one per cent of the cloud is not noise, it is a mis-set threshold or an uncorrected trajectory. Overlap materially above the flight plan's nominal side-lap — thirty per cent is typical — means lines were flown closer than planned or the detection cell is too large. And every class 7 point should carry the withheld bit if that is your policy; a mismatch between the two counts means the flagging step did not run.

```python
import laspy
import numpy as np

las = laspy.read("final_flagged.laz")
cls, w = np.asarray(las.classification), np.asarray(las.withheld).astype(bool)

noise_frac = (cls == 7).mean()
assert noise_frac < 0.01, f"noise is {noise_frac:.3%} of the cloud — threshold is wrong"
assert (cls[w] == 7).all(), "withheld set on something that is not class 7"
assert (w[cls == 7]).all(), "class 7 points exist without the withheld bit"
print("noise and overlap flags are internally consistent")
```

## Common Errors

**A density check passes and the survey visibly missed its specification.** Overlap was never marked, so the tile mean includes the double-counted strips. Mark class 12 and exclude it from the acceptance calculation, as in step 5.

**The terrain surface dips sharply in a few places.** Sub-surface noise was not marked, and both SMRF and CSF trust the lowest return. Run the height-above-ground noise pass *before* the ground filter, not after, so the filter never sees the offending points.

**`filters.assign` silently changes nothing.** The expression referenced `HeightAboveGround` without a preceding `filters.hag_nn`, so the dimension does not exist and the WHERE clause matches nothing. PDAL does not error on an unknown dimension in an assignment expression — check that the dimension is present with `filters.info` first.

## Frequently Asked Questions

### Should I delete noise or flag it?
Flag it. Deleting is irreversible, removes the evidence that anything was removed, and makes a re-run with a different threshold impossible without going back to the original delivery. The withheld bit costs nothing and every serious consumer honours it.

### Is class 12 overlap or "reserved"?
In the ASPRS LAS 1.4 specification, class 12 is overlap for point formats 0–5 and is deprecated in favour of the dedicated overlap bit for formats 6–10. In practice both are in circulation; write class 12 for compatibility and also set the overlap bit where the format has one.

### What noise fraction should I expect?
Well under one per cent for airborne LiDAR over land. Terrestrial scans in wet or reflective environments run higher. A figure above a few per cent almost always means the threshold, not the sensor.

## Related Guides

- [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/) — the classification workflow these classes belong to
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — the acceptance check that overlap distorts
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — statistical outlier removal, which is a different job from classifying noise

Back to [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
