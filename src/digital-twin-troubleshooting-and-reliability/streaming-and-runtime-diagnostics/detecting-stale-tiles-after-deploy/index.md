---
title: "Detecting Stale Tiles After Deploy"
description: "Catch a half-updated tileset in production: version stamps in tile metadata, a post-deploy crawl"
---
# Detecting Stale Tiles After Deploy

This page detects the state where part of a tileset is from the new build and part from the old — stamping a build version into tile metadata so a mixed state is visible at all, crawling the deployed tileset after a release, probing the CDN's edges from several regions, and raising an alarm in the client when the tiles it holds disagree.

## Why you hit this

A tileset is thousands of files, and a deploy that replaces them in place is not atomic. For a period that lasts from seconds to a cache lifetime, some clients hold the new root JSON and the old content, or vice versa — and the result is geometry from two builds in one scene: a demolished building standing next to its replacement, or a tile whose bounding volume no longer matches its content.

The immutable-prefix scheme in [versioning tilesets with immutable prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) prevents this by construction and is the right answer. This page is for the situation where that scheme is not in place yet, for verifying that it is working, and for catching the residual cases — a stale pointer at one CDN edge, a client holding a build for a week, a deploy that half-completed.

## Prerequisites

- Python 3.10+ with `requests`; Node for the client-side checks.
- Write access to the tiling pipeline, so a version stamp can be added.
- Ideally a CDN whose edges can be probed by region, or a synthetic-monitoring service.

## Step-by-Step

### 1. Stamp the build version into everything

```python
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

def build_stamp(provenance_hash, label=None):
    return {
        "buildId": f"b-{provenance_hash[:8]}",
        "provenanceHash": provenance_hash,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "label": label or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }

def stamp_tileset(tileset_path, stamp, schema_class="buildProvenance"):
    """Put the stamp where a client can read it without extra requests."""
    doc = json.loads(Path(tileset_path).read_text())
    doc.setdefault("asset", {})["tilesetVersion"] = stamp["buildId"]

    schema = doc.setdefault("schema", {"id": "build-provenance-1",
                                       "classes": {}})
    schema["classes"].setdefault(schema_class, {
        "name": "Build provenance",
        "properties": {
            "buildId": {"type": "STRING", "required": True},
            "builtAt": {"type": "STRING", "required": True},
            "provenanceHash": {"type": "STRING", "required": True},
        },
    })
    doc["metadata"] = {
        "class": schema_class,
        "properties": {k: stamp[k] for k in
                       ("buildId", "builtAt", "provenanceHash")},
    }

    stamped = 0
    def walk(tile):
        nonlocal stamped
        if tile.get("content"):
            tile.setdefault("metadata", {"class": schema_class, "properties": {}})
            tile["metadata"]["class"] = schema_class
            tile["metadata"].setdefault("properties", {})["buildId"] = stamp["buildId"]
            stamped += 1
        for child in tile.get("children", []):
            walk(child)
    walk(doc["root"])

    Path(tileset_path).write_text(json.dumps(doc, sort_keys=True,
                                             separators=(",", ":")))
    return {"tileset": str(tileset_path), "buildId": stamp["buildId"],
            "tiles_stamped": stamped}

def stamp_content(glb_path, stamp):
    """A build id in the glTF's asset extras — readable by any glTF tool."""
    import struct
    data = Path(glb_path).read_bytes()
    magic, version, total = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, f"{glb_path} is not a GLB"
    json_len, json_type = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + json_len].decode("utf-8"))
    doc.setdefault("asset", {}).setdefault("extras", {})["buildId"] = stamp["buildId"]

    new_json = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    new_json += b" " * ((4 - len(new_json) % 4) % 4)
    rest = data[20 + json_len:]
    out = struct.pack("<III", magic, version, 12 + 8 + len(new_json) + len(rest))
    out += struct.pack("<II", len(new_json), json_type) + new_json + rest
    Path(glb_path).write_bytes(out)
    return {"path": str(glb_path), "buildId": stamp["buildId"],
            "bytes": len(out)}
```

A build identifier in **both** the tileset JSON and the content files is what makes staleness detectable at all. Without it, a stale tile is indistinguishable from a current one: the bytes differ and nothing says which build they came from, so no check can be written.

Stamping the tileset's `asset.tilesetVersion` costs nothing and is the field a client reads first. Stamping every tile's metadata costs about 30 bytes per tile — 180 KB on a 6,000-tile city before gzip — and is what lets the client detect a *mixed* state rather than just knowing which root it has.

