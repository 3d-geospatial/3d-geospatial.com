---
title: "Uploading Terrain Rasters to ion"
description: "Prepare and upload elevation rasters as ion terrain: nodata and vertical datum handling, mosaicking, base terrain choice"
---
# Uploading Terrain Rasters to ion

This page prepares a set of GeoTIFF elevation tiles — 1 m lidar-derived DTM covering 900 km² — for upload as a Cesium ion terrain asset: fixing nodata so the sea does not become a cliff, declaring the vertical datum, mosaicking or not, choosing the base terrain to blend into, and verifying the result against survey control points before anything is built on it.

## Why you hit this

Terrain is the layer everything else sits on. A building tileset clamped to terrain that is 40 m out puts every building underground; a point cloud draped over terrain with nodata read as zero shows a 100 m cliff at every water body. And terrain tiling is the slowest and most expensive ion operation, so a mistake discovered afterwards costs hours rather than minutes.

Most of the work is in the raster before it is uploaded. ion tiles what it is given faithfully, including the parts that are wrong.

## Prerequisites

- Python 3.10+ with `rasterio`, `numpy`, `pyproj`; GDAL command-line tools available.
- An ion token with `assets:write`.
- The rasters' horizontal **and** vertical CRS, and a handful of survey control points with known heights for verification.

## Step-by-Step

### 1. Inspect every input raster, not just the first

```python
import json
import math
import os
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS

def inspect(paths):
    rows = []
    for p in sorted(paths):
        with rasterio.open(p) as ds:
            band = ds.read(1, masked=True)
            rows.append({
                "file": Path(p).name,
                "crs": ds.crs.to_string() if ds.crs else None,
                "res_m": [round(abs(ds.transform.a), 3), round(abs(ds.transform.e), 3)],
                "size": [ds.width, ds.height],
                "dtype": str(ds.dtypes[0]),
                "nodata": ds.nodata,
                "valid_pct": round(100.0 * band.count() / band.size, 2),
                "min": None if band.count() == 0 else round(float(band.min()), 2),
                "max": None if band.count() == 0 else round(float(band.max()), 2),
            })
    return rows

rasters = list(Path("input/dtm").glob("*.tif"))
rows = inspect(rasters)
print(f"{len(rows)} rasters")
print("CRS values:", Counter(r["crs"] for r in rows))
print("dtypes:", Counter(r["dtype"] for r in rows))
print("resolutions:", Counter(tuple(r["res_m"]) for r in rows))
print("nodata:", Counter(str(r["nodata"]) for r in rows))
extremes = sorted(rows, key=lambda r: (r["min"] is None, r["min"]))[:3]
print("lowest:", [(r["file"], r["min"], r["max"]) for r in extremes])
```

Checking all of them matters because a delivery of 900 tiles is rarely uniform: a few will have a different nodata value, one or two will be `float64` where the rest are `float32`, and occasionally a handful arrive in a different CRS entirely because they came from a neighbouring authority. Each inconsistency becomes a visible artefact in the tiled terrain.

The `min` value across the set is the fastest nodata diagnostic there is. A DTM whose minimum is −9999 or −32768 has nodata being read as elevation, and that is what produces the cliffs.

