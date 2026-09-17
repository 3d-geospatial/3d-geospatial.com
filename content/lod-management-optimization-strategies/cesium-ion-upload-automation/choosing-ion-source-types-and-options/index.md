# Choosing ion Source Types and Options

This page chooses the right ion asset type and source options for each kind of input — CityGML buildings, LAZ point clouds, photogrammetry meshes, terrain rasters and imagery — explains the options that change the output rather than the ones that do not, and verifies the tiled result against the input before anything depends on it.

## Why you hit this

The upload API takes a `type` and an `options` object, and getting either wrong produces an asset that tiles successfully and is subtly wrong: a point cloud tiled as a mesh, buildings placed at the wrong height, a terrain raster treated as imagery. None of these fail loudly. They produce an asset in `COMPLETE` state that looks plausible until someone measures something.

The second reason is cost and time. Tiling a 400 GB point cloud takes hours and consumes quota; discovering afterwards that the wrong vertical datum was declared means doing it again. The options are worth understanding before the first upload, not after the third.

## Prerequisites

- An ion token with `assets:write` — see [managing ion access tokens and scopes](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/managing-ion-access-tokens-and-scopes/).
- Python 3.10+ with `requests` and `boto3` (the upload step uses S3-compatible credentials returned by the API).
- Knowledge of your input's CRS, including the **vertical** datum, and its units.

## Step-by-Step

### 1. Map the input to an asset type

```python
import json
import os
from pathlib import Path

import requests

API = "https://api.cesium.com/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['ION_UPLOAD_TOKEN']}",
           "Content-Type": "application/json"}

SOURCE_MAP = {
    # extension -> (asset type, sourceType, notes)
    ".las":  ("POINTCLOUD", "POINT_CLOUD", "tiled as 3D Tiles point cloud"),
    ".laz":  ("POINTCLOUD", "POINT_CLOUD", "compressed LAS, same path"),
    ".ply":  ("POINTCLOUD", "POINT_CLOUD", "only if it is points, not a mesh"),
    ".gml":  ("3DTILES", "CITYGML", "CityGML buildings, LOD1/LOD2"),
    ".xml":  ("3DTILES", "CITYGML", "CityGML with an .xml extension"),
    ".obj":  ("3DTILES", "3D_MODEL", "single model or photogrammetry mesh"),
    ".fbx":  ("3DTILES", "3D_MODEL", "model with a scene graph"),
    ".glb":  ("3DTILES", "3D_MODEL", "already glTF; consider self-hosting instead"),
    ".ifc":  ("3DTILES", "BIM", "IFC; check georeferencing first"),
    ".shp":  ("3DTILES", "3D_MODEL", "only with extrusion attributes"),
    ".tif":  ("TERRAIN", "RASTER_TERRAIN", "if it is elevation; IMAGERY if it is colour"),
    ".tiff": ("TERRAIN", "RASTER_TERRAIN", "same"),
    ".kml":  ("3DTILES", "KML", "KML/COLLADA models"),
}

def classify_input(path):
    ext = Path(path).suffix.lower()
    if ext not in SOURCE_MAP:
        raise ValueError(f"no mapping for {ext}; check the ion source type list")
    asset_type, source_type, note = SOURCE_MAP[ext]
    return {"path": str(path), "type": asset_type, "sourceType": source_type, "note": note}

print(json.dumps(classify_input("input/city_lod2.gml"), indent=2))
```

The one mapping that cannot be made from the extension is GeoTIFF: the same file extension carries both elevation and colour, and `TERRAIN` versus `IMAGERY` is a decision about what the pixel values mean. Getting it wrong is visible immediately — imagery tiled as terrain produces a landscape of noise — which makes it the least dangerous of these mistakes.

The dangerous one is `.ply` and `.obj`, where a file can be either points or a mesh. A point cloud tiled as a 3D model produces an enormous asset with one vertex per point and no connectivity, which tiles slowly and renders badly.

