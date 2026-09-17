---
title: "Validating Attribute Tables with Pandera"
description: "Catch bad building attributes before they reach a tileset: Pandera schemas for GeoDataFrames, cross-field checks, geometry validity"
---
# Validating Attribute Tables with Pandera

This page validates the attribute table behind a city model with Pandera — declaring a schema for a GeoDataFrame, expressing the cross-field rules that catch real data errors, handling nullability honestly, checking geometry validity alongside the attributes, and producing a report that fails CI with a list of offending rows rather than a stack trace.

## Why you hit this

A building's attributes end up in a tileset's property table and drive styling, filtering and analysis. A height of 3,400 m, a construction year of 20226, a `NULL` where a required identifier should be, or a footprint area that disagrees with the geometry by a factor of ten — all of these pass through a tiling pipeline silently and appear in a viewer as a tower to the stratosphere or a filter that returns nothing.

The attributes are also the part of the data that changes most often. Geometry is delivered once a year; attributes are updated monthly from a register, and each update is an opportunity for a new category, a changed unit or a column that was renamed.

Pandera makes the schema executable: it is declared once in code, checked on every ingest, and fails with the rows that broke it.

## Prerequisites

- Python 3.10+ with `pandera>=0.19`, `pandas`, `geopandas`, `shapely`.
- The attribute table as a GeoDataFrame — from a GeoPackage, PostGIS or a CityGML parse.
- The register's documentation, or enough domain knowledge to state the rules.

## Step-by-Step

### 1. Declare the column schema

```python
import json
from datetime import date
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import pandera.pandas as pa
from pandera.typing import Series

CURRENT_YEAR = date.today().year

BUILDING_FUNCTIONS = {
    "residential", "commercial", "industrial", "civic", "mixed",
    "agricultural", "utility", "unknown",
}

QUALITY_LEVELS = {"surveyed", "photogrammetric", "extruded_footprint", "estimated"}

building_schema = pa.DataFrameSchema(
    {
        "register_id": pa.Column(
            str,
            checks=[
                pa.Check.str_matches(r"^[A-Z]{3}-\d{8}$",
                                     error="register_id must look like OSL-00412088"),
            ],
            nullable=False, unique=True, required=True,
            description="the authoritative property-register identifier",
        ),
        "function": pa.Column(
            str,
            checks=[pa.Check.isin(BUILDING_FUNCTIONS,
                                  error="function outside the controlled vocabulary")],
            nullable=False, required=True,
        ),
        "measured_height_m": pa.Column(
            float,
            checks=[
                pa.Check.greater_than(1.5, error="a building under 1.5 m is a shed "
                                                 "or a data error"),
                pa.Check.less_than(450.0, error="no building here exceeds 450 m"),
            ],
            nullable=True, required=True,
            description="eaves-to-ground height in metres; null where not measured",
        ),
        "storeys_above_ground": pa.Column(
            "Int16",
            checks=[pa.Check.in_range(0, 170, error="storey count implausible")],
            nullable=True, required=True,
        ),
        "year_of_construction": pa.Column(
            "Int16",
            checks=[
                pa.Check.in_range(800, CURRENT_YEAR + 2,
                                  error=f"year must be between 800 and "
                                        f"{CURRENT_YEAR + 2}"),
            ],
            nullable=True, required=True,
        ),
        "footprint_area_m2": pa.Column(
            float,
            checks=[pa.Check.greater_than(4.0), pa.Check.less_than(250_000.0)],
            nullable=False, required=True,
        ),
        "data_quality": pa.Column(
            str,
            checks=[pa.Check.isin(QUALITY_LEVELS)],
            nullable=False, required=True,
        ),
        "last_surveyed": pa.Column(
            "datetime64[ns]",
            checks=[pa.Check.le(pd.Timestamp.now(), error="survey date in the future")],
            nullable=True, required=False,
        ),
    },
    strict="filter",
    coerce=True,
    name="building_attributes",
)
```

`strict="filter"` rather than `True` or `False` is the setting that makes this survivable on real data. `True` fails when the table has any extra column, which it always does; `False` ignores them silently; `filter` drops them and keeps going, so the schema defines exactly what the pipeline consumes and the register's forty other columns are simply not carried forward.

`coerce=True` is what turns a `year_of_construction` read from a GeoPackage as a float into an `Int16`, which is the type the property table wants. Without it, a nullable integer column read through pandas arrives as `float64` and fails the type check for reasons that have nothing to do with the data.

