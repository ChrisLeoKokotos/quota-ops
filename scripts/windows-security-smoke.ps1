# Requires Windows PowerShell 5.1+ or PowerShell 7.
# No provider login, secrets, or account profiles are used by this smoke test.
# QO-SEC-01: verifies the trusted dashboard server's loopback boundary and
# refuses to pass if any header-only request can reach a snapshot.
param([int]$Port = 3000)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$server = Join-Path $repo "server\dashboard-server.ts"
if (-not (Test-Path $server)) { throw "Trusted dashboard server missing from the checkout." }
if (-not (Test-Path (Join-Path $repo "node_modules\next"))) { throw "Next.js missing; run npm ci before this test." }
if (-not (Test-Path (Join-Path $repo ".next"))) { throw "Build missing; run npm run build first." }

Add-Type -AssemblyName System.Net.Http | Out-Null
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(8)

# Sends a request with full control over Host and custom headers, which
# Invoke-WebRequest does not reliably allow on Windows PowerShell 5.1.
function SendRequest([string]$url, [hashtable]$headers) {
  $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get), $url
  foreach ($name in $headers.Keys) {
    if ($name -ieq "Host") {
      $request.Headers.Host = $headers[$name]
    } else {
      [void]$request.Headers.TryAddWithoutValidation($name, $headers[$name])
    }
  }
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $body }
  } finally {
    $request.Dispose()
  }
}

function AssertStatus([string]$label, [int]$actual, [int[]]$expected) {
  if ($expected -notcontains $actual) {
    throw "$label : expected $($expected -join ' or '), got $actual"
  }
  Write-Host ("  PASS  {0} (HTTP {1})" -f $label, $actual)
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "Refusing to reuse existing listener on port $Port." }

$stdout = Join-Path $env:TEMP ("quotaops-next-smoke-" + [guid]::NewGuid().ToString("N") + ".out")
$stderr = "$stdout.err"
$process = $null
try {
  $env:PORT = "$Port"
  $arguments = ('--experimental-strip-types "' + $server + '" --production')
  $process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $arguments -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $ready = $false
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    if ($process.HasExited) { throw "Dashboard server exited before becoming ready. See $stderr" }
    try {
      if ((SendRequest "http://127.0.0.1:$Port/" @{}).Status -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Dashboard server did not become ready on loopback." }

  Write-Host "Listener binding"
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
  if ($listeners.Count -lt 1) { throw "No dashboard listener found." }
  foreach ($listener in $listeners) {
    if ($listener.LocalAddress -ne "127.0.0.1") {
      throw "Unexpected non-loopback listener: $($listener.LocalAddress):$Port"
    }
  }
  Write-Host ("  PASS  listener bound to 127.0.0.1 only ({0} entr{1})" -f $listeners.Count, $(if ($listeners.Count -eq 1) { "y" } else { "ies" }))

  $snapshot = "http://127.0.0.1:$Port/api/collector/snapshot"
  $capabilityUrl = "http://127.0.0.1:$Port/api/collector/capability"

  Write-Host "Negative snapshot requests"
  AssertStatus "no capability" (SendRequest $snapshot @{}).Status @(403)
  AssertStatus "retired X-QuotaOps-Client marker" (SendRequest $snapshot @{ "X-QuotaOps-Client" = "dashboard" }).Status @(403)
  AssertStatus "forged trusted-peer marker" (SendRequest $snapshot @{
    "X-QuotaOps-Peer" = "forged-marker"
    "X-QuotaOps-Peer-Address" = "127.0.0.1"
  }).Status @(403)
  AssertStatus "proxied request" (SendRequest $capabilityUrl @{ "X-Forwarded-For" = "203.0.113.9" }).Status @(403)

  Write-Host "Capability flow"
  $minted = SendRequest $capabilityUrl @{}
  if ($minted.Status -ne 200) { throw "Capability endpoint refused a loopback request: $($minted.Status)" }
  if ($minted.Body -notmatch '"capability":"(qo1\.\d+\.[A-Za-z0-9_-]+)"') { throw "Capability response was malformed." }
  $capability = $Matches[1]
  Write-Host ("  PASS  capability minted ({0} chars)" -f $capability.Length)

  AssertStatus "tampered capability" (SendRequest $snapshot @{ "X-QuotaOps-Capability" = ($capability.Substring(0, $capability.Length - 1) + "X") }).Status @(403)
  AssertStatus "non-loopback Host header" (SendRequest $snapshot @{
    "Host" = "untrusted.invalid:$Port"
    "X-QuotaOps-Capability" = $capability
  }).Status @(403)
  AssertStatus "cross-origin request" (SendRequest $snapshot @{
    "Origin" = "http://untrusted.invalid"
    "X-QuotaOps-Capability" = $capability
  }).Status @(403)

  # 503 means authorization passed and the local collector is simply not
  # running, which is the expected state for a credential-free smoke test.
  AssertStatus "valid capability reaches the collector hop" (SendRequest $snapshot @{ "X-QuotaOps-Capability" = $capability }).Status @(200, 503)

  Write-Host "LAN exposure"
  $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -First 1).IPAddress
  if ($lan) {
    $probe = New-Object System.Net.Sockets.TcpClient
    try {
      if ($probe.ConnectAsync($lan, $Port).Wait(3000)) {
        throw "Dashboard port answered on the host's LAN address $lan. This violates the QO-SEC-01 boundary."
      }
      Write-Host "  PASS  host LAN address does not accept connections on port $Port"
    } catch [System.AggregateException] {
      Write-Host "  PASS  host LAN address refused the connection on port $Port"
    } finally {
      $probe.Dispose()
    }
  } else {
    Write-Host "  SKIP  no non-loopback IPv4 address available to probe"
  }

  Write-Host ""
  Write-Host "PASS: loopback-only dashboard listener, seven refused unauthorized requests, capability flow intact."
} finally {
  Remove-Item Env:\PORT -ErrorAction SilentlyContinue
  if ($client) { $client.Dispose() }
  if ($process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
}