<figure class="diagram">
<svg viewBox="4 6 742 264" role="img" aria-labelledby="ion-src-t ion-src-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-src-t">Input to asset type, with the decision that is not automatic</title>
  <desc id="ion-src-d">A table mapping inputs to ion asset types. LAS and LAZ become point cloud assets. CityGML becomes 3D Tiles with the CityGML source type. OBJ and FBX meshes become 3D Tiles with the 3D model source type. IFC becomes 3D Tiles with the BIM source type. A GeoTIFF becomes either terrain or imagery depending on whether its pixels are elevations or colours, which the extension cannot tell you.</desc>
  <rect class="svg-bg" x="4" y="6" width="742" height="264" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="168" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="186" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="362" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="538" y="20" width="194" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="168" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="186" y="52" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="52" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="538" y="52" width="194" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="84" width="168" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="186" y="84" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="84" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="538" y="84" width="194" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="116" width="168" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="186" y="116" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="116" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="538" y="116" width="194" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="148" width="168" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="186" y="148" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="362" y="148" width="176" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="538" y="148" width="194" height="32" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="180" width="168" height="48" fill="#ffffff" stroke="#5b6471"/>
    <rect x="186" y="180" width="176" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="362" y="180" width="176" height="48" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="538" y="180" width="194" height="48" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="102" y="41">input</text><text x="274" y="41">type</text><text x="450" y="41">sourceType</text><text x="635" y="41">the risk</text>
    <text x="102" y="73">.las / .laz</text><text x="274" y="73">POINTCLOUD</text><text x="450" y="73">POINT_CLOUD</text><text x="635" y="73">vertical datum</text>
    <text x="102" y="105">.gml CityGML</text><text x="274" y="105">3DTILES</text><text x="450" y="105">CITYGML</text><text x="635" y="105">LOD selection</text>
    <text x="102" y="137">.obj / .fbx mesh</text><text x="274" y="137">3DTILES</text><text x="450" y="137">3D_MODEL</text><text x="635" y="137">no georeferencing</text>
    <text x="102" y="169">.ifc</text><text x="274" y="169">3DTILES</text><text x="450" y="169">BIM</text><text x="635" y="169">map conversion missing</text>
    <text x="102" y="200">.tif GeoTIFF</text><text x="102" y="218">— elevation or colour?</text>
    <text x="274" y="200">TERRAIN</text><text x="274" y="218">or IMAGERY</text>
    <text x="450" y="200">RASTER_TERRAIN</text><text x="450" y="218">or RASTER_IMAGERY</text>
    <text x="635" y="200">the extension cannot</text><text x="635" y="218">tell you — you must</text>
  </g>
  <text x="375" y="252" fill="#5b6471" font-size="12" text-anchor="middle">every row's real risk is the coordinate reference system, not the type</text>
</svg>
<figcaption>Only one row needs a human decision; every row needs the CRS declared correctly.</figcaption>
</figure>

### 2. Declare the coordinate reference system explicitly

```python
def crs_options(horizontal_epsg, vertical_epsg=None, units="m"):
    """ion accepts an EPSG code or WKT; pass both horizontal and vertical when they differ."""
    opts = {}
    if vertical_epsg:
        opts["baseTerrainId"] = None
        opts["srs"] = f"EPSG:{horizontal_epsg}+{vertical_epsg}"   # compound CRS
    else:
        opts["srs"] = f"EPSG:{horizontal_epsg}"
    if units != "m":
        opts["sourceUnits"] = units
    return {k: v for k, v in opts.items() if v is not None}

PROFILES = {
    "no_lidar_2026": crs_options(25832, 5941),        # ETRS89 / UTM32N + NN2000 heights
    "us_state_plane_ft": crs_options(6350, 6360, units="ft"),
    "wgs84_ellipsoidal": crs_options(4979),
}
print(json.dumps(PROFILES, indent=2))
```

Letting ion guess the CRS from the file's own metadata works when that metadata is right, and LAS headers, CityGML `srsName` attributes and GeoTIFF tags are all frequently wrong or incomplete. Declaring it in the options overrides the guess, and the cost of declaring it when it was already right is zero.

The compound form — horizontal plus vertical EPSG — is what gets heights correct. A point cloud in EPSG:25832 with orthometric heights, uploaded without a vertical code, lands about 40 m off vertically in much of Europe because ion treats the heights as ellipsoidal. The mechanism is the same one described in [handling vertical datums and geoid separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/), and it is the most common single error in ion uploads.

Units matter for US data: a state plane CRS in feet with heights in feet needs both declared, and a silent metre assumption shrinks a city by a factor of 3.28.

### 3. Set the options that actually change the output

