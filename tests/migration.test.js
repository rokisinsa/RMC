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
  for (const f of ["matches", ...SYSTEMS]) assert.ok(ds[f], f);
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

test("過去の事前確率：試合前保存を確認できた ODDIK だけ。他は null（推測で作らない）", () => {
  const withProb = ds.recommendations.picks.filter(p => p.locked?.prob != null).map(p => p.id);
  assert.deepEqual(withProb, ["rec-legacy-oddik-procyon"]);
  assert.equal(pick("rec-legacy-oddik-procyon").locked.prob, 0.7542);
  for (const id of ["rec-legacy-lyon", "rec-legacy-italy", "rec-legacy-cs2", "rec-legacy-cor", "rec-legacy-tun"]) {
    assert.equal(pick(id).locked.prob, null, id);
    assert.equal(pick(id).locked_at, null, id);
    assert.ok(pick(id).flags.includes("lock_unverified"), id);
  }
  // 未確認の旧 locked 値は原文として残す（事前確率とは別名）
  assert.equal(pick("rec-legacy-lyon").legacy.raw.data_locked_prob_unverified, 0.922);
  assert.equal(pick("rec-legacy-italy").legacy.raw.data_locked_prob_unverified, 0.802);
});

test("現行モデルの再計算は recalculated_reference にだけあり、locked と混同しない", () => {
  const models = ["oddik-procyon", "lyon", "italy", "cs2", "cor", "tun"].map(s => pick(`rec-legacy-${s}`));
  for (const p of models) {
    assert.equal(p.recalculated_reference.length, 1, p.id);
    assert.equal(p.recalculated_reference[0].model_version, "5.1");
  }
  assert.equal(pick("rec-legacy-lyon").recalculated_reference[0].prob, 0.9103);
  assert.equal(pick("rec-legacy-lyon").locked.prob, null);
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
