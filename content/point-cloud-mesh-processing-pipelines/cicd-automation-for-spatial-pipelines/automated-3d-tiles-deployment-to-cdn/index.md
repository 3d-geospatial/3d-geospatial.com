# Automatically Deploying a Validated 3D Tileset to a CDN or Object Store

This guide deploys a validated 3D Tiles set from CI to an object store fronted by a CDN — Amazon S3 or Cloudflare R2 — using `boto3` and `aws s3 sync`, setting the correct `Content-Type` and `Content-Encoding` for gzipped `tileset.json` and `.b3dm` payloads, applying long-lived `Cache-Control`, invalidating the edge, and swapping an atomic versioned prefix so clients never see a half-uploaded tileset.

You need this once the tileset is more than a folder you drag into a bucket: browsers refuse to decode a gzipped `.b3dm` served without `Content-Encoding: gzip`, a stale `tileset.json` pins clients to deleted tiles, and a mid-sync deploy shows users a broken tree. This is the publish stage of the [CI/CD automation for spatial pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/) workflow, and it runs only after the [schema validation gate](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) is green.

<figure class="diagram">
<svg viewBox="0 0 840 280" role="img" aria-labelledby="cdn-t cdn-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cdn-t">Atomic versioned deploy of a tileset to object storage and CDN</title>
  <desc id="cdn-d">A validated artifact is synced to a versioned prefix with correct content types and cache headers, then an atomic pointer swap moves the live alias to the new release, and the CDN edge is invalidated.</desc>
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

## Common Errors

**Tiles download but Cesium throws `Unexpected token` or fails to parse the glTF.** The object was gzipped but served without `Content-Encoding: gzip`, so the browser passed compressed bytes straight to the loader. Fix: set `ContentEncoding: gzip` on every pre-gzipped object (steps 1 and 3), and verify with `curl -I` that the header is present — a missing encoding header on a gzipped body is the most common 3D Tiles deploy failure.

**Every tile is served double-compressed and errors intermittently.** You gzipped the files *and* the CDN re-compressed them, producing a double-DEFLATE body some clients reject. Fix: choose one layer — either pre-gzip and mark `Content-Encoding: gzip` while disabling CDN compression for those paths, or upload raw and let the CDN compress. Never both.

**Clients keep loading old tiles after a deploy.** The `tileset.json` alias was cached with a long `max-age` and no invalidation, so the edge kept serving the previous tree while its referenced tiles were deleted, yielding 404s. Fix: cache the alias with a short `max-age` (60 s) and issue an explicit invalidation on the alias path (step 5), while keeping the immutable release prefix long-lived.

## Related Guides

- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the gate that must pass before this deploy runs
- [GitHub Actions GDAL/PDAL Pipeline Jobs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/github-actions-gdal-pdal-pipeline-jobs/) — the process stage producing the artifact deployed here
- [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/) — the managed-hosting alternative to a self-hosted CDN
- [Automated Tile Generation for 3D Geospatial](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/) — how the tileset being deployed is built

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
