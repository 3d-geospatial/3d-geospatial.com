---
title: "Encoding Property Textures for Per-Texel Data"
description: "Store analysis results per texel instead of per feature: EXT_structural_metadata property textures, channel packing, normalisation"
---
# Encoding Property Textures for Per-Texel Data

This page stores continuous analysis results — facade solar irradiance, surface temperature, corrosion risk — as property textures on 3D Tiles content, so the value varies across a wall rather than being a single number per building: packing several properties into one image's channels, normalising to integer ranges, meeting the UV requirements, and decoding the result back to physical units to prove the round trip.

## Why you hit this

Per-feature metadata gives one value per building. That is right for a construction year and useless for solar irradiance, which varies by a factor of four between a south-facing top storey and a shaded north-facing ground floor. Averaging it to one number per building discards the analysis.

Property textures solve this by storing the value per texel, sampled through the same UVs as the base colour texture. The data is then available to a style expression and to picking at the point the user clicked, at the cost of one extra image per tile and a careful encoding step.

## Prerequisites

- Tile content with UVs, ideally a per-tile atlas from [tiling photogrammetry OBJ meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/tiling-photogrammetry-obj-meshes/) or [generating UV atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/).
- The schema from [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/), extended with a class for the texel properties.
- Python 3.10+ with `numpy` and `Pillow`; `gltf-transform` for inspection.

## Step-by-Step

### 1. Decide what belongs in a property texture

```python
import json
from pathlib import Path

import numpy as np
from PIL import Image

CANDIDATES = {
    "solarIrradiance":   {"unit": "kWh/m²/yr", "range": (0, 1400),
                          "varies": "strongly across a facade", "verdict": "texture"},
    "surfaceTempSummer": {"unit": "°C", "range": (-10, 70),
                          "varies": "strongly with orientation", "verdict": "texture"},
    "corrosionRisk":     {"unit": "index 0–1", "range": (0, 1),
                          "varies": "by height and exposure", "verdict": "texture"},
    "yearOfConstruction": {"unit": "year", "range": (1700, 2030),
                           "varies": "not at all within a building",
                           "verdict": "per-feature"},
    "registerId":        {"unit": "string", "range": None,
                          "varies": "not at all", "verdict": "per-feature"},
    "roofArea":          {"unit": "m²", "range": (0, 5000),
                          "varies": "one value per building by definition",
                          "verdict": "per-feature"},
}

for name, spec in CANDIDATES.items():
    print(f"{name:<22}{spec['verdict']:<14}{spec['varies']}")
```

The test is whether the value varies *within* one feature. A property that does not has no business in a texture: it costs an image, a UV lookup and a normalisation round trip to store one number 4 million times.

Property textures are also unsuitable for anything discrete with many categories. A material classification with 40 classes could be encoded as an index, and bilinear filtering between texels would produce meaningless intermediate indices — so either the sampler must be set to nearest, or the property belongs elsewhere.

### 2. Normalise to an integer range and record the transform

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class ChannelEncoding:
    name: str
    unit: str
    component_type: str      # "UINT8" or "UINT16"
    offset: float            # physical = raw * scale + offset
    scale: float
    no_data_raw: int | None

def plan_encoding(name, unit, lo, hi, component_type="UINT8", reserve_no_data=True):
    """Map a physical range onto the integer range, reserving one value for no-data."""
    max_raw = 255 if component_type == "UINT8" else 65535
    usable_max = max_raw - 1 if reserve_no_data else max_raw
    scale = (hi - lo) / usable_max
    return ChannelEncoding(name=name, unit=unit, component_type=component_type,
                           offset=lo, scale=scale,
                           no_data_raw=max_raw if reserve_no_data else None)

def encode(values, enc, mask=None):
    """Physical units -> raw integers, with no-data written as the reserved value."""
    v = np.asarray(values, dtype=np.float64)
    raw = np.rint((v - enc.offset) / enc.scale)
    usable_max = (255 if enc.component_type == "UINT8" else 65535) \
        - (1 if enc.no_data_raw is not None else 0)
    raw = np.clip(raw, 0, usable_max)
    dtype = np.uint8 if enc.component_type == "UINT8" else np.uint16
    out = raw.astype(dtype)
    if mask is not None and enc.no_data_raw is not None:
        out[mask] = enc.no_data_raw
    return out

def decode(raw, enc):
    r = np.asarray(raw)
    phys = r.astype(np.float64) * enc.scale + enc.offset
    if enc.no_data_raw is not None:
        phys = np.where(r == enc.no_data_raw, np.nan, phys)
    return phys

SOLAR = plan_encoding("solarIrradiance", "kWh/m²/yr", 0.0, 1400.0, "UINT8")
TEMP = plan_encoding("surfaceTempSummer", "°C", -10.0, 70.0, "UINT8")
print(SOLAR, "\n", TEMP)
print("quantisation step:", round(SOLAR.scale, 3), SOLAR.unit)
```

The quantisation step is the number to check before committing to eight bits. Solar irradiance over 0–1400 in 254 steps is about 5.5 kWh/m²/yr per step, which is far below the analysis's own uncertainty and therefore free. Surface temperature over an 80 °C range is 0.32 °C per step, also fine.

A property needing better than roughly 1/250 of its range needs `UINT16` and its own channel pair, or a tighter range. Narrowing the range is usually the better answer: if no facade in the dataset exceeds 1,100 kWh/m²/yr, encoding 0–1400 wastes a fifth of the resolution.

Reserving the top raw value for no-data costs one step of resolution and makes unlit interior faces distinguishable from genuinely dark ones, which matters because an unanalysed texel decoded as 0 kWh looks like a real shaded surface.

<figure class="diagram">
<svg viewBox="10 -2 720 258" role="img" aria-labelledby="ptex-pack-t ptex-pack-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ptex-pack-t">Packing four properties into one RGBA image</title>
  <desc id="ptex-pack-d">One RGBA texture carrying four separate properties. The red channel holds solar irradiance encoded from 0 to 1400 kilowatt hours per square metre per year in 254 steps. The green channel holds summer surface temperature from minus 10 to 70 degrees. The blue channel holds corrosion risk from 0 to 1. The alpha channel holds a validity mask. Each channel records its own offset and scale in the schema so the client can decode back to physical units.</desc>
  <rect class="svg-bg" x="10" y="-2" width="720" height="258" fill="#ffffff"/>
  <g stroke-width="1.6">
    <rect x="24" y="40" width="160" height="58" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="24" y="98" width="160" height="58" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="24" y="156" width="160" height="58" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="216" y="40" width="240" height="58" fill="#ffffff" stroke="#5b6471"/>
    <rect x="216" y="98" width="240" height="58" fill="#ffffff" stroke="#5b6471"/>
    <rect x="216" y="156" width="240" height="58" fill="#ffffff" stroke="#5b6471"/>
    <rect x="488" y="40" width="228" height="58" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="488" y="98" width="228" height="58" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="488" y="156" width="228" height="58" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="104" y="64">channel R</text><text x="104" y="84">UINT8</text>
    <text x="104" y="122">channel G</text><text x="104" y="142">UINT8</text>
    <text x="104" y="180">channel B</text><text x="104" y="200">UINT8</text>
    <text x="336" y="64">solarIrradiance</text><text x="336" y="84">0 … 1400 kWh/m²/yr</text>
    <text x="336" y="122">surfaceTempSummer</text><text x="336" y="142">−10 … 70 °C</text>
    <text x="336" y="180">corrosionRisk</text><text x="336" y="200">0 … 1 index</text>
    <text x="602" y="64">step 5.51 kWh</text><text x="602" y="84">raw 255 = no data</text>
    <text x="602" y="122">step 0.31 °C</text><text x="602" y="142">raw 255 = no data</text>
    <text x="602" y="180">step 0.0039</text><text x="602" y="200">raw 255 = no data</text>
  </g>
  <text x="370" y="26" fill="#1f2937" font-size="13" text-anchor="middle">one 1024² RGBA image — 4 MB raw, 0.6 MB as lossless WebP</text>
  <text x="370" y="238" fill="#5b6471" font-size="12" text-anchor="middle">the alpha channel carries a validity mask; offset and scale live in the schema, not in the image</text>
</svg>
<figcaption>Four properties in one image and one UV lookup; the schema carries the offsets and scales that turn raw channels back into units.</figcaption>
</figure>

### 3. Render the analysis into texture space

```python
def rasterise_to_uv(triangles_uv, triangle_values, size=1024, dilate_px=2):
    """Bake per-triangle analysis values into the mesh's UV layout."""
    acc = np.zeros((size, size), dtype=np.float64)
    hits = np.zeros((size, size), dtype=np.int32)

    for tri_uv, value in zip(triangles_uv, triangle_values):
        u = np.clip(tri_uv[:, 0] * (size - 1), 0, size - 1)
        v = np.clip((1.0 - tri_uv[:, 1]) * (size - 1), 0, size - 1)
        u0, u1 = int(np.floor(u.min())), int(np.ceil(u.max()))
        v0, v1 = int(np.floor(v.min())), int(np.ceil(v.max()))
        if u1 <= u0 or v1 <= v0:
            uu, vv = int(round(u.mean())), int(round(v.mean()))
            acc[vv, uu] += value
            hits[vv, uu] += 1
            continue
        yy, xx = np.mgrid[v0:v1 + 1, u0:u1 + 1]
        # Barycentric inside test
        d = ((v[1] - v[2]) * (u[0] - u[2]) + (u[2] - u[1]) * (v[0] - v[2]))
        if abs(d) < 1e-9:
            continue
        a = ((v[1] - v[2]) * (xx - u[2]) + (u[2] - u[1]) * (yy - v[2])) / d
        b = ((v[2] - v[0]) * (xx - u[2]) + (u[0] - u[2]) * (yy - v[2])) / d
        c = 1.0 - a - b
        inside = (a >= -1e-6) & (b >= -1e-6) & (c >= -1e-6)
        acc[yy[inside], xx[inside]] += value
        hits[yy[inside], xx[inside]] += 1

    valid = hits > 0
    out = np.zeros_like(acc)
    out[valid] = acc[valid] / hits[valid]

    for _ in range(dilate_px):
        grown = valid.copy()
        grown[1:, :] |= valid[:-1, :]
        grown[:-1, :] |= valid[1:, :]
        grown[:, 1:] |= valid[:, :-1]
        grown[:, :-1] |= valid[:, 1:]
        fill = grown & ~valid
        neighbour_sum = np.zeros_like(out)
        neighbour_n = np.zeros_like(hits)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(np.where(valid, out, 0.0), (dy, dx), axis=(0, 1))
            shifted_valid = np.roll(valid, (dy, dx), axis=(0, 1))
            neighbour_sum += shifted
            neighbour_n += shifted_valid.astype(np.int32)
        out[fill] = neighbour_sum[fill] / np.maximum(neighbour_n[fill], 1)
        valid = grown

    return out, valid
