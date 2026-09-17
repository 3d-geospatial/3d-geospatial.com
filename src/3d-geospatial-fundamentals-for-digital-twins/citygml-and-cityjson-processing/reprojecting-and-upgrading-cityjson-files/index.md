---
title: "Reprojecting and Upgrading CityJSON Files"
description: "Move CityJSON models between CRSs and versions safely: upgrade to 2.0, assign a compound CRS, reproject with cjio"
---
# Reprojecting and Upgrading CityJSON Files

This page moves CityJSON city models between coordinate reference systems and between format versions without losing precision or heights — upgrading an older file to CityJSON 2.0, assigning a compound CRS so the vertical datum is explicit, reprojecting from EPSG:25832+7837 to the twin's frame, choosing an appropriate `transform` scale for the target units, and verifying the result against control points.

## Why you hit this

City models arrive in the CRS of the agency that made them and in whatever CityJSON version was current when the pipeline that produced them was written. A twin has one internal frame, so every delivery needs a conversion, and two things go wrong reliably. Heights get treated as ellipsoidal when they are orthometric, which sinks or lifts a whole city by the geoid separation. And the integer vertex grid, which was millimetres in a metric CRS, becomes something absurd after a change of units — a millimetre scale in degrees is a grid 100 m across. Both are silent: the file stays valid, the buildings stay where they look right on a flat map, and the error shows up when the model is draped on terrain. The data model is described in [CityGML and CityJSON processing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).

## Prerequisites

- Python 3.10+ with `cjio>=0.9`, `pyproj>=3.6` on PROJ 9.3+, `numpy>=1.24`.
- The geoid grid for the source heights available to PROJ — `de_bkg_gcg2016.tif` for DHHN2016 in the examples — either through `PROJ_NETWORK=ON` or a local copy.
- A few control points on the model with known coordinates in both the source and target CRS, for the verification step.

## Step-by-Step

### 1. Read the version and CRS before anything else

```python
import json
from pathlib import Path

src = Path("delivery/lod2_tile_11.city.json")
cj = json.loads(src.read_text())
print("version:", cj["version"])
print("referenceSystem:", cj.get("metadata", {}).get("referenceSystem"))
print("transform:", cj.get("transform"))
print("extent:", cj.get("metadata", {}).get("geographicalExtent"))
```

Three answers decide the work. The version decides whether an upgrade comes first. The reference system decides whether a vertical datum has to be assigned. The transform's scale decides how much precision the integers can carry, and it has to be revisited after any change of units.

<figure class="diagram">
<svg viewBox="6 6 748 216" role="img" aria-labelledby="cjup-ver-t cjup-ver-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjup-ver-t">What changes between CityJSON versions</title>
  <desc id="cjup-ver-d">A table of versions. In 1.0 the transform was optional and the reference system was written as an EPSG string, with a large metadata block. In 1.1 the transform became mandatory, the reference system moved to an OGC definition URL, and metadata was simplified. In 2.0 the line-delimited CityJSONSeq form and further object types arrived, with extensions handled by URL.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="216" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="120" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="140" y="20" width="300" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="440" y="20" width="300" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="120" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="140" y="58" width="300" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="440" y="58" width="300" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="108" width="120" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="140" y="108" width="300" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="108" width="300" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="158" width="120" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="140" y="158" width="300" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="440" y="158" width="300" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="80" y="44">version</text>
    <text x="290" y="44">coordinates and CRS</text>
    <text x="590" y="44">structure</text>
    <text x="80" y="88">1.0</text>
    <text x="290" y="80">transform optional, floats allowed</text>
    <text x="290" y="98">CRS as "EPSG:25832"</text>
    <text x="590" y="88">large metadata block</text>
    <text x="80" y="138">1.1</text>
    <text x="290" y="130">transform mandatory, integers</text>
    <text x="590" y="130">metadata simplified,</text>
    <text x="590" y="148">extended metadata separated</text>
    <text x="290" y="148">CRS as an OGC definition URL</text>
    <text x="80" y="188">2.0</text>
    <text x="290" y="180">unchanged from 1.1</text>
    <text x="590" y="180">CityJSONSeq (.city.jsonl),</text>
    <text x="590" y="198">more object types</text>
  </g>
