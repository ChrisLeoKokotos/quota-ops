# Same-PC QuotaOps -> Lily scoped-token HTTP smoke test.
# NEVER prints bearer secrets. Requires the local collector to be running.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This test requires Windows.' }
$root = Join-Path $env:USERPROFILE '.quotaops'
$collectorPath = Join-Path $root 'collector.token'
$lilyPath = Join-Path $root 'lily-read.token'
if (-not (Test-Path $lilyPath)) { throw 'Missing Lily read-only token. Start QuotaOps collector.' }
if (-not (Test-Path $collectorPath)) { throw 'Missing collector token. Start QuotaOps collector.' }
$lily = (Get-Content -Path $lilyPath -Raw -ErrorAction Stop).Trim()
$collector = (Get-Content -Path $collectorPath -Raw -ErrorAction Stop).Trim()
if ($lily -eq $collector) { throw 'FAIL: Lily and collector token must be independent.' }
$base = 'http://127.0.0.1:4317'
$readHeaders = @{ Authorization = "Bearer $lily"; Accept = 'application/json' }
$collectorHeaders = @{ Authorization = "Bearer $collector"; Accept = 'application/json' }

function Assert-Unauthorized {
    param([string]$Path,[hashtable]$Headers)
    try {
        Invoke-WebRequest -Uri ($base + $Path) -Headers $Headers -Method Get -TimeoutSec 4 -UseBasicParsing | Out-Null
    } catch {
        $code = [int]$_.Exception.Response.StatusCode
        if ($code -eq 401) { return }
        throw ("Expected 401, got {0} on {1}" -f $code,$Path)
    }
    throw ("Unexpected authorization success at {0}" -f $Path)
}
Assert-Unauthorized '/snapshot' $readHeaders
Assert-Unauthorized '/lily/v1/snapshot' $collectorHeaders
$view = Invoke-RestMethod -Uri ($base + '/lily/v1/snapshot') -Headers $readHeaders -TimeoutSec 4
if ($view.version -ne 1 -or $view.scope -ne 'lily_readonly') {
    throw 'Unexpected schema version or scope.'
}
if ($view.tokens.scope -ne 'locally_observed') { throw 'Missing source provenance.' }
$serialized = ConvertTo-Json $view -Depth 20 -Compress
foreach ($forbidden in @('"email"', '"profileDir"', '"message"', '"accessToken"', '"Authorization"', '"cookies"')) {
    if ($serialized.Contains($forbidden)) { throw ("Unexpected sensitive field: {0}" -f $forbidden) }
}
Write-Host ("PASS: QuotaOps -> Lily native API boundary. Accounts={0}, scope={1}, tokenScope={2}." -f @($view.accounts).Count, $view.scope, $view.tokens.scope) -ForegroundColor Green
Write-Host 'Tokens were not printed. Open Lily Settings -> QuotaOps to complete native GUI acceptance.'
