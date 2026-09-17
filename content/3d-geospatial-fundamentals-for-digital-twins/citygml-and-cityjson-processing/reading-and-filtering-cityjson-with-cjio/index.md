# Reading and Filtering CityJSON with cjio

This page subsets and cleans CityJSON city models with `cjio` — chaining operators on the command line, selecting objects by attribute in Python where the CLI has no filter, removing duplicate and orphan vertices, updating the metadata bounding box, and exporting the result as glTF for streaming or JSONL for streaming processing, all in EPSG:7415 (Amersfoort / RD New + NAP).

## Why you hit this

A national city model arrives as tiles of tens of thousands of buildings, and almost every job needs a slice of it: one district for a pilot, one construction year range for a heritage study, the fifty buildings around a site for a shadow analysis. Loading the whole tile into a viewer or a mesh pipeline to throw 95% of it away wastes hours across a project, and hand-editing JSON breaks the vertex indices. `cjio` is the tool that does these operations without corrupting the index structure; the parts it does not cover are a dozen lines of Python against the same file. The data model both rely on is described in [CityGML and CityJSON processing for digital twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).

## Prerequisites

- Python 3.10+ with `cjio>=0.9` (`pip install cjio`), `numpy>=1.24`.
- A CityJSON 1.1 or 2.0 file. The examples use a 3D BAG tile in EPSG:7415; `cjio <file> upgrade` brings a 1.1 file to 2.0 first.
- For glTF export, nothing extra; for JSONL, nothing extra. Both are built into `cjio`.

## Step-by-Step

### 1. See what is in the file

```python
import subprocess
from pathlib import Path

src = Path("9-284-556.city.json")
print(subprocess.run(["cjio", str(src), "info"], capture_output=True, text=True).stdout)
```

`info` reports the version, the CRS, the bounding box, the counts per city-object type, the LODs present and whether the file carries textures or materials. Read three things before anything else: the CRS, because every bounding box you pass later is in those units; the LODs, because a filter for an LOD that is not there yields an empty file; and the vertex count, which tells you whether this is a job for the command line or for streaming.

### 2. Chain operators on the command line

`cjio` applies operators left to right on one loaded model, so a whole pipeline is one command and the file is parsed once.

```python
subprocess.run([
    "cjio", str(src),
    "upgrade",                                   # 1.1 → 2.0 if needed
    "lod_filter", "2.2",
    "subset", "--bbox", "84000", "444000", "85000", "445000",
    "vertices_clean",
    "save", "district_lod22.city.json",
], check=True)
```

The order matters for both correctness and speed. `upgrade` first, so later operators see one schema version. `lod_filter` before `subset`, because dropping geometry is cheaper per object than testing containment. `vertices_clean` last, after everything that can orphan a vertex, so the shared array is trimmed once. `save` writes; without it, nothing is written and the work is discarded — which is the single most common surprise for people used to tools that edit in place.

<figure class="diagram">
<svg viewBox="6 16 748 216" role="img" aria-labelledby="cjio-chain-t cjio-chain-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjio-chain-t">One parse, many operators</title>
  <desc id="cjio-chain-d">A cjio command loads the file once into memory, then applies upgrade, level of detail filter, subset, vertex cleaning and save in sequence. Each operator transforms the in-memory model, and only save writes to disk. A separate diagram row shows the naive alternative of five separate commands, which parses and writes the file five times.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="216" fill="#ffffff"/>
  <defs>
    <marker id="cjio-chain-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="90" height="46" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="140" y="30" width="100" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="270" y="30" width="100" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="400" y="30" width="100" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="530" y="30" width="110" height="46" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="660" y="30" width="80" height="46" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cjio-chain-arrow)">
    <path d="M110 53 H138"/><path d="M240 53 H268"/><path d="M370 53 H398"/><path d="M500 53 H528"/><path d="M640 53 H658"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="58">load</text>
    <text x="190" y="58">upgrade</text>
    <text x="320" y="58">lod_filter</text>
    <text x="450" y="58">subset</text>
    <text x="585" y="58">vertices_clean</text>
    <text x="700" y="58">save</text>
  </g>
  <rect x="20" y="130" width="720" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <text x="380" y="150" fill="#1f2937" font-size="12.5" text-anchor="middle">five separate commands: parse, write, parse, write, parse, write, parse, write, parse, write</text>
  <text x="380" y="170" fill="#1f2937" font-size="12.5" text-anchor="middle">same result, several times the I/O, four intermediate files to clean up</text>
  <text x="380" y="214" fill="#15384a" font-size="12.5" text-anchor="middle">Only the final `save` touches the disk.</text>
</svg>
<figcaption>Operators compose in memory, so a long chain costs one parse and one write regardless of how many steps it has.</figcaption>
</figure>

### 3. Filter by attribute in Python

`cjio` subsets by bounding box, identifier, object type or a random sample. Attribute conditions — construction year, function, height above a threshold — belong in Python.

