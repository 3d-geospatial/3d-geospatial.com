# Training a Random Forest Point Classifier

This page trains a random forest to classify airborne lidar into ground, vegetation, building and other — computing multi-scale geometric features, splitting train and test **spatially** rather than randomly, handling the severe class imbalance, reading the feature importances to drop what does not help, and reporting per-class error rather than a single accuracy figure.

## Why you hit this

Rule-based classification works well for the easy classes and poorly for the hard ones. The progressive morphological filter in [ground classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) extracts ground reliably; separating low vegetation from a gravel surface, or a flat roof from a car park, needs more than one threshold.

A random forest on geometric features handles those cases and is the right tool before anything deeper: it trains in minutes on a laptop, needs no GPU, tolerates unscaled features, and its feature importances tell you what the classification is actually using — which is information a neural network does not readily give up.

The trap is validation. A random train/test split on point-cloud data reports 99% accuracy and produces a classifier that fails on the next tile, because neighbouring points are nearly identical and end up on both sides of the split.

## Prerequisites

- Python 3.10+ with `numpy`, `scikit-learn>=1.3`, `laspy`, `scipy`, `pdal`.
- At least two classified tiles — one to train on, one held back entirely.
- Height above ground computed, as in the power-line guide.

## Step-by-Step

### 1. Compute features at several scales

```python
import json
import math
from collections import Counter
from pathlib import Path

import laspy
import numpy as np
from scipy.spatial import cKDTree

FEATURE_SCALES = (0.5, 1.5, 4.0)

def eigen_features(points, radius, min_neighbours=5):
    tree = cKDTree(points)
    neighbour_lists = tree.query_ball_point(points, r=radius, workers=-1)
    n = len(points)
    out = np.zeros((n, 7), dtype=np.float32)
    for i, idx in enumerate(neighbour_lists):
        k = len(idx)
        if k < min_neighbours:
            out[i] = [0, 0, 0, 0, 0, k, 0]
            continue
        local = points[idx]
        centred = local - local.mean(axis=0)
        cov = centred.T @ centred / k
        w, v = np.linalg.eigh(cov)
        w = np.clip(w[::-1], 1e-12, None)
        total = w.sum()
        principal = v[:, ::-1][:, 0]
        out[i] = [
            (w[0] - w[1]) / w[0],                      # linearity
            (w[1] - w[2]) / w[0],                      # planarity
            w[2] / w[0],                               # scattering
            -np.sum((w / total) * np.log(w / total)),  # eigenentropy
            abs(float(v[:, ::-1][2, 2])),              # normal verticality
            k,                                         # neighbour count = local density
            float(local[:, 2].max() - local[:, 2].min()),  # local height range
        ]
    return out

FEATURE_NAMES = ["linearity", "planarity", "scattering", "eigenentropy",
                 "normal_verticality", "density", "height_range"]

def build_features(las_path, scales=FEATURE_SCALES, include_intensity=True,
                   include_returns=True):
    las = laspy.read(las_path)
    xyz = np.column_stack([np.asarray(las.x), np.asarray(las.y),
                           np.asarray(las.z)]).astype(np.float64)
    blocks, names = [], []
    for r in scales:
        blocks.append(eigen_features(xyz, r))
        names.extend(f"{n}_r{r}" for n in FEATURE_NAMES)

    hag = np.asarray(las.HeightAboveGround, dtype=np.float32).reshape(-1, 1)
    blocks.append(hag)
    names.append("height_above_ground")

    if include_intensity and hasattr(las, "intensity"):
        inten = np.asarray(las.intensity, dtype=np.float32).reshape(-1, 1)
        blocks.append(inten)
        names.append("intensity")
    if include_returns and hasattr(las, "number_of_returns"):
        nret = np.asarray(las.number_of_returns, dtype=np.float32).reshape(-1, 1)
        rnum = np.asarray(las.return_number, dtype=np.float32).reshape(-1, 1)
        blocks.append(np.hstack([nret, rnum, nret - rnum]))
        names.extend(["number_of_returns", "return_number", "returns_after"])

    X = np.hstack(blocks).astype(np.float32)
    y = np.asarray(las.classification).astype(np.int16)
    return X, y, names, xyz
```

