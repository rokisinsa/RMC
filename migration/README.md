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

## 過去の事前確率

| カード | 採用した事前確率 | 根拠 |
|---|---|---|
| ODDIK vs Procyon | **0.7542**（locked） | `data-locked-prob` が a136f57（9/24 04:23 JST）で保存され、基準点まで不変。試合開始は 9/24 06:00 JST |
| Lyon | null | 旧 locked 0.922 は 58bebb7（9/23 23:13 JST）で保存。開始時刻が「未確認」のため、試合前か確認できない |
| Italy | null | 旧 locked 0.802 は 58bebb7（9/23 23:13 JST）で保存。開始時刻が「未確認」のため確認できない |
| Bounty Hunters | null | HTMLの 86.5% は 5546658（9/23 23:02 JST）で追加。試合開始（9/23 05:55 JST）より後 |
| Corinthians | null | HTMLの 92.0% は 9/23 23:02 JST に追加。試合開始（9/22 09:30 JST）より後 |
| Tunisia | null | HTMLの 86.0% は 9/23 23:02 JST に追加。開始時刻が未確認で、リポジトリの作成（9/23 21:46 JST）前に試合済み |

- **確認できない値の保存先**：Lyon と Italy の旧 locked 値は `legacy.raw.data_locked_prob_unverified` に、HTML 直書きの表示値は `legacy.raw.static_probability_text` に原文として残した。
- **再計算値**：現行モデル v5.1 での再計算値は `recalculated_reference` にだけ置いた。

VALUE①・② の推定勝率・必要勝率・EV・市場差は、初出（9/25 12:31〜9/26 01:59）から基準点まで不変で、試合開始前でした。そのため locked として採用しています。ただし KC vs XLG は開始時刻の記録がないため確認できず、null です（もともと「未固定」）。

## baseline との比較（`compare-baseline.js`）

| 分類 | 件数 |
|---|---|
| A. 手順0の期待値と一致 | 156 項目 |
| B. 意図した変更 | 6 項目 |
| C. 説明できない不一致 | **0 件** |

カード単位の照合でも、全45枚について次の3点が旧表示と一致した。

- 新ロジックが試合事実から判定した勝敗
- 投入額
- 取得オッズ

B の内訳：

1. **推奨の最大連敗 1 → 2**（重複を1件と数える参考集計も同じ）
   - 並び順を、旧 data-ts（投入・登録時刻が混在）から試合開始時刻優先へ変えた。
   - その結果、ODDIK（開始 9/24 06:00）が Sakkari（旧 data-ts 9/24 04:40、開始時刻未確認）の後ろになり、ODDIK×→中国× が連続した。
2. **推奨の1/4ケリー +$0.82（賭け1件）→ +$0.00（賭け0件・見送り9件）**
   - 事前確率の確定ルールにより、Lyon 0.922 が使えなくなった。
   - 残る ODDIK 0.7542 は、オッズ1.24では期待値がマイナスのため見送りになる。

B のうち「最大連敗（重複を1件と数える参考集計）」と「ケリーの見送り件数」の2件は、初回の比較で「説明できない不一致」として検出されました。原因を確かめたところ、上記1・2と同じ理由から派生する差分だったため、理由を明記して登録しました（データは変更していません）。

参考：精度検証（Brier）は、現行表示が3件で 0.2047 です。locked 確率のみを使うと、ODDIK の1件だけで Brier 0.5688 になります。
