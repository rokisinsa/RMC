# RMC データ仕様（新構造 v1）

状態：**手順2（旧データの移行用下書き）まで作成済み。** `data/*.json` は `meta.status = "draft"` で、`analysis.html` はまだこの構造を使っていません。移行の詳細は `migration/README.md` を参照してください。

機械検証できる正式な定義は `schema/*.schema.json` にあり、スキーマで表せないルールは `lib/integrity.js` にあります。この文書はその説明です。

## 1. ファイル構成

| ファイル | 中身 | 分析判断 |
|---|---|---|
| `data/matches.json` | 客観的な試合事実（開始時刻・状態・最終スコア・前半/セット/マップのスコア・出典） | **入れない** |
| `data/recommendations.json` | 推奨取引の探索回とカード | 入れる |
| `data/experience.json` | 経験値取引（実際に投入した取引） | 入れる |
| `data/value1.json` | VALUE①の探索回とカード（除外ログ含む） | 入れる |
| `data/value2.json` | VALUE②の探索回とカード（除外ログ含む） | 入れる |
| `data/pro_edge.json` | ④ PRO EDGE｜プロ型価格分析（市場価格と独自推定のズレ）。詳細は `docs/pro-edge-spec.md` | 入れる |
| `data/match-updates.json` | 移行基準点より後の試合事実の更新ログ（追記のみ）。matches.json に順に重ねたものが実効の試合事実。確認できない結果は reviews に要確認として残す | **入れない** |
| `data/legacy-analysis/<系統>.json` | 旧RMCの分析本文（原文と構造化）。推奨・VALUE①・VALUE②のそれぞれの系統に所属し、系統間で共有しない | 入れる（旧データの原文） |
| `data/legacy-unassigned.json` | どの系統のものか確定できない旧データ（`system_assignment: "unknown"`）。成績には使わない | — |

## 2. 4分析系統の独立

- 新規候補探索は **①推奨・②VALUE①・③VALUE②・④PRO EDGE の4回をそれぞれ独立** に行う。各ファイルの `discovery_runs` に、その系統自身の探索回だけを記録する。
- `run_id` の先頭は `rec-` / `v1-` / `v2-` / `pe-`。カードの `run_id` は同じファイル内の探索回だけを参照できる。
- カードIDの先頭は `rec-` / `exp-` / `v1-` / `v2-` / `pe-` で、全系統を通して一意にする。
- 分析ID `analysis_id`（`pe-an-`）は ④ PRO EDGE だけの追跡項目で、④のカードには必須（`ANALYSIS_ID_MISSING` / `ANALYSIS_ID_PREFIX`）。①推奨・②VALUE①・③VALUE②には適用しない（④の追加を理由に①②③を変更しない）。
- 他系統のカードIDや `run_id` を、どの項目の値としても参照してはいけない（`CROSS_SYSTEM_REFERENCE`）。
- 共通候補を1回取得して3系統へ振り分ける構造は禁止。共通の探索回を置くと、`RUN_ID_PREFIX` と `ID_COLLISION` で検出される。
- 共有してよいのは `matches.json` の試合事実だけ。複数系統が同じ `match_id` を参照するのは正常。
- 別系統で同じ試合・同じ選択の事前分析（分析文または推定勝率レンジ）が完全に一致した場合は、流用の疑いとして warning を出す（`POSSIBLY_SHARED_ANALYSIS`）。
- 経験値取引は候補探索系統ではないので、`discovery_runs` を持たず `run_id` は `null`。

## 3. カード（pick）の共通項目

| 項目 | 意味 |
|---|---|
| `match_id` | `matches.json` の試合 |
| `market` | `match_winner` / `match_1x2`（通常の勝者市場。選択側が勝たなければ負け） / `dnb` / `first_half_1x2` / `set1_winner` / `map1_winner` / `double_chance` / `to_qualify` / `winner_incl_extra_time` / `other`。後ろの4つは現時点で自動精算しない |
| `selection` | `side_a` / `side_b` / `draw`（試合の表記「A vs B」の A・B。ホーム/アウェーは意味しない。`selection_label` は表示用） |
| `market_odds` | 確認できた市場オッズ。`{text, min, max, observed_at, source}`。**レンジのまま保持し、精算には使わない** |
| `odds_taken` | 実際に取得したオッズ（一点）。不明なら `null`。**勝手にレンジから一点へ固定しない** |
| `stake` | 投入額。監視カードなど実投入しないものは `null` |
| `discovered_at` | その系統の探索で見つけた時刻 |
| `bet_at` | 実際に投入した時刻 |
| `locked_at` | 事前分析を固定した時刻 |
| `live` | 試合開始後の取引なら `true`（`bet_at` 必須） |
| `locked` | 事前分析（系統ごとに項目が違う。VALUE①②は `verdict` 必須） |
| `condition` | VALUE①の条件付きVALUEだけ：`{text, min_odds, met, checked_at}` |
| `closing_odds` | 試合後に追記してよい |
| `recalculated_reference` | 後から別モデルで再計算した**参考値**（事前確率ではない）。**追記のみ** |
| `settlement_override` | 自動判定できない場合だけ使う明示的な精算：`{state: win/loss/push/void, reason, set_at, source}` |
| `flags` | `duplicate_review` / `needs_review` / `legacy_import` / `time_unverified` / `odds_unverified` / `result_unverified` / `lock_unverified` / `analysis_independence_review`（別系統と分析値が一致し、独立分析と断定できない） |
| `legacy` | 旧 analysis.html から移行したカードの出典：`{source, commit, table, row_index, detail_id, data_ts, sort_at, first_seen_at, first_seen_commit, lock_evidence, raw}`。`legacy_import` フラグと必ず対にする。`raw` は旧表示の原文で、計算には使わない |