<figure class="diagram">
<svg viewBox="6 10 728 230" role="img" aria-labelledby="ter-nodata-t ter-nodata-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ter-nodata-t">Nodata read as elevation versus nodata masked</title>
  <desc id="ter-nodata-d">Two terrain cross-sections. On the left, nodata cells over a lake carry the value minus 9999 and are tiled as elevation, producing a vertical shaft descending far below the surrounding ground. On the right the same cells are declared as nodata, so the tiler interpolates or leaves a hole and the lake surface stays level with its shoreline.</desc>
  <rect class="svg-bg" x="6" y="10" width="728" height="230" fill="#ffffff"/>
  <rect x="20" y="24" width="336" height="176" rx="9" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="384" y="24" width="336" height="176" rx="9" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <text x="188" y="48" fill="#1f2937" font-size="13" text-anchor="middle">nodata = −9999 tiled as elevation</text>
  <text x="552" y="48" fill="#1f2937" font-size="13" text-anchor="middle">nodata declared and masked</text>
  <path d="M44 96 H128 V186 H168 V96 H332" stroke="#b0413e" stroke-width="2.5" fill="none"/>
  <path d="M408 96 H492 L512 99 L532 99 L552 96 H696" stroke="#4f7a4d" stroke-width="2.5" fill="none"/>
  <path d="M492 99 H552" stroke="#1f6b8a" stroke-width="3" fill="none"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="148" y="126">100 m shaft</text>
    <text x="148" y="144">at every</text>
    <text x="148" y="162">water body</text>
    <text x="522" y="130">lake surface level</text>
    <text x="522" y="148">with its shoreline</text>
  </g>
  <g fill="#5b6471" font-size="12">
    <text x="44" y="88">ground</text>
    <text x="408" y="88">ground</text>
  </g>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">one GDAL flag decides which of these the terrain asset becomes</text>
</svg>
<figcaption>The left picture is what an undeclared nodata value looks like after tiling, and it cannot be fixed without re-tiling.</figcaption>
</figure>

### 2. Normalise nodata, dtype and CRS

```python
def normalise_raster(src_path, out_path, target_crs="EPSG:25832",
                     nodata_out=-9999.0, dtype="float32"):
    """One pass: reproject if needed, set a single nodata value, mask sentinel values."""
    with rasterio.open(src_path) as ds:
        data = ds.read(1).astype("float32")
        src_nodata = ds.nodata
        mask = np.zeros(data.shape, dtype=bool)
        if src_nodata is not None:
            mask |= np.isclose(data, src_nodata)
        for sentinel in (-9999.0, -32767.0, -32768.0, 3.4028234663852886e38):
            mask |= np.isclose(data, sentinel, rtol=0, atol=1e-3)
        mask |= ~np.isfinite(data)
        mask |= data < -500.0                    # no land below this in this project
        mask |= data > 9000.0
        data[mask] = nodata_out

        profile = ds.profile
        profile.update(dtype=dtype, nodata=nodata_out, compress="deflate",
                       predictor=3, tiled=True, blockxsize=512, blockysize=512,
                       BIGTIFF="IF_SAFER")
        needs_warp = ds.crs is None or ds.crs != CRS.from_string(target_crs)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(data, 1)
    if needs_warp:
        warped = str(out_path).replace(".tif", "_warp.tif")
        subprocess.run(["gdalwarp", "-t_srs", target_crs, "-r", "bilinear",
                        "-dstnodata", str(nodata_out), "-co", "COMPRESS=DEFLATE",
                        "-co", "PREDICTOR=3", "-co", "TILED=YES",
                        str(out_path), warped], check=True, capture_output=True)
        os.replace(warped, out_path)
    return {"file": Path(out_path).name, "masked_pct": round(100.0 * mask.mean(), 2),
             "warped": needs_warp}

stats = [normalise_raster(p, f"work/dtm/{p.name}") for p in rasters]
print(f"masked on average {np.mean([s['masked_pct'] for s in stats]):.2f}% of cells")
print(f"{sum(s['warped'] for s in stats)} raster(s) needed reprojection")
```

Declaring nodata is necessary and not sufficient, because the sentinel values are often present *without* being declared in the header — which is exactly the case the loop over known sentinels handles. Adding a physical plausibility range on top catches the ones nobody has seen before: a DTM cell at −3.4e38 is a float32 minimum written by some export path, and a cell at 32767 is an integer sentinel that survived a dtype conversion.

`predictor=3` is the floating-point predictor for DEFLATE and typically halves the file size of an elevation raster against no predictor, which matters directly because upload bandwidth is the bottleneck.

Reprojecting with `bilinear` rather than `nearest` is right for continuous elevation; nearest leaves stair-stepping that shows up as terracing in the tiled terrain.

### 3. Declare the vertical datum

