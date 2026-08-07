---
title: "Extracting Building Footprints from Classified LiDAR"
description: "Turn ASPRS class 6 into clean polygons: cluster, alpha-shape, regularise to right angles, and validate against a cadastre with IoU before publishing."
---
# Extracting Building Footprints from Classified LiDAR

This page turns the building class of a classified LiDAR cloud into polygon footprints a twin can use — clustering class 6 returns into per-building groups, deriving a boundary with an alpha shape, regularising it to the right angles buildings actually have, and validating the result against a cadastre with intersection-over-union before any of it is published. The output is the layer that joins geometry to attributes, so its quality decides whether a click in the viewer returns the right building.

## Why you hit this

A classified cloud tells you which returns hit a building. It does not tell you *which* building, where its edges are, or what shape it is — and every one of those is needed the moment the twin has to attach an address, a construction year, or an energy rating to geometry. Footprints are also the join key between the point cloud and every municipal register, so an extraction that merges two terraced houses into one polygon quietly merges their attributes too.

The class this consumes comes out of [LiDAR classification and ground extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/); the polygons this produces are what a [CityGML register](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) or a batch table keys on.

## Prerequisites

- Python 3.10+ with `laspy>=2.5`, `numpy>=1.24`, `scikit-learn>=1.3`, `shapely>=2.0`, `geopandas>=0.14` and `alphashape>=1.3`.
- A cloud with ASPRS class 6 populated and a metric projected CRS — EPSG:32633 in the examples.
- A reference layer for validation: a cadastral footprint set, or a manually digitised sample of thirty to fifty buildings.

## Step-by-Step

### 1. Load class 6 and cluster it into buildings

DBSCAN is the right clustering choice here because the number of buildings is unknown and the density is roughly uniform within each roof.

```python
import laspy
import numpy as np
from sklearn.cluster import DBSCAN

las = laspy.read("classified_full.laz")
is_building = np.asarray(las.classification) == 6
xy = np.column_stack([np.asarray(las.x)[is_building],
                      np.asarray(las.y)[is_building]])

# eps ~= 2-3x point spacing; min_samples excludes chimneys and clutter
db = DBSCAN(eps=1.2, min_samples=40, algorithm="ball_tree").fit(xy)
labels = db.labels_
n = labels.max() + 1
print(f"{is_building.sum():,} building points → {n} clusters, "
      f"{(labels == -1).sum():,} unassigned")
```

`eps` is the parameter that decides whether a terrace becomes one building or six. Set it from the point spacing — two to three times the mean spacing — and check the result against a known terrace before trusting it across the city. Too large and adjoining buildings merge; too small and a roof with a courtyard splits in two.

### 2. Derive a boundary with an alpha shape

A convex hull is wrong for anything but a rectangle. An alpha shape follows concavities, and its single parameter controls how deeply.

```python
import alphashape
from shapely.geometry import MultiPoint

def footprint(points_xy, alpha=0.35):
    if len(points_xy) < 4:
        return None
    shape = alphashape.alphashape(points_xy, alpha)
    return shape if shape.geom_type in ("Polygon", "MultiPolygon") else None

polys = {}
for cid in range(n):
    pts = xy[labels == cid]
    poly = footprint(pts)
    if poly is not None and poly.area > 25.0:      # drop sheds and clutter
        polys[cid] = poly
print(f"{len(polys)} footprints above 25 m²")
```

Alpha is an inverse length: larger values follow finer concavities and eventually start eating into the shape, smaller values approach the convex hull. Around 0.3–0.5 suits typical building point densities, and the check is visual on a courtyard block — the courtyard should appear as a hole, not be filled and not be cut open.

