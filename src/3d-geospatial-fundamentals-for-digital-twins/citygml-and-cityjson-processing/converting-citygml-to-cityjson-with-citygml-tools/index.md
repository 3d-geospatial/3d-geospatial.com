---
title: "Converting CityGML to CityJSON with citygml-tools"
description: "Convert CityGML city models to CityJSON without losing semantics: validate first, read the stats, set vertex precision"
---
# Converting CityGML to CityJSON with citygml-tools

This page converts a CityGML 2.0 or 3.0 city model into CityJSON with `citygml-tools` — validating the XML first, reading the feature statistics so you know what should survive, choosing a vertex precision, keeping the coordinate reference system attached, and verifying the conversion by round-tripping back to CityGML and comparing.

## Why you hit this

CityGML is what mapping agencies publish and almost nothing can process comfortably. A single LOD2 tile of a national dataset is hundreds of megabytes of XML with GML geometry nested six levels deep, `xlink` references between features, and coordinates repeated as text for every surface that touches a vertex. CityJSON holds the same objects, semantics and attributes in a tenth of the space with an indexed vertex list, which is what makes the processing in [CityGML and CityJSON processing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/) practical. The conversion itself is one command; what needs care is proving nothing was dropped.

## Prerequisites

- **citygml-tools 2.x** on the `PATH`, with Java 17 or newer. It is a command-line launcher around the citygml4j library.
- Python 3.10+ with `numpy>=1.24` for the verification step; `cjval` for schema validation.
- A CityGML file whose `srsName` names a CRS — the example is a German LOD2 tile in EPSG:25832 with DHHN2016 heights, so the compound code is EPSG:25832+7837.
- Disk for both copies, and a JVM heap large enough for the input: set it through the `JAVA_OPTS` environment variable the launcher reads, for example `JAVA_OPTS=-Xmx12g`.

## Step-by-Step

### 1. Validate the CityGML before converting

```python
import subprocess
from pathlib import Path

src = Path("lod2_32691_5336_2_by.gml")

val = subprocess.run(["citygml-tools", "validate", str(src)], capture_output=True, text=True)
print(val.stdout[-800:])
if val.returncode != 0:
    raise SystemExit("CityGML is not schema-valid; fix the source before converting")
```

Conversion is not a validator. A CityGML file with a mistyped element name, a missing `gml:id` or a geometry that references a non-existent shared surface can convert into a CityJSON that is structurally fine and missing features. Validating first means any later discrepancy is the converter's doing, not the source's.

### 2. Read the statistics so you know what to expect

```python
stats = subprocess.run(["citygml-tools", "stats", str(src)], capture_output=True, text=True)
print(stats.stdout[-1200:])
```

`stats` lists feature types and their counts, the LODs present, whether appearances and generic attributes are used, and the CRS. Those numbers are the baseline for verification: 4,812 `Building` features with LOD2 geometry and 11,204 `BuildingPart` children should come out as the same counts in the CityJSON. Note in particular whether the file uses an Application Domain Extension — an ADE such as Energy or Utility Network — because that determines whether the conversion needs an extension mapping or will silently drop those properties.

