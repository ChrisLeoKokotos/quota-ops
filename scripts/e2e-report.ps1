# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# QO-SEC-03 sanitized evidence collector.
#
# Runs every assertion that does not need a human, and prints a report the
# owner can paste into a pull request without redacting anything. It collects
# counts, states and PASS/FAIL -- never a password, cookie, token, profile
# path, session file or raw ACL dump.
#
# The owner still performs the interactive provider login. This script covers
# everything around it.
#
#   powershell -NoProfile -File .\scripts\e2e-report.ps1
#   powershell -NoProfile -File .\scripts\e2e-report.ps1 -AccountId <test-id>

[CmdletBinding()]
param(
  [string]$AccountId,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "lib/verification.ps1")
$results = [System.Collections.ArrayList]::new()

function Record([string]$Id, [string]$Name, [string]$Status, [string]$Detail = "") {
  [void]$results.Add([pscustomobject]@{ id = $Id; name = $Name; status = $Status; detail = $Detail })
  $colour = switch ($Status) {
    "PASS" { "Green" }
    "FAIL" { "Red" }
    "SKIP" { "DarkGray" }
    "INCONCLUSIVE" { "Magenta" }
    default { "Yellow" }
  }
  Write-Host ("  {0,-8} {1,-46} {2}" -f $Status, $Name, $Detail) -ForegroundColor $colour
}

function Try-Step([string]$Id, [string]$Name, [scriptblock]$Body) {
  try {
    $detail = & $Body
    Record $Id $Name "PASS" ([string]$detail)
  } catch {
    # The message is ours, not the provider's: never echo a raw error that
    # might carry a URL, a path or a token fragment.
    Record $Id $Name "FAIL" $_.Exception.Message
  }
}

