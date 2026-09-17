# Resuming Failed Tiling Runs from Checkpoints

This page makes a long tiling run restartable — an append-only manifest of completed shards, atomic commits so a killed worker never leaves a half-written tile, a resume path that recomputes only what is outstanding, and a reconciliation pass that proves the resumed run is complete, for a 6,000-shard city job that takes nine hours.

## Why you hit this

A nine-hour job will be interrupted. A spot instance is reclaimed, the object store returns 503 for a minute, one shard hits a geometry bug and the process exits, or someone needs the machine. Without a checkpoint, the only recovery is to start again, which turns a 30-minute setback into another nine hours and makes people reluctant to run the pipeline at all.

The requirement is stronger than "skip files that exist". A shard whose tile was written but whose `tileset.json` entry was not is worse than a missing shard, because the resume will skip it and the tileset will reference nothing. The design below makes completion a single atomic fact per shard.

## Prerequisites

- The sharded tiling run from [orchestrating tiling jobs with Dask](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/orchestrating-tiling-jobs-with-dask/), or any pipeline with one unit of work per shard.
- Deterministic output, per [making tile output deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) — a resume that produces different bytes for an already-built shard defeats the purpose.
- Python 3.10+; a filesystem or object store where a rename is atomic within a prefix.

## Step-by-Step

### 1. Make one shard's completion a single atomic event

```python
import hashlib
import json
import os
import shutil
import tempfile
import time
from dataclasses import dataclass, asdict
from pathlib import Path

@dataclass(frozen=True)
class ShardRecord:
    shard: str
    provenance_hash: str
    content_hash: str
    tiles: int
    bytes_out: int
    seconds: float
    finished_at: float

def commit_shard(shard, staging_dir, final_root, provenance_hash):
    """Write to a staging dir, then move it into place in one rename."""
    staging = Path(staging_dir)
    final = Path(final_root) / shard
    payload = sorted(p for p in staging.rglob("*") if p.is_file())
    h = hashlib.sha256()
    for p in payload:
        h.update(str(p.relative_to(staging)).encode())
        h.update(p.read_bytes())
    content_hash = h.hexdigest()

    if final.exists():
        shutil.rmtree(final)
    final.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, final)                 # atomic: the shard appears complete or not at all
    return ShardRecord(
        shard=shard,
        provenance_hash=provenance_hash,
        content_hash=content_hash,
        tiles=len([p for p in payload if p.suffix in {".glb", ".b3dm"}]),
        bytes_out=sum(p.stat().st_size for p in payload),
        seconds=0.0,
        finished_at=time.time(),
    )
```

Staging then renaming is the whole trick. A worker killed mid-write leaves a directory under `staging/`, which the resume ignores and deletes; it can never leave a partially populated shard under the final prefix. On object storage without directory renames, the equivalent is to write every object under a per-shard prefix and then write a single small `_complete` marker last — the marker is the atomic event.

The content hash covers the shard's whole payload in sorted order, so it is comparable across runs and is what the reconciliation pass in step 5 checks.

### 2. Append the record to a manifest, and never rewrite it

```python
class Manifest:
    """Append-only JSON Lines. Crash-safe because a partial last line is discarded on read."""

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record):
        line = json.dumps(asdict(record), sort_keys=True, separators=(",", ":"))
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())               # the record survives a power loss

    def read(self):
        done, skipped = {}, 0
        if not self.path.exists():
            return done, skipped
        for raw in self.path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                skipped += 1                   # truncated final line from a hard kill
                continue
            done[rec["shard"]] = rec           # a later record supersedes an earlier one
        return done, skipped

manifest = Manifest("build/city/manifest.jsonl")
completed, partial_lines = manifest.read()
print(f"{len(completed)} shards recorded, {partial_lines} truncated line(s) ignored")
```

Append-only with `fsync` and one JSON object per line is the cheapest durable structure there is, and its failure mode is benign: the only record a crash can damage is the last one, and an unparsable line is simply dropped. Rewriting a whole manifest file, by contrast, can lose every record if the process dies during the write.

Letting a later record supersede an earlier one means re-running a shard needs no deletion — the newest line wins, which is what you want when a shard is rebuilt after a data fix.

