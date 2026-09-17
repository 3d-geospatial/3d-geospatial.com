---
title: "Merging Meshes to Cut Draw Calls"
description: "Cut a tile from 400 draw calls to 4 by merging primitives per material — atlas the textures, keep feature ids for picking"
---
# Merging Meshes to Cut Draw Calls

This page merges the 400 per-building primitives in a city tile down to four draw calls — grouping by material, atlasing the textures that block the merge, preserving per-feature identifiers so picking and styling still work, and stopping short of the merge that would destroy frustum culling.

## Why you hit this

A CityGML conversion produces one mesh per building. A BIM export produces one per element, sometimes one per bolt. Both are structurally correct and both are unrenderable at city scale: each primitive is a separate draw call, and a browser issuing 400 draw calls per tile across 30 visible tiles spends its entire frame budget on state changes rather than on drawing.

The fix is mechanical and the constraints are the interesting part: primitives can only merge when they share a material, merging destroys the object boundaries that picking depends on unless identifiers are preserved, and merging too aggressively makes the tile a single indivisible unit that cannot be culled.

## Prerequisites

- Node.js 18+ with `@gltf-transform/core`, `@gltf-transform/functions` and `@gltf-transform/extensions`.
- Tile content with many primitives — the output of a CityGML or IFC conversion.
- For the atlas step, `sharp` or `jimp`; `xatlas` if UVs must be regenerated.

## Step-by-Step

### 1. Measure where the draw calls are

```javascript
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function drawCallReport(path) {
  const doc = await io.read(path);
  const root = doc.getRoot();

  const byMaterial = new Map();
  let primitives = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives += 1;
      const mat = prim.getMaterial();
      const key = mat ? mat.getName() || `material_${root.listMaterials().indexOf(mat)}`
                      : '(no material)';
      const entry = byMaterial.get(key) ?? { primitives: 0, triangles: 0, vertices: 0 };
      const idx = prim.getIndices();
      entry.primitives += 1;
      entry.triangles += Math.floor((idx ? idx.getCount()
                                         : prim.getAttribute('POSITION').getCount()) / 3);
      entry.vertices += prim.getAttribute('POSITION').getCount();
      byMaterial.set(key, entry);
    }
  }

  const groups = [...byMaterial.entries()]
    .map(([material, v]) => ({ material, ...v }))
    .sort((a, b) => b.primitives - a.primitives);

  return {
    primitives,
    materials: byMaterial.size,
    drawCallsNow: primitives,
    drawCallsIfMergedPerMaterial: byMaterial.size,
    reduction: Number((primitives / Math.max(byMaterial.size, 1)).toFixed(1)),
    groups: groups.slice(0, 6),
  };
}

console.log(JSON.stringify(await drawCallReport('input/tile_12021000.glb'), null, 2));
```

The ratio between primitive count and material count is the whole opportunity, and it is usually dramatic on converted city data: 412 primitives across 4 materials means a 103× reduction is available with no loss of anything.

Where that ratio is close to 1 — 400 primitives across 380 materials — merging is blocked by materials, and the work is in step 3 rather than step 2. That is the common shape for photogrammetry and for BIM exports where every element carries its own material instance.

<figure class="diagram">
<svg viewBox="27 -4 687 246" role="img" aria-labelledby="mrg-why-t mrg-why-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mrg-why-t">Frame time against draw calls per tile</title>
  <desc id="mrg-why-d">A chart of measured frame time with thirty tiles in view. At 400 draw calls per tile the frame takes 96 milliseconds. At 100 per tile it takes 31 milliseconds. At 20 it takes 12 milliseconds, inside the 16.7 millisecond budget. At 4 it takes 8 milliseconds. The triangle count is identical in all four cases; only the number of state changes differs.</desc>
  <rect class="svg-bg" x="27" y="-4" width="687" height="246" fill="#ffffff"/>
  <path d="M100 24 V186 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M100 148 H700" stroke="#b0413e" stroke-width="1.6" stroke-dasharray="7 5" fill="none"/>
  <text x="698" y="142" fill="#b0413e" font-size="12" text-anchor="end">16.7 ms budget</text>
  <g stroke-width="1.5">
    <rect x="132" y="30" width="86" height="156" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="272" y="110" width="86" height="76" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="412" y="156" width="86" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="552" y="166" width="86" height="20" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="175" y="24">96 ms</text>
    <text x="315" y="104">31 ms</text>
    <text x="455" y="150">12 ms</text>
    <text x="595" y="160">8 ms</text>
    <text x="175" y="204">400 calls</text><text x="315" y="204">100 calls</text>
    <text x="455" y="204">20 calls</text><text x="595" y="204">4 calls</text>
  </g>
  <text x="400" y="224" fill="#5b6471" font-size="12" text-anchor="middle">draw calls per tile, 30 tiles in view — identical triangle count throughout</text>
  <text x="58" y="100" fill="#5b6471" font-size="12" text-anchor="middle">frame</text>
  <text x="58" y="116" fill="#5b6471" font-size="12" text-anchor="middle">time</text>
