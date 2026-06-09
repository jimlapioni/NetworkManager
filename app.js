const state = {
  loading: true,
  apiOnline: false,
  activeView: "dashboard",
  selectedDeviceId: null,
  selectedSensorId: null,
  pendingDeviceGroup: "",
  devices: [],
  groups: [],
  sensors: [],
  events: [],
  summary: null,
  draggingNode: null,
  snmpDiscovery: null,
  interfaceDiscovery: null,
  sensorSamples: {},
  sensorSamplesLoading: {},
};

const emptySummary = {
  devices: 0,
  sensors: 0,
  up: 0,
  warning: 0,
  down: 0,
  unknown: 0,
};

const statusRank = ["down", "warning", "unknown", "paused", "up"];
const statusLabels = {
  up: "Up",
  warning: "Warning",
  down: "Down",
  unknown: "Unknown",
  paused: "Paused",
};

const chartPlot = {
  left: 82,
  right: 744,
  top: 36,
  bottom: 268,
};
chartPlot.width = chartPlot.right - chartPlot.left;
chartPlot.height = chartPlot.bottom - chartPlot.top;
const chartTimeStepMs = 30 * 1000;
const chartVisibleWindowMs = 10 * 60 * 1000;

const snmpOidGuide = [
  {
    name: "System Description",
    oid: "1.3.6.1.2.1.1.1.0",
    unit: "",
    description: "Device model, OS, firmware, or system text.",
  },
  {
    name: "System Uptime",
    oid: "1.3.6.1.2.1.1.3.0",
    unit: "ticks",
    description: "Time since device SNMP agent started, in hundredths of a second.",
  },
  {
    name: "Hostname",
    oid: "1.3.6.1.2.1.1.5.0",
    unit: "",
    description: "Device system name.",
  },
  {
    name: "Interface Description",
    oid: "1.3.6.1.2.1.2.2.1.2.{ifIndex}",
    unit: "",
    description: "Port/interface label. Replace {ifIndex}, for example .2.1.2.1.",
  },
  {
    name: "Interface Status",
    oid: "1.3.6.1.2.1.2.2.1.8.{ifIndex}",
    unit: "state",
    description: "Operational status: 1 up, 2 down, 3 testing.",
  },
  {
    name: "Interface Speed",
    oid: "1.3.6.1.2.1.2.2.1.5.{ifIndex}",
    unit: "bps",
    description: "Configured interface speed in bits per second.",
  },
  {
    name: "Inbound Traffic Counter",
    oid: "1.3.6.1.2.1.2.2.1.10.{ifIndex}",
    unit: "octets",
    description: "Inbound byte counter. Use deltas over time to calculate traffic rate.",
  },
  {
    name: "Outbound Traffic Counter",
    oid: "1.3.6.1.2.1.2.2.1.16.{ifIndex}",
    unit: "octets",
    description: "Outbound byte counter. Use deltas over time to calculate traffic rate.",
  },
];

async function fetchJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

async function loadData() {
  state.loading = true;
  render();

  try {
    const [summary, devices, groups, sensors, events] = await Promise.all([
      fetchJson("/api/summary"),
      fetchJson("/api/devices"),
      fetchJson("/api/groups"),
      fetchJson("/api/sensors"),
      fetchJson("/api/events"),
    ]);

    state.summary = normalizeSummary(summary);
    state.devices = normalizeList(devices);
    state.groups = normalizeList(groups);
    state.sensors = normalizeList(sensors);
    state.events = normalizeList(events);
    state.apiOnline = true;
  } catch {
    state.summary = emptySummary;
    state.devices = [];
    state.groups = [];
    state.sensors = [];
    state.events = [];
    state.apiOnline = false;
  } finally {
    state.loading = false;
    render();
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function normalizeSummary(value) {
  return {
    ...emptySummary,
    ...(value || {}),
  };
}

function setView(activeView, payload = {}, options = {}) {
  state.activeView = activeView;
  state.selectedDeviceId = payload.deviceId || null;
  state.selectedSensorId = payload.sensorId || null;
  render();
  if (options.push !== false) {
    pushRoute();
  }
}

function routeState() {
  return {
    activeView: state.activeView,
    selectedDeviceId: state.selectedDeviceId,
    selectedSensorId: state.selectedSensorId,
  };
}

function routeHash(route = routeState()) {
  if (route.activeView === "device-detail" && route.selectedDeviceId) return `#/device/${route.selectedDeviceId}`;
  if (route.activeView === "sensor-detail" && route.selectedSensorId) return `#/sensor/${route.selectedSensorId}`;
  if (["devices", "sensors", "events"].includes(route.activeView)) return `#/${route.activeView}`;
  return "#/dashboard";
}

function parseRouteHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "device" && parts[1]) return { activeView: "device-detail", selectedDeviceId: parts[1], selectedSensorId: null };
  if (parts[0] === "sensor" && parts[1]) return { activeView: "sensor-detail", selectedDeviceId: null, selectedSensorId: parts[1] };
  if (["devices", "sensors", "events"].includes(parts[0])) return { activeView: parts[0], selectedDeviceId: null, selectedSensorId: null };
  return { activeView: "dashboard", selectedDeviceId: null, selectedSensorId: null };
}

function applyRoute(route) {
  state.activeView = route.activeView;
  state.selectedDeviceId = route.selectedDeviceId;
  state.selectedSensorId = route.selectedSensorId;
  render();
}

function pushRoute() {
  const route = routeState();
  const hash = routeHash(route);
  if (window.location.hash === hash) {
    history.replaceState(route, "", hash);
  } else {
    history.pushState(route, "", hash);
  }
}

function initRouting() {
  const route = parseRouteHash();
  state.activeView = route.activeView;
  state.selectedDeviceId = route.selectedDeviceId;
  state.selectedSensorId = route.selectedSensorId;
  history.replaceState(routeState(), "", routeHash());
  window.addEventListener("popstate", (event) => {
    applyRoute(event.state || parseRouteHash());
  });
}

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <div class="noc-shell">
      ${renderSidebar()}
      <div class="noc-main">
        ${renderHeader()}
        ${renderCurrentView()}
      </div>
    </div>
    ${renderDeviceModal()}
    ${renderGroupModal()}
    ${renderSensorModal()}
  `;
  bindEvents();
}

function renderSidebar() {
  const groups = groupDevices();
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">NM</div>
        <div>
          <strong>NetworkManager</strong>
          <span>NOC Console</span>
        </div>
      </div>

      <nav class="nav">
        ${navButton("dashboard", "Dashboard", icon("dashboard"))}
        ${navButton("devices", "Devices", icon("server"))}
        ${navButton("sensors", "Sensors", icon("sensor"))}
        ${navButton("events", "Alerts", icon("alert"))}
      </nav>

      <section class="tree-panel">
        <div class="section-label">
          <span>Monitoring Tree</span>
          <button class="mini-button" data-action="open-group-modal" aria-label="Add group">${icon("plus")}</button>
        </div>
        <div class="tree-scroll">
          ${groups.length ? groups.map(renderTreeGroup).join("") : renderTreeEmpty()}
        </div>
      </section>

      <section class="side-status">
        <div class="section-label">Probe Health</div>
        <div class="probe-card ${state.apiOnline ? "online" : "waiting"}">
          <span class="pulse"></span>
          <div>
            <strong>${state.apiOnline ? "API Connected" : "API Waiting"}</strong>
            <small>${state.apiOnline ? "Live checks available" : "Backend service not detected"}</small>
          </div>
        </div>
      </section>
    </aside>
  `;
}

