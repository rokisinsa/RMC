import fs from "node:fs";

const summaryPath=process.argv[2]||"data/bet-channel-screening-summary.json";
const outPath=process.argv[3]||"tmp/live-coverage-trial.json";
const s=JSON.parse(fs.readFileSync(summaryPath,"utf8"));

const jst=iso=>{
  const d=new Date(iso);
  const x=new Date(d.getTime()+9*3600e3).toISOString().replace("Z","+09:00");
  return x;
};
const generatedAt=jst(s.checked_at);
const stamp=generatedAt.replace(/[-:T+]/g,"").slice(0,12);
const runId=`live-coverage-${stamp}-${String(s.screening_digest||"none").slice(0,6)}`;
const cards=[...(s.screening_event_ids||[])].map(String);
const byId=new Map((s.events||[]).map(e=>[String(e.event_id),e]));
const categories=[...(s.category_keys||[])];
const counts=Object.fromEntries(categories.map(k=>[k,0]));
for(const id of cards){
  const e=byId.get(id);
  if(e && Object.prototype.hasOwnProperty.call(counts,e.category_key)) counts[e.category_key]++;
}
const competitionsChecked=Object.values(counts).filter(x=>x>0).length;
const zeroCardSports=Object.values(counts).filter(x=>x===0).length;

const reasons=(e,system)=>{
  const r=[];
  if(!e){r.push("event_metadata_missing");return {deep:false,r};}
  if(e.start_state!=="future_or_upcoming") r.push("start_time_passed_or_long_market");
  if(e.price_state!=="priced") r.push("price_unavailable");
  if(!["primary_h2h","h2h_or_two_way"].includes(e.market_class)) r.push("market_not_standard_h2h");
  const odds=(e.market_choices||[]).map(x=>x.odds).filter(x=>typeof x==="number"&&x>1);
  const fav=odds.length?Math.min(...odds):null;
  let deep=false;
  if(system==="recommendations"){
    deep=e.start_state==="future_or_upcoming"&&e.price_state==="priced"&&["primary_h2h","h2h_or_two_way"].includes(e.market_class)&&fav!=null&&fav<=1.50;
    if(!deep&&fav!=null&&fav>1.50) r.push("favorite_not_short_enough_for_gap_screen");
  }else if(system==="value1"){
    deep=e.start_state==="future_or_upcoming"&&e.price_state==="priced"&&["primary_h2h","h2h_or_two_way"].includes(e.market_class)&&odds.length>=2;
    if(!deep&&odds.length<2) r.push("insufficient_priced_outcomes_for_value");
  }else if(system==="value2"){
    deep=e.start_state==="future_or_upcoming"&&e.price_state==="priced"&&["primary_h2h","h2h_or_two_way"].includes(e.market_class)&&odds.length>=2;
    if(!deep&&odds.length<2) r.push("insufficient_market_baseline");
  }else{
    deep=e.start_state==="future_or_upcoming"&&e.price_state==="priced"&&["primary_h2h","h2h_or_two_way"].includes(e.market_class)&&odds.length>=2;
    if(!deep&&odds.length<2) r.push("insufficient_outcomes_for_novig");
  }
  if(deep) r.push("metadata_screen_pass");
  if(!r.length) r.push("screen_reject_rule");
  return {deep,r:[...new Set(r)]};
};

const prefixes={recommendations:"rec",value1:"v1",value2:"v2",pro_edge:"pe"};
const coverageSystems={};
const systems={};
for(const system of Object.keys(prefixes)){
  const evidence=cards.map(id=>{
    const x=reasons(byId.get(id),system);
    return {event_id:id,screen_decision:x.deep?"deep_dive":"screen_reject",reason_codes:x.r,note:"live coverage rehearsal: metadata-level first pass only"};
  });
  const deep=evidence.filter(x=>x.screen_decision==="deep_dive").length;
  coverageSystems[system]={
    target_sports:categories.length,
    scanned_sports:categories.length,
    unscanned_sports:0,
    zero_card_sports:zeroCardSports,
    unavailable_sports:0,
    cards_checked:cards.length,
    competitions_checked:competitionsChecked,
    deep_dived:deep,
    accepted:0,watch:0,rejected:0,
    scanned_sport_names:categories,
    unscanned_sport_names:[],
    card_ids:cards,
    sport_card_counts:counts,
    screening_evidence:evidence
  };
  systems[system]={
    discovery_runs:[{
      run_id:`${prefixes[system]}-${runId}`,
      started_at:generatedAt,
      slot:"12:00",
      note:"BET CHANNEL実掲載全eventを使うライブcoverage dry-run。候補の最終採否・本番pick追加は行わない。"
    }],
    new_picks:[]
  };
}
const payload={
  payload_version:1,
  run_id:runId,
  source:"RMC live BET CHANNEL coverage rehearsal",
  generated_at:generatedAt,
  slot:"12:00",
  note:"実BET CHANNEL全掲載eventを①〜④で独立一次走査した証跡を使うdry-run。production dataは変更しない。",
  systems,
  coverage_audit:{
    coverage_scope:"bet_channel_only",
    sportsbook_master:{
      bet_channel:categories,
      union_sports:categories,
      unavailable_sources:[],
      mode:"bet_channel_only",
      source_audit:{
        bet_channel:{
          checked_at:generatedAt,
          source_urls:[s.source_url||"https://bet-channel.com/matches?lang=ja"],
          menu_end_verified:s.menu_end_verified===true,
          category_count:s.category_count,
          event_count:s.event_count,
          access_status:"direct",
          event_ids:s.event_ids,
          note:"live compact summary",
          inventory_digest:s.inventory_digest,
          analysis_ready:s.analysis_ready===true,
          analysis_card_count:s.analysis_card_count,
          analysis_card_ids:s.analysis_card_ids,
          bettable_analysis_card_count:s.bettable_analysis_card_count,
          unavailable_price_card_count:s.unavailable_price_card_count,
          screening_event_count:s.screening_event_count,
          screening_event_ids:s.screening_event_ids,
          screening_digest:s.screening_digest
        }
      }
    },
    systems:coverageSystems,
    self_audit:{
      checked_at:generatedAt,
      inventory_status:s.self_audit?.status,
      inventory_self_audit_digest:s.self_audit?.digest,
      anomalies_found:s.self_audit?.anomaly_count??0,
      remediation_status:s.self_audit?.remediation_status??"unknown",
      fixes_applied:s.self_audit?.fixes_applied??[],
      unresolved_blockers:s.self_audit?.unresolved_blockers??0,
      checks_performed:s.self_audit?.checks_run??["live_summary_present"],
      note:"live inventory self-audit mirrored into rehearsal payload"
    }
  }
};

fs.mkdirSync(outPath.split("/").slice(0,-1).join("/")||".",{recursive:true});
fs.writeFileSync(outPath,JSON.stringify(payload,null,2)+"\n");
console.log(JSON.stringify({
  run_id:runId,
  category_count:categories.length,
  cards_checked:cards.length,
  systems:Object.fromEntries(Object.entries(coverageSystems).map(([k,v])=>[k,{cards_checked:v.cards_checked,evidence:v.screening_evidence.length,deep_dived:v.deep_dived}])),
  self_audit:payload.coverage_audit.self_audit
},null,2));
