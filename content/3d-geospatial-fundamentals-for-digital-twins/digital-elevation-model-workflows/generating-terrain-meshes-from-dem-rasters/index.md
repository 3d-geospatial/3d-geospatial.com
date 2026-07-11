# Generating Terrain Meshes from DEM Rasters for Digital Twins

This page turns a **DEM raster** — a GeoTIFF of elevations — into a watertight triangle mesh a digital twin can render, using `rasterio` to read the grid, `numpy` to build vertices, and `trimesh` to triangulate, simplify, and export glTF or OBJ. The path is: read the raster and its nodata mask, sample every valid cell into an XYZ vertex on an explicit CRS (here EPSG:32618 horizontal with vertical EPSG:5703), stitch the regular grid into triangles, optionally decimate to a TIN to cut triangle count, and write a `.glb` or `.obj` ready to drape imagery over.

You hit this the moment a terrain surface has to be geometry rather than a raster: a Cesium or game-engine twin needs a mesh to occlude buildings, cast shadows, and let the camera skim the ground, and analysis like cut-and-fill needs a continuous triangulated surface. The DEM already exists — produced by the [digital elevation model workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) that rasterize, void-fill, and hydro-flatten a point cloud — so this guide starts from a clean GeoTIFF and ends at a mesh, and the two things that break it are mishandled nodata (which pulls spikes down to the fill value) and a CRS left implicit (which mis-scales or mis-places the surface).

<figure class="diagram">
<svg viewBox="0 0 800 300" role="img" aria-labelledby="demmesh-t demmesh-d" xmlns="http://www.w3.org/2000/svg">
  <title id="demmesh-t">DEM raster to triangulated terrain mesh</title>
  <desc id="demmesh-d">A regular grid of DEM cells with elevation values becomes a lattice of vertices, each carrying its easting, northing, and height; adjacent vertices are joined into two triangles per cell to form a continuous terrain mesh.</desc>
  <defs>
    <marker id="demmesh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="30" y="70" width="180" height="160" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#1f6b8a" stroke-width="1">
    <line x1="90" y1="70" x2="90" y2="230"/><line x1="150" y1="70" x2="150" y2="230"/>
    <line x1="30" y1="123" x2="210" y2="123"/><line x1="30" y1="176" x2="210" y2="176"/>
  </g>
  <rect x="330" y="90" width="150" height="120" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#c46a3d"><circle cx="360" cy="120" r="3"/><circle cx="405" cy="120" r="3"/><circle cx="450" cy="120" r="3"/><circle cx="360" cy="165" r="3"/><circle cx="405" cy="165" r="3"/><circle cx="450" cy="165" r="3"/></g>
  <rect x="600" y="70" width="180" height="160" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#4f7a4d" stroke-width="1.5" fill="none">
    <path d="M630 200 L690 110 L750 190 Z"/><path d="M630 200 L690 190 L750 190"/><path d="M690 110 L720 150"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#demmesh-arrow)">
    <line x1="210" y1="150" x2="328" y2="150"/>
    <line x1="480" y1="150" x2="598" y2="150"/>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="120" y="255">DEM cells (GeoTIFF)</text>
    <text x="405" y="235"><tspan x="405" dy="0">vertices</tspan><tspan x="405" dy="15">E, N, H</tspan></text>
    <text x="690" y="255">triangulated mesh</text>
  </g>
  <text x="405" y="70" fill="#5b6471" font-size="12" text-anchor="middle">EPSG:32618 + 5703</text>
</svg>
<figcaption>Each valid DEM cell becomes a vertex carrying easting, northing, and orthometric height; adjacent vertices are stitched into two triangles per cell.</figcaption>
</figure>

## Prerequisites

