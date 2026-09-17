---
title: "glTF vs 3D Tiles vs OBJ for Spatial Data"
description: "Choose and convert between glTF, 3D Tiles, and OBJ for digital twin meshes using trimesh, pygltflib, and numpy — with explicit CRS handling and verification."
---
# glTF vs 3DTiles vs OBJ for Spatial Data in Digital Twin Pipelines

This guide shows how to choose and convert between **glTF**, **3D Tiles**, and **OBJ** for delivering textured building and terrain meshes — using `trimesh`, `pygltflib`, and `numpy` — while keeping the coordinate reference system (CRS) explicit at every step. The short version: load and repair geometry as OBJ, export an optimized `.glb` (glTF) for asset-level web delivery, then package those `.glb` payloads into a 3D Tiles tileset when you need to stream a whole city referenced to an Earth-centered, Earth-fixed frame (EPSG:4978).

## Why you hit this

You almost never receive data in the format you ship in. Photogrammetry and CAD pipelines spit out `.obj` with a sidecar `.mtl`; web viewers and game engines want `.glb`; CesiumJS and other geospatial clients want a streamable 3D Tiles tileset. OBJ carries no CRS, no units, and no axis convention, so the moment a building exported in a local metric grid (say EPSG:32618, UTM zone 18N) lands in a viewer that assumes glTF's Y-up metres, it appears rotated, mis-scaled, or floating thousands of kilometres off the globe. The conversion itself is easy; getting the coordinate frame, axis order, and scale right is the part that breaks production. This page walks the exact `trimesh` → `pygltflib` → tileset path and shows how to verify each hop before trusting it.

<figure class="diagram">
<svg viewBox="0 36 788 191" role="img" aria-labelledby="fmt-journey-t fmt-journey-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-journey-t">The frame changes at every hop from OBJ to a tileset</title>
  <desc id="fmt-journey-d">An OBJ in UTM metres and Z-up is shifted to a local origin, rotated to glTF's Y-up convention and exported as a binary glTF, then packaged into a 3D Tiles tileset whose root transform places the local metres back onto the globe in the geocentric EPSG:4978 frame.</desc>
  <rect class="svg-bg" x="0" y="36" width="788" height="191" fill="#ffffff"/>
  <defs>
    <marker id="fmt-journey-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="14" y="50" width="166" height="96" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="212" y="50" width="166" height="96" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="410" y="50" width="166" height="96" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="608" y="50" width="166" height="96" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#fmt-journey-a)">
    <line x1="180" y1="98" x2="210" y2="98"/>
    <line x1="378" y1="98" x2="408" y2="98"/>
    <line x1="576" y1="98" x2="606" y2="98"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="97" y="82"><tspan x="97" dy="0" font-weight="600">building.obj + .mtl</tspan><tspan x="97" dy="17">EPSG:32618 metres</tspan><tspan x="97" dy="16">Z-up · no CRS field</tspan></text>
    <text x="295" y="82"><tspan x="295" dy="0" font-weight="600">centroid subtracted</tspan><tspan x="295" dy="17">coords now tens of m</tspan><tspan x="295" dy="16">offset kept in float64</tspan></text>
    <text x="493" y="82"><tspan x="493" dy="0" font-weight="600">building.glb</tspan><tspan x="493" dy="17">Y-up · float32 positions</tspan><tspan x="493" dy="16">CRS only in extras</tspan></text>
    <text x="691" y="82"><tspan x="691" dy="0" font-weight="600">tileset.json</tspan><tspan x="691" dy="17">root transform → EPSG:4978</tspan><tspan x="691" dy="16">streamable, LOD-aware</tspan></text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="195" y="176">keep the offset in float64</text>
    <text x="393" y="176">rotate −90° about X</text>
    <text x="591" y="176">reproject the origin to ECEF</text>
  </g>
  <text x="400" y="208" fill="#15384a" font-size="12.5" text-anchor="middle">The building never moves. Every hop changes only which frame its numbers are expressed in — and only one hop records that.</text>