Three scales rather than one is the change that most improves a geometric classifier. At 0.5 m a roof and a car park both look planar; at 4 m the roof is planar and elevated while the car park is planar and at ground level, and the height feature separates them. A single scale forces a compromise that fits neither the fine structure nor the context.

Eigenentropy is worth including even though it correlates with scattering: it summarises how evenly the variance is distributed and is consistently among the more important features for vegetation.

`returns_after` — the number of returns following this one from the same pulse — is a strong vegetation cue and is free. A point with three returns after it is under a canopy; a point that is the only return is on a hard surface.

<figure class="diagram">
<svg viewBox="4 6 732 246" role="img" aria-labelledby="rf-scale-t rf-scale-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rf-scale-t">Why one feature scale is not enough</title>
  <desc id="rf-scale-d">A comparison of four surfaces at two neighbourhood radii. At half a metre, a flat roof and a car park both have planarity 0.88 and are indistinguishable, and low vegetation and a gravel surface both have scattering near 0.2. At four metres, the roof keeps planarity 0.84 while the car park drops to 0.61 because it is bounded by kerbs, and low vegetation rises to scattering 0.31 while gravel stays at 0.09. Combined with height above ground, all four separate.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="246" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="194" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="370" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="546" y="20" width="176" height="32" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="52" width="176" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="194" y="52" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="52" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="52" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="86" width="176" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="194" y="86" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="86" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="86" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="120" width="176" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="194" y="120" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="120" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="120" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="154" width="176" height="34" fill="#ffffff" stroke="#5b6471"/>
    <rect x="194" y="154" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="370" y="154" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="546" y="154" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="106" y="41">surface</text><text x="282" y="41">at r = 0.5 m</text>
    <text x="458" y="41">at r = 4.0 m</text><text x="634" y="41">height above ground</text>
    <text x="106" y="74">flat roof</text><text x="282" y="74">planarity 0.88</text>
    <text x="458" y="74">planarity 0.84</text><text x="634" y="74">8.4 m</text>
    <text x="106" y="108">car park</text><text x="282" y="108">planarity 0.88</text>
    <text x="458" y="108">planarity 0.61</text><text x="634" y="108">0.1 m</text>
    <text x="106" y="142">low vegetation</text><text x="282" y="142">scattering 0.19</text>
    <text x="458" y="142">scattering 0.31</text><text x="634" y="142">0.6 m</text>
    <text x="106" y="176">gravel surface</text><text x="282" y="176">scattering 0.21</text>
    <text x="458" y="176">scattering 0.09</text><text x="634" y="176">0.0 m</text>
  </g>
  <text x="370" y="212" fill="#b0413e" font-size="12.5" text-anchor="middle">at one scale the pairs are indistinguishable</text>
  <text x="370" y="234" fill="#1f2937" font-size="12.5" text-anchor="middle">at two scales plus height, all four separate cleanly</text>
</svg>
<figcaption>The confusions a single-scale classifier makes — roof against car park, low vegetation against gravel — resolve at a second scale.</figcaption>
</figure>

### 2. Split spatially, never randomly

