import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";

const emptySummary = { devices: 0, sensors: 0, up: 0, warning: 0, down: 0, unknown: 0 };
const statusLabels = { up: "Up", warning: "Warning", down: "Critical", unknown: "Unknown", paused: "Paused" };
const statusRank = ["down", "warning", "unknown", "paused", "up"];
const deviceSerialNumberOid = "1.3.6.1.2.1.47.1.1.1.1.11";
const chartPlot = { left: 82, right: 744, top: 36, bottom: 268 };
chartPlot.width = chartPlot.right - chartPlot.left;
chartPlot.height = chartPlot.bottom - chartPlot.top;
const chartTimeStepMs = 30 * 1000;
const chartVisibleWindowMs = 10 * 60 * 1000;
const authTokenStorageKey = "networkManagerAuthToken";

const snmpOidGuide = [
  { name: "System Description", oid: "1.3.6.1.2.1.1.1.0", unit: "", description: "Device model, OS, firmware, or system text." },
  { name: "System Uptime", oid: "1.3.6.1.2.1.1.3.0", unit: "ticks", description: "Time since device SNMP agent started, in hundredths of a second." },
  { name: "Hostname", oid: "1.3.6.1.2.1.1.5.0", unit: "", description: "Device system name." },
  { name: "Device Serial Number", oid: deviceSerialNumberOid, unit: "", action: "serial-number", description: "Walks the serial-number table and creates a sensor from the first non-empty value." },
  { name: "Interface Description", oid: "1.3.6.1.2.1.2.2.1.2.{ifIndex}", unit: "", description: "Port/interface label. Replace {ifIndex}, for example .2.1.2.1." },
];

function authHeaders() {
  const token = window.localStorage.getItem(authTokenStorageKey);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const error = new Error(payload.error || "Authentication required.");
    error.status = 401;
    error.payload = payload;
    throw error;
  }
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
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

function icon(name) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24"><path d="M3 4h8v8H3V4Zm10 0h8v5h-8V4ZM3 14h8v6H3v-6Zm10-3h8v9h-8v-9Z"/></svg>',
    server: '<svg viewBox="0 0 24 24"><path d="M4 3h16v8H4V3Zm2 2v4h12V5H6Zm-2 8h16v8H4v-8Zm2 2v4h12v-4H6Zm1-9h2v2H7V6Zm0 10h2v2H7v-2Z"/></svg>',
    sensor: '<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 1 4 4v5.2a6 6 0 1 1-8 0V6a4 4 0 0 1 4-4Zm-2 12-.4.3A4 4 0 1 0 14.4 14l-.4-.3V6a2 2 0 1 0-4 0v8Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2Zm0 4 6.6 12H5.4L12 6Zm-1 4h2v5h-2v-5Zm0 6h2v2h-2v-2Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.3L13 11h8V3l-3.3 3.3Z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>',
    radar: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm1 1v9h7v-2h-4.2l4.8-4.8-1.4-1.4-4.8 4.8V4h-1.4Z"/></svg>',
  };
  return <span dangerouslySetInnerHTML={{ __html: icons[name] || "" }} />;
}

