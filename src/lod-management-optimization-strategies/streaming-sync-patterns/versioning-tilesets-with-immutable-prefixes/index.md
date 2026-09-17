---
title: "Versioning Tilesets with Immutable Prefixes"
description: "Deploy tileset updates without cache invalidation: content-addressed prefixes, a short-lived pointer document, atomic switchover"
---
# Versioning Tilesets with Immutable Prefixes

This page deploys tileset updates by never modifying a published file — each build lands under its own immutable prefix with a one-year cache lifetime, a tiny pointer document with a short lifetime tells clients which build is current, switchover is a single write, and rollback is the same write in reverse.

## Why you hit this

A tileset is thousands of files fetched by URL. If a rebuild overwrites them in place, every cache between the origin and the viewer holds a mixture: some tiles from the old build, some from the new. The visible result is geometry from two builds in one scene — a building that was demolished still standing next to its replacement, or tiles whose bounding volumes no longer match their content. CDN invalidation is the usual answer and it is slow, rate-limited, expensive at this file count, and does nothing about the browser's own cache.

The alternative is to make every published file immutable. A file that never changes can be cached forever, and an update is not a modification but a new set of files at new URLs. All the coordination then happens in one small document.

## Prerequisites

- Object storage behind a CDN — S3, R2, GCS, or similar — with control over `Cache-Control`.
- A tileset build that produces a complete output tree, as in [3D Tiles batch tiling pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
- Deterministic output, from [making tile output deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) — without it, every rebuild is a new build even when nothing changed.
- Python 3.10+ with `boto3`.

## Step-by-Step

### 1. Give the build an identity derived from its inputs

```python
import hashlib
import json
import os
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

import boto3

@dataclass(frozen=True)
class BuildId:
    version: str          # the prefix segment, e.g. "b-7f3a9c21"
    provenance_hash: str  # inputs + params + tool versions
    built_at: str
    label: str            # human-readable, e.g. "2026-09-17 nightly"

def build_id(provenance_hash, label=None):
    short = provenance_hash[:8]
    return BuildId(version=f"b-{short}",
                   provenance_hash=provenance_hash,
                   built_at=datetime.now(timezone.utc).isoformat(),
                   label=label or datetime.now(timezone.utc).strftime("%Y-%m-%d build"))

def provenance(inputs, params, tools):
    payload = {"inputs": {k: v for k, v in sorted(inputs.items())},
               "params": params, "tools": tools}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()

bid = build_id(provenance(
    {"footprints": "sha256:9a1f…", "dtm": "sha256:41c0…"},
    {"max_per_tile": 2000, "quantize_position": 14},
    {"tiler": "twin-tiler 4.2.1", "gltfpack": "0.20"},
), label="2026-09-17 nightly")
print(asdict(bid))
```

Deriving the prefix from the provenance hash rather than from a timestamp or a counter gives one useful property for free: a rebuild that changes nothing produces the same prefix, so it uploads nothing and the pointer does not move. That turns "did anything actually change?" into a string comparison, and it stops a nightly job from publishing 6,000 identical files every night.

The short hash is the prefix segment because URLs are read by humans during incidents. Eight hex characters is 4 billion values, which is ample for build identity within a project.

### 2. Publish under the prefix, with a one-year cache lifetime

```python
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_POINTER = "public, max-age=30, stale-while-revalidate=60"

CONTENT_TYPES = {
    ".json": "application/json",
    ".glb": "model/gltf-binary",
    ".b3dm": "application/octet-stream",
    ".subtree": "application/octet-stream",
    ".ktx2": "image/ktx2",
    ".webp": "image/webp",
}

def publish_build(local_root, bucket, base_prefix, bid, s3=None, dry_run=False):
    s3 = s3 or boto3.client("s3")
    prefix = f"{base_prefix.rstrip('/')}/{bid.version}/"
    uploaded, skipped, total_bytes = 0, 0, 0
    for path in sorted(Path(local_root).rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(local_root).as_posix()
        key = f"{prefix}{rel}"
        ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        size = path.stat().st_size
        if not dry_run:
            s3.upload_file(str(path), bucket, key,
                           ExtraArgs={"CacheControl": CACHE_IMMUTABLE,
                                      "ContentType": ctype,
                                      "ContentEncoding": "gzip"
                                      if path.suffix == ".json" else None}
                           if path.suffix == ".json" else
                           {"CacheControl": CACHE_IMMUTABLE, "ContentType": ctype})
        uploaded += 1
        total_bytes += size
    return {"prefix": prefix, "files": uploaded, "skipped": skipped,
            "gb": round(total_bytes / 1e9, 2)}

print(publish_build("build/city/output", "tiles.example.com", "city", bid, dry_run=True))
```

`immutable` in the `Cache-Control` header is the directive that matters. Without it, a browser with a `max-age=31536000` response still revalidates on a reload; with it, the browser will not issue a conditional request at all, which removes a round trip per tile on every repeat visit.

The header is a promise, and immutable prefixes are what make the promise true. Serving `immutable` on a path you later overwrite produces the worst of both worlds: clients that hold the old content for a year with no way to be told otherwise.

### 3. Write the pointer document last

```python
POINTER_KEY_TEMPLATE = "{base}/current.json"

def write_pointer(bucket, base_prefix, bid, extra=None, s3=None):
    s3 = s3 or boto3.client("s3")
    doc = {
        "schema": 1,
        "version": bid.version,
        "tilesetUrl": f"/{base_prefix.strip('/')}/{bid.version}/tileset.json",
        "provenanceHash": bid.provenance_hash,
        "builtAt": bid.built_at,
        "label": bid.label,
        "publishedAt": datetime.now(timezone.utc).isoformat(),
        **(extra or {}),
    }
    body = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
    key = POINTER_KEY_TEMPLATE.format(base=base_prefix.strip("/"))
    s3.put_object(Bucket=bucket, Key=key, Body=body,
                  CacheControl=CACHE_POINTER, ContentType="application/json")
    return {"key": key, "bytes": len(body), "doc": doc}

print(json.dumps(write_pointer("tiles.example.com", "city", bid)["doc"], indent=2))
```

The pointer is the only mutable object in the system, and everything about it is chosen to make that safe: it is a few hundred bytes, it has a 30-second cache lifetime, and `stale-while-revalidate` means a client never blocks on fetching it. A viewer reads the pointer at start-up and then uses immutable URLs for everything else.

Writing it **after** every tile is uploaded is the ordering that makes switchover atomic in practice. Until the pointer moves, the new build is invisible; once it moves, every file it references is already in place. There is no window in which a client can resolve a URL that does not exist.

<figure class="diagram">
<svg viewBox="4 16 732 242" role="img" aria-labelledby="ver-layout-t ver-layout-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ver-layout-t">Immutable prefixes with one mutable pointer</title>
  <desc id="ver-layout-d">A storage layout. Three build prefixes each hold a complete tileset with a one-year immutable cache lifetime: an older build, the current build, and a newly uploaded build. A single small pointer document at the base of the path has a thirty-second cache lifetime and names which build is current. The viewer fetches the pointer once, then fetches tiles from the named prefix using URLs that never change.</desc>
  <rect class="svg-bg" x="4" y="16" width="732" height="242" fill="#ffffff"/>
  <defs>
    <marker id="ver-layout-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="18" y="30" width="196" height="56" rx="7" fill="#ffffff" stroke="#5b6471" stroke-width="1.6"/>
  <rect x="18" y="96" width="196" height="56" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2.4"/>
  <rect x="18" y="162" width="196" height="56" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.6"/>
  <rect x="290" y="96" width="166" height="56" rx="7" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2.4"/>
  <rect x="532" y="84" width="190" height="80" rx="7" fill="#ffffff" stroke="#5b6471" stroke-width="1.6"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ver-layout-arrow)">
    <path d="M456 112 H530"/>
    <path d="M596 164 V196 H214 V132" stroke-dasharray="6 4"/>
  </g>
  <path d="M214 124 H288" stroke="#4f7a4d" stroke-width="2" fill="none" marker-end="url(#ver-layout-arrow)"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="52">city/b-2c81f0aa/</text><text x="116" y="70">previous — kept for rollback</text>
    <text x="116" y="118">city/b-7f3a9c21/</text><text x="116" y="136">current</text>
    <text x="116" y="184">city/b-91de4c07/</text><text x="116" y="202">uploaded, not yet pointed at</text>
    <text x="373" y="118">city/current.json</text><text x="373" y="136">max-age 30 s</text>
    <text x="627" y="108">viewer: read pointer</text><text x="627" y="126">once, then fetch tiles</text>
    <text x="627" y="144">from that prefix only</text>
  </g>
  <text x="20" y="240" fill="#5b6471" font-size="12">every file under a b- prefix: max-age 1 year, immutable</text>
  <text x="720" y="240" fill="#5b6471" font-size="12" text-anchor="end">switchover = one 300-byte write; rollback = the same write</text>
