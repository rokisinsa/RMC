// RMC 分析情報 V2（新データ構造版）。本番 analysis.html / analysis.js とは独立。
// data/*.json だけを読み込み、lib/view の表示モデル・描画を呼ぶ（数値はすべてデータから自動計算）。
// 旧 analysis.html は参照しない（旧分析メモは data/legacy-analysis に移行済み）。

let buildViewModel, renderPage, resolveMode, assertNoDemoInProduction;

export const DATA_PATHS = {
  matches: "data/matches.json",
  match_updates: "data/match-updates.json",
  recommendations: "data/recommendations.json",
  experience: "data/experience.json",
  value1: "data/value1.json",
  value2: "data/value2.json",
  pro_edge: "data/pro_edge.json",
  system_analysis: "data/system-analysis.json",
  today_gap_analysis: "data/today-gap-analysis.json",
  complete_summary: "data/bet-channel-complete-summary.json",
  automation_runs: "data/automation-runs.json",
  scheduled_checklist: "data/scheduled-update-checklist.json",
  legacy_unassigned: "data/legacy-unassigned.json",
  legacy_analysis_recommendations: "data/legacy-analysis/recommendations.json",
  legacy_analysis_value1: "data/legacy-analysis/value1.json",
  legacy_analysis_value2: "data/legacy-analysis/value2.json",
  post_match_recommendations: "data/post-match-reviews/recommendations.json",
  post_match_experience: "data/post-match-reviews/experience.json",
  post_match_value1: "data/post-match-reviews/value1.json",
  post_match_value2: "data/post-match-reviews/value2.json",
  post_match_pro_edge: "data/post-match-reviews/pro_edge.json",
};

const OPTIONAL = new Set(["system_analysis", "today_gap_analysis", "complete_summary", "automation_runs", "scheduled_checklist", "post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

async function getJson(path, optional = false) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}cb=${Date.now()}`, { cache: "no-store" });
  if (optional && res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} を読み込めません（${res.status}）`);
  return res.json();
}

// ④のデモ（架空データ）。development でしか呼ばれない。本データには混ぜず、__demo 印を付ける
async function applyDemo(ds) {
  const { makeProEdgeSample } = await import("./tests/fixtures/pro-edge-sample.js");
  const sample = makeProEdgeSample();
  return {
    ...ds,
    __demo: true,
    matches: { ...ds.matches, update_runs: [...ds.matches.update_runs, ...sample.matches.update_runs], matches: [...ds.matches.matches, ...sample.matches.matches] },
    pro_edge: sample.pro_edge,
  };
}

function safeText(v) {
  return String(v ?? "").replace(/[<>&]/g, "");
}

