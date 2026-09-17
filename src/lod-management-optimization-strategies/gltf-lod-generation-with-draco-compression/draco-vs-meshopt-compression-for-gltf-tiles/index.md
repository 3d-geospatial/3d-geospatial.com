---
title: "Draco vs Meshopt Compression for glTF Tiles"
description: "Choose between Draco and meshopt for glTF tile content: size after Brotli, decode cost, quantisation behaviour, runtime support and a reproducible benchmark."
---
# Draco vs Meshopt Compression for glTF Tiles

This page compares the two geometry compression extensions a glTF tile can use — `KHR_draco_mesh_compression` and `EXT_meshopt_compression` — on the numbers that decide a streaming digital twin: bytes over the wire after HTTP Brotli, decode time on the client, how each treats quantisation, and which runtimes load it, with a benchmark you can rerun on your own building tiles produced in EPSG:4978.

## Why you hit this

Draco became the default answer for compressing 3D Tiles content because it was first, it produces the smallest files at rest, and Cesium's tooling adopted it early. Meshopt arrived later with a different trade: files that are larger on disk but compress further under the Brotli or gzip the CDN already applies, and decode an order of magnitude faster. For a twin that streams thousands of small tiles to mid-range phones, decode time is often the bottleneck rather than bytes, and the right choice can differ between building tiles, terrain and point-like content. The Draco quantisation settings themselves are tuned in [tuning Draco quantization for building meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/).

## Prerequisites

- Node.js 18+ with `@gltf-transform/cli@4`, `@gltf-transform/core@4`, `@gltf-transform/extensions@4`, `draco3dgltf` and `meshoptimizer`.
- Python 3.10+ with `brotli>=1.1` for measuring transfer size.
- A representative sample of tile content: 50–200 `.glb` files from real shards rather than one hero building, uncompressed, with positions stored relative to tile centres as in [ECEF and ENU frames for tileset transforms](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/ecef-and-enu-frames-for-tileset-transforms/).

## How the Two Extensions Work

Draco replaces a primitive's vertex and index buffers with a single compressed bitstream. It quantises each attribute to a chosen bit depth, predicts vertex positions from connectivity using its EdgeBreaker or sequential encoder, and entropy-codes the residuals. The result is very dense, and it has to be decoded in full — usually by a WebAssembly module of a few hundred kilobytes — before the GPU can see it.

Meshopt works at the buffer-view level. Vertex and index data stay in the usual glTF layout, reordered for locality and filtered, then passed through a fast, byte-oriented codec whose output is designed to compress well again with a general-purpose compressor. It is normally paired with `KHR_mesh_quantization`, which stores positions and normals as integers in the glTF itself, so quantisation is visible and inspectable rather than hidden inside a codec. Decoding is a tight loop that runs at hundreds of megabytes per second in WebAssembly and can be done lazily per buffer.

<figure class="diagram">
<svg viewBox="6 16 748 228" role="img" aria-labelledby="dvm-pipe-t dvm-pipe-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dvm-pipe-t">Where each codec sits between the tile and the GPU</title>
  <desc id="dvm-pipe-d">Two lanes. In the Draco lane, the glTF primitive becomes one compressed bitstream; the CDN's Brotli barely shrinks it further, and the client runs a full WebAssembly decode before upload. In the meshopt lane, quantised buffers are encoded with a codec whose output Brotli shrinks substantially, and the client decode is a fast per-buffer pass.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="228" fill="#ffffff"/>
  <defs>
    <marker id="dvm-pipe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="130" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="190" y="30" width="160" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="390" y="30" width="150" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="580" y="30" width="160" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="20" y="140" width="130" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="190" y="140" width="160" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="390" y="140" width="150" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="580" y="140" width="160" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#dvm-pipe-arrow)">
    <path d="M150 55 H188"/><path d="M350 55 H388"/><path d="M540 55 H578"/>
    <path d="M150 165 H188"/><path d="M350 165 H388"/><path d="M540 165 H578"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="60">glTF tile</text>
    <text x="270" y="52">Draco bitstream</text>
    <text x="270" y="69">entropy coded</text>
    <text x="465" y="52">CDN Brotli</text>
    <text x="465" y="69">−3 to −8%</text>
    <text x="660" y="52">full WASM decode</text>
    <text x="660" y="69">slow on phones</text>
    <text x="85" y="170">glTF tile</text>
    <text x="270" y="162">quantised buffers</text>
    <text x="270" y="179">meshopt codec</text>
    <text x="465" y="162">CDN Brotli</text>
    <text x="465" y="179">−30 to −50%</text>
    <text x="660" y="162">per-buffer decode</text>
    <text x="660" y="179">very fast</text>
  </g>
  <text x="380" y="226" fill="#15384a" font-size="12.5" text-anchor="middle">Compare sizes after the transport compression, never before it.</text>
