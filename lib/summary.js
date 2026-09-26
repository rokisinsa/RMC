// 集計ロジック。入力は settlePick() の結果の配列。
//
// 定義（確定仕様）
//   戦績・勝率 … win/loss のみ。push/void/pending は数えない
//   確定済み投入額 … 金額が計算できた win/loss の stake 合計
//   総投入予定額 … 登録された全カード（pending・push・void を含む）の stake 合計
//   ROI … 確定済み純損益 ÷ 確定済み投入額 × 100（未確定は含めない。分母0なら null）
//   未確定の予想損益 … odds_taken がある pending だけ合算。オッズ不明は「未計算」件数として別に数える

import { roundMoney } from "./settlement.js";

function byOrder(a, b) {
  if (a.orderKey == null && b.orderKey == null) return 0;
  if (a.orderKey == null) return 1;
  if (b.orderKey == null) return -1;
  return Date.parse(a.orderKey) - Date.parse(b.orderKey);
}

export function summarize(settlements) {
  const s = {
    count: settlements.length,
    wins: 0, losses: 0, pushes: 0, voids: 0, pending: 0,
    settledGames: 0, winRate: null,
    plannedStake: 0, settledStake: 0, refundedStake: 0,
    netProfit: 0, roi: null,
    amountMissing: 0,
    openStake: 0, openProjectedProfit: 0, openProjectedCount: 0, openUncomputed: 0,
    maxLosingStreak: 0,
  };

  for (const r of settlements) {
    if (r.stake != null) s.plannedStake += r.stake;
    switch (r.state) {
      case "win": s.wins++; break;
      case "loss": s.losses++; break;
      case "push": s.pushes++; if (r.stake != null) s.refundedStake += r.stake; break;
      case "void": s.voids++; if (r.stake != null) s.refundedStake += r.stake; break;
      case "pending":
        s.pending++;
        if (r.stake != null) s.openStake += r.stake;
        if (r.projectedProfit != null) { s.openProjectedProfit += r.projectedProfit; s.openProjectedCount++; }
        else s.openUncomputed++;
        break;
      default: throw new Error(`不明な精算状態: ${r.state}`);
    }
    if ((r.state === "win" || r.state === "loss") && r.profit != null) {
      s.settledStake += r.stake;
      s.netProfit += r.profit;
    }
    if (r.amountMissing) s.amountMissing++;
  }

  s.settledGames = s.wins + s.losses;
  s.winRate = s.settledGames > 0 ? (s.wins / s.settledGames) * 100 : null;
  s.plannedStake = roundMoney(s.plannedStake);
  s.settledStake = roundMoney(s.settledStake);
  s.refundedStake = roundMoney(s.refundedStake);
  s.netProfit = roundMoney(s.netProfit);
  s.openStake = roundMoney(s.openStake);
  s.openProjectedProfit = roundMoney(s.openProjectedProfit);
  s.roi = s.settledStake > 0 ? (s.netProfit / s.settledStake) * 100 : null;

  let streak = 0;
  for (const r of [...settlements].sort(byOrder)) {
    if (r.state === "loss") s.maxLosingStreak = Math.max(s.maxLosingStreak, ++streak);
    else if (r.state === "win") streak = 0;
  }
  return s;
}

// 複利（現行 analysis.js と同じルール）：元金 base で開始し、2倍到達で利益をストックして base に戻す。
// 負けたらその挑戦は失敗として base から再開。push/void は資金を動かさない。
export function compound(settlements, base = 100) {
  const target = base * 2;
  let balance = base, stock = 0, cycles = 0, failures = 0, incomplete = 0;
  for (const r of [...settlements].sort(byOrder)) {
    if (r.state === "loss") { balance = base; failures++; continue; }
    if (r.state !== "win") continue;
    if (r.odds == null) { incomplete++; continue; }
    balance *= r.odds;
    if (balance >= target) { stock += balance - base; cycles++; balance = base; }
  }
  return {
    balance: roundMoney(balance),
    stock: roundMoney(stock),
    cycles, failures, incomplete,
    profit: roundMoney(balance - base),
  };
}

// 1/4ケリー：locked（事前固定）確率だけを使う。現行モデルでの再計算値は使わない。
// items: [{ settlement, prob }]
export function quarterKelly(items, base = 100) {
  let balance = base, bets = 0, skipped = 0;
  const ordered = [...items].sort((a, b) => byOrder(a.settlement, b.settlement));
  for (const { settlement: r, prob } of ordered) {
    if (r.state !== "win" && r.state !== "loss") continue;
    const odds = r.odds;
    if (!(prob > 0 && prob < 1 && odds > 1)) { skipped++; continue; }
    const fraction = Math.min(Math.max(((odds * prob - 1) / (odds - 1)) / 4, 0), 0.25);
    if (fraction <= 0) { skipped++; continue; }
    const bet = balance * fraction;
    bets++;
    balance += r.state === "win" ? bet * (odds - 1) : -bet;
  }
  return { balance: roundMoney(balance), profit: roundMoney(balance - base), bets, skipped };
}
