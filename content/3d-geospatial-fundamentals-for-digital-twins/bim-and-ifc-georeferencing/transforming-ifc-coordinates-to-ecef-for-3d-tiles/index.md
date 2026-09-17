# Transforming IFC Coordinates to ECEF for 3D Tiles

This page takes the geometry of an IFC building that is already placed in a projected CRS — EPSG:25832 with DHHN2016 heights in the running example — and turns it into a 3D Tiles 1.1 tileset: vertices stored as float32 in a local east-north-up frame, a root `transform` that places that frame on the WGS84 ellipsoid in ECEF (EPSG:4978), glTF axes that survive the y-up convention, and a round-trip check that proves a corner lands on its surveyed coordinate.

## Why you hit this

Reading `IfcMapConversion` gets the building onto the map, but a map is not what a Cesium or deck.gl viewer consumes. Tilesets live in Earth-centred Cartesian coordinates whose magnitudes are around six million metres, and a glTF vertex buffer is float32 with seven significant digits. Write ECEF directly into the buffer and every vertex snaps to a grid about half a metre across. The fix is standard — local coordinates plus a transform — and still goes wrong in three predictable places: the vertical datum, the axis convention and the direction of the matrix. Reading the parameters is covered in [reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/).

## Prerequisites

- `pyproj>=3.6` on PROJ 9.3+ with the German geoid grid `de_bkg_gcg2016.tif` available (network grids or a local copy); `numpy>=1.24`; `trimesh>=4.0`.
- The building's vertices as a float64 array of easting, northing and orthometric height in EPSG:25832+7837 — the output of step 4 in [BIM and IFC georeferencing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
- Familiarity with the frames in [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/); this page applies them to BIM output rather than re-deriving them.

## Step-by-Step

### 1. Pick the local origin and convert it to geodetic and ECEF

```python
import numpy as np
from pyproj import Transformer

SRC = "EPSG:25832+7837"          # ETRS89 / UTM 32N + DHHN2016 height
enh = np.load("clinic_block_c_enh.npy")           # (n, 3) float64, metres

lo, hi = enh.min(axis=0), enh.max(axis=0)
origin_enh = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])   # ground level, not mid-height

to_geodetic = Transformer.from_crs(SRC, "EPSG:4979", always_xy=True)       # lon, lat, ellipsoidal h
to_ecef = Transformer.from_crs(SRC, "EPSG:4978", always_xy=True)

lon0, lat0, h0 = to_geodetic.transform(*origin_enh)
x0, y0, z0 = to_ecef.transform(*origin_enh)
print(f"origin lon {lon0:.8f} lat {lat0:.8f} h_ell {h0:.3f} | "
      f"orthometric {origin_enh[2]:.3f} → geoid N ≈ {h0 - origin_enh[2]:.3f} m")
```

The printed geoid separation is the first check. Around Munich it should be close to 47.5 m. A value of 0.000 means PROJ did not find the geoid grid and silently treated DHHN2016 heights as ellipsoidal — every building in the twin will sink into the terrain by the same 47 m, and nothing downstream raises an error. Put the origin at the base of the building rather than its centroid so that the up axis of the local frame is measured from ground level, which keeps storey heights readable when debugging vertex values.

### 2. Build the east-north-up to ECEF matrix

```python
def enu_to_ecef_matrix(lon_deg, lat_deg, x0, y0, z0):
    lam, phi = np.radians(lon_deg), np.radians(lat_deg)
    east = np.array([-np.sin(lam), np.cos(lam), 0.0])
    north = np.array([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
    up = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = east, north, up, (x0, y0, z0)
    return m

M = enu_to_ecef_matrix(lon0, lat0, x0, y0, z0)
tileset_transform = M.T.flatten().tolist()     # 3D Tiles stores column-major
```

`M` maps a local point to ECEF: `ecef = M @ [e, n, u, 1]`. The tileset stores the sixteen numbers in column-major order, so the row-major numpy array is transposed before flattening. The easy mistake is flattening `M` directly; the result is a matrix whose translation sits in the bottom row, which Cesium reads as a projective term and renders as nothing at all.