The nullable pattern is the important editorial decision: `register_id` and `function` are `nullable=False` because a building without them cannot be styled or joined, while `measured_height_m` is `nullable=True` because "not measured" is a real state that must be distinguishable from zero. Forcing a default onto a missing height is how a city ends up with a thousand 3 m buildings.

Putting the error message in each check is worth the extra characters: the failure report quotes it, so a reviewer sees "no building here exceeds 450 m" rather than `less_than(450.0)`.

<figure class="diagram">
<svg viewBox="4 6 732 244" role="img" aria-labelledby="pandera-null-t pandera-null-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pandera-null-t">Nullability policy per column, and what each choice costs</title>
  <desc id="pandera-null-d">A table of five columns with their nullability decision. Register id is not nullable because a building without it cannot be joined to the register. Function is not nullable, with an explicit unknown category instead. Measured height is nullable because not measured is a real state that must differ from zero. Year of construction is nullable for the same reason. Footprint area is not nullable because it can always be computed from the geometry. Each row states what goes wrong if the opposite choice is made.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="244" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="196" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="214" y="20" width="126" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="340" y="20" width="382" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="196" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="54" width="126" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="340" y="54" width="382" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="92" width="196" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="92" width="126" height="38" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="340" y="92" width="382" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="130" width="196" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="130" width="126" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="340" y="130" width="382" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="18" y="168" width="196" height="38" fill="#ffffff" stroke="#5b6471"/>
    <rect x="214" y="168" width="126" height="38" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="340" y="168" width="382" height="38" fill="#ffffff" stroke="#5b6471"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="116" y="41">column</text><text x="277" y="41">nullable?</text>
    <text x="531" y="41">the reason</text>
  </g>
  <g fill="#1f2937" font-size="12.5">
    <text x="28" y="78">register_id</text>
    <text x="350" y="78">a building with no id cannot be joined or picked</text>
    <text x="28" y="116">function</text>
    <text x="350" y="116">use an explicit "unknown" category, not a null</text>
    <text x="28" y="154">measured_height_m</text>
    <text x="350" y="154">"not measured" must differ from a 3 m default</text>
    <text x="28" y="192">year_of_construction</text>
    <text x="350" y="192">a default year creates a fake cluster in every chart</text>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="277" y="78">no</text><text x="277" y="116">no</text>
    <text x="277" y="154">yes</text><text x="277" y="192">yes</text>
  </g>
  <text x="370" y="232" fill="#5b6471" font-size="12" text-anchor="middle">a nullable column needs a noData value in the tileset schema; a non-nullable one does not</text>
</svg>
<figcaption>Nullability is a data-modelling decision with a downstream consequence: every nullable column needs a declared noData value in the tileset's metadata schema.</figcaption>
</figure>

### 2. Add the cross-field checks that catch real errors

```python
def storeys_consistent_with_height(df: pd.DataFrame) -> pd.Series:
    """A storey is 2.4 to 5.5 m; the pair must be mutually plausible."""
    h = df["measured_height_m"]
    s = df["storeys_above_ground"]
    known = h.notna() & s.notna() & (s > 0)
    per_storey = h.where(known) / s.where(known)
    return ~known | per_storey.between(2.2, 6.0)

def height_consistent_with_function(df: pd.DataFrame) -> pd.Series:
    limits = {"agricultural": 25.0, "utility": 120.0, "residential": 180.0,
              "commercial": 450.0, "industrial": 90.0, "civic": 160.0,
              "mixed": 450.0, "unknown": 450.0}
    ceiling = df["function"].map(limits).fillna(450.0)
    return df["measured_height_m"].isna() | (df["measured_height_m"] <= ceiling)

def quality_implies_measurement(df: pd.DataFrame) -> pd.Series:
    """A 'surveyed' building must actually have a measured height."""
    return (df["data_quality"] != "surveyed") | df["measured_height_m"].notna()

def survey_after_construction(df: pd.DataFrame) -> pd.Series:
    known = df["last_surveyed"].notna() & df["year_of_construction"].notna()
    return ~known | (df["last_surveyed"].dt.year >= df["year_of_construction"])

building_schema = building_schema.add_checks([
    pa.Check(storeys_consistent_with_height,
             error="height and storey count imply an implausible storey height",
             element_wise=False),
    pa.Check(height_consistent_with_function,
             error="height exceeds what this building function plausibly reaches",
             element_wise=False),
    pa.Check(quality_implies_measurement,
             error="data_quality is 'surveyed' but measured_height_m is null",
             element_wise=False),
    pa.Check(survey_after_construction,
             error="last_surveyed predates year_of_construction",
             element_wise=False),
])
```

