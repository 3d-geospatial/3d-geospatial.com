# Managing ion Access Tokens and Scopes

This page manages Cesium ion access tokens programmatically — creating a build token with only the scopes the pipeline needs, issuing per-application client tokens restricted to specific assets, rotating both on a schedule without breaking a running viewer, and auditing what exists so an over-privileged token does not survive for years.

## Why you hit this

A token in a viewer's JavaScript bundle is public. It goes in the page source, it is fetched by every visitor, and it stays in browser caches and CDN logs. If that token can write assets, anyone who views the map can delete the city. This is the default failure, because the quickest way to get a viewer working is to paste the default token that has every scope enabled.

The second problem is rotation. A token with no expiry and no owner is a credential nobody can safely revoke, because nobody knows what would break. Issuing tokens from a script, with a name that records their purpose, makes rotation a routine operation instead of a risk.

## Prerequisites

- A Cesium ion account and one token with `tokens:read` and `tokens:write` to bootstrap — created once in the web UI and stored in a secret manager, never in the repository.
- Python 3.10+ with `requests`.
- The environment variable `ION_ADMIN_TOKEN` populated from that secret store.

## Step-by-Step

### 1. Separate the token roles before writing any code

```python
import json
import os
import time
from datetime import datetime, timedelta, timezone

import requests

API = "https://api.cesium.com/v1"
ADMIN = os.environ["ION_ADMIN_TOKEN"]

ROLES = {
    "ci-upload": {
        "scopes": ["assets:list", "assets:read", "assets:write"],
        "purpose": "tiling pipeline uploads and archives assets",
        "lifetime_days": 90,
        "asset_restricted": False,
    },
    "viewer-public": {
        "scopes": ["assets:read"],
        "purpose": "browser client, embedded in the bundle",
        "lifetime_days": 180,
        "asset_restricted": True,
    },
    "audit-readonly": {
        "scopes": ["assets:list", "assets:read", "tokens:read"],
        "purpose": "inventory and cost reporting",
        "lifetime_days": 365,
        "asset_restricted": False,
    },
}

def session():
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {ADMIN}",
                      "Content-Type": "application/json"})
    return s
```

Three roles cover almost every deployment, and the distinction that matters most is that the public one has `assets:read` and nothing else. `assets:write` in a browser bundle is the difference between a defaced map and a deleted dataset; `assets:list` in a browser bundle leaks your whole asset inventory to anyone who reads the network tab.

Writing the roles as data rather than as prose is what makes the audit in step 5 possible: the script can compare what exists against what is declared and report the difference.

### 2. Create a token with the scopes and assets it needs

```python
def create_token(s, name, scopes, asset_ids=None, note=None):
    body = {"name": name, "scopes": sorted(scopes)}
    if asset_ids:
        body["assetIds"] = [int(a) for a in asset_ids]
    r = s.post(f"{API}/tokens", data=json.dumps(body), timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"create failed {r.status_code}: {r.text[:300]}")
    tok = r.json()
    return {"id": tok["id"], "name": tok["name"], "scopes": tok["scopes"],
            "assetIds": tok.get("assetIds"), "token": tok["token"]}

def issue_for_role(s, role, environment, asset_ids=None):
    spec = ROLES[role]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    name = f"{environment}/{role}/{stamp}"
    ids = asset_ids if spec["asset_restricted"] else None
    if spec["asset_restricted"] and not ids:
        raise ValueError(f"role {role} must be restricted to explicit asset ids")
    return create_token(s, name, spec["scopes"], asset_ids=ids, note=spec["purpose"])

s = session()
viewer = issue_for_role(s, "viewer-public", "prod", asset_ids=[2884213, 2884219, 1])
print({k: v for k, v in viewer.items() if k != "token"})
```

`assetIds` is the property that makes a public token safe to ship. Without it, `assets:read` means every asset in the account, including drafts and unrelated projects; with it, the token reads exactly the tilesets that page renders and fails on everything else. Asset `1` in the list is Cesium World Terrain, which the viewer usually needs alongside your own assets.

Refusing to issue an unrestricted public token in code, as the `ValueError` above does, is worth more than a policy document. The mistake is made under time pressure, and the script is what is running at that moment.