```python
def spatial_blocks(xyz, block_m=50.0):
    i = np.floor(xyz[:, 0] / block_m).astype(np.int64)
    j = np.floor(xyz[:, 1] / block_m).astype(np.int64)
    return i * 1_000_003 + j

def blocked_split(xyz, y, test_fraction=0.3, block_m=50.0, seed=7):
    """Whole blocks go to train or test, so no point's neighbours leak across."""
    blocks = spatial_blocks(xyz, block_m)
    unique = np.unique(blocks)
    rng = np.random.default_rng(seed)
    rng.shuffle(unique)
    n_test = max(int(len(unique) * test_fraction), 1)
    test_blocks = set(unique[:n_test].tolist())
    is_test = np.isin(blocks, list(test_blocks))
    return {
        "train": np.flatnonzero(~is_test),
        "test": np.flatnonzero(is_test),
        "blocks_total": int(len(unique)),
        "blocks_test": n_test,
        "train_points": int((~is_test).sum()),
        "test_points": int(is_test.sum()),
        "train_class_mix": dict(Counter(y[~is_test].tolist())),
        "test_class_mix": dict(Counter(y[is_test].tolist())),
    }

def random_split_for_comparison(y, test_fraction=0.3, seed=7):
    """Included only to demonstrate the leakage it causes."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    cut = int(len(y) * (1 - test_fraction))
    return {"train": idx[:cut], "test": idx[cut:]}
```

Blocked splitting is the single most important decision in this page. Points 10 cm apart have nearly identical features and nearly always the same label, so a random split puts a point in training and its neighbour in test — and the model, having memorised the neighbour, scores nearly perfectly on data it has effectively seen.

The block size has to exceed the largest feature radius by a comfortable margin. With a 4 m maximum radius, 50 m blocks mean only the points within 4 m of a block boundary have any neighbour across it, which is under 1% of the points and a negligible leak.

A held-out *tile*, not just held-out blocks, is the final check, because blocks from the same tile still share the flight's acquisition conditions.

### 3. Handle the class imbalance

```python
from sklearn.ensemble import RandomForestClassifier

def class_weights(y, strategy="balanced_capped", cap=20.0):
    counts = Counter(y.tolist())
    total = sum(counts.values())
    n_classes = len(counts)
    if strategy == "none":
        return None
    weights = {}
    for cls, n in counts.items():
        w = total / (n_classes * n)
        weights[cls] = min(w, cap) if strategy == "balanced_capped" else w
    return weights

def subsample_majority(X, y, idx, max_per_class=400_000, seed=11):
    """Cheaper than weighting and often as effective: cap each class's training points."""
    rng = np.random.default_rng(seed)
    keep = []
    for cls in np.unique(y[idx]):
        members = idx[y[idx] == cls]
        if len(members) > max_per_class:
            members = rng.choice(members, size=max_per_class, replace=False)
        keep.append(members)
    out = np.concatenate(keep)
    rng.shuffle(out)
    return out, {cls: int((y[out] == cls).sum()) for cls in np.unique(y[out])}
```

Airborne lidar over a city is roughly 55% ground, 30% vegetation, 12% building and 3% everything else — and an unweighted forest will happily ignore the 3%, achieving high accuracy by never predicting it. Weighting or subsampling is not optional if those classes matter.

Capping the weight at 20 rather than using the raw inverse frequency matters for a class with a few hundred points: an uncapped weight of 4,000 makes every one of those points dominate a tree's splits and produces wild over-prediction of that class.

Subsampling the majority classes is usually the better choice because it also makes training faster, and a random forest does not benefit much from 20 million ground points over 400,000.

### 4. Train, with parameters that matter

```python
def train(X, y, train_idx, weights=None, n_estimators=300, max_depth=None,
          min_samples_leaf=5, max_features="sqrt", n_jobs=-1, seed=7):
    clf = RandomForestClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        min_samples_leaf=min_samples_leaf,
        max_features=max_features,
        class_weight=weights,
        n_jobs=n_jobs,
        random_state=seed,
        oob_score=True,
        bootstrap=True,
    )
    clf.fit(X[train_idx], y[train_idx])
    return clf, {
        "trees": n_estimators,
        "oob_score": round(float(clf.oob_score_), 4),
        "features": X.shape[1],
        "train_points": len(train_idx),
        "classes": clf.classes_.tolist(),
        "note": "oob_score is optimistic on point clouds — it is not spatially blocked",
    }
```

