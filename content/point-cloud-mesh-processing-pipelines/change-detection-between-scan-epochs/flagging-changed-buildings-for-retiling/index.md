# Flagging Changed Buildings for Retiling

This page converts the change polygons produced by epoch-to-epoch LiDAR comparison into a retiling work list: matching each polygon to building footprints with a Shapely `STRtree`, classifying buildings as new, altered or demolished from the sign and extent of the change, and mapping the affected footprints to the quadkey shards an incremental tiling job has to rebuild — all in EPSG:32618 with an explicit hand-off to EPSG:4326 for tile addressing.

## Why you hit this

Change detection answers "where did the ground surface move?", and a tiling pipeline asks "which shards are stale?". Between them sits a translation step that is easy to get subtly wrong. Use raw change polygons as the dirty set and every parked lorry and regraded verge triggers a rebuild; use only the building register and the new warehouse that has not been registered yet never appears. The detection side is in [M3C2 change detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/); the rebuild side is in [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/). This page is the join.

## Prerequisites

- `shapely>=2.0`, `pyproj>=3.6`, `mercantile>=1.2`, `numpy>=1.24`.
- Change polygons as GeoJSON in EPSG:32618 with `mean_dz`, `area_m2` and a gain/loss sign — the output of the change-detection workflow.
- Building footprints for the same area in EPSG:32618 with a stable `building_id`, from the municipal register or from [extracting building footprints from classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/).
- The tiling job's shard zoom level; zoom 16 cells are roughly 380 m across at 40° N.

## Step-by-Step

### 1. Load polygons and footprints into an index

```python
import json
from shapely import STRtree
from shapely.geometry import shape

def load_features(path, id_field=None):
    fc = json.load(open(path))
    geoms = [shape(f["geometry"]) for f in fc["features"]]
    props = [f["properties"] for f in fc["features"]]
    if id_field:
        assert len({p[id_field] for p in props}) == len(props), f"{id_field} is not unique"
    return geoms, props

change_geoms, change_props = load_features("changes_2025-06_2026-06.geojson")
bldg_geoms, bldg_props = load_features("footprints_2025.geojson", id_field="building_id")

for g in change_geoms + bldg_geoms:
    assert g.is_valid, "repair invalid geometry with shapely.make_valid before indexing"

tree = STRtree(bldg_geoms)
print(f"{len(change_geoms)} change polygons, {len(bldg_geoms)} footprints indexed")
```

Both files have to be in the same projected CRS, EPSG:32618 here, because overlap is measured as area. A footprint file in EPSG:4326 would load without error and produce overlap fractions computed in square degrees — tiny, meaningless numbers that make every building look unchanged.

### 2. Measure how much of each building changed

```python
from collections import defaultdict

overlap = defaultdict(lambda: {"gain": 0.0, "loss": 0.0, "dz": []})

for cg, cp in zip(change_geoms, change_props):
    kind = "gain" if cp["mean_dz"] > 0 else "loss"
    for i in tree.query(cg, predicate="intersects"):
        shared = cg.intersection(bldg_geoms[i]).area
        if shared > 0:
            rec = overlap[i]
            rec[kind] += shared
            rec["dz"].append((cp["mean_dz"], shared))

for i, rec in list(overlap.items())[:3]:
    print(bldg_props[i]["building_id"], {k: round(v, 1) for k, v in rec.items() if k != "dz"})
```

`STRtree.query` with `predicate="intersects"` returns indices of footprints that genuinely intersect, not merely whose bounding boxes overlap, so the loop body only computes real intersections. Recording the area-weighted `mean_dz` per building lets the next step tell a new storey (a large positive change over most of the roof) from a rooftop plant installation (a small positive change over a few percent).

### 3. Classify buildings, including ones the register does not know

