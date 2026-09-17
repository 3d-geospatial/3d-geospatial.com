# Preparing Ground Control Point Files

This page builds and validates the ground control file a photogrammetry run consumes — the CRS header, the image observations, the distribution that actually constrains a solution, the check points held back from it, and the validation that catches a swapped easting, a typo in a height or a point observed in only one image, all against EPSG:25832+7837.

## Why you hit this

Control points are the only mechanism that removes systematic deformation from a reconstruction, and the file that carries them is plain text with no schema. A single transposed digit moves one point by a hundred metres, the solver either rejects it or bends the whole model towards it, and the result looks like a processing problem rather than a data-entry one. Worse, the failure often appears as a small, plausible tilt rather than an obvious break. Validating the file before a six-hour run costs a minute and prevents re-running. The role control plays in the pipeline is set out in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).

## Prerequisites

- Surveyed points in the target compound CRS — EPSG:25832+7837 here — with their survey accuracy recorded.
- The flight's imagery, with EXIF positions, so observations can be checked against where the camera was.
- Python 3.10+ with `numpy>=1.24`, `pyproj>=3.6`, `pillow>=10`, `exifread>=3.0`.
- A marking tool for picking image coordinates: the ODM or WebODM GCP interface, or any viewer that reports pixel coordinates with the origin at the top left.

## Step-by-Step

### 1. Understand the format

```text
EPSG:25832+7837
691204.412 5335818.221 519.310 2104 1436 DJI_0123.JPG gcp_A
691204.412 5335818.221 519.310 1876 2210 DJI_0124.JPG gcp_A
691204.412 5335818.221 519.310 3012 1104 DJI_0125.JPG gcp_A
691286.901 5335836.978 519.290 980 1502 DJI_0141.JPG gcp_B
```

The first line is the coordinate reference system, as an EPSG code or a PROJ string. Every following line is one *observation*: the point's three world coordinates, then its pixel coordinates in one image, then the image name, then an optional label. A point observed in four images appears on four lines with identical world coordinates and different pixel coordinates.

Two conventions cause most of the confusion. World coordinates are easting, northing, height in the declared CRS — not longitude, latitude — and pixel coordinates count from the top-left corner of the image, x to the right and y downward. Some survey exports give northing first, and some marking tools report pixels from the bottom left; both produce a file that parses perfectly and reconstructs wrongly.

### 2. Write the file from a survey table and a marking table

```python
from pathlib import Path
import numpy as np

CRS = "EPSG:25832+7837"

survey = {                      # label → (easting, northing, orthometric height)
    "gcp_A": (691204.412, 5335818.221, 519.310),
    "gcp_B": (691286.901, 5335836.978, 519.290),
    "gcp_C": (691275.305, 5335887.874, 519.330),
    "gcp_D": (691192.799, 5335869.108, 519.300),
    "gcp_E": (691240.118, 5335852.664, 521.045),
}
observations = [                # (label, image, px, py) from the marking session
    ("gcp_A", "DJI_0123.JPG", 2104, 1436),
    ("gcp_A", "DJI_0124.JPG", 1876, 2210),
    ("gcp_A", "DJI_0125.JPG", 3012, 1104),
    ("gcp_B", "DJI_0141.JPG", 980, 1502),
    # …
]

def write_gcp_list(path, crs, survey, observations):
    lines = [crs]
    for label, image, px, py in observations:
        e, n, h = survey[label]
        lines.append(f"{e:.3f} {n:.3f} {h:.3f} {px} {py} {image} {label}")
    Path(path).write_text("\n".join(lines) + "\n")
    return len(lines) - 1

n_obs = write_gcp_list("gcp_list.txt", CRS, survey, observations)
print(f"{n_obs} observations of {len({o[0] for o in observations})} points written")
```

Generating the file from two tables rather than editing it by hand is what keeps the world coordinates consistent across a point's observations. A hand-edited file where one of four lines for `gcp_A` has a different height is accepted by the solver and quietly inconsistent.

### 3. Validate before running anything

