# RMC 定時更新 仕様書（ChatGPT 定時タスク用・最終版）

- **状態**：本番切替の承認後に、ChatGPT 定時タスクへこのまま移植する（現時点では未適用）。
- **実行時刻**：毎日 06:00・12:00・18:00・23:00（日本時間）
- **リポジトリ**：`rokisinsa/RMC`（ブランチ `main`）
- **公開ページ**：`https://rokisinsa.github.io/RMC/analysis-v2.html`（切替後のページ）

---

## 毎回のチェックリスト（この順番で全項目を行い、最後の報告に各項目の結果を書く）

- □1 結果更新（下の「□1」）
- □2 未確定カード更新（「□2」）
- □3 推奨用の新規候補を独立探索（「□3」）
- □4 VALUE①用の新規候補を独立探索（「□4」）
- □5 VALUE②用の新規候補を独立探索（「□5」）
- □6 PRO EDGE用の新規候補を独立探索（「□6」と「④ PRO EDGE 更新手順」）
- □7 競技偏り監査（「□7」）
- □8 敗因分析（「□8」）
- □9 損益・ROI・CLV等の検証（「□9」）
- □10 データ品質監査（「□10」）
- □11 JSON更新・Git commit（「□11」）
- □12 最新commit SHAと公開RMC確認（「□12」）

□3〜□6 は4回の独立した探索です。共通候補の一覧を作って振り分けること、他系統の候補・分析を流用することは禁止です。

---

## 0. 絶対ルール（毎回、作業の前に確認する）

1. **HTML・JS に数値やカードを書き込まない。** `analysis.html` / `analysis.js` / `analysis-v2.html` / `analysis-v2.js` / `index.html` は編集しない。更新するのは `data/` 配下の JSON だけ。
2. **導出値を書かない。** 払戻し・純損益・戦績・勝率・ROI・投入総額・未確定件数・判定内訳・複利・ケリー・CLV は画面が自動で計算する。スキーマ上も保存できない。
3. **候補探索は4系統で完全に独立して4回行う。** ① 推奨取引・② VALUE①・③ VALUE②・④ PRO EDGE は、それぞれ別々に探索・分析・判定する。次のことは禁止。
   - 共通の候補一覧を作って各系統へ振り分けること
   - ①〜③の候補・分析値・推定勝率・判定を④へ流用すること
   - ④の候補・分析値を①〜③へ流用すること
   - ある系統の分析結果を見て、別の系統の判定を決めること
   - ④の追加・改善を理由に、①②③の探索条件・分析方法・判定基準を変えること
   同じ試合が複数の系統に入ること自体は構わない。その場合も、各系統が自分の探索回・自分の分析で判断する。
4. **推測しない。** 確認できない開始時刻・オッズ・結果・スコアは null または要確認のまま残す。オッズのレンジ（例 1.17〜1.20）を一点に固定しない。
5. **試合前に固定した事前値（locked）は、試合開始後に書き換えない。** 再計算した値は `recalculated_reference` へ追記する。
6. **削除しない。** 既存のカード・試合・更新ログ・旧分析メモ・重複6組（duplicate_review）を消さない、統合しない。
7. **基準点と移行スナップショットを変更しない。** `baseline/2026-09-26/`・`snapshots/2026-09-26-migration/`・`data/matches.json` の既存の試合事実は書き換えない。結果は `data/match-updates.json` に追記する。
8. **1回の定時更新は1コミット。** テスト（GitHub Actions）が失敗したら、次の作業より先に直す。

---

## □1 結果更新

前回以降に開始した試合の結果を確認し、`data/match-updates.json` の `runs` に更新回を1件追記する。既存の run は変更も削除もしない。

1. 対象を洗い出す：`data/matches.json` と既存の更新ログを重ねた状態で、次のどちらかに当たる試合。
   - `status` が `scheduled` / `unknown` で、開始時刻を過ぎたもの
   - 要確認（reviews）に残っているもの
2. **試合の同一性を確認する。** 名前だけで同じ試合と決めない。日付・大会・対戦相手・ラウンド・開始時刻を組み合わせて照合する。表記揺れがあって断定できないときは `review_required` にする。
3. **結果の情報源の優先順位**
   | 優先 | 情報源 | `source_confidence` |
   |---|---|---|
   | 1 | 競技・大会・リーグ・チームの公式 | `official` |
   | 2 | 信頼性の高い専門結果DB（ATP / WTA / ITF、HLTV、VLR.gg、SiegeGG、ESPNcricinfo など） | `specialist_db` |
   | 3 | 信頼できる複数の結果ソースが一致 | `multi_source` |
   | — | 信頼できるソースが1件だけ | `single_source`（1件のみであることを明示） |
   | — | ユーザーが公式で確認して指示した | `user_confirmed` |
   - 各情報源には `name`・`url`・`type`（`official` / `specialist_db` / `media` / `user_confirmed`）を書く。
   - **使用禁止**：予想（Prediction）、プレビュー、Correct Score 予想、オッズ・ベッティング情報のページ、検索スニペットだけ。検査で拒否される。
