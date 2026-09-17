---
title: "Resolving Float32 Precision Jitter in Large-Coordinate Meshes"
description: "Stop vertices shaking and tiles cracking when geometry uses UTM or ECEF coordinates: float32 spacing, storage vs transform precision, re-centring and a floating origin."
---
# Resolving Float32 Precision Jitter in Large-Coordinate Meshes

This page resolves the shaking vertices, cracked tile seams and stair-stepped silhouettes that appear when mesh geometry carries full UTM (EPSG:32618) or Earth-centred (EPSG:4978) coordinates into single-precision buffers and GPU math — measuring the float32 spacing at the coordinates you actually have, separating storage precision from transform precision, re-centring vertex data behind a tile transform, and moving the render origin with the camera in engines that do not do it for you.

## Why you hit this

The failure crosses every section of a twin pipeline, which is why it is hard to pin down. The CRS work in [coordinate reference systems for 3D assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) is correct: the coordinates are right, to the millimetre, in float64. The mesh processing is correct: decimation and export preserve every vertex. Then the exporter writes positions into a glTF `FLOAT` accessor — 32 bits — or a custom viewer multiplies a camera matrix built from ECEF values in a `Float32Array`, and precision the whole pipeline protected disappears in the last step. A float32 value near 6.4 million can only take values half a metre apart. Buildings built from such vertices are rendered on a half-metre grid, and as the camera moves, rounding in the transform chain changes frame by frame, so geometry visibly vibrates.

## Prerequisites

- Python 3.10+ with `numpy>=1.24`, `trimesh>=4.0` and `pygltflib>=1.16`.
- Meshes or tiles whose vertices are, or might be, stored in absolute projected or geocentric coordinates — for example buildings in EPSG:32618 exported from a GIS, or ECEF tiles from a custom tiler.
- For the runtime section, a three.js or custom WebGL viewer; CesiumJS already renders relative to the eye and needs only the storage fix.

## Step-by-Step

### 1. Measure float32 spacing at your coordinates

```python
import numpy as np

for label, value in [("local tile, 200 m", 200.0), ("district, 5 km", 5_000.0),
                     ("UTM easting", 585_412.0), ("UTM northing", 4_511_203.0),
                     ("ECEF", 6_378_137.0)]:
    step = float(np.spacing(np.float32(value)))
    print(f"{label:<18} {value:>14,.1f}  float32 step {step * 1000:>10.3f} mm")
```

`np.spacing` returns the gap between a value and the next representable float of the same type. Float32 has 24 bits of mantissa, so its spacing doubles every time the magnitude doubles: around 15 µm at 200 m, half a millimetre at 5 km, over 6 cm at a UTM easting and half a metre at a UTM northing or any ECEF coordinate. The easting and northing of the same vertex are quantised to different grids, which is why jitter often looks stronger north-south than east-west.

<figure class="diagram">
<svg viewBox="66 3 668 263" role="img" aria-labelledby="fj-ulp-t fj-ulp-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fj-ulp-t">Float32 spacing against coordinate magnitude</title>
  <desc id="fj-ulp-d">A log-log step chart of float32 spacing against the magnitude of a coordinate. Local tile coordinates of a few hundred metres have spacing in micrometres. A 5 kilometre district reaches half a millimetre. UTM eastings around 585 kilometres reach 6 centimetres, and UTM northings and ECEF coordinates in the millions reach half a metre. A horizontal line marks 1 millimetre, the practical limit for building geometry.</desc>
  <rect class="svg-bg" x="66" y="3" width="668" height="263" fill="#ffffff"/>
  <path d="M80 20 V200 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M80 118 H720" fill="none" stroke="#4f7a4d" stroke-width="2" stroke-dasharray="6 4"/>
  <path d="M100 190 H180 V172 H260 V150 H340 V128 H420 V106 H500 V76 H580 V50 H660 V34 H710" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="170" cy="190" r="6"/><circle cx="330" cy="128" r="6"/><circle cx="520" cy="76" r="6"/><circle cx="650" cy="34" r="6"/><circle cx="690" cy="34" r="6"/>
  </g>
  <text x="712" y="112" fill="#4f7a4d" font-size="12" text-anchor="end">1 mm</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="170" y="220">200 m</text><text x="330" y="220">5 km</text><text x="520" y="220">585 km</text><text x="670" y="220">4.5–6.4 Mm</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="186" y="184">15 µm</text><text x="346" y="146">0.5 mm</text><text x="530" y="98">6 cm</text><text x="540" y="30">0.5 m</text>
  </g>
  <text x="400" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">coordinate magnitude (log) — spacing doubles with each doubling of magnitude</text>
