#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${RMC_LOG_DIR:-/var/log/rmc}"
LOG_FILE="$LOG_DIR/fixed-odds-vps.log"
LOCK_FILE="/tmp/rmc-fixed-odds-vps.lock"

mkdir -p "$LOG_DIR" 2>/dev/null || true
if [ ! -w "$LOG_DIR" ]; then
  LOG_DIR="$HOME/.local/state/rmc"
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/fixed-odds-vps.log"
fi

log(){ printf '%s  %s\n' "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$LOG_FILE"; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "SKIP: another fixed-odds scan is already running"
  exit 0
fi

cd "$REPO_ROOT"
export RMC_SOURCE_MACHINE="japan_vps_linux"
export RMC_SOURCE_REGION="JP"

log "START fixed-odds Japan VPS scan"
git fetch origin main
git pull --rebase --autostash origin main

command -v node >/dev/null || { log "FAIL: node not found"; exit 1; }
node -e "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))" || {
  log "Playwright missing; installing"
  npm install --no-save playwright@1.55.0
}
npx playwright install chromium >/dev/null

node scripts/scrape-bet-channel-fixed-odds-local.mjs data/bet-channel-fixed-odds-inventory.json

node <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("data/bet-channel-fixed-odds-inventory.json","utf8"));
const e=[];
if(x.complete!==true)e.push("complete");
if(x.analysis_ready!==true)e.push("analysis_ready");
if(x.access_status!=="direct")e.push("access_status");
if(x.source_machine!=="japan_vps_linux")e.push("source_machine");
if(x.source_region!=="JP")e.push("source_region");
if(x.menu_end_verified!==true)e.push("menu_end_verified");
if(x.event_count!==x.event_ids?.length)e.push("event_count");
if(x.screening_event_count!==x.screening_event_ids?.length)e.push("screening_event_count");
if((x.self_audit?.unresolved_blockers??1)!==0)e.push("unresolved_blockers");
if(e.length){console.error("fixed inventory validation failed:",e.join(","));process.exit(1);}
console.log(JSON.stringify({checked_at:x.checked_at,category_count:x.category_count,event_count:x.event_count,screening_event_count:x.screening_event_count,source_machine:x.source_machine},null,2));
NODE

git add -- data/bet-channel-fixed-odds-inventory.json
if git diff --cached --quiet; then
  log "No fixed-odds diff; scan complete"
  exit 0
fi

git config user.name "RMC Japan VPS"
git config user.email "rmc-vps@users.noreply.github.com"
git commit -m "Update BET CHANNEL fixed-odds inventory (Japan VPS)"

pushed=0
for attempt in 1 2 3; do
  if git push origin HEAD:main; then pushed=1; break; fi
  log "push conflict retry $attempt/3"
  git pull --rebase --autostash origin main
  sleep 2
done
if [ "$pushed" != "1" ]; then
  log "FAIL: could not push fixed inventory"
  exit 1
fi
log "SUCCESS fixed-odds Japan VPS scan and push"