4. 確認できた試合だけを `changes` に書く。
   ```json
   {
     "match_id": "2026-09-26-ge-vit",
     "set": {
       "status": "final",
       "result": { "final": { "a": 1, "b": 2 }, "periods": { "map1": { "a": 10, "b": 13 } }, "text": "Team Vitality 2-1 Global Esports" },
       "result_confirmed_at": "2026-09-26T20:00:00+09:00"
     },
     "evidence": {
       "sources": [{ "name": "VLR.gg", "url": "https://www.vlr.gg/...", "type": "specialist_db" }],
       "verified_at": "2026-09-26T20:00:00+09:00",
       "source_confidence": "specialist_db",
       "note": null
     }
   }
   ```
   - スコアは `a` = side_a（matches.json の表記の前側）、`b` = side_b の順で書く。
   - 前半・第1セット・第1マップが市場に関係するときは、`periods` の `ht` / `set1` / `map1` も書く。スコアが分からず勝者だけ分かるときは `winners` を使う。
   - `result_confirmed_at`：結果が確定した時刻。公式の試合終了・結果発表の時刻が分かればそれを、分からなければ確認時刻（`verified_at`）を書く。`verified_at` より後にはできない。
   - 中止・延期・No result は、`status` を `cancelled` / `postponed` / `abandoned` にする。精算は無効（返金）になる。
5. **結果訂正**（すでに final の結果を別の値にするとき）は、`correction: { "reason": "…" }` が必須。
   - 理由がないと検査で拒否される。
   - 変更前の値・変更後の値・情報源・確認時刻は、自動で履歴に残る。
   - 無条件に上書きしない。
6. 確認できなかった試合は `changes` に入れない。`reviews` に `unknown`（確認できず）または `review_required`（同一性・時刻などが要確認）として、理由を書く。

更新回の形式：`run_id` は `mr-YYYY-MM-DD-HHMM-result-update`、`kind` は `result_update`、`at` は前回の run より後。

---

## □2 未確定カード更新

試合前のカードで、追記してよい情報だけを加える。

- **④ PRO EDGE**：締切オッズ（`kind: "closing"` のスナップショット）を、試合開始直前（開始時刻以前）に取得できた場合だけ追記する。取れなければ追記しない（CLV は未計算のまま）。
- **①②③**：`closing_odds`（締切オッズ）を取得できた場合だけ追記してよい。locked の事前値・判定・`odds_taken`・`stake` は変更しない。
- **VALUE① 条件付き**：試合開始前に条件成立を確認できたときだけ、`condition.met: true` と `checked_at`（開始前の時刻）を入れる。一度決めた `condition` は変更しない。

---

## □3〜□6 新規候補の独立探索（4回）

4系統を**この順番で1つずつ**行う。ある系統の探索中に、他の系統の候補・分析を参照しない。

### 4系統共通
- [ ] その系統専用の探索回を `discovery_runs` に1件追加する
  - `run_id`：`rec-…` / `v1-…` / `v2-…` / `pe-…` ＋日付と時刻（例 `v1-2026-09-27-0600`）
  - `slot`：`06:00` / `12:00` / `18:00` / `23:00`
- [ ] 各カードの `run_id` は、同じファイルのこの探索回を指す（他系統の run_id・`*-legacy-import` は使えない）
- [ ] 試合が matches.json に無ければ、次のとおり登録する
  - matches.json の `update_runs` に、その定時更新の更新回（kind: `result_update`）を1件追記する
  - 試合を追加し、`provenance` の最初の項目にその run_id を入れる
  - 試合の登録ルール：`id` は `YYYY-MM-DD-略称-略称`。`side_a` / `side_b` は表記順。`home_side` は記録で確認できるときだけ設定し、ほかは `unknown`。開始時刻は確認できたときだけ `start_at`＋`recorded`、食い違いは `review_required`＋`start_candidates`、仮時刻は入れない。試合事実に判定・推定・オッズ・選択は入れない
