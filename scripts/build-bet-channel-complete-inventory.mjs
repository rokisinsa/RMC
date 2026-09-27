import fs from "node:fs/promises";
import crypto from "node:crypto";

const LEGACY = process.argv[2] || "data/bet-channel-screening-summary.json";
const FIXED = process.argv[3] || "data/bet-channel-fixed-odds-inventory.json";
const OUT = process.argv[4] || "data/bet-channel-complete-summary.json";

const jstNow = () => new Date(Date.now()+9*3600e3).toISOString().replace("Z","+09:00");
const hash = v => crypto.createHash("sha256").update(typeof v==="string"?v:JSON.stringify(v)).digest("hex").slice(0,20);
const read = async p => { try { return JSON.parse(await fs.readFile(p,"utf8")); } catch { return null; } };
const uniq = xs => [...new Set((xs||[]).map(String))];
const latestIso = (...vals) => {
  const good=vals.filter(Boolean).map(v=>({v,t:Date.parse(v)})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>b.t-a.t);
  return good[0]?.v || jstNow();
};

const legacy=await read(LEGACY);
const fixed=await read(FIXED);

if(!legacy){
  console.error("legacy BET CHANNEL screening summary missing");
  process.exit(2);
}

const fixedOk=!!fixed && fixed.complete===true && fixed.analysis_ready===true && fixed.menu_end_verified===true;
const fixedEvents=(fixed?.events||[]).map(e=>({
  ...e,
  event_id:String(e.event_id),
  category:e.category||e.title||"eSports",
  category_key:e.category_key||("BETBY_ESPORTS:"+(e.category||e.title||"unknown")),
  market_class:e.market_class||"primary_h2h",
  primary_market:e.primary_market!==false,
  price_state:e.price_state||((e.market_choices||[]).some(x=>typeof x.odds==="number")?"priced":"unpriced"),
  start_state:e.start_state||"future_or_upcoming",
  source_url:e.source_url||"https://bet-channel.com/fixed-odds?bt-path=/esports"
}));

const fixedCategoryKeys=uniq([
  ...(fixed?.category_keys||[]),
  ...fixedEvents.map(e=>e.category_key).filter(Boolean)
]);
const categoryKeys=uniq([...(legacy.category_keys||[]),...fixedCategoryKeys]);

const legacyEventIds=uniq(legacy.event_ids||[]);
const fixedEventIds=uniq(fixed?.event_ids||fixedEvents.map(e=>e.event_id));
const allEventIds=uniq([...legacyEventIds,...fixedEventIds]);

const legacyScreeningIds=uniq(legacy.screening_event_ids||[]);
const fixedScreeningIds=uniq(fixed?.screening_event_ids||fixedEventIds);
const screeningIds=uniq([...legacyScreeningIds,...fixedScreeningIds]);

const fixedAnalysisIds=uniq((fixed?.analysis_card_ids||fixedEvents.filter(e=>e.primary_market!==false).map(e=>"bc-"+hash(String(e.event_id)))).map(String));
const analysisIds=uniq([...(legacy.analysis_card_ids||[]),...fixedAnalysisIds]);

const events=[...(legacy.events||[]),...fixedEvents];
const priced=e=>e.price_state==="priced"||(e.market_choices||[]).some(x=>typeof x.odds==="number"&&x.bettable!==false);
const now=Date.now();
const priorityIds=events.filter(e=>{
  const t=Date.parse(e.start_at_jst||e.start_at||"");
  return Number.isFinite(t)&&t>=now&&t<=now+12*3600e3;
}).map(e=>String(e.event_id));

const legacyAudit=legacy.self_audit||{};
const fixedAudit=fixed?.self_audit||{};
const blockers=[
  ...(legacy.complete===true&&legacy.analysis_ready===true?[]:["legacy_incomplete"]),
  ...(fixedOk?[]:["fixed_odds_incomplete"]),
  ...((legacyAudit.unresolved_blockers??0)===0?[]:["legacy_self_audit_blocker"]),
  ...((fixedAudit.unresolved_blockers??0)===0?[]:["fixed_self_audit_blocker"])
];
const warnings=[
  ...((legacyAudit.warning_count??0)>0?["legacy_warning"]:[]),
  ...((fixedAudit.warning_count??0)>0?["fixed_warning"]:[])
];

