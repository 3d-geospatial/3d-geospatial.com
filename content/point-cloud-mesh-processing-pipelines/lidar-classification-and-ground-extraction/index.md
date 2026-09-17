# LiDAR Classification and Ground Extraction

Classification is the step that turns a bag of measured points into data an analysis can use. Until every return carries a class, a terrain model contains treetops, a building extraction contains parked cars, and a clearance calculation contains the survey vehicle. This guide covers the two ground filters that matter in production — SMRF and the Cloth Simulation Filter — the ASPRS codes they write, how to score a classifier rather than eyeball it, and the gates that stop an under-tuned filter from reaching a digital twin.

The distinction that organises everything below is between **classification** (assigning a semantic label to every point) and **ground extraction** (selecting the subset labelled as bare earth). Ground extraction is one output of classification, and it is the one with the most downstream consumers: every [digital elevation model workflow](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) starts from it, and so does every volumetric or hydrological product built on the resulting surface.

## Prerequisites

- **PDAL 2.6+** with Python bindings (`conda install -c conda-forge pdal python-pdal`), plus `laspy>=2.5`, `numpy>=1.24` and `scikit-learn>=1.3` for the scoring step.
- **A cloud in a projected metric CRS.** Both filters reason about slope and height in the horizontal units of the data, so a cloud in EPSG:4326 produces meaningless windows. Reproject first — see [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/).
- **Outliers already removed.** A single low noise point beneath the terrain drags the ground surface down with it, and both filters trust it. Run the [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) pass first.
- **A validation sample.** A few thousand manually labelled points, stratified across terrain types, is what turns "the filter looks right" into a number.

## Concept

Ground filters all solve the same problem: the terrain is the lower envelope of the point cloud, but that envelope has to be estimated in a way that follows real slope without following a building.

**SMRF** — Simple Morphological Filter — rasterises the minimum elevation into a grid, then applies a morphological opening with a window that grows step by step. At each window size, points whose height above the opened surface exceeds a threshold are marked non-ground. Because the threshold scales with the window and the terrain slope, a large flat roof is removed at a large window while a gentle hillside survives every window. Its four parameters are `window` (the largest structure to remove, in metres), `slope` (expected terrain slope as a rise/run ratio), `threshold` (the elevation tolerance at the smallest window), and `scalar` (how fast the tolerance grows with window size).

**CSF** — Cloth Simulation Filter — inverts the cloud and drops a simulated cloth onto it from above. The cloth is a grid of masses connected by springs; it settles onto the inverted surface, and points within a distance of the settled cloth are ground. Its parameters are `resolution` (the cloth grid spacing), `rigidness` (how much the cloth resists bending), `threshold` (the distance from cloth to point that counts as ground), and `step` (the time step of the simulation).

<figure class="diagram">
<svg viewBox="-19 28 799 220" role="img" aria-labelledby="lc-two-t lc-two-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lc-two-t">How SMRF and CSF each find the ground</title>
  <desc id="lc-two-d">SMRF opens the minimum-elevation surface with a growing window, so structures wider than the window are removed while terrain slope survives. CSF inverts the cloud and settles a simulated cloth onto it from above, so the cloth drapes over the inverted terrain and everything far from it is non-ground.</desc>
  <rect class="svg-bg" x="-19" y="28" width="799" height="220" fill="#ffffff"/>
  <path d="M40 155 L110 151 L150 105 L230 105 L250 153 L330 145 L360 85 L380 85 L400 149 L470 145"
        fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M40 157 L110 153 L150 153 L230 154 L250 155 L330 147 L360 148 L380 148 L400 151 L470 147"
        fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M148 103 h84 v52 h-84 Z" fill="none" stroke="#c46a3d" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="190" y="95" fill="#9a4f26" font-size="11.5" text-anchor="middle">window grows past the roof</text>
  <path d="M540 108 L610 112 L650 158 L730 158" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M540 90 L610 94 L650 96 L730 98" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g stroke="#1f6b8a" stroke-width="1.2">
    <path fill="none" d="M560 90 V62 M600 93 V62 M640 95 V62 M680 97 V62 M720 98 V62"/>
  </g>
  <text x="636" y="54" fill="#1f6b8a" font-size="11.5" text-anchor="middle">cloth falls from above</text>
  <text x="255" y="196" fill="#4f7a4d" font-size="12.5" text-anchor="middle">SMRF — opening of the minimum surface</text>
  <text x="636" y="196" fill="#1f6b8a" font-size="12.5" text-anchor="middle">CSF — cloth settled on the inverted cloud</text>
  <text x="380" y="230" fill="#15384a" font-size="12" text-anchor="middle">SMRF is parameterised in metres of structure and terrain slope; CSF in cloth stiffness and grid spacing — which is why they fail differently</text>