`min_samples_leaf=5` rather than the default 1 is a deliberate regularisation. A leaf holding one point memorises that point, which on data this correlated is a near-guarantee of overfitting; five is enough to blunt it without losing the minority classes.

`oob_score` is reported and should not be believed. Out-of-bag samples are drawn randomly, so they suffer exactly the leakage the blocked split exists to avoid — the OOB score will be several points above the blocked test score, and the gap between them is a useful measure of how correlated the data is.

Three hundred trees is comfortably past the point of diminishing returns; the accuracy curve is flat above about 150 and the cost is linear.

### 5. Read the feature importances and prune

```python
from sklearn.inspection import permutation_importance

def importance_report(clf, X, y, test_idx, feature_names, n_repeats=5, seed=7):
    impurity = clf.feature_importances_
    perm = permutation_importance(clf, X[test_idx], y[test_idx],
                                  n_repeats=n_repeats, random_state=seed, n_jobs=-1)
    rows = []
    for i, name in enumerate(feature_names):
        rows.append({
            "feature": name,
            "impurity_importance": round(float(impurity[i]), 5),
            "permutation_importance": round(float(perm.importances_mean[i]), 5),
            "permutation_std": round(float(perm.importances_std[i]), 5),
        })
    rows.sort(key=lambda r: -r["permutation_importance"])
    useless = [r["feature"] for r in rows if r["permutation_importance"] <= 0.0005]
    return {"top": rows[:8], "candidates_to_drop": useless,
            "note": "impurity importance favours high-cardinality features; "
                    "trust the permutation figure"}

def retrain_without(X, y, train_idx, test_idx, feature_names, drop, **kwargs):
    keep = [i for i, n in enumerate(feature_names) if n not in set(drop)]
    clf, info = train(X[:, keep], y, train_idx, **kwargs)
    score = clf.score(X[np.ix_(test_idx, keep)], y[test_idx])
    return clf, {"features_before": len(feature_names), "features_after": len(keep),
                 "dropped": sorted(set(drop)),
                 "test_accuracy": round(float(score), 4), **info}
```

Permutation importance measured on the **blocked test set** is the figure to act on. Impurity importance is computed during training and systematically favours continuous features with many distinct values, so it over-rates density and intensity and under-rates the binary-ish return features.

Dropping features that contribute nothing is worth doing for a practical reason: each feature scale costs a full neighbour search at inference time, so dropping the 0.5 m scale entirely — if the importances say it adds nothing — cuts a third off the feature computation on every future tile.

Intensity is the feature most often worth dropping. It is uncalibrated between flight lines, so a model that learns from it generalises badly to the next survey, and its importance is usually modest.

<figure class="diagram">
<svg viewBox="4 6 732 278" role="img" aria-labelledby="rf-features-t rf-features-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rf-features-t">Feature groups and whether they transfer</title>
  <desc id="rf-features-d">A table of five feature groups with their importance and whether they transfer to another survey. Height above ground is the most important feature and transfers because it is geometric. Eigenvalue features at several scales transfer for the same reason. Return counts are useful and depend on the sensor. Density depends on flying height. Intensity is uncalibrated between surveys and is usually worth dropping.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="278" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="282" y="20" width="176" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="458" y="20" width="264" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="264" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="282" y="54" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="54" width="264" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="88" width="264" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="282" y="88" width="176" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="458" y="88" width="264" height="34" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="122" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="282" y="122" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="458" y="122" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="156" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="282" y="156" width="176" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="458" y="156" width="264" height="34" fill="#fdf3e0" stroke="#c46a3d"/>
    <rect x="18" y="190" width="264" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="282" y="190" width="176" height="34" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="458" y="190" width="264" height="34" fill="#f7dfdc" stroke="#b0413e"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="150" y="42">feature group</text><text x="370" y="42">importance</text><text x="590" y="42">transfers to a new survey?</text>
    <text x="150" y="76">height above ground</text><text x="370" y="76">highest</text><text x="590" y="76">yes — geometric</text>
    <text x="150" y="110">eigenvalue features, 3 scales</text><text x="370" y="110">high</text><text x="590" y="110">yes — geometric</text>
    <text x="150" y="144">return counts</text><text x="370" y="144">moderate</text><text x="590" y="144">depends on the sensor</text>
    <text x="150" y="178">local density</text><text x="370" y="178">moderate</text><text x="590" y="178">depends on flying height</text>
    <text x="150" y="212">intensity</text><text x="370" y="212">low</text><text x="590" y="212">no — uncalibrated between surveys</text>
  </g>
  <text x="20" y="244" fill="#1f2937" font-size="12.5">A model whose importance is mostly geometric transfers; one leaning on density does not.</text>
  <text x="20" y="266" fill="#5b6471" font-size="12">Drop intensity unless it has been radiometrically calibrated across the whole survey.</text>
