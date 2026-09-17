# Running OpenDroneMap in Docker for City Blocks

This page runs OpenDroneMap in Docker over a city block or a district — laying out the project so a run is reproducible, screening blurred images before committing compute, choosing quality settings that match the ground sampling distance, using split-merge when the dataset outgrows one machine, and verifying the outputs' CRS and point counts against EPSG:25832+7837.

## Why you hit this

A photogrammetry run is hours of compute that either produces twin-ready geometry or a plausible-looking failure, and the difference is decided by inputs and settings before it starts. Running the container by hand also makes the result irreproducible: nobody remembers which flags produced last quarter's mesh. Putting the whole invocation in code, with the screening and verification around it, turns the run into a pipeline stage that can be repeated when the imagery is reflown. The theory it rests on is in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).

## Prerequisites

- Docker with the `opendronemap/odm` image pulled, and enough RAM for the dataset: roughly 1 GB per 10 images at high quality, so 32 GB for 300 images.
- Python 3.10+ with `numpy>=1.24`, `pillow>=10`, `laspy>=2.5`, `rasterio>=1.3`.
- Imagery in one folder, one camera model, with EXIF positions; a `gcp_list.txt` if control points are used.
- Local SSD for the project directory. Photogrammetry writes tens of gigabytes of intermediates and a network share will dominate the run time.

## Step-by-Step

### 1. Lay the project out the way the container expects

```python
from pathlib import Path
import shutil

PROJECT = Path("/data/odm/block_09")
(PROJECT / "images").mkdir(parents=True, exist_ok=True)

for src in sorted(Path("/deliveries/flight_2026_09/images").glob("*.JPG")):
    dst = PROJECT / "images" / src.name
    if not dst.exists():
        shutil.copy2(src, dst)

shutil.copy2("/deliveries/flight_2026_09/gcp_list.txt", PROJECT / "gcp_list.txt")
print(f"{len(list((PROJECT / 'images').glob('*.JPG')))} images staged in {PROJECT}")
```

The container takes a *datasets* directory and a project name inside it, so the mount point and the project name have to agree — this is the single most common reason a run reports "no images found". Copying rather than symlinking matters too: a symlink into a path that is not mounted inside the container resolves to nothing.

### 2. Screen for blur and exposure before spending the compute

```python
import numpy as np
from PIL import Image

def sharpness(path, max_side=1200):
    img = Image.open(path).convert("L")
    img.thumbnail((max_side, max_side))
    a = np.asarray(img, dtype=np.float64)
    # Laplacian via a 4-neighbour kernel, variance as the focus measure
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:])
    return float(lap.var()), float(a.mean())

scores = {p.name: sharpness(p) for p in sorted((PROJECT / "images").glob("*.JPG"))}
vals = np.array([s for s, _ in scores.values()])
threshold = np.percentile(vals, 5)
suspect = [n for n, (s, m) in scores.items() if s < threshold or m < 40 or m > 215]
print(f"sharpness: median {np.median(vals):.0f}, p5 {threshold:.0f}")
print(f"{len(suspect)} images flagged: {suspect[:8]}")
```

The threshold is relative to the dataset, not absolute: a sharpness score depends on the scene's texture as much as on focus, so the fifth percentile of this flight is a far better cut-off than a number carried over from another project. Flagged images go to a human, because a genuinely blurred image should be removed while an image of a featureless roof scores low and is fine.

