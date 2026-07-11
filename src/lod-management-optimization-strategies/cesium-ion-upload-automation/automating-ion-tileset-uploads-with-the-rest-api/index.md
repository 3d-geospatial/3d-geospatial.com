---
title: "Automating ion Tileset Uploads With the REST API"
description: "Runnable Python script to upload a local 3D Tiles directory to Cesium ion via the REST API and boto3: create asset, S3 upload, onComplete, poll to COMPLETE."
---
# Automating ion Tileset Uploads With the REST API and Temporary S3 Credentials

This walkthrough uploads a local 3D Tiles directory to Cesium ion entirely from a Python script — creating the asset with `requests`, pushing every file to ion's temporary S3 location with `boto3`, posting the `onComplete` signal, and polling `GET /v1/assets/{id}` until the status reads `COMPLETE`. It is the concrete, runnable version of the [Cesium ion upload automation](/lod-management-optimization-strategies/cesium-ion-upload-automation/) workflow, aimed at a `tileset.json` tree you have already built and validated locally.

You reach for this the first time you want a hosted preview from CI instead of dragging a folder into the ion web UI — a per-pull-request deploy, a nightly refresh, or any publish that has to be reproducible and leave an audit trail.

## Prerequisites

- Python 3.10+ with `pip install "requests>=2.31" "boto3>=1.34"`.
- A Cesium ion access token with `assets:write` and `assets:read`, exported as `CESIUM_ION_TOKEN` (a CI secret, never committed).
- A local `tileset.json` directory that already passes `npx 3d-tiles-validator --tilesetFile tileset/tileset.json`. The source geometry is assumed to carry a CRS — a projected metric grid such as EPSG:25832 (ETRS89 / UTM 32N) with an ECEF root `transform` — because ion re-tiles into **EPSG:4978 (geocentric WGS84 ECEF)** and cannot place a source that lacks one.
- Network egress to `api.cesium.com` and to the AWS S3 endpoint ion returns.

The asset moves through a small status machine once you signal completion; the script's job is to drive it to a terminal state and fail loudly on `ERROR`.

<figure class="diagram">
<svg viewBox="0 0 800 300" role="img" aria-labelledby="ion-fsm-t ion-fsm-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-fsm-t">Cesium ion asset status state machine</title>
  <desc id="ion-fsm-d">After onComplete an asset moves from AWAITING_FILES to NOT_STARTED to IN_PROGRESS; the client polls IN_PROGRESS in a loop until it transitions to the terminal COMPLETE state or to the terminal ERROR or DATA_ERROR state.</desc>
  <defs>
    <marker id="ion-fsm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#ion-fsm-arrow)">
    <line x1="170" y1="148" x2="207" y2="148"/>
    <line x1="360" y1="148" x2="397" y2="148"/>
    <line x1="550" y1="135" x2="607" y2="82"/>
    <line x1="550" y1="161" x2="607" y2="216"/>
  </g>
  <path d="M430 120 C 425 86 505 86 500 120" fill="none" stroke="#5b6471" stroke-width="2" marker-end="url(#ion-fsm-arrow)"/>
  <rect x="20" y="120" width="150" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="210" y="120" width="150" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="400" y="120" width="150" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="610" y="50" width="170" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="610" y="192" width="170" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g font-size="12.5" text-anchor="middle">
    <text x="95" y="152" fill="#15384a">AWAITING_FILES</text>
    <text x="285" y="152" fill="#15384a">NOT_STARTED</text>
    <text x="475" y="152" fill="#1f2937">IN_PROGRESS</text>
    <text x="695" y="82" fill="#1f2937">COMPLETE</text>
    <text x="695" y="224" fill="#1f2937">ERROR / DATA_ERROR</text>
  </g>
  <text x="465" y="78" fill="#5b6471" font-size="12" text-anchor="middle">poll GET /v1/assets/{id}</text>
  <text x="190" y="110" fill="#5b6471" font-size="12" text-anchor="middle">onComplete</text>
  <text x="380" y="110" fill="#5b6471" font-size="12" text-anchor="middle">tiling begins</text>
  <text x="583" y="118" fill="#5b6471" font-size="12" text-anchor="middle">success</text>
  <text x="585" y="188" fill="#5b6471" font-size="12" text-anchor="middle">bad source</text>
