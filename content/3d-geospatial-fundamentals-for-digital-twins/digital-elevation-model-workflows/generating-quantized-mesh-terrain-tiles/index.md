# Generating Quantized Mesh Terrain Tiles

This page turns a DEM mosaic into a streaming terrain pyramid in the quantized-mesh format — the layer CesiumJS renders under a 3D Tiles city — and covers the three details that decide whether the result is watertight: the TMS tile addressing, the per-edge vertex lists that let neighbouring tiles agree, and the skirt heights that hide what is left. A terrain pyramid that renders with visible cracks at tile boundaries is nearly always failing one of those three.

## Why you hit this

Terrain and buildings arrive in a viewer from two different pipelines, and the terrain one is the older and less forgiving. Quantized mesh predates 3D Tiles, addresses tiles in TMS rather than XYZ, quantises every vertex to 16 bits within the tile's own bounding box, and requires each tile to declare which of its vertices lie on each edge so the runtime can weld neighbours. None of that is difficult; all of it is easy to get subtly wrong in a way that renders as a hairline crack the length of every tile boundary.

The mosaic this consumes comes out of [merging and mosaicking DEM tiles with GDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/merging-and-mosaicking-dem-tiles-with-gdal/).

## Prerequisites

- `ctb-quantized-mesh` (a fork of Cesium Terrain Builder) or `cesium-terrain-builder-docker`, plus GDAL 3.6+.
- A single-band float32 DEM in EPSG:4326 with an explicit nodata value. The format is defined on the geographic grid, so a projected mosaic has to be warped first.
- Python 3.10+ with `numpy>=1.24` and `requests` for the verification steps.
- Roughly 3–5× the DEM's size in free disk for the pyramid.

## Step-by-Step

### 1. Warp the mosaic to EPSG:4326 on the tiling grid

Quantized mesh tiles the geographic grid, so the source has to be there too, aligned to whole tile boundaries.

```bash
gdalwarp \
  -t_srs EPSG:4326 \
  -r bilinear \
  -dstnodata -9999 \
  -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BIGTIFF=IF_SAFER \
  -multi -wo NUM_THREADS=ALL_CPUS \
  dem_utm33n_1m.tif dem_wgs84.tif

gdalinfo dem_wgs84.tif | grep -E "Size is|Pixel Size|NoData"
```

Resampling a projected DEM to geographic stretches cells non-uniformly with latitude, which is unavoidable and worth knowing: at 60° N a cell that was square in UTM becomes twice as wide as it is tall in degrees. That is the format's constraint, not a mistake.

### 2. Build the pyramid

`ctb-tile` walks the zoom levels, meshing each tile to a vertex budget.

```bash
mkdir -p terrain
ctb-tile --output-dir terrain --output-format Mesh \
         --start-zoom 14 --end-zoom 0 \
         --thread-count $(nproc) \
         dem_wgs84.tif

# The layer descriptor the client reads first.
ctb-tile --output-dir terrain --output-format Mesh --layer dem_wgs84.tif
cat terrain/layer.json
```

Building from the deepest zoom upward is deliberate: each coarser level is meshed from the level below rather than from the DEM, so the pyramid is internally consistent and a coarse tile is a genuine simplification of its children rather than an independent sampling of the raster.

