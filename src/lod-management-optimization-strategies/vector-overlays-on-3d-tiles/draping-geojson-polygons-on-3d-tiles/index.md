---
title: "Draping GeoJSON Polygons on 3D Tiles"
description: "Drape parcel and zone polygons over terrain and tiles in CesiumJS: prepare valid GeoJSON, batch ground primitives"
---
# Draping GeoJSON Polygons on 3D Tiles

This page drapes polygon layers — parcels, zones, flood extents, work areas — over terrain and 3D Tiles content in CesiumJS without losing frame rate or feature identity: preparing valid, simplified GeoJSON in EPSG:4326 from a projected source, batching hundreds of polygons into a single ground primitive with per-feature colours, keeping a stable identifier for picking, and measuring what the layer costs per frame.

## Why you hit this

Draping is the first overlay anybody tries and the first thing that wrecks a demo. `GeoJsonDataSource.load` with `clampToGround: true` works beautifully for fifty parcels and turns a smooth scene into six frames per second at five thousand, because each entity becomes its own primitive with its own shadow-volume geometry and its own draw call. The fix is not a different library; it is batching the same geometry into one primitive, which Cesium supports directly but not through the convenience loader. The strategy choice around this is in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).

## Prerequisites

- CesiumJS 1.110+ in a scene with terrain, and a browser with depth-texture support — `scene.groundPrimitiveSupported` must be true, or draping silently falls back to nothing.
- Python 3.10+ with `geopandas>=0.14`, `shapely>=2.0`, `pyproj>=3.6`.
- A polygon layer with a stable identifier column and a declared CRS; the example is a parcel layer in EPSG:25832.

## Step-by-Step

### 1. Prepare the GeoJSON: valid, simplified, projected

```python
import geopandas as gpd
from shapely import make_valid

gdf = gpd.read_file("parcels.gpkg", layer="parcels")
print(f"{len(gdf)} features, CRS {gdf.crs.to_epsg()}")

invalid = ~gdf.geometry.is_valid
gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(make_valid)
print(f"repaired {int(invalid.sum())} invalid geometries")

gdf = gdf[gdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
gdf["geometry"] = gdf.geometry.simplify(0.25, preserve_topology=True)   # 25 cm in EPSG:25832
gdf = gdf[gdf.geometry.area > 1.0]

out = gdf.to_crs(4326)[["parcel_id", "zoning", "geometry"]]
out.to_file("web/parcels_4326.geojson", driver="GeoJSON")
print(f"{len(out)} features written, {sum(len(g.exterior.coords) for g in out.geometry.explode()):,} exterior vertices")
```

Simplify in the projected CRS, where the tolerance is metres, and reproject afterwards; simplifying in degrees means a tolerance that changes with latitude. A 25 cm tolerance is invisible at any zoom a parcel layer is read at and typically removes half the vertices of a cadastral dataset, because survey polygons carry vertices at every kink of a boundary wall.

Validity matters more for draped polygons than for ordinary geometry. A self-intersecting ring produces a shadow volume that is inside-out in part of its extent, and the visible result is a polygon with a hole in it that moves as the camera moves.

### 2. Batch into one ground primitive

```javascript
async function drapeLayer(url, scene, colorFor) {
  const geojson = await (await fetch(url)).json();
  const instances = [];

  for (const feature of geojson.features) {
    const polys = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    for (const rings of polys) {
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(rings[0].flat()),
        rings.slice(1).map((r) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(r.flat())))
      );
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({ polygonHierarchy: hierarchy, vertexFormat: Cesium.VertexFormat.POSITION_ONLY }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFor(feature.properties)),
          show: new Cesium.ShowGeometryInstanceAttribute(true),
        },
        id: feature.properties.parcel_id,
      }));
    }
  }

  const primitive = new Cesium.GroundPrimitive({
    geometryInstances: instances,
    classificationType: Cesium.ClassificationType.BOTH,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
    asynchronous: true,
  });
  scene.primitives.add(primitive);
  await primitive.readyPromise;
  return primitive;
}

const zoningColors = {
  residential: Cesium.Color.fromCssColorString("#1f6b8a").withAlpha(0.35),
  commercial: Cesium.Color.fromCssColorString("#c46a3d").withAlpha(0.35),
  green: Cesium.Color.fromCssColorString("#4f7a4d").withAlpha(0.35),
};
const parcels = await drapeLayer("/web/parcels_4326.geojson", viewer.scene,
  (p) => zoningColors[p.zoning] ?? Cesium.Color.GRAY.withAlpha(0.3));
```

