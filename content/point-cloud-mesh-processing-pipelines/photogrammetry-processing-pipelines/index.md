# Photogrammetry Processing Pipelines

Photogrammetry is how most digital twins get their surface detail. A drone flight over a site produces a few hundred images; a processing run turns them into a dense point cloud, a surface mesh, an orthophoto and a digital surface model, all of it georeferenced well enough to sit alongside survey data. It is also the part of a twin pipeline where the output looks convincing while being wrong: a reconstruction with perfect internal consistency can be domed by half a metre, tilted by a decimetre across a site, or sharp everywhere except the one facade that mattered. This guide covers the pipeline end to end — planning overlap and ground sampling distance, running OpenDroneMap or COLMAP, georeferencing with ground control points, reading the quality report that tells you whether to trust the result, and fusing the output with LiDAR where both exist.

It is written for engineers who own the path from imagery to twin geometry and who will hand the result to the processing chain in [point cloud and mesh processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/). Coordinates are in EPSG:25832 with DHHN2016 heights (compound EPSG:25832+7837) unless stated otherwise.

## Prerequisites

- **OpenDroneMap** (the `opendronemap/odm` container) or **COLMAP 3.9+** with a CUDA GPU for dense reconstruction; `docker` for reproducible runs.
- **Python 3.10+** with `pyproj>=3.6`, `numpy>=1.24`, `laspy>=2.5`, `rasterio>=1.3`, `open3d>=0.18`, `pillow>=10` and `exifread>=3.0`.
- **Imagery with consistent EXIF**: camera model, focal length, and either RTK positions or approximate GNSS positions. Mixed cameras in one dataset need separate calibration groups.
- **Ground control**: at least five well-distributed control points and three independent check points, surveyed in the target compound CRS. RTK-tagged imagery reduces but does not remove the need for check points.
- **Disk and memory**: budget roughly 10–20 GB of working space per hundred 20 MP images, and 32 GB of RAM for a few hundred images at high quality settings.

## Concept

Structure from motion (SfM) estimates where each camera was and what its interior geometry is, by matching features across overlapping images and solving a bundle adjustment that minimises reprojection error. The output is a sparse point cloud and a set of camera poses. Multi-view stereo (MVS) then densifies that: for every pixel in every image, it searches along the epipolar line in neighbouring images for the depth that best matches, producing a depth map per image, which are fused into a dense cloud. Meshing and texturing follow.

Two numbers govern everything upstream of that. **Ground sampling distance** is the size of one pixel on the ground, `GSD = sensor_pixel_pitch × altitude / focal_length`, and it sets the finest detail the reconstruction can contain — a 2 cm GSD cannot resolve a 1 cm crack whatever the processing settings. **Overlap** is how much of each image is seen by its neighbours; below about 70% forward and 60% side overlap, feature matching degrades, and the failure is not graceful: whole regions drop out or reconstruct with the wrong geometry.

<figure class="diagram">
<svg viewBox="-4 16 768 258" role="img" aria-labelledby="pg-arch-t pg-arch-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-arch-t">The photogrammetry pipeline and what each stage produces</title>
  <desc id="pg-arch-d">Imagery with EXIF positions enters feature extraction and matching, then bundle adjustment produces camera poses and a sparse cloud. Ground control points are introduced at bundle adjustment to georeference the solution. Multi-view stereo densifies to a point cloud, which is meshed and textured, and rasterised into a surface model and an orthophoto. Check points validate the georeferencing at the end.</desc>
  <rect class="svg-bg" x="-4" y="16" width="768" height="258" fill="#ffffff"/>
  <defs>
    <marker id="pg-arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="80" width="110" height="60" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="80" width="120" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="300" y="80" width="130" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="460" y="80" width="120" height="60" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="610" y="30" width="140" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="610" y="96" width="140" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="610" y="162" width="140" height="52" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="150" y="210" width="280" height="50" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#pg-arch-arrow)">
    <path d="M120 110 H148"/><path d="M270 110 H298"/><path d="M430 110 H458"/>
    <path d="M580 100 L608 62"/><path d="M580 115 H608"/><path d="M580 128 L608 176"/>
    <path d="M290 208 V142"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="105">imagery</text><text x="65" y="123">+ EXIF</text>
    <text x="210" y="105">features and</text><text x="210" y="123">matching</text>
    <text x="365" y="105">bundle</text><text x="365" y="123">adjustment</text>
    <text x="520" y="105">MVS dense</text><text x="520" y="123">cloud</text>
    <text x="680" y="52">textured mesh</text><text x="680" y="70">for the twin</text>
    <text x="680" y="118">DSM / DTM</text><text x="680" y="136">rasters</text>
    <text x="680" y="184">orthophoto</text><text x="680" y="202">for colour</text>
    <text x="290" y="232">ground control points</text><text x="290" y="250">enter here, not after</text>
  </g>
