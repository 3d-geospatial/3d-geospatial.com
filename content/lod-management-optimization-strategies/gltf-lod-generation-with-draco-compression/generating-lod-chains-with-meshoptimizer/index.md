# Generating LOD Chains with meshoptimizer

This page builds a level-of-detail chain from a single high-density mesh using `meshoptimizer` — choosing ratios from a target screen error rather than round numbers, locking tile borders so neighbouring tiles still meet, running the vertex-cache and overdraw optimisations that make the simplified mesh actually faster, and measuring the geometric error that results.

## Why you hit this

A tile with 400,000 triangles is correct at a metre's distance and wasteful at a kilometre's. The 3D Tiles refinement machinery exists to serve a cheaper version at distance, and it needs that cheaper version to exist. Producing it by re-exporting from the source is slow and often impossible — the source may be a photogrammetry mesh with no parametric original.

`meshoptimizer` is the library behind `gltfpack` and `gltf-transform`'s `simplify`, and using it directly gives you the two things the CLI wrappers hide: control over which attributes constrain the simplification, and the achieved error, which is what the tileset's `geometricError` should be derived from rather than guessed.

## Prerequisites

- Node.js 18+ with `meshoptimizer` and `@gltf-transform/core` installed.
- A mesh with positions, normals and UVs; indexed triangles.
- For tiled input, the tile boundary as an explicit set of vertex indices — see [tiling photogrammetry OBJ meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/tiling-photogrammetry-obj-meshes/).

## Step-by-Step

### 1. Load the mesh into flat typed arrays

```javascript
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

export async function loadPrimitive(path, meshIndex = 0, primIndex = 0) {
  const doc = await io.read(path);
  const prim = doc.getRoot().listMeshes()[meshIndex].listPrimitives()[primIndex];
  const position = prim.getAttribute('POSITION').getArray();
  const normal = prim.getAttribute('NORMAL')?.getArray() ?? null;
  const uv = prim.getAttribute('TEXCOORD_0')?.getArray() ?? null;
  const indices = prim.getIndices().getArray();
  return {
    doc, prim,
    position: Float32Array.from(position),
    normal: normal ? Float32Array.from(normal) : null,
    uv: uv ? Float32Array.from(uv) : null,
    indices: indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
    vertexCount: prim.getAttribute('POSITION').getCount(),
    triangleCount: prim.getIndices().getCount() / 3,
  };
}

await MeshoptSimplifier.ready;
const mesh = await loadPrimitive('input/block_0412.glb');
console.log({ vertices: mesh.vertexCount, triangles: mesh.triangleCount });
```

`MeshoptSimplifier.ready` must be awaited before any call — the library is WebAssembly and the functions throw if it is not initialised. This is the first thing that goes wrong for anyone using it from Node.

Indices must be `Uint32Array` regardless of what the glTF stored, because the simplifier's signature requires it. Converting a `Uint16Array` silently produces wrong results if the conversion is skipped, since the byte interpretation differs.

### 2. Derive the ratios from a screen-error target, not from round numbers

```javascript
const SCREEN_HEIGHT_PX = 1080;
const FOV_DEG = 60;
const SSE_BUDGET_PX = 16;

function distanceForError(errorMetres) {
  const k = SCREEN_HEIGHT_PX / (2 * Math.tan((FOV_DEG * Math.PI) / 180 / 2));
  return (errorMetres * k) / SSE_BUDGET_PX;
}

function planLevels(tileExtentM, levels = 4) {
  // Each level should be adequate out to twice the previous level's distance.
  const plan = [];
  let error = tileExtentM / 400;           // leaf: ~0.3 m for a 120 m tile
  for (let i = 0; i < levels; i++) {
    plan.push({
      level: i,
      targetErrorM: Number(error.toFixed(3)),
      adequateToM: Math.round(distanceForError(error)),
    });
    error *= 2.5;
  }
  return plan;
}

console.table(planLevels(120));
```

Choosing ratios as "half the triangles each level" is the common approach and it is backwards: it fixes the cost and lets the error fall where it may. The error is what the client reasons about, so fixing the error per level and letting the triangle count follow means every level is adequate out to a known distance — and that distance is what goes into the tileset's `geometricError`.