</svg>
<figcaption>The jump that affects code is 1.0 to 1.1: coordinates become integers behind a mandatory transform, and the CRS string becomes a URL.</figcaption>
</figure>

### 2. Upgrade to the current version

```python
import subprocess

subprocess.run([
    "cjio", str(src),
    "upgrade",
    "save", "work/tile_11_v2.city.json",
], check=True)

up = json.loads(Path("work/tile_11_v2.city.json").read_text())
print("version:", up["version"], "| transform present:", "transform" in up,
      "| CRS:", up.get("metadata", {}).get("referenceSystem"))
```

`upgrade` rewrites the file to the version the installed `cjio` targets: it adds a `transform` and quantises float coordinates if the source was 1.0, converts the reference system to URL form, and moves metadata fields that no longer exist in the current schema. Upgrade before reprojecting, so the reprojection operates on one known structure, and keep the original — upgrading is not reversible without information loss in the metadata.

### 3. Make the vertical datum explicit

```python
NEEDS_VERTICAL = {"25832": "7837", "32618": "5703", "28992": "5709"}   # horizontal → vertical EPSG

crs = up["metadata"]["referenceSystem"]
code = crs.rstrip("/").split("/")[-1]
if code in NEEDS_VERTICAL:
    compound = f"{code}+{NEEDS_VERTICAL[code]}"
    subprocess.run([
        "cjio", "work/tile_11_v2.city.json",
        "crs_assign", compound,
        "save", "work/tile_11_compound.city.json",
    ], check=True)
    print("assigned", compound)
```

`crs_assign` changes the declared CRS without touching a single coordinate, which is exactly right here: the heights were always DHHN2016, the file simply failed to say so. Assigning is a statement about what the data already is, and it must come from the delivery documentation rather than a guess. Reprojecting a file whose CRS is only horizontal treats its heights as ellipsoidal, and in Bavaria that is a 47 m error in every building.

The distinction is worth stating plainly, because the two commands look similar and do opposite things. `crs_assign` relabels; `crs_reproject` transforms. Using assign when you meant reproject leaves the geometry in the old frame with a new label — the worst outcome, because everything downstream now trusts a wrong declaration.

<figure class="diagram">
<svg viewBox="6 6 748 204" role="img" aria-labelledby="cjup-ar-t cjup-ar-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjup-ar-t">crs_assign against crs_reproject</title>
  <desc id="cjup-ar-d">Two paths from the same file. crs_assign leaves every vertex unchanged and only rewrites the declared reference system, which is correct when the declaration was incomplete or missing. crs_reproject transforms every vertex through PROJ and rewrites both the vertices and the declaration, which is what moving between frames requires.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="204" fill="#ffffff"/>
  <defs>
    <marker id="cjup-ar-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="80" width="140" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="280" y="20" width="200" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="280" y="140" width="200" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="560" y="20" width="180" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="560" y="140" width="180" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cjup-ar-arrow)">
    <path d="M160 96 L278 56"/>
    <path d="M160 120 L278 162"/>
    <path d="M480 48 H558"/>
    <path d="M480 168 H558"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="90" y="104">tile_11</text><text x="90" y="122">CRS: 25832</text>
    <text x="380" y="42">crs_assign 25832+7837</text><text x="380" y="62">vertices untouched</text>
    <text x="380" y="162">crs_reproject 4978</text><text x="380" y="182">every vertex through PROJ</text>
    <text x="650" y="42">same geometry,</text><text x="650" y="62">honest declaration</text>
    <text x="650" y="162">new geometry,</text><text x="650" y="182">new declaration</text>
  </g>
</svg>
<figcaption>Assign fixes a declaration; reproject moves the data. Doing the first when you needed the second is undetectable inside the file.</figcaption>
</figure>

### 4. Reproject, then fix the transform scale

```python
subprocess.run([
    "cjio", "work/tile_11_compound.city.json",
    "crs_reproject", "4978",
    "save", "work/tile_11_ecef.city.json",
], check=True)

out = json.loads(Path("work/tile_11_ecef.city.json").read_text())
print("CRS:", out["metadata"]["referenceSystem"], "| scale:", out["transform"]["scale"])
```

