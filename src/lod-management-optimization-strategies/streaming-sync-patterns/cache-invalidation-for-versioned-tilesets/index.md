---
title: "Cache Invalidation for Versioned Tilesets"
description: "Publish a tileset update without invalidating the CDN: immutable content paths, one mutable entry point, ETags, and why a wildcard purge is almost never right."
---
# Cache Invalidation for Versioned Tilesets

This page publishes a tileset update so that caches keep working — every payload path immutable and cached for a year, exactly one mutable entry point, and an invalidation that touches a single object rather than a wildcard over a hundred thousand. The alternative, purging the tree on every publish, costs minutes of propagation, empties every edge and every browser cache, and makes the first viewer after a deploy pay for the whole city again.

## Why you hit this

Tilesets are large, mostly static, and republished often. Those three facts together make caching the dominant factor in perceived performance, and they make the naive publish — overwrite in place, purge everything — the worst possible combination: viewers see partially updated trees during the write, and afterwards nobody has a warm cache. The fix is structural rather than a setting, and it is the same pattern that works for any large versioned artifact.

The deploy mechanics are in [automated 3D Tiles deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/); this page is about what the caches do with it.

## Prerequisites

- Object storage plus a CDN that honours `Cache-Control` and conditional requests — CloudFront, Fastly, Cloudflare and most others.
- A build that writes to an immutable, version-keyed prefix, as produced by an [incremental retile](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/).
- The ability to set headers per path pattern, either at upload or at the edge.

## Step-by-Step

### 1. Make every payload path immutable

The rule is simple: if the bytes at a URL can ever change, that URL cannot be cached long. So arrange for them never to change.

```bash
BUILD=$(git rev-parse --short HEAD)

# Payloads: content-addressed by build, cached for a year.
aws s3 sync build/next/ "s3://twin/builds/${BUILD}/" \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "tileset.json"

# The one mutable object: never cached.
aws s3 cp build/next/tileset.json "s3://twin/builds/${BUILD}/tileset.json" \
  --cache-control "no-cache"
```

`immutable` is the directive that matters and the one most often omitted. Without it, a browser with a year-old entry still sends a conditional request on every navigation to confirm the object has not changed; with it, the request is not made at all. Across a tileset that is thousands of avoided round trips per session.

### 2. Keep exactly one mutable entry point

Everything the viewer reads is reachable from one object, and only that object changes.

```bash
# The alias the viewer is pointed at. This is the only thing a publish rewrites.
aws s3 cp "s3://twin/builds/${BUILD}/tileset.json" s3://twin/live/tileset.json \
  --cache-control "no-cache, must-revalidate" \
  --metadata-directive REPLACE

# Its content URIs are absolute into the immutable prefix.
python - <<'PY'
import json
ts = json.load(open("build/next/tileset.json"))
def rewrite(node, prefix):
    if "content" in node and not node["content"]["uri"].startswith("http"):
        node["content"]["uri"] = f"{prefix}/{node['content']['uri']}"
    for c in node.get("children", []):
        rewrite(c, prefix)
rewrite(ts["root"], f"/builds/{__import__('os').environ['BUILD']}")
json.dump(ts, open("build/next/tileset.json", "w"))
PY
```

<figure class="diagram">
<svg viewBox="16 36 708 214" role="img" aria-labelledby="ci-shape-t ci-shape-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ci-shape-t">One mutable object in front of an immutable tree</title>
  <desc id="ci-shape-d">The viewer resolves a single no-cache alias, which points into a build prefix whose every object is immutable and cached for a year. Publishing rewrites the alias only, so one object is invalidated and every payload the viewer already holds stays valid.</desc>
  <rect class="svg-bg" x="16" y="36" width="708" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="30" y="96" width="150" height="52" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="260" y="50" width="200" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="260" y="106" width="200" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="162" width="200" height="44" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="106" width="180" height="44" rx="8" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none">
    <path d="M180 122 L258 128"/>
    <path d="M460 128 L528 128"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="105" y="118"><tspan x="105" dy="0">/live/tileset.json</tspan><tspan x="105" dy="16">no-cache</tspan></text>
    <text x="360" y="70">/builds/8f2c1a/ — previous</text>
    <text x="360" y="126">/builds/c41e97/ — live</text>
    <text x="360" y="182">/builds/19b0d4/ — next</text>
    <text x="620" y="126"><tspan x="620" dy="0">*.b3dm, *.glb</tspan><tspan x="620" dy="16">immutable, 1 year</tspan></text>
  </g>
  <text x="370" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Publishing rewrites one object and invalidates one path — every payload a viewer already holds stays valid</text>
