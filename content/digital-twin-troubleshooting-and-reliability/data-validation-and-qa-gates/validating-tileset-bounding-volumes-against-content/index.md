# Validating Tileset Bounding Volumes Against Content

This page proves that every tile in a 3D Tiles tileset has a bounding volume that actually contains its content — decoding each tile's glTF, applying the transform chain correctly, testing containment for region, box and sphere volumes, and also checking the opposite failure, a volume so loose that culling stops working.

## Why you hit this

A bounding volume is a promise the tileset makes to the client: everything in this tile is inside this shape. The client uses it to decide whether the tile is visible and whether to refine, and it never verifies the promise. When the promise is broken the failure is silent and geometry-dependent: buildings vanish when the camera approaches from one direction, a district refuses to refine, a tile flickers in and out.

The opposite failure is quieter still. A volume ten times larger than its content is always "visible", so the client loads tiles that contribute nothing and the frame budget goes on geometry outside the view. Nothing is missing, everything is slow, and the tileset validates cleanly against the specification.

## Prerequisites

- Python 3.10+ with `numpy`, `pygltflib` or `trimesh`, `pyproj`; Node with `3d-tiles-validator` for the specification check.
- A 3D Tiles 1.0 or 1.1 tileset with its content files, from [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/).
- Enough patience to get the transform chain right, because that is where the bugs are.

## Step-by-Step

### 1. Walk the tree and accumulate the transform chain

```python
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

@dataclass
class TileRef:
    path: str                      # "root/0/2" for reporting
    depth: int
    tile: dict
    world_from_tile: np.ndarray    # 4x4, accumulated
    parent_volume: dict | None
    content_uri: str | None

def walk_tileset(tileset_path, base_dir=None):
    """Yield every tile with its accumulated transform and its parent's volume."""
    doc = json.loads(Path(tileset_path).read_text())
    base = Path(base_dir or Path(tileset_path).parent)
    out, external = [], []

    def matrix_of(tile):
        t = tile.get("transform")
        if not t:
            return np.identity(4)
        # 3D Tiles stores column-major; reshape then transpose to row-major.
        return np.asarray(t, dtype=np.float64).reshape(4, 4).T

    def recurse(tile, path, depth, parent_matrix, parent_volume):
        matrix = parent_matrix @ matrix_of(tile)
        uri = (tile.get("content") or {}).get("uri")
        if uri and uri.endswith(".json"):
            external.append({"path": path, "uri": uri,
                             "matrix": matrix, "depth": depth})
            uri = None
        out.append(TileRef(path=path, depth=depth, tile=tile,
                           world_from_tile=matrix,
                           parent_volume=parent_volume,
                           content_uri=uri))
        for i, child in enumerate(tile.get("children") or []):
            recurse(child, f"{path}/{i}", depth + 1, matrix,
                    tile.get("boundingVolume"))

    recurse(doc["root"], "root", 0, np.identity(4), None)
    return {
        "tileset": str(tileset_path),
        "base_dir": str(base),
        "tiles": out,
        "external_tilesets": external,
        "asset_version": doc.get("asset", {}).get("version"),
        "root_geometric_error": doc.get("geometricError"),
    }
```

The transform **chain** is the part almost every hand-rolled checker gets wrong. A tile's transform is relative to its parent, so a tile's content is placed by the product of every transform from the root down — and checking a tile against its own volume using only its own transform gives a correct answer at the root and nonsense three levels down.

The column-major reshape-then-transpose is the other half of the same bug. The specification stores the matrix column-major, NumPy's `reshape(4, 4)` reads row-major, so the transpose is mandatory. Getting this wrong produces offsets in the millions of metres, which is at least obvious; getting the chain wrong produces plausible small errors, which is worse.

Recording the parent's volume alongside each tile lets the nesting check in step 5 run in the same pass, and collecting external tilesets separately means they can be recursed into afterwards without confusing the transform bookkeeping.

