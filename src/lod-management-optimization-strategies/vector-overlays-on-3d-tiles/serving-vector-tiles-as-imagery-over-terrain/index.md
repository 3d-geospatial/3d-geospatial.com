---
title: "Serving Vector Tiles as Imagery over Terrain"
description: "Render huge vector layers to raster tiles for Cesium: a deterministic Python tile renderer, zoom ranges, empty-tile skipping"
---
# Serving Vector Tiles as Imagery over Terrain

This page turns a vector layer too large to drape — a cadastre, a soil map, a national network — into raster tiles that Cesium adds as an imagery layer over terrain: a small deterministic renderer in Python that draws Web Mercator (EPSG:3857) tiles with anti-aliasing, a zoom strategy that keeps the tile count sane, empty-tile skipping, MBTiles packaging, and an alignment check against known coordinates.

## Why you hit this

Geometry overlays scale to tens of thousands of features. A cadastre has two million parcels, a soil map has a million polygons with intricate boundaries, and a utility network has every service connection in a country. No amount of batching makes those into scene geometry a browser can hold, and they are not interactive data anyway — nobody clicks a soil polygon in a twin, they read the colours. Rendering them once, server-side, into cached raster tiles moves the cost off the client permanently. The trade-off against the geometry strategies is set out in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).

## Prerequisites

- Python 3.10+ with `geopandas>=0.14`, `shapely>=2.0`, `mercantile>=1.2`, `Pillow>=10`, `pyproj>=3.6`.
- A vector layer with a declared CRS and a category column to colour by; the example is a cadastral parcel layer in EPSG:25832.
- A static file host or CDN for the tiles, and CesiumJS 1.110+ on the client.

## Step-by-Step

### 1. Reproject once and index

```python
import geopandas as gpd
from shapely import make_valid

gdf = gpd.read_file("cadastre.gpkg", layer="parcels")
gdf.loc[~gdf.geometry.is_valid, "geometry"] = gdf.loc[~gdf.geometry.is_valid, "geometry"].apply(make_valid)
gdf = gdf.to_crs(3857)                                  # Web Mercator: the tile scheme's CRS
gdf["geometry"] = gdf.geometry.simplify(2.0, preserve_topology=True)   # 2 m at the equator
sindex = gdf.sindex
print(f"{len(gdf):,} parcels in EPSG:3857, bounds {[round(v) for v in gdf.total_bounds]}")
```

Reprojecting the whole layer once, into the CRS the tile scheme uses, removes a per-tile transformation from the render loop — which matters when the loop runs a hundred thousand times. Web Mercator distances are inflated by the secant of the latitude, so a 2 m simplification tolerance at 48° N is really about 1.3 m on the ground; simplify in the source CRS instead if the tolerance has to be exact.

### 2. Render one tile

```python
from io import BytesIO
import mercantile
import numpy as np
from PIL import Image, ImageDraw

TILE = 256
SUPERSAMPLE = 2                      # draw at 512 and downsample for anti-aliasing

PALETTE = {
    "residential": (31, 107, 138, 110),
    "commercial": (196, 106, 61, 110),
    "agricultural": (79, 122, 77, 110),
    "other": (91, 100, 113, 90),
}
OUTLINE = (21, 56, 74, 180)

def render_tile(z, x, y):
    bounds = mercantile.xy_bounds(x, y, z)             # in EPSG:3857 metres
    width_m = bounds.right - bounds.left
    scale = TILE * SUPERSAMPLE / width_m

    candidates = list(sindex.intersection((bounds.left, bounds.bottom, bounds.right, bounds.top)))
    if not candidates:
        return None
    rows = gdf.iloc[candidates]

    img = Image.new("RGBA", (TILE * SUPERSAMPLE, TILE * SUPERSAMPLE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    drawn = 0
    for _, r in rows.iterrows():
        geoms = r.geometry.geoms if r.geometry.geom_type == "MultiPolygon" else [r.geometry]
        colour = PALETTE.get(r["use_class"], PALETTE["other"])
        for g in geoms:
            xs, ys = np.asarray(g.exterior.coords).T
            px = (xs - bounds.left) * scale
            py = (bounds.top - ys) * scale             # image y grows downward
            if px.max() - px.min() < 1 and py.max() - py.min() < 1:
                continue                                # smaller than a pixel at this zoom
            draw.polygon(list(zip(px, py)), fill=colour, outline=OUTLINE)
            drawn += 1
    if drawn == 0:
        return None
    return img.resize((TILE, TILE), Image.LANCZOS)
```

