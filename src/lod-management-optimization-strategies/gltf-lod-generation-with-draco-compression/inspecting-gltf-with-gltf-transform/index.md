---
title: "Inspecting glTF with gltf-transform"
description: "Read what is actually inside a GLB with gltf-transform: accessor types, texture sizes, draw calls"
---
# Inspecting glTF with gltf-transform

This page reads what is actually inside a GLB — meshes, primitives, accessors, materials, texture dimensions, extensions and unused data — using the `gltf-transform` CLI and its Node API, and turns that reading into a scriptable audit that fails a tiling build when a tile regresses.

## Why you hit this

Tile content is the part of a 3D Tiles pipeline that nobody looks at. The tileset JSON is readable, the viewer either works or does not, and the GLB in between is a binary blob that gets passed from a mesh exporter to a compressor to a CDN without anyone checking what it contains. That is where the surprises live: a 4096×4096 normal map on a building with no visible detail, 40 primitives where 2 would do, a `KHR_materials_pbrSpecularGlossiness` extension no current viewer reads, 30% of the buffer occupied by accessors nothing references.

Every one of those is a bandwidth or frame-rate problem, and all of them are visible in one command.

## Prerequisites

- Node.js 18+ and the CLI: `npm install -g @gltf-transform/cli`.
- For the scripted audit, `npm install @gltf-transform/core @gltf-transform/extensions`.
- A GLB or glTF file — tile content from [converting GLB to 3D Tiles with 3d-tiles-tools](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-glb-to-3d-tiles-with-3d-tiles-tools/), or any exporter output.

## Step-by-Step

### 1. Start with `inspect`

```bash
npx gltf-transform inspect output/content/12021000.glb
```

```text
 SCENES ─────────────────────────────────────
  name        rootName   bboxMin              bboxMax
  Scene       Root       -118.4,-3.2,-96.7    121.9,74.1,102.4

 MESHES ─────────────────────────────────────
  name          primitives   mode        vertices   glPrimitives   indices      attributes
  building_1    1            TRIANGLES   4,182      2,788          uint16       POSITION, NORMAL, TEXCOORD_0
  ...

 TEXTURES ───────────────────────────────────
  name        uri   slots                  instances   mimeType     resolution   size
  atlas_0     —     baseColorTexture       412         image/jpeg   4096x4096    9.42 MB
  atlas_0_n   —     normalTexture          412         image/png    4096x4096   31.80 MB
```

The `inspect` output is the whole first pass. Three numbers in it are usually wrong on a first look at a tile: the texture size, the primitive count and whether indices are `uint16` or `uint32`.

A 31.8 MB PNG normal map is the single most common finding, and it is almost always a mistake — PNG is lossless and normal maps do not need it at tile scale, so converting to WebP typically takes that to under 2 MB. The `slots` and `instances` columns tell you whether a texture is worth optimising at all: a texture used by 412 primitives matters, one used by 1 does not.

<figure class="diagram">
<svg viewBox="4 6 732 248" role="img" aria-labelledby="gti-anatomy-t gti-anatomy-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gti-anatomy-t">What inspect reports, and what each number costs</title>
  <desc id="gti-anatomy-d">A table of inspect sections and the cost each one drives. Meshes and primitives drive draw calls. Vertices and accessors drive buffer size and parse time. Texture resolution and MIME type drive download size and GPU memory. Materials drive shader variants. Extensions drive client compatibility. Unused accessors and textures cost bytes for nothing.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="248" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="230" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="444" y="20" width="278" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="196" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="52" width="230" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="444" y="52" width="278" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="84" width="196" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="84" width="230" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="444" y="84" width="278" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="116" width="196" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="116" width="230" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="444" y="116" width="278" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="148" width="196" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="148" width="230" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="444" y="148" width="278" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="180" width="196" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="180" width="230" height="32" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="444" y="180" width="278" height="32" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="41">inspect section</text><text x="329" y="41">drives</text><text x="583" y="41">what to look for</text>
    <text x="116" y="73">meshes, primitives</text><text x="329" y="73">draw calls</text><text x="583" y="73">more than ~8 primitives per tile</text>
    <text x="116" y="105">vertices, accessors</text><text x="329" y="105">buffer size, parse time</text><text x="583" y="105">uint32 indices under 65k vertices</text>
    <text x="116" y="137">textures</text><text x="329" y="137">download, GPU memory</text><text x="583" y="137">PNG, or 4096² where 1024² serves</text>
    <text x="116" y="169">materials</text><text x="329" y="169">shader variants</text><text x="583" y="169">near-duplicate materials</text>
    <text x="116" y="201">extensions</text><text x="329" y="201">client compatibility</text><text x="583" y="201">anything deprecated or required</text>
  </g>
  <text x="370" y="236" fill="#5b6471" font-size="12" text-anchor="middle">one command produces every row; the rightmost column is the reason to read it</text>
