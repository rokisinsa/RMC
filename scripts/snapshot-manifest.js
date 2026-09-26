// 移行スナップショットの内容ハッシュ一覧（MANIFEST.json）を作る／確かめる。改行コードの差は無視する。
// 使い方: node scripts/snapshot-manifest.js create|verify [snapshots/2026-09-26-migration]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { ROOT } from "./load-node.js";

export const SNAPSHOT_DIR = join(ROOT, "snapshots", "2026-09-26-migration");

function files(dir) {
  const out = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else out.push(p);
    }
  })(dir);
  return out.sort();
}
const hash = p => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r/g, "")).digest("hex");

export function computeManifest(dir = SNAPSHOT_DIR) {
  return Object.fromEntries(files(join(dir, "data")).map(p => [relative(dir, p).replace(/\\/g, "/"), hash(p)]));
}

export function verifyManifest(dir = SNAPSHOT_DIR) {
  const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
  const now = computeManifest(dir);
  const problems = [];
  for (const [f, h] of Object.entries(manifest.files)) {
    if (!(f in now)) problems.push(`${f} が無い`);
    else if (now[f] !== h) problems.push(`${f} が変更されている`);
  }
  for (const f of Object.keys(now)) if (!(f in manifest.files)) problems.push(`${f} が追加されている`);
  return problems;
}

if (process.argv[1]?.endsWith("snapshot-manifest.js")) {
  const [cmd, d] = process.argv.slice(2);
  const dir = d ? join(ROOT, d) : SNAPSHOT_DIR;
  if (cmd === "create") {
    if (existsSync(join(dir, "MANIFEST.json"))) { console.error("MANIFEST.json は作成済み（スナップショットは不変）"); process.exit(1); }
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({
      source_commit: "fa22aa6",
      description: "本番切替前の移行スナップショット（不変）。06:45 基準点（baseline-2026-09-26）から移行したデータ＋人間確認＋最初の結果更新（mr-2026-09-26-1937-result-update）。これ以降の更新は data/ 側にだけ追加する",
      files: computeManifest(dir),
    }, null, 2) + "\n");
    console.log("MANIFEST.json を作成しました");
  } else {
    const p = verifyManifest(dir);
    console.log(p.length ? p.join("\n") : "スナップショットは不変");
    process.exit(p.length ? 1 : 0);
  }
}
