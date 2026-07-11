# Cesium ion Upload Automation for 3D Tilesets and Point Clouds

Clicking through the Cesium ion web UI to publish a tileset is fine once; it is a liability the tenth time, and it is impossible to reproduce inside a build. The moment a digital twin has a nightly tiling job, a reviewer who needs a fresh preview per pull request, or a compliance requirement that every hosted asset traces back to a commit, the upload has to become code. Cesium ion exposes a REST API that mirrors every UI action: create an asset, receive temporary S3 credentials, push files straight to the bucket, signal completion, and watch ion re-tile the source into streamable 3D Tiles. This guide turns that sequence into a deterministic, idempotent publish step you can drop into [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) or a broader [CI/CD spatial pipeline](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/), using `requests` for the API and `boto3` for the credentialed upload. It assumes you already produce a valid `tileset.json` directory, a `.laz`/`.las` point cloud, or a CityGML export in a known source CRS and now need it hosted without a human in the loop.

## Prerequisites

Pin every component so a publish run replays identically. The ion REST API is versioned under `/v1`; the response envelope described here is stable across the versions below.

| Component | Pinned version | Purpose |
|-----------|----------------|---------|
| Python | 3.10–3.12 | Orchestration, hashing, subprocess control |
| `requests` | 2.31+ | ion REST calls (`POST /v1/assets`, `GET /v1/assets/{id}`) |
| `boto3` | 1.34+ | Upload to the temporary S3 location ion returns |
| `botocore` | 1.34+ | Retries and multipart transfer config |
| Node `3d-tiles-validator` | 0.5+ | Pre-flight validation before any byte leaves CI |
| Cesium ion account | REST access token | Server-side token scoped to `assets:write` |

**Input formats and `sourceType`.** ion re-tiles from a *source*, and the `options.sourceType` you declare on asset creation decides the tiling engine. Use `3DTILES` when you are re-hosting an already-tiled `tileset.json` directory (ion re-packages and optimises it), `POINT_CLOUD` for raw `.laz`/`.las`/`.ply` LiDAR that ion should tile into `pnts`, and `CITYGML` for `.gml`/`.citygml` municipal models ion converts to 3D Tiles. Match `sourceType` to the bytes you upload — feeding a `tileset.json` to a `POINT_CLOUD` source fails during tiling, not at upload, so it costs you a full poll cycle to discover.

**Coordinate reference systems — declare the source, ion owns the target.** ion always re-tiles into **EPSG:4978 (geocentric WGS84 ECEF, metres)**, the frame CesiumJS renders in. You do not control that output CRS, but you must state the *input* CRS explicitly, because ion cannot infer a projected metric grid from raw vertices. For central-European data pass the source as EPSG:25832 (ETRS89 / UTM 32N); for a US survey with orthometric heights declare the compound EPSG:32618+5703 (UTM 18N + NAVD88) so the vertical datum is carried into the geoid-correct ECEF result. A `POINT_CLOUD` upload whose `.laz` header lacks a CRS, or a `3DTILES` root missing its ECEF `transform`, lands kilometres off the ellipsoid — the same EPSG:4978 placement bug that bites local tiling, surfacing here as a hosted asset floating in orbit.

## Concept

The ion REST API models an upload as a short-lived state machine anchored to one asset id. A `POST /v1/assets` call is not just metadata: ion allocates a private S3 prefix and returns three things together — an `assetMetadata` object carrying the permanent integer `id`, an `uploadLocation` object holding *temporary* AWS credentials (access key, secret, session token, bucket, and prefix), and an `onComplete` object describing the callback that tells ion you have finished writing files. The credentials are the crux: you never hand ion your files through the API, you hand them to S3 directly with `boto3`, scoped to that one prefix, expiring in minutes.

Once the bytes are in S3, `POST`-ing the `onComplete` request flips the asset out of `AWAITING_FILES` and hands it to the tiling engine. From there the asset walks `NOT_STARTED` → `IN_PROGRESS` → `COMPLETE`, or diverts to `ERROR`/`DATA_ERROR` if the source is malformed. Tiling is asynchronous and can take seconds or an hour, so the client polls `GET /v1/assets/{id}` on a backoff until it reads a terminal status. The whole dance is safe to automate because every step is a plain HTTP call with a JSON envelope — the only non-`requests` piece is the S3 transfer, and `boto3` handles that with the temporary credentials verbatim. The child walkthrough, [automating ion tileset uploads with the REST API](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/), implements exactly this loop end to end.

