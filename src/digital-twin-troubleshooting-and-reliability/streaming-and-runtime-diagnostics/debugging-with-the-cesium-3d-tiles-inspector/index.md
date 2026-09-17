---
title: "Debugging with the Cesium 3D Tiles Inspector"
description: "Read every Cesium3DTilesInspector field and act on it: selected vs visited tiles, memory counters, bounding-volume overlays"
---
# Debugging with the Cesium 3D Tiles Inspector

This page turns the CesiumJS 3D Tiles Inspector from a panel of numbers into a diagnostic procedure — what each statistic actually counts, which combinations point at which defect, how to use the bounding-volume and freeze-frame overlays to see a culling problem, and how to dump the same statistics from a script so a finding becomes a regression test.

## Why you hit this

The inspector is the fastest route from "this tileset feels wrong" to a specific cause, and most of its fields are read wrongly. "Visited" and "Selected" look interchangeable and mean very different things; "Tiles style recolored" is usually zero and occasionally explains everything; the memory counters are the only place a cache problem is visible.

The panel also has three overlays — bounding volumes, content volumes and freeze frame — which together answer questions no counter can: why is this tile loaded, why is that one not, and what exactly did the last frame select.

## Prerequisites

- CesiumJS 1.100 or later with a loaded `Cesium3DTileset`.
- `Cesium3DTilesInspector` added to the viewer, or `tileset.debugShowStatistics` for a console-only version.
- A repeatable camera position, because every number here depends on the view.

## Step-by-Step

### 1. Add the inspector and fix the view

```javascript
export function attachInspector(viewer, tileset) {
  const inspector = viewer.container.querySelector('.cesium-viewer-cesiumInspectorContainer')
    ? null
    : new Cesium.Cesium3DTilesInspector(viewer.container, viewer.scene);
  const model = inspector?.viewModel;
  if (model) {
    model.tileset = tileset;
    model.performance = true;         // frame-time graph
    model.showStatistics = true;
    model.showPickStatistics = true;
    model.showResourceCacheStatistics = true;
  }
  return { inspector, model };
}

export const VIEWS = {
  cityOverview: {
    destination: Cesium.Cartesian3.fromDegrees(10.7522, 59.9139, 2400),
    orientation: { heading: 0.0, pitch: Cesium.Math.toRadians(-45), roll: 0.0 },
  },
  streetLevel: {
    destination: Cesium.Cartesian3.fromDegrees(10.7461, 59.9128, 12),
    orientation: { heading: Cesium.Math.toRadians(78),
                   pitch: Cesium.Math.toRadians(-4), roll: 0.0 },
  },
  obliqueDistrict: {
    destination: Cesium.Cartesian3.fromDegrees(10.7602, 59.9188, 420),
    orientation: { heading: Cesium.Math.toRadians(212),
                   pitch: Cesium.Math.toRadians(-22), roll: 0.0 },
  },
};

export async function settleAt(viewer, tileset, view, { timeoutMs = 15_000 } = {}) {
  viewer.camera.setView(view);
  const started = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      if (tileset.tilesLoaded || performance.now() - started > timeoutMs) {
        setTimeout(resolve, 300);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  return {
    view: Object.keys(VIEWS).find((k) => VIEWS[k] === view) ?? 'custom',
    settledMs: Math.round(performance.now() - started),
    tilesLoaded: tileset.tilesLoaded,
  };
}
```

Fixing the camera with `setView` rather than `flyTo` is what makes the numbers comparable between sessions. Every statistic in the panel is a function of the view, so a reading taken after a manual fly-around is a reading of an unknown state.

Waiting for `tilesLoaded` matters for a different reason than in a WebGL capture: the inspector's `numberOfPendingRequests` and `numberOfTilesProcessing` are the interesting fields *while* loading, and the selection and memory fields are only meaningful once loading has stopped. Reading both sets at the same moment mixes two different diagnostics.

Three named views rather than one is deliberate: a defect that appears only at street level or only in an oblique view is common, and comparing the same statistics across the three is often the whole diagnosis.

### 2. Read the selection statistics correctly

