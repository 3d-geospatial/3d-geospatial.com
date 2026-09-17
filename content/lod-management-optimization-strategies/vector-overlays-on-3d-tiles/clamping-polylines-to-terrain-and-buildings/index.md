# Clamping Polylines to Terrain and Buildings

This page draws linear features over tiled 3D content in CesiumJS so they stay visible and correctly placed — clamping routes and boundaries onto terrain and buildings with ground polylines, choosing the arc type for long lines, styling with widths in pixels and dashes, handling genuinely aerial lines such as cables with a depth-fail material and a catenary, and verifying placement against sampled terrain in EPSG:4979.

## Why you hit this

A line is the hardest overlay to place. A polygon draped on terrain looks right whatever the terrain does; a line drawn from surveyed coordinates disappears into the ground on one side of a ridge and floats a metre above it on the other, because the terrain tile in view is an approximation whose error changes with the level of detail. The usual reaction — add a metre to every height — swaps one artefact for another, and neither survives the camera moving closer. Cesium has a purpose-built answer, and the remaining work is knowing when *not* to clamp. The strategy context is in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).

## Prerequisites

- CesiumJS 1.110+ with terrain loaded and depth-texture support (`scene.groundPrimitiveSupported`).
- Python 3.10+ with `geopandas>=0.14`, `shapely>=2.0` and `pyproj>=3.6` for preparing the lines.
- Line data with a declared CRS; the examples use an inspection route and a cable span digitised in EPSG:25832.

## Step-by-Step

### 1. Prepare and densify the lines

```python
import geopandas as gpd
import numpy as np
from shapely.geometry import LineString

routes = gpd.read_file("network.gpkg", layer="inspection_routes").to_crs(25832)

def densify(line, max_spacing=25.0):
    """Insert vertices so no segment exceeds max_spacing, in CRS units."""
    coords = list(line.coords)
    out = [coords[0]]
    for a, b in zip(coords, coords[1:]):
        d = np.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(np.ceil(d / max_spacing)))
        for k in range(1, n + 1):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    return LineString(out)

routes["geometry"] = routes.geometry.apply(densify)
routes.to_crs(4326)[["route_id", "status", "geometry"]].to_file("web/routes_4326.geojson", driver="GeoJSON")
print(f"{len(routes)} routes, {int(routes.geometry.apply(lambda g: len(g.coords)).sum()):,} vertices")
```

Densifying looks unnecessary — a clamped line follows the terrain regardless — and it matters for a different reason: a clamped polyline is subdivided along the ground, but its *horizontal* path between two far-apart vertices is a straight line in the chosen arc type, not along the road it was digitised from. A 25 m spacing keeps a route on its road over a curve without exploding the vertex count.

### 2. Clamp with a batched ground polyline primitive

```javascript
async function clampedRoutes(url, scene, colorFor) {
  const fc = await (await fetch(url)).json();
  const instances = fc.features.map((f) => new Cesium.GeometryInstance({
    geometry: new Cesium.GroundPolylineGeometry({
      positions: Cesium.Cartesian3.fromDegreesArray(f.geometry.coordinates.flat()),
      width: 6.0,                            // pixels, not metres
      arcType: Cesium.ArcType.GEODESIC,
      granularity: Cesium.Math.RADIANS_PER_DEGREE * 0.05,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFor(f.properties)),
    },
    id: f.properties.route_id,
  }));

  const primitive = new Cesium.GroundPolylinePrimitive({
    geometryInstances: instances,
    classificationType: Cesium.ClassificationType.BOTH,
    appearance: new Cesium.PolylineColorAppearance(),
    asynchronous: true,
  });
  scene.primitives.add(primitive);
  await primitive.readyPromise;
  return primitive;
}

const statusColor = {
  due: Cesium.Color.fromCssColorString("#c46a3d"),
  done: Cesium.Color.fromCssColorString("#4f7a4d"),
  blocked: Cesium.Color.fromCssColorString("#b0413e"),
};
const routes = await clampedRoutes("/web/routes_4326.geojson", viewer.scene,
  (p) => statusColor[p.status] ?? Cesium.Color.fromCssColorString("#1f6b8a"));
```

Width is in pixels, which is the right unit for a line that means "the route", because it stays readable at every zoom. A line that represents a physical width — a 3.5 m carriageway — is not a polyline at all; it is a draped polygon. `classificationType: BOTH` lets the route climb onto a building where it crosses one, which is what an inspection route through a site should do.

