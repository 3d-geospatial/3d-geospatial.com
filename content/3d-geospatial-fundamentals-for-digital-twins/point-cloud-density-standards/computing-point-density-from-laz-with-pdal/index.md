# Computing Point Density and Coverage Gaps from LAZ with PDAL

This page measures **point density** (points per square metre) and coverage uniformity from a `.laz` file with `PDAL` — using `filters.hexbin` to estimate density and trace the survey boundary, reading the EPSG code straight from the LAS header (EPSG:32618 in the examples), and reporting a median density plus the fraction of the extent that falls into gaps. The pipeline is a PDAL JSON stage list driven from the `pdal` Python bindings, with `numpy` only for the final reduction, so the same logic runs unchanged in a batch job over a whole delivery.

You hit this when a survey lands and you need one authoritative density figure before it enters the twin — and, more importantly, a map of where the cloud is too thin to trust. A headline mean hides dropped flight lines and occlusion shadows; PDAL's `filters.hexbin` is purpose-built for both jobs because it estimates density and emits a boundary polygon whose interior holes are exactly the voids you care about. This complements the standalone `laspy`/`numpy` binning in the [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) reference and the per-asset targets in [LiDAR point density best practices for infrastructure](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/); here the tool is PDAL end to end.

<figure class="diagram">
<svg viewBox="6 46 768 238" role="img" aria-labelledby="pdalhex-t pdalhex-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pdalhex-t">PDAL hexbin density and boundary with a coverage gap</title>
  <desc id="pdalhex-d">Scattered LAZ points in EPSG:32618 are aggregated by filters.hexbin into hexagonal cells; occupied hexagons yield a density in points per square metre while an unfilled hexagon in the interior is reported as a hole in the boundary polygon.</desc>
  <rect class="svg-bg" x="6" y="46" width="768" height="238" fill="#ffffff"/>
  <defs>
    <marker id="pdalhex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#5b6471"/>
    </marker>
  </defs>
  <rect x="20" y="60" width="200" height="180" rx="8" fill="#e3f0f4" stroke="#1f6b8a" stroke-width="2"/>
  <g fill="#15384a"><circle cx="55" cy="95" r="2.5"/><circle cx="90" cy="110" r="2.5"/><circle cx="130" cy="90" r="2.5"/><circle cx="170" cy="120" r="2.5"/><circle cx="70" cy="160" r="2.5"/><circle cx="120" cy="180" r="2.5"/><circle cx="180" cy="200" r="2.5"/><circle cx="95" cy="210" r="2.5"/><circle cx="150" cy="150" r="2.5"/></g>
  <g stroke="#4f7a4d" stroke-width="2" fill="#eef5e9">
    <polygon points="400,80 430,97 430,131 400,148 370,131 370,97"/>
    <polygon points="460,80 490,97 490,131 460,148 430,131 430,97"/>
    <polygon points="400,148 430,165 430,199 400,216 370,199 370,165"/>
    <polygon points="460,148 490,165 490,199 460,216 430,199 430,165"/>
  </g>
  <polygon points="520,148 550,165 550,199 520,216 490,199 490,165" fill="#fdf3e0" stroke="#c46a3d" stroke-width="2" stroke-dasharray="4 3"/>
  <rect x="600" y="95" width="160" height="110" rx="8" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g stroke="#5b6471" stroke-width="2" marker-end="url(#pdalhex-arrow)">
    <line x1="220" y1="150" x2="365" y2="150"/>
    <line x1="558" y1="150" x2="598" y2="150"/>
  </g>
  <g font-size="13" text-anchor="middle" fill="#1f2937">
    <text x="120" y="265">LAZ points · EPSG:32618</text>
    <text x="445" y="255">hexbin aggregate</text>
    <text x="680" y="135"><tspan x="680" dy="0">density (ppsm)</tspan><tspan x="680" dy="18">+ boundary</tspan><tspan x="680" dy="18">with holes</tspan></text>
  </g>
  <text x="520" y="245" fill="#9a4f26" font-size="12" text-anchor="middle">gap = hole</text>
</svg>
<figcaption>filters.hexbin aggregates points into hexagons, reports density per square metre, and returns a boundary polygon whose interior holes are the coverage gaps.</figcaption>
</figure>

## Prerequisites

