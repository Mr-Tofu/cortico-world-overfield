/**
 * Key names for `of_send_keys`. The vocabulary deliberately matches the built-in
 * `pet_cua_key` and the keyhold World: one chord, keys joined by `+`, names are
 * case-insensitive. This World only needs the keys a game actually uses.
 */

const NAMED = new Map();
const add = (names, vk, extended = false) => {
  for (const name of names) NAMED.set(name, { vk, extended });
};

add(['ctrl', 'control'], 0x11);
add(['shift'], 0x10);
add(['alt', 'option'], 0x12);
add(['win', 'windows', 'meta', 'super', 'cmd', 'command'], 0x5b, true);
add(['enter', 'return'], 0x0d);
add(['esc', 'escape'], 0x1b);
add(['tab'], 0x09);
add(['space'], 0x20);
add(['backspace'], 0x08);
add(['delete', 'del'], 0x2e, true);
add(['insert', 'ins'], 0x2d, true);
add(['home'], 0x24, true);
add(['end'], 0x23, true);
add(['pageup', 'pgup'], 0x21, true);
add(['pagedown', 'pgdn'], 0x22, true);
add(['left'], 0x25, true);
add(['up'], 0x26, true);
add(['right'], 0x27, true);
add(['down'], 0x28, true);
add(['capslock'], 0x14);
add(['printscreen', 'prtsc'], 0x2c, true);
add(['menu', 'apps', 'contextmenu'], 0x5d, true);
add(['volumeup'], 0xaf, true);
add(['volumedown'], 0xae, true);
add(['volumemute', 'mute'], 0xad, true);
add(['playpause'], 0xb3, true);
for (let i = 1; i <= 24; i++) add([`f${i}`], 0x6f + i);

const PUNCT = {
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
};
for (const [ch, vk] of Object.entries(PUNCT)) add([ch], vk);
add(['plus'], 0xbb);
add(['minus'], 0xbd);

export function keyCode(name) {
  const n = String(name).trim().toLowerCase();
  if (NAMED.has(n)) return NAMED.get(n);
  if (/^[a-z]$/.test(n)) return { vk: n.toUpperCase().charCodeAt(0), extended: false };
  if (/^[0-9]$/.test(n)) return { vk: n.charCodeAt(0), extended: false };
  return null;
}

/**
 * "shift+left" -> [{ name: 'shift', vk: 0x10, extended: false }, ...].
 * Whitespace means a sequence, which is refused: a hold is one chord.
 */
export function parseChord(spec) {
  const raw = typeof spec === 'string' ? spec.trim() : '';
  if (!raw) return { error: '没有给键名' };
  if (/\s/.test(raw)) return { error: `一次只能按一组键（用 + 连接，如 shift+left），收到「${raw}」` };
  if (raw.length > 64) return { error: '键名太长（最多 64 个字符）' };

  const names = raw === '+'
    ? ['plus']
    : raw.endsWith('++')
      ? [...raw.slice(0, -2).split('+'), 'plus']
      : raw.split('+');

  const seen = new Set();
  const keys = [];
  for (const name of names) {
    if (!name) return { error: `键名不完整：「${raw}」` };
    const code = keyCode(name);
    if (!code) return { error: `不认识这个键：「${name}」` };
    if (seen.has(code.vk)) continue;
    seen.add(code.vk);
    keys.push({ name: name.toLowerCase(), vk: code.vk, extended: code.extended });
  }
  if (!keys.length) return { error: `没有可用的键：「${raw}」` };
  return { keys };
}

export function chordLabel(keys) {
  return keys.map((key) => key.name).join('+');
}