</svg>
<figcaption>The ion asset status machine: onComplete releases the asset to tiling, the client polls the IN_PROGRESS state, and the asset settles in COMPLETE or an ERROR terminal state.</figcaption>
</figure>

## Step-by-Step

### 1. Create the asset and capture the upload location

One `POST /v1/assets` returns the asset id, the temporary S3 credentials, and the `onComplete` descriptor together. Declare `sourceType` as `3DTILES` because you are re-hosting an existing tileset.

```python
import os
import requests

ION_API = "https://api.cesium.com/v1"
token = os.environ["CESIUM_ION_TOKEN"]           # KeyError here means the secret is unset
session = requests.Session()
session.headers.update({"Authorization": f"Bearer {token}"})

resp = session.post(f"{ION_API}/assets", json={
    "name": "downtown-block",
    "description": "REST upload of local tileset",
    "type": "3DTILES",
    "options": {"sourceType": "3DTILES"},
})
resp.raise_for_status()
body = resp.json()

asset_id = body["assetMetadata"]["id"]
upload_location = body["uploadLocation"]
on_complete = body["onComplete"]
print(f"created asset {asset_id}")
```

The response is the only place the temporary credentials appear, so capture `uploadLocation` and `on_complete` immediately rather than re-requesting them — a second `POST` would allocate a *different* asset with a *different* S3 prefix. The `assetMetadata.id` is the permanent handle you will reference from CesiumJS; everything else in the response is short-lived scaffolding for this one publish.

### 2. Upload the tileset directory with boto3

Build an S3 client from the temporary credentials and walk the directory, preserving each file's path relative to the tileset root as its S3 key. That relative layout is what keeps `tileset.json`'s content URIs resolvable after ion ingests them.

```python
from pathlib import Path
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    aws_access_key_id=upload_location["accessKey"],
    aws_secret_access_key=upload_location["secretAccessKey"],
    aws_session_token=upload_location["sessionToken"],
    endpoint_url=upload_location.get("endpoint"),
    config=Config(retries={"max_attempts": 5, "mode": "standard"}),
)

source_dir = Path("tileset")
bucket, prefix = upload_location["bucket"], upload_location["prefix"]

uploaded = 0
for path in sorted(source_dir.rglob("*")):
    if path.is_file():
        key = f"{prefix}{path.relative_to(source_dir).as_posix()}"
        s3.upload_file(str(path), bucket, key)
        uploaded += 1
print(f"uploaded {uploaded} files to s3://{bucket}/{prefix}")
```

Two details matter here. First, `botocore`'s standard retry mode absorbs the transient 5xx and throttling responses S3 returns under load, so a single slow tile does not abort the whole upload. Second, `upload_file` automatically switches to a multipart transfer for large objects, which is what lets a single dense `pnts` tile of hundreds of megabytes go up without a bespoke chunking loop. If the tileset holds tens of thousands of tiny files, the per-object HTTP overhead dominates and the transfer can outlast the temporary credentials — in that case, zip the directory and upload one archive instead:

```python
import subprocess

archive = source_dir.parent / "tileset.zip"
subprocess.run(["zip", "-r", "-q", str(archive), "."], cwd=source_dir, check=True)
s3.upload_file(str(archive), bucket, f"{prefix}tileset.zip")   # ion unpacks server-side
```

### 3. Signal completion

Post the `onComplete` request exactly as ion described it — its `method`, `url`, and `fields` are all supplied in the create response, so echo them back rather than hard-coding the path.

```python
done = session.request(
    on_complete["method"],
    on_complete["url"],
    json=on_complete.get("fields", {}),
)
done.raise_for_status()
print("onComplete acknowledged; ion is tiling")
```

Until this call lands, the asset sits in `AWAITING_FILES` and ion assumes more bytes may arrive. The `onComplete` request is the explicit handoff that tells ion the upload is finished and tiling may begin — skip it and the asset never leaves `AWAITING_FILES`, no matter how many files you uploaded. Echoing ion's supplied `method` and `fields` rather than assuming `POST` keeps the script correct even if a future API revision changes the callback shape.

### 4. Poll until COMPLETE and handle ERROR

Poll `GET /v1/assets/{id}` on an exponential backoff. Return on `COMPLETE`, raise on `ERROR`/`DATA_ERROR` with ion's own message, and cap the total wait so a stuck job cannot hang the runner.

