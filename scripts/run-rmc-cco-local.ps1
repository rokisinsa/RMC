param(
  [string]$RunId = "",
  [ValidateSet("06:00","17:00","22:00")]
  [string]$Slot = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

function Exec([string]$Exe, [string[]]$Args) {
  & $Exe @Args
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed ($LASTEXITCODE): $($Args -join ' ')" }
}

function JstNow {
  $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
  return [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow,$tz)
}

$now = JstNow
if (-not $Slot) {
  if ($now.Hour -lt 11) { $Slot = "06:00" }
  elseif ($now.Hour -lt 20) { $Slot = "17:00" }
  else { $Slot = "22:00" }
}
if (-not $RunId) {
  $RunId = "rmc-{0}-{1}00" -f $now.ToString("yyyyMMdd"), $Slot.Substring(0,2)
}

Write-Host "RMC CCO FULL RUN: $RunId / $Slot" -ForegroundColor Cyan

foreach ($cmd in @("git","node","npm","npx","claude")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    if ($cmd -eq "claude") {
      Exec "npm" @("install","-g","@anthropic-ai/claude-code")
    } else {
      throw "$cmd が見つかりません。"
    }
  }
}

Exec "git" @("fetch","origin","main")
Exec "git" @("pull","--rebase","--autostash","origin","main")
$StartSha = (& git rev-parse HEAD).Trim()

Exec "npm" @("install","--no-save","playwright@1.55.0")
Exec "npx" @("playwright","install","chromium")

$tmp1 = Join-Path $env:TEMP "rmc-bc-attempt1.json"
$tmp2 = Join-Path $env:TEMP "rmc-bc-attempt2.json"
Remove-Item $tmp1,$tmp2 -Force -ErrorAction SilentlyContinue
& node scripts/scrape-bet-channel.mjs $tmp1
$code1=$LASTEXITCODE
$needRetry=$true
if($code1 -eq 0 -and (Test-Path $tmp1)){
  $needRetry = (node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write((x.self_audit?.requires_rescan||!x.complete||!x.analysis_ready)?'yes':'no')" $tmp1) -eq "yes"
}
if($needRetry){ Exec "node" @("scripts/scrape-bet-channel.mjs",$tmp2) }
$args=@("--attempt1",$tmp1,"--out","data/bet-channel-inventory.json","--summary","data/bet-channel-screening-summary.json")
if(Test-Path $tmp2){ $args += @("--attempt2",$tmp2) }
Exec "node" (@("scripts/select-bet-channel-inventory.mjs")+$args)

$env:RMC_SOURCE_MACHINE="japan_local_windows"
$env:RMC_SOURCE_REGION="JP"
$env:RMC_SOURCE_REGION_EVIDENCE="local_windows_user_confirmed_japan"
Exec "node" @("scripts/scrape-bet-channel-fixed-odds-local.mjs","data/bet-channel-fixed-odds-inventory.json")
Exec "node" @("scripts/build-bet-channel-complete-inventory.mjs","data/bet-channel-screening-summary.json","data/bet-channel-fixed-odds-inventory.json","data/bet-channel-complete-summary.json")

node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync('data/bet-channel-complete-summary.json','utf8'));const now=Date.now(),l=Date.parse(x.component_status?.legacy?.checked_at||''),f=Date.parse(x.component_status?.fixed_odds?.checked_at||'');const e=[];if(x.complete!==true||x.analysis_ready!==true||x.menu_end_verified!==true||(x.self_audit?.unresolved_blockers??1)!==0)e.push('union');if(!Number.isFinite(l)||now-l>45*60*1000)e.push('legacy_stale');if(!Number.isFinite(f)||now-f>55*60*1000)e.push('fixed_stale');if(e.length){console.error(e);process.exit(1)};console.log('fresh complete union',x.category_count,x.event_count,x.screening_event_count)"
if($LASTEXITCODE -ne 0){ throw "fresh complete union validation failed" }

$payload = "incoming/$RunId.json"
New-Item -ItemType Directory -Force -Path "incoming","tmp" | Out-Null
Remove-Item $payload -Force -ErrorAction SilentlyContinue

$prompt = @"
RMCの本物の完全本番runを実行する。run_id=$RunId、slot=$Slot、source="CCO local Windows full production runner"。
CI/rehearsal/dry-run用の架空分析ではない。

