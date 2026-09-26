# RMC の自動更新のしくみ（本番更新 workflow）

## ひとことで言うと

- **考えるのは ChatGPT（外部の分析側）**：試合を調べて、①推奨・②VALUE①・③VALUE②・④PRO EDGE を**それぞれ別々に**分析し、結果を「更新 payload（ペイロード）」という1つの JSON にまとめる。
- **GitHub は「受け取って、検査して、公開する装置」**：payload を受け取り、ルールどおりか細かく検査し、合格したときだけ `data/` に書き込んで、ページ（analysis-v2.html）に出す。
- GitHub は**予想も分析もしない**。オッズや勝率を自分で作ったり、足りない値を推測で埋めたりしない。

## 流れ（小学生向けのたとえ付き）

```
ChatGPT（調べて分析する人）
  ↓  宿題のプリント（更新 payload）を作る
GitHub production update（先生の受付箱）  … .github/workflows/rmc-production-update.yml
  ↓  プリントを受け取る
validation（先生の採点）  … scripts/rmc-production-update.mjs
  ↓  書き方・日付・重複・ズル（未来の情報・書き換え）がないかチェック。1つでもダメなら返却（何も書き込まない）
main（クラスの掲示板の原稿）
  ↓  合格したプリントの内容だけを data/*.json に書き写す
Actions（ほかの先生の二重チェック）
  ↓  今あるテストを全部やり直す。1つでも失敗したら掲示しない
Pages（掲示板に貼る）
  ↓  GitHub Pages が公開する
RMC（みんなが見るページ）  … https://rokisinsa.github.io/RMC/analysis-v2.html
```

## 何を検査するか（1つでも重大エラーならコミットしない）

| 検査 | 内容 |
|---|---|
| JSON schema | payload の形（`schema/rmc-update-payload.schema.json`）と、反映後の全データのスキーマ |
| match identity | 試合 ID の形（`YYYY-MM-DD-略称-略称`）、ID の日付と開始日（JST）の一致、同じ試合の別 ID 登録の禁止 |
| duplicate | 同じ系統の同じ試合・市場・選択の二重登録、同じ run_id の二重適用 |
| JST 日時 | payload の日時はすべて `+09:00` |
| source / confidence | 結果の根拠（公式・専門DB など）と確度。予想・プレビュー・オッズページは結果の根拠にできない |
| null 処理 | 無い値は `null`。「N/A」「不明」などの文字で埋めない |
| 未来情報 | `generated_at` より後の時刻、試合開始後のオッズ、試合開始より前に「確認した」結果、未来の payload |
| locked | 固定済みの事前値・オッズ・投入額・価格スナップショット・結果・履歴の書き換え（追記だけ許可） |
| baseline / snapshots | 変更されていないこと |
| 過去結果 | 確定済みの結果の変更は `correction.reason` が必要。試合事実が変わっていないカードの損益が変わったら拒否 |
| P/L・ROI | 戦績＝勝ち＋負け、純損益＝各カードの損益の合計、ROI＝純損益÷確定投入額、未確定件数 |
| CLV | 価格CLV＝購入÷締切−1、確率CLV＝締切no-vig確率−1/購入 |
| 4系統の独立 | 系統ごとに別ブロック・別の探索回。①②③に④の項目を入れない。④の推定が同じ試合の①②③の推定の写しでない |
| ④の計算値 | 外部が計算した market / base / final probability・edge・fair odds・EV・required EV・minimum entry odds・CLV を `reported` で送ると、GitHub 側で入力から計算し直して照合する（違えば拒否）。market probability を base probability にコピーしたら拒否 |

## 更新 payload の形

最小（変更なし。検査だけして「完全チェックした」記録を残す）:

```json
{ "payload_version": 1, "run_id": "rmc-2026-09-27-0600", "source": "ChatGPT Automations 06:00", "generated_at": "2026-09-27T06:50:00+09:00" }
```

