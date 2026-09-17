---
title: "Cropping Point Clouds to Polygons with PDAL"
description: "Clip a point cloud to parcels, corridors or exclusion zones with filters.crop: WKT and OGR sources, buffers, inverted crops"
---
# Cropping Point Clouds to Polygons with PDAL

This page clips a large point cloud to arbitrary polygons with PDAL's `filters.crop` — supplying geometry as WKT or from an OGR datasource, handling buffers and inverted crops, batching hundreds of parcels in one pass, keeping the CRS consistent, and verifying that every polygon got the points it should have.

## Why you hit this

Deliverables are rarely "the whole survey". A parcel owner gets their parcel, a utility gets a corridor, a contractor gets the works area, and a privacy request removes a property. Each of those is a polygon clip, and doing it by hand for 340 parcels is not an option.

The operation itself is one PDAL stage. What makes it worth a page is everything around it: the CRS has to match or the crop silently returns nothing, a parcel boundary needs a buffer to be useful, an exclusion needs the inverse, and a batch of hundreds needs a strategy that does not read the cloud 340 times.

## Prerequisites

- PDAL 2.6+ with GDAL/OGR support; Python 3.10+ with `numpy`, `geopandas`, `shapely`, `pyproj`.
- A point cloud with a correctly declared CRS.
- Polygons in a format OGR reads: GeoPackage, Shapefile, GeoJSON, or a PostGIS table.

## Step-by-Step

### 1. Make the CRS match before anything else

```python
import json
import math
import subprocess
from pathlib import Path

import geopandas as gpd
import numpy as np
from pyproj import CRS

def cloud_crs(las_path):
    info = json.loads(subprocess.run(["pdal", "info", "--metadata", str(las_path)],
                                     capture_output=True, text=True, check=True).stdout)
    srs = info.get("metadata", {}).get("srs", {})
    wkt = srs.get("compoundwkt") or srs.get("wkt") or ""
    if not wkt:
        return {"declared": False, "epsg": None,
                "warning": "cloud has no CRS; filters.crop will assume the polygon's"}
    crs = CRS.from_wkt(wkt)
    return {"declared": True, "epsg": crs.to_epsg(), "name": crs.name,
            "is_projected": crs.is_projected,
            "axis_order": [a.abbrev for a in crs.axis_info][:2]}

def align_polygons(polygons_path, target_epsg, out_path, layer=None):
    gdf = gpd.read_file(polygons_path, layer=layer)
    source = gdf.crs
    if source is None:
        raise ValueError(f"{polygons_path} has no CRS; set it explicitly before cropping")
    if source.to_epsg() == target_epsg:
        gdf.to_file(out_path, driver="GPKG", layer="crop")
        return {"reprojected": False, "epsg": target_epsg, "features": len(gdf),
                "path": str(out_path)}
    out = gdf.to_crs(epsg=target_epsg)
    out.to_file(out_path, driver="GPKG", layer="crop")
    return {"reprojected": True, "from_epsg": source.to_epsg(),
            "to_epsg": target_epsg, "features": len(out), "path": str(out_path)}

info = cloud_crs("input/tile_a.laz")
print(json.dumps(info, indent=2))
print(align_polygons("input/parcels.gpkg", info["epsg"], "work/parcels_aligned.gpkg"))
```

`filters.crop` does not reproject. If the cloud is in EPSG:25832 and the polygons are in EPSG:4326, the crop compares eastings in the hundreds of thousands against longitudes around 10, finds no overlap, and returns an empty output with exit code zero — which is the single most common failure with this stage and looks exactly like "there were no points there".

A cloud with no declared CRS is the other trap. PDAL then assumes the polygon's coordinates are in the cloud's unknown system, which happens to work when they genuinely match and fails silently when they do not. Declaring the cloud's CRS with `--writers.las.a_srs` on a prior pass removes the ambiguity.

