---
title: "Automated 3D Tiles Deployment to a CDN"
description: "Deploy a validated 3D Tiles set to S3 or Cloudflare R2 from CI with boto3 and aws s3 sync: Content-Type/Content-Encoding for gzipped tileset.json and b3dm, cache-control, atomic prefix swap."
---
# Automatically Deploying a Validated 3D Tileset to a CDN or Object Store

This guide deploys a validated 3D Tiles set from CI to an object store fronted by a CDN — Amazon S3 or Cloudflare R2 — using `boto3` and `aws s3 sync`, setting the correct `Content-Type` and `Content-Encoding` for gzipped `tileset.json` and `.b3dm` payloads, applying long-lived `Cache-Control`, invalidating the edge, and swapping an atomic versioned prefix so clients never see a half-uploaded tileset.

You need this once the tileset is more than a folder you drag into a bucket: browsers refuse to decode a gzipped `.b3dm` served without `Content-Encoding: gzip`, a stale `tileset.json` pins clients to deleted tiles, and a mid-sync deploy shows users a broken tree. This is the publish stage of the [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) workflow, and it runs only after the [schema validation gate](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) is green.

<figure class="diagram">
<svg viewBox="6 81 828 142" role="img" aria-labelledby="cdn-t cdn-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-t">Atomic versioned deploy of a tileset to object storage and CDN</title>
  <desc id="cdn-d">A validated artifact is synced to a versioned prefix with correct content types and cache headers, then an atomic pointer swap moves the live alias to the new release, and the CDN edge is invalidated.</desc>
  <rect class="svg-bg" x="6" y="81" width="828" height="142" fill="#ffffff"/>
  <defs>
    <marker id="cdn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="95" width="150" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="210" y="95" width="180" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="430" y="95" width="170" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="640" y="95" width="180" height="70" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#cdn-arrow)">
    <line x1="170" y1="130" x2="208" y2="130"/>
    <line x1="390" y1="130" x2="428" y2="130"/>
    <line x1="600" y1="130" x2="638" y2="130"/>
  </g>
  <g fill="#1f2937" font-size="13" text-anchor="middle">
    <text x="95" y="126"><tspan x="95" dy="0">Validated</tspan><tspan x="95" dy="16">artifact</tspan></text>
    <text x="300" y="126"><tspan x="300" dy="0">Sync versioned</tspan><tspan x="300" dy="16">releases/&lt;sha&gt;/</tspan></text>
    <text x="515" y="126"><tspan x="515" dy="0">Swap pointer</tspan><tspan x="515" dy="16">latest &#8594; sha</tspan></text>
    <text x="730" y="126"><tspan x="730" dy="0">Invalidate</tspan><tspan x="730" dy="16">CDN edge</tspan></text>
  </g>
  <text x="420" y="205" fill="#5b6471" font-size="12" text-anchor="middle">Content-Type + Content-Encoding + Cache-Control set per object during sync</text>
</svg>
<figcaption>The deploy writes to an immutable versioned prefix with correct content and cache headers, atomically repoints the live alias, then invalidates the edge so the swap goes live everywhere at once.</figcaption>
</figure>

## Prerequisites