- Python 3.10+ with `rasterio>=1.3` (bundles GDAL 3.6+), `numpy>=1.24`, `trimesh>=4.0`, and `pyproj>=3.6`. Install via `conda install -c conda-forge rasterio trimesh pyproj numpy` so GDAL and PROJ are one matched build.
- A single-band elevation GeoTIFF with a populated nodata value and a declared CRS. The examples use EPSG:32618 (UTM 18N, metres) for the horizontal grid and orthometric heights on EPSG:5703 (NAVD88), i.e. the compound EPSG:32618+5703. Do not mesh a geographic raster (EPSG:4326) — degree cells are not square metres and the mesh comes out sheared.
- A DEM that is already void-filled. Interior nodata holes become gaps or spikes in the mesh; fill them at the raster stage, not here.
- For very large rasters, enough RAM to hold the elevation array plus roughly three times its vertex-array footprint, or the windowed approach in step 5.

## Step-by-Step

### 1. Read the DEM and its nodata mask

Open the GeoTIFF, read band 1, and capture the affine `transform`, the CRS, and the nodata value together — the transform maps pixel row/column to easting/northing and is what georeferences every vertex.

```python
import rasterio
import numpy as np

with rasterio.open("dtm_18N_filled.tif") as src:
    elev = src.read(1).astype(np.float64)
    transform = src.transform          # affine: (col,row) -> (E,N) in EPSG:32618
    nodata = src.nodata
    crs = src.crs

print("CRS:", crs, "| nodata:", nodata, "| shape:", elev.shape)
assert crs is not None and crs.is_projected, "DEM must be a projected metric CRS (EPSG:32618)"
valid = np.isfinite(elev) & (elev != nodata)
print("valid cells:", int(valid.sum()), "of", elev.size)
```

### 2. Sample the grid into XYZ vertices in the raster CRS

Build one vertex per cell. `rasterio.transform.xy` converts row/column indices to eastings and northings; the height is the elevation value. Keep a lookup from `(row, col)` to vertex index so the triangulation in step 3 can reference neighbours.

```python
from rasterio.transform import xy

rows, cols = np.nonzero(valid)
eastings, northings = xy(transform, rows, cols, offset="center")
heights = elev[rows, cols]

vertices = np.column_stack([eastings, northings, heights]).astype(np.float64)  # EPSG:32618+5703

# Dense index grid: -1 where nodata, else the vertex row in `vertices`.
vidx = np.full(elev.shape, -1, dtype=np.int64)
vidx[rows, cols] = np.arange(len(vertices))
print("vertices:", len(vertices))
```

### 3. Triangulate the regular grid into two triangles per cell

Every 2×2 block of valid vertices forms a quad that splits into two triangles. Vectorize over the grid: take the top-left corner of each cell, require all four corners valid, and emit the two triangles with consistent (counter-clockwise, upward) winding so normals point to the sky.

```python
tl = vidx[:-1, :-1]     # top-left of each cell
tr = vidx[:-1, 1:]
bl = vidx[1:, :-1]
br = vidx[1:, 1:]

full = (tl >= 0) & (tr >= 0) & (bl >= 0) & (br >= 0)   # all four corners present
tl, tr, bl, br = tl[full], tr[full], bl[full], br[full]

faces = np.vstack([
    np.column_stack([tl, bl, br]),   # lower triangle
    np.column_stack([tl, br, tr]),   # upper triangle
])
print("faces:", len(faces))
```

### 4. Build the mesh and (optionally) decimate to a TIN

Assemble a `trimesh` object, shift to a local origin so the large UTM eastings do not overflow float32 on export, and quadric-decimate to a TIN. Terrain is smooth over most of its area, so a target of 20–40% of the faces typically holds sub-decimetre vertical error while shrinking the payload.

```python
import trimesh

origin = vertices.mean(axis=0)                 # local origin in EPSG:32618+5703
mesh = trimesh.Trimesh(vertices=vertices - origin, faces=faces, process=True)
trimesh.repair.fix_normals(mesh)

print("pre-decimation:", len(mesh.faces), "faces, watertight:", mesh.is_watertight)

target = max(5000, len(mesh.faces) // 4)       # ~4x reduction to a TIN
tin = mesh.simplify_quadric_decimation(target)
print("post-decimation:", len(tin.faces), "faces")
np.save("terrain_origin_utm.npy", origin)      # re-add at placement time
```

