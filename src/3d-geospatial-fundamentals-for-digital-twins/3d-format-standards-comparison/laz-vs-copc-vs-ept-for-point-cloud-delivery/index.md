---
title: "LAZ vs COPC vs EPT for Point Cloud Delivery"
description: "Choose between plain LAZ, Cloud-Optimized Point Cloud and Entwine Point Tiles: range requests, octree addressing, single-file vs directory, and what each costs to build."
---
# LAZ vs COPC vs EPT for Point Cloud Delivery

This page chooses between the three ways a point cloud gets delivered from object storage — plain **LAZ**, **COPC**, and **EPT** — on the axes that actually decide it: whether a client can read a spatial subset without downloading everything, whether the payload is one file or a directory of thousands, and what each costs to build and to keep current. All three hold the same points; they differ entirely in what a reader can do without reading it all.

## Why you hit this

A survey delivered as plain LAZ is a sealed box. Reading the points inside a 200 m radius means downloading the whole file, decompressing it, and discarding 99% of what you fetched — which is fine at 200 MB and untenable at 40 GB. Both COPC and EPT solve that, in different ways with different operational consequences, and the choice tends to be made by whichever tool the team already had rather than by what the access pattern needs.

The wider container landscape is mapped in [3D format standards comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/); this page is specifically about delivery over HTTP.

## Prerequisites

- PDAL 2.6+ (COPC reader and writer are built in), `untwine` or `entwine` for EPT, and `laspy>=2.5` with `lazrs`.
- Object storage that honours HTTP range requests. S3, GCS, Azure Blob and any standards-compliant CDN do; some older proxies do not, and COPC degrades to a full download when they do not.
- A cloud in a projected metric CRS with classification already applied — all three formats preserve whatever you give them and none of them improves it.

## Step-by-Step

### 1. Understand what each format actually is

**LAZ** is LASzip-compressed LAS: a header, variable-length records, then compressed point chunks. Chunks are independently decompressible, which is what makes partial reads *possible*, but nothing in the file says which chunk covers which ground, so finding the right chunk means reading them all.

**COPC** is a valid LAZ file with an octree baked into it. The points are reordered so that each octree node's points are contiguous, and a VLR holds the node hierarchy with each node's byte offset and length. A reader fetches the hierarchy with one range request, decides which nodes it needs, and fetches exactly those byte ranges. It is still one file, and any LAZ reader can open it and see all the points.

**EPT** is a directory: a JSON manifest plus one file per octree node, in LAZ or binary. A reader fetches the manifest, then the node files it needs, as ordinary whole-file GETs. No range-request support is required, and the node files can be served by anything.

<figure class="diagram">
<svg viewBox="10 28 724 204" role="img" aria-labelledby="pc-three-t pc-three-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pc-three-t">One file opaque, one file indexed, many files addressed</title>
  <desc id="pc-three-d">Plain LAZ is a single opaque file whose chunks cannot be located spatially. COPC is a single file with an octree index in a variable-length record, so a reader fetches the hierarchy and then the byte ranges it needs. EPT is a directory of one file per octree node plus a manifest, so each node is an ordinary whole-file request.</desc>
  <rect class="svg-bg" x="10" y="28" width="724" height="204" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="70" width="200" height="70" rx="8" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="268" y="70" width="200" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="278" y="80" width="40" height="50" rx="4" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="512" y="70" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="566" y="70" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="620" y="70" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="674" y="70" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="512" y="108" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="566" y="108" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="620" y="108" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="674" y="108" width="46" height="30" rx="4" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="124" y="112">one opaque file</text>
    <text x="298" y="110">VLR</text>
    <text x="400" y="112">points, octree-ordered</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle" font-weight="600">
    <text x="124" y="56">LAZ</text>
    <text x="368" y="56">COPC</text>
    <text x="616" y="56">EPT</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="124" y="168">no spatial index — read it all</text>
    <text x="368" y="168">range requests into one file</text>
    <text x="616" y="168">one whole-file GET per node</text>
  </g>
  <text x="380" y="214" fill="#15384a" font-size="12.5" text-anchor="middle">The same points in all three. What differs is whether a reader can find the ones it wants without fetching the rest.</text>
</svg>
<figcaption>COPC keeps the single-file convenience and adds the index; EPT gives up the single file and needs nothing special from the server.</figcaption>
</figure>

### 2. Build a COPC from an existing LAZ

One PDAL invocation, and the output remains a readable LAZ.

```python
import json
import pdal

spec = {"pipeline": [
    "survey_utm33n.laz",
    {"type": "writers.copc", "filename": "survey.copc.laz",
     "forward": "all"}
]}
n = pdal.Pipeline(json.dumps(spec)).execute()
print(f"{n:,} points written to COPC")
```

