"""Synthetic outage forecasting review and early-warning experiments.

This module is deliberately separate from the existing spoilage-risk model.
The repository does not contain a LightGBM outage model; the current model is
XGBoost and predicts a synthetic six-hour temperature-risk target.  The outage
review therefore uses a separate XGBoost adapter with isotonic calibration and
never changes the existing spoilage target.

Every result returned here is labelled simulated.  The tuning and evaluation
worlds are generated with different seeds.  Thresholds and model parameters
are fitted only on the tuning world.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Callable, Iterable

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from xgboost import XGBClassifier

from .synthetic import SyntheticConfig, generate_dataset
from .thermal import thermal_step


OUTAGE_HORIZON_HOURS = 6
BREACH_LIMIT_C = 8.0
WARNING_LIMIT_C = 6.0
OUTAGE_FEATURES = [
    "hour",
    "day_of_week",
    "is_evening",
    "outdoor_temp_c",
    "forecast_rain_next_6h",
    "forecast_wind_next_6h",
    "feeder_outage_hours_prev24",
    "feeder_outage_events_prev72",
    "feeder_id",
    "clinic_index",
]


@dataclass(frozen=True)
class OutageExperimentConfig:
    days: int = 180
    tuning_seed: int = 2025
    evaluation_seed: int = 2026
    horizon_hours: int = OUTAGE_HORIZON_HOURS
    matched_false_alarm_budget: float = 0.05
    bootstrap_samples: int = 1000
    random_state: int = 2026


def _safe_auc(function: Callable[..., float], y_true: np.ndarray, score: np.ndarray, fallback: float | None = None) -> float | None:
    if len(np.unique(y_true)) < 2:
        return fallback
    return round(float(function(y_true, score)), 4)


def _split_times(frame: pd.DataFrame) -> tuple[pd.Timestamp, pd.Timestamp]:
    times = np.array(sorted(pd.to_datetime(frame["timestamp"], utc=True).unique()))
    first = times[int(len(times) * 0.60)]
    second = times[int(len(times) * 0.80)]
    return pd.Timestamp(first), pd.Timestamp(second)


def _time_masks(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    first, second = _split_times(frame)
    stamps = pd.to_datetime(frame["timestamp"], utc=True)
    return {
        "train": (stamps < first).to_numpy(),
        "calibration": ((stamps >= first) & (stamps < second)).to_numpy(),
        "threshold": (stamps >= second).to_numpy(),
    }


def _rolling_feeder_history(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.sort_values(["feeder_id", "timestamp"], kind="stable").copy()
    outage = (~result["feeder_online"].astype(bool)).astype(float)
    result["feeder_outage_hours_prev24"] = (
        outage.groupby(result["feeder_id"]).shift(1).fillna(0).groupby(result["feeder_id"]).rolling(24, min_periods=1).sum().reset_index(level=0, drop=True)
    )
    start = (outage.eq(1) & outage.groupby(result["feeder_id"]).shift(1).fillna(0).eq(0)).astype(float)
    result["feeder_outage_events_prev72"] = (
        start.groupby(result["feeder_id"]).shift(1).fillna(0).groupby(result["feeder_id"]).rolling(72, min_periods=1).sum().reset_index(level=0, drop=True)
    )
    return result.sort_values(["clinic_id", "timestamp"], kind="stable").reset_index(drop=True)


def prepare_outage_frame(frame: pd.DataFrame, horizon_hours: int = OUTAGE_HORIZON_HOURS) -> pd.DataFrame:
    """Add outage-start, future-breach, and event labels without using current power/temp as model features."""
    result = _rolling_feeder_history(frame)
    result = result.sort_values(["feeder_id", "timestamp"], kind="stable").copy()
    feeder_online = result["feeder_online"].astype(bool)
    previous_online = feeder_online.groupby(result["feeder_id"]).shift(1, fill_value=True)
    outage_start = (~feeder_online) & previous_online
    result["outage_start"] = outage_start.astype(int)
    future_starts = []
    future_breaches = []
    for steps in range(1, horizon_hours + 1):
        future_starts.append(outage_start.groupby(result["feeder_id"]).shift(-steps, fill_value=False).astype(bool))
        temperature = result["temperature_c"].astype(float)
        future_breaches.append(temperature.groupby(result["clinic_id"]).shift(-steps).fillna(-999).gt(BREACH_LIMIT_C))
    result["new_outage_next_6h"] = (pd.concat(future_starts, axis=1).any(axis=1) & feeder_online).astype(int)
    result["breach_next_6h"] = pd.concat(future_breaches, axis=1).any(axis=1).astype(int)
    still_off = feeder_online.groupby(result["feeder_id"]).shift(-horizon_hours, fill_value=True).astype(bool)
    result["outage_ongoing_next_6h"] = ((~feeder_online) & (~still_off)).astype(int)
    result = result.sort_values(["clinic_id", "timestamp"], kind="stable").copy()
    temp = result["temperature_c"].astype(float)
    previous_temp = temp.groupby(result["clinic_id"]).shift(1).fillna(temp)
    result["breach_onset"] = (temp.gt(BREACH_LIMIT_C) & previous_temp.le(BREACH_LIMIT_C)).astype(int)
    power = result["power_on"].astype(bool)
    previous_power = power.groupby(result["clinic_id"]).shift(1, fill_value=True)
    result["power_failure_start"] = ((~power) & previous_power).astype(int)
    result["grid_up"] = (result["feeder_online"].astype(bool) & power).astype(int)
    return result.reset_index(drop=True)


def _feature_matrix(frame: pd.DataFrame) -> np.ndarray:
    return frame[OUTAGE_FEATURES].astype(float).fillna(0.0).to_numpy()


def _fit_isotonic(raw_calibration: np.ndarray, target: np.ndarray) -> IsotonicRegression:
    calibrator = IsotonicRegression(out_of_bounds="clip")
    if len(np.unique(target)) < 2:
        calibrator.fit(np.array([0.0, 1.0]), np.array([0.0, 1.0]))
    else:
        calibrator.fit(raw_calibration, target)
    return calibrator


def _fit_xgb(train: pd.DataFrame, calibration: pd.DataFrame, seed: int) -> tuple[Any, IsotonicRegression]:
    model = XGBClassifier(
        n_estimators=180,
        max_depth=3,
        learning_rate=0.06,
        subsample=0.9,
        colsample_bytree=0.9,
        min_child_weight=5,
        objective="binary:logistic",
        eval_metric="logloss",
        random_state=seed,
        n_jobs=1,
        tree_method="hist",
    )
    model.fit(_feature_matrix(train), train["new_outage_next_6h"].to_numpy(dtype=int))
    raw = model.predict_proba(_feature_matrix(calibration))[:, 1]
    calibrator = _fit_isotonic(raw, calibration["new_outage_next_6h"].to_numpy(dtype=int))
    return model, calibrator


def _predict(model: Any, calibrator: IsotonicRegression, frame: pd.DataFrame) -> np.ndarray:
    if len(frame) == 0:
        return np.array([], dtype=float)
    raw = model.predict_proba(_feature_matrix(frame))[:, 1]
    return np.clip(np.asarray(calibrator.predict(raw), dtype=float), 0.0, 1.0)


def _fit_flat_rate(train: pd.DataFrame) -> dict[str, float]:
    grouped = train.groupby("clinic_id")["new_outage_next_6h"].mean()
    fallback = float(train["new_outage_next_6h"].mean())
    return {str(key): float(value) for key, value in grouped.items()} | {"__fallback__": fallback}


def _flat_score(rates: dict[str, float], frame: pd.DataFrame) -> np.ndarray:
    fallback = rates.get("__fallback__", 0.0)
    return frame["clinic_id"].map(rates).fillna(fallback).to_numpy(dtype=float)


def _fit_hour_rain_rule(train: pd.DataFrame) -> dict[tuple[int, int], float]:
    data = train.copy()
    data["rain_flag"] = (data["forecast_rain_next_6h"].astype(float) > 0).astype(int)
    grouped = data.groupby(["hour", "rain_flag"])["new_outage_next_6h"].mean()
    fallback = float(data["new_outage_next_6h"].mean())
    return {(int(hour), int(rain)): float(value) for (hour, rain), value in grouped.items()} | {(-1, -1): fallback}


def _hour_rain_score(rule: dict[tuple[int, int], float], frame: pd.DataFrame) -> np.ndarray:
    fallback = rule.get((-1, -1), 0.0)
    rain = (frame["forecast_rain_next_6h"].astype(float) > 0).astype(int)
    return np.asarray([rule.get((int(hour), int(is_rain)), fallback) for hour, is_rain in zip(frame["hour"], rain)], dtype=float)


def _threshold_at_false_alarm_budget(scores: np.ndarray, target: np.ndarray, budget: float) -> float:
    negatives = scores[target == 0]
    if len(negatives) == 0:
        return float(np.inf)
    quantile = float(np.quantile(negatives, max(0.0, min(1.0, 1.0 - budget)), method="higher"))
    return quantile


def _classification_metrics(target: np.ndarray, score: np.ndarray, threshold: float | None = None) -> dict[str, Any]:
    if len(target) == 0:
        return {"rows": 0, "positive_rate": None, "pr_auc": None, "roc_auc": None, "lift_top5": None, "threshold": threshold}
    top_n = max(1, int(np.ceil(len(score) * 0.05)))
    top_indices = np.argsort(-score, kind="stable")[:top_n]
    top_rate = float(np.mean(target[top_indices]))
    prevalence = float(np.mean(target))
    result = {
        "rows": int(len(target)),
        "positive_rate": round(prevalence, 6),
        "pr_auc": _safe_auc(average_precision_score, target, score),
        "roc_auc": _safe_auc(roc_auc_score, target, score),
        "lift_top5": round(top_rate / prevalence, 4) if prevalence > 0 else None,
        "top5_positive_rate": round(top_rate, 6),
        "threshold": round(float(threshold), 6) if threshold is not None and np.isfinite(threshold) else None,
    }
    if threshold is not None and np.isfinite(threshold):
        predicted = score >= threshold
        negatives = target == 0
        result["false_alarm_rate"] = round(float(np.mean(predicted[negatives])) if np.any(negatives) else 0.0, 6)
        result["recall"] = round(float(np.mean(target[predicted])) if np.any(predicted) else 0.0, 6)
    return result


def _calibration_bins(target: np.ndarray, score: np.ndarray, bins: int = 10) -> list[dict[str, float | int]]:
    rows: list[dict[str, float | int]] = []
    edges = np.linspace(0.0, 1.0, bins + 1)
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (score >= low) & ((score < high) if high < 1.0 else (score <= high))
        if np.any(mask):
            rows.append({
                "predicted": round(float(np.mean(score[mask])), 6),
                "observed": round(float(np.mean(target[mask])), 6),
                "count": int(np.sum(mask)),
            })
    return rows


def _persistence_score(frame: pd.DataFrame, durations: list[float], horizon: int) -> np.ndarray:
    """P(still offline after H hours | offline for elapsed hours)."""
    return np.asarray([
        _survival(durations, max(0.0, float(elapsed) + horizon)) / _survival(durations, max(0.0, float(elapsed)))
        if _survival(durations, max(0.0, float(elapsed))) > 0 else 0.0
        for elapsed in frame["outage_hours"].to_numpy(dtype=float)
    ], dtype=float)


def _outage_durations(frame: pd.DataFrame) -> list[float]:
    durations: list[float] = []
    for _, group in frame.sort_values(["feeder_id", "timestamp"]).groupby("feeder_id"):
        online = group["feeder_online"].astype(bool).to_numpy()
        start = None
        for index, value in enumerate(online):
            if not value and start is None:
                start = index
            if value and start is not None:
                durations.append(float(index - start))
                start = None
        if start is not None:
            durations.append(float(len(online) - start))
    return durations


def _survival(durations: Iterable[float], threshold: float) -> float:
    values = np.asarray(list(durations), dtype=float)
    if len(values) == 0:
        return 0.0
    return float(np.mean(values >= max(0.0, float(threshold))))


def _safe_hours_after_cut(row: pd.Series, frame_by_clinic: dict[str, pd.DataFrame], horizon: int) -> float:
    group = frame_by_clinic[str(row["clinic_id"])]
    position = int(row["clinic_position"])
    future = group.iloc[position + 1:position + 1 + horizon]
    current = float(row["temperature_c"])
    if current >= BREACH_LIMIT_C:
        return 0.0
    tau = float(row.get("insulation_tau_hours", 24.0))
    for offset in range(horizon):
        ambient = float(future.iloc[offset]["outdoor_temp_c"]) if offset < len(future) else float(row["outdoor_temp_c"])
        step = thermal_step(current, ambient, power_on=False, cooling_failure=True, insulation_tau_hours=tau, noise_c=0.0)
        current = float(step["temperature_c"])
        if current >= BREACH_LIMIT_C:
            return float(offset + 1)
    return float(horizon)


def add_physics_columns(frame: pd.DataFrame, horizon: int = OUTAGE_HORIZON_HOURS) -> pd.DataFrame:
    result = frame.sort_values(["clinic_id", "timestamp"], kind="stable").copy()
    result["clinic_position"] = result.groupby("clinic_id").cumcount()
    groups = {str(key): value.reset_index(drop=True) for key, value in result.groupby("clinic_id", sort=False)}
    result["safe_hours_after_cut"] = [
        _safe_hours_after_cut(row, groups, horizon) if int(row["grid_up"]) == 1 else 0.0
        for _, row in result.iterrows()
    ]
    return result


def _combiner_score(frame: pd.DataFrame, outage_score: np.ndarray, durations: list[float], horizon: int) -> np.ndarray:
    scores: list[float] = []
    for row, p6 in zip(frame.itertuples(index=False), outage_score):
        safe_hours = float(getattr(row, "safe_hours_after_cut"))
        if not bool(getattr(row, "grid_up")):
            elapsed = max(0.0, float(getattr(row, "outage_hours")))
            denominator = _survival(durations, elapsed)
            score = _survival(durations, elapsed + safe_hours) / denominator if denominator > 0 else 0.0
        else:
            probability = min(max(float(p6), 0.0), 1.0 - 1e-12)
            lam = -np.log1p(-probability) / float(horizon)
            duration_survival = _survival(durations, safe_hours)
            remaining = max(0.0, float(horizon) - safe_hours)
            score = duration_survival * (1.0 - np.exp(-lam * remaining))
        scores.append(float(np.clip(score, 0.0, 1.0)))
    return np.asarray(scores, dtype=float)


def _power_failure_time(group: pd.DataFrame, breach_time: pd.Timestamp) -> pd.Timestamp | None:
    candidates = group[(group["timestamp"] <= breach_time) & (group["power_failure_start"] == 1)]
    return pd.Timestamp(candidates["timestamp"].max()) if len(candidates) else None


def _event_warning_categories(frame: pd.DataFrame, score_column: str, threshold: float, horizon: int) -> list[str]:
    events: list[str] = []
    ordered = frame.sort_values(["clinic_id", "timestamp"], kind="stable")
    groups = {str(key): group.reset_index(drop=True) for key, group in ordered.groupby("clinic_id", sort=False)}
    for _, group in groups.items():
        for _, event in group[group["breach_onset"] == 1].iterrows():
            breach_time = pd.Timestamp(event["timestamp"])
            failure_time = _power_failure_time(group, breach_time)
            if failure_time is None:
                events.append("not_warned")
                continue
            pre_start = failure_time - pd.Timedelta(hours=horizon)
            pre = group[(group["timestamp"] >= pre_start) & (group["timestamp"] < failure_time) & (group[score_column] >= threshold)]
            post = group[(group["timestamp"] >= failure_time) & (group["timestamp"] <= breach_time) & (group[score_column] >= threshold)]
            if len(pre):
                events.append("warned_before_power_failed")
            elif len(post):
                events.append("warned_only_after_power_failed")
            else:
                events.append("not_warned")
    return events


def _lead_times(frame: pd.DataFrame, score_column: str, threshold: float, horizon: int) -> list[float]:
    leads: list[float] = []
    ordered = frame.sort_values(["clinic_id", "timestamp"], kind="stable")
    for _, group in ordered.groupby("clinic_id", sort=False):
        group = group.reset_index(drop=True)
        for _, event in group[group["breach_onset"] == 1].iterrows():
            breach_time = pd.Timestamp(event["timestamp"])
            failure_time = _power_failure_time(group, breach_time)
            if failure_time is None:
                continue
            warnings = group[(group["timestamp"] < failure_time) & (group["timestamp"] >= failure_time - pd.Timedelta(hours=horizon)) & (group[score_column] >= threshold)]
            if len(warnings):
                latest = pd.Timestamp(warnings["timestamp"].max())
                leads.append(float((failure_time - latest).total_seconds() / 3600.0))
    return leads


def _bootstrap_proportions(categories: list[str], seed: int, samples: int) -> dict[str, dict[str, float | int]]:
    labels = ("warned_before_power_failed", "warned_only_after_power_failed", "not_warned")
    if not categories:
        return {label: {"count": 0, "percentage": None, "count_ci95": [0, 0], "percentage_ci95": [None, None]} for label in labels}
    rng = np.random.default_rng(seed)
    values = np.asarray(categories, dtype=object)
    output: dict[str, dict[str, float | int]] = {}
    for label in labels:
        observed_count = int(np.sum(values == label))
        observed_percentage = observed_count / len(values) * 100.0
        counts = np.empty(samples, dtype=float)
        percentages = np.empty(samples, dtype=float)
        for index in range(samples):
            sample = rng.choice(values, size=len(values), replace=True)
            count = np.sum(sample == label)
            counts[index] = count
            percentages[index] = count / len(values) * 100.0
        output[label] = {
            "count": observed_count,
            "percentage": round(observed_percentage, 2),
            "count_ci95": [int(np.floor(np.quantile(counts, 0.025))), int(np.ceil(np.quantile(counts, 0.975)))],
            "percentage_ci95": [round(float(np.quantile(percentages, 0.025)), 2), round(float(np.quantile(percentages, 0.975)), 2)],
        }
    return output


def _permutation_importance(model: Any, calibrator: IsotonicRegression, frame: pd.DataFrame, target: np.ndarray, seed: int) -> list[dict[str, float]]:
    if len(frame) == 0:
        return []
    rng = np.random.default_rng(seed)
    baseline = average_precision_score(target, _predict(model, calibrator, frame)) if len(np.unique(target)) > 1 else 0.0
    rows: list[dict[str, float]] = []
    for feature in OUTAGE_FEATURES:
        shuffled = frame.copy()
        shuffled[feature] = rng.permutation(shuffled[feature].to_numpy())
        score = average_precision_score(target, _predict(model, calibrator, shuffled)) if len(np.unique(target)) > 1 else 0.0
        rows.append({"feature": feature, "mean_ap_decrease": round(float(baseline - score), 6)})
    return sorted(rows, key=lambda row: row["mean_ap_decrease"], reverse=True)


def _train_and_score(tuning: pd.DataFrame, evaluation: pd.DataFrame, config: OutageExperimentConfig) -> dict[str, Any]:
    masks = _time_masks(tuning)
    train = tuning[masks["train"]]
    calibration = tuning[masks["calibration"]]
    threshold_world = tuning[masks["threshold"]].copy()
    eval_grid = evaluation[evaluation["grid_up"] == 1].copy()
    tune_grid = threshold_world[threshold_world["grid_up"] == 1].copy()
    model, calibrator = _fit_xgb(train, calibration, config.random_state)
    model_tune = _predict(model, calibrator, tune_grid)
    model_eval = _predict(model, calibrator, eval_grid)
    rates = _fit_flat_rate(train)
    flat_tune = _flat_score(rates, tune_grid)
    flat_eval = _flat_score(rates, eval_grid)
    rule = _fit_hour_rain_rule(train)
    rule_tune = _hour_rain_score(rule, tune_grid)
    rule_eval = _hour_rain_score(rule, eval_grid)
    plain_tune = (tune_grid["temperature_c"].astype(float).to_numpy() >= WARNING_LIMIT_C).astype(float)
    plain_eval = (eval_grid["temperature_c"].astype(float).to_numpy() >= WARNING_LIMIT_C).astype(float)
    target_tune = tune_grid["new_outage_next_6h"].to_numpy(dtype=int)
    matched_budget = config.matched_false_alarm_budget
    thresholds = {
        "flat_per_clinic_rate": _threshold_at_false_alarm_budget(flat_tune, target_tune, matched_budget),
        "hour_plus_rain_rule": _threshold_at_false_alarm_budget(rule_tune, target_tune, matched_budget),
        "current_xgboost_outage_model": _threshold_at_false_alarm_budget(model_tune, target_tune, matched_budget),
        "plain_6c_prealarm": WARNING_LIMIT_C,
    }
    metrics = {
        "flat_per_clinic_rate": _classification_metrics(eval_grid["new_outage_next_6h"].to_numpy(dtype=int), flat_eval, thresholds["flat_per_clinic_rate"]),
        "hour_plus_rain_rule": _classification_metrics(eval_grid["new_outage_next_6h"].to_numpy(dtype=int), rule_eval, thresholds["hour_plus_rain_rule"]),
        "current_xgboost_outage_model": _classification_metrics(eval_grid["new_outage_next_6h"].to_numpy(dtype=int), model_eval, thresholds["current_xgboost_outage_model"]),
        "plain_6c_prealarm": _classification_metrics(eval_grid["breach_next_6h"].to_numpy(dtype=int), plain_eval, thresholds["plain_6c_prealarm"]),
    }
    model_target_eval = eval_grid["new_outage_next_6h"].to_numpy(dtype=int)
    metrics["current_xgboost_outage_model"]["brier"] = round(float(brier_score_loss(model_target_eval, model_eval)), 6)
    metrics["current_xgboost_outage_model"]["calibration"] = _calibration_bins(model_target_eval, model_eval)
    ongoing_eval = evaluation[evaluation["grid_up"] == 0].copy()
    ongoing_score = _persistence_score(ongoing_eval, _outage_durations(tuning), config.horizon_hours)
    ongoing_target = ongoing_eval["outage_ongoing_next_6h"].to_numpy(dtype=int)
    return {
        "model": model,
        "calibrator": calibrator,
        "metrics": metrics,
        "ongoing_persistence": _classification_metrics(ongoing_target, ongoing_score),
        "thresholds": thresholds,
        "evaluation_grid": eval_grid,
        "tuning_grid": tune_grid,
        "model_eval_scores": model_eval,
        "model_tune_scores": model_tune,
        "flat_eval_scores": flat_eval,
        "rule_eval_scores": rule_eval,
        "durations": _outage_durations(tuning),
        "permutation_importance": _permutation_importance(model, calibrator, eval_grid, eval_grid["new_outage_next_6h"].to_numpy(dtype=int), config.random_state),
    }


def _attach_combiner_scores(frame: pd.DataFrame, scores: np.ndarray, durations: list[float], horizon: int) -> pd.DataFrame:
    result = frame.copy()
    result["combined_risk_score"] = _combiner_score(result, scores, durations, horizon)
    return result


def _evaluate_early_warning(
    tuning: pd.DataFrame,
    evaluation: pd.DataFrame,
    fit: dict[str, Any],
    config: OutageExperimentConfig,
) -> dict[str, Any]:
    masks = _time_masks(tuning)
    tune = tuning[masks["threshold"]].copy()
    tune = add_physics_columns(tune, config.horizon_hours)
    eval_frame = add_physics_columns(evaluation, config.horizon_hours)
    tune_grid = tune[tune["grid_up"] == 1].copy()
    eval_grid = eval_frame[eval_frame["grid_up"] == 1].copy()
    model_tune = _predict(fit["model"], fit["calibrator"], tune_grid)
    model_eval = _predict(fit["model"], fit["calibrator"], eval_grid)
    tune_combined = _attach_combiner_scores(tune_grid, model_tune, fit["durations"], config.horizon_hours)
    eval_combined_grid = _attach_combiner_scores(eval_grid, model_eval, fit["durations"], config.horizon_hours)
    tune_full = tune.copy()
    eval_full = eval_frame.copy()
    tune_full["combined_risk_score"] = _combiner_score(tune_full, _predict(fit["model"], fit["calibrator"], tune_full), fit["durations"], config.horizon_hours)
    eval_full["combined_risk_score"] = _combiner_score(eval_full, _predict(fit["model"], fit["calibrator"], eval_full), fit["durations"], config.horizon_hours)
    plain_tune = (tune_grid["temperature_c"].astype(float).to_numpy() >= WARNING_LIMIT_C).astype(float)
    matched_budget = max(
        0.01,
        min(
            0.10,
            float(np.mean(plain_tune[tune_grid["breach_next_6h"].to_numpy(dtype=int) == 0])) if np.any(tune_grid["breach_next_6h"].to_numpy(dtype=int) == 0) else config.matched_false_alarm_budget,
        ),
    )
    combined_threshold = _threshold_at_false_alarm_budget(tune_combined["combined_risk_score"].to_numpy(), tune_combined["breach_next_6h"].to_numpy(dtype=int), matched_budget)
    outage_threshold = _threshold_at_false_alarm_budget(model_tune, tune_grid["breach_next_6h"].to_numpy(dtype=int), matched_budget)
    combined_categories = _event_warning_categories(eval_full, "combined_risk_score", combined_threshold, config.horizon_hours)
    outage_categories = _event_warning_categories(eval_full, "combined_risk_score", outage_threshold, config.horizon_hours)
    plain_full = eval_full.copy()
    plain_full["plain_6c_score"] = (plain_full["temperature_c"].astype(float) >= WARNING_LIMIT_C).astype(float)
    plain_categories = _event_warning_categories(plain_full, "plain_6c_score", 0.5, config.horizon_hours)
    eval_events = int(np.sum(eval_full["breach_onset"] == 1))
    eval_full["plain_6c_score"] = (eval_full["temperature_c"].astype(float) >= WARNING_LIMIT_C).astype(float)
    pre_failure_leads = _lead_times(eval_full, "combined_risk_score", combined_threshold, config.horizon_hours)
    plain_leads = _lead_times(eval_full, "plain_6c_score", 0.5, config.horizon_hours)
    outage_leads = _lead_times(eval_full, "combined_risk_score", outage_threshold, config.horizon_hours)
    travel_time_hours = 2.0
    def lead_summary(values: list[float]) -> dict[str, Any]:
        return {
            "count": len(values),
            "mean": round(float(np.mean(values)), 3) if values else None,
            "median": round(float(np.median(values)), 3) if values else None,
            "share_at_least_travel_time": round(float(np.mean(np.asarray(values) >= travel_time_hours)), 4) if values else None,
        }
    return {
        "status": "SIMULATED",
        "evaluation_breach_events": eval_events,
        "matched_false_alarm_budget": round(matched_budget, 4),
        "combined_threshold": round(float(combined_threshold), 6) if np.isfinite(combined_threshold) else None,
        "categories": _bootstrap_proportions(combined_categories, config.random_state + 10, config.bootstrap_samples),
        "plain_6c_prealarm_categories": _bootstrap_proportions(plain_categories, config.random_state + 11, config.bootstrap_samples),
        "outage_score_categories": _bootstrap_proportions(outage_categories, config.random_state + 12, config.bootstrap_samples),
        "lead_time_hours": {
            "combined_risk": lead_summary(pre_failure_leads),
            "plain_6c_prealarm": lead_summary(plain_leads),
            "outage_score_only": lead_summary(outage_leads),
            "travel_time_assumption_hours": travel_time_hours,
        },
        "note": "Combined risk uses the outage score, empirical outage-duration survival, and a Newton-cooling safe-hours estimate. All metrics are simulated.",
    }


def run_experiment(config: OutageExperimentConfig = OutageExperimentConfig()) -> dict[str, Any]:
    """Run the review in separate tuning/evaluation synthetic worlds."""
    tuning_raw = generate_dataset(SyntheticConfig(days=config.days, seed=config.tuning_seed))
    evaluation_raw = generate_dataset(SyntheticConfig(days=config.days, seed=config.evaluation_seed))
    tuning = prepare_outage_frame(tuning_raw, config.horizon_hours)
    evaluation = prepare_outage_frame(evaluation_raw, config.horizon_hours)
    fit = _train_and_score(tuning, evaluation, config)
    early_warning = _evaluate_early_warning(tuning, evaluation, fit, config)
    return {
        "status": "SIMULATED",
        "pipeline_note": "Repository baseline is XGBoost spoilage prediction; outage review uses a separate XGBoost outage-start model because no LightGBM model exists here.",
        "config": asdict(config),
        "worlds": {"tuning_seed": config.tuning_seed, "evaluation_seed": config.evaluation_seed, "days_each": config.days},
        "outage_rate": {
            "tuning_clinic_hours": round(float((tuning["grid_up"] == 0).mean()), 6),
            "evaluation_clinic_hours": round(float((evaluation["grid_up"] == 0).mean()), 6),
            "tuning_new_outage_rate_grid_up": round(float(tuning.loc[tuning["grid_up"] == 1, "new_outage_next_6h"].mean()), 6),
            "evaluation_new_outage_rate_grid_up": round(float(evaluation.loc[evaluation["grid_up"] == 1, "new_outage_next_6h"].mean()), 6),
        },
        "baselines_new_outages_grid_up": fit["metrics"],
        "ongoing_outage_separate": {
            "persistence_baseline": fit["ongoing_persistence"],
            "target_definition": "Among already-offline clinic-hours, target=1 means the shared feeder is still offline six hours later.",
            "note": "This is a separate persistence case and is not mixed with new-outage PR-AUC or lift.",
        },
        "current_model_permutation_importance": fit["permutation_importance"],
        "early_warning": early_warning,
    }


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Run simulated outage baselines and early-warning review")
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--tuning-seed", type=int, default=2025)
    parser.add_argument("--evaluation-seed", type=int, default=2026)
    parser.add_argument("--bootstrap-samples", type=int, default=1000)
    parser.add_argument("--output", type=str, default=None)
    args = parser.parse_args()
    report = run_experiment(OutageExperimentConfig(days=args.days, tuning_seed=args.tuning_seed, evaluation_seed=args.evaluation_seed, bootstrap_samples=args.bootstrap_samples))
    payload = json.dumps(report, indent=2)
    if args.output:
        from pathlib import Path
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
