import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSchemas } from "../scripts/load-node.js";
import { createValidator } from "../lib/schema-validate.js";
import { makeDataset } from "./fixtures/dataset.js";

const schemas = loadSchemas();
const validate = createValidator(schemas);
const SCHEMA_OF = {
  matches: "matches.schema.json",
  recommendations: "recommendations.schema.json",
  experience: "experience.schema.json",
  value1: "value1.schema.json",
  value2: "value2.schema.json",
};

test("5つのデータファイルのスキーマがすべて存在する", () => {
  for (const id of [...Object.values(SCHEMA_OF), "defs.schema.json"]) assert.ok(schemas[id], id);
});

test("fixture の全ファイルがスキーマに適合する", () => {
  const ds = makeDataset();
  for (const [name, id] of Object.entries(SCHEMA_OF)) assert.deepEqual(validate(id, ds[name]), [], name);
});

test("検証器は未対応キーワードを黙って無視しない", () => {
  const v = createValidator({ "x.json": { $id: "x.json", type: "object", oneOf: [] } });
  assert.throws(() => v("x.json", {}), /未対応のスキーマキーワード "oneOf"/);
});

test("matches.json に分析判断（verdict・推定勝率・オッズ等）を入れるとスキーマ違反", () => {
  for (const key of ["verdict", "prob", "odds_taken", "confidence", "selection", "stake"]) {
    const ds = makeDataset();
    ds.matches.matches[0][key] = key === "verdict" ? "formal" : 0.5;
    const errors = validate("matches.schema.json", ds.matches);
    assert.ok(errors.some(e => e.includes(`定義されていない項目 "${key}"`)), key);
  }
});

test("オフセットなしの日時はスキーマ違反", () => {
  const ds = makeDataset();
  ds.matches.matches[0].start_at = "2026-09-20T20:00:00";
  assert.ok(validate("matches.schema.json", ds.matches).some(e => e.includes("start_at") && e.includes("タイムゾーン")));

  const ds2 = makeDataset();
  ds2.recommendations.picks[0].locked_at = "2026-09-19T23:30:00";
  assert.ok(validate("recommendations.schema.json", ds2.recommendations).some(e => e.includes("locked_at")));
});

test("start_at / bet_at / discovered_at / locked_at は別項目として必須", () => {
  const ds = makeDataset();
  for (const key of ["discovered_at", "bet_at", "locked_at"]) {
    const p = structuredClone(ds.recommendations);
    delete p.picks[0][key];
    assert.ok(validate("recommendations.schema.json", p).some(e => e.includes(`必須項目 "${key}"`)), key);
  }
  const m = structuredClone(ds.matches);
  delete m.matches[0].start_at;
  assert.ok(validate("matches.schema.json", m).some(e => e.includes(`必須項目 "start_at"`)));
});

test("odds_taken は 1 より大きい一点の数値か null。文字列レンジは不可", () => {
  for (const bad of [1, 0.9, "1.17〜1.20", "1.25"]) {
    const ds = makeDataset();
    ds.recommendations.picks[0].odds_taken = bad;
    assert.ok(validate("recommendations.schema.json", ds.recommendations).length > 0, String(bad));
  }
  const ds = makeDataset();
  ds.recommendations.picks[0].odds_taken = null;
  assert.deepEqual(validate("recommendations.schema.json", ds.recommendations), []);
});

test("market_odds と odds_taken は別項目（market_odds はレンジを min/max で保持できる）", () => {
  const ds = makeDataset();
  ds.value1.picks[0].market_odds = { text: "1.95〜2.00", min: 1.95, max: 2.0, observed_at: "2026-09-19T23:20:00+09:00", source: "公開市場" };
  assert.deepEqual(validate("value1.schema.json", ds.value1), []);
});

test("系統ごとのID接頭辞・system値・判定値が強制される", () => {
  const cases = [
    ["recommendations", p => { p.id = "v1-x"; }, "形式が不正"],
    ["recommendations", p => { p.system = "value1"; }, "\"recommendations\" である必要"],
    ["value1", p => { p.locked.verdict = "adopted"; }, "許可されていない値"],
    ["value2", p => { p.locked.verdict = "formal"; }, "許可されていない値"],
    ["value1", p => { p.run_id = "v2-2026-09-19-23"; }, "形式が不正"],
    ["experience", p => { p.run_id = "rec-2026-09-19-23"; }, "型が不正"],
  ];
  for (const [system, mutate, expected] of cases) {
    const ds = makeDataset();
    mutate(ds[system].picks[0]);
    const errors = validate(SCHEMA_OF[system], ds[system]);
    assert.ok(errors.some(e => e.includes(expected)), `${system}: ${errors.join(" / ")}`);
  }
});

test("精算状態は明示的な値だけ（win/loss/push/void）", () => {
  const ds = makeDataset();
  ds.recommendations.picks[0].settlement_override = { state: "cancelled", reason: "x", set_at: "2026-09-26T00:00:00+09:00", source: null };
  assert.ok(validate("recommendations.schema.json", ds.recommendations).some(e => e.includes("許可されていない値")));
  ds.recommendations.picks[0].settlement_override.state = "void";
  assert.deepEqual(validate("recommendations.schema.json", ds.recommendations), []);
});

test("払戻し・純損益は保存項目に存在しない（自動計算のみ）", () => {
  for (const key of ["payout", "profit", "result"]) {
    const ds = makeDataset();
    ds.recommendations.picks[0][key] = 120;
    assert.ok(validate("recommendations.schema.json", ds.recommendations).some(e => e.includes(`定義されていない項目 "${key}"`)), key);
  }
});