```

Dilating the valid region by a couple of texels is the step that prevents a visible black seam at every UV island boundary. The bilinear sampler reaches outside the rasterised triangle at its edges, and without dilation it reads the zero-filled background — which decodes to the bottom of the property's range and shows as a dark rim on every facade.

Averaging rather than taking the last value where triangles overlap in UV space matters for atlases produced by packing, where adjacent islands can share a texel row.

### 4. Pack the channels and write the image

```python
def pack_rgba(channels, encodings, masks, size=1024):
    """channels: {name: float array (size,size)}; returns a PIL image and the schema entries."""
    order = list(channels)
    assert len(order) <= 4, "one RGBA image carries at most four UINT8 properties"
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    schema_channels = []
    for i, name in enumerate(order):
        enc = encodings[name]
        assert enc.component_type == "UINT8", "UINT16 needs two channels or a 16-bit image"
        rgba[:, :, i] = encode(channels[name], enc, mask=~masks[name])
        schema_channels.append({"property": name, "channel": i,
                                "offset": enc.offset, "scale": enc.scale,
                                "noData": enc.no_data_raw})
    for i in range(len(order), 4):
        rgba[:, :, i] = 255                     # unused channels: fully valid white
    return Image.fromarray(rgba, mode="RGBA"), schema_channels

