// テスト用の架空データ一式（実在の試合ではない）。
// makeDataset() は毎回新しいコピーを返すので、テスト内で自由に書き換えてよい。
//
// 期待値の早見表（テストで使う）
//   推奨取引 official: 3勝1敗 / push1 / void1 / pending2（うちオッズ不明1）
//     確定済み投入額 400 / 純損益 -15 / ROI -3.75% / 総投入予定額 800 / 予想損益 +15
//   VALUE① official: formal 2件 + 開始前に条件成立した conditional 1件 → 1勝2敗 / 純損益 -175
//          reference（監視）: 2勝（うち1件はレンジのみで金額未計算）/ pending1

const JST = "+09:00";

function match(id, sport, start, status, result = null) {
  return {
    id, sport, competition: "Fixture League", side_a: `${id}-a`, side_b: `${id}-b`, home_side: "unknown",
    venue: null, start_at: `${start}${JST}`, start_time_status: "recorded", status, result,
    sources: ["fixture"], verified_at: status === "final" ? `2026-09-25T12:00:00${JST}` : null, note: null,
    provenance: [{ update_run_id: "mr-fixture", changes: [], note: null }],
  };
}

function pick(system, id, fields) {
  return {
    id, system,
    match_id: fields.match_id,
    market: fields.market ?? "match_1x2",
    market_label: null,
    selection: fields.selection ?? "side_a",
    selection_label: null,
    market_odds: fields.market_odds ?? null,
    odds_taken: fields.odds_taken ?? null,
    stake: fields.stake === undefined ? 100 : fields.stake,
    discovered_at: fields.discovered_at ?? `2026-09-19T23:10:00${JST}`,
    run_id: fields.run_id === undefined ? null : fields.run_id,
    analysis_id: fields.analysis_id !== undefined ? fields.analysis_id
      : system === "experience" ? null : `${{ recommendations: "rec-an-", value1: "v1-an-", value2: "v2-an-" }[system]}${id.split("-").slice(1).join("-")}`,
    bet_at: fields.bet_at ?? null,
    locked_at: fields.locked_at === undefined ? `2026-09-19T23:30:00${JST}` : fields.locked_at,
    live: fields.live ?? false,
    locked: fields.locked ?? null,
    ...(fields.condition !== undefined ? { condition: fields.condition } : {}),
    closing_odds: null,
    recalculated_reference: [],
    settlement_override: fields.settlement_override ?? null,
    flags: fields.flags ?? [],
    detail_ref: null,
    note: null,
  };
}