<figure class="diagram">
<svg viewBox="46 16 668 230" role="img" aria-labelledby="odm-blur-t odm-blur-d" xmlns="http://www.w3.org/2000/svg">
  <title id="odm-blur-t">Sharpness distribution and the review cut-off</title>
  <desc id="odm-blur-d">A histogram of Laplacian-variance sharpness scores across a flight. Most images cluster in a broad peak. A small tail at low scores contains genuinely blurred images from a turn and a few featureless roof shots. The fifth percentile marks the review cut-off, and the flagged images are inspected rather than deleted automatically.</desc>
  <rect class="svg-bg" x="46" y="16" width="668" height="230" fill="#ffffff"/>
  <path d="M60 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.2">
    <rect x="80" y="166" width="40" height="14"/>
    <rect x="125" y="150" width="40" height="30"/>
    <rect x="170" y="120" width="40" height="60"/>
    <rect x="215" y="70" width="40" height="110"/>
    <rect x="260" y="48" width="40" height="132"/>
    <rect x="305" y="60" width="40" height="120"/>
    <rect x="350" y="90" width="40" height="90"/>
    <rect x="395" y="120" width="40" height="60"/>
    <rect x="440" y="150" width="40" height="30"/>
  </g>
  <path d="M168 30 V180" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <text x="160" y="46" fill="#b0413e" font-size="12.5" text-anchor="end">p5: review these</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="100" y="200">low</text><text x="280" y="200">median</text><text x="460" y="200">high</text>
  </g>
  <text x="380" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">Laplacian variance per image — relative to this flight, never an absolute threshold</text>
</svg>
<figcaption>Screening is a triage step, not a filter: the tail contains both blurred frames and legitimately flat scenes, and only a person can tell them apart quickly.</figcaption>
</figure>

### 3. Run the container with explicit settings

```python
import subprocess

def run_odm(project_root, project_name, extra=()):
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{project_root}:/datasets",
        "opendronemap/odm",
        "--project-path", "/datasets", project_name,
        "--feature-quality", "high",
        "--pc-quality", "high",
        "--pc-las",
        "--dsm", "--dtm",
        "--orthophoto-resolution", "2",      # cm per pixel
        "--gcp", f"/datasets/{project_name}/gcp_list.txt",
        "--use-3dmesh",                      # a full 3D mesh, not a 2.5D surface
        "--mesh-size", "300000",
        "--max-concurrency", "14",
        *extra,
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)

run_odm("/data/odm", "block_09")
```

Four of those flags decide the character of the output. `--pc-quality high` sets the dense-matching resolution, which is the main compute-versus-detail dial. `--use-3dmesh` produces a true 3D surface rather than a 2.5D height field, which is essential when facades matter and unnecessary for bare terrain. `--orthophoto-resolution` should be close to the GSD — asking for 1 cm from a 2 cm GSD flight invents nothing and doubles the file. `--mesh-size` caps triangles before any decimation the twin pipeline applies later.

For iteration, `--rerun-from` restarts at a named stage instead of from scratch: `--rerun-from odm_meshing` after changing mesh settings saves the hours of dense matching.

### 4. Split large areas into submodels

A district that will not fit in memory is processed as overlapping submodels and merged.

```python
run_odm("/data/odm", "district_north", extra=(
    "--split", "400",            # target images per submodel
    "--split-overlap", "120",    # metres of overlap between submodels
))
```

Split-merge reconstructs each submodel independently, aligns them using the overlap and the control points, and merges the point clouds, orthophotos and surface models. The overlap has to be generous enough to contain shared control points and plenty of common texture; 100–150 m works for typical urban flights at 80–120 m altitude. Too small an overlap produces visible steps between submodels in both geometry and colour.

<figure class="diagram">
<svg viewBox="26 16 701 242" role="img" aria-labelledby="odm-split-t odm-split-d" xmlns="http://www.w3.org/2000/svg">
  <title id="odm-split-t">Split-merge submodels with overlap</title>
  <desc id="odm-split-d">A district divided into four submodels that overlap by about 120 metres. Control points fall inside the overlap zones so neighbouring submodels share constraints and align. Without overlap, each submodel is georeferenced on its own and steps appear at the seams in both geometry and colour.</desc>
  <rect class="svg-bg" x="26" y="16" width="701" height="242" fill="#ffffff"/>
  <rect x="40" y="30" width="300" height="140" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2" fill-opacity="0.6"/>
  <rect x="250" y="30" width="300" height="140" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2" fill-opacity="0.6"/>
  <rect x="40" y="110" width="300" height="120" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2" fill-opacity="0.6"/>
  <rect x="250" y="110" width="300" height="120" fill="#f7dfdc" stroke="#b0413e" stroke-width="2" fill-opacity="0.6"/>
  <g fill="#1f2937">
    <circle cx="295" cy="90" r="6"/><circle cx="295" cy="170" r="6"/><circle cx="150" cy="140" r="6"/><circle cx="450" cy="140" r="6"/><circle cx="295" cy="130" r="6"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="120" y="60">submodel A</text>
    <text x="480" y="60">submodel B</text>
    <text x="120" y="212">submodel C</text>
    <text x="480" y="212">submodel D</text>
  </g>
  <text x="600" y="98" fill="#15384a" font-size="12.5" text-anchor="start">control points sit in</text>
  <text x="600" y="116" fill="#15384a" font-size="12.5" text-anchor="start">the overlap, so</text>
  <text x="600" y="134" fill="#15384a" font-size="12.5" text-anchor="start">submodels share</text>
  <text x="600" y="152" fill="#15384a" font-size="12.5" text-anchor="start">constraints</text>
  <text x="295" y="240" fill="#15384a" font-size="12.5" text-anchor="middle">overlap ≈ 120 m</text>
