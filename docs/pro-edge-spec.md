# ④ PRO EDGE｜プロ型価格分析 仕様

状態：手順2の設計への追加として、データ構造・スキーマ・計算エンジン・検証・テストを作成済みです。**④は①推奨・②VALUE①・③VALUE②の外側にある第4の独立エンジンで、①②③の候補探索・分析・判定・データ・集計・表示は一切変更しません。**④を改善するために①②③を変えることはせず、①②③の改善案は別件の候補として報告だけにします。画面（手順3）はまだ実装していません。`data/pro_edge.json` は空の下書きで、架空のサンプルはテスト用フィクスチャにだけあります。

## 1. 目的と位置付け

- 「強いチーム・選手を探す」系統ではありません。**市場価格と RMC 独自推定勝率のズレ**を探します。
  - 格差が小さくても、価格の歪みが大きければ候補になります。
  - 圧倒的な格差があっても、価格が適正か期待値が足りなければ採用しません（サンプル pe-s4 がその例）。
- 公開されている「プロ型の価格分析・市場効率分析」の一般的な考え方を参考にした、RMC 独自の設計です。特定人物の非公開モデルを再現したものではありません。
- 追加課金が必要な API や有料データは使いません（8章）。

## 2. 独立性（①推奨・②VALUE①・③VALUE②・④PRO EDGE）

- **探索の独立**：候補探索は4系統がそれぞれ独立して行います。共通の候補プールを作って振り分ける構造は禁止です。④は、①〜③が見つけていない試合も独自に探します。
- **独自の識別子**：④のカードは `system: "pro_edge"`、④自身の `run_id`（`pe-`）、`analysis_id`（`pe-an-`、④だけに必須）、`discovered_at`、`locked_at` を持ちます。①②③は④追加前の構造のままで、分析IDの必須化などの変更は加えていません。

- **流用の禁止**：④が①②③の探索回・カードIDを参照すると error です。④の分析IDは `pe-an-` で始める必要があります。
- **同じ試合は可**：同じ試合を複数の系統が扱うことはできます。共有するのは `matches.json` の客観的事実（開始時刻・結果・スコア）だけです。
- **流用の疑い**：④の `base_probability` が、同じ試合・選択について他系統の推定値と完全に一致した場合は warning（`POSSIBLY_SHARED_ANALYSIS`）を出します。

## 3. データ構造（`data/pro_edge.json`、スキーマ `schema/pro_edge.schema.json`）

保存するのは入力値だけです。市場確率・edge・EV・fair odds・最低購入オッズ・CLV は `lib/pro-edge/` で毎回計算します（スキーマ上も保存できません）。

| 項目 | 内容 |
|---|---|
| `id` / `system` / `match_id` / `run_id` / `analysis_id` | ④自身の識別子。競技・国・リーグ・開始日時は `matches.json` から引く |
| `market` / `selection` | market_type と選択側（`side_a` / `side_b` / `draw`） |
| `discovered_at` / `locked_at` / `bet_at` | 発見・事前固定・購入の時刻（すべてタイムゾーン付き） |
| `price_snapshots[]` | ブックメーカーの元オッズ（控除込み）。`kind`：opening=始値 / analysis=分析時点 / closing=締切。取得時刻と出典つき。**追記のみ** |
| `bet_odds` / `bet_bookmaker` | 実際の購入価格。無ければ null。**一度入れたら変更不可** |
| `stake` | accepted だけが持つ。watch / rejected は null |
| `locked.decision` | `accepted`（本成績）/ `watch`（参考成績）/ `rejected`（集計外） |
| `locked.required_ev` | 判断時点の必要EV（設定値をカードごとに固定） |
| `locked.market_reference` | 市場確率に使ったスナップショットと方法（`single_book` / `consensus`） |
| `locked.offered_price` | EV に使った提示価格のスナップショット |
| `locked.model` | model_id・版・競技モジュール・手法・学習データの終端（`trained_through`） |
| `locked.base_probability` | 独自モデルの推定（0 < p < 1） |
| `locked.expert_adjustments[]` | モデル外の補正：`adjustment_value`・`category`・`reason`・`source`・`created_at` |
| `locked.features[]` | 使った特徴量：`name`・`status`（present / missing）・`value`・`observed_at`・`source` |
| `locked.data_confidence` | `high` / `medium` / `low` |
| `locked.price_gap_factors` / `disagreement_reasons` / `missing_information` | 主な価格差要因、RMC と市場が食い違う理由、情報不足の項目 |
| `recalculated_reference[]` | 後から別モデルで再計算した参考値（locked とは別の項目） |