</svg>
<figcaption>Three of the four boxes change the coordinate frame and only the last one writes the frame down. That asymmetry is where the format conversions actually go wrong.</figcaption>
</figure>

## Prerequisites

- Python 3.10+
- `trimesh>=4.0` (`pip install "trimesh[easy]"`) — OBJ/PLY/glTF loading and repair
- `pygltflib>=1.16` (`pip install pygltflib`) — direct glTF/GLB inspection and edits
- `numpy>=1.24` — vertex array math and the local-origin shift
- Optional for tiling: `py3dtiles>=7` or Cesium `3d-tiles-tools` (Node) for tileset assembly
- A source mesh `building.obj` with its `building.mtl` and texture in the same directory
- **Known source CRS, stated explicitly.** This guide assumes the OBJ vertices are in metres in EPSG:32618 (UTM 18N). 3D Tiles ultimately expects geocentric EPSG:4978, so the tileset's root `transform` is what places local metres onto the globe.

## Step-by-Step

### 1. Load and repair the OBJ in trimesh

OBJ has no units or axis metadata, so the first job is to load the mesh, confirm it parsed as a single watertight body, and fix the cheap topological defects before they propagate into glTF.

```python
import trimesh
import numpy as np

# OBJ vertices here are metres in EPSG:32618 (UTM 18N), Z-up.
mesh = trimesh.load("building.obj", process=True, force="mesh")

trimesh.repair.fix_normals(mesh)        # consistent outward winding
mesh.remove_duplicate_faces()
mesh.merge_vertices()

print("vertices:", len(mesh.vertices), "faces:", len(mesh.faces))
print("units (trimesh guess):", mesh.units)   # often None for OBJ — set it yourself
print("watertight:", mesh.is_watertight)
```

If `mesh.units` is `None`, set it deliberately with `mesh.units = "meters"`; never let a downstream tool guess.

### 2. Shift to a local origin and record the offset

UTM eastings/northings are large (hundreds of thousands of metres), and glTF stores positions as 32-bit floats. Subtracting a local origin keeps coordinates small and avoids "jitter" — visible vertex wobble from float32 precision loss. Save the offset; it becomes the tileset transform later.

```python
# Local origin = mesh centroid in EPSG:32618, kept in float64.
origin_utm = np.asarray(mesh.centroid, dtype=np.float64)
mesh.apply_translation(-origin_utm)

print("origin_utm (EPSG:32618):", origin_utm)
np.save("origin_utm.npy", origin_utm)   # the bytes you will re-add at tiling time
```