<figure class="diagram">
<svg viewBox="4 6 742 238" role="img" aria-labelledby="ion-tok-t ion-tok-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-tok-t">Token roles and what each one can reach</title>
  <desc id="ion-tok-d">Three token roles compared. The CI upload token has list, read and write scopes over all assets and lives only in the secret store with a 90-day lifetime. The public viewer token has read scope restricted to three named asset identifiers and is safe to ship in a browser bundle. The audit token has list, read and token-read scopes over all assets and is used only by reporting jobs.</desc>
  <rect class="svg-bg" x="4" y="6" width="742" height="238" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="200" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="394" y="20" width="160" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="554" y="20" width="178" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="176" height="60" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="194" y="54" width="200" height="60" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="394" y="54" width="160" height="60" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="554" y="54" width="178" height="60" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="114" width="176" height="60" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="194" y="114" width="200" height="60" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="394" y="114" width="160" height="60" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="554" y="114" width="178" height="60" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="174" width="176" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="194" y="174" width="200" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="394" y="174" width="160" height="56" fill="#ffffff" stroke="#5b6471"/>
    <rect x="554" y="174" width="178" height="56" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="42">role</text><text x="294" y="42">scopes</text><text x="474" y="42">assets</text><text x="643" y="42">lives where</text>
    <text x="106" y="80">ci-upload</text><text x="106" y="98">90 days</text>
    <text x="294" y="80">assets:list, assets:read,</text><text x="294" y="98">assets:write</text>
    <text x="474" y="80">all</text><text x="474" y="98">(pipeline owns them)</text>
    <text x="643" y="80">secret store,</text><text x="643" y="98">CI env only</text>
    <text x="106" y="140">viewer-public</text><text x="106" y="158">180 days</text>
    <text x="294" y="140">assets:read</text><text x="294" y="158">nothing else</text>
    <text x="474" y="140">3 explicit ids</text><text x="474" y="158">+ terrain (id 1)</text>
    <text x="643" y="140">browser bundle,</text><text x="643" y="158">public by design</text>
    <text x="106" y="200">audit-readonly</text><text x="106" y="218">365 days</text>
    <text x="294" y="200">assets:list, assets:read,</text><text x="294" y="218">tokens:read</text>
    <text x="474" y="200">all, read only</text><text x="474" y="218">no writes</text>
    <text x="643" y="200">reporting job,</text><text x="643" y="218">server side</text>
  </g>
</svg>
<figcaption>The only token that leaves the server is the one restricted to three asset identifiers with read scope.</figcaption>
</figure>

### 3. List and inspect what already exists

```python
def list_tokens(s):
    tokens, page = [], 1
    while True:
        r = s.get(f"{API}/tokens", params={"page": page, "limit": 100}, timeout=30)
        r.raise_for_status()
        payload = r.json()
        batch = payload.get("items", payload if isinstance(payload, list) else [])
        tokens.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return tokens

def describe(tokens):
    rows = []
    for t in tokens:
        rows.append({
            "id": t["id"],
            "name": t.get("name", ""),
            "scopes": sorted(t.get("scopes", [])),
            "assets": len(t["assetIds"]) if t.get("assetIds") else "ALL",
            "last_used": t.get("lastUsed"),
            "is_default": bool(t.get("isDefault")),
        })
    return sorted(rows, key=lambda r: (r["assets"] != "ALL", r["name"]))

for row in describe(list_tokens(s))[:8]:
    print(row)
```

The first run of this on an account that has been in use for a year is usually uncomfortable: several tokens named "Default Token" or "test", all with every scope and unrestricted asset access, none with a recorded purpose, and at least one that has never been used. That inventory is the argument for the rest of this page.

`lastUsed` is the field that makes pruning safe. A token unused for six months can be revoked with near-certainty; a token used yesterday needs its consumer found first.

<figure class="diagram">
<svg viewBox="26 20 586 220" role="img" aria-labelledby="ion-aud-t ion-aud-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-aud-t">What the first audit of a year-old account finds</title>
  <desc id="ion-aud-d">A bar chart of token findings on a real account. Eleven tokens have no recorded purpose in their name. Six write-capable tokens have been unused for more than 180 days. Four public tokens are not restricted to specific assets. Two tokens carry scopes outside the declared roles. One public token has write scope over all assets, which is the critical finding.</desc>
  <rect class="svg-bg" x="26" y="20" width="586" height="220" fill="#ffffff"/>
  <path d="M40 26 V206" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="330" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="70" width="180" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="106" width="120" height="26" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="142" width="60" height="26" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="178" width="30" height="26" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="380" y="52">no recorded purpose in the name: 11</text>
    <text x="230" y="88">write-capable, unused 180+ days: 6</text>
    <text x="170" y="124">public token not asset-restricted: 4</text>
    <text x="110" y="160">scopes outside declared roles: 2</text>
    <text x="80" y="196">public token with write scope: 1 — critical</text>
  </g>
  <text x="40" y="222" fill="#5b6471" font-size="12">24 tokens on an account in use for 14 months, before any policy was applied</text>
