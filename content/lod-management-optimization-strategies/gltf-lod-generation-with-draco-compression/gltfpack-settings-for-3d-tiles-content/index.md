# gltfpack Settings for 3D Tiles Content

This page settles which `gltfpack` flags belong in a 3D Tiles pipeline: how far to quantise positions and UVs before the geometry visibly moves, when meshopt beats Draco, what to do about textures, and the three flags that produce a smaller file and a broken tileset — with a measured before-and-after on a city block.

## Why you hit this

`gltfpack` is the fastest way to make tile content small, and its defaults are tuned for standalone models rather than for tiles. A default run on tile content quantises positions to a bit depth chosen from the mesh's own bounds, merges nodes in ways that break instancing, and may drop the extensions a tileset depends on. The result is a 6× smaller file that is a centimetre off, or a tile whose features cannot be picked.

The flags themselves are simple. Knowing which ones interact with the tiling scheme is the part that takes a project to learn.

## Prerequisites

- `gltfpack` installed: `npm install -g gltfpack` (it bundles meshoptimizer and Basis).
- `gltf-transform` for verification — see [inspecting glTF with gltf-transform](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/inspecting-gltf-with-gltf-transform/).
- Tile content whose coordinates are **local**, near the origin, with the placement in the tile's transform.

## Step-by-Step

### 1. Establish the baseline before changing anything

```bash
IN=input/block_0412.glb
npx gltf-transform inspect "$IN" | head -30
ls -l "$IN"
```

```python
import json
import subprocess
from pathlib import Path

def measure(path):
    proc = subprocess.run(["npx", "gltf-transform", "inspect", "--format", "json", path],
                          capture_output=True, text=True)
    doc = json.loads(proc.stdout) if proc.returncode == 0 else {}
    meshes = doc.get("meshes", [])
    textures = doc.get("textures", [])
    return {
        "file": Path(path).name,
        "bytes": Path(path).stat().st_size,
        "vertices": sum(m.get("vertices", 0) for m in meshes),
        "primitives": sum(m.get("primitives", 0) for m in meshes),
        "textures": len(textures),
        "texture_bytes": sum(t.get("size", 0) for t in textures),
        "extensions": doc.get("extensionsUsed", []),
    }

base = measure("input/block_0412.glb")
print(json.dumps(base, indent=2))
```

Recording the baseline as a dict, rather than eyeballing the file size, is what lets the rest of this page be a comparison. The vertex count matters as much as the byte count: a setting that halves the file by dropping geometry is a different outcome from one that halves it by encoding the same geometry better, and only the second is free.

### 2. Understand what the quantisation flags actually control

```bash
# Positions: bits per component, relative to the mesh's bounding box
npx gltfpack -i "$IN" -o out/q14.glb -vp 14 -noq          # -noq disables, -vp sets bits
npx gltfpack -i "$IN" -o out/q12.glb -vp 12
npx gltfpack -i "$IN" -o out/q16.glb -vp 16

# Texture coordinates, normals, tangents
npx gltfpack -i "$IN" -o out/full.glb -vp 14 -vt 12 -vn 8
```

```python
def quantisation_step_m(extent_m, bits):
    """Position error introduced by quantising a bounding box of this extent."""
    return extent_m / (2 ** bits)

for extent in (120.0, 250.0, 1000.0):
    row = {f"{b} bits": round(quantisation_step_m(extent, b) * 1000, 2)
           for b in (10, 12, 14, 16)}
    print(f"extent {extent:>6.0f} m → step in mm:", row)
```

The crucial property is that quantisation is **relative to the mesh's own bounding box**, not absolute. The same `-vp 14` gives a 7 mm step on a 120 m tile and a 6 cm step on a 1 km tile, so the right bit depth depends on the tile size — which is why a single project-wide value is usually either wasteful or too coarse.

For a 120 m city tile, 14 bits gives about 7 mm, which is below any survey tolerance and is the value to reach for. 12 bits gives 3 cm, visible as facades that no longer meet cleanly. 16 bits gives 2 mm and costs the same as 14 for most meshes because the encoder's entropy coding absorbs the difference.

