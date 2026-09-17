---
title: "Running PDAL Pipelines in Docker"
description: "Containerise a PDAL pipeline reproducibly: pinned images, PROJ grid handling, volume and permission mapping, memory limits"
---
# Running PDAL Pipelines in Docker

This page containerises a PDAL point-cloud pipeline so it produces identical output on a laptop and in CI — pinning the image by digest, getting PROJ transformation grids into the container, mapping volumes and file ownership so output is not root-owned, setting memory limits that fail loudly instead of being killed, and verifying the versions the pipeline actually ran with.

## Why you hit this

A PDAL pipeline's output depends on PDAL's version, GDAL's version, PROJ's version *and* the PROJ transformation grids present on the machine. Change any of those and a datum transformation shifts by centimetres, a filter's default changes, or a writer emits a different point format. None of it is visible in the pipeline JSON, so two runs that look identical produce different data.

Containers fix this when they are pinned and break it when they are not. `pdal/pdal:latest` is a moving target that will change PROJ under you; a digest-pinned image with the grids baked in is a reproducible computation.

## Prerequisites

- Docker 24+ or Podman 4+; Python 3.10+ on the host for the wrapper.
- A PDAL pipeline JSON — see [cropping point clouds to polygons with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/cropping-point-clouds-to-polygons-with-pdal/).
- Knowledge of which datum transformations the pipeline needs, so the right grids are installed.

## Step-by-Step

### 1. Pin the image by digest, not by tag

```python
import json
import os
import shlex
import subprocess
from pathlib import Path

IMAGE = {
    "repository": "ghcr.io/pdal/pdal",
    "tag": "2.7.2",
    "digest": "sha256:4f1a8c2e9b7d6350e1c8a4f2b90d7e13c6a58f04b2e9d71c3a06f85b24e1c9d7",
}

def image_reference(pinned=True):
    if pinned:
        return f"{IMAGE['repository']}@{IMAGE['digest']}"
    return f"{IMAGE['repository']}:{IMAGE['tag']}"

def resolve_digest(repository, tag):
    """Look up the digest for a tag so it can be recorded and pinned."""
    proc = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", f"{repository}:{tag}",
         "--format", "{{json .Manifest}}"],
        capture_output=True, text=True)
    if proc.returncode != 0:
        proc = subprocess.run(["docker", "pull", f"{repository}:{tag}"],
                              capture_output=True, text=True, check=True)
        inspect = subprocess.run(
            ["docker", "inspect", "--format", "{{index .RepoDigests 0}}",
             f"{repository}:{tag}"],
            capture_output=True, text=True, check=True)
        return {"reference": inspect.stdout.strip(),
                "digest": inspect.stdout.strip().split("@")[-1]}
    manifest = json.loads(proc.stdout)
    return {"reference": f"{repository}@{manifest['digest']}",
            "digest": manifest["digest"]}

print(json.dumps(resolve_digest("ghcr.io/pdal/pdal", "2.7.2"), indent=2))
```

A tag is a mutable pointer. `pdal/pdal:2.7.2` can be rebuilt against a newer PROJ, and the rebuild is invisible — same tag, different transformation results. A digest identifies the exact image bytes and is what "reproducible" requires.

Recording the digest in the repository alongside the pipeline is the practical habit: the pipeline JSON says *what* to compute and the digest says *with what*, and both are needed to reproduce a result a year later.

Resolving the digest from a tag once, at the point you choose the version, is the workflow — then pin and forget.

### 2. Get the PROJ grids into the container

```dockerfile
# Dockerfile
FROM ghcr.io/pdal/pdal@sha256:4f1a8c2e9b7d6350e1c8a4f2b90d7e13c6a58f04b2e9d71c3a06f85b24e1c9d7

# Grids the project's transformations need, fetched at build time and baked in.
# no_kv_arcgp-2006.tif: NN2000 heights; de_adv_BETA2007.tif: DHHN2016.
ARG PROJ_DATA_DIR=/usr/share/proj
RUN set -eux; \
    mkdir -p "${PROJ_DATA_DIR}"; \
    for grid in \
        no_kv_arcgp-2006.tif \
        no_kv_ETRS89NO_NGO48_TIN.tif \
        de_adv_BETA2007.tif \
        us_noaa_g2018u0.tif ; do \
      curl -fsSL -o "${PROJ_DATA_DIR}/${grid}" \
        "https://cdn.proj.org/${grid}"; \
    done; \
    ls -l "${PROJ_DATA_DIR}" | head -20

ENV PROJ_DATA=/usr/share/proj \
    PROJ_NETWORK=OFF \
    GDAL_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    CPL_DEBUG=OFF

# Run as a non-root user whose id is supplied at build time.
ARG UID=1000
ARG GID=1000
RUN groupadd -g "${GID}" pipeline 2>/dev/null || true; \
    useradd -u "${UID}" -g "${GID}" -m -s /bin/bash pipeline 2>/dev/null || true
USER ${UID}:${GID}

WORKDIR /work
ENTRYPOINT ["pdal"]
```

