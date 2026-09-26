// ④ PRO EDGE：市場確率（控除除去 = no-vig）と複数ブックメーカーの consensus。
//
// 2-way：qA = 1/oddsA, qB = 1/oddsB, pA = qA/(qA+qB), pB = qB/(qA+qB)
// 3-way：各アウトカムの 1/odds を合計で割って正規化
// overround（控除込みの合計）= Σ 1/odds。1 未満は裁定（計算ミス・古い価格の疑い）、大きすぎる場合も異常として扱う。
//
// 元のブックメーカーオッズ（スナップショット）は保存し、no-vig 確率はそこから毎回計算する（保存しない）。

export const OUTCOMES_OF_MARKET = {
  match_winner: ["side_a", "side_b"],
  dnb: ["side_a", "side_b"],
  set1_winner: ["side_a", "side_b"],
  map1_winner: ["side_a", "side_b"],
  match_1x2: ["side_a", "draw", "side_b"],
  first_half_1x2: ["side_a", "draw", "side_b"],
};

export function isValidOdds(o, cfg) {
  return typeof o === "number" && Number.isFinite(o) && o > 1 && o >= (cfg?.odds?.min ?? 1.01) && o <= (cfg?.odds?.max ?? 1000);
}

// スナップショット1件の検査と no-vig 化。{ ok, probabilities, overround, issues }
export function noVig(snapshot, cfg = {}) {
  const outcomes = OUTCOMES_OF_MARKET[snapshot.market];
  const issues = [];
  if (!outcomes) return { ok: false, probabilities: null, overround: null, issues: [`市場 ${snapshot.market} は no-vig 未対応`] };
  for (const o of outcomes) {
    const odds = snapshot.outcomes?.[o];
    if (odds == null) issues.push(`アウトカム ${o} のオッズがない`);
    else if (!isValidOdds(odds, cfg)) issues.push(`アウトカム ${o} のオッズ ${odds} が異常`);
  }
  const extra = Object.keys(snapshot.outcomes ?? {}).filter(k => !outcomes.includes(k));
  if (extra.length) issues.push(`市場 ${snapshot.market} に無いアウトカム: ${extra.join(", ")}`);
  if (issues.length) return { ok: false, probabilities: null, overround: null, issues };

  const inv = Object.fromEntries(outcomes.map(o => [o, 1 / snapshot.outcomes[o]]));
  const overround = outcomes.reduce((s, o) => s + inv[o], 0);
  const probabilities = Object.fromEntries(outcomes.map(o => [o, inv[o] / overround]));
  if (overround < (cfg?.odds?.overround_min ?? 1)) issues.push(`overround ${overround.toFixed(4)} が 1 未満（裁定・古い価格の疑い）`);
  if (overround > (cfg?.odds?.overround_max ?? 1.25)) issues.push(`overround ${overround.toFixed(4)} が大きすぎる`);
  return { ok: issues.length === 0, probabilities, overround, issues };
}

// 市場確率。スナップショットが複数ブックメーカーにまたがり、最低社数を満たすときだけ consensus を作る。
// 返り値 { probability, method: "single_book" | "consensus", bookmakers, sources, issues }
export function marketProbability(snapshots, selection, cfg = {}) {
  const issues = [];
  if (!snapshots.length) return { probability: null, method: null, bookmakers: [], issues: ["市場スナップショットがない"] };
  const markets = new Set(snapshots.map(s => s.market));
  if (markets.size > 1) return { probability: null, method: null, bookmakers: [], issues: ["異なる市場のスナップショットは混ぜられない"] };

  const valid = [];
  for (const s of snapshots) {
    const r = noVig(s, cfg);
    if (r.ok) valid.push({ s, p: r.probabilities[selection] });
    else issues.push(...r.issues.map(i => `${s.bookmaker}: ${i}`));
  }
  const books = [...new Set(valid.map(v => v.s.bookmaker))];
  if (!valid.length) return { probability: null, method: null, bookmakers: [], issues };
  if (books.length !== valid.length) issues.push("同じブックメーカーのスナップショットが重複している");

  if (valid.length === 1) {
    return { probability: valid[0].p, method: "single_book", bookmakers: books, issues };
  }
  const min = cfg?.consensus?.min_bookmakers ?? 2;
  if (books.length < min) {
    return { probability: null, method: null, bookmakers: books, issues: [...issues, `consensus には ${min} 社以上が必要`] };
  }
  const probability = valid.reduce((s, v) => s + v.p, 0) / valid.length;
  return { probability, method: "consensus", bookmakers: books, issues };
}
