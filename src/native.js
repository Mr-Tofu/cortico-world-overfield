/**
 * Win32 bridge for the OverField World.
 *
 * Loaded lazily from Coopanion's own koffi copy, like the keyhold World does.
 * Only input, window lookup and the clipboard live here: the extension never
 * captures the screen.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;
const MOUSEEVENTF_LEFTDOWN = 0x2;
const MOUSEEVENTF_LEFTUP = 0x4;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const VK_MENU = 0x12;

let native = null;

function loadKoffi() {
  const attempts = [];
  try {
    attempts.push(createRequire(import.meta.url));
  } catch {
    // ignore
  }
  const appRoot = process.env.COOPANION_APP_ROOT;
  if (appRoot) {
    try {
      attempts.push(createRequire(join(appRoot, 'package.json')));
    } catch {
      // ignore
    }
  }
  try {
    attempts.push(createRequire(join(dirname(process.execPath), 'resources', 'app', 'package.json')));
  } catch {
    // ignore
  }
  try {
    attempts.push(createRequire(join(process.cwd(), 'package.json')));
  } catch {
    // ignore
  }

  const errors = [];
  for (const require of attempts) {
    try {
      return require('koffi');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`找不到 koffi（Coopanion 自带），扩展无法操作窗口：${errors[0] ?? '未知原因'}`);
}

function build() {
  const koffi = loadKoffi();
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');

  const RECT = koffi.struct('OVERFIELD_RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  const POINT = koffi.struct('OVERFIELD_POINT', { x: 'long', y: 'long' });
  const KEYBDINPUT = koffi.struct('OVERFIELD_KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const MOUSEINPUT = koffi.struct('OVERFIELD_MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('OVERFIELD_HARDWAREINPUT', {
    uMsg: 'uint32_t',
    wParamL: 'uint16_t',
    wParamH: 'uint16_t',
  });
  const INPUT = koffi.struct('OVERFIELD_INPUT', {
    type: 'uint32_t',
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });
  const EnumWindowsProc = koffi.proto('bool __stdcall OVERFIELD_EnumWindowsProc(void *hwnd, intptr_t lParam)');

  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
  const EnumWindows = user32.func('bool __stdcall EnumWindows(OVERFIELD_EnumWindowsProc *cb, intptr_t lParam)');
  const IsWindow = user32.func('bool __stdcall IsWindow(void *hwnd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int max)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *buf, int max)');
  const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hwnd)');
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hwnd)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)');
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t attach, uint32_t attachTo, bool attachFlag)');
  const GetClientRect = user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ OVERFIELD_RECT *rect)');
  const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ OVERFIELD_POINT *point)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ OVERFIELD_RECT *rect)');
  const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ OVERFIELD_POINT *point)');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, OVERFIELD_INPUT *inputs, int size)');
  const OpenClipboard = user32.func('bool __stdcall OpenClipboard(void *hwnd)');
  const CloseClipboard = user32.func('bool __stdcall CloseClipboard()');
  const EmptyClipboard = user32.func('bool __stdcall EmptyClipboard()');
  const GetClipboardData = user32.func('void * __stdcall GetClipboardData(uint32_t format)');
  const SetClipboardData = user32.func('void * __stdcall SetClipboardData(uint32_t format, void *memory)');

  const GlobalAlloc = kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, uintptr_t bytes)');
  const GlobalLock = kernel32.func('void * __stdcall GlobalLock(void *memory)');
  const GlobalUnlock = kernel32.func('bool __stdcall GlobalUnlock(void *memory)');
  const GlobalSize = kernel32.func('uintptr_t __stdcall GlobalSize(void *memory)');
  const GlobalFree = kernel32.func('void * __stdcall GlobalFree(void *memory)');
  const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');
  const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
  const Sleep = kernel32.func('void __stdcall Sleep(uint32_t ms)');
  const DwmGetWindowAttributeInt = dwmapi.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attr, _Out_ int *value, uint32_t size)');

  // Electron is normally already per-monitor aware. This is best effort: calling
  // it after the GUI exists can fail, and that failure is harmless here.
  try {
    SetProcessDpiAwarenessContext(-4);
  } catch {
    // ignore
  }

  const inputSize = koffi.sizeof(INPUT);
  const hwndKey = (hwnd) => {
    try {
      return koffi.address(hwnd).toString(16);
    } catch {
      return '';
    }
  };
  const sameWindow = (a, b) => !!a && !!b && hwndKey(a) === hwndKey(b);

  function keyEvent(vk, up, extended = false) {
    return {
      type: INPUT_KEYBOARD,
      u: {
        ki: {
          wVk: vk,
          wScan: 0,
          dwFlags: (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0),
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
  }

  function mouseEvent(flags) {
    return {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
  }

  function send(events) {
    if (!events.length) return;
    const sent = SendInput(events.length, events, inputSize);
    if (sent !== events.length) {
      throw new Error(`SendInput 只送出 ${sent}/${events.length} 个事件（可能被更高权限的窗口挡住）`);
    }
  }

  function foregroundHandle() {
    return GetForegroundWindow();
  }

  function processName(pid) {
    const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!process) return null;
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (!QueryFullProcessImageNameW(process, 0, buf, size)) return null;
      const path = String.fromCharCode(...buf.subarray(0, size[0]));
      return path.slice(path.lastIndexOf('\\') + 1);
    } finally {
      CloseHandle(process);
    }
  }

  function clientRect(hwnd) {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetClientRect(hwnd, rect)) return null;
    const point = { x: 0, y: 0 };
    if (!ClientToScreen(hwnd, point)) return null;
    return {
      x: point.x,
      y: point.y,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    };
  }

  function frameRect(hwnd) {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!GetWindowRect(hwnd, rect)) return null;
    return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  }

  function windows() {
    const result = [];
    const fg = foregroundHandle();
    const buf = new Uint16Array(512);
    const classBuf = new Uint16Array(256);
    EnumWindows((hwnd) => {
      if (!IsWindowVisible(hwnd)) return true;
      if (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
      const cloaked = [0];
      if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
      const length = GetWindowTextW(hwnd, buf, buf.length);
      if (length <= 0) return true;
      const title = String.fromCharCode(...buf.subarray(0, length));
      const classLength = GetClassNameW(hwnd, classBuf, classBuf.length);
      const className = classLength > 0 ? String.fromCharCode(...classBuf.subarray(0, classLength)) : '';
      const pidOut = [0];
      GetWindowThreadProcessId(hwnd, pidOut);
      result.push({
        hwnd,
        handle: hwndKey(hwnd),
        title,
        className,
        pid: pidOut[0],
        process: processName(pidOut[0]),
        client: clientRect(hwnd),
        frame: frameRect(hwnd),
        minimized: !!IsIconic(hwnd),
        foreground: sameWindow(hwnd, fg),
      });
      return true;
    }, 0);
    return result;
  }

  function isForeground(hwnd) {
    return sameWindow(hwnd, foregroundHandle());
  }

  function focus(hwnd) {
    if (!hwnd || !IsWindow(hwnd)) return { ok: false, reason: '窗口已经不在了' };
    if (isForeground(hwnd)) return { ok: true, foreground: true };
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    ShowWindow(hwnd, SW_SHOW);
    // Windows only lets the foreground process hand focus away. A synthetic
    // Alt tap is the same workaround the built-in computer-use engine uses.
    try {
      send([keyEvent(VK_MENU, false), keyEvent(VK_MENU, true)]);
    } catch {
      // the SetForegroundWindow attempts below may still work
    }
    SetForegroundWindow(hwnd);
    BringWindowToTop(hwnd);
    Sleep(60);
    if (isForeground(hwnd)) return { ok: true, foreground: true };

    // Attach to the current foreground thread and try once more. This is the
    // standard fallback when a different process owns the foreground.
    const fg = foregroundHandle();
    if (fg) {
      const fgPid = [0];
      const fgThread = GetWindowThreadProcessId(fg, fgPid);
      const current = GetCurrentThreadId();
      let attached = false;
      try {
        attached = !!AttachThreadInput(current, fgThread, true);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        Sleep(40);
      } finally {
        if (attached) AttachThreadInput(current, fgThread, false);
      }
    }
    return isForeground(hwnd) ? { ok: true, foreground: true } : { ok: false, reason: 'Windows 没有把前台让给游戏窗口' };
  }

  function down(key) {
    send([keyEvent(key.vk, false, key.extended)]);
  }

  function up(key) {
    send([keyEvent(key.vk, true, key.extended)]);
  }

  function chord(keys, holdMs) {
    if (!keys.length) throw new Error('没有按键');
    let sentDown = false;
    try {
      send(keys.map((key) => keyEvent(key.vk, false, key.extended)));
      sentDown = true;
      if (holdMs > 0) Sleep(holdMs);
    } finally {
      if (sentDown) send([...keys].reverse().map((key) => keyEvent(key.vk, true, key.extended)));
    }
  }

  function click(x, y) {
    if (!SetCursorPos(Math.round(x), Math.round(y))) throw new Error('SetCursorPos 失败');
    Sleep(20);
    send([mouseEvent(MOUSEEVENTF_LEFTDOWN), mouseEvent(MOUSEEVENTF_LEFTUP)]);
  }

  // Clipboard text goes through PowerShell: the FFI koffi.view path over a
  // GlobalLock pointer aborts the whole process on some clipboards (exit 134).
  function psRun(script, timeoutMs = 10000) {
    const win = process.env.SystemRoot || 'C:\\Windows';
    const exe = join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return spawnSync(exe, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      encoding: 'buffer',
      timeout: timeoutMs,
      windowsHide: true,
    });
  }

  function clipboardGetText() {
    // Read through a real variable: Get-Clipboard writes errors to stderr and
    // returns nothing while another process holds the clipboard.
    const result = psRun("$t=$null; try { $t=Get-Clipboard -Raw -ErrorAction Stop } catch { }; if ($null -ne $t) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)) }");
    const out = String(result.stdout ?? '').trim();
    if (!out) return null;
    return Buffer.from(out, 'base64').toString('utf8');
  }

  function clipboardSetText(text) {
    const wanted = String(text ?? '');
    const b64 = Buffer.from(wanted, 'utf8').toString('base64');
    const script = b64
      ? "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')); Set-Clipboard -Value $t"
      : 'Set-Clipboard';
    // Set-Clipboard often reports ExternalException even though the text did
    // land, so success is decided by reading the clipboard back.
    for (let attempt = 0; attempt < 3; attempt++) {
      psRun(script);
      const current = clipboardGetText();
      if (wanted === '' ? !current : current === wanted) return;
    }
    throw new Error('clipboard write failed');
  }

  function cursor() {
    const p = { x: 0, y: 0 };
    if (!GetCursorPos(p)) return null;
    return { x: p.x, y: p.y };
  }

  function alive(hwnd) {
    return !!hwnd && !!IsWindow(hwnd);
  }

  return {
    windows,
    processName,
    clientRect,
    frameRect,
    isForeground,
    focus,
    alive,
    chord,
    down,
    up,
    click,
    clipboardGetText,
    clipboardSetText,
    cursor,
    sleep: Sleep,
  };
}

export function win32() {
  if (!native) native = build();
  return native;
}
