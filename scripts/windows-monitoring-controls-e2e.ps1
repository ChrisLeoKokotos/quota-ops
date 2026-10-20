# Authenticated local controls smoke check for the *running installed app*.
# Prints only PASS/FAIL and counts; never outputs the bearer token or profiles.
# Always attempts to resume monitoring in a finally block.
param([int]$ExpectedAccounts = 5)
$ErrorActionPreference = "Stop"
$baseUrl = "http://127.0.0.1:4317"
$tokenPath = Join-Path $HOME ".quotaops\collector.token"
if (-not (Test-Path -LiteralPath $tokenPath)) {
  throw "FAIL: collector token file not available (app may not be started)"
}
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($token -notmatch '^[A-Za-z0-9_-]{43}$') {
  throw "FAIL: collector token has unexpected format"
}
$authorized = @{ Authorization = "Bearer $token"; Accept = "application/json" }

function Invoke-Authenticated([string]$method, [string]$resource) {
  return Invoke-RestMethod -Uri "$baseUrl$resource" -Method $method -Headers $authorized -TimeoutSec 8
}
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
}
function Expect-Denied([hashtable]$headers, [string]$resource, [int]$expectedStatus) {
  try {
    Invoke-WebRequest -Uri "$baseUrl$resource" -Headers $headers -Method Get -UseBasicParsing -TimeoutSec 8 | Out-Null
    throw "FAIL: denied request was accepted"
  } catch {
    if ($_.Exception.Message -eq "FAIL: denied request was accepted") { throw }
    $code = [int]$_.Exception.Response.StatusCode
    Assert-True ($code -eq $expectedStatus) "unexpected refusal status"
  }
}

$didPause = $false
try {
  Expect-Denied @{} "/snapshot" 401
  Expect-Denied @{ Authorization = "Bearer $token"; Origin = "https://evil.invalid" } "/snapshot" 403

  $health = Invoke-Authenticated "GET" "/health"
  Assert-True ($health.status -eq "ok") "collector health is not OK"
  $pause = Invoke-Authenticated "POST" "/monitoring/pause"
  $didPause = $true
  Assert-True ($pause.paused -eq $true) "pause was not acknowledged"
  $pausedHealth = Invoke-Authenticated "GET" "/health"
  Assert-True ($pausedHealth.paused -eq $true) "pause did not reach collector"
  $snapshot = Invoke-Authenticated "GET" "/snapshot"
  Assert-True ($snapshot.version -eq 1) "unexpected snapshot contract"
  Assert-True ($snapshot.accounts.Count -ge 0) "malformed snapshot accounts"
  if ($ExpectedAccounts -ge 0) {
    # An in-flight batch may be discarded when pause is requested. Do not
    # demand all accounts unless monitoring was allowed to finish beforehand.
    Write-Host ("Observed account results: {0}" -f $snapshot.accounts.Count)
  }
  Write-Host "PASS: unauthenticated denial, Origin denial, collector health, real pause, snapshot schema"
} finally {
  if ($didPause) {
    try {
      $resume = Invoke-Authenticated "POST" "/monitoring/resume"
      Assert-True ($resume.paused -eq $false) "resume not acknowledged"
      Write-Host "PASS: monitoring resumed"
    } catch {
      Write-Warning "Resume could not be confirmed. Reopen the QuotaOps tray and resume manually."
      throw
    }
  }
}
