# 分析情報 V2（確認用画面）

- **本番**の `analysis.html` / `analysis.js` / `index.html` は変更していません。
- **V2** は `analysis-v2.html` として並行で置いてあり、トップページからのリンクもありません。切り替えは承認後に行います。

## 確認方法

```
node scripts/serve.js            # http://localhost:8123/analysis-v2.html
```

- データを `fetch` で読むため、`file://` で直接開いても動きません。GitHub Pages ではそのまま動きます。
- `?demo=pro_edge` を付けると、④を架空のサンプルデータで表示します。「デモ表示」の帯が出ます。本データには混ぜません。

## 構成

| ファイル | 役割 |
|---|---|
| `analysis-v2.html` | 画面の枠とスタイル |
| `analysis-v2.js` | データ読み込み（data/*.json と config）、操作（行の開閉、期間タブ）、旧分析メモの差し込み |
| `lib/view/model.js` | 表示用モデル。①②③と経験値取引は既存の `summarizeSystem` / `compound` / `quarterKelly` を呼ぶだけで、④は `summarizeProEdge` を使う。判定・集計ロジックは再実装しない |
| `lib/view/render.js` | 表示用モデルから HTML を生成（計算はしない。データ由来の文字列はエスケープ） |
| `lib/view/format.js` | 金額・確率・日本時間の書式 |
| `scripts/v2-compare-legacy.js` | 旧RMC（基準点の表示）との照合。一致・意図した差・説明できない差に分類する |

## 表示ルール

- **自動計算**：数値はすべてデータから計算し、HTML への手入力はしません。
- **系統の分離**：①推奨・②VALUE①・③VALUE②・④PRO EDGE・経験値取引は別セクションです。VALUE①・② と④は、本成績と参考成績を別枠にしています。
- **事前確率**：試合前に固定された値（`locked`）だけを表示します。現在モデルの再計算値は「現在モデルによる参考再計算（事前確率ではありません）」という別枠に出します。
- **データ品質**：開始時刻・オッズ・結果・事前値・条件成立・重複確認中・独立性要確認を、各カードにバッジで表示します。
- **旧分析メモ**：`data/legacy-analysis/<系統>.json` から表示します（原文 `raw_html` と、原文から構造化した `blocks`）。旧 `analysis.html` は参照しません。事前固定を確認できない確率表示は構造化の対象外です。
- **結果更新**：基準点（06:45）より後の結果は `data/match-updates.json`（追記のみ）を matches.json に重ねて表示します。確認できなかった試合は「要確認」バッジを付け、結果は入れません。
- **複利**：取引の順序（投入時刻・試合終了時刻）を証明できないため「参考値・順序未確定」とし、試合開始時刻順と旧画面の登録時刻順の2通りの値を併記します（`scripts/audit-compound.js`）。
- **実行モード**：`http://localhost` などのローカル環境だけが development です。④のデモ（`?demo=pro_edge`）は development でしか動きません。GitHub Pages を含むそれ以外はすべて production で、demo 指定は無視されます。架空データを含む表示モデルは production では例外で止まります。
- **旧ファイルなしの確認**：`node scripts/serve.js 8124 --block=analysis.html,analysis.js` で、旧ファイルを 404 にした状態で表示を確かめられます。