</svg>
<figcaption>Overlap is what lets the merge align submodels. Control points placed inside the overlap constrain both sides of every seam.</figcaption>
</figure>

### 5. Verify the outputs before accepting the run

```python
import json
import laspy
import rasterio

OUT = PROJECT
expected = {
    "cloud": OUT / "odm_georeferencing" / "odm_georeferenced_model.laz",
    "mesh": OUT / "odm_texturing" / "odm_textured_model_geo.obj",
    "ortho": OUT / "odm_orthophoto" / "odm_orthophoto.tif",
    "dsm": OUT / "odm_dem" / "dsm.tif",
    "dtm": OUT / "odm_dem" / "dtm.tif",
}
missing = {k: str(p) for k, p in expected.items() if not p.exists()}
assert not missing, f"run did not produce: {missing}"

with laspy.open(expected["cloud"]) as f:
    h = f.header
    crs = h.parse_crs()
    print(f"cloud: {h.point_count:,} points, CRS {crs.to_epsg() if crs else None}, "
          f"z range {h.mins[2]:.1f}–{h.maxs[2]:.1f} m")

with rasterio.open(expected["ortho"]) as o:
    print(f"ortho: {o.width}×{o.height}, {o.res[0] * 100:.1f} cm/px, CRS {o.crs.to_epsg()}")

stats_path = OUT / "opensfm" / "stats" / "stats.json"
if stats_path.exists():
    stats = json.loads(stats_path.read_text())
    recon = stats.get("reconstruction_statistics", {})
    print(f"images reconstructed: {recon.get('reconstructed_images')} of {recon.get('initial_shots')}, "
          f"mean reprojection error {recon.get('reprojection_error_normalized', 'n/a')}")
```

Asserting the outputs exist is not pedantry: OpenDroneMap completes with a zero exit status after skipping stages whose inputs were missing, so a run that produced no DSM looks successful from the outside. The point count, the CRS and the z range together catch the georeferencing failures — an unset CRS, or ellipsoidal heights where orthometric were expected.

## Expected Output & Verification

```text
412 images staged in /data/odm/block_09
sharpness: median 1184, p5 402
19 images flagged: ['DJI_0207.JPG', 'DJI_0208.JPG', 'DJI_0209.JPG', 'DJI_0341.JPG']
cloud: 78,412,006 points, CRS 25832, z range 498.2–556.4 m
ortho: 18420×14904, 2.0 cm/px, CRS 25832
images reconstructed: 412 of 412, mean reprojection error 0.42
```

Three of those lines are the acceptance test. Every image reconstructed means no region was dropped. A reprojection error under about 1.5 px means the solution is internally consistent. And the z range has to match the site: a 58 m spread over a block with 20 m buildings on flat ground means either noise above the site — birds, or matched cloud — or a control point with a typo in its height.

Then check accuracy against the points held back from the adjustment:

```python
import numpy as np
from pyproj import Transformer

check = np.loadtxt("check_points.csv", delimiter=",", skiprows=1)      # E, N, H in EPSG:25832+7837
with rasterio.open(expected["dsm"]) as dsm:
    sampled = np.array([v[0] for v in dsm.sample(check[:, :2])])
resid = sampled - check[:, 2]
print(f"vertical residuals at check points (m): {np.round(resid, 3)}")
print(f"RMSEz {np.sqrt(np.mean(resid ** 2)):.3f} m")
```

