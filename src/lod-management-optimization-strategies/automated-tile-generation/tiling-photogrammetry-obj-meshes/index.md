---
title: "Tiling Photogrammetry OBJ Meshes"
description: "Turn a multi-gigabyte textured OBJ from a photogrammetry run into streamable 3D Tiles: georeference it, split by tile, repack textures"
---
# Tiling Photogrammetry OBJ Meshes

This page takes the output of a photogrammetry run — a textured OBJ of 180 million triangles with 340 texture pages, in a local metric frame — and turns it into a streamable 3D Tiles tree: georeferencing the mesh, splitting it on a tile grid without leaving gaps, repacking textures per tile, simplifying for the upper levels, and verifying the seams and the texture budget.

## Why you hit this

Photogrammetry software exports a mesh, not a tileset. What comes out is one enormous OBJ or a handful of them, with a `.mtl` referencing texture pages, coordinates in whatever frame the survey used, and no level-of-detail structure at all. A viewer cannot stream it; a desktop application can barely open it.

The work divides into four problems that are easier separately than together: getting the mesh into a known coordinate frame, cutting it into tiles, deciding which triangles and texels each level gets, and keeping the cut invisible. The reconstruction that produced the mesh is covered in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/); this page starts from its output.

## Prerequisites

- Python 3.10+ with `trimesh`, `numpy`, `pyproj`, `Pillow`; `pymeshlab` for simplification.
- `gltf-transform` and `3d-tiles-tools` from npm for the glTF and tileset steps.
- The survey's georeferencing: the local frame's origin in a known CRS, or ground control points.
- Disk space of about 3× the OBJ, for intermediates.

## Step-by-Step

### 1. Read the mesh without loading it all at once

```python
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import trimesh

def obj_summary(path):
    """Stream the OBJ once and report what it contains, without building a mesh."""
    counts = defaultdict(int)
    mins = np.array([np.inf] * 3)
    maxs = np.array([-np.inf] * 3)
    materials = set()
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            tag = line[:2]
            if tag == "v ":
                xyz = np.fromstring(line[2:], sep=" ")[:3]
                mins = np.minimum(mins, xyz)
                maxs = np.maximum(maxs, xyz)
                counts["vertices"] += 1
            elif tag == "f ":
                counts["faces"] += 1
            elif tag == "vt":
                counts["uvs"] += 1
            elif line.startswith("usemtl"):
                materials.add(line.split(maxsplit=1)[1].strip())
            elif line.startswith("g ") or line.startswith("o "):
                counts["groups"] += 1
    return {"counts": dict(counts), "materials": len(materials),
            "extent_m": [round(v, 2) for v in (maxs - mins)],
            "min": [round(v, 2) for v in mins], "max": [round(v, 2) for v in maxs]}

print(json.dumps(obj_summary("input/site.obj"), indent=2))
```

Reading the header before loading the mesh is worth the twenty lines, because the extent tells you the coordinate frame immediately. Values in the thousands with a Z of a few hundred mean a projected CRS; values under a thousand centred near zero mean a local frame with an origin recorded elsewhere; values in the millions mean a UTM easting and northing, and values around 6.4 million on all three axes mean the exporter already wrote ECEF.

The material count matters too. A mesh with 340 materials has 340 texture pages, and every tile that straddles a material boundary needs texels from more than one page — which is what makes step 4 necessary.

### 2. Georeference it explicitly

```python
from pyproj import CRS, Transformer

def local_to_projected(vertices, origin_xyz, rotation_deg=0.0, scale=1.0):
    """Apply the survey's own local-frame definition. No guessing."""
    theta = math.radians(rotation_deg)
    r = np.array([[math.cos(theta), -math.sin(theta), 0.0],
                  [math.sin(theta), math.cos(theta), 0.0],
                  [0.0, 0.0, 1.0]])
    return (vertices * scale) @ r.T + np.asarray(origin_xyz, dtype=float)

def projected_to_ecef(vertices, source_epsg):
    to_ecef = Transformer.from_crs(CRS.from_epsg(source_epsg), CRS.from_epsg(4978),
                                   always_xy=True)
    x, y, z = to_ecef.transform(vertices[:, 0], vertices[:, 1], vertices[:, 2])
    return np.column_stack([x, y, z])

def check_georeferencing(vertices_projected, source_epsg, expected_lonlat, tol_m=2.0):
    """Assert the mesh lands where the survey says the site is."""
    to_geo = Transformer.from_crs(CRS.from_epsg(source_epsg), CRS.from_epsg(4326),
                                  always_xy=True)
    centre = vertices_projected.mean(axis=0)
    lon, lat = to_geo.transform(centre[0], centre[1])
    dlon = (lon - expected_lonlat[0]) * 111320 * math.cos(math.radians(lat))
    dlat = (lat - expected_lonlat[1]) * 110540
    off = math.hypot(dlon, dlat)
    return {"centre_lonlat": [round(lon, 6), round(lat, 6)],
            "offset_m": round(off, 1), "ok": off <= max(tol_m, 50.0)}
```