```python
import exifread
from pyproj import CRS as PCRS, Transformer

def validate(path, image_dir, expect_epsg=25832, max_camera_dist_m=400.0):
    lines = Path(path).read_text().strip().splitlines()
    header, rows = lines[0], [l.split() for l in lines[1:] if l.strip()]
    problems, counts = [], {}

    crs = PCRS.from_user_input(header.split("+")[0] if header.startswith("EPSG") else header)
    if crs.to_epsg() != expect_epsg:
        problems.append(f"header CRS {header} is not the expected EPSG:{expect_epsg}")
    if header.startswith("EPSG") and "+" not in header:
        problems.append("header has no vertical CRS: heights will be treated as ellipsoidal")

    to_wgs = Transformer.from_crs(header, "EPSG:4326", always_xy=True)
    coords_by_label = {}

    for i, r in enumerate(rows, start=2):
        if len(r) < 6:
            problems.append(f"line {i}: expected at least 6 fields, got {len(r)}")
            continue
        e, n, h, px, py, image = float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), r[5]
        label = r[6] if len(r) > 6 else f"line{i}"
        counts[label] = counts.get(label, 0) + 1
        coords_by_label.setdefault(label, set()).add((e, n, h))

        if not (200_000 < e < 900_000) or not (4_000_000 < n < 6_500_000):
            problems.append(f"line {i}: {e}, {n} is not a plausible UTM easting/northing — swapped?")
        if not (-100 < h < 3000):
            problems.append(f"line {i}: height {h} is implausible")

        img_path = Path(image_dir) / image
        if not img_path.exists():
            problems.append(f"line {i}: image {image} not found")
            continue
        with open(img_path, "rb") as f:
            tags = exifread.process_file(f, details=False)
        w = int(str(tags.get("EXIF ExifImageWidth", 0)) or 0)
        hgt = int(str(tags.get("EXIF ExifImageLength", 0)) or 0)
        if w and hgt and not (0 <= px <= w and 0 <= py <= hgt):
            problems.append(f"line {i}: pixel ({px}, {py}) is outside the {w}×{hgt} image")

    for label, coords in coords_by_label.items():
        if len(coords) > 1:
            problems.append(f"{label}: inconsistent world coordinates across observations")
    for label, n_obs in counts.items():
        if n_obs < 3:
            problems.append(f"{label}: only {n_obs} observation(s); three or more are needed")

    return problems, counts

problems, counts = validate("gcp_list.txt", "/data/odm/block_09/images")
print(f"{len(counts)} points, observations per point: {counts}")
for p in problems:
    print("PROBLEM:", p)
assert not problems, "fix the control file before running"
```

Each check maps to a real failure. The plausibility bounds catch swapped easting and northing, which is otherwise undetectable in a file of large numbers. The pixel-bounds check catches a marking tool whose coordinate origin differs from the expected one, because a y flipped about the image centre usually still lands inside the image but a systematically offset one does not. The consistency check catches hand edits, and the observation count catches points that will contribute nothing.

<figure class="diagram">
<svg viewBox="6 6 748 222" role="img" aria-labelledby="gcp-checks-t gcp-checks-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gcp-checks-t">What each validation check catches</title>
  <desc id="gcp-checks-d">A table of checks. The CRS header check catches a missing vertical datum. Coordinate plausibility catches swapped easting and northing. Height plausibility catches typos. Pixel bounds catch a flipped image origin. Coordinate consistency catches hand edits. The observation count catches points that constrain nothing.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="222" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="270" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="290" y="20" width="450" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="54" width="270" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="54" width="450" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="86" width="270" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="86" width="450" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="118" width="270" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="118" width="450" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="150" width="270" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="150" width="450" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="182" width="270" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="290" y="182" width="450" height="32" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="155" y="42">check</text>
    <text x="515" y="42">failure it catches</text>
    <text x="155" y="75">compound CRS in the header</text><text x="515" y="75">heights silently treated as ellipsoidal</text>
    <text x="155" y="107">easting/northing bounds</text><text x="515" y="107">coordinates written in the wrong order</text>
    <text x="155" y="139">height bounds</text><text x="515" y="139">a transposed digit in a survey height</text>
    <text x="155" y="171">pixel inside the image</text><text x="515" y="171">a marking tool with a flipped y origin</text>
    <text x="155" y="203">one coordinate per label</text><text x="515" y="203">a hand-edited line that drifted</text>
  </g>
