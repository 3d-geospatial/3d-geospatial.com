---
title: "Transforming Between Epoch-Based Datums"
description: "Handle plate motion in pyproj: coordinate epochs, ITRF and NAD83(2011) realisations, time-dependent Helmert transforms, and when a static transform is wrong."
---
# Transforming Between Epoch-Based Datums

This page handles the one CRS problem that a static EPSG code cannot express: continental plates move, so a coordinate on a dynamic datum means nothing without a date attached to it. It covers coordinate epochs in `pyproj`, the difference between a plate-fixed and an Earth-fixed realisation, time-dependent Helmert transforms, and how to decide whether your twin needs any of this at all.

## Why you hit this

Most city twins never notice plate motion, and then one does — when a survey flown in 2019 is merged with one flown in 2025 and the two disagree by six centimetres in a consistent direction across the whole extent. That is not a registration error and no amount of ICP will remove it. The Australian plate moves about 7 cm/year, the Pacific about 7, North America about 2.5, and Europe about 2.5. Over a six-year gap those are 42, 42, 15 and 15 cm respectively, and every one of them exceeds the tolerance of a survey-grade twin.

The static half of this is covered in [coordinate reference systems for 3D assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/); what follows is what changes when the datum has a time axis.

## Prerequisites

- Python 3.10+ with `pyproj>=3.6` (PROJ 9.2+ for reliable epoch handling) and `numpy>=1.24`.
- PROJ transformation grids installed, including the plate-motion models — `projsync --source-id all` fetches them.
- The **acquisition epoch** of every dataset, as a decimal year. This is metadata surveys record and pipelines routinely discard, and without it none of the below is possible.
- A decision about the twin's reference epoch: the single date all data is expressed at.

## Step-by-Step

### 1. Establish whether your datum is dynamic

Static datums are fixed to a plate and their coordinates do not change with time. Dynamic ones are fixed to the Earth's centre of mass, so every point on a moving plate drifts.

```python
from pyproj import CRS

for code in ("EPSG:7912", "EPSG:6318", "EPSG:7844", "EPSG:4326"):
    crs = CRS.from_user_input(code)
    dyn = crs.datum.type_name if crs.datum else "unknown"
    print(f"{code:<12} {crs.name[:44]:<46} {dyn}")
```

`EPSG:7912` (ITRF2014) is a dynamic geodetic reference frame: its coordinates are Earth-centred and every point moves. `EPSG:6318` (NAD83(2011)) and `EPSG:7844` (GDA2020) are plate-fixed: within North America and Australia respectively, coordinates are nearly constant, and the plate's motion has been absorbed into the definition. `EPSG:4326` is the trap — nominally WGS84, in practice whatever realisation the receiver used, and treated by almost every tool as static when it is not.

<figure class="diagram">
<svg viewBox="47 42 646 198" role="img" aria-labelledby="ep-frames-t ep-frames-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ep-frames-t">Plate-fixed and Earth-fixed frames over six years</title>
  <desc id="ep-frames-d">A point on a moving plate keeps almost the same coordinates in a plate-fixed frame such as GDA2020, because the plate's motion is built into the definition. In an Earth-fixed frame such as ITRF2014 the same point drifts by the plate velocity, about forty-two centimetres over six years in Australia.</desc>
  <rect class="svg-bg" x="47" y="42" width="646" height="198" fill="#ffffff"/>
  <g fill="#4f7a4d">
    <circle cx="120" cy="90" r="6"/><circle cx="122" cy="90" r="6"/>
  </g>
  <path d="M60 128 H320" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <text x="190" y="70" fill="#4f7a4d" font-size="12.5" text-anchor="middle">plate-fixed (GDA2020)</text>
  <text x="190" y="150" fill="#1f2937" font-size="12" text-anchor="middle">2019 and 2025 coordinates: 2 mm apart</text>
  <g fill="#b0413e">
    <circle cx="450" cy="90" r="6"/><circle cx="590" cy="90" r="6"/>
  </g>
  <path d="M456 90 H584" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="5 4"/>
  <path d="M420 128 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <text x="550" y="70" fill="#b0413e" font-size="12.5" text-anchor="middle">Earth-fixed (ITRF2014)</text>
  <text x="550" y="150" fill="#1f2937" font-size="12" text-anchor="middle">the same point drifts 42 cm in six years</text>
  <text x="370" y="196" fill="#15384a" font-size="12.5" text-anchor="middle">Neither frame is wrong. Mixing them without epochs produces a shift that looks like a registration failure.</text>
  <text x="370" y="222" fill="#5b6471" font-size="12" text-anchor="middle">GNSS delivers Earth-fixed; national grids are usually plate-fixed; the conversion between them needs a date</text>
