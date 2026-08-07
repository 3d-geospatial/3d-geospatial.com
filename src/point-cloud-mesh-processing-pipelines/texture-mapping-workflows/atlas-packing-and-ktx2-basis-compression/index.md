---
title: "Atlas Packing and KTX2 Basis Compression"
description: "Pack UV islands with xatlas, choose gutters that survive mipmapping, and encode to KTX2 UASTC or ETC1S so textures stay compressed on the GPU rather than only on the wire."
---
# Atlas Packing and KTX2 Basis Compression

This page packs a building's UV islands into an atlas with a gutter that survives mipmapping, then encodes that atlas to KTX2 with Basis Universal so it stays compressed in GPU memory rather than only on the wire. The second half is the one that matters for a city: a PNG or JPEG texture is decompressed to raw RGBA on upload, so a tileset whose download looks modest can occupy several times its own size in VRAM.

## Why you hit this

Texture memory, not geometry, is usually what makes a city tileset evict. A 1024×1024 RGBA texture is 4 MB resident regardless of whether it arrived as a 180 KB JPEG, and a few hundred visible buildings each carrying one is more VRAM than the geometry will ever use. KTX2 with a Basis payload transcodes to whichever block-compressed format the device supports — BC7 on desktop, ASTC or ETC2 on mobile — so the same texture occupies a quarter to a sixth of that and never round-trips through raw pixels.

The atlas this packs is produced by the baking step in [texture mapping workflows](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).

## Prerequisites

- Python 3.10+ with `xatlas>=0.0.7`, `trimesh>=4.0`, `numpy>=1.24` and `Pillow>=10`.
- `toktx` or `basisu` from the KTX-Software toolchain, plus `@gltf-transform/cli` for wiring the result into a glTF.
- A mesh with per-face material assignments if you intend to keep materials separable, because packing merges them.

## Step-by-Step

### 1. Pack the islands with a gutter sized for mipmapping

`xatlas` does the packing; the parameter that matters is the padding between islands.

```python
import numpy as np
import trimesh
import xatlas

mesh = trimesh.load("building_block.ply", force="mesh")

atlas = xatlas.Atlas()
atlas.add_mesh(mesh.vertices, mesh.faces)

chart = xatlas.ChartOptions()
chart.max_cost = 4.0                  # lower splits more, reducing distortion

pack = xatlas.PackOptions()
pack.resolution = 2048
pack.padding = 8                      # texels between islands — see below
pack.bilinear = True
pack.block_align = True               # align islands to 4x4 blocks for BCn/ASTC

atlas.generate(chart_options=chart, pack_options=pack)
vmap, indices, uvs = atlas[0]
print(f"{atlas.chart_count} charts, {atlas.width}x{atlas.height}, "
      f"utilisation {atlas.utilization[0]:.1%}")
```

The gutter has to survive every mip level you intend to sample, and each level halves it. Eight texels at the base gives four at mip 1, two at mip 2 and one at mip 3 — so eight is the minimum for a texture sampled three levels down, and sixteen is safer for a full mip chain. Too small a gutter is the cause of the coloured fringes that appear on distant buildings and not on close ones, which is a distinctive and frequently misdiagnosed symptom.

<figure class="diagram">
<svg viewBox="46 46 629 208" role="img" aria-labelledby="ak-gutter-t ak-gutter-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ak-gutter-t">Each mip level halves the gutter</title>
  <desc id="ak-gutter-d">A gutter of eight texels at the base resolution becomes four at the first mip level, two at the second and one at the third. Once it reaches a single texel, bilinear filtering samples across the island boundary and the neighbouring island's colour bleeds in, which appears as a fringe only at distance.</desc>
  <rect class="svg-bg" x="46" y="46" width="629" height="208" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="60" width="90" height="60" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="174" y="60" width="90" height="60" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="330" y="60" width="46" height="30" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="382" y="60" width="46" height="30" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="60" width="24" height="16" rx="2" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="527" y="60" width="24" height="16" rx="2" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="620" y="60" width="12" height="8" rx="1" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="633" y="60" width="12" height="8" rx="1" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="162" y="150">base — 8 texel gutter</text>
    <text x="379" y="150">mip 1 — 4</text>
    <text x="525" y="150">mip 2 — 2</text>
    <text x="632" y="150">mip 3 — 1</text>
  </g>
  <text x="632" y="176" fill="#b0413e" font-size="11.5" text-anchor="middle">bleeds</text>
  <text x="370" y="212" fill="#15384a" font-size="12.5" text-anchor="middle">The fringe appears only at distance, because only distant geometry samples the deep mip levels</text>
  <text x="370" y="236" fill="#5b6471" font-size="12" text-anchor="middle">Which is why it survives review — the model is inspected close up, where the gutter is still wide</text>
</svg>
<figcaption>A gutter that looks generous at the base resolution is one texel three levels down, and that is where the bleeding starts.</figcaption>
</figure>

### 2. Rebuild the mesh against the new UVs

`xatlas` returns a vertex remap, so the mesh has to be rebuilt rather than patched.

