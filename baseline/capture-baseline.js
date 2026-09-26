// 手順0：現行ページの baseline を記録する。
//
// 1. displayed … 基準タグ時点の analysis.html / analysis.js を読み、ブラウザと同じ計算で「画面に出ている値」を再現する。
//                VALUE①② のサマリーは HTML 直書きの文字列をそのまま記録する。
// 2. legacy_rows … 現行HTMLの各行から読み取った生データ（暫定解釈つき）
// 3. expected  … legacy_rows を新ルール（lib/）で再計算した期待値
//
// displayed は「現在の表示」であって正解ではない。差分は baseline/<日付>/README.md で説明する。
// 使い方: node baseline/capture-baseline.js [git参照（既定: baseline-2026-09-26）]

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/load-node.js";
import { settlePick } from "../lib/settlement.js";
import { summarize, compound, quarterKelly } from "../lib/summary.js";
import { REFERENCE_NOTIONAL_STAKE } from "../lib/buckets.js";

const REF = process.argv[2] ?? "baseline-2026-09-26";
const OUT_DIR = join(ROOT, "baseline", "2026-09-26");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const html = git("show", `${REF}:analysis.html`);
const js = git("show", `${REF}:analysis.js`);
const commit = git("rev-list", "-n", "1", REF).trim();

// ── HTML の簡易パーサ ──────────────────────────────────────
const strip = s => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const cells = inner => [...inner.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map(m => m[1]);
function attrs(s) {
  const out = {};
  s.replace(/data-([a-z0-9-]+)="([^"]*)"/g, (_, k, v) => { out[k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = v; });
  return out;
}
function rowsOf(cls) {
  return [...html.matchAll(new RegExp(`<tr class="${cls}"([^>]*)>([^]*?)</tr>`, "g"))]
    .map(m => ({ dataset: attrs(m[1]), tds: cells(m[2]) }));
}
function tableBody(id) {
  const m = new RegExp(`<table id="${id}">[^]*?<tbody>([^]*?)</tbody>`).exec(html);
  if (!m) throw new Error(`table #${id} が見つかりません`);
  return m[1];
}
const textById = id => { const m = new RegExp(`id="${id}"[^>]*>([^]*?)</`).exec(html); return m ? strip(m[1]) : null; };

