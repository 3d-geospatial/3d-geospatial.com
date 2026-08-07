---
title: "Benchmarking Draco Decode on Mobile GPUs"
description: "Measure Draco decode and GPU upload on real phones, separate the WASM decode from the driver upload, and pick quantization bits from a device-class budget."
---
# Benchmarking Draco Decode on Mobile GPUs

This page measures what a Draco-compressed tile actually costs on a phone — the WASM decode on the CPU, the buffer upload to the GPU, and the first draw — and turns those numbers into a quantization and compression-level choice per device class. The measurement matters because mobile is where the frame budget is tightest and where desktop intuitions are most wrong: a tile that decodes in 4 ms on a laptop routinely takes 30 ms on a mid-range Android device, which is two frames gone before anything is drawn.

## Why you hit this

Compression settings are almost always chosen on a workstation, where decode is nearly free and download is the only visible cost. On a phone the balance inverts: the network is often better than expected and the CPU is much worse, so a setting tuned for bytes produces a client that stutters on exactly the devices most viewers use. Nothing in the tileset reports this, and the desktop numbers are all reassuring.

The compression choices this feeds back into are in [glTF LOD generation with Draco compression](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/) and [tuning Draco quantization](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/).

## Prerequisites

- Real devices, or at minimum Chrome's device emulation with CPU throttling set to 4× or 6×. Emulation is a rough proxy for CPU and says nothing about the GPU driver.
- Remote debugging: `chrome://inspect` for Android, Safari's Web Inspector for iOS.
- A set of test tiles encoded at several quantization and compression settings from the same source mesh.
- `EXT_disjoint_timer_query_webgl2` where available, for real GPU timings rather than submission times.

## Step-by-Step

### 1. Time the decode in isolation

Decode the same buffer repeatedly without touching the GPU, so the number is purely the WASM cost.

```javascript
async function benchDecode(url, rounds = 20) {
  const buf = await (await fetch(url)).arrayBuffer();
  const loader = new DracoLoader();          // whichever wrapper your client uses
  await loader.ready();

  // Warm up: the first call pays JIT and WASM instantiation.
  for (let i = 0; i < 3; i++) await loader.decode(buf.slice(0));

  const times = [];
  for (let i = 0; i < rounds; i++) {
    const copy = buf.slice(0);               // decode consumes the buffer
    const t0 = performance.now();
    await loader.decode(copy);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    bytes: buf.byteLength,
    p50: times[rounds >> 1],
    p95: times[Math.floor(rounds * 0.95)],
    min: times[0],
  };
}
```

Discarding the first few rounds is not optional. WASM instantiation and JIT warm-up dominate the first call by an order of magnitude, and including them makes every configuration look identical.

### 2. Time the GPU upload separately

Upload is a different cost with a different fix, and on mobile drivers it is frequently the larger of the two.

```javascript
function benchUpload(gl, positions, indices, rounds = 20) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const vb = gl.createBuffer();
    const ib = gl.createBuffer();
    const t0 = performance.now();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.finish();                              // force the driver to complete
    times.push(performance.now() - t0);
    gl.deleteBuffer(vb); gl.deleteBuffer(ib);
  }
  times.sort((a, b) => a - b);
  return { p50: times[rounds >> 1], p95: times[Math.floor(rounds * 0.95)] };
}
```

`gl.finish()` is what makes this a measurement rather than a submission timer. Without it you are timing how long it took to queue the command, which on a mobile driver is a small fraction of the real cost.

<figure class="diagram">
<svg viewBox="57 7 790 259" role="img" aria-labelledby="db-split-t db-split-d" xmlns="http://www.w3.org/2000/svg">
  <title id="db-split-t">The same tile on three device classes</title>
  <desc id="db-split-d">A tile that decodes in four milliseconds and uploads in one on a laptop takes eleven and four on a recent phone, and thirty-one and nine on a mid-range one. The download is comparable across all three, so the desktop measurement understates the mobile cost by roughly a factor of eight.</desc>
  <rect class="svg-bg" x="57" y="7" width="790" height="259" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="150" y="56" width="42" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="192" y="56" width="11" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="102" width="116" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="102" width="42" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="150" y="148" width="326" height="26" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="476" y="148" width="95" height="26" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <path d="M326 40 V196" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="326" y="34" fill="#b0413e" font-size="12" text-anchor="middle">one 60 fps frame</text>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="215" y="74">laptop — decode 4.1 ms, upload 1.0</text>
    <text x="320" y="120">recent phone — decode 11.3 ms, upload 4.1</text>
    <text x="583" y="166">mid-range phone — decode 31.4, upload 9.2</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">The download is within a few milliseconds on all three — the difference is entirely CPU and driver</text>
  <text x="380" y="248" fill="#5b6471" font-size="12" text-anchor="middle">Which is why a compression setting tuned for bytes on a workstation stutters on the devices most viewers use</text>
</svg>
<figcaption>Two frames gone before the tile is drawn, on hardware that is neither old nor unusual. The desktop measurement gives no warning of it.</figcaption>
</figure>