```python
from pyproj import CRS as PyCRS, Transformer

def vertical_offset_sample(lon, lat, h_orthometric,
                           compound="EPSG:25832+5941", target="EPSG:4979"):
    """How far the declared vertical datum moves a height. Sanity-check before upload."""
    t = Transformer.from_crs(PyCRS.from_user_input(compound),
                             PyCRS.from_user_input(target), always_xy=True)
    x, y, z = t.transform(lon, lat, h_orthometric)
    return {"orthometric_m": h_orthometric, "ellipsoidal_m": round(z, 3),
            "separation_m": round(z - h_orthometric, 3)}

print(vertical_offset_sample(10.7522, 59.9139, 24.0))

def terrain_options(horizontal_epsg, vertical_epsg, base_terrain_id=1, water_mask=False):
    opts = {"sourceType": "RASTER_TERRAIN",
            "srs": f"EPSG:{horizontal_epsg}+{vertical_epsg}",
            "baseTerrainId": int(base_terrain_id)}
    if water_mask:
        opts["waterMask"] = True
    return opts

print(terrain_options(25832, 5941))
```

Terrain is where the vertical datum matters most, because the error is systematic across the whole dataset and everything else is positioned relative to it. National height systems are orthometric — NN2000, DHHN2016, NAVD88, ODN — and 3D Tiles terrain is ellipsoidal, so the separation has to be applied somewhere. Declaring the compound CRS makes ion apply it; not declaring it means the whole city sits at the wrong height while looking internally consistent.

Printing the separation for one point before uploading is thirty seconds of work that catches a wrong vertical code, because the number should match what a national geoid map says for that location — around 40 m in southern Norway, 45 m in Germany, −30 m in parts of the US.

### 4. Choose the base terrain and decide about mosaicking

```python
BASE_TERRAIN = {
    "world_terrain": 1,      # blend into Cesium World Terrain outside the extent
    "none": 0,               # ellipsoid outside the extent — a visible edge
}

def upload_plan(rasters, max_files=1000, max_total_gb=120.0, mosaic_threshold=500):
    total_gb = sum(Path(p).stat().st_size for p in rasters) / 1e9
    plan = {"files": len(rasters), "total_gb": round(total_gb, 1),
            "mosaic": len(rasters) > mosaic_threshold,
            "base_terrain_id": BASE_TERRAIN["world_terrain"],
            "water_mask": False}
    if plan["files"] > max_files and not plan["mosaic"]:
        plan["mosaic"] = True
        plan["reason"] = f"{plan['files']} files exceeds the practical per-asset limit"
    if total_gb > max_total_gb:
        plan["split_into_assets"] = math.ceil(total_gb / max_total_gb)
    return plan

def mosaic_to_vrt(rasters, out_vrt="work/dtm.vrt", out_tif=None):
    listing = Path("work/dtm_list.txt")
    listing.write_text("\n".join(str(p) for p in sorted(rasters)))
    subprocess.run(["gdalbuildvrt", "-input_file_list", str(listing),
                    "-resolution", "highest", "-r", "bilinear", out_vrt],
                   check=True, capture_output=True)
    if out_tif:
        subprocess.run(["gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE",
                        "-co", "PREDICTOR=3", "-co", "BIGTIFF=YES",
                        out_vrt, out_tif], check=True, capture_output=True)
        return {"vrt": out_vrt, "tif": out_tif,
                "gb": round(Path(out_tif).stat().st_size / 1e9, 2)}
    return {"vrt": out_vrt}

plan = upload_plan(list(Path("work/dtm").glob("*.tif")))
print(plan)
```

`baseTerrainId: 1` blends the asset into Cesium World Terrain at its edges, which is what you want for a city inside a country: outside the extent the viewer shows global terrain rather than a cliff down to the ellipsoid. `0` is right only when the asset covers the whole area of interest, or when the surrounding terrain would be misleading.

Mosaicking is a trade. A single large COG uploads as one file and tiles as one coherent surface with no tile-boundary artefacts; 900 separate GeoTIFFs upload in parallel and let a failed file be replaced individually. Past a few hundred files the mosaic wins, mostly because per-file upload overhead and the chance that one file is subtly different both grow.