Three decisions in that loop keep the output both correct and small. The spatial index turns "which parcels are in this tile" from a full scan into a lookup, which is the difference between a week and an hour for a national layer. Supersampling and downsampling give clean edges without a graphics stack. And returning `None` for a tile with nothing visible is what makes the empty-tile skipping in the next step possible.

<figure class="diagram">
<svg viewBox="26 6 668 242" role="img" aria-labelledby="vt-pyr-t vt-pyr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vt-pyr-t">Tile counts per zoom level for one city extent</title>
  <desc id="vt-pyr-d">A pyramid of Web Mercator tiles over a city extent. Zoom 12 needs about 4 tiles, zoom 14 about 60, zoom 16 about 950, zoom 18 about 15,000 and zoom 20 about 240,000. Because tile count quadruples per level, the top three levels are almost free and the bottom level dominates both render time and storage.</desc>
  <rect class="svg-bg" x="26" y="6" width="668" height="242" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="330" y="20" width="60" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="300" y="52" width="120" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="250" y="84" width="220" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="170" y="116" width="380" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="148" width="640" height="26" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="400" y="39">z12 · ~4 tiles</text>
    <text x="430" y="71">z14 · ~60</text>
    <text x="480" y="103">z16 · ~950</text>
    <text x="560" y="135">z18 · ~15,000</text>
    <text x="40" y="196">z20 · ~240,000 tiles — most of the cost, rarely looked at</text>
  </g>
  <text x="380" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">Stop one or two levels short and let the client over-zoom the last level.</text>
</svg>
<figcaption>Every extra level quadruples the work. The right maximum zoom is the one where the parcel boundaries are already a pixel apart.</figcaption>
</figure>

### 3. Generate a zoom range into MBTiles

```python
import sqlite3
from pathlib import Path

def build_mbtiles(out_path, min_zoom=12, max_zoom=18):
    west, south, east, north = gdf.to_crs(4326).total_bounds
    con = sqlite3.connect(out_path)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER,
            tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row));
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
    """)
    written = skipped = 0
    for z in range(min_zoom, max_zoom + 1):
        for t in mercantile.tiles(west, south, east, north, z):
            img = render_tile(t.z, t.x, t.y)
            if img is None:
                skipped += 1
                continue
            buf = BytesIO()
            img.save(buf, "PNG", optimize=True)
            con.execute("INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)",
                        (z, t.x, (1 << z) - 1 - t.y, buf.getvalue()))   # MBTiles rows count from the south
            written += 1
        con.commit()
        print(f"z{z}: {written} written, {skipped} empty so far")
    con.executemany("INSERT OR REPLACE INTO metadata VALUES (?,?)", [
        ("name", "cadastre"), ("format", "png"), ("minzoom", str(min_zoom)), ("maxzoom", str(max_zoom)),
        ("bounds", f"{west},{south},{east},{north}"), ("type", "overlay"),
    ])
    con.commit(); con.close()
    return written, skipped

written, skipped = build_mbtiles("tiles/cadastre.mbtiles")
print(f"{written:,} tiles written, {skipped:,} empty tiles skipped, "
      f"{Path('tiles/cadastre.mbtiles').stat().st_size / 1e6:.1f} MB")
```

The `(1 << z) - 1 - t.y` is the MBTiles row flip, and getting it wrong produces a layer that is mirrored vertically — plausible-looking and completely wrong, which is why the verification step below checks a known coordinate rather than eyeballing the result. Skipping empty tiles matters for a layer with gaps: a cadastre covering 30% of a rectangular extent saves two thirds of the storage and render time.

