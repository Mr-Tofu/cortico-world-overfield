/**
 * Start/stop/observe the chat bridge process.
 *
 * The bridge is a plain Node script run with Coopanion's own Electron binary in
 * `ELECTRON_RUN_AS_NODE` mode, so the extension does not need a separate Node
 * install. It only reads packets through Npcap; no elevation is required when
 * Npcap was installed without its admin-only restriction (checked at runtime).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_SCRIPT = fileURLToPath(new URL('../bridge/main.mjs', import.meta.url));
export const RELAY_SCRIPT = fileURLToPath(new URL('../relay/main.mjs', import.meta.url));

export function readStatus(dir) {
  try {
    if (!existsSync(join(dir, 'status.json'))) return null;
    return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function statusAlive(status, now = Date.now()) {
  if (!status?.pid) return false;
  const updated = Date.parse(status.updatedAt ?? status.startedAt ?? '');
  if (!Number.isFinite(updated) || now - updated > 8000) return false;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function appRoot() {
  if (process.resourcesPath) return join(process.resourcesPath, 'app');
  return process.env.COOPANION_APP_ROOT ?? '';
}

export function startBridge({ dir, ports = '11000-11100', device = '', log = null } = {}) {
  const existing = readStatus(dir);
  if (statusAlive(existing)) {
    return { started: false, pid: existing.pid, status: existing };
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const root = appRoot();
  if (root) env.COOPANION_APP_ROOT = root;
  const args = [BRIDGE_SCRIPT, '--out', dir, '--ports', ports];
  if (device) args.push('--device', device);
  if (!existsSync(BRIDGE_SCRIPT)) throw new Error(`找不到桥接脚本：${BRIDGE_SCRIPT}`);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  log?.info?.('聊天桥接已启动', { pid: child.pid, dir, ports, device });
  return { started: true, pid: child.pid, status: null };
}

export function stopBridge({ dir, log = null } = {}) {
  const status = readStatus(dir);
  if (!status?.pid) {
    // Clear a stale status file so the next start is clean.
    try { rmSync(join(dir, 'status.json'), { force: true }); } catch { /* ignore */ }
    return { stopped: false, reason: '没有在运行的桥接' };
  }
  if (status.pid === process.pid) {
    // Never signal ourselves; a status file pointing here is stale or forged.
    try { rmSync(join(dir, 'status.json'), { force: true }); } catch { /* ignore */ }
    return { stopped: false, reason: '状态文件指向当前进程，已忽略' };
  }
  try {
    process.kill(status.pid);
    log?.info?.('聊天桥接已停止', { pid: status.pid });
    return { stopped: true, pid: status.pid };
  } catch (error) {
    try { rmSync(join(dir, 'status.json'), { force: true }); } catch { /* ignore */ }
    return { stopped: false, reason: String(error) };
  }
}

export function describeStatus(status) {
  if (!status) return '聊天进程：没有状态文件';
  const alive = statusAlive(status);
  const relay = status.mode === 'relay';
  const lines = [`聊天进程：${relay ? '本地中转' : '被动抓包'}${alive ? ' 运行中' : ' 未运行'}${status.pid ? `（pid ${status.pid}）` : ''}`];
  if (relay) {
    lines.push(`区服：${status.dispatchHost ?? '?'} → ${status.dispatchIp || '?'}`);
    lines.push(`本地端口：dispatch ${status.ports?.dispatch ?? '-'} / gate ${status.ports?.gate ?? '-'} / control ${status.ports?.control ?? '-'}`);
    lines.push(`hosts：${status.hostsActive ? '已指向 127.0.0.1' : '未配置（运行 relay/setup-hosts.cmd）'}`);
    lines.push(`下发：${status.dispatchRequests ?? 0} 次请求 / ${status.gateRewrites ?? 0} 次改写 / ${status.gateConnections ?? 0} 个网关连接`);
    lines.push(`发送：${status.injectedSends ?? 0} 条注入 / ${status.injectedOk ?? 0} 条回执 / ${status.injectedFailed ?? 0} 条超时`);
    if (status.gate?.ip) lines.push(`真实网关：${status.gate.ip}:${status.gate.port}`);
  } else {
    lines.push(`网卡：${status.deviceDescription || status.device || '未选择'}${status.localIp ? ` · 本机 ${status.localIp}` : ''}`);
    lines.push(`抓包：${status.packets ?? 0} 包 / ${status.tcpPackets ?? 0} TCP / ${status.frames ?? 0} 帧 / ${status.chats ?? 0} 条聊天`);
    if (status.gate?.ip) lines.push(`区服网关：${status.gate.ip}:${status.gate.port}`);
  }
  if (status.self?.name) lines.push(`本人角色：${status.self.name}`);
  if (status.lastError) lines.push(`最近错误：${status.lastError}`);
  if (status.updatedAt) lines.push(`心跳：${status.updatedAt}`);
  return lines.join('\n');
}

/** Start the local relay (read + protocol send). */
export function startRelay({
  dir, dispatchPort = 18881, gatePort = 18882, controlPort = 18883, dispatchIp = '', log = null,
} = {}) {
  const existing = readStatus(dir);
  if (statusAlive(existing) && existing.mode === 'relay') {
    return { started: false, pid: existing.pid, status: existing };
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const root = appRoot();
  if (root) env.COOPANION_APP_ROOT = root;
  const args = [
    RELAY_SCRIPT,
    '--out', dir,
    '--dispatch-port', String(dispatchPort),
    '--gate-port', String(gatePort),
    '--control-port', String(controlPort),
  ];
  if (dispatchIp) args.push('--dispatch-ip', dispatchIp);
  if (!existsSync(RELAY_SCRIPT)) throw new Error(`找不到中转脚本：${RELAY_SCRIPT}`);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  log?.info?.('本地中转已启动', { pid: child.pid, dir, dispatchPort, gatePort, controlPort });
  return { started: true, pid: child.pid, status: null };
}

/** POST a chat send to the running relay's control API. */
export async function relaySend({ dir, text, channel = 0, target = 0, controlPort = 0, timeoutMs = 8000 } = {}) {
  const status = readStatus(dir);
  // The running relay's own port wins: the config may have changed since it started.
  const port = status?.ports?.control || controlPort || 18883;
  const response = await fetch(`http://127.0.0.1:${port}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, channel, target }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `控制接口返回 ${response.status}`);
  return payload;
}

export function relayAlive(dir) {
  const status = readStatus(dir);
  return status?.mode === 'relay' && statusAlive(status);
}

async function relayPost(dir, path, payload, timeoutMs = 8000) {
  const status = readStatus(dir);
  const port = status?.ports?.control || 18883;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `控制接口返回 ${response.status}`);
  return data;
}

export function relayFriends(dir) {
  return relayPost(dir, '/friends', {});
}

export function relayHistory(dir, target) {
  return relayPost(dir, '/history', { target });
}

export function relayTeleport(dir, friendId) {
  return relayPost(dir, '/teleport', { friendId }, 12_000);
}