`locked` は試合前に固定し、以後は変更できません（`check-locked.js` で検査します）。

## 4. 計算式

### 市場確率（no-vig）

- **2-way**：`qA = 1/oddsA`、`qB = 1/oddsB`、`pA = qA/(qA+qB)`、`pB = qB/(qA+qB)`
- **3-way**：各アウトカムの `1/odds` を、その合計で割って正規化します。
- **overround**：`Σ 1/odds` です。1 未満（裁定取引の状態、古い価格の疑い）や 1.25 超は異常として warning を出し、その価格からは市場確率を作りません。
- **consensus**：2社以上の異なるブックメーカーがある場合だけ、各社の no-vig 確率を平均して作ります。1社だけなら `single_book` とし、consensus は作りません。

### 推定勝率と価格

| 項目 | 式 |
|---|---|
| final_probability | `base_probability + Σ adjustment_value`（0 < final < 1 でなければ無効。base は上書きしない） |
| edge | `final_probability − market_probability`（単位は pt） |
| fair_odds | `1 / final_probability` |
| EV | `final_probability × offered_odds − 1`（offered は `locked.offered_price` の価格） |
| EV_at_bet | `final_probability × bet_odds − 1` |
| minimum_entry_odds | `(1 + required_EV) / final_probability`（required_EV の初期値 0.03 は `config/pro-edge.config.json` で変更可能） |

**追跡性**：edge に使った市場価格（`market_sources`：ブックメーカー・取得時刻・出典）と、EV に使った提示価格（`offered_source`）を、それぞれ別々に返します。

**独自モデルの条件**：

- `base_probability` が市場確率と同一の場合は error です（`MODEL_COPIES_MARKET`）。
- オッズや市場確率など、市場由来の特徴量をモデルに入れると error です（`MARKET_FEATURE_IN_MODEL`）。

## 5. CLV（Closing Line Value）

| 指標 | 式 | ＋の意味 | −の意味 |
|---|---|---|---|
| 価格ベースCLV `clv_price` | `bet_odds / closing_odds − 1` | 締切より良い価格で買えた（例：2.10 で購入・締切 2.00 → +5.0%） | 締切より悪い価格で買った |
| 確率ベースCLV `clv_probability` | `closing_no_vig_probability − 1 / bet_odds` | 締切時点の市場適正勝率が、購入価格の要求する勝率を上回った（締切ラインに対して期待値プラス） | 下回った |
| 締切ベースEV `closing_ev` | `bet_odds × closing_no_vig_probability − 1` | `clv_probability` と同じ符号 | — |

- **締切オッズがない場合**：CLV は未計算（null、`status: no_closing_odds`）とします。
- **締切オッズが片側だけの場合**：控除を除けないため、確率ベースCLV は計算しません（`closing_not_devigable`）。
- 推測で値を補うことはしません。
- 価格CLVがプラスでも、確率CLVがマイナスになることはあります（サンプル pe-s2）。そのため両方を別々に持ちます。

## 6. 評価（`lib/pro-edge/evaluate.js`）

- **母集団**：
  - 本成績 = accepted。実際の `bet_odds` で精算し、`bet_odds` がなければ金額は未計算です。
  - 参考成績 = watch。「仮に$100を判断時の提示価格で投入した場合」で計算します。
  - rejected は集計しません。
- **指標**：
  - ROI（確定純損益 ÷ 確定投入額。push / void は除外）
  - Hit Rate
  - Average EV（判断時・購入時）
  - Average / Median CLV（価格・確率。それぞれ件数を別に表示）
  - Brier Score
  - Log Loss
  - Calibration
- **期間**：直近20・直近50・直近100・全期間です。試合開始順に並べてから切り出すため、入力の順序には依存しません。
- **サンプル不足の扱い**：
  - N件に満たない期間は値を出さず、`status: insufficient_sample` と `sample_size` を返します。
  - 全期間は最低20件です（設定で変更可能）。
  - Calibration は全体で100件未満なら全帯を非表示にします。帯ごとに10件未満の帯も非表示です。少ない件数で精度があるように見せないためです。

## 7. モデルと未来データリークの防止