<figure class="diagram">
<svg viewBox="16 92 751 178" role="img" aria-labelledby="poly-three-t poly-three-d" xmlns="http://www.w3.org/2000/svg">
  <title id="poly-three-t">Three ways a line meets the terrain</title>
  <desc id="poly-three-d">Three sections of the same ridge. A line drawn at its surveyed heights cuts through the hill and floats over the valley. A line offset upward by one metre floats visibly on the slope and still disappears where terrain error exceeds the offset. A clamped ground polyline follows the surface exactly at every level of detail.</desc>
  <rect class="svg-bg" x="16" y="92" width="751" height="178" fill="#ffffff"/>
  <path d="M30 190 C90 190 120 120 180 120 C240 120 250 180 300 186" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M30 186 L300 176" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="165" y="222" fill="#b0413e" font-size="12.5" text-anchor="middle">surveyed heights: cuts and floats</text>
  <path d="M330 190 C390 190 420 120 480 120 C540 120 550 180 600 186" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M330 178 C390 178 420 108 480 108 C540 108 550 168 600 174" fill="none" stroke="#9a4f26" stroke-width="2.5" stroke-dasharray="6 4"/>
  <text x="465" y="222" fill="#9a4f26" font-size="12.5" text-anchor="middle">offset 1 m: floats on slopes</text>
  <path d="M630 226 C670 226 682 196 712 196" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M630 226 C670 226 682 196 712 196" fill="none" stroke="#1f6b8a" stroke-width="2" stroke-dasharray="3 3"/>
  <text x="680" y="252" fill="#1f6b8a" font-size="12.5" text-anchor="middle">clamped: on the surface</text>
  <text x="680" y="120" fill="#15384a" font-size="12.5" text-anchor="middle">clamping uses the</text>
  <text x="680" y="138" fill="#15384a" font-size="12.5" text-anchor="middle">depth buffer, so it</text>
  <text x="680" y="156" fill="#15384a" font-size="12.5" text-anchor="middle">follows every refinement</text>
</svg>
<figcaption>Only clamping survives a change of terrain level of detail, because it is resolved per pixel against whatever surface is drawn.</figcaption>
</figure>

### 3. Choose the arc type deliberately

```javascript
// Two vertices 40 km apart, drawn three ways
const a = [11.1, 48.0], b = [11.9, 48.3];
for (const [name, arcType] of [["GEODESIC", Cesium.ArcType.GEODESIC],
                               ["RHUMB", Cesium.ArcType.RHUMB],
                               ["NONE", Cesium.ArcType.NONE]]) {
  viewer.entities.add({
    name,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([...a, ...b]),
      width: 3,
      clampToGround: true,
      arcType,
      material: Cesium.Color.fromCssColorString(name === "GEODESIC" ? "#1f6b8a" : name === "RHUMB" ? "#c46a3d" : "#b0413e"),
    },
  });
}
```

`GEODESIC` follows the shortest path on the ellipsoid and is right for anything derived from survey or GIS data at city scale. `RHUMB` holds a constant bearing, which matters for marine and aviation lines. `NONE` connects the two positions with a straight line through space, which for two points 40 km apart passes about 30 m below the surface — invisible when clamped, and wrong as soon as the line is used for measurement. At the segment lengths of a densified route the three agree to millimetres, which is another reason densifying early removes a class of question.

### 4. Style with dashes, and keep width honest

```javascript
viewer.entities.add({
  name: "planned diversion",
  polyline: {
    positions: Cesium.Cartesian3.fromDegreesArray(diversionLonLat),
    width: 5,
    clampToGround: true,
    classificationType: Cesium.ClassificationType.BOTH,
    material: new Cesium.PolylineDashMaterialProperty({
      color: Cesium.Color.fromCssColorString("#c46a3d"),
      dashLength: 20.0,
    }),
  },
});
```

Dashes read as "planned" or "provisional" without a legend, which makes them worth the extra material. Keep the vocabulary small and consistent across a twin — solid for as-built, dashed for planned, dotted for inferred — because a viewer with six line styles teaches nobody anything.

### 5. Do not clamp what is genuinely in the air

A power line, a pipe bridge or a crane path has real geometry above the ground, and clamping it would be a lie. Those lines need their own heights, a depth-fail material so they remain visible where terrain hides them, and a sag curve if they are suspended.