```bash
# Any LAZ reader still opens it; a COPC reader also sees the hierarchy.
pdal info survey.copc.laz --summary | head -20
```

The reordering is the expensive part: the writer has to build the octree and sort the points into node order, which for a billion-point survey means an external sort and roughly the same wall clock as reading the file twice.

### 3. Read a spatial subset without downloading the file

This is the whole point, and it works directly against a URL.

```python
import json
import pdal

spec = {"pipeline": [
    {"type": "readers.copc",
     "filename": "https://storage.example.com/surveys/survey.copc.laz",
     "bounds": "([598000, 598400], [6643800, 6644200])",
     "resolution": 0.5},
    {"type": "writers.las", "filename": "subset.laz", "forward": "all"},
]}
p = pdal.Pipeline(json.dumps(spec))
print(p.execute(), "points fetched")
```

`resolution` is the parameter that makes COPC genuinely useful for a viewer: it stops the octree descent at the level whose spacing matches the value, so a wide overview costs a few hundred kilobytes rather than the whole extent at full density. Combined with `bounds` it is a level-of-detail query over a point cloud, served from static object storage.

### 4. Build an EPT when range requests are not available

`untwine` is the current builder and it is considerably faster than the older `entwine` for the same job.

```bash
untwine --files survey_utm33n.laz --output_dir ept_survey/

ls ept_survey/
# ept.json  ept-data/  ept-hierarchy/  ept-sources/

python - <<'PY'
import json
m = json.load(open("ept_survey/ept.json"))
print("points:", f"{m['points']:,}", "| span:", m["span"], "| srs:", m["srs"]["authority"], m["srs"]["horizontal"])
PY
```

The directory structure is the trade. It serves from anything, it caches well because each node is an immutable whole file, and it turns one artifact into hundreds of thousands of small objects — which matters for storage cost, for listing operations, and for anything that syncs the bucket.

<figure class="diagram">
<svg viewBox="-8 19 756 221" role="img" aria-labelledby="pc-cost-t pc-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pc-cost-t">What a 400-metre viewport costs in each format</title>
  <desc id="pc-cost-d">Reading a four-hundred-metre window from a forty gigabyte survey costs the whole file in plain LAZ, about six megabytes in COPC through a handful of range requests, and about eight megabytes in EPT through a few dozen whole-file requests. The difference between COPC and EPT is request count rather than bytes.</desc>
  <rect class="svg-bg" x="-8" y="19" width="756" height="221" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="180" y="56" width="520" height="30" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="180" y="106" width="14" height="30" rx="3" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="180" y="156" width="18" height="30" rx="3" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="200" y="46">LAZ — 40 GB, 1 request</text>
    <text x="206" y="128">COPC — 6.1 MB, 9 range requests</text>
    <text x="210" y="178">EPT — 8.4 MB, 47 whole-file requests</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="end">
    <text x="170" y="76">LAZ</text>
    <text x="170" y="126">COPC</text>
    <text x="170" y="176">EPT</text>
  </g>
  <text x="370" y="222" fill="#15384a" font-size="12.5" text-anchor="middle">Both indexed formats fetch a similar volume; COPC does it in fewer, larger requests, which is what a high-latency link notices</text>
</svg>
<figcaption>The bytes are comparable. The request count is not, and on a mobile connection the difference between nine and forty-seven round trips is what the user experiences.</figcaption>
</figure>

### 5. Verify the index actually works

An index that exists and is not used is the failure mode to check for.

```python
import json
import time
import pdal

def timed_subset(reader, url, bounds, resolution=None):
    stage = {"type": reader, "filename": url, "bounds": bounds}
    if resolution:
        stage["resolution"] = resolution
    t0 = time.perf_counter()
    p = pdal.Pipeline(json.dumps({"pipeline": [stage]}))
    n = p.execute()
    return n, time.perf_counter() - t0

bounds = "([598000, 598400], [6643800, 6644200])"
n_full, t_full = timed_subset("readers.las", "survey_utm33n.laz", bounds)
n_copc, t_copc = timed_subset("readers.copc", "survey.copc.laz", bounds)

print(f"LAZ  {n_full:,} points in {t_full:6.1f}s")
print(f"COPC {n_copc:,} points in {t_copc:6.1f}s  ({t_full / t_copc:.0f}x faster)")
assert n_full == n_copc, "the two readers disagree about which points are in the window"
```

The equality assertion is the one that matters. A speedup with a different point count means the COPC's octree does not agree with the coordinates, which happens when a file is reordered without rebuilding the hierarchy.

