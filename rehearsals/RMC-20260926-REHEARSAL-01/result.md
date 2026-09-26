# 実運用リハーサル RMC-20260926-REHEARSAL-01

入力：`rehearsals/RMC-20260926-REHEARSAL-01/gpt-input.json`（架空の試合・オッズ。data/ には入れない）
定時更新の想定時刻：2026-09-27T18:00:00+09:00（slot 18:00）

## □1〜□12 の実施内容

- □1 結果更新：mr-2026-09-27-1800-rehearsal-01（2026-09-27-rhpa-rhpb を final へ）
- □2 未確定カード更新：④締切スナップショット 1件・①closing_odds 1件
- □3 ①新規：rec-rh-01（探索回 rec-2026-09-27-1800-rh）
- □4 ②新規：v1-rh-01（探索回 v1-2026-09-27-1800-rh）
- □5 ③新規：v2-rh-01（探索回 v2-2026-09-27-1800-rh）
- □6 ④新規：pe-rh-01, pe-rh-02（探索回 pe-2026-09-27-1800-rh）
- □7 競技偏り監査・□9 損益/ROI/CLV・□10 データ品質：下の「監査レポート」
- □8 敗因分析：recommendations 1件・pro_edge 1件
- □11 JSON 更新：before → after の差分を locked 保護・追記のみ検査で確認（本番 data/ へは書かない）
- □12 commit SHA・公開ページ確認：dev ブランチの push と GitHub Actions・V2 表示確認で行う（このスクリプトの外）

## スキーマ・整合性（validate-data と同じ検査）

- PASS before: error 0件
  - before: リハーサルで増えた warning 0件
- PASS after: error 0件
  - after: リハーサルで増えた warning 0件
- PASS corrected: error 0件
  - corrected: リハーサルで増えた warning 0件

## locked 保護・追記のみ（check-locked と同じ検査。基準が draft でも省略しない）

- PASS data/ → before: 違反0件
- PASS before → after: 違反0件
- PASS after → corrected: 違反0件
- PASS data/ → corrected: 違反0件
- PASS （逆検査）locked 後の odds_taken 書き換え・④価格の書き換え・更新ログの書き換えを検出する — LOCKED_FIELD_CHANGED, PRICE_SNAPSHOTS_REWRITTEN, UPDATE_LOG_REWRITTEN

## 4系統の独立性（①推奨・②VALUE①・③VALUE②・④PRO EDGE）

- PASS ① だけが扱う候補がある — 2026-09-28-rhfa-rhfb
- PASS ② だけが扱う候補がある — 2026-09-28-rhta-rhtb
- PASS ③ だけが扱う候補がある — 2026-09-28-rhva-rhvb
- PASS ④ だけが扱う候補がある — 2026-09-28-rhea-rheb, 2026-09-28-rhwa-rhwb
- PASS 複数系統で同じ match_id を扱う試合がある（共有は試合事実だけ） — 2026-09-27-rhpa-rhpb：①②④
- PASS ① の候補はすべて自系統の探索回 run_id を持つ（共通候補プール・振り分けなし）
- PASS ② の候補はすべて自系統の探索回 run_id を持つ（共通候補プール・振り分けなし）
- PASS ③ の候補はすべて自系統の探索回 run_id を持つ（共通候補プール・振り分けなし）
- PASS ④ の候補はすべて自系統の探索回 run_id を持つ（共通候補プール・振り分けなし）
- PASS 探索回は系統ごとに別の run_id（4回の独立探索） — rec-2026-09-27-0600-rh, rec-2026-09-27-1800-rh, v1-2026-09-27-0600-rh, v1-2026-09-27-1800-rh, v2-2026-09-27-1800-rh, pe-2026-09-27-0600-rh, pe-2026-09-27-1800-rh
- PASS ① のデータに④固有の項目が無い
- PASS ② のデータに④固有の項目が無い
- PASS ③ のデータに④固有の項目が無い
- PASS ① の表示行に④の計算値（market/base/final probability・EV・CLV）が無い
- PASS ② の表示行に④の計算値（market/base/final probability・EV・CLV）が無い
- PASS ③ の表示行に④の計算値（market/base/final probability・EV・CLV）が無い
- PASS ④の base / final probability が同じ試合の①②③の推定値の写しではない
- PASS ④の分析文が①②③の分析文の写しではない
- PASS 共有試合で「共通分析の流用の疑い」警告が出ていない
- PASS （逆検査）①②③へ④の項目（market_probability / base_probability / final_probability）を入れると error
- PASS （逆検査）④の基本推定と②の推定値が一致すると「流用の疑い」警告
- PASS （逆検査）④のカードが①の探索回を使うと error

## scheduled → final の反映（記号・払戻し・損益・戦績・勝率・ROI・未確定件数）