<figure class="diagram">
<svg viewBox="4 16 732 214" role="img" aria-labelledby="bv-chain-t bv-chain-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bv-chain-t">The transform chain, and the two ways to get it wrong</title>
  <desc id="bv-chain-d">A three-level tileset. The root carries an east-north-up to earth-centred transform. A district tile carries a local offset of 400 metres east. A leaf tile carries no transform. The correct world placement of the leaf's content is the product of the root and district matrices. Using only the leaf's own transform places the content at the earth's centre, 6378 kilometres away. Reading the matrix row-major instead of column-major places it a few thousand kilometres away and rotated.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="214" fill="#ffffff"/>
  <defs>
    <marker id="bv-chain-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.8">
    <rect x="18" y="30" width="146" height="50" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="98" width="146" height="50" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="166" width="146" height="50" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="246" y="30" width="230" height="50" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="246" y="98" width="230" height="50" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="246" y="166" width="230" height="50" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="30" width="212" height="50" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="510" y="98" width="212" height="50" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="510" y="166" width="212" height="50" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#bv-chain-arrow)">
    <path d="M164 55 H244"/><path d="M164 123 H244"/><path d="M164 191 H244"/>
    <path d="M476 55 H508"/><path d="M476 123 H508"/><path d="M476 191 H508"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="91" y="50">correct</text><text x="91" y="68">root × district</text>
    <text x="91" y="118">own transform</text><text x="91" y="136">only</text>
    <text x="91" y="186">row-major</text><text x="91" y="204">reshape</text>
    <text x="361" y="50">content lands on the</text><text x="361" y="68">facade in Oslo</text>
    <text x="361" y="118">content lands at the</text><text x="361" y="136">Earth's centre</text>
    <text x="361" y="186">content lands rotated,</text><text x="361" y="204">a few thousand km off</text>
    <text x="616" y="50">containment passes</text><text x="616" y="68">as it should</text>
    <text x="616" y="118">every tile "fails" by</text><text x="616" y="136">6,378 km</text>
    <text x="616" y="186">every tile fails by an</text><text x="616" y="204">implausible amount</text>
  </g>
</svg>
<figcaption>Both mistakes fail loudly at implausible magnitudes, which is the one mercy: a checker reporting 6,378 km of error has a transform bug, not a data problem.</figcaption>
</figure>

### 2. Decode the content's actual extent

```python
def content_bounds_local(content_path):
    """The axis-aligned bounds of a tile's geometry in its own coordinate system."""
    import trimesh

    path = Path(content_path)
    if path.suffix.lower() in (".glb", ".gltf"):
        scene = trimesh.load(path, process=False)
        if isinstance(scene, trimesh.Scene):
            if not scene.geometry:
                return None, {"reason": "glTF contains no geometry"}
            corners = []
            for name, geom in scene.geometry.items():
                node_matrix = scene.graph.get(name)[0] if name in scene.graph.nodes_geometry \
                    else np.identity(4)
                verts = np.asarray(geom.vertices)
                if verts.size == 0:
                    continue
                homo = np.column_stack([verts, np.ones(len(verts))])
                placed = (node_matrix @ homo.T).T[:, :3]
                corners.append(placed)
            if not corners:
                return None, {"reason": "glTF geometry has no vertices"}
            pts = np.vstack(corners)
        else:
            pts = np.asarray(scene.vertices)
    elif path.suffix.lower() == ".pnts":
        return None, {"reason": "pnts not decoded here; use 3d-tiles-tools to convert"}
    else:
        return None, {"reason": f"unhandled content type {path.suffix}"}

    return {
        "min": pts.min(axis=0),
        "max": pts.max(axis=0),
        "centre": (pts.min(axis=0) + pts.max(axis=0)) / 2.0,
        "extent": pts.max(axis=0) - pts.min(axis=0),
        "vertices": int(len(pts)),
        "points": pts,
    }, None

def content_bounds_world(content_path, world_from_tile, y_up_to_z_up=True):
    local, err = content_bounds_local(content_path)
    if local is None:
        return None, err

    pts = local["points"]
    # glTF is Y-up; 3D Tiles content is placed in a Z-up frame.
    if y_up_to_z_up:
        rot = np.array([[1.0, 0.0, 0.0, 0.0],
                        [0.0, 0.0, -1.0, 0.0],
                        [0.0, 1.0, 0.0, 0.0],
                        [0.0, 0.0, 0.0, 1.0]])
        matrix = world_from_tile @ rot
    else:
        matrix = world_from_tile

    homo = np.column_stack([pts, np.ones(len(pts))])
    world = (matrix @ homo.T).T[:, :3]
    return {
        "min": world.min(axis=0),
        "max": world.max(axis=0),
        "vertices": int(len(world)),
        "points": world,
        "y_up_applied": bool(y_up_to_z_up),
    }, None
```