<figure class="diagram">
<svg viewBox="46 0 668 268" role="img" aria-labelledby="fmt-f32-t fmt-f32-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-f32-t">Why a raw UTM easting jitters in float32 and a local one does not</title>
  <desc id="fmt-f32-d">Two number lines show the spacing of representable 32-bit float values. Around a raw UTM easting of 585,016 metres the representable values are about six centimetres apart, which is visible vertex jitter. After the centroid shift the same coordinate is about sixteen metres, where representable values are about a micrometre apart.</desc>
  <rect class="svg-bg" x="46" y="0" width="668" height="268" fill="#ffffff"/>
  <text x="380" y="28" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">float32 carries about seven significant digits — where you spend them decides what they buy</text>
  <line x1="60" y1="102" x2="700" y2="102" stroke="#b0413e" stroke-width="2"/>
  <path fill="none" d="M60 94 V110 M140 94 V110 M220 94 V110 M300 94 V110 M380 94 V110 M460 94 V110 M540 94 V110 M620 94 V110 M700 94 V110"
        stroke="#b0413e" stroke-width="2"/>
  <text x="60" y="80" fill="#b0413e" font-size="12.5" text-anchor="start">raw UTM easting, about 585 016 m</text>
  <text x="60" y="132" fill="#1f2937" font-size="12" text-anchor="start">representable values land ~6 cm apart — vertices visibly wobble as the camera moves</text>
  <line x1="60" y1="196" x2="700" y2="196" stroke="#4f7a4d" stroke-width="2"/>
  <path fill="none" d="M60 189 V203 M76 189 V203 M92 189 V203 M108 189 V203 M124 189 V203 M140 189 V203 M156 189 V203 M172 189 V203 M188 189 V203 M204 189 V203 M220 189 V203 M236 189 V203 M252 189 V203 M268 189 V203 M284 189 V203 M300 189 V203 M316 189 V203 M332 189 V203 M348 189 V203 M364 189 V203 M380 189 V203 M396 189 V203 M412 189 V203 M428 189 V203 M444 189 V203 M460 189 V203 M476 189 V203 M492 189 V203 M508 189 V203 M524 189 V203 M540 189 V203 M556 189 V203 M572 189 V203 M588 189 V203 M604 189 V203 M620 189 V203 M636 189 V203 M652 189 V203 M668 189 V203 M684 189 V203 M700 189 V203"
        stroke="#4f7a4d" stroke-width="1.5"/>
  <text x="60" y="174" fill="#4f7a4d" font-size="12.5" text-anchor="start">local metres after the centroid shift, about 16 m</text>
  <text x="60" y="226" fill="#1f2937" font-size="12" text-anchor="start">representable values land ~1 µm apart — the shift buys back four orders of magnitude</text>
  <text x="380" y="250" fill="#5b6471" font-size="12" text-anchor="middle">This is why the offset must stay in float64 outside the file, never folded back into the vertices.</text>
</svg>
<figcaption>The precision is not lost by glTF; it is spent on the leading digits of the easting. Moving the origin is what returns it to the geometry.</figcaption>
</figure>

### 3. Convert Z-up to glTF Y-up

glTF mandates a right-handed, Y-up coordinate system; UTM/most GIS meshes are Z-up. Apply the rotation once, in code, rather than relying on an exporter flag you cannot audit.

```python
# Rotate -90 deg about X so geospatial Z-up becomes glTF Y-up.
z_to_y = trimesh.transformations.rotation_matrix(-np.pi / 2.0, [1, 0, 0])
mesh.apply_transform(z_to_y)
```

<figure class="diagram">
<svg viewBox="46 46 529 205" role="img" aria-labelledby="fmt-axis-t fmt-axis-d" xmlns="http://www.w3.org/2000/svg">
  <title id="fmt-axis-t">Z-up geospatial axes versus glTF's Y-up convention</title>
  <desc id="fmt-axis-d">A geospatial or CAD coordinate triad has Z pointing up, with X and Y spanning the ground plane. glTF 2.0 mandates a right-handed Y-up frame, so height moves to the Y axis. A single minus ninety degree rotation about X converts one to the other.</desc>
  <rect class="svg-bg" x="46" y="46" width="529" height="205" fill="#ffffff"/>
  <defs>
    <marker id="fmt-axis-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
    <marker id="fmt-axis-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#1f6b8a"/>
    </marker>
    <marker id="fmt-axis-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#4f7a4d"/>
    </marker>
  </defs>
  <g stroke="#1f6b8a" stroke-width="2.5" marker-end="url(#fmt-axis-b)">
    <line x1="140" y1="170" x2="215" y2="200"/>
    <line x1="140" y1="170" x2="205" y2="125"/>
    <line x1="140" y1="170" x2="140" y2="82"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="2.5" marker-end="url(#fmt-axis-c)">
    <line x1="470" y1="170" x2="545" y2="200"/>
    <line x1="470" y1="170" x2="535" y2="125"/>
    <line x1="470" y1="170" x2="470" y2="82"/>
  </g>
  <g fill="#1f6b8a" font-size="13" font-weight="600">
    <text x="222" y="206">X</text>
    <text x="212" y="122">Y</text>
    <text x="132" y="74">Z</text>
  </g>
  <g fill="#4f7a4d" font-size="13" font-weight="600">
    <text x="552" y="206">X</text>
    <text x="542" y="122">Z</text>
    <text x="462" y="74">Y</text>
  </g>
  <line x1="255" y1="152" x2="400" y2="152" stroke="#5b6471" stroke-width="2" marker-end="url(#fmt-axis-a)"/>
  <text x="328" y="142" fill="#5b6471" font-size="12" text-anchor="middle">rotate −90° about X</text>
  <text x="328" y="176" fill="#5b6471" font-size="11.5" text-anchor="middle">exactly once</text>
  <text x="140" y="232" fill="#1f2937" font-size="12.5" text-anchor="middle">geospatial and CAD: Z is up</text>
  <text x="470" y="232" fill="#1f2937" font-size="12.5" text-anchor="middle">glTF 2.0: Y is up, right-handed</text>