<figure class="diagram">
<svg viewBox="2 16 661 240" role="img" aria-labelledby="pc-res-t pc-res-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pc-res-t">A resolution query stops the octree descent early</title>
  <desc id="pc-res-d">Requesting a coarse resolution over a wide extent stops the octree descent at a shallow level, so the reader fetches a few overview nodes. Requesting full density over a small extent descends to the leaves but only within that extent. The same file serves both, which is what makes a point cloud viewable directly from object storage.</desc>
  <rect class="svg-bg" x="2" y="16" width="661" height="240" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="40" y="60" width="120" height="30" rx="5" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="102" width="120" height="30" rx="5" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="144" width="120" height="30" rx="5" fill="#ffffff" stroke="#e6e0d4"/>
    <rect x="40" y="186" width="120" height="30" rx="5" fill="#ffffff" stroke="#e6e0d4"/>
    <rect x="420" y="60" width="120" height="30" rx="5" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="102" width="120" height="30" rx="5" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="144" width="120" height="30" rx="5" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="420" y="186" width="120" height="30" rx="5" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="172" y="80">level 0 — fetched</text>
    <text x="172" y="122">level 1 — fetched</text>
    <text x="172" y="164">level 2 — skipped</text>
    <text x="172" y="206">level 3 — skipped</text>
    <text x="552" y="80">level 0 — fetched</text>
    <text x="552" y="122">level 1 — fetched</text>
    <text x="552" y="164">level 2 — fetched</text>
    <text x="552" y="206">level 3 — fetched</text>
  </g>
  <text x="100" y="44" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">wide extent, 2 m resolution</text>
  <text x="480" y="44" fill="#1f6b8a" font-size="12.5" text-anchor="middle" font-weight="600">small extent, full density</text>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">Both queries hit the same static file, and neither downloads more than the nodes it needs</text>
</svg>
<figcaption>The resolution parameter turns a point cloud into something a viewer can page, without a server that understands point clouds.</figcaption>
</figure>

## Expected Output & Verification

A representative comparison on a 40 GB municipal survey:

```text
1,204,882,340 points written to COPC
LAZ  2,140,118 points in  412.7s
COPC 2,140,118 points in    3.9s  (106x faster)
points: 1,204,882,340 | span: 256 | srs: EPSG 25832
```

Two things to check beyond the timing. The point counts must match exactly, and the CRS in the COPC header and the EPT manifest must be the one you put in — both formats forward it, and both will happily forward an absent one.

## Common Errors

**COPC reads are as slow as plain LAZ.** The server does not honour range requests, so the reader falls back to fetching the whole file. Test with `curl -r 0-1023` and check for a `206 Partial Content` response.

**`readers.copc` reports zero points in a window you can see data in.** The `bounds` are in a different CRS from the file. COPC bounds are in the file's own CRS, with no reprojection.

**The EPT directory is enormous in object count.** That is inherent — a billion-point survey produces hundreds of thousands of node files. Budget for the per-object storage cost and avoid operations that list the prefix.

**A COPC built from a reordered LAZ returns wrong subsets.** The octree hierarchy was carried forward from the source while the point order changed. Always rebuild the COPC from the source rather than patching one.

## Frequently Asked Questions

### Which should a new pipeline use?
COPC, unless you cannot rely on range requests. It keeps the single-file operational model, any LAZ reader can still open it, and it is now the format PDAL, QGIS and the browser viewers read natively.

### Is COPC lossy relative to LAZ?
No. It is a valid LAZ file with the points in a particular order and one extra VLR. Every point, attribute and header field survives.

### Can I keep the archive as plain LAZ and derive COPC for delivery?
Yes, and it is a reasonable arrangement: the archive stays in the form the surveyor delivered, and the COPC is a regenerable derivative. It costs the rebuild time whenever the source changes, which for an archive is rarely.

### Does either format help with writing?
Neither is designed for partial writes. Both are built once and read many times, so a workflow that appends points continuously wants a database rather than either of these.

One operational note that decides more migrations than the format comparison does. COPC's single-file model means the archive, the delivery copy and the thing a viewer reads are the same object, so there is nothing to keep in sync. EPT's directory model separates them, and a directory of half a million small files behaves differently from one large one in every system that touches it — backup, replication, lifecycle rules, cost reporting and any operation that lists a prefix. That difference is usually a stronger argument than the request-count comparison.

The second is that neither format changes what is in the cloud. A survey delivered without a CRS, or with vegetation misclassified, is exactly as wrong after conversion. The indexing is about access, and the quality work belongs upstream of it.

## Related Guides

- [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/) — the wider container trade-offs
- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — the density figures a resolution query depends on
- [Computing Point Density from LAZ with PDAL](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/computing-point-density-from-laz-with-pdal/) — measuring what a subset actually returned

Back to [3D Format Standards Comparison](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/3d-format-standards-comparison/).
