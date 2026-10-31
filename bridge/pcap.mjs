/**
 * Npcap (wpcap.dll) binding through Coopanion's own koffi.
 *
 * Live capture needs the Npcap driver, which is already installed for the
 * person's packet tools. On this machine it allows unprivileged capture; when
 * it does not, `openDevice` fails with Npcap's own message and the World
 * reports that instead of pretending the bridge works.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createSocket } from 'node:dgram';

const NPCAP_DLL = 'C:\\Windows\\System32\\Npcap\\wpcap.dll';

let koffiCache = null;

export function loadKoffi() {
  if (koffiCache) return koffiCache;
  const errors = [];
  const attempts = [];
  const appRoot = process.env.COOPANION_APP_ROOT;
  if (appRoot) attempts.push(join(appRoot, 'package.json'));
  attempts.push(join(dirname(process.execPath), 'resources', 'app', 'package.json'));
  attempts.push(join(process.cwd(), 'package.json'));
  for (const pkg of attempts) {
    try {
      const require = createRequire(pkg);
      koffiCache = require('koffi');
      return koffiCache;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`找不到 koffi（Coopanion 自带）：${errors[0] ?? '未知原因'}`);
}

function lib() {
  const koffi = loadKoffi();
  const wpcap = koffi.load(NPCAP_DLL);
  const pcapIf = koffi.struct('OFBRIDGE_pcap_if', {
    next: 'void *',
    name: 'char *',
    description: 'char *',
    addresses: 'void *',
    flags: 'uint32_t',
  });
  const pcapAddr = koffi.struct('OFBRIDGE_pcap_addr', {
    next: 'void *',
    addr: 'void *',
    netmask: 'void *',
    broadaddr: 'void *',
    dstaddr: 'void *',
  });
  const pcapPkthdr = koffi.struct('OFBRIDGE_pcap_pkthdr', {
    ts_sec: 'uint32_t',
    ts_usec: 'uint32_t',
    caplen: 'uint32_t',
    len: 'uint32_t',
  });
  const bpfProgram = koffi.struct('OFBRIDGE_bpf_program', { bf_len: 'uint32_t', bf_insns: 'void *' });

  return {
    koffi,
    pcapIf,
    pcapAddr,
    pcapPkthdr,
    bpfProgram,
    findalldevs: wpcap.func('int pcap_findalldevs(_Out_ void **alldevs, _Out_ char *errbuf)'),
    freealldevs: wpcap.func('void pcap_freealldevs(void *alldevs)'),
    openLive: wpcap.func('void *pcap_open_live(const char *device, int snaplen, int promisc, int to_ms, _Out_ char *errbuf)'),
    close: wpcap.func('void pcap_close(void *p)'),
    datalink: wpcap.func('int pcap_datalink(void *p)'),
    compile: wpcap.func('int pcap_compile(void *p, _Out_ OFBRIDGE_bpf_program *fp, const char *str, int optimize, uint32_t netmask)'),
    setfilter: wpcap.func('int pcap_setfilter(void *p, OFBRIDGE_bpf_program *fp)'),
    freecode: wpcap.func('void pcap_freecode(OFBRIDGE_bpf_program *fp)'),
    nextEx: wpcap.func('int pcap_next_ex(void *p, _Out_ OFBRIDGE_pcap_pkthdr **hdr, _Out_ uint8_t **data)'),
    stats: wpcap.func('int pcap_stats(void *p, _Out_ uint8_t *stats)'),
    version: wpcap.func('const char *pcap_lib_version()'),
  };
}

let cached = null;
function api() {
  if (!cached) cached = lib();
  return cached;
}

function errText(buffer) {
  const raw = typeof buffer === 'string' ? buffer : buffer?.[0] ?? '';
  return String(raw).replace(/\0[\s\S]*$/, '').trim();
}

export function npcapVersion() {
  try {
    return String(api().version()).replace(/\0[\s\S]*$/, '');
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Enumerate Npcap devices and their IPv4 addresses. */
export function listDevices() {
  const a = api();
  const errbuf = ['\0'.repeat(512)];
  const alldevs = [null];
  const rc = a.findalldevs(alldevs, errbuf);
  if (rc !== 0 || !alldevs[0]) {
    throw new Error(`Npcap 枚举网卡失败：${errText(errbuf) || `rc=${rc}`}`);
  }
  const devices = [];
  try {
    let ptr = alldevs[0];
    while (ptr) {
      const dev = a.koffi.decode(ptr, a.pcapIf);
      devices.push({
        name: String(dev.name ?? ''),
        description: String(dev.description ?? ''),
        flags: Number(dev.flags ?? 0),
        ips: readAddresses(a, dev.addresses),
      });
      ptr = dev.next;
    }
  } finally {
    a.freealldevs(alldevs[0]);
  }
  return devices;
}

