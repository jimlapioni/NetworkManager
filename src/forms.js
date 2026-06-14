import { formatRate } from "./charts.js";

export function thresholdForm(threshold, defaultMetric) {
  return {
    enabled: !!threshold?.enabled,
    metric: threshold?.metric || defaultMetric,
    warningOperator: threshold?.warningOperator || "",
    warningValue: threshold?.warningValue ?? "",
    criticalOperator: threshold?.criticalOperator || "",
    criticalValue: threshold?.criticalValue ?? "",
  };
}

export function portMetricOptions() {
  return [
    ["maxBps", "Max Traffic"],
    ["inBps", "Inbound"],
    ["outBps", "Outbound"],
  ];
}

export function defaultPortRule(severity = "warning", direction = "above") {
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

export function defaultInternetMonitorName(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.hostname || "HTTP Monitor";
  } catch {
    return "HTTP Monitor";
  }
}

export function normalizeThresholdRules(threshold) {
  return (threshold?.rules || []).map((rule) => normalizeClientThresholdRule(rule));
}

export function normalizeClientThresholdRule(rule) {
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

export function percentToMbps(percent, interfaceSpeed) {
  const bps = Number(interfaceSpeed || 0) * Number(percent || 0) / 100;
  return Number.isFinite(bps) ? Number((bps / 1_000_000).toFixed(2)) : "";
}

export function ruleLimitBps(rule, interfaceSpeed) {
  if (rule.mode === "absolute_mbps") return Number(rule.absoluteMbps || 0) * 1_000_000;
  return Number(interfaceSpeed || 0) * Number(rule.percent || 0) / 100;
}

export function describeClientRule(rule, interfaceSpeed) {
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

export function ruleSummaryTitle(rule) {
  const metric = Object.fromEntries(portMetricOptions())[rule.metric] || "Max Traffic";
  const sign = rule.direction === "below" ? "<" : ">";
  const value = rule.mode === "absolute_mbps"
    ? `${Number(rule.absoluteMbps || 0).toLocaleString()} Mbps`
    : `${Number(rule.percent || 0).toLocaleString()}%`;
  return `${metric} ${sign} ${value}`;
}

export function ruleModeLabel(rule) {
  return rule.mode === "absolute_mbps" ? "Advanced Mbps rule" : "Port speed percent rule";
}

export function operatorOptions() {
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

export function thresholdHint(sensor) {
  if (sensor.type === "snmp_traffic") return "Traffic thresholds use bps values. Example: 800000000 for 800 Mbps.";
  return "Numeric thresholds apply to the parsed sample value. Text-only SNMP values will not trigger numeric thresholds.";
}

export function existingTrafficKeys(sensors, deviceId) {
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

export function newDiscoveredTrafficInterfaces(items, sensors, deviceId) {
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

export function normalizeClientOid(value) {
  return String(value || "").trim().replace(/^\./, "").replace(/\s+/g, "");
}