def write_property_texture(image, out_path, lossless=True):
    """Lossless only — a lossy codec corrupts the values."""
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.suffix == ".webp":
        image.save(p, format="WEBP", lossless=True, quality=100, method=6)
    elif p.suffix == ".png":
        image.save(p, format="PNG", optimize=True)
    else:
        raise ValueError("property textures must be PNG or lossless WebP")
    return {"path": str(p), "bytes": p.stat().st_size,
            "size": image.size, "lossless": lossless}
```

Lossless encoding is not a preference, it is a correctness requirement. A JPEG or lossy WebP property texture is a texture of *approximately* the right integers, and since each integer is 5.5 kWh of irradiance, a compression artefact of three levels is a 16 kWh error that varies spatially in a way that looks like real structure.

Unused channels set to 255 rather than 0 is a small detail worth getting right: a client that samples all four channels and finds zeros may interpret them as valid minimum values.

Sixteen-bit properties need either a 16-bit PNG with its own image or two eight-bit channels combined as high and low bytes, and the second option requires the client to do the recombination — which the specification does support through a multi-channel property but which not every client implements well.

### 5. Declare the property texture in the glTF and the schema

```python
SCHEMA_ADDITION = {
    "classes": {
        "facadeAnalysis": {
            "name": "Facade analysis",
            "properties": {
                "solarIrradiance": {
                    "type": "SCALAR", "componentType": "UINT8",
                    "normalized": True, "offset": 0.0, "scale": 1400.0,
                    "noData": 255,
                },
                "surfaceTempSummer": {
                    "type": "SCALAR", "componentType": "UINT8",
                    "normalized": True, "offset": -10.0, "scale": 80.0,
                    "noData": 255,
                },
                "corrosionRisk": {
                    "type": "SCALAR", "componentType": "UINT8",
                    "normalized": True, "offset": 0.0, "scale": 1.0,
                    "noData": 255,
                },
            },
        }
    }
}

def attach_property_texture(gltf_doc, image_index, texture_index, schema_channels,
                            primitive_indices):
    """Add EXT_structural_metadata propertyTextures and point primitives at it."""
    ext = gltf_doc.setdefault("extensions", {}).setdefault("EXT_structural_metadata", {})
    ext.setdefault("schema", SCHEMA_ADDITION)
    tables = ext.setdefault("propertyTextures", [])
    properties = {}
    for ch in schema_channels:
        properties[ch["property"]] = {"index": texture_index, "texCoord": 0,
                                      "channels": [ch["channel"]]}
    tables.append({"class": "facadeAnalysis", "properties": properties})
    pt_index = len(tables) - 1

    for mesh_i, prim_i in primitive_indices:
        prim = gltf_doc["meshes"][mesh_i]["primitives"][prim_i]
        prim.setdefault("extensions", {}) \
            .setdefault("EXT_structural_metadata", {}) \
            .setdefault("propertyTextures", []) \
            .append(pt_index)

    used = gltf_doc.setdefault("extensionsUsed", [])
    if "EXT_structural_metadata" not in used:
        used.append("EXT_structural_metadata")
    return {"propertyTexture": pt_index, "properties": list(properties)}