```javascript
export function selectionStats(tileset) {
  const s = tileset.statistics;
  return {
    // Tiles whose content was rendered this frame.
    selected: s.selected,
    // Tiles the traversal looked at: visited >= selected always.
    visited: s.visited,
    // Tiles examined for the request queue, including ones culled.
    numberOfCommands: s.numberOfCommands,
    numberOfAttemptedRequests: s.numberOfAttemptedRequests,
    numberOfPendingRequests: s.numberOfPendingRequests,
    numberOfTilesProcessing: s.numberOfTilesProcessing,
    numberOfTilesWithContentReady: s.numberOfTilesWithContentReady,
    numberOfTilesTotal: s.numberOfTilesTotal,
    numberOfLoadedTilesTotal: s.numberOfLoadedTilesTotal,
    // Derived ratios are what actually diagnose.
    visitedPerSelected: Number((s.visited / Math.max(s.selected, 1)).toFixed(1)),
    commandsPerSelected: Number((s.numberOfCommands / Math.max(s.selected, 1))
      .toFixed(1)),
    loadedButNotSelected: s.numberOfTilesWithContentReady - s.selected,
  };
}

const SELECTION_RULES = [
  {
    when: (v) => v.visitedPerSelected > 12,
    finding: 'the traversal visits far more tiles than it selects',
    cause: 'bounding volumes are much larger than their content, so nothing culls '
         + 'early; or the tree is too deep for its content',
    fix: 'tighten the bounding volumes and check the tree depth',
  },
  {
    when: (v) => v.commandsPerSelected > 8,
    finding: 'each selected tile issues many draw commands',
    cause: 'tile content has one primitive per feature',
    fix: 'join primitives per material in the content pipeline',
  },
  {
    when: (v) => v.loadedButNotSelected > v.selected * 2,
    finding: 'far more tiles are resident than are being rendered',
    cause: 'the cache is large and the camera moved, or refinement is ADD where '
         + 'REPLACE was meant',
    fix: 'check the refine mode; a large cache is otherwise healthy',
  },
  {
    when: (v) => v.numberOfPendingRequests > 0 && v.numberOfTilesProcessing === 0,
    finding: 'requests are pending but nothing is being processed',
    cause: 'the network is the bottleneck, not the decoder',
    fix: 'check the transport and the request concurrency',
  },
  {
    when: (v) => v.numberOfTilesProcessing > 8,
    finding: 'many tiles are decoding simultaneously',
    cause: 'Draco or KTX2 decode is the bottleneck',
    fix: 'reduce tile size, or switch Draco to meshopt for faster decode',
  },
];

export function diagnoseSelection(tileset) {
  const v = selectionStats(tileset);
  return {
    stats: v,
    findings: SELECTION_RULES.filter((r) => r.when(v))
      .map(({ finding, cause, fix }) => ({ finding, cause, fix })),
  };
}
```

**Visited** counts every tile the traversal examined, including ones it culled; **selected** counts the tiles whose content was actually rendered. The ratio between them is the culling efficiency, and it is the single most useful derived number the panel does not show.

A ratio of 3 to 8 is healthy: the traversal descends a few levels and culls siblings. A ratio above 12 means the culling is not working, which on a correct tileset means the bounding volumes are too loose — the failure described in [validating tileset bounding volumes against content](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-tileset-bounding-volumes-against-content/).

`numberOfCommands` divided by `selected` is the draw calls per tile, which connects the panel to the content pipeline: above about eight, the tile content has one primitive per feature and wants the merge from [merging meshes to cut draw calls](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/merging-meshes-to-cut-draw-calls/).

