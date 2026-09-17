# Sparse and Dense Reconstruction with COLMAP

This page drives COLMAP through a full reconstruction from Python — feature extraction with a shared camera model, a matching strategy chosen for the capture pattern, incremental mapping, undistortion, patch-match stereo and fusion — and reads the resulting statistics to decide whether the sparse model is worth densifying, before the result is georeferenced into EPSG:25832+7837.

## Why you hit this

OpenDroneMap is the right tool for a nadir survey flight. COLMAP is the right tool when the capture is unusual: a terrestrial walk-around of a bridge pier, an interior, a hand-held sequence of a facade, imagery from several cameras, or any case where you need to intervene between stages. Its cost is that nothing is chosen for you — matching strategy, camera model, stereo parameters and fusion thresholds are all explicit, and the defaults are tuned for benchmark datasets rather than for buildings. The pipeline context is in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).

## Prerequisites

- COLMAP 3.9+ with CUDA for dense reconstruction; the CPU path works for sparse but is impractical for stereo.
- Python 3.10+ with `numpy>=1.24`, `open3d>=0.18`, `pycolmap` optional for reading models directly.
- Imagery in one folder. Mixed cameras are supported but need separate camera models, which changes the extraction call.
- Disk: dense stereo writes a depth and normal map per image, typically 20–60 MB each, so 400 images need tens of gigabytes.

## Step-by-Step

### 1. Set up the workspace and extract features

```python
import subprocess
from pathlib import Path

WS = Path("/data/colmap/pier_north")
IMAGES = WS / "images"
DB = WS / "database.db"
SPARSE = WS / "sparse"
DENSE = WS / "dense"
for d in (SPARSE, DENSE):
    d.mkdir(parents=True, exist_ok=True)

def colmap(*args):
    subprocess.run(["colmap", *map(str, args)], check=True)

colmap("feature_extractor",
       "--database_path", DB,
       "--image_path", IMAGES,
       "--ImageReader.single_camera", 1,          # one camera model for the whole set
       "--ImageReader.camera_model", "OPENCV",    # 2 focal lengths + 4 distortion terms
       "--SiftExtraction.max_image_size", 3200,
       "--SiftExtraction.estimate_affine_shape", 1,
       "--SiftExtraction.domain_size_pooling", 1)
```

`single_camera` is the flag that decides whether the solver estimates one interior orientation or one per image. For a single physical camera at a fixed zoom, sharing the model is both more accurate and far more stable; for a dataset of photographs from several phones, sharing it is wrong and produces a warped reconstruction. `OPENCV` is a good default camera model for consumer and drone cameras; a fisheye lens needs `OPENCV_FISHEYE` and a pinhole rig with known calibration can use `PINHOLE` with fixed parameters.

The two SIFT options increase robustness on repetitive and oblique material at a cost in extraction time — worth it for facades, unnecessary for open terrain.

### 2. Match with the strategy the capture pattern implies

```python
n_images = len(list(IMAGES.glob("*.jpg"))) + len(list(IMAGES.glob("*.JPG")))

if n_images < 400:
    colmap("exhaustive_matcher", "--database_path", DB,
           "--SiftMatching.guided_matching", 1)
else:
    # a walked or flown sequence: match each image against its neighbours in capture order
    colmap("sequential_matcher", "--database_path", DB,
           "--SequentialMatching.overlap", 12,
           "--SequentialMatching.loop_detection", 1,
           "--SequentialMatching.vocab_tree_path", "/opt/colmap/vocab_tree_flickr100K_words32K.bin")
print(f"matched {n_images} images")
```

Matching is quadratic in image count, so the strategy is the difference between minutes and days. Exhaustive matching compares every pair and is the most thorough; below a few hundred images it is the right choice. Sequential matching exploits capture order and only compares each image with its neighbours, with loop detection through a vocabulary tree to catch the moment the path returns to where it started — which is what stops a walk around a building from reconstructing as a spiral.

