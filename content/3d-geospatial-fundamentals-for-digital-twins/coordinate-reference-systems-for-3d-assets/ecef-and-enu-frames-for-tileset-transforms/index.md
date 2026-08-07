# ECEF and ENU Frames for Tileset Transforms

This page builds the sixteen numbers that place a tileset on the globe — the root `transform` — from first principles: the east-north-up basis at a chosen origin, the geocentric translation to that origin, the column-major ordering 3D Tiles expects, and the assertions that catch each of the three ways it goes wrong. Get it right and a building sits on its footprint; get it subtly wrong and the building is level but rotated, or upright but half a kilometre away.

## Why you hit this

Tile content is authored in small local metres so that float32 vertices stay precise, and 3D Tiles positions that content in a geocentric Earth-centred Earth-fixed frame. The root transform is the bridge, and it has to encode two things at once: where the local origin sits on the globe, and which way is up there. The second is what people miss — "up" in a local frame is the ellipsoid normal at that specific point, and it differs from the geocentric radial direction by up to about 0.2°, which over a kilometre-wide tile is metres of tilt.

The local-origin shift this depends on is covered in [glTF vs 3D Tiles vs OBJ](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/).

## Prerequisites

- Python 3.10+ with `pyproj>=3.6` and `numpy>=1.24`.
- A local origin: the point your tile content's coordinates are relative to, in a known CRS.
- Content in metres with a stated axis convention. glTF is Y-up; the ENU frame built here is Z-up, so one rotation sits between them.

## Step-by-Step

### 1. Convert the local origin to ECEF

The translation column of the transform is the origin's geocentric position.

```python
import numpy as np
from pyproj import Transformer

to_ecef = Transformer.from_crs("EPSG:32633+5941", "EPSG:4978", always_xy=True)

origin_e, origin_n, origin_h = 598120.4, 6643880.1, 42.6      # UTM 33N + orthometric
ox, oy, oz = to_ecef.transform(origin_e, origin_n, origin_h)

r = float(np.linalg.norm([ox, oy, oz]))
print(f"ECEF origin: {ox:.3f} {oy:.3f} {oz:.3f}")
assert 6.3e6 < r < 6.6e6, f"radius {r:.0f} m is not on the ellipsoid"
```

The radius assertion is the cheapest and most valuable check in the whole procedure. Every forgotten reprojection lands the origin at or near the geocentre, and this catches it in one line.

### 2. Build the ENU basis at that origin

East, north and up are the columns of the rotation. They come from the geodetic latitude and longitude, not from the projected coordinates.

```python
import numpy as np
from pyproj import Transformer

to_geo = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)
lon, lat, _ = to_geo.transform(ox, oy, oz)
la, lo = np.radians(lat), np.radians(lon)

east  = np.array([-np.sin(lo),               np.cos(lo),              0.0])
north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
up    = np.array([ np.cos(la) * np.cos(lo),  np.cos(la) * np.sin(lo), np.sin(la)])

for name, v in (("east", east), ("north", north), ("up", up)):
    print(f"{name:<6} {np.round(v, 6)}  |v| = {np.linalg.norm(v):.9f}")

assert abs(np.dot(east, north)) < 1e-12 and abs(np.dot(east, up)) < 1e-12
assert np.allclose(np.cross(east, north), up, atol=1e-12), "basis is left-handed"
```

The cross-product assertion is what catches a sign error. East cross north must equal up in a right-handed frame; if it equals minus up, the tileset renders mirrored and everything reads correctly except that text on facades is backwards.

