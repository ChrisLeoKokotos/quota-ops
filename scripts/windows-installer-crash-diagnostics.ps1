# Read-only, scoped diagnostics for disposable hosted Windows CI.
# Never emit raw event XML, messages, file paths, user identities or dumps.
param(
    [switch]$SelfTest,
    [string]$StartedUtc = '',
    [string]$ExitCode = ''
)
$ErrorActionPreference = 'Stop'
$installerName = 'QuotaOps-Setup-0.2.0-x64.exe'

function Get-SafeCrashFields([xml]$EventXml) {
    $fields = @{}
    foreach ($node in $EventXml.Event.EventData.Data) {
        $fields[[string]$node.Name] = [string]$node.InnerText
    }
    # Match the exact setup executable; unrelated crashes are not reported.
    if ($fields['AppName'] -ine $installerName) { return }
    $module = [string]$fields['ModuleName']
    if ($module -notmatch '^[A-Za-z0-9_.-]{1,100}$') { $module = 'unavailable' }
    $exception = [string]$fields['ExceptionCode']
    if ($exception -notmatch '^(?:0x)?[0-9A-Fa-f]{8}$') { $exception = 'unavailable' }
    $offset = [string]$fields['FaultingOffset']
    if ($offset -notmatch '^(?:0x)?[0-9A-Fa-f]{1,16}$') { $offset = 'unavailable' }
    [pscustomobject]@{ module = $module; exception = $exception; offset = $offset }
}

if ($SelfTest) {
    [xml]$fixture = '<Event><EventData><Data Name="AppName">QuotaOps-Setup-0.2.0-x64.exe</Data><Data Name="ModuleName">ntdll.dll</Data><Data Name="ExceptionCode">c0000005</Data><Data Name="FaultingOffset">0000000000012345</Data><Data Name="AppPath">C:\private\fixture.exe</Data></EventData></Event>'
    $result = Get-SafeCrashFields $fixture
    if ($result.module -ne 'ntdll.dll' -or $result.exception -ne 'c0000005' -or $result.offset -ne '0000000000012345' -or @($result.PSObject.Properties).Count -ne 3) { throw 'Diagnostic projection regression' }
    [xml]$unrelated = '<Event><EventData><Data Name="AppName">unrelated.exe</Data></EventData></Event>'
    if ($null -ne (Get-SafeCrashFields $unrelated)) { throw 'Unrelated event accepted' }
    [xml]$unsafe = '<Event><EventData><Data Name="AppName">QuotaOps-Setup-0.2.0-x64.exe</Data><Data Name="ModuleName">C:\private\module.dll</Data><Data Name="ExceptionCode">bad</Data><Data Name="FaultingOffset">bad!</Data></EventData></Event>'
    $result = Get-SafeCrashFields $unsafe
    if ($result.module -ne 'unavailable' -or $result.exception -ne 'unavailable' -or $result.offset -ne 'unavailable') { throw 'Unsafe field accepted' }
    Write-Output 'PASS: scoped installer crash event projection; unrelated and unsafe fields rejected.'
    exit 0
}

if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Hosted GitHub Actions runner required' }
try {
    $start = [DateTimeOffset]::Parse($StartedUtc, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime
} catch {
    Write-Output 'Installer event diagnostics unavailable: invalid start timestamp.'
    exit 0
}
if ($start -lt (Get-Date).AddMinutes(-35) -or $start -gt (Get-Date).AddMinutes(1)) {
    Write-Output 'Installer event diagnostics unavailable: start outside bounded window.'
    exit 0
}
if ($ExitCode -match '^-?[0-9]{1,10}$') { Write-Output "Installer process exit code: $ExitCode" }
$artifact = 'release/windows/QuotaOps-Setup-0.2.0-x64.exe'
if (Test-Path -LiteralPath $artifact -PathType Leaf) {
    try { Write-Output "Installer SHA256: $((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash)" } catch { Write-Output 'Installer SHA256 unavailable.' }
}
# Windows Error Reporting may publish the Application Error event after process exit.
for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; ProviderName='Application Error'; Id=1000; StartTime=$start } -MaxEvents 50 -ErrorAction Stop)
        $matches = @(foreach ($event in $events) { Get-SafeCrashFields ([xml]$event.ToXml()) })
        if ($matches.Count -gt 0) {
            foreach ($match in ($matches | Select-Object -First 5)) {
                Write-Output "Installer crash event: module=$($match.module) exception=$($match.exception) offset=$($match.offset)"
            }
            exit 0
        }
    } catch {
        # No raw exception or event output: it may contain local paths.
    }
    if ($attempt -lt 2) { Start-Sleep -Seconds 5 }
}
Write-Output 'No matching Application Error event found in bounded window; fault module remains unknown.'
# Original installation step remains failed. This diagnostic never retries it.
