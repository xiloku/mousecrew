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
//
// Quoting (win32 shell path only): when shell:true is on, Node builds the command line as
// `command + ' ' + args.join(' ')` and hands it to cmd.exe WITHOUT quoting the args. An
// arg like `--append-system-prompt-file C:\Users\Jo Smith\sys.md` then splits at the
// space and the CLI sees two broken args. winSpawnArgs() fixes this by quoting each arg
// for cmd.exe when (and only when) the shell is engaged; off win32 / direct-exec it
// returns the args array UNCHANGED, so the POSIX code path is byte-identical.

const path = require('path');

// Extensions that are directly executable by CreateProcess without a shell.
const DIRECT_EXT = new Set(['.exe', '.com']);

// cmd.exe metacharacters. A token holding any of these (or whitespace, or a quote) is
// double-quoted AND has each metacharacter caret-escaped inside the quotes. Both layers
// are needed because a .cmd/.bat shim runs the line through TWO cmd parses (Node spawns
// `cmd /d /s /c "<cmd> <args>"`, and the batch file is itself a cmd context): the quotes
// carry spaces across the argv split, and the caret carries the metacharacter through the
// outer cmd parse so the inner `%~1` de-quote yields the literal character. This exact
// combination is verified by the round-trip test (a spaced path AND `a&b` both survive).
const CMD_META = /[()%!^"<>&|]/;
const CMD_META_G = /[()%!^<>&|]/g;

/**
 * Quote a single argument so cmd.exe passes it to the child as one literal token, even
 * when it contains spaces, quotes, or cmd metacharacters.
 *
 * A plain token (no whitespace, quote, or metacharacter) is returned unchanged, so a
 * normal flag like `--append-system-prompt-file` is untouched. Otherwise:
 *   1. argv layer — the child's CommandLineToArgvW parser strips the wrapping quotes: an
 *      embedded `"` must arrive as `\"`, and a run of backslashes right before a `"` is
 *      doubled.
 *   2. cmd layer — caret-escape each metacharacter so the outer cmd parse does not act on
 *      it, then wrap the whole thing in double quotes for the spaces.
 * @param {string} arg
 * @returns {string}
 */
function quoteArgForCmd(arg) {
  const s = String(arg);
  const needsQuote = s === '' || /\s/.test(s) || CMD_META.test(s);
  if (!needsQuote) return s;
  const body = s
    .replace(/(\\*)"/g, '$1$1\\"')      // argv: double backslashes before a quote, escape it
    .replace(/(\\*)$/, '$1$1')          // argv: double trailing backslashes before closing "
    .replace(CMD_META_G, '^$&');        // cmd: caret-escape metacharacters inside the quotes
  return `"${body}"`;
}

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

/**
 * The args array to actually hand to spawn(), given the same command winSpawnOptions()
 * is called with. When the shell is engaged on win32 (bare name / .cmd / .bat), each arg
 * is quoted for cmd.exe so spaces and metacharacters survive. Otherwise — off win32, or
 * a direct .exe where shell:false — the array is returned UNCHANGED (a new array with the
 * same elements), so no quoting ever reaches the byte-identical POSIX path.
 * @param {string} command
 * @param {string[]} args
 * @returns {string[]}
 */
function winSpawnArgs(command, args) {
  const list = Array.isArray(args) ? args : [];
  if (!needsShellOnWin(command)) return list.slice();
  return list.map(quoteArgForCmd);
}

module.exports = { winSpawnOptions, winSpawnArgs, needsShellOnWin, quoteArgForCmd };
