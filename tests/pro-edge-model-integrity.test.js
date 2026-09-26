// ④ PRO EDGE：モデル（Elo・ロジスティック）・未来データリーク・時系列分割・欠損・検証・①〜③との独立性
import { test } from "node:test";
import assert from "node:assert/strict";
import { eloRatings, eloProbability, fitLogistic, predictLogistic } from "../lib/pro-edge/models.js";
import { timeSeriesSplit, assertChronological, leakageIssues } from "../lib/pro-edge/backtest.js";
import { sportModuleOf, SPORT_MODULES, COMMON_FEATURES } from "../lib/pro-edge/sports.js";
import { checkProEdge } from "../lib/pro-edge/integrity.js";
import { checkIndependence, checkLockedImmutable } from "../lib/integrity.js";
import { validateDataset } from "../lib/validate.js";
import { loadSchemas, loadProEdgeConfig } from "../scripts/load-node.js";
import { makeProEdgeSample } from "./fixtures/pro-edge-sample.js";
import { makeDataset } from "./fixtures/dataset.js";

const cfg = loadProEdgeConfig();
const schemas = loadSchemas();
const codes = issues => issues.map(i => i.code);
function checked(mutate) {
  const ds = makeProEdgeSample();
  mutate(ds.pro_edge.picks, ds);
  return checkProEdge(ds.pro_edge, new Map(ds.matches.matches.map(m => [m.id, m])), cfg);
}

// ── サンプルの妥当性 ──
test("サンプル一式（matches + pro_edge）がスキーマと検査を通る", () => {
  assert.deepEqual(validateDataset(makeProEdgeSample(), schemas, { proEdgeConfig: cfg }), []);
});

test("導出値（market_probability・edge・EV・fair odds・CLV）はスキーマ上保存できない", () => {
  for (const key of ["market_probability", "edge", "ev", "fair_odds", "clv_price"]) {
    const ds = makeProEdgeSample();
    ds.pro_edge.picks[0][key] = 0.1;
    assert.ok(validateDataset(ds, schemas, { proEdgeConfig: cfg }).some(i => i.message.includes(`定義されていない項目 "${key}"`)), key);
  }
});

// ── モデル ──
test("Elo は予測時点より前に開始した試合だけを使う（未来の試合は入らない）", () => {
  const h = [
    { start_at: "2026-01-01T00:00:00Z", side_a: "X", side_b: "Y", winner: "side_a" },
    { start_at: "2026-01-05T00:00:00Z", side_a: "X", side_b: "Y", winner: "side_b" },
  ];
  const before = eloRatings(h, "2026-01-03T00:00:00Z");
  assert.equal(before.used, 1);
  assert.ok(before.get("X") > 1500);
  const withFuture = eloRatings(h, "2026-01-06T00:00:00Z");
  assert.equal(withFuture.used, 2);
  assert.equal(eloProbability(1500, 1500), 0.5);
  assert.ok(Math.abs(eloProbability(1600, 1500) - 1 / (1 + 10 ** (-100 / 400))) < 1e-12);
});

test("ロジスティック回帰は決定的で、Elo差を特徴量に単調な確率を返す", () => {
  const rows = [];
  for (let d = -300; d <= 300; d += 20) rows.push({ x: [d / 400], y: d > 0 ? 1 : 0 }, { x: [d / 400], y: d > 60 ? 1 : 0 });
  const m1 = fitLogistic(rows), m2 = fitLogistic(rows);
  assert.deepEqual(m1, m2);
  assert.ok(predictLogistic(m1, [0.5]) > predictLogistic(m1, [0]));
  assert.ok(predictLogistic(m1, [0]) > predictLogistic(m1, [-0.5]));
  assert.throws(() => fitLogistic([]), /学習データがない/);
});

test("市場確率をそのままコピーした base_probability は禁止", () => {
  const issues = checked(picks => { picks[4].locked.base_probability = 1 / 1.85 / (1 / 1.85 + 1 / 2.0); });
  assert.ok(codes(issues).includes("MODEL_COPIES_MARKET"));
});