```python
import numpy as np
import trimesh

new_vertices = mesh.vertices[vmap]
new_normals = mesh.vertex_normals[vmap]
packed = trimesh.Trimesh(vertices=new_vertices, faces=indices, process=False)
packed.visual = trimesh.visual.TextureVisuals(uv=uvs)

print(f"vertices {len(mesh.vertices):,} → {len(new_vertices):,} "
      f"(+{100 * (len(new_vertices) / len(mesh.vertices) - 1):.1f}% from seam splits)")
```

The vertex count always grows, because every vertex on an island boundary has to be duplicated so it can carry two texture coordinates. A ten to twenty per cent increase is normal; forty per cent or more means `max_cost` is splitting charts too aggressively and is worth raising.

### 3. Encode to KTX2 — UASTC or ETC1S

The two Basis modes are not quality settings, they are different formats for different content.

```bash
# UASTC: high quality, larger, for colour and normal maps that matter.
toktx --t2 --uastc 3 --uastc_rdo_l 1.0 --zcmp 18 --genmipmap \
      --assign_oetf srgb block_albedo.ktx2 block_albedo.png

# ETC1S: much smaller, lossier, for ambient occlusion, roughness and distant LODs.
toktx --t2 --bcmp --clevel 4 --qlevel 200 --genmipmap \
      --assign_oetf linear block_ao.ktx2 block_ao.png

ktxinfo block_albedo.ktx2 | head -12
```

ETC1S compresses far harder and introduces visible blocking on high-frequency colour, so it suits single-channel maps and distant levels of detail. UASTC keeps facade detail intact and is roughly three to four times the file size. Both transcode to a block-compressed GPU format, which is the property that matters — the file size difference is secondary to the fact that neither ever becomes raw RGBA.

<figure class="diagram">
<svg viewBox="15 42 748 212" role="img" aria-labelledby="ak-vram-t ak-vram-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ak-vram-t">Download size against what actually sits in VRAM</title>
  <desc id="ak-vram-d">A JPEG texture downloads small and is decompressed to raw RGBA on upload, so a 2048 by 2048 map occupies sixteen megabytes of GPU memory. The same map as KTX2 with a Basis payload transcodes to a block-compressed format and occupies four megabytes, or two and a half with ETC1S, and never passes through raw pixels.</desc>
  <rect class="svg-bg" x="15" y="42" width="748" height="212" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="60" y="56" width="30" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="90" width="480" height="26" rx="3" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="60" y="142" width="96" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="60" y="176" width="120" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="100" y="74">JPEG download — 0.9 MB</text>
    <text x="550" y="108">JPEG in VRAM — 16.0 MB raw RGBA</text>
    <text x="166" y="160">KTX2 UASTC download — 3.1 MB</text>
    <text x="190" y="194">KTX2 in VRAM — 4.0 MB, stays compressed</text>
  </g>
  <text x="370" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">KTX2 downloads three times larger and occupies a quarter of the memory — and memory is what evicts a city tileset</text>
</svg>
<figcaption>The comparison people make is the top pair of bars. The one that decides whether a tileset holds together is the bottom.</figcaption>
</figure>

### 4. Wire the KTX2 into the glTF

The extension has to be declared, and it has to be declared as required for the payload to be meaningful.

```bash
npx @gltf-transform/cli uastc block.glb block_ktx2.glb \
  --slots "{baseColorTexture,normalTexture}" --level 3 --rdo 1.0 --zstd 18

npx @gltf-transform/cli etc1s block_ktx2.glb block_final.glb \
  --slots "{occlusionTexture,metallicRoughnessTexture}" --quality 200

npx @gltf-transform/cli inspect block_final.glb | grep -A4 "textures"
```

```python
from pygltflib import GLTF2

g = GLTF2().load("block_final.glb")
print("extensionsUsed:", g.extensionsUsed)
print("extensionsRequired:", g.extensionsRequired)
assert "KHR_texture_basisu" in (g.extensionsRequired or []), \
    "KTX2 payload present but the extension is not required — non-supporting clients will render untextured"
```

### 5. Check the atlas actually improved anything

Packing and encoding both have failure modes that look like success.

```python
from PIL import Image
import os

def report(path, uvs):
    size = os.path.getsize(path) / 1e6
    print(f"{os.path.basename(path):<24} {size:6.2f} MB")

import numpy as np
inside = ((uvs >= 0.0) & (uvs <= 1.0)).all(axis=1).mean()
print(f"UVs inside [0,1]: {100 * inside:.2f}%")
assert inside > 0.999, "UVs escaped the atlas — packing failed or the remap was misapplied"
print(f"atlas utilisation: {atlas.utilization[0]:.1%}")
```

Utilisation below about 50% means the packer is wasting half the texture on empty space, usually because a few very large charts dominate. Raising `max_cost` splits them and typically recovers ten to twenty points, at the cost of more seams and a slightly higher vertex count.