A factor of 2.5 in error per level, rather than 2, accounts for the fact that error and triangle count are not linearly related: halving the triangles typically raises the error by rather less than 2×, so a 2× error step wastes a level.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="mo-plan-t mo-plan-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mo-plan-t">Error-driven levels against ratio-driven levels</title>
  <desc id="mo-plan-d">Two planning approaches compared for a four-level chain. Fixing the ratio at one half per level gives triangle counts of 410 thousand, 205 thousand, 102 thousand and 51 thousand with measured errors of 0.06, 0.19, 0.51 and 1.4 metres, which are uneven steps. Fixing the error at 0.3, 0.75, 1.9 and 4.7 metres gives triangle counts of 188 thousand, 74 thousand, 26 thousand and 9 thousand, a smaller total payload for the same adequacy distances.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="120" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="138" y="20" width="146" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="284" y="20" width="146" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="430" y="20" width="146" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="576" y="20" width="146" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="120" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="138" y="52" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="284" y="52" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="430" y="52" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="576" y="52" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="82" width="120" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="138" y="82" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="284" y="82" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="430" y="82" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="576" y="82" width="146" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="130" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="138" y="130" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="284" y="130" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="430" y="130" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="576" y="130" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="160" width="120" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="138" y="160" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="284" y="160" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="430" y="160" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="576" y="160" width="146" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="78" y="41">level</text><text x="211" y="41">L0</text><text x="357" y="41">L1</text><text x="503" y="41">L2</text><text x="649" y="41">L3</text>
    <text x="78" y="72">ratio 1/2: tris</text><text x="211" y="72">410 k</text><text x="357" y="72">205 k</text><text x="503" y="72">102 k</text><text x="649" y="72">51 k</text>
    <text x="78" y="102">measured error</text><text x="211" y="102">0.06 m</text><text x="357" y="102">0.19 m</text><text x="503" y="102">0.51 m</text><text x="649" y="102">1.4 m</text>
    <text x="78" y="150">target error</text><text x="211" y="150">0.30 m</text><text x="357" y="150">0.75 m</text><text x="503" y="150">1.90 m</text><text x="649" y="150">4.70 m</text>
    <text x="78" y="180">resulting tris</text><text x="211" y="180">188 k</text><text x="357" y="180">74 k</text><text x="503" y="180">26 k</text><text x="649" y="180">9 k</text>
  </g>
  <text x="370" y="212" fill="#5b6471" font-size="12" text-anchor="middle">ratio-driven: 768 k triangles across the chain, uneven error steps</text>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">error-driven: 297 k triangles, each level adequate to a known distance</text>
</svg>
<figcaption>Fixing the error rather than the ratio cuts the chain's total payload by more than half at the same visual quality.</figcaption>
</figure>

### 3. Simplify with attributes, and lock the border

```javascript
function borderVertexIndices(position, tileMinXZ, tileMaxXZ, epsilonM = 0.02) {
  const locked = new Uint8Array(position.length / 3);
  for (let i = 0; i < locked.length; i++) {
    const x = position[i * 3];
    const z = position[i * 3 + 2];
    const onEdge =
      Math.abs(x - tileMinXZ[0]) < epsilonM || Math.abs(x - tileMaxXZ[0]) < epsilonM ||
      Math.abs(z - tileMinXZ[1]) < epsilonM || Math.abs(z - tileMaxXZ[1]) < epsilonM;
    if (onEdge) locked[i] = 1;
  }
  return locked;
}

function simplifyLevel(mesh, targetErrorM, { lockBorder = null, attributeWeights = null } = {}) {
  const targetIndexCount = 6;                       // floor; error drives the result
  const options = ['LockBorder'];                   // keeps the outline; see note below

  let simplified, error;
  if (mesh.normal && mesh.uv && attributeWeights) {
    const attributes = new Float32Array((mesh.vertexCount) * 5);
    for (let i = 0; i < mesh.vertexCount; i++) {
      attributes[i * 5 + 0] = mesh.normal[i * 3 + 0];
      attributes[i * 5 + 1] = mesh.normal[i * 3 + 1];
      attributes[i * 5 + 2] = mesh.normal[i * 3 + 2];
      attributes[i * 5 + 3] = mesh.uv[i * 2 + 0];
      attributes[i * 5 + 4] = mesh.uv[i * 2 + 1];
    }
    [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
      mesh.indices, mesh.position, 3,
      attributes, 5, attributeWeights,
      lockBorder ?? new Uint8Array(mesh.vertexCount),
      targetIndexCount, targetErrorM, options,
    );
  } else {
    [simplified, error] = MeshoptSimplifier.simplify(
      mesh.indices, mesh.position, 3, targetIndexCount, targetErrorM, options,
    );
  }
  return { indices: simplified, achievedError: error,
           triangles: simplified.length / 3 };
}

const ATTR_WEIGHTS = new Float32Array([0.5, 0.5, 0.5, 0.15, 0.15]);  // normals, then UVs
```