</svg>
<figcaption>Below a few kilometres from the origin, float32 is finer than any survey. At projected or geocentric magnitudes it is coarser than the buildings' details.</figcaption>
</figure>

### 2. Scan tiles for large stored coordinates

```python
from pathlib import Path
from pygltflib import GLTF2

def position_extent(glb_path):
    g = GLTF2().load_binary(str(glb_path))
    worst = 0.0
    for mesh in g.meshes:
        for prim in mesh.primitives:
            acc = g.accessors[prim.attributes.POSITION]
            if acc.max and acc.min:
                worst = max(worst, max(abs(v) for v in acc.max + acc.min))
    has_rtc = "CESIUM_RTC" in (g.extensionsUsed or [])
    return worst, has_rtc

flagged = []
for p in sorted(Path("tiles/city/content").rglob("*.glb")):
    extent, rtc = position_extent(p)
    step = float(np.spacing(np.float32(extent))) if extent else 0.0
    if step > 0.001:
        flagged.append((p.name, round(extent), round(step * 1000, 1), rtc))
print(f"{len(flagged)} tiles store positions with float32 steps above 1 mm", flagged[:5])
```

The accessor `min` and `max` are required for positions and give the extent without decoding the buffer. Any tile whose largest absolute coordinate exceeds roughly 8 km has a float32 step above a millimetre and is a candidate for visible artifacts; values in the hundreds of thousands or millions are a certain cause. The check is cheap enough to run on every tile in CI alongside [validating glTF assets with the Khronos validator](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-gltf-assets-with-the-khronos-validator/).

### 3. Re-centre vertex data behind a tile transform

```python
import json
import trimesh

def recentre_tile(glb_in, glb_out):
    scene = trimesh.load(glb_in, force="scene", process=False)
    mesh = scene.to_geometry()                               # float64 vertices in the source frame
    centre = (mesh.bounds[0] + mesh.bounds[1]) / 2
    mesh.vertices = mesh.vertices - centre
    step = float(np.spacing(np.float32(np.abs(mesh.vertices).max())))
    assert step < 1e-4, f"tile still too large after re-centring: step {step * 1000:.2f} mm"
    mesh.export(glb_out)
    translation = np.eye(4)
    translation[:3, 3] = centre
    return translation.T.flatten().tolist()                  # column-major for tileset.json

transform = recentre_tile("in/tile_8812_5631.glb", "out/tile_8812_5631.glb")
print("tile transform translation:", [round(v, 3) for v in transform[12:15]])
```

The large part of every coordinate moves into the tile's `transform`, which is stored in the tileset JSON as float64 and applied by the runtime in double precision. What remains in the buffer is a few hundred metres at most, where float32 is finer than a hundredth of a millimetre. For ECEF data the rotation matters too: a pure translation leaves the local axes aligned with the Earth's axes rather than with east, north and up, which is harmless for precision but awkward for debugging; the full east-north-up version is in [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/).

The re-centring must happen on float64 data. Loading an already-quantised float32 buffer and subtracting its centre only preserves the half-metre grid in smaller numbers. If the only copy of the geometry is the float32 tile, regenerate it from the source rather than re-centring the tile.