<figure class="diagram">
<svg viewBox="6 26 748 248" role="img" aria-labelledby="ifce-frames-t ifce-frames-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifce-frames-t">Three frames between the IFC model and the viewer</title>
  <desc id="ifce-frames-d">Projected easting, northing and orthometric height are converted by PROJ, with the geoid, into Earth-centred coordinates. A local east-north-up frame at the building base holds small float32 vertices, and the tileset transform matrix maps that frame back into Earth-centred coordinates at render time.</desc>
  <rect class="svg-bg" x="6" y="26" width="748" height="248" fill="#ffffff"/>
  <defs>
    <marker id="ifce-frames-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="40" width="200" height="80" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="280" y="40" width="200" height="80" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="540" y="40" width="200" height="80" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="280" y="170" width="200" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ifce-frames-arrow)">
    <path d="M220 80 H278"/>
    <path d="M480 80 H538"/>
    <path d="M640 121 C640 190 560 198 482 198"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="66">EPSG:25832+7837</text>
    <text x="120" y="86">E, N, orthometric H</text>
    <text x="120" y="104">float64, ~5×10⁶ m</text>
    <text x="380" y="66">EPSG:4978 ECEF</text>
    <text x="380" y="86">X, Y, Z</text>
    <text x="380" y="104">float64, ~6×10⁶ m</text>
    <text x="640" y="66">local ENU at base</text>
    <text x="640" y="86">e, n, u</text>
    <text x="640" y="104">float32, &lt; 200 m</text>
    <text x="380" y="194">tileset transform M</text>
    <text x="380" y="212">ENU → ECEF at render</text>
  </g>
  <text x="250" y="70" fill="#5b6471" font-size="11" text-anchor="middle">PROJ</text>
  <text x="380" y="256" fill="#15384a" font-size="12.5" text-anchor="middle">Only the right-hand frame is written into the vertex buffer.</text>
</svg>
<figcaption>Large coordinates stay in float64 until the last moment; the buffer holds small local values and the matrix carries the placement.</figcaption>
</figure>

### 3. Express every vertex in the local frame

```python
ecef = np.column_stack(to_ecef.transform(enh[:, 0], enh[:, 1], enh[:, 2]))
M_inv = np.linalg.inv(M)
local = (M_inv @ np.column_stack([ecef, np.ones(len(ecef))]).T).T[:, :3]

print("local extent (m):", (local.max(0) - local.min(0)).round(3))
local32 = local.astype(np.float32)
err = np.abs(local32.astype(np.float64) - local).max()
print(f"float32 quantisation error: {err * 1000:.3f} mm")
assert err < 0.001, "local frame too large for float32 at millimetre precision"
```

Going through ECEF and back through the inverse matrix, rather than subtracting eastings and northings from the origin, is deliberate. A projected CRS has scale distortion and grid convergence, so easting differences are not east-west distances on the ground — at the edge of a UTM zone they differ by several centimetres per hundred metres and are rotated by up to three degrees. The ECEF route puts every vertex in a true tangent-plane frame, which is what the tileset transform assumes.

### 4. Swap to glTF's y-up axes and write the content

3D Tiles applies a fixed y-up to z-up rotation to glTF content, so the buffer has to be written in glTF's convention.

```python
import trimesh

faces = np.load("clinic_block_c_faces.npy")            # (m, 3) int
gltf_vertices = np.column_stack([local32[:, 0], local32[:, 2], -local32[:, 1]])   # (e, u, -n)

mesh = trimesh.Trimesh(vertices=gltf_vertices, faces=faces, process=False)
mesh.export("tiles/clinic_block_c.glb")
```

The mapping `(e, n, u) → (e, u, −n)` is the inverse of the runtime rotation, which takes glTF `(x, y, z)` to `(x, −z, y)`. Getting the sign of the third component wrong mirrors the building north-south: the footprint still fits its bounding box, every wall is in a plausible place, and the entrance faces the wrong street.

