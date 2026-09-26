// ④ PRO EDGE：opening/bet/closing・CLV・評価指標（ROI・Hit Rate・Average EV・CLV・Brier・Log Loss・Calibration・期間）
import { test } from "node:test";
import assert from "node:assert/strict";
import { clv, priceTrail } from "../lib/pro-edge/clv.js";
import { metrics, calibration, windowedMetrics } from "../lib/pro-edge/evaluate.js";
import { summarizeProEdge } from "../lib/pro-edge/summary.js";
import { analyzePick } from "../lib/pro-edge/analyze.js";
import { loadProEdgeConfig } from "../scripts/load-node.js";
import { makeProEdgeSample, makeSeries } from "./fixtures/pro-edge-sample.js";

const cfg = loadProEdgeConfig();
const closing = outcomes => ({ snapshot_id: "ps-c", kind: "closing", bookmaker: "BookA", market: "match_winner", outcomes, observed_at: "2026-10-01T19:59:00+09:00", source: "x" });

test("opening / bet / closing を区別し、取得できない値は null", () => {
  const { pro_edge } = makeProEdgeSample();
  const a = analyzePick(pro_edge.picks[0], cfg);
  assert.deepEqual([a.opening_odds, a.bet_odds, a.closing_odds], [2.0, 2.08, 1.95]);
  const pending = analyzePick(pro_edge.picks[4], cfg);          // 試合前：始値・締切なし
  assert.deepEqual([pending.opening_odds, pending.bet_odds, pending.closing_odds], [null, 1.85, null]);
  assert.deepEqual(priceTrail({ selection: "side_a" }), { opening_odds: null, bet_odds: null, closing_odds: null });
});

test("価格ベースCLV = bet / closing − 1（＋は締切より良い価格）", () => {
  assert.equal(clv({ selection: "side_a", bet_odds: 2.1, closing_snapshot: closing({ side_a: 2.0, side_b: 1.85 }) }, cfg).clv_price, 0.05);
  assert.equal(clv({ selection: "side_a", bet_odds: 1.9, closing_snapshot: closing({ side_a: 2.0, side_b: 1.85 }) }, cfg).clv_price, -0.05);
});

test("確率ベースCLV = 締切 no-vig 確率 − 1/bet（＋は締切適正ラインに対して期待値プラス）", () => {
  const c = closing({ side_a: 1.95, side_b: 1.9 });
  const r = clv({ selection: "side_a", bet_odds: 2.08, closing_snapshot: c }, cfg);
  const pc = (1 / 1.95) / (1 / 1.95 + 1 / 1.9);
  assert.equal(r.clv_probability, Math.round((pc - 1 / 2.08) * 1e6) / 1e6);
  assert.equal(r.closing_ev, Math.round((2.08 * pc - 1) * 1e6) / 1e6);
  assert.equal(Math.sign(r.clv_probability), Math.sign(r.closing_ev));
});

test("価格CLVがプラスでも、確率CLVはマイナスになりうる（両方を別々に持つ）", () => {
  const { pro_edge } = makeProEdgeSample();
  const a = analyzePick(pro_edge.picks[1], cfg);                 // 2.45 で購入・締切 2.40（3-way）
  assert.ok(a.clv.clv_price > 0);
  assert.ok(a.clv.clv_probability < 0);
});

test("締切オッズが無ければ CLV は未計算。片側だけの締切では確率CLVを出さない", () => {
  assert.equal(clv({ selection: "side_a", bet_odds: 2, closing_snapshot: null }, cfg).status, "no_closing_odds");
  assert.equal(clv({ selection: "side_a", bet_odds: null, closing_snapshot: closing({ side_a: 2, side_b: 1.8 }) }, cfg).status, "no_bet_odds");
  const oneSided = clv({ selection: "side_a", bet_odds: 2.1, closing_snapshot: closing({ side_a: 2.0 }) }, cfg);
  assert.equal(oneSided.clv_price, 0.05);
  assert.equal(oneSided.clv_probability, null);
  assert.equal(oneSided.status, "closing_not_devigable");
});

test("accepted は本成績、watch は参考成績（$100を提示価格で仮定）、rejected は集計しない", () => {
  const { matches, pro_edge } = makeProEdgeSample();
  const r = summarizeProEdge(pro_edge, new Map(matches.matches.map(m => [m.id, m])), cfg);
  assert.deepEqual(r.decision_counts, { accepted: 3, watch: 1, rejected: 1 });
  assert.deepEqual([r.official.wins, r.official.losses, r.official.pending, r.official.netProfit], [1, 1, 1, 8]);
  assert.equal(r.official.roi, 4);                              // (108 − 100) ÷ 200
  assert.deepEqual([r.reference.count, r.reference.netProfit], [1, 95]);   // 1.95 × $100 仮定
  assert.equal(r.groups.excluded.length, 1);
  assert.ok(![...r.groups.official, ...r.groups.reference].some(g => g.pick.locked.decision === "rejected"));
});

