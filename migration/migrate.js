// 手順2：旧 analysis.html（baseline-2026-09-26）から data/*.json の移行用下書きを生成する。
//
// 入力
//   baseline/2026-09-26/baseline.json … 旧行データ（legacy_rows）
//   migration/history-report.json     … Git履歴の値の変遷（node migration/scan-history.js で生成）
//   migration/legacy-map.js           … 試合・市場・選択の対応表（手作業）
//   git show baseline-2026-09-26:analysis.html / analysis.js
// 出力
//   data/matches.json, recommendations.json, experience.json, value1.json, value2.json
//
// 事前値の扱い（確定ルール）
//   locked_at は「今の事前値が、試合開始前のコミットから変わらず保存されていた」と Git 履歴で確認できた場合だけ設定する。
//   確認できないカードは locked_at=null・lock_unverified とし、推定確率・EV は null にする。
//   現行モデルでの再計算値は recalculated_reference にだけ入れる（事前確率として扱わない）。
//   払戻し・純損益・戦績などの導出値は保存しない。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/load-node.js";
import { MATCHES, PICKS, VALUE2_EXCLUDED_LOG_TEXT } from "./legacy-map.js";
import { HUMAN_REVIEW_RUN, HUMAN_REVIEW_CHANGES } from "./human-review-2026-09-26.js";

const REF = "baseline-2026-09-26";
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const COMMIT = git("rev-parse", "--short=7", `${REF}^{commit}`).trim();
const AS_OF = git("show", "-s", "--format=%cI", `${REF}^{commit}`).trim();              // 2026-09-26T06:45:58+09:00
const html = git("show", `${REF}:analysis.html`);
const js = git("show", `${REF}:analysis.js`);
const baseline = JSON.parse(readFileSync(join(ROOT, "baseline/2026-09-26/baseline.json"), "utf8"));
const history = JSON.parse(readFileSync(join(ROOT, "migration/history-report.json"), "utf8"));
if (history.end !== REF) throw new Error("history-report.json の終点が基準タグと違います");

const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const ms = s => Date.parse(s);
const DUPLICATE_SLUGS = [
  ["log-barca-rec", "log-barca"], ["lat-ger-rec", "lat-ger"], ["charlton-city-rec", "cha-mci"],
  ["smr-fin-rec", "smr-fin"], ["ag-lgd-rec", "ag-lgd"], ["fearx-cyb-rec", "fearx"],
];
const PLACEHOLDER_TS = new Set(["2026-09-26T00:00:00+09:00", "2026-09-26T00:01:00+09:00"]);

// ── 旧HTMLの補足情報（市場表記・開始表記・詳細の格差スコア・静的確率表示） ─────────
function htmlRows(cls) {
  return [...html.matchAll(new RegExp(`<tr class="${cls}"([^>]*)>([^]*?)</tr>`, "g"))].map(m => {
    const inner = m[2];
    const target = (/data-target="([^"]+)"/.exec(m[1]) ?? [])[1] ?? null;
    const detail = target ? (new RegExp(`<tr class="detail-row" id="${target}">([^]*?)(?=<tr class="|</tbody>)`).exec(html) ?? [])[1] ?? "" : "";
    return {
      market_text: strip((/class="market">([^]*?)<\/div>/.exec(inner) ?? [])[1] ?? "") || null,
      start_text: strip((/class="start-jst">([^]*?)<\/div>/.exec(inner) ?? [])[1] ?? "") || null,
      gap: Number((/格差(?:スコア)?(?:<\/?[a-z]+>|[：:\s])*(\d{2,3})/.exec(detail) ?? [])[1]) || null,
      static_prob: strip((/class="probability-head">\s*<span>[^<]*<\/span>\s*<strong>([^<]*)<\/strong>/.exec(detail) ?? [])[1] ?? "") || null,
    };
  });
}
function valueHtmlRows(tableId) {
  const body = new RegExp(`<table id="${tableId}">[^]*?<tbody>([^]*?)</tbody>`).exec(html)[1];
  return [...body.matchAll(/<tr>\s*(<td class="result[^]*?)<\/tr>/g)].map(m => ({
    markets: [...m[1].matchAll(/class="market">([^]*?)<\/div>/g)].map(x => strip(x[1])),
    start_text: strip((/class="start-jst">([^]*?)<\/div>/.exec(m[1]) ?? [])[1] ?? "") || null,
  }));
}
const extra = {
  recommendations: htmlRows("trade-row"),
  experience: htmlRows("actual-row"),
  value1: valueHtmlRows("oddsTestTable"),
  value2: valueHtmlRows("oddsTestTable2"),
};

