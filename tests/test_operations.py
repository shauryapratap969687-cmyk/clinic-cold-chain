"""Regression coverage for operational boundaries using isolated temporary DBs."""
from datetime import datetime, timedelta, timezone
import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from backend import config, main, weather
from backend.auth import Principal, issue_token, verify_password
from backend.storage import Storage


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "operations.db")
    monkeypatch.setattr(config, "AUTH_MODE", "demo")
    monkeypatch.setattr(config, "DEMO_USERNAME", "demo-operator")
    monkeypatch.setattr(config, "DEMO_PASSWORD", "demo-password-change-me")
    monkeypatch.setattr(config, "DEMO_ROLE", "admin")
    monkeypatch.setattr(config, "WEATHER_PROVIDER", "deterministic")
    monkeypatch.setattr(main, "load_bundle", lambda: None)
    return main.create_app


def clinic(state, identifier="CL-03"):
    return next(row for row in state["clinics"] if row["id"] == identifier)


def test_public_shell_and_demo_contract(runtime):
    with TestClient(runtime()) as client:
        assert client.get("/").status_code == 200
        assert client.get("/styles.css").status_code == 200
        assert client.get("/app.js").status_code == 200
        assert client.get("/api/auth/config").json()["demo"] is True
        assert client.get("/api/auth/me").json()["role"] == "admin"
        assert client.get("/api/health").json()["persistence_ready"] is True
        assert client.get("/api/model").json()["ready"] is False
        assert client.get("/api/policy").json()["validation_status"] == "not_validated"
        assert client.get("/api/weather").json()["fallback"] is True
        state = client.get("/api/state").json()
        assert state["summary"]["powered_clinics"] == 20
        assert all(c["risk_probability"] is None for c in state["clinics"])
        assert all(c["risk_source"] == "rules" for c in state["clinics"])


def test_restart_restores_state_rng_and_history(runtime):
    with TestClient(runtime()) as client:
        client.post("/api/simulate", json={"action": "trip_feeder", "feeder_id": 3}).raise_for_status()
        result = client.post("/api/simulate", json={"action": "advance", "hours": 6}).json()
        before_count = client.get("/api/monitoring").json()["prediction_count"]
        snapshot = client.app.state.simulation.snapshot()
        expected_next = client.app.state.simulation.simulate("advance", hours=1)
        client.app.state.simulation.restore_snapshot(snapshot)
    with TestClient(runtime()) as client:
        recovered = client.get("/api/state").json()
        assert recovered == result
        assert client.get("/api/monitoring").json()["prediction_count"] == before_count
        advanced = client.post("/api/simulate", json={"action": "advance", "hours": 1}).json()
        assert [c["temperature_c"] for c in advanced["clinics"]] == [c["temperature_c"] for c in expected_next["clinics"]]
        assert client.get("/api/audit").json()["entries"]
        assert client.get("/api/events").json()["events"]


def test_repeat_trip_no_instant_heating_and_local_fault_survives_restore(runtime):
    with TestClient(runtime()) as client:
        initial = client.get("/api/state").json()
        for _ in range(2):
            result = client.post("/api/simulate", json={"action": "trip_feeder", "feeder_id": 3}).json()
            assert clinic(result)["temperature_c"] == clinic(initial)["temperature_c"]
        assert sum(not c["power_on"] for c in result["clinics"]) == 3
        client.post("/api/simulate", json={"action": "local_fault", "clinic_id": "CL-03"})
        result = client.post("/api/simulate", json={"action": "restore_feeder", "feeder_id": 3}).json()
        assert not clinic(result)["power_on"]
        advanced = client.post("/api/simulate", json={"action": "advance", "hours": 2}).json()
        assert clinic(advanced)["outage_hours"] == 2
        assert clinic(advanced)["risk_level"] == "Critical"


