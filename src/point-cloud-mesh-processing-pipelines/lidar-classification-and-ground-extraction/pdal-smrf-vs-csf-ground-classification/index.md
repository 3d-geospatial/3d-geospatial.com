---
title: "PDAL SMRF vs CSF Ground Classification"
description: "Run filters.smrf and filters.csf on the same tile, map each parameter to what it physically controls, and score both against labelled points before choosing."
---
# PDAL SMRF vs CSF Ground Classification

This page runs `filters.smrf` and `filters.csf` over the same LiDAR tile, maps every parameter to the physical thing it controls, and scores both against a labelled sample so the choice is made on numbers rather than on which output looks tidier. Both filters estimate the same surface — the lower envelope of the cloud — and they disagree in predictable places, which is what makes a per-site comparison worth the twenty minutes it takes.

## Why you hit this

Ground classification is the first irreversible decision in a terrain pipeline. Everything downstream — the [DEM](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/), the flood extent, the clearance envelope, the volumetrics — is computed from the points this filter kept, and a point wrongly removed cannot be recovered by any later stage. The two filters PDAL ships are both good and neither is universally better, so teams tend to adopt whichever they saw first and carry it to sites it does not suit.

## Prerequisites

- PDAL 2.6+ with the CSF plugin built in (`conda install -c conda-forge pdal` includes it; check with `pdal --drivers | grep csf`).
- A tile in a projected metric CRS with outliers already removed, per [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
- A few thousand manually labelled points across the tile's terrain types, for scoring.
- `laspy>=2.5`, `numpy>=1.24`, `scikit-learn>=1.3`.

## Step-by-Step

### 1. Map each SMRF parameter to what it controls

SMRF has four parameters and every one of them is a physical quantity, which makes it tunable by reasoning about the site rather than by search.

```python
SMRF = {
    "type": "filters.smrf",
    "cell": 1.0,        # raster cell for the minimum surface, metres.
                        #   ~= the point spacing; finer wastes work, coarser loses detail
    "window": 18.0,     # the LARGEST structure to remove, metres.
                        #   must exceed the widest building footprint on the tile
    "slope": 0.20,      # expected terrain slope as rise/run.
                        #   0.05 for a floodplain, 0.2 general, 0.5+ for mountainous
    "threshold": 0.45,  # elevation tolerance at the smallest window, metres.
                        #   ~= 2-3x the vertical accuracy of the survey
    "scalar": 1.20,     # how fast the tolerance grows with window size.
                        #   raise it where terrain is rough, lower it where it is smooth
}
```

`window` is the one that decides success. It is not a smoothing radius; it is a statement about the largest thing in the scene that is not terrain. Set it to 12 m on a tile containing a 40 m warehouse and the warehouse roof survives every opening and becomes a plateau.

### 2. Map each CSF parameter the same way

CSF's parameters describe a physical simulation, and two of them are commonly misread.

```python
CSF = {
    "type": "filters.csf",
    "resolution": 1.0,   # cloth grid spacing, metres. Finer follows more detail and
                         #   costs quadratically; ~= point spacing is the usual choice
    "rigidness": 2,      # TERRAIN TYPE, not quality: 1 steep, 2 relief, 3 flat
    "threshold": 0.35,   # cloth-to-point distance counted as ground, metres
    "step": 0.65,        # simulation time step; smaller is stabler and slower
    "iterations": 500,   # simulation steps; raise until the cloth stops moving
    "smooth": True,      # post-settle smoothing of the cloth
}
```

`rigidness` is an enumeration of terrain character with three valid values, not a dial. A stiff cloth spans buildings well and also spans ravines; a slack one follows a ravine and also sags into a courtyard. `iterations` is the other one worth checking — if the cloth has not settled when the simulation stops, the result depends on the iteration count, which is a silent source of run-to-run variation.

<figure class="diagram">
<svg viewBox="10 18 767 272" role="img" aria-labelledby="sc-param-t sc-param-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sc-param-t">What each parameter is actually a statement about</title>
  <desc id="sc-param-d">SMRF's window is a statement about the largest non-terrain structure, its slope about the landscape, its threshold about the survey's vertical accuracy. CSF's resolution is a statement about point spacing and its rigidness about terrain type. Reading them as tuning dials rather than as descriptions of the site is what makes them hard to set.</desc>
  <rect class="svg-bg" x="10" y="18" width="767" height="272" fill="#ffffff"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2">
    <rect x="24" y="66" width="150" height="34" rx="6"/>
    <rect x="24" y="110" width="150" height="34" rx="6"/>
    <rect x="24" y="154" width="150" height="34" rx="6"/>
    <rect x="24" y="198" width="150" height="34" rx="6"/>
  </g>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="410" y="66" width="150" height="34" rx="6"/>
    <rect x="410" y="110" width="150" height="34" rx="6"/>
    <rect x="410" y="154" width="150" height="34" rx="6"/>
    <rect x="410" y="198" width="150" height="34" rx="6"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="99" y="88">window</text>
    <text x="99" y="132">slope</text>
    <text x="99" y="176">threshold</text>
    <text x="99" y="220">cell</text>
    <text x="485" y="88">rigidness</text>
    <text x="485" y="132">resolution</text>
    <text x="485" y="176">threshold</text>
    <text x="485" y="220">iterations</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="184" y="88">the widest building on the tile</text>
    <text x="184" y="132">the landscape&#39;s rise over run</text>
    <text x="184" y="176">the survey&#39;s vertical accuracy</text>
    <text x="184" y="220">the point spacing</text>
    <text x="570" y="88">terrain type: 1 steep, 2 relief, 3 flat</text>
    <text x="570" y="132">the point spacing</text>
    <text x="570" y="176">the survey&#39;s vertical accuracy</text>
    <text x="570" y="220">enough for the cloth to settle</text>
  </g>
  <text x="99" y="46" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">SMRF</text>
  <text x="485" y="46" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">CSF</text>
  <text x="380" y="272" fill="#15384a" font-size="12.5" text-anchor="middle">Every one of these is measurable from the site or the survey report — none of them needs a parameter sweep to find</text>
</svg>
<figcaption>Both filters are fully determined by things you already know about the survey. The search only starts when a parameter is treated as a quality setting.</figcaption>
</figure>

### 3. Run both on the same input in one pipeline pass

Reading the tile once and branching keeps the comparison honest and halves the I/O.

```python
import json
import pdal

both = {
    "pipeline": [
        {"type": "readers.las", "filename": "tile_utm33n.laz", "tag": "src"},
        {"type": "filters.assign", "assignment": "Classification[:]=0", "tag": "reset"},

        {"type": "filters.smrf", "inputs": ["reset"], "tag": "smrf",
         "cell": 1.0, "window": 18.0, "slope": 0.20, "threshold": 0.45, "scalar": 1.20},
        {"type": "writers.las", "inputs": ["smrf"], "filename": "out_smrf.laz",
         "forward": "all"},

        {"type": "filters.csf", "inputs": ["reset"], "tag": "csf",
         "resolution": 1.0, "rigidness": 2, "threshold": 0.35,
         "step": 0.65, "iterations": 500, "smooth": True},
        {"type": "writers.las", "inputs": ["csf"], "filename": "out_csf.laz",
         "forward": "all"},
    ]
}
p = pdal.Pipeline(json.dumps(both))
print(p.execute(), "points through both filters")
```

### 4. Score both against the labelled sample

The comparison that decides it is per-class recall on ground, plus the vegetation-into-ground leak that puts spikes in the surface.

```python
import numpy as np
import laspy
from sklearn.metrics import confusion_matrix

truth = np.asarray(laspy.read("validation_labelled.laz").classification)

def score(path):
    pred = np.asarray(laspy.read(path).classification)[: len(truth)]
    cm = confusion_matrix(truth, pred, labels=[2, 5, 6])
    ground_recall = cm[0, 0] / cm[0].sum()
    veg_as_ground = cm[1, 0] / cm[1].sum()
    bld_as_ground = cm[2, 0] / cm[2].sum()
    return ground_recall, veg_as_ground, bld_as_ground

for name, path in (("SMRF", "out_smrf.laz"), ("CSF", "out_csf.laz")):
    gr, vg, bg = score(path)
    print(f"{name}: ground recall {gr:.3f} | veg→ground {vg:.4f} | bld→ground {bg:.4f}")
```

Three numbers, and they trade against each other. A filter can always raise ground recall by being more permissive, at the cost of letting vegetation and buildings through. What you are choosing is the point on that trade-off that suits the downstream product: a drainage model tolerates missing ground far better than it tolerates a spike, a volumetric calculation is the reverse.

### 5. Score per stratum, not per tile

A single figure for the tile hides exactly the terrain where the filter struggles.

```python
import numpy as np
import laspy

las = laspy.read("validation_labelled.laz")
stratum = np.asarray(las.point_source_id)   # or a slope band, or a land-cover code

pred = np.asarray(laspy.read("out_smrf.laz").classification)[: len(stratum)]
truth = np.asarray(las.classification)

for s in np.unique(stratum):
    m = (stratum == s) & (truth == 2)
    if m.sum() < 50:
        continue
    print(f"stratum {s}: ground recall {(pred[m] == 2).mean():.3f}  (n={m.sum()})")
```

<figure class="diagram">
<svg viewBox="95 6 602 291" role="img" aria-labelledby="sc-strat-t sc-strat-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sc-strat-t">One tile figure against four stratum figures</title>
  <desc id="sc-strat-d">A single tile-wide ground recall of 0.96 is composed of 0.99 on flat open ground, 0.98 under sparse canopy, 0.94 in the urban core and 0.71 on the steep vegetated cutting. Only the last of those matters to the drainage model, and the tile figure conceals it entirely.</desc>
  <rect class="svg-bg" x="95" y="6" width="602" height="291" fill="#ffffff"/>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Ground recall, same filter, same tile</text>
  <rect x="120" y="60" width="404" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke-width="2">
    <rect x="120" y="112" width="416" height="26" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="120" y="148" width="412" height="26" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="120" y="184" width="395" height="26" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="120" y="220" width="298" height="26" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="534" y="80">0.96 — whole tile</text>
    <text x="546" y="130">0.99 — flat open ground</text>
    <text x="542" y="166">0.98 — sparse canopy</text>
    <text x="525" y="202">0.94 — urban core</text>
    <text x="428" y="238">0.71 — steep vegetated cutting</text>
  </g>
  <text x="380" y="278" fill="#15384a" font-size="12.5" text-anchor="middle">The cutting is 4% of the points and the whole reason the drainage model was commissioned</text>
</svg>
<figcaption>A tile-wide number is an average weighted by how much easy terrain the tile happens to contain. It says nothing about the hard part.</figcaption>
</figure>

## Expected Output & Verification

A representative comparison on a mixed urban tile:

```text
SMRF: ground recall 0.962 | veg→ground 0.0071 | bld→ground 0.0034
CSF : ground recall 0.981 | veg→ground 0.0189 | bld→ground 0.0102
stratum 1: ground recall 0.994  (n=8120)
stratum 2: ground recall 0.981  (n=3044)
stratum 3: ground recall 0.943  (n=5210)
stratum 4: ground recall 0.712  (n=486)
```

Read it as a trade rather than a winner. CSF found two per cent more ground and let roughly three times as much vegetation through, so for a terrain surface feeding a hydrological model SMRF is the safer choice here, and for a volumetric calculation over open ground CSF is. The stratum breakdown says something neither headline does: whichever filter ships, the steep vegetated cutting needs its own parameters or its own pass.

<figure class="diagram">
<svg viewBox="-1 6 695 290" role="img" aria-labelledby="sc-trade-t sc-trade-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sc-trade-t">The trade every ground filter makes</title>
  <desc id="sc-trade-d">Loosening a filter raises the share of true ground it keeps and simultaneously raises the share of vegetation it mistakes for ground. SMRF and CSF sit at different points on that curve with the parameters given, and moving either one along the curve moves both numbers together.</desc>
  <rect class="svg-bg" x="-1" y="6" width="695" height="290" fill="#ffffff"/>
  <path d="M70 56 V216 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M100 200 C 220 170 360 120 620 74" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="6 4"/>
  <circle cx="300" cy="140" r="7" fill="#1f6b8a"/>
  <circle cx="470" cy="100" r="7" fill="#4f7a4d"/>
  <text x="300" y="126" fill="#1f6b8a" font-size="12" text-anchor="middle">SMRF</text>
  <text x="470" y="86" fill="#4f7a4d" font-size="12" text-anchor="middle">CSF</text>
  <text x="380" y="248" fill="#5b6471" font-size="12" text-anchor="middle">vegetation mistaken for ground →</text>
  <text x="34" y="120" fill="#5b6471" font-size="12" text-anchor="middle">ground</text>
  <text x="34" y="136" fill="#5b6471" font-size="12" text-anchor="middle">kept ↑</text>
  <text x="370" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">You are choosing a point on a curve, not a better algorithm</text>
  <text x="370" y="278" fill="#15384a" font-size="12" text-anchor="middle">A drainage model wants the lower left; a volumetric calculation over open ground can afford the upper right</text>
</svg>
<figcaption>Both filters ride the same trade-off. Which one is "better" is a statement about what the terrain is for, not about the algorithms.</figcaption>
</figure>

## Common Errors

**Both filters return almost no ground.** The tile is in a geographic CRS, so `window: 18.0` means eighteen degrees and `cell: 1.0` means a one-degree raster. Reproject to a metric CRS before classifying; the assertion in the parent guide catches it.

**CSF output changes between runs.** The cloth had not settled when `iterations` ran out, so the result depends on where the simulation stopped. Raise `iterations` until two consecutive runs with different values agree, then keep the higher one.

**SMRF leaves a plateau where a large building was.** `window` is smaller than that building's footprint. Measure the widest structure on the tile and set `window` above it; if the tile contains both a warehouse and a steep slope, split the tile rather than compromising the parameter.

## Frequently Asked Questions

### Can I run both and combine them?
Yes, and the useful combination is conservative rather than permissive: classify as ground only where both agree, and route the disagreements to manual review or to a second pass with per-stratum parameters. That trades a little recall for a large drop in the spike rate, which is usually the right direction for a terrain product.

### How long does each take?
On a 40-million-point tile, SMRF runs in a few minutes and streams; CSF takes longer and needs the tile resident. At city scale that difference decides the architecture more often than the accuracy does.

### Do the parameters transfer between surveys?
The ones tied to the survey do — `threshold` follows vertical accuracy, `cell` and `resolution` follow point spacing. The ones tied to the site do not: `window`, `slope` and `rigidness` are statements about the landscape and have to be revisited per area.

One last operational point. Whichever filter you adopt, record the exact parameter set in the tile's metadata alongside the output, not only in the pipeline file. A year later the question is never "what does our pipeline do" but "what was this tile classified with", and those two answers diverge the first time somebody reruns a single tile with an override. A dozen bytes of JSON in the LAS VLR, or a sidecar next to the LAZ, makes the classification reproducible from the artifact rather than from the repository's history.

## Related Guides

- [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/) — the full classification workflow and its gates
- [Extracting Building Footprints from Classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/) — what the building class becomes
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — where the ground class is consumed

Back to [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