### 3. Sweep the settings that actually trade against each other

Compression level trades encode time and size; quantization bits trade size and precision. Only a sweep on-device shows which one your decode is sensitive to.

```javascript
const grid = [];
for (const level of [3, 7, 10]) {
  for (const bits of [11, 12, 14]) {
    const url = `/bench/block_l${level}_q${bits}.glb`;
    const d = await benchDecode(url);
    grid.push({ level, bits, kb: (d.bytes / 1024).toFixed(1),
                decode_p50: d.p50.toFixed(1), decode_p95: d.p95.toFixed(1) });
  }
}
console.table(grid);
```

The finding that recurs: decode time is far more sensitive to compression level than to quantization bits, because level controls how much entropy coding the decoder has to undo while bits mostly change the payload size. So on mobile the right move is usually to drop the level and keep the precision, which is the opposite of the desktop instinct.

### 4. Get real GPU timings where the extension exists

CPU-side timers measure submission. `EXT_disjoint_timer_query_webgl2` measures the GPU.

```javascript
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

function gpuTime(drawFn) {
  if (!ext) return Promise.resolve(null);
  const q = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
  drawFn();
  gl.endQuery(ext.TIME_ELAPSED_EXT);

  return new Promise((resolve) => {
    const poll = () => {
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (available && !disjoint) {
        resolve(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);   // ns → ms
        gl.deleteQuery(q);
      } else if (disjoint) {
        resolve(null);                     // the GPU was interrupted; discard
      } else {
        requestAnimationFrame(poll);
      }
    };
    requestAnimationFrame(poll);
  });
}
```

Discarding disjoint results matters. A thermal throttle or a context switch invalidates the query, and a benchmark that keeps those samples reports a bimodal distribution nobody can act on.

### 5. Turn the sweep into a per-device-class budget

The output of the exercise is a table your build pipeline can key on.

```javascript
const BUDGET_MS = 16.7;
const RESERVE = 0.4;                          // leave 40% of the frame for drawing

function pickSettings(measurements, deviceClass) {
  const allowed = BUDGET_MS * (1 - RESERVE);
  return measurements
    .filter((m) => m.device === deviceClass && m.decode_p95 + m.upload_p95 < allowed)
    .sort((a, b) => a.kb - b.kb)[0] || null;   // smallest that fits the budget
}

console.log('mid-range:', pickSettings(all, 'mid'));
console.log('flagship :', pickSettings(all, 'flagship'));
```

<figure class="diagram">
<svg viewBox="1 35 713 235" role="img" aria-labelledby="db-sweep-t db-sweep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="db-sweep-t">Decode time against compression level and quantization bits</title>
  <desc id="db-sweep-d">On a mid-range phone, raising the Draco compression level from three to ten roughly triples decode time while saving a few per cent of bytes. Raising quantization from eleven to fourteen bits changes decode time hardly at all. So the setting to relax on mobile is the level, not the precision.</desc>
  <rect class="svg-bg" x="1" y="35" width="713" height="235" fill="#ffffff"/>
  <path d="M70 50 V196 H660" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="120,176 260,150 400,112 540,68" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <polyline points="120,186 260,184 400,181 540,178" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <g fill="#b0413e">
    <circle cx="120" cy="176" r="4"/><circle cx="260" cy="150" r="4"/>
    <circle cx="400" cy="112" r="4"/><circle cx="540" cy="68" r="4"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="120" cy="186" r="4"/><circle cx="260" cy="184" r="4"/>
    <circle cx="400" cy="181" r="4"/><circle cx="540" cy="178" r="4"/>
  </g>
  <text x="556" y="62" fill="#b0413e" font-size="12" text-anchor="start">compression level 3 → 10</text>
  <text x="556" y="182" fill="#4f7a4d" font-size="12" text-anchor="start">quantization 11 → 14 bits</text>
  <text x="360" y="222" fill="#5b6471" font-size="12" text-anchor="middle">setting, from relaxed to aggressive</text>
  <text x="36" y="118" fill="#5b6471" font-size="12" text-anchor="middle">decode</text>
  <text x="36" y="134" fill="#5b6471" font-size="12" text-anchor="middle">ms</text>
  <text x="370" y="252" fill="#15384a" font-size="12.5" text-anchor="middle">Precision is nearly free at decode time; entropy coding is not. Spend the bits and relax the level.</text>