```python
OPTION_NOTES = {
    "POINT_CLOUD": {
        "srs": "required in practice; the LAS header is often wrong",
        "geometricErrorScale": "raise above 1.0 to thin aggressively, lower for dense detail",
        "maxPoints": "cap per tile; leave default unless tiles are too heavy",
        "pointCloudColorSource": "RGB, intensity or classification — decides what you see",
    },
    "CITYGML": {
        "srs": "CityGML srsName is frequently absent",
        "clampToTerrain": "true if the model has no reliable base heights",
        "textureFormat": "auto is fine; WEBP cuts bandwidth where textures exist",
    },
    "3D_MODEL": {
        "position": "[lon, lat, height] — a model has no georeferencing of its own",
        "orientation": "heading/pitch/roll in degrees, applied at the position",
        "scale": "only if the model's units are not metres",
    },
    "RASTER_TERRAIN": {
        "baseTerrainId": "1 for Cesium World Terrain as the surround, or 0 for none",
        "waterMask": "adds a water mask layer; costs tiling time",
        "srs": "required when the GeoTIFF lacks a projection",
    },
}

def build_options(source_type, **kwargs):
    known = set(OPTION_NOTES.get(source_type, {}))
    unknown = set(kwargs) - known - {"srs", "sourceUnits"}
    if unknown:
        raise ValueError(f"{source_type}: unrecognised options {sorted(unknown)}")
    return {"sourceType": source_type, **kwargs}

pc_options = build_options("POINT_CLOUD", srs="EPSG:25832+5941",
                           pointCloudColorSource="RGB", geometricErrorScale=1.0)
print(pc_options)
```

`pointCloudColorSource` is the option that most changes what a viewer shows, and the right value depends on the survey: `RGB` for a coloured aerial survey, `intensity` for an uncoloured one where intensity carries the visual structure, `classification` when the point is to show ground versus vegetation versus buildings. A cloud with no RGB uploaded with `RGB` selected renders black.

`geometricErrorScale` is the density dial: values above 1.0 make the client keep coarse tiles longer, which cuts bandwidth and loses detail. Leave it at 1.0 for a first upload and tune only with a measurement in hand.

`position` is not optional for `3D_MODEL`. A model file has no place on Earth, so ion needs one, and omitting it puts the model at the antimeridian on the equator.

### 4. Create the asset and upload

```python
import boto3

def create_asset(name, description, asset_type, options, attribution=""):
    body = {"name": name, "description": description, "type": asset_type,
            "options": options}
    if attribution:
        body["attribution"] = attribution
    r = requests.post(f"{API}/assets", headers=HEADERS, data=json.dumps(body), timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"create failed {r.status_code}: {r.text[:400]}")
    payload = r.json()
    return {"asset": payload["assetMetadata"], "upload": payload["uploadLocation"],
            "on_complete": payload["onComplete"]}

def upload_files(upload_location, files):
    s3 = boto3.client(
        "s3",
        aws_access_key_id=upload_location["accessKey"],
        aws_secret_access_key=upload_location["secretAccessKey"],
        aws_session_token=upload_location["sessionToken"],
    )
    sent = []
    for path in files:
        key = f"{upload_location['prefix']}{Path(path).name}"
        s3.upload_file(str(path), upload_location["bucket"], key)
        sent.append({"file": Path(path).name, "bytes": Path(path).stat().st_size})
    return sent

def start_tiling(on_complete):
    r = requests.request(on_complete["method"], on_complete["url"],
                         headers=HEADERS, data=json.dumps(on_complete.get("fields", {})),
                         timeout=60)
    r.raise_for_status()
    return {"started": True, "status": r.status_code}

created = create_asset("City LOD2 2026-09-17", "CityGML LOD2, ETRS89/UTM32N + NN2000",
                       "3DTILES",
                       build_options("CITYGML", srs="EPSG:25832+5941"),
                       attribution="City of Example, CC BY 4.0")
sent = upload_files(created["upload"], ["input/city_lod2.gml"])
print(created["asset"]["id"], sent)
print(start_tiling(created["on_complete"]))
```

The three-step shape — create, upload to the returned S3 location, then call the `onComplete` endpoint — is the API's design and the reason a half-finished upload leaves an `AWAITING_FILES` asset behind: the create succeeded and the final call never happened. Wrapping the three in one function with a `try`/`finally` that archives the asset on failure keeps the account clean, and is why the pruning job in [listing and pruning old ion assets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/listing-and-pruning-old-ion-assets/) finds stubs at all.

All files for one asset go under the same prefix, which is how a multi-file input — a CityGML set, an OBJ with its MTL and textures, a tiled GeoTIFF — becomes one asset.

### 5. Wait for tiling and read the outcome

