// 事前値 locked の保護と、試合事実の変更履歴のチェック。基準コミット時点の data/*.json と現在の data/*.json を比べ、
// locked 済みカードの事前値が書き換えられていないかを検査する。
// 使い方: node scripts/check-locked.js <基準コミット>   （例: HEAD~1, origin/main, コミットSHA）

import { execFileSync } from "node:child_process";
import { loadDatasets, DATA_FILES, ROOT } from "./load-node.js";
import { checkLockedImmutable, checkMatchHistory, SYSTEMS } from "../lib/integrity.js";
import { checkMatchUpdatesAppendOnly } from "../lib/match-updates.js";

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
// 移行用下書き（meta.status = "draft"）はスクリプトから再生成するため比較しない。本番化（active）以降のデータだけを保護する。
const isDraft = data => data?.meta?.status === "draft";
let errors = 0;
for (const system of SYSTEMS) {
  const before = readAt(base, DATA_FILES[system]);
  if (!before) continue;
  if (isDraft(before)) { console.log(`${DATA_FILES[system]}: 基準時点は下書き（draft）のため比較しない`); continue; }
  for (const i of checkLockedImmutable(before, datasets[system] ?? null)) {
    console.log(`[${i.level}] ${i.code} ${i.system} ${i.id}: ${i.message}`);
    if (i.level === "error") errors++;
  }
}
const matchesBefore = readAt(base, DATA_FILES.matches);
if (isDraft(matchesBefore)) console.log("matches.json: 基準時点は下書き（draft）のため比較しない");
for (const i of isDraft(matchesBefore) ? [] : checkMatchHistory(matchesBefore, datasets.matches ?? null)) {
  console.log(`[${i.level}] ${i.code} ${i.system} ${i.id}: ${i.message}`);
  if (i.level === "error") errors++;
}
for (const i of checkMatchUpdatesAppendOnly(readAt(base, DATA_FILES.match_updates), datasets.match_updates ?? null)) {
  console.log(`[${i.level}] ${i.code}: ${i.message}`);
  errors++;
}
console.log(errors ? `locked 保護違反 ${errors} 件` : "locked 保護: 問題なし");
process.exit(errors ? 1 : 0);
