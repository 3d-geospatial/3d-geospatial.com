---
title: "Profiling WebGL with Spector.js"
description: "Capture and read a WebGL frame from a 3D Tiles viewer: draw-call inventory, state-change counts, texture and shader inspection"
---
# Profiling WebGL with Spector.js

This page captures a single frame from a CesiumJS viewer with Spector.js and reads it — counting draw calls and grouping them by what changed between them, finding the redundant state changes and texture binds, checking which shader programs are in use, and turning the capture into a specific change to the tileset rather than a vague "it is slow".

## Why you hit this

The browser's own performance panel tells you the frame took 38 ms and that most of it was in a function called `_executeCommands`. That is true and unusable. What you need to know is how many draw calls that frame issued, how many of them were for tiles outside the view, how many texture binds happened, and whether the shader was recompiled — and none of that is visible from a JavaScript profile.

Spector.js captures the actual WebGL command stream for one frame. It is the only tool that answers "what did the GPU actually get asked to do?", and the answer is usually surprising: a tileset that looks fine issues 2,800 draw calls per frame because every building is its own primitive.

## Prerequisites

- Chrome or Firefox with the Spector.js extension, or the library loaded in the page.
- A CesiumJS viewer with the tileset loaded and the camera at a representative view.
- `npm install spectorjs` if you want captures from a script rather than by hand.

## Step-by-Step

### 1. Capture a frame reproducibly

```javascript
import * as SPECTOR from 'spectorjs';

export function attachSpector(canvas, { commandsPerFrame = 20_000 } = {}) {
  const spector = new SPECTOR.Spector();
  spector.spyCanvases();
  spector.setMarker('tileset-frame');
  return {
    spector,
    capture(frames = 1) {
      return new Promise((resolve) => {
        spector.onCaptureStarted.add(() => console.log('capture started'));
        spector.onCapture.add((capture) => resolve(capture));
        spector.captureCanvas(canvas, commandsPerFrame, frames);
      });
    },
  };
}

export async function captureAtView(viewer, tileset, view, { settleMs = 4000 } = {}) {
  // A capture of a frame that is still loading tiles measures the loader, not the scene.
  viewer.camera.setView(view);
  await waitForTilesSettled(tileset, settleMs);
  const { capture } = attachSpector(viewer.canvas);
  viewer.scene.requestRender();
  const frame = await capture(1);
  return {
    frame,
    context: {
      tilesLoaded: tileset.tilesLoaded,
      selectedTiles: tileset._selectedTiles?.length ?? null,
      maximumScreenSpaceError: tileset.maximumScreenSpaceError,
      resolution: [viewer.canvas.width, viewer.canvas.height],
      devicePixelRatio: window.devicePixelRatio,
    },
  };
}

function waitForTilesSettled(tileset, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (tileset.tilesLoaded || performance.now() - started > timeoutMs) {
        setTimeout(resolve, 250);      // one more frame for the last upload
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}
```

Waiting for `tilesLoaded` before capturing is the step that makes a capture meaningful. A frame captured while tiles are still arriving is dominated by `texImage2D` and `bufferData` calls from the loader, which tells you about the loading path and nothing about the steady-state rendering cost — and those are different problems with different fixes.

Recording the context alongside the capture matters because a draw-call count is meaningless without the screen-space error and the resolution that produced it. A capture at `maximumScreenSpaceError: 32` on a 1080p canvas is not comparable to one at 8 on a 4K display, and comparing them is how a "regression" gets invented.

Setting the camera with `setView` rather than flying makes the capture repeatable, which is what lets two captures a week apart be compared.

### 2. Inventory the draw calls