Axis order is worth checking for geographic CRSs: EPSG:4326 is formally latitude-longitude, and a polygon written as longitude-latitude will crop a region on the other side of the world.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="crop-crs-t crop-crs-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crop-crs-t">What a CRS mismatch does to a crop</title>
  <desc id="crop-crs-d">Three cases. When the cloud and the polygon share EPSG 25832, the crop returns the expected 1.8 million points. When the polygon is in EPSG 4326 while the cloud is in 25832, the polygon's coordinates near 10 and 59 fall nowhere near the cloud's eastings near 598000, so the crop returns zero points with exit code zero. When the polygon is in EPSG 4326 with axes swapped, it crops a region in the Indian Ocean and also returns zero points.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="204" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="222" y="20" width="214" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="436" y="20" width="132" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="568" y="20" width="154" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="204" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="222" y="52" width="214" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="436" y="52" width="132" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="568" y="52" width="154" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="96" width="204" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="222" y="96" width="214" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="436" y="96" width="132" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="568" y="96" width="154" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="140" width="204" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="222" y="140" width="214" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="436" y="140" width="132" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="568" y="140" width="154" height="44" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="41">polygon CRS</text><text x="329" y="41">coordinates seen</text>
    <text x="502" y="41">points out</text><text x="645" y="41">exit code</text>
    <text x="120" y="70">EPSG:25832 (matches)</text><text x="120" y="88">correct</text>
    <text x="329" y="79">598412, 6643188</text>
    <text x="502" y="79">1,804,118</text><text x="645" y="79">0 — success</text>
    <text x="120" y="114">EPSG:4326, not reprojected</text><text x="120" y="132">silent failure</text>
    <text x="329" y="123">10.75, 59.91</text>
    <text x="502" y="123">0</text><text x="645" y="123">0 — "success"</text>
    <text x="120" y="158">EPSG:4326, axes swapped</text><text x="120" y="176">crops the Indian Ocean</text>
    <text x="329" y="167">59.91, 10.75</text>
    <text x="502" y="167">0</text><text x="645" y="167">0 — "success"</text>
  </g>
  <text x="370" y="212" fill="#1f2937" font-size="12.5" text-anchor="middle">both failures return zero points and exit successfully</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">an empty output is only meaningful if the point count was asserted against an expectation</text>
</svg>
<figcaption>A CRS mismatch does not produce an error; it produces an empty file and a zero exit code.</figcaption>
</figure>

### 2. Crop to a single polygon

```python
def crop_to_wkt(las_path, out_path, wkt, buffer_m=0.0, outside=False, a_srs=None):
    stages = [str(las_path)]
    crop = {"type": "filters.crop", "polygon": wkt}
    if buffer_m:
        crop["distance"] = float(buffer_m)
    if outside:
        crop["outside"] = True
    stages.append(crop)
    writer = {"type": "writers.las", "filename": str(out_path),
              "compression": "laszip", "extra_dims": "all",
              "forward": "all"}
    if a_srs:
        writer["a_srs"] = a_srs
    stages.append(writer)

    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    meta_path = Path(out_path).with_suffix(".meta.json")
    proc = subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta_path)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"pdal failed: {proc.stderr[-400:]}")
    return read_output_count(meta_path, out_path)

def read_output_count(meta_path, out_path):
    meta = json.loads(Path(meta_path).read_text())
    stages = meta.get("stages", {})
    writer = next((v for k, v in stages.items() if k.startswith("writers.las")), {})
    return {"path": str(out_path),
            "points": int(writer.get("count", 0)),
            "bytes": Path(out_path).stat().st_size if Path(out_path).exists() else 0}
```

`forward: "all"` on the writer is the option that keeps a cropped deliverable usable: it carries the header's scale, offset, CRS, point format and global encoding from the input rather than letting the writer invent defaults. Without it a cropped LAS can come out with a different scale factor, which changes the last decimal of every coordinate.

`extra_dims: "all"` does the same for non-standard dimensions. A cloud carrying `HeightAboveGround` or a custom confidence field loses those silently otherwise.

The `distance` option buffers the polygon outwards, which is what a parcel deliverable usually needs: a boundary point sitting exactly on the line is ambiguous, and 0.5 m of buffer gives the recipient the context to see where their boundary is.

### 3. Use an OGR datasource for many polygons