</svg>
<figcaption>The same ground point, two legitimate coordinate values. Which one you have depends on the frame, and converting between them is a function of time.</figcaption>
</figure>

### 2. Attach the epoch to the coordinates

`pyproj` carries the epoch on the transformer, not on the CRS, and passing it is what switches on the time-dependent path.

```python
import numpy as np
from pyproj import Transformer

# ITRF2014 (dynamic, EPSG:7912) at the 2019 acquisition epoch
# → GDA2020 (plate-fixed, EPSG:7844)
tf = Transformer.from_crs("EPSG:7912", "EPSG:7844", always_xy=True)

lon = np.array([151.2093, 151.2110])
lat = np.array([-33.8688, -33.8701])
h   = np.array([58.2, 61.7])
epoch = np.full(lon.shape, 2019.45)          # decimal year of acquisition

x, y, z, t = tf.transform(lon, lat, h, epoch)
print("GDA2020:", np.round(x, 8), np.round(y, 8))
print("operation:", tf.description)
```

The fourth positional argument is the epoch. Omit it and PROJ picks a default — usually the frame's own reference epoch — which silently applies the wrong amount of plate motion. The error is smooth, consistent across the extent, and indistinguishable from a small datum offset.

### 3. Propagate coordinates between epochs within one frame

Bringing two surveys onto a common date is a separate operation from changing frames.

```python
from pyproj import Transformer

# Same frame, different epochs: ITRF2014@2019.45 → ITRF2014@2025.00
prop = Transformer.from_pipeline(
    "+proj=pipeline "
    "+step +proj=unitconvert +xy_in=deg +xy_out=rad "
    "+step +proj=cart +ellps=GRS80 "
    "+step +proj=deformation +dt=5.55 +grids=au_ga_AUS_GDA2020_conformal_and_distortion.tif "
    "+step +inv +proj=cart +ellps=GRS80 "
    "+step +proj=unitconvert +xy_in=rad +xy_out=deg"
)
```

Where a deformation grid is unavailable, a plate-motion model gives a good approximation: the velocity is nearly constant over decades, so the displacement is simply velocity times elapsed years applied in the Earth-centred frame.

```python
import numpy as np

# Australian plate velocity in ITRF2014, ECEF metres per year.
VX, VY, VZ = -0.0398, 0.0000, 0.0509

def propagate_ecef(xyz, from_epoch, to_epoch):
    dt = to_epoch - from_epoch
    return xyz + np.array([VX, VY, VZ]) * dt

p2019 = np.array([-4646050.12, 2553461.44, -3534952.87])
p2025 = propagate_ecef(p2019, 2019.45, 2025.00)
print("displacement (m):", np.round(p2025 - p2019, 4),
      "| magnitude:", round(float(np.linalg.norm(p2025 - p2019)), 4))
```

### 4. Pick one reference epoch for the twin and convert everything to it

The decision that makes the rest tractable is choosing a single date all stored geometry is expressed at.

```python
REFERENCE_EPOCH = 2020.00        # the twin's internal epoch, recorded in the manifest

def ingest(dataset_path, source_crs, acquisition_epoch):
    tf = Transformer.from_crs(source_crs, "EPSG:7844", always_xy=True)
    lon, lat, h = read_coordinates(dataset_path)
    x, y, z, _ = tf.transform(lon, lat, h, np.full(lon.shape, acquisition_epoch))
    return x, y, z, {
        "source_crs": source_crs,
        "acquisition_epoch": acquisition_epoch,
        "reference_epoch": REFERENCE_EPOCH,
        "plate_model": "ITRF2014 / GDA2020",
    }
```

