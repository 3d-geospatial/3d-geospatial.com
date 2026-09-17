---
title: "Colorizing LiDAR from Orthophotos with PDAL"
description: "Assign RGB to LAZ points from an orthophoto with PDAL filters.colorization: CRS and band scaling, relief displacement on roofs and walls, masking and an alignment check."
---
# Colorizing LiDAR from Orthophotos with PDAL

This page assigns red, green and blue values to LiDAR points from an aerial orthophoto with PDAL's `filters.colorization` — matching the CRS of both datasets (EPSG:25832 here), scaling 8-bit imagery into LAS 16-bit colour, restricting colour to surfaces an orthophoto can actually see, and measuring the image-to-cloud misalignment that produces coloured roof edges on the ground.

## Why you hit this

A coloured point cloud is far easier to read than one shaded by intensity or height, and many viewers and customers expect one. When the scan was flown without a camera, or its imagery is unusable, colouring from the national or municipal orthophoto is the obvious fix and a single PDAL filter does it. The result looks right from above and wrong everywhere else: walls painted with the colours of the pavement in front of them, tree crowns with a grey halo of road, roof edges repeated as a shadow on the street. Those are not bugs in PDAL; they are properties of orthophotos, and they are predictable enough to handle. The mesh-texturing equivalent of this problem is in [aligning photogrammetry textures with point clouds](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/aligning-photogrammetry-textures-with-point-clouds/).

## Prerequisites

- PDAL 2.6+ with Python bindings (`pdal>=3.4`), `rasterio>=1.3`, `numpy>=1.24`, `scikit-image>=0.22`.
- LAZ in EPSG:25832 with heights in DHHN2016 (EPSG:7837), classified with at least ground (2), vegetation (3–5) and building (6).
- An orthophoto GeoTIFF covering the same area, ideally a *true* orthophoto; its CRS must be known and its date close to the flight date.
- Point data record format 7 or 8 output (LAS 1.4) so the file has RGB fields.

## Step-by-Step

### 1. Confirm the two datasets share a CRS and overlap

```python
import json
import pdal
import rasterio
from rasterio.warp import transform_bounds

with rasterio.open("dop20_32_691_5335.tif") as img:
    img_epsg = img.crs.to_epsg()
    img_bounds = img.bounds
    print("orthophoto:", img_epsg, img.res, img.dtypes, img.count, "bands")

info = pdal.Pipeline(json.dumps({"pipeline": ["tile_691_5335.laz", {"type": "filters.info"}]}))
info.execute()
meta = info.metadata["metadata"]["filters.info"]
bbox = meta["bbox"]
print("cloud:", meta["srs"]["horizontal"][:40], "…", bbox)

assert img_epsg == 25832, "reproject the orthophoto to EPSG:25832 first (gdalwarp)"
assert img_bounds.left <= bbox["minx"] and img_bounds.right >= bbox["maxx"], "orthophoto does not cover the tile in x"
assert img_bounds.bottom <= bbox["miny"] and img_bounds.top >= bbox["maxy"], "orthophoto does not cover the tile in y"
```

`filters.colorization` samples the raster at each point's x and y in the point's own coordinates; it does not reproject between the cloud and the image. An orthophoto delivered in a different CRS — EPSG:4258 geographic coordinates, or Gauss-Krüger EPSG:31468 in an older German archive — produces either an error or colours sampled from the wrong place entirely. Reproject the image once with `gdalwarp -t_srs EPSG:25832` rather than the cloud.

### 2. Colourise with correct band mapping and scaling

```python
pipeline = {
    "pipeline": [
        "tile_691_5335.laz",
        {
            "type": "filters.colorization",
            "raster": "dop20_32_691_5335.tif",
            "dimensions": "Red:1:256.0, Green:2:256.0, Blue:3:256.0",
        },
        {
            "type": "writers.las",
            "filename": "tile_691_5335_rgb.laz",
            "minor_version": 4, "dataformat_id": 7,
            "compression": "laszip", "forward": "all", "a_srs": "EPSG:25832+7837",
        },
    ]
}
n = pdal.Pipeline(json.dumps(pipeline)).execute()
print(f"{n:,} points colourised")
```