Write-Host ""
Write-Host "QuotaOps QO-SEC-03 sanitized evidence" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# --- environment -------------------------------------------------------------
Write-Host "`nEnvironment"
$commit = (& git -C $repo rev-parse HEAD).Trim()
$branch = (& git -C $repo rev-parse --abbrev-ref HEAD).Trim()
Record "env.commit" "Commit under test" "INFO" $commit
Record "env.branch" "Branch" "INFO" $branch
Record "env.os" "Windows version" "INFO" (Get-CimInstance Win32_OperatingSystem).Version
Record "env.node" "Node.js" "INFO" (& node --version).Trim()
Record "env.cores" "Logical cores" "INFO" ([string](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors)
Record "env.ram" "RAM (GB)" "INFO" ([string][math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1))

# --- automated suite ---------------------------------------------------------
Write-Host "`nAutomated checks"

Try-Step "auto.typecheck" "TypeScript typecheck" {
  Push-Location $repo
  try {
    $null = & npm run typecheck 2>&1
    if ($LASTEXITCODE -ne 0) { throw "typecheck reported errors" }
    "no diagnostics"
  } finally { Pop-Location }
}

# Not Try-Step: the result is a status, not a pass-or-throw.
Push-Location $repo
try {
  $run = Invoke-Checked { npm test }
  $summary = Read-TestSummary -Output $run.output -ExitCode $run.exitCode
  Record "auto.tests" "Unit and security test suite" $summary.status $summary.detail
} finally { Pop-Location }

Try-Step "auto.verification" "Verification primitives self-test" {
  Push-Location $repo
  try {
    $run = Invoke-Checked { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/lib/verification.tests.ps1 }
    if ($run.exitCode -ne 0) { throw "the verification harness reported failures" }
    $count = ([regex]::Matches($run.output, '(?m)^ok ')).Count
    if ($count -lt 1) { throw "the verification harness produced no results" }
    "$count case(s) verified"
  } finally { Pop-Location }
}

if (-not $SkipBuild) {
  Try-Step "auto.build" "Next.js production build" {
    Push-Location $repo
    try {
      $null = & npm run build 2>&1
      if ($LASTEXITCODE -ne 0) { throw "build failed" }
      "succeeded"
    } finally { Pop-Location }
  }

  Try-Step "auto.static" "Desktop static export" {
    Push-Location $repo
    try {
      $output = & node desktop/build-static.mjs 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { throw "static export failed" }
      $hashes = [regex]::Match($output, '(\d+) inline script hash').Groups[1].Value
      "exported, $hashes inline script hash(es)"
    } finally { Pop-Location }
  }

  Try-Step "auto.api-restored" "API routes restored after static build" {
    if (-not (Test-Path (Join-Path $repo "app\api"))) { throw "app/api is missing" }
    if (Test-Path (Join-Path $repo "app\_api_excluded_from_static_build")) {
      throw "the build left a parked copy behind"
    }
    "app/api intact, no parked copy"
  }
}

Try-Step "auto.audit" "Production dependency audit" {
  Push-Location $repo
  try {
    $output = & npm audit --omit=dev --audit-level=high 2>&1 | Out-String
    if ($output -notmatch "found 0 vulnerabilities") { throw "audit reported findings" }
    "0 vulnerabilities"
  } finally { Pop-Location }
}

# --- browser lifecycle -------------------------------------------------------
Write-Host "`nBrowser lifecycle (synthetic, no provider login)"

Try-Step "e2e06.detector" "Detector sees a browser, then reports zero" {
  Push-Location $repo
  try {
    $output = & node --experimental-strip-types scripts\windows-browser-lifecycle-check.ts 2>&1 | Out-String
    if ($output -notmatch "PASS") { throw "lifecycle check did not pass" }
    $seen = [regex]::Match($output, 'detector saw (\d+)').Groups[1].Value
    "saw $seen process(es) running, 0 after teardown"
  } finally { Pop-Location }
}

Try-Step "e2e06.orphans" "No QuotaOps browser processes right now" {
  Push-Location $repo
  try {
    $json = & powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-browser-processes.ps1 -Json 2>&1 | Out-String
    $parsed = $json | ConvertFrom-Json
    if ($parsed.status -eq "INCONCLUSIVE") {
      throw "inconclusive: $($parsed.browsersNotInspected) process(es) could not be inspected"
    }
    if ($parsed.quotaOpsProcesses -ne 0) { throw "$($parsed.quotaOpsProcesses) still running" }
    "0 running, 0 debug args, $($parsed.debugRangeListeners) debug-range listener(s)"
  } finally { Pop-Location }
}

# --- collector ---------------------------------------------------------------
Write-Host "`nCollector configuration"

Try-Step "e2e07.security-check" "Collector security check" {
  Push-Location $repo
  try {
    $output = & npm run collector:setup -- security-check 2>&1 | Out-String
    if ($output -notmatch "passed") { throw "security-check did not pass" }
    $count = [regex]::Match($output, 'for (\d+) configured').Groups[1].Value
    "$count profile(s) verified"
  } finally { Pop-Location }
}

Try-Step "e2e07.consent" "Token Analytics consent state" {
  Push-Location $repo
  try {
    $output = & npm run collector:setup -- tokens-auto status 2>&1 | Out-String
    $claude = if ($output -match 'Claude Code history: (\w+)') { $Matches[1] } else { "unknown" }
    $codex = if ($output -match 'Codex history: (\w+)') { $Matches[1] } else { "unknown" }
    "Claude Code: $claude, Codex: $codex"
  } finally { Pop-Location }
}

Try-Step "e2e07.acl" "QuotaOps home is not world-readable" {
  $quotaHome = Join-Path $env:USERPROFILE ".quotaops"
  if (-not (Test-Path $quotaHome)) { throw "QuotaOps home does not exist yet" }
  $acl = Get-Acl $quotaHome
  $broad = @($acl.Access | Where-Object {
      $_.IdentityReference -match 'Everyone|BUILTIN\\Users|Authenticated Users'
    })
  if ($broad.Count -gt 0) {
    throw "$($broad.Count) broad principal(s) present"
  }
  # Count only; never print the principals themselves.
  "no broad principals; $($acl.Access.Count) ACE(s) total"
}

# --- network boundary --------------------------------------------------------
Write-Host "`nNetwork boundary"

# Absence is not evidence of correct binding, so it is reported as SKIP
# rather than folded into a passing security assertion.
# Enumerate every listener and filter here. `Get-NetTCPConnection -LocalPort`
# throws when nothing matches, which would make "the collector is not
# running" indistinguishable from "the sockets could not be read" -- the
# first is a SKIP, the second an INCONCLUSIVE, and they are not the same
# claim.
$listeners = $null
try {
  $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
  $listeners = @($all | Where-Object { $_.LocalPort -eq 4317 })
} catch {
  $listeners = $null
}
$collectorState = Get-CollectorListenerState -Listeners $listeners
Record "net.collector-port" "Collector binds loopback only" $collectorState.status $collectorState.detail

Try-Step "net.debug-range" "No listeners in the DevTools port range" {
  $debug = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -ge 9222 -and $_.LocalPort -le 9322 })
  if ($debug.Count -gt 0) { throw "$($debug.Count) listener(s) present" }
  "none"
}

