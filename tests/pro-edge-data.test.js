// ④ PRO EDGE：本データ（data/pro_edge.json）の検査。①②③のテストとは分離。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDatasets, loadSchemas, loadProEdgeConfig } from "../scripts/load-node.js";
import { validateDataset } from "../lib/validate.js";

const { datasets } = loadDatasets();

test("④ PRO EDGE の data/pro_edge.json は空の下書き（旧データ無し・架空カードを入れない）", () => {
  assert.equal(datasets.pro_edge.system, "pro_edge");
  assert.equal(datasets.pro_edge.meta.status, "draft");
  assert.deepEqual([datasets.pro_edge.discovery_runs, datasets.pro_edge.picks], [[], []]);
});

test("④を含む本データ一式が error 0件で検証を通る", () => {
  const errors = validateDataset(datasets, loadSchemas(), { proEdgeConfig: loadProEdgeConfig() }).filter(i => i.level === "error");
  assert.deepEqual(errors, []);
});
