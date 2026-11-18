param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$WheelSteps = 40,
  [int]$ResizeSteps = 12,
  [int]$MinimizeCycles = 5
)
# Exercises ONE test-owned QuotaOps window and reports rendering and UI-thread
# responsiveness as JSON. Window messages go only to that window (wheel,
# resize, minimize/restore); the user's mouse and keyboard are not used.
#   nonblank*: distinct colours on a 48x48 grid of a PrintWindow capture
#              (a blank or failed software-rendered frame has very few).
#   uiLatency: round-trip of a UI Automation property read on the window,
#              sampled during each phase (served by the browser UI thread).
# ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Text;
using System.Drawing;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class QuotaOpsRenderProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static IntPtr MainWindow(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != want || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      var t = new StringBuilder(64); GetWindowText(h, t, 64);
      if (c.ToString() == "Chrome_WidgetWin_1" && t.ToString() == "QuotaOps") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int DistinctColours(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    int w = Math.Max(1, r.R - r.L), ht = Math.Max(1, r.B - r.T);
    using (var bmp = new Bitmap(w, ht)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        bool ok = PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc);
        if (!ok) return -1;
      }
      var seen = new HashSet<int>();
      for (int i = 1; i < 48; i++) for (int j = 1; j < 48; j++)
        seen.Add(bmp.GetPixel(w * i / 48, ht * j / 48).ToArgb());
      return seen.Count;
    }
  }
}
"@

$hwnd = [QuotaOpsRenderProbe]::MainWindow([uint32]$TargetPid)
if ($hwnd -eq [IntPtr]::Zero) { '{"error":"window_not_found"}'; exit 2 }
$SW_RESTORE = 9; $SW_MINIMIZE = 6; $WM_MOUSEWHEEL = 0x020A
$SWP_NOZORDER = 0x0004; $SWP_NOACTIVATE = 0x0010
[void][QuotaOpsRenderProbe]::ShowWindow($hwnd, $SW_RESTORE)
[void][QuotaOpsRenderProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, 80, 80, 1100, 640, $SWP_NOZORDER -bor $SWP_NOACTIVATE)
Start-Sleep -Milliseconds 1500
$before = [QuotaOpsRenderProbe]::DistinctColours($hwnd)

$element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$latencies = New-Object System.Collections.Generic.List[double]
function Measure-Ui {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  [void]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  [void]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
  $watch.Stop()
  $latencies.Add($watch.Elapsed.TotalMilliseconds)
}

# Scroll: wheel messages at the window centre (screen coordinates in lParam).
$rect = New-Object QuotaOpsRenderProbe+RECT
[void][QuotaOpsRenderProbe]::GetWindowRect($hwnd, [ref]$rect)
$cx = [int](($rect.L + $rect.R) / 2); $cy = [int](($rect.T + $rect.B) / 2)
$lparam = [IntPtr](($cy -shl 16) -bor ($cx -band 0xFFFF))
for ($i = 0; $i -lt $WheelSteps; $i++) {
  $delta = if ($i -lt ($WheelSteps / 2)) { -120 } else { 120 }
  $wparam = [IntPtr](($delta -band 0xFFFF) -shl 16)
  [void][QuotaOpsRenderProbe]::PostMessage($hwnd, $WM_MOUSEWHEEL, $wparam, $lparam)
  Start-Sleep -Milliseconds 50
  if ($i % 4 -eq 0) { Measure-Ui }
}
$afterScroll = [QuotaOpsRenderProbe]::DistinctColours($hwnd)

# Resize between three sizes.
$sizes = @(@(1100, 640), @(800, 520), @(1400, 860))
for ($i = 0; $i -lt $ResizeSteps; $i++) {
  $s = $sizes[$i % 3]
  [void][QuotaOpsRenderProbe]::SetWindowPos($hwnd, [IntPtr]::Zero, 80, 80, $s[0], $s[1], $SWP_NOZORDER -bor $SWP_NOACTIVATE)
  Start-Sleep -Milliseconds 150
  Measure-Ui
}
Start-Sleep -Milliseconds 600
$afterResize = [QuotaOpsRenderProbe]::DistinctColours($hwnd)

# Minimize / restore.
for ($i = 0; $i -lt $MinimizeCycles; $i++) {
  [void][QuotaOpsRenderProbe]::ShowWindow($hwnd, $SW_MINIMIZE)
  Start-Sleep -Milliseconds 400
  [void][QuotaOpsRenderProbe]::ShowWindow($hwnd, $SW_RESTORE)
  Start-Sleep -Milliseconds 400
  Measure-Ui
}
Start-Sleep -Milliseconds 800
$afterRestore = [QuotaOpsRenderProbe]::DistinctColours($hwnd)

$sorted = $latencies | Sort-Object
$p50 = $sorted[[int][Math]::Floor(($sorted.Count - 1) * 0.5)]
$p95 = $sorted[[int][Math]::Floor(($sorted.Count - 1) * 0.95)]
$max = $sorted[$sorted.Count - 1]
$inv = [System.Globalization.CultureInfo]::InvariantCulture
[string]::Format($inv,
  '{{"nonblankBefore":{0},"nonblankAfterScroll":{1},"nonblankAfterResize":{2},"nonblankAfterRestore":{3},"uiLatencyMs":{{"samples":{4},"p50":{5:0.0},"p95":{6:0.0},"max":{7:0.0}}}}}',
  $before, $afterScroll, $afterResize, $afterRestore, $sorted.Count, $p50, $p95, $max)