</svg>
<figcaption>Both estimate the same surface. SMRF reasons about the size of things it should remove; CSF reasons about how stiffly a sheet drapes.</figcaption>
</figure>

The practical consequence of that difference is where each one breaks. SMRF's failure mode is scale: a structure larger than `window` is never opened away and stays classified as ground, so a large flat warehouse roof becomes a plateau in the terrain. CSF's failure mode is stiffness: a cloth rigid enough to bridge a building is too rigid to follow a steep ravine, so it either cuts the corner of the ravine or drapes into the building.

**Key Practice:** Choose on terrain character, not on preference. Urban sites with large flat roofs and gentle relief favour CSF with high rigidness; steep or dissected terrain with modest structures favours SMRF with a `window` sized to the largest building and a `slope` matching the landscape. Where a survey contains both, run them per tile with per-tile parameters rather than one setting for the city.

## Step-by-Step Workflow

### 1. Confirm the CRS is metric and the cloud is clean

Both filters interpret their parameters in the data's horizontal units. Degrees produce windows thousands of times too large.

```python
import pdal
import json

info = json.loads(pdal.Pipeline(json.dumps({"pipeline": ["survey.laz",
    {"type": "filters.info"}]})).execute_streaming and "{}" or "{}")

pipeline = pdal.Pipeline(json.dumps({"pipeline": ["survey.laz"]}))
pipeline.execute()
meta = pipeline.metadata["metadata"]["readers.las"]
print("CRS:", meta.get("srs", {}).get("horizontal", "MISSING"))
print("scale:", meta["scale_x"], "offset:", meta["offset_x"])
assert "PROJCRS" in str(meta.get("srs", {}).get("wkt", "")), \
    "cloud is not in a projected CRS — SMRF/CSF windows would be in degrees"
```

### 2. Run SMRF and write the ASPRS codes

`filters.smrf` writes class 2 (ground) and leaves everything else at its incoming class. Set the parameters from the site rather than from the defaults.

```python
import pdal
import json

smrf = {
    "pipeline": [
        "survey_utm33n.laz",
        {"type": "filters.assign", "assignment": "Classification[:]=0"},
        {"type": "filters.smrf",
         "window": 18.0,        # largest structure to remove, metres
         "slope": 0.20,         # expected terrain slope, rise/run
         "threshold": 0.45,     # elevation tolerance at the smallest window
         "scalar": 1.20,        # how fast the tolerance grows with window
         "cell": 1.0},          # raster cell for the minimum surface
        {"type": "writers.las", "filename": "classified_smrf.laz",
         "extra_dims": "all", "forward": "all"},
    ]
}
p = pdal.Pipeline(json.dumps(smrf))
n = p.execute()
print(f"{n} points written")
```

The `filters.assign` stage that resets every class to 0 is deliberate. Delivered clouds frequently arrive with a vendor's classification already in them, and SMRF will not overwrite a class it did not set — so without the reset you are scoring the vendor's filter and believing it is yours.

### 3. Run CSF for comparison on the same tile

Running both on the same input, and comparing, costs minutes and settles the choice with evidence.

