// 定時更新の監査レポート（□7 競技偏り・□9 損益/ROI/CLV の検証・□10 データ品質）。
// 監査結果を表示するだけで、データは変更しない。集計の整合性違反があるときだけ終了コード1。
// 使い方: node scripts/audit-report.js [--now=2026-09-27T06:00:00+09:00]

import { loadDatasets, loadProEdgeConfig } from "./load-node.js";
import { buildViewModel } from "../lib/view/model.js";
import { pendingReviews } from "../lib/match-updates.js";

const nowArg = process.argv.find(a => a.startsWith("--now="))?.slice(6);
const now = nowArg ?? new Date().toISOString();
const { datasets } = loadDatasets();
const vm = buildViewModel(structuredClone(datasets), { proEdgeConfig: loadProEdgeConfig(), now });
const pct = x => `${(x * 100).toFixed(0)}%`;
let violations = 0;

// □7 競技偏り：系統ごとに、直近の新規カード（旧データを除く）の競技の偏り
console.log("■ □7 競技偏り監査（系統ごと・直近20件の新規カード）");
const views = { recommendations: vm.recommendations, value1: vm.value1, value2: vm.value2, pro_edge: vm.pro_edge };
for (const [system, v] of Object.entries(views)) {
  const recent = v.rows.filter(r => !r.legacy).sort((a, b) => String(b.settlement.orderKey).localeCompare(String(a.settlement.orderKey))).slice(0, 20);
  if (!recent.length) { console.log(`  ${system}: 新規カードなし`); continue; }
  const bySport = {};
  for (const r of recent) bySport[r.match?.sport ?? "不明"] = (bySport[r.match?.sport ?? "不明"] ?? 0) + 1;
  const [top, n] = Object.entries(bySport).sort((a, b) => b[1] - a[1])[0];
  const flag = recent.length >= 5 && n / recent.length > 0.6 ? "  ⚠ 偏り（60%超）" : "";
  console.log(`  ${system}: ${recent.length}件 / 最多 ${top} ${pct(n / recent.length)}${flag}`);
}

// □9 損益・ROI・CLV の検証：集計が各カードの精算結果と一致するか
console.log("\n■ □9 損益・ROI・CLV の検証");
const check = (name, s, rows) => {
  const own = rows.map(r => r.settlement);
  const net = own.filter(x => (x.state === "win" || x.state === "loss") && x.profit != null).reduce((a, x) => a + x.profit, 0);
  const problems = [];
  if (s.settledGames !== s.wins + s.losses) problems.push("戦績");
  if (Math.abs(s.netProfit - net) > 0.005) problems.push("純損益");
  if (s.settledStake && Math.abs(s.roi - (s.netProfit / s.settledStake) * 100) > 1e-9) problems.push("ROI");
  if (s.pending !== own.filter(x => x.state === "pending").length) problems.push("未確定件数");
  violations += problems.length;
  console.log(`  ${name}: ${s.settledGames}戦${s.wins}勝${s.losses}敗 純損益 ${s.netProfit.toFixed(2)} ROI ${s.roi == null ? "—" : s.roi.toFixed(2) + "%"} 未確定 ${s.pending}件 金額未計算 ${s.amountMissing}件 ${problems.length ? `⚠ 不整合: ${problems.join("・")}` : "整合OK"}`);
};
check("① 推奨", vm.recommendations.summary, vm.recommendations.rows);
check("経験値", vm.experience.summary, vm.experience.rows);
check("② VALUE① 本成績", vm.value1.official, vm.value1.rows.filter(r => r.bucket === "official"));
check("③ VALUE② 本成績", vm.value2.official, vm.value2.rows.filter(r => r.bucket === "official"));
check("④ PRO EDGE 本成績", vm.pro_edge.official, vm.pro_edge.rows.filter(r => r.bucket === "official"));
const pe = vm.pro_edge.rows.filter(r => r.bucket === "official");
const clvDone = pe.filter(r => r.analysis.clv.status === "ok").length;
const clvWaiting = pe.filter(r => r.settlement.state !== "pending" && r.analysis.clv.status !== "ok").length;
console.log(`  ④ CLV: 計算済み ${clvDone}件 / 確定済みで締切オッズ未取得 ${clvWaiting}件`);
for (const [k, a] of [["①", vm.recommendations.compound_audit], ["②", vm.value1.compound_audit], ["③", vm.value2.compound_audit]]) {
  console.log(`  ${k} 複利: ${a.status === "confirmed" ? "正式（投入時刻順）" : a.status === "no_settled" ? "確定0件" : "参考値・取引順序未確定"}`);
}

// □10 データ品質
console.log("\n■ □10 データ品質監査");
const all = [...vm.recommendations.rows, ...vm.experience.rows, ...vm.value1.rows, ...vm.value2.rows, ...vm.pro_edge.rows];
const count = label => all.filter(r => r.quality.some(q => q.label.startsWith(label))).length;
console.log(`  開始時刻 未確認・要確認: ${count("開始時刻 未確認") + count("開始時刻 要確認")}件`);
console.log(`  オッズ 未確認: ${count("オッズ 未確認")}件 / レンジのみ: ${count("オッズ レンジのみ")}件`);
console.log(`  結果 未確認（開始済み）: ${count("結果 未確認")}件`);
console.log(`  条件成立 未確認: ${count("条件成立 未確認")}件`);
console.log(`  重複確認中: ${count("重複確認中")}件 / 独立性要確認: ${count("独立性 要確認")}件`);
console.log(`  結果更新の要確認（試合）: ${pendingReviews(datasets.match_updates).size}試合`);

console.log(violations ? `\n集計の不整合 ${violations} 件` : "\n集計の不整合なし");
process.exit(violations ? 1 : 0);