function App() {
  const [route, setRouteState] = useState(() => parseRouteHash());
  const [data, setData] = useState({ loading: true, apiOnline: false, summary: emptySummary, devices: [], groups: [], sensors: [], events: [] });
  const [auth, setAuth] = useState({ loading: true, authenticated: false, setupRequired: false, authDisabled: false, user: null, error: "" });
  const [modal, setModal] = useState(null);
  const [deviceDetailTabs, setDeviceDetailTabs] = useState({});
  const [portSamples, setPortSamples] = useState({});
  const [sensorSamples, setSensorSamples] = useState({});
  const [sensorSamplesLoading, setSensorSamplesLoading] = useState({});
  const [sensorThresholds, setSensorThresholds] = useState({});
  const [sensorThresholdsLoading, setSensorThresholdsLoading] = useState({});
  const [pending, setPending] = useState(null);
  const [toast, setToast] = useState("");

  const loadAuth = useCallback(async () => {
    try {
      const payload = await apiRequest("/api/auth/me");
      setAuth({
        loading: false,
        authenticated: !!payload.authenticated || !!payload.authDisabled,
        setupRequired: !!payload.setupRequired,
        authDisabled: !!payload.authDisabled,
        user: payload.user || null,
        error: "",
      });
      return payload;
    } catch (error) {
      setAuth((current) => ({ ...current, loading: false, authenticated: false, setupRequired: !!error.payload?.setupRequired, error: error.message }));
      return null;
    }
  }, []);

  const loadData = useCallback(async ({ showLoading = false } = {}) => {
    if (showLoading) setData((current) => ({ ...current, loading: true }));
    try {
      const [summary, devices, groups, sensors, events] = await Promise.all([
        apiRequest("/api/summary"),
        apiRequest("/api/devices"),
        apiRequest("/api/groups"),
        apiRequest("/api/sensors"),
        apiRequest("/api/events"),
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
    } catch (error) {
      setData((current) => ({ ...current, loading: false, apiOnline: false }));
      if (error.status === 401) {
        window.localStorage.removeItem(authTokenStorageKey);
        setAuth((current) => ({ ...current, authenticated: false, setupRequired: !!error.payload?.setupRequired, error: error.message }));
      }
      setToast(error.message);
    }
  }, []);

  const setRoute = useCallback((next) => {
    setRouteState((previous) => {
      window.history.pushState(next, "", routeHash(next));
      return next;
    });
  }, []);

  useEffect(() => {
    window.history.replaceState(route, "", routeHash(route));
    const onPopState = (event) => setRouteState(event.state || parseRouteHash());
    window.addEventListener("popstate", onPopState);
    loadAuth().then((payload) => {
      if (payload?.authDisabled || payload?.authenticated) loadData({ showLoading: true });
    });
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!["dashboard", "events"].includes(route.view)) return undefined;
    const timer = window.setInterval(() => loadData({ showLoading: false }), 10000);
    return () => window.clearInterval(timer);
  }, [route.view, loadData]);

  const selectedDevice = data.devices.find((device) => String(device.id) === String(route.deviceId));
  const selectedSensor = data.sensors.find((sensor) => String(sensor.id) === String(route.sensorId));
  const selectedDeviceSensors = selectedDevice ? data.sensors.filter((sensor) => String(sensor.deviceId) === String(selectedDevice.id)) : [];
  const selectedPortSensors = selectedDeviceSensors.filter((sensor) => sensor.type === "snmp_traffic");
  const activeDeviceTab = deviceDetailTabs[String(selectedDevice?.id || "")] || (selectedPortSensors.length ? "ports" : "sensors");

  const refreshPortSamples = useCallback(async (deviceId, { force = false } = {}) => {
    if (!deviceId) return;
    if (!force && portSamples[String(deviceId)]) return;
    const samples = await apiRequest(`/api/devices/${deviceId}/traffic-samples?limit=24`);
    setPortSamples((current) => ({ ...current, [deviceId]: samples?.samples || {} }));
  }, [portSamples]);

  useEffect(() => {
    if (route.view !== "device-detail" || activeDeviceTab !== "ports" || !route.deviceId || !selectedPortSensors.length) return undefined;
    let cancelled = false;
    async function refreshPortData() {
      try {
        const [sensors, samples] = await Promise.all([
          apiRequest("/api/sensors"),
          apiRequest(`/api/devices/${route.deviceId}/traffic-samples?limit=24`),
        ]);
        if (cancelled) return;
        setData((current) => ({ ...current, sensors: normalizeList(sensors) }));
        setPortSamples((current) => ({ ...current, [route.deviceId]: samples?.samples || {} }));
      } catch (error) {
        if (!cancelled) setToast(error.message);
      }
    }
    refreshPortData();
    const timer = window.setInterval(refreshPortData, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.view, route.deviceId, activeDeviceTab, selectedPortSensors.length]);

  useEffect(() => {
    if (route.view !== "sensor-detail" || !route.sensorId) return undefined;
    const sensorId = String(route.sensorId);
    let cancelled = false;
    async function refreshSensorDetail() {
      setSensorSamplesLoading((current) => ({ ...current, [sensorId]: true }));
      setSensorThresholdsLoading((current) => ({ ...current, [sensorId]: true }));
      try {
        const thresholdEndpoint = selectedSensor?.type === "snmp_traffic" ? "threshold-rules" : "thresholds";
        const [sensors, samples, threshold] = await Promise.all([
          apiRequest("/api/sensors"),
          apiRequest(`/api/sensors/${sensorId}/samples`),
          apiRequest(`/api/sensors/${sensorId}/${thresholdEndpoint}`),
        ]);
        if (cancelled) return;
        setData((current) => ({ ...current, sensors: normalizeList(sensors) }));
        setSensorSamples((current) => ({ ...current, [sensorId]: normalizeList(samples) }));
        setSensorThresholds((current) => ({ ...current, [sensorId]: threshold }));
      } catch (error) {
        if (!cancelled) setToast(error.message);
      } finally {
        if (!cancelled) setSensorSamplesLoading((current) => ({ ...current, [sensorId]: false }));
        if (!cancelled) setSensorThresholdsLoading((current) => ({ ...current, [sensorId]: false }));
      }
    }
    refreshSensorDetail();
    const timer = window.setInterval(refreshSensorDetail, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [route.view, route.sensorId, selectedSensor?.type]);

  const runAction = useCallback(async (label, fn) => {
    setPending(label);
    setToast("");
    try {
      const result = await fn();
      await loadData({ showLoading: false });
      return result;
    } catch (error) {
      setToast(error.message);
      throw error;
    } finally {
      setPending(null);
    }
  }, [loadData]);

  const actions = useMemo(() => ({
    openModal: setModal,
    closeModal: () => setModal(null),
    refresh: () => loadData({ showLoading: false }),
    setAuth,
    loadAuth,
    logout: async () => {
      try {
        await apiRequest("/api/auth/logout", { method: "POST" });
      } catch {
        // Local token removal is enough when the backend cannot be reached.
      }
      window.localStorage.removeItem(authTokenStorageKey);
      setAuth({ loading: false, authenticated: false, setupRequired: false, authDisabled: false, user: null, error: "" });
      setData((current) => ({ ...current, apiOnline: false, devices: [], groups: [], sensors: [], events: [], summary: emptySummary }));
    },
    setRoute,
    setDeviceDetailTab: (deviceId, tab) => setDeviceDetailTabs((current) => ({ ...current, [deviceId]: tab })),
    refreshPortSamples,
    saveDevice: (payload) => runAction("save-device", () => apiRequest("/api/devices", { method: "POST", body: payload })),
    saveGroup: (payload) => runAction("save-group", () => apiRequest("/api/groups", { method: "POST", body: payload })),
    saveDeviceGroup: (deviceId, payload) => runAction("save-device-group", () => apiRequest(`/api/devices/${deviceId}/group`, { method: "POST", body: payload })),
    saveSensor: (deviceId, payload) => runAction("save-sensor", () => apiRequest(`/api/devices/${deviceId}/sensors`, { method: "POST", body: payload })),
    createDiscoveredSensors: (deviceId, payload) => runAction("bulk-sensors", () => apiRequest(`/api/devices/${deviceId}/sensors/bulk`, { method: "POST", body: payload })),
    scanSnmp: (deviceId, payload) => apiRequest(`/api/devices/${deviceId}/snmp/walk`, { method: "POST", body: payload }),
    scanTraffic: (deviceId, payload) => apiRequest(`/api/devices/${deviceId}/interfaces/discover`, { method: "POST", body: payload }),
    createTrafficSensors: (deviceId, payload) => runAction("traffic-sensors", () => apiRequest(`/api/devices/${deviceId}/interfaces/traffic-sensors`, { method: "POST", body: payload })),
    checkSensor: (sensorId) => runAction(`check-${sensorId}`, async () => {
      const updated = await apiRequest(`/api/sensors/${sensorId}/check-now`, { method: "POST" });
      setSensorSamples((current) => ({ ...current, [sensorId]: undefined }));
      if (updated?.deviceId) await refreshPortSamples(updated.deviceId, { force: true });
      return updated;
    }),
    checkAllSensors: () => runAction("check-all", async () => {
      for (const sensor of data.sensors) await apiRequest(`/api/sensors/${sensor.id}/check-now`, { method: "POST" });
    }),
    deleteSensor: (sensor) => runAction(`delete-sensor-${sensor.id}`, async () => {
      if (!window.confirm(`Delete ${sensor.name || "this sensor"}? This removes its samples and alert events.`)) return null;
      return apiRequest(`/api/sensors/${sensor.id}`, { method: "DELETE" });
    }),
    deleteDevice: (device) => runAction(`delete-device-${device.id}`, async () => {
      if (!window.confirm(`Delete ${device.name || "this device"}? This removes its sensors, samples, and alert events.`)) return null;
      const result = await apiRequest(`/api/devices/${device.id}`, { method: "DELETE" });
      setRoute({ view: "dashboard" });
      return result;
    }),
    deleteGroup: (group) => runAction(`delete-group-${group.name}`, async () => {
      if (!window.confirm(`Delete group ${group.name}? This deletes ${group.devices.length} device(s) and all related sensors.`)) return null;
      return apiRequest(`/api/groups/${encodeURIComponent(group.name)}`, { method: "DELETE" });
    }),
    saveTopology: (deviceId, payload) => apiRequest(`/api/devices/${deviceId}/topology`, { method: "POST", body: payload }).then(() => loadData({ showLoading: false })),
    saveThreshold: (sensorId, payload) => runAction(`threshold-${sensorId}`, async () => {
      const threshold = await apiRequest(`/api/sensors/${sensorId}/thresholds`, { method: "PUT", body: payload });
      setSensorThresholds((current) => ({ ...current, [sensorId]: threshold }));
      return threshold;
    }),
    saveThresholdRules: (sensorId, payload) => runAction(`threshold-rules-${sensorId}`, async () => {
      const threshold = await apiRequest(`/api/sensors/${sensorId}/threshold-rules`, { method: "PUT", body: payload });
      setSensorThresholds((current) => ({ ...current, [sensorId]: threshold }));
      return threshold;
    }),
  }), [data.sensors, loadAuth, loadData, refreshPortSamples, runAction, setRoute]);

  const content = data.loading ? (
    <main className="single-view">{emptyState("Loading", "Fetching live network state...")}</main>
  ) : (
    <CurrentView
      route={route}
      data={data}
      selectedDevice={selectedDevice}
      selectedSensor={selectedSensor}
      deviceDetailTab={activeDeviceTab}
      portSamples={portSamples}
      sensorSamples={sensorSamples}
      sensorSamplesLoading={sensorSamplesLoading}
      sensorThresholds={sensorThresholds}
      sensorThresholdsLoading={sensorThresholdsLoading}
      actions={actions}
      pending={pending}
    />
  );

  if (auth.loading) return <main className="auth-shell">{emptyState("Loading", "Checking access...")}</main>;
  if (!auth.authenticated || auth.setupRequired) {
    return <AuthScreen auth={auth} setAuth={setAuth} loadData={loadData} />;
  }

  return (
    <div className="noc-shell">
      <Sidebar data={data} route={route} actions={actions} />
      <div className="noc-main">
        <Header route={route} summary={data.summary} apiOnline={data.apiOnline} auth={auth} actions={actions} />
        {toast && <div className="react-toast" role="status">{toast}<button type="button" onClick={() => setToast("")}>{icon("close")}</button></div>}
        {content}
      </div>
      <ModalHost modal={modal} actions={actions} data={data} />
    </div>
  );
}

function CurrentView(props) {
  if (props.route.view === "devices") return <DevicesView {...props} />;
  if (props.route.view === "sensors") return <SensorsView {...props} />;
  if (props.route.view === "events") return <EventsView events={props.data.events} />;
  if (props.route.view === "device-detail") return <DeviceDetail {...props} />;
  if (props.route.view === "sensor-detail") {
    const key = String(props.route.sensorId || "");
    return <SensorDetail sensor={props.selectedSensor} samples={props.sensorSamples[key] || []} loading={!!props.sensorSamplesLoading[key]} threshold={props.sensorThresholds?.[key]} thresholdLoading={!!props.sensorThresholdsLoading?.[key]} actions={props.actions} pending={props.pending} />;
  }
  return <Dashboard {...props} />;
}

function AuthScreen({ auth, setAuth, loadData }) {
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const setup = auth.setupRequired;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setAuth((current) => ({ ...current, error: "" }));
    try {
      const payload = await apiRequest(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: form });
      window.localStorage.setItem(authTokenStorageKey, payload.token || "");
      setAuth({ loading: false, authenticated: true, setupRequired: false, authDisabled: false, user: payload.user || null, error: "" });
      await loadData({ showLoading: true });
    } catch (error) {
      setAuth((current) => ({ ...current, error: error.message }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand auth-brand"><div className="brand-mark">NM</div><div><strong>NetworkManager</strong><span>NOC Console</span></div></div>
        <div><div className="eyebrow">Secure Access</div><h1>{setup ? "Create Admin User" : "Sign In"}</h1><p>{setup ? "Create the first local administrator before opening the console." : "Sign in with your local account to manage monitoring."}</p></div>
        <form onSubmit={submit}>
          <label>Username<input required autoComplete="username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></label>
          <label>Password<input required type="password" minLength={setup ? 8 : 1} autoComplete={setup ? "new-password" : "current-password"} value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} /></label>
          <FormMessage error={auth.error}>{setup ? "Password must be at least 8 characters." : "Use your NetworkManager account."}</FormMessage>
          <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? "Working..." : setup ? "Create Admin" : "Sign In"}</button></div>
        </form>
      </section>
    </main>
  );
}

function Header({ route, summary, apiOnline, auth, actions }) {
  const titles = { dashboard: "Command Dashboard", devices: "Device Inventory", sensors: "Sensor Console", events: "Alert Timeline", "device-detail": "Device Detail", "sensor-detail": "Sensor Detail" };
  return (
    <header className="topbar">
      <div><div className="eyebrow">Local Network Monitoring</div><h1>{titles[route.view] || titles.dashboard}</h1></div>
      <div className="topbar-center">
        <Signal label="Up" value={summary.up} status="up" />
        <Signal label="Warning" value={summary.warning} status="warning" />
        <Signal label="Critical" value={summary.down} status="down" />
        <Signal label="Unknown" value={summary.unknown} status="unknown" />
      </div>
      <div className="topbar-actions">
        {auth?.user && <span className="user-chip">{auth.user.username}</span>}
        {!auth?.authDisabled && <button className="ghost-button" type="button" onClick={actions.logout}>Sign Out</button>}
        <button className="ghost-button" type="button" onClick={actions.refresh}>{icon("refresh")} Refresh</button>
        <button className="primary-button" type="button" onClick={() => actions.openModal({ type: "device" })}>{icon("plus")} Device</button>
      </div>
    </header>
  );
}

function Sidebar({ data, route, actions }) {
  const groups = useMemo(() => groupDevices(data.groups, data.devices), [data.groups, data.devices]);
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">NM</div><div><strong>NetworkManager</strong><span>NOC Console</span></div></div>
      <nav className="nav">
        <NavButton active={route.view === "dashboard"} label="Dashboard" iconName="dashboard" onClick={() => actions.setRoute({ view: "dashboard" })} />
        <NavButton active={route.view === "devices"} label="Devices" iconName="server" onClick={() => actions.setRoute({ view: "devices" })} />
        <NavButton active={route.view === "sensors"} label="Sensors" iconName="sensor" onClick={() => actions.setRoute({ view: "sensors" })} />
        <NavButton active={route.view === "events"} label="Alerts" iconName="alert" onClick={() => actions.setRoute({ view: "events" })} />
      </nav>
      <section className="tree-panel">
        <div className="section-label"><span>Monitoring Tree</span><button className="mini-button" type="button" onClick={() => actions.openModal({ type: "group" })}>{icon("plus")}</button></div>
        <div className="tree-scroll">
          {groups.length ? groups.map((group) => (
            <article className="tree-group" key={group.name}>
              <button className="tree-group-button" type="button">
                <span className={`status-dot ${group.status}`} /><strong>{group.name}</strong><small>{group.devices.length}</small>
                <span className="tree-group-action add" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); actions.openModal({ type: "device", groupName: group.name }); }}>{icon("plus")}</span>
                <span className="tree-group-action" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); actions.deleteGroup(group); }}>{icon("trash")}</span>
              </button>
              {group.devices.map((device) => (
                <button className={`tree-device ${String(device.id) === String(route.deviceId) ? "active" : ""}`} key={device.id} type="button" onClick={() => actions.setRoute({ view: "device-detail", deviceId: device.id })}>
                  <span className={`status-dot ${device.status || "unknown"}`} />
                  <span className="tree-device-name">{device.name || device.host}</span>
                  <span className="tree-device-action" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); actions.openModal({ type: "sensor", deviceId: device.id }); }}>{icon("plus")}</span>
                </button>
              ))}
            </article>
          )) : <div className="tree-empty"><strong>No groups</strong><small>Add a group to start monitoring.</small></div>}
        </div>
      </section>
      <section className="side-status">
        <div className="section-label">Probe Health</div>
        <div className={`probe-card ${data.apiOnline ? "online" : "waiting"}`}><span className="pulse" /><div><strong>{data.apiOnline ? "API Connected" : "API Waiting"}</strong><small>{data.apiOnline ? "Live checks available" : "Backend service not detected"}</small></div></div>
      </section>
    </aside>
  );
}

