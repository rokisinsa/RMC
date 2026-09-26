# 手順2：旧データの移行用下書き

基準点は `baseline-2026-09-26`（`02e5167`、2026-09-26 06:45:58 JST）です。

`analysis.html`、`analysis.js`、`index.html`、本番の GitHub Pages はいずれも変更していません。

## 再生成の手順

```
node migration/scan-history.js     # Git履歴（87コミット）の値の変遷 → history-report.json
node migration/migrate.js          # data/*.json（下書き）を生成
node scripts/validate-data.js      # スキーマ・整合性の検証
node migration/compare-baseline.js # baseline との比較 → compare-report.json
```

| ファイル | 役割 |
|---|---|
| `legacy-map.js` | 旧行を試合・市場・選択へ対応付ける手作業の対応表（35試合・45カード） |
| `history-report.json` | 旧HTMLの各行の値がいつ・どう変わったか（事前値の確認の根拠） |
| `compare-report.json` | 新ロジックの集計、baseline との差の分類、カード単位の照合 |

## 移行ルール

- **削除・統合はしない。** 旧行と同じ件数を移行した（推奨30・経験値4・VALUE①9・VALUE②2）。重複6組は両方を残し、`duplicate_review` を付けた。
- **出典の記録。** すべてのカードに `legacy_import` と `legacy`（commit・表・行番号・旧 data-ts・初出コミット・事前固定の根拠・原文）を持たせた。
- **開始時刻。** 旧HTMLの最終状態が明示している時刻だけを `recorded` とした。「未確認」「差異あり」「仮時刻 00:00/00:01」は、`start_at = null` とし、候補は `start_time_note` に書いた。
- **事前値（locked_at）。** 次の2つを Git 履歴で確認できた場合だけ設定した。
  - 今の事前値（オッズ・信頼度・格差スコア・locked確率・判定・推定勝率・EV）が、あるコミットから基準点まで変わっていないこと
  - そのコミットが試合開始より前であること

  確認できないカードは `locked_at = null` と `lock_unverified` にし、推定確率・EV は null とした。
- **オッズ。** 数字1つだけの表記は `odds_taken` とした。レンジ・「約」・「以上」・「未確認」は `market_odds` の原文と min/max に残し、`odds_taken` は null（一点へ固定しない）。
- **導出値は保存しない。** 払戻し・損益・○×△は保存していない。旧表示の払戻し・損益の文字列も `raw` に入れていない（baseline.json に保存済み）。

## 手順2の確定事項の反映（K1〜K10）

| 項目 | 反映内容 |
|---|---|
| K1 Lyon / Italy | 人間確認の更新回 `mr-2026-09-26-human-review` で、開始時刻（9/24 01:45 / 04:05 JST）と最終結果（0-8 / 2-3）を確定した。旧 locked 値 0.922 / 0.802 は Git 上の保存時刻 9/23 23:13 JST（58bebb7）が開始前なので locked に採用した |
| K2 Bulgaria | 正式結果 2-1 を確定し、`result_unverified` を外した（値は基準点と同じ）。条件付きVALUE は `condition.met = null` のため本成績外 |
| K3 ODDIK | `start_time_status: review_required`、候補は 06:00+09:00 と 06:00-03:00。locked 0.7542（9/24 04:23 JST）はどちらの候補よりも前なので維持した |
| K4 重複6組 | 同じ match_id を参照する別々のカードとして保持し、`duplicate_review` を付けた。格差・信頼度の食い違いもそのまま |
| K5 LOUD–EDG | VALUE①・VALUE② の両方に `analysis_independence_review` を付けた。分析値はコピーしていない。新規カードは移行用の探索回を使えない（`NEW_PICK_ON_LEGACY_RUN`） |
| K6 除外ログ | `data/legacy-unassigned.json` に `system_assignment: "unknown"` として保持した。VALUE①・VALUE② の `excluded_log` は空 |
| K7 市場・両チーム | 通常の勝者市場は 1X2 とした。DNB・ダブルチャンス・勝ち抜け・延長込みは別の市場として扱う。両チームは `side_a` / `side_b` で持ち、`home_side` は明記がある3試合だけ設定した |
| K8 基準点以降 | 試合事実は `update_runs` と `provenance`（before/after）で、基準点・人間確認・今後の結果更新を区別する。06:45 以降の結果は取り込んでいない |
| K9 削除済みの行 | 本データへは復元せず、`migration/archive/removed-before-baseline.json` で参照のみとした |
| K10 投入額 | 推奨は全件 $100。旧 $300 / $270 は `legacy.raw.stake_history` の履歴のみ |

## 過去の事前確率

| カード | 事前確率（locked） | locked_at（Git上の保存時刻） | 根拠 |
|---|---|---|---|
| ODDIK vs Procyon | **0.7542** | 2026-09-24 04:23 JST（a136f57） | 開始時刻は要確認（候補 9/24 06:00 JST / 9/24 18:00 JST）。どちらの候補よりも前 |
| Lyon | **0.922** | 2026-09-23 23:13 JST（58bebb7） | 開始 9/24 01:45 JST（人間確認）より前 |
| Italy | **0.802** | 2026-09-23 23:13 JST（58bebb7） | 開始 9/24 04:05 JST（人間確認）より前 |
| Bounty Hunters | null | — | HTMLの 86.5% は 9/23 23:02 JST の追加で、開始（9/23 05:55 JST）より後 |
| Corinthians | null | — | HTMLの 92.0% は 9/23 23:02 JST の追加で、開始（9/22 09:30 JST）より後 |
| Tunisia | null | — | HTMLの 86.0% は 9/23 23:02 JST の追加。開始時刻が未確認で、リポジトリ作成前に試合済み |

HTML 直書きの表示値は `legacy.raw.static_probability_text` に原文として残した。現行モデル v5.1 での再計算値は `recalculated_reference` にだけ置いている（例：Lyon 0.9103。事前確率とは別の項目）。

VALUE①・② の推定勝率・必要勝率・EV・市場差は、初出（9/25 12:31〜9/26 01:59）から基準点まで変わっておらず、試合開始前だったので locked に採用した。KC vs XLG だけは開始時刻の記録がないため確認できず、null（もともと「未固定」）。

## baseline との比較（`compare-baseline.js`）

| 分類 | 件数 |
|---|---|
| A. 手順0の期待値と一致 | 161 項目 |
| B. 意図した変更 | 1 項目 |
| C. 説明できない不一致 | **0 件** |

カード単位の照合でも、全45枚について、新ロジックの判定した勝敗・投入額・取得オッズが旧表示と一致した。

B の内容は「推奨の複利ストック $114.80 → $140.58」の1件。Lyon・Italy の開始時刻が確定したことで並び順が実際の開始時刻順になり、Tunisia→Corinthians→Prizmic→Bounty→Lyon→Italy の6連勝で初めて倍額に届くようになった（1.17×1.11×1.19×1.13×1.12×1.23 ＝ 2.4058）。確保回数1回・失敗2回・現在資金$100は変わらない。

前回（手順2の初回）に意図した変更として登録していた「最大連敗 1→2」と「1/4ケリー +$0.82→$0」は、今回の確定（Lyon の locked 採用、ODDIK の並び順にロック時刻を使用）で解消し、手順0の期待値と一致した。

精度検証（locked 確率のみ）は3件で Brier 0.2047 / Log Loss 0.5684 になり、現在の表示と一致する。