`PROJ_NETWORK=OFF` with the grids baked in is the combination that makes the container reproducible. With networking on, PROJ downloads grids on demand from the CDN — so the first run and the tenth run can use different transformations, and a run without network access silently falls back to a lower-accuracy transformation path.

The fallback is the dangerous part: PROJ does not fail when a grid is missing, it uses the best available path, which might be a 1 m-accurate Helmert instead of a 1 cm-accurate grid shift. The output is plausible and wrong by decimetres.

Baking the grids at build time costs a few hundred megabytes and removes the whole class of problem. Which grids to include comes from listing the transformations the project uses — `projinfo -s EPSG:25832+5941 -t EPSG:4978 --spatial-test intersects` names them.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="docker-proj-t docker-proj-d" xmlns="http://www.w3.org/2000/svg">
  <title id="docker-proj-t">PROJ grid availability and transformation accuracy</title>
  <desc id="docker-proj-d">Three container configurations transforming the same point. With the grid baked in and network off, PROJ uses the grid shift and the height is correct to one centimetre. With no grid and network on, PROJ downloads the grid on the first run, giving the same answer but a different result if the CDN content changes. With no grid and network off, PROJ silently falls back to a Helmert transformation and the height is 38 centimetres out, with no warning and a successful exit code.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="230" y="20" width="212" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="442" y="20" width="130" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="572" y="20" width="150" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="212" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="230" y="54" width="212" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="442" y="54" width="130" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="572" y="54" width="150" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="98" width="212" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="230" y="98" width="212" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="442" y="98" width="130" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="572" y="98" width="150" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="142" width="212" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="230" y="142" width="212" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="442" y="142" width="130" height="44" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="572" y="142" width="150" height="44" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="124" y="41">container config</text><text x="336" y="41">transformation used</text>
    <text x="507" y="41">height error</text><text x="647" y="41">reproducible?</text>
    <text x="124" y="72">grid baked in,</text><text x="124" y="90">PROJ_NETWORK=OFF</text>
    <text x="336" y="81">grid shift (1 cm)</text>
    <text x="507" y="81">0.01 m</text><text x="647" y="81">yes</text>
    <text x="124" y="116">no grid,</text><text x="124" y="134">PROJ_NETWORK=ON</text>
    <text x="336" y="125">grid, downloaded</text>
    <text x="507" y="125">0.01 m</text><text x="647" y="125">only if the CDN is</text>
    <text x="124" y="160">no grid,</text><text x="124" y="178">PROJ_NETWORK=OFF</text>
    <text x="336" y="171">Helmert fallback</text>
    <text x="507" y="171">0.38 m</text><text x="647" y="171">yes — and wrong</text>
  </g>
  <text x="647" y="140" fill="#9a4f26" font-size="11.5" text-anchor="middle">unchanged</text>
  <text x="370" y="212" fill="#b0413e" font-size="12.5" text-anchor="middle">the third row exits successfully and reports nothing</text>
  <text x="370" y="234" fill="#5b6471" font-size="12" text-anchor="middle">PROJ picks the best available path; a missing grid is a silent downgrade, not an error</text>
</svg>
<figcaption>The missing-grid case is the one to design against: it succeeds, says nothing, and is 38 cm wrong.</figcaption>
</figure>

### 3. Map volumes and file ownership correctly