def test_external_telemetry_updates_visible_state_and_refuses_simulator(runtime):
    with TestClient(runtime()) as client:
        response = client.post("/api/telemetry/clinic", json={"clinic_id": "CL-03", "temperature_c": 1.1, "source": "test-sensor"})
        assert response.status_code == 200
        state = client.get("/api/state").json()
        assert state["telemetry_mode"] == "external"
        assert clinic(state)["temperature_c"] == 1.1
        assert clinic(state)["risk_level"] == "Critical"
        assert clinic(state)["risk_probability"] is None
        assert state["stale_sensor_count"] == 19
        assert clinic(state, "CL-01")["temperature_c"] is None
        assert clinic(state, "CL-01")["risk_level"] == "Unknown"
        assert client.post("/api/simulate", json={"action": "advance"}).status_code == 409
        client.post("/api/telemetry/feeder", json={"feeder_id": 3, "online": False}).raise_for_status()
        state = client.get("/api/state").json()
        assert all(not c["power_on"] for c in state["clinics"] if c["feeder_id"] == 3)
        assert client.post("/api/simulate", json={"action": "reset"}).json()["telemetry_mode"] == "simulation"


def test_temperature_warning_alarm_and_critical_violation(runtime):
    with TestClient(runtime()) as client:
        client.post("/api/telemetry/clinic", json={"clinic_id": "CL-03", "temperature_c": 6.5, "source": "test-sensor"}).raise_for_status()
        state = client.get("/api/state").json()
        warning = clinic(state)
        assert warning["temperature_c"] == 6.5
        assert warning["too_hot"] is False
        assert warning["temperature_alarm"] is True
        assert warning["temperature_alarm_level"] == "warning"
        assert warning["temperature_alarm_threshold_c"] == config.HIGH_TEMP_ALARM_C == 6.0
        assert "early-warning" in warning["temperature_alarm_message"]
        assert warning["risk_level"] == "Warning"
        warning_alert = next(alert for alert in client.get("/api/alerts").json()["alerts"]
                             if alert["entity_id"] == "CL-03" and alert["kind"] == "high_temperature_alarm")
        assert warning_alert["status"] == "open"

        client.post("/api/telemetry/clinic", json={"clinic_id": "CL-03", "temperature_c": 8.5, "source": "test-sensor"}).raise_for_status()
        state = client.get("/api/state").json()
        critical = clinic(state)
        assert critical["temperature_c"] == 8.5
        assert critical["too_hot"] is True
        assert critical["temperature_alarm"] is True
        assert critical["temperature_alarm_level"] == "critical"
        assert critical["risk_level"] == "Critical"
        alerts = [alert for alert in client.get("/api/alerts").json()["alerts"] if alert["entity_id"] == "CL-03"]
        assert next(alert for alert in alerts if alert["kind"] == "thermal_violation")["status"] == "open"
        assert next(alert for alert in alerts if alert["kind"] == "high_temperature_alarm")["status"] == "resolved"


def test_system_health_escalates_for_shared_outage_and_thermal_breach(runtime):
    with TestClient(runtime()) as client:
        initial = client.get("/api/state").json()
        assert initial["summary"]["system_health"] == "Healthy"

        warning = client.post("/api/simulate", json={"action": "trip_feeder", "feeder_id": 3}).json()
        assert warning["summary"]["system_health"] == "Warning"
        assert warning["summary"]["warning_clinics"] == 3

        critical = client.post("/api/simulate", json={"action": "advance", "hours": 6}).json()
        assert critical["summary"]["system_health"] == "Critical"
        assert critical["summary"]["critical_clinics"] == 3