Cross-field checks are where the real errors live, because a single column's range is easy to get right and the relationship between two columns is not. A height of 68 m passes the range check and a storey count of 3 passes its own; together they imply 22.7 m per storey, which is the signature of a height recorded in feet or a storey count that means "floors above the entrance".

`quality_implies_measurement` catches a specific and common register problem: a quality flag saying the building was surveyed while the height column is empty, because the survey recorded something the import did not carry across.

Returning a boolean Series from a DataFrame-level check, rather than using `element_wise=True`, keeps these vectorised. An element-wise check over 412,000 rows in Python is minutes; the vectorised form is milliseconds.

### 3. Validate the geometry alongside the attributes

```python
def geometry_report(gdf, expected_epsg=25832, area_tolerance=0.05,
                    min_area_m2=4.0):
    geom = gdf.geometry
    findings = []
    rows = pd.DataFrame(index=gdf.index)

    if gdf.crs is None:
        findings.append({"severity": "error", "issue": "GeoDataFrame has no CRS"})
    elif gdf.crs.to_epsg() != expected_epsg:
        findings.append({
            "severity": "error",
            "issue": f"CRS is EPSG:{gdf.crs.to_epsg()}, expected EPSG:{expected_epsg}",
        })

    rows["is_empty"] = geom.is_empty
    rows["is_missing"] = geom.isna()
    rows["is_invalid"] = ~geom.is_valid
    rows["wrong_type"] = ~geom.geom_type.isin(["Polygon", "MultiPolygon"])
    rows["too_small"] = geom.area < min_area_m2

    computed = geom.area
    declared = gdf["footprint_area_m2"]
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = (computed / declared.replace(0, np.nan)).fillna(np.inf)
    rows["area_mismatch"] = (ratio - 1.0).abs() > area_tolerance
    rows["area_ratio"] = ratio.round(3)

    for name, mask in (("empty geometry", rows["is_empty"]),
                       ("missing geometry", rows["is_missing"]),
                       ("invalid geometry", rows["is_invalid"]),
                       ("non-polygon geometry", rows["wrong_type"]),
                       ("footprint under the minimum", rows["too_small"]),
                       ("declared area disagrees with the geometry",
                        rows["area_mismatch"])):
        n = int(mask.sum())
        if n:
            findings.append({
                "severity": "error" if name != "footprint under the minimum" else "warn",
                "issue": f"{n} row(s): {name}",
                "examples": gdf.loc[mask, "register_id"].head(4).tolist(),
            })

    return {
        "rows": len(gdf),
        "findings": findings,
        "errors": sum(1 for f in findings if f["severity"] == "error"),
        "area_ratio_summary": {
            "p05": round(float(ratio.replace([np.inf, -np.inf], np.nan)
                               .quantile(0.05)), 3),
            "p50": round(float(ratio.replace([np.inf, -np.inf], np.nan)
                               .quantile(0.50)), 3),
            "p95": round(float(ratio.replace([np.inf, -np.inf], np.nan)
                               .quantile(0.95)), 3),
        },
        "detail": rows,
    }
```

Comparing the declared area against the geometry's computed area is the check that catches a unit error and a geometry-attribute mismatch in one test. A ratio clustered around 10.76 means the declared area is in square feet; a ratio around 1.0 for most rows and 0.1 for a few means those rows' geometry was replaced without updating the attribute.

The area ratio's **distribution** is more informative than the count of failures. A p50 of 1.0 with a p95 of 1.04 is rounding; a p50 of 10.76 is a unit conversion the whole table needs.

Checking the CRS explicitly matters because `geom.area` on a geographic CRS returns square degrees, which compare to square metres as nonsense — and GeoPandas will happily compute it without warning.