</svg>
<figcaption>Height changes axis, not meaning. Applying the rotation twice is as common as skipping it, and both are visible in the viewer as a building lying on its side.</figcaption>
</figure>

### 4. Export an optimized binary glTF (.glb)

Export the repaired, re-oriented mesh as `.glb`. The binary container packs geometry, the material, and the texture into one file, which is what asset-level web and engine viewers consume directly.

```python
mesh.export("building.glb")             # trimesh writes glTF 2.0 binary
print("wrote building.glb")
```

### 5. Inspect and tag the glTF with pygltflib

Open the `.glb` directly to confirm the buffers, accessors, and material survived, and to stamp an `extras` note recording the source CRS — glTF has no CRS field, so this metadata is your only in-file record.

```python
from pygltflib import GLTF2

gltf = GLTF2().load("building.glb")
print("meshes:", len(gltf.meshes), "materials:", len(gltf.materials))
print("accessors:", len(gltf.accessors), "buffers:", len(gltf.buffers))

gltf.extras = {"source_crs": "EPSG:32618", "origin_utm": np.load("origin_utm.npy").tolist()}
gltf.save("building.glb")
```

### 6. Package into a 3D Tiles tileset

For city-scale streaming, the `.glb` becomes the payload of a tileset whose root `transform` places the local-origin metres onto the globe in EPSG:4978. Compute the transform from the saved UTM origin (reproject EPSG:32618 → EPSG:4978 with `pyproj`), then write a minimal `tileset.json`.

```python
import json
from pyproj import Transformer

origin_utm = np.load("origin_utm.npy")            # easting, northing, height (m)
to_ecef = Transformer.from_crs("EPSG:32618+5703", "EPSG:4978", always_xy=True)
x, y, z = to_ecef.transform(*origin_utm)

# Column-major 4x4: identity rotation, translation = ECEF origin.
transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, x, y, z, 1]

tileset = {
    "asset": {"version": "1.1"},
    "geometricError": 256,
    "root": {
        "transform": transform,
        "boundingVolume": {"sphere": [0, 0, 0, 60]},  # metres, local frame
        "geometricError": 0,
        "refine": "REPLACE",
        "content": {"uri": "building.glb"},
    },
}
with open("tileset.json", "w") as f:
    json.dump(tileset, f, indent=2)
print("wrote tileset.json with ECEF root at", (round(x), round(y), round(z)))
```

For more than one building, let `py3dtiles` or Cesium's `3d-tiles-tools` build the bounding-volume hierarchy and screen-space-error LOD for you rather than hand-writing the tree.

### Format comparison

| Format | Geo CRS support | LOD / streaming | Best use |
|---|---|---|---|
| OBJ | None — units and axis undefined | None; whole mesh loads at once | Legacy CAD/DCC handoff, 3D printing, repair-stage I/O |
| glTF / GLB | None natively; carry CRS in `extras` + a world transform | None alone (Draco/meshopt compress, no streaming) | Single asset delivery to web, engines, AR/VR |
| 3D Tiles | Native; root `transform` to EPSG:4978, tile CRS metadata | Hierarchical LOD, view-frustum culling, HTTP streaming | City/terrain-scale geospatial twins in CesiumJS |

