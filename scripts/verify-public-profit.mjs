#!/usr/bin/env node
import fs from "node:fs";
import { buildViewModel } from "../lib/view/model.js";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function fail(msg) {
  console.error("PUBLIC_PROFIT_VERIFY_FAIL:", msg);
  process.exit(1);
}
function auditSummary(s) {
  return {
    count:s.count, settled_games:s.settledGames, wins:s.wins, losses:s.losses, pending:s.pending,
    settled_stake:s.settledStake, net_profit:s.netProfit, roi:s.roi, amount_missing:s.amountMissing
  };
}
function profitAuditSnapshot(vm) {
  const zero={count:0,settledGames:0,wins:0,losses:0,pending:0,settledStake:0,netProfit:0,roi:null,amountMissing:0};
  return {
    recommendations:{
      official:auditSummary(vm.recommendations.summary),watch:auditSummary(zero),
      compound:{...vm.recommendations.compound},
      quarter_kelly:{...vm.recommendations.kelly}
    },
    value1:{official:auditSummary(vm.value1.official),watch:auditSummary(vm.value1.reference)},
    value2:{official:auditSummary(vm.value2.official),watch:auditSummary(vm.value2.reference)},
    pro_edge:{official:auditSummary(vm.pro_edge.official),watch:auditSummary(vm.pro_edge.reference)}
  };
}
function close(a,b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a-b) < 0.005;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "object" && typeof b === "object") {
    const ak=Object.keys(a||{}), bk=Object.keys(b||{});
    return ak.length===bk.length && ak.every(k=>k in (b||{}) && close(a[k],b[k]));
  }
  return a === b;
}
async function getJson(base,path) {
  const u = `${base.replace(/\/$/,"")}/${path}?cb=${Date.now()}-${Math.random()}`;
  const r = await fetch(u,{cache:"no-store"});
  if (!r.ok) {
    const e=new Error(`${path} HTTP ${r.status}`);
    e.status=r.status;
    throw e;
  }
  return r.json();
}
async function getText(base,path) {
  const u = `${base.replace(/\/$/,"")}/${path}?cb=${Date.now()}-${Math.random()}`;
  const r = await fetch(u,{cache:"no-store"});
  if (!r.ok) fail(`${path} HTTP ${r.status}`);
  return r.text();
}

const base = arg("--base");
const runId = arg("--run-id");
const payloadPath = arg("--payload");
if (!base || !runId || !payloadPath) fail("--base --run-id --payload are required");

const paths = {
  matches:"data/matches.json",
  match_updates:"data/match-updates.json",
  recommendations:"data/recommendations.json",
  experience:"data/experience.json",
  value1:"data/value1.json",
  value2:"data/value2.json",
  pro_edge:"data/pro_edge.json",
  system_analysis:"data/system-analysis.json",
  complete_summary:"data/bet-channel-complete-summary.json",
  legacy_unassigned:"data/legacy-unassigned.json",
  legacy_analysis_recommendations:"data/legacy-analysis/recommendations.json",
  legacy_analysis_value1:"data/legacy-analysis/value1.json",
  legacy_analysis_value2:"data/legacy-analysis/value2.json",
  post_match_recommendations:"data/post-match-reviews/recommendations.json",
  post_match_experience:"data/post-match-reviews/experience.json",
  post_match_value1:"data/post-match-reviews/value1.json",
  post_match_value2:"data/post-match-reviews/value2.json",
  post_match_pro_edge:"data/post-match-reviews/pro_edge.json",
};
const optional = new Set([
  "system_analysis","post_match_recommendations","post_match_experience",
  "post_match_value1","post_match_value2","post_match_pro_edge"
]);
const ds={};
for (const [k,p] of Object.entries(paths)) {
  try { ds[k]=await getJson(base,p); }
  catch(e) {
    if (optional.has(k) && e.status===404) continue;
    throw e;
  }
}
const cfg=await getJson(base,"config/pro-edge.config.json");
const automation=await getJson(base,"data/automation-runs.json");
const vm=buildViewModel(ds,{proEdgeConfig:cfg});
const actual=profitAuditSnapshot(vm);
const complete=ds.complete_summary;
const sysAnalysis=ds.system_analysis;
if (!complete || complete.complete!==true || complete.analysis_ready!==true || complete.menu_end_verified!==true || (complete.self_audit?.unresolved_blockers??1)!==0) {
  fail("public complete-summary is not complete");
}
if (!sysAnalysis || sysAnalysis.meta?.run_id!==runId) {
  fail(`public system-analysis run_id mismatch: expected ${runId}, got ${sysAnalysis?.meta?.run_id??"missing"}`);
}
const expectedCats=[...new Set((complete.category_keys??[]).map(String))].sort();
for (const system of ["recommendations","value1","value2","pro_edge"]) {
  const got=[...new Set((sysAnalysis.systems?.[system]?.sport_coverage??[]).map(x=>String(x.category_key??x.category??"")))].sort();
  if (JSON.stringify(got)!==JSON.stringify(expectedCats)) {
    fail(`public system-analysis ${system} category coverage mismatch: ${got.length}/${expectedCats.length}`);
  }
}
const fixedCount=complete.component_status?.fixed_odds?.screening_event_count??0;
if (fixedCount<=0) fail("public complete-summary has zero fixed-odds/eSports screening events");
console.log(`PUBLIC_SYSTEM_ANALYSIS_OK run=${runId} categories=${expectedCats.length} fixed_esports=${fixedCount}`);

