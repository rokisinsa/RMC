// テストを2段階で実行する。
//   1) snapshot 段：単体テストと、移行時点のデータを検証するテスト（tests/*.test.js）を、
//      不変の移行スナップショット（snapshots/2026-09-26-migration/data）に対して実行する。
//      → GPT 定時更新で data/ が増えても、移行時点の検証は影響を受けない。
//   2) live 段：tests/live/*.test.js を現在の data/ に対して実行する。
//      → 新しい試合・結果が追加されても、スキーマ・整合性・計算ルールが正しければ通る。
// 使い方: node scripts/run-tests.js [snapshot|live]（省略時は両方）

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./load-node.js";

const SNAPSHOT_DATA = "snapshots/2026-09-26-migration/data";
const list = dir => readdirSync(join(ROOT, dir)).filter(f => f.endsWith(".test.js")).map(f => `${dir}/${f}`);
const phases = {
  snapshot: { files: list("tests"), env: { RMC_DATA_DIR: SNAPSHOT_DATA }, label: `snapshot（${SNAPSHOT_DATA}）` },
  live: { files: list("tests/live"), env: {}, label: "live（data/）" },
};

const which = process.argv[2] ? [process.argv[2]] : ["snapshot", "live"];
let failed = false;
for (const name of which) {
  const p = phases[name];
  if (!p) { console.error(`不明な段: ${name}`); process.exit(2); }
  console.log(`\n=== ${p.label}：${p.files.length} ファイル ===`);
  const env = { ...process.env, ...p.env };
  if (!p.env.RMC_DATA_DIR) delete env.RMC_DATA_DIR;
  const r = spawnSync(process.execPath, ["--test", ...p.files], { cwd: ROOT, env, stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