```python
from cjio import cityjson

cm = cityjson.load(str(src))
j = cm.j                                          # the raw CityJSON dictionary

def matches(obj):
    a = obj.get("attributes", {})
    year = a.get("oorspronkelijkbouwjaar") or a.get("yearOfConstruction")
    h = a.get("h_dak_50p") or a.get("measuredHeight")
    return obj["type"] == "Building" and year is not None and int(year) < 1945 and (h or 0) > 12.0

ids = [oid for oid, obj in j["CityObjects"].items() if matches(obj)]
print(f"{len(ids)} of {len(j['CityObjects'])} objects match")

subset = cm.get_subset_ids(ids)
cityjson.save(subset, "prewar_tall.city.json")
```

`get_subset_ids` keeps the matched objects *and* their children — building parts, installations — and rewrites the vertex list and every boundary index to match. That is the whole reason to use it rather than deleting dictionary entries: a hand-made subset that leaves the vertex array untouched is valid but enormous, and one that trims vertices without renumbering boundaries is corrupt in a way no viewer will explain.

Attribute names are dataset-specific. The 3D BAG uses Dutch keys such as `oorspronkelijkbouwjaar` and percentile roof heights such as `h_dak_50p`; a German LOD2 model uses `measuredHeight` and `function` with a code list. Print the attribute keys of one object before writing a filter.

### 4. Clean the geometry index and update the bounding box

```python
cm = cityjson.load("prewar_tall.city.json")
before = len(cm.j["vertices"])
cm.remove_duplicate_vertices()
cm.remove_orphan_vertices()
cm.update_bbox()
after = len(cm.j["vertices"])
print(f"vertices {before:,} → {after:,} ({100 * (1 - after / before):.1f}% removed)")
cityjson.save(cm, "prewar_tall_clean.city.json")
```

Duplicates arrive from conversion, where each GML surface repeated its corner coordinates as text and the converter kept them separate. Orphans arrive from every subset and LOD filter. Both are harmless to a viewer and expensive everywhere else: they inflate the file, they make vertex counts meaningless as a size proxy, and they stop adjacency from being computable, because two coincident vertices are not the same vertex. `update_bbox` matters because `metadata.geographicalExtent` is what a catalogue and many loaders read to place the file.

<figure class="diagram">
<svg viewBox="6 6 748 200" role="img" aria-labelledby="cjio-sub-t cjio-sub-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjio-sub-t">Ways to select a subset, and what each keeps</title>
  <desc id="cjio-sub-d">A table of subset methods. A bounding box keeps objects intersecting an extent in CRS units. Identifiers keep named objects and their children. An object type keeps one class such as Building or Road. A random sample keeps a percentage for testing. An attribute condition needs Python and then reuses the identifier route.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="200" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="230" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="250" y="20" width="490" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="56" width="490" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="90" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="90" width="490" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="124" width="230" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="250" y="124" width="490" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="158" width="230" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="250" y="158" width="490" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="135" y="43">selection</text>
    <text x="495" y="43">what it keeps</text>
    <text x="135" y="78">subset --bbox</text><text x="495" y="78">objects intersecting an extent, in the file's CRS units</text>
    <text x="135" y="112">subset --id</text><text x="495" y="112">named objects plus their children, indices renumbered</text>
    <text x="135" y="146">subset --cotype</text><text x="495" y="146">one class: Building, Road, SolitaryVegetationObject…</text>
    <text x="135" y="180">attribute condition</text><text x="495" y="180">Python filter → list of ids → get_subset_ids</text>
  </g>
</svg>
<figcaption>Every route ends in the same index rewrite, which is why they compose safely and hand-edited JSON does not.</figcaption>
</figure>

### 5. Export for the next stage

```python
subprocess.run(["cjio", "prewar_tall_clean.city.json", "export", "glb", "prewar_tall.glb"], check=True)
subprocess.run(["cjio", "prewar_tall_clean.city.json", "export", "jsonl", "prewar_tall.city.jsonl"], check=True)

for p in ("prewar_tall_clean.city.json", "prewar_tall.glb", "prewar_tall.city.jsonl"):
    print(f"{p:<34}{Path(p).stat().st_size / 1e6:8.2f} MB")
```

The glTF export triangulates every surface and merges the model into one binary, ready for [tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/); it keeps object identifiers as mesh names, which is how a click in a viewer gets back to the source object. The JSONL export writes one metadata line and one feature per line, each with its own vertices — the form to use when a later stage should process buildings one at a time without loading the district.

### 6. Verify the subset

```python
import json

full = json.loads(src.read_text())
sub = json.loads(Path("prewar_tall_clean.city.json").read_text())

assert set(sub["CityObjects"]) <= set(full["CityObjects"]) | {
    k for o in full["CityObjects"].values() for k in o.get("children", []) or []
}, "subset contains objects not in the source"
assert sub["metadata"]["referenceSystem"] == full["metadata"]["referenceSystem"], "CRS changed"

for oid, obj in sub["CityObjects"].items():
    if oid in full["CityObjects"]:
        assert obj.get("attributes") == full["CityObjects"][oid].get("attributes"), f"attributes changed for {oid}"
        assert all(g["lod"] == "2.2" for g in obj.get("geometry", [])), f"unexpected LOD in {oid}"
print(f"{len(sub['CityObjects'])} objects verified against the source")
```

