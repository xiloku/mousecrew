<#
.SYNOPSIS
  Generate a mousecrew API token file on Windows and lock it owner-only with NTFS ACLs.

.DESCRIPTION
  The Windows counterpart of writing ~/.config/mousecrew/auth.json by hand and running
  `chmod 600` on it. On NTFS there are no POSIX mode bits, so mousecrew enforces
  owner-only access through the file's ACL (see src/lib/win-acl.js, docs/WINDOWS.md).
  This script:

    1. Generates a cryptographically-random token.
    2. Writes it as JSON  { "token": "<value>" }  to the token file (default
       $env:USERPROFILE\.config\mousecrew\auth.json), matching what readTokenFile() reads.
    3. Locks the FILE down with:  icacls <file> /inheritance:r /grant:r "<user>:F"
       — drop every inherited ACE, grant the current user Full control, nobody else. This
       is exactly what tightenAcl() does at runtime and what assertOwnerOnlyAccess() then
       accepts, so a server started afterwards reads the token without failing closed.

  It deliberately tightens ONLY the file, never the parent directory: stripping
  inheritance on a shared directory would revoke access to its sibling files (a known
  pitfall the runtime guards against the same way). The directory is created if missing
  but its ACL is left untouched.

.PARAMETER Path
  Where to write the token file. Default: $env:USERPROFILE\.config\mousecrew\auth.json.

.PARAMETER Bytes
  Number of random bytes behind the token (default 32 -> a 43-char base64url string).

.PARAMETER Force
  Overwrite an existing token file. Without it, an existing file is left untouched.

.EXAMPLE
  pwsh -File scripts/win/new-token.ps1

.EXAMPLE
  pwsh -File scripts/win/new-token.ps1 -Path C:\mc\auth.json -Force
#>
[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:USERPROFILE '.config\mousecrew\auth.json'),
  [int]$Bytes = 32,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if ($Bytes -lt 16) {
  throw "Refusing to generate a token from fewer than 16 random bytes (got $Bytes)."
}

if ((Test-Path -LiteralPath $Path) -and -not $Force) {
  throw "Token file already exists: $Path. Re-run with -Force to overwrite it."
}

# 1. Generate a cryptographically-random token, URL-safe (base64url, no padding).
#    RandomNumberGenerator.Create().GetBytes() works on both Windows PowerShell 5.1 and
#    PowerShell 7+ (unlike the static ::Fill(), which is .NET Core / PS7-only).
$raw = [byte[]]::new($Bytes)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($raw) } finally { $rng.Dispose() }
$token = [Convert]::ToBase64String($raw).TrimEnd('=').Replace('+', '-').Replace('/', '_')

# 2. Ensure the parent directory exists. We create it if missing but do NOT touch its ACL
#    — tightening a shared directory would strip the inheritance its sibling files rely on.
$dir = Split-Path -Parent $Path
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# 3. Write the token file as the JSON shape readTokenFile() expects: { "token": "..." }.
#    Write without a BOM so JSON.parse() on the Node side reads it cleanly.
$json = (@{ token = $token } | ConvertTo-Json -Compress)
[System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))

# 4. Lock the FILE owner-only via NTFS ACL — the Windows equivalent of chmod 600.
#    /inheritance:r  removes inherited ACEs (and copies none back), so no group/other ACE
#                    survives from the parent directory.
#    /grant:r <u>:F  replaces any ACE for the current user with Full control.
#    After this, win-acl.js assertOwnerOnlyAccess() sees only the current user (+ the
#    SYSTEM/Administrators/logon-session principals it treats as owner-equivalent).
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $Path /inheritance:r /grant:r "${user}:F" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "icacls failed to tighten the ACL on $Path (exit $LASTEXITCODE)."
}

Write-Host "Wrote owner-only token file: $Path"
Write-Host "Point mousecrew at it via the config 'tokenFile' field or the MOUSECREW_TOKEN env var."
