# Fixing CORS and Content-Encoding Errors on Tile Servers

This page diagnoses the family of tileset failures where every file downloads perfectly with `curl` and nothing renders in the browser — missing or cached-away CORS headers, preflight requests the server rejects, pre-compressed tiles served without `Content-Encoding`, tiles compressed twice, and MIME types that make a CDN or proxy mangle binary content — with a Python probe that inspects the raw bytes and headers exactly as a browser would receive them.

## Why you hit this

A tileset is dozens to millions of small files fetched cross-origin by JavaScript, which is the combination that triggers every browser security rule and every CDN optimisation at once. Moving tiles from a local dev server to object storage behind a CDN is when these errors appear, and they are confusing because they are intermittent (a CDN edge cached a bad response for one region), origin-dependent (the staging viewer works and production does not), or reported far from the cause (`RangeError: Invalid typed array length` for what is actually a gzip header problem). The deployment itself is covered in [automated 3D Tiles deployment to CDN](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/automated-3d-tiles-deployment-to-cdn/).

## Prerequisites

- Python 3.10+ with `requests>=2.31` and, for S3-hosted tiles, `boto3>=1.34`.
- The tileset URL, one content URL at each level of the tree, and the exact origin of the viewer page, for example `https://twin.example.org`.
- Access to the browser's developer tools network panel with "Disable cache" available.

## Step-by-Step

### 1. Probe a tile the way the browser requests it

```python
import requests

VIEWER_ORIGIN = "https://twin.example.org"
MAGIC = {b"glTF": "glb", b"b3dm": "b3dm", b"pnts": "pnts", b"i3dm": "i3dm",
         b"cmpt": "cmpt", b"subt": "subtree", b"\x1f\x8b\x08\x00": "gzip!", b"{\n  \"": "json"}

def probe(url, origin=VIEWER_ORIGIN, auth=None):
    headers = {"Origin": origin, "Accept-Encoding": "gzip, br"}
    if auth:
        headers["Authorization"] = auth
    r = requests.get(url, headers=headers, stream=True, timeout=20)
    head = r.raw.read(4, decode_content=False)            # the bytes on the wire, not decoded
    body = requests.get(url, headers=headers, timeout=20).content[:4]
    return {
        "status": r.status_code,
        "content-type": r.headers.get("Content-Type"),
        "content-encoding": r.headers.get("Content-Encoding"),
        "acao": r.headers.get("Access-Control-Allow-Origin"),
        "vary": r.headers.get("Vary"),
        "cache": r.headers.get("CF-Cache-Status") or r.headers.get("X-Cache"),
        "wire_magic": MAGIC.get(head, head.hex()),
        "decoded_magic": MAGIC.get(body, body.hex()),
    }

for u in ("https://tiles.example.org/city/tileset.json",
          "https://tiles.example.org/city/content/0/0/0.glb",
          "https://tiles.example.org/city/content/14/8812/5631.glb"):
    print(u.rsplit("/", 3)[-3:], probe(u))
```

Two readings of the first bytes are compared. `wire_magic` reads the stream without decompression, which is what the network carried; `decoded_magic` lets `requests` decode according to `Content-Encoding`, which is what `fetch()` hands to the tileset loader. A healthy compressed tile shows `gzip!` on the wire and `glb` after decoding. A tile whose decoded bytes still start with `1f 8b` was stored gzipped without the header, and the loader receives compressed garbage.

### 2. Read the CORS result correctly

```python
def cors_verdict(p, origin=VIEWER_ORIGIN):
    if p["acao"] is None:
        return "blocked: no Access-Control-Allow-Origin"
    if p["acao"] not in ("*", origin):
        return f"blocked: header allows {p['acao']}, page is {origin}"
    if p["acao"] != "*" and (p["vary"] is None or "origin" not in p["vary"].lower()):
        return "fragile: origin echoed without Vary: Origin — a CDN can serve it to other origins"
    return "ok"

p = probe("https://tiles.example.org/city/content/14/8812/5631.glb")
print(cors_verdict(p))
```