<figure class="diagram">
<svg viewBox="4 6 732 236" role="img" aria-labelledby="pandera-cross-t pandera-cross-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pandera-cross-t">Why single-column checks miss the real errors</title>
  <desc id="pandera-cross-d">Four rows of building attributes. A height of 68.4 metres passes its own range check and a storey count of 3 passes its own, but together they imply 22.8 metres per storey, which the cross-field check rejects. A height of 120 metres passes for a commercial building and fails for an agricultural one. A quality flag of surveyed with a null height passes both column checks and fails the cross-field rule. Only the last row is genuinely consistent.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="236" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="126" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="144" y="20" width="96" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="240" y="20" width="96" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="336" y="20" width="126" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="462" y="20" width="120" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="582" y="20" width="140" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="126" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="144" y="54" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="54" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="336" y="54" width="126" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="54" width="120" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="582" y="54" width="140" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="90" width="126" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="144" y="90" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="90" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="336" y="90" width="126" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="90" width="120" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="582" y="90" width="140" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="126" width="126" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="144" y="126" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="126" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="336" y="126" width="126" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="126" width="120" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="582" y="126" width="140" height="36" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="162" width="126" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="144" y="162" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="240" y="162" width="96" height="36" fill="#ffffff" stroke="#5b6471"/>
    <rect x="336" y="162" width="126" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="462" y="162" width="120" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="582" y="162" width="140" height="36" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="81" y="41">function</text><text x="192" y="41">height</text>
    <text x="288" y="41">storeys</text><text x="399" y="41">column checks</text>
    <text x="522" y="41">cross-field</text><text x="652" y="41">what it means</text>
    <text x="81" y="77">residential</text><text x="192" y="77">68.4 m</text>
    <text x="288" y="77">3</text><text x="399" y="77">both pass</text>
    <text x="522" y="77">fails</text><text x="652" y="77">22.8 m per storey</text>
    <text x="81" y="113">agricultural</text><text x="192" y="113">120.0 m</text>
    <text x="288" y="113">2</text><text x="399" y="113">both pass</text>
    <text x="522" y="113">fails</text><text x="652" y="113">a 120 m barn</text>
    <text x="81" y="149">civic</text><text x="192" y="149">null</text>
    <text x="288" y="149">4</text><text x="399" y="149">both pass</text>
    <text x="522" y="149">fails</text><text x="652" y="149">"surveyed", no height</text>
    <text x="81" y="185">residential</text><text x="192" y="185">14.2 m</text>
    <text x="288" y="185">5</text><text x="399" y="185">both pass</text>
    <text x="522" y="185">passes</text><text x="652" y="185">consistent</text>
  </g>
  <text x="370" y="224" fill="#5b6471" font-size="12" text-anchor="middle">every row passes every single-column range check; three of the four are wrong</text>
</svg>
<figcaption>Single-column ranges are easy to get right and catch almost nothing; the relationships between columns are where the errors are.</figcaption>
</figure>

### 4. Run the validation and collect the failures usefully

```python
def validate(gdf, schema=building_schema, expected_epsg=25832,
             sample_failures=6):
    result = {"rows_in": len(gdf)}
    geometry = geometry_report(gdf, expected_epsg=expected_epsg)
    result["geometry"] = {k: v for k, v in geometry.items() if k != "detail"}

    attributes = gdf.drop(columns=[gdf.geometry.name])
    try:
        validated = schema.validate(attributes, lazy=True)
        result["attributes"] = {"passed": True, "rows_out": len(validated),
                                "failure_cases": []}
        result["validated"] = validated
    except pa.errors.SchemaErrors as exc:
        cases = exc.failure_cases
        grouped = []
        for (check, column), part in cases.groupby(["check", "column"], dropna=False):
            grouped.append({
                "check": str(check),
                "column": str(column),
                "count": int(len(part)),
                "example_values": part["failure_case"].head(sample_failures)
                                      .astype(str).tolist(),
                "example_indices": part["index"].head(sample_failures).tolist(),
            })
        grouped.sort(key=lambda g: -g["count"])
        result["attributes"] = {
            "passed": False,
            "total_failure_cases": int(len(cases)),
            "distinct_checks_failed": len(grouped),
            "by_check": grouped[:12],
        }
        result["validated"] = None

    result["pass"] = (result["attributes"]["passed"]
                      and geometry["errors"] == 0)
    return result
```

`lazy=True` is the option that turns this from a debugging exercise into a report. Without it, Pandera raises on the first failing check and says nothing about the other eleven; with it, every check runs and `failure_cases` is a DataFrame of every offending row, column and value.

Grouping the failure cases by check and column, sorted by count, is what makes the output actionable. "4,182 rows fail `isin(BUILDING_FUNCTIONS)` with values `['agricultural_other', 'garage']`" is a decision about the vocabulary; a flat list of 4,182 row indices is not.

