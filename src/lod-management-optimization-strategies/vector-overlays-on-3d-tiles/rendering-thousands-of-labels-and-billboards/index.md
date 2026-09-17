---
title: "Rendering Thousands of Labels and Billboards"
description: "Show asset labels over 3D Tiles without wrecking frame time: billboard and label collections, height references, distance conditions"
---
# Rendering Thousands of Labels and Billboards

This page puts asset markers and text over a tiled 3D scene at a scale that stays interactive — using billboard and label collections instead of entities, clamping markers to terrain or tile content, hiding them by distance, clustering them when they crowd, and keeping only the nearest few hundred labels alive as the camera moves.

## Why you hit this

Every twin ends up needing markers: inspection points, sensors, addresses, defect locations, asset tags. The straightforward implementation — one entity with a `label` and a `billboard` per feature — is comfortable up to a few hundred and unusable at ten thousand, because each label is a textured quad whose glyphs are packed into an atlas and whose position is recomputed every frame. The scene does not crash; it drops to single-digit frame rates and the labels become an unreadable stack of overlapping text. Both problems have standard answers in CesiumJS, and neither is the default. The overlay strategies around this are in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).

## Prerequisites

- CesiumJS 1.110+ over a tileset and, for clamped markers, terrain.
- Point data with a stable identifier, a label string and a category, in EPSG:4326 with heights or with a height reference.
- Python 3.10+ with `geopandas>=0.14` for preparing the points.

## Step-by-Step

### 1. Prepare points with the fields the renderer needs

```python
import geopandas as gpd

pts = gpd.read_file("assets.gpkg", layer="inspection_points").to_crs(4326)
pts["label"] = pts["asset_tag"].astype(str)
pts["category"] = pts["asset_type"].fillna("other")
pts["priority"] = pts["risk_score"].fillna(0).astype(int)      # drives what stays visible when crowded

keep = ["asset_id", "label", "category", "priority", "geometry"]
pts[keep].to_file("web/assets_4326.geojson", driver="GeoJSON")
print(f"{len(pts)} points, {pts['category'].nunique()} categories")
```

A `priority` field is what makes the later steps possible. Once a scene has more markers than it can show, something has to decide which ones survive, and doing that by risk, status or size is far more useful than by arbitrary order.

### 2. Use collections, not entities

```javascript
const billboards = viewer.scene.primitives.add(new Cesium.BillboardCollection({
  scene: viewer.scene,                       // enables depth testing against terrain and tiles
}));
const labels = viewer.scene.primitives.add(new Cesium.LabelCollection({ scene: viewer.scene }));

const ICONS = {
  valve: "/icons/valve.png",
  hydrant: "/icons/hydrant.png",
  other: "/icons/generic.png",
};

const fc = await (await fetch("/web/assets_4326.geojson")).json();
const records = fc.features.map((f) => {
  const [lon, lat] = f.geometry.coordinates;
  const position = Cesium.Cartesian3.fromDegrees(lon, lat);
  const p = f.properties;

  const billboard = billboards.add({
    position,
    image: ICONS[p.category] ?? ICONS.other,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    scale: 0.6,
    scaleByDistance: new Cesium.NearFarScalar(200, 1.0, 3000, 0.4),
    translucencyByDistance: new Cesium.NearFarScalar(2000, 1.0, 6000, 0.0),
    id: p.asset_id,
  });

  const label = labels.add({
    position,
    text: p.label,
    font: "13px sans-serif",
    fillColor: Cesium.Color.fromCssColorString("#1f2937"),
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    pixelOffset: new Cesium.Cartesian2(0, -28),
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 900.0),
    id: p.asset_id,
  });

  return { ...p, position, billboard, label };
});
console.log(`${records.length} markers in 2 collections`);
```

A collection batches its members into one draw call and one texture atlas, which is the difference between a scene that holds ten thousand markers and one that holds five hundred. Passing `scene` to the constructor is what lets `heightReference` work, because clamping needs access to the terrain and tile surfaces.

The two distance controls do different jobs. `scaleByDistance` keeps a marker readable near the camera and small far away; `distanceDisplayCondition` removes it entirely beyond a range, which is the only one that saves work. Text is the expensive part, so labels get a much shorter visibility range than their icons — 900 m against 6 km here.