// ── 現行モデル v5.1 の再計算（参考値。事前確率ではない） ─────────────────
const ctx = vm.createContext({ document: { addEventListener() {} }, Math, Number, String, Date, Object });
vm.runInContext(js, ctx);
const recalculated = key => vm.runInContext(`bayesEstimate(probabilityModels[${JSON.stringify(key)}]).p`, ctx);
const MODEL_VERSION = vm.runInContext("MODEL_VERSION", ctx);

// ── Git履歴による事前固定の確認 ───────────────────────────────
const norm = v => (v == null || v === "" || v === "—" ? null : v);
// 推奨取引の事前値：オッズ・信頼度・格差スコア・locked確率・確率表示。
// 列は履歴の途中で増えている（9/24 02:21 種目、02:46 結果内容、9/25 21:26 信頼度）。
// 9列以上ある版はオッズ＝6列目。それより前の版は投入額セル（$…）の直前をオッズとして読む。信頼度は10列目。
// 投入額は比較しない（9/26 03:02 に「未設定」→$100 へ一律統一された運用変更のため）。
function recSig(e) {
  const t = e.row.tds;
  const stakeAt = t.findIndex(v => /^\$\d/.test(v));
  const odds = t.length >= 9 ? t[5] : stakeAt > 0 ? t[stakeAt - 1] : null;
  const conf = t.length >= 10 ? t[9] : null;
  return JSON.stringify({ odds: norm(odds), conf: norm(conf), gap: norm(e.row.gap), locked: norm(e.row.locked_prob), head: norm(e.row.prob_head) });
}
function expSig(e) { return JSON.stringify({ odds: norm(e.row.tds[5]), stake: e.row.stake }); }
// VALUE①: 取得オッズ・必要勝率・推定勝率・推定EV・投入 / VALUE②: 取得オッズ・必要勝率・推定勝率・市場差・Upset Risk・投入
// （結果・収益・Closing の列は試合後に書き換わるので比較に含めない）
const valueSig = system => e => {
  const t = e.row.tds, off = /^[○×△]$/.test(t[0]) ? 1 : 0;
  const pre = { verdict: e.row.verdict, odds: t[4 + off], req: t[5 + off], est: t[6 + off] };
  return JSON.stringify(system === "value1"
    ? { ...pre, ev: t[7 + off], stake: t[8 + off] }
    : { ...pre, gap: t[7 + off], risk: t[8 + off], stake: t[9 + off] });
};
// 今の値が導入されたコミット（それ以降、基準点まで不変）と、それが試合開始前かどうか
function lockFromHistory(key, sigFn, match) {
  const startAt = lockStart(match);
  const startNote = reviewedStart.has(match.id) ? `（開始時刻は人間確認 ${HUMAN_REVIEW_RUN.run_id} で確定）`
    : match.start_time_status === "review_required" ? `（開始時刻は要確認。候補 ${match.start_candidates.join(" / ")} のいずれよりも前かで判定）` : "";
  const entries = history.rows[key];
  if (!entries?.length) return { first_seen_at: null, first_seen_commit: null, locked_at: null, verified: false, evidence: `履歴キー ${key} が見つからない` };
  const sigs = entries.map(sigFn);
  let i = sigs.length - 1;
  while (i > 0 && sigs[i - 1] === sigs.at(-1)) i--;
  const since = entries[i];
  const base = { first_seen_at: entries[0].time, first_seen_commit: entries[0].sha };
  if (!startAt) {
    return { ...base, locked_at: null, verified: false,
      evidence: `現在の事前値は ${since.sha}（${since.time}）から保存。試合開始時刻が未確認のため、試合前の保存か確認できない` };
  }
  if (ms(since.time) < ms(startAt)) {
    return { ...base, locked_at: since.time, verified: true,
      evidence: `現在の事前値は ${since.sha}（${since.time}）から基準点まで不変。試合開始 ${startAt} より前${startNote}` };
  }
  return { ...base, locked_at: null, verified: false,
    evidence: `現在の事前値の保存は ${since.sha}（${since.time}）で、試合開始 ${startAt} より後${startNote}` };
}

