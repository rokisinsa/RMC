// RMC 分析情報 V2（新データ構造版）。本番 analysis.html / analysis.js とは独立。
// data/*.json だけを読み込み、lib/view の表示モデル・描画を呼ぶ（数値はすべてデータから自動計算）。
// 旧 analysis.html は参照しない（旧分析メモは data/legacy-analysis に移行済み）。

import { buildViewModel } from "./lib/view/model.js";
import { renderPage } from "./lib/view/render.js";
import { resolveMode, assertNoDemoInProduction } from "./lib/view/mode.js";

export const DATA_PATHS = {
  matches: "data/matches.json",
  match_updates: "data/match-updates.json",
  recommendations: "data/recommendations.json",
  experience: "data/experience.json",
  value1: "data/value1.json",
  value2: "data/value2.json",
  pro_edge: "data/pro_edge.json",
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

const OPTIONAL = new Set(["post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

async function getJson(path, optional = false) {
  const res = await fetch(path, { cache: "no-cache" });
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
      + renderPage(vm, { demo: mode.demo });
    wire(root);
    window.__rmcV2 = vm;   // 確認用
  } catch (err) {
    root.innerHTML = `<div class="load-error">データを読み込めませんでした：${String(err.message).replace(/[<>&]/g, "")}</div>`;
    console.error(err);
  }
}

main();