<figure class="diagram">
<svg viewBox="6 6 748 250" role="img" aria-labelledby="c2c-map-t c2c-map-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-map-t">What maps to what in the conversion</title>
  <desc id="c2c-map-d">CityGML city object members become entries in the CityJSON CityObjects dictionary keyed by gml:id. GML geometry becomes indexed boundaries over a shared vertex list. Surface semantics become the semantics surfaces and values arrays. Generic attributes become plain attribute keys. Appearances become the appearance member. Application Domain Extension properties need a CityJSON Extension or they are dropped.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="250" fill="#ffffff"/>
  <defs>
    <marker id="c2c-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="66" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="112" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="158" width="250" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="204" width="250" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="490" y="20" width="250" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="66" width="250" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="112" width="250" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="158" width="250" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="204" width="250" height="38" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g stroke="#5b6471" stroke-width="1.5" fill="none" marker-end="url(#c2c-map-arrow)">
    <path d="M270 39 H488"/><path d="M270 85 H488"/><path d="M270 131 H488"/><path d="M270 177 H488"/><path d="M270 223 H488"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="145" y="44">cityObjectMember + gml:id</text>
    <text x="145" y="90">gml:Solid / MultiSurface</text>
    <text x="145" y="136">boundedBy surface types</text>
    <text x="145" y="182">genericAttribute, stringAttribute</text>
    <text x="145" y="228">ADE properties</text>
    <text x="615" y="44">CityObjects["id"]</text>
    <text x="615" y="90">boundaries + vertices</text>
    <text x="615" y="136">semantics.surfaces / values</text>
    <text x="615" y="182">attributes</text>
    <text x="615" y="228">Extension, or dropped</text>
  </g>
</svg>
<figcaption>Everything in the CityGML conceptual model has a home in CityJSON. Only domain extensions need a decision before conversion.</figcaption>
</figure>

### 3. Convert, with an explicit vertex precision

```python
out = Path("cityjson"); out.mkdir(exist_ok=True)

subprocess.run([
    "citygml-tools", "to-cityjson",
    "--vertex-precision=3",          # millimetre in a metric CRS
    str(src),
], check=True)

produced = src.with_suffix(".json")
target = out / (src.stem + ".city.json")
produced.replace(target)
print(f"CityGML {src.stat().st_size / 1e6:.1f} MB → CityJSON {target.stat().st_size / 1e6:.1f} MB")
```

Vertex precision is the one setting worth thinking about. It fixes the number of decimal places kept when coordinates are quantised into the integer vertex list, and it is expressed in the units of the file's CRS. Three decimals in EPSG:25832 is a millimetre grid, which is far finer than any LOD2 model's accuracy and costs nothing measurable in file size. The same value in a geographic CRS is a grid about 100 m across, which destroys the model — so check the CRS units before setting it. Options differ between citygml-tools versions; run `citygml-tools to-cityjson --help` to see what your build supports.

<figure class="diagram">
<svg viewBox="6 6 748 234" role="img" aria-labelledby="c2c-prec-t c2c-prec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-prec-t">Vertex precision against grid size in two kinds of CRS</title>
  <desc id="c2c-prec-d">A table of vertex precision values against the resulting coordinate grid. In a projected CRS in metres, two decimals give a centimetre grid, three give a millimetre grid and six give a micrometre grid. In a geographic CRS in degrees, two decimals give about 1.1 kilometres, three about 110 metres and six about 11 centimetres, so a model in degrees needs at least seven decimals.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="234" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="20" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="60" width="200" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="60" width="260" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="60" width="260" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="102" width="200" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="102" width="260" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="102" width="260" height="42" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="144" width="200" height="42" fill="#ffffff" stroke="#5b6471"/>
    <rect x="220" y="144" width="260" height="42" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="144" width="260" height="42" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="45">vertex precision</text>
    <text x="350" y="45">projected CRS, metres</text>
    <text x="610" y="45">geographic CRS, degrees</text>
    <text x="120" y="87">2</text><text x="350" y="87">1 cm grid</text><text x="610" y="87">≈ 1.1 km grid</text>
    <text x="120" y="129">3</text><text x="350" y="129">1 mm grid — use this</text><text x="610" y="129">≈ 110 m grid</text>
    <text x="120" y="171">6</text><text x="350" y="171">1 µm grid, larger file</text><text x="610" y="171">≈ 11 cm grid</text>
  </g>
  <text x="380" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">The same number means completely different things; read the CRS units first.</text>
</svg>
<figcaption>Precision is in CRS units, not metres. A city model in degrees needs seven decimals to keep centimetre geometry.</figcaption>
</figure>

### 4. Check the CRS survived

