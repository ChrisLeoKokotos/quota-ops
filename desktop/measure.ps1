# Requires Windows PowerShell 5.1+ or PowerShell 7.
#
# Architecture benchmark harness.
#
# Launches a desktop shell, waits for its window, then samples the whole
# process tree -- shell, web runtime, dashboard server and any browser the
# collector starts. Measuring only the top-level process would understate
# every multi-process framework, which is most of them.
#
# Reports startup latency, private working set across the tree, process count
# and CPU over a settle window. Writes a JSON line for the comparison table.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("electron", "tauri")][string]$Shell,
  [int]$SettleSeconds = 20,
  [int]$SampleSeconds = 30,
  [string]$OutFile
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:MeasureRoot = $repo

function Get-TreeProcesses([int]$RootPid) {
  # Two passes, unioned, because neither alone sees the whole application.
  #
  # Parent-chain descendants catch processes that run from outside the
  # repository -- most importantly WebView2, which lives in Program Files and
  # accounts for most of a Tauri app's memory.
  #
  # Path matching catches processes the chain can miss when a shell re-execs
  # or reparents its helpers.
  #
  # Using only the first would undercount Electron; using only the second
  # would undercount Tauri by roughly 190 MB. Either way the comparison would
  # favour one framework for a reason that has nothing to do with the
  # framework.
  $root = $script:MeasureRoot
  $self = $PID

  $previous = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    $all = @(Get-CimInstance Win32_Process)
    $byParent = @{}
    foreach ($entry in $all) {
      $parent = [int]$entry.ParentProcessId
      if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = @() }
      $byParent[$parent] += $entry
    }

    $ids = @{}
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([int]$RootPid)
    while ($queue.Count -gt 0) {
      $current = [int]$queue.Dequeue()
      if ($ids.ContainsKey($current)) { continue }
      $ids[$current] = $true
      if ($byParent.ContainsKey($current)) {
        foreach ($child in $byParent[$current]) { $queue.Enqueue([int]$child.ProcessId) }
      }
    }

    foreach ($candidate in @(Get-Process)) {
      if ($candidate.Id -eq $self) { continue }
      if ($candidate.Path -and $candidate.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $ids[[int]$candidate.Id] = $true
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

function Measure-Tree([int]$RootPid) {
  $procs = @(Get-TreeProcesses $RootPid)
  $private = 0
  $names = @{}
  foreach ($live in $procs) {
    try {
      $private += $live.PrivateMemorySize64
      $key = $live.ProcessName
      if (-not $names.ContainsKey($key)) { $names[$key] = 0 }
      $names[$key] = $names[$key] + 1
    } catch {
      # Exited between enumeration and sampling.
    }
  }
  return [pscustomobject]@{
    ProcessCount = @($procs).Count
    PrivateMB    = [math]::Round($private / 1MB, 1)
    Names        = $names
  }
}

# Clear any descriptor so the shell starts a fresh dashboard instance.
Remove-Item (Join-Path $env:USERPROFILE ".quotaops\dashboard-runtime.json") -Force -ErrorAction SilentlyContinue

# A parent Electron app exports this, and it would make the shell under test
# start as a bare Node process instead of a desktop app.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$t0 = Get-Date
$env:QUOTAOPS_T0 = [string][int64]([DateTimeOffset]$t0).ToUnixTimeMilliseconds()

if ($Shell -eq "electron") {
  $exe = Join-Path $repo "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $exe)) { throw "Electron is not installed in this worktree." }
  $launchArgs = @((Join-Path $repo "desktop\electron"))
  # The shippable payload, not the build tree.
  $packageRoot = Join-Path $repo "node_modules\electron\dist"
} else {
  $exe = Join-Path $repo "desktop\tauri\target\release\quotaops.exe"
  if (-not (Test-Path $exe)) { throw "Tauri binary not built; see docs/desktop/architecture-benchmark.md." }
  $launchArgs = @()
  # Only the produced binary: the build directory also holds artifacts and
  # dependency objects that are never shipped. WebView2 is an operating system
  # component on Windows 11 and is not part of the download either.
  $packageRoot = $exe
}

# `$args` is an automatic variable, and Start-Process rejects an empty
# -ArgumentList, so the Tauri binary is launched without that parameter.
$process = if ($launchArgs.Count -gt 0) {
  Start-Process -FilePath $exe -ArgumentList $launchArgs -PassThru
} else {
  Start-Process -FilePath $exe -PassThru
}
Write-Host ("Launched {0} as pid {1}" -f $Shell, $process.Id)

# Startup latency: first moment the dashboard answers its identity probe,
# which is the earliest point the window can show real content.
$descriptorPath = Join-Path $env:USERPROFILE ".quotaops\dashboard-runtime.json"
$ready = $null
for ($i = 0; $i -lt 120; $i++) {
  if (Test-Path $descriptorPath) {
    try {
      $d = Get-Content $descriptorPath -Raw | ConvertFrom-Json
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/__quotaops/instance" -f $d.port) -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ready = Get-Date; break }
    } catch {}
  }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { $process | Stop-Process -Force -ErrorAction SilentlyContinue; throw "Dashboard never became ready." }

$startupMs = [math]::Round(($ready - $t0).TotalMilliseconds)
Write-Host ("Dashboard ready after {0} ms" -f $startupMs)

Write-Host ("Settling for {0}s..." -f $SettleSeconds)
Start-Sleep -Seconds $SettleSeconds

$idle = Measure-Tree $process.Id
Write-Host ("Idle: {0} processes, {1} MB private" -f $idle.ProcessCount, $idle.PrivateMB)

# CPU over the sample window, across the whole tree.
$before = (@(Get-TreeProcesses $process.Id) | ForEach-Object {
  try { $_.TotalProcessorTime.TotalMilliseconds } catch { 0 }
} | Measure-Object -Sum).Sum
Start-Sleep -Seconds $SampleSeconds
$after = (@(Get-TreeProcesses $process.Id) | ForEach-Object {
  try { $_.Refresh(); $_.TotalProcessorTime.TotalMilliseconds } catch { 0 }
} | Measure-Object -Sum).Sum

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$cpuPercent = [math]::Round((($after - $before) / ($SampleSeconds * 1000.0 * $cores)) * 100, 3)
$sampled = Measure-Tree $process.Id

$packageMB = if (Test-Path $packageRoot -PathType Leaf) {
  [math]::Round((Get-Item $packageRoot).Length / 1MB, 2)
} else {
  [math]::Round((Get-ChildItem $packageRoot -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum / 1MB, 1)
}

$result = [pscustomobject]@{
  shell            = $Shell
  startupMs        = $startupMs
  idleProcessCount = $idle.ProcessCount
  idlePrivateMB    = $idle.PrivateMB
  settledProcessCount = $sampled.ProcessCount
  settledPrivateMB = $sampled.PrivateMB
  idleCpuPercent   = $cpuPercent
  packageMB        = $packageMB
  cores            = $cores
  sampleSeconds    = $SampleSeconds
  timestamp        = (Get-Date).ToString("o")
}

$process | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
# Anything the shell spawned must be gone with it.
$leftover = @(Get-TreeProcesses $process.Id).Count
$result | Add-Member -NotePropertyName leftoverProcesses -NotePropertyValue $leftover

$json = $result | ConvertTo-Json -Compress
Write-Output $json
if ($OutFile) { Add-Content -Path $OutFile -Value $json -Encoding utf8 }
