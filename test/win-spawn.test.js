const test = require('node:test');
const assert = require('node:assert');
const { winSpawnOptions, needsShellOnWin } = require('../src/lib/win-spawn');

const isWin = process.platform === 'win32';

test('off win32, winSpawnOptions is always a no-op', { skip: isWin }, () => {
  assert.deepEqual(winSpawnOptions('claude'), {});
  assert.deepEqual(winSpawnOptions('kiro-cli.cmd'), {});
  assert.equal(needsShellOnWin('claude'), false);
});

test('on win32, a bare CLI name needs the shell', { skip: !isWin }, () => {
  assert.equal(needsShellOnWin('kiro-cli'), true);
  assert.deepEqual(winSpawnOptions('kiro-cli'), { shell: true, windowsHide: true });
});

test('on win32, a .cmd/.bat wrapper needs the shell', { skip: !isWin }, () => {
  assert.equal(needsShellOnWin('codex.cmd'), true);
  assert.equal(needsShellOnWin('C:\\tools\\opencode.bat'), true);
  assert.deepEqual(winSpawnOptions('codex.cmd'), { shell: true, windowsHide: true });
});

test('on win32, a real .exe does NOT need the shell', { skip: !isWin }, () => {
  assert.equal(needsShellOnWin('node.exe'), false);
  assert.equal(needsShellOnWin('C:\\Program Files\\nodejs\\node.exe'), false);
  assert.deepEqual(winSpawnOptions('node.exe'), {});
});

test('a non-string / empty command never needs the shell', () => {
  assert.equal(needsShellOnWin(''), false);
  assert.equal(needsShellOnWin(undefined), false);
  assert.equal(needsShellOnWin(null), false);
  assert.deepEqual(winSpawnOptions(''), {});
});
