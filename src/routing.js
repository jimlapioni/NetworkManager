export function parseRouteHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "device" && parts[1]) return { view: "device-detail", deviceId: parts[1], sensorId: null };
  if (parts[0] === "sensor" && parts[1]) return { view: "sensor-detail", deviceId: null, sensorId: parts[1] };
  if (["dashboard", "internet", "devices", "sensors", "events"].includes(parts[0])) return { view: parts[0], deviceId: null, sensorId: null };
  return { view: "dashboard", deviceId: null, sensorId: null };
}

export function routeHash(route) {
  if (route.view === "device-detail" && route.deviceId) return `#/device/${route.deviceId}`;
  if (route.view === "sensor-detail" && route.sensorId) return `#/sensor/${route.sensorId}`;
  if (["internet", "devices", "sensors", "events"].includes(route.view)) return `#/${route.view}`;
  return "#/dashboard";
}