## Expected Output & Verification

```text
CityJSON 2.0 | CRS https://www.opengis.net/def/crs/EPSG/0/7415
extent [84000.0, 444000.0, -2.4, 85000.0, 445000.0, 71.8]
Building 21804 | BuildingPart 24117 | LODs 1.2, 1.3, 2.2 | vertices 3,984,221
1912 of 45921 objects match
vertices 986,204 → 214,338 (78.3% removed)
prewar_tall_clean.city.json     12.44 MB
prewar_tall.glb                  9.81 MB
prewar_tall.city.jsonl          14.02 MB
1912 objects verified against the source
```

The 78% vertex reduction is typical after a subset and clean, and it is worth checking rather than assuming: a much smaller reduction means `vertices_clean` ran before the operators that orphaned vertices, and no reduction at all usually means the file was already clean and the duplicates you expected were never there.

<figure class="diagram">
<svg viewBox="26 16 628 208" role="img" aria-labelledby="cjio-vc-t cjio-vc-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cjio-vc-t">Vertex count through a subset pipeline</title>
  <desc id="cjio-vc-d">Bars show the vertex count at each stage. The source tile has 3.98 million vertices. After the level of detail filter the shared array is unchanged because vertices are still referenced. After the subset to matching buildings, 986 thousand vertices remain referenced but the array still holds orphans. Vertex cleaning brings it to 214 thousand.</desc>
  <rect class="svg-bg" x="26" y="16" width="628" height="208" fill="#ffffff"/>
  <path d="M40 20 V170" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="40" y="30" width="600" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="70" width="600" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="110" width="149" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="150" width="33" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="56" y="50">source tile · 3.98 M</text>
    <text x="56" y="90">after lod_filter · 3.98 M (still referenced)</text>
    <text x="201" y="130">after subset · 0.99 M in array</text>
    <text x="85" y="170">after vertices_clean · 0.21 M</text>
  </g>
  <text x="380" y="206" fill="#15384a" font-size="12.5" text-anchor="middle">Filtering geometry does not shrink the vertex array; only cleaning does.</text>
</svg>
<figcaption>The array keeps every vertex until something removes the unreferenced ones, so file size lags behind the subset by one step.</figcaption>
</figure>

## Common Errors

**The command runs and nothing changes on disk.** The chain had no `save`. `cjio` is functional: operators transform the loaded model and only `save` persists it.

**`subset --bbox` returns nothing.** The extent was given in the wrong CRS — degrees against a file in EPSG:7415, or a Dutch extent against a German tile. Print the file's extent from `info` and check the magnitudes match.

**`KeyError` on an attribute in the Python filter.** Attribute names vary per dataset and per object type; building parts often carry different keys from their parent. Use `.get()` with a fallback, as step 3 does, and test the filter on one object first.

**The exported glTF is at the origin or in the wrong place.** glTF has no CRS, so the export writes model coordinates directly. Record the CRS and the translation alongside the file, and re-centre and place the geometry when tiling — the mechanics are in [transforming IFC coordinates to ECEF for 3D Tiles](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/transforming-ifc-coordinates-to-ecef-for-3d-tiles/), which applies unchanged to city models.

## Frequently Asked Questions

### Should I use the CLI or the Python API?

The CLI for anything it covers, because a one-line chain in a build script is easier to review than equivalent Python. The API for attribute logic, for integration with the rest of a pipeline, and for anything where you need the raw dictionary in `cm.j`.

### Does subsetting break parent-child links?

`get_subset_ids` and `subset --id` keep children with their parents. A subset by bounding box can keep a building part whose parent's centre lies outside the box; check for `parents` entries that are not in the output and pull them in if a consumer needs the hierarchy.

### Can I keep a subset in sync with an updated source tile?

Yes, by keeping the filter rather than the output. Store the identifier list and the code that produced it, then re-run the subset when a new tile is published; identifiers in national datasets are stable, so a diff of the two identifier lists tells you which buildings entered or left the selection. Storing only the extracted file means the next update starts from scratch and nobody remembers which condition produced it.

### How large a file can cjio handle?

In memory, roughly what the JSON parses to — count on several times the file size in RAM. Above a few gigabytes, work per tile, or convert to JSONL and process feature by feature.

## Related Guides

- [Converting CityGML to CityJSON with citygml-tools](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/converting-citygml-to-cityjson-with-citygml-tools/) — producing the input
- [Extracting LOD2 Roof Surfaces from CityJSON](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/extracting-lod2-roof-surfaces-from-cityjson/) — using the semantics in the subset
- [Reprojecting and Upgrading CityJSON Files](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/reprojecting-and-upgrading-cityjson-files/) — CRS and version operators in detail

Back to [CityGML and CityJSON Processing for Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).