The pending-versus-processing distinction separates a network problem from a decode problem, and they need opposite fixes: more concurrency for the first, smaller tiles for the second.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="inspector-ratios-t inspector-ratios-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inspector-ratios-t">Visited against selected, and what the ratio means</title>
  <desc id="inspector-ratios-d">Three readings of the same tileset from the same view. A healthy tileset visits 640 tiles and selects 148, a ratio of 4.3, and culling is working. A tileset with loose bounding volumes visits 4180 tiles and selects 152, a ratio of 27.5, because nothing culls early. A tileset with a tree far deeper than its content visits 1840 and selects 41, a ratio of 44.9, because the traversal descends through many almost empty levels.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="208" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="226" y="20" width="108" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="334" y="20" width="108" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="442" y="20" width="96" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="538" y="20" width="184" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="208" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="226" y="54" width="108" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="334" y="54" width="108" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="442" y="54" width="96" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="538" y="54" width="184" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="98" width="208" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="226" y="98" width="108" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="334" y="98" width="108" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="442" y="98" width="96" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="538" y="98" width="184" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="142" width="208" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="226" y="142" width="108" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="334" y="142" width="108" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="442" y="142" width="96" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="538" y="142" width="184" height="44" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="122" y="41">tileset</text><text x="280" y="41">visited</text>
    <text x="388" y="41">selected</text><text x="490" y="41">ratio</text>
    <text x="630" y="41">what it means</text>
    <text x="122" y="72">healthy</text><text x="122" y="90">tight volumes</text>
    <text x="280" y="82">640</text><text x="388" y="82">148</text><text x="490" y="82">4.3</text>
    <text x="630" y="82">culling works</text>
    <text x="122" y="116">loose bounding</text><text x="122" y="134">volumes</text>
    <text x="280" y="126">4,180</text><text x="388" y="126">152</text><text x="490" y="126">27.5</text>
    <text x="630" y="116">nothing culls early —</text><text x="630" y="134">tighten the volumes</text>
    <text x="122" y="160">tree deeper than</text><text x="122" y="178">its content</text>
    <text x="280" y="170">1,840</text><text x="388" y="170">41</text><text x="490" y="170">44.9</text>
    <text x="630" y="160">many near-empty levels —</text><text x="630" y="178">flatten the tree</text>
  </g>
  <text x="370" y="212" fill="#1f2937" font-size="12.5" text-anchor="middle">the selected count is nearly identical in all three; only the ratio distinguishes them</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">the inspector shows both numbers and not the ratio, which is why the panel is easy to misread</text>
</svg>
<figcaption>All three rows render roughly the same scene; the visited count is what separates a healthy tileset from two broken ones.</figcaption>
</figure>

### 3. Read the memory counters

```javascript
export function memoryStats(tileset) {
  const s = tileset.statistics;
  const cacheBytes = tileset.cacheBytes ?? tileset.maximumMemoryUsage * 1024 * 1024;
  const total = s.geometryByteLength + s.texturesByteLength
    + s.batchTableByteLength;
  return {
    geometryMB: Number((s.geometryByteLength / 1e6).toFixed(1)),
    texturesMB: Number((s.texturesByteLength / 1e6).toFixed(1)),
    batchTableMB: Number((s.batchTableByteLength / 1e6).toFixed(1)),
    totalMB: Number((total / 1e6).toFixed(1)),
    cacheLimitMB: Number((cacheBytes / 1e6).toFixed(1)),
    cacheUtilisation: Number((total / Math.max(cacheBytes, 1)).toFixed(3)),
    textureShare: Number((s.texturesByteLength / Math.max(total, 1)).toFixed(3)),
    loadedTiles: s.numberOfLoadedTilesTotal,
    mbPerTile: Number((total / 1e6 / Math.max(s.numberOfLoadedTilesTotal, 1))
      .toFixed(2)),
  };
}

const MEMORY_RULES = [
  {
    when: (m) => m.cacheUtilisation > 0.95,
    finding: 'the tile cache is full',
    cause: 'tiles are being evicted and re-requested as the camera moves',
    fix: 'raise tileset.cacheBytes, or reduce per-tile payload',
  },
  {
    when: (m) => m.textureShare > 0.75,
    finding: 'textures are the overwhelming majority of tile memory',
    cause: 'uncompressed textures, or atlases larger than the content needs',
    fix: 'encode textures as KTX2/Basis and reduce the atlas dimension per level',
  },
  {
    when: (m) => m.batchTableMB > m.geometryMB,
    finding: 'metadata occupies more memory than geometry',
    cause: 'string properties in the property table, or many properties per feature',
    fix: 'use enums instead of strings and drop properties nothing styles by',
  },
  {
    when: (m) => m.mbPerTile > 4,
    finding: `${m.mbPerTile} MB per loaded tile`,
    cause: 'tiles are too large for smooth streaming',
    fix: 'rebalance the tile payloads',
  },
];

export function diagnoseMemory(tileset) {
  const m = memoryStats(tileset);
  return {
    stats: m,
    findings: MEMORY_RULES.filter((r) => r.when(m))
      .map(({ finding, cause, fix }) => ({
        finding: typeof finding === 'function' ? finding(m) : finding, cause, fix })),
  };
}
```

