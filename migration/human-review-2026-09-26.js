// 移行基準点（baseline-2026-09-26、06:45 JST）の「後」に、人間が確認して確定した試合事実。
// 基準点の値は書き換えず、別の更新回（human_review）として provenance に before/after を残す。
//
// ここに入れてよいのは、ユーザーが公式情報で確認した事実だけ。06:45 以降に判明した新しい試合結果は入れない
// （それは今後 result_update の更新回として別に取り込む）。

export const HUMAN_REVIEW_RUN = {
  run_id: "mr-2026-09-26-human-review",
  kind: "human_review",
  at: "2026-09-26T18:51:47+09:00",
  source: "ユーザー確認（外部の公式情報：Servette FC Chênois Féminin vs OL Lyonnes、Italy vs Finland、UEFA公式）",
  note: "手順2の要確認事項 K1・K2 への回答。基準点時点で既に終了していた試合の開始時刻・結果の確定",
};

// match_id → { 変更する項目: 新しい値 }, 確認メモ
export const HUMAN_REVIEW_CHANGES = {
  "2026-09-23-ser-lyo": {
    set: {
      start_at: "2026-09-24T01:45:00+09:00",
      start_time_status: "recorded",
      start_time_note: "現地 2026/09/23 18:45（公式情報でユーザー確認）",
      result: { final: { a: 0, b: 8 }, periods: { ht: { a: 0, b: 4 } }, text: "Servette 0-8 Lyon（前半 0-4）" },
    },
    note: "開始時刻と最終結果を公式情報で確認",
  },
  "2026-09-23-ita-fin": {
    set: {
      start_at: "2026-09-24T04:05:00+09:00",
      start_time_status: "recorded",
      start_time_note: "現地 2026/09/23 21:05（公式情報でユーザー確認）",
      result: { final: { a: 2, b: 3 }, winners: { set1: "side_a" }, text: "Italy 2-3 Finland（第1セットはイタリア。スコア未記録）" },
    },
    note: "開始時刻と最終結果を公式情報で確認。第1セットの勝者は旧記録どおり",
  },
  "2026-09-26-bul-por-u21": {
    set: { flags: ["legacy_import"] },   // result_unverified を外す（結果の値は基準点と同じ 2-1）
    note: "正式結果 Bulgaria U21 2-1 Portugal U21 を UEFA 公式で確認。旧データにあった「Portugal 4-0」は採用しない",
  },
};