<figure class="diagram">
<svg viewBox="21 16 606 240" role="img" aria-labelledby="vt-flip-t vt-flip-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vt-flip-t">Tile row numbering in XYZ and in MBTiles</title>
  <desc id="vt-flip-d">At zoom two there are four rows. In the XYZ scheme used by web tiles, row zero is at the north. In MBTiles, row zero is at the south, so a tile stored without the flip appears mirrored vertically. The conversion is two to the power of the zoom, minus one, minus the row.</desc>
  <rect class="svg-bg" x="21" y="16" width="606" height="240" fill="#ffffff"/>
  <g stroke-width="1.5" fill="#e3f0f4" stroke="#1f6b8a">
    <rect x="60" y="30" width="60" height="40"/><rect x="60" y="70" width="60" height="40"/>
    <rect x="60" y="110" width="60" height="40"/><rect x="60" y="150" width="60" height="40"/>
    <rect x="420" y="30" width="60" height="40"/><rect x="420" y="70" width="60" height="40"/>
    <rect x="420" y="110" width="60" height="40"/><rect x="420" y="150" width="60" height="40"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="90" y="55">y = 0</text><text x="90" y="95">y = 1</text><text x="90" y="135">y = 2</text><text x="90" y="175">y = 3</text>
    <text x="450" y="55">row 3</text><text x="450" y="95">row 2</text><text x="450" y="135">row 1</text><text x="450" y="175">row 0</text>
    <text x="90" y="212">XYZ: 0 at the north</text>
    <text x="450" y="212">MBTiles: 0 at the south</text>
  </g>
  <text x="270" y="110" fill="#15384a" font-size="12.5" text-anchor="middle">row = 2^z − 1 − y</text>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Applying the flip twice, or not at all, mirrors the whole layer and looks plausible.</text>
</svg>
<figcaption>The two conventions differ only in which end row zero is, which is exactly why the error survives casual inspection.</figcaption>
</figure>

### 4. Add it to Cesium as an imagery layer

```javascript
const cadastre = viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://tiles.example.org/cadastre/{z}/{x}/{reverseY}.png",
    minimumLevel: 12,
    maximumLevel: 18,
    rectangle: Cesium.Rectangle.fromDegrees(11.36, 48.06, 11.72, 48.22),
    credit: "Cadastre © state survey",
  })
);
cadastre.alpha = 0.65;
cadastre.brightness = 1.0;
```

`maximumLevel` at 18 while the camera can go closer is deliberate: Cesium over-zooms the deepest available level rather than requesting tiles that do not exist, so the layer stays visible and slightly soft up close instead of disappearing. The `rectangle` stops the client requesting tiles outside the data extent, which otherwise generates a steady stream of 404s. Whether the URL template needs `{y}` or `{reverseY}` depends on how the tiles were written — the MBTiles convention above counts rows from the south, so a server unpacking them directly wants `{reverseY}`.

### 5. Verify the alignment against a known coordinate

```python
from pyproj import Transformer

to_merc = Transformer.from_crs(4326, 3857, always_xy=True)

def pixel_of(lon, lat, z):
    x, y = to_merc.transform(lon, lat)
    t = mercantile.tile(lon, lat, z)
    b = mercantile.xy_bounds(t)
    px = (x - b.left) / (b.right - b.left) * TILE
    py = (b.top - y) / (b.top - b.bottom) * TILE
    return t, px, py

t, px, py = pixel_of(11.5730216, 48.1381190, 18)       # a surveyed parcel corner
img = render_tile(t.z, t.x, t.y)
sample = img.getpixel((int(px), int(py)))
print(f"tile {t.z}/{t.x}/{t.y} pixel ({px:.1f}, {py:.1f}) → RGBA {sample}")
assert sample[3] > 0, "the surveyed corner falls on a transparent pixel: the layer is misaligned"
```

Rendering the tile that should contain a surveyed point and reading the pixel is the only check that catches the three silent failure modes together: a wrong CRS, a flipped row index and an extent computed in the wrong units. It is worth keeping as a test, with the expected colour class asserted as well, so a change to the palette or the renderer cannot quietly break geolocation.

<figure class="diagram">
<svg viewBox="6 6 748 218" role="img" aria-labelledby="vt-cost-t vt-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="vt-cost-t">Geometry overlay against imagery for the same layer</title>
  <desc id="vt-cost-d">A comparison. Draped geometry sends every vertex to the client, holds it in memory, allows per-feature picking and styling, and stops scaling around tens of thousands of features. Imagery sends pixels, costs the client almost nothing, has no picking or client-side restyling, and scales to millions of features with a build step and cache storage.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="218" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="260" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="20" width="260" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="200" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="58" width="260" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="480" y="58" width="260" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="96" width="200" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="96" width="260" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="96" width="260" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="134" width="200" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="134" width="260" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="134" width="260" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="172" width="200" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="172" width="260" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="480" y="172" width="260" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="44">property</text>
    <text x="350" y="44">draped geometry</text>
    <text x="610" y="44">imagery tiles</text>
    <text x="120" y="82">client memory</text><text x="350" y="82">all vertices</text><text x="610" y="82">a few textures</text>
    <text x="120" y="120">picking</text><text x="350" y="120">per feature</text><text x="610" y="120">none</text>
    <text x="120" y="158">restyling</text><text x="350" y="158">instant, client-side</text><text x="610" y="158">rebuild the tiles</text>
    <text x="120" y="196">scale limit</text><text x="350" y="196">tens of thousands</text><text x="610" y="196">millions</text>
  </g>
