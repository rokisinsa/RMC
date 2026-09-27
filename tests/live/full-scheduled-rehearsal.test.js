import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("VPS前の完全模擬定時更新が本番validator→41項目→公開HTTP検証まで41/41通る", () => {
  const out=execFileSync(process.execPath,["scripts/rehearse-full-scheduled-update.mjs"],{encoding:"utf8",maxBuffer:20*1024*1024});
  assert.match(out,/FULL_SCHEDULED_REHEARSAL_PASS/);
  assert.match(out,/"pass": 41/);
  assert.match(out,/"production_dry_run": true/);
  assert.match(out,/"production_apply": true/);
  assert.match(out,/"public_verifier": "pass"/);
});