<figure class="diagram">
<svg viewBox="5 6 719 278" role="img" aria-labelledby="bf-alpha-t bf-alpha-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bf-alpha-t">Convex hull, alpha shape and an over-tight alpha</title>
  <desc id="bf-alpha-d">A convex hull over an L-shaped building fills the notch entirely. An alpha shape at a suitable value follows the notch and the courtyard. Too large an alpha starts cutting into the boundary between points and produces a ragged, holed polygon.</desc>
  <rect class="svg-bg" x="5" y="6" width="719" height="278" fill="#ffffff"/>
  <g fill="#1f6b8a">
    <circle cx="50" cy="90" r="2.4"/><circle cx="80" cy="90" r="2.4"/><circle cx="110" cy="90" r="2.4"/><circle cx="140" cy="90" r="2.4"/>
    <circle cx="50" cy="120" r="2.4"/><circle cx="80" cy="120" r="2.4"/><circle cx="110" cy="120" r="2.4"/><circle cx="140" cy="120" r="2.4"/>
    <circle cx="50" cy="150" r="2.4"/><circle cx="80" cy="150" r="2.4"/>
    <circle cx="50" cy="180" r="2.4"/><circle cx="80" cy="180" r="2.4"/>
  </g>
  <path d="M44 84 H146 V126 H86 V186 H44 Z" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M44 84 H146 V126 H44 Z" fill="none" stroke="#b0413e" stroke-width="0"/>
  <path d="M44 84 L146 84 L146 126 L86 186 L44 186 Z" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="300" cy="90" r="2.4"/><circle cx="330" cy="90" r="2.4"/><circle cx="360" cy="90" r="2.4"/><circle cx="390" cy="90" r="2.4"/>
    <circle cx="300" cy="120" r="2.4"/><circle cx="330" cy="120" r="2.4"/><circle cx="360" cy="120" r="2.4"/><circle cx="390" cy="120" r="2.4"/>
    <circle cx="300" cy="150" r="2.4"/><circle cx="330" cy="150" r="2.4"/>
    <circle cx="300" cy="180" r="2.4"/><circle cx="330" cy="180" r="2.4"/>
  </g>
  <path d="M294 84 H396 V126 H336 V186 H294 Z" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="560" cy="90" r="2.4"/><circle cx="590" cy="90" r="2.4"/><circle cx="620" cy="90" r="2.4"/><circle cx="650" cy="90" r="2.4"/>
    <circle cx="560" cy="120" r="2.4"/><circle cx="590" cy="120" r="2.4"/><circle cx="620" cy="120" r="2.4"/><circle cx="650" cy="120" r="2.4"/>
    <circle cx="560" cy="150" r="2.4"/><circle cx="590" cy="150" r="2.4"/>
    <circle cx="560" cy="180" r="2.4"/><circle cx="590" cy="180" r="2.4"/>
  </g>
  <path d="M556 86 L590 84 L622 90 L650 86 L654 122 L620 118 L592 126 L594 152 L588 184 L558 186 Z"
        fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <text x="95" y="222" fill="#b0413e" font-size="12.5" text-anchor="middle">convex hull — notch filled</text>
  <text x="345" y="222" fill="#4f7a4d" font-size="12.5" text-anchor="middle">alpha ≈ 0.35 — notch followed</text>
  <text x="605" y="222" fill="#c46a3d" font-size="12.5" text-anchor="middle">alpha too large — boundary ragged</text>
  <text x="380" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">One L-shaped roof, three boundary choices</text>
  <text x="380" y="266" fill="#15384a" font-size="12" text-anchor="middle">Check alpha on a courtyard block: the courtyard should be a hole, not filled and not cut open</text>
</svg>
<figcaption>The middle case is the target. The right-hand failure is easy to miss at city zoom and shows up as a per-building area that is a few per cent low everywhere.</figcaption>
</figure>

### 3. Regularise to the angles buildings actually have

An alpha shape follows the points, and points are noisy, so the raw boundary has hundreds of vertices and no right angles. Buildings almost always do.

```python
import numpy as np
from shapely.geometry import Polygon
from shapely import affinity

def dominant_angle(poly: Polygon) -> float:
    """Angle of the longest edge, in degrees, wrapped to [0, 90)."""
    c = np.asarray(poly.exterior.coords)
    seg = np.diff(c, axis=0)
    lengths = np.hypot(seg[:, 0], seg[:, 1])
    dx, dy = seg[np.argmax(lengths)]
    return float(np.degrees(np.arctan2(dy, dx)) % 90.0)

def regularise(poly: Polygon, tol: float = 0.35) -> Polygon:
    theta = dominant_angle(poly)
    rotated = affinity.rotate(poly, -theta, origin="centroid", use_radians=False)
    boxed = rotated.simplify(tol, preserve_topology=True)
    snapped = boxed.envelope if boxed.area / boxed.envelope.area > 0.92 else boxed
    return affinity.rotate(snapped, theta, origin="centroid")

regular = {cid: regularise(p) for cid, p in polys.items()
           if p.geom_type == "Polygon"}
print("regularised", len(regular), "footprints")
```

The rotate–simplify–rotate-back pattern is what makes the simplification axis-aware: after rotating the dominant edge onto the X axis, a Douglas–Peucker simplification naturally preserves the axis-aligned edges and removes the noise between them. The `envelope` substitution snaps a nearly-rectangular footprint to an exact rectangle, which is right for most buildings and wrong for L-shapes — hence the 0.92 area-ratio guard.

