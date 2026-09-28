import fs from "node:fs";

const summaryPath=process.argv[2]||"data/bet-channel-complete-summary.json";
const outPath=process.argv[3]||"tmp/live-coverage-trial.json";
const s=JSON.parse(fs.readFileSync(summaryPath,"utf8"));

const jst=iso=>{
  const d=new Date(iso);
  return new Date(d.getTime()+9*3600e3).toISOString().replace("Z","+09:00");
};
const generatedAt=jst(s.checked_at);
const runMs=Date.parse(generatedAt);
const stamp=generatedAt.replace(/[-:T+]/g,"").slice(0,12);
const runId=`live-coverage-${stamp}-${String(s.screening_digest||s.integrity?.screening_digest||"none").slice(0,6)}`;
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
const prioritySet=new Set((s.priority_12h_event_ids||[]).map(String));
const standardMarket=e=>["primary_h2h","h2h_or_two_way"].includes(e?.market_class)||e?.primary_market===true;
const priced=e=>e?.price_state==="priced"||(e?.market_choices||[]).some(x=>typeof x.odds==="number"&&x.bettable!==false);
const within24=e=>{
  const t=Date.parse(e?.start_at_jst||"");
  return Number.isFinite(t)&&Number.isFinite(runMs)&&t>=runMs&&t<=runMs+24*3600e3;
};
const eligible=e=>!!e&&e.start_state==="future_or_upcoming"&&priced(e)&&standardMarket(e)&&within24(e);

// Coverage rehearsal: every eligible priced/upcoming standard-H2H card must have deep-dive proof for every system.
// No per-category cap. If 7 cards qualify, all 7 must be deep-dived independently in ①〜④.
const eligibleByCategory=new Map();
for(const id of cards){
  const e=byId.get(id);
  if(!eligible(e)) continue;
  const k=e.category_key||e.category||"unknown";
  if(!eligibleByCategory.has(k)) eligibleByCategory.set(k,[]);
  eligibleByCategory.get(k).push(id);
}
const deepSet=new Set([...eligibleByCategory.values()].flatMap(ids=>ids));

const reasons=(e,system,id)=>{
  const r=[];
  if(!e){r.push("event_metadata_missing");return {deep:false,r};}
  if(!within24(e)) r.push("outside_24h_deep_dive_window");
  if(e.start_state!=="future_or_upcoming") r.push("not_future_upcoming");
  if(!priced(e)) r.push("price_unavailable");
  if(!standardMarket(e)) r.push("market_not_standard_h2h");
  const odds=(e.market_choices||[]).map(x=>x.odds).filter(x=>typeof x==="number"&&x>1);
  const fav=odds.length?Math.min(...odds):null;
  if(system==="recommendations" && fav!=null) r.push(`gap_screen_favorite_odds_${fav}`);
  if(system==="value1") r.push("value1_independent_probability_ev_screen");
  if(system==="value2") r.push("value2_market_clv_calibration_screen");
  if(system==="pro_edge") r.push("pro_edge_novig_base_expert_ev_screen");
  const deep=deepSet.has(String(id));
  if(deep) r.push("category_coverage_deep_dive_required");
  if(!r.length) r.push("screen_reject_rule");
  return {deep,r:[...new Set(r)]};
};

const analysisDetail=e=>({
  summary:"live coverage rehearsal: production handoff/gate validation only; external research is intentionally marked unavailable, never fabricated",
  h2h:{status:"unavailable",summary:"rehearsal does not fabricate H2H; production analysis must supply verified H2H or a source-backed unavailable reason",items:[]},
  recent_form:{
    status:"unavailable",
    side_a:{label:e?.side_a||"side_a",summary:"rehearsal does not fabricate recent form",items:[]},
    side_b:{label:e?.side_b||"side_b",summary:"rehearsal does not fabricate recent form",items:[]}
  },
  common_opponent_comparison:{status:"unavailable",summary:"common opponents cannot be compared because verified recent-form rows are intentionally unavailable in this CI rehearsal",items:[]},
  ranking_or_rating:{status:"unavailable",text:"rehearsal does not fabricate rankings/ratings"},
  home_away:{status:"unavailable",text:"rehearsal does not fabricate venue splits"},
  availability:{status:"unavailable",text:"rehearsal does not fabricate roster/availability"},
  market:{status:priced(e)?"checked":"unavailable",text:priced(e)?"inventory contains current published price metadata":"published price unavailable"},
  sport_specific:{status:"unavailable",text:"sport/title-specific external research is required in production"},
  rationale:{
    why:["eligible-category coverage gate exercised with the real current inventory"],
    risks:["external H2H/form/ranking/roster research is not performed by this CI rehearsal"],
    conclusion:"insufficient_data"
  },
  missing_information:["external-source H2H/form/common-opponent/ranking/availability/sport-specific evidence"]
});