```python
csf = {
    "pipeline": [
        "survey_utm33n.laz",
        {"type": "filters.assign", "assignment": "Classification[:]=0"},
        {"type": "filters.csf",
         "resolution": 1.0,     # cloth grid spacing, metres
         "rigidness": 2,        # 1 steep, 2 relief, 3 flat
         "threshold": 0.35,     # cloth-to-point distance counted as ground
         "step": 0.65,
         "iterations": 500},
        {"type": "writers.las", "filename": "classified_csf.laz",
         "extra_dims": "all", "forward": "all"},
    ]
}
print(pdal.Pipeline(json.dumps(csf)).execute(), "points written")
```

`rigidness` is the parameter people get wrong. It is not a quality dial: 1 is for steep terrain, 2 for general relief, 3 for flat sites. Setting 3 on a hillside produces a cloth that spans the valleys and classifies the valley floors as non-ground; setting 1 in a city produces a cloth that drapes into every courtyard.

<figure class="diagram">
<svg viewBox="16 102 708 194" role="img" aria-labelledby="lc-fail-t lc-fail-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lc-fail-t">Each filter's characteristic failure</title>
  <desc id="lc-fail-d">A SMRF window smaller than the widest building leaves that roof classified as ground, producing a plateau in the terrain. A CSF cloth rigid enough to bridge buildings cannot follow a steep ravine, so it cuts across the top and the ravine floor is classified as non-ground.</desc>
  <rect class="svg-bg" x="16" y="102" width="708" height="194" fill="#ffffff"/>
  <path d="M30 210 L110 206 L140 140 L280 140 L310 208 L350 206"
        fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M30 212 L110 208 L140 142 L280 142 L310 210 L350 208"
        fill="none" stroke="#b0413e" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="210" y="128" fill="#b0413e" font-size="11.5" text-anchor="middle">roof wider than window — kept as ground</text>
  <text x="190" y="248" fill="#b0413e" font-size="12.5" text-anchor="middle">SMRF: window too small</text>
  <path d="M400 150 L470 152 L520 232 L560 232 L610 150 L710 148"
        fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M400 152 L470 154 L540 168 L610 152 L710 150"
        fill="none" stroke="#b0413e" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="556" y="200" fill="#b0413e" font-size="11.5" text-anchor="start">cloth spans the ravine</text>
  <text x="556" y="248" fill="#b0413e" font-size="12.5" text-anchor="middle">CSF: rigidness too high</text>
  <text x="370" y="278" fill="#15384a" font-size="12" text-anchor="middle">Both errors are smooth and plausible, which is why they survive a visual check and only surface in a hydrological result</text>
</svg>
<figcaption>Grey is the true surface, dashed red what the filter called ground. Neither failure looks like a bug in a viewer. One raises a plateau where a warehouse was; the other removes a valley floor the drainage model needed.</figcaption>
</figure>

### 4. Extend beyond ground: buildings, vegetation and noise

Ground is one class. A twin usually needs at least buildings and vegetation too, and PDAL composes them from geometric features rather than from a single filter.

```python
classify = {
    "pipeline": [
        "classified_smrf.laz",
        {"type": "filters.hag_nn"},                       # height above ground, per point
        {"type": "filters.approximatecoplanar",           # planarity from local eigenvalues
         "knn": 12, "thresh1": 25, "thresh2": 6},
        # Tall and planar => building (ASPRS 6)
        {"type": "filters.assign",
         "value": ["Classification = 6 WHERE HeightAboveGround > 2.5 && Coplanar == 1"]},
        # Tall and not planar => high vegetation (ASPRS 5)
        {"type": "filters.assign",
         "value": ["Classification = 5 WHERE HeightAboveGround > 2.5 && Coplanar == 0"]},
        # Below the ground surface => noise (ASPRS 7)
        {"type": "filters.assign",
         "value": ["Classification = 7 WHERE HeightAboveGround < -0.3"]},
        {"type": "writers.las", "filename": "classified_full.laz", "forward": "all"},
    ]
}
print(pdal.Pipeline(json.dumps(classify)).execute(), "points classified")
```