<figure class="diagram">
<svg viewBox="44 16 614 224" role="img" aria-labelledby="qm-tms-t qm-tms-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qm-tms-t">TMS and XYZ number their rows in opposite directions</title>
  <desc id="qm-tms-d">Quantized mesh addresses tiles in TMS, where row zero is the southernmost. Web map tiles and 3D Tiles use XYZ, where row zero is the northernmost. A pyramid served under the wrong convention renders mirrored north to south, with terrain that looks plausible and is upside down.</desc>
  <rect class="svg-bg" x="44" y="16" width="614" height="224" fill="#ffffff"/>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.5">
    <rect x="60" y="60" width="70" height="44"/><rect x="130" y="60" width="70" height="44"/>
    <rect x="60" y="104" width="70" height="44"/><rect x="130" y="104" width="70" height="44"/>
    <rect x="60" y="148" width="70" height="44"/><rect x="130" y="148" width="70" height="44"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="95" y="87">y=2</text><text x="165" y="87">y=2</text>
    <text x="95" y="131">y=1</text><text x="165" y="131">y=1</text>
    <text x="95" y="175">y=0</text><text x="165" y="175">y=0</text>
  </g>
  <g fill="#ffffff" stroke="#5b6471" stroke-width="1.5">
    <rect x="440" y="60" width="70" height="44"/><rect x="510" y="60" width="70" height="44"/>
    <rect x="440" y="104" width="70" height="44"/><rect x="510" y="104" width="70" height="44"/>
    <rect x="440" y="148" width="70" height="44"/><rect x="510" y="148" width="70" height="44"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="475" y="87">y=0</text><text x="545" y="87">y=0</text>
    <text x="475" y="131">y=1</text><text x="545" y="131">y=1</text>
    <text x="475" y="175">y=2</text><text x="545" y="175">y=2</text>
  </g>
  <text x="130" y="44" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">TMS — quantized mesh</text>
  <text x="510" y="44" fill="#9a4f26" font-size="12.5" text-anchor="middle" font-weight="600">XYZ — 3D Tiles, web maps</text>
  <text x="250" y="118" fill="#5b6471" font-size="12" text-anchor="start">north</text>
  <text x="250" y="176" fill="#5b6471" font-size="12" text-anchor="start">south</text>
  <text x="370" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">y_xyz = 2^zoom − 1 − y_tms — the one line that reconciles a terrain layer with the city above it</text>
</svg>
<figcaption>Both conventions are in active use and neither is wrong. Serving a pyramid under the other one renders terrain that is convincing and mirrored.</figcaption>
</figure>

### 3. Understand what a tile actually contains

Every vertex is quantised to 16 bits within the tile's own bounding box, and the edges are declared explicitly.

```python
import struct
import gzip
import numpy as np

def read_quantized_mesh(path):
    raw = gzip.open(path, "rb").read() if path.endswith(".gz") else open(path, "rb").read()
    off = 0
    cx, cy, cz, min_h, max_h, bx, by, bz, br, hx, hy, hz = struct.unpack_from("<3d2f4d3d", raw, off)
    off += 88
    (count,) = struct.unpack_from("<I", raw, off); off += 4

    def zigzag(a):
        return (a >> 1) ^ (-(a & 1))

    def decode(n):
        nonlocal off
        arr = np.frombuffer(raw, dtype="<u2", count=n, offset=off).astype(np.int32)
        off += n * 2
        return np.cumsum(zigzag(arr))

    u, v, h = decode(count), decode(count), decode(count)
    return {"vertices": count, "min_h": min_h, "max_h": max_h,
            "u": u, "v": v, "h": h, "centre": (cx, cy, cz)}

t = read_quantized_mesh("terrain/14/8801/9702.terrain")
print(f"{t['vertices']} vertices, height range {t['min_h']:.1f}–{t['max_h']:.1f} m")
print("u range:", int(t["u"].min()), int(t["u"].max()))
```

The `u`, `v` and `h` arrays run from 0 to 32767 across the tile, so the vertical precision is the tile's height range divided by 32767 — under a centimetre for a typical tile and metres for one spanning a mountain range. That is the format's main limitation and the reason a tile covering enormous relief benefits from being split.

### 4. Check that neighbouring tiles agree on their shared edge

Each tile lists the indices of the vertices on its west, south, east and north edges. Two neighbours are watertight only if their shared edge vertices have identical positions.

```python
import numpy as np

def edge_heights(tile, side):
    idx = tile["edges"][side]
    return tile["h"][idx], tile["u"][idx], tile["v"][idx]

def seam_residual(left, right):
    """left's east edge against right's west edge."""
    lh, _, lv = edge_heights(left, "east")
    rh, _, rv = edge_heights(right, "west")
    if len(lh) != len(rh):
        return None                       # different vertex counts: cannot weld
    order_l, order_r = np.argsort(lv), np.argsort(rv)
    return np.abs(lh[order_l] - rh[order_r]).max()

r = seam_residual(tile_a, tile_b)
print("max edge height difference:", "incompatible" if r is None else f"{r} quantised units")
```

