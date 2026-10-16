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

## local / exec runners can launch a `.cmd` or `.bat`

Most globally-installed CLIs on Windows (claude, kiro-cli, codex, opencode, ...)
are not `.exe` files but `.cmd`/`.bat` shims that npm/pip drop on `PATH`. Node's
`child_process.spawn('kiro-cli', ...)` will not run those without a shell and
throws `ENOENT`.

So on win32, for `local` and `exec` crew members, mousecrew spawns through the
shell when the configured command is a bare name or a `.cmd`/`.bat`
(`src/lib/win-spawn.js`). The message body is passed over **stdin**, never on the
command line, so going through `cmd.exe` does not expose it to shell parsing.

## A remote worker's `--cli` must be a real `.exe` on Windows

The remote worker (`bin/mousecrew-worker.js`) passes the prompt as a command-line
argument (`-p <text>`), not over stdin. If that command were launched through
`cmd.exe`, the remotely-supplied prompt text would be exposed to shell
metacharacter parsing — a command-injection / argument-mangling risk.

For that reason mousecrew does **not** silently wrap the worker CLI in a shell.
On Windows, point the worker's `--cli` at a real `.exe` (or an operator-provided
wrapper you trust), not at a `.cmd`/`.bat` shim.
