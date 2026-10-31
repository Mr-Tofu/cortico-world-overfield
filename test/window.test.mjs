import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreWindow } from '../src/window.js';

function window(overrides) {
  return {
    title: '',
    process: '',
    className: '',
    client: { width: 1600, height: 900 },
    minimized: false,
    foreground: false,
    ...overrides,
  };
}

test('the real game window wins: launcher.exe + Unity class + product title', () => {
  const game = window({ title: '开放空间', process: 'launcher.exe', className: 'UnityWndClass' });
  const other = window({ title: '开放空间 - Google Chrome', process: 'chrome.exe', className: 'Chrome_WidgetWin_1' });
  const pet = window({ title: '开放空间', process: 'Coopanion.exe', className: 'Chrome_WidgetWin_1' });
  assert.ok(scoreWindow(game) > 300);
  assert.equal(scoreWindow(other), 0);
  assert.equal(scoreWindow(pet), 0);
});

test('an OverField build without the product name in the title still matches', () => {
  const win = window({ title: 'TapTap 游戏', process: 'OverField.exe', className: 'UnityWndClass' });
  assert.ok(scoreWindow(win) >= 320);
});

test('a title-only match on an unknown process stays a weak fallback', () => {
  const unknown = window({ title: '开放空间交流群', process: 'someapp.exe', className: 'SomeClass' });
  const game = window({ title: 'OverField', process: 'launcher.exe', className: 'UnityWndClass' });
  const weak = scoreWindow(unknown);
  assert.ok(weak > 0, 'still usable when nothing better exists');
  assert.ok(weak < scoreWindow(game), 'never beats the real game window');
});

test('windows without a title, browsers and small helper windows are ignored', () => {
  assert.equal(scoreWindow(window({ title: '', process: 'launcher.exe' })), 0);
  assert.equal(scoreWindow(window({ title: '开放空间 - Google Chrome', process: 'chrome.exe' })), 0);
  assert.equal(scoreWindow(window({ title: '开放空间小助手', process: 'helper.exe', client: { width: 320, height: 200 } })), 0);
  assert.equal(scoreWindow(window({ title: '随便一个窗口', process: 'notepad.exe' })), 0);
});
