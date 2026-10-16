const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  assertOwnerOnlyAccess, tightenAcl,
  _parseIcaclsPrincipals, _bareAccount,
} = require('../src/lib/win-acl');

const isWin = process.platform === 'win32';

// The icacls output parser is pure string work, so it runs on every platform. These lock
// in the shape of real icacls output and the "strip the DOMAIN\\ prefix" rule the
// allow-list depends on.
test('_bareAccount strips the domain/machine prefix and upper-cases', () => {
  assert.equal(_bareAccount('BUILTIN\\Administrators'), 'ADMINISTRATORS');
  assert.equal(_bareAccount('NT AUTHORITY\\SYSTEM'), 'SYSTEM');
  assert.equal(_bareAccount('DESKTOP-ABC\\Admin'), 'ADMIN');
  assert.equal(_bareAccount('Everyone'), 'EVERYONE');
});

test('_parseIcaclsPrincipals reads the principals out of real icacls output', () => {
  const file = 'C:\\Users\\Admin\\.config\\mousecrew\\auth.json';
  const stdout = [
    `${file} DESKTOP-ABC\\Admin:(F)`,
    '                           NT AUTHORITY\\SYSTEM:(F)',
    '                           BUILTIN\\Administrators:(F)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  const principals = _parseIcaclsPrincipals(stdout, file).map(_bareAccount);
  assert.deepEqual(principals.sort(), ['ADMIN', 'ADMINISTRATORS', 'SYSTEM']);
});

test('_parseIcaclsPrincipals catches a wide grant (Users)', () => {
  const file = 'C:\\tmp\\auth.json';
  const stdout = [
    `${file} DESKTOP-ABC\\Admin:(F)`,
    '              BUILTIN\\Users:(RX)',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  const principals = _parseIcaclsPrincipals(stdout, file).map(_bareAccount);
  assert.ok(principals.includes('USERS'), 'Users ACE must be seen so it can be rejected');
});

// The live behaviour needs a real NTFS ACL, so these only run on Windows. They cover the
// two cases the brief requires: a correctly-locked file passes, a world/Users-readable
// file is rejected (fail closed).
test('win32: an owner-only token file passes assertOwnerOnlyAccess', { skip: !isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-acl-ok-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'abc' }));
  tightenAcl(file);
  assert.doesNotThrow(() => assertOwnerOnlyAccess(file));
});

test('win32: a Users-readable token file is rejected — fail CLOSED', { skip: !isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-acl-wide-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'abc' }));
  tightenAcl(file);
  // Open it up to the local Users group (SID S-1-5-32-545) — the Windows analogue of
  // chmod 0644 / "everyone can read".
  execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R'], { windowsHide: true });
  assert.throws(() => assertOwnerOnlyAccess(file), /accessible to/);
});

test('win32: Everyone-readable token file is rejected — fail CLOSED', { skip: !isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-acl-everyone-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'abc' }));
  tightenAcl(file);
  // Everyone = SID S-1-1-0.
  execFileSync('icacls', [file, '/grant', '*S-1-1-0:R'], { windowsHide: true });
  assert.throws(() => assertOwnerOnlyAccess(file), /accessible to/);
});

// Non-Windows: both functions are no-ops and never throw.
test('off win32 the ACL check is a no-op', { skip: isWin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mousecrew-acl-posix-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'abc' }), { mode: 0o644 });
  assert.doesNotThrow(() => assertOwnerOnlyAccess(file));
  assert.doesNotThrow(() => tightenAcl(file));
});
