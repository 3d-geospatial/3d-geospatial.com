# Handling Vertical Datums and Geoid Separation in 3D Geospatial Data

This page shows how to reconcile the two height systems a digital twin mixes — **ellipsoidal** heights on WGS84 (EPSG:4979) and **orthometric** heights on a geoid model (NAVD88, EPSG:5703; or EGM2008, EPSG:3855) — by computing the geoid separation N explicitly with `pyproj` compound-CRS transforms, and how a datum mismatch shows up as a vertical step at tile seams. The core operation is a compound-CRS transform such as EPSG:32618+5703 → EPSG:4979 that carries a metric, orthometric point into the ellipsoidal frame Cesium renders in, applying the geoid grid per point rather than a constant.

You hit this whenever two datasets that "look" co-registered disagree in Z: a GNSS-derived cloud on ellipsoidal heights sits tens of metres above a DEM on NAVD88, or two adjacent tiles authored against different geoid models leave a cliff at their shared edge. The offset is the geoid separation, and it is not a bug in the geometry — it is an undeclared vertical datum. This guide isolates and quantifies that separation. The broader datum-management strategy lives in [coordinate reference systems for 3D assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/), and the horizontal EPSG:4326 → UTM path is covered in [converting WGS84 to local projected coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/); here the focus is strictly the vertical.

<figure class="diagram">
<svg viewBox="26 55 748 264" role="img" aria-labelledby="vdatum-t vdatum-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vdatum-t">Geoid separation and a Z step at a tile seam</title>
  <desc id="vdatum-d">Two adjacent terrain tiles share an edge; the left tile is referenced to the ellipsoid and the right to the geoid, so their surfaces meet at a vertical step equal to the geoid separation N, the gap between the ellipsoid and geoid surfaces.</desc>
  <rect class="svg-bg" x="26" y="55" width="748" height="264" fill="#ffffff"/>
  <defs>
    <marker id="vdatum-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <path d="M40 90 Q 250 70 400 82 T 760 90" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M40 150 Q 250 175 400 150 T 760 152" fill="none" stroke="#c46a3d" stroke-width="2"/>
  <text x="90" y="82" fill="#1f6b8a" font-size="12">ellipsoid (EPSG:4979)</text>
  <text x="90" y="168" fill="#c46a3d" font-size="12">geoid (NAVD88 / EGM2008)</text>
  <line x1="400" y1="82" x2="400" y2="150" stroke="#5b6471" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="415" y="120" fill="#1f2937" font-size="13">N</text>
  <rect x="160" y="210" width="230" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="410" y="238" width="230" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <line x1="390" y1="232" x2="410" y2="260" stroke="#5b6471" stroke-width="2" marker-end="url(#vdatum-arrow)"/>
  <text x="400" y="300" fill="#c46a3d" font-size="13" text-anchor="middle">Z step = N at the seam</text>
  <g font-size="13" text-anchor="middle" fill="#15384a">
    <text x="275" y="237">tile A: ellipsoidal Z</text>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="525" y="265">tile B: orthometric Z</text>
  </g>
</svg>
<figcaption>The geoid separation N is the gap between ellipsoid and geoid; author two tiles against different vertical datums and N reappears as a vertical step at their shared edge.</figcaption>
</figure>

## Prerequisites

- Python 3.9+ with `pyproj>=3.6` (PROJ 9.x) and `numpy>=1.24`: `pip install "pyproj>=3.6" numpy`.
- PROJ vertical grids reachable at runtime — `us_noaa_g2018u0.tif` (GEOID18, behind NAVD88) and `us_nga_egm2008_1.tif` (EGM2008). Enable the PROJ CDN or install `proj-data`; without the grid, PROJ silently returns ellipsoidal heights and every separation reads as zero.
- Data whose vertical datum you can state. The examples use a horizontal EPSG:32618 (UTM 18N) paired with orthometric NAVD88 (EPSG:5703) or EGM2008 (EPSG:3855), and the geographic-3D ellipsoidal frame EPSG:4979.
- A published benchmark or a control point with a known orthometric height for validation.

Enable network grids first so a missing geoid fails loudly:

```python
import pyproj
pyproj.network.set_network_enabled(active=True)
print("PROJ", pyproj.proj_version_str, "| network:", pyproj.network.is_network_enabled())
```

## Step-by-Step