Each entry in `dimensions` is `Name:band:scale`. The LAS specification stores colour as 16-bit unsigned integers, and most viewers expect 8-bit imagery to be scaled into that range; multiplying by 256 maps 255 to 65,280. Leaving the scale at 1 produces a cloud that some viewers render almost black, because 255 out of 65,535 is 0.4% brightness. An orthophoto with a near-infrared fourth band is common — CIR products put infrared in band 1 — so check the band order in the image metadata before trusting `1, 2, 3`.

<figure class="diagram">
<svg viewBox="74 -4 614 282" role="img" aria-labelledby="col-lean-t col-lean-d" xmlns="http://www.w3.org/2000/svg">
  <title id="col-lean-t">Why roof colour lands on the street in a standard orthophoto</title>
  <desc id="col-lean-d">A camera above and to the side of a building sees the roof displaced outward in a standard orthophoto, which was rectified to the terrain rather than to the building. The roof appears in the image over the street beside the building. Colourising ground points there gives them roof colours, and the wall points get pavement colours, while a true orthophoto rectified to a surface model places the roof correctly.</desc>
  <rect class="svg-bg" x="74" y="-4" width="614" height="282" fill="#ffffff"/>
  <path d="M40 210 H720" fill="none" stroke="#4f7a4d" stroke-width="2.5"/>
  <path d="M260 210 V110 H380 V210" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <circle cx="110" cy="40" r="10" fill="#1f2937"/>
  <path d="M110 50 L260 110" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M110 50 L380 110" fill="none" stroke="#5b6471" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M260 110 L410 210" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="3 3"/>
  <path d="M380 110 L530 210" fill="none" stroke="#b0413e" stroke-width="1.5" stroke-dasharray="3 3"/>
  <path d="M410 214 H530" fill="none" stroke="#b0413e" stroke-width="6"/>
  <path d="M260 214 H380" fill="none" stroke="#4f7a4d" stroke-width="6"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="110" y="24">camera</text>
    <text x="320" y="164">building</text>
  </g>
  <text x="470" y="238" fill="#b0413e" font-size="12.5" text-anchor="middle">standard ortho: roof shown here</text>
  <text x="300" y="260" fill="#4f7a4d" font-size="12.5" text-anchor="middle">true ortho: roof here</text>
  <text x="600" y="150" fill="#15384a" font-size="12.5" text-anchor="middle">displacement grows with</text>
  <text x="600" y="168" fill="#15384a" font-size="12.5" text-anchor="middle">height and view angle</text>
</svg>
<figcaption>A standard orthophoto is only geometrically correct at terrain height. Anything taller leans away from the image centre, and its colour is sampled by the wrong points.</figcaption>
</figure>

### 3. Colour only what the orthophoto can see

An orthophoto is a view from above. It carries valid colour for surfaces facing up — ground, roofs, crowns — and no information at all about walls. Compute normals, and colour only points whose surface faces the sky.

```python
pipeline = {
    "pipeline": [
        "tile_691_5335.laz",
        {"type": "filters.normal", "knn": 12},
        {"type": "filters.assign", "value": ["Red = 32896", "Green = 32896", "Blue = 32896"]},
        {
            "type": "filters.colorization",
            "raster": "dop20_32_691_5335.tif",
            "dimensions": "Red:1:256.0, Green:2:256.0, Blue:3:256.0",
            "where": "(Classification == 2 || Classification == 6 || Classification == 5) && NormalZ > 0.5",
        },
        {"type": "writers.las", "filename": "tile_691_5335_rgb.laz", "minor_version": 4,
         "dataformat_id": 7, "compression": "laszip", "forward": "all", "a_srs": "EPSG:25832+7837"},
    ]
}
pdal.Pipeline(json.dumps(pipeline)).execute()
```

The `where` option, available on most PDAL filters, applies the colourisation to a subset while leaving the other points untouched. Walls and low-confidence points first receive a neutral grey, so they are visibly "uncoloured" rather than silently carrying a colour from the pavement. `NormalZ > 0.5` keeps surfaces within 60° of horizontal, which includes pitched roofs; `filters.normal` orients normals upward by default, so the sign is meaningful for airborne data.

### 4. Measure the image-to-cloud offset

Even a well-georeferenced orthophoto can be shifted relative to the LiDAR by several pixels. Rasterise the cloud's intensity and compare it with the image's luminance.