```javascript
function catenary(startLonLatH, endLonLatH, sagMetres, samples = 48) {
  const positions = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lon = startLonLatH[0] + (endLonLatH[0] - startLonLatH[0]) * t;
    const lat = startLonLatH[1] + (endLonLatH[1] - startLonLatH[1]) * t;
    const straight = startLonLatH[2] + (endLonLatH[2] - startLonLatH[2]) * t;
    const sag = sagMetres * 4 * t * (1 - t);          // parabolic approximation of a catenary
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, straight - sag));
  }
  return positions;
}

viewer.entities.add({
  name: "110 kV span",
  polyline: {
    positions: catenary([11.5701, 48.1362, 512.4], [11.5768, 48.1379, 514.1], 6.2),
    width: 3,
    clampToGround: false,
    material: Cesium.Color.fromCssColorString("#1f2937"),
    depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
      color: Cesium.Color.fromCssColorString("#5b6471"),
      dashLength: 12.0,
    }),
  },
});
```

The parabola is the standard small-sag approximation of a catenary and is accurate to a few centimetres for spans under a few hundred metres — well inside the accuracy of the sag figure itself, which comes from the line's design tension and temperature. `depthFailMaterial` is the detail that makes an aerial line usable: where a building or hill is in front of the span, the dashed grey material draws instead of nothing, so the user sees the line continue behind the obstruction.

<figure class="diagram">
<svg viewBox="90 56 580 202" role="img" aria-labelledby="poly-cat-t poly-cat-d" xmlns="http://www.w3.org/2000/svg">
  <title id="poly-cat-t">An aerial span with sag and a depth-fail material</title>
  <desc id="poly-cat-d">Two pylons with a conductor sagging between them. The visible part of the span is drawn solid. Where a building stands in front of the span, the segment behind it is drawn with a dashed depth-fail material so the line reads as continuing behind the obstruction rather than ending at it.</desc>
  <rect class="svg-bg" x="90" y="56" width="580" height="202" fill="#ffffff"/>
  <path d="M40 200 H720" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M120 200 V80 M110 92 H130 M104 116 H136" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <path d="M640 200 V70 M630 82 H650 M624 106 H656" fill="none" stroke="#5b6471" stroke-width="2.5"/>
  <path d="M120 84 C260 168 300 176 380 174" fill="none" stroke="#1f2937" stroke-width="2.5"/>
  <path d="M470 168 C540 150 580 110 640 74" fill="none" stroke="#1f2937" stroke-width="2.5"/>
  <path d="M380 174 C410 172 440 171 470 168" fill="none" stroke="#5b6471" stroke-width="2.5" stroke-dasharray="6 5"/>
  <rect x="368" y="120" width="104" height="80" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <text x="420" y="112" fill="#1f2937" font-size="12.5" text-anchor="middle">building tile in front</text>
  <text x="250" y="140" fill="#1f2937" font-size="12.5" text-anchor="middle">sag ≈ 6 m at mid-span</text>
  <text x="560" y="218" fill="#5b6471" font-size="12.5" text-anchor="middle">dashed: depthFailMaterial</text>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">Clamping this line to the ground would put a 110 kV conductor on the pavement.</text>
</svg>
<figcaption>Aerial lines keep their own heights; the depth-fail material is what stops them vanishing behind the geometry they pass.</figcaption>
</figure>

### 6. Verify placement against sampled terrain

```javascript
const carto = routeLonLat.reduce((acc, v, i) => (i % 2 ? acc : [...acc, Cesium.Cartographic.fromDegrees(routeLonLat[i], routeLonLat[i + 1])]), []);
const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, carto);
const heights = sampled.map((c) => c.height);
console.log(`route terrain height: min ${Math.min(...heights).toFixed(1)} m, max ${Math.max(...heights).toFixed(1)} m`);

const picked = viewer.scene.pick(Cesium.SceneTransforms.worldToWindowCoordinates(
  viewer.scene, Cesium.Cartesian3.fromDegrees(routeLonLat[0], routeLonLat[1])));
console.log("picked id at the route start:", picked && picked.id);
```

`sampleTerrainMostDetailed` gives the heights the route actually runs over, which is the number a report needs — the length of a clamped line along the ground, the maximum gradient, the height range. Picking at a known vertex confirms the identifier survived batching.

## Expected Output & Verification

```text
84 routes, 12,908 vertices
route terrain height: min 508.2 m, max 547.9 m
picked id at the route start: RT-0042
```

Verify clamping visually at two levels of detail: fly in until the terrain refines twice and confirm the line does not detach. A line that separates from the surface as tiles refine was not clamped — it was drawn with `perPositionHeight` or with `clampToGround` on a primitive type that ignores it.

For length, measure along the sampled heights rather than in plan:

```javascript
let flat = 0, slope = 0;
for (let i = 1; i < sampled.length; i++) {
  const a = Cesium.Cartographic.toCartesian(sampled[i - 1]);
  const b = Cesium.Cartographic.toCartesian(sampled[i]);
  slope += Cesium.Cartesian3.distance(a, b);
  flat += Cesium.Cartesian3.distance(
    Cesium.Cartesian3.fromRadians(sampled[i - 1].longitude, sampled[i - 1].latitude, 0),
    Cesium.Cartesian3.fromRadians(sampled[i].longitude, sampled[i].latitude, 0));
}
console.log(`plan length ${flat.toFixed(0)} m, along-ground length ${slope.toFixed(0)} m`);
```

<figure class="diagram">
<svg viewBox="46 32 668 220" role="img" aria-labelledby="poly-len-t poly-len-d" xmlns="http://www.w3.org/2000/svg">
  <title id="poly-len-t">Plan length against along-ground length</title>
  <desc id="poly-len-d">A route profile over a hill. Its plan length is the horizontal distance, while the along-ground length follows the slope and is longer. On a route with a mean gradient of twelve percent the difference is about one percent, and on steep sections it reaches several percent, which matters for inspection time and cable lengths.</desc>
  <rect class="svg-bg" x="46" y="32" width="668" height="220" fill="#ffffff"/>
  <path d="M60 170 C180 170 220 80 340 80 C460 80 500 150 700 150" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M60 200 H700" fill="none" stroke="#5b6471" stroke-width="2"/>
  <path d="M60 206 V220 M700 206 V220" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <text x="380" y="234" fill="#1f2937" font-size="12.5" text-anchor="middle">plan length 1,840 m</text>
  <text x="330" y="60" fill="#4f7a4d" font-size="12.5" text-anchor="middle">along-ground length 1,868 m</text>
  <text x="620" y="110" fill="#15384a" font-size="12.5" text-anchor="middle">+1.5% on this profile</text>
</svg>
<figcaption>A clamped line looks right and is not measured for free: any length a report quotes has to say whether it is in plan or along the ground.</figcaption>
</figure>

## Performance Notes

- **Batch, as with polygons.** One `GroundPolylinePrimitive` with a hundred routes is one draw call; a hundred entity polylines are a hundred.
- **Granularity controls subdivision.** A coarse granularity on long segments makes a clamped line cut corners across terrain; a very fine one multiplies vertices. The default is fine for city-scale work once lines are densified to 25 m.
- **Dash materials cost a separate appearance**, so a layer with three dash styles is three primitives. Group by style, not by feature.
- **Aerial spans are cheap** — 48 positions each — but each entity is its own primitive; for a transmission network with thousands of spans, build them into one `PolylineCollection`.

## Common Errors

**The line is invisible over buildings but fine over terrain.** `classificationType` is `TERRAIN`. Set `BOTH` for anything that should climb onto tile content.

**A long line bulges away from the road it follows.** Two distant vertices connected with `ArcType.NONE` or a coarse granularity. Densify the line and use `GEODESIC`.

**`width` appears to do nothing beyond about 10.** Browsers cap hardware line width; Cesium's ground polylines are rendered as geometry and handle larger widths, but entity polylines on some platforms do not. Use the ground polyline path when a thick line matters.

**An aerial line flickers against a building.** Z-fighting between the span and the facade it grazes. Nudge the span's height by its real clearance rather than an arbitrary offset, and keep the depth-fail material so the hidden part still reads.

## Frequently Asked Questions

### Can a clamped line be picked reliably?

Yes, by instance id as in step 2, and the pick tolerance is the drawn pixel width — a 6 px line is easy to hit. For touch interfaces, draw an invisible wider line behind it for picking, or increase the width on small screens.

### How do I show direction along a route?

A polyline arrow material for a single route, or a repeating dash offset animated over time for a flow. Both cost a material per style, so use them for the few routes where direction matters rather than for a whole network.

### Do clamped lines work without terrain?

Yes — with the ellipsoid as the surface, they clamp to it, and with `CESIUM_3D_TILE` they clamp to tile content. A line over a flat ellipsoid and a tileset of buildings is a valid and common configuration for a site twin.

## Related Guides

- [Draping GeoJSON Polygons on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/draping-geojson-polygons-on-3d-tiles/) — the polygon equivalent, including batching
- [Classifying 3D Tiles with Polygon Volumes](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/classifying-3d-tiles-with-polygon-volumes/) — colouring the buildings a route passes
- [Tracking Down Z-Fighting Between Terrain and Buildings](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracking-down-z-fighting-between-terrain-and-buildings/) — when an aerial line grazes geometry

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
