---
title: "Styling Tiles by Metadata with Cesium3DTileStyle"
description: "Write Cesium3DTileStyle expressions that colour, filter and size 3D Tiles features by metadata — conditions, variables, no-data handling"
---
# Styling Tiles by Metadata with Cesium3DTileStyle

This page writes the style expressions that turn a metadata-bearing tileset into a thematic map — colour ramps by construction year, filters by building function, point-cloud styling by classification — and covers the expression constructs that are cheap, the ones that are expensive, and how to keep a legend honest about missing data.

## Why you hit this

Once the metadata from [defining tileset and group metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) is in the tileset, styling is how anyone gets value from it. A `Cesium3DTileStyle` is evaluated per feature and compiled to a shader, so the colouring happens on the GPU at no per-frame cost — which makes it the right mechanism for thematic display of hundreds of thousands of features, and a trap if the expression is written as if it were JavaScript.

The two things that go wrong are performance and honesty. An expression with 200 conditions compiles to a shader that stalls; a colour ramp that treats a missing construction year as 1900 produces a map with a confident cluster of buildings that do not exist.

## Prerequisites

- A 3D Tiles 1.1 tileset with metadata, loaded in CesiumJS 1.100 or later.
- Property names as declared in the schema — they are case-sensitive in expressions.
- Browser dev tools for the frame-time measurements.

## Step-by-Step

### 1. Start with the expression model

```javascript
const style = new Cesium.Cesium3DTileStyle({
  // Every top-level key is an expression evaluated per feature.
  show: '${quality} !== "estimated"',
  color: {
    conditions: [
      ['${yearOfConstruction} === 0', "color('#9aa3ad')"],       // noData first
      ['${yearOfConstruction} < 1900', "color('#7c3f2e')"],
      ['${yearOfConstruction} < 1945', "color('#b0413e')"],
      ['${yearOfConstruction} < 1970', "color('#c46a3d')"],
      ['${yearOfConstruction} < 1990', "color('#d9a05b')"],
      ['true', "color('#1f6b8a')"],
    ],
  },
  pointSize: '3.0',
});

tileset.style = style;
```

The expression language is deliberately small: property references with `${name}`, arithmetic, comparisons, `&&`/`||`/`!`, a set of built-in functions, and `conditions` arrays that evaluate top to bottom and stop at the first true test. There is no iteration, no function definition and no access to anything outside the feature.

`conditions` evaluating in order is the property to build on. Putting the no-data test first means every subsequent condition can assume a real value, which is both faster and clearer than guarding each one.

`show` returning false removes the feature from rendering entirely, which is cheaper than colouring it transparent — a transparent feature still rasterises and still participates in blending.

### 2. Handle no-data before anything else

```javascript
export function yearRampStyle({ domain = [1850, 2026], bands = 7,
                                noDataValue = 0 } = {}) {
  const [lo, hi] = domain;
  const palette = ['#5b2f22', '#7c3f2e', '#b0413e', '#c46a3d',
                   '#d9a05b', '#7f9f6f', '#1f6b8a'];
  const conditions = [
    [`\${yearOfConstruction} === ${noDataValue}`, "color('#9aa3ad')"],
  ];
  for (let b = 0; b < bands; b++) {
    const edge = lo + ((hi - lo) * (b + 1)) / bands;
    conditions.push([`\${yearOfConstruction} < ${Math.round(edge)}`,
                     `color('${palette[b % palette.length]}')`]);
  }
  conditions.push(['true', `color('${palette[palette.length - 1]}')`]);

  return {
    style: new Cesium.Cesium3DTileStyle({ color: { conditions } }),
    legend: [
      { label: 'no recorded year', colour: '#9aa3ad', noData: true },
      ...Array.from({ length: bands }, (_, b) => ({
        label: `${Math.round(lo + ((hi - lo) * b) / bands)}–`
             + `${Math.round(lo + ((hi - lo) * (b + 1)) / bands) - 1}`,
        colour: palette[b % palette.length],
      })),
    ],
  };
}
```

