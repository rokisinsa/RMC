import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSchemas } from "../scripts/load-node.js";
import { validateDataset } from "../lib/validate.js";
import { makeDataset } from "./fixtures/dataset.js";

const schemas = loadSchemas();

test("fixture 一式：error 0件、想定どおりの warning のみ", () => {
  const issues = validateDataset(makeDataset(), schemas);
  assert.deepEqual(issues.filter(i => i.level === "error"), []);
  assert.deepEqual(issues.map(i => `${i.code}:${i.id}`), ["CONDITION_CHECKED_AFTER_START:v1-f"]);
});

test("存在しない match_id を参照すると error", () => {
  const ds = makeDataset();
  ds.value2.picks[0].match_id = "m999";
  assert.ok(validateDataset(ds, schemas).some(i => i.code === "MATCH_UNKNOWN"));
});

test("match id の重複は error", () => {
  const ds = makeDataset();
  ds.matches.matches.push(structuredClone(ds.matches.matches[0]));
  assert.ok(validateDataset(ds, schemas).some(i => i.code === "MATCH_ID_DUPLICATE"));
});

test("スキーマ違反があれば整合性検査より先に止める", () => {
  const ds = makeDataset();
  ds.recommendations.picks[0].locked_at = "2026-09-19 23:30";
  const issues = validateDataset(ds, schemas);
  assert.ok(issues.length > 0 && issues.every(i => i.code === "SCHEMA"));
});

test("一部のファイルだけでも検証できる（段階的な移行用）", () => {
  const ds = makeDataset();
  const issues = validateDataset({ matches: ds.matches, value2: ds.value2 }, schemas);
  assert.deepEqual(issues, []);
});
