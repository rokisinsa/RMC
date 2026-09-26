// 手順2：移行データ（data/*.json）を新ロジックで集計し、baseline と比較する。
//
// 分類
//   A. 一致           … 新ロジックの値が baseline の期待値（手順0）と一致
//   B. 意図した変更   … 期待値と違うが、理由が下の INTENDED_CHANGES に明記されているもの
//   C. 説明できない不一致 … それ以外すべて（1件でもあれば終了コード1）
// 表示値（現行ページ）との差は、手順0の README で説明済みの仕様変更として別欄に並べる。
//
// 出力: migration/compare-report.json と標準出力

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDatasets } from "../scripts/load-node.js";
import { summarizeSystem } from "../lib/buckets.js";
import { compound, quarterKelly } from "../lib/summary.js";
import { deepEqual } from "../lib/schema-validate.js";

const baseline = JSON.parse(readFileSync(join(ROOT, "baseline/2026-09-26/baseline.json"), "utf8"));
const { datasets } = loadDatasets();
const matchesById = new Map(datasets.matches.matches.map(m => [m.id, m]));

// ── 手順2で意図して変わる項目（理由を明記） ─────────────────────────
const INTENDED_CHANGES = [
  {
    path: "recommendations.compound.stock", from: 114.8, to: 140.58,
    reason: "Lyon・Italy の開始時刻を人間確認で確定（9/24 01:45 / 04:05 JST、mr-2026-09-26-human-review）したことで、並び順が旧 data-ts（9/23 12:13 / 9/22 21:56）から実際の開始時刻に変わった。Tunisia→Corinthians→Prizmic→Bounty→Lyon→Italy の6連勝で初めて倍額に到達（1.17×1.11×1.19×1.13×1.12×1.23＝2.4058 → ストック $140.58）。旧順では Italy の時点で $214.80 に到達していた。確保回数1回・失敗2回・現在資金$100は同じ",
  },
];
// 参考：前回（手順2初回）登録していた最大連敗 1→2 と 1/4ケリー +$0.82→$0 の変更は、今回の確定事項
// （Lyon 0.922 の locked 採用、ODDIK の開始時刻を要確認として並び順にロック時刻を使用）により解消し、手順0の期待値と一致した。

// ── 新ロジックでの集計 ──────────────────────────────────────
const sys = name => summarizeSystem(datasets[name], matchesById);
const rec = sys("recommendations"), exp = sys("experience"), v1 = sys("value1"), v2 = sys("value2");
const recSettlements = rec.groups.official.map(g => g.settlement);
const firstOfDup = new Set();
const recDedup = rec.groups.official.filter(({ pick }) => {
  if (!pick.flags.includes("duplicate_review")) return true;
  const key = `${pick.match_id}|${pick.market}|${pick.selection}`;
  if (firstOfDup.has(key)) return false;
  firstOfDup.add(key);
  return true;
}).map(g => g.settlement);
const { summarize } = await import("../lib/summary.js");

const computed = {
  recommendations: {
    all_rows: rec.official,
    duplicates_counted_once_reference: summarize(recDedup),
    compound: compound(recSettlements, 100),
    quarter_kelly_locked_prob_only: quarterKelly(rec.groups.official.map(g => ({ settlement: g.settlement, prob: g.pick.locked?.prob ?? null })), 100),
  },
  experience: { all_rows: exp.official },
  value1: {
    verdict_counts: v1.verdictCounts,
    official: v1.official,
    official_compound: compound(v1.groups.official.map(g => g.settlement), 100),
    reference: v1.reference,
    not_counted: [...v1.groups.conditional_unmet, ...v1.groups.excluded].map(g => g.pick.id),
  },
  value2: {
    verdict_counts: v2.verdictCounts,
    official: v2.official,
    official_compound: compound(v2.groups.official.map(g => g.settlement), 100),
    reference: v2.reference,
    not_counted: [...v2.groups.conditional_unmet, ...v2.groups.excluded].map(g => g.pick.id),
  },
};

// ── 比較 ─────────────────────────────────────────────────
function* leaves(obj, path = "") {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) yield* leaves(v, path ? `${path}.${k}` : k);
  } else yield [path, obj];
}
const expectedLeaves = new Map(leaves(baseline.expected));
const computedLeaves = new Map(leaves(computed));
const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : deepEqual(a, b));