```python
new_buildings = []
status = {}

for i, rec in overlap.items():
    area = bldg_geoms[i].area
    loss_frac, gain_frac = rec["loss"] / area, rec["gain"] / area
    w = sum(a for _, a in rec["dz"])
    mean_dz = sum(d * a for d, a in rec["dz"]) / w
    if loss_frac > 0.6 and mean_dz < -2.5:
        status[i] = "demolished"
    elif max(loss_frac, gain_frac) > 0.1 and abs(mean_dz) > 0.5:
        status[i] = "altered"

footprint_union = STRtree(bldg_geoms)
for cg, cp in zip(change_geoms, change_props):
    if cp["mean_dz"] > 2.5 and cp["area_m2"] > 30:
        hits = footprint_union.query(cg, predicate="intersects")
        covered = sum(cg.intersection(bldg_geoms[j]).area for j in hits)
        if covered / cg.area < 0.2:
            new_buildings.append(cg)

counts = {s: list(status.values()).count(s) for s in ("demolished", "altered")}
print(counts, "new:", len(new_buildings))
```

The thresholds encode building-scale judgement and are worth stating in plain terms. A demolition removes most of the footprint and drops the surface by at least a storey's height. An alteration changes at least a tenth of the roof by more than half a metre, which excludes antennas and solar panels. A new building is a gain of more than a storey over more than 30 m² that is mostly outside every known footprint. Put these numbers in configuration, not code, so a city with many low sheds can tune them without a release.

<figure class="diagram">
<svg viewBox="6 16 743 260" role="img" aria-labelledby="fcb-class-t fcb-class-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fcb-class-t">How overlap and height change classify a building</title>
  <desc id="fcb-class-d">Four footprint scenarios. A loss polygon covering most of a footprint with a drop of several metres is a demolition. A gain polygon over a part of a roof with a rise of a storey is an alteration. A small gain over a few percent of a roof is ignored as rooftop equipment. A gain polygon with no footprint beneath it is a new building the register does not yet contain.</desc>
  <rect class="svg-bg" x="6" y="16" width="743" height="260" fill="#ffffff"/>
  <rect x="20" y="30" width="160" height="150" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="205" y="30" width="160" height="150" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="390" y="30" width="160" height="150" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="575" y="30" width="160" height="150" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M45 60 h110 v90 h-110 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M40 56 h116 v84 h-116 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2" fill-opacity="0.8"/>
  <path d="M230 60 h110 v90 h-110 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M290 60 h50 v50 h-50 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M415 60 h110 v90 h-110 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M495 70 h16 v14 h-16 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M610 62 h90 v80 h-90 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="206">demolished</text>
    <text x="285" y="206">altered</text>
    <text x="470" y="206">ignored</text>
    <text x="655" y="206">new</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="100" y="226">loss &gt; 60%, dZ &lt; −2.5 m</text>
    <text x="285" y="226">&gt; 10% of roof, |dZ| &gt; 0.5 m</text>
    <text x="470" y="226">3% of roof: plant</text>
    <text x="655" y="226">gain, &lt; 20% on footprints</text>
  </g>
  <text x="380" y="258" fill="#15384a" font-size="12.5" text-anchor="middle">blue: registered footprint · green: gain polygon · red: loss polygon</text>
</svg>
<figcaption>The same change polygon means different things depending on how much of a footprint it covers and how far the surface moved.</figcaption>
</figure>

### 4. Map affected buildings to shards

```python
import mercantile
from pyproj import Transformer

SHARD_ZOOM = 16
to_wgs84 = Transformer.from_crs("EPSG:32618", "EPSG:4326", always_xy=True)

def shards_for(geom, buffer_m=5.0):
    minx, miny, maxx, maxy = geom.buffer(buffer_m).bounds
    lons, lats = to_wgs84.transform([minx, maxx, maxx, minx], [miny, miny, maxy, maxy])
    return {mercantile.quadkey(t) for t in
            mercantile.tiles(min(lons), min(lats), max(lons), max(lats), SHARD_ZOOM)}

dirty = defaultdict(set)
for i, s in status.items():
    for qk in shards_for(bldg_geoms[i]):
        dirty[qk].add(f"{s}:{bldg_props[i]['building_id']}")
for n, g in enumerate(new_buildings):
    for qk in shards_for(g):
        dirty[qk].add(f"new:candidate-{n:04d}")

print(f"{len(dirty)} dirty shards at z{SHARD_ZOOM}")
```