UVs at 12 bits give a 1/4096 step, which is sub-texel for a 2048² atlas and therefore free. Normals at 8 bits are about 1.4° of angular error, which is invisible on architectural geometry and noticeable on smooth curved surfaces — 10 bits for anything organic.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="gp-quant-t gp-quant-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gp-quant-t">Position quantisation step against tile extent</title>
  <desc id="gp-quant-d">A table of quantisation step size in millimetres for three tile extents and four bit depths. At 120 metres extent, 12 bits gives 29 millimetres, 14 bits gives 7 millimetres and 16 bits gives 2 millimetres. At 250 metres, 14 bits gives 15 millimetres. At 1000 metres, 14 bits gives 61 millimetres, which is too coarse, and 16 bits is needed. The rule is that the step must stay below the survey tolerance for the tile's own extent.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="164" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="20" width="136" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="318" y="20" width="136" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="454" y="20" width="136" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="590" y="20" width="132" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="164" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="52" width="136" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="318" y="52" width="136" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="454" y="52" width="136" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="590" y="52" width="132" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="164" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="88" width="136" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="318" y="88" width="136" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="454" y="88" width="136" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="590" y="88" width="132" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="124" width="164" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="182" y="124" width="136" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="318" y="124" width="136" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="454" y="124" width="136" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="590" y="124" width="132" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="41">tile extent</text><text x="250" y="41">-vp 10</text><text x="386" y="41">-vp 12</text>
    <text x="522" y="41">-vp 14</text><text x="656" y="41">-vp 16</text>
    <text x="100" y="75">120 m (city block)</text>
    <text x="250" y="75">117 mm</text><text x="386" y="75">29 mm</text><text x="522" y="75">7 mm</text><text x="656" y="75">2 mm</text>
    <text x="100" y="111">250 m (district tile)</text>
    <text x="250" y="111">244 mm</text><text x="386" y="111">61 mm</text><text x="522" y="111">15 mm</text><text x="656" y="111">4 mm</text>
    <text x="100" y="147">1000 m (coarse tile)</text>
    <text x="250" y="147">977 mm</text><text x="386" y="147">244 mm</text><text x="522" y="147">61 mm</text><text x="656" y="147">15 mm</text>
  </g>
  <text x="370" y="186" fill="#1f2937" font-size="12.5" text-anchor="middle">green: below a 20 mm survey tolerance · orange: borderline · red: visible</text>
  <text x="370" y="212" fill="#5b6471" font-size="12" text-anchor="middle">the step scales with the tile's bounding box, so one project-wide bit depth is wrong for at least one tile size</text>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">set -vp per level: 14 for leaves, 16 for the coarse tiles that span kilometres</text>
</svg>
<figcaption>Quantisation is relative to the mesh extent, which is why the same flag is right for a block and wrong for a district.</figcaption>
</figure>

### 3. Choose meshopt or Draco

```bash
# meshopt (EXT_meshopt_compression) — gltfpack's native path
npx gltfpack -i "$IN" -o out/meshopt.glb -vp 14 -vt 12 -vn 8 -cc

# Draco is not gltfpack's job; use gltf-transform for that
npx gltf-transform draco "$IN" out/draco.glb \
  --quantize-position 14 --quantize-texcoord 12 --quantize-normal 8
```

```python
def compare_compression(paths):
    rows = [measure(p) for p in paths]
    base_bytes = rows[0]["bytes"]
    for r in rows:
        r["ratio"] = round(base_bytes / r["bytes"], 2)
        r["kb"] = round(r["bytes"] / 1024, 1)
    return rows

for r in compare_compression(["input/block_0412.glb", "out/meshopt.glb", "out/draco.glb"]):
    print(f"{r['file']:<24}{r['kb']:>9} KB  ×{r['ratio']:<6}{r['extensions']}")
```

`-cc` enables meshopt's higher compression level, which is slower to encode and identical to decode. For tile content it is the right default: encoding happens once in the pipeline, decoding happens on every client.

The choice between the two comes down to decode speed against ratio. Draco compresses geometry perhaps 10–25% smaller; meshopt decodes several times faster and its decoder is a fraction of the size. For a tileset where a client loads dozens of tiles per second while the camera moves, decode time appears directly as frame stutter, and meshopt usually wins despite the larger files. For a tileset served over a slow link to a static viewer, Draco's ratio wins.

What you must not do is both. Draco-compressing a meshopt-compressed file produces a larger file than either, and some clients refuse it.