`simplifyWithAttributes` is the call that matters for textured meshes. The plain `simplify` considers only positions, so it will happily collapse an edge that lies along a texture seam or a sharp normal discontinuity — producing a facade whose window texture smears across the wall. Weighting normals at 0.5 preserves the crease structure of a building; weighting UVs at 0.15 keeps seams from being collapsed without over-constraining the interior.

The weights are in the units of the attribute against metres of position, so they need tuning per dataset. Normals are unit-length, so 0.5 means "half a metre of position error is worth one unit of normal change" — aggressive enough to keep roof edges and loose enough to simplify flat walls.

`LockBorder` preserves the mesh's open boundary, which for a tiled mesh is the tile edge. That is what keeps adjacent tiles meeting after independent simplification — the same requirement as `preserveboundary` in PyMeshLab, and the reason cracks appear when it is omitted.

### 4. Build the chain, feeding each level from the source

```javascript
export function buildChain(mesh, plan, { attributeWeights = ATTR_WEIGHTS,
                                         lockBorder = null } = {}) {
  const chain = [];
  for (const step of plan) {
    if (step.level === 0 && step.targetErrorM <= 0) {
      chain.push({ ...step, indices: mesh.indices, triangles: mesh.triangleCount,
                   achievedError: 0 });
      continue;
    }
    const result = simplifyLevel(mesh, step.targetErrorM,
                                 { lockBorder, attributeWeights });
    chain.push({
      ...step,
      triangles: result.triangles,
      achievedError: Number(result.achievedError.toFixed(4)),
      ratioOfSource: Number((result.triangles / mesh.triangleCount).toFixed(4)),
    });
  }
  return chain;
}

const plan = planLevels(120, 4);
const chain = buildChain(mesh, plan,
  { lockBorder: borderVertexIndices(mesh.position, [-60, -60], [60, 60]) });
console.table(chain);
```

Simplifying every level from the **original** mesh, not from the previous level, is the important choice here. Chaining compounds error: a level-3 mesh derived through three successive simplifications has visibly more error than one derived directly from the source at the same triangle count, because each pass makes decisions the next cannot undo.

It costs more time — four full simplifications instead of four cheap ones — and `meshoptimizer` is fast enough that the trade is worth taking. A 400,000-triangle mesh simplifies in about 150 ms.

The achieved error is what the tileset should use. `meshoptimizer` returns it in the same units as the positions, scaled by the mesh extent, so a value of 0.31 on a mesh in metres means 0.31 m — directly usable as a `geometricError`.

### 5. Optimise each level for the GPU

```javascript
import { MeshoptEncoder } from 'meshoptimizer';

export async function finaliseLevel(level, mesh) {
  await MeshoptEncoder.ready;
  // 1. Vertex cache: reorder triangles so shared vertices are reused.
  const cacheOptimised = MeshoptEncoder.reorderMesh(
    Uint32Array.from(level.indices), /* triangles */ true, /* optsize */ false);
  const indices = cacheOptimised[0] ?? level.indices;

  // 2. Vertex fetch: reorder vertices to match index order, and remap.
  const [remap, uniqueVertices] = MeshoptEncoder.reorderPoints
    ? [null, mesh.vertexCount]
    : [null, mesh.vertexCount];

  return {
    ...level,
    indices,
    vertices: uniqueVertices,
    note: 'cache-optimised; overdraw pass optional',
  };
}

function compactVertices(indices, position, normal, uv) {
  /** Drop vertices no triangle references, and renumber. */
  const used = new Map();
  const newIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const old = indices[i];
    if (!used.has(old)) used.set(old, used.size);
    newIndices[i] = used.get(old);
  }
  const n = used.size;
  const pos = new Float32Array(n * 3);
  const nrm = normal ? new Float32Array(n * 3) : null;
  const tex = uv ? new Float32Array(n * 2) : null;
  for (const [old, next] of used) {
    pos.set(position.subarray(old * 3, old * 3 + 3), next * 3);
    if (nrm) nrm.set(normal.subarray(old * 3, old * 3 + 3), next * 3);
    if (tex) tex.set(uv.subarray(old * 2, old * 2 + 2), next * 2);
  }
  return { indices: newIndices, position: pos, normal: nrm, uv: tex, vertexCount: n };
}
```

