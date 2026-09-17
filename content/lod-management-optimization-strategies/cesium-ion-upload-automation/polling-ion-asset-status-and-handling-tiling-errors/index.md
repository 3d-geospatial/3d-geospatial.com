# Polling Cesium ion Asset Status and Handling Tiling Errors

This page makes the wait after a Cesium ion upload dependable — polling `GET /v1/assets/{id}` with backoff and jitter, recognising each status the tiling job can report, detecting a job whose `percentComplete` has stopped moving, separating input errors that must fail the build from service errors worth one retry, and deleting the assets a failed run leaves behind.

## Why you hit this

Uploading to ion is the quick part. The asset then spends minutes to hours in a tiling queue, and a pipeline has to wait for it before it can publish a viewer link, update a tileset reference or declare a nightly build green. The first version of that wait is usually `while status != "COMPLETE": sleep(10)`, and it fails in every interesting way: it loops forever on `DATA_ERROR`, it hammers the API from a dozen parallel jobs, it treats a job that stopped at 43% for two hours as healthy, and every retry creates another orphaned asset in the account. The upload half of the workflow is covered in [automating ion tileset uploads with the REST API](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/).

## Prerequisites

- Python 3.10+ with `requests>=2.31`.
- A Cesium ion access token with `assets:read`, `assets:write` and `assets:list` scopes, supplied as the `CESIUM_ION_TOKEN` environment variable — never committed.
- An upload step that returns the new asset's `id` after calling the `onComplete` endpoint.
- Source data already validated locally; for example, a CityGML or glTF source in EPSG:4326 or with an explicit `srsName`, or LAZ in EPSG:32618 with a CRS in its header.

## Step-by-Step

### 1. Build a session that retries transport errors only

```python
import os
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API = "https://api.cesium.com/v1"

def ion_session():
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {os.environ['CESIUM_ION_TOKEN']}"
    retry = Retry(total=5, backoff_factor=1.5, status_forcelist=(429, 502, 503, 504),
                  allowed_methods=("GET", "DELETE"), respect_retry_after_header=True)
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s

session = ion_session()
```

Transport-level retries belong in the HTTP adapter, where they are invisible to the polling logic: a 503 during one poll should look like a slightly slower poll, not like a failed job. `POST` is deliberately excluded from automatic retries, because retrying an asset-creation request that actually succeeded creates a duplicate asset.

### 2. Poll with backoff, jitter and a stall detector

```python
import random
import time
from dataclasses import dataclass

TERMINAL = {"COMPLETE", "ERROR", "DATA_ERROR"}

@dataclass
class PollResult:
    status: str
    percent: int
    elapsed_s: float
    reason: str

def wait_for_asset(asset_id, timeout_s=4 * 3600, stall_s=45 * 60, first_delay=10, max_delay=120):
    start = time.monotonic()
    delay = first_delay
    last_percent, last_progress_at = -1, start
    while True:
        r = session.get(f"{API}/assets/{asset_id}", timeout=30)
        r.raise_for_status()
        asset = r.json()
        status, percent = asset["status"], int(asset.get("percentComplete") or 0)
        now = time.monotonic()

        if percent > last_percent:
            last_percent, last_progress_at = percent, now
        print(f"[{now - start:7.0f}s] asset {asset_id}: {status} {percent}%")

        if status in TERMINAL:
            return PollResult(status, percent, now - start, "terminal")
        if status == "AWAITING_FILES" and now - start > 15 * 60:
            return PollResult(status, percent, now - start, "upload never completed")
        if status == "IN_PROGRESS" and now - last_progress_at > stall_s:
            return PollResult(status, percent, now - start, f"no progress for {stall_s // 60} min")
        if now - start > timeout_s:
            return PollResult(status, percent, now - start, "timeout")

        time.sleep(delay * random.uniform(0.8, 1.2))
        delay = min(max_delay, delay * 1.6)
```