test("市場由来の値（オッズ・市場確率）を特徴量に入れるのは禁止", () => {
  const issues = checked(picks => {
    picks[0].locked.features.push({ name: "market_implied_prob", status: "present", value: 0.46, observed_at: "2026-10-01T06:00:00+09:00", source: "x", note: null });
  });
  assert.ok(codes(issues).includes("MARKET_FEATURE_IN_MODEL"));
});

test("欠損データ：missing は value=null（推測で埋めない）。present は値と取得時刻が必須", () => {
  assert.ok(codes(checked(p => { p[0].locked.features[4].value = 0.8; })).includes("MISSING_FEATURE_WITH_VALUE"));
  assert.ok(codes(checked(p => { p[0].locked.features[0].observed_at = null; })).includes("PRESENT_FEATURE_INCOMPLETE"));
  assert.deepEqual(makeProEdgeSample().pro_edge.picks[0].locked.missing_information, ["serve_hold_rate"]);
});

test("競技モジュール：競技固有の特徴量を分離し、定義外は warning", () => {
  assert.equal(sportModuleOf("男子テニス"), "tennis");
  assert.equal(sportModuleOf("VALORANT"), "esports");
  assert.equal(sportModuleOf("女子ハンドボール"), "handball");
  assert.ok(SPORT_MODULES.tennis.features.includes("surface"));
  assert.ok(SPORT_MODULES.esports.features.includes("veto"));
  assert.ok(!COMMON_FEATURES.includes("surface"));
  const w = checked(p => { p[0].locked.features.push({ name: "veto", status: "missing", value: null, observed_at: null, source: null, note: null }); });
  assert.equal(w.find(i => i.code === "UNKNOWN_FEATURE")?.level, "warning");
  assert.ok(codes(checked(p => { p[0].locked.model.sport_module = "soccer"; })).includes("SPORT_MODULE_MISMATCH"));
});

// ── 未来データリーク ──
test("未来データリーク：特徴量・Expert補正・学習データ終端が locked_at／試合開始より後なら error", () => {
  const cases = [
    p => { p[0].locked.features[0].observed_at = "2026-10-01T06:50:00+09:00"; },                // locked 06:40 の後
    p => { p[0].locked.expert_adjustments[0].created_at = "2026-10-01T21:00:00+09:00"; },       // 試合開始後
    p => { p[0].locked.model.trained_through = "2026-10-02T00:00:00+09:00"; },                   // 試合後まで学習
  ];
  for (const mutate of cases) assert.ok(codes(checked(mutate)).includes("FUTURE_DATA_LEAK"));
  assert.deepEqual(leakageIssues(makeProEdgeSample().pro_edge.picks[0], "2026-10-01T20:00:00+09:00"), []);
});

test("未来データリーク：市場確率・EV に locked_at 後の価格や締切オッズを使うのは error", () => {
  assert.ok(codes(checked(p => { p[0].price_snapshots[2].observed_at = "2026-10-01T07:00:00+09:00"; })).includes("FUTURE_DATA_LEAK"));
  assert.ok(codes(checked(p => { p[0].locked.offered_price.snapshot_id = "ps-s1-close-a"; })).includes("CLOSING_USED_PRE_MATCH"));
  assert.ok(codes(checked(p => { p[0].price_snapshots[3].observed_at = "2026-10-01T20:30:00+09:00"; })).includes("CLOSING_AFTER_START"));
});

// ── 時系列分割 ──
const rec = (d, y = 1) => ({ start_at: `2026-01-${String(d).padStart(2, "0")}T00:00:00Z`, y });

test("時系列分割：学習 → 検証 → テストの時間順を崩さない（入力順に依存しない）", () => {
  const records = [rec(20), rec(3), rec(15), rec(1), rec(10), rec(25)];
  const s = timeSeriesSplit(records, { train_end: "2026-01-10T00:00:00Z", validation_end: "2026-01-20T00:00:00Z" });
  assert.deepEqual(s.train.map(r => r.start_at.slice(8, 10)), ["01", "03"]);
  assert.deepEqual(s.validation.map(r => r.start_at.slice(8, 10)), ["10", "15"]);
  assert.deepEqual(s.test.map(r => r.start_at.slice(8, 10)), ["20", "25"]);
  assert.ok(assertChronological(s));
  const again = timeSeriesSplit([...records].reverse(), { train_end: "2026-01-10T00:00:00Z", validation_end: "2026-01-20T00:00:00Z" });
  assert.deepEqual(again, s);
});