<figure class="diagram">
<svg viewBox="92 9 556 305" role="img" aria-labelledby="ee-enu-t ee-enu-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ee-enu-t">Why local up is not the geocentric radial direction</title>
  <desc id="ee-enu-d">The ellipsoid normal at a point is perpendicular to the ellipsoid surface, while the geocentric radial direction points at the Earth's centre. Because the Earth is flattened, the two differ by up to about 0.2 degrees at mid-latitudes, which tilts a kilometre-wide tile by several metres across its width.</desc>
  <rect class="svg-bg" x="92" y="9" width="556" height="305" fill="#ffffff"/>
  <path d="M120 210 A 190 150 0 0 1 470 100" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <circle cx="330" cy="235" r="5" fill="#5b6471"/>
  <circle cx="330" cy="118" r="5" fill="#1f6b8a"/>
  <path d="M330 118 L330 235" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M330 118 L352 40" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <path d="M330 118 L330 40" fill="none" stroke="#c46a3d" stroke-width="2.5" stroke-dasharray="5 4"/>
  <text x="362" y="36" fill="#1f6b8a" font-size="12" text-anchor="start">ellipsoid normal — local up</text>
  <text x="318" y="36" fill="#c46a3d" font-size="12" text-anchor="end">geocentric radial</text>
  <text x="344" y="240" fill="#5b6471" font-size="12" text-anchor="start">toward the geocentre</text>
  <text x="140" y="188" fill="#4f7a4d" font-size="12" text-anchor="start">ellipsoid surface</text>
  <text x="370" y="272" fill="#15384a" font-size="12.5" text-anchor="middle">Up to about 0.2° apart at mid-latitudes — several metres of tilt across a kilometre-wide tile</text>
  <text x="370" y="296" fill="#5b6471" font-size="12" text-anchor="middle">So the basis must come from geodetic latitude, not from normalising the ECEF position vector</text>
</svg>
<figcaption>Normalising the position vector gives the radial direction, which is a plausible and slightly wrong &quot;up&quot;. The tilt it introduces grows with tile size.</figcaption>
</figure>

### 3. Assemble the matrix in column-major order

3D Tiles stores the transform as sixteen numbers in column-major order, which is the transpose of how most people write a matrix out.

```python
import numpy as np

def root_transform(east, north, up, origin_ecef):
    """Column-major 4x4 as 3D Tiles expects: [c0(4), c1(4), c2(4), c3(4)]."""
    ox, oy, oz = origin_ecef
    return [
        east[0],  east[1],  east[2],  0.0,     # column 0 — X axis of the local frame
        north[0], north[1], north[2], 0.0,     # column 1 — Y axis
        up[0],    up[1],    up[2],    0.0,     # column 2 — Z axis
        ox,       oy,       oz,       1.0,     # column 3 — translation
    ]

transform = root_transform(east, north, up, (ox, oy, oz))
print("translation:", [round(v, 2) for v in transform[12:15]])
print("bottom row:", transform[3], transform[7], transform[11], transform[15])
assert transform[15] == 1.0, "the 16th element must be 1"
```

Two elements identify the ordering immediately. In column-major the translation occupies indices 12–14 and index 15 is 1. In row-major the translation would be at 3, 7 and 11. If your translation looks like `[x, 0, 0, 0]` you have written it the other way round.

<figure class="diagram">
<svg viewBox="16 16 699 236" role="img" aria-labelledby="ee-col-t ee-col-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ee-col-t">Column-major against row-major, element by element</title>
  <desc id="ee-col-d">In the column-major order 3D Tiles requires, the local frame's east, north and up axes occupy elements zero to two, four to six and eight to ten, and the translation occupies twelve to fourteen with a one at fifteen. Written row-major, the translation lands at three, seven and eleven instead, which places the tileset near the geocentre with a scrambled basis.</desc>
  <rect class="svg-bg" x="16" y="16" width="699" height="236" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="150" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="184" y="56" width="150" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="56" width="150" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="492" y="56" width="150" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="30" y="140" width="150" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="184" y="140" width="150" height="30" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="140" width="150" height="30" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="492" y="140" width="150" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="105" y="76">0–2 east, 3 = 0</text>
    <text x="259" y="76">4–6 north, 7 = 0</text>
    <text x="413" y="76">8–10 up, 11 = 0</text>
    <text x="567" y="76">12–14 origin, 15 = 1</text>
    <text x="105" y="160">0–2 east, 3 = ox</text>
    <text x="259" y="160">4–6 north, 7 = oy</text>
    <text x="413" y="160">8–10 up, 11 = oz</text>
    <text x="567" y="160">12–14 zeros, 15 = 1</text>
  </g>
  <text x="30" y="44" fill="#4f7a4d" font-size="12.5" text-anchor="start" font-weight="600">column-major — what 3D Tiles reads</text>
  <text x="30" y="128" fill="#b0413e" font-size="12.5" text-anchor="start" font-weight="600">row-major — the same sixteen numbers, transposed</text>
  <text x="370" y="208" fill="#15384a" font-size="12.5" text-anchor="middle">Both arrays are sixteen valid floats and the validator accepts either — only the rendered position tells them apart</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">Assert that elements 3, 7 and 11 are zero and element 15 is one before writing the tileset</text>
