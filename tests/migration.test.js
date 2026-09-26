// 手順2：移行用下書き data/*.json の検査
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDatasets, loadSchemas } from "../scripts/load-node.js";
import { validateDataset } from "../lib/validate.js";
import { findDuplicates } from "../lib/integrity.js";

const { datasets: ds } = loadDatasets();
const baseline = JSON.parse(readFileSync(join(ROOT, "baseline/2026-09-26/baseline.json"), "utf8"));
const SYSTEMS = ["recommendations", "experience", "value1", "value2"];
const allPicks = SYSTEMS.flatMap(s => ds[s].picks);
const pick = id => allPicks.find(p => p.id === id);
const match = id => ds.matches.matches.find(m => m.id === id);

test("5ファイルとも存在し、error 0件で検証を通る", () => {
  for (const f of ["matches", ...SYSTEMS, "legacy_unassigned"]) assert.ok(ds[f], f);
  assert.deepEqual(validateDataset(ds, loadSchemas()).filter(i => i.level === "error"), []);
});

test("既存データを削除していない（旧行と同じ件数）", () => {
  for (const s of SYSTEMS) assert.equal(ds[s].picks.length, baseline.legacy_rows[s].length, s);
  assert.equal(ds.matches.matches.length, 35);
});

test("旧データには legacy_import と出典（commit・表・行番号）がある", () => {
  for (const p of allPicks) {
    assert.ok(p.flags.includes("legacy_import"), p.id);
    assert.equal(p.legacy.commit, "02e5167");
  }
  for (const m of ds.matches.matches) assert.ok(m.flags.includes("legacy_import"), m.id);
});

test("推奨取引の重複6組は統合・削除せず、両方に duplicate_review", () => {
  const groups = findDuplicates(ds.recommendations);
  assert.equal(groups.length, 6);
  for (const g of groups) {
    assert.equal(g.ids.length, 2);
    for (const id of g.ids) assert.ok(pick(id).flags.includes("duplicate_review"), id);
  }
  // 中身の食い違い（格差スコア）も保存されたまま
  assert.equal(pick("rec-legacy-lat-ger-rec").locked.gap_score, 92);
  assert.equal(pick("rec-legacy-lat-ger").locked.gap_score, 93);
});

test("仮時刻 00:00 / 00:01 を開始時刻にしていない", () => {
  for (const id of ["2026-09-26-ag-lgd", "2026-09-26-fearx-cybme", "2026-09-26-tmt-rrx"]) {
    assert.equal(match(id).start_at, null, id);
    assert.equal(match(id).start_time_status, "unverified", id);
  }
  assert.equal(pick("rec-legacy-fearx").legacy.sort_at, null);
  assert.equal(pick("rec-legacy-ag-lgd").legacy.sort_at, null);
});

test("オッズレンジを一点へ固定していない", () => {
  for (const p of allPicks) {
    if (p.market_odds?.min != null && p.market_odds?.max != null && p.market_odds.min < p.market_odds.max) {
      assert.equal(p.odds_taken, null, p.id);
    }
  }
  assert.equal(pick("v1-legacy-kc-xlg").odds_taken, null);
  assert.deepEqual([pick("v1-legacy-kc-xlg").market_odds.min, pick("v1-legacy-kc-xlg").market_odds.max], [1.17, 1.2]);
});

test("過去の事前確率：試合前保存を Git 履歴で確認できた ODDIK・Lyon・Italy だけ。他は null（推測で作らない）", () => {
  const withProb = ds.recommendations.picks.filter(p => p.locked?.prob != null).map(p => [p.id, p.locked.prob, p.locked_at]);
  assert.deepEqual(withProb, [
    ["rec-legacy-oddik-procyon", 0.7542, "2026-09-24T04:23:20+09:00"],
    ["rec-legacy-lyon", 0.922, "2026-09-23T23:13:05+09:00"],   // locked_at は Git 上の実際の保存時刻
    ["rec-legacy-italy", 0.802, "2026-09-23T23:13:05+09:00"],
  ]);
  for (const id of ["rec-legacy-cs2", "rec-legacy-cor", "rec-legacy-tun"]) {
    assert.equal(pick(id).locked.prob, null, id);
    assert.equal(pick(id).locked_at, null, id);
    assert.ok(pick(id).flags.includes("lock_unverified"), id);
  }
  assert.equal(pick("rec-legacy-lyon").legacy.raw.data_locked_prob, 0.922);
});

