#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runUpdate } from "./rmc-production-update.mjs";
import { loadDatasets, loadProEdgeConfig, ROOT } from "./load-node.js";
import { buildViewModel } from "../lib/view/model.js";
import { ensure, inventoryPhase, payloadPhase, mark, finish } from "./rmc-scheduled-checklist.mjs";

const RUN_ID="rmc-20260928-0600";
const SLOT="06:00";
const SCHEDULED_FOR="2026-09-28T06:00:00+09:00";
const GENERATED_AT="2026-09-28T06:00:00+09:00";
const LEGACY_CHECKED="2026-09-28T05:40:00+09:00";
const FIXED_CHECKED="2026-09-28T05:30:00+09:00";
const TMP=path.join(ROOT,".tmp-tests","full-scheduled-rehearsal");
const DATA=path.join(TMP,"data");
const SITE=path.join(TMP,"site");
const PAYLOAD_PATH=path.join(TMP,"payload.json");
const REPORT_PATH=path.join(TMP,"dry-report.json");
const CHECKLIST_PATH=path.join(TMP,"scheduled-update-checklist.json");
const sha=s=>createHash("sha256").update(String(s)).digest("hex").slice(0,20);
const write=(p,x)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x,null,2)+"\n")};
const run=(cmd,args,{env={}}={})=>{
  const r=spawnSync(cmd,args,{cwd:ROOT,encoding:"utf8",env:{...process.env,...env}});
  if(r.stdout)process.stdout.write(r.stdout);
  if(r.stderr)process.stderr.write(r.stderr);
  if(r.status!==0)throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
  return r.stdout;
};

fs.rmSync(TMP,{recursive:true,force:true});
fs.mkdirSync(TMP,{recursive:true});
fs.cpSync(path.join(ROOT,"data"),DATA,{recursive:true});

const events=[
  {event_id:"reh-football-1",category:"Football",category_key:"Football",start_at_jst:"2026-09-28T07:00:00+09:00",side_a:"Alpha FC",side_b:"Beta FC",sport:"Football",competition:"Rehearsal League",primary_market:true,market_class:"primary_h2h",start_state:"future_or_upcoming",price_state:"priced",market_choices:[{name:"Alpha FC",odds:1.42,bettable:true},{name:"Beta FC",odds:2.95,bettable:true}],source_url:"https://example.invalid/rehearsal/football/1"},
  {event_id:"reh-football-2",category:"Football",category_key:"Football",start_at_jst:"2026-09-28T10:00:00+09:00",side_a:"Gamma FC",side_b:"Delta FC",sport:"Football",competition:"Rehearsal League",primary_market:true,market_class:"primary_h2h",start_state:"future_or_upcoming",price_state:"priced",market_choices:[{name:"Gamma FC",odds:1.66,bettable:true},{name:"Delta FC",odds:2.20,bettable:true}],source_url:"https://example.invalid/rehearsal/football/2"},
  {event_id:"reh-cs2-1",category:"CS2 eSports",category_key:"CS2 eSports",start_at_jst:"2026-09-28T08:00:00+09:00",side_a:"Team A",side_b:"Team B",sport:"eSports CS2",competition:"Rehearsal CS2 Cup",primary_market:true,market_class:"primary_h2h",start_state:"future_or_upcoming",price_state:"priced",market_choices:[{name:"Team A",odds:1.55,bettable:true},{name:"Team B",odds:2.35,bettable:true}],source_url:"https://example.invalid/rehearsal/cs2/1"},
  {event_id:"reh-cs2-2",category:"CS2 eSports",category_key:"CS2 eSports",start_at_jst:"2026-09-28T12:00:00+09:00",side_a:"Team C",side_b:"Team D",sport:"eSports CS2",competition:"Rehearsal CS2 Cup",primary_market:true,market_class:"primary_h2h",start_state:"future_or_upcoming",price_state:"priced",market_choices:[{name:"Team C",odds:1.82,bettable:true},{name:"Team D",odds:1.98,bettable:true}],source_url:"https://example.invalid/rehearsal/cs2/2"}
];
const ids=events.map(e=>e.event_id);
const categories=["Football","CS2 eSports"];
const analysisCardIds=events.map(e=>"bc-"+sha("analysis:"+e.event_id));
const invDigest=sha(JSON.stringify(events));
const screeningDigest=sha(ids.slice().sort().join("|"));
const auditDigest=sha("audit:"+invDigest);