function renderTodayGapAnalysis(a) {
  if (!a?.candidates?.length) return "";
  const statusLabel = {
    candidate: "価格込み候補",
    watch: "監視",
    price_reject: "格差大・価格NG"
  };
  const statusTone = {
    candidate: "#69f0a5",
    watch: "#ffd45d",
    price_reject: "#ff8f9a"
  };
  const candidates = [...a.candidates].sort((x,y)=>(x.rank??999)-(y.rank??999));
  const topRows = candidates.map(c => {
    const o=c.odds ?? {};
    return `<tr>
      <td style="white-space:nowrap;font-weight:900">#${safeText(c.rank)}</td>
      <td><strong>${safeText(c.matchup)}</strong><div class="sub">${safeText(c.sport)}｜${safeText(c.competition)}</div></td>
      <td style="white-space:nowrap">${safeText(c.start_jst ? c.start_jst.replace("T"," ").slice(5,16) : "—")}</td>
      <td style="white-space:nowrap"><strong>${safeText(c.gap_grade ?? "—")}</strong></td>
      <td style="white-space:nowrap"><strong>${safeText(c.price_grade ?? "—")}</strong></td>
      <td style="white-space:nowrap">${safeText(o.min ?? "—")}〜${safeText(o.max ?? "—")}</td>
      <td style="white-space:nowrap">${safeText(c.estimated_win_probability_pct ?? "—")}${c.estimated_win_probability_pct == null ? "" : "%"}</td>
      <td style="color:${statusTone[c.status] ?? "#dff8ff"};font-weight:800">${safeText(statusLabel[c.status] ?? c.status ?? "—")}</td>
    </tr>`;
  }).join("");

  const detailCards = candidates.map((c,i) => {
    const o=c.odds ?? {};
    const links=(c.sources ?? []).map((u,n)=>`<a href="${safeText(u)}" target="_blank" rel="noopener" style="color:#7edcff">出典${n+1}</a>`).join(" / ");
    return `<details class="analysis-card" ${i < 4 ? "open" : ""}>
      <summary>
        <span style="font-weight:900;color:#8edcff">#${safeText(c.rank)}</span>
        <span class="analysis-match">${safeText(c.matchup)}</span>
        <span class="analysis-time">${safeText(c.start_jst ? c.start_jst.replace("T"," ").slice(5,16)+" JST" : "時刻未確認")}</span>
        <span style="padding:3px 7px;border:1px solid rgba(255,255,255,.14);border-radius:999px;font-size:10px">格差 ${safeText(c.gap_grade ?? "—")}</span>
        <span style="padding:3px 7px;border:1px solid rgba(255,255,255,.14);border-radius:999px;font-size:10px">価格 ${safeText(c.price_grade ?? "—")}</span>
      </summary>
      <div class="analysis-card-body">
        <div class="analysis-summary"><strong>${safeText(statusLabel[c.status] ?? c.status ?? "—")}</strong>｜${safeText(c.conclusion ?? "")}</div>
        <div class="detail-grid">
          <div class="box"><h3>大会・条件</h3><div>${safeText(c.sport)}｜${safeText(c.competition)}</div><div class="sub">${safeText(c.venue ?? "会場未確認")}｜${safeText(c.format ?? "形式未確認")}</div></div>
          <div class="box"><h3>市場・価格</h3><div>オッズ ${safeText(o.min ?? "—")}〜${safeText(o.max ?? "—")}</div><div>必要勝率 ${safeText(o.required_win_rate_pct ?? "—")}${typeof o.required_win_rate_pct === "string" && /\d/.test(o.required_win_rate_pct) ? "%" : ""}</div><div>推定勝率 ${safeText(c.estimated_win_probability_pct ?? "—")}${c.estimated_win_probability_pct == null ? "" : "%"}</div><div>推定EV ${safeText(c.estimated_ev_pct ?? "—")}</div><div class="sub">${safeText(o.book_examples ?? "")}</div></div>
          <div class="box"><h3>ランキング / Rating</h3><div>${safeText(c.ranking_rating ?? "未確認")}</div></div>
          <div class="box"><h3>H2H</h3><div>${safeText(c.h2h ?? "未確認")}</div></div>
          <div class="box"><h3>直近成績</h3><div>${safeText(c.recent_form ?? "未確認")}</div></div>
          <div class="box"><h3>直近の共通相手</h3><div>${safeText(c.common_opponents ?? "未確認")}</div></div>
          <div class="box"><h3>メンバー / 欠場 / roster</h3><div>${safeText(c.roster ?? "未確認")}</div></div>
          <div class="box"><h3>序盤傾向 / Veto</h3><div>${safeText(c.early_tendency ?? "未確認")}</div></div>
        </div>
        <div style="margin-top:10px;padding:9px 10px;border-left:3px solid #ffb36b;background:rgba(255,179,107,.07);font-size:11px;line-height:1.65"><strong>リスク：</strong>${safeText(c.risk ?? "特記事項なし")}</div>
        <div class="analysis-sources" style="margin-top:9px">${links}</div>
      </div>
    </details>`;
  }).join("");

  const pure=(a.summary?.pure_gap_top ?? []).map(x=>safeText(x)).join(" ／ ");
  const value=(a.summary?.price_adjusted_top ?? []).map(x=>safeText(x)).join(" ／ ");
  return `<section class="analysis-panel" style="border:2px solid rgba(105,240,165,.42);margin-top:10px">
    <div class="analysis-panel-head" style="background:linear-gradient(90deg,rgba(63,203,255,.12),rgba(105,240,165,.09))">
      <div><strong style="font-size:17px">🔥 ${safeText(a.title ?? "本日の格差試合 完全分析")}</strong>
      <div class="sub">更新 ${safeText(a.generated_at ?? "—")}｜対象 ${safeText(a.window?.from ?? "—")} ～ ${safeText(a.window?.to ?? "—")}</div></div>
      <div class="analysis-counts"><span>候補 ${safeText(candidates.length)}件</span><span>リアル＋eSports</span></div>
    </div>
    <div style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)">
      <div style="font-size:11px;line-height:1.7"><strong>純粋な実力格差：</strong>${pure || "—"}</div>
      <div style="font-size:11px;line-height:1.7"><strong>価格込み注目：</strong>${value || "—"}</div>
      <div class="sub">${safeText(a.summary?.caution ?? "")}</div>
    </div>
    <div class="table-wrap" style="margin:10px 12px"><table class="result-table">
      <thead><tr><th>#</th><th>カード / 大会</th><th>開始</th><th>格差</th><th>価格</th><th>オッズ</th><th>推定勝率</th><th>判定</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table></div>
    <div style="padding:0 12px 12px"><div class="sub" style="margin-bottom:7px">各カードを開くと、H2H・直近・共通相手・roster・序盤傾向・市場評価まで表示。</div>${detailCards}</div>
  </section>`;
}