```python
import json

cj = json.loads(target.read_text())
crs = cj.get("metadata", {}).get("referenceSystem")
print("referenceSystem:", crs, "| transform:", cj["transform"])
if not crs:
    cj.setdefault("metadata", {})["referenceSystem"] = "https://www.opengis.net/def/crs/EPSG/0/25832"
    target.write_text(json.dumps(cj))
    print("CRS was missing and has been set explicitly — confirm it against the delivery note")
```

A CityGML file that declares its CRS only on an inner geometry, or uses a `srsName` the converter cannot resolve to an EPSG code, produces CityJSON with no `referenceSystem`. Everything downstream then guesses, and PROJ cannot reproject at all. Setting it by hand is legitimate when the delivery documentation states the CRS; inventing it is not. Where heights matter, set the compound code so the vertical datum is explicit.

### 5. Verify by round-tripping and comparing

```python
subprocess.run(["citygml-tools", "from-cityjson", str(target)], check=True)
back = target.with_suffix("").with_suffix(".gml")      # strips .city.json → .gml

before = subprocess.run(["citygml-tools", "stats", str(src)], capture_output=True, text=True).stdout
after = subprocess.run(["citygml-tools", "stats", str(back)], capture_output=True, text=True).stdout

import re
def counts(text):
    return {m.group(2): int(m.group(1)) for m in re.finditer(r"^\s*(\d+)\s+(\w+)\s*$", text, re.M)}

b, a = counts(before), counts(after)
for k in sorted(set(b) | set(a)):
    if b.get(k) != a.get(k):
        print(f"MISMATCH {k}: CityGML {b.get(k)} vs round-trip {a.get(k)}")
print("feature counts compared")
```

The round trip is the strongest cheap check available: convert to CityJSON, convert back, and compare feature statistics with the original. Identical counts per feature type mean no object was lost or invented. It does not prove geometry is identical, which is what the coordinate check below is for, and it will not flag an ADE property that both directions dropped — for that, compare an attribute key list from the source XML.

```python
import numpy as np

def cityjson_vertices(path):
    d = json.loads(Path(path).read_text())
    v = np.asarray(d["vertices"], dtype=np.float64)
    t = d["transform"]
    return v * np.asarray(t["scale"]) + np.asarray(t["translate"])

V = cityjson_vertices(target)
print("vertices:", len(V), "| bbox:", V.min(axis=0).round(2), V.max(axis=0).round(2))
assert V[:, 2].min() > -100 and V[:, 2].max() < 1000, "implausible heights: wrong CRS or unit"
```

## Expected Output & Verification

```text
lod2_32691_5336_2_by.gml is valid
Feature types: 4812 Building, 11204 BuildingPart, 1 CityModel
LODs: 2 | Appearances: yes | CRS: EPSG:25832
CityGML 486.2 MB → CityJSON 41.7 MB
referenceSystem: https://www.opengis.net/def/crs/EPSG/0/25832 | transform: {'scale': [0.001, 0.001, 0.001], 'translate': [691000.0, 5335000.0, 310.0]}
feature counts compared
vertices: 1842119 | bbox: [691000.02 5335000.01  312.44] [691999.98 5335999.99  498.21]
```

A ten-to-one size reduction with identical feature counts is the normal result. Then run `cjval` on the output, because schema validity of the CityJSON is a separate question from validity of the CityGML, and the two validators check different things.