- [ ] `discovered_at` / `locked_at` / `bet_at` はタイムゾーン付き。`locked_at` は試合開始より前
- [ ] オッズは、一点の取得値だけを `odds_taken`（④は `bet_odds`）に入れる。レンジは `market_odds` の `min` / `max` に入れる
- [ ] 同じ系統の中で、同じ試合・市場・選択を重複して登録しない
- [ ] 市場（`market`）
  - 通常の勝者市場は `match_1x2`（選択側が勝たなければ負け）
  - 引分のない競技は `match_winner`
  - DNB は `dnb`、前半・第1セット・第1マップはそれぞれの市場
  - ダブルチャンス・勝ち抜け・延長込みは、`double_chance` / `to_qualify` / `winner_incl_extra_time`（自動精算しない）

### □3 ① 推奨取引（`data/recommendations.json`）
- [ ] 探索・分析・判定の方法は、現行の①のまま（変更しない）
- [ ] `stake: 100`（1件 $100）
- [ ] `locked`：`prob`（試合前に固定した事前確率がある場合のみ）・`gap_score`・`confidence`・`summary`
- [ ] 実際に投入した場合は `bet_at` を記録する（複利の正式化に必要）

### □4 ② VALUE①（`data/value1.json`）
- [ ] VALUE① の方法で独自に探索・分析する（③の値を写さない）
- [ ] `locked.verdict`：`formal` / `conditional` / `watch` / `excluded`
- [ ] formal / conditional は `stake: 100`、watch / excluded は `stake: null`
- [ ] conditional には `condition`（条件文・`min_odds`・`met: null`・`checked_at: null`）を入れる

### □5 ③ VALUE②（`data/value2.json`）
- [ ] VALUE② の方法で独自に探索・分析する（②の値を写さない）
- [ ] `locked.verdict`：`adopted` / `watch` / `excluded`。adopted は `stake: 100`
- [ ] 市場差（`market_gap_lo` / `hi`、単位 pt）と `upset_risk`

### □6 ④ PRO EDGE（`data/pro_edge.json`）— 下の「④ PRO EDGE 更新手順」に従う

---

## ④ PRO EDGE 更新手順（□2・□6）

**目的**：強い側を探すのではなく、市場適正確率と RMC 独自推定勝率のズレ（価格の歪み）を探す。①〜③で見つかっていない試合も、独自に探す。

1. **市場オッズの取得** → `price_snapshots` に追記する（既存のスナップショットは変更しない）
   ```json
   { "snapshot_id": "ps-<カード>-an-<社>", "kind": "analysis", "bookmaker": "BookA", "market": "match_winner",
     "outcomes": { "side_a": 2.10, "side_b": 1.75 }, "observed_at": "…+09:00", "source": "BookA 公開オッズページ" }
   ```
   - 始値が分かれば `kind: "opening"` も入れる。取得できないアウトカムがあるスナップショットは使わない（推測で埋めない）。
2. **控除除去（no-vig）→ market_probability**：画面が自動で計算する。
   - 1社なら `market_reference.method = "single_book"`、2社以上なら `"consensus"`。
   - `market_reference.snapshot_ids` に、使ったスナップショットを列挙する。
3. **base_probability**：競技モジュールの独自モデル（Elo / Rating＋ロジスティック回帰など）で推定する。
   - 市場確率のコピーは禁止。オッズ・市場確率を特徴量に入れない。
   - 使った特徴量は `features` に記録する（取得できないものは `status: "missing"`・`value: null`）。
   - `model.trained_through` は `locked_at` より前にする。
4. **expert_adjustment**：モデル外の情報（ロスター・怪我・欠場・Patch・天候・日程・移動など）は、`expert_adjustments` に1件ずつ書く（`adjustment_value`・`category`・`reason`・`source`・`created_at`）。
   - `base_probability` は上書きしない。
5. **final_probability ＝ base＋Σ補正**（0〜1 の範囲外は無効）
6. **edge ＝ final − market、fair_odds ＝ 1/final、EV ＝ final × 提示オッズ − 1、minimum_entry_odds ＝ (1＋required_EV)/final**：いずれも画面が自動計算する。
   - EV に使う提示価格は `offered_price.snapshot_id` で指定する。
   - `required_ev` は設定値（初期 0.03）を記録する。
7. **判定 `decision`**：
   - `accepted`（本成績。EV ≥ required_EV のときだけ）
   - `watch`（参考成績）
   - `rejected`（集計外）
   - accepted だけ `stake: 100`。
8. **固定**：`locked_at` を入れる（試合開始前）。以後、`locked` は変更しない。
9. **購入したとき**：実際の購入価格だけを `bet_odds`・`bet_bookmaker`・`bet_at` に入れる（一度入れたら変更しない）。
10. **締切**：試合開始直前の締切オッズを取れたら、`kind: "closing"` で追記する。すると画面が CLV を計算する。
    - 価格ベース CLV ＝ bet ÷ closing − 1
    - 確率ベース CLV ＝ 締切の no-vig 確率 − 1/bet
    - 締切が取れなければ CLV は未計算のまま。