Recording the metadata alongside the coordinates is what makes the transform reversible. A dataset whose acquisition epoch has been forgotten cannot be returned to its original frame, and cannot be correctly compared against a later survey.

<figure class="diagram">
<svg viewBox="10 36 744 192" role="img" aria-labelledby="ep-ref-t ep-ref-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ep-ref-t">Every dataset converted to one reference epoch at ingest</title>
  <desc id="ep-ref-d">Three surveys acquired in 2018, 2021 and 2025 are each propagated to the twin's reference epoch of 2020 at ingest, so all stored geometry shares one date. Comparisons between them then measure real change rather than plate motion, and the acquisition epoch is retained so the conversion stays reversible.</desc>
  <rect class="svg-bg" x="10" y="36" width="744" height="192" fill="#ffffff"/>
  <g stroke-width="2">
    <rect x="24" y="50" width="140" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="98" width="140" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="24" y="146" width="140" height="34" rx="6" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="290" y="80" width="180" height="70" rx="8" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="580" y="80" width="160" height="70" rx="8" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="94" y="72">survey 2018.30</text>
    <text x="94" y="120">survey 2021.60</text>
    <text x="94" y="168">survey 2025.10</text>
    <text x="380" y="108"><tspan x="380" dy="0">propagate to</tspan><tspan x="380" dy="17">epoch 2020.00</tspan></text>
    <text x="660" y="100"><tspan x="660" dy="0">one internal frame,</tspan><tspan x="660" dy="17">one date, comparisons</tspan><tspan x="660" dy="16">measure real change</tspan></text>
  </g>
  <g stroke="#5b6471" stroke-width="2" fill="none">
    <path d="M164 67 C 220 80 250 92 288 100"/>
    <path d="M164 115 L288 115"/>
    <path d="M164 163 C 220 150 250 138 288 130"/>
    <path d="M470 115 H578"/>
  </g>
  <text x="380" y="210" fill="#15384a" font-size="12.5" text-anchor="middle">Keep the acquisition epoch in the metadata — without it the propagation cannot be undone or re-derived</text>
</svg>
<figcaption>One reference epoch turns a fleet of surveys into a comparable set. Without it, every multi-year difference contains an unknown amount of plate motion.</figcaption>
</figure>

<figure class="diagram">
<svg viewBox="56 23 638 229" role="img" aria-labelledby="ep-rate-t ep-rate-d" xmlns="http://www.w3.org/2000/svg">
  <title id="ep-rate-t">Plate velocity against the gap between two surveys</title>
  <desc id="ep-rate-d">Displacement is velocity times elapsed years, so the error from ignoring plate motion grows linearly with the gap between surveys. In Australia at seven centimetres a year, a two-year gap is inside most tolerances and a six-year gap is not. In Europe at two and a half, the same crossing happens around fifteen years.</desc>
  <rect class="svg-bg" x="56" y="23" width="638" height="229" fill="#ffffff"/>
  <path d="M70 46 V190 H680" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <path d="M70 150 H680" fill="none" stroke="#b0413e" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="680" y="144" fill="#b0413e" font-size="12" text-anchor="end">5 cm survey tolerance</text>
  <polyline points="100,186 200,142 300,98 400,54" fill="none" stroke="#c46a3d" stroke-width="2.5"/>
  <polyline points="100,188 220,172 340,156 460,140 580,124 660,113" fill="none" stroke="#1f6b8a" stroke-width="2.5"/>
  <text x="410" y="50" fill="#c46a3d" font-size="12" text-anchor="start">Australia, 7 cm/yr</text>
  <text x="600" y="106" fill="#1f6b8a" font-size="12" text-anchor="end">Europe, 2.5 cm/yr</text>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="100" y="212">0</text><text x="220" y="212">4</text><text x="340" y="212">8</text>
    <text x="460" y="212">12</text><text x="580" y="212">16</text><text x="660" y="212">20</text>
  </g>
  <text x="375" y="234" fill="#5b6471" font-size="12" text-anchor="middle">years between the two surveys</text>
</svg>
<figcaption>The threshold is not a property of the datum but of your tolerance and your region. Crossing it is what turns epoch handling from optional into necessary.</figcaption>
</figure>

## Expected Output & Verification