<figure class="diagram">
<svg viewBox="34 6 689 240" role="img" aria-labelledby="lbl-cost-t lbl-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lbl-cost-t">Frame cost of three marker implementations</title>
  <desc id="lbl-cost-d">Curves of frames per second against marker count. One entity per feature with a label and a billboard falls below thirty frames per second by two thousand markers. Billboard and label collections stay near sixty until about ten thousand. Collections with clustering and distance conditions stay near sixty to fifty thousand because only a few hundred are drawn at any time.</desc>
  <rect class="svg-bg" x="34" y="6" width="689" height="240" fill="#ffffff"/>
  <path d="M70 20 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="90,40 200,44 330,50 460,58 590,66 690,74" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="90,42 200,48 330,62 460,92 590,132 690,158" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="90,46 200,84 330,132 460,158 590,170 690,175" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="90" y="200">200</text><text x="200" y="200">1,000</text><text x="330" y="200">2,000</text>
    <text x="460" y="200">10,000</text><text x="590" y="200">25,000</text><text x="690" y="200">50,000</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="62" y="44">60</text><text x="62" y="112">30</text><text x="62" y="180">0</text>
  </g>
  <text x="430" y="36" fill="#4f7a4d" font-size="12.5" text-anchor="start">collections + clustering + distance</text>
  <text x="250" y="70" fill="#1f6b8a" font-size="12.5" text-anchor="start">collections only</text>
  <text x="210" y="120" fill="#b0413e" font-size="12.5" text-anchor="start">one entity per feature</text>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">markers in the dataset — not all of them drawn</text>
</svg>
<figcaption>Collections fix the draw-call cost; only culling and clustering fix the cost of actually drawing thousands of glyphs.</figcaption>
</figure>

### 3. Clamp markers to the right surface

```javascript
for (const r of records) {
  r.billboard.heightReference = r.category === "roof_sensor"
    ? Cesium.HeightReference.RELATIVE_TO_3D_TILE
    : Cesium.HeightReference.CLAMP_TO_GROUND;
  if (r.category === "roof_sensor") r.billboard.position = Cesium.Cartesian3.fromDegrees(
    r.lon, r.lat, 1.5);                      // 1.5 m above whatever tile surface is beneath
}
```

Height references decide what a marker sits on, and the choice is per category rather than per layer. A hydrant belongs on the ground; a roof sensor belongs on the building, which means clamping to tile content rather than terrain. The tile-relative references are recent additions to CesiumJS, so check the version you ship against the reference names you use — an unsupported value is ignored and the marker falls to the ellipsoid, which looks like a data error.

For markers that must stay visible through geometry — a defect on the far side of a building that a user is navigating to — `disableDepthTestDistance: Number.POSITIVE_INFINITY` draws them on top of everything. Use it sparingly: a scene where every marker ignores depth loses all sense of which markers are near.

### 4. Cluster when markers crowd

```javascript
const ds = await Cesium.GeoJsonDataSource.load("/web/assets_4326.geojson", { clampToGround: true });
viewer.dataSources.add(ds);

ds.clustering.enabled = true;
ds.clustering.pixelRange = 40;
ds.clustering.minimumClusterSize = 4;

const pinBuilder = new Cesium.PinBuilder();
ds.clustering.clusterEvent.addEventListener((clustered, cluster) => {
  cluster.label.show = true;
  cluster.label.text = String(clustered.length);
  cluster.label.font = "bold 14px sans-serif";
  cluster.label.fillColor = Cesium.Color.WHITE;
  cluster.billboard.show = true;
  cluster.billboard.image = pinBuilder
    .fromColor(Cesium.Color.fromCssColorString("#1f6b8a"), 44)
    .toDataURL();
  cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.BOTTOM;
});
```

Clustering works in screen space: markers within `pixelRange` pixels of each other collapse into one pin carrying a count. That is the behaviour users expect from a map, and it solves the readability problem as well as the performance one. The data-source route is the one with clustering support built in, so a scene with both — collections for a large static layer, a clustered data source for the interactive one — is a normal arrangement rather than a contradiction.

