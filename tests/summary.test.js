import { test } from "node:test";
import assert from "node:assert/strict";
import { settlePick } from "../lib/settlement.js";
import { summarize, compound, quarterKelly } from "../lib/summary.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";

const ds = makeDataset();
const M = matchesById(ds);
const recSettlements = ds.recommendations.picks.map(p => settlePick(p, M.get(p.match_id)));

// 合成データ用
const S = (state, { stake = 100, odds = null, profit, projectedProfit = null, at = "2026-09-20T00:00:00+09:00" } = {}) => ({
  state, stake, odds, projectedProfit, orderKey: at,
  profit: profit !== undefined ? profit
    : state === "win" ? (odds == null ? null : Math.round(stake * (odds - 1) * 100) / 100)
    : state === "loss" ? -stake : state === "pending" ? null : 0,
  amountMissing: state === "win" && odds == null,
});

test("推奨取引 fixture：戦績・勝率", () => {
  const s = summarize(recSettlements);
  assert.equal(s.count, 8);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 1);
  assert.equal(s.pushes, 1);
  assert.equal(s.voids, 1);
  assert.equal(s.pending, 2);
  assert.equal(s.settledGames, 4);   // push/void は勝敗に数えない
  assert.equal(s.winRate, 75);
});

test("推奨取引 fixture：純損益・確定済み投入額・ROI", () => {
  const s = summarize(recSettlements);
  assert.equal(s.netProfit, -15);        // +20 +25 +40 −100
  assert.equal(s.settledStake, 400);     // win/loss のみ
  assert.equal(s.roi, -3.75);            // −15 ÷ 400 × 100
  assert.equal(s.refundedStake, 200);    // push + void
});

test("総投入予定額と確定済み投入額を分けて出す", () => {
  const s = summarize(recSettlements);
  assert.equal(s.plannedStake, 800);     // 全8件
  assert.equal(s.settledStake, 400);
  assert.equal(s.openStake, 200);
});

test("未確定の予想損益：オッズ不明は −$100 にせず「未計算」件数へ", () => {
  const s = summarize(recSettlements);
  assert.equal(s.openProjectedProfit, 15);
  assert.equal(s.openProjectedCount, 1);
  assert.equal(s.openUncomputed, 1);
});

test("回帰：現行ページの −$1,986.00 の再発防止（オッズ不明の未確定20件＋既知1件）", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => S("pending")),
    S("pending", { odds: 1.14, projectedProfit: 14 }),
  ];
  const s = summarize(rows);
  assert.equal(s.openProjectedProfit, 14);
  assert.equal(s.openUncomputed, 20);
  assert.equal(s.openStake, 2100);
});

test("ROI は未確定を含めない・確定0件なら null", () => {
  assert.equal(summarize([S("pending", { odds: 1.5, projectedProfit: 50 })]).roi, null);
  assert.equal(summarize([]).roi, null);
  assert.equal(summarize([]).winRate, null);
  const s = summarize([S("win", { odds: 1.25 }), S("loss"), S("pending", { odds: 2, projectedProfit: 100 })]);
  assert.equal(s.roi, -37.5);            // (25 − 100) ÷ 200
});

test("的中でも金額が出せないカードは損益・ROI から除外し、件数で知らせる", () => {
  const s = summarize([S("win", { odds: null }), S("win", { odds: 1.35 })]);
  assert.equal(s.wins, 2);
  assert.equal(s.netProfit, 35);
  assert.equal(s.settledStake, 100);
  assert.equal(s.amountMissing, 1);
});

test("最大連敗（push/void/pending は連敗を途切れさせない）", () => {
  const t = d => `2026-09-${d}T00:00:00+09:00`;
  const rows = [
    S("loss", { at: t(20) }), S("loss", { at: t(21) }), S("push", { at: t(22) }), S("loss", { at: t(23) }),
    S("win", { odds: 1.5, at: t(24) }), S("loss", { at: t(25) }),
  ];
  assert.equal(summarize(rows).maxLosingStreak, 3);
});

test("複利：推奨 fixture（勝ち→負けでリセット→勝ち2つ）", () => {
  const c = compound(recSettlements, 100);
  assert.equal(c.balance, 175);          // 100 → 120 → 失敗 → 100 × 1.25 × 1.40
  assert.equal(c.stock, 0);
  assert.equal(c.cycles, 0);
  assert.equal(c.failures, 1);
  assert.equal(c.profit, 75);
});

test("複利：2倍到達で利益をストックし元金へ戻す（現行ルールと同じ）", () => {
  const t = d => `2026-09-${d}T00:00:00+09:00`;
  // 現行データ順の再現：1.17 → 1.11 → 1.13 → 1.19 → 1.23 で 214.80 到達 → ストック 114.80
  const rows = [1.17, 1.11, 1.13, 1.19, 1.23].map((odds, i) => S("win", { odds, at: t(10 + i) }));
  const c = compound(rows, 100);
  assert.equal(c.stock, 114.8);
  assert.equal(c.cycles, 1);
  assert.equal(c.balance, 100);
});

test("複利：オッズ不明の的中は計算できない件数として数える", () => {
  const c = compound([S("win", { odds: null })], 100);
  assert.equal(c.incomplete, 1);
  assert.equal(c.balance, 100);
});

test("1/4ケリー：locked 確率だけを使い、確率が無いカードは見送り扱い", () => {
  const items = [
    { settlement: S("win", { odds: 1.12, at: "2026-09-20T00:00:00+09:00" }), prob: 0.922 },
    { settlement: S("loss", { odds: 1.24, at: "2026-09-21T00:00:00+09:00" }), prob: 0.7542 }, // 期待値マイナス→見送り
    { settlement: S("win", { odds: 1.11, at: "2026-09-22T00:00:00+09:00" }), prob: null },     // locked 確率なし
  ];
  const k = quarterKelly(items, 100);
  assert.equal(k.bets, 1);
  assert.equal(k.skipped, 2);
  // f = ((1.12×0.922 − 1) ÷ 0.12) ÷ 4 = 0.068、利益 = 100 × 0.068 × 0.12
  assert.equal(k.profit, 0.82);
});

test("1/4ケリー：投入率は フルケリー÷4（25%を超えない）", () => {
  // フルケリー = (3 × 0.99 − 1) ÷ 2 = 0.985 → 1/4 = 0.24625
  const k = quarterKelly([{ settlement: S("win", { odds: 3 }), prob: 0.99 }], 100);
  assert.equal(k.balance, 149.25);       // 100 + 24.625 × 2
});