const rec=(automation.runs||[]).find(x=>x.run_id===runId);
if (!rec) fail(`automation run ${runId} not found on public Pages`);
if (!close(actual,rec.profit_audit)) {
  console.error("expected profit_audit:", JSON.stringify(rec.profit_audit,null,2));
  console.error("public recomputed audit:", JSON.stringify(actual,null,2));
  fail("public data recomputation does not match profit_audit");
}

const payload=JSON.parse(fs.readFileSync(payloadPath,"utf8"));
const changed=new Set((payload.result_updates||[]).flatMap(r=>(r.changes||[]).map(c=>c.match_id)));
const systems=[
  ["recommendations",vm.recommendations.rows],
  ["value1",vm.value1.rows],
  ["value2",vm.value2.rows],
  ["pro_edge",vm.pro_edge.rows],
];
for (const [system,rows] of systems) {
  for (const r of rows.filter(x=>changed.has(x.match?.id) && x.bucket==="official")) {
    const s=r.settlement;
    if (s.state==="pending") fail(`${system} ${r.id}: changed final match remains pending`);
    if ((s.state==="win"||s.state==="loss") && s.stake!=null) {
      const legacy=r.flags?.includes("legacy_import");
      if (!legacy && s.odds==null) fail(`${system} ${r.id}: non-legacy official settled pick has no exact odds`);
      if (!legacy && s.profit==null) fail(`${system} ${r.id}: non-legacy official settled pick has no computed profit`);
      if (s.odds!=null && s.profit!=null) {
        const expected=s.state==="win"
          ? Math.round((s.stake*s.odds-s.stake+Number.EPSILON)*100)/100
          : -s.stake;
        if (Math.abs(expected-s.profit)>0.005) fail(`${system} ${r.id}: row profit mismatch expected ${expected}, got ${s.profit}`);
      }
    }
    console.log(`PUBLIC_ROW_OK ${system} ${r.id} state=${s.state} odds=${s.odds ?? "—"} stake=${s.stake ?? "—"} payout=${s.payout ?? "—"} profit=${s.profit ?? "—"}`);
  }
}

for (const path of ["analysis-v2.js","lib/view/model.js","lib/view/render.js","lib/settlement.js","lib/summary.js","lib/buckets.js"]) {
  const publicText=await getText(base,path);
  const localText=fs.readFileSync(new URL(`../${path}`, import.meta.url),"utf8");
  if (publicText !== localText) fail(`${path} on Pages differs from current main checkout`);
}
console.log("PUBLIC_PROFIT_VERIFY_OK", runId);