</svg>
<figcaption>Control points belong in the bundle adjustment. Applying a transformation to a finished cloud fixes its position and leaves its internal deformation untouched.</figcaption>
</figure>

**Key Practice:** Compute the GSD before the flight and record it with the dataset. Every downstream tolerance — the decimation error budget, the texture resolution, the change-detection level of detection — is bounded by it, and a project that cannot state its GSD cannot state its accuracy.

## Flight and Image Quality

Bad input cannot be processed into good output, and the checks are cheap enough to run on every dataset before committing hours of compute.

```python
import exifread
from pathlib import Path

def image_report(folder):
    rows = []
    for p in sorted(Path(folder).glob("*.JPG")):
        with open(p, "rb") as f:
            tags = exifread.process_file(f, details=False)
        rows.append({
            "name": p.name,
            "camera": f"{tags.get('Image Make')} {tags.get('Image Model')}".strip(),
            "focal_mm": float(str(tags.get("EXIF FocalLength", "0")).split("/")[0]) or None,
            "has_gps": "GPS GPSLatitude" in tags,
            "iso": str(tags.get("EXIF ISOSpeedRatings", "")),
            "exposure": str(tags.get("EXIF ExposureTime", "")),
        })
    return rows

rows = image_report("flight_2026_09/images")
cameras = {r["camera"] for r in rows}
print(f"{len(rows)} images, cameras {cameras}, without GPS: {sum(not r['has_gps'] for r in rows)}")
assert len(cameras) == 1, "mixed cameras need separate calibration groups in the run configuration"
```

**Key Practice:** Reject blurred images before processing, not after. A Laplacian-variance sharpness score over every image, with the worst few percent flagged for review, takes a minute and prevents the characteristic failure where one blurred pass leaves a smeared region that looks like a modelling artefact. The full procedure, including the threshold calibration, is in [running OpenDroneMap in Docker for city blocks](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/).

## Georeferencing

There are three ways to place a reconstruction, and they are not equivalent. **GNSS from EXIF** gives metre-level absolute accuracy and no control over deformation. **RTK positions** give centimetre-level camera positions, which is excellent, and still leave the vertical scale sensitive to camera calibration. **Ground control points** constrain the solution inside the bundle adjustment, which is the only mechanism that removes systematic deformation such as doming.

The `gcp_list.txt` format OpenDroneMap uses is a text file whose first line is the target CRS as a PROJ string or EPSG code, followed by one row per image observation:

```text
EPSG:25832+7837
691204.412 5335818.221 519.310 2104 1436 DJI_0123.JPG gcp_A
691204.412 5335818.221 519.310 1876 2210 DJI_0124.JPG gcp_A
691286.901 5335836.978 519.290 980 1502 DJI_0141.JPG gcp_B
```

Each control point needs at least three observations in different images, and five points spread to the corners and centre of the site constrain scale, rotation and the low-order deformation modes. The details, including how to mark the observations reproducibly, are in [preparing ground control point files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/).

**Key Practice:** Hold back at least three surveyed points as check points, never used in the adjustment, and report the residuals at those points as the project's accuracy. Residuals at control points measure how well the solver fitted its constraints, which is not the same thing and is always optimistic.

