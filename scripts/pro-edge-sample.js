// ④ PRO EDGE エンジンを架空のサンプルデータで動かす（data/ には書き込まない）。
// 使い方: node scripts/pro-edge-sample.js

import { loadSchemas, loadProEdgeConfig } from "./load-node.js";
import { validateDataset } from "../lib/validate.js";
import { summarizeProEdge } from "../lib/pro-edge/summary.js";
import { eloRatings, fitLogistic, predictLogistic } from "../lib/pro-edge/models.js";
import { timeSeriesSplit, assertChronological } from "../lib/pro-edge/backtest.js";
import { makeProEdgeSample } from "../tests/fixtures/pro-edge-sample.js";

const cfg = loadProEdgeConfig();
const ds = makeProEdgeSample();
const issues = validateDataset(ds, loadSchemas(), { proEdgeConfig: cfg });
console.log(`検証: error ${issues.filter(i => i.level === "error").length} 件 / warning ${issues.filter(i => i.level === "warning").length} 件`);

const matchesById = new Map(ds.matches.matches.map(m => [m.id, m]));
const r = summarizeProEdge(ds.pro_edge, matchesById, cfg);
const pct = x => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const pt = x => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`);
const num = (x, d = 3) => (x == null ? "—" : x.toFixed(d));

console.log("\n■ カード別（サンプル・架空データ）");
for (const g of Object.values(r.groups).flat()) {
  const a = g.analysis, m = matchesById.get(g.pick.match_id);
  console.log([
    a.id, g.pick.locked.decision.padEnd(8), m.sport, g.pick.market, g.pick.selection,
    `市場${pct(a.market_probability)}(${a.market_method})`, `基本${pct(a.base_probability)}`, `補正${pt(a.expert_adjustment)}`,
    `最終${pct(a.final_probability)}`, `EDGE${pt(a.edge)}`, `Fair${num(a.fair_odds, 2)}`, `提示${num(a.offered_odds, 2)}`,
    `EV${a.ev >= 0 ? "+" : ""}${pct(a.ev)}`, `最低${num(a.minimum_entry_odds, 2)}`,
    `始${num(a.opening_odds, 2)}/買${num(a.bet_odds, 2)}/締${num(a.closing_odds, 2)}`,
    `CLV価格${pct(a.clv.clv_price)} 確率${a.clv.clv_probability == null ? "—" : `${(a.clv.clv_probability * 100).toFixed(2)}pt`}`,
    `結果${g.settlement.state} 損益${g.settlement.profit ?? "—"}`,
  ].join(" | "));
}

console.log("\n■ 集計");
console.log("判断内訳", r.decision_counts);
console.log(`本成績（accepted）: ${r.official.wins}勝${r.official.losses}敗 未確定${r.official.pending} 純損益${r.official.netProfit} ROI ${r.official.roi?.toFixed(2)}%`);
console.log(`参考成績（watch・$100仮定）: ${r.reference.wins}勝${r.reference.losses}敗 純損益${r.reference.netProfit}`);
const e = r.evaluation.official;
for (const k of ["last_20", "last_50", "last_100", "all"]) console.log(`${k}: ${e[k].status}（sample_size ${e[k].sample_size}）`);
console.log(`Calibration: ${e.calibration.status}（sample_size ${e.calibration.sample_size}、最低 ${e.calibration.min_total} 件）`);

// 時系列バックテストの実演（合成データ。学習→検証→テストの順を守る）
const teams = ["A", "B", "C", "D"], strength = { A: 1.2, B: 0.4, C: -0.3, D: -1.1 };
const history = [];
let t = 0;
for (let round = 0; round < 30; round++) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
  const a = teams[i], b = teams[j], pa = 1 / (1 + Math.exp(-(strength[a] - strength[b])));
  history.push({ start_at: new Date(Date.UTC(2026, 0, 1) + t++ * 3600e3).toISOString(), side_a: a, side_b: b, winner: ((t * 7919) % 100) / 100 < pa ? "side_a" : "side_b" });
}
const split = timeSeriesSplit(history, { train_end: history[100].start_at, validation_end: history[140].start_at });
assertChronological(split);
const rows = list => list.map(m => { const { get } = eloRatings(history, m.start_at); return { x: [(get(m.side_a) - get(m.side_b)) / 400], y: m.winner === "side_a" ? 1 : 0 }; });
const model = fitLogistic(rows(split.train));
const score = list => {
  const rs = rows(list);
  const brier = rs.reduce((s, r) => s + (predictLogistic(model, r.x) - r.y) ** 2, 0) / rs.length;
  const ll = rs.reduce((s, r) => { const p = Math.min(Math.max(predictLogistic(model, r.x), 1e-6), 1 - 1e-6); return s - (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p)); }, 0) / rs.length;
  return `Brier ${brier.toFixed(4)} / Log Loss ${ll.toFixed(4)}（${rs.length}試合）`;
};
console.log("\n■ 時系列バックテスト（合成データ・Elo＋ロジスティック）");
console.log(`学習 ${split.train.length} / 検証 ${split.validation.length} / テスト ${split.test.length}（時間順を確認済み）`);
console.log(`係数 w=${model.weights[0].toFixed(3)} b=${model.bias.toFixed(3)}`);
console.log(`検証期間: ${score(split.validation)}`);
console.log(`テスト期間: ${score(split.test)}（基準：50/50予想の Brier 0.25）`);