### 1. Compute the geoid separation N per point

N is the signed gap between ellipsoidal height h and orthometric height H, with H = h − N. Recover it directly: transform your orthometric compound CRS (EPSG:32618+5703) into the ellipsoidal frame (EPSG:4979) and subtract. N varies continuously across the extent, which is exactly why a constant will not do.

```python
import numpy as np
from pyproj import Transformer

# Orthometric NAVD88 (EPSG:32618+5703) -> ellipsoidal WGS84 3D (EPSG:4979)
to_ellip = Transformer.from_crs("EPSG:32618+5703", "EPSG:4979", always_xy=True)

easting  = np.array([583120.4, 583402.9, 584010.7])   # metres, EPSG:32618
northing = np.array([4507880.1, 4508110.7, 4508640.2])
ortho_H  = np.array([14.62, 11.08, 9.55])              # NAVD88 orthometric, metres

lon, lat, ellip_h = to_ellip.transform(easting, northing, ortho_H)
separation = ellip_h - ortho_H                          # N, metres
print("geoid separation N (m):", np.round(separation, 3))
```

The three values that come back are close to each other, and that closeness is the trap. Over a few hundred metres N barely moves, so the first instinct — take the mean and subtract it — looks defensible and is wrong at the only scale that matters. Across a single UTM zone N sweeps several metres; across a metropolitan tileset it commonly moves 30–60 cm corner to corner, which is larger than the vertical tolerance of every clearance, drainage, and flood product the twin exists to answer. A constant shift bakes that gradient into the data as a tilt, and because the tilt is smooth nobody sees it until an analyst compares two survey campaigns and finds one of them leaning.

<figure class="diagram">
<svg viewBox="24 16 670 286" role="img" aria-labelledby="vd-nfield-t vd-nfield-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vd-nfield-t">Geoid separation varies continuously across a survey extent</title>
  <desc id="vd-nfield-d">Contours of geoid separation sweep diagonally across a survey extent, from about minus 33.2 metres in one corner to minus 33.6 metres in another. Three sampled control points fall on different contours, so a single averaged constant is wrong by up to 0.4 metres at the extremes.</desc>
  <rect class="svg-bg" x="24" y="16" width="670" height="286" fill="#ffffff"/>
  <rect x="40" y="30" width="440" height="230" rx="6" fill="#ffffff" stroke="#5b6471" stroke-width="2"/>
  <g fill="none" stroke="#c46a3d" stroke-width="2">
    <path d="M50 80 C 160 58 300 100 470 76"/>
    <path d="M50 150 C 160 128 300 170 470 146"/>
    <path d="M50 220 C 160 198 300 240 470 216"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="120" cy="96" r="5"/>
    <circle cx="250" cy="168" r="5"/>
    <circle cx="400" cy="205" r="5"/>
  </g>
  <g fill="#15384a" font-size="12" text-anchor="end">
    <text x="108" y="100">A</text>
    <text x="238" y="172">B</text>
    <text x="388" y="209">C</text>
  </g>
  <g fill="#c46a3d" font-size="11.5" text-anchor="end">
    <text x="466" y="68">N = −33.2 m</text>
    <text x="466" y="138">N = −33.4 m</text>
    <text x="466" y="208">N = −33.6 m</text>
  </g>
  <rect x="510" y="86" width="170" height="118" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="595" y="118" fill="#1f2937" font-size="12" text-anchor="middle"><tspan x="595" dy="0">One averaged constant</tspan><tspan x="595" dy="16">of −33.4 m is wrong by</tspan><tspan x="595" dy="16">0.2 m at A and C, and</tspan><tspan x="595" dy="16">tilts the whole extent</tspan></text>
  <text x="260" y="284" fill="#5b6471" font-size="12" text-anchor="middle">Survey extent, EPSG:32618 — sampled N: A −33.24 m · B −33.41 m · C −33.58 m</text>
</svg>
<figcaption>N is a field, not a number. Sample it per point through the grid; the moment you average it you have introduced a tilt that no later check will attribute to the datum.</figcaption>
</figure>

### 2. Convert orthometric heights to ellipsoidal for Cesium delivery

Web runtimes place geometry on the WGS84 ellipsoid (EPSG:4978 ECEF, reached via EPSG:4979). So the delivery boundary needs ellipsoidal Z, not the orthometric Z the twin analyses in. Do the conversion with the same compound transform, keeping the internal store orthometric.