```python
import time

def wait_for(asset_id, timeout_s=14400, poll_s=20):
    started = time.time()
    last = None
    while time.time() - started < timeout_s:
        r = requests.get(f"{API}/assets/{asset_id}", headers=HEADERS, timeout=30)
        r.raise_for_status()
        a = r.json()
        state = (a["status"], a.get("percentComplete"))
        if state != last:
            print(f"  {int(time.time() - started):>5}s  {state[0]:<16}{state[1]}%")
            last = state
        if a["status"] == "COMPLETE":
            return {"ok": True, "asset": a, "seconds": round(time.time() - started)}
        if a["status"] in {"ERROR", "DATA_ERROR"}:
            return {"ok": False, "status": a["status"],
                    "message": a.get("errorMessage") or a.get("message"),
                    "seconds": round(time.time() - started)}
        time.sleep(poll_s)
    return {"ok": False, "status": "TIMEOUT", "seconds": round(time.time() - started)}

outcome = wait_for(created["asset"]["id"])
print(json.dumps({k: v for k, v in outcome.items() if k != "asset"}, indent=2))
```

`DATA_ERROR` and `ERROR` mean different things and the distinction saves time: `DATA_ERROR` is a problem with the input — unreadable geometry, an unsupported CityGML profile, a missing texture — and re-uploading the same file will fail the same way. `ERROR` is a tiling failure and is sometimes worth one retry.

The `errorMessage` field is usually specific enough to act on. It is the first thing to read and the most commonly ignored.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="ion-fail-t ion-fail-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-fail-t">Upload states and what each one means</title>
  <desc id="ion-fail-d">A table of five ion asset states. AWAITING_FILES means the create call succeeded and the onComplete call never happened, leaving a stub. IN_PROGRESS with a percentage is normal. COMPLETE means tiling finished. DATA_ERROR means the input itself is unusable and re-uploading the same file will fail identically. ERROR is a tiling failure that is sometimes worth one retry.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="186" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="204" y="20" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="458" y="20" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="186" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="204" y="54" width="254" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="458" y="54" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="88" width="186" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="204" y="88" width="254" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="458" y="88" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="122" width="186" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="204" y="122" width="254" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="122" width="264" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="156" width="186" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="204" y="156" width="254" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="458" y="156" width="264" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="190" width="186" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="204" y="190" width="254" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="458" y="190" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="111" y="42">status</text><text x="331" y="42">what happened</text><text x="590" y="42">what to do</text>
    <text x="111" y="76">AWAITING_FILES</text><text x="331" y="76">onComplete never called</text><text x="590" y="76">delete the stub, re-upload</text>
    <text x="111" y="110">IN_PROGRESS</text><text x="331" y="110">tiling, with a percentage</text><text x="590" y="110">poll every 20 seconds</text>
    <text x="111" y="144">COMPLETE</text><text x="331" y="144">tiled and streamable</text><text x="590" y="144">verify the extent and heights</text>
    <text x="111" y="178">DATA_ERROR</text><text x="331" y="178">the input is unusable</text><text x="590" y="178">fix the data — a retry fails too</text>
    <text x="111" y="212">ERROR</text><text x="331" y="212">tiling failed</text><text x="590" y="212">read errorMessage, retry once</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">DATA_ERROR and ERROR are the distinction that saves time: only one of them is worth retrying.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">AWAITING_FILES stubs are what the pruning job finds months later.</text>
</svg>
<figcaption>Only one of these five states is worth a retry, and knowing which saves an afternoon.</figcaption>
</figure>

### 6. Verify the tiled asset against the input

```python
def verify_extent(asset_id, expected_bbox_wgs84, tol_deg=0.002):
    """Compare ion's reported extent with the input's own bounds."""
    r = requests.get(f"{API}/assets/{asset_id}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    a = r.json()
    got = a.get("bbox")                        # [west, south, east, north]
    if not got:
        return {"checked": False, "reason": "asset reports no bbox"}
    deltas = [round(abs(g - e), 6) for g, e in zip(got, expected_bbox_wgs84)]
    return {"reported": got, "expected": expected_bbox_wgs84, "deltas_deg": deltas,
            "within_tolerance": all(d <= tol_deg for d in deltas)}

def verify_heights(asset_id, expected_min_m, expected_max_m, tol_m=3.0):
    """The vertical-datum check: a 30–40 m offset here means the wrong vertical EPSG."""
    r = requests.get(f"{API}/assets/{asset_id}", headers=HEADERS, timeout=30)
    a = r.json()
    lo, hi = a.get("minHeight"), a.get("maxHeight")
    if lo is None or hi is None:
        return {"checked": False, "reason": "asset reports no height range"}
    return {"reported": [lo, hi], "expected": [expected_min_m, expected_max_m],
            "offset_m": round(((lo - expected_min_m) + (hi - expected_max_m)) / 2, 2),
            "ok": abs(lo - expected_min_m) <= tol_m and abs(hi - expected_max_m) <= tol_m}

print(verify_extent(created["asset"]["id"], [10.6801, 59.8802, 10.8404, 59.9601]))
print(verify_heights(created["asset"]["id"], 0.4, 118.7))
```

