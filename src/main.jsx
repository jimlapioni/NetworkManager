import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

const emptySummary = { devices: 0, sensors: 0, up: 0, warning: 0, down: 0, unknown: 0 };
const statusLabels = { up: "Up", warning: "Warning", down: "Down", unknown: "Unknown", paused: "Paused" };
const statusRank = ["down", "warning", "unknown", "paused", "up"];

async function fetchJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeSummary(value) {
  return { ...emptySummary, ...(value || {}) };
}

function parseRouteHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "device" && parts[1]) return { view: "device-detail", deviceId: parts[1], sensorId: null };
  if (parts[0] === "sensor" && parts[1]) return { view: "sensor-detail", deviceId: null, sensorId: parts[1] };
  if (["devices", "sensors", "events"].includes(parts[0])) return { view: parts[0], deviceId: null, sensorId: null };
  return { view: "dashboard", deviceId: null, sensorId: null };
}

function routeHash(route) {
  if (route.view === "device-detail" && route.deviceId) return `#/device/${route.deviceId}`;
  if (route.view === "sensor-detail" && route.sensorId) return `#/sensor/${route.sensorId}`;
  if (["devices", "sensors", "events"].includes(route.view)) return `#/${route.view}`;
  return "#/dashboard";
}

function formatRate(value) {
  let current = Number(value || 0);
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let unit = units[0];
  for (let index = 0; index < units.length - 1 && Math.abs(current) >= 1000; index += 1) {
    current /= 1000;
    unit = units[index + 1];
  }
  return `${current.toFixed(2)} ${unit}`;
}

function shortInterfaceName(value) {
  return String(value || "")
    .trim()
    .replace(/^Ten-GigabitEthernet/i, "Te")
    .replace(/^M-GigabitEthernet/i, "M-Gi")
    .replace(/^GigabitEthernet/i, "Gi")
    .replace(/^Bridge-Aggregation/i, "BAGG")
    .replace(/^Vlan-interface/i, "Vlan")
    .replace(/\s+/g, " ");
}

function icon(name) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24"><path d="M3 4h8v8H3V4Zm10 0h8v5h-8V4ZM3 14h8v6H3v-6Zm10-3h8v9h-8v-9Z"/></svg>',
    server: '<svg viewBox="0 0 24 24"><path d="M4 3h16v8H4V3Zm2 2v4h12V5H6Zm-2 8h16v8H4v-8Zm2 2v4h12v-4H6Zm1-9h2v2H7V6Zm0 10h2v2H7v-2Z"/></svg>',
    sensor: '<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 1 4 4v5.2a6 6 0 1 1-8 0V6a4 4 0 0 1 4-4Zm-2 12-.4.3A4 4 0 1 0 14.4 14l-.4-.3V6a2 2 0 1 0-4 0v8Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2Zm0 4 6.6 12H5.4L12 6Zm-1 4h2v5h-2v-5Zm0 6h2v2h-2v-2Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.3L13 11h8V3l-3.3 3.3Z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>',
  };
  return <span dangerouslySetInnerHTML={{ __html: icons[name] || "" }} />;
}