</svg>
<figcaption>The two geometric groups carry the model and transfer; intensity is useful here and useless next time.</figcaption>
</figure>

### 6. Report per-class error, not accuracy

```python
from sklearn.metrics import confusion_matrix, classification_report

CLASS_NAMES = {1: "unclassified", 2: "ground", 3: "low_veg", 4: "med_veg",
               5: "high_veg", 6: "building", 9: "water", 11: "road"}

def evaluate(clf, X, y, test_idx, class_names=CLASS_NAMES):
    pred = clf.predict(X[test_idx])
    truth = y[test_idx]
    labels = sorted(set(truth.tolist()) | set(pred.tolist()))
    cm = confusion_matrix(truth, pred, labels=labels)
    report = classification_report(truth, pred, labels=labels, output_dict=True,
                                   zero_division=0)

    per_class = []
    for i, label in enumerate(labels):
        support = int(cm[i].sum())
        per_class.append({
            "class": label,
            "name": class_names.get(label, str(label)),
            "support": support,
            "recall": round(float(report[str(label)]["recall"]), 4),
            "precision": round(float(report[str(label)]["precision"]), 4),
            "f1": round(float(report[str(label)]["f1-score"]), 4),
            "worst_confusion": class_names.get(
                labels[int(np.argmax(np.where(np.arange(len(labels)) == i, -1, cm[i])))],
                "—") if support else "—",
        })
    return {
        "overall_accuracy": round(float((pred == truth).mean()), 4),
        "balanced_accuracy": round(float(np.mean([p["recall"] for p in per_class
                                                  if p["support"] > 0])), 4),
        "per_class": sorted(per_class, key=lambda p: p["f1"]),
        "confusion_matrix": {"labels": labels, "counts": cm.tolist()},
    }

def compare_splits(X, y, xyz, feature_names):
    """The demonstration that random splitting lies."""
    blocked = blocked_split(xyz, y)
    random = random_split_for_comparison(y)
    results = {}
    for name, split in (("blocked", blocked), ("random", random)):
        clf, _ = train(X, y, split["train"],
                       weights=class_weights(y[split["train"]]))
        ev = evaluate(clf, X, y, split["test"])
        results[name] = {"overall_accuracy": ev["overall_accuracy"],
                         "balanced_accuracy": ev["balanced_accuracy"]}
    results["optimism"] = round(results["random"]["overall_accuracy"]
                                - results["blocked"]["overall_accuracy"], 4)
    return results

print(json.dumps(compare_splits(X, y, xyz, names), indent=2))
```

Balanced accuracy — the mean per-class recall — is the headline figure for an imbalanced problem. Overall accuracy on a cloud that is 55% ground can reach 0.93 while low vegetation has a recall of 0.31, and the two numbers describe very different classifiers.

