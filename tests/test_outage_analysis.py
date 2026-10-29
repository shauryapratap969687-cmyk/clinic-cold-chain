from __future__ import annotations

from backend.outage_analysis import OutageExperimentConfig, prepare_outage_frame, run_experiment
from backend.synthetic import SyntheticConfig, generate_dataset


def test_generator_exposes_weather_driven_outage_target_without_day_effect() -> None:
    frame = generate_dataset(SyntheticConfig(days=180, seed=2026))
    assert {"outage_start", "outage_start_next_6h", "feeder_weather_stress", "feeder_outage_hazard"}.issubset(frame.columns)
    assert 0.01 < float((~frame["power_on"].astype(bool)).mean()) < 0.06
    assert float(frame["feeder_outage_hazard"].max()) > float(frame["feeder_outage_hazard"].min())
    prepared = prepare_outage_frame(frame)
    assert prepared["new_outage_next_6h"].isin([0, 1]).all()
    assert prepared["grid_up"].isin([0, 1]).all()


def test_outage_review_keeps_new_and_ongoing_cases_separate() -> None:
    report = run_experiment(OutageExperimentConfig(days=180, bootstrap_samples=40, tuning_seed=2025, evaluation_seed=2026))
    assert report["status"] == "SIMULATED"
    assert "current_xgboost_outage_model" in report["baselines_new_outages_grid_up"]
    assert "persistence_baseline" in report["ongoing_outage_separate"]
    assert report["early_warning"]["evaluation_breach_events"] > 0
    assert report["early_warning"]["categories"]["warned_before_power_failed"]["count"] >= 0
    assert report["current_model_permutation_importance"]
    assert report["baselines_new_outages_grid_up"]["current_xgboost_outage_model"]["calibration"]
