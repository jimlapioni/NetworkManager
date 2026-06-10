# Changelog

## v0.3.0 - 2026-06-11

### Added

- Added a dedicated Device Detail Ports tab with square port tiles and mini inbound/outbound traffic charts.
- Added batched traffic sample loading for device port tiles.
- Added automatic port tile refresh while viewing the Ports tab.
- Added a Ports-only traffic sensor workflow with SNMP interface discovery and duplicate filtering.
- Added per-device duplicate protection for SNMP OIDs, traffic OIDs, and traffic interface indexes.
- Added a Device Serial Number SNMP guide action using `1.3.6.1.2.1.47.1.1.1.1.11`.
- Added README product documentation with a Device Detail screenshot.

### Changed

- Split `snmp_traffic` sensors out of the Assigned Sensors table into the Ports tab.
- Moved Interface Traffic creation out of the general Add Sensor dialog.
- Simplified the SNMP OID guide by removing traffic counter items now covered by the dedicated port workflow.
- Updated the Ports action button to use the plus icon for adding traffic sensors.

### Fixed

- Prevented duplicate SNMP sensors from being added to the same device.
- Prevented duplicate traffic sensors from being added for the same port.
- Improved port tile labels to avoid awkward single-character wrapping.

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