<figure class="diagram">
<svg viewBox="0 0 820 350" role="img" aria-labelledby="ion-life-t ion-life-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-life-t">Cesium ion upload lifecycle from create asset to COMPLETE</title>
  <desc id="ion-life-d">A client creates an asset with a POST call, receives temporary S3 credentials, uploads the tileset directory with boto3, posts an onComplete signal, then polls the asset status endpoint in a loop until it reads a terminal COMPLETE state or an ERROR state.</desc>
  <defs>
    <marker id="ion-life-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#ion-life-arrow)">
    <line x1="190" y1="70" x2="223" y2="70"/>
    <line x1="400" y1="70" x2="433" y2="70"/>
    <line x1="610" y1="70" x2="643" y2="70"/>
    <line x1="725" y1="100" x2="725" y2="153"/>
    <line x1="605" y1="185" x2="517" y2="185"/>
    <line x1="660" y1="217" x2="517" y2="252"/>
  </g>
  <path d="M780 168 C 812 164 812 208 780 204" fill="none" stroke="#5b6471" stroke-width="2" marker-end="url(#ion-life-arrow)"/>
  <rect x="20" y="40" width="170" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="225" y="40" width="175" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="435" y="40" width="175" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="645" y="40" width="160" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="605" y="155" width="200" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="335" y="155" width="180" height="60" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="335" y="250" width="180" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g font-size="13" text-anchor="middle">
    <text x="105" y="66" fill="#15384a"><tspan x="105" dy="0">1 Create asset</tspan><tspan x="105" dy="16">POST /v1/assets</tspan></text>
    <text x="312" y="66" fill="#15384a"><tspan x="312" dy="0">2 Temp S3 creds</tspan><tspan x="312" dy="16">uploadLocation</tspan></text>
    <text x="522" y="66" fill="#1f2937"><tspan x="522" dy="0">3 Upload dir</tspan><tspan x="522" dy="16">boto3 upload_file</tspan></text>
    <text x="725" y="66" fill="#15384a"><tspan x="725" dy="0">4 Signal done</tspan><tspan x="725" dy="16">onComplete</tspan></text>
    <text x="705" y="181" fill="#1f2937"><tspan x="705" dy="0">5 Poll status</tspan><tspan x="705" dy="16">GET /v1/assets/{id}</tspan></text>
    <text x="425" y="181" fill="#1f2937"><tspan x="425" dy="0">COMPLETE</tspan><tspan x="425" dy="16">hosted asset id</tspan></text>
    <text x="425" y="281" fill="#1f2937">ERROR / DATA_ERROR</text>
  </g>
  <text x="770" y="149" fill="#5b6471" font-size="12" text-anchor="middle">poll loop</text>
  <text x="612" y="243" fill="#5b6471" font-size="12" text-anchor="start">on ERROR</text>
</svg>
<figcaption>The ion upload lifecycle: create the asset, upload to the temporary S3 location, signal completion, then poll the status endpoint until it reads COMPLETE or ERROR. Tiling to EPSG:4978 ECEF happens server-side between the onComplete signal and the terminal status.</figcaption>
</figure>

## Step-by-Step Workflow

The workflow validates the source, decides whether the asset even needs re-uploading, creates the asset, pushes the bytes to S3, signals completion, polls to a terminal status, and records the hosted id. Every step is scripted so the whole thing is a single CI job.

### 1. Handle the token and configure the session

Never bake an ion token into source. Read it from the environment (a CI secret) and fail loud if it is absent, so a misconfigured runner errors at start instead of sending unauthenticated requests.

```python
import os
import requests

ION_API = "https://api.cesium.com/v1"

def ion_session() -> requests.Session:
    token = os.environ.get("CESIUM_ION_TOKEN")
    if not token:
        raise RuntimeError("CESIUM_ION_TOKEN is not set; add it as a CI secret")
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session

session = ion_session()
```