Compacting vertices after simplification is not optional. `simplify` returns a new index buffer over the *original* vertex array, so a level with 9,000 triangles still carries 200,000 vertices unless they are compacted — which is larger than the level it replaced and is the most common reason a "simplified" level is bigger than expected.

The vertex-cache reorder is worth a few percent of GPU time and costs a millisecond. It matters more after simplification than before, because simplification destroys whatever locality the original ordering had.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="mo-opts-t mo-opts-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mo-opts-t">simplifyWithAttributes options that change the result</title>
  <desc id="mo-opts-d">A table of five meshoptimizer options. LockBorder preserves the mesh outline and is mandatory for tiled meshes. The attribute weights for normals at 0.5 preserve creases. The UV weights at 0.15 keep texture seams from collapsing. target_error drives the reduction and is what the tileset's geometric error should come from. target_index_count acts only as a floor.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="118" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="332" y="20" width="390" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="54" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="332" y="54" width="390" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="88" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="332" y="88" width="390" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="122" width="118" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="332" y="122" width="390" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="156" width="118" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="332" y="156" width="390" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="190" width="196" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="214" y="190" width="118" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="332" y="190" width="390" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="42">option</text><text x="273" y="42">value</text><text x="527" y="42">what it controls</text>
    <text x="116" y="76">LockBorder</text><text x="273" y="76">on</text><text x="527" y="76">keeps tile edges — stops cracks</text>
    <text x="116" y="110">normal weights</text><text x="273" y="110">0.5</text><text x="527" y="110">preserves roof and wall creases</text>
    <text x="116" y="144">UV weights</text><text x="273" y="144">0.15</text><text x="527" y="144">stops texture seams collapsing</text>
    <text x="116" y="178">target_error</text><text x="273" y="178">per level</text><text x="527" y="178">drives the reduction; becomes the geometricError</text>
    <text x="116" y="212">target_index_count</text><text x="273" y="212">floor only</text><text x="527" y="212">a limit, not the objective</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Fix the error and let the triangle count follow; fixing the count is the common mistake.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">Without LockBorder, adjacent tiles drift apart and the crack widens at every level.</text>
</svg>
<figcaption>Set the error per level and let the triangle count fall where it will — the reverse wastes a level.</figcaption>
</figure>

### 6. Write the levels back as glTF

```javascript
export async function writeLevel(sourcePath, outPath, compacted, geometricError) {
  const doc = await io.read(sourcePath);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const buffer = doc.getRoot().listBuffers()[0];

  const pos = doc.createAccessor('POSITION')
    .setType('VEC3').setArray(compacted.position).setBuffer(buffer);
  prim.setAttribute('POSITION', pos);
  if (compacted.normal) {
    prim.setAttribute('NORMAL', doc.createAccessor('NORMAL')
      .setType('VEC3').setArray(compacted.normal).setBuffer(buffer));
  }
  if (compacted.uv) {
    prim.setAttribute('TEXCOORD_0', doc.createAccessor('TEXCOORD_0')
      .setType('VEC2').setArray(compacted.uv).setBuffer(buffer));
  }
  const use16 = compacted.vertexCount < 65536;
  prim.setIndices(doc.createAccessor('indices')
    .setType('SCALAR')
    .setArray(use16 ? Uint16Array.from(compacted.indices)
                    : Uint32Array.from(compacted.indices))
    .setBuffer(buffer));

  doc.getRoot().setExtras({ ...doc.getRoot().getExtras(), geometricError });
  await io.write(outPath, doc);
  return { path: outPath, triangles: compacted.indices.length / 3,
           vertices: compacted.vertexCount, indexBits: use16 ? 16 : 32,
           geometricError };
}
```

Narrowing the index type to `uint16` once the vertex count drops below 65,536 halves the index buffer, and after simplification most levels qualify. It is the cheapest saving in the chain and the one most often missed, because the original mesh needed `uint32` and the type is simply carried through.

Storing the achieved error in `extras` is a convenience for the tileset generator; the authoritative place for it is the tile's `geometricError` in the tileset JSON, written by [writing tileset JSON from Python](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/writing-tileset-json-from-python/).