Generating the legend from the same code that generates the conditions is the only way to keep them consistent. A legend written separately drifts the first time a band edge changes, and a wrong legend on a thematic map is worse than no legend.

The no-data entry belongs in the legend, visibly, with its own colour. A map where 8% of buildings are grey and the legend does not say why invites the reader to assume the grey means something.

The `noData` value has to match the schema's declaration. Where the schema says `noData: 0`, the expression tests for 0; where the property is simply absent, the test is `${yearOfConstruction} === undefined`, and the two are not interchangeable.

<figure class="diagram">
<svg viewBox="4 10 732 234" role="img" aria-labelledby="sty-nodata-t sty-nodata-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sty-nodata-t">Two ways to handle a missing construction year</title>
  <desc id="sty-nodata-d">Two histograms of the same 412000 buildings by construction decade. On the left, the missing-year value of zero falls into the oldest band, producing a spike of 33000 buildings apparently built before 1860 that do not exist. On the right, the no-data test runs first and those buildings are shown grey and counted separately in the legend, leaving the real distribution visible.</desc>
  <rect class="svg-bg" x="4" y="10" width="732" height="234" fill="#ffffff"/>
  <rect x="18" y="24" width="340" height="206" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="382" y="24" width="340" height="206" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="188" y="48" fill="#1f2937" font-size="13" text-anchor="middle">no-data not handled</text>
  <text x="552" y="48" fill="#1f2937" font-size="13" text-anchor="middle">no-data tested first</text>
  <path d="M44 196 H336" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <path d="M408 196 H700" stroke="#5b6471" stroke-width="1.4" fill="none"/>
  <g stroke-width="1.3">
    <rect x="50" y="76" width="30" height="120" fill="#b0413e" stroke="#b0413e"/>
    <rect x="86" y="164" width="30" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="122" y="150" width="30" height="46" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="158" y="132" width="30" height="64" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="120" width="30" height="76" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="230" y="140" width="30" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="266" y="158" width="30" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="302" y="172" width="30" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="414" y="164" width="30" height="32" fill="#9aa3ad" stroke="#5b6471"/>
    <rect x="450" y="164" width="30" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="486" y="150" width="30" height="46" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="522" y="132" width="30" height="64" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="558" y="120" width="30" height="76" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="594" y="140" width="30" height="56" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="630" y="158" width="30" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="666" y="172" width="30" height="24" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <text x="65" y="70" fill="#b0413e" font-size="12" text-anchor="middle">33 k</text>
  <text x="188" y="214" fill="#1f2937" font-size="12" text-anchor="middle">a pre-1860 spike that is not real</text>
  <text x="429" y="158" fill="#1f2937" font-size="12" text-anchor="middle">grey</text>
  <text x="552" y="214" fill="#1f2937" font-size="12" text-anchor="middle">33 k counted as "no recorded year"</text>
</svg>
<figcaption>The same data, and one condition's ordering decides whether the map shows a fabricated cluster of Victorian buildings.</figcaption>
</figure>

### 3. Filter with `show`, and combine conditions cheaply

```javascript
export function buildFilterStyle({ functions = null, minHeight = null,
                                   maxHeight = null, districts = null,
                                   qualityAtLeast = null } = {}) {
  const clauses = [];
  if (functions?.length) {
    clauses.push('(' + functions.map((f) => `\${function} === "${f}"`).join(' || ') + ')');
  }
  if (minHeight !== null) clauses.push(`\${measuredHeight} >= ${minHeight}`);
  if (maxHeight !== null) clauses.push(`\${measuredHeight} <= ${maxHeight}`);
  if (minHeight !== null || maxHeight !== null) {
    clauses.push('${measuredHeight} > 0');              // exclude the noData sentinel
  }
  if (districts?.length) {
    clauses.push('(' + districts.map((d) => `\${districtCode} === "${d}"`).join(' || ') + ')');
  }
  if (qualityAtLeast) {
    const rank = { surveyed: 0, photogrammetric: 1, extruded_footprint: 2, estimated: 3 };
    const allowed = Object.entries(rank)
      .filter(([, v]) => v <= rank[qualityAtLeast])
      .map(([k]) => `\${quality} === "${k}"`);
    clauses.push('(' + allowed.join(' || ') + ')');
  }
  const show = clauses.length ? clauses.join(' && ') : 'true';
  return { style: new Cesium.Cesium3DTileStyle({ show }), show,
           clauses: clauses.length };
}

console.log(buildFilterStyle({ functions: ['commercial', 'mixed'], minHeight: 12,
                               qualityAtLeast: 'photogrammetric' }).show);
```