Carrying the example indices through lets a reviewer open those rows in QGIS immediately, which is the difference between a report that gets acted on and one that gets filed.

### 5. Separate blocking failures from quarantine

```python
BLOCKING_CHECKS = {
    "not_nullable",
    "field_uniqueness",
    "str_matches",           # register_id format
    "isin",                  # controlled vocabularies
}

def triage(result, blocking=BLOCKING_CHECKS, max_quarantine_fraction=0.02):
    attrs = result["attributes"]
    if attrs["passed"]:
        return {"action": "accept", "blocking": [], "quarantine_rows": 0}

    blocking_findings, quarantinable = [], []
    for group in attrs["by_check"]:
        name = group["check"].split("(")[0].strip()
        if name in blocking or "not_nullable" in group["check"]:
            blocking_findings.append(group)
        else:
            quarantinable.append(group)

    quarantine_rows = sum(g["count"] for g in quarantinable)
    fraction = quarantine_rows / max(result["rows_in"], 1)

    if blocking_findings:
        action = "reject"
    elif fraction > max_quarantine_fraction:
        action = "reject"
    else:
        action = "accept_with_quarantine"

    return {
        "action": action,
        "blocking": blocking_findings[:6],
        "quarantinable": quarantinable[:6],
        "quarantine_rows": quarantine_rows,
        "quarantine_fraction": round(fraction, 5),
        "reason": ("structural failures cannot be quarantined"
                   if blocking_findings
                   else f"{fraction:.2%} of rows would be quarantined, above the "
                        f"{max_quarantine_fraction:.0%} limit"
                   if fraction > max_quarantine_fraction
                   else f"{quarantine_rows} row(s) set aside for review"),
    }

def split_quarantine(gdf, result, schema=building_schema):
    """Produce a clean table and a quarantine table with the reason attached."""
    attrs = gdf.drop(columns=[gdf.geometry.name])
    try:
        schema.validate(attrs, lazy=True)
        return gdf, gdf.iloc[0:0].assign(quarantine_reason=pd.Series(dtype=str))
    except pa.errors.SchemaErrors as exc:
        cases = exc.failure_cases
        reasons = (cases.dropna(subset=["index"])
                        .groupby("index")["check"]
                        .apply(lambda s: "; ".join(sorted(set(s.astype(str))))[:300]))
        bad_index = reasons.index
        clean = gdf.loc[~gdf.index.isin(bad_index)].copy()
        quarantine = gdf.loc[gdf.index.isin(bad_index)].copy()
        quarantine["quarantine_reason"] = reasons.reindex(quarantine.index).values
        return clean, quarantine
```

Distinguishing blocking from quarantinable failures is what keeps a monthly ingest running. A duplicate `register_id` or a missing identifier is structural — the rest of the table cannot be trusted, so the ingest stops. An implausible height on 40 buildings out of 412,000 is a data-quality issue that should not block a city update.

Attaching the reason to each quarantined row and writing it out as a layer is what makes the quarantine useful rather than a black hole: the register's maintainer gets a GeoPackage of 40 buildings with "height and storey count imply an implausible storey height" against each one.

The fraction limit is the safeguard against the quarantine becoming the ingest: if 15% of rows are being set aside, something changed upstream and the schema or the data needs attention rather than a filter.

### 6. Report it in CI

```python
def ci_report(result, triage_result, out_dir="build/validation"):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    report = {
        "rows_in": result["rows_in"],
        "pass": result["pass"],
        "action": triage_result["action"],
        "geometry_errors": result["geometry"]["errors"],
        "geometry_findings": result["geometry"]["findings"][:6],
        "area_ratio": result["geometry"]["area_ratio_summary"],
        "attribute_checks_failed": result["attributes"].get("distinct_checks_failed", 0),
        "top_failures": result["attributes"].get("by_check", [])[:6],
        "quarantine_rows": triage_result["quarantine_rows"],
        "reason": triage_result.get("reason", ""),
    }
    Path(out_dir, "report.json").write_text(json.dumps(report, indent=2))

    lines = [f"# Attribute validation — {report['rows_in']:,} rows", ""]
    lines.append(f"**Action: {report['action']}** — {report['reason']}")
    lines.append("")
    if report["geometry_findings"]:
        lines.append("## Geometry")
        for f in report["geometry_findings"]:
            lines.append(f"- **{f['severity']}**: {f['issue']}")
        lines.append("")
    if report["top_failures"]:
        lines.append("## Attributes")
        lines.append("| column | check | rows | examples |")
        lines.append("| --- | --- | --- | --- |")
        for g in report["top_failures"]:
            examples = ", ".join(g["example_values"][:3])
            lines.append(f"| `{g['column']}` | {g['check']} | {g['count']} "
                         f"| {examples} |")
    Path(out_dir, "report.md").write_text("\n".join(lines))
    return {"json": str(Path(out_dir, "report.json")),
            "markdown": str(Path(out_dir, "report.md")),
            "exit_code": 0 if triage_result["action"] != "reject" else 1}
```