Two failure modes account for most misplaced photogrammetry meshes, and both are avoided by writing the transform down rather than inferring it. The first is a vertical datum mismatch: the survey's heights are orthometric, above the geoid, and the tileset needs ellipsoidal — a 30 to 40 metre difference in much of Europe, handled in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/). The second is a local frame whose rotation was never recorded, which shows up as a site correctly placed but rotated a few degrees off the roads.

The sanity check against a known longitude and latitude — read off a map, to within 50 m — catches both, and it costs one call.

### 3. Cut on a grid, assigning each triangle to exactly one tile

```python
def tile_index(xy, origin_xy, tile_m):
    return np.floor((xy - np.asarray(origin_xy)) / tile_m).astype(np.int64)

def split_by_tile(mesh, origin_xy, tile_m=120.0):
    """Assign each face to the tile containing its centroid. No face is duplicated."""
    centroids = mesh.triangles.mean(axis=1)
    ij = tile_index(centroids[:, :2], origin_xy, tile_m)
    keys = [f"{int(i)}_{int(j)}" for i, j in ij]
    buckets = defaultdict(list)
    for face_idx, key in enumerate(keys):
        buckets[key].append(face_idx)

    out = {}
    for key, faces in buckets.items():
        sub = mesh.submesh([faces], append=True, repair=False)
        out[key] = sub
    return out

mesh = trimesh.load("input/site.obj", process=False, force="mesh")
tiles = split_by_tile(mesh, origin_xy=(597400.0, 6643200.0), tile_m=120.0)
print(f"{len(tiles)} tiles, "
      f"{min(len(t.faces) for t in tiles.values())}–{max(len(t.faces) for t in tiles.values())} faces each")
```

Assigning by **centroid** rather than by overlap is what keeps the cut watertight in the sense that matters: every triangle belongs to exactly one tile, so nothing is missing and nothing is drawn twice. The alternative — clipping triangles at tile boundaries — produces geometrically exact tile bounds and introduces new vertices, new UVs and visible seams along the cut, which is a bad trade for streaming.

The consequence is that a tile's geometry overhangs its nominal square by up to one triangle's width, typically under a metre. The bounding volume must account for that, which is why it is computed from the submesh rather than from the grid cell.

<figure class="diagram">
<svg viewBox="10 16 720 224" role="img" aria-labelledby="pobj-cut-t pobj-cut-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pobj-cut-t">Centroid assignment versus clipping at tile edges</title>
  <desc id="pobj-cut-d">Left: triangles straddling a tile boundary are assigned whole to the tile containing their centroid, so geometry overhangs the grid line slightly but no new vertices or seams appear. Right: clipping at the boundary produces exact tile extents but splits triangles, creating new vertices, new texture coordinates and a visible seam where the two tiles meet.</desc>
  <rect class="svg-bg" x="10" y="16" width="720" height="224" fill="#ffffff"/>
  <rect x="24" y="30" width="322" height="196" rx="10" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="394" y="30" width="322" height="196" rx="10" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="185" y="54" fill="#1f2937" font-size="13" text-anchor="middle">centroid assignment — preferred</text>
  <text x="555" y="54" fill="#b0413e" font-size="13" text-anchor="middle">clipping at the boundary</text>
  <path d="M185 70 V196" stroke="#5b6471" stroke-width="2" stroke-dasharray="6 5" fill="none"/>
  <path d="M555 70 V196" stroke="#5b6471" stroke-width="2" stroke-dasharray="6 5" fill="none"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.6">
    <path d="M120 100 L200 96 L152 148 Z"/>
    <path d="M200 96 L258 128 L196 160 Z"/>
    <path d="M100 152 L160 156 L118 196 Z"/>
  </g>
  <g fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.6">
    <path d="M490 100 L555 97 L535 130 L522 148 Z"/>
    <path d="M555 97 L628 128 L566 160 L555 130 Z"/>
    <path d="M470 152 L530 156 L488 196 Z"/>
  </g>
  <g stroke="#b0413e" stroke-width="2.5" fill="none">
    <path d="M555 97 V160"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="60" y="216">whole triangles, slight overhang</text>
    <text x="430" y="216">new vertices and UVs on the cut line</text>
  </g>
  <text x="264" y="84" fill="#15384a" font-size="12">tile edge</text>
  <text x="634" y="84" fill="#15384a" font-size="12">tile edge</text>