The height check is the one that earns its place in CI. A consistent offset of 30 to 45 metres, with the horizontal extent correct, is the unmistakable signature of a missing or wrong vertical EPSG — and it is invisible in a viewer unless the asset is compared against terrain.

An extent that is correct in longitude and wrong in latitude, or mirrored, points at axis order rather than datum; see [detecting swapped axis order in pipeline data](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/detecting-swapped-axis-order-in-pipeline-data/).

<figure class="diagram">
<svg viewBox="4 6 732 230" role="img" aria-labelledby="ion-ver-t ion-ver-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-ver-t">Reading the verification result</title>
  <desc id="ion-ver-d">A decision table for the two checks. Horizontal extent correct and height range correct means the asset is good. Horizontal correct and heights offset by 30 to 45 metres means the vertical EPSG code was wrong or missing. Horizontal mirrored or swapped means axis order. Both wildly wrong means the horizontal EPSG was wrong. A missing height range means the source type was wrong for the input.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="230" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="200" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="218" y="20" width="200" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="418" y="20" width="304" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="218" y="52" width="200" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="418" y="52" width="304" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="218" y="86" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="418" y="86" width="304" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="120" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="218" y="120" width="200" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="418" y="120" width="304" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="154" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="154" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="154" width="304" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="188" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="188" width="200" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="418" y="188" width="304" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="118" y="41">horizontal extent</text><text x="318" y="41">height range</text><text x="570" y="41">what it means</text>
    <text x="118" y="74">matches</text><text x="318" y="74">matches</text><text x="570" y="74">asset is good; record the id</text>
    <text x="118" y="108">matches</text><text x="318" y="108">off by 30–45 m</text><text x="570" y="108">wrong or missing vertical EPSG</text>
    <text x="118" y="142">mirrored or swapped</text><text x="318" y="142">matches</text><text x="570" y="142">axis order in the declared srs</text>
    <text x="118" y="176">nowhere near</text><text x="318" y="176">nowhere near</text><text x="570" y="176">wrong horizontal EPSG entirely</text>
    <text x="118" y="210">matches</text><text x="318" y="210">absent</text><text x="570" y="210">wrong source type for this input</text>
  </g>
</svg>
<figcaption>Two numbers from the asset metadata identify which of four mistakes was made.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "path": "input/city_lod2.gml",
  "type": "3DTILES",
  "sourceType": "CITYGML",
  "note": "CityGML buildings, LOD1/LOD2"
}
2884213 [{'file': 'city_lod2.gml', 'bytes': 1841203344}]
{'started': True, 'status': 204}
     20s  IN_PROGRESS      3%
    340s  IN_PROGRESS      41%
    820s  IN_PROGRESS      88%
    980s  COMPLETE         100%
{"ok": true, "seconds": 980}
{'reported': [10.6803, 59.8801, 10.8402, 59.9603], 'expected': [10.6801, 59.8802, 10.8404, 59.9601],
 'deltas_deg': [0.0002, 0.0001, 0.0002, 0.0002], 'within_tolerance': True}
{'reported': [0.6, 119.2], 'expected': [0.4, 118.7], 'offset_m': 0.35, 'ok': True}
```

A 0.35 m mean height offset is tiling quantisation and is fine; the number to watch for is 30 to 45. The horizontal deltas at the fourth decimal place are about 20 m at this latitude, which is the bounding-box rounding ion applies, not a placement error.

Verify the tiled output is actually usable, by fetching the tileset as a client would and walking one branch:

```python
def verify_streaming(asset_id):
    r = requests.get(f"{API}/assets/{asset_id}/endpoint", headers=HEADERS, timeout=30)
    r.raise_for_status()
    ep = r.json()
    ts = requests.get(ep["url"], headers={"Authorization": f"Bearer {ep['accessToken']}"},
                      timeout=30)
    if ts.status_code != 200:
        return {"ok": False, "tileset_status": ts.status_code}
    doc = ts.json()
    root = doc.get("root", {})
    def depth(t, d=0):
        kids = t.get("children") or []
        return d if not kids else max(depth(c, d + 1) for c in kids)
    first_content = None
    def find_content(t):
        nonlocal first_content
        if first_content:
            return
        uri = (t.get("content") or {}).get("uri")
        if uri:
            first_content = uri
        for c in t.get("children") or []:
            find_content(c)
    find_content(root)
    return {"ok": True, "asset_version": doc.get("asset", {}).get("version"),
            "root_geometric_error": doc.get("geometricError"),
            "tree_depth": depth(root), "has_content": bool(first_content),
            "first_content": (first_content or "")[:60]}

