// V2 画面（新データ＋lib/view）と旧RMC（baseline-2026-09-26 の analysis.html 表示）を照合する。
// 分類：一致 / 意図した差（理由を明記） / 説明できない差（1件でもあれば終了コード1）
// 使い方: node scripts/v2-compare-legacy.js

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadDatasets, loadProEdgeConfig } from "./load-node.js";
import { buildViewModel } from "../lib/view/model.js";
import { money, amount, RESULT_SYMBOL } from "../lib/view/format.js";

const baseline = JSON.parse(readFileSync(join(ROOT, "baseline/2026-09-26/baseline.json"), "utf8"));
const vm = buildViewModel(loadDatasets().datasets, { proEdgeConfig: loadProEdgeConfig() });
const matched = [], intended = [], unexplained = [];
const check = (path, legacy, v2, reasonIfDiff = null) => {
  if (legacy === v2) matched.push(path);
  else if (reasonIfDiff) intended.push({ path, legacy, v2, reason: reasonIfDiff });
  else unexplained.push({ path, legacy, v2 });
};

// V2 の損益セル表示（lib/view/render.js の moneyCells と同じ規則）
function v2Cells(s) {
  if (s.state === "pending") {
    return s.projectedProfit == null ? { payout: "未確定", profit: "未確定" }
      : { payout: `${amount(s.stake + s.projectedProfit)} 予定`, profit: `${money(s.projectedProfit)} 予定` };
  }
  if (s.profit == null) return { payout: "金額未計算", profit: "金額未計算" };
  return { payout: amount(s.payout), profit: money(s.profit) };
}
const byLegacy = (rows, table) => new Map(rows.filter(r => r.legacy?.table === table).map(r => [r.legacy.row_index, r]));

// ── ① 推奨：30行 ──
const rec = byLegacy(vm.recommendations.rows, "resultTable");
for (const L of baseline.legacy_rows.recommendations) {
  const r = rec.get(L.legacy_index), p = `推奨#${L.legacy_index} ${L.match}`;
  if (!r) { unexplained.push({ path: p, legacy: "行あり", v2: "行なし" }); continue; }
  const c = v2Cells(r.settlement);
  check(`${p} 結果記号`, L.symbol, RESULT_SYMBOL[r.settlement.state]);
  check(`${p} 投入額`, L.stake_cell, amount(r.settlement.stake));
  check(`${p} 払戻し`, L.payout_cell, c.payout);
  check(`${p} 損益`, L.profit_cell, c.profit);
  check(`${p} 信頼度`, L.confidence ?? "—", r.locked?.confidence ?? "—");
}
// 旧画面の並び順（旧 analysis.js の data-ts 降順）と一致するか
const legacyOrder = [...baseline.legacy_rows.recommendations].sort((a, b) => b.data_ts.localeCompare(a.data_ts)).map(r => r.legacy_index);
check("推奨 並び順", legacyOrder.join(","), vm.recommendations.rows.map(r => r.legacy.row_index).join(","));

// ── 経験値：4行 ──
const exp = byLegacy(vm.experience.rows, "actualBetTable");
for (const L of baseline.legacy_rows.experience) {
  const r = exp.get(L.legacy_index), p = `経験値#${L.legacy_index} ${L.match}`;
  const s = r.settlement;
  check(`${p} 結果記号`, L.symbol, RESULT_SYMBOL[s.state]);
  check(`${p} 投入額`, L.data_stake, s.stake);
  check(`${p} 払戻し（予定含む）`, L.data_payout, s.state === "pending" ? s.stake + s.projectedProfit : s.payout);
}

// ── ② VALUE① / ③ VALUE②：各行の結果記号と損益表示 ──
const VALUE_REASON = {
  "Bulgaria U21 vs Portugal U21": "条件付きVALUE で条件成立の記録が無い（condition.met=null）ため、本成績に算入せず「集計外（条件成立未確認）」と表示（確定仕様）",
  "Karmine Corp vs Xi Lai Gaming": "監視カードで取得オッズがレンジ（1.17〜1.20）のみ。一点に固定しないため参考損益は「金額未計算」（旧表示 +$17.00 は 1.17 に固定した値）",
};
for (const [key, table, label] of [["value1", "oddsTestTable", "VALUE①"], ["value2", "oddsTestTable2", "VALUE②"]]) {
  const rows = byLegacy(vm[key].rows, table);
  for (const L of baseline.legacy_rows[key]) {
    const r = rows.get(L.legacy_index), p = `${label}#${L.legacy_index} ${L.match}`;
    check(`${p} 結果記号`, L.symbol, RESULT_SYMBOL[r.settlement.state]);
    const c = v2Cells(r.settlement);
    const v2Profit = r.bucket === "official" || r.bucket === "reference"
      ? (r.settlement.state === "pending" && c.profit === "未確定" ? "未確定" : c.profit.replace(" 予定", "") === c.profit ? c.profit : "未確定")
      : "集計外（条件成立未確認）";
    const legacyProfit = L.profit_text === "監視・未算入" ? "未確定" : L.profit_text;
    check(`${p} 損益表示`, legacyProfit, v2Profit, VALUE_REASON[L.match] ?? null);
  }
}