function completeUpdateBanner(ds) {
  const checklist = ds.scheduled_checklist;
  const latestId = checklist?.latest_run_id ?? null;
  const latestRun = checklist?.runs?.find(r => r.run_id === latestId) ?? checklist?.runs?.at?.(-1) ?? null;
  const c = ds.complete_summary;
  const latestAnalysis = ds.system_analysis?.meta?.generated_at ?? null;
  const publishedRuns = (ds.automation_runs?.runs ?? []).filter(r => r.pages_result === "published");
  const publishedIds = new Set(publishedRuns.map(r => r.run_id));
  const isCompletePass = r => r?.status === "passed" && r?.summary?.pass === 41 && r?.summary?.fail === 0 && r?.summary?.blocked === 0 && r?.summary?.pending === 0;
  const passedRuns = (checklist?.runs ?? []).filter(r => isCompletePass(r) && (publishedIds.size === 0 || publishedIds.has(r.run_id)));
  const run = passedRuns.at(-1) ?? latestRun;
  const latestAttempt = latestRun && run && latestRun.run_id !== run.run_id ? latestRun : null;
  const lastPublished = publishedRuns.at(-1) ?? null;

  if (run) {
    const icon = x => x === "pass" ? "✅" : x === "fail" ? "❌" : x === "blocked" ? "⏸" : "…";
    const rows = (run.checks ?? []).map(x => `<tr>
      <td style="white-space:nowrap">${safeText(x.id)}</td>
      <td style="white-space:nowrap">${icon(x.status)} ${safeText(x.status)}</td>
      <td>${safeText(x.title)}</td>
      <td>${safeText(x.detail ?? "—")}</td>
    </tr>`).join("");
    const s = run.summary ?? { pass:0, fail:0, blocked:0, pending:0, total:41 };
    const ok = run.status === "passed" && s.pass === 41 && s.fail === 0 && s.blocked === 0 && s.pending === 0;
    const cls = ok ? "data-status" : "load-error";
    const border = ok ? "#2a8" : "#d33";
    const headline = ok
      ? `✅ RMC完全定時更新：41/41 PASS（${safeText(run.run_id)}）`
      : `❌ RMC完全定時更新：未完了（${safeText(run.run_id)}）`;
    const warning = ok ? "" : '<div style="font-weight:700">新規判断に使用禁止。未実行をPASS扱いしません。</div>';
    const inventoryLine = c
      ? `<div class="sub">完全母集団：${safeText(c.complete === true ? "complete" : "incomplete")} ／ 全event ${safeText(c.event_count ?? 0)} ／ screening ${safeText(c.screening_event_count ?? 0)} ／ blockers ${safeText((c.self_audit?.blockers ?? []).join(", ") || "なし")}</div>`
      : '<div class="sub">完全母集団JSON：未取得</div>';
    return `<div class="${cls}" style="border:2px solid ${border};padding:12px;margin:10px 0">
      <div style="font-weight:800">${headline}</div>
      ${warning}
      <div class="sub">予定：${safeText(run.scheduled_for ?? "—")} ／ slot ${safeText(run.slot ?? "—")} ／ 状態 ${safeText(run.status ?? "—")}</div>
      ${latestAttempt ? `<div class="sub">最新試行 ${safeText(latestAttempt.run_id)} は未完了のため、最後に公開成功した完全更新を表示中。</div>` : ""}
      <div class="sub">✅ ${safeText(s.pass)} ／ ❌ ${safeText(s.fail)} ／ ⏸ ${safeText(s.blocked)} ／ … ${safeText(s.pending)} ／ 合計 ${safeText(s.total ?? 41)}</div>
      ${inventoryLine}
      <div class="sub">最終分析：${safeText(latestAnalysis ?? "未記録")} ／ 最終公開成功run：${safeText(lastPublished?.run_id ?? "未記録")}</div>
      <details style="margin-top:8px" ${ok ? "" : "open"}>
        <summary><strong>定時更新41項目の監査結果を表示</strong></summary>
        <div class="table-wrap"><table class="result-table"><thead><tr><th>#</th><th>判定</th><th>チェック項目</th><th>根拠</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>
    </div>`;
  }

  if (!c) return '<div class="load-error">⚠ 完全版取得状態・41項目監査状態を確認できません。</div>';
  const blockers = c.self_audit?.blockers ?? [];
  const fixed = c.component_status?.fixed_odds ?? {};
  if (c.complete !== true || c.analysis_ready !== true || c.menu_end_verified !== true || (c.self_audit?.unresolved_blockers ?? 1) !== 0) {
    return `<div class="load-error" style="border:2px solid #d33;padding:12px;margin:10px 0;font-weight:700">
      ⚠ RMC完全定時更新：41項目監査記録なし／完全母集団未完了
      <div class="sub" style="font-weight:400">blockers：${safeText(blockers.join(", ") || "不明")} ／ 通常：${safeText(c.component_status?.legacy?.screening_event_count ?? 0)}件 ／ eSports：${safeText(fixed.screening_event_count ?? 0)}件</div>
    </div>`;
  }
  return '<div class="load-error">⚠ 完全母集団はありますが、41項目の定時監査記録がありません。完全更新扱いにしません。</div>';
}