A `.vrt` is not uploadable — it is a reference to other files — so mosaicking for upload means materialising a COG.

### 5. Upload and tile

```python
import boto3
import requests

API = "https://api.cesium.com/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['ION_UPLOAD_TOKEN']}",
           "Content-Type": "application/json"}

def upload_terrain(name, description, files, options, attribution=""):
    body = {"name": name, "description": description, "type": "TERRAIN",
            "options": options}
    if attribution:
        body["attribution"] = attribution
    r = requests.post(f"{API}/assets", headers=HEADERS, data=json.dumps(body), timeout=60)
    r.raise_for_status()
    payload = r.json()
    loc, meta = payload["uploadLocation"], payload["assetMetadata"]

    s3 = boto3.client("s3", aws_access_key_id=loc["accessKey"],
                      aws_secret_access_key=loc["secretAccessKey"],
                      aws_session_token=loc["sessionToken"])
    sent_bytes = 0
    for p in files:
        s3.upload_file(str(p), loc["bucket"], f"{loc['prefix']}{Path(p).name}")
        sent_bytes += Path(p).stat().st_size

    oc = payload["onComplete"]
    done = requests.request(oc["method"], oc["url"], headers=HEADERS,
                            data=json.dumps(oc.get("fields", {})), timeout=60)
    done.raise_for_status()
    return {"asset_id": meta["id"], "files": len(files),
            "uploaded_gb": round(sent_bytes / 1e9, 2)}

result = upload_terrain(
    "City DTM 1 m 2026",
    "Lidar-derived DTM, 1 m, ETRS89/UTM32N + NN2000",
    [Path("work/dtm_mosaic.tif")],
    terrain_options(25832, 5941, base_terrain_id=1, water_mask=False),
    attribution="City of Example, CC BY 4.0",
)
print(result)
```

`waterMask: True` adds a water-mask layer so the viewer can render water surfaces specially, and it roughly doubles terrain tiling time. It is worth it for a coastal or lake-heavy area where water rendering matters visually, and not worth it for an inland city where the only water is a river.

The 1 m source resolution will be tiled down to whatever the terrain tiling scheme supports at the deepest level, which is finer than 1 m in a city extent — so no detail is lost, but no detail is invented either. Uploading a 0.25 m DTM produces a slightly better terrain asset and takes four times the storage and tiling time.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="ter-prep-t ter-prep-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ter-prep-t">The five raster problems to fix before uploading</title>
  <desc id="ter-prep-d">A table of five input problems found in a 912-tile DTM delivery, each with the number of rasters affected and the consequence of not fixing it. Undeclared nodata affects 32 rasters and produces cliffs at every water body. A mismatched CRS affects 4 and places them wrongly. Float64 dtype affects 6 and doubles the upload. A missing vertical datum affects all of them and shifts the city by 40 metres. Coarse resolution affects none here.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="236" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="254" y="20" width="110" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="364" y="20" width="358" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="254" y="54" width="110" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="364" y="54" width="358" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="88" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="254" y="88" width="110" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="364" y="88" width="358" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="122" width="236" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="254" y="122" width="110" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="364" y="122" width="358" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="236" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="254" y="156" width="110" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="364" y="156" width="358" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="190" width="236" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="254" y="190" width="110" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="364" y="190" width="358" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="136" y="42">problem</text><text x="309" y="42">rasters</text><text x="543" y="42">if not fixed</text>
    <text x="136" y="76">nodata not declared</text><text x="309" y="76">32</text><text x="543" y="76">cliffs at every water body</text>
    <text x="136" y="110">different CRS</text><text x="309" y="110">4</text><text x="543" y="110">those tiles land elsewhere</text>
    <text x="136" y="144">float64 dtype</text><text x="309" y="144">6</text><text x="543" y="144">double the upload for nothing</text>
    <text x="136" y="178">no vertical datum in srs</text><text x="309" y="178">all 912</text><text x="543" y="178">the city sits 40 m out</text>
    <text x="136" y="212">resolution mismatch</text><text x="309" y="212">0</text><text x="543" y="212">terracing in the tiled surface</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Four of the five are one-line fixes in the normalisation pass and cannot be fixed after tiling.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">The vertical datum is the one that is invisible in a viewer and wrong for everything built on it.</text>
