# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# Verification primitives for the evidence collector, kept separate so they can
# be driven with synthetic inputs rather than trusted by inspection.
#
# Every function returns a status from the set PASS / FAIL / SKIP /
# INCONCLUSIVE, never a bare boolean, because the three non-PASS outcomes mean
# genuinely different things and collapsing them is how a missing check turns
# into reported success.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a
# non-ASCII byte here breaks parsing outright.

Set-StrictMode -Version Latest

<#
.SYNOPSIS
Decides whether a test run genuinely succeeded.

.DESCRIPTION
An earlier version matched "# fail 0" in the output and nothing else. That
accepts a runner which crashed after printing a summary, a run that executed
no tests at all, and truncated output that happens to contain the phrase. The
exit code, the presence of a complete summary, and a positive test count are
all required now, and any of them missing is a FAIL rather than a PASS.
#>
function Read-TestSummary {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$Output,
    [Parameter(Mandatory = $true)][AllowNull()]$ExitCode
  )

  if ($null -eq $ExitCode) {
    return [pscustomobject]@{ status = "FAIL"; detail = "the test runner reported no exit code"; tests = 0; pass = 0; fail = 0 }
  }

  $text = if ($null -eq $Output) { "" } else { $Output }

  $testsMatch = [regex]::Match($text, '(?m)^#\s*tests\s+(\d+)\s*$')
  $passMatch = [regex]::Match($text, '(?m)^#\s*pass\s+(\d+)\s*$')
  $failMatch = [regex]::Match($text, '(?m)^#\s*fail\s+(\d+)\s*$')

  if (-not ($testsMatch.Success -and $passMatch.Success -and $failMatch.Success)) {
    # A crash before the summary must never read as success, whatever the
    # exit code says.
    return [pscustomobject]@{
      status = "FAIL"
      detail = "no complete test summary was produced (runner crashed or output truncated)"
      tests  = 0
      pass   = 0
      fail   = 0
    }
  }

  $tests = [int]$testsMatch.Groups[1].Value
  $passed = [int]$passMatch.Groups[1].Value
  $failed = [int]$failMatch.Groups[1].Value

  if ($tests -le 0) {
    return [pscustomobject]@{
      status = "FAIL"
      detail = "the runner executed 0 tests"
      tests  = $tests
      pass   = $passed
      fail   = $failed
    }
  }

  if ($failed -gt 0) {
    return [pscustomobject]@{
      status = "FAIL"
      detail = "$failed of $tests test(s) failed"
      tests  = $tests
      pass   = $passed
      fail   = $failed
    }
  }

  if ([int]$ExitCode -ne 0) {
    # The summary can be clean while the process still died afterwards.
    return [pscustomobject]@{
      status = "FAIL"
      detail = "summary reported no failures but the runner exited $ExitCode"
      tests  = $tests
      pass   = $passed
      fail   = $failed
    }
  }

  return [pscustomobject]@{
    status = "PASS"
    detail = "$passed of $tests passed, 0 failed"
    tests  = $tests
    pass   = $passed
    fail   = $failed
  }
}

<#
.SYNOPSIS
Classifies the collector's listening sockets.

.DESCRIPTION
An earlier version returned early with "collector not running" when it found
no listener, and the caller recorded that as PASS. An absent collector is not
evidence that its binding is correct: it is evidence of nothing. When the
collector is expected, absence is a FAIL; when it is optional, absence is a
SKIP. Neither is a PASS.

Listeners are supplied as objects with a LocalAddress property so this can be
exercised without a running collector.
#>
function Get-CollectorListenerState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][AllowNull()]$Listeners,
    [switch]$Required
  )

  if ($null -eq $Listeners) {
    return [pscustomobject]@{
      status = "INCONCLUSIVE"
      detail = "the listening sockets could not be enumerated"
    }
  }

  $items = @($Listeners)

  if ($items.Count -eq 0) {
    if ($Required) {
      return [pscustomobject]@{ status = "FAIL"; detail = "the collector is expected to be running but nothing is listening on 4317" }
    }
    return [pscustomobject]@{ status = "SKIP"; detail = "the collector is not running, so its binding was not verified" }
  }

  $nonLoopback = @($items | Where-Object { $_.LocalAddress -ne "127.0.0.1" })
  if ($nonLoopback.Count -gt 0) {
    # Count only; an address is not secret but printing it adds nothing.
    return [pscustomobject]@{ status = "FAIL"; detail = "$($nonLoopback.Count) listener(s) bound beyond loopback" }
  }

  return [pscustomobject]@{ status = "PASS"; detail = "$($items.Count) loopback listener(s)" }
}

<#
.SYNOPSIS
Runs an external command and reports its exit code alongside its output.

.DESCRIPTION
`$LASTEXITCODE` is easy to read at the wrong moment: any intervening command
overwrites it. Capturing both together removes that ordering hazard.
#>
function Invoke-Checked {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $global:LASTEXITCODE = 0
  $output = & $Command 2>&1 | Out-String
  $code = $LASTEXITCODE

  return [pscustomobject]@{
    exitCode = $code
    output   = $output
  }
}
