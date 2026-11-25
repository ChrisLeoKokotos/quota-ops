param([Parameter(Mandatory=$true)][int]$TargetPid)
# Read-only Windows UI Automation. Restrict traversal to the spawned app's
# top-level windows. Report only a fixed PASS/FAIL marker, never UI contents.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
$condition = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $TargetPid)
$expected = 'Recommended account: Advisor balanced'
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $deadline) {
  try {
    foreach ($window in $A::RootElement.FindAll($S::Children, $condition)) {
      $nameCondition = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $expected)
      $result = $window.FindFirst($S::Descendants, $nameCondition)
      if ($null -eq $result) { continue }
      # The recommendation's live region must contain the actual projected
      # headroom text, not merely an account name elsewhere in the dashboard.
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
      $queue.Enqueue($result)
      $names = New-Object 'System.Collections.Generic.List[string]'
      $seen = 0
      while ($queue.Count -gt 0 -and $seen -lt 100) {
        $item = $queue.Dequeue()
        $seen++
        $names.Add($item.Current.Name)
        $kid = $walker.GetFirstChild($item)
        while ($null -ne $kid -and $queue.Count -lt 100) {
          $queue.Enqueue($kid)
          $kid = $walker.GetNextSibling($kid)
        }
      }
      if (($names -join ' ') -match 'Tightest remaining quota:\s*60\.0%') {
        'ADVISOR_UI_PASS'
        exit 0
      }
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
    # A React update may replace accessibility elements. Retry fresh.
  }
  Start-Sleep -Milliseconds 500
}
'ADVISOR_UI_NOT_CONFIRMED'
exit 1
