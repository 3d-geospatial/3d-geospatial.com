# Converting WGS84 to Local Projected Coordinates

Converting WGS84 to local projected coordinates requires transforming spherical latitude/longitude (EPSG:4326) into a metric Cartesian plane using a defined map projection and geodetic transformation pipeline. The production-standard approach relies on the [PROJ engine](https://proj.org/usage/transformation.html) (via `pyproj` or GDAL) to apply ellipsoid flattening, datum shifts, and projection mathematics—typically Universal Transverse Mercator (UTM), State Plane, or a custom Transverse Mercator. For 3D digital twins, you must explicitly handle the vertical component by pairing the horizontal projection with a vertical CRS or geoid model to convert ellipsoidal heights to orthometric elevations. This ensures sub-centimeter alignment across BIM, LiDAR, and IoT datasets.

## Why Local Projections Matter in 3D Pipelines

Global coordinate systems introduce scale distortion and non-linear distance calculations that break engineering tolerances. Digital twin environments operate in local Cartesian space where CAD/BIM assets, point clouds, and simulation meshes expect uniform metric units (meters or feet). When integrating GPS, RTK, or satellite-derived positioning into site-scale twins, [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) dictate how spatial distortion is minimized across your project footprint.

Selecting a projection with minimal scale factor deviation (<1:10,000) at your site centroid prevents cumulative drift in asset registration. Mastering this transformation pipeline is foundational to [3D Geospatial Fundamentals for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/), particularly when aligning photogrammetric meshes, survey control networks, or sensor telemetry to engineering-grade models.

## Step-by-Step Conversion Workflow

1. **Identify the Optimal Local CRS**: Determine the projection that minimizes distortion for your site extent. UTM zones work for regional coverage, while State Plane or custom Transverse Mercator systems are preferred for municipal infrastructure. Verify the EPSG code or construct a custom PROJ string with your central meridian, false easting/northing, and scale factor.
2. **Define the Transformation Chain**: WGS84 → Target CRS requires a datum transformation. Modern PROJ automatically resolves grid shift files (NTv2, NADCON, or geoid TIFFs) when standard EPSG codes are used. Avoid hardcoding `+towgs84` parameters unless working in legacy or offline environments.
3. **Handle Vertical Coordinates via Compound CRS**: Geographic coordinates store ellipsoidal height, which differs from mean sea level by geoid undulation. For digital twins, specify a compound CRS using the combined EPSG authority string (e.g., `"EPSG:32618+5703"` for UTM Zone 18N + NAVD88) or apply a geoid correction before projection.
4. **Execute Vectorized Transformation**: Use array-backed operations to process thousands of points efficiently. Avoid Python loops; leverage the C-optimized backend in `pyproj` or `rasterio`. Always enforce `always_xy=True` to prevent coordinate axis order confusion.

## Production-Ready Python Implementation

The following snippet uses `pyproj` to handle 2D and 3D transformations safely, leveraging modern `Transformer` objects and NumPy vectorization. It demonstrates both horizontal projection and compound CRS handling for vertical alignment.

```python
import numpy as np
from pyproj import Transformer, CRS

# 1. Define source and target CRS
# WGS84 geographic 3D (EPSG:4326) -> UTM Zone 18N (EPSG:32618)
crs_source = CRS.from_epsg(4326)
crs_target_2d = CRS.from_epsg(32618)

# For 3D: Compound CRS string "EPSG:HORIZ+VERT"
# EPSG:32618 = UTM Zone 18N, EPSG:5703 = NAVD88 height
# pyproj accepts the combined authority string directly
crs_target_3d = CRS.from_authority("EPSG", "32618+5703")

# 2. Initialize Transformers (C-optimized, thread-safe)
transformer_2d = Transformer.from_crs(crs_source, crs_target_2d, always_xy=True)
transformer_3d = Transformer.from_crs(crs_source, crs_target_3d, always_xy=True)

# 3. Sample input data (lon, lat, ellipsoidal_height)
# Shape: (N, 3)
coords_wgs84 = np.array([
    [-73.9857, 40.7484, 15.2],   # NYC example
    [-74.0060, 40.7128, 8.5],
    [-73.9650, 40.7820, 22.1]
])

# 4. Vectorized 2D transformation (lon, lat -> easting, northing)
easting, northing = transformer_2d.transform(
    coords_wgs84[:, 0], coords_wgs84[:, 1]
)

# 5. Vectorized 3D transformation (lon, lat, ellipsoidal_h -> E, N, orthometric_h)
easting_3d, northing_3d, ortho_height = transformer_3d.transform(
    coords_wgs84[:, 0], coords_wgs84[:, 1], coords_wgs84[:, 2]
)

# 6. Output as structured array for downstream BIM/CAD ingestion
local_coords_2d = np.column_stack((easting, northing))
local_coords_3d = np.column_stack((easting_3d, northing_3d, ortho_height))

print("2D Local Coordinates:\n", local_coords_2d)
print("\n3D Local Coordinates (with orthometric heights):\n", local_coords_3d)
```

**Key Implementation Notes:**
- `always_xy=True` forces longitude/latitude order regardless of CRS axis definition, preventing silent coordinate swaps.
- Compound CRS is specified as a single authority string `"EPSG:32618+5703"` passed to `CRS.from_authority("EPSG", "32618+5703")`. Do not use the Python `+` operator on two `CRS` objects—that syntax is not valid in pyproj.
- The [pyproj Transformer API](https://pyproj4.github.io/pyproj/stable/api/transformer.html) caches transformation pipelines internally, making repeated calls highly efficient for streaming telemetry or large point clouds.
- Vertical transformation accuracy depends on PROJ's ability to download geoid grid files. Enable network access (`PROJ_NETWORK=ON`) or pre-cache grids to prevent silent fallback to ellipsoidal heights.

## Critical Validation & Pitfalls

| Pitfall | Impact | Mitigation |
|---------|--------|------------|
| **Axis Order Confusion** | Coordinates flipped (lat/lon vs lon/lat) | Always use `always_xy=True` or explicitly define `CRS.from_user_input("EPSG:4326").axis_info` |
| **Ignoring Geoid Separation** | 10–50m vertical drift in 3D twins | Use compound CRS authority string (`"EPSG:32618+5703"`) or apply `geoidgrids` via PROJ parameters |
| **Hardcoded `+towgs84`** | Inaccurate datum shifts across regions | Rely on EPSG codes; let PROJ auto-resolve NTv2/NADCON grids |
| **Loop-Based Transforms** | 100x+ slower on >10k points | Pass NumPy arrays directly to `transformer.transform()` |
| **Missing geoid grids** | Silent fallback to ellipsoidal Z | Set `PROJ_NETWORK=ON` or distribute grid files with your pipeline |

### Verification Checklist
1. **Scale Factor Check**: Confirm the projection's scale factor at your site centroid is ≤ 1.0001. Use `projinfo` to inspect distortion parameters for your chosen EPSG zone.
2. **Control Point Validation**: Transform 3–5 surveyed ground control points (GCPs) and compare against known local coordinates. Tolerances should stay within ±2cm for engineering-grade twins.
3. **Metadata Preservation**: Store the source EPSG, target EPSG, transformation date, and grid file versions alongside your dataset. Digital twin platforms require provenance for audit compliance.

## Next Steps

Once coordinates are projected locally, validate alignment by overlaying transformed point clouds against existing CAD/BIM geometry in a viewer like CesiumJS, Potree, or Autodesk Platform Services. Consistent CRS handling eliminates registration drift, enabling reliable spatial queries, clash detection, and sensor fusion across your infrastructure lifecycle.