<figure class="diagram">
<svg viewBox="26 14 693 248" role="img" aria-labelledby="pg-dome-t pg-dome-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-dome-t">Doming, and what removes it</title>
  <desc id="pg-dome-d">A flat site reconstructed from nadir-only imagery with self-calibration bows upward in the middle by tens of centimetres, because the focal length and the surface shape trade off against each other. Adding oblique images or ground control points across the site removes the trade-off and flattens the reconstruction.</desc>
  <rect class="svg-bg" x="26" y="14" width="693" height="248" fill="#ffffff"/>
  <path d="M40 180 H350" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M40 180 C120 120 260 120 350 180" fill="none" stroke="#b0413e" stroke-width="2.5"/>
  <g fill="#1f2937">
    <circle cx="60" cy="60" r="5"/><circle cx="120" cy="60" r="5"/><circle cx="180" cy="60" r="5"/><circle cx="240" cy="60" r="5"/><circle cx="300" cy="60" r="5"/>
  </g>
  <g stroke="#5b6471" stroke-width="1" fill="none" stroke-dasharray="4 4">
    <path d="M60 66 V150"/><path d="M180 66 V126"/><path d="M300 66 V150"/>
  </g>
  <text x="195" y="42" fill="#1f2937" font-size="12.5" text-anchor="middle">nadir images only</text>
  <text x="195" y="212" fill="#b0413e" font-size="12.5" text-anchor="middle">reconstruction bows up 30 cm</text>
  <path d="M410 180 H720" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M410 178 H720" fill="none" stroke="#1f6b8a" stroke-width="2.5" stroke-dasharray="7 4"/>
  <g fill="#1f2937">
    <circle cx="430" cy="60" r="5"/><circle cx="490" cy="60" r="5"/><circle cx="550" cy="60" r="5"/><circle cx="610" cy="60" r="5"/><circle cx="670" cy="60" r="5"/>
    <circle cx="420" cy="100" r="5"/><circle cx="700" cy="100" r="5"/>
  </g>
  <g fill="#4f7a4d">
    <circle cx="450" cy="180" r="6"/><circle cx="560" cy="180" r="6"/><circle cx="680" cy="180" r="6"/>
  </g>
  <text x="565" y="42" fill="#1f2937" font-size="12.5" text-anchor="middle">plus obliques and control points</text>
  <text x="565" y="212" fill="#1f6b8a" font-size="12.5" text-anchor="middle">flat, within a few centimetres</text>
  <text x="380" y="244" fill="#15384a" font-size="12.5" text-anchor="middle">Doming is a calibration ambiguity, not a noise problem, so more images at the same angle do not fix it.</text>
</svg>
<figcaption>Nadir-only flights leave focal length and surface curvature indistinguishable. Obliques or spread control points break the ambiguity.</figcaption>
</figure>

## Reading the Quality Report

Every processing run produces statistics, and four numbers decide whether the output is usable.

**Reprojection error** (typically 0.3–1.0 px) is how well the solved geometry explains the feature observations. Above about 1.5 px, something is wrong with matching or calibration. It is an internal consistency measure and says nothing about absolute accuracy.

**Reconstructed images** should be all of them. A run that reconstructs 412 of 460 images has dropped a region, and the missing images are almost always contiguous — one leg of the flight, or the images over water.

**Points per image and matched features** show where matching struggled. Uniform values across the dataset are healthy; a run where a third of the images have a tenth of the matches has a texture-poor or blurred region.

**Check-point residuals** are the accuracy. For a 2 cm GSD flight with good control, expect 1–3 cm horizontally and 2–5 cm vertically; vertical is always worse, by roughly a factor of two.

**Key Practice:** Store the report with the outputs and put its four numbers in the dataset's metadata. Six months later, when a measurement is disputed, the question is always "how good was that reconstruction" and the answer has to be retrievable without re-running anything. The parsing is covered in [reading photogrammetry quality reports](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/reading-photogrammetry-quality-reports/).

## Cross-Section Integration

Photogrammetric output enters the rest of the twin in three places, and each has a contract.

- **To point cloud processing.** The dense cloud is noisier than LiDAR and has no returns through vegetation, so the filtering and classification in [point cloud filtering techniques](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/point-cloud-filtering-techniques/) need different parameters than for LiDAR — a larger statistical outlier neighbourhood, and ground classification that does not assume penetration under canopy.
- **To meshing.** Photogrammetric clouds are dense and locally smooth, which suits Poisson reconstruction, while their sharp discontinuities at facades suit ball pivoting; the trade-off is in [ball pivoting reconstruction for building facades](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/surface-reconstruction-algorithms/ball-pivoting-reconstruction-for-building-facades/).
- **To LOD and tiling.** The textured mesh is already the highest LOD of a tileset, and its texture is usually the largest asset in the twin. Atlas packing and compression, from [atlas packing and KTX2 Basis compression](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/atlas-packing-and-ktx2-basis-compression/), decide whether it streams.

Where LiDAR also exists, the two are complementary rather than competing: LiDAR gives reliable ground under vegetation and accurate absolute geometry, photogrammetry gives colour and facade detail. Fusing them is a registration problem with a bias question attached, covered in [fusing LiDAR and photogrammetry point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/fusing-lidar-and-photogrammetry-point-clouds/).