The Y-up to Z-up rotation is the third classic transform bug and the subtlest, because it produces an error the size of the building rather than the size of the planet. glTF defines Y as up; 3D Tiles places content in a Z-up frame, so a viewer applies that rotation and a checker must too. Omitting it makes a 40 m building appear to stick 40 m out of the side of its bounding box.

Testing every vertex rather than the eight corners of a local bounding box matters once a rotation is involved: the rotated box's corners are not the transformed corners of the original box, so a corner-only test can pass while vertices lie outside.

Sampling is a reasonable optimisation on a huge tile, and the sampling must be of **vertices**, not of triangles, because the extreme vertex is what defines containment.

### 3. Test containment for each volume type

```python
from pyproj import CRS, Transformer

ECEF = CRS.from_epsg(4978)
GEOG = CRS.from_epsg(4979)
TO_GEOG = Transformer.from_crs(ECEF, GEOG, always_xy=True)

def check_sphere(volume, world_points, tolerance_m=0.05):
    cx, cy, cz, radius = volume["sphere"]
    centre = np.array([cx, cy, cz])
    d = np.linalg.norm(world_points - centre, axis=1)
    outside = d > radius + tolerance_m
    return {
        "type": "sphere",
        "radius_m": round(float(radius), 3),
        "vertices_outside": int(outside.sum()),
        "max_excess_m": round(float((d - radius).max()), 4),
        "required_radius_m": round(float(d.max()), 3),
        "tightness": round(float(d.max() / max(radius, 1e-9)), 4),
        "contains": bool(not outside.any()),
    }

def check_box(volume, world_points, tolerance_m=0.05):
    b = np.asarray(volume["box"], dtype=np.float64)
    centre = b[0:3]
    axes = b[3:12].reshape(3, 3)          # three half-axis vectors
    lengths = np.linalg.norm(axes, axis=1)
    unit = axes / np.maximum(lengths[:, None], 1e-12)

    rel = world_points - centre
    coords = rel @ unit.T                  # projection onto each half-axis
    excess = np.abs(coords) - lengths[None, :]
    outside = (excess > tolerance_m).any(axis=1)
    return {
        "type": "box",
        "half_lengths_m": [round(float(v), 3) for v in lengths],
        "vertices_outside": int(outside.sum()),
        "max_excess_m": round(float(excess.max()), 4),
        "required_half_lengths_m": [round(float(v), 3)
                                    for v in np.abs(coords).max(axis=0)],
        "tightness": round(float((np.abs(coords).max(axis=0)
                                  / np.maximum(lengths, 1e-9)).max()), 4),
        "contains": bool(not outside.any()),
    }

def check_region(volume, world_points, tolerance_m=0.05):
    west, south, east, north, min_h, max_h = volume["region"]
    lon, lat, h = TO_GEOG.transform(world_points[:, 0], world_points[:, 1],
                                    world_points[:, 2])
    lon_r = np.radians(lon)
    lat_r = np.radians(lat)

    # Metre tolerance converted to radians at this latitude.
    lat_tol = tolerance_m / 6_378_137.0
    lon_tol = lat_tol / np.maximum(np.cos(lat_r), 1e-6)

    outside_lon = (lon_r < west - lon_tol) | (lon_r > east + lon_tol)
    outside_lat = (lat_r < south - lat_tol) | (lat_r > north + lat_tol)
    outside_h = (h < min_h - tolerance_m) | (h > max_h + tolerance_m)
    outside = outside_lon | outside_lat | outside_h

    return {
        "type": "region",
        "declared_deg": [round(math.degrees(west), 7), round(math.degrees(south), 7),
                         round(math.degrees(east), 7), round(math.degrees(north), 7)],
        "declared_height_m": [round(min_h, 3), round(max_h, 3)],
        "required_deg": [round(float(lon.min()), 7), round(float(lat.min()), 7),
                         round(float(lon.max()), 7), round(float(lat.max()), 7)],
        "required_height_m": [round(float(h.min()), 3), round(float(h.max()), 3)],
        "vertices_outside": int(outside.sum()),
        "outside_horizontally": int((outside_lon | outside_lat).sum()),
        "outside_vertically": int(outside_h.sum()),
        "contains": bool(not outside.any()),
        "height_tightness": round(float((h.max() - h.min())
                                        / max(max_h - min_h, 1e-9)), 4),
    }

def check_volume(volume, world_points, tolerance_m=0.05):
    if volume is None:
        return {"type": None, "contains": False, "reason": "no bounding volume"}
    if "sphere" in volume:
        return check_sphere(volume, world_points, tolerance_m)
    if "box" in volume:
        return check_box(volume, world_points, tolerance_m)
    if "region" in volume:
        return check_region(volume, world_points, tolerance_m)
    return {"type": "unknown", "contains": False,
            "reason": f"unrecognised volume keys: {sorted(volume)}"}
```

