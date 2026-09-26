// ④ PRO EDGE：推定勝率・価格計算。
//
//   base_probability  … 独自モデルの推定（市場確率のコピー禁止）
//   expert_adjustment … モデル外情報の補正（合計）。base は上書きしない
//   final_probability = base_probability + Σ adjustment_value（0 < final < 1 でなければ無効）
//   edge              = final_probability − market_probability
//   fair_odds         = 1 / final_probability
//   EV                = final_probability × offered_odds − 1
//   minimum_entry_odds = (1 + required_EV) / final_probability

const round = (x, d = 6) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function expertAdjustmentTotal(adjustments = []) {
  return adjustments.reduce((s, a) => s + a.adjustment_value, 0);
}

// { final_probability, valid, issue }
export function finalProbability(baseProbability, adjustments = []) {
  if (!(baseProbability > 0 && baseProbability < 1)) {
    return { final_probability: null, valid: false, issue: `base_probability ${baseProbability} が 0〜1 の範囲外` };
  }
  const final = baseProbability + expertAdjustmentTotal(adjustments);
  if (!(final > 0 && final < 1)) {
    return { final_probability: round(final), valid: false, issue: `final_probability ${round(final)} が 0〜1 の範囲外（補正が大きすぎる）` };
  }
  return { final_probability: round(final), valid: true, issue: null };
}

export const fairOdds = p => (p > 0 && p < 1 ? round(1 / p, 4) : null);
export const edge = (finalP, marketP) => (finalP == null || marketP == null ? null : round(finalP - marketP));
export const expectedValue = (finalP, odds) => (finalP == null || odds == null ? null : round(finalP * odds - 1));
export const minimumEntryOdds = (finalP, requiredEv) =>
  (finalP > 0 && finalP < 1 && requiredEv != null ? round((1 + requiredEv) / finalP, 4) : null);