After reprojection the target units decide whether the existing scale is still sensible. The rule is one line of arithmetic: the grid spacing is `scale`, in target units, so a scale of 0.001 is a millimetre grid in EPSG:4978 (metres) and roughly a 110 m grid in EPSG:4326 (degrees). If a pipeline must produce a geographic CityJSON, set the scale to 1e-9 or finer.

```python
def rescale_transform(path, new_scale, out_path):
    d = json.loads(Path(path).read_text())
    s_old, t_old = d["transform"]["scale"], d["transform"]["translate"]
    verts = [[v[i] * s_old[i] + t_old[i] for i in range(3)] for v in d["vertices"]]
    lo = [min(v[i] for v in verts) for i in range(3)]
    d["vertices"] = [[round((v[i] - lo[i]) / new_scale[i]) for i in range(3)] for v in verts]
    d["transform"] = {"scale": list(new_scale), "translate": lo}
    Path(out_path).write_text(json.dumps(d))
    return max(abs(verts[k][i] - (d["vertices"][k][i] * new_scale[i] + lo[i]))
               for k in range(len(verts)) for i in range(3))

err = rescale_transform("work/tile_11_ecef.city.json", (0.001, 0.001, 0.001),
                        "work/tile_11_ecef_mm.city.json")
print(f"worst coordinate change from rescaling: {err * 1000:.3f} mm")
```

Recomputing the translate from the data's own minimum keeps the integers small, which matters because JSON integers are text: a translate near the data means five-digit integers instead of ten-digit ones and a noticeably smaller file.

### 5. Update the extent and validate

```python
subprocess.run([
    "cjio", "work/tile_11_ecef_mm.city.json",
    "vertices_clean",
    "save", "out/tile_11_ready.city.json",
], check=True)
subprocess.run(["cjval", "out/tile_11_ready.city.json"], check=True)

ready = json.loads(Path("out/tile_11_ready.city.json").read_text())
print("extent:", [round(v, 2) for v in ready["metadata"]["geographicalExtent"]])
```

`cjval` catches a mismatch between the declared extent and the vertices, which is the usual leftover after manual transform surgery. The details of what else it checks are in [validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/).

### 6. Verify against control points

```python
import numpy as np
from pyproj import Transformer

# A surveyed corner, in the source compound CRS and independently in the target frame
control_src = np.array([691204.412, 5335818.221, 519.31])
tf = Transformer.from_crs("EPSG:25832+7837", "EPSG:4978", always_xy=True)
expected = np.array(tf.transform(*control_src))

d = json.loads(Path("out/tile_11_ready.city.json").read_text())
V = (np.asarray(d["vertices"], dtype=np.float64) * np.asarray(d["transform"]["scale"])
     + np.asarray(d["transform"]["translate"]))
nearest = V[np.argmin(np.linalg.norm(V - expected, axis=1))]
print("residual (mm):", ((nearest - expected) * 1000).round(1))
assert np.linalg.norm(nearest - expected) < 0.05
```

Comparing against a transformation you computed separately with `pyproj` is what makes this a test rather than a tautology. A residual of tens of metres means the vertical datum was not applied; a residual of a few metres means the horizontal CRS was mislabelled; a residual of a few millimetres is the quantisation grid and is expected.

## Expected Output & Verification

```text
version: 1.1
referenceSystem: https://www.opengis.net/def/crs/EPSG/0/25832
transform: {'scale': [0.001, 0.001, 0.001], 'translate': [691000.0, 5335000.0, 310.0]}
version: 2.0 | transform present: True | CRS: https://www.opengis.net/def/crs/EPSG/0/25832
assigned 25832+7837
CRS: https://www.opengis.net/def/crs/EPSG/0/4978 | scale: [0.001, 0.001, 0.001]
worst coordinate change from rescaling: 0.500 mm
extent: [4176533.41, 833224.58, 4726108.2, 4177298.77, 833951.02, 4726699.63]
residual (mm): [ 0.4 -0.3  0.5]
```

An ECEF extent with values in the millions on all three axes is the signature of a correct reprojection; an extent that still shows 691,000 and 5,335,000 means `crs_reproject` did not run or was given the same CRS it already had.

