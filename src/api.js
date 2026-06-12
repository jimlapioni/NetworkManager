export const emptySummary = { devices: 0, sensors: 0, up: 0, warning: 0, down: 0, unknown: 0 };
export const authTokenStorageKey = "networkManagerAuthToken";

export function authHeaders() {
  const token = window.localStorage.getItem(authTokenStorageKey);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiRequest(path, options = {}) {
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

export function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

export function normalizeSummary(value) {
  return { ...emptySummary, ...(value || {}) };
}