<figure class="diagram">
<svg viewBox="6 6 748 238" role="img" aria-labelledby="ifce-axes-t ifce-axes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifce-axes-t">Local ENU axes against glTF axes</title>
  <desc id="ifce-axes-d">On the left, the local frame has east as x, north as y and up as z. On the right, glTF stores east as x, up as y and south as z. The runtime rotation maps glTF back to east, north, up, so writing the third component as minus north is what keeps the building from mirroring.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="238" fill="#ffffff"/>
  <defs>
    <marker id="ifce-axes-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="300" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="440" y="20" width="300" height="180" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#1f2937" stroke-width="2.5" fill="none" marker-end="url(#ifce-axes-arrow)">
    <path d="M120 150 H240"/>
    <path d="M120 150 L180 100"/>
    <path d="M120 150 V50"/>
    <path d="M540 150 H660"/>
    <path d="M540 150 V50"/>
    <path d="M540 150 L480 190"/>
  </g>
  <path d="M322 110 H438" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#ifce-axes-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="255" y="146">x = e</text>
    <text x="215" y="96">y = n</text>
    <text x="150" y="48">z = u</text>
    <text x="690" y="146">x = e</text>
    <text x="580" y="48">y = u</text>
    <text x="600" y="186">z = −n</text>
  </g>
  <text x="380" y="100" fill="#5b6471" font-size="11.5" text-anchor="middle">write</text>
  <text x="170" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">local ENU, z-up</text>
  <text x="590" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">glTF buffer, y-up</text>
</svg>
<figcaption>glTF's positive z points south in this frame. The minus sign is the entire difference between a correct building and its mirror image.</figcaption>
</figure>

### 5. Write the tileset with the transform and a local bounding box

```python
import json

centre = (local.max(0) + local.min(0)) / 2
half = (local.max(0) - local.min(0)) / 2

tileset = {
    "asset": {"version": "1.1", "tilesetVersion": "clinic-c-r07"},
    "geometricError": 60.0,
    "root": {
        "transform": tileset_transform,
        "boundingVolume": {"box": [*centre.tolist(),
                                   half[0], 0, 0,
                                   0, half[1], 0,
                                   0, 0, half[2]]},
        "geometricError": 0.0,
        "refine": "REPLACE",
        "content": {"uri": "clinic_block_c.glb"},
    },
}
with open("tiles/tileset.json", "w") as f:
    json.dump(tileset, f, indent=2)
```

The bounding box is expressed in the local frame because the root `transform` applies to it. A box computed in ECEF and then placed under a transform ends up six million metres from the geometry, which culls the tile permanently — Cesium never requests content whose bounding volume is never in view.

## Expected Output & Verification

```text
origin lon 11.57302155 lat 48.13811904 h_ell 566.912 | orthometric 519.310 → geoid N ≈ 47.602 m
local extent (m): [ 86.414  54.093  38.650]
float32 quantisation error: 0.004 mm
```

Then close the loop: take a surveyed corner through the entire chain and back, independently of the matrix you wrote.

```python
from pyproj import Transformer

corner_enh = np.array([691204.412, 5335818.221, 519.31])        # surveyed, EPSG:25832+7837
corner_local = local[np.argmin(np.linalg.norm(enh - corner_enh, axis=1))]

# Independent route: PROJ's own topocentric conversion around the same ECEF origin
topo = Transformer.from_pipeline(
    f"+proj=pipeline +step +proj=unitconvert +xy_in=deg +xy_out=rad "
    f"+step +proj=cart +ellps=GRS80 "
    f"+step +proj=topocentric +ellps=GRS80 +X_0={x0} +Y_0={y0} +Z_0={z0}"
)
cx, cy, cz = to_ecef.transform(*corner_enh)
lon_c, lat_c, h_c = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True).transform(cx, cy, cz)
e_ref, n_ref, u_ref = topo.transform(lon_c, lat_c, h_c)

diff = corner_local - np.array([e_ref, n_ref, u_ref])
print("matrix vs PROJ topocentric (mm):", (diff * 1000).round(2))
assert np.abs(diff).max() < 0.002
```

