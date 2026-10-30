"""FastAPI application for the production-oriented cold-chain demo."""

from __future__ import annotations

import json
import asyncio
import logging
import time
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .alerts import sync_alerts
from .auth import ROLES, Principal, current_principal, hash_password, issue_token, require_roles, verify_password
from .codeflow import (
    AI_RATE_LIMIT_PER_MINUTE,
    EXECUTE_RATE_LIMIT_PER_MINUTE,
    MAX_OUTPUT_BYTES,
    MAX_SOURCE_CHARS,
    MAX_TRACE_EVENTS,
    TIMEOUT_SECONDS,
    ask_codeflow_ai,
    codeflow_config,
    execute_codeflow,
    verify_codeflow,
)
from .model import load_bundle
from .simulation import Simulation
from .storage import Storage, utc_now
from .thermal import thermal_forecast_validation
from .weather import get_weather


class SimulationRequest(BaseModel):
    action: str
    feeder_id: int | None = Field(default=None, ge=1, le=6, strict=True)
    clinic_id: str | None = None
    hours: int | None = Field(default=None, ge=1, le=24)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class FeederTelemetryRequest(BaseModel):
    model_config = {"allow_inf_nan": False}
    feeder_id: int = Field(ge=1, le=6, strict=True)
    online: bool
    outage_hours: float = Field(default=0, ge=0, le=10_000)
    observed_at: datetime | None = None
    source: str = Field(default="manual", min_length=1, max_length=64)


class ClinicTelemetryRequest(BaseModel):
    model_config = {"allow_inf_nan": False}
    clinic_id: str = Field(pattern=r"^CL-(0[1-9]|1[0-9]|20)$")
    temperature_c: float = Field(ge=-80, le=100)
    humidity_pct: float = Field(default=65, ge=0, le=100)
    power_on: bool = True
    local_fault: bool = False
    outage_hours: float = Field(default=0, ge=0, le=10_000)
    observed_at: datetime | None = None
    source: str = Field(default="manual", min_length=1, max_length=64)


class FeedbackRequest(BaseModel):
    prediction_id: int = Field(ge=1)
    actual_outcome: bool
    notes: str | None = Field(default=None, max_length=2000)


class SMSReplyRequest(BaseModel):
    clinic_id: str = Field(pattern=r"^CL-(0[1-9]|1[0-9]|20)$")
    reply: str = Field(min_length=1, max_length=16)


class CodeFlowRequest(BaseModel):
    """Bounded source request shared by execute, verify, and legacy run."""

    model_config = {"extra": "forbid", "allow_inf_nan": False}

    source: str = Field(min_length=1, max_length=MAX_SOURCE_CHARS, strict=True)
    language: str = Field(default="python", min_length=1, max_length=32, strict=True)
    timeout_seconds: float | None = Field(default=None, gt=0, le=TIMEOUT_SECONDS, strict=True)
    max_output_bytes: int | None = Field(default=None, ge=1, le=MAX_OUTPUT_BYTES, strict=True)
    max_trace_events: int | None = Field(default=None, ge=1, le=MAX_TRACE_EVENTS, strict=True)


class CodeFlowAIRequest(BaseModel):
    model_config = {"extra": "forbid", "allow_inf_nan": False}

    action: str = Field(default="ask", pattern=r"^(ask|explain|review|fix|fix_all)$", strict=True)
    question: str | None = Field(default=None, max_length=4000, strict=True)
    prompt: str | None = Field(default=None, max_length=4000, strict=True)
    source: str | None = Field(default=None, max_length=MAX_SOURCE_CHARS, strict=True)
    language: str = Field(default="python", min_length=1, max_length=32, strict=True)
    diagnostics: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    execution: dict[str, Any] | None = None


