import React, { useEffect, useMemo, useState } from "react";
import { apiRequest, normalizeList } from "../api.js";

const channelTypes = [
  ["webhook", "Webhook"],
  ["slack_webhook", "Slack"],
  ["teams_webhook", "Teams"],
  ["email", "Email"],
];

const defaultConfig = {
  webhook: { url: "" },
  slack_webhook: { url: "" },
  teams_webhook: { url: "" },
  email: { host: "", port: 587, from: "", to: "", username: "", password: "", useTls: true },
};

export function NotificationsView({ actions, pending, ui }) {
  const [channels, setChannels] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  async function loadNotifications() {
    setLoading(true);
    setError("");
    try {
      const [channelPayload, deliveryPayload] = await Promise.all([
        apiRequest("/api/notification-channels"),
        apiRequest("/api/notification-deliveries?limit=80"),
      ]);
      setChannels(normalizeList(channelPayload));
      setDeliveries(normalizeList(deliveryPayload));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadNotifications();
  }, [refreshKey]);

  useEffect(() => {
    const refresh = () => setRefreshKey((value) => value + 1);
    window.addEventListener("networkmanager:notifications-changed", refresh);
    return () => window.removeEventListener("networkmanager:notifications-changed", refresh);
  }, []);

  async function testChannel(channel) {
    setTestResult("");
    try {
      const result = await actions.testNotificationChannel(channel.id);
      setTestResult(`${channel.name}: ${result.ok ? "Test sent" : "Test failed"}${result.statusCode ? ` (${result.statusCode})` : ""}`);
      setRefreshKey((value) => value + 1);
    } catch (testError) {
      setTestResult(`${channel.name}: ${testError.message}`);
    }
  }

  async function deleteChannel(channel) {
    if (!window.confirm(`Delete notification channel "${channel.name}"?`)) return;
    await actions.deleteNotificationChannel(channel);
    setRefreshKey((value) => value + 1);
  }

  async function toggleChannel(channel) {
    await actions.saveNotificationChannel({ ...channel, enabled: !channel.enabled });
    setRefreshKey((value) => value + 1);
  }

  const enabledCount = channels.filter((channel) => channel.enabled).length;
  const failedCount = deliveries.filter((delivery) => delivery.status === "failed").length;
  const lastDelivery = deliveries[0];

  return (
    <main className="notifications-view">
      <section className="notification-summary-grid">
        {ui.metricCard("Channels", channels.length, "Configured targets", "cyan")}
        {ui.metricCard("Enabled", enabledCount, "Active delivery routes", "green")}
        {ui.metricCard("Failed", failedCount, "Recent delivery errors", "red")}
        {ui.metricCard("Last Delivery", lastDelivery ? ui.formatDateTime(lastDelivery.createdAt) : "-", "Most recent attempt", "blue")}
      </section>

      <section className="notifications-layout">
        <div className="panel notification-channel-panel">
          <div className="panel-head">
            <div><h2>Notification Channels</h2><p>Send alert events to webhook, Slack, Teams, or Email.</p></div>
            <button className="primary-button" type="button" onClick={() => actions.openModal({ type: "notification-channel" })}>{ui.icon("plus")} Channel</button>
          </div>
          {error ? <div className="modal-note error">{error}</div> : null}
          {testResult ? <div className="modal-note">{testResult}</div> : null}
          {loading ? (
            <div className="empty-state"><strong>Loading channels</strong><p>Reading notification configuration.</p></div>
          ) : channels.length ? (
            <div className="notification-channel-list">
              {channels.map((channel) => (
                <article className={`notification-channel-row ${channel.enabled ? "enabled" : "disabled"}`} key={channel.id}>
                  <div className="notification-channel-main">
                    <span className={`status-dot ${channel.enabled ? "up" : "unknown"}`} />
                    <div>
                      <strong>{channel.name}</strong>
                      <span>{channelTypeLabel(channel.type)} · {channelTarget(channel)}</span>
                    </div>
                  </div>
                  <div className="notification-channel-actions">
                    <button className="mini-action" type="button" disabled={pending === `notification-test-${channel.id}`} onClick={() => testChannel(channel)}>{pending === `notification-test-${channel.id}` ? "..." : "Test"}</button>
                    <button className="mini-action" type="button" onClick={() => toggleChannel(channel)}>{channel.enabled ? "Disable" : "Enable"}</button>
                    <button className="mini-action" type="button" onClick={() => actions.openModal({ type: "notification-channel", channel })}>{ui.icon("edit")} Edit</button>
                    <button className="mini-action danger" type="button" onClick={() => deleteChannel(channel)}>{ui.icon("trash")} Delete</button>
                  </div>
                </article>
              ))}
            </div>
          ) : ui.emptyState("No notification channels", "Add a webhook, Slack, Teams, or Email target to start sending alerts.")}
        </div>

        <div className="panel notification-delivery-panel">
          <div className="panel-head"><div><h2>Delivery Log</h2><p>Recent notification attempts and provider responses.</p></div><button className="ghost-button" type="button" onClick={() => setRefreshKey((value) => value + 1)}>{ui.icon("refresh")} Refresh</button></div>
          {deliveries.length ? <NotificationDeliveryTable deliveries={deliveries} ui={ui} /> : ui.emptyState("No deliveries yet", "Delivery records appear after a sensor changes status and a channel is enabled.")}
        </div>
      </section>
    </main>
  );
}