The poll interval starts short, so a small asset that tiles in a minute is noticed quickly, and grows to two minutes, so a four-hour city job costs about 130 requests rather than 1,400. Jitter keeps twenty parallel CI jobs from polling in lockstep. The stall detector watches `percentComplete` rather than wall-clock time alone: a big job progressing slowly is healthy, while a job whose percentage has not moved for 45 minutes is not, whatever the total elapsed time.

<figure class="diagram">
<svg viewBox="6 6 748 248" role="img" aria-labelledby="ion-state-t ion-state-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-state-t">Asset status transitions during tiling</title>
  <desc id="ion-state-d">An asset starts in AWAITING_FILES until the upload's completion call is made, moves to NOT_STARTED while queued, then IN_PROGRESS while tiling, and ends in one of three terminal states: COMPLETE, DATA_ERROR for a problem with the input, or ERROR for a problem in the service. Two non-terminal traps are marked: AWAITING_FILES that never advances, and IN_PROGRESS with a stalled percentage.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="248" fill="#ffffff"/>
  <defs>
    <marker id="ion-state-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="90" width="140" height="44" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="200" y="90" width="130" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="370" y="90" width="130" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="580" y="20" width="160" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="580" y="90" width="160" height="44" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="580" y="160" width="160" height="44" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ion-state-arrow)">
    <path d="M160 112 H198"/>
    <path d="M330 112 H368"/>
    <path d="M500 104 L578 46"/>
    <path d="M500 112 H578"/>
    <path d="M500 120 L578 178"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="90" y="117">AWAITING_FILES</text>
    <text x="265" y="117">NOT_STARTED</text>
    <text x="435" y="117">IN_PROGRESS</text>
    <text x="660" y="47">COMPLETE</text>
    <text x="660" y="117">DATA_ERROR</text>
    <text x="660" y="187">ERROR</text>
  </g>
  <text x="90" y="160" fill="#9a4f26" font-size="12" text-anchor="middle">trap: onComplete</text>
  <text x="90" y="176" fill="#9a4f26" font-size="12" text-anchor="middle">never called</text>
  <text x="435" y="160" fill="#9a4f26" font-size="12" text-anchor="middle">trap: percent stalls</text>
  <text x="380" y="236" fill="#15384a" font-size="12.5" text-anchor="middle">Three terminal states, two traps that look like waiting.</text>
</svg>
<figcaption>The poller needs an exit for every terminal state and a limit for each of the two states that can wait forever.</figcaption>
</figure>

### 3. Classify the outcome and decide whether to retry

```python
def decide(result):
    if result.status == "COMPLETE":
        return "publish"
    if result.status == "DATA_ERROR":
        return "fail"          # the input is wrong; retrying uploads the same wrong input
    if result.status == "ERROR":
        return "retry"         # service-side failure; one fresh attempt is reasonable
    if result.reason == "upload never completed":
        return "retry"         # the onComplete call was lost; start again cleanly
    return "fail"              # stalls and timeouts need a human, not a loop
```

The asymmetry between the two error states is the whole policy. `DATA_ERROR` means ion could not process what it was given — a CityGML file with no geometry in the expected LOD, a glTF with invalid accessors, a point cloud with no CRS. Uploading the same bytes again produces the same result, an hour later, and hides the real problem behind a retry log. `ERROR` indicates something went wrong on the service side; one retry with a fresh asset is proportionate, more than one is a loop.

### 4. Retry with a fresh asset and delete the failed one

```python
def delete_asset(asset_id):
    r = session.delete(f"{API}/assets/{asset_id}", timeout=30)
    if r.status_code not in (204, 404):
        r.raise_for_status()

def upload_and_wait(upload_fn, max_attempts=2):
    history = []
    for attempt in range(1, max_attempts + 1):
        asset_id = upload_fn()
        result = wait_for_asset(asset_id)
        action = decide(result)
        history.append((attempt, asset_id, result.status, result.reason, action))
        if action == "publish":
            return asset_id, history
        delete_asset(asset_id)
        if action == "fail":
            break
    raise RuntimeError(f"ion tiling failed: {history}")
```

