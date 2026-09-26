// 精算ロジック。払戻し・純損益は保存せず、試合事実＋選択＋odds_taken＋stake から毎回計算する。
//
// 精算状態（state）
//   pending … 未確定（試合前・進行中・結果未入力・自動判定不能）
//   win     … 的中。払戻し = stake × odds_taken（odds_taken が無ければ金額は未計算）
//   loss    … 不的中。純損益 = -stake（オッズ不要）
//   push    … 返金（DNBの引分など）。純損益 0、勝敗には数えない
//   void    … 無効（中止・延期・没収など）。純損益 0、勝敗には数えない
//
// 市場オッズ（market_odds）は精算に使わない。レンジしか無い場合は金額を未計算のままにする。

export const STATES = ["pending", "win", "loss", "push", "void"];

const VOID_MATCH_STATUSES = new Set(["cancelled", "postponed", "abandoned"]);

const PERIOD_OF_MARKET = {
  match_winner: "final",
  match_1x2: "final",
  dnb: "final",
  first_half_1x2: "ht",
  set1_winner: "set1",
  map1_winner: "map1",
};

// セント単位で丸める（1.14 × 100 = 113.99999999999999 のような誤差を表示・集計に持ち込まない）
export function roundMoney(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function winnerSide(score) {
  if (score.a > score.b) return "side_a";
  if (score.b > score.a) return "side_b";
  return "draw";
}

// 試合事実から結果を判定する。{ state, reason }
export function outcomeFromMatch(pick, match) {
  if (!match) return { state: "pending", reason: "試合事実が未登録" };
  if (VOID_MATCH_STATUSES.has(match.status)) return { state: "void", reason: `試合が ${match.status}` };
  if (match.status !== "final") return { state: "pending", reason: `試合状態 ${match.status}` };

  const period = PERIOD_OF_MARKET[pick.market];
  if (!period) return { state: "pending", reason: `市場 ${pick.market} は自動精算対象外（settlement_override が必要）` };

  const score = period === "final" ? match.result?.final : match.result?.periods?.[period];
  // スコアが無く勝者だけ記録されている場合（例：第1セット勝利・スコア未確認）はその勝者を使う
  const recordedWinner = match.result?.winners?.[period] ?? null;
  if (!score && !recordedWinner) return { state: "pending", reason: `${period} のスコアが未入力` };

  const winner = score ? winnerSide(score) : recordedWinner;
  if (pick.market === "dnb" && winner === "draw") return { state: "push", reason: "DNB 引分のため返金" };
  if (pick.market === "match_winner" && winner === "draw") {
    return { state: "pending", reason: "引分のない市場なのに同点スコア（要確認）" };
  }
  if (pick.selection === "draw" && (pick.market === "dnb" || pick.market === "match_winner")) {
    return { state: "pending", reason: `市場 ${pick.market} で draw は選択できない（要確認）` };
  }
  return {
    state: winner === pick.selection ? "win" : "loss",
    reason: score ? `${period} ${score.a}-${score.b}` : `${period} 勝者 ${winner}（スコア未記録）`,
  };
}

// 1件を精算する。notionalStake は監視カードなどの「仮に投入した場合」の参考計算用。
export function settlePick(pick, match, { notionalStake = null } = {}) {
  const stake = pick.stake ?? notionalStake;
  const odds = pick.odds_taken ?? pick.bet_odds ?? null;   // ④ PRO EDGE は bet_odds

  const { state, reason } = pick.settlement_override
    ? { state: pick.settlement_override.state, reason: `手動精算: ${pick.settlement_override.reason}` }
    : outcomeFromMatch(pick, match);
  const source = pick.settlement_override ? "override" : match ? "match" : "none";

  let payout = null, profit = null, projectedProfit = null;
  if (stake != null) {
    if (state === "win" && odds != null) {
      payout = roundMoney(stake * odds);
      profit = roundMoney(payout - stake);
    } else if (state === "loss") {
      payout = 0;
      profit = roundMoney(-stake);
    } else if (state === "push" || state === "void") {
      payout = stake;
      profit = 0;
    } else if (state === "pending" && odds != null) {
      projectedProfit = roundMoney(stake * odds - stake);
    }
  }

  return {
    id: pick.id,
    state,
    source,
    reason,
    stake,
    odds,
    payout,
    profit,
    projectedProfit,
    // 確定しているのに金額が出せない（例: 的中だが odds_taken 不明）
    amountMissing: state !== "pending" && stake != null && profit === null,
    // 並び順：試合開始 → 投入 → 固定 → 発見 → 旧data-ts（旧データの並び順専用。時刻の意味は不明）
    orderKey: match?.start_at ?? pick.bet_at ?? pick.locked_at ?? pick.discovered_at ?? pick.legacy?.sort_at ?? null,
  };
}
