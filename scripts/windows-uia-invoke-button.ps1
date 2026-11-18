param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$TimeoutSeconds = 15
)
# Invokes a button by its exact name in a top-level window owned by ONE
# test-owned process (for example the QuotaOps consent dialog). UI Automation
# Invoke, or BM_CLICK posted to that button's own window when the button (a
# Windows task-dialog CCPushButton) exposes no pattern. No mouse movement, no
# keystrokes, no other process is touched.
# ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QuotaOpsButtonDriver {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$A = [System.Windows.Automation.AutomationElement]
$pidCondition = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $TargetPid)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

function Find-Button($element, $depth) {
  if ($depth -gt 10) { return $null }
  $current = $element.Current
  $isButton = $current.ControlType -eq [System.Windows.Automation.ControlType]::Button -or
    $current.ClassName -eq "CCPushButton"
  if ($isButton -and $current.Name -eq $Name) {
    return $element
  }
  $child = $walker.GetFirstChild($element)
  while ($child -ne $null) {
    $found = Find-Button $child ($depth + 1)
    if ($found) { return $found }
    $child = $walker.GetNextSibling($child)
  }
  return $null
}

$until = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $until) {
  foreach ($window in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCondition)) {
    $button = Find-Button $window 0
    if ($button) {
      $pattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        "BUTTON_INVOKED"
        exit 0
      }
      $hwnd = [IntPtr]$button.Current.NativeWindowHandle
      if ($hwnd -ne [IntPtr]::Zero) {
        $owner = 0
        [void][QuotaOpsButtonDriver]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        if ($owner -eq $TargetPid) {
          $BM_CLICK = 0x00F5
          [void][QuotaOpsButtonDriver]::PostMessage($hwnd, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
          "BUTTON_CLICKED"
          exit 0
        }
      }
      "BUTTON_NOT_INVOKABLE"
      exit 3
    }
  }
  Start-Sleep -Milliseconds 300
}
"BUTTON_NOT_FOUND"
exit 4