### 事前値（locked）と確認状態

- **推定確率・EV**（`prob` / `prob_lo` / `prob_hi` / `prob_point` / `ev_lo` / `ev_hi` / `market_gap_lo` / `market_gap_hi`）を持てるのは `locked_at` があるカードだけ（`ESTIMATE_WITHOUT_LOCK`）。
- 過去カードの事前確率は、次の優先順で決める。
  1. 試合開始前に保存されたことを確認できる locked 値
  2. 試合開始前から HTML に保存されていたことを Git 履歴で確認できる値
  3. どちらも確認できなければ null
- 確認できない旧データは `locked_at = null` と `lock_unverified` にする。旧値は `legacy.raw.data_locked_prob_unverified` などの原文として残す。
- 現行モデルで再計算した確率は `recalculated_reference` にだけ置く。

試合開始時刻 `start_at` は `matches.json` 側にある。**日時はすべてタイムゾーン付きISO 8601**（例：`2026-09-26T21:00:00+09:00`）で、オフセットのない値はスキーマ違反になる。

`matches.json` の試合事実に関するルール：

- 両チームは `side_a` / `side_b`（表記順）で持ち、スコアも `{a, b}` で持つ。ホームがどちらかは `home_side`（`side_a` / `side_b` / `neutral` / `unknown`）に分けて持ち、記録で確認できない場合は `unknown` にする。
- 開始時刻の候補が食い違う場合は `start_time_status: "review_required"`、`start_at: null` とし、候補を `start_candidates` に入れる。事前固定の判定は、最も早い候補より前であることを条件にする。
- 試合事実の変更は、すべて `update_runs`（`baseline_migration` → `human_review` / `result_update`）の更新回として、各試合の `provenance` に `before` / `after` 付きで追記する。移行基準点の値を後から書き換えない（`MATCH_CHANGE_UNRECORDED`）。

- `start_time_status` は `recorded` / `review_required` / `unverified` / `unknown` のいずれか。`start_at` を持てるのは `recorded` のときだけ（`START_STATUS_MISMATCH`）。仮時刻や未確認の候補は、`start_at` ではなく `start_time_note` に書く。
- `status` の `unknown` は、開始時刻を過ぎた（または開始時刻不明の）まま結果が記録されていない状態を表す。
- `result.winners` は、スコアが残っておらず勝者だけ分かる場合（例：第1セット勝利・スコア未確認）に使う。スコアと矛盾すると error（`WINNER_SCORE_CONFLICT`）。

払戻し・純損益・結果記号（○×△）は**保存しない**。スキーマでも保存を禁止している。

## 4. 精算（`lib/settlement.js`）

| 状態 | 条件 | 払戻し | 純損益 | 勝敗 |
|---|---|---|---|---|
| `win` | 選択側の勝ち | `stake × odds_taken`（`odds_taken` が無ければ未計算） | 払戻し − stake | 勝ち |
| `loss` | 選択側の負け | 0 | −stake（オッズ不要） | 負け |
| `push` | DNBの引分など | stake | 0 | 数えない |
| `void` | 中止・延期・没収 | stake | 0 | 数えない |
| `pending` | 試合前・進行中・スコア未入力 | — | — | 数えない |

- 対象の期間：`first_half_1x2` は `periods.ht`、`set1_winner` は `periods.set1`、`map1_winner` は `periods.map1` を使う。
- `match_1x2` の引分は、home/away を選んでいれば負け。
- `match_winner` で同点スコアになった場合は自動判定せず、pending（要確認）にする。
- 金額はセント単位に丸める（`113.99999999999999` のような誤差は出さない）。

## 5. 集計（`lib/summary.js`）

- **戦績・勝率**：win/loss のみを数える。
- **確定済み投入額**：金額を計算できた win/loss の stake 合計。
- **総投入予定額**：登録された全カードの stake 合計（pending・push・void を含む）。
- **ROI** ＝ 確定済み純損益 ÷ 確定済み投入額 × 100。未確定は含めない。確定が0件なら `null`。
- **未確定の予想損益**：`odds_taken` がある pending だけを合算する。オッズ不明のカードは**未計算件数**として別に数え、−$100 としては扱わない。
- **的中なのに `odds_taken` が無いカード**：損益と ROI から除外し、`amountMissing` の件数で知らせる。
- **複利**：現行ルールと同じ。元金$100で始め、2倍に届いたら利益をストックして元金に戻す。負けたら失敗として元金から再開。push/void では資金は動かない。
- **1/4ケリー**：**locked の事前確率だけ**を使う。現行モデルでの再計算値は使わない。
- **最大連敗**：試合開始時刻の順に数える。

