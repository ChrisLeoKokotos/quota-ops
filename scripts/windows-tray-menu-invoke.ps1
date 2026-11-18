param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [string]$Item = "Quit"
)
# Drives the REAL tray context menu of ONE test-owned QuotaOps process.
#
# 1. Posts the notify-icon callback that the Windows shell sends on a
#    right-click (WM_CONTEXTMENU) to that process's own
#    Electron_NotifyIconHostWindow, so Electron opens its real tray menu.
# 2. Invokes the named menu item through UI Automation, restricted to
#    elements owned by the same PID.
#
# No mouse movement, no keystrokes, no other process is touched. Used only by
# scripts/windows-packaged-tray-quit-e2e.mjs against an isolated test home.
# ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QuotaOpsTrayDriver {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr FindHost(uint want) {
    foreach (IntPtr parent in new IntPtr[] { IntPtr.Zero, new IntPtr(-3) }) {
      IntPtr h = IntPtr.Zero;
      while ((h = FindWindowEx(parent, h, "Electron_NotifyIconHostWindow", null)) != IntPtr.Zero) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == want) return h;
      }
    }
    return IntPtr.Zero;
  }
  public static int VisibleWidgets(uint want) {
    int n = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == want && IsWindowVisible(h)) {
        var sb = new StringBuilder(64); GetClassName(h, sb, 64);
        if (sb.ToString() == "Chrome_WidgetWin_1") n++;
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@

$host_ = [QuotaOpsTrayDriver]::FindHost([uint32]$TargetPid)
if ($host_ -eq [IntPtr]::Zero) { "TRAY_HOST_NOT_FOUND"; exit 2 }
[void][QuotaOpsTrayDriver]::AllowSetForegroundWindow($TargetPid)

$pidCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

function Find-MenuItem($element, $depth) {
  if ($depth -gt 12) { return $null }
  $current = $element.Current
  if ($current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -and
      $current.Name -eq $Item) { return $element }
  $child = $walker.GetFirstChild($element)
  while ($child -ne $null) {
    $found = Find-MenuItem $child ($depth + 1)
    if ($found) { return $found }
    $child = $walker.GetNextSibling($child)
  }
  return $null
}

function Find-OpenMenuItem {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $pidCondition)
  foreach ($window in $windows) {
    if ($window.Current.ClassName -ne "Chrome_WidgetWin_1") { continue }
    if ($window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Pane) { continue }
    $found = Find-MenuItem $window 0
    if ($found) { return $found }
  }
  return $null
}

# Electron numbers tray icons from an internal counter; probe a small range
# and stop at the first id that opens a menu window for this PID.
$WM_APP_NOTIFY = 0x8001
$WM_CONTEXTMENU = 0x007B
$baseline = [QuotaOpsTrayDriver]::VisibleWidgets([uint32]$TargetPid)
$menuItem = $null
foreach ($iconId in 2, 3, 4, 5, 6) {
  [void][QuotaOpsTrayDriver]::PostMessage($host_, $WM_APP_NOTIFY, [IntPtr]$iconId, [IntPtr]$WM_CONTEXTMENU)
  Start-Sleep -Milliseconds 900
  if ([QuotaOpsTrayDriver]::VisibleWidgets([uint32]$TargetPid) -gt $baseline) {
    "TRAY_MENU_OPENED icon_id=$iconId"
    $until = (Get-Date).AddSeconds(8)
    while (-not $menuItem -and (Get-Date) -lt $until) {
      Start-Sleep -Milliseconds 300
      $menuItem = Find-OpenMenuItem
    }
    break
  }
}
if (-not $menuItem) { "TRAY_MENU_ITEM_NOT_FOUND"; exit 4 }
$pattern = $null
if ($menuItem.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
  $pattern.Invoke()
  "TRAY_ITEM_INVOKED"
  exit 0
}
"TRAY_ITEM_NOT_INVOKABLE"
exit 3