Probe from outside the network the tile server sits in, and ideally from more than one region. A CDN answers from the edge nearest the client, and each edge keeps its own cache, so a probe from the build server in one region can report a clean response while users on another continent receive a stale, broken one. Running the same probe through two or three regions — a CI runner, a small cloud function elsewhere, a colleague's laptop — is the cheapest way to see whether a failure is global or tied to particular edges.

The third case is the intermittent one. When a server echoes the requesting origin back in `Access-Control-Allow-Origin` but does not send `Vary: Origin`, a CDN caches the first response and serves it to everyone. The first viewer to request a tile after a purge decides which origin every other viewer is allowed to be; staging works on Monday and production fails, then the reverse after the next deploy.

<figure class="diagram">
<svg viewBox="6 16 748 250" role="img" aria-labelledby="cors-vary-t cors-vary-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cors-vary-t">How a missing Vary header poisons a CDN cache</title>
  <desc id="cors-vary-d">A staging viewer requests a tile first. The origin server echoes its origin in Access-Control-Allow-Origin without Vary Origin, and the CDN caches that response. When the production viewer then requests the same tile, the CDN serves the cached response allowing only the staging origin, and the browser blocks it.</desc>
  <rect class="svg-bg" x="6" y="16" width="748" height="250" fill="#ffffff"/>
  <defs>
    <marker id="cors-vary-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="150" height="50" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="20" y="170" width="150" height="50" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="300" y="100" width="160" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="590" y="100" width="150" height="50" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#cors-vary-arrow)">
    <path d="M170 55 L298 110"/>
    <path d="M460 118 H588"/>
    <path d="M298 140 L172 195"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="95" y="52">staging viewer</text>
    <text x="95" y="69">requests first</text>
    <text x="95" y="192">production viewer</text>
    <text x="95" y="209">blocked</text>
    <text x="380" y="122">CDN caches</text>
    <text x="380" y="139">one response</text>
    <text x="665" y="122">origin echoes</text>
    <text x="665" y="139">no Vary: Origin</text>
  </g>
  <text x="525" y="104" fill="#5b6471" font-size="11.5" text-anchor="middle">miss</text>
  <text x="250" y="190" fill="#b0413e" font-size="12" text-anchor="start">ACAO: https://staging…</text>
  <text x="380" y="248" fill="#15384a" font-size="12.5" text-anchor="middle">Either send Access-Control-Allow-Origin: * for public tiles, or always send Vary: Origin.</text>
</svg>
<figcaption>The cache key does not include the Origin header unless the response says it should, so one origin's permission is replayed to all.</figcaption>
</figure>

### 3. Check the preflight when the viewer sends custom headers

A plain `GET` needs no preflight. Adding an `Authorization` header — for token-protected tilesets — makes every request "non-simple", and the browser first sends an `OPTIONS` request that the server must answer.

```python
def preflight(url, origin=VIEWER_ORIGIN, request_headers="authorization"):
    r = requests.options(url, headers={
        "Origin": origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": request_headers,
    }, timeout=20)
    allowed = (r.headers.get("Access-Control-Allow-Headers") or "").lower()
    return {
        "status": r.status_code,
        "allow_origin": r.headers.get("Access-Control-Allow-Origin"),
        "allow_methods": r.headers.get("Access-Control-Allow-Methods"),
        "allow_headers_ok": all(h.strip() in allowed or allowed == "*" for h in request_headers.split(",")),
        "max_age": r.headers.get("Access-Control-Max-Age"),
    }

print(preflight("https://tiles.example.org/city/content/14/8812/5631.glb"))
```

Object storage rejects `OPTIONS` with `403` until a CORS rule allows the method and header, and the browser reports this as a CORS error on the `GET` that never happened. `Access-Control-Max-Age` deserves attention for tilesets: without it, some browsers repeat the preflight for every one of thousands of tile URLs, doubling request count. Setting it to an hour or more removes that overhead. Note also that `Access-Control-Allow-Headers: *` does not cover `Authorization` in current browsers, which must be named explicitly.