Stamping the glTF's `asset.extras` is the part that makes a server-side crawl possible without decoding geometry: a `HEAD`-then-partial-`GET` of the first few kilobytes reveals the build id.

### 2. Crawl the deployment and check for mixing

```python
import concurrent.futures
import json
import struct
from collections import Counter

import requests

def read_glb_build_id(url, session, chunk=16384):
    """Fetch only the GLB header and JSON chunk, not the geometry."""
    r = session.get(url, headers={"Range": f"bytes=0-{chunk - 1}"}, timeout=20)
    if r.status_code not in (200, 206):
        return {"url": url, "status": r.status_code, "buildId": None}
    data = r.content
    if len(data) < 20 or struct.unpack_from("<I", data, 0)[0] != 0x46546C67:
        return {"url": url, "status": r.status_code, "buildId": None,
                "error": "not a GLB"}
    json_len = struct.unpack_from("<I", data, 12)[0]
    if 20 + json_len > len(data):
        r2 = session.get(url, headers={"Range": f"bytes=0-{20 + json_len}"},
                         timeout=20)
        data = r2.content
    try:
        doc = json.loads(data[20:20 + json_len].decode("utf-8"))
    except Exception as exc:
        return {"url": url, "status": r.status_code, "buildId": None,
                "error": repr(exc)[:80]}
    return {
        "url": url,
        "status": r.status_code,
        "buildId": doc.get("asset", {}).get("extras", {}).get("buildId"),
        "age": r.headers.get("Age"),
        "cdnStatus": r.headers.get("CF-Cache-Status") or r.headers.get("X-Cache"),
        "etag": r.headers.get("ETag"),
    }

def crawl_deployment(base_url, expected_build_id, sample=400, workers=16):
    session = requests.Session()
    pointer = session.get(f"{base_url}/current.json",
                          headers={"Cache-Control": "no-cache"}, timeout=20)
    pointer_doc = pointer.json() if pointer.status_code == 200 else {}
    tileset_url = pointer_doc.get("tilesetUrl", f"{base_url}/tileset.json")
    if not tileset_url.startswith("http"):
        tileset_url = f"{base_url.rstrip('/')}/{tileset_url.lstrip('/')}"

    ts = session.get(tileset_url, headers={"Cache-Control": "no-cache"}, timeout=30)
    ts.raise_for_status()
    doc = ts.json()
    root_build = doc.get("asset", {}).get("tilesetVersion")

    content_urls, declared = [], []
    prefix = tileset_url.rsplit("/", 1)[0]
    def walk(tile):
        uri = (tile.get("content") or {}).get("uri")
        if uri and not uri.endswith(".json"):
            content_urls.append(uri if uri.startswith("http")
                                else f"{prefix}/{uri}")
            declared.append(((tile.get("metadata") or {})
                             .get("properties") or {}).get("buildId"))
        for child in tile.get("children", []):
            walk(child)
    walk(doc["root"])

    import random
    idx = random.sample(range(len(content_urls)), min(sample, len(content_urls)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda i: read_glb_build_id(content_urls[i], session),
                                idx))
    for r, i in zip(results, idx):
        r["declaredBuildId"] = declared[i]

    found = Counter(r["buildId"] for r in results)
    mismatched = [r for r in results
                  if r["buildId"] and r["declaredBuildId"]
                  and r["buildId"] != r["declaredBuildId"]]
    wrong_build = [r for r in results
                   if r["buildId"] and r["buildId"] != expected_build_id]

    return {
        "pointerBuildId": pointer_doc.get("version"),
        "rootBuildId": root_build,
        "expectedBuildId": expected_build_id,
        "sampled": len(results),
        "totalContentTiles": len(content_urls),
        "buildIdsFound": dict(found),
        "distinctBuilds": len([k for k in found if k]),
        "unstamped": found.get(None, 0),
        "wrongBuildCount": len(wrong_build),
        "declaredVsActualMismatch": len(mismatched),
        "mixed": len([k for k in found if k]) > 1,
        "examples": wrong_build[:4],
        "pass": (root_build == expected_build_id
                 and not [k for k in found if k and k != expected_build_id]
                 and not mismatched),
    }
```

Fetching only the first 16 KB with a `Range` header is what makes a 400-tile crawl cheap: the build id is in the glTF JSON chunk at the start of the file, so a 400 KB tile costs 16 KB to check. A 400-tile sample is about 6 MB and a few seconds.

Comparing the **declared** build id from the tileset's tile metadata against the **actual** one from the content is the check that catches a half-completed deploy precisely. The tileset says this tile belongs to build `b-7f3a9c21`; the file says `b-2c81f0aa`; the two disagree, and that is a mixed state with no ambiguity.