```python
def crop_from_ogr(las_path, out_path, gpkg_path, layer="crop",
                  where=None, buffer_m=0.0, outside=False):
    """One crop stage reading geometry from OGR — no WKT strings in the pipeline."""
    crop = {
        "type": "filters.crop",
        "ogr": {
            "datasource": str(gpkg_path),
            "layer": layer,
        },
    }
    if where:
        crop["ogr"]["sql"] = f"SELECT geom FROM {layer} WHERE {where}"
    if buffer_m:
        crop["distance"] = float(buffer_m)
    if outside:
        crop["outside"] = True

    stages = [str(las_path), crop,
              {"type": "writers.las", "filename": str(out_path),
               "compression": "laszip", "extra_dims": "all", "forward": "all"}]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    meta_path = Path(out_path).with_suffix(".meta.json")
    subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta_path)],
                   check=True, capture_output=True)
    return read_output_count(meta_path, out_path)
```

The `ogr` form is preferable to building WKT strings for anything beyond one polygon. It avoids a pipeline JSON containing a megabyte of coordinates, it lets the crop use OGR's spatial index, and it accepts an SQL `WHERE` so a subset of a parcel table can be selected without pre-filtering the file.

Several polygons in the datasource are treated as a union: a point inside any of them is kept. That is what you want for "crop to these 40 parcels as one deliverable" and not what you want for "produce 40 separate files", which is step 4.

### 4. Produce one output per polygon, in one read

```python
def crop_per_polygon(las_path, gpkg_path, out_dir, layer="crop",
                     id_field="parcel_id", buffer_m=0.5, max_per_pass=64):
    """A pipeline with one crop+writer branch per polygon: one read of the cloud."""
    gdf = gpd.read_file(gpkg_path, layer=layer)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    results = []

    for start in range(0, len(gdf), max_per_pass):
        batch = gdf.iloc[start:start + max_per_pass]
        stages = [{"type": "readers.las", "filename": str(las_path), "tag": "source"}]
        for _, row in batch.iterrows():
            pid = str(row[id_field])
            tag = f"crop_{pid}".replace("-", "_").replace(" ", "_")
            stages.append({
                "type": "filters.crop",
                "polygon": row.geometry.wkt,
                "distance": float(buffer_m),
                "inputs": ["source"],
                "tag": tag,
            })
            stages.append({
                "type": "writers.las",
                "filename": str(Path(out_dir) / f"{pid}.laz"),
                "compression": "laszip",
                "extra_dims": "all",
                "forward": "all",
                "inputs": [tag],
            })
        spec = Path(out_dir) / f"batch_{start // max_per_pass}.json"
        spec.write_text(json.dumps({"pipeline": stages}, indent=2))
        meta_path = spec.with_suffix(".meta.json")
        subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta_path)],
                       check=True, capture_output=True)

        meta = json.loads(meta_path.read_text())
        for _, row in batch.iterrows():
            pid = str(row[id_field])
            path = Path(out_dir) / f"{pid}.laz"
            results.append({"id": pid, "path": str(path),
                            "exists": path.exists(),
                            "bytes": path.stat().st_size if path.exists() else 0,
                            "area_m2": round(float(row.geometry.area), 1)})
    return {"polygons": len(gdf), "outputs": len(results),
            "empty_outputs": sum(1 for r in results if r["bytes"] < 400),
            "results": results[:5]}
```

Branching one pipeline into many crop-and-write pairs reads the cloud **once**, which is the whole reason to do it this way. Running `pdal pipeline` 340 times reads a 40 GB LAZ 340 times — decompression is the cost, and it dominates everything else by two orders of magnitude.

The `max_per_pass` cap exists because each branch holds its accepted points in memory until its writer flushes. Sixty-four parcels of a few hundred thousand points each is a few gigabytes; three hundred at once is not.

An output smaller than about 400 bytes is a LAZ header with no points, which is why the `empty_outputs` count is checked against the file size rather than by reading each file.

### 5. Invert the crop for exclusions

