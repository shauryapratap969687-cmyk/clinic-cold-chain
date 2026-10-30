from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from backend import config, main
from backend.auth import hash_password


def test_authority_dashboard_is_dynamic_and_supports_followups(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "authority.db")
    monkeypatch.setattr(config, "AUTH_MODE", "demo")
    monkeypatch.setattr(config, "DEMO_ROLE", "authority")
    monkeypatch.setattr(main, "load_bundle", lambda: None)

    with TestClient(main.create_app()) as client:
        summary = client.get("/api/authority/summary")
        assert summary.status_code == 200
        assert summary.json()["total_clinics"] == 20

        registered = client.post("/api/authority/clinics", json={
            "clinic_id": "CL-21", "name": "North Ridge Clinic", "location": "North district"
        })
        assert registered.status_code == 200
        assert registered.json()["clinic"]["clinic_id"] == "CL-21"

        filtered = client.get("/api/authority/clinics?location=North")
        assert filtered.status_code == 200
        assert [row["id"] for row in filtered.json()["clinics"]] == ["CL-21"]
        assert filtered.json()["clinics"][0]["connection_status"] == "registered"

        detail = client.get("/api/authority/clinics/CL-21")
        assert detail.status_code == 200
        assert detail.json()["clinic"]["name"] == "North Ridge Clinic"
        assert detail.json()["clinic"]["risk_level"] == "Unknown"

        followup = client.post("/api/authority/clinics/CL-21/followups", json={"message": "Send a simulated status update."})
        assert followup.status_code == 200
        followup_id = followup.json()["followup"]["id"]
        assert client.get("/api/authority/followups").json()["followups"][0]["id"] == followup_id


def test_clinic_user_is_scoped_to_assigned_clinic(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "authority-scope.db")
    monkeypatch.setattr(config, "AUTH_MODE", "required")
    monkeypatch.setattr(config, "DEMO_USERNAME", "authority-admin")
    monkeypatch.setattr(config, "DEMO_PASSWORD", "authority-password-123")
    monkeypatch.setattr(config, "DEMO_ROLE", "authority")
    monkeypatch.setattr(config, "SECRET_KEY", "authority-test-secret-0123456789-ABCDEF")
    monkeypatch.setattr(main, "load_bundle", lambda: None)

    with TestClient(main.create_app()) as client:
        with sqlite3.connect(config.DB_PATH) as db:
            db.execute(
                "INSERT INTO users(username,password_hash,role,clinic_id,active,created_at) VALUES(?,?,?,?,1,?)",
                ("clinic-one", hash_password("clinic-password-123"), "clinic_operator", "CL-01", "2026-01-01T00:00:00Z"),
            )
        login = client.post("/api/auth/login", json={"username": "clinic-one", "password": "clinic-password-123"})
        assert login.status_code == 200
        client.headers["Authorization"] = "Bearer " + login.json()["access_token"]
        state = client.get("/api/state")
        assert state.status_code == 200
        assert [row["id"] for row in state.json()["clinics"]] == ["CL-01"]
        assert client.get("/api/authority/summary").status_code == 403
        assert client.post("/api/simulate", json={"action": "local_fault", "clinic_id": "CL-02"}).status_code == 403
        assert client.post("/api/simulate", json={"action": "local_fault", "clinic_id": "CL-01"}).status_code == 200