Reading `Age` and the CDN cache status alongside is what turns a finding into a cause: a stale tile with `Age: 84000` and `CF-Cache-Status: HIT` is an edge holding an old object, which is a different problem from a stale tile served fresh from the origin.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="stale-mix-t stale-mix-d" xmlns="http://www.w3.org/2000/svg">
  <title id="stale-mix-t">Four ways a deploy leaves a mixed state</title>
  <desc id="stale-mix-d">A table of four mixed states. New root with old content happens when the JSON has a short cache lifetime and the tiles a long one, and the symptom is bounding volumes that no longer match their content. Old root with new content happens when a client holds a cached root, and the symptom is missing tiles. One stale CDN edge means some regions see the old build entirely. A client holding a build for days sees a self-consistent old build, which is harmless unless it is compared against fresh data.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="218" y="20" width="244" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="462" y="20" width="260" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="200" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="54" width="244" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="54" width="260" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="100" width="200" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="218" y="100" width="244" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="462" y="100" width="260" height="46" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="146" width="200" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="218" y="146" width="244" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="462" y="146" width="260" height="46" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="192" width="200" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="218" y="192" width="244" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="192" width="260" height="46" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="118" y="41">state</text><text x="340" y="41">cause</text>
    <text x="592" y="41">symptom</text>
    <text x="118" y="74">new root,</text><text x="118" y="92">old content</text>
    <text x="340" y="74">JSON has a short lifetime,</text><text x="340" y="92">tiles a long one</text>
    <text x="592" y="74">volumes no longer match</text><text x="592" y="92">their content</text>
    <text x="118" y="120">old root,</text><text x="118" y="138">new content</text>
    <text x="340" y="120">the client holds a cached</text><text x="340" y="138">root document</text>
    <text x="592" y="120">tiles 404, districts</text><text x="592" y="138">missing</text>
    <text x="118" y="166">one stale</text><text x="118" y="184">CDN edge</text>
    <text x="340" y="166">a purge that did not reach</text><text x="340" y="184">every POP</text>
    <text x="592" y="166">some regions see the old</text><text x="592" y="184">build entirely</text>
    <text x="118" y="212">client holds a</text><text x="118" y="230">build for days</text>
    <text x="340" y="212">immutable URLs and a long</text><text x="340" y="230">session</text>
    <text x="592" y="212">self-consistent old build —</text><text x="592" y="230">harmless, but surprising</text>
  </g>
</svg>
<figcaption>Only the last row is self-consistent; the first two put geometry from two builds in one scene.</figcaption>
</figure>

### 3. Probe the edges, not just the origin

```python
EDGE_PROBES = {
    "eu-north": "https://eu-north.probe.example.com",
    "eu-west": "https://eu-west.probe.example.com",
    "us-east": "https://us-east.probe.example.com",
    "ap-southeast": "https://ap-southeast.probe.example.com",
}

def probe_pointer(base_url, expected_build_id, probes=EDGE_PROBES,
                  timeout=20):
    """Ask each region what the pointer says. A purge that missed one POP shows here."""
    rows = []
    for region, proxy in probes.items():
        try:
            r = requests.get(f"{base_url}/current.json",
                             proxies={"https": proxy, "http": proxy},
                             timeout=timeout)
            doc = r.json() if r.status_code == 200 else {}
            rows.append({
                "region": region,
                "status": r.status_code,
                "buildId": doc.get("version"),
                "age": int(r.headers.get("Age", 0) or 0),
                "cdnStatus": r.headers.get("CF-Cache-Status")
                             or r.headers.get("X-Cache"),
                "cacheControl": r.headers.get("Cache-Control"),
                "matches": doc.get("version") == expected_build_id,
            })
        except Exception as exc:
            rows.append({"region": region, "status": None,
                         "error": repr(exc)[:100], "matches": False})

    builds = {r.get("buildId") for r in rows if r.get("buildId")}
    stale = [r for r in rows if r.get("buildId") and not r["matches"]]
    return {
        "regions": len(rows),
        "rows": rows,
        "distinctBuilds": len(builds),
        "consistent": len(builds) <= 1,
        "staleRegions": [r["region"] for r in stale],
        "worstAgeSeconds": max((r.get("age", 0) for r in rows), default=0),
        "pass": len(builds) == 1 and not stale,
        "advice": ("a region is serving an old pointer — check the purge reached "
                   "every POP, and that the pointer's Cache-Control is seconds "
                   "rather than minutes") if stale else "all regions agree",
    }

def wait_for_edge_convergence(base_url, expected_build_id, probes=EDGE_PROBES,
                              timeout_s=300, interval_s=15):
    import time
    started = time.time()
    history = []
    while time.time() - started < timeout_s:
        result = probe_pointer(base_url, expected_build_id, probes)
        history.append({"at": round(time.time() - started, 1),
                        "consistent": result["consistent"],
                        "stale": result["staleRegions"]})
        if result["pass"]:
            return {"converged": True,
                    "seconds": round(time.time() - started, 1),
                    "history": history}
        time.sleep(interval_s)
    return {"converged": False, "seconds": timeout_s, "history": history,
            "advice": "the pointer's cache lifetime is longer than the deploy "
                      "expects, or a purge is not propagating"}
```