Scope the token to `assets:write` and `assets:read` only. A token that can also delete assets should never appear in a routine publish job.

### 2. Decide idempotency — skip unchanged sources

Re-tiling an identical source wastes ion processing minutes and mints a duplicate asset id every run. Compute a content hash over the source directory and store it in the asset `description`; on the next run, list existing assets and skip if the hash already matches a `COMPLETE` asset.

```python
import hashlib
from pathlib import Path

def source_digest(source_dir: Path) -> str:
    """Stable SHA-256 over file names + bytes, independent of walk order."""
    h = hashlib.sha256()
    for path in sorted(source_dir.rglob("*")):
        if path.is_file():
            h.update(path.relative_to(source_dir).as_posix().encode())
            h.update(path.read_bytes())
    return h.hexdigest()[:16]

def find_existing(session: requests.Session, digest: str):
    resp = session.get(f"{ION_API}/assets")
    resp.raise_for_status()
    for asset in resp.json()["items"]:
        if asset["status"] == "COMPLETE" and f"digest={digest}" in (asset.get("description") or ""):
            return asset["id"]
    return None

source_dir = Path("tileset")
digest = source_digest(source_dir)
existing_id = find_existing(session, digest)
```

### 3. Create the asset and receive S3 credentials

`POST /v1/assets` allocates the id and the temporary upload location in one response. Set `type` to the delivery format (`3DTILES`) and `options.sourceType` to what you are actually uploading.

```python
def create_asset(session, name, digest, source_type="3DTILES"):
    payload = {
        "name": name,
        "description": f"CI publish; digest={digest}",
        "type": "3DTILES",                       # delivery format ion serves
        "options": {"sourceType": source_type},  # 3DTILES | POINT_CLOUD | CITYGML
    }
    resp = session.post(f"{ION_API}/assets", json=payload)
    resp.raise_for_status()
    body = resp.json()
    return body["assetMetadata"]["id"], body["uploadLocation"], body["onComplete"]

asset_id, upload_location, on_complete = create_asset(
    session, "downtown-block-3dtiles", digest, source_type="3DTILES")
print(f"created ion asset {asset_id}")
```

### 4. Upload the source to the temporary S3 location with boto3

`uploadLocation` carries short-lived AWS credentials scoped to one bucket prefix. Hand them straight to `boto3` — do not persist them, they expire in minutes. Choose between a directory upload (walk every file, preserving relative keys — required for a `3DTILES` `tileset.json` tree) and a single-object upload for a lone `.laz`.

```python
import boto3
from botocore.config import Config

def upload_directory(upload_location: dict, source_dir: Path) -> int:
    s3 = boto3.client(
        "s3",
        aws_access_key_id=upload_location["accessKey"],
        aws_secret_access_key=upload_location["secretAccessKey"],
        aws_session_token=upload_location["sessionToken"],
        endpoint_url=upload_location.get("endpoint"),
        config=Config(retries={"max_attempts": 5, "mode": "standard"}),
    )
    bucket, prefix = upload_location["bucket"], upload_location["prefix"]
    count = 0
    for path in sorted(source_dir.rglob("*")):
        if path.is_file():
            key = f"{prefix}{path.relative_to(source_dir).as_posix()}"
            s3.upload_file(str(path), bucket, key)   # multipart for large tiles
            count += 1
    return count

n = upload_directory(upload_location, source_dir)
print(f"uploaded {n} files to the ion S3 prefix")
```

For very large point clouds, zipping the directory first turns thousands of `upload_file` calls into one and lets ion unpack server-side.

```python
import subprocess

def zip_source(source_dir: Path, archive: Path) -> Path:
    subprocess.run(["zip", "-r", "-q", str(archive), "."],
                   cwd=source_dir, check=True)
    return archive
```

### 5. Signal completion, then poll to a terminal status

`POST` the `onComplete` request exactly as ion described it, then poll `GET /v1/assets/{id}` on a capped backoff. Treat `COMPLETE` as success and `ERROR`/`DATA_ERROR` as a hard failure that surfaces ion's own message.