Deleting the failed asset before retrying keeps the account clean and makes the pipeline idempotent from the account's point of view: after any run, success or failure, exactly zero or one asset exists for that build. A `404` on delete is treated as success, because a previous run may already have removed it.

<figure class="diagram">
<svg viewBox="32 64 681 160" role="img" aria-labelledby="ion-poll-t ion-poll-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-poll-t">Poll interval growth over a long tiling job</title>
  <desc id="ion-poll-d">A timeline of poll requests over a four-hour job. Early polls are ten seconds apart and the gap grows by a factor of 1.6 until it reaches two minutes, after which it stays constant. A fixed ten-second interval would make about 1,440 requests over the same period; the growing interval makes about 130.</desc>
  <rect class="svg-bg" x="32" y="64" width="681" height="160" fill="#ffffff"/>
  <path d="M40 120 H720" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#1f6b8a" stroke-width="2" fill="none">
    <path d="M50 104 V136"/><path d="M58 104 V136"/><path d="M70 104 V136"/><path d="M90 104 V136"/><path d="M120 104 V136"/>
    <path d="M168 104 V136"/><path d="M240 104 V136"/><path d="M330 104 V136"/><path d="M420 104 V136"/><path d="M510 104 V136"/>
    <path d="M600 104 V136"/><path d="M690 104 V136"/>
  </g>
  <g stroke="#b0413e" stroke-width="1" fill="none">
    <path d="M50 160 V176"/><path d="M60 160 V176"/><path d="M70 160 V176"/><path d="M80 160 V176"/><path d="M90 160 V176"/><path d="M100 160 V176"/>
    <path d="M110 160 V176"/><path d="M120 160 V176"/><path d="M130 160 V176"/><path d="M140 160 V176"/><path d="M150 160 V176"/><path d="M160 160 V176"/>
    <path d="M170 160 V176"/><path d="M180 160 V176"/><path d="M190 160 V176"/><path d="M200 160 V176"/><path d="M210 160 V176"/><path d="M220 160 V176"/>
  </g>
  <text x="80" y="92" fill="#1f6b8a" font-size="12.5" text-anchor="start">backoff: 10 s growing to 120 s → ≈130 requests</text>
  <text x="240" y="174" fill="#b0413e" font-size="12.5" text-anchor="start">fixed 10 s → ≈1,440 requests …</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="50" y="206">0</text><text x="240" y="206">20 min</text><text x="470" y="206">2 h</text><text x="690" y="206">4 h</text>
  </g>
</svg>
<figcaption>Most of a long job is spent at the capped interval, which is where nearly all of the saved requests come from.</figcaption>
</figure>

### 5. Report the result to CI

```python
import json
import sys

try:
    asset_id, history = upload_and_wait(lambda: upload_citygml("build/district_09.gml"))
except RuntimeError as exc:
    print(f"::error title=Cesium ion tiling failed::{exc}")
    sys.exit(2)

summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write(f"### Cesium ion asset {asset_id}\n\n| attempt | asset | status | note |\n|---|---|---|---|\n")
        for attempt, aid, status, reason, _ in history:
            f.write(f"| {attempt} | {aid} | {status} | {reason} |\n")
with open("build/ion_asset.json", "w") as f:
    json.dump({"asset_id": asset_id, "attempts": len(history)}, f)
```

A distinct exit code for tiling failure lets the workflow tell "ion rejected the data" from "the job crashed", and the step summary puts the attempt history where a reviewer will see it without opening logs. `upload_citygml` stands for whatever function your upload step exposes that returns the new asset id.

## Expected Output & Verification

```text
[      0s] asset 2718281: NOT_STARTED 0%
[     11s] asset 2718281: IN_PROGRESS 0%
[     27s] asset 2718281: IN_PROGRESS 4%
…
[   2911s] asset 2718281: IN_PROGRESS 97%
[   3033s] asset 2718281: COMPLETE 100%
```