</svg>
<figcaption>Each section of the report maps to a specific cost, which is what makes the output actionable rather than informational.</figcaption>
</figure>

### 2. Find what nothing references

```bash
npx gltf-transform copy input.glb /tmp/pruned.glb --no-prune 2>/dev/null || true

npx gltf-transform prune input.glb output/pruned.glb \
  --keep-attributes false --keep-indices false --keep-solid-textures false
```

```javascript
// audit/unused.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function unusedReport(path) {
  const doc = await io.read(path);
  const root = doc.getRoot();

  const referencedAccessors = new Set();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const name of prim.listSemantics()) referencedAccessors.add(prim.getAttribute(name));
      if (prim.getIndices()) referencedAccessors.add(prim.getIndices());
      for (const target of prim.listTargets()) {
        for (const name of target.listSemantics()) referencedAccessors.add(target.getAttribute(name));
      }
    }
  }

  const allAccessors = root.listAccessors();
  const orphanAccessors = allAccessors.filter((a) => !referencedAccessors.has(a));
  const orphanBytes = orphanAccessors.reduce(
    (sum, a) => sum + a.getCount() * a.getElementSize() * a.getComponentSize(), 0);

  const usedTextures = new Set();
  for (const mat of root.listMaterials()) {
    for (const slot of ['BaseColor', 'Normal', 'Emissive', 'Occlusion', 'MetallicRoughness']) {
      const tex = mat[`get${slot}Texture`]?.();
      if (tex) usedTextures.add(tex);
    }
  }
  const orphanTextures = root.listTextures().filter((t) => !usedTextures.has(t));

  const usedMaterials = new Set();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial()) usedMaterials.add(prim.getMaterial());
    }
  }

  return {
    accessors: { total: allAccessors.length, orphan: orphanAccessors.length,
                 orphanKB: Math.round(orphanBytes / 1024) },
    textures: { total: root.listTextures().length, orphan: orphanTextures.length,
                orphanKB: Math.round(orphanTextures.reduce(
                  (s, t) => s + (t.getImage()?.byteLength ?? 0), 0) / 1024) },
    materials: { total: root.listMaterials().length,
                 orphan: root.listMaterials().length - usedMaterials.size },
    meshes: { total: root.listMeshes().length,
              orphan: root.listMeshes().filter((m) => m.listParents()
                .filter((p) => p.propertyType === 'Node').length === 0).length },
  };
}
```

Orphaned data is the easiest win in a tile pipeline and the most common. Exporters leave behind morph-target accessors nothing uses, tangent attributes for materials with no normal map, and a second UV set from a baking step that was removed. Between 5% and 30% of a tile's buffer is typical, and `prune` removes it in one pass with no visual change.

Walking the document graph rather than trusting a tool's report matters when the pipeline has several stages: a `prune` that ran before a later step added data will report clean while the file is not.

### 3. Count what the GPU will actually do

