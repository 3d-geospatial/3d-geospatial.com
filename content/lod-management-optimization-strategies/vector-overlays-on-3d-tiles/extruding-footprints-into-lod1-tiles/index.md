# Extruding Footprints into LOD1 Tiles

This page turns a footprint layer — buildings, zoning envelopes, planned volumes — into an LOD1 3D Tiles overlay that streams and culls like any other tileset: sampling a base height per polygon from a DTM, extruding prisms with `trimesh`, sharding by quadkey, writing one glTF and one tileset per shard in EPSG:4978, and checking the result against the source attributes.

## Why you hit this

Draped polygons and classification volumes stop being practical somewhere around ten thousand features, and they cannot show height at all. A city's building footprints with a height attribute, an entire zoning scheme, or a flood model's volumes are all datasets where the overlay has to become geometry — tiled, so the client only loads what is in view. The judgement about when to cross that line is in [vector overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/); this page is the pipeline for after you have.

## Prerequisites

- Python 3.10+ with `geopandas>=0.14`, `shapely>=2.0`, `rasterio>=1.3`, `trimesh>=4.0`, `pyproj>=3.6`, `mercantile>=1.2`.
- Footprints in a projected CRS with a height column — EPSG:25832 and metres in the examples — and a stable identifier.
- A DTM covering the extent, in the same horizontal CRS, with heights in the same vertical datum as the height column's reference (DHHN2016 here).

## Step-by-Step

### 1. Sample a base height for every footprint

```python
import geopandas as gpd
import numpy as np
import rasterio

gdf = gpd.read_file("footprints.gpkg").to_crs(25832)
gdf = gdf[gdf.geometry.is_valid & (gdf.geometry.area > 4.0)]

with rasterio.open("dtm_1m.tif") as dtm:
    assert dtm.crs.to_epsg() == 25832, "DTM must match the footprint CRS"
    bases = []
    for geom in gdf.geometry:
        # sample the DTM around the footprint boundary, not just at the centroid
        pts = [geom.exterior.interpolate(d, normalized=True).coords[0] for d in np.linspace(0, 1, 24)]
        vals = np.array([v[0] for v in dtm.sample(pts)], dtype=float)
        vals = vals[np.isfinite(vals) & (vals > dtm.nodata if dtm.nodata is not None else True)]
        bases.append(float(np.percentile(vals, 10)) if len(vals) else np.nan)

gdf["base_z"] = bases
missing = gdf["base_z"].isna().sum()
gdf = gdf.dropna(subset=["base_z"])
print(f"{len(gdf)} footprints with a base height, {missing} dropped for missing DTM coverage")
```

Sampling around the boundary rather than at the centroid is what keeps a building on a slope from floating. The 10th percentile of the boundary samples approximates the downhill ground level, which is the conventional base for an LOD1 prism; the mean would bury the downhill wall and the minimum would exaggerate the prism on rough ground. Dropping features with no DTM coverage is deliberate — a prism with a guessed base is worse than a missing prism, because nobody can tell it is wrong.

<figure class="diagram">
<svg viewBox="46 24 668 234" role="img" aria-labelledby="ext-base-t ext-base-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ext-base-t">Choosing the base height on a slope</title>
  <desc id="ext-base-d">A footprint on sloping terrain, seen in section. A base at the centroid height leaves the downhill corner floating and buries the uphill corner. A base at the minimum boundary height floats the whole prism over most of the site. The tenth percentile of boundary samples sits just above the lowest corner and gives a prism that meets the ground at its downhill edge.</desc>
  <rect class="svg-bg" x="46" y="24" width="668" height="234" fill="#ffffff"/>
  <path d="M60 200 L700 140" fill="none" stroke="#4f7a4d" stroke-width="3"/>
  <rect x="180" y="84" width="150" height="102" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="400" y="60" width="150" height="102" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <path d="M180 186 H330" fill="none" stroke="#b0413e" stroke-width="2.5" stroke-dasharray="5 4"/>
  <path d="M400 162 H550" fill="none" stroke="#4f7a4d" stroke-width="2.5" stroke-dasharray="5 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="255" y="76">base at centroid height</text>
    <text x="475" y="52">base at 10th percentile</text>
    <text x="255" y="212">floats uphill, buried downhill</text>
    <text x="475" y="196">meets the ground downhill</text>
  </g>
  <text x="380" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">The prism has one base height; the terrain under it does not.</text>
</svg>
<figcaption>Any single base height is a compromise on a slope. Sampling the boundary and taking a low percentile makes the compromise explicit and repeatable.</figcaption>
</figure>

