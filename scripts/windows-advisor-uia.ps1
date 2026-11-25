param([Parameter(Mandatory=$true)][int]$TargetPid)
# Read-only Windows UI Automation. Restrict traversal to the spawned app's
# top-level windows. Report only a fixed PASS/FAIL marker, never UI contents.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AdvisorResize {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
}
"@
# No input injection, debug port, app security change, or arbitrary window access.
[void][AdvisorResize]::SetThreadDpiAwarenessContext([IntPtr](-4))
$A = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
$condition = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $TargetPid)
$expected = 'Recommended account: Advisor balanced; tightest remaining quota: 60.0%'
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $deadline) {
  try {
    foreach ($window in $A::RootElement.FindAll($S::Children, $condition)) {
      $nameCondition = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $expected)
      $result = $window.FindFirst($S::Descendants, $nameCondition)
      if ($null -eq $result) { continue }
      # The exact accessible label is rendered from the same recommendation
      # and headroom as the visible status. It cannot match a mere account card.
      $hwnd = [IntPtr]$window.Current.NativeWindowHandle
      [uint32]$owner = 0
      [void][AdvisorResize]::GetWindowThreadProcessId($hwnd,[ref]$owner)
      if ($hwnd -eq [IntPtr]::Zero -or $owner -ne $TargetPid) { throw 'Test window ownership mismatch' }
      $original = New-Object AdvisorResize+RECT
      if (![AdvisorResize]::GetWindowRect($hwnd,[ref]$original)) { throw 'Window bounds unavailable' }
      $dpi = [AdvisorResize]::GetDpiForWindow($hwnd)
      if ($dpi -eq 0) { throw 'Window DPI unavailable' }
      $scale = $dpi / 96.0
      try {
        foreach ($size in @(@{w=640;h=480},@{w=480;h=360})) {
          $w = [int][Math]::Round($size.w * $scale)
          $h = [int][Math]::Round($size.h * $scale)
          # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
          if (![AdvisorResize]::SetWindowPos($hwnd,[IntPtr]::Zero,0,0,$w,$h,22)) { throw 'Resize failed' }
          Start-Sleep -Milliseconds 750
          $bounds = New-Object AdvisorResize+RECT
          if (![AdvisorResize]::GetWindowRect($hwnd,[ref]$bounds)) { throw 'Resized bounds unavailable' }
          if ([Math]::Abs(($bounds.Right-$bounds.Left)-$w) -gt 4 -or [Math]::Abs(($bounds.Bottom-$bounds.Top)-$h) -gt 4) { throw 'Unexpected resized bounds' }
          $current = $A::FromHandle($hwnd)
          $stillRecommended = $current.FindFirst($S::Descendants,$nameCondition)
          if ($null -eq $stillRecommended) { throw 'Recommendation missing after resize' }
        }
        'ADVISOR_RESIZE_PASS'
      } finally {
        [void][AdvisorResize]::SetWindowPos($hwnd,[IntPtr]::Zero,0,0,($original.Right-$original.Left),($original.Bottom-$original.Top),22)
      }
      'ADVISOR_UI_PASS'
      exit 0
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    # A React update may replace accessibility elements. Retry fresh.
  }
  Start-Sleep -Milliseconds 500
}
'ADVISOR_UI_NOT_CONFIRMED'
exit 1
