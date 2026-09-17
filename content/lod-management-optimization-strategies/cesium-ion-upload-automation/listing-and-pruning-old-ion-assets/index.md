# Listing and Pruning Old ion Assets

This page inventories a Cesium ion account that has accumulated 640 assets over two years, classifies them against a retention policy, checks which are still referenced by a deployed viewer or a token, and deletes the rest — with a dry run, an audit log and a guard that makes deleting a live asset impossible rather than merely unlikely.

## Why you hit this

Every automated upload leaves an asset behind. A nightly tiling job that uploads a new city tileset produces 365 assets a year, of which one is current; a pipeline that retries on failure leaves half-tiled assets in `ERROR` state; a developer testing source options leaves a dozen `AWAITING_FILES` assets that were never completed. None of them are free — storage is billed — and all of them make the asset list unusable for the people who need to find the current one.

Deleting is irreversible and there is no recycle bin, so the whole problem is telling "superseded" from "current" reliably enough to automate. The answer is not to guess from names but to read what is actually referenced.

## Prerequisites

- An ion token with `assets:list`, `assets:read` and, for the deletion step only, `assets:write` — see [managing ion access tokens and scopes](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/managing-ion-access-tokens-and-scopes/).
- Python 3.10+ with `requests`.
- A way to enumerate what production references: the deployed viewer's configuration, or the asset ids baked into your public tokens.

## Step-by-Step

### 1. Pull the full inventory

```python
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests

API = "https://api.cesium.com/v1"
TOKEN = os.environ["ION_ADMIN_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

def list_assets(page_size=100):
    assets, page = [], 1
    while True:
        r = requests.get(f"{API}/assets", headers=HEADERS,
                         params={"page": page, "limit": page_size}, timeout=45)
        r.raise_for_status()
        batch = r.json().get("items", [])
        assets.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return assets

def normalise(assets):
    rows = []
    for a in assets:
        rows.append({
            "id": a["id"],
            "name": a.get("name", ""),
            "type": a.get("type"),
            "status": a.get("status"),
            "bytes": int(a.get("bytes") or 0),
            "date_added": a.get("dateAdded"),
            "description": (a.get("description") or "")[:120],
            "percent": a.get("percentComplete"),
        })
    return rows

inventory = normalise(list_assets())
print(f"{len(inventory)} assets, {sum(r['bytes'] for r in inventory) / 1e9:.1f} GB")
print(Counter(r["status"] for r in inventory))
print(Counter(r["type"] for r in inventory).most_common())
```

The status histogram is the first useful output. `COMPLETE` assets are the real inventory; `ERROR` and `DATA_ERROR` are failed tilings that occupy storage and can almost always go; `AWAITING_FILES` assets are stubs created by an upload that never sent data, which is what an interrupted script leaves behind.

Recording `bytes` at this stage is what turns the exercise from tidying into a number someone will act on — "410 GB in superseded assets" gets approval that "lots of old assets" does not.

<figure class="diagram">
<svg viewBox="26 10 688 222" role="img" aria-labelledby="prune-inv-t prune-inv-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prune-inv-t">Where the storage actually is</title>
  <desc id="prune-inv-d">A bar chart of gigabytes by asset status on a 640-asset account. Superseded complete assets hold 498 gigabytes. Current and rollback assets hold 660 gigabytes. Failed assets in error or data-error state hold 21 gigabytes. Incomplete stubs awaiting files hold 5 gigabytes. The superseded group is the only large recoverable block.</desc>
  <rect class="svg-bg" x="26" y="10" width="688" height="222" fill="#ffffff"/>
  <path d="M40 24 V172 H700" stroke="#5b6471" stroke-width="1.5" fill="none"/>
  <g stroke-width="1.5">
    <rect x="40" y="34" width="256" height="28" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="70" width="193" height="28" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="40" y="106" width="9" height="28" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="142" width="3" height="28" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="306" y="52">current + rollback, keep: 660 GB</text>
    <text x="243" y="88">superseded, recoverable: 498 GB</text>
    <text x="59" y="124">ERROR / DATA_ERROR: 21 GB (55 assets)</text>
    <text x="53" y="160">AWAITING_FILES stubs: 5 GB (24 assets)</text>
  </g>
  <text x="40" y="196" fill="#5b6471" font-size="12">640 assets, 1,185 GB total — the middle bar is what a retention policy reclaims</text>
  <text x="40" y="214" fill="#5b6471" font-size="12">the two small bars are pure waste: those assets were never usable</text>