```python
def docker_run(pipeline_path, input_dir, output_dir, image=None,
               memory_gb=8, cpus=4.0, extra_env=None, network=False,
               read_only_input=True):
    image = image or image_reference()
    uid, gid = os.getuid(), os.getgid()
    in_abs = Path(input_dir).resolve()
    out_abs = Path(output_dir).resolve()
    out_abs.mkdir(parents=True, exist_ok=True)
    pipe_abs = Path(pipeline_path).resolve()

    args = [
        "docker", "run", "--rm",
        "--user", f"{uid}:{gid}",
        "--memory", f"{memory_gb}g",
        "--memory-swap", f"{memory_gb}g",          # no swap: fail rather than thrash
        "--cpus", str(cpus),
        "--network", "none" if not network else "bridge",
        "--security-opt", "no-new-privileges",
        "-v", f"{in_abs}:/work/input:ro" if read_only_input
              else f"{in_abs}:/work/input",
        "-v", f"{out_abs}:/work/output",
        "-v", f"{pipe_abs.parent}:/work/pipelines:ro",
        "-e", "PROJ_NETWORK=OFF",
        "-e", "GDAL_NUM_THREADS=1",
        "-e", "OMP_NUM_THREADS=1",
    ]
    for key, value in (extra_env or {}).items():
        args.extend(["-e", f"{key}={value}"])
    args.append(image)
    args.extend(["pipeline", f"/work/pipelines/{pipe_abs.name}",
                 "--metadata", "/work/output/metadata.json"])
    return args

def run(pipeline_path, input_dir, output_dir, **kwargs):
    args = docker_run(pipeline_path, input_dir, output_dir, **kwargs)
    proc = subprocess.run(args, capture_output=True, text=True)
    result = {
        "command": " ".join(shlex.quote(a) for a in args),
        "returncode": proc.returncode,
        "stderr_tail": proc.stderr.strip().splitlines()[-5:],
    }
    if proc.returncode == 137:
        result["diagnosis"] = ("exit 137 = SIGKILL, almost always the container's "
                              "memory limit; raise --memory or stream the pipeline")
    elif proc.returncode != 0:
        result["diagnosis"] = "pipeline failed; see stderr_tail"
    meta = Path(output_dir) / "metadata.json"
    if meta.exists():
        result["metadata"] = json.loads(meta.read_text())
    return result
```

`--user $(id -u):$(id -g)` is the option whose absence causes the most friction: without it every output file is owned by root, and the next step in the pipeline — or the developer — cannot delete or overwrite them. It is a one-line fix that people rediscover repeatedly.

Mounting the input read-only is worth doing because a PDAL pipeline should never modify its input, and a typo that writes to the input path is caught by the filesystem rather than by noticing later.

`--network none` is both a reproducibility measure and a safety one: it guarantees PROJ cannot download a grid, so a missing grid becomes a detectable behaviour change rather than a silent success.

`--memory-swap` equal to `--memory` disables swap for the container, which turns "the job ran for nine hours thrashing" into "the job failed in four minutes with exit 137". The second is far more useful.

### 4. Make the pipeline paths container-relative

```python
def containerise_pipeline(pipeline_dict, input_map=None, output_map=None):
    """Rewrite host paths to container paths so one JSON works in both places."""
    input_map = input_map or {}
    output_map = output_map or {}
    out = json.loads(json.dumps(pipeline_dict))          # deep copy

    def rewrite(value):
        if not isinstance(value, str):
            return value
        for host, container in {**input_map, **output_map}.items():
            if value.startswith(host):
                return value.replace(host, container, 1)
        return value

    stages = out.get("pipeline", [])
    for i, stage in enumerate(stages):
        if isinstance(stage, str):
            stages[i] = rewrite(stage)
            continue
        for key in ("filename", "datasource"):
            if key in stage:
                stage[key] = rewrite(stage[key])
        if "ogr" in stage and isinstance(stage["ogr"], dict):
            if "datasource" in stage["ogr"]:
                stage["ogr"]["datasource"] = rewrite(stage["ogr"]["datasource"])
    return out

def write_containerised(pipeline_path, out_path, input_dir, output_dir):
    original = json.loads(Path(pipeline_path).read_text())
    converted = containerise_pipeline(
        original,
        input_map={str(Path(input_dir).resolve()): "/work/input"},
        output_map={str(Path(output_dir).resolve()): "/work/output"},
    )
    Path(out_path).write_text(json.dumps(converted, indent=2))
    remaining = [s for s in json.dumps(converted).split('"')
                 if s.startswith("/") and not s.startswith("/work")]
    return {"path": str(out_path),
            "host_paths_remaining": sorted(set(remaining))[:5],
            "clean": not remaining}
```