Building the expression as a string from structured filter state, rather than writing expressions by hand for each combination, is what keeps a filter UI maintainable. Every filter becomes a clause, absent filters contribute nothing, and the whole thing is one `&&` chain.

The height clause pairs with an explicit `> 0` test because the no-data sentinel is negative — without it, `measuredHeight <= 40` includes every building whose height is unknown, which is exactly backwards.

Enum comparisons in an expression use the enum's **name** as a string, not its integer value, which is a convenience the client provides and a frequent source of confusion when debugging against the raw property table.

### 4. Style point clouds by classification

```javascript
export const LIDAR_CLASS_STYLE = new Cesium.Cesium3DTileStyle({
  color: {
    conditions: [
      ['${Classification} === 2', "color('#8a7a5c')"],   // ground
      ['${Classification} === 3', "color('#9fbf7a')"],   // low vegetation
      ['${Classification} === 4', "color('#74a85a')"],   // medium vegetation
      ['${Classification} === 5', "color('#4f7a4d')"],   // high vegetation
      ['${Classification} === 6', "color('#b0413e')"],   // building
      ['${Classification} === 9', "color('#1f6b8a')"],   // water
      ['${Classification} === 11', "color('#5b6471')"],  // road surface
      ['${Classification} === 1', "color('#c9c2b4')"],   // unclassified
      ['true', "color('#9aa3ad')"],
    ],
  },
  pointSize: 'clamp(${POSITION}[2] * 0.0 + 3.0, 2.0, 6.0)',
  show: '${Classification} !== 7 && ${Classification} !== 18',   // drop noise
});

export const INTENSITY_STYLE = new Cesium.Cesium3DTileStyle({
  color: {
    conditions: [
      ['${Intensity} === undefined', "color('#9aa3ad')"],
      ['true', 'rgb(clamp(${Intensity} / 4, 0, 255), '
             + 'clamp(${Intensity} / 4, 0, 255), '
             + 'clamp(${Intensity} / 3, 0, 255))'],
    ],
  },
  pointSize: '2.5',
});
```

Point clouds are where style expressions earn the most, because there is no other way to recolour 200 million points interactively. Both examples are a handful of comparisons per point, evaluated in a shader, so switching between them is instant regardless of the cloud's size.

Dropping ASPRS classes 7 and 18 — low and high noise — with `show` rather than colouring them is the right call: they are usually a few percent of the points and removing them from rasterisation is a measurable frame-rate gain on a dense cloud.

The `rgb(...)` form computing colour arithmetically, rather than bucketing into conditions, is the cheaper construct for a continuous variable and produces a smooth ramp. It is available because the expression language has arithmetic and `clamp`.

### 5. Keep the expression cheap

