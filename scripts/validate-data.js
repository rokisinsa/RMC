// data/*.json をスキーマと整合性ルールで検証する。error が1件でもあれば終了コード1。
// 使い方: node scripts/validate-data.js [データディレクトリ]

import { loadSchemas, loadDatasets } from "./load-node.js";
import { validateDataset } from "../lib/validate.js";

const dir = process.argv[2];
const { datasets, missing } = loadDatasets(dir);

if (Object.keys(datasets).length === 0) {
  console.log("data/*.json はまだありません（手順2で作成予定）。検証をスキップします。");
  process.exit(0);
}
if (missing.length) console.log(`未作成のデータファイル: ${missing.join(", ")}`);

const issues = validateDataset(datasets, loadSchemas());
for (const i of issues) {
  console.log(`[${i.level}] ${i.code} ${i.system}${i.id ? ` ${i.id}` : ""}: ${i.message}`);
}
const errors = issues.filter(i => i.level === "error").length;
console.log(`error ${errors} 件 / warning ${issues.length - errors} 件`);
process.exit(errors ? 1 : 0);