// ── 値の解析 ─────────────────────────────────────────────
const NUMERIC = /^\d+(?:\.\d+)?$/;
function marketOdds(text) {
  if (!text || NUMERIC.test(text)) return null;
  const r = /(\d+(?:\.\d+)?)\s*[〜~]\s*(\d+(?:\.\d+)?)/.exec(text);
  return { text, min: r ? Number(r[1]) : null, max: r ? Number(r[2]) : null, observed_at: null, source: "旧analysis.html" };
}
const oddsTaken = text => (text && NUMERIC.test(text) ? Number(text) : null);
function pctRange(text) {
  const r = /([+-]?\d+(?:\.\d+)?)\s*〜\s*([+-]?\d+(?:\.\d+)?)\s*%/.exec(text ?? "");
  return r ? [Number(r[1]) / 100, Number(r[2]) / 100] : [null, null];
}
const pctSingle = text => (/^\d+(?:\.\d+)?%$/.test(text ?? "") ? Number(text.slice(0, -1)) / 100 : null);
function ptRange(text) {
  const r = /([+-]?\d+(?:\.\d+)?)\s*〜\s*([+-]?\d+(?:\.\d+)?)\s*pt/.exec(text ?? "");
  return r ? [Number(r[1]), Number(r[2])] : [null, null];
}
const UPSET = { "低": "low", "中": "mid", "中〜高": "mid_high", "高": "high" };
const round4 = x => (x == null ? null : Math.round(x * 10000) / 10000);
const withJst = ts => (/(Z|[+-]\d{2}:\d{2})$/.test(ts) ? ts : `${ts}+09:00`);

// ── matches.json ─────────────────────────────────────────
// 1) 基準点（06:45）の状態をそのまま作る → provenance の最初は baseline_migration
const BASELINE_RUN = {
  run_id: "mr-baseline-2026-09-26", kind: "baseline_migration", at: AS_OF,
  source: `analysis.html@${COMMIT}（${REF}）`,
  note: "旧RMCからの移行基準点。06:45 以降に判明した結果はここへ後付けしない",
};
const matchById = new Map();
const matches = MATCHES.map(m => {
  const out = {
    id: m.id, sport: m.sport, competition: m.competition,
    side_a: m.side_a, side_b: m.side_b, home_side: m.home_side ?? "unknown", venue: m.venue ?? null,
    start_at: m.start ?? null,
    start_time_status: m.start ? "recorded" : m.start_time_status,
    ...(m.start_candidates ? { start_candidates: m.start_candidates } : {}),
    start_time_note: m.start_time_note ?? null,
    status: m.status, result: m.result,
    provenance: [{ update_run_id: BASELINE_RUN.run_id, changes: [], note: "基準点の状態" }],
    sources: [`analysis.html@${COMMIT}`],
    verified_at: null,
    flags: ["legacy_import", ...(m.flags ?? []), ...(m.start ? [] : ["time_unverified"])],
    note: m.note ?? null,
  };
  matchById.set(m.id, out);
  return out;
});

// 2) 基準点の後の人間確認を、別の更新回として before/after 付きで重ねる
const reviewedStart = new Set();
for (const [id, { set, note }] of Object.entries(HUMAN_REVIEW_CHANGES)) {
  const m = matchById.get(id);
  if (!m) throw new Error(`人間確認の対象 ${id} が matches にない`);
  const changes = [];
  const after = { ...set };
  if (after.start_at) after.flags = (after.flags ?? m.flags).filter(f => f !== "time_unverified");
  for (const [field, value] of Object.entries(after)) {
    changes.push({ field, before: m[field] ?? null, after: value });
    m[field] = value;
  }
  if (set.start_at) { delete m.start_candidates; reviewedStart.add(id); }
  m.verified_at = HUMAN_REVIEW_RUN.at;
  m.sources.push(HUMAN_REVIEW_RUN.source);
  m.provenance.push({ update_run_id: HUMAN_REVIEW_RUN.run_id, changes, note });
}

// 事前固定の判定に使う開始時刻：確定していれば start_at、要確認なら最も早い候補（どの候補より前かを保守的に判定）
function lockStart(match) {
  if (match.start_at) return match.start_at;
  if (match.start_time_status === "review_required") {
    return match.start_candidates.reduce((a, b) => (ms(a) <= ms(b) ? a : b));
  }
  return null;
}