The check that settles whether epoch handling is working is a differenced control point across two surveys.

```python
import numpy as np

# Same physical benchmark, surveyed twice, both propagated to the reference epoch.
p_2019 = np.array([336742.118, 6250881.442, 58.204])
p_2025 = np.array([336742.121, 6250881.446, 58.199])

d = p_2025 - p_2019
print("residual (mm):", np.round(d * 1000, 1),
      "| magnitude:", round(float(np.linalg.norm(d)) * 1000, 1), "mm")
assert np.linalg.norm(d) < 0.02, "residual exceeds survey tolerance — check the epochs"
```

Expected output for a correctly handled pair is a residual of a few millimetres — the surveys' own noise. A residual of 15–45 cm with a consistent horizontal direction across every control point is unhandled plate motion, and its magnitude divided by the years between surveys should come out close to your region's plate velocity, which is a satisfying confirmation of the diagnosis.

## Common Errors

**A consistent horizontal shift between two epochs of the same site.** Plate motion, unhandled. Divide the shift by the elapsed years and compare against the plate velocity for your region; the match is usually within a centimetre per year.

**`pyproj` ignores the epoch you passed.** The transformation PROJ selected is not time-dependent, either because a plate-motion grid is missing or because both CRSs are plate-fixed and no propagation is required. Inspect `tf.description` and `tf.get_grids_used()` to see which operation was chosen.

**Coordinates change when nothing should have.** A static transform was applied between two dynamic frames using the default epoch rather than the acquisition epoch. The magnitude is the plate velocity times the difference between the acquisition date and the frame's reference date.

## Frequently Asked Questions

### Does my twin need epoch handling at all?
If all data comes from one survey campaign, or if the twin's tolerance is decimetres rather than centimetres, no. It becomes necessary when multi-year data is fused at survey-grade tolerance, or when the twin is in a fast-moving region such as Australia, New Zealand or the Pacific coast.

### What epoch should I pick as the reference?
Something round and defensible — the year the twin was established is common. What matters far more than the value is that it is recorded in the manifest and that every ingest converts to it.

### Is WGS84 static or dynamic?
Dynamic, in every modern realisation, though almost every tool treats `EPSG:4326` as static. That mismatch is why a GNSS-derived cloud and a national-grid dataset can differ by a decimetre with no error anywhere.

A closing note on where the epoch belongs in a pipeline. It is metadata about the *acquisition*, not about the file, so it should travel with the survey from the moment it is delivered — in the LAS header's VLR, in a sidecar next to the raster, in the manifest row for the tile. Pipelines routinely discard it at the first conversion because no format demands it, and by the time the second survey arrives there is nothing to propagate from. Recording it costs one field and is unrecoverable once lost.

The second point is that the epoch and the datum are separate declarations, and both are needed. "GDA2020" alone does not say when the coordinates were valid, and "epoch 2019.45" alone does not say which frame they are in. A pipeline that asserts one and not the other will happily fuse two surveys that agree on the frame and differ by six years of plate motion.

### Can I just apply a constant shift between two survey epochs?
Over a city, usually yes — plate velocity varies by well under a millimetre per year across a metropolitan extent, so a single displacement vector is accurate to a millimetre or two. Over a national extent it is not: velocity varies with position on the plate, and a deformation grid is the correct instrument.

### What about vertical motion?
Subsidence, uplift and glacial isostatic adjustment are real and are not captured by a horizontal plate model. Where they matter — reclaimed land, extraction areas, formerly glaciated regions — the vertical rate has to come from a local deformation model or from repeated levelling, and it is often larger than the horizontal plate motion.

### Does this affect the tileset I publish?
Only through the coordinates that went into it. The published tileset is a snapshot at the reference epoch; what changes is that a tileset built next year from a new survey will line up with it, because both were propagated to the same date before tiling.

## Related Guides

- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — the static transformation chain this extends
- [How to Choose CRS for Urban Digital Twins](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/how-to-choose-crs-for-urban-digital-twins/) — plate-fixed national grids as the internal frame
- [Asserting CRS and Units with pyproj](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/asserting-crs-and-units-with-pyproj/) — gating the epoch alongside the CRS

Back to [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/).
