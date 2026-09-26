import { test } from "node:test";
import assert from "node:assert/strict";
import { settlePick, outcomeFromMatch, roundMoney } from "../lib/settlement.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";

const ds = makeDataset();
const M = matchesById(ds);
const recPick = id => ds.recommendations.picks.find(p => p.id === id);
const settle = (id, opts) => { const p = recPick(id); return settlePick(p, M.get(p.match_id), opts); };

test("1X2・前半・第1セット・第1マップを試合事実から自動判定", () => {
  assert.equal(settle("rec-r1").state, "win");   // 2-0 で side_a の勝ち
  assert.equal(settle("rec-r3").state, "loss");  // 前半 0-1
  assert.equal(settle("rec-r4").state, "win");   // 第1セット 25-20
  assert.equal(settle("rec-r5").state, "win");   // 第1マップ 13-10（シリーズは 0-2 で負けでも第1マップは勝ち）
});

test("的中：払戻し = stake × odds_taken、純損益 = 払戻し − stake", () => {
  const r = settle("rec-r1");
  assert.equal(r.payout, 120);
  assert.equal(r.profit, 20);
});

test("浮動小数の誤差を持ち込まない（1.14 × 100 = 114.00）", () => {
  const p = { ...recPick("rec-r1"), odds_taken: 1.14 };
  const r = settlePick(p, M.get("m1"));
  assert.equal(r.payout, 114);
  assert.equal(r.profit, 14);
  assert.equal(roundMoney(100 * 1.13), 113);
  assert.equal(roundMoney(300 * 1.17), 351);
});

test("不的中：純損益 = −stake（オッズ不明でも計算できる）", () => {
  const p = { ...recPick("rec-r3"), odds_taken: null };
  const r = settlePick(p, M.get("m2"));
  assert.equal(r.state, "loss");
  assert.equal(r.payout, 0);
  assert.equal(r.profit, -100);
  assert.equal(r.amountMissing, false);
});

test("DNB の引分は push：損益0で勝ち/負けに数えない", () => {
  const r = settle("rec-r2");
  assert.equal(r.state, "push");
  assert.equal(r.profit, 0);
  assert.equal(r.payout, 100);
});

test("1X2 の引分は選択側の負け、draw 選択なら勝ち", () => {
  const p = { ...recPick("rec-r1"), match_id: "m2" };
  assert.equal(settlePick(p, M.get("m2")).state, "loss");
  assert.equal(settlePick({ ...p, selection: "draw", odds_taken: 3.2 }, M.get("m2")).state, "win");
});

test("中止・延期・没収は void：損益0", () => {
  const r = settle("rec-r6");
  assert.equal(r.state, "void");
  assert.equal(r.profit, 0);
  for (const status of ["postponed", "abandoned"]) {
    assert.equal(settlePick(recPick("rec-r6"), { ...M.get("m5"), status }).state, "void");
  }
});

test("試合前・進行中・スコア未入力・試合未登録は pending", () => {
  assert.equal(settle("rec-r7").state, "pending");
  assert.equal(settlePick(recPick("rec-r1"), { ...M.get("m1"), status: "live" }).state, "pending");
  assert.equal(settlePick(recPick("rec-r3"), { ...M.get("m2"), result: { final: { a: 1, b: 1 } } }).state, "pending");
  assert.equal(settlePick(recPick("rec-r1"), undefined).state, "pending");
});

test("引分のない市場で同点スコアなら自動判定せず pending（要確認）", () => {
  const p = { ...recPick("rec-r1"), market: "match_winner" };
  const r = outcomeFromMatch(p, M.get("m2"));
  assert.equal(r.state, "pending");
  assert.match(r.reason, /要確認/);
});

test("other 市場やライブ取引は settlement_override で明示精算する", () => {
  const p = { ...recPick("rec-r1"), market: "other" };
  assert.equal(settlePick(p, M.get("m1")).state, "pending");
  const o = { ...p, settlement_override: { state: "loss", reason: "ライブ前半1X2", set_at: "2026-09-20T21:00:00+09:00", source: null } };
  const r = settlePick(o, M.get("m1"));
  assert.equal(r.state, "loss");
  assert.equal(r.source, "override");
  assert.equal(r.profit, -100);
});

test("未確定の予想損益は odds_taken がある場合だけ計算する", () => {
  assert.equal(settle("rec-r7").projectedProfit, 15);
  const unknown = settle("rec-r8");
  assert.equal(unknown.projectedProfit, null);   // −$100 として扱わない
  assert.equal(unknown.profit, null);
});

test("市場オッズのレンジは精算に使わない（的中でも金額は未計算）", () => {
  const p = { ...recPick("rec-r8"), match_id: "m1" };
  const r = settlePick(p, M.get("m1"));
  assert.equal(r.state, "win");
  assert.equal(r.payout, null);
  assert.equal(r.profit, null);
  assert.equal(r.amountMissing, true);
});

test("監視カード（stake=null）は notionalStake で「仮に投入した場合」を計算できる", () => {
  const p = ds.value1.picks.find(x => x.id === "v1-c");
  assert.equal(settlePick(p, M.get("m4")).profit, null);
  assert.equal(settlePick(p, M.get("m4"), { notionalStake: 100 }).profit, 35);
});

test("並び順キーは試合開始時刻（無ければ bet_at → locked_at → discovered_at）", () => {
  assert.equal(settle("rec-r1").orderKey, "2026-09-20T20:00:00+09:00");
  assert.equal(settlePick(recPick("rec-r1"), undefined).orderKey, recPick("rec-r1").locked_at);
});
