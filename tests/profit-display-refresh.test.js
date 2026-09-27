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

  // ①：時系列の最後に置いた正式推奨を pending → win にして、上部6項目の再計算を検証する。
  ds.matches.matches.push({
    id:"m7", sport:"サッカー", competition:"Fixture League", side_a:"m7-a", side_b:"m7-b", home_side:"unknown",
    venue:null, start_at:"2026-10-01T20:00:00+09:00", start_time_status:"recorded", status:"scheduled", result:null,
    sources:["fixture"], verified_at:null, note:null, provenance:[{update_run_id:"mr-fixture",changes:[],note:null}]
  });
  const template=structuredClone(ds.recommendations.picks.find(p=>p.id==="rec-r7"));
  Object.assign(template,{
    id:"rec-r9", match_id:"m7", selection:"side_b", odds_taken:1.2, stake:100,
    discovered_at:"2026-10-01T06:10:00+09:00", locked_at:"2026-10-01T06:30:00+09:00"
  });
  template.locked={...template.locked,prob:0.9};
  ds.recommendations.picks.push(template);

  const recBefore = summarizeSystem(ds.recommendations, matchesById(ds));
  const compBefore = compound(recBefore.groups.official.map(g=>g.settlement),100);
  const kellyBefore = quarterKelly(recBefore.groups.official.map(g=>({settlement:g.settlement,prob:g.pick.locked?.prob??null})),100);
  assert.equal(recBefore.groups.official.find(g=>g.pick.id==="rec-r9").settlement.state,"pending");

  const m7=ds.matches.matches.find(x=>x.id==="m7");
  m7.status="final";
  m7.result={final:{a:0,b:1},text:"m7-a 0-1 m7-b"};
  const recAfter = summarizeSystem(ds.recommendations, matchesById(ds));
  const compAfter = compound(recAfter.groups.official.map(g=>g.settlement),100);
  const kellyAfter = quarterKelly(recAfter.groups.official.map(g=>({settlement:g.settlement,prob:g.pick.locked?.prob??null})),100);
  const rr=recAfter.groups.official.find(g=>g.pick.id==="rec-r9").settlement;
  assert.deepEqual([rr.state,rr.payout,rr.profit],["win",120,20]);
  assert.equal(recAfter.official.wins,recBefore.official.wins+1);
  assert.equal(recAfter.official.pending,recBefore.official.pending-1);
  assert.equal(recAfter.official.settledStake,recBefore.official.settledStake+100);
  assert.equal(recAfter.official.netProfit,recBefore.official.netProfit+20);
  assert.notDeepEqual(compAfter,compBefore);
  assert.equal(kellyAfter.bets,kellyBefore.bets+1);
  assert.notEqual(kellyAfter.profit,kellyBefore.profit);

  // ②：同様にVALUE① formalの結果確定で正式収支が動く。
  const m1=ds.matches.matches.find(x=>x.id==="m1");
  const finalM1=structuredClone(m1.result);
  m1.status="scheduled"; m1.result=null;
  const v1Before=summarizeSystem(ds.value1,matchesById(ds));
  assert.equal(v1Before.groups.official.find(g=>g.pick.id==="v1-a").settlement.state,"pending");
  m1.status="final"; m1.result=finalM1;
  const v1After=summarizeSystem(ds.value1,matchesById(ds));
  const vr=v1After.groups.official.find(g=>g.pick.id==="v1-a").settlement;
  assert.deepEqual([vr.state,vr.payout,vr.profit],["win",125,25]);
  assert.equal(v1After.official.wins,v1Before.official.wins+1);
  assert.equal(v1After.official.pending,v1Before.official.pending-1);
  assert.equal(v1After.official.settledStake,v1Before.official.settledStake+100);
  assert.equal(v1After.official.netProfit,v1Before.official.netProfit+25);
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