</svg>
<figcaption>The triangles are the same in every bar; only the state changes differ, and they cost 12× the frame time.</figcaption>
</figure>

### 2. Merge what already shares a material

```javascript
import { join, dedup, flatten, prune } from '@gltf-transform/functions';

export async function mergeByMaterial(inPath, outPath) {
  const doc = await io.read(inPath);
  await doc.transform(
    dedup(),                                 // collapse identical materials first
    flatten(),                               // bake node transforms into vertices
    join({ keepMeshes: false, keepNamed: false }),
    prune(),
  );
  await io.write(outPath, doc);
  return drawCallReport(outPath);
}
```

`dedup` before `join` is the ordering that matters. `join` merges primitives that share the *same material object*; two materials with identical properties but separate objects block it. `dedup` collapses those first, and on converted city data it is frequently what unlocks the merge — a CityGML conversion often creates one material instance per building with identical values.

`flatten` bakes node transforms into the vertex positions, which is required because merged primitives can only carry one transform. It is also the step that can go wrong: a node with a scale that flips an axis produces inverted winding after flattening, and the merged mesh renders with its faces inside out. The symptom and its diagnosis are in [diagnosing inverted normals across pipeline stages](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/diagnosing-inverted-normals-across-pipeline-stages/).

`keepNamed: false` allows named meshes to merge too. Setting it to `true` preserves named objects as separate primitives, which is occasionally what you want and usually defeats the purpose.

### 3. Atlas the textures that block the merge

```javascript
import sharp from 'sharp';

export async function atlasTextures(doc, { pageSize = 2048, padding = 4 } = {}) {
  const root = doc.getRoot();
  const textures = root.listTextures()
    .filter((t) => t.getMimeType() !== 'image/ktx2');

  // Sort tall-first; shelf-pack into rows.
  const items = [];
  for (const tex of textures) {
    const size = tex.getSize();
    if (!size) continue;
    items.push({ tex, w: size[0], h: size[1] });
  }
  items.sort((a, b) => b.h - a.h);

  const placements = [];
  let x = 0, y = 0, rowH = 0;
  for (const item of items) {
    const w = item.w + padding * 2;
    const h = item.h + padding * 2;
    if (x + w > pageSize) { x = 0; y += rowH; rowH = 0; }
    if (y + h > pageSize) break;                     // page full; caller reduces inputs
    placements.push({ ...item, x: x + padding, y: y + padding });
    x += w;
    rowH = Math.max(rowH, h);
  }

  const composites = await Promise.all(placements.map(async (p) => ({
    input: Buffer.from(p.tex.getImage()),
    left: p.x, top: p.y,
  })));
  const atlasBuffer = await sharp({
    create: { width: pageSize, height: pageSize, channels: 3,
              background: { r: 128, g: 128, b: 128 } },
  }).composite(composites).webp({ quality: 88 }).toBuffer();

  return { atlasBuffer, placements, packed: placements.length, total: items.length };
}

export function remapUVs(prim, placement, pageSize) {
  const uv = prim.getAttribute('TEXCOORD_0');
  if (!uv) return false;
  const array = Float32Array.from(uv.getArray());
  const su = placement.w / pageSize;
  const sv = placement.h / pageSize;
  const ou = placement.x / pageSize;
  const ov = placement.y / pageSize;
  for (let i = 0; i < array.length; i += 2) {
    array[i] = ou + array[i] * su;
    array[i + 1] = ov + array[i + 1] * sv;
  }
  uv.setArray(array);
  return true;
}
```