<figure class="diagram">
<svg viewBox="10 32 608 212" role="img" aria-labelledby="ck-commit-t ck-commit-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ck-commit-t">Staging, atomic rename, manifest append</title>
  <desc id="ck-commit-d">A worker writes a shard's tiles into a per-run staging directory. When the shard is complete the directory is renamed into the final output prefix in one atomic operation, and only then is a record appended to the manifest and flushed to disk. A crash before the rename leaves only staging garbage; a crash between rename and append leaves an unrecorded but complete shard, which reconciliation adopts.</desc>
  <rect class="svg-bg" x="10" y="32" width="608" height="212" fill="#ffffff"/>
  <defs>
    <marker id="ck-commit-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="24" y="46" width="150" height="76" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="234" y="46" width="160" height="76" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="454" y="46" width="150" height="76" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="454" y="158" width="150" height="72" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="234" y="158" width="160" height="72" rx="8" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#ck-commit-arrow)">
    <path d="M174 84 H232"/>
    <path d="M394 84 H452"/>
    <path d="M529 122 V156"/>
    <path d="M394 194 H452" marker-end="none" stroke-dasharray="5 4"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="99" y="76">tile the shard</text><text x="99" y="94">into staging/</text><text x="99" y="112">(crash ⇒ garbage)</text>
    <text x="314" y="70">one rename into</text><text x="314" y="88">output/&lt;shard&gt;/</text><text x="314" y="106">atomic, no partials</text>
    <text x="529" y="70">append record:</text><text x="529" y="88">hashes, tiles,</text><text x="529" y="106">bytes, seconds</text>
    <text x="529" y="184">fsync — survives</text><text x="529" y="202">power loss;</text><text x="529" y="220">last line may tear</text>
    <text x="314" y="184">gap here ⇒ shard</text><text x="314" y="202">complete but</text><text x="314" y="220">unrecorded</text>
  </g>
</svg>
<figcaption>The rename is the commit point; the manifest append is a record of it, and the gap between them is the only case reconciliation has to handle.</figcaption>
</figure>

### 3. Compute the outstanding work at start-up

```python
def plan_run(all_shards, manifest, provenance_hash, force=()):
    """Split the shard list into skip / rebuild / new, and explain each decision."""
    completed, _ = manifest.read()
    plan = {"skip": [], "stale": [], "new": [], "forced": []}
    for shard in sorted(all_shards):
        rec = completed.get(shard)
        if shard in force:
            plan["forced"].append(shard)
        elif rec is None:
            plan["new"].append(shard)
        elif rec["provenance_hash"] != provenance_hash:
            plan["stale"].append(shard)                # inputs, params or tools changed
        else:
            plan["skip"].append(shard)
    plan["todo"] = plan["new"] + plan["stale"] + plan["forced"]
    return plan

ALL = [line.strip() for line in Path("build/city/shards.txt").read_text().splitlines() if line.strip()]
plan = plan_run(ALL, manifest, provenance_hash="c41d9f8a2b703e55")
print({k: len(v) for k, v in plan.items()})
```

Separating *new* from *stale* is what makes the resume trustworthy rather than merely fast. A shard skipped because its provenance hash matches is skipped for a stated reason — same inputs, same parameters, same tool versions — and a shard whose inputs changed is rebuilt even though its output exists. Skipping on file existence alone silently keeps stale tiles after a parameter change, which is the most common way a resumed pipeline ships wrong data.

### 4. Clean the staging area before doing anything else

```python
def sweep_staging(staging_root, max_age_s=0):
    """Remove leftovers from the interrupted run. Nothing here is ever valid output."""
    removed, kept = [], []
    root = Path(staging_root)
    if not root.exists():
        return {"removed": 0, "kept": 0}
    now = time.time()
    for child in sorted(root.iterdir()):
        age = now - child.stat().st_mtime
        if age >= max_age_s:
            shutil.rmtree(child, ignore_errors=True)
            removed.append(child.name)
        else:
            kept.append(child.name)                    # another live worker owns it
    return {"removed": len(removed), "kept": len(kept), "examples": removed[:3]}

print(sweep_staging("build/city/staging"))
```

The `max_age_s` guard is there for the case where a second worker is still running — sweeping a live worker's staging directory turns a partial failure into a total one. In a single-process resume, zero is correct; with concurrent workers, set it comfortably above the slowest shard's runtime, or give each run its own staging prefix and sweep only your own.

### 5. Reconcile output against the manifest