</svg>
<figcaption>None of these are exotic; all of them produce a file that parses and a reconstruction that is subtly wrong.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="6 10 748 208" role="img" aria-labelledby="gcp-line-t gcp-line-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gcp-line-t">Anatomy of one observation line</title>
  <desc id="gcp-line-d">A single line of a control file broken into its seven fields: easting, northing and height in the declared coordinate reference system, then the pixel x and pixel y in the image with the origin at the top left, then the image file name and an optional label. The header line above declares the compound coordinate reference system.</desc>
  <rect class="svg-bg" x="6" y="10" width="748" height="208" fill="#ffffff"/>
  <rect x="20" y="24" width="250" height="34" rx="6" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke-width="1.5">
    <rect x="20" y="86" width="115" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="135" y="86" width="125" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="260" y="86" width="90" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="350" y="86" width="70" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="420" y="86" width="70" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="490" y="86" width="160" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="650" y="86" width="90" height="34" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="145" y="46">EPSG:25832+7837</text>
    <text x="77" y="108">691204.412</text>
    <text x="197" y="108">5335818.221</text>
    <text x="305" y="108">519.310</text>
    <text x="385" y="108">2104</text>
    <text x="455" y="108">1436</text>
    <text x="570" y="108">DJI_0123.JPG</text>
    <text x="695" y="108">gcp_A</text>
  </g>
  <g fill="#5b6471" font-size="11.5" text-anchor="middle">
    <text x="197" y="146">easting, northing, height in the declared CRS</text>
    <text x="420" y="146">pixels, origin top-left</text>
    <text x="620" y="146">image, then label</text>
  </g>
  <text x="380" y="200" fill="#15384a" font-size="12.5" text-anchor="middle">The header is the only place the vertical datum appears — omit it and heights become ellipsoidal.</text>
</svg>
<figcaption>Seven fields, two coordinate conventions and one header: nearly every control-file defect is a confusion between two of them.</figcaption>
</figure>

### 4. Check the distribution, not just the count

```python
from shapely.geometry import MultiPoint, Point
import numpy as np

pts = np.array([survey[l] for l in survey])
hull = MultiPoint([Point(p[0], p[1]) for p in pts]).convex_hull
site = MultiPoint([Point(x, y) for x, y in flight_footprint_coords]).convex_hull   # from image positions

coverage = hull.area / site.area
centroid_offset = Point(pts[:, 0].mean(), pts[:, 1].mean()).distance(site.centroid)
z_spread = pts[:, 2].max() - pts[:, 2].min()

print(f"control hull covers {coverage * 100:.0f}% of the site, "
      f"centroid offset {centroid_offset:.0f} m, height spread {z_spread:.1f} m")
assert coverage > 0.6, "control points do not span the site: expect a tilt"
```

Five points in a cluster constrain position and nothing else. What removes deformation is spread: points near the corners of the flight footprint, one near the middle, and — where the site has relief — points at different heights, because a control set that is flat in z leaves the vertical scale poorly determined. A hull covering more than about 60% of the site area is the practical rule, and the centroid offset catches the case where all the control sits on one side.

<figure class="diagram">
<svg viewBox="16 16 728 228" role="img" aria-labelledby="gcp-dist-t gcp-dist-d" xmlns="http://www.w3.org/2000/svg">
  <title id="gcp-dist-t">Control distribution and what it constrains</title>
  <desc id="gcp-dist-d">Three site plans. Five clustered points fix position only, leaving rotation and scale poorly determined. Five points along one edge fix position and one direction, leaving a tilt across the site. Five points at the corners and centre constrain position, rotation, scale and low-order deformation.</desc>
  <rect class="svg-bg" x="16" y="16" width="728" height="228" fill="#ffffff"/>
  <rect x="30" y="30" width="200" height="150" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="280" y="30" width="200" height="150" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="530" y="30" width="200" height="150" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f2937">
    <circle cx="120" cy="100" r="5"/><circle cx="132" cy="112" r="5"/><circle cx="110" cy="115" r="5"/><circle cx="128" cy="92" r="5"/><circle cx="142" cy="105" r="5"/>
    <circle cx="300" cy="50" r="5"/><circle cx="345" cy="50" r="5"/><circle cx="390" cy="50" r="5"/><circle cx="435" cy="50" r="5"/><circle cx="460" cy="50" r="5"/>
    <circle cx="550" cy="50" r="5"/><circle cx="710" cy="50" r="5"/><circle cx="550" cy="160" r="5"/><circle cx="710" cy="160" r="5"/><circle cx="630" cy="105" r="5"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="206">clustered</text>
    <text x="380" y="206">one edge</text>
    <text x="630" y="206">corners and centre</text>
    <text x="130" y="226">position only</text>
    <text x="380" y="226">tilt across the site</text>
    <text x="630" y="226">position, scale, rotation</text>
  </g>
</svg>
<figcaption>The count in a specification is the least important property of a control set; what it spans decides what it can constrain.</figcaption>
</figure>

### 5. Split control from check points

```python
CHECK_LABELS = {"chk_1", "chk_2", "chk_3"}

control = {k: v for k, v in all_surveyed.items() if k not in CHECK_LABELS}
check = {k: v for k, v in all_surveyed.items() if k in CHECK_LABELS}

write_gcp_list("gcp_list.txt", CRS, control, [o for o in observations if o[0] in control])
Path("check_points.csv").write_text(
    "label,easting,northing,height\n" +
    "\n".join(f"{k},{v[0]:.3f},{v[1]:.3f},{v[2]:.3f}" for k, v in check.items()) + "\n"
)
print(f"{len(control)} control points in the run, {len(check)} check points held back")
```