### 4. Write the layer with a CRS and a stable id

A footprint without a stable identifier cannot be joined to anything on the next run.

```python
import geopandas as gpd
import hashlib

def stable_id(poly):
    c = poly.centroid
    key = f"{round(c.x, 2)}_{round(c.y, 2)}"
    return "BLD_" + hashlib.sha1(key.encode()).hexdigest()[:12]

gdf = gpd.GeoDataFrame(
    {"bld_id": [stable_id(p) for p in regular.values()],
     "area_m2": [round(p.area, 2) for p in regular.values()],
     "n_points": [int((labels == cid).sum()) for cid in regular]},
    geometry=list(regular.values()),
    crs="EPSG:32633",
)
gdf.to_file("footprints.gpkg", layer="buildings", driver="GPKG")
print(gdf.head())
```

Hashing the rounded centroid gives an id that survives a re-run over the same data and changes only when the building moves — which is exactly the behaviour a change-detection pass wants. An incrementing integer would renumber the whole city whenever one building is added.

### 5. Validate against a reference with intersection-over-union

IoU is the measure that catches both over- and under-segmentation, which a simple count cannot.

```python
import geopandas as gpd

ours = gpd.read_file("footprints.gpkg", layer="buildings")
ref = gpd.read_file("cadastre.gpkg").to_crs(ours.crs)

joined = gpd.sjoin(ours, ref, how="left", predicate="intersects")
rows = []
for _, r in joined.dropna(subset=["index_right"]).iterrows():
    a = r.geometry
    b = ref.geometry.iloc[int(r.index_right)]
    inter = a.intersection(b).area
    union = a.union(b).area
    rows.append(inter / union if union else 0.0)

import numpy as np
iou = np.array(rows)
print(f"matched {len(iou)} of {len(ours)} footprints")
print(f"IoU median {np.median(iou):.3f}  |  fraction above 0.7: {(iou > 0.7).mean():.3f}")
```

<figure class="diagram">
<svg viewBox="26 14 698 272" role="img" aria-labelledby="bf-iou-t bf-iou-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bf-iou-t">What intersection-over-union detects that a count does not</title>
  <desc id="bf-iou-d">A merged terrace produces one extracted polygon covering three reference footprints, so each match scores about one third. A split roof produces three polygons against one reference. A well-matched building scores above 0.85. Counting polygons alone reports all three cases as plausible.</desc>
  <rect class="svg-bg" x="26" y="14" width="698" height="272" fill="#ffffff"/>
  <path d="M40 80 h200 v90 h-200 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="5 4">
    <path d="M44 84 h62 v82 h-62 Z"/><path d="M110 84 h62 v82 h-62 Z"/><path d="M176 84 h60 v82 h-60 Z"/>
  </g>
  <path d="M300 80 h160 v90 h-160 Z" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="5 4"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5">
    <path d="M304 84 h48 v82 h-48 Z"/><path d="M356 84 h48 v82 h-48 Z"/><path d="M408 84 h48 v82 h-48 Z"/>
  </g>
  <path d="M540 82 h170 v88 h-170 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M546 86 h162 v82 h-162 Z" fill="none" stroke="#c46a3d" stroke-width="2" stroke-dasharray="5 4"/>
  <text x="140" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">merged terrace — IoU ≈ 0.33</text>
  <text x="380" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">split roof — IoU ≈ 0.31 each</text>
  <text x="625" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">good match — IoU ≈ 0.91</text>
  <text x="380" y="42" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Solid blue: extracted. Dashed amber: reference.</text>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Polygon counts are 1-vs-3, 3-vs-1 and 1-vs-1 — only IoU tells you the first two are failures</text>
  <text x="380" y="268" fill="#5b6471" font-size="12" text-anchor="middle">Tune DBSCAN eps against the merged case and alpha against the split one</text>
</svg>
<figcaption>The two failure directions have opposite fixes, and only a per-polygon overlap measure distinguishes them.</figcaption>
</figure>

## Expected Output & Verification

A representative run over a dense urban tile:

```text
812,440 building points → 1,284 clusters, 9,102 unassigned
1,196 footprints above 25 m²
regularised 1,196 footprints
matched 1,174 of 1,196 footprints
IoU median 0.874  |  fraction above 0.7: 0.941
```

An IoU median above about 0.85 with more than 90% of footprints over 0.7 is a usable extraction for a city twin. The twenty-two unmatched polygons are worth inspecting individually rather than tuning away — they are typically new construction absent from the cadastre, which is a finding rather than an error.

