import fs from "node:fs/promises";

const args=process.argv.slice(2);
const opt=name=>{const i=args.indexOf(name); return i>=0?args[i+1]:null;};
const a1p=opt("--attempt1"), a2p=opt("--attempt2"), out=opt("--out");
if(!a1p||!out){ console.error("usage: --attempt1 <json> [--attempt2 <json>] --out <json>"); process.exit(2); }

async function read(p){ if(!p) return null; try{return JSON.parse(await fs.readFile(p,"utf8"));}catch{return null;} }
const a1=await read(a1p), a2=await read(a2p);
const healthy=x=>!!x &&
  x.complete===true && x.analysis_ready===true &&
  x.failed_category_count===0 && x.metadata_missing_count===0 && x.time_parse_missing_count===0 &&
  x.menu_end_verified===true &&
  x.integrity?.event_count_matches_ids===true &&
  x.integrity?.screening_event_count_matches_ids===true &&
  x.integrity?.screening_category_counts_sum===true &&
  x.integrity?.priority_12h_is_subset===true &&
  x.integrity?.category_keys_complete===true &&
  x.integrity?.category_card_counts_sum===true &&
  x.self_audit?.blocker_count===0;

const summary=x=>x?({
  checked_at:x.checked_at,
  category_count:x.category_count,
  event_count:x.event_count,
  screening_event_count:x.screening_event_count,
  priority_12h_event_count:x.priority_12h_event_count,
  complete:x.complete,
  analysis_ready:x.analysis_ready,
  self_audit_status:x.self_audit?.status??null,
  requires_rescan:x.self_audit?.requires_rescan??null,
  anomaly_count:x.self_audit?.anomaly_count??null,
  blocker_count:x.self_audit?.blocker_count??null,
  screening_digest:x.integrity?.screening_digest??null
}):null;

let chosen=null, remediation="";
if(healthy(a1) && !a1.self_audit?.requires_rescan){
  chosen=a1; remediation="not_needed";
}else{
  if(!healthy(a2)){
    console.error(JSON.stringify({ok:false,reason:"retry_required_but_retry_not_healthy",attempt1:summary(a1),attempt2:summary(a2)},null,2));
    process.exit(2);
  }
  if(a1 && healthy(a1) && a1.self_audit?.requires_rescan && a2.self_audit?.requires_rescan){
    const base=Math.max(Number(a1.screening_event_count||0),Number(a2.screening_event_count||0),1);
    const eventDiff=Math.abs(Number(a1.screening_event_count||0)-Number(a2.screening_event_count||0))/base;
    const catBase=Math.max(Number(a1.category_count||0),Number(a2.category_count||0),1);
    const catDiff=Math.abs(Number(a1.category_count||0)-Number(a2.category_count||0))/catBase;
    if(eventDiff>0.15 || catDiff>0.10){
      console.error(JSON.stringify({ok:false,reason:"two_scans_unstable",event_diff_ratio:eventDiff,category_diff_ratio:catDiff,attempt1:summary(a1),attempt2:summary(a2)},null,2));
      process.exit(2);
    }
    chosen=a2; remediation="confirmed_by_rescan";
  }else{
    chosen=a2;
    remediation=a1&&healthy(a1)?"rescan_cleared_suspicion":"retry_replaced_failed_scan";
  }
}

chosen.self_audit ??= {};
const initial=summary(a1), retry=summary(a2);
chosen.self_audit.initial_attempt=initial;
chosen.self_audit.retry_attempt=retry;
chosen.self_audit.remediation_status=remediation;
chosen.self_audit.fixes_applied=[
  ...(chosen.self_audit.fixes_applied??[]),
  ...(remediation==="not_needed"?[]:["full_dynamic_rescan"])
];
chosen.self_audit.requires_rescan=false;
chosen.self_audit.unresolved_blockers=0;
chosen.self_audit.status=remediation==="not_needed"?"pass":"pass_after_remediation";
chosen.self_audit.final_selection_reason=remediation;

await fs.mkdir(out.split("/").slice(0,-1).join("/")||".",{recursive:true});
await fs.writeFile(out,JSON.stringify(chosen,null,2)+"\n");
console.log(JSON.stringify({ok:true,selected:summary(chosen),remediation_status:remediation},null,2));