Atlasing is what turns 380 materials into 1, and the UV remap is the half that gets forgotten. Each primitive's UVs are rescaled from their original 0–1 space into the rectangle the texture occupies in the atlas, which is a two-multiply-and-add per coordinate and must happen for every primitive that shares that texture.

The padding is not cosmetic. Without it the bilinear filter samples across the boundary into a neighbouring texture, which shows as a thin fringe of the wrong colour on every edge — and at a distance, where several texels are averaged, the fringe widens. Four texels is enough for base-colour textures without mipmaps; mipmapped atlases need padding proportional to the deepest mip level, which in practice means either more padding or per-page mip generation.

UVs outside 0–1 cannot be atlased at all. A primitive using `REPEAT` wrapping to tile a brick texture across a facade breaks when its texture becomes part of an atlas, because the repeat now samples its neighbours. Those primitives have to keep their own material, which is why an atlas pass usually reduces material count by a large factor rather than to one.

### 4. Preserve the feature identifiers

```javascript
export function assignFeatureIds(doc) {
  /** Before merging, stamp each primitive's vertices with a per-feature id. */
  const root = doc.getRoot();
  const idByPrimitive = new Map();
  let nextId = 0;

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute('POSITION').getCount();
      const ids = new Uint16Array(count).fill(nextId);
      const accessor = doc.createAccessor(`featureId_${nextId}`)
        .setType('SCALAR')
        .setArray(ids)
        .setBuffer(root.listBuffers()[0]);
      prim.setAttribute('_FEATURE_ID_0', accessor);
      idByPrimitive.set(prim, { id: nextId, name: mesh.getName() || `feature_${nextId}` });
      nextId += 1;
    }
  }
  return { features: nextId, index: idByPrimitive };
}

export function buildPropertyTable(index, attributes) {
  /** A parallel array per property, indexed by feature id. */
  const ids = [...index.values()].sort((a, b) => a.id - b.id);
  return {
    count: ids.length,
    properties: {
      gmlId: ids.map((f) => attributes[f.name]?.gmlId ?? ''),
      buildingFunction: ids.map((f) => attributes[f.name]?.function ?? ''),
      measuredHeight: ids.map((f) => attributes[f.name]?.height ?? null),
      yearOfConstruction: ids.map((f) => attributes[f.name]?.year ?? null),
    },
  };
}
```

Stamping feature ids **before** the merge is the step that makes merging acceptable rather than destructive. After `join`, the 412 buildings are one primitive and there is no other way to tell them apart; with a `_FEATURE_ID_0` attribute per vertex, the merged primitive still knows which building each triangle belongs to, so a click resolves to a building and `Cesium3DTileStyle` can colour by attribute.

`Uint16Array` caps at 65,535 features per tile, which is comfortable for a city block and not for a tile of every tree. `Uint32Array` costs twice the bytes per vertex and is the right choice above that.

The property table goes in the tileset's metadata, as described in [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/), with the feature id as the row index.

### 5. Know when to stop merging

```javascript
export function mergeGranularityPlan(tileExtentM, primitives, { targetCalls = 6 } = {}) {
  /** Merge within spatial cells, not across the whole tile, when the tile is large. */
  const cellsPerAxis = Math.max(1, Math.round(Math.sqrt(targetCalls)));
  const cellM = tileExtentM / cellsPerAxis;
  return {
    tileExtentM,
    cellsPerAxis,
    cellM: Number(cellM.toFixed(1)),
    expectedDrawCalls: cellsPerAxis * cellsPerAxis,
    rationale: cellM < 40
      ? 'cells too small to help; merge the whole tile'
      : 'merging per cell keeps frustum culling useful within the tile',
  };
}

export function assignSpatialGroup(prim, originXZ, cellM) {
  const pos = prim.getAttribute('POSITION');
  const min = pos.getMin([0, 0, 0]);
  const max = pos.getMax([0, 0, 0]);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const i = Math.floor((cx - originXZ[0]) / cellM);
  const j = Math.floor((cz - originXZ[1]) / cellM);
  return `${i}_${j}`;
}

console.log(mergeGranularityPlan(120, 412));
console.log(mergeGranularityPlan(1000, 8200));
```

