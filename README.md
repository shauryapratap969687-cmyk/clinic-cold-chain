# ColdChain / Control Room

A self-contained FastAPI + XGBoost operational prototype with a responsive
dashboard, durable SQLite history, authenticated roles, telemetry ingestion,
rules-based safety indicators, and a simulation sandbox.

> **Safety:** this project uses synthetic data and a deliberately simplified
> spoilage proxy. It is not medical advice, a validated clinical model, or a
> substitute for a regulated cold-chain monitoring system.

## What is included

- 20 clinics connected to six shared feeders (three or four clinics per feeder).
- Reproducible 180–365 day hourly data generation.
- Shared feeder failures, independent local faults, temperature dynamics, and
  rare freezing events.
- An XGBoost classifier with class weighting, chronological train/calibration/
  validation/test splits, six-hour purges, and sigmoid probability calibration.
- Test-set PR-AUC, F2, Brier score, ROC-AUC, calibration bins, ROC points,
  confusion matrix, and feature importance.
- A live dashboard with feeder trip/restore, local fault, freezing, reset, and
  manual time-advance controls.
- Larger 17–18px text, colorful status cards, smooth transitions, 48px controls,
  keyboard focus, mobile layouts, and reduced-motion support.
- Required-auth mode with password hashing, expiring bearer sessions, current
  database role checks and login throttling. **Default demo mode bypasses auth.**
- SQLite events, observations, predictions, outcomes, incidents, audit records,
  and a restartable simulation snapshot including its random-generator state.
- Validated telemetry HTTP ingestion, stale/missing-data indicators, an optional
  cached Open-Meteo weather adapter, and a rules-only fallback.
- Alert acknowledgement, recurrence, recovery and timed escalation to a
  durable **demo-log outbox**. No real SMS/email/webhook delivery is configured.
- A dashboard temperature safeguard that polls live state every three seconds,
  marks fresh readings above the configurable 6°C early-warning threshold,
  records durable alerts, and can play an operator-enabled browser double-beep.
  The browser alarm is not a hardware alarm.
- Monitoring and operator-confirmed outcomes, with no fabricated live accuracy.

## Run locally

From this directory in PowerShell:

```powershell
uv venv .venv --python 3.11
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.venv\Scripts\python.exe -m backend.train --days 240 --seed 42
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

The training step is explicit. If artifacts are missing, corrupted, or fail
inference, the API starts in **rules-only mode** instead of blocking safety
indicators on model training. No probability is invented: it is `null` and the
dashboard shows "Unavailable / rules only". Existing model artifacts still work.

Use one application process per database. Do not use `--workers` with this
in-process simulation. `--reload` is optional during development; restarts restore
the last saved snapshot. OpenAPI documentation is at `/docs`.

## Demo flow

1. Note the six feeders and 20 powered clinics in the overview.
2. Select **Feeder 3** and choose **Trip feeder**. All clinics on that feeder
   should immediately go offline together.
3. Advance six simulated hours to show the outage-driven temperature/risk
   response.
4. Restore the feeder, then try a **Local fault** or **Freeze clinic** to show
   that a single-clinic event does not take down its neighbors.
5. Use the model-insights cards to explain the calibrated probabilities and
   the synthetic test-set metrics.
6. Open **Operations**, acknowledge an alert, and inspect **Audit trail**.
   Acknowledgement records ownership, not recovery; the alert resolves only on
   fresh evidence of recovery. Reset explicitly returns to synthetic state.
7. Restart the server to verify snapshot/history persistence. A long idle gap
   intentionally becomes **Unknown**, not green. Advance/reset to generate fresh
   demo observations. In external mode, send fresh telemetry instead.

## Temperature alarm behavior

The dashboard's thermal safeguard is intentionally separate from the model
forecast. It uses fresh clinic readings and deterministic policy thresholds:

| Condition | Dashboard state | Alarm level |
|---|---|---|
| Fresh temperature above `COLDCHAIN_HIGH_TEMP_ALARM_C` (default `6°C`) | Warning | Warning |
| Fresh temperature above `8°C` or below `2°C` | Critical | Critical |
| Fresh feeder/clinic outage | Warning | Operational warning |
| Missing or stale temperature/power data | Unknown | No fresh temperature alarm |

The system-health card derives its current posture from fresh clinic and feeder
conditions, so a shared feeder trip can move the system from **Healthy** to
**Warning**, and sustained warming can move it to **Critical**. A fresh
temperature crossing creates a durable alert and is shown in the temperature
alarm panel.

Sound is opt-in because browsers require a user gesture for Web Audio. Click
**Enable alarm sound** once in the dashboard to hear a confirmation double-beep;
newly detected threshold crossings then play the same double-beep. Visual alarm
state remains authoritative if audio is unavailable or muted. These readings are
synthetic/API demo data and are not an independent refrigerator alarm.

To change the early-warning threshold locally, set the ignored `.env` value:

```text
COLDCHAIN_HIGH_TEMP_ALARM_C=6.0
```

After changing the value, restart the application. The critical bounds remain
the explicit demo policy limits of below `2°C` or above `8°C`.

## SIMULATED physics-based thermal forecast

The prototype includes a separate thermal forecast alongside the existing XGBoost risk prediction. `backend/thermal.py` uses Newton's law of cooling for ambient heat exchange and a bounded refrigerator compressor term for powered operation. Synthetic trajectories include insulation variation, door openings, feeder/power outages, local cooling failures, freeze events and reproducible residual noise.

- The next six hours are simulated from current temperature, ambient trajectory, power state, cooling-failure state, door load and insulation.
- The dashboard shows the simulated measured temperature, six-hour forecast, uncertainty band, exact 1/2/6-hour power-cut horizons, and a time-to-limit value only when the mean trajectory crosses a configured limit.
- Missing/stale or external-mode inputs are marked unreliable and do not show a countdown. Displayed forecast values are labelled `SIMULATED`.
- The XGBoost target and feature list remain separate from this physics forecast.
- `/api/model` reports held-out synthetic validation metrics: MAE, RMSE, threshold-crossing-time error and failure-scenario error. These are not real refrigerator or vaccine-accuracy claims.

The live simulation seed and forecast horizon can be configured with `COLDCHAIN_SIMULATION_SEED` and `COLDCHAIN_THERMAL_FORECAST_HORIZON_HOURS`.

## API

The API is served by the same FastAPI process as the frontend. In `demo` mode,
operational requests can be used from the local browser without a token. In
`required` mode, send `Authorization: Bearer <access_token>` on all protected
requests. Interactive OpenAPI documentation is available at `/docs`.

### Public endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Dashboard HTML |
| `GET` | `/api/health` | Liveness, model, persistence and stale-sensor status |
| `GET` | `/api/auth/config` | Auth mode and supported roles; does not expose secrets |
| `POST` | `/api/auth/login` | Required-mode login with username/password |

### Protected read endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/me` | Current authenticated user and DB-checked role |
| `GET` | `/api/state` | Current feeders, clinics, telemetry and risk state |
| `GET` | `/api/model` | Held-out synthetic metrics and charts |
| `GET` | `/api/alerts` | Active/recovered incidents and escalation metadata |
| `GET` | `/api/weather` | Context weather, provider/fallback/cache status |
| `GET` | `/api/monitoring` | Data quality, prediction history, outcomes and drift proxy |
| `GET` | `/api/events` | Bounded operational event history |
| `GET` | `/api/policy` | Safeguards, roles, retention and validation limits |
| `GET` | `/api/audit` | Append-only audit records; admin/auditor only |

### Protected write endpoints

