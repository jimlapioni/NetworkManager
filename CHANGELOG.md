# Changelog

## v0.2.0 - 2026-06-10

### Added

- Added group management with create and delete support from the monitoring tree.
- Added device deletion and device regrouping from the device detail page.
- Added per-device sensor creation, sensor deletion, and manual sensor checks.
- Added SNMP v2c GET sensor configuration fields for OID, community, port, and unit.
- Added SNMP OID guidance for common system and interface OIDs.
- Added SNMP interface traffic discovery:
  - Scans interface names from `1.3.6.1.2.1.2.2.1.2`.
  - Scans interface descriptions from `1.3.6.1.2.1.31.1.1.1.18`.
  - Scans interface speed from `1.3.6.1.2.1.2.2.1.5`.
  - Creates inbound and outbound traffic sensors from high-capacity counters.
- Added traffic measurement history charts with inbound and outbound lines.
- Added sensor sample metadata storage for traffic counters and interface speed.

### Changed

- Updated device detail layout so basic device information appears above assigned sensors.
- Updated Dashboard Sensor Console to span the full dashboard width.
- Improved Sensor Console table readability by avoiding important text truncation.
- Added a top-positioned horizontal scrollbar for wide sensor tables.
- Updated traffic chart scaling to use interface speed as the Y-axis upper bound when SNMP returns a valid speed.
- Updated traffic chart labels to use bits-based units such as `Mbps` and `Gbps`.
- Updated traffic chart X-axis to show 30-second grid intervals in the visible time window.
- Simplified table last-check timestamps for readability while preserving the full timestamp in hover text.

### Fixed

- Fixed SNMP sensor form behavior so SNMP-specific parameters appear only when the SNMP sensor type is selected.
- Fixed select dropdown coloring for the dark UI.
- Fixed delete action layout in sensor tables.
- Fixed traffic chart grid alignment by removing the separate CSS background grid and keeping chart lines and axes in the same SVG coordinate system.
- Fixed Dashboard table compression that previously shortened important column labels and sensor names.