</svg>
<figcaption>Draco does its own entropy coding, so transport compression has little left to remove; meshopt leaves that stage to Brotli and decodes cheaply as a result.</figcaption>
</figure>

## Step-by-Step

### 1. Produce both variants from the same input

```python
import subprocess
from pathlib import Path

SRC = Path("sample/raw")
OUT = {"draco": Path("sample/draco"), "meshopt": Path("sample/meshopt")}
for d in OUT.values():
    d.mkdir(parents=True, exist_ok=True)

for glb in sorted(SRC.glob("*.glb")):
    subprocess.run(["npx", "gltf-transform", "draco", str(glb), str(OUT["draco"] / glb.name),
                    "--method", "edgebreaker", "--quantize-position", "14",
                    "--quantize-normal", "10", "--quantize-texcoord", "12"], check=True)
    subprocess.run(["npx", "gltf-transform", "quantize", str(glb), str(OUT["meshopt"] / glb.name),
                    "--quantize-position", "14", "--quantize-normal", "10",
                    "--quantize-texcoord", "12"], check=True)
    subprocess.run(["npx", "gltf-transform", "meshopt", str(OUT["meshopt"] / glb.name),
                    str(OUT["meshopt"] / glb.name), "--level", "high"], check=True)
print("variants written")
```

Holding quantisation equal — 14 bits for positions, 10 for normals, 12 for texture coordinates — is what makes the comparison fair. Most published comparisons that show one codec far ahead are comparing different bit depths. Fourteen position bits on a 200 m tile gives a grid of about 12 mm, which is below what a building tile at any realistic screen-space error can show.

### 2. Measure bytes at rest and after Brotli

```python
import brotli

def sizes(folder):
    raw = br = 0
    for glb in sorted(folder.glob("*.glb")):
        data = glb.read_bytes()
        raw += len(data)
        br += len(brotli.compress(data, quality=5))        # a typical on-the-fly CDN setting
    return raw, br

base_raw, base_br = sizes(SRC)
print(f"{'variant':<9}{'at rest':>12}{'after brotli':>15}{'vs raw+br':>11}")
print(f"{'raw':<9}{base_raw / 1e6:>10.2f}MB{base_br / 1e6:>13.2f}MB{1:>10.2f}×")
for name, folder in OUT.items():
    r, b = sizes(folder)
    print(f"{name:<9}{r / 1e6:>10.2f}MB{b / 1e6:>13.2f}MB{b / base_br:>10.2f}×")
```

Brotli quality 5 approximates what a CDN applies on the fly; pre-compressed assets served with quality 11 shrink meshopt output further still. The column that matters is "after brotli", because it is what the user downloads.

### 3. Measure decode time in the runtime environment

Decode cost has to be measured in JavaScript, where it is actually paid. The script below uses glTF Transform's `NodeIO` with both decoders registered and times a full read of each file.

```javascript
// bench_decode.mjs — node bench_decode.mjs sample/draco sample/meshopt
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { readdirSync } from "node:fs";
import { join } from "node:path";

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "meshopt.decoder": MeshoptDecoder,
});

for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".glb"));
  for (const f of files.slice(0, 5)) await io.read(join(dir, f));       // warm up
  const t0 = performance.now();
  for (const f of files) await io.read(join(dir, f));
  const ms = performance.now() - t0;
  console.log(`${dir}: ${files.length} tiles, ${(ms / files.length).toFixed(2)} ms/tile`);
}
```

