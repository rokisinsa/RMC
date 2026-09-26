// ④ PRO EDGE：no-vig・複数ブックメーカー・異常オッズ・fair odds・edge・EV・最低購入オッズ・Expert補正・final範囲
import { test } from "node:test";
import assert from "node:assert/strict";
import { noVig, marketProbability } from "../lib/pro-edge/market.js";
import { finalProbability, expertAdjustmentTotal, fairOdds, edge, expectedValue, minimumEntryOdds } from "../lib/pro-edge/pricing.js";
import { analyzePick } from "../lib/pro-edge/analyze.js";
import { loadProEdgeConfig } from "../scripts/load-node.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";

const cfg = loadProEdgeConfig();
const snap = (market, outcomes, bookmaker = "BookA") => ({ snapshot_id: `ps-${bookmaker}`, kind: "analysis", bookmaker, market, outcomes, observed_at: "2026-10-01T06:00:00+09:00", source: "x" });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("2-way no-vig：qA/(qA+qB)", () => {
  const r = noVig(snap("match_winner", { side_a: 1.8, side_b: 2.1 }), cfg);
  const qa = 1 / 1.8, qb = 1 / 2.1;
  assert.ok(r.ok);
  near(r.probabilities.side_a, qa / (qa + qb));
  near(r.probabilities.side_b, qb / (qa + qb));
  near(r.probabilities.side_a + r.probabilities.side_b, 1);
  near(r.overround, qa + qb);
});

test("3-way no-vig：3つの inverse odds を合計で正規化", () => {
  const r = noVig(snap("match_1x2", { side_a: 2.5, draw: 3.4, side_b: 2.9 }), cfg);
  const inv = [1 / 2.5, 1 / 3.4, 1 / 2.9], sum = inv[0] + inv[1] + inv[2];
  near(r.probabilities.side_a, inv[0] / sum);
  near(r.probabilities.draw, inv[1] / sum);
  near(r.probabilities.side_b, inv[2] / sum);
});

test("3-way 市場で引分オッズが欠けていたら計算しない", () => {
  const r = noVig(snap("match_1x2", { side_a: 2.5, side_b: 2.9 }), cfg);
  assert.equal(r.ok, false);
  assert.equal(r.probabilities, null);
  assert.match(r.issues.join(), /draw のオッズがない/);
});

test("複数ブックメーカー：2社以上なら consensus（no-vig 確率の平均）", () => {
  const a = snap("match_winner", { side_a: 2.1, side_b: 1.75 }, "BookA");
  const b = snap("match_winner", { side_a: 2.05, side_b: 1.8 }, "BookB");
  const r = marketProbability([a, b], "side_a", cfg);
  assert.equal(r.method, "consensus");
  near(r.probability, (noVig(a, cfg).probabilities.side_a + noVig(b, cfg).probabilities.side_a) / 2);
  assert.deepEqual(r.bookmakers, ["BookA", "BookB"]);
});

test("1社しかなければ consensus を作らない（single_book）", () => {
  const r = marketProbability([snap("match_winner", { side_a: 2.1, side_b: 1.75 })], "side_a", cfg);
  assert.equal(r.method, "single_book");
  const same = marketProbability([snap("match_winner", { side_a: 2.1, side_b: 1.75 }), snap("match_winner", { side_a: 2.0, side_b: 1.8 })], "side_a", cfg);
  assert.equal(same.probability, null);              // 同じ社の2件は consensus にしない
  assert.match(same.issues.join(), /2 社以上/);
});

test("異常オッズ：1以下・非数・上限超え・overround 異常を検出", () => {
  for (const bad of [1, 0.5, Number.NaN, 5000]) {
    assert.equal(noVig(snap("match_winner", { side_a: bad, side_b: 2 }), cfg).ok, false, String(bad));
  }
  const arb = noVig(snap("match_winner", { side_a: 2.2, side_b: 2.2 }), cfg);   // 合計 0.909（裁定）
  assert.equal(arb.ok, false);
  assert.match(arb.issues.join(), /1 未満/);
  const heavy = noVig(snap("match_winner", { side_a: 1.4, side_b: 1.6 }), cfg);  // 合計 1.339
  assert.match(heavy.issues.join(), /大きすぎる/);
  assert.equal(marketProbability([], "side_a", cfg).probability, null);
});

test("fair odds = 1 / final、edge = final − market、EV = final × offered − 1", () => {
  assert.equal(fairOdds(0.54), 1.8519);
  assert.equal(fairOdds(0), null);
  assert.equal(edge(0.54, 0.46), 0.08);
  assert.equal(edge(null, 0.46), null);
  assert.equal(expectedValue(0.54, 2.1), 0.134);
  assert.equal(expectedValue(0.52, 1.95), 0.014);
  assert.equal(expectedValue(0.54, null), null);
});

test("最低購入オッズ = (1 + required_EV) / final。required_EV は設定・カードごとに変更可能", () => {
  assert.equal(cfg.required_ev, 0.03);
  assert.equal(minimumEntryOdds(0.54, 0.03), 1.9074);
  assert.equal(minimumEntryOdds(0.54, 0.05), 1.9444);
  assert.ok(expectedValue(0.54, minimumEntryOdds(0.54, 0.03)) >= 0.03 - 1e-4);
});

test("Expert補正：base は上書きせず、final = base + Σ補正", () => {
  const adj = [{ adjustment_value: 0.02 }, { adjustment_value: -0.005 }];
  assert.equal(expertAdjustmentTotal(adj), 0.015);
  const r = finalProbability(0.52, adj);
  assert.equal(r.final_probability, 0.535);
  const { pro_edge } = makeProEdgeSample();
  const a = analyzePick(pro_edge.picks[0], cfg);
  assert.deepEqual([a.base_probability, a.expert_adjustment, a.final_probability], [0.52, 0.02, 0.54]);
  assert.equal(pro_edge.picks[0].locked.base_probability, 0.52);   // 元データは不変
});

test("final_probability は 0〜1 の範囲外を無効にする", () => {
  assert.equal(finalProbability(0.9, [{ adjustment_value: 0.15 }]).valid, false);
  assert.equal(finalProbability(0.05, [{ adjustment_value: -0.1 }]).valid, false);
  assert.equal(finalProbability(1, []).valid, false);
  assert.equal(finalProbability(0.5, []).valid, true);
});

test("edge に使った市場価格と、EV に使った提示価格の出典・取得時刻を追跡できる", () => {
  const { pro_edge } = makeProEdgeSample();
  const a = analyzePick(pro_edge.picks[0], cfg);
  assert.deepEqual(a.market_sources.map(s => [s.bookmaker, s.observed_at]),
    [["BookA", "2026-10-01T06:20:00+09:00"], ["BookB", "2026-10-01T06:25:00+09:00"]]);
  assert.deepEqual([a.offered_odds, a.offered_source.bookmaker, a.offered_source.observed_at, a.offered_source.source],
    [2.1, "BookA", "2026-10-01T06:20:00+09:00", "BookA 公開オッズページ"]);
});
