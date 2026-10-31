/**
 * Find the OverField game window without asking the person to configure it.
 *
 * The game is a Unity standalone player, so its window class is the engine's
 * `UnityWndClass`; the shipped player executable is `launcher.exe` (the game
 * itself, next to `launcher_Data`), and an alternate build may use
 * `OverField.exe`. The title always carries the product name 开放空间/OverField.
 *
 * No single signal is trusted alone: a browser tab titled "开放空间 - Chrome"
 * must never receive key input.
 */

import { win32 } from './native.js';

const GAME_PROCESSES = ['launcher.exe', 'overfield.exe', 'overfield', '开放空间.exe'];
const TITLE_HINTS = ['开放空间', 'overfield'];
// Never treat the pet's own windows (Electron) as the game.
const BLOCKED_PROCESSES = ['coopanion.exe', 'electron.exe'];
// A browser tab can carry the product name; it must never receive key input.
const BROWSER_PROCESSES = /chrome|msedge|firefox|opera|brave|vivaldi|code|notepad|explorer/;

function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function scoreWindow(win) {
  const title = normalise(win.title);
  const process = normalise(win.process);
  const className = normalise(win.className);
  if (!title) return 0;
  if (BLOCKED_PROCESSES.some((name) => process === name || process.includes(name))) return 0;

  const titleHit = TITLE_HINTS.some((hint) => title.includes(hint));
  const processHit = GAME_PROCESSES.includes(process);
  const unityClass = className.includes('unitywndclass');
  if (!titleHit && !processHit) return 0;
  if (!processHit && BROWSER_PROCESSES.test(process)) return 0;

  let score = 0;
  if (titleHit) score += 240;
  if (processHit) score += 200;
  if (unityClass) score += 120;
  if (win.foreground) score += 20;
  if (!win.minimized) score += 10;
  if (win.client && win.client.width >= 800 && win.client.height >= 450) score += 10;

  // A title-only match on an unknown process is a last-resort fallback: keep it
  // below any real game window (process or Unity class) so it cannot win.
  if (!processHit && !unityClass) {
    const client = win.client;
    if (!client || client.width < 800 || client.height < 450) return 0;
    score = Math.min(score, 90);
  }
  return score;
}

function describeWindow(win) {
  const bits = [`「${win.title || '?'}」`];
  if (win.process) bits.push(win.process);
  if (win.className) bits.push(win.className);
  return bits.join(' · ');
}

/** Resolve the best matching visible top-level window; enumerate on every call. */
export function findGameWindow() {
  const native = win32();
  const windows = native.windows();
  let best = null;
  let bestScore = 0;
  for (const win of windows) {
    const score = scoreWindow(win);
    if (score > bestScore) {
      best = win;
      bestScore = score;
    }
  }
  if (!best) {
    return {
      window: null,
      reason: '没有找到开放空间的游戏窗口（进程 launcher.exe / OverField.exe，或标题含「开放空间」的大窗口）',
      visible: windows.filter((win) => win.client).slice(0, 8),
    };
  }
  if (!best.client || best.client.width < 64 || best.client.height < 64) {
    return { window: null, reason: '找到了窗口，但 client 尺寸不可用（可能最小化了）', visible: [best] };
  }
  return { window: best, reason: null };
}

export function windowCandidates(visible = []) {
  if (!visible.length) return '';
  return visible
    .slice(0, 6)
    .map((win) => describeWindow(win))
    .join('；');
}

/** Bring a found window forward; returns the native result. */
export function raiseWindow(win) {
  if (!win) return { ok: false, reason: '没有窗口' };
  return win32().focus(win.hwnd);
}

export function foreground(win) {
  return !!win && win32().isForeground(win.hwnd);
}

export function clientRect(win) {
  if (!win) return null;
  const fresh = win32().clientRect(win.hwnd);
  return fresh ?? win.client ?? null;
}

export { describeWindow };