The three volume types need genuinely different tests, and the box is the one worth reading carefully: its twelve numbers are a centre followed by three **half-axis vectors**, not three lengths and a rotation. Projecting each point onto the normalised axes and comparing against the axis lengths is the containment test, and treating the nine numbers as a rotation matrix is a common misreading that happens to work for axis-aligned boxes.

A `region` volume is in **radians** with heights above the ellipsoid, which is why the check transforms ECEF vertices to geographic coordinates rather than the other way round. Converting a metre tolerance to radians needs the cosine of latitude for longitude, and forgetting it makes the tolerance 2× too tight at 60° north.

Reporting the **required** volume alongside the declared one is what makes a failure fixable in one step: the report says "declared radius 140 m, required 187 m", and the fix is to write 187.

<figure class="diagram">
<svg viewBox="4 12 730 244" role="img" aria-labelledby="bv-types-t bv-types-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bv-types-t">The three volume types and their containment test</title>
  <desc id="bv-types-d">Three volume types shown in cross-section around the same building. A region is an axis-aligned longitude, latitude and height range in radians, tested by transforming vertices to geographic coordinates. An oriented box is a centre plus three half-axis vectors, tested by projecting vertices onto the normalised axes and comparing against the axis lengths. A sphere is a centre and a radius, tested by distance. The box is tightest around a rotated building and the sphere is loosest.</desc>
  <rect class="svg-bg" x="4" y="12" width="730" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="26" width="222" height="196" rx="9" fill="#ffffff" stroke="#e6e0d4"/>
    <rect x="258" y="26" width="222" height="196" rx="9" fill="#ffffff" stroke="#e6e0d4"/>
    <rect x="498" y="26" width="222" height="196" rx="9" fill="#ffffff" stroke="#e6e0d4"/>
  </g>
  <g font-size="12.5" text-anchor="middle" fill="#1f2937">
    <text x="129" y="48">region — radians + height</text>
    <text x="369" y="48">oriented box</text>
    <text x="609" y="48">sphere</text>
  </g>
  <rect x="48" y="66" width="162" height="112" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M312 100 L406 68 L434 146 L340 178 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <circle cx="609" cy="122" r="76" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="1.8">
    <path d="M96 150 L166 126 L186 178 L116 202 Z"/>
    <path d="M336 150 L406 126 L426 178 L356 202 Z"/>
    <path d="M576 150 L646 126 L666 178 L596 202 Z"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="129" y="196">wasted: 44%</text>
    <text x="369" y="196">wasted: 9%</text>
    <text x="609" y="216">wasted: 61%</text>
  </g>
  <text x="370" y="238" fill="#5b6471" font-size="12" text-anchor="middle">the same rotated building: an oriented box wastes 9% of its volume, a sphere 61%</text>
</svg>
<figcaption>All three are legal and they differ by a factor of seven in wasted volume, which is culling efficiency given away.</figcaption>
</figure>

### 4. Check tightness, not only containment

```python
TIGHTNESS_LIMITS = {
    "sphere": 4.0,     # declared radius no more than 4× what is needed
    "box": 3.0,
    "region_height": 5.0,
}

def tightness_finding(result, limits=TIGHTNESS_LIMITS):
    if not result.get("contains"):
        return None
    kind = result["type"]
    if kind == "sphere":
        ratio = 1.0 / max(result["tightness"], 1e-9)
        if ratio > limits["sphere"]:
            return {
                "severity": "warn",
                "issue": f"sphere radius is {ratio:.1f}× larger than needed "
                         f"({result['radius_m']} m declared, "
                         f"{result['required_radius_m']} m required)",
            }
    elif kind == "box":
        ratio = 1.0 / max(result["tightness"], 1e-9)
        if ratio > limits["box"]:
            return {
                "severity": "warn",
                "issue": f"box is {ratio:.1f}× larger than needed on its worst axis",
            }
    elif kind == "region":
        declared = result["declared_height_m"]
        required = result["required_height_m"]
        span_declared = max(declared[1] - declared[0], 1e-9)
        span_required = max(required[1] - required[0], 1e-9)
        if span_declared / span_required > limits["region_height"]:
            return {
                "severity": "warn",
                "issue": f"region height span is {span_declared / span_required:.1f}× "
                         f"larger than needed ({span_declared:.1f} m declared, "
                         f"{span_required:.1f} m required)",
            }
    return None
```