Merging a whole tile into one primitive makes it a single indivisible unit: the GPU cannot cull any part of it, so a camera seeing one corner of the tile rasterises all of it. For a 120 m tile that is fine — the whole tile is on screen or it is not. For a 1 km tile it is not, and the right granularity is a few spatial cells within the tile, each merged internally.

The rule of thumb that has held up: merge freely within roughly 150 m, and split into cells beyond that. The cost of a handful of extra draw calls is far below the cost of rasterising geometry that is off screen.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="mrg-blockers-t mrg-blockers-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mrg-blockers-t">What blocks a merge, and what unblocks it</title>
  <desc id="mrg-blockers-d">A table of four things that stop primitives merging. Distinct material objects with identical values are unblocked by deduplication. Genuinely distinct textures are unblocked by atlasing and a UV remap. Repeat-wrapped textures cannot be atlased at all and must keep their own material. Node transforms are unblocked by flattening, which is also where a winding flip can be introduced.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="254" y="20" width="178" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="432" y="20" width="290" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="54" width="178" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="432" y="54" width="290" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="88" width="178" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="432" y="88" width="290" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="254" y="122" width="178" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="432" y="122" width="290" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="156" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="254" y="156" width="178" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="432" y="156" width="290" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="136" y="42">blocker</text><text x="343" y="42">unblocked by</text><text x="577" y="42">caveat</text>
    <text x="136" y="76">duplicate material objects</text><text x="343" y="76">dedup</text><text x="577" y="76">run it before join</text>
    <text x="136" y="110">distinct base textures</text><text x="343" y="110">atlas + UV remap</text><text x="577" y="110">pad each region by 2 texels</text>
    <text x="136" y="144">REPEAT-wrapped textures</text><text x="343" y="144">nothing</text><text x="577" y="144">they must keep their own material</text>
    <text x="136" y="178">node transforms</text><text x="343" y="178">flatten</text><text x="577" y="178">a negative determinant flips winding</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">Dedup before join is the ordering that unlocks most of the reduction on converted city data.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">The third row is why an atlas pass usually reduces the material count rather than reaching one.</text>
</svg>
<figcaption>Three of the four blockers have a mechanical fix; repeat-wrapped textures simply cannot be atlased.</figcaption>
</figure>

### 6. Put the pipeline together

```javascript
export async function optimiseTile(inPath, outPath, { tileExtentM = 120,
                                                      atlas = true } = {}) {
  const before = await drawCallReport(inPath);
  const doc = await io.read(inPath);

  const features = assignFeatureIds(doc);
  await doc.transform(dedup(), flatten());

  if (atlas) {
    const { atlasBuffer, placements, packed, total } = await atlasTextures(doc);
    if (packed === total && packed > 1) {
      const atlasTex = doc.createTexture('atlas')
        .setImage(atlasBuffer).setMimeType('image/webp');
      const atlasMat = doc.createMaterial('atlas_material')
        .setBaseColorTexture(atlasTex).setRoughnessFactor(0.9).setMetallicFactor(0.0);
      const byTexture = new Map(placements.map((p) => [p.tex, p]));
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const oldTex = prim.getMaterial()?.getBaseColorTexture();
          const placement = oldTex ? byTexture.get(oldTex) : null;
          if (!placement) continue;
          remapUVs(prim, placement, 2048);
          prim.setMaterial(atlasMat);
        }
      }
    }
  }

  await doc.transform(join({ keepMeshes: false, keepNamed: false }), prune());
  await io.write(outPath, doc);

  const after = await drawCallReport(outPath);
  return { features: features.features, before: before.drawCallsNow,
           after: after.drawCallsNow,
           reduction: Number((before.drawCallsNow / Math.max(after.drawCallsNow, 1))
                             .toFixed(1)) };
}

console.log(await optimiseTile('input/tile_12021000.glb',
                               'output/content/12021000.glb'));
```