function NavButton({ active, label, iconName, onClick }) {
  return <button className={active ? "active" : ""} type="button" onClick={onClick}>{icon(iconName)}<span>{label}</span></button>;
}

function Dashboard({ data, actions, pending }) {
  return (
    <main className="dashboard">
      <section className="metrics-row">
        {metricCard("Devices", data.summary.devices, "Managed targets", "cyan")}
        {metricCard("Sensors", data.summary.sensors, "Ping / HTTP / SNMP", "blue")}
        {metricCard("Alerts", (data.summary.warning || 0) + (data.summary.down || 0), "Warning / critical", "amber")}
        {metricCard("Probe", data.apiOnline ? "Online" : "Waiting", "Backend status", data.apiOnline ? "green" : "gray")}
      </section>
      <section className="command-grid">
        <div className="panel topology-panel">
          <div className="panel-head"><div><h2>Network Topology</h2><p>Device positions and relationships.</p></div><button className="ghost-button" type="button" onClick={actions.refresh}>{icon("refresh")} Sync</button></div>
          <Topology devices={data.devices} actions={actions} />
        </div>
        <div className="panel alert-panel"><div className="panel-head"><div><h2>Alert Timeline</h2><p>Recent status transitions</p></div></div><EventsList events={data.events.slice(0, 8)} /></div>
        <div className="panel table-panel">
          <div className="panel-head"><div><h2>Sensor Console</h2><p>Current readings from all monitors</p></div><button className="ghost-button" type="button" disabled={pending === "check-all"} onClick={actions.checkAllSensors}>{icon("play")} Check All</button></div>
          <SensorTable sensors={data.sensors} devices={data.devices} actions={actions} />
        </div>
      </section>
    </main>
  );
}

function DeviceDetail({ selectedDevice, data, deviceDetailTab, portSamples, actions, pending }) {
  if (!selectedDevice) return <main className="single-view">{emptyState("Device not found", "The selected device is not available.")}</main>;
  const sensors = data.sensors.filter((sensor) => String(sensor.deviceId) === String(selectedDevice.id));
  const portSensors = sensors.filter((sensor) => sensor.type === "snmp_traffic");
  const assignedSensors = sensors.filter((sensor) => sensor.type !== "snmp_traffic");
  const activeTab = deviceDetailTab || (portSensors.length ? "ports" : "sensors");
  return (
    <main className="single-view device-detail-view">
      <section className="panel identity-panel device-summary-panel">
        <div className="detail-title device-summary-head"><div><h2>{selectedDevice.name || selectedDevice.host}</h2><p>{selectedDevice.host}</p></div><StatusBadge status={selectedDevice.status} /></div>
        <div className="device-summary-body">
          <DeviceGroupEditor device={selectedDevice} actions={actions} />
          <div className="device-summary-details">
            {detailRow("SNMP", selectedDevice.snmpEnabled ? "Enabled" : "Disabled")}
            {detailRow("SNMP Port", selectedDevice.snmpPort || 161)}
            {detailRow("Notes", selectedDevice.notes || "-")}
          </div>
          <div className="danger-zone"><button className="mini-action danger" type="button" onClick={() => actions.deleteDevice(selectedDevice)}>{icon("trash")} Delete Device</button></div>
        </div>
      </section>
      <section className="panel device-monitor-panel">
        <div className="panel-head">
          <div><h2>{activeTab === "ports" ? "Ports" : "Assigned Sensors"}</h2><p>{activeTab === "ports" ? "Interface traffic sensors attached to this device" : "Non-port checks attached to this device"}</p></div>
          <div className="panel-head-actions">{activeTab === "ports" && <PortChartLegend />}<button className="primary-button" type="button" onClick={() => actions.openModal({ type: activeTab === "ports" ? "traffic" : "sensor", deviceId: selectedDevice.id })}>{icon("plus")} {activeTab === "ports" ? "Traffic Sensor" : "Sensor"}</button></div>
        </div>
        <div className="device-detail-tabs" role="tablist">
          <button className={activeTab === "ports" ? "active" : ""} type="button" onClick={() => actions.setDeviceDetailTab(selectedDevice.id, "ports")}><span>Ports</span><strong>{portSensors.length}</strong></button>
          <button className={activeTab === "sensors" ? "active" : ""} type="button" onClick={() => actions.setDeviceDetailTab(selectedDevice.id, "sensors")}><span>Sensors</span><strong>{assignedSensors.length}</strong></button>
        </div>
        {activeTab === "ports" ? <PortGrid sensors={portSensors} samples={portSamples[String(selectedDevice.id)] || {}} actions={actions} /> : <SensorTable sensors={assignedSensors} devices={data.devices} showDevice={false} actions={actions} pending={pending} />}
      </section>
    </main>
  );
}