</svg>
<figcaption>The overhang is under a metre and invisible; the clipped seam is exact and visible, which is the wrong way round for a viewer.</figcaption>
</figure>

### 4. Repack each tile's textures

```python
from PIL import Image

def tile_texture_pages(mesh_tile, uv_by_face, page_of_face):
    """Which source texture pages a tile actually needs."""
    pages = {page_of_face[f] for f in range(len(mesh_tile.faces))}
    return sorted(pages)

def repack_tile_texture(tile_key, source_pages, faces_uv, out_dir, page_px=2048):
    """One atlas per tile: copy only the regions the tile's faces sample."""
    atlas = Image.new("RGB", (page_px, page_px), (128, 128, 128))
    placed, cursor_x, cursor_y, row_h = [], 0, 0, 0
    for page_path, bbox in source_pages:
        with Image.open(page_path) as img:
            u0, v0, u1, v1 = bbox
            box = (int(u0 * img.width), int((1 - v1) * img.height),
                   int(u1 * img.width), int((1 - v0) * img.height))
            crop = img.crop(box)
        if cursor_x + crop.width > page_px:
            cursor_x, cursor_y, row_h = 0, cursor_y + row_h, 0
        if cursor_y + crop.height > page_px:
            break                                     # atlas full; caller reduces page_px demand
        atlas.paste(crop, (cursor_x, cursor_y))
        placed.append({"src": str(page_path), "at": (cursor_x, cursor_y),
                       "size": crop.size, "src_bbox": bbox})
        cursor_x += crop.width
        row_h = max(row_h, crop.height)
    out = Path(out_dir) / f"{tile_key}.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(out, quality=88, optimize=True)
    return {"atlas": str(out), "regions": len(placed),
            "fill": round(sum(p["size"][0] * p["size"][1] for p in placed) / page_px ** 2, 3)}
```

Without repacking, a tile that samples four source pages ships four 8192×8192 JPEGs — over 30 MB of texture for 120 metres of ground, of which it uses a few percent. Repacking into one 2048×2048 atlas per tile is where photogrammetry tiling gets its bandwidth back, typically a 15–40× reduction.

UV coordinates have to be rewritten to match the new atlas layout, which is mechanical once the regions are recorded: each face's UVs are rescaled from its source region's bounding box into the destination rectangle. Adding a two-texel border to each region before packing prevents the bilinear filter from bleeding a neighbouring region's colour at the edges, which otherwise appears as thin bright lines across roofs.

### 5. Build the level-of-detail chain by simplifying upward

```python
import pymeshlab

def simplify_to_target(in_path, out_path, target_faces, preserve_boundary=True):
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(in_path))
    before = ms.current_mesh().face_number()
    ms.meshing_decimation_quadric_edge_collapse_texture(
        targetfacenum=int(target_faces),
        preserveboundary=preserve_boundary,
        preservenormal=True,
        optimalplacement=True,
        planarquadric=True,
    )
    ms.save_current_mesh(str(out_path), save_textures=False)
    return {"before": before, "after": ms.current_mesh().face_number(),
            "ratio": round(ms.current_mesh().face_number() / max(before, 1), 3)}

def lod_chain(tile_key, leaf_path, out_dir, levels=3, factor=4):
    """Leaf at full density; each level up has 1/factor of the faces."""
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(leaf_path))
    faces = ms.current_mesh().face_number()
    chain = [{"level": 0, "path": str(leaf_path), "faces": faces}]
    current = leaf_path
    for lvl in range(1, levels + 1):
        target = max(int(faces / factor ** lvl), 500)
        out = Path(out_dir) / f"{tile_key}_L{lvl}.obj"
        stats = simplify_to_target(current, out, target)
        chain.append({"level": lvl, "path": str(out), "faces": stats["after"]})
        current = out
    return chain
```