```python
def apply_exclusions(las_path, out_path, exclusion_gpkg, layer="exclusions",
                     buffer_m=2.0):
    """Remove everything inside the polygons — privacy requests, restricted areas."""
    stages = [
        str(las_path),
        {"type": "filters.crop",
         "ogr": {"datasource": str(exclusion_gpkg), "layer": layer},
         "distance": float(buffer_m),
         "outside": True},
        {"type": "writers.las", "filename": str(out_path),
         "compression": "laszip", "extra_dims": "all", "forward": "all"},
    ]
    spec = Path(out_path).with_suffix(".pipeline.json")
    spec.write_text(json.dumps({"pipeline": stages}, indent=2))
    meta_path = Path(out_path).with_suffix(".meta.json")
    subprocess.run(["pdal", "pipeline", str(spec), "--metadata", str(meta_path)],
                   check=True, capture_output=True)
    return read_output_count(meta_path, out_path)

def exclusion_verification(original_las, cleaned_las, exclusion_gpkg,
                           layer="exclusions", buffer_m=2.0, sample=400_000):
    """Assert that nothing inside the exclusions survived."""
    import laspy
    from shapely.geometry import Point
    from shapely.prepared import prep

    gdf = gpd.read_file(exclusion_gpkg, layer=layer)
    union = gdf.geometry.buffer(buffer_m).union_all()
    prepared = prep(union)

    las = laspy.read(cleaned_las)
    n = len(las.points)
    rng = np.random.default_rng(7)
    idx = rng.choice(n, size=min(sample, n), replace=False)
    xs = np.asarray(las.x)[idx]
    ys = np.asarray(las.y)[idx]
    inside = sum(1 for x, y in zip(xs, ys) if prepared.contains(Point(x, y)))

    return {
        "sampled": int(len(idx)),
        "still_inside_exclusion": inside,
        "clean": inside == 0,
        "buffer_m": buffer_m,
        "note": "a non-zero count means the buffer or the CRS is wrong, "
                "not that the crop failed to run",
    }
```

An inverted crop is how a privacy request or a restricted-area removal is implemented, and it is the case where verification matters most: the consequence of a failed exclusion is a compliance problem rather than a missing file.

The buffer on an exclusion goes **outwards**, enlarging the removed area, which is the conservative direction. Two metres beyond a property boundary removes the points that would reconstruct the facade from just outside the line.

Sampling rather than testing every point keeps the verification fast; with 400,000 samples, an exclusion that leaked 0.1% of its points is caught with near-certainty.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="crop-opts-t crop-opts-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crop-opts-t">Writer options that keep a cropped deliverable faithful</title>
  <desc id="crop-opts-d">A table of four writer options and what is lost without each. Forward all carries the header's scale, offset, CRS and point format from the input. Extra dims set to all carries non-standard dimensions such as height above ground. Laszip compression saves about seventy percent of the space. The a_srs option only matters when the input had no declared CRS.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="190" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="384" y="20" width="338" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="54" width="190" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="384" y="54" width="338" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="88" width="190" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="384" y="88" width="338" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="122" width="190" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="384" y="122" width="338" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="156" width="190" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="384" y="156" width="338" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="42">option</text><text x="289" y="42">value</text><text x="553" y="42">lost without it</text>
    <text x="106" y="76">forward</text><text x="289" y="76">all</text><text x="553" y="76">scale, offset, CRS, point format</text>
    <text x="106" y="110">extra_dims</text><text x="289" y="110">all</text><text x="553" y="110">HeightAboveGround and custom fields</text>
    <text x="106" y="144">compression</text><text x="289" y="144">laszip</text><text x="553" y="144">70% more disk for the same data</text>
    <text x="106" y="178">a_srs</text><text x="289" y="178">only if undeclared</text><text x="553" y="178">nothing, if the input declared one</text>
  </g>
  <text x="20" y="210" fill="#1f2937" font-size="12.5">A changed scale factor re-quantises every coordinate and makes two deliveries disagree at the millimetre.</text>
  <text x="20" y="232" fill="#5b6471" font-size="12">The first two are one word each and are the difference between a copy and a lossy export.</text>
</svg>
<figcaption>Two words on the writer keep a cropped file byte-faithful to its source header.</figcaption>
</figure>

### 6. Verify completeness against the polygons

