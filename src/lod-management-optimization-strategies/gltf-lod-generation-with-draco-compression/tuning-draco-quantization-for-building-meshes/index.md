---
title: "Tuning Draco Quantization for Building Meshes"
description: "Pick Draco quantization bits for georeferenced building glTF with numpy and gltf-transform: error = extent / 2^bits, position 14 / texcoord 12 / normal 10, EPSG:4978."
---
# Tuning Draco Quantization Bits for Georeferenced Building Meshes

This guide chooses `KHR_draco_mesh_compression` quantization bit settings for georeferenced building glTF meshes — using `numpy` to solve the extent-versus-error relationship and `gltf-transform` to encode — so decoded positions stay sub-centimetre while the payload still shrinks by an order of magnitude. You hit this the moment a Draco encode either bloats (too many bits, no size win) or bows a facade (too few bits on a large building), and you need a defensible number instead of a copied default. It assumes meshes authored in a local East-North-Up (ENU) metric frame and placed onto the globe by a root transform into EPSG:4978, as set up in the parent workflow, [glTF LOD generation with Draco compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).

## Prerequisites

- Python 3.10+ with `numpy>=1.26` and `trimesh>=4.4`: `pip install "numpy>=1.26" "trimesh>=4.4"`. `trimesh` decodes Draco on read, which the verification step relies on.
- `gltf-transform` CLI 4.0+ on Node 18+: `npm install -g @gltf-transform/cli`. Confirm with `gltf-transform --version`.
- A building mesh as `.glb` (glTF 2.0), authored in a **local ENU frame in metres** and centred near its own origin, not in full projected eastings. The bounding-box extent that drives quantization is the building's own size (tens of metres), independent of the ECEF placement into **EPSG:4978** carried by the root transform.
- The core fact: a POSITION attribute quantized to `n` bits over a bounding box of extent `E` metres has a worst-case positional error of about `E / 2^n`. Quantization snaps every coordinate to one of `2^n` evenly spaced grid values across the box, so the grid spacing *is* the error floor.

<figure class="diagram">
<svg viewBox="46 6 668 297" role="img" aria-labelledby="tdq-t tdq-d" xmlns="http://www.w3.org/2000/svg">
  <title id="tdq-t">Draco position error as a function of quantization bits for a 30 m building</title>
  <desc id="tdq-d">For a 30 metre bounding-box extent, 10 quantization bits give about 29 millimetres of position error, 12 bits about 7 millimetres, and 14 bits about 2 millimetres, so more bits shrink the error grid spacing.</desc>
  <rect class="svg-bg" x="46" y="6" width="668" height="297" fill="#ffffff"/>
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