`cacheUtilisation` at or above 0.95 is the finding that explains periodic hitching better than any other number. A full cache evicts the least recently used tiles, the camera pans back, and those tiles are re-requested and re-decoded — so the viewer does the same work repeatedly and the frame rate is fine between the stalls.

The `batchTableByteLength` counter is the one nobody looks at, and on a metadata-rich tileset it is startling: a property table with four string properties per feature over 400,000 features can exceed the geometry, which is the measured argument for the enum advice in [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/).

`mbPerTile` connects the panel to the tile-balance work: above about 4 MB per tile, a single tile's arrival is visible as a stall regardless of how well everything else is tuned.

<figure class="diagram">
<svg viewBox="26 13 659 217" role="img" aria-labelledby="inspector-mem-t inspector-mem-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inspector-mem-t">Where tile memory goes, and the counter nobody reads</title>
  <desc id="inspector-mem-d">A stacked bar of a tileset's 1841 megabytes of resident tile memory. Textures account for 1420 megabytes, geometry for 284 and the batch table holding per-feature metadata for 137. The cache limit is 1900 megabytes, so utilisation is 97 percent and tiles are being evicted and re-requested. The finding is that textures are 77 percent of the total and the batch table is half the size of the geometry, which points at string properties in the metadata schema.</desc>
  <rect class="svg-bg" x="26" y="13" width="659" height="217" fill="#ffffff"/>
  <g stroke-width="1.4">
    <rect x="40" y="56" width="474" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="514" y="56" width="95" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="609" y="56" width="46" height="40" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <path d="M675 46 V106" stroke="#b0413e" stroke-width="2.4" stroke-dasharray="6 4" fill="none"/>
  <text x="671" y="40" fill="#b0413e" font-size="12" text-anchor="end">cache limit 1,900 MB</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="277" y="81">textures 1,420 MB (77%)</text>
    <text x="561" y="81">geom 284</text>
    <text x="632" y="122">batch 137</text>
  </g>
  <text x="40" y="140" fill="#1f2937" font-size="12.5">cacheUtilisation 0.97 — tiles are evicted and re-requested on every pan</text>
  <text x="40" y="162" fill="#1f2937" font-size="12.5">textureShare 0.77 — uncompressed atlases; KTX2 would cut this 4–6×</text>
  <text x="40" y="184" fill="#1f2937" font-size="12.5">batchTableByteLength is half the geometry — string properties in the schema</text>
  <text x="40" y="212" fill="#5b6471" font-size="12">three findings from three counters, and only the first is visible as a symptom</text>
</svg>
<figcaption>The batch-table counter is the one nobody reads, and on a metadata-rich tileset it can exceed the geometry.</figcaption>
</figure>

### 4. Use the overlays to see what the numbers imply

```javascript
export const OVERLAYS = {
  boundingVolumes: {
    set: (t, on) => { t.debugShowBoundingVolume = on; },
    shows: 'the volume the traversal culls against',
    useWhen: 'visited/selected is high, or geometry disappears from some angles',
    lookFor: 'volumes much larger than their content, or a child sticking out of '
           + 'its parent',
  },
  contentVolumes: {
    set: (t, on) => { t.debugShowContentBoundingVolume = on; },
    shows: 'the tighter volume around the content itself, where present',
    useWhen: 'comparing declared against actual extent',
    lookFor: 'a large gap between the tile volume and the content volume',
  },
  viewerRequestVolumes: {
    set: (t, on) => { t.debugShowViewerRequestVolume = on; },
    shows: 'volumes the camera must be inside for the tile to load',
    useWhen: 'a tile never loads however close the camera gets',
    lookFor: 'a request volume that does not contain any plausible camera position',
  },
  geometricError: {
    set: (t, on) => { t.debugShowGeometricError = on; },
    shows: 'each selected tile\'s geometric error as a label',
    useWhen: 'refinement happens at the wrong distance',
    lookFor: 'a child whose error is not smaller than its parent\'s',
  },
  renderingStatistics: {
    set: (t, on) => { t.debugShowRenderingStatistics = on; },
    shows: 'per-tile command, point and triangle counts as labels',
    useWhen: 'one tile is suspected of dominating the frame',
    lookFor: 'a single tile with an order of magnitude more commands than its peers',
  },
  memoryUsage: {
    set: (t, on) => { t.debugShowMemoryUsage = on; },
    shows: 'per-tile texture and geometry memory as labels',
    useWhen: 'the cache is full and you need to know which tiles are large',
    lookFor: 'tiles whose texture memory dwarfs their geometry',
  },
  freezeFrame: {
    set: (t, on) => { t.debugFreezeFrame = on; },
    shows: 'stops the traversal so the current selection can be inspected',
    useWhen: 'the selection changes faster than you can look at it',
    lookFor: 'what was selected at the moment the problem appeared',
  },
  wireframe: {
    set: (t, on) => { t.debugWireframe = on; },
    shows: 'triangle edges',
    useWhen: 'density or decimation looks wrong',
    lookFor: 'a level whose triangles are far finer or coarser than its neighbours',
  },
};

export function overlayPlan(diagnosis) {
  const plan = [];
  for (const f of diagnosis.findings) {
    if (f.finding.includes('visits far more tiles')) {
      plan.push('boundingVolumes', 'contentVolumes');
    }
    if (f.finding.includes('draw commands')) plan.push('renderingStatistics');
    if (f.finding.includes('cache is full')) plan.push('memoryUsage');
    if (f.finding.includes('never loads')) plan.push('viewerRequestVolumes');
  }
  return [...new Set(plan)].map((key) => ({ overlay: key, ...OVERLAYS[key] }));
}
```