A volume four times larger than its content is not a specification violation and is a performance problem. The client's culling test is against the volume, so an oversized volume makes the tile visible from four times the distance and loads it that much sooner — and a whole tileset built with a generous margin loads several times more geometry than it needs.

The region **height** span is the one that goes wrong most often, because a generator that does not know its content's height range writes a safe 0–500 m. Every such tile is then "visible" whenever its footprint is on screen, regardless of the camera's pitch, which is the mechanism described in [octree vs quadtree subdivision for tall buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/octree-vs-quadtree-subdivision-for-tall-buildings/).

Keeping tightness as a warning rather than an error is right: it is a tuning finding, not a correctness one, and a tileset with a few loose volumes is still correct.

### 5. Check the nesting and the geometric errors

```python
def volume_contains_volume(outer, inner, tolerance_m=0.1):
    """A conservative test: does the outer volume contain the inner one's corners?"""
    def corners(volume):
        if "sphere" in volume:
            cx, cy, cz, r = volume["sphere"]
            centre = np.array([cx, cy, cz])
            offsets = np.array([[sx * r, sy * r, sz * r]
                                for sx in (-1, 1) for sy in (-1, 1)
                                for sz in (-1, 1)])
            return centre + offsets
        if "box" in volume:
            b = np.asarray(volume["box"], dtype=np.float64)
            centre = b[0:3]
            axes = b[3:12].reshape(3, 3)
            return np.array([centre + sx * axes[0] + sy * axes[1] + sz * axes[2]
                             for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
        if "region" in volume:
            west, south, east, north, min_h, max_h = volume["region"]
            from pyproj import Transformer
            to_ecef = Transformer.from_crs(GEOG, ECEF, always_xy=True)
            pts = []
            for lon in (west, east):
                for lat in (south, north):
                    for h in (min_h, max_h):
                        x, y, z = to_ecef.transform(math.degrees(lon),
                                                    math.degrees(lat), h)
                        pts.append([x, y, z])
            return np.asarray(pts)
        return None

    inner_pts = corners(inner)
    if inner_pts is None or outer is None:
        return {"checked": False}
    result = check_volume(outer, inner_pts, tolerance_m=tolerance_m)
    return {"checked": True, "contains": result.get("contains", False),
            "corners_outside": result.get("vertices_outside", 0),
            "max_excess_m": result.get("max_excess_m")}

def geometric_error_chain(tiles):
    findings = []
    by_path = {t.path: t for t in tiles}
    for t in tiles:
        ge = t.tile.get("geometricError")
        if ge is None:
            findings.append({"tile": t.path, "severity": "error",
                             "issue": "missing geometricError"})
            continue
        parent_path = t.path.rsplit("/", 1)[0] if "/" in t.path else None
        parent = by_path.get(parent_path) if parent_path else None
        if parent is not None:
            parent_ge = parent.tile.get("geometricError")
            if parent_ge is not None and ge >= parent_ge:
                findings.append({
                    "tile": t.path, "severity": "error",
                    "issue": f"geometricError {ge} is not less than the parent's "
                             f"{parent_ge}",
                })
        if not t.tile.get("children") and ge != 0:
            findings.append({
                "tile": t.path, "severity": "warn",
                "issue": f"leaf tile has geometricError {ge}; 0 tells the client "
                         f"there is nothing finer",
            })
    return findings
```

A child volume outside its parent's is the failure that makes geometry disappear entirely: the client culls the parent, never descends to the child, and a whole subtree is invisible from the directions where the parent fails the frustum test. It is worse than a content-containment failure because nothing renders at all.

Testing the child volume's corners against the parent is conservative — a sphere's eight "corners" are outside the sphere itself — so it can report a failure where the true volumes nest. That is the right direction for a validator, and the excess figure says whether the failure is marginal or real.

The geometric-error chain check belongs here rather than in a separate pass because it uses the same tree walk, and a non-decreasing error has the same symptom as a bad volume: a tile that never refines.

### 6. Run it over the tileset and gate

