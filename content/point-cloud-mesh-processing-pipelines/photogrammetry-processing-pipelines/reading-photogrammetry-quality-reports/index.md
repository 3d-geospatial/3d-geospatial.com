# Reading Photogrammetry Quality Reports

This page turns the statistics a photogrammetry run produces into an acceptance decision — parsing OpenDroneMap's `stats.json` and COLMAP's model analysis, computing the ground sampling distance from EXIF, combining them with check-point residuals into one machine-readable quality record in EPSG:25832+7837, and gating a pipeline on thresholds that can be defended.

## Why you hit this

Every processing tool produces a report, and almost nobody reads it until a measurement is disputed. By then the run has been deleted, the report is a PDF in a project folder, and the only honest answer to "how accurate is this?" is "we don't know". The fix is small: extract the four numbers that matter, store them next to the outputs, and refuse to publish a reconstruction whose numbers are outside the agreed range. The four numbers and their meaning are introduced in [photogrammetry processing pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/); this page is the parsing and the gate.

## Prerequisites

- A completed OpenDroneMap project with `opensfm/stats/stats.json`, or a COLMAP sparse model.
- Python 3.10+ with `numpy>=1.24`, `rasterio>=1.3`, `exifread>=3.0`.
- Check points held back from the adjustment, in the target compound CRS, and the run's surface model for sampling them.

## Step-by-Step

### 1. Compute the ground sampling distance from the imagery

```python
import exifread
from pathlib import Path

def gsd_cm(image_path, altitude_m, sensor_width_mm=None):
    with open(image_path, "rb") as f:
        tags = exifread.process_file(f, details=False)
    focal = float(str(tags["EXIF FocalLength"]).split("/")[0])
    width_px = int(str(tags["EXIF ExifImageWidth"]))
    if sensor_width_mm is None:
        # FocalPlaneXResolution is in pixels per unit; unit 2 = inch, 3 = cm
        res = tags.get("EXIF FocalPlaneXResolution")
        unit = int(str(tags.get("EXIF FocalPlaneResolutionUnit", 2)))
        if res is None:
            raise ValueError("no sensor size in EXIF: pass sensor_width_mm explicitly")
        num, den = (str(res).split("/") + ["1"])[:2]
        px_per_unit = float(num) / float(den)
        sensor_width_mm = width_px / px_per_unit * (25.4 if unit == 2 else 10.0)
    pitch_mm = sensor_width_mm / width_px
    return pitch_mm * altitude_m / focal * 100

gsd = gsd_cm("/data/odm/block_09/images/DJI_0123.JPG", altitude_m=92.0, sensor_width_mm=13.2)
print(f"GSD {gsd:.2f} cm/px")
```

The GSD bounds every accuracy claim the project can make, and it is worth computing rather than quoting from the flight plan, which records the intended altitude rather than the flown one. Sensor width from EXIF is unreliable across manufacturers, so pass it explicitly from the camera's datasheet when a project's numbers matter.

<figure class="diagram">
<svg viewBox="286 4 451 238" role="img" aria-labelledby="qr-gsd-t qr-gsd-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qr-gsd-t">Ground sampling distance from altitude, focal length and pixel pitch</title>
  <desc id="qr-gsd-d">A camera at altitude above the ground, with its sensor and focal length shown. One sensor pixel of a given pitch projects to a ground footprint equal to the pitch times the altitude divided by the focal length. A 3.3 micrometre pitch with a 9 millimetre lens at 92 metres gives about 2 centimetres on the ground.</desc>
  <rect class="svg-bg" x="286" y="4" width="451" height="238" fill="#ffffff"/>
  <path d="M294 200 H700" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M300 40 h120 v18 h-120 Z" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M340 58 L300 200" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M380 58 L420 200" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M300 200 H420" fill="none" stroke="#9a4f26" stroke-width="6"/>
  <path d="M470 58 V200" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M462 58 H478 M462 200 H478" fill="none" stroke="#1f6b8a" stroke-width="2"/>
  <path d="M340 58 H380" fill="none" stroke="#9a4f26" stroke-width="4"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="360" y="32">sensor, pixel pitch p</text>
    <text x="520" y="120">altitude h</text>
    <text x="360" y="224">GSD = p × h / f</text>
  </g>
  <text x="392" y="80" fill="#9a4f26" font-size="12" text-anchor="start">focal length f</text>
  <text x="640" y="180" fill="#15384a" font-size="12.5" text-anchor="middle">3.3 µm · 92 m / 9 mm ≈ 2 cm</text>