@pytest.mark.parametrize("payload", [
    {"clinic_id": "CL-99", "temperature_c": 4},
    {"clinic_id": "CL-01", "temperature_c": 101},
    {"clinic_id": "CL-01", "temperature_c": 4, "observed_at": "2026-01-01T12:00:00"},
    {"clinic_id": "CL-01", "temperature_c": 4, "observed_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()},
])
def test_bad_telemetry_is_rejected(runtime, payload):
    with TestClient(runtime()) as client:
        assert client.post("/api/telemetry/clinic", json=payload).status_code == 422


def test_stale_and_duplicate_telemetry_no_new_predictions(runtime):
    with TestClient(runtime()) as client:
        count = client.get("/api/monitoring").json()["prediction_count"]
        timestamp = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        payload = {"clinic_id": "CL-01", "temperature_c": 4, "observed_at": timestamp}
        assert client.post("/api/telemetry/clinic", json=payload).status_code == 200
        assert client.post("/api/telemetry/clinic", json=payload).status_code == 409
        state = client.get("/api/state").json()
        assert clinic(state, "CL-01")["risk_level"] == "Unknown"
        assert state["summary"]["system_health"] == "Unknown"
        assert client.get("/api/monitoring").json()["prediction_count"] == count


def test_alert_ack_escalation_recovery_and_recurrence(runtime):
    with TestClient(runtime()) as client:
        client.post("/api/simulate", json={"action": "freeze_clinic", "clinic_id": "CL-01"})
        alerts = client.get("/api/alerts").json()["alerts"]
        alarm = next(a for a in alerts if a["kind"] == "thermal_violation")
        identifier = alarm["id"]
        client.post(f"/api/alerts/{identifier}/acknowledge").raise_for_status()
        assert len(client.get("/api/alerts").json()["alerts"]) == len(alerts)
        with sqlite3.connect(config.DB_PATH) as db:
            db.execute("UPDATE alerts SET opened_at=? WHERE id=?", ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), identifier))
        alarm = next(a for a in client.get("/api/alerts").json()["alerts"] if a["id"] == identifier)
        assert alarm["status"] == "acknowledged"
        assert alarm["escalation_level"] == 2
        assert alarm["delivery_status"] == "logged_demo"
        client.post("/api/simulate", json={"action": "reset"})
        assert next(a for a in client.get("/api/alerts").json()["alerts"] if a["id"] == identifier)["status"] == "resolved"
        client.post("/api/simulate", json={"action": "freeze_clinic", "clinic_id": "CL-01"})
        recurred = [a for a in client.get("/api/alerts").json()["alerts"] if a["kind"] == "thermal_violation" and a["status"] == "open"]
        assert len(recurred) == 1 and recurred[0]["id"] != identifier
        assert all(e["payload"].get("sent") is False for e in client.get("/api/events?limit=500").json()["events"] if e["event_type"] == "alert.escalated")


def test_alert_queue_can_exclude_resolved_history(runtime):
    with TestClient(runtime()) as client:
        client.post("/api/simulate", json={"action": "freeze_clinic", "clinic_id": "CL-01"}).raise_for_status()
        active = client.get("/api/alerts?include_resolved=false")
        assert active.status_code == 200
        rows = active.json()["alerts"]
        assert rows and all(row["status"] != "resolved" for row in rows)

        client.post("/api/simulate", json={"action": "reset"}).raise_for_status()
        assert client.get("/api/alerts?include_resolved=false").json()["alerts"] == []


def required_mode(monkeypatch):
    monkeypatch.setattr(config, "AUTH_MODE", "required")
    monkeypatch.setattr(config, "DEMO_USERNAME", "test-admin")
    monkeypatch.setattr(config, "DEMO_PASSWORD", "test-only-password-12345")
    monkeypatch.setattr(config, "SECRET_KEY", "unit-test-only-abcdef0123456789-XYZ-!@#")


def test_authentication_roles_disabled_users_and_expiry(runtime, monkeypatch):
    required_mode(monkeypatch)
    with TestClient(runtime()) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/state").status_code == 401
        assert client.get("/api/auth/config").json()["auth_mode"] == "required"
        assert client.post("/api/auth/login", json={"username": config.DEMO_USERNAME, "password": "wrong"}).status_code == 401
        login = client.post("/api/auth/login", json={"username": config.DEMO_USERNAME, "password": config.DEMO_PASSWORD}).json()
        client.headers["Authorization"] = "Bearer " + login["access_token"]
        assert client.get("/api/state").status_code == 200
        with sqlite3.connect(config.DB_PATH) as db:
            db.execute("UPDATE users SET role='auditor' WHERE username=?", (config.DEMO_USERNAME,))
        assert client.get("/api/auth/me").json()["role"] == "auditor"
        assert client.get("/api/audit").status_code == 200
        assert client.post("/api/simulate", json={"action": "reset"}).status_code == 403
        assert client.post("/api/monitoring/feedback", json={"prediction_id": 1, "actual_outcome": True}).status_code == 403
        with sqlite3.connect(config.DB_PATH) as db:
            db.execute("UPDATE users SET active=0 WHERE username=?", (config.DEMO_USERNAME,))
        assert client.get("/api/state").status_code == 401
        client.headers["Authorization"] = "Bearer bad.invalid.token"
        assert client.get("/api/state").status_code == 401
        monkeypatch.setattr(config, "TOKEN_TTL_SECONDS", -1)
        expired = issue_token(Principal(config.DEMO_USERNAME, "admin", 1))
        client.headers["Authorization"] = "Bearer " + expired
        assert client.get("/api/state").status_code == 401


