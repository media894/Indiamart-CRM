$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $appDir "start-crm.bat"
$taskName = "IndiaMART CRM Auto Start"

if (!(Test-Path $startScript)) {
  throw "Missing start script: $startScript"
}

$action = New-ScheduledTaskAction -Execute $startScript -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Starts the IndiaMART CRM Node server when Windows user logs in." `
  -Force | Out-Null

Write-Host "Auto-start task installed: $taskName"
Write-Host "The CRM will start automatically after Windows login."
Write-Host "To start now, run: .\start-crm.bat"