Deciding the split in code, from one surveyed table, means the two files can never disagree and nobody can accidentally include a check point in the adjustment. Choose check points that are spread across the site too — three check points in one corner measure the accuracy of that corner.

## Expected Output & Verification

```text
18 observations of 5 points written
5 points, observations per point: {'gcp_A': 4, 'gcp_B': 4, 'gcp_C': 3, 'gcp_D': 4, 'gcp_E': 3}
control hull covers 71% of the site, centroid offset 14 m, height spread 1.8 m
5 control points in the run, 3 check points held back
```

After the reconstruction, the file's quality shows up as residuals. Compare the two sets:

```python
import numpy as np

ctrl_resid = np.loadtxt("odm_report/gcp_residuals.csv", delimiter=",", skiprows=1, usecols=(1, 2, 3))
chk_resid = np.loadtxt("check_residuals.csv", delimiter=",", skiprows=1, usecols=(1, 2, 3))
for name, r in (("control", ctrl_resid), ("check", chk_resid)):
    h = np.hypot(r[:, 0], r[:, 1])
    print(f"{name}: horizontal RMS {np.sqrt((h ** 2).mean()) * 100:.1f} cm, "
          f"vertical RMS {np.sqrt((r[:, 2] ** 2).mean()) * 100:.1f} cm")
```

Control residuals smaller than check residuals is normal and expected — the solver fitted the control. What matters is the *ratio*: check residuals two or three times the control residuals indicate a solution that is fitting its constraints rather than the site, usually from too few or badly distributed points. Check residuals close to the control residuals, and both close to the survey accuracy, is a healthy reconstruction.

A height spread of only 1.8 m across the control set is worth noting in the report: on a flat site it is unavoidable, and it means the vertical scale rests on the camera calibration rather than on the control.

## Performance Notes

- **Marking is the slow part.** Three observations per point across five points is fifteen careful picks; budget an hour and do it once, carefully, rather than twice.
- **Reuse control between epochs.** Permanent markers surveyed once serve every future flight, which makes repeat surveys both cheaper and directly comparable.
- **Validate in CI.** The validation function above runs in under a second and belongs in the same job that launches the processing run, so a bad file fails in seconds rather than after the reconstruction.
- **Keep the marking table, not just the generated file.** Re-generating `gcp_list.txt` from tables lets you change the CRS declaration or drop a point without re-marking.

## Common Errors

**The solver reports it ignored a control point.** Its reprojection residual exceeded the rejection threshold — usually a mismarked observation, or a point whose label is shared with a different physical marker. Check that point's observations against each other.

**The reconstruction is tilted despite good residuals at the control points.** Control is clustered or confined to one edge. Residuals can be tiny at the points and large everywhere else.

**Heights are systematically offset by tens of metres.** The header declared a horizontal CRS only, so orthometric heights were interpreted as ellipsoidal. Always write the compound code, as in step 1.

**Pixel coordinates seem to be mirrored vertically.** The marking tool used a bottom-left origin. Convert with `py = image_height - py` and re-validate; the pixel-bounds check will not always catch this, so verify one observation visually.

## Frequently Asked Questions

### How many control points are enough?

Five well-distributed points plus three check points is a sound minimum for a site of a few hectares. Larger areas need more, roughly one control point per 100–150 m of site extent along each axis, and split-merge runs need points inside each submodel's overlap.

### Can I use existing survey markers instead of placing targets?

Yes, if they are identifiable in the imagery at the flight's GSD — a painted cross, a manhole centre, a corner of a kerb. Natural features are harder to mark consistently across images, which shows up as larger residuals for those points.

### Do check points need to be observed in the images?

They need to be identifiable, so their coordinates can be compared with the reconstruction at the same spot. That is usually by sampling the surface model at the point's easting and northing, as the verification step in [running OpenDroneMap in Docker](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/) does.

## Related Guides

- [Running OpenDroneMap in Docker for City Blocks](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/) — the run that consumes this file
- [Georeferencing Photogrammetric Point Clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/georeferencing-photogrammetric-point-clouds/) — placing a reconstruction that had no control
- [Georeferencing IFC2x3 Models Without IfcMapConversion](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/bim-and-ifc-georeferencing/georeferencing-ifc2x3-models-without-map-conversion/) — the same least-squares fitting idea for BIM

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
