from __future__ import annotations

import json
import os
import random
import re
import socket
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "network-manager.sqlite"
DB_LOCK = threading.Lock()
PING_TIMEOUT_MS = 1200
SNMP_TIMEOUT_SECONDS = 2.0
SNMP_WALK_LIMIT = 128
IF_DESCR_OID = "1.3.6.1.2.1.2.2.1.2"
IF_SPEED_OID = "1.3.6.1.2.1.2.2.1.5"
IF_ALIAS_OID = "1.3.6.1.2.1.31.1.1.1.18"
IF_HC_IN_OID = "1.3.6.1.2.1.31.1.1.1.6"
IF_HC_OUT_OID = "1.3.6.1.2.1.31.1.1.1.10"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


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

            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                value_text TEXT NOT NULL,
                value_number REAL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
            );
            """
        )
        ensure_column(connection, "devices", "topology_x", "REAL")
        ensure_column(connection, "devices", "topology_y", "REAL")
        ensure_column(connection, "samples", "meta_json", "TEXT NOT NULL DEFAULT '{}'")
        sync_groups_from_devices(connection)


def ensure_column(connection: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = [row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def row_to_device(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "host": row["host"],
        "group": row["group_name"],
        "tags": [tag.strip() for tag in row["tags"].split(",") if tag.strip()],
        "notes": row["notes"],
        "snmpEnabled": bool(row["snmp_enabled"]),
        "snmpCommunity": row["snmp_community"],
        "snmpPort": row["snmp_port"],
        "status": row["status"],
        "topologyX": row["topology_x"],
        "topologyY": row["topology_y"],
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


def get_devices() -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute("SELECT * FROM devices ORDER BY group_name, name").fetchall()
        return [row_to_device(row) for row in rows]


def get_sensors() -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute("SELECT * FROM sensors ORDER BY id DESC").fetchall()
        return [row_to_sensor(row) for row in rows]


def get_events(limit: int = 80) -> list[dict]:
    with DB_LOCK, db() as connection:
        rows = connection.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [row_to_event(row) for row in rows]


def get_sensor_samples(sensor_id: int, limit: int = 80) -> list[dict]:
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
              (name, host, group_name, tags, notes, snmp_enabled, snmp_community, snmp_port, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
            """,
            (
                name,
                host,
                group_name,
                str(payload.get("tags") or "").strip(),
                str(payload.get("notes") or "").strip(),
                1 if payload.get("snmpEnabled") else 0,
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
    if sensor_type not in {"icmp", "snmp", "snmp_traffic"}:
        raise ValueError("Sensor type must be icmp, snmp, or snmp_traffic.")

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


def delete_device(device_id: int) -> dict:
    with DB_LOCK, db() as connection:
        row = connection.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row:
            raise ValueError("Device not found.")
        sensor_rows = connection.execute("SELECT id FROM sensors WHERE device_id = ?", (device_id,)).fetchall()
        sensor_ids = [row["id"] for row in sensor_rows]
        for sensor_id in sensor_ids:
            connection.execute("DELETE FROM samples WHERE sensor_id = ?", (sensor_id,))
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
    else:
        status, value_text, value_number, error = "unknown", "Unsupported sensor", None, "Unsupported sensor type"
        next_config = config
        sample_meta = {}

    checked_at = now_iso()
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
            connection.execute(
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
        update_device_status(connection, row["device_id"])

    return get_sensor(sensor_id)


def statusLabels(status: str) -> str:
    return {"up": "Up", "warning": "Warning", "down": "Down", "unknown": "Unknown"}.get(status, status)


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
                rows = connection.execute(
                    "SELECT id FROM sensors WHERE next_check_at <= ? ORDER BY next_check_at ASC LIMIT 8",
                    (time.time(),),
                ).fetchall()
            for row in rows:
                check_sensor(row["id"])
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
    limit = min(max(1, int(limit or SNMP_WALK_LIMIT)), SNMP_WALK_LIMIT)

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
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        try:
            if path == "/api/summary":
                return self.send_json(get_summary())
            if path == "/api/devices":
                return self.send_json(get_devices())
            if path == "/api/groups":
                return self.send_json(get_groups())
            if path == "/api/sensors":
                return self.send_json(get_sensors())
            if path == "/api/events":
                return self.send_json(get_events())
            match = re.fullmatch(r"/api/sensors/(\d+)/samples", path)
            if match:
                return self.send_json(get_sensor_samples(int(match.group(1))))
            match = re.fullmatch(r"/api/devices/(\d+)/traffic-samples", path)
            if match:
                query = parse_qs(parsed_url.query)
                limit = int(query.get("limit", [24])[0] or 24)
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
        try:
            payload = self.read_json()
            if path == "/api/devices":
                return self.send_json(create_device(payload), 201)
            if path == "/api/groups":
                return self.send_json(create_group(payload), 201)
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

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        try:
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
    server = ThreadingHTTPServer(("127.0.0.1", 4173), Handler)
    print("NetworkManager running at http://127.0.0.1:4173")
    server.serve_forever()


if __name__ == "__main__":
    main()