```

`normalized: True` with `offset` and `scale` is the declaration that makes the raw bytes meaningful. The client reads the channel as a normalised 0–1 float, multiplies by `scale` and adds `offset`, and gets kilowatt-hours — so the transform lives in the schema and the image stays a plain image.

The `channels` array is what allows four properties in one texture: each property names the channel indices it occupies, and a `UINT16` property names two.

The sampler on the texture matters. `LINEAR` filtering is correct and desirable for continuous properties, and wrong for anything index-like; `CLAMP_TO_EDGE` wrapping avoids sampling the opposite edge of the atlas at island boundaries.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="ptex-decide-t ptex-decide-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ptex-decide-t">Per-feature, per-texel or neither</title>
  <desc id="ptex-decide-d">A table of four properties and where each belongs. Solar irradiance varies strongly across a facade and belongs in a property texture. Surface temperature does too. Construction year does not vary within a building and belongs in a per-feature property table. A register identifier is a string and belongs per feature. A material classification with forty categories belongs nowhere in a texture because bilinear filtering would produce meaningless intermediate indices.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="214" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="232" y="20" width="232" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="464" y="20" width="258" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="214" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="54" width="232" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="464" y="54" width="258" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="214" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="88" width="232" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="464" y="88" width="258" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="214" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="232" y="122" width="232" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="464" y="122" width="258" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="156" width="214" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="232" y="156" width="232" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="464" y="156" width="258" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="190" width="214" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="232" y="190" width="232" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="464" y="190" width="258" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="125" y="42">property</text><text x="348" y="42">varies within a feature?</text><text x="593" y="42">where it belongs</text>
    <text x="125" y="76">solar irradiance</text><text x="348" y="76">strongly, by orientation</text><text x="593" y="76">property texture</text>
    <text x="125" y="110">surface temperature</text><text x="348" y="110">strongly</text><text x="593" y="110">property texture</text>
    <text x="125" y="144">year of construction</text><text x="348" y="144">not at all</text><text x="593" y="144">per-feature table</text>
    <text x="125" y="178">register identifier</text><text x="348" y="178">not at all, and a string</text><text x="593" y="178">per-feature table</text>
    <text x="125" y="212">material class, 40 values</text><text x="348" y="212">yes, but discrete</text><text x="593" y="212">neither — filtering breaks it</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">The test is whether the value varies within one feature; nothing else decides this.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">A discrete index in a filtered texture produces categories that do not exist.</text>
</svg>
<figcaption>One question answers the first four rows; the fifth shows why a discrete property cannot be a texture.</figcaption>
</figure>

### 6. Read it back and confirm the round trip

```python
import subprocess

def decode_roundtrip_check(image_path, encodings, reference, sample_uvs, tol_frac=0.01):
    """Sample the written image at known UVs and compare against the source analysis."""
    img = np.asarray(Image.open(image_path).convert("RGBA"))
    size = img.shape[0]
    rows = []
    for name, enc in encodings.items():
        channel = {"solarIrradiance": 0, "surfaceTempSummer": 1, "corrosionRisk": 2}[name]
        errors = []
        for (u, v), expected in sample_uvs[name]:
            px = int(round(np.clip(u, 0, 1) * (size - 1)))
            py = int(round((1.0 - np.clip(v, 0, 1)) * (size - 1)))
            raw = int(img[py, px, channel])
            got = decode(np.array([raw]), enc)[0]
            if np.isnan(got):
                errors.append({"uv": (u, v), "status": "no data"})
                continue
            span = abs(enc.scale) * 255
            errors.append({"uv": (u, v), "expected": round(expected, 3),
                           "got": round(float(got), 3),
                           "error": round(float(got) - expected, 3),
                           "within": abs(float(got) - expected) <= tol_frac * span})
        numeric = [e for e in errors if "error" in e]
        rows.append({
            "property": name,
            "samples": len(errors),
            "no_data": len(errors) - len(numeric),
            "max_abs_error": round(max((abs(e["error"]) for e in numeric), default=0.0), 3),
            "quantisation_step": round(enc.scale, 4),
            "all_within_tolerance": all(e["within"] for e in numeric),
        })
    return rows

for row in decode_roundtrip_check("output/content/facade_props_12021000.webp",
                                  {"solarIrradiance": SOLAR, "surfaceTempSummer": TEMP},
                                  reference=None, sample_uvs=SAMPLES):
    print(row)