// ── 1. displayed：現行 analysis.js をそのまま実行して再現 ─────────────
function reproduceDisplayed() {
  const out = {};
  const recorder = id => ({
    set textContent(v) { out[id] = v; }, get textContent() { return out[id] ?? ""; },
    set innerHTML(v) { out[`${id}.innerHTML`] = v; }, style: {},
  });
  const toFakeRow = r => ({
    dataset: { ...r.dataset },
    querySelectorAll: sel => (sel === "td" ? r.tds.map(t => ({ textContent: strip(t) })) : []),
  });
  const tradeRows = rowsOf("trade-row").map(toFakeRow);
  const actualRows = rowsOf("actual-row").map(toFakeRow);
  const probBoxes = [...html.matchAll(/class="probability-box"[^>]*data-model="([a-z0-9]+)"/g)].map(m => {
    const head = { textContent: "" };
    return { dataset: { model: m[1] }, head, querySelector: s => (s === ".probability-head strong" ? head : { textContent: "" }), appendChild() {} };
  });
  const document = {
    addEventListener() {},
    getElementById: recorder,
    createElement: () => ({ className: "", textContent: "" }),
    querySelectorAll(sel) {
      if (sel === "#actualBetTable .actual-row") return actualRows;
      if (sel === ".probability-box[data-model]") return probBoxes;
      if (sel === ".trade-row[data-locked-prob]") return tradeRows.filter(r => r.dataset.lockedProb !== undefined);
      return [];
    },
  };
  const ctx = vm.createContext({ document, Math, Number, String, Date, Object, console });
  vm.runInContext(js, ctx);
  vm.runInContext(`
    renderActualBetSummary();
    initProbabilityBoxes();
    updateCalibration();
    renderTradeSummary(__rows.sort((a,b)=>b.dataset.ts.localeCompare(a.dataset.ts)));
  `, Object.assign(ctx, { __rows: tradeRows }));

  const probabilityHeads = Object.fromEntries(probBoxes.map(b => [b.dataset.model, b.head.textContent]));
  const staticProbabilityHeads = Object.fromEntries(
    [...html.matchAll(/data-model="([a-z0-9]+)">\s*<div class="probability-head"><span>[^<]*<\/span><strong>([^<]*)<\/strong>/g)].map(m => [m[1], m[2]]),
  );
  delete out["compoundHistory.innerHTML"];

  const hard = ids => Object.fromEntries(ids.map(id => [id, textById(id)]));
  const overview = id => {
    const m = new RegExp(`id="${id}">([^]*?)</div>\\s*(?:<div class="table-wrap">|</div>\\s*<div class="table-wrap">)`).exec(html);
    const block = m ? m[1] : "";
    return Object.fromEntries([...block.matchAll(/class="value-mini">([^<]*)<strong>([^<]*)<\/strong>/g)].map(x => [x[1].trim(), x[2].trim()]));
  };

  return {
    recommendations: pick(out, ["simpleProfit", "compoundProfit", "compoundNote", "compoundStock", "compoundStockNote",
      "quarterKellyProfit", "quarterKellyNote", "record", "winRate", "allCount", "settledStake", "openProfit"]),
    experience: pick(out, ["actualSettledProfit", "actualTotalStake", "actualOpenCount", "actualOpenProfit", "actualOpenNote"]),
    value1_hardcoded: {
      ...hard(["oddsSimpleProfit", "oddsCompoundProfit", "oddsCompoundNote", "oddsCompoundStock", "oddsKellyProfit", "oddsRecord", "oddsSettledStake", "oddsOpenCount"]),
      overview: overview("oddsTestOverview1"),
      notes: {
        simple: "$100固定・確定3件の仮想損益",
        record: "確定分 勝率66.7%",
        settledStake: "確定3件",
      },
    },
    value2_hardcoded: {
      ...hard(["odds2SimpleProfit", "odds2Roi", "odds2Record", "odds2Clv", "odds2LosingStreak", "odds2OpenCount"]),
      overview: overview("oddsTestOverview2"),
    },
    calibration: out.calibrationStatus,
    probability_heads_rendered: probabilityHeads,
    probability_heads_static_html: staticProbabilityHeads,
  };
}
function pick(obj, keys) { return Object.fromEntries(keys.map(k => [k, obj[k] ?? null])); }

// ── 2. legacy_rows：現行行データの読み取り（暫定解釈） ─────────────────
const NUMERIC_ODDS = /^\d+(?:\.\d+)?$/;
const STATUS_OF_SYMBOL = { "○": "win", "×": "loss", "△": "open" };
// data-ts にオフセットが無いものは JST として解釈（暫定。要確認）
const withJst = ts => (/(Z|[+-]\d{2}:\d{2})$/.test(ts) ? ts : `${ts}+09:00`);

// 推奨取引の重複候補（詳細IDの組）。同一試合・同一選択と判断したもの。削除はしない。
const REC_DUPLICATE_GROUPS = [
  ["detail-log-barca-rec", "detail-log-barca"],
  ["detail-lat-ger-rec", "detail-lat-ger"],
  ["detail-charlton-city-rec", "detail-cha-mci"],
  ["detail-smr-fin-rec", "detail-smr-fin"],
  ["detail-ag-lgd-rec", "detail-ag-lgd"],
  ["detail-fearx-cyb-rec", "detail-fearx"],
];