最初に docs/RMC_ANALYSIS_LOGIC.md、schema/rmc-update-payload.schema.json、scripts/rmc-production-update.mjs、scripts/rmc-scheduled-checklist.mjs を読む。
freshな data/bet-channel-complete-summary.json の screening_event_ids 全件を、①recommendations ②value1 ③value2 ④pro_edge で完全独立一次走査する。リアルスポーツ全競技＋eSports全タイトルを対象にし、共通候補プールへまとめない。
deep_diveに上げたイベントはWebSearch/WebFetchを実際に使い、H2H、直近6〜10戦、共通相手比較、ranking/rating、平均得失点/SET/MAP/round差、H/AまたはLAN/online、roster/欠場、休養/移動、序盤傾向、競技固有指標、最新市場価格を複数情報源で確認する。1回検索して無いだけでinsufficient_dataにしない。公式→大会/リーグ公式→専門DB→信頼できる統計サイトへ検索を広げる。
eSportsはBO、patch/version、roster変更、map pool、veto、map勝率、共通相手、Tier差を確認する。
カジ旅、遊雅堂、bet365は公開取得可能範囲をWebでクロスチェックし、取れない場合もsource_auditへURL、checked_at、access_status、具体的理由を残す。推測値は禁止。
deep_diveが5件以上ある系統でinsufficient_dataが60%超なら追加調査を続け、解消不能なら未完成payloadを公開せず非0終了する。
既存①〜④＋experienceの開始済みpending/unknown/review_requiredも再照合する。
新規正式採用はsource_event_id、exact odds、observed_at/source、stake、bet_at、locked_atを固定する。市場確率を独立推定確率へコピーしない。
現行schemaとvalidatorに完全準拠したJSONを $payload にだけ作る。data/*.jsonを直接編集しない。scripts/build-live-coverage-rehearsal.mjs の unavailable ダミーは禁止。
payload作成後に node scripts/rmc-production-update.mjs --payload "$payload" --dry-run --start-sha "$StartSha" --report tmp/cco-dry-run.json を実行し、失敗したら修正してok=trueまで繰り返す。
最後に $payload が存在し、dry-run ok=trueを確認して終了する。
"@

$prompt | Set-Content -Encoding UTF8 "tmp/cco-full-run-prompt.txt"
& claude -p $prompt --dangerously-skip-permissions --output-format text
if($LASTEXITCODE -ne 0){ throw "Claude Code full analysis failed" }
if(-not (Test-Path $payload)){ throw "payload not created: $payload" }

Exec "node" @("scripts/rmc-production-update.mjs","--payload",$payload,"--dry-run","--start-sha",$StartSha,"--report","tmp/cco-dry-run-final.json")
$report=Get-Content "tmp/cco-dry-run-final.json" -Raw | ConvertFrom-Json
if($report.ok -ne $true){ throw "production dry-run is not ok" }

$work=".tmp-tests/cco-local"
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item data/scheduled-update-checklist.json "$work/checklist.json" -Force
$scheduledFor = "{0}T{1}:00+09:00" -f $now.ToString("yyyy-MM-dd"),$Slot
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--slot",$Slot,"--scheduled-for",$scheduledFor,"--source","CCO local Windows full production runner","--start-sha",$StartSha,"--inventory")
Exec "node" @("scripts/rmc-production-update.mjs","--payload",$payload,"--apply","--start-sha",$StartSha,"--report","$work/apply.json")
Exec "node" @("scripts/rmc-production-update.mjs","--check-diff")
Exec "npm" @("test")
Exec "node" @("scripts/snapshot-manifest.js","verify")
Exec "node" @("scripts/validate-data.js")
Exec "node" @("scripts/check-locked.js",$StartSha)
Exec "node" @("scripts/audit-report.js")
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--payload",$payload,"--report","tmp/cco-dry-run-final.json")
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--phase","tests","--detail","CCO full research + tests PASS")
Exec "node" @("scripts/rmc-production-update.mjs","--finalize","--run-id",$RunId,"--actions-result","pass")

Exec "git" @("add","incoming","data")
Exec "git" @("commit","-m","RMC CCO local full production update: $RunId")
Exec "git" @("push","origin","HEAD:main")
$EndSha=(& git rev-parse HEAD).Trim()
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--phase","commit","--detail","CCO main push PASS: $EndSha","--end-sha",$EndSha)

$base="https://rokisinsa.github.io/RMC"
$published=$false
for($i=0;$i -lt 60;$i++){
  try {
    $runs=(Invoke-WebRequest -UseBasicParsing "$base/data/automation-runs.json?cb=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())").Content
    if($runs -match [Regex]::Escape($RunId)){
      & node scripts/verify-public-profit.mjs --base $base --run-id $RunId --payload $payload
      if($LASTEXITCODE -eq 0){$published=$true;break}
    }
  } catch {}
  Start-Sleep -Seconds 10
}
if(-not $published){throw "Pages/public verification timed out"}

Exec "git" @("fetch","origin","main")
Exec "git" @("reset","--hard","origin/main")
Exec "node" @("scripts/rmc-production-update.mjs","--finalize-pages","--run-id",$RunId)
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--phase","pages","--detail","Pages/public profit audit PASS")
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--phase","public","--detail","public RMC/system-analysis/profit verification PASS")
Exec "node" @("scripts/rmc-scheduled-checklist.mjs","--file","$work/checklist.json","--run-id",$RunId,"--success","--detail","CCO checks 1-40 completed")
Exec "node" @("scripts/validate-scheduled-checklist.mjs","$work/checklist.json")
Copy-Item "$work/checklist.json" data/scheduled-update-checklist.json -Force
Exec "git" @("add","data/automation-runs.json","data/scheduled-update-checklist.json")
Exec "git" @("commit","-m","RMC CCO local Pages verified: $RunId")
Exec "git" @("push","origin","HEAD:main")

Write-Host "SUCCESS: $RunId / 41 of 41 / Pages verified" -ForegroundColor Green