test("Lyon・Italy の開始時刻と結果は、基準点とは別の人間確認の更新回として記録", () => {
  const runs = ds.matches.update_runs.map(r => [r.run_id, r.kind]);
  assert.deepEqual(runs, [["mr-baseline-2026-09-26", "baseline_migration"], ["mr-2026-09-26-human-review", "human_review"]]);
  const lyon = match("2026-09-23-ser-lyo"), italy = match("2026-09-23-ita-fin");
  assert.equal(lyon.start_at, "2026-09-24T01:45:00+09:00");
  assert.deepEqual(lyon.result.final, { a: 0, b: 8 });
  assert.equal(italy.start_at, "2026-09-24T04:05:00+09:00");
  assert.deepEqual(italy.result.final, { a: 2, b: 3 });
  // 基準点の値（開始時刻未確認）は provenance の before に残っている
  const change = lyon.provenance[1].changes.find(c => c.field === "start_at");
  assert.deepEqual([lyon.provenance[1].update_run_id, change.before, change.after], ["mr-2026-09-26-human-review", null, "2026-09-24T01:45:00+09:00"]);
});

test("Bulgaria は正式結果 2-1 で確定。ただし条件付きVALUE は条件成立の記録が無いので本成績外", () => {
  const m = match("2026-09-26-bul-por-u21");
  assert.deepEqual(m.result.final, { a: 2, b: 1 });
  assert.ok(!m.flags.includes("result_unverified"));
  const p = pick("v1-legacy-bul-por-u21");
  assert.deepEqual([p.condition.met, p.condition.checked_at], [null, null]);
});

test("ODDIK の開始時刻は要確認のまま（候補2つ）、locked 0.7542 はどちらの候補よりも前", () => {
  const m = match("2026-09-24-oddik-procyon");
  assert.equal(m.start_at, null);
  assert.equal(m.start_time_status, "review_required");
  assert.deepEqual(m.start_candidates, ["2026-09-24T06:00:00+09:00", "2026-09-24T06:00:00-03:00"]);
  for (const c of m.start_candidates) assert.ok(Date.parse(pick("rec-legacy-oddik-procyon").locked_at) < Date.parse(c));
});

test("LOUD–EDG の VALUE①・② は独立性を要確認（分析値はコピーせず別々のまま）", () => {
  const v1 = pick("v1-legacy-loud-edg"), v2 = pick("v2-legacy-loud-edg");
  for (const p of [v1, v2]) assert.ok(p.flags.includes("analysis_independence_review"), p.id);
  assert.notEqual(v1.run_id, v2.run_id);
  assert.equal(v1.legacy.table, "oddsTestTable");
  assert.equal(v2.legacy.table, "oddsTestTable2");
});

test("除外ログ3件はどの系統にも帰属させない（system_assignment=unknown）", () => {
  assert.deepEqual(ds.value1.excluded_log, []);
  assert.deepEqual(ds.value2.excluded_log, []);
  const log = ds.legacy_unassigned.excluded_log;
  assert.equal(log.length, 3);
  for (const e of log) assert.equal(e.system_assignment, "unknown");
});

test("基準点前に削除済みの行は本データへ復元しない（archive で参照のみ）", () => {
  const archive = JSON.parse(readFileSync(join(ROOT, "migration/archive/removed-before-baseline.json"), "utf8"));
  const names = archive.rows.map(r => r.match);
  for (const n of ["サッカリ、マリア vs ギブソン、タイラ", "ボリネッツ、ケイティ vs ビレル、キンバリー"]) {
    assert.ok(names.includes(n), n);
    assert.ok(!allPicks.some(p => p.selection_label?.includes(n.split(" vs ")[1])), n);
  }
});