<figure class="diagram">
<svg viewBox="51 21 658 229" role="img" aria-labelledby="cm-match-t cm-match-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cm-match-t">Matching strategies and their cost</title>
  <desc id="cm-match-d">Three matching patterns for twelve images arranged in a loop. Exhaustive matching connects every pair, sixty-six pairs in total. Sequential matching connects each image to its neighbours within an overlap window, about thirty pairs. Sequential matching with loop detection adds the few pairs that close the loop, which is what keeps a walk-around from drifting.</desc>
  <rect class="svg-bg" x="51" y="21" width="658" height="229" fill="#ffffff"/>
  <g stroke="#5b6471" stroke-width="0.7" fill="none">
    <path d="M70 60 L130 40 L190 60 L190 120 L130 140 L70 120 Z"/>
    <path d="M70 60 L190 60 M70 60 L190 120 M70 60 L130 140 M130 40 L190 120 M130 40 L130 140 M130 40 L70 120 M190 60 L130 140 M190 60 L70 120 M190 120 L70 120"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="70" cy="60" r="5"/><circle cx="130" cy="40" r="5"/><circle cx="190" cy="60" r="5"/>
    <circle cx="190" cy="120" r="5"/><circle cx="130" cy="140" r="5"/><circle cx="70" cy="120" r="5"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="1.8" fill="none">
    <path d="M320 60 L380 40 L440 60 L440 120 L380 140 L320 120"/>
  </g>
  <g fill="#1f6b8a">
    <circle cx="320" cy="60" r="5"/><circle cx="380" cy="40" r="5"/><circle cx="440" cy="60" r="5"/>
    <circle cx="440" cy="120" r="5"/><circle cx="380" cy="140" r="5"/><circle cx="320" cy="120" r="5"/>
  </g>
  <g stroke="#4f7a4d" stroke-width="1.8" fill="none">
    <path d="M570 60 L630 40 L690 60 L690 120 L630 140 L570 120"/>
  </g>
  <path d="M570 120 L570 60" fill="none" stroke="#9a4f26" stroke-width="2.2" stroke-dasharray="6 4"/>
  <g fill="#1f6b8a">
    <circle cx="570" cy="60" r="5"/><circle cx="630" cy="40" r="5"/><circle cx="690" cy="60" r="5"/>
    <circle cx="690" cy="120" r="5"/><circle cx="630" cy="140" r="5"/><circle cx="570" cy="120" r="5"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="176">exhaustive</text>
    <text x="380" y="176">sequential</text>
    <text x="630" y="176">sequential + loop</text>
    <text x="130" y="196">every pair · O(n²)</text>
    <text x="380" y="196">neighbours only</text>
    <text x="630" y="196">neighbours + closure</text>
  </g>
  <text x="380" y="232" fill="#15384a" font-size="12.5" text-anchor="middle">Without loop closure, a walk that returns to its start reconstructs as an open spiral.</text>
</svg>
<figcaption>The matching graph is what the bundle adjustment has to work with; a strategy that omits the loop-closing pairs cannot be rescued later.</figcaption>
</figure>

### 3. Map incrementally and read the statistics

```python
colmap("mapper",
       "--database_path", DB,
       "--image_path", IMAGES,
       "--output_path", SPARSE,
       "--Mapper.ba_refine_principal_point", 1,
       "--Mapper.min_num_matches", 30)

models = sorted(p for p in SPARSE.iterdir() if p.is_dir())
print(f"{len(models)} model(s): {[m.name for m in models]}")
out = subprocess.run(["colmap", "model_analyzer", "--path", str(models[0])],
                     capture_output=True, text=True)
print(out.stdout)
```

The mapper can produce more than one model, and that is the most important thing to check before going further. Two models mean the matching graph was disconnected — two sets of images with nothing in common — and densifying either one reconstructs half the subject. The usual cause is a gap in the capture or a matching strategy that missed the connection.

`model_analyzer` reports the number of registered images, the number of points, the mean track length and the mean reprojection error. A mean track length above about three means points are seen in enough images to be well determined; a value near two means the geometry rests on pairs and will be weak.

<figure class="diagram">
<svg viewBox="6 6 748 236" role="img" aria-labelledby="cm-cam-t cm-cam-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cm-cam-t">Camera models and when each is right</title>
  <desc id="cm-cam-d">A table of COLMAP camera models. PINHOLE has four parameters and suits a pre-calibrated rig. SIMPLE_RADIAL has four and suits a well-behaved consumer lens. OPENCV has eight and is the default choice for drone and consumer cameras. OPENCV_FISHEYE suits fisheye lenses. Sharing one model across all images is correct for a single camera and wrong for a mixed set.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="236" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="220" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="120" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="360" y="20" width="380" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="220" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="240" y="54" width="120" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="54" width="380" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="90" width="220" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="240" y="90" width="120" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="90" width="380" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="126" width="220" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="240" y="126" width="120" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="360" y="126" width="380" height="36" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="20" y="162" width="220" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="240" y="162" width="120" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="360" y="162" width="380" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="43">model</text><text x="300" y="43">parameters</text><text x="550" y="43">when it is right</text>
    <text x="130" y="77">PINHOLE</text><text x="300" y="77">4</text><text x="550" y="77">a rig calibrated beforehand, held fixed</text>
    <text x="130" y="113">SIMPLE_RADIAL</text><text x="300" y="113">4</text><text x="550" y="113">a well-behaved consumer lens, few images</text>
    <text x="130" y="149">OPENCV</text><text x="300" y="149">8</text><text x="550" y="149">the default for drone and consumer cameras</text>
    <text x="130" y="185">OPENCV_FISHEYE</text><text x="300" y="185">8</text><text x="550" y="185">fisheye and action cameras</text>
  </g>
  <text x="380" y="224" fill="#15384a" font-size="12.5" text-anchor="middle">More parameters fit better and need more, better-distributed observations to be determined.</text>