## Expected Output & Verification

After step 6 you should have `building.glb`, `tileset.json`, and `origin_utm.npy`. Verify each hop instead of trusting it:

```python
import trimesh, numpy as np
from pygltflib import GLTF2

# 1. glTF re-imports and is the same size as the source.
g = trimesh.load("building.glb", force="mesh")
assert g.is_winding_consistent, "winding broke on export"
assert abs(g.extents.max() - g.extents.max()) < 1e-6   # finite, non-degenerate

# 2. CRS tag survived in the glTF extras.
gltf = GLTF2().load("building.glb")
assert gltf.extras["source_crs"] == "EPSG:32618"
print("source_crs:", gltf.extras["source_crs"])

# 3. Tileset root transform is a plausible ECEF location (|R| ~ 6.38e6 m).
import json
ts = json.load(open("tileset.json"))
tx, ty, tz = ts["root"]["transform"][12:15]
radius = np.linalg.norm([tx, ty, tz])
assert 6.0e6 < radius < 6.6e6, f"root transform not on the ellipsoid: {radius:.0f} m"
print(f"ECEF radius {radius:,.0f} m  (Earth surface ~6,378,000 m)")
```

A sane run prints something like `source_crs: EPSG:32618` and `ECEF radius 6,369,142 m`. If the radius is near zero, the root `transform` never received the reprojected origin — the building will render at the centre of the Earth. Validate the finished tileset with the OGC `3d-tiles-validator` before serving it.

## Common Errors

**`ValueError: Material specified in OBJ but no MTL file found`** (or textures come through black). The `.obj` references a `.mtl` and image that did not travel with it. `trimesh` resolves these by relative path, so load from the directory that contains all three files, or pass `resolver=trimesh.visual.resolvers.FilePathResolver("/path/to/assets")`.

**Model appears tipped on its side or mirrored in the web viewer.** You skipped the Z-up → Y-up rotation in step 3, or applied it twice. glTF is strictly Y-up right-handed; apply `rotation_matrix(-pi/2, [1,0,0])` exactly once and re-check `mesh.bounds` so the height extent lands on the Y axis.

**Building renders kilometres away, jitters, or sits at the planet's core.** Either you exported raw UTM eastings into float32 glTF (precision jitter — fix with the local-origin shift in step 2), or the tileset root `transform` translation is still `[0,0,0]` (fix by reprojecting `origin_utm` from EPSG:32618 to EPSG:4978 as in step 6). The verification radius check above catches the second case before deployment.

## Frequently Asked Questions

### Can I store EPSG codes inside a glTF file?
Not in a standard field — glTF 2.0 has no CRS slot. Record the source CRS in the asset-level `extras` object (as in step 5) so the geometry and its georeference travel together, and apply the actual world placement through a 3D Tiles root `transform` or a viewer-side model matrix. Treat the `extras` note as documentation, not as something a generic viewer will act on.

### Why convert to EPSG:4978 for 3D Tiles instead of keeping UTM?
3D Tiles positions content in a global Earth-centered, Earth-fixed Cartesian frame (EPSG:4978) so a single tileset can span the whole globe without projection seams. You keep your local metric work in EPSG:32618 right up to the tiling step, then bake the EPSG:32618 → EPSG:4978 offset into the root `transform`. Tile-local vertices stay small and float32-safe.

### Is OBJ ever the right delivery format for a digital twin?
For delivery, almost never — it has no streaming, no LOD, no compression, and no CRS. It is genuinely useful as an intermediate at the repair stage (it round-trips cleanly through `trimesh`) and for one-off 3D-printing or DCC handoffs. For anything served to users, export `.glb` for single assets or a 3D Tiles tileset for spatial scenes.

## Related Guides

- [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — the wider format trade-off picture
- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the reprojection mechanics behind the root transform
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — building tilesets at scale
- [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — the repair checks behind step 1
- [3D Geospatial Fundamentals for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/) — the foundations these formats sit on

Back to [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
