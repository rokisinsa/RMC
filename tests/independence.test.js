import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIndependence } from "../lib/integrity.js";
import { makeDataset } from "./fixtures/dataset.js";

const codes = issues => issues.map(i => i.code);

test("fixture：3分析系統＋経験値取引は独立している", () => {
  assert.deepEqual(checkIndependence(makeDataset()), []);
});

test("各候補探索系統（推奨・VALUE①・VALUE②）は自分専用の探索回を持つ", () => {
  const ds = makeDataset();
  const runs = ["recommendations", "value1", "value2"].map(s => ds[s].discovery_runs.map(r => r.run_id));
  assert.equal(new Set(runs.flat()).size, 3);   // 同じ時刻でも探索回は3つ別々
});

test("共通候補の振り分け（他系統の探索回 run_id を使う）は禁止", () => {
  const ds = makeDataset();
  ds.value1.picks[0].run_id = "rec-2026-09-19-23";
  const c = codes(checkIndependence(ds));
  assert.ok(c.includes("RUN_ID_UNKNOWN"));
  assert.ok(c.includes("CROSS_SYSTEM_REFERENCE"));
});

test("共通の探索回を各系統へ登録する（同じ run_id を複数ファイルに置く）のは禁止", () => {
  const ds = makeDataset();
  const shared = { run_id: "shared-2026-09-19-23", started_at: "2026-09-19T23:00:00+09:00", slot: "23:00", note: null };
  for (const s of ["recommendations", "value1", "value2"]) {
    ds[s].discovery_runs.push(structuredClone(shared));
    ds[s].picks[0].run_id = shared.run_id;
  }
  const c = codes(checkIndependence(ds));
  assert.ok(c.includes("RUN_ID_PREFIX"));
  assert.ok(c.includes("ID_COLLISION"));
});

test("候補探索系統のカードは run_id 必須、経験値取引は run_id を持たない", () => {
  const ds = makeDataset();
  ds.value2.picks[0].run_id = null;
  ds.experience.picks[0].run_id = "rec-2026-09-19-23";
  const c = codes(checkIndependence(ds));
  assert.ok(c.includes("RUN_ID_MISSING"));
  assert.ok(c.includes("RUN_ID_NOT_ALLOWED"));
});

test("他系統のカードIDをどの項目からも参照できない", () => {
  const ds = makeDataset();
  ds.value2.picks[0].note = "v1-a";   // VALUE① のカードを流用した痕跡
  const issues = checkIndependence(ds);
  assert.ok(issues.some(i => i.code === "CROSS_SYSTEM_REFERENCE" && i.id === "v2-a"));
});

test("ファイルと中身の system 不一致・ID接頭辞違いを検出", () => {
  const ds = makeDataset();
  ds.value1.picks[1].system = "value2";
  ds.value2.picks[0].id = "v1-zzz";
  const c = codes(checkIndependence(ds));
  assert.ok(c.includes("SYSTEM_MISMATCH"));
  assert.ok(c.includes("ID_PREFIX"));
});

test("matches.json は客観的事実のみ（分析判断のキーはネストしても検出）", () => {
  const ds = makeDataset();
  ds.matches.matches[0].result.text = "2-0";                   // 事実なのでOK
  assert.deepEqual(checkIndependence(ds), []);
  ds.matches.matches[0].result.analysis = { prob: 0.8 };        // 分析判断
  ds.matches.matches[1].verdict = "formal";
  const issues = checkIndependence(ds).filter(i => i.code === "MATCH_HAS_ANALYSIS");
  assert.equal(issues.length, 2);
});

test("試合事実は共有してよい（同じ match_id を複数系統が参照するのは正常）", () => {
  const ds = makeDataset();
  assert.equal(ds.recommendations.picks[0].match_id, ds.value1.picks[0].match_id);
  assert.deepEqual(checkIndependence(ds), []);
});

test("別系統で同じ試合・選択の事前分析が完全一致したら共通分析の流用を警告", () => {
  const ds = makeDataset();
  const v2 = ds.value2.picks[0];                                  // m3 / home
  const v1 = structuredClone(ds.value1.picks[0]);
  v1.id = "v1-copy"; v1.match_id = "m3"; v1.market = "match_winner"; v1.selection = "home";
  v1.locked.summary = v2.locked.summary;
  ds.value1.picks.push(v1);
  const w = checkIndependence(ds).filter(i => i.code === "POSSIBLY_SHARED_ANALYSIS");
  assert.equal(w.length, 1);
  assert.equal(w[0].level, "warning");
});