<figure class="diagram">
<svg viewBox="16 42 694 214" role="img" aria-labelledby="ak-mode-t ak-mode-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ak-mode-t">Which Basis mode suits which map</title>
  <desc id="ak-mode-d">UASTC keeps facade colour and normal directions intact and costs three to four times the bytes. ETC1S quantises chroma aggressively, which is invisible on a single-channel occlusion or roughness map and produces visible blocking on high-frequency colour. Distant levels of detail can drop to ETC1S because nothing samples them closely.</desc>
  <rect class="svg-bg" x="16" y="42" width="694" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="56" width="200" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="98" width="200" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="30" y="140" width="200" height="34" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="30" y="182" width="200" height="34" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="130" y="78">baseColorTexture</text>
    <text x="130" y="120">normalTexture</text>
    <text x="130" y="162">occlusionTexture</text>
    <text x="130" y="204">metallicRoughness</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="252" y="78">UASTC — chroma detail is the subject</text>
    <text x="252" y="120">UASTC — channels are directions, not colours</text>
    <text x="252" y="162">ETC1S — single channel, artefacts invisible</text>
    <text x="252" y="204">ETC1S — single channel, artefacts invisible</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Mixing the two per slot typically halves the texture payload against UASTC everywhere, with nothing visible lost</text>
</svg>
<figcaption>The two modes are not quality tiers. One preserves chroma and one discards it, and half a glTF&#39;s texture slots do not carry chroma at all.</figcaption>
</figure>

## Expected Output & Verification

A representative run on a photogrammetric block:

```text
412 charts, 2048x2048, utilisation 71.4%
vertices 184,220 → 211,884 (+15.0% from seam splits)
UVs inside [0,1]: 100.00%
block_albedo.ktx2         3.14 MB
block_ao.ktx2             0.42 MB
extensionsRequired: ['KHR_texture_basisu']
```

Then confirm the two things a file inspection cannot: that the texture looks right at distance, which is where a thin gutter shows, and that VRAM fell. The second is measurable directly:

```javascript
const info = viewer.scene.context._gl.getExtension('WEBGL_debug_renderer_info');
console.log('texture memory MB:', (viewer.scene.totalMemoryUsageInBytes / 1e6).toFixed(1));
```

A tileset that moved from JPEG to KTX2 should show texture memory falling by roughly a factor of four, and the tile eviction rate falling with it.

## Common Errors

**Coloured fringes on distant buildings only.** The gutter is too small for the deep mip levels. Raise `padding` to 16 and rebuild; there is no runtime fix.

**Every model renders untextured in one viewer.** `KHR_texture_basisu` is in `extensionsUsed` but not `extensionsRequired`, so a non-supporting client loads the file, finds no fallback image, and draws it plain. Declare it required.

**KTX2 files are larger than the JPEGs and VRAM did not fall.** The encode produced an uncompressed KTX2 rather than a Basis payload — `--t2` without `--uastc` or `--bcmp`. Check with `ktxinfo` that the supercompression scheme is set.

**Atlas utilisation is very low.** A handful of enormous charts. Raise `chart.max_cost` to split them, and accept the extra seams.

## Frequently Asked Questions

### One atlas per building or one per block?
Per block, up to about 2048 or 4096 square. One atlas per building multiplies the draw calls, which as [triangle-count tuning](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) shows is the frame cost that actually matters.

### Does KTX2 slow down loading?
Transcoding costs a few milliseconds per texture on the CPU, against a JPEG decode of similar magnitude. The saving is on the GPU side, where the upload is smaller and stays smaller.

### Should normal maps use UASTC or ETC1S?
UASTC. ETC1S quantises chroma aggressively, and a normal map's channels are directions rather than colours, so the artefacts appear as visible faceting in the lighting.

One planning note before adopting this. KTX2 changes where the cost sits rather than removing it: the download grows, the GPU memory falls, and the CPU pays a transcode. For a tileset whose problem is bandwidth on a slow connection that is the wrong trade, and JPEG plus aggressive resolution reduction is better. For a city tileset whose problem is eviction — which is nearly all of them past a few hundred visible buildings — it is decisively the right one.

The second note concerns tooling. Both `toktx` and `gltf-transform` will happily produce a KTX2 file with no supercompression, which is a valid container holding uncompressed pixels and offers none of the benefit. Because the extension is declared either way and the render is identical, the only signal is the file size and `ktxinfo`. Check the supercompression scheme in the same step that writes the file, not in review.

Finally, keep the source PNGs. Basis is a lossy encode and the parameters will be revisited — a change of mode, a different RDO setting, a new device class in the fleet — and re-encoding from an already-encoded texture compounds the loss.

### Can the atlas be rebuilt without re-baking the textures?
No. The UV layout and the texture are one artifact — repacking moves every island, so the baked pixels no longer correspond to the coordinates. Re-baking is the cost of a repack, which is a reason to settle the atlas resolution and gutter before baking rather than after.

## Related Guides

- [Texture Mapping Workflows for 3D Geospatial](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/) — producing the atlas this packs
- [Baking Normal and AO Maps for Web Delivery](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/baking-normal-and-ao-maps-for-web-delivery/) — the maps that get encoded differently
- [Preserving UV Seams During Mesh Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/preserving-uv-seams-during-mesh-decimation/) — protecting the islands this packing created

Back to [Texture Mapping Workflows for 3D Geospatial](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
