# Registers a daily Windows Task Scheduler job that runs the Kidak collect-only pass.
# Run it yourself (it is NOT run automatically):   powershell -ExecutionPolicy Bypass -File tools\register_daily_collect.ps1
# Remove it again:                                 Unregister-ScheduledTask -TaskName "MarketOrganism-collect-kidak" -Confirm:$false
param(
  [string]$Markets = "kidak",
  [string]$At = "09:10",
  [string]$TaskName = "MarketOrganism-collect-$($Markets -replace ',','-')"
)
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Error "run 'python run.py' once first so .venv exists"; exit 1 }
$log = Join-Path $root "data\collect.log"
$cmd = "/c `"`"$py`" `"$root\run.py`" --collect $Markets >> `"$log`" 2>&1`""
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Market Organism: daily collect-only pass ($Markets) into data\history.duckdb" -Force | Out-Null
Write-Host "Registered '$TaskName' daily at $At -> $log"
Write-Host "NAVER keys: set NAVER_CLIENT_ID / NAVER_CLIENT_SECRET as *user* environment variables to include Naver DataLab."