```yaml
# .github/workflows/attributes.yml
name: attribute validation
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - name: Validate the attribute table
        run: python -m pipeline.validate data/buildings.gpkg --out build/validation
      - name: Publish the report
        if: always()
        run: cat build/validation/report.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: validation
          path: |
            build/validation/report.json
            build/validation/quarantine.gpkg
```

Writing the report to `GITHUB_STEP_SUMMARY` puts the failing table in front of whoever opened the pull request, which is the difference between a red cross they have to dig into and a table they can read. Uploading the quarantine GeoPackage means the rows are one download from a map.

<figure class="diagram">
<svg viewBox="2 16 734 246" role="img" aria-labelledby="pandera-triage-t pandera-triage-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pandera-triage-t">Triage: reject, quarantine or accept</title>
  <desc id="pandera-triage-d">A decision flow. The validation produces failure cases. Structural failures such as a duplicate identifier, a null identifier or a value outside a controlled vocabulary are blocking and the ingest is rejected. Other failures such as an implausible height or an inconsistent storey count are quarantinable. If the quarantined rows exceed two percent of the table the ingest is also rejected, because something changed upstream. Otherwise the clean rows are accepted and the quarantined rows are written out with a reason for review.</desc>
  <rect class="svg-bg" x="2" y="16" width="734" height="246" fill="#ffffff"/>
  <defs>
    <marker id="pandera-triage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="16" y="100" width="130" height="54" rx="7" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <rect x="200" y="30" width="180" height="54" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="200" y="168" width="180" height="54" rx="7" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2"/>
  <rect x="436" y="168" width="140" height="54" rx="7" fill="#f7dfdc" stroke="#b0413e" stroke-width="2"/>
  <rect x="436" y="96" width="140" height="54" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <rect x="616" y="96" width="106" height="54" rx="7" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" fill="none" marker-end="url(#pandera-triage-arrow)">
    <path d="M146 116 L198 76"/>
    <path d="M146 140 L198 182"/>
    <path d="M380 195 H434"/>
    <path d="M380 178 L434 140"/>
    <path d="M576 123 H614"/>
  </g>
  <g fill="#1f2937" font-size="12" text-anchor="middle">
    <text x="81" y="122">failure cases</text><text x="81" y="140">from Pandera</text>
    <text x="290" y="50">structural: duplicate id,</text><text x="290" y="68">null id, bad vocabulary</text>
    <text x="290" y="188">value-level: implausible</text><text x="290" y="206">height, storey mismatch</text>
    <text x="506" y="188">&gt; 2% of rows:</text><text x="506" y="206">reject</text>
    <text x="506" y="116">≤ 2%: accept</text><text x="506" y="134">with quarantine</text>
    <text x="669" y="116">clean table</text><text x="669" y="134">to the tileset</text>
  </g>
  <text x="290" y="100" fill="#b0413e" font-size="12" text-anchor="middle">→ reject the ingest</text>
  <text x="370" y="244" fill="#5b6471" font-size="12" text-anchor="middle">quarantined rows are written out with their reason attached, so the register's owner can fix them</text>
</svg>
<figcaption>Structural failures stop the ingest; value-level failures are quarantined, unless there are so many that something upstream changed.</figcaption>
</figure>

## Expected Output & Verification

```text
{
  "rows_in": 412418,
  "geometry": {
    "rows": 412418, "errors": 1,
    "findings": [
      {"severity": "error", "issue": "7 row(s): invalid geometry",
       "examples": ["OSL-00412088", "OSL-00418204", "OSL-00441882"]},
      {"severity": "warn", "issue": "184 row(s): footprint under the minimum"}
    ],
    "area_ratio_summary": {"p05": 0.998, "p50": 1.0, "p95": 1.004}
  },
  "attributes": {
    "passed": false,
    "total_failure_cases": 4841,
    "distinct_checks_failed": 5,
    "by_check": [
      {"check": "isin({'agricultural', 'civic', …})", "column": "function",
       "count": 4182,
       "example_values": ["garage", "garage", "agricultural_other"],
       "example_indices": [1841, 1902, 2118]},
      {"check": "height and storey count imply an implausible storey height",
       "column": null, "count": 412,
       "example_values": ["68.4", "71.2", "64.8"]},
      {"check": "data_quality is 'surveyed' but measured_height_m is null",
       "column": null, "count": 184, "example_values": ["surveyed"]},
      {"check": "field_uniqueness", "column": "register_id", "count": 58,
       "example_values": ["OSL-00318204", "OSL-00318204"]},
      {"check": "year must be between 800 and 2027",
       "column": "year_of_construction", "count": 5,
       "example_values": ["20226", "1", "3021"]}
    ]
  },
  "pass": false
}
{
  "action": "reject",
  "reason": "structural failures cannot be quarantined",
  "blocking": [
    {"check": "isin({'agricultural', 'civic', …})", "column": "function",
     "count": 4182},
    {"check": "field_uniqueness", "column": "register_id", "count": 58}
  ],
  "quarantine_rows": 601,
  "quarantine_fraction": 0.00146
}
```

The 4,182 rows with `function` values of `garage` and `agricultural_other` are the interesting finding: the register added two categories, and the correct response is a vocabulary update rather than a data fix. That is why vocabulary failures are blocking — the schema is out of date and every subsequent ingest will fail the same way until it is fixed.

The 58 duplicate `register_id` values are the other blocking finding, and they matter because the identifier is the join key into the tileset's property table; a duplicate means two buildings claim the same metadata row.

An area ratio p50 of exactly 1.0 with a p95 of 1.004 confirms the declared areas and the geometry agree, so no unit error is present in this table.

Verify the schema itself catches what it claims, by validating a table with deliberate defects:

```python
def schema_self_test(schema=building_schema):
    """Each row is one deliberate defect; every one must be caught."""
    base = {
        "register_id": "OSL-00412088", "function": "residential",
        "measured_height_m": 14.2, "storeys_above_ground": 5,
        "year_of_construction": 1968, "footprint_area_m2": 184.2,
        "data_quality": "photogrammetric", "last_surveyed": pd.Timestamp("2024-06-01"),
    }
    cases = {
        "bad_id_format": {**base, "register_id": "412088"},
        "null_id": {**base, "register_id": None},
        "unknown_function": {**base, "function": "garage"},
        "height_too_large": {**base, "measured_height_m": 3400.0},
        "height_too_small": {**base, "measured_height_m": 0.4},
        "year_in_the_future": {**base, "year_of_construction": 3021},
        "storey_height_implausible": {**base, "measured_height_m": 68.4,
                                     "storeys_above_ground": 3},
        "agricultural_skyscraper": {**base, "function": "agricultural",
                                    "measured_height_m": 120.0},
        "surveyed_without_height": {**base, "data_quality": "surveyed",
                                    "measured_height_m": None},
        "survey_before_construction": {**base, "year_of_construction": 2020,
                                       "last_surveyed": pd.Timestamp("2010-01-01")},
    }
    results = {}
    for name, row in cases.items():
        df = pd.DataFrame([row])
        try:
            schema.validate(df, lazy=True)
            results[name] = {"caught": False}
        except pa.errors.SchemaErrors as exc:
            checks = sorted(set(exc.failure_cases["check"].astype(str)))
            results[name] = {"caught": True, "by": checks[:2]}

    clean = pd.DataFrame([base])
    try:
        schema.validate(clean, lazy=True)
        results["clean_row_passes"] = {"caught": False, "passes": True}
    except pa.errors.SchemaErrors as exc:
        results["clean_row_passes"] = {
            "passes": False,
            "unexpected_failures": sorted(set(exc.failure_cases["check"].astype(str))),
        }

    missed = [k for k, v in results.items()
              if k != "clean_row_passes" and not v["caught"]]
    return {"cases": results, "missed": missed,
            "all_caught": not missed,
            "clean_passes": results["clean_row_passes"].get("passes", False)}

print(json.dumps(schema_self_test(), indent=2))
```

Ten defects, all of which must be caught, plus one clean row that must pass. This is the test that stops a schema from silently becoming permissive — a check with a typo in the column name simply never fires, and nothing else would notice.

Then verify the schema against a **previous** accepted table, so a tightened rule is not applied retroactively by surprise:

```python
def regression_against_last_accepted(current_gdf, previous_gpkg,
                                     schema=building_schema):
    previous = gpd.read_file(previous_gpkg)
    prev_result = validate(previous, schema=schema)
    curr_result = validate(current_gdf, schema=schema)

    def failure_counts(result):
        return {g["check"] + "|" + str(g["column"]): g["count"]
                for g in result["attributes"].get("by_check", [])}

    prev_counts = failure_counts(prev_result)
    curr_counts = failure_counts(curr_result)
    new_checks = sorted(set(curr_counts) - set(prev_counts))
    worsened = [{"check": k, "was": prev_counts[k], "now": curr_counts[k]}
                for k in set(prev_counts) & set(curr_counts)
                if curr_counts[k] > prev_counts[k] * 1.2]
    return {
        "previous_rows": prev_result["rows_in"],
        "current_rows": curr_result["rows_in"],
        "previously_accepted_now_fails": not prev_result["pass"],
        "new_failing_checks": new_checks[:5],
        "worsened_checks": worsened[:5],
        "note": "if the previously accepted table now fails, the schema was "
                "tightened — decide deliberately whether to backfill",
    }
```

A tightened schema that fails last month's accepted data is a decision, not a bug, and surfacing it explicitly prevents the awkward case where a rule is added, the new ingest is rejected, and nobody realises the old data would fail too.

## Performance Notes

- **Vectorised checks on 412,000 rows take 200–800 ms in total.** The whole validation is well under a second, which is why it belongs in every ingest.
- **`element_wise=True` is the trap**: the same check row by row is 30–90 seconds. Write DataFrame-level checks returning a boolean Series.
- **`lazy=True` costs nothing** and collects every failure; without it you get one.
- **Geometry validity is the slow part** at roughly 20,000 polygons per second for `is_valid`. On 412,000 buildings that is about 20 seconds, and it is worth it.
- **`coerce=True` copies the columns it converts.** On a very wide table, select the schema's columns first.
- **Cache nothing.** The validation is fast enough to run on every read, which is the point.

## Common Errors

**`SchemaError: column 'x' not in dataframe`.** A renamed column upstream. `required=False` for genuinely optional ones; otherwise fix the mapping.

**Every row fails a type check.** A nullable integer column arrived as `float64`. Use the pandas nullable `"Int16"` type and `coerce=True`.

**The check never fires.** A typo in the column name inside a DataFrame-level check, so the lambda references a column that does not exist and raises — which Pandera reports as a check error rather than a failure. The self-test catches this.

**Validation takes two minutes.** `element_wise=True` somewhere.

**`geom.area` returns tiny numbers.** The CRS is geographic. Check it before computing areas.

**The quarantine grows every month.** The register changed and the schema did not. That is what the vocabulary check is telling you.

**A duplicate `register_id` passes.** `unique=True` was set on the column but the table was validated after a merge that reset the index; Pandera checks the column, so verify the merge did not concatenate two extracts.

## Frequently Asked Questions

### Pandera or Great Expectations?

Pandera for a schema that lives next to the code and runs in-process, which is what a pipeline ingest wants. Great Expectations for a data-quality programme with its own store, docs and profiling, which is more machinery than a single pipeline needs.

### Should the schema live with the pipeline or with the data?

With the pipeline that consumes it, because the schema describes what the pipeline requires rather than what the register happens to contain. Two consumers with different requirements should have two schemas.

### How do I handle a register that adds categories regularly?

Keep the vocabulary check blocking and the vocabulary in one place, so an addition is a one-line change with a review. Making it non-blocking means new categories flow into the tileset and style as "unknown" silently.

## Related Guides

- [Checking Point Cloud Classification Completeness](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/checking-point-cloud-classification-completeness/) — the same discipline for point clouds
- [Defining Tileset and Group Metadata](https://www.3d-geospatial.com/lod-management-optimization-strategies/tileset-metadata-and-3d-tiles-next/defining-tileset-and-group-metadata/) — where these attributes end up
- [Tracing Unit Errors from Feet to Metres](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/cross-section-failure-modes/tracing-unit-errors-from-feet-to-metres/) — the defect the area-ratio check detects

Back to [Data Validation and QA Gates](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/).