| Method | Path | Allowed roles | Purpose |
|---|---|---|---|
| `POST` | `/api/simulate` | Operator/admin | Run synthetic feeder, clinic, freeze, reset or time actions |
| `POST` | `/api/telemetry/clinic` | Clinic/admin | Ingest a validated clinic observation |
| `POST` | `/api/telemetry/feeder` | Grid/admin | Ingest a validated shared-feeder observation |
| `POST` | `/api/alerts/{id}/acknowledge` | Operator/admin | Record alert ownership; does not resolve the incident |
| `POST` | `/api/monitoring/feedback` | Clinic/admin | Record one human-confirmed outcome per prediction |

Simulation request example:

Example telemetry request:

```json
{
  "clinic_id": "CL-03",
  "temperature_c": 4.4,
  "humidity_pct": 65,
  "power_on": true,
  "local_fault": false,
  "outage_hours": 0,
  "source": "clinic-gateway"
}
```

Telemetry timestamps must be timezone-aware ISO 8601 values when supplied. The
server rejects future timestamps, duplicate/out-of-order observations, invalid
clinic/feeder IDs and non-finite values. Stale or missing telemetry becomes
**Unknown**, never healthy. The first external observation switches the runtime
to external mode; simulation mutations are then blocked until an explicit Reset.

### Important response fields

Each clinic in `/api/state` contains:

```json
{
  "id": "CL-03",
  "feeder_id": 3,
  "power_on": true,
  "temperature_c": 4.4,
  "too_cold": false,
  "risk_probability": 0.12,
  "risk_level": "Warning",
  "risk_source": "calibrated_model",
  "data_quality": "ok",
  "source": "simulation"
}
```

`risk_probability` is `null` when telemetry is missing/stale or the system is
using deterministic rules. The frontend displays this as
**Unavailable / rules only** instead of presenting a fake zero-percent risk.
Observed temperatures below 2°C or above 8°C are escalated independently of
the AI model. These thresholds are a demo policy, not universal product rules.

### cURL examples

```powershell
# Demo mode: no Authorization header is needed on loopback
curl http://127.0.0.1:8000/api/state

# Trip the shared feeder and inspect all affected clinics
curl -X POST http://127.0.0.1:8000/api/simulate `
  -H "Content-Type: application/json" `
  -d '{"action":"trip_feeder","feeder_id":3}'

# Required mode: log in, then use the returned access_token
curl -X POST http://127.0.0.1:8000/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{"username":"YOUR_USER","password":"YOUR_PASSWORD"}'
```

Supported actions are `trip_feeder`, `restore_feeder`, `local_fault`,
`restore_clinic`, `freeze_clinic`, `advance` (with `hours` from 1–24), and
`reset`.

## Project layout

```text
backend/
  features.py       shared training/live feature engineering
  synthetic.py      power/temperature/weather data generator
  model.py          training, calibration, evaluation, artifacts
  simulation.py     thread-safe manually advanced live state
  main.py           FastAPI routes and static frontend hosting
  config.py         fail-closed authenticated configuration
  auth.py           password hashing, signed tokens and role checks
  storage.py        SQLite schema/migration and persistence
  alerts.py         deterministic alert lifecycle and escalation
  weather.py        optional provider adapter and cache/fallback
  manage_users.py   local account creation/disable CLI with hidden password input
frontend/
  index.html        accessible dashboard structure
  styles.css        responsive control-room visual system
  app.js            API integration, controls, and canvas charts
tests/
  test_backend.py   generator/model/simulation regression coverage
  test_operations.py auth, persistence, telemetry and fail-safe coverage
docs/
  OPERATIONS.md     secure setup, interfaces and outage runbook
  VALIDATION.md     uncompleted clinical/deployment acceptance gates
```

## Authentication and configuration

By default the loopback demo enters as an admin without authentication. Its
banner explicitly says **Local demo · auth bypassed**. Do not expose it to a
network. Optional demo sign-in uses `demo-operator` / `demo-password-change-me`;
these are public demonstration values, not secure credentials.