test("時系列分割：未来のデータが学習側に混ざったら検出。期間の逆転も拒否", () => {
  assert.throws(() => assertChronological({ train: [rec(12)], validation: [rec(11)], test: [rec(20)] }), /順序が崩れている/);
  assert.throws(() => timeSeriesSplit([], { train_end: "2026-01-20T00:00:00Z", validation_end: "2026-01-10T00:00:00Z" }), /train_end < validation_end/);
});

test("バックテスト：学習期間だけで Elo とロジスティックを作り、テスト期間で評価（ランダム分割なし）", () => {
  const teams = ["A", "B", "C", "D"], strength = { A: 1.2, B: 0.4, C: -0.3, D: -1.1 };
  const history = [];
  let t = 0;
  for (let r = 0; r < 30; r++) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = teams[i], b = teams[j];
    const pa = 1 / (1 + Math.exp(-(strength[a] - strength[b])));
    history.push({ start_at: new Date(Date.UTC(2026, 0, 1) + t++ * 3600e3).toISOString(), side_a: a, side_b: b, winner: ((t * 7919) % 100) / 100 < pa ? "side_a" : "side_b" });
  }
  const split = timeSeriesSplit(history, { train_end: history[100].start_at, validation_end: history[140].start_at });
  assertChronological(split);
  const rowsOf = list => list.map(m => {
    const { get } = eloRatings(history, m.start_at);                  // その試合より前だけで Elo
    return { x: [(get(m.side_a) - get(m.side_b)) / 400], y: m.winner === "side_a" ? 1 : 0 };
  });
  const model = fitLogistic(rowsOf(split.train));
  const test = rowsOf(split.test);
  const brier = test.reduce((s, r) => s + (predictLogistic(model, r.x) - r.y) ** 2, 0) / test.length;
  assert.ok(brier < 0.25, `Brier ${brier}`);                           // 50/50 予想（0.25）より良い
  assert.ok(split.train.every(m => Date.parse(m.start_at) < Date.parse(split.test[0].start_at)));
});

// ── 判断・投入額・異常オッズ ──
test("accepted は投入額必須、watch / rejected は投入額なし。accepted で EV 不足は error", () => {
  assert.ok(codes(checked(p => { p[0].stake = null; })).includes("ACCEPTED_WITHOUT_STAKE"));
  assert.ok(codes(checked(p => { p[2].stake = 100; })).includes("STAKE_NOT_ALLOWED"));
  assert.ok(codes(checked(p => { p[2].locked.decision = "accepted"; p[2].stake = 100; })).includes("PRO_EDGE_CALC"));
});

test("異常オッズ：購入価格の異常は error、overround 異常は warning", () => {
  assert.ok(codes(checked(p => { p[0].bet_odds = 2000; })).includes("BET_ODDS_ANOMALY"));
  const w = checked(p => { p[4].price_snapshots[0].outcomes = { side_a: 2.2, side_b: 2.2 }; });
  assert.equal(w.find(i => i.code === "ODDS_ANOMALY")?.level, "warning");
  assert.ok(codes(w).includes("MARKET_PROBABILITY_UNAVAILABLE"));
});

test("価格スナップショットは追記のみ、購入価格は一度入れたら変更不可", () => {
  const before = makeProEdgeSample().pro_edge;
  const edited = structuredClone(before);
  edited.picks[0].price_snapshots[0].outcomes.side_a = 2.5;
  assert.ok(codes(checkLockedImmutable(before, edited)).includes("PRICE_SNAPSHOTS_REWRITTEN"));
  const appended = structuredClone(before);
  appended.picks[4].price_snapshots.push({ snapshot_id: "ps-s5-close-a", kind: "closing", bookmaker: "BookA", market: "match_winner", outcomes: { side_a: 1.8, side_b: 2.05 }, observed_at: "2026-10-03T18:59:00+09:00", source: "x" });
  assert.deepEqual(checkLockedImmutable(before, appended), []);
  const rebet = structuredClone(before);
  rebet.picks[0].bet_odds = 2.2;
  assert.ok(codes(checkLockedImmutable(before, rebet)).includes("LOCKED_FIELD_CHANGED"));
  const relocked = structuredClone(before);
  relocked.picks[0].locked.base_probability = 0.6;
  assert.ok(codes(checkLockedImmutable(before, relocked)).includes("LOCKED_FIELD_CHANGED"));
});

