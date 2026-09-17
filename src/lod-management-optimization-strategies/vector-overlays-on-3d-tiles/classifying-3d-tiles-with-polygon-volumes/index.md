---
title: "Classifying 3D Tiles with Polygon Volumes"
description: "Paint building tiles by zone in CesiumJS: classification primitives, volume extents that cover the tallest roof, classification types"
---
# Classifying 3D Tiles with Polygon Volumes

This page colours existing 3D Tiles content by zone without touching the tiles — building extruded classification volumes from polygons, sizing them so they cover the tallest building in their footprint, choosing what each volume is allowed to paint, keeping per-feature picking, and moving to a classification tileset when the number of volumes outgrows a primitive.

## Why you hit this

The most common request after a twin's buildings are on screen is "colour them by something": zoning, ownership, energy class, survey status. Rebuilding the tileset with the attribute baked in takes hours and has to be repeated whenever the attribute changes. Classification does it at render time — the volume is a shadow-volume geometry and the buildings keep their own textures, so switching from zoning to energy class is one style change. What goes wrong is geometric: a volume that does not fully contain the buildings paints only part of them, and the result looks like a rendering bug. The choice between this and the other overlay strategies is in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).

## Prerequisites

- CesiumJS 1.110+ with a stencil buffer — `viewer.scene.context.stencilBuffer` must be true, which it is on all current desktop and mobile browsers with WebGL 2.
- A loaded 3D Tiles tileset of buildings, and polygons in EPSG:4326 with a zone attribute and a stable identifier.
- Height information for the footprints the volumes cover: a `height_m` column, the building tileset's own metadata, or a DSM to sample.

## Step-by-Step

### 1. Size the volumes from the buildings they must cover

```python
import geopandas as gpd
import numpy as np
import rasterio

zones = gpd.read_file("zoning.gpkg").to_crs(25832)
buildings = gpd.read_file("footprints.gpkg").to_crs(25832)      # with height_m and base_z

joined = gpd.sjoin(buildings[["geometry", "height_m", "base_z"]], zones[["geometry", "zone_id"]],
                   how="inner", predicate="intersects")
tops = joined.groupby("zone_id").apply(lambda g: float((g["base_z"] + g["height_m"]).max()))
bottoms = joined.groupby("zone_id").apply(lambda g: float(g["base_z"].min()))

zones = zones.merge(tops.rename("top_z"), on="zone_id").merge(bottoms.rename("bottom_z"), on="zone_id")
zones["top_z"] = zones["top_z"] + 10.0            # clearance above the tallest roof
zones["bottom_z"] = zones["bottom_z"] - 20.0      # below the lowest terrain in the zone
print(zones[["zone_id", "bottom_z", "top_z"]].describe().loc[["min", "max"]])
zones.to_crs(4326).to_file("web/zones_4326.geojson", driver="GeoJSON")
```

The extents come from the data, not from a round number. A zone containing a 60 m tower needs a volume that reaches above it, and a zone on a hillside needs a base below the lowest ground in its own footprint — otherwise the lower storeys of the downhill buildings sit outside the volume and stay unpainted. The generous margins cost nothing: a classification volume is invisible, so making it 10 m taller than necessary has no visual effect at all.

