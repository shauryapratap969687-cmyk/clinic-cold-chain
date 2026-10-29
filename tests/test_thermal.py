from __future__ import annotations

from backend.simulation import Simulation
from backend.synthetic import SyntheticConfig, generate_dataset
from backend.thermal import (
    THERMAL_MODEL_VERSION,
    forecast_temperature,
    simulate_thermal_trajectory,
    thermal_forecast_validation,
)


def test_newton_model_is_reproducible_and_exposes_physical_scenario_fields() -> None:
    first = generate_dataset(SyntheticConfig(days=180, seed=77))
    second = generate_dataset(SyntheticConfig(days=180, seed=77))
    assert first.equals(second)
    required = {
        "ambient_temp_c", "door_open", "door_open_minutes", "cooling_failure",
        "compressor_on", "compressor_duty", "insulation_tau_hours", "thermal_model",
    }
    assert required.issubset(first.columns)
    assert set(first["thermal_model"]) == {THERMAL_MODEL_VERSION}
    assert first["door_open"].any()
    assert first["cooling_failure"].any()
    assert (first["compressor_duty"] >= 0).all() and (first["compressor_duty"] <= 1).all()


def test_power_failure_uses_newton_warming_and_crosses_limits_from_trajectory() -> None:
    ambient = [22.0] * 6
    actual = simulate_thermal_trajectory(4.5, ambient, power_states=[False] * 6, noise_c=[0.0] * 6)
    temperatures = [row["temperature_c"] for row in actual]
    assert temperatures[-1] > temperatures[0]
    assert temperatures[-1] > 8.0

    forecast = forecast_temperature(4.5, ambient, power_on=False, seed=11)
    assert forecast["status"] == "SIMULATED"
    assert forecast["time_to_limit_hours"] is not None
    assert forecast["time_to_critical_hours"] is not None
    assert forecast["forecast_temperature_c"] > 8.0
    assert forecast["uncertainty_c"] is not None


def test_normal_operation_does_not_invent_a_countdown() -> None:
    forecast = forecast_temperature(4.5, [22.0] * 6, power_on=True, seed=11)
    assert forecast["reliability"] == "reliable"
    assert forecast["time_to_limit_hours"] is None
    assert forecast["possible_limit_breach"] is False
    assert forecast["note"].startswith("SIMULATED")


def test_cooling_failure_and_door_opening_are_modelled_separately() -> None:
    ambient = [22.0] * 6
    failure = simulate_thermal_trajectory(4.5, ambient, cooling_failures=[True] * 6, noise_c=[0.0] * 6)
    door = simulate_thermal_trajectory(4.5, ambient, door_open_minutes=[30.0] * 6, noise_c=[0.0] * 6)
    assert failure[-1]["cooling_failure"] is True
    assert all(row["door_open"] for row in door)
    assert failure[-1]["temperature_c"] > door[-1]["temperature_c"]


def test_held_out_validation_reports_temperature_and_failure_metrics() -> None:
    metrics = thermal_forecast_validation(1234)
    assert metrics["status"] == "SIMULATED"
    assert metrics["validated_on"] == "held-out synthetic scenarios"
    assert metrics["mae_c"] >= 0
    assert metrics["rmse_c"] >= metrics["mae_c"]
    assert metrics["failure_scenarios"]["count"] > 0
    assert metrics["failure_scenarios"]["mae_c"] >= 0


def test_live_simulation_state_exposes_simulated_forecast_and_failure_inputs() -> None:
    simulation = Simulation(bundle=None, seed=42)
    initial = simulation.state()
    clinic = next(row for row in initial["clinics"] if row["id"] == "CL-03")
    assert clinic["thermal_forecast"]["status"] == "SIMULATED"
    assert clinic["thermal_forecast"]["reliability"] == "reliable"
    assert clinic["thermal_forecast"]["measured_temperature_c"] == clinic["temperature_c"]
    assert clinic["thermal_forecast"]["forecast_temperature_c"] is not None
    assert initial["thermal_forecast"]["status"] == "SIMULATED"

    simulation.simulate("trip_feeder", feeder_id=3)
    outage = simulation.simulate("advance", hours=1)
    affected = next(row for row in outage["clinics"] if row["id"] == "CL-03")
    assert affected["power_on"] is False
    assert affected["thermal_forecast"]["status"] == "SIMULATED"
    assert affected["thermal_forecast"]["time_to_limit_hours"] is not None


def test_power_cut_forecast_reports_exact_horizons_and_does_not_change_live_state() -> None:
    simulation = Simulation(bundle=None, seed=42)
    before = simulation.state()
    clinic_before = next(row for row in before["clinics"] if row["id"] == "CL-03")
    forecast = clinic_before["power_cut_forecast"]
    assert forecast["status"] == "SIMULATED"
    assert forecast["scenario"] == "power_cut"
    assert forecast["safe_range_c"] == {"low_c": 2.0, "high_c": 8.0}
    assert forecast["after_1h_c"] == forecast["trajectory"][0]["temperature_c"]
    assert forecast["after_2h_c"] == forecast["trajectory"][1]["temperature_c"]
    assert forecast["after_6h_c"] == forecast["trajectory"][5]["temperature_c"]
    assert clinic_before["power_on"] is True

    after = simulation.state()
    clinic_after = next(row for row in after["clinics"] if row["id"] == "CL-03")
    assert clinic_after["temperature_c"] == clinic_before["temperature_c"]
    assert clinic_after["power_on"] is True