<figure class="diagram">
<svg viewBox="76 6 721 268" role="img" aria-labelledby="bf-hist-t bf-hist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bf-hist-t">The IoU distribution, and what each part of it means</title>
  <desc id="bf-hist-d">Most footprints cluster above 0.85, which is a good match. A shoulder between 0.4 and 0.7 is usually regularisation trimming or extending an edge. A spike below 0.4 is segmentation: terraces merged or roofs split. Each region has a different remedy.</desc>
  <rect class="svg-bg" x="76" y="6" width="721" height="268" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="90" y="196" width="52" height="20" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="150" y="186" width="52" height="30" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="210" y="176" width="52" height="40" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="162" width="52" height="54" rx="3" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="330" y="140" width="52" height="76" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="390" y="104" width="52" height="112" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="70" width="52" height="146" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="88" width="52" height="128" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <path d="M80 216 H600" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="116" y="234">0.3</text><text x="176" y="234">0.4</text><text x="236" y="234">0.5</text>
    <text x="296" y="234">0.6</text><text x="356" y="234">0.7</text><text x="416" y="234">0.8</text>
    <text x="476" y="234">0.9</text><text x="536" y="234">1.0</text>
  </g>
  <text x="340" y="256" fill="#5b6471" font-size="12" text-anchor="middle">intersection over union</text>
  <text x="620" y="112" fill="#4f7a4d" font-size="12" text-anchor="start">good match — ship</text>
  <text x="620" y="172" fill="#c46a3d" font-size="12" text-anchor="start">edge trimming — tune alpha</text>
  <text x="620" y="200" fill="#b0413e" font-size="12" text-anchor="start">merged or split — tune eps</text>
  <text x="370" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Where a footprint lands on this axis names the parameter to change</text>
</svg>
<figcaption>The distribution is more useful than the median. Its left tail is a segmentation problem and its middle shoulder is a boundary problem, and they are tuned with different parameters.</figcaption>
</figure>

## Common Errors

**A whole terrace comes out as one polygon.** DBSCAN's `eps` is larger than the gap between adjoining roofs — which for a terrace is zero. Terraces need either a smaller `eps` with a higher `min_samples`, or a segmentation that uses roof plane normals rather than XY proximity alone.

**Every footprint is a rectangle, including the L-shaped ones.** The `envelope` substitution in `regularise` fired because the area ratio guard was too loose. Raise the 0.92 threshold, or drop the substitution and rely on the rotated simplification alone.

**`TopologyException` when computing IoU.** One of the alpha shapes is self-intersecting. Run `poly.buffer(0)` before any set operation — it is the standard Shapely idiom for repairing a ring that crosses itself.

## Frequently Asked Questions

### Should I extract footprints from the point cloud or use the cadastre?
Use the cadastre where it exists and is current, and extract to find what it is missing. The extraction's real value in a maintained city is change detection: buildings present in the cloud and absent from the register are new construction, and the reverse is demolition.

### What minimum area should I keep?
Twenty-five square metres removes sheds, bin stores and clutter without losing a small house. If the twin needs outbuildings, drop the threshold and expect the polygon count to roughly double.

### Can I get building height at the same time?
Yes, and it is nearly free: take the height-above-ground of the class 6 points in each cluster and use a high percentile — the 95th rather than the maximum, so a chimney or an aerial does not set the building height.

A closing note on when to run this. Footprint extraction is cheap relative to the classification that precedes it, so the temptation is to run it on every delivery and overwrite the layer. Resist that: keep each run's output versioned by acquisition date and diff successive versions rather than replacing. The diff is the product a city actually wants — new construction, demolition, extensions — and it is only available if the previous extraction still exists. Overwriting turns a change-detection capability into a snapshot, at no saving in compute.

The other thing worth versioning is the parameter set. `eps`, `min_samples` and `alpha` together determine whether a terrace is one polygon or six, so a diff between two runs with different parameters reports building changes that are really parameter changes. Store all three alongside the layer and refuse to diff two versions that disagree on them.

## Related Guides

- [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/) — producing the class 6 this consumes
- [PDAL SMRF vs CSF Ground Classification](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/pdal-smrf-vs-csf-ground-classification/) — the ground filter beneath it
- [CityGML vs 3D Tiles for Municipal Twin Delivery](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/citygml-vs-3d-tiles-for-municipal-twin-delivery/) — where footprints join attributes

Back to [LiDAR Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
