// baseline（手順0）の整合性。
// - displayed（現行 JS の再現値）が GitHub Pages 本番の実表示と一致すること
// - expected が legacy_rows と現在の lib から再計算した値と一致すること（lib を変えたら baseline 再生成が必要）
// - 現在の誤表示を「正解」として固定していないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/load-node.js";
import { settlePick } from "../lib/settlement.js";
import { summarize } from "../lib/summary.js";

const dir = join(ROOT, "baseline", "2026-09-26");
const baseline = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8"));
const live = JSON.parse(readFileSync(join(dir, "live-pages-snapshot.json"), "utf8"));

test("baseline は基準タグのコミットを記録している", () => {
  assert.equal(baseline.meta.ref, "baseline-2026-09-26");
  assert.equal(baseline.meta.commit, "02e5167513133cd31106f1f9bb265ef0aa37b186");
});

test("現行JSの再現値が本番ページの実表示と一致する", () => {
  const d = baseline.displayed;
  const reproduced = { ...d.recommendations, ...d.experience };
  for (const [id, value] of Object.entries(reproduced)) assert.equal(value, live.values[id], id);
  for (const id of Object.keys(live.values).filter(k => k.startsWith("odds"))) {
    const v = id.startsWith("odds2") ? d.value2_hardcoded[id] : d.value1_hardcoded[id];
    assert.equal(v, live.values[id], id);
  }
  assert.equal(d.calibration, live.values.calibrationStatus);
  assert.deepEqual(d.probability_heads_rendered, live.probability_heads);
});

const legacySettle = (status, stake, odds, notional = null) => settlePick({
  id: "x", stake, odds_taken: odds, market: "other", selection: "home",
  settlement_override: status === "open" ? null : { state: status, reason: "legacy", set_at: "2026-09-26T06:45:58+09:00", source: null },
}, undefined, { notionalStake: notional });

test("expected（推奨・経験値）は legacy_rows から再計算した値と一致", () => {
  const rec = baseline.legacy_rows.recommendations.map(r => legacySettle(r.status, r.data_stake, r.odds_taken_provisional));
  assert.deepEqual(summarize(rec), baseline.expected.recommendations.all_rows);
  const exp = baseline.legacy_rows.experience.map(r => legacySettle(r.status, r.data_stake, r.odds_taken_provisional));
  assert.deepEqual(summarize(exp), baseline.expected.experience.all_rows);
});

test("expected（VALUE①②）は legacy_rows から再計算した値と一致", () => {
  const calc = (rows, official, reference) => ({
    official: summarize(rows.filter(r => official.includes(r.verdict)).map(r => legacySettle(r.status, 100, r.odds_taken_provisional))),
    reference: summarize(rows.filter(r => reference.includes(r.verdict)).map(r => legacySettle(r.status, null, r.odds_taken_provisional, 100))),
  });
  const v1 = calc(baseline.legacy_rows.value1, ["formal"], ["watch"]);
  assert.deepEqual(v1.official, baseline.expected.value1.official);
  assert.deepEqual(v1.reference, baseline.expected.value1.reference);
  const v2 = calc(baseline.legacy_rows.value2, ["adopted"], ["watch"]);
  assert.deepEqual(v2.official, baseline.expected.value2.official);
  assert.deepEqual(v2.reference, baseline.expected.value2.reference);
});

test("現在の誤表示を正解として固定していない", () => {
  const e = baseline.expected;
  // 推奨：予想損益 −$1,986 ではなく、オッズ既知1件の +$14 と未計算20件
  assert.equal(baseline.displayed.recommendations.openProfit, "$-1986.00");
  assert.equal(e.recommendations.all_rows.openProjectedProfit, 14);
  assert.equal(e.recommendations.all_rows.openUncomputed, 20);
  // 推奨：総投入予定額と確定済み投入額を分離
  assert.equal(e.recommendations.all_rows.plannedStake, 3000);
  assert.equal(e.recommendations.all_rows.settledStake, 900);
  // VALUE①：表示 +$52 / 2戦2勝 ではなく、正式VALUEのみ 1勝1敗 −$75
  assert.equal(baseline.displayed.value1_hardcoded.oddsSimpleProfit, "+$52.00");
  assert.equal(e.value1.official.netProfit, -75);
  assert.equal(e.value1.official.wins, 1);
  assert.equal(e.value1.official.losses, 1);
  assert.equal(e.value1.official.roi, -37.5);
  assert.deepEqual(e.value1.verdict_counts, { conditional: 1, formal: 4, watch: 4 });
});
