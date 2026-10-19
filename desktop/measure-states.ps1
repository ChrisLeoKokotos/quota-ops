# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# Measures the IPC desktop shell across the four states the owner asked for:
#
#   1. Dashboard visible and idle
#   2. Minimized to the system tray
#   3. Background collection running
#   4. Background monitoring paused
#
# Samples the whole process tree each time -- shell, renderers, any collector
# and any browser it launches -- because measuring only the shell would hide
# exactly the costs these states exist to expose.

[CmdletBinding()]
param(
  [int]$SettleSeconds = 12,
  [string]$OutFile = "docs\performance\ipc-states.jsonl"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electron = Join-Path $repo "node_modules\electron\dist\electron.exe"
$shellDir = Join-Path $repo "desktop\electron-ipc"

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Get-AppProcesses {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    $self = $PID
    $all = @(Get-CimInstance Win32_Process)
    $byParent = @{}
    foreach ($entry in $all) {
      $parent = [int]$entry.ParentProcessId
      if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = @() }
      $byParent[$parent] += $entry
    }

    $ids = @{}
    foreach ($candidate in @(Get-Process)) {
      if ($candidate.Id -eq $self) { continue }
      if ($candidate.Path -and $candidate.Path.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
        $ids[[int]$candidate.Id] = $true
      }
    }
    # Pull in descendants too: WebView2, Chrome and the collector live outside
    # the repository but belong to the application while it owns them.
    foreach ($seed in @($ids.Keys)) {
      $queue = New-Object System.Collections.Queue
      $queue.Enqueue([int]$seed)
      while ($queue.Count -gt 0) {
        $current = [int]$queue.Dequeue()
        if ($byParent.ContainsKey($current)) {
          foreach ($child in $byParent[$current]) {
            $childId = [int]$child.ProcessId
            if (-not $ids.ContainsKey($childId)) {
              $ids[$childId] = $true
              $queue.Enqueue($childId)
            }
          }
        }
      }
    }
    # Collector and QuotaOps-owned browsers, wherever they run from.
    foreach ($entry in $all) {
      if ($entry.ProcessId -eq $self) { continue }
      if ($entry.CommandLine -and (
            $entry.CommandLine -like "*collector/service.ts*" -or
            $entry.CommandLine -like "*collector\service.ts*" -or
            $entry.CommandLine -like "*--user-data-dir=*quotaops*")) {
        $ids[[int]$entry.ProcessId] = $true
      }
    }
    $ids.Remove($self)

    $resolved = @()
    foreach ($id in @($ids.Keys)) {
      $live = Get-Process -Id $id
      if ($live) { $resolved += $live }
    }
    return @($resolved)
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Sample-State([string]$Name, [int]$Seconds) {
  Start-Sleep -Seconds $Seconds

  $procs = @(Get-AppProcesses)
  $before = (@($procs) | ForEach-Object { try { $_.TotalProcessorTime.TotalMilliseconds } catch { 0 } } | Measure-Object -Sum).Sum
  Start-Sleep -Seconds $Seconds
  $procs = @(Get-AppProcesses)
  $after = (@($procs) | ForEach-Object { try { $_.Refresh(); $_.TotalProcessorTime.TotalMilliseconds } catch { 0 } } | Measure-Object -Sum).Sum

  $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $private = (@($procs) | ForEach-Object { try { $_.PrivateMemorySize64 } catch { 0 } } | Measure-Object -Sum).Sum
  $browsers = @($procs | Where-Object { $_.ProcessName -in @("chrome", "msedge", "msedgewebview2") }).Count

  $result = [pscustomobject]@{
    state            = $Name
    processCount     = @($procs).Count
    privateMB        = [math]::Round($private / 1MB, 1)
    cpuPercent       = [math]::Round((($after - $before) / ($Seconds * 1000.0 * $cores)) * 100, 3)
    browserProcesses = $browsers
    timestamp        = (Get-Date).ToString("o")
  }

  Write-Host ("  {0,-28} {1,2} procs  {2,7} MB  {3,6}% CPU  {4} browser" -f
    $result.state, $result.processCount, $result.privateMB, $result.cpuPercent, $result.browserProcesses)
  return $result
}

# --- clean slate -------------------------------------------------------------
Get-Process electron, quotaops -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$repo*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*collector/service.ts*" -or $_.CommandLine -like "*snapshot-stub*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$results = @()

# --- collector up, so the dashboard has something to show --------------------
$collector = Start-Process -FilePath "node" -ArgumentList @((Join-Path $repo "desktop\collector-stub.mjs")) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

$app = Start-Process -FilePath $electron -ArgumentList @($shellDir) -PassThru
Write-Host ("Launched IPC shell as pid {0}" -f $app.Id)

Write-Host "States:"
$results += Sample-State "1. visible and idle" $SettleSeconds

# --- 2. minimized to tray ----------------------------------------------------
# The window is hidden the same way the close button does it.
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
$handle = $app.MainWindowHandle
if ($handle -ne 0) {
  Add-Type -Namespace Win -Name Native -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
"@
  [Win.Native]::ShowWindow($handle, 0) | Out-Null   # SW_HIDE
}
$results += Sample-State "2. minimized to tray" $SettleSeconds

# --- 3. background collection running ----------------------------------------
# A real browser launched against a QuotaOps-style profile, which is what
# collection actually costs. Synthetic: no provider login.
$profileRoot = Join-Path $env:TEMP ("quotaops-state3-" + [guid]::NewGuid().ToString("N"))
$collect = Start-Process -FilePath "node" -ArgumentList @("--experimental-strip-types", (Join-Path $repo "desktop\collect-sim.mjs"), $profileRoot) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 6
$results += Sample-State "3. collection running" $SettleSeconds
try { $collect | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profileRoot*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 4
Remove-Item $profileRoot -Recurse -Force -ErrorAction SilentlyContinue

# --- 4. monitoring paused ----------------------------------------------------
$collector | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$results += Sample-State "4. monitoring paused" $SettleSeconds

# --- teardown ----------------------------------------------------------------
$app | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$leftover = @(Get-AppProcesses).Count
Write-Host ("Processes surviving shutdown: {0}" -f $leftover)

$payload = [pscustomobject]@{
  states            = $results
  leftoverProcesses = $leftover
  machine           = [pscustomobject]@{
    os    = (Get-CimInstance Win32_OperatingSystem).Version
    cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
    ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  }
}
$json = $payload | ConvertTo-Json -Compress -Depth 6
Add-Content -Path (Join-Path $repo $OutFile) -Value $json -Encoding utf8
Write-Output $json