- **競技モジュール**（`lib/pro-edge/sports.js`）：
  - 共通の特徴量：Rating / Ranking、H2H 全件、直近6試合、勝敗、平均得失点、ホーム／アウェー／中立地、当日メンバー、欠場、選手変更、休養日、連戦、大会状況、対戦相性。
  - 競技固有の特徴量：テニス（surface、serve / return）、サッカー（lineup、xG、日程）、バスケットボール（rotation、pace）、野球（先発投手）、バレー（SET 特性）、eSports（Veto、map pool、side、roster、Patch）など。
  - 取得できない特徴量は `missing`（value は null）とし、推測で埋めません。
- **初期モデル**（`lib/pro-edge/models.js`）：解釈しやすさを優先し、Elo と ロジスティック回帰にしました。外部ライブラリは使わず、同じ入力なら必ず同じ結果になります。
- **未来データリークの禁止**：
  - 特徴量・Expert補正・学習データの終端・市場価格の取得時刻は、いずれも `locked_at` 以前かつ試合開始より前でなければなりません（`FUTURE_DATA_LEAK`）。
  - 締切オッズを、事前の市場確率や EV に使うことはできません（`CLOSING_USED_PRE_MATCH`）。
  - Elo は、予測時点より前に開始した試合だけを使います。
- **時系列分割**（`lib/pro-edge/backtest.js`）：必ず「学習 → 検証 → テスト」の時間順で分け、分割結果の順序も検査します。ランダムシャッフルによる評価は使いません。

## 8. データの入手

**追加課金なしで使うもの**

- 公開Webのオッズ表示（ブックメーカーやオッズ比較サイトの公開ページ）。定時更新の際に GPT が取得し、スナップショットとして保存します。
- 公式サイト・公式SNSの情報：日程、結果、スコア、ロスター、欠場、当日メンバー。
- 公開ランキング・レーティング：FIFA、FIVB、ATP / WTA、HLTV / VRS など。
- 公開の試合記録：H2H、直近成績、得失点、SET / MAP の結果。
- 既存の RMC データ（`matches.json` など）と、ローカルでの計算。

**現状では取得できない、または取得が不安定なもの**（missing として扱います）

- 締切オッズの確実な記録：試合開始直前に取得できた場合だけ記録します。取得できなければ CLV は未計算です。
- 複数社の同時刻オッズ：取得できた社の数に応じて single_book になります。
- 有料データ：xG の詳細、選手トラッキング、ベッティング取引所の出来高、オッズ履歴 API など。
- 当日ロスターや Veto の確定前の値：確定後に取得できた時刻で記録します。
- 過去オッズの網羅的な履歴。このためバックテストは、蓄積した自前のスナップショットの範囲だけで行います。

## 9. 手順3で実装する④の画面構成（設計のみ）

1. **サマリー**：本成績（accepted）と参考成績（watch）を分けて表示します。
   - 表示する項目：ROI、Hit Rate、Average EV、Average / Median CLV（価格・確率）、Brier、Log Loss。
   - 直近20 / 50 / 100 / 全期間の切り替えを付けます。
   - サンプル不足のときは値の代わりに「サンプル不足（n=○件）」と表示します。
2. **判定内訳**：accepted / watch / rejected の件数（データから集計）。
3. **カード一覧（1行1カード）**：
   - 基本情報：競技、国／地域、リーグ・大会、開始日時（JST）、カード、市場、判定。
   - 価格：現在オッズ、市場適正勝率、RMC最終推定勝率、EDGE、EV、最低購入オッズ。
   - 結果：result、profit_loss。
4. **詳細（行をタップ）**：
   - 価格：現在オッズ（ブックメーカー別）、市場適正勝率（no-vig・single / consensus の別）、RMC基本推定勝率、Expert補正（理由・出典・日時の一覧）、RMC最終推定勝率、Fair Odds、EDGE、EV、最低購入オッズ。
   - 試合データ：H2H、直近6試合、Ranking / Rating、平均得失点 / SET差 / MAP差。
   - 分析：主な価格差要因、RMC と市場が食い違う理由、情報不足の項目、データ信頼度。
   - 価格推移：opening_odds → bet_odds → closing_odds と CLV（価格・確率）。未取得は「—」、締切がなければ「CLV未計算」と表示します。
5. **Calibration**：帯ごとの予測と実績を表示します。件数不足の帯は「サンプル不足」と表示し、値は出しません。
6. **補足表示**：
   - 重複・要確認・独立性要確認のカードにはバッジを付けます。
   - ①〜③と同じ試合がある場合も、④の分析値だけを表示します（他系統の値は混ぜません）。