const matched = [], intended = [], unexplained = [];
for (const path of new Set([...expectedLeaves.keys(), ...computedLeaves.keys()])) {
  // not_counted は手順0では表示名、手順2ではカードIDなので件数で比較する
  if (path.endsWith("not_counted")) {
    const a = expectedLeaves.get(path)?.length, b = computedLeaves.get(path)?.length;
    (a === b ? matched : unexplained).push({ path, expected: a, computed: b, note: "件数で比較" });
    continue;
  }
  const a = expectedLeaves.get(path), b = computedLeaves.get(path);
  if (!expectedLeaves.has(path) || !computedLeaves.has(path)) {
    unexplained.push({ path, expected: a ?? "(なし)", computed: b ?? "(なし)" });
  } else if (same(a, b)) {
    matched.push({ path, value: a });
  } else {
    const rule = INTENDED_CHANGES.find(r => r.path === path && same(r.from, a) && same(r.to, b));
    (rule ? intended : unexplained).push({ path, expected: a, computed: b, ...(rule ? { reason: rule.reason } : {}) });
  }
}
for (const r of INTENDED_CHANGES) {
  if (!intended.some(i => i.path === r.path)) unexplained.push({ path: r.path, note: "意図した変更として登録したのに発生しなかった", expected: r.from, computed: computedLeaves.get(r.path) });
}

// ── カード単位の照合（旧表示の結果記号・投入額・オッズと一致するか） ─────────
const STATE_OF = { win: "win", loss: "loss", open: "pending" };
const perPick = [];
const legacyRows = baseline.legacy_rows;
for (const [name, rows, table] of [
  ["recommendations", legacyRows.recommendations, "resultTable"], ["experience", legacyRows.experience, "actualBetTable"],
  ["value1", legacyRows.value1, "oddsTestTable"], ["value2", legacyRows.value2, "oddsTestTable2"],
]) {
  const bucketOf = new Map();
  for (const [bucket, list] of Object.entries(sys(name).groups)) for (const g of list) bucketOf.set(g.pick.id, { bucket, s: g.settlement });
  for (const row of rows) {
    const pick = datasets[name].picks.find(p => p.legacy.table === table && p.legacy.row_index === row.legacy_index);
    if (!pick) { unexplained.push({ path: `${name}#${row.legacy_index}`, note: "旧行が移行されていない" }); continue; }
    const { bucket, s } = bucketOf.get(pick.id);
    const legacyState = STATE_OF[row.status];
    const checks = {
      state: [legacyState, s.state],
      odds_taken: [row.odds_taken_provisional, pick.odds_taken],
      ...(row.data_stake !== undefined ? { stake: [row.data_stake, pick.stake] } : {}),
    };
    for (const [k, [a, b]] of Object.entries(checks)) {
      if (!same(a, b)) unexplained.push({ path: `${name}.${pick.id}.${k}`, expected: a, computed: b, note: "旧行と移行データの不一致" });
    }
    perPick.push({ id: pick.id, bucket, state: s.state, reason: s.reason, profit: s.profit, projected: s.projectedProfit });
  }
  if (rows.length !== datasets[name].picks.length) {
    unexplained.push({ path: `${name}.count`, expected: rows.length, computed: datasets[name].picks.length, note: "件数不一致" });
  }
}

// ── 精度検証（Brier / Log Loss）：locked 確率のみ ───────────────────────
const calib = rec.groups.official.filter(g => g.pick.locked?.prob != null && ["win", "loss"].includes(g.settlement.state));
const clamp = p => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
const calibration = {
  count: calib.length,
  brier: calib.length ? calib.reduce((s, g) => s + (g.pick.locked.prob - (g.settlement.state === "win" ? 1 : 0)) ** 2, 0) / calib.length : null,
  log_loss: calib.length ? calib.reduce((s, g) => {
    const y = g.settlement.state === "win" ? 1 : 0, p = clamp(g.pick.locked.prob);
    return s - (y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }, 0) / calib.length : null,
  ids: calib.map(g => g.pick.id),
};

const report = { computed, calibration, matched_count: matched.length, intended, unexplained, per_pick: perPick };
writeFileSync(join(ROOT, "migration", "compare-report.json"), JSON.stringify(report, null, 2) + "\n");

console.log(`A. 一致: ${matched.length} 項目`);
console.log(`B. 意図した変更: ${intended.length} 項目`);
for (const i of intended) console.log(`   - ${i.path}: ${JSON.stringify(i.expected)} → ${JSON.stringify(i.computed)}（${i.reason}）`);
console.log(`C. 説明できない不一致: ${unexplained.length} 件`);
for (const u of unexplained) console.log(`   - ${u.path}: ${JSON.stringify(u.expected)} → ${JSON.stringify(u.computed)} ${u.note ?? ""}`);
console.log(`精度検証（locked確率のみ）: ${calibration.count}件 Brier ${calibration.brier?.toFixed(4)} LogLoss ${calibration.log_loss?.toFixed(4)}`);
process.exit(unexplained.length ? 1 : 0);
