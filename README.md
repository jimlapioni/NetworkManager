# NetworkManager

Local NOC-style network monitoring console.

## Run

```powershell
& python.exe server.py
```

Open:

```text
http://127.0.0.1:4173
```

## Current Features

- Device inventory stored in SQLite.
- Device deletion and manual regrouping.
- Group deletion with related device cleanup.
- ICMP ping sensor.
- SNMP v2c GET sensor with custom OID.
- Manual sensor check.
- Manual drag-and-save topology node positions.
- Basic scheduler for repeated checks.
- Alert events for sensor status changes.