<figure class="diagram">
<svg viewBox="-3 24 728 290" role="img" aria-labelledby="dq-lat-t dq-lat-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dq-lat-t">The same wall corner on a coarse and a fine quantization lattice</title>
  <desc id="dq-lat-d">Draco snaps every position onto a regular lattice whose spacing is the bounding-box extent divided by two to the power of the position bits. On a coarse lattice a wall corner and a setback move to the nearest grid intersection and the profile visibly changes. On a fine lattice the same profile is reproduced within a few millimetres.</desc>
  <rect class="svg-bg" x="-3" y="24" width="728" height="290" fill="#ffffff"/>
  <path d="M60 70 V250 M90 70 V250 M120 70 V250 M150 70 V250 M180 70 V250 M210 70 V250 M240 70 V250 M270 70 V250 M300 70 V250 M60 70 H300 M60 100 H300 M60 130 H300 M60 160 H300 M60 190 H300 M60 220 H300 M60 250 H300" fill="none" stroke="#e6e0d4" stroke-width="1"/>
  <path d="M440 70 V250 M450 70 V250 M460 70 V250 M470 70 V250 M480 70 V250 M490 70 V250 M500 70 V250 M510 70 V250 M520 70 V250 M530 70 V250 M540 70 V250 M550 70 V250 M560 70 V250 M570 70 V250 M580 70 V250 M590 70 V250 M600 70 V250 M610 70 V250 M620 70 V250 M630 70 V250 M640 70 V250 M650 70 V250 M660 70 V250 M670 70 V250 M680 70 V250 M440 70 H680 M440 80 H680 M440 90 H680 M440 100 H680 M440 110 H680 M440 120 H680 M440 130 H680 M440 140 H680 M440 150 H680 M440 160 H680 M440 170 H680 M440 180 H680 M440 190 H680 M440 200 H680 M440 210 H680 M440 220 H680 M440 230 H680 M440 240 H680 M440 250 H680" fill="none" stroke="#e6e0d4" stroke-width="1"/>
  <polyline points="60,210 60,120 150,120 150,96 240,96" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="5 4"/>
  <polyline points="60,220 60,130 150,130 150,100 240,100" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="440,210 440,120 530,120 530,96 620,96" fill="none" stroke="#5b6471" stroke-width="2" stroke-dasharray="5 4"/>
  <polyline points="440,210 440,120 530,120 530,100 620,100" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="180" y="52">11 bits over a 30 m extent — 15 mm lattice</text>
    <text x="560" y="52">14 bits over the same extent — 1.8 mm lattice</text>
  </g>
  <text x="180" y="278" fill="#b0413e" font-size="12" text-anchor="middle">the setback moves half a cell; the corner is no longer square</text>
  <text x="560" y="278" fill="#4f7a4d" font-size="12" text-anchor="middle">indistinguishable from the source at any usable zoom</text>
  <text x="370" y="296" fill="#5b6471" font-size="12" text-anchor="middle">Dashed grey is the source profile; the solid line is what decodes</text>
</svg>
<figcaption>Three extra bits cost about 12% of the position bytes and shrink the lattice by eight. That is the whole trade, and it is almost always worth taking.</figcaption>
</figure>

### 3. Set texcoord and normal bits by role, not by extent

TEXCOORD and NORMAL quantize over fixed ranges (UV in [0,1], normals on the unit sphere), so their bit budgets follow the attribute's role rather than the mesh size. For textured building facades, 12 texcoord bits keeps the atlas crisp and 10 normal bits avoids visible shading facets; drop normals to 8 only for hard-edged, untextured background assets.

```python
TEXCOORD_BITS = 12    # UV in [0,1]; 12 bits ~ 1/4096 of the atlas
NORMAL_BITS   = 10    # 8 bits facets on smooth curved facades

quant = {"position": pos_bits, "texcoord": TEXCOORD_BITS, "normal": NORMAL_BITS}
print("quantization plan:", quant)
```

<figure class="diagram">
<svg viewBox="46 20 676 284" role="img" aria-labelledby="dq-uv-t dq-uv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dq-uv-t">Why texture coordinates need their own bit budget</title>
  <desc id="dq-uv-d">Two UV islands sit next to each other in an atlas with a narrow gutter between them. Quantizing texture coordinates too coarsely snaps vertices on the island edge across the gutter, so the shader samples the neighbouring island and a stripe of the wrong texture appears along the seam.</desc>
  <rect class="svg-bg" x="46" y="20" width="676" height="284" fill="#ffffff"/>
  <path d="M60 60 h200 v160 h-200 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M276 60 h200 v160 h-200 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <path d="M540 60 h140 v160 h-140 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <path d="M260 60 V220 M276 60 V220" fill="none" stroke="#5b6471" stroke-width="1" stroke-dasharray="3 3"/>
  <g fill="#1f6b8a">
    <circle cx="256" cy="96" r="4"/><circle cx="256" cy="140" r="4"/><circle cx="256" cy="184" r="4"/>
  </g>
  <g fill="#b0413e">
    <circle cx="282" cy="96" r="4"/><circle cx="282" cy="140" r="4"/><circle cx="282" cy="184" r="4"/>
  </g>
  <path d="M540 60 h140 v22 h-140 Z" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="160" y="48">island A</text>
    <text x="376" y="48">island B</text>
    <text x="610" y="48">what renders</text>
  </g>
  <text x="268" y="242" fill="#5b6471" font-size="11.5" text-anchor="middle">gutter</text>
  <text x="268" y="262" fill="#b0413e" font-size="12" text-anchor="middle">island A's edge vertices snap across it</text>
  <text x="610" y="242" fill="#b0413e" font-size="12" text-anchor="middle">a stripe of island B along the seam</text>
  <text x="370" y="286" fill="#15384a" font-size="12" text-anchor="middle">The lattice spacing that matters here is the gutter width in UV space, not the building's size in metres</text>