A differing vertex count on the shared edge is the crack that cannot be closed by any skirt: the runtime has no correspondence to weld. It happens when two tiles were meshed from different source resolutions, which is why the pyramid must be built in one pass from one mosaic.

<figure class="diagram">
<svg viewBox="2 52 736 202" role="img" aria-labelledby="qm-seam-t qm-seam-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qm-seam-t">Matching edge vertices, mismatched counts, and what a skirt hides</title>
  <desc id="qm-seam-d">When two tiles share the same edge vertex positions the runtime welds them and the surface is continuous. When their vertex counts differ there is no correspondence to weld and a crack remains. A skirt — a downward-facing wall extruded from the tile edge — hides small residual gaps but cannot close a structural mismatch.</desc>
  <rect class="svg-bg" x="2" y="52" width="736" height="202" fill="#ffffff"/>
  <path d="M40 70 L150 70 L150 160 L40 160 Z" fill="none" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M150 70 L260 70 L260 160 L150 160 Z" fill="none" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#4f7a4d">
    <circle cx="150" cy="70" r="3.5"/><circle cx="150" cy="100" r="3.5"/>
    <circle cx="150" cy="130" r="3.5"/><circle cx="150" cy="160" r="3.5"/>
  </g>
  <path d="M300 70 L410 70 L410 160 L300 160 Z" fill="none" stroke="#b0413e" stroke-width="2"/>
  <path d="M414 70 L524 70 L524 160 L414 160 Z" fill="none" stroke="#b0413e" stroke-width="2"/>
  <g fill="#b0413e">
    <circle cx="410" cy="70" r="3.5"/><circle cx="410" cy="115" r="3.5"/><circle cx="410" cy="160" r="3.5"/>
    <circle cx="414" cy="70" r="3.5"/><circle cx="414" cy="94" r="3.5"/>
    <circle cx="414" cy="118" r="3.5"/><circle cx="414" cy="142" r="3.5"/><circle cx="414" cy="160" r="3.5"/>
  </g>
  <path d="M570 70 L690 70 L690 150 L570 150 Z" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M570 150 L570 178 M690 150 L690 178 M570 178 L690 178" fill="none" stroke="#c46a3d" stroke-width="2"/>
  <text x="150" y="196" fill="#4f7a4d" font-size="12" text-anchor="middle">4 vertices each — welds cleanly</text>
  <text x="412" y="196" fill="#b0413e" font-size="12" text-anchor="middle">3 against 5 — no correspondence, crack remains</text>
  <text x="630" y="204" fill="#9a4f26" font-size="12" text-anchor="middle">skirt hides sub-pixel gaps only</text>
  <text x="370" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">A skirt is cosmetic. A vertex-count mismatch is structural, and it means the two tiles were meshed from different sources.</text>
</svg>
<figcaption>The middle case is the one to gate on. No runtime setting closes it, because the two tiles disagree about how many points describe their shared edge.</figcaption>
</figure>

### 5. Serve the pyramid with the right headers

The client fetches `layer.json` first and then tiles by TMS address, and both need specific content types.

```nginx
location ~* \.terrain$ {
    add_header Content-Type application/vnd.quantized-mesh;
    add_header Content-Encoding gzip;
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
location = /terrain/layer.json {
    add_header Content-Type application/json;
    add_header Cache-Control "no-cache";
}
```

The `Content-Encoding: gzip` header is required because `ctb-tile` writes the tiles already gzipped and the server must not compress them again. Omitting it makes the client receive compressed bytes it does not know to inflate, and every tile fails to parse.