Rewriting the paths rather than maintaining two pipeline files keeps a single source of truth. The `host_paths_remaining` check is the useful part: an absolute path that is not under `/work` will not exist in the container, and the failure is a confusing "unable to open" rather than an obvious mapping error.

The `ogr.datasource` key needs handling separately because it is nested, and it is the one most often missed — a crop pipeline that works on the host and fails in the container usually has a host path to a GeoPackage buried there.

### 5. Record the versions the run actually used

```python
def capture_environment(image=None):
    image = image or image_reference()
    commands = {
        "pdal": ["pdal", "--version"],
        "pdal_drivers": ["pdal", "--drivers"],
        "gdal": ["gdalinfo", "--version"],
        "proj": ["projinfo", "--version"],
        "proj_data": ["sh", "-c", "ls /usr/share/proj | head -40"],
        "proj_search_paths": ["sh", "-c", "projinfo --searchpaths"],
    }
    captured = {}
    for name, cmd in commands.items():
        proc = subprocess.run(
            ["docker", "run", "--rm", "--network", "none",
             "--entrypoint", cmd[0], image, *cmd[1:]],
            capture_output=True, text=True)
        captured[name] = (proc.stdout or proc.stderr).strip()[:2000]
    return {"image": image, "captured": captured}

def provenance_record(pipeline_path, environment, output_dir):
    import hashlib
    pipeline_text = Path(pipeline_path).read_text()
    record = {
        "image": environment["image"],
        "pipeline_sha256": hashlib.sha256(pipeline_text.encode()).hexdigest(),
        "pdal_version": _first_line(environment["captured"]["pdal"]),
        "gdal_version": environment["captured"]["gdal"],
        "proj_version": _first_line(environment["captured"]["proj"]),
        "proj_grids": sorted(environment["captured"]["proj_data"].split()),
        "env": {"PROJ_NETWORK": "OFF", "GDAL_NUM_THREADS": "1",
                "OMP_NUM_THREADS": "1"},
    }
    path = Path(output_dir) / "provenance.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True))
    return record

def _first_line(text):
    return text.strip().splitlines()[0] if text.strip() else ""
```

Writing a provenance record alongside every output is what makes a result reproducible rather than merely repeatable. It records the image digest, the pipeline's hash, and the three library versions plus the grid list — which is everything that can change the numbers.

The grid list matters as much as the versions. Two runs of the same image with different `PROJ_DATA` contents produce different heights, and the list is the only record of which grids were available.

This record is also what the incremental-build machinery in [making tile output deterministic](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/making-tile-output-deterministic/) hashes into a provenance value.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="docker-repro-t docker-repro-d" xmlns="http://www.w3.org/2000/svg">
  <title id="docker-repro-t">What has to be pinned for a run to repeat</title>
  <desc id="docker-repro-d">A table of five things that change a PDAL pipeline's numeric output, with how each is pinned. The image digest pins PDAL, GDAL and PROJ together. The PROJ grid set must be baked in and network access disabled. Thread counts must be fixed for reproducible reductions. The pipeline JSON is hashed. The input files are hashed. All five together are what a provenance record holds.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="260" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="278" y="20" width="222" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="500" y="20" width="222" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="278" y="54" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="54" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="260" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="278" y="88" width="222" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="500" y="88" width="222" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="122" width="260" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="278" y="122" width="222" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="500" y="122" width="222" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="278" y="156" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="156" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="190" width="260" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="278" y="190" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="500" y="190" width="222" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="148" y="42">what changes the output</text><text x="389" y="42">how it is pinned</text><text x="611" y="42">recorded as</text>
    <text x="148" y="76">PDAL, GDAL, PROJ versions</text><text x="389" y="76">image digest, not a tag</text><text x="611" y="76">sha256 in the record</text>
    <text x="148" y="110">PROJ transformation grids</text><text x="389" y="110">baked in, network off</text><text x="611" y="110">the grid file list</text>
    <text x="148" y="144">thread counts</text><text x="389" y="144">OMP and GDAL set to 1</text><text x="611" y="144">the env block</text>
    <text x="148" y="178">the pipeline itself</text><text x="389" y="178">hashed</text><text x="611" y="178">sha256 of the JSON</text>
    <text x="148" y="212">the input data</text><text x="389" y="212">hashed</text><text x="611" y="212">sha256 per input</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">A missing PROJ grid is a silent downgrade, not an error — which is why row two is the dangerous one.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">All five go in provenance.json next to the output, or the result cannot be reproduced.</text>
