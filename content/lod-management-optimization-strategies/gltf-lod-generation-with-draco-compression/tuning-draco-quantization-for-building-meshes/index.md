# Tuning Draco Quantization Bits for Georeferenced Building Meshes

This guide chooses `KHR_draco_mesh_compression` quantization bit settings for georeferenced building glTF meshes — using `numpy` to solve the extent-versus-error relationship and `gltf-transform` to encode — so decoded positions stay sub-centimetre while the payload still shrinks by an order of magnitude. You hit this the moment a Draco encode either bloats (too many bits, no size win) or bows a facade (too few bits on a large building), and you need a defensible number instead of a copied default. It assumes meshes authored in a local East-North-Up (ENU) metric frame and placed onto the globe by a root transform into EPSG:4978, as set up in the parent workflow, [glTF LOD generation with Draco compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).

## Prerequisites

- Python 3.10+ with `numpy>=1.26` and `trimesh>=4.4`: `pip install "numpy>=1.26" "trimesh>=4.4"`. `trimesh` decodes Draco on read, which the verification step relies on.
- `gltf-transform` CLI 4.0+ on Node 18+: `npm install -g @gltf-transform/cli`. Confirm with `gltf-transform --version`.
- A building mesh as `.glb` (glTF 2.0), authored in a **local ENU frame in metres** and centred near its own origin, not in full projected eastings. The bounding-box extent that drives quantization is the building's own size (tens of metres), independent of the ECEF placement into **EPSG:4978** carried by the root transform.
- The core fact: a POSITION attribute quantized to `n` bits over a bounding box of extent `E` metres has a worst-case positional error of about `E / 2^n`. Quantization snaps every coordinate to one of `2^n` evenly spaced grid values across the box, so the grid spacing *is* the error floor.

<figure class="diagram">
<svg viewBox="0 0 760 300" role="img" aria-labelledby="tdq-t tdq-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tdq-t">Draco position error as a function of quantization bits for a 30 m building</title>
  <desc id="tdq-d">For a 30 metre bounding-box extent, 10 quantization bits give about 29 millimetres of position error, 12 bits about 7 millimetres, and 14 bits about 2 millimetres, so more bits shrink the error grid spacing.</desc>
  <defs>
    <marker id="tdq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <text x="380" y="36" fill="#1f2937" font-size="15" font-weight="600" text-anchor="middle">Bounding-box extent E = 30 m &#183; position error &#8776; E / 2^bits</text>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#tdq-arrow)">
    <line x1="215" y1="90" x2="453" y2="90"/>
    <line x1="215" y1="160" x2="453" y2="160"/>
    <line x1="215" y1="230" x2="453" y2="230"/>
  </g>
  <rect x="60" y="65" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="60" y="135" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="60" y="205" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="460" y="65" width="240" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="460" y="135" width="240" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="460" y="205" width="240" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g font-size="14" text-anchor="middle">
    <text x="135" y="95" fill="#15384a">POSITION 10 bit</text>
    <text x="135" y="165" fill="#15384a">POSITION 12 bit</text>
    <text x="135" y="235" fill="#15384a">POSITION 14 bit</text>
    <text x="580" y="95" fill="#1f2937">error &#8776; 29 mm</text>
    <text x="580" y="165" fill="#1f2937">error &#8776; 7.3 mm</text>
    <text x="580" y="235" fill="#1f2937">error &#8776; 1.8 mm</text>
  </g>
  <text x="380" y="285" fill="#5b6471" font-size="12" text-anchor="middle">14 bits clears the 1 cm gate with margin; 10 bits does not for a building-sized box</text>
</svg>
<figcaption>Each added position bit halves the quantization grid spacing, so the bit budget follows directly from the mesh extent and the accuracy you must hold.</figcaption>
</figure>

## Step-by-Step

### 1. Measure the bounding-box extent in the ENU frame

Quantization error scales with the *largest* axis of the box, because Draco quantizes each axis over the mesh's full extent. Load the building and take the per-axis extent with `numpy`; the maximum dimension is the one that sets the error floor.

```python
import numpy as np
import trimesh

mesh = trimesh.load("building_enu.glb", force="mesh", process=False)
lo, hi = mesh.bounds                    # ENU metres, centred near origin
extent = hi - lo                        # per-axis size [ex, ey, ez]
max_extent = float(extent.max())
print(f"extent (m): {extent.round(2)}  max axis: {max_extent:.2f} m")
```

### 2. Solve for the position bit budget from a tolerance

Invert `error ≈ extent / 2^bits` for the bit count that holds a target accuracy: `bits = ceil(log2(extent / tolerance))`. Round up, then floor at a sane minimum so a tiny kiosk still gets enough bits to render cleanly.

```python
def position_bits(max_extent_m, tolerance_m=0.01, floor=11, cap=16):
    """Smallest POSITION quantization bits holding `tolerance_m` over the extent."""
    need = int(np.ceil(np.log2(max_extent_m / tolerance_m)))
    return int(np.clip(need, floor, cap))

def predicted_error(max_extent_m, bits):
    return max_extent_m / (2 ** bits)   # worst-case metres

pos_bits = position_bits(max_extent, tolerance_m=0.01)   # sub-centimetre
print(f"POSITION {pos_bits} bit -> predicted error "
      f"{predicted_error(max_extent, pos_bits) * 1000:.2f} mm")
```