Agreement to a millimetre or two between your matrix and PROJ's `topocentric` operation proves the axis order, the column-major flattening and the origin all at once, because a mistake in any of them produces an error of metres, not millimetres.

<figure class="diagram">
<svg viewBox="6 6 748 204" role="img" aria-labelledby="ifce-loop-t ifce-loop-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ifce-loop-t">Two independent routes to the same local coordinate</title>
  <desc id="ifce-loop-d">A surveyed corner goes to ECEF with PROJ. One route applies the inverse of the hand-built tileset matrix; the other applies PROJ's topocentric conversion around the same origin. The two local coordinates must agree to within two millimetres.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="204" fill="#ffffff"/>
  <defs>
    <marker id="ifce-loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="80" width="150" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="210" y="80" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="380" y="20" width="200" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="380" y="140" width="200" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="620" y="80" width="120" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ifce-loop-arrow)">
    <path d="M170 108 H208"/>
    <path d="M330 98 L378 52"/>
    <path d="M330 118 L378 164"/>
    <path d="M580 48 L618 96"/>
    <path d="M580 168 L618 122"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="104">surveyed corner</text>
    <text x="95" y="122">EPSG:25832+7837</text>
    <text x="270" y="104">ECEF</text>
    <text x="270" y="122">EPSG:4978</text>
    <text x="480" y="44">inverse of your M</text>
    <text x="480" y="62">hand-built</text>
    <text x="480" y="164">+proj=topocentric</text>
    <text x="480" y="182">PROJ's own</text>
    <text x="680" y="104">agree</text>
    <text x="680" y="122">≤ 2 mm</text>
  </g>
</svg>
<figcaption>The test pits the matrix you wrote against one you did not, so a transposed matrix or a swapped axis cannot pass by agreeing with itself.</figcaption>
</figure>

## Common Errors

**The building is 47 m underground in the viewer.** PROJ could not load `de_bkg_gcg2016.tif` and fell back to a ballpark vertical transformation. Run `projinfo -s EPSG:25832+7837 -t EPSG:4979 --spatial-test intersects` and confirm the chosen operation names the grid; enable `PROJ_NETWORK=ON` or install the grid locally.

**Nothing renders and no error appears.** The transform was flattened row-major, or the bounding box was written in ECEF. Load the tileset in a validator — see [writing 3D Tiles validator checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — and inspect whether `transform[15]` is 1 and `transform[12:15]` holds the ECEF origin.

**Walls shimmer when the camera moves close.** The vertex buffer holds values in the millions: the local conversion was skipped for part of the geometry, often elements appended after step 3. Assert the extent of every buffer before export, not just the first.

## Frequently Asked Questions

### Should I use the RTC_CENTER / CESIUM_RTC approach instead of a transform?

For new 3D Tiles 1.1 content, a tile `transform` is the standard mechanism and needs no extension. `CESIUM_RTC` was a glTF 1.0-era extension; it still loads in Cesium but other runtimes ignore it, so a transform is the portable choice.

### Can one transform cover a whole campus of buildings?

Yes, within a few kilometres. Beyond that, the tangent plane departs from the ellipsoid by tens of centimetres at the edges and float32 precision degrades; give each building or each tile its own origin.

### Do I need Draco or meshopt compression at this stage?

Not for correctness. Compress after the round-trip check passes, so a quantisation setting can never be confused with a transformation error — the order is covered in [tuning Draco quantization for building meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/).

## Related Guides

- [Reading IfcMapConversion with IfcOpenShell](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/reading-ifcmapconversion-with-ifcopenshell/) — where the projected coordinates came from
- [ECEF and ENU Frames for Tileset Transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/) — the frame mathematics in depth
- [Resolving Float32 Precision Jitter in Large-Coordinate Meshes](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/resolving-float32-precision-jitter-in-large-coordinate-meshes/) — what happens when this step is skipped

Back to [BIM and IFC Georeferencing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/).
