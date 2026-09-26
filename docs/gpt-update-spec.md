# GPT 定時更新 新仕様書（新RMC切替後に適用）

状態：**案（未適用）**。今の ChatGPT 定時タスクは変更していません。本番切替の承認後に、この仕様へ差し替えます。

対象の時刻：毎日 06:00・12:00・18:00・23:00（JST）

---

## 0. 絶対ルール

1. **`analysis.html` / `analysis.js` / `index.html` に数値やカードを直接書き込まない。** 更新するのは `data/` 配下の JSON ファイルだけです。
2. **払戻し・純損益・戦績・勝率・ROI・投入総額・未確定件数・判定内訳・複利・ケリーなどの導出値は書き込まない。** 画面がデータから自動計算します。スキーマ上も保存できません。
3. **候補探索は4系統で完全に独立して、4回行う。**
   - ① 推奨取引・② VALUE①・③ VALUE②・④ PRO EDGE は、それぞれ別々に探索・分析・判定する。
   - 1つの共通候補リストを作って①〜④へ振り分けることは禁止。
   - 他系統の候補・分析値・推定勝率・判定をコピーしない。
   - ④の追加や改善を理由に、①②③の探索条件・分析方法・判定基準を変えない。
4. **推測しない。** 確認できない開始時刻・オッズ・結果・スコアは null（または要確認）のまま残します。オッズのレンジ（例 1.17〜1.20）を一点に固定しません。
5. **試合前に固定した事前値（locked）は、試合開始後に書き換えない。** 再計算した値は `recalculated_reference` へ追記します。
6. **既存データを削除しない。** 重複6組（duplicate_review）も統合・削除しません。
7. **基準点（`baseline/2026-09-26`）と `data/matches.json` の既存の試合事実は書き換えない。** 試合結果は `data/match-updates.json` に追記します。

---

## 1. 更新の流れ（毎回この順番）

| # | 作業 | 更新するファイル |
|---|---|---|
| 1 | 最新の `main` を取得し、テストが通ることを確認する（`npm test`） | — |
| 2 | 結果更新：前回以降に終わった試合の結果を確認して追記する | `data/match-updates.json` |
| 3 | 試合前カードの情報更新（締切オッズ・CLV の材料など。追記のみ） | 各系統のファイル |
| 4 | ① 推奨取引の新規候補探索（①専用の探索回） | `data/matches.json`（新しい試合の事実）、`data/recommendations.json` |
| 5 | ② VALUE① の新規候補探索（②専用の探索回） | `data/matches.json`、`data/value1.json` |
| 6 | ③ VALUE② の新規候補探索（③専用の探索回） | `data/matches.json`、`data/value2.json` |
| 7 | ④ PRO EDGE の新規候補探索（④専用の探索回） | `data/matches.json`、`data/pro_edge.json` |
| 8 | 検証：`node scripts/validate-data.js` と `node scripts/check-locked.js HEAD` がどちらもエラー0件 | — |
| 9 | コミット（1回の定時更新＝1コミット。メッセージに時刻と各系統の件数を書く） | — |

- 8 でエラーが出たら、コミットせずに原因を直すか、変更を取り消します。
- 4〜7 は順番に行いますが、**前の系統の候補や分析結果を次の系統に渡してはいけません。**

---

## 2. 結果更新（`data/match-updates.json`）

更新1回につき、`runs` に1件を追記します。既存の run は変更も削除もしません（追記のみ）。

```json
{
  "run_id": "mr-2026-09-27-0600-result-update",
  "kind": "result_update",
  "at": "2026-09-27T06:05:00+09:00",
  "source": "GPT定時更新 06:00",
  "note": null,
  "changes": [
    {
      "match_id": "2026-09-26-ge-vit",
      "set": { "status": "final", "result": { "final": { "a": 0, "b": 2 }, "text": "Global Esports 0-2 Team Vitality" } },
      "evidence": {
        "sources": [{ "name": "VLR.gg 試合ページ", "url": "https://..." }],
        "verified_at": "2026-09-27T06:03:00+09:00",
        "note": null
      }
    }
  ],
  "reviews": [
    { "match_id": "2026-09-26-kor-vie", "status": "unknown", "note": "公式結果を確認できず" }
  ]
}
```

**チェックリスト**

- [ ] `run_id` は `mr-YYYY-MM-DD-HHMM-…` の形式で、既存と重複していない
- [ ] `at` は前回の run より後
- [ ] `changes` に入れるのは、**信頼できる情報源で確認できた結果だけ**。情報源の名前と URL を `evidence.sources` に必ず書く
  - 優先順：大会・競技団体の公式 → 公式データ提供元（ATP / WTA / ITF、HLTV、VLR.gg、ESPNcricinfo など） → 大手報道
  - 情報源が1件だけのときは、`evidence.note` にその旨を書く
- [ ] `set` に入れてよい項目は `status`・`result`・`start_at`・`start_time_status`・`start_candidates`・`start_time_note` だけ。判定・推定・オッズ・選択は入れない
- [ ] `result.final` / `periods` のスコアは side_a / side_b の順（matches.json の表記順）。前半・第1セット・第1マップが市場に関わる場合は `periods` の `ht` / `set1` / `map1` も入れる
  - スコアが分からず勝者だけ分かる場合は `winners` を使う
- [ ] 中止・延期・No result は、`status` を `cancelled` / `postponed` / `abandoned` にする（精算は無効＝返金）
- [ ] 確認できなかった試合は `changes` に入れず、`reviews` に `unknown` または `review_required` として理由つきで書く
- [ ] 相手選手の名前の表記揺れなどで同じ試合か断定できない場合も、`review_required` にする

