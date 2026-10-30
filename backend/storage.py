"""SQLite persistence with parameterized statements and durable demo records."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from .auth import hash_password
from . import config


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Storage:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path or config.DB_PATH)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self.initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(str(self.path), timeout=10, check_same_thread=False)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._lock, self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, entity_id TEXT NOT NULL,
                    observed_at TEXT NOT NULL, payload_json TEXT NOT NULL, quality TEXT NOT NULL DEFAULT 'ok',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_telemetry_entity_time ON telemetry(entity_id, observed_at);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
                    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, alert_key TEXT UNIQUE NOT NULL, entity_id TEXT NOT NULL,
                    kind TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
                    observed_at TEXT NOT NULL, next_action TEXT NOT NULL, acknowledged_by TEXT,
                    acknowledged_at TEXT, outbound_logged INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL,
                    resource TEXT, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS predictions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id TEXT NOT NULL, probability REAL,
                    risk_level TEXT NOT NULL, observed_at TEXT NOT NULL, data_quality TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id INTEGER, actual_outcome INTEGER NOT NULL,
                    notes TEXT, created_at TEXT NOT NULL, FOREIGN KEY(prediction_id) REFERENCES predictions(id)
                );
                CREATE TABLE IF NOT EXISTS runtime_snapshot (
                    id INTEGER PRIMARY KEY CHECK(id=1), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS alert_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER NOT NULL,
                    escalation_level INTEGER NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, UNIQUE(alert_id, escalation_level)
                );
                """
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(alerts)")}
            for name, declaration in {"opened_at": "TEXT", "resolved_at": "TEXT", "escalation_level": "INTEGER NOT NULL DEFAULT 0",
                                      "delivery_status": "TEXT NOT NULL DEFAULT 'logged_demo'"}.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE alerts ADD COLUMN {name} {declaration}")
            db.execute("UPDATE alerts SET opened_at=updated_at WHERE opened_at IS NULL")
            db.commit()
            if any(row[1] == "probability" and row[3] for row in db.execute("PRAGMA table_info(predictions)")):
                db.executescript("""
                    PRAGMA foreign_keys=OFF;
                    BEGIN;
                    CREATE TABLE predictions_new (id INTEGER PRIMARY KEY AUTOINCREMENT, clinic_id TEXT NOT NULL,
                        probability REAL, risk_level TEXT NOT NULL, observed_at TEXT NOT NULL, data_quality TEXT NOT NULL);
                    INSERT INTO predictions_new SELECT id,clinic_id,probability,risk_level,observed_at,data_quality FROM predictions;
                    DROP TABLE predictions;
                    ALTER TABLE predictions_new RENAME TO predictions;
                    COMMIT;
                    PRAGMA foreign_keys=ON;
                """)
            if "risk_source" not in {row[1] for row in db.execute("PRAGMA table_info(predictions)")}:
                db.execute("ALTER TABLE predictions ADD COLUMN risk_source TEXT NOT NULL DEFAULT 'legacy_unknown'")
            # Retain legacy feedback rows while ensuring all new writes are unique.
            if not db.execute("SELECT prediction_id FROM feedback WHERE prediction_id IS NOT NULL GROUP BY prediction_id HAVING COUNT(*)>1 LIMIT 1").fetchone():
                db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_outcome ON feedback(prediction_id) WHERE prediction_id IS NOT NULL")
            db.execute("""CREATE TRIGGER IF NOT EXISTS feedback_unique_insert BEFORE INSERT ON feedback
                WHEN NEW.prediction_id IS NULL OR EXISTS(SELECT 1 FROM feedback WHERE prediction_id=NEW.prediction_id)
                BEGIN SELECT RAISE(ABORT, 'prediction feedback must be unique and paired'); END""")
            self._ensure_demo_user(db, config.DEMO_USERNAME, config.DEMO_PASSWORD, config.DEMO_ROLE)

    @staticmethod
    def _ensure_demo_user(db: sqlite3.Connection, username: str, password: str, role: str) -> None:
        existing = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        if existing:
            # Explicit, deployment-controlled rotation path for environments
            # without database shell access. It is disabled by default.
            if config.AUTH_MODE == "required" and config.BOOTSTRAP_SYNC:
                db.execute("UPDATE users SET password_hash=?, role=?, active=1 WHERE id=?",
                           (hash_password(password), role, existing[0]))
            return
        db.execute(
            """INSERT OR IGNORE INTO users(username,password_hash,role,active,created_at) VALUES(?,?,?,?,?)""",
            (username, hash_password(password), role, 1, utc_now()),
        )

    def user_by_username(self, username: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE username=? AND active=1", (username,)).fetchone()
            return dict(row) if row else None

    def audit(self, action: str, actor: str | None, resource: str | None = None, detail: Any = None) -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO audit_log(actor,action,resource,detail_json,created_at) VALUES(?,?,?,?,?)",
                       (actor, action, resource, json.dumps(detail if detail is not None else {}, default=str), utc_now()))

    def record_event(self, event_type: str, payload: Any, actor: str | None = None) -> int:
        with self._lock, self._connect() as db:
            cursor = db.execute("INSERT INTO events(event_type,actor,payload_json,created_at) VALUES(?,?,?,?)",
                               (event_type, actor, json.dumps(payload, default=str), utc_now()))
            return int(cursor.lastrowid)

    def record_telemetry(self, source: str, entity_id: str, payload: dict[str, Any],
                         observed_at: str | None = None, quality: str = "ok") -> int:
        with self._lock, self._connect() as db:
            cursor = db.execute("INSERT INTO telemetry(source,entity_id,observed_at,payload_json,quality,created_at) VALUES(?,?,?,?,?,?)",
                               (source, entity_id, observed_at or utc_now(), json.dumps(payload, default=str), quality, utc_now()))
            return int(cursor.lastrowid)

    def record_prediction(self, clinic_id: str, probability: float | None, risk_level: str,
                          observed_at: str | None = None, data_quality: str = "ok", risk_source: str = "rules") -> int:
        with self._lock, self._connect() as db:
            cursor = db.execute("INSERT INTO predictions(clinic_id,probability,risk_level,observed_at,data_quality,risk_source) VALUES(?,?,?,?,?,?)",
                               (clinic_id, probability, risk_level, observed_at or utc_now(), data_quality, risk_source))
            return int(cursor.lastrowid)

    def upsert_alert(self, alert_key: str, entity_id: str, kind: str, severity: str, message: str,
                     observed_at: str, next_action: str) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO alerts(alert_key,entity_id,kind,severity,status,message,observed_at,next_action,updated_at,opened_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(alert_key) DO UPDATE SET
                   severity=excluded.severity,message=excluded.message,observed_at=excluded.observed_at,
                   next_action=excluded.next_action,updated_at=excluded.updated_at""",
                (alert_key, entity_id, kind, severity, "open", message, observed_at, next_action, now, now),
            )
            row = db.execute("SELECT * FROM alerts WHERE alert_key=?", (alert_key,)).fetchone()
            if row and not row["outbound_logged"]:
                db.execute("UPDATE alerts SET outbound_logged=1,updated_at=? WHERE id=?", (now, row["id"]))
                db.execute("INSERT OR IGNORE INTO alert_outbox(alert_id,escalation_level,channel,status,created_at) VALUES(?,0,'demo-log','logged_demo',?)",
                           (row["id"], now))
                db.execute("INSERT INTO events(event_type,actor,payload_json,created_at) VALUES(?,?,?,?)",
                           ("alert_outbound_demo", "system", json.dumps({"alert_id": row["id"], "channel": "demo-log", "delivery_status": "logged_demo", "sent": False}), now))
                row = db.execute("SELECT * FROM alerts WHERE alert_key=?", (alert_key,)).fetchone()
            return dict(row)

    def resolve_alert(self, alert_key: str) -> None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT id FROM alerts WHERE alert_key=? AND status!='resolved'", (alert_key,)).fetchone()
            if row:
                now = utc_now()
                db.execute("UPDATE alerts SET status='resolved',resolved_at=?,updated_at=?,alert_key=alert_key || ':resolved:' || id WHERE id=?",
                           (now, now, row["id"]))
                db.execute("INSERT INTO events(event_type,actor,payload_json,created_at) VALUES(?,?,?,?)",
                           ("alert.resolved", "system", json.dumps({"alert_id": row["id"]}), now))

    def escalate_due(self) -> int:
        """UTC wall time, independent of simulated clock; acknowledgement is not recovery."""
        now = datetime.now(timezone.utc)
        count = 0
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT * FROM alerts WHERE status IN ('open','acknowledged') AND escalation_level<2 LIMIT 500").fetchall()
            for row in rows:
                opened = datetime.fromisoformat(row["opened_at"].replace("Z", "+00:00"))
                due = min(2, int((now - opened).total_seconds() // config.ALERT_ESCALATION_SECONDS))
                for level in range(row["escalation_level"] + 1, due + 1):
                    stamp = utc_now()
                    db.execute("INSERT OR IGNORE INTO alert_outbox(alert_id,escalation_level,channel,status,created_at) VALUES(?,?,'demo-log','logged_demo',?)",
                               (row["id"], level, stamp))
                    db.execute("UPDATE alerts SET escalation_level=?,delivery_status='logged_demo',updated_at=? WHERE id=?",
                               (level, stamp, row["id"]))
                    db.execute("INSERT INTO events(event_type,actor,payload_json,created_at) VALUES(?,?,?,?)",
                               ("alert.escalated", "system", json.dumps({"alert_id": row["id"], "level": level, "channel": "demo-log", "sent": False}), stamp))
                    count += 1
        return count

    def list_alerts(self, include_acknowledged: bool = True) -> list[dict[str, Any]]:
        query = "SELECT * FROM alerts"
        if not include_acknowledged:
            query += " WHERE status != 'acknowledged'"
        query += " ORDER BY updated_at DESC, id DESC LIMIT 500"
        with self._lock, self._connect() as db:
            return [dict(row) for row in db.execute(query)]

    def acknowledge_alert(self, alert_id: int, actor: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=?,updated_at=? WHERE id=? AND status='open'",
                       (actor, utc_now(), utc_now(), alert_id))
            row = db.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
            if not row:
                return None
            return dict(row)

    def recent_audit(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,))]

    def add_feedback(self, prediction_id: int | None, actual_outcome: bool, notes: str | None) -> dict[str, Any]:
        with self._lock, self._connect() as db:
            if prediction_id is None or not db.execute("SELECT id FROM predictions WHERE id=?", (prediction_id,)).fetchone():
                raise ValueError("prediction_id not found")
            existing = db.execute("SELECT * FROM feedback WHERE prediction_id=? ORDER BY id LIMIT 1", (prediction_id,)).fetchone()
            if existing:
                if bool(existing["actual_outcome"]) != actual_outcome:
                    raise ValueError("prediction_id already has a different outcome")
                return {**dict(existing), "actual_outcome": bool(existing["actual_outcome"])}
            cursor = db.execute("INSERT INTO feedback(prediction_id,actual_outcome,notes,created_at) VALUES(?,?,?,?)",
                               (prediction_id, int(actual_outcome), notes, utc_now()))
            return {"id": int(cursor.lastrowid), "prediction_id": prediction_id, "actual_outcome": bool(actual_outcome), "notes": notes}

    def save_snapshot(self, payload: dict[str, Any]) -> None:
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO runtime_snapshot(id,payload_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at",
                       (json.dumps(payload), utc_now()))

    def load_snapshot(self) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT payload_json FROM runtime_snapshot WHERE id=1").fetchone()
            return json.loads(row[0]) if row else None

    def recent_events(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock, self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (min(limit, 500),))]

    def monitoring(self, stale_seconds: int) -> dict[str, Any]:
        with self._lock, self._connect() as db:
            prediction_count = int(db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0])
            feedback_count = int(db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0])
            rows = db.execute("SELECT observed_at,quality FROM telemetry ORDER BY id DESC LIMIT 1000").fetchall()
            quality = {"ok": 0, "degraded": 0, "invalid": 0}
            for row in rows:
                quality[str(row[1])] = quality.get(str(row[1]), 0) + 1
            recent = [dict(row) for row in db.execute("SELECT * FROM predictions ORDER BY id DESC LIMIT 1000")]
            distribution = {level: sum(row["risk_level"] == level for row in recent) for level in ("Safe", "Warning", "Critical", "Unknown")}
            labeled = [dict(row) for row in db.execute("""SELECT p.*,f.actual_outcome FROM predictions p JOIN feedback f ON p.id=f.prediction_id
                WHERE f.id=(SELECT MIN(f2.id) FROM feedback f2 WHERE f2.prediction_id=p.id) ORDER BY p.id DESC LIMIT 1000""")]
            tp = sum(row["risk_level"] == "Critical" and row["actual_outcome"] == 1 for row in labeled)
            fp = sum(row["risk_level"] == "Critical" and row["actual_outcome"] == 0 for row in labeled)
            fn = sum(row["risk_level"] != "Critical" and row["actual_outcome"] == 1 for row in labeled)
            tn = len(labeled) - tp - fp - fn
            calibrated = [row for row in labeled if row["risk_source"] == "calibrated_model" and row["probability"] is not None]
            performance = {"status": "paired_outcomes" if labeled else "not_enough_data", "labeled_count": len(labeled),
                           "accuracy": (tp + tn) / len(labeled) if labeled else None,
                           "precision": tp / (tp + fp) if tp + fp else None,
                           "recall": tp / (tp + fn) if tp + fn else None,
                           "f2": 5 * tp / (5 * tp + 4 * fn + fp) if 5 * tp + 4 * fn + fp else None,
                           "brier": sum((row["probability"] - row["actual_outcome"]) ** 2 for row in calibrated) / len(calibrated) if calibrated else None,
                           "probability_labeled_count": len(calibrated), "confusion_matrix": [[tn, fp], [fn, tp]] if labeled else None,
                           "limitation": "Operator-reported six-hour outcomes; Critical is the positive alarm class. Not independent clinical validation."}
            baseline = db.execute("SELECT risk_level FROM predictions ORDER BY id LIMIT 200").fetchall()
            baseline_rate = sum(row[0] == "Critical" for row in baseline) / len(baseline) if baseline else None
            recent_rate = distribution["Critical"] / len(recent) if recent else None
            drift = {"method": "critical_risk_rate_shift", "baseline_count": len(baseline), "recent_count": len(recent),
                     "baseline_critical_rate": baseline_rate, "recent_critical_rate": recent_rate,
                     "absolute_shift": abs(recent_rate - baseline_rate) if recent_rate is not None and baseline_rate is not None else None,
                     "limitation": "Descriptive proxy only: first 200 versus latest 1000 predictions, potentially overlapping. Actions, missingness and model changes confound drift."}
            return {"prediction_count": prediction_count, "feedback_count": feedback_count,
                    "recent_data_quality": quality, "stale_sensor_count": self.stale_sensor_count(stale_seconds),
                    "risk_distribution": distribution, "recent_predictions": recent[:100], "performance": performance, "drift": drift}

    def latest_telemetry(self, entity_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT * FROM telemetry WHERE entity_id=? ORDER BY id DESC LIMIT 1", (entity_id,)).fetchone()
            return dict(row) if row else None

    def stale_sensor_count(self, stale_seconds: int) -> int:
        now = datetime.now(timezone.utc)
        with self._lock, self._connect() as db:
            count = 0
            for index in range(1, 21):
                row = db.execute("SELECT observed_at FROM telemetry WHERE entity_id=? ORDER BY id DESC LIMIT 1", (f"CL-{index:02d}",)).fetchone()
                try:
                    stamp = datetime.fromisoformat(str(row[0]).replace("Z", "+00:00"))
                    if stamp.tzinfo is None:
                        stamp = stamp.replace(tzinfo=timezone.utc)
                    count += (now - stamp).total_seconds() > stale_seconds
                except (TypeError, ValueError, IndexError):
                    count += 1
            return count