```python
import numpy as np
from skimage.registration import phase_cross_correlation

res = 0.2
grid = {
    "pipeline": [
        "tile_691_5335.laz",
        {"type": "filters.range", "limits": "Classification[2:2]"},
        {"type": "writers.gdal", "filename": "intensity_020.tif", "resolution": res,
         "dimension": "Intensity", "output_type": "mean", "bounds":
         f"([{bbox['minx']},{bbox['maxx']}],[{bbox['miny']},{bbox['maxy']}])"},
    ]
}
pdal.Pipeline(json.dumps(grid)).execute()

with rasterio.open("intensity_020.tif") as a, rasterio.open("dop20_32_691_5335.tif") as ortho:
    lidar = a.read(1)
    window = rasterio.windows.from_bounds(*a.bounds, transform=ortho.transform)
    rgb = ortho.read((1, 2, 3), window=window, out_shape=(3, *lidar.shape)).astype("float32")
luma = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]

valid = np.isfinite(lidar) & (lidar > 0)
shift, error, _ = phase_cross_correlation(
    np.where(valid, lidar, 0), np.where(valid, luma, 0), upsample_factor=10
)
print(f"offset: {shift[1] * res:+.2f} m east, {-shift[0] * res:+.2f} m north (error {error:.3f})")
```

Ground-only intensity is compared because road markings, kerbs and field boundaries appear in both datasets without relief displacement. Phase correlation returns the shift in pixels, row first; a result within a pixel is good registration, and anything over a metre explains visible colour bleeding along every road edge. A consistent offset can be corrected by shifting the orthophoto's geotransform before colourisation.

Run the correlation on several windows across a large sheet rather than once for the whole image. A single global shift is typical when the orthophoto and the LiDAR were referenced to different realisations of ETRS89 or processed with different geoid models; a shift that varies smoothly across the sheet points instead at the digital terrain model used to rectify the imagery, which displaces the image wherever that model disagrees with the LiDAR ground. The first case is fixed by one translation. The second cannot be fixed by moving the image and is a reason to request a true orthophoto rectified against a current surface model, or to accept coloured ground points near slopes as approximate and document it in the output metadata.

<figure class="diagram">
<svg viewBox="-4 16 768 194" role="img" aria-labelledby="col-flow-t col-flow-d" xmlns="http://www.w3.org/2000/svg">
  <title id="col-flow-t">Colourisation pipeline with masking</title>
  <desc id="col-flow-d">The classified LAZ gets normals, then every point is set to neutral grey. Colourisation is applied only where the class is ground, building or high vegetation and the normal faces upward. The output is written as LAS 1.4 point format 7. In parallel, a ground intensity raster is correlated with the orthophoto to measure any offset, which feeds back into the colourisation as a corrected raster.</desc>
  <rect class="svg-bg" x="-4" y="16" width="768" height="194" fill="#ffffff"/>
  <defs>
    <marker id="col-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="10" y="30" width="110" height="56" rx="8" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="150" y="30" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="300" y="30" width="120" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="450" y="30" width="160" height="56" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="640" y="30" width="110" height="56" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="300" y="140" width="160" height="56" rx="8" fill="#ffffff" stroke="#5b6471" stroke-width="1.5"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#col-flow-arrow)">
    <path d="M120 58 H148"/><path d="M270 58 H298"/><path d="M420 58 H448"/><path d="M610 58 H638"/>
    <path d="M65 87 C65 168 200 168 298 168"/>
    <path d="M460 168 C530 168 530 110 530 88"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="65" y="54">classified</text><text x="65" y="71">LAZ</text>
    <text x="210" y="54">filters.normal</text><text x="210" y="71">knn = 12</text>
    <text x="360" y="54">assign</text><text x="360" y="71">neutral grey</text>
    <text x="530" y="54">colorization</text><text x="530" y="71">where: up-facing</text>
    <text x="695" y="54">LAS 1.4</text><text x="695" y="71">format 7</text>
    <text x="380" y="164">intensity vs ortho</text><text x="380" y="181">phase correlation</text>
  </g>
  <text x="575" y="126" fill="#5b6471" font-size="11.5" text-anchor="middle">corrected offset</text>
</svg>
<figcaption>The offset check runs once per orthophoto sheet and corrects the raster, so every tile colourised from that sheet benefits.</figcaption>
</figure>

## Expected Output & Verification

```text
orthophoto: 25832 (0.2, 0.2) ('uint8', 'uint8', 'uint8', 'uint8') 4 bands
cloud: PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS8 … {'maxx': 692000.0, 'maxy': 5336000.0, 'minx': 691000.0, 'miny': 5335000.0, …}
18,441,902 points colourised
offset: +0.14 m east, -0.06 m north (error 0.412)
```

