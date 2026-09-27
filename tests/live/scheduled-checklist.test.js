import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TITLES, inferNextSlot, ensure, mark, finish } from "../../scripts/rmc-scheduled-checklist.mjs";
import { ROOT, loadSchemas } from "../../scripts/load-node.js";
import { createValidator } from "../../lib/schema-validate.js";

test("定時41項目はちょうど41件・ID/タイトルが一意", () => {
  assert.equal(TITLES.length, 41);
  assert.equal(new Set(TITLES).size, 41);
  assert.ok(TITLES.every(x => typeof x === "string" && x.trim().length > 0));
});

test("定時枠は多少遅延しても最寄り枠へ紐づく（23:05→23:00）", () => {
  const x=inferNextSlot(new Date("2026-09-27T23:05:00+09:00"));
  assert.equal(x.slot, "23:00");
  assert.equal(x.runId, "rmc-20260927-2300");
  assert.equal(x.scheduledFor, "2026-09-27T23:00:00+09:00");
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
  const r=ensure(db,{runId:"rmc-20260928-1200",slot:"12:00",scheduledFor:"2026-09-28T12:00:00+09:00",source:"test",startSha:"abcdef0"});
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