<figure class="diagram">
<svg viewBox="6 6 748 228" role="img" aria-labelledby="lbl-clust-t lbl-clust-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lbl-clust-t">Clustering by screen-space pixel range</title>
  <desc id="lbl-clust-d">On the left, fourteen markers within forty pixels of each other overlap into unreadable text. On the right, the same markers collapse into three pins labelled with their counts, plus two markers that stand alone because no neighbour is within the pixel range.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="228" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="200" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="200" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f6b8a">
    <circle cx="120" cy="100" r="5"/><circle cx="132" cy="112" r="5"/><circle cx="118" cy="124" r="5"/><circle cx="140" cy="96" r="5"/>
    <circle cx="200" cy="150" r="5"/><circle cx="214" cy="160" r="5"/><circle cx="196" cy="168" r="5"/>
    <circle cx="280" cy="80" r="5"/><circle cx="292" cy="92" r="5"/><circle cx="276" cy="100" r="5"/><circle cx="300" cy="76" r="5"/>
    <circle cx="80" cy="190" r="5"/><circle cx="320" cy="190" r="5"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none">
    <path d="M100 80 h60 v60 h-60 Z" stroke-dasharray="4 3"/>
    <path d="M180 132 h54 v54 h-54 Z" stroke-dasharray="4 3"/>
    <path d="M260 60 h60 v58 h-60 Z" stroke-dasharray="4 3"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="500" cy="110" r="18"/><circle cx="580" cy="160" r="15"/><circle cx="660" cy="88" r="18"/>
    <circle cx="460" cy="190" r="5"/><circle cx="700" cy="190" r="5"/>
  </g>
  <g fill="#ffffff" font-size="13" text-anchor="middle">
    <text x="500" y="115">4</text><text x="580" y="165">3</text><text x="660" y="93">4</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="46">unclustered: overlapping text</text>
    <text x="570" y="46">clustered at pixelRange 40</text>
    <text x="190" y="212">dashed: 40 px neighbourhoods</text>
    <text x="570" y="212">isolated markers stay themselves</text>
  </g>
</svg>
<figcaption>Clustering is a screen-space decision, so it adapts as the camera moves and needs no thresholds in the data.</figcaption>
</figure>

### 5. Keep only the nearest markers alive

```javascript
const MAX_LABELS = 400;
let lastUpdate = 0;

viewer.scene.postRender.addEventListener(() => {
  const now = performance.now();
  if (now - lastUpdate < 250) return;                  // throttle: 4 Hz is plenty
  lastUpdate = now;

  const camera = viewer.scene.camera.positionWC;
  for (const r of records) {
    r.dist = Cesium.Cartesian3.distance(camera, r.position);
  }
  const visible = records
    .filter((r) => r.dist < 1500)
    .sort((a, b) => (b.priority - a.priority) || (a.dist - b.dist))
    .slice(0, MAX_LABELS);
  const keep = new Set(visible.map((r) => r.asset_id));

  for (const r of records) {
    const on = keep.has(r.asset_id);
    if (r.label.show !== on) r.label.show = on;
  }
});
```

This is the control that makes an arbitrarily large dataset behave. Labels are budgeted — at most four hundred on screen — and the budget is spent on the highest-priority markers first, then the nearest. Throttling to four updates a second is imperceptible and keeps the sort off the frame path. Toggling `show` only when it changes matters: assigning it every tick dirties the collection and forces a rebuild of the label batch.

## Expected Output & Verification

```text
18,204 points, 7 categories
18,204 markers in 2 collections
```

Verify three things: the frame rate with the layer on and off, the number of labels actually drawn, and that picking returns the identifier.