function App() {
  const [route, setRouteState] = useState(() => parseRouteHash());
  const [data, setData] = useState({
    loading: true,
    apiOnline: false,
    summary: emptySummary,
    devices: [],
    groups: [],
    sensors: [],
    events: [],
  });
  const [deviceDetailTab, setDeviceDetailTab] = useState(null);
  const [portSamples, setPortSamples] = useState({});
  const routeRef = useRef(route);
  routeRef.current = route;

  const loadData = useCallback(async ({ showLoading = false } = {}) => {
    if (showLoading) setData((current) => ({ ...current, loading: true }));
    try {
      const [summary, devices, groups, sensors, events] = await Promise.all([
        fetchJson("/api/summary"),
        fetchJson("/api/devices"),
        fetchJson("/api/groups"),
        fetchJson("/api/sensors"),
        fetchJson("/api/events"),
      ]);
      setData({
        loading: false,
        apiOnline: true,
        summary: normalizeSummary(summary),
        devices: normalizeList(devices),
        groups: normalizeList(groups),
        sensors: normalizeList(sensors),
        events: normalizeList(events),
      });
    } catch {
      setData({
        loading: false,
        apiOnline: false,
        summary: emptySummary,
        devices: [],
        groups: [],
        sensors: [],
        events: [],
      });
    }
  }, []);

  const setRoute = useCallback((next) => {
    setRouteState((previous) => {
      if (next.view !== "device-detail" || String(previous.deviceId || "") !== String(next.deviceId || "")) {
        setDeviceDetailTab(null);
      }
      window.history.pushState(next, "", routeHash(next));
      return next;
    });
  }, []);

  useEffect(() => {
    window.history.replaceState(route, "", routeHash(route));
    const onPopState = (event) => setRouteState(event.state || parseRouteHash());
    window.addEventListener("popstate", onPopState);
    loadData({ showLoading: true });
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!["dashboard", "events"].includes(route.view)) return undefined;
    const timer = window.setInterval(() => loadData({ showLoading: false }), 10000);
    return () => window.clearInterval(timer);
  }, [route.view, loadData]);

  const selectedDevice = data.devices.find((device) => String(device.id) === String(route.deviceId));
  const selectedSensor = data.sensors.find((sensor) => String(sensor.id) === String(route.sensorId));
  const selectedDeviceSensors = selectedDevice
    ? data.sensors.filter((sensor) => String(sensor.deviceId) === String(selectedDevice.id))
    : [];
  const selectedPortSensors = selectedDeviceSensors.filter((sensor) => sensor.type === "snmp_traffic");
  const activeDeviceTab = deviceDetailTab || (selectedPortSensors.length ? "ports" : "sensors");

  useEffect(() => {
    if (route.view !== "device-detail" || activeDeviceTab !== "ports" || !route.deviceId || !selectedPortSensors.length) return undefined;
    let cancelled = false;
    async function refreshPortData() {
      try {
        const [sensors, samples] = await Promise.all([
          fetchJson("/api/sensors"),
          fetchJson(`/api/devices/${route.deviceId}/traffic-samples?limit=24`),
        ]);
        if (cancelled) return;
        setData((current) => ({ ...current, sensors: normalizeList(sensors) }));
        setPortSamples((current) => ({ ...current, [route.deviceId]: samples?.samples || {} }));
      } catch {
        if (!cancelled) setPortSamples((current) => ({ ...current, [route.deviceId]: current[route.deviceId] || {} }));
      }
    }
    refreshPortData();
    const timer = window.setInterval(refreshPortData, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.view, route.deviceId, activeDeviceTab, selectedPortSensors.length]);

  const content = data.loading ? (
    <main className="single-view">{emptyState("Loading", "Fetching live network state...")}</main>
  ) : (
    <CurrentView
      route={route}
      data={data}
      selectedDevice={selectedDevice}
      selectedSensor={selectedSensor}
      deviceDetailTab={activeDeviceTab}
      setDeviceDetailTab={setDeviceDetailTab}
      portSamples={portSamples}
      setRoute={setRoute}
    />
  );

  return (
    <div className="noc-shell">
      <Sidebar data={data} route={route} setRoute={setRoute} />
      <div className="noc-main">
        <Header route={route} summary={data.summary} apiOnline={data.apiOnline} onRefresh={() => loadData({ showLoading: false })} />
        {content}
      </div>
    </div>
  );
}

function CurrentView(props) {
  if (props.route.view === "devices") return <DevicesView data={props.data} setRoute={props.setRoute} />;
  if (props.route.view === "sensors") return <SensorsView data={props.data} setRoute={props.setRoute} />;
  if (props.route.view === "events") return <EventsView events={props.data.events} />;
  if (props.route.view === "device-detail") return <DeviceDetail {...props} />;
  if (props.route.view === "sensor-detail") return <SensorDetail sensor={props.selectedSensor} />;
  return <Dashboard data={props.data} setRoute={props.setRoute} />;
}