### 2. Assign each footprint to a shard

```python
import mercantile
from pyproj import Transformer

SHARD_ZOOM = 15
to_wgs84 = Transformer.from_crs(25832, 4326, always_xy=True)

def shard_of(geom):
    lon, lat = to_wgs84.transform(geom.centroid.x, geom.centroid.y)
    return mercantile.quadkey(mercantile.tile(lon, lat, SHARD_ZOOM))

gdf["shard"] = gdf.geometry.apply(shard_of)
counts = gdf["shard"].value_counts()
print(f"{len(counts)} shards; features per shard: median {int(counts.median())}, max {counts.max()}")
```

Assigning by centroid keeps each building in exactly one shard, which matters because a prism split across two shards would be drawn twice at the boundary. Zoom 15 gives shards a few hundred metres across; the trade-offs are the same as for any tiling job and are covered in [choosing shard sizes for city-scale tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/choosing-shard-sizes-for-city-scale-tiling/).

### 3. Extrude and place each shard's geometry

```python
import trimesh
from trimesh.creation import extrude_polygon

ecef = Transformer.from_crs("EPSG:25832+7837", "EPSG:4978", always_xy=True)

def enu_matrix(lon, lat, x0, y0, z0):
    lam, phi = np.radians(lon), np.radians(lat)
    east = np.array([-np.sin(lam), np.cos(lam), 0.0])
    north = np.array([-np.sin(phi) * np.cos(lam), -np.sin(phi) * np.sin(lam), np.cos(phi)])
    up = np.array([np.cos(phi) * np.cos(lam), np.cos(phi) * np.sin(lam), np.sin(phi)])
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = east, north, up, (x0, y0, z0)
    return m

def shard_mesh(rows):
    """Extrude every footprint in a shard and return (glTF-ready mesh, tile transform)."""
    cx, cy = rows.geometry.centroid.x.mean(), rows.geometry.centroid.y.mean()
    cz = float(rows["base_z"].min())
    lon0, lat0 = to_wgs84.transform(cx, cy)
    x0, y0, z0 = ecef.transform(cx, cy, cz)
    M = enu_matrix(lon0, lat0, x0, y0, z0)
    M_inv = np.linalg.inv(M)

    parts = []
    for _, r in rows.iterrows():
        height = float(r["height_m"])
        if not (1.0 < height < 300.0):
            continue
        prism = extrude_polygon(r.geometry, height=height)
        v = np.asarray(prism.vertices, dtype=np.float64)
        v[:, 2] += r["base_z"]                                   # prisms start at z = 0
        X, Y, Z = ecef.transform(v[:, 0], v[:, 1], v[:, 2])
        local = (M_inv @ np.column_stack([X, Y, Z, np.ones(len(v))]).T).T[:, :3]
        prism.vertices = np.column_stack([local[:, 0], local[:, 2], -local[:, 1]])   # glTF y-up
        prism.metadata["name"] = str(r["building_id"])
        parts.append(prism)

    merged = trimesh.util.concatenate(parts)
    return merged, M, len(parts)
```

Three details carry the correctness of the whole tileset. Prisms are extruded from z = 0 and shifted by the sampled base, because `extrude_polygon` knows nothing about elevation. Coordinates go through ECEF and back through the inverse of the tile matrix, so the local frame is a true tangent plane rather than a projected approximation. And the axis swap to `(e, u, −n)` matches the y-up convention 3D Tiles applies to glTF content — the same reasoning as in [transforming IFC coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/).

### 4. Write glTF and tileset per shard

```python
import json
from pathlib import Path

out = Path("tiles/zoning"); out.mkdir(parents=True, exist_ok=True)
children = []

for shard, rows in gdf.groupby("shard"):
    mesh, M, n = shard_mesh(rows)
    mesh.export(out / f"{shard}.glb")

    local = np.asarray(mesh.vertices, dtype=np.float64)
    enu = np.column_stack([local[:, 0], -local[:, 2], local[:, 1]])     # back to e, n, u for the box
    centre = (enu.max(axis=0) + enu.min(axis=0)) / 2
    half = (enu.max(axis=0) - enu.min(axis=0)) / 2
    diag = float(np.linalg.norm(half) * 2)

    children.append({
        "transform": M.T.flatten().tolist(),
        "boundingVolume": {"box": [*centre.tolist(), half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]]},
        "geometricError": max(diag / 16.0, 4.0),
        "content": {"uri": f"{shard}.glb"},
    })
    print(f"shard {shard}: {n} prisms, {len(mesh.faces):,} triangles")

minx, miny, maxx, maxy = gdf.total_bounds
west, south = to_wgs84.transform(minx, miny)
east, north = to_wgs84.transform(maxx, maxy)
region = [np.radians(west), np.radians(south), np.radians(east), np.radians(north),
          float(gdf["base_z"].min()) - 5.0, float((gdf["base_z"] + gdf["height_m"]).max()) + 5.0]

root_error = max(c["geometricError"] for c in children) * 4
(out / "tileset.json").write_text(json.dumps({
    "asset": {"version": "1.1", "tilesetVersion": "zoning-2026-09"},
    "geometricError": root_error * 2,
    "root": {
        "boundingVolume": {"region": region},
        "geometricError": root_error,
        "refine": "ADD",
        "children": children,
    },
}, indent=2))
```