```python
def completeness_check(gpkg_path, out_dir, layer="crop", id_field="parcel_id",
                       expected_density_per_m2=None, tolerance=0.4):
    gdf = gpd.read_file(gpkg_path, layer=layer)
    rows = []
    for _, row in gdf.iterrows():
        pid = str(row[id_field])
        path = Path(out_dir) / f"{pid}.laz"
        if not path.exists():
            rows.append({"id": pid, "status": "missing file",
                         "area_m2": round(float(row.geometry.area), 1)})
            continue
        info = json.loads(subprocess.run(["pdal", "info", "--summary", str(path)],
                                         capture_output=True, text=True,
                                         check=True).stdout)
        n = int(info["summary"]["num_points"])
        area = float(row.geometry.area)
        density = n / max(area, 1e-9)
        entry = {"id": pid, "points": n, "area_m2": round(area, 1),
                 "density_per_m2": round(density, 2)}
        if n == 0:
            entry["status"] = "EMPTY"
        elif expected_density_per_m2 and density < expected_density_per_m2 * tolerance:
            entry["status"] = "sparse"
        else:
            entry["status"] = "ok"
        rows.append(entry)

    by_status = {}
    for r in rows:
        by_status.setdefault(r["status"], 0)
        by_status[r["status"]] += 1
    return {
        "polygons": len(rows),
        "by_status": by_status,
        "empty": [r["id"] for r in rows if r.get("status") == "EMPTY"][:6],
        "sparse": [r for r in rows if r.get("status") == "sparse"][:4],
        "median_density": round(float(np.median([r["density_per_m2"] for r in rows
                                                 if "density_per_m2" in r])), 2)
        if rows else 0.0,
        "all_ok": by_status.get("ok", 0) == len(rows),
    }

print(json.dumps(completeness_check("work/parcels_aligned.gpkg", "out/parcels",
                                    expected_density_per_m2=41.8), indent=2))
```

Comparing each output's point density against the survey's nominal density is what catches the interesting failures. A parcel with zero points is either outside the cloud's extent or a CRS problem; a parcel at 40% of the expected density is partly outside the tile, which is legitimate and worth flagging so the recipient is told rather than left to wonder.

<figure class="diagram">
<svg viewBox="4 16 732 234" role="img" aria-labelledby="crop-batch-t crop-batch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="crop-batch-t">One read, many outputs</title>
  <desc id="crop-batch-d">Two approaches to producing 340 parcel deliverables from a 40 gigabyte compressed cloud. Running one pipeline per parcel decompresses the cloud 340 times and takes 19 hours. One pipeline with 64 crop branches per pass needs 6 passes, decompresses the cloud 6 times and takes 21 minutes. The difference is entirely decompression, which dominates the crop itself by two orders of magnitude.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="234" fill="#ffffff"/>
  <g stroke-width="1.6">
    <rect x="18" y="30" width="330" height="176" rx="9" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="392" y="30" width="330" height="176" rx="9" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <text x="183" y="54" fill="#1f2937" font-size="13" text-anchor="middle">one pipeline per parcel</text>
  <text x="557" y="54" fill="#1f2937" font-size="13" text-anchor="middle">branched pipeline, 64 per pass</text>
  <g stroke-width="1.4">
    <rect x="42" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="90" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="138" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="186" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="234" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="282" y="72" width="40" height="26" fill="#ffffff" stroke="#b0413e"/>
    <rect x="416" y="72" width="88" height="26" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="512" y="72" width="88" height="26" fill="#ffffff" stroke="#4f7a4d"/>
    <rect x="608" y="72" width="88" height="26" fill="#ffffff" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="62" y="90">read</text><text x="110" y="90">read</text><text x="158" y="90">read</text>
    <text x="206" y="90">read</text><text x="254" y="90">read</text><text x="302" y="90">…</text>
    <text x="460" y="90">read + 64 crops</text><text x="556" y="90">read + 64</text>
    <text x="652" y="90">read + 64</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="183" y="132">340 decompressions of 40 GB</text>
    <text x="183" y="154">19 hours</text>
    <text x="557" y="132">6 decompressions of 40 GB</text>
    <text x="557" y="154">21 minutes</text>
  </g>
  <text x="183" y="186" fill="#b0413e" font-size="12" text-anchor="middle">the crop itself is 0.4% of the time</text>
  <text x="557" y="186" fill="#1f2937" font-size="12" text-anchor="middle">54× faster, identical output</text>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">batch size is limited by memory: each branch buffers its accepted points until its writer flushes</text>