Probing from several regions is the only way to find a stale edge, because the origin is always correct and the problem is a cached copy somewhere else. A CDN purge that silently missed one point of presence produces a subset of users on the old build for its full cache lifetime, and no origin-side check sees it.

Measuring the **convergence time** is the more useful version of this. A deploy is not finished when the pointer is written; it is finished when every edge agrees, and knowing that this takes 45 seconds rather than 20 minutes is what makes a deploy procedure trustworthy.

The `Age` header is the direct evidence: an edge serving a pointer with `Age: 840` when the pointer's `max-age` is 30 means the edge is not revalidating, which is a CDN configuration finding rather than a deploy one.

<figure class="diagram">
<svg viewBox="6 11 708 239" role="img" aria-labelledby="stale-converge-t stale-converge-d" xmlns="http://www.w3.org/2000/svg">
  <title id="stale-converge-t">Edge convergence after the pointer write</title>
  <desc id="stale-converge-d">A timeline of four CDN regions after the pointer is written at time zero. The EU north region reports the new build at 12 seconds, EU west at 18 and US east at 31, all within the 30-second pointer cache lifetime. The Asia Pacific south-east region is still reporting the old build at 300 seconds, because a purge did not reach that point of presence and its cached pointer has an age of 842 seconds against a 30-second max-age. A deploy is not finished when the pointer is written; it is finished when every region agrees.</desc>
  <rect class="svg-bg" x="6" y="11" width="708" height="239" fill="#ffffff"/>
  <path d="M132 188 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <path d="M132 36 V188" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.4">
    <rect x="132" y="44" width="52" height="24" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="184" y="44" width="516" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="132" y="78" width="78" height="24" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="210" y="78" width="490" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="132" y="112" width="134" height="24" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="266" y="112" width="434" height="24" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="132" y="146" width="568" height="24" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12">
    <text x="20" y="61">eu-north</text>
    <text x="20" y="95">eu-west</text>
    <text x="20" y="129">us-east</text>
    <text x="20" y="163">ap-southeast</text>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="192" y="38">12 s</text>
    <text x="218" y="38">18 s</text>
    <text x="274" y="38">31 s</text>
    <text x="416" y="163">still the old build at 300 s — Age 842, max-age 30</text>
  </g>
  <g font-size="11.5">
    <text x="132" y="212" fill="#9a4f26">orange: still serving the old pointer</text>
    <text x="360" y="212" fill="#4f7a4d">green: new build</text>
  </g>
  <text x="132" y="232" fill="#5b6471" font-size="12">a deploy is finished when every region agrees, not when the pointer is written</text>
</svg>
<figcaption>Three regions converge inside the pointer's cache lifetime; the fourth never does, which is the finding an origin-side check cannot make.</figcaption>
</figure>

### 4. Detect a mixed state in the client

