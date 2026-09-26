// ④ PRO EDGE のテスト・サンプル実行用の架空データ（実在の試合・実際のオッズではない）。
// data/ には入れない。makeProEdgeSample() は毎回新しいコピーを返す。
//
// 早見表
//   pe-s1 accepted テニス 2-way・2社 consensus・Expert補正あり・締切あり → 勝ち
//   pe-s2 accepted サッカー 3-way・1社のみ → 引分で負け
//   pe-s3 watch    eSports 2-way（EV が required_EV 未満）→ 勝ち（参考成績）
//   pe-s4 rejected サッカー 2-way DNB（edge マイナス）
//   pe-s5 accepted バレー 2-way・試合前（締切なし → CLV 未計算）

const J = "+09:00";

function match(id, sport, start, status, result = null) {
  return {
    id, sport, competition: "Sample League", side_a: `${id}-A`, side_b: `${id}-B`, home_side: "unknown", venue: null,
    start_at: `${start}${J}`, start_time_status: "recorded", start_time_note: null, status, result,
    provenance: [{ update_run_id: "mr-sample", changes: [], note: null }],
    sources: ["sample"], verified_at: null, flags: [], note: null,
  };
}

const snap = (snapshot_id, kind, bookmaker, market, outcomes, observed_at) =>
  ({ snapshot_id, kind, bookmaker, market, outcomes, observed_at: `${observed_at}${J}`, source: `${bookmaker} 公開オッズページ` });
const feature = (name, value, observed_at, source = "公開データ") =>
  value === null
    ? { name, status: "missing", value: null, observed_at: null, source: null, note: "取得できず" }
    : { name, status: "present", value, observed_at: `${observed_at}${J}`, source, note: null };
const model = (sport_module, trained_through) =>
  ({ model_id: `${sport_module}-elo-logit`, model_version: "0.1.0", sport_module, method: "elo_logistic", trained_through: `${trained_through}${J}` });

function pick(id, f) {
  return {
    id, system: "pro_edge", match_id: f.match_id, run_id: "pe-2026-10-01-06", analysis_id: `pe-an-${id.slice(3)}`,
    market: f.market, selection: f.selection, selection_label: null,
    discovered_at: f.discovered_at ?? `2026-10-01T06:10:00${J}`,
    locked_at: f.locked_at ?? `2026-10-01T06:40:00${J}`,
    bet_at: f.bet_at ?? null, live: false,
    price_snapshots: f.snapshots,
    bet_odds: f.bet_odds ?? null, bet_bookmaker: f.bet_bookmaker ?? null,
    stake: f.stake ?? null,
    locked: {
      decision: f.decision, decision_reason: f.decision_reason ?? null, required_ev: 0.03,
      market_reference: f.market_reference, offered_price: f.offered_price,
      model: f.model, base_probability: f.base_probability, expert_adjustments: f.adjustments ?? [],
      features: f.features ?? [], data_confidence: f.data_confidence ?? "medium",
      price_gap_factors: f.price_gap_factors ?? [], disagreement_reasons: f.disagreement_reasons ?? [],
      missing_information: f.missing_information ?? [], summary: null,
    },
    recalculated_reference: [],
    settlement_override: null, flags: [], note: null,
  };
}

