import React, { useEffect, useState } from "react";
import { apiRequest, normalizeList } from "../api.js";

export const internetDeviceName = "Internet";
export const internetDeviceHost = "internet.local";
export const internetDeviceGroup = "Internet";

const methodOptions = ["GET", "HEAD", "POST"];
const sampleRangeOptions = [
  ["1h", "1H"],
  ["24h", "1D"],
  ["7d", "7D"],
  ["30d", "30D"],
];
const statusFilterOptions = [
  ["all", "All"],
  ["up", "Up"],
  ["warning", "Warning"],
  ["down", "Critical"],
  ["unknown", "Unknown"],
];
const pageSizeOptions = [25, 50, 100];
const latencyPlot = { left: 62, right: 616, top: 32, bottom: 230 };
latencyPlot.width = latencyPlot.right - latencyPlot.left;
latencyPlot.height = latencyPlot.bottom - latencyPlot.top;

export function InternetView({ data, actions, pending, ui }) {
  const [monitors, setMonitors] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [pager, setPager] = useState({ total: 0, limit: 25, offset: 0, summary: emptyInternetSummary() });
  const [selectedMonitorId, setSelectedMonitorId] = useState(null);
  const [sampleRange, setSampleRange] = useState("1h");
  const [samples, setSamples] = useState([]);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [samplesError, setSamplesError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [listRefreshToken, setListRefreshToken] = useState(0);
  const summary = pager.summary || emptyInternetSummary();
  const totalMonitors = Number(pager.total || summary.total || 0);
  const upCount = Number(summary.up || 0);
  const problemCount = Number(summary.warning || 0) + Number(summary.down || 0);
  const avgMs = monitors.map((sensor) => monitorLatencyValue(sensor)).filter((value) => Number.isFinite(value) && value > 0);
  const average = avgMs.length ? `${Math.round(avgMs.reduce((sum, value) => sum + value, 0) / avgMs.length)} ms` : "-";
  const selectedMonitor = monitors.find((monitor) => String(monitor.id) === String(selectedMonitorId)) || monitors[0] || null;
  const pageCount = Math.max(1, Math.ceil(totalMonitors / pageSize));
  const currentPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setListLoading(true);
      setListError("");
      try {
        const params = new URLSearchParams({
          type: "http",
          includeTotal: "1",
          limit: String(pageSize),
          offset: String(currentPage * pageSize),
        });
        const query = search.trim();
        if (query) params.set("q", query);
        if (statusFilter !== "all") params.set("status", statusFilter);
        const payload = await apiRequest(`/api/sensors?${params.toString()}`);
        if (cancelled) return;
        const items = normalizeList(payload);
        const total = Number(payload.total ?? items.length);
        const nextPageCount = Math.max(1, Math.ceil(total / pageSize));
        if (currentPage > nextPageCount - 1) {
          setPage(nextPageCount - 1);
          return;
        }
        setMonitors(items);
        setPager({
          total,
          limit: Number(payload.limit || pageSize),
          offset: Number(payload.offset || currentPage * pageSize),
          summary: { ...emptyInternetSummary(), ...(payload.summary || {}), total },
        });
      } catch (error) {
        if (!cancelled) setListError(error.message);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, statusFilter, pageSize, currentPage, listRefreshToken, data.sensors.length]);

  useEffect(() => {
    if (!monitors.length) {
      setSelectedMonitorId(null);
      return;
    }
    if (!selectedMonitorId || !monitors.some((monitor) => String(monitor.id) === String(selectedMonitorId))) {
      setSelectedMonitorId(monitors[0].id);
    }
  }, [monitors, selectedMonitorId]);

  useEffect(() => {
    if (!selectedMonitor?.id) {
      setSamples([]);
      setSamplesError("");
      return undefined;
    }
    let cancelled = false;
    async function loadSamples() {
      setSamplesLoading(true);
      setSamplesError("");
      try {
        const payload = await apiRequest(`/api/sensors/${selectedMonitor.id}/samples?range=${encodeURIComponent(sampleRange)}&resolution=auto`);
        if (!cancelled) setSamples(normalizeList(payload));
      } catch (error) {
        if (!cancelled) setSamplesError(error.message);
      } finally {
        if (!cancelled) setSamplesLoading(false);
      }
    }
    loadSamples();
    return () => {
      cancelled = true;
    };
  }, [selectedMonitor?.id, sampleRange, refreshToken]);

  async function checkMonitor(monitorId) {
    await actions.checkSensor(monitorId);
    setListRefreshToken((current) => current + 1);
    if (String(monitorId) === String(selectedMonitor?.id)) setRefreshToken((current) => current + 1);
  }

  async function deleteMonitor(monitor) {
    const index = monitors.findIndex((item) => String(item.id) === String(monitor.id));
    const nextMonitor = monitors[index + 1] || monitors[index - 1] || null;
    const result = await actions.deleteSensor(monitor);
    if (result === null) return;
    setSelectedMonitorId(nextMonitor?.id || null);
    setListRefreshToken((current) => current + 1);
  }

  function updateSearch(value) {
    setSearch(value);
    setPage(0);
  }

  function updateStatusFilter(value) {
    setStatusFilter(value);
    setPage(0);
  }

  function updatePageSize(value) {
    setPageSize(Number(value));
    setPage(0);
  }

  return (
    <main className="single-view internet-view">
      <section className="metrics-row">
        {ui.metricCard("Internet", totalMonitors, "HTTP/HTTPS monitors", "cyan")}
        {ui.metricCard("Online", upCount, "Passing checks", "green")}
        {ui.metricCard("Issues", problemCount, "Warning / critical", problemCount ? "amber" : "gray")}
        {ui.metricCard("Avg Time", average, "Visible response", "blue")}
      </section>
      <div className="internet-workspace">
        <section className="panel internet-panel">
          <div className="panel-head">
            <div><h2>Internet Monitors</h2><p>HTTP and HTTPS uptime checks for public or internal services.</p></div>
            <button className="primary-button" type="button" onClick={() => actions.openModal({ type: "internet-monitor" })}>{ui.icon("plus")} Monitor</button>
          </div>
          <InternetMonitorFilters search={search} statusFilter={statusFilter} pageSize={pageSize} onSearch={updateSearch} onStatusFilter={updateStatusFilter} onPageSize={updatePageSize} />
          {listError && <div className="modal-note error internet-list-error">{listError}</div>}
          {listLoading && !monitors.length ? (
            <div className="internet-list-loading">Loading monitors</div>
          ) : monitors.length ? (
            <InternetMonitorList monitors={monitors} selectedMonitorId={selectedMonitor?.id} onSelect={setSelectedMonitorId} onCheck={checkMonitor} onDelete={deleteMonitor} pending={pending} ui={ui} />
          ) : (
            ui.emptyState(search || statusFilter !== "all" ? "No matching monitors" : "No internet monitors", search || statusFilter !== "all" ? "Adjust search or filters to show more monitors." : "Add an HTTP or HTTPS monitor to start checking service availability.")
          )}
          <InternetPagination loading={listLoading} page={currentPage} pageCount={pageCount} pageSize={pageSize} total={totalMonitors} count={monitors.length} onPage={setPage} />
        </section>
        <InternetLatencyPanel monitor={selectedMonitor} samples={samples} sampleRange={sampleRange} onRangeChange={setSampleRange} loading={samplesLoading} error={samplesError} onCheck={checkMonitor} actions={actions} pending={pending} ui={ui} />
      </div>
    </main>
  );
}