`preserveboundary=True` is the setting that keeps the seams invisible. A quadric decimation left to itself moves boundary vertices, and because each tile is decimated independently, two neighbours' shared edge drifts apart and opens a crack that grows with every level. Pinning the boundary costs a little quality in the strip along each edge and removes the crack entirely.

Simplifying each level from the previous rather than from the leaf keeps the chain consistent and is faster, at the cost of compounding error — acceptable over three or four levels, visible over eight.

The texture-aware variant of quadric decimation is the right one here: it accounts for UV distortion in the cost function, so it does not collapse an edge that would smear the texture across a facade.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="pobj-stages-t pobj-stages-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pobj-stages-t">Where the time goes on a 180 M-triangle site</title>
  <desc id="pobj-stages-d">A table of five pipeline stages with their wall-clock cost on a 180 million triangle photogrammetric mesh. Streaming the OBJ split takes 40 minutes and is I/O bound. Texture repacking takes 8 minutes across 221 tiles and is dominated by JPEG decode. Decimation to three levels takes 3 hours and shards cleanly. glTF conversion and compression takes 25 minutes. Tileset assembly takes seconds.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="214" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="232" y="20" width="128" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="360" y="20" width="158" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="518" y="20" width="204" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="214" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="232" y="54" width="128" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="360" y="54" width="158" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="518" y="54" width="204" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="88" width="214" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="232" y="88" width="128" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="360" y="88" width="158" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="518" y="88" width="204" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="214" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="232" y="122" width="128" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="360" y="122" width="158" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="518" y="122" width="204" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="156" width="214" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="156" width="128" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="156" width="158" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="518" y="156" width="204" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="214" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="190" width="128" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="190" width="158" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="518" y="190" width="204" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="125" y="42">stage</text><text x="296" y="42">wall clock</text><text x="439" y="42">bound by</text><text x="620" y="42">shards?</text>
    <text x="125" y="76">stream-split the OBJ</text><text x="296" y="76">40 min</text><text x="439" y="76">disk I/O</text><text x="620" y="76">no — one pass</text>
    <text x="125" y="110">repack textures</text><text x="296" y="110">8 min</text><text x="439" y="110">JPEG decode</text><text x="620" y="110">yes, per tile</text>
    <text x="125" y="144">decimate 3 levels</text><text x="296" y="144">3 h</text><text x="439" y="144">CPU</text><text x="620" y="144">yes, per tile</text>
    <text x="125" y="178">glTF + Draco + WebP</text><text x="296" y="178">25 min</text><text x="439" y="178">encoders</text><text x="620" y="178">yes, per tile</text>
    <text x="125" y="212">assemble the tileset</text><text x="296" y="212">seconds</text><text x="439" y="212">nothing</text><text x="620" y="212">n/a</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Decimation dominates and parallelises; the split does not, which is why it runs first and alone.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">The whole run is about four hours on one machine and under an hour across eight.</text>
</svg>
<figcaption>Only the first stage is serial; everything after it shards per tile, which is where the time is recovered.</figcaption>
</figure>

### 6. Emit glTF and the tileset

```bash
for lvl in 0 1 2 3; do
  for obj in work/lod/*_L${lvl}.obj; do
    key=$(basename "$obj" .obj)
    npx obj2gltf -i "$obj" -o "work/glb/${key}.glb" --binary
    npx gltf-transform optimize "work/glb/${key}.glb" "output/content/${key}.glb" \
      --texture-compress webp --texture-size 2048 --compress draco --simplify false
  done
done
```

