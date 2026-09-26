// ④ PRO EDGE 固有の検査。{ level, code, system:"pro_edge", id, message } を返す。

import { toMs } from "../time.js";
import { analyzePick } from "./analyze.js";
import { leakageIssues } from "./backtest.js";
import { MARKET_DERIVED_FEATURE, knownFeatures, sportModuleOf } from "./sports.js";
import { effectiveStart } from "../integrity.js";

const issue = (level, code, id, message) => ({ level, code, system: "pro_edge", id, message });

export function checkProEdge(data, matchesById, cfg = {}) {
  const out = [];
  const analysisIds = new Map();
  for (const pick of data.picks) {
    const id = pick.id, L = pick.locked;
    const match = matchesById.get(pick.match_id);
    const start = effectiveStart(match);

    if (analysisIds.has(pick.analysis_id)) out.push(issue("error", "ANALYSIS_ID_DUPLICATE", id, `analysis_id ${pick.analysis_id} が ${analysisIds.get(pick.analysis_id)} と重複`));
    analysisIds.set(pick.analysis_id, id);

    // 価格スナップショット
    const snapIds = new Set();
    for (const s of pick.price_snapshots) {
      if (snapIds.has(s.snapshot_id)) out.push(issue("error", "SNAPSHOT_ID_DUPLICATE", id, `snapshot_id ${s.snapshot_id} が重複`));
      snapIds.add(s.snapshot_id);
      if (s.market !== pick.market) out.push(issue("error", "SNAPSHOT_MARKET_MISMATCH", id, `${s.snapshot_id} の市場 ${s.market} がカードの市場 ${pick.market} と違う`));
      if (s.kind === "closing" && start && toMs(s.observed_at) > toMs(start)) {
        out.push(issue("error", "CLOSING_AFTER_START", id, `締切オッズ ${s.snapshot_id} の取得が試合開始より後`));
      }
      if (s.kind !== "closing" && start && toMs(s.observed_at) >= toMs(start)) {
        out.push(issue("error", "PRE_MATCH_SNAPSHOT_AFTER_START", id, `${s.kind} オッズ ${s.snapshot_id} の取得が試合開始以降`));
      }
    }
    if (pick.bet_odds != null && !(pick.bet_odds >= (cfg.odds?.min ?? 1.01) && pick.bet_odds <= (cfg.odds?.max ?? 1000))) {
      out.push(issue("error", "BET_ODDS_ANOMALY", id, `bet_odds ${pick.bet_odds} が異常`));
    }
    if (pick.bet_odds != null && pick.bet_at == null) out.push(issue("error", "BET_ODDS_WITHOUT_TIME", id, "bet_odds には bet_at が必要"));

    if (!L) continue;
    if (pick.locked_at == null) {
      out.push(issue("error", "PRO_EDGE_UNLOCKED_ANALYSIS", id, "④の分析値（locked）は locked_at（試合前の固定時刻）とセットで保存する"));
    }

    // 市場確率・EV に使った価格は locked_at 以前に取得したもの（opening / analysis）だけ
    for (const sid of [...L.market_reference.snapshot_ids, L.offered_price.snapshot_id]) {
      const s = pick.price_snapshots.find(x => x.snapshot_id === sid);
      if (!s) continue;
      if (s.kind === "closing") out.push(issue("error", "CLOSING_USED_PRE_MATCH", id, `締切オッズ ${sid} を事前の市場確率・EV に使っている`));
      if (pick.locked_at && toMs(s.observed_at) > toMs(pick.locked_at)) {
        out.push(issue("error", "FUTURE_DATA_LEAK", id, `市場価格 ${sid} の取得時刻が locked_at より後`));
      }
    }

    // 未来データリーク（特徴量・補正・学習期間）
    for (const msg of leakageIssues(pick, start)) out.push(issue("error", "FUTURE_DATA_LEAK", id, msg));

    // 特徴量：市場由来の値は禁止、欠損は推測で埋めない
    const known = knownFeatures(L.model.sport_module);
    if (match && L.model.sport_module !== sportModuleOf(match.sport)) {
      out.push(issue("warning", "SPORT_MODULE_MISMATCH", id, `sport_module ${L.model.sport_module} が試合の競技（${match.sport}）と合わない`));
    }
    for (const f of L.features) {
      if (MARKET_DERIVED_FEATURE.test(f.name)) out.push(issue("error", "MARKET_FEATURE_IN_MODEL", id, `特徴量 ${f.name} は市場由来（モデルに市場価格を入れない）`));
      if (f.status === "missing" && f.value !== null) out.push(issue("error", "MISSING_FEATURE_WITH_VALUE", id, `欠損の特徴量 ${f.name} に値が入っている（推測で埋めない）`));
      if (f.status === "present" && (f.value === null || f.observed_at == null)) out.push(issue("error", "PRESENT_FEATURE_INCOMPLETE", id, `特徴量 ${f.name} の値または取得時刻がない`));
      if (!known.has(f.name)) out.push(issue("warning", "UNKNOWN_FEATURE", id, `特徴量 ${f.name} は ${L.model.sport_module} モジュールに定義がない`));
    }

    // 計算結果の検査
    const a = analyzePick(pick, cfg);
    for (const msg of a.issues) {
      const level = /overround|異常/.test(msg) ? "warning" : "error";
      out.push(issue(level, level === "warning" ? "ODDS_ANOMALY" : "PRO_EDGE_CALC", id, msg));
    }
    if (a.market_probability == null && L.decision !== "rejected") {
      out.push(issue("error", "MARKET_PROBABILITY_UNAVAILABLE", id, "市場確率を計算できない（accepted / watch には必要）"));
    }
    if (a.market_probability != null && Math.abs(L.base_probability - a.market_probability) < 1e-9) {
      out.push(issue("error", "MODEL_COPIES_MARKET", id, "base_probability が市場確率と同一（市場のコピーは独自モデルではない）"));
    }

    // 判断と投入額
    if (L.decision === "accepted" && !(pick.stake > 0)) out.push(issue("error", "ACCEPTED_WITHOUT_STAKE", id, "accepted には投入額が必要"));
    if (L.decision !== "accepted" && pick.stake != null) out.push(issue("error", "STAKE_NOT_ALLOWED", id, `${L.decision} は投入額を持たない（参考成績は$100仮定で計算）`));
  }
  return out;
}
