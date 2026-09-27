import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script="scripts/select-bet-channel-inventory.mjs";
const healthy=(count,{rescan=false,status="pass",cats=100}={})=>({
  checked_at:"2026-09-27T14:00:00.000Z",
  complete:true,analysis_ready:true,failed_category_count:0,metadata_missing_count:0,time_parse_missing_count:0,
  menu_end_verified:true,category_count:cats,event_count:count,screening_event_count:count,priority_12h_event_count:Math.min(10,count),
  integrity:{
    event_count_matches_ids:true,screening_event_count_matches_ids:true,screening_category_counts_sum:true,
    priority_12h_is_subset:true,category_keys_complete:true,category_card_counts_sum:true,screening_digest:"digest-"+count
  },
  self_audit:{
    status,blocker_count:0,requires_rescan:rescan,unresolved_blockers:0,anomaly_count:rescan?1:0,
    remediation_status:rescan?"retry_required":"not_needed",fixes_applied:[],checks_run:["fixture"]
  },
  screening_events:[],screening_event_ids:[],analysis_card_ids:[],category_keys:[]
});

function dir(){ return mkdtempSync(join(tmpdir(),"rmc-bc-heal-")); }
function run(args){ return spawnSync(process.execPath,[script,...args],{encoding:"utf8"}); }

test("BET CHANNEL self-heal：1回目がsuspiciousでも再取得が正常なら2回目を採用",()=>{
  const d=dir();
  try{
    const a1=join(d,"a1.json"),a2=join(d,"a2.json"),out=join(d,"out.json");
    writeFileSync(a1,JSON.stringify(healthy(180,{rescan:true,status:"suspicious"})));
    writeFileSync(a2,JSON.stringify(healthy(190,{rescan:false,status:"pass"})));
    const r=run(["--attempt1",a1,"--attempt2",a2,"--out",out]);
    assert.equal(r.status,0,r.stdout+r.stderr);
    const x=JSON.parse(readFileSync(out,"utf8"));
    assert.equal(x.screening_event_count,190);
    assert.equal(x.self_audit.status,"pass_after_remediation");
    assert.equal(x.self_audit.remediation_status,"rescan_cleared_suspicion");
    assert.ok(x.self_audit.fixes_applied.includes("full_dynamic_rescan"));
  }finally{rmSync(d,{recursive:true,force:true});}
});

test("BET CHANNEL self-heal：再取得後も大きく不安定なら拒否",()=>{
  const d=dir();
  try{
    const a1=join(d,"a1.json"),a2=join(d,"a2.json"),out=join(d,"out.json");
    writeFileSync(a1,JSON.stringify(healthy(200,{rescan:true,status:"suspicious"})));
    writeFileSync(a2,JSON.stringify(healthy(100,{rescan:true,status:"suspicious"})));
    const r=run(["--attempt1",a1,"--attempt2",a2,"--out",out]);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/two_scans_unstable|retry_not_healthy/);
  }finally{rmSync(d,{recursive:true,force:true});}
});