```python
def validate_tileset(tileset_path, tolerance_m=0.05, sample_vertices=200_000,
                     check_tightness=True, seed=7):
    walked = walk_tileset(tileset_path)
    base = Path(walked["base_dir"])
    rng = np.random.default_rng(seed)
    rows, findings = [], []

    for ref in walked["tiles"]:
        volume = ref.tile.get("boundingVolume")
        if volume is None:
            findings.append({"tile": ref.path, "severity": "error",
                             "issue": "tile has no boundingVolume"})
            continue

        if ref.parent_volume is not None:
            nest = volume_contains_volume(ref.parent_volume, volume,
                                          tolerance_m=tolerance_m * 4)
            if nest.get("checked") and not nest["contains"]:
                findings.append({
                    "tile": ref.path, "severity": "error",
                    "issue": f"bounding volume is not contained in its parent's "
                             f"(worst corner {nest['max_excess_m']} m outside)",
                })

        if not ref.content_uri:
            continue
        content_path = base / ref.content_uri
        if not content_path.exists():
            findings.append({"tile": ref.path, "severity": "error",
                             "issue": f"content missing: {ref.content_uri}"})
            continue

        world, err = content_bounds_world(content_path, ref.world_from_tile)
        if world is None:
            findings.append({"tile": ref.path, "severity": "warn",
                             "issue": f"content not decoded: {err['reason']}"})
            continue

        pts = world["points"]
        if len(pts) > sample_vertices:
            pts = pts[rng.choice(len(pts), size=sample_vertices, replace=False)]

        result = check_volume(volume, pts, tolerance_m=tolerance_m)
        rows.append({"tile": ref.path, "depth": ref.depth,
                     "uri": ref.content_uri, **result})
        if not result.get("contains"):
            findings.append({
                "tile": ref.path, "severity": "error",
                "issue": f"{result['vertices_outside']} vertex/vertices up to "
                         f"{result['max_excess_m']} m outside the {result['type']}",
                "fix": result.get("required_radius_m")
                       or result.get("required_half_lengths_m")
                       or result.get("required_height_m"),
            })
        elif check_tightness:
            loose = tightness_finding(result)
            if loose:
                findings.append({"tile": ref.path, **loose})

    findings.extend(geometric_error_chain(walked["tiles"]))
    errors = [f for f in findings if f["severity"] == "error"]
    return {
        "tileset": str(tileset_path),
        "asset_version": walked["asset_version"],
        "tiles": len(walked["tiles"]),
        "tiles_with_content": len(rows),
        "external_tilesets": len(walked["external_tilesets"]),
        "checked": len(rows),
        "errors": len(errors),
        "warnings": len(findings) - len(errors),
        "findings": findings[:12],
        "pass": not errors,
        "volume_types": {k: sum(1 for r in rows if r["type"] == k)
                         for k in ("region", "box", "sphere")},
    }
```

<figure class="diagram">
<svg viewBox="4 6 732 254" role="img" aria-labelledby="bv-modes-t bv-modes-d" xmlns="http://www.w3.org/2000/svg">
  <title id="bv-modes-t">Four bounding-volume failures and what the user sees</title>
  <desc id="bv-modes-d">A table of four failure modes. Content outside the tile's own volume makes geometry vanish when the camera approaches from certain directions. A child volume outside its parent's makes a whole subtree invisible because the parent is culled first. A volume much larger than its content loads geometry that contributes nothing, costing frame time with nothing missing. A non-decreasing geometric error makes a tile never refine, so the district stays coarse. The specification validator catches only the first and the last.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="254" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="220" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="238" y="20" width="306" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="544" y="20" width="178" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="220" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="54" width="306" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="544" y="54" width="178" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="102" width="220" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="102" width="306" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="544" y="102" width="178" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="150" width="220" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="238" y="150" width="306" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="544" y="150" width="178" height="48" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="198" width="220" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="238" y="198" width="306" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="544" y="198" width="178" height="48" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="128" y="41">failure</text><text x="391" y="41">what the user sees</text>
    <text x="633" y="41">spec validator catches?</text>
    <text x="128" y="74">content outside its</text><text x="128" y="92">own volume</text>
    <text x="391" y="74">buildings vanish from some</text><text x="391" y="92">camera directions</text>
    <text x="633" y="83">yes</text>
    <text x="128" y="122">child volume outside</text><text x="128" y="140">the parent's</text>
    <text x="391" y="122">a whole subtree is invisible —</text><text x="391" y="140">the parent is culled first</text>
    <text x="633" y="131">no</text>
    <text x="128" y="170">volume 4× larger</text><text x="128" y="188">than its content</text>
    <text x="391" y="170">nothing missing, everything</text><text x="391" y="188">slow — culling stops working</text>
    <text x="633" y="179">no</text>
    <text x="128" y="220">geometricError not</text>
    <text x="128" y="238">decreasing</text>
    <text x="391" y="229">the district never refines</text>
    <text x="633" y="229">yes</text>
  </g>