function NotificationDeliveryTable({ deliveries, ui }) {
  return (
    <div className="notification-delivery-table">
      <table>
        <thead><tr><th>Time</th><th>Channel</th><th>Type</th><th>Status</th><th>Code</th><th>Response</th></tr></thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td>{ui.formatDateTime(delivery.createdAt)}</td>
              <td>{delivery.channelName || "-"}</td>
              <td>{channelTypeLabel(delivery.channelType)}</td>
              <td><span className={`delivery-status ${delivery.status}`}>{delivery.status}</span></td>
              <td>{delivery.statusCode || "-"}</td>
              <td className="delivery-response">{delivery.response || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotificationChannelModal({ actions, pending, ui, channel }) {
  const editing = !!channel?.id;
  const [form, setForm] = useState(() => normalizeChannelForm(channel));
  const [error, setError] = useState("");

  const typeConfig = form.config || {};
  const typeLabel = channelTypeLabel(form.type);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateConfig(key, value) {
    setForm((current) => ({ ...current, config: { ...(current.config || {}), [key]: value } }));
  }

  function changeType(type) {
    setForm((current) => ({
      ...current,
      type,
      config: { ...(defaultConfig[type] || {}), ...(current.type === type ? current.config : {}) },
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await actions.saveNotificationChannel({ ...form, id: channel?.id });
      window.dispatchEvent(new CustomEvent("networkmanager:notifications-changed"));
      actions.closeModal();
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return (
    <ui.ModalShell title={editing ? "Edit Notification Channel" : "Add Notification Channel"} caption={`${typeLabel} delivery target`} actions={actions} wide>
      <form onSubmit={submit} className="notification-channel-form">
        <div className="form-grid">
          <label>Name<input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="NOC Webhook" /></label>
          <label>Type<select value={form.type} onChange={(event) => changeType(event.target.value)}>{channelTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="checkbox-label"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /> Enabled</label>
        </div>
        {form.type === "email" ? (
          <div className="form-grid notification-email-grid">
            <label>SMTP Host<input required value={typeConfig.host || ""} onChange={(event) => updateConfig("host", event.target.value)} placeholder="smtp.example.com" /></label>
            <label>Port<input type="number" min="1" max="65535" value={typeConfig.port || 587} onChange={(event) => updateConfig("port", event.target.value)} /></label>
            <label>From<input required value={typeConfig.from || ""} onChange={(event) => updateConfig("from", event.target.value)} placeholder="networkmanager@example.com" /></label>
            <label>To<input required value={typeConfig.to || ""} onChange={(event) => updateConfig("to", event.target.value)} placeholder="noc@example.com" /></label>
            <label>Username<input value={typeConfig.username || ""} onChange={(event) => updateConfig("username", event.target.value)} autoComplete="off" /></label>
            <label>Password<input type="password" value={typeConfig.password || ""} onChange={(event) => updateConfig("password", event.target.value)} placeholder={editing ? "Leave blank to keep existing password" : ""} autoComplete="new-password" /></label>
            <label className="checkbox-label"><input type="checkbox" checked={typeConfig.useTls !== false} onChange={(event) => updateConfig("useTls", event.target.checked)} /> Use TLS</label>
          </div>
        ) : (
          <label>Webhook URL<input required type="url" value={typeConfig.url || ""} onChange={(event) => updateConfig("url", event.target.value)} placeholder="https://hooks.example.com/networkmanager" /></label>
        )}
        <ui.FormMessage error={error}>{form.type === "email" ? "Email is advanced; leave password blank while editing to keep the stored value." : "Webhook tests send a synthetic NetworkManager alert payload."}</ui.FormMessage>
        <ui.ModalActions actions={actions} submitLabel={pending === "notification-channel" ? "Saving..." : "Save Channel"} />
      </form>
    </ui.ModalShell>
  );
}

function normalizeChannelForm(channel) {
  const type = channel?.type || "webhook";
  return {
    id: channel?.id,
    name: channel?.name || "",
    type,
    enabled: channel?.enabled !== false,
    config: { ...(defaultConfig[type] || {}), ...(channel?.config || {}), password: "" },
  };
}

function channelTypeLabel(type) {
  return Object.fromEntries(channelTypes)[type] || type || "-";
}

function channelTarget(channel) {
  const config = channel?.config || {};
  if (channel?.type === "email") return config.to || config.host || "Email target";
  return config.url || "Webhook URL";
}