function navButton(view, label, iconSvg) {
  return `
    <button class="${state.activeView === view ? "active" : ""}" data-view="${view}">
      ${iconSvg}<span>${label}</span>
    </button>
  `;
}

function renderHeader() {
  const summary = state.summary || emptySummary;
  return `
    <header class="topbar">
      <div>
        <div class="eyebrow">Local Network Monitoring</div>
        <h1>${viewTitle()}</h1>
      </div>
      <div class="topbar-center">
        ${renderSignal("Up", summary.up, "up")}
        ${renderSignal("Warning", summary.warning, "warning")}
        ${renderSignal("Down", summary.down, "down")}
        ${renderSignal("Unknown", summary.unknown, "unknown")}
      </div>
      <div class="topbar-actions">
        <button class="ghost-button" data-action="refresh">${icon("refresh")} Refresh</button>
        <button class="primary-button" data-action="open-device-modal">${icon("plus")} Device</button>
      </div>
    </header>
  `;
}

function renderSignal(label, value, status) {
  return `
    <div class="signal ${status}">
      <span></span>
      <strong>${Number(value || 0).toLocaleString()}</strong>
      <small>${label}</small>
    </div>
  `;
}

function renderCurrentView() {
  if (state.loading) return renderLoading();
  if (state.activeView === "devices") return renderDevicesView();
  if (state.activeView === "sensors") return renderSensorsView();
  if (state.activeView === "events") return renderEventsView();
  if (state.activeView === "device-detail") return renderDeviceDetail();
  if (state.activeView === "sensor-detail") return renderSensorDetail();
  return renderDashboard();
}

function renderDashboard() {
  return `
    <main class="dashboard">
      <section class="metrics-row">
        ${metricCard("Devices", state.summary?.devices || 0, "Managed targets", "cyan")}
        ${metricCard("Sensors", state.summary?.sensors || 0, "Ping / HTTP / SNMP", "blue")}
        ${metricCard("Alerts", (state.summary?.warning || 0) + (state.summary?.down || 0), "Active issues", "amber")}
        ${metricCard("Probe", state.apiOnline ? "Online" : "Waiting", "Backend status", state.apiOnline ? "green" : "gray")}
      </section>

      <section class="command-grid">
        <div class="panel topology-panel">
          <div class="panel-head">
            <div>
              <h2>Network Topology</h2>
              <p>Live device relationships will appear when discovery data is available.</p>
            </div>
            <button class="ghost-button" data-action="refresh">${icon("refresh")} Sync</button>
          </div>
          ${renderTopology()}
        </div>

        <div class="panel alert-panel">
          <div class="panel-head">
            <div>
              <h2>Alert Timeline</h2>
              <p>Recent status transitions</p>
            </div>
          </div>
          ${renderEventsList(state.events.slice(0, 8))}
        </div>

        <div class="panel table-panel">
          <div class="panel-head">
            <div>
              <h2>Sensor Console</h2>
              <p>Current readings from all monitors</p>
            </div>
            <button class="ghost-button" data-action="check-now">${icon("play")} Check All</button>
          </div>
          ${renderSensorTable(state.sensors)}
        </div>

        <div class="panel health-panel">
          <div class="panel-head">
            <div>
              <h2>SNMP Workspace</h2>
              <p>v2c templates and custom OID checks</p>
            </div>
          </div>
          ${renderSnmpWorkspace()}
        </div>
      </section>
    </main>
  `;
}

function renderDevicesView() {
  return `
    <main class="single-view">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Devices</h2>
            <p>Routers, switches, servers, printers, NAS, and probes.</p>
          </div>
          <button class="primary-button" data-action="open-device-modal">${icon("plus")} Device</button>
        </div>
        ${renderDeviceTable()}
      </section>
    </main>
  `;
}

function renderSensorsView() {
  return `
    <main class="single-view">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Sensors</h2>
            <p>Ping, HTTP, SNMP template, and custom OID monitors.</p>
          </div>
        </div>
        ${renderSensorTable(state.sensors)}
      </section>
    </main>
  `;
}

function renderEventsView() {
  return `
    <main class="single-view">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Alerts</h2>
            <p>Failures, warnings, acknowledgements, and recovery events.</p>
          </div>
        </div>
        ${renderEventsList(state.events)}
      </section>
    </main>
  `;
}

function renderDeviceDetail() {
  const device = state.devices.find((item) => String(item.id) === String(state.selectedDeviceId));
  if (!device) {
    return `<main class="single-view">${emptyState("Device not found", "The selected device is not available from the API.")}</main>`;
  }
  const sensors = state.sensors.filter((sensor) => String(sensor.deviceId) === String(device.id));

  return `
    <main class="single-view device-detail-view">
      <section class="panel identity-panel device-summary-panel">
        <div class="detail-title device-summary-head">
          <div>
            <h2>${escapeHtml(device.name || device.host)}</h2>
            <p>${escapeHtml(device.host || "")}</p>
          </div>
          ${statusBadge(device.status)}
        </div>
        <div class="device-summary-body">
          <form class="group-editor" data-form="device-group" data-device-id="${device.id}">
            <label>Group<input name="group" type="text" value="${escapeAttribute(device.group || "Unassigned")}" /></label>
            <button class="ghost-button" type="submit">Save Group</button>
          </form>
          <div class="device-summary-details">
            ${detailRow("SNMP", device.snmpEnabled ? "Enabled" : "Disabled")}
            ${detailRow("SNMP Port", device.snmpPort || 161)}
            ${detailRow("Notes", device.notes || "-")}
          </div>
          <div class="danger-zone">
            <button class="mini-action danger" data-action="delete-device" data-delete-device-id="${device.id}">${icon("trash")} Delete Device</button>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Assigned Sensors</h2>
            <p>Checks attached to this device</p>
          </div>
          <button class="primary-button" data-action="open-sensor-modal" data-device-id="${device.id}">${icon("plus")} Sensor</button>
        </div>
        ${renderSensorTable(sensors, { showDevice: false })}
      </section>
    </main>
  `;
}

function renderSensorDetail() {
  const sensor = state.sensors.find((item) => String(item.id) === String(state.selectedSensorId));
  if (!sensor) {
    return `<main class="single-view">${emptyState("Sensor not found", "The selected sensor is not available from the API.")}</main>`;
  }
  const samples = state.sensorSamples[String(sensor.id)] || [];

  return `
    <main class="single-view detail-grid">
      <section class="panel identity-panel">
        <div class="detail-title">
          <div>
            <h2>${escapeHtml(sensor.name || "Sensor")}</h2>
            <p>${escapeHtml(sensor.type || "monitor")}</p>
          </div>
          ${statusBadge(sensor.status)}
        </div>
        ${detailRow("Last Value", sensor.lastValue || "-")}
        ${detailRow("Interval", `${sensor.interval || 30}s`)}
        ${detailRow("Device", deviceName(sensor.deviceId))}
        ${detailRow("Unit", sensor.unit || "-")}
        ${sensor.type === "snmp_traffic" ? detailRow("Interface", sensor.config?.interfaceName || sensor.config?.index || "-") : ""}
        ${sensor.type === "snmp_traffic" ? detailRow("Description", sensor.config?.interfaceDescription || "-") : ""}
        ${sensor.type === "snmp_traffic" ? detailRow("Interface Speed", formatRate(sensor.config?.interfaceSpeed || 0)) : ""}
        ${sensor.type === "snmp_traffic" ? detailRow("Speed OID", sensor.config?.speedOid || "-") : ""}
        ${sensor.type === "snmp_traffic" ? detailRow("Inbound OID", sensor.config?.inOid || "-") : ""}
        ${sensor.type === "snmp_traffic" ? detailRow("Outbound OID", sensor.config?.outOid || "-") : ""}
        ${detailRow("Last Check", sensor.lastCheck || "-")}
      </section>
      <section class="panel chart-panel">
        <div class="panel-head">
          <div>
            <h2>Measurement History</h2>
            <p>${sensor.type === "snmp_traffic" ? "Inbound and outbound interface rate" : "Recent sensor samples"}</p>
          </div>
          <button class="ghost-button" data-action="check-sensor" data-check-sensor-id="${sensor.id}">${icon("play")} Check</button>
        </div>
        ${renderSensorChart(sensor, samples)}
      </section>
    </main>
  `;
}

