// ④ PRO EDGE：CLV（Closing Line Value）。
//
// 価格ベースCLV   clv_price       = bet_odds / closing_odds − 1
//   ＋ … 締切（試合開始直前）より良い価格で買えた（例 2.10 で購入・締切 2.00 → +5.0%）
//   − … 締切より悪い価格で買った
// 確率ベースCLV   clv_probability = closing_no_vig_probability − 1 / bet_odds
//   ＋ … 締切時点の市場適正勝率が、購入価格が要求する勝率を上回った（締切ラインに対して期待値プラス）
//   − … 下回った
// 締切ベースEV    closing_ev      = bet_odds × closing_no_vig_probability − 1（clv_probability × bet_odds と同符号）
//
// closing_odds が無ければ CLV は未計算（null）。確率ベースは締切の全アウトカムが揃い no-vig 化できる場合だけ計算する
// （片側の締切オッズだけでは控除を除去できないので計算しない）。推測で補わない。

import { noVig } from "./market.js";

const round = (x, d = 6) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// prices: { opening_snapshot, bet_odds, closing_snapshot }（スナップショットは同じ市場・同じブックメーカーが望ましい）
export function clv({ selection, bet_odds, closing_snapshot }, cfg = {}) {
  const closingOdds = closing_snapshot?.outcomes?.[selection] ?? null;
  if (bet_odds == null || closingOdds == null) {
    return { clv_price: null, clv_probability: null, closing_ev: null, closing_probability: null,
      status: bet_odds == null ? "no_bet_odds" : "no_closing_odds" };
  }
  const clv_price = round(bet_odds / closingOdds - 1);
  const nv = noVig(closing_snapshot, cfg);
  if (!nv.ok) {
    return { clv_price, clv_probability: null, closing_ev: null, closing_probability: null, status: "closing_not_devigable", issues: nv.issues };
  }
  const pc = nv.probabilities[selection];
  return {
    clv_price,
    clv_probability: round(pc - 1 / bet_odds),
    closing_ev: round(bet_odds * pc - 1),
    closing_probability: round(pc),
    status: "ok",
  };
}

// 始値 → 購入 → 締切の価格推移（取得できない値は null）
export function priceTrail({ selection, opening_snapshot, bet_odds, closing_snapshot }) {
  return {
    opening_odds: opening_snapshot?.outcomes?.[selection] ?? null,
    bet_odds: bet_odds ?? null,
    closing_odds: closing_snapshot?.outcomes?.[selection] ?? null,
  };
}