All four corners of the buffered bounding box are transformed, not just two. A UTM rectangle is not a rectangle in longitude and latitude — its edges converge slightly — so transforming only the lower-left and upper-right corners can miss a sliver of a neighbouring shard at the top-left. The five-metre buffer does the same job for geometry: a building whose wall sits exactly on a shard boundary has its eaves, and its tile content, in the neighbour.

<figure class="diagram">
<svg viewBox="66 6 628 278" role="img" aria-labelledby="fcb-shard-t fcb-shard-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fcb-shard-t">A building on a shard boundary dirties both shards</title>
  <desc id="fcb-shard-d">A three by two grid of shards. An altered building lies close to the boundary between two shards. Its footprint touches only the left one, but the five metre buffer crosses the boundary, so both shards are marked dirty. A demolished building in the middle of another shard dirties only that shard.</desc>
  <rect class="svg-bg" x="66" y="6" width="628" height="278" fill="#ffffff"/>
  <rect x="80" y="20" width="200" height="110" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="280" y="20" width="200" height="110" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="480" y="20" width="200" height="110" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="80" y="130" width="200" height="110" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="280" y="130" width="200" height="110" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="480" y="130" width="200" height="110" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M206 50 h66 v50 h-66 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M198 42 h82 v66 h-82 Z" fill="none" stroke="#1f6b8a" stroke-width="1.2" stroke-dasharray="4 3"/>
  <path d="M282 42 h8 v66 h-8" fill="none" stroke="#1f6b8a" stroke-width="1.2" stroke-dasharray="4 3"/>
  <path d="M550 160 h60 v50 h-60 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="80">dirty</text>
    <text x="400" y="80">dirty: buffer</text>
    <text x="580" y="80">clean</text>
    <text x="180" y="190">clean</text>
    <text x="380" y="190">clean</text>
    <text x="580" y="230">dirty</text>
  </g>
  <text x="239" y="124" fill="#1f6b8a" font-size="11.5" text-anchor="middle">altered</text>
  <text x="580" y="152" fill="#b0413e" font-size="11.5" text-anchor="middle">demolished</text>
  <text x="380" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">Buffering by the eave overhang catches content that crosses the shard edge.</text>
</svg>
<figcaption>Shard membership is decided by the tile content, which extends past the footprint; the buffer makes the dirty set match what the tiler actually writes.</figcaption>
</figure>

### 5. Write the work list

```python
worklist = {
    "comparison": {"t0": "2025-06", "t1": "2026-06", "crs": "EPSG:32618+5703"},
    "shard_zoom": SHARD_ZOOM,
    "thresholds": {"demolish_loss_frac": 0.6, "alter_frac": 0.1, "new_min_area_m2": 30},
    "shards": {qk: sorted(reasons) for qk, reasons in sorted(dirty.items())},
    "new_building_candidates": [json.loads(json.dumps(g.__geo_interface__)) for g in new_buildings],
}
with open("retile_worklist_2026-06.json", "w") as f:
    json.dump(worklist, f, indent=2)
```

The thresholds are written into the file alongside the result for the same reason a test report records its configuration. When next year's comparison flags twice as many alterations, the first question is whether the city changed or the settings did, and the work list should answer that without anyone opening the code history.

Recording the reasons against each shard — which building, which classification — is what makes the work list reviewable. A rebuild of 40 shards that someone can read is approved; one that says only "40 shards" is questioned. The new-building candidates go to the register team as well as the tiler, because until they have an identifier they cannot carry attributes in the twin.

## Expected Output & Verification

```text
212 change polygons, 18,406 footprints indexed
{'demolished': 7, 'altered': 41} new: 5
63 dirty shards at z16
```

Verify against independent records rather than the change data. Demolition and building-permit registers for the comparison period should account for most `demolished` and `new` entries; a permitted demolition that is missing points at an occlusion or a too-strict threshold, and an unpermitted one is worth a human look before it is published. Then check the multiplier: dirty shards per changed building should sit between 1 and about 1.5 at zoom 16. A much higher ratio means the buffer is too large or a huge change polygon — typically a regraded site — is being attributed to every footprint it touches.

