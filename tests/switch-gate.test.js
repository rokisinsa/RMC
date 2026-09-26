// 本番切替前ゲート（テストE）
//  1. 移行スナップショット検証と現在データ検証の分離（GPT 更新をまねたデータでも live 段が通る）
//  2. 結果更新ログ：scheduled→final の反映と履歴、final→別final の訂正履歴
//  3. 結果ソースの品質
//  4. Bulgaria の結果と VALUE① 条件付きの扱い
//  8. 複利の正式な順序規則
//  6/9. GPT 定時更新仕様・本番切替手順書の必須項目
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadDatasets, loadProEdgeConfig } from "../scripts/load-node.js";
import { applyMatchUpdates, checkMatchUpdates, pendingReviews, SOURCE_RULES_EFFECTIVE_FROM } from "../lib/match-updates.js";
import { buildViewModel, compoundAudit } from "../lib/view/model.js";
import { makeDataset } from "./fixtures/dataset.js";

const cfg = loadProEdgeConfig();
const codes = issues => issues.map(i => i.code);

// ── テスト用の小さな試合事実と更新ログ ──
function base() {
  const ds = makeDataset();
  const m = ds.matches;
  m.update_runs = [{ run_id: "mr-baseline-test", kind: "baseline_migration", at: "2026-09-19T00:00:00+09:00", source: "test", note: null }];
  for (const x of m.matches) x.provenance = [{ update_run_id: "mr-baseline-test", changes: [], note: null }];
  const m6 = m.matches.find(x => x.id === "m6");
  return { ds, m6 };
}
const ev = (over = {}) => ({ sources: [{ name: "大会公式", url: "https://official.example/result", type: "official" }], verified_at: "2026-10-01T10:00:00+09:00", source_confidence: "official", note: null, ...over });
const run = (id, at, changes, reviews = []) => ({ run_id: id, kind: "result_update", at, source: "test", note: null, changes, reviews });

