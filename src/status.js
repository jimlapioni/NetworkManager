export const statusLabels = { up: "Up", warning: "Warning", down: "Critical", unknown: "Unknown", paused: "Paused" };
export const statusRank = ["down", "warning", "unknown", "paused", "up"];

export function normalizeStatus(status) {
  return statusLabels[status] ? status : "unknown";
}

export function aggregateStatus(statuses) {
  return [...statuses].sort((a, b) => statusRank.indexOf(a) - statusRank.indexOf(b))[0] || "unknown";
}
