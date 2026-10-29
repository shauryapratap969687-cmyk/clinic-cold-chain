"""
Synthetic hourly data for rural clinics (cold-chain predictor).

Writes three files:
  synthetic_clinic_data.csv  one row per clinic per hour (the main dataset)
  outage_events.csv          one row per outage: when power was cut, when it came back, why
  clinics.csv                per-clinic facts, including hidden "ground truth" for checking models

Main columns
  Identity / time  clinic_id, feeder_id, hour, day_of_week (0=Mon), month, is_evening
  Weather          temperature_c, humidity_pct, rain_mm, wind_kmh, weather_condition
  Forecast         forecast_rain_next_6h_mm, forecast_max_wind_next_6h_kmh
                   (what a forecast feed said at this hour about the NEXT 6 hours; it has errors)
  Grid             outage (power is out this hour), outage_started (an outage began this hour)
  Outage memory    hours_since_last_outage, outages_last_24h, outages_last_7d, rain_last_3h
  Hub distance     distance_from_hub_km, travel_time_h (slower in rain)
  Backup power     power_source (grid / battery / none), battery_pct, backup_runtime_left_h
  Fridge           fridge_temp_c (noisy sensor reading), holdover_h, hours_until_unusable,
                   cold_chain_breach
  Forecast label   outage_starts_next_6h  (what the outage-prediction model learns to predict)

Outages come in two layers. A FEEDER outage cuts power to every clinic on that feeder at the
same moment (feeders group clinics by distance from the hub). A LOCAL outage hits one clinic.

hours_until_unusable = backup runtime left + how long the fridge alone can hold <= 8C
if all power stopped right now. During an outage this is a true countdown.

Sensor realism: weather, fridge, battery and power_source columns have measurement noise,
occasional glitch spikes on the fridge probe, and missing values (blank cells). Gateway
dropouts are more likely during outages. holdover_h and hours_until_unusable are computed from
those observed readings, so they go blank when an input is missing. The outage flags and
cold_chain_breach (true temperature >= 8C) are clean ground truth, never missing.
true_fridge_temp_c is the real fridge temperature with no noise, kept only to check estimators.

ALL OF THIS IS SIMULATED. Tune the PARAMETERS section and check the printed
summary against real reliability statistics before relying on it.
Seasons: a yearly temperature cycle and a dry season (Jan to May) / monsoon (Jun to Sep) rain pattern, so
`month` now carries signal. 240 days from 2025-01-01.
Extra columns (v2): local_fault, feeder_online (why the power is out), outage_hours (hours into the current
outage), fridge_temp_lag1_c / fridge_temp_delta_c, breach_next_6h (true temperature reaches 8 C within 6 h) and
breach_next_6h_new (same, only for hours with power on and the fridge still fine: new problems, not persistence).
Never use breach_next_6h*, cold_chain_breach, true_fridge_temp_c as model inputs.
"""

import numpy as np
import pandas as pd

# ---------------- PARAMETERS (tune these) ----------------
SEED = 42
N_CLINICS = 20
N_FEEDERS = 6                      # clinics are grouped into feeders by distance from the hub
N_DAYS = 240                       # same span as the uploaded dataset
START_DATE = "2025-01-01"          # Jan to Aug: cool dry season, hot pre-monsoon, then monsoon

# Weather
BASE_TEMP_C = 27.5                 # average daily temperature over the year
SEASON_SWING_C = 6.5               # yearly swing: coolest in January, hottest around late May
RAIN_START_MULT_DRY = 0.35         # rain spells start this much as often in the dry season (Jan to May)
RAIN_START_MULT_WET = 1.6          # and this much as often in the monsoon (Jun to Sep)
DIURNAL_SWING_C = 5.0              # day/night temperature swing
P_RAIN_START = 0.04                # chance a dry hour turns into a rain spell
P_RAIN_STOP = 0.25                 # chance a rainy hour ends the spell

# Grid outages. Two layers: FEEDER outages hit every clinic on a feeder at once,
# LOCAL outages (transformer, service line) hit one clinic. Tuned so about 3% of
# all clinic-hours are without grid power.
FEEDER_BASE_P = 0.00343            # baseline chance a feeder outage starts in any hour
FEEDER_FAULT_P = 0.00086           # feeder faults unrelated to weather or time
FEEDER_DURATION_MEDIAN_H = 1.8     # median feeder outage length (hours)
LOCAL_BASE_P = 0.00196             # baseline chance a local outage starts in any hour
LOCAL_FAULT_P = 0.00049            # local faults unrelated to weather or time
LOCAL_DURATION_MEDIAN_H = 1.2
EVENING_HOURS = range(18, 23)      # 6pm to 10pm
EVENING_MULT = 2.5
RAIN_MULT_PER_MM = 0.35            # extra multiplier per mm/hr of rain
RAIN_MULT_CAP = 5.0
WIND_MULT_PER_KMH = 0.03           # extra multiplier per km/h of wind above 25
WIND_MULT_CAP = 3.0
AFTERSHOCK_MULT = 1.5              # hazard boost for 6 hours after an outage ends
DURATION_SIGMA = 0.9               # spread of the lognormal (bigger = heavier tail)
DURATION_MAX_H = 24