// ── ①〜③との独立性 ──
function combined() {
  const base = makeDataset(), pe = makeProEdgeSample();
  return { ...base, matches: { ...base.matches, matches: [...base.matches.matches, ...pe.matches.matches], update_runs: [...base.matches.update_runs, ...pe.matches.update_runs] }, pro_edge: pe.pro_edge };
}

test("①〜④が同じデータ一式で独立している（error 0件）", () => {
  const issues = validateDataset(combined(), schemas, { proEdgeConfig: cfg });
  assert.deepEqual(issues.filter(i => i.level === "error"), []);
});

test("④が①〜③と同じ試合を扱うのは可。ただし探索回・分析IDは④自身のもの", () => {
  const ds = combined();
  ds.pro_edge.picks[0].match_id = "m1";                            // ①〜③も扱う試合（事実は共有）
  ds.pro_edge.picks[0].price_snapshots = ds.pro_edge.picks[0].price_snapshots.filter(s => s.kind !== "closing");
  const errors = validateDataset(ds, schemas, { proEdgeConfig: cfg }).filter(i => i.level === "error" && i.code !== "PRE_MATCH_SNAPSHOT_AFTER_START" && i.code !== "FUTURE_DATA_LEAK");
  assert.ok(!errors.some(i => ["CROSS_SYSTEM_REFERENCE", "RUN_ID_UNKNOWN", "ID_COLLISION"].includes(i.code)), JSON.stringify(errors));
});

test("④が①〜③の探索回・分析ID・カードIDを流用したら error（共通候補プールからの振り分け禁止）", () => {
  const cases = [
    ds => { ds.pro_edge.picks[0].run_id = "v1-2026-09-19-23"; },
    ds => { ds.pro_edge.picks[0].analysis_id = "v2-an-a"; },
    ds => { ds.pro_edge.picks[0].note = "rec-r1"; },
  ];
  for (const mutate of cases) {
    const ds = combined();
    mutate(ds);
    const c = [...checkIndependence(ds).map(i => i.code), ...validateDataset(ds, schemas, { proEdgeConfig: cfg }).map(i => i.code)];
    assert.ok(c.some(x => ["RUN_ID_UNKNOWN", "CROSS_SYSTEM_REFERENCE", "ANALYSIS_ID_PREFIX", "SCHEMA", "ID_COLLISION"].includes(x)), c.join());
  }
});

test("分析ID（analysis_id）は④だけに必須。①②③には適用しない（④追加で①②③を変えない）", () => {
  const ds = combined();
  assert.ok(ds.value2.picks.every(p => !("analysis_id" in p)));      // ①②③の fixture は④追加前のまま
  assert.ok(!checkIndependence(ds).some(i => i.code === "ANALYSIS_ID_MISSING" && i.system !== "pro_edge"));
  ds.pro_edge.picks[0].analysis_id = null;
  assert.ok(checkIndependence(ds).some(i => i.code === "ANALYSIS_ID_MISSING" && i.system === "pro_edge"));
  ds.pro_edge.picks[0].analysis_id = "v1-an-x";
  assert.ok(checkIndependence(ds).some(i => i.code === "ANALYSIS_ID_PREFIX" && i.system === "pro_edge"));
});

test("④の基本推定が他系統の推定値と完全一致したら流用の疑いを warning", () => {
  const ds = combined();
  const p = ds.pro_edge.picks[0];
  Object.assign(p, { match_id: "m1", selection: "side_a" });
  p.locked.base_probability = 0.9;                                 // 推奨 fixture の locked.prob と同じ
  const w = checkIndependence(ds).filter(i => i.code === "POSSIBLY_SHARED_ANALYSIS");
  assert.ok(w.some(i => i.system.includes("pro_edge")));
});