function Header({ route, summary, apiOnline, onRefresh }) {
  const titles = {
    dashboard: "Command Dashboard",
    devices: "Device Inventory",
    sensors: "Sensor Console",
    events: "Alert Timeline",
    "device-detail": "Device Detail",
    "sensor-detail": "Sensor Detail",
  };
  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">Local Network Monitoring</div>
        <h1>{titles[route.view] || titles.dashboard}</h1>
      </div>
      <div className="topbar-center">
        <Signal label="Up" value={summary.up} status="up" />
        <Signal label="Warning" value={summary.warning} status="warning" />
        <Signal label="Down" value={summary.down} status="down" />
        <Signal label="Unknown" value={summary.unknown} status="unknown" />
      </div>
      <div className="topbar-actions">
        <button className="ghost-button" onClick={onRefresh}>{icon("refresh")} Refresh</button>
        <button className="primary-button">{icon("plus")} Device</button>
      </div>
    </header>
  );
}

function Sidebar({ data, route, setRoute }) {
  const groups = useMemo(() => groupDevices(data.groups, data.devices), [data.groups, data.devices]);
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">NM</div>
        <div><strong>NetworkManager</strong><span>NOC Console</span></div>
      </div>
      <nav className="nav">
        <NavButton active={route.view === "dashboard"} label="Dashboard" iconName="dashboard" onClick={() => setRoute({ view: "dashboard" })} />
        <NavButton active={route.view === "devices"} label="Devices" iconName="server" onClick={() => setRoute({ view: "devices" })} />
        <NavButton active={route.view === "sensors"} label="Sensors" iconName="sensor" onClick={() => setRoute({ view: "sensors" })} />
        <NavButton active={route.view === "events"} label="Alerts" iconName="alert" onClick={() => setRoute({ view: "events" })} />
      </nav>
      <section className="tree-panel">
        <div className="section-label"><span>Monitoring Tree</span><button className="mini-button">{icon("plus")}</button></div>
        <div className="tree-scroll">
          {groups.map((group) => (
            <article className="tree-group" key={group.name}>
              <div className="tree-group-head"><span className={`dot ${group.status}`} /><strong>{group.name}</strong><small>{group.devices.length}</small></div>
              {group.devices.map((device) => (
                <button className={`tree-device ${String(device.id) === String(route.deviceId) ? "active" : ""}`} key={device.id} onClick={() => setRoute({ view: "device-detail", deviceId: device.id })}>
                  <span className={`dot ${device.status || "unknown"}`} />{device.name}
                </button>
              ))}
            </article>
          ))}
        </div>
      </section>
      <section className="side-status">
        <div className="section-label">Probe Health</div>
        <div className={`probe-card ${data.apiOnline ? "online" : "waiting"}`}>
          <span className="pulse" />
          <div><strong>{data.apiOnline ? "API Connected" : "API Waiting"}</strong><small>{data.apiOnline ? "Live checks available" : "Backend service not detected"}</small></div>
        </div>
      </section>
    </aside>
  );
}

function NavButton({ active, label, iconName, onClick }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon(iconName)}<span>{label}</span></button>;
}