The `worst_confusion` column is what turns the report into a work list. "Low vegetation is most often confused with ground" points at the feature that should separate them, which is usually a finer height-above-ground resolution or a smaller feature scale.

<figure class="diagram">
<svg viewBox="4 6 732 238" role="img" aria-labelledby="rf-split-t rf-split-d" xmlns="http://www.w3.org/2000/svg">
  <title id="rf-split-t">Random splitting versus spatially blocked splitting</title>
  <desc id="rf-split-d">Two evaluation results for the same model and data. With a random point-level split, overall accuracy is 0.991 and balanced accuracy 0.978, and the model appears excellent. With a spatially blocked split at 50 metre blocks, overall accuracy is 0.934 and balanced accuracy 0.812. On a completely held-out tile, accuracy is 0.911 and balanced accuracy 0.774. The random split overstates accuracy by 5.7 points and balanced accuracy by 16.6 points.</desc>
  <rect class="svg-bg" x="4" y="6" width="732" height="238" fill="#ffffff"/>
  <g stroke-width="1.5">
    <rect x="18" y="20" width="268" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="286" y="20" width="148" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="434" y="20" width="148" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="582" y="20" width="140" height="34" fill="#e3f0f4" stroke="#1f6b8a"/>
    <rect x="18" y="54" width="268" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="286" y="54" width="148" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="434" y="54" width="148" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="582" y="54" width="140" height="40" fill="#f7dfdc" stroke="#b0413e"/>
    <rect x="18" y="94" width="268" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="94" width="148" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="434" y="94" width="148" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="582" y="94" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="18" y="134" width="268" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="286" y="134" width="148" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="434" y="134" width="148" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
    <rect x="582" y="134" width="140" height="40" fill="#eef5e9" stroke="#4f7a4d"/>
  </g>
  <g fill="#1f2937" font-size="12.5" text-anchor="middle">
    <text x="152" y="41">evaluation method</text><text x="360" y="41">accuracy</text>
    <text x="508" y="41">balanced acc.</text><text x="652" y="41">trustworthy?</text>
    <text x="152" y="70">random point-level split</text><text x="152" y="86">(neighbours leak across)</text>
    <text x="360" y="78">0.991</text><text x="508" y="78">0.978</text><text x="652" y="78">no</text>
    <text x="152" y="110">spatially blocked, 50 m</text><text x="152" y="126">held-out blocks</text>
    <text x="360" y="118">0.934</text><text x="508" y="118">0.812</text><text x="652" y="118">yes</text>
    <text x="152" y="150">completely held-out tile</text><text x="152" y="166">different flight line</text>
    <text x="360" y="158">0.911</text><text x="508" y="158">0.774</text><text x="652" y="158">yes — the real figure</text>
  </g>
  <text x="370" y="204" fill="#1f2937" font-size="12.5" text-anchor="middle">the random split overstates accuracy by 5.7 points and balanced accuracy by 16.6</text>
  <text x="370" y="226" fill="#5b6471" font-size="12" text-anchor="middle">on a held-out tile the minority classes are where the difference lands</text>
</svg>
<figcaption>Same model, same data, three evaluation methods; only the bottom row predicts what happens on the next tile.</figcaption>
</figure>

## Expected Output & Verification