| 系統 | カード | 状態 | 記号 | 払戻し | 損益 | 未確定の予想損益 |
|---|---|---|---|---|---|---|
| ① before | rec-rh-00-a | pending | △ | — | — | 80 |
| ① after | rec-rh-00-a | win | ○ | 180 | 80 | — |
| ② before | v1-rh-00-a | pending | △ | — | — | 85 |
| ② after | v1-rh-00-a | win | ○ | 185 | 85 | — |
| ④ before | pe-rh-00-a | pending | △ | — | — | 85 |
| ④ after | pe-rh-00-a | win | ○ | 185 | 85 | — |

| 系統 | 集計 | 時点 | 件数 | 戦績 | 勝率 | 確定投入 | 純損益 | ROI | 未確定 |
|---|---|---|---|---|---|---|---|---|---|
| ① | 本成績 | before | 31 | 9勝2敗 | 81.82% | 1000 | -73 | -7.3% | 19 |
| ① | 本成績 | after | 32 | 10勝2敗 | 83.33% | 1100 | 7 | 0.64% | 19 |
- PASS ① rec-rh-00-a：試合前（△）→ 的中（○）
- PASS ① rec-rh-00-a：払戻し 100×1.8＝180・損益 +80
- PASS ① 本成績：勝ち +1・純損益 +80・確定投入 +100・未確定 19→19 — 新規の未確定 1件を含む
- PASS ① 本成績：勝率＝勝ち÷(勝ち＋負け)・ROI＝純損益÷確定投入
| ② | 参考成績（監視・$100仮定） | before | 5 | 3勝0敗 | 100% | 100 | 35 | 35% | 2 |
| ② | 参考成績（監視・$100仮定） | after | 5 | 4勝0敗 | 100% | 200 | 120 | 60% | 1 |
- PASS ② v1-rh-00-a：試合前（△）→ 的中（○）
- PASS ② v1-rh-00-a：払戻し 100×1.85＝185・損益 +85
- PASS ② 参考成績（監視・$100仮定）：勝ち +1・純損益 +85・確定投入 +100・未確定 2→1 — 新規の未確定 0件を含む
- PASS ② 参考成績（監視・$100仮定）：勝率＝勝ち÷(勝ち＋負け)・ROI＝純損益÷確定投入
| ④ | 本成績（accepted） | before | 1 | 0勝0敗 | —% | 0 | 0 | —% | 1 |
| ④ | 本成績（accepted） | after | 2 | 1勝0敗 | 100% | 100 | 85 | 85% | 1 |
- PASS ④ pe-rh-00-a：試合前（△）→ 的中（○）
- PASS ④ pe-rh-00-a：払戻し 100×1.85＝185・損益 +85
- PASS ④ 本成績（accepted）：勝ち +1・純損益 +85・確定投入 +100・未確定 1→1 — 新規の未確定 1件を含む
- PASS ④ 本成績（accepted）：勝率＝勝ち÷(勝ち＋負け)・ROI＝純損益÷確定投入
- PASS 実効の試合事実：status final・スコア・result_confirmed_at・根拠（出典・確認時刻・確度）が provenance に残る
- PASS V2 描画：共有試合の結果と今回の更新回が画面に出る
- PASS ①レンジだけのオッズは一点に固定せず、未確定の予想損益は「未計算」扱い

## 確定結果の訂正（final → corrected final）

- 訂正前（previous_value）：{"a":2,"b":0} Rehearsal Player A 2-0（架空）
- 訂正後（new_value）：{"a":1,"b":2} Rehearsal Player B 2-1（訂正後・架空）
- 理由（reason）：公式記録の訂正（リハーサル・架空）
- 出典（source）：大会公式 訂正発表（架空） https://rehearsal.example/official/rhpa-rhpb-correction（official）
- 確認時刻（verified_at）：2026-09-27T19:50:00+09:00／確度：official
- PASS provenance に previous_value / new_value / reason / source / verified_at が残る
- PASS 訂正前の履歴（□1 の確定記録）は消えずに残る（追記のみ）

| 系統 | カード | 訂正前 | 訂正後 | 損益 訂正前→後 | 集計の純損益 訂正前→後 | 戦績 訂正前→後 |
|---|---|---|---|---|---|---|
| ① | rec-rh-00-a | ○ | × | 80→-100 | 7→-173 | 10勝2敗→9勝3敗 |
- PASS ① rec-rh-00-a：精算が自動で ○→× に変わり、集計の純損益が -180 変わる
| ② | v1-rh-00-a | ○ | × | 85→-100 | 120→-65 | 4勝0敗→3勝1敗 |
- PASS ② v1-rh-00-a：精算が自動で ○→× に変わり、集計の純損益が -185 変わる
| ④ | pe-rh-00-a | ○ | × | 85→-100 | 85→-100 | 1勝0敗→0勝1敗 |
- PASS ④ pe-rh-00-a：精算が自動で ○→× に変わり、集計の純損益が -185 変わる
- PASS （逆検査）理由（correction.reason）の無い訂正は error
- PASS （逆検査）予想・プレビューを根拠にした結果更新は error

## ④ PRO EDGE：市場価格 → no-vig → 市場確率 → base → 補正 → final → edge → fair odds → EV → 判定 → 購入 → 締切 → CLV