// ── カード共通 ──────────────────────────────────────────
function basePick(system, prefix, idx, map, fields) {
  const match = matchById.get(map.match);
  if (!match) throw new Error(`${system}#${idx}: 試合 ${map.match} が MATCHES にない`);
  return {
    id: `${prefix}legacy-${map.slug}`,
    system,
    match_id: map.match,
    market: map.market,
    market_label: fields.market_label ?? null,
    selection: map.selection,
    selection_label: map.label,
    market_odds: fields.market_odds ?? null,
    odds_taken: fields.odds_taken ?? null,
    stake: fields.stake,
    discovered_at: null,
    run_id: fields.run_id,
    bet_at: null,
    locked_at: fields.lock.locked_at,
    ...(map.live ? { live: true } : {}),
    locked: fields.locked,
    ...(fields.condition ? { condition: fields.condition } : {}),
    closing_odds: null,
    recalculated_reference: fields.recalculated_reference ?? [],
    settlement_override: null,
    flags: [...new Set([
      "legacy_import",
      ...(fields.lock.locked_at ? [] : ["lock_unverified"]),
      ...(match.start_at ? [] : ["time_unverified"]),
      ...(fields.odds_taken == null ? ["odds_unverified"] : []),
      ...(match.flags.includes("result_unverified") ? ["result_unverified"] : []),
      ...(fields.flags ?? []),
    ])],
    detail_ref: fields.detail_ref ?? null,
    note: fields.note ?? null,
    legacy: {
      source: "analysis.html",
      commit: COMMIT,
      table: fields.table,
      row_index: idx,
      detail_id: fields.detail_ref ?? null,
      data_ts: fields.data_ts ?? null,
      sort_at: fields.sort_at ?? null,
      first_seen_at: fields.lock.first_seen_at,
      first_seen_commit: fields.lock.first_seen_commit,
      lock_evidence: fields.lock.evidence,
      raw: fields.raw,
    },
  };
}
const legacyRun = (prefix, label) => ({
  run_id: `${prefix}legacy-import`, started_at: AS_OF, slot: "adhoc",
  note: `${label}：旧RMC（${COMMIT}）からの一括移行用。実際の探索回・探索時刻は記録がない。系統ごとに別の移行用探索回として扱う（他系統と共有しない）`,
});
const stakeHistory = key => [...new Set((history.rows[key] ?? []).map(e => e.row.stake).filter(v => v != null))];

// ── recommendations.json ────────────────────────────────
const recPicks = baseline.legacy_rows.recommendations.map(r => {
  const map = PICKS.recommendations[r.legacy_index];
  const x = extra.recommendations[r.legacy_index];
  const match = matchById.get(map.match);
  const key = r.detail_id ? `target:${r.detail_id}` : `match:resultTable:${r.match}`;
  const lock = lockFromHistory(key, recSig, match);
  const lockedProb = r.locked_prob;
  const dup = DUPLICATE_SLUGS.some(g => g.includes(map.slug));
  const raw = {
    date_and_start_text: x.start_text, market_text: x.market_text, odds_text: r.odds_text,
    result_text: r.result_text, confidence_text: r.confidence, data_status: r.status,
    stake_history: stakeHistory(key),
  };
  if (x.static_prob) raw.static_probability_text = x.static_prob;
  if (lockedProb != null) raw[lock.verified ? "data_locked_prob" : "data_locked_prob_unverified"] = lockedProb;
  return basePick("recommendations", "rec-", r.legacy_index, map, {
    table: "resultTable",
    run_id: "rec-legacy-import",
    market_label: x.market_text,
    market_odds: marketOdds(r.odds_text),
    odds_taken: oddsTaken(r.odds_text),
    stake: r.data_stake,
    lock,
    locked: {
      // 事前確率は「試合前に保存された locked 値」を確認できた場合だけ（第1優先）。確認できなければ null。
      prob: lock.verified && lockedProb != null ? lockedProb : null,
      gap_score: x.gap,
      confidence: norm(r.confidence),
      model_version: null,
      summary: null,
    },
    recalculated_reference: map.model ? [{
      at: AS_OF, model_version: MODEL_VERSION, prob: round4(recalculated(map.model)),
      note: `旧analysis.js v${MODEL_VERSION} の bayesEstimate で再計算した参考値。事前確率ではない`,
    }] : [],
    detail_ref: r.detail_id,
    data_ts: r.data_ts,
    sort_at: PLACEHOLDER_TS.has(withJst(r.data_ts)) ? null : withJst(r.data_ts),
    flags: [
      ...(dup ? ["duplicate_review"] : []),
      ...(PLACEHOLDER_TS.has(withJst(r.data_ts)) ? ["time_unverified"] : []),
      ...(r.data_ts_has_offset ? [] : ["time_unverified"]),
    ],
    note: map.live ? "旧表記「前半17分頃・0-0でベット」のライブ取引。投入時刻の正確な記録なし" : null,
    raw,
  });
});