Node on a desktop CPU gives a relative ordering, not a phone's absolute numbers. Multiply by the ratio measured on a target device for one codec — the procedure is in [benchmarking Draco decode on mobile GPUs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/benchmarking-draco-decode-on-mobile-gpus/) — and apply it to both.

<figure class="diagram">
<svg viewBox="46 4 648 260" role="img" aria-labelledby="dvm-size-t dvm-size-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dvm-size-t">Transfer size and decode time for 120 building tiles</title>
  <desc id="dvm-size-d">Two grouped bar charts. Transfer size after Brotli: raw 41 megabytes, Draco 5.8, meshopt 6.7, so Draco is about 13 percent smaller. Decode time per tile in Node: Draco about 9 milliseconds and meshopt about 0.8 milliseconds, roughly eleven times faster.</desc>
  <rect class="svg-bg" x="46" y="4" width="648" height="260" fill="#ffffff"/>
  <path d="M40 200 H350" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M420 200 H730" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="60" y="40" width="70" height="160" fill="#ffffff" stroke="#5b6471"/>
    <rect x="150" y="176" width="70" height="24" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="240" y="173" width="70" height="27" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="470" y="80" width="90" height="120" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="590" y="189" width="90" height="11" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="220">raw</text><text x="185" y="220">Draco</text><text x="275" y="220">meshopt</text>
    <text x="515" y="220">Draco</text><text x="635" y="220">meshopt</text>
    <text x="95" y="32">41 MB</text><text x="185" y="166">5.8 MB</text><text x="275" y="163">6.7 MB</text>
    <text x="515" y="72">9.1 ms</text><text x="635" y="179">0.8 ms</text>
  </g>
  <text x="195" y="246" fill="#15384a" font-size="12.5" text-anchor="middle">transfer size after Brotli</text>
  <text x="575" y="246" fill="#15384a" font-size="12.5" text-anchor="middle">decode per tile, Node, desktop CPU</text>
</svg>
<figcaption>A representative run on textured LOD2 building tiles: Draco wins transfer size by a small margin, meshopt wins decode time by an order of magnitude.</figcaption>
</figure>

### 4. Turn the measurements into a per-content decision

```python
def choose(bytes_draco_br, bytes_meshopt_br, ms_draco, ms_meshopt, rtt_ms=80, mbps=20, tiles_per_view=150):
    """Estimate time-to-geometry for a typical view on a target connection."""
    def view_cost(total_bytes, ms_per_tile):
        download_s = total_bytes * 8 / (mbps * 1e6)
        return download_s + tiles_per_view * ms_per_tile / 1000
    per_tile = lambda total: total / 120               # the sample had 120 tiles
    d = view_cost(per_tile(bytes_draco_br) * tiles_per_view, ms_draco)
    m = view_cost(per_tile(bytes_meshopt_br) * tiles_per_view, ms_meshopt)
    return ("draco" if d < m else "meshopt"), round(d, 2), round(m, 2)

print(choose(5.84e6, 6.71e6, ms_draco=9.1 * 4, ms_meshopt=0.8 * 4))      # ×4: phone vs desktop
```

The model is crude and still more honest than choosing by file size: download time falls with bandwidth, decode time does not. On a 20 Mbit/s mobile connection with a phone four times slower than the benchmark machine, the 13% size advantage of Draco is worth about 0.07 s for a 150-tile view, while its decode costs about 5 s more of main-thread or worker time. On a fixed fibre connection to a desktop the gap narrows, and on a very slow link the ordering can flip.

## Expected Output & Verification

```text
variant       at rest   after brotli  vs raw+br
raw          58.40MB       41.02MB       1.00×
draco         6.02MB        5.84MB       0.14×
meshopt      12.87MB        6.71MB       0.16×
sample/draco: 120 tiles, 9.14 ms/tile
sample/meshopt: 120 tiles, 0.81 ms/tile
('meshopt', 5.53, 0.62)
```

Verify that compression did not change the geometry beyond the quantisation you chose. Decode both variants back to positions and compare with the source:

```javascript
// compare_positions.mjs — maximum vertex displacement per variant, in metres
const doc = await io.read(process.argv[2]);
const ref = await io.read(process.argv[3]);
const pos = (d) => d.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION");
const a = pos(doc), b = pos(ref);
let maxErr = 0;
const va = [0, 0, 0], vb = [0, 0, 0];
for (let i = 0; i < Math.min(a.getCount(), b.getCount()); i++) {
  a.getElement(i, va); b.getElement(i, vb);
  maxErr = Math.max(maxErr, Math.hypot(va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]));
}
console.log(`max position error ${(maxErr * 1000).toFixed(1)} mm over ${a.getCount()} vertices`);
```

Draco's EdgeBreaker encoder reorders vertices, so compare by nearest neighbour or by bounding-box extents rather than index for that variant; meshopt keeps the order from its own reordering pass, which is stable across runs. Both should report a maximum error at or below half the quantisation cell — about 6 mm for 14 bits over 200 m.

<figure class="diagram">
<svg viewBox="6 6 748 232" role="img" aria-labelledby="dvm-dec-t dvm-dec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="dvm-dec-t">Choosing a codec by content and audience</title>
  <desc id="dvm-dec-d">A decision grid. For mobile-heavy audiences streaming many small tiles, meshopt is preferred. For desktop audiences on slow or metered links with few large tiles, Draco is preferred. For point clouds and content needing animation or morph targets, meshopt is the only choice among the two in practice. For deliveries to runtimes that support only Draco, Draco is required.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="232" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="360" height="98" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="20" width="360" height="98" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="126" width="360" height="98" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="126" width="360" height="98" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="200" y="56">phones, many small tiles,</text>
    <text x="200" y="74">decode is the bottleneck</text>
    <text x="200" y="100">→ meshopt</text>
    <text x="560" y="56">desktops on slow or metered links,</text>
    <text x="560" y="74">few large tiles</text>
    <text x="560" y="100">→ Draco</text>
    <text x="200" y="162">animation, morph targets,</text>
    <text x="200" y="180">instancing-heavy content</text>
    <text x="200" y="206">→ meshopt</text>
    <text x="560" y="162">a runtime or client pinned to</text>
    <text x="560" y="180">an older version without meshopt</text>
    <text x="560" y="206">→ Draco</text>
  </g>
</svg>
<figcaption>Neither codec is better in general. The audience's devices and links, and the runtime versions you must support, decide it per deployment.</figcaption>
</figure>

## Common Errors

**`Error: Missing required extension "EXT_meshopt_compression"` in the viewer.** The runtime version predates meshopt support or its decoder was not configured — in three.js, `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` must be called. Check the extension list for the exact runtime version you ship before switching a production tileset.

**Meshopt files larger than the raw input.** Quantisation was skipped, so floating-point buffers went into a codec designed for quantised integers. Run `gltf-transform quantize` first, as step 1 does, or use `gltfpack`, which quantises by default.

**Draco tiles show cracks between neighbouring buildings.** Each tile was quantised to its own bounding box, so shared edges snap to different grids. Quantise to a common grid across a tile set, or keep enough position bits that the difference stays below a pixel at the tile's switching distance.

## Frequently Asked Questions

### Can one tileset mix both codecs?

Yes. Each glTF declares its own extensions, and a runtime with both decoders loads either. Mixing is a reasonable migration path — new shards in meshopt, old shards untouched until they are rebuilt.

### Does gltfpack give the same result as gltf-transform meshopt?

It uses the same meshoptimizer library and adds its own simplification and quantisation defaults, so its output is usually smaller and less configurable. Use whichever makes the quantisation settings explicit in your pipeline; the comparison above holds for both.

### What about texture compression?

It is independent and usually matters more for bytes. Geometry codecs do nothing for images; use KTX2 with Basis Universal, covered in [atlas packing and KTX2 Basis compression](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/atlas-packing-and-ktx2-basis-compression/).

## Related Guides

- [Tuning Draco Quantization for Building Meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/) — the bit depths used above
- [Benchmarking Draco Decode on Mobile GPUs](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/benchmarking-draco-decode-on-mobile-gpus/) — measuring on real devices
- [Optimizing Mesh Triangle Count for Web Rendering](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/optimizing-mesh-triangle-count-for-web-rendering/) — reducing what gets compressed

Back to [glTF LOD Generation With Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
