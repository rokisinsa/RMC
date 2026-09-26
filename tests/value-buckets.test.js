import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPick, summarizeSystem } from "../lib/buckets.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";

const ds = makeDataset();
const M = matchesById(ds);
const v1 = id => ds.value1.picks.find(p => p.id === id);
const cls = id => classifyPick(v1(id), M.get(v1(id).match_id));

test("VALUE①：正式VALUE は本成績、監視は参考成績、除外は集計外", () => {
  assert.equal(cls("v1-a"), "official");
  assert.equal(cls("v1-c"), "reference");
  assert.equal(cls("v1-g"), "excluded");
});

test("VALUE①：条件付きは condition.met=true が試合開始前に確認された場合だけ本成績", () => {
  assert.equal(cls("v1-d"), "official");            // 開始前に成立確認
  assert.equal(cls("v1-e"), "conditional_unmet");   // met=null
  assert.equal(cls("v1-f"), "conditional_unmet");   // 開始後に確認
  const p = structuredClone(v1("v1-d"));
  p.condition.met = false;
  assert.equal(classifyPick(p, M.get(p.match_id)), "conditional_unmet");
});

test("VALUE①：本成績（正式＋開始前成立の条件付き）", () => {
  const s = summarizeSystem(ds.value1, M).official;
  assert.equal(s.count, 3);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 2);
  assert.equal(s.netProfit, -175);   // +25 −100 −100
  assert.equal(s.settledStake, 300);
  assert.equal(Number(s.roi.toFixed(4)), -58.3333);
  assert.equal(s.winRate.toFixed(1), "33.3");
});

test("VALUE①：監視は本成績へ入らず、$100仮定の参考成績として別集計", () => {
  const r = summarizeSystem(ds.value1, M);
  assert.equal(r.reference.count, 3);
  assert.equal(r.reference.wins, 2);
  assert.equal(r.reference.netProfit, 35);      // レンジのみの的中は金額未計算
  assert.equal(r.reference.amountMissing, 1);
  assert.equal(r.reference.pending, 1);
  assert.equal(r.reference.openUncomputed, 1);
  // 監視の勝ちが本成績に紛れ込んでいない
  assert.ok(!r.groups.official.some(g => g.pick.locked.verdict === "watch"));
});

test("VALUE①：未成立の条件付きは本成績にも参考成績にも入れない", () => {
  const r = summarizeSystem(ds.value1, M);
  assert.equal(r.conditionalUnmet.count, 2);
  const ids = [...r.groups.official, ...r.groups.reference].map(g => g.pick.id);
  assert.ok(!ids.includes("v1-e") && !ids.includes("v1-f"));
});

test("VALUE①：判定内訳はデータから数える（手書きしない）", () => {
  assert.deepEqual(summarizeSystem(ds.value1, M).verdictCounts, { formal: 2, watch: 3, conditional: 3, excluded: 1 });
});

test("VALUE②：採用は本成績、監視は参考成績", () => {
  const r = summarizeSystem(ds.value2, M);
  assert.equal(r.official.count, 1);
  assert.equal(r.official.netProfit, 76);
  assert.equal(r.official.roi, 76);
  assert.equal(r.reference.count, 1);
  assert.equal(r.reference.pending, 1);
});

test("推奨取引・経験値取引は全件が本成績", () => {
  assert.equal(summarizeSystem(ds.recommendations, M).official.count, 8);
  const e = summarizeSystem(ds.experience, M).official;
  assert.equal(e.netProfit, 15);
  assert.equal(e.plannedStake, 650);
  assert.equal(e.settledStake, 300);
  assert.equal(e.openProjectedProfit, 31.5);
  assert.equal(e.roi, 5);
});

test("1試合の結果を1か所変えると、その試合を参照する全系統の集計が連動する", () => {
  const d = makeDataset();
  const before = {
    rec: summarizeSystem(d.recommendations, matchesById(d)).official.netProfit,
    v1: summarizeSystem(d.value1, matchesById(d)).official.netProfit,
  };
  // m1 を 2-0 → 0-1（ホーム敗戦）へ訂正
  d.matches.matches.find(m => m.id === "m1").result.final = { home: 0, away: 1 };
  const after = {
    rec: summarizeSystem(d.recommendations, matchesById(d)).official.netProfit,
    v1: summarizeSystem(d.value1, matchesById(d)).official.netProfit,
    exp: summarizeSystem(d.experience, matchesById(d)).official.netProfit,
  };
  assert.equal(after.rec, before.rec - 120);   // rec-r1: +20 → −100
  assert.equal(after.v1, before.v1 - 125);     // v1-a: +25 → −100
  assert.equal(after.exp, -300);               // exp-e1: +15 → −300
});