```python
from pyproj import Transformer

to_ecef = Transformer.from_crs("EPSG:4979", "EPSG:4978", always_xy=True)

# lon, lat, ellip_h came from step 1 — now push to geocentric ECEF for the tileset.
x, y, z = to_ecef.transform(lon, lat, ellip_h)
radii = np.linalg.norm(np.column_stack([x, y, z]), axis=1)
assert (6.3e6 < radii).all() and (radii < 6.5e6).all(), "not on the ellipsoid — datum chain wrong"
print("ECEF radius (m):", np.round(radii, 1))
```

### 3. Quantify the Z step two datums produce at a seam

If tile A is authored on EGM2008 and tile B on NAVD88, points that are physically identical carry different Z. Transform one benchmark through both compound CRSs into the shared ellipsoidal frame and the difference is the seam step you would see in the viewer.

```python
from pyproj import Transformer

navd88  = Transformer.from_crs("EPSG:32618+5703", "EPSG:4979", always_xy=True)
egm2008 = Transformer.from_crs("EPSG:32618+3855", "EPSG:4979", always_xy=True)

e, n, h_ortho = 583120.4, 4507880.1, 14.62     # same ground point, one number per datum
_, _, ellip_from_navd88  = navd88.transform(e, n, h_ortho)
_, _, ellip_from_egm2008 = egm2008.transform(e, n, h_ortho)

seam_step = ellip_from_navd88 - ellip_from_egm2008
print(f"seam Z step from mixed vertical datums: {seam_step*100:.1f} cm")
```

That number is a prediction, and it is worth confirming against the delivered data rather than only against the transform. Sample both tiles along a transect that crosses their shared edge — a few hundred elevation lookups at a metre spacing, half on each side — and plot the profile. A datum mismatch has an unmistakable shape: the terrain on each side is continuous and sensibly shaped, and the two halves are offset from one another by a near-constant amount that matches the separation you just computed. That is very different from the shapes produced by the other seam faults. A resampling or edge-matching error produces a step whose size varies along the seam; a CRS drift produces a horizontal shear rather than a vertical offset; and a hydro-flattening artefact bends only the cells within a few metres of the edge.

<figure class="diagram">
<svg viewBox="9 2 665 256" role="img" aria-labelledby="vd-seam-t vd-seam-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vd-seam-t">Elevation transect across a tile seam with mixed vertical datums</title>
  <desc id="vd-seam-d">An elevation profile sampled across two adjacent tiles. Terrain on each side of the seam is continuous and similarly shaped, but the whole right-hand tile sits about twenty-seven centimetres below the left, the signature of one tile authored on NAVD88 and the other on EGM2008.</desc>
  <rect class="svg-bg" x="9" y="2" width="665" height="256" fill="#ffffff"/>
  <defs>
    <marker id="vd-seam-a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#b0413e"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="1.5">
    <line x1="60" y1="40" x2="60" y2="212"/>
    <line x1="60" y1="212" x2="668" y2="212"/>
  </g>
  <line x1="360" y1="40" x2="360" y2="212" stroke="#5b6471" stroke-width="2" stroke-dasharray="5 4"/>
  <polyline points="60,128 110,122 160,131 210,118 260,124 310,116 360,122" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <polyline points="360,150 410,144 460,152 510,140 560,146 610,138 660,144" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <line x1="386" y1="122" x2="386" y2="150" stroke="#b0413e" stroke-width="2" marker-start="url(#vd-seam-a)" marker-end="url(#vd-seam-a)"/>
  <g fill="#5b6471" font-size="11" text-anchor="end">
    <text x="52" y="126">14.62</text>
    <text x="52" y="154">14.35</text>
  </g>
  <text x="396" y="140" fill="#b0413e" font-size="12" text-anchor="start">27 cm, constant along the seam</text>
  <text x="200" y="96" fill="#1f6b8a" font-size="12.5" text-anchor="middle">tile A — orthometric on NAVD88</text>
  <text x="520" y="182" fill="#4f7a4d" font-size="12.5" text-anchor="middle">tile B — orthometric on EGM2008</text>
  <text x="360" y="30" fill="#5b6471" font-size="12" text-anchor="middle">tile seam</text>
  <text x="364" y="240" fill="#5b6471" font-size="12" text-anchor="middle">distance along the transect (m)</text>