Each shard is its own child with its own transform, so the root needs a bounding volume that contains them all — a `region` computed from the layer's geographic extent is the clean way, because a box in one shard's frame cannot contain another's. The merging patterns, including grouping when the shard count grows, are in [merging shard tilesets into a root tileset](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/merging-shard-tilesets-into-a-root-tileset/).

<figure class="diagram">
<svg viewBox="-4 66 758 162" role="img" aria-labelledby="ext-pipe-t ext-pipe-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ext-pipe-t">Footprints to an overlay tileset</title>
  <desc id="ext-pipe-d">Footprints in a projected CRS are given a base height sampled from the digital terrain model, assigned to quadkey shards by centroid, extruded to prisms, converted through Earth-centred coordinates into a local east-north-up frame per shard, and written as one glTF per shard with a tileset that references them by transform and bounding box.</desc>
  <rect class="svg-bg" x="-4" y="66" width="758" height="162" fill="#ffffff"/>
  <defs>
    <marker id="ext-pipe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="80" width="110" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="80" width="110" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="290" y="80" width="110" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="80" width="130" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="590" y="80" width="150" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="150" y="170" width="250" height="44" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ext-pipe-arrow)">
    <path d="M120 110 H148"/><path d="M260 110 H288"/><path d="M400 110 H428"/><path d="M560 110 H588"/>
    <path d="M275 168 V142"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="105">footprints</text><text x="65" y="123">+ height</text>
    <text x="205" y="105">base_z from</text><text x="205" y="123">the DTM</text>
    <text x="345" y="105">shard by</text><text x="345" y="123">quadkey z15</text>
    <text x="495" y="105">extrude, to ENU</text><text x="495" y="123">via EPSG:4978</text>
    <text x="665" y="105">glb + tileset</text><text x="665" y="123">per shard</text>
    <text x="275" y="196">drop features with no DTM coverage</text>
  </g>
</svg>
<figcaption>Every stage is deterministic, so the whole overlay can be rebuilt from the source layer whenever the footprints or the heights change.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="26 30 847 194" role="img" aria-labelledby="ext-tri-t ext-tri-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ext-tri-t">Triangle count per prism against footprint complexity</title>
  <desc id="ext-tri-d">Bars comparing triangles per extruded prism. A simplified rectangular footprint with five vertices gives about sixteen triangles. A typical simplified cadastral footprint with twelve vertices gives about forty. An unsimplified survey footprint with four hundred vertices gives about eight hundred, which is twenty times the geometry for detail no viewer resolves.</desc>
  <rect class="svg-bg" x="26" y="30" width="847" height="194" fill="#ffffff"/>
  <path d="M40 30 V180" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="40" y="44" width="16" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="90" width="40" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="136" width="620" height="30" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="68" y="64">5-vertex rectangle · ~16 triangles</text>
    <text x="92" y="110">12-vertex simplified parcel · ~40 triangles</text>
    <text x="672" y="156">400-vertex survey outline · ~800</text>
  </g>
  <text x="380" y="206" fill="#15384a" font-size="12.5" text-anchor="middle">Simplifying to 0.25 m before extruding is the single largest saving in the whole pipeline.</text>
</svg>
<figcaption>Wall triangles are two per footprint edge, so vertex count drives tile size directly — and cadastral outlines carry far more vertices than a prism needs.</figcaption>
</figure>

### 5. Check the tileset against the source

```python
totals = {"prisms": 0, "triangles": 0}
for c in children:
    mesh = trimesh.load(out / c["content"]["uri"], force="mesh", process=False)
    totals["triangles"] += len(mesh.faces)
totals["prisms"] = int(len(gdf))

expected_volume = float((gdf.geometry.area * gdf["height_m"]).sum())
print(f"{totals['prisms']:,} prisms, {totals['triangles']:,} triangles, "
      f"expected total volume {expected_volume / 1e6:.2f} × 10⁶ m³")

# a prism has 2 caps triangulated plus 2 triangles per wall segment
approx = int(sum(len(g.exterior.coords) * 2 + 4 for g in gdf.geometry))
assert 0.5 * approx < totals["triangles"] < 2.0 * approx, "triangle count far from the prism estimate"
```