</svg>
<figcaption>Five things decide the numbers, and only one of them is visible in the pipeline JSON.</figcaption>
</figure>

### 6. Wire it into CI

```yaml
# .github/workflows/pipeline.yml
name: point-cloud pipeline
on: [push, workflow_dispatch]

jobs:
  run:
    runs-on: ubuntu-24.04
    env:
      PDAL_IMAGE: ghcr.io/pdal/pdal@sha256:4f1a8c2e9b7d6350e1c8a4f2b90d7e13c6a58f04b2e9d71c3a06f85b24e1c9d7
    steps:
      - uses: actions/checkout@v4

      - name: Pull the pinned image
        run: docker pull "$PDAL_IMAGE"

      - name: Record the environment
        run: |
          mkdir -p build
          docker run --rm --network none --entrypoint pdal "$PDAL_IMAGE" --version \
            | tee build/pdal_version.txt
          docker run --rm --network none --entrypoint projinfo "$PDAL_IMAGE" --version \
            | tee build/proj_version.txt
          docker run --rm --network none --entrypoint sh "$PDAL_IMAGE" \
            -c 'ls /usr/share/proj' | tee build/proj_grids.txt

      - name: Assert the grids the project needs are present
        run: |
          for grid in no_kv_arcgp-2006.tif de_adv_BETA2007.tif; do
            grep -qx "$grid" build/proj_grids.txt \
              || { echo "missing PROJ grid: $grid"; exit 1; }
          done

      - name: Run the pipeline
        run: |
          docker run --rm \
            --user "$(id -u):$(id -g)" \
            --memory 12g --memory-swap 12g --cpus 4 \
            --network none \
            --security-opt no-new-privileges \
            -v "$PWD/data:/work/input:ro" \
            -v "$PWD/build:/work/output" \
            -v "$PWD/pipelines:/work/pipelines:ro" \
            -e PROJ_NETWORK=OFF -e GDAL_NUM_THREADS=1 -e OMP_NUM_THREADS=1 \
            "$PDAL_IMAGE" \
            pipeline /work/pipelines/ground.json \
              --metadata /work/output/metadata.json

      - name: Verify the output
        run: python3 scripts/verify_output.py build/

      - uses: actions/upload-artifact@v4
        with:
          name: pipeline-output
          path: |
            build/*.laz
            build/metadata.json
            build/proj_grids.txt
```

Asserting the grids are present as an explicit CI step is the safeguard that catches a rebuilt base image dropping a grid. Without it the pipeline succeeds with a Helmert fallback and nobody notices until a survey check fails months later.

Uploading the grid list and the version files as artefacts alongside the output means a result from any past CI run can be traced to the environment that produced it, which is the practical form of reproducibility.

<figure class="diagram">
<svg viewBox="4 6 732 238" role="img" aria-labelledby="docker-flags-t docker-flags-d" xmlns="http://www.w3.org/2000/svg">
  <title id="docker-flags-t">The docker run flags that matter and why</title>
  <desc id="docker-flags-d">A table of six docker run flags. The user flag prevents root-owned output. Memory with memory-swap equal makes an over-large job fail with exit 137 in minutes rather than thrash for hours. Network none guarantees PROJ cannot silently download a grid. The read-only input mount prevents a typo writing to the source data. The digest-pinned image prevents a rebuilt tag changing PROJ. No-new-privileges is a general hardening measure.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="238" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="252" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="270" y="20" width="452" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="252" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="270" y="52" width="452" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="82" width="252" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="270" y="82" width="452" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="112" width="252" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="270" y="112" width="452" height="30" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="142" width="252" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="270" y="142" width="452" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="172" width="252" height="30" fill="#ffffff" stroke="#5b6471"/>
    <rect x="270" y="172" width="452" height="30" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="28" y="41">flag</text><text x="280" y="41">what goes wrong without it</text>
    <text x="28" y="72">--user $(id -u):$(id -g)</text>
    <text x="280" y="72">every output file is owned by root and cannot be deleted</text>
    <text x="28" y="102">--memory-swap = --memory</text>
    <text x="280" y="102">an oversized job thrashes for hours instead of exit 137 in minutes</text>
    <text x="28" y="132">--network none</text>
    <text x="280" y="132">PROJ downloads a grid, so two runs use different transformations</text>
    <text x="28" y="162">-v input:ro</text>
    <text x="280" y="162">a path typo writes into the source survey data</text>
    <text x="28" y="192">image@sha256:…</text>
    <text x="280" y="192">a rebuilt tag changes PROJ and shifts every height</text>
  </g>
  <text x="18" y="226" fill="#5b6471" font-size="12">five flags, and four of them prevent a failure that is silent rather than loud</text>