### 4. Set the flags that matter for tiles, and skip the ones that do not

```bash
npx gltfpack \
  -i input/block_0412.glb \
  -o output/content/block_0412.glb \
  -vp 14 -vt 12 -vn 8 \
  -cc \
  -noq \
  -km -ke \
  -tc -tq 8 \
  -mi \
  -v
```

```python
FLAGS = {
    "-vp N": ("position bits", "14 for ≤250 m tiles, 16 for kilometre tiles"),
    "-vt N": ("texcoord bits", "12; sub-texel for a 2048² atlas"),
    "-vn N": ("normal bits", "8 for architecture, 10 for organic surfaces"),
    "-cc":   ("high compression", "always; encode once, decode often"),
    "-km":   ("keep materials", "always for tiles — merging materials breaks styling"),
    "-ke":   ("keep extras", "always — feature ids and metadata live here"),
    "-mi":   ("instance meshes", "keeps EXT_mesh_gpu_instancing rather than flattening"),
    "-tc":   ("KTX2/Basis textures", "when GPU texture memory is the constraint"),
    "-tq N": ("Basis quality", "8 is a reasonable default; 10 for hero content"),
    "-si R": ("simplify to ratio", "NEVER in a tiling pipeline — LOD is decided upstream"),
    "-sa":   ("aggressive simplify", "never; ignores the error bound"),
    "-noq":  ("disable quantisation", "only to isolate a problem; costs 3–4× size"),
}
for flag, (what, when) in FLAGS.items():
    print(f"{flag:<8}{what:<26}{when}")
```

`-km` and `-ke` are the two flags that most often need adding. Without `-km`, `gltfpack` merges materials it considers equivalent, which collapses the distinct materials a `Cesium3DTileStyle` selects on. Without `-ke`, the `extras` that carry feature identifiers are dropped, and picking stops working.

`-si` is the flag to avoid entirely in a tiling pipeline. Level of detail is a tileset-level decision made with knowledge of the geometric errors, as in [generating LOD chains with meshoptimizer](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/generating-lod-chains-with-meshoptimizer/); letting the packer also simplify means the tile's content no longer matches the `geometricError` the tileset declares, and on tiled meshes it opens seams because `gltfpack` has no notion of the tile border.

### 5. Handle textures deliberately

```bash
# Resize first, then compress — gltfpack will not downscale for you
npx gltf-transform resize "$IN" work/resized.glb --width 2048 --height 2048

# WebP: small on the wire, decoded to RGBA on the GPU
npx gltf-transform webp work/resized.glb output/webp.glb --slots "{baseColor,emissive}"

# KTX2/Basis via gltfpack: stays compressed on the GPU
npx gltfpack -i work/resized.glb -o output/ktx2.glb -vp 14 -vt 12 -vn 8 -cc -tc -tq 8
```

```python
def texture_memory_mb(width, height, form="rgba"):
    texels = width * height * 1.3333        # with mipmaps
    per_texel = {"rgba": 4, "etc1s": 0.5, "uastc": 1.0}[form]
    return round(texels * per_texel / 1e6, 1)

for dim in (1024, 2048, 4096):
    print(f"{dim}²: RGBA {texture_memory_mb(dim, dim):>6} MB   "
          f"ETC1S {texture_memory_mb(dim, dim, 'etc1s'):>5} MB   "
          f"UASTC {texture_memory_mb(dim, dim, 'uastc'):>5} MB")
```

Texture memory, not texture bytes, is what limits a textured city, and this is the calculation that makes the case for KTX2. A 2048² base-colour texture is about 22 MB as RGBA on the GPU and 2.7 MB as ETC1S — so a scene holding 60 tiles goes from 1.3 GB, which will fail, to 160 MB, which will not.

`-tc` produces ETC1S by default, which is aggressive and fine for diffuse building textures; `-tu` selects UASTC, which is twice the memory and noticeably better on normal maps and anything with sharp detail. Mixing them per slot — ETC1S for base colour, UASTC for normals — is the setting most projects end up at.

`gltfpack` does not resize textures, so an oversized atlas stays oversized. Resize first.

