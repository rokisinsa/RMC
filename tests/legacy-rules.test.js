// 手順2で追加したルール：勝者のみの結果・旧データの保護・事前値の確認状態・開始時刻の状態
import { test } from "node:test";
import assert from "node:assert/strict";
import { settlePick } from "../lib/settlement.js";
import { checkLegacyAndLock, checkMatches, checkLockedImmutable, checkOdds, checkTimes } from "../lib/integrity.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";

const codes = issues => issues.map(i => i.code);
const legacyOf = (p, extra = {}) => ({
  ...p, flags: [...p.flags, "legacy_import"],
  legacy: { source: "analysis.html", commit: "02e5167", table: "resultTable", row_index: 0, raw: {}, ...extra },
});

test("スコア不明で勝者だけ記録された結果（例：第1セット勝利・スコア未確認）でも精算できる", () => {
  const ds = makeDataset();
  const p = ds.recommendations.picks.find(x => x.id === "rec-r4");       // set1_winner / home
  const m = { ...matchesById(ds).get("m3"), result: { winners: { set1: "home" }, text: "第1S 勝利（スコア未確認）" } };
  const r = settlePick(p, m);
  assert.equal(r.state, "win");
  assert.match(r.reason, /スコア未記録/);
  assert.equal(settlePick({ ...p, selection: "away" }, m).state, "loss");
});

test("勝者とスコアが矛盾したら error", () => {
  const ds = makeDataset();
  ds.matches.matches[0].result.winners = { final: "away" };             // スコアは 2-0 home
  assert.ok(codes(checkMatches(ds.matches)).includes("WINNER_SCORE_CONFLICT"));
});

test("開始時刻：recorded のときだけ start_at を持つ（仮時刻・未確認は null）", () => {
  const ds = makeDataset();
  assert.deepEqual(checkMatches(ds.matches), []);
  ds.matches.matches[0].start_time_status = "unverified";                // start_at が残ったまま
  assert.ok(codes(checkMatches(ds.matches)).includes("START_STATUS_MISMATCH"));
  ds.matches.matches[0].start_at = null;
  assert.deepEqual(checkMatches(ds.matches), []);
});

test("結果の無い final は error", () => {
  const ds = makeDataset();
  ds.matches.matches[0].result = null;
  assert.ok(codes(checkMatches(ds.matches)).includes("FINAL_WITHOUT_RESULT"));
});

test("試合前の固定を確認できない（locked_at=null）カードは推定確率・EVを持てない", () => {
  const ds = makeDataset();
  const p = ds.value1.picks.find(x => x.id === "v1-a");
  p.locked_at = null;
  assert.ok(codes(checkLegacyAndLock(ds.value1)).includes("ESTIMATE_WITHOUT_LOCK"));
  Object.assign(p.locked, { prob_lo: null, prob_hi: null, ev_lo: null, ev_hi: null });
  assert.deepEqual(checkLegacyAndLock(ds.value1), []);
});

test("推奨の事前確率も同じ（再計算値は recalculated_reference にだけ置ける）", () => {
  const ds = makeDataset();
  const p = ds.recommendations.picks[0];
  p.locked_at = null;
  assert.ok(codes(checkLegacyAndLock(ds.recommendations)).includes("ESTIMATE_WITHOUT_LOCK"));
  p.locked.prob = null;
  p.recalculated_reference.push({ at: "2026-09-26T06:45:58+09:00", model_version: "5.1", prob: 0.91, note: "参考" });
  assert.deepEqual(checkLegacyAndLock(ds.recommendations), []);
});

test("legacy 記録と legacy_import フラグは対、未確認の旧データには lock_unverified が必要", () => {
  const ds = makeDataset();
  ds.recommendations.picks[0].flags.push("legacy_import");
  assert.ok(codes(checkLegacyAndLock(ds.recommendations)).includes("LEGACY_FLAG_MISMATCH"));

  const ds2 = makeDataset();
  const p = legacyOf(ds2.recommendations.picks[0]);
  p.locked_at = null; p.locked.prob = null;
  ds2.recommendations.picks[0] = p;
  assert.ok(codes(checkLegacyAndLock(ds2.recommendations)).includes("LOCK_UNVERIFIED_UNFLAGGED"));
  p.flags.push("lock_unverified");
  assert.deepEqual(checkLegacyAndLock(ds2.recommendations), []);
});

test("旧データ由来のカードは locked_at が無くても削除・書き換え不可", () => {
  const before = makeDataset().recommendations;
  before.picks[0] = legacyOf(before.picks[0]);
  before.picks[0].locked_at = null;
  const edited = structuredClone(before);
  edited.picks[0].locked.gap_score = 99;
  assert.ok(codes(checkLockedImmutable(before, edited)).includes("LOCKED_FIELD_CHANGED"));
  const legacyEdited = structuredClone(before);
  legacyEdited.picks[0].legacy.raw.odds_text = "1.30";
  assert.ok(codes(checkLockedImmutable(before, legacyEdited)).includes("LEGACY_RECORD_CHANGED"));
  const deleted = structuredClone(before);
  deleted.picks.shift();
  assert.ok(codes(checkLockedImmutable(before, deleted)).includes("LOCKED_PICK_DELETED"));
});

test("旧データは取得時刻・投入時刻の記録が無いことがあるので warning に留める（新規データは error）", () => {
  const ds = makeDataset();
  const p = ds.recommendations.picks[0];
  p.locked_at = null; p.locked.prob = null;
  assert.equal(checkOdds(ds.recommendations).find(i => i.code === "ODDS_TAKEN_WITHOUT_TIME").level, "error");
  ds.recommendations.picks[0] = legacyOf(p);
  assert.equal(checkOdds(ds.recommendations).find(i => i.code === "ODDS_TAKEN_WITHOUT_TIME").level, "warning");

  const live = makeDataset();
  const e = live.experience.picks[0];
  e.live = true; e.bet_at = null;
  assert.equal(checkTimes(live.experience, matchesById(live)).find(i => i.code === "TIME_LIVE_WITHOUT_BET_AT").level, "error");
  live.experience.picks[0] = legacyOf(e);
  assert.equal(checkTimes(live.experience, matchesById(live)).find(i => i.code === "TIME_LIVE_WITHOUT_BET_AT").level, "warning");
});

test("並び順：試合開始時刻が無い旧データは legacy.sort_at を使う", () => {
  const ds = makeDataset();
  const p = legacyOf({ ...ds.recommendations.picks[0], locked_at: null, discovered_at: null }, { sort_at: "2026-09-22T21:56:00+09:00" });
  assert.equal(settlePick(p, { ...matchesById(ds).get("m1"), start_at: null }).orderKey, "2026-09-22T21:56:00+09:00");
});