function readAddresses(a, head) {
  const ips = [];
  let ptr = head;
  while (ptr) {
    const addr = a.koffi.decode(ptr, a.pcapAddr);
    if (addr.addr) {
      const bytes = a.koffi.decode(addr.addr, 'uint8_t', 16);
      const buf = Buffer.from(bytes);
      if (buf.readUInt16LE(0) === 2) ips.push(`${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`);
    }
    ptr = addr.next;
  }
  return ips;
}

/** Best-effort local IPv4 for the default route (no packet is sent). */
export function localAddress() {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = createSocket('udp4');
      socket.connect(53, '223.5.5.5', () => {
        const address = socket.address()?.address ?? '';
        socket.close();
        resolve(address);
      });
    } catch {
      try { socket?.close(); } catch { /* ignore */ }
      resolve('');
    }
  });
}

export function chooseDevice(devices, { preferred = '', localIp = '' } = {}) {
  const wanted = String(preferred ?? '').trim();
  if (wanted) {
    const hit = devices.find((d) => d.name === wanted || d.description === wanted || d.name.includes(wanted));
    if (hit) return hit;
    throw new Error(`指定的网卡不存在：${wanted}`);
  }
  if (localIp) {
    const byIp = devices.find((d) => d.ips.includes(localIp));
    if (byIp) return byIp;
  }
  const usable = devices.filter((d) => !/WAN Miniport|Loopback|Wi-Fi Direct/i.test(d.description));
  const running = usable.find((d) => (d.flags & 0x04) !== 0);
  if (running) return running;
  if (usable.length) return usable[0];
  if (devices.length) return devices[0];
  throw new Error('Npcap 没有可用网卡');
}

export function openDevice(deviceName, { filter = 'tcp', promisc = false, timeoutMs = 50 } = {}) {
  const a = api();
  const errbuf = ['\0'.repeat(512)];
  const handle = a.openLive(deviceName, 65535, promisc ? 1 : 0, timeoutMs, errbuf);
  if (!handle) {
    throw new Error(`打开网卡失败：${errText(errbuf) || '未知原因'}`);
  }
  const linkType = a.datalink(handle);
  if (filter) {
    const program = {};
    const rc = a.compile(handle, program, filter, 1, 0xffffffff);
    if (rc !== 0) {
      a.close(handle);
      throw new Error(`BPF 过滤规则编译失败：${filter}`);
    }
    try {
      const rc2 = a.setfilter(handle, program);
      if (rc2 !== 0) throw new Error(`BPF 过滤规则安装失败：${filter}`);
    } finally {
      a.freecode(program);
    }
  }
  return { handle, linkType };
}

export function nextPacket(capture) {
  const a = api();
  const hdr = [null];
  const data = [null];
  const rc = a.nextEx(capture.handle, hdr, data);
  if (rc === 0) return null; // read timeout
  if (rc === 1) {
    const meta = a.koffi.decode(hdr[0], a.pcapPkthdr);
    const bytes = a.koffi.decode(data[0], 'uint8_t', meta.caplen);
    return { tsMs: meta.ts_sec * 1000 + Math.floor(meta.ts_usec / 1000), bytes: Buffer.from(bytes) };
  }
  if (rc === -2) return null;
  throw new Error(`pcap_next_ex rc=${rc}`);
}

export function closeCapture(capture) {
  try {
    api().close(capture.handle);
  } catch {
    // already closed
  }
}