```javascript
let shown = 0;
for (const r of records) if (r.label.show) shown++;
console.log(`labels shown: ${shown} of ${records.length}`);

const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction((m) => {
  const picked = viewer.scene.pick(m.position);
  console.log("picked asset:", picked && picked.id);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

The count of shown labels should track the budget, not the dataset — if it equals the dataset size, the culling loop is not running or `show` was overridden by a data source that owns the same entities. Picking a marker must return the asset identifier that was set on both the billboard and the label, so a click on either the icon or the text resolves to the same asset.

<figure class="diagram">
<svg viewBox="6 6 748 228" role="img" aria-labelledby="lbl-href-t lbl-href-d" xmlns="http://www.w3.org/2000/svg">
  <title id="lbl-href-t">Height references and where a marker ends up</title>
  <desc id="lbl-href-d">A table of height references. NONE places the marker at its own height above the ellipsoid. CLAMP_TO_GROUND puts it on the terrain. RELATIVE_TO_GROUND puts it at its height above the terrain. The tile-relative references place it on or above 3D Tiles content, which is what a roof-mounted sensor needs.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="228" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="260" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="280" y="20" width="230" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="510" y="20" width="230" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="260" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="280" y="58" width="230" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="510" y="58" width="230" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="100" width="260" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="280" y="100" width="230" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="100" width="230" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="142" width="260" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="280" y="142" width="230" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="510" y="142" width="230" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="150" y="44">height reference</text>
    <text x="395" y="44">sits on terrain</text>
    <text x="625" y="44">sits on tile content</text>
    <text x="150" y="85">NONE (own height)</text><text x="395" y="85">no</text><text x="625" y="85">no</text>
    <text x="150" y="127">CLAMP_TO_GROUND</text><text x="395" y="127">yes</text><text x="625" y="127">no</text>
    <text x="150" y="169">tile-relative references</text><text x="395" y="169">no</text><text x="625" y="169">yes</text>
  </g>
  <text x="380" y="216" fill="#15384a" font-size="12.5" text-anchor="middle">A marker on a roof needs a tile-relative reference; terrain clamping puts it in the street.</text>
</svg>
<figcaption>The reference is per marker, and an unsupported value in an older CesiumJS silently falls back, which looks like bad coordinates.</figcaption>
</figure>

## Performance Notes

- **One collection per icon set.** A collection packs its images into a texture atlas; mixing forty distinct icons in one collection is fine, but 4,000 unique images will thrash the atlas.
- **Keep icons small and square** — 32 to 64 px — and pre-scale them rather than relying on `scale` to shrink a 512 px source, which wastes atlas space.
- **Text is dearer than icons.** Budget labels aggressively and let icons run further; users can see where things are long before they need to read tags.
- **Throttle camera-driven work.** A `postRender` handler that sorts 18,000 records every frame costs more than the labels it is trying to save.
- **Use `requestRenderMode`** for scenes that are mostly static: with explicit render requests, a scene with thousands of markers costs nothing while nobody is moving the camera.

## Common Errors

**Markers sit at sea level under the terrain.** `heightReference` needs the `scene` reference, which the collection constructor only gets if you pass it. Without it, clamping is ignored.

**Labels flicker on and off as the camera moves.** The culling threshold has no hysteresis, so markers at the boundary toggle every update. Cull at 1,500 m and restore at 1,400 m, or keep the last visible set and only change it when the difference is material.

**Every label is drawn on top of the buildings.** `disableDepthTestDistance` was set globally. Reserve it for a selected marker.

**Clustering does nothing.** Clustering is a property of a data source's entity cluster, not of a primitive collection. A layer built with `BillboardCollection` has to implement its own grouping or be loaded as a data source instead.

## Frequently Asked Questions

### Should I use a data source or collections?

Collections for large, mostly static layers where you control visibility yourself; a data source when you want clustering, entity semantics and time dynamics for free. Mixing both in one scene is normal.

### How do I avoid overlapping text without clustering?

Cesium's `LabelCollection` has no general declutter, so the practical options are the distance and priority budget from step 5, shortening the text, or showing text only for a selection. A screen-space collision test in JavaScript is possible but expensive at scale.

### Can labels carry the tileset's own metadata?

Yes — read the feature properties from the tileset and create labels for the features in view, which keeps the label set to what is loaded. That works well for building identifiers and badly for a dataset that is not in the tiles.

## Related Guides

- [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/) — the other four overlay strategies
- [Streaming Live Sensor Updates onto Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/) — when the markers' values change continuously
- [Tuning Tileset Cache Bytes for Memory-Constrained Clients](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/tuning-tileset-cache-bytes-for-memory-constrained-clients/) — the budget markers share with tiles

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