```javascript
export class BuildConsistencyMonitor {
  constructor(tileset, { expectedBuildId = null, onMixed = null } = {}) {
    this.tileset = tileset;
    this.expectedBuildId = expectedBuildId
      ?? tileset.asset?.tilesetVersion
      ?? null;
    this.onMixed = onMixed ?? ((detail) => console.warn('mixed build', detail));
    this.seen = new Map();          // buildId -> count
    this.mixedReported = false;
    this._handler = (tile) => this.#inspect(tile);
    tileset.tileLoad.addEventListener(this._handler);
  }

  #inspect(tile) {
    const fromMetadata = tile.metadata?.getProperty?.('buildId') ?? null;
    const fromContent = tile.content?.gltf?.asset?.extras?.buildId
      ?? tile.content?._model?.gltf?.asset?.extras?.buildId
      ?? null;
    const buildId = fromContent ?? fromMetadata;
    if (!buildId) return;

    this.seen.set(buildId, (this.seen.get(buildId) ?? 0) + 1);

    if (fromMetadata && fromContent && fromMetadata !== fromContent) {
      this.#report({
        kind: 'declared-vs-actual',
        declared: fromMetadata,
        actual: fromContent,
        uri: tile._contentResource?.url,
      });
      return;
    }
    if (this.expectedBuildId && buildId !== this.expectedBuildId) {
      this.#report({
        kind: 'unexpected-build',
        expected: this.expectedBuildId,
        actual: buildId,
        uri: tile._contentResource?.url,
      });
      return;
    }
    if (this.seen.size > 1) {
      this.#report({ kind: 'multiple-builds',
                     builds: Object.fromEntries(this.seen) });
    }
  }

  #report(detail) {
    if (this.mixedReported) return;
    this.mixedReported = true;
    this.onMixed({ ...detail, at: new Date().toISOString(),
                   tilesInspected: [...this.seen.values()]
                     .reduce((a, b) => a + b, 0) });
  }

  summary() {
    return {
      expectedBuildId: this.expectedBuildId,
      buildsSeen: Object.fromEntries(this.seen),
      distinctBuilds: this.seen.size,
      mixed: this.seen.size > 1,
      tilesInspected: [...this.seen.values()].reduce((a, b) => a + b, 0),
    };
  }

  dispose() {
    this.tileset.tileLoad.removeEventListener(this._handler);
  }
}

export function installMixedBuildAlarm(viewer, tileset, { report } = {}) {
  return new BuildConsistencyMonitor(tileset, {
    onMixed: async (detail) => {
      console.warn('[tileset] mixed build detected', detail);
      if (report) {
        try {
          await fetch(report, {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...detail,
              userAgent: navigator.userAgent,
              url: location.href,
            }),
          });
        } catch { /* never let telemetry break the viewer */ }
      }
    },
  });
}
```

Detecting the mixed state in the client is the only check that sees what a user actually got. A server-side crawl confirms the deployment is consistent; it cannot know that a particular browser is holding a root document from last week alongside tiles from today.

Reporting once per session rather than per tile is what keeps this from becoming a telemetry flood: a mixed state affects every tile, so a single report with the build ids is the useful signal.

Swallowing the telemetry failure is deliberate. A monitoring call that throws inside a `tileLoad` handler can break tile loading, which turns a cosmetic problem into an outage.

### 5. Gate the deploy on consistency

```python
def deploy_verification(base_url, expected_build_id, sample=400,
                        probes=EDGE_PROBES, converge_timeout_s=300):
    crawl = crawl_deployment(base_url, expected_build_id, sample=sample)
    convergence = wait_for_edge_convergence(base_url, expected_build_id,
                                            probes=probes,
                                            timeout_s=converge_timeout_s)
    edges = probe_pointer(base_url, expected_build_id, probes=probes)

    findings = []
    if crawl["rootBuildId"] != expected_build_id:
        findings.append({
            "severity": "error",
            "issue": f"the served root declares {crawl['rootBuildId']}, expected "
                     f"{expected_build_id}",
            "fix": "the pointer or the root was not updated; re-run the switchover",
        })
    if crawl["mixed"]:
        findings.append({
            "severity": "error",
            "issue": f"content from {crawl['distinctBuilds']} builds is being served: "
                     f"{sorted(k for k in crawl['buildIdsFound'] if k)}",
            "fix": "a previous deploy overwrote in place; move to immutable prefixes",
        })
    if crawl["declaredVsActualMismatch"]:
        findings.append({
            "severity": "error",
            "issue": f"{crawl['declaredVsActualMismatch']} tile(s) whose metadata and "
                     f"content disagree on the build",
            "fix": "the upload did not complete; re-upload and re-verify",
        })
    if crawl["unstamped"]:
        findings.append({
            "severity": "warn",
            "issue": f"{crawl['unstamped']} sampled tile(s) carry no build id",
            "fix": "add the stamp to the content pipeline; unstamped tiles cannot "
                   "be checked",
        })
    if not edges["consistent"]:
        findings.append({
            "severity": "error",
            "issue": f"regions disagree: {edges['staleRegions']} still serve an old "
                     f"pointer",
            "fix": edges["advice"],
        })
    if not convergence["converged"]:
        findings.append({
            "severity": "error",
            "issue": f"edges had not converged after {convergence['seconds']} s",
            "fix": convergence["advice"],
        })

    errors = [f for f in findings if f["severity"] == "error"]
    return {
        "expectedBuildId": expected_build_id,
        "crawl": {k: v for k, v in crawl.items() if k != "examples"},
        "edges": {k: v for k, v in edges.items() if k != "rows"},
        "convergenceSeconds": convergence.get("seconds"),
        "findings": findings,
        "errors": len(errors),
        "pass": not errors,
        "summary": ("deploy verified" if not errors
                    else f"deploy NOT verified: {len(errors)} blocking finding(s)"),
    }
```