```javascript
// audit/cost.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function costReport(path) {
  const doc = await io.read(path);
  const root = doc.getRoot();

  let drawCalls = 0;
  let triangles = 0;
  let vertices = 0;
  let instancedDrawCalls = 0;
  const materialsPerPrim = new Set();

  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const instancing = node.getExtension('EXT_mesh_gpu_instancing');
    const instanceCount = instancing
      ? instancing.getAttribute('TRANSLATION')?.getCount() ?? 1
      : 1;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : prim.getAttribute('POSITION').getCount();
      triangles += Math.floor(count / 3) * (instancing ? instanceCount : 1);
      vertices += prim.getAttribute('POSITION').getCount();
      if (instancing) instancedDrawCalls += 1; else drawCalls += 1;
      if (prim.getMaterial()) materialsPerPrim.add(prim.getMaterial());
    }
  }

  const textureBytes = root.listTextures()
    .reduce((s, t) => s + (t.getImage()?.byteLength ?? 0), 0);
  const gpuTextureBytes = root.listTextures().reduce((s, t) => {
    const size = t.getSize();
    return s + (size ? size[0] * size[1] * 4 * 1.33 : 0);   // RGBA + mipmaps
  }, 0);

  return {
    drawCalls, instancedDrawCalls, triangles, vertices,
    materials: materialsPerPrim.size,
    indexWidth: indexWidths(root),
    textureBytesOnWire: Math.round(textureBytes / 1024),
    textureBytesOnGpu: Math.round(gpuTextureBytes / 1024 / 1024),
    extensionsRequired: root.listExtensionsRequired().map((e) => e.extensionName),
    extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
  };
}

function indexWidths(root) {
  const widths = {};
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      if (!idx) { widths.none = (widths.none ?? 0) + 1; continue; }
      const bits = idx.getComponentSize() * 8;
      const maxVertex = prim.getAttribute('POSITION').getCount();
      const key = maxVertex < 65536 && bits === 32 ? 'uint32_wasteful' : `uint${bits}`;
      widths[key] = (widths[key] ?? 0) + 1;
    }
  }
  return widths;
}
```

`textureBytesOnGpu` is the number that explains a viewer running out of memory while the network panel looks fine. A 4096×4096 texture compresses to 2 MB on the wire and occupies about 87 MB on the GPU once decoded to RGBA with mipmaps — so a scene holding 40 such tiles has a memory problem that no amount of compression addresses. Only a smaller texture, or a GPU-compressed format like KTX2/Basis, changes it.

`uint32_wasteful` catches a real and invisible cost: indices stored as 32-bit for a primitive with fewer than 65,536 vertices, doubling the index buffer for nothing. Exporters do this routinely.

### 4. Check the extensions against what your client supports

```javascript
// audit/extensions.mjs
const SUPPORTED = new Set([
  'KHR_draco_mesh_compression',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_materials_unlit',
  'KHR_texture_transform',
  'EXT_mesh_gpu_instancing',
  'EXT_meshopt_compression',
  'EXT_structural_metadata',
  'EXT_mesh_features',
]);

const DEPRECATED = new Set([
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_technique_webgl',
  'CESIUM_RTC',
]);

export function extensionVerdict(report) {
  const required = report.extensionsRequired ?? [];
  const used = report.extensionsUsed ?? [];
  const blocking = required.filter((e) => !SUPPORTED.has(e));
  const deprecated = used.filter((e) => DEPRECATED.has(e));
  const unknown = used.filter((e) => !SUPPORTED.has(e) && !DEPRECATED.has(e));
  return {
    blocking, deprecated, unknown,
    ok: blocking.length === 0 && deprecated.length === 0,
  };
}
```

The distinction between `extensionsUsed` and `extensionsRequired` decides how a client fails. An extension in `used` but not `required` is optional — the client can ignore it and render something reasonable. One in `required` that the client does not support means the whole file is refused, which is the correct behaviour and looks like a broken tile.

`KHR_materials_pbrSpecularGlossiness` is worth calling out because it is the one exporters still emit and current viewers no longer read; `gltf-transform metal-rough` converts it.

### 5. Wire it into a build gate

