"""Physics-based synthetic refrigerator temperature modelling.

The model uses Newton's law of cooling for the passive exchange with ambient
air and adds a bounded thermostat/compressor term for an operating refrigerator.
Door openings, power loss, cooling failure, and forced-freeze events are kept as
separate scenario inputs so the forecast remains explainable and reproducible.

All outputs from this module are simulated estimates.  They are not sensor
readings, vaccine stability determinations, or clinical predictions.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Sequence

import numpy as np


THERMAL_MODEL_VERSION = "newton-cooling-refrigerator-v1"
THERMAL_HORIZON_HOURS = 6


@dataclass(frozen=True)
class ThermalParameters:
    """Synthetic refrigerator parameters in degrees Celsius and hours."""

    setpoint_c: float = 4.5
    insulation_tau_hours: float = 24.0
    compressor_capacity_c_per_hour: float = 2.0
    thermostat_gain: float = 0.35
    door_heat_gain_c_per_hour: float = 1.6
    door_compressor_compensation: float = 0.05
    freeze_cooling_c_per_hour: float = 1.8
    cooling_failure_heat_gain_c_per_hour: float = 0.03
    residual_sigma_c: float = 0.08


DEFAULT_THERMAL_PARAMETERS = ThermalParameters()


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


def _finite(value: object) -> bool:
    try:
        return bool(np.isfinite(float(value)))
    except (TypeError, ValueError):
        return False


def thermal_step(
    temperature_c: float,
    ambient_temp_c: float,
    *,
    power_on: bool = True,
    cooling_failure: bool = False,
    freeze_active: bool = False,
    door_open_minutes: float = 0.0,
    insulation_tau_hours: float | None = None,
    dt_hours: float = 1.0,
    noise_c: float = 0.0,
    parameters: ThermalParameters = DEFAULT_THERMAL_PARAMETERS,
) -> dict[str, Any]:
    """Advance one simulated thermal interval.

    The passive term is Newton's law of cooling:

    ``dT/dt = (ambient - T) / tau``

    A powered compressor supplies a thermostat-controlled cooling term.  The
    compressor is not treated as magic: it must have power, and its duty cycle
    increases with temperature error and door-opening load.  Power loss and a
    cooling failure remove that term; a freeze scenario applies a separate
    forced-cooling disturbance used by the existing demo controls.
    """
    temperature = float(temperature_c)
    ambient = float(ambient_temp_c)
    dt = float(dt_hours)
    if not (_finite(temperature) and _finite(ambient) and _finite(dt)):
        raise ValueError("thermal inputs must be finite")
    if dt < 0:
        raise ValueError("dt_hours must be non-negative")
    tau = float(insulation_tau_hours or parameters.insulation_tau_hours)
    if not _finite(tau) or tau <= 0:
        raise ValueError("insulation_tau_hours must be positive")

    door_minutes = _clamp(door_open_minutes, 0.0, 60.0)
    door_fraction = door_minutes / 60.0
    ambient_exchange = (ambient - temperature) / tau * dt
    compressor_duty = 0.0
    compressor_on = False
    compressor_cooling = 0.0

    if freeze_active:
        compressor_duty = 1.0
        compressor_on = True
        compressor_cooling = parameters.freeze_cooling_c_per_hour * dt
    elif power_on and not cooling_failure:
        # The base duty offsets the expected ambient load.  The temperature
        # error and door-opening load then make the compressor work harder.
        base_duty = max(0.0, (ambient - parameters.setpoint_c) / (tau * parameters.compressor_capacity_c_per_hour))
        error_duty = parameters.thermostat_gain * (temperature - parameters.setpoint_c)
        door_duty = parameters.door_compressor_compensation * door_fraction
        compressor_duty = _clamp(base_duty + error_duty + door_duty, 0.0, 1.0)
        compressor_on = compressor_duty >= 0.05
        compressor_cooling = parameters.compressor_capacity_c_per_hour * compressor_duty * dt

    door_heat = parameters.door_heat_gain_c_per_hour * door_fraction * dt
    failure_heat = parameters.cooling_failure_heat_gain_c_per_hour * dt if cooling_failure else 0.0
    next_temperature = temperature + ambient_exchange + door_heat + failure_heat - compressor_cooling + float(noise_c)

    return {
        "temperature_c": round(float(next_temperature), 4),
        "compressor_on": bool(compressor_on),
        "compressor_duty": round(float(compressor_duty), 4),
        "ambient_exchange_c": round(float(ambient_exchange), 4),
        "door_heat_c": round(float(door_heat), 4),
        "compressor_cooling_c": round(float(compressor_cooling), 4),
        "cooling_failure": bool(cooling_failure),
        "door_open": bool(door_minutes > 0),
        "door_open_minutes": round(float(door_minutes), 2),
        "thermal_model": THERMAL_MODEL_VERSION,
    }


def simulate_thermal_trajectory(
    initial_temperature_c: float,
    ambient_temps_c: Sequence[float],
    *,
    power_states: Sequence[bool] | None = None,
    cooling_failures: Sequence[bool] | None = None,
    freeze_states: Sequence[bool] | None = None,
    door_open_minutes: Sequence[float] | None = None,
    insulation_tau_hours: float = DEFAULT_THERMAL_PARAMETERS.insulation_tau_hours,
    noise_c: Sequence[float] | None = None,
    parameters: ThermalParameters = DEFAULT_THERMAL_PARAMETERS,
) -> list[dict[str, Any]]:
    """Simulate a sequence of known scenario inputs."""
    horizon = len(ambient_temps_c)
    power = list(power_states or [True] * horizon)
    failures = list(cooling_failures or [False] * horizon)
    freezes = list(freeze_states or [False] * horizon)
    doors = list(door_open_minutes or [0.0] * horizon)
    noise = list(noise_c or [0.0] * horizon)
    if not all(len(values) == horizon for values in (power, failures, freezes, doors, noise)):
        raise ValueError("thermal scenario sequences must have the same length")

    current = float(initial_temperature_c)
    trajectory: list[dict[str, Any]] = []
    for index, ambient in enumerate(ambient_temps_c):
        step = thermal_step(
            current,
            float(ambient),
            power_on=bool(power[index]),
            cooling_failure=bool(failures[index]),
            freeze_active=bool(freezes[index]),
            door_open_minutes=float(doors[index]),
            insulation_tau_hours=insulation_tau_hours,
            noise_c=float(noise[index]),
            parameters=parameters,
        )
        current = float(step["temperature_c"])
        trajectory.append({"hours_ahead": index + 1, "ambient_temp_c": round(float(ambient), 3), **step})
    return trajectory


def _crossing_time(
    initial_temperature_c: float,
    temperatures: Sequence[float],
    limit_c: float,
    direction: str,
) -> float | None:
    values = [float(initial_temperature_c), *[float(value) for value in temperatures]]
    for index, value in enumerate(values):
        if (direction == "above" and value >= limit_c) or (direction == "below" and value <= limit_c):
            return float(index)
    return None


def _first_limit_crossing(
    initial_temperature_c: float,
    temperatures: Sequence[float],
    warning_limit_c: float,
    critical_low_c: float,
    critical_high_c: float,
) -> tuple[float | None, str | None]:
    candidates = [
        (_crossing_time(initial_temperature_c, temperatures, warning_limit_c, "above"), "high_warning"),
        (_crossing_time(initial_temperature_c, temperatures, critical_low_c, "below"), "low_critical"),
        (_crossing_time(initial_temperature_c, temperatures, critical_high_c, "above"), "high_critical"),
    ]
    candidates = [(time, direction) for time, direction in candidates if time is not None]
    return min(candidates, key=lambda item: item[0]) if candidates else (None, None)


def _unavailable_forecast(reason: str, horizon_hours: int) -> dict[str, Any]:
    return {
        "status": "SIMULATED",
        "reliability": "unreliable",
        "thermal_model": THERMAL_MODEL_VERSION,
        "horizon_hours": int(horizon_hours),
        "measured_temperature_c": None,
        "forecast_temperature_c": None,
        "forecast_low_c": None,
        "forecast_high_c": None,
        "uncertainty_c": None,
        "time_to_limit_hours": None,
        "time_to_warning_hours": None,
        "time_to_critical_hours": None,
        "limit_breach_direction": None,
        "possible_limit_breach": False,
        "trajectory": [],
        "note": reason,
    }


def unavailable_forecast(reason: str, horizon_hours: int = THERMAL_HORIZON_HOURS) -> dict[str, Any]:
    """Return an explicit no-countdown result when inputs are not usable."""
    return _unavailable_forecast(reason, int(horizon_hours))


def forecast_temperature(
    measured_temperature_c: float,
    ambient_forecast_c: Sequence[float],
    *,
    power_on: bool = True,
    cooling_failure: bool = False,
    freeze_active: bool = False,
    door_open_minutes: float = 0.0,
    insulation_tau_hours: float = DEFAULT_THERMAL_PARAMETERS.insulation_tau_hours,
    warning_limit_c: float = 6.0,
    critical_low_c: float = 2.0,
    critical_high_c: float = 8.0,
    seed: int = 42,
    ensemble_size: int = 48,
    door_open_probability: float = 0.08,
    parameters: ThermalParameters = DEFAULT_THERMAL_PARAMETERS,
) -> dict[str, Any]:
    """Forecast the next six hours with a reproducible uncertainty ensemble.

    Future door openings and residual disturbances are unknown, so the forecast
    samples them from the synthetic scenario distribution.  Power and cooling
    failure states are held at their current state; this is explicit and avoids
    inventing an unobserved repair countdown.
    """
    horizon = len(ambient_forecast_c)
    if horizon <= 0 or not _finite(measured_temperature_c) or not all(_finite(value) for value in ambient_forecast_c):
        return _unavailable_forecast("Current temperature or ambient forecast is unavailable.", max(horizon, THERMAL_HORIZON_HOURS))
    if not 1 <= ensemble_size <= 256:
        raise ValueError("ensemble_size must be between 1 and 256")

    rng = np.random.default_rng(int(seed))
    members: list[list[float]] = []
    for _ in range(ensemble_size):
        current = float(measured_temperature_c)
        path: list[float] = []
        for hour, expected_ambient in enumerate(ambient_forecast_c):
            door_minutes = float(door_open_minutes) if hour == 0 else 0.0
            if hour > 0 and rng.random() < _clamp(door_open_probability, 0.0, 1.0):
                door_minutes = float(rng.uniform(8.0, 30.0))
            ambient = float(expected_ambient) + float(rng.normal(0.0, 0.45))
            step = thermal_step(
                current,
                ambient,
                power_on=power_on,
                cooling_failure=cooling_failure,
                freeze_active=freeze_active,
                door_open_minutes=door_minutes,
                insulation_tau_hours=insulation_tau_hours,
                noise_c=float(rng.normal(0.0, parameters.residual_sigma_c)),
                parameters=parameters,
            )
            current = float(step["temperature_c"])
            path.append(current)
        members.append(path)

    values = np.asarray(members, dtype=float)
    mean_path = np.mean(values, axis=0)
    low_path = np.quantile(values, 0.10, axis=0)
    high_path = np.quantile(values, 0.90, axis=0)
    warning_time = _crossing_time(measured_temperature_c, mean_path, warning_limit_c, "above")
    low_critical_time = _crossing_time(measured_temperature_c, mean_path, critical_low_c, "below")
    high_critical_time = _crossing_time(measured_temperature_c, mean_path, critical_high_c, "above")
    critical_times = [value for value in (low_critical_time, high_critical_time) if value is not None]
    limit_time, direction = _first_limit_crossing(
        measured_temperature_c, mean_path, warning_limit_c, critical_low_c, critical_high_c
    )
    possible_crossing = any(
        _first_limit_crossing(measured_temperature_c, path, warning_limit_c, critical_low_c, critical_high_c)[0] is not None
        for path in values
    )
    final_uncertainty = max(0.0, float((high_path[-1] - low_path[-1]) / 2.0))
    reliability = "reliable" if final_uncertainty <= 1.5 else "unreliable"
    note = "SIMULATED forecast; no temperature limit breach predicted in the six-hour mean trajectory."
    if limit_time is not None:
        note = "SIMULATED forecast; the mean trajectory reaches a configured temperature limit."
    elif possible_crossing:
        note = "SIMULATED forecast; some uncertainty members cross a limit, but the mean trajectory does not."
    if reliability == "unreliable":
        note = "SIMULATED forecast uncertainty is high; do not use the countdown operationally."

    trajectory = [
        {
            "hours_ahead": index + 1,
            "temperature_c": round(float(mean_path[index]), 2),
            "low_c": round(float(low_path[index]), 2),
            "high_c": round(float(high_path[index]), 2),
        }
        for index in range(horizon)
    ]
    return {
        "status": "SIMULATED",
        "reliability": reliability,
        "thermal_model": THERMAL_MODEL_VERSION,
        "horizon_hours": int(horizon),
        "measured_temperature_c": round(float(measured_temperature_c), 2),
        "forecast_temperature_c": round(float(mean_path[-1]), 2),
        "forecast_low_c": round(float(low_path[-1]), 2),
        "forecast_high_c": round(float(high_path[-1]), 2),
        "uncertainty_c": round(final_uncertainty, 2),
        "time_to_limit_hours": round(float(limit_time), 2) if limit_time is not None and reliability == "reliable" else None,
        "time_to_warning_hours": round(float(warning_time), 2) if warning_time is not None and reliability == "reliable" else None,
        "time_to_critical_hours": round(float(min(critical_times)), 2) if critical_times and reliability == "reliable" else None,
        "limit_breach_direction": direction if limit_time is not None and reliability == "reliable" else None,
        "possible_limit_breach": bool(possible_crossing),
        "trajectory": trajectory,
        "note": note,
    }


def _scenario_crossing(temperatures: Sequence[float], warning_limit_c: float = 6.0) -> float | None:
    crossing, _ = _first_limit_crossing(temperatures[0], temperatures[1:], warning_limit_c, 2.0, 8.0)
    return crossing


@lru_cache(maxsize=8)
def thermal_forecast_validation(seed: int = 2026) -> dict[str, Any]:
    """Validate the forecast on deterministic held-out synthetic scenarios."""
    rng = np.random.default_rng(int(seed))
    errors: list[float] = []
    crossing_errors: list[float] = []
    failure_errors: list[float] = []
    failure_crossing_errors: list[float] = []
    matched_crossings = 0
    missed_crossings = 0
    scenario_count = 48
    failure_count = 0

    for index in range(scenario_count):
        scenario = ("normal", "door_open", "power_outage", "cooling_failure")[index % 4]
        horizon = THERMAL_HORIZON_HOURS
        initial = float(rng.uniform(3.8, 5.2))
        ambient = [float(20.0 + 4.0 * np.sin((index + hour) / 4.0) + rng.normal(0.0, 0.3)) for hour in range(horizon)]
        power = [scenario != "power_outage"] * horizon
        failures = [scenario == "cooling_failure"] * horizon
        doors = [0.0] * horizon
        if scenario == "door_open":
            doors[0] = 30.0
            doors[1] = 15.0
        else:
            doors = [float(rng.uniform(0.0, 30.0)) if rng.random() < 0.08 else 0.0 for _ in range(horizon)]
        actual = simulate_thermal_trajectory(
            initial,
            ambient,
            power_states=power,
            cooling_failures=failures,
            door_open_minutes=doors,
            insulation_tau_hours=float(rng.uniform(20.0, 28.0)),
            noise_c=[float(rng.normal(0.0, DEFAULT_THERMAL_PARAMETERS.residual_sigma_c)) for _ in range(horizon)],
        )
        forecast = forecast_temperature(
            initial,
            ambient,
            power_on=power[0],
            cooling_failure=failures[0],
            door_open_minutes=doors[0],
            insulation_tau_hours=24.0,
            seed=int(seed + index + 1),
        )
        actual_path = [float(row["temperature_c"]) for row in actual]
        predicted_path = [float(row["temperature_c"]) for row in forecast["trajectory"]]
        differences = np.asarray(predicted_path) - np.asarray(actual_path)
        errors.extend(np.abs(differences).tolist())
        actual_crossing = _scenario_crossing([initial, *actual_path])
        predicted_crossing = _scenario_crossing([initial, *predicted_path])
        if actual_crossing is not None and predicted_crossing is not None:
            crossing_errors.append(abs(actual_crossing - predicted_crossing))
            matched_crossings += 1
        elif actual_crossing is not None:
            missed_crossings += 1
        if scenario in {"power_outage", "cooling_failure"}:
            failure_count += 1
            failure_errors.extend(np.abs(differences).tolist())
            if actual_crossing is not None and predicted_crossing is not None:
                failure_crossing_errors.append(abs(actual_crossing - predicted_crossing))

    def mean_or_none(values: Sequence[float]) -> float | None:
        return round(float(np.mean(values)), 3) if values else None

    return {
        "status": "SIMULATED",
        "validated_on": "held-out synthetic scenarios",
        "thermal_model": THERMAL_MODEL_VERSION,
        "scenario_count": scenario_count,
        "horizon_hours": THERMAL_HORIZON_HOURS,
        "mae_c": round(float(np.mean(errors)), 3),
        "rmse_c": round(float(np.sqrt(np.mean(np.square(errors)))), 3),
        "threshold_crossing_time_mae_hours": mean_or_none(crossing_errors),
        "threshold_crossing_matches": matched_crossings,
        "threshold_crossing_misses": missed_crossings,
        "failure_scenarios": {
            "count": failure_count,
            "mae_c": round(float(np.mean(failure_errors)), 3) if failure_errors else None,
            "rmse_c": round(float(np.sqrt(np.mean(np.square(failure_errors)))), 3) if failure_errors else None,
            "threshold_crossing_time_mae_hours": mean_or_none(failure_crossing_errors),
        },
        "note": "Synthetic validation only; these metrics do not establish real refrigerator or vaccine accuracy.",
    }