Beyond the offset, check the colour distribution by class. Ground and roof points should have a wide spread of colours; a cluster of pure black (0, 0, 0) means points fell outside the image or on its nodata border, and a large share of mid-grey on roofs means the normal threshold is excluding pitched roofs.

```python
import laspy
import numpy as np

las = laspy.read("tile_691_5335_rgb.laz")
rgb = np.column_stack([las.red, las.green, las.blue])
for cls, name in ((2, "ground"), (6, "building"), (5, "high veg")):
    m = las.classification == cls
    grey = np.all(rgb[m] == 32896, axis=1).mean()
    black = np.all(rgb[m] == 0, axis=1).mean()
    print(f"{name:<9} {m.sum():>10,} pts | neutral {grey * 100:5.1f}% | black {black * 100:4.1f}%")
```

<figure class="diagram">
<svg viewBox="26 26 489 202" role="img" aria-labelledby="col-share-t col-share-d" xmlns="http://www.w3.org/2000/svg">
  <title id="col-share-t">Share of points left neutral by class</title>
  <desc id="col-share-d">Bars show the share of points left neutral grey after masked colourisation. Ground is about two percent neutral, mostly steep embankments. Buildings are about thirty-five percent neutral, the walls. High vegetation is about eight percent neutral, the sides of crowns. Black nodata points are under a tenth of a percent in every class.</desc>
  <rect class="svg-bg" x="26" y="26" width="489" height="202" fill="#ffffff"/>
  <path d="M40 30 V180" fill="none" stroke="#5b6471" stroke-width="1.5"/>
  <rect x="40" y="40" width="14" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <rect x="40" y="90" width="245" height="34" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="1.5"/>
  <rect x="40" y="140" width="56" height="34" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="12.5" text-anchor="start">
    <text x="66" y="62">ground: 2% — steep banks</text>
    <text x="297" y="112">building: 35% — walls, as intended</text>
    <text x="108" y="162">high vegetation: 8% — crown sides</text>
  </g>
  <text x="300" y="210" fill="#15384a" font-size="12.5" text-anchor="middle">points left neutral grey after masked colourisation</text>
</svg>
<figcaption>A third of building points staying neutral is the mask working: those are wall points an orthophoto never observed.</figcaption>
</figure>

## Common Errors

**`filters.colorization: Unable to open raster`.** GDAL cannot read the image path, often a VRT whose relative source paths broke when the job ran from another directory. Use absolute paths inside the VRT, or pass a single GeoTIFF.

**The whole cloud is nearly black in the viewer.** The scale was left at 1, so 8-bit values were stored as 16-bit colour. Rerun with a scale of 256, or rescale in place with `filters.assign` and `Red = Red * 256`.

**Colour stripes along one edge of every tile.** The orthophoto sheet ends inside the tile and the points beyond it received black. Build a VRT mosaic of neighbouring sheets and colourise against that, or buffer the image extent assertion in step 1.

## Frequently Asked Questions

### Should I colourise before or after classification?

After. Classification drives the mask, and colour does not help ground filters. Keep colourisation as a late, re-runnable step so it can be repeated when a newer orthophoto arrives without touching classification.

### Can I colour walls from street-level imagery instead?

Yes, but not with `filters.colorization`, which samples a single georeferenced raster in plan. Walls need projection from calibrated oblique or street-level cameras, which is a texture-mapping problem rather than a raster lookup.

### Does the orthophoto date matter much?

For roofs and roads, little; for vegetation and anything mobile, a great deal. A summer flight coloured from a winter orthophoto gives leaf-on crowns the colour of bare branches and the ground beneath them. Record both dates in the output metadata.

## Related Guides

- [Baking Normal and AO Maps for Web Delivery](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/baking-normal-and-ao-maps-for-web-delivery/) — surface detail for meshes rather than points
- [Extracting Building Footprints from Classified LiDAR](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/extracting-building-footprints-from-classified-lidar/) — the classes the mask depends on
- [Converting Point Clouds to 3D Tiles with py3dtiles](https://www.3d-geospatial.com/lod-management-optimization-strategies/automated-tile-generation/converting-point-clouds-to-3d-tiles-with-py3dtiles/) — streaming the coloured result

Back to [Texture Mapping Workflows for Digital Twins](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/texture-mapping-workflows/).
