// RMC 分析情報 V2（新データ構造版）。本番 analysis.html / analysis.js とは独立。
// data/*.json を読み込み、lib/view の表示モデル・描画を呼ぶだけ（数値はすべてデータから自動計算）。

import { buildViewModel } from "./lib/view/model.js";
import { renderPage } from "./lib/view/render.js";

const FILES = {
  matches: "data/matches.json",
  recommendations: "data/recommendations.json",
  experience: "data/experience.json",
  value1: "data/value1.json",
  value2: "data/value2.json",
  pro_edge: "data/pro_edge.json",
  legacy_unassigned: "data/legacy-unassigned.json",
};

async function getJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} を読み込めません（${res.status}）`);
  return res.json();
}

// ④のデモ表示（?demo=pro_edge）：架空のサンプルを使う。本データには混ぜない
async function applyDemo(ds) {
  const { makeProEdgeSample } = await import("./tests/fixtures/pro-edge-sample.js");
  const sample = makeProEdgeSample();
  return {
    ...ds,
    matches: { ...ds.matches, update_runs: [...ds.matches.update_runs, ...sample.matches.update_runs], matches: [...ds.matches.matches, ...sample.matches.matches] },
    pro_edge: sample.pro_edge,
  };
}

// 旧RMCの分析メモ（本文）。data へ未移行のため analysis.html から該当箇所だけを表示する。
// 旧メモ内の確率表示（事前固定を確認できない値）とスクリプトは取り除く。
let legacyDoc = null;
async function legacyDetail(key) {
  legacyDoc ??= fetch("./analysis.html", { cache: "no-cache" }).then(r => r.text()).then(t => new DOMParser().parseFromString(t, "text/html"));
  const doc = await legacyDoc;
  let node = null;
  if (key.startsWith("id:")) {
    node = doc.getElementById(key.slice(3))?.querySelector(".detail-cell");
  } else {
    const [table, idx] = key.split("#");
    const mains = [...doc.querySelectorAll(`#${table} tbody > tr`)].filter(tr => tr.querySelector("td.result"));
    node = mains[Number(idx)]?.nextElementSibling;
  }
  if (!node) return null;
  const clone = node.cloneNode(true);
  clone.querySelectorAll("script, style, .probability-box, .model-meta").forEach(n => n.remove());
  clone.querySelectorAll("*").forEach(el => [...el.attributes].forEach(a => { if (/^on/i.test(a.name)) el.removeAttribute(a.name); }));
  clone.querySelectorAll("details").forEach(d => d.setAttribute("open", ""));
  return clone.innerHTML;
}

function wire(root) {
  root.addEventListener("click", async e => {
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
    const slot = detail.querySelector(".legacy-detail[data-legacy-key]:not([data-loaded])");
    if (!detail.hidden && slot) {
      slot.dataset.loaded = "1";
      try {
        const html = await legacyDetail(slot.dataset.legacyKey);
        slot.innerHTML = html
          ? `<div class="legacy-title">旧RMCの分析メモ（移行前の原文。確率表示は除外）</div><div class="legacy-body">${html}</div>`
          : '<div class="sub">旧RMCの分析メモはありません</div>';
      } catch {
        slot.innerHTML = '<div class="sub">旧RMCの分析メモを読み込めませんでした</div>';
      }
    }
  });
}

async function main() {
  const root = document.getElementById("app");
  try {
    const entries = await Promise.all(Object.entries(FILES).map(async ([k, p]) => [k, await getJson(p)]));
    let ds = Object.fromEntries(entries);
    const cfg = await getJson("config/pro-edge.config.json");
    const demo = new URLSearchParams(location.search).get("demo") === "pro_edge";
    if (demo) ds = await applyDemo(ds);
    const vm = buildViewModel(ds, { proEdgeConfig: cfg });
    root.innerHTML = renderPage(vm, { demo });
    wire(root);
    window.__rmcV2 = vm;   // 確認用
  } catch (err) {
    root.innerHTML = `<div class="load-error">データを読み込めませんでした：${String(err.message).replace(/[<>&]/g, "")}</div>`;
    console.error(err);
  }
}

main();