```python
def reconcile(all_shards, manifest, final_root, adopt=True):
    """Find the three inconsistencies a crash can leave, and optionally repair them."""
    completed, _ = manifest.read()
    on_disk = {p.name for p in Path(final_root).iterdir() if p.is_dir()} \
        if Path(final_root).exists() else set()
    expected = set(all_shards)

    report = {
        "recorded_and_present": sorted(set(completed) & on_disk),
        "present_not_recorded": sorted(on_disk - set(completed)),   # crashed after rename
        "recorded_not_present": sorted(set(completed) - on_disk),   # deleted or wrong root
        "never_built": sorted(expected - on_disk - set(completed)),
        "unexpected": sorted(on_disk - expected),                   # stale shard, schema changed
    }
    if adopt:
        adopted = []
        for shard in report["present_not_recorded"]:
            rec = rehash_existing(shard, final_root)
            manifest.append(rec)
            adopted.append(shard)
        report["adopted"] = adopted
    return report

def rehash_existing(shard, final_root, provenance_hash="unknown"):
    d = Path(final_root) / shard
    files = sorted(p for p in d.rglob("*") if p.is_file())
    h = hashlib.sha256()
    for p in files:
        h.update(str(p.relative_to(d)).encode())
        h.update(p.read_bytes())
    return ShardRecord(shard, provenance_hash, h.hexdigest(),
                       len([p for p in files if p.suffix in {".glb", ".b3dm"}]),
                       sum(p.stat().st_size for p in files), 0.0, time.time())

report = reconcile(ALL, manifest, "build/city/output")
print({k: (len(v) if isinstance(v, list) else v) for k, v in report.items()})
```

`present_not_recorded` is the gap in the diagram above: the rename succeeded and the process died before the append. Adopting those shards by re-hashing them is cheap and correct — the output is complete by construction, because the rename only happens once it is. Setting `adopt=False` and rebuilding them instead is also defensible and costs one shard's work.

`recorded_not_present` always means something outside the pipeline removed output, and the right response is to drop those records and rebuild, never to trust the manifest over the disk.

<figure class="diagram">
<svg viewBox="6 2 728 244" role="img" aria-labelledby="ck-recon-t ck-recon-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ck-recon-t">Reconciling the manifest against the output</title>
  <desc id="ck-recon-d">Two overlapping sets. Shards recorded in the manifest and shards present on disk. The overlap is healthy and is skipped. Present but not recorded means the run crashed between the rename and the append, and those shards are adopted by re-hashing. Recorded but not present means output was deleted, and those records are dropped so the shards rebuild. Outside both sets are shards that were never built.</desc>
  <rect class="svg-bg" x="6" y="2" width="728" height="244" fill="#ffffff"/>
  <rect x="20" y="16" width="700" height="216" rx="10" fill="#ffffff" stroke="#e6e0d4" stroke-width="1.5"/>
  <circle cx="290" cy="120" r="94" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <circle cx="430" cy="120" r="94" fill="#eef5e9" fill-opacity="0.75" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#15384a" font-size="12.5" text-anchor="middle">
    <text x="205" y="112">recorded,</text><text x="205" y="130">not present:</text><text x="205" y="148">drop &amp; rebuild</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="360" y="112">both:</text><text x="360" y="130">skip</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="518" y="112">present, not</text><text x="518" y="130">recorded:</text><text x="518" y="148">adopt by rehash</text>
  </g>
  <text x="290" y="44" fill="#1f6b8a" font-size="13" text-anchor="middle">manifest records</text>
  <text x="470" y="44" fill="#1f2937" font-size="13" text-anchor="middle">shards on disk</text>
  <text x="640" y="206" fill="#5b6471" font-size="12.5" text-anchor="middle">outside both:</text>
  <text x="640" y="222" fill="#5b6471" font-size="12.5" text-anchor="middle">never built</text>
  <text x="96" y="206" fill="#5b6471" font-size="12.5" text-anchor="middle">every shard in</text>
  <text x="96" y="222" fill="#5b6471" font-size="12.5" text-anchor="middle">shards.txt</text>