</svg>
<figcaption>Every accuracy figure in the report is bounded by this one number, which is why it belongs in the dataset's metadata rather than in the flight plan.</figcaption>
</figure>

### 2. Parse the OpenDroneMap statistics

```python
import json

def parse_odm_stats(project):
    stats = json.loads((Path(project) / "opensfm" / "stats" / "stats.json").read_text())
    recon = stats.get("reconstruction_statistics", {})
    feats = stats.get("features_statistics", {}).get("detected_features", {})
    points = stats.get("points_statistics", {})
    return {
        "images_total": recon.get("initial_shots"),
        "images_reconstructed": recon.get("reconstructed_images"),
        "components": recon.get("components"),
        "reprojection_error_px": recon.get("reprojection_error_normalized"),
        "mean_track_length": recon.get("average_track_length"),
        "points": points.get("reconstructed"),
        "features_median": feats.get("median"),
        "gps_error_m": (stats.get("gps_errors", {}) or {}).get("average_error"),
    }

odm = parse_odm_stats("/data/odm/block_09")
print(json.dumps(odm, indent=2))
```

Field names differ between OpenSfM versions, so the parser uses `.get` throughout and returns `None` rather than raising — a report that is missing a field is still worth recording, while a parser that crashes on an unfamiliar version blocks the pipeline for no reason. Print the raw JSON once when adopting a new version and adjust the mapping.

`components` is the field to read first: more than one means the reconstruction split into disconnected parts, and everything else in the report describes only the largest of them.

### 3. Parse COLMAP's model analysis

```python
import re
import subprocess

def parse_colmap_model(model_path):
    out = subprocess.run(["colmap", "model_analyzer", "--path", str(model_path)],
                         capture_output=True, text=True).stdout
    def num(pattern, cast=float):
        m = re.search(pattern, out)
        return cast(m.group(1)) if m else None
    return {
        "cameras": num(r"Cameras:\s+(\d+)", int),
        "images": num(r"Images:\s+(\d+)", int),
        "images_registered": num(r"Registered images:\s+(\d+)", int),
        "points": num(r"Points:\s+(\d+)", int),
        "observations": num(r"Observations:\s+(\d+)", int),
        "mean_track_length": num(r"Mean track length:\s+([\d.]+)"),
        "mean_obs_per_image": num(r"Mean observations per image:\s+([\d.]+)"),
        "reprojection_error_px": num(r"Mean reprojection error:\s+([\d.]+)px"),
    }

colmap_stats = parse_colmap_model("/data/colmap/pier_north/sparse/0")
print(colmap_stats)
```

The two tools report the same quantities under different names, which is why the record below normalises them: a pipeline that accepts both should not have two acceptance rules.

### 4. Measure accuracy at the check points

```python
import numpy as np
import rasterio

def check_point_residuals(dsm_path, check_csv):
    check = np.loadtxt(check_csv, delimiter=",", skiprows=1, usecols=(1, 2, 3))
    with rasterio.open(dsm_path) as dsm:
        assert dsm.crs.to_epsg() == 25832, "check points and DSM must share a CRS"
        sampled = np.array([v[0] for v in dsm.sample(check[:, :2])], dtype=float)
    resid = sampled - check[:, 2]
    resid = resid[np.isfinite(resid)]
    return {
        "n": int(len(resid)),
        "rmse_z_m": float(np.sqrt(np.mean(resid ** 2))),
        "bias_z_m": float(np.mean(resid)),
        "max_abs_z_m": float(np.max(np.abs(resid))),
        "residuals_m": [round(float(r), 3) for r in resid],
    }

acc = check_point_residuals("/data/odm/block_09/odm_dem/dsm.tif", "check_points.csv")
print(acc)
```