function InternetMonitorFilters({ search, statusFilter, pageSize, onSearch, onStatusFilter, onPageSize }) {
  return (
    <div className="internet-list-controls">
      <label className="internet-search">
        <span>Search</span>
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Name, URL, device, response..." />
      </label>
      <label>
        <span>Status</span>
        <select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}>
          {statusFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        <span>Rows</span>
        <select value={pageSize} onChange={(event) => onPageSize(event.target.value)}>
          {pageSizeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>
  );
}

function InternetMonitorList({ monitors, selectedMonitorId, onSelect, onCheck, onDelete, pending, ui }) {
  return (
    <div className="internet-monitor-list">
      {monitors.map((monitor) => (
        <article className={`internet-monitor-row ${monitor.status || "unknown"} ${String(monitor.id) === String(selectedMonitorId) ? "active" : ""}`} key={monitor.id}>
          <button className="internet-monitor-main" type="button" onClick={() => onSelect(monitor.id)}>
            <div className="internet-monitor-title">
              <ui.StatusBadge status={monitor.status} />
              <div><strong>{monitor.name}</strong><span>{monitor.config?.url || "-"}</span></div>
            </div>
            <div className="internet-monitor-meta">
              <span>{monitor.config?.method || "GET"}</span>
              <span>{monitor.config?.expectedStatus || 200}</span>
              <span>{monitorLatencyText(monitor)}</span>
              <span title={monitor.lastCheck ? ui.formatDateTime(monitor.lastCheck) : ""}>{monitor.lastCheck ? compactDateTime(monitor.lastCheck) : "-"}</span>
            </div>
          </button>
          <div className="internet-monitor-actions">
            <button className="mini-action internet-row-action" type="button" title="Check now" disabled={pending === `check-${monitor.id}`} onClick={() => onCheck(monitor.id)}>{ui.icon("play")}</button>
            <button className="mini-action danger internet-row-action" type="button" title="Delete monitor" onClick={() => onDelete(monitor)}>{ui.icon("trash")}</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function InternetPagination({ loading, page, pageCount, pageSize, total, count, onPage }) {
  const start = total ? page * pageSize + 1 : 0;
  const end = total ? Math.min(total, page * pageSize + count) : 0;
  return (
    <div className="internet-pagination">
      <span>{loading ? "Updating..." : `${start}-${end} of ${total}`}</span>
      <div>
        <button className="mini-action" type="button" disabled={page <= 0 || loading} onClick={() => onPage(Math.max(0, page - 1))}>Prev</button>
        <strong>{page + 1} / {pageCount}</strong>
        <button className="mini-action" type="button" disabled={page >= pageCount - 1 || loading} onClick={() => onPage(Math.min(pageCount - 1, page + 1))}>Next</button>
      </div>
    </div>
  );
}

function InternetLatencyPanel({ monitor, samples, sampleRange, onRangeChange, loading, error, onCheck, actions, pending, ui }) {
  if (!monitor) {
    return (
      <section className="panel internet-latency-panel">
        <div className="panel-head"><div><h2>Latency History</h2><p>Select or add a monitor.</p></div></div>
        {ui.emptyState("Select or add a monitor", "Latency history will appear after an HTTP or HTTPS monitor is selected.")}
      </section>
    );
  }
  const values = samples.map((sample) => Number(sample.valueNumber || 0)).filter((value) => Number.isFinite(value) && value >= 0);
  const latest = samples.at(-1);
  const peak = values.length ? Math.max(...values) : 0;
  return (
    <section className="panel internet-latency-panel">
      <div className="panel-head">
        <div><h2>Latency History</h2><p>{monitor.name} · {monitor.config?.url || "-"}</p></div>
        <div className="panel-head-actions">
          <button className="ghost-button" type="button" disabled={pending === `check-${monitor.id}`} onClick={() => onCheck(monitor.id)}>{ui.icon("play")} Check</button>
          <button className="ghost-button" type="button" onClick={() => actions.setRoute({ view: "sensor-detail", sensorId: monitor.id })}>Open Detail</button>
        </div>
      </div>
      <div className="internet-latency-body">
        <div className="chart-toolbar internet-chart-toolbar">
          <div className="chart-control-group"><span>Range</span><div className="segmented-control history-range-toggle" aria-label="History range">{sampleRangeOptions.map(([value, label]) => <button className={sampleRange === value ? "active" : ""} key={value} type="button" onClick={() => onRangeChange(value)}>{label}</button>)}</div></div>
        </div>
        <div className="chart-stats internet-latency-stats">
          <div><span>Current</span><strong>{latest?.valueNumber ? `${Math.round(Number(latest.valueNumber))} ms` : "-"}</strong></div>
          <div><span>Peak</span><strong>{peak ? `${Math.round(peak)} ms` : "-"}</strong></div>
          <div><span>Samples</span><strong>{samples.length}</strong></div>
          <div><span>Last Check</span><strong>{monitor.lastCheck ? ui.formatDateTime(monitor.lastCheck) : "-"}</strong></div>
        </div>
        {error ? <div className="modal-note error">{error}</div> : <InternetLatencyChart samples={samples} loading={loading} ui={ui} />}
      </div>
    </section>
  );
}

function InternetLatencyChart({ samples, loading, ui }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  useEffect(() => setHoverIndex(null), [samples.length]);
  if (loading) return <div className="empty-chart internet-latency-empty"><span>Loading latency samples</span></div>;
  if (!samples.length) return <div className="empty-chart internet-latency-empty"><span>No samples yet</span></div>;
  const domain = latencyDomain(samples);
  const values = samples.map((sample) => Number(sample.valueNumber || 0));
  const max = niceLatencyMax(Math.max(1, ...values));
  const points = samples.map((sample, index) => {
    const x = latencyX(sampleTime(sample, index, domain), domain);
    const y = latencyY(values[index], max);
    return { index, sample, x, y, value: values[index] || 0 };
  });
  const pointText = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const hover = points.find((point) => point.index === hoverIndex);
  return (
    <svg className="internet-latency-chart" viewBox="0 0 660 280" role="img" aria-label="HTTP latency history" onMouseLeave={() => setHoverIndex(null)}>
      <LatencyGrid max={max} domain={domain} />
      <polyline className="internet-latency-line" points={pointText} />
      {points.map((point) => <line key={point.index} className="internet-latency-hit" x1={point.x} x2={point.x} y1={latencyPlot.top} y2={latencyPlot.bottom} onMouseEnter={() => setHoverIndex(point.index)} onMouseMove={() => setHoverIndex(point.index)} />)}
      {hover && <LatencyTooltip point={hover} ui={ui} />}
    </svg>
  );
}

function LatencyGrid({ max, domain }) {
  const yTicks = [1, 0.75, 0.5, 0.25, 0];
  const xTicks = latencyTimeTicks(domain);
  return (
    <>
      <g className="chart-grid">
        <line x1={latencyPlot.left} y1={latencyPlot.top} x2={latencyPlot.left} y2={latencyPlot.bottom} />
        <line x1={latencyPlot.left} y1={latencyPlot.bottom} x2={latencyPlot.right} y2={latencyPlot.bottom} />
        {xTicks.map((tick) => <line key={`x-${tick.time}`} x1={tick.x} y1={latencyPlot.top} x2={tick.x} y2={latencyPlot.bottom} />)}
        {yTicks.map((ratio) => { const y = latencyPlot.bottom - ratio * latencyPlot.height; return <line key={`y-${ratio}`} x1={latencyPlot.left} y1={y} x2={latencyPlot.right} y2={y} />; })}
      </g>
      <g className="chart-axis-labels">
        {yTicks.map((ratio) => { const y = latencyPlot.bottom - ratio * latencyPlot.height; return <text key={`yl-${ratio}`} x={latencyPlot.left - 10} y={y + 4} textAnchor="end">{Math.round(max * ratio)}</text>; })}
        {xTicks.map((tick) => <text className="chart-time-label" key={`tl-${tick.time}`} x={tick.x} y="254" textAnchor="middle">{tick.label}</text>)}
        <text className="chart-axis-title" x={latencyPlot.left} y="20" textAnchor="start">MS</text>
        <text className="chart-axis-title" x={(latencyPlot.left + latencyPlot.right) / 2} y="274" textAnchor="middle">Time</text>
      </g>
    </>
  );
}

function LatencyTooltip({ point, ui }) {
  const width = 174;
  const height = 58;
  const x = clamp(point.x + 12, latencyPlot.left + 8, latencyPlot.right - width - 8);
  const y = clamp(point.y - height - 12, latencyPlot.top + 8, latencyPlot.bottom - height - 8);
  return (
    <g className="chart-hover-layer">
      <line className="chart-hover-line" x1={point.x} x2={point.x} y1={latencyPlot.top} y2={latencyPlot.bottom} />
      <circle className="chart-hover-point out" cx={point.x} cy={point.y} r="4" />
      <g className="chart-tooltip" transform={`translate(${x}, ${y})`}>
        <rect width={width} height={height} rx="7" />
        <text className="chart-tooltip-time" x="10" y="18">{ui.formatDateTime(point.sample?.createdAt)}</text>
        <text className="chart-tooltip-row" x="10" y="40"><tspan>Latency</tspan><tspan x="78">{point.sample?.valueText || `${Math.round(point.value)} ms`}</tspan></text>
      </g>
    </g>
  );
}

function latencyDomain(samples) {
  const times = samples.map((sample) => new Date(sample.createdAt || "").getTime()).filter((time) => Number.isFinite(time));
  const now = Date.now();
  const minTime = times.length ? Math.min(...times) : now - 60_000;
  const maxTime = times.length ? Math.max(...times) : now;
  const duration = Math.max(60_000, maxTime - minTime);
  const padding = Math.max(30_000, duration * 0.03);
  return { start: minTime - padding, end: maxTime + padding };
}

function sampleTime(sample, index, domain) {
  const time = new Date(sample?.createdAt || "").getTime();
  return Number.isFinite(time) ? time : domain.start + index * 30_000;
}

function latencyX(time, domain) {
  return latencyPlot.left + ((time - domain.start) / Math.max(1, domain.end - domain.start)) * latencyPlot.width;
}

function latencyY(value, max) {
  return latencyPlot.bottom - (Number(value || 0) / Math.max(1, max)) * latencyPlot.height;
}

function latencyTimeTicks(domain) {
  const ticks = [];
  const duration = Math.max(60_000, domain.end - domain.start);
  const step = latencyTickStep(duration);
  const first = Math.ceil(domain.start / step) * step;
  for (let time = first; time <= domain.end + 1; time += step) ticks.push({ time, label: formatLatencyTimeLabel(time, duration), x: latencyX(time, domain) });
  return ticks;
}

function latencyTickStep(duration) {
  if (duration <= 2 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (duration <= 36 * 60 * 60 * 1000) return 4 * 60 * 60 * 1000;
  if (duration <= 10 * 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return 5 * 24 * 60 * 60 * 1000;
}

function formatLatencyTimeLabel(value, duration = 0) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  if (duration > 36 * 60 * 60 * 1000) return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
  if (duration > 2 * 60 * 60 * 1000) return `${String(date.getDate()).padStart(2, "0")}/${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function niceLatencyMax(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 1;
  const padded = number * 1.18;
  const exponent = Math.floor(Math.log10(padded));
  const base = 10 ** exponent;
  const normalized = padded / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

function monitorLatencyText(monitor) {
  const value = monitorLatencyValue(monitor);
  return Number.isFinite(value) && value > 0 ? `${Math.round(value)} ms` : "-";
}

function monitorLatencyValue(monitor) {
  const direct = Number(monitor?.valueNumber);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return parseLatencyValue(monitor?.lastValue || "");
}

function parseLatencyValue(value) {
  const text = String(value || "");
  const ms = text.match(/([\d.]+)\s*ms\b/i);
  if (ms) return Number(ms[1]);
  const seconds = text.match(/([\d.]+)\s*s(ec|econds?)?\b/i);
  if (seconds) return Number(seconds[1]) * 1000;
  return 0;
}

function compactDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function emptyInternetSummary() {
  return { up: 0, warning: 0, down: 0, unknown: 0, paused: 0, total: 0 };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function InternetMonitorModal({ actions, ui }) {
  const [form, setForm] = useState({
    name: "",
    url: "https://",
    method: "GET",
    expectedStatus: 200,
    timeout: 5,
    keyword: "",
    verifyTls: true,
    interval: 30,
  });
  const [error, setError] = useState("");
  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await actions.saveInternetMonitor({
        ...form,
        type: "http",
        interval: Number(form.interval || 30),
        expectedStatus: Number(form.expectedStatus || 200),
        timeout: Number(form.timeout || 5),
      });
      actions.closeModal();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <ui.ModalShell title="Add Internet Monitor" caption="Create an HTTP or HTTPS uptime check" actions={actions} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Name<input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Company Website" /></label>
          <label>URL<input required value={form.url} onChange={(event) => update("url", event.target.value)} placeholder="https://example.com" /></label>
          <label>Method<select value={form.method} onChange={(event) => update("method", event.target.value)}>{methodOptions.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
          <label>Expected Status<input type="number" min="100" max="599" value={form.expectedStatus} onChange={(event) => update("expectedStatus", event.target.value)} /></label>
          <label>Timeout Seconds<input type="number" min="1" step="0.5" value={form.timeout} onChange={(event) => update("timeout", event.target.value)} /></label>
          <label>Interval Seconds<input type="number" min="10" value={form.interval} onChange={(event) => update("interval", event.target.value)} /></label>
          <label className="wide">Keyword Match<input value={form.keyword} onChange={(event) => update("keyword", event.target.value)} placeholder="Optional text expected in response body" /></label>
          <label className="wide check-label"><input type="checkbox" checked={!!form.verifyTls} onChange={(event) => update("verifyTls", event.target.checked)} /> Verify TLS certificate</label>
        </div>
        <ui.FormMessage error={error}>The monitor will be grouped under the system Internet device.</ui.FormMessage>
        <ui.ModalActions actions={actions} submitLabel="Save & Check" />
      </form>
    </ui.ModalShell>
  );
}