```javascript
// audit/gate.mjs
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { costReport } from './cost.mjs';
import { unusedReport } from './unused.mjs';
import { extensionVerdict } from './extensions.mjs';

const BUDGET = {
  maxDrawCallsPerTile: 8,
  maxTrianglesPerTile: 600_000,
  maxTextureBytesOnWireKB: 3_072,
  maxTextureBytesOnGpuMB: 96,
  maxOrphanKB: 64,
  maxTextureDimension: 2048,
};

export async function gate(contentDir) {
  const files = (await readdir(contentDir)).filter((f) => f.endsWith('.glb'));
  const findings = [];
  for (const file of files) {
    const path = join(contentDir, file);
    const cost = await costReport(path);
    const unused = await unusedReport(path);
    const ext = extensionVerdict(cost);

    if (cost.drawCalls > BUDGET.maxDrawCallsPerTile)
      findings.push({ file, issue: `${cost.drawCalls} draw calls`, severity: 'warn' });
    if (cost.triangles > BUDGET.maxTrianglesPerTile)
      findings.push({ file, issue: `${cost.triangles} triangles`, severity: 'warn' });
    if (cost.textureBytesOnWire > BUDGET.maxTextureBytesOnWireKB)
      findings.push({ file, issue: `${cost.textureBytesOnWire} KB textures on wire`,
                      severity: 'error' });
    if (cost.textureBytesOnGpu > BUDGET.maxTextureBytesOnGpuMB)
      findings.push({ file, issue: `${cost.textureBytesOnGpu} MB textures on GPU`,
                      severity: 'error' });
    if (unused.accessors.orphanKB > BUDGET.maxOrphanKB)
      findings.push({ file, issue: `${unused.accessors.orphanKB} KB orphaned accessors`,
                      severity: 'warn' });
    if (cost.indexWidth.uint32_wasteful)
      findings.push({ file, issue: `${cost.indexWidth.uint32_wasteful} primitive(s) with `
                     + `needless uint32 indices`, severity: 'warn' });
    for (const e of ext.blocking)
      findings.push({ file, issue: `required extension not supported: ${e}`,
                      severity: 'error' });
    for (const e of ext.deprecated)
      findings.push({ file, issue: `deprecated extension: ${e}`, severity: 'error' });
  }
  const errors = findings.filter((f) => f.severity === 'error');
  return { files: files.length, findings, errors: errors.length,
           pass: errors.length === 0 };
}

const result = await gate(process.argv[2] ?? 'output/content');
console.log(JSON.stringify({ files: result.files, errors: result.errors,
                             sample: result.findings.slice(0, 6) }, null, 2));
if (!result.pass) process.exit(1);
```

Distinguishing `warn` from `error` is what makes a gate survive contact with a real pipeline. Draw calls and orphaned bytes are worth reporting and not worth blocking a release over; a required extension nobody supports and a texture that will exhaust GPU memory are.

Running this over the whole content directory takes about 15 ms per file, so a 6,000-tile city is under two minutes — cheap enough for every build.

<figure class="diagram">
<svg viewBox="4 6 732 312" role="img" aria-labelledby="gti-budget-t gti-budget-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gti-budget-t">A per-tile budget worth gating on</title>
  <desc id="gti-budget-d">A table of six budget limits for tile content with the reason for each. Draw calls at eight per tile keeps state changes affordable. Triangles at 600 thousand keeps parse time bounded. Textures on the wire at 3 megabytes keeps the download reasonable. Textures on the GPU at 96 megabytes is the figure that actually exhausts memory. Orphaned accessors at 64 kilobytes catches exporter leftovers. Texture dimension at 2048 keeps the GPU figure achievable.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="312" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="252" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="20" width="110" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="380" y="20" width="342" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="54" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="54" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="88" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="88" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="252" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="270" y="122" width="110" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="380" y="122" width="342" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="252" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="270" y="156" width="110" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="380" y="156" width="342" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="190" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="190" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="190" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="224" width="252" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="270" y="224" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="380" y="224" width="342" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="144" y="42">metric</text><text x="325" y="42">limit</text><text x="551" y="42">why this number</text>
    <text x="144" y="76">draw calls per tile</text><text x="325" y="76">8</text><text x="551" y="76">state changes dominate above this</text>
    <text x="144" y="110">triangles per tile</text><text x="325" y="110">600 k</text><text x="551" y="110">parse time becomes visible</text>
    <text x="144" y="144">texture bytes on the wire</text><text x="325" y="144">3 MB</text><text x="551" y="144">download on the critical path</text>
    <text x="144" y="178">texture bytes on the GPU</text><text x="325" y="178">96 MB</text><text x="551" y="178">this is what exhausts memory</text>
    <text x="144" y="212">orphaned accessors</text><text x="325" y="212">64 KB</text><text x="551" y="212">exporter leftovers, free to remove</text>
    <text x="144" y="246">max texture dimension</text><text x="325" y="246">2048</text><text x="551" y="246">keeps the GPU figure achievable</text>
  </g>
  <text x="20" y="278" fill="#1f2937" font-size="12.5">The GPU figure is width times height times four times 1.33, independent of the compressed size.</text>
  <text x="20" y="300" fill="#5b6471" font-size="12">Gate on the two texture rows as errors; the rest are worth reporting and not blocking.</text>
</svg>
<figcaption>Six numbers, and the GPU texture figure is the one that has no relation to what the network panel shows.</figcaption>
</figure>

### 6. Fix what the audit found

