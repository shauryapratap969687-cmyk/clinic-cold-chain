"""Durable alert derivation and demo outbound escalation logging."""

from __future__ import annotations

from typing import Any

from .storage import Storage, utc_now


def sync_alerts(storage: Storage, state: dict[str, Any]) -> list[dict[str, Any]]:
    feeders = {feeder["id"]: feeder for feeder in state.get("feeders", [])}
    for feeder in feeders.values():
        entity = f"feeder-{feeder['id']}"
        quality = feeder.get("data_quality", "ok")
        if quality != "ok":
            storage.upsert_alert(f"telemetry:{entity}", entity, "telemetry_unavailable", "high",
                                 f"Telemetry {quality} at {entity}; feeder condition unconfirmed", feeder.get("observed_at") or utc_now(),
                                 "Verify feeder telemetry with the grid operator")
        else:
            storage.resolve_alert(f"telemetry:{entity}")
    for clinic in state.get("clinics", []):
        entity_id = str(clinic["id"])
        observed_at = clinic.get("observed_at") or utc_now()
        quality = clinic.get("data_quality", "ok")
        if quality != "ok":
            storage.upsert_alert(f"telemetry:{entity_id}", entity_id, "telemetry_unavailable", "high",
                                 f"Telemetry {quality} at {entity_id}; current condition unknown", observed_at,
                                 "Verify sensor connectivity and obtain a current temperature reading")
        else:
            storage.resolve_alert(f"telemetry:{entity_id}")
        if quality == "ok" and (clinic.get("too_cold") or float(clinic["temperature_c"]) > 8):
            storage.upsert_alert(f"thermal:{entity_id}", entity_id, "thermal_violation", "critical",
                                 f"Observed temperature violation at {entity_id}", observed_at,
                                 "Isolate affected stock and inspect refrigeration")
        elif quality == "ok":
            storage.resolve_alert(f"thermal:{entity_id}")
        feeder = feeders.get(clinic.get("feeder_id"), {})
        feeder_fresh = feeder.get("data_quality", "ok") == "ok"
        if clinic.get("feeder_online") is False and feeder_fresh:
            storage.upsert_alert(f"outage:{clinic.get('feeder_id')}:{entity_id}", entity_id, "feeder_outage", "high",
                                 f"Feeder outage affecting {entity_id}", feeder.get("observed_at") or observed_at,
                                 "Contact grid operator and verify backup power")
        elif clinic.get("feeder_online") is True and feeder_fresh:
            storage.resolve_alert(f"outage:{clinic.get('feeder_id')}:{entity_id}")
        if quality == "ok" and clinic.get("local_fault"):
            storage.upsert_alert(f"local:{entity_id}", entity_id, "local_fault", "high",
                                 f"Local refrigeration fault at {entity_id}", observed_at, "Inspect local refrigeration and backup power")
        elif quality == "ok":
            storage.resolve_alert(f"local:{entity_id}")
        if quality == "ok" and clinic.get("risk_level") == "Critical":
            storage.upsert_alert(f"risk:{entity_id}", entity_id, "critical_risk", "critical",
                                 f"Critical operational risk at {entity_id} ({clinic.get('risk_source', 'rules')})", observed_at,
                                 "Verify stock temperature and arrange operational review")
        elif quality == "ok":
            storage.resolve_alert(f"risk:{entity_id}")
    storage.escalate_due()
    return storage.list_alerts()