function legacyRecommendations() {
  return rowsOf("trade-row").map((r, i) => {
    const t = r.tds.map(strip);
    const odds = t[5];
    const dup = REC_DUPLICATE_GROUPS.findIndex(g => g.includes(r.dataset.target));
    return {
      legacy_index: i,
      detail_id: r.dataset.target ?? null,
      data_ts: r.dataset.ts,
      data_ts_has_offset: /(Z|[+-]\d{2}:\d{2})$/.test(r.dataset.ts),
      status: r.dataset.status,
      symbol: t[0],
      symbol_matches_status: STATUS_OF_SYMBOL[t[0]] === r.dataset.status,
      sport: t[2],
      match: strip(/class="match">([^]*?)<\/div>/.exec(r.tds[3])?.[1] ?? "").replace(/ ▼$/, ""),
      result_text: t[4],
      odds_text: odds,
      odds_taken_provisional: NUMERIC_ODDS.test(odds) ? Number(odds) : null,
      data_stake: Number(r.dataset.stake),
      data_payout: Number(r.dataset.payout),
      stake_cell: t[6], payout_cell: t[7], profit_cell: t[8],
      confidence: t[9] ?? null,
      locked_prob: r.dataset.lockedProb !== undefined ? Number(r.dataset.lockedProb) : null,
      duplicate_group: dup >= 0 ? dup + 1 : null,
    };
  });
}

function legacyExperience() {
  return rowsOf("actual-row").map((r, i) => {
    const t = r.tds.map(strip);
    return {
      legacy_index: i, data_ts: r.dataset.ts, status: r.dataset.status, symbol: t[0],
      match: strip(/class="match">([^]*?)<\/div>/.exec(r.tds[3])?.[1] ?? ""), bet: t[4],
      odds_text: t[5], odds_taken_provisional: NUMERIC_ODDS.test(t[5]) ? Number(t[5]) : null,
      data_stake: Number(r.dataset.stake), data_payout: Number(r.dataset.payout),
      payout_known: r.dataset.payoutKnown === "1",
    };
  });
}

// VALUE表の開始時刻「試合開始 9/26 00:00 JST」「試合開始 21:00 JST」→ ISO（暫定）
function startFrom(dateCell) {
  const date = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(dateCell);
  const withDate = /(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2}) JST/.exec(dateCell);
  const timeOnly = /(\d{2}):(\d{2}) JST/.exec(dateCell);
  const p = n => String(n).padStart(2, "0");
  if (withDate) return `2026-${p(withDate[1])}-${p(withDate[2])}T${withDate[3]}:${withDate[4]}:00+09:00`;
  if (date && timeOnly) return `${date[1]}-${p(date[2])}-${p(date[3])}T${timeOnly[1]}:${timeOnly[2]}:00+09:00`;
  return null;
}

