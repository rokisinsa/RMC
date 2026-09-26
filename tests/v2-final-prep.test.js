// 本番切替前の最終準備（テストD）
//  1. 基準点後の結果更新ログ（別の更新回）と自動連動
//  2. 旧分析メモの移行（原文保持・構造化・系統所属）
//  3. V2 が旧 analysis.html なしで動く
//  4. production では④デモが完全に無効
//  5. 複利の順序未確定の扱い
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, DATA_DIR, loadDatasets, loadSchemas, loadProEdgeConfig, DATA_FILES } from "../scripts/load-node.js";
import { validateDataset } from "../lib/validate.js";
import { applyMatchUpdates, checkMatchUpdates, checkMatchUpdatesAppendOnly, pendingReviews } from "../lib/match-updates.js";
import { buildViewModel } from "../lib/view/model.js";
import { renderPage } from "../lib/view/render.js";
import { resolveMode, assertNoDemoInProduction } from "../lib/view/mode.js";
import { parse, toBlocks, blocksText, normalizeText, text } from "../migration/legacy-html.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";

const cfg = loadProEdgeConfig();
const fresh = () => structuredClone(loadDatasets().datasets);
const NOW = "2026-09-26T19:40:00+09:00";
const vmOf = ds => buildViewModel(ds, { proEdgeConfig: cfg, now: NOW });
const row = (v, id) => v.rows.find(r => r.id === id);
const codes = issues => issues.map(i => i.code);
const sha = f => createHash("sha256").update(readFileSync(join(ROOT, f), "utf8").replace(/\r/g, "")).digest("hex");

// ── 1. 結果更新 ──────────────────────────────────────────
test("基準点（baseline/2026-09-26 と matches.json の基準点・人間確認）は書き換えていない", () => {
  assert.equal(sha("baseline/2026-09-26/baseline.json"), "86af8bc15919c671f435a94fa35329116afe5f894a995fa627e4d08e6642aab7");
  const m = fresh().matches;
  assert.deepEqual(m.update_runs.map(r => r.run_id), ["mr-baseline-2026-09-26", "mr-2026-09-26-human-review"]);
  assert.equal(m.matches.find(x => x.id === "2026-09-26-fin-fra").status, "unknown");     // 基準点の値のまま
});

test("基準点後の更新は別の更新回として重ね、before/after を provenance に残す", () => {
  const ds = fresh();
  const eff = applyMatchUpdates(ds.matches, ds.match_updates);
  const f = eff.matches.find(x => x.id === "2026-09-26-fin-fra");
  assert.deepEqual([f.status, f.result.final], ["final", { a: 1, b: 3 }]);
  const p = f.provenance.at(-1);
  assert.equal(p.update_run_id, "mr-2026-09-26-1937-result-update");
  assert.deepEqual(p.changes.find(c => c.field === "status"), { field: "status", before: "unknown", after: "final" });
  assert.equal(eff.update_runs.at(-1).kind, "result_update");
  assert.equal(ds.matches.matches.find(x => x.id === "2026-09-26-fin-fra").status, "unknown");   // 元データは不変
  assert.deepEqual(checkMatchUpdates(ds.matches, ds.match_updates), []);
});

test("確認できなかった試合は結果を入れず要確認のまま（推測しない）", () => {
  const ds = fresh();
  const reviews = pendingReviews(ds.match_updates);
  for (const id of ["2026-09-25-prz-gri", "2026-09-26-hos-oze", "2026-09-26-kor-vie", "2026-09-26-ge-vit"]) assert.ok(reviews.has(id), id);
  const vm = vmOf(ds);
  const hos = row(vm.experience, "exp-legacy-hos-oze");
  assert.equal(hos.settlement.state, "pending");
  assert.ok(hos.quality.some(q => q.key === "review"));
  const prz = row(vm.experience, "exp-legacy-prz-gri");
  assert.ok(prz.quality.some(q => q.label === "要確認（結果更新時）" && q.note.includes("Daniil Glinka")));
});