Separating bias from RMSE is what makes the number actionable. A bias of +8 cm with an RMSE of 9 cm is a systematic vertical offset — a datum or a calibration problem, fixable and worth fixing. A bias near zero with an RMSE of 9 cm is noise at the level the GSD and the control allow, and no amount of reprocessing will improve it.

<figure class="diagram">
<svg viewBox="6 6 748 240" role="img" aria-labelledby="qr-four-t qr-four-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qr-four-t">The four numbers and what each one can and cannot tell you</title>
  <desc id="qr-four-d">A table. Reprojection error measures internal consistency, not absolute accuracy. Reconstructed images reveal dropped regions. Mean track length shows how well determined the points are. Check-point residuals are the only measure of absolute accuracy. Each has a typical acceptable range for a two centimetre ground sampling distance survey.</desc>
  <rect class="svg-bg" x="6" y="6" width="748" height="240" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="20" y="20" width="220" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="290" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="530" y="20" width="210" height="36" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="20" y="56" width="220" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="56" width="290" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="56" width="210" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="100" width="220" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="100" width="290" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="100" width="210" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="144" width="220" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="144" width="290" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="530" y="144" width="210" height="44" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="20" y="188" width="220" height="44" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="188" width="290" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="530" y="188" width="210" height="44" fill="#fdf3e0" stroke="#c46a3d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="130" y="43">number</text>
    <text x="385" y="43">what it measures</text>
    <text x="635" y="43">healthy range</text>
    <text x="130" y="83">reprojection error</text><text x="385" y="83">internal consistency only</text><text x="635" y="83">0.3–1.0 px</text>
    <text x="130" y="127">images reconstructed</text><text x="385" y="127">whether a region was dropped</text><text x="635" y="127">all of them</text>
    <text x="130" y="171">mean track length</text><text x="385" y="171">how many views define a point</text><text x="635" y="171">&gt; 3</text>
    <text x="130" y="215">check-point residuals</text><text x="385" y="215">absolute accuracy — the only one</text><text x="635" y="215">1–3 × GSD</text>
  </g>
</svg>
<figcaption>Only the last row is accuracy. The first three describe whether the solution is coherent, which is necessary and not sufficient.</figcaption>
</figure>

### 5. Write one quality record and gate on it

```python
from datetime import date

def quality_record(project, gsd_cm, stats, accuracy, tool, digest):
    rec = {
        "project": str(project),
        "processed": date.today().isoformat(),
        "tool": tool,
        "container_digest": digest,
        "gsd_cm": round(gsd_cm, 2),
        "crs": "EPSG:25832+7837",
        "images_total": stats.get("images_total") or stats.get("images"),
        "images_reconstructed": stats.get("images_reconstructed") or stats.get("images_registered"),
        "components": stats.get("components", 1),
        "reprojection_error_px": stats.get("reprojection_error_px"),
        "mean_track_length": stats.get("mean_track_length"),
        "accuracy": accuracy,
    }
    Path(project, "quality.json").write_text(json.dumps(rec, indent=2))
    return rec

def gate(rec, max_reproj_px=1.5, min_track=3.0, rmse_multiple_of_gsd=3.0):
    failures = []
    if (rec["components"] or 1) > 1:
        failures.append(f"{rec['components']} disconnected components")
    if rec["images_reconstructed"] != rec["images_total"]:
        missing = rec["images_total"] - rec["images_reconstructed"]
        if missing > 0.02 * rec["images_total"]:
            failures.append(f"{missing} images not reconstructed")
    if (rec["reprojection_error_px"] or 0) > max_reproj_px:
        failures.append(f"reprojection error {rec['reprojection_error_px']:.2f} px")
    if (rec["mean_track_length"] or 0) < min_track:
        failures.append(f"mean track length {rec['mean_track_length']:.2f}")
    limit = rmse_multiple_of_gsd * rec["gsd_cm"] / 100.0
    if rec["accuracy"]["rmse_z_m"] > limit:
        failures.append(f"RMSEz {rec['accuracy']['rmse_z_m']:.3f} m exceeds {limit:.3f} m")
    if abs(rec["accuracy"]["bias_z_m"]) > 0.5 * limit:
        failures.append(f"vertical bias {rec['accuracy']['bias_z_m']:+.3f} m")
    return failures

rec = quality_record("/data/odm/block_09", gsd, odm, acc, "odm",
                     "sha256:3f0a…")     # the container digest that produced it
failures = gate(rec)
print("PASS" if not failures else "FAIL: " + "; ".join(failures))
```