</svg>
<figcaption>Every one of these is cheap to fix before the upload and impossible to fix after the tiling.</figcaption>
</figure>

### 6. Verify heights against control points

```python
def sample_terrain_heights(asset_id, points_lonlat):
    """Ask ion for heights at known positions and compare with surveyed values."""
    ep = requests.get(f"{API}/assets/{asset_id}/endpoint", headers=HEADERS, timeout=30)
    ep.raise_for_status()
    endpoint = ep.json()
    layer = requests.get(f"{endpoint['url']}layer.json",
                         headers={"Authorization": f"Bearer {endpoint['accessToken']}"},
                         timeout=30)
    return {"endpoint_ok": layer.status_code == 200,
            "available_levels": len(layer.json().get("available", []))
                                if layer.status_code == 200 else None}

def verify_against_control(local_raster, control_points, expected_datum="orthometric"):
    """Compare the prepared raster against control before uploading — much faster."""
    rows = []
    with rasterio.open(local_raster) as ds:
        to_raster = Transformer.from_crs("EPSG:4326", ds.crs, always_xy=True)
        for cp in control_points:
            x, y = to_raster.transform(cp["lon"], cp["lat"])
            try:
                val = next(ds.sample([(x, y)], indexes=1))[0]
            except StopIteration:
                val = None
            if val is None or (ds.nodata is not None and np.isclose(val, ds.nodata)):
                rows.append({"id": cp["id"], "status": "nodata"})
                continue
            rows.append({"id": cp["id"], "raster_m": round(float(val), 3),
                         "control_m": cp["h_m"],
                         "residual_m": round(float(val) - cp["h_m"], 3)})
    resid = [r["residual_m"] for r in rows if "residual_m" in r]
    return {"points": len(rows), "with_value": len(resid),
            "mean_m": round(float(np.mean(resid)), 3) if resid else None,
            "rmse_m": round(float(np.sqrt(np.mean(np.square(resid)))), 3) if resid else None,
            "max_abs_m": round(float(np.max(np.abs(resid))), 3) if resid else None,
            "worst": sorted((r for r in rows if "residual_m" in r),
                            key=lambda r: -abs(r["residual_m"]))[:3]}

CONTROL = [
    {"id": "GP-014", "lon": 10.7461, "lat": 59.9128, "h_m": 18.412},
    {"id": "GP-027", "lon": 10.7702, "lat": 59.9214, "h_m": 41.067},
    {"id": "GP-041", "lon": 10.7318, "lat": 59.9042, "h_m": 6.885},
    {"id": "GP-058", "lon": 10.8011, "lat": 59.9380, "h_m": 96.204},
]
print(json.dumps(verify_against_control("work/dtm_mosaic.tif", CONTROL), indent=2))
```

Verifying the *local* raster against control before uploading is the change that saves the most time on this page. The residual statistics answer both questions at once: a mean near zero with a small RMSE means the raster is right, and a mean of −40 with a small RMSE means the vertical datum is wrong while the surface itself is fine.

A large RMSE with a near-zero mean is a different problem — the surface is noisy or the control points fall on structures the DTM removed — and is worth resolving before terrain becomes the reference everything else is clamped to.