- Python 3.11 with `boto3>=1.34`, and the AWS CLI v2 (`aws s3 sync`) or `rclone` available on the deploy runner. Cloudflare R2 speaks the S3 API, so the same tools target it via a custom `endpoint_url`.
- A validated tileset in `dist/` from the [validation gate](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/), containing `tileset.json` and `.b3dm`/`.pnts` payloads. Tiles are geocentric EPSG:4978 for Cesium; the deploy never reprojects — it publishes bytes.
- A bucket with a CDN in front (CloudFront over S3, or Cloudflare's cache over R2) and credentials in the CI secret store, injected as environment variables and never written to the workflow file.
- A decision on gzip: either pre-gzip `tileset.json` and set `Content-Encoding: gzip` yourself, or leave files raw and let the CDN compress. Do exactly one — double compression is a classic breakage covered below.

## Step-by-Step

### 1. Map each extension to its content type and encoding

3D Tiles payloads have specific MIME types, and a gzipped file must advertise `Content-Encoding: gzip` or the browser hands raw DEFLATE bytes to the glTF loader. Define the mapping once so every object is tagged consistently.

```python
CONTENT_TYPES = {
    ".json": "application/json",
    ".b3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".glb":  "model/gltf-binary",
}

def headers_for(path: str, gzipped: bool) -> dict:
    ext = path[path.rfind("."):]
    meta = {"ContentType": CONTENT_TYPES.get(ext, "application/octet-stream")}
    if gzipped:
        meta["ContentEncoding"] = "gzip"
    # Immutable versioned objects: cache hard. The pointer alias is cached short.
    meta["CacheControl"] = "public, max-age=31536000, immutable"
    return meta
```

<figure class="diagram">
<svg viewBox="-14 17 788 309" role="img" aria-labelledby="cdn-mime-t cdn-mime-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-mime-t">Content type and cache policy, per extension</title>
  <desc id="cdn-mime-d">Every payload extension in a tileset is immutable once written and can be cached for a year. Only tileset.json changes between deployments, so it is the single file that must not be cached. Getting this backwards produces the two classic symptoms: tiles that never update, or a tileset that is re-downloaded on every page load.</desc>
  <rect class="svg-bg" x="-14" y="17" width="788" height="309" fill="#ffffff"/>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="89" y="44">extension</text>
    <text x="316" y="44">Content-Type</text>
    <text x="603" y="44">Cache-Control</text>
  </g>
    <rect x="24" y="58" width="130" height="28" rx="6" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="166" y="58" width="300" height="28" rx="6" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="478" y="58" width="250" height="28" rx="6" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="24" y="96" width="130" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="166" y="96" width="300" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="478" y="96" width="250" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="24" y="134" width="130" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="166" y="134" width="300" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="478" y="134" width="250" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="24" y="172" width="130" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="166" y="172" width="300" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="478" y="172" width="250" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="24" y="210" width="130" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="166" y="210" width="300" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="478" y="210" width="250" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="24" y="248" width="130" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="166" y="248" width="300" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="478" y="248" width="250" height="28" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="89" y="77">.json</text>
    <text x="316" y="77">application/json</text>
    <text x="603" y="77">no-cache</text>
    <text x="89" y="115">.b3dm</text>
    <text x="316" y="115">application/octet-stream</text>
    <text x="603" y="115">immutable, 1 year</text>
    <text x="89" y="153">.pnts</text>
    <text x="316" y="153">application/octet-stream</text>
    <text x="603" y="153">immutable, 1 year</text>
    <text x="89" y="191">.glb</text>
    <text x="316" y="191">model/gltf-binary</text>
    <text x="603" y="191">immutable, 1 year</text>
    <text x="89" y="229">.subtree</text>
    <text x="316" y="229">application/octet-stream</text>
    <text x="603" y="229">immutable, 1 year</text>
    <text x="89" y="267">.ktx2</text>
    <text x="316" y="267">image/ktx2</text>
    <text x="603" y="267">immutable, 1 year</text>
  </g>
  <text x="380" y="308" fill="#15384a" font-size="12.5" text-anchor="middle">One mutable file and everything else immutable — which is exactly what makes the versioned-prefix plus alias-swap pattern work</text>
</svg>
<figcaption>Content types matter for compression and for range requests; cache policy is what decides whether a deploy is visible in seconds or in hours.</figcaption>
</figure>

### 2. Upload the tree to an immutable versioned prefix with boto3

Write the whole tileset under `releases/<commit-sha>/` so each deploy is immutable and independently addressable. `boto3` sets the per-object metadata from step 1; R2 is reached by pointing `endpoint_url` at the account's R2 domain.

```python
import os
from pathlib import Path
import boto3

def upload_release(dist: Path, bucket: str, sha: str) -> str:
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT_URL"),   # set for Cloudflare R2
        region_name=os.environ.get("AWS_REGION", "auto"))
    prefix = f"releases/{sha}"
    for path in dist.rglob("*"):
        if path.is_file():
            gz = path.suffix == ".json"                   # we pre-gzip tileset.json
            key = f"{prefix}/{path.relative_to(dist).as_posix()}"
            s3.upload_file(str(path), bucket, key, ExtraArgs=headers_for(path.name, gz))
    return prefix
```

### 3. Or sync the directory with the CLI

For large tilesets `aws s3 sync` (or `rclone`) is faster than a Python loop because it parallelises and skips unchanged objects. Set per-pattern metadata with `--exclude`/`--include` passes so `.b3dm` and gzipped JSON get the right headers.

```bash
SHA="${GITHUB_SHA}"
DEST="s3://twin-tiles/releases/${SHA}"

# Binary tiles: octet-stream, long-lived immutable cache.
aws s3 sync dist/ "${DEST}" \
  --exclude "*.json" \
  --content-type "application/octet-stream" \
  --cache-control "public, max-age=31536000, immutable"

# Pre-gzipped tileset.json: json + gzip encoding.
aws s3 sync dist/ "${DEST}" \
  --exclude "*" --include "*.json" \
  --content-type "application/json" \
  --content-encoding "gzip" \
  --cache-control "public, max-age=31536000, immutable"
```

### 4. Swap the live alias atomically

Clients hit a stable URL — `live/tileset.json` — so the deploy goes live by repointing that alias to the new release in one operation, after every tile is uploaded. Copying the versioned `tileset.json` to the short-cached alias key is the atomic swap: until this line runs, the old tileset serves unchanged; after it, the new tree is live as a whole.

```python
def swap_pointer(s3, bucket: str, sha: str) -> None:
    # The alias tileset.json is cached briefly and its child URIs point at the
    # immutable release prefix, so repointing it flips the whole tree at once.
    s3.copy_object(
        Bucket=bucket,
        CopySource={"Bucket": bucket, "Key": f"releases/{sha}/tileset.json"},
        Key="live/tileset.json",
        ContentType="application/json", ContentEncoding="gzip",
        CacheControl="public, max-age=60", MetadataDirective="REPLACE")
```

<figure class="diagram">
<svg viewBox="16 28 657 256" role="img" aria-labelledby="cdn-swap-t cdn-swap-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-swap-t">A versioned prefix with an alias in front of it</title>
  <desc id="cdn-swap-d">Each build writes to its own immutable prefix keyed by the commit. The alias the viewer resolves points at one of them. Deploying means writing a new prefix and then moving the alias, which is a single small operation, and rolling back means moving it again.</desc>
  <rect class="svg-bg" x="16" y="28" width="657" height="256" fill="#ffffff"/>
  <defs>
    <marker id="cdn-swap-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="30" y="118" width="150" height="52" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#eef5e9" stroke="#4f7a4d" stroke-width="2">
    <rect x="290" y="42" width="220" height="46" rx="8"/>
    <rect x="290" y="118" width="220" height="46" rx="8"/>
    <rect x="290" y="194" width="220" height="46" rx="8"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cdn-swap-a)">
    <path d="M180 138 L288 141"/>
  </g>
  <path d="M180 132 C 220 100 240 80 288 66" fill="none" stroke="#e6e0d4" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M180 152 C 220 184 240 202 288 216" fill="none" stroke="#e6e0d4" stroke-width="2" stroke-dasharray="5 4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="105" y="144">/live alias</text>
    <text x="400" y="70">/builds/8f2c1a — previous</text>
    <text x="400" y="146">/builds/c41e97 — live</text>
    <text x="400" y="222">/builds/19b0d4 — just written</text>
  </g>
  <text x="612" y="70" fill="#5b6471" font-size="12" text-anchor="middle">kept for rollback</text>
  <text x="612" y="222" fill="#5b6471" font-size="12" text-anchor="middle">not yet visible</text>
  <text x="370" y="266" fill="#15384a" font-size="12.5" text-anchor="middle">Viewers never see a half-written build, and a rollback is one alias write rather than a re-upload</text>
