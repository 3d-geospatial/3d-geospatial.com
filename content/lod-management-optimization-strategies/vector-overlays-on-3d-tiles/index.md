# Vector Overlays on 3D Tiles

A digital twin is rarely just geometry. The questions people bring to it are about parcels, zoning, easements, planned routes, flood extents, inspection findings and asset identifiers — all of it vector data that has to appear *on* the tiled 3D content without fighting it for depth, memory or frame time. This guide covers the five ways to put vector data over a 3D Tiles scene, what each one costs, and how to choose: draping polygons onto terrain and buildings, clamping polylines, extruding footprints into their own tiles, classifying existing tiles with polygon volumes, and rendering vector data as imagery for the cases where nothing else scales.

It is written for engineers building on CesiumJS over 3D Tiles produced by the pipelines in [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/), with source vector data in a projected CRS such as EPSG:25832 that is transformed to EPSG:4979 for display.

## Prerequisites

- CesiumJS 1.110 or newer, and Python 3.10+ with `geopandas>=0.14`, `shapely>=2.0`, `pyproj>=3.6` for preparing the data.
- Vector data with a declared CRS and valid geometry — invalid polygons drape as holes or not at all.
- A 3D Tiles tileset with known bounding volumes, and terrain if ground draping is involved.
- A decision about what "on the ground" means for each layer: on the terrain, on the buildings, or on both. That choice drives everything below.

## The Five Strategies

### Ground primitives: drape polygons on terrain

A `GroundPrimitive` renders a polygon by projecting it onto whatever is beneath it, using the depth buffer rather than geometry. Because the polygon has no height of its own, it follows every hill and every tile refinement without seams, and it needs no terrain sampling at load time.

```javascript
const parcels = await Cesium.GeoJsonDataSource.load("/data/parcels_4326.geojson", {
  clampToGround: true,
  fill: Cesium.Color.fromCssColorString("#1f6b8a").withAlpha(0.35),
  stroke: Cesium.Color.fromCssColorString("#15384a"),
  strokeWidth: 2,
});
viewer.dataSources.add(parcels);
```

**Key Practice:** Keep draped layers under a few thousand polygons, and merge them into one primitive when you can. Every `GroundPrimitive` is a draw call with its own shadow-volume geometry; ten thousand separate parcel entities will cost more frame time than the whole city tileset. Where a layer is larger than that, move it to imagery or to its own tileset.

### Classification: paint the buildings, not the ground

`classificationType` decides what a draped geometry is allowed to colour. `Cesium.ClassificationType.TERRAIN` paints terrain only, `CESIUM_3D_TILE` paints tile content only, and `BOTH` paints whatever is in front.

```javascript
const zone = new Cesium.ClassificationPrimitive({
  geometryInstances: new Cesium.GeometryInstance({
    geometry: new Cesium.PolygonGeometry({
      polygonHierarchy: new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArrayHeights(flatCoordsWithHeights)
      ),
      extrudedHeight: 60.0,
      height: 0.0,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromCssColorString("#c46a3d").withAlpha(0.5)
      ),
    },
  }),
  classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
});
scene.primitives.add(zone);
```

**Key Practice:** Give a classification volume an extruded height that comfortably exceeds the tallest building it must cover, and a base below the lowest terrain in its footprint. Classification works by testing what lies inside the volume, so a zone extruded to 20 m colours the bottom 20 m of a 60 m tower and leaves the rest untouched — which looks like a rendering bug and is a geometry mistake.

### Extruded tiles: turn vector data into 3D Tiles

Above roughly ten thousand features, or whenever the overlay has real height — building footprints at LOD1, flood volumes, noise envelopes — the overlay belongs in its own tileset, streamed and culled exactly like the rest of the scene.

```python
import geopandas as gpd

parcels = gpd.read_file("parcels.gpkg").to_crs(25832)
parcels["height"] = parcels["zoning_max_height_m"].fillna(12.0)
parcels["base"] = parcels["terrain_z"]            # sampled from the DTM beforehand
parcels[["geometry", "height", "base", "parcel_id"]].to_file("zoning_prisms.gpkg")
```