// ── 2. 結果更新ログ ─────────────────────────────────────
test("scheduled → final：最新の有効な事実だけが表示に反映され、過去の履歴は消えない", () => {
  const { ds } = base();
  const log = { schema_version: 1, runs: [run("mr-t1", "2026-10-01T10:05:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 0, b: 1 }, text: "0-1" }, result_confirmed_at: "2026-10-01T09:50:00+09:00" }, evidence: ev() }])] };
  assert.deepEqual(checkMatchUpdates(ds.matches, log), []);
  const eff = applyMatchUpdates(ds.matches, log).matches.find(x => x.id === "m6");
  assert.deepEqual([eff.status, eff.result.final, eff.result_confirmed_at], ["final", { a: 0, b: 1 }, "2026-10-01T09:50:00+09:00"]);
  assert.equal(eff.provenance.length, 2);                                                 // 基準点＋今回
  assert.deepEqual(eff.provenance[1].changes.find(c => c.field === "status"), { field: "status", before: "scheduled", after: "final" });
  assert.equal(eff.provenance[1].evidence.source_confidence, "official");
  assert.equal(ds.matches.matches.find(x => x.id === "m6").status, "scheduled");         // 元データは不変
  const vm = buildViewModel({ ...ds, match_updates: log, pro_edge: { schema_version: 1, system: "pro_edge", discovery_runs: [], picks: [] } }, { proEdgeConfig: cfg });
  assert.equal(vm.recommendations.rows.find(r => r.id === "rec-r7").settlement.state, "win");   // side_b 選択 → 勝ち
});

test("final → 別の final（結果訂正）：理由が無ければ拒否。理由があれば 元の値・新しい値・情報源・確認時刻・理由 をすべて残す", () => {
  const { ds } = base();
  const first = run("mr-t1", "2026-10-01T10:05:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 0, b: 1 }, text: "0-1" } }, evidence: ev() }]);
  const silent = run("mr-t2", "2026-10-01T12:00:00+09:00", [{ match_id: "m6", set: { result: { final: { a: 2, b: 1 }, text: "2-1" } }, evidence: ev({ verified_at: "2026-10-01T11:55:00+09:00" }) }]);
  assert.ok(codes(checkMatchUpdates(ds.matches, { schema_version: 1, runs: [first, silent] })).includes("UPDATE_CORRECTION_REASON_MISSING"));

  const corrected = structuredClone(silent);
  corrected.changes[0].correction = { reason: "公式記録の訂正（得点者の判定変更）" };
  corrected.changes[0].evidence = ev({ verified_at: "2026-10-01T11:55:00+09:00", sources: [{ name: "リーグ公式 訂正発表", url: "https://official.example/correction", type: "official" }] });
  const log = { schema_version: 1, runs: [first, corrected] };
  assert.deepEqual(checkMatchUpdates(ds.matches, log), []);
  const eff = applyMatchUpdates(ds.matches, log).matches.find(x => x.id === "m6");
  assert.deepEqual(eff.result.final, { a: 2, b: 1 });                                     // 現在の表示は訂正後
  const last = eff.provenance.at(-1);
  assert.deepEqual(last.changes.find(c => c.field === "result").before.final, { a: 0, b: 1 });   // previous_value
  assert.deepEqual(last.changes.find(c => c.field === "result").after.final, { a: 2, b: 1 });    // new_value
  assert.equal(last.correction.reason, "公式記録の訂正（得点者の判定変更）");
  assert.equal(last.evidence.sources[0].name, "リーグ公式 訂正発表");
  assert.equal(last.evidence.verified_at, "2026-10-01T11:55:00+09:00");
  assert.equal(eff.provenance.length, 3);                                                 // 最初の確定も残る
  // 精算も訂正後の結果に連動（rec-r7 は side_b 選択 → 負けに変わる）
  const vm = buildViewModel({ ...ds, match_updates: log, pro_edge: { schema_version: 1, system: "pro_edge", discovery_runs: [], picks: [] } }, { proEdgeConfig: cfg });
  assert.equal(vm.recommendations.rows.find(r => r.id === "rec-r7").settlement.state, "loss");
});

test("要確認は、後の更新回で結果が入れば外れ、新しい要確認に置き換わる", () => {
  const log = { runs: [
    run("mr-a", "2026-10-01T10:00:00+09:00", [], [{ match_id: "m6", status: "unknown", note: "未確認" }, { match_id: "m5", status: "unknown", note: "未確認" }]),
    run("mr-b", "2026-10-01T12:00:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 1, b: 0 } } }, evidence: ev() }], [{ match_id: "m5", status: "review_required", note: "表記揺れ" }]),
  ] };
  const r = pendingReviews(log);
  assert.ok(!r.has("m6"));
  assert.deepEqual(r.get("m5").map(x => [x.run_id, x.status]), [["mr-b", "review_required"]]);
});

// ── 3. 結果ソースの品質 ────────────────────────────────────
test("予想・プレビュー・オッズ・検索スニペットは結果の根拠として拒否", () => {
  const { ds } = base();
  for (const src of [
    { name: "Tennis Tonic H2H prediction", url: "https://tennistonic.com/tennis-news/1/h2h-prediction-of-a-vs-b/", type: "media" },
    { name: "Match preview", url: "https://example.com/preview/a-vs-b", type: "media" },
    { name: "Esports Insider", url: "https://esportsinsider.com/betting-odds/r6/x", type: "media" },
    { name: "検索結果のスニペット", url: "https://search.example/q", type: "media" },
  ]) {
    const log = { runs: [run("mr-t1", "2026-10-01T10:05:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 1, b: 0 } } }, evidence: ev({ sources: [src], source_confidence: "single_source" }) }])] };
    assert.ok(codes(checkMatchUpdates(base().ds.matches, log)).includes("UPDATE_SOURCE_NOT_RESULT"), src.url);
  }
});

test("source_confidence と情報源の整合（公式・専門DB・複数一致・1件のみ・ユーザー確認）", () => {
  const { ds } = base();
  const check = e => codes(checkMatchUpdates(ds.matches, { runs: [run("mr-t1", "2026-10-01T10:05:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 1, b: 0 } } }, evidence: e }])] }));
  const media = n => ({ name: n, url: `https://${n}.example/`, type: "media" });
  assert.deepEqual(check(ev()), []);
  assert.ok(check(ev({ source_confidence: "specialist_db" })).includes("UPDATE_SOURCE_CONFIDENCE_MISMATCH"));
  assert.ok(check(ev({ sources: [media("a")], source_confidence: "multi_source" })).includes("UPDATE_SOURCE_CONFIDENCE_MISMATCH"));
  assert.deepEqual(check(ev({ sources: [media("a"), media("b")], source_confidence: "multi_source" })), []);
  assert.deepEqual(check(ev({ sources: [media("a")], source_confidence: "single_source" })), []);          // 1件のみであることが明示される
  assert.ok(check(ev({ source_confidence: undefined })).includes("UPDATE_SOURCE_CONFIDENCE_MISSING"));
  assert.ok(check(ev({ sources: [{ name: "x", url: "https://x.example/" }] })).includes("UPDATE_SOURCE_TYPE_MISSING"));
  assert.ok(check(ev({ sources: [{ name: "公式", type: "official" }] })).includes("UPDATE_SOURCE_URL_MISSING"));
  assert.deepEqual(check(ev({ sources: [{ name: "UEFA公式（ユーザー確認）", type: "user_confirmed" }], source_confidence: "user_confirmed" })), []);
});

test("ルール制定前の最初の更新回（19:37）は source_confidence 未記載でも可、それ以降は必須", () => {
  const { datasets } = loadDatasets(join(ROOT, "data"));
  assert.ok(Date.parse(datasets.match_updates.runs[0].at) < Date.parse(SOURCE_RULES_EFFECTIVE_FROM));
  for (const r of datasets.match_updates.runs.filter(x => Date.parse(x.at) >= Date.parse(SOURCE_RULES_EFFECTIVE_FROM))) {
    for (const c of r.changes) assert.ok(c.evidence.source_confidence, `${r.run_id} ${c.match_id}`);
  }
});

test("result_confirmed_at は確認時刻より後にできない", () => {
  const { ds } = base();
  const log = { runs: [run("mr-t1", "2026-10-01T10:05:00+09:00", [{ match_id: "m6", set: { status: "final", result: { final: { a: 1, b: 0 } }, result_confirmed_at: "2026-10-01T10:30:00+09:00" }, evidence: ev() }])] };
  assert.ok(codes(checkMatchUpdates(ds.matches, log)).includes("UPDATE_CONFIRMED_AFTER_VERIFIED"));
});

// ── 4. Bulgaria ─────────────────────────────────────────
test("Bulgaria U21 2-1 Portugal U21 は客観的結果として確定、VALUE① 条件付きは本成績の集計外", () => {
  const ds = loadDatasets().datasets;
  const eff = applyMatchUpdates(ds.matches, ds.match_updates).matches.find(x => x.id === "2026-09-26-bul-por-u21");
  assert.deepEqual([eff.status, eff.result.final], ["final", { a: 2, b: 1 }]);
  assert.ok(!eff.flags.includes("result_unverified"));
  assert.ok(eff.provenance.some(p => p.update_run_id === "mr-2026-09-26-human-review" && /UEFA/.test(p.note)));
  const vm = buildViewModel(ds, { proEdgeConfig: cfg });
  const row = vm.value1.rows.find(r => r.id === "v1-legacy-bul-por-u21");
  assert.equal(row.settlement.state, "loss");                                             // 試合結果は Portugal の敗戦
  assert.equal(row.bucket, "conditional_unmet");                                           // VALUE① 損益は集計外
  assert.ok(!vm.value1.rows.filter(r => r.bucket === "official").some(r => r.id === row.id));
});

// ── 8. 複利の順序規則 ──────────────────────────────────────
function groups(list) {
  return list.map(([id, bet, confirmed, state, odds]) => ({
    pick: { id, bet_at: bet, legacy: null, locked_at: null },
    match: { result_confirmed_at: confirmed },
    settlement: { state, odds, stake: 100, orderKey: bet, profit: state === "win" ? 100 * (odds - 1) : -100 },
  }));
}
test("複利：投入時刻と結果確定時刻が揃い、前の結果確定後に次を投入している場合だけ正式値", () => {
  const ok = compoundAudit(groups([
    ["a", "2026-10-01T10:00:00+09:00", "2026-10-01T12:00:00+09:00", "win", 1.5],
    ["b", "2026-10-01T13:00:00+09:00", "2026-10-01T15:00:00+09:00", "win", 1.4],
  ]));
  assert.equal(ok.status, "confirmed");
  // $100 × 1.5 × 1.4 = $210 で倍額到達 → ストック $110・資金は元金 $100 に戻る
  assert.equal(ok.official_order.balance, 100);
  assert.equal(ok.official_order.stock, 110);

  const overlap = compoundAudit(groups([
    ["a", "2026-10-01T10:00:00+09:00", "2026-10-01T12:00:00+09:00", "win", 1.5],
    ["b", "2026-10-01T11:00:00+09:00", "2026-10-01T15:00:00+09:00", "win", 1.4],
  ]));
  assert.equal(overlap.status, "order_unconfirmed");
  assert.ok(overlap.reasons.some(r => r.includes("結果確定前に投入")));
  const same = compoundAudit(groups([["a", "2026-10-01T10:00:00+09:00", "2026-10-01T09:00:00+09:00", "win", 1.5], ["b", "2026-10-01T10:00:00+09:00", "2026-10-01T15:00:00+09:00", "loss", 2]]));
  assert.ok(same.reasons.some(r => r.includes("同じ")));
  const missing = compoundAudit(groups([["a", null, null, "win", 1.5]]));
  assert.equal(missing.status, "order_unconfirmed");
  assert.equal(missing.reasons.length, 2);
});

test("過去分（移行データ）の複利は正式値にしない（$114.80 / $140.58 とも参考値）", () => {
  const ds = loadDatasets().datasets;
  const vm = buildViewModel({ ...ds, match_updates: { schema_version: 1, runs: [] } }, { proEdgeConfig: cfg });
  const a = vm.recommendations.compound_audit;
  assert.equal(a.status, "order_unconfirmed");
  assert.equal(a.official_order, null);
  assert.equal(vm.recommendations.compound.stock, 140.58);
  assert.equal(a.alternative_by_registration.stock, 114.8);
});

// ── 1. テスト分離：GPT 更新をまねたデータでも live 段が通り、不正な更新は落ちる ──
function simulateGptUpdate(mutate) {
  mkdirSync(join(ROOT, ".tmp-tests"), { recursive: true });              // Git 管理外（.gitignore）
  const dir = mkdtempSync(join(ROOT, ".tmp-tests", "rmc-live-"));
  cpSync(join(ROOT, "data"), dir, { recursive: true });
  const rd = f => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const wr = (f, v) => writeFileSync(join(dir, f), JSON.stringify(v, null, 2));
  mutate(rd, wr);
  // テストランナー内から node --test を入れ子で起動すると NODE_TEST_CONTEXT が引き継がれ、子の失敗が終了コードに出ない。外して独立に実行する
  const env = { ...process.env, RMC_DATA_DIR: dir };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "tests/live/live-data.test.js"], { cwd: ROOT, env, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test("GPT 定時更新をまねて新しい試合・推奨カード・結果を追加しても、live 段のテストはそのまま通る", () => {
  const r = simulateGptUpdate((rd, wr) => {
    const m = rd("matches.json");
    m.update_runs.push({ run_id: "mr-2026-10-01-0600-gpt", kind: "result_update", at: "2026-10-01T06:05:00+09:00", source: "GPT定時更新 06:00", note: null });
    m.matches.push({
      id: "2026-10-02-new-match", sport: "男子サッカー", competition: "テストリーグ", side_a: "A", side_b: "B", home_side: "unknown", venue: null,
      start_at: "2026-10-02T19:00:00+09:00", start_time_status: "recorded", start_time_note: null, status: "scheduled", result: null,
      provenance: [{ update_run_id: "mr-2026-10-01-0600-gpt", changes: [], note: "新規登録" }], sources: ["大会公式"], verified_at: null, flags: [], note: null,
    });
    wr("matches.json", m);
    const rec = rd("recommendations.json");
    rec.discovery_runs.push({ run_id: "rec-2026-10-01-0600", started_at: "2026-10-01T06:00:00+09:00", slot: "06:00", note: "①独自の探索回" });
    rec.picks.push({
      id: "rec-2026-10-01-new", system: "recommendations", match_id: "2026-10-02-new-match", market: "match_1x2", market_label: null,
      selection: "side_a", selection_label: "A", market_odds: null, odds_taken: 1.25, stake: 100,
      discovered_at: "2026-10-01T06:10:00+09:00", run_id: "rec-2026-10-01-0600", bet_at: "2026-10-01T06:30:00+09:00", locked_at: "2026-10-01T06:30:00+09:00",
      locked: { prob: null, gap_score: 88, confidence: "A", model_version: null, summary: null },
      closing_odds: null, recalculated_reference: [], settlement_override: null, flags: [], detail_ref: null, note: null,
    });
    wr("recommendations.json", rec);
    const u = rd("match-updates.json");
    u.runs.push(run("mr-2026-10-03-0600-gpt", "2026-10-03T06:05:00+09:00", [
      { match_id: "2026-10-02-new-match", set: { status: "final", result: { final: { a: 2, b: 0 }, text: "2-0" }, result_confirmed_at: "2026-10-02T21:00:00+09:00" }, evidence: ev({ verified_at: "2026-10-03T06:00:00+09:00" }) },
    ]));
    wr("match-updates.json", u);
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("過去の結果を黙って書き換える不正な更新は live 段で失敗する", () => {
  const r = simulateGptUpdate((rd, wr) => {
    const m = rd("matches.json");
    m.matches.find(x => x.id === "2026-09-26-slo-pol").result.final = { a: 3, b: 0 };   // 履歴なしで書き換え
    wr("matches.json", m);
  });
  assert.notEqual(r.status, 0);
  const r2 = simulateGptUpdate((rd, wr) => {
    const u = rd("match-updates.json");
    u.runs[0].changes[0].set.result.final = { a: 3, b: 1 };                                 // 更新ログの書き換え
    wr("match-updates.json", u);
  });
  assert.notEqual(r2.status, 0);
});

test("移行スクリプトは明示指定なしでは実行されない（data/ の上書き防止）", () => {
  for (const f of ["migration/migrate.js", "migration/extract-legacy-analysis.js"]) {
    const r = spawnSync(process.execPath, [f], { cwd: ROOT, encoding: "utf8", env: { ...process.env, RMC_ALLOW_MIGRATION_REGENERATE: "" } });
    assert.equal(r.status, 1, f);
    assert.match(r.stderr, /RMC_ALLOW_MIGRATION_REGENERATE/);
  }
});

// ── 6 / 9. 仕様書・手順書 ─────────────────────────────────
test("GPT 定時更新仕様：12項目と独立探索の禁止事項を含む", () => {
  const doc = readFileSync(join(ROOT, "docs", "gpt-update-spec.md"), "utf8");
  for (const item of ["□1 結果更新", "□2 未確定カード更新", "□3 推奨用の新規候補を独立探索", "□4 VALUE①用の新規候補を独立探索", "□5 VALUE②用の新規候補を独立探索",
    "□6 PRO EDGE用の新規候補を独立探索", "□7 競技偏り監査", "□8 敗因分析", "□9 損益・ROI・CLV等の検証", "□10 データ品質監査", "□11 JSON更新・Git commit", "□12 最新commit SHAと公開RMC確認"]) {
    assert.ok(doc.includes(item), item);
  }
  for (const rule of ["共通候補", "流用", "source_confidence", "correction", "result_confirmed_at", "bet_at"]) assert.ok(doc.includes(rule), rule);
});

test("本番切替手順書：12項目と rollback を含み、旧 analysis.html を削除しない", () => {
  const doc = readFileSync(join(ROOT, "docs", "production-switch-runbook.md"), "utf8");
  for (const item of ["dev最終テスト", "backup/tag", "V2データ確認", "production demo無効確認", "GPT定時タスク更新", "analysis.html切替方法",
    "index.htmlリンク確認", "Git commit/push", "GitHub Pages確認", "①②③④・経験値表示確認", "数値照合", "rollback"]) {
    assert.ok(doc.includes(item), item);
  }
  assert.ok(doc.includes("旧 analysis.html は削除しない"));
});