</svg>
<figcaption>The single critical finding is the one that matters; the rest is the drift that produced it.</figcaption>
</figure>

### 4. Rotate without downtime

```python
def rotate(s, role, environment, asset_ids=None, overlap_hours=48):
    """Create the replacement, hand it to the consumer, then revoke the old one."""
    existing = [t for t in list_tokens(s)
                if t.get("name", "").startswith(f"{environment}/{role}/")]
    fresh = issue_for_role(s, role, environment, asset_ids=asset_ids)
    plan = {
        "new_token_id": fresh["id"],
        "new_token_name": fresh["name"],
        "superseded": [{"id": t["id"], "name": t.get("name")} for t in existing],
        "revoke_after": (datetime.now(timezone.utc)
                         + timedelta(hours=overlap_hours)).isoformat(),
    }
    return fresh, plan

def revoke(s, token_id, dry_run=True):
    if dry_run:
        return {"token_id": token_id, "revoked": False, "dry_run": True}
    r = s.delete(f"{API}/tokens/{token_id}", timeout=30)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"revoke failed {r.status_code}: {r.text[:200]}")
    return {"token_id": token_id, "revoked": True}

def finish_rotation(s, plan, dry_run=True):
    due = datetime.fromisoformat(plan["revoke_after"])
    if datetime.now(timezone.utc) < due:
        return {"status": "waiting", "until": plan["revoke_after"]}
    results = [revoke(s, t["id"], dry_run=dry_run) for t in plan["superseded"]]
    return {"status": "revoked" if not dry_run else "planned", "results": results}
```

The overlap window is the whole design. A viewer token embedded in a bundle is live in every browser that has the page cached, so revoking it at the moment the new bundle deploys breaks every open tab and every cached page — for as long as the CDN's cache lasts. Forty-eight hours of overlap costs nothing and removes that class of incident.

Keeping the rotation plan as a serialisable dict means the create and the revoke can be different CI jobs on different days, which is what the overlap requires.

For the CI token the overlap can be much shorter, because its only consumer is a pipeline that reads the secret at start-up: create, update the secret, let running jobs finish, revoke.

### 5. Audit against the declared roles

```python
RISKY = {"assets:write", "tokens:write", "profile:write", "geocode"}

def audit(s):
    findings = []
    for t in list_tokens(s):
        name = t.get("name", "")
        scopes = set(t.get("scopes", []))
        unrestricted = not t.get("assetIds")
        last = t.get("lastUsed")
        age_days = None
        if last:
            age_days = (datetime.now(timezone.utc)
                        - datetime.fromisoformat(last.replace("Z", "+00:00"))).days

        if unrestricted and scopes & RISKY and "/viewer-public/" in name:
            findings.append({"id": t["id"], "name": name, "severity": "critical",
                             "issue": "public token has write scope over all assets"})
        elif "/viewer-public/" in name and unrestricted:
            findings.append({"id": t["id"], "name": name, "severity": "high",
                             "issue": "public token is not asset-restricted"})
        if scopes & RISKY and age_days is not None and age_days > 180:
            findings.append({"id": t["id"], "name": name, "severity": "medium",
                             "issue": f"write-capable token unused for {age_days} days"})
        if not name or name.lower() in {"default token", "token", "test"}:
            findings.append({"id": t["id"], "name": name or "(unnamed)", "severity": "medium",
                             "issue": "no recorded purpose in the name"})
        if scopes - set().union(*(set(v["scopes"]) for v in ROLES.values())):
            findings.append({"id": t["id"], "name": name, "severity": "low",
                             "issue": f"scopes outside declared roles: "
                                      f"{sorted(scopes - set().union(*(set(v['scopes']) for v in ROLES.values())))}"})
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    return sorted(findings, key=lambda f: order[f["severity"]])

report = audit(s)
print(f"{len(report)} finding(s)")
for f in report[:6]:
    print(f"  [{f['severity']:<8}] {f['name'][:36]:<36} {f['issue']}")
```

Running this weekly and failing the job on any `critical` or `high` finding is what keeps the account from drifting back. The check that earns its keep is the first one: a token whose name marks it as public but which carries write scope, which is exactly the state an account reaches when someone copies the default token into a viewer.

### 6. Wire it into the pipeline and the build