```bash
npx gltf-transform optimize input.glb output.glb \
  --texture-compress webp --texture-size 2048 \
  --compress meshopt --simplify false

npx gltf-transform prune input.glb step1.glb
npx gltf-transform dedup step1.glb step2.glb
npx gltf-transform join step2.glb step3.glb --keepMeshes false --keepNamed false
npx gltf-transform metal-rough step3.glb step4.glb
npx gltf-transform resize step4.glb step5.glb --width 2048 --height 2048
npx gltf-transform webp step5.glb output.glb --slots "{baseColor,normal,emissive}"
```

`optimize` runs a reasonable default chain and is the right first move; the explicit sequence is what you reach for when a specific finding needs addressing without changing anything else. `--simplify false` matters whenever the geometry's level of detail was already decided upstream, as it is in a tiling pipeline — letting `optimize` simplify again undoes deliberate decisions and, on tiled meshes, opens seams.

`join` is the fix for a high draw-call count: it merges primitives that share a material into one. `dedup` removes duplicate accessors, textures and materials, which is where most of the savings on an exporter's output come from.

<figure class="diagram">
<svg viewBox="6 10 728 226" role="img" aria-labelledby="gti-fix-t gti-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gti-fix-t">Findings and the command that fixes each</title>
  <desc id="gti-fix-d">A mapping from audit finding to remedy. Orphaned accessors are removed by prune. Duplicate materials and textures by dedup. Too many draw calls by join. A deprecated specular-glossiness extension by metal-rough. Oversized textures by resize. PNG textures by webp or ktx2. Needless 32-bit indices by the reorder or optimize command.</desc>
  <rect class="svg-bg" x="6" y="10" width="728" height="226" fill="#ffffff"/>
  <defs>
    <marker id="gti-fix-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.5">
    <rect x="20" y="24" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="58" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="92" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="126" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="160" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="194" width="300" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="440" y="24" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="58" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="92" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="126" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="160" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="194" width="280" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.6" fill="none" marker-end="url(#gti-fix-arrow)">
    <path d="M320 38 H438"/><path d="M320 72 H438"/><path d="M320 106 H438"/>
    <path d="M320 140 H438"/><path d="M320 174 H438"/><path d="M320 208 H438"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="43">orphaned accessors, 240 KB</text><text x="580" y="43">gltf-transform prune</text>
    <text x="170" y="77">duplicate materials ×6</text><text x="580" y="77">gltf-transform dedup</text>
    <text x="170" y="111">41 draw calls in one tile</text><text x="580" y="111">gltf-transform join</text>
    <text x="170" y="145">pbrSpecularGlossiness</text><text x="580" y="145">gltf-transform metal-rough</text>
    <text x="170" y="179">4096² PNG normal map</text><text x="580" y="179">resize + webp (or ktx2)</text>
    <text x="170" y="213">uint32 indices, 4k vertices</text><text x="580" y="213">gltf-transform optimize</text>
  </g>
</svg>
<figcaption>Every finding the audit produces has one command that fixes it; none of them requires re-exporting the mesh.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "files": 412,
  "errors": 9,
  "sample": [
    {"file": "12021000.glb", "issue": "31840 KB textures on wire", "severity": "error"},
    {"file": "12021000.glb", "issue": "174 MB textures on GPU", "severity": "error"},
    {"file": "12021000.glb", "issue": "41 draw calls", "severity": "warn"},
    {"file": "12021001.glb", "issue": "248 KB orphaned accessors", "severity": "warn"},
    {"file": "12021004.glb", "issue": "deprecated extension: KHR_materials_pbrSpecularGlossiness", "severity": "error"},
    {"file": "12021009.glb", "issue": "6 primitive(s) with needless uint32 indices", "severity": "warn"}
  ]
}
```

Nine errors across 412 tiles, concentrated in a handful of files — which is the usual shape, because the cause is one exporter setting applied to a subset of the input. The two errors on `12021000.glb` are the same root cause seen twice: an oversized PNG normal map, expensive on the wire and far more expensive on the GPU.

Verify that fixing the findings did not change the geometry, which is the risk with any optimisation chain:

```javascript
// audit/equivalence.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function geometryEquivalence(before, after, tolM = 0.001) {
  const [a, b] = await Promise.all([io.read(before), io.read(after)]);
  const bounds = (doc) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let tris = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const min = pos.getMinNormalized([0, 0, 0]);
        const max = pos.getMaxNormalized([0, 0, 0]);
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], min[i]);
          hi[i] = Math.max(hi[i], max[i]);
        }
        const idx = prim.getIndices();
        tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
      }
    }
    return { lo, hi, tris };
  };
  const ba = bounds(a);
  const bb = bounds(b);
  const deltas = [...ba.lo.map((v, i) => Math.abs(v - bb.lo[i])),
                  ...ba.hi.map((v, i) => Math.abs(v - bb.hi[i]))];
  return {
    trianglesBefore: ba.tris, trianglesAfter: bb.tris,
    trianglesEqual: ba.tris === bb.tris,
    maxBoundsDeltaM: Math.max(...deltas),
    boundsEqual: Math.max(...deltas) <= tolM,
  };
}
```

Triangle count and bounding box are a weak check that catches strong failures: a `simplify` that ran by accident changes the triangle count, and a quantisation with the wrong range moves the bounds. Both are easy to do accidentally with `optimize` and both are invisible in a viewer at normal zoom.

Then verify the file still validates and loads:

```bash
npx gltf-validator output/content/12021000.glb 2>&1 | head -20