<figure class="diagram">
<svg viewBox="6 16 647 232" role="img" aria-labelledby="mrg-order-t mrg-order-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mrg-order-t">Pipeline order, and what each step unblocks</title>
  <desc id="mrg-order-d">Six steps in order. Feature ids are stamped first, because after merging there is no way to tell features apart. Deduplication collapses identical materials so the join can proceed. Flatten bakes node transforms into vertices. Atlasing merges the remaining distinct textures into one page and remaps texture coordinates. Join merges primitives sharing a material. Prune removes what is now unreferenced. Reordering any of the first four breaks the merge.</desc>
  <rect class="svg-bg" x="6" y="16" width="647" height="232" fill="#ffffff"/>
  <defs>
    <marker id="mrg-order-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.6">
    <rect x="20" y="30" width="126" height="48" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="182" y="30" width="126" height="48" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="344" y="30" width="126" height="48" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="506" y="30" width="126" height="48" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="182" y="130" width="126" height="48" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="344" y="130" width="126" height="48" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.8" fill="none" marker-end="url(#mrg-order-arrow)">
    <path d="M146 54 H180"/><path d="M308 54 H342"/><path d="M470 54 H504"/>
    <path d="M569 78 V104 H245 V128"/>
    <path d="M308 154 H342"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="83" y="50">1 feature ids</text><text x="83" y="68">(before merge)</text>
    <text x="245" y="50">2 dedup</text><text x="245" y="68">materials</text>
    <text x="407" y="50">3 flatten</text><text x="407" y="68">transforms</text>
    <text x="569" y="50">4 atlas +</text><text x="569" y="68">remap UVs</text>
    <text x="245" y="150">5 join per</text><text x="245" y="168">material</text>
    <text x="407" y="150">6 prune</text><text x="407" y="168">orphans</text>
  </g>
  <text x="370" y="206" fill="#b0413e" font-size="12.5" text-anchor="middle">stamping ids after step 5 is impossible — the features no longer exist as separate primitives</text>
  <text x="370" y="230" fill="#1f2937" font-size="12.5" text-anchor="middle">atlasing after joining is also impossible — the UVs to remap are already merged</text>
</svg>
<figcaption>The order is forced: identifiers and atlasing must both precede the join that destroys the boundaries they need.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "primitives": 412,
  "materials": 380,
  "drawCallsNow": 412,
  "drawCallsIfMergedPerMaterial": 380,
  "reduction": 1.1,
  "groups": [
    {"material": "building_facade_0", "primitives": 2, "triangles": 1208, "vertices": 744},
    ...
  ]
}
{ features: 412, before: 412, after: 4, reduction: 103 }
```

The first report shows the case where materials block the merge: 412 primitives across 380 materials, so `join` alone would achieve almost nothing. After `dedup` collapsed the identical materials and the atlas absorbed the distinct textures, the tile came out at 4 draw calls — one per remaining material, which are the atlas, two repeat-wrapped facade textures that could not be atlased, and an untextured group.

Verify that the merge did not change what is drawn, since a wrong flatten or a UV remap error changes appearance without changing any count:

```javascript
export async function visualEquivalenceCheck(before, after, tolM = 0.001) {
  const [a, b] = await Promise.all([io.read(before), io.read(after)]);
  const stats = (doc) => {
    let tris = 0, verts = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        tris += Math.floor((idx ? idx.getCount() : pos.getCount()) / 3);
        verts += pos.getCount();
        const mn = pos.getMin([0, 0, 0]), mx = pos.getMax([0, 0, 0]);
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], mn[i]); hi[i] = Math.max(hi[i], mx[i]);
        }
      }
    }
    return { tris, verts, lo, hi };
  };
  const sa = stats(a), sb = stats(b);
  const deltas = [...sa.lo.map((v, i) => Math.abs(v - sb.lo[i])),
                  ...sa.hi.map((v, i) => Math.abs(v - sb.hi[i]))];
  return {
    trianglesEqual: sa.tris === sb.tris,
    trianglesBefore: sa.tris, trianglesAfter: sb.tris,
    maxBoundsDeltaM: Number(Math.max(...deltas).toFixed(5)),
    boundsEqual: Math.max(...deltas) <= tolM,
    verticesBefore: sa.verts, verticesAfter: sb.verts,
  };
}
```

Triangles must be identical — merging changes no geometry — while vertices may fall slightly if `join` welds coincident ones. A bounds delta above a millimetre means `flatten` applied a transform that was not previously being applied, or applied one twice.

Then verify picking still resolves to individual features, which is the property the merge threatens:

```javascript
export async function featureIdCheck(path, expectedFeatures) {
  const doc = await io.read(path);
  const ids = new Set();
  let verticesWithId = 0, verticesTotal = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      verticesTotal += pos.getCount();
      const fid = prim.getAttribute('_FEATURE_ID_0');
      if (!fid) continue;
      verticesWithId += fid.getCount();
      const arr = fid.getArray();
      for (let i = 0; i < arr.length; i++) ids.add(arr[i]);
    }
  }
  return {
    distinctFeatureIds: ids.size,
    expectedFeatures,
    complete: ids.size === expectedFeatures,
    coverage: Number((verticesWithId / Math.max(verticesTotal, 1)).toFixed(3)),
    contiguous: ids.size > 0 && Math.max(...ids) === ids.size - 1,
  };
}
```

`coverage` must be 1.0 and `contiguous` must be true. A coverage below 1 means some primitive was merged without ids and clicking it returns nothing; non-contiguous ids mean the property table's row indices will not line up with what the client reads.

## Performance Notes

- **`join` on a 412-primitive tile takes about 80 ms.** Across 6,000 tiles that is eight minutes, and it shards per tile.
- **Atlasing is the expensive step** at 0.5–2 s per tile, almost all of it image encode. Reuse a decoded source texture across every tile that references it.
- **Merging raises the minimum cullable unit.** Keep merged groups under about 150 m of extent so a partly visible tile does not rasterise entirely.
- **Feature id attributes cost 2 bytes per vertex** as `Uint16`. On a 200,000-vertex tile that is 400 KB before compression and roughly 40 KB after — worth it for picking.
- **Do not merge across LOD levels.** Each level is a separate content file with its own merge.
- **Draw-call reduction is a client-side win and a compression loss.** A merged primitive compresses slightly worse than many small ones because vertex locality drops; run the cache reorder afterwards.

## Common Errors

**Merged tile renders inside out.** `flatten` baked a negative-determinant transform. Flip the winding, or fix the source node's scale.

**Every building is now the same colour.** Materials were merged rather than atlased, so per-building appearance was lost. Use feature ids plus a style instead of distinct materials.

**Textures show fringes at edges.** Atlas padding too small, or mipmaps generated over the whole page. Increase padding and generate mips per region.

**A facade's brick texture now shows other buildings.** A `REPEAT`-wrapped texture was atlased. Those primitives must keep their own material.

**Picking returns the whole tile.** Feature ids missing, or stamped after the join. Stamp first.

**`join` had no effect.** The primitives do not share materials. Run `dedup` first and check the material count.

**Frame rate got worse after merging a large tile.** Culling granularity collapsed. Merge per spatial cell within the tile.

## Frequently Asked Questions

### Does merging conflict with instancing?

Yes, and instancing wins where it applies. Repeated identical geometry — trees, lamp posts — should be instanced, not merged; merging expands each copy into unique vertices. Merge the geometry that is genuinely unique.

### How few draw calls should a tile have?

Between two and eight. One is achievable and makes the tile uncullable internally; more than about ten starts to show in the frame time when many tiles are visible.

### Can I merge across tiles?

No. A tile is the unit of streaming and culling, so merging across tiles would mean loading both to see either.

## Related Guides

- [Generating Instanced Tiles for Trees](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/generating-instanced-tiles-for-trees/) — the alternative for repeated geometry
- [Generating UV Atlases with xatlas](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/generating-uv-atlases-with-xatlas/) — when UVs must be rebuilt rather than remapped
- [Styling Tiles by Metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/) — using the feature ids this preserves

Back to [glTF LOD Generation with Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
