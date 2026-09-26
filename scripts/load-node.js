// Node 専用の読み込み補助（lib/ はブラウザでも使えるよう fs に依存させない）。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// データの読み込み先。既定は data/（現在のデータ）。RMC_DATA_DIR を指定すると、そのディレクトリ
// （例：移行スナップショット snapshots/2026-09-26-migration/data）を読む。
export const DATA_DIR = process.env.RMC_DATA_DIR ? resolve(ROOT, process.env.RMC_DATA_DIR) : join(ROOT, "data");

export const DATA_FILES = {
  matches: "matches.json",
  recommendations: "recommendations.json",
  experience: "experience.json",
  value1: "value1.json",
  value2: "value2.json",
  legacy_unassigned: "legacy-unassigned.json",
  pro_edge: "pro_edge.json",
  match_updates: "match-updates.json",
  legacy_analysis_recommendations: "legacy-analysis/recommendations.json",
  legacy_analysis_value1: "legacy-analysis/value1.json",
  legacy_analysis_value2: "legacy-analysis/value2.json",
  post_match_recommendations: "post-match-reviews/recommendations.json",
  post_match_experience: "post-match-reviews/experience.json",
  post_match_value1: "post-match-reviews/value1.json",
  post_match_value2: "post-match-reviews/value2.json",
  post_match_pro_edge: "post-match-reviews/pro_edge.json",
};

export function loadProEdgeConfig(path = join(ROOT, "config", "pro-edge.config.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSchemas(dir = join(ROOT, "schema")) {
  const schemas = {};
  for (const file of readdirSync(dir).filter(f => f.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
    schemas[schema.$id] = schema;
  }
  return schemas;
}

// 存在するデータファイルだけを読み込む。{ datasets, missing }
// 任意ファイル（移行スナップショットより後に追加されたもの。無くても欠けとして扱わない）
export const OPTIONAL_DATA_FILES = new Set(["post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

export function loadDatasets(dir = DATA_DIR) {
  const datasets = {}, missing = [];
  for (const [name, file] of Object.entries(DATA_FILES)) {
    const path = join(dir, file);
    if (existsSync(path)) datasets[name] = JSON.parse(readFileSync(path, "utf8"));
    else if (!OPTIONAL_DATA_FILES.has(name)) missing.push(file);
  }
  return { datasets, missing };
}