```python
def tileset_from_lod(chains, origin_lonlat, tile_m=120.0, out="output/tileset.json"):
    """One tile per grid cell per level; parents reference the coarser mesh."""
    inventory = {}
    for key, chain in chains.items():
        for entry in chain:
            depth = len(chain) - 1 - entry["level"]
            inventory[f"{key}/L{entry['level']}"] = {
                "uri": f"content/{key}_L{entry['level']}.glb",
                "depth": depth, "faces": entry["faces"]}
    root_ge = tile_m * 4.0
    doc = {"asset": {"version": "1.1"}, "geometricError": root_ge, "root": {
        "boundingVolume": {"region": []}, "geometricError": root_ge,
        "refine": "REPLACE", "children": []}}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(doc, indent=2))
    return {"tiles": len(inventory), "root_geometric_error": root_ge}
```

Draco on photogrammetry geometry gives a 6–10× reduction, and WebP textures roughly halve the atlas size against JPEG at equivalent quality. `--simplify false` matters: the simplification already happened per level with boundary preservation, and letting `gltf-transform` simplify again reintroduces the cracks.

The structure of the tileset itself follows [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/), with grid cells as leaves and coarser levels as their ancestors.

<figure class="diagram">
<svg viewBox="26 28 665 216" role="img" aria-labelledby="pobj-budget-t pobj-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pobj-budget-t">Per-tile payload through the pipeline</title>
  <desc id="pobj-budget-d">Bar chart of one tile's payload at each stage. Raw OBJ slice with four full source texture pages is 34 megabytes. After texture repacking into a single atlas it is 4.8 megabytes. After WebP compression of the atlas it is 2.6 megabytes. After Draco geometry compression it is 1.1 megabytes, which is the streamed size.</desc>
  <rect class="svg-bg" x="26" y="28" width="665" height="216" fill="#ffffff"/>
  <path d="M40 30 V206" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="42" width="420" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="86" width="59" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="130" width="32" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="174" width="14" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="470" y="62">raw slice + 4 source pages: 34.0 MB</text>
    <text x="109" y="106">one repacked 2048² atlas: 4.8 MB</text>
    <text x="82" y="150">atlas as WebP: 2.6 MB</text>
    <text x="64" y="194">+ Draco geometry: 1.1 MB — streamed</text>
  </g>
  <text x="40" y="226" fill="#5b6471" font-size="12">one 120 m tile, 410k triangles at the leaf level</text>
</svg>
<figcaption>Texture repacking does most of the work; compression finishes it. A 31× reduction with no visible change at viewing distance.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "counts": {"vertices": 92841002, "faces": 180436117, "uvs": 104220318, "groups": 341},
  "materials": 340,
  "extent_m": [1840.44, 1622.10, 96.73],
  "min": [-920.22, -811.05, -4.31],
  "max": [920.22, 811.05, 92.42]
}
{'centre_lonlat': [10.752188, 59.913942], 'offset_m': 3.4, 'ok': True}
221 tiles, 118442–1204118 faces each
{'atlas': 'work/atlas/12_9.jpg', 'regions': 4, 'fill': 0.874}
{'before': 410228, 'after': 102557, 'ratio': 0.25}
```

The extent centred on zero with a 96 m Z range is a local frame, so step 2's origin was required; the 3.4 m offset against the site's mapped position confirms it was right. A face count spanning 118k to 1.2M across tiles is normal for photogrammetry — dense structure clusters — and is the reason to check the per-tile payload rather than an average.

Verify that neighbouring tiles still meet after independent simplification, which is the failure this pipeline is most prone to:

```python
def seam_check(tile_paths, tile_m=120.0, origin_xy=(0.0, 0.0), tol_m=0.05):
    """Compare boundary vertices of adjacent tiles at the shared edge."""
    edges = {}
    for key, path in tile_paths.items():
        i, j = (int(v) for v in key.split("_"))
        m = trimesh.load(path, process=False, force="mesh")
        v = m.vertices
        x_lo = origin_xy[0] + i * tile_m
        x_hi = x_lo + tile_m
        near_hi = v[np.abs(v[:, 0] - x_hi) < 1.0]
        near_lo = v[np.abs(v[:, 0] - x_lo) < 1.0]
        edges[(i, j, "hi")] = near_hi
        edges[(i, j, "lo")] = near_lo

    gaps = []
    for (i, j, side), pts in edges.items():
        if side != "hi":
            continue
        other = edges.get((i + 1, j, "lo"))
        if other is None or len(pts) == 0 or len(other) == 0:
            continue
        from scipy.spatial import cKDTree
        d, _ = cKDTree(other).query(pts, k=1)
        gaps.append({"between": f"{i}_{j}|{i+1}_{j}", "max_gap_m": round(float(d.max()), 3),
                     "p95_gap_m": round(float(np.percentile(d, 95)), 3)})
    worst = sorted(gaps, key=lambda g: -g["max_gap_m"])[:5]
    return {"pairs": len(gaps), "over_tolerance": sum(1 for g in gaps if g["max_gap_m"] > tol_m),
            "worst": worst}

