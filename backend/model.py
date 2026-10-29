"""Training, calibration, evaluation, and artifact loading."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .features import FEATURE_COLUMNS, build_feature_frame
from .synthetic import SyntheticConfig, generate_dataset
from .thermal import thermal_forecast_validation

HORIZON_HOURS = 6
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"


def _chronological_ranges(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    times = np.array(sorted(pd.to_datetime(frame["timestamp"], utc=True).unique()))
    n = len(times)
    # Each boundary has a six-hour purge so a label window cannot cross splits.
    train_end = int(n * 0.60)
    calibration_start = train_end + HORIZON_HOURS
    calibration_end = int(n * 0.75)
    validation_start = calibration_end + HORIZON_HOURS
    validation_end = int(n * 0.85)
    test_start = validation_end + HORIZON_HOURS
    masks = {
        "train": frame["timestamp"].isin(times[:train_end]).to_numpy(),
        "calibration": frame["timestamp"].isin(times[calibration_start:calibration_end]).to_numpy(),
        "validation": frame["timestamp"].isin(times[validation_start:validation_end]).to_numpy(),
        "test": frame["timestamp"].isin(times[test_start:]).to_numpy(),
    }
    return masks


def _safe_metric(function: Any, y_true: np.ndarray, values: np.ndarray, fallback: float = 0.0) -> float:
    try:
        if len(np.unique(y_true)) < 2:
            return fallback
        return float(function(y_true, values))
    except ValueError:
        return fallback


def _calibration_rows(y_true: np.ndarray, probabilities: np.ndarray) -> list[dict[str, float | int]]:
    rows: list[dict[str, float | int]] = []
    edges = np.linspace(0, 1, 11)
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (probabilities >= low) & ((probabilities < high) if high < 1 else (probabilities <= high))
        if np.any(mask):
            rows.append({"predicted": round(float(np.mean(probabilities[mask])), 6),
                         "observed": round(float(np.mean(y_true[mask])), 6), "count": int(mask.sum())})
    return rows


def _choose_f2_threshold(y_true: np.ndarray, probabilities: np.ndarray) -> float:
    from sklearn.metrics import fbeta_score
    candidates = np.unique(np.r_[np.linspace(0.01, 0.99, 99), probabilities])
    scores = [fbeta_score(y_true, probabilities >= threshold, beta=2, zero_division=0) for threshold in candidates]
    return float(candidates[int(np.argmax(scores))])


def train_and_persist(days: int = 240, seed: int = 42, artifact_dir: Path | None = None) -> dict[str, Any]:
    """Train a reproducible model and write the CSV, joblib, and metrics JSON."""
    import joblib
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import (average_precision_score, brier_score_loss, confusion_matrix,
                                 fbeta_score, roc_auc_score, roc_curve)
    from xgboost import XGBClassifier
    artifact_dir = Path(artifact_dir or ARTIFACT_DIR)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    dataset = generate_dataset(SyntheticConfig(days=days, seed=seed))
    dataset.to_csv(artifact_dir / "dataset.csv", index=False)
    masks = _chronological_ranges(dataset)
    y = dataset["spoilage"].to_numpy(dtype=int)
    x = dataset[FEATURE_COLUMNS].to_numpy(dtype=float)
    train_y = y[masks["train"]]
    positives = max(1, int(train_y.sum()))
    negatives = max(1, int(len(train_y) - positives))
    model = XGBClassifier(
        n_estimators=180,
        max_depth=4,
        learning_rate=0.08,
        subsample=0.88,
        colsample_bytree=0.9,
        min_child_weight=3,
        objective="binary:logistic",
        eval_metric="logloss",
        scale_pos_weight=negatives / positives,
        random_state=seed,
        n_jobs=1,
        tree_method="hist",
    )
    model.fit(x[masks["train"]], train_y)
    calibrator = LogisticRegression(solver="lbfgs", random_state=seed)
    calibration_margin = model.predict(x[masks["calibration"]], output_margin=True)
    calibration_y = y[masks["calibration"]]
    if len(np.unique(calibration_y)) >= 2:
        calibrator.fit(calibration_margin.reshape(-1, 1), calibration_y)
    else:
        # Defensive fallback for unusually unlucky seeds/configurations.
        calibrator.fit(np.array([[-10.0], [10.0]]), np.array([0, 1]))

    def calibrated(mask: np.ndarray) -> np.ndarray:
        margins = model.predict(x[mask], output_margin=True).reshape(-1, 1)
        return np.clip(calibrator.predict_proba(margins)[:, 1], 0.0, 1.0)

    validation_prob = calibrated(masks["validation"])
    threshold = _choose_f2_threshold(y[masks["validation"]], validation_prob)
    test_y = y[masks["test"]]
    test_prob = calibrated(masks["test"])
    test_pred = test_prob >= threshold
    matrix = confusion_matrix(test_y, test_pred, labels=[0, 1]).tolist()
    fpr, tpr, _ = roc_curve(test_y, test_prob) if len(np.unique(test_y)) > 1 else (np.array([0, 1]), np.array([0, 1]), None)
    importance = model.feature_importances_.tolist()
    metric_values = {
        "pr_auc": _safe_metric(average_precision_score, test_y, test_prob, float(test_y.mean())),
        "f2": float(fbeta_score(test_y, test_pred, beta=2, zero_division=0)),
        "brier": float(brier_score_loss(test_y, test_prob)),
        "roc_auc": _safe_metric(roc_auc_score, test_y, test_prob, 0.5),
        "threshold": threshold,
        "prevalence": float(y.mean()),
    }
    metrics: dict[str, Any] = {
        **metric_values,
        "dataset": {
            "days": days,
            "rows": int(len(dataset)),
            "positive_rate": float(y.mean()),
            "train_rows": int(masks["train"].sum()),
            "calibration_rows": int(masks["calibration"].sum()),
            "validation_rows": int(masks["validation"].sum()),
            "test_rows": int(masks["test"].sum()),
        },
        "calibration": _calibration_rows(test_y, test_prob),
        "feature_importance": [{"feature": name, "importance": float(value)}
                               for name, value in zip(FEATURE_COLUMNS, importance)],
        "thermal_forecast_validation": thermal_forecast_validation(seed=seed + 100_000),
        "confusion_matrix": matrix,
        "roc_curve": [{"fpr": float(a), "tpr": float(b)} for a, b in zip(fpr, tpr)],
        "notes": [
            "Synthetic demonstration data; not medical advice and not a validated clinical model.",
            "spoilage is a synthetic proxy: the next six hours contain any temperature below 2C or above 8C for two consecutive hours.",
            "Chronological train/calibration/validation/test splits use six-hour purges; the threshold is selected on validation only.",
        ],
    }
    bundle = {"model": model, "calibrator": calibrator, "feature_columns": FEATURE_COLUMNS,
              "threshold": threshold, "metrics": metrics}
    joblib.dump(bundle, artifact_dir / "model.joblib")
    (artifact_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    return metrics


def load_bundle(artifact_dir: Path | None = None) -> dict[str, Any] | None:
    path = Path(artifact_dir or ARTIFACT_DIR) / "model.joblib"
    if not path.exists():
        return None
    try:
        import joblib
        return joblib.load(path)
    except Exception:
        # Missing dependencies, incompatible versions, or corrupt local artifacts
        # must never trigger training or disable deterministic operational alarms.
        return None


def calibrated_probability(bundle: dict[str, Any], row: np.ndarray) -> float:
    model = bundle["model"]
    calibrator = bundle["calibrator"]
    margin = np.asarray(model.predict(row, output_margin=True)).reshape(-1, 1)
    return float(np.clip(calibrator.predict_proba(margin)[0, 1], 0.0, 1.0))