<figure class="diagram">
<svg viewBox="6 12 748 218" role="img" aria-labelledby="fj-chain-t fj-chain-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fj-chain-t">Two places precision is lost</title>
  <desc id="fj-chain-d">The path from source coordinates to pixels has two float32 bottlenecks. The first is storage: absolute coordinates written into a float32 vertex buffer are quantised permanently. The second is transform: a model-view matrix computed in float32 from large model and camera positions loses precision every frame, which causes jitter even when stored vertices are small. Re-centring fixes the first; computing model-view in float64 relative to the eye fixes the second.</desc>
  <rect class="svg-bg" x="6" y="12" width="748" height="218" fill="#ffffff"/>
  <defs>
    <marker id="fj-chain-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="140" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="200" y="60" width="160" height="60" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="60" width="160" height="60" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="600" y="60" width="140" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="200" y="160" width="160" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="400" y="160" width="160" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#fj-chain-arrow)">
    <path d="M160 90 H198"/><path d="M360 90 H398"/><path d="M560 90 H598"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="1.5" fill="none" stroke-dasharray="5 4">
    <path d="M280 122 V158"/><path d="M480 122 V158"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="90" y="86">source</text><text x="90" y="103">float64</text>
    <text x="280" y="86">vertex buffer</text><text x="280" y="103">float32: storage</text>
    <text x="480" y="86">model-view</text><text x="480" y="103">float32: transform</text>
    <text x="670" y="86">clip space</text><text x="670" y="103">pixels</text>
    <text x="280" y="184">fix: re-centre +</text><text x="280" y="201">tile transform</text>
    <text x="480" y="184">fix: relative to eye</text><text x="480" y="201">in float64 on CPU</text>
  </g>
  <text x="380" y="40" fill="#15384a" font-size="12.5" text-anchor="middle">Quantised storage looks like stair steps; float32 transforms look like shaking.</text>
</svg>
<figcaption>The two losses have different signatures. Fixing storage alone still leaves shaking in viewers that build their matrices from large numbers in single precision.</figcaption>
</figure>

### 4. Keep the render origin near the camera

CesiumJS computes model-view matrices relative to the eye in double precision on the CPU before uploading them, so re-centred tiles are sufficient there. Engines that place the camera at world coordinates in the millions — a common three.js setup when tiles are loaded with absolute positions — need a floating origin.

```javascript
// three.js: keep the scene origin within a few km of the camera
const ORIGIN_SHIFT_THRESHOLD = 2000;                    // metres
const worldOffset = new THREE.Vector3();                // float64 in JS, never uploaded directly

function rebaseOrigin(camera, worldRoot) {
  if (camera.position.length() < ORIGIN_SHIFT_THRESHOLD) return;
  const shift = camera.position.clone();
  worldOffset.add(shift);                                // accumulate the true position in float64
  worldRoot.position.sub(shift);                         // move the world, not the camera
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld();
  worldRoot.updateMatrixWorld(true);
}

renderer.setAnimationLoop(() => {
  controls.update();
  rebaseOrigin(camera, tilesGroup);
  renderer.render(scene, camera);
});
```

JavaScript numbers are float64, so `worldOffset` holds the camera's true position exactly; only small, camera-relative values reach the GPU's float32 uniforms. Any code that converts screen picks back to geographic coordinates must add `worldOffset` before transforming to EPSG:4978 or EPSG:32618. Also make sure vertex shaders declare `precision highp float;` — on mobile GPUs `mediump` can be a 16-bit float, which reintroduces jitter at only a few hundred metres from the origin.

## Expected Output & Verification

```text
local tile, 200 m           200.0  float32 step      0.015 mm
district, 5 km            5,000.0  float32 step      0.488 mm
UTM easting             585,412.0  float32 step     62.500 mm
UTM northing          4,511,203.0  float32 step    500.000 mm
ECEF                  6,378,137.0  float32 step    500.000 mm
1284 tiles store positions with float32 steps above 1 mm [('tile_8812_5631.glb', 4511261, 500.0, False), …]
tile transform translation: [585412.318, 4511228.44, 11.84]
```