`debugFreezeFrame` is the overlay that makes the others usable. Without it the traversal reselects every frame, so turning on the bounding-volume display while moving shows a flickering mess; freezing the frame pins the selection and lets you fly the camera *outside* it to see what was chosen and why.

That combination — freeze, then fly out and look back — is the procedure for diagnosing a culling problem. Tiles whose volumes are visibly larger than their content are the ones inflating the visited count, and seeing three of them explains a ratio of 27 immediately.

`debugShowViewerRequestVolume` is worth knowing about because it explains an otherwise baffling symptom: a tile that never loads no matter how close the camera gets, because it has a viewer request volume the camera is never inside.

### 5. Dump the statistics from a script

```javascript
export async function statisticsReport(viewer, tileset, views = VIEWS,
                                       { settleTimeoutMs = 20_000 } = {}) {
    const rows = [];
    for (const [name, view] of Object.entries(views)) {
      const settle = await settleAt(viewer, tileset, view,
                                    { timeoutMs: settleTimeoutMs });
      const selection = diagnoseSelection(tileset);
      const memory = diagnoseMemory(tileset);

      const frames = [];
      for (let i = 0; i < 90; i++) {
        const t0 = performance.now();
        viewer.scene.render();
        frames.push(performance.now() - t0);
        await new Promise((r) => requestAnimationFrame(r));
      }
      frames.sort((a, b) => a - b);

      rows.push({
        view: name,
        settledMs: settle.settledMs,
        ...selection.stats,
        ...memory.stats,
        medianFrameMs: Number(frames[45].toFixed(2)),
        p95FrameMs: Number(frames[85].toFixed(2)),
        findings: [...selection.findings, ...memory.findings],
      });
    }

    const allFindings = rows.flatMap((r) => r.findings.map((f) => f.finding));
    return {
      rows,
      distinctFindings: [...new Set(allFindings)],
      worstView: rows.slice().sort((a, b) => b.p95FrameMs - a.p95FrameMs)[0]?.view,
      pass: allFindings.length === 0,
    };
  }

export function toMarkdown(report) {
  const lines = ['| view | visited | selected | ratio | cmds/tile | mem MB | p95 ms |',
                 '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of report.rows) {
    lines.push(`| ${r.view} | ${r.visited} | ${r.selected} | `
      + `${r.visitedPerSelected} | ${r.commandsPerSelected} | ${r.totalMB} | `
      + `${r.p95FrameMs} |`);
  }
  if (report.distinctFindings.length) {
    lines.push('', '### Findings', ...report.distinctFindings.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}
```

Reading the same statistics from three fixed views and printing a table is what turns the inspector from an interactive tool into a regression test. `tileset.statistics` is a public object, so everything the panel shows is scriptable — and a CI job that asserts `visitedPerSelected < 12` catches a bounding-volume regression the day it is introduced.