</svg>
<figcaption>Uploading over the live prefix makes every deploy a window in which the tileset references tiles that do not exist yet. The alias removes that window entirely.</figcaption>
</figure>

### 5. Invalidate the CDN edge

The alias is short-cached, but force an invalidation so the swap is visible immediately rather than after TTL expiry. On CloudFront, invalidate the alias path; on Cloudflare, purge the URL.

```python
def invalidate_cloudfront(distribution_id: str, sha: str) -> None:
    cf = boto3.client("cloudfront")
    cf.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "Paths": {"Quantity": 1, "Items": ["/live/tileset.json"]},
            "CallerReference": sha,
        })
```

### 6. Run the deploy job only from the default branch

Guard the whole deploy on a push to `main` after the gate, and inject credentials from secrets. Fork pull requests never reach this job, so they cannot touch the bucket.

```yaml
  deploy:
    needs: [gate]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v4
        with: { name: validated-tileset, path: dist/ }
      - name: Publish to R2
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET }}
          S3_ENDPOINT_URL: ${{ secrets.R2_ENDPOINT }}
        run: python3 scripts/deploy.py dist/ --bucket twin-tiles --sha "${{ github.sha }}"
```

## Expected Output & Verification

After a deploy, confirm the served headers with `curl -I` against the CDN URL — the single most useful post-deploy check. The gzipped `tileset.json` must report both `content-type: application/json` and `content-encoding: gzip`, and a `.b3dm` must be `application/octet-stream`.