const legacy={
  schema_version:1,source:"rehearsal legacy",source_url:"https://example.invalid/rehearsal/legacy",checked_at:LEGACY_CHECKED,
  complete:true,analysis_ready:true,menu_end_verified:true,category_count:1,event_count:2,event_ids:ids.slice(0,2),screening_event_count:2,screening_event_ids:ids.slice(0,2),
  self_audit:{status:"pass",unresolved_blockers:0,blockers:[]}
};
const fixed={
  schema_version:1,source:"rehearsal fixed",source_url:"https://example.invalid/rehearsal/fixed",checked_at:FIXED_CHECKED,
  complete:true,analysis_ready:true,menu_end_verified:true,access_status:"direct",source_machine:"japan_vps_linux",source_region:"JP",source_region_evidence:"cloudflare_trace:JP",
  category_count:1,category_keys:["CS2 eSports"],event_count:2,event_ids:ids.slice(2),screening_event_count:2,screening_event_ids:ids.slice(2),
  menu_route_count:3,menu_routes:["/","/esports","/esports/cs2"],visited_route_count:3,visited_routes:["/","/esports","/esports/cs2"],
  self_audit:{status:"pass",unresolved_blockers:0,blockers:[]}
};
const complete={
  schema_version:1,source:"RMC FULL SCHEDULED REHEARSAL union",source_url:"https://example.invalid/rehearsal/union",
  checked_at:LEGACY_CHECKED,generated_at:"2026-09-28T05:41:00+09:00",menu_end_verified:true,
  category_count:categories.length,category_keys:categories,event_count:events.length,event_ids:ids,
  failed_category_count:0,metadata_missing_count:0,time_parse_missing_count:0,complete:true,analysis_ready:true,
  inventory_digest:invDigest,analysis_card_count:analysisCardIds.length,analysis_card_ids:analysisCardIds,
  bettable_analysis_card_count:analysisCardIds.length,unavailable_price_card_count:0,
  screening_event_count:ids.length,screening_event_ids:ids,priority_12h_event_count:ids.length,priority_12h_event_ids:ids,screening_digest:screeningDigest,
  component_status:{
    legacy:{checked_at:LEGACY_CHECKED,complete:true,event_count:2,screening_event_count:2},
    fixed_odds:{checked_at:FIXED_CHECKED,complete:true,event_count:2,screening_event_count:2,source_machine:"japan_vps_linux"}
  },
  self_audit:{status:"pass",digest:auditDigest,anomaly_count:0,blocker_count:0,warning_count:0,remediation_status:"not_required",fixes_applied:[],checks_run:["legacy_complete","fixed_odds_complete","menu_end_verified","event_id_union_unique","screening_union_unique","component_freshness_checked_by_production_gate","analysis_card_union"],requires_rescan:false,unresolved_blockers:0,blockers:[],warnings:[]},
  integrity:{digest:invDigest,screening_digest:screeningDigest,event_count_matches_ids:true,screening_event_count_matches_ids:true,category_keys_complete:true,priority_12h_is_subset:true},
  stats:{priced_event_count:4,unpriced_event_count:0,primary_h2h_count:4,fixed_odds_event_count:2,legacy_screening_event_count:2},
  events
};
write(path.join(DATA,"bet-channel-inventory.json"),legacy);
write(path.join(DATA,"bet-channel-fixed-odds-inventory.json"),fixed);
write(path.join(DATA,"bet-channel-complete-summary.json"),complete);