Comparing the triangle count with what prism geometry predicts catches the two silent failures of a run like this: footprints that were skipped by the height filter, and polygons whose interiors triangulated into hundreds of triangles because they were invalid. The volume figure is for the report rather than the check, but it is worth printing because a reviewer who knows the district will spot an order-of-magnitude error instantly.

## Expected Output & Verification

```text
18,406 footprints with a base height, 112 dropped for missing DTM coverage
214 shards; features per shard: median 82, max 311
shard 120210233010 : 82 prisms, 3,204 triangles
…
18,406 prisms, 742,118 triangles, expected total volume 24.81 × 10⁶ m³
```

Then verify in the viewer, against the thing the overlay is supposed to align with:

```javascript
const zoning = await Cesium.Cesium3DTileset.fromUrl("/tiles/zoning/tileset.json");
zoning.style = new Cesium.Cesium3DTileStyle({ color: "color('#c46a3d', 0.4)" });
viewer.scene.primitives.add(zoning);
await viewer.zoomTo(zoning);
console.log("tileset ready, memory", (zoning.totalMemoryUsageInBytes / 1048576).toFixed(1), "MiB");
```

The prisms should sit on the terrain with their downhill edges touching it, and the building tileset — if one is loaded — should be inside its zoning prism wherever the zoning permits its height. A systematic 40 m offset means the base heights and the DTM disagree on the vertical datum; a rotation means the ENU matrix was flattened row-major.

## Performance Notes

- **Extrusion is cheap, triangulation of complex footprints is not.** Simplify footprints to 0.25 m before extruding; a cadastral polygon with 400 vertices makes a prism with 800 wall triangles that no viewer needs.
- **One glTF per shard, one mesh per shard.** Concatenating prisms into a single mesh per shard is what keeps draw calls proportional to shards rather than to buildings.
- **Sample the DTM in one pass per shard** with windowed reads rather than per-polygon `sample` calls; on a city this is the difference between minutes and an hour.
- **Expect about 40 triangles per simple prism** and size the tiles accordingly: a shard of 300 buildings is around 12,000 triangles, which is a comfortable tile.
- **Keep the source layer, not the tiles, as the thing you version.** Rebuilding the overlay from a GeoPackage takes minutes and guarantees consistency; patching tiles does not.

## Common Errors

**Prisms float uniformly a few metres above the terrain.** The DTM is a DSM, so the sampled "ground" is the roof of whatever was there. Check the raster's product type before using it.

**Every prism is at the origin of the Earth.** The tile transform was flattened row-major instead of column-major, or the local frame conversion was skipped so vertices hold ECEF values that the transform then shifts again.

**Some buildings are missing with no error.** They failed the height sanity filter — a null, a zero, or a height in centimetres. Log the rejected identifiers rather than filtering silently.

**`extrude_polygon` raises on a MultiPolygon.** It takes a single polygon. Explode multipart geometries first and extrude each part, keeping the same identifier on all parts.

## Frequently Asked Questions

### Should the overlay carry per-feature metadata?

Yes, if users will click it. Store the identifier and the attributes that drive styling as feature metadata, so the viewer can style and query without a round trip — the mechanics are in [attaching EXT_structural_metadata to building tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/attaching-ext-structural-metadata-to-building-tiles/).

### Can I build an LOD hierarchy for the overlay?

For prisms it is rarely worth it: they are already tiny, and a coarse level would merge buildings into blocks that misrepresent the data. Shard by area and use `ADD` refinement with a single level, which is what the code above writes.

### How does this compare with classification volumes?

Classification paints existing geometry and needs no new tiles, which is better for a few thousand features. Extruded tiles scale to hundreds of thousands, show height honestly, and can be styled and picked per feature, at the cost of a build step.

## Related Guides

- [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/) — where this strategy fits
- [Classifying 3D Tiles with Polygon Volumes](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/classifying-3d-tiles-with-polygon-volumes/) — the alternative for smaller layers
- [Merging Shard Tilesets into a Root Tileset](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/merging-shard-tilesets-into-a-root-tileset/) — when the shard count grows

Back to [Vector Overlays on 3D Tiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/vector-overlays-on-3d-tiles/).