11. **記録するもの**：データ信頼度（`data_confidence`）、主な価格差要因、RMC と市場が食い違う理由、情報不足の項目。

---

## □7 競技偏り監査

- GitHub Actions の監査レポート（`node scripts/audit-report.js`）で、系統ごとに直近20件の新規カードの競技の比率を確認する。
- 1競技が60%を超えていたら、その系統の次回探索で他競技も探す。
- ただし、判定基準は変えない。偏り解消のために、基準に満たないカードを入れない。
- 結果はコミットメッセージに1行で書く。

---

## □8 敗因分析

確定したカード（特に負け）について、その系統の `data/post-match-reviews/<系統>.json` に1件追記する。

```json
{ "pick_id": "v1-…", "created_at": "…+09:00", "update_run": "2026-09-27 06:00", "outcome": "loss",
  "category": "variance", "findings": "…", "missing_data": ["…"], "action": "none", "proposal": null }
```

- `category`：`variance`（想定内の外れ）/ `model_error` / `information_missing` / `late_news` / `market_moved` / `data_error` / `execution` / `other`
- 系統ごとに別ファイル。他系統のカードのレビューを書かない。
- **記録するだけ。** 判定基準・分析方法・locked の事前値は変更しない。改善案は `action: "propose_change"` と `proposal` に書き、人間の承認なしに適用しない。
- 1試合だけの結果でロジックを変えない。

---

## □9 損益・ROI・CLV 等の検証

- 監査レポートで、系統ごとに次が「整合OK」であることを確認する：戦績＝勝ち＋負け、純損益＝各カードの損益の合計、ROI＝純損益÷確定済み投入額、未確定件数。
- ④は、CLV を計算済みの件数と、締切オッズ未取得の件数を確認する。
- 複利は、次の「複利の順序規則」を満たすときだけ正式値になる。満たさないときは「参考値・取引順序未確定」と表示される（正常）。

### 複利の順序規則
正式値として採用する条件（すべて満たすとき、`bet_at` 順で計算する）：
1. 確定した全取引に `bet_at` があり、その試合に `result_confirmed_at` がある
2. `bet_at` の昇順で並べたとき、各取引の `bet_at` が、直前の取引の試合の `result_confirmed_at` 以降である（前の結果が確定してから次を投入）
3. `bet_at` が同時刻の取引がない

過去分（移行データ）は `bet_at` の記録がないため、正式値にしない。参考値（$114.80・$140.58）の順序を推測で決めない。

---

## □10 データ品質監査

監査レポートで、次の件数を確認し、減らせるものは次の更新で解消する（推測では埋めない）。
- 開始時刻の未確認・要確認
- オッズの未確認・レンジのみ
- 開始済みで結果未確認
- 条件成立の未確認
- 重複確認中、独立性要確認
- 結果更新の要確認

---

## □11 JSON 更新・Git commit

- 変更してよいファイル：`data/matches.json`（新しい試合の追加・update_runs の追記だけ）、`data/match-updates.json`、`data/recommendations.json`、`data/experience.json`、`data/value1.json`、`data/value2.json`、`data/pro_edge.json`、`data/post-match-reviews/*.json`
- 変更してはいけないファイル：上記以外のすべて（HTML・JS・`baseline/`・`snapshots/`・`schema/`・`lib/`・`data/legacy-*`）
- 1回の定時更新＝1コミット。メッセージの例：
  ```
  RMC定時更新 2026-09-27 06:00 JST
  結果更新 3件（要確認 2件）/ 新規: ①2 ②1 ③0 ④1 / 敗因分析 1件
  競技偏り: 問題なし / データ品質: 開始時刻未確認 2件
  ```

---

## □12 最新 commit SHA と公開RMCの確認

1. push した後のコミット SHA を記録する（GitHub のコミット一覧で確認）。
2. そのコミットの GitHub Actions「tests」が成功していることを確認する。
   - 失敗していたら原因を直すコミットを入れる。直せなければ、そのコミットを revert する。
3. 公開ページ `https://rokisinsa.github.io/RMC/analysis-v2.html` を開き、次を確認する（GitHub Pages の反映に数分かかる）。
   - エラー表示がない
   - 「データ時点」「試合事実の更新回」に今回の更新回が表示されている
   - 今回追加・確定したカードが表示されている
   - ①②③④・経験値の各セクションが表示されている
4. 確認結果（SHA・Actions の結果・公開ページの確認）を、最後の報告に書く。