### 5. Reproject or export with an explicit CRS

For an OBJ handed to CAD, keep the metric EPSG:32618 vertices. For a web twin, reproject the local-origin vertices back to full UTM, then export glTF; the saved origin plus EPSG:32618+5703 is what a downstream tiler bakes into a 3D Tiles root transform. Never let an exporter guess the frame.

```python
from pyproj import Transformer

world = tin.vertices + origin                  # back to EPSG:32618+5703 metres

# OBJ for CAD: metric UTM, Z-up, CRS recorded in a sidecar (.obj carries none itself).
trimesh.Trimesh(world, tin.faces).export("terrain_utm18n.obj")
with open("terrain_utm18n.prj", "w") as f:
    f.write("EPSG:32618+5703")

# glTF for the web twin: keep local metres, tag the source CRS in extras.
glb = trimesh.Trimesh(tin.vertices, tin.faces)
glb.metadata["source_crs"] = "EPSG:32618+5703"
glb.export("terrain.glb")
print("exported terrain_utm18n.obj and terrain.glb")
```

## Expected Output & Verification

After step 5 you have `terrain.glb`, `terrain_utm18n.obj`, and the saved origin. Verify the mesh re-imports, has upward normals, and covers the raster footprint:

```python
import trimesh, numpy as np

m = trimesh.load("terrain_utm18n.obj", force="mesh")
assert m.is_winding_consistent, "winding broke on export"
assert (m.face_normals[:, 2] > 0).mean() > 0.95, "normals not predominantly up — fix winding"

world = m.vertices
print(f"extent E {world[:,0].ptp():.1f} m  N {world[:,1].ptp():.1f} m  "
      f"H {world[:,2].min():.1f}–{world[:,2].max():.1f} m")
```

Expected console output for a 1 km² 0.5 m DTM tile decimated to a TIN:

```text
CRS: EPSG:32618 | nodata: -9999.0 | shape: (2000, 2000)
valid cells: 3987214 of 4000000
vertices: 3987214
faces: 7960000
pre-decimation: 7960000 faces, watertight: False
post-decimation: 1990000 faces
extent E 999.5 m  N 999.5 m  H 4.2–61.8 m
```

The extent should match the raster's ground coverage and the height range should match the DEM's min/max — if heights are off by ~30 m, the vertical datum was dropped somewhere; confirm EPSG:5703 travelled through. A terrain mesh is rarely fully watertight at the tile edge, which is expected; stitch adjacent tiles at delivery rather than forcing a closed volume here.

## Common Errors

**Terrain has deep spikes pulling down to a flat floor.** The nodata sentinel (`-9999`) was meshed as a real elevation because the mask in step 1 missed it — often because the raster stores nodata as NaN, not the header value, or vice versa. Test both: `np.isfinite(elev) & (elev != nodata)`, and confirm `src.nodata` is populated before trusting it.

**`ValueError: could not broadcast` or a sheared, stretched mesh.** The DEM was in a geographic CRS (EPSG:4326), so `rasterio.transform.xy` returned degrees and the vertices span fractions of a unit while heights span tens of metres. Reproject the raster to a projected metric CRS such as EPSG:32618 before meshing; assert `crs.is_projected` as in step 1.

**Model renders far from the origin, jitters, or the exporter warns about precision.** Raw UTM eastings (hundreds of thousands of metres) were written into a float32 glTF buffer. Subtract the local origin before export (step 4) and re-add it only when placing the tile, exactly as the saved `terrain_origin_utm.npy` allows.

## Related Guides

- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — producing the void-filled DEM this mesh starts from
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — keeping EPSG:32618+5703 explicit through the export
- [Mesh Topology Basics for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) — winding, manifoldness, and the repair checks behind step 4
- [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — choosing glTF vs OBJ vs 3D Tiles for the finished terrain

Back to [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/).
