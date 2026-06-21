# glTF vs 3DTiles vs OBJ for Spatial Data in Digital Twin Pipelines

This guide shows how to choose and convert between **glTF**, **3D Tiles**, and **OBJ** for delivering textured building and terrain meshes — using `trimesh`, `pygltflib`, and `numpy` — while keeping the coordinate reference system (CRS) explicit at every step. The short version: load and repair geometry as OBJ, export an optimized `.glb` (glTF) for asset-level web delivery, then package those `.glb` payloads into a 3D Tiles tileset when you need to stream a whole city referenced to an Earth-centered, Earth-fixed frame (EPSG:4978).

## Why you hit this

You almost never receive data in the format you ship in. Photogrammetry and CAD pipelines spit out `.obj` with a sidecar `.mtl`; web viewers and game engines want `.glb`; CesiumJS and other geospatial clients want a streamable 3D Tiles tileset. OBJ carries no CRS, no units, and no axis convention, so the moment a building exported in a local metric grid (say EPSG:32618, UTM zone 18N) lands in a viewer that assumes glTF's Y-up metres, it appears rotated, mis-scaled, or floating thousands of kilometres off the globe. The conversion itself is easy; getting the coordinate frame, axis order, and scale right is the part that breaks production. This page walks the exact `trimesh` → `pygltflib` → tileset path and shows how to verify each hop before trusting it.

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

### 3. Convert Z-up to glTF Y-up

glTF mandates a right-handed, Y-up coordinate system; UTM/most GIS meshes are Z-up. Apply the rotation once, in code, rather than relying on an exporter flag you cannot audit.

```python
# Rotate -90 deg about X so geospatial Z-up becomes glTF Y-up.
z_to_y = trimesh.transformations.rotation_matrix(-np.pi / 2.0, [1, 0, 0])
mesh.apply_transform(z_to_y)
```

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

- [3D Format Standards Comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — the wider format trade-off picture
- [Converting WGS84 to Local Projected Coordinates](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the reprojection mechanics behind the root transform
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — building tilesets at scale
- [Mesh Topology Basics for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — the repair checks behind step 1
- [3D Geospatial Fundamentals for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/) — the foundations these formats sit on

Back to [3D Format Standards Comparison](/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