</svg>
<figcaption>Each flag prevents a specific failure, and most of those failures are quiet.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "reference": "ghcr.io/pdal/pdal@sha256:4f1a8c2e9b7d6350e1c8a4f2b90d7e13c6a58f04b2e9d71c3a06f85b24e1c9d7",
  "digest": "sha256:4f1a8c2e9b7d6350e1c8a4f2b90d7e13c6a58f04b2e9d71c3a06f85b24e1c9d7"
}
{'path': 'build/ground.container.json', 'host_paths_remaining': [], 'clean': true}
{
  "image": "ghcr.io/pdal/pdal@sha256:4f1a8c2e…",
  "pipeline_sha256": "9a1f4c20e8b7d3516f2a90c4e1b78d35a604f92c8e1b7d3a506f24c9e8b1d70a",
  "pdal_version": "pdal 2.7.2 (git-version: 8f21ac)",
  "gdal_version": "GDAL 3.8.4, released 2024/02/08",
  "proj_version": "9.3.1",
  "proj_grids": ["de_adv_BETA2007.tif", "no_kv_ETRS89NO_NGO48_TIN.tif",
                 "no_kv_arcgp-2006.tif", "proj.db", "us_noaa_g2018u0.tif"],
  "env": {"GDAL_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "PROJ_NETWORK": "OFF"}
}
{'returncode': 0, 'stderr_tail': []}
```

The provenance record is the deliverable of this page as much as the point cloud is. With the image digest, the pipeline hash and the grid list, the run can be reproduced exactly; without any one of them it cannot.

Verify the container produces the same numbers as a reference, which is the only test that catches a PROJ change:

```python
def transformation_regression_check(image=None, cases=None, tolerance_m=0.005):
    """Transform known points and compare against recorded reference values."""
    image = image or image_reference()
    cases = cases or [
        {"name": "oslo_nn2000_to_ecef",
         "from": "EPSG:25832+5941", "to": "EPSG:4978",
         "input": [598412.44, 6643188.91, 24.0],
         "expected": [3172418.204, 601884.412, 5512104.881]},
        {"name": "utm32_to_wgs84",
         "from": "EPSG:25832", "to": "EPSG:4326",
         "input": [598412.44, 6643188.91, 0.0],
         "expected": [59.913942, 10.752188, 0.0]},
    ]
    rows = []
    for case in cases:
        proc = subprocess.run(
            ["docker", "run", "--rm", "--network", "none",
             "-e", "PROJ_NETWORK=OFF", "--entrypoint", "sh", image,
             "-c", f"echo '{case['input'][0]} {case['input'][1]} {case['input'][2]}' "
                   f"| cs2cs -d 6 {case['from']} {case['to']}"],
            capture_output=True, text=True)
        if proc.returncode != 0:
            rows.append({"case": case["name"], "status": "failed",
                         "stderr": proc.stderr.strip()[-200:]})
            continue
        parts = proc.stdout.split()
        got = [float(p) for p in parts[:3]]
        deltas = [abs(g - e) for g, e in zip(got, case["expected"])]
        rows.append({
            "case": case["name"], "got": got, "expected": case["expected"],
            "max_delta": round(max(deltas), 6),
            "within_tolerance": max(deltas) <= tolerance_m,
        })
    return {"image": image, "cases": rows,
            "all_match": all(r.get("within_tolerance") for r in rows),
            "note": "a failure here means PROJ or its grids changed — the pipeline's "
                    "output has moved"}

print(json.dumps(transformation_regression_check(), indent=2))
```

This is the test that turns "the image is pinned" into "the numbers are the same". It costs two container invocations and catches the failure mode that pinning is supposed to prevent but that a base-image rebuild can still cause if the pin is by tag.

Then verify the memory limit behaves as intended, because discovering it during a nine-hour job is expensive:

```python
def memory_limit_check(pipeline_path, input_dir, output_dir, limits_gb=(1, 4, 12)):
    """Find the limit at which this pipeline fails, so CI can be set above it."""
    rows = []
    for gb in limits_gb:
        result = run(pipeline_path, input_dir, output_dir, memory_gb=gb)
        rows.append({
            "memory_gb": gb,
            "returncode": result["returncode"],
            "killed": result["returncode"] == 137,
            "diagnosis": result.get("diagnosis", "completed"),
        })
        if result["returncode"] == 0:
            break
    smallest_ok = next((r["memory_gb"] for r in rows if r["returncode"] == 0), None)
    return {
        "runs": rows,
        "smallest_working_gb": smallest_ok,
        "recommended_ci_gb": smallest_ok * 1.5 if smallest_ok else None,
        "note": "exit 137 is the container OOM killer, not a pipeline error",
    }
```

Knowing the pipeline's actual memory ceiling lets CI be configured with headroom rather than with a guess, and it turns an intermittent CI failure — a runner with less memory than the developer's laptop — into a known requirement.

## Performance Notes

- **`--network none` costs nothing** and removes a class of non-determinism. Use it unless a stage genuinely needs the network.
- **Baked-in PROJ grids add 200–600 MB** to the image depending on coverage. Include only the grids the project's transformations need.
- **Set `GDAL_NUM_THREADS=1` and `OMP_NUM_THREADS=1`** for reproducibility, and raise them deliberately where a stage is thread-safe and the run does not need to be bit-identical.
- **Volume mounts on Docker Desktop for macOS and Windows are slow.** A 40 GB LAZ read through a bind mount can be several times slower than native; use a named volume or run in a Linux VM for large jobs.
- **`--memory-swap` equal to `--memory`** turns slow death into fast failure.
- **Pull the image once in CI** and reuse it across steps; the layer cache makes subsequent runs instant.

## Common Errors

**Exit code 137.** The container's memory limit, not a pipeline error. Raise `--memory` or stream the pipeline in chunks.

**Output files owned by root.** `--user` missing.

**"unable to open" a file that exists.** A host path in the pipeline JSON. Rewrite paths to `/work/...`.

**Heights differ from a previous run by decimetres.** A PROJ grid is missing and the fallback path was used. Assert the grids in CI.

**`PROJ: Cannot find proj.db`.** `PROJ_DATA` pointing at a directory that does not contain it, usually after overriding the environment variable in `docker run`.

**Results differ between the laptop and CI with the same tag.** The tag was rebuilt. Pin by digest.

**The container is very slow reading input on macOS.** Bind-mount performance. Copy into the container or use a volume.

**`cs2cs` not found.** Some PDAL images ship PROJ without the command-line tools; use `pdal translate` with a reprojection filter for the regression check instead.

## Frequently Asked Questions

### Should I build my own image or use the official one?

Use the official image as a base and add the grids and a non-root user on top, which is what the Dockerfile above does. Building PDAL from source is a maintenance commitment with little benefit unless a plugin requires it.

### Is Podman equivalent?

Yes for this purpose, and its rootless mode removes the ownership problem entirely. The flags are the same; `--userns=keep-id` replaces `--user`.

### How do I handle a pipeline that needs 200 GB of input?

Do not bind-mount it through a slow filesystem layer. Run the container on the machine that holds the data, with a native mount, and shard the work — the checkpointing approach in [resuming failed tiling runs from checkpoints](https://www.3d-geospatial.com/lod-management-optimization-strategies/3d-tiles-batch-tiling-pipelines/resuming-failed-tiling-runs-from-checkpoints/) applies directly.

## Related Guides

- [Testing Spatial Pipelines with pytest Fixtures](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/testing-spatial-pipelines-with-pytest-fixtures/) — the test suite this runs
- [Cropping Point Clouds to Polygons with PDAL](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/cropping-point-clouds-to-polygons-with-pdal/) — a pipeline worth containerising
- [Handling Vertical Datums and Geoid Separation](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/handling-vertical-datums-and-geoid-separation/) — why the PROJ grids matter

Back to [CI/CD Automation for Spatial Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/).