</svg>
<figcaption>Texture coordinates live in a fixed zero-to-one space, so their bit budget has nothing to do with the mesh extent. Twelve bits is the usual floor for an atlas with tight gutters.</figcaption>
</figure>

This is why texcoord and normal bits should never be derived from the same reasoning as positions. Positions are quantized over the mesh's own bounding box, so the lattice spacing is a physical distance and the right budget follows from a tolerance in metres. Texture coordinates are always normalised into the unit square, so their lattice spacing is a fraction of the atlas regardless of whether the building is a kiosk or a stadium — and what it has to resolve is the gutter between UV islands, which is typically two to four texels wide. At 1024 texels that is roughly 0.002 to 0.004 in UV, and 10-bit texcoords give a lattice of 0.001, which is uncomfortably close. Twelve bits is the sensible floor for any atlas, and 14 for one with tight packing.

Normals are the opposite case. Draco encodes them onto an octahedral parameterisation whose angular resolution is what actually matters, and shading is forgiving of small angular error. Eight bits gives roughly half a degree, which is below the threshold at which banding becomes visible on a curved surface, and 10 bits is generous for anything short of a mirror-finish material. Spending 12 or 14 bits on normals is the most common way a Draco configuration wastes budget: it costs real bytes on every vertex and buys precision no shader will express.

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

Record the chosen bit budget in the asset's metadata alongside the bounding-box extent it was derived from. The two numbers together are what make the quantization reproducible: the same bit count over a different extent is a different lattice, so an asset re-exported after a re-tiling that changed its bounds will quietly change precision unless the budget is recomputed from the new extent.

## Common Errors

**`AssertionError: position bits too low for this extent`.** The building spans more than the bit budget can resolve at your tolerance — a 400 m tower at 11 bits gives `400 / 2048 ≈ 195 mm`, far past 1 cm. The fix is not fewer bits elsewhere but more position bits: let `position_bits` compute from the real `max_extent` (step 1) rather than pasting a fixed 11, or cap the building's extent by splitting an oversized mega-mesh into per-storey parts before encoding.

**`AssertionError: Draco did not shrink the payload` (ratio near 1.0).** The `draco` command passed geometry through without compressing — usually because the primitive lacks indices, or the native Draco module for `gltf-transform` did not load. Re-index the mesh (`trimesh` writes indexed glTF by default), reinstall `@gltf-transform/cli`, and confirm `KHR_draco_mesh_compression` appears in `gltf-transform inspect`.

**Facades shade in visible facets after encoding.** NORMAL quantized at 8 bits bands smooth curved surfaces under directional light. Raise `NORMAL_BITS` to 10 for any textured or curved building facade; reserve 8 bits for flat, hard-edged, or untextured assets where the banding never faces the camera. Position and texcoord bits do not fix shading — the normal budget does.

One habit worth adopting: derive the bit budget in code from the measured extent and the stated tolerance, rather than hard-coding the number the derivation produced. The two forms give identical output today, and only one of them keeps giving the right answer when a building archetype with a different footprint enters the pipeline.

## Related Guides

- [glTF LOD Generation With Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/) — the full LOD-chain and encode workflow this tuning slots into
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — wrapping the tuned glTF as b3dm with correct bounding volumes
- [Automated Mesh Decimation for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/) — the triangle-budget decimation that precedes quantization

Back to [glTF LOD Generation With Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