export function makeProEdgeSample() {
  const matches = {
    schema_version: 1,
    update_runs: [{ run_id: "mr-sample", kind: "result_update", at: `2026-10-02T12:00:00${J}`, source: "sample", note: null }],
    matches: [
      match("pe-m1", "男子テニス", "2026-10-01T20:00:00", "final", { final: { a: 2, b: 1 }, text: null }),
      match("pe-m2", "男子サッカー", "2026-10-01T21:00:00", "final", { final: { a: 1, b: 1 }, text: null }),
      match("pe-m3", "CS2", "2026-10-01T22:00:00", "final", { final: { a: 0, b: 2 }, text: null }),
      match("pe-m4", "男子サッカー", "2026-10-01T23:00:00", "final", { final: { a: 2, b: 0 }, text: null }),
      match("pe-m5", "男子バレー", "2026-10-03T19:00:00", "scheduled"),
    ],
  };

  const pro_edge = {
    schema_version: 1, system: "pro_edge",
    discovery_runs: [{ run_id: "pe-2026-10-01-06", started_at: `2026-10-01T06:00:00${J}`, slot: "06:00", note: "④独自の探索回" }],
    picks: [
      pick("pe-s1", {
        match_id: "pe-m1", market: "match_winner", selection: "side_a", decision: "accepted", stake: 100,
        snapshots: [
          snap("ps-s1-open-a", "opening", "BookA", "match_winner", { side_a: 2.0, side_b: 1.8 }, "2026-09-30T12:00:00"),
          snap("ps-s1-an-a", "analysis", "BookA", "match_winner", { side_a: 2.1, side_b: 1.75 }, "2026-10-01T06:20:00"),
          snap("ps-s1-an-b", "analysis", "BookB", "match_winner", { side_a: 2.05, side_b: 1.8 }, "2026-10-01T06:25:00"),
          snap("ps-s1-close-a", "closing", "BookA", "match_winner", { side_a: 1.95, side_b: 1.9 }, "2026-10-01T19:59:00"),
        ],
        market_reference: { snapshot_ids: ["ps-s1-an-a", "ps-s1-an-b"], method: "consensus" },
        offered_price: { snapshot_id: "ps-s1-an-a" },
        model: model("tennis", "2026-09-30T23:59:00"),
        base_probability: 0.52,
        adjustments: [{ adjustment_value: 0.02, category: "injury", reason: "相手選手の手首テーピング（公式練習映像）", source: "大会公式SNS", created_at: `2026-10-01T06:30:00${J}` }],
        features: [
          feature("rating", 1685, "2026-09-30T23:00:00"), feature("h2h_all", "3勝2敗", "2026-09-30T23:00:00"),
          feature("recent6", "5勝1敗", "2026-09-30T23:00:00"), feature("surface", "hard", "2026-09-30T23:00:00"),
          feature("serve_hold_rate", null, null),
        ],
        data_confidence: "medium",
        bet_odds: 2.08, bet_bookmaker: "BookA", bet_at: `2026-10-01T07:00:00${J}`,
        price_gap_factors: ["市場は直近の大会成績を重視", "サーフェス適性の差が価格に未反映"],
        disagreement_reasons: ["RMCはハードコートでの直近成績を高く評価"],
        missing_information: ["serve_hold_rate"],
      }),
      pick("pe-s2", {
        match_id: "pe-m2", market: "match_1x2", selection: "side_a", decision: "accepted", stake: 100,
        snapshots: [
          snap("ps-s2-an-a", "analysis", "BookA", "match_1x2", { side_a: 2.5, draw: 3.4, side_b: 2.9 }, "2026-10-01T06:20:00"),
          snap("ps-s2-close-a", "closing", "BookA", "match_1x2", { side_a: 2.4, draw: 3.5, side_b: 3.0 }, "2026-10-01T20:59:00"),
        ],
        market_reference: { snapshot_ids: ["ps-s2-an-a"], method: "single_book" },
        offered_price: { snapshot_id: "ps-s2-an-a" },
        model: model("soccer", "2026-09-30T23:59:00"),
        base_probability: 0.45,
        features: [feature("rating", 1602, "2026-09-30T23:00:00"), feature("xg_for", null, null), feature("lineup", null, null)],
        data_confidence: "low",
        bet_odds: 2.45, bet_bookmaker: "BookA", bet_at: `2026-10-01T07:05:00${J}`,
        missing_information: ["xg_for", "lineup"],
      }),
      pick("pe-s3", {
        match_id: "pe-m3", market: "match_winner", selection: "side_b", decision: "watch", decision_reason: "EV が required_EV に届かない",
        snapshots: [snap("ps-s3-an-a", "analysis", "BookA", "match_winner", { side_a: 1.9, side_b: 1.95 }, "2026-10-01T06:20:00")],
        market_reference: { snapshot_ids: ["ps-s3-an-a"], method: "single_book" },
        offered_price: { snapshot_id: "ps-s3-an-a" },
        model: model("esports", "2026-09-30T23:59:00"),
        base_probability: 0.52,
        features: [feature("map_pool", "Mirage/Inferno/Nuke", "2026-09-30T23:00:00"), feature("veto", null, null)],
      }),
      pick("pe-s4", {
        match_id: "pe-m4", market: "dnb", selection: "side_a", decision: "rejected", decision_reason: "edge マイナス（圧倒的格差だが価格が適正以下）",
        snapshots: [snap("ps-s4-an-a", "analysis", "BookA", "dnb", { side_a: 1.2, side_b: 4.5 }, "2026-10-01T06:20:00")],
        market_reference: { snapshot_ids: ["ps-s4-an-a"], method: "single_book" },
        offered_price: { snapshot_id: "ps-s4-an-a" },
        model: model("soccer", "2026-09-30T23:59:00"),
        base_probability: 0.76,
        features: [feature("rating", 1810, "2026-09-30T23:00:00")],
      }),
      pick("pe-s5", {
        match_id: "pe-m5", market: "match_winner", selection: "side_a", decision: "accepted", stake: 100,
        snapshots: [snap("ps-s5-an-a", "analysis", "BookA", "match_winner", { side_a: 1.85, side_b: 2.0 }, "2026-10-01T06:20:00")],
        market_reference: { snapshot_ids: ["ps-s5-an-a"], method: "single_book" },
        offered_price: { snapshot_id: "ps-s5-an-a" },
        model: model("volleyball", "2026-09-30T23:59:00"),
        base_probability: 0.58,
        features: [feature("set_diff", "+14", "2026-09-30T23:00:00")],
        bet_odds: 1.85, bet_bookmaker: "BookA", bet_at: `2026-10-01T07:10:00${J}`,
      }),
    ],
  };
  return { matches, pro_edge };
}

// 評価テスト用の合成系列（決定的な疑似乱数。実データではない）
export function makeSeries(n, { seed = 7, p = 0.55, odds = 2.0 } = {}) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Array.from({ length: n }, (_, i) => {
    const win = rand() < p;
    const at = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().replace(".000Z", "Z");
    const close = odds * (0.95 + rand() * 0.1);
    return {
      settlement: { state: win ? "win" : "loss", stake: 100, odds, payout: win ? 100 * odds : 0, profit: win ? 100 * (odds - 1) : -100, projectedProfit: null, amountMissing: false, orderKey: at },
      analysis: {
        final_probability: p, ev: p * odds - 1, ev_at_bet: p * odds - 1,
        clv: { clv_price: odds / close - 1, clv_probability: null },
      },
    };
  });
}