```javascript
const DRAW_COMMANDS = new Set([
  'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced',
  'drawRangeElements', 'drawArraysInstancedANGLE', 'drawElementsInstancedANGLE',
]);

export function drawCallInventory(capture) {
  const commands = capture.commands ?? [];
  const draws = [];
  let currentProgram = null;
  let currentTexture = null;
  let currentFramebuffer = 'default';

  for (const cmd of commands) {
    const name = cmd.name;
    if (name === 'useProgram') currentProgram = cmd.text ?? String(cmd.arguments?.[0]);
    if (name === 'bindTexture') currentTexture = String(cmd.arguments?.[1]);
    if (name === 'bindFramebuffer') {
      currentFramebuffer = cmd.arguments?.[1] ? String(cmd.arguments[1]) : 'default';
    }
    if (!DRAW_COMMANDS.has(name)) continue;

    const mode = cmd.arguments?.[0];
    const count = Number(cmd.arguments?.[1] ?? cmd.arguments?.[2] ?? 0);
    const instances = name.includes('Instanced')
      ? Number(cmd.arguments?.[cmd.arguments.length - 1] ?? 1)
      : 1;
    draws.push({
      command: name,
      mode,
      vertexOrIndexCount: count,
      instances,
      triangles: Math.floor(count / 3) * instances,
      program: currentProgram,
      texture: currentTexture,
      framebuffer: currentFramebuffer,
    });
  }

  const byProgram = new Map();
  for (const d of draws) {
    const entry = byProgram.get(d.program) ?? { draws: 0, triangles: 0, instanced: 0 };
    entry.draws += 1;
    entry.triangles += d.triangles;
    if (d.instances > 1) entry.instanced += 1;
    byProgram.set(d.program, entry);
  }

  return {
    totalCommands: commands.length,
    drawCalls: draws.length,
    triangles: draws.reduce((s, d) => s + d.triangles, 0),
    instancedDrawCalls: draws.filter((d) => d.instances > 1).length,
    instancesTotal: draws.reduce((s, d) => s + (d.instances > 1 ? d.instances : 0), 0),
    framebuffers: [...new Set(draws.map((d) => d.framebuffer))],
    programs: [...byProgram.entries()]
      .map(([program, v]) => ({ program, ...v }))
      .sort((a, b) => b.draws - a.draws),
    smallDraws: draws.filter((d) => d.triangles < 300).length,
    draws,
  };
}
```

The `smallDraws` count is the finding that most often explains a slow tileset. A draw call with fewer than 300 triangles costs almost the same as one with 30,000 — the per-call overhead dominates — so a frame with 2,400 draw calls averaging 180 triangles is spending its budget on state changes rather than on geometry.

Grouping by shader program separates the passes, which matters in CesiumJS because the globe, the terrain, the tileset and any post-processing are different programs. A frame with 2,800 draw calls where 2,600 belong to one program is a tileset problem; one where they are spread across twelve programs has too many distinct materials.

Tracking the bound framebuffer catches the case where half the draw calls are for a shadow map or a picking pass that nobody needs — and both are switchable off in a viewer.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="spector-inv-t spector-inv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="spector-inv-t">One captured frame, broken down</title>
  <desc id="spector-inv-d">A breakdown of a single captured frame with 2847 draw calls. The tileset program accounts for 2612 calls and 1.8 million triangles, of which 2104 calls carry fewer than 300 triangles each. The globe program accounts for 148 calls. A picking framebuffer accounts for 74 calls that the user never sees. Post-processing accounts for 13. The finding is that 2104 tiny draw calls are 74 percent of the frame's calls and 6 percent of its triangles.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="220" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="238" y="20" width="126" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="364" y="20" width="150" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="514" y="20" width="208" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="220" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="52" width="126" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="364" y="52" width="150" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="514" y="52" width="208" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="86" width="220" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="238" y="86" width="126" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="364" y="86" width="150" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="514" y="86" width="208" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="120" width="220" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="238" y="120" width="126" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="364" y="120" width="150" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="514" y="120" width="208" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="220" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="238" y="154" width="126" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="364" y="154" width="150" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="514" y="154" width="208" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="128" y="41">group</text><text x="301" y="41">draw calls</text>
    <text x="439" y="41">triangles</text><text x="618" y="41">finding</text>
    <text x="128" y="74">tileset program</text><text x="301" y="74">2,612</text>
    <text x="439" y="74">1.80 M</text><text x="618" y="74">92% of all calls</text>
    <text x="128" y="108">… of which &lt; 300 triangles</text><text x="301" y="108">2,104</text>
    <text x="439" y="108">0.11 M</text><text x="618" y="108">74% of calls, 6% of triangles</text>
    <text x="128" y="142">globe + terrain</text><text x="301" y="142">148</text>
    <text x="439" y="142">0.42 M</text><text x="618" y="142">normal</text>
    <text x="128" y="176">picking framebuffer</text><text x="301" y="176">74</text>
    <text x="439" y="176">0.06 M</text><text x="618" y="176">not shown to the user</text>
  </g>
  <text x="370" y="214" fill="#1f2937" font-size="12.5" text-anchor="middle">the fix is not "fewer triangles" — it is fewer, larger draw calls</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">2,104 calls carrying 6% of the geometry is what the frame time is actually going on</text>