function Dashboard({ data, setRoute }) {
  return (
    <main className="dashboard">
      <section className="metrics-row">
        {metricCard("Devices", data.summary.devices, "Managed targets", "cyan")}
        {metricCard("Sensors", data.summary.sensors, "Ping / SNMP / Traffic", "blue")}
        {metricCard("Alerts", (data.summary.warning || 0) + (data.summary.down || 0), "Active issues", "amber")}
        {metricCard("Probe", data.apiOnline ? "Online" : "Waiting", "Backend status", data.apiOnline ? "green" : "gray")}
      </section>
      <section className="command-grid">
        <div className="panel topology-panel">
          <div className="panel-head"><div><h2>Network Topology</h2><p>Device positions and relationships.</p></div></div>
          <Topology devices={data.devices} setRoute={setRoute} />
        </div>
        <div className="panel alert-panel">
          <div className="panel-head"><div><h2>Alert Timeline</h2><p>Recent status transitions</p></div></div>
          <EventsList events={data.events.slice(0, 8)} />
        </div>
        <div className="panel table-panel">
          <div className="panel-head"><div><h2>Sensor Console</h2><p>Current readings from all monitors</p></div></div>
          <SensorTable sensors={data.sensors} devices={data.devices} setRoute={setRoute} />
        </div>
      </section>
    </main>
  );
}

function DeviceDetail({ selectedDevice, data, deviceDetailTab, setDeviceDetailTab, portSamples, setRoute }) {
  if (!selectedDevice) return <main className="single-view">{emptyState("Device not found", "The selected device is not available.")}</main>;
  const sensors = data.sensors.filter((sensor) => String(sensor.deviceId) === String(selectedDevice.id));
  const portSensors = sensors.filter((sensor) => sensor.type === "snmp_traffic");
  const assignedSensors = sensors.filter((sensor) => sensor.type !== "snmp_traffic");
  const activeTab = deviceDetailTab || (portSensors.length ? "ports" : "sensors");
  return (
    <main className="single-view device-detail-view">
      <section className="panel identity-panel device-summary-panel">
        <div className="detail-title device-summary-head">
          <div><h2>{selectedDevice.name || selectedDevice.host}</h2><p>{selectedDevice.host}</p></div>
          <StatusBadge status={selectedDevice.status} />
        </div>
        <div className="device-summary-body">
          <div className="device-summary-details">
            {detailRow("Group", selectedDevice.group || "Unassigned")}
            {detailRow("SNMP", selectedDevice.snmpEnabled ? "Enabled" : "Disabled")}
            {detailRow("SNMP Port", selectedDevice.snmpPort || 161)}
            {detailRow("Notes", selectedDevice.notes || "-")}
          </div>
        </div>
      </section>
      <section className="panel device-monitor-panel">
        <div className="panel-head">
          <div><h2>{activeTab === "ports" ? "Ports" : "Assigned Sensors"}</h2><p>{activeTab === "ports" ? "Interface traffic sensors attached to this device" : "Non-port checks attached to this device"}</p></div>
          <div className="panel-head-actions">
            {activeTab === "ports" && <PortChartLegend />}
            <button className="primary-button">{icon("plus")} {activeTab === "ports" ? "Traffic Sensor" : "Sensor"}</button>
          </div>
        </div>
        <div className="device-detail-tabs" role="tablist">
          <button className={activeTab === "ports" ? "active" : ""} onClick={() => setDeviceDetailTab("ports")}><span>Ports</span><strong>{portSensors.length}</strong></button>
          <button className={activeTab === "sensors" ? "active" : ""} onClick={() => setDeviceDetailTab("sensors")}><span>Sensors</span><strong>{assignedSensors.length}</strong></button>
        </div>
        {activeTab === "ports" ? (
          <PortGrid sensors={portSensors} samples={portSamples[String(selectedDevice.id)] || {}} setRoute={setRoute} />
        ) : (
          <SensorTable sensors={assignedSensors} devices={data.devices} showDevice={false} setRoute={setRoute} />
        )}
      </section>
    </main>
  );
}