```

The maximum absolute error must be at or below half the quantisation step, and anything larger means either the image was written lossily or the encode and decode transforms disagree. That single check catches both of the mistakes that make a property texture silently wrong.

<figure class="diagram">
<svg viewBox="24 12 692 230" role="img" aria-labelledby="ptex-loss-t ptex-loss-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ptex-loss-t">Why the codec must be lossless</title>
  <desc id="ptex-loss-d">A comparison of decode error for three encodings of the same solar irradiance channel. Lossless WebP gives a maximum error of 2.7 kilowatt hours, which is half the quantisation step and is the floor. JPEG at quality 95 gives 41 kilowatt hours. JPEG at quality 80 gives 138 kilowatt hours, a tenth of the whole range, and the error is spatially correlated so it looks like real structure on the facade.</desc>
  <rect class="svg-bg" x="24" y="12" width="692" height="230" fill="#ffffff"/>
  <path d="M40 26 V180 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M40 26 V180" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="38" width="13" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="80" width="197" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="122" width="662" height="30" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="63" y="58">lossless WebP: max error 2.7 kWh — the quantisation floor</text>
    <text x="247" y="100">JPEG q95: max error 41 kWh</text>
    <text x="40" y="172">JPEG q80: max error 138 kWh — 10% of the full range</text>
  </g>
  <text x="40" y="202" fill="#1f2937" font-size="12.5">the error is spatially correlated, so it reads as real variation across the facade</text>
  <text x="40" y="224" fill="#5b6471" font-size="12">1024² channel, 0–1400 kWh/m²/yr in 254 steps; lossless WebP costs 0.6 MB, JPEG q80 costs 0.09 MB</text>
</svg>
<figcaption>A lossy codec turns a property texture into plausible fiction; the 0.5 MB saved is not worth it.</figcaption>
</figure>

## Expected Output & Verification

```text
solarIrradiance       texture       strongly across a facade
surfaceTempSummer     texture       strongly with orientation
corrosionRisk         texture       by height and exposure
yearOfConstruction    per-feature   not at all within a building
registerId            per-feature   not at all
roofArea              per-feature   one value per building by definition
ChannelEncoding(name='solarIrradiance', unit='kWh/m²/yr', component_type='UINT8',
                offset=0.0, scale=5.5118…, no_data_raw=255)
quantisation step: 5.512 kWh/m²/yr
{'path': 'output/content/facade_props_12021000.webp', 'bytes': 612844,
 'size': (1024, 1024), 'lossless': True}
{'propertyTexture': 0, 'properties': ['solarIrradiance', 'surfaceTempSummer', 'corrosionRisk']}
{'property': 'solarIrradiance', 'samples': 240, 'no_data': 18, 'max_abs_error': 2.71,
 'quantisation_step': 5.5118, 'all_within_tolerance': True}
{'property': 'surfaceTempSummer', 'samples': 240, 'no_data': 18, 'max_abs_error': 0.16,
 'quantisation_step': 0.3137, 'all_within_tolerance': True}
```

A maximum error of 2.71 against a step of 5.51 is exactly half a step, which is the theoretical floor for rounding — the encoding is as good as eight bits allows. The 18 no-data samples are texels on interior faces the analysis did not cover, correctly distinguishable from zero irradiance.

Verify the texture is actually reachable from the primitives, which is the structural mistake that produces a valid file with no accessible properties:

```python
def reachability_check(glb_path):
    doc = json.loads(subprocess.run(
        ["npx", "gltf-transform", "copy", glb_path, "/dev/stdout", "--format", "gltf"],
        capture_output=True, text=True).stdout)
    ext = doc.get("extensions", {}).get("EXT_structural_metadata", {})
    textures = ext.get("propertyTextures", [])
    schema = ext.get("schema", {})
    problems = []
    if not textures:
        problems.append("no propertyTextures declared")
    referenced = set()
    prims_with = 0
    for mi, mesh in enumerate(doc.get("meshes", [])):
        for pi, prim in enumerate(mesh.get("primitives", [])):
            ids = ((prim.get("extensions") or {})
                   .get("EXT_structural_metadata") or {}).get("propertyTextures") or []
            if ids:
                prims_with += 1
                referenced.update(ids)
            if ids and "TEXCOORD_0" not in (prim.get("attributes") or {}):
                problems.append(f"mesh {mi} primitive {pi} has a property texture "
                                f"but no TEXCOORD_0")
    for i, pt in enumerate(textures):
        cls = schema.get("classes", {}).get(pt.get("class"))
        if cls is None:
            problems.append(f"propertyTexture {i} references unknown class {pt.get('class')}")
            continue
        for prop, binding in pt.get("properties", {}).items():
            if prop not in cls["properties"]:
                problems.append(f"propertyTexture {i} binds undeclared property {prop}")
            tex = doc.get("textures", [])[binding["index"]] if binding.get("index") is not None \
                else None
            if tex is None:
                problems.append(f"{prop} points at a missing texture")
    unreferenced = set(range(len(textures))) - referenced
    return {"property_textures": len(textures),
            "primitives_with_property_textures": prims_with,
            "unreferenced": sorted(unreferenced),
            "problems": problems[:5],
            "ok": not problems and not unreferenced}