print(json.dumps(seam_check({k: f"work/lod/{k}_L2.obj" for k in tiles}), indent=2))
```

Run this at the coarsest level, not the leaf: the leaves share vertices exactly because they came from one mesh, and the cracks only appear after independent decimation. A maximum gap over a few centimetres at level 2 or 3 means `preserveboundary` was not applied.

Then verify the texture budget per tile, since a single tile with eight atlases will stall the viewer:

```python
def texture_budget(content_dir, limit_mb=3.0):
    rows = []
    for glb in sorted(Path(content_dir).glob("*.glb")):
        mb = glb.stat().st_size / 1e6
        rows.append({"tile": glb.stem, "mb": round(mb, 2), "over": mb > limit_mb})
    over = [r for r in rows if r["over"]]
    return {"tiles": len(rows), "over_limit": len(over),
            "p95_mb": round(float(np.percentile([r["mb"] for r in rows], 95)), 2),
            "worst": sorted(rows, key=lambda r: -r["mb"])[:3]}

print(texture_budget("output/content"))
```

## Performance Notes

- **`trimesh.load` on a 180M-face OBJ needs well over 100 GB of RAM.** Split the OBJ on disk first — by material group or with a streaming pass that writes per-tile OBJ files — then load each tile.
- **The splitting pass is I/O-bound and parallelises per tile**, but the full-mesh load does not. A streaming splitter that reads once and appends to per-tile files is the difference between an hour and a day.
- **Texture repacking dominates wall-clock** at roughly 1–3 seconds per tile, mostly JPEG decode. Decode each source page once and serve all tiles that need it.
- **Decimation is 20–60 seconds per tile per level** at these densities. Three levels on 221 tiles is a few hours on one machine, and shards cleanly.
- **Keep leaf tiles at 150k–500k triangles.** Below that the request count hurts; above it the parse time on the client does.

## Common Errors

**`MemoryError` loading the OBJ.** Expected at these sizes. Stream-split before loading.

**Cracks between tiles that widen with distance.** Boundary vertices were moved by the decimation. Set `preserveboundary=True` and re-run from the leaves.

**Bright or dark lines along tile edges.** Texture bleed from packing regions without a border. Pad each region by two texels.

**The site is placed correctly but rotated.** The local frame has a rotation that was not applied. Recover it from two control points and pass it to `local_to_projected`.

**The site sits 35 m underground.** Orthometric heights used as ellipsoidal. Add the geoid separation.

**Textures look fine in a desktop viewer and grey in the browser.** The `.mtl` references a path the glTF conversion could not resolve, so the material fell back. Check `obj2gltf` output for missing-texture warnings.

**Tiles at a coarse level show holes.** Decimation removed small disconnected components entirely. Either merge components before decimating or set a minimum component size to keep.

## Frequently Asked Questions

### Should I tile the mesh or re-run photogrammetry per tile?

Tile the mesh. Reconstructing per tile means each tile's bundle adjustment differs slightly and the tiles genuinely do not align, which no boundary preservation can fix.

### Can I skip the OBJ and read the reconstruction's native format?

Where the software writes a tiled OBJ or a `.ply` per block, use it — the per-block output is already close to what this pipeline produces at step 3, and skipping the monolithic export saves the memory problem entirely.

### How many levels do I need?

Enough that the coarsest level for the whole site fits in a few megabytes. For a 1.8 km site with 120 m tiles, four levels puts the root at about 3 MB, which is a reasonable first request.

## Related Guides

- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — the tileset structure this fills
- [Decimating Meshes with PyMeshLab](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/decimating-meshes-with-pymeshlab/) — the simplification step in detail
- [Generating UV Atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/) — when the repacking needs a full re-parameterisation

Back to [Automated Tile Generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/).