</svg>
<figcaption>Four regions, four fixed responses — and a resume that starts by naming which region every shard is in.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="ck-states-t ck-states-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ck-states-t">What each shard state means on resume</title>
  <desc id="ck-states-d">A table of five shard states and the resume action for each. A shard with a manifest record and matching provenance is skipped. One with a record but a changed provenance hash is rebuilt because its inputs moved. One present on disk with no record is adopted by re-hashing. One recorded but missing from disk is rebuilt because something deleted the output. One in the failures file is left alone until the bug is fixed and it is forced.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="230" y="20" width="108" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="338" y="20" width="100" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="438" y="20" width="284" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="212" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="54" width="108" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="338" y="54" width="100" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="438" y="54" width="284" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="212" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="88" width="108" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="338" y="88" width="100" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="438" y="88" width="284" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="122" width="212" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="122" width="108" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="338" y="122" width="100" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="438" y="122" width="284" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="212" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="156" width="108" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="338" y="156" width="100" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="438" y="156" width="284" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="190" width="212" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="190" width="108" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="338" y="190" width="100" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="438" y="190" width="284" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="124" y="42">state</text><text x="284" y="42">manifest</text><text x="388" y="42">on disk</text><text x="580" y="42">resume action</text>
    <text x="124" y="76">provenance matches</text><text x="284" y="76">yes</text><text x="388" y="76">yes</text><text x="580" y="76">skip</text>
    <text x="124" y="110">provenance changed</text><text x="284" y="110">yes</text><text x="388" y="110">yes</text><text x="580" y="110">rebuild — inputs moved</text>
    <text x="124" y="144">complete, unrecorded</text><text x="284" y="144">no</text><text x="388" y="144">yes</text><text x="580" y="144">adopt by re-hashing</text>
    <text x="124" y="178">recorded, missing</text><text x="284" y="178">yes</text><text x="388" y="178">no</text><text x="580" y="178">drop record, rebuild</text>
    <text x="124" y="212">in failures.jsonl</text><text x="284" y="212">no</text><text x="388" y="212">no</text><text x="580" y="212">leave until fixed, then force</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">Five states, five fixed responses — the resume names the state before it does anything.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">The third row is the crash window between the atomic rename and the manifest append.</text>
</svg>
<figcaption>Every shard falls into exactly one of these five states, and each has a single correct response.</figcaption>
</figure>

### 6. Run it, and checkpoint the aggregate too

```python
def resumable_run(all_shards, provenance_hash, build_fn,
                  root="build/city", force=()):
    manifest = Manifest(f"{root}/manifest.jsonl")
    sweep_staging(f"{root}/staging")
    recon = reconcile(all_shards, manifest, f"{root}/output")
    plan = plan_run(all_shards, manifest, provenance_hash, force=force)

    started = time.time()
    for i, shard in enumerate(plan["todo"], start=1):
        staging = tempfile.mkdtemp(prefix=f"{shard}-", dir=f"{root}/staging")
        t0 = time.time()
        try:
            build_fn(shard, staging)
            rec = commit_shard(shard, staging, f"{root}/output", provenance_hash)
            manifest.append(ShardRecord(**{**asdict(rec), "seconds": round(time.time() - t0, 3)}))
        except Exception as exc:                        # one bad shard must not end the run
            shutil.rmtree(staging, ignore_errors=True)
            with open(f"{root}/failures.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"shard": shard, "error": repr(exc)[:400],
                                    "at": time.time()}) + "\n")
        if i % 50 == 0:
            done = i / len(plan["todo"])
            eta = (time.time() - started) / max(done, 1e-9) * (1 - done)
            print(f"{i}/{len(plan['todo'])} shards, eta {eta/60:.0f} min")

    final, _ = manifest.read()
    return {"reconciled": {k: len(v) for k, v in recon.items() if isinstance(v, list)},
            "skipped": len(plan["skip"]), "built": len(plan["todo"]),
            "recorded_total": len(final)}
```

Catching the per-shard exception and logging it to `failures.jsonl` rather than propagating is what turns one geometry bug into a 5,999-shard success plus a list to fix, instead of an aborted run. The failures file is a work list for the next resume: pass those shard keys as `force` once the bug is fixed.

Writing the tileset that references these shards belongs *after* the loop, built from the manifest, so it always describes what actually exists.

## Expected Output & Verification

```text
4127 shards recorded, 1 truncated line(s) ignored
{'removed': 3, 'kept': 0, 'examples': ['120210233010-a1b2', '120210233011-cd34', '120210233012-ef56']}
{'recorded_and_present': 4127, 'present_not_recorded': 2, 'recorded_not_present': 0,
 'never_built': 1871, 'unexpected': 0, 'adopted': 2}
{'skip': 4129, 'stale': 0, 'new': 1871, 'forced': 0, 'todo': 1871}
50/1871 shards, eta 168 min
...
{'reconciled': {...}, 'skipped': 4129, 'built': 1871, 'recorded_total': 6000}
```

The resume skipped 4,129 shards — 4,127 from the manifest plus the 2 adopted by reconciliation — and rebuilt only the 1,871 that had never run. Three staging directories were swept, which is the signature of a run killed with three workers in flight, and one manifest line was torn by the kill and correctly ignored.

Verify that the resumed result is identical to what an uninterrupted run would have produced:

```python
def resume_equivalence_check(all_shards, root_resumed, root_clean):
    """Every shard's content hash must match between the resumed and the from-scratch run."""
    a, _ = Manifest(f"{root_resumed}/manifest.jsonl").read()
    b, _ = Manifest(f"{root_clean}/manifest.jsonl").read()
    only_a = sorted(set(a) - set(b))
    only_b = sorted(set(b) - set(a))
    mismatched = sorted(s for s in set(a) & set(b)
                        if a[s]["content_hash"] != b[s]["content_hash"]
                        and a[s]["provenance_hash"] != "unknown")
    return {"shards": len(b), "only_in_resumed": only_a, "only_in_clean": only_b,
            "content_mismatches": mismatched[:5], "equivalent": not (only_a or only_b or mismatched)}

print(resume_equivalence_check(ALL, "build/city", "build/city_clean"))
```

This is the test that matters, and it is worth running once on a 200-shard subset rather than the city: kill the run at a random point, resume it, and compare against a clean build. Any mismatch means either the output is not deterministic or a shard's completion is not atomic, and both are worth finding on a subset rather than in production.

Also verify that changing a parameter invalidates the right shards:

```python
def staleness_check(all_shards, manifest, old_hash, new_hash):
    p_same = plan_run(all_shards, manifest, old_hash)
    p_changed = plan_run(all_shards, manifest, new_hash)
    return {"skipped_when_unchanged": len(p_same["skip"]),
            "rebuilt_when_changed": len(p_changed["stale"]) + len(p_changed["new"]),
            "correct": len(p_same["todo"]) == 0 and len(p_changed["skip"]) == 0}

print(staleness_check(ALL, manifest, "c41d9f8a2b703e55", "9e71b04c3d8a2f16"))
```

A resume that skips everything after a parameter change is the dangerous failure, because it succeeds quickly and ships the old tiles. This check asserts the two ends of the behaviour: nothing rebuilt when nothing changed, everything rebuilt when the provenance changed.

## Performance Notes

- **Manifest reads are trivial** — 6,000 JSON Lines records parse in well under a second, so re-reading on every resume costs nothing.
- **`fsync` per record costs about a millisecond** on SSD, against seconds to minutes per shard. Never batch it away; batching is how you lose the last minutes of a run.
- **Re-hashing on adoption is I/O-bound** and only touches the handful of shards in the gap, typically fewer than the worker count.
- **Reconciliation lists a directory with thousands of entries.** On object storage that is a paginated `LIST` costing a second or two; cache the result for the run rather than calling it per shard.
- **Put staging on the same filesystem as the output**, otherwise `os.replace` falls back to a copy and the commit stops being atomic and starts being slow.

## Common Errors

**`OSError: [Errno 18] Invalid cross-device link`.** Staging and output are on different mounts, so the rename cannot be atomic. Move staging under the output root.

**The resume rebuilds everything.** The provenance hash is not stable between runs — usually because it includes a timestamp, a temporary path or a run identifier. It must contain only inputs, parameters and tool versions.

**The resume skips a shard whose source data changed.** The provenance hash does not include the input file digests, only the parameters. Add the digests.

**Manifest has two records for one shard with different hashes.** Expected after a rebuild; the last line wins. If it happens within a single run, two workers were assigned the same shard — check the work-splitting.

**`json.JSONDecodeError` on a line that is not the last.** Something other than the append path wrote to the manifest, or two processes appended without `O_APPEND`. Opening in `"a"` mode gives atomic appends for lines below the pipe buffer size; larger records need a lock.

**Tileset references a shard that is not on disk.** The tileset was written from the shard list rather than from the manifest. Build it from the manifest, after the loop.

## Frequently Asked Questions

### Why not use a database for the manifest?

A database is a better answer once several machines write concurrently, and Postgres with a unique key on the shard is a five-line change. For a single driver process, a JSON Lines file has no service to run, no connection to lose and a recovery story you can read with `tail`.

### Should the failures file be part of the resume plan automatically?

No. Retrying a failed shard automatically on the next run hides a persistent bug behind a growing runtime. Surface it, fix it, then force those shards.

### How does this interact with a distributed scheduler?

The manifest and reconciliation stay in the driver; the workers only ever stage and return a record. That keeps the durable state in one place, which is what makes the resume reasoning simple.

## Related Guides

- [Orchestrating Tiling Jobs with Dask](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/orchestrating-tiling-jobs-with-dask/) — the run this checkpoints
- [Making Tile Output Deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) — the property a resume depends on
- [Choosing Shard Sizes for City-Scale Tiling](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/choosing-shard-sizes-for-city-scale-tiling/) — the unit of work being checkpointed

Back to [3D Tiles Batch Tiling Pipelines](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/).