function DeviceGroupEditor({ device, actions }) {
  const [group, setGroup] = useState(device.group || "Unassigned");
  useEffect(() => setGroup(device.group || "Unassigned"), [device.id, device.group]);
  async function submit(event) {
    event.preventDefault();
    await actions.saveDeviceGroup(device.id, { group });
  }
  return (
    <form className="group-editor" onSubmit={submit}>
      <label>Group<input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
      <button className="ghost-button" type="submit">Save Group</button>
    </form>
  );
}

function PortGrid({ sensors, samples, actions }) {
  if (!sensors.length) return emptyState("No ports", "Interface traffic sensors will appear here after SNMP traffic discovery.");
  return (
    <div className="port-grid">
      {sensors.map((sensor) => (
        <button className={`port-tile ${sensor.status || "unknown"}`} key={sensor.id} type="button" title={sensor.config?.interfaceName || sensor.name || ""} onClick={() => actions.setRoute({ view: "sensor-detail", sensorId: sensor.id })}>
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

function SensorTable({ sensors, devices, actions, showDevice = true, pending }) {
  if (!sensors.length) return emptyState("No sensors", "Readings will appear after sensors are added.");
  const deviceName = (id) => devices.find((device) => String(device.id) === String(id))?.name || "-";
  return (
    <div className="scrollable-table-shell">
      <table>
        <thead><tr><th>Status</th><th>Sensor</th><th>Type</th>{showDevice && <th>Device</th>}<th>Value</th><th>Last Check</th><th>Actions</th></tr></thead>
        <tbody>
          {sensors.map((sensor) => (
            <tr key={sensor.id} data-sensor-id={sensor.id} onClick={() => actions.setRoute({ view: "sensor-detail", sensorId: sensor.id })}>
              <td><StatusBadge status={sensor.status} /></td>
              <td><strong>{sensor.name}</strong>{sensor.type === "snmp_traffic" && sensor.config?.interfaceDescription && <small>{sensor.config.interfaceDescription}</small>}</td>
              <td>{sensor.type}</td>
              {showDevice && <td>{deviceName(sensor.deviceId)}</td>}
              <td>{sensor.lastValue || "-"}</td>
              <td>{sensor.lastCheck || "-"}</td>
              <td>
                <div className="row-actions">
                  <button className="mini-action" type="button" disabled={pending === `check-${sensor.id}`} onClick={(event) => { event.stopPropagation(); actions.checkSensor(sensor.id); }}>{icon("play")} Check</button>
                  <button className="mini-action danger" type="button" onClick={(event) => { event.stopPropagation(); actions.deleteSensor(sensor); }}>{icon("trash")} Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DevicesView({ data, actions }) {
  return (
    <main className="single-view">
      <section className="panel">
        <div className="panel-head"><div><h2>Devices</h2><p>Routers, switches, servers, printers, NAS, and probes.</p></div><button className="primary-button" type="button" onClick={() => actions.openModal({ type: "device" })}>{icon("plus")} Device</button></div>
        <div className="scrollable-table-shell">
          <table><thead><tr><th>Status</th><th>Device</th><th>Host</th><th>Group</th><th>SNMP</th><th>Tags</th><th>Actions</th></tr></thead><tbody>
            {data.devices.map((device) => <tr key={device.id} onClick={() => actions.setRoute({ view: "device-detail", deviceId: device.id })}><td><StatusBadge status={device.status} /></td><td>{device.name}</td><td>{device.host}</td><td>{device.group}</td><td>{device.snmpEnabled ? "Enabled" : "Disabled"}</td><td>{Array.isArray(device.tags) ? device.tags.join(", ") : device.tags || "-"}</td><td><button className="mini-action danger" type="button" onClick={(event) => { event.stopPropagation(); actions.deleteDevice(device); }}>{icon("trash")} Delete</button></td></tr>)}
          </tbody></table>
        </div>
      </section>
    </main>
  );
}

function SensorsView({ data, actions, pending }) {
  return <main className="single-view"><section className="panel"><div className="panel-head"><div><h2>Sensors</h2><p>Current readings from all monitors.</p></div><button className="ghost-button" type="button" disabled={pending === "check-all"} onClick={actions.checkAllSensors}>{icon("play")} Check All</button></div><SensorTable sensors={data.sensors} devices={data.devices} actions={actions} pending={pending} /></section></main>;
}

function EventsView({ events }) {
  return <main className="single-view"><section className="panel"><div className="panel-head"><div><h2>Alerts</h2><p>Failures, warnings, and recovery events.</p></div></div><EventsList events={events} /></section></main>;
}

function SensorDetail({ sensor, samples = [], loading = false, threshold, thresholdLoading = false, actions, pending }) {
  if (!sensor) return <main className="single-view">{emptyState("Sensor not found", "The selected sensor is not available.")}</main>;
  return (
    <main className="single-view detail-grid">
      <section className="panel identity-panel">
        <div className="detail-title"><div><h2>{sensor.name}</h2><p>{sensor.type}</p></div><StatusBadge status={sensor.status} /></div>
        {detailRow("Last Value", sensor.lastValue || "-")}
        {detailRow("Unit", sensor.unit || "-")}
        {sensor.type === "snmp_traffic" && detailRow("Interface", sensor.config?.interfaceName || sensor.config?.index || "-")}
        {sensor.type === "snmp_traffic" && detailRow("Description", sensor.config?.interfaceDescription || "-")}
        {sensor.type === "snmp_traffic" && detailRow("Interface Speed", formatRate(sensor.config?.interfaceSpeed || 0))}
        {sensor.type === "snmp_traffic" && detailRow("Speed OID", sensor.config?.speedOid || "-")}
        {sensor.type === "snmp_traffic" && detailRow("Inbound OID", sensor.config?.inOid || "-")}
        {sensor.type === "snmp_traffic" && detailRow("Outbound OID", sensor.config?.outOid || "-")}
        {sensor.type !== "snmp_traffic" && detailRow("OID", sensor.oid || "-")}
        {detailRow("Last Check", sensor.lastCheck || "-")}
      </section>
      <div className="sensor-detail-main">
        <section className="panel chart-panel">
          <div className="panel-head"><div><h2>Measurement History</h2><p>{sensor.type === "snmp_traffic" ? "Inbound and outbound interface rate" : "Recent sensor samples"}</p></div><button className="ghost-button" type="button" disabled={pending === `check-${sensor.id}`} onClick={() => actions.checkSensor(sensor.id)}>{icon("play")} Check</button></div>
          <SensorChart sensor={sensor} samples={samples} loading={loading} />
        </section>
        <ThresholdPanel sensor={sensor} threshold={threshold} loading={thresholdLoading} pending={pending} actions={actions} />
      </div>
    </main>
  );
}

function ThresholdPanel({ sensor, threshold, loading, pending, actions }) {
  if (sensor.type === "snmp_traffic") return <PortThresholdRulesPanel sensor={sensor} threshold={threshold} loading={loading} pending={pending} actions={actions} />;
  const defaultMetric = sensor.type === "snmp_traffic" ? "maxBps" : "value_number";
  const [form, setForm] = useState(() => thresholdForm(threshold, defaultMetric));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    setForm(thresholdForm(threshold, defaultMetric));
    setError("");
    setSaved("");
  }, [sensor.id, threshold?.updatedAt, threshold?.metric, threshold?.enabled]);
  const metricOptions = sensor.type === "snmp_traffic"
    ? [
        ["maxBps", "Max Traffic"],
        ["inBps", "Inbound"],
        ["outBps", "Outbound"],
      ]
    : [["value_number", "Numeric Value"]];
  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setSaved("");
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    setSaved("");
    try {
      await actions.saveThreshold(sensor.id, {
        ...form,
        warningValue: form.warningValue === "" ? null : Number(form.warningValue),
        criticalValue: form.criticalValue === "" ? null : Number(form.criticalValue),
      });
      setSaved("Threshold saved. It will apply on the next check.");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <section className="panel threshold-panel">
      <div className="panel-head"><div><h2>Alert Threshold</h2><p>Override sensor status when a metric crosses warning or critical limits.</p></div></div>
      {loading ? <div className="threshold-loading">Loading threshold...</div> : (
        <form onSubmit={submit}>
          <div className="threshold-grid">
            <label className="check-label threshold-enabled"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /> Enable threshold</label>
            <label>Metric<select value={form.metric} onChange={(event) => update("metric", event.target.value)}>{metricOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Warning<select value={form.warningOperator} onChange={(event) => update("warningOperator", event.target.value)}>{operatorOptions().map(([value, label]) => <option key={`w-${value}`} value={value}>{label}</option>)}</select></label>
            <label>Warning Value<input type="number" step="any" value={form.warningValue} onChange={(event) => update("warningValue", event.target.value)} placeholder={sensor.type === "snmp_traffic" ? "bps" : "value"} /></label>
            <label>Critical<select value={form.criticalOperator} onChange={(event) => update("criticalOperator", event.target.value)}>{operatorOptions().map(([value, label]) => <option key={`c-${value}`} value={value}>{label}</option>)}</select></label>
            <label>Critical Value<input type="number" step="any" value={form.criticalValue} onChange={(event) => update("criticalValue", event.target.value)} placeholder={sensor.type === "snmp_traffic" ? "bps" : "value"} /></label>
          </div>
          <FormMessage error={error}>{saved || thresholdHint(sensor)}</FormMessage>
          <div className="modal-actions"><button className="primary-button" type="submit" disabled={pending === `threshold-${sensor.id}`}>{pending === `threshold-${sensor.id}` ? "Saving..." : "Save Threshold"}</button></div>
        </form>
      )}
    </section>
  );
}

function PortThresholdRulesPanel({ sensor, threshold, loading, pending, actions }) {
  const [rules, setRules] = useState(() => normalizeThresholdRules(threshold));
  const [draft, setDraft] = useState(() => defaultPortRule());
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    setRules(normalizeThresholdRules(threshold));
    setDraft(defaultPortRule());
    setAdvanced(false);
    setError("");
    setSaved("");
  }, [sensor.id, JSON.stringify(threshold?.rules || [])]);
  const interfaceSpeed = Number(sensor.config?.interfaceSpeed || 0);
  function updateRule(index, patch) {
    setRules((current) => current.map((rule, position) => position === index ? { ...rule, ...patch } : rule));
    setSaved("");
  }
  function deleteRule(index) {
    setRules((current) => current.filter((_, position) => position !== index));
    setSaved("");
  }
  function updateDraft(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
    setSaved("");
  }
  function addRule() {
    setError("");
    const next = normalizeClientThresholdRule(draft);
    setRules((current) => [...current, next]);
    setDraft(defaultPortRule(draft.severity, draft.direction));
    setAdvanced(false);
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    setSaved("");
    try {
      const payloadRules = rules.map(normalizeClientThresholdRule);
      await actions.saveThresholdRules(sensor.id, { rules: payloadRules });
      setSaved("Threshold rules saved. They will apply on the next check.");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <section className="panel threshold-panel threshold-rules-panel">
      <div className="panel-head"><div><h2>Threshold Rules</h2><p>Use simple port-speed rules first. Advanced Mbps rules are available when needed.</p></div></div>
      {loading ? <div className="threshold-loading">Loading threshold rules...</div> : (
        <form onSubmit={submit}>
          <div className="threshold-rule-list">
            {rules.length ? rules.map((rule, index) => (
              <article className={`threshold-rule-card ${rule.severity}`} key={rule.clientId || rule.id || index}>
                <label className="check-label"><input type="checkbox" checked={!!rule.enabled} onChange={(event) => updateRule(index, { enabled: event.target.checked })} /> Enabled</label>
                <select value={rule.severity} onChange={(event) => updateRule(index, { severity: event.target.value })}><option value="warning">Warning</option><option value="critical">Critical</option></select>
                <select value={rule.metric} onChange={(event) => updateRule(index, { metric: event.target.value })}>{portMetricOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <select value={rule.direction} onChange={(event) => updateRule(index, { direction: event.target.value })}><option value="above">&gt;</option><option value="below">&lt;</option></select>
                {rule.mode === "absolute_mbps" ? <label>Mbps<input type="number" min="0" step="0.01" value={rule.absoluteMbps ?? ""} onChange={(event) => updateRule(index, { absoluteMbps: event.target.value })} /></label> : <label>Percent<input type="number" min="0" max="100" step="0.1" value={rule.percent ?? ""} onChange={(event) => updateRule(index, { percent: event.target.value })} /></label>}
                <select value={rule.mode} onChange={(event) => updateRule(index, event.target.value === "absolute_mbps" ? { mode: "absolute_mbps", absoluteMbps: rule.absoluteMbps ?? percentToMbps(rule.percent, interfaceSpeed), percent: "" } : { mode: "percent", percent: rule.percent || 80, absoluteMbps: "" })}><option value="percent">% of port</option><option value="absolute_mbps">Mbps</option></select>
                <button className="mini-action danger" type="button" onClick={() => deleteRule(index)}>{icon("trash")} Delete</button>
                <p>{describeClientRule(rule, interfaceSpeed)}</p>
              </article>
            )) : <div className="threshold-empty">No threshold rules yet. Add a warning or critical rule below.</div>}
          </div>
          <section className="threshold-rule-builder">
            <div className="threshold-builder-head"><strong>Add Rule</strong><span>{describeClientRule(draft, interfaceSpeed)}</span></div>
            <div className="threshold-builder-grid">
              <label>Rule Type<select value={draft.direction} onChange={(event) => updateDraft("direction", event.target.value)}><option value="above">High usage (&gt;)</option><option value="below">Low usage (&lt;)</option></select></label>
              <label>Severity<select value={draft.severity} onChange={(event) => updateDraft("severity", event.target.value)}><option value="warning">Warning</option><option value="critical">Critical</option></select></label>
              <label>Metric<select value={draft.metric} onChange={(event) => updateDraft("metric", event.target.value)}>{portMetricOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>Percent<input type="number" min="0" max="100" step="0.1" value={draft.percent} onChange={(event) => updateDraft("percent", event.target.value)} /></label>
            </div>
            <button className="ghost-button threshold-advanced-toggle" type="button" onClick={() => setAdvanced((current) => !current)}>{advanced ? "Hide Advanced" : "Advanced option"}</button>
            {advanced && <div className="threshold-advanced">
              <label className="check-label"><input type="checkbox" checked={draft.mode === "absolute_mbps"} onChange={(event) => setDraft((current) => event.target.checked ? { ...current, mode: "absolute_mbps", absoluteMbps: current.absoluteMbps || percentToMbps(current.percent, interfaceSpeed) } : { ...current, mode: "percent" })} /> Use specific Mbps instead of percent</label>
              {draft.mode === "absolute_mbps" && <label>Specific Mbps<input type="number" min="0" step="0.01" value={draft.absoluteMbps ?? ""} onChange={(event) => updateDraft("absoluteMbps", event.target.value)} placeholder="950" /></label>}
            </div>}
            <div className="threshold-builder-actions"><button className="primary-button" type="button" onClick={addRule}>{icon("plus")} Add Rule</button></div>
          </section>
          <FormMessage error={error}>{saved || "Critical uses the existing red status internally; the UI displays it as Critical."}</FormMessage>
          <div className="modal-actions"><button className="primary-button" type="submit" disabled={pending === `threshold-rules-${sensor.id}`}>{pending === `threshold-rules-${sensor.id}` ? "Saving..." : "Save Rules"}</button></div>
        </form>
      )}
    </section>
  );
}

function ModalHost({ modal, actions, data }) {
  if (!modal) return null;
  const device = modal.deviceId ? data.devices.find((item) => String(item.id) === String(modal.deviceId)) : null;
  if (modal.type === "device") return <DeviceModal modal={modal} actions={actions} />;
  if (modal.type === "group") return <GroupModal actions={actions} />;
  if (modal.type === "sensor") return <SensorModal device={device} actions={actions} />;
  if (modal.type === "traffic") return <TrafficModal device={device} sensors={data.sensors} actions={actions} />;
  return null;
}

function ModalShell({ title, caption, children, actions, wide = false }) {
  return (
    <dialog open>
      <div className={`modal-card ${wide ? "" : "compact-modal"}`}>
        <div className="modal-head"><div><h2>{title}</h2><p>{caption}</p></div><button className="icon-button" type="button" onClick={actions.closeModal} aria-label="Close">{icon("close")}</button></div>
        {children}
      </div>
    </dialog>
  );
}

function DeviceModal({ modal, actions }) {
  const [form, setForm] = useState({ name: "", host: "", group: modal.groupName || "", snmpPort: 161, snmpEnabled: false, snmpCommunity: "", tags: "", notes: "" });
  const [error, setError] = useState("");
  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await actions.saveDevice({ ...form, snmpPort: Number(form.snmpPort || 161) });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <ModalShell title="Add Device" caption="Register a network target" actions={actions} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Core Switch" /></label>
          <label>Host<input required value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="192.168.1.1" /></label>
          <label>Group<input value={form.group} onChange={(event) => update("group", event.target.value)} placeholder="Core Network" /></label>
          <label>SNMP Port<input type="number" value={form.snmpPort} onChange={(event) => update("snmpPort", event.target.value)} /></label>
          <label className="wide check-label"><input type="checkbox" checked={form.snmpEnabled} onChange={(event) => update("snmpEnabled", event.target.checked)} /> Enable SNMP v2c for this device</label>
          <label className="wide">SNMP v2c Community<input type="password" value={form.snmpCommunity} onChange={(event) => update("snmpCommunity", event.target.value)} placeholder="public" /></label>
          <label className="wide">Tags<input value={form.tags} onChange={(event) => update("tags", event.target.value)} placeholder="switch, core" /></label>
          <label className="wide">Notes<textarea value={form.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Location, model, owner, or maintenance notes" /></label>
        </div>
        <FormMessage error={error}>Device will be saved to local SQLite.</FormMessage>
        <ModalActions actions={actions} submitLabel="Save" />
      </form>
    </ModalShell>
  );
}

function GroupModal({ actions }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await actions.saveGroup({ name });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <ModalShell title="Add Group" caption="Create an empty monitoring group" actions={actions}>
      <form onSubmit={submit}>
        <label>Group Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Networks" /></label>
        <FormMessage error={error}>Groups can exist even before devices are added.</FormMessage>
        <ModalActions actions={actions} submitLabel="Save" />
      </form>
    </ModalShell>
  );
}

function SensorModal({ device, actions }) {
  const [form, setForm] = useState({ type: "icmp", name: "", interval: 30, oid: "1.3.6.1.2.1.1.3.0", unit: "", community: "", port: device?.snmpPort || 161 });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("ICMP uses the selected device host. No SNMP parameters are required.");
  const [discovery, setDiscovery] = useState(null);
  const isSnmp = form.type === "snmp";
  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    if (name === "type") setMessage(value === "snmp" ? "Enter the SNMP v2c OID, community, and UDP port for this device." : "ICMP uses the selected device host. No SNMP parameters are required.");
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await actions.saveSensor(device.id, { ...form, interval: Number(form.interval || 30), port: Number(form.port || 161) });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  async function scanWalk() {
    setError("");
    setMessage(`Walking ${form.oid}...`);
    try {
      const payload = await actions.scanSnmp(device.id, { baseOid: form.oid, community: form.community, port: Number(form.port || 161), limit: 128 });
      setDiscovery({ baseOid: payload.baseOid, items: payload.items || [] });
      setMessage(`SNMP walk completed. Found ${payload.count || 0} row(s).`);
    } catch (err) {
      setError(err.message);
      setMessage(err.message);
    }
  }
  async function createDiscovered() {
    if (!discovery?.items?.length) return;
    setError("");
    try {
      const baseName = form.name.trim() || "SNMP";
      const sensors = discovery.items.map((item) => ({ name: `${baseName} ${item.value || `index ${item.index}`}`, interval: Number(form.interval || 30), oid: item.oid, unit: form.unit, community: form.community, port: Number(form.port || 161) }));
      await actions.createDiscoveredSensors(device.id, { sensors });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  async function readSerialNumber() {
    setError("");
    setMessage("Reading device serial number table...");
    try {
      const payload = await actions.scanSnmp(device.id, { baseOid: deviceSerialNumberOid, community: form.community, port: Number(form.port || 161), limit: 128 });
      const item = (payload.items || []).find((row) => String(row.value || "").trim());
      if (!item) throw new Error("No serial number value found.");
      await actions.saveSensor(device.id, { type: "snmp", name: "Device Serial Number", interval: Number(form.interval || 30), oid: item.oid, unit: "", community: form.community, port: Number(form.port || 161) });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
      setMessage(err.message);
    }
  }
  if (!device) return null;
  return (
    <ModalShell title="Add Sensor" caption={`Attach to ${device.name || device.host}`} actions={actions} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="sensor-type-field"><span>Sensor Type</span><div className="segmented-control"><button className={form.type === "icmp" ? "active" : ""} type="button" onClick={() => update("type", "icmp")}>ICMP Ping</button><button className={form.type === "snmp" ? "active" : ""} type="button" onClick={() => update("type", "snmp")}>SNMP v2c GET</button></div></div>
          <label>Name<input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={isSnmp ? "SNMP Uptime" : "ICMP Ping"} /></label>
          <label>Interval Seconds<input type="number" min="10" value={form.interval} onChange={(event) => update("interval", event.target.value)} /></label>
          {isSnmp && <>
            <label>SNMP OID<input value={form.oid} onChange={(event) => update("oid", event.target.value)} /></label>
            <label>Community<input type="password" value={form.community} onChange={(event) => update("community", event.target.value)} placeholder="Use device community" /></label>
            <label>Port<input type="number" value={form.port} onChange={(event) => update("port", event.target.value)} /></label>
            <label>Unit<input value={form.unit} onChange={(event) => update("unit", event.target.value)} placeholder="ticks, %, ms" /></label>
            <section className="oid-guide wide"><div className="oid-guide-head"><strong>Common SNMP OIDs</strong><span>Click Use to fill the sensor fields.</span></div><div className="oid-guide-list">{snmpOidGuide.map((item) => <OidGuideItem key={item.name} item={item} onUse={() => item.action === "serial-number" ? readSerialNumber() : (update("name", item.name), update("oid", item.oid), update("unit", item.unit || ""))} />)}</div></section>
            <section className="snmp-discovery wide"><div className="snmp-discovery-head"><div><strong>SNMP Walk Discovery</strong><span>Use the OID above as a base, discover indexed rows, then create one sensor per row.</span></div><button className="mini-action" type="button" onClick={scanWalk}>{icon("radar")} Scan</button></div><SnmpDiscoveryResults discovery={discovery} onCreate={createDiscovered} /></section>
          </>}
        </div>
        <FormMessage error={error}>{message}</FormMessage>
        <ModalActions actions={actions} submitLabel="Save & Check" />
      </form>
    </ModalShell>
  );
}

function OidGuideItem({ item, onUse }) {
  return <div className="oid-guide-item"><div><strong>{item.name}</strong><code>{item.oid}</code><p>{item.description}</p></div><button className="mini-action" type="button" onClick={onUse}>{item.action === "serial-number" ? "Read" : "Use"}</button></div>;
}

function SnmpDiscoveryResults({ discovery, onCreate }) {
  if (!discovery) return <div className="snmp-discovery-results"><p>Example: walk <code>1.3.6.1.2.1.2.2.1.2</code> to discover interface names and indexes.</p></div>;
  if (!discovery.items?.length) return <div className="snmp-discovery-results"><p>No rows found under this OID. Check the base OID, community, and SNMP access.</p></div>;
  return (
    <div className="snmp-discovery-results">
      <p>Found {discovery.items.length} indexed row(s). These will be created as individual SNMP GET sensors.</p>
      <div className="snmp-discovery-list">{discovery.items.slice(0, 40).map((item) => <div className="snmp-discovery-row" key={item.oid}><strong>#{item.index || "-"}</strong><span>{item.value || "-"}</span><code>{item.oid}</code></div>)}</div>
      {discovery.items.length > 40 && <p>{discovery.items.length - 40} more row(s) are hidden from preview but will still be created.</p>}
      <div className="snmp-discovery-actions"><button className="primary-button" type="button" onClick={onCreate}>{icon("plus")} Create {discovery.items.length} Sensors</button></div>
    </div>
  );
}

function TrafficModal({ device, sensors, actions }) {
  const [form, setForm] = useState({ interval: 30, community: "", port: device?.snmpPort || 161 });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("Discover interfaces and create only missing traffic sensors.");
  const [interfaces, setInterfaces] = useState(null);
  if (!device) return null;
  const missing = interfaces ? newDiscoveredTrafficInterfaces(interfaces, sensors, device.id) : [];
  async function scan() {
    setError("");
    setMessage("Discovering interface traffic counters...");
    try {
      const payload = await actions.scanTraffic(device.id, { community: form.community, port: Number(form.port || 161), limit: 128 });
      setInterfaces(payload.interfaces || []);
      setMessage(`Interface discovery completed. Found ${payload.count || 0} interface(s).`);
    } catch (err) {
      setError(err.message);
      setMessage(err.message);
    }
  }
  async function createTraffic() {
    setError("");
    try {
      await actions.createTrafficSensors(device.id, { interval: Number(form.interval || 30), community: form.community, port: Number(form.port || 161), interfaces: missing.map((item) => ({ ...item, sensorName: `Traffic ${item.name || `ifIndex ${item.index}`}` })) });
      await actions.refreshPortSamples(device.id, { force: true });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <ModalShell title="Add Traffic Sensor" caption={`Discover interfaces on ${device.name || device.host}`} actions={actions} wide>
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="form-grid">
          <label>Interval Seconds<input type="number" min="10" value={form.interval} onChange={(event) => setForm((current) => ({ ...current, interval: event.target.value }))} /></label>
          <label>Community<input type="password" value={form.community} onChange={(event) => setForm((current) => ({ ...current, community: event.target.value }))} placeholder="Use device community" /></label>
          <label>Port<input type="number" value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} /></label>
          <section className="snmp-discovery traffic-discovery wide"><div className="snmp-discovery-head"><div><strong>Interface Traffic Discovery</strong><span>Discover ports, pair each index with inbound/outbound counters, and create only missing traffic sensors.</span></div><button className="mini-action" type="button" onClick={scan}>{icon("radar")} Scan Ports</button></div><TrafficDiscoveryResults interfaces={interfaces} missing={missing} onCreate={createTraffic} /></section>
        </div>
        <FormMessage error={error}>{message}</FormMessage>
        <div className="modal-actions"><button className="ghost-button" type="button" onClick={actions.closeModal}>Cancel</button></div>
      </form>
    </ModalShell>
  );
}

function TrafficDiscoveryResults({ interfaces, missing, onCreate }) {
  if (!interfaces) return <div className="snmp-discovery-results"><p>Uses IF-MIB for names, descriptions, speed, inbound, and outbound counters.</p></div>;
  if (!interfaces.length) return <div className="snmp-discovery-results"><p>No interfaces found. Check SNMP access or try a device that exposes IF-MIB.</p></div>;
  return (
    <div className="snmp-discovery-results">
      <p>Found {interfaces.length} interface(s). {missing.length} missing traffic sensor(s) can be created.</p>
      <div className="snmp-discovery-list">{interfaces.slice(0, 40).map((item) => <div className="snmp-discovery-row" key={item.index}><strong>#{item.index}</strong><span><b>{item.name || "-"}</b><small>{[item.description, item.speedBps ? `Speed ${formatRate(item.speedBps)}` : ""].filter(Boolean).join(" / ") || "No description"}</small></span><code>IN {item.inOid}</code><code>OUT {item.outOid}</code></div>)}</div>
      {interfaces.length > 40 && <p>{interfaces.length - 40} more interface(s) are hidden from preview but will still be created.</p>}
      <div className="snmp-discovery-actions"><button className="primary-button" type="button" disabled={!missing.length} onClick={onCreate}>{icon("plus")} Create {missing.length} Traffic Sensors</button></div>
    </div>
  );
}

function FormMessage({ error, children }) {
  return <div className={`modal-note ${error ? "error" : ""}`}>{error || children}</div>;
}

function ModalActions({ actions, submitLabel }) {
  return <div className="modal-actions"><button className="ghost-button" type="button" onClick={actions.closeModal}>Cancel</button><button className="primary-button" type="submit">{submitLabel}</button></div>;
}

function EventsList({ events }) {
  if (!events.length) return emptyState("No alerts", "Status transitions will appear here.");
  return <div className="event-list">{events.map((event) => <article className={`event-row ${event.status || "unknown"}`} key={event.id}><span className={`event-dot ${event.status || "unknown"}`} /><div className="event-copy"><strong>{event.title}</strong><small>{event.message || "-"}</small></div><time>{formatDateTime(event.createdAt)}</time></article>)}</div>;
}

function Topology({ devices, actions }) {
  const [positions, setPositions] = useState({});
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const canvasRef = useRef(null);
  useEffect(() => setPositions({}), [devices.map((device) => `${device.id}:${device.topologyX}:${device.topologyY}`).join("|")]);
  if (!devices.length) return emptyState("No devices", "Add devices to populate topology.");
  function positionFor(device, index) {
    const transient = positions[device.id];
    if (transient) return transient;
    return { x: clampPercent(device.topologyX ?? (18 + (index % 4) * 22), 8, 92), y: clampPercent(device.topologyY ?? (22 + Math.floor(index / 4) * 26), 12, 88) };
  }
  function pointerDown(event, device, index) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: device.id, startX: event.clientX, startY: event.clientY, rect, moved: false, position: positionFor(device, index) };
  }
  function pointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = ((event.clientX - drag.startX) / drag.rect.width) * 100;
    const dy = ((event.clientY - drag.startY) / drag.rect.height) * 100;
    const next = { x: clampPercent(drag.position.x + dx, 8, 92), y: clampPercent(drag.position.y + dy, 12, 88) };
    drag.moved = Math.abs(dx) + Math.abs(dy) > 0.4;
    drag.next = next;
    if (drag.moved) suppressClickRef.current = true;
    setPositions((current) => ({ ...current, [drag.id]: next }));
  }
  async function pointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    suppressClickRef.current = true;
    if (!drag.moved) {
      actions.setRoute({ view: "device-detail", deviceId: drag.id });
      return;
    }
    const next = drag.next || positions[drag.id];
    if (next) await actions.saveTopology(drag.id, next);
  }
  return (
    <div className="topology-map topology-canvas" ref={canvasRef} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { dragRef.current = null; }}>
      {devices.slice(0, 12).map((device, index) => {
        const position = positionFor(device, index);
        return <button className={`topology-node ${device.status || "unknown"}`} key={device.id} type="button" style={{ left: `${position.x}%`, top: `${position.y}%` }} onPointerDown={(event) => pointerDown(event, device, index)} onClick={(event) => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } if (event.detail === 0) actions.setRoute({ view: "device-detail", deviceId: device.id }); }}><span /><strong>{device.name}</strong><small>{device.host}</small></button>;
      })}
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
  return <span className={`port-mini-chart ${empty ? "empty" : ""}`}><svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><line className="port-chart-baseline" x1="0" y1={height - 4} x2={width} y2={height - 4} /><polyline className="port-chart-in" points={inbound} /><polyline className="port-chart-out" points={outbound} /></svg></span>;
}

function SensorChart({ sensor, samples, loading }) {
  const [trafficAxisMode, setTrafficAxisMode] = useState("port_speed");
  useEffect(() => setTrafficAxisMode("port_speed"), [sensor.id]);
  if (loading) return <div className="empty-chart"><span>Loading samples</span></div>;
  if (!samples.length) return <div className="empty-chart"><span>No samples yet</span></div>;
  const domain = chartDomain(samples);
  const visibleSamples = chartVisibleSamples(samples, domain);
  if (sensor.type === "snmp_traffic") {
    const points = visibleSamples.map((sample) => ({ inBps: Number(sample.meta?.inBps || 0), outBps: Number(sample.meta?.outBps || 0) }));
    const measuredMax = Math.max(0, ...points.flatMap((item) => [item.inBps, item.outBps]));
    const interfaceSpeed = Number(sensor.config?.interfaceSpeed || visibleSamples.at(-1)?.meta?.interfaceSpeed || 0);
    const axisMax = trafficAxisMode === "auto_peak"
      ? niceAxisMax(measuredMax)
      : Math.max(1, interfaceSpeed || measuredMax, measuredMax);
    const scale = chartScale(axisMax, "rate");
    return <div className="traffic-chart"><div className="chart-toolbar"><div className="segmented-control chart-axis-toggle" aria-label="Y axis display mode"><button className={trafficAxisMode === "port_speed" ? "active" : ""} type="button" onClick={() => setTrafficAxisMode("port_speed")}>Port Speed</button><button className={trafficAxisMode === "auto_peak" ? "active" : ""} type="button" onClick={() => setTrafficAxisMode("auto_peak")}>Auto Peak</button></div></div><div className="chart-stats"><div><span>Inbound</span><strong>{formatRate(points.at(-1)?.inBps || 0)}</strong></div><div><span>Outbound</span><strong>{formatRate(points.at(-1)?.outBps || 0)}</strong></div><div><span>Peak</span><strong>{formatRate(measuredMax)}</strong></div><div><span>Axis Max</span><strong>{formatRate(axisMax)}</strong></div></div><svg viewBox="0 0 780 330" role="img" aria-label="Interface traffic history"><ChartGrid max={axisMax} scale={scale} domain={domain} /><polyline className="chart-line in" points={chartPoints(points.map((item) => item.inBps), axisMax, visibleSamples, domain)} /><polyline className="chart-line out" points={chartPoints(points.map((item) => item.outBps), axisMax, visibleSamples, domain)} /></svg><div className="chart-legend"><span><i className="legend-in" />Inbound</span><span><i className="legend-out" />Outbound</span></div></div>;
  }
  const values = visibleSamples.map((sample) => Number(sample.valueNumber || 0));
  const max = Math.max(1, ...values);
  const scale = chartScale(max, "number", sensor.unit || "");
  return <div className="traffic-chart"><div className="chart-stats"><div><span>Current</span><strong>{visibleSamples.at(-1)?.valueText || "-"}</strong></div><div><span>Samples</span><strong>{visibleSamples.length}</strong></div><div><span>Peak</span><strong>{max.toLocaleString()}</strong></div><div><span>Axis Max</span><strong>{max.toLocaleString()}</strong></div></div><svg viewBox="0 0 780 330" role="img" aria-label="Sensor sample history"><ChartGrid max={max} scale={scale} domain={domain} /><polyline className="chart-line in" points={chartPoints(values, max, visibleSamples, domain)} /></svg></div>;
}

function ChartGrid({ max, scale, domain }) {
  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  const timeTicks = chartTimeTicks(domain);
  return <><g className="chart-grid"><line x1={chartPlot.left} y1={chartPlot.top} x2={chartPlot.left} y2={chartPlot.bottom} /><line x1={chartPlot.left} y1={chartPlot.bottom} x2={chartPlot.right} y2={chartPlot.bottom} />{timeTicks.map((tick) => <line key={`x-${tick.time}`} x1={tick.x} y1={chartPlot.top} x2={tick.x} y2={chartPlot.bottom} />)}{yTicks.map((ratio) => { const y = chartPlot.bottom - ratio * chartPlot.height; return <line key={`y-${ratio}`} x1={chartPlot.left} y1={y} x2={chartPlot.right} y2={y} />; })}</g><g className="chart-axis-labels">{yTicks.map((ratio) => { const y = chartPlot.bottom - ratio * chartPlot.height; return <text key={`yl-${ratio}`} x={chartPlot.left - 10} y={y + 4} textAnchor="end">{formatAxisValue(max * ratio, scale)}</text>; })}{timeTicks.map((tick) => <text className="chart-time-label" key={`tl-${tick.time}`} x={tick.x} y="294" textAnchor="middle">{tick.label}</text>)}<text className="chart-axis-title" x={chartPlot.left} y="20" textAnchor="start">{scale.unit}</text><text className="chart-axis-title" x={(chartPlot.left + chartPlot.right) / 2} y="320" textAnchor="middle">Time</text></g></>;
}

function thresholdForm(threshold, defaultMetric) {
  return {
    enabled: !!threshold?.enabled,
    metric: threshold?.metric || defaultMetric,
    warningOperator: threshold?.warningOperator || "",
    warningValue: threshold?.warningValue ?? "",
    criticalOperator: threshold?.criticalOperator || "",
    criticalValue: threshold?.criticalValue ?? "",
  };
}

function portMetricOptions() {
  return [
    ["maxBps", "Max Traffic"],
    ["inBps", "Inbound"],
    ["outBps", "Outbound"],
  ];
}

function defaultPortRule(severity = "warning", direction = "above") {
  const percent = direction === "below" ? (severity === "critical" ? 1 : 5) : (severity === "critical" ? 95 : 80);
  return {
    clientId: `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: true,
    severity,
    metric: "maxBps",
    direction,
    mode: "percent",
    percent,
    absoluteMbps: "",
    label: "",
  };
}

function normalizeThresholdRules(threshold) {
  return (threshold?.rules || []).map((rule) => normalizeClientThresholdRule(rule));
}

function normalizeClientThresholdRule(rule) {
  const mode = rule.mode === "absolute_mbps" ? "absolute_mbps" : "percent";
  return {
    id: rule.id,
    clientId: rule.clientId || `rule-${rule.id || Date.now()}-${Math.random().toString(16).slice(2)}`,
    enabled: rule.enabled !== false,
    severity: rule.severity === "critical" ? "critical" : "warning",
    metric: ["maxBps", "inBps", "outBps"].includes(rule.metric) ? rule.metric : "maxBps",
    direction: rule.direction === "below" ? "below" : "above",
    mode,
    percent: mode === "percent" ? Number(rule.percent ?? 80) : "",
    absoluteMbps: mode === "absolute_mbps" ? Number(rule.absoluteMbps ?? rule.absolute_mbps ?? 0) : "",
    label: rule.label || "",
  };
}

function percentToMbps(percent, interfaceSpeed) {
  const bps = Number(interfaceSpeed || 0) * Number(percent || 0) / 100;
  return Number.isFinite(bps) ? Number((bps / 1_000_000).toFixed(2)) : "";
}

function ruleLimitBps(rule, interfaceSpeed) {
  if (rule.mode === "absolute_mbps") return Number(rule.absoluteMbps || 0) * 1_000_000;
  return Number(interfaceSpeed || 0) * Number(rule.percent || 0) / 100;
}

function describeClientRule(rule, interfaceSpeed) {
  const metric = Object.fromEntries(portMetricOptions())[rule.metric] || "Max Traffic";
  const severity = rule.severity === "critical" ? "Critical" : "Warning";
  const sign = rule.direction === "below" ? "<" : ">";
  const target = rule.mode === "absolute_mbps"
    ? `${Number(rule.absoluteMbps || 0).toLocaleString()} Mbps`
    : `${Number(rule.percent || 0).toLocaleString()}% of ${formatRate(interfaceSpeed || 0)}`;
  const limit = ruleLimitBps(rule, interfaceSpeed);
  const converted = limit ? ` (${formatRate(limit)})` : "";
  return `${severity} when ${metric} ${sign} ${target}${converted}`;
}

function operatorOptions() {
  return [
    ["", "Disabled"],
    [">", ">"],
    [">=", ">="],
    ["<", "<"],
    ["<=", "<="],
    ["==", "=="],
    ["!=", "!="],
  ];
}

function thresholdHint(sensor) {
  if (sensor.type === "snmp_traffic") return "Traffic thresholds use bps values. Example: 800000000 for 800 Mbps.";
  return "Numeric thresholds apply to the parsed sample value. Text-only SNMP values will not trigger numeric thresholds.";
}

function groupDevices(groups, devices) {
  const map = new Map();
  groups.forEach((group) => map.set(group.name || "Unassigned", []));
  devices.forEach((device) => {
    const group = device.group || "Unassigned";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(device);
  });
  return Array.from(map.entries()).map(([name, groupDevicesList]) => ({ name, devices: groupDevicesList, status: aggregateStatus(groupDevicesList.map((device) => device.status || "unknown")) }));
}

function existingTrafficKeys(sensors, deviceId) {
  const keys = { indexes: new Set(), oids: new Set() };
  sensors.filter((sensor) => String(sensor.deviceId) === String(deviceId) && sensor.type === "snmp_traffic").forEach((sensor) => {
    if (sensor.config?.index) keys.indexes.add(String(sensor.config.index));
    ["speedOid", "inOid", "outOid"].forEach((name) => {
      const oid = normalizeClientOid(sensor.config?.[name]);
      if (oid) keys.oids.add(oid);
    });
  });
  return keys;
}

function newDiscoveredTrafficInterfaces(items, sensors, deviceId) {
  const existing = existingTrafficKeys(sensors, deviceId);
  const requestIndexes = new Set();
  const requestOids = new Set();
  return items.filter((item) => {
    const index = String(item.index || "").trim();
    if (!index || existing.indexes.has(index) || requestIndexes.has(index)) return false;
    const oids = ["speedOid", "inOid", "outOid"].map((name) => normalizeClientOid(item[name])).filter(Boolean);
    if (oids.some((oid) => existing.oids.has(oid) || requestOids.has(oid))) return false;
    requestIndexes.add(index);
    oids.forEach((oid) => requestOids.add(oid));
    return true;
  });
}

function normalizeClientOid(value) {
  return String(value || "").trim().replace(/^\./, "").replace(/\s+/g, "");
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

function miniChartPoints(values, max, width, height) {
  const topPadding = 6;
  const bottomPadding = 6;
  const baseline = height - bottomPadding;
  if (values.length < 2 || max <= 0) return `0,${baseline} ${width},${baseline}`;
  return values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width;
    const y = baseline - (Number(value || 0) / max) * (height - topPadding - bottomPadding);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function chartPoints(values, max, samples, domain) {
  return values.map((value, index) => {
    const time = new Date(samples[index]?.createdAt || "").getTime();
    const x = chartX(Number.isFinite(time) ? time : domain.start + index * chartTimeStepMs, domain);
    const y = chartPlot.bottom - (Number(value || 0) / max) * chartPlot.height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function chartDomain(samples) {
  const times = samples.map((sample) => new Date(sample.createdAt || "").getTime()).filter((time) => Number.isFinite(time));
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
  for (let time = domain.start; time <= domain.end + 1; time += chartTimeStepMs) ticks.push({ time, label: formatChartTimeLabel(time), x: chartX(time, domain) });
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

function niceAxisMax(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 1;
  const padded = number * 1.12;
  const exponent = Math.floor(Math.log10(padded));
  const base = 10 ** exponent;
  const normalized = padded / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
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
  return String(value || "").trim().replace(/^Ten-GigabitEthernet/i, "Te").replace(/^M-GigabitEthernet/i, "M-Gi").replace(/^GigabitEthernet/i, "Gi").replace(/^Bridge-Aggregation/i, "BAGG").replace(/^Vlan-interface/i, "Vlan").replace(/\s+/g, " ");
}

function formatAxisValue(value, scale) {
  const scaled = Number(value || 0) / scale.divisor;
  if (Math.abs(scaled) >= 100) return scaled.toFixed(0);
  if (Math.abs(scaled) >= 10) return scaled.toFixed(1);
  return scaled.toFixed(2);
}

function formatChartTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  return `${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return value || "-";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function clampPercent(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

const rootElement = document.getElementById("root");
const root = globalThis.__networkManagerReactRoot || createRoot(rootElement);
globalThis.__networkManagerReactRoot = root;
root.render(<App />);
