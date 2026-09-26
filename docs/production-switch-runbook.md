# 本番切替手順書（V2 への切替・1回で安全に行う）

状態：**未実行**。人間の承認を得てから、この手順を上から順に行います。

**方針**
- 旧 analysis.html は削除しない。切替後も、URL で開ける状態で残す。
- 切替は、`index.html` の青い扉のリンク先を `analysis-v2.html` に変えることで行う。これが最小で、元に戻しやすい方法。
- GPT 定時タスクの切替と、ページの切替を同じ時間帯に行う。定時更新の合間（例 23:30〜05:30 JST）を選ぶ。

---

## 1. dev最終テスト

開発ブランチ `dev/data-structure` で次を行い、すべて成功することを確認する。

```
npm test                                   # snapshot 段＋live 段
node scripts/validate-data.js              # error 0件
node scripts/check-locked.js HEAD~1        # 違反0件
node scripts/snapshot-manifest.js verify   # スナップショット不変
node scripts/audit-report.js               # 集計の不整合なし
node migration/compare-baseline.js         # 説明できない不一致 0件（snapshot で実行）
node scripts/v2-compare-legacy.js          # 説明できない差 0件（snapshot で実行）
```

- 上の2つの比較スクリプトは、`RMC_DATA_DIR=snapshots/2026-09-26-migration/data` を付けて実行する。
- ④追加前の134件（A）も、スナップショットに対して通ることを確認する。

## 2. backup/tag

- `main` の現在の先頭にタグ `pre-v2-switch-YYYYMMDD` を付けて push する。
- 旧 `analysis.html` / `analysis.js` / `index.html` の、その時点の状態を記録する（タグで復元できる）。

## 3. V2データ確認

1. 切替の直前に、`main` に入った GPT の最新更新（旧方式で analysis.html に書かれた結果など）を確認する。
2. それを `data/match-updates.json` に結果更新として取り込む（□1 の規則に従い、推測しない）。
3. `data/pro_edge.json` に架空のカードが無いことを確認する（`Sample League`・`pe-s*` が無い）。
4. 開発ブランチを `main` の最新に追従させる。競合は解消し、`analysis.html` 側の変更は旧ファイルとしてそのまま残す。

## 4. production demo無効確認

- `https://rokisinsa.github.io/RMC/analysis-v2.html?demo=pro_edge` を開き、「デモ表示」が出ないこと、④に架空カードが出ないことを確認する。
- この確認は、切替の前にプレビュー用ブランチの Pages で行う。できない場合は、手順9の直後に行う。

## 5. GPT定時タスク更新

- ChatGPT 定時タスクの指示を、`docs/gpt-update-spec.md`（最終版）の内容に差し替える。
- 旧指示（analysis.html を直接編集する指示）は無効にする。
- 差し替え後の最初の定時更新は、手順10・11の確認と同時に監視する。

## 6. analysis.html切替方法

- **推奨**：`index.html` の `ICE_BLUE_LINK` を `"./analysis-v2.html"` に変える（手順7）。
  - 旧 analysis.html は削除しない。URL で直接開ける状態で残し、旧画面であることの表示もしない（旧ファイルは変更しない）。
- **代案（将来）**：V2 が安定したら、別の作業として analysis.html を V2 への案内ページにするかを判断する（今回は行わない）。

## 7. index.htmlリンク確認

- 変更は `const ICE_BLUE_LINK = "./analysis.html";` の1行だけで、`"./analysis-v2.html"` にする。
- 紫・金の扉（未設定）には触れない。
- ローカルで `node scripts/serve.js` を起動し、トップの青い扉から V2 が開くことを確認する。

## 8. Git commit/push

1. 開発ブランチを `main` に取り込むプルリクエストを作る。
2. GitHub Actions「tests」が成功していることを確認してからマージする。
3. マージのコミット SHA を記録する。

## 9. GitHub Pages確認

- Pages の反映（数分）を待つ。
- `https://rokisinsa.github.io/RMC/` と `…/analysis-v2.html` と `…/analysis.html` を開き、次を確認する。
  - トップの青い扉が V2 を開く
  - V2 にエラー表示がない
  - 旧 analysis.html も開ける（rollback 用）

## 10. ①②③④・経験値表示確認

V2 で次を確認する。
- ① 推奨取引・② VALUE①・③ VALUE②・④ PRO EDGE・経験値取引が、別々のセクションとして表示されている
- 本成績と参考成績が別枠になっている
- 重複確認中・要確認・開始時刻未確認などのバッジが出ている
- 複利は「参考値・取引順序未確定」と表示されている
- 行を開くと、事前値（locked）・参考再計算（別枠）・旧分析メモ・試合後レビューが表示される

## 11. 数値照合

- 公開ページの各サマリーが、手元で実行した `node scripts/audit-report.js` の数値（戦績・純損益・ROI・未確定件数）と一致すること。
- 移行時点の値は、`RMC_DATA_DIR=snapshots/2026-09-26-migration/data node scripts/v2-compare-legacy.js` で、説明できない差が0件であること。
- 切替後の最初の GPT 定時更新の後に、もう一度同じ照合を行う。

## 12. rollback方法

問題があれば、次のどちらかで元に戻す。
- **表示だけ戻す（最短）**：`index.html` の `ICE_BLUE_LINK` を `"./analysis.html"` に戻すコミットを push する。旧 analysis.html は残っているので、すぐ旧画面に戻る。
- **全体を戻す**：手順2のタグ `pre-v2-switch-YYYYMMDD` を基準に、切替のマージコミットを `git revert` して push する（履歴は消さない）。

GPT 定時タスクも、旧指示に戻す（旧指示の文面は切替前に保存しておく）。

rollback の後、切替後に `data/` へ入った結果更新は残しておき、再切替のときに使う。

**注意**：旧 analysis.html は削除しない。rollback できる状態を維持する。