<figure class="diagram">
<svg viewBox="4 6 732 312" role="img" aria-labelledby="gp-avoid-t gp-avoid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gp-avoid-t">The gltfpack flags to add and the ones to avoid</title>
  <desc id="gp-avoid-d">A table of six flags. Keep materials and keep extras must be added because merging materials breaks styling and dropping extras breaks picking. Instance meshes must be added or instancing is flattened. High compression is always worth it. Simplify must never be used in a tiling pipeline because level of detail is decided upstream. Aggressive simplify ignores the error bound entirely.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="312" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="220" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="238" y="20" width="132" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="370" y="20" width="352" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="54" width="132" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="370" y="54" width="352" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="88" width="132" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="370" y="88" width="352" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="122" width="132" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="370" y="122" width="352" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="156" width="132" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="370" y="156" width="352" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="220" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="190" width="132" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="190" width="352" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="224" width="220" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="224" width="132" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="224" width="352" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="128" y="42">flag</text><text x="304" y="42">add or avoid</text><text x="546" y="42">why</text>
    <text x="128" y="76">-km keep materials</text><text x="304" y="76">add</text><text x="546" y="76">merging materials breaks styling</text>
    <text x="128" y="110">-ke keep extras</text><text x="304" y="110">add</text><text x="546" y="110">dropping extras breaks picking</text>
    <text x="128" y="144">-mi instance meshes</text><text x="304" y="144">add</text><text x="546" y="144">otherwise instancing is flattened</text>
    <text x="128" y="178">-cc high compression</text><text x="304" y="178">add</text><text x="546" y="178">encode once, decode often</text>
    <text x="128" y="212">-si simplify to ratio</text><text x="304" y="212">avoid</text><text x="546" y="212">LOD is decided upstream; opens seams</text>
    <text x="128" y="246">-sa aggressive simplify</text><text x="304" y="246">avoid</text><text x="546" y="246">ignores the error bound</text>
  </g>
  <text x="20" y="278" fill="#1f2937" font-size="12.5">The four to add are one line each; the two to avoid are what turn a pack into a regression.</text>
  <text x="20" y="300" fill="#5b6471" font-size="12">-si has no knowledge of the tile border, so it reintroduces the cracks LockBorder prevented.</text>
</svg>
<figcaption>Four flags to add, two never to use in a tiling pipeline, and the two are the ones that look helpful.</figcaption>
</figure>

### 6. Script the whole thing per level

```python
LEVEL_SETTINGS = {
    0: {"vp": 14, "vt": 12, "vn": 8, "texture_px": 2048, "tq": 8},
    1: {"vp": 14, "vt": 12, "vn": 8, "texture_px": 1024, "tq": 8},
    2: {"vp": 15, "vt": 11, "vn": 8, "texture_px": 512,  "tq": 7},
    3: {"vp": 16, "vt": 10, "vn": 8, "texture_px": 256,  "tq": 6},
}

def pack_level(in_path, out_path, level):
    cfg = LEVEL_SETTINGS[level]
    resized = str(Path(out_path).with_suffix(".resized.glb"))
    subprocess.run(["npx", "gltf-transform", "resize", in_path, resized,
                    "--width", str(cfg["texture_px"]),
                    "--height", str(cfg["texture_px"])],
                   check=True, capture_output=True)
    args = ["npx", "gltfpack", "-i", resized, "-o", out_path,
            "-vp", str(cfg["vp"]), "-vt", str(cfg["vt"]), "-vn", str(cfg["vn"]),
            "-cc", "-km", "-ke", "-mi", "-tc", "-tq", str(cfg["tq"])]
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"gltfpack failed on {in_path}: {proc.stderr[-400:]}")
    Path(resized).unlink(missing_ok=True)
    return {**measure(out_path), "level": level, "settings": cfg}

results = [pack_level(f"work/lod/block_0412_L{lvl}.glb",
                      f"output/content/block_0412_L{lvl}.glb", lvl)
           for lvl in range(4)]
for r in results:
    print(f"L{r['level']}  {r['bytes']/1024:>8.1f} KB  "
          f"{r['vertices']:>8} verts  {r['textures']} tex  "
          f"{r['texture_bytes']/1024:>8.1f} KB tex")
```

Coarser levels get **more** position bits, not fewer, because they cover a larger extent — which is the counter-intuitive consequence of relative quantisation, and the setting most pipelines get backwards. Coarser levels get fewer UV bits and much smaller textures, which is where their savings come from.