<figure class="diagram">
<svg viewBox="6 6 748 214" role="img" aria-labelledby="c2c-ver-t c2c-ver-d" xmlns="http://www.w3.org/2000/svg">
  <title id="c2c-ver-t">Three independent checks on a conversion</title>
  <desc id="c2c-ver-d">The CityGML source is validated against its schema. The conversion produces CityJSON, which is validated with cjval. A round trip back to CityGML gives feature counts that are compared with the source's counts. A separate coordinate check compares the bounding box and heights against expectations for the CRS.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="214" fill="#ffffff"/>
  <defs>
    <marker id="c2c-ver-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="80" width="130" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="220" y="80" width="140" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="20" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="430" y="88" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="430" y="156" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="640" y="88" width="100" height="50" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#c2c-ver-arrow)">
    <path d="M150 108 H218"/>
    <path d="M360 100 L428 54"/>
    <path d="M360 110 H428"/>
    <path d="M360 120 L428 172"/>
    <path d="M580 113 H638"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="85" y="104">CityGML</text><text x="85" y="122">validated</text>
    <text x="290" y="104">CityJSON</text><text x="290" y="122">converted</text>
    <text x="505" y="42">cjval: schema</text><text x="505" y="59">and structure</text>
    <text x="505" y="110">round trip:</text><text x="505" y="127">feature counts</text>
    <text x="505" y="178">coordinates:</text><text x="505" y="195">bbox and heights</text>
    <text x="690" y="110">accept</text><text x="690" y="127">or stop</text>
  </g>
</svg>
<figcaption>Each check can fail on its own: schema validity, object preservation and coordinate sanity are three different properties.</figcaption>
</figure>

## Performance Notes

Conversion is dominated by XML parsing, which is single-threaded and memory-hungry, so the useful levers are all about how much XML each invocation sees.

- **Convert tiles in parallel processes, not threads.** One JVM per tile with a heap sized for that tile finishes a 40-tile delivery in the time the largest tile takes, provided the machine has the memory; eight concurrent conversions at 12 GB each need a 96 GB machine, so size the pool by memory rather than by cores.
- **Expect roughly 1–3 minutes per 100 MB of CityGML** on current hardware, most of it parsing. The CityJSON write is a small fraction of that.
- **Keep the originals compressed.** CityGML compresses about 20:1 with `zstd`, and converters read from a decompressed stream fine, so an archive costs little.
- **Do the LOD filtering and subsetting afterwards, in CityJSON**, where both are index operations rather than XML tree surgery — see [reading and filtering CityJSON with cjio](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reading-and-filtering-cityjson-with-cjio/).

## Common Errors

**`java.lang.OutOfMemoryError: Java heap space`.** The whole model is held in memory during conversion. Raise the heap with `JAVA_OPTS=-Xmx16g`, or convert the delivery tile by tile — national datasets are almost always published as tiles for this reason.

**The CityJSON has no `referenceSystem`.** The source's `srsName` was absent or unresolvable, often a local URN such as `urn:adv:crs:ETRS89_UTM32*DE_DHHN2016_NH`. Map it to the EPSG compound code yourself, as step 4 does, using the delivery documentation.

**Buildings lose their heights and sit flat.** The CityGML used `srsDimension="2"` on geometry that carries three coordinates, or the heights were in a separate `gml:posList` the converter read as 2D. Check a single surface's coordinate count in the source XML before blaming the converter.

**Attributes from an extension disappear.** ADE properties have no place in plain CityJSON. Either accept the loss, having recorded it, or define a CityJSON Extension and convert with it — and check the output's `extensions` member to confirm it was applied.

## Frequently Asked Questions

### Is the conversion lossless?

For the core CityGML model — objects, hierarchy, attributes, geometry, semantics and appearances — yes, within the chosen vertex precision. It is not lossless for ADEs without an extension mapping, nor for XML-specific artefacts such as comments and element ordering.

### Should I convert or keep querying the CityGML?

Convert. Even XML-native tooling runs faster against CityJSON, and every Python library in a spatial pipeline reads JSON natively. Keep the CityGML as the archived delivery.

### Can I convert straight to CityJSONSeq for streaming?

Convert to CityJSON, then `cjio <file> export jsonl` for the line-delimited form. That keeps the schema validation step on a file `cjval` understands.

## Related Guides

- [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/) — the processing chain this feeds
- [Reading and Filtering CityJSON with cjio](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reading-and-filtering-cityjson-with-cjio/) — the next step
- [Validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/) — the gate on the output

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
