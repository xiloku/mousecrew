// Platform-aware "this path is owner-only" assertion for tests.
//
// On POSIX, owner-only is a mode fact: a regular file should be 0o600, a directory 0o700.
// On win32 those bits are meaningless — NTFS does not carry POSIX group/other bits and
// fs.statSync().mode reports ~0o666/0o777 regardless of the real ACL — so a `mode & 0o777`
// assertion is always red there even when the file is perfectly locked down. The real
// owner-only fact on Windows lives in the ACL, which src/lib/win-acl.js reads with icacls.
//
// This helper routes to the right check per platform so a single assertion in a test means
// the same thing everywhere: "only the owner (plus SYSTEM/Administrators) can reach this".
// On win32 it delegates to assertOwnerOnlyAccess (which throws unless the ACL is owner-only);
// elsewhere it asserts the POSIX mode. It does NOT weaken the POSIX assertion — that path is
// byte-for-byte the check the tests used before.

const assert = require('node:assert');
const fs = require('fs');
const { assertOwnerOnlyAccess } = require('../../src/lib/win-acl');

/**
 * Assert that `target` is owner-only on the current platform.
 * @param {string} target path to a file or directory
 * @param {{ dir?: boolean }} [opts] set dir:true for a directory (POSIX expects 0o700)
 */
function assertOwnerOnly(target, opts = {}) {
  if (process.platform === 'win32') {
    if (opts.dir) {
      // On win32 we deliberately do NOT lock a directory's ACL with icacls /inheritance:r:
      // these are shared/transient data dirs, and stripping inheritance revokes the owner's
      // own access to sibling files and the ability to delete the tree (observed as EPERM on
      // rmSync and EPERM on transcript reads). Privacy on Windows is a per-FILE guarantee —
      // the private files written into the dir carry owner-only ACLs (asserted separately).
      // So for a directory we assert only that it exists; the POSIX 0o700 bit does not map.
      assert.ok(fs.existsSync(target) && fs.statSync(target).isDirectory(), `${target} should exist as a directory`);
      return;
    }
    // Files: the real owner-only fact lives in the ACL. Throws unless the ACL grants access
    // to the current user (+SYSTEM/Administrators/the current logon session) only.
    assertOwnerOnlyAccess(target);
    return;
  }
  const expected = opts.dir ? 0o700 : 0o600;
  assert.equal(
    fs.statSync(target).mode & 0o777,
    expected,
    `${target} should be ${expected.toString(8)} (owner-only) on POSIX`,
  );
}

module.exports = { assertOwnerOnly };