Running this immediately after the pointer write, as part of the deploy job rather than as a separate exercise, is what makes it useful. A deploy that reports "verified" has actually been checked from four regions against 400 sampled tiles; one that reports a mixed state can be rolled back with the single pointer write from the versioning scheme before anyone notices.

Treating unstamped tiles as a warning rather than an error is the pragmatic choice during adoption: a tileset being migrated will have old content without stamps, and the check should report the gap rather than blocking every deploy until the backfill is done.

### 6. Watch for the slow case: a client on an old build

```javascript
export function installBuildFreshnessCheck(tileset, {
  pointerUrl, intervalMs = 15 * 60 * 1000, onNewBuild = null } = {}) {
  const current = tileset.asset?.tilesetVersion ?? null;
  let stopped = false;

  const check = async () => {
    if (stopped) return;
    try {
      const res = await fetch(pointerUrl, { cache: 'no-cache' });
      if (res.ok) {
        const doc = await res.json();
        if (current && doc.version && doc.version !== current) {
          const detail = {
            sessionBuild: current,
            latestBuild: doc.version,
            publishedAt: doc.publishedAt ?? null,
            sessionAgeMinutes: Math.round(performance.now() / 60_000),
          };
          if (onNewBuild) onNewBuild(detail);
          return;                       // stop polling once reported
        }
      }
    } catch { /* offline is not an error here */ }
    setTimeout(check, intervalMs);
  };
  setTimeout(check, intervalMs);
  return { stop() { stopped = true; } };
}

export function newBuildPrompt(detail, { onReload } = {}) {
  return {
    level: 'info',
    message: `Newer data is available (${detail.latestBuild}). `
      + 'Reload to see it.',
    detail,
    action: { label: 'Reload', run: onReload ?? (() => location.reload()) },
    rationale: 'switching tilesets mid-session would mix geometry from two builds, '
      + 'so the safe action is a reload rather than a hot swap',
  };
}
```

A long-lived session on an old build is **not** a bug and should not be fixed by swapping the tileset. With immutable prefixes the session is entirely self-consistent — it is looking at a complete, correct, slightly old city — and hot-swapping would be the thing that creates a mixed state.

Prompting instead is the correct behaviour, and it is worth stating in the code why: a reload starts a clean session on the new build, and a swap does not.

Stopping the poll after reporting once avoids nagging, and polling at fifteen minutes rather than every minute keeps the pointer request negligible.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="stale-verify-t stale-verify-d" xmlns="http://www.w3.org/2000/svg">
  <title id="stale-verify-t">Three checks, three blind spots covered</title>
  <desc id="stale-verify-d">A table of three verification layers. The origin crawl samples 400 tiles and compares declared against actual build ids, catching a half-completed upload, but it cannot see a stale CDN edge. The multi-region pointer probe catches a purge that missed a point of presence, but it cannot see what a specific browser holds. The client-side monitor catches a browser holding a mixed state, but only for users who load the page. All three together leave no gap.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="458" y="20" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="54" width="264" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="54" width="264" height="52" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="106" width="176" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="106" width="264" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="106" width="264" height="52" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="158" width="176" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="158" width="264" height="52" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="158" width="264" height="52" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="41">layer</text><text x="326" y="41">catches</text>
    <text x="590" y="41">cannot see</text>
    <text x="106" y="74">origin crawl</text><text x="106" y="92">400 sampled tiles</text>
    <text x="326" y="74">a half-completed upload; metadata</text>
    <text x="326" y="92">and content disagreeing</text>
    <text x="590" y="74">a stale CDN edge — the origin</text>
    <text x="590" y="92">is always correct</text>
    <text x="106" y="126">multi-region</text><text x="106" y="144">pointer probe</text>
    <text x="326" y="126">a purge that missed a point of</text>
    <text x="326" y="144">presence; slow convergence</text>
    <text x="590" y="126">what a specific browser is</text>
    <text x="590" y="144">holding right now</text>
    <text x="106" y="178">client monitor</text><text x="106" y="196">per session</text>
    <text x="326" y="178">a browser holding a mixed state</text>
    <text x="326" y="196">from two builds</text>
    <text x="590" y="178">anything, until a user loads</text>
    <text x="590" y="196">the page</text>
  </g>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">each layer's blind spot is another layer's finding; none of them is sufficient alone</text>