<figure class="diagram">
<svg viewBox="4 10 732 240" role="img" aria-labelledby="ter-resid-t ter-resid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ter-resid-t">Reading the control-point residuals</title>
  <desc id="ter-resid-d">Three residual patterns against survey control. A mean near zero with a root-mean-square error under 0.2 metres means the raster and its declared datum are correct. A mean of about minus 40 metres with the same small spread means the vertical datum is wrong, since the surface shape is right but shifted. A near-zero mean with a spread of several metres means the surface itself is noisy or the control points fall on removed structures.</desc>
  <rect class="svg-bg" x="4" y="10" width="732" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="24" width="160" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="178" y="24" width="150" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="328" y="24" width="150" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="478" y="24" width="244" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="58" width="160" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="178" y="58" width="150" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="328" y="58" width="150" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="478" y="58" width="244" height="50" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="108" width="160" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="178" y="108" width="150" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="328" y="108" width="150" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="478" y="108" width="244" height="50" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="158" width="160" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="178" y="158" width="150" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="328" y="158" width="150" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="478" y="158" width="244" height="50" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="98" y="45">pattern</text><text x="253" y="45">mean</text><text x="403" y="45">RMSE</text><text x="600" y="45">diagnosis</text>
    <text x="98" y="80">good</text><text x="98" y="98">ship it</text>
    <text x="253" y="88">−0.02 m</text><text x="403" y="88">0.11 m</text>
    <text x="600" y="80">raster and declared datum</text><text x="600" y="98">are both correct</text>
    <text x="98" y="130">shifted</text><text x="98" y="148">re-declare</text>
    <text x="253" y="138">−39.8 m</text><text x="403" y="138">0.12 m</text>
    <text x="600" y="130">vertical datum wrong:</text><text x="600" y="148">shape right, height not</text>
    <text x="98" y="180">noisy</text><text x="98" y="198">investigate</text>
    <text x="253" y="188">+0.04 m</text><text x="403" y="188">3.7 m</text>
    <text x="600" y="180">surface noise, or control</text><text x="600" y="198">on removed structures</text>
  </g>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">the mean and the spread separate a datum error from a data-quality error</text>
</svg>
<figcaption>Two statistics from four control points tell you which of three situations you are in before the upload starts.</figcaption>
</figure>

## Expected Output & Verification

```text
912 rasters
CRS values: Counter({'EPSG:25832': 908, 'EPSG:4258': 4})
dtypes: Counter({'float32': 906, 'float64': 6})
resolutions: Counter({(1.0, 1.0): 912})
nodata: Counter({'-9999.0': 880, 'None': 32})
lowest: [('dtm_32_598_6642.tif', -9999.0, 84.21), ...]
masked on average 6.81% of cells
4 raster(s) needed reprojection
{'orthometric_m': 24.0, 'ellipsoidal_m': 63.842, 'separation_m': 39.842}
{'files': 912, 'total_gb': 41.7, 'mosaic': True, 'base_terrain_id': 1, 'water_mask': False}
{'asset_id': 2884401, 'files': 1, 'uploaded_gb': 38.4}
{
  "points": 4, "with_value": 4,
  "mean_m": -0.018, "rmse_m": 0.104, "max_abs_m": 0.141,
  "worst": [{"id": "GP-058", "raster_m": 96.063, "control_m": 96.204, "residual_m": -0.141}]
}
```

Three findings from the inspection that each needed fixing: 32 rasters with no declared nodata, 4 in a different CRS, and 6 in `float64`. The 39.8 m separation confirms the vertical EPSG is the right one for this location, and a 0.10 m RMSE against control says the prepared surface is good.

Verify the tiled asset covers the extent at the depth you expect, since a terrain asset that tiled only to level 12 will look smooth and featureless in a city:

```python
def verify_terrain_levels(asset_id, expect_max_level=14):
    ep = requests.get(f"{API}/assets/{asset_id}/endpoint", headers=HEADERS, timeout=30)
    ep.raise_for_status()
    endpoint = ep.json()
    r = requests.get(f"{endpoint['url']}layer.json",
                     headers={"Authorization": f"Bearer {endpoint['accessToken']}"},
                     timeout=30)
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code}
    layer = r.json()
    avail = layer.get("available", [])
    per_level = [{"level": i, "ranges": len(rs)} for i, rs in enumerate(avail)]
    deepest = max((i for i, rs in enumerate(avail) if rs), default=-1)
    return {"ok": deepest >= expect_max_level, "deepest_level": deepest,
            "tile_scheme": layer.get("scheme"), "projection": layer.get("projection"),
            "levels": per_level[-4:]}

print(json.dumps(verify_terrain_levels(result["asset_id"]), indent=2))
```