One `GroundPrimitive` with five thousand instances is one draw call. The `id` on each instance is what picking returns, so the identifier travels with the geometry rather than in a side table. `asynchronous: true` builds the geometry in a web worker, which keeps the main thread responsive while a large layer loads; the `readyPromise` is how you know it is safe to query or style.

<figure class="diagram">
<svg viewBox="6 6 748 228" role="img" aria-labelledby="drape-batch-t drape-batch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drape-batch-t">Entities against one batched primitive</title>
  <desc id="drape-batch-d">On the left, a data source creates one entity and one primitive per parcel, so five thousand parcels mean five thousand draw calls and five thousand shadow volumes. On the right, the same polygons become geometry instances inside a single ground primitive with per-instance colours, which the renderer draws in one call while still picking individual features by identifier.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="228" fill="#ffffff"/>
  <rect x="20" y="20" width="340" height="200" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="20" width="340" height="200" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.2">
    <rect x="50" y="70" width="60" height="40"/><rect x="120" y="70" width="60" height="40"/><rect x="190" y="70" width="60" height="40"/><rect x="260" y="70" width="60" height="40"/>
    <rect x="50" y="120" width="60" height="40"/><rect x="120" y="120" width="60" height="40"/><rect x="190" y="120" width="60" height="40"/><rect x="260" y="120" width="60" height="40"/>
  </g>
  <rect x="430" y="70" width="280" height="90" rx="6" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1">
    <rect x="445" y="85" width="50" height="28"/><rect x="505" y="85" width="50" height="28"/><rect x="565" y="85" width="50" height="28"/><rect x="625" y="85" width="50" height="28"/>
    <rect x="445" y="120" width="50" height="28"/><rect x="505" y="120" width="50" height="28"/><rect x="565" y="120" width="50" height="28"/><rect x="625" y="120" width="50" height="28"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="190" y="48">GeoJsonDataSource, clampToGround</text>
    <text x="570" y="48">one GroundPrimitive, many instances</text>
    <text x="190" y="190">5,000 primitives · 5,000 draw calls</text>
    <text x="570" y="190">1 primitive · 1 draw call</text>
    <text x="190" y="210">picking by entity</text>
    <text x="570" y="210">picking by instance id</text>
  </g>
</svg>
<figcaption>Batching changes the cost by three orders of magnitude and keeps per-feature colour and picking, which is why the convenience loader is only for small layers.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="26 22 688 238" role="img" aria-labelledby="drape-shadow-t drape-shadow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drape-shadow-t">How a draped polygon finds the surface</title>
  <desc id="drape-shadow-d">A cross-section of terrain with a building on it. The draped polygon is not geometry on the surface; it is a volume extruded through the height range of the terrain beneath it. Wherever that volume intersects a rendered surface, the fragment is coloured, so the polygon follows every hill and every level of detail exactly.</desc>
  <rect class="svg-bg" x="26" y="22" width="688" height="238" fill="#ffffff"/>
  <path d="M40 190 C160 190 220 140 340 140 C460 140 520 178 700 172" fill="none" stroke="#4f7a4d" stroke-width="3"/>
  <rect x="420" y="96" width="100" height="70" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M120 60 h420 v170 h-420 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2" stroke-dasharray="7 4" fill-opacity="0.35"/>
  <path d="M120 190 C160 190 220 140 340 140 C420 140 430 150 440 152" fill="none" stroke="#9a4f26" stroke-width="5"/>
  <path d="M420 96 H520" fill="none" stroke="#9a4f26" stroke-width="5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="330" y="50">shadow volume: extruded through the height range</text>
    <text x="220" y="222">coloured where it meets the terrain</text>
    <text x="600" y="110">coloured on the roof when</text>
    <text x="600" y="128">classificationType allows tiles</text>
  </g>
  <text x="380" y="242" fill="#15384a" font-size="12.5" text-anchor="middle">Nothing is sampled at load time, so refinement never detaches the polygon from the surface.</text>
