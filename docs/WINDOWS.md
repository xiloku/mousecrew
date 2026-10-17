# Running mousecrew on Windows

mousecrew runs on Windows (win32). A few things behave differently from POSIX;
this page covers the ones you need to know.

## Private files are protected with NTFS ACLs, not POSIX mode

On POSIX, mousecrew keeps secrets and message bodies owner-only with mode `0600`
(`0700` for directories). Windows/NTFS does not carry those POSIX bits —
`fs.statSync().mode` reports roughly `0o666` no matter how the file is locked —
so the mode check is meaningless there.

Instead, on win32 mousecrew enforces owner-only access through the file's **ACL**,
using `icacls` (see `src/lib/win-acl.js`):

- Reading a token file: `assertOwnerOnlyAccess()` refuses unless the only
  principals on the ACL are the current user, `SYSTEM`, `Administrators`, the
  current logon session, and the owner. It **fails closed** — anything it cannot
  run, parse, or recognise is treated as "shared" and rejected.
- Writing a private file: `tightenAcl()` is the equivalent of `chmod 600` —
  `icacls <file> /inheritance:r /grant:r <user>:F` (drop inheritance, grant the
  current user only). This is applied per **file** (token file, session record,
  sidecar state, long-message body files), never to a shared data directory —
  stripping inheritance on a directory would revoke our own access to its
  sibling files.

To lock a token file down by hand:

```
icacls "C:\path\to\auth.json" /inheritance:r /grant:r "%USERNAME%:F"
```

Or let the helper script do all of it — generate a random token, write
`{"token": "..."}`, and apply exactly that `icacls` lock to the **file** (never
the directory):

```
pwsh -File scripts/win/new-token.ps1
# or an explicit path, overwriting any existing file:
pwsh -File scripts/win/new-token.ps1 -Path C:\path\to\auth.json -Force
```

It writes to `%USERPROFILE%\.config\mousecrew\auth.json` by default, creates the
parent directory if missing (without touching its ACL), and runs on both Windows
PowerShell 5.1 and PowerShell 7+. After it runs, `assertOwnerOnlyAccess()` accepts
the file and the server reads the token without failing closed.

## local / exec runners can launch a `.cmd` or `.bat`

Most globally-installed CLIs on Windows (claude, kiro-cli, codex, opencode, ...)
are not `.exe` files but `.cmd`/`.bat` shims that npm/pip drop on `PATH`. Node's
`child_process.spawn('kiro-cli', ...)` will not run those without a shell and
throws `ENOENT`.

So on win32, for `local` and `exec` crew members, mousecrew spawns through the
shell when the configured command is a bare name or a `.cmd`/`.bat`
(`src/lib/win-spawn.js`). The message body is passed over **stdin**, never on the
command line, so going through `cmd.exe` does not expose it to shell parsing.

### Argument quoting on the shell path

When the shell is engaged, Node builds the command line as
`command + ' ' + args.join(' ')` and hands it to `cmd.exe` **without quoting the
args**. An argument that contains spaces or cmd metacharacters would then be split
or re-interpreted — e.g. `--append-system-prompt-file C:\Users\Jo Smith\sys.md`
arrives at the CLI as two broken arguments.

mousecrew fixes this with `winSpawnArgs()` (`src/lib/win-spawn.js`), which quotes
each argument for `cmd.exe` **only on the win32 shell path**: it wraps a token that
holds whitespace / a quote / a metacharacter in double quotes, escapes embedded
quotes and trailing backslashes for the child's argv parser, and caret-escapes cmd
metacharacters (`& | < > ( ) ^ % !`) so they survive the extra `cmd.exe` parse a
`.cmd`/`.bat` shim adds. Off win32, or for a direct `.exe` (shell not engaged), it
returns the arguments unchanged, so the POSIX code path is byte-identical.

## Killing a turn kills the whole process tree

When a `.cmd`/`.bat` CLI is launched through the shell, the spawned process is a
`cmd.exe` wrapper and the real CLI is its **child**. A plain `proc.kill()` reaps
only the wrapper and leaves the CLI (and anything it spawned) running — an orphaned
turn process.

So on win32, every teardown path — graceful `stop()`, the wedged-process
`_killAndRestart()`, and the `exec` runner's turn-timeout — goes through
`killProcessTree()` (`src/lib/win-spawn.js`), which runs
`taskkill /PID <pid> /T /F` to take down the whole tree (`/T` = tree, `/F` =
force). On POSIX `killProcessTree()` is exactly `proc.kill(signal)` — same call,
same signal, nothing added — so POSIX teardown is byte-identical. If `taskkill`
cannot be launched, it falls back to `proc.kill()` so a kill still happens.

## A remote worker's `--cli` must be a real `.exe` on Windows

The remote worker (`bin/mousecrew-worker.js`) passes the prompt as a command-line
argument (`-p <text>`), not over stdin. If that command were launched through
`cmd.exe`, the remotely-supplied prompt text would be exposed to shell
metacharacter parsing — a command-injection / argument-mangling risk.

For that reason mousecrew does **not** silently wrap the worker CLI in a shell.
On Windows, point the worker's `--cli` at a real `.exe` (or an operator-provided
wrapper you trust), not at a `.cmd`/`.bat` shim.

## Known limitations

These are accepted, documented edge cases of the NTFS-ACL enforcement — all of
them fail **safe** (refuse / err on the side of locked-down), never open.

- **Localized `icacls` output.** `assertOwnerOnlyAccess()` parses `icacls`
  output, which is localized on non-English Windows. The parser keys off the
  structural `principal:(flags)` form and ignores the trailing "Successfully
  processed" summary line (which has no `:(`), so localization does not change the
  principal list it reads. A translated summary line is simply skipped. If a future
  Windows build localized the ACE form itself, the parser would fail to recognise a
  principal and the file would be **rejected (fail closed)**, not wrongly accepted.
- **AzureAD / work-or-school account names.** `assertOwnerOnlyAccess()` compares
  the current user (`os.userInfo().username`, a bare login name) against the bare
  account name `icacls` prints. For an AzureAD/Entra account `icacls` may print a
  form (e.g. `AzureAD\Given Name`) that does not match the bare login name, in
  which case a token file that is in fact owner-only is treated as "shared" and
  **rejected (fail closed)** — the server will not start on it. The safe
  workaround is to grant the exact principal `icacls` reports (or use a local
  account for the service identity). This errs toward refusing a legitimate file
  rather than accepting a shared one.