</svg>
<figcaption>The datum signature: both halves keep their shape and the offset stays constant along the seam. A varying step means edge matching; a lateral smear means CRS drift.</figcaption>
</figure>

### 4. Assert one vertical datum across a dataset before tiling

The durable fix is a gate: refuse any tile whose declared vertical sub-CRS differs from the project datum. Resolve the compound CRS and compare the vertical component by EPSG code.

```python
from pyproj import CRS

PROJECT_VERTICAL = 5703        # NAVD88 for the whole twin

def assert_vertical_datum(crs_string: str) -> None:
    crs = CRS.from_user_input(crs_string)
    if not crs.is_compound:
        raise ValueError(f"{crs_string} has no vertical datum; Z is ambiguous")
    vert = crs.sub_crs_list[1]
    if vert.to_epsg() != PROJECT_VERTICAL:
        raise ValueError(f"vertical datum EPSG:{vert.to_epsg()} != project EPSG:{PROJECT_VERTICAL}")
    print(f"{crs_string}: vertical datum OK ({vert.name})")

assert_vertical_datum("EPSG:32618+5703")
```

## Expected Output & Verification

Running steps 1–3 over the sample control points around New York, where the NAVD88 geoid separation is roughly −33 m, prints:

```text
geoid separation N (m): [-33.412 -33.398 -33.371]
ECEF radius (m): [6368521.7 6368512.4 6368498.9]
seam Z step from mixed vertical datums: 27.4 cm
```

Verify against a benchmark whose published NAVD88 height you trust — the residual is your real vertical accuracy, and a residual near a round 30–100 m means the geoid grid never loaded:

```python
known_ortho = 38.512                       # published NAVD88 benchmark height, m
_, _, ellip_bm = to_ellip.transform(583500.0, 4508900.0, known_ortho)

# The benchmark's ellipsoidal height must equal H + N (N ≈ -33.4 m here).
n_at_benchmark = ellip_bm - known_ortho
assert -34.5 < n_at_benchmark < -32.5, f"N={n_at_benchmark:.2f} m off — check the geoid grid"
print("benchmark separation N:", round(n_at_benchmark, 2), "m")
```

Two signatures matter. A separation that comes back exactly 0.0 means PROJ fell back to ellipsoidal heights because the grid was missing — the transform ran but did nothing. A seam step in step 3 on the order of 0.2–0.5 m is the real difference between GEOID18/NAVD88 and EGM2008 in the mid-latitudes, and it is precisely the cliff you would otherwise ship into a tileset.

Finally, record the separation you computed alongside the data rather than only the transformed heights. Storing N per tile — even as a single representative value with the grid name and version — means a future consumer can reverse the conversion exactly, and a future geoid revision can be applied as a difference rather than a full reprocessing. It costs one number per tile and turns an irreversible transform into a reversible one.

## Common Errors

**Geoid separation reads exactly 0.0 for every point.** PROJ could not find the vertical grid and silently returned ellipsoidal heights. Call `pyproj.network.set_network_enabled(active=True)` before building the transformer, pre-download the grid with `projsync --file us_noaa_g2018u0.tif`, and assert `transformer.get_grids_used()` reports `available=True`.

**`pyproj.exceptions.CRSError: Invalid projection: EPSG:32618+3855`.** The compound `+` syntax needs `pyproj>=3.0` and PROJ 7+, and EGM2008 as a height CRS is EPSG:3855 (not a geographic code). Upgrade `pyproj`, or build the compound explicitly with `CRS.from_epsg(32618) + CRS.from_epsg(3855)`.

**Heights are off by a clean 33 m only in one region of a tiled twin.** One batch of tiles was authored on ellipsoidal Z and the rest on orthometric, so the geoid separation appears as a step exactly where the batches meet. Gate every tile through the vertical-datum check in step 4 and re-transform the offending batch through the correct compound CRS rather than shifting it by a constant, which is wrong wherever N changes.

## Related Guides

- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the full datum-management and validation strategy
- [Converting WGS84 to Local Projected Coordinates](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/converting-wgs84-to-local-projected-coordinates/) — the horizontal EPSG:4326 → UTM transform
- [How to Choose CRS for Urban Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) — selecting the internal metric and vertical frame
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — aligning terrain rasters to one vertical datum

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