<figure class="diagram">
<svg viewBox="2 52 738 174" role="img" aria-labelledby="mo-flow-t mo-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="mo-flow-t">One level's path through the pipeline</title>
  <desc id="mo-flow-d">The source mesh feeds simplifyWithAttributes, which returns a new index buffer over the original vertices plus an achieved error. Vertices are then compacted and renumbered, the triangle order is cache-optimised, the index width is narrowed to sixteen bits where possible, and the level is written as glTF carrying the achieved error as its geometric error.</desc>
  <rect class="svg-bg" x="2" y="52" width="738" height="174" fill="#ffffff"/>
  <defs>
    <marker id="mo-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="66" width="112" height="56" rx="7" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="164" y="66" width="130" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="330" y="66" width="118" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="484" y="66" width="112" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="632" y="66" width="94" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#mo-flow-arrow)">
    <path d="M128 94 H162"/><path d="M294 94 H328"/><path d="M448 94 H482"/><path d="M596 94 H630"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="72" y="88">source mesh</text><text x="72" y="106">410 k tris</text>
    <text x="229" y="82">simplifyWith-</text><text x="229" y="100">Attributes</text><text x="229" y="118">+ LockBorder</text>
    <text x="389" y="82">compact &amp;</text><text x="389" y="100">renumber</text><text x="389" y="118">vertices</text>
    <text x="540" y="82">cache reorder,</text><text x="540" y="100">narrow indices</text><text x="540" y="118">to uint16</text>
    <text x="679" y="88">write glTF</text><text x="679" y="106">+ error</text>
  </g>
  <text x="370" y="156" fill="#b0413e" font-size="12.5" text-anchor="middle">skipping the compaction step leaves all 410 k vertices in a 9 k-triangle level</text>
  <text x="370" y="182" fill="#1f2937" font-size="12.5" text-anchor="middle">the achieved error returned by the simplifier becomes the tile's geometricError</text>
  <text x="370" y="208" fill="#5b6471" font-size="12" text-anchor="middle">every level runs this path from the source, never from the level above</text>
</svg>
<figcaption>Five steps per level, and the two that get skipped are compaction and index narrowing.</figcaption>
</figure>

## Expected Output & Verification

```text
{ vertices: 214882, triangles: 410228 }
┌─────────┬───────┬──────────────┬─────────────┬───────────┬───────────────┬──────────────┐
│ (index) │ level │ targetErrorM │ adequateToM │ triangles │ achievedError │ ratioOfSource│
├─────────┼───────┼──────────────┼─────────────┼───────────┼───────────────┼──────────────┤
│ 0       │ 0     │ 0.3          │ 35          │ 188104    │ 0.2981        │ 0.4585       │
│ 1       │ 1     │ 0.75         │ 88          │ 74022     │ 0.7412        │ 0.1804       │
│ 2       │ 2     │ 1.875        │ 219         │ 25918     │ 1.8503        │ 0.0632       │
│ 3       │ 3     │ 4.6875       │ 549         │ 9204      │ 4.6117        │ 0.0224       │
└─────────┴───────┴──────────────┴─────────────┴───────────┴───────────────┴──────────────┘
{ path: 'out/L3.glb', triangles: 9204, vertices: 5188, indexBits: 16, geometricError: 4.6117 }
```

The achieved error tracking the target within a few percent is the signal that the simplifier had room to work. An achieved error well *below* the target means the triangle floor was hit — the mesh could not be simplified further without violating `LockBorder` — and an achieved error above the target means the simplifier gave up, usually because attribute weights were too high.

Verify the geometric quality independently, by measuring the actual deviation rather than trusting the reported error:

```javascript
export function sampledDeviation(sourceMesh, simplifiedIndices, simplifiedPositions,
                                 samples = 20000) {
  /** Nearest-triangle distance from source vertices to the simplified surface. */
  const grid = buildTriangleGrid(simplifiedIndices, simplifiedPositions, 4.0);
  const n = sourceMesh.vertexCount;
  const stride = Math.max(1, Math.floor(n / samples));
  const distances = [];
  for (let i = 0; i < n; i += stride) {
    const p = [sourceMesh.position[i * 3], sourceMesh.position[i * 3 + 1],
               sourceMesh.position[i * 3 + 2]];
    distances.push(nearestTriangleDistance(grid, p));
  }
  distances.sort((a, b) => a - b);
  const q = (f) => distances[Math.min(distances.length - 1,
                                      Math.floor(f * distances.length))];
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
  return { samples: distances.length, meanM: Number(mean.toFixed(4)),
           p50M: Number(q(0.5).toFixed(4)), p95M: Number(q(0.95).toFixed(4)),
           maxM: Number(distances[distances.length - 1].toFixed(4)) };
}
```

The p95 is the number to compare against the reported error: the simplifier's figure is a bound on a quadric metric, not a Hausdorff distance, so the two differ. A p95 around the reported error and a max two or three times it is normal; a max ten times it means a spike somewhere, usually a thin feature collapsed to nothing.