<figure class="diagram">
<svg viewBox="112 42 646 210" role="img" aria-labelledby="qm-quant-t qm-quant-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qm-quant-t">Vertical precision depends on the tile's own height range</title>
  <desc id="qm-quant-d">Heights are quantised to sixteen bits between the tile's minimum and maximum. A tile spanning two hundred metres of relief resolves to about three millimetres. A tile spanning three thousand metres resolves to about five centimetres, and one spanning a whole mountain range resolves to decimetres.</desc>
  <rect class="svg-bg" x="112" y="42" width="646" height="210" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="200" y="56" width="60" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="98" width="180" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="200" y="140" width="330" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="200" y="182" width="470" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="270" y="76">200 m range → 3 mm per step</text>
    <text x="390" y="118">1000 m range → 15 mm</text>
    <text x="540" y="160">3000 m range → 46 mm</text>
    <text x="200" y="234">8000 m range → 122 mm — a tile spanning a mountain range loses centimetre precision entirely</text>
  </g>
  <text x="190" y="76" fill="#5b6471" font-size="12" text-anchor="end">city tile</text>
  <text x="190" y="118" fill="#5b6471" font-size="12" text-anchor="end">regional</text>
  <text x="190" y="160" fill="#5b6471" font-size="12" text-anchor="end">alpine</text>
  <text x="190" y="202" fill="#5b6471" font-size="12" text-anchor="end">continental</text>
</svg>
<figcaption>Sixteen bits is plenty for a city tile and marginal for a coarse one, which is one reason the pyramid&#39;s upper levels carry less vertical fidelity than their cell size suggests.</figcaption>
</figure>

## Expected Output & Verification

A correct pyramid over a city extent:

```text
Size is 41216, 28904
Pixel Size = (0.0000089831529,-0.0000089831529)
NoData Value=-9999
14/8801/9702.terrain — 4218 vertices, height range 3.2–214.7 m
u range: 0 32767
max edge height difference: 0 quantised units
```

Three things to confirm. The `u` and `v` ranges must reach 0 and 32767, or the tile does not span its own bounding box and a gap will appear at the edge. Edge residuals must be exactly zero in quantised units — not merely small, because the runtime welds by exact match. And `layer.json` must list every zoom level you built, since a missing level makes the client fall back to a coarser one without reporting anything.

## Common Errors

**Hairline cracks along every tile boundary.** Either the edge vertex lists are absent, or neighbours disagree on their shared edge. Check the residual as in step 4; if the counts differ, the pyramid was built from more than one source.

**Terrain is mirrored north to south.** The server is addressing tiles in XYZ while the format uses TMS. Convert with `y_tms = 2**zoom - 1 - y_xyz`.

**Every tile fails to parse in the client.** The server re-compressed already-gzipped tiles, or omitted `Content-Encoding: gzip` so the client never inflated them. Fetch one tile with `curl -I` and check the headers.

**Terrain floats above or below the buildings.** The DEM was orthometric and the client expects ellipsoidal heights, so the two layers differ by the geoid separation. Convert the mosaic through a compound CRS before tiling.

## Frequently Asked Questions

### How deep should the pyramid go?
To the zoom whose tile size matches the DEM resolution — beyond that the mesher is interpolating rather than describing. For a 1 m DEM at mid-latitudes that is around zoom 15 or 16.

### Should I use quantized mesh or 3D Tiles for terrain?
Quantized mesh where CesiumJS is the client and terrain is a separate layer, because it is what the terrain provider API expects. 3D Tiles where terrain and city ship as one tileset, which simplifies the pipeline at the cost of losing the dedicated terrain rendering path.

### What vertex budget per tile?
The builder chooses adaptively, and typical tiles land between 1,000 and 8,000 vertices. Forcing a higher budget rarely improves the visible surface and multiplies the pyramid's size, because most of the extra vertices land on ground that is already flat.

One consequence of that quantisation is worth planning for. Because precision is a function of the tile's height range rather than of its ground size, the coarse levels of a pyramid over varied terrain are the least precise part of it — exactly the levels a viewer sees first. Where that matters, the remedy is not a finer format but a shallower start zoom, so the client never renders the levels whose vertical resolution has degraded past the tolerance.

The second planning note concerns rebuilds. A quantized-mesh pyramid is not incrementally updatable in any meaningful sense: changing one DEM tile changes the meshing of every level above it, because each coarse tile is derived from its children. Budget for full rebuilds, keep the source mosaic, and version the pyramid by build so a rollback is an alias swap rather than a regeneration.

## Related Guides

- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — producing the DEM this consumes
- [Merging and Mosaicking DEM Tiles with GDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/merging-and-mosaicking-dem-tiles-with-gdal/) — the single mosaic the pyramid must come from
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — why terrain floats above buildings

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