</svg>
<figcaption>Failed uploads are the satisfying deletions; superseded builds are the ones that free real storage.</figcaption>
</figure>

### 2. Group into lineages

```python
STAMP = re.compile(r"(.*?)[\s_\-]*(\d{4}[-_]?\d{2}[-_]?\d{2}|v\d+)\s*$", re.I)

def lineage_key(name):
    """Strip a trailing date or version so 'City LOD2 2026-09-01' groups with its siblings."""
    m = STAMP.match(name.strip())
    base = (m.group(1) if m else name).strip(" _-")
    return base.lower() or "(unnamed)"

def group_lineages(rows):
    groups = defaultdict(list)
    for r in rows:
        groups[lineage_key(r["name"])].append(r)
    for key, members in groups.items():
        members.sort(key=lambda r: r["date_added"] or "", reverse=True)
    return dict(sorted(groups.items(), key=lambda kv: -sum(m["bytes"] for m in kv[1])))

lineages = group_lineages(inventory)
for key, members in list(lineages.items())[:5]:
    total = sum(m["bytes"] for m in members) / 1e9
    print(f"{key[:40]:<40} {len(members):>3} assets  {total:>6.1f} GB  "
          f"newest {(members[0]['date_added'] or '?')[:10]}")
```

Grouping by a name with the version stripped is a heuristic and is honest about it. It works because automated uploads name assets from a template — and where it fails, the failure is visible in the output, as a lineage of one whose siblings landed under a different key.

The value is that retention becomes a per-lineage decision — keep the newest two of each — rather than a per-asset one, which is both safer and easier to explain.

<figure class="diagram">
<svg viewBox="10 2 720 232" role="img" aria-labelledby="prune-lin-t prune-lin-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prune-lin-t">A lineage and the retention decision</title>
  <desc id="prune-lin-d">One lineage of nightly city tileset uploads shown as a row of assets from newest to oldest. The newest is referenced by the production viewer and is kept. The second newest is kept as the rollback target. Three older complete assets past the retention window are candidates for deletion. Two failed uploads in error state are deleted regardless of age. One asset older than the window is still referenced by a public token and is therefore kept and flagged for investigation.</desc>
  <rect class="svg-bg" x="10" y="2" width="720" height="232" fill="#ffffff"/>
  <g stroke-width="1.6">
    <rect x="24" y="48" width="92" height="66" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="128" y="48" width="92" height="66" rx="7" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="48" width="92" height="66" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="336" y="48" width="92" height="66" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="440" y="48" width="92" height="66" rx="7" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="544" y="48" width="80" height="66" rx="7" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="636" y="48" width="80" height="66" rx="7" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="70" y="70">09-16</text><text x="70" y="88">COMPLETE</text><text x="70" y="106">referenced</text>
    <text x="174" y="70">09-15</text><text x="174" y="88">COMPLETE</text><text x="174" y="106">rollback</text>
    <text x="278" y="70">09-08</text><text x="278" y="88">COMPLETE</text><text x="278" y="106">past window</text>
    <text x="382" y="70">08-30</text><text x="382" y="88">COMPLETE</text><text x="382" y="106">past window</text>
    <text x="486" y="70">08-22</text><text x="486" y="88">COMPLETE</text><text x="486" y="106">past window</text>
    <text x="584" y="70">08-19</text><text x="584" y="88">ERROR</text><text x="584" y="106">never usable</text>
    <text x="676" y="70">06-02</text><text x="676" y="88">COMPLETE</text><text x="676" y="106">in a token</text>
  </g>
  <g stroke-width="1.5">
    <rect x="24" y="138" width="196" height="30" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="232" y="138" width="300" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="544" y="138" width="80" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="636" y="138" width="80" height="30" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="122" y="158">keep: newest two</text>
    <text x="382" y="158">delete after dry-run review</text>
    <text x="584" y="158">delete</text>
    <text x="676" y="158">keep, flag</text>
  </g>
  <text x="370" y="30" fill="#1f2937" font-size="13" text-anchor="middle">lineage "city lod2 nightly" — 7 assets, 168 GB</text>
  <text x="370" y="194" fill="#5b6471" font-size="12" text-anchor="middle">retention: keep the newest 2 and anything referenced; delete COMPLETE assets older than 14 days</text>
  <text x="370" y="216" fill="#5b6471" font-size="12" text-anchor="middle">a referenced asset outside the window is never deleted — it means something still points at an old build</text>