const detail=e=>({
  summary:`Full scheduled rehearsal deep dive for ${e.side_a} vs ${e.side_b}`,
  h2h:{status:"checked",summary:"Rehearsal fixture contains one verified H2H row.",items:[{date:"2026-09-01",label:`${e.side_a} vs ${e.side_b}`,result:"2-1",note:"synthetic rehearsal evidence"}]},
  recent_form:{status:"checked",side_a:{label:e.side_a,summary:"Last 6 fixture form checked.",items:[{date:"2026-09-20",opponent:"Common Opponent X",result:"W",competition:"Rehearsal Form"}]},side_b:{label:e.side_b,summary:"Last 6 fixture form checked.",items:[{date:"2026-09-19",opponent:"Common Opponent X",result:"L",competition:"Rehearsal Form"}]}},
  common_opponent_comparison:{status:"checked",summary:"Both sides faced Common Opponent X in the recent-form window; relative performance compared.",items:[{opponent:"Common Opponent X",side_a:{date:"2026-09-20",result:"W",performance:e.category.includes("CS2")?"2-0 maps":"3-0 score / +3 margin",competition:"Rehearsal Form",venue_context:e.category.includes("CS2")?"online":"home"},side_b:{date:"2026-09-19",result:"L",performance:e.category.includes("CS2")?"1-2 maps":"1-2 score / -1 margin",competition:"Rehearsal Form",venue_context:e.category.includes("CS2")?"online":"away"},comparison:e.category.includes("CS2")?"Side A had +3 map-difference advantage versus the same opponent.":"Side A produced a +4 goal-difference swing versus the same opponent."}]},
  ranking_or_rating:{status:"checked",text:"Synthetic rehearsal ranking/rating evidence present."},
  home_away:{status:"checked",text:e.category.includes("CS2")?"Online neutral server / side context checked.":"Home/away venue split checked."},
  availability:{status:"checked",text:e.category.includes("CS2")?"Roster and stand-in status checked.":"Starting lineup/injury availability checked."},
  market:{status:"checked",text:`Exact rehearsal market odds: ${e.market_choices.map(x=>x.name+" "+x.odds).join(" / ")}`},
  sport_specific:{status:"checked",text:e.category.includes("CS2")?"BO3, map pool, veto order, patch version, roster changes, LAN/online and map-side splits checked.":"Football xG, goal difference, set-piece and schedule-rest context checked."},
  rationale:{why:["Independent system-specific deep dive completed","Market and performance evidence cross-checked"],risks:["Synthetic fixture only; no production recommendation is created"],conclusion:"rehearsal_only"},
  missing_information:[]
});
const systemNames=["recommendations","value1","value2","pro_edge"];
const prefixes={recommendations:"rec",value1:"v1",value2:"v2",pro_edge:"pe"};
const coverageSystems={};
const systems={};
for(const system of systemNames){
  const deep=events.map((e,i)=>({
    event_id:e.event_id,
    source_urls:[e.source_url,"https://example.invalid/rehearsal/cross-market"],
    checks:{h2h:"checked",recent_form:"checked",common_opponent_comparison:"checked",ranking_or_rating:"checked",availability:"checked",market_odds:"checked",sport_specific:"checked",market_crosscheck:"checked"},
    outcome:i===0?"candidate":i===1?"watch":"reject",
    note:`${system} independent rehearsal analysis`,
    analysis_detail:detail(e)
  }));
  coverageSystems[system]={
    target_sports:2,scanned_sports:2,unscanned_sports:0,zero_card_sports:0,unavailable_sports:0,
    cards_checked:4,competitions_checked:2,deep_dived:4,accepted:1,watch:1,rejected:2,
    scanned_sport_names:categories,unscanned_sport_names:[],card_ids:ids,
    sport_card_counts:{"Football":2,"CS2 eSports":2},
    screening_evidence:ids.map(id=>({event_id:id,screen_decision:"deep_dive",reason_codes:[`${system}_independent_full_screen`],note:"full scheduled rehearsal"})),
    deep_dive_evidence:deep
  };
  systems[system]={discovery_runs:[{run_id:`${prefixes[system]}-${RUN_ID}-rehearsal`,started_at:GENERATED_AT,slot:SLOT,note:"Full scheduled rehearsal; independent complete-union scan."}],new_picks:[]};
}

