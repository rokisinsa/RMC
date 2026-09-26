import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, checkDuplicates } from "../lib/integrity.js";
import { makeDataset } from "./fixtures/dataset.js";

function withDuplicate(flags = []) {
  const ds = makeDataset();
  const copy = structuredClone(ds.recommendations.picks[0]);   // m1 / match_1x2 / side_a
  copy.id = "rec-r1-dup";
  copy.flags = flags;
  ds.recommendations.picks.push(copy);
  return ds;
}

test("fixture には重複がない", () => {
  const ds = makeDataset();
  for (const s of ["recommendations", "experience", "value1", "value2"]) assert.deepEqual(findDuplicates(ds[s]), [], s);
});

test("同一系統内の 同一試合＋同一市場＋同一選択 を重複として検出", () => {
  const ds = withDuplicate();
  assert.deepEqual(findDuplicates(ds.recommendations), [{ key: "m1|match_1x2|side_a", ids: ["rec-r1", "rec-r1-dup"] }]);
});

test("フラグなしの重複は error、全員に duplicate_review があれば削除せず warning", () => {
  const unflagged = checkDuplicates(withDuplicate().recommendations);
  assert.equal(unflagged[0].level, "error");
  assert.equal(unflagged[0].code, "DUPLICATE_UNFLAGGED");

  const ds = withDuplicate(["duplicate_review"]);
  ds.recommendations.picks[0].flags = ["duplicate_review"];
  const flagged = checkDuplicates(ds.recommendations);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].level, "warning");
  assert.equal(ds.recommendations.picks.length, 9);   // 検出しても削除しない
});

test("市場か選択が違えば重複ではない", () => {
  const ds = makeDataset();
  const a = structuredClone(ds.recommendations.picks[0]);
  a.id = "rec-x1"; a.market = "first_half_1x2";
  const b = structuredClone(ds.recommendations.picks[0]);
  b.id = "rec-x2"; b.selection = "side_b";
  ds.recommendations.picks.push(a, b);
  assert.deepEqual(findDuplicates(ds.recommendations), []);
});

test("別系統に同じ試合・市場・選択があっても重複ではない（系統は独立）", () => {
  const ds = makeDataset();
  // rec-r1 と v1-a はどちらも m1 / match_1x2 / side_a
  assert.deepEqual(findDuplicates(ds.recommendations), []);
  assert.deepEqual(findDuplicates(ds.value1), []);
});