</svg>
<figcaption>The frame's cost is in 2,104 tiny draw calls carrying 6% of the triangles, which no triangle-count optimisation touches.</figcaption>
</figure>

### 3. Count the redundant state changes

```javascript
const STATE_COMMANDS = {
  useProgram: (c) => String(c.arguments?.[0]),
  bindTexture: (c) => `${c.arguments?.[0]}:${c.arguments?.[1]}`,
  bindBuffer: (c) => `${c.arguments?.[0]}:${c.arguments?.[1]}`,
  bindVertexArray: (c) => String(c.arguments?.[0]),
  blendFunc: (c) => (c.arguments ?? []).join(','),
  depthFunc: (c) => String(c.arguments?.[0]),
  cullFace: (c) => String(c.arguments?.[0]),
  enable: (c) => `enable:${c.arguments?.[0]}`,
  disable: (c) => `disable:${c.arguments?.[0]}`,
  viewport: (c) => (c.arguments ?? []).join(','),
};

export function redundantStateChanges(capture) {
  const commands = capture.commands ?? [];
  const lastValue = new Map();
  const counts = new Map();
  const redundant = new Map();

  for (const cmd of commands) {
    const keyFn = STATE_COMMANDS[cmd.name];
    if (!keyFn) continue;
    const value = keyFn(cmd);
    counts.set(cmd.name, (counts.get(cmd.name) ?? 0) + 1);
    if (lastValue.get(cmd.name) === value) {
      redundant.set(cmd.name, (redundant.get(cmd.name) ?? 0) + 1);
    }
    lastValue.set(cmd.name, value);
  }

  const rows = [...counts.entries()].map(([name, total]) => ({
    command: name,
    total,
    redundant: redundant.get(name) ?? 0,
    redundantShare: Number(((redundant.get(name) ?? 0) / total).toFixed(3)),
  })).sort((a, b) => b.redundant - a.redundant);

  return {
    stateCommands: [...counts.values()].reduce((a, b) => a + b, 0),
    redundantTotal: [...redundant.values()].reduce((a, b) => a + b, 0),
    rows: rows.slice(0, 8),
    verdict: rows[0]?.redundant > 200
      ? `${rows[0].redundant} redundant ${rows[0].command} calls — the renderer is `
        + 'not sorting by state'
      : 'state changes look reasonable',
  };
}
```

A redundant state change is one that sets the driver to a value it already has. The driver usually filters these cheaply, and "usually" is doing a lot of work — on some mobile drivers a redundant `useProgram` still triggers a validation pass, and 600 of them per frame is measurable.

