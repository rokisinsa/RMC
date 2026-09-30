import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TITLES, inferNextSlot, ensure, mark, finish } from "../../scripts/rmc-scheduled-checklist.mjs";
import { mergeRun } from "../../scripts/merge-scheduled-checklist.mjs";
import { ROOT, loadSchemas } from "../../scripts/load-node.js";
import { createValidator } from "../../lib/schema-validate.js";

test("定時41項目はちょうど41件・ID/タイトルが一意", () => {
  assert.equal(TITLES.length, 41);
  assert.equal(new Set(TITLES).size, 41);
  assert.ok(TITLES.every(x => typeof x === "string" && x.trim().length > 0));
});

test("定時枠は多少遅延しても最寄り枠へ紐づく（22:05→22:00）", () => {
  const x=inferNextSlot(new Date("2026-09-27T22:05:00+09:00"));
  assert.equal(x.slot, "22:00");
  assert.equal(x.runId, "rmc-20260927-2200");
  assert.equal(x.scheduledFor, "2026-09-27T22:00:00+09:00");
});

test("1〜40すべてPASSした場合だけ41番とrun全体をPASSにできる", () => {
  const db={schema_version:1,latest_run_id:null,runs:[]};
  const r=ensure(db,{runId:"rmc-20260928-0600",slot:"06:00",scheduledFor:"2026-09-28T06:00:00+09:00",source:"test",startSha:"abcdef0"});
  for(let i=1;i<=40;i++) mark(r,i,"pass","ok-"+i);
  finish(r,true,"all complete");
  assert.equal(r.status,"passed");
  assert.equal(r.summary.pass,41);
  assert.equal(r.summary.fail,0);
  assert.equal(r.summary.blocked,0);
  assert.equal(r.checks[40].status,"pass");
});

test("1項目でもFAILなら未実行項目をPASS扱いせず最終FAIL", () => {
  const db={schema_version:1,latest_run_id:null,runs:[]};
  const r=ensure(db,{runId:"rmc-20260928-1700",slot:"17:00",scheduledFor:"2026-09-28T17:00:00+09:00",source:"test",startSha:"abcdef0"});
  mark(r,1,"pass","started");
  mark(r,2,"pass","legacy ok");
  mark(r,3,"fail","fixed odds missing");
  finish(r,false,"fixed odds missing");
  assert.equal(r.status,"failed");
  assert.equal(r.checks[2].status,"fail");
  assert.ok(r.checks.slice(3,40).every(c=>c.status==="blocked"));
  assert.equal(r.checks[40].status,"fail");
  assert.notEqual(r.summary.pass,41);
});

test("公開用scheduled-update-checklist.jsonはschema PASS・41項目整合", () => {
  const data=JSON.parse(readFileSync(join(ROOT,"data","scheduled-update-checklist.json"),"utf8"));
  const validate=createValidator(loadSchemas());
  assert.deepEqual(validate("scheduled-update-checklist.schema.json",data),[]);
  const latest=data.runs.find(r=>r.run_id===data.latest_run_id);
  assert.ok(latest);
  assert.equal(latest.checks.length,41);
  assert.deepEqual(latest.checks.map(x=>x.id),Array.from({length:41},(_,i)=>i+1));
  assert.equal(latest.summary.pass+latest.summary.fail+latest.summary.blocked+latest.summary.pending,41);
});

test("並行監査マージ：passedを降格させず、pendingで既存証拠を消さない", () => {
  const base={run_id:"rmc-20260928-1700",scheduled_for:"2026-09-28T17:00:00+09:00",status:"passed",blockers:[],checks:TITLES.map((title,i)=>({id:i+1,title,status:"pass",checked_at:"2026-09-28T17:20:00+09:00"})),summary:{pass:41,fail:0,blocked:0,pending:0,total:41},updated_at:"2026-09-28T17:20:00+09:00"};
  const stale=structuredClone(base);
  stale.status="failed"; stale.checks[2].status="fail"; stale.checks[2].checked_at="2026-09-28T17:10:00+09:00"; stale.summary={pass:40,fail:1,blocked:0,pending:0,total:41};
  assert.equal(mergeRun(base,stale).status,"passed");

  const running=structuredClone(base); running.status="running"; running.checks[40].status="pending"; running.summary={pass:40,fail:0,blocked:0,pending:1,total:41};
  const incoming=structuredClone(running); incoming.checks[0].status="pending"; incoming.checks[0].checked_at="2026-09-28T17:30:00+09:00";
  const merged=mergeRun(running,incoming);
  assert.equal(merged.checks[0].status,"pass");
});

test("並行監査マージ：新しい再試行証拠でFAILをPASSへ更新できる", () => {
  const mk=(status,at)=>({run_id:"rmc-20260928-2200",scheduled_for:"2026-09-28T22:00:00+09:00",status:"failed",blockers:["fixed_odds_incomplete"],checks:TITLES.map((title,i)=>({id:i+1,title,status:i===2?status:"pending",checked_at:at})),summary:{pass:0,fail:status==="fail"?1:0,blocked:0,pending:status==="fail"?40:41,total:41},updated_at:at});
  const old=mk("fail","2026-09-28T22:35:00+09:00");
  const fresh=mk("pass","2026-09-28T22:50:00+09:00"); fresh.blockers=[];
  assert.equal(mergeRun(old,fresh).checks[2].status,"pass");
});