Rendering 90 frames after settling gives the frame-time percentiles in the same table, which is what makes a finding actionable: a visited ratio of 27 with a 9 ms p95 is a tidiness issue, and the same ratio with a 48 ms p95 is the cause.

### 6. Turn a finding into a fix

```javascript
const FIX_MAP = {
  'the traversal visits far more tiles than it selects': {
    where: 'tileset generation',
    action: 'recompute bounding volumes from the decoded content',
    guide: 'validating-tileset-bounding-volumes-against-content',
    verify: 'visitedPerSelected below 8 from all three views',
  },
  'each selected tile issues many draw commands': {
    where: 'content pipeline',
    action: 'gltf-transform join per material, keep feature ids for picking',
    guide: 'merging-meshes-to-cut-draw-calls',
    verify: 'commandsPerSelected below 4',
  },
  'the tile cache is full': {
    where: 'viewer configuration',
    action: 'raise tileset.cacheBytes to 2–3× the steady-state total',
    guide: 'diagnosing-slow-first-render-of-tilesets',
    verify: 'cacheUtilisation below 0.8 after a pan and return',
  },
  'textures are the overwhelming majority of tile memory': {
    where: 'content pipeline',
    action: 'KTX2/Basis encoding and a per-level texture dimension',
    guide: 'gltfpack-settings-for-3d-tiles-content',
    verify: 'textureShare below 0.6',
  },
  'metadata occupies more memory than geometry': {
    where: 'metadata schema',
    action: 'replace string properties with enums; drop unused properties',
    guide: 'defining-tileset-and-group-metadata',
    verify: 'batchTableMB below geometryMB',
  },
};

export function actionPlan(report, fixMap = FIX_MAP) {
  const plan = [];
  for (const finding of report.distinctFindings) {
    const fix = fixMap[finding];
    if (fix) {
      plan.push({ finding, ...fix });
    } else {
      plan.push({ finding, where: 'unknown',
                  action: 'reproduce with freeze frame and the bounding-volume '
                        + 'overlay' });
    }
  }
  return {
    plan,
    byArea: plan.reduce((acc, p) => {
      acc[p.where] = (acc[p.where] ?? 0) + 1;
      return acc;
    }, {}),
    note: 'most inspector findings resolve in the content pipeline, not the viewer',
  };
}
```

<figure class="diagram">
<svg viewBox="4 12 732 252" role="img" aria-labelledby="inspector-overlay-t inspector-overlay-d" xmlns="http://www.w3.org/2000/svg">
  <title id="inspector-overlay-t">Freeze frame plus bounding volumes, seen from outside</title>
  <desc id="inspector-overlay-d">Two views of the same frozen selection. Looking along the camera direction, the tiles appear correctly chosen. Flying outside the frozen frustum and looking back reveals three selected tiles whose bounding volumes extend far beyond the frustum, which is why the traversal visited them. Their content volumes are much smaller, confirming the declared volumes are too loose rather than the content being large.</desc>
  <rect class="svg-bg" x="4" y="12" width="732" height="252" fill="#ffffff"/>
  <rect x="18" y="26" width="330" height="200" rx="9" fill="#ffffff" stroke="#e6e0d4" stroke-width="1.5"/>
  <rect x="392" y="26" width="330" height="200" rx="9" fill="#ffffff" stroke="#e6e0d4" stroke-width="1.5"/>
  <text x="183" y="50" fill="#1f2937" font-size="13" text-anchor="middle">along the frozen camera</text>
  <text x="557" y="50" fill="#1f2937" font-size="13" text-anchor="middle">from outside, looking back</text>
  <path d="M183 72 L96 196 H270 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.8"/>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="1.4">
    <rect x="120" y="140" width="34" height="34"/>
    <rect x="164" y="140" width="34" height="34"/>
    <rect x="208" y="140" width="34" height="34"/>
  </g>
  <text x="183" y="212" fill="#1f2937" font-size="12" text-anchor="middle">looks correct</text>
  <path d="M470 78 L442 196 H612 L586 78" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.8" fill-opacity="0.5"/>
  <g fill="none" stroke="#b0413e" stroke-width="1.8" stroke-dasharray="5 4">
    <path d="M410 96 H530 V192 H410 Z"/>
    <path d="M500 88 H620 V192 H500 Z"/>
    <path d="M588 104 H706 V192 H588 Z"/>
  </g>
  <g fill="#f7dfdc" stroke="#b0413e" stroke-width="1.4">
    <rect x="456" y="154" width="28" height="28"/>
    <rect x="546" y="150" width="28" height="28"/>
    <rect x="634" y="156" width="28" height="28"/>
  </g>
  <text x="557" y="212" fill="#b0413e" font-size="12" text-anchor="middle">volumes 4× the content, reaching outside the frustum</text>
  <text x="370" y="246" fill="#5b6471" font-size="12" text-anchor="middle">freeze the frame, then fly out — this is the only way to see why a tile was visited</text>