### 3. Set texcoord and normal bits by role, not by extent

TEXCOORD and NORMAL quantize over fixed ranges (UV in [0,1], normals on the unit sphere), so their bit budgets follow the attribute's role rather than the mesh size. For textured building facades, 12 texcoord bits keeps the atlas crisp and 10 normal bits avoids visible shading facets; drop normals to 8 only for hard-edged, untextured background assets.

```python
TEXCOORD_BITS = 12    # UV in [0,1]; 12 bits ~ 1/4096 of the atlas
NORMAL_BITS   = 10    # 8 bits facets on smooth curved facades

quant = {"position": pos_bits, "texcoord": TEXCOORD_BITS, "normal": NORMAL_BITS}
print("quantization plan:", quant)
```

### 4. Encode with gltf-transform at the chosen bits

Drive `gltf-transform draco` through `subprocess`, passing the bit budget from the plan. The `edgebreaker` method gives the smallest connectivity payload for closed manifold building meshes.

```python
import subprocess
from pathlib import Path

def draco_encode(in_glb, out_glb, quant):
    subprocess.run(
        ["gltf-transform", "draco", str(in_glb), str(out_glb),
         "--method", "edgebreaker",
         "--quantize-position", str(quant["position"]),
         "--quantize-texcoord", str(quant["texcoord"]),
         "--quantize-normal", str(quant["normal"])],
        check=True,
    )
    return Path(out_glb)

draco_encode("building_enu.glb", "building_draco.glb", quant)
```

### 5. Measure decoded-vs-source deviation to confirm

The predicted error is a bound, not a promise — verify it. `trimesh` decodes the Draco glTF on read, so compare the decoded vertices back to the source surface and confirm the worst deviation clears your tolerance, then check the payload actually shrank.

```python
src = trimesh.load("building_enu.glb", force="mesh", process=False)
dec = trimesh.load("building_draco.glb", force="mesh", process=False)  # decoded

_, dist, _ = src.nearest.on_surface(dec.vertices)
worst_mm = float(dist.max()) * 1000
raw_kb = Path("building_enu.glb").stat().st_size / 1024
enc_kb = Path("building_draco.glb").stat().st_size / 1024

print(f"decoded worst deviation: {worst_mm:.2f} mm")
print(f"payload: {raw_kb:.0f} KB -> {enc_kb:.0f} KB  ({raw_kb / enc_kb:.1f}x)")
assert worst_mm < 10.0, "position bits too low for this extent"
assert enc_kb < raw_kb, "Draco did not shrink the payload"
```

## Expected Output & Verification

For a 30 m facade at POSITION 14 / TEXCOORD 12 / NORMAL 10, the solver picks 12–14 position bits, the decoded deviation lands a few millimetres under the 1 cm gate, and the `.glb` compresses several-fold:

```text
extent (m): [28.4 14.9 22.1]  max axis: 28.40 m
POSITION 12 bit -> predicted error 6.93 mm
quantization plan: {'position': 12, 'texcoord': 12, 'normal': 10}
decoded worst deviation: 5.87 mm
payload: 4820 KB -> 610 KB  (7.9x)
```

The measured deviation (5.87 mm) sits just below the predicted bound (6.93 mm) — expected, since the bound is worst-case and most vertices land nearer a grid point. If you need a firmer sub-centimetre margin, raise position bits to 14 and re-run; the deviation drops to roughly 1.8 mm at a small size cost. Cross-check the extension landed with `gltf-transform inspect`:

```bash
gltf-transform inspect building_draco.glb
```

The report must list `KHR_draco_mesh_compression` under extensions; if it is absent, the encode no-opped and the size ratio will read near 1.0.

## Common Errors

**`AssertionError: position bits too low for this extent`.** The building spans more than the bit budget can resolve at your tolerance — a 400 m tower at 11 bits gives `400 / 2048 ≈ 195 mm`, far past 1 cm. The fix is not fewer bits elsewhere but more position bits: let `position_bits` compute from the real `max_extent` (step 1) rather than pasting a fixed 11, or cap the building's extent by splitting an oversized mega-mesh into per-storey parts before encoding.

**`AssertionError: Draco did not shrink the payload` (ratio near 1.0).** The `draco` command passed geometry through without compressing — usually because the primitive lacks indices, or the native Draco module for `gltf-transform` did not load. Re-index the mesh (`trimesh` writes indexed glTF by default), reinstall `@gltf-transform/cli`, and confirm `KHR_draco_mesh_compression` appears in `gltf-transform inspect`.

**Facades shade in visible facets after encoding.** NORMAL quantized at 8 bits bands smooth curved surfaces under directional light. Raise `NORMAL_BITS` to 10 for any textured or curved building facade; reserve 8 bits for flat, hard-edged, or untextured assets where the banding never faces the camera. Position and texcoord bits do not fix shading — the normal budget does.

## Related Guides

- [glTF LOD Generation With Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/) — the full LOD-chain and encode workflow this tuning slots into
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — wrapping the tuned glTF as b3dm with correct bounding volumes
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the triangle-budget decimation that precedes quantization

Back to [glTF LOD Generation With Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