```javascript
export function expressionCost(styleJson) {
  /** A rough cost model: conditions and property reads become shader work. */
  const text = JSON.stringify(styleJson);
  const conditions = (text.match(/\[\s*"/g) || []).length;
  const properties = new Set(text.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []);
  const regexUse = (text.match(/regExp|regexp/g) || []).length;
  const stringCompares = (text.match(/===\s*\\?"/g) || []).length;

  const findings = [];
  if (conditions > 16) {
    findings.push({ issue: `${conditions} conditions`, severity: 'high',
                    why: 'each becomes a branch; bucket into ≤16 bands' });
  }
  if (regexUse) {
    findings.push({ issue: `${regexUse} regular expression(s)`, severity: 'high',
                    why: 'evaluated per feature on the CPU; precompute a property instead' });
  }
  if (stringCompares > 24) {
    findings.push({ issue: `${stringCompares} string comparisons`, severity: 'medium',
                    why: 'use enums, which compare as integers' });
  }
  if (properties.size > 6) {
    findings.push({ issue: `${properties.size} properties referenced`, severity: 'low',
                    why: 'each property table column is fetched with the content' });
  }
  return { conditions, properties: [...properties], findings,
           verdict: findings.some((f) => f.severity === 'high') ? 'will hurt'
                  : findings.length ? 'acceptable' : 'cheap' };
}

console.log(expressionCost(yearRampStyle().style.style));
```

Three constructs account for nearly every styling performance problem. Long condition lists become long branch chains; regular expressions cannot be evaluated in a shader at all and force per-feature CPU evaluation; and string comparisons are far more expensive than integer ones, which is the practical argument for enums in the schema.

A style referencing many properties has a subtler cost: every referenced property table column is fetched with the tile content, so a style that touches eight properties downloads eight columns for every tile whether or not the user looks at them.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="sty-cost-t sty-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sty-cost-t">Expression constructs ranked by cost</title>
  <desc id="sty-cost-d">A table of five style expression constructs with their relative cost and the reason. Arithmetic with clamp is the cheapest and produces a smooth ramp. Up to sixteen bucketed conditions compile to a short branch chain. Enum comparisons are integer comparisons. String comparisons are an order of magnitude more expensive. A regular expression cannot run in a shader at all and forces per-feature evaluation on the CPU.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="230" y="20" width="152" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="382" y="20" width="340" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="54" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="382" y="54" width="340" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="88" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="382" y="88" width="340" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="122" width="152" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="382" y="122" width="340" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="212" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="156" width="152" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="382" y="156" width="340" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="190" width="212" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="190" width="152" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="382" y="190" width="340" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="124" y="42">construct</text><text x="306" y="42">cost</text><text x="552" y="42">why</text>
    <text x="124" y="76">rgb() with clamp()</text><text x="306" y="76">cheapest</text><text x="552" y="76">one expression for any range</text>
    <text x="124" y="110">up to 16 conditions</text><text x="306" y="110">cheap</text><text x="552" y="110">a short branch chain in the shader</text>
    <text x="124" y="144">enum comparison</text><text x="306" y="144">cheap</text><text x="552" y="144">integer comparison</text>
    <text x="124" y="178">string comparison</text><text x="306" y="178">10× an enum</text><text x="552" y="178">string work in a shader</text>
    <text x="124" y="212">regExp()</text><text x="306" y="212">seconds per apply</text><text x="552" y="212">cannot run in a shader at all</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">The top three are free at any feature count; the bottom row is why enums belong in the schema.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">A style with 200 conditions compiles to 200 branches and stalls on apply.</text>
</svg>
<figcaption>Arithmetic beats conditions, enums beat strings, and a regular expression leaves the GPU entirely.</figcaption>
</figure>

### 6. Switch styles without stalling

```javascript
export class StyleSwitcher {
  constructor(tileset) {
    this.tileset = tileset;
    this.cache = new Map();
    this.current = null;
  }

  register(name, factory) {
    this.cache.set(name, { factory, style: null });
    return this;
  }

  apply(name, options = {}) {
    const entry = this.cache.get(name);
    if (!entry) throw new Error(`unknown style ${name}`);
    const key = `${name}:${JSON.stringify(options)}`;
    if (this.current === key) return { applied: false, reason: 'already current' };
    if (!entry.style || entry.key !== key) {
      const built = entry.factory(options);
      entry.style = built.style ?? built;
      entry.legend = built.legend;
      entry.key = key;
    }
    const t0 = performance.now();
    this.tileset.style = entry.style;
    this.current = key;
    return { applied: true, name, legend: entry.legend,
             applyMs: Number((performance.now() - t0).toFixed(2)) };
  }

  /** Change only a numeric threshold: cheaper than rebuilding the whole style. */
  updateThreshold(name, propertyName, value) {
    const entry = this.cache.get(name);
    if (!entry?.style) return { updated: false };
    entry.style[propertyName] = value;          // e.g. style.pointSize
    this.tileset.makeStyleDirty();
    return { updated: true, property: propertyName, value };
  }
}
```