**Key Practice:** Sample the terrain into the vector data *before* tiling and store the base height per feature. A tileset generated with a constant base floats over a valley and buries itself in a hill, and no runtime option can fix geometry that is already baked into tiles. The extrusion mechanics are in [extruding footprints into LOD1 tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/extruding-footprints-into-lod1-tiles/).

### Clamped polylines: routes, pipes and boundaries

Polylines are their own problem, because a line clamped to the ground disappears behind every bump and a line offset upward floats visibly on a slope.

```javascript
viewer.entities.add({
  polyline: {
    positions: Cesium.Cartesian3.fromDegreesArray(routeLonLat),
    width: 6,
    clampToGround: true,
    classificationType: Cesium.ClassificationType.BOTH,
    material: new Cesium.PolylineOutlineMaterialProperty({
      color: Cesium.Color.fromCssColorString("#b0413e"),
      outlineWidth: 2,
      outlineColor: Cesium.Color.WHITE,
    }),
  },
});
```

**Key Practice:** Clamp, do not offset. `clampToGround` draws the line into the depth buffer of the surface beneath it, so it stays visible over terrain and buildings at every level of detail; an offset of "a metre or two" is a guess that fails on a 30% slope and inside a tile whose geometric error is larger than the offset. The cases where an offset is genuinely needed — a suspended cable, an aerial route — are in [clamping polylines to terrain and buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/clamping-polylines-to-terrain-and-buildings/).

### Imagery: vector data at raster scale

A cadastre of two million parcels, a national soil map, a basemap: these are not overlay geometry, they are pictures. Rendering them server-side into raster tiles and adding them as an imagery layer puts the cost on a tile server that caches, instead of on the client's geometry budget.

```javascript
viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://tiles.example.org/cadastre/{z}/{x}/{y}.png",
    maximumLevel: 20,
    credit: "Cadastre © state survey",
  })
);
```

**Key Practice:** Imagery drapes on terrain but not on buildings, so it is right for ground-level context and wrong for anything that must appear on a facade or a roof. Combine it with a small classification layer for the few features that need to reach up onto the buildings.