</svg>
<figcaption>Two of the four failures pass the specification validator, and both of those are the ones that produce a confusing symptom.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "tileset": "output/city/tileset.json",
  "asset_version": "1.1",
  "tiles": 6147, "tiles_with_content": 4812, "external_tilesets": 12,
  "checked": 4812, "errors": 4, "warnings": 61,
  "volume_types": {"region": 4812, "box": 0, "sphere": 0},
  "pass": false,
  "findings": [
    {"tile": "root/2/1/3", "severity": "error",
     "issue": "1841 vertex/vertices up to 18.412 m outside the region",
     "fix": [12.104, 78.882]},
    {"tile": "root/2/1", "severity": "error",
     "issue": "bounding volume is not contained in its parent's (worst corner 4.18 m outside)"},
    {"tile": "root/5/0/2", "severity": "error",
     "issue": "content missing: content/5/0/2.glb"},
    {"tile": "root/7", "severity": "error",
     "issue": "geometricError 512 is not less than the parent's 512"},
    {"tile": "root/1/0/0", "severity": "warn",
     "issue": "region height span is 7.3× larger than needed (500.0 m declared, 68.4 m required)"}
  ]
}
```

The first finding is the classic one and it is fully diagnosed: 1,841 vertices up to 18.4 m outside the region, with the required height range of 12.1 to 78.9 m supplied as the fix. That is a generator that wrote a height range from the footprint data rather than from the geometry.

The 61 warnings are mostly the last kind: regions with a 0–500 m declared height span against a 68 m requirement, which is a generator default. None of them break anything and together they make the tileset load several times more geometry than it needs.

Verify the checker itself against the reference validator, so a disagreement is investigated rather than assumed:

```python
import subprocess

def cross_check_with_reference(tileset_path, report_path="build/spec_validation.json"):
    proc = subprocess.run(
        ["npx", "3d-tiles-validator", "--tilesetFile", str(tileset_path),
         "--reportFile", report_path],
        capture_output=True, text=True)
    report = json.loads(Path(report_path).read_text()) if Path(report_path).exists() \
        else {"issues": []}
    issues = report.get("issues") or []

    containment = [i for i in issues
                   if "BOUNDING_VOLUME" in (i.get("type") or "")
                   or "CONTENT_OUTSIDE" in (i.get("type") or "")]
    ours = validate_tileset(tileset_path)
    our_containment = [f for f in ours["findings"]
                       if "outside the" in f["issue"]]

    return {
        "reference_exit": proc.returncode,
        "reference_issues": len(issues),
        "reference_containment_issues": len(containment),
        "our_errors": ours["errors"],
        "our_containment_errors": len(our_containment),
        "agree_on_containment": len(containment) == len(our_containment),
        "reference_only": [i.get("type") for i in containment][:4],
        "ours_only": [f["tile"] for f in our_containment][:4],
        "note": "the reference validator checks the spec; this checker also checks "
                "nesting and tightness, so extra findings are expected",
    }