<figure class="diagram">
<svg viewBox="6 6 748 208" role="img" aria-labelledby="cjup-prec-t cjup-prec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjup-prec-t">Transform scale and the resulting grid in different target CRSs</title>
  <desc id="cjup-prec-d">A table of transform scale values against the grid they produce. A scale of one thousandth gives a millimetre grid in a metric projected CRS and in Earth-centred coordinates, but about a 110 metre grid in degrees. A scale of one billionth gives about a tenth of a millimetre in degrees and sub-nanometre precision, with larger integers, in metric systems.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="208" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="160" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="180" y="20" width="190" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="370" y="20" width="180" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="550" y="20" width="190" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="58" width="160" height="46" fill="#ffffff" stroke="#5b6471"/>
    <rect x="180" y="58" width="190" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="370" y="58" width="180" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="550" y="58" width="190" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="104" width="160" height="46" fill="#ffffff" stroke="#5b6471"/>
    <rect x="180" y="104" width="190" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="370" y="104" width="180" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="550" y="104" width="190" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="100" y="44">scale</text>
    <text x="275" y="44">projected, metres</text>
    <text x="460" y="44">EPSG:4978, metres</text>
    <text x="645" y="44">EPSG:4326, degrees</text>
    <text x="100" y="86">0.001</text><text x="275" y="86">1 mm</text><text x="460" y="86">1 mm</text><text x="645" y="86">≈ 110 m</text>
    <text x="100" y="132">1e-9</text><text x="275" y="132">1 nm, long integers</text><text x="460" y="132">1 nm, long integers</text><text x="645" y="132">≈ 0.1 mm</text>
  </g>
  <text x="380" y="196" fill="#15384a" font-size="12.5" text-anchor="middle">Choose the scale from the target CRS units, then let the translate keep the integers short.</text>
</svg>
<figcaption>One scale cannot serve both metric and angular targets. Reprojection is the moment to reconsider it.</figcaption>
</figure>

## Performance Notes

- **Reprojection cost is per vertex and PROJ is fast**; the JSON parse and write dominate. A 40 MB tile with 1.8 million vertices takes seconds, so tiling the work by delivery tile is enough parallelism.
- **Quantisation is the only lossy step.** Doing it once, at the end, keeps the total error at half a grid cell; rescaling twice doubles it.
- **Batch tiles with one process per tile** and assert the CRS of each output, because a mixed-CRS collection of tiles is far harder to notice later than a failure now.
- **Cache the geoid grid locally** in CI. Network grid access adds a round trip per transformation batch, and a CI runner without network grids silently falls back to a ballpark vertical transformation.

## Common Errors

**Every building is 40–50 m out vertically.** The source CRS was horizontal-only when `crs_reproject` ran. Assign the compound code first; the underlying theory is in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/).

**The model collapses to a handful of distinct coordinates.** A millimetre scale survived a reprojection into degrees. Rescale the transform as in step 4.

**`cjio` reports the CRS cannot be found.** The EPSG code was passed with a prefix (`EPSG:4978`) where the operator expects the bare code, or the compound code is not in the PROJ database for the installed version. Try `projinfo` on the same code to confirm PROJ knows it.

**`upgrade` drops metadata fields.** Several 1.0 metadata members do not exist in 1.1 and later. Copy anything you need into `+metadata-extended` or into your own sidecar before upgrading.

## Frequently Asked Questions

### Should city models be stored in ECEF?

No. Keep the semantic source in a projected compound CRS, where areas and heights are directly meaningful, and convert to EPSG:4978 only as part of producing tiles for a viewer.

### Is it safe to reproject twice?

Geometrically yes, but each pass quantises. If a pipeline needs both a projected and an ECEF product, generate both from the original rather than chaining one from the other.

### Can I reproject a CityJSONSeq file?

Not with the operators above, which load a whole model. Process the features line by line with `pyproj` in a small script, keeping each feature's own transform consistent, or reproject the CityJSON before exporting to JSONL.

## Related Guides

- [Validating CityJSON with cjval](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/validating-cityjson-with-cjval/) — the check after every transformation
- [Reading and Filtering CityJSON with cjio](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reading-and-filtering-cityjson-with-cjio/) — subsetting before reprojecting
- [Transforming Between Epoch-Based Datums](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/transforming-between-epoch-based-datums/) — when the source and target realisations differ in time

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
