#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "$RMC_RUN_ID"
: "$RMC_SLOT"
RMC_SOURCE="${RMC_SOURCE:-CCO full production runner}"
export RMC_SOURCE

bash scripts/run-rmc-cco-full.sh

START_SHA="$(cat tmp/cco-start-sha.txt)"
WORK=".tmp-tests/cco-production"
mkdir -p "$WORK"
cp data/scheduled-update-checklist.json "$WORK/checklist.json"
scheduled_for="$(node -e 'const m=process.env.RMC_RUN_ID.match(/^rmc-(\d{4})(\d{2})(\d{2})-/);process.stdout.write(m[1]+"-"+m[2]+"-"+m[3]+"T"+process.env.RMC_SLOT+":00+09:00")')"

node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --slot "$RMC_SLOT" --scheduled-for "$scheduled_for" --source "$RMC_SOURCE" --start-sha "$START_SHA" --inventory
node scripts/rmc-production-update.mjs --payload "incoming/$RMC_RUN_ID.json" --dry-run --start-sha "$START_SHA" --report "$WORK/dry-run.json"
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --payload "incoming/$RMC_RUN_ID.json" --report "$WORK/dry-run.json"
node scripts/rmc-production-update.mjs --payload "incoming/$RMC_RUN_ID.json" --apply --start-sha "$START_SHA" --report "$WORK/apply.json"
node scripts/rmc-production-update.mjs --check-diff
npm test
node scripts/snapshot-manifest.js verify
node scripts/validate-data.js
node scripts/check-locked.js "$START_SHA"
node scripts/audit-report.js
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --phase tests --detail "CCO full research + tests PASS"
node scripts/rmc-production-update.mjs --finalize --run-id "$RMC_RUN_ID" --actions-result pass
node scripts/validate-data.js

git config user.name "RMC CCO Runner"
git config user.email "rmc-cco@users.noreply.github.com"
git add incoming data
if git diff --cached --quiet; then
  echo "No production diff to commit" >&2
  exit 30
fi
git commit -m "RMC CCO full production update: $RMC_RUN_ID"
git push origin HEAD:main
END_SHA="$(git rev-parse HEAD)"
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --phase commit --detail "CCO main push PASS: $END_SHA" --end-sha "$END_SHA"

owner="${GITHUB_REPOSITORY%%/*}"
repo="${GITHUB_REPOSITORY#*/}"
base="https://${owner}.github.io/${repo}"
published=0
for i in $(seq 1 60); do
  if curl -fsS "$base/data/automation-runs.json?cb=$RANDOM" | grep -q "\"run_id\": \"$RMC_RUN_ID\""; then
    if node scripts/verify-public-profit.mjs --base "$base" --run-id "$RMC_RUN_ID" --payload "incoming/$RMC_RUN_ID.json"; then
      published=1
      break
    fi
  fi
  sleep 10
done
[ "$published" = 1 ] || { echo "Pages/public verification timed out" >&2; exit 31; }

git fetch origin main
git reset --hard origin/main
node scripts/rmc-production-update.mjs --finalize-pages --run-id "$RMC_RUN_ID"
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --phase pages --detail "Pages/public profit audit PASS"
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --phase public --detail "public RMC/system-analysis/profit verification PASS"
node scripts/rmc-scheduled-checklist.mjs --file "$WORK/checklist.json" --run-id "$RMC_RUN_ID" --success --detail "CCO checks 1-40 completed"
node scripts/validate-scheduled-checklist.mjs "$WORK/checklist.json"
cp "$WORK/checklist.json" data/scheduled-update-checklist.json

git add data/automation-runs.json data/scheduled-update-checklist.json
git commit -m "RMC CCO Pages verified: $RMC_RUN_ID"
git push origin HEAD:main

node - <<'NODE'
const fs=require("fs");
const id=process.env.RMC_RUN_ID;
const c=JSON.parse(fs.readFileSync("data/scheduled-update-checklist.json","utf8"));
const r=(c.runs||[]).find(x=>x.run_id===id);
console.log(JSON.stringify(r,null,2));
if(!r || r.status!=="passed" || r.summary?.pass!==41 || r.summary?.fail!==0 || r.summary?.blocked!==0 || r.summary?.pending!==0) process.exit(1);
NODE
