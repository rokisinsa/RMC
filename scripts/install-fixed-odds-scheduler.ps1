$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $RepoRoot "scripts\run-fixed-odds-local.ps1"
$TaskName = "RMC BET CHANNEL Fixed Odds"

Set-Location $RepoRoot

if (-not (Test-Path $Runner)) { throw "run-fixed-odds-local.ps1 が見つかりません: $Runner" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Gitを先にインストールしてください。" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.jsを先にインストールしてください。" }

Write-Host "RMC fixed-odds 自動取得を設定します。" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"

node -e "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))"
if ($LASTEXITCODE -ne 0) {
    npm install --no-save playwright@1.55.0
    if ($LASTEXITCODE -ne 0) { throw "Playwrightの導入に失敗しました。" }
}
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "Chromiumの導入に失敗しました。" }

$PowerShell = (Get-Command powershell.exe).Source
$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
    -WorkingDirectory $RepoRoot

$Triggers = @(
    (New-ScheduledTaskTrigger -Daily -At "05:20"),
    (New-ScheduledTaskTrigger -Daily -At "11:20"),
    (New-ScheduledTaskTrigger -Daily -At "17:20"),
    (New-ScheduledTaskTrigger -Daily -At "22:20")
)

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

$UserId = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited

$Task = New-ScheduledTask `
    -Action $Action `
    -Trigger $Triggers `
    -Settings $Settings `
    -Principal $Principal `
    -Description "RMC: BET CHANNEL fixed-odds/Betby eSportsを日本IPから取得しGitHubへ反映"

Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

Write-Host ""
Write-Host "登録完了: $TaskName" -ForegroundColor Green
Write-Host "実行時刻: 05:20 / 11:20 / 17:20 / 22:20 JST"
Write-Host "PCがスリープならWakeToRun、時刻を逃した場合はStartWhenAvailableで実行します。"
Write-Host ""
Write-Host "いま初回実行を開始します..." -ForegroundColor Cyan

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Runner
if ($LASTEXITCODE -ne 0) {
    throw "初回fixed-odds取得に失敗しました。画面のFAIL行と $env:TEMP\rmc-fixed-odds-local.log を確認してください。"
}

Write-Host ""
Write-Host "初回取得・GitHub反映まで成功しました。" -ForegroundColor Green
Write-Host "以後は自動実行されます。"