</svg>
<figcaption>The model choice is a trade between flexibility and stability; eight parameters on forty images of a flat wall will fit something meaningless.</figcaption>
</figure>

### 4. Undistort, then run patch-match stereo

```python
colmap("image_undistorter",
       "--image_path", IMAGES,
       "--input_path", models[0],
       "--output_path", DENSE,
       "--output_type", "COLMAP",
       "--max_image_size", 2400)

colmap("patch_match_stereo",
       "--workspace_path", DENSE,
       "--workspace_format", "COLMAP",
       "--PatchMatchStereo.geom_consistency", 1,
       "--PatchMatchStereo.filter", 1,
       "--PatchMatchStereo.num_samples", 15,
       "--PatchMatchStereo.window_radius", 5)
```

Undistortion rewrites the images as ideal pinhole views, which is what the stereo stage requires. `max_image_size` here is the dial that dominates dense reconstruction time: halving it quarters the stereo cost, and 2400 px is a sensible compromise for building-scale work whose GSD is a few centimetres.

Geometric consistency makes each depth map agree with its neighbours' before a pixel is kept. It roughly doubles the stereo time and removes most of the speckle that otherwise reaches the fused cloud, which saves more time in filtering later than it costs here.

### 5. Fuse, and control the noise at the fusion stage

```python
colmap("stereo_fusion",
       "--workspace_path", DENSE,
       "--workspace_format", "COLMAP",
       "--input_type", "geometric",
       "--output_path", DENSE / "fused.ply",
       "--StereoFusion.min_num_pixels", 5,
       "--StereoFusion.max_reproj_error", 2.0,
       "--StereoFusion.max_depth_error", 0.01,
       "--StereoFusion.max_normal_error", 10.0)

import open3d as o3d
pcd = o3d.io.read_point_cloud(str(DENSE / "fused.ply"))
print(f"fused cloud: {len(pcd.points):,} points, has normals: {pcd.has_normals()}, "
      f"has colours: {pcd.has_colors()}")
```

`min_num_pixels` is the most effective noise control in the whole pipeline: it requires a 3D point to be supported by that many consistent pixels across images before it is emitted. Raising it from the default to five removes the thin fog of spurious points around every surface, at the cost of thinning genuinely single-view detail such as a narrow railing.

The fused cloud carries colours and normals, which is a real advantage over LiDAR for downstream reconstruction — the normals come from the stereo geometry rather than from an estimation over neighbours, so they are reliable on thin structures where a k-nearest-neighbour estimate struggles.

<figure class="diagram">
<svg viewBox="26 26 633 230" role="img" aria-labelledby="cm-stage-t cm-stage-d" xmlns="http://www.w3.org/2000/svg">
  <title id="cm-stage-t">Where the time goes in a COLMAP run</title>
  <desc id="cm-stage-d">Bars of wall-clock time for 380 images on one GPU. Feature extraction takes about eight minutes, matching about twelve with the sequential strategy, mapping about fourteen, undistortion about three, patch-match stereo about a hundred and ten, and fusion about nine. Dense stereo dominates, and its cost scales with the undistortion image size.</desc>
  <rect class="svg-bg" x="26" y="26" width="633" height="230" fill="#ffffff"/>
  <path d="M40 30 V200" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke-width="1.5">
    <rect x="40" y="40" width="44" height="22" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="70" width="66" height="22" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="100" width="77" height="22" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="130" width="17" height="22" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="40" y="160" width="605" height="22" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="40" y="190" width="50" height="22" fill="#e3f0f4" stroke="#1f6b8a"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="96" y="57">feature extraction · 8 min</text>
    <text x="118" y="87">sequential matching · 12 min</text>
    <text x="129" y="117">mapper · 14 min</text>
    <text x="69" y="147">undistortion · 3 min</text>
    <text x="380" y="177">patch-match stereo · 110 min</text>
    <text x="102" y="207">fusion · 9 min</text>
  </g>
  <text x="380" y="238" fill="#15384a" font-size="12.5" text-anchor="middle">380 images, one GPU, undistorted to 2400 px — halving that size quarters the red bar</text>
</svg>
<figcaption>Every decision that matters for run time is made before stereo starts: matching strategy, undistortion size and whether geometric consistency is enabled.</figcaption>
</figure>

### 6. Hand the result over with a known scale and frame

A COLMAP reconstruction is metrically arbitrary: correct in shape, unknown in scale, position and orientation. Two routes fix that. Either supply known camera positions to the mapper so the bundle adjustment solves in the target frame, or fit a similarity transformation afterwards from control points — which is what [georeferencing photogrammetric point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/georeferencing-photogrammetric-point-clouds/) covers.