```python
import time

def finish_upload(session, on_complete: dict):
    resp = session.request(
        on_complete["method"], on_complete["url"],
        json=on_complete.get("fields", {}))
    resp.raise_for_status()

def poll_until_done(session, asset_id, timeout_s=3600):
    delay, waited = 5, 0
    while waited < timeout_s:
        resp = session.get(f"{ION_API}/assets/{asset_id}")
        resp.raise_for_status()
        status = resp.json()["status"]
        if status == "COMPLETE":
            return resp.json()
        if status in ("ERROR", "DATA_ERROR"):
            raise RuntimeError(f"ion tiling failed: {resp.json().get('statusMessage')}")
        time.sleep(delay)
        waited += delay
        delay = min(delay * 2, 60)     # exponential backoff, capped at 60s
    raise TimeoutError(f"asset {asset_id} did not finish within {timeout_s}s")

finish_upload(session, on_complete)
final = poll_until_done(session, asset_id)
print(f"asset {final['id']} is {final['status']} at {final['percentComplete']}%")
```

## Validation & Verification

Validate the source before it leaves CI, then verify the hosted asset after ion reports `COMPLETE`. Local validation is free; a failed tiling job is not.

```bash
# Pre-flight: a 3DTILES source must pass the official validator before upload.
npx 3d-tiles-validator --tilesetFile tileset/tileset.json
```

After the poll returns, re-fetch the asset and assert it is genuinely servable — a `COMPLETE` status with a resolvable id and a non-zero byte count.

```python
def verify_hosted(session, asset_id):
    resp = session.get(f"{ION_API}/assets/{asset_id}")
    resp.raise_for_status()
    meta = resp.json()
    assert meta["status"] == "COMPLETE", f"unexpected status {meta['status']}"
    assert meta["bytes"] > 0, "hosted asset reports zero bytes"
    assert meta["percentComplete"] == 100, "tiling not fully complete"
    print(f"verified asset {asset_id}: {meta['bytes'] / 1e6:.1f} MB, "
          f"type {meta['type']}")
    return meta

verify_hosted(session, asset_id)
```

**Expected values.** A healthy publish leaves `status == "COMPLETE"`, `percentComplete == 100`, and `bytes` in the tens-to-hundreds of megabytes for an urban block. Load it in CesiumJS with `Cesium.Cesium3DTileset.fromIonAssetId(asset_id)` and confirm the tiles snap onto the globe at the survey location — ion has re-tiled the source into EPSG:4978 ECEF, so a model that appears at the planet centre means the source lacked a CRS or an ECEF root transform, not that ion misbehaved.

## Performance & Scale

The wall-clock cost of an ion publish is dominated by two things: the S3 upload and ion's own tiling time. The API calls themselves are milliseconds.

**Upload in parallel, but not the poll.** `boto3`'s `upload_file` is single-threaded per call; for a directory of thousands of small tiles, wrap the loop in a `ThreadPoolExecutor` (S3 uploads are I/O-bound, so threads help where processes would not). Keep the poll strictly sequential with backoff — hammering `GET /v1/assets/{id}` every second wastes rate-limit budget without making ion tile faster.

```python
from concurrent.futures import ThreadPoolExecutor

def upload_parallel(s3, bucket, prefix, source_dir, workers=8):
    files = [p for p in source_dir.rglob("*") if p.is_file()]
    def put(path):
        key = f"{prefix}{path.relative_to(source_dir).as_posix()}"
        s3.upload_file(str(path), bucket, key)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(put, files))
    return len(files)
```

**Skip the work you already did.** The digest check in step 2 is the single biggest scale lever on a steady twin: a nightly job over a mostly-static city re-tiles nothing and re-uploads nothing when the source hash is unchanged, turning a half-hour tiling run into a two-second no-op. Only genuinely changed sources create a new asset. Pair this with archiving large point clouds — one multipart upload of a 4 GB zip beats tens of thousands of tiny `pnts` PUTs, which pay HTTP overhead on every object. For truly city-scale batch publishing across many independent asset directories, drive this per-asset flow from a [3D Tiles batch tiling pipeline](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) so uploads fan out while each asset keeps its own poll loop.

## Failure Modes & Gotchas

