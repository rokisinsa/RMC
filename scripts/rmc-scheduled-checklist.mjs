#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatasets, loadProEdgeConfig } from "./load-node.js";
import { buildViewModel } from "../lib/view/model.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const DEFAULT_FILE=path.join(ROOT,"data","scheduled-update-checklist.json");
const SLOTS=["06:00","12:00","18:00","23:00"];
const SYSTEMS=["recommendations","value1","value2","pro_edge"];
const TITLES=[
"run_id・開始JST・開始SHA・前回blocker記録",
"BET CHANNEL通常スポーツをメニュー終端まで完全取得",
"BET CHANNEL fixed-odds/eSportsをJP許可ノードから完全取得",
"eSportsメニュー/ルートを再帰全巡回し未訪問0",
"通常＋eSports complete union成立",
"inventory freshness（通常45分/eSports55分）",
"カジ旅・bet365・優雅堂の補助確認または取得不能理由",
"全リアルスポーツを対象化",
"全eSportsタイトルを対象化",
"①推奨が完全screening全件を独立一次走査",
"②VALUE①が完全screening全件を独立一次走査",
"③VALUE②が完全screening全件を独立一次走査",
"④PRO EDGEが完全screening全件を独立一次走査",
"①〜④ card_idsが完全母集団と一致",
"競技/タイトル別sport coverage監査",
"各priced 24h競技/タイトルのdeep dive実施",
"priced_upcoming>0でdeep_dive=0を禁止",
"候補数上限なし・全件証跡保持",
"各カードに具体的reason_codes",
"deep dive完全項目（H2H/直近/rating/roster/市場/EV等）",
"eSports固有deep dive（BO/map/veto/patch/roster/LAN等）",
"deep_dive対象IDとdeep_dive_evidence ID完全一致",
"②③④ candidate/watchの外部市場cross-check",
"既存①〜④＋経験値の全カード結果再照合",
"結果ソース優先順位と根拠記録",
"日付/JST/大会/対戦相手identity照合",
"同一match_idの全系統同時精算",
"新規正式採用exact odds/取得時刻/stake固定",
"旧移行カードだけamount_missing許可・推測補完禁止",
"①戦績/投入/損益/ROI/pending/複利/1/4 Kelly再計算",
"②VALUE①戦績/投入/損益/ROI/pending再計算",
"③VALUE②戦績/投入/損益/ROI/pending再計算",
"④PRO EDGE戦績/投入/損益/ROI/CLV/pending再計算",
"新規敗戦post-match review完備",
"future-info leakage 0",
"locked/baseline/snapshot/history保護",
"schema/duplicate/independence/JST/profit/CLV等全tests PASS",
"GitHub main commit/push・競合再検証",
"Pages公開＋公開収支/exact odds/払戻し再計算一致",
"公開RMCに通常＋eSports両方の最新分析/採否理由表示",
"1〜40全PASSの最終報告"
];
const arg=n=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:null};
const has=n=>process.argv.includes(n);
const nowIso=()=>new Date(Date.now()+9*3600e3).toISOString().replace(/\.\d{3}Z$/,"+09:00");
const readJson=p=>JSON.parse(fs.readFileSync(p,"utf8"));
const maybe=p=>{try{return readJson(p)}catch{return null}};
const setEq=(a,b)=>{a=[...new Set((a||[]).map(String))].sort();b=[...new Set((b||[]).map(String))].sort();return JSON.stringify(a)===JSON.stringify(b)};
const arr=x=>Array.isArray(x)?x:[];
const scheduled=s=>SLOTS.includes(s);
function emptyDb(){return {schema_version:1,latest_run_id:null,runs:[]}}
function load(file){return fs.existsSync(file)?readJson(file):emptyDb()}
function save(file,db){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(db,null,2)+"\n")}
function summary(run){
  const s={pass:0,fail:0,blocked:0,pending:0,total:41};
  for(const c of run.checks)s[c.status]++;
  return s;
}
function recompute(run){
  run.summary=summary(run);
  if(run.checks[40].status==="pass"&&run.summary.pass===41)run.status="passed";
  else if(run.checks.some(c=>c.status==="fail"))run.status="failed";
  else if(run.checks.some(c=>c.status==="blocked"))run.status="blocked";
  else run.status="running";
  run.updated_at=nowIso();
}
function ensure(db,{runId,slot,scheduledFor,source,startSha}){
  const m=String(runId||"").match(/^rmc-(\d{4})(\d{2})(\d{2})-(0600|1200|1800|2300)$/);
  if(m){
    slot ||= m[4].slice(0,2)+":"+m[4].slice(2);
    scheduledFor ||= `${m[1]}-${m[2]}-${m[3]}T${m[4].slice(0,2)}:${m[4].slice(2)}:00+09:00`;
  }
  let r=db.runs.find(x=>x.run_id===runId);
  if(!r){
    const previous=db.runs.at(-1)??null;
    r={run_id:runId,slot:slot||null,scheduled_for:scheduledFor||null,started_at:nowIso(),finished_at:null,source:source||"RMC scheduled update",start_sha:startSha||null,end_sha:null,status:"running",prior_blockers:[...(previous?.blockers||[])],blockers:[],checks:TITLES.map((title,i)=>({id:i+1,title,status:"pending",detail:null,checked_at:null})),summary:{pass:0,fail:0,blocked:0,pending:41,total:41}};
    db.runs.push(r);
  }else{
    if(slot)r.slot=slot;if(scheduledFor)r.scheduled_for=scheduledFor;if(source)r.source=source;if(startSha&&!r.start_sha)r.start_sha=startSha;
    if(!Array.isArray(r.prior_blockers))r.prior_blockers=[];
  }
  db.latest_run_id=runId;
  db.runs=db.runs.slice(-40);
  return r;
}
function mark(run,id,status,detail){
  const c=run.checks[id-1]; if(!c)throw new Error("unknown check "+id);
  c.status=status;c.detail=detail||null;c.checked_at=nowIso();
  recompute(run);
}
function blockPending(run,reason){
  for(const c of run.checks.slice(0,40))if(c.status==="pending"){c.status="blocked";c.detail=reason;c.checked_at=nowIso()}
  recompute(run);
}
function inferNextSlot(d=new Date()){
  const ms=d.getTime();
  const j=new Date(ms+9*3600e3);
  const y=j.getUTCFullYear(),m=j.getUTCMonth(),day=j.getUTCDate();
  const candidates=[];
  for(const dd of [-1,0,1]){
    const base=new Date(Date.UTC(y,m,day+dd,0,0,0));
    const by=base.getUTCFullYear(),bm=base.getUTCMonth(),bd=base.getUTCDate();
    for(const sh of [6,12,18,23]){
      const utc=Date.UTC(by,bm,bd,sh-9,0,0);
      const localDate=`${by}-${String(bm+1).padStart(2,"0")}-${String(bd).padStart(2,"0")}`;
      candidates.push({ms:utc,slot:String(sh).padStart(2,"0")+":00",scheduledFor:`${localDate}T${String(sh).padStart(2,"0")}:00:00+09:00`,runId:`rmc-${localDate.replaceAll("-","")}-${String(sh).padStart(2,"0")}00`});
    }
  }
  const nearest=[...candidates].sort((a,b)=>Math.abs(a.ms-ms)-Math.abs(b.ms-ms))[0];
  if(nearest && Math.abs(nearest.ms-ms)<=120*60000) return nearest;
  return null;
}
function ageMinutes(ref,ts){return (Date.parse(ref)-Date.parse(ts))/60000}
function inventoryPhase(run,root=ROOT,refTime=null){
  const complete=maybe(path.join(root,"data","bet-channel-complete-summary.json"));
  const legacy=maybe(path.join(root,"data","bet-channel-inventory.json"));
  const fixed=maybe(path.join(root,"data","bet-channel-fixed-odds-inventory.json"));
  const ref=refTime||run.scheduled_for||nowIso();
  const legacyOk=!!legacy&&legacy.complete===true&&legacy.analysis_ready===true&&legacy.menu_end_verified===true&&(legacy.self_audit?.unresolved_blockers??1)===0&&legacy.event_count>0;
  mark(run,2,legacyOk?"pass":"fail",legacyOk?`legacy complete: ${legacy.category_count} categories / ${legacy.event_count} events / ${legacy.screening_event_count} screening`:"legacy inventory incomplete/missing");
  const fixedOk=!!fixed&&fixed.complete===true&&fixed.analysis_ready===true&&fixed.access_status==="direct"&&fixed.source_region==="JP"&&["japan_vps_linux","japan_local_windows"].includes(fixed.source_machine)&&fixed.event_count===arr(fixed.event_ids).length&&fixed.screening_event_count===arr(fixed.screening_event_ids).length&&(fixed.self_audit?.unresolved_blockers??1)===0;
  mark(run,3,fixedOk?"pass":"fail",fixedOk?`JP ${fixed.source_machine}: ${fixed.event_count} events / ${fixed.screening_event_count} screening`:"JP fixed-odds/eSports inventory incomplete/missing");
  const routesOk=fixedOk&&fixed.menu_end_verified===true&&Number(fixed.menu_route_count)>0&&fixed.menu_route_count===fixed.visited_route_count&&setEq(fixed.menu_routes,fixed.visited_routes);
  mark(run,4,routesOk?"pass":"fail",routesOk?`recursive routes ${fixed.visited_route_count}/${fixed.menu_route_count}, unvisited 0`:"eSports recursive menu exhaustion not proven");
  const unionOk=!!complete&&complete.complete===true&&complete.analysis_ready===true&&complete.menu_end_verified===true&&(complete.self_audit?.unresolved_blockers??1)===0&&complete.event_count>0&&complete.screening_event_count>0;
  mark(run,5,unionOk?"pass":"fail",unionOk?`union complete: ${complete.category_count} categories / ${complete.event_count} events / ${complete.screening_event_count} screening`:`union incomplete: ${arr(complete?.self_audit?.blockers).join(",")||"missing"}`);
  const la=legacy?.checked_at?ageMinutes(ref,legacy.checked_at):Infinity, fa=fixed?.checked_at?ageMinutes(ref,fixed.checked_at):Infinity;
  const fresh=legacyOk&&fixedOk&&la>=-10&&la<=45&&fa>=-10&&fa<=55;
  mark(run,6,fresh?"pass":"fail",`at ${ref}: legacy age ${Number.isFinite(la)?la.toFixed(1):"∞"}m / fixed age ${Number.isFinite(fa)?fa.toFixed(1):"∞"}m`);
  mark(run,8,legacyOk?"pass":"fail",legacyOk?`all listed real-sports menu categories captured (${legacy.category_count})`:"real-sports inventory not complete");
  const espOk=fixedOk&&fixed.event_count>0&&arr(fixed.category_keys).length>0;
  mark(run,9,espOk?"pass":"fail",espOk?`all discovered eSports titles/categories captured (${fixed.category_count||fixed.category_keys.length})`:"eSports titles inventory is zero/incomplete");
  run.blockers=[...new Set(arr(complete?.self_audit?.blockers))];
  recompute(run);
}
function detailOk(d){
  const a=d?.analysis_detail;
  return !!a&&arr(d.source_urls).length>0&&a.h2h&&a.recent_form&&a.ranking_or_rating&&a.home_away&&a.availability&&a.market&&a.sport_specific&&a.rationale&&arr(a.rationale.why).length>0&&Array.isArray(a.rationale.risks)&&a.rationale.conclusion&&Array.isArray(a.missing_information);
}
function sourceAuditOk(a){
  if(!a||!a.checked_at||!arr(a.source_urls).length||!a.access_status)return false;
  if(a.access_status==="unavailable"||a.access_status==="partial")return !!String(a.note||"").trim();
  return a.menu_end_verified===true&&Number.isInteger(a.event_count)&&arr(a.event_ids).length===a.event_count;
}
function payloadPhase(run,payloadPath,reportPath){
  const p=readJson(payloadPath), report=reportPath&&fs.existsSync(reportPath)?readJson(reportPath):null;
  const complete=maybe(path.join(ROOT,"data","bet-channel-complete-summary.json"));
  const master=arr(complete?.screening_event_ids).map(String);
  const ca=p.coverage_audit, sys=ca?.systems||{}, sourceAudit=ca?.sportsbook_master?.source_audit||{};
  const supp=["casitabi","bet365","yuugado"];
  const c7=supp.every(k=>sourceAuditOk(sourceAudit[k]));
  mark(run,7,c7?"pass":"fail",c7?"3 supplementary books checked or explicit unavailable reasons recorded":"casitabi/bet365/yuugado source_audit incomplete");

  let allCards=true;
  SYSTEMS.forEach((s,idx)=>{
    const x=sys[s], ownRuns=arr(p.systems?.[s]?.discovery_runs);
    const ok=!!x&&setEq(x.card_ids,master)&&x.cards_checked===master.length&&arr(x.screening_evidence).length===master.length&&ownRuns.length>0;
    mark(run,10+idx,ok?"pass":"fail",ok?`${s}: ${master.length}/${master.length} independently screened`:`${s}: full independent screening evidence mismatch`);
    allCards&&=ok;
  });
  mark(run,14,allCards?"pass":"fail",allCards?`all four card_id sets exactly equal ${master.length} screening IDs`:"one or more systems differ from complete screening universe");

  const cats=arr(complete?.category_keys).map(String);
  const coverageOk=SYSTEMS.every(s=>{const x=sys[s];const keys=Object.keys(x?.sport_card_counts||{});return cats.every(k=>keys.includes(k))&&keys.length===cats.length&&Object.values(x.sport_card_counts).reduce((a,b)=>a+Number(b||0),0)===x.cards_checked});
  mark(run,15,coverageOk?"pass":"fail",coverageOk?`sport/title coverage present for all ${cats.length} categories`:"sport_card_counts incomplete/mismatched");

  const events=arr(complete?.events), gen=Date.parse(p.generated_at);
  const eligibleByCat=new Map();
  for(const e of events){
    const st=Date.parse(e.start_at_jst||e.start_at||"");
    const priced=e.price_state==="priced"||arr(e.market_choices).some(q=>typeof q.odds==="number"&&q.bettable!==false&&q.is_valid_bet!==false);
    const h2h=["primary_h2h","h2h_or_two_way"].includes(e.market_class)||e.primary_market===true;
    const upcoming=e.start_state==="future_or_upcoming"||(!["start_time_passed","ended","cancelled","postponed"].includes(e.start_state)&&st>=gen);
    if(Number.isFinite(st)&&st>=gen&&st<=gen+86400000&&priced&&h2h&&upcoming){
      const k=String(e.category_key||e.category||"unknown");if(!eligibleByCat.has(k))eligibleByCat.set(k,[]);eligibleByCat.get(k).push(String(e.event_id));
    }
  }
  let deepOk=true,zeroOk=true;
  for(const s of SYSTEMS){
    const deep=arr(sys[s]?.deep_dive_evidence).map(x=>String(x.event_id));
    for(const [k,ids] of eligibleByCat){
      const n=ids.filter(id=>deep.includes(id)).length;
      const need=Math.min(3,ids.length);
      if(n<need)deepOk=false;
      if(n===0)zeroOk=false;
    }
  }
  mark(run,16,deepOk?"pass":"fail",deepOk?`each eligible category deep-dived up to 3 events across all four systems`:"one or more eligible categories lacks required deep dives");
  mark(run,17,zeroOk?"pass":"fail",zeroOk?"no priced-upcoming eligible category has deep_dive=0":"priced-upcoming category with zero deep dive detected");

  const noCap=SYSTEMS.every(s=>arr(sys[s]?.screening_evidence).length===master.length&&arr(sys[s]?.card_ids).length===master.length);
  mark(run,18,noCap?"pass":"fail",noCap?"full-universe evidence retained; no runtime truncation":"screening evidence truncated");
  const reasonsOk=SYSTEMS.every(s=>arr(sys[s]?.screening_evidence).every(e=>e.screen_decision==="deep_dive"||arr(e.reason_codes).length>0));
  mark(run,19,reasonsOk?"pass":"fail",reasonsOk?"all non-deep cards carry concrete reason_codes":"abstract/missing reject reason detected");
  const d20=SYSTEMS.every(s=>arr(sys[s]?.deep_dive_evidence).every(detailOk));
  mark(run,20,d20?"pass":"fail",d20?"all deep-dive evidence has structured complete fields/source URLs":"deep-dive structured evidence missing");

  const esportRe=/esport|eスポ|cs2|counter.?strike|valorant|dota|league of legends|\blol\b|rainbow six|efootball|esoccer|ebasket|nba.?2k|ecricket|etennis|efighting|rocket league|overwatch|pubg|mobile legends/i;
  const eids=new Set(events.filter(e=>esportRe.test(`${e.category||""} ${e.category_key||""} ${e.sport||""} ${e.title||""}`)).map(e=>String(e.event_id)));
  let espDeep=true, espCount=0;
  for(const s of SYSTEMS)for(const d of arr(sys[s]?.deep_dive_evidence).filter(d=>eids.has(String(d.event_id)))){
    espCount++;const txt=JSON.stringify(d.analysis_detail?.sport_specific||{})+" "+arr(d.analysis_detail?.missing_information).join(" ");
    if(!/(bo\d|map|veto|patch|roster|lan|online|マップ|ロスター|パッチ|取得できず|unavailable)/i.test(txt))espDeep=false;
  }
  const eligibleIds=new Set([...eligibleByCat.values()].flat());
  const eligibleEsports=[...eids].filter(id=>eligibleIds.has(id));
  if(eligibleEsports.length>0&&espCount===0)espDeep=false;
  mark(run,21,espDeep?"pass":"fail",espDeep?`eSports-specific evidence recorded for ${espCount} deep dives; eligible eSports events=${eligibleEsports.length}`:"eligible eSports deep-dive specific evidence missing");

  const idsOk=SYSTEMS.every(s=>setEq(arr(sys[s]?.screening_evidence).filter(x=>x.screen_decision==="deep_dive").map(x=>x.event_id),arr(sys[s]?.deep_dive_evidence).map(x=>x.event_id)));
  mark(run,22,idsOk?"pass":"fail",idsOk?"deep-dive target IDs exactly match proof IDs":"deep-dive target/proof ID mismatch");
  const crossOk=["value1","value2","pro_edge"].every(s=>arr(sys[s]?.deep_dive_evidence).filter(d=>["candidate","watch"].includes(d.outcome)).every(d=>d.checks?.market_crosscheck==="checked"));
  mark(run,23,crossOk?"pass":"fail",crossOk?"②③④ candidate/watch external market cross-check complete":"candidate/watch market cross-check missing");

  const comp=p.completion_audit;
  const {datasets}=loadDatasets();
  const expected={};
  for(const s of ["recommendations","experience","value1","value2","pro_edge"])expected[s]=arr(datasets[s]?.picks).map(x=>String(x.id));
  const checked=comp?.existing_pick_ids_by_system||{};
  const allExisting=Object.keys(expected).every(s=>setEq(checked[s],expected[s]));
  mark(run,24,allExisting?"pass":"fail",allExisting?"all existing pick IDs rechecked in every system":"existing-card result recheck set incomplete");

  const cfg=loadProEdgeConfig();
  const vm=buildViewModel(datasets,{proEdgeConfig:cfg,now:p.generated_at});
  const overdue=new Set();
  for(const s of ["recommendations","experience","value1","value2","pro_edge"])for(const r of arr(vm[s]?.rows)){
    const st=Date.parse(r.match?.start_at||""); if(r.settlement?.state==="pending"&&Number.isFinite(st)&&st<=gen)overdue.add(String(r.match.id));
  }
  const resultChecks=arr(comp?.result_checks), checkedMids=resultChecks.map(x=>String(x.match_id));
  const rcOk=setEq(checkedMids,[...overdue])&&resultChecks.every(x=>x.status&&arr(x.source_urls).length>0&&x.verified_at);
  mark(run,25,rcOk?"pass":"fail",rcOk?`all ${overdue.size} overdue pending matches checked with source evidence`:`result source evidence incomplete (${checkedMids.length}/${overdue.size})`);
  const idOk=rcOk&&resultChecks.every(x=>x.identity_ok===true);
  mark(run,26,idOk?"pass":"fail",idOk?"date/JST/competition/opponent identity confirmed for every result check":"identity confirmation missing");

  const reportOk=report?.ok===true;
  mark(run,27,reportOk&&comp?.settlement_propagation_checked===true?"pass":"fail",reportOk?"production validator confirms same-match propagation":"settlement propagation not proven");
  mark(run,28,reportOk&&comp?.exact_odds_checked===true?"pass":"fail",reportOk?"formal picks exact odds/stake/time gate passed":"exact-odds evidence not proven");
  mark(run,29,reportOk&&comp?.legacy_amount_missing_only===true?"pass":"fail",reportOk?"amount_missing restricted to legacy evidence gaps":"legacy-only amount_missing assertion missing");

  const pr=comp?.profit_recalculated||{};
  mark(run,30,reportOk&&pr.recommendations===true?"pass":"fail","① profit/ROI/compound/quarter-Kelly recalculation evidence");
  mark(run,31,reportOk&&pr.value1===true?"pass":"fail","② VALUE① recalculation evidence");
  mark(run,32,reportOk&&pr.value2===true?"pass":"fail","③ VALUE② recalculation evidence");
  mark(run,33,reportOk&&pr.pro_edge===true?"pass":"fail","④ PRO EDGE/CLV recalculation evidence");
  mark(run,34,reportOk&&comp?.loss_reviews_checked===true?"pass":"fail",reportOk?"new losses require complete post-match reviews":"loss-review completeness not proven");
  mark(run,35,reportOk&&comp?.future_info_leakage_checked===true?"pass":"fail",reportOk?"future-info leakage gate passed":"future-info audit not proven");
  mark(run,36,reportOk&&comp?.locked_history_checked===true?"pass":"fail",reportOk?"locked/baseline/snapshot/history protection gate passed":"locked/history audit not proven");
  if(!reportOk) run.blockers=[...new Set([...(run.blockers||[]),"production_validator_failed"])];
  else run.blockers=(run.blockers||[]).filter(x=>x!=="production_validator_failed");
  recompute(run);
}
function phase(run,name,detail){
  const map={tests:37,commit:38,pages:39,public:40};const id=map[name];if(!id)throw new Error("unknown phase "+name);mark(run,id,"pass",detail||name+" passed");
}
function finish(run,success,reason){
  if(success){
    const pending=run.checks.slice(0,40).filter(c=>c.status!=="pass");
    if(pending.length || (run.blockers||[]).length){mark(run,41,"fail",`cannot finalize: checks not passed: ${pending.map(c=>c.id).join(",")||"none"}; blockers: ${(run.blockers||[]).join(",")||"none"}`);run.status="failed"}
    else{mark(run,41,"pass","checks 1-40 all PASS; blockers 0; final report allowed");run.status="passed";run.finished_at=nowIso()}
  }else{
    const alreadyFailed=run.checks.slice(0,40).some(c=>c.status==="fail");
    if(!alreadyFailed){
      const first=run.checks.slice(0,40).find(c=>c.status==="pending");
      if(first)mark(run,first.id,"fail",reason||"workflow failed before this check completed");
    }
    blockPending(run,reason||"blocked by prior failure");
    mark(run,41,"fail",reason||"one or more checks failed/blocked");
    run.status="failed";run.finished_at=nowIso();
  }
  recompute(run);
}
function main(){
  const file=arg("--file")?path.resolve(ROOT,arg("--file")):DEFAULT_FILE;
  const db=load(file);
  let runId=arg("--run-id"),slot=arg("--slot"),scheduledFor=arg("--scheduled-for");
  if(has("--auto-next")){const x=inferNextSlot();if(!x)throw new Error("current time is outside the allowed scheduled-slot audit window");runId=x.runId;slot=x.slot;scheduledFor=x.scheduledFor}
  if(!runId)throw new Error("--run-id required (or --auto-next)");
  const run=ensure(db,{runId,slot,scheduledFor,source:arg("--source"),startSha:arg("--start-sha")});
  if(run.slot&&run.scheduled_for&&run.start_sha)mark(run,1,"pass",`${run.run_id} / ${run.scheduled_for} / start_sha ${run.start_sha} / prior_blockers ${(run.prior_blockers||[]).join(",")||"none"}`);
  else mark(run,1,"fail","run_id/slot/scheduled_for/start_sha evidence incomplete");
  if(has("--inventory"))inventoryPhase(run,ROOT,arg("--reference-time"));
  if(arg("--payload"))payloadPhase(run,path.resolve(ROOT,arg("--payload")),arg("--report")?path.resolve(ROOT,arg("--report")):null);
  if(arg("--phase"))phase(run,arg("--phase"),arg("--detail"));
  if(has("--success"))finish(run,true,arg("--detail"));
  if(has("--fail"))finish(run,false,arg("--detail"));
  if(arg("--end-sha"))run.end_sha=arg("--end-sha");
  recompute(run);save(file,db);
  console.log(JSON.stringify({file:path.relative(ROOT,file),run_id:run.run_id,status:run.status,summary:run.summary,blockers:run.blockers,checks:run.checks.map(c=>({id:c.id,status:c.status,detail:c.detail}))},null,2));
  if(has("--assert-pass")&&run.status!=="passed")process.exit(1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
export {TITLES,inferNextSlot,inventoryPhase,payloadPhase,ensure,mark,finish,recompute};