</svg>
<figcaption>The selection looks right from the camera and is obviously wrong from outside it, which is what freeze frame exists for.</figcaption>
</figure>

## Expected Output & Verification

```text
| view             | visited | selected | ratio | cmds/tile | mem MB | p95 ms |
| ---              | ---     | ---      | ---   | ---       | ---    | ---    |
| cityOverview     | 4180    | 152      | 27.5  | 17.2      | 1841.4 | 41.8   |
| streetLevel      | 1204    | 48       | 25.1  | 18.4      | 1902.1 | 38.2   |
| obliqueDistrict  | 3812    | 141      | 27.0  | 17.8      | 1884.8 | 44.1   |

### Findings
- the traversal visits far more tiles than it selects
- each selected tile issues many draw commands
- the tile cache is full
- textures are the overwhelming majority of tile memory
```

```text
{
  "plan": [
    {"finding": "the traversal visits far more tiles than it selects",
     "where": "tileset generation",
     "action": "recompute bounding volumes from the decoded content",
     "verify": "visitedPerSelected below 8 from all three views"},
    {"finding": "each selected tile issues many draw commands",
     "where": "content pipeline",
     "action": "gltf-transform join per material, keep feature ids for picking",
     "verify": "commandsPerSelected below 4"},
    {"finding": "the tile cache is full",
     "where": "viewer configuration",
     "action": "raise tileset.cacheBytes to 2–3× the steady-state total",
     "verify": "cacheUtilisation below 0.8 after a pan and return"}
  ],
  "byArea": {"tileset generation": 1, "content pipeline": 2,
             "viewer configuration": 1},
  "note": "most inspector findings resolve in the content pipeline, not the viewer"
}
```