</svg>
<figcaption>Decompression dominates; branching the pipeline turns 340 reads into six.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "declared": true, "epsg": 25832, "name": "ETRS89 / UTM zone 32N",
  "is_projected": true, "axis_order": ["E", "N"]
}
{'reprojected': true, 'from_epsg': 4326, 'to_epsg': 25832, 'features': 340,
 'path': 'work/parcels_aligned.gpkg'}
{'polygons': 340, 'outputs': 340, 'empty_outputs': 4,
 'results': [{'id': 'P-00412', 'bytes': 8412004, 'area_m2': 1841.2}, …]}
{
  "polygons": 340,
  "by_status": {"ok": 328, "sparse": 8, "EMPTY": 4},
  "empty": ["P-01204", "P-01208", "P-01214", "P-01221"],
  "sparse": [{"id": "P-00884", "points": 18412, "area_m2": 2104.8,
              "density_per_m2": 8.75, "status": "sparse"}],
  "median_density": 41.44,
  "all_ok": false
}
{'sampled': 400000, 'still_inside_exclusion': 0, 'clean': true, 'buffer_m': 2.0}
```

The reprojection from EPSG:4326 to 25832 is the step that made the whole thing work; without it all 340 outputs would have been empty. A median density of 41.4 against a nominal 41.8 confirms the crops are complete where they should be.

The four empty parcels and eight sparse ones are the useful findings. Four consecutive parcel identifiers being empty suggests a block outside the tile's extent rather than four independent failures, which is worth checking before reporting them as problems.

Verify the empty outputs are legitimately empty rather than a mistake:

```python
def empty_output_diagnosis(gpkg_path, empty_ids, las_path, layer="crop",
                           id_field="parcel_id"):
    gdf = gpd.read_file(gpkg_path, layer=layer)
    info = json.loads(subprocess.run(["pdal", "info", "--summary", str(las_path)],
                                     capture_output=True, text=True, check=True).stdout)
    b = info["summary"]["bounds"]
    from shapely.geometry import box
    cloud_box = box(b["minx"], b["miny"], b["maxx"], b["maxy"])

    rows = []
    for pid in empty_ids:
        match = gdf[gdf[id_field].astype(str) == str(pid)]
        if match.empty:
            rows.append({"id": pid, "reason": "polygon not found in layer"})
            continue
        geom = match.iloc[0].geometry
        if not cloud_box.intersects(geom):
            rows.append({"id": pid, "reason": "outside the cloud's extent",
                         "distance_to_cloud_m": round(float(geom.distance(cloud_box)), 1)})
        elif cloud_box.intersection(geom).area / max(geom.area, 1e-9) < 0.01:
            rows.append({"id": pid, "reason": "barely overlaps the extent",
                         "overlap_fraction": round(
                             float(cloud_box.intersection(geom).area / geom.area), 4)})
        else:
            rows.append({"id": pid, "reason": "UNEXPLAINED — inside the extent "
                                              "and still empty; check the CRS",
                         "overlap_fraction": round(
                             float(cloud_box.intersection(geom).area / geom.area), 4)})
    return {"checked": len(rows), "rows": rows,
            "unexplained": [r for r in rows if "UNEXPLAINED" in r["reason"]]}

print(json.dumps(empty_output_diagnosis("work/parcels_aligned.gpkg",
                                        ["P-01204", "P-01208"], "input/tile_a.laz"),
                 indent=2))