```text
{'blocks_total': 400, 'blocks_test': 120, 'train_points': 29184102,
 'test_points': 12636316,
 'train_class_mix': {2: 16082418, 5: 6418204, 3: 1884102, 6: 3418204, 1: 1381174},
 'test_class_mix': {2: 6982104, 5: 2818402, 3: 812004, 6: 1481806, 1: 542000}}
{'trees': 300, 'oob_score': 0.9881, 'features': 26, 'train_points': 1602418,
 'classes': [1, 2, 3, 4, 5, 6, 9, 11]}
{
  "top": [
    {"feature": "height_above_ground", "impurity_importance": 0.28412,
     "permutation_importance": 0.19841, "permutation_std": 0.00211},
    {"feature": "planarity_r4.0", "impurity_importance": 0.09104,
     "permutation_importance": 0.07412, "permutation_std": 0.00184},
    {"feature": "scattering_r1.5", "impurity_importance": 0.08218,
     "permutation_importance": 0.06104, "permutation_std": 0.00162},
    {"feature": "returns_after", "impurity_importance": 0.02104,
     "permutation_importance": 0.04418, "permutation_std": 0.00121}
  ],
  "candidates_to_drop": ["intensity", "linearity_r0.5", "eigenentropy_r0.5"]
}
{
  "overall_accuracy": 0.9341,
  "balanced_accuracy": 0.8122,
  "per_class": [
    {"class": 3, "name": "low_veg", "support": 812004, "recall": 0.6418,
     "precision": 0.7104, "f1": 0.6744, "worst_confusion": "ground"},
    {"class": 4, "name": "med_veg", "support": 418204, "recall": 0.7218,
     "precision": 0.6884, "f1": 0.7047, "worst_confusion": "high_veg"},
    {"class": 6, "name": "building", "support": 1481806, "recall": 0.9418,
     "precision": 0.9604, "f1": 0.951, "worst_confusion": "ground"},
    {"class": 2, "name": "ground", "support": 6982104, "recall": 0.9784,
     "precision": 0.9641, "f1": 0.9712, "worst_confusion": "low_veg"}
  ]
}
{'blocked': {'overall_accuracy': 0.9341, 'balanced_accuracy': 0.8122},
 'random': {'overall_accuracy': 0.9912, 'balanced_accuracy': 0.9784},
 'optimism': 0.0571}
```

The 0.0571 optimism figure is the demonstration that matters: the random split reports 99.1% and the blocked split 93.4% for the same model. Reporting the random figure would be misleading, and it is the figure most tutorials produce.

Low vegetation at 0.64 recall, confused with ground, is the honest weak point and it is typical — the boundary between 20 cm grass and bare earth is genuinely ambiguous at airborne point density, and no feature set fixes it entirely.

Verify on a completely held-out tile, because blocked validation still shares the flight:

```python
def holdout_tile_check(clf, feature_names, holdout_las, keep_features=None):
    X_h, y_h, names_h, xyz_h = build_features(holdout_las)
    if names_h != feature_names:
        raise ValueError("feature order differs between tiles; rebuild consistently")
    if keep_features:
        keep = [i for i, n in enumerate(feature_names) if n in set(keep_features)]
        X_h = X_h[:, keep]
    pred = clf.predict(X_h)
    ev_labels = sorted(set(y_h.tolist()))
    cm = confusion_matrix(y_h, pred, labels=ev_labels)
    recalls = [cm[i, i] / max(cm[i].sum(), 1) for i in range(len(ev_labels))]
    return {
        "tile": Path(holdout_las).name,
        "points": int(len(y_h)),
        "overall_accuracy": round(float((pred == y_h).mean()), 4),
        "balanced_accuracy": round(float(np.mean(recalls)), 4),
        "per_class_recall": {CLASS_NAMES.get(l, str(l)): round(float(r), 4)
                             for l, r in zip(ev_labels, recalls)},
        "classes_in_holdout_not_in_training": sorted(
            set(y_h.tolist()) - set(clf.classes_.tolist())),
    }

print(json.dumps(holdout_tile_check(clf, names, "input/tile_b_classified.laz"), indent=2))
```

A class present in the holdout and absent from training is the failure that produces a confidently wrong result across a whole region — a tile with water where the training tile had none will have every water point assigned to something else. Checking for it explicitly costs one set difference.

Then verify the model is not relying on something that will not generalise:

```python
def generalisation_risk_check(importance_report_result, feature_names):
    """Features that vary between surveys are a generalisation risk however useful."""
    FRAGILE = {"intensity", "density", "number_of_returns", "return_number",
               "returns_after"}
    rows = []
    for r in importance_report_result["top"]:
        base = r["feature"].split("_r")[0]
        rows.append({
            "feature": r["feature"],
            "permutation_importance": r["permutation_importance"],
            "fragile": base in FRAGILE,
            "why": "varies with sensor, altitude and calibration between surveys"
                   if base in FRAGILE else "geometric — stable across surveys",
        })
    fragile_share = sum(r["permutation_importance"] for r in rows if r["fragile"]) \
        / max(sum(r["permutation_importance"] for r in rows), 1e-9)
    return {
        "rows": rows,
        "fragile_importance_share": round(fragile_share, 3),
        "verdict": "model leans on survey-specific features; expect degradation "
                   "on a new sensor" if fragile_share > 0.3
                   else "mostly geometric features — should transfer",
    }
```

Density and return counts are genuinely useful and genuinely survey-specific. A model whose importance is a third density will do well on this survey and worse on the next one flown at a different altitude, and knowing that in advance is better than discovering it.

## Performance Notes

- **Feature computation dominates**: three scales on 40 million points is 30–60 minutes single-threaded. `workers=-1` on the neighbour search and a per-block loop parallelise it.
- **Training on 1.6 million subsampled points with 300 trees takes 2–4 minutes** on 8 cores. More points buy very little.
- **Inference is 1–2 million points per second** with 300 trees, so a tile predicts in under a minute once the features exist.
- **Memory is the constraint at feature time.** 26 float32 features on 40 million points is 4 GB; compute and predict per block rather than holding the whole tile.
- **Drop the finest scale if its importance is low** — it is a third of the feature cost.
- **Cache features alongside the tile.** Re-training happens far more often than re-featurising.

## Common Errors

**99% accuracy that collapses on a new tile.** Random splitting. Use blocks.

**A minority class is never predicted.** No class weighting and no subsampling.

**`ValueError: Input contains NaN`.** Points with too few neighbours produced NaN features. Fill with zeros or a sentinel and let the forest learn the pattern.

**Feature order differs between tiles.** `build_features` included intensity on one tile and not another. Build the feature list once and enforce it.

**Predictions are blocky at tile boundaries.** Features computed per tile without overlap, so points near the edge have truncated neighbourhoods. Featurise with a buffer.

**The model is worse than PMF at ground.** Likely true, and fine — use PMF for ground and the forest for the classes it does better. A hybrid beats either.

**Permutation importance takes hours.** It refits nothing but predicts once per feature per repeat. Reduce `n_repeats` and subsample the test set.

## Frequently Asked Questions

### Random forest or a neural network?

A random forest is the right first model: it trains in minutes, needs no tuning to be reasonable and tells you what it used. Point-based deep learning does better on the hard classes given enough labelled data and a GPU, and the features here are a good baseline to beat.

### How much labelled data do I need?

Two or three well-classified tiles covering the terrain types you care about. What matters far more than volume is that every class you want to predict appears in training with a few thousand examples.

### Should I use the forest for ground?

Usually not. PMF or SMRF is faster, more predictable and at least as accurate for ground, and using it first also gives you height above ground, which is the forest's most important feature.

## Related Guides

- [Ground Classification with PDAL PMF](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/ground-classification-with-pdal-pmf/) — the rule-based step this complements
- [Detecting Power Lines in Lidar](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/detecting-power-lines-in-lidar/) — the same features used as explicit rules
- [Checking Point Cloud Classification Completeness](https://www.3d-geospatial.com/digital-twin-troubleshooting-and-reliability/data-validation-and-qa-gates/checking-point-cloud-classification-completeness/) — auditing a classification in production

Back to [Lidar Classification and Ground Extraction](https://www.3d-geospatial.com/point-cloud-mesh-processing-pipelines/lidar-classification-and-ground-extraction/).
