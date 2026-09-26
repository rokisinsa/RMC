// 手順3：V2 画面（lib/view）のテスト。表示用モデルと HTML 描画だけを検査し、①②③の判定・集計ロジックには触れない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ROOT, loadDatasets, loadProEdgeConfig, DATA_FILES } from "../scripts/load-node.js";
import { buildViewModel } from "../lib/view/model.js";
import { renderPage } from "../lib/view/render.js";
import { money, amount, jst } from "../lib/view/format.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";

const cfg = loadProEdgeConfig();
const fresh = () => structuredClone(loadDatasets().datasets);
const vmOf = ds => buildViewModel(ds, { proEdgeConfig: cfg });
const vm = vmOf(fresh());
const row = (list, id) => list.rows.find(r => r.id === id);
function withDemo(ds) {
  const s = makeProEdgeSample();
  return { ...ds, matches: { ...ds.matches, matches: [...ds.matches.matches, ...s.matches.matches] }, pro_edge: s.pro_edge };
}

test("6データファイル（＋系統未確定ログ）を読み込める", () => {
  const { datasets, missing } = loadDatasets();
  for (const k of ["matches", "recommendations", "experience", "value1", "value2", "pro_edge"]) assert.ok(datasets[k], k);
  assert.deepEqual(missing, []);
  assert.equal(Object.keys(DATA_FILES).length, 7);
});

test("matches との join：試合事実（競技・大会・開始・結果）は matches.json から", () => {
  const r = row(vm.recommendations, "rec-legacy-lyon");
  assert.equal(r.match.card, "セルヴェットFC vs オリンピック・リヨン");
  assert.equal(r.match.start_at, "2026-09-24T01:45:00+09:00");
  assert.equal(r.result_text, "Servette 0-8 Lyon（前半 0-4）");
  const loud = [vm.recommendations, vm.value1, vm.value2].map(v => v.rows.find(x => x.match?.id === "2026-09-26-loud-edg"));
  assert.ok(loud.every(x => x.match.card === "LOUD vs EDward Gaming"));      // 同じ試合事実を共有
  assert.ok(new Set(loud.map(x => x.id)).size === 3);                          // 分析判断は別々
});

test("① 推奨：戦績・勝率・確定純損益・ROI・総投入予定額・確定済み投入額・未確定件数", () => {
  const s = vm.recommendations.summary;
  assert.deepEqual([s.settledGames, s.wins, s.losses], [9, 7, 2]);
  assert.equal(s.winRate.toFixed(1), "77.8");
  assert.equal(s.netProfit, -87);
  assert.equal(s.roi.toFixed(2), "-9.67");
  assert.deepEqual([s.plannedStake, s.settledStake, s.pending], [3000, 900, 21]);
  assert.equal(vm.recommendations.rows.length, 30);
});

test("unknown odds：オッズ不明の未確定は −$100 にせず未計算", () => {
  const s = vm.recommendations.summary;
  assert.deepEqual([s.openProjectedProfit, s.openProjectedCount, s.openUncomputed], [14, 1, 20]);
  const r = row(vm.recommendations, "rec-legacy-kaz-uzb-rec");
  assert.equal(r.settlement.projectedProfit, null);
  assert.ok(r.quality.some(q => q.label === "オッズ 未確認"));
  assert.ok(!renderPage(vm).includes("-$1986"));
});

test("range odds：レンジしか無いオッズは一点に固定せず、金額未計算・品質表示あり", () => {
  const kc = row(vm.value1, "v1-legacy-kc-xlg");
  assert.equal(kc.odds_taken, null);
  assert.deepEqual([kc.market_odds.min, kc.market_odds.max], [1.17, 1.2]);
  assert.equal(kc.settlement.profit, null);
  assert.ok(kc.quality.some(q => q.label.startsWith("オッズ レンジのみ")));
  assert.equal(vm.value1.reference.amountMissing, 1);
});

test("② VALUE①：本成績（正式）と参考成績（監視）を混ぜない", () => {
  const v = vm.value1;
  assert.deepEqual([v.official.wins, v.official.losses, v.official.netProfit, v.official.roi], [1, 1, -75, -37.5]);
  assert.deepEqual([v.reference.wins, v.reference.netProfit, v.reference.amountMissing], [2, 35, 1]);
  assert.ok(v.rows.filter(r => r.bucket === "official").every(r => ["formal", "conditional"].includes(r.locked.verdict)));
  assert.ok(v.rows.filter(r => r.bucket === "reference").every(r => r.locked.verdict === "watch"));
});

test("conditional VALUE：条件成立が試合前に確認されていなければ集計外（本成績にも参考にも入れない）", () => {
  const b = row(vm.value1, "v1-legacy-bul-por-u21");
  assert.equal(b.bucket, "conditional_unmet");
  assert.equal(b.settlement.state, "loss");                                   // 試合結果（Portugal敗戦）は事実として表示
  assert.ok(b.quality.some(q => q.label === "条件成立 未確認"));
  assert.equal(vm.value1.official.count + vm.value1.reference.count + vm.value1.conditional_unmet.count, 9);
});

test("③ VALUE②：採用＝本成績、監視＝参考成績。VALUE①とは別集計", () => {
  const v = vm.value2;
  assert.deepEqual([v.official.count, v.official.pending, v.official.openProjectedProfit], [1, 1, 76]);
  assert.deepEqual([v.reference.count, v.reference.pending], [1, 1]);
  assert.notEqual(v.official, vm.value1.official);
  assert.equal(row(v, "v2-legacy-ge-vit").bucket, "official");
  assert.equal(row(v, "v2-legacy-loud-edg").bucket, "reference");
});

test("④ PRO EDGE：本データは0件（サンプル不足表示）、デモデータで本成績と参考成績を別集計", () => {
  assert.equal(vm.pro_edge.rows.length, 0);
  assert.equal(vm.pro_edge.evaluation.official.all.status, "insufficient_sample");
  const demo = vmOf(withDemo(fresh()));
  assert.deepEqual(demo.pro_edge.decision_counts, { accepted: 3, watch: 1, rejected: 1 });
  assert.deepEqual([demo.pro_edge.official.netProfit, demo.pro_edge.official.roi], [8, 4]);
  assert.equal(demo.pro_edge.reference.netProfit, 95);
  const rej = demo.pro_edge.rows.find(r => r.id === "pe-s4");
  assert.equal(rej.bucket, "excluded");
  // ①②③の集計はデモを混ぜても変わらない
  assert.deepEqual(demo.recommendations.summary, vm.recommendations.summary);
  assert.deepEqual(demo.value1.official, vm.value1.official);
});

test("duplicate_review：6組12件を削除・統合せず「重複確認中」と表示", () => {
  assert.deepEqual(vm.recommendations.duplicates, { rows: 12, groups: 6 });
  const html = renderPage(vm);
  assert.equal((html.match(/>重複確認中</g) ?? []).length, 12);
});

test("locked probability：試合前に固定された値だけを事前確率として表示し、参考再計算は別表示", () => {
  const lyon = row(vm.recommendations, "rec-legacy-lyon");
  assert.equal(lyon.locked.prob, 0.922);
  assert.equal(lyon.recalculated_reference[0].prob, 0.9103);
  const cor = row(vm.recommendations, "rec-legacy-cor");
  assert.equal(cor.locked.prob, null);
  const html = renderPage(vm);
  const lyonDetail = html.slice(html.indexOf('id="d-rec-legacy-lyon"'), html.indexOf('id="d-rec-legacy-lyon"') + 3000);
  assert.ok(lyonDetail.includes("<th>事前確率</th><td>92.2%</td>"));
  assert.ok(lyonDetail.includes("現在モデルによる参考再計算（事前確率ではありません）"));
  const corDetail = html.slice(html.indexOf('id="d-rec-legacy-cor"'), html.indexOf('id="d-rec-legacy-cor"') + 3000);
  assert.ok(corDetail.includes("<th>事前確率</th><td><span class=\"muted\">記録なし</span></td>"));
  assert.ok(!corDetail.includes("<th>事前確率</th><td>94.9%"));                  // 再計算値を事前確率として出さない
});

test("result update propagation：matches の結果を1か所変えると、共有する全系統の表示が連動", () => {
  const ds = fresh();
  const m = ds.matches.matches.find(x => x.id === "2026-09-26-loud-edg");
  m.status = "final";
  m.result = { final: { a: 2, b: 0 }, text: "LOUD 2-0 EDG" };
  const after = vmOf(ds);
  assert.equal(row(after.recommendations, "rec-legacy-loud-edg-rec").settlement.state, "win");
  assert.equal(row(after.value1, "v1-legacy-loud-edg").settlement.state, "win");
  assert.equal(row(after.value2, "v2-legacy-loud-edg").settlement.state, "win");
  assert.equal(after.recommendations.summary.wins, vm.recommendations.summary.wins + 1);
  assert.equal(after.recommendations.summary.pending, vm.recommendations.summary.pending - 1);
  assert.equal(row(after.recommendations, "rec-legacy-loud-edg-rec").result_text, "LOUD 2-0 EDG");
});

test("$100 計算：推奨は1件 $100、払戻し = $100 × オッズ", () => {
  assert.ok(vm.recommendations.rows.every(r => r.settlement.stake === 100));
  const r = row(vm.recommendations, "rec-legacy-prz-rin");
  assert.deepEqual([r.settlement.payout, r.settlement.profit], [119, 19]);
  const html = renderPage(vm);
  assert.ok(html.includes("<td class=\"money\">$119.00</td>"));
  assert.ok(html.includes("+$19.00"));
});

test("ROI = 確定純損益 ÷ 確定済み投入額（未確定・返金は含めない）", () => {
  const s = vm.recommendations.summary;
  assert.equal(s.roi, (s.netProfit / s.settledStake) * 100);
  assert.equal(vm.experience.summary.roi, 5);
  assert.equal(vm.value2.official.roi, null);                                  // 確定0件
});

test("pending：未確定は予定表示・勝敗に数えない", () => {
  const r = row(vm.recommendations, "rec-legacy-spain-czech-rec");
  assert.equal(r.settlement.state, "pending");
  assert.equal(r.settlement.projectedProfit, 14);
  const html = renderPage(vm);
  assert.ok(html.includes("$114.00 予定"));
  assert.ok(html.includes("+$14.00 予定"));
});

test("データ品質：開始時刻・オッズ・結果・条件の未確認を隠さない", () => {
  const labels = id => [vm.recommendations, vm.value1].flatMap(v => v.rows).find(r => r.id === id).quality.map(q => q.label);
  assert.ok(labels("rec-legacy-fearx").includes("開始時刻 未確認"));
  assert.ok(labels("rec-legacy-oddik-procyon").includes("開始時刻 要確認（候補が食い違い）"));
  assert.ok(labels("v1-legacy-fin-fra").includes("結果 未確認（開始済み・未記録）"));
  assert.ok(labels("rec-legacy-jpn-nep-rec").includes("オッズ 未確認"));
  assert.ok(labels("v1-legacy-bul-por-u21").includes("条件成立 未確認"));
  assert.ok(labels("v1-legacy-loud-edg").includes("独立性 要確認"));
});

test("HTML render smoke test：4系統が別セクションで描画され、NaN / undefined が出ない", () => {
  for (const v of [vm, vmOf(withDemo(fresh()))]) {
    const html = renderPage(v, { demo: v !== vm });
    for (const id of ["sec-rec", "sec-v1", "sec-v2", "sec-pe", "sec-exp", "sec-unassigned"]) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(html.includes("④ PRO EDGE｜プロ型価格分析"));
    assert.ok(html.includes("市場適正確率"));
    for (const bad of ["NaN", "undefined", ">null<", "[object Object]"]) assert.ok(!html.includes(bad), bad);
    assert.ok(!/<script/i.test(html));
  }
  assert.ok(renderPage(vm).includes("サンプル不足（n=0"));
  const html = renderPage(vm);
  assert.ok(html.slice(html.indexOf('id="sec-v1"'), html.indexOf('id="sec-v2"')).includes("集計保留"));   // 旧画面の VALUE① ケリー欄を維持
  assert.ok(html.slice(html.indexOf('id="sec-v2"'), html.indexOf('id="sec-pe"')).includes("集計待ち"));   // 旧画面の VALUE② CLV欄を維持
});

test("書式：金額の符号と日本時間", () => {
  assert.deepEqual([money(-87), money(19), money(0), amount(3000)], ["-$87.00", "+$19.00", "$0.00", "$3000.00"]);
  assert.equal(jst("2026-09-23T21:05:00+02:00"), "2026/9/24 04:05 JST");
  assert.equal(jst(null), null);
});

test("旧RMCとの照合：説明できない差 0 件", () => {
  execFileSync("node", ["scripts/v2-compare-legacy.js"], { cwd: ROOT, stdio: "pipe" });
});
