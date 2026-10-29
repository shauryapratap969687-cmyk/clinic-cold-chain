from __future__ import annotations

from fastapi.testclient import TestClient

from backend import config, main


def test_priority_endpoint_and_simulated_sms_states(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "priority.db")
    monkeypatch.setattr(config, "AUTH_MODE", "demo")
    monkeypatch.setattr(main, "load_bundle", lambda: None)

    with TestClient(main.create_app()) as client:
        dashboard = client.get("/coldchain")
        assert dashboard.status_code == 200
        assert "ColdChain / Control Room" in dashboard.text
        assert "Live clinic priority ranking" in dashboard.text

        initial = client.get("/api/priority")
        assert initial.status_code == 200
        payload = initial.json()
        assert payload["simulated"] is True
        assert [row["priority_rank"] for row in payload["clinics"]] == list(range(1, 21))
        assert payload["sms_state_counts"] == {"normal": 20}

        client.post("/api/simulate", json={"action": "trip_feeder", "feeder_id": 3}).raise_for_status()
        state = client.get("/api/state").json()
        affected = [row for row in state["clinics"] if row["feeder_id"] == 3]
        assert {row["sms_state"] for row in affected} == {"critical_unconfirmed", "critical_no_sms"}
        backup = next(row for row in affected if row["has_backup"])
        before_rank = backup["priority_rank"]
        assert backup["sms"]["reply_options"] == ["YES", "NO"]
        assert "SIMULATED SMS" in backup["sms"]["message"]

        replied = client.post("/api/sms/reply", json={"clinic_id": backup["id"], "reply": "YES"})
        assert replied.status_code == 200
        updated = next(row for row in replied.json()["clinics"] if row["id"] == backup["id"])
        assert updated["sms_state"] == "backup_in_use"
        assert updated["power_source"] == "battery"
        assert updated["priority_rank"] > before_rank

        no_backup = next(row for row in affected if not row["has_backup"])
        rejected = client.post("/api/sms/reply", json={"clinic_id": no_backup["id"], "reply": "YES"})
        assert rejected.status_code == 422


def test_sms_reply_validation_is_single_choice(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "priority-invalid.db")
    monkeypatch.setattr(config, "AUTH_MODE", "demo")
    monkeypatch.setattr(main, "load_bundle", lambda: None)

    with TestClient(main.create_app()) as client:
        response = client.post("/api/sms/reply", json={"clinic_id": "CL-03", "reply": "maybe"})
        assert response.status_code == 422