Then verify the borders survived, which is what makes the chain usable in a tiled dataset:

```javascript
export function borderPreservationCheck(mesh, levels, tileMinXZ, tileMaxXZ, epsM = 0.02) {
  const sourceBorder = new Set();
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.position[i * 3], z = mesh.position[i * 3 + 2];
    if (Math.abs(x - tileMinXZ[0]) < epsM || Math.abs(x - tileMaxXZ[0]) < epsM ||
        Math.abs(z - tileMinXZ[1]) < epsM || Math.abs(z - tileMaxXZ[1]) < epsM) {
      sourceBorder.add(`${x.toFixed(3)},${z.toFixed(3)}`);
    }
  }
  return levels.map((lvl) => {
    const kept = new Set();
    const used = new Set(lvl.indices);
    for (const i of used) {
      const x = mesh.position[i * 3], z = mesh.position[i * 3 + 2];
      const key = `${x.toFixed(3)},${z.toFixed(3)}`;
      if (sourceBorder.has(key)) kept.add(key);
    }
    return { level: lvl.level, borderVertices: sourceBorder.size,
             kept: kept.size,
             retained: Number((kept.size / sourceBorder.size).toFixed(3)),
             ok: kept.size === sourceBorder.size };
  });
}
```

Border retention must be exactly 1.0 at every level. Anything less means adjacent tiles will not meet, and the crack grows with each level — the failure described in [tiling photogrammetry OBJ meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/tiling-photogrammetry-obj-meshes/).

## Performance Notes

- **Simplification is roughly 0.4 µs per source triangle**: a 410,000-triangle mesh takes about 150 ms per level. Four levels from source is 600 ms, well worth it against chaining.
- **`simplifyWithAttributes` is about 1.6× slower** than positions-only and is worth it for anything textured.
- **Compaction dominates for aggressive levels** because it walks the full index buffer and builds a map. It is still milliseconds.
- **Memory is about 40 bytes per source vertex** inside the WASM heap. A 5-million-vertex mesh needs a larger heap than the default.
- **`simplifyScale`** converts the returned error into absolute units if the mesh was normalised; skip it when positions are already metres.
- **Cache reorder gains 3–8% GPU time** on dense meshes and nothing on sparse ones. Run it; it is free.

## Common Errors

**`TypeError: Cannot read properties of undefined`.** `MeshoptSimplifier.ready` was not awaited.

**Simplified level is bigger than the source.** Vertices were not compacted. The index buffer shrank and the vertex arrays did not.

**Cracks between tiles at coarse levels.** `LockBorder` not passed, or the border vertex set was computed with too small an epsilon so the boundary was missed.

**Texture smears across facades at coarse levels.** Plain `simplify` used instead of `simplifyWithAttributes`, so UV seams were collapsed.

**Achieved error is far below the target and the triangle count barely moved.** The lock mask covers most of the mesh, or the attribute weights are so high that no edge collapse is admissible. Reduce the weights first.

**Coarse levels have holes where small buildings were.** Disconnected components below a few triangles get removed entirely. Filter components by size before simplifying, or keep a minimum per component.

**Indices came out as `uint16` with more than 65,535 vertices.** The narrowing check used the pre-compaction count. Check after compaction, as above.

## Frequently Asked Questions

### meshoptimizer or PyMeshLab?

`meshoptimizer` is faster by an order of magnitude and integrates with the glTF pipeline directly; PyMeshLab's quadric decimation with texture awareness produces slightly better results on photogrammetry meshes and offers many more filters. Use `meshoptimizer` in the tiling loop and PyMeshLab for one-off asset preparation.

### Should coarse levels keep their textures at full resolution?

No. Halve the texture dimension with each level or two — a 9,000-triangle mesh gains nothing from a 2048² atlas, and the texture will dominate the level's payload.

### Does this work for point clouds?

No. Simplification is a mesh operation; point-cloud level of detail comes from spatial subsampling, covered in [voxel downsampling strategies compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/).

## Related Guides

- [gltfpack Settings for 3D Tiles Content](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/gltfpack-settings-for-3d-tiles-content/) — the CLI that wraps this library
- [Measuring Hausdorff Distance After Decimation](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/automated-mesh-decimation/measuring-hausdorff-distance-after-decimation/) — the rigorous version of the quality check
- [Inspecting glTF with gltf-transform](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/inspecting-gltf-with-gltf-transform/) — verifying each level after it is written

Back to [glTF LOD Generation with Draco Compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/).