```

An empty output whose polygon lies inside the cloud's extent is the one that needs investigation, and this function separates those from the ones that are simply outside. In practice the unexplained cases come down to a Z filter, a class filter earlier in the pipeline, or a polygon with invalid geometry that OGR silently skipped.

Then verify the cropped files preserve the input's header properties, since a deliverable with a different scale factor is a subtle corruption:

```python
def header_fidelity_check(original_las, cropped_las):
    def header(path):
        info = json.loads(subprocess.run(["pdal", "info", "--metadata", str(path)],
                                         capture_output=True, text=True,
                                         check=True).stdout)
        m = info["metadata"]
        return {
            "scale": [m.get("scale_x"), m.get("scale_y"), m.get("scale_z")],
            "offset": [m.get("offset_x"), m.get("offset_y"), m.get("offset_z")],
            "point_format": m.get("dataformat_id"),
            "version": f"{m.get('major_version')}.{m.get('minor_version')}",
            "srs_epsg": (CRS.from_wkt(m["srs"]["wkt"]).to_epsg()
                         if m.get("srs", {}).get("wkt") else None),
            "dimensions": sorted(d["name"] for d in info.get("schema", {})
                                 .get("dimensions", [])),
        }
    a, b = header(original_las), header(cropped_las)
    diffs = {k: {"original": a[k], "cropped": b[k]} for k in a if a[k] != b[k]}
    return {"identical": not diffs, "differences": diffs,
            "dimensions_lost": sorted(set(a["dimensions"]) - set(b["dimensions"])),
            "note": "scale, offset and CRS must match; 'forward: all' on the writer "
                    "is what preserves them"}
```

A changed scale factor re-quantises every coordinate, which moves points by up to half a scale unit and makes the cropped file disagree with the original at the millimetre level. Nobody notices until two deliverables from the same survey are compared.

## Performance Notes

- **Decompression dominates.** A 40 GB LAZ takes minutes to read; the crop test is microseconds per point. Structure the work to read once.
- **`filters.crop` with `ogr` uses OGR's spatial index**, so hundreds of polygons cost little more than one.
- **Each pipeline branch buffers its points.** Sixty-four branches on a dense tile is a few gigabytes; reduce `max_per_pass` if memory is tight.
- **Build a spatial index on the cloud** — `pdal tindex` over tiles, or COPC — so a small polygon reads only the relevant chunks instead of the whole file.
- **COPC is the real answer for many small crops.** A COPC file supports spatial queries, so cropping a parcel from a 40 GB COPC reads a few megabytes.
- **`laszip` compression on output** costs about 30% of the write time and saves 70% of the space; always worth it for a deliverable.

## Common Errors

**Empty output, exit code 0.** CRS mismatch. Check both CRSs and reproject the polygons.

**Empty output with matching CRSs.** Axis order on a geographic CRS, or an invalid polygon OGR skipped. Run `ST_IsValid` equivalents before cropping.

**Points just outside the boundary are missing.** No buffer. Add `distance`.

**Custom dimensions lost.** `extra_dims` not set to `all` on the writer.

**Scale factor changed.** `forward: all` not set.

**Crop takes hours for 340 parcels.** One pipeline per parcel. Branch instead.

**`filters.crop` reports "unable to open datasource".** A relative path resolved against the working directory rather than the pipeline file, or a missing OGR driver for the format.

**An exclusion leaked points.** The buffer is too small for the reconstruction risk, or the exclusion polygons were not unioned and overlapping ones left gaps.

## Frequently Asked Questions

### Should I crop or use a spatial index?

Crop for a fixed set of deliverables. For interactive or repeated queries over the same cloud, convert to COPC once and query it — the read cost drops from the whole file to the relevant nodes.

### Does the crop respect Z?

`filters.crop` is 2D by default; a `bounds` parameter with a Z range restricts vertically, or `filters.expression` on Z does the same more flexibly.

### How do I crop to a buffered line, like a corridor?

Buffer the line in `geopandas` to a polygon and crop to that. `filters.crop` takes polygons, not linestrings.

## Related Guides

- [Radius Outlier Removal in Open3D](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/radius-outlier-removal-in-open3d/) — filtering by density rather than extent
- [Voxel Downsampling Strategies Compared](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/voxel-downsampling-strategies-compared/) — reducing a cropped deliverable's size
- [Running PDAL Pipelines in Docker](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/running-pdal-pipelines-in-docker/) — making these pipelines reproducible

Back to [Point Cloud Filtering Techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/).