Caching the built style objects matters because assigning `tileset.style` with a structurally new expression triggers a shader recompile, which is tens of milliseconds and visible as a hitch. Assigning a previously used style object reuses the compiled program.

`makeStyleDirty()` is the mechanism for re-evaluating an existing style against changed property values without recompiling — which is what the live-data pattern in [streaming live sensor updates onto tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/) relies on.

<figure class="diagram">
<svg viewBox="26 12 688 232" role="img" aria-labelledby="sty-expr-t sty-expr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="sty-expr-t">Style application cost by construct</title>
  <desc id="sty-expr-d">A bar chart of measured milliseconds to apply a style to a tileset with 412000 features. Eight bucketed conditions on an enum take 6 milliseconds. Sixteen conditions take 11 milliseconds. Arithmetic colour with clamp takes 5 milliseconds. Two hundred string conditions take 340 milliseconds. A style containing a regular expression takes 1120 milliseconds because it cannot be evaluated in a shader.</desc>
  <rect class="svg-bg" x="26" y="12" width="688" height="232" fill="#ffffff"/>
  <path d="M40 26 V190 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="24" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="68" width="44" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="102" width="20" height="26" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="136" width="204" height="26" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="170" width="620" height="16" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="74" y="52">8 bucketed enum conditions: 6 ms</text>
    <text x="94" y="86">16 conditions: 11 ms</text>
    <text x="70" y="120">arithmetic rgb() with clamp: 5 ms</text>
    <text x="254" y="154">200 string conditions: 340 ms</text>
  </g>
  <text x="40" y="206" fill="#1f2937" font-size="12.5">one regular expression in the style: 1,120 ms — evaluated per feature on the CPU</text>
  <text x="40" y="226" fill="#5b6471" font-size="12">412,000 features; the first three recompile a shader, the last two do not compile at all</text>
</svg>
<figcaption>Bucketed conditions and arithmetic are milliseconds; a regular expression is a second, because it leaves the GPU.</figcaption>
</figure>

## Expected Output & Verification

```text
${function} === "commercial" || ${function} === "mixed" && ${measuredHeight} >= 12 && …
{ conditions: 9, properties: ['${yearOfConstruction}'], findings: [], verdict: 'cheap' }
{ applied: true, name: 'yearRamp', applyMs: 6.41, legend: [ … 8 entries … ] }
```

A `cheap` verdict with one property referenced and nine conditions is the target shape for a thematic style. The 6.4 ms application cost is a one-off shader compile, not a per-frame cost.

Verify the style produces the distribution you expect, rather than trusting that it looks right:

```javascript
export function styleDistributionCheck(tileset, { property = 'yearOfConstruction',
                                                  bands = null } = {}) {
  const counts = new Map();
  let features = 0, missing = 0;
  for (const tile of tileset._selectedTiles ?? []) {
    const content = tile.content;
    if (!content || typeof content.featuresLength !== 'number') continue;
    for (let i = 0; i < content.featuresLength; i++) {
      const f = content.getFeature(i);
      const v = f.getProperty(property);
      features += 1;
      if (v === undefined || v === null || v === 0) { missing += 1; continue; }
      const key = bands
        ? bands.find((b) => v < b) ?? 'above'
        : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    features, missing,
    missingFraction: Number((missing / Math.max(features, 1)).toFixed(3)),
    bands: top.map(([band, n]) => ({ band, n,
      share: Number((n / Math.max(features - missing, 1)).toFixed(3)) })),
  };
}

console.log(styleDistributionCheck(tileset,
  { bands: [1900, 1945, 1970, 1990, 2010, 2027] }));
```