function renderSensorChart(sensor, samples) {
  if (state.sensorSamplesLoading[String(sensor.id)]) {
    return `<div class="empty-chart"><span>Loading samples</span></div>`;
  }
  if (!samples.length) {
    return `<div class="empty-chart"><span>No samples yet</span></div>`;
  }

  if (sensor.type === "snmp_traffic") {
    const domain = chartDomain(samples);
    const visibleSamples = chartVisibleSamples(samples, domain);
    const points = visibleSamples.map((sample) => ({
      time: sample.createdAt,
      inBps: Number(sample.meta?.inBps || 0),
      outBps: Number(sample.meta?.outBps || 0),
    }));
    const measuredMax = Math.max(1, ...points.flatMap((item) => [item.inBps, item.outBps]));
    const interfaceSpeed = Number(sensor.config?.interfaceSpeed || visibleSamples.at(-1)?.meta?.interfaceSpeed || 0);
    const axisMax = Math.max(1, interfaceSpeed || measuredMax, measuredMax);
    const scale = chartScale(axisMax, "rate");
    return `
      <div class="traffic-chart">
        <div class="chart-stats">
          <div><span>Inbound</span><strong>${formatRate(points.at(-1)?.inBps || 0)}</strong></div>
          <div><span>Outbound</span><strong>${formatRate(points.at(-1)?.outBps || 0)}</strong></div>
          <div><span>Peak</span><strong>${formatRate(measuredMax)}</strong></div>
          <div><span>Axis Max</span><strong>${formatRate(axisMax)}</strong></div>
        </div>
        <svg viewBox="0 0 780 330" role="img" aria-label="Interface traffic history">
          ${chartGrid(axisMax, scale, domain)}
          <polyline class="chart-line in" points="${chartPoints(points.map((item) => item.inBps), axisMax, visibleSamples, domain)}"></polyline>
          <polyline class="chart-line out" points="${chartPoints(points.map((item) => item.outBps), axisMax, visibleSamples, domain)}"></polyline>
        </svg>
        <div class="chart-legend">
          <span><i class="legend-in"></i>Inbound</span>
          <span><i class="legend-out"></i>Outbound</span>
        </div>
      </div>
    `;
  }

  const domain = chartDomain(samples);
  const visibleSamples = chartVisibleSamples(samples, domain);
  const values = visibleSamples.map((sample) => Number(sample.valueNumber || 0));
  const max = Math.max(1, ...values);
  const scale = chartScale(max, "number", sensor.unit || "");
  return `
    <div class="traffic-chart">
      <div class="chart-stats">
        <div><span>Current</span><strong>${escapeHtml(visibleSamples.at(-1)?.valueText || "-")}</strong></div>
        <div><span>Samples</span><strong>${visibleSamples.length}</strong></div>
        <div><span>Peak</span><strong>${max.toLocaleString()}</strong></div>
        <div><span>Axis Max</span><strong>${max.toLocaleString()}</strong></div>
      </div>
      <svg viewBox="0 0 780 330" role="img" aria-label="Sensor sample history">
        ${chartGrid(max, scale, domain)}
        <polyline class="chart-line in" points="${chartPoints(values, max, visibleSamples, domain)}"></polyline>
      </svg>
    </div>
  `;
}

function chartGrid(max, scale, domain) {
  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  const timeTicks = chartTimeTicks(domain);
  return `
    <g class="chart-grid">
      <line x1="${chartPlot.left}" y1="${chartPlot.top}" x2="${chartPlot.left}" y2="${chartPlot.bottom}"></line>
      <line x1="${chartPlot.left}" y1="${chartPlot.bottom}" x2="${chartPlot.right}" y2="${chartPlot.bottom}"></line>
      ${timeTicks
        .map((tick) => `<line x1="${tick.x.toFixed(1)}" y1="${chartPlot.top}" x2="${tick.x.toFixed(1)}" y2="${chartPlot.bottom}"></line>`)
        .join("")}
      ${yTicks
        .map((ratio) => {
          const y = chartPlot.bottom - ratio * chartPlot.height;
          return `<line x1="${chartPlot.left}" y1="${y.toFixed(1)}" x2="${chartPlot.right}" y2="${y.toFixed(1)}"></line>`;
        })
        .join("")}
    </g>
    <g class="chart-axis-labels">
      ${yTicks
        .map((ratio) => {
          const y = chartPlot.bottom - ratio * chartPlot.height;
          const label = formatAxisValue(max * ratio, scale);
          return `<text x="${chartPlot.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(label)}</text>`;
        })
        .join("")}
      ${timeTicks
        .map((tick) => `<text class="chart-time-label" x="${tick.x.toFixed(1)}" y="294" text-anchor="middle">${escapeHtml(tick.label)}</text>`)
        .join("")}
      <text class="chart-axis-title" x="${chartPlot.left}" y="20" text-anchor="start">${escapeHtml(scale.unit)}</text>
      <text class="chart-axis-title" x="${((chartPlot.left + chartPlot.right) / 2).toFixed(1)}" y="320" text-anchor="middle">Time</text>
    </g>
  `;
}

function chartPoints(values, max, samples, domain) {
  return values
    .map((value, index) => {
      const time = new Date(samples[index]?.createdAt || "").getTime();
      const x = chartX(Number.isFinite(time) ? time : domain.start + index * chartTimeStepMs, domain);
      const y = chartPlot.bottom - (Number(value || 0) / max) * chartPlot.height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function chartDomain(samples) {
  const times = samples
    .map((sample) => new Date(sample.createdAt || "").getTime())
    .filter((time) => Number.isFinite(time));
  const now = Date.now();
  const minTime = times.length ? Math.min(...times) : now - chartTimeStepMs;
  const maxTime = times.length ? Math.max(...times) : now;
  const rawStart = Math.floor(minTime / chartTimeStepMs) * chartTimeStepMs;
  let end = Math.ceil(maxTime / chartTimeStepMs) * chartTimeStepMs;
  let start = Math.max(rawStart, end - chartVisibleWindowMs);
  if (end <= start) end = start + chartTimeStepMs;
  return { start, end };
}

function chartVisibleSamples(samples, domain) {
  const visible = samples.filter((sample) => {
    const time = new Date(sample.createdAt || "").getTime();
    return Number.isFinite(time) && time >= domain.start && time <= domain.end;
  });
  return visible.length ? visible : samples.slice(-1);
}

function chartX(time, domain) {
  return chartPlot.left + ((time - domain.start) / Math.max(1, domain.end - domain.start)) * chartPlot.width;
}

function chartTimeTicks(domain) {
  const ticks = [];
  for (let time = domain.start; time <= domain.end + 1; time += chartTimeStepMs) {
    ticks.push({
      label: formatChartTimeLabel(time),
      x: chartX(time, domain),
    });
  }
  return ticks;
}

function chartScale(max, type, unit = "") {
  if (type === "rate") {
    const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    let divisor = 1;
    let selected = units[0];
    for (const candidate of units) {
      selected = candidate;
      if (max / divisor < 1000 || candidate === units.at(-1)) break;
      divisor *= 1000;
    }
    return { divisor, unit: selected };
  }
  return { divisor: 1, unit: unit || "value" };
}

function formatAxisValue(value, scale) {
  const scaled = Number(value || 0) / scale.divisor;
  if (Math.abs(scaled) >= 100) return scaled.toFixed(0);
  if (Math.abs(scaled) >= 10) return scaled.toFixed(1);
  return scaled.toFixed(2);
}

function formatTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatTableDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return value || "-";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day} ${formatTimeLabel(date)}`;
}

function formatChartTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatRate(value) {
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let current = Math.max(0, Number(value || 0));
  let unit = units[0];
  for (unit of units) {
    if (current < 1000 || unit === units.at(-1)) break;
    current /= 1000;
  }
  return `${current.toFixed(2)} ${unit}`;
}

function metricCard(label, value, caption, tone) {
  return `
    <article class="metric-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(caption)}</small>
    </article>
  `;
}

function renderTopology() {
  if (!state.devices.length) {
    return `
      <div class="topology-empty">
        <div class="radar">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <strong>No live devices</strong>
        <p>Devices will be plotted here after the monitoring backend returns data.</p>
      </div>
    `;
  }

  return `
    <div class="topology-map">
      ${state.devices
        .slice(0, 18)
        .map((device, index) => {
          const x = Number.isFinite(Number(device.topologyX)) ? Number(device.topologyX) : 12 + ((index * 23) % 72);
          const y = Number.isFinite(Number(device.topologyY)) ? Number(device.topologyY) : 18 + ((index * 31) % 62);
          return `
            <button class="topology-node ${device.status || "unknown"}" style="left:${x}%;top:${y}%;" data-device-id="${device.id}">
              <span></span>${escapeHtml(device.name || device.host)}
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderSnmpWorkspace() {
  return `
    <div class="snmp-grid">
      ${snmpChip("Uptime", "1.3.6.1.2.1.1.3.0")}
      ${snmpChip("CPU", "Template")}
      ${snmpChip("Memory", "Template")}
      ${snmpChip("Interface", "Traffic")}
      ${snmpChip("Custom OID", "Manual")}
    </div>
    <div class="snmp-note">
      SNMP v2c checks will activate once the backend implements template and custom OID polling.
    </div>
  `;
}

function snmpChip(label, value) {
  return `
    <div class="snmp-chip">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDeviceTable() {
  if (!state.devices.length) {
    return emptyState("No devices", "Add devices after the backend storage API is connected.");
  }

  return `
    <div class="data-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Device</th>
            <th>Host</th>
            <th>Group</th>
            <th>SNMP</th>
            <th>Tags</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.devices
            .map(
              (device) => `
                <tr data-device-id="${device.id}">
                  <td>${statusBadge(device.status)}</td>
                  <td>${escapeHtml(device.name || "-")}</td>
                  <td>${escapeHtml(device.host || "-")}</td>
                  <td>${escapeHtml(device.group || "-")}</td>
                  <td>${device.snmpEnabled ? "Enabled" : "Disabled"}</td>
                  <td>${escapeHtml(Array.isArray(device.tags) ? device.tags.join(", ") : device.tags || "-")}</td>
                  <td><button class="mini-action danger" data-action="delete-device" data-delete-device-id="${device.id}">${icon("trash")} Delete</button></td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSensorTable(sensors, options = {}) {
  if (!sensors.length) {
    return emptyState("No sensors", "Ping, HTTP, and SNMP readings will appear after the API is connected.");
  }
  const showDevice = options.showDevice !== false;

  return `
    <div class="scrollable-table-shell">
      <div class="table-scroll-top" data-table-scroll-top aria-hidden="true"><div></div></div>
      <div class="data-table-wrap" data-table-scroll-body>
        <table class="sensor-table ${showDevice ? "" : "compact-sensor-table"}">
          <colgroup>
            <col class="sensor-col-status" />
            <col class="sensor-col-name" />
            <col class="sensor-col-type" />
            ${showDevice ? `<col class="sensor-col-device" />` : ""}
            <col class="sensor-col-value" />
            <col class="sensor-col-check" />
            <col class="sensor-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>Status</th>
              <th>Sensor</th>
              <th>Type</th>
              ${showDevice ? "<th>Device</th>" : ""}
              <th>Value</th>
              <th>Last Check</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${sensors
              .map(
                (sensor) => `
                  <tr data-sensor-id="${sensor.id}">
                    <td>${statusBadge(sensor.status)}</td>
                    <td>${renderSensorNameCell(sensor)}</td>
                    <td>${escapeHtml(sensor.type || "-")}</td>
                    ${showDevice ? `<td>${escapeHtml(deviceName(sensor.deviceId))}</td>` : ""}
                    <td>${escapeHtml(sensor.lastValue || "-")}</td>
                    <td title="${escapeAttribute(sensor.lastCheck || "-")}">${escapeHtml(formatTableDateTime(sensor.lastCheck))}</td>
                    <td>
                      <div class="row-actions">
                        <button class="mini-action" data-action="check-sensor" data-check-sensor-id="${sensor.id}">${icon("play")} Check</button>
                        <button class="mini-action danger" data-action="delete-sensor" data-delete-sensor-id="${sensor.id}">${icon("trash")} Delete</button>
                      </div>
                    </td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSensorNameCell(sensor) {
  const description = sensor.type === "snmp_traffic" ? sensor.config?.interfaceDescription || "" : "";
  return `
    <div class="sensor-name-cell">
      <strong>${escapeHtml(sensor.name || "-")}</strong>
      ${description ? `<small>${escapeHtml(description)}</small>` : ""}
    </div>
  `;
}

function renderEventsList(events) {
  if (!events.length) {
    return emptyState("No alerts", "Failures, warnings, and recoveries will appear here.");
  }

  return `
    <div class="event-list">
      ${events
        .map(
          (event) => `
            <button class="event-row">
              <span class="event-dot ${event.status || "unknown"}"></span>
              <div>
                <strong>${escapeHtml(event.title || event.message || "Event")}</strong>
                <small>${escapeHtml(event.createdAt || event.time || "")}</small>
              </div>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTreeGroup(group) {
  return `
    <div class="tree-group">
      <button class="tree-group-button">
        <span class="status-dot ${group.status}"></span>
        <strong>${escapeHtml(group.name)}</strong>
        <small>${group.devices.length}</small>
        <span class="tree-group-action add" data-action="open-device-modal" data-group-name="${escapeAttribute(group.name)}" aria-label="Add device to group">${icon("plus")}</span>
        <span class="tree-group-action" data-action="delete-group" data-delete-group-name="${escapeAttribute(group.name)}" aria-label="Delete group">${icon("trash")}</span>
      </button>
      ${group.devices
        .map(
          (device) => `
            <button class="tree-device ${String(device.id) === String(state.selectedDeviceId) ? "active" : ""}" data-device-id="${device.id}">
              <span class="status-dot ${device.status || "unknown"}"></span>
              <span class="tree-device-name">${escapeHtml(device.name || device.host)}</span>
              <span class="tree-device-action" data-action="open-sensor-modal" data-device-id="${device.id}" aria-label="Add sensor">${icon("plus")}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTreeEmpty() {
  return `
    <div class="tree-empty">
      <div class="empty-node"></div>
      <strong>No devices</strong>
      <span>Waiting for backend API</span>
    </div>
  `;
}

function emptyState(title, message) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon("radar")}</div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderLoading() {
  return `
    <main class="dashboard">
      <section class="metrics-row">
        ${Array.from({ length: 4 }).map(() => `<div class="metric-card skeleton"></div>`).join("")}
      </section>
      <section class="command-grid">
        <div class="panel topology-panel skeleton-panel"></div>
        <div class="panel alert-panel skeleton-panel"></div>
        <div class="panel table-panel skeleton-panel"></div>
        <div class="panel health-panel skeleton-panel"></div>
      </section>
    </main>
  `;
}

function renderDeviceModal() {
  return `
    <dialog id="device-modal">
      <form class="modal-card" data-form="device">
        <div class="modal-head">
          <div>
            <h2>Add Device</h2>
            <p>Create a monitored network target.</p>
          </div>
          <button class="icon-button" type="button" data-action="close-dialog" aria-label="Close">${icon("close")}</button>
        </div>
        <div class="form-grid">
          <label>Name<input name="name" type="text" placeholder="Core Switch" required /></label>
          <label>Host<input name="host" type="text" placeholder="192.168.1.1" required /></label>
          <label>Group<input name="group" type="text" placeholder="Core Network" value="${escapeAttribute(state.pendingDeviceGroup)}" /></label>
          <label>SNMP Port<input name="snmpPort" type="number" value="161" /></label>
          <label class="wide check-label"><input name="snmpEnabled" type="checkbox" /> Enable SNMP v2c for this device</label>
          <label class="wide">SNMP v2c Community<input name="snmpCommunity" type="password" placeholder="public" /></label>
          <label class="wide">Notes<textarea name="notes" placeholder="Location, model, owner, or maintenance notes"></textarea></label>
        </div>
        <div class="modal-note" data-form-message="device">Device will be saved to local SQLite.</div>
        <div class="modal-actions">
          <button class="ghost-button" type="button" data-action="close-dialog">Cancel</button>
          <button class="primary-button" type="submit">Save</button>
        </div>
      </form>
    </dialog>
  `;
}

function renderGroupModal() {
  return `
    <dialog id="group-modal">
      <form class="modal-card compact-modal" data-form="group">
        <div class="modal-head">
          <div>
            <h2>Add Group</h2>
            <p>Create an empty monitoring group.</p>
          </div>
          <button class="icon-button" type="button" data-action="close-dialog" aria-label="Close">${icon("close")}</button>
        </div>
        <label>Group Name<input name="name" type="text" placeholder="Networks" required /></label>
        <div class="modal-note" data-form-message="group">Groups can exist even before devices are added.</div>
        <div class="modal-actions">
          <button class="ghost-button" type="button" data-action="close-dialog">Cancel</button>
          <button class="primary-button" type="submit">Save</button>
        </div>
      </form>
    </dialog>
  `;
}

function renderSensorModal() {
  const device = state.devices.find((item) => String(item.id) === String(state.selectedDeviceId));
  return `
    <dialog id="sensor-modal">
      <form class="modal-card" data-form="sensor">
        <div class="modal-head">
          <div>
            <h2>Add Sensor</h2>
            <p>${device ? `Attach to ${escapeHtml(device.name || device.host)}` : "Select a device from the monitoring tree first."}</p>
          </div>
          <button class="icon-button" type="button" data-action="close-dialog" aria-label="Close">${icon("close")}</button>
        </div>
        <div class="form-grid">
          <div class="sensor-type-field">
            <span>Sensor Type</span>
            <div class="segmented-control">
              <label><input type="radio" name="type" value="icmp" checked /> <span>ICMP Ping</span></label>
              <label><input type="radio" name="type" value="snmp" /> <span>SNMP v2c GET</span></label>
              <label><input type="radio" name="type" value="snmp_traffic" /> <span>Interface Traffic</span></label>
            </div>
          </div>
          <label>Name<input name="name" type="text" placeholder="ICMP Ping" /></label>
          <label>Interval Seconds<input name="interval" type="number" value="30" min="10" /></label>
          <div class="snmp-fields" data-snmp-fields hidden>
            <label data-snmp-get-only>SNMP OID<input name="oid" type="text" value="1.3.6.1.2.1.1.3.0" /></label>
            <label>Community<input name="community" type="password" placeholder="Use device community" /></label>
            <label>Port<input name="port" type="number" value="${device?.snmpPort || 161}" /></label>
            <label data-snmp-get-only>Unit<input name="unit" type="text" placeholder="ticks, %, ms" /></label>
            <section class="oid-guide" data-snmp-get-only>
              <div class="oid-guide-head">
                <strong>Common SNMP OIDs</strong>
                <span>Click Use to fill the sensor fields.</span>
              </div>
              <div class="oid-guide-list">
                ${snmpOidGuide.map(renderOidGuideItem).join("")}
              </div>
            </section>
            <section class="snmp-discovery" data-snmp-discovery data-snmp-get-only>
              <div class="snmp-discovery-head">
                <div>
                  <strong>SNMP Walk Discovery</strong>
                  <span>Use the OID above as a base, discover indexed rows, then create one sensor per row.</span>
                </div>
                <button class="mini-action" type="button" data-action="scan-snmp-walk">${icon("radar")} Scan</button>
              </div>
              <div class="snmp-discovery-results" data-snmp-discovery-results>
                <p>Example: walk <code>1.3.6.1.2.1.2.2.1.2</code> to discover interface names and indexes.</p>
              </div>
            </section>
            <section class="snmp-discovery traffic-discovery" data-traffic-discovery hidden>
              <div class="snmp-discovery-head">
                <div>
                  <strong>Interface Traffic Discovery</strong>
                  <span>Discover ports, pair each index with inbound/outbound HC octet counters, and create traffic sensors.</span>
                </div>
                <button class="mini-action" type="button" data-action="scan-interface-traffic">${icon("radar")} Scan Ports</button>
              </div>
              <div class="snmp-discovery-results" data-traffic-discovery-results>
                <p>Uses <code>1.3.6.1.2.1.2.2.1.2</code> for port names, then maps inbound <code>1.3.6.1.2.1.31.1.1.1.6.X</code> and outbound <code>1.3.6.1.2.1.31.1.1.1.10.X</code>.</p>
              </div>
            </section>
          </div>
        </div>
        <div class="modal-note" data-form-message="sensor">ICMP uses the selected device host. Choose SNMP to enter OID, community, and port.</div>
        <div class="modal-actions">
          <button class="ghost-button" type="button" data-action="close-dialog">Cancel</button>
          <button class="primary-button" type="submit">Save & Check</button>
        </div>
      </form>
    </dialog>
  `;
}

function renderOidGuideItem(item) {
  return `
    <article class="oid-guide-item">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <code>${escapeHtml(item.oid)}</code>
        <p>${escapeHtml(item.description)}</p>
      </div>
      <button
        class="mini-action"
        type="button"
        data-action="use-oid"
        data-oid="${escapeAttribute(item.oid)}"
        data-name="${escapeAttribute(item.name)}"
        data-unit="${escapeAttribute(item.unit)}"
      >Use</button>
    </article>
  `;
}

function sensorTypeButton(label, text) {
  return `
    <button class="sensor-type" type="button">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(text)}</span>
    </button>
  `;
}

function groupDevices() {
  const map = new Map();
  state.groups.forEach((group) => {
    const name = group.name || "Unassigned";
    if (!map.has(name)) map.set(name, []);
  });
  state.devices.forEach((device) => {
    const group = device.group || "Unassigned";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(device);
  });

  return Array.from(map.entries()).map(([name, devices]) => ({
    name,
    devices,
    status: aggregateStatus(devices.map((device) => device.status || "unknown")),
  }));
}

function aggregateStatus(statuses) {
  const sorted = [...statuses].sort((a, b) => statusRank.indexOf(a) - statusRank.indexOf(b));
  return sorted[0] || "unknown";
}

function statusBadge(status = "unknown") {
  const normalized = statusLabels[status] ? status : "unknown";
  return `<span class="status-badge ${normalized}"><span></span>${statusLabels[normalized]}</span>`;
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function deviceName(deviceId) {
  const device = state.devices.find((item) => String(item.id) === String(deviceId));
  return device?.name || device?.host || "-";
}

function viewTitle() {
  const titles = {
    dashboard: "Command Dashboard",
    devices: "Device Inventory",
    sensors: "Sensor Console",
    events: "Alert Timeline",
    "device-detail": "Device Detail",
    "sensor-detail": "Sensor Detail",
  };
  return titles[state.activeView] || titles.dashboard;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.querySelectorAll(".tree-device[data-device-id], .topology-node[data-device-id], tr[data-device-id]").forEach((element) => {
    element.addEventListener("click", () => {
      if (element.dataset.dragged === "true") {
        element.dataset.dragged = "false";
        return;
      }
      setView("device-detail", { deviceId: element.dataset.deviceId });
    });
  });

  document.querySelectorAll(".topology-node[data-device-id]").forEach((element) => {
    element.addEventListener("pointerdown", startTopologyDrag);
  });

  document.querySelectorAll("[data-sensor-id]").forEach((element) => {
    element.addEventListener("click", () => setView("sensor-detail", { sensorId: element.dataset.sensorId }));
  });

  document.querySelectorAll("[data-action='refresh']").forEach((button) => {
    button.addEventListener("click", loadData);
  });

  document.querySelectorAll("[data-action='open-device-modal']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      state.pendingDeviceGroup = button.dataset.groupName || "";
      render();
      document.querySelector("#device-modal")?.showModal();
    });
  });

  document.querySelectorAll("[data-action='open-sensor-modal']").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const deviceId = button.dataset.deviceId || state.selectedDeviceId;
      if (!deviceId) return;
      state.selectedDeviceId = deviceId;
      state.activeView = "device-detail";
      state.snmpDiscovery = null;
      state.interfaceDiscovery = null;
      render();
      document.querySelector("#sensor-modal")?.showModal();
    });
  });

  document.querySelectorAll("[data-action='open-group-modal']").forEach((button) => {
    button.addEventListener("click", () => document.querySelector("#group-modal")?.showModal());
  });

  document.querySelectorAll("[data-action='close-dialog']").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });

  document.querySelectorAll("[data-action='check-sensor']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await checkSensor(button.dataset.checkSensorId);
    });
  });

  document.querySelectorAll("[data-action='delete-sensor']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteSensor(button.dataset.deleteSensorId);
    });
  });

  document.querySelectorAll("[data-action='delete-device']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteDevice(button.dataset.deleteDeviceId);
    });
  });

  document.querySelectorAll("[data-action='delete-group']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteGroup(button.dataset.deleteGroupName);
    });
  });

  document.querySelectorAll("[data-action='use-oid']").forEach((button) => {
    button.addEventListener("click", () => applyOidGuide(button));
  });

  document.querySelectorAll("[data-action='scan-snmp-walk']").forEach((button) => {
    button.addEventListener("click", async () => scanSnmpWalk(button.closest("form")));
  });

  document.querySelectorAll("[data-action='create-discovered-sensors']").forEach((button) => {
    button.addEventListener("click", async () => createDiscoveredSnmpSensors(button.closest("form")));
  });

  document.querySelectorAll("[data-action='scan-interface-traffic']").forEach((button) => {
    button.addEventListener("click", async () => scanInterfaceTraffic(button.closest("form")));
  });

  document.querySelectorAll("[data-action='create-traffic-sensors']").forEach((button) => {
    button.addEventListener("click", async () => createTrafficSensors(button.closest("form")));
  });

  document.querySelectorAll("[data-action='check-now']").forEach((button) => {
    button.addEventListener("click", checkAllSensors);
  });

  document.querySelector("[data-form='device']")?.addEventListener("submit", saveDevice);
  document.querySelector("[data-form='group']")?.addEventListener("submit", saveGroup);
  document.querySelector("[data-form='device-group']")?.addEventListener("submit", saveDeviceGroup);
  const sensorForm = document.querySelector("[data-form='sensor']");
  sensorForm?.addEventListener("submit", saveSensor);
  sensorForm?.querySelectorAll("input[name='type']").forEach((input) => {
    input.addEventListener("change", () => updateSensorTypeFields(sensorForm));
  });
  if (sensorForm) updateSensorTypeFields(sensorForm);
  syncTableScrollbars();
  if (state.activeView === "sensor-detail" && state.selectedSensorId) {
    loadSensorSamples(state.selectedSensorId);
  }
}

function syncTableScrollbars() {
  document.querySelectorAll(".scrollable-table-shell").forEach((shell) => {
    const top = shell.querySelector("[data-table-scroll-top]");
    const topInner = top?.firstElementChild;
    const body = shell.querySelector("[data-table-scroll-body]");
    const table = body?.querySelector("table");
    if (!top || !topInner || !body || !table) return;

    const update = () => {
      topInner.style.width = `${table.scrollWidth}px`;
      top.hidden = body.scrollWidth <= body.clientWidth + 1;
    };

    let syncing = false;
    top.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      body.scrollLeft = top.scrollLeft;
      syncing = false;
    });
    body.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      top.scrollLeft = body.scrollLeft;
      syncing = false;
    });
    update();
    requestAnimationFrame(update);
  });
}

function startTopologyDrag(event) {
  event.preventDefault();
  const node = event.currentTarget;
  const map = node.closest(".topology-map");
  if (!map) return;

  state.draggingNode = {
    deviceId: node.dataset.deviceId,
    node,
    map,
    moved: false,
  };
  node.classList.add("dragging");
  node.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", moveTopologyDrag);
  window.addEventListener("pointerup", endTopologyDrag, { once: true });
}

function moveTopologyDrag(event) {
  if (!state.draggingNode) return;
  const { node, map } = state.draggingNode;
  const rect = map.getBoundingClientRect();
  const x = clamp(((event.clientX - rect.left) / rect.width) * 100, 5, 95);
  const y = clamp(((event.clientY - rect.top) / rect.height) * 100, 8, 92);
  node.style.left = `${x}%`;
  node.style.top = `${y}%`;
  node.dataset.x = String(x);
  node.dataset.y = String(y);
  state.draggingNode.moved = true;
}

async function endTopologyDrag(event) {
  window.removeEventListener("pointermove", moveTopologyDrag);
  const drag = state.draggingNode;
  state.draggingNode = null;
  if (!drag) return;
  drag.node.classList.remove("dragging");

  if (!drag.moved) {
    setView("device-detail", { deviceId: drag.deviceId });
    return;
  }

  drag.node.dataset.dragged = "true";
  const x = Number(drag.node.dataset.x);
  const y = Number(drag.node.dataset.y);
  try {
    await apiRequest(`/api/devices/${drag.deviceId}/topology`, {
      method: "POST",
      body: { x, y },
    });
    const device = state.devices.find((item) => String(item.id) === String(drag.deviceId));
    if (device) {
      device.topologyX = x;
      device.topologyY = y;
    }
  } catch (error) {
    await loadData();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateSensorTypeFields(form) {
  const type = form.querySelector("input[name='type']:checked")?.value || "icmp";
  const snmpFields = form.querySelector("[data-snmp-fields]");
  const nameInput = form.querySelector("input[name='name']");
  const message = form.querySelector("[data-form-message='sensor']");
  const isSnmp = type === "snmp";
  const isTraffic = type === "snmp_traffic";

  if (snmpFields) snmpFields.hidden = !(isSnmp || isTraffic);
  form.querySelectorAll("[data-snmp-get-only]").forEach((element) => {
    element.hidden = !isSnmp;
  });
  form.querySelectorAll("[data-traffic-discovery]").forEach((element) => {
    element.hidden = !isTraffic;
  });
  if (nameInput) {
    nameInput.placeholder = isTraffic ? "Traffic" : isSnmp ? "SNMP Uptime" : "ICMP Ping";
  }
  if (message) {
    if (isTraffic) {
      message.textContent = "Scan interfaces and create one inbound/outbound traffic sensor per port.";
    } else {
      message.textContent = isSnmp
        ? "Enter the SNMP v2c OID, community, and UDP port for this device."
        : "ICMP uses the selected device host. No SNMP parameters are required.";
    }
  }
}

function applyOidGuide(button) {
  const form = button.closest("form");
  if (!form) return;
  const nameInput = form.querySelector("input[name='name']");
  const oidInput = form.querySelector("input[name='oid']");
  const unitInput = form.querySelector("input[name='unit']");
  const message = form.querySelector("[data-form-message='sensor']");

  if (nameInput) nameInput.value = button.dataset.name || "";
  if (oidInput) oidInput.value = button.dataset.oid || "";
  if (unitInput) unitInput.value = button.dataset.unit || "";
  if (message) {
    message.textContent = (button.dataset.oid || "").includes("{ifIndex}")
      ? "This OID needs an interface index. Replace {ifIndex} with the target port index before saving."
      : "OID guide value applied. You can save or adjust the fields.";
  }
}

function renderSnmpDiscoveryResults(items) {
  if (!items.length) {
    return `<p>No rows found under this OID. Check the base OID, community, and SNMP access.</p>`;
  }

  const visibleItems = items.slice(0, 40);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  return `
    <p>Found ${items.length} indexed row(s). These will be created as individual SNMP GET sensors.</p>
    <div class="snmp-discovery-list">
      ${visibleItems
        .map(
          (item) => `
            <div class="snmp-discovery-row">
              <strong>#${escapeHtml(item.index || "-")}</strong>
              <span>${escapeHtml(item.value || "-")}</span>
              <code>${escapeHtml(item.oid || "")}</code>
            </div>
          `
        )
        .join("")}
    </div>
    ${hiddenCount ? `<p>${hiddenCount} more row(s) are hidden from preview but will still be created.</p>` : ""}
    <div class="snmp-discovery-actions">
      <button class="primary-button" type="button" data-action="create-discovered-sensors">${icon("plus")} Create ${items.length} Sensors</button>
    </div>
  `;
}

function renderTrafficDiscoveryResults(items) {
  if (!items.length) {
    return `<p>No interfaces found. Check SNMP access or try a device that exposes IF-MIB.</p>`;
  }

  const visibleItems = items.slice(0, 40);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  return `
    <p>Found ${items.length} interface(s). Each one will become a traffic sensor with inbound and outbound counters.</p>
    <div class="traffic-discovery-list">
      ${visibleItems
        .map(
          (item) => `
            <div class="traffic-discovery-row">
              <strong>#${escapeHtml(item.index || "-")}</strong>
              <span>
                <b>${escapeHtml(item.name || "-")}</b>
                <small>${escapeHtml([item.description, item.speedBps ? `Speed ${formatRate(item.speedBps)}` : ""].filter(Boolean).join(" · ") || "No description")}</small>
              </span>
              <code>SPEED ${escapeHtml(item.speedOid || "")}</code>
              <code>IN ${escapeHtml(item.inOid || "")}</code>
              <code>OUT ${escapeHtml(item.outOid || "")}</code>
            </div>
          `
        )
        .join("")}
    </div>
    ${hiddenCount ? `<p>${hiddenCount} more interface(s) are hidden from preview but will still be created.</p>` : ""}
    <div class="snmp-discovery-actions">
      <button class="primary-button" type="button" data-action="create-traffic-sensors">${icon("plus")} Create ${items.length} Traffic Sensors</button>
    </div>
  `;
}

async function scanSnmpWalk(form) {
  if (!form) return;
  const message = form.querySelector("[data-form-message='sensor']");
  const results = form.querySelector("[data-snmp-discovery-results]");
  const data = new FormData(form);
  const deviceId = state.selectedDeviceId;
  try {
    if (!deviceId) throw new Error("Select a device from the monitoring tree first.");
    const baseOid = String(data.get("oid") || "").trim();
    if (!baseOid) throw new Error("Enter a discovery base OID first.");
    state.snmpDiscovery = null;
    if (message) message.textContent = `Walking ${baseOid}...`;
    if (results) results.innerHTML = `<p>Scanning SNMP table. This may take a few seconds.</p>`;
    const payload = await apiRequest(`/api/devices/${deviceId}/snmp/walk`, {
      method: "POST",
      body: {
        baseOid,
        community: data.get("community"),
        port: Number(data.get("port") || 161),
        limit: 128,
      },
    });
    state.snmpDiscovery = {
      deviceId,
      baseOid: payload.baseOid,
      items: payload.items || [],
    };
    if (results) {
      results.innerHTML = renderSnmpDiscoveryResults(state.snmpDiscovery.items);
      results.querySelector("[data-action='create-discovered-sensors']")?.addEventListener("click", async () => {
        await createDiscoveredSnmpSensors(form);
      });
    }
    if (message) message.textContent = `SNMP walk completed. Found ${payload.count || 0} row(s).`;
  } catch (error) {
    if (results) results.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    if (message) message.textContent = error.message;
  }
}

async function scanInterfaceTraffic(form) {
  if (!form) return;
  const message = form.querySelector("[data-form-message='sensor']");
  const results = form.querySelector("[data-traffic-discovery-results]");
  const data = new FormData(form);
  const deviceId = state.selectedDeviceId;
  try {
    if (!deviceId) throw new Error("Select a device from the monitoring tree first.");
    state.interfaceDiscovery = null;
    if (message) message.textContent = "Discovering interface traffic counters...";
    if (results) results.innerHTML = `<p>Scanning interface table. This may take a few seconds.</p>`;
    const payload = await apiRequest(`/api/devices/${deviceId}/interfaces/discover`, {
      method: "POST",
      body: {
        community: data.get("community"),
        port: Number(data.get("port") || 161),
        limit: 128,
      },
    });
    state.interfaceDiscovery = {
      deviceId,
      interfaces: payload.interfaces || [],
    };
    if (results) {
      results.innerHTML = renderTrafficDiscoveryResults(state.interfaceDiscovery.interfaces);
      results.querySelector("[data-action='create-traffic-sensors']")?.addEventListener("click", async () => {
        await createTrafficSensors(form);
      });
    }
    if (message) message.textContent = `Interface discovery completed. Found ${payload.count || 0} interface(s).`;
  } catch (error) {
    if (results) results.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    if (message) message.textContent = error.message;
  }
}

async function createDiscoveredSnmpSensors(form) {
  if (!form) return;
  const message = form.querySelector("[data-form-message='sensor']");
  const data = new FormData(form);
  const deviceId = state.selectedDeviceId;
  const discovery = state.snmpDiscovery;
  try {
    if (!deviceId) throw new Error("Select a device from the monitoring tree first.");
    if (!discovery || String(discovery.deviceId) !== String(deviceId) || !discovery.items?.length) {
      throw new Error("Run SNMP walk discovery first.");
    }
    const baseName = String(data.get("name") || "").trim() || "SNMP";
    const sensors = discovery.items.map((item) => {
      const label = item.value || `index ${item.index}`;
      return {
        name: `${baseName} ${label}`,
        interval: Number(data.get("interval") || 30),
        oid: item.oid,
        unit: data.get("unit"),
        community: data.get("community"),
        port: Number(data.get("port") || 161),
      };
    });
    if (message) message.textContent = `Creating ${sensors.length} SNMP sensor(s)...`;
    await apiRequest(`/api/devices/${deviceId}/sensors/bulk`, {
      method: "POST",
      body: { sensors },
    });
    state.snmpDiscovery = null;
    form.closest("dialog")?.close();
    form.reset();
    await loadData();
  } catch (error) {
    if (message) message.textContent = error.message;
  }
}

async function createTrafficSensors(form) {
  if (!form) return;
  const message = form.querySelector("[data-form-message='sensor']");
  const data = new FormData(form);
  const deviceId = state.selectedDeviceId;
  const discovery = state.interfaceDiscovery;
  try {
    if (!deviceId) throw new Error("Select a device from the monitoring tree first.");
    if (!discovery || String(discovery.deviceId) !== String(deviceId) || !discovery.interfaces?.length) {
      throw new Error("Run interface traffic discovery first.");
    }
    const baseName = String(data.get("name") || "").trim() || "Traffic";
    const interfaces = discovery.interfaces.map((item) => ({
      ...item,
      sensorName: `${baseName} ${item.name || `ifIndex ${item.index}`}`,
    }));
    if (message) message.textContent = `Creating ${interfaces.length} traffic sensor(s)...`;
    await apiRequest(`/api/devices/${deviceId}/interfaces/traffic-sensors`, {
      method: "POST",
      body: {
        interfaces,
        interval: Number(data.get("interval") || 30),
        community: data.get("community"),
        port: Number(data.get("port") || 161),
      },
    });
    state.interfaceDiscovery = null;
    form.closest("dialog")?.close();
    form.reset();
    await loadData();
  } catch (error) {
    if (message) message.textContent = error.message;
  }
}

async function saveDevice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector("[data-form-message='device']");
  const data = new FormData(form);
  try {
    message.textContent = "Saving device...";
    await apiRequest("/api/devices", {
      method: "POST",
      body: {
        name: data.get("name"),
        host: data.get("host"),
        group: data.get("group"),
        notes: data.get("notes"),
        snmpEnabled: data.get("snmpEnabled") === "on",
        snmpCommunity: data.get("snmpCommunity"),
        snmpPort: Number(data.get("snmpPort") || 161),
      },
    });
    form.closest("dialog")?.close();
    form.reset();
    state.pendingDeviceGroup = "";
    await loadData();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector("[data-form-message='group']");
  const data = new FormData(form);
  try {
    message.textContent = "Saving group...";
    await apiRequest("/api/groups", {
      method: "POST",
      body: { name: data.get("name") },
    });
    form.closest("dialog")?.close();
    form.reset();
    await loadData();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function saveDeviceGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const deviceId = form.dataset.deviceId;
  const data = new FormData(form);
  await apiRequest(`/api/devices/${deviceId}/group`, {
    method: "POST",
    body: { group: data.get("group") },
  });
  await loadData();
  setView("device-detail", { deviceId });
}

async function saveSensor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = form.querySelector("[data-form-message='sensor']");
  const data = new FormData(form);
  const deviceId = state.selectedDeviceId;
  try {
    if (!deviceId) throw new Error("Select a device from the monitoring tree first.");
    if (data.get("type") === "snmp_traffic") {
      throw new Error("Use Scan Ports, then Create Traffic Sensors.");
    }
    message.textContent = "Saving sensor and running first check...";
    await apiRequest(`/api/devices/${deviceId}/sensors`, {
      method: "POST",
      body: {
        type: data.get("type"),
        name: data.get("name"),
        interval: Number(data.get("interval") || 30),
        oid: data.get("oid"),
        unit: data.get("unit"),
        community: data.get("community"),
        port: Number(data.get("port") || 161),
      },
    });
    form.closest("dialog")?.close();
    form.reset();
    await loadData();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function checkSensor(sensorId) {
  if (!sensorId) return;
  await apiRequest(`/api/sensors/${sensorId}/check-now`, { method: "POST" });
  delete state.sensorSamples[String(sensorId)];
  await loadData();
}

async function loadSensorSamples(sensorId) {
  const key = String(sensorId);
  if (state.sensorSamples[key] || state.sensorSamplesLoading[key]) return;
  state.sensorSamplesLoading[key] = true;
  try {
    const samples = await fetchJson(`/api/sensors/${sensorId}/samples`);
    state.sensorSamples[key] = normalizeList(samples);
  } catch {
    state.sensorSamples[key] = [];
  } finally {
    state.sensorSamplesLoading[key] = false;
    if (state.activeView === "sensor-detail" && String(state.selectedSensorId) === key) {
      render();
    }
  }
}

async function deleteSensor(sensorId) {
  if (!sensorId) return;
  const sensor = state.sensors.find((item) => String(item.id) === String(sensorId));
  const name = sensor?.name || "this sensor";
  if (!window.confirm(`Delete ${name}? This removes its samples and alert events.`)) return;
  await apiRequest(`/api/sensors/${sensorId}`, { method: "DELETE" });
  if (String(state.selectedSensorId) === String(sensorId)) {
    state.activeView = "sensors";
    state.selectedSensorId = null;
  }
  await loadData();
}

async function deleteDevice(deviceId) {
  if (!deviceId) return;
  const device = state.devices.find((item) => String(item.id) === String(deviceId));
  const name = device?.name || "this device";
  if (!window.confirm(`Delete ${name}? This removes its sensors, samples, and alert events.`)) return;
  await apiRequest(`/api/devices/${deviceId}`, { method: "DELETE" });
  if (String(state.selectedDeviceId) === String(deviceId)) {
    state.activeView = "dashboard";
    state.selectedDeviceId = null;
    state.selectedSensorId = null;
  }
  await loadData();
}

async function deleteGroup(groupName) {
  if (!groupName) return;
  const devices = state.devices.filter((device) => device.group === groupName);
  if (!window.confirm(`Delete group ${groupName}? This deletes ${devices.length} device(s) and all related sensors.`)) return;
  await apiRequest(`/api/groups/${encodeURIComponent(groupName)}`, { method: "DELETE" });
  state.activeView = "dashboard";
  state.selectedDeviceId = null;
  state.selectedSensorId = null;
  await loadData();
}

async function checkAllSensors() {
  for (const sensor of state.sensors) {
    await apiRequest(`/api/sensors/${sensor.id}/check-now`, { method: "POST" });
  }
  await loadData();
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
    trash: '<svg viewBox="0 0 24 24"><path d="M7 4h10l1 2h4v2h-2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8H2V6h4l1-2Zm1.2 4H6v12h12V8H8.2ZM9 10h2v8H9v-8Zm4 0h2v8h-2v-8Z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L19 6.4 6.4 19 5 17.6 17.6 5Z"/></svg>',
    radar: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Zm1 3v7l5 5 1.4-1.4-4.4-4.4V5h-2Zm-1 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>',
  };
  return icons[name] || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

initRouting();
loadData();