- PDAL 2.5+ with the Python bindings and `numpy>=1.24`. Install the whole stack from conda-forge so the LAZ backend and GEOS (which `filters.hexbin` needs for the boundary polygon) are matched: `conda install -c conda-forge pdal python-pdal numpy`.
- A `.laz` or `.las` tile whose header declares a projected metric CRS. The examples assume EPSG:32618 (UTM 18N, metres); density computed in a geographic CRS such as EPSG:4326 is wrong by orders of magnitude because a degree is not a metre.
- A density target to check against — for example a QL1 floor of 8 ppsm for urban work. The Quality Level table lives in the [point cloud density standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) reference.
- The authoritative `filters.hexbin` and pipeline documentation at [pdal.io](https://pdal.io/) if you need the full option list.

## Step-by-Step

### 1. Read the CRS from the LAS header with PDAL

Run a metadata-only pipeline and pull the horizontal CRS from the reader stage. Refuse to proceed unless it is projected and metric — every density figure downstream depends on it.

```python
import pdal
import json

LAZ = "survey_18N.laz"
info = pdal.Pipeline(json.dumps([{"type": "readers.las", "filename": LAZ}]))
info.execute()
meta = info.metadata["metadata"]["readers.las"]

srs_wkt = meta["srs"]["horizontal"]
print("declared CRS:", srs_wkt[:70])
assert "32618" in srs_wkt or "UTM zone 18N" in srs_wkt, \
    "expected EPSG:32618; reproject to a projected metric CRS before density"
print("header point count:", meta["count"])
```

### 2. Estimate density and boundary with filters.hexbin

`filters.hexbin` lays a hexagonal grid over the cloud, keeps hexagons holding at least `threshold` points, and reports an average density plus a boundary polygon. Set `edge_size` to the resolution you care about (1 m gives density directly comparable to a ppsm target).

```python
import pdal
import json

pipeline = pdal.Pipeline(json.dumps([
    {"type": "readers.las", "filename": "survey_18N.laz"},
    {"type": "filters.hexbin", "edge_size": 1.0, "threshold": 1},
]))
pipeline.execute()

hb = pipeline.metadata["metadata"]["filters.hexbin"]
print("avg density (pts/m^2):", round(hb["density"], 2))
print("covered area (m^2):", round(hb["area"], 1))
print("avg point spacing (m):", round(hb.get("avg_pt_spacing", 0.0), 3))
```

<figure class="diagram">
<svg viewBox="33 6 701 304" role="img" aria-labelledby="pd-hull-t pd-hull-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pd-hull-t">Bounding-box area against the hexbin hull area</title>
  <desc id="pd-hull-d">The same curved flight swath measured two ways. Its bounding box encloses a large area of empty ground, so dividing the point count by that area understates density. The concave hull that filters.hexbin derives follows the swath, giving a much smaller area and a density figure that reflects where the points actually are.</desc>
  <rect class="svg-bg" x="33" y="6" width="701" height="304" fill="#ffffff"/>
  <path d="M47 71 H331 V222 H47 Z" fill="#f7dfdc" stroke="#b0413e" stroke-width="2" stroke-dasharray="7 4"/>
  <g fill="#1f6b8a"><circle cx="175" cy="213" r="2.4"/><circle cx="177" cy="202" r="2.4"/><circle cx="106" cy="156" r="2.4"/><circle cx="247" cy="150" r="2.4"/><circle cx="91" cy="128" r="2.4"/><circle cx="84" cy="121" r="2.4"/><circle cx="227" cy="173" r="2.4"/><circle cx="65" cy="79" r="2.4"/><circle cx="100" cy="136" r="2.4"/><circle cx="174" cy="211" r="2.4"/><circle cx="194" cy="199" r="2.4"/><circle cx="224" cy="176" r="2.4"/><circle cx="323" cy="115" r="2.4"/><circle cx="232" cy="166" r="2.4"/><circle cx="120" cy="187" r="2.4"/><circle cx="170" cy="190" r="2.4"/><circle cx="309" cy="95" r="2.4"/><circle cx="124" cy="157" r="2.4"/><circle cx="302" cy="92" r="2.4"/><circle cx="225" cy="181" r="2.4"/><circle cx="77" cy="137" r="2.4"/><circle cx="239" cy="156" r="2.4"/><circle cx="73" cy="136" r="2.4"/><circle cx="106" cy="147" r="2.4"/><circle cx="114" cy="139" r="2.4"/><circle cx="210" cy="184" r="2.4"/><circle cx="107" cy="176" r="2.4"/><circle cx="255" cy="168" r="2.4"/><circle cx="110" cy="171" r="2.4"/><circle cx="209" cy="205" r="2.4"/><circle cx="107" cy="169" r="2.4"/><circle cx="137" cy="169" r="2.4"/><circle cx="85" cy="112" r="2.4"/><circle cx="207" cy="191" r="2.4"/><circle cx="299" cy="116" r="2.4"/><circle cx="268" cy="125" r="2.4"/><circle cx="296" cy="118" r="2.4"/><circle cx="114" cy="168" r="2.4"/><circle cx="122" cy="168" r="2.4"/><circle cx="209" cy="178" r="2.4"/><circle cx="83" cy="94" r="2.4"/><circle cx="229" cy="188" r="2.4"/><circle cx="203" cy="182" r="2.4"/><circle cx="228" cy="164" r="2.4"/><circle cx="210" cy="201" r="2.4"/><circle cx="142" cy="165" r="2.4"/><circle cx="58" cy="94" r="2.4"/><circle cx="66" cy="106" r="2.4"/><circle cx="193" cy="191" r="2.4"/><circle cx="296" cy="137" r="2.4"/><circle cx="235" cy="166" r="2.4"/><circle cx="55" cy="117" r="2.4"/><circle cx="248" cy="160" r="2.4"/><circle cx="219" cy="197" r="2.4"/><circle cx="154" cy="168" r="2.4"/><circle cx="203" cy="212" r="2.4"/><circle cx="250" cy="180" r="2.4"/><circle cx="285" cy="131" r="2.4"/><circle cx="296" cy="126" r="2.4"/><circle cx="268" cy="160" r="2.4"/><circle cx="213" cy="193" r="2.4"/><circle cx="200" cy="197" r="2.4"/><circle cx="319" cy="112" r="2.4"/><circle cx="164" cy="196" r="2.4"/><circle cx="180" cy="183" r="2.4"/><circle cx="234" cy="171" r="2.4"/><circle cx="173" cy="206" r="2.4"/><circle cx="188" cy="214" r="2.4"/><circle cx="110" cy="163" r="2.4"/><circle cx="221" cy="170" r="2.4"/><circle cx="291" cy="125" r="2.4"/><circle cx="278" cy="137" r="2.4"/><circle cx="108" cy="166" r="2.4"/><circle cx="299" cy="121" r="2.4"/><circle cx="201" cy="181" r="2.4"/><circle cx="194" cy="211" r="2.4"/><circle cx="250" cy="167" r="2.4"/><circle cx="101" cy="138" r="2.4"/><circle cx="111" cy="164" r="2.4"/><circle cx="178" cy="211" r="2.4"/><circle cx="304" cy="92" r="2.4"/><circle cx="78" cy="85" r="2.4"/><circle cx="239" cy="169" r="2.4"/><circle cx="244" cy="144" r="2.4"/><circle cx="160" cy="210" r="2.4"/><circle cx="109" cy="149" r="2.4"/><circle cx="216" cy="194" r="2.4"/><circle cx="232" cy="202" r="2.4"/><circle cx="223" cy="180" r="2.4"/><circle cx="91" cy="148" r="2.4"/><circle cx="230" cy="167" r="2.4"/><circle cx="152" cy="188" r="2.4"/><circle cx="221" cy="187" r="2.4"/><circle cx="269" cy="142" r="2.4"/><circle cx="299" cy="107" r="2.4"/><circle cx="177" cy="213" r="2.4"/><circle cx="156" cy="205" r="2.4"/><circle cx="272" cy="155" r="2.4"/><circle cx="215" cy="194" r="2.4"/><circle cx="269" cy="158" r="2.4"/><circle cx="125" cy="176" r="2.4"/><circle cx="305" cy="119" r="2.4"/><circle cx="152" cy="196" r="2.4"/><circle cx="135" cy="186" r="2.4"/><circle cx="205" cy="197" r="2.4"/><circle cx="76" cy="84" r="2.4"/><circle cx="251" cy="149" r="2.4"/><circle cx="247" cy="145" r="2.4"/><circle cx="195" cy="211" r="2.4"/><circle cx="245" cy="179" r="2.4"/><circle cx="286" cy="106" r="2.4"/><circle cx="186" cy="207" r="2.4"/><circle cx="220" cy="200" r="2.4"/><circle cx="195" cy="192" r="2.4"/><circle cx="283" cy="133" r="2.4"/><circle cx="286" cy="143" r="2.4"/><circle cx="195" cy="197" r="2.4"/><circle cx="189" cy="182" r="2.4"/><circle cx="303" cy="107" r="2.4"/><circle cx="262" cy="155" r="2.4"/><circle cx="221" cy="181" r="2.4"/><circle cx="176" cy="211" r="2.4"/><circle cx="127" cy="160" r="2.4"/><circle cx="177" cy="212" r="2.4"/><circle cx="174" cy="188" r="2.4"/><circle cx="226" cy="177" r="2.4"/><circle cx="241" cy="149" r="2.4"/><circle cx="122" cy="156" r="2.4"/><circle cx="152" cy="175" r="2.4"/><circle cx="232" cy="172" r="2.4"/><circle cx="114" cy="170" r="2.4"/><circle cx="166" cy="194" r="2.4"/><circle cx="183" cy="188" r="2.4"/><circle cx="222" cy="190" r="2.4"/><circle cx="276" cy="155" r="2.4"/><circle cx="125" cy="175" r="2.4"/><circle cx="281" cy="121" r="2.4"/><circle cx="283" cy="141" r="2.4"/><circle cx="272" cy="123" r="2.4"/><circle cx="235" cy="158" r="2.4"/><circle cx="266" cy="157" r="2.4"/><circle cx="89" cy="140" r="2.4"/><circle cx="56" cy="103" r="2.4"/><circle cx="301" cy="112" r="2.4"/><circle cx="194" cy="199" r="2.4"/><circle cx="223" cy="165" r="2.4"/><circle cx="74" cy="128" r="2.4"/><circle cx="191" cy="186" r="2.4"/><circle cx="98" cy="163" r="2.4"/><circle cx="320" cy="90" r="2.4"/><circle cx="88" cy="110" r="2.4"/><circle cx="246" cy="162" r="2.4"/><circle cx="187" cy="202" r="2.4"/><circle cx="69" cy="107" r="2.4"/><circle cx="104" cy="159" r="2.4"/><circle cx="153" cy="183" r="2.4"/><circle cx="175" cy="213" r="2.4"/><circle cx="266" cy="168" r="2.4"/><circle cx="215" cy="193" r="2.4"/><circle cx="200" cy="210" r="2.4"/><circle cx="136" cy="179" r="2.4"/><circle cx="263" cy="157" r="2.4"/><circle cx="295" cy="137" r="2.4"/><circle cx="259" cy="160" r="2.4"/><circle cx="229" cy="167" r="2.4"/><circle cx="164" cy="193" r="2.4"/><circle cx="223" cy="178" r="2.4"/><circle cx="301" cy="111" r="2.4"/><circle cx="227" cy="186" r="2.4"/><circle cx="171" cy="198" r="2.4"/></g>
  <path d="M450 78 L510 132 L570 176 L630 186 L690 158 L720 128 L720 176 L690 208 L630 236 L570 226 L510 182 L450 126 Z" fill="#eef5e9" stroke="#4f7a4d" stroke-width="2"/>
  <g fill="#1f6b8a"><circle cx="565" cy="213" r="2.4"/><circle cx="567" cy="202" r="2.4"/><circle cx="496" cy="156" r="2.4"/><circle cx="637" cy="150" r="2.4"/><circle cx="481" cy="128" r="2.4"/><circle cx="474" cy="121" r="2.4"/><circle cx="617" cy="173" r="2.4"/><circle cx="455" cy="79" r="2.4"/><circle cx="490" cy="136" r="2.4"/><circle cx="564" cy="211" r="2.4"/><circle cx="584" cy="199" r="2.4"/><circle cx="614" cy="176" r="2.4"/><circle cx="713" cy="115" r="2.4"/><circle cx="622" cy="166" r="2.4"/><circle cx="510" cy="187" r="2.4"/><circle cx="560" cy="190" r="2.4"/><circle cx="699" cy="95" r="2.4"/><circle cx="514" cy="157" r="2.4"/><circle cx="692" cy="92" r="2.4"/><circle cx="615" cy="181" r="2.4"/><circle cx="467" cy="137" r="2.4"/><circle cx="629" cy="156" r="2.4"/><circle cx="463" cy="136" r="2.4"/><circle cx="496" cy="147" r="2.4"/><circle cx="504" cy="139" r="2.4"/><circle cx="600" cy="184" r="2.4"/><circle cx="497" cy="176" r="2.4"/><circle cx="645" cy="168" r="2.4"/><circle cx="500" cy="171" r="2.4"/><circle cx="599" cy="205" r="2.4"/><circle cx="497" cy="169" r="2.4"/><circle cx="527" cy="169" r="2.4"/><circle cx="475" cy="112" r="2.4"/><circle cx="597" cy="191" r="2.4"/><circle cx="689" cy="116" r="2.4"/><circle cx="658" cy="125" r="2.4"/><circle cx="686" cy="118" r="2.4"/><circle cx="504" cy="168" r="2.4"/><circle cx="512" cy="168" r="2.4"/><circle cx="599" cy="178" r="2.4"/><circle cx="473" cy="94" r="2.4"/><circle cx="619" cy="188" r="2.4"/><circle cx="593" cy="182" r="2.4"/><circle cx="618" cy="164" r="2.4"/><circle cx="600" cy="201" r="2.4"/><circle cx="532" cy="165" r="2.4"/><circle cx="448" cy="94" r="2.4"/><circle cx="456" cy="106" r="2.4"/><circle cx="583" cy="191" r="2.4"/><circle cx="686" cy="137" r="2.4"/><circle cx="625" cy="166" r="2.4"/><circle cx="445" cy="117" r="2.4"/><circle cx="638" cy="160" r="2.4"/><circle cx="609" cy="197" r="2.4"/><circle cx="544" cy="168" r="2.4"/><circle cx="593" cy="212" r="2.4"/><circle cx="640" cy="180" r="2.4"/><circle cx="675" cy="131" r="2.4"/><circle cx="686" cy="126" r="2.4"/><circle cx="658" cy="160" r="2.4"/><circle cx="603" cy="193" r="2.4"/><circle cx="590" cy="197" r="2.4"/><circle cx="709" cy="112" r="2.4"/><circle cx="554" cy="196" r="2.4"/><circle cx="570" cy="183" r="2.4"/><circle cx="624" cy="171" r="2.4"/><circle cx="563" cy="206" r="2.4"/><circle cx="578" cy="214" r="2.4"/><circle cx="500" cy="163" r="2.4"/><circle cx="611" cy="170" r="2.4"/><circle cx="681" cy="125" r="2.4"/><circle cx="668" cy="137" r="2.4"/><circle cx="498" cy="166" r="2.4"/><circle cx="689" cy="121" r="2.4"/><circle cx="591" cy="181" r="2.4"/><circle cx="584" cy="211" r="2.4"/><circle cx="640" cy="167" r="2.4"/><circle cx="491" cy="138" r="2.4"/><circle cx="501" cy="164" r="2.4"/><circle cx="568" cy="211" r="2.4"/><circle cx="694" cy="92" r="2.4"/><circle cx="468" cy="85" r="2.4"/><circle cx="629" cy="169" r="2.4"/><circle cx="634" cy="144" r="2.4"/><circle cx="550" cy="210" r="2.4"/><circle cx="499" cy="149" r="2.4"/><circle cx="606" cy="194" r="2.4"/><circle cx="622" cy="202" r="2.4"/><circle cx="613" cy="180" r="2.4"/><circle cx="481" cy="148" r="2.4"/><circle cx="620" cy="167" r="2.4"/><circle cx="542" cy="188" r="2.4"/><circle cx="611" cy="187" r="2.4"/><circle cx="659" cy="142" r="2.4"/><circle cx="689" cy="107" r="2.4"/><circle cx="567" cy="213" r="2.4"/><circle cx="546" cy="205" r="2.4"/><circle cx="662" cy="155" r="2.4"/><circle cx="605" cy="194" r="2.4"/><circle cx="659" cy="158" r="2.4"/><circle cx="515" cy="176" r="2.4"/><circle cx="695" cy="119" r="2.4"/><circle cx="542" cy="196" r="2.4"/><circle cx="525" cy="186" r="2.4"/><circle cx="595" cy="197" r="2.4"/><circle cx="466" cy="84" r="2.4"/><circle cx="641" cy="149" r="2.4"/><circle cx="637" cy="145" r="2.4"/><circle cx="585" cy="211" r="2.4"/><circle cx="635" cy="179" r="2.4"/><circle cx="676" cy="106" r="2.4"/><circle cx="576" cy="207" r="2.4"/><circle cx="610" cy="200" r="2.4"/><circle cx="585" cy="192" r="2.4"/><circle cx="673" cy="133" r="2.4"/><circle cx="676" cy="143" r="2.4"/><circle cx="585" cy="197" r="2.4"/><circle cx="579" cy="182" r="2.4"/><circle cx="693" cy="107" r="2.4"/><circle cx="652" cy="155" r="2.4"/><circle cx="611" cy="181" r="2.4"/><circle cx="566" cy="211" r="2.4"/><circle cx="517" cy="160" r="2.4"/><circle cx="567" cy="212" r="2.4"/><circle cx="564" cy="188" r="2.4"/><circle cx="616" cy="177" r="2.4"/><circle cx="631" cy="149" r="2.4"/><circle cx="512" cy="156" r="2.4"/><circle cx="542" cy="175" r="2.4"/><circle cx="622" cy="172" r="2.4"/><circle cx="504" cy="170" r="2.4"/><circle cx="556" cy="194" r="2.4"/><circle cx="573" cy="188" r="2.4"/><circle cx="612" cy="190" r="2.4"/><circle cx="666" cy="155" r="2.4"/><circle cx="515" cy="175" r="2.4"/><circle cx="671" cy="121" r="2.4"/><circle cx="673" cy="141" r="2.4"/><circle cx="662" cy="123" r="2.4"/><circle cx="625" cy="158" r="2.4"/><circle cx="656" cy="157" r="2.4"/><circle cx="479" cy="140" r="2.4"/><circle cx="446" cy="103" r="2.4"/><circle cx="691" cy="112" r="2.4"/><circle cx="584" cy="199" r="2.4"/><circle cx="613" cy="165" r="2.4"/><circle cx="464" cy="128" r="2.4"/><circle cx="581" cy="186" r="2.4"/><circle cx="488" cy="163" r="2.4"/><circle cx="710" cy="90" r="2.4"/><circle cx="478" cy="110" r="2.4"/><circle cx="636" cy="162" r="2.4"/><circle cx="577" cy="202" r="2.4"/><circle cx="459" cy="107" r="2.4"/><circle cx="494" cy="159" r="2.4"/><circle cx="543" cy="183" r="2.4"/><circle cx="565" cy="213" r="2.4"/><circle cx="656" cy="168" r="2.4"/><circle cx="605" cy="193" r="2.4"/><circle cx="590" cy="210" r="2.4"/><circle cx="526" cy="179" r="2.4"/><circle cx="653" cy="157" r="2.4"/><circle cx="685" cy="137" r="2.4"/><circle cx="649" cy="160" r="2.4"/><circle cx="619" cy="167" r="2.4"/><circle cx="554" cy="193" r="2.4"/><circle cx="613" cy="178" r="2.4"/><circle cx="691" cy="111" r="2.4"/><circle cx="617" cy="186" r="2.4"/><circle cx="561" cy="198" r="2.4"/></g>
  <text x="200" y="34" fill="#b0413e" font-size="12.5" text-anchor="middle" font-weight="600">bounding box</text>
  <text x="590" y="34" fill="#4f7a4d" font-size="12.5" text-anchor="middle" font-weight="600">hexbin concave hull</text>
  <text x="200" y="268" fill="#1f2937" font-size="12" text-anchor="middle">area 1.00 km² → 6.1 points/m²</text>
  <text x="590" y="268" fill="#1f2937" font-size="12" text-anchor="middle">area 0.62 km² → 9.8 points/m²</text>
  <text x="370" y="292" fill="#5b6471" font-size="12" text-anchor="middle">Same file, same points — a 38% difference in the number you would report against the specification</text>
</svg>
<figcaption>Area is the denominator, so the hull choice is not cosmetic. A bounding box over a curved or L-shaped block reports a density the survey never had.</figcaption>
</figure>

### 3. Turn the boundary into a coverage gap fraction

The hexbin `boundary` is a WKT polygon; interior rings (holes) are voids the survey never covered. Compare the polygon's net area against its outer-ring area with `shapely` to get the fraction of the footprint lost to gaps.

```python
from shapely import wkt

poly = wkt.loads(hb["boundary"])              # POLYGON, holes = coverage gaps
from shapely.geometry import Polygon
outer = Polygon(poly.exterior)                 # footprint ignoring holes

gap_fraction = 1.0 - (poly.area / outer.area)
print(f"coverage gaps: {gap_fraction:.2%} of the footprint")
print("gap (hole) count:", len(list(poly.interiors)))
```

### 4. Compute a median density and empty-cell fraction over a grid

The hexbin average is a single number; acceptance also needs the median and the worst served regions. Read the point coordinates PDAL already streamed, bin them into a metric grid, and reduce over occupied cells. This uses PDAL as the reader and keeps the reduction to a compact `numpy` step — the standalone binning routine is detailed in the density standards reference.

```python
import numpy as np

arr = pipeline.arrays[0]                        # structured array from the executed pipeline
x, y = np.asarray(arr["X"]), np.asarray(arr["Y"])   # metres, EPSG:32618

cell = 1.0
minx, miny = x.min(), y.min()
cols = int(np.ceil((x.max() - minx) / cell)) + 1
rows = int(np.ceil((y.max() - miny) / cell)) + 1
ci = np.clip(((x - minx) / cell).astype(np.int64), 0, cols - 1)
ri = np.clip(((y - miny) / cell).astype(np.int64), 0, rows - 1)

counts = np.zeros((rows, cols), dtype=np.int64)
np.add.at(counts, (ri, ci), 1)
occupied = counts[counts > 0] / (cell * cell)   # ppsm

print("median density:", round(float(np.median(occupied)), 2), "ppsm")
print("p05 density:", round(float(np.percentile(occupied, 5)), 2), "ppsm")
print("empty-cell fraction:", round(float((counts == 0).mean()), 4))
```

The gap fraction and the median tell you different things, and a pipeline needs both. The median answers "is the survey dense enough where it has data" — it is robust to a handful of extreme cells and it maps directly onto the acquisition specification. The empty-cell fraction answers "does it have data everywhere", which no density average can express, because a cell with zero points contributes nothing to a mean over occupied cells and vanishes entirely from a mean over the hull.

What turns those two numbers into a decision is the arrangement of the failures. Scattered single empty cells are normal: water bodies absorb the pulse, wet asphalt scatters it, and a specular roof returns nothing at certain incidence angles. Those are properties of the surface and reflying will not change them. Contiguous runs of empty cells are different — they are occlusions behind a structure, a gap between flight lines, or a trajectory dropout, and every one of them is fixable by another pass. So the check worth automating is not simply `empty_fraction < 0.02`; it is the size of the largest connected empty region, which `scipy.ndimage.label` will give you in two lines over the same count grid.

<figure class="diagram">
<svg viewBox="46 6 638 322" role="img" aria-labelledby="pd-grid-t pd-grid-d" xmlns="http://www.w3.org/2000/svg">
  <title id="pd-grid-t">Per-cell counts over a one-metre grid</title>
  <desc id="pd-grid-d">A grid of per-cell point counts across a tile. Most cells sit comfortably above the requirement, a scattering fall between eight and twelve, and four cells hold no points at all. The empty cells are adjacent, which is the signature of an occlusion rather than of random sparsity.</desc>
  <rect class="svg-bg" x="46" y="6" width="638" height="322" fill="#ffffff"/>
  <text x="370" y="34" fill="#1f2937" font-size="13" text-anchor="middle" font-weight="600">Points per cell — the two statistics that matter are the median and the empty fraction</text>
    <rect x="60" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="116" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="228" y="60" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="284" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="340" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="396" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="452" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="508" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="564" y="60" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="620" y="60" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="60" y="94" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="116" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="228" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="284" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="340" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="396" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="452" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="508" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="564" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="620" y="94" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="60" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="116" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="128" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="228" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="284" y="128" width="50" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="340" y="128" width="50" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="396" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="452" y="128" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="508" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="564" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="620" y="128" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="60" y="162" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="116" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="228" y="162" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="284" y="162" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="340" y="162" width="50" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="396" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="452" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="508" y="162" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="564" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="620" y="162" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="60" y="196" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="116" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="228" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="284" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="340" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="396" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="452" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="508" y="196" width="50" height="28" rx="4" fill="#f7dfdc" stroke="#b0413e" stroke-width="1.5"/>
    <rect x="564" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="620" y="196" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="60" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="116" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="172" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="228" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="284" y="230" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="340" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="396" y="230" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="452" y="230" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="508" y="230" width="50" height="28" rx="4" fill="#fdf3e0" stroke="#c46a3d" stroke-width="1.5"/>
    <rect x="564" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
    <rect x="620" y="230" width="50" height="28" rx="4" fill="#eef5e9" stroke="#4f7a4d" stroke-width="1.5"/>
  <g fill="#1f2937" font-size="11.5" text-anchor="middle">
    <text x="85" y="79">12</text>
    <text x="141" y="79">18</text>
    <text x="197" y="79">17</text>
    <text x="253" y="79">11</text>
    <text x="309" y="79">14</text>
    <text x="365" y="79">18</text>
    <text x="421" y="79">16</text>
    <text x="477" y="79">19</text>
    <text x="533" y="79">18</text>
    <text x="589" y="79">10</text>
    <text x="645" y="79">18</text>
    <text x="85" y="113">9</text>
    <text x="141" y="113">16</text>
    <text x="197" y="113">13</text>
    <text x="253" y="113">17</text>
    <text x="309" y="113">12</text>
    <text x="365" y="113">12</text>
    <text x="421" y="113">20</text>
    <text x="477" y="113">16</text>
    <text x="533" y="113">17</text>
    <text x="589" y="113">17</text>
    <text x="645" y="113">16</text>
    <text x="85" y="147">15</text>
    <text x="141" y="147">19</text>
    <text x="197" y="147">11</text>
    <text x="253" y="147">12</text>
    <text x="309" y="147">0</text>
    <text x="365" y="147">0</text>
    <text x="421" y="147">19</text>
    <text x="477" y="147">11</text>
    <text x="533" y="147">17</text>
    <text x="589" y="147">15</text>
    <text x="645" y="147">20</text>
    <text x="85" y="181">9</text>
    <text x="141" y="181">19</text>
    <text x="197" y="181">21</text>
    <text x="253" y="181">10</text>
    <text x="309" y="181">11</text>
    <text x="365" y="181">0</text>
    <text x="421" y="181">21</text>
    <text x="477" y="181">18</text>
    <text x="533" y="181">9</text>
    <text x="589" y="181">13</text>
    <text x="645" y="181">21</text>
    <text x="85" y="215">9</text>
    <text x="141" y="215">13</text>
    <text x="197" y="215">16</text>
    <text x="253" y="215">18</text>
    <text x="309" y="215">20</text>
    <text x="365" y="215">15</text>
    <text x="421" y="215">20</text>
    <text x="477" y="215">21</text>
    <text x="533" y="215">0</text>
    <text x="589" y="215">15</text>
    <text x="645" y="215">15</text>
    <text x="85" y="249">20</text>
    <text x="141" y="249">21</text>
    <text x="197" y="249">18</text>
    <text x="253" y="249">16</text>
    <text x="309" y="249">11</text>
    <text x="365" y="249">14</text>
    <text x="421" y="249">10</text>
    <text x="477" y="249">9</text>
    <text x="533" y="249">11</text>
    <text x="589" y="249">16</text>
    <text x="645" y="249">12</text>
  </g>
  <text x="370" y="290" fill="#5b6471" font-size="12" text-anchor="middle">median 15 points/m² · 4 of 66 cells empty (6.1%) · no cell between 1 and 8</text>
  <text x="370" y="310" fill="#b0413e" font-size="12" text-anchor="middle">The empty cells touch each other — an occlusion under a structure, not thin coverage</text>
</svg>
<figcaption>Counting is the easy part. Reading the arrangement is what separates a survey that needs reflying from one that needs a note in the metadata.</figcaption>
</figure>

### 5. Gate the result against the acquisition target

Fold the figures into a pass/fail a CI job can act on: the median must clear the contracted density and the gaps must stay under an acceptance threshold.

```python
TARGET_PPSM = 8.0          # QL1 urban floor
MAX_GAP = 0.02             # 2% of footprint

median = float(np.median(occupied))
status = "PASS" if (median >= TARGET_PPSM and gap_fraction <= MAX_GAP) else "FAIL"
print(f"median {median:.1f} ppsm, gaps {gap_fraction:.2%} -> {status}")
```

## Expected Output & Verification

A healthy QL1 urban tile in EPSG:32618 should print an average and median near or above target with a small gap fraction:

```text
declared CRS: PROJCS["WGS 84 / UTM zone 18N", ...
header point count: 41880233
avg density (pts/m^2): 11.4
covered area (m^2): 998840.0
avg point spacing (m): 0.29
coverage gaps: 0.8% of the footprint
median density: 11.1 ppsm
p05 density: 6.9 ppsm
empty-cell fraction: 0.0121
median 11.1 ppsm, gaps 0.80% -> PASS
```

Cross-check the two independent estimates: the hexbin `avg_pt_spacing` (~0.29 m) and the grid median (~11 ppsm) should agree through `spacing ≈ 1/√density` — here 1/√11.1 ≈ 0.30 m, a match that confirms the figure is real rather than an artifact of one method's cell geometry. If the hexbin density and the grid median disagree by more than a few percent, the cloud is clustered along flight lines; if either comes back near zero, the CRS is still geographic — recheck step 1.

It is also worth persisting the count grid itself, not just the summary statistics. The grid is small — a few hundred kilobytes for a survey tile — and it is what lets a later question be answered without re-reading the LAZ: which cells were sparse, whether the sparse region moved between acquisitions, and whether a clearance failure sits inside one. Summary statistics answer the acceptance question and nothing else.

## Common Errors

**`PDAL: filters.hexbin: Unable to compute boundary` or a missing `boundary` key.** PDAL was built without GEOS, so hexbin can estimate density but cannot trace the polygon. Install the conda-forge `pdal` build (which links GEOS), or drop step 3 and rely on the grid empty-cell fraction from step 4 for gap detection.

**Density reported as a tiny fraction such as 0.000004 pts/m².** The header CRS is geographic (EPSG:4326), so PDAL measured area in square degrees. The assertion in step 1 is meant to catch this; reproject with `filters.reprojection` (`in_srs`/`out_srs` set to explicit EPSG codes, e.g. to EPSG:32618) before the hexbin stage.

**`KeyError: 'filters.hexbin'` when reading metadata.** The pipeline was constructed but never executed, or the stage name was misspelled, so no metadata block exists. Call `pipeline.execute()` before touching `pipeline.metadata`, and read the block under the exact stage key `filters.hexbin`.

## Related Guides

- [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/) — ppsm, Quality Levels, and the standalone numpy binning routine
- [LiDAR Point Density Best Practices](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/best-practices-for-lidar-point-density-in-infrastructure/) — per-asset density targets and sparse-cell flagging
- [Coordinate Reference Systems for 3D Assets](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/coordinate-reference-systems-for-3d-assets/) — reproject to EPSG:32618 before any metric measurement
- [Digital Elevation Model Workflows](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/digital-elevation-model-workflows/) — where density gaps surface as raster voids

Back to [Point Cloud Density Standards](https://www.3d-geospatial.com/3d-geospatial-fundamentals-for-digital-twins/point-cloud-density-standards/).