**The upload succeeds but tiling ends in DATA_ERROR.** ion accepted every byte, then rejected the *content* — almost always a `sourceType` mismatch (a `tileset.json` uploaded under `POINT_CLOUD`) or a source missing its CRS. The upload cannot catch this because S3 stores arbitrary bytes; only tiling reads them. Match `options.sourceType` to the actual data and, for point clouds, confirm the `.laz` header declares a projected EPSG (EPSG:25832 or EPSG:32618+5703) before upload.

**Temporary S3 credentials expire mid-upload.** The `uploadLocation` credentials live for minutes, so a slow directory of tens of thousands of tiny files can outrun them and start returning `ExpiredToken`. Zip the source into a single object, parallelise the transfer, or re-create the asset to get fresh credentials — do not try to refresh them, they are bound to that one asset allocation.

**Every CI run creates a duplicate asset.** Without the idempotency check, a re-run of an unchanged source mints a fresh id, and the account fills with near-identical assets that all cost storage. Store a content digest in the asset `description` and short-circuit when a `COMPLETE` asset already carries it, as in step 2.

**The poll loop hangs forever on a stuck job.** A tiling job that never reaches a terminal status will spin the poll until the process is killed. Always cap the loop with a `timeout_s` and raise `TimeoutError`, so CI fails cleanly with a diagnosable message instead of a silently wedged runner.

**The hosted asset renders at the centre of the Earth.** ion re-tiles to EPSG:4978 ECEF, but it can only place geometry correctly if the source carried a CRS. A `3DTILES` root without an ECEF `transform`, or a projected source that skipped the geographic-3D hop, lands off the ellipsoid — the same class of bug covered in [automated tile generation](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/). Fix it in the source, before upload.

## Frequently Asked Questions

### Do I upload files through the ion REST API or straight to S3?

Straight to S3. The `POST /v1/assets` response hands you an `uploadLocation` object with temporary AWS credentials scoped to a single bucket prefix; you use `boto3` to write your files there directly, then tell ion you are done with the `onComplete` callback. The REST API never receives your geometry — it only brokers the asset lifecycle and the credentials. This is why the workflow needs both `requests` and `boto3`.

### Which sourceType should I set for a tileset versus a point cloud?

Set `options.sourceType` to `3DTILES` when you upload an already-tiled `tileset.json` directory for ion to re-host, `POINT_CLOUD` for raw LAS/LAZ/PLY LiDAR that ion should tile into pnts, and `CITYGML` for municipal CityGML models. The `type` field stays `3DTILES` because that is always the delivery format ion serves; `sourceType` describes the bytes going in, `type` describes what comes out.

### How long do the temporary upload credentials last?

Only a few minutes — they are short-lived STS credentials tied to the asset you just created. For a large source, parallelise the upload or zip the directory into one object so the transfer finishes inside the window. If they expire, re-create the asset rather than attempting a refresh, because the credentials are bound to that specific asset allocation.

### How do I avoid re-uploading an asset that has not changed?

Compute a stable content hash over the source directory and record it in the asset description, then list existing assets at the start of each run and skip when a COMPLETE asset already carries that hash. This makes the publish step idempotent, so a nightly job over a static city re-tiles nothing and your account does not accumulate duplicate assets.

### What CRS does the hosted asset end up in, and do I control it?

The hosted asset is always in EPSG:4978, geocentric WGS84 ECEF, because that is the frame CesiumJS renders in — you do not control the output CRS. What you must control is the input: declare the source CRS explicitly (EPSG:25832, or the compound EPSG:32618+5703 when heights are orthometric) either in the LAS header or the tileset root transform, so ion places the re-tiled result correctly on the ellipsoid.

## Related Guides

- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — produce the validated tileset this workflow uploads
- [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/) — fan this per-asset publish out across many tilesets
- [Automating ion Tileset Uploads with the REST API](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/) — the full runnable script behind this workflow
- [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) — wire this publish step into a build with GDAL/PDAL jobs
- [Cesium ion platform](https://cesium.com/platform/cesium-ion/) — the managed tiling and hosting service this API drives

Back to [LOD Management & Optimization Strategies](https://www.3d-geospatial.com/lod-management-optimization-strategies/).