def _validate_request(request: SimulationRequest, simulation: Simulation) -> None:
    actions = {"trip_feeder", "restore_feeder", "local_fault", "restore_clinic", "freeze_clinic", "reset", "advance"}
    if request.action not in actions:
        raise HTTPException(status_code=422, detail=f"unknown action: {request.action}")
    feeder_actions = {"trip_feeder", "restore_feeder"}
    clinic_actions = {"local_fault", "restore_clinic", "freeze_clinic"}
    if request.action in feeder_actions:
        if request.feeder_id not in simulation.feeder_online:
            raise HTTPException(status_code=422, detail="feeder_id must be an integer from 1 to 6")
    elif request.action in clinic_actions:
        if request.clinic_id not in simulation.clinics:
            raise HTTPException(status_code=422, detail="clinic_id must be CL-01 through CL-20")
    elif request.feeder_id is not None or request.clinic_id is not None:
        raise HTTPException(status_code=422, detail="this action does not accept feeder_id or clinic_id")
    if request.action == "advance" and request.hours is None:
        request.hours = 1
    if request.action != "advance" and request.hours is not None:
        raise HTTPException(status_code=422, detail="hours is only valid for advance")


def _dump(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value.dict()


def _as_json_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for row in rows:
        for key in ("payload_json", "detail_json"):
            if key in row:
                try:
                    row[key[:-5]] = json.loads(row.pop(key))
                except (TypeError, json.JSONDecodeError):
                    pass
    return rows


def _alert_payload(alert: dict[str, Any]) -> dict[str, Any]:
    result = dict(alert)
    result["escalation_state"] = result.get("status", "open")
    return result


def create_app() -> FastAPI:
    config.validate()
    runtime_lock = RLock()
    login_lock = RLock()
    codeflow_rate_lock = RLock()
    login_attempts: OrderedDict[str, deque[float]] = OrderedDict()
    codeflow_attempts: OrderedDict[str, deque[float]] = OrderedDict()
    api_attempts: OrderedDict[str, deque[float]] = OrderedDict()
    dummy_hash = hash_password("unusable-login-timing-placeholder")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        ensure_runtime()
        stopping = asyncio.Event()

        async def worker() -> None:
            while not stopping.is_set():
                try:
                    await asyncio.wait_for(stopping.wait(), timeout=config.WORKER_INTERVAL_SECONDS)
                except asyncio.TimeoutError:
                    try:
                        await asyncio.to_thread(maintenance)
                    except Exception:
                        logging.getLogger(__name__).exception("Alert maintenance failed")

        task = asyncio.create_task(worker())
        try:
            yield
        finally:
            stopping.set()
            await task

    # Interactive API documentation is disabled in deployed builds so it cannot
    # expose an unauthenticated inventory of operational endpoints.
    app = FastAPI(title="Cold-chain operational prototype", version="2.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.simulation = None
    app.state.bundle = None
    app.state.storage = None
    app.state.initial_state_recorded = False

    @app.middleware("http")
    async def security_boundary(request: Request, call_next):
        # Render terminates TLS at its proxy; honor its normalized header only
        # when HTTPS enforcement is explicitly enabled for deployment.
        forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        if config.ENFORCE_HTTPS and forwarded_proto != "https":
            from fastapi.responses import RedirectResponse
            response = RedirectResponse(str(request.url).replace("http://", "https://", 1), status_code=308)
        else:
            if request.url.path.startswith("/api/"):
                key = request.client.host if request.client else "unknown"
                now = time.monotonic()
                with login_lock:
                    bucket = api_attempts.setdefault(key, deque(maxlen=config.API_RATE_LIMIT_PER_MINUTE))
                    api_attempts.move_to_end(key)
                    while bucket and bucket[0] <= now - 60:
                        bucket.popleft()
                    if len(bucket) >= config.API_RATE_LIMIT_PER_MINUTE:
                        return JSONResponse(status_code=429, content={"detail": "Too many requests; retry in one minute"}, headers={"Retry-After": "60"})
                    bucket.append(now)
                    while len(api_attempts) > 2048:
                        api_attempts.popitem(last=False)
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "frame-src 'none'; "
            "form-action 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "font-src 'self' data:; "
            "connect-src 'self'; "
            "worker-src 'self'; "
            "manifest-src 'self'; "
            "upgrade-insecure-requests"
        )
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else response.headers.get("Cache-Control", "no-cache")
        if forwarded_proto == "https" or config.ENFORCE_HTTPS:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echo passwords or non-JSON NaN/Infinity inputs in error responses.
        return JSONResponse(status_code=422, content={"detail": [
            {key: error[key] for key in ("type", "loc", "msg")} for error in exc.errors()
        ]})

    def storage() -> Storage:
        with runtime_lock:
            if app.state.storage is None:
                config.ensure_config_dirs()
                app.state.storage = Storage()
            return app.state.storage

    app.state.get_storage = storage

    def ensure_runtime() -> Simulation:
        with runtime_lock:
            store = storage()
            if app.state.simulation is None:
                try:
                    bundle = load_bundle()
                except Exception:
                    bundle = None
                app.state.bundle = bundle
                app.state.simulation = Simulation(bundle=bundle, seed=config.SIMULATION_SEED)
                snapshot = store.load_snapshot()
                if snapshot:
                    app.state.simulation.restore_snapshot(snapshot)
                    app.state.initial_state_recorded = True
            current = app.state.simulation
            if not app.state.initial_state_recorded:
                _record_state(store, current.state(), "system", "simulation.startup")
                app.state.initial_state_recorded = True
            return current

    def _record_state(store: Storage, state: dict[str, Any], actor: str, event_type: str,
                      prediction_entities: set[str] | None = None) -> None:
        for clinic in state.get("clinics", []):
            clinic_id = str(clinic["id"])
            if state["telemetry_mode"] == "simulation":
                store.record_telemetry("simulation", clinic_id, clinic, observed_at=clinic["observed_at"])
            if clinic["data_quality"] == "ok" and (prediction_entities is None or clinic_id in prediction_entities):
                store.record_prediction(clinic_id, clinic["risk_probability"], clinic["risk_level"],
                                        observed_at=clinic["observed_at"], risk_source=clinic["risk_source"])
        store.save_snapshot(app.state.simulation.snapshot())
        store.record_event(event_type, {"timestamp": state.get("timestamp"), "clinic_count": len(state.get("clinics", []))}, actor)
        if event_type.startswith("simulation.") and event_type != "simulation.startup":
            store.audit("simulation.change", actor, "simulation", {"event": event_type, "timestamp": state.get("timestamp")})
        sync_alerts(store, state)

    def _state_response(state: dict[str, Any]) -> dict[str, Any]:
        state["status"] = state["telemetry_status"]
        return state

    def maintenance() -> None:
        with runtime_lock:
            sync_alerts(storage(), ensure_runtime().state())

    def observation_time(stamp: datetime | None, previous: str | None) -> str:
        stamp = stamp or datetime.now(timezone.utc)
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise HTTPException(status_code=422, detail="observed_at must include a timezone")
        stamp = stamp.astimezone(timezone.utc)
        if (stamp - datetime.now(timezone.utc)).total_seconds() > 60:
            raise HTTPException(status_code=422, detail="observed_at is more than 60 seconds in the future")
        if previous and stamp <= datetime.fromisoformat(previous.replace("Z", "+00:00")):
            raise HTTPException(status_code=409, detail="Out-of-order or duplicate observation")
        return stamp.isoformat().replace("+00:00", "Z")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        current = ensure_runtime()
        current_state = current.state()
        return {"status": "ok" if current_state["telemetry_status"] == "Telemetry current" else "Telemetry stale", "model_ready": current.model_available,
                "persistence_ready": True, "stale_sensor_count": current_state["stale_sensor_count"],
                "stale_feeder_count": current_state["stale_feeder_count"]}

    @app.get("/api/auth/config")
    def auth_config() -> dict[str, Any]:
        return {"auth_mode": config.AUTH_MODE, "demo": config.AUTH_MODE == "demo", "roles": sorted(ROLES)}

    @app.post("/api/auth/login")
    def login(request: LoginRequest, http_request: Request) -> dict[str, Any]:
        # In-process, bounded, IP-based limiter. Trust no forwarded IP header.
        key = http_request.client.host if http_request.client else "local"
        now = time.monotonic()
        with login_lock:
            attempts = login_attempts.setdefault(key, deque(maxlen=10))
            login_attempts.move_to_end(key)
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if len(attempts) >= 10:
                raise HTTPException(status_code=429, detail="Too many login attempts; retry in one minute", headers={"Retry-After": "60"})
            attempts.append(now)
            while len(login_attempts) > 1024:
                login_attempts.popitem(last=False)
        user = storage().user_by_username(request.username)
        if config.AUTH_MODE == "required" and request.username == "demo-operator":
            user = None
        valid = verify_password(request.password, str(user["password_hash"]) if user else dummy_hash)
        if not user or not valid or user["role"] not in ROLES:
            storage().audit("auth.login", request.username, "auth", {"success": False})
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
        principal = Principal(str(user["username"]), str(user["role"]), int(user["id"]))
        token = issue_token(principal)
        storage().audit("auth.login", principal.username, "auth", {"success": True, "role": principal.role})
        return {"access_token": token, "token_type": "bearer", "expires_in": config.TOKEN_TTL_SECONDS,
                "user": principal.as_dict()}

    @app.get("/api/auth/me")
    def me(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
        return principal.as_dict()

    @app.get("/api/state")
    def state(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        with runtime_lock:
            result = ensure_runtime().state()
            sync_alerts(storage(), result)
            return _state_response(result)

    @app.post("/api/simulate")
    def simulate(request: SimulationRequest, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
        current = ensure_runtime()
        _validate_request(request, current)
        if request.action in {"trip_feeder", "restore_feeder"} and principal.role not in {"grid_operator", "admin"}:
            raise HTTPException(status_code=403, detail="Grid operator or admin role required for feeder actions")
        if request.action in {"local_fault", "restore_clinic", "freeze_clinic"} and principal.role not in {"clinic_operator", "admin"}:
            raise HTTPException(status_code=403, detail="Clinic operator or admin role required for clinic actions")
        if request.action in {"reset", "advance"} and principal.role not in {"clinic_operator", "grid_operator", "admin"}:
            raise HTTPException(status_code=403, detail="Operator or admin role required for simulation changes")
        with runtime_lock:
            if current.external_mode and request.action != "reset":
                raise HTTPException(status_code=409, detail="External telemetry mode is active; explicitly reset to return to simulation")
            result = current.simulate(request.action, feeder_id=request.feeder_id, clinic_id=request.clinic_id, hours=request.hours)
            _record_state(storage(), result, principal.username, f"simulation.{request.action}")
            return _state_response(result)

    @app.get("/api/priority")
    def priority(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        """Return the simulated v3 urgency ranking and SMS state summary."""
        current = ensure_runtime()
        state = current.state()
        return {
            "timestamp": state["timestamp"],
            "simulated": True,
            "policy": state["priority"],
            "sms_state_counts": state["summary"]["sms_state_counts"],
            "clinics": [
                {
                    "id": clinic["id"],
                    "name": clinic["name"],
                    "priority_rank": clinic["priority_rank"],
                    "priority_rank_before_followup": clinic["priority_rank_before_followup"],
                    "priority_slack_h": clinic["priority_slack_h"],
                    "hours_until_unusable": clinic["hours_until_unusable"],
                    "travel_time_h": clinic["travel_time_h"],
                    "sms_state": clinic["sms_state"],
                    "sms": clinic["sms"],
                }
                for clinic in sorted(state["clinics"], key=lambda row: row["priority_rank"] or 999)
            ],
        }

    @app.post("/api/sms/reply")
    def sms_reply(request: SMSReplyRequest, principal: Principal = Depends(require_roles("clinic_operator", "admin"))) -> dict[str, Any]:
        """Apply a simulated YES/NO SMS reply from a clinic worker."""
        current = ensure_runtime()
        try:
            result = current.reply_sms(request.clinic_id, request.reply)
        except KeyError:
            raise HTTPException(status_code=404, detail="Clinic not found")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        result["sms_reply_accepted"] = str(request.reply).strip().upper()
        _record_state(storage(), result, principal.username, "sms.reply", {request.clinic_id})
        return _state_response(result)

    @app.get("/api/model")
    def model_info(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        bundle = ensure_runtime().bundle
        if bundle is None or not ensure_runtime().model_available:
            return {"ready": False, "model_name": "Rules-only fallback", "horizon_hours": 6, "validation_status": "not_validated",
                    "thermal_forecast_validation": thermal_forecast_validation(seed=config.SIMULATION_SEED + 100_000)}
        metrics = bundle.get("metrics", {})
        return {"ready": True, "model_name": "XGBoost + sigmoid calibration", "horizon_hours": 6,
                "metrics": {name: metrics.get(name) for name in ("pr_auc", "f2", "brier", "roc_auc", "threshold", "prevalence")},
                "dataset": metrics.get("dataset", {}), "calibration": metrics.get("calibration", []),
                "feature_importance": metrics.get("feature_importance", []),
                "thermal_forecast_validation": metrics.get("thermal_forecast_validation") or thermal_forecast_validation(seed=config.SIMULATION_SEED + 100_000),
                "confusion_matrix": metrics.get("confusion_matrix", [[0, 0], [0, 0]]),
                "roc_curve": metrics.get("roc_curve", []), "notes": metrics.get("notes", [])}

    @app.post("/api/telemetry/feeder")
    def ingest_feeder(request: FeederTelemetryRequest, principal: Principal = Depends(require_roles("grid_operator", "admin"))) -> dict[str, Any]:
        with runtime_lock:
            current = ensure_runtime()
            previous = current.feeder_observations.get(request.feeder_id, {}).get("observed_at")
            observed_at = observation_time(request.observed_at, previous)
            payload = {**_dump(request), "observed_at": observed_at}
            current.ingest_feeder(payload, observed_at)
            row_id = storage().record_telemetry(request.source, f"feeder-{request.feeder_id}", payload, observed_at)
            storage().audit("telemetry.ingest", principal.username, f"feeder-{request.feeder_id}", payload)
            affected = {c["id"] for c in current.clinics.values() if c["feeder_id"] == request.feeder_id}
            if current._quality(observed_at) != "ok":
                affected = set()
            _record_state(storage(), current.state(), principal.username, "telemetry.feeder", affected)
            return {"accepted": True, "telemetry_id": row_id, "observed_at": observed_at}

    @app.post("/api/telemetry/clinic")
    def ingest_clinic(request: ClinicTelemetryRequest, principal: Principal = Depends(require_roles("clinic_operator", "admin"))) -> dict[str, Any]:
        with runtime_lock:
            current = ensure_runtime()
            if request.clinic_id not in current.clinics:
                raise HTTPException(status_code=422, detail="clinic_id must be CL-01 through CL-20")
            previous = current.clinics[request.clinic_id].get("observed_at") if current.external_mode else None
            observed_at = observation_time(request.observed_at, previous)
            payload = {**_dump(request), "observed_at": observed_at}
            current.ingest_clinic(payload, observed_at)
            quality = current._quality(observed_at)
            row_id = storage().record_telemetry(request.source, request.clinic_id, payload, observed_at, quality)
            storage().audit("telemetry.ingest", principal.username, request.clinic_id, payload)
            _record_state(storage(), current.state(), principal.username, "telemetry.clinic", {request.clinic_id})
            return {"accepted": True, "telemetry_id": row_id, "quality": quality, "observed_at": observed_at}

    @app.get("/api/weather")
    def weather(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        return get_weather()

    @app.get("/api/alerts")
    def alerts(include_acknowledged: bool = Query(True), include_resolved: bool = Query(True), _: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        maintenance()
        rows = storage().list_alerts(include_acknowledged)
        if not include_resolved:
            rows = [row for row in rows if row.get("status") != "resolved"]
        return {"alerts": [_alert_payload(alert) for alert in _as_json_rows(rows)]}

    @app.post("/api/alerts/{alert_id}/acknowledge")
    def acknowledge(alert_id: int, principal: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin"))) -> dict[str, Any]:
        alert = storage().acknowledge_alert(alert_id, principal.username)
        if not alert:
            raise HTTPException(status_code=404, detail="Alert not found")
        storage().audit("alert.acknowledge", principal.username, str(alert_id), {"channel": "demo-log"})
        return {"alert": _alert_payload(alert), "escalation": {"status": alert["status"], "next_action": "Escalation continues until observed recovery; demo-log only"}}

    @app.get("/api/audit")
    def audit(limit: int = Query(100, ge=1, le=500), _: Principal = Depends(require_roles("admin", "auditor"))) -> dict[str, Any]:
        return {"entries": _as_json_rows(storage().recent_audit(limit))}

    @app.get("/api/monitoring")
    def monitoring(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        current_state = ensure_runtime().state()
        result = storage().monitoring(config.TELEMETRY_STALE_SECONDS)
        result["stale_sensor_count"] = current_state["stale_sensor_count"]
        result["stale_feeder_count"] = current_state["stale_feeder_count"]
        result["current_data_quality"] = {quality: sum(c["data_quality"] == quality for c in current_state["clinics"])
                                          for quality in ("ok", "missing", "stale")}
        return result

    @app.post("/api/monitoring/feedback")
    def feedback(request: FeedbackRequest, principal: Principal = Depends(require_roles("clinic_operator", "admin"))) -> dict[str, Any]:
        try:
            result = storage().add_feedback(request.prediction_id, request.actual_outcome, request.notes)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        storage().audit("monitoring.feedback", principal.username, "prediction", result)
        return result

    @app.get("/api/events")
    def events(limit: int = Query(100, ge=1, le=500), _: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        return {"events": _as_json_rows(storage().recent_events(limit))}

    @app.get("/api/policy")
    def policy(_: Principal = Depends(require_roles("clinic_operator", "grid_operator", "admin", "auditor"))) -> dict[str, Any]:
        return {"medical_status": "Operational prototype; not clinically validated or certified; not medical advice",
                "deterministic_safeguards": [f"Observed temperature above {config.HIGH_TEMP_ALARM_C:g}°C creates an early-warning alarm",
                                               "Observed temperature below 2C or above 8C always elevates to Critical",
                                               "Feeder outage duration contributes deterministic risk when the model is unavailable",
                                               "SIMULATED Newton-law thermal forecasts show a countdown only when the mean trajectory crosses a configured limit"],
                "missing_data": "Missing or stale clinic telemetry is Unknown and creates no fresh prediction. External telemetry switches the whole runtime into external mode; simulation changes require an explicit reset. External observations use rules only; historical simulation weather is not a live model input.",
                "retention": "SQLite retains operational telemetry, alerts, events, audit entries, predictions, and feedback until an operator-managed database retention policy removes them",
                "roles": {"clinic_operator": "clinic telemetry, clinic controls, feedback, read operations",
                          "grid_operator": "feeder telemetry and feeder controls, read operations",
                          "admin": "all operations and audit access", "auditor": "read-only state, monitoring, alerts, audit, and events"},
                "auth_mode": config.AUTH_MODE, "validation_status": "not_validated",
                "thermal_forecast": "SIMULATED only; held-out synthetic validation reports temperature error and threshold-crossing error. No real-sensor or vaccine-stability claim is made.",
                "authentication": "Demo is a no-security local bypass. Required mode uses bearer authentication; local login throttling is process-local.",
                "escalation": f"In-app worker every {config.WORKER_INTERVAL_SECONDS:g}s; UTC elapsed-time stages at {config.ALERT_ESCALATION_SECONDS}s and {2 * config.ALERT_ESCALATION_SECONDS}s. Acknowledgement does not resolve. Demo-log outbox records intent only, with no external messages sent.",
                "deployment": "Single application process per SQLite runtime; TLS, backups, user provisioning, and retention are operator responsibilities."}

    def _codeflow_limits(request: CodeFlowRequest) -> dict[str, Any]:
        return {
            name: value
            for name, value in {
                "timeout_seconds": request.timeout_seconds,
                "max_output_bytes": request.max_output_bytes,
                "max_trace_events": request.max_trace_events,
            }.items()
            if value is not None
        }

    def _check_codeflow_rate(http_request: Request, bucket: str, limit: int) -> None:
        """Bound expensive CodeFlow actions per client without trusting proxies."""
        key = f"{http_request.client.host if http_request.client else 'local'}:{bucket}"
        now = time.monotonic()
        with codeflow_rate_lock:
            attempts = codeflow_attempts.setdefault(key, deque(maxlen=limit))
            codeflow_attempts.move_to_end(key)
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if len(attempts) >= limit:
                raise HTTPException(status_code=429, detail="CodeFlow rate limit reached; retry in one minute", headers={"Retry-After": "60"})
            attempts.append(now)
            while len(codeflow_attempts) > 2048:
                codeflow_attempts.popitem(last=False)

    @app.get("/api/codeflow/config")
    def codeflow_runtime_config(_: Principal = Depends(current_principal)) -> dict[str, Any]:
        return codeflow_config()

    @app.get("/api/codeflow/capabilities", include_in_schema=False)
    def codeflow_capabilities(_: Principal = Depends(current_principal)) -> dict[str, Any]:
        return codeflow_config()

    @app.post("/api/codeflow/execute")
    def codeflow_execute(request: CodeFlowRequest, http_request: Request, _: Principal = Depends(current_principal)) -> dict[str, Any]:
        _check_codeflow_rate(http_request, "execute", EXECUTE_RATE_LIMIT_PER_MINUTE)
        return execute_codeflow(request.source, request.language, _codeflow_limits(request))

    @app.post("/api/codeflow/run", include_in_schema=False)
    def codeflow_run(request: CodeFlowRequest, http_request: Request, _: Principal = Depends(current_principal)) -> dict[str, Any]:
        _check_codeflow_rate(http_request, "execute", EXECUTE_RATE_LIMIT_PER_MINUTE)
        return execute_codeflow(request.source, request.language, _codeflow_limits(request))

    @app.post("/api/codeflow/verify")
    def codeflow_verify(request: CodeFlowRequest, _: Principal = Depends(current_principal)) -> dict[str, Any]:
        return verify_codeflow(request.source, request.language)

    @app.post("/api/codeflow/ai")
    def codeflow_ai(request: CodeFlowAIRequest, http_request: Request, _: Principal = Depends(current_principal)) -> dict[str, Any]:
        _check_codeflow_rate(http_request, "ai", AI_RATE_LIMIT_PER_MINUTE)
        question = request.question or request.prompt
        if not question or not question.strip():
            raise HTTPException(status_code=422, detail="question or prompt is required")
        return ask_codeflow_ai(
            question=question,
            source=request.source,
            language=request.language,
            action=request.action,
            diagnostics=request.diagnostics,
            execution_context=request.execution,
        )

    frontend = Path(__file__).resolve().parents[1] / "frontend"
    if frontend.is_dir():
        coldchain_file = frontend / "coldchain.html"
        if coldchain_file.is_file():
            @app.get("/", include_in_schema=False)
            def clinic_cold_chain_home() -> FileResponse:
                """Make Clinic Cold Chain the default deployed application."""
                return FileResponse(str(coldchain_file), media_type="text/html")

            @app.get("/coldchain", include_in_schema=False)
            @app.get("/cold-chain", include_in_schema=False)
            def coldchain_dashboard() -> FileResponse:
                """Serve the standalone ColdChain clinic dashboard."""
                return FileResponse(str(coldchain_file), media_type="text/html")

        index_file = frontend / "index.html"

        # CodeFlow is a single-page lesson surface.  Keep these browser paths
        # explicit so direct navigation and refresh do not become StaticFiles
        # 404s while leaving the existing dashboard mount unchanged.
        if index_file.is_file():
            def codeflow_spa() -> FileResponse:
                return FileResponse(str(index_file), media_type="text/html")

            for path in ("/visualizer", "/examples", "/learn", "/challenges"):
                app.add_api_route(path, codeflow_spa, methods=["GET"], include_in_schema=False)

        codeflow_css_file = frontend / "codeflow.css"
        if not codeflow_css_file.is_file():
            codeflow_css_file = frontend / "codeflow-legacy.css"
        if codeflow_css_file.is_file():
            @app.get("/codeflow.css", include_in_schema=False)
            def codeflow_css() -> FileResponse:
                return FileResponse(str(codeflow_css_file), media_type="text/css")

        app.mount("/", StaticFiles(directory=str(frontend), html=True), name="frontend")
    return app


app = create_app()
