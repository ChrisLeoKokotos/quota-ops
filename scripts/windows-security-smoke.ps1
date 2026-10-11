# Requires Windows PowerShell 5.1+ or PowerShell 7.
# No provider login, secrets, or account profiles are used by this smoke test.
param([int]$Port = 3000)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$next = Join-Path $repo "node_modules\next\dist\bin\next"
if (-not (Test-Path $next)) { throw "Next.js missing; run npm ci before this test." }
if (-not (Test-Path (Join-Path $repo ".next"))) { throw "Build missing; run npm run build first." }

function ReadHttpStatus([string]$url, [hashtable]$headers) {
  try {
    $response = Invoke-WebRequest -Uri $url -Headers $headers -TimeoutSec 4 -UseBasicParsing
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) {
      return [int]$_.Exception.Response.StatusCode
    }
    throw
  }
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "Refusing to reuse existing listener on port $Port." }

$stdout = Join-Path $env:TEMP ("quotaops-next-smoke-" + [guid]::NewGuid().ToString("N") + ".out")
$stderr = "$stdout.err"
$process = $null
try {
  $process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(
    $next, "start", "--hostname", "127.0.0.1", "--port", "$Port"
  ) -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $ready = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    if ($process.HasExited) { throw "Next.js process exited before becoming ready." }
    try {
      $status = ReadHttpStatus "http://127.0.0.1:$Port/" @{}
      if ($status -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Next.js did not become ready on loopback." }

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  if ($listeners.Count -lt 1) { throw "No Next.js listener found." }
  foreach ($listener in $listeners) {
    if ($listener.LocalAddress -ne "127.0.0.1") {
      throw "Unexpected non-loopback listener: $($listener.LocalAddress):$Port"
    }
  }

  $snapshot = "http://127.0.0.1:$Port/api/collector/snapshot"
  $withoutMarker = ReadHttpStatus $snapshot @{}
  if ($withoutMarker -ne 403) { throw "Snapshot route allowed request without client marker: $withoutMarker" }

  $wrongMarker = ReadHttpStatus $snapshot @{ "x-quotaops-client" = "untrusted" }
  if ($wrongMarker -ne 403) { throw "Snapshot route allowed invalid marker: $wrongMarker" }

  $wrongOrigin = ReadHttpStatus $snapshot @{
    "x-quotaops-client" = "dashboard"
    "Origin" = "http://untrusted.invalid"
  }
  if ($wrongOrigin -ne 403) { throw "Snapshot route allowed cross-origin request: $wrongOrigin" }

  Write-Host "PASS: loopback-only Next.js listener and three negative snapshot requests."
} finally {
  if ($process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
}
