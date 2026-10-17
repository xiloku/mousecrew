const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  winSpawnOptions, winSpawnArgs, needsShellOnWin, quoteArgForCmd,
} = require('../src/lib/win-spawn');

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

// ---- item 2: argument quoting for the win32 shell path ----

test('quoteArgForCmd leaves a plain token bare and quotes one with spaces', () => {
  // Pure function, platform-independent: a token with no space/quote/metachar is passed
  // bare so a normal flag is unchanged; a path with spaces is wrapped so cmd.exe keeps it
  // as one arg and the child's argv parser strips the quotes back off.
  assert.equal(quoteArgForCmd('--append-system-prompt-file'), '--append-system-prompt-file');
  assert.equal(quoteArgForCmd('plain'), 'plain');
  assert.equal(quoteArgForCmd('C:\\Users\\Jo Smith\\sys.md'), '"C:\\Users\\Jo Smith\\sys.md"');
  assert.equal(quoteArgForCmd(''), '""');
});

test('quoteArgForCmd wraps a metacharacter in quotes and caret-escapes it inside', () => {
  // Verified against a real cmd round-trip: quote for spaces/argv AND caret-escape the
  // metacharacter so it survives the outer cmd parse that a .cmd shim adds.
  assert.equal(quoteArgForCmd('a&b'), '"a^&b"');
  assert.equal(quoteArgForCmd('x|y'), '"x^|y"');
  assert.equal(quoteArgForCmd('a & b'), '"a ^& b"');
  assert.equal(quoteArgForCmd('50%done'), '"50^%done"');
  // An embedded quote becomes \" (argv layer); the quote itself is not caret-escaped.
  assert.equal(quoteArgForCmd('say "hi"'), '"say \\"hi\\""');
  // Trailing backslashes (right before the closing quote) are doubled so they do not
  // escape it: `a b\` -> `"a b\\"`.
  assert.equal(quoteArgForCmd('a b\\'), '"a b\\\\"');
});

test('off win32, winSpawnArgs returns the args byte-identical (no quoting on the POSIX path)', { skip: isWin }, () => {
  const args = ['--append-system-prompt-file', '/home/jo smith/sys.md', 'a&b'];
  const out = winSpawnArgs('claude', args);
  assert.deepEqual(out, args);      // unchanged values
  assert.notEqual(out, args);       // but a fresh array, never the caller's
});

test('on win32, winSpawnArgs quotes for the shell path but leaves a direct .exe untouched', { skip: !isWin }, () => {
  const args = ['--append-system-prompt-file', 'C:\\Users\\Jo Smith\\sys.md'];
  // Bare name / .cmd -> shell is engaged -> quote.
  assert.deepEqual(winSpawnArgs('kiro-cli', args), [
    '--append-system-prompt-file', '"C:\\Users\\Jo Smith\\sys.md"',
  ]);
  // Direct .exe -> shell:false -> args unchanged.
  assert.deepEqual(winSpawnArgs('node.exe', args), args);
});

test('on win32, a spaced arg survives cmd.exe round-trip through the shell path', { skip: !isWin }, () => {
  // The real end-to-end check: a .cmd shim (needs the shell) is handed an arg with spaces
  // and a metacharacter; with winSpawnArgs quoting it, the child must see it as ONE arg.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-winspawn-'));
  try {
    // echoargs.cmd prints each received arg on its own line as [n]=<value>.
    const shim = path.join(dir, 'echoargs.cmd');
    fs.writeFileSync(shim,
      '@echo off\r\n' +
      ':loop\r\n' +
      'if "%~1"=="" goto end\r\n' +
      'echo [arg]=%~1\r\n' +
      'shift\r\n' +
      'goto loop\r\n' +
      ':end\r\n');
    const spaced = 'C:\\Users\\Jo Smith\\sys.md';
    const args = ['--append-system-prompt-file', spaced, 'a&b'];
    const res = spawnSync(shim, winSpawnArgs(shim, args), {
      ...winSpawnOptions(shim), encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const got = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('[arg]='))
      .map((l) => l.slice('[arg]='.length));
    assert.deepEqual(got, ['--append-system-prompt-file', spaced, 'a&b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