<figure class="diagram">
<svg viewBox="36 30 668 254" role="img" aria-labelledby="cls-extent-t cls-extent-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-extent-t">A classification volume that is too short</title>
  <desc id="cls-extent-d">Two zones over the same street. On the left the volume is extruded to twenty metres, so a sixty metre tower is coloured only up to twenty metres and the rest keeps its original appearance, which looks like a bug. On the right the volume reaches ten metres above the tallest roof and twenty metres below the lowest terrain, so every building in the zone is coloured in full.</desc>
  <rect class="svg-bg" x="36" y="30" width="668" height="254" fill="#ffffff"/>
  <path d="M30 220 H360" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <rect x="70" y="150" width="50" height="70" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="150" y="60" width="60" height="160" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="240" y="170" width="50" height="50" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M50 160 h270 v60 h-270 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2" fill-opacity="0.55"/>
  <text x="185" y="248" fill="#b0413e" font-size="12.5" text-anchor="middle">volume to 20 m: tower half painted</text>
  <path d="M400 220 H730" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <rect x="440" y="150" width="50" height="70" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="520" y="60" width="60" height="160" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="610" y="170" width="50" height="50" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M420 44 h270 v192 h-270 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2" fill-opacity="0.45"/>
  <text x="555" y="248" fill="#4f7a4d" font-size="12.5" text-anchor="middle">volume above the tallest roof: all painted</text>
  <text x="380" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">The volume is invisible, so there is no cost to making it generous.</text>
</svg>
<figcaption>Classification paints what is inside the volume. Sizing it from the tallest roof and the lowest ground is the whole trick.</figcaption>
</figure>

### 2. Build one batched classification primitive

```javascript
async function classifyZones(url, scene, colorFor) {
  const fc = await (await fetch(url)).json();
  const instances = [];

  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      instances.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(rings[0].flat()),
            rings.slice(1).map((r) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(r.flat())))
          ),
          height: f.properties.bottom_z,
          extrudedHeight: f.properties.top_z,
          vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFor(f.properties)),
          show: new Cesium.ShowGeometryInstanceAttribute(true),
        },
        id: f.properties.zone_id,
      }));
    }
  }

  const primitive = new Cesium.ClassificationPrimitive({
    geometryInstances: instances,
    classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
    asynchronous: true,
  });
  scene.primitives.add(primitive);
  await primitive.readyPromise;
  return primitive;
}

const zonePalette = {
  residential: Cesium.Color.fromCssColorString("#1f6b8a").withAlpha(0.45),
  mixed: Cesium.Color.fromCssColorString("#c46a3d").withAlpha(0.45),
  industrial: Cesium.Color.fromCssColorString("#5b6471").withAlpha(0.45),
  protected: Cesium.Color.fromCssColorString("#4f7a4d").withAlpha(0.45),
};
const zoneLayer = await classifyZones("/web/zones_4326.geojson", viewer.scene,
  (p) => zonePalette[p.zone] ?? Cesium.Color.GRAY.withAlpha(0.35));
```

`ClassificationPrimitive` requires every instance to carry a colour attribute — it has no appearance of its own — and batches them into one draw. The heights come from the data prepared in step 1, in metres above the ellipsoid; if the source heights are orthometric, convert them first, because a 47 m geoid separation puts the base of every volume above the ground.

### 3. Choose what each layer paints

```javascript
zoneLayer.classificationType = Cesium.ClassificationType.CESIUM_3D_TILE;   // buildings only
// TERRAIN for a ground-plane zone, BOTH for a volume that covers everything inside it
```

The three options answer three different questions. Zoning that regulates buildings should paint buildings, so the street between them keeps its own appearance and the zone boundary stays legible. A flood extent should paint `BOTH`, because water covers the ground and the lower storeys alike. A soil or noise map belongs on `TERRAIN`.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="cls-type-t cls-type-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-type-t">What each classification type paints</title>
  <desc id="cls-type-d">A table of the three classification types against terrain, building tiles and point clouds. TERRAIN paints terrain only. CESIUM_3D_TILE paints building tile surfaces only. BOTH paints terrain and tiles. None of them paint point clouds, which have no surfaces to classify.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="230" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="250" y="20" width="160" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="410" y="20" width="170" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="580" y="20" width="160" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="230" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="250" y="58" width="160" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="58" width="170" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="580" y="58" width="160" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="102" width="230" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="250" y="102" width="160" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="410" y="102" width="170" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="580" y="102" width="160" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="146" width="230" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="250" y="146" width="160" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="146" width="170" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="580" y="146" width="160" height="44" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="44">classificationType</text>
    <text x="330" y="44">terrain</text>
    <text x="495" y="44">building tiles</text>
    <text x="660" y="44">point clouds</text>
    <text x="135" y="86">TERRAIN</text><text x="330" y="86">painted</text><text x="495" y="86">untouched</text><text x="660" y="86">untouched</text>
    <text x="135" y="130">CESIUM_3D_TILE</text><text x="330" y="130">untouched</text><text x="495" y="130">painted</text><text x="660" y="130">untouched</text>
    <text x="135" y="174">BOTH</text><text x="330" y="174">painted</text><text x="495" y="174">painted</text><text x="660" y="174">untouched</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">To colour a point cloud, style the point cloud itself — classification needs surfaces.</text>
