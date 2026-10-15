# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# QO-SEC-03 browser process detector.
#
# Chrome and Edge live in Program Files, so matching the executable path
# against "*quotaops*" never matches anything and always reports zero — which
# reads as "clean teardown" whether or not processes are still running. A
# QuotaOps-owned browser is identified instead by the profile it was launched
# with: Playwright's launchPersistentContext passes the profile directory as
# --user-data-dir, and every helper process Chrome spawns inherits it.
#
# Output is sanitized by design: counts and a status, never a command line and
# never a profile path. Access-denied inspection is reported as INCONCLUSIVE,
# not as zero.

[CmdletBinding()]
param(
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE ".quotaops\browser-profiles"),
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$browserNames = @("chrome.exe", "msedge.exe")
$matched = 0
$inspected = 0
$denied = 0
$debugFlagged = 0

# Normalise for comparison: command lines may quote the path or use either
# slash, and drive-letter casing varies.
$needle = $ProfileRoot.Trim().TrimEnd('\', '/').Replace('/', '\').ToLowerInvariant()

try {
  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter (
    ($browserNames | ForEach-Object { "Name = '$_'" }) -join " OR "
  ) -ErrorAction Stop)
} catch {
  $processes = @()
  $denied = 1
}

foreach ($process in $processes) {
  $commandLine = $null
  try {
    $commandLine = $process.CommandLine
  } catch {
    $denied += 1
    continue
  }

  if ([string]::IsNullOrEmpty($commandLine)) {
    # A browser we cannot inspect is not evidence of a clean teardown.
    $denied += 1
    continue
  }

  $inspected += 1
  $normalized = $commandLine.Replace('/', '\').ToLowerInvariant()
  if ($normalized.Contains("--user-data-dir=") -and $normalized.Contains($needle)) {
    $matched += 1
    # Inspect the launch configuration itself, not only the listening ports:
    # a debugging port outside the scanned range would otherwise go unseen.
    if ($normalized -match "--remote-debugging-(port|pipe)=") {
      $debugFlagged += 1
    }
  }
}

# Any listener in the usual DevTools range is reported as well, so a port
# opened by something this script did not attribute still surfaces.
$debugListeners = 0
try {
  $debugListeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalPort -ge 9222 -and $_.LocalPort -le 9322 }
  ).Count
} catch {
  $denied += 1
}

$status = if ($denied -gt 0) { "INCONCLUSIVE" } elseif ($matched -gt 0) { "RUNNING" } else { "CLEAN" }

$result = [pscustomobject]@{
  status              = $status
  quotaOpsProcesses   = $matched
  browsersInspected   = $inspected
  browsersNotInspected = $denied
  remoteDebuggingArgs = $debugFlagged
  debugRangeListeners = $debugListeners
}

if ($Json) {
  $result | ConvertTo-Json -Compress
} else {
  Write-Output ("Status: {0}" -f $result.status)
  Write-Output ("QuotaOps browser processes: {0}" -f $result.quotaOpsProcesses)
  Write-Output ("Browser processes inspected: {0}" -f $result.browsersInspected)
  Write-Output ("Browser processes not inspectable: {0}" -f $result.browsersNotInspected)
  Write-Output ("QuotaOps browsers launched with a debugging port: {0}" -f $result.remoteDebuggingArgs)
  Write-Output ("Listeners on ports 9222-9322: {0}" -f $result.debugRangeListeners)
  if ($denied -gt 0) {
    Write-Output "Some browser processes could not be inspected. Treat this run as INCONCLUSIVE, not as a pass."
  }
}

# 0 clean, 1 QuotaOps browsers still running, 2 inconclusive,
# 3 a QuotaOps browser was launched with remote debugging enabled.
if ($debugFlagged -gt 0) { exit 3 }
if ($status -eq "INCONCLUSIVE") { exit 2 }
if ($status -eq "RUNNING") { exit 1 }
exit 0