test("結果更新の自動連動：試合事実 → ①②③④・経験値 → ○×△ → 払戻し → 純損益 → 戦績 → 勝率 → ROI → 未確定", () => {
  const ds = fresh();
  const before = vmOf(ds);
  ds.match_updates.runs.push({
    run_id: "mr-2026-09-26-2200-test", kind: "result_update", at: "2026-09-26T23:59:00+09:00", source: "テスト", note: null,
    changes: [{ match_id: "2026-09-26-loud-edg", set: { status: "final", result: { final: { a: 2, b: 1 }, text: "LOUD 2-1 EDG" } },
      evidence: { sources: [{ name: "テスト公式", url: "https://example.com/", type: "official" }], verified_at: "2026-09-26T23:58:00+09:00", source_confidence: "official", note: null } }],
    reviews: [],
  });
  assert.deepEqual(checkMatchUpdates(ds.matches, ds.match_updates), []);
  const after = vmOf(ds);
  const rec = row(after.recommendations, "rec-legacy-loud-edg-rec");
  assert.equal(rec.settlement.state, "win");                                              // ○
  assert.equal(rec.settlement.payout, null);                                              // オッズがレンジ → 払戻しは未計算（推測しない）
  assert.equal(row(after.value1, "v1-legacy-loud-edg").settlement.state, "win");
  assert.equal(row(after.value2, "v2-legacy-loud-edg").settlement.state, "win");
  const b = before.recommendations.summary, a = after.recommendations.summary;
  assert.equal(a.wins, b.wins + 1);
  assert.equal(a.pending, b.pending - 1);
  assert.equal(a.winRate, (a.wins / a.settledGames) * 100);
  assert.equal(a.amountMissing, b.amountMissing + 1);
  assert.equal(after.value2.reference.wins, before.value2.reference.wins + 1);

  // 金額が計算できるカードでの連動（スペイン–チェコ 1.14：推奨 $100 と 経験値 $300）
  const base = structuredClone(ds); base.match_updates.runs = [];
  const v0 = vmOf(base), v1 = vmOf(fresh());
  assert.equal(row(v0.recommendations, "rec-legacy-spain-czech-rec").settlement.state, "pending");
  assert.deepEqual([row(v1.recommendations, "rec-legacy-spain-czech-rec").settlement.payout, row(v1.recommendations, "rec-legacy-spain-czech-rec").settlement.profit], [114, 14]);
  assert.equal(v1.recommendations.summary.netProfit, v0.recommendations.summary.netProfit + 14);
  assert.equal(v1.recommendations.summary.settledStake, v0.recommendations.summary.settledStake + 100);
  assert.equal(v1.recommendations.summary.roi, (v1.recommendations.summary.netProfit / v1.recommendations.summary.settledStake) * 100);
  assert.deepEqual([row(v1.experience, "exp-legacy-esp-cze").settlement.profit, v1.experience.summary.netProfit], [42, 57]);
  // 中止（No result）は無効＝返金：勝敗・ROI分母に入れない
  const jpn = row(v1.recommendations, "rec-legacy-jpn-nep-rec");
  assert.deepEqual([jpn.settlement.state, jpn.settlement.profit], ["void", 0]);
  assert.equal(v1.recommendations.summary.voids, 1);
  assert.equal(v1.recommendations.summary.settledGames, v0.recommendations.summary.settledGames + 1);   // スペイン–チェコのみ加算
});

test("結果更新ログの検査：未登録の試合・結果なしの final・時刻の逆行・確認時刻の不整合・書き換え", () => {
  const ds = fresh();
  const bad = structuredClone(ds.match_updates);
  bad.runs.push({
    run_id: "mr-2026-09-26-0100-bad", kind: "result_update", at: "2026-09-26T01:00:00+09:00", source: "x", note: null,
    changes: [
      { match_id: "no-such-match", set: { status: "final" }, evidence: { sources: [{ name: "x", url: "https://x.example/" }], verified_at: "2026-09-26T00:00:00+09:00", note: null } },
      { match_id: "2026-09-26-kor-vie", set: { status: "final" }, evidence: { sources: [{ name: "x", url: "https://x.example/" }], verified_at: "2026-09-26T02:00:00+09:00", note: null } },
    ],
    reviews: [],
  });
  const c = codes(checkMatchUpdates(ds.matches, bad));
  for (const code of ["UPDATE_MATCH_UNKNOWN", "UPDATE_FINAL_WITHOUT_RESULT", "UPDATE_RUN_ORDER", "UPDATE_VERIFIED_AFTER_RUN"]) assert.ok(c.includes(code), code);
  const rewritten = structuredClone(ds.match_updates);
  rewritten.runs[0].changes[0].set.result.final = { a: 3, b: 0 };
  assert.ok(codes(checkMatchUpdatesAppendOnly(ds.match_updates, rewritten)).includes("UPDATE_LOG_REWRITTEN"));
  // 分析判断は更新ログに入れられない（スキーマ）
  const analysis = structuredClone(ds.match_updates);
  analysis.runs[0].changes[0].set.verdict = "formal";
  assert.ok(validateDataset({ ...ds, match_updates: analysis }, loadSchemas(), { proEdgeConfig: cfg }).some(i => i.message.includes('"verdict"')));
});