test("推奨の投入額は全件 $100（旧 $300/$270 は stake_history の履歴のみ）", () => {
  for (const p of ds.recommendations.picks) assert.equal(p.stake, 100, p.id);
  assert.deepEqual(pick("rec-legacy-oddik-procyon").legacy.raw.stake_history, ["270", "100"]);
});

test("home/away を断定しない：side_a/side_b と、記録がある場合だけ home_side", () => {
  const known = ds.matches.matches.filter(m => m.home_side !== "unknown").map(m => [m.id, m.home_side]);
  assert.deepEqual(known, [["2026-09-23-ser-lyo", "side_a"], ["2026-09-24-chn-mdv", "side_a"], ["2026-09-26-bul-por-u21", "side_a"]]);
});

test("現行モデルの再計算は recalculated_reference にだけあり、locked と混同しない", () => {
  assert.notEqual(pick("rec-legacy-lyon").recalculated_reference[0].prob, pick("rec-legacy-lyon").locked.prob);
  const models = ["oddik-procyon", "lyon", "italy", "cs2", "cor", "tun"].map(s => pick(`rec-legacy-${s}`));
  for (const p of models) {
    assert.equal(p.recalculated_reference.length, 1, p.id);
    assert.equal(p.recalculated_reference[0].model_version, "5.1");
  }
  assert.equal(pick("rec-legacy-lyon").recalculated_reference[0].prob, 0.9103);   // 参考値
  assert.equal(pick("rec-legacy-lyon").locked.prob, 0.922);                          // 事前確率（Git履歴で試合前保存を確認）
});

test("VALUE①・②の区分を保持（正式4・条件付1・監視4 / 採用1・監視1）", () => {
  const count = s => ds[s].picks.reduce((a, p) => ({ ...a, [p.locked.verdict]: (a[p.locked.verdict] ?? 0) + 1 }), {});
  assert.deepEqual(count("value1"), { conditional: 1, formal: 4, watch: 4 });
  assert.deepEqual(count("value2"), { adopted: 1, watch: 1 });
  const bul = pick("v1-legacy-bul-por-u21");
  assert.deepEqual([bul.condition.met, bul.condition.checked_at], [null, null]);
});

test("客観的事実は matches.json に一元化し、同一試合は複数系統から同じ match_id を参照", () => {
  const systemsOf = id => [...new Set(allPicks.filter(p => p.match_id === id).map(p => p.system))].sort();
  assert.deepEqual(systemsOf("2026-09-26-loud-edg"), ["recommendations", "value1", "value2"]);
  assert.deepEqual(systemsOf("2026-09-26-ge-vit"), ["recommendations", "value2"]);
  assert.deepEqual(systemsOf("2026-09-25-esp-cze"), ["experience", "recommendations"]);
  // 分析判断は共有しない：各系統のカードは別ID・別探索回
  const loud = allPicks.filter(p => p.match_id === "2026-09-26-loud-edg");
  assert.equal(new Set(loud.map(p => p.run_id)).size, 3);
});

test("導出値（払戻し・純損益・戦績・勝率・ROI）を保存していない", () => {
  const text = SYSTEMS.map(s => readFileSync(join(ROOT, "data", `${s}.json`), "utf8")).join("\n");
  for (const key of ["\"payout\"", "\"profit\"", "\"roi\"", "\"win_rate\"", "\"record\"", "\"data_payout\""]) {
    assert.ok(!text.includes(key), key);
  }
});

test("baseline 比較：説明できない不一致 0件", () => {
  execFileSync("node", ["migration/compare-baseline.js"], { cwd: ROOT, stdio: "pipe" }); // 不一致があれば終了コード1で例外
});

test("④ PRO EDGE の data/pro_edge.json は空の下書き（旧データ無し・架空カードを入れない）", () => {
  assert.equal(ds.pro_edge.system, "pro_edge");
  assert.equal(ds.pro_edge.meta.status, "draft");
  assert.deepEqual([ds.pro_edge.discovery_runs, ds.pro_edge.picks], [[], []]);
});