// ── サマリー（旧画面の表示値 → V2） ──
const d = baseline.displayed;
const R = vm.recommendations, V1 = vm.value1, V2 = vm.value2, E = vm.experience;
check("推奨 戦績", d.recommendations.record, `${R.summary.settledGames}戦 ${R.summary.wins}勝 ${R.summary.losses}敗`);
check("推奨 勝率", d.recommendations.winRate, `勝率 ${R.summary.winRate.toFixed(1)}%`);
check("推奨 単利（確定純損益）", d.recommendations.simpleProfit, money(R.summary.netProfit), "金額の符号表記を「$-87.00」から「-$87.00」に修正（値は同じ −87）");
check("推奨 投入金額合計", d.recommendations.settledStake, amount(R.summary.plannedStake), null);
check("推奨 未確定件数", d.recommendations.allCount, `全${R.rows.length}件 / 未確定${R.summary.pending}件`);
check("推奨 未確定・予想損益", d.recommendations.openProfit, money(R.summary.openProjectedProfit),
  "オッズ不明の未確定20件を −$100 として算入しない（確定仕様4）。オッズ既知の1件（スペイン–チェコ 1.14）だけで +$14.00、残り20件は未計算と表示");
check("推奨 複利ストック", d.recommendations.compoundStock, amount(R.compound.stock),
  "Lyon・Italy の開始時刻の人間確認（K1）により並び順が実際の開始時刻順になり、倍額到達が Italy の時点（$214.80）から Lyon→Italy の後（$240.58）へ移った");
check("推奨 複利 現在資金", d.recommendations.compoundNote, `現在資金 ${amount(R.compound.balance)}`);
check("推奨 1/4ケリー", d.recommendations.quarterKellyProfit, money(R.kelly.profit),
  "現在モデルの再計算確率ではなく、試合前に固定された事前確率（locked）だけを使う（確定ルール）。Lyon 0.922 のみ賭け対象、ODDIK・Italy は期待値マイナスで見送り");
check("推奨 精度検証", d.calibration, `精度検証：事前ロック ${R.calibration.count}件｜Brier ${R.calibration.brier.toFixed(4)}｜Log Loss ${R.calibration.log_loss.toFixed(4)}｜今後は競技・市場別にも採点`);
check("経験値 確定収支", d.experience.actualSettledProfit, money(E.summary.netProfit));
check("経験値 投入額合計", d.experience.actualTotalStake, amount(E.summary.plannedStake));
check("経験値 未確定", d.experience.actualOpenCount, `${E.summary.pending}件`);
check("経験値 予想損益", d.experience.actualOpenProfit, money(E.summary.openProjectedProfit));
const V1_REASON = "旧画面の VALUE① サマリーは手書きで、NiP×・Poland○ の結果が反映されていなかった（手順0で確認済み）。V2 はデータから自動計算し、本成績（正式VALUE）と参考成績（監視）を分けた";
check("VALUE① 単利", d.value1_hardcoded.oddsSimpleProfit, money(V1.official.netProfit), V1_REASON);
check("VALUE① 戦績", d.value1_hardcoded.oddsRecord, `${V1.official.settledGames}戦 ${V1.official.wins}勝 ${V1.official.losses}敗`, V1_REASON);
check("VALUE① 複利", d.value1_hardcoded.oddsCompoundProfit, money(V1.official_compound.profit), V1_REASON);
check("VALUE① 投入合計", d.value1_hardcoded.oddsSettledStake, amount(V1.official.settledStake));
check("VALUE① 未確定", d.value1_hardcoded.oddsOpenCount, `${V1.official.pending}件`, `${V1_REASON}（本成績の未確定は GL・JSK の2件。監視の未確定2件は参考成績側）`);
check("VALUE① 正式VALUE件数", d.value1_hardcoded.overview["正式VALUE対象"], `${V1.verdict_counts.formal}件`, V1_REASON);
check("VALUE① 監視件数", d.value1_hardcoded.overview["監視候補"], `${V1.verdict_counts.watch}件`, V1_REASON);
check("VALUE① 条件付き件数", d.value1_hardcoded.overview["条件付きVALUE"], `${V1.verdict_counts.conditional}件`);
check("VALUE① 深掘り除外", d.value1_hardcoded.overview["深掘り除外"], `${vm.legacy_unassigned.length}件`, null);
check("VALUE① 1/4ケリー", d.value1_hardcoded.oddsKellyProfit, "集計保留",
  "旧表示は「+$0.00」＋注記「推定勝率未固定の監視カードを含むため集計保留」。V2 は数値を出さず「集計保留」と表示（推定勝率がレンジで点推定が無いため）");
check("VALUE② CLV", d.value2_hardcoded.odds2Clv, V2.rows.some(r => r.bucket === "official" && r.closing_odds != null) ? "取得あり" : "集計待ち");
check("VALUE② 単利", d.value2_hardcoded.odds2SimpleProfit, money(V2.official.netProfit));
check("VALUE② 戦績", d.value2_hardcoded.odds2Record, `${V2.official.settledGames}戦 ${V2.official.wins}勝 ${V2.official.losses}敗`);
check("VALUE② 未確定", d.value2_hardcoded.odds2OpenCount, `${V2.official.pending}件`,
  "本成績（採用）と参考成績（監視）を分けて表示。本成績の未確定は GE–Vitality の1件、監視の LOUD–EDG 1件は参考成績側の未確定として別枠に表示");
check("VALUE② 最大連敗", d.value2_hardcoded.odds2LosingStreak, `${V2.official.maxLosingStreak}`);
check("VALUE② ROI", d.value2_hardcoded.odds2Roi, V2.official.roi == null ? "—（確定0件）" : `${V2.official.roi.toFixed(1)}%`,
  "確定0件では ROI（確定純損益÷確定済み投入額）を計算できないため、0.0% ではなく「—（確定0件）」と表示");

console.log(`一致: ${matched.length} 項目`);
console.log(`意図した差: ${intended.length} 項目`);
for (const i of intended) console.log(`  - ${i.path}：旧「${i.legacy}」→ V2「${i.v2}」｜${i.reason}`);
console.log(`説明できない差: ${unexplained.length} 項目`);
for (const u of unexplained) console.log(`  - ${u.path}：旧「${u.legacy}」→ V2「${u.v2}」`);
process.exit(unexplained.length ? 1 : 0);
