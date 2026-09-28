$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Log = Join-Path $env:TEMP "rmc-fixed-odds-local.log"

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
    Add-Content -Path $Log -Value $line -Encoding UTF8
    Write-Host $line
}

try {
    Set-Location $RepoRoot
    Write-Log "START fixed-odds Japan local scan"

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git not found" }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm not found" }
    if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "npx not found" }

    git fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }

    git pull --rebase --autostash origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull --rebase failed" }

    node -e "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))"
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Playwright not found; installing"
        npm install --no-save playwright@1.55.0
        if ($LASTEXITCODE -ne 0) { throw "Playwright npm install failed" }
    }

    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Chromium install/check failed" }

    $env:RMC_SOURCE_MACHINE = "japan_local_windows"
    $env:RMC_SOURCE_REGION = "JP"
    $env:RMC_SOURCE_REGION_EVIDENCE = "local_windows_user_confirmed_japan"

    node scripts/scrape-bet-channel-fixed-odds-local.mjs data/bet-channel-fixed-odds-inventory.json
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Scrape incomplete; publishing diagnostic structure"
        if (Test-Path "data/bet-channel-fixed-odds-diagnostic.json") {
            git add -- data/bet-channel-fixed-odds-diagnostic.json
            git diff --cached --quiet
            if ($LASTEXITCODE -ne 0) {
                git config user.name "RMC Japan Local"
                git config user.email "rmc-local@users.noreply.github.com"
                git commit -m "Update BET CHANNEL fixed-odds diagnostic (Japan)"
                if ($LASTEXITCODE -eq 0) {
                    for ($i=1; $i -le 3; $i++) {
                        git push origin HEAD:main
                        if ($LASTEXITCODE -eq 0) { break }
                        git pull --rebase --autostash origin main
                        Start-Sleep -Seconds 2
                    }
                }
            }
        }
        throw "fixed-odds/eSports scrape did not complete"
    }

    node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync('data/bet-channel-fixed-odds-inventory.json','utf8'));if(x.complete!==true||x.analysis_ready!==true||x.access_status!=='direct'||x.source_machine!=='japan_local_windows'||x.self_audit?.unresolved_blockers!==0)process.exit(1);console.log('fixed complete',x.checked_at,x.event_count,x.screening_event_count)"
    if ($LASTEXITCODE -ne 0) { throw "fixed-odds/eSports final validation failed" }

    git add -- data/bet-channel-fixed-odds-inventory.json
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Log "No fixed-odds diff; scan complete"
        exit 0
    }

    git config user.name "RMC Japan Local"
    git config user.email "rmc-local@users.noreply.github.com"

    git commit -m "Update BET CHANNEL fixed-odds inventory (Japan)"
    if ($LASTEXITCODE -ne 0) { throw "fixed-odds inventory commit failed" }

    $pushed = $false
    for ($i=1; $i -le 3; $i++) {
        git push origin HEAD:main
        if ($LASTEXITCODE -eq 0) {
            $pushed = $true
            break
        }

        Write-Log "push conflict retry $i/3"
        git pull --rebase --autostash origin main
        if ($LASTEXITCODE -ne 0) { throw "rebase after push conflict failed" }
        Start-Sleep -Seconds 2
    }

    if (-not $pushed) { throw "push failed after 3 attempts" }

    Write-Log "SUCCESS fixed-odds Japan local scan and push"
    exit 0
}
catch {
    Write-Log "FAIL: $($_.Exception.Message)"
    exit 1
}