// ── experience.json ─────────────────────────────────────
const expPicks = baseline.legacy_rows.experience.map(r => {
  const map = PICKS.experience[r.legacy_index];
  const x = extra.experience[r.legacy_index];
  const match = matchById.get(map.match);
  const key = `match:actualBetTable:${r.match}`;
  const lock = lockFromHistory(key, expSig, match);
  return basePick("experience", "exp-", r.legacy_index, map, {
    table: "actualBetTable",
    run_id: null,
    market_label: r.bet,
    odds_taken: oddsTaken(r.odds_text),
    market_odds: marketOdds(r.odds_text),
    stake: r.data_stake,
    lock,
    locked: { summary: null },
    data_ts: r.data_ts,
    sort_at: withJst(r.data_ts),
    raw: { date_and_start_text: x.start_text, market_text: x.market_text, bet_text: r.bet, odds_text: r.odds_text, data_status: r.status, stake_history: stakeHistory(key) },
  });
});

// ── value1.json / value2.json ───────────────────────────
function valuePicks(system, prefix, table) {
  return baseline.legacy_rows[system].map(r => {
    const map = PICKS[system][r.legacy_index];
    const x = extra[system][r.legacy_index];
    const match = matchById.get(map.match);
    const lock = lockFromHistory(`match:${table}:${r.match}`, valueSig(system), match);
    const [probLo, probHi] = pctRange(r.estimated_prob_text);
    const lockedValues = system === "value1" ? (() => {
      const [evLo, evHi] = pctRange(history.rows[`match:${table}:${r.match}`].at(-1).row.tds[8]);
      return {
        verdict: r.verdict,
        prob_lo: lock.verified ? probLo : null, prob_hi: lock.verified ? probHi : null, prob_point: null,
        required_prob: lock.verified ? pctSingle(r.required_prob_text) : null,
        ev_lo: lock.verified ? evLo : null, ev_hi: lock.verified ? evHi : null,
        gap_score: null, model_version: null, summary: null,
      };
    })() : (() => {
      const t = history.rows[`match:${table}:${r.match}`].at(-1).row.tds;
      const [gapLo, gapHi] = ptRange(t[8]);
      return {
        verdict: r.verdict,
        prob_lo: lock.verified ? probLo : null, prob_hi: lock.verified ? probHi : null, prob_point: null,
        required_prob: lock.verified ? pctSingle(r.required_prob_text) : null,
        market_gap_lo: lock.verified ? gapLo : null, market_gap_hi: lock.verified ? gapHi : null,
        upset_risk: UPSET[t[9]] ?? null,
        model_version: null, summary: null,
      };
    })();
    // 本成績に入る判定（正式・採用・条件付き）は $100、監視・除外は stake なし（参考成績は $100 仮定で計算）
    const official = ["formal", "conditional", "adopted"].includes(r.verdict);
    const tds = history.rows[`match:${table}:${r.match}`].at(-1).row.tds;
    return basePick(system, prefix, r.legacy_index, map, {
      table,
      run_id: `${prefix}legacy-import`,
      market_label: x.markets[0] ?? null,
      market_odds: marketOdds(r.odds_text),
      odds_taken: oddsTaken(r.odds_text),
      stake: official ? 100 : null,
      lock,
      locked: lockedValues,
      condition: map.condition ? { text: map.condition.text, min_odds: map.condition.min_odds, met: null, checked_at: null } : null,
      flags: [...(map.condition ? ["needs_review"] : []), ...(map.flags ?? [])],
      note: map.condition ? "条件成立（1.25以上で取得できたか）の記録がないため met=null。本成績に算入しない" : null,
      data_ts: null,
      sort_at: null,
      raw: {
        verdict_label: r.verdict_label, date_and_start_text: x.start_text, market_texts: x.markets,
        odds_text: r.odds_text, required_prob_text: r.required_prob_text, estimated_prob_text: r.estimated_prob_text,
        ev_or_gap_text: tds[8] ?? null, ...(system === "value2" ? { upset_risk_text: tds[9] ?? null } : {}),
        stake_text: r.stake_text,
      },
    });
  });
}

