# Operating the cold-chain prototype

**Scope:** a local engineering demonstration, not a certified safety system.
Keep independent calibrated thermometers, local hardware alarms and approved
product-specific procedures. Software cannot perform clinical/regulatory
validation or replace those safeguards.

## Startup and private configuration

1. Install dependencies and explicitly train the synthetic model as in README.
2. Use default `demo` auth only on `127.0.0.1`, on a trusted workstation.
3. For authenticated mode, create an ignored `.env` based on `.env.example`.
   Set `COLDCHAIN_AUTH_MODE=required`, a non-demo bootstrap username, a unique
   password (12+ characters) and a cryptographically random signing secret
   (32+ characters). Configure secrets in your own terminal/secret manager.
4. Start one server process:

   ```powershell
   .venv\Scripts\python.exe -m uvicorn backend.main:app --env-file .env --host 127.0.0.1 --port 8000
   ```

5. Log in using the website form. Tokens stay in browser memory and expire.
   Page reload requires login again in required mode. Sign-out clears browser
   data; it does not revoke a copied bearer token before its expiry. Disabling
   an account in the database invalidates access on subsequent requests.

Never expose demo mode. Required mode is necessary but not sufficient for an
internet deployment: use TLS, secret management, device authentication, SSO/MFA,
network controls and security review. Role permissions are global, **not scoped
to assigned clinics**. Do not deploy to independent tenants without that work.

## Role permissions

| Role | Reads | Writes |
|---|---|---|
| clinic_operator | State, model, alerts, monitoring, weather, events, policy | Clinic telemetry/scenarios, time/reset, acknowledgement, outcomes |
| grid_operator | Same operational reads | Feeder telemetry/scenarios, time/reset, acknowledgement |
| admin | All, including audit | All operational writes |
| auditor | All, including audit | None |

An existing user's password/role is not reset on restart. This prototype has no
account-management API. Use the local administrative CLI for explicit user
provisioning/disable operations; keep that terminal and database private:

```powershell
.venv\Scripts\python.exe -m backend.manage_users create alice --role clinic_operator
.venv\Scripts\python.exe -m backend.manage_users disable alice
```

The CLI asks for passwords with hidden terminal input (never command arguments).
Load the same environment/DB path as the server; the CLI accepts `--env-file .env`
before the subcommand. Bootstrap accounts use `COLDCHAIN_DEMO_*` variables for
legacy compatibility, even in required-auth mode.

## API overview

Operational requests require `Authorization: Bearer <session-token>` in required
mode. The token comes from `POST /api/auth/login`, JSON `{username,password}`.
Do not save tokens in source files or include them in request logs.

| Endpoint | Purpose |
|---|---|
| GET /api/auth/config, /api/health | Public access-mode/liveness information |
| POST /api/auth/login; GET /api/auth/me | Login and current DB-checked role |
| GET /api/state; POST /api/simulate | Live state and simulation actions |
| GET /api/model | Synthetic held-out metrics, not live validation |
| POST /api/telemetry/clinic | Accept one sensor observation |
| POST /api/telemetry/feeder | Accept one shared-feeder observation |
| GET /api/alerts | Bounded incident history |
| POST /api/alerts/{id}/acknowledge | Record responsibility, not recovery |
| GET /api/weather | Configured contextual weather/fallback |
| GET /api/monitoring | Counts, outcomes, quality and drift proxy |
| POST /api/monitoring/feedback | One confirmed outcome per prediction ID |
| GET /api/audit; GET /api/events | Audit/event records, bounded to 500 |
| GET /api/policy | Explicit safeguards and limitations |

### External telemetry

Example clinic payload, with `observed_at` omitted to use server receipt time:

```json
{"clinic_id":"CL-03","temperature_c":4.4,"humidity_pct":65,"power_on":true,"local_fault":false,"outage_hours":0,"source":"clinic-gateway"}
```

Example feeder payload:

```json
{"feeder_id":3,"online":false,"outage_hours":1,"source":"feeder-gateway"}
```

For real devices, always send `observed_at` as timezone-aware ISO 8601, e.g.
`2026-10-11T10:00:00Z` (replace with the actual observation time). Timestamps more
than 60 seconds in the future or without a timezone fail validation; duplicate
or out-of-order timestamps return 409. Rejecting a replay does not advance the
stored observation. IDs and finite temperature/humidity bounds are validated.

The **first external observation switches the entire runtime to external mode**.
Unobserved clinics/feeders become missing/Unknown. Feeder-off observations affect
all linked clinics, but never manufacture fresh temperature samples. Simulation
mutations then return 409, except an explicit Reset. Reset discards active
external state in favor of a clearly labelled synthetic scenario; history stays.
Do not use Reset during actual operational monitoring.

