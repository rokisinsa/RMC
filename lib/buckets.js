// 各系統のカードを「本成績」「参考成績」「集計外」へ振り分ける。
//
// VALUE①（確定仕様）
//   formal      → official（本成績・本損益・本ROI）
//   conditional → condition.met === true かつ condition.checked_at が試合開始前 の場合のみ official。
//                 それ以外（false / null / 開始後の確認）は conditional_unmet（本成績へ算入しない）
//   watch       → reference（「仮に$100投入した場合」の参考成績）
//   excluded    → excluded
// VALUE②
//   adopted → official / watch → reference / excluded → excluded
// 推奨取引・経験値取引
//   すべて official

import { toMs } from "./time.js";
import { settlePick } from "./settlement.js";
import { summarize } from "./summary.js";

export const REFERENCE_NOTIONAL_STAKE = 100;

export function classifyPick(pick, match) {
  const verdict = pick.locked?.verdict ?? null;
  switch (pick.system) {
    case "recommendations":
    case "experience":
      return "official";
    case "value1":
      if (verdict === "formal") return "official";
      if (verdict === "watch") return "reference";
      if (verdict === "excluded") return "excluded";
      if (verdict === "conditional") {
        const c = pick.condition;
        const checkedBeforeStart =
          c?.checked_at != null && match?.start_at != null && toMs(c.checked_at) <= toMs(match.start_at);
        return c?.met === true && checkedBeforeStart ? "official" : "conditional_unmet";
      }
      return "unlocked";
    case "value2":
      if (verdict === "adopted") return "official";
      if (verdict === "watch") return "reference";
      if (verdict === "excluded") return "excluded";
      return "unlocked";
    default:
      throw new Error(`不明な系統: ${pick.system}`);
  }
}

// 系統ファイル1つ分を集計する。matchesById: Map<match_id, match>
export function summarizeSystem(systemData, matchesById) {
  const groups = { official: [], reference: [], conditional_unmet: [], excluded: [], unlocked: [] };
  for (const pick of systemData.picks) {
    const match = matchesById.get(pick.match_id);
    const bucket = classifyPick(pick, match);
    const settlement = settlePick(pick, match, {
      notionalStake: bucket === "reference" || bucket === "conditional_unmet" ? REFERENCE_NOTIONAL_STAKE : null,
    });
    groups[bucket].push({ pick, settlement });
  }
  const verdictCounts = {};
  for (const pick of systemData.picks) {
    const v = pick.locked?.verdict ?? "(none)";
    verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
  }
  return {
    official: summarize(groups.official.map(g => g.settlement)),
    reference: summarize(groups.reference.map(g => g.settlement)),
    conditionalUnmet: summarize(groups.conditional_unmet.map(g => g.settlement)),
    verdictCounts,
    groups,
  };
}