| カード | 判定 | 市場確率 | 方法 | base | 補正 | final | edge | fair odds | 提示 | EV | 必要EV | 最低オッズ | 購入 | 締切 | CLV(価格) | CLV(確率) | CLV状態 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pe-rh-00-a（before：締切前） | accepted | 0.53 | consensus | 0.56 | 0.02 | 0.58 | 0.05 | 1.72 | 1.85 | 0.07 | 0.03 | 1.78 | 1.85 | — | — | — | no_closing_odds |
| pe-rh-00-a（after：締切追記） | accepted | 0.53 | consensus | 0.56 | 0.02 | 0.58 | 0.05 | 1.72 | 1.85 | 0.07 | 0.03 | 1.78 | 1.85 | 1.75 | 0.06 | 0 | ok |
| pe-rh-01（締切なし） | accepted | 0.44 | single_book | 0.5 | 0 | 0.5 | 0.06 | 2 | 2.2 | 0.1 | 0.03 | 2.06 | 2.2 | — | — | — | no_closing_odds |
| pe-rh-02（rejected） | rejected | 0.71 | single_book | 0.7 | 0 | 0.7 | -0.01 | 1.43 | 1.3 | -0.09 | 0.03 | 1.47 | — | — | — | — | no_bet_odds |
- PASS pe-rh-00-a：市場確率（2社 consensus・no-vig）〜CLV まで、式どおりの独立再計算と一致
- PASS pe-rh-00-a：no-vig 後の確率の合計が 1（控除を除去）
- PASS pe-rh-00-a：EV ≥ 必要EV なので accepted（本成績）
- PASS 締切オッズが無い時点では CLV 未計算（before）→ 締切追記で CLV 計算（after）
- PASS pe-rh-01：締切オッズが無いので CLV は未計算（null・推測しない）
- PASS pe-rh-02：EV マイナスで rejected・集計外（投入額なし）
- PASS V2 表示：④の締切なしカードに「CLV 未計算」バッジ
- PASS （逆検査）試合開始後に取得した締切オッズは error（CLV に使わない）
- PASS （逆検査）base_probability に市場確率をそのまま入れると error（市場のコピー禁止）

## 既存の live テスト・監査レポートをリハーサルデータで実行

- PASS live テスト（RMC_DATA_DIR=after） — pass 10 / fail 0
- PASS live テスト（RMC_DATA_DIR=corrected） — pass 10 / fail 0
- PASS validate-data.js（after） — error 0 件 / warning 15 件
- PASS validate-data.js（corrected） — error 0 件 / warning 15 件
- PASS audit-report.js（after）：集計の不整合なし

```
■ □7 競技偏り監査（系統ごと・直近20件の新規カード）
  recommendations: 2件 / 最多 男子サッカー 50%
  value1: 2件 / 最多 CS2 50%
  value2: 1件 / 最多 男子バレー 100%
  pro_edge: 3件 / 最多 VALORANT 33%

■ □9 損益・ROI・CLV の検証
  ① 推奨: 12戦10勝2敗 純損益 7.00 ROI 0.64% 未確定 19件 金額未計算 1件 整合OK
  経験値: 2戦2勝0敗 純損益 57.00 ROI 9.50% 未確定 2件 金額未計算 0件 整合OK
  ② VALUE① 本成績: 2戦1勝1敗 純損益 -75.00 ROI -37.50% 未確定 3件 金額未計算 0件 整合OK
  ③ VALUE② 本成績: 1戦1勝0敗 純損益 76.00 ROI 76.00% 未確定 1件 金額未計算 0件 整合OK
  ④ PRO EDGE 本成績: 1戦1勝0敗 純損益 85.00 ROI 85.00% 未確定 1件 金額未計算 0件 整合OK
  ④ CLV: 計算済み 1件 / 確定済みで締切オッズ未取得 0件
  ① 複利: 参考値・取引順序未確定
  ② 複利: 参考値・取引順序未確定
  ③ 複利: 参考値・取引順序未確定

■ □10 データ品質監査
  開始時刻 未確認・要確認: 9件
  オッズ 未確認: 14件 / レンジのみ: 13件
  結果 未確認（開始済み）: 24件
  条件成立 未確認: 1件
  重複確認中: 12件 / 独立性要確認: 2件
  結果更新の要確認（試合）: 8試合

集計の不整合なし
```

## V2 表示確認用のコピー

- `node scripts/serve.js` を起動して http://localhost:8123/.tmp-tests/rehearsal/RMC-20260926-REHEARSAL-01/site/analysis-v2.html を開く（リハーサルデータ・本番 data/ とは別）
- PASS 確認用コピーにデモ用の架空データ（Sample League・pe-s*）が含まれない

## 本番データ

- PASS data/ はリハーサルの前後で1バイトも変わっていない — 120116b9a70c3ba7
- PASS data/ に架空のリハーサルデータが無い

## まとめ

- 検証 69件：PASS 69 / FAIL 0
