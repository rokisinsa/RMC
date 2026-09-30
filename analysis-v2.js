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

const OPTIONAL = new Set(["system_analysis", "complete_summary", "automation_runs", "scheduled_checklist", "post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

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
      + completeUpdateBanner(ds)
      + renderPage(vm, { demo: mode.demo });
    wire(root);
    window.__rmcV2 = vm;   // 確認用
  } catch (err) {
    root.innerHTML = `<div class="load-error">データを読み込めませんでした：${String(err.message).replace(/[<>&]/g, "")}</div>`;
    console.error(err);
  }
}

main();
