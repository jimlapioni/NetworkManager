import { clampPercent, shortInterfaceName } from "./charts.js";

export function topologyPairKey(link) {
  const a = String(link.sourceDeviceId || "");
  const b = String(link.targetDeviceId || "");
  return [a, b].sort().join(":");
}

export function topologyInterfaceToken(value) {
  const token = shortInterfaceName(value).split(/\s+/)[0] || "";
  const normalized = token.replace(/[(),]/g, "");
  if (!normalized) return "";
  const patterns = [
    /^Gi\d/i,
    /^Te\d/i,
    /^Fa\d/i,
    /^Eth\d/i,
    /^Ethernet\d/i,
    /^GE\d/i,
    /^XGE\d/i,
    /^M-Gi\d/i,
    /^BAGG\d/i,
    /^Vlan\d/i,
    /^Po\d/i,
    /^Port-channel\d/i,
    /^Loopback\d/i,
    /^InLoopBack\d/i,
    /^NULL\d/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized)) ? normalized : "";
}

export function topologyPortScore(value) {
  const token = topologyInterfaceToken(value);
  if (!token) return 0;
  if (/^(Gi|Te|Fa|Eth|Ethernet|GE|XGE|M-Gi)\d/i.test(token)) return 6;
  if (/^(BAGG|Po|Port-channel)\d/i.test(token)) return 4;
  if (/^(Vlan|Loopback|InLoopBack|NULL)\d/i.test(token)) return 2;
  return 1;
}

export function topologyLinkScore(link) {
  const sourceScore = topologyPortScore(link.localPort);
  const targetScore = topologyPortScore(link.remotePortId || link.remotePort);
  const targetIdBonus = link.remotePortId ? 2 : 0;
  return sourceScore + targetScore + targetIdBonus;
}

export function topologyNormalizedPort(value) {
  return (topologyPortLabel(value) || shortInterfaceName(value)).toLowerCase();
}

export function topologyLinksAreReciprocal(a, b) {
  if (String(a.sourceDeviceId) !== String(b.targetDeviceId) || String(a.targetDeviceId) !== String(b.sourceDeviceId)) return false;
  const aLocal = topologyNormalizedPort(a.localPort);
  const aRemote = topologyNormalizedPort(a.remotePortId || a.remotePort);
  const bLocal = topologyNormalizedPort(b.localPort);
  const bRemote = topologyNormalizedPort(b.remotePortId || b.remotePort);
  return !!aLocal && !!aRemote && aLocal === bRemote && aRemote === bLocal;
}

export function collapseTopologyLinks(links) {
  const groups = new Map();
  for (const link of links) {
    if (!link.sourceDeviceId || !link.targetDeviceId) continue;
    const key = topologyPairKey(link);
    groups.set(key, [...(groups.get(key) || []), link]);
  }
  return Array.from(groups.values()).map((group) => group.reduce((best, link) => {
    const reciprocalBonus = group.some((candidate) => candidate !== link && topologyLinksAreReciprocal(link, candidate)) ? 20 : 0;
    const score = topologyLinkScore(link) + reciprocalBonus;
    const bestReciprocalBonus = group.some((candidate) => candidate !== best && topologyLinksAreReciprocal(best, candidate)) ? 20 : 0;
    const bestScore = topologyLinkScore(best) + bestReciprocalBonus;
    return score > bestScore ? link : best;
  }, group[0]));
}

export function topologyPortLabel(value) {
  const label = topologyInterfaceToken(value);
  if (!label) return "";
  return label.length > 18 ? `${label.slice(0, 17)}...` : label;
}

export function topologyLabelPoint(source, target, ratio) {
  const x = source.x + (target.x - source.x) * ratio;
  const y = source.y + (target.y - source.y) * ratio;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(3.2, Math.max(1.7, length * 0.045));
  return {
    x: clampPercent(x + (-dy / length) * offset, 6, 94),
    y: clampPercent(y + (dx / length) * offset, 8, 92),
  };
}

export function annotateNeighborWithDiscoveredNode(neighbor, discoveredNodes) {
  const node = discoveredNodes.find((item) => {
    if (neighbor.discoveredNodeId && String(item.id) === String(neighbor.discoveredNodeId)) return true;
    if (neighbor.identityKey && item.identityKey === neighbor.identityKey) return true;
    if (neighbor.remoteManagementIp && item.managementIp && String(item.managementIp).toLowerCase() === String(neighbor.remoteManagementIp).toLowerCase()) return true;
    if (neighbor.remoteChassisId && item.chassisId && String(item.chassisId).toLowerCase() === String(neighbor.remoteChassisId).toLowerCase()) return true;
    if (neighbor.remoteSystemName && item.hostname && String(item.hostname).toLowerCase() === String(neighbor.remoteSystemName).toLowerCase()) return true;
    return false;
  });
  return node ? { ...neighbor, discoveredNode: node, discoveredNodeId: node.id, discoveredNodeStatus: node.status } : neighbor;
}

export function deviceNameById(devices, id) {
  return devices.find((device) => String(device.id) === String(id))?.name || "";
}