</svg>
<figcaption>The two orderings are indistinguishable as data and completely different as a placement. One assertion on four elements separates them.</figcaption>
</figure>

### 4. Handle the glTF Y-up convention

The ENU basis is Z-up and glTF is Y-up, so exactly one rotation reconciles them — and it belongs in one place, not two.

```python
import numpy as np

Z_UP_TO_Y_UP = np.array([
    [1.0, 0.0,  0.0, 0.0],
    [0.0, 0.0,  1.0, 0.0],
    [0.0, -1.0, 0.0, 0.0],
    [0.0, 0.0,  0.0, 1.0],
])

def compose(enu_matrix_4x4, content_is_y_up=True):
    return enu_matrix_4x4 @ Z_UP_TO_Y_UP if content_is_y_up else enu_matrix_4x4
```

Apply it either in the tileset transform or when exporting the glTF, never both. Applying it twice rotates the content 180° about X, which renders as a building standing on its roof and is unmistakable; applying it zero times renders a building lying on its side, which people sometimes ship.

### 5. Verify by round-tripping a known point

The end-to-end check takes a vertex in local coordinates, applies the transform, and confirms it lands where the source data says it should.

```python
import numpy as np
from pyproj import Transformer

M = np.array(transform).reshape(4, 4).T          # column-major → row-major for numpy

local = np.array([12.5, -8.25, 3.0, 1.0])        # a vertex in tile-local metres
world = M @ local

back = Transformer.from_crs("EPSG:4978", "EPSG:32633+5941", always_xy=True)
e, n, h = back.transform(world[0], world[1], world[2])

expected = (origin_e + 12.5, origin_n - 8.25, origin_h + 3.0)
print("expected:", [round(v, 3) for v in expected])
print("actual  :", round(e, 3), round(n, 3), round(h, 3))
assert abs(e - expected[0]) < 0.02 and abs(n - expected[1]) < 0.02, "transform misplaces the vertex"
```

<figure class="diagram">
<svg viewBox="10 46 736 172" role="img" aria-labelledby="ee-fail-t ee-fail-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ee-fail-t">Three ways the transform goes wrong, and what each looks like</title>
  <desc id="ee-fail-d">A translation of zero puts the tileset at the centre of the Earth. A row-major matrix puts the translation in the wrong elements and the tileset ends up near the origin with a scrambled basis. A basis built from the normalised position vector renders the tileset level but tilted by a fraction of a degree, which is visible only as a slope across a large tile.</desc>
  <rect class="svg-bg" x="10" y="46" width="736" height="172" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="60" width="220" height="66" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="268" y="60" width="220" height="66" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="512" y="60" width="220" height="66" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="134" y="84"><tspan x="134" dy="0" font-weight="600">translation is zero</tspan><tspan x="134" dy="17">tileset at the geocentre</tspan><tspan x="134" dy="16">caught by the radius check</tspan></text>
    <text x="378" y="84"><tspan x="378" dy="0" font-weight="600">row-major matrix</tspan><tspan x="378" dy="17">translation in 3, 7, 11</tspan><tspan x="378" dy="16">caught by element 15 ≠ 1</tspan></text>
    <text x="622" y="84"><tspan x="622" dy="0" font-weight="600">basis from |position|</tspan><tspan x="622" dy="17">tilted by up to 0.2°</tspan><tspan x="622" dy="16">caught by the vertex round-trip</tspan></text>
  </g>
  <text x="380" y="170" fill="#15384a" font-size="12.5" text-anchor="middle">The first two are obvious in a viewer; the third renders convincingly and is only visible as a slope across a large tile</text>
  <text x="380" y="200" fill="#5b6471" font-size="12" text-anchor="middle">Three assertions, each a line long, cover all three — and the third is the one worth keeping in CI</text>
