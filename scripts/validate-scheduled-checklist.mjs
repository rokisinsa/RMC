#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const file=path.resolve(process.argv[2]||"data/scheduled-update-checklist.json");
const fail=msg=>{console.error("scheduled-checklist validation FAIL:",msg);process.exitCode=1;};
let db;
try{db=JSON.parse(fs.readFileSync(file,"utf8"));}catch(e){console.error("scheduled-checklist validation FAIL: unreadable JSON",e.message);process.exit(1);}
if(db.schema_version!==1)fail("schema_version must be 1");
if(!Array.isArray(db.runs))fail("runs must be array");
const ids=new Set();
for(const r of db.runs||[]){
  if(!r||typeof r!=="object"){fail("run must be object");continue;}
  if(!/^rmc-\d{8}-(0600|1200|1800|2300)$/.test(String(r.run_id||"")))fail(`invalid run_id ${r.run_id}`);
  if(ids.has(r.run_id))fail(`duplicate run_id ${r.run_id}`); ids.add(r.run_id);
  if(!["06:00","12:00","18:00","23:00"].includes(r.slot))fail(`${r.run_id}: invalid slot`);
  if(!Number.isFinite(Date.parse(r.scheduled_for||"")))fail(`${r.run_id}: invalid scheduled_for`);
  if(!["running","blocked","failed","passed"].includes(r.status))fail(`${r.run_id}: invalid status ${r.status}`);
  if(!Array.isArray(r.checks)||r.checks.length!==41){fail(`${r.run_id}: checks length must be exactly 41`);continue;}
  const checkIds=r.checks.map(c=>c.id);
  if(JSON.stringify(checkIds)!==JSON.stringify(Array.from({length:41},(_,i)=>i+1)))fail(`${r.run_id}: check ids must be 1..41 exactly`);
  for(const c of r.checks){
    if(!["pending","pass","fail","blocked"].includes(c.status))fail(`${r.run_id} #${c.id}: invalid status`);
    if(typeof c.title!=="string"||!c.title.trim())fail(`${r.run_id} #${c.id}: missing title`);
  }
  const s={pass:0,fail:0,blocked:0,pending:0,total:41};
  for(const c of r.checks)s[c.status]++;
  for(const k of ["pass","fail","blocked","pending","total"])if(r.summary?.[k]!==s[k])fail(`${r.run_id}: summary.${k} mismatch expected ${s[k]} got ${r.summary?.[k]}`);
  const truePassed=r.checks.every(c=>c.status==="pass")&&r.summary?.pass===41&&r.checks[40]?.status==="pass"&&(r.blockers||[]).length===0;
  if(r.status==="passed"&&!truePassed)fail(`${r.run_id}: passed without 41/41 and blockers=0`);
  if(truePassed&&r.status!=="passed")fail(`${r.run_id}: 41/41 should be passed`);
  if(r.status==="failed"&&!r.checks.some(c=>c.status==="fail"))fail(`${r.run_id}: failed status without any failed check`);
}
if(db.latest_run_id!=null&&!ids.has(db.latest_run_id))fail("latest_run_id does not exist in runs");
if(!process.exitCode)console.log(`scheduled-checklist validation PASS: ${db.runs.length} run(s), latest=${db.latest_run_id||"none"}`);