Verify both halves. For storage, reload a re-centred tile, add the transform translation back in float64 and compare every vertex with the float64 source: the maximum difference should be below a tenth of a millimetre. For the runtime, record a slow orbit around a building at street level before and after the fix and difference consecutive frames of a static region — a jittering scene shows non-zero differences in stationary geometry, a fixed one does not.

```python
src = trimesh.load("in/tile_8812_5631_float64.ply", process=False)
out = trimesh.load("out/tile_8812_5631.glb", force="mesh", process=False)
restored = out.vertices.astype(np.float64) + np.array(transform[12:15])
err = np.abs(restored - src.vertices).max()
print(f"max round-trip error {err * 1000:.4f} mm")
assert err < 1e-4
```

<figure class="diagram">
<svg viewBox="26 26 488 182" role="img" aria-labelledby="fj-fix-t fj-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fj-fix-t">Maximum vertex error before and after re-centring</title>
  <desc id="fj-fix-d">Two bars on a log scale compare the maximum vertex position error for the same building tile. With absolute UTM coordinates in a float32 buffer the error is 250 millimetres. After re-centring behind a tile transform the error is 0.004 millimetres, about sixty thousand times smaller.</desc>
  <rect class="svg-bg" x="26" y="26" width="488" height="182" fill="#ffffff"/>
  <path d="M40 20 V160" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="40" y="40" width="460" height="40" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <rect x="40" y="100" width="24" height="40" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <text x="270" y="65" fill="#1f2937" font-size="12.5" text-anchor="middle">absolute UTM in float32 — 250 mm</text>
  <text x="76" y="125" fill="#1f2937" font-size="12.5" text-anchor="start">re-centred + tile transform — 0.004 mm</text>
  <text x="280" y="190" fill="#15384a" font-size="12.5" text-anchor="middle">maximum vertex error for one building tile (log scale)</text>
</svg>
<figcaption>Re-centring costs one float64 subtraction per vertex at export and removes the error entirely for practical purposes.</figcaption>
</figure>

## Common Errors

**Geometry is stable but picked coordinates are off by up to half a metre.** Picking reads back depth or positions through float32 GPU buffers and reconstructs world coordinates from them. Re-add the float64 tile transform or world offset on the CPU after picking instead of reconstructing from GPU values.

**Cracks appear between neighbouring re-centred tiles.** Each tile was re-centred correctly, but the shared edge vertices were quantised or decimated independently before re-centring. Snap shared boundary vertices in float64 across tiles first, then re-centre.

**Jitter persists in CesiumJS after re-centring.** Some geometry bypasses the tileset — an entity, a custom primitive or a model loaded with absolute positions. Check `CESIUM_RTC` or a `modelMatrix` on those objects; the tileset content itself is no longer the source.

## Frequently Asked Questions

### Does KHR_mesh_quantization make this worse?

It makes it explicit. Quantised positions are integers scaled into a bounding box, so precision depends on the box size and bit depth, not on the absolute magnitude — which is why quantisation must happen after re-centring, with a box sized to the tile rather than the city.

### Is CESIUM_RTC an acceptable alternative to a tile transform?

It solves the storage problem for runtimes that support it, mostly CesiumJS. A tile `transform` in the tileset is part of the 3D Tiles specification and portable across runtimes, so prefer it for new content.

### Why not use float64 vertex buffers?

glTF does not allow double-precision vertex attributes, and WebGL cannot upload them as vertex data. Precision has to come from structure — small local coordinates plus double-precision transforms — rather than from a wider type.

## Related Guides

- [Diagnosing CRS Drift Causing LOD Seams](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-crs-drift-causing-lod-seams/) — seams from inconsistent transformations rather than precision
- [Tracking Down Z-Fighting Between Terrain and Buildings](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracking-down-z-fighting-between-terrain-and-buildings/) — the depth-buffer relative of this problem
- [Transforming IFC Coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/) — doing the re-centring as part of BIM ingestion

Back to [Cross-Section Failure Modes in Digital Twins](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/).