Observation timestamps and wall-clock receipt times are separate from the
synthetic 2025 simulation clock. By default a reading older than 900 seconds is
stale. Polling does not make it fresh. No new prediction is recorded for a stale
clinic. Missing/stale information is not proof of recovery or safety.

### Weather

Set `COLDCHAIN_WEATHER_PROVIDER=open-meteo` and the correct latitude/longitude.
The first weather request calls the fixed HTTPS provider; startup stays offline.
Requests time out after three seconds by default. A successful response is cached
for 300 seconds. Provider failure serves a marked stale cached response, or
synthetic fallback if no cache exists. No fallback is presented as live weather.

The weather card is for configured site context, not 20 independently geolocated
forecasts, and not a validated live ML input. Review provider licensing, location
privacy, and service guarantees before deploying.

## Incident runbook (review and adapt with qualified personnel)

- **Temperature excursion:** below 2°C or above 8°C raises an immediate rule
  alarm independently of AI. Verify with a calibrated independent device; follow
  the product's approved excursion/quarantine SOP and contact the responsible
  pharmacist/quality team. Never automatically release stock based on a green
  card or automatically discard it based solely on the model.
- **Feeder outage:** verify physical power/backup status, communicate with grid
  operations, minimize unnecessary refrigerator opening and follow approved
  contingency transport/storage plans. Do not treat the prototype's risk score
  as a validated "remaining safe hours" estimate.
- **Stale sensor/network failure:** status is Unknown; inspect the local device
  and connectivity, obtain manual measurements, and follow the downtime SOP.
  No web application can replace an independently powered local alarm.
- **Model unavailable:** deterministic rules remain; probabilities are absent,
  not zero. Investigate model artifact/version issues outside active handling.
  Load only trusted local joblib files; joblib is not a safe untrusted format.
- **Weather unavailable:** inspect fallback/stale labels. Weather failure must
  not disable temperature rules.
- **Application/database unavailable:** switch to manual logs and independent
  alarms, contact the on-call engineer, preserve incident records, and restore
  from a tested consistent backup. Never infer safety from an unreachable API.

### Alert escalation

The in-app worker checks every five wall-clock seconds. Active incidents create
one initial demo-log outbox entry and escalate at 300 and 600 seconds. Set
`COLDCHAIN_ALERT_ESCALATION_SECONDS` locally for a faster presentation. Advancing
the simulated clock does not fast-forward real escalation. Acknowledgement does
not stop escalation; fresh recovery resolves the incident. A recurrence creates
a new incident ID. Stale/missing readings cannot clear a prior thermal incident.

**No real messages are sent.** Outbox events say `logged_demo` and `sent:false`.
A production service requires a durable external worker, delivery receipts,
retries/backoff, deduplication, verified contacts, escalation ownership and
validated failure drills. The app's worker stops when the app stops.

### History, audit and backups

Default private database: `backend/data/coldchain.db` (ignored by Git). Override
with `COLDCHAIN_DB_PATH`. SQLite WAL is enabled. Use SQLite's backup API or stop
the app cleanly before copying; copying a live `.db` alone may omit WAL records.
Back up the model/version/configuration too, with secrets stored separately.

Schema creation and additive migrations happen at startup. Back up a prior
database before upgrading. Audit is append-only through application endpoints,
not tamper-proof against filesystem/database administrators. Retention is not
automatically enforced; establish a reviewed retention/backup policy. Requests
are serialized within one server process, but snapshot/history writes are
separate transactions: this is not a crash-atomic event pipeline.

### Monitoring and outcomes

`/api/monitoring` exposes recent prediction IDs. Submit confirmed six-hour
outcomes using `{prediction_id,actual_outcome,notes}`. A repeated identical
outcome is idempotent; a conflicting outcome is rejected. Record the evidence
and observation window; the prototype does not automatically verify labels or
wait for six hours before allowing entry. Do not treat demonstration labels as
real clinical outcomes.

Live outcome metrics treat **Critical** as the positive alarm class; this differs
from the synthetic test classifier's F2-selected warning threshold. Brier score
uses only paired calibrated-model probabilities; rules-only records have no
probability. No labels means unavailable metrics, not perfect accuracy.

The risk-shift display compares first 200 with latest 1,000 recorded predictions;
windows can overlap and operator scenarios can dominate it. It is a descriptive
proxy, not a validated feature-drift alarm. Model versioning, observation cohort
selection, independent evaluation, drift thresholds and retraining approval are
required before real monitoring decisions.