</svg>
<figcaption>Thousands of immutable files, one mutable pointer, and a switchover that is a single small object write.</figcaption>
</figure>

### 4. Resolve the pointer in the client

```javascript
const POINTER_URL = 'https://tiles.example.com/city/current.json';

export async function resolveTileset({ pinnedVersion = null } = {}) {
  if (pinnedVersion) {
    return { tilesetUrl: `https://tiles.example.com/city/${pinnedVersion}/tileset.json`,
             version: pinnedVersion, pinned: true };
  }
  const res = await fetch(POINTER_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`pointer fetch failed: ${res.status}`);
  const doc = await res.json();
  if (doc.schema !== 1) throw new Error(`unsupported pointer schema ${doc.schema}`);
  return {
    tilesetUrl: new URL(doc.tilesetUrl, 'https://tiles.example.com').href,
    version: doc.version,
    label: doc.label,
    pinned: false,
  };
}

export async function loadTileset(viewer) {
  const { tilesetUrl, version } = await resolveTileset();
  const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
    cacheBytes: 536_870_912,
    maximumScreenSpaceError: 16,
  });
  viewer.scene.primitives.add(tileset);
  return { tileset, version };
}
```

Resolving the pointer once per session, not per tile, is the point: after that one request every URL the client touches is immutable, so the CDN serves everything from edge cache and the browser serves repeat visits from disk.

`pinnedVersion` is the feature that makes this layout valuable beyond caching. A support engineer investigating a report can pin the session to the build the reporter saw; a QA environment can pin to a build under review while production moves on. Both are impossible when the tileset lives at a single mutable URL.

A running session keeps its version for its lifetime. Switching builds mid-session would mix geometry across two prefixes, which is exactly the problem this design exists to prevent — so a new build is picked up on the next page load, and a "new data available" prompt is the right way to surface it sooner.

### 5. Make switchover and rollback the same operation

```python
def current_pointer(bucket, base_prefix, s3=None):
    s3 = s3 or boto3.client("s3")
    key = POINTER_KEY_TEMPLATE.format(base=base_prefix.strip("/"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
    except s3.exceptions.NoSuchKey:
        return None
    return json.loads(obj["Body"].read())

def switch_to(bucket, base_prefix, target_version, s3=None, history_key=None):
    """Point at an already-published build. This is both deploy and rollback."""
    s3 = s3 or boto3.client("s3")
    base = base_prefix.strip("/")
    probe = f"{base}/{target_version}/tileset.json"
    try:
        s3.head_object(Bucket=bucket, Key=probe)
    except Exception as exc:
        raise RuntimeError(f"refusing to point at {target_version}: {probe} missing ({exc})")

    previous = current_pointer(bucket, base_prefix, s3=s3)
    doc = {
        "schema": 1,
        "version": target_version,
        "tilesetUrl": f"/{base}/{target_version}/tileset.json",
        "publishedAt": datetime.now(timezone.utc).isoformat(),
        "previousVersion": (previous or {}).get("version"),
    }
    s3.put_object(Bucket=bucket,
                  Key=POINTER_KEY_TEMPLATE.format(base=base),
                  Body=json.dumps(doc, sort_keys=True, separators=(",", ":")).encode(),
                  CacheControl=CACHE_POINTER, ContentType="application/json")
    if history_key:
        s3.put_object(Bucket=bucket, Key=history_key,
                      Body=(json.dumps({"at": doc["publishedAt"], **doc}) + "\n").encode(),
                      CacheControl="no-store", ContentType="application/x-ndjson")
    return {"now": target_version, "was": doc["previousVersion"]}

print(switch_to("tiles.example.com", "city", "b-7f3a9c21"))
```

The `head_object` probe before writing the pointer is the guard that prevents the one catastrophic mistake available here: pointing at a prefix that was never uploaded, or was pruned, which takes the tileset offline for everyone within 30 seconds.

Rollback being identical to deploy is the property that makes this design worth the effort. There is no reverse migration, no re-upload and no invalidation — the previous build's files are still there, still cached at the edge, and a 300-byte write brings them back. Recovery time is the pointer's cache lifetime, which is why 30 seconds is a good value for it.

<figure class="diagram">
<svg viewBox="4 6 735 210" role="img" aria-labelledby="ver-headers-t ver-headers-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ver-headers-t">The two cache policies that make this work</title>
  <desc id="ver-headers-d">A table contrasting the cache headers on tile content and on the pointer document. Tile content gets a one-year max-age with the immutable directive, so a browser never revalidates and a CDN edge holds it indefinitely. The pointer gets a thirty-second max-age with stale-while-revalidate, so switchover and rollback both take effect within half a minute without ever blocking a client.</desc>
  <rect class="svg-bg" x="4" y="6" width="735" height="210" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="314" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="528" y="20" width="194" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="196" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="214" y="54" width="314" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="528" y="54" width="194" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="88" width="314" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="528" y="88" width="194" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="122" width="196" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="214" y="122" width="314" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="528" y="122" width="194" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="42">object</text><text x="371" y="42">Cache-Control</text><text x="625" y="42">consequence</text>
    <text x="116" y="76">every tile and subtree</text><text x="371" y="76">max-age=31536000, immutable</text><text x="625" y="76">no revalidation, ever</text>
    <text x="116" y="110">current.json pointer</text><text x="371" y="110">max-age=30, stale-while-revalidate=60</text><text x="625" y="110">switchover in 30 s</text>
    <text x="116" y="144">the mistake</text><text x="371" y="144">immutable on an overwritten path</text><text x="625" y="144">clients hold wrong data for a year</text>
  </g>
  <text x="20" y="176" fill="#1f2937" font-size="12.5">The immutable directive is a promise; only never overwriting a path makes the promise true.</text>
  <text x="20" y="198" fill="#5b6471" font-size="12">A long-lived pointer is the one misconfiguration that makes this scheme worse than doing nothing.</text>
</svg>
<figcaption>One long-lived policy, one short-lived one, and the third row is what happens when they are confused.</figcaption>
</figure>

### 6. Retain and prune old builds

```python
RETENTION = {"keep_versions": 5, "keep_days": 30, "never_prune": set()}

def list_versions(bucket, base_prefix, s3=None):
    s3 = s3 or boto3.client("s3")
    base = base_prefix.strip("/")
    paginator = s3.get_paginator("list_objects_v2")
    versions = {}
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{base}/",
                                   Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            seg = cp["Prefix"][len(base) + 1:].strip("/")
            if seg.startswith("b-"):
                versions[seg] = {"prefix": cp["Prefix"]}
    for version, info in versions.items():
        head = s3.list_objects_v2(Bucket=bucket,
                                  Prefix=f"{info['prefix']}tileset.json", MaxKeys=1)
        contents = head.get("Contents") or []
        info["published"] = contents[0]["LastModified"].isoformat() if contents else None
        info["bytes"] = None
    return dict(sorted(versions.items(),
                       key=lambda kv: kv[1]["published"] or "", reverse=True))

def prune_plan(bucket, base_prefix, s3=None, policy=RETENTION):
    versions = list_versions(bucket, base_prefix, s3=s3)
    pointer = current_pointer(bucket, base_prefix, s3=s3) or {}
    protected = {pointer.get("version"), pointer.get("previousVersion")} | policy["never_prune"]
    protected.discard(None)
    now = datetime.now(timezone.utc)
    plan = []
    for rank, (version, info) in enumerate(versions.items()):
        age_days = None
        if info["published"]:
            age_days = (now - datetime.fromisoformat(info["published"])).days
        if version in protected:
            plan.append({"version": version, "action": "keep", "why": "referenced"})
        elif rank < policy["keep_versions"]:
            plan.append({"version": version, "action": "keep",
                         "why": f"newest {rank + 1}"})
        elif age_days is not None and age_days < policy["keep_days"]:
            plan.append({"version": version, "action": "keep",
                         "why": f"{age_days}d old, inside window"})
        else:
            plan.append({"version": version, "action": "delete",
                         "why": f"{age_days}d old, rank {rank}"})
    return plan

for row in prune_plan("tiles.example.com", "city"):
    print(f"  {row['version']:<14}{row['action']:<8}{row['why']}")
```

Protecting both the current and the *previous* version explicitly is what keeps rollback available. A retention policy that keeps only the current build makes the rollback path a lie, and the moment it matters is the moment it will be discovered.

Old builds are cheap to keep — a city tileset is tens of gigabytes and object storage is inexpensive — so five versions and thirty days is a comfortable default that costs a few hundred gigabytes.

<figure class="diagram">
<svg viewBox="26 3 688 227" role="img" aria-labelledby="ver-time-t ver-time-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ver-time-t">Deploy, incident, rollback</title>
  <desc id="ver-time-d">A timeline. A new build is uploaded over twenty minutes while the old build continues to serve, since nothing references the new prefix yet. The pointer is written, and within thirty seconds new sessions start on the new build. A defect is reported eight minutes later. The pointer is written back to the previous version, and within thirty seconds new sessions are on the old build again, served from edge cache that was never invalidated.</desc>
  <rect class="svg-bg" x="26" y="3" width="688" height="227" fill="#ffffff"/>
  <path d="M40 176 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="46" width="230" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="86" width="210" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="480" y="46" width="220" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="155" y="66">old build serving</text>
    <text x="375" y="106">new build serving</text>
    <text x="590" y="66">old build serving again</text>
  </g>
  <g stroke="#c46a3d" stroke-width="1.8" stroke-dasharray="5 4" fill="none">
    <path d="M270 36 V176"/><path d="M480 36 V176"/>
  </g>
  <g fill="#9a4f26" font-size="12" text-anchor="middle">
    <text x="270" y="30">pointer → new</text>
    <text x="480" y="30">pointer → previous</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="155" y="196">upload 20 min:</text><text x="155" y="212">nothing references it yet</text>
    <text x="375" y="196">defect reported</text><text x="375" y="212">after 8 min</text>
    <text x="590" y="196">recovery = 30 s,</text><text x="590" y="212">no invalidation, cache warm</text>
  </g>
</svg>
<figcaption>Upload is not a deploy, the deploy is one write, and rollback is the same write with the previous version.</figcaption>
</figure>

## Expected Output & Verification

```text
{'version': 'b-7f3a9c21', 'provenance_hash': '7f3a9c21e4b0…',
 'built_at': '2026-09-17T02:14:08.331Z', 'label': '2026-09-17 nightly'}
{'prefix': 'city/b-7f3a9c21/', 'files': 6147, 'skipped': 0, 'gb': 18.42}
{
  "schema": 1,
  "version": "b-7f3a9c21",
  "tilesetUrl": "/city/b-7f3a9c21/tileset.json",
  "provenanceHash": "7f3a9c21e4b0…",
  "label": "2026-09-17 nightly"
}
{'now': 'b-7f3a9c21', 'was': 'b-2c81f0aa'}
  b-7f3a9c21    keep    referenced
  b-2c81f0aa    keep    referenced
  b-91de4c07    keep    newest 3
  b-4408ab12    keep    12d old, inside window
  b-1f70cc93    delete  47d old, rank 5
```

Two versions kept as referenced — current and previous — is the shape that keeps rollback honest. One deletion of a 47-day-old build is the routine outcome once the policy has been running.

Verify the cache headers are actually what was intended, since a misconfigured bucket policy or CDN rule silently overrides them:

```python
import requests

def header_check(base_url, version, sample_tiles):
    rows = []
    for path in [f"{version}/tileset.json", *[f"{version}/{t}" for t in sample_tiles]]:
        r = requests.head(f"{base_url}/{path}", timeout=20)
        cc = r.headers.get("Cache-Control", "")
        rows.append({"path": path, "status": r.status_code, "cache_control": cc,
                     "immutable": "immutable" in cc,
                     "long_lived": "max-age=31536000" in cc,
                     "age": r.headers.get("Age"),
                     "cdn": r.headers.get("CF-Cache-Status") or r.headers.get("X-Cache")})
    p = requests.head(f"{base_url}/current.json", timeout=20)
    pointer_cc = p.headers.get("Cache-Control", "")
    return {
        "tiles_ok": all(x["immutable"] and x["long_lived"] and x["status"] == 200
                        for x in rows),
        "pointer_short_lived": "max-age=30" in pointer_cc or "max-age=60" in pointer_cc,
        "pointer_cache_control": pointer_cc,
        "sample": rows[:3],
    }

print(json.dumps(header_check("https://tiles.example.com/city", "b-7f3a9c21",
                              ["content/0/0/0.glb", "content/1/2/3.glb"]), indent=2))
```

The pointer having a long cache lifetime is the failure that makes this design worse than doing nothing: switchover and rollback both stop working, silently, and the symptom is a deploy that "did not take" for some users.

Then verify that no client can end up mixing builds, by asserting that the tileset under a prefix references only relative paths:

```python
def self_containment_check(base_url, version):
    r = requests.get(f"{base_url}/{version}/tileset.json", timeout=30)
    r.raise_for_status()
    doc = r.json()
    absolute, external = [], []
    def walk(tile, path="root"):
        uri = (tile.get("content") or {}).get("uri")
        if uri:
            if uri.startswith("http") or uri.startswith("/"):
                absolute.append({"at": path, "uri": uri})
            if uri.endswith(".json"):
                external.append({"at": path, "uri": uri})
        for i, c in enumerate(tile.get("children") or []):
            walk(c, f"{path}/{i}")
    walk(doc["root"])
    other_versions = [a for a in absolute if "/b-" in a["uri"] and version not in a["uri"]]
    return {"absolute_uris": len(absolute), "external_tilesets": len(external),
            "references_other_versions": other_versions[:3],
            "self_contained": not other_versions and not absolute}

print(self_containment_check("https://tiles.example.com/city", "b-7f3a9c21"))
```

An absolute URI anywhere in the tileset is how a build ends up referencing another build's content — usually because a generator was given a full base URL. Relative URIs make the whole prefix self-contained by construction, which is the property that guarantees no client mixes builds.

## Performance Notes

- **Uploading 6,147 files takes 8–20 minutes** at typical concurrency. Parallelise at 16–32 connections; it is the slowest part of a deploy and it happens while the old build serves.
- **Skip unchanged files** by comparing content hashes against the previous prefix and using a server-side copy. On an incremental rebuild, 95% of tiles are unchanged and copying is far cheaper than uploading.
- **`immutable` saves one conditional request per tile** on repeat visits, which on a 400-tile session is 400 round trips.
- **The pointer costs one request per session.** With `stale-while-revalidate` it is never on the critical path after the first load.
- **Storage for five builds of a city tileset is about 90 GB.** At commodity object-storage prices that is a rounding error against the cost of a bad deploy.
- **No invalidation calls at all**, which matters because CDN invalidation at 6,000 paths is both slow and, on some providers, billed per path.

## Common Errors

**Clients still see the old build minutes after switchover.** The pointer has a long `Cache-Control`. It must be seconds.

**A tile 404s after deploy.** The pointer was written before the upload finished. Always write it last, and probe the tileset before writing it.

**Mixed geometry in one scene.** The tileset uses absolute URIs pointing outside its own prefix. Make every content URI relative.

**Every nightly build creates a new prefix even though nothing changed.** The provenance hash includes a timestamp or a temporary path. It must contain only inputs, parameters and tool versions.

**Rollback failed: prefix not found.** Retention pruned the previous build. Protect current and previous explicitly.

**The viewer reloads the pointer constantly.** `cache: 'no-cache'` on every tile request rather than only on the pointer. Only the pointer needs it.

**Storage costs climbing fast.** Retention is not running, or an incremental build is re-uploading unchanged tiles under each new prefix instead of server-side copying them.

## Frequently Asked Questions

### Why not use query strings for versioning?

Some CDNs ignore query strings in the cache key by default, and some proxies strip them. A path segment is unambiguous everywhere and is visible in logs.

### Can the pointer be a DNS or CDN rule instead?

It can — a CDN edge rule rewriting `/city/tileset.json` to the current prefix works and keeps the client simpler. The trade is that the rule lives in CDN configuration rather than in an object you can write from the deploy job, which makes rollback a configuration change instead of a file write.

### What about implicit tiling subtree files?

They are content like anything else and live under the same prefix with the same headers. Nothing changes.

## Related Guides

- [Making Tile Output Deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) — what makes the provenance-derived prefix meaningful
- [Detecting Stale Tiles After Deploy](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/detecting-stale-tiles-after-deploy/) — catching the failure this design prevents
- [HTTP/2 and Connection Limits for Tile Streaming](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/http2-and-connection-limits-for-tile-streaming/) — the transport that serves these immutable URLs

Back to [Streaming Sync Patterns](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/).