def test_security_headers_are_present_on_html_and_api_responses(runtime):
    with TestClient(runtime()) as client:
        headers = {"x-forwarded-proto": "https"}
        page = client.get("/coldchain", headers=headers)
        api = client.get("/api/auth/config", headers=headers)
        for response in (page, api):
            assert response.headers["x-content-type-options"] == "nosniff"
            assert response.headers["x-frame-options"] == "DENY"
            assert response.headers["strict-transport-security"].startswith("max-age=31536000")
            assert response.headers["permissions-policy"] == "camera=(), microphone=(), geolocation=()"
            assert response.headers["referrer-policy"] == "no-referrer"
            assert "default-src 'self'" in response.headers["content-security-policy"]
            assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_required_mode_fails_closed(runtime, monkeypatch):
    monkeypatch.setattr(config, "AUTH_MODE", "not-a-mode")
    with pytest.raises(ValueError):
        runtime()
    monkeypatch.setattr(config, "AUTH_MODE", "required")
    with pytest.raises(ValueError):
        runtime()


def test_login_limiter_does_not_echo_password(runtime):
    with TestClient(runtime()) as client:
        payload = {"username": "missing-user", "password": "must-not-be-in-audit"}
        for _ in range(10):
            assert client.post("/api/auth/login", json=payload).status_code == 401
        assert client.post("/api/auth/login", json=payload).status_code == 429
        assert payload["password"] not in json.dumps(client.get("/api/audit").json())


def test_reinitializing_storage_does_not_reset_credentials(runtime):
    first = Storage()
    hashed = first.user_by_username(config.DEMO_USERNAME)["password_hash"]
    second = Storage()
    assert second.user_by_username(config.DEMO_USERNAME)["password_hash"] == hashed


def test_explicit_required_bootstrap_sync_rotates_credentials(runtime, monkeypatch):
    required_mode(monkeypatch)
    monkeypatch.setattr(config, "BOOTSTRAP_SYNC", False)
    first = Storage()
    first_hash = first.user_by_username(config.DEMO_USERNAME)["password_hash"]
    monkeypatch.setattr(config, "DEMO_PASSWORD", "rotated-test-password-123")
    Storage()
    assert Storage().user_by_username(config.DEMO_USERNAME)["password_hash"] == first_hash
    monkeypatch.setattr(config, "BOOTSTRAP_SYNC", True)
    rotated = Storage().user_by_username(config.DEMO_USERNAME)
    assert rotated is not None
    assert verify_password(config.DEMO_PASSWORD, rotated["password_hash"])


def test_feedback_requires_prediction_and_is_idempotent(runtime):
    with TestClient(runtime()) as client:
        monitor = client.get("/api/monitoring").json()
        assert monitor["performance"]["status"] == "not_enough_data"
        assert monitor["performance"]["brier"] is None
        identifier = monitor["recent_predictions"][0]["id"]
        assert client.post("/api/monitoring/feedback", json={"prediction_id": 99999, "actual_outcome": False}).status_code == 422
        payload = {"prediction_id": identifier, "actual_outcome": False}
        first = client.post("/api/monitoring/feedback", json=payload).json()
        second = client.post("/api/monitoring/feedback", json=payload).json()
        assert first["id"] == second["id"]
        assert client.post("/api/monitoring/feedback", json={**payload, "actual_outcome": True}).status_code == 422
        monitor = client.get("/api/monitoring").json()
        assert monitor["feedback_count"] == 1
        assert monitor["performance"]["accuracy"] == 1
        assert monitor["performance"]["brier"] is None  # rules are not calibrated probabilities