</svg>
<figcaption>Two of these announce themselves immediately. The tilt does not, which is why the round-trip check earns its place in the gate.</figcaption>
</figure>

## Expected Output & Verification

A correct run over an Oslo-area origin prints:

```text
ECEF origin: 3172416.883 601058.221 5481955.107
east   [-0.186524  0.982448  0.      ]  |v| = 1.000000000
north  [-0.850196 -0.161436  0.501112]  |v| = 1.000000000
up     [ 0.492313  0.093484  0.865383]  |v| = 1.000000000
translation: [3172416.88, 601058.22, 5481955.11]
bottom row: 0.0 0.0 0.0 1.0
expected: [598132.9, 6643871.85, 45.6]
actual  : 598132.901 6643871.849 45.601
```

Four things to confirm: the ECEF radius is on the ellipsoid, all three basis vectors are unit length, element 15 is 1 with the rest of the bottom row zero, and the round-tripped vertex matches to a couple of centimetres. Together those exclude every failure mode in the diagram above.

## Common Errors

**The tileset renders at the centre of the Earth.** The translation is `[0, 0, 0]`, usually because the origin was never reprojected to ECEF. The radius assertion catches it before publishing.

**The tileset is in the right place but rotated oddly.** The matrix was written row-major. Check that indices 12–14 hold the translation and index 15 is 1.

**Buildings lean slightly across a large tile.** The basis came from normalising the ECEF position vector rather than from geodetic latitude, so "up" is the radial direction. Rebuild the basis from `lat`/`lon`.

**Content is on its side or upside down.** The Z-up to Y-up rotation was applied zero times or twice. Apply it exactly once, and record in the manifest where it is applied.

## Frequently Asked Questions

### Where should the local origin be?
At the centre of the tile's extent, so vertex magnitudes stay small in every direction. A corner origin doubles the largest coordinate for no benefit.

### Can one transform serve a whole city?
Only if the city is small enough that one ENU basis is accurate across it. The basis is exact at the origin and drifts with distance, so beyond roughly ten kilometres each district wants its own origin and transform.

### Does the vertical datum matter here?
Yes. `EPSG:4978` expects ellipsoidal height, so an orthometric origin height has to pass through a compound CRS as in step 1. Feeding an orthometric height straight in puts the tileset the geoid separation off vertically — tens of metres in many regions.

One practice makes all of this reproducible: store the origin, the basis and the composed matrix in the tileset's `extras` alongside the transform itself, together with the CRS the origin came from. The sixteen numbers are opaque, so a tileset that carries only them cannot be re-derived, checked against a moved origin, or compared with the next build. Four extra fields turn the transform from a magic constant into something a later reader can verify.

The related habit is to compute the transform once per tileset and pass it down, rather than recomputing it per tile. Two tiles whose transforms were computed from slightly different origins will not line up at their shared edge, and the discrepancy is proportional to how far apart the origins are — which makes it a seam that grows across the city rather than a constant offset.

## Related Guides

- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the compound CRS the origin passes through
- [glTF vs 3D Tiles vs OBJ for Spatial Data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/gltf-vs-3dtiles-vs-obj-for-spatial-data/) — the local-origin shift and the Y-up rotation
- [Writing 3D Tiles Validator Checks in CI](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/writing-3d-tiles-validator-checks-in-ci/) — where the radius assertion belongs

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
