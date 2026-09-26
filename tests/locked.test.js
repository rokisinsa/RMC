import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLockedImmutable, LOCKED_FIELDS } from "../lib/integrity.js";
import { makeDataset } from "./fixtures/dataset.js";

function change(system, id, mutate) {
  const before = makeDataset()[system];
  const after = structuredClone(before);
  mutate(after.picks.find(p => p.id === id), after);
  return checkLockedImmutable(before, after);
}
const codes = issues => issues.map(i => i.code);

test("変更がなければ問題なし", () => {
  const ds = makeDataset();
  assert.deepEqual(checkLockedImmutable(ds.value1, structuredClone(ds.value1)), []);
});

test("locked 後に推定勝率・EV・判定を書き換えると error", () => {
  for (const mutate of [
    p => { p.locked.prob_lo = 0.7; },
    p => { p.locked.ev_hi = 0.2; },
    p => { p.locked.verdict = "watch"; },
    p => { p.locked.summary = "結果を見て修正"; },
  ]) {
    assert.ok(codes(change("value1", "v1-a", mutate)).includes("LOCKED_FIELD_CHANGED"));
  }
});

test("locked 後に odds_taken・stake・選択・市場・market_odds を変えると error", () => {
  for (const mutate of [
    p => { p.odds_taken = 1.3; },
    p => { p.stake = 300; },
    p => { p.selection = "side_b"; },
    p => { p.market = "dnb"; },
    p => { p.market_odds = { text: "1.20〜1.25", min: 1.2, max: 1.25, observed_at: null, source: null }; },
    p => { p.locked_at = "2026-09-19T23:40:00+09:00"; },
  ]) {
    assert.ok(codes(change("recommendations", "rec-r1", mutate)).includes("LOCKED_FIELD_CHANGED"));
  }
});

test("保護対象の項目一覧", () => {
  for (const f of ["locked", "odds_taken", "stake", "selection", "market", "match_id", "locked_at", "market_odds"]) {
    assert.ok(LOCKED_FIELDS.includes(f), f);
  }
});

test("locked 済みカードの削除は error", () => {
  assert.ok(codes(change("value1", "v1-a", (p, file) => { file.picks = file.picks.filter(x => x !== p); })).includes("LOCKED_PICK_DELETED"));
});

test("将来モデルの再計算は recalculated_reference へ追記するだけならOK", () => {
  const issues = change("recommendations", "rec-r1", p => {
    p.recalculated_reference.push({ at: "2026-10-01T06:00:00+09:00", model_version: "6.0", prob: 0.87, note: "参考再評価" });
  });
  assert.deepEqual(issues, []);
});

test("既存の recalculated_reference を書き換える・消すのは error", () => {
  const before = makeDataset().recommendations;
  before.picks[0].recalculated_reference.push({ at: "2026-10-01T06:00:00+09:00", model_version: "6.0", prob: 0.87, note: null });
  const edited = structuredClone(before);
  edited.picks[0].recalculated_reference[0].prob = 0.95;
  assert.ok(codes(checkLockedImmutable(before, edited)).includes("RECALCULATED_REFERENCE_REWRITTEN"));
  const removed = structuredClone(before);
  removed.picks[0].recalculated_reference = [];
  assert.ok(codes(checkLockedImmutable(before, removed)).includes("RECALCULATED_REFERENCE_REWRITTEN"));
});

test("試合後の追記（closing_odds・手動精算・フラグ・メモ）は許可", () => {
  const issues = change("value1", "v1-a", p => {
    p.closing_odds = 1.22;
    p.settlement_override = { state: "win", reason: "公式結果確認", set_at: "2026-09-20T23:00:00+09:00", source: "公式" };
    p.flags = ["result_unverified"];
    p.note = "試合後メモ";
  });
  assert.deepEqual(issues, []);
});

test("locked 前（locked_at=null）のカードは自由に修正できる", () => {
  const issues = change("value1", "v1-a", p => { p.locked_at = null; });
  // before 側は locked 済みなので locked_at の削除自体は error
  assert.ok(codes(issues).includes("LOCKED_FIELD_CHANGED"));

  const before = makeDataset().value1;
  before.picks[0].locked_at = null;
  const after = structuredClone(before);
  after.picks[0].locked.prob_lo = 0.7;
  after.picks[0].odds_taken = 1.3;
  assert.deepEqual(checkLockedImmutable(before, after), []);
});

test("条件付きVALUE：一度決めた condition は変更不可、未決定なら決めてよい", () => {
  assert.ok(codes(change("value1", "v1-d", p => { p.condition.met = false; })).includes("CONDITION_CHANGED"));
  assert.deepEqual(change("value1", "v1-e", p => { p.condition.met = true; p.condition.checked_at = "2026-09-20T19:00:00+09:00"; }), []);
});