Texture dimension falling faster than triangle count is deliberate: at a level adequate to 500 m, a 256² texture is more than the screen can resolve, and the texture would otherwise be 90% of the payload.

<figure class="diagram">
<svg viewBox="26 12 688 236" role="img" aria-labelledby="gp-result-t gp-result-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gp-result-t">Payload of one tile through the settings</title>
  <desc id="gp-result-d">Bar chart of one tile's size at four stages. The raw GLB from the exporter is 9.4 megabytes. Resizing the texture to 2048 pixels brings it to 4.1 megabytes. Adding meshopt compression with 14-bit positions brings it to 1.6 megabytes. Adding KTX2 Basis textures brings it to 0.78 megabytes, an overall twelvefold reduction with no visible change.</desc>
  <rect class="svg-bg" x="26" y="12" width="688" height="236" fill="#ffffff"/>
  <path d="M40 26 V190 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="420" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="72" width="183" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="110" width="71" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="148" width="35" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="470" y="53">exporter GLB, 4096² PNG: 9.40 MB</text>
    <text x="233" y="91">textures resized to 2048²: 4.10 MB</text>
    <text x="121" y="129">+ meshopt, -vp 14 -vt 12 -vn 8: 1.60 MB</text>
    <text x="85" y="167">+ KTX2 Basis (-tc -tq 8): 0.78 MB</text>
  </g>
  <text x="40" y="212" fill="#5b6471" font-size="12">one 120 m leaf tile, 410k triangles — 12× smaller, and 8× less GPU texture memory</text>
  <text x="40" y="230" fill="#5b6471" font-size="12">geometry accounts for 0.41 MB of the final figure; the rest is texture</text>
</svg>
<figcaption>Texture handling does most of the work on a textured tile; geometry compression finishes it.</figcaption>
</figure>

## Expected Output & Verification

```text
extent    120 m → step in mm: {'10 bits': 117.19, '12 bits': 29.3, '14 bits': 7.32, '16 bits': 1.83}
extent    250 m → step in mm: {'10 bits': 244.14, '12 bits': 61.04, '14 bits': 15.26, '16 bits': 3.81}
extent   1000 m → step in mm: {'10 bits': 976.56, '12 bits': 244.14, '14 bits': 61.04, '16 bits': 15.26}
block_0412.glb              9420.3 KB  ×1.0     ['KHR_materials_unlit']
meshopt.glb                 1601.8 KB  ×5.88    ['EXT_meshopt_compression', 'KHR_mesh_quantization']
draco.glb                   1402.4 KB  ×6.72    ['KHR_draco_mesh_compression', 'KHR_mesh_quantization']
L0     798.4 KB     214882 verts  2 tex     384.1 KB tex
L1     412.0 KB      96114 verts  2 tex      98.2 KB tex
L2     148.6 KB      34210 verts  2 tex      26.4 KB tex
L3      61.2 KB      12008 verts  2 tex       7.1 KB tex
```

Draco is 12% smaller than meshopt here, which is the typical margin, and does not change the recommendation for a streaming tileset. The per-level figures are the important output: the chain totals 1.4 MB for four levels, against 9.4 MB for the single unoptimised leaf.

Verify that quantisation did not move the geometry beyond tolerance, by comparing vertex positions before and after:

```python
import numpy as np

def quantisation_error_check(before, after, tol_m=0.02):
    """Compare decoded positions; requires a loader that applies KHR_mesh_quantization."""
    import trimesh
    a = trimesh.load(before, process=False, force="mesh")
    b = trimesh.load(after, process=False, force="mesh")
    if len(a.vertices) != len(b.vertices):
        return {"comparable": False,
                "reason": f"vertex count changed {len(a.vertices)} → {len(b.vertices)}; "
                          f"simplification ran"}
    d = np.linalg.norm(np.asarray(a.vertices) - np.asarray(b.vertices), axis=1)
    return {"comparable": True, "vertices": len(d),
            "mean_mm": round(float(d.mean()) * 1000, 3),
            "p95_mm": round(float(np.percentile(d, 95)) * 1000, 3),
            "max_mm": round(float(d.max()) * 1000, 3),
            "within_tolerance": bool(d.max() <= tol_m)}

print(quantisation_error_check("input/block_0412.glb", "output/content/block_0412_L0.glb"))
```