Expressing the accuracy threshold as a multiple of the GSD is what makes one gate work across flights at different altitudes. Three times the GSD vertically is an achievable target for a well-controlled survey; a 2 cm GSD flight should land inside 6 cm, and a 5 cm GSD flight inside 15 cm. Recording the container digest alongside makes the run reproducible, which is the other half of a defensible number.

### 6. Track the record across flights

```python
import glob

records = [json.loads(Path(p).read_text()) for p in sorted(glob.glob("/data/odm/*/quality.json"))]
print(f"{'project':<22}{'GSD':>6}{'reproj':>8}{'track':>7}{'RMSEz':>8}{'bias':>8}")
for r in records:
    a = r["accuracy"]
    print(f"{Path(r['project']).name:<22}{r['gsd_cm']:>6.2f}{r['reprojection_error_px']:>8.2f}"
          f"{r['mean_track_length']:>7.2f}{a['rmse_z_m']:>8.3f}{a['bias_z_m']:>+8.3f}")
```

A table of past runs is the most useful artefact this whole page produces. It answers "is this flight worse than usual?" — which is a far better question than "is this flight acceptable?" — and it exposes slow drifts, such as a camera whose calibration has changed or a control network that has been disturbed.

## Expected Output & Verification

```text
GSD 2.04 cm/px
{
  "images_total": 412,
  "images_reconstructed": 412,
  "components": 1,
  "reprojection_error_px": 0.42,
  "mean_track_length": 5.61,
  "points": 214882,
  "features_median": 18422,
  "gps_error_m": 1.42
}
{'n': 3, 'rmse_z_m': 0.038, 'bias_z_m': 0.011, 'max_abs_z_m': 0.049, 'residuals_m': [0.049, -0.021, 0.011]}
PASS

project                  GSD  reproj  track   RMSEz    bias
block_09                2.04    0.42   5.61   0.038  +0.011
block_11                2.11    0.51   5.02   0.044  -0.008
block_12                2.08    1.62   3.21   0.128  +0.092
```

`block_12` in that table is the point of the exercise: its reprojection error is above the threshold, its track length has collapsed and its vertical bias is 9 cm, all of which point at the same cause — a weakly connected reconstruction with control on one side. The gate rejects it, and the table shows it is the exception rather than the norm for this project.

Verify the gate itself against a run you know is bad. Keep the statistics of a past failed run as a fixture and assert that `gate` rejects it:

```python
bad = json.loads(Path("tests/fixtures/quality_bad.json").read_text())
assert gate(bad), "the gate accepted a known-bad run"
print("gate rejects the known-bad fixture")
```