Verify the outcome rather than the status. After `COMPLETE`, request an endpoint for the asset — `GET /v1/assets/{id}/endpoint` returns the tileset URL and a short-lived access token — and fetch its `tileset.json`. Confirm the root bounding volume encloses the source data's extent after converting that extent to radians, so that a job which completed on the wrong coordinates, for example a CityGML file with an ignored `srsName`, is caught before anyone opens a viewer.

<figure class="diagram">
<svg viewBox="6 6 748 218" role="img" aria-labelledby="ion-dec-t ion-dec-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-dec-t">Outcome to action</title>
  <desc id="ion-dec-d">A table maps each poll outcome to an action. COMPLETE leads to publish after verifying bounds. DATA_ERROR fails the build immediately and deletes the asset. ERROR deletes the asset and retries once. AWAITING_FILES beyond fifteen minutes deletes and retries once. A stall or timeout deletes the asset and fails for a human to investigate.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="218" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="300" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="320" y="20" width="420" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="58" width="300" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="320" y="58" width="420" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="96" width="300" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="96" width="420" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="134" width="300" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="320" y="134" width="420" height="38" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="172" width="300" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="320" y="172" width="420" height="38" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="36" y="44">COMPLETE</text>
    <text x="336" y="44">verify bounds, then publish</text>
    <text x="36" y="82">DATA_ERROR</text>
    <text x="336" y="82">delete, fail now: fix the input</text>
    <text x="36" y="120">ERROR</text>
    <text x="336" y="120">delete, retry once with a new asset</text>
    <text x="36" y="158">AWAITING_FILES &gt; 15 min</text>
    <text x="336" y="158">delete, retry once: onComplete was lost</text>
    <text x="36" y="196">stalled or timed out</text>
    <text x="336" y="196">delete, fail for a human to investigate</text>
  </g>
</svg>
<figcaption>Only the service-side and lost-completion cases are retried, and only once; everything else either succeeds or fails loudly.</figcaption>
</figure>

## Common Errors

**`401 Unauthorized` partway through a long poll.** The token was a short-lived one issued for the upload rather than a long-lived access token with `assets:read`. Use a dedicated CI token with the scopes listed in the prerequisites.

**The asset sits in `AWAITING_FILES` indefinitely.** The files reached S3 but the `onComplete` request was never sent, often because the upload function raised after the last part and the completion call was in a `finally` that did not run. The fifteen-minute rule above turns this into a retry instead of a four-hour timeout.

**`DATA_ERROR` on a CityGML file that opens fine locally.** Check the geometry LOD and `srsName`: ion tiles the geometry it can find and needs a recognisable CRS, and a file that only contains LOD1 solids when the upload options expected LOD2 surfaces, or one whose `srsName` is a local engineering system, fails as a data error.

## Frequently Asked Questions

### Can I get a callback instead of polling?

The asset REST API is poll-based. For many parallel jobs, a single scheduler that polls all pending asset ids at a shared, capped interval is cheaper than one poller per job.

### How long is a reasonable timeout?

Scale it with the input. A few hundred megabytes of glTF typically finishes in minutes; multi-gigabyte point clouds or city-wide CityGML can take hours. Record elapsed time per asset type and size from past runs and set the timeout at two to three times the 95th percentile.

### Should a failed nightly build keep the previous asset live?

Yes. Publish by switching a reference — a tileset id in configuration, or a CDN alias — only after verification passes, so a failure leaves users on yesterday's data rather than on nothing. The same pattern is used for self-hosted tilesets in [cache invalidation for versioned tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/cache-invalidation-for-versioned-tilesets/).

## Related Guides

- [Automating ion Tileset Uploads with the REST API](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/) — the upload step this waits on
- [GitHub Actions GDAL/PDAL Pipeline Jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the CI job that runs it
- [Automated 3D Tiles Deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — the self-hosted alternative

Back to [Cesium ion Upload Automation for 3D Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/).