</svg>
<figcaption>The origin is always right, which is exactly why an origin-only check cannot find a stale deployment.</figcaption>
</figure>

## Expected Output & Verification

```text
{'tileset': 'output/city/tileset.json', 'buildId': 'b-7f3a9c21',
 'tiles_stamped': 4812}
{
  "pointerBuildId": "b-7f3a9c21",
  "rootBuildId": "b-7f3a9c21",
  "expectedBuildId": "b-7f3a9c21",
  "sampled": 400, "totalContentTiles": 4812,
  "buildIdsFound": {"b-7f3a9c21": 382, "b-2c81f0aa": 14, "null": 4},
  "distinctBuilds": 2, "unstamped": 4,
  "wrongBuildCount": 14, "declaredVsActualMismatch": 14,
  "mixed": true, "pass": false,
  "examples": [
    {"url": ".../content/3/14/9.glb", "buildId": "b-2c81f0aa",
     "declaredBuildId": "b-7f3a9c21", "age": "84120", "cdnStatus": "HIT"},
    {"url": ".../content/3/14/10.glb", "buildId": "b-2c81f0aa",
     "declaredBuildId": "b-7f3a9c21", "age": "84118", "cdnStatus": "HIT"}
  ]
}
{
  "regions": 4, "distinctBuilds": 2, "consistent": false,
  "staleRegions": ["ap-southeast"], "worstAgeSeconds": 842,
  "pass": false,
  "advice": "a region is serving an old pointer — check the purge reached every POP, and that the pointer's Cache-Control is seconds rather than minutes"
}
{
  "expectedBuildId": "b-7f3a9c21",
  "convergenceSeconds": 300,
  "errors": 3,
  "pass": false,
  "summary": "deploy NOT verified: 3 blocking finding(s)",
  "findings": [
    {"severity": "error",
     "issue": "content from 2 builds is being served: ['b-2c81f0aa', 'b-7f3a9c21']",
     "fix": "a previous deploy overwrote in place; move to immutable prefixes"},
    {"severity": "error",
     "issue": "14 tile(s) whose metadata and content disagree on the build",
     "fix": "the upload did not complete; re-upload and re-verify"},
    {"severity": "error",
     "issue": "regions disagree: ['ap-southeast'] still serve an old pointer",
     "fix": "a region is serving an old pointer — check the purge reached every POP..."}
  ]
}
```

Fourteen tiles from the previous build, all with `CF-Cache-Status: HIT` and an `Age` of about 84,000 seconds, is the diagnosis in one line: those objects are cached at the edge from a deploy that overwrote paths in place, and the edge is serving them for their full one-year lifetime.

The `ap-southeast` region on an old pointer is a second, independent finding — a purge that did not reach that point of presence — and it would have been invisible to any origin-side check.

Verify the checks catch a deliberately mixed state, because a verification that never fails is not a verification:

```python
def verification_self_test(base_url, current_build_id, staging_dir="build/selftest"):
    """Publish a deliberately mixed tileset to a test prefix and confirm detection."""
    import shutil

    test_prefix = f"{base_url}/selftest"
    shutil.rmtree(staging_dir, ignore_errors=True)
    Path(staging_dir).mkdir(parents=True, exist_ok=True)

    results = {}

    # Case 1: everything consistent — must pass.
    consistent = crawl_deployment(f"{test_prefix}/consistent", current_build_id,
                                  sample=40)
    results["consistent_passes"] = consistent["pass"]

    # Case 2: a handful of tiles from an older build — must fail as mixed.
    mixed = crawl_deployment(f"{test_prefix}/mixed", current_build_id, sample=40)
    results["mixed_detected"] = mixed["mixed"] and not mixed["pass"]
    results["mixed_count"] = mixed["wrongBuildCount"]

    # Case 3: the root declares a build the content does not carry.
    mismatch = crawl_deployment(f"{test_prefix}/mismatch", current_build_id,
                                sample=40)
    results["mismatch_detected"] = mismatch["declaredVsActualMismatch"] > 0

    # Case 4: unstamped content — must warn, not pass silently.
    unstamped = crawl_deployment(f"{test_prefix}/unstamped", current_build_id,
                                 sample=40)
    results["unstamped_reported"] = unstamped["unstamped"] > 0

    results["all_cases_correct"] = (
        results["consistent_passes"] and results["mixed_detected"]
        and results["mismatch_detected"] and results["unstamped_reported"])
    return results
```