**Key Practice:** Record the vertical CRS of the photogrammetric output explicitly. OpenDroneMap georeferences to the CRS given in the control file, and if that file declared only a horizontal system, the heights are whatever the GNSS produced — usually ellipsoidal — while every LiDAR dataset it will be compared against is orthometric.

<figure class="diagram">
<svg viewBox="6 6 748 242" role="img" aria-labelledby="pg-fuse-t pg-fuse-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pg-fuse-t">What each source contributes</title>
  <desc id="pg-fuse-d">A comparison of LiDAR and photogrammetry across five properties. LiDAR penetrates vegetation, gives reliable bare-earth ground, has good absolute accuracy and no colour. Photogrammetry gives dense colour and facade detail, no vegetation penetration, and accuracy that depends on control. Fusing them uses LiDAR for ground and photogrammetry for surfaces and colour.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="242" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="220" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="490" y="20" width="250" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="220" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="56" width="250" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="490" y="56" width="250" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="92" width="220" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="92" width="250" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="490" y="92" width="250" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="20" y="128" width="220" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="128" width="250" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="490" y="128" width="250" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="164" width="220" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="164" width="250" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="490" y="164" width="250" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="43">property</text>
    <text x="365" y="43">LiDAR</text>
    <text x="615" y="43">photogrammetry</text>
    <text x="130" y="79">vegetation penetration</text><text x="365" y="79">yes</text><text x="615" y="79">none</text>
    <text x="130" y="115">bare-earth ground</text><text x="365" y="115">reliable</text><text x="615" y="115">canopy surface only</text>
    <text x="130" y="151">colour</text><text x="365" y="151">intensity only</text><text x="615" y="151">true colour</text>
    <text x="130" y="187">facade detail</text><text x="365" y="187">sparse from the air</text><text x="615" y="187">dense with obliques</text>
  </g>
  <text x="380" y="230" fill="#15384a" font-size="12.5" text-anchor="middle">Fusion takes ground from LiDAR and surfaces and colour from photogrammetry.</text>
</svg>
<figcaption>Neither source is better; they fail in opposite places, which is exactly why fusing them is worth the registration work.</figcaption>
</figure>

## Planning a Capture That Reconstructs Well

Most of a reconstruction's quality is decided before the drone takes off, and the decisions are arithmetic rather than judgement.

**Altitude follows from the GSD you need.** Work backwards: a 2 cm GSD with a 24 mm-equivalent lens and a 20 MP sensor puts the aircraft around 90 m. Flying lower gives a finer GSD, more images and a quadratic increase in processing time, so pick the coarsest GSD that resolves the smallest feature the twin has to show — typically three to five pixels across it.

**Overlap follows from the terrain and the subject.** Flat open ground reconstructs from 70% forward and 60% side overlap. Dense urban fabric needs more, because tall buildings occlude the ground between them and a point seen in only two images is poorly determined; 80% and 70% is the usual urban setting. Where the flight plan specifies overlap at a nominal altitude, remember the actual overlap falls over higher ground — a hill 30 m above the reference plane loses a third of the planned overlap.

**Facades need their own passes.** Nadir imagery sees roofs and the tops of walls. Any twin that will be viewed from street level needs oblique passes at 30–45°, flown around the blocks rather than across them, and ideally in two directions so no facade is only seen at a grazing angle. That typically doubles the image count and is the difference between buildings that look like buildings and blocks with smeared sides.

**Lighting decides the texture.** Thin high cloud is ideal: it gives even illumination with no hard shadows. Direct low sun bakes long shadows into the texture, which then look wrong at every other time of day and hide detail in the shadowed facades. Avoid flying across the solar noon when a site has deep courtyards, since a courtyard that is black in every image reconstructs as nothing.

**Key Practice:** Record the planned and the flown parameters — altitude, overlap, GSD, sun angle, cloud — in the dataset's metadata. When a reconstruction disappoints, the first question is which of them differed from the plan, and without the record the investigation starts with guesswork.

## Production Checklist

- [ ] GSD computed from altitude, focal length and pixel pitch, and recorded with the dataset.
- [ ] Forward overlap ≥ 70% and side overlap ≥ 60% verified from image positions, not from the flight plan.
- [ ] One camera model per calibration group; mixed cameras split.
- [ ] Blurred and over-exposed images flagged and reviewed before processing.
- [ ] At least five control points, well distributed, each observed in three or more images.
- [ ] At least three check points held back from the adjustment.
- [ ] Target CRS stated as a compound code with a vertical datum.
- [ ] Reprojection error under 1.5 px and every image reconstructed.
- [ ] Check-point residuals reported and stored with the outputs.
- [ ] Outputs' CRS asserted programmatically, not assumed from the run configuration.

