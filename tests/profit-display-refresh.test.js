import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProEdgeConfig } from "../scripts/load-node.js";
import { summarizeSystem } from "../lib/buckets.js";
import { compound, quarterKelly } from "../lib/summary.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";
import { summarizeProEdge } from "../lib/pro-edge/summary.js";

const cfg = loadProEdgeConfig();

test("①②：正式採用の結果確定で上部収支と①の複利・1/4ケリーが実際に更新される", () => {
  const ds = makeDataset();
  const m = ds.matches.matches.find(x => x.id === "m1");
  const finalResult = structuredClone(m.result);

  // 同じ試合を①推奨と②VALUE①の正式カードが参照している状態で、結果未確定→確定を再現。
  m.status = "scheduled";
  m.result = null;
  const recBefore = summarizeSystem(ds.recommendations, matchesById(ds));
  const v1Before = summarizeSystem(ds.value1, matchesById(ds));
  const compBefore = compound(recBefore.groups.official.map(g => g.settlement), 100);
  const kellyBefore = quarterKelly(recBefore.groups.official.map(g => ({ settlement:g.settlement, prob:g.pick.locked?.prob ?? null })), 100);
  assert.equal(recBefore.groups.official.find(g=>g.pick.id==="rec-r1").settlement.state, "pending");
  assert.equal(v1Before.groups.official.find(g=>g.pick.id==="v1-a").settlement.state, "pending");

  m.status = "final";
  m.result = finalResult;
  const recAfter = summarizeSystem(ds.recommendations, matchesById(ds));
  const v1After = summarizeSystem(ds.value1, matchesById(ds));
  const compAfter = compound(recAfter.groups.official.map(g => g.settlement), 100);
  const kellyAfter = quarterKelly(recAfter.groups.official.map(g => ({ settlement:g.settlement, prob:g.pick.locked?.prob ?? null })), 100);

  const rr = recAfter.groups.official.find(g=>g.pick.id==="rec-r1").settlement;
  assert.deepEqual([rr.state,rr.payout,rr.profit], ["win",120,20]);
  assert.equal(recAfter.official.wins, recBefore.official.wins + 1);
  assert.equal(recAfter.official.pending, recBefore.official.pending - 1);
  assert.equal(recAfter.official.settledStake, recBefore.official.settledStake + 100);
  assert.equal(recAfter.official.netProfit, recBefore.official.netProfit + 20);
  assert.notDeepEqual(compAfter, compBefore);
  assert.equal(kellyAfter.bets, kellyBefore.bets + 1);
  assert.notEqual(kellyAfter.profit, kellyBefore.profit);

  const vr = v1After.groups.official.find(g=>g.pick.id==="v1-a").settlement;
  assert.deepEqual([vr.state,vr.payout,vr.profit], ["win",125,25]);
  assert.equal(v1After.official.wins, v1Before.official.wins + 1);
  assert.equal(v1After.official.pending, v1Before.official.pending - 1);
  assert.equal(v1After.official.settledStake, v1Before.official.settledStake + 100);
  assert.equal(v1After.official.netProfit, v1Before.official.netProfit + 25);
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
