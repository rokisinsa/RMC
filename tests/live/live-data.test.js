// live 段：現在の data/ を検証する（値は固定しない）。
// GPT 定時更新で新しい試合・カード・結果が追加されても、スキーマ・整合性・計算ルール・不変性が正しければ通る。
// 過去の値をここへ書き写して通す方式は使わない（移行時点の値の検証は snapshot 段のテストが担う）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, DATA_DIR, loadDatasets, loadSchemas, loadProEdgeConfig } from "../../scripts/load-node.js";
import { validateDataset } from "../../lib/validate.js";
import { checkLockedImmutable, checkMatchHistory, SYSTEMS } from "../../lib/integrity.js";
import { applyMatchUpdates, checkMatchUpdatesAppendOnly, pendingReviews } from "../../lib/match-updates.js";
import { buildViewModel } from "../../lib/view/model.js";
import { renderPage } from "../../lib/view/render.js";
import { RESULT_SYMBOL } from "../../lib/view/format.js";
import { verifyManifest } from "../../scripts/snapshot-manifest.js";

const cfg = loadProEdgeConfig();
const live = loadDatasets().datasets;
const snap = loadDatasets(join(ROOT, "snapshots", "2026-09-26-migration", "data")).datasets;
const vm = buildViewModel(structuredClone(live), { proEdgeConfig: cfg });
const sha = f => createHash("sha256").update(readFileSync(join(ROOT, f), "utf8").replace(/\r/g, "")).digest("hex");

test("live 段はスナップショットではなく現在のデータを読んでいる", () => {
  assert.notEqual(DATA_DIR, join(ROOT, "snapshots", "2026-09-26-migration", "data"));
});

test("現在のデータがスキーマ・整合性検査を error 0 件で通る", () => {
  assert.deepEqual(validateDataset(live, loadSchemas(), { proEdgeConfig: cfg }).filter(i => i.level === "error"), []);
});

test("06:45 基準点と移行スナップショットは不変", () => {
  assert.equal(sha("baseline/2026-09-26/baseline.json"), "86af8bc15919c671f435a94fa35329116afe5f894a995fa627e4d08e6642aab7");
  assert.deepEqual(verifyManifest(), []);
});

test("移行時点から見て、削除・書き換えが無い（追記だけ）", () => {
  for (const s of SYSTEMS) {
    if (!snap[s]) continue;
    assert.deepEqual(checkLockedImmutable(snap[s], live[s]).filter(i => i.level === "error"), [], s);
  }
  assert.deepEqual(checkMatchHistory(snap.matches, live.matches), []);
  assert.deepEqual(checkMatchUpdatesAppendOnly(snap.match_updates, live.match_updates), []);
  for (const s of ["recommendations", "value1", "value2"]) {
    assert.deepEqual(live[`legacy_analysis_${s}`], snap[`legacy_analysis_${s}`], `旧分析メモ ${s}`);
  }
  assert.deepEqual(live.legacy_unassigned, snap.legacy_unassigned);
  // 移行時点のカードはすべて残っている
  for (const s of SYSTEMS) {
    const ids = new Set(live[s].picks.map(p => p.id));
    for (const p of snap[s].picks) assert.ok(ids.has(p.id), `${s}: ${p.id}`);
  }
});

test("導出値（払戻し・損益・戦績・勝率・ROI）はデータに保存されていない", () => {
  const text = SYSTEMS.map(s => JSON.stringify(live[s])).join("\n");
  for (const key of ['"payout"', '"profit"', '"roi"', '"win_rate"', '"record"', '"net_profit"']) assert.ok(!text.includes(key), key);
});

test("推奨取引は全件 $100", () => {
  for (const p of live.recommendations.picks) assert.equal(p.stake, 100, p.id);
});

test("集計の整合（戦績・勝率・ROI・投入額・未確定・損益が各カードの精算結果と一致）", () => {
  const systems = [
    ["recommendations", vm.recommendations.summary, vm.recommendations.rows, r => true],
    ["experience", vm.experience.summary, vm.experience.rows, r => true],
    ["value1", vm.value1.official, vm.value1.rows, r => r.bucket === "official"],
    ["value2", vm.value2.official, vm.value2.rows, r => r.bucket === "official"],
    ["pro_edge", vm.pro_edge.official, vm.pro_edge.rows, r => r.bucket === "official"],
  ];
  for (const [name, s, rows, inOfficial] of systems) {
    const own = rows.filter(inOfficial).map(r => r.settlement);
    assert.equal(s.count, own.length, `${name} 件数`);
    assert.equal(s.settledGames, s.wins + s.losses, `${name} 戦績`);
    assert.equal(s.wins, own.filter(x => x.state === "win").length, `${name} 勝ち`);
    assert.equal(s.pending, own.filter(x => x.state === "pending").length, `${name} 未確定`);
    if (s.settledGames) assert.ok(Math.abs(s.winRate - (s.wins / s.settledGames) * 100) < 1e-9, `${name} 勝率`);
    if (s.settledStake) assert.ok(Math.abs(s.roi - (s.netProfit / s.settledStake) * 100) < 1e-9, `${name} ROI`);
    else assert.equal(s.roi, null, `${name} ROI（確定0件）`);
    const net = own.filter(x => (x.state === "win" || x.state === "loss") && x.profit != null).reduce((a, x) => a + x.profit, 0);
    assert.ok(Math.abs(s.netProfit - net) < 0.005, `${name} 純損益`);
    const planned = own.reduce((a, x) => a + (x.stake ?? 0), 0);
    assert.ok(Math.abs(s.plannedStake - planned) < 0.005, `${name} 総投入予定額`);
  }
  for (const r of [...vm.recommendations.rows, ...vm.experience.rows, ...vm.value1.rows, ...vm.value2.rows]) {
    assert.ok(RESULT_SYMBOL[r.settlement.state], r.id);
    if (r.settlement.state === "pending") assert.equal(r.settlement.profit, null, r.id);
  }
});

test("要確認の試合に、確認できていない結果が入っていない", () => {
  const eff = new Map(applyMatchUpdates(live.matches, live.match_updates).matches.map(m => [m.id, m]));
  for (const [id] of pendingReviews(live.match_updates)) {
    const m = eff.get(id);
    assert.ok(m, id);
    assert.ok(m.status !== "final" || m.provenance.at(-1).update_run_id.startsWith("mr-baseline") === false, id);
  }
});

test("複利：正式値は順序規則を満たすときだけ。満たさなければ参考値・取引順序未確定", () => {
  const html = renderPage(vm);
  for (const a of [vm.recommendations.compound_audit, vm.value1.compound_audit, vm.value2.compound_audit]) {
    if (a.status === "confirmed") assert.ok(a.official_order);
    if (a.status === "order_unconfirmed") assert.ok(a.reasons.length > 0);
  }
  if (vm.recommendations.compound_audit.status === "order_unconfirmed") assert.ok(html.includes("複利（参考値・取引順序未確定）"));
});

test("本データに④の架空サンプルは含まれず、V2 は本番モードで描画できる", () => {
  assert.ok(!JSON.stringify(live).includes("Sample League"));
  assert.ok(live.pro_edge.picks.every(p => !p.id.startsWith("pe-s")));
  const html = renderPage(vm, { demo: true });
  assert.ok(!html.includes("デモ表示"));
  for (const id of ["sec-rec", "sec-v1", "sec-v2", "sec-pe", "sec-exp"]) assert.ok(html.includes(`id="${id}"`), id);
  for (const bad of ["NaN", "undefined", "[object Object]"]) assert.ok(!html.includes(bad), bad);
});
