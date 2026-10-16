// win-spawn.js — let child_process.spawn find a CLI that is a .cmd/.bat wrapper on Windows.
//
// The problem: on Windows almost every globally-installed CLI (claude, kiro-cli, codex,
// opencode, ...) is not an .exe but a .cmd shim that npm/pip/etc. drop on PATH. Node's
// child_process.spawn does NOT run those without a shell — spawn('kiro-cli', args) throws
// ENOENT, so no `local`/`exec` crew member can start and the remote worker cannot run a
// turn. (On POSIX there is no such thing; spawn finds the file on PATH directly.)
//
// The fix: when the command is a bare name or a .cmd/.bat on win32, spawn through the
// shell so cmd.exe resolves it via PATHEXT. We do NOT turn on the shell for a command that
// already names a real executable (has a path separator or an .exe/.com extension), to
// keep the surface small. Off win32 this is always a no-op: {} is returned.
//
// Scope note on injection: the command and args come from the operator's agents.json /
// server launch flags, not from a remote user or a chat message, so enabling the shell
// here does not widen a remote attack surface. The one caveat a shell adds is that an arg
// containing shell metacharacters would be re-interpreted; callers already pass fixed CLI
// flags and the message body goes over stdin (never argv) in the exec/local runners, so
// that caveat does not bite the paths that use this. Documented in docs/WINDOWS.md.

const path = require('path');

// Extensions that are directly executable by CreateProcess without a shell.
const DIRECT_EXT = new Set(['.exe', '.com']);

/**
 * Decide whether a given command needs the shell to be found on win32.
 * @param {string} command the executable name/path as configured
 * @returns {boolean}
 */
function needsShellOnWin(command) {
  if (process.platform !== 'win32') return false;
  if (typeof command !== 'string' || !command) return false;
  // An absolute/relative path to a real .exe does not need the shell.
  const ext = path.extname(command).toLowerCase();
  if (DIRECT_EXT.has(ext)) return false;
  // Bare name (kiro-cli), or an explicit .cmd/.bat, needs cmd.exe to resolve via PATHEXT.
  return true;
}

/**
 * Spawn options to merge in so a .cmd/.bat/bare-name command is found on win32.
 * Returns {} off win32 or when the command is already a direct executable.
 * @param {string} command
 * @returns {{shell?: boolean, windowsHide?: boolean}}
 */
function winSpawnOptions(command) {
  if (!needsShellOnWin(command)) return {};
  // shell:true routes through %ComSpec% (cmd.exe), which honours PATHEXT and runs .cmd
  // shims. windowsHide keeps a stray console window from flashing up for each turn.
  return { shell: true, windowsHide: true };
}

module.exports = { winSpawnOptions, needsShellOnWin };
