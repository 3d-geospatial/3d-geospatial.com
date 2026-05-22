# How to choose CRS for urban digital twins

Choose a **local projected coordinate system** (UTM, State Plane, or national grid) paired with a **geoid-referenced vertical datum** (orthometric height) to maintain sub-meter accuracy across both horizontal and vertical axes. Never use global geographic coordinates (WGS84 lat/lon) for core geometry storage in city-scale twins. Angular units introduce non-linear scale distortion, break spatial indexing, and cause floating-point precision loss when coordinates exceed 10⁶ meters. Store data in a single authoritative EPSG, transform on ingestion, and convert to 3D geographic only at the rendering or tiling layer.

## Decision Framework for Urban Scale

Selecting the right CRS requires evaluating four technical constraints before data ingestion. Treat these as non-negotiable gates for any production pipeline.

1. **Horizontal Projection Type**: Use conformal projections (e.g., Transverse Mercator) for engineering, surveying, and BIM alignment. Equal-area projections are only necessary for environmental modeling or land-use analytics. Verify that the projection's central meridian and scale factor keep distortion below `1:10,000` across your city's bounding box. Consult the [EPSG Geodetic Parameter Registry](https://epsg.org/) to confirm zone boundaries and recommended usage areas.
2. **Vertical Datum Separation**: Ellipsoidal heights (WGS84, ETRS89) measure distance from a mathematical ellipsoid. Orthometric heights (NAVD88, EVRF2007, EGM2008) measure distance from the geoid (mean sea level). The separation can exceed 50 meters depending on location. Urban twins require orthometric heights for flood simulation, utility grading, and sensor fusion. Always pair your horizontal EPSG with a compound vertical EPSG (e.g., `EPSG:7415` = ETRS89/UTM33N + EVRF2007 height).
3. **Precision & Floating-Point Limits**: Single-precision floats (32-bit) lose millimeter accuracy past ~16 km from the origin. Double-precision (64-bit) extends this to ~1000 km but increases memory overhead. Local projections keep coordinates within a manageable range (typically 300,000–700,000m Easting/Northing), preserving precision for LOD generation and collision detection.
4. **Metadata & Pipeline Consistency**: Document the EPSG in every layer, tileset, and database table. Automated pipelines will fail silently if vertical datums mismatch or if a CRS lacks a defined transformation path. Embed CRS metadata in GeoJSON, CityGML, and 3D Tiles headers to enforce schema validation at ingest.

## Python Validation & Transformation Pipeline

Use `pyproj` to validate CRS properties before ingestion and build a reusable transformer. The following snippet checks projection type, vertical datum presence, and prepares a coordinate transformer for downstream engines. Refer to the official [pyproj documentation](https://pyproj4.github.io/pyproj/stable/) for advanced transformation grid management.

```python
import pyproj
from pyproj import CRS, Transformer
from typing import Dict

def validate_urban_twin_crs(epsg_code: int) -> Dict:
    """
    Validates a CRS for urban digital twin storage.
    Returns a structured report with warnings and a ready-to-use transformer.
    """
    crs = CRS.from_epsg(epsg_code)
    report = {
        "epsg": epsg_code,
        "is_valid": True,
        "is_projected": False,
        "has_vertical_datum": False,
        "compound_epsg": None,
        "transformer": None,
        "warnings": []
    }

    # 1. Reject geographic (lat/lon) for core storage
    if crs.is_geographic:
        report["is_valid"] = False
        report["warnings"].append("Geographic CRS detected. Use a projected CRS for city-scale geometry.")
        return report

    report["is_projected"] = crs.is_projected

    # 2. Check for vertical datum (compound CRS)
    if crs.is_compound:
        report["has_vertical_datum"] = True
        report["compound_epsg"] = epsg_code
    else:
        report["warnings"].append("No vertical datum defined. Pair with a geoid-based height system (e.g., NAVD88, EGM2008).")

    # 3. Build transformer to WGS84 3D (EPSG:4979) for rendering/tiling
    try:
        target_crs = CRS.from_epsg(4979)  # WGS84 3D (lat, lon, ellipsoidal height)
        report["transformer"] = Transformer.from_crs(crs, target_crs, always_xy=True)
    except pyproj.exceptions.CRSError as e:
        report["warnings"].append(f"Transformation path unavailable: {e}")

    return report

# Usage example
if __name__ == "__main__":
    # EPSG:32632 = WGS84 / UTM zone 32N (horizontal only)
    result = validate_urban_twin_crs(32632)
    print(result["warnings"])
    
    # If valid, transform a sample coordinate
    if result["transformer"]:
        x, y, z = 500000.0, 6000000.0, 45.2
        lon, lat, h = result["transformer"].transform(x, y, z)
        print(f"Transformed to WGS84 3D: {lon:.6f}, {lat:.6f}, {h:.3f}")
```

## Pipeline Integration & Rendering Considerations

Once validated, lock the authoritative CRS at the database level. PostgreSQL/PostGIS, DuckDB Spatial, or cloud-native data lakes should store all base geometry in the chosen projected EPSG. Apply transformations only at the edge of your pipeline:

* **Ingestion Layer**: Convert incoming CAD, BIM, or survey data to the target CRS using `pyproj` or GDAL. Strip redundant metadata and enforce compound vertical datums before committing to storage.
* **Query & Analysis Layer**: Run spatial joins, buffer operations, and volumetric calculations in the local projection. This guarantees metric accuracy and avoids the computational overhead of on-the-fly geographic conversions.
* **Visualization & Tiling Layer**: Convert to `EPSG:4979` (WGS84 3D) or `EPSG:4326` only when generating 3D Tiles, CesiumJS scenes, or WebGL meshes. Modern rendering engines expect geographic coordinates for globe placement, but they handle the final projection matrix internally.

Understanding how these parameters interact is foundational to the [Coordinate Reference Systems for 3D Assets](/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) workflow, where precision loss during transformation directly impacts spatial queries, mesh generation, and real-time synchronization.

### Common Pitfalls to Avoid
* **Mixing Ellipsoidal and Orthometric Heights**: Sensor networks (LiDAR, GNSS RTK) often output ellipsoidal heights by default. Failing to apply a geoid model before ingestion will misalign infrastructure models by meters.
* **Assuming Web Mercator is Suitable**: `EPSG:3857` is designed for web maps, not engineering. It introduces severe area and distance distortion at mid-latitudes, making it unsuitable for flood modeling, utility routing, or BIM integration.
* **Ignoring Transformation Grids**: Default `pyproj` or GDAL transformations may fall back to approximate Helmert shifts if NADCON, NTv2, or EGM grids are missing. Always distribute grid files alongside your pipeline or use cloud-hosted transformation services.

For teams scaling beyond a single municipality, establish a CRS registry that maps regional zones to standardized transformation chains. This ensures interoperability when merging adjacent digital twins or integrating national open-data portals. The broader [3D Geospatial Fundamentals for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/) guide covers how these coordinate strategies align with semantic modeling, real-time IoT ingestion, and multi-resolution rendering pipelines.