A visited ratio of about 27 in all three views is the primary finding, and its consistency across views is informative: a ratio that is high everywhere is a tileset property, while one that spikes only at street level would point at the vertical extents discussed in [octree vs quadtree subdivision for tall buildings](https://www.3d-geospatial.com/lod-management-optimization-strategies/hierarchical-lod-structuring/octree-vs-quadtree-subdivision-for-tall-buildings/).

Three of the four findings resolve in the pipeline rather than the viewer, which is the usual distribution and the reason the action plan records *where* each fix belongs.

Verify a finding before acting on it, because the inspector reports symptoms and several causes share a symptom:

```javascript
export async function confirmCullingFinding(viewer, tileset, view) {
  await settleAt(viewer, tileset, view);
  const baseline = selectionStats(tileset);

  // If the volumes are loose, tightening the screen-space error should not
  // change the visited/selected ratio much — the traversal is not error-bound.
  const originalSse = tileset.maximumScreenSpaceError;
  const readings = [];
  for (const sse of [originalSse / 2, originalSse, originalSse * 2]) {
    tileset.maximumScreenSpaceError = sse;
    await settleAt(viewer, tileset, view);
    const s = selectionStats(tileset);
    readings.push({ sse, visited: s.visited, selected: s.selected,
                    ratio: s.visitedPerSelected });
  }
  tileset.maximumScreenSpaceError = originalSse;

  const ratios = readings.map((r) => r.ratio);
  const spread = Math.max(...ratios) / Math.max(Math.min(...ratios), 1e-9);
  return {
    baseline,
    readings,
    ratioSpread: Number(spread.toFixed(2)),
    conclusion: spread < 1.3
      ? 'the ratio is insensitive to screen-space error — the bounding volumes are '
        + 'the cause, not the refinement policy'
      : 'the ratio tracks the screen-space error — the tree is being traversed '
        + 'deeply because refinement demands it, not because culling fails',
  };
}
```

Sweeping the screen-space error separates the two causes of a high visited ratio. If the ratio barely moves, the traversal is visiting tiles it cannot cull, which is a bounding-volume problem; if the ratio tracks the error, the traversal is descending because refinement asks it to, which is a tree-structure or geometric-error problem.

Then verify the fix with the same script, from the same three views:

```javascript
export async function regressionGate(viewer, tilesetUrl, thresholds = {
  visitedPerSelected: 8,
  commandsPerSelected: 4,
  cacheUtilisation: 0.85,
  textureShare: 0.6,
  p95FrameMs: 20,
}) {
  const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
    maximumScreenSpaceError: 16,
    cacheBytes: 1_073_741_824,
  });
  viewer.scene.primitives.add(tileset);
  const report = await statisticsReport(viewer, tileset);

  const breaches = [];
  for (const row of report.rows) {
    for (const [key, limit] of Object.entries(thresholds)) {
      if (row[key] !== undefined && row[key] > limit) {
        breaches.push({ view: row.view, metric: key, value: row[key], limit });
      }
    }
  }
  viewer.scene.primitives.remove(tileset);
  return {
    views: report.rows.length,
    breaches,
    pass: breaches.length === 0,
    summary: breaches.length
      ? `${breaches.length} threshold breach(es) across ${report.rows.length} views`
      : 'all views within thresholds',
  };
}
```

Five thresholds across three views is fifteen assertions, and they are all derived from `tileset.statistics` — so this runs headless in CI and fails a pull request that loosens a bounding volume or splits a mesh back into per-feature primitives.

## Performance Notes

- **The inspector itself costs a few milliseconds per frame** when statistics are enabled, and considerably more with the bounding-volume overlay on. Turn the overlays off before measuring frame times.
- **`debugShowBoundingVolume` draws a wireframe per selected tile**, so with 4,000 visited tiles it is slower than the scene. Use it with freeze frame.
- **`tileset.statistics` is free to read** — it is a plain object updated during traversal — so the scripted report adds nothing to the frame.
- **Three views is the right number** for a regression gate: overview, street level and oblique catch different defects and take about a minute together.
- **`debugFreezeFrame` stops the traversal but not the renderer**, so the frame time while frozen is the cost of the frozen selection, which is a useful measurement in itself.
- **Read the loading counters while loading** and the selection counters after; they are different diagnostics at different moments.

## Common Errors

**The inspector panel is empty.** `viewModel.tileset` was not set, or the tileset was added to the scene after the inspector was created.

**Every number is zero.** The camera is not looking at the tileset, or the tileset failed to load — check the browser console for a 404 on `tileset.json`.

**Statistics change every frame and nothing can be read.** Use `debugFreezeFrame`.

**Bounding volumes look enormous in the overlay.** They probably are; that is the finding. Compare against the content volume overlay.

**`visited` equals `selected`.** The tileset has one level, or `refine` is `ADD` throughout so nothing is replaced.

**Memory numbers do not match the browser's.** The counters measure tile content; the browser includes the whole page, Cesium itself and the GPU driver's allocations.

**The frame-time graph shows spikes the p95 does not.** The graph includes frames during loading; the scripted measurement settles first. Both are true and answer different questions.

## Frequently Asked Questions

### Is the inspector safe to ship in production?

The panel is a debug tool and adds weight; `tileset.statistics` is not, and reading it in production to report the visited ratio and cache utilisation is cheap and worth doing. Ship the reader, not the panel.

### Which number should I watch first?

`visited / selected`. It is not displayed, it is one division, and it separates a tileset-structure problem from everything else.

### How does this relate to a WebGL capture?

The inspector explains the tileset's decisions; a capture explains what those decisions cost the GPU. A high `commandsPerSelected` here and 2,800 draw calls in a capture are the same finding seen from both ends — see [profiling WebGL with Spector.js](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/profiling-webgl-with-spector-js/).

## Related Guides

- [Validating Tileset Bounding Volumes Against Content](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/validating-tileset-bounding-volumes-against-content/) — fixing the commonest finding at its source
- [Profiling WebGL with Spector.js](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/profiling-webgl-with-spector-js/) — the GPU-side view of the same frame
- [Diagnosing Slow First Render of Tilesets](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/diagnosing-slow-first-render-of-tilesets/) — the loading counters this page reads after settling

Back to [Streaming and Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