`filters.hag_nn` is what makes the rest possible: it attaches each point's height above the nearest ground point, which converts an absolute elevation into a relative one that the same threshold can be applied to across a hilly site. Without it, "taller than 2.5 m" means something different at every elevation.

**Key Practice:** Write the standard ASPRS codes and nothing else — 1 unclassified, 2 ground, 5 high vegetation, 6 building, 7 noise, 9 water. Custom codes above 64 are legitimate for infrastructure assets, but only after the standard ones are populated, because every off-the-shelf tool reads the standard set and silently ignores the rest.

### 5. Score the classifier against labelled points

This is the step that separates a tuned filter from a plausible one. Build a confusion matrix from a stratified manual sample.

```python
import numpy as np
import laspy
from sklearn.metrics import confusion_matrix, classification_report

truth = laspy.read("validation_labelled.laz")        # manually labelled, stratified
pred = laspy.read("classified_full.laz")

# Both files carry the same points in the same order (subset by GpsTime + PointSourceId).
y_true = np.asarray(truth.classification)
y_pred = np.asarray(pred.classification)[: len(y_true)]

labels = [2, 5, 6, 7]
cm = confusion_matrix(y_true, y_pred, labels=labels)
print("rows = truth, cols = predicted\n", cm)
print(classification_report(y_true, y_pred, labels=labels,
                            target_names=["ground", "high veg", "building", "noise"],
                            zero_division=0))
```

Read the ground row rather than the overall accuracy. Producer's accuracy on class 2 — the fraction of true ground points the filter found — below about 95% in open terrain means the filter is removing real ground. The complementary error, ground points that are actually vegetation, is what puts spikes in the terrain model. Overall accuracy hides both because ground is usually the majority class.

<figure class="diagram">
<svg viewBox="6 31 758 275" role="img" aria-labelledby="lc-cm-t lc-cm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lc-cm-t">Reading a classification confusion matrix</title>
  <desc id="lc-cm-d">Rows are the manually labelled truth and columns are what the filter predicted. The diagonal is correct. The cell where true ground was predicted as vegetation is missing terrain; the cell where true vegetation was predicted as ground is a spike in the surface. Overall accuracy averages both away.</desc>
  <rect class="svg-bg" x="6" y="31" width="758" height="275" fill="#ffffff"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="180" y="70" width="130" height="46" rx="4"/>
    <rect x="316" y="122" width="130" height="46" rx="4"/>
    <rect x="452" y="174" width="130" height="46" rx="4"/>
  </g>
  <rect x="316" y="70" width="130" height="46" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="180" y="122" width="130" height="46" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#ffffff" stroke="#e6e0d4" stroke-width="1.5">
    <rect x="452" y="70" width="130" height="46" rx="4"/>
    <rect x="452" y="122" width="130" height="46" rx="4"/>
    <rect x="180" y="174" width="130" height="46" rx="4"/>
    <rect x="316" y="174" width="130" height="46" rx="4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="245" y="99">18 402</text>
    <text x="381" y="99">742</text>
    <text x="517" y="99">61</text>
    <text x="245" y="151">318</text>
    <text x="381" y="151">9 116</text>
    <text x="517" y="151">204</text>
    <text x="245" y="203">44</text>
    <text x="381" y="203">160</text>
    <text x="517" y="203">6 380</text>
  </g>
  <g fill="#ffffff" stroke="#e6e0d4" stroke-width="1.5">
    <rect x="20" y="70" width="150" height="46" rx="4"/>
    <rect x="20" y="122" width="150" height="46" rx="4"/>
    <rect x="20" y="174" width="150" height="46" rx="4"/>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="95" y="99">true ground</text>
    <text x="95" y="151">true vegetation</text>
    <text x="95" y="203">true building</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="245" y="58">pred ground</text>
    <text x="381" y="58">pred vegetation</text>
    <text x="517" y="58">pred building</text>
  </g>
  <text x="620" y="99" fill="#b0413e" font-size="11.5" text-anchor="start">742 holes in the terrain</text>
  <text x="620" y="151" fill="#b0413e" font-size="11.5" text-anchor="start">318 spikes in the terrain</text>
  <text x="380" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">Overall accuracy here is 96.1%, and the two red cells are the only ones that reach a hydrological model</text>
  <text x="380" y="288" fill="#5b6471" font-size="12" text-anchor="middle">Report per-class producer's accuracy, stratified by terrain type — a city-wide figure hides a failing hillside</text>