# Distance from hub (farther clinics sit at the end of the feeder: weaker grid, slower trips)
DIST_RANGE_KM = (5, 90)
SPEED_DRY_KMH = 25
SPEED_RAIN_KMH = 15

# Backup power (battery / inverter that keeps the fridge running during an outage)
BACKUP_RUNTIME_CHOICES_H = [0, 2, 4, 6, 8]   # hours of fridge runtime on a full battery
BACKUP_RUNTIME_PROBS = [0.78, 0.04, 0.09, 0.06, 0.03]   # 0 = no backup at all: only about 1 clinic in 5 has one
BATTERY_CHARGE_PCT_PER_H = 15      # recharge speed while the grid is on

# Fridge
FRIDGE_SAFE_MAX_C = 8.0            # medicine is unusable above this
FRIDGE_TAU_MEAN_H = 30.0           # how slowly an unpowered fridge warms (bigger = holds longer)
FRIDGE_TAU_SD_H = 6.0
COOLING_TAU_H = 1.0                # how fast a powered fridge recovers to its setpoint
INDOOR_OFFSET_C = 1.0              # room is slightly warmer than outdoors
DOOR_OPEN_P = 0.15                 # chance per daytime hour (8am to 6pm) of a door opening
DOOR_BUMP_C = (0.3, 1.2)           # temperature jump from a door opening
HOLDOVER_CAP_H = 72

# Sensor realism: noise, spikes and missing values (applied to what the dashboard sees;
# the outage flags and cold_chain_breach stay clean as ground truth)
SENSOR_NOISE_C = 0.25              # fridge probe noise (std dev, deg C)
SPIKE_P = 0.003                    # chance per hour of a glitch reading on the fridge probe
SPIKE_SIZE_C = (3.0, 6.0)          # size of a glitch (random direction)
BATTERY_NOISE_PCT = 1.5            # battery gauge noise (std dev, percentage points)
WX_NOISE_TEMP_C = 0.5              # weather feed noise: temperature (std dev)
WX_NOISE_HUM_PCT = 3.0             # humidity
WX_NOISE_RAIN_FRAC = 0.15          # rain: typical +/- 15% error on a reading
WX_NOISE_WIND_KMH = 2.0            # wind
GATEWAY_DROP_P = 0.01              # chance per hour the clinic's IoT gateway misses a reading
GATEWAY_DROP_EXTRA_IN_OUTAGE = 0.04  # extra dropout chance during an outage (towers lose power too)
GATEWAY_BURSTS_PER_100_DAYS = 3    # average multi-hour connectivity losses per clinic per 100 days
GATEWAY_BURST_LEN_H = (3, 12)      # how long those last
BATTERY_DROP_P = 0.005             # extra chance the battery gauge alone is missing
WEATHER_DROP_P = 0.005             # chance per hour, per weather column, that the feed is missing

# Weather forecast feed (says what the next 6 hours will bring, with errors)
FORECAST_HORIZON_H = 6
FORECAST_RAIN_ERR_FRAC = 0.35      # forecast rain is typically off by about +/- 35%
FORECAST_RAIN_ADD_MM = 1.0         # plus a small additive error (std dev, mm)
FORECAST_WIND_ERR_KMH = 4.0        # forecast max wind error (std dev)
FORECAST_MISS_P = 0.08             # chance the forecast badly under-calls an event (x0.2)

# SMS follow-up (only clinics WITH a backup are texted when an outage starts)
SMS_LATENCY_MIN = (1, 5)           # minutes from outage start until the text is sent
SMS_REPLY_P = 0.85                 # chance the health worker answers at all
SMS_REPLY_MEDIAN_MIN = 25          # typical time to tap a reply (minutes)
SMS_REPLY_SIGMA = 0.8              # spread of reply times (lognormal)
SMS_REPLY_CLIP_MIN = (3, 240)
SMS_WRONG_TAP_P = 0.03             # chance the worker taps the wrong button
BACKUP_FAULT_P = 0.12              # chance a backup fails to start in a given outage (inverter or battery fault)

# Forecast label
LABEL_HORIZON_H = 6                # "will an outage start in the next 6 hours?"
# ----------------------------------------------------------

rng = np.random.default_rng(SEED)
n_hours = N_DAYS * 24
times = pd.date_range(START_DATE, periods=n_hours, freq="h")
hour_of_day = times.hour.to_numpy()
day_of_week = times.dayofweek.to_numpy()
month_of_year = times.month.to_numpy()
is_evening = np.isin(hour_of_day, list(EVENING_HOURS)).astype(int)
day_of_year = times.dayofyear.to_numpy()
season_temp = SEASON_SWING_C * np.sin(2 * np.pi * (day_of_year - 60) / 365)      # peaks about 31 May
rain_season_mult = np.where(month_of_year <= 5, RAIN_START_MULT_DRY,
                            np.where(month_of_year <= 9, RAIN_START_MULT_WET, 0.8))
wetness = (rain_season_mult - RAIN_START_MULT_DRY) / (RAIN_START_MULT_WET - RAIN_START_MULT_DRY)   # 0 dry .. 1 monsoon