```python
changed = len(status) + len(new_buildings)
ratio = len(dirty) / max(changed, 1)
print(f"{ratio:.2f} shards per changed building")
assert ratio < 2.0, "dirty set is inflated: check buffer size and oversized change polygons"
```

<figure class="diagram">
<svg viewBox="-4 6 768 198" role="img" aria-labelledby="fcb-flow-t fcb-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fcb-flow-t">From change polygons to a retiling work list</title>
  <desc id="fcb-flow-d">Change polygons and building footprints are joined with a spatial index, buildings are classified as demolished, altered or new, their buffered extents are transformed from UTM to longitude and latitude and mapped to zoom 16 quadkeys, and the resulting work list feeds both the incremental tiler and the building register.</desc>
  <rect class="svg-bg" x="-4" y="6" width="768" height="198" fill="#ffffff"/>
  <defs>
    <marker id="fcb-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="20" width="120" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="10" y="100" width="120" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="170" y="60" width="120" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="330" y="60" width="120" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="490" y="60" width="120" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="650" y="20" width="100" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="650" y="100" width="100" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#fcb-flow-arrow)">
    <path d="M130 45 L168 76"/>
    <path d="M130 125 L168 94"/>
    <path d="M290 85 H328"/>
    <path d="M450 85 H488"/>
    <path d="M610 76 L648 50"/>
    <path d="M610 94 L648 120"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="70" y="42">change</text><text x="70" y="59">polygons</text>
    <text x="70" y="122">footprints</text><text x="70" y="139">EPSG:32618</text>
    <text x="230" y="82">STRtree</text><text x="230" y="99">overlap</text>
    <text x="390" y="82">classify</text><text x="390" y="99">buildings</text>
    <text x="550" y="82">UTM → 4326</text><text x="550" y="99">quadkeys z16</text>
    <text x="700" y="42">incremental</text><text x="700" y="59">tiler</text>
    <text x="700" y="122">building</text><text x="700" y="139">register</text>
  </g>
  <text x="380" y="186" fill="#15384a" font-size="12.5" text-anchor="middle">Areas are measured in metres; only shard addressing crosses into longitude and latitude.</text>
</svg>
<figcaption>Keeping every area computation in the projected CRS and transforming only for addressing avoids the most common silent error in this join.</figcaption>
</figure>

## Common Errors

**Every overlap fraction is zero or near zero.** One of the two files is in EPSG:4326. Check `bldg_geoms[0].bounds`: values under 180 are degrees. Reproject before indexing.

**`GEOSException: TopologyException: Input geom 1 is invalid`.** A footprint has a self-intersection, common in digitised registers. Run `shapely.make_valid` on both layers before building the tree, and log how many were repaired.

**Hundreds of shards dirty after a routine resurvey.** A regraded construction site produced one enormous change polygon that intersects many footprints at small fractions. Cap change polygon area before the join, or split large polygons on the shard grid first so each piece is classified on its own.

## Frequently Asked Questions

### Why not retile every shard any change polygon touches?

Because most change is not building change: earthworks, vegetation that survived filtering, vehicles, stockpiles. Filtering through footprints keeps the rebuild proportional to what the building tiles actually contain. Terrain tiles are a separate layer with their own, simpler rule — any significant ground change dirties the shard.

### What zoom should the shards be?

Whatever the tiler uses; the join must not invent its own. Zoom 15 to 17 is typical for building content, trading rebuild granularity against shard count.

### How do I handle a building that is both altered and partly demolished?

Treat it as altered and rebuild it from the new epoch. The classification decides priority and reporting, not what the tiler does — any listed building is regenerated from current data.

## Related Guides

- [M3C2 Change Detection with py4dgeo](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/m3c2-change-detection-with-py4dgeo/) — producing the change polygons
- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — consuming the work list
- [Computing Quadkeys and Tile Bounds in Python](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/spatial-indexing-and-tiling-schemes/computing-quadkeys-and-tile-bounds-in-python/) — the addressing scheme used for shards

Back to [Change Detection Between LiDAR Scan Epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/).
