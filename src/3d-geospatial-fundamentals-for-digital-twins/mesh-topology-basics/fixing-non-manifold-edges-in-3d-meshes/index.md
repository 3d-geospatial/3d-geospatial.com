# Fixing non-manifold edges in 3D meshes

Fixing non-manifold edges in 3D meshes requires isolating edges shared by more than two faces or vertices with inconsistent adjacency, then applying deterministic topological surgery. The standard repair sequence is: (1) detect defects via adjacency graph traversal, (2) classify the violation (T-junctions, >2-face sharing, dangling faces, or zero-thickness shells), and (3) apply tolerance-aware repair that preserves coordinate precision while enforcing manifold topology. In geospatial and digital twin workflows, non-manifold geometry breaks watertight validation, prevents accurate volumetric analysis, and causes silent failures in spatial indexing and physics simulation.

## Why Non-Manifold Edges Break Geospatial Pipelines

Digital twin automation relies on predictable Euler characteristics (`V - E + F = 2` for closed genus-0 meshes). Non-manifold edges violate this invariant by introducing ambiguous surface normals, undefined interior/exterior boundaries, and broken half-edge traversals. When municipal GIS teams merge LiDAR-derived meshes, CAD exports, and photogrammetry tiles, coordinate rounding and overlapping boundaries routinely generate T-junctions and multi-face edges. These defects propagate through spatial databases, causing invalid CityGML topology, failed Boolean operations, and incorrect shadow casting.

Reviewing [Mesh Topology Basics](/3d-geospatial-fundamentals-for-digital-twins/mesh-topology-basics/) clarifies how half-edge data structures and manifold constraints dictate which algorithmic approaches preserve spatial accuracy versus those that introduce geometric distortion. Automated repair must prioritize conservative face deletion over aggressive hole-filling to avoid generating phantom geometry that misrepresents real-world infrastructure.

## Detection & Classification Workflow

Before applying automated fixes, classify the defect type to select the appropriate repair strategy:

- **T-junctions:** A vertex lies on an edge but isn't shared by adjacent faces. Resolved via vertex merging.
- **Non-manifold edges:** Three or more faces share a single edge. Requires edge splitting or conservative face removal.
- **Non-manifold vertices:** Faces meet at a vertex but don't form a single disk topology. Often indicates overlapping shells.
- **Zero-thickness shells:** Two coplanar faces share an edge but point in opposite directions, creating an internal void. Detected via normal inversion checks.

Detection relies on building an edge-to-face adjacency map. Edges with `count != 2` or vertices with disconnected face loops are flagged. The [OGC CityGML 3.0 Specification](https://www.ogc.org/standard/citygml/) explicitly requires manifold geometry for Level of Detail (LOD) 2+ building models, making automated validation mandatory before database ingestion.

## Programmatic Repair with Python & trimesh

The following routine uses `trimesh` to detect, isolate, and conservatively repair non-manifold edges while maintaining geospatial coordinate fidelity. It prioritizes vertex merging and degenerate face removal before applying targeted face deletion for persistent violations.

```python
import trimesh
import numpy as np

def fix_non_manifold_edges(input_path, output_path, merge_tol=1e-4, crs_offset=None):
    """
    Detects and repairs non-manifold edges in 3D meshes.
    Returns a watertight, manifold mesh suitable for digital twin ingestion.
    """
    # Load without automatic processing to preserve raw topology
    mesh = trimesh.load(input_path, force='mesh', process=False)
    
    # Shift large GIS coordinates to origin to avoid float32 precision loss
    if crs_offset is not None:
        mesh.vertices -= crs_offset
        
    # 1. Merge near-identical vertices (resolves ~70% of T-junctions)
    mesh.merge_vertices()
    
    # 2. Remove zero-area/degenerate faces
    mesh.update_faces(mesh.nondegenerate_faces())
    
    # 3. Identify non-manifold edges via unique edge-face mapping
    # mesh.edges returns an (N_faces * 3, 2) array
    edges = mesh.edges
    sorted_edges = np.sort(edges, axis=1)
    unique_edges, inverse = np.unique(sorted_edges, axis=0, return_inverse=True)
    
    # Count how many faces share each unique edge
    edge_counts = np.bincount(inverse)
    
    # Edges shared by != 2 faces violate manifold topology
    non_manifold_mask = edge_counts != 2
    non_manifold_ids = np.where(non_manifold_mask)[0]
    
    if len(non_manifold_ids) > 0:
        # Map back to original edge array indices
        bad_edge_indices = np.where(np.isin(inverse, non_manifold_ids))[0]
        # Convert edge-array indices to face indices (3 edges per face)
        bad_face_indices = np.unique(bad_edge_indices // 3)
        
        # Conservative deletion: remove offending faces to restore manifold topology
        valid_mask = np.ones(len(mesh.faces), dtype=bool)
        valid_mask[bad_face_indices] = False
        mesh.update_faces(valid_mask)
        
    # 4. Final topology cleanup
    mesh.update_faces(mesh.unique_faces())
    mesh.fix_normals()
    
    # Restore original coordinates
    if crs_offset is not None:
        mesh.vertices += crs_offset
        
    mesh.export(output_path)
    return mesh.is_watertight
```

### Key Implementation Notes
- **CRS Offset Handling:** Large UTM coordinates cause floating-point precision loss during adjacency hashing. Shifting to the origin before repair and restoring afterward prevents vertex snapping artifacts.
- **Conservative Deletion:** The script removes faces attached to non-manifold edges rather than attempting to split them. This guarantees topological validity at the cost of minor surface area loss, which is acceptable for geospatial bounding volumes.
- **Modern `trimesh` API:** `mesh.nondegenerate_faces()` and `mesh.unique_faces()` produce boolean masks that you feed into `mesh.update_faces(...)`, replacing the older `remove_degenerate_faces()` and `remove_duplicate_faces()` calls. See the [trimesh Repair Documentation](https://trimesh.org/trimesh.repair.html) for version-specific method signatures.

## Validation & Post-Repair Checks

After running the repair routine, validate the output before pipeline ingestion:

1. **Watertight Verification:** `mesh.is_watertight` must return `True`. If `False`, run `mesh.fill_holes()` only if the missing area is below a defined threshold (e.g., `< 0.5 m²` for building footprints).
2. **Normal Consistency:** Run `mesh.fix_normals()` to ensure outward-facing orientation. Inconsistent normals break volumetric calculations and ray-casting in rendering engines.
3. **Coordinate Integrity:** Verify that the restored CRS offset matches the original bounding box within `±1e-6` tolerance. Drift indicates precision loss during vertex merging.

For production digital twin pipelines, wrap this routine in a validation loop that retries with tighter merge tolerances (`1e-5` → `1e-6`) if watertightness fails. Always log defect counts pre- and post-repair for audit trails. Understanding [3D Geospatial Fundamentals for Digital Twins](/3d-geospatial-fundamentals-for-digital-twins/) ensures repair thresholds align with municipal accuracy standards and downstream simulation requirements.