def make_regional_weather():
    """Weather shared by everyone: temperature and rain spells."""
    # Temperature: daily cycle (peak ~3pm) + slowly drifting noise
    diurnal = DIURNAL_SWING_C * np.sin(2 * np.pi * (hour_of_day - 9) / 24)
    noise = np.zeros(n_hours)
    for t in range(1, n_hours):
        noise[t] = 0.95 * noise[t - 1] + rng.normal(0, 0.4)
    # Rain spells: a two-state Markov chain (dry <-> raining)
    raining = np.zeros(n_hours, dtype=bool)
    for t in range(1, n_hours):
        if raining[t - 1]:
            raining[t] = rng.random() > P_RAIN_STOP
        else:
            raining[t] = rng.random() < P_RAIN_START * rain_season_mult[t]
    # Rain makes it cooler
    temp = BASE_TEMP_C + season_temp + diurnal + noise - 2.5 * raining
    return temp, raining


def simulate_outages(base_p, weakness, fault_p, median_h, rain, wind, u_start, z_dur):
    """Hour-by-hour outage process. Returns 1 for every hour the power is out.
    The chance an outage starts rises with rain, wind, the evening peak and a recent outage."""
    out = np.zeros(n_hours, dtype=int)
    outage_end = -1                               # hour index when the current outage ends
    last_end = -999                               # when the previous outage ended
    for t in range(n_hours):
        if t < outage_end:
            out[t] = 1
            continue
        p = base_p * weakness
        if hour_of_day[t] in EVENING_HOURS:
            p *= EVENING_MULT
        p *= min(1 + RAIN_MULT_PER_MM * rain[t], RAIN_MULT_CAP)
        p *= min(1 + WIND_MULT_PER_KMH * max(wind[t] - 25, 0), WIND_MULT_CAP)
        if t - last_end <= 6:
            p *= AFTERSHOCK_MULT
        p += fault_p
        if u_start[t] < min(p, 0.9):
            duration = np.exp(np.log(median_h) + DURATION_SIGMA * z_dur[t])
            duration = int(np.clip(np.ceil(duration), 1, DURATION_MAX_H))
            outage_end = t + duration
            last_end = outage_end
            out[t] = 1
    return out


regional_temp, regional_raining = make_regional_weather()

# ---------- pass 1: fixed facts about every clinic ----------
# Each clinic gets its own random stream. Everything random is drawn up front, so changing
# the outage settings never reshuffles weather, clinic facts or sensor noise.
rcs, facts = {}, {}
for clinic_id in range(1, N_CLINICS + 1):
    rc = np.random.default_rng([SEED, clinic_id])
    distance_km = float(rc.uniform(*DIST_RANGE_KM))
    facts[clinic_id] = {
        "distance_km": distance_km,
        "grid_weakness": float(rc.lognormal(0, 0.3) * (0.7 + distance_km / 100)),  # >1 = weaker
        "backup_h": int(rc.choice(BACKUP_RUNTIME_CHOICES_H, p=BACKUP_RUNTIME_PROBS)),
        "fridge_tau": float(np.clip(rc.normal(FRIDGE_TAU_MEAN_H, FRIDGE_TAU_SD_H), 12, 48)),
        "setpoint": float(rc.uniform(3.0, 5.0)),
    }
    rcs[clinic_id] = rc

# ---------- feeders: nearby clinics (by distance from the hub) share a feeder ----------
by_distance = sorted(facts, key=lambda c: facts[c]["distance_km"])
feeder_of = {}
for f, group in enumerate(np.array_split(by_distance, N_FEEDERS), start=1):
    for c in group:
        feeder_of[int(c)] = f

feeder_out, feeder_weakness = {}, {}
for f in range(1, N_FEEDERS + 1):
    members = [c for c in facts if feeder_of[c] == f]
    mean_dist = float(np.mean([facts[c]["distance_km"] for c in members]))
    rf = np.random.default_rng([SEED, 1000 + f])
    weak = float(rf.lognormal(0, 0.3) * (0.7 + mean_dist / 100))
    f_rain = np.where(regional_raining & (rf.random(n_hours) > 0.10),
                      rf.gamma(2.0, 2.0, n_hours), 0.0)
    f_wind = rf.gamma(3.0, 4.0, n_hours) + np.where(f_rain > 0, rf.gamma(2.0, 5.0, n_hours), 0.0)
    feeder_out[f] = simulate_outages(FEEDER_BASE_P, weak, FEEDER_FAULT_P, FEEDER_DURATION_MEDIAN_H,
                                     f_rain, f_wind, rf.random(n_hours), rf.standard_normal(n_hours))
    feeder_weakness[f] = weak

# ---------- pass 2: simulate each clinic ----------
rows, event_rows, clinic_rows, sms_rows = [], [], [], []
cool_k = 1 - np.exp(-1 / COOLING_TAU_H)

