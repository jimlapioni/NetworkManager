import { statusLabels } from "./status.js";

export const chartPlot = { left: 82, right: 744, top: 36, bottom: 268 };
chartPlot.width = chartPlot.right - chartPlot.left;
chartPlot.height = chartPlot.bottom - chartPlot.top;

export const chartTimeStepMs = 30 * 1000;

export function miniChartPoints(values, max, width, height) {
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

export function chartLineSegments(values, max, samples, domain) {
  const segments = [];
  let segment = [];
  values.forEach((value, index) => {
    if (!isFiniteNumber(value)) {
      if (segment.length >= 2) segments.push(segment.join(" "));
      segment = [];
      return;
    }
    const x = chartSampleX(samples[index], index, domain);
    const y = chartY(value, max);
    segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (segment.length >= 2) segments.push(segment.join(" "));
  return segments;
}

export function chartSampleX(sample, index, domain) {
  const time = new Date(sample?.createdAt || "").getTime();
  return chartX(Number.isFinite(time) ? time : domain.start + index * chartTimeStepMs, domain);
}

export function chartY(value, max) {
  return chartPlot.bottom - (Number(value || 0) / Math.max(1, max)) * chartPlot.height;
}

export function clampChartValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function chartDomain(samples) {
  const times = samples.map((sample) => new Date(sample.createdAt || "").getTime()).filter((time) => Number.isFinite(time));
  const now = Date.now();
  const minTime = times.length ? Math.min(...times) : now - chartTimeStepMs;
  const maxTime = times.length ? Math.max(...times) : now;
  const duration = Math.max(chartTimeStepMs, maxTime - minTime);
  const padding = Math.max(chartTimeStepMs, duration * 0.03);
  let start = minTime - padding;
  let end = maxTime + padding;
  if (end <= start) end = start + chartTimeStepMs;
  return { start, end };
}

export function chartVisibleSamples(samples, domain) {
  const visible = samples.filter((sample) => {
    const time = new Date(sample.createdAt || "").getTime();
    return Number.isFinite(time) && time >= domain.start && time <= domain.end;
  });
  return visible.length ? visible : samples.slice(-1);
}

export function chartX(time, domain) {
  return chartPlot.left + ((time - domain.start) / Math.max(1, domain.end - domain.start)) * chartPlot.width;
}

export function chartTimeTicks(domain) {
  const ticks = [];
  const duration = Math.max(chartTimeStepMs, domain.end - domain.start);
  const step = chartTickStep(duration);
  const first = Math.ceil(domain.start / step) * step;
  for (let time = first; time <= domain.end + 1; time += step) ticks.push({ time, label: formatChartTimeLabel(time, duration), x: chartX(time, domain) });
  return ticks;
}

export function chartTickStep(duration) {
  if (duration <= 2 * 60 * 60 * 1000) return 10 * 60 * 1000;
  if (duration <= 36 * 60 * 60 * 1000) return 4 * 60 * 60 * 1000;
  if (duration <= 10 * 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return 5 * 24 * 60 * 60 * 1000;
}

export function chartScale(max, type, unit = "") {
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

export function niceAxisMax(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 1;
  const padded = number * 1.12;
  const exponent = Math.floor(Math.log10(padded));
  const base = 10 ** exponent;
  const normalized = padded / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

export function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatRate(value) {
  let current = Number(value || 0);
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let unit = units[0];
  for (let index = 0; index < units.length - 1 && Math.abs(current) >= 1000; index += 1) {
    current /= 1000;
    unit = units[index + 1];
  }
  return `${current.toFixed(2)} ${unit}`;
}

export function formatNullableRate(value) {
  return isFiniteNumber(value) ? formatRate(value) : "-";
}

export function sampleIssueText(sample) {
  const status = statusLabels[sample?.status] || "No data";
  const value = String(sample?.valueText || "").trim();
  const text = value && value !== "-" ? value : "No numeric data";
  const message = `${status}: ${text}`;
  return message.length > 36 ? `${message.slice(0, 33)}...` : message;
}

export function shortInterfaceName(value) {
  return String(value || "").trim().replace(/^Ten-GigabitEthernet/i, "Te").replace(/^M-GigabitEthernet/i, "M-Gi").replace(/^GigabitEthernet/i, "Gi").replace(/^Bridge-Aggregation/i, "BAGG").replace(/^Vlan-interface/i, "Vlan").replace(/\s+/g, " ");
}

export function formatAxisValue(value, scale) {
  const scaled = Number(value || 0) / scale.divisor;
  if (Math.abs(scaled) >= 100) return scaled.toFixed(0);
  if (Math.abs(scaled) >= 10) return scaled.toFixed(1);
  return scaled.toFixed(2);
}

export function formatChartTimeLabel(value, duration = 0) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  if (duration > 36 * 60 * 60 * 1000) return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
  if (duration > 2 * 60 * 60 * 1000) return `${String(date.getDate()).padStart(2, "0")}/${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return value || "-";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function clampPercent(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
