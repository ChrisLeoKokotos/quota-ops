param([Parameter(Mandatory=$true)][int]$TargetPid)
# Read-only Windows UI Automation. Restrict traversal to the spawned app's
# top-level windows. Report only a fixed PASS/FAIL marker, never UI contents.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
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