<figure class="diagram">
<svg viewBox="56 8 658 238" role="img" aria-labelledby="qr-trend-t qr-trend-d" xmlns="http://www.w3.org/2000/svg">
  <title id="qr-trend-t">Vertical RMSE across flights against the GSD-based limit</title>
  <desc id="qr-trend-d">A series of flights with their vertical root mean square error plotted against a limit of three times the ground sampling distance. Most flights sit between one and two times the GSD. One flight exceeds the limit, and the same flight also shows a large vertical bias, which identifies a control problem rather than noise.</desc>
  <rect class="svg-bg" x="56" y="8" width="658" height="238" fill="#ffffff"/>
  <path d="M70 30 V180 H700" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M70 70 H700" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <g stroke-width="1.5" fill="#e3f0f4" stroke="#1f6b8a">
    <rect x="110" y="140" width="44" height="40"/>
    <rect x="190" y="132" width="44" height="48"/>
    <rect x="270" y="146" width="44" height="34"/>
    <rect x="350" y="136" width="44" height="44"/>
    <rect x="510" y="128" width="44" height="52"/>
    <rect x="590" y="142" width="44" height="38"/>
  </g>
  <rect x="430" y="44" width="44" height="136" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
  <text x="688" y="62" fill="#b0413e" font-size="12" text-anchor="end">limit: 3 × GSD</text>
  <text x="452" y="36" fill="#b0413e" font-size="12.5" text-anchor="middle">block_12</text>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="132" y="200">07</text><text x="212" y="200">08</text><text x="292" y="200">09</text>
    <text x="372" y="200">11</text><text x="452" y="200">12</text><text x="532" y="200">13</text><text x="612" y="200">14</text>
  </g>
  <text x="385" y="228" fill="#15384a" font-size="12.5" text-anchor="middle">vertical RMSE per block, in the same units as the limit</text>
</svg>
<figcaption>A per-project history turns a threshold into context: one flight outside the band is a specific problem to investigate, not a reason to move the threshold.</figcaption>
</figure>

## Performance Notes

- **Parsing is free**; sampling the surface model at a handful of check points is milliseconds. There is no performance reason to skip any of this.
- **Store `quality.json` with the outputs, not in a build directory** that gets cleaned. It is the smallest and most valuable artefact of the run.
- **Keep the raw report too.** A normalised record loses fields you will want when the next question is unexpected.
- **Run the gate inside the processing job**, so a failing reconstruction never reaches the tiling stage and waste compute downstream.

## Common Errors

**`KeyError` on a statistics field.** The tool version changed its schema. Use `.get` and log unknown structures rather than failing.

**Check-point sampling returns nodata.** The points fall outside the surface model, or on a masked cell such as water. Print the sampled values before computing statistics and exclude nodata explicitly.

**RMSE looks excellent because the check points were in the adjustment.** The most common way to produce a flattering number. The split has to be enforced where the control file is generated, as in [preparing ground control point files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/).

**Reprojection error is tiny and the model is visibly wrong.** Expected — it is an internal measure. A reconstruction can fit its own observations beautifully and be domed by 30 cm.

## Frequently Asked Questions

### What accuracy should I promise a client?

Whatever the check points measured on their site, with the number of points stated. For planning purposes before flying, one to three times the GSD horizontally and two to three times vertically is a defensible expectation for a controlled survey.

### Three check points seems few.

It is the practical minimum and it gives a weak estimate. Five to ten spread across the site is much better, and on a large project the marginal survey cost is small against the cost of an accuracy dispute.

### Can I compare reprojection error between ODM and COLMAP?

Only loosely. Both report a mean in pixels, but the feature detectors, the image scales at which features were found and the outlier thresholds differ. Compare each tool against its own history.

## Related Guides

- [Running OpenDroneMap in Docker for City Blocks](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/running-opendronemap-in-docker-for-city-blocks/) — the run that produces these statistics
- [Preparing Ground Control Point Files](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/preparing-ground-control-point-files/) — where the check-point split is enforced
- [Schema Validation Gates for Spatial Data](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/cicd-automation-for-spatial-pipelines/schema-validation-gates-for-spatial-data/) — the same gate pattern for other data

Back to [Photogrammetry Processing Pipelines](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/photogrammetry-processing-pipelines/).