</svg>
<figcaption>Retention decided per lineage, with "referenced" always overriding "old".</figcaption>
</figure>

### 3. Find out what is actually referenced

```python
def referenced_by_tokens():
    """Any asset id pinned into a token is in use by something."""
    ids, page = set(), 1
    while True:
        r = requests.get(f"{API}/tokens", headers=HEADERS,
                         params={"page": page, "limit": 100}, timeout=30)
        r.raise_for_status()
        batch = r.json().get("items", [])
        for t in batch:
            for aid in (t.get("assetIds") or []):
                ids.add(int(aid))
        if len(batch) < 100:
            break
        page += 1
    return ids

def referenced_by_code(roots=("src", "config", "deploy")):
    """Asset ids appearing in the repository: viewer config, IaC, docs."""
    pattern = re.compile(r"(?:assetId|asset_id|ionAssetId|fromAssetId)\D{0,12}(\d{3,9})")
    ids = set()
    for root in roots:
        for path in Path(root).rglob("*"):
            if not path.is_file() or path.suffix in {".png", ".jpg", ".glb", ".zip"}:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for m in pattern.finditer(text):
                ids.add(int(m.group(1)))
    return ids

def referenced_by_runtime(manifest_path="deploy/live_assets.json"):
    """The authoritative list, written by the deploy that made those assets live."""
    p = Path(manifest_path)
    if not p.exists():
        return set()
    return {int(v) for v in json.loads(p.read_text()).get("asset_ids", [])}

protected = referenced_by_tokens() | referenced_by_code() | referenced_by_runtime()
print(f"{len(protected)} asset ids are referenced somewhere")
```

Three sources, unioned, and none of them trusted alone. Tokens catch anything a viewer can read; the repository scan catches configuration and infrastructure code; the deploy manifest is the authoritative record if your deploy writes one, and writing one is the single change that makes this whole process safe.

The repository scan will produce false positives — an asset id in a changelog or a release note — and that is the right direction to be wrong in. A protected asset costs storage; a deleted live asset costs an outage.

### 4. Apply the policy, as a dry run

```python
POLICY = {
    "keep_newest_per_lineage": 2,
    "retain_complete_days": 14,
    "delete_statuses": {"ERROR", "DATA_ERROR"},
    "delete_incomplete_after_days": 3,        # AWAITING_FILES stubs
    "never_delete_types": {"TERRAIN"},        # terrain is slow and costly to rebuild
}

def decide(rows, protected, policy=POLICY, now=None):
    now = now or datetime.now(timezone.utc)
    groups = group_lineages(rows)
    decisions = []
    for key, members in groups.items():
        for rank, r in enumerate(members):
            added = (datetime.fromisoformat(r["date_added"].replace("Z", "+00:00"))
                     if r["date_added"] else now)
            age_days = (now - added).days
            if r["id"] in protected:
                action, reason = "keep", "referenced"
            elif r["type"] in policy["never_delete_types"]:
                action, reason = "keep", "protected type"
            elif r["status"] in policy["delete_statuses"]:
                action, reason = "delete", f"status {r['status']}"
            elif (r["status"] in {"AWAITING_FILES", "NOT_STARTED"}
                  and age_days >= policy["delete_incomplete_after_days"]):
                action, reason = "delete", f"incomplete for {age_days}d"
            elif rank < policy["keep_newest_per_lineage"]:
                action, reason = "keep", f"newest {rank + 1} in lineage"
            elif age_days >= policy["retain_complete_days"]:
                action, reason = "delete", f"superseded, {age_days}d old"
            else:
                action, reason = "keep", f"inside retention window ({age_days}d)"
            decisions.append({**r, "lineage": key, "rank": rank,
                              "age_days": age_days, "action": action, "reason": reason})
    return decisions

decisions = decide(inventory, protected)
to_delete = [d for d in decisions if d["action"] == "delete"]
print(f"{len(to_delete)} of {len(decisions)} assets would be deleted, "
      f"freeing {sum(d['bytes'] for d in to_delete) / 1e9:.1f} GB")
print(Counter(d["reason"].split(",")[0] for d in to_delete).most_common())
```