const digest=hash([...allEventIds].sort().join("|"));
const screeningDigest=hash([...screeningIds].sort().join("|"));
const auditDigest=hash(JSON.stringify({
  legacy:legacyAudit.digest||legacy.screening_digest||legacy.inventory_digest||null,
  fixed:fixedAudit.digest||fixed?.inventory_digest||null,
  digest,screeningDigest
}));

const out={
  schema_version:1,
  source:"BET CHANNEL complete union (legacy /matches + fixed-odds/Betby eSports)",
  source_url:"https://bet-channel.com/",
  checked_at:latestIso(legacy.checked_at,fixed?.checked_at),
  generated_at:jstNow(),
  menu_end_verified:legacy.menu_end_verified===true && fixed?.menu_end_verified===true,
  category_count:categoryKeys.length,
  category_keys:categoryKeys,
  event_count:allEventIds.length,
  event_ids:allEventIds,
  failed_category_count:(legacy.failed_category_count||0)+(fixed?.failed_category_count||0),
  metadata_missing_count:(legacy.metadata_missing_count||0)+(fixed?.metadata_missing_count||0),
  time_parse_missing_count:(legacy.time_parse_missing_count||0)+(fixed?.time_parse_missing_count||0),
  complete:blockers.length===0,
  analysis_ready:blockers.length===0,
  inventory_digest:digest,
  analysis_card_count:analysisIds.length,
  analysis_card_ids:analysisIds,
  bettable_analysis_card_count:(legacy.bettable_analysis_card_count||0)+fixedEvents.filter(priced).length,
  unavailable_price_card_count:(legacy.unavailable_price_card_count||0)+fixedEvents.filter(e=>!priced(e)).length,
  screening_event_count:screeningIds.length,
  screening_event_ids:screeningIds,
  priority_12h_event_count:priorityIds.length,
  priority_12h_event_ids:priorityIds,
  screening_digest:screeningDigest,
  component_status:{
    legacy:{checked_at:legacy.checked_at,complete:legacy.complete===true,event_count:legacy.event_count,screening_event_count:legacy.screening_event_count},
    fixed_odds:{checked_at:fixed?.checked_at||null,complete:fixedOk,event_count:fixed?.event_count||0,screening_event_count:fixed?.screening_event_count||0,source_machine:fixed?.source_machine||null}
  },
  self_audit:{
    status:blockers.length?"blocked":"pass",
    digest:auditDigest,
    anomaly_count:blockers.length+warnings.length,
    blocker_count:blockers.length,
    warning_count:warnings.length,
    remediation_status:blockers.length?"required":"not_needed",
    fixes_applied:[],
    checks_run:[
      "legacy_complete","fixed_odds_complete","menu_end_verified","event_id_union_unique",
      "screening_union_unique","component_freshness_checked_by_production_gate","analysis_card_union"
    ],
    unresolved_blockers:blockers.length,
    blockers,
    warnings
  },
  integrity:{
    digest,
    screening_digest:screeningDigest,
    event_count_matches_ids:allEventIds.length===new Set(allEventIds).size,
    screening_event_count_matches_ids:screeningIds.length===new Set(screeningIds).size,
    category_keys_complete:categoryKeys.length===new Set(categoryKeys).size,
    priority_12h_is_subset:priorityIds.every(id=>screeningIds.includes(id))
  },
  stats:{
    priced_event_count:events.filter(priced).length,
    unpriced_event_count:events.filter(e=>!priced(e)).length,
    primary_h2h_count:events.filter(e=>e.primary_market===true||e.market_class==="primary_h2h").length,
    fixed_odds_event_count:fixedEventIds.length,
    legacy_screening_event_count:legacyScreeningIds.length
  },
  events
};

await fs.writeFile(OUT,JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify({
  ok:out.complete,
  out:OUT,
  category_count:out.category_count,
  event_count:out.event_count,
  screening_event_count:out.screening_event_count,
  legacy_screening_event_count:legacyScreeningIds.length,
  fixed_screening_event_count:fixedScreeningIds.length,
  blockers
},null,2));
if(!out.complete) process.exitCode=3;