```python
colmap("model_aligner",
       "--input_path", models[0],
       "--output_path", SPARSE / "aligned",
       "--ref_images_path", WS / "camera_positions.txt",   # image_name X Y Z per line
       "--ref_is_gps", 0,
       "--alignment_type", "custom",
       "--robust_alignment_max_error", 0.5)
```

`model_aligner` estimates the similarity transformation that best maps the reconstruction's camera positions onto the supplied ones, and writes an aligned model. Passing projected coordinates with `ref_is_gps 0` keeps everything in metres; the robust threshold rejects positions that disagree badly, which is what stops one bad RTK fix from rotating the model.

## Expected Output & Verification

```text
matched 380 images
1 model(s): ['0']
Cameras: 1
Images: 378
Registered images: 378
Points: 214,882
Observations: 1,204,338
Mean track length: 5.6047
Mean observations per image: 3186.08
Mean reprojection error: 0.58431px
fused cloud: 41,204,882 points, has normals: True, has colours: True
```

Read that output as an acceptance test. One model, nearly all images registered, a mean track length above three and a reprojection error under about one pixel is a healthy sparse reconstruction. Two images unregistered out of 380 is normal — usually the first and last frames of a sequence.

Then verify the dense result against something independent:

```python
import numpy as np

pts = np.asarray(pcd.points)
print("extent (model units):", (pts.max(axis=0) - pts.min(axis=0)).round(2))

# after alignment: check a measured distance between two control points
a = np.array([691204.412, 5335818.221, 519.310])
b = np.array([691286.901, 5335836.978, 519.290])
print(f"control distance: {np.linalg.norm(a - b):.3f} m")
```

Comparing a surveyed distance with the same distance in the aligned cloud is the check that catches a scale error, which is the failure mode unique to reconstructions from imagery alone. A 1% scale error is invisible in every visual inspection and fatal for any measurement.

## Performance Notes

- **Undistortion size sets the stereo bill.** It is the first parameter to change when a run does not fit the available time.
- **Stereo is per image and embarrassingly parallel across GPUs**; COLMAP supports multiple GPU indices, and a two-GPU machine halves the dominant stage.
- **Sequential matching for sequences, exhaustive for unordered sets.** Getting this wrong either wastes hours or produces a disconnected model.
- **Cache the database.** Feature extraction and matching results live in `database.db`; re-running the mapper with different settings costs minutes, not hours, as long as that file is kept.
- **Fuse with `min_num_pixels` tuned per subject**: five for buildings, three for thin structures where detail matters more than noise.

## Common Errors

**Two or more sparse models.** The matching graph is disconnected. Add loop-closure matching, or match the two groups explicitly with a custom match list.

**`ERROR: No images with matches found in the database`.** Extraction ran on a different `image_path` than matching, or the images are in a subdirectory. COLMAP's paths are absolute inside the workspace and easy to get subtly wrong.

**Dense stereo runs out of GPU memory.** Reduce `max_image_size` at undistortion, or lower `PatchMatchStereo.window_radius` and `num_samples`. Both reduce quality gracefully rather than failing.

**The reconstruction has correct shape and wrong size.** Expected — imagery alone has no scale. Align with control or with known camera positions.

**Facades reconstruct with holes where windows are.** Glass has no stable features and reflects the sky. That is a capture limitation; fill it in meshing, or model windows as flat surfaces, as in [ball pivoting reconstruction for building facades](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/ball-pivoting-reconstruction-for-building-facades/).

## Frequently Asked Questions

### Can COLMAP use ground control points directly?

Not in the image-observation sense that survey software uses. The practical routes are `model_aligner` with known camera positions, or aligning the finished cloud onto control points with a similarity transformation. For projects where control-in-adjustment matters, use survey-oriented software.

### Is `pycolmap` worth using instead of the CLI?

For reading models and writing analysis, yes — it gives direct access to cameras, images and points without parsing binaries. For running the pipeline, the CLI is what the documentation and the community troubleshoot against.

### How does the fused cloud compare with a LiDAR cloud of the same site?

Denser on textured surfaces, noisier at a few millimetres to centimetres, absent on glass and water, with no penetration through vegetation, and carrying true colour and reliable normals. The two are complementary, which is the subject of [fusing LiDAR and photogrammetry point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/fusing-lidar-and-photogrammetry-point-clouds/).

## Related Guides

- [Running OpenDroneMap in Docker for City Blocks](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/) — the survey-oriented alternative
- [Georeferencing Photogrammetric Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/georeferencing-photogrammetric-point-clouds/) — giving the model scale and a frame
- [Removing Noise from Terrestrial LiDAR Scans](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/removing-noise-from-terrestrial-lidar-scans/) — filtering the fused output

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