### 4. Fix the storage configuration

For S3 or an S3-compatible store, set CORS and object metadata at upload time rather than patching responses in the CDN.

```python
import boto3
from pathlib import Path

s3 = boto3.client("s3")
BUCKET = "twin-tiles-prod"

s3.put_bucket_cors(Bucket=BUCKET, CORSConfiguration={"CORSRules": [{
    "AllowedOrigins": ["https://twin.example.org", "https://staging.twin.example.org"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Authorization", "Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 86400,
}]})

TYPES = {".json": "application/json", ".glb": "model/gltf-binary", ".b3dm": "application/octet-stream",
         ".pnts": "application/octet-stream", ".subtree": "application/octet-stream"}

def upload(path, key, gzipped):
    extra = {"ContentType": TYPES.get(Path(path).suffix, "application/octet-stream"),
             "CacheControl": "public, max-age=31536000, immutable"}
    if gzipped:
        extra["ContentEncoding"] = "gzip"
    s3.upload_file(str(path), BUCKET, key, ExtraArgs=extra)
```

S3 answers CORS per request by matching the `Origin` against the rule and adds `Vary: Origin` itself, which makes it safe behind a CDN that honours `Vary`. Changing CORS rules or object metadata does not change what edges already cached. After fixing the origin, purge the tileset path on the CDN, or publish the corrected tiles under a new version prefix so that no cached response can match; the versioned approach also makes rollback trivial and is the one to prefer for production tilesets.

`ContentEncoding` must be set exactly when — and only when — the stored bytes are gzip; a pipeline that gzips some tiles and not others has to decide per file from the bytes, not from a naming convention.

<figure class="diagram">
<svg viewBox="6 6 748 250" role="img" aria-labelledby="cors-enc-t cors-enc-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cors-enc-t">Stored bytes, header and what the loader receives</title>
  <desc id="cors-enc-d">Four rows. Plain glTF bytes with no encoding header arrive as glTF. Gzipped bytes with Content-Encoding gzip are decompressed by the browser and arrive as glTF. Gzipped bytes without the header arrive still compressed and fail with invalid magic. Gzipped bytes that the CDN compresses again, with a single gzip header, arrive compressed once and also fail.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="250" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="20" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="20" width="260" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="70" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="70" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="70" width="260" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="120" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="120" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="120" width="260" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="170" width="200" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="220" y="170" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="480" y="170" width="260" height="40" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="45">glTF bytes</text><text x="350" y="45">no Content-Encoding</text><text x="610" y="45">loader gets glTF</text>
    <text x="120" y="95">gzip bytes</text><text x="350" y="95">Content-Encoding: gzip</text><text x="610" y="95">browser inflates → glTF</text>
    <text x="120" y="145">gzip bytes</text><text x="350" y="145">no Content-Encoding</text><text x="610" y="145">1f 8b … invalid magic</text>
    <text x="120" y="195">gzip bytes</text><text x="350" y="195">CDN gzips again, one header</text><text x="610" y="195">still gzip after inflate</text>
  </g>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">The header must describe the bytes exactly once.</text>
</svg>
<figcaption>Only the first two rows work. The third and fourth produce the same symptom in the viewer, and the probe's wire and decoded magic bytes tell them apart.</figcaption>
</figure>

## Expected Output & Verification

A broken and a fixed probe of the same deep tile:

```text
before: {'status': 200, 'content-type': 'binary/octet-stream', 'content-encoding': None, 'acao': 'https://staging.twin.example.org',
         'vary': None, 'cache': 'HIT', 'wire_magic': 'gzip!', 'decoded_magic': 'gzip!'}
        blocked: header allows https://staging.twin.example.org, page is https://twin.example.org
after:  {'status': 200, 'content-type': 'model/gltf-binary', 'content-encoding': 'gzip', 'acao': 'https://twin.example.org',
         'vary': 'Origin, Accept-Encoding', 'cache': 'MISS', 'wire_magic': 'gzip!', 'decoded_magic': 'glb'}
        ok
```

