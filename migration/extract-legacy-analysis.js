// 旧RMCの分析本文（H2H・直近成績・ランキング・Rating・得失点・SET/MAP差・分析理由・リスクなど）を
// 旧 analysis.html（基準点 baseline-2026-09-26）から取り出し、各系統に所属するファイルへ保存する。
//   原文 raw_html をそのまま保持し、構造化できるものだけ blocks に構造化する（書き換え・要約はしない）。
//   旧 analysis.js の要約文（easySummaries）も原文のまま js_summary に保持する。
//   事前固定を確認できない確率表示（probability-box）は blocks に入れない（原文には残る）。
// 出力: data/legacy-analysis/recommendations.json, value1.json, value2.json
// 使い方: node migration/extract-legacy-analysis.js

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/load-node.js";
import { parse, toBlocks } from "./legacy-html.js";


// 安全装置：本番切替後に誤って再実行すると、GPT 定時更新で追加されたデータを旧データで上書きしてしまう。
// 移行用下書きを作り直すときだけ、RMC_ALLOW_MIGRATION_REGENERATE=1 を付けて実行する。
if (process.env.RMC_ALLOW_MIGRATION_REGENERATE !== "1") {
  console.error("このスクリプトは移行用下書きの再生成専用です。data/ を上書きするため、通常は実行しません（RMC_ALLOW_MIGRATION_REGENERATE=1 が必要）。");
  process.exit(1);
}

const REF = "baseline-2026-09-26";
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const COMMIT = git("rev-parse", "--short=7", `${REF}^{commit}`).trim();
const AS_OF = git("show", "-s", "--format=%cI", `${REF}^{commit}`).trim();
const html = git("show", `${REF}:analysis.html`);
const js = git("show", `${REF}:analysis.js`);
const load = f => JSON.parse(readFileSync(join(ROOT, "data", f), "utf8"));

// 旧 analysis.js の要約文（原文）
const ctx = vm.createContext({ document: { addEventListener() {} }, Math, Number, String, Date, Object });
vm.runInContext(js, ctx);
const easySummaries = vm.runInContext("easySummaries", ctx);

function detailFragment(id) {
  const m = new RegExp(`<tr class="detail-row" id="${id}"><td[^>]*class="detail-cell"[^>]*>([^]*?)(?=<tr class="|</tbody>)`).exec(html);
  return m ? m[1].replace(/<\/td><\/tr>\s*$/, "") : null;
}
function valueFragments(tableId) {
  const body = new RegExp(`<table id="${tableId}">[^]*?<tbody>([^]*?)</tbody>`).exec(html)[1];
  return [...body.matchAll(/<tr>\s*<td class="result[^]*?<\/tr>\s*<tr><td colspan="\d+">([^]*?)<\/td><\/tr>/g)].map(m => m[1]);
}

function entry(pick, raw, location) {
  const excluded = [];
  const blocks = toBlocks(parse(raw), excluded);
  const js_summary = pick.detail_ref && easySummaries[pick.detail_ref]
    ? { market: easySummaries[pick.detail_ref].market, reason: easySummaries[pick.detail_ref].reason, caution: easySummaries[pick.detail_ref].caution }
    : null;
  return {
    pick_id: pick.id,
    source: { file: "analysis.html", commit: COMMIT, location },
    raw_html: raw,
    blocks,
    excluded_from_blocks: excluded,
    js_summary,
  };
}

const meta = label => ({
  generated_by: "migration/extract-legacy-analysis.js", legacy_source: "analysis.html", legacy_commit: COMMIT,
  as_of: AS_OF, status: "draft",
  note: `${label}の旧分析本文（原文と構造化）。書き換え・要約はしていない。事前固定を確認できない確率表示は構造化の対象外（raw_html には原文のまま残る）`,
});

const out = {};
// ① 推奨取引：詳細行（detail_ref）ごと
out.recommendations = {
  schema_version: 1, meta: meta("① 推奨取引"), system: "recommendations",
  entries: load("recommendations.json").picks.filter(p => p.detail_ref).map(p => {
    const raw = detailFragment(p.detail_ref);
    if (raw == null) throw new Error(`${p.id}: 詳細行 ${p.detail_ref} が見つからない`);
    return entry(p, raw, `#${p.detail_ref} .detail-cell`);
  }),
};
// ② VALUE① / ③ VALUE②：旧表の各行の直後にある分析行
for (const [system, table, label] of [["value1", "oddsTestTable", "② VALUE①"], ["value2", "oddsTestTable2", "③ VALUE②"]]) {
  const frags = valueFragments(table);
  const picks = load(`${system}.json`).picks;
  if (frags.length !== picks.length) throw new Error(`${system}: 分析行 ${frags.length} 件とカード ${picks.length} 件が合わない`);
  out[system] = {
    schema_version: 1, meta: meta(label), system,
    entries: picks.map(p => entry(p, frags[p.legacy.row_index], `#${table} tbody 行${p.legacy.row_index}の直後の分析行`)),
  };
}

mkdirSync(join(ROOT, "data", "legacy-analysis"), { recursive: true });
for (const [system, data] of Object.entries(out)) {
  writeFileSync(join(ROOT, "data", "legacy-analysis", `${system}.json`), JSON.stringify(data, null, 2) + "\n");
  console.log(`data/legacy-analysis/${system}.json: ${data.entries.length} 件`);
}