</svg>
<figcaption>The two off-diagonal cells adjacent to ground are the entire story. One removes terrain, the other invents it, and the headline accuracy is indifferent to both.</figcaption>
</figure>

### 6. Gate the result before it reaches a terrain model

Turn the scoring into a check that fails a build.

```python
import numpy as np
import laspy

MIN_GROUND_RECALL = 0.95
MAX_VEG_AS_GROUND = 0.02

def gate(truth_path, pred_path):
    t = np.asarray(laspy.read(truth_path).classification)
    p = np.asarray(laspy.read(pred_path).classification)[: len(t)]
    problems = []

    is_ground = t == 2
    recall = float((p[is_ground] == 2).mean())
    if recall < MIN_GROUND_RECALL:
        problems.append(f"ground recall {recall:.3f} < {MIN_GROUND_RECALL}")

    is_veg = t == 5
    leak = float((p[is_veg] == 2).mean())
    if leak > MAX_VEG_AS_GROUND:
        problems.append(f"vegetation classified as ground {leak:.3f} > {MAX_VEG_AS_GROUND}")

    if 2 not in set(np.unique(p)):
        problems.append("no ground class in the output at all")

    return problems

issues = gate("validation_labelled.laz", "classified_full.laz")
print("\n".join(issues) if issues else "classification gate passed")
```

The third check looks trivial and is the one that fires most often in practice: a pipeline whose `filters.smrf` stage was silently skipped — because the input was already classified and the assign stage was removed — produces a file with no class 2 at all, and every downstream stage treats it as an empty terrain.

## Validation & Verification

Beyond the confusion matrix, two checks catch faults the sample cannot see.

The first is a comparison against surveyed control. Take the classified ground points within a metre of each control point, take their median height, and difference it against the surveyed value. A systematic offset across all control points is a datum problem rather than a classification one and belongs in the [vertical datum](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) work; a random scatter wider than the survey specification is a filter or trajectory problem.

The second is a class histogram compared against expectation. A city tile with 3% ground is not a tuning problem, it is a filter that failed; a rural tile with 96% ground and no vegetation in a forested area is the same failure in the other direction.

```python
import numpy as np
import laspy

las = laspy.read("classified_full.laz")
codes, counts = np.unique(las.classification, return_counts=True)
total = counts.sum()
for c, n in zip(codes, counts):
    print(f"class {c:>3}: {n:>10,}  {100 * n / total:5.1f}%")

ground_frac = counts[codes == 2].sum() / total
assert 0.15 < ground_frac < 0.85, f"ground fraction {ground_frac:.2f} is implausible for this site"
```

Expected outcome for a typical urban tile: ground 30–50%, building 20–35%, vegetation 15–30%, noise well under 1%. The bounds are deliberately wide because the right values depend entirely on the site — what matters is that you state the expectation for *your* sites and let the assertion catch the run that leaves it.

## Performance & Scale

SMRF and CSF are both O(n) in points but very different in memory. SMRF rasterises to a grid and streams, so its footprint is set by the grid rather than by the cloud, and a billion-point tile is tractable. CSF holds the whole cloud plus a cloth grid in memory and does not stream, so it needs the tile to fit — in practice about 40–60 million points per 16 GB of RAM.