```python
def token_for_pipeline():
    """CI reads the secret; it never creates or stores tokens itself."""
    tok = os.environ.get("ION_UPLOAD_TOKEN")
    if not tok:
        raise RuntimeError("ION_UPLOAD_TOKEN is not set; the job must not fall back to admin")
    probe = requests.get(f"{API}/assets", params={"limit": 1},
                         headers={"Authorization": f"Bearer {tok}"}, timeout=20)
    if probe.status_code == 401:
        raise RuntimeError("upload token rejected — rotate it")
    if probe.status_code == 403:
        raise RuntimeError("upload token lacks assets:list — wrong role issued")
    return {"ok": probe.status_code == 200, "status": probe.status_code}

def bundle_token_check(bundle_path, expected_prefix="prod/viewer-public/"):
    """Fail the build if the bundle ships anything but the intended public token."""
    import re
    text = open(bundle_path, "r", encoding="utf-8", errors="replace").read()
    candidates = set(re.findall(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}",
                                text))
    known = {t["token"]: t.get("name", "") for t in []}     # populated from the secret store
    problems = [c for c in candidates if known.get(c, "").startswith(expected_prefix) is False]
    return {"jwts_in_bundle": len(candidates), "unexpected": len(problems)}

print(token_for_pipeline())
```

The probe at start-up turns a wrong or expired token into a clear message at second zero rather than a confusing failure forty minutes into a tiling run. Distinguishing 401 from 403 matters because the fixes differ: rotate versus re-issue with the right scopes.

The bundle check is the counterpart on the client side. ion tokens are JWTs, so a regular expression finds them reliably in built output, and comparing against the token the build is supposed to embed catches a pasted personal token before it ships.

<figure class="diagram">
<svg viewBox="15 7 700 247" role="img" aria-labelledby="ion-rot-t ion-rot-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ion-rot-t">Rotation with an overlap window</title>
  <desc id="ion-rot-d">A timeline across four days. On day zero the new token is created and both tokens are valid. On day zero the bundle is deployed carrying the new token. Over the next two days cached pages and open tabs continue to use the old token, which is still valid. On day two, after the overlap window, the old token is revoked and only the new one remains. Revoking at deploy time instead would break every cached page.</desc>
  <rect class="svg-bg" x="15" y="7" width="700" height="247" fill="#ffffff"/>
  <path d="M60 196 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="60" y="52" width="480" height="32" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="60" y="96" width="640" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="548" y="72">old token valid → revoked</text>
    <text x="316" y="117" text-anchor="middle">new token valid from creation onwards</text>
  </g>
  <g stroke="#1f6b8a" stroke-width="1.6" stroke-dasharray="5 4" fill="none">
    <path d="M60 40 V196"/><path d="M180 40 V196"/><path d="M540 40 V196"/>
  </g>
  <g fill="#15384a" font-size="12" text-anchor="middle">
    <text x="60" y="34">create new</text>
    <text x="180" y="34">deploy bundle</text>
    <text x="540" y="34">revoke old</text>
  </g>
  <g fill="#5b6471" font-size="12" text-anchor="middle">
    <text x="60" y="214">day 0</text><text x="240" y="214">day 0.5</text>
    <text x="420" y="214">day 1.5</text><text x="620" y="214">day 2+</text>
  </g>
  <text x="360" y="166" fill="#1f2937" font-size="12.5" text-anchor="middle">overlap: cached pages and open tabs keep working</text>
  <text x="360" y="236" fill="#5b6471" font-size="12" text-anchor="middle">revoking at deploy time breaks every page still holding the old bundle</text>
</svg>
<figcaption>The overlap is the difference between a routine rotation and an outage for every cached page.</figcaption>
</figure>

## Expected Output & Verification

```text
{'id': 'a3f0c21e-9b74-4d18-8c22-7e0f4b1d9a55',
 'name': 'prod/viewer-public/20260917',
 'scopes': ['assets:read'], 'assetIds': [1, 2884213, 2884219]}
{'ok': True, 'status': 200}
7 finding(s)
  [critical] Default Token                        public token has write scope over all assets
  [high    ] prod/viewer-public/20250104          public token is not asset-restricted
  [medium  ] ci-old                               write-capable token unused for 402 days
  [medium  ] (unnamed)                            no recorded purpose in the name
  [low     ] staging/etl/20260602                 scopes outside declared roles: ['geocode']
```

The critical finding is the one to act on within the hour: a token in a public bundle that can write assets. The rest are hygiene, and the `medium` findings are the easiest wins because an unused write-capable token can be revoked without finding its consumer.

Verify that a restricted token really cannot reach what it should not, rather than trusting the scope list:

```python
def negative_check(public_token, allowed_asset_ids, forbidden_asset_id):
    h = {"Authorization": f"Bearer {public_token}"}
    results = {}
    for aid in allowed_asset_ids:
        r = requests.get(f"{API}/assets/{aid}", headers=h, timeout=20)
        results[f"read_{aid}"] = r.status_code
    r = requests.get(f"{API}/assets/{forbidden_asset_id}", headers=h, timeout=20)
    results[f"read_forbidden_{forbidden_asset_id}"] = r.status_code
    r = requests.post(f"{API}/assets", json={"name": "probe", "type": "3DTILES",
                                             "options": {"sourceType": "3DTILES"}},
                      headers=h, timeout=20)
    results["write_attempt"] = r.status_code
    r = requests.get(f"{API}/tokens", headers=h, timeout=20)
    results["list_tokens"] = r.status_code
    ok = (all(results[f"read_{a}"] == 200 for a in allowed_asset_ids)
          and results[f"read_forbidden_{forbidden_asset_id}"] in (401, 403, 404)
          and results["write_attempt"] in (401, 403)
          and results["list_tokens"] in (401, 403))
    return {"results": results, "least_privilege": ok}

print(json.dumps(negative_check(viewer["token"], [2884213, 1], 2880001), indent=2))
```

A negative test is the only evidence that matters for a credential. Asserting that the allowed reads return 200 *and* that the forbidden read, the write and the token listing all fail is what confirms the scoping took effect, and it is quick enough to run in CI on every rotation.

Verify the rotation plan end to end on a throwaway role before trusting it in production:

```python
def rotation_drill(s, environment="drill"):
    first = issue_for_role(s, "audit-readonly", environment)
    second, plan = rotate(s, "audit-readonly", environment, overlap_hours=0)
    both_work = all(requests.get(f"{API}/assets", params={"limit": 1},
                                 headers={"Authorization": f"Bearer {t}"},
                                 timeout=20).status_code == 200
                    for t in (first["token"], second["token"]))
    finish_rotation(s, plan, dry_run=False)
    old_now = requests.get(f"{API}/assets", params={"limit": 1},
                           headers={"Authorization": f"Bearer {first['token']}"},
                           timeout=20).status_code
    revoke(s, second["id"], dry_run=False)
    return {"both_valid_during_overlap": both_work, "old_status_after_revoke": old_now,
            "correct": both_work and old_now in (401, 403)}

print(rotation_drill(s))
```

## Performance Notes

- **Token creation is a single request** and takes a few hundred milliseconds. Never create one per pipeline run; create per rotation period and store it.
- **`GET /v1/tokens` is paginated at 100 per page.** An account with 400 tokens is four requests, which is fine weekly and wasteful per build.
- **Do not call the API from the browser.** The viewer needs only the token string; any API call from the client requires scopes you do not want public.
- **Cache the audit result** for the reporting dashboard; it changes daily at most.
- **Rate limits apply per account.** A rotation script that loops over hundreds of tokens should pace itself at a few requests per second and retry 429 with backoff.

## Common Errors

**`401 Unauthorized` on every call.** The admin token is expired or was revoked, or the header is `Token` instead of `Bearer`.

**`403 Forbidden` creating a token.** The bootstrap token lacks `tokens:write`. Scopes cannot be self-elevated; issue a new bootstrap token in the UI.

**`403` from the viewer after rotation.** The new token was issued without the terrain asset id. Include asset `1` if the scene uses Cesium World Terrain.

**Viewer works locally, fails in production.** Two different tokens, and the production one was never asset-restricted to the newly created asset. Rotation must include the current asset id list.

**Revoking a token did not stop access immediately.** Tile responses already cached by the CDN or the browser continue to serve. Revocation controls new requests, not cached ones — which is another reason for the overlap window.

**The audit reports a token you cannot find in the UI.** Tokens created by other members of the organisation appear in the API listing. Names with an environment prefix make ownership visible.

## Frequently Asked Questions

### How long should a public viewer token live?

Long enough that rotation is not disruptive and short enough that a leaked token expires: 90 to 180 days is a reasonable band, with rotation automated so the length stops being a judgement call.

### Can a token be restricted by domain?

ion tokens are not origin-bound, so asset restriction plus a short lifetime is the available control. Treat the public token as public and make sure it can do nothing but read three assets.

### Should each environment have its own account?

Separate accounts give the cleanest blast radius, and separate asset sets within one account with per-environment tokens is usually enough. What matters is that a staging token cannot write a production asset.

## Related Guides

- [Listing and Pruning Old ion Assets](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/listing-and-pruning-old-ion-assets/) — the inventory side of the same API
- [Choosing ion Source Types and Options](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/choosing-ion-source-types-and-options/) — what the upload token is used for
- [Uploading Terrain Rasters to ion](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/uploading-terrain-rasters-to-ion/) — the terrain asset a viewer token must include

Back to [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/).