Every decision carries its reason, and that is what makes the dry run reviewable. A human scanning 240 delete decisions cannot verify each one, but they can verify that the reasons are the five expected categories and that no reason says something surprising.

Ordering the checks so `referenced` wins over everything else is the important detail. A referenced asset that is 400 days old and ranked eighth in its lineage must still be kept, and it should be reported — it means production is pinned to an old build, which is a separate problem worth knowing about.

### 5. Write the dry run out and require a review

```python
def write_plan(decisions, out="build/prune_plan.json"):
    dele = [d for d in decisions if d["action"] == "delete"]
    plan = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "policy": {k: (sorted(v) if isinstance(v, set) else v) for k, v in POLICY.items()},
        "counts": {"total": len(decisions), "delete": len(dele),
                   "keep": len(decisions) - len(dele)},
        "bytes_freed": sum(d["bytes"] for d in dele),
        "delete": [{"id": d["id"], "name": d["name"], "type": d["type"],
                    "status": d["status"], "gb": round(d["bytes"] / 1e9, 3),
                    "age_days": d["age_days"], "reason": d["reason"]} for d in dele],
        "kept_but_stale": [{"id": d["id"], "name": d["name"], "age_days": d["age_days"]}
                           for d in decisions
                           if d["action"] == "keep" and d["reason"] == "referenced"
                           and d["age_days"] > POLICY["retain_complete_days"] * 3],
    }
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(plan, indent=2, sort_keys=True))
    return {"path": out, **plan["counts"], "gb": round(plan["bytes_freed"] / 1e9, 1),
            "stale_references": len(plan["kept_but_stale"])}

print(write_plan(decisions))
```

Serialising the plan and executing it as a separate step, from the file, is what makes the process auditable and repeatable. The plan is a reviewable artefact: it goes in a pull request, someone reads the delete list, and the execution job takes only that file as input.

`kept_but_stale` deserves attention every run. A production token pinned to an asset from June, when the lineage has uploaded nightly since, means the deploy that was supposed to update the reference never did — and the pruning job is the only thing that would ever have noticed.

### 6. Execute, with guards

```python
def delete_asset(asset_id, dry_run=True):
    if dry_run:
        return {"id": asset_id, "deleted": False, "dry_run": True}
    r = requests.delete(f"{API}/assets/{asset_id}", headers=HEADERS, timeout=45)
    if r.status_code in (200, 204):
        return {"id": asset_id, "deleted": True}
    return {"id": asset_id, "deleted": False, "status": r.status_code,
            "body": r.text[:200]}

def execute(plan_path="build/prune_plan.json", dry_run=True,
            max_deletes=300, max_gb=800.0, audit_log="build/prune_audit.jsonl"):
    plan = json.loads(Path(plan_path).read_text())
    dele = plan["delete"]
    if len(dele) > max_deletes:
        raise RuntimeError(f"plan deletes {len(dele)} assets, above the {max_deletes} guard")
    gb = plan["bytes_freed"] / 1e9
    if gb > max_gb:
        raise RuntimeError(f"plan frees {gb:.1f} GB, above the {max_gb} GB guard")

    live = referenced_by_tokens() | referenced_by_code() | referenced_by_runtime()
    conflicts = [d for d in dele if d["id"] in live]
    if conflicts:
        raise RuntimeError(f"plan is stale: {len(conflicts)} asset(s) became referenced, "
                           f"first {conflicts[0]['id']}")

    results = []
    Path(audit_log).parent.mkdir(parents=True, exist_ok=True)
    with open(audit_log, "a", encoding="utf-8") as log:
        for d in dele:
            res = delete_asset(d["id"], dry_run=dry_run)
            log.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(),
                                  **d, **res}, sort_keys=True) + "\n")
            results.append(res)
    ok = sum(1 for r in results if r.get("deleted") or r.get("dry_run"))
    return {"attempted": len(results), "succeeded": ok,
            "failed": [r for r in results if not (r.get("deleted") or r.get("dry_run"))][:3]}

print(execute(dry_run=True))
```

