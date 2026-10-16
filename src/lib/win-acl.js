// win-acl.js — the Windows half of "the token file must be owner-only".
//
// On POSIX the one-line check `st.mode & 0o077` says the whole thing: if any group/other
// bit is set, the secret is already shared, so refuse. Windows NTFS does not carry those
// bits — `fs.statSync().mode` reports 0o666 for almost everything regardless of the real
// ACL — so the POSIX check is both meaningless and, worse, always-true, which would make
// mousecrew refuse to start on Windows even with a perfectly locked-down file.
//
// The equivalent fact on Windows lives in the ACL, which we read with `icacls`. The two
// public functions keep the same contract the POSIX path has:
//
//   assertOwnerOnlyAccess(file)  — fail CLOSED. Throw unless the ONLY principals that can
//                                  reach the file are the current user, SYSTEM, the local
//                                  Administrators group, and OWNER RIGHTS. Anything we
//                                  cannot run, parse, or recognise is treated as "wider
//                                  than owner-only" and rejected — the same bias the
//                                  POSIX check has (unknown => refuse).
//   tightenAcl(file)             — the create-time counterpart of `chmod 600`: drop
//                                  inheritance and grant full control to the current user
//                                  only. After this, assertOwnerOnlyAccess() passes.
//
// Neither function does anything off win32; callers branch on process.platform.

const { execFileSync } = require('child_process');
const os = require('os');

// Principals that are allowed to appear in the ACL without the file being "shared".
// Matched case-insensitively against the account name AFTER the domain/machine prefix is
// stripped (icacls prints e.g. "BUILTIN\\Administrators", "NT AUTHORITY\\SYSTEM",
// "MACHINE\\user", "CREATOR OWNER"). The current user is added at call time.
const ALWAYS_ALLOWED = new Set([
  'SYSTEM',                 // NT AUTHORITY\SYSTEM — the service account; expected.
  'ADMINISTRATORS',         // BUILTIN\Administrators — a local admin can read anything anyway.
  'OWNER RIGHTS',           // the OWNER RIGHTS SID; the owner, by definition.
  'CREATOR OWNER',          // inheritance template entry, materialises to the owner.
]);

/** Everything after the last backslash, upper-cased. "BUILTIN\\Administrators" -> "ADMINISTRATORS". */
function bareAccount(principal) {
  const s = String(principal).trim();
  const idx = s.lastIndexOf('\\');
  return (idx >= 0 ? s.slice(idx + 1) : s).toUpperCase();
}

/** The current user's bare account name, upper-cased. */
function currentUser() {
  // os.userInfo().username is the login name without domain, which is what we compare to.
  try {
    const u = os.userInfo().username;
    if (u) return bareAccount(u);
  } catch { /* fall through */ }
  const env = process.env.USERNAME || process.env.USER || '';
  return bareAccount(env);
}

/**
 * Parse `icacls <file>` output into the list of principals that hold an ACE.
 * icacls prints the path on the first line, then one principal per line as
 * "  DOMAIN\\name:(FLAGS)(perms)", then a trailing "Successfully processed" summary.
 * Returns an array of raw principal strings (before bareAccount()).
 */
function parseIcaclsPrincipals(stdout, file) {
  const lines = String(stdout).split(/\r?\n/);
  const principals = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/successfully processed|processed \d+ files/i.test(line)) continue;
    // The first content line usually repeats the file path, often with the first ACE
    // appended after it: "C:\path\auth.json user:(F)". Strip a leading path token.
    let work = line;
    // Drop a leading copy of the file path if present.
    if (work.includes(file)) work = work.slice(work.indexOf(file) + file.length);
    // Each ACE is "principal:(...)". A line can hold the path then an ACE.
    // Split on the first ":(" to get the principal; a line with no ":(" is noise.
    const m = work.match(/^\s*(.+?):\([^)]*\)/);
    if (m) {
      principals.push(m[1].trim());
    }
  }
  return principals;
}

/**
 * Fail closed unless the file's ACL grants access only to owner-equivalent principals.
 * Throws on win32 when a disallowed principal (Everyone, Users, Authenticated Users, ...)
 * is present, or when icacls cannot be run or its output cannot be parsed.
 * No-op (returns) off win32.
 */
function assertOwnerOnlyAccess(file) {
  if (process.platform !== 'win32') return;

  let stdout;
  try {
    stdout = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    // Cannot determine the ACL -> cannot prove it is safe -> refuse.
    throw new Error(`${file}: cannot read ACL via icacls (${e.message}) — refusing (fail closed)`);
  }

  const principals = parseIcaclsPrincipals(stdout, file);
  if (principals.length === 0) {
    throw new Error(`${file}: could not parse any ACL entries from icacls — refusing (fail closed)`);
  }

  const me = currentUser();
  const offenders = [];
  for (const p of principals) {
    const bare = bareAccount(p);
    if (bare === me) continue;
    if (ALWAYS_ALLOWED.has(bare)) continue;
    // The per-logon SID "NT AUTHORITY\LogonSessionId_<auth>_<id>" is the current interactive
    // logon session itself — Windows stamps it onto freshly created files, and it survives
    // even an explicit `icacls /inheritance:r /grant:r <user>:F`. It is scoped to this one
    // logon (not a shared group like Users/Everyone), so it is owner-equivalent and must not
    // count as "shared". Without this, a correctly locked-down token file would be rejected
    // and readTokenFile would fail closed — exactly the Windows-won't-start bug this guards.
    if (/^LOGONSESSIONID_\d+_\d+$/.test(bare)) continue;
    offenders.push(p);
  }
  if (offenders.length) {
    throw new Error(
      `${file} is accessible to ${offenders.join(', ')} (want current user only) — ` +
      `run: icacls "${file}" /inheritance:r /grant:r "%USERNAME%:F"`,
    );
  }
}

/**
 * Create-time hardening: strip inherited ACEs and grant full control to the current user
 * only. The Windows equivalent of `chmod 600`. Throws on failure (so a caller that means
 * to lock the file down learns it did not). No-op off win32.
 */
function tightenAcl(file) {
  if (process.platform !== 'win32') return;
  const me = os.userInfo().username; // login name; icacls resolves it on the local machine
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${me}:F`], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (e) {
    throw new Error(`${file}: could not tighten ACL via icacls (${e.message})`);
  }
}

module.exports = {
  assertOwnerOnlyAccess,
  tightenAcl,
  // exported for unit testing of the parser without touching the filesystem
  _parseIcaclsPrincipals: parseIcaclsPrincipals,
  _bareAccount: bareAccount,
  _currentUser: currentUser,
};
