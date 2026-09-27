import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensure, mark, finish } from "../scripts/rmc-scheduled-checklist.mjs";
import { mergeRun, mergeDb } from "../scripts/merge-scheduled-checklist.mjs";

const makeDb=()=>({schema_version:1,latest_run_id:null,runs:[]});
const makeRun=()=>{
  const db=makeDb();
  const run=ensure(db,{runId:"rmc-20260928-0600",slot:"06:00",scheduledFor:"2026-09-28T06:00:00+09:00",source:"test",startSha:"abc123"});
  return {db,run};
};

test("定時41項目: 1〜40に未PASSが1件でもあれば #41 をPASSにできない",()=>{
  const {run}=makeRun();
  for(let i=1;i<=39;i++)mark(run,i,"pass",`ok ${i}`);
  mark(run,40,"fail","public mismatch");
  finish(run,true,"finalize");
  assert.equal(run.status,"failed");
  assert.equal(run.checks[40].status,"fail");
  assert.equal(run.summary.pass,39);
  assert.equal(run.summary.fail,2);
});

test("定時41項目: 41/41だけが passed",()=>{
  const {run}=makeRun();
  for(let i=1;i<=40;i++)mark(run,i,"pass",`ok ${i}`);
  run.blockers=[];
  finish(run,true,"complete");
  assert.equal(run.status,"passed");
  assert.equal(run.summary.pass,41);
  assert.equal(run.summary.fail,0);
  assert.equal(run.summary.blocked,0);
  assert.equal(run.summary.pending,0);
});

test("定時41項目: 途中FAILなら残りはblockedになり未実行をPASS扱いしない",()=>{
  const {run}=makeRun();
  mark(run,1,"pass","start");
  mark(run,2,"pass","legacy");
  mark(run,3,"fail","fixed missing");
  finish(run,false,"blocked by fixed inventory");
  assert.equal(run.status,"failed");
  assert.equal(run.checks[2].status,"fail");
  assert.ok(run.checks.slice(3,40).every(c=>c.status==="blocked"));
  assert.equal(run.checks[40].status,"fail");
});

test("定時41項目: passed runは後からfailed/pendingの古い情報で降格しない",()=>{
  const {run:passed}=makeRun();
  for(let i=1;i<=40;i++)mark(passed,i,"pass","ok");
  finish(passed,true,"complete");
  const failed=structuredClone(passed);
  failed.status="failed"; failed.checks[2].status="fail"; failed.checks[2].checked_at="2099-01-01T00:00:00+09:00";
  const merged=mergeRun(passed,failed);
  assert.equal(merged.status,"passed");
  assert.equal(merged.summary.pass,41);
});

test("定時41項目: mergeDbは別runの失敗履歴を消さない",()=>{
  const {db,run}=makeRun();
  mark(run,1,"pass","start");mark(run,2,"fail","x");finish(run,false,"x");
  const next=makeDb();
  const r2=ensure(next,{runId:"rmc-20260928-1200",slot:"12:00",scheduledFor:"2026-09-28T12:00:00+09:00",source:"test",startSha:"def456"});
  mark(r2,1,"pass","start");mark(r2,2,"fail","y");finish(r2,false,"y");
  const merged=mergeDb(db,next,r2.run_id);
  assert.equal(merged.runs.length,2);
  assert.ok(merged.runs.some(r=>r.run_id===run.run_id&&r.status==="failed"));
  assert.ok(merged.runs.some(r=>r.run_id===r2.run_id&&r.status==="failed"));
});

test("scheduled-update-checklist validatorは現在の台帳を検証できる",()=>{
  const out=execFileSync(process.execPath,["scripts/validate-scheduled-checklist.mjs","data/scheduled-update-checklist.json"],{encoding:"utf8"});
  assert.match(out,/validation PASS/);
});

test("RMC V2は41項目台帳を読み、FAIL時に新規判断禁止を表示する実装を持つ",()=>{
  const src=fs.readFileSync("analysis-v2.js","utf8");
  assert.match(src,/scheduled_checklist:\s*"data\/scheduled-update-checklist\.json"/);
  assert.match(src,/RMC完全定時更新：41\/41 PASS/);
  assert.match(src,/新規判断に使用禁止/);
  assert.match(src,/定時更新41項目の監査結果を表示/);
});


test("定時41項目: 前提未PASSの空集合チェックを見かけ上PASSにしない",()=>{
  const {run}=makeRun();
  mark(run,1,"pass","start");
  mark(run,2,"pass","legacy");
  mark(run,3,"fail","fixed missing");
  mark(run,4,"fail","routes unavailable");
  mark(run,5,"fail","union incomplete");
  mark(run,15,"fail","coverage unavailable");
  mark(run,16,"pass","eligible category 0");
  mark(run,17,"pass","zero violations");
  mark(run,24,"fail","existing cards not rechecked");
  mark(run,25,"pass","0 overdue matches");
  mark(run,26,"pass","all identities ok");
  assert.equal(run.checks[15].status,"blocked");
  assert.equal(run.checks[16].status,"blocked");
  assert.equal(run.checks[24].status,"blocked");
  assert.equal(run.checks[25].status,"blocked");
});
