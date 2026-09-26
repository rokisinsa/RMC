import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTimes, checkOdds, checkConditions } from "../lib/integrity.js";
import { makeDataset, matchesById } from "./fixtures/dataset.js";

const codes = issues => issues.map(i => i.code);
function mutated(system, id, mutate) {
  const ds = makeDataset();
  mutate(ds[system].picks.find(p => p.id === id));
  return { data: ds[system], M: matchesById(ds) };
}

// ── 時刻 ──
test("fixture：時刻ルール違反なし", () => {
  const ds = makeDataset();
  for (const s of ["recommendations", "experience", "value1", "value2"]) assert.deepEqual(checkTimes(ds[s], matchesById(ds)), [], s);
});

test("試合開始後の locked は error（事前分析として扱えない）", () => {
  const { data, M } = mutated("recommendations", "rec-r1", p => { p.locked_at = "2026-09-20T20:30:00+09:00"; });
  assert.ok(codes(checkTimes(data, M)).includes("TIME_LOCKED_AFTER_START"));
});

test("別オフセットでも正しく前後判定する（開始 20:00 JST ＝ 11:00Z）", () => {
  const before = mutated("recommendations", "rec-r1", p => { p.locked_at = "2026-09-20T10:59:00Z"; });
  assert.deepEqual(checkTimes(before.data, before.M), []);
  const after = mutated("recommendations", "rec-r1", p => { p.locked_at = "2026-09-20T11:01:00Z"; });
  assert.ok(codes(checkTimes(after.data, after.M)).includes("TIME_LOCKED_AFTER_START"));
});

test("discovered_at が locked_at より後なら error", () => {
  const { data, M } = mutated("value1", "v1-a", p => { p.discovered_at = "2026-09-19T23:45:00+09:00"; });
  assert.ok(codes(checkTimes(data, M)).includes("TIME_DISCOVERED_AFTER_LOCK"));
});

test("試合開始後の bet_at は live:true が必要、ライブは bet_at 必須", () => {
  const late = mutated("experience", "exp-e1", p => { p.bet_at = "2026-09-20T20:17:00+09:00"; p.locked_at = p.bet_at; });
  assert.ok(codes(checkTimes(late.data, late.M)).includes("TIME_BET_AFTER_START"));

  const live = mutated("experience", "exp-e1", p => { p.live = true; p.bet_at = "2026-09-20T20:17:00+09:00"; p.locked_at = p.bet_at; });
  assert.deepEqual(checkTimes(live.data, live.M), []);

  const noBet = mutated("experience", "exp-e1", p => { p.live = true; p.bet_at = null; });
  assert.ok(codes(checkTimes(noBet.data, noBet.M)).includes("TIME_LIVE_WITHOUT_BET_AT"));
});

test("探索回の開始より前の discovered_at は warning", () => {
  const { data, M } = mutated("value2", "v2-a", p => { p.discovered_at = "2026-09-19T22:00:00+09:00"; });
  const w = checkTimes(data, M).find(i => i.code === "TIME_DISCOVERED_BEFORE_RUN");
  assert.equal(w?.level, "warning");
});

// ── オッズ ──
test("fixture：オッズルール違反なし", () => {
  const ds = makeDataset();
  for (const s of ["recommendations", "experience", "value1", "value2"]) assert.deepEqual(checkOdds(ds[s]), [], s);
});

test("market_odds の min > max は error", () => {
  const { data } = mutated("value1", "v1-h", p => { p.market_odds.min = 1.3; });
  assert.ok(codes(checkOdds(data)).includes("ODDS_RANGE_INVERTED"));
});

test("レンジ表記なのに min/max 未入力は warning（勝手に一点へ固定しない）", () => {
  const { data } = mutated("value1", "v1-h", p => { p.market_odds = { text: "1.17〜1.20", min: null, max: null, observed_at: null, source: null }; });
  const w = checkOdds(data).find(i => i.code === "ODDS_RANGE_UNPARSED");
  assert.equal(w?.level, "warning");
  assert.equal(data.picks.find(p => p.id === "v1-h").odds_taken, null);
});

test("レンジの端を bet_at なしで odds_taken にした疑いは warning", () => {
  const { data } = mutated("value1", "v1-h", p => { p.odds_taken = 1.17; });
  assert.ok(codes(checkOdds(data)).includes("ODDS_TAKEN_FROM_RANGE"));
  const ok = mutated("value1", "v1-h", p => { p.odds_taken = 1.17; p.bet_at = "2026-09-26T07:00:00+09:00"; });
  assert.deepEqual(checkOdds(ok.data), []);
});

test("odds_taken には取得時点（bet_at か locked_at）が必要", () => {
  const { data } = mutated("recommendations", "rec-r1", p => { p.locked_at = null; p.bet_at = null; });
  assert.ok(codes(checkOdds(data)).includes("ODDS_TAKEN_WITHOUT_TIME"));
});

// ── 条件付きVALUE ──
test("condition は VALUE① の条件付きVALUE だけが持てる", () => {
  const cond = { text: "x", min_odds: null, met: null, checked_at: null };
  const a = mutated("value1", "v1-a", p => { p.condition = cond; });
  assert.ok(codes(checkConditions(a.data, a.M)).includes("CONDITION_NOT_ALLOWED"));
  const b = mutated("value2", "v2-a", p => { p.condition = cond; });
  assert.ok(codes(checkConditions(b.data, b.M)).includes("CONDITION_NOT_ALLOWED"));
  const c = mutated("value1", "v1-d", p => { delete p.condition; });
  assert.ok(codes(checkConditions(c.data, c.M)).includes("CONDITION_MISSING"));
});

test("condition.met を決めたら checked_at 必須、開始後の確認は warning", () => {
  const a = mutated("value1", "v1-e", p => { p.condition.met = true; });
  assert.ok(codes(checkConditions(a.data, a.M)).includes("CONDITION_UNCHECKED"));
  const ds = makeDataset();
  const w = checkConditions(ds.value1, matchesById(ds));
  assert.deepEqual(w.map(i => [i.code, i.id, i.level]), [["CONDITION_CHECKED_AFTER_START", "v1-f", "warning"]]);
});