export function makeDataset() {
  const matches = {
    schema_version: 1,
    update_runs: [{ run_id: "mr-fixture", kind: "result_update", at: `2026-09-25T12:00:00${JST}`, source: "fixture", note: null }],
    matches: [
      match("m1", "サッカー", "2026-09-20T20:00:00", "final", { final: { a: 2, b: 0 }, periods: { ht: { a: 1, b: 0 } }, text: null }),
      match("m2", "サッカー", "2026-09-21T20:00:00", "final", { final: { a: 1, b: 1 }, periods: { ht: { a: 0, b: 1 } }, text: null }),
      match("m3", "バレー", "2026-09-22T19:00:00", "final", { final: { a: 3, b: 1 }, periods: { set1: { a: 25, b: 20 } }, text: null }),
      match("m4", "CS2", "2026-09-23T05:00:00", "final", { final: { a: 0, b: 2 }, periods: { map1: { a: 13, b: 10 } }, text: null }),
      match("m5", "サッカー", "2026-09-24T18:00:00", "cancelled"),
      match("m6", "サッカー", "2026-09-30T18:00:00", "scheduled"),
    ],
  };

  const run = (prefix) => ({ run_id: `${prefix}2026-09-19-23`, started_at: `2026-09-19T23:00:00${JST}`, slot: "23:00", note: null });
  const R = "rec-2026-09-19-23", V1 = "v1-2026-09-19-23", V2 = "v2-2026-09-19-23";
  const rec = (id, f) => pick("recommendations", id, { run_id: R, locked: { prob: 0.9, gap_score: 90, confidence: "A", model_version: "5.1", summary: null }, ...f });

  const recommendations = {
    schema_version: 1, system: "recommendations", discovery_runs: [run("rec-")],
    picks: [
      rec("rec-r1", { match_id: "m1", market: "match_1x2", selection: "side_a", odds_taken: 1.2 }),       // win +20
      rec("rec-r2", { match_id: "m2", market: "dnb", selection: "side_a", odds_taken: 1.3 }),              // push
      rec("rec-r3", { match_id: "m2", market: "first_half_1x2", selection: "side_a", odds_taken: 1.5 }),   // loss -100
      rec("rec-r4", { match_id: "m3", market: "set1_winner", selection: "side_a", odds_taken: 1.25 }),     // win +25
      rec("rec-r5", { match_id: "m4", market: "map1_winner", selection: "side_a", odds_taken: 1.4 }),      // win +40
      rec("rec-r6", { match_id: "m5", market: "match_winner", selection: "side_a", odds_taken: 1.1 }),     // void
      rec("rec-r7", { match_id: "m6", market: "match_winner", selection: "side_b", odds_taken: 1.15,
        discovered_at: `2026-09-26T06:10:00${JST}`, locked_at: `2026-09-26T06:30:00${JST}` }),         // pending +15予定
      rec("rec-r8", { match_id: "m6", market: "match_1x2", selection: "side_a", odds_taken: null,
        market_odds: { text: "1.03〜1.06", min: 1.03, max: 1.06, observed_at: null, source: null },
        discovered_at: `2026-09-26T06:10:00${JST}`, locked_at: `2026-09-26T06:30:00${JST}` }),         // pending 未計算
    ],
  };

  const experience = {
    schema_version: 1, system: "experience",
    picks: [
      pick("experience", "exp-e1", { match_id: "m1", locked: { summary: null }, stake: 300, odds_taken: 1.05,
        bet_at: `2026-09-20T12:00:00${JST}`, discovered_at: null, locked_at: `2026-09-20T12:00:00${JST}` }), // win +15
      pick("experience", "exp-e2", { match_id: "m6", locked: { summary: null }, market: "match_winner", selection: "side_b", stake: 350, odds_taken: 1.09,
        bet_at: `2026-09-26T08:00:00${JST}`, discovered_at: null, locked_at: `2026-09-26T08:00:00${JST}` }), // pending +31.5予定
    ],
  };

  const v1 = (id, verdict, f) => pick("value1", id, {
    run_id: V1,
    locked: { verdict, prob_lo: 0.6, prob_hi: 0.65, prob_point: null, required_prob: 0.5, ev_lo: 0.02, ev_hi: 0.08, gap_score: null, model_version: "v1", summary: `${id} 独自分析` },
    ...f,
  });
  const range = (min, max) => ({ text: `${min}〜${max}`, min, max, observed_at: null, source: null });

  const value1 = {
    schema_version: 1, system: "value1", discovery_runs: [run("v1-")], excluded_log: [],
    picks: [
      v1("v1-a", "formal", { match_id: "m1", odds_taken: 1.25 }),                                        // official win +25
      v1("v1-b", "formal", { match_id: "m3", market: "match_winner", selection: "side_b", odds_taken: 2.0 }), // official loss -100
      v1("v1-c", "watch", { match_id: "m4", market: "map1_winner", stake: null, odds_taken: 1.35 }),     // reference win +35
      v1("v1-d", "conditional", { match_id: "m2", selection: "side_b", odds_taken: 3.0,
        condition: { text: "3.0以上", min_odds: 3.0, met: true, checked_at: `2026-09-21T19:00:00${JST}` } }), // official loss -100
      v1("v1-e", "conditional", { match_id: "m1", market: "first_half_1x2", odds_taken: 1.8,
        condition: { text: "1.8以上", min_odds: 1.8, met: null, checked_at: null } }),                   // 集計外（未確認）
      v1("v1-f", "conditional", { match_id: "m3", market: "set1_winner", odds_taken: 1.5,
        condition: { text: "1.5以上", min_odds: 1.5, met: true, checked_at: `2026-09-22T20:00:00${JST}` } }), // 集計外（開始後に確認）
      v1("v1-g", "excluded", { match_id: "m6", market: "match_winner", stake: null, odds_taken: null,
        discovered_at: `2026-09-26T06:10:00${JST}`, locked_at: `2026-09-26T06:30:00${JST}` }),
      v1("v1-h", "watch", { match_id: "m6", market: "match_winner", selection: "side_b", stake: null, odds_taken: null,
        market_odds: range(1.17, 1.2), discovered_at: `2026-09-26T06:10:00${JST}`, locked_at: `2026-09-26T06:30:00${JST}` }), // reference pending 未計算
      v1("v1-i", "watch", { match_id: "m4", market: "match_winner", selection: "side_b", stake: null, odds_taken: null,
        market_odds: range(1.17, 1.2) }),                                                               // reference win 金額未計算
    ],
  };

  const v2 = (id, verdict, f) => pick("value2", id, {
    run_id: V2,
    locked: { verdict, prob_lo: 0.6, prob_hi: 0.63, prob_point: null, required_prob: 0.568, market_gap_lo: 3.2, market_gap_hi: 6.2, upset_risk: "mid", model_version: "v2", summary: `${id} 独自分析` },
    ...f,
  });

  const value2 = {
    schema_version: 1, system: "value2", discovery_runs: [run("v2-")], excluded_log: [],
    picks: [
      v2("v2-a", "adopted", { match_id: "m3", market: "match_winner", odds_taken: 1.76 }),              // official win +76
      v2("v2-b", "watch", { match_id: "m6", market: "match_winner", stake: null, odds_taken: null,
        discovered_at: `2026-09-26T06:10:00${JST}`, locked_at: `2026-09-26T06:30:00${JST}` }),          // reference pending
    ],
  };

  return { matches, recommendations, experience, value1, value2 };
}

export function matchesById(dataset) {
  return new Map(dataset.matches.matches.map(m => [m.id, m]));
}