<figure class="diagram">
<svg viewBox="26 12 718 294" role="img" aria-labelledby="vo-arch-t vo-arch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vo-arch-t">Where each overlay strategy lands in the scene</title>
  <desc id="vo-arch-d">A scene with terrain and building tiles. Imagery drapes on the terrain only. Ground primitives drape on terrain and can be restricted or extended to tile content through the classification type. Classification volumes paint the surfaces of building tiles inside them. An overlay tileset adds its own geometry, streamed and culled like the buildings. Labels and billboards float above everything in screen space.</desc>
  <rect class="svg-bg" x="26" y="12" width="718" height="294" fill="#ffffff"/>
  <defs>
    <marker id="vo-arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M40 250 C200 240 340 258 520 244 C620 236 680 244 730 240" fill="none" stroke="#4f7a4d" stroke-width="3"/>
  <path d="M150 244 H300" fill="none" stroke="#9a4f26" stroke-width="6"/>
  <rect x="360" y="150" width="70" height="96" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="450" y="110" width="80" height="136" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M350 100 h190 v146 h-190 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2" stroke-dasharray="6 4" fill-opacity="0.45"/>
  <rect x="590" y="176" width="60" height="68" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="40" y="40">imagery: terrain only</text>
    <text x="40" y="62">ground primitive: drapes, classification type decides what it paints</text>
    <text x="40" y="84">classification volume: paints tile content inside it</text>
    <text x="40" y="106">overlay tileset: its own streamed geometry</text>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none" marker-end="url(#vo-arch-arrow)">
    <path d="M120 46 C120 120 90 200 60 240"/>
    <path d="M230 68 V236"/>
    <path d="M330 90 L350 120"/>
    <path d="M330 112 C440 130 540 170 586 194"/>
  </g>
  <text x="620" y="266" fill="#4f7a4d" font-size="12" text-anchor="middle">overlay tileset</text>
  <text x="225" y="266" fill="#9a4f26" font-size="12" text-anchor="middle">draped polygon</text>
  <text x="445" y="288" fill="#15384a" font-size="12.5" text-anchor="middle">Only a classification volume and an overlay tileset can reach up the facades.</text>
</svg>
<figcaption>The five strategies differ in where their pixels can appear and in what they cost; nothing about the source data decides between them.</figcaption>
</figure>

## Choosing a Strategy

The decision is driven by three properties of the layer: how many features it has, whether it needs to appear on buildings as well as ground, and whether it has to be interactive — clickable, styled per feature, updated live.

| Layer | Features | Needs facades | Strategy |
|---|---|---|---|
| Site boundary, a few parcels | < 100 | no | ground primitive |
| District zoning | 100–5,000 | yes | classification volumes |
| City cadastre | > 100,000 | no | imagery |
| LOD1 zoning envelopes | > 10,000 | yes | overlay tileset |
| Inspection route | 1 polyline | yes | clamped polyline |
| Asset identifiers | 1,000–50,000 | n/a | label collection with clustering |

**Key Practice:** Never mix strategies for one layer to "get the best of both". Two representations of the same features, one draped and one extruded, produce double-drawn edges, inconsistent picking and two places to fix a styling bug. Pick one per layer and switch wholesale when the data outgrows it.

<figure class="diagram">
<svg viewBox="6 6 728 226" role="img" aria-labelledby="vo-dec-t vo-dec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vo-dec-t">Feature count against the need for facade coverage</title>
  <desc id="vo-dec-d">A two by three grid. With few features and ground only, use ground primitives. With few features needing facades, use classification volumes. With many features and ground only, use imagery. With many features needing facades, build an overlay tileset. Interactivity requirements push a layer one step towards geometry rather than imagery.</desc>
  <rect class="svg-bg" x="6" y="6" width="728" height="226" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="180" y="20" width="270" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="450" y="20" width="270" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="160" height="80" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="180" y="58" width="270" height="80" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="58" width="270" height="80" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="138" width="160" height="80" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="180" y="138" width="270" height="80" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="450" y="138" width="270" height="80" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="315" y="44">ground only</text>
    <text x="585" y="44">must reach facades</text>
    <text x="100" y="94">up to ~5,000</text>
    <text x="100" y="112">features</text>
    <text x="315" y="92">ground primitives,</text>
    <text x="315" y="110">merged into few draw calls</text>
    <text x="585" y="92">classification volumes,</text>
    <text x="585" y="110">extruded past the tallest roof</text>
    <text x="100" y="174">tens of thousands</text>
    <text x="100" y="192">and up</text>
    <text x="315" y="172">imagery tiles,</text>
    <text x="315" y="190">rendered server-side</text>
    <text x="585" y="172">overlay 3D Tiles,</text>
    <text x="585" y="190">streamed and culled</text>
  </g>
</svg>
<figcaption>Only two of the four quadrants can paint a facade, and only two of them scale past a few thousand features.</figcaption>
</figure>

## What Overlays Cost, and Where

It helps to know which resource each strategy spends, because the symptoms differ and so do the fixes.

Draped geometry spends **client memory and build time**. Every polygon becomes a shadow volume — geometry extruded through the height range it covers — held for as long as the layer is on screen. A thousand parcels with twenty vertices each is nothing; a soil map with a million vertices takes seconds to build in a worker and hundreds of megabytes to hold, and the symptom is a stall when the layer is switched on rather than a low frame rate afterwards.

Classification volumes spend **fill rate**. The geometry is small — a few vertices per zone — but every pixel inside a volume is tested against the depth and stencil buffers, so overlapping volumes multiply the per-pixel work. The symptom is a frame rate that falls when the camera looks along a street where many zones overlap, and is fine when it looks down at the same zones from above.

An overlay tileset spends **the same budget as the rest of the scene**: requests, decode time and the tile cache. That is a feature rather than a cost, because it means the overlay is culled and streamed by the same machinery, and the familiar controls apply. The symptom of an overlay tileset that is too heavy is the same as for any tileset — tiles evicted and re-requested, covered in [tuning tileset cache bytes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/tuning-tileset-cache-bytes-for-memory-constrained-clients/).

Imagery spends **network and cache storage on the server**, and almost nothing on the client. A raster layer of a national cadastre is a few hundred megabytes of PNG at rest, served from a CDN, and the client holds a handful of textures for the tiles in view. What it cannot do is interact: there is no feature to pick and no way to restyle without rebuilding.

Labels and billboards spend **text rasterisation and per-frame position updates**. They are the only overlay whose cost is largely independent of the geometry underneath, and the only one where the readability limit arrives before the performance limit — a thousand labels in one view is unreadable long before it is slow.

**Key Practice:** Diagnose an overlay problem by which resource the symptom points at, before changing strategy. A stall on toggle is build time, a drop when looking sideways is fill rate, tiles re-requested is the cache, and unreadable clutter is a labelling policy — and each has a fix that does not involve rewriting the layer.

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="vo-cost-t vo-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vo-cost-t">Which resource each strategy spends</title>
  <desc id="vo-cost-d">A table of strategies against the resource they consume and the symptom when they are over-used. Draped geometry spends client memory and build time, and stalls on toggle. Classification spends fill rate, and drops frames when looking along a street. An overlay tileset spends the tile cache, and re-requests tiles. Imagery spends server storage, and costs nothing on the client. Labels spend text rasterisation, and become unreadable before they become slow.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="450" y="20" width="290" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="220" y="54" width="230" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="450" y="54" width="290" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="88" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="220" y="88" width="230" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="450" y="88" width="290" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="122" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="122" width="230" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="450" y="122" width="290" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="156" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="156" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="156" width="290" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="190" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="220" y="190" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="450" y="190" width="290" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="42">strategy</text><text x="335" y="42">spends</text><text x="595" y="42">symptom when over-used</text>
    <text x="120" y="76">draped geometry</text><text x="335" y="76">client memory, build time</text><text x="595" y="76">stall when the layer is switched on</text>
    <text x="120" y="110">classification</text><text x="335" y="110">fill rate</text><text x="595" y="110">frames drop looking along a street</text>
    <text x="120" y="144">overlay tileset</text><text x="335" y="144">the tile cache</text><text x="595" y="144">tiles evicted and re-requested</text>
    <text x="120" y="178">imagery</text><text x="335" y="178">server storage</text><text x="595" y="178">nothing on the client</text>
    <text x="120" y="212">labels</text><text x="335" y="212">text rasterisation</text><text x="595" y="212">unreadable before it is slow</text>
  </g>
</svg>
<figcaption>Diagnose by symptom, then change strategy — the five failures look different and have different fixes.</figcaption>
</figure>

## Keeping Attributes Attached

An overlay that cannot answer "what is this?" is decoration. Each strategy carries attributes differently, and deciding this at the pipeline stage saves rebuilding later.

Geometry instances in a primitive take an `id`, which can be a string or an object, and picking returns it directly — so the identifier and a small amount of context travel with the geometry. An overlay tileset carries feature metadata, which is richer and also styleable in the viewer through expressions. Imagery carries nothing, so an interactive raster layer needs a separate feature query by coordinate. Labels carry whatever you put in their `id` alongside their text.

The rule that keeps this maintainable is to ship one stable identifier and let everything else be looked up. Baking a dozen attributes into tiles means rebuilding the tiles when a value changes; baking the identifier means the tiles outlive every attribute change, and the viewer asks an API for the current values. For attributes that change by the minute — occupancy, status, sensor readings — that is the only workable arrangement, and it is described in [streaming live sensor updates onto tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/).

**Key Practice:** Put the identifier in the geometry and the values behind an API. An overlay whose only baked attribute is an identifier can be rebuilt rarely and restyled instantly, which is the opposite of the usual arrangement where a colour change means a tiling run.

## Cross-Section Integration

Overlays are the point at which the twin's geometry meets its attribute data, and that makes them the place where CRS discipline pays off or fails visibly. Vector data arrives in a national projected CRS; Cesium wants longitude, latitude and height on the WGS84 ellipsoid. A parcel layer transformed without its vertical datum drapes fine — draped geometry ignores its own heights — but the moment the same layer is extruded into a tileset, the missing geoid separation appears as a 40 m offset. The transformations are the ones in [coordinate reference systems for 3D assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).

Overlays also inherit the tileset's level of detail. A classification volume paints whatever tile content is loaded, so a building at a coarse level shows the zone on its blocky silhouette and the boundary shifts slightly as the tile refines. That is expected behaviour and worth explaining to users rather than trying to fix; the alternative, forcing a high detail level for the sake of an overlay, costs the memory budget described in [tuning tileset cache bytes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/tuning-tileset-cache-bytes-for-memory-constrained-clients/).

**Key Practice:** Transform vector data to EPSG:4979 once, in the pipeline, and ship the overlay in that frame with its CRS recorded. Transforming in the browser per feature is slow, hard to test, and puts a PROJ-equivalent in a place where nobody will notice it drifting out of date.

## Production Checklist

- [ ] Every overlay layer has one strategy, recorded with the reason.
- [ ] Vector geometry is valid — `shapely.make_valid` applied and the count of repairs logged.
- [ ] Source CRS is declared; transformation to EPSG:4979 happens in the pipeline, not the client.
- [ ] Classification volumes extrude above the tallest building in their footprint and below the lowest terrain.
- [ ] Extruded overlay tiles carry a per-feature base height sampled from the DTM.
- [ ] Draped layers are merged into as few primitives as the styling allows.
- [ ] Labels use a collection with clustering or a distance display condition, not one entity per feature.
- [ ] Picking returns a stable feature identifier that resolves in the source dataset.
- [ ] Layer visibility and memory are measured together — overlays count against the same budget as tiles.

## Troubleshooting Matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Polygon appears on terrain but not on buildings | `classificationType` is `TERRAIN` | set `CESIUM_3D_TILE` or `BOTH` |
| Zone colours only the lower part of towers | classification volume not extruded high enough | extrude past the tallest roof in the footprint |
| Overlay floats or sinks by tens of metres | vertical datum ignored when transforming | transform with the compound CRS |
| Frame rate collapses when a layer is enabled | thousands of separate primitives or entities | merge, or move the layer to imagery or a tileset |
| Line disappears behind terrain | line offset instead of clamped | `clampToGround: true` |
| Labels flicker and overlap | one label entity per feature, no declutter | label collection with clustering |
| Picked feature has no identifier | attributes dropped during tiling | carry the identifier as a feature ID or batch-table property |

## Frequently Asked Questions

### Can I style a draped layer per feature without splitting it into primitives?

Yes — a single `Primitive` can hold many `GeometryInstance`s, each with its own colour attribute, and they batch into one draw call. Changing a colour later means updating the attribute rather than rebuilding the primitive.

### Do overlays work on point cloud tilesets?

Classification does not; it needs surfaces to paint. Ground primitives drape on terrain under a point cloud, and an overlay tileset works anywhere. For colouring points by an attribute, style the point cloud itself instead.

### How do I keep an overlay in sync with a changing database?

Serve the overlay from an endpoint that reads the database, cache it with a short lifetime, and version the URL when the schema changes. For frequently changing status data, keep the geometry static in a tileset and stream only the attribute values — the pattern in [streaming live sensor updates onto tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/).

### Is deck.gl a better fit for large vector overlays?

For pure data visualisation over a basemap, often yes. In a twin where the vector data must interact with 3D Tiles geometry — classification, depth, picking against buildings — the Cesium primitives above are the ones with access to the depth buffer.

### Should an overlay be toggled or always on?

Always-on overlays train users to ignore them, and every one of them costs part of the budget the tiles need. Ship the two or three layers that answer the questions users actually arrive with, and put the rest behind a layer switch that loads them on demand — a layer built lazily on first use costs nothing until somebody wants it.

### Can two classification layers overlap?

They can, and the result is the blend of both colours with no defined order. Where zones overlap, decide the precedence in the pipeline and ship non-overlapping volumes, or use one volume per precedence level and toggle between them.

## Related Guides

- [Draping GeoJSON Polygons on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/draping-geojson-polygons-on-3d-tiles/) — the ground-primitive route in detail
- [Clamping Polylines to Terrain and Buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/clamping-polylines-to-terrain-and-buildings/) — routes and boundaries
- [Extruding Footprints into LOD1 Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/extruding-footprints-into-lod1-tiles/) — when the overlay becomes a tileset
- [Classifying 3D Tiles with Polygon Volumes](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/classifying-3d-tiles-with-polygon-volumes/) — painting facades
- [Rendering Thousands of Labels and Billboards](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/rendering-thousands-of-labels-and-billboards/) — text without wrecking frame time
- [Serving Vector Tiles as Imagery over Terrain](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/serving-vector-tiles-as-imagery-over-terrain/) — the scale escape hatch

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