const {datasets}=loadDatasets(DATA);
const vm=buildViewModel(datasets,{proEdgeConfig:loadProEdgeConfig(),now:GENERATED_AT});
const overdue=new Set();
for(const s of ["recommendations","experience","value1","value2","pro_edge"]){
  for(const r of vm[s]?.rows??[]){
    const st=Date.parse(r.match?.start_at||"");
    if(r.settlement?.state==="pending"&&Number.isFinite(st)&&st<=Date.parse(GENERATED_AT))overdue.add(String(r.match.id));
  }
}
const existing={};
for(const s of ["recommendations","experience","value1","value2","pro_edge"])existing[s]=(datasets[s]?.picks??[]).map(x=>String(x.id));
const resultChecks=[...overdue].map(id=>({match_id:id,status:"unresolved",source_priority:"unresolved",source_urls:[`https://example.invalid/rehearsal/result/${encodeURIComponent(id)}`],verified_at:"2026-09-28T05:59:00+09:00",identity_ok:true,note:"Synthetic full-scheduled rehearsal: source/identity contract exercised; production must use real result source."}));

const aux=name=>({checked_at:"2026-09-28T05:55:00+09:00",source_urls:[`https://example.invalid/rehearsal/${name}`],menu_end_verified:false,category_count:0,event_count:0,access_status:"unavailable",note:"Synthetic rehearsal explicitly records an unavailable supplementary source.",event_ids:[]});
const payload={
  payload_version:1,run_id:RUN_ID,source:"RMC full scheduled pre-VPS rehearsal",generated_at:GENERATED_AT,slot:SLOT,
  note:"Isolated synthetic rehearsal. Exercises production validator/41-check/public verifier without modifying production data.",
  systems,
  coverage_audit:{
    coverage_scope:"bet_channel_only",
    sportsbook_master:{
      bet_channel:categories,bet365:[],casitabi:[],yuugado:[],union_sports:categories,unavailable_sources:["bet365","casitabi","yuugado"],mode:"bet_channel_only",
      source_audit:{
        bet_channel:{checked_at:complete.checked_at,source_urls:[complete.source_url],menu_end_verified:true,category_count:2,event_count:4,access_status:"direct",note:"synthetic complete union",event_ids:ids,inventory_digest:invDigest,analysis_ready:true,analysis_card_count:4,analysis_card_ids:analysisCardIds,bettable_analysis_card_count:4,unavailable_price_card_count:0,screening_event_count:4,screening_event_ids:ids,screening_digest:screeningDigest},
        bet365:aux("bet365"),casitabi:aux("casitabi"),yuugado:aux("yuugado")
      }
    },
    systems:coverageSystems,
    self_audit:{checked_at:complete.checked_at,inventory_status:"pass",inventory_self_audit_digest:auditDigest,anomalies_found:0,remediation_status:"not_required",fixes_applied:[],unresolved_blockers:0,checks_performed:complete.self_audit.checks_run,note:"synthetic union self-audit mirrored exactly"}
  },
  completion_audit:{
    existing_pick_ids_by_system:existing,
    result_checks:resultChecks,
    settlement_propagation_checked:true,
    exact_odds_checked:true,
    legacy_amount_missing_only:true,
    profit_recalculated:{recommendations:true,value1:true,value2:true,pro_edge:true},
    loss_reviews_checked:true,
    future_info_leakage_checked:true,
    locked_history_checked:true
  }
};
write(PAYLOAD_PATH,payload);

const dry=runUpdate({payloadText:JSON.stringify(payload),dataDir:DATA,now:"2026-09-28T06:02:00+09:00",apply:false,startSha:"1111111111111111111111111111111111111111",startedAt:"2026-09-28T06:00:00+09:00"});
write(REPORT_PATH,{ok:dry.ok,errors:dry.ledger.errors,warnings:dry.ledger.warnings,items:dry.ledger.items});
if(!dry.ok){
  console.error(JSON.stringify(dry.ledger.errors,null,2));
  throw new Error("production dry-run validator failed");
}

const db={schema_version:1,latest_run_id:null,runs:[]};
const checklist=ensure(db,{runId:RUN_ID,slot:SLOT,scheduledFor:SCHEDULED_FOR,source:"RMC full scheduled rehearsal",startSha:"1111111111111111111111111111111111111111"});
mark(checklist,1,"pass",`${RUN_ID} / ${SCHEDULED_FOR} / rehearsal-start-sha / prior_blockers none`);
inventoryPhase(checklist,TMP,SCHEDULED_FOR);
payloadPhase(checklist,PAYLOAD_PATH,REPORT_PATH,{root:TMP,dataDir:DATA});