全部の項目の例は `tests/fixtures/production-update/stage-a.json`（新しい試合・4系統の新規候補）と `stage-b.json`（結果更新・締切オッズ・試合後レビュー）を見てください（どちらも架空のテスト用データ）。

| ブロック | 中身 | 反映先 |
|---|---|---|
| `matches` | 新しい試合の登録（試合事実だけ）と、その更新回 | `data/matches.json` |
| `result_updates` | □1 結果更新の更新回 | `data/match-updates.json`（追記） |
| `systems.recommendations` / `value1` / `value2` | 探索回・新規カード・締切オッズ（VALUE①は条件確認も） | 各系統のファイル |
| `systems.experience` | 経験値取引の新規カード・締切オッズ | `data/experience.json` |
| `systems.pro_edge` | 探索回・新規カード・価格スナップショットの追記・購入記録・計算値の申告（照合用） | `data/pro_edge.json` |
| `post_match_reviews` | □8 試合後レビュー（系統ごと） | `data/post-match-reviews/<系統>.json` |

- **系統ごとに別のブロック**です。共通の候補リストから振り分けることはできません。同じ試合が複数の系統に出るのは、それぞれの系統が別々に選んだときだけです（探索回 `run_id` も系統ごと）。
- 既存のカードに対してできるのは「まだ無い値の追記」だけ（締切オッズ、条件確認、④の締切スナップショット・購入記録）。

## 動かし方

### 1. 手元で検査だけ（dry-run。data/ は変わらない）

```bash
node scripts/rmc-production-update.mjs --payload tmp/rmc-update.json --dry-run
```

表示されるもの：追加・更新・変更なし・拒否の件数、locked 違反、schema 違反、重複、損益差分、系統別の件数。

### 2. GitHub で本番更新（workflow）

- GitHub の Actions →「rmc-production-update」→「Run workflow」
  - `run_id`・`source`（payload と同じ値）
  - `payload_json`（JSON 本文）か `payload_path`（リポジトリの `incoming/` か `tmp/` にある .json）
  - `dry_run` にチェックすると検査だけ
- または API の `repository_dispatch`（event type `rmc-production-update`、`client_payload` に `run_id`・`source`・`payload` または `payload_path`・`dry_run`）

workflow の順番：受信 → dry-run 検証 → 反映 → 変更ファイルの検査 → 全テスト（npm test・snapshot・validate・locked 保護・監査・リハーサル）→ 実行記録に PASS を記録 → `RMC production update: <run_id>` でコミット → main へ push → Pages の公開確認。
途中で1つでも失敗すると、そこで止まり、main は変わりません。

### 3. 実行記録

`data/automation-runs.json` に、1回ごとに次を追記します（追記のみ。書き換えると locked 保護で拒否）。
`run_id, started_at, finished_at, source, start_sha, end_sha, systems_checked, cards_checked, results_updated, metadata_updated, new_candidates, accepted, watch, rejected, postmortems_created, validation_result, actions_result, pages_result`

- `end_sha` は「この記録を含むコミット自身の SHA」なので書けず、常に `null`。コミットの SHA と Pages の結果は、その回の Actions 実行のまとめ（Summary）に出ます。
- `actions_result` は、コミット前に全テストが通ったときだけ `pass` になってコミットされます。

## 大事な注意

- **GitHub 側は分析しない。** H2H・直近成績・ランキング/レーティング・ロスター・欠場・最新オッズ・市場確率・基本推定・EV・CLV の元になる値は、すべて外部の分析側が payload に入れて渡す。
- **payload を GitHub に届ける手段は別に必要。** この workflow は「受け取ってから公開するまで」を GitHub だけで安全に行うためのもの。ChatGPT Automations から GitHub に届けられない場合は、`Run workflow` の画面に人が payload を貼る、または GitHub API を呼べる仕組みから `repository_dispatch` を送る必要がある（この変更では API キーや有料 API は追加していない）。
- 旧 `analysis.html` / `analysis.js` に直接書く方式には戻さない。公開ページは `analysis-v2.html`、トップの青い扉もそのまま。