---

## 3. 新しい試合の事実（`data/matches.json`）

新しい候補の試合がまだ matches.json に無い場合だけ、試合を追加します。既存の試合は変更しません（変更は match-updates で行う）。

- [ ] `id` は `YYYY-MM-DD-略称-略称`（開始日は JST）
- [ ] `side_a` / `side_b` は表記順。ホームが記録で確認できる場合だけ `home_side` を設定し、分からなければ `unknown`
- [ ] 開始時刻を確認できた場合だけ `start_at`（タイムゾーン付き）と `start_time_status: "recorded"` を入れる
  - 候補が食い違う場合は `review_required` とし、候補を `start_candidates` に入れる
  - 未確認なら `unverified` / `unknown` で、`start_at` は null。仮時刻（00:00 など）は入れない
- [ ] `status: "scheduled"`、`result: null`
- [ ] matches.json の `update_runs` にその定時更新の更新回（kind: `result_update`、run_id `mr-…`）を1件追記し、追加した試合の `provenance` の最初の項目にその run_id を入れる
- [ ] 分析判断（判定・推定勝率・EV・オッズ・選択）は入れない

---

## 4. 系統ごとの新規候補

### 共通（①②③④）
- [ ] その系統専用の探索回を `discovery_runs` に1件追加する
  - 形式：`rec-` / `v1-` / `v2-` / `pe-` ＋ 日付と時刻
  - `slot` は `06:00` / `12:00` / `18:00` / `23:00`
- [ ] 各カードの `run_id` は、同じファイルのこの探索回を指す（他系統の run_id・移行用の `*-legacy-import` は使わない）
- [ ] `discovered_at`・`locked_at` はタイムゾーン付き。`locked_at` は試合開始より前
- [ ] 事前分析（`locked`）は試合開始前に固定する。固定後は変更しない
- [ ] 取得オッズは一点の値だけを `odds_taken`（④は `bet_odds`）に入れる。レンジは `market_odds` の min / max
- [ ] 同じ系統の中で、同じ試合・市場・選択を重ねて登録しない
- [ ] 旧データ（`legacy_import`）のカードを変更・削除しない

### ① 推奨取引（`data/recommendations.json`）
- [ ] 投入額は1件 $100（`stake: 100`）
- [ ] 探索・分析・判定の方法は、現行の①のまま（変更しない）
- [ ] `locked`：`prob`（試合前に固定した事前確率がある場合のみ）・`gap_score`・`confidence`・`summary`

### ② VALUE①（`data/value1.json`）
- [ ] `locked.verdict`：`formal`（正式）/ `conditional`（条件付き）/ `watch`（監視）/ `excluded`
- [ ] formal / conditional は `stake: 100`、watch / excluded は `stake: null`
- [ ] conditional は `condition`（条件文・最低オッズ）を必ず入れる
  - 試合開始前に条件成立を確認できたときだけ `met: true` と `checked_at`（開始前の時刻）を入れる
  - 確認できなければ `met: null` のまま（本成績に入らない）
- [ ] VALUE② と同じ試合を扱う場合も、VALUE① 独自の分析で推定する（②の値を写さない）

### ③ VALUE②（`data/value2.json`）
- [ ] `locked.verdict`：`adopted`（採用）/ `watch`（監視）/ `excluded`
- [ ] adopted は `stake: 100`、watch / excluded は `stake: null`
- [ ] 市場差（`market_gap_lo` / `hi`、単位 pt）と `upset_risk` を入れる
- [ ] VALUE① の値を写さない

### ④ PRO EDGE（`data/pro_edge.json`）
- [ ] `analysis_id`（`pe-an-…`）を付ける
- [ ] 価格は `price_snapshots` に、ブックメーカー・取得時刻・出典つきで追記する（opening / analysis / closing）。既存のスナップショットは変更しない
- [ ] `locked` に次を入れる
  - `market_reference`（1社なら single_book、2社以上なら consensus）
  - `offered_price`
  - `model`（`trained_through` は locked_at より前）
  - `base_probability`（市場確率のコピー禁止）
  - `expert_adjustments`（理由・出典・日時）
  - `features`（取得できないものは missing）
  - `data_confidence`、`required_ev`（設定値 0.03）
  - `decision`：accepted / watch / rejected
- [ ] accepted だけ `stake: 100`。EV が required_EV 未満なら accepted にしない
- [ ] 実際に買った場合だけ、`bet_odds` と `bet_at` を入れる（一度入れたら変更しない）
- [ ] 試合開始直前の締切オッズを取れた場合だけ、kind:"closing" のスナップショットを追記する（取れなければ CLV は未計算のまま）

---

## 5. 経験値取引（`data/experience.json`）

- [ ] 実際に投入したものだけを登録する（分析系統ではない）
- [ ] `stake` は実際の投入額、`odds_taken` は実際の取得オッズ
- [ ] 結果は match-updates で更新する（カードの損益は書かない）

---

## 6. コミット前の確認（すべて満たすまでコミットしない）

- [ ] `node scripts/validate-data.js` → error 0件
- [ ] `node scripts/check-locked.js HEAD` → 違反0件（locked の事前値・価格スナップショット・結果更新ログ・試合事実の履歴の書き換えがない）
- [ ] `npm test` → すべて通過
- [ ] `analysis.html` / `analysis.js` / `index.html` に差分がない
- [ ] 4系統それぞれの探索回が別々にあり、他系統の run_id・分析値を参照していない
- [ ] 導出値（払戻し・損益・戦績・勝率・ROI・件数）をどこにも書いていない