Re-checking the referenced set at execution time, not just at planning time, is the guard that matters. A plan reviewed on Monday and executed on Wednesday can have become wrong, because a deploy in between pinned production to an asset the plan lists for deletion — and that is precisely the sequence that causes an outage.

The two numeric guards catch a different failure: a bug in the grouping or a change in the API's date format that makes every asset look ancient. A plan that wants to delete 600 assets should stop and ask rather than proceed.

<figure class="diagram">
<svg viewBox="1 12 657 226" role="img" aria-labelledby="prune-flow-t prune-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="prune-flow-t">Plan, review, re-check, delete</title>
  <desc id="prune-flow-d">The inventory and the referenced-asset set feed a policy step that writes a plan file. The plan is reviewed by a person. At execution time the referenced set is queried again and compared against the plan; a conflict aborts the run. Only then are the deletions issued, each one written to an append-only audit log.</desc>
  <rect class="svg-bg" x="1" y="12" width="657" height="226" fill="#ffffff"/>
  <defs>
    <marker id="prune-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="26" width="120" height="48" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="16" y="102" width="120" height="48" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="186" y="64" width="116" height="48" rx="7" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="352" y="64" width="110" height="48" rx="7" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="512" y="64" width="116" height="48" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="512" y="152" width="116" height="48" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#prune-flow-arrow)">
    <path d="M136 50 L184 72"/><path d="M136 126 L184 104"/>
    <path d="M302 88 H350"/><path d="M462 88 H510"/>
    <path d="M570 112 V150"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="76" y="46">640 assets</text><text x="76" y="64">from the API</text>
    <text x="76" y="122">referenced ids:</text><text x="76" y="140">tokens, code, deploy</text>
    <text x="244" y="84">policy →</text><text x="244" y="102">plan file</text>
    <text x="407" y="84">human</text><text x="407" y="102">review</text>
    <text x="570" y="84">re-check refs;</text><text x="570" y="102">conflict = abort</text>
    <text x="570" y="172">delete +</text><text x="570" y="190">audit log line</text>
  </g>
  <text x="370" y="220" fill="#5b6471" font-size="12" text-anchor="middle">the second reference check stops a plan reviewed on Monday from breaking Wednesday's deploy</text>
</svg>
<figcaption>The plan is an artefact, the review is a step, and the reference check happens twice.</figcaption>
</figure>

## Expected Output & Verification

```text
640 assets, 1184.6 GB
Counter({'COMPLETE': 561, 'ERROR': 48, 'AWAITING_FILES': 24, 'DATA_ERROR': 7})
[('3DTILES', 402), ('IMAGERY', 118), ('TERRAIN', 74), ('POINTCLOUD', 46)]
city lod2 nightly                         62 assets   168.4 GB  newest 2026-09-16
district scans                            31 assets    94.2 GB  newest 2026-09-11
orthophoto tiles                          24 assets    61.0 GB  newest 2026-08-30
41 asset ids are referenced somewhere
248 of 640 assets would be deleted, freeing 512.3 GB
[('superseded', 169), ('status ERROR', 48), ('incomplete for 91d', 24), ('status DATA_ERROR', 7)]
{'path': 'build/prune_plan.json', 'total': 640, 'delete': 248, 'keep': 392,
 'gb': 512.3, 'stale_references': 2}
{'attempted': 248, 'succeeded': 248, 'failed': []}
```

512 GB from 248 assets, of which 79 were failures and stubs that could never have been used. The two stale references are the finding worth following up: something in production is pinned to an asset three retention windows old.

Verify the plan does not touch anything reachable, by resolving each protected asset through the API as a client would:

```python
def protection_check(plan_path="build/prune_plan.json"):
    plan = json.loads(Path(plan_path).read_text())
    planned = {d["id"] for d in plan["delete"]}
    live = referenced_by_tokens() | referenced_by_code() | referenced_by_runtime()
    overlap = sorted(planned & live)
    reachable = []
    for aid in sorted(live)[:40]:
        r = requests.get(f"{API}/assets/{aid}", headers=HEADERS, timeout=20)
        reachable.append({"id": aid, "status": r.status_code,
                          "state": r.json().get("status") if r.status_code == 200 else None})
    broken = [x for x in reachable if x["status"] != 200 or x["state"] != "COMPLETE"]
    return {"planned_deletes": len(planned), "referenced": len(live),
            "overlap": overlap, "safe": not overlap,
            "already_broken_references": broken[:5]}

print(json.dumps(protection_check(), indent=2))
```

An empty `overlap` is the safety property. `already_broken_references` is a bonus finding that this check produces for free — a referenced asset that returns 404 means a previous manual deletion already broke something, and nobody noticed.

Then verify after execution that the account matches the plan and nothing else changed:

```python
def post_delete_check(plan_path="build/prune_plan.json"):
    plan = json.loads(Path(plan_path).read_text())
    planned = {d["id"] for d in plan["delete"]}
    now = {a["id"] for a in list_assets()}
    return {"still_present_but_planned": sorted(planned & now)[:5],
            "removed": len(planned - now),
            "expected_removed": len(planned),
            "clean": planned.isdisjoint(now)}

print(post_delete_check())
```

A planned asset still present after a non-dry run usually returned 409 because a tiling job was in progress on it; re-running the execution the next day clears those.

## Performance Notes

- **Listing 640 assets is seven paginated requests**, a couple of seconds. Cache the inventory for the run; do not re-list per lineage.
- **Deletion is one request per asset** at roughly 300–800 ms. 248 deletions is a few minutes serially, which is fine for a weekly job and avoids any rate-limit complications.
- **The repository scan is the slow local step** on a large monorepo. Limit the roots and skip binary extensions, as above.
- **Storage billing is the metric to watch**, not asset count. Keeping 60 small assets costs less than keeping two large ones.
- **Run weekly, not nightly.** A nightly prune competing with a nightly upload produces confusing 409s.

## Common Errors

**`409 Conflict` deleting an asset.** A tiling job is running on it. Skip and retry on the next run.

**`403 Forbidden` deleting.** The token lacks `assets:write`. Deliberately separate this from the listing token so the audit job cannot delete.

**Every asset looks ancient and the plan wants to delete all of them.** `dateAdded` was missing or in an unexpected format and the code defaulted to the current time. The `max_deletes` guard is what catches this.

**A live viewer breaks after pruning.** The asset was referenced only from a place the scan did not cover — a CMS field, a colleague's bookmark, a partner's embed. Add a deploy manifest so the reference set is authoritative rather than inferred.

**Terrain asset deleted by accident.** Terrain rebuilds are slow and expensive; keep them in `never_delete_types` and prune them by hand.

**`ERROR` assets reappear every week.** The pipeline is failing and retrying. Pruning is treating the symptom; look at the upload job.

## Frequently Asked Questions

### Can a deleted asset be recovered?

No. There is no undelete, which is why the plan is reviewed and the reference check runs twice. Where an asset would be expensive to rebuild, exclude its type from automated deletion.

### How many versions should a lineage keep?

Two is enough when rollback is a redeploy with a different asset id: the current one and the one before it. Keep more when the upstream data is not reproducible, because then the asset is the only copy.

### Should the pruning job also archive?

If the source data is reproducible, no — re-tiling is cheaper than storing. If it is not, the asset is a primary record and belongs in object storage, not only in ion.

## Related Guides

- [Managing ion Access Tokens and Scopes](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/managing-ion-access-tokens-and-scopes/) — the token that pins an asset as referenced
- [Choosing ion Source Types and Options](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/choosing-ion-source-types-and-options/) — what the uploads that fill the account are doing
- [Versioning Tilesets with Immutable Prefixes](https://www.3d-geospatial.com/lod-management-optimization-strategies/streaming-sync-patterns/versioning-tilesets-with-immutable-prefixes/) — the self-hosted equivalent of a lineage

Back to [Cesium ion Upload Automation](https://www.3d-geospatial.com/lod-management-optimization-strategies/cesium-ion-upload-automation/).