test("最新の集計（基準点＋結果更新）", () => {
  const vm = vmOf(fresh());
  const r = vm.recommendations.summary, e = vm.experience.summary;
  assert.deepEqual([r.wins, r.losses, r.voids, r.pending, r.netProfit, r.settledStake], [8, 2, 1, 19, -73, 1000]);
  assert.deepEqual([e.wins, e.losses, e.pending, e.netProfit, e.settledStake], [2, 0, 2, 57, 600]);
  assert.deepEqual([vm.value1.official.wins, vm.value1.official.losses, vm.value1.official.netProfit], [1, 1, -75]);
  assert.deepEqual([vm.value1.reference.wins, vm.value1.reference.amountMissing], [3, 2]);   // France 勝ち（約1.20 → 金額未計算）
  assert.deepEqual([vm.value2.official.pending, vm.value2.reference.pending], [1, 1]);
});

// ── 2. 旧分析メモの移行 ────────────────────────────────────
const la = s => JSON.parse(readFileSync(join(DATA_DIR, "legacy-analysis", `${s}.json`), "utf8"));

test("旧分析メモ：原文を保持し、構造化で文章を欠落させていない（確率表示の除外分を除く）", () => {
  let n = 0;
  for (const s of ["recommendations", "value1", "value2"]) {
    for (const e of la(s).entries) {
      let expect = normalizeText(text(parse(e.raw_html)));
      for (const x of e.excluded_from_blocks) expect = expect.replace(normalizeText(x.text), "");
      assert.equal(normalizeText(blocksText(e.blocks)), expect, e.pick_id);
      assert.deepEqual(toBlocks(parse(e.raw_html)), e.blocks, e.pick_id);                 // 原文から再現できる
      n++;
    }
  }
  assert.equal(n, 39);
});

test("旧分析メモ：各系統のカードにだけ所属し、④とは共有しない", () => {
  const ds = fresh();
  for (const s of ["recommendations", "value1", "value2"]) {
    const own = new Set(ds[s].picks.map(p => p.id));
    assert.ok(la(s).entries.every(e => own.has(e.pick_id) && la(s).system === s), s);
  }
  assert.ok(!Object.keys(DATA_FILES).some(k => k === "legacy_analysis_pro_edge"));
  const foreign = structuredClone(ds);
  foreign.legacy_analysis_value2.entries[0].pick_id = "v1-legacy-nip-3dmax";
  assert.ok(validateDataset(foreign, loadSchemas(), { proEdgeConfig: cfg }).some(i => i.code === "LEGACY_ANALYSIS_FOREIGN_PICK"));
});

test("旧分析メモ：H2H・ランキング・直近成績・分析理由が構造化され、事前固定でない確率表示は含まない", () => {
  const china = la("recommendations").entries.find(e => e.pick_id === "rec-legacy-china-maldives");
  const table = china.blocks.find(b => b.type === "table");
  assert.deepEqual(table.headers, ["日付", "ホーム", "アウェイ", "スコア", "勝者", "先制点"]);
  assert.deepEqual(table.rows[0], ["2021/6/11", "中国", "モルディブ", "5-0", "中国", "未確認"]);
  assert.ok(china.blocks.some(b => b.type === "boxes" && b.boxes.some(x => x.title === "当時のFIFA順位")));
  const lyon = la("recommendations").entries.find(e => e.pick_id === "rec-legacy-lyon");
  assert.ok(lyon.excluded_from_blocks.some(x => x.text.includes("87.0%")));
  assert.ok(!blocksText(lyon.blocks).includes("87.0%"));
  assert.ok(lyon.raw_html.includes("87.0%"));                                              // 原文には残る
  assert.equal(lyon.js_summary.market, "前半1X2：リヨン");
});

// ── 3. 旧 analysis.html なしで動く ─────────────────────────
test("V2 は旧 analysis.html を取得しない（コード上に取得処理が無い）", () => {
  const src = readFileSync(join(ROOT, "analysis-v2.js"), "utf8");
  assert.ok(!/fetch\([^)]*analysis\.html/.test(src));
  assert.ok(!/DOMParser/.test(src));
  const paths = [...src.matchAll(/"(data\/[^"]+\.json)"/g)].map(m => m[1]).sort();
  assert.deepEqual(paths, Object.values(DATA_FILES).map(f => `data/${f}`).sort());          // 読み込むデータは data/ だけ
});

test("V2 の描画に必要な情報がすべてデータから揃う（①②③④・経験値・旧分析メモ）", () => {
  const html = renderPage(vmOf(fresh()));
  for (const id of ["sec-rec", "sec-v1", "sec-v2", "sec-pe", "sec-exp"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("<td>2021/6/11</td>"));                                         // 中国–モルディブの H2H
  assert.ok(html.includes("3DMAXが圧倒的に強いからではなく"));                              // VALUE① NiP の分析本文
  assert.ok(!html.includes("data-legacy-key"));                                           // 旧ファイルからの差し込み枠は無い
  for (const bad of ["NaN", "undefined", "[object Object]"]) assert.ok(!html.includes(bad), bad);
});

// ── 4. production では④デモ無効 ──────────────────────────
test("production 判定：GitHub Pages・その他のホスト・file:// はすべて production。demo 指定は無視", () => {
  for (const url of [
    "https://rokisinsa.github.io/RMC/analysis-v2.html?demo=pro_edge",
    "https://example.com/analysis-v2.html?demo=pro_edge",
    "http://192.168.0.10:8123/analysis-v2.html?demo=pro_edge",
    "file:///D:/RMC/analysis-v2.html?demo=pro_edge",
    "https://localhost:8123/analysis-v2.html?demo=pro_edge",
  ]) {
    const m = resolveMode(url);
    assert.equal(m.mode, "production", url);
    assert.equal(m.demo, false, url);
    assert.equal(m.demo_requested_but_ignored, true, url);
  }
  const dev = resolveMode("http://localhost:8123/analysis-v2.html?demo=pro_edge");
  assert.deepEqual([dev.mode, dev.demo], ["development", true]);
  assert.equal(resolveMode("http://localhost:8123/analysis-v2.html").demo, false);
});

test("production で架空データを表示しようとしたら止まる（二重の安全装置）", () => {
  const prod = resolveMode("https://rokisinsa.github.io/RMC/analysis-v2.html?demo=pro_edge");
  assert.throws(() => assertNoDemoInProduction(prod, { __demo: true }), /production/);
  assert.doesNotThrow(() => assertNoDemoInProduction(prod, {}));
  // 表示モデルに demo 印が無ければ、demo 指定でもデモ表示にならない
  const vm = vmOf(fresh());
  assert.ok(!renderPage(vm, { demo: true }).includes("デモ表示"));
  const s = makeProEdgeSample();
  const demoVm = vmOf({ ...fresh(), __demo: true, pro_edge: s.pro_edge, matches: { ...fresh().matches, matches: [...fresh().matches.matches, ...s.matches.matches] } });
  assert.ok(renderPage(demoVm, { demo: true }).includes("デモ表示：架空のサンプルデータです"));
  // デモの読み込みは development 判定の内側だけ
  const src = readFileSync(join(ROOT, "analysis-v2.js"), "utf8");
  assert.match(src, /if \(mode\.demo\) ds = await applyDemo\(ds\);/);
  assert.equal((src.match(/applyDemo\(/g) ?? []).length, 2);                               // 定義1＋呼び出し1
});

test("本データ（data/pro_edge.json）に架空カードは無い", () => {
  const ds = fresh();
  assert.deepEqual(ds.pro_edge.picks, []);
  assert.ok(!JSON.stringify(ds).includes("Sample League"));
});

// ── 5. 複利の順序未確定 ────────────────────────────────────
test("複利：取引順序を証明できないので参考値・順序未確定（2通りの順序の値を併記）", () => {
  const base = fresh(); base.match_updates.runs = [];
  const vm = vmOf(base);
  const a = vm.recommendations.compound_audit;
  assert.equal(a.status, "order_unconfirmed");
  assert.ok(a.reasons.some(r => r.includes("bet_at")));
  assert.equal(vm.recommendations.compound.stock, 140.58);                                 // 試合開始時刻順
  assert.equal(a.alternative_by_registration.stock, 114.8);                               // 旧画面と同じ登録時刻順
  const html = renderPage(vm);
  assert.ok(html.includes("複利（参考値・取引順序未確定）"));
  assert.equal(vm.value2.compound_audit.status, "no_settled");
  // 重複カードは確定済みに含まれない（二重算入なし）
  assert.ok(vm.recommendations.rows.filter(r => r.flags.includes("duplicate_review")).every(r => r.settlement.state === "pending"));
});

test("複利の監査スクリプトが両方の計算過程を出す", () => {
  const out = execFileSync("node", ["scripts/audit-compound.js"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /ストック \$114\.80/);
  assert.match(out, /ストック \$140\.58/);
  assert.match(out, /前の試合の開始前に次を登録/);
});

// ── その他の維持事項 ───────────────────────────────────────
test("経験値取引は4系統とは別に表示・集計し、VALUE①②の並び順は旧表のまま", () => {
  const vm = vmOf(fresh());
  const html = renderPage(vm);
  assert.ok(html.indexOf('id="sec-exp"') > html.indexOf('id="sec-pe"'));
  assert.deepEqual(vm.value1.rows.map(r => r.legacy.row_index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(vm.value2.rows.map(r => r.legacy.row_index), [0, 1]);
  assert.equal(vm.recommendations.duplicates.groups, 6);
});
