// ④ PRO EDGE：競技モジュール（特徴量の定義）。
// 共通特徴量と競技固有特徴量を分ける。取得できない特徴量は status:"missing"・value:null とし、推測で埋めない。
// 市場由来の値（オッズ・市場確率）はモデルの特徴量に入れない（市場のコピー禁止）。

export const COMMON_FEATURES = [
  "rating", "ranking", "h2h_all", "recent6", "recent6_record", "avg_points_for", "avg_points_against",
  "venue_role", "lineup_today", "absences", "roster_change", "rest_days", "fixture_congestion",
  "tournament_context", "matchup_style",
];

export const SPORT_MODULES = {
  tennis: { label: "テニス", features: ["surface", "surface_record", "h2h_surface", "serve_hold_rate", "return_break_rate"] },
  soccer: { label: "サッカー", features: ["lineup", "xg_for", "xg_against", "schedule_load"] },
  basketball: { label: "バスケットボール", features: ["rotation", "pace", "back_to_back"] },
  baseball: { label: "野球", features: ["starting_pitcher", "bullpen_usage"] },
  volleyball: { label: "バレー", features: ["set_diff", "set1_record", "serve_receive"] },
  esports: { label: "eSports", features: ["veto", "map_pool", "map_diff", "side", "roster", "patch", "lan_online"] },
  handball: { label: "ハンドボール", features: ["goal_diff"] },
  cricket: { label: "クリケット", features: ["format", "toss"] },
  other: { label: "その他", features: [] },
};

// matches.json の sport（日本語表記）→ 競技モジュール
const SPORT_PATTERNS = [
  [/テニス/, "tennis"], [/サッカー/, "soccer"], [/バスケ/, "basketball"], [/野球/, "baseball"],
  [/バレー/, "volleyball"], [/ハンドボール/, "handball"], [/クリケット/, "cricket"],
  [/CS2|VALORANT|LoL|Rainbow Six|Dota|eSports/i, "esports"],
];
export function sportModuleOf(sport) {
  return SPORT_PATTERNS.find(([re]) => re.test(sport ?? ""))?.[1] ?? "other";
}

export const MARKET_DERIVED_FEATURE = /odds|market|implied|no_vig|consensus|closing|price/i;

export function knownFeatures(sportModule) {
  return new Set([...COMMON_FEATURES, ...(SPORT_MODULES[sportModule]?.features ?? [])]);
}