</svg>
<figcaption>The type is a property of the layer's meaning, not a setting to try until something appears.</figcaption>
</figure>

### 4. Pick, filter and restyle without rebuilding

```javascript
const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction((m) => {
  const picked = viewer.scene.pick(m.position);
  if (!Cesium.defined(picked)) return;
  // A click on a classified building can return either the zone instance or the building feature
  if (picked instanceof Cesium.Cesium3DTileFeature) {
    console.log("building", picked.getProperty("building_id"));
  } else if (Cesium.defined(picked.id)) {
    console.log("zone", picked.id);
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function showOnly(zoneIds) {
  for (const f of allZoneIds) {
    const attrs = zoneLayer.getGeometryInstanceAttributes(f);
    attrs.show = Cesium.ShowGeometryInstanceAttribute.toValue(zoneIds.has(f));
  }
}
```

Picking over classified geometry is ambiguous by nature: the pixel belongs to a building *and* to a zone. Deciding which one a click means — usually the building, with the zone shown as context — is an application decision worth making once and documenting, because users will otherwise get different behaviour depending on which pixel they hit.

### 5. Move to a classification tileset when the layer is large

A primitive holds its geometry in memory all the time. Past a few thousand volumes, the same geometry belongs in a tileset with `classificationType` set, so it streams and culls.

```javascript
const zoneTiles = await Cesium.Cesium3DTileset.fromUrl("/tiles/zone_volumes/tileset.json", {
  classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
});
viewer.scene.primitives.add(zoneTiles);
zoneTiles.style = new Cesium.Cesium3DTileStyle({
  color: {
    conditions: [
      ["${zone} === 'protected'", "color('#4f7a4d', 0.45)"],
      ["${zone} === 'industrial'", "color('#5b6471', 0.45)"],
      ["true", "color('#1f6b8a', 0.4)"],
    ],
  },
});
```

The volumes are built exactly like the prisms in [extruding footprints into LOD1 tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/extruding-footprints-into-lod1-tiles/), with the base and top from step 1 instead of a building height, and with the zone attribute carried as feature metadata so the style expression above can read it.

## Expected Output & Verification

```text
        bottom_z   top_z
min       478.20  521.40
max       502.66  578.10
```

Verify coverage rather than appearance, by sampling the classified result along the height of the tallest building in each zone:

```javascript
async function verifyCoverage(tallestByZone) {
  for (const [zoneId, { lon, lat, base, top }] of Object.entries(tallestByZone)) {
    const heights = [base + 1, (base + top) / 2, top - 1];
    for (const h of heights) {
      const world = Cesium.Cartesian3.fromDegrees(lon, lat, h);
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, world);
      const picked = win && viewer.scene.pick(win);
      if (!picked) console.warn(`zone ${zoneId}: nothing picked at ${h.toFixed(1)} m`);
    }
  }
}
```

Checking near the base, the middle and just under the roof is what catches a volume that is too short or whose base is above the terrain. A zone where the top sample misses is the classic under-extruded volume; one where the base sample misses has its bottom above the ground, usually from orthometric heights used as ellipsoidal.

Also confirm the hardware supports the technique at all, and that the layer is one primitive:

```javascript
console.log("stencil buffer:", viewer.scene.context.stencilBuffer);
console.log("primitives:", viewer.scene.primitives.length);
```

<figure class="diagram">
<svg viewBox="6 6 748 186" role="img" aria-labelledby="cls-scale-t cls-scale-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cls-scale-t">Classification primitive against classification tileset</title>
  <desc id="cls-scale-d">A comparison table. A classification primitive holds all volumes in memory, is built once at load, styles through instance attributes and suits up to a few thousand volumes. A classification tileset streams and culls volumes, is built offline, styles through a tile style expression and suits tens of thousands or more.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="186" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="260" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="20" width="260" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="200" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="58" width="260" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="58" width="260" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="98" width="200" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="98" width="260" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="98" width="260" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="138" width="200" height="40" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="138" width="260" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="480" y="138" width="260" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="44">property</text>
    <text x="350" y="44">ClassificationPrimitive</text>
    <text x="610" y="44">classification tileset</text>
    <text x="120" y="83">build</text><text x="350" y="83">in the browser, at load</text><text x="610" y="83">offline, in the pipeline</text>
    <text x="120" y="123">styling</text><text x="350" y="123">instance attributes, instant</text><text x="610" y="123">tile style expressions</text>
    <text x="120" y="163">scale</text><text x="350" y="163">up to a few thousand</text><text x="610" y="163">tens of thousands and up</text>
  </g>
</svg>
<figcaption>The same rendering technique, two delivery mechanisms. The crossover is where in-browser build time and memory start to be felt.</figcaption>
</figure>

## Performance Notes

- **Volumes are shadow geometry**, so their cost is proportional to vertex count and to the height range they span. Simplify polygons and avoid volumes that span a whole valley.
- **One primitive per layer, restyled through attributes.** Rebuilding to change a colour is the mistake that makes classification feel slow.
- **Overlapping volumes multiply fragment work.** Where zones overlap, ship non-overlapping volumes from the pipeline rather than letting the renderer blend them.
- **Hide rather than remove.** `show` on an instance attribute costs nothing; removing and re-adding a primitive rebuilds geometry.
- **Watch memory alongside the tileset's.** Classification geometry counts against the same budget as tile content, which is sized in [tuning tileset cache bytes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/tuning-tileset-cache-bytes-for-memory-constrained-clients/).

## Common Errors

**Nothing is coloured, and no error appears.** Either the stencil buffer is unavailable, or `classificationType` is `TERRAIN` while the target is a tileset, or the volume's height range does not intersect the buildings. Check all three in that order.

**Only the ground floor of every building is coloured.** The volume's `extrudedHeight` is below the roofs. Recompute the top from the maximum of base plus height in the zone, as step 1 does.

**The colour is applied to the terrain as well and swamps the scene.** `BOTH` was set on a layer that only needed buildings. Zoning almost never wants `BOTH`.

**Volumes appear to shift as the camera moves closer.** The building tiles are refining, and classification paints whatever level of detail is loaded. This is inherent; explain it rather than fighting it.

## Frequently Asked Questions

### Can I classify with a polygon that has holes?

Yes — pass the inner rings in the `PolygonHierarchy`, as in step 2. Holes are the right way to model a zone with an excluded parcel, and they cost nothing extra.

### Does classification change the tileset's own styling?

No. The tileset keeps its style and its textures; classification draws over the fragments inside the volume. Both are visible at once, which is why alpha around 0.4–0.5 works better than an opaque colour.

### Is there a limit on the number of volumes in one primitive?

No hard limit, but each instance adds geometry to the batch, and build time and memory grow linearly. Several thousand is comfortable; beyond that, the tileset route is the answer.

## Related Guides

- [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/) — how classification compares with draping and imagery
- [Extruding Footprints into LOD1 Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/extruding-footprints-into-lod1-tiles/) — building the volumes as a tileset
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — styling the buildings directly when the attribute is already in the tiles

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