The practical arrangement for a city is to tile, filter per tile with a shared overlap buffer, and merge. The buffer matters for the same reason it matters in [DEM mosaicking](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/merging-and-mosaicking-dem-tiles-with-gdal/): both filters estimate a surface from neighbours, and a tile edge without a buffer has neighbours on one side only, so the estimated ground bends upward toward every boundary.

```python
import json
import pdal

def classify_tile(path, out, buffer_m=50.0, bounds=None):
    stages = [
        {"type": "readers.las", "filename": path},
        {"type": "filters.crop", "bounds": bounds} if bounds else None,
        {"type": "filters.smrf", "window": 18.0, "slope": 0.2,
         "threshold": 0.45, "scalar": 1.2},
        {"type": "filters.crop", "bounds": bounds} if bounds else None,   # trim the buffer back off
        {"type": "writers.las", "filename": out, "forward": "all"},
    ]
    return pdal.Pipeline(json.dumps({"pipeline": [s for s in stages if s]})).execute()
```

Note the crop appearing twice: once wide to bring the buffer in, once narrow to remove it after filtering. Classifying with the buffer and writing without it is what makes the tiles mergeable without a seam.

## Failure Modes & Gotchas

- **Filtering a cloud that is already classified.** SMRF will not overwrite an existing non-zero class, so running it on a vendor-classified file changes almost nothing and the scoring measures the vendor. Reset with `filters.assign` first, or explicitly decide to keep the delivery's classification.
- **A `window` smaller than the largest building.** The roof survives every opening and becomes a plateau in the terrain. Size `window` from the largest structure in the tile, not from a default.
- **CSF `rigidness` chosen as a quality setting.** It encodes terrain type: 1 steep, 2 relief, 3 flat. Using 3 everywhere because it looks cleanest in the city removes valley floors in the hills.
- **Low noise dragging the surface down.** One multipath return two metres below the ground defines the local minimum for both filters. Remove outliers before classifying, and classify sub-surface points as 7 afterwards as a second line of defence.
- **Scoring on a non-stratified sample.** A random sample is dominated by the easy majority — open flat ground — and reports 98% while the steep vegetated cutting the drainage model depends on is at 60%. Stratify by terrain type and report per stratum.

## Frequently Asked Questions

### Should I use SMRF or CSF?
Test both on a representative tile and score them. As a prior: SMRF for steep or dissected terrain with modest structures, CSF for flat urban sites with large buildings. Where a survey spans both, parameterise per tile rather than picking one for the city.

### Do I need to classify at all if I only want a terrain model?
Yes — a terrain model *is* the ground class rasterised. What you can skip is the building and vegetation classification, provided nothing downstream needs them. Most twins do eventually, and re-running the classification later costs more than doing it once.

### How many validation points do I need?
Enough per stratum, not enough in total. Two hundred labelled points in each of five terrain strata is far more informative than five thousand drawn at random, because the random draw will put nearly all of them in the easy majority class.

### What about deep-learning classifiers?
They work well on data resembling their training set and degrade quietly outside it. The practical arrangement is to keep the geometric filter as the baseline and gate, use the learned model where it demonstrably beats it on your scored sample, and never ship a learned classification that has not been scored on the same stratified sample as the geometric one.

### Where do custom ASPRS codes fit?
Above 64, and only after the standard classes are populated. Power lines, rail, and bridge bearings are legitimate custom classes; putting them in the 1–63 range collides with the reserved set and every generic tool misreads them.

## Related Guides

- [PDAL SMRF vs CSF Ground Classification](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/pdal-smrf-vs-csf-ground-classification/) — the parameter-by-parameter comparison
- [Extracting Building Footprints from Classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/) — turning class 6 into polygons
- [Reclassifying Noise and Overlap Points with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/reclassifying-noise-and-overlap-points-with-pdal/) — classes 7 and 12, and why they matter
- [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) — the outlier removal that must run first
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — what the ground class becomes

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