</svg>
<figcaption>The two knobs cost very differently at decode time, which inverts the usual desktop advice to push the compression level as high as it will go.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="22 13 696 247" role="img" aria-labelledby="db-warm-t db-warm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="db-warm-t">Why the first decodes have to be discarded</title>
  <desc id="db-warm-d">The first call pays WASM instantiation and just-in-time compilation, and takes several times the steady-state cost. The second and third are still elevated. From about the fourth the measurement stabilises, and only those rounds describe what a viewer experiences on a tile mid-session.</desc>
  <rect class="svg-bg" x="22" y="13" width="696" height="247" fill="#ffffff"/>
  <path d="M70 46 V190 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <polyline points="110,60 170,120 230,150 290,166 350,168 410,167 470,169 530,167 590,168 650,167"
            fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <g fill="#1f6b8a">
    <circle cx="110" cy="60" r="4"/><circle cx="170" cy="120" r="4"/><circle cx="230" cy="150" r="4"/>
    <circle cx="290" cy="166" r="4"/><circle cx="350" cy="168" r="4"/><circle cx="410" cy="167" r="4"/>
  </g>
  <path d="M260 46 V196" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="256" y="40" fill="#b0413e" font-size="12" text-anchor="end">discard everything left of here</text>
  <text x="470" y="150" fill="#4f7a4d" font-size="12" text-anchor="start">steady state — the number to report</text>
  <text x="375" y="218" fill="#5b6471" font-size="12" text-anchor="middle">decode round</text>
  <text x="370" y="242" fill="#15384a" font-size="12.5" text-anchor="middle">Include the first three and every configuration reports the same time, because instantiation dominates all of them</text>
</svg>
<figcaption>The warm-up is not noise to be averaged out — it is a different operation, and including it makes the whole sweep uninformative.</figcaption>
</figure>

## Expected Output & Verification

A representative sweep on a mid-range Android device:

```text
┌───────┬──────┬───────┬────────────┬────────────┐
│ level │ bits │  kB   │ decode_p50 │ decode_p95 │
├───────┼──────┼───────┼────────────┼────────────┤
│   3   │  11  │ 214.8 │    12.4    │    15.1    │
│   3   │  14  │ 246.1 │    12.9    │    15.8    │
│   7   │  11  │ 198.2 │    21.7    │    26.4    │
│   7   │  14  │ 228.7 │    22.3    │    27.1    │
│  10   │  14  │ 223.4 │    31.4    │    38.9    │
└───────┴──────┴───────┴────────────┴────────────┘
upload p50 9.2 ms | p95 12.6 ms
```

The decision falls straight out of it. Level 10 costs 31 ms of decode to save 5 kB against level 7 — worthless on this device. Level 3 at 14 bits costs 13 ms, keeps full precision, and is 10% larger than level 7. With a 10 ms budget for decode plus upload on a 60 fps target, only the level-3 rows fit at all.

Verify the numbers are real by checking three things: the warm-up rounds were discarded, the p95 is within about 25% of the p50 (a wider spread means thermal throttling and the device needs a cool-down between configurations), and the disjoint counter stayed at zero for any GPU timings.

## Common Errors

**Every configuration decodes in the same time.** The warm-up was not discarded, so all the measurements are dominated by WASM instantiation. Run three throwaway decodes first.

**Decode times climb steadily through the sweep.** The device is thermally throttling. Insert a pause between configurations and randomise their order, then check that the first and last measurement of the same configuration agree.

**Upload appears free.** `gl.finish()` was omitted, so the timer measured command submission. On a desktop driver the difference is small; on mobile it is most of the cost.

**Emulated throttling gives a different answer from a real device.** It will. CPU throttling in DevTools models the CPU only and nothing about the GPU driver, memory bandwidth or thermal behaviour. Use it for a first pass and confirm on hardware.

## Frequently Asked Questions

### Which devices should I test?
Two: the median device in your analytics and the tenth percentile. The flagship tells you nothing you need, and the very oldest device is usually out of scope. If you have no analytics, a three-year-old mid-range Android is a reasonable stand-in for the tenth percentile.

### Can I ship different tiles per device class?
Yes, by serving a different tileset alias to clients that report a low-power device, but it doubles the build and the storage. The usual better answer is to pick settings that fit the tenth-percentile budget and accept slightly larger tiles everywhere.

### Does meshopt compare better than Draco on mobile?
Frequently, yes — `EXT_meshopt_compression` decodes considerably faster for a modest size penalty, which is exactly the trade mobile wants. Benchmark it with the same harness before switching; the advantage varies with mesh topology.

A note on what these numbers are for. The output is not a single global setting but a budget per device class, and the budget is the thing worth writing down: how many milliseconds of the frame you are willing to spend on getting a tile onto the GPU, on the tenth-percentile device you intend to support. Once that number exists, every compression question answers itself by measurement, and the arguments about whether level 10 is worth it stop being arguments.

The second use is regression detection. Encoder versions change, WASM decoders get faster and occasionally slower, and a browser update can move decode cost by twenty per cent in either direction. Running this sweep on one device once per release, and storing the five headline numbers, turns that into something you notice rather than something a viewer reports.

## Related Guides

- [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/) — where device benchmarking fits
- [Tuning Draco Quantization for Building Meshes](https://www.3d-geospatial.com/lod-management-optimization-strategies/gltf-lod-generation-with-draco-compression/tuning-draco-quantization-for-building-meshes/) — choosing the bits these numbers justify
- [Measuring Tile Load Times in the Cesium Frame Loop](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/measuring-tile-load-times-in-the-cesium-frame-loop/) — the client-side budget this feeds

Back to [Performance Profiling and Benchmarking](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/performance-profiling-and-benchmarking/).