```python
import time

def poll_until_done(session, asset_id, timeout_s=3600):
    delay, waited = 5, 0
    while waited < timeout_s:
        r = session.get(f"{ION_API}/assets/{asset_id}")
        r.raise_for_status()
        meta = r.json()
        status = meta["status"]
        print(f"  {status} {meta['percentComplete']}%")
        if status == "COMPLETE":
            return meta
        if status in ("ERROR", "DATA_ERROR"):
            raise RuntimeError(f"tiling failed: {meta.get('statusMessage')}")
        time.sleep(delay)
        waited += delay
        delay = min(delay * 2, 60)
    raise TimeoutError(f"asset {asset_id} not done after {timeout_s}s")

final = poll_until_done(session, asset_id)
print(f"asset {final['id']} COMPLETE — {final['bytes'] / 1e6:.1f} MB in EPSG:4978")
```

The backoff is what keeps this loop a good citizen: it starts at five seconds and doubles to a sixty-second ceiling, so a job that tiles in ten seconds is caught quickly while an hour-long city-scale job does not burn thousands of requests against your rate limit. Surfacing `statusMessage` on failure matters because ion's message names the actual defect — an unreferenced content URI, an unsupported extension, a missing CRS — which turns a red build into a one-line fix instead of a guessing game. To keep the run idempotent across repeated CI invocations, record `asset_id` alongside a hash of the source so a later run can skip an unchanged tileset, exactly as the parent [Cesium ion upload automation](/lod-management-optimization-strategies/cesium-ion-upload-automation/) workflow describes.

## Expected Output & Verification

A successful run prints the created id, the upload count, then one line per poll as ion climbs to 100%:

```text
created asset 2831045
uploaded 214 files to s3://assets.cesium.com/sources/2831045/
onComplete acknowledged; ion is tiling
  NOT_STARTED 0%
  IN_PROGRESS 37%
  IN_PROGRESS 82%
  COMPLETE 100%
asset 2831045 COMPLETE — 48.6 MB in EPSG:4978
```

Confirm the asset is genuinely servable, not merely present, before you rely on it:

```python
check = session.get(f"{ION_API}/assets/{asset_id}").json()
assert check["status"] == "COMPLETE"
assert check["percentComplete"] == 100
assert check["bytes"] > 0
print("verified:", check["id"], check["type"])
```

Then load it in CesiumJS with `Cesium.Cesium3DTileset.fromIonAssetId(asset_id)` and confirm the tiles land at the survey location on the globe. ion has re-tiled your source into EPSG:4978 ECEF; geometry that appears at the planet's centre means the source lacked a CRS or ECEF root transform, which you fix in the tileset, not in this script.

## Common Errors

**`botocore.exceptions.ClientError: An error occurred (ExpiredToken)`.** The temporary S3 credentials lived only a few minutes and the directory upload outran them. Zip the tileset into a single object and upload that, or re-run from step 1 to mint a fresh asset with fresh credentials — the credentials are bound to one asset and cannot be refreshed in place.

**`RuntimeError: tiling failed: ...` with status DATA_ERROR.** ion stored every byte, then rejected the content during tiling — typically a `sourceType` mismatch or a source with no CRS. Confirm `options.sourceType` is `3DTILES` for a tileset directory and that the tileset root carries an ECEF `transform`; a missing CRS is the usual cause of a DATA_ERROR that only appears after upload.

**`requests.exceptions.HTTPError: 401 Client Error: Unauthorized`.** The `CESIUM_ION_TOKEN` is missing, expired, or scoped without `assets:write`. Verify the environment variable is set in the CI runner and that the token can create assets — a read-only token authenticates but is rejected on `POST /v1/assets`.

## Related Guides

- [Cesium ion Upload Automation for 3D Tilesets](/lod-management-optimization-strategies/cesium-ion-upload-automation/) — the concepts, idempotency, and sourceType choices behind this script
- [Automated Tile Generation for 3D Geospatial](/lod-management-optimization-strategies/automated-tile-generation/) — build and validate the tileset before you upload it
- [CI/CD Automation for Spatial Pipelines](/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — run this upload as a job in a spatial build

Back to [Cesium ion Upload Automation for 3D Tilesets](/lod-management-optimization-strategies/cesium-ion-upload-automation/).