function legacyValue(tableId, verdictOf) {
  const body = tableBody(tableId);
  const rows = [...body.matchAll(/<tr>\s*(<td class="result[^]*?)<\/tr>/g)].map(m => cells(m[1]));
  return rows.map((c, i) => {
    const t = c.map(strip);
    const badge = /value-badge (\w+)">([^<]*)</.exec(c[1]);
    const oddsText = t[5];
    const stakeText = t[tableId === "oddsTestTable" ? 9 : 10];
    const profitText = t[tableId === "oddsTestTable" ? 10 : 11];
    return {
      legacy_index: i,
      symbol: t[0],
      status: STATUS_OF_SYMBOL[t[0]],
      verdict_label: badge?.[2] ?? null,
      verdict: verdictOf(badge?.[1]),
      start_at_provisional: startFrom(c[2]),
      sport: t[3],
      match: strip(/class="match">([^]*?)<\/div>/.exec(c[4])?.[1] ?? ""),
      odds_text: oddsText,
      odds_taken_provisional: NUMERIC_ODDS.test(oddsText) ? Number(oddsText) : null,
      required_prob_text: t[6],
      estimated_prob_text: t[7],
      stake_text: stakeText,
      profit_text: profitText,
      cell_count: c.length,
    };
  });
}

// ── 3. expected：新ルールで再計算 ─────────────────────────
const LEGACY_SET_AT = "2026-09-26T06:45:58+09:00"; // 基準コミットの時刻
const legacyPick = ({ id, status, stake, odds, orderKey }) => ({
  id, stake, odds_taken: odds, market: "other", selection: "home",
  settlement_override: status === "open" ? null : { state: status, reason: "現行HTMLの結果記号", set_at: LEGACY_SET_AT, source: "legacy" },
  bet_at: null, locked_at: orderKey, discovered_at: null,
});
const settleLegacy = (p, notional = null) => settlePick(legacyPick(p), undefined, { notionalStake: notional });

function expectedRecommendations(rows) {
  const settle = rows.map(r => settleLegacy({ id: `legacy-rec-${r.legacy_index}`, status: r.status, stake: r.data_stake, odds: r.odds_taken_provisional, orderKey: withJst(r.data_ts) }));
  const firstOfDup = new Set();
  const dedup = settle.filter((_, i) => {
    const g = rows[i].duplicate_group;
    if (g == null) return true;
    if (firstOfDup.has(g)) return false;
    firstOfDup.add(g);
    return true;
  });
  const kellyItems = settle.map((s, i) => ({ settlement: s, prob: rows[i].locked_prob }));
  return {
    all_rows: summarize(settle),
    duplicates_counted_once_reference: summarize(dedup),
    compound: compound(settle, 100),
    quarter_kelly_locked_prob_only: quarterKelly(kellyItems, 100),
  };
}

function expectedExperience(rows) {
  const settle = rows.map(r => settleLegacy({ id: `legacy-exp-${r.legacy_index}`, status: r.status, stake: r.data_stake, odds: r.odds_taken_provisional, orderKey: withJst(r.data_ts) }));
  return { all_rows: summarize(settle) };
}

function expectedValue(rows, officialVerdicts, referenceVerdicts) {
  const toSettlement = (r, notional) => settleLegacy({
    id: `legacy-${r.legacy_index}`, status: r.status,
    stake: notional ? null : 100, odds: r.odds_taken_provisional, orderKey: r.start_at_provisional,
  }, notional ? REFERENCE_NOTIONAL_STAKE : null);
  const official = rows.filter(r => officialVerdicts.includes(r.verdict)).map(r => toSettlement(r, false));
  const reference = rows.filter(r => referenceVerdicts.includes(r.verdict)).map(r => toSettlement(r, true));
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return {
    verdict_counts: counts,
    official: summarize(official),
    official_compound: compound(official, 100),
    reference: summarize(reference),
    not_counted: rows.filter(r => !officialVerdicts.includes(r.verdict) && !referenceVerdicts.includes(r.verdict)).map(r => `${r.match}（${r.verdict_label}）`),
  };
}

// ── 実行 ───────────────────────────────────────────────
const legacy = {
  recommendations: legacyRecommendations(),
  experience: legacyExperience(),
  value1: legacyValue("oddsTestTable", c => ({ formal: "formal", conditional: "conditional", watch: "watch" })[c] ?? c ?? null),
  value2: legacyValue("oddsTestTable2", c => ({ formal: "adopted", watch: "watch" })[c] ?? c ?? null),
};

const baseline = {
  meta: {
    ref: REF,
    commit,
    captured_by: "baseline/capture-baseline.js",
    note: "displayed は現在の表示（正解ではない）。expected は legacy_rows を新ルールで再計算した期待値。条件付きVALUE の condition_met は現行データに記録がないため null（本成績に算入しない）として計算。",
  },
  displayed: reproduceDisplayed(),
  expected: {
    recommendations: expectedRecommendations(legacy.recommendations),
    experience: expectedExperience(legacy.experience),
    value1: expectedValue(legacy.value1, ["formal"], ["watch"]),
    value2: expectedValue(legacy.value2, ["adopted"], ["watch"]),
  },
  legacy_rows: legacy,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
console.log(`baseline を書き出しました: baseline/2026-09-26/baseline.json（${REF} = ${commit.slice(0, 7)}）`);
console.log(JSON.stringify({ displayed: baseline.displayed, expected: baseline.expected }, null, 2));
