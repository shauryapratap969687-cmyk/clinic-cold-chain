from __future__ import annotations

from backend.dataset import DEFAULT_DATASET_PATH, FORBIDDEN_MODEL_COLUMNS, load_training_dataset
from backend.features import FEATURE_COLUMNS


def test_packaged_v3_dataset_maps_to_the_existing_training_contract() -> None:
    frame, metadata = load_training_dataset(DEFAULT_DATASET_PATH)

    assert metadata["source"] == "packaged clinic_cold_chain_v3"
    assert metadata["raw_rows"] == 115_200
    assert frame["clinic_id"].nunique() == 20
    assert {"temperature_c", "outdoor_temp_c", "forecast_rain_next_6h", "spoilage"}.issubset(frame.columns)
    assert frame[FEATURE_COLUMNS].shape[1] == len(FEATURE_COLUMNS)
    assert not FORBIDDEN_MODEL_COLUMNS.intersection(FEATURE_COLUMNS)
    assert 0.005 < float(frame["spoilage"].mean()) < 0.08
    assert float(frame["temperature_c"].median()) < 8.0
    assert float(frame["outdoor_temp_c"].median()) > 20.0


def test_packaged_dataset_preserves_simulated_follow_up_fields_for_analysis() -> None:
    frame, _ = load_training_dataset(DEFAULT_DATASET_PATH)

    assert {"sms_state", "has_backup", "priority_slack_h", "hours_until_unusable"}.issubset(frame.columns)
    assert set(frame["has_backup"].dropna().unique()).issubset({0, 1})
    assert frame["priority_slack_h"].notna().any()