function wire(root) {
  root.addEventListener("click", e => {
    const tab = e.target.closest(".win-tab");
    if (tab) {
      const g = tab.dataset.windowGroup;
      root.querySelectorAll(`.win-tab[data-window-group="${g}"]`).forEach(b => b.classList.toggle("active", b === tab));
      root.querySelectorAll(`.win-panel[data-window-group="${g}"]`).forEach(p => { p.hidden = p.dataset.windowPanel !== tab.dataset.window; });
      return;
    }
    const row = e.target.closest("tr.row");
    if (!row) return;
    const detail = document.getElementById(row.dataset.toggle);
    if (!detail) return;
    detail.hidden = !detail.hidden;
    row.classList.toggle("opened", !detail.hidden);
  });
}

async function main() {
  const cb = Date.now();
  const [modelMod, renderMod, modeMod] = await Promise.all([
    import(`./lib/view/model.js?cb=${cb}`),
    import(`./lib/view/render.js?cb=${cb}`),
    import(`./lib/view/mode.js?cb=${cb}`)
  ]);
  buildViewModel = modelMod.buildViewModel;
  renderPage = renderMod.renderPage;
  resolveMode = modeMod.resolveMode;
  assertNoDemoInProduction = modeMod.assertNoDemoInProduction;
  const root = document.getElementById("app");
  const mode = resolveMode(location.href);
  document.documentElement.dataset.mode = mode.mode;
  try {
    const entries = await Promise.all(Object.entries(DATA_PATHS).map(async ([k, p]) => [k, await getJson(p, OPTIONAL.has(k))]));
    let ds = Object.fromEntries(entries.filter(([, v]) => v != null));
    const cfg = await getJson("config/pro-edge.config.json");
    if (mode.demo) ds = await applyDemo(ds);                 // development のときだけ
    assertNoDemoInProduction(mode, ds);
    const vm = buildViewModel(ds, { proEdgeConfig: cfg });
    root.innerHTML = (mode.mode === "development" ? '<div class="dev-banner">development モード（ローカル確認環境）</div>' : "")
      + renderTodayGapAnalysis(ds.today_gap_analysis)
      + '<details style="margin:10px 0 18px;border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:8px 10px"><summary style="cursor:pointer;font-size:12px;font-weight:800;color:#9fc9da">自動更新・41項目監査の状態（開く）</summary>'
      + completeUpdateBanner(ds)
      + '</details>'
      + '<div style="margin:18px 2px 8px;font-size:12px;color:#8fa8b5">以下は既存の①推奨・②VALUE①・③VALUE②・④PRO EDGE・経験値の取引履歴／収支。上の「本日・深夜の格差試合」が今回の最新分析です。</div>'
      + renderPage(vm, { demo: mode.demo });
    wire(root);
    window.__rmcV2 = vm;   // 確認用
  } catch (err) {
    root.innerHTML = `<div class="load-error">データを読み込めませんでした：${String(err.message).replace(/[<>&]/g, "")}</div>`;
    console.error(err);
  }
}

main();