def test_model_exception_uses_rules_and_thermal_alarm(runtime, monkeypatch):
    monkeypatch.setattr(main, "load_bundle", lambda: {"model": None})
    with TestClient(runtime()) as client:
        assert client.get("/api/model").json()["ready"] is False
        state = client.post("/api/simulate", json={"action": "freeze_clinic", "clinic_id": "CL-03"}).json()
        assert clinic(state)["risk_level"] == "Critical"
        assert clinic(state)["risk_probability"] is None
        assert clinic(state)["risk_source"] == "rules"


def test_escalation_worker_runs_without_dashboard_polling(runtime, monkeypatch):
    monkeypatch.setattr(config, "WORKER_INTERVAL_SECONDS", 1)
    with TestClient(runtime()) as client:
        client.post("/api/simulate", json={"action": "freeze_clinic", "clinic_id": "CL-01"})
        with sqlite3.connect(config.DB_PATH) as db:
            db.execute("UPDATE alerts SET opened_at=?", ((datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),))
        deadline = time.monotonic() + 5
        levels = []
        while time.monotonic() < deadline:
            time.sleep(0.15)
            with sqlite3.connect(config.DB_PATH) as db:
                levels = [row[0] for row in db.execute("SELECT escalation_level FROM alerts")]
            if levels and all(level == 2 for level in levels):
                break
        assert levels and all(level == 2 for level in levels)


def test_weather_provider_cache_then_stale_fallback(runtime, monkeypatch):
    monkeypatch.setattr(config, "WEATHER_PROVIDER", "open-meteo")
    monkeypatch.setattr(weather, "_cache", None)
    monkeypatch.setattr(weather, "_cache_key", None)
    monkeypatch.setattr(weather, "_last_attempt", 0)
    stamp = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    data = {"current": {"time": stamp.isoformat(), "temperature_2m": 25, "precipitation": 1, "wind_speed_10m": 12},
            "hourly": {"time": [(stamp + timedelta(hours=i)).isoformat() for i in range(7)],
                       "precipitation": [1] * 7, "wind_speed_10m": [12] * 7}}

    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            return json.dumps(data).encode()

    class Provider:
        calls = 0
        def open(self, request, timeout):
            self.calls += 1
            assert request.full_url.startswith("https://api.open-meteo.com/")
            if self.calls > 1:
                raise TimeoutError("simulated provider outage")
            return Response()

    provider = Provider()
    monkeypatch.setattr(weather, "build_opener", lambda *args: provider)
    result = weather.get_weather()
    assert result["fallback"] is False
    assert result["forecast_rain_next_6h"] == 6
    assert weather.get_weather()["provider"] == "open-meteo"
    assert provider.calls == 1
    monkeypatch.setattr(weather, "_last_attempt", 0)
    fallback = weather.get_weather()
    assert fallback["fallback"] is True and fallback["stale"] is True
    assert fallback["temperature_c"] == result["temperature_c"]
    assert fallback["observed_at"] == result["observed_at"]


def test_local_user_provisioning_and_disable(runtime, monkeypatch):
    from backend import manage_users
    from backend.auth import verify_password
    monkeypatch.setattr("sys.argv", ["manage_users", "create", "operator-a", "--role", "clinic_operator"])
    monkeypatch.setattr(manage_users, "getpass", lambda prompt: "test-only-password-123")
    manage_users.main()
    store = Storage()
    user = store.user_by_username("operator-a")
    assert user["role"] == "clinic_operator"
    assert verify_password("test-only-password-123", user["password_hash"])
    monkeypatch.setattr("sys.argv", ["manage_users", "disable", "operator-a"])
    manage_users.main()
    assert store.user_by_username("operator-a") is None
    assert "test-only-password-123" not in json.dumps(store.recent_audit())