print(json.dumps(verify_streaming(created["asset"]["id"]), indent=2))
```

A tree depth of zero on a city-sized input means everything landed in one tile, which happens when the CRS was declared such that all the geometry collapsed to a point — a CRS error that the extent check can miss if the extent itself was derived from the same wrong declaration.

Then record the asset id where the deploy and the pruning job can both see it:

```python
def record_live(asset_id, manifest="deploy/live_assets.json", label="city_lod2"):
    p = Path(manifest)
    data = json.loads(p.read_text()) if p.exists() else {"asset_ids": [], "labels": {}}
    data["labels"][label] = asset_id
    data["asset_ids"] = sorted(set(data["labels"].values()))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, sort_keys=True))
    return data

print(record_live(created["asset"]["id"]))
```

## Performance Notes

- **Tiling time scales with input size, not asset type**: roughly 10–20 minutes per 100 GB for point clouds, faster for CityGML, much slower for photogrammetry meshes with large textures.
- **Upload bandwidth is usually the bottleneck** for large inputs. `boto3` multipart upload is used automatically above 8 MB; raise the concurrency for a fast link.
- **Compress before uploading.** LAZ instead of LAS is a 5–8× smaller upload for identical tiled output.
- **Poll at 20-second intervals**, not faster. A tiling job of an hour does not need 3,600 status requests.
- **Archive on failure.** A failed asset still counts against storage until it is deleted.
- **Self-hosting is cheaper past a point.** For tilesets you regenerate nightly, the pipeline in [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) plus a CDN avoids per-asset tiling entirely.

## Common Errors

**`400 Bad Request` on create, "unknown option".** Options are per source type; `position` on a `CITYGML` source is rejected. The `build_options` guard catches this locally.

**Asset stuck in `AWAITING_FILES`.** The `onComplete` call was never made, or the upload wrote to the wrong prefix. Both leave a stub to delete.

**`DATA_ERROR` on CityGML.** Usually an unsupported profile or invalid geometry. Validate with `val3dity` or `cjval` first; see [CityGML and CityJSON processing](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/citygml-and-cityjson-processing/).

**Point cloud renders black.** `pointCloudColorSource` is `RGB` on a cloud with no colour. Switch to `intensity` or `classification`.

**Model is at 0°, 0°.** `3D_MODEL` uploaded without `position`. There is no way for ion to infer it.

**Everything is 40 m underground.** Orthometric heights declared as ellipsoidal. Add the vertical EPSG to `srs`.

**City is 3.28× too small.** Feet declared as metres. Set `sourceUnits`.

## Frequently Asked Questions

### Should I upload GLB, or self-host it?

If the glTF is already tiled, self-host — uploading finished 3D Tiles to ion adds a tiling step that has nothing to do. ion earns its place when it does work you would otherwise write: point-cloud tiling, terrain meshing, CityGML conversion.

### Can I change options after tiling?

No. Options apply at tiling time, so a wrong CRS means a new asset. This is the reason to verify on a small extract before committing a 400 GB upload.

### How do I test options cheaply?

Clip a 500 m square from the input and upload that. It tiles in under a minute and exercises exactly the same option handling, which makes the CRS mistakes cost a minute instead of six hours.

## Related Guides

- [Uploading Terrain Rasters to ion](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/uploading-terrain-rasters-to-ion/) — the terrain path in detail
- [Managing ion Access Tokens and Scopes](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/managing-ion-access-tokens-and-scopes/) — the token these calls need
- [Listing and Pruning Old ion Assets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/listing-and-pruning-old-ion-assets/) — clearing up what these uploads leave behind

Back to [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/).