A changed vertex count is the check's most useful result: it means `-si` was passed, or that `gltfpack` merged or welded vertices, and either way the file is no longer the geometry the tileset's `geometricError` describes.

Then verify the extensions and metadata survived, since `-km`/`-ke` are easy to forget:

```python
def tile_readiness_check(path, expect_features=True, expect_instancing=False):
    doc = json.loads(subprocess.run(
        ["npx", "gltf-transform", "copy", path, "/dev/stdout", "--format", "gltf"],
        capture_output=True, text=True).stdout)
    used = set(doc.get("extensionsUsed", []))
    required = set(doc.get("extensionsRequired", []))
    materials = len(doc.get("materials", []))
    has_extras = any("extras" in n for n in doc.get("nodes", [])) or "extras" in doc
    has_feature_ids = "EXT_mesh_features" in used or any(
        "_FEATURE_ID_0" in (p.get("attributes") or {})
        for m in doc.get("meshes", []) for p in m.get("primitives", []))
    problems = []
    if expect_features and not (has_feature_ids or has_extras):
        problems.append("feature ids and extras both missing — add -ke")
    if expect_instancing and "EXT_mesh_gpu_instancing" not in used:
        problems.append("instancing flattened — add -mi")
    if materials == 1:
        problems.append("all materials merged into one — add -km")
    return {"materials": materials, "used": sorted(used), "required": sorted(required),
            "problems": problems, "ok": not problems}

print(json.dumps(tile_readiness_check("output/content/block_0412_L0.glb"), indent=2))
```

## Performance Notes

- **Encoding is 100–400 ms per tile** with `-cc`, dominated by Basis texture encoding when `-tc` is on. Basis on a 2048² texture is 1–3 seconds, which makes textures the pipeline's cost centre.
- **`-tc` shards perfectly per tile.** It is the stage to parallelise if the tiling run is slow.
- **meshopt decode is roughly 3–5× faster than Draco** on the same geometry, which shows up as smoother camera movement rather than as a number in the network panel.
- **`-cc` costs about 2× encode time for 5–8% size.** Worth it for content served many times.
- **Do not re-pack an already packed file.** Each pass re-quantises, and error accumulates.
- **Run the packer after LOD generation, never before.** Simplifying quantised geometry bakes the quantisation grid into the simplified result.

## Common Errors

**Facades no longer meet; thin gaps at corners.** `-vp` too low for the tile extent. Compute the step from the extent and keep it under your tolerance.

**Styling stopped working after packing.** Materials were merged. Add `-km`.

**Picking returns nothing.** `extras` and feature ids were dropped. Add `-ke`.

**Instanced trees became one tree, or millions of unique meshes.** Instancing was flattened. Add `-mi`.

**Textures look blocky on normal maps.** ETC1S on a normal map. Use `-tu` for UASTC, or keep normal maps as WebP.

**File got bigger.** Double compression — meshopt on top of Draco, or WebP on an already-compressed JPEG.

**Client refuses the file.** `EXT_meshopt_compression` in `extensionsRequired` and the client does not support it. Check the target viewer's version before choosing meshopt.

**Vertex count dropped unexpectedly.** `-si` was in the command, or a welding pass merged coincident vertices across a texture seam. Both change the geometry the tileset describes.

## Frequently Asked Questions

### Can I use gltfpack instead of a separate LOD step?

For a standalone model, yes. For tile content, no: `-si` has no knowledge of the tile border or of the tileset's geometric errors, so it produces seams and content that does not match its declared error.

### Is KHR_mesh_quantization safe to require?

Yes for any current viewer; it has been widely supported for years and is what makes the quantisation flags meaningful. `EXT_meshopt_compression` is the one to check against your client.

### Should every level use the same settings?

No — that is the main finding of this page. Position bits should rise with the tile extent and texture dimension should fall fast with level.

## Related Guides

- [Generating LOD Chains with meshoptimizer](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/generating-lod-chains-with-meshoptimizer/) — the step that must run before packing
- [Inspecting glTF with gltf-transform](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/inspecting-gltf-with-gltf-transform/) — verifying what the packer produced
- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — the other half of tile content cost

Back to [glTF LOD Generation with Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
