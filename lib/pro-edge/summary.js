// ④ PRO EDGE の集計。
//   本成績（accepted）… 実際の購入価格 bet_odds で精算。bet_odds が無ければ金額は未計算（推測しない）
//   参考成績（watch） … 「仮に$100を判断時の提示価格で投入した場合」。提示価格（offered_price）で精算
//   rejected         … 集計しない

import { settlePick } from "../settlement.js";
import { summarize } from "../summary.js";
import { classifyPick, REFERENCE_NOTIONAL_STAKE } from "../buckets.js";
import { analyzePick } from "./analyze.js";
import { windowedMetrics } from "./evaluate.js";

export function summarizeProEdge(data, matchesById, cfg = {}) {
  const groups = { official: [], reference: [], excluded: [], unlocked: [] };
  for (const pick of data.picks) {
    const match = matchesById.get(pick.match_id);
    const analysis = analyzePick(pick, cfg);
    const bucket = classifyPick(pick, match);
    const settlement = bucket === "reference"
      ? settlePick({ ...pick, bet_odds: analysis.offered_odds }, match, { notionalStake: REFERENCE_NOTIONAL_STAKE })
      : settlePick(pick, match);
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