npx gltf-transform inspect output/content/12021000.glb | grep -A4 "TEXTURES"
```

A validator run after the optimisation chain is worth the seconds. `join` and `dedup` rewrite accessor indices, and a bug in a plugin or an unusual input occasionally produces a file that is structurally invalid while still opening in a tolerant viewer.

## Performance Notes

- **Reading a 4 MB GLB with the Node API is about 15 ms**, so auditing thousands of tiles is minutes, not hours. Reuse one `NodeIO` instance.
- **`inspect` on the CLI spawns a process per file.** For bulk work use the API; for one file the CLI is fine.
- **GPU texture cost is width × height × 4 × 1.33**, independent of the compressed size on the wire. This is the number to budget against, not the download.
- **KTX2/Basis keeps textures compressed on the GPU**, cutting that figure by 4–6×. It is the real fix for a texture memory problem.
- **`join` reduces draw calls and increases the smallest unit that can be culled.** For tile content that is the right trade; for a scene with distinct moving parts it is not.
- **Run the gate on changed tiles only** in an incremental build, using the manifest from [resuming failed tiling runs from checkpoints](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/resuming-failed-tiling-runs-from-checkpoints/).

## Common Errors

**`Error: Missing extension: KHR_draco_mesh_compression`.** The extensions were not registered on the `NodeIO`. `registerExtensions(ALL_EXTENSIONS)` is required to read compressed files.

**`inspect` reports 0 textures on a file that clearly has them.** The glTF references external image files that are not next to it. GLB is self-contained; `.gltf` is not.

**Triangle count changes after `optimize`.** `simplify` ran. Pass `--simplify false` in a tiling pipeline.

**`join` produced one enormous primitive and the frame rate got worse.** Culling granularity collapsed. Join within a material and within a spatial group, not across the whole tile.

**The optimised file is larger.** WebP on a texture that was already a well-compressed JPEG, or meshopt on top of Draco. Compress once, and compare.

**Validator errors about accessor bounds after quantisation.** `KHR_mesh_quantization` requires `min`/`max` on quantised accessors to be in the quantised space. Let `gltf-transform` do the quantisation rather than writing it by hand.

## Frequently Asked Questions

### Draco or meshopt?

Meshopt decodes faster and compresses slightly less; Draco compresses more and decodes slower. For tile content where the client is loading dozens of tiles per second, meshopt's decode speed usually wins. Measure on your own content — the ratio depends heavily on mesh regularity.

### Should tile content use KTX2 textures?

Yes where GPU memory is the constraint, which it is for any textured city. The cost is a longer encode step in the pipeline and a client that must support `KHR_texture_basisu`.

### Can this audit replace the 3D Tiles validator?

No — they check different things. The validator checks the tileset structure and the glTF's conformance; this audit checks the cost and the content decisions. Run both.

## Related Guides

- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — the fix for the draw-call finding
- [gltfpack Settings for 3D Tiles Content](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/gltfpack-settings-for-3d-tiles-content/) — the other compression path
- [Converting GLB to 3D Tiles with 3d-tiles-tools](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-glb-to-3d-tiles-with-3d-tiles-tools/) — where this content comes from

Back to [glTF LOD Generation with Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
