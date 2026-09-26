// 事前値 locked の保護チェック。基準コミット時点の data/*.json と現在の data/*.json を比べ、
// locked 済みカードの事前値が書き換えられていないかを検査する。
// 使い方: node scripts/check-locked.js <基準コミット>   （例: HEAD~1, origin/main, コミットSHA）

import { execFileSync } from "node:child_process";
import { loadDatasets, DATA_FILES, ROOT } from "./load-node.js";
import { checkLockedImmutable, SYSTEMS } from "../lib/integrity.js";

const base = process.argv[2];
if (!base) {
  console.error("基準コミットを指定してください（例: node scripts/check-locked.js HEAD~1）");
  process.exit(2);
}
if (/^0+$/.test(base)) {
  console.log("基準コミットがありません（新規ブランチの初回 push）。スキップします。");
  process.exit(0);
}

function readAt(ref, file) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:data/${file}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null; // 基準時点にファイルが無い
  }
}

const { datasets } = loadDatasets();
let errors = 0;
for (const system of SYSTEMS) {
  const before = readAt(base, DATA_FILES[system]);
  if (!before) continue;
  for (const i of checkLockedImmutable(before, datasets[system] ?? null)) {
    console.log(`[${i.level}] ${i.code} ${i.system} ${i.id}: ${i.message}`);
    if (i.level === "error") errors++;
  }
}
console.log(errors ? `locked 保護違反 ${errors} 件` : "locked 保護: 問題なし");
process.exit(errors ? 1 : 0);
