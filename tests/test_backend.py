from __future__ import annotations

from pathlib import Path

from backend.model import load_bundle, train_and_persist
from backend.simulation import Simulation
from backend.synthetic import SyntheticConfig, generate_dataset


def test_dataset_has_required_schema_and_shared_feeder_events() -> None:
    frame = generate_dataset(SyntheticConfig(days=180, seed=7))

    required = {
        "timestamp", "clinic_id", "feeder_id", "hour", "day_of_week", "month",
        "is_evening", "forecast_rain_next_6h", "forecast_wind_next_6h", "too_cold",
        "spoilage", "spoilage_proxy",
    }
    assert required.issubset(frame.columns)
    assert frame["clinic_id"].nunique() == 20
    assert frame["feeder_id"].nunique() == 6
    assert set(frame["spoilage"].unique()).issubset({0, 1})
    assert 0.005 < frame["spoilage"].mean() < 0.08

    # A feeder assignment is stable, so a feeder trip can be rendered as a
    # simultaneous group event by the live simulator.
    assert frame.groupby("clinic_id")["feeder_id"].nunique().max() == 1


def test_training_writes_calibrated_bundle_and_metrics(tmp_path: Path) -> None:
    metrics = train_and_persist(days=180, seed=9, artifact_dir=tmp_path)
    bundle = load_bundle(tmp_path)

    assert bundle is not None
    assert (tmp_path / "dataset.csv").exists()
    assert (tmp_path / "metrics.json").exists()
    assert metrics["dataset"]["test_rows"] > 0
    assert 0 <= metrics["pr_auc"] <= 1
    assert 0 <= metrics["f2"] <= 1
    assert metrics["feature_importance"]
    assert metrics["calibration"]


def test_simulation_shared_and_local_controls(tmp_path: Path) -> None:
    train_and_persist(days=180, seed=11, artifact_dir=tmp_path)
    bundle = load_bundle(tmp_path)
    assert bundle is not None
    simulation = Simulation(bundle=bundle, seed=42)

    before = simulation.state()
    feeder_clinics = [clinic for clinic in before["clinics"] if clinic["feeder_id"] == 3]
    assert len(feeder_clinics) in (3, 4)

    after_trip = simulation.simulate("trip_feeder", feeder_id=3)
    affected = [clinic for clinic in after_trip["clinics"] if clinic["feeder_id"] == 3]
    assert all(not clinic["power_on"] for clinic in affected)
    assert all(clinic["status"] == "Feeder outage" for clinic in affected)
    assert all(clinic["power_on"] for clinic in after_trip["clinics"] if clinic["feeder_id"] != 3)

    clinic_id = affected[0]["id"]
    simulation.simulate("restore_feeder", feeder_id=3)
    local_fault = simulation.simulate("local_fault", clinic_id=clinic_id)
    local = next(clinic for clinic in local_fault["clinics"] if clinic["id"] == clinic_id)
    assert not local["power_on"]
    assert local["local_fault"]
    assert all(clinic["power_on"] for clinic in local_fault["clinics"] if clinic["id"] != clinic_id)