## 6. 本成績と参考成績（`lib/buckets.js`）

| 系統 | 本成績（official） | 参考成績（reference：$100仮定） | 集計外 |
|---|---|---|---|
| 推奨取引・経験値取引 | 全件 | — | — |
| VALUE① | `formal`、および `conditional` のうち `condition.met=true` かつ `checked_at ≤ 試合開始` のもの | `watch` | `conditional` の未成立・未確認・開始後確認、`excluded` |
| VALUE② | `adopted` | `watch` | `excluded` |

判定内訳（正式 n 件・監視 n 件…）はデータから数える。手書きはしない。

## 7. 事前分析の固定（locked）

- `locked_at` のあるカードは、次の項目を変更できない：`system` / `match_id` / `market` / `selection` / `market_odds` / `odds_taken` / `stake` / `discovered_at` / `run_id` / `locked_at` / `locked` / `live`。`bet_at` を記録済みならそれも変更不可。
- locked 済みのカードは削除できない。
- `recalculated_reference` は追記のみ。一度決めた `condition` も変更できない。
- `closing_odds`、`settlement_override`、`flags`、`note` の試合後追記は許可する。
- `scripts/check-locked.js <基準コミット>` が、直前の data と比べて違反を検出する（GitHub Actions でも実行する）。

## 8. 整合性チェック一覧（`lib/integrity.js`）

| 種類 | コード | 重さ |
|---|---|---|
| 重複 | `DUPLICATE_UNFLAGGED` / `DUPLICATE_UNDER_REVIEW`（`duplicate_review` 付きなら削除せず warning） | error / warning |
| 独立性 | `SYSTEM_MISMATCH` `ID_PREFIX` `RUN_ID_PREFIX` `RUN_ID_MISSING` `RUN_ID_UNKNOWN` `RUN_ID_NOT_ALLOWED` `ID_COLLISION` `CROSS_SYSTEM_REFERENCE` `MATCH_HAS_ANALYSIS` | error |
| 独立性 | `POSSIBLY_SHARED_ANALYSIS` | warning |
| 参照 | `MATCH_UNKNOWN` `MATCH_ID_DUPLICATE` | error |
| 時刻 | `TIME_DISCOVERED_AFTER_LOCK` `TIME_LOCKED_AFTER_START` `TIME_BET_AFTER_START` `TIME_LIVE_WITHOUT_BET_AT` | error |
| 時刻 | `TIME_DISCOVERED_BEFORE_RUN` `LOCKED_AT_WITHOUT_LOCKED` | warning |
| オッズ | `ODDS_RANGE_INVERTED` `ODDS_TAKEN_WITHOUT_TIME` | error |
| オッズ | `ODDS_RANGE_UNPARSED` `ODDS_TAKEN_FROM_RANGE` | warning |
| 条件付き | `CONDITION_NOT_ALLOWED` `CONDITION_MISSING` `CONDITION_UNCHECKED` | error |
| 条件付き | `CONDITION_CHECKED_AFTER_START` | warning |
| locked | `LOCKED_FIELD_CHANGED` `LOCKED_PICK_DELETED` `RECALCULATED_REFERENCE_REWRITTEN` `CONDITION_CHANGED` `LEGACY_RECORD_CHANGED`（旧データ由来のカードは `locked_at` が無くても保護） | error |
| 事前値 | `ESTIMATE_WITHOUT_LOCK` `LOCK_UNVERIFIED_UNFLAGGED` `LEGACY_FLAG_MISMATCH` | error |
| 試合事実 | `START_STATUS_MISMATCH` `START_CANDIDATES_MISSING` `START_CANDIDATES_NOT_ALLOWED` `FINAL_WITHOUT_RESULT` `WINNER_SCORE_CONFLICT` `PROVENANCE_RUN_UNKNOWN` `PROVENANCE_BASELINE_MISSING` `PROVENANCE_ORDER` | error |
| 試合事実の履歴 | `MATCH_DELETED` `PROVENANCE_REWRITTEN` `MATCH_CHANGE_UNRECORDED`（`check-locked.js` で前バージョンと比較） | error |
| 独立性 | `NEW_PICK_ON_LEGACY_RUN`：新規カードは移行用の探索回を使えず、その系統自身の独立した探索回 `run_id` が必要 | error |
| 旧データ | `ODDS_TAKEN_WITHOUT_TIME` と `TIME_LIVE_WITHOUT_BET_AT` は、`legacy_import` の場合だけ warning（記録が無いものを推測で埋めないため） | warning |

## 9. コマンド

外部依存はなく、Node.js 22 以上で動く。

```
npm test                              # 全テスト
node scripts/validate-data.js         # data/*.json の検証（未作成ならスキップ）
node scripts/check-locked.js HEAD~1   # locked 保護と試合事実の履歴（基準コミットと比較。下書き（draft）の版は比較しない）
node baseline/capture-baseline.js     # baseline の再取得（基準タグから）
```