function PortGrid({ sensors, samples, setRoute }) {
  if (!sensors.length) return emptyState("No ports", "Interface traffic sensors will appear here after SNMP traffic discovery.");
  return (
    <div className="port-grid">
      {sensors.map((sensor) => (
        <button className={`port-tile ${sensor.status || "unknown"}`} key={sensor.id} title={sensor.config?.interfaceName || sensor.name || ""} onClick={() => setRoute({ view: "sensor-detail", sensorId: sensor.id })}>
          <span className={`port-light ${sensor.status || "unknown"}`} />
          <span className="port-name">{shortInterfaceName(sensor.config?.interfaceName || sensor.name || `ifIndex ${sensor.config?.index || ""}`)}</span>
          <span className="port-desc">{sensor.config?.interfaceDescription || "No description"}</span>
          <PortMiniChart samples={samples[String(sensor.id)] || []} />
          <span className="port-speed">{formatRate(sensor.config?.interfaceSpeed || 0)}</span>
        </button>
      ))}
    </div>
  );
}

function PortMiniChart({ samples }) {
  const width = 120;
  const height = 36;
  const values = samples.map((sample) => ({ inBps: Number(sample.meta?.inBps || 0), outBps: Number(sample.meta?.outBps || 0) }));
  const max = Math.max(0, ...values.flatMap((item) => [item.inBps, item.outBps]));
  const inbound = miniChartPoints(values.map((item) => item.inBps), max, width, height);
  const outbound = miniChartPoints(values.map((item) => item.outBps), max, width, height);
  const empty = values.length < 2;
  return (
    <span className={`port-mini-chart ${empty ? "empty" : ""}`}>
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <line className="port-chart-baseline" x1="0" y1={height - 4} x2={width} y2={height - 4} />
        <polyline className="port-chart-in" points={inbound} />
        <polyline className="port-chart-out" points={outbound} />
      </svg>
    </span>
  );
}