### Storage and retention

A photogrammetry programme accumulates data faster than any other part of a twin, and deciding early what to keep saves an awkward conversation later. The imagery is the irreplaceable part: everything else can be recomputed from it, given the control points and the processing settings. A project's dense cloud, mesh and orthophoto together are usually two to five times the size of the imagery that produced them, so keeping the derived products forever costs several times as much as keeping the source.

The arrangement that holds up is to archive the imagery, the control file and the processing configuration — the three inputs — in cold storage, keep the current derived products in hot storage, and delete superseded derivatives when a reflight replaces them. That makes a reprocessing run possible years later, when a better algorithm or a corrected control network justifies it, and keeps the working set small.

**Key Practice:** Store the container digest and the full command line with the outputs, not just the settings you remember choosing. A reprocessing run that cannot reproduce the original is a new dataset rather than a correction, and the difference matters when the two are compared for change.

## Troubleshooting Matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Site bows upward in the middle | nadir-only imagery with self-calibration | add obliques, add control points across the site |
| Whole region missing from the reconstruction | insufficient overlap, blur, or water | re-fly the gap; mask water before matching |
| Reconstruction tilts across the site | control points clustered on one side | distribute control to the corners |
| Facades smeared or absent | no oblique coverage | fly a second pass at 45° around the buildings |
| Heights off by tens of metres | ellipsoidal versus orthometric confusion | declare a compound CRS in the control file |
| Duplicated or doubled surfaces | two flights merged without joint adjustment | process together, or register afterwards with ICP |
| Repetitive pattern reconstructed as a wave | matching confused by a regular texture | add control, reduce matching neighbours, mask the area |
| Texture blurry despite a fine GSD | texturing chose distant images | restrict texturing to near-nadir, sharp images |

## Frequently Asked Questions

### OpenDroneMap or COLMAP?

OpenDroneMap for aerial survey work: it handles georeferencing, orthophotos, DSMs and control points as first-class concepts and needs little tuning. COLMAP when the geometry is unusual — terrestrial sequences, indoor work, or a reconstruction that needs specific calibration control — and when you want each stage separately, as in [sparse and dense reconstruction with COLMAP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/sparse-and-dense-reconstruction-with-colmap/).

### Do RTK positions remove the need for ground control?

They remove the need for control to establish *position*, and not the need for check points to establish *accuracy*. RTK camera positions are centimetre-accurate at the antenna, with a lever arm to the sensor and a vertical datum question attached, so a few surveyed points remain the cheapest insurance in the project.

### How much overlap is too much?

Beyond about 85% forward overlap the extra images add processing time and little geometry. The exception is facades and complex structures, where redundancy genuinely helps — but there the answer is more viewing angles, not more images from the same angle.

### Can photogrammetry replace LiDAR for a city twin?

For surfaces and colour, largely yes; for ground under vegetation and for absolute vertical accuracy, no. City programmes that have both use LiDAR as the geometric reference and photogrammetry for appearance.

### How long does a run take?

Rough orders of magnitude on a 16-core machine with a mid-range GPU: 200 images at high quality in one to two hours, 1,000 images in half a day, 10,000 images only with the split-merge workflow and a cluster. Dense reconstruction dominates, and it scales with pixels, not with area.

### What about Gaussian splatting and other radiance-field methods?

They produce striking visualisations from the same imagery and are not yet a substitute for a measured surface: there is no agreed way to validate their geometry against control, and no interchange format a twin pipeline can consume like a mesh. Keep them as a visualisation branch off the same dataset, not as the geometric source.

## Related Guides

- [Running OpenDroneMap in Docker for City Blocks](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/) — a reproducible run and its settings
- [Preparing Ground Control Point Files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/) — the format, the marking and the checks
- [Sparse and Dense Reconstruction with COLMAP](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/sparse-and-dense-reconstruction-with-colmap/) — stage-by-stage control
- [Georeferencing Photogrammetric Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/georeferencing-photogrammetric-point-clouds/) — placing a finished reconstruction
- [Fusing LiDAR and Photogrammetry Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/fusing-lidar-and-photogrammetry-point-clouds/) — using both sources together
- [Reading Photogrammetry Quality Reports](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/reading-photogrammetry-quality-reports/) — the four numbers that matter

Back to [Point Cloud & Mesh Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/).
