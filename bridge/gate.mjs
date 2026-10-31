/**
 * Read the current gateway address from the client's own log.
 *
 * The launcher asks the dispatch server for `gate_tcp_ip` / `gate_tcp_port`
 * and writes the JSON response into `ClientLog/*.txt`. That is the most
 * reliable way to show which server the session is on without touching the
 * game's memory or config.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function clientLogDir() {
  const base = process.env.USERPROFILE || process.env.HOME || '';
  return join(base, 'AppData', 'LocalLow', 'Inutan', '开放空间', 'ClientLog');
}

export function findGate(logDir = clientLogDir()) {
  if (!existsSync(logDir)) return null;
  let files;
  try {
    files = readdirSync(logDir).filter((name) => name.endsWith('.txt'));
  } catch {
    return null;
  }
  const newest = files
    .map((name) => ({ name, path: join(logDir, name), mtime: statSync(join(logDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  for (const file of newest) {
    let text = '';
    try {
      const size = statSync(file.path).size;
      const start = Math.max(0, size - 512 * 1024);
      const buf = readFileSync(file.path);
      text = buf.subarray(start).toString('utf8');
    } catch {
      continue;
    }
    const pattern = /"gate_tcp_ip"\s*:\s*"([0-9.]+)"\s*,\s*"gate_tcp_port"\s*:\s*(\d+)/g;
    let last = null;
    for (const match of text.matchAll(pattern)) {
      last = { ip: match[1], port: Number(match[2]) };
    }
    if (last) return { ...last, logFile: file.path };
  }
  return null;
}