```

The reference validator and this checker should agree on **containment**. Disagreement means one of them has the transform chain wrong, and the reference implementation is the one to believe — so a mismatch is a bug in the local checker rather than a data finding.

Extra findings from the local checker are expected and are the point: nesting and tightness are not specification violations, so the reference validator does not report them.

Then verify the fix, because the required-volume figures the report emits should make the tileset pass in one pass:

```python
def apply_fixes(tileset_path, out_path, tolerance_margin_m=0.25):
    """Rewrite failing volumes with the required extents plus a small margin."""
    walked = walk_tileset(tileset_path)
    base = Path(walked["base_dir"])
    doc = json.loads(Path(tileset_path).read_text())
    fixed = []

    def locate(path):
        node = doc["root"]
        for part in path.split("/")[1:]:
            node = node["children"][int(part)]
        return node

    for ref in walked["tiles"]:
        if not ref.content_uri:
            continue
        content_path = base / ref.content_uri
        if not content_path.exists():
            continue
        world, err = content_bounds_world(content_path, ref.world_from_tile)
        if world is None:
            continue
        volume = ref.tile.get("boundingVolume") or {}
        result = check_volume(volume, world["points"])
        if result.get("contains"):
            continue

        node = locate(ref.path)
        if result["type"] == "region":
            lon, lat, h = TO_GEOG.transform(world["points"][:, 0],
                                            world["points"][:, 1],
                                            world["points"][:, 2])
            node["boundingVolume"] = {"region": [
                math.radians(float(lon.min())), math.radians(float(lat.min())),
                math.radians(float(lon.max())), math.radians(float(lat.max())),
                float(h.min()) - tolerance_margin_m,
                float(h.max()) + tolerance_margin_m,
            ]}
        elif result["type"] == "sphere":
            centre = (world["min"] + world["max"]) / 2.0
            radius = float(np.linalg.norm(world["points"] - centre, axis=1).max())
            node["boundingVolume"] = {"sphere": [*map(float, centre),
                                                 radius + tolerance_margin_m]}
        fixed.append({"tile": ref.path, "type": result["type"]})

    Path(out_path).write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")))
    after = validate_tileset(out_path)
    return {"fixed_tiles": len(fixed), "examples": fixed[:5],
            "errors_before": validate_tileset(tileset_path)["errors"],
            "errors_after": after["errors"],
            "clean": after["pass"]}
```

Recomputing the volume from the decoded geometry rather than nudging the declared numbers is the right fix, and it is only correct once the transform chain is right — which is why the fixer reuses exactly the same code path as the checker.

## Performance Notes

- **Decoding the glTF dominates**: about 15–60 ms per tile depending on size and whether Draco decompression is needed. 4,812 tiles is 2–5 minutes.
- **Sample the vertices on large tiles.** 200,000 vertices is ample for a containment test, and it caps the per-tile cost regardless of the tile's density.
- **Reuse one `Transformer`.** Creating a `pyproj` transformer per tile is slower than the containment test itself.
- **Run it on changed tiles only** in an incremental build, using the manifest from [resuming failed tiling runs from checkpoints](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/resuming-failed-tiling-runs-from-checkpoints/).
- **The nesting and geometric-error checks cost nothing** — they are arithmetic on the tileset JSON — so run them on every build even when the content check is sampled.
- **External tilesets need a recursive pass** with the accumulated transform carried in; the walker collects them rather than following them so the recursion is explicit.

## Common Errors

**Every tile fails by about 6,378 km.** The transform chain was not accumulated, so a leaf's content was placed by an identity matrix at the Earth's centre.

**Every tile fails by a few thousand kilometres and looks rotated.** Row-major reshape of a column-major matrix. Transpose it.

**Every tile fails by roughly the building's height.** The Y-up to Z-up rotation was not applied.

**A tile with a `box` volume fails and looks fine in a viewer.** The nine axis numbers were read as a rotation matrix rather than as three half-axis vectors.

**Region checks fail marginally at high latitude.** The metre-to-radian tolerance was not divided by the cosine of latitude for longitude.

**Content-missing errors for `.pnts` tiles.** Point-cloud content is not decoded by this checker; convert with `3d-tiles-tools` or add a `.pnts` reader.

**The checker passes and geometry still disappears.** Check the nesting: a parent volume that does not contain its child is culled first and the symptom is identical.

## Frequently Asked Questions

### Is this not what the reference validator does?

Partly. It checks specification conformance, which includes content containment, and it does not check that a child volume nests inside its parent or that a volume is reasonably tight. Both of those are legal and cause real problems.

### Which volume type should a generator emit?

Region for geographic tiles aligned to longitude and latitude, which covers most city tiling; oriented box for content in a local frame under a transform, and for tall or rotated extents. Sphere only where the extent is genuinely isotropic.

### How tight is too tight?

Exactly tight is fine — the volume is inclusive, so a vertex on the boundary is contained. A small margin, 10–25 cm, absorbs floating-point differences between the generator's arithmetic and the client's without measurably hurting culling.

## Related Guides

- [Writing Tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/) — generating volumes correctly in the first place
- [Converting GLB to 3D Tiles with 3d-tiles-tools](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-glb-to-3d-tiles-with-3d-tiles-tools/) — the tool that computes volumes from content
- [Debugging with the Cesium 3D Tiles Inspector](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/debugging-with-the-cesium-3d-tiles-inspector/) — seeing these volumes in the viewer

Back to [Data Validation and QA Gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