</svg>
<figcaption>The whole scheme is one indirection. Everything expensive is immutable, and the only thing that changes is a few kilobytes of JSON.</figcaption>
</figure>

### 3. Invalidate one path, not a wildcard

```bash
# Right: one path, propagates in seconds, free on most CDNs.
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/live/tileset.json"

# Wrong: a wildcard over the whole tree.
# aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*"
```

The wildcard is wrong on three counts. It takes minutes rather than seconds to propagate, so there is a window in which some edges serve the old tree and some the new. It is billed per path on several CDNs, and a city tileset has a lot of paths. And it discards every warm cache entry, so the first viewer after each deploy re-downloads the entire visible extent — which is precisely the cost the caching was there to avoid.

### 4. Use ETags for the one object that does change

The alias is fetched on every session, so making it conditional is worth the two headers.

```python
import hashlib
import json
from pathlib import Path

def publish_alias(local_path, s3, bucket, key):
    body = Path(local_path).read_bytes()
    etag = hashlib.md5(body).hexdigest()
    s3.put_object(
        Bucket=bucket, Key=key, Body=body,
        ContentType="application/json",
        CacheControl="no-cache, must-revalidate",
        Metadata={"build-etag": etag},
    )
    return etag
```

With `no-cache` the client still revalidates, but a matching ETag returns `304 Not Modified` with an empty body. For a tileset root that is a few kilobytes that is a modest saving; for an implicit tileset whose root is under two kilobytes it is nearly all of the request.

### 5. Retire old builds on a schedule, not on publish

Deleting the previous build at publish time removes the rollback and breaks any viewer mid-session.

```bash
# Keep the last four builds; expire anything older.
aws s3api put-bucket-lifecycle-configuration --bucket twin --lifecycle-configuration '{
  "Rules": [{
    "ID": "expire-old-builds",
    "Filter": {"Prefix": "builds/"},
    "Status": "Enabled",
    "Expiration": {"Days": 30}
  }]
}'
```

Expiring by age rather than by count is the safer rule: a quiet month should not silently expire the only version you would want to return to, and thirty days of a city tileset is a predictable storage cost rather than an unbounded one.