function miniChartPoints(values, max, width, height) {
  if (values.length < 2 || max <= 0) return `0,${height - 4} ${width},${height - 4}`;
  return values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = height - 4 - (Number(value || 0) / max) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function SensorTable({ sensors, devices, setRoute, showDevice = true }) {
  if (!sensors.length) return emptyState("No sensors", "Readings will appear after sensors are added.");
  const deviceName = (id) => devices.find((device) => String(device.id) === String(id))?.name || "-";
  return (
    <div className="scrollable-table-shell">
      <table>
        <thead><tr><th>Status</th><th>Sensor</th><th>Type</th>{showDevice && <th>Device</th>}<th>Value</th><th>Last Check</th></tr></thead>
        <tbody>
          {sensors.map((sensor) => (
            <tr key={sensor.id} data-sensor-id={sensor.id} onClick={() => setRoute?.({ view: "sensor-detail", sensorId: sensor.id })}>
              <td><StatusBadge status={sensor.status} /></td>
              <td><strong>{sensor.name}</strong>{sensor.type === "snmp_traffic" && sensor.config?.interfaceDescription && <small>{sensor.config.interfaceDescription}</small>}</td>
              <td>{sensor.type}</td>
              {showDevice && <td>{deviceName(sensor.deviceId)}</td>}
              <td>{sensor.lastValue || "-"}</td>
              <td>{sensor.lastCheck || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventsList({ events }) {
  if (!events.length) return emptyState("No alerts", "Status transitions will appear here.");
  return (
    <div className="event-list">
      {events.map((event) => (
        <article className={`event-item ${event.status || "unknown"}`} key={event.id}>
          <span className={`dot ${event.status || "unknown"}`} />
          <div><strong>{event.title}</strong><p>{event.message}</p></div>
          <time>{event.createdAt}</time>
        </article>
      ))}
    </div>
  );
}

function DevicesView({ data, setRoute }) {
  return (
    <main className="single-view">
      <section className="panel">
        <div className="panel-head"><div><h2>Devices</h2><p>Routers, switches, servers, printers, NAS, and probes.</p></div></div>
        <div className="scrollable-table-shell">
          <table><thead><tr><th>Status</th><th>Device</th><th>Host</th><th>Group</th><th>SNMP</th></tr></thead><tbody>
            {data.devices.map((device) => <tr key={device.id} onClick={() => setRoute({ view: "device-detail", deviceId: device.id })}><td><StatusBadge status={device.status} /></td><td>{device.name}</td><td>{device.host}</td><td>{device.group}</td><td>{device.snmpEnabled ? "Enabled" : "Disabled"}</td></tr>)}
          </tbody></table>
        </div>
      </section>
    </main>
  );
}

function SensorsView({ data, setRoute }) {
  return <main className="single-view"><section className="panel"><div className="panel-head"><div><h2>Sensors</h2><p>Current readings from all monitors.</p></div></div><SensorTable sensors={data.sensors} devices={data.devices} setRoute={setRoute} /></section></main>;
}

function EventsView({ events }) {
  return <main className="single-view"><section className="panel"><div className="panel-head"><div><h2>Alerts</h2><p>Failures, warnings, and recovery events.</p></div></div><EventsList events={events} /></section></main>;
}

function SensorDetail({ sensor }) {
  if (!sensor) return <main className="single-view">{emptyState("Sensor not found", "The selected sensor is not available.")}</main>;
  return (
    <main className="single-view">
      <section className="panel identity-panel">
        <div className="detail-title"><div><h2>{sensor.name}</h2><p>{sensor.type}</p></div><StatusBadge status={sensor.status} /></div>
        <div className="detail-grid">
          {detailRow("Value", sensor.lastValue || "-")}
          {detailRow("Last Check", sensor.lastCheck || "-")}
          {detailRow("OID", sensor.oid || sensor.config?.inOid || "-")}
        </div>
      </section>
    </main>
  );
}

function Topology({ devices, setRoute }) {
  if (!devices.length) return emptyState("No devices", "Add devices to populate topology.");
  return (
    <div className="topology-canvas">
      {devices.slice(0, 12).map((device, index) => {
        const fallbackX = 16 + (index % 4) * 22;
        const fallbackY = 18 + Math.floor(index / 4) * 24;
        return (
          <button
            className={`topology-node ${device.status || "unknown"}`}
            key={device.id}
            style={{
              left: `${device.topologyX ?? fallbackX}%`,
              top: `${device.topologyY ?? fallbackY}%`,
            }}
            onClick={() => setRoute({ view: "device-detail", deviceId: device.id })}
          >
            <span className={`dot ${device.status || "unknown"}`} />
            <strong>{device.name}</strong>
            <small>{device.host}</small>
          </button>
        );
      })}
    </div>
  );
}

function groupDevices(groups, devices) {
  const map = new Map();
  groups.forEach((group) => map.set(group.name || "Unassigned", []));
  devices.forEach((device) => {
    const group = device.group || "Unassigned";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(device);
  });
  return Array.from(map.entries()).map(([name, groupDevicesList]) => ({
    name,
    devices: groupDevicesList,
    status: aggregateStatus(groupDevicesList.map((device) => device.status || "unknown")),
  }));
}

function aggregateStatus(statuses) {
  return [...statuses].sort((a, b) => statusRank.indexOf(a) - statusRank.indexOf(b))[0] || "unknown";
}

function StatusBadge({ status = "unknown" }) {
  const normalized = statusLabels[status] ? status : "unknown";
  return <span className={`status-badge ${normalized}`}><span />{statusLabels[normalized]}</span>;
}

function PortChartLegend() {
  return <div className="port-chart-legend"><span><i className="legend-in" />Inbound</span><span><i className="legend-out" />Outbound</span></div>;
}

function Signal({ label, value, status }) {
  return <div className={`signal ${status}`}><span /><strong>{Number(value || 0).toLocaleString()}</strong><small>{label}</small></div>;
}

function metricCard(label, value, caption, tone) {
  return <article className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>;
}

function detailRow(label, value) {
  return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

function emptyState(title, body) {
  return <div className="empty-state"><strong>{title}</strong><p>{body}</p></div>;
}

createRoot(document.getElementById("root")).render(<App />);
