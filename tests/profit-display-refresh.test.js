import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDatasets, loadProEdgeConfig } from "../scripts/load-node.js";
import { buildViewModel } from "../lib/view/model.js";
import { summarizeSystem } from "../lib/buckets.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";
import { summarizeProEdge } from "../lib/pro-edge/summary.js";

const cfg = loadProEdgeConfig();

test("①②：正式採用の結果確定で上部収支と①の複利・1/4ケリーが実際に更新される", () => {
  const ds = structuredClone(loadDatasets().datasets);
  delete ds.match_updates;
  const m = ds.matches.matches.find(x => x.id === "2026-09-28-commanders-seahawks");
  assert.ok(m, "Seattle match exists");
  m.status = "scheduled";
  m.result = null;

  const before = buildViewModel(ds, { proEdgeConfig: cfg, now: "2026-09-27T19:00:00+09:00" });
  const recBefore = before.recommendations.rows.find(x => x.id === "rec-202609271444-seahawks");
  const v1Before = before.value1.rows.find(x => x.id === "v1-202609271444-seahawks");
  assert.equal(recBefore.settlement.state, "pending");
  assert.equal(v1Before.settlement.state, "pending");

  const recSummaryBefore = structuredClone(before.recommendations.summary);
  const compoundBefore = structuredClone(before.recommendations.compound);
  const kellyBefore = structuredClone(before.recommendations.kelly);
  const v1SummaryBefore = structuredClone(before.value1.official);

  m.status = "final";
  m.result = { final: { a: 0, b: 1 }, text: "Commanders 0-1 Seahawks" };
  const after = buildViewModel(ds, { proEdgeConfig: cfg, now: "2026-09-28T20:00:00+09:00" });
  const recAfter = after.recommendations.rows.find(x => x.id === "rec-202609271444-seahawks");
  const v1After = after.value1.rows.find(x => x.id === "v1-202609271444-seahawks");

  assert.equal(recAfter.settlement.state, "win");
  assert.equal(recAfter.settlement.payout, 129);
  assert.equal(recAfter.settlement.profit, 29);
  assert.equal(after.recommendations.summary.wins, recSummaryBefore.wins + 1);
  assert.equal(after.recommendations.summary.pending, recSummaryBefore.pending - 1);
  assert.equal(after.recommendations.summary.settledStake, recSummaryBefore.settledStake + 100);
  assert.equal(after.recommendations.summary.netProfit, recSummaryBefore.netProfit + 29);
  assert.notDeepEqual(after.recommendations.compound, compoundBefore);
  assert.equal(after.recommendations.kelly.bets, kellyBefore.bets + 1);
  assert.notEqual(after.recommendations.kelly.profit, kellyBefore.profit);

  assert.equal(v1After.settlement.state, "win");
  assert.equal(v1After.settlement.payout, 129);
  assert.equal(v1After.settlement.profit, 29);
  assert.equal(after.value1.official.wins, v1SummaryBefore.wins + 1);
  assert.equal(after.value1.official.pending, v1SummaryBefore.pending - 1);
  assert.equal(after.value1.official.settledStake, v1SummaryBefore.settledStake + 100);
  assert.equal(after.value1.official.netProfit, v1SummaryBefore.netProfit + 29);
});

test("③：VALUE②正式採用は結果確定で正式収支へ反映される", () => {
  const ds = makeDataset();
  const m = ds.matches.matches.find(x => x.id === "m3");
  const originalResult = structuredClone(m.result);
  m.status = "scheduled";
  m.result = null;
  const before = summarizeSystem(ds.value2, matchesById(ds)).official;
  assert.equal(before.pending, 1);
  assert.equal(before.settledGames, 0);

  m.status = "final";
  m.result = originalResult;
  const after = summarizeSystem(ds.value2, matchesById(ds)).official;
  assert.equal(after.pending, 0);
  assert.equal(after.wins, 1);
  assert.equal(after.settledStake, 100);
  assert.equal(after.netProfit, 76);
  assert.equal(after.roi, 76);
});

test("④：PRO EDGE accepted は結果確定で正式収支へ反映される", () => {
  const sample = makeProEdgeSample();
  const m = sample.matches.matches.find(x => x.id === "pe-m5");
  const M = () => new Map(sample.matches.matches.map(x => [x.id, x]));
  const before = summarizeProEdge(sample.pro_edge, M(), cfg).official;
  assert.equal(before.pending, 1);

  m.status = "final";
  m.result = { final: { a: 3, b: 0 }, text: "A 3-0 B" };
  const after = summarizeProEdge(sample.pro_edge, M(), cfg).official;
  assert.equal(after.pending, 0);
  assert.equal(after.wins, before.wins + 1);
  assert.equal(after.settledStake, before.settledStake + 100);
  assert.equal(after.netProfit, before.netProfit + 85);
});
