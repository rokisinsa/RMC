// ④ PRO EDGE：カード1件の分析値を計算する（保存値は入力だけ。edge・EV などは毎回ここで算出）。
//
// 入力（data/pro_edge.json のカード）
//   price_snapshots[]          … ブックメーカーごとの価格スナップショット（kind: opening / analysis / closing）
//   locked.market_reference    … 市場確率に使うスナップショット（1社なら single_book、複数社なら consensus）
//   locked.offered_price       … EV 計算に使う提示価格のスナップショットID
//   locked.base_probability / expert_adjustments / required_ev / decision
//   bet_odds / bet_bookmaker   … 実際の購入価格（無ければ null）

import { marketProbability, noVig } from "./market.js";
import { finalProbability, expertAdjustmentTotal, fairOdds, edge, expectedValue, minimumEntryOdds } from "./pricing.js";
import { clv, priceTrail } from "./clv.js";

const trace = s => ({ snapshot_id: s.snapshot_id, bookmaker: s.bookmaker, observed_at: s.observed_at, source: s.source });

export function analyzePick(pick, cfg = {}) {
  const issues = [];
  const byId = new Map((pick.price_snapshots ?? []).map(s => [s.snapshot_id, s]));
  const L = pick.locked ?? {};

  // 市場確率
  const refIds = L.market_reference?.snapshot_ids ?? [];
  const refs = refIds.map(id => byId.get(id)).filter(Boolean);
  if (refs.length !== refIds.length) issues.push("market_reference に存在しないスナップショットIDがある");
  const market = marketProbability(refs, pick.selection, cfg);
  issues.push(...market.issues);
  if (L.market_reference?.method && market.method && L.market_reference.method !== market.method) {
    issues.push(`market_reference.method（${L.market_reference.method}）と実際の計算方法（${market.method}）が違う`);
  }

  // 提示価格（EV 用）
  const offered = byId.get(L.offered_price?.snapshot_id);
  const offeredOdds = offered?.outcomes?.[pick.selection] ?? null;
  if (L.offered_price && !offered) issues.push("offered_price のスナップショットが存在しない");

  // 推定勝率
  const fin = finalProbability(L.base_probability, L.expert_adjustments ?? []);
  if (!fin.valid) issues.push(fin.issue);
  const finalP = fin.valid ? fin.final_probability : null;

  const ev = expectedValue(finalP, offeredOdds);
  const requiredEv = L.required_ev ?? cfg.required_ev ?? null;

  // 価格推移と CLV（購入したブックメーカーの始値・締切を優先）
  const pickSnap = kind => {
    const list = (pick.price_snapshots ?? []).filter(s => s.kind === kind);
    return list.find(s => s.bookmaker === pick.bet_bookmaker) ?? list[0] ?? null;
  };
  const opening = pickSnap("opening"), closing = pickSnap("closing");
  const trail = priceTrail({ selection: pick.selection, opening_snapshot: opening, bet_odds: pick.bet_odds, closing_snapshot: closing });
  const clvResult = clv({ selection: pick.selection, bet_odds: pick.bet_odds, closing_snapshot: closing }, cfg);

  if (L.decision === "accepted" && ev != null && requiredEv != null && ev < requiredEv) {
    issues.push(`accepted だが EV ${ev} が required_EV ${requiredEv} 未満`);
  }

  return {
    id: pick.id,
    market_probability: market.probability,
    market_method: market.method,
    market_sources: refs.map(trace),
    base_probability: L.base_probability ?? null,
    expert_adjustment: expertAdjustmentTotal(L.expert_adjustments ?? []),
    final_probability: finalP,
    edge: edge(finalP, market.probability),
    fair_odds: fairOdds(finalP),
    offered_odds: offeredOdds,
    offered_source: offered ? trace(offered) : null,
    ev,
    ev_at_bet: expectedValue(finalP, pick.bet_odds ?? null),
    required_ev: requiredEv,
    minimum_entry_odds: minimumEntryOdds(finalP, requiredEv),
    decision: L.decision ?? null,
    data_confidence: L.data_confidence ?? null,
    ...trail,
    clv: clvResult,
    closing_market_no_vig: closing ? noVig(closing, cfg).probabilities : null,
    issues,
  };
}