<figure class="diagram">
<svg viewBox="26 26 672 208" role="img" aria-labelledby="odm-qual-t odm-qual-d" xmlns="http://www.w3.org/2000/svg">
  <title id="odm-qual-t">Quality settings against run time and point count</title>
  <desc id="odm-qual-d">Bars comparing three point cloud quality settings for the same 412 images. Medium takes about 1.4 hours and yields 21 million points. High takes about 3.2 hours and yields 78 million. Ultra takes about 9 hours and yields 214 million, most of which is decimated away before the data reaches a viewer.</desc>
  <rect class="svg-bg" x="26" y="26" width="672" height="208" fill="#ffffff"/>
  <path d="M40 30 V180" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="40" y="40" width="80" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="40" y="90" width="190" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="140" width="530" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="132" y="62">medium · 1.4 h · 21 M points</text>
    <text x="242" y="112">high · 3.2 h · 78 M points</text>
    <text x="582" y="162">ultra · 9 h · 214 M</text>
  </g>
  <text x="380" y="216" fill="#15384a" font-size="12.5" text-anchor="middle">Run time for 412 images at 2 cm GSD; detail beyond the GSD is noise, not information.</text>
</svg>
<figcaption>Quality settings above what the ground sampling distance supports buy points, not detail, and every extra point is decimated away downstream.</figcaption>
</figure>

## Performance Notes

- **Dense matching dominates** and scales with pixels. Halving the working resolution roughly quarters its cost, which is what the quality settings do internally.
- **`--max-concurrency` should leave headroom.** Setting it to the core count starves the process that feeds workers and can push a machine into swap, which is far slower than a lower concurrency.
- **Keep intermediates on local NVMe.** A run writes and re-reads tens of gigabytes; network storage can double the wall clock.
- **Use `--rerun-from`** while tuning meshing or texturing, and only re-run from scratch when matching settings change.
- **Split-merge is for memory, not speed.** It adds alignment work, so use it when a single model will not fit rather than as a default.

## Common Errors

**`No images found` although the folder is full.** The mount point and `--project-path` disagree, or the images are one directory deeper than the container expects. The layout is `<mounted>/<project>/images`.

**The run stops after the sparse reconstruction.** Not enough memory for dense matching; the container is killed by the OOM killer and the exit status can still be zero in some configurations. Check `dmesg` and reduce quality or split.

**The orthophoto has holes over water.** Expected: water has no stable features. Mask water bodies from the imagery, or accept the holes and fill them from another source.

**The mesh has a smooth lump where a building should be.** Insufficient oblique coverage on that facade, so MVS had only near-nadir views. Re-fly with a 45° pass; no setting recovers geometry that was never observed.

**Outputs are in the wrong place after a split-merge run.** Merged products live in the parent project directory while submodels keep their own; scripts that hard-code the single-model paths silently read a submodel. Resolve output paths after checking whether `submodels/` exists.

## Frequently Asked Questions

### Should I use the ODM container or a native install?

The container, for reproducibility: the toolchain has many native dependencies, and pinning an image digest makes a run repeatable a year later. Pin the digest rather than `latest`, and record it with the outputs.

### How do I process repeat flights of the same site consistently?

Same container digest, same settings, same control points, and the same target CRS — then differences between epochs are real change rather than processing change. That is the precondition for [change detection between LiDAR scan epochs](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/change-detection-between-scan-epochs/) working on photogrammetric data.

### Can the textured mesh go straight into 3D Tiles?

It has to be decimated and re-textured for streaming first — a full-resolution photogrammetric mesh is hundreds of millions of triangles and gigabytes of texture. The path is decimation, atlas packing and tiling, in that order.

## Related Guides

- [Preparing Ground Control Point Files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/) — the file this run consumes
- [Reading Photogrammetry Quality Reports](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/reading-photogrammetry-quality-reports/) — interpreting `stats.json` in depth
- [Fusing LiDAR and Photogrammetry Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/fusing-lidar-and-photogrammetry-point-clouds/) — what to do with the output alongside LiDAR

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
