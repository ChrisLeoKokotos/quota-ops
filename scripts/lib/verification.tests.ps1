# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# Fixture harness for the verification primitives. Prints one line per case
# and exits non-zero on any mismatch, so a Node test can assert on it.
#
# These exist because the checks they cover previously turned missing or
# failed work into reported success. ASCII only.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "verification.ps1")

$failures = 0

function Expect([string]$Name, [string]$Expected, [string]$Actual, [string]$Detail = "") {
  if ($Expected -eq $Actual) {
    Write-Output ("ok   {0} -> {1}" -f $Name, $Actual)
  } else {
    $script:failures++
    Write-Output ("FAIL {0} -> expected {1}, got {2} ({3})" -f $Name, $Expected, $Actual, $Detail)
  }
}

$good = "# tests 146`n# pass 145`n# fail 0`n# skipped 1"

# --- Read-TestSummary --------------------------------------------------------

$r = Read-TestSummary -Output $good -ExitCode 0
Expect "clean run" "PASS" $r.status $r.detail

# The original defect: a summary saying zero failures while the runner died.
$r = Read-TestSummary -Output $good -ExitCode 1
Expect "clean summary but nonzero exit" "FAIL" $r.status $r.detail

# A crash before any summary must not read as success.
$r = Read-TestSummary -Output "starting tests..." -ExitCode 0
Expect "no summary, exit 0" "FAIL" $r.status $r.detail

$r = Read-TestSummary -Output "" -ExitCode 0
Expect "empty output" "FAIL" $r.status $r.detail

$r = Read-TestSummary -Output $null -ExitCode 0
Expect "null output" "FAIL" $r.status $r.detail

# A run that executed nothing proves nothing.
$r = Read-TestSummary -Output "# tests 0`n# pass 0`n# fail 0" -ExitCode 0
Expect "zero tests executed" "FAIL" $r.status $r.detail

# Truncation: the phrase appears but the summary is incomplete.
$r = Read-TestSummary -Output "# fail 0" -ExitCode 0
Expect "truncated to the fail line only" "FAIL" $r.status $r.detail

$r = Read-TestSummary -Output "# tests 10`n# pass 8`n# fail 2" -ExitCode 1
Expect "real failures" "FAIL" $r.status $r.detail

# The phrase embedded in prose must not be mistaken for a summary line.
$r = Read-TestSummary -Output "note: we want to see # fail 0 here" -ExitCode 0
Expect "phrase inside prose" "FAIL" $r.status $r.detail

$r = Read-TestSummary -Output $good -ExitCode $null
Expect "missing exit code" "FAIL" $r.status $r.detail

# --- Get-CollectorListenerState ---------------------------------------------

$loopback = @([pscustomobject]@{ LocalAddress = "127.0.0.1" })
$exposed = @([pscustomobject]@{ LocalAddress = "0.0.0.0" })

$r = Get-CollectorListenerState -Listeners $loopback
Expect "loopback listener" "PASS" $r.status $r.detail

$r = Get-CollectorListenerState -Listeners $exposed
Expect "non-loopback listener" "FAIL" $r.status $r.detail

$r = Get-CollectorListenerState -Listeners @($loopback[0], $exposed[0])
Expect "mixed listeners" "FAIL" $r.status $r.detail

# The original defect: absence recorded as a passing security assertion.
$r = Get-CollectorListenerState -Listeners @()
Expect "absent, optional" "SKIP" $r.status $r.detail

$r = Get-CollectorListenerState -Listeners @() -Required
Expect "absent, required" "FAIL" $r.status $r.detail

$r = Get-CollectorListenerState -Listeners $null
Expect "enumeration failed" "INCONCLUSIVE" $r.status $r.detail

# --- Invoke-Checked ----------------------------------------------------------

$r = Invoke-Checked { cmd.exe /c "exit 0" }
Expect "exit code 0 captured" "0" ([string]$r.exitCode)

$r = Invoke-Checked { cmd.exe /c "exit 3" }
Expect "exit code 3 captured" "3" ([string]$r.exitCode)

Write-Output ("summary: {0} failure(s)" -f $failures)
if ($failures -gt 0) { exit 1 }
exit 0
