from __future__ import annotations

import json
import os
import random
import re
import base64
import hashlib
import hmac
import ipaddress
import socket
import sqlite3
import smtplib
import ssl
import subprocess
import secrets
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib import request as urlrequest
from urllib import error as urlerror


ROOT = Path(__file__).resolve().parent
DIST_PATH = ROOT / "dist"
DB_PATH = ROOT / "data" / "network-manager.sqlite"
DB_LOCK = threading.Lock()
HTTP_HOST = os.environ.get("NETWORK_MANAGER_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("NETWORK_MANAGER_PORT", "4173"))
PING_TIMEOUT_MS = 1200
SNMP_TIMEOUT_SECONDS = 2.0
SNMP_WALK_LIMIT = 128
SNMP_TABLE_WALK_LIMIT = 4096
SENSOR_BATCH_LIMIT = 8
TRAFFIC_DEVICE_BATCH_LIMIT = 2
MAINTENANCE_INTERVAL_SECONDS = 300
RAW_SAMPLE_RETENTION_SECONDS = 7 * 24 * 60 * 60
ROLLUP_RETENTION_SECONDS = {"5m": 30 * 24 * 60 * 60, "1h": 180 * 24 * 60 * 60, "1d": 180 * 24 * 60 * 60}
ROLLUP_BUCKET_SECONDS = {"5m": 5 * 60, "1h": 60 * 60, "1d": 24 * 60 * 60}
SAMPLE_RANGE_SECONDS = {"1h": 60 * 60, "24h": 24 * 60 * 60, "7d": 7 * 24 * 60 * 60, "30d": 30 * 24 * 60 * 60, "180d": 180 * 24 * 60 * 60}
SAMPLE_AUTO_RESOLUTION = {"1h": "raw", "24h": "5m", "7d": "1h", "30d": "1h", "180d": "1d"}
AUTH_DISABLED = os.environ.get("NETWORK_MANAGER_AUTH_DISABLED", "").lower() in {"1", "true", "yes", "on"}
PASSWORD_ITERATIONS = 210_000
IF_DESCR_OID = "1.3.6.1.2.1.2.2.1.2"
IF_SPEED_OID = "1.3.6.1.2.1.2.2.1.5"
IF_ALIAS_OID = "1.3.6.1.2.1.31.1.1.1.18"
IF_HC_IN_OID = "1.3.6.1.2.1.31.1.1.1.6"
IF_HC_OUT_OID = "1.3.6.1.2.1.31.1.1.1.10"
LLDP_LOC_PORT_ID_OID = "1.0.8802.1.1.2.1.3.7.1.3"
LLDP_LOC_PORT_DESC_OID = "1.0.8802.1.1.2.1.3.7.1.4"
LLDP_REM_CHASSIS_ID_OID = "1.0.8802.1.1.2.1.4.1.1.5"
LLDP_REM_PORT_ID_OID = "1.0.8802.1.1.2.1.4.1.1.7"
LLDP_REM_PORT_DESC_OID = "1.0.8802.1.1.2.1.4.1.1.8"
LLDP_REM_SYS_NAME_OID = "1.0.8802.1.1.2.1.4.1.1.9"
LLDP_REM_MAN_ADDR_IF_ID_OID = "1.0.8802.1.1.2.1.4.2.1.4"
INTERNET_DEVICE_NAME = "Internet"
INTERNET_DEVICE_HOST = "internet.local"
INTERNET_DEVICE_GROUP = "Internet"
TRAFFIC_POLL_LOCK = threading.Lock()
TRAFFIC_POLL_DEVICES: set[int] = set()


def static_root() -> Path:
    return DIST_PATH if (DIST_PATH / "index.html").exists() else ROOT


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def iso_at(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone().isoformat(timespec="seconds")


def parse_iso_timestamp(value: str) -> float:
    if not value:
        return 0
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return 0


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    with DB_LOCK, db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT 'Unassigned',
                tags TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                snmp_enabled INTEGER NOT NULL DEFAULT 0,
                snmp_community TEXT NOT NULL DEFAULT '',
                snmp_port INTEGER NOT NULL DEFAULT 161,
                status TEXT NOT NULL DEFAULT 'unknown',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS groups (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sensors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                interval_seconds INTEGER NOT NULL DEFAULT 30,
                config_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'unknown',
                last_value TEXT NOT NULL DEFAULT '',
                last_check TEXT NOT NULL DEFAULT '',
                last_error TEXT NOT NULL DEFAULT '',
                next_check_at REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id INTEGER,
                sensor_id INTEGER,
                status TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS topology_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_device_id INTEGER NOT NULL,
                target_device_id INTEGER,
                protocol TEXT NOT NULL DEFAULT 'lldp',
                local_port TEXT NOT NULL DEFAULT '',
                remote_port TEXT NOT NULL DEFAULT '',
                remote_management_ip TEXT NOT NULL DEFAULT '',
                remote_system_name TEXT NOT NULL DEFAULT '',
                remote_chassis_id TEXT NOT NULL DEFAULT '',
                remote_port_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                last_seen TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_device_id) REFERENCES devices(id) ON DELETE CASCADE,
                FOREIGN KEY(target_device_id) REFERENCES devices(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS discovered_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identity_key TEXT NOT NULL UNIQUE,
                source_device_id INTEGER,
                mapped_device_id INTEGER,
                hostname TEXT NOT NULL DEFAULT '',
                management_ip TEXT NOT NULL DEFAULT '',
                chassis_id TEXT NOT NULL DEFAULT '',
                local_port TEXT NOT NULL DEFAULT '',
                remote_port TEXT NOT NULL DEFAULT '',
                remote_port_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'unmanaged',
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_device_id) REFERENCES devices(id) ON DELETE SET NULL,
                FOREIGN KEY(mapped_device_id) REFERENCES devices(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                value_text TEXT NOT NULL,
                value_number REAL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                last_used_at TEXT NOT NULL DEFAULT '',
                expires_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sensor_thresholds (
                sensor_id INTEGER PRIMARY KEY,
                metric TEXT NOT NULL DEFAULT 'value_number',
                warning_operator TEXT NOT NULL DEFAULT '',
                warning_value REAL,
                critical_operator TEXT NOT NULL DEFAULT '',
                critical_value REAL,
                enabled INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sensor_threshold_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id INTEGER NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                severity TEXT NOT NULL,
                metric TEXT NOT NULL,
                direction TEXT NOT NULL,
                mode TEXT NOT NULL,
                percent REAL,
                absolute_mbps REAL,
                label TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS notification_channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notification_deliveries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                event_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                response TEXT NOT NULL DEFAULT '',
                status_code INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE,
                FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sample_rollups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id INTEGER NOT NULL,
                bucket TEXT NOT NULL,
                bucket_start TEXT NOT NULL,
                status TEXT NOT NULL,
                avg_value REAL,
                min_value REAL,
                max_value REAL,
                sample_count INTEGER NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(sensor_id, bucket, bucket_start),
                FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_samples_sensor_created ON samples(sensor_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_samples_created ON samples(created_at);
            CREATE INDEX IF NOT EXISTS idx_sample_rollups_sensor_bucket_start ON sample_rollups(sensor_id, bucket, bucket_start);
            CREATE INDEX IF NOT EXISTS idx_sample_rollups_bucket_start ON sample_rollups(bucket, bucket_start);
            CREATE INDEX IF NOT EXISTS idx_topology_links_source ON topology_links(source_device_id);
            CREATE INDEX IF NOT EXISTS idx_topology_links_target ON topology_links(target_device_id);
            CREATE INDEX IF NOT EXISTS idx_discovered_nodes_status ON discovered_nodes(status);
            CREATE INDEX IF NOT EXISTS idx_discovered_nodes_source ON discovered_nodes(source_device_id);
            """
        )
        ensure_column(connection, "devices", "topology_x", "REAL")
        ensure_column(connection, "devices", "topology_y", "REAL")
        ensure_column(connection, "samples", "meta_json", "TEXT NOT NULL DEFAULT '{}'")
        ensure_column(connection, "topology_links", "remote_management_ip", "TEXT NOT NULL DEFAULT ''")
        sync_groups_from_devices(connection)
        bootstrap_admin_from_env(connection)


def ensure_column(connection: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = [row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt, digest = stored.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations)).hex()
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def row_to_user(row: sqlite3.Row | None) -> dict | None:
    if not row:
        return None
    return {"id": row["id"], "username": row["username"], "role": row["role"], "createdAt": row["created_at"]}


def users_exist(connection: sqlite3.Connection | None = None) -> bool:
    if connection is not None:
        return bool(connection.execute("SELECT 1 FROM users LIMIT 1").fetchone())
    with DB_LOCK, db() as check_connection:
        return users_exist(check_connection)


def auth_setup_required() -> bool:
    if AUTH_DISABLED:
        return False
    return not users_exist()


def bootstrap_admin_from_env(connection: sqlite3.Connection) -> None:
    username = os.environ.get("NETWORK_MANAGER_ADMIN_USER", "").strip()
    password = os.environ.get("NETWORK_MANAGER_ADMIN_PASSWORD", "")
    if not username or not password:
        return
    existing = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if existing:
        return
    created_at = now_iso()
    connection.execute(
        "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)",
        (username, hash_password(password), created_at, created_at),
    )


def create_initial_admin(payload: dict) -> dict:
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or len(password) < 8:
        raise ValueError("Username and a password of at least 8 characters are required.")
    with DB_LOCK, db() as connection:
        if users_exist(connection):
            raise ValueError("Initial setup is already complete.")
        created_at = now_iso()
        cursor = connection.execute(
            "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)",
            (username, hash_password(password), created_at, created_at),
        )
        row = connection.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
    login_payload = create_login_token(row["id"], "browser session")
    return {"ok": True, "user": row_to_user(row), "token": login_payload["token"]}


def create_login_token(user_id: int, name: str) -> dict:
    raw_token = secrets.token_urlsafe(32)
    created_at = now_iso()
    with DB_LOCK, db() as connection:
        connection.execute(
            "INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, name, token_hash(raw_token), created_at),
        )
    return {"token": raw_token}


def login_user(payload: dict) -> dict:
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or not verify_password(password, row["password_hash"]):
        raise ValueError("Invalid username or password.")
    token = create_login_token(int(row["id"]), "browser session")["token"]
    return {"ok": True, "token": token, "user": row_to_user(row)}


def logout_token(token: str) -> dict:
    if token:
        with DB_LOCK, db() as connection:
            connection.execute("DELETE FROM api_tokens WHERE token_hash = ?", (token_hash(token),))
    return {"ok": True}


def authenticate_basic(header: str) -> dict | None:
    try:
        encoded = header.split(" ", 1)[1]
        decoded = base64.b64decode(encoded).decode("utf-8")
        username, password = decoded.split(":", 1)
    except Exception:
        return None
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row and verify_password(password, row["password_hash"]):
        return row_to_user(row)
    return None


def authenticate_bearer(header: str) -> dict | None:
    token = header.split(" ", 1)[1].strip() if " " in header else ""
    if not token:
        return None
    current_time = now_iso()
    with DB_LOCK, db() as connection:
        row = connection.execute(
            """
            SELECT users.*
            FROM api_tokens
            JOIN users ON users.id = api_tokens.user_id
            WHERE api_tokens.token_hash = ?
              AND (api_tokens.expires_at = '' OR api_tokens.expires_at > ?)
            """,
            (token_hash(token), current_time),
        ).fetchone()
        if row:
            connection.execute("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?", (current_time, token_hash(token)))
    return row_to_user(row)


def authenticate_request(headers) -> dict | None:
    if AUTH_DISABLED:
        return {"id": 0, "username": "auth-disabled", "role": "admin", "createdAt": ""}
    authorization = headers.get("Authorization", "")
    if authorization.lower().startswith("basic "):
        return authenticate_basic(authorization)
    if authorization.lower().startswith("bearer "):
        return authenticate_bearer(authorization)
    return None


def list_api_tokens(user_id: int) -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            "SELECT id, name, last_used_at, expires_at, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC",
            (user_id,),
        ).fetchall()
    return [
        {"id": row["id"], "name": row["name"], "lastUsedAt": row["last_used_at"], "expiresAt": row["expires_at"], "createdAt": row["created_at"]}
        for row in rows
    ]


def create_api_token(user_id: int, payload: dict) -> dict:
    raw_token = secrets.token_urlsafe(32)
    name = str(payload.get("name") or "API Token").strip() or "API Token"
    created_at = now_iso()
    with DB_LOCK, db() as connection:
        cursor = connection.execute(
            "INSERT INTO api_tokens (user_id, name, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, name, token_hash(raw_token), str(payload.get("expiresAt") or ""), created_at),
        )
    return {"id": cursor.lastrowid, "name": name, "token": raw_token, "createdAt": created_at}


def delete_api_token(user_id: int, token_id: int) -> dict:
    with DB_LOCK, db() as connection:
        connection.execute("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", (token_id, user_id))
    return {"ok": True}


def row_to_device(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "host": row["host"],
        "group": row["group_name"],
        "tags": [tag.strip() for tag in row["tags"].split(",") if tag.strip()],
        "notes": row["notes"],
        "snmpCommunity": row["snmp_community"],
        "snmpPort": row["snmp_port"],
        "status": row["status"],
        "topologyX": row["topology_x"],
        "topologyY": row["topology_y"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def is_internet_system_device_row(row) -> bool:
    name = clean_snmp_text(row["name"] if isinstance(row, sqlite3.Row) else row.get("name")).lower()
    host = clean_snmp_text(row["host"] if isinstance(row, sqlite3.Row) else row.get("host")).lower()
    group = clean_snmp_text(row["group_name"] if isinstance(row, sqlite3.Row) else row.get("group_name", row.get("group", ""))).lower()
    tags = clean_snmp_text(row["tags"] if isinstance(row, sqlite3.Row) else row.get("tags", "")).lower()
    return (
        name == INTERNET_DEVICE_NAME.lower()
        and (host == INTERNET_DEVICE_HOST.lower() or group == INTERNET_DEVICE_GROUP.lower() or "system" in tags.split(","))
    )


def row_to_topology_link(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "sourceDeviceId": row["source_device_id"],
        "targetDeviceId": row["target_device_id"],
        "protocol": row["protocol"],
        "localPort": row["local_port"],
        "remotePort": row["remote_port"],
        "remoteManagementIp": row["remote_management_ip"],
        "remoteSystemName": row["remote_system_name"],
        "remoteChassisId": row["remote_chassis_id"],
        "remotePortId": row["remote_port_id"],
        "status": row["status"],
        "lastSeen": row["last_seen"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def row_to_discovered_node(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "identityKey": row["identity_key"],
        "sourceDeviceId": row["source_device_id"],
        "sourceDeviceName": row["source_device_name"] if "source_device_name" in row.keys() else "",
        "mappedDeviceId": row["mapped_device_id"],
        "mappedDeviceName": row["mapped_device_name"] if "mapped_device_name" in row.keys() else "",
        "hostname": row["hostname"],
        "managementIp": row["management_ip"],
        "chassisId": row["chassis_id"],
        "localPort": row["local_port"],
        "remotePort": row["remote_port"],
        "remotePortId": row["remote_port_id"],
        "status": row["status"],
        "firstSeen": row["first_seen"],
        "lastSeen": row["last_seen"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def sync_groups_from_devices(connection: sqlite3.Connection) -> None:
    timestamp = now_iso()
    rows = connection.execute("SELECT DISTINCT group_name FROM devices").fetchall()
    for row in rows:
        group_name = row["group_name"] or "Unassigned"
        connection.execute(
            "INSERT OR IGNORE INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)",
            (group_name, timestamp, timestamp),
        )


def get_groups() -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            """
            SELECT groups.name, groups.created_at, groups.updated_at, COUNT(devices.id) AS device_count
            FROM groups
            LEFT JOIN devices ON devices.group_name = groups.name
            GROUP BY groups.name
            ORDER BY groups.name
            """
        ).fetchall()
        return [
            {
                "name": row["name"],
                "deviceCount": row["device_count"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]


def create_group(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Group name is required.")
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)",
            (name, timestamp, timestamp),
        )
        row = connection.execute(
            """
            SELECT groups.name, groups.created_at, groups.updated_at, COUNT(devices.id) AS device_count
            FROM groups
            LEFT JOIN devices ON devices.group_name = groups.name
            WHERE groups.name = ?
            GROUP BY groups.name
            """,
            (name,),
        ).fetchone()
        return {"name": row["name"], "deviceCount": row["device_count"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def row_to_sensor(row: sqlite3.Row) -> dict:
    config = json.loads(row["config_json"] or "{}")
    return {
        "id": row["id"],
        "deviceId": row["device_id"],
        "name": row["name"],
        "type": row["type"],
        "interval": row["interval_seconds"],
        "config": config,
        "status": row["status"],
        "lastValue": row["last_value"],
        "lastCheck": row["last_check"],
        "lastError": row["last_error"],
        "unit": config.get("unit", ""),
        "oid": config.get("oid", ""),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def row_to_event(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "deviceId": row["device_id"],
        "sensorId": row["sensor_id"],
        "status": row["status"],
        "title": row["title"],
        "message": row["message"],
        "createdAt": row["created_at"],
    }


def row_to_sample(row: sqlite3.Row) -> dict:
    meta = json.loads(row["meta_json"] or "{}") if "meta_json" in row.keys() else {}
    return {
        "id": row["id"],
        "sensorId": row["sensor_id"],
        "status": row["status"],
        "valueText": row["value_text"],
        "valueNumber": row["value_number"],
        "meta": meta,
        "createdAt": row["created_at"],
    }


def row_to_rollup_sample(row: sqlite3.Row) -> dict:
    meta = json.loads(row["meta_json"] or "{}")
    in_bps = meta.get("maxInBps")
    out_bps = meta.get("maxOutBps")
    if in_bps is not None or out_bps is not None:
        meta["inBps"] = NumberSafe(in_bps)
        meta["outBps"] = NumberSafe(out_bps)
        value_number = max(NumberSafe(in_bps), NumberSafe(out_bps))
        value_text = f"In {format_bps(NumberSafe(in_bps))} / Out {format_bps(NumberSafe(out_bps))}"
    else:
        value_number = row["avg_value"]
        value_text = "-" if value_number is None else f"{value_number:g}"
    meta["rollup"] = row["bucket"]
    meta["sampleCount"] = row["sample_count"]
    return {
        "id": f"{row['bucket']}:{row['sensor_id']}:{row['bucket_start']}",
        "sensorId": row["sensor_id"],
        "status": row["status"],
        "valueText": value_text,
        "valueNumber": value_number,
        "meta": meta,
        "createdAt": row["bucket_start"],
    }


def NumberSafe(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def format_bps(value: float) -> str:
    current = float(value or 0)
    unit = "bps"
    for candidate in ("Kbps", "Mbps", "Gbps", "Tbps"):
        if abs(current) < 1000:
            break
        current /= 1000
        unit = candidate
    return f"{current:.2f} {unit}"


def default_threshold_metric(sensor_type: str) -> str:
    return "maxBps" if sensor_type == "snmp_traffic" else "value_number"


def row_to_threshold(row: sqlite3.Row | None, sensor_type: str = "") -> dict:
    if not row:
        return {
            "enabled": False,
            "metric": default_threshold_metric(sensor_type),
            "warningOperator": "",
            "warningValue": None,
            "criticalOperator": "",
            "criticalValue": None,
        }
    return {
        "enabled": bool(row["enabled"]),
        "metric": row["metric"],
        "warningOperator": row["warning_operator"],
        "warningValue": row["warning_value"],
        "criticalOperator": row["critical_operator"],
        "criticalValue": row["critical_value"],
        "updatedAt": row["updated_at"],
    }


def get_sensor_threshold(sensor_id: int) -> dict:
    with DB_LOCK, db() as connection:
        sensor = connection.execute("SELECT type FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not sensor:
            raise ValueError("Sensor not found.")
        row = connection.execute("SELECT * FROM sensor_thresholds WHERE sensor_id = ?", (sensor_id,)).fetchone()
    return row_to_threshold(row, sensor["type"])


def save_sensor_threshold(sensor_id: int, payload: dict) -> dict:
    allowed_metrics = {"value_number", "inBps", "outBps", "maxBps"}
    allowed_operators = {"", ">", ">=", "<", "<=", "==", "!="}
    metric = str(payload.get("metric") or "value_number").strip()
    warning_operator = str(payload.get("warningOperator") or payload.get("warning_operator") or "").strip()
    critical_operator = str(payload.get("criticalOperator") or payload.get("critical_operator") or "").strip()
    if metric not in allowed_metrics:
        raise ValueError("Unsupported threshold metric.")
    if warning_operator not in allowed_operators or critical_operator not in allowed_operators:
        raise ValueError("Unsupported threshold operator.")

    def number_or_none(value):
        if value in {"", None}:
            return None
        return float(value)

    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        sensor = connection.execute("SELECT id, type FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not sensor:
            raise ValueError("Sensor not found.")
        connection.execute(
            """
            INSERT INTO sensor_thresholds
              (sensor_id, metric, warning_operator, warning_value, critical_operator, critical_value, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sensor_id) DO UPDATE SET
              metric = excluded.metric,
              warning_operator = excluded.warning_operator,
              warning_value = excluded.warning_value,
              critical_operator = excluded.critical_operator,
              critical_value = excluded.critical_value,
              enabled = excluded.enabled,
              updated_at = excluded.updated_at
            """,
            (
                sensor_id,
                metric,
                warning_operator,
                number_or_none(payload.get("warningValue", payload.get("warning_value"))),
                critical_operator,
                number_or_none(payload.get("criticalValue", payload.get("critical_value"))),
                1 if payload.get("enabled") else 0,
                timestamp,
            ),
        )
        row = connection.execute("SELECT * FROM sensor_thresholds WHERE sensor_id = ?", (sensor_id,)).fetchone()
    return row_to_threshold(row, sensor["type"])


def row_to_threshold_rule(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "sensorId": row["sensor_id"],
        "enabled": bool(row["enabled"]),
        "severity": row["severity"],
        "metric": row["metric"],
        "direction": row["direction"],
        "mode": row["mode"],
        "percent": row["percent"],
        "absoluteMbps": row["absolute_mbps"],
        "label": row["label"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_sensor_threshold_rules(sensor_id: int) -> dict:
    with DB_LOCK, db() as connection:
        sensor = connection.execute("SELECT id, type FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not sensor:
            raise ValueError("Sensor not found.")
        if sensor["type"] != "snmp_traffic":
            raise ValueError("Threshold rules are only available for port traffic sensors.")
        rows = connection.execute(
            "SELECT * FROM sensor_threshold_rules WHERE sensor_id = ? ORDER BY id ASC",
            (sensor_id,),
        ).fetchall()
    return {"rules": [row_to_threshold_rule(row) for row in rows]}


def normalize_threshold_rule(sensor_id: int, payload: dict) -> dict:
    allowed_severities = {"warning", "critical"}
    allowed_metrics = {"maxBps", "inBps", "outBps"}
    allowed_directions = {"above", "below"}
    allowed_modes = {"percent", "absolute_mbps"}
    severity = str(payload.get("severity") or "warning").strip()
    metric = str(payload.get("metric") or "maxBps").strip()
    direction = str(payload.get("direction") or "above").strip()
    mode = str(payload.get("mode") or "percent").strip()
    if severity not in allowed_severities:
        raise ValueError("Threshold rule severity must be warning or critical.")
    if metric not in allowed_metrics:
        raise ValueError("Threshold rule metric must be maxBps, inBps, or outBps.")
    if direction not in allowed_directions:
        raise ValueError("Threshold rule direction must be above or below.")
    if mode not in allowed_modes:
        raise ValueError("Threshold rule mode must be percent or absolute_mbps.")

    percent = payload.get("percent")
    absolute_mbps = payload.get("absoluteMbps", payload.get("absolute_mbps"))
    if mode == "percent":
        if percent in {"", None}:
            raise ValueError("Percent threshold requires a percent value.")
        percent = float(percent)
        if percent < 0 or percent > 100:
            raise ValueError("Percent threshold must be between 0 and 100.")
        absolute_mbps = None
    else:
        if absolute_mbps in {"", None}:
            raise ValueError("Advanced Mbps threshold requires an Mbps value.")
        absolute_mbps = float(absolute_mbps)
        if absolute_mbps < 0:
            raise ValueError("Advanced Mbps threshold must be 0 or higher.")
        percent = None

    return {
        "sensor_id": sensor_id,
        "enabled": 1 if payload.get("enabled", True) else 0,
        "severity": severity,
        "metric": metric,
        "direction": direction,
        "mode": mode,
        "percent": percent,
        "absolute_mbps": absolute_mbps,
        "label": str(payload.get("label") or "").strip(),
    }


def save_sensor_threshold_rules(sensor_id: int, payload: dict) -> dict:
    rules = payload.get("rules")
    if not isinstance(rules, list):
        raise ValueError("Threshold rules payload must include a rules list.")
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        sensor = connection.execute("SELECT id, type FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not sensor:
            raise ValueError("Sensor not found.")
        if sensor["type"] != "snmp_traffic":
            raise ValueError("Threshold rules are only available for port traffic sensors.")
        normalized = [normalize_threshold_rule(sensor_id, item if isinstance(item, dict) else {}) for item in rules]
        connection.execute("DELETE FROM sensor_threshold_rules WHERE sensor_id = ?", (sensor_id,))
        for item in normalized:
            connection.execute(
                """
                INSERT INTO sensor_threshold_rules
                  (sensor_id, enabled, severity, metric, direction, mode, percent, absolute_mbps, label, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["sensor_id"],
                    item["enabled"],
                    item["severity"],
                    item["metric"],
                    item["direction"],
                    item["mode"],
                    item["percent"],
                    item["absolute_mbps"],
                    item["label"],
                    timestamp,
                    timestamp,
                ),
            )
        rows = connection.execute(
            "SELECT * FROM sensor_threshold_rules WHERE sensor_id = ? ORDER BY id ASC",
            (sensor_id,),
        ).fetchall()
    return {"rules": [row_to_threshold_rule(row) for row in rows]}


def threshold_metric_value(metric: str, value_number: float | None, sample_meta: dict) -> float | None:
    if metric == "value_number":
        return value_number
    if metric == "inBps":
        return sample_meta.get("inBps")
    if metric == "outBps":
        return sample_meta.get("outBps")
    if metric == "maxBps":
        values = [sample_meta.get("inBps"), sample_meta.get("outBps")]
        numbers = [float(value) for value in values if value is not None]
        return max(numbers) if numbers else value_number
    return None


def threshold_metric_label(metric: str) -> str:
    return {"maxBps": "Max Traffic", "inBps": "Inbound", "outBps": "Outbound", "value_number": "Value"}.get(metric, metric)


def threshold_rule_limit(rule: dict, sample_meta: dict) -> float | None:
    if rule["mode"] == "absolute_mbps":
        return float(rule["absoluteMbps"] or 0) * 1_000_000
    interface_speed = sample_meta.get("interfaceSpeed")
    if not interface_speed:
        return None
    return float(interface_speed) * float(rule["percent"] or 0) / 100


def threshold_rule_matches(rule: dict, value: float | None, sample_meta: dict) -> tuple[bool, float | None]:
    if not rule["enabled"] or value is None:
        return False, None
    limit = threshold_rule_limit(rule, sample_meta)
    if limit is None:
        return False, None
    if rule["direction"] == "above":
        return float(value) > limit, limit
    return float(value) < limit, limit


def describe_threshold_rule(rule: dict, limit: float | None) -> str:
    severity = "Critical" if rule["severity"] == "critical" else "Warning"
    direction = ">" if rule["direction"] == "above" else "<"
    metric = threshold_metric_label(rule["metric"])
    if rule["mode"] == "absolute_mbps":
        target = f"{rule['absoluteMbps']:.2f} Mbps"
    else:
        target = f"{rule['percent']:.2f}% of {format_bps(limit * 100 / max(float(rule['percent'] or 1), 1))}" if limit is not None else f"{rule['percent']:.2f}% of port speed"
    return f"{severity} threshold breached: {metric} {direction} {target}"


def apply_threshold_rules(sensor_id: int, value_number: float | None, sample_meta: dict) -> tuple[str | None, str]:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            "SELECT * FROM sensor_threshold_rules WHERE sensor_id = ? ORDER BY id ASC",
            (sensor_id,),
        ).fetchall()
    matches = []
    for row in rows:
        rule = row_to_threshold_rule(row)
        metric_value = threshold_metric_value(rule["metric"], value_number, sample_meta)
        matched, limit = threshold_rule_matches(rule, metric_value, sample_meta)
        if matched:
            matches.append((rule, limit))
    critical = next((item for item in matches if item[0]["severity"] == "critical"), None)
    if critical:
        return "down", describe_threshold_rule(critical[0], critical[1])
    warning = next((item for item in matches if item[0]["severity"] == "warning"), None)
    if warning:
        return "warning", describe_threshold_rule(warning[0], warning[1])
    return None, ""


def compare_threshold(value: float | None, operator: str, limit: float | None) -> bool:
    if value is None or limit is None or not operator:
        return False
    value = float(value)
    limit = float(limit)
    if operator == ">":
        return value > limit
    if operator == ">=":
        return value >= limit
    if operator == "<":
        return value < limit
    if operator == "<=":
        return value <= limit
    if operator == "==":
        return value == limit
    if operator == "!=":
        return value != limit
    return False


def apply_threshold(sensor_id: int, sensor_type: str, status: str, value_number: float | None, sample_meta: dict, error: str) -> tuple[str, str]:
    if status not in {"up", "warning"}:
        return status, error
    if sensor_type == "snmp_traffic":
        rule_status, rule_error = apply_threshold_rules(sensor_id, value_number, sample_meta)
        if rule_status:
            return rule_status, rule_error
        return status, error
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM sensor_thresholds WHERE sensor_id = ?", (sensor_id,)).fetchone()
    threshold = row_to_threshold(row, sensor_type)
    if not threshold["enabled"]:
        return status, error
    metric_value = threshold_metric_value(threshold["metric"], value_number, sample_meta)
    if compare_threshold(metric_value, threshold["criticalOperator"], threshold["criticalValue"]):
        return "down", f"Critical threshold breached: {threshold['metric']} {threshold['criticalOperator']} {threshold['criticalValue']}"
    if compare_threshold(metric_value, threshold["warningOperator"], threshold["warningValue"]):
        return "warning", f"Warning threshold breached: {threshold['metric']} {threshold['warningOperator']} {threshold['warningValue']}"
    return status, error


def row_to_notification_channel(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "enabled": bool(row["enabled"]),
        "config": json.loads(row["config_json"] or "{}"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_notification_channels() -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute("SELECT * FROM notification_channels ORDER BY id DESC").fetchall()
    return [row_to_notification_channel(row) for row in rows]


def save_notification_channel(payload: dict, channel_id: int | None = None) -> dict:
    channel_type = str(payload.get("type") or "").strip()
    if channel_type not in {"webhook", "email", "slack_webhook", "teams_webhook"}:
        raise ValueError("Notification channel type must be webhook, email, slack_webhook, or teams_webhook.")
    name = str(payload.get("name") or channel_type).strip() or channel_type
    config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        if channel_id is None:
            cursor = connection.execute(
                "INSERT INTO notification_channels (name, type, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (name, channel_type, 1 if payload.get("enabled", True) else 0, json.dumps(config), timestamp, timestamp),
            )
            channel_id = cursor.lastrowid
        else:
            connection.execute(
                "UPDATE notification_channels SET name = ?, type = ?, enabled = ?, config_json = ?, updated_at = ? WHERE id = ?",
                (name, channel_type, 1 if payload.get("enabled", True) else 0, json.dumps(config), timestamp, channel_id),
            )
        row = connection.execute("SELECT * FROM notification_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        raise ValueError("Notification channel not found.")
    return row_to_notification_channel(row)


def delete_notification_channel(channel_id: int) -> dict:
    with DB_LOCK, db() as connection:
        connection.execute("DELETE FROM notification_channels WHERE id = ?", (channel_id,))
    return {"ok": True}


def list_notification_deliveries(limit: int = 80) -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            """
            SELECT notification_deliveries.*, notification_channels.name AS channel_name, notification_channels.type AS channel_type
            FROM notification_deliveries
            LEFT JOIN notification_channels ON notification_channels.id = notification_deliveries.channel_id
            ORDER BY notification_deliveries.id DESC
            LIMIT ?
            """,
            (min(max(int(limit or 80), 1), 200),),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "channelId": row["channel_id"],
            "channelName": row["channel_name"],
            "channelType": row["channel_type"],
            "eventId": row["event_id"],
            "status": row["status"],
            "response": row["response"],
            "statusCode": row["status_code"],
            "retryCount": row["retry_count"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def notification_payload(event: dict, sensor: dict | None, device: dict | None) -> dict:
    return {
        "event": event,
        "sensor": sensor,
        "device": device,
        "summary": event.get("title") or "NetworkManager alert",
        "message": event.get("message") or "",
    }


def post_json_url(url: str, payload: dict, timeout: float = 5.0) -> tuple[int | None, str]:
    data = json.dumps(payload).encode("utf-8")
    req = urlrequest.Request(url, data=data, headers={"Content-Type": "application/json", "User-Agent": "NetworkManager/1.0"}, method="POST")
    try:
        with urlrequest.urlopen(req, timeout=timeout) as response:
            return response.status, response.read(500).decode("utf-8", errors="replace")
    except urlerror.HTTPError as exc:
        return exc.code, exc.read(500).decode("utf-8", errors="replace")


def deliver_webhook(channel: dict, payload: dict) -> tuple[int | None, str]:
    url = str(channel["config"].get("url") or "").strip()
    if not url:
        raise ValueError("Webhook URL is required.")
    if channel["type"] == "slack_webhook":
        body = {"text": f"*{payload['summary']}*\n{payload['message']}"}
    elif channel["type"] == "teams_webhook":
        body = {"text": f"{payload['summary']}\n{payload['message']}"}
    else:
        body = payload
    return post_json_url(url, body)


def deliver_email(channel: dict, payload: dict) -> tuple[int | None, str]:
    config = channel["config"]
    host = str(config.get("host") or "").strip()
    to_address = str(config.get("to") or "").strip()
    from_address = str(config.get("from") or config.get("username") or "").strip()
    if not host or not to_address or not from_address:
        raise ValueError("Email host, from, and to are required.")
    port = int(config.get("port") or 587)
    message = EmailMessage()
    message["Subject"] = f"NetworkManager: {payload['summary']}"
    message["From"] = from_address
    message["To"] = to_address
    message.set_content(f"{payload['summary']}\n\n{payload['message']}\n\n{json.dumps(payload, indent=2)}")
    username = str(config.get("username") or "").strip()
    password = str(config.get("password") or "")
    use_tls = bool(config.get("useTls", True))
    context = ssl.create_default_context()
    with smtplib.SMTP(host, port, timeout=8) as smtp:
        if use_tls:
            smtp.starttls(context=context)
        if username:
            smtp.login(username, password)
        smtp.send_message(message)
    return None, "sent"


def record_notification_delivery(channel_id: int, event_id: int, status: str, response: str = "", status_code: int | None = None) -> None:
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        connection.execute(
            """
            INSERT INTO notification_deliveries
              (channel_id, event_id, status, response, status_code, retry_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (channel_id, event_id, status, response[:1000], status_code, timestamp, timestamp),
        )


def deliver_notifications_for_event(event_id: int) -> None:
    with DB_LOCK, db() as connection:
        event_row = connection.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        if not event_row:
            return
        sensor_row = connection.execute("SELECT * FROM sensors WHERE id = ?", (event_row["sensor_id"],)).fetchone() if event_row["sensor_id"] else None
        device_row = connection.execute("SELECT * FROM devices WHERE id = ?", (event_row["device_id"],)).fetchone() if event_row["device_id"] else None
        channel_rows = connection.execute("SELECT * FROM notification_channels WHERE enabled = 1 ORDER BY id ASC").fetchall()
    event = row_to_event(event_row)
    sensor = row_to_sensor(sensor_row) if sensor_row else None
    device = row_to_device(device_row) if device_row else None
    payload = notification_payload(event, sensor, device)
    for channel_row in channel_rows:
        channel = row_to_notification_channel(channel_row)
        try:
            if channel["type"] in {"webhook", "slack_webhook", "teams_webhook"}:
                status_code, response = deliver_webhook(channel, payload)
            elif channel["type"] == "email":
                status_code, response = deliver_email(channel, payload)
            else:
                raise ValueError("Unsupported notification channel.")
            delivery_status = "sent" if status_code is None or 200 <= int(status_code) < 300 else "failed"
            record_notification_delivery(channel["id"], event_id, delivery_status, response, status_code)
        except Exception as exc:
            record_notification_delivery(channel["id"], event_id, "failed", str(exc), None)


def clean_snmp_text(value) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1].strip()
    return text


def parse_snmp_int(value) -> int:
    text = clean_snmp_text(value)
    if not text:
        return 0
    match = re.search(r"-?\d+", text)
    if not match:
        return 0
    return int(match.group(0))


def normalize_oid(value) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lstrip("."))


def sensor_duplicate_keys(sensor_type: str, config: dict) -> list[tuple[str, str]]:
    if sensor_type == "snmp":
        oid = normalize_oid(config.get("oid"))
        return [("oid", oid)] if oid else []
    if sensor_type == "snmp_traffic":
        keys = []
        index = str(config.get("index") or "").strip()
        if index:
            keys.append(("traffic-index", index))
        for name in ("speedOid", "inOid", "outOid"):
            oid = normalize_oid(config.get(name))
            if oid:
                keys.append(("oid", oid))
        return keys
    return []


def existing_sensor_keys(connection: sqlite3.Connection, device_id: int) -> dict[tuple[str, str], str]:
    rows = connection.execute(
        "SELECT name, type, config_json FROM sensors WHERE device_id = ? AND type IN ('snmp', 'snmp_traffic')",
        (device_id,),
    ).fetchall()
    keys = {}
    for row in rows:
        config = json.loads(row["config_json"] or "{}")
        for key in sensor_duplicate_keys(row["type"], config):
            keys[key] = row["name"]
    return keys


def duplicate_message(key: tuple[str, str], owner: str | None = None) -> str:
    if key[0] == "traffic-index":
        detail = f" already used by {owner}" if owner else ""
        return f"Duplicate interface index {key[1]} for this device{detail}."
    detail = f" already used by {owner}" if owner else ""
    return f"Duplicate OID {key[1]} for this device{detail}."


def assert_unique_sensor_configs(connection: sqlite3.Connection, device_id: int, configs: list[tuple[str, dict]]) -> None:
    existing = existing_sensor_keys(connection, device_id)
    batch = {}
    for sensor_type, config in configs:
        for key in sensor_duplicate_keys(sensor_type, config):
            if key in existing:
                raise ValueError(duplicate_message(key, existing[key]))
            if key in batch:
                raise ValueError(duplicate_message(key, batch[key]))
            batch[key] = str(config.get("interfaceName") or config.get("oid") or config.get("index") or "this request").strip()


def query_limit_offset(filters: dict, default_limit: int = 500) -> tuple[int, int]:
    limit = min(max(1, int(filters.get("limit") or default_limit)), 1000)
    offset = max(0, int(filters.get("offset") or 0))
    return limit, offset


def query_flag(filters: dict, key: str) -> bool:
    value = str(filters.get(key) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def get_devices(filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    where = []
    params = []
    q = str(filters.get("q") or "").strip()
    status = str(filters.get("status") or "").strip()
    if q:
        where.append("(name LIKE ? OR host LIKE ? OR group_name LIKE ? OR tags LIKE ? OR notes LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like, like, like])
    if status:
        where.append("status = ?")
        params.append(status)
    limit, offset = query_limit_offset(filters)
    sql = "SELECT * FROM devices"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY group_name, name LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with DB_LOCK, db() as connection:
        rows = connection.execute(sql, params).fetchall()
        return [row_to_device(row) for row in rows]


def get_topology_links() -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            """
            SELECT * FROM topology_links
            ORDER BY protocol, source_device_id, local_port, remote_system_name
            """
        ).fetchall()
        return [row_to_topology_link(row) for row in rows]


def get_discovered_nodes(filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    status = str(filters.get("status") or "").strip()
    where = []
    params = []
    if status and status != "all":
        where.append("discovered_nodes.status = ?")
        params.append(status)
    sql = """
        SELECT discovered_nodes.*,
               source.name AS source_device_name,
               mapped.name AS mapped_device_name
        FROM discovered_nodes
        LEFT JOIN devices source ON source.id = discovered_nodes.source_device_id
        LEFT JOIN devices mapped ON mapped.id = discovered_nodes.mapped_device_id
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY discovered_nodes.status, discovered_nodes.last_seen DESC, discovered_nodes.hostname"
    with DB_LOCK, db() as connection:
        rows = connection.execute(sql, params).fetchall()
        return [row_to_discovered_node(row) for row in rows]


def sensor_filter_clause(filters: dict | None = None) -> tuple[str, list]:
    filters = filters or {}
    where = []
    params = []
    q = str(filters.get("q") or "").strip()
    status = str(filters.get("status") or "").strip()
    sensor_type = str(filters.get("type") or "").strip()
    device_id = str(filters.get("deviceId") or filters.get("device_id") or "").strip()
    if q:
        where.append(
            "("
            "sensors.name LIKE ? OR sensors.type LIKE ? OR sensors.last_value LIKE ? OR "
            "sensors.config_json LIKE ? OR devices.name LIKE ? OR devices.host LIKE ? OR devices.group_name LIKE ?"
            ")"
        )
        like = f"%{q}%"
        params.extend([like, like, like, like, like, like, like])
    if status and status != "all":
        where.append("sensors.status = ?")
        params.append(status)
    if sensor_type:
        where.append("sensors.type = ?")
        params.append(sensor_type)
    if device_id:
        where.append("sensors.device_id = ?")
        params.append(int(device_id))
    return (" WHERE " + " AND ".join(where)) if where else "", params


def get_sensors(filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    where_sql, params = sensor_filter_clause(filters)
    limit, offset = query_limit_offset(filters)
    sql = "SELECT sensors.* FROM sensors LEFT JOIN devices ON devices.id = sensors.device_id"
    sql += where_sql
    sql += " ORDER BY sensors.id DESC LIMIT ? OFFSET ?"
    with DB_LOCK, db() as connection:
        rows = connection.execute(sql, [*params, limit, offset]).fetchall()
        return [row_to_sensor(row) for row in rows]


def get_sensors_page(filters: dict | None = None) -> dict:
    filters = filters or {}
    where_sql, params = sensor_filter_clause(filters)
    limit, offset = query_limit_offset(filters)
    base_sql = " FROM sensors LEFT JOIN devices ON devices.id = sensors.device_id" + where_sql
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            "SELECT sensors.*" + base_sql + " ORDER BY sensors.id DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        total = int(connection.execute("SELECT COUNT(*) AS total" + base_sql, params).fetchone()["total"])
        status_rows = connection.execute(
            "SELECT sensors.status AS status, COUNT(*) AS total" + base_sql + " GROUP BY sensors.status",
            params,
        ).fetchall()
    summary = {"up": 0, "warning": 0, "down": 0, "unknown": 0, "paused": 0, "total": total}
    for row in status_rows:
        status = row["status"] if row["status"] in summary else "unknown"
        summary[status] += int(row["total"] or 0)
    return {"items": [row_to_sensor(row) for row in rows], "total": total, "limit": limit, "offset": offset, "summary": summary}


def get_events(limit: int = 80, filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    where = []
    params = []
    status = str(filters.get("status") or "").strip()
    device_id = str(filters.get("deviceId") or filters.get("device_id") or "").strip()
    sensor_id = str(filters.get("sensorId") or filters.get("sensor_id") or "").strip()
    if status:
        where.append("status = ?")
        params.append(status)
    if device_id:
        where.append("device_id = ?")
        params.append(int(device_id))
    if sensor_id:
        where.append("sensor_id = ?")
        params.append(int(sensor_id))
    limit = min(max(1, int(filters.get("limit") or limit or 80)), 500)
    offset = max(0, int(filters.get("offset") or 0))
    sql = "SELECT * FROM events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with DB_LOCK, db() as connection:
        rows = connection.execute(sql, params).fetchall()
        return [row_to_event(row) for row in rows]


def status_severity(status: str) -> int:
    return {"up": 0, "paused": 1, "unknown": 2, "warning": 3, "down": 4}.get(status or "unknown", 2)


def bucket_start_iso(timestamp: float, bucket_seconds: int) -> str:
    return iso_at((int(timestamp) // bucket_seconds) * bucket_seconds)


def aggregate_rollup_items(sensor_id: int, bucket: str, bucket_start: str, items: list[dict]) -> dict | None:
    if not items:
        return None
    sample_count = sum(int(item.get("sampleCount") or 1) for item in items)
    status = max((str(item.get("status") or "unknown") for item in items), key=status_severity)
    numeric_items = [item for item in items if item.get("avgValue") is not None]
    avg_value = None
    min_value = None
    max_value = None
    if numeric_items and sample_count:
        weighted_sum = sum(float(item["avgValue"]) * int(item.get("sampleCount") or 1) for item in numeric_items)
        weighted_count = sum(int(item.get("sampleCount") or 1) for item in numeric_items)
        if weighted_count:
            avg_value = weighted_sum / weighted_count
        min_candidates = [item.get("minValue") for item in numeric_items if item.get("minValue") is not None]
        max_candidates = [item.get("maxValue") for item in numeric_items if item.get("maxValue") is not None]
        min_value = min(min_candidates) if min_candidates else None
        max_value = max(max_candidates) if max_candidates else None
    traffic_items = [item for item in items if item.get("avgInBps") is not None or item.get("avgOutBps") is not None or item.get("maxInBps") is not None or item.get("maxOutBps") is not None]
    meta = {}
    if traffic_items:
        traffic_count = sum(int(item.get("sampleCount") or 1) for item in traffic_items)
        if traffic_count:
            meta["avgInBps"] = sum(NumberSafe(item.get("avgInBps")) * int(item.get("sampleCount") or 1) for item in traffic_items) / traffic_count
            meta["avgOutBps"] = sum(NumberSafe(item.get("avgOutBps")) * int(item.get("sampleCount") or 1) for item in traffic_items) / traffic_count
        meta["maxInBps"] = max(NumberSafe(item.get("maxInBps")) for item in traffic_items)
        meta["maxOutBps"] = max(NumberSafe(item.get("maxOutBps")) for item in traffic_items)
        speeds = [NumberSafe(item.get("interfaceSpeed")) for item in traffic_items if NumberSafe(item.get("interfaceSpeed")) > 0]
        if speeds:
            meta["interfaceSpeed"] = max(speeds)
    return {
        "sensor_id": sensor_id,
        "bucket": bucket,
        "bucket_start": bucket_start,
        "status": status,
        "avg_value": avg_value,
        "min_value": min_value,
        "max_value": max_value,
        "sample_count": sample_count,
        "meta_json": json.dumps(meta),
        "created_at": now_iso(),
    }


def sample_rollup_input(row: sqlite3.Row) -> dict:
    meta = json.loads(row["meta_json"] or "{}") if "meta_json" in row.keys() else {}
    value = row["value_number"]
    in_bps = meta.get("inBps")
    out_bps = meta.get("outBps")
    return {
        "status": row["status"],
        "sampleCount": 1,
        "avgValue": value,
        "minValue": value,
        "maxValue": value,
        "avgInBps": in_bps,
        "maxInBps": in_bps,
        "avgOutBps": out_bps,
        "maxOutBps": out_bps,
        "interfaceSpeed": meta.get("interfaceSpeed"),
    }


def rollup_rollup_input(row: sqlite3.Row) -> dict:
    meta = json.loads(row["meta_json"] or "{}")
    return {
        "status": row["status"],
        "sampleCount": row["sample_count"],
        "avgValue": row["avg_value"],
        "minValue": row["min_value"],
        "maxValue": row["max_value"],
        "avgInBps": meta.get("avgInBps"),
        "maxInBps": meta.get("maxInBps"),
        "avgOutBps": meta.get("avgOutBps"),
        "maxOutBps": meta.get("maxOutBps"),
        "interfaceSpeed": meta.get("interfaceSpeed"),
    }


def upsert_rollups(connection: sqlite3.Connection, rows: list[dict]) -> None:
    for row in rows:
        connection.execute(
            """
            INSERT INTO sample_rollups
                (sensor_id, bucket, bucket_start, status, avg_value, min_value, max_value, sample_count, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sensor_id, bucket, bucket_start) DO UPDATE SET
                status = excluded.status,
                avg_value = excluded.avg_value,
                min_value = excluded.min_value,
                max_value = excluded.max_value,
                sample_count = excluded.sample_count,
                meta_json = excluded.meta_json,
                created_at = excluded.created_at
            """,
            (
                row["sensor_id"],
                row["bucket"],
                row["bucket_start"],
                row["status"],
                row["avg_value"],
                row["min_value"],
                row["max_value"],
                row["sample_count"],
                row["meta_json"],
                row["created_at"],
            ),
        )


def build_sample_rollups(connection: sqlite3.Connection, now_ts: float) -> None:
    cutoff = bucket_start_iso(now_ts, ROLLUP_BUCKET_SECONDS["5m"])
    rows = connection.execute("SELECT * FROM samples WHERE created_at < ? ORDER BY sensor_id, created_at", (cutoff,)).fetchall()
    grouped: dict[tuple[int, str], list[dict]] = {}
    for row in rows:
        bucket_start = bucket_start_iso(parse_iso_timestamp(row["created_at"]), ROLLUP_BUCKET_SECONDS["5m"])
        grouped.setdefault((int(row["sensor_id"]), bucket_start), []).append(sample_rollup_input(row))
    upsert_rollups(connection, [aggregate_rollup_items(sensor_id, "5m", bucket_start, items) for (sensor_id, bucket_start), items in grouped.items() if items])


def build_rollup_from_rollups(connection: sqlite3.Connection, source_bucket: str, target_bucket: str, now_ts: float) -> None:
    cutoff = bucket_start_iso(now_ts, ROLLUP_BUCKET_SECONDS[target_bucket])
    rows = connection.execute(
        "SELECT * FROM sample_rollups WHERE bucket = ? AND bucket_start < ? ORDER BY sensor_id, bucket_start",
        (source_bucket, cutoff),
    ).fetchall()
    grouped: dict[tuple[int, str], list[dict]] = {}
    for row in rows:
        bucket_start = bucket_start_iso(parse_iso_timestamp(row["bucket_start"]), ROLLUP_BUCKET_SECONDS[target_bucket])
        grouped.setdefault((int(row["sensor_id"]), bucket_start), []).append(rollup_rollup_input(row))
    upsert_rollups(connection, [aggregate_rollup_items(sensor_id, target_bucket, bucket_start, items) for (sensor_id, bucket_start), items in grouped.items() if items])


def cleanup_sample_retention(connection: sqlite3.Connection, now_ts: float) -> None:
    connection.execute("DELETE FROM samples WHERE created_at < ?", (iso_at(now_ts - RAW_SAMPLE_RETENTION_SECONDS),))
    for bucket, retention in ROLLUP_RETENTION_SECONDS.items():
        connection.execute("DELETE FROM sample_rollups WHERE bucket = ? AND bucket_start < ?", (bucket, iso_at(now_ts - retention)))


def run_sample_maintenance_once() -> None:
    now_ts = time.time()
    with DB_LOCK, db() as connection:
        build_sample_rollups(connection, now_ts)
        build_rollup_from_rollups(connection, "5m", "1h", now_ts)
        build_rollup_from_rollups(connection, "1h", "1d", now_ts)
        cleanup_sample_retention(connection, now_ts)


def sample_maintenance() -> None:
    while True:
        try:
            run_sample_maintenance_once()
        except Exception:
            pass
        time.sleep(MAINTENANCE_INTERVAL_SECONDS)


def choose_sample_resolution(time_range: str, resolution: str) -> str:
    if resolution == "auto":
        return SAMPLE_AUTO_RESOLUTION[time_range]
    if resolution not in {"raw", "5m", "1h", "1d"}:
        raise ValueError("Unsupported sample resolution.")
    return resolution


def get_sensor_samples(sensor_id: int, limit: int = 80, filters: dict | None = None) -> list[dict]:
    filters = filters or {}
    if "range" in filters or "resolution" in filters:
        time_range = str(filters.get("range") or "1h")
        if time_range not in SAMPLE_RANGE_SECONDS:
            raise ValueError("Unsupported sample range.")
        resolution = choose_sample_resolution(time_range, str(filters.get("resolution") or "auto"))
        start_at = iso_at(time.time() - SAMPLE_RANGE_SECONDS[time_range])
        with DB_LOCK, db() as connection:
            sensor = connection.execute("SELECT id FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
            if not sensor:
                raise ValueError("Sensor not found.")
            if resolution == "raw":
                rows = connection.execute(
                    "SELECT * FROM samples WHERE sensor_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 5000",
                    (sensor_id, start_at),
                ).fetchall()
                return [row_to_sample(row) for row in rows]
            rows = connection.execute(
                """
                SELECT * FROM sample_rollups
                WHERE sensor_id = ? AND bucket = ? AND bucket_start >= ?
                ORDER BY bucket_start ASC
                LIMIT 5000
                """,
                (sensor_id, resolution, start_at),
            ).fetchall()
            return [row_to_rollup_sample(row) for row in rows]
    limit = min(max(1, int(limit or 80)), 240)
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            """
            SELECT * FROM (
                SELECT * FROM samples
                WHERE sensor_id = ?
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC
            """,
            (sensor_id, limit),
        ).fetchall()
        return [row_to_sample(row) for row in rows]


def get_device_traffic_samples(device_id: int, limit: int = 24) -> dict:
    limit = min(max(1, int(limit or 24)), 80)
    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT id FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise ValueError("Device not found.")
        sensors = connection.execute(
            "SELECT id FROM sensors WHERE device_id = ? AND type = 'snmp_traffic' ORDER BY id DESC",
            (device_id,),
        ).fetchall()
        grouped = {}
        for sensor in sensors:
            rows = connection.execute(
                """
                SELECT * FROM (
                    SELECT * FROM samples
                    WHERE sensor_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                )
                ORDER BY id ASC
                """,
                (sensor["id"], limit),
            ).fetchall()
            grouped[str(sensor["id"])] = [row_to_sample(row) for row in rows]
    return {"ok": True, "deviceId": device_id, "limit": limit, "samples": grouped}


def get_summary() -> dict:
    with DB_LOCK, db() as connection:
        device_count = connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
        sensor_count = connection.execute("SELECT COUNT(*) FROM sensors").fetchone()[0]
        status_rows = connection.execute("SELECT status, COUNT(*) AS count FROM sensors GROUP BY status").fetchall()

    summary = {"devices": device_count, "sensors": sensor_count, "up": 0, "warning": 0, "down": 0, "unknown": 0}
    for row in status_rows:
        if row["status"] in summary:
            summary[row["status"]] = row["count"]
    return summary


def discovered_node_row(connection: sqlite3.Connection, node_id: int) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM discovered_nodes WHERE id = ?", (node_id,)).fetchone()
    if not row:
        raise ValueError("Discovered node not found.")
    return row


def get_discovered_node(node_id: int) -> dict:
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            """
            SELECT discovered_nodes.*,
                   source.name AS source_device_name,
                   mapped.name AS mapped_device_name
            FROM discovered_nodes
            LEFT JOIN devices source ON source.id = discovered_nodes.source_device_id
            LEFT JOIN devices mapped ON mapped.id = discovered_nodes.mapped_device_id
            WHERE discovered_nodes.id = ?
            """,
            (node_id,),
        ).fetchall()
        if not rows:
            raise ValueError("Discovered node not found.")
        return row_to_discovered_node(rows[0])


def remove_discovered_topology_link(connection: sqlite3.Connection, node: sqlite3.Row) -> None:
    connection.execute(
        """
        DELETE FROM topology_links
        WHERE protocol = 'lldp'
          AND source_device_id = ?
          AND local_port = ?
          AND remote_system_name = ?
          AND remote_chassis_id = ?
        """,
        (node["source_device_id"], node["local_port"], node["hostname"], node["chassis_id"]),
    )


def create_topology_link_from_discovered(connection: sqlite3.Connection, node: sqlite3.Row, target_device_id: int) -> None:
    if not node["source_device_id"]:
        raise ValueError("Discovered node has no source device.")
    if int(node["source_device_id"]) == int(target_device_id):
        raise ValueError("Cannot map a discovered node to its source device.")
    target = connection.execute("SELECT id FROM devices WHERE id = ?", (target_device_id,)).fetchone()
    if not target:
        raise ValueError("Target device not found.")
    timestamp = now_iso()
    remove_discovered_topology_link(connection, node)
    connection.execute(
        """
        INSERT INTO topology_links
          (source_device_id, target_device_id, protocol, local_port, remote_port, remote_management_ip, remote_system_name,
           remote_chassis_id, remote_port_id, status, last_seen, created_at, updated_at)
        VALUES (?, ?, 'lldp', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        """,
        (
            node["source_device_id"],
            target_device_id,
            node["local_port"],
            node["remote_port"],
            node["management_ip"],
            node["hostname"],
            node["chassis_id"],
            node["remote_port_id"],
            timestamp,
            timestamp,
            timestamp,
        ),
    )


def set_discovered_node_status(node_id: int, status: str) -> dict:
    if status not in {"unmanaged", "ignored"}:
        raise ValueError("Unsupported discovered node status.")
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        node = discovered_node_row(connection, node_id)
        if status == "ignored":
            remove_discovered_topology_link(connection, node)
        connection.execute(
            "UPDATE discovered_nodes SET status = ?, mapped_device_id = NULL, updated_at = ? WHERE id = ?",
            (status, timestamp, node_id),
        )
    return get_discovered_node(node_id)


def map_discovered_node(node_id: int, payload: dict) -> dict:
    target_device_id = int(payload.get("deviceId") or payload.get("device_id") or 0)
    if not target_device_id:
        raise ValueError("deviceId is required.")
    timestamp = now_iso()
    with DB_LOCK, db() as connection:
        node = discovered_node_row(connection, node_id)
        create_topology_link_from_discovered(connection, node, target_device_id)
        connection.execute(
            "UPDATE discovered_nodes SET status = 'mapped', mapped_device_id = ?, updated_at = ? WHERE id = ?",
            (target_device_id, timestamp, node_id),
        )
    return get_discovered_node(node_id)


def promote_discovered_node(node_id: int, payload: dict) -> dict:
    node = get_discovered_node(node_id)
    name = str(payload.get("name") or node.get("hostname") or node.get("managementIp") or node.get("chassisId") or "Discovered Node").strip()
    host = str(payload.get("host") or node.get("managementIp") or "").strip()
    if not host:
        raise ValueError("Host is required to promote this discovered node.")
    device = create_device(
        {
            "name": name,
            "host": host,
            "group": str(payload.get("group") or "Discovered").strip() or "Discovered",
            "tags": str(payload.get("tags") or "lldp,discovered").strip(),
            "notes": str(payload.get("notes") or f"Promoted from LLDP discovered node {node_id}.").strip(),
            "snmpCommunity": str(payload.get("snmpCommunity") or "").strip(),
            "snmpPort": int(payload.get("snmpPort") or 161),
        }
    )
    mapped = map_discovered_node(node_id, {"deviceId": device["id"]})
    return {"ok": True, "device": device, "node": mapped}


def create_device(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()
    host = str(payload.get("host") or "").strip()
    if not name or not host:
        raise ValueError("Device name and host are required.")

    created_at = now_iso()
    group_name = str(payload.get("group") or "Unassigned").strip() or "Unassigned"
    with DB_LOCK, db() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)",
            (group_name, created_at, created_at),
        )
        cursor = connection.execute(
            """
            INSERT INTO devices
              (name, host, group_name, tags, notes, snmp_community, snmp_port, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
            """,
            (
                name,
                host,
                group_name,
                str(payload.get("tags") or "").strip(),
                str(payload.get("notes") or "").strip(),
                str(payload.get("snmpCommunity") or "").strip(),
                int(payload.get("snmpPort") or 161),
                created_at,
                created_at,
            ),
        )
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return row_to_device(row)


def create_sensor(device_id: int, payload: dict) -> dict:
    sensor_type = str(payload.get("type") or "").strip().lower()
    if sensor_type == "ping":
        sensor_type = "icmp"
    if sensor_type not in {"icmp", "snmp", "snmp_traffic", "http"}:
        raise ValueError("Sensor type must be icmp, snmp, snmp_traffic, or http.")

    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not device:
        raise ValueError("Device not found.")

    config = {}
    default_name = "ICMP Ping" if sensor_type == "icmp" else "SNMP Uptime"
    if sensor_type == "snmp":
        oid = str(payload.get("oid") or "1.3.6.1.2.1.1.3.0").strip()
        if not oid:
            raise ValueError("SNMP OID is required.")
        config = {
            "oid": oid,
            "unit": str(payload.get("unit") or "").strip(),
            "community": str(payload.get("community") or device["snmp_community"] or "public").strip(),
            "port": int(payload.get("port") or device["snmp_port"] or 161),
        }
    elif sensor_type == "snmp_traffic":
        index = str(payload.get("index") or "").strip()
        if not index:
            raise ValueError("Interface index is required.")
        default_name = f"Traffic {payload.get('interfaceName') or index}"
        config = {
            "index": index,
            "interfaceName": str(payload.get("interfaceName") or "").strip(),
            "inOid": str(payload.get("inOid") or f"{IF_HC_IN_OID}.{index}").strip(),
            "outOid": str(payload.get("outOid") or f"{IF_HC_OUT_OID}.{index}").strip(),
            "community": str(payload.get("community") or device["snmp_community"] or "public").strip(),
            "port": int(payload.get("port") or device["snmp_port"] or 161),
        }
    elif sensor_type == "http":
        default_name = "HTTP Check"
        url = str(payload.get("url") or f"http://{device['host']}").strip()
        if not url:
            raise ValueError("HTTP URL is required.")
        config = {
            "url": url,
            "method": str(payload.get("method") or "GET").upper(),
            "expectedStatus": int(payload.get("expectedStatus") or 200),
            "timeout": float(payload.get("timeout") or 5),
            "keyword": str(payload.get("keyword") or "").strip(),
            "verifyTls": bool(payload.get("verifyTls", True)),
        }

    created_at = now_iso()
    with DB_LOCK, db() as connection:
        assert_unique_sensor_configs(connection, device_id, [(sensor_type, config)])
        cursor = connection.execute(
            """
            INSERT INTO sensors
              (device_id, name, type, interval_seconds, config_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)
            """,
            (
                device_id,
                str(payload.get("name") or default_name).strip() or default_name,
                sensor_type,
                max(10, int(payload.get("interval") or 30)),
                json.dumps(config),
                created_at,
                created_at,
            ),
        )
        row = connection.execute("SELECT * FROM sensors WHERE id = ?", (cursor.lastrowid,)).fetchone()
    sensor = row_to_sensor(row)
    check_sensor(sensor["id"])
    return get_sensor(sensor["id"])


def create_sensors_bulk(device_id: int, payload: dict) -> dict:
    sensors = payload.get("sensors")
    if not isinstance(sensors, list) or not sensors:
        raise ValueError("Sensors list is required.")
    if len(sensors) > 128:
        raise ValueError("Bulk create is limited to 128 sensors.")

    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise ValueError("Device not found.")

        created_at = now_iso()
        created_ids = []
        configs = []
        for item in sensors:
            if not isinstance(item, dict):
                raise ValueError("Each sensor must be an object.")
            oid = str(item.get("oid") or "").strip()
            if not oid:
                raise ValueError("Every SNMP sensor requires an OID.")
            config = {
                "oid": oid,
                "unit": str(item.get("unit") or "").strip(),
                "community": str(item.get("community") or device["snmp_community"] or "public").strip(),
                "port": int(item.get("port") or device["snmp_port"] or 161),
            }
            configs.append(("snmp", config))
        assert_unique_sensor_configs(connection, device_id, configs)
        for item, (_, config) in zip(sensors, configs):
            cursor = connection.execute(
                """
                INSERT INTO sensors
                  (device_id, name, type, interval_seconds, config_json, status, created_at, updated_at)
                VALUES (?, ?, 'snmp', ?, ?, 'unknown', ?, ?)
                """,
                (
                    device_id,
                    str(item.get("name") or "SNMP Sensor").strip() or "SNMP Sensor",
                    max(10, int(item.get("interval") or 30)),
                    json.dumps(config),
                    created_at,
                    created_at,
                ),
            )
            created_ids.append(cursor.lastrowid)

        rows = connection.execute(
            f"SELECT * FROM sensors WHERE id IN ({','.join('?' for _ in created_ids)}) ORDER BY id DESC",
            created_ids,
        ).fetchall()
        update_device_status(connection, device_id)

    return {"ok": True, "created": len(created_ids), "sensors": [row_to_sensor(row) for row in rows]}


def create_interface_traffic_sensors(device_id: int, payload: dict) -> dict:
    interfaces = payload.get("interfaces")
    if not isinstance(interfaces, list) or not interfaces:
        raise ValueError("Interfaces list is required.")
    if len(interfaces) > 128:
        raise ValueError("Traffic sensor creation is limited to 128 interfaces.")

    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not device:
            raise ValueError("Device not found.")

        created_at = now_iso()
        created_ids = []
        prepared = []
        for item in interfaces:
            if not isinstance(item, dict):
                raise ValueError("Each interface must be an object.")
            index = str(item.get("index") or "").strip()
            if not index:
                raise ValueError("Every interface requires an index.")
            interface_name = str(item.get("name") or item.get("interfaceName") or f"ifIndex {index}").strip()
            interface_description = str(item.get("description") or item.get("interfaceDescription") or "").strip()
            interface_speed = parse_snmp_int(item.get("speedBps") or item.get("interfaceSpeed"))
            config = {
                "index": index,
                "interfaceName": interface_name,
                "interfaceDescription": interface_description,
                "interfaceSpeed": interface_speed,
                "speedOid": str(item.get("speedOid") or f"{IF_SPEED_OID}.{index}").strip(),
                "inOid": str(item.get("inOid") or f"{IF_HC_IN_OID}.{index}").strip(),
                "outOid": str(item.get("outOid") or f"{IF_HC_OUT_OID}.{index}").strip(),
                "community": str(payload.get("community") or item.get("community") or device["snmp_community"] or "public").strip(),
                "port": int(payload.get("port") or item.get("port") or device["snmp_port"] or 161),
            }
            prepared.append((item, interface_name, config))
        assert_unique_sensor_configs(connection, device_id, [("snmp_traffic", config) for _, _, config in prepared])
        for item, interface_name, config in prepared:
            cursor = connection.execute(
                """
                INSERT INTO sensors
                  (device_id, name, type, interval_seconds, config_json, status, created_at, updated_at)
                VALUES (?, ?, 'snmp_traffic', ?, ?, 'unknown', ?, ?)
                """,
                (
                    device_id,
                    str(item.get("sensorName") or f"Traffic {interface_name}").strip() or f"Traffic {interface_name}",
                    max(10, int(payload.get("interval") or item.get("interval") or 30)),
                    json.dumps(config),
                    created_at,
                    created_at,
                ),
            )
            created_ids.append(cursor.lastrowid)

        rows = connection.execute(
            f"SELECT * FROM sensors WHERE id IN ({','.join('?' for _ in created_ids)}) ORDER BY id DESC",
            created_ids,
        ).fetchall()
        update_device_status(connection, device_id)

    return {"ok": True, "created": len(created_ids), "sensors": [row_to_sensor(row) for row in rows]}


def sync_existing_traffic_descriptions(device_id: int, interfaces: list[dict]) -> None:
    metadata = {}
    for item in interfaces:
        index = str(item.get("index") or "").strip()
        if not index:
            continue
        metadata[index] = {
            "description": clean_snmp_text(item.get("description")),
            "interfaceSpeed": parse_snmp_int(item.get("speedBps") or item.get("interfaceSpeed")),
            "speedOid": str(item.get("speedOid") or f"{IF_SPEED_OID}.{index}").strip(),
        }
    if not metadata:
        return

    updated_at = now_iso()
    with DB_LOCK, db() as connection:
        rows = connection.execute(
            "SELECT id, config_json FROM sensors WHERE device_id = ? AND type = 'snmp_traffic'",
            (device_id,),
        ).fetchall()
        for row in rows:
            config = json.loads(row["config_json"] or "{}")
            index = str(config.get("index") or "")
            item = metadata.get(index)
            if not item:
                continue
            changed = False
            description = item.get("description") or ""
            if description and config.get("interfaceDescription") != description:
                config["interfaceDescription"] = description
                changed = True
            interface_speed = int(item.get("interfaceSpeed") or 0)
            if interface_speed and int(config.get("interfaceSpeed") or 0) != interface_speed:
                config["interfaceSpeed"] = interface_speed
                config["speedOid"] = item.get("speedOid") or f"{IF_SPEED_OID}.{index}"
                changed = True
            if changed:
                connection.execute(
                    "UPDATE sensors SET config_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(config), updated_at, row["id"]),
                )


def update_device_topology(device_id: int, payload: dict) -> dict:
    x = float(payload.get("x"))
    y = float(payload.get("y"))
    x = min(95.0, max(5.0, x))
    y = min(92.0, max(8.0, y))
    updated_at = now_iso()
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise ValueError("Device not found.")
        connection.execute(
            "UPDATE devices SET topology_x = ?, topology_y = ?, updated_at = ? WHERE id = ?",
            (x, y, updated_at, device_id),
        )
        updated = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        return row_to_device(updated)


def update_device(device_id: int, payload: dict) -> dict:
    updated_at = now_iso()
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise ValueError("Device not found.")
        name = str(payload.get("name", row["name"]) or "").strip()
        host = str(payload.get("host", row["host"]) or "").strip()
        group_name = str(payload.get("group", row["group_name"]) or "Unassigned").strip() or "Unassigned"
        if not name or not host:
            raise ValueError("Device name and host are required.")
        connection.execute(
            "INSERT OR IGNORE INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)",
            (group_name, updated_at, updated_at),
        )
        connection.execute(
            """
            UPDATE devices
            SET name = ?, host = ?, group_name = ?, tags = ?, notes = ?,
                snmp_community = ?, snmp_port = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                host,
                group_name,
                str(payload.get("tags", row["tags"]) or "").strip(),
                str(payload.get("notes", row["notes"]) or "").strip(),
                str(payload.get("snmpCommunity", row["snmp_community"]) or "").strip(),
                int(payload.get("snmpPort", row["snmp_port"]) or 161),
                updated_at,
                device_id,
            ),
        )
        updated = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        return row_to_device(updated)


def update_device_group(device_id: int, payload: dict) -> dict:
    group_name = str(payload.get("group") or "Unassigned").strip() or "Unassigned"
    updated_at = now_iso()
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise ValueError("Device not found.")
        connection.execute(
            "INSERT OR IGNORE INTO groups (name, created_at, updated_at) VALUES (?, ?, ?)",
            (group_name, updated_at, updated_at),
        )
        connection.execute(
            "UPDATE devices SET group_name = ?, updated_at = ? WHERE id = ?",
            (group_name, updated_at, device_id),
        )
        updated = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        return row_to_device(updated)


def update_sensor(sensor_id: int, payload: dict) -> dict:
    updated_at = now_iso()
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not row:
            raise ValueError("Sensor not found.")
        config = json.loads(row["config_json"] or "{}")
        sensor_type = row["type"]
        if sensor_type == "snmp":
            if "oid" in payload:
                config["oid"] = str(payload.get("oid") or "").strip()
                if not config["oid"]:
                    raise ValueError("SNMP OID is required.")
            for source, target in (("unit", "unit"), ("community", "community"), ("port", "port")):
                if source in payload:
                    config[target] = int(payload[source]) if source == "port" else str(payload[source] or "").strip()
        elif sensor_type == "snmp_traffic":
            for source, target in (("interfaceName", "interfaceName"), ("interfaceDescription", "interfaceDescription"), ("interfaceSpeed", "interfaceSpeed")):
                if source in payload:
                    config[target] = int(payload[source]) if source == "interfaceSpeed" else str(payload[source] or "").strip()
        elif sensor_type == "http":
            for source in ("url", "method", "keyword"):
                if source in payload:
                    config[source] = str(payload[source] or "").strip()
            for source in ("expectedStatus",):
                if source in payload:
                    config[source] = int(payload[source])
            for source in ("timeout",):
                if source in payload:
                    config[source] = float(payload[source])
            if "verifyTls" in payload:
                config["verifyTls"] = bool(payload["verifyTls"])
        name = str(payload.get("name", row["name"]) or "").strip() or row["name"]
        interval = max(10, int(payload.get("interval", row["interval_seconds"]) or row["interval_seconds"]))
        connection.execute(
            "UPDATE sensors SET name = ?, interval_seconds = ?, config_json = ?, updated_at = ? WHERE id = ?",
            (name, interval, json.dumps(config), updated_at, sensor_id),
        )
        updated = connection.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
    return row_to_sensor(updated)


def delete_device(device_id: int) -> dict:
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise ValueError("Device not found.")
        sensor_rows = connection.execute("SELECT id FROM sensors WHERE device_id = ?", (device_id,)).fetchall()
        sensor_ids = [row["id"] for row in sensor_rows]
        for sensor_id in sensor_ids:
            connection.execute("DELETE FROM samples WHERE sensor_id = ?", (sensor_id,))
            connection.execute("DELETE FROM sample_rollups WHERE sensor_id = ?", (sensor_id,))
        connection.execute("DELETE FROM topology_links WHERE source_device_id = ? OR target_device_id = ?", (device_id, device_id))
        connection.execute("DELETE FROM events WHERE device_id = ?", (device_id,))
        connection.execute("DELETE FROM sensors WHERE device_id = ?", (device_id,))
        connection.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    return {"ok": True, "id": device_id}


def delete_group(group_name: str) -> dict:
    with DB_LOCK, db() as connection:
        rows = connection.execute("SELECT id FROM devices WHERE group_name = ?", (group_name,)).fetchall()
        device_ids = [row["id"] for row in rows]
        for device_id in device_ids:
            sensor_rows = connection.execute("SELECT id FROM sensors WHERE device_id = ?", (device_id,)).fetchall()
            for sensor_row in sensor_rows:
                connection.execute("DELETE FROM samples WHERE sensor_id = ?", (sensor_row["id"],))
                connection.execute("DELETE FROM sample_rollups WHERE sensor_id = ?", (sensor_row["id"],))
            connection.execute("DELETE FROM topology_links WHERE source_device_id = ? OR target_device_id = ?", (device_id, device_id))
            connection.execute("DELETE FROM events WHERE device_id = ?", (device_id,))
            connection.execute("DELETE FROM sensors WHERE device_id = ?", (device_id,))
            connection.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        connection.execute("DELETE FROM groups WHERE name = ?", (group_name,))
    return {"ok": True, "group": group_name, "deletedDevices": len(device_ids)}


def get_sensor(sensor_id: int) -> dict:
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not row:
            raise ValueError("Sensor not found.")
        return row_to_sensor(row)


def delete_sensor(sensor_id: int) -> dict:
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        if not row:
            raise ValueError("Sensor not found.")
        device_id = row["device_id"]
        connection.execute("DELETE FROM samples WHERE sensor_id = ?", (sensor_id,))
        connection.execute("DELETE FROM sample_rollups WHERE sensor_id = ?", (sensor_id,))
        connection.execute("DELETE FROM events WHERE sensor_id = ?", (sensor_id,))
        connection.execute("DELETE FROM sensors WHERE id = ?", (sensor_id,))
        update_device_status(connection, device_id)
    return {"ok": True, "id": sensor_id}


def run_icmp_check(host: str) -> tuple[str, str, float | None, str]:
    command = ["ping", "-n", "1", "-w", str(PING_TIMEOUT_MS), host] if os.name == "nt" else ["ping", "-c", "1", "-W", "1", host]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=4)
    except Exception as exc:
        return "down", "Ping failed", None, str(exc)

    output = f"{completed.stdout}\n{completed.stderr}"
    latency_match = re.search(r"(?:time|時間)[=<]\s*(\d+(?:\.\d+)?)\s*ms", output, re.IGNORECASE)
    latency = float(latency_match.group(1)) if latency_match else None
    ok = completed.returncode == 0 and ("TTL=" in output.upper() or latency is not None)
    if ok:
        value = f"{latency:g} ms" if latency is not None else "Reply received"
        return "up", value, latency, ""
    return "down", "No reply", None, output.strip()[-300:]


def run_snmp_check(host: str, community: str, port: int, oid: str, unit: str = "") -> tuple[str, str, float | None, str]:
    try:
        value = snmp_get(host, community or "public", port or 161, oid)
    except Exception as exc:
        return "down", "SNMP timeout/error", None, str(exc)

    value_text = str(value)
    numeric = float(value) if isinstance(value, (int, float)) else None
    if unit and value_text not in {"", "None"}:
        value_text = f"{value_text} {unit}"
    return "up", value_text, numeric, ""


def run_http_check(config: dict) -> tuple[str, str, float | None, str]:
    url = str(config.get("url") or "").strip()
    method = str(config.get("method") or "GET").upper()
    expected_status = int(config.get("expectedStatus") or 200)
    timeout = float(config.get("timeout") or 5)
    keyword = str(config.get("keyword") or "")
    verify_tls = bool(config.get("verifyTls", True))
    if not url:
        return "down", "Missing URL", None, "HTTP URL is required."
    started = time.time()
    try:
        req = urlrequest.Request(url, method=method, headers={"User-Agent": "NetworkManager/1.0"})
        context = ssl._create_unverified_context() if url.lower().startswith("https://") and not verify_tls else None
        with urlrequest.urlopen(req, timeout=timeout, context=context) as response:
            body = response.read(8192).decode("utf-8", errors="replace")
            elapsed_ms = round((time.time() - started) * 1000, 2)
            if response.status != expected_status:
                return "down", f"HTTP {response.status} in {elapsed_ms:.0f} ms", elapsed_ms, f"Expected HTTP {expected_status}."
            if keyword and keyword not in body:
                return "down", f"HTTP {response.status} keyword missing", elapsed_ms, "Expected keyword was not found."
            return "up", f"HTTP {response.status} in {elapsed_ms:.0f} ms", elapsed_ms, ""
    except urlerror.HTTPError as exc:
        elapsed_ms = round((time.time() - started) * 1000, 2)
        status = "up" if exc.code == expected_status and not keyword else "down"
        return status, f"HTTP {exc.code} in {elapsed_ms:.0f} ms", elapsed_ms, "" if status == "up" else str(exc)
    except Exception as exc:
        return "down", "HTTP error", None, str(exc)


def format_bps(value: float) -> str:
    units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"]
    current = max(0.0, float(value))
    unit = units[0]
    for unit in units:
        if current < 1000 or unit == units[-1]:
            break
        current /= 1000
    return f"{current:.2f} {unit}"


def counter_delta(previous: int, current: int, bits: int = 64) -> int:
    if current >= previous:
        return current - previous
    return (2**bits - previous) + current


def run_snmp_traffic_check(
    host: str,
    community: str,
    port: int,
    config: dict,
) -> tuple[str, str, float | None, str, dict, dict]:
    in_oid = str(config.get("inOid") or "").strip()
    out_oid = str(config.get("outOid") or "").strip()
    if not in_oid or not out_oid:
        return "down", "Traffic OIDs missing", None, "Traffic OIDs missing", config, {}

    try:
        in_counter = int(snmp_get(host, community or "public", port or 161, in_oid))
        out_counter = int(snmp_get(host, community or "public", port or 161, out_oid))
    except Exception as exc:
        return "down", "SNMP traffic timeout/error", None, str(exc), config, {}

    interface_description = str(config.get("interfaceDescription") or "").strip()
    index = str(config.get("index") or "").strip()
    if not interface_description and index:
        try:
            alias = clean_snmp_text(snmp_get(host, community or "public", port or 161, f"{IF_ALIAS_OID}.{index}"))
            if alias:
                interface_description = alias
        except Exception:
            interface_description = ""
    interface_speed = parse_snmp_int(config.get("interfaceSpeed"))
    if not interface_speed and index:
        try:
            interface_speed = parse_snmp_int(snmp_get(host, community or "public", port or 161, f"{IF_SPEED_OID}.{index}"))
        except Exception:
            interface_speed = 0

    checked_at = time.time()
    previous_in = config.get("lastInCounter")
    previous_out = config.get("lastOutCounter")
    previous_at = config.get("lastCounterAt")
    next_config = {
        **config,
        "interfaceDescription": interface_description,
        "interfaceSpeed": interface_speed,
        "speedOid": str(config.get("speedOid") or (f"{IF_SPEED_OID}.{index}" if index else "")).strip(),
        "lastInCounter": in_counter,
        "lastOutCounter": out_counter,
        "lastCounterAt": checked_at,
    }

    if previous_in is None or previous_out is None or previous_at is None:
        meta = {"inBps": 0, "outBps": 0, "inCounter": in_counter, "outCounter": out_counter, "interfaceSpeed": interface_speed}
        return "up", "Baseline captured", 0, "", next_config, meta

    elapsed = max(1.0, checked_at - float(previous_at))
    in_bps = (counter_delta(int(previous_in), in_counter) * 8) / elapsed
    out_bps = (counter_delta(int(previous_out), out_counter) * 8) / elapsed
    value_text = f"In {format_bps(in_bps)} / Out {format_bps(out_bps)}"
    meta = {
        "inBps": round(in_bps, 2),
        "outBps": round(out_bps, 2),
        "inCounter": in_counter,
        "outCounter": out_counter,
        "interfaceSpeed": interface_speed,
        "elapsed": round(elapsed, 2),
    }
    return "up", value_text, max(in_bps, out_bps), "", next_config, meta


def record_sensor_result(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    status: str,
    value_text: str,
    value_number: float | None,
    error: str,
    next_config: dict,
    sample_meta: dict,
    checked_at: str,
) -> int | None:
    previous = row["status"]
    connection.execute(
        """
        UPDATE sensors
        SET status = ?, last_value = ?, last_check = ?, last_error = ?, next_check_at = ?, updated_at = ?, config_json = ?
        WHERE id = ?
        """,
        (
            status,
            value_text,
            checked_at,
            error,
            time.time() + int(row["interval_seconds"]),
            checked_at,
            json.dumps(next_config),
            row["id"],
        ),
    )
    connection.execute(
        "INSERT INTO samples (sensor_id, status, value_text, value_number, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
        (row["id"], status, value_text, value_number, checked_at, json.dumps(sample_meta)),
    )
    if previous == status:
        return None
    cursor = connection.execute(
        """
        INSERT INTO events (device_id, sensor_id, status, title, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            row["device_id"],
            row["id"],
            status,
            f"{row['name']} is {statusLabels(status)}",
            error or value_text,
            checked_at,
        ),
    )
    return cursor.lastrowid


def acquire_traffic_poll(device_id: int) -> bool:
    with TRAFFIC_POLL_LOCK:
        if device_id in TRAFFIC_POLL_DEVICES:
            return False
        TRAFFIC_POLL_DEVICES.add(device_id)
        return True


def release_traffic_poll(device_id: int) -> None:
    with TRAFFIC_POLL_LOCK:
        TRAFFIC_POLL_DEVICES.discard(device_id)


def traffic_sensor_result_from_counters(row: sqlite3.Row, in_counter: int | None, out_counter: int | None) -> tuple[str, str, float | None, str, dict, dict]:
    config = json.loads(row["config_json"] or "{}")
    index = str(config.get("index") or "").strip()
    if not index:
        return "down", "Interface index missing", None, "Traffic interface index missing", config, {}
    if in_counter is None or out_counter is None:
        return "down", "Traffic counters missing", None, f"SNMP counters missing for interface index {index}.", config, {}

    checked_at = time.time()
    previous_in = config.get("lastInCounter")
    previous_out = config.get("lastOutCounter")
    previous_at = config.get("lastCounterAt")
    interface_speed = parse_snmp_int(config.get("interfaceSpeed"))
    next_config = {
        **config,
        "lastInCounter": int(in_counter),
        "lastOutCounter": int(out_counter),
        "lastCounterAt": checked_at,
    }
    if interface_speed:
        next_config["interfaceSpeed"] = interface_speed

    if previous_in is None or previous_out is None or previous_at is None:
        meta = {"inBps": 0, "outBps": 0, "inCounter": int(in_counter), "outCounter": int(out_counter), "interfaceSpeed": interface_speed}
        return "up", "Baseline captured", 0, "", next_config, meta

    elapsed = max(1.0, checked_at - float(previous_at))
    in_bps = (counter_delta(int(previous_in), int(in_counter)) * 8) / elapsed
    out_bps = (counter_delta(int(previous_out), int(out_counter)) * 8) / elapsed
    value_text = f"In {format_bps(in_bps)} / Out {format_bps(out_bps)}"
    meta = {
        "inBps": round(in_bps, 2),
        "outBps": round(out_bps, 2),
        "inCounter": int(in_counter),
        "outCounter": int(out_counter),
        "interfaceSpeed": interface_speed,
        "elapsed": round(elapsed, 2),
    }
    return "up", value_text, max(in_bps, out_bps), "", next_config, meta


def mark_traffic_sensors_failed(device_id: int, rows: list[sqlite3.Row], message: str) -> list[int]:
    checked_at = now_iso()
    event_ids = []
    with DB_LOCK, db() as connection:
        for row in rows:
            config = json.loads(row["config_json"] or "{}")
            event_id = record_sensor_result(connection, row, "down", "SNMP walk failed", None, message, config, {}, checked_at)
            if event_id:
                event_ids.append(event_id)
        update_device_status(connection, device_id)
    return event_ids


def check_device_traffic_sensors(device_id: int, sensor_ids: list[int] | None = None, include_due: bool = False) -> list[dict]:
    if not acquire_traffic_poll(device_id):
        return [get_sensor(sensor_id) for sensor_id in (sensor_ids or [])]
    event_ids = []
    try:
        with DB_LOCK, db() as connection:
            device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
            if not device:
                raise ValueError("Device not found.")
            params: list[object] = [device_id]
            sql = "SELECT * FROM sensors WHERE device_id = ? AND type = 'snmp_traffic'"
            if sensor_ids and include_due:
                placeholders = ",".join("?" for _ in sensor_ids)
                sql += f" AND (id IN ({placeholders}) OR next_check_at <= ?)"
                params.extend(sensor_ids)
                params.append(time.time())
            elif sensor_ids:
                placeholders = ",".join("?" for _ in sensor_ids)
                sql += f" AND id IN ({placeholders})"
                params.extend(sensor_ids)
            else:
                sql += " AND next_check_at <= ?"
                params.append(time.time())
            sql += " ORDER BY id ASC"
            rows = connection.execute(sql, params).fetchall()
        if not rows:
            return []

        community = str(device["snmp_community"] or "public").strip()
        port = int(device["snmp_port"] or 161)
        try:
            in_counters = snmp_walk_table(device["host"], community, port, IF_HC_IN_OID, SNMP_TABLE_WALK_LIMIT)
            out_counters = snmp_walk_table(device["host"], community, port, IF_HC_OUT_OID, SNMP_TABLE_WALK_LIMIT)
        except Exception as exc:
            event_ids = mark_traffic_sensors_failed(device_id, rows, f"SNMP walk failure: {exc}")
            return [get_sensor(row["id"]) for row in rows]

        results = []
        for row in rows:
            config = json.loads(row["config_json"] or "{}")
            index = str(config.get("index") or "").strip()
            status, value_text, value_number, error, next_config, sample_meta = traffic_sensor_result_from_counters(
                row,
                in_counters.get(index),
                out_counters.get(index),
            )
            status, threshold_error = apply_threshold(row["id"], row["type"], status, value_number, sample_meta, error)
            if threshold_error:
                error = threshold_error
            results.append((row, status, value_text, value_number, error, next_config, sample_meta))

        checked_at = now_iso()
        with DB_LOCK, db() as connection:
            for row, status, value_text, value_number, error, next_config, sample_meta in results:
                event_id = record_sensor_result(connection, row, status, value_text, value_number, error, next_config, sample_meta, checked_at)
                if event_id:
                    event_ids.append(event_id)
            update_device_status(connection, device_id)
        return [get_sensor(row["id"]) for row in rows]
    finally:
        release_traffic_poll(device_id)
        for event_id in event_ids:
            threading.Thread(target=deliver_notifications_for_event, args=(event_id,), daemon=True).start()


def check_sensor(sensor_id: int) -> dict:
    with DB_LOCK, db() as connection:
        row = connection.execute(
            """
            SELECT sensors.*, devices.host, devices.snmp_community, devices.snmp_port
            FROM sensors
            JOIN devices ON devices.id = sensors.device_id
            WHERE sensors.id = ?
            """,
            (sensor_id,),
        ).fetchone()

    if not row:
        raise ValueError("Sensor not found.")

    if row["type"] == "snmp_traffic":
        if row["last_check"]:
            try:
                last_check = datetime.fromisoformat(row["last_check"])
                if (datetime.now(timezone.utc).astimezone() - last_check).total_seconds() < 2:
                    return get_sensor(sensor_id)
            except Exception:
                pass
        checked = check_device_traffic_sensors(row["device_id"], [sensor_id], include_due=True)
        return checked[0] if checked else get_sensor(sensor_id)

    config = json.loads(row["config_json"] or "{}")
    if row["type"] == "icmp":
        status, value_text, value_number, error = run_icmp_check(row["host"])
        next_config = config
        sample_meta = {}
    elif row["type"] == "snmp":
        status, value_text, value_number, error = run_snmp_check(
            row["host"],
            config.get("community") or row["snmp_community"] or "public",
            int(config.get("port") or row["snmp_port"] or 161),
            config.get("oid") or "1.3.6.1.2.1.1.3.0",
            config.get("unit") or "",
        )
        next_config = config
        sample_meta = {}
    elif row["type"] == "snmp_traffic":
        status, value_text, value_number, error, next_config, sample_meta = run_snmp_traffic_check(
            row["host"],
            config.get("community") or row["snmp_community"] or "public",
            int(config.get("port") or row["snmp_port"] or 161),
            config,
        )
    elif row["type"] == "http":
        status, value_text, value_number, error = run_http_check(config)
        next_config = config
        sample_meta = {}
    else:
        status, value_text, value_number, error = "unknown", "Unsupported sensor", None, "Unsupported sensor type"
        next_config = config
        sample_meta = {}

    status, threshold_error = apply_threshold(row["id"], row["type"], status, value_number, sample_meta, error)
    if threshold_error:
        error = threshold_error
    checked_at = now_iso()
    event_id = None
    with DB_LOCK, db() as connection:
        previous = connection.execute("SELECT status FROM sensors WHERE id = ?", (sensor_id,)).fetchone()["status"]
        connection.execute(
            """
            UPDATE sensors
            SET status = ?, last_value = ?, last_check = ?, last_error = ?, next_check_at = ?, updated_at = ?, config_json = ?
            WHERE id = ?
            """,
            (
                status,
                value_text,
                checked_at,
                error,
                time.time() + int(row["interval_seconds"]),
                checked_at,
                json.dumps(next_config),
                sensor_id,
            ),
        )
        connection.execute(
            "INSERT INTO samples (sensor_id, status, value_text, value_number, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
            (sensor_id, status, value_text, value_number, checked_at, json.dumps(sample_meta)),
        )
        if previous != status:
            cursor = connection.execute(
                """
                INSERT INTO events (device_id, sensor_id, status, title, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["device_id"],
                    sensor_id,
                    status,
                    f"{row['name']} is {statusLabels(status)}",
                    error or value_text,
                    checked_at,
                ),
            )
            event_id = cursor.lastrowid
        update_device_status(connection, row["device_id"])

    if event_id:
        threading.Thread(target=deliver_notifications_for_event, args=(event_id,), daemon=True).start()

    return get_sensor(sensor_id)


def statusLabels(status: str) -> str:
    return {"up": "Up", "warning": "Warning", "down": "Critical", "unknown": "Unknown"}.get(status, status)


def update_device_status(connection: sqlite3.Connection, device_id: int) -> None:
    rows = connection.execute("SELECT status FROM sensors WHERE device_id = ?", (device_id,)).fetchall()
    statuses = [row["status"] for row in rows]
    if not statuses:
        status = "unknown"
    elif "down" in statuses:
        status = "down"
    elif "warning" in statuses:
        status = "warning"
    elif all(item == "up" for item in statuses):
        status = "up"
    else:
        status = "unknown"
    connection.execute("UPDATE devices SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), device_id))


def scheduler() -> None:
    while True:
        try:
            with DB_LOCK, db() as connection:
                non_traffic_rows = connection.execute(
                    """
                    SELECT id FROM sensors
                    WHERE next_check_at <= ? AND type != 'snmp_traffic'
                    ORDER BY next_check_at ASC
                    LIMIT ?
                    """,
                    (time.time(), SENSOR_BATCH_LIMIT),
                ).fetchall()
                traffic_rows = connection.execute(
                    """
                    SELECT id, device_id FROM sensors
                    WHERE next_check_at <= ? AND type = 'snmp_traffic'
                    ORDER BY next_check_at ASC
                    """,
                    (time.time(),),
                ).fetchall()
            for row in non_traffic_rows:
                check_sensor(row["id"])
            grouped: dict[int, list[int]] = {}
            for row in traffic_rows:
                device_id = int(row["device_id"])
                if device_id not in grouped and len(grouped) >= TRAFFIC_DEVICE_BATCH_LIMIT:
                    continue
                grouped.setdefault(device_id, []).append(int(row["id"]))
            for device_id, sensor_ids in grouped.items():
                check_device_traffic_sensors(device_id, sensor_ids)
        except Exception:
            pass
        time.sleep(3)


def encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    data = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(data)]) + data


def tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + encode_length(len(value)) + value


def encode_integer(value: int) -> bytes:
    if value == 0:
        data = b"\x00"
    else:
        data = value.to_bytes((value.bit_length() + 7) // 8, "big")
        if data[0] & 0x80:
            data = b"\x00" + data
    return tlv(0x02, data)


def encode_octet_string(value: str) -> bytes:
    return tlv(0x04, value.encode("utf-8"))


def encode_null() -> bytes:
    return tlv(0x05, b"")


def encode_oid(oid: str) -> bytes:
    parts = [int(part) for part in oid.strip(".").split(".")]
    if len(parts) < 2:
        raise ValueError("Invalid OID.")
    encoded = bytes([parts[0] * 40 + parts[1]])
    for part in parts[2:]:
        stack = [part & 0x7F]
        part >>= 7
        while part:
            stack.append(0x80 | (part & 0x7F))
            part >>= 7
        encoded += bytes(reversed(stack))
    return tlv(0x06, encoded)


def make_snmp_get_request(community: str, oid: str) -> bytes:
    return make_snmp_request(community, oid, 0xA0)


def make_snmp_get_next_request(community: str, oid: str) -> bytes:
    return make_snmp_request(community, oid, 0xA1)


def make_snmp_request(community: str, oid: str, pdu_tag: int) -> bytes:
    request_id = random.randint(1, 2_147_483_647)
    varbind = tlv(0x30, encode_oid(oid) + encode_null())
    varbind_list = tlv(0x30, varbind)
    pdu = tlv(pdu_tag, encode_integer(request_id) + encode_integer(0) + encode_integer(0) + varbind_list)
    return tlv(0x30, encode_integer(1) + encode_octet_string(community) + pdu)


def read_tlv(data: bytes, offset: int = 0) -> tuple[int, bytes, int]:
    tag = data[offset]
    offset += 1
    first = data[offset]
    offset += 1
    if first & 0x80:
        size = first & 0x7F
        length = int.from_bytes(data[offset : offset + size], "big")
        offset += size
    else:
        length = first
    value = data[offset : offset + length]
    return tag, value, offset + length


def decode_oid(value: bytes) -> str:
    if not value:
        return ""
    first = value[0]
    parts = [first // 40, first % 40]
    current = 0
    for byte in value[1:]:
        current = (current << 7) | (byte & 0x7F)
        if not (byte & 0x80):
            parts.append(current)
            current = 0
    return ".".join(str(part) for part in parts)


def decode_int(value: bytes, signed: bool = False) -> int:
    return int.from_bytes(value, "big", signed=signed)


def decode_snmp_value(tag: int, value: bytes):
    if tag == 0x02:
        return decode_int(value, signed=True)
    if tag == 0x04:
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    if tag == 0x05:
        return None
    if tag == 0x06:
        return decode_oid(value)
    if tag == 0x40:
        return ".".join(str(part) for part in value)
    if tag in {0x41, 0x42, 0x43, 0x46}:
        return decode_int(value)
    if tag in {0x80, 0x81, 0x82}:
        raise ValueError("No such SNMP object/instance.")
    return value.hex()


def snmp_get(host: str, community: str, port: int, oid: str):
    request = make_snmp_get_request(community, oid)
    _, value = snmp_request(host, port, request)
    return value


def snmp_get_next(host: str, community: str, port: int, oid: str) -> tuple[str, object]:
    request = make_snmp_get_next_request(community, oid)
    return snmp_request(host, port, request)


def snmp_request(host: str, port: int, request: bytes) -> tuple[str, object]:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(SNMP_TIMEOUT_SECONDS)
        sock.sendto(request, (host, port))
        response, _ = sock.recvfrom(65535)

    tag, message, _ = read_tlv(response)
    if tag != 0x30:
        raise ValueError("Invalid SNMP response.")

    offset = 0
    _, _, offset = read_tlv(message, offset)
    _, _, offset = read_tlv(message, offset)
    pdu_tag, pdu, _ = read_tlv(message, offset)
    if pdu_tag != 0xA2:
        raise ValueError("Invalid SNMP response PDU.")

    pdu_offset = 0
    _, _, pdu_offset = read_tlv(pdu, pdu_offset)
    _, error_status, pdu_offset = read_tlv(pdu, pdu_offset)
    _, _, pdu_offset = read_tlv(pdu, pdu_offset)
    if decode_int(error_status) != 0:
        raise ValueError(f"SNMP error status {decode_int(error_status)}.")

    _, varbind_list, _ = read_tlv(pdu, pdu_offset)
    _, varbind, _ = read_tlv(varbind_list, 0)
    vb_offset = 0
    _, response_oid, vb_offset = read_tlv(varbind, vb_offset)
    value_tag, value, _ = read_tlv(varbind, vb_offset)
    return decode_oid(response_oid), decode_snmp_value(value_tag, value)


def oid_parts(oid: str) -> list[int]:
    try:
        parts = [int(part) for part in oid.strip(".").split(".") if part != ""]
    except ValueError as exc:
        raise ValueError("Invalid OID.") from exc
    if len(parts) < 2:
        raise ValueError("Invalid OID.")
    return parts


def is_child_oid(base_oid: str, oid: str) -> bool:
    base = oid_parts(base_oid)
    candidate = oid_parts(oid)
    return len(candidate) > len(base) and candidate[: len(base)] == base


def oid_index(base_oid: str, oid: str) -> str:
    base = oid_parts(base_oid)
    candidate = oid_parts(oid)
    return ".".join(str(part) for part in candidate[len(base) :])


def snmp_walk(host: str, community: str, port: int, base_oid: str, limit: int = SNMP_WALK_LIMIT) -> list[dict]:
    oid_parts(base_oid)
    current_oid = base_oid
    items = []
    limit = min(max(1, int(limit or SNMP_WALK_LIMIT)), SNMP_TABLE_WALK_LIMIT)

    for _ in range(limit):
        next_oid, value = snmp_get_next(host, community, port, current_oid)
        if not is_child_oid(base_oid, next_oid):
            break
        if items and items[-1]["oid"] == next_oid:
            break
        items.append(
            {
                "oid": next_oid,
                "index": oid_index(base_oid, next_oid),
                "value": "" if value is None else str(value),
            }
        )
        current_oid = next_oid
    return items


def snmp_walk_table(host: str, community: str, port: int, base_oid: str, limit: int = SNMP_TABLE_WALK_LIMIT) -> dict[str, int]:
    rows = snmp_walk(host, community, port, base_oid, limit)
    table = {}
    for item in rows:
        index = str(item.get("index") or "").strip()
        if not index:
            continue
        table[index] = parse_snmp_int(item.get("value"))
    return table


def discover_snmp_walk(device_id: int, payload: dict) -> dict:
    base_oid = str(payload.get("baseOid") or payload.get("oid") or "").strip()
    if not base_oid:
        raise ValueError("Discovery base OID is required.")

    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not device:
        raise ValueError("Device not found.")

    community = str(payload.get("community") or device["snmp_community"] or "public").strip()
    port = int(payload.get("port") or device["snmp_port"] or 161)
    limit = int(payload.get("limit") or SNMP_WALK_LIMIT)
    items = snmp_walk(device["host"], community, port, base_oid, limit)
    return {"ok": True, "baseOid": base_oid, "count": len(items), "items": items}


def lldp_table(host: str, community: str, port: int, oid: str, limit: int) -> dict[str, str]:
    rows = snmp_walk(host, community, port, oid, limit)
    return {str(item.get("index") or "").strip(): clean_snmp_text(item.get("value")) for item in rows if str(item.get("index") or "").strip()}


def lldp_remote_key(index: str) -> str:
    parts = [part for part in str(index or "").split(".") if part]
    return ".".join(parts[:3]) if len(parts) >= 3 else ""


def lldp_management_address_from_index(index: str) -> tuple[str, str]:
    try:
        parts = [int(part) for part in str(index or "").split(".") if part != ""]
    except ValueError:
        return "", ""
    if len(parts) < 5:
        return "", ""
    remote_key = ".".join(str(part) for part in parts[:3])
    subtype = parts[3]
    remainder = parts[4:]
    candidates = []
    if remainder and 0 < remainder[0] <= len(remainder) - 1:
        candidates.append(remainder[1 : 1 + remainder[0]])
    candidates.append(remainder)
    for octets in candidates:
        try:
            if subtype == 1 and len(octets) >= 4:
                return remote_key, ".".join(str(part) for part in octets[:4])
            if subtype == 2 and len(octets) >= 16:
                return remote_key, str(ipaddress.IPv6Address(bytes(octets[:16])))
        except ValueError:
            continue
    return remote_key, ""


def lldp_management_addresses(host: str, community: str, port: int, limit: int) -> dict[str, str]:
    rows = snmp_walk(host, community, port, LLDP_REM_MAN_ADDR_IF_ID_OID, limit)
    addresses = {}
    for item in rows:
        remote_key, address = lldp_management_address_from_index(str(item.get("index") or ""))
        if remote_key and address and remote_key not in addresses:
            addresses[remote_key] = address
    return addresses


def lldp_local_port_index(remote_index: str) -> str:
    parts = [part for part in str(remote_index or "").split(".") if part]
    return parts[-2] if len(parts) >= 3 else ""


def discovery_keys(value) -> set[str]:
    text = clean_snmp_text(value).lower()
    if not text:
        return set()
    keys = {text}
    hostname = text.rstrip(".")
    is_ip_address = False
    try:
        ipaddress.ip_address(hostname)
        is_ip_address = True
    except ValueError:
        is_ip_address = False
    if hostname and hostname != text:
        keys.add(hostname)
    if "." in hostname and not is_ip_address:
        short_hostname = hostname.split(".", 1)[0]
        if short_hostname:
            keys.add(short_hostname)
    compact = re.sub(r"[^a-z0-9]", "", text)
    if compact:
        keys.add(compact)
    return keys


def snmp_hostname_aliases(connection: sqlite3.Connection) -> dict[int, list[str]]:
    rows = connection.execute(
        """
        SELECT device_id, name, last_value, config_json
        FROM sensors
        WHERE type = 'snmp'
        """
    ).fetchall()
    aliases: dict[int, list[str]] = {}
    for row in rows:
        try:
            config = json.loads(row["config_json"] or "{}")
        except json.JSONDecodeError:
            config = {}
        oid = clean_snmp_text(config.get("oid")).lower()
        name = clean_snmp_text(row["name"]).lower()
        value = clean_snmp_text(row["last_value"])
        if not value or value in {"-", "None"}:
            continue
        is_hostname_sensor = (
            oid == "1.3.6.1.2.1.1.5.0"
            or "sysname" in name
            or "system name" in name
            or "hostname" in name
        )
        if is_hostname_sensor:
            aliases.setdefault(int(row["device_id"]), []).append(value)
    return aliases


def device_match_index(rows: list[sqlite3.Row], source_device_id: int, snmp_aliases: dict[int, list[str]] | None = None) -> dict[str, int]:
    index = {}
    snmp_aliases = snmp_aliases or {}
    for row in rows:
        if int(row["id"]) == int(source_device_id) or is_internet_system_device_row(row):
            continue
        aliases = [row["name"], row["host"]]
        aliases.extend([tag.strip() for tag in str(row["tags"] or "").split(",") if tag.strip()])
        aliases.extend(snmp_aliases.get(int(row["id"]), []))
        if row["notes"]:
            aliases.append(row["notes"])
        for value in aliases:
            for key in discovery_keys(value):
                index[key] = int(row["id"])
    return index


def match_device_id(match_index: dict[str, int], *candidates) -> int | None:
    for candidate in candidates:
        for key in discovery_keys(candidate):
            if key in match_index:
                return match_index[key]
    return None


def discovered_identity_key(neighbor: dict) -> str:
    management_ip = clean_snmp_text(neighbor.get("remoteManagementIp") or neighbor.get("managementIp"))
    chassis_id = clean_snmp_text(neighbor.get("remoteChassisId") or neighbor.get("chassisId"))
    hostname = clean_snmp_text(neighbor.get("remoteSystemName") or neighbor.get("hostname"))
    source_device_id = clean_snmp_text(neighbor.get("sourceDeviceId"))
    local_port = clean_snmp_text(neighbor.get("localPort"))
    remote_port = clean_snmp_text(neighbor.get("remotePortId") or neighbor.get("remotePort"))
    if management_ip:
        return f"ip:{management_ip.lower()}"
    if chassis_id:
        return f"chassis:{re.sub(r'[^a-z0-9]', '', chassis_id.lower())}"
    hostname_key = sorted(discovery_keys(hostname), key=lambda item: (len(item), item))[0] if discovery_keys(hostname) else ""
    if hostname_key:
        return f"host:{hostname_key}"
    return f"link:{source_device_id}:{local_port.lower()}:{remote_port.lower()}"


def discovered_nodes_by_identity(connection: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    rows = connection.execute("SELECT * FROM discovered_nodes").fetchall()
    return {row["identity_key"]: row for row in rows}


def upsert_discovered_node(connection: sqlite3.Connection, neighbor: dict, timestamp: str | None = None) -> sqlite3.Row:
    timestamp = timestamp or now_iso()
    identity_key = discovered_identity_key(neighbor)
    existing = connection.execute("SELECT * FROM discovered_nodes WHERE identity_key = ?", (identity_key,)).fetchone()
    status = existing["status"] if existing and existing["status"] in {"ignored", "mapped"} else "unmanaged"
    mapped_device_id = existing["mapped_device_id"] if existing and existing["status"] == "mapped" else None
    if existing:
        connection.execute(
            """
            UPDATE discovered_nodes
            SET source_device_id = ?, hostname = ?, management_ip = ?, chassis_id = ?,
                local_port = ?, remote_port = ?, remote_port_id = ?, status = ?,
                mapped_device_id = ?, last_seen = ?, updated_at = ?
            WHERE identity_key = ?
            """,
            (
                neighbor.get("sourceDeviceId"),
                clean_snmp_text(neighbor.get("remoteSystemName")),
                clean_snmp_text(neighbor.get("remoteManagementIp")),
                clean_snmp_text(neighbor.get("remoteChassisId")),
                clean_snmp_text(neighbor.get("localPort")),
                clean_snmp_text(neighbor.get("remotePort")),
                clean_snmp_text(neighbor.get("remotePortId")),
                status,
                mapped_device_id,
                timestamp,
                timestamp,
                identity_key,
            ),
        )
    else:
        connection.execute(
            """
            INSERT INTO discovered_nodes
              (identity_key, source_device_id, mapped_device_id, hostname, management_ip, chassis_id,
               local_port, remote_port, remote_port_id, status, first_seen, last_seen, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'unmanaged', ?, ?, ?, ?)
            """,
            (
                identity_key,
                neighbor.get("sourceDeviceId"),
                clean_snmp_text(neighbor.get("remoteSystemName")),
                clean_snmp_text(neighbor.get("remoteManagementIp")),
                clean_snmp_text(neighbor.get("remoteChassisId")),
                clean_snmp_text(neighbor.get("localPort")),
                clean_snmp_text(neighbor.get("remotePort")),
                clean_snmp_text(neighbor.get("remotePortId")),
                timestamp,
                timestamp,
                timestamp,
                timestamp,
            ),
        )
    return connection.execute("SELECT * FROM discovered_nodes WHERE identity_key = ?", (identity_key,)).fetchone()


def snmp_sensor_profiles(connection: sqlite3.Connection, device_id: int) -> list[dict]:
    rows = connection.execute(
        "SELECT config_json FROM sensors WHERE device_id = ? AND type IN ('snmp', 'snmp_traffic') ORDER BY id ASC",
        (device_id,),
    ).fetchall()
    profiles = []
    for row in rows:
        try:
            config = json.loads(row["config_json"] or "{}")
        except json.JSONDecodeError:
            continue
        profiles.append(config)
    return profiles


def lldp_discovery_credentials(device: sqlite3.Row, profiles: list[dict], payload: dict) -> tuple[str, int]:
    profile_with_community = next((profile for profile in profiles if clean_snmp_text(profile.get("community"))), {})
    profile_with_port = next((profile for profile in profiles if profile.get("port")), {})
    community = clean_snmp_text(payload.get("community") or device["snmp_community"] or profile_with_community.get("community") or "public")
    port = int(payload.get("port") or device["snmp_port"] or profile_with_port.get("port") or 161)
    return community, port


def lldp_discovery_candidates(connection: sqlite3.Connection, payload: dict | None = None) -> list[sqlite3.Row]:
    payload = payload or {}
    rows = connection.execute("SELECT * FROM devices ORDER BY name").fetchall()
    sensor_rows = connection.execute(
        "SELECT DISTINCT device_id FROM sensors WHERE type IN ('snmp', 'snmp_traffic')"
    ).fetchall()
    devices_with_snmp_sensors = {int(row["device_id"]) for row in sensor_rows}
    candidates = []
    payload_has_profile = bool(clean_snmp_text(payload.get("community")) or payload.get("port"))
    for row in rows:
        if is_internet_system_device_row(row):
            continue
        has_device_profile = bool(clean_snmp_text(row["snmp_community"]) or int(row["snmp_port"] or 161) != 161)
        has_snmp_sensor = int(row["id"]) in devices_with_snmp_sensors
        if payload_has_profile or has_device_profile or has_snmp_sensor:
            candidates.append(row)
    return candidates


def discover_lldp_topology(device_id: int, payload: dict | None = None) -> dict:
    payload = payload or {}
    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        devices = connection.execute("SELECT * FROM devices").fetchall()
        profiles = snmp_sensor_profiles(connection, device_id) if device else []
        snmp_aliases = snmp_hostname_aliases(connection)
        discovered_map = discovered_nodes_by_identity(connection)
    if not device:
        raise ValueError("Device not found.")
    if is_internet_system_device_row(device):
        return {
            "ok": True,
            "deviceId": int(device_id),
            "sourceDeviceName": device["name"],
            "count": 0,
            "matched": 0,
            "unmatched": 0,
            "neighbors": [],
            "unmatchedNeighbors": [],
            "links": [],
            "skipped": True,
        }

    community, port = lldp_discovery_credentials(device, profiles, payload)
    limit = int(payload.get("limit") or SNMP_TABLE_WALK_LIMIT)
    host = device["host"]

    local_ids = lldp_table(host, community, port, LLDP_LOC_PORT_ID_OID, limit)
    local_desc = lldp_table(host, community, port, LLDP_LOC_PORT_DESC_OID, limit)
    rem_chassis = lldp_table(host, community, port, LLDP_REM_CHASSIS_ID_OID, limit)
    rem_port_ids = lldp_table(host, community, port, LLDP_REM_PORT_ID_OID, limit)
    rem_port_desc = lldp_table(host, community, port, LLDP_REM_PORT_DESC_OID, limit)
    rem_names = lldp_table(host, community, port, LLDP_REM_SYS_NAME_OID, limit)
    try:
        rem_management = lldp_management_addresses(host, community, port, limit)
    except Exception:
        rem_management = {}

    match_index = device_match_index(devices, device_id, snmp_aliases)
    devices_by_id = {int(row["id"]): row for row in devices}
    keys = sorted(set(rem_chassis) | set(rem_port_ids) | set(rem_port_desc) | set(rem_names) | set(rem_management))
    timestamp = now_iso()
    links = []
    for key in keys:
        local_port_number = lldp_local_port_index(key)
        remote_system_name = clean_snmp_text(rem_names.get(key))
        remote_chassis_id = clean_snmp_text(rem_chassis.get(key))
        remote_port_id = clean_snmp_text(rem_port_ids.get(key))
        remote_port = clean_snmp_text(rem_port_desc.get(key)) or remote_port_id
        remote_management_ip = clean_snmp_text(rem_management.get(key))
        local_port = clean_snmp_text(local_ids.get(local_port_number)) or clean_snmp_text(local_desc.get(local_port_number)) or local_port_number
        target_device_id = match_device_id(match_index, remote_management_ip, remote_system_name, remote_chassis_id)
        discovery_probe = {
            "sourceDeviceId": int(device_id),
            "localPort": local_port,
            "remotePort": remote_port,
            "remotePortId": remote_port_id,
            "remoteSystemName": remote_system_name,
            "remoteManagementIp": remote_management_ip,
            "remoteChassisId": remote_chassis_id,
        }
        discovered_identity = discovered_identity_key(discovery_probe)
        discovered_existing = discovered_map.get(discovered_identity)
        if not target_device_id and discovered_existing and discovered_existing["status"] == "mapped" and discovered_existing["mapped_device_id"]:
            target_device_id = int(discovered_existing["mapped_device_id"])
        target_device = devices_by_id.get(int(target_device_id)) if target_device_id else None
        if not remote_system_name and not remote_chassis_id and not remote_port and not remote_management_ip:
            continue
        links.append(
            {
                "sourceDeviceId": int(device_id),
                "sourceDeviceName": device["name"],
                "sourceHost": device["host"],
                "targetDeviceId": target_device_id,
                "targetDeviceName": target_device["name"] if target_device else "",
                "targetHost": target_device["host"] if target_device else "",
                "protocol": "lldp",
                "localPort": local_port,
                "remotePort": remote_port,
                "remoteManagementIp": remote_management_ip,
                "remoteSystemName": remote_system_name,
                "remoteChassisId": remote_chassis_id,
                "remotePortId": remote_port_id,
                "discoveredNodeId": discovered_existing["id"] if discovered_existing else None,
                "discoveredNodeStatus": discovered_existing["status"] if discovered_existing else "",
                "identityKey": discovered_identity,
                "unmatchedReason": "" if target_device_id else "not_found_in_devices",
                "status": "active",
                "lastSeen": timestamp,
            }
        )

    with DB_LOCK, db() as connection:
        connection.execute("DELETE FROM topology_links WHERE source_device_id = ? AND protocol = 'lldp'", (device_id,))
        for link in links:
            if link.get("targetDeviceId"):
                connection.execute(
                    """
                    INSERT INTO topology_links
                      (source_device_id, target_device_id, protocol, local_port, remote_port, remote_management_ip, remote_system_name,
                       remote_chassis_id, remote_port_id, status, last_seen, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        link["sourceDeviceId"],
                        link["targetDeviceId"],
                        link["protocol"],
                        link["localPort"],
                        link["remotePort"],
                        link["remoteManagementIp"],
                        link["remoteSystemName"],
                        link["remoteChassisId"],
                        link["remotePortId"],
                        link["status"],
                        timestamp,
                        timestamp,
                        timestamp,
                    ),
                )
            else:
                discovered = upsert_discovered_node(connection, link, timestamp)
                link["discoveredNodeId"] = discovered["id"]
                link["discoveredNodeStatus"] = discovered["status"]
        rows = connection.execute("SELECT * FROM topology_links WHERE source_device_id = ? AND protocol = 'lldp'", (device_id,)).fetchall()

    persisted = [row_to_topology_link(row) for row in rows]
    unmatched_neighbors = [link for link in links if not link.get("targetDeviceId")]
    return {
        "ok": True,
        "deviceId": int(device_id),
        "sourceDeviceName": device["name"],
        "count": len(persisted),
        "matched": len([link for link in persisted if link.get("targetDeviceId")]),
        "unmatched": len([link for link in persisted if not link.get("targetDeviceId")]),
        "neighbors": links,
        "unmatchedNeighbors": unmatched_neighbors,
        "links": persisted,
    }


def discover_all_lldp_topology(payload: dict | None = None) -> dict:
    payload = payload or {}
    with DB_LOCK, db() as connection:
        rows = lldp_discovery_candidates(connection, payload)
    results = []
    errors = []
    for row in rows:
        try:
            results.append(discover_lldp_topology(int(row["id"]), payload))
        except Exception as exc:
            errors.append({"deviceId": int(row["id"]), "error": str(exc)})
    unmatched_neighbors = []
    for result in results:
        unmatched_neighbors.extend(result.get("unmatchedNeighbors") or [])
    matched = sum(int(result.get("matched") or 0) for result in results)
    unmatched = len(unmatched_neighbors)
    scanned = len(rows)
    return {
        "ok": not errors,
        "devices": scanned,
        "results": results,
        "errors": errors,
        "unmatchedNeighbors": unmatched_neighbors,
        "summary": {
            "scanned": scanned,
            "matched": matched,
            "unmatched": unmatched,
            "errors": len(errors),
        },
        "links": get_topology_links(),
    }


def discover_interface_traffic(device_id: int, payload: dict) -> dict:
    with DB_LOCK, db() as connection:
        device = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
    if not device:
        raise ValueError("Device not found.")

    community = str(payload.get("community") or device["snmp_community"] or "public").strip()
    port = int(payload.get("port") or device["snmp_port"] or 161)
    name_oid = str(payload.get("nameOid") or IF_DESCR_OID).strip()
    limit = int(payload.get("limit") or SNMP_WALK_LIMIT)
    rows = snmp_walk(device["host"], community, port, name_oid, limit)
    try:
        alias_rows = snmp_walk(device["host"], community, port, IF_ALIAS_OID, limit)
        aliases = {item["index"]: clean_snmp_text(item["value"]) for item in alias_rows if item.get("index") and item.get("value")}
    except Exception:
        aliases = {}
    try:
        speed_rows = snmp_walk(device["host"], community, port, IF_SPEED_OID, limit)
        speeds = {item["index"]: parse_snmp_int(item.get("value")) for item in speed_rows if item.get("index")}
    except Exception:
        speeds = {}
    interfaces = [
        {
            "index": item["index"],
            "name": item["value"] or f"ifIndex {item['index']}",
            "description": aliases.get(item["index"], ""),
            "speedBps": speeds.get(item["index"], 0),
            "nameOid": item["oid"],
            "descriptionOid": f"{IF_ALIAS_OID}.{item['index']}",
            "speedOid": f"{IF_SPEED_OID}.{item['index']}",
            "inOid": f"{IF_HC_IN_OID}.{item['index']}",
            "outOid": f"{IF_HC_OUT_OID}.{item['index']}",
        }
        for item in rows
        if item.get("index")
    ]
    sync_existing_traffic_descriptions(device_id, interfaces)
    return {"ok": True, "count": len(interfaces), "interfaces": interfaces}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(static_root()), **kwargs)

    def log_message(self, format: str, *args) -> None:
        return

    def public_api_path(self, path: str) -> bool:
        return path in {"/api/auth/login", "/api/auth/logout", "/api/auth/setup", "/api/auth/me"}

    def require_api_auth(self, path: str) -> bool:
        if not path.startswith("/api/") or self.public_api_path(path):
            self.current_user = authenticate_request(self.headers)
            return True
        user = authenticate_request(self.headers)
        if user:
            self.current_user = user
            return True
        return False

    def auth_token_from_header(self) -> str:
        authorization = self.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            return authorization.split(" ", 1)[1].strip()
        return ""

    def send_auth_required(self) -> None:
        self.send_response(401)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        payload = json.dumps({"error": "Authentication required.", "setupRequired": auth_setup_required()}).encode("utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if not self.require_api_auth(path):
            return self.send_auth_required()
        query = {key: values[-1] for key, values in parse_qs(parsed_url.query).items()}
        try:
            if path == "/api/auth/me":
                user = getattr(self, "current_user", None)
                return self.send_json({"authenticated": bool(user), "user": user, "setupRequired": auth_setup_required(), "authDisabled": AUTH_DISABLED})
            if path == "/api/summary":
                return self.send_json(get_summary())
            if path == "/api/devices":
                return self.send_json(get_devices(query))
            if path == "/api/groups":
                return self.send_json(get_groups())
            if path == "/api/topology/links":
                return self.send_json(get_topology_links())
            if path == "/api/discovered-nodes":
                return self.send_json(get_discovered_nodes(query))
            if path == "/api/sensors":
                if query_flag(query, "includeTotal"):
                    return self.send_json(get_sensors_page(query))
                return self.send_json(get_sensors(query))
            if path == "/api/events":
                return self.send_json(get_events(filters=query))
            if path == "/api/tokens":
                return self.send_json(list_api_tokens(int(self.current_user["id"])))
            if path == "/api/notification-channels":
                return self.send_json(list_notification_channels())
            if path == "/api/notification-deliveries":
                return self.send_json(list_notification_deliveries(int(query.get("limit") or 80)))
            match = re.fullmatch(r"/api/sensors/(\d+)/samples", path)
            if match:
                return self.send_json(get_sensor_samples(int(match.group(1)), filters=query))
            match = re.fullmatch(r"/api/sensors/(\d+)/thresholds", path)
            if match:
                return self.send_json(get_sensor_threshold(int(match.group(1))))
            match = re.fullmatch(r"/api/sensors/(\d+)/threshold-rules", path)
            if match:
                return self.send_json(get_sensor_threshold_rules(int(match.group(1))))
            match = re.fullmatch(r"/api/devices/(\d+)/traffic-samples", path)
            if match:
                limit = int(query.get("limit") or 24)
                return self.send_json(get_device_traffic_samples(int(match.group(1)), limit))
            if path == "/api/snmp/templates":
                return self.send_json(
                    [
                        {"name": "SNMP Uptime", "oid": "1.3.6.1.2.1.1.3.0", "unit": "ticks"},
                        {"name": "System Description", "oid": "1.3.6.1.2.1.1.1.0", "unit": ""},
                    ]
                )
        except Exception as exc:
            return self.send_error_json(str(exc), 500)
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not self.require_api_auth(path):
            return self.send_auth_required()
        try:
            payload = self.read_json()
            if path == "/api/auth/setup":
                return self.send_json(create_initial_admin(payload), 201)
            if path == "/api/auth/login":
                return self.send_json(login_user(payload))
            if path == "/api/auth/logout":
                return self.send_json(logout_token(self.auth_token_from_header()))
            if path == "/api/tokens":
                return self.send_json(create_api_token(int(self.current_user["id"]), payload), 201)
            if path == "/api/notification-channels":
                return self.send_json(save_notification_channel(payload), 201)
            if path == "/api/devices":
                return self.send_json(create_device(payload), 201)
            if path == "/api/groups":
                return self.send_json(create_group(payload), 201)
            if path == "/api/topology/discover":
                return self.send_json(discover_all_lldp_topology(payload))
            match = re.fullmatch(r"/api/discovered-nodes/(\d+)/ignore", path)
            if match:
                return self.send_json(set_discovered_node_status(int(match.group(1)), "ignored"))
            match = re.fullmatch(r"/api/discovered-nodes/(\d+)/unignore", path)
            if match:
                return self.send_json(set_discovered_node_status(int(match.group(1)), "unmanaged"))
            match = re.fullmatch(r"/api/discovered-nodes/(\d+)/map", path)
            if match:
                return self.send_json(map_discovered_node(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/discovered-nodes/(\d+)/promote", path)
            if match:
                return self.send_json(promote_discovered_node(int(match.group(1)), payload), 201)
            match = re.fullmatch(r"/api/devices/(\d+)/sensors", path)
            if match:
                return self.send_json(create_sensor(int(match.group(1)), payload), 201)
            match = re.fullmatch(r"/api/devices/(\d+)/sensors/bulk", path)
            if match:
                return self.send_json(create_sensors_bulk(int(match.group(1)), payload), 201)
            match = re.fullmatch(r"/api/devices/(\d+)/interfaces/traffic-sensors", path)
            if match:
                return self.send_json(create_interface_traffic_sensors(int(match.group(1)), payload), 201)
            match = re.fullmatch(r"/api/devices/(\d+)/snmp/walk", path)
            if match:
                return self.send_json(discover_snmp_walk(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/devices/(\d+)/interfaces/discover", path)
            if match:
                return self.send_json(discover_interface_traffic(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/devices/(\d+)/topology/discover", path)
            if match:
                return self.send_json(discover_lldp_topology(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/devices/(\d+)/topology", path)
            if match:
                return self.send_json(update_device_topology(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/devices/(\d+)/group", path)
            if match:
                return self.send_json(update_device_group(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/sensors/(\d+)/check-now", path)
            if match:
                return self.send_json(check_sensor(int(match.group(1))))
            if path == "/api/snmp/test":
                value = snmp_get(
                    str(payload.get("host") or ""),
                    str(payload.get("community") or "public"),
                    int(payload.get("port") or 161),
                    str(payload.get("oid") or "1.3.6.1.2.1.1.3.0"),
                )
                return self.send_json({"ok": True, "value": value})
        except ValueError as exc:
            return self.send_error_json(str(exc), 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)
        return self.send_error_json("Not found", 404)

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        if not self.require_api_auth(path):
            return self.send_auth_required()
        try:
            payload = self.read_json()
            match = re.fullmatch(r"/api/devices/(\d+)", path)
            if match:
                return self.send_json(update_device(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/sensors/(\d+)", path)
            if match:
                return self.send_json(update_sensor(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/notification-channels/(\d+)", path)
            if match:
                return self.send_json(save_notification_channel(payload, int(match.group(1))))
        except ValueError as exc:
            return self.send_error_json(str(exc), 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)
        return self.send_error_json("Not found", 404)

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if not self.require_api_auth(path):
            return self.send_auth_required()
        try:
            payload = self.read_json()
            match = re.fullmatch(r"/api/sensors/(\d+)/thresholds", path)
            if match:
                return self.send_json(save_sensor_threshold(int(match.group(1)), payload))
            match = re.fullmatch(r"/api/sensors/(\d+)/threshold-rules", path)
            if match:
                return self.send_json(save_sensor_threshold_rules(int(match.group(1)), payload))
        except ValueError as exc:
            return self.send_error_json(str(exc), 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)
        return self.send_error_json("Not found", 404)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if not self.require_api_auth(path):
            return self.send_auth_required()
        try:
            match = re.fullmatch(r"/api/tokens/(\d+)", path)
            if match:
                return self.send_json(delete_api_token(int(self.current_user["id"]), int(match.group(1))))
            match = re.fullmatch(r"/api/notification-channels/(\d+)", path)
            if match:
                return self.send_json(delete_notification_channel(int(match.group(1))))
            match = re.fullmatch(r"/api/sensors/(\d+)", path)
            if match:
                return self.send_json(delete_sensor(int(match.group(1))))
            match = re.fullmatch(r"/api/devices/(\d+)", path)
            if match:
                return self.send_json(delete_device(int(match.group(1))))
            match = re.fullmatch(r"/api/groups/(.+)", path)
            if match:
                return self.send_json(delete_group(unquote(path.split("/api/groups/", 1)[1])))
        except ValueError as exc:
            return self.send_error_json(str(exc), 404)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)
        return self.send_error_json("Not found", 404)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, payload, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, message: str, status: int) -> None:
        self.send_json({"error": message}, status)


def main() -> None:
    init_db()
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=sample_maintenance, daemon=True).start()
    server = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), Handler)
    display_host = "127.0.0.1" if HTTP_HOST in {"", "0.0.0.0"} else HTTP_HOST
    print(f"NetworkManager running at http://{display_host}:{HTTP_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