test("ROI・Hit Rate・Average EV・Average/Median CLV・Brier・Log Loss", () => {
  const items = [
    { settlement: { state: "win", stake: 100, profit: 100, orderKey: "2026-01-01T00:00:00Z" }, analysis: { final_probability: 0.6, ev: 0.2, ev_at_bet: 0.18, clv: { clv_price: 0.04, clv_probability: 0.01 } } },
    { settlement: { state: "loss", stake: 100, profit: -100, orderKey: "2026-01-02T00:00:00Z" }, analysis: { final_probability: 0.6, ev: 0.1, ev_at_bet: null, clv: { clv_price: -0.02, clv_probability: null } } },
    { settlement: { state: "win", stake: 100, profit: 50, orderKey: "2026-01-03T00:00:00Z" }, analysis: { final_probability: 0.7, ev: 0.05, ev_at_bet: 0.06, clv: { clv_price: 0.1, clv_probability: 0.03 } } },
    { settlement: { state: "pending", stake: 100, profit: null, projectedProfit: null, orderKey: "2026-01-04T00:00:00Z" }, analysis: { final_probability: 0.5, ev: 0.3, clv: { clv_price: null, clv_probability: null } } },
  ];
  const m = metrics(items);
  assert.equal(m.sample_size, 3);
  assert.equal(m.roi, 50 / 300 * 100);
  assert.equal(m.hit_rate, 2 / 3 * 100);
  assert.ok(Math.abs(m.average_ev_decision - (0.2 + 0.1 + 0.05) / 3) < 1e-12);
  assert.equal(m.average_ev_bet, 0.12);
  assert.equal(m.clv_sample_size, 3);
  assert.ok(Math.abs(m.average_clv_price - 0.04) < 1e-12);
  assert.equal(m.median_clv_price, 0.04);
  assert.equal(m.clv_probability_sample_size, 2);
  assert.equal(m.median_clv_probability, 0.02);
  assert.ok(Math.abs(m.brier - ((0.4 ** 2 + 0.6 ** 2 + 0.3 ** 2) / 3)) < 1e-12);
  assert.ok(Math.abs(m.log_loss - (-(Math.log(0.6) + Math.log(0.4) + Math.log(0.7)) / 3)) < 1e-12);
});

test("Calibration：少数サンプルでは値を出さない", () => {
  const small = calibration(makeSeries(30), cfg.evaluation.calibration);
  assert.equal(small.status, "insufficient_sample");
  assert.ok(small.bins.every(b => b.mean_predicted === null && b.observed_rate === null));
  const big = calibration(makeSeries(150, { p: 0.55 }), cfg.evaluation.calibration);
  assert.equal(big.status, "ok");
  const bin = big.bins.find(b => b.count > 0);
  assert.equal(bin.count, 150);                                   // 全件 0.55 の帯
  assert.equal(bin.status, "ok");
  assert.ok(Math.abs(bin.mean_predicted - 0.55) < 1e-9);
  assert.ok(big.bins.filter(b => b.count === 0).every(b => b.status === "insufficient_sample"));
});

test("直近20/50/100/全期間：件数が足りない期間は値を出さず sample_size を示す", () => {
  const w = windowedMetrics(makeSeries(60), cfg);
  assert.equal(w.last_20.status, "ok");
  assert.equal(w.last_20.sample_size, 20);
  assert.equal(w.last_50.sample_size, 50);
  assert.deepEqual(w.last_100, { status: "insufficient_sample", sample_size: 60, required_sample: 100 });
  assert.equal(w.all.sample_size, 60);
  const few = windowedMetrics(makeSeries(5), cfg);
  assert.equal(few.all.status, "insufficient_sample");
  assert.equal(few.all.sample_size, 5);
  assert.equal(few.last_20.roi, undefined);
});

test("直近N件は試合開始順の最後のN件（入力順に依存しない）", () => {
  const series = makeSeries(30);
  const last20 = windowedMetrics(series, cfg).last_20;
  const shuffled = windowedMetrics([...series].reverse(), cfg).last_20;
  assert.deepEqual(shuffled, last20);
  assert.deepEqual(last20, { status: "ok", ...metrics(series.slice(-20)) });
});