Verify from both origins and after a CDN purge, since the poisoning case only appears on the second request. Probe the same URL with the staging origin, then the production origin, twice each; every response must carry the requesting origin or `*`. Then load the viewer with the network panel open and "Disable cache" off, pan until a few hundred tiles have loaded, and filter for failed requests — there should be none, and the preflight count should be a handful rather than one per tile.

<figure class="diagram">
<svg viewBox="26 26 631 182" role="img" aria-labelledby="cors-pre-t cors-pre-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cors-pre-t">Preflight requests with and without Max-Age</title>
  <desc id="cors-pre-d">For a view that loads 400 tiles with an Authorization header, a server without Access-Control-Max-Age causes up to 400 preflight OPTIONS requests in addition to 400 GET requests. With a Max-Age of one day, a handful of preflights cover all tiles from the same path pattern, and the request count is close to 400.</desc>
  <rect class="svg-bg" x="26" y="26" width="631" height="182" fill="#ffffff"/>
  <rect x="40" y="40" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="300" y="40" width="260" height="40" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <rect x="40" y="110" width="260" height="40" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="300" y="110" width="8" height="40" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="170" y="65">400 GET</text><text x="430" y="65">up to 400 OPTIONS</text>
    <text x="170" y="135">400 GET</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="572" y="65">no Max-Age</text>
    <text x="320" y="135">a few OPTIONS · Max-Age 86400</text>
  </g>
  <text x="360" y="190" fill="#15384a" font-size="12.5" text-anchor="middle">requests for one view of 400 authorised tiles</text>
</svg>
<figcaption>Preflight caching is a performance fix as much as a correctness one for token-protected tilesets.</figcaption>
</figure>

## Common Errors

**`Access to fetch at '…/tileset.json' from origin '…' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`.** No CORS rule matches, or the rule exists and the CDN serves a cached response from before it was added. Probe with a cache-busting query string to separate the two, then purge.

**`RangeError: Invalid typed array length` or `Invalid glTF magic`.** The loader received bytes that are not a tile — almost always gzip without a `Content-Encoding` header, occasionally an HTML error page returned with status 200 by a single-page-app fallback. The probe's `decoded_magic` shows which.

**Tiles load on desktop and fail on some mobile networks.** A carrier or corporate proxy recompressed a response it believed was text, because the MIME type was `binary/octet-stream` or missing. Serve explicit binary types and `Cache-Control: no-transform` for tile content.

## Frequently Asked Questions

### Is Access-Control-Allow-Origin: * safe for tiles?

For public tilesets, yes — it is the simplest correct configuration and CDN-friendly. It cannot be combined with credentialed requests using cookies; token-in-header authentication works with it only if the server does not also send `Access-Control-Allow-Credentials: true`.

### Should I pre-compress tiles or let the CDN compress?

Pre-compress JSON and uncompressed binary content with Brotli or gzip at build time for predictable results and lower CDN cost, and set the header accordingly. Do not compress content that is already compressed internally with Draco, meshopt or KTX2 — the gain is small — unless measurements show otherwise.

### Do range requests matter for 3D Tiles?

Not for ordinary tile files, which are fetched whole. They matter for COPC and for large subtree or glTF files some loaders read partially; allow the `Range` header in CORS and expose `Content-Range`, as in step 4.

## Related Guides

- [Eliminating Tile Popping and Pop-In](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/eliminating-tile-popping-and-pop-in/) — the next problem once tiles load at all
- [Cache Invalidation for Versioned Tilesets](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/cache-invalidation-for-versioned-tilesets/) — cache headers that avoid needing purges
- [Fixing Tilesets That Never Refine Past the Root](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/fixing-tilesets-that-never-refine-past-the-root/) — when loading succeeds but detail never arrives

Back to [Streaming & Runtime Diagnostics for 3D Tiles](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/streaming-and-runtime-diagnostics/).
