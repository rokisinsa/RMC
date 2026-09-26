// ④ PRO EDGE の集計（①②③の集計・区分ロジックには手を加えず、④の中で完結させる）。
//   本成績（accepted）… 実際の購入価格 bet_odds で精算。bet_odds が無ければ金額は未計算（推測しない）
//   参考成績（watch） … 「仮に$100を判断時の提示価格で投入した場合」。提示価格（offered_price）で精算
//   rejected         … 集計しない
// 精算は共通の settlePick（試合事実から勝敗を判定）を使い、価格は odds_taken として渡す。

import { settlePick } from "../settlement.js";
import { summarize } from "../summary.js";
import { REFERENCE_NOTIONAL_STAKE } from "../buckets.js";
import { analyzePick } from "./analyze.js";
import { windowedMetrics } from "./evaluate.js";

// accepted → official / watch → reference / rejected → excluded / 未固定 → unlocked
export function classifyProEdge(pick) {
  switch (pick.locked?.decision) {
    case "accepted": return "official";
    case "watch": return "reference";
    case "rejected": return "excluded";
    default: return "unlocked";
  }
}

export function summarizeProEdge(data, matchesById, cfg = {}) {
  const groups = { official: [], reference: [], excluded: [], unlocked: [] };
  for (const pick of data.picks) {
    const match = matchesById.get(pick.match_id);
    const analysis = analyzePick(pick, cfg);
    const bucket = classifyProEdge(pick);
    const settlement = bucket === "reference"
      ? settlePick({ ...pick, odds_taken: analysis.offered_odds }, match, { notionalStake: REFERENCE_NOTIONAL_STAKE })
      : settlePick({ ...pick, odds_taken: pick.bet_odds ?? null }, match);
    groups[bucket].push({ pick, analysis, settlement });
  }
  const decisionCounts = {};
  for (const p of data.picks) {
    const d = p.locked?.decision ?? "(none)";
    decisionCounts[d] = (decisionCounts[d] ?? 0) + 1;
  }
  return {
    decision_counts: decisionCounts,
    official: summarize(groups.official.map(g => g.settlement)),
    reference: summarize(groups.reference.map(g => g.settlement)),
    evaluation: {
      official: windowedMetrics(groups.official, cfg),
      reference: windowedMetrics(groups.reference, cfg),
    },
    groups,
  };
}