Four fixtures on a test prefix — consistent, mixed, mismatched and unstamped — and the check must classify all four correctly. Running this when the verification is written, and again whenever the stamping changes, is what keeps it from quietly becoming a no-op.

Then verify the headers make the whole problem impossible, which is the real fix:

```python
def header_policy_check(base_url, sample_tile_paths, pointer_path="current.json"):
    session = requests.Session()
    rows = []
    for path in sample_tile_paths[:8]:
        r = session.head(f"{base_url}/{path}", timeout=20)
        cc = r.headers.get("Cache-Control", "")
        rows.append({
            "path": path,
            "cacheControl": cc,
            "immutable": "immutable" in cc,
            "longLived": "max-age=31536000" in cc,
            "pathIsVersioned": "/b-" in path,
        })
    p = session.head(f"{base_url}/{pointer_path}", timeout=20)
    pointer_cc = p.headers.get("Cache-Control", "")

    tiles_ok = all(r["immutable"] and r["longLived"] and r["pathIsVersioned"]
                   for r in rows)
    pointer_ok = any(f"max-age={n}" in pointer_cc for n in (10, 15, 30, 60))
    return {
        "tiles": rows,
        "pointerCacheControl": pointer_cc,
        "tilesImmutableAndVersioned": tiles_ok,
        "pointerShortLived": pointer_ok,
        "staleMixingPossible": not (tiles_ok and pointer_ok),
        "verdict": ("immutable prefixes plus a short-lived pointer make a mixed "
                    "state structurally impossible"
                    if tiles_ok and pointer_ok else
                    "the header policy permits mixing; the checks above are "
                    "detecting a problem that should not be possible"),
    }
```

This is the check that closes the loop. Immutable, long-lived, version-prefixed tile URLs plus a short-lived pointer make every mixed state on this page structurally impossible — so a passing header policy means the detection machinery is a belt-and-braces measure rather than a necessity.

## Performance Notes

- **Range requests make the crawl cheap**: 16 KB per tile instead of 400 KB, so a 400-tile sample is about 6 MB.
- **Crawl with 16 concurrent workers.** More adds little because the checks are small and latency-bound.
- **Sample, do not exhaustively crawl.** A mixed state affecting 14 of 4,812 tiles is found in a 400-tile sample with high probability, and a full crawl costs 75 MB for no extra certainty.
- **The build stamp costs about 30 bytes per tile** in the tileset JSON and a few bytes in each GLB — under 200 KB on a city before gzip.
- **Probe the edges from a monitoring service** rather than proxies where possible; a synthetic check from four regions every deploy is cheaper to operate.
- **Poll the pointer from the client at 15 minutes**, not every minute. The pointer is a few hundred bytes and the urgency is low.

## Common Errors

**Every tile reports `buildId: null`.** The content pipeline is not stamping. Add it; unstamped tiles cannot be checked.

**The crawl passes and users still see mixed geometry.** The origin is consistent and an edge is not. Probe the regions.

**`Range` requests return the whole file.** The server does not support byte ranges; the crawl still works and costs full tile size.

**`declaredVsActualMismatch` on every tile.** The tileset stamping and the content stamping ran in different builds. Stamp both in one pass.

**The edge probe reports the same build everywhere and a user disagrees.** The user's browser is holding a cached root. The client monitor is the layer that sees this.

**Convergence never completes.** The pointer's `Cache-Control` is minutes rather than seconds, so edges legitimately serve the old value.

**Mixed states keep appearing despite immutable prefixes.** Something is writing to an existing prefix. The header policy check plus the publish-time refusal in the versioning scheme prevent it.

## Frequently Asked Questions

### Is this needed with immutable prefixes?

Not to prevent mixing, which becomes impossible. It remains worth running as a verification that the scheme is actually in force — a single deploy that writes to an old prefix reintroduces the problem, and the crawl is how that is caught.

### Should a mixed state roll the deploy back automatically?

Yes, where the rollback is a single pointer write. The risk of an automatic rollback is far lower than the risk of serving two builds, and recovery takes the pointer's cache lifetime.

### How large a sample is enough?

For a defect affecting more than about 1% of tiles, 400 samples is ample. For a defect affecting a specific district, sample by spatial stratum rather than uniformly so each district is represented.

## Related Guides

- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — the scheme that makes this impossible by construction
- [Making Tile Output Deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) — where the provenance hash in the build id comes from
- [Debugging with the Cesium 3D Tiles Inspector](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/debugging-with-the-cesium-3d-tiles-inspector/) — reading the tileset version a session is actually holding

Back to [Streaming and Runtime Diagnostics](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