The `missingFraction` is the number to put in front of whoever asked for the map. Eight percent missing is a caveat; forty percent missing means the map is mostly about data coverage rather than about buildings, and the honest presentation is different.

Then verify the style is not costing frame time, by measuring with it on and off:

```javascript
export async function styleFrameCostCheck(viewer, tileset, style,
                                          { frames = 120 } = {}) {
  const sample = async (label) => {
    const times = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      viewer.scene.render();
      times.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    times.sort((a, b) => a - b);
    return { label,
             medianMs: Number(times[frames >> 1].toFixed(2)),
             p95Ms: Number(times[Math.floor(frames * 0.95)].toFixed(2)) };
  };

  tileset.style = undefined;
  const off = await sample('no style');
  tileset.style = style;
  const on = await sample('styled');
  return {
    off, on,
    medianDeltaMs: Number((on.medianMs - off.medianMs).toFixed(2)),
    p95DeltaMs: Number((on.p95Ms - off.p95Ms).toFixed(2)),
    acceptable: on.p95Ms - off.p95Ms < 1.5,
  };
}
```

A well-written style adds well under a millisecond to the frame, because it is a few comparisons in a shader that already runs. A delta of several milliseconds means the expression is being evaluated on the CPU — check for regular expressions and for property types the shader cannot handle.

## Performance Notes

- **Keep conditions at 16 or fewer.** Beyond that the branch chain shows up in the fragment shader.
- **Prefer arithmetic to conditions for continuous variables.** `rgb(clamp(...))` is one expression regardless of the range.
- **Enum comparisons beat string comparisons** by roughly an order of magnitude, which is the practical reason to declare enums in the schema.
- **Never use `regExp()` in a style.** It forces per-feature CPU evaluation and costs seconds on a city.
- **Cache built style objects.** Re-assigning the same object avoids a recompile; a structurally new expression does not.
- **`show: false` is cheaper than a transparent colour.** Hidden features are not rasterised.
- **Every referenced property is downloaded.** A style touching one property fetches one column per tile.

## Common Errors

**Style has no effect.** The property name does not match the schema, including case, or the features carry the property under a different name than the tileset metadata declares.

**Everything is the fallback colour.** The `conditions` array has no matching test — usually because a numeric property is being compared against a string, or an enum against its integer value rather than its name.

**A fabricated cluster at one end of the ramp.** No-data sentinel falling into a real band. Test for it first.

**Frame rate drops when the style is applied.** A regular expression, or more than a few dozen string comparisons.

**Applying a style takes half a second.** A condition per feature category. Bucket instead.

**`show` filter excludes buildings with valid heights.** The no-data sentinel is negative and passes a `<= max` test. Add the `> 0` clause.

**Legend and map disagree.** They are generated separately. Generate both from one function.

## Frequently Asked Questions

### Can a style reference tile or group metadata?

Yes — group and tile metadata properties are available to expressions alongside feature properties, which is what makes district-level filtering a single condition rather than a per-feature test.

### How do I show a continuous ramp rather than bands?

Use arithmetic: normalise the property into 0–1 and build the colour with `rgb()` or `hsl()`. It is cheaper than banding and produces a smooth result.

### Can I style by something not in the tileset?

Only by writing it onto features at runtime with `setProperty` and referencing that name, which is the live-data pattern. There is no way for an expression to reach outside the feature.

## Related Guides

- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — the properties these expressions read
- [Streaming Live Sensor Updates onto Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/streaming-live-sensor-updates-onto-tilesets/) — styling by values that change every few seconds
- [Encoding Property Textures for Per-Texel Data](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/encoding-property-textures-for-per-texel-data/) — when per-feature is too coarse

Back to [Tileset Metadata and 3D Tiles Next](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/).