</svg>
<figcaption>Imagery trades interactivity for scale. Where a user needs to click a feature, keep a small geometry layer for the selection on top of the raster.</figcaption>
</figure>

## Expected Output & Verification

```text
1,842,204 parcels in EPSG:3857, bounds [1263000, 6115000, 1305000, 6141000]
z12: 6 written, 2 empty so far
z14: 78 written, 22 empty so far
z16: 1094 written, 402 empty so far
z18: 15922 written, 5210 empty so far
15,922 tiles written, 5,210 empty tiles skipped, 412.6 MB
tile 18/140361/91230 pixel (182.4, 98.7) → RGBA (31, 107, 138, 110)
```

Then verify in the viewer: the parcel edges should line up with the building footprints in the tileset and with the terrain features. A uniform shift of tens of metres means the source CRS was wrong; a shift that grows towards the poles means something was computed in degrees as if they were metres; a vertically mirrored layer is the MBTiles row flip.

Keep two operational checks as well. Tile requests should be cacheable — `Cache-Control: public, max-age=31536000, immutable` with the layer version in the path — and the 404 rate should be near zero once `rectangle` is set, which is visible in the CDN logs described in [alerting on tile error rates from CDN logs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/pipeline-observability-and-monitoring/alerting-on-tile-error-rates-from-cdn-logs/).

## Performance Notes

- **Render in parallel per tile.** Tiles are independent, so a process pool over the tile list scales linearly; the spatial index is read-only and can be rebuilt per worker or shared through a fork.
- **Stop at the zoom where boundaries are a pixel apart.** For cadastral parcels that is typically z18–z19; going to z21 quadruples storage twice for detail nobody sees.
- **Cull sub-pixel features** as the renderer does, and consider dropping small parcels entirely below a zoom threshold — at z12 a 200 m² parcel is a fraction of a pixel.
- **PNG for crisp boundaries, WebP for size.** WebP at quality 85 typically halves the bytes with no visible change on flat-colour overlays; serve both with content negotiation if the CDN supports it.
- **Rebuild only what changed.** Keep a per-tile hash of the features that intersect it, and re-render a tile only when that set changes — the same idea as [incremental retiling of changed city blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).

## Common Errors

**The layer is upside down.** The MBTiles row flip was applied twice or not at all, or the URL template uses `{y}` where the tiles are stored with `{reverseY}`. Check one tile at a known coordinate.

**Everything is transparent at low zoom.** The sub-pixel cull removed every feature, because at z10 a parcel is smaller than a pixel. Either stop the layer at a higher minimum zoom or render a dissolved, generalised version for the low levels.

**Edges look ragged.** Supersampling was skipped or the downsample used a nearest filter. Draw at twice the size and resize with `LANCZOS`.

**Tiles are enormous.** Intricate boundaries at high zoom with anti-aliasing produce noisy PNGs. Simplify more aggressively, or quantise the palette — `img.convert("P", palette=Image.ADAPTIVE, colors=32)` often halves the size on flat overlays.

## Frequently Asked Questions

### Why not serve real vector tiles with MapLibre?

Because CesiumJS has no native vector-tile imagery provider, so a vector tile has to be rasterised somewhere anyway — in a client-side canvas, which reintroduces the per-frame cost, or on the server, which is what this page does. If the application is a 2D map, real vector tiles are the better answer.

### Can the raster layer be interactive at all?

Indirectly. A click can query a feature service for the coordinate and highlight the result as a small geometry overlay. That gives one clickable feature at a time without shipping the layer's geometry.

### Does imagery drape on buildings?

No — imagery drapes on terrain only. Anything that must appear on a facade needs classification or geometry, as covered in [classifying 3D Tiles with polygon volumes](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/classifying-3d-tiles-with-polygon-volumes/).

## Related Guides

- [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/) — where imagery fits among the strategies
- [Draping GeoJSON Polygons on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/draping-geojson-polygons-on-3d-tiles/) — the geometry route for smaller layers
- [Automated 3D Tiles Deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — publishing and caching tile output

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
