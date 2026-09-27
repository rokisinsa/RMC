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

const OPTIONAL = new Set(["system_analysis", "complete_summary", "automation_runs", "post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

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
  const c = ds.complete_summary;
  if (!c) return '<div class="load-error">⚠ 完全版取得状態を確認できません。bet-channel-complete-summary.json が未取得です。</div>';

  const blockers = c.self_audit?.blockers ?? [];
  const fixed = c.component_status?.fixed_odds ?? {};
  const latestAnalysis = ds.system_analysis?.meta?.generated_at ?? null;
  const publishedRuns = (ds.automation_runs?.runs ?? []).filter(r => r.pages_result === "published");
  const lastPublished = publishedRuns.at(-1) ?? null;

  if (c.complete !== true || c.analysis_ready !== true || c.menu_end_verified !== true || (c.self_audit?.unresolved_blockers ?? 1) !== 0) {
    return `<div class="load-error" style="border:2px solid #d33;padding:12px;margin:10px 0;font-weight:700">
      ⚠ RMC完全定時更新：未完了／新規判断に使用禁止
      <div class="sub" style="font-weight:400">完全母集団チェック：${safeText(c.checked_at ?? c.generated_at ?? "時刻不明")} ／ blockers：${safeText(blockers.join(", ") || "不明")}</div>
      <div class="sub" style="font-weight:400">通常：${safeText(c.component_status?.legacy?.screening_event_count ?? 0)}件 ／ eSports：${safeText(fixed.screening_event_count ?? 0)}件 ／ eSports取得元：${safeText(fixed.source_machine ?? "未取得")}</div>
      <div class="sub" style="font-weight:400">画面内の候補分析は前回成功時点の記録です。最終分析：${safeText(latestAnalysis ?? "未記録")} ／ 最終公開成功run：${safeText(lastPublished?.run_id ?? "未記録")}</div>
    </div>`;
  }

  return `<div class="data-status" style="border:2px solid #2a8;padding:10px;margin:10px 0">
    RMC完全定時更新：完全母集団OK
    <div class="sub">確認：${safeText(c.checked_at ?? c.generated_at ?? "—")} ／ 全event ${safeText(c.event_count ?? 0)} ／ screening ${safeText(c.screening_event_count ?? 0)} ／ eSports ${safeText(fixed.screening_event_count ?? 0)}</div>
  </div>`;
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
