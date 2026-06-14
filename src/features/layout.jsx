import React from "react";
import { normalizeStatus, statusLabels } from "../status.js";

export function icon(name) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24"><path d="M3 4h8v8H3V4Zm10 0h8v5h-8V4ZM3 14h8v6H3v-6Zm10-3h8v9h-8v-9Z"/></svg>',
    internet: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 9h-3.1a15.6 15.6 0 0 0-1-5A8.03 8.03 0 0 1 18.9 11ZM12 4.1c.7 1 1.5 3.2 1.8 6.9h-3.6C10.5 7.3 11.3 5.1 12 4.1ZM4.1 13h3.1c.1 1.8.5 3.5 1 5A8.03 8.03 0 0 1 4.1 13Zm3.1-2H4.1A8.03 8.03 0 0 1 8.2 6a15.6 15.6 0 0 0-1 5ZM12 19.9c-.7-1-1.5-3.2-1.8-6.9h3.6c-.3 3.7-1.1 5.9-1.8 6.9ZM14.8 18c.5-1.5.9-3.2 1-5h3.1a8.03 8.03 0 0 1-4.1 5Z"/></svg>',
    server: '<svg viewBox="0 0 24 24"><path d="M4 3h16v8H4V3Zm2 2v4h12V5H6Zm-2 8h16v8H4v-8Zm2 2v4h12v-4H6Zm1-9h2v2H7V6Zm0 10h2v2H7v-2Z"/></svg>',
    sensor: '<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 1 4 4v5.2a6 6 0 1 1-8 0V6a4 4 0 0 1 4-4Zm-2 12-.4.3A4 4 0 1 0 14.4 14l-.4-.3V6a2 2 0 1 0-4 0v8Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 2 2 20h20L12 2Zm0 4 6.6 12H5.4L12 6Zm-1 4h2v5h-2v-5Zm0 6h2v2h-2v-2Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.3L13 11h8V3l-3.3 3.3Z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M16.8 3.2 20.8 7.2 8.5 19.5 4 20l.5-4.5L16.8 3.2Zm0 2.8L6.4 16.4l-.2 1.4 1.4-.2L18 7.2 16.8 6Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>',
    radar: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm1 1v9h7v-2h-4.2l4.8-4.8-1.4-1.4-4.8 4.8V4h-1.4Z"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.8 2.8 0 0 0 2.6-2h-5.2A2.8 2.8 0 0 0 12 22Zm7-5-2-2V9a5 5 0 0 0-4-4.9V2h-2v2.1A5 5 0 0 0 7 9v6l-2 2v1h14v-1Zm-4-1H9V9a3 3 0 0 1 6 0v7Z"/></svg>',
  };
  return <span dangerouslySetInnerHTML={{ __html: icons[name] || "" }} />;
}

export function Header({ route, summary, auth, actions }) {
  const titles = { dashboard: "Command Dashboard", internet: "Internet Monitoring", devices: "Device Inventory", sensors: "Sensor Console", events: "Alert Timeline", notifications: "Notifications", "device-detail": "Device Detail", "sensor-detail": "Sensor Detail" };
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
        {!["internet", "notifications"].includes(route.view) && <button className="primary-button" type="button" onClick={() => actions.openModal({ type: "device" })}>{icon("plus")} Device</button>}
      </div>
    </header>
  );
}

export function NavButton({ active, label, iconName, onClick }) {
  return <button className={active ? "active" : ""} type="button" onClick={onClick}>{icon(iconName)}<span>{label}</span></button>;
}

export function ModalShell({ title, caption, children, actions, wide = false, className = "" }) {
  return (
    <dialog open>
      <div className={`modal-card ${wide ? "" : "compact-modal"} ${className}`}>
        <div className="modal-head"><div><h2>{title}</h2><p>{caption}</p></div><button className="icon-button" type="button" onClick={actions.closeModal} aria-label="Close">{icon("close")}</button></div>
        {children}
      </div>
    </dialog>
  );
}

export function FormMessage({ error, children }) {
  return <div className={`modal-note ${error ? "error" : ""}`}>{error || children}</div>;
}

export function ModalActions({ actions, submitLabel }) {
  return <div className="modal-actions"><button className="ghost-button" type="button" onClick={actions.closeModal}>Cancel</button><button className="primary-button" type="submit">{submitLabel}</button></div>;
}

export function StatusBadge({ status = "unknown" }) {
  const normalized = normalizeStatus(status);
  return <span className={`status-badge ${normalized}`}><span />{statusLabels[normalized]}</span>;
}

export function Signal({ label, value, status }) {
  return <div className={`signal ${status}`}><span /><strong>{Number(value || 0).toLocaleString()}</strong><small>{label}</small></div>;
}

export function metricCard(label, value, caption, tone) {
  return <article className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>;
}

export function emptyState(title, body) {
  return <div className="empty-state"><strong>{title}</strong><p>{body}</p></div>;
}