const prefixes={recommendations:"rec",value1:"v1",value2:"v2",pro_edge:"pe"};
const coverageSystems={};
const systems={};
for(const system of Object.keys(prefixes)){
  const evidence=cards.map(id=>{
    const x=reasons(byId.get(id),system,id);
    return {event_id:id,screen_decision:x.deep?"deep_dive":"screen_reject",reason_codes:x.r,note:"live complete-union coverage rehearsal"};
  });
  const deepIds=evidence.filter(x=>x.screen_decision==="deep_dive").map(x=>x.event_id);
  coverageSystems[system]={
    target_sports:categories.length,
    scanned_sports:categories.length,
    unscanned_sports:0,
    zero_card_sports:zeroCardSports,
    unavailable_sports:0,
    cards_checked:cards.length,
    competitions_checked:competitionsChecked,
    deep_dived:deepIds.length,
    accepted:0,watch:0,rejected:0,
    scanned_sport_names:categories,
    unscanned_sport_names:[],
    card_ids:cards,
    sport_card_counts:counts,
    screening_evidence:evidence,
    deep_dive_evidence:deepIds.map(id=>{
      const e=byId.get(id);
      return {
        event_id:id,
        source_urls:[e?.source_url||s.source_url||"https://bet-channel.com/"],
        checks:{
          h2h:"unavailable",
          recent_form:"unavailable",
          common_opponent_comparison:"unavailable",
          ranking_or_rating:"unavailable",
          availability:"unavailable",
          market_odds:priced(e)?"checked":"unavailable",
          sport_specific:"unavailable",
          market_crosscheck:"unavailable"
        },
        outcome:"insufficient_data",
        note:"CI rehearsal verifies complete-union handoff and mandatory per-category deep-dive proof; it does not create betting picks",
        analysis_detail:analysisDetail(e)
      };
    })
  };
  systems[system]={
    discovery_runs:[{
      run_id:`${prefixes[system]}-${runId}`,
      started_at:generatedAt,
      slot:"adhoc",
      note:"BET CHANNEL complete union（通常+fixed-odds/eSports）全eventを使うライブcoverage dry-run。候補の最終採否・本番pick追加は行わない。"
    }],
    new_picks:[]
  };
}
const payload={
  payload_version:1,
  run_id:runId,
  source:"RMC live BET CHANNEL complete-union coverage rehearsal",
  generated_at:generatedAt,
  slot:"adhoc",
  note:"実BET CHANNEL complete union全掲載eventを①〜④で独立一次走査した証跡を使うdry-run。production dataは変更しない。",
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
          checked_at:s.checked_at,
          source_urls:[s.source_url||"https://bet-channel.com/"],
          menu_end_verified:s.menu_end_verified===true,
          category_count:s.category_count,
          event_count:s.event_count,
          access_status:s.complete===true?"direct":"partial",
          event_ids:s.event_ids,
          note:"live complete union summary",
          inventory_digest:s.integrity?.digest||s.inventory_digest,
          analysis_ready:s.analysis_ready===true,
          analysis_card_count:s.analysis_card_count,
          analysis_card_ids:s.analysis_card_ids,
          bettable_analysis_card_count:s.bettable_analysis_card_count,
          unavailable_price_card_count:s.unavailable_price_card_count,
          screening_event_count:s.screening_event_count,
          screening_event_ids:s.screening_event_ids,
          screening_digest:s.integrity?.screening_digest||s.screening_digest
        }
      }
    },
    systems:coverageSystems,
    self_audit:{
      checked_at:s.checked_at,
      inventory_status:s.self_audit?.status,
      inventory_self_audit_digest:s.self_audit?.digest,
      anomalies_found:s.self_audit?.anomaly_count??0,
      remediation_status:s.self_audit?.remediation_status??"unknown",
      fixes_applied:s.self_audit?.fixes_applied??[],
      unresolved_blockers:s.self_audit?.unresolved_blockers??0,
      checks_performed:s.self_audit?.checks_run??["complete_union_present"],
      note:"complete-union inventory self-audit mirrored into rehearsal payload"
    }
  }
};

fs.mkdirSync(outPath.split("/").slice(0,-1).join("/")||".",{recursive:true});
fs.writeFileSync(outPath,JSON.stringify(payload,null,2)+"\n");
console.log(JSON.stringify({
  run_id:runId,
  category_count:categories.length,
  cards_checked:cards.length,
  eligible_categories:eligibleByCategory.size,
  systems:Object.fromEntries(Object.entries(coverageSystems).map(([k,v])=>[k,{cards_checked:v.cards_checked,evidence:v.screening_evidence.length,deep_dived:v.deep_dived,deep_dive_evidence:v.deep_dive_evidence.length}])),
  self_audit:payload.coverage_audit.self_audit
},null,2));