// ── 書き出し ─────────────────────────────────────────────
const meta = label => ({
  generated_by: "migration/migrate.js",
  legacy_source: "analysis.html",
  legacy_commit: COMMIT,
  as_of: AS_OF,
  status: "draft",
  note: `${label}：旧RMC（${REF}）からの移行用下書き。analysis.html は未切り替え。`,
});

const slugOf = label => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const out = {
  matches: { schema_version: 1, meta: meta("試合事実"), update_runs: [BASELINE_RUN, HUMAN_REVIEW_RUN], matches },
  recommendations: { schema_version: 1, meta: meta("推奨取引"), system: "recommendations", discovery_runs: [legacyRun("rec-", "推奨取引")], picks: recPicks },
  experience: { schema_version: 1, meta: meta("経験値取引"), system: "experience", picks: expPicks },
  value1: { schema_version: 1, meta: meta("VALUE①"), system: "value1", discovery_runs: [legacyRun("v1-", "VALUE①")], excluded_log: [], picks: valuePicks("value1", "v1-", "oddsTestTable") },
  value2: { schema_version: 1, meta: meta("VALUE②"), system: "value2", discovery_runs: [legacyRun("v2-", "VALUE②")], excluded_log: [], picks: valuePicks("value2", "v2-", "oddsTestTable2") },
  // ④ PRO EDGE は新設の独立系統。旧RMCに該当データは無いので、空の下書きとして作る（架空のカードは入れない）
  pro_edge: {
    schema_version: 1,
    meta: { ...meta("④ PRO EDGE｜プロ型価格分析"), note: "④ PRO EDGE：新設の独立分析系統。旧RMCに対応するデータは無いため空。候補は④自身の探索回（pe-…）で独立に追加する。analysis.html は未切り替え。" },
    system: "pro_edge", discovery_runs: [], picks: [],
  },
  // 旧HTMLの配置だけではどの系統の除外か確定できない記録（どの系統にも帰属させない）
  legacy_unassigned: {
    schema_version: 1, meta: meta("系統未確定の旧データ"),
    excluded_log: VALUE2_EXCLUDED_LOG_TEXT.split(" / ").map(label => ({
      id: `legacy-unassigned-${slugOf(label)}`,
      label,
      system_assignment: "unknown",
      candidate_systems: ["value1", "value2"],
      reason: "旧HTMLでは VALUE② 欄の「深掘りで除外」に記載。配置だけでは VALUE①・VALUE② のどちらの除外か確定できないため要確認",
      legacy: { source: "analysis.html", commit: COMMIT, location: "#oddsTestArea2 .excluded-log（深掘りで除外）", text: VALUE2_EXCLUDED_LOG_TEXT },
    })),
  },
};

mkdirSync(join(ROOT, "data"), { recursive: true });
const FILES = {
  matches: "matches.json", recommendations: "recommendations.json", experience: "experience.json",
  value1: "value1.json", value2: "value2.json", legacy_unassigned: "legacy-unassigned.json", pro_edge: "pro_edge.json",
};
for (const [k, f] of Object.entries(FILES)) writeFileSync(join(ROOT, "data", f), JSON.stringify(out[k], null, 2) + "\n");

// 基準点より前に旧HTMLから削除されていた行（本データへは復元しない。参照用の記録のみ）
const removed = Object.entries(history.rows)
  .filter(([, list]) => (list.at(-1).last_seen ?? list.at(-1).time) !== AS_OF)
  .map(([key, list]) => {
    const last = list.at(-1);
    return {
      key, match: last.row.match, table: last.row.table,
      first_seen_at: list[0].time, last_seen_at: last.last_seen ?? last.time,
      last_status_symbol: last.row.symbol, last_cells: last.row.tds,
    };
  });
mkdirSync(join(ROOT, "migration", "archive"), { recursive: true });
writeFileSync(join(ROOT, "migration", "archive", "removed-before-baseline.json"), JSON.stringify({
  note: "基準点（baseline-2026-09-26）の時点で旧HTMLに存在しなかった行。行の組み替え（列追加・ID付与）で消えた旧表記も含む。本データ（data/*.json）へは復元しない",
  rows: removed,
}, null, 2) + "\n");

console.log(`data/*.json を生成しました（${REF} = ${COMMIT}）`);
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${(v.picks ?? v.matches ?? v.excluded_log).length} 件`);
console.log(`  基準点前に削除済みの行（archive のみ）: ${removed.length} 件`);