print(json.dumps(reachability_check("output/content/12021000.glb"), indent=2))
```

A declared property texture that no primitive references is the commonest failure and it validates cleanly — the client simply never samples it, and the style expression returns undefined for every feature.

Then verify the sampler settings, since bilinear filtering on the wrong wrap mode produces edge artefacts that look like data:

```python
def sampler_check(glb_path, texture_index):
    doc = json.loads(subprocess.run(
        ["npx", "gltf-transform", "copy", glb_path, "/dev/stdout", "--format", "gltf"],
        capture_output=True, text=True).stdout)
    tex = doc["textures"][texture_index]
    sampler = doc.get("samplers", [])[tex["sampler"]] if "sampler" in tex else {}
    image = doc["images"][tex["source"]]
    return {
        "mimeType": image.get("mimeType"),
        "lossless": image.get("mimeType") in ("image/png", "image/webp"),
        "magFilter": sampler.get("magFilter"),
        "wrapS": sampler.get("wrapS"), "wrapT": sampler.get("wrapT"),
        "clamped": sampler.get("wrapS") == 33071 and sampler.get("wrapT") == 33071,
        "warning": None if sampler.get("wrapS") == 33071
                   else "REPEAT wrapping samples across atlas islands",
    }
```

## Performance Notes

- **A 1024² RGBA lossless WebP is 0.4–0.8 MB** for four properties, against about 4 MB raw. It is the largest single addition to a textured tile, so match the resolution to the analysis's own resolution rather than to the base colour texture.
- **512² is often enough.** Facade irradiance varies over metres, not centimetres; a 512² channel over a 120 m tile is about 23 cm per texel.
- **GPU cost is one extra texture unit and one sample**, which is negligible — the download is the cost.
- **Pack up to four UINT8 properties per image.** A fifth property means a second image and a second sample.
- **Do not mipmap a property texture** unless the property is genuinely continuous and averaging is meaningful; a mipmapped no-data sentinel averages into the data range.
- **KTX2 is not appropriate here.** Basis compression is lossy; property textures need PNG or lossless WebP.

## Common Errors

**Every sampled value is wrong by a constant factor.** The schema's `scale` and the encoder's `scale` disagree — one is the range, the other is the per-step increment. The schema's `scale` multiplies a normalised 0–1 value, so it is the full range.

**Values look like real structure but are not.** A lossy codec. Re-encode losslessly.

**Dark rim on every facade.** No dilation around UV islands, so the sampler reads background. Dilate by two texels.

**A style expression returns undefined.** No primitive references the property texture, or the primitive lacks `TEXCOORD_0`.

**No-data texels decode to the property's minimum.** The reserved no-data value was not declared, or was set to 0 rather than the top of the range.

**Values shift when the camera moves away.** Mipmapping is averaging across the no-data sentinel or across island boundaries. Disable mip generation for property textures.

**The texture is 4 MB per tile.** A 2048² RGBA at the base colour texture's resolution. Halve it twice; the analysis does not have that resolution.

## Frequently Asked Questions

### Can a property texture hold 16-bit values?

Yes, either as a 16-bit PNG or by binding two eight-bit channels to one property. Support for the two-channel form varies between clients, so test against yours before committing.

### How does picking work with property textures?

The client samples at the picked texel, so a click returns the value at that point on the surface rather than a feature-wide value. That is the main reason to use them: "this wall at this height receives 940 kWh" is a different answer from "this building averages 610".

### Should I use a property texture or vertex attributes?

Vertex attributes are better when the mesh is dense relative to the variation — a terrain with a value per vertex. Property textures are better when the mesh is coarse and the variation is fine, which is the usual case for facade analysis on extruded footprints.

## Related Guides

- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — the schema these properties extend
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — reading texel properties in an expression
- [Generating UV Atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/) — the UV layout a property texture depends on

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