# --- manual steps ------------------------------------------------------------
Write-Host "`nSteps that need you (interactive provider login)"
foreach ($manual in @(
    @("E2E-01", "First login and collection"),
    @("E2E-02", "Session reuse without re-login"),
    @("E2E-03", "Session expiry reports login_required"),
    @("E2E-04", "Two accounts stay isolated"),
    @("E2E-05", "Offline and timeout reporting"),
    @("E2E-08", "Desktop shell shows account data"),
    @("E2E-09", "Repeated refresh cycles stay stable")
  )) {
  Record $manual[0] $manual[1] "MANUAL" "run it, then record PASS or FAIL"
}

# --- summary -----------------------------------------------------------------
$pass = @($results | Where-Object { $_.status -eq "PASS" }).Count
$fail = @($results | Where-Object { $_.status -eq "FAIL" }).Count
$skip = @($results | Where-Object { $_.status -eq "SKIP" }).Count
$unclear = @($results | Where-Object { $_.status -eq "INCONCLUSIVE" }).Count
$manualCount = @($results | Where-Object { $_.status -eq "MANUAL" }).Count

Write-Host ""
Write-Host ("Automated: {0} PASS, {1} FAIL, {2} SKIP, {3} INCONCLUSIVE. Manual outstanding: {4}." -f
  $pass, $fail, $skip, $unclear, $manualCount) -ForegroundColor Cyan
if ($unclear -gt 0) {
  Write-Host "An INCONCLUSIVE check verified nothing. Do not read it as a pass." -ForegroundColor Magenta
}

$reportPath = Join-Path $repo ("docs\validation\e2e-report-" + $commit.Substring(0, 7) + ".md")
New-Item -ItemType Directory -Force -Path (Split-Path $reportPath) | Out-Null

$lines = @(
  "# QO-SEC-03 evidence -- $($commit.Substring(0,7))",
  "",
  "Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Automated results only;",
  "the manual rows need an interactive provider login.",
  "",
  "| ID | Check | Status | Detail |",
  "|---|---|---|---|"
)
foreach ($row in $results) {
  $lines += "| ``$($row.id)`` | $($row.name) | **$($row.status)** | $($row.detail) |"
}
$lines += ""
$lines += "Automated: $pass PASS, $fail FAIL, $skip SKIP, $unclear INCONCLUSIVE. Manual outstanding: $manualCount."
$lines += ""
$lines += "SKIP means the precondition was absent, INCONCLUSIVE means the check"
$lines += "could not run. Neither is evidence of correct behaviour."
$lines += ""
$lines += "This file contains counts and states only -- no credentials, tokens,"
$lines += "cookies, profile paths, session files or raw ACL contents. It is safe"
$lines += "to attach to a pull request as written."

Set-Content -Path $reportPath -Value $lines -Encoding utf8
Write-Host ("Report written to {0}" -f $reportPath)

if ($fail -gt 0) { exit 1 }
if ($unclear -gt 0) { exit 2 }
exit 0