Then verify the water bodies are flat rather than shafts, which is the nodata check applied to the tiled output:

```python
def water_flatness_check(local_raster, lake_polygons_gdf, tol_m=0.5):
    """Standard deviation of heights inside each water polygon."""
    import rasterio.mask
    rows = []
    with rasterio.open(local_raster) as ds:
        for _, poly in lake_polygons_gdf.to_crs(ds.crs).iterrows():
            try:
                out, _ = rasterio.mask.mask(ds, [poly.geometry], crop=True, filled=False)
            except ValueError:
                continue
            band = out[0]
            vals = band.compressed()
            vals = vals[~np.isclose(vals, ds.nodata if ds.nodata is not None else -9999.0)]
            if vals.size < 10:
                rows.append({"name": poly.get("name", "?"), "status": "all nodata"})
                continue
            rows.append({"name": poly.get("name", "?"), "n": int(vals.size),
                         "std_m": round(float(vals.std()), 3),
                         "range_m": round(float(vals.max() - vals.min()), 3),
                         "flat": float(vals.std()) <= tol_m})
    bad = [r for r in rows if r.get("flat") is False]
    return {"polygons": len(rows), "not_flat": len(bad), "worst": bad[:3]}
```

## Performance Notes

- **Terrain tiling is the slowest ion operation**: budget 20–40 minutes per 10 GB, doubled with a water mask.
- **DEFLATE with `predictor=3`** typically halves a float32 elevation raster. On 41 GB that is 20 GB less to upload.
- **Mosaic to a COG rather than uploading a VRT.** A VRT references files ion cannot see.
- **Overviews do not help the upload** — ion builds its own pyramid — so skip them in the COG to save space and time.
- **Resolution beyond 1 m rarely pays.** The terrain tiling scheme's deepest level in a city extent is finer than 1 m, but the visual difference against a 0.5 m source is negligible while the cost is 4×.
- **Split above about 100 GB per asset.** Very large single assets tile slowly and fail expensively.

## Common Errors

**Cliffs at every water body and building edge.** Undeclared nodata. Normalise before uploading; it cannot be fixed afterwards.

**The whole city is 40 m too low or too high.** Missing vertical EPSG in `srs`. The control-point mean identifies it before the upload.

**Terracing across the surface.** Reprojection with `nearest`, or an integer dtype holding decimetre values. Use `bilinear` and `float32`.

**A visible square edge where the asset ends.** `baseTerrainId: 0`. Set it to 1 to blend into world terrain.

**`DATA_ERROR` on the terrain asset.** Usually a raster with no CRS at all, or a file that is not elevation — an RGB orthophoto in the same folder is the classic case.

**Terrain looks smooth in the city.** The asset tiled to a shallow level because the source resolution was coarse, or the mosaic's resolution was set by `-resolution average` over mixed inputs. Use `-resolution highest`.

**Buildings float or sink after terrain changes.** Everything clamped to terrain moves when terrain does. Re-verify building heights whenever the terrain asset is replaced.

## Frequently Asked Questions

### DTM or DSM for terrain?

DTM — bare earth. A DSM includes buildings and trees, so a building tileset placed on it sits on top of its own roof. Keep the DSM as a separate asset if it is needed for analysis.

### Should the water mask be enabled?

Only where water rendering matters visually and the extent has significant water. It doubles tiling time and cannot be added later without re-tiling.

### Can I update terrain incrementally?

No — a terrain asset is tiled as a whole. Replacing a district means a new asset, which is why the lineage and pruning process in [listing and pruning old ion assets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/listing-and-pruning-old-ion-assets/) matters for terrain in particular.

## Related Guides

- [Choosing ion Source Types and Options](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/choosing-ion-source-types-and-options/) — the option set this page specialises
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — why the 40 m appears
- [Listing and Pruning Old ion Assets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/listing-and-pruning-old-ion-assets/) — retention for assets that are expensive to rebuild

Back to [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/).