For real authentication, copy `.env.example` to an ignored `.env` locally and
set `COLDCHAIN_AUTH_MODE=required`, an explicit non-demo
`COLDCHAIN_DEMO_USERNAME`, a unique 12+ character `COLDCHAIN_DEMO_PASSWORD`, and
a random 32+ character `COLDCHAIN_SECRET_KEY`. Despite the legacy `DEMO_` names,
these configure the initial account for required mode. Missing/default values
fail startup. Run with `--env-file .env`. Never send these secrets in chat or
commit the `.env` or database.

Users are bootstrapped only when their username is absent. Changing environment
credentials does **not** reset an existing account. Account provisioning,
credential rotation, MFA/OIDC, TLS and backup policy remain deployment work.
See [operations guide](docs/OPERATIONS.md).

## What is real, and what still needs integration?

| Area | Implemented here | Not claimed |
|---|---|---|
| Feeder telemetry | Validated API ingestion, visible shared-feeder state | Physical device/SCADA connection or device identity provisioning |
| Authentication | Required-auth mode, hashed passwords, roles, token expiry | SSO/MFA, multi-tenant or assigned-clinic access isolation |
| Storage | SQLite durable history and runtime snapshot | Highly available/atomic distributed event pipeline |
| Weather | Configurable Open-Meteo adapter, cache, timeout/fallback | Provider availability/SLA or live-model validity |
| Escalation | In-app worker, acknowledgement/recovery/recurrence, demo outbox | Real SMS/email/calls or external delivery receipts |
| Audit | Append-only application API records | Tamper-proof storage against a database administrator |
| Monitoring | Outcome metrics, quality, counts, descriptive risk-shift proxy | Validated drift detector, automatic retraining or clinical performance |
| Validation | Explicit readiness status and review checklist | Regulatory approval, clinical validation or certification |
| Fail-safe | Stale/Unknown state, independent temperature rules | Independent local hardware alarm or offline edge controller |

The synthetic model is deliberately **not applied to external telemetry**.
External observations use deterministic rules until real-data validation exists.
Weather is context-only and is not silently inserted into the historical model.

## Simulated outage-forecast review

`backend/outage_analysis.py` adds a separate calibrated XGBoost outage-start review without changing the existing synthetic spoilage target. It uses separate tuning and evaluation worlds, a six-hour horizon, tuning-only threshold selection, and keeps new outages separate from already-ongoing outage persistence. All results are **SIMULATED** diagnostics.

Run the review with:

```powershell
.venv\Scripts\python.exe -m backend.outage_analysis --days 180 --tuning-seed 2025 --evaluation-seed 2026 --bootstrap-samples 500 --output reports\outage_review_final.json
```

These results are not real-world outage, refrigerator, vaccine or clinical performance claims.

## Checks

```powershell
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m compileall -q backend
node --check frontend/app.js
```

Optional DOM interaction tests (no Node build is needed to run the website):

```powershell
npm ci --ignore-scripts
npm test
```

These test login gating, role-gated controls, feeder actions, stale readings,
and uncertain-request recovery in a simulated DOM, not real-device rendering.

Tests use temporary databases and do not overwrite the running demo's history.
For fault procedures and external-ingestion examples, read
[OPERATIONS.md](docs/OPERATIONS.md). Before any pilot, review every unchecked gate
in [VALIDATION.md](docs/VALIDATION.md) with qualified personnel.

## Privacy, safety and public-repository guidance

- Do not commit `.env`, SQLite files, model artifacts, sensor payloads, tokens,
  real clinic data or logs. The repository ignores these paths; verify `git status`
  before every commit.
- The public demo password is intentionally documented and must never be reused.
- The default application is a local demonstration, not an internet-facing
  deployment. Use required auth, TLS, secret management, MFA/OIDC, scoped tenant
  permissions and security review before exposure.
- No external SMS/email/call is sent. Alert outbox records have `sent: false`.
- No clinical, regulatory, reliability or production-readiness claim is made.
  Read `docs/VALIDATION.md` for all outstanding gates.
