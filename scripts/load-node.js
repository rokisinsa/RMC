// Node 専用の読み込み補助（lib/ はブラウザでも使えるよう fs に依存させない）。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DATA_FILES = {
  matches: "matches.json",
  recommendations: "recommendations.json",
  experience: "experience.json",
  value1: "value1.json",
  value2: "value2.json",
  legacy_unassigned: "legacy-unassigned.json",
};

export function loadSchemas(dir = join(ROOT, "schema")) {
  const schemas = {};
  for (const file of readdirSync(dir).filter(f => f.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
    schemas[schema.$id] = schema;
  }
  return schemas;
}

// 存在するデータファイルだけを読み込む。{ datasets, missing }
export function loadDatasets(dir = join(ROOT, "data")) {
  const datasets = {}, missing = [];
  for (const [name, file] of Object.entries(DATA_FILES)) {
    const path = join(dir, file);
    if (existsSync(path)) datasets[name] = JSON.parse(readFileSync(path, "utf8"));
    else missing.push(file);
  }
  return { datasets, missing };
}