</svg>
<figcaption>Draping is a per-pixel test against the depth buffer, which is why it needs no terrain sampling and never develops gaps.</figcaption>
</figure>

### 3. Pick and style individual features

```javascript
const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);
  if (!Cesium.defined(picked) || !Cesium.defined(picked.id)) return;
  const parcelId = picked.id;
  const attrs = parcels.getGeometryInstanceAttributes(parcelId);
  attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(
    Cesium.Color.fromCssColorString("#b0413e").withAlpha(0.6)
  );
  document.querySelector("#readout").textContent = `parcel ${parcelId}`;
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

`getGeometryInstanceAttributes` returns a live view of the instance's attributes, so assigning a colour repaints that one feature without rebuilding anything. The same mechanism drives filtering: setting `attrs.show = Cesium.ShowGeometryInstanceAttribute.toValue(false)` hides a feature at no geometry cost, which is how a zoning filter should be implemented rather than by reloading the layer.

### 4. Decide what the layer is allowed to paint

```javascript
parcels.classificationType = Cesium.ClassificationType.TERRAIN;        // ground only
// or CESIUM_3D_TILE to paint only building tiles, or BOTH
```

For parcels, `TERRAIN` is usually right: a parcel boundary painted up the side of a building is confusing, since the parcel is a ground-plane concept. For a work area or a flood extent, `BOTH` is right, because the water or the exclusion zone genuinely covers whatever is inside it. The choice is per layer and worth writing down next to the layer definition.

### 5. Measure the cost

```javascript
async function measure(scene, seconds = 5) {
  const t0 = performance.now();
  let frames = 0;
  await new Promise((resolve) => {
    const tick = () => {
      frames++;
      if (performance.now() - t0 > seconds * 1000) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return frames / seconds;
}

const withLayer = await measure(viewer.scene);
parcels.show = false;
const withoutLayer = await measure(viewer.scene);
parcels.show = true;
console.log(`FPS ${withLayer.toFixed(1)} with layer, ${withoutLayer.toFixed(1)} without`);
```

Toggling `show` on the primitive rather than removing it separates draw cost from build cost, which is the distinction that matters when deciding whether a layer needs a different strategy. A drop of a frame or two is fine; a drop from 60 to 20 means the layer is too large for draping and belongs in imagery or its own tileset.

<figure class="diagram">
<svg viewBox="34 6 689 240" role="img" aria-labelledby="drape-fps-t drape-fps-d" xmlns="http://www.w3.org/2000/svg">
  <title id="drape-fps-t">Frame rate against parcel count for three approaches</title>
  <desc id="drape-fps-d">Curves of frames per second against the number of draped parcels. Individual entities fall from 60 frames per second at a hundred parcels to under 10 at five thousand. A single batched ground primitive stays near 60 up to about twenty thousand and then declines gently. Server-rendered imagery stays flat at 60 regardless of feature count.</desc>
  <rect class="svg-bg" x="34" y="6" width="689" height="240" fill="#ffffff"/>
  <path d="M70 20 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M90 40 H690" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <polyline points="90,42 200,46 330,52 460,64 590,84 690,104" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="90,48 200,92 330,130 460,154 590,166 690,172" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="90" y="200">100</text><text x="200" y="200">500</text><text x="330" y="200">2,000</text>
    <text x="460" y="200">5,000</text><text x="590" y="200">20,000</text><text x="690" y="200">50,000</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="end">
    <text x="62" y="44">60</text><text x="62" y="112">30</text><text x="62" y="180">0</text>
  </g>
  <text x="300" y="34" fill="#1f2937" font-size="12.5" text-anchor="middle">imagery</text>
  <text x="520" y="58" fill="#1f6b8a" font-size="12.5" text-anchor="start">one batched primitive</text>
  <text x="250" y="126" fill="#b0413e" font-size="12.5" text-anchor="start">one entity per parcel</text>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">parcels draped, mid-range laptop GPU</text>
</svg>
<figcaption>Batching moves the useful limit from a few hundred features to tens of thousands; past that, only a raster representation holds the frame rate.</figcaption>
</figure>

## Expected Output & Verification

```text
5194 features, CRS 25832
repaired 37 invalid geometries
5188 features written, 214,006 exterior vertices
FPS 58.4 with layer, 59.1 without
```

Verify position, not just appearance. Pick a known parcel corner, read back the picked position, and compare it with the source coordinate transformed independently:

```javascript
const corner = Cesium.Cartesian3.fromDegrees(11.5730216, 48.1381190);
const window2d = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, corner);
const picked = viewer.scene.pick(window2d);
console.log("picked id at the known corner:", picked && picked.id);
```

The identifier returned at a surveyed corner must be the parcel that corner belongs to. This catches the two errors appearance cannot: a layer reprojected with swapped axes, which drapes plausibly in the wrong place, and an identifier column that was lost in the export so every instance picks as `undefined`.

Also confirm the layer really is one primitive:

```javascript
console.log("primitives in scene:", viewer.scene.primitives.length);
```

## Performance Notes

- **Vertices, not features, drive the build cost.** A thousand parcels with 200 vertices each cost the same as ten thousand with 20. Simplify before shipping.
- **Shadow volumes are extruded geometry**, so a draped layer's memory is roughly proportional to its vertex count times the terrain height range it spans. Split a layer that covers a mountain range by area.
- **Rebuild nothing to restyle.** Colour and visibility are instance attributes; rebuilding a primitive to change a colour is the most common self-inflicted stall.
- **Load asynchronously and show progress.** A 200,000-vertex layer takes a second or two to build in the worker; a spinner is better than a frozen toggle.
- **Split very large layers by tile or district** and add primitives as the camera approaches, using a bounding-sphere test, rather than holding the whole city's parcels in memory.

## Common Errors

**Nothing appears and no error is logged.** `scene.groundPrimitiveSupported` is false — the browser or GPU has no depth texture support. Fall back to `perPositionHeight` polygons sampled onto the terrain, which is less accurate but works everywhere.

**Polygons appear as rings with holes that move with the camera.** Invalid or self-intersecting rings. Repair with `make_valid` before export and check `is_valid` again afterwards, since simplification can reintroduce invalidity.

**Picking returns the primitive rather than a feature.** The `id` was set on the primitive instead of on each `GeometryInstance`, or the source features had no identifier. Set it per instance, as step 2 does.

**Colours look washed out over the terrain.** `PerInstanceColorAppearance` with `flat: false` applies lighting to a draped surface, which is rarely wanted. Set `flat: true`, and remember that alpha over an already-lit terrain compounds — 0.35 usually reads as intended, 0.6 hides the ground.

## Frequently Asked Questions

### Can I drape a polygon with real heights instead?

Yes, with `perPositionHeight: true`, which uses the polygon's own z values and does not follow terrain. It is the right choice when the polygon represents something at a fixed elevation — a flood level, a deck — and the wrong choice for anything that should hug the ground.

### How do I outline a draped polygon?

Draped polygon outlines are not supported directly; use a clamped polyline for the boundary, which is covered in [clamping polylines to terrain and buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/clamping-polylines-to-terrain-and-buildings/). Batch the outlines into one polyline collection for the same reason the fills are batched.

### Does a draped layer respect the tileset's clipping planes?

No. Clipping planes apply to the tileset they are set on; a draped primitive is separate scene geometry. To clip both, apply the same planes to the primitive's own clipping configuration, or hide the layer when a clipping mode is active.

## Related Guides

- [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/) — choosing between the five strategies
- [Classifying 3D Tiles with Polygon Volumes](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/classifying-3d-tiles-with-polygon-volumes/) — when the overlay must reach up the facades
- [Serving Vector Tiles as Imagery over Terrain](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/serving-vector-tiles-as-imagery-over-terrain/) — the option for very large layers

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