<figure class="diagram">
<svg viewBox="60 23 624 211" role="img" aria-labelledby="ci-cost-t ci-cost-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ci-cost-t">What the first viewer after a deploy pays</title>
  <desc id="ci-cost-d">After a wildcard purge every edge and browser cache is empty, so the first viewer downloads the whole visible extent again — about ninety megabytes. After a single-path invalidation only the changed tiles are cold, so the same viewer downloads a few megabytes and the rest comes from cache.</desc>
  <rect class="svg-bg" x="60" y="23" width="624" height="211" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="200" y="60" width="470" height="32" rx="4" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="200" y="112" width="34" height="32" rx="4" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="200" y="50">wildcard purge — 91 MB re-downloaded, 4 min propagation</text>
    <text x="246" y="134">single path — 6.4 MB, seconds to propagate</text>
  </g>
  <text x="190" y="82" fill="#5b6471" font-size="12" text-anchor="end">/*</text>
  <text x="190" y="134" fill="#5b6471" font-size="12" text-anchor="end">/live/tileset.json</text>
  <text x="370" y="188" fill="#15384a" font-size="12.5" text-anchor="middle">Same deploy, same tiles changed — the difference is entirely in what the invalidation discarded</text>
  <text x="370" y="216" fill="#5b6471" font-size="12" text-anchor="middle">And the wildcard's four-minute propagation is a window in which edges disagree about which build is live</text>
</svg>
<figcaption>The purge is not merely slower. It throws away the caches that were the point of the exercise, and it does so on every publish.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="10 42 607 214" role="img" aria-labelledby="ci-hdr-t ci-hdr-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ci-hdr-t">The header each kind of object needs</title>
  <desc id="ci-hdr-d">Tile payloads and subtree files never change at their path and take a one-year immutable cache. The tileset root at the alias changes on every publish and takes no-cache with must-revalidate. Getting these two the wrong way round produces either a viewer that never updates or a city that is re-downloaded on every visit.</desc>
  <rect class="svg-bg" x="10" y="42" width="607" height="214" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="56" width="230" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="24" y="98" width="230" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="24" y="140" width="230" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="24" y="182" width="230" height="34" rx="6" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="139" y="78">*.b3dm, *.glb, *.pnts</text>
    <text x="139" y="120">*.subtree</text>
    <text x="139" y="162">*.ktx2 textures</text>
    <text x="139" y="204">/live/tileset.json</text>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="start">
    <text x="278" y="78">public, max-age=31536000, immutable</text>
    <text x="278" y="120">public, max-age=31536000, immutable</text>
    <text x="278" y="162">public, max-age=31536000, immutable</text>
    <text x="278" y="204">no-cache, must-revalidate</text>
  </g>
  <text x="370" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">One row differs from the other three, and it is the only object a publish rewrites</text>
</svg>
<figcaption>Four patterns and one exception. The exception is small, revalidates cheaply with an ETag, and is the entire mutable surface of the deployment.</figcaption>
</figure>

## Expected Output & Verification

Confirm the headers from outside your network, because a local check sees neither the CDN nor its cache state.

```bash
curl -sI https://cdn.example.com/live/tileset.json | grep -Ei "cache-control|etag|x-cache"
curl -sI https://cdn.example.com/builds/c41e97/12/8801/9702.b3dm | grep -Ei "cache-control|x-cache"
```

```text
cache-control: no-cache, must-revalidate
etag: "9f2c1ab4e6d0..."
x-cache: Miss from cloudfront

cache-control: public, max-age=31536000, immutable
x-cache: Hit from cloudfront
```

Four things to check: the alias is `no-cache` and the payloads are `immutable`; the payload path contains the build id; a second request for the same payload reports a cache hit; and the tileset the alias resolves to carries the commit you just published. That last one catches a stale edge, which is the failure this whole scheme exists to prevent and the only one a header check alone will miss.

## Common Errors

**Viewers see the old tileset for hours after a deploy.** The alias was cached. Set `no-cache` on it explicitly — inheriting a bucket-wide long `max-age` is the usual cause.

**Every deploy re-downloads the whole city.** Payload paths are not version-keyed, so the invalidation had to be a wildcard. Move payloads under a build prefix and the wildcard becomes unnecessary.

**Some viewers see a half-updated tree.** The tileset was overwritten in place while a viewer was resolving it. Write the new build to its own prefix first, then move the alias.

**The CDN reports a hit but serves stale bytes.** A proxy between you and the CDN is caching without honouring the headers. Check for an intermediate cache and confirm `Vary` and `Cache-Control` survive it.

## Frequently Asked Questions

### Why not use query strings for versioning?
Some CDNs strip or ignore query strings when forming the cache key, so `tile.b3dm?v=2` can be served from the entry for `?v=1`. Path-based versioning has no such ambiguity anywhere.

### How long should `max-age` be for payloads?
A year, with `immutable`. The path already encodes the build, so the bytes at it can never change and there is no reason to revalidate.

### Does this interact with the incremental rebuild?
Directly, and favourably: tiles that were copied forward byte-identical land at a *new* path under the new build prefix, so they are cold at the edge even though the bytes are the same. If that matters, address payloads by content hash rather than by build id and unchanged tiles keep their URL — at the cost of a less readable layout.

It is worth being explicit about what this scheme buys and what it does not. It makes a publish atomic and cheap, and it keeps warm caches warm — so the median viewer after a deploy pays for the handful of tiles that changed rather than for the city. It does not make the first ever visit faster: a cold viewer downloads the visible extent regardless, and that cost belongs to tile size and compression rather than to caching.

The second limitation is that immutability is a property of the path, not of the bytes. Two builds that produce identical tiles still place them at different paths, so every tile is cold after a publish even where nothing changed. Where that matters — a city republished several times a day — addressing payloads by a hash of their contents rather than by build id keeps unchanged tiles at the same URL and preserves their cache entries, at the cost of a directory layout no human can navigate.

Finally, verify from outside. A `curl` from the build machine frequently bypasses the CDN entirely and reports the origin's headers, which are not what a viewer sees. Check from a network you do not control, and check the resolved commit rather than only the headers.

### Should the alias be an object or a redirect?
An object. A redirect adds a round trip on every session and, on several CDNs, is cached under rules that differ from the target's — which reintroduces exactly the staleness the scheme removes.

## Related Guides

- [Streaming & Synchronization Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/) — how the client consumes what is published
- [Automated 3D Tiles Deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/) — the upload and alias mechanics
- [Incremental Retiling of Changed City Blocks](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/incremental-retiling-of-changed-city-blocks/) — producing a build where most tiles did not change

Back to [Streaming & Synchronization Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