More useful is what the count *implies*: a high redundant `bindTexture` count means draw calls are not sorted by texture, so the renderer is alternating between materials. That is not something a viewer user can fix directly, and it is a strong argument for the atlasing in [merging meshes to cut draw calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — fewer distinct textures means fewer binds however the renderer sorts.

`viewport` appearing in this list at all is worth investigating: it usually means a render pass is being set up per object, which is a viewer configuration problem.

### 4. Check the textures actually bound

```javascript
export function textureInventory(capture) {
  const commands = capture.commands ?? [];
  const textures = new Map();
  let unit = 0;

  for (const cmd of commands) {
    if (cmd.name === 'activeTexture') unit = Number(cmd.arguments?.[0]) - 0x84C0;
    if (cmd.name === 'texImage2D' || cmd.name === 'texStorage2D'
        || cmd.name === 'compressedTexImage2D') {
      const key = `${cmd.name}@unit${unit}`;
      const width = Number(cmd.arguments?.[3] ?? 0);
      const height = Number(cmd.arguments?.[4] ?? 0);
      const entry = textures.get(key) ?? { uploads: 0, sizes: [] };
      entry.uploads += 1;
      if (width && height) entry.sizes.push([width, height]);
      textures.set(key, entry);
    }
  }

  const uploads = [...textures.entries()].map(([key, v]) => {
    const areas = v.sizes.map(([w, h]) => w * h);
    const compressed = key.startsWith('compressed');
    const bytesPerTexel = compressed ? 0.5 : 4;
    return {
      key,
      uploads: v.uploads,
      largest: v.sizes.length
        ? v.sizes[areas.indexOf(Math.max(...areas))]
        : null,
      estimatedGpuMB: Number((areas.reduce((a, b) => a + b, 0)
        * bytesPerTexel * 1.333 / 1e6).toFixed(2)),
      compressed,
    };
  }).sort((a, b) => b.estimatedGpuMB - a.estimatedGpuMB);

  return {
    uploadCommands: uploads.reduce((s, u) => s + u.uploads, 0),
    estimatedGpuMB: Number(uploads.reduce((s, u) => s + u.estimatedGpuMB, 0)
      .toFixed(2)),
    anyUncompressed: uploads.some((u) => !u.compressed && u.estimatedGpuMB > 1),
    uploads: uploads.slice(0, 6),
    verdict: uploads.some((u) => !u.compressed && u.estimatedGpuMB > 20)
      ? 'large uncompressed textures — KTX2/Basis would cut GPU memory 4–6×'
      : 'texture memory looks controlled',
  };
}
```

Texture uploads appearing in a *steady-state* frame are the finding here. Once tiles are loaded, a frame should upload nothing; `texImage2D` in a settled frame means textures are being evicted and re-uploaded because the cache is too small, which shows as periodic hitching rather than a consistently low frame rate.

The GPU memory estimate is deliberately crude and useful: width × height × 4 × 1.333 for an uncompressed texture, or × 0.5 for a Basis-compressed one. That factor of eight is the whole argument for KTX2, and seeing it against a real capture's numbers is more persuasive than the general claim.

### 5. Inspect the shader programs

```javascript
export function shaderReport(capture) {
  const programs = capture.programs ?? capture.initState?.programs ?? [];
  const rows = programs.map((p, i) => {
    const vertex = p.shaders?.find((s) => /vertex/i.test(s.name ?? s.type ?? ''));
    const fragment = p.shaders?.find((s) => /fragment/i.test(s.name ?? s.type ?? ''));
    const fragSource = fragment?.source ?? '';
    return {
      index: i,
      uniforms: (p.uniforms ?? []).length,
      attributes: (p.attributes ?? []).length,
      vertexLines: (vertex?.source ?? '').split('\n').length,
      fragmentLines: fragSource.split('\n').length,
      textureSamples: (fragSource.match(/texture2D|texture\s*\(/g) ?? []).length,
      branches: (fragSource.match(/\bif\s*\(/g) ?? []).length,
      loops: (fragSource.match(/\bfor\s*\(/g) ?? []).length,
      usesDerivatives: /dFdx|dFdy|fwidth/.test(fragSource),
      styleConditions: (fragSource.match(/czm_style|tiles3d_/g) ?? []).length,
    };
  });

  const heavy = rows.filter((r) => r.branches > 16 || r.textureSamples > 8);
  return {
    programs: rows.length,
    rows: rows.sort((a, b) => b.branches - a.branches).slice(0, 5),
    heavyPrograms: heavy.length,
    verdict: heavy.length
      ? `${heavy.length} program(s) with heavy branching or many texture samples — `
        + 'check the Cesium3DTileStyle conditions'
      : 'shaders are simple',
  };
}
```

Branch count in the fragment shader is the number that connects a capture back to a data decision. A `Cesium3DTileStyle` with 200 conditions compiles to 200 comparisons in the fragment shader, and the capture shows it — which is the measured version of the advice in [styling tiles by metadata with Cesium3DTileStyle](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/styling-tiles-by-metadata-with-cesium3dtilestyle/).

A program count above about fifteen in a tileset frame usually means the content has many distinct material configurations, each producing a shader variant. Every variant is a compile on first use, which is the source of a one-off stutter when a new kind of tile appears.

<figure class="diagram">
<svg viewBox="6 10 708 234" role="img" aria-labelledby="spector-state-t spector-state-d" xmlns="http://www.w3.org/2000/svg">
  <title id="spector-state-t">Redundant state changes in the captured frame</title>
  <desc id="spector-state-d">A bar chart of state commands in one frame with their redundant share. bindTexture is called 2612 times of which 1841 are redundant, because draw calls are not sorted by texture. useProgram is called 2612 times with 2504 redundant. bindBuffer is called 5224 times with 612 redundant. enable and disable are called 418 times with 380 redundant. The pattern says the renderer is alternating between materials rather than batching them.</desc>
  <rect class="svg-bg" x="6" y="10" width="708" height="234" fill="#ffffff"/>
  <path d="M136 24 V180 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.4">
    <rect x="136" y="34" width="400" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="34" width="47" height="24" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="136" y="70" width="200" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="70" width="141" height="24" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="136" y="106" width="200" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="106" width="192" height="24" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="136" y="142" width="32" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="136" y="142" width="29" height="24" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="20" y="51">bindBuffer</text>
    <text x="20" y="87">bindTexture</text>
    <text x="20" y="123">useProgram</text>
    <text x="20" y="159">enable/disable</text>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="546" y="51">5,224 — 612 redundant</text>
    <text x="346" y="87">2,612 — 1,841 redundant</text>
    <text x="346" y="123">2,612 — 2,504 redundant</text>
    <text x="178" y="159">418 — 380 redundant</text>
  </g>
  <g font-size="12">
    <text x="146" y="204" fill="#b0413e">red: redundant</text>
    <text x="260" y="204" fill="#15384a">blue: total calls</text>
  </g>
  <text x="146" y="226" fill="#5b6471" font-size="12">2,504 redundant useProgram calls means one draw call per material, unbatched</text>
</svg>
<figcaption>Redundant binds are cheap individually; their count is the diagnostic, and it says the draw calls are one-per-material.</figcaption>
</figure>

### 6. Turn the capture into a change

```javascript
const THRESHOLDS = {
  drawCallsPerFrame: 400,
  smallDrawShare: 0.25,
  trianglesPerFrame: 4_000_000,
  programs: 15,
  fragmentBranches: 16,
  uncompressedTextureMB: 20,
  uploadsInSettledFrame: 0,
};

export function diagnose(capture, context, thresholds = THRESHOLDS) {
  const draws = drawCallInventory(capture);
  const state = redundantStateChanges(capture);
  const textures = textureInventory(capture);
  const shaders = shaderReport(capture);

  const findings = [];
  const smallShare = draws.smallDraws / Math.max(draws.drawCalls, 1);

  if (draws.drawCalls > thresholds.drawCallsPerFrame) {
    findings.push({
      severity: 'error',
      observation: `${draws.drawCalls} draw calls in one frame`,
      fix: smallShare > thresholds.smallDrawShare
        ? 'merge primitives per material in the tile content (gltf-transform join)'
        : 'reduce the number of visible tiles: raise maximumScreenSpaceError or '
          + 'make tiles larger',
    });
  }
  if (smallShare > thresholds.smallDrawShare) {
    findings.push({
      severity: 'error',
      observation: `${(smallShare * 100).toFixed(0)}% of draw calls carry `
        + '< 300 triangles',
      fix: 'the content has one primitive per feature; join by material and use '
        + 'feature ids for picking',
    });
  }
  if (draws.triangles > thresholds.trianglesPerFrame) {
    findings.push({
      severity: 'warn',
      observation: `${(draws.triangles / 1e6).toFixed(1)} M triangles per frame`,
      fix: 'raise maximumScreenSpaceError, or add a coarser level to the tileset',
    });
  }
  if (shaders.programs > thresholds.programs) {
    findings.push({
      severity: 'warn',
      observation: `${shaders.programs} shader programs`,
      fix: 'dedup materials in the content; each variant is a compile on first use',
    });
  }
  const worstShader = shaders.rows[0];
  if (worstShader && worstShader.branches > thresholds.fragmentBranches) {
    findings.push({
      severity: 'warn',
      observation: `fragment shader has ${worstShader.branches} branches`,
      fix: 'bucket the Cesium3DTileStyle conditions to 16 or fewer',
    });
  }
  if (textures.uploadCommands > thresholds.uploadsInSettledFrame) {
    findings.push({
      severity: 'error',
      observation: `${textures.uploadCommands} texture upload(s) in a settled frame`,
      fix: 'the tile cache is evicting textures — raise tileset.cacheBytes',
    });
  }
  if (textures.anyUncompressed
      && textures.estimatedGpuMB > thresholds.uncompressedTextureMB) {
    findings.push({
      severity: 'warn',
      observation: `about ${textures.estimatedGpuMB} MB of uncompressed texture`,
      fix: 'encode tile textures as KTX2/Basis',
    });
  }

  return {
    context,
    summary: {
      drawCalls: draws.drawCalls,
      triangles: draws.triangles,
      smallDrawShare: Number(smallShare.toFixed(3)),
      instancedDrawCalls: draws.instancedDrawCalls,
      programs: shaders.programs,
      redundantStateChanges: state.redundantTotal,
      estimatedTextureGpuMB: textures.estimatedGpuMB,
    },
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    pass: !findings.some((f) => f.severity === 'error'),
  };
}
```

Every finding carries a **fix** that names a specific change to the content or the viewer configuration, which is the difference between a profile and a diagnosis. "2,847 draw calls" is an observation; "the content has one primitive per feature, join by material" is something someone can do this afternoon.

The distinction between too many draw calls and too many *small* draw calls is the important branch. Too many large draw calls means too many visible tiles, and the fix is in the tileset's structure or the screen-space error; too many small ones means the tile content is fragmented, and the fix is in the content pipeline.

## Expected Output & Verification

```text
{
  "context": {
    "tilesLoaded": true, "selectedTiles": 148,
    "maximumScreenSpaceError": 16, "resolution": [2560, 1340],
    "devicePixelRatio": 2
  },
  "summary": {
    "drawCalls": 2847, "triangles": 2284118, "smallDrawShare": 0.739,
    "instancedDrawCalls": 4, "programs": 9,
    "redundantStateChanges": 5337, "estimatedTextureGpuMB": 412.88
  },
  "findings": [
    {"severity": "error", "observation": "2847 draw calls in one frame",
     "fix": "merge primitives per material in the tile content (gltf-transform join)"},
    {"severity": "error", "observation": "74% of draw calls carry < 300 triangles",
     "fix": "the content has one primitive per feature; join by material and use feature ids for picking"},
    {"severity": "error", "observation": "18 texture upload(s) in a settled frame",
     "fix": "the tile cache is evicting textures — raise tileset.cacheBytes"},
    {"severity": "warn", "observation": "about 412.88 MB of uncompressed texture",
     "fix": "encode tile textures as KTX2/Basis"}
  ],
  "errors": 3, "pass": false
}
```

Three errors with concrete fixes, from one captured frame. The 74% small-draw share against 148 selected tiles says each tile is issuing about 19 draw calls, which is one per building — exactly the situation the merge step exists for.

The 18 texture uploads in a settled frame is the second independent finding and explains a symptom the frame rate does not: periodic hitching as the cache thrashes.

Verify the diagnosis by making the change and re-capturing the same view:

```javascript
export async function beforeAfter(viewer, tilesetUrlBefore, tilesetUrlAfter, view) {
  const results = {};
  for (const [label, url] of [['before', tilesetUrlBefore],
                              ['after', tilesetUrlAfter]]) {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      maximumScreenSpaceError: 16,
      cacheBytes: 536_870_912,
    });
    viewer.scene.primitives.add(tileset);
    const { frame, context } = await captureAtView(viewer, tileset, view);
    const d = diagnose(frame, context);
    const frames = [];
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now();
      viewer.scene.render();
      frames.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    frames.sort((a, b) => a - b);
    results[label] = {
      ...d.summary,
      medianFrameMs: Number(frames[60].toFixed(2)),
      p95FrameMs: Number(frames[114].toFixed(2)),
    };
    viewer.scene.primitives.remove(tileset);
  }
  const before = results.before;
  const after = results.after;
  return {
    results,
    drawCallReduction: Number((before.drawCalls / Math.max(after.drawCalls, 1))
      .toFixed(1)),
    frameTimeReduction: Number((before.medianFrameMs - after.medianFrameMs)
      .toFixed(2)),
    trianglesUnchanged: Math.abs(before.triangles - after.triangles)
      / Math.max(before.triangles, 1) < 0.02,
    verdict: after.medianFrameMs < before.medianFrameMs * 0.75
      ? 'the change worked'
      : 'draw calls fell and the frame time did not — the bottleneck is elsewhere',
  };
}
```

The `trianglesUnchanged` assertion is what makes this a valid comparison: a merge should change the draw-call count and not the geometry, so a triangle count that also fell means something else changed too and the frame-time improvement cannot be attributed.

The verdict's second branch is the honest outcome worth naming. A tileset whose draw calls drop 20× with no frame-time improvement was never draw-call bound, and the capture's other findings — texture memory, shader branches, triangle count — are where to look next.

Then verify the capture is representative rather than a lucky frame:

```javascript
export async function captureStability(viewer, tileset, view, { captures = 5 } = {}) {
  const rows = [];
  for (let i = 0; i < captures; i++) {
    const { frame, context } = await captureAtView(viewer, tileset, view,
                                                   { settleMs: 6000 });
    const d = diagnose(frame, context);
    rows.push({
      capture: i,
      drawCalls: d.summary.drawCalls,
      triangles: d.summary.triangles,
      textureUploads: d.summary.estimatedTextureGpuMB,
      selectedTiles: context.selectedTiles,
    });
  }
  const calls = rows.map((r) => r.drawCalls);
  const spread = (Math.max(...calls) - Math.min(...calls)) / Math.max(...calls);
  return {
    rows,
    drawCallSpread: Number(spread.toFixed(3)),
    stable: spread < 0.05,
    note: spread >= 0.05
      ? 'captures differ by more than 5% — the scene has not settled, or the '
        + 'camera moved between captures'
      : 'captures are consistent; the numbers are representative',
  };
}
```

A draw-call count that varies by more than a few percent across captures of the same view means the scene was not settled, and every number derived from it is provisional. Five captures is cheap and it converts a single measurement into a claim.

<figure class="diagram">
<svg viewBox="4 6 732 234" role="img" aria-labelledby="spector-fix-t spector-fix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="spector-fix-t">Observation to fix</title>
  <desc id="spector-fix-d">A mapping from capture observation to the change it implies. Many draw calls with small triangle counts means the content has one primitive per feature, fixed by joining per material. Many draw calls with large triangle counts means too many visible tiles, fixed by raising the screen-space error. Texture uploads in a settled frame means the tile cache is too small. Many shader programs means duplicate materials. Many fragment branches means too many style conditions. High uncompressed texture memory means KTX2 is needed.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="234" fill="#ffffff"/>
  <defs>
    <marker id="spector-fix-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="312" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="56" width="312" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="92" width="312" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="128" width="312" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="164" width="312" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="410" y="20" width="312" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="56" width="312" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="92" width="312" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="128" width="312" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="410" y="164" width="312" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.6" fill="none" marker-end="url(#spector-fix-arrow)">
    <path d="M330 35 H408"/><path d="M330 71 H408"/><path d="M330 107 H408"/>
    <path d="M330 143 H408"/><path d="M330 179 H408"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="174" y="40">many calls, few triangles each</text>
    <text x="566" y="40">join primitives per material</text>
    <text x="174" y="76">many calls, many triangles each</text>
    <text x="566" y="76">raise maximumScreenSpaceError</text>
    <text x="174" y="112">texture uploads in a settled frame</text>
    <text x="566" y="112">raise tileset.cacheBytes</text>
    <text x="174" y="148">many shader programs</text>
    <text x="566" y="148">dedup materials in the content</text>
    <text x="174" y="184">many fragment branches</text>
    <text x="566" y="184">bucket the style conditions</text>
  </g>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">the first two look identical in a JavaScript profile and need opposite fixes</text>
</svg>
<figcaption>The top two rows are indistinguishable without a capture and their fixes are in different places — the content pipeline and the viewer configuration.</figcaption>
</figure>

## Performance Notes

- **Spector.js slows the page substantially while spying.** Capture, read the result, then reload without the extension; never measure frame times with it attached.
- **A capture of 20,000 commands is a few megabytes of JSON.** A frame with 2,800 draw calls generates roughly 15,000 commands, so the default limit is usually adequate; raise it if the capture truncates.
- **Capture one frame, not ten.** The interesting information is in a single frame's command stream, and ten captures are ten times the JSON for the same finding.
- **The browser's own frame timing is the measurement**; the capture is the explanation. Use both.
- **`EXT_disjoint_timer_query_webgl2` gives real GPU timings** where the browser exposes it, which is the only way to attribute time to a specific draw call rather than counting calls.
- **Automate the capture in CI against a fixed view** and assert on the draw-call count; it is a stable number and it regresses quietly.

## Common Errors

**The capture is empty.** `spyCanvases()` was called after the context was created, or the canvas was obtained differently. Call it before the viewer initialises.

**The capture is dominated by `texImage2D` and `bufferData`.** The frame was captured while tiles were loading. Wait for `tilesLoaded`.

**Draw-call count varies wildly between captures.** The camera moved or the scene had not settled. Fix the view with `setView` and use the stability check.

**`capture.programs` is empty.** Some Spector versions put programs in `initState`. The shader report handles both.

**Frame time is much worse than usual while profiling.** Expected — the spy wraps every WebGL call. Detach before timing.

**Everything looks fine and the viewer still stutters.** The stutter is probably not in the render frame: check the loader, the decode workers, and garbage collection in the browser's performance panel.

**The instanced draw-call count is 0 on a tileset with instanced trees.** The instancing extension was flattened by the content pipeline; see [generating instanced tiles for trees](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/generating-instanced-tiles-for-trees/).

## Frequently Asked Questions

### Spector.js or the browser's WebGL inspector?

Spector.js gives the full command stream with state at each call, which is what the analysis above needs. Chrome's own tooling is better for GPU timing and worse for command inspection, so they complement each other.

### Can I capture from a headless browser in CI?

Yes, with the library rather than the extension: load `spectorjs`, capture on a fixed view, and assert on the draw-call count. It is a stable regression test and much cheaper than a visual one.

### Does a high draw-call count always matter?

On desktop, up to a few hundred calls per frame is free. The threshold that matters is the device: a mid-range phone starts struggling at about 150, so a tileset intended for mobile needs an order of magnitude fewer calls than one for a workstation.

## Related Guides

- [Merging Meshes to Cut Draw Calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/) — the fix for the commonest finding
- [Diagnosing Slow First Render of Tilesets](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/diagnosing-slow-first-render-of-tilesets/) — the loading path this capture deliberately excludes
- [Debugging with the Cesium 3D Tiles Inspector](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/debugging-with-the-cesium-3d-tiles-inspector/) — the tileset-level view of the same frame

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