```text
$ curl -sI https://tiles.example.com/live/tileset.json
HTTP/2 200
content-type: application/json
content-encoding: gzip
cache-control: public, max-age=60
$ curl -sI https://tiles.example.com/releases/9f3c2a1/tiles/tile_18_3312.b3dm
HTTP/2 200
content-type: application/octet-stream
cache-control: public, max-age=31536000, immutable
```

Then load `https://tiles.example.com/live/tileset.json` with `Cesium.Cesium3DTileset.fromUrl` and confirm the tiles render at the survey location. Because the release prefix is immutable and the alias is atomic, rolling back is repointing `live/tileset.json` at a previous release — no re-upload. For a fully managed alternative that skips bucket, headers, and invalidation entirely, publish to Cesium ion instead; see [Cesium ion upload automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/) and [automating ion tileset uploads with the REST API](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/automating-ion-tileset-uploads-with-the-rest-api/).

Two operational details make the difference between a deploy that works and one that works reliably. The first is compression: `tileset.json` and any `.json` payloads benefit enormously from gzip or brotli at the edge, while `.b3dm` and `.glb` contents are already Draco-compressed and gain almost nothing, so enabling compression indiscriminately spends CPU on payloads that will not shrink. Configure it by content type rather than globally.

The second is the invalidation itself. Because every payload path is unique to its build prefix, the only object that ever needs invalidating is the alias — a single path, not a wildcard over the whole tree. A wildcard invalidation on a city-scale tileset can take several minutes to propagate and, on some CDNs, is billed per path; invalidating one alias is immediate and free. If a deploy feels slow at the CDN step, that is almost always what is happening.

Finally, verify the deploy from outside your own network before declaring it done. Fetching the alias through the CDN, following it to the versioned prefix, and confirming the returned `tileset.json` carries the commit you expect takes one request and catches the two failures that a local check cannot see: a stale edge and a prefix that was written to the wrong bucket.

## Common Errors

**Tiles download but Cesium throws `Unexpected token` or fails to parse the glTF.** The object was gzipped but served without `Content-Encoding: gzip`, so the browser passed compressed bytes straight to the loader. Fix: set `ContentEncoding: gzip` on every pre-gzipped object (steps 1 and 3), and verify with `curl -I` that the header is present — a missing encoding header on a gzipped body is the most common 3D Tiles deploy failure.

**Every tile is served double-compressed and errors intermittently.** You gzipped the files *and* the CDN re-compressed them, producing a double-DEFLATE body some clients reject. Fix: choose one layer — either pre-gzip and mark `Content-Encoding: gzip` while disabling CDN compression for those paths, or upload raw and let the CDN compress. Never both.

**Clients keep loading old tiles after a deploy.** The `tileset.json` alias was cached with a long `max-age` and no invalidation, so the edge kept serving the previous tree while its referenced tiles were deleted, yielding 404s. Fix: cache the alias with a short `max-age` (60 s) and issue an explicit invalidation on the alias path (step 5), while keeping the immutable release prefix long-lived.

Keep a small number of previous prefixes rather than all of them. Three or four builds is enough to roll back through a bad week, and a lifecycle rule that expires anything older keeps the bucket from growing without bound — a city-scale tileset is tens of gigabytes per build, and an unbounded history is the storage bill nobody predicted.

Delete by prefix age rather than by count, so a quiet month does not silently expire the only version you would want to return to.

## Related Guides

- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the gate that must pass before this deploy runs
- [GitHub Actions GDAL/PDAL Pipeline Jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the process stage producing the artifact deployed here
- [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/) — the managed-hosting alternative to a self-hosted CDN
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — how the tileset being deployed is built

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