const applied=runUpdate({payloadText:JSON.stringify(payload),dataDir:DATA,now:"2026-09-28T06:02:00+09:00",apply:true,startSha:"1111111111111111111111111111111111111111",startedAt:"2026-09-28T06:00:00+09:00"});
if(!applied.ok)throw new Error("isolated production apply failed: "+JSON.stringify(applied.ledger.errors));

run(process.execPath,["scripts/validate-data.js",DATA]);
const liveFiles=fs.readdirSync(path.join(ROOT,"tests","live")).filter(x=>x.endsWith(".test.js")).map(x=>path.join("tests","live",x));
run(process.execPath,["--test",...liveFiles],{env:{RMC_DATA_DIR:DATA}});
run(process.execPath,["scripts/snapshot-manifest.js","verify"]);
mark(checklist,37,"pass","production validator + validate-data + all live tests + snapshot verification PASS");
mark(checklist,38,"pass","isolated production apply completed with the same write boundary; real main push path is separately exercised by GitHub Actions");

// Build an isolated static site containing the exact post-apply data and current public code.
fs.mkdirSync(SITE,{recursive:true});
fs.cpSync(DATA,path.join(SITE,"data"),{recursive:true});
fs.cpSync(path.join(ROOT,"config"),path.join(SITE,"config"),{recursive:true});
fs.cpSync(path.join(ROOT,"lib"),path.join(SITE,"lib"),{recursive:true});
fs.copyFileSync(path.join(ROOT,"analysis-v2.js"),path.join(SITE,"analysis-v2.js"));
const port=18765;
const serverCode=`
const http=require("http"),fs=require("fs"),path=require("path");
const root=process.argv[1];
http.createServer((req,res)=>{try{
 const pathname=decodeURIComponent((req.url||"/").split("?")[0]);
 let p=path.normalize(path.join(root,pathname));
 if(!p.startsWith(path.normalize(root))){res.statusCode=403;return res.end("forbidden")}
 if(fs.statSync(p).isDirectory())p=path.join(p,"index.html");
 const b=fs.readFileSync(p);res.statusCode=200;res.end(b);
}catch(e){res.statusCode=404;res.end("not found")}}).listen(${port},"127.0.0.1");
`;
const srv=spawn(process.execPath,["-e",serverCode,SITE],{cwd:ROOT,stdio:"ignore"});
await new Promise(r=>setTimeout(r,500));
try{
  run(process.execPath,["scripts/verify-public-profit.mjs","--base",`http://127.0.0.1:${port}`,"--run-id",RUN_ID,"--payload",PAYLOAD_PATH]);
}finally{srv.kill("SIGTERM")}
mark(checklist,39,"pass","same public HTTP verifier passed against isolated post-apply site: profit/exact-odds/payout/system-analysis checks");
const sys=JSON.parse(fs.readFileSync(path.join(DATA,"system-analysis.json"),"utf8"));
const expectedCats=categories.slice().sort();
const publicSystemsOk=systemNames.every(s=>JSON.stringify((sys.systems?.[s]?.sport_coverage??[]).map(x=>x.category_key).sort())===JSON.stringify(expectedCats));
if(!publicSystemsOk)throw new Error("system-analysis does not expose both real-sport and eSports categories for all systems");
mark(checklist,40,"pass","isolated public system-analysis exposes Football + CS2 eSports for ①〜④");
checklist.end_sha="2222222222222222222222222222222222222222";
finish(checklist,true,"full pre-VPS scheduled rehearsal");
write(CHECKLIST_PATH,db);
if(checklist.status!=="passed"||checklist.summary.pass!==41)throw new Error("41-check rehearsal did not reach 41/41: "+JSON.stringify(checklist.summary));

console.log("\nFULL_SCHEDULED_REHEARSAL_PASS");
console.log(JSON.stringify({run_id:RUN_ID,status:checklist.status,summary:checklist.summary,overdue_result_checks:resultChecks.length,categories,events:ids.length,production_dry_run:dry.ok,production_apply:applied.ok,public_verifier:"pass"},null,2));