for clinic_id in range(1, N_CLINICS + 1):
    rc = rcs[clinic_id]
    distance_km = facts[clinic_id]["distance_km"]
    grid_weakness = facts[clinic_id]["grid_weakness"]
    backup_h = facts[clinic_id]["backup_h"]
    fridge_tau = facts[clinic_id]["fridge_tau"]
    setpoint = facts[clinic_id]["setpoint"]
    feeder = feeder_of[clinic_id]
    warm_k = 1 - np.exp(-1 / fridge_tau)

    # ---------- weather: regional + local differences ----------
    temp = regional_temp + rc.normal(0, 0.8, n_hours)
    local_rain = regional_raining & (rc.random(n_hours) > 0.15)
    rain = np.where(local_rain, rc.gamma(2.0, 2.0, n_hours), 0.0)       # mm/hr
    wind = rc.gamma(3.0, 4.0, n_hours) + np.where(rain > 0, rc.gamma(2.0, 5.0, n_hours), 0.0)
    humidity = 55 + 20 * wetness + 12 * (rain > 0) - 1.2 * (temp - BASE_TEMP_C - season_temp) + rc.normal(0, 4, n_hours)
    humidity = np.clip(humidity, 20, 100)
    room = temp + INDOOR_OFFSET_C

    # random numbers for the outage process and the hour-by-hour loop
    u_start = rc.random(n_hours)                  # decides whether a local outage starts
    z_dur = rc.standard_normal(n_hours)           # decides how long it lasts
    u_door = rc.random(n_hours)                   # decides whether the fridge door opens
    door_bump = rc.uniform(*DOOR_BUMP_C, n_hours) # how much a door opening warms the fridge
    sensor_noise = rc.normal(0, SENSOR_NOISE_C, n_hours)

    # random numbers for sensor glitches and gaps
    spike_u = rc.random(n_hours)
    spike_sign = rc.choice([-1.0, 1.0], n_hours)
    spike_size = rc.uniform(*SPIKE_SIZE_C, n_hours)
    batt_noise = rc.normal(0, BATTERY_NOISE_PCT, n_hours)
    wx_noise_t = rc.normal(0, WX_NOISE_TEMP_C, n_hours)
    wx_noise_h = rc.normal(0, WX_NOISE_HUM_PCT, n_hours)
    wx_noise_w = rc.normal(0, WX_NOISE_WIND_KMH, n_hours)
    rain_noise = rc.normal(0, WX_NOISE_RAIN_FRAC, n_hours)
    u_gate = rc.random(n_hours)
    u_batt = rc.random(n_hours)
    u_wx = rc.random((4, n_hours))                # temperature, humidity, rain, wind

    # random numbers for the forecast feed
    fc_rain_err = rc.normal(0, FORECAST_RAIN_ERR_FRAC, n_hours)
    fc_rain_add = rc.normal(0, FORECAST_RAIN_ADD_MM, n_hours)
    fc_wind_err = rc.normal(0, FORECAST_WIND_ERR_KMH, n_hours)
    u_fmiss = rc.random(n_hours)
    u_fx = rc.random((2, n_hours))                # forecast rain, forecast wind

    # drawn last, because the count varies
    n_bursts = rc.poisson(GATEWAY_BURSTS_PER_100_DAYS * N_DAYS / 100)
    burst_starts = rc.integers(0, n_hours, n_bursts)
    burst_lens = rc.integers(GATEWAY_BURST_LEN_H[0], GATEWAY_BURST_LEN_H[1] + 1, n_bursts)

    # ---------- grid outages: this clinic's feeder going down, or a local fault ----------
    local_out = simulate_outages(LOCAL_BASE_P, grid_weakness, LOCAL_FAULT_P, LOCAL_DURATION_MEDIAN_H,
                                 rain, wind, u_start, z_dur)
    outage = np.maximum(local_out, feeder_out[feeder])
    started = ((outage == 1) & (np.concatenate(([0], outage[:-1])) == 0)).astype(int)
    feeder_online = 1 - feeder_out[feeder]                  # ground truth: did the clinic's feeder have power
    local_fault = local_out                                  # ground truth: a local fault at this clinic
    run_starts = np.flatnonzero(started)
    run_ends = np.flatnonzero((outage[:-1] == 1) & (outage[1:] == 0)) + 1
    if outage[-1] == 1:
        run_ends = np.append(run_ends, n_hours)
    events = list(zip(run_starts, run_ends))      # (hour power cut, hour power came back)

    # backup faults: in some outages the backup does not start even though the clinic owns one
    rs_fault = np.random.default_rng([SEED, 6000 + clinic_id])
    backup_down = np.zeros(n_hours, dtype=bool)
    for e0, e1 in events:
        if rs_fault.random() < BACKUP_FAULT_P:
            backup_down[e0:e1] = True

    # ---------- backup battery and fridge, hour by hour ----------
    battery = np.zeros(n_hours)
    fridge_true = np.zeros(n_hours)
    since_back = np.zeros(n_hours)
    source = np.empty(n_hours, dtype=object)
    batt = 100.0 if backup_h > 0 else 0.0
    T = setpoint
    since = 168.0

    for t in range(n_hours):
        # Backup battery: drains during an outage, recharges when the grid is on
        grid_on = outage[t] == 0
        backup_running = (not grid_on) and backup_h > 0 and batt > 0 and not backup_down[t]
        powered = grid_on or backup_running
        if grid_on:
            source[t] = "grid"
            if backup_h > 0:
                batt = min(100.0, batt + BATTERY_CHARGE_PCT_PER_H)
        elif backup_running:
            source[t] = "battery"
            batt = max(0.0, batt - 100.0 / backup_h)
            if batt < 1e-6:
                batt = 0.0
        else:
            source[t] = "none"
        battery[t] = batt

        # Fridge temperature: cools toward its setpoint if powered, warms toward room if not
        if 8 <= hour_of_day[t] < 18 and u_door[t] < DOOR_OPEN_P:
            T += door_bump[t]
        if powered:
            T += (setpoint - T) * cool_k
        else:
            T += (room[t] - T) * warm_k
        fridge_true[t] = T

        # Memory feature: hours since power last came back
        since = 0.0 if outage[t] else min(since + 1, 168.0)
        since_back[t] = since

    # ---------- what the sensors / dashboard would actually see ----------
    # Noise: fridge probe (plus rare glitch spikes), battery gauge, weather feed
    sensor = fridge_true + sensor_noise + np.where(spike_u < SPIKE_P, spike_sign * spike_size, 0.0)
    batt_obs = np.clip(battery + batt_noise, 0, 100)
    temp_obs = temp + wx_noise_t
    hum_obs = np.clip(humidity + wx_noise_h, 0, 100)
    rain_obs = np.where(rain > 0, rain * np.exp(rain_noise), 0.0)
    wind_obs = np.clip(wind + wx_noise_w, 0, None)

    # Missing values: IoT gateway dropouts (random, worse during outages, plus multi-hour
    # connectivity losses) hit the fridge probe, battery gauge and power-source reading together
    gate_missing = u_gate < GATEWAY_DROP_P + GATEWAY_DROP_EXTRA_IN_OUTAGE * outage
    for b_start, b_len in zip(burst_starts, burst_lens):
        gate_missing[b_start:b_start + b_len] = True
    batt_missing = gate_missing | (u_batt < BATTERY_DROP_P)
    sensor = np.where(gate_missing, np.nan, sensor)
    batt_obs = np.where(batt_missing, np.nan, batt_obs)
    source_obs = np.where(gate_missing, np.nan, source)
    # The weather feed has its own, rarer gaps, separately for each column
    temp_obs = np.where(u_wx[0] < WEATHER_DROP_P, np.nan, temp_obs)
    hum_obs = np.where(u_wx[1] < WEATHER_DROP_P, np.nan, hum_obs)
    rain_obs = np.where(u_wx[2] < WEATHER_DROP_P, np.nan, rain_obs)
    wind_obs = np.where(u_wx[3] < WEATHER_DROP_P, np.nan, wind_obs)

    # Weather label is worked out from the observed readings; blank if any input is missing
    weather_condition = np.select(
        [(rain_obs >= 10) | (wind_obs >= 45), rain_obs >= 5, rain_obs > 0, hum_obs >= 80],
        ["storm", "heavy_rain", "light_rain", "cloudy"],
        default="clear",
    ).astype(object)
    weather_condition[np.isnan(rain_obs) | np.isnan(wind_obs) | np.isnan(hum_obs)] = np.nan
    hum_int = pd.array(hum_obs.round(), dtype="Float64").astype("Int64")
    batt_int = pd.array(batt_obs.round(), dtype="Float64").astype("Int64")

    # Forecast feed: what the next 6 hours will bring, built from the true future weather
    # plus forecast error (it can over-call, under-call, or miss an event). Last 6 rows: unknown.
    fut_rain = (pd.Series(rain)[::-1].rolling(FORECAST_HORIZON_H, min_periods=FORECAST_HORIZON_H)
                .sum()[::-1].shift(-1).to_numpy())
    fut_wind = (pd.Series(wind)[::-1].rolling(FORECAST_HORIZON_H, min_periods=FORECAST_HORIZON_H)
                .max()[::-1].shift(-1).to_numpy())
    fc_rain = np.clip(fut_rain * np.exp(fc_rain_err) + fc_rain_add, 0, None)
    fc_rain = np.where(u_fmiss < FORECAST_MISS_P, fc_rain * 0.2, fc_rain)
    fc_wind = np.clip(fut_wind + fc_wind_err, 0, None)
    fc_rain = np.where(u_fx[0] < WEATHER_DROP_P, np.nan, fc_rain)
    fc_wind = np.where(u_fx[1] < WEATHER_DROP_P, np.nan, fc_wind)

    # Derived columns come from the observed readings, so they are blank when an input is missing
    room_obs = temp_obs + INDOOR_OFFSET_C
    backup_left = batt_obs / 100 * backup_h                      # hours of backup runtime left
    ratio = np.clip((room_obs - FRIDGE_SAFE_MAX_C) / np.maximum(room_obs - sensor, 1e-9), 1e-9, 1.0)
    holdover = np.minimum(-fridge_tau * np.log(ratio), HOLDOVER_CAP_H)   # Newton's cooling
    seen_breach = sensor >= FRIDGE_SAFE_MAX_C
    holdover = np.where(seen_breach, 0.0, holdover)
    until_unusable = np.where(seen_breach, 0.0, backup_left + holdover)
    breach_true = fridge_true >= FRIDGE_SAFE_MAX_C               # ground truth, never missing

    # ---------- outage memory features and the forecast label ----------
    s = pd.Series(started)
    outages_24h = s.rolling(24, min_periods=1).sum().to_numpy()
    outages_7d = s.rolling(168, min_periods=1).sum().to_numpy()
    rain_3h = pd.Series(rain_obs).rolling(3, min_periods=1).sum().to_numpy()
    # label at hour t = 1 if any outage STARTS during hours t+1 .. t+6 (last 6 rows: unknown)
    future = (s[::-1].rolling(LABEL_HORIZON_H, min_periods=LABEL_HORIZON_H).max()[::-1]
              .shift(-1).to_numpy())
    label = pd.array(future, dtype="Float64").astype("Int64")

    # hours into the current outage (1 in the first hour, 0 when the grid is on)
    run_id = np.cumsum(np.concatenate(([1], (outage[1:] != outage[:-1]).astype(int))))
    outage_hours = pd.Series(outage).groupby(run_id).cumsum().to_numpy()
    # fridge reading one hour ago and the change since then (past only, so safe to use as features)
    fridge_obs = pd.Series(sensor)
    fridge_lag1 = fridge_obs.shift(1)
    fridge_delta = fridge_obs - fridge_lag1
    # ready-made label: does the true fridge temperature reach 8 C in any of the next 6 hours?
    brk = pd.Series(breach_true.astype(float))
    breach_next6 = pd.array((brk[::-1].rolling(LABEL_HORIZON_H, min_periods=LABEL_HORIZON_H).max()[::-1]
                             .shift(-1)).to_numpy(), dtype="Float64").astype("Int64")
    # the same label, but only for hours that look fine right now (power on, fridge not yet above 8 C):
    # these are the genuinely NEW problems, not "a problem exists now, so it persists"
    fine_now = (outage == 0) & (~breach_true)
    breach_next6_new = pd.Series(breach_next6).where(pd.Series(fine_now)).astype("Int64").to_numpy()

    # ---------- SMS follow-up: only clinics with a backup get a text ----------
    has_backup = int(backup_h > 0)
    out_hold = holdover[outage == 0]
    typical_hold = float(np.nanmedian(out_hold)) if np.isfinite(out_hold).any() else 0.0
    hold_f = pd.Series(holdover).ffill(limit=12).fillna(typical_hold).to_numpy()     # fridge-alone hours to 8 C, gaps filled
    backup_left_f = pd.Series(backup_left).ffill(limit=12).fillna(0.0).to_numpy()
    rs = np.random.default_rng([SEED, 5000 + clinic_id])                             # own stream: nothing else reshuffles
    sms_state = np.where(outage == 1, "critical_unconfirmed" if has_backup else "critical_no_sms", "normal").astype(object)
    follow_up = np.full(n_hours, "", dtype=object)
    if has_backup:
        for k, (t0, t1) in enumerate(events):
            send_min = rs.uniform(*SMS_LATENCY_MIN)
            answers = rs.random() < SMS_REPLY_P
            delay = float(np.clip(np.exp(rs.normal(np.log(SMS_REPLY_MEDIAN_MIN), SMS_REPLY_SIGMA)), *SMS_REPLY_CLIP_MIN))
            flip = rs.random()
            hours_left = round(float(hold_f[t0]) * 2) / 2                       # holdover model, to the nearest half hour
            alert = (f"CLINIC {clinic_id:02d}: power is OFF. Your fridge stays cold for about {hours_left:g} h. "
                     f"Is your backup power working? Reply 1 = YES, 2 = NO")
            row = {"alert_id": f"A{clinic_id:02d}-{k + 1:03d}", "clinic_id": clinic_id, "outage_start": times[t0],
                   "sent_at": times[t0] + pd.Timedelta(minutes=round(send_min, 1)), "hours_left_in_message": hours_left,
                   "message_text": alert, "reply": "", "reply_at": pd.NaT, "reply_delay_min": np.nan,
                   "backup_actually_working": np.nan, "reply_correct": np.nan, "reply_after_power_back": np.nan,
                   "confirmation_text": ""}
            if answers:
                total_min = send_min + delay
                tr = t0 + int(total_min // 60)
                late = tr >= t1                                              # power came back before the worker replied
                t_eff = min(tr, t1 - 1)
                working = bool(source[t_eff] == "battery")                   # true state: is the backup running right now?
                tapped_yes = working if flip > SMS_WRONG_TAP_P else (not working)
                row.update({"reply": "YES" if tapped_yes else "NO",
                            "reply_at": times[t0] + pd.Timedelta(minutes=round(total_min, 1)),
                            "reply_delay_min": round(delay, 1), "backup_actually_working": int(working),
                            "reply_correct": int(tapped_yes == working), "reply_after_power_back": int(late)})
                if tapped_yes:
                    left = round(float(hold_f[t_eff] + backup_left_f[t_eff]) * 2) / 2
                    row["confirmation_text"] = f"Thank you. With your backup you have about {left:g} h. Keep the fridge door shut."
                else:
                    left = round(float(hold_f[t_eff]) * 2) / 2
                    row["confirmation_text"] = f"Thank you. Help is being arranged. About {left:g} h left. Keep the fridge door shut."
                if not late:
                    sms_state[tr:t1] = "backup_in_use" if tapped_yes else "needs_help"
                    follow_up[tr:t1] = row["reply"]
            sms_rows.append(row)

    # a clinic that said "backup working" goes back to urgent once its battery is used up (battery gauge reads empty)
    sms_state[(sms_state == "backup_in_use") & (backup_left_f <= 0.05)] = "backup_exhausted"

    # roads are slower in real rain, so travel time uses the true rain
    travel_time = distance_km / np.where(rain > 0, SPEED_RAIN_KMH, SPEED_DRY_KMH)

    rows.append(pd.DataFrame({
        "timestamp": times,
        "clinic_id": clinic_id,
        "feeder_id": feeder,
        "hour": hour_of_day,
        "day_of_week": day_of_week,
        "month": month_of_year,
        "is_evening": is_evening,
        "temperature_c": temp_obs.round(1),
        "humidity_pct": hum_int,
        "rain_mm": rain_obs.round(1),
        "wind_kmh": wind_obs.round(1),
        "weather_condition": weather_condition,
        "forecast_rain_next_6h_mm": fc_rain.round(1),
        "forecast_max_wind_next_6h_kmh": fc_wind.round(1),
        "outage": outage,
        "outage_started": started,
        "hours_since_last_outage": since_back.astype(int),
        "outages_last_24h": outages_24h.astype(int),
        "outages_last_7d": outages_7d.astype(int),
        "rain_last_3h": rain_3h.round(1),
        "distance_from_hub_km": round(distance_km, 1),
        "travel_time_h": travel_time.round(2),
        "power_source": source_obs,
        "battery_pct": batt_int,
        "backup_runtime_left_h": backup_left.round(2),
        "fridge_temp_c": sensor.round(2),
        "holdover_h": holdover.round(2),
        "hours_until_unusable": until_unusable.round(2),
        "cold_chain_breach": breach_true.astype(int),
        "true_fridge_temp_c": fridge_true.round(2),     # hidden truth for checking estimators; never a model input
        "outage_starts_next_6h": label,
        "local_fault": local_fault,
        "feeder_online": feeder_online,
        "outage_hours": outage_hours,
        "fridge_temp_lag1_c": fridge_lag1.round(2),
        "fridge_temp_delta_c": fridge_delta.round(2),
        "breach_next_6h": breach_next6,
        "breach_next_6h_new": breach_next6_new,
        "has_backup": has_backup,
        "sms_state": sms_state,
        "follow_up_reply": follow_up,
        "holdover_filled_h": hold_f.round(2),
        "backup_left_filled_h": backup_left_f.round(2),
        "_dist": round(distance_km, 1),
    }))

    # ---------- event log: when power was cut, when it came back, and why ----------
    for start, end in events:
        peak = fridge_true[start:min(end + 2, n_hours)].max()      # true peak, not the noisy reading
        event_rows.append({
            "clinic_id": clinic_id,
            "feeder_id": feeder,
            "outage_start": times[start],
            "power_back": times[0] + pd.Timedelta(hours=int(end)),
            "duration_h": int(end - start),
            "cause": "feeder" if feeder_out[feeder][start] else "local",
            "backup_runtime_full_h": backup_h,
            "peak_fridge_temp_c": round(float(peak), 2),
            "medicine_unusable": int(peak >= FRIDGE_SAFE_MAX_C),
        })

    clinic_rows.append({
        "clinic_id": clinic_id,
        "feeder_id": feeder,
        "distance_from_hub_km": round(distance_km, 1),
        "backup_runtime_full_h": backup_h,
        "has_backup": has_backup,
        "fridge_setpoint_c": round(setpoint, 2),
        "true_fridge_tau_h": round(fridge_tau, 1),      # hidden truth: a real system must fit this
        "true_grid_weakness": round(grid_weakness, 2),  # hidden truth: never use as a feature
        "true_feeder_weakness": round(feeder_weakness[feeder], 2),  # hidden truth: same
    })

df = pd.concat(rows, ignore_index=True).drop(columns="_dist")
# ---------- priority ranking, recomputed every hour across all clinics ----------
# slack = hours until the fridge reaches 8 C, minus the trip from the hub (distance and weather): how much margin
# is left if help is sent now. Smaller slack = more urgent. Before a follow-up, only the fridge-alone holdover counts.
# After a YES (backup working and in use) the backup hours are added and the clinic moves to a lower tier.
tier_now = np.select([df["sms_state"] == "normal", df["sms_state"] == "backup_in_use"], [2, 1], default=0)
tier_base = np.where(df["sms_state"] == "normal", 2, 0)
hours_now = df["holdover_filled_h"] + np.where(df["sms_state"] == "backup_in_use", df["backup_left_filled_h"], 0.0)
df["hours_to_8c_priority"] = hours_now.round(2)
df["priority_slack_h"] = (hours_now - df["travel_time_h"]).round(2)
tie = df["distance_from_hub_km"] * 1e-4                      # equal slack: the farther clinic goes first
key_now = tier_now * 1000 + df["priority_slack_h"] - tie
key_base = tier_base * 1000 + (df["holdover_filled_h"] - df["travel_time_h"]) - tie
df["priority_rank"] = key_now.groupby(df["timestamp"]).rank(method="first").astype(int)
df["priority_rank_before_followup"] = key_base.groupby(df["timestamp"]).rank(method="first").astype(int)
events_df = pd.DataFrame(event_rows)
clinics_df = pd.DataFrame(clinic_rows)

sms_df = pd.DataFrame(sms_rows)
sms_df.to_csv("sms_log.csv", index=False)
df.to_csv("synthetic_clinic_data.csv", index=False)
events_df.to_csv("outage_events.csv", index=False)
clinics_df.to_csv("clinics.csv", index=False)

# ---------------- Sanity check: does the output look plausible? ----------------
print(f"Saved {len(df)} hourly rows ({N_CLINICS} clinics x {n_hours} hours) to synthetic_clinic_data.csv")
print(f"Saved {len(events_df)} outage events to outage_events.csv, {len(clinics_df)} clinics to clinics.csv\n")

print(f"Share of clinic-hours without grid power: {df['outage'].mean() * 100:.2f}%  "
      f"({df['outage'].mean() * 24:.2f} outage hours per day on average)")
raining_now = df["rain_mm"] > 0
print(f"Outage share while raining:      {df.loc[raining_now, 'outage'].mean():.3f}")
print(f"Outage share while not raining:  {df.loc[~raining_now, 'outage'].mean():.3f}")
evening = df["is_evening"] == 1
print(f"Outage share in evening (18-22): {df.loc[evening, 'outage'].mean():.3f}")
print(f"Outage share other hours:        {df.loc[~evening, 'outage'].mean():.3f}")

print(f"\nOutage events by cause: {events_df['cause'].value_counts().to_dict()}")
n_out_same_feeder = df.groupby(["feeder_id", "timestamp"])["outage"].transform("sum")
print(f"Outage hours when another clinic on the same feeder is also out: "
      f"{(n_out_same_feeder[df['outage'] == 1] >= 2).mean():.1%}")
print(f"Median outage length: {events_df['duration_h'].median():.1f} h, "
      f"outages longer than 5 h: {(events_df['duration_h'] > 5).mean():.1%}")
print(f"Outages that made medicine unusable: {events_df['medicine_unusable'].sum()} of {len(events_df)}")

lab = df["outage_starts_next_6h"]
pos = (lab == 1).fillna(False).astype(bool)
neg = (lab == 0).fillna(False).astype(bool)
print(f"\n'Outage starts in next 6h' = 1 for {lab.dropna().mean():.1%} of hours")
print(f"Avg forecast rain next 6h (mm): hours before an outage {df.loc[pos, 'forecast_rain_next_6h_mm'].mean():.1f}"
      f"  vs other hours {df.loc[neg, 'forecast_rain_next_6h_mm'].mean():.1f}")
print(f"Avg forecast max wind next 6h (km/h): hours before an outage "
      f"{df.loc[pos, 'forecast_max_wind_next_6h_kmh'].mean():.1f}"
      f"  vs other hours {df.loc[neg, 'forecast_max_wind_next_6h_kmh'].mean():.1f}")

summary = clinics_df.set_index("clinic_id")[["feeder_id", "distance_from_hub_km", "backup_runtime_full_h",
                                             "true_fridge_tau_h"]].copy()
summary["outage_events"] = events_df.groupby("clinic_id").size()
summary["outage_h_per_day"] = df.groupby("clinic_id")["outage"].mean() * 24
summary["breach_hours"] = df.groupby("clinic_id")["cold_chain_breach"].sum()
summary["bad_outages"] = events_df.groupby("clinic_id")["medicine_unusable"].sum()
print("\nPer clinic:")
print(summary.fillna(0).round(2).to_string())

missing = (df.isna().mean() * 100).round(2)
print("\nMissing values (% of rows):")
print(missing[missing > 0].to_string())

print(f"\nBACKUP: {int(clinics_df['has_backup'].sum())} of {N_CLINICS} clinics have a backup "
      f"(runtime hours: {clinics_df.loc[clinics_df['has_backup'] == 1, 'backup_runtime_full_h'].tolist()})")
print(f"SMS: {len(sms_df)} alerts sent to backup clinics; replied {(sms_df['reply'] != '').mean():.0%}; "
      f"YES {(sms_df['reply'] == 'YES').sum()}, NO {(sms_df['reply'] == 'NO').sum()}; "
      f"median reply {sms_df['reply_delay_min'].median():.0f} min; "
      f"replies that matched the real backup state {sms_df['reply_correct'].mean():.1%}; "
      f"arrived after power was back {sms_df['reply_after_power_back'].mean():.1%}")
print("Example alert :", sms_df['message_text'].iloc[0])
ex = sms_df[sms_df['confirmation_text'] != ''].iloc[0]
print("Example reply :", ex['reply'], "->", ex['confirmation_text'])
print("sms_state hours:", df['sms_state'].value_counts().to_dict())
moved = df[df['sms_state'] == 'backup_in_use']
print(f"Clinics that confirmed a working backup: average rank {moved['priority_rank_before_followup'].mean():.1f} before the reply, "
      f"{moved['priority_rank'].mean():.1f} after (higher number = lower priority)")
