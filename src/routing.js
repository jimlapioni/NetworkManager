export function parseRouteHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "device" && parts[1]) return { view: "device-detail", deviceId: parts[1], sensorId: null, monitorId: null };
  if (parts[0] === "sensor" && parts[1]) return { view: "sensor-detail", deviceId: null, sensorId: parts[1], monitorId: null };
  if (parts[0] === "internet") return { view: "internet", deviceId: null, sensorId: null, monitorId: parts[1] || null };
  if (["dashboard", "devices", "sensors", "events", "notifications"].includes(parts[0])) return { view: parts[0], deviceId: null, sensorId: null, monitorId: null };
  return { view: "dashboard", deviceId: null, sensorId: null, monitorId: null };
}

export function routeHash(route) {
  if (route.view === "device-detail" && route.deviceId) return `#/device/${route.deviceId}`;
  if (route.view === "sensor-detail" && route.sensorId) return `#/sensor/${route.sensorId}`;
  if (route.view === "internet" && route.monitorId) return `#/internet/${route.monitorId}`;
  if (["internet", "devices", "sensors", "events", "notifications"].includes(route.view)) return `#/${route.view}`;
  return "#/dashboard";
}
