// V2 表示用モデル。data/*.json と既存の計算ロジックだけから、画面に出す値をすべて組み立てる。
// ①推奨・②VALUE①・③VALUE②・経験値取引は既存の summarizeSystem / compound / quarterKelly をそのまま呼ぶだけ
// （判定・集計ロジックはここで変更・再実装しない）。④ PRO EDGE は④専用の summarizeProEdge を使う。
// 表示に手入力の数字は使わない。

import { summarizeSystem } from "../buckets.js";
import { compound, quarterKelly } from "../summary.js";
import { summarizeProEdge } from "../pro-edge/summary.js";
import { applyMatchUpdates, pendingReviews } from "../match-updates.js";

// ── データ品質（隠さずに表示する状態） ────────────────────────────
// level: ok=確認済み / warn=未確認・要確認 / info=試合前など
function quality(pick, match, extra = [], ctx = {}) {
  const q = [];
  for (const r of ctx.reviews?.get(match?.id) ?? []) {
    q.push({ key: "review", level: "warn", label: r.status === "review_required" ? "要確認（結果更新時）" : "結果 未確認（更新時に確認できず）", note: r.note });
  }
  const start = match?.start_time_status;
  if (start === "recorded") q.push({ key: "start", level: "ok", label: "開始時刻 確認済み" });
  else if (start === "review_required") q.push({ key: "start", level: "warn", label: "開始時刻 要確認（候補が食い違い）" });
  else if (start === "unverified") q.push({ key: "start", level: "warn", label: "開始時刻 未確認" });
  else q.push({ key: "start", level: "warn", label: "開始時刻 不明" });

  const odds = pick.odds_taken ?? pick.bet_odds ?? null;
  if (odds != null) q.push({ key: "odds", level: "ok", label: "オッズ 確認済み" });
  else if (pick.market_odds?.min != null && pick.market_odds?.max != null) q.push({ key: "odds", level: "warn", label: "オッズ レンジのみ（一点未確定）" });
  else if (pick.system !== "pro_edge") q.push({ key: "odds", level: "warn", label: "オッズ 未確認" });

  if (match?.status === "final") {
    q.push(match.flags?.includes("result_unverified")
      ? { key: "result", level: "warn", label: "結果 未確認" }
      : { key: "result", level: "ok", label: "結果 確認済み" });
  } else if (match?.status === "scheduled") {
    q.push(match.start_at && ctx.now && Date.parse(match.start_at) < Date.parse(ctx.now)
      ? { key: "result", level: "warn", label: "結果 未確認（開始時刻経過・未記録）" }
      : { key: "result", level: "info", label: "試合前" });
  } else if (match?.status === "abandoned" || match?.status === "cancelled" || match?.status === "postponed") {
    q.push({ key: "result", level: "info", label: `試合 ${{ abandoned: "中止（結果なし）", cancelled: "中止", postponed: "延期" }[match.status]}・無効（返金）` });
  } else if (match?.status === "unknown") q.push({ key: "result", level: "warn", label: "結果 未確認（開始済み・未記録）" });
  else if (match) q.push({ key: "result", level: "info", label: `試合状態 ${match.status}` });

  if (pick.flags?.includes("lock_unverified")) q.push({ key: "lock", level: "warn", label: "事前値 試合前の保存を確認できず" });
  else if (pick.locked_at) q.push({ key: "lock", level: "ok", label: "事前値 試合前に固定" });
  if (pick.flags?.includes("duplicate_review")) q.push({ key: "dup", level: "warn", label: "重複確認中" });
  if (pick.flags?.includes("analysis_independence_review")) q.push({ key: "indep", level: "warn", label: "独立性 要確認" });
  if (pick.condition) {
    q.push(pick.condition.met === true
      ? { key: "cond", level: "ok", label: "条件成立 確認済み" }
      : { key: "cond", level: "warn", label: pick.condition.met === false ? "条件 不成立" : "条件成立 未確認" });
  }
  if (pick.live) q.push({ key: "live", level: "info", label: "ライブ取引" });
  return [...q, ...extra];
}

// 選択側・市場の結果の表示用テキスト
function resultText(pick, match) {
  if (!match) return "試合事実なし";
  if (match.status === "scheduled") return "試合前";
  if (match.status === "unknown") return "未確定（結果未記録）";
  if (["cancelled", "postponed", "abandoned"].includes(match.status)) return `試合${match.status}`;
  return match.result?.text ?? (match.result?.final ? `${match.result.final.a}-${match.result.final.b}` : "結果あり");
}

function baseRow(pick, match, bucket, settlement, ctx) {
  return {
    id: pick.id,
    system: pick.system,
    bucket,
    settlement,
    match: match ? {
      id: match.id, sport: match.sport, competition: match.competition, region: match.region ?? null,
      card: `${match.side_a} vs ${match.side_b}`, side_a: match.side_a, side_b: match.side_b,
      start_at: match.start_at, start_time_status: match.start_time_status, start_candidates: match.start_candidates ?? [],
      start_time_note: match.start_time_note, status: match.status,
    } : null,
    selection: pick.selection,
    selection_label: pick.selection_label ?? (match ? { side_a: match.side_a, side_b: match.side_b, draw: "引分" }[pick.selection] : pick.selection),
    market: pick.market,
    market_label: pick.market_label ?? null,
    result_text: resultText(pick, match),
    odds_taken: pick.odds_taken ?? null,
    market_odds: pick.market_odds ?? null,
    stake: pick.stake,
    locked: pick.locked,
    locked_at: pick.locked_at,
    lock_evidence: pick.legacy?.lock_evidence ?? null,
    recalculated_reference: pick.recalculated_reference ?? [],
    condition: pick.condition ?? null,
    flags: pick.flags ?? [],
    quality: quality(pick, match, [], ctx),
    detail_ref: pick.detail_ref ?? null,
    legacy: pick.legacy ? { table: pick.legacy.table, row_index: pick.legacy.row_index, data_ts: pick.legacy.data_ts, raw: pick.legacy.raw } : null,
    closing_odds: pick.closing_odds ?? null,
  };
}

function systemRows(data, matchesById, summary, ctx, legacyAnalysis = null) {
  const analysisById = new Map((legacyAnalysis?.entries ?? []).map(e => [e.pick_id, e]));
  const byId = new Map();
  for (const [bucket, list] of Object.entries(summary.groups)) for (const g of list) byId.set(g.pick.id, { bucket, settlement: g.settlement });
  return data.picks.map(p => {
    const { bucket, settlement } = byId.get(p.id);
    const row = baseRow(p, matchesById.get(p.match_id), bucket, settlement, ctx);
    const la = analysisById.get(p.id);
    row.legacy_analysis = la ? { blocks: la.blocks, js_summary: la.js_summary, source: la.source } : null;
    return row;
  });
}

// 旧画面の並び順を維持：推奨は旧 data-ts の降順（旧 analysis.js と同じ文字列比較）、新規カードは試合開始時刻の降順
function recOrder(rows) {
  const key = r => r.legacy?.data_ts ?? r.settlement.orderKey ?? "";
  return [...rows].sort((a, b) => key(b).localeCompare(key(a)));
}
// VALUE①②は旧表の並び（行番号順）、新規カードはその後ろに試合開始順
const legacyOrder = rows => [...rows].sort((a, b) =>
  (a.legacy?.row_index ?? 1e9) - (b.legacy?.row_index ?? 1e9) || String(a.settlement.orderKey).localeCompare(String(b.settlement.orderKey)));

function calibrationLockedOnly(summary) {
  const items = summary.groups.official.filter(g => g.pick.locked?.prob != null && ["win", "loss"].includes(g.settlement.state));
  if (!items.length) return { count: 0, brier: null, log_loss: null };
  const clamp = p => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  const y = g => (g.settlement.state === "win" ? 1 : 0);
  return {
    count: items.length,
    brier: items.reduce((s, g) => s + (g.pick.locked.prob - y(g)) ** 2, 0) / items.length,
    log_loss: items.reduce((s, g) => s - (y(g) * Math.log(clamp(g.pick.locked.prob)) + (1 - y(g)) * Math.log(1 - clamp(g.pick.locked.prob))), 0) / items.length,
  };
}

const countBy = (rows, f) => rows.reduce((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});

// 複利は取引の順序で結果が変わる。各取引の投入時刻（bet_at）と前の試合の終了時刻が分からない限り、
// 「前の結果が出てから次に投入した」順序を証明できないので、参考値・順序未確定として扱う。
function compoundAudit(officialGroups) {
  const settled = officialGroups.filter(g => g.settlement.state === "win" || g.settlement.state === "loss");
  const reasons = [];
  const noBet = settled.filter(g => g.pick.bet_at == null).length;
  const noStart = settled.filter(g => g.match?.start_at == null).length;
  if (noBet) reasons.push(`投入時刻（bet_at）の記録がない取引 ${noBet}件`);
  if (noStart) reasons.push(`試合開始時刻が確定していない取引 ${noStart}件`);
  if (settled.length) reasons.push("試合の終了時刻を記録していないため、前の結果確定後に次を投入したことを確認できない");
  // 旧画面と同じ「旧 data-ts（登録時刻）順」での参考値
  const byRegistration = settled.map(g => ({ ...g.settlement, orderKey: g.pick.legacy?.sort_at ?? g.pick.bet_at ?? g.pick.locked_at ?? g.settlement.orderKey }));
  return {
    status: !settled.length ? "no_settled" : reasons.length ? "order_unconfirmed" : "confirmed",
    reasons,
    alternative_by_registration: compound(byRegistration, 100),
  };
}

export function buildViewModel(ds, { proEdgeConfig = {}, now = new Date().toISOString() } = {}) {
  // 試合事実 = matches.json（基準点＋人間確認）に、基準点後の更新ログを順に適用したもの
  const effectiveMatches = applyMatchUpdates(ds.matches, ds.match_updates);
  const matchesById = new Map(effectiveMatches.matches.map(m => [m.id, m]));
  const ctx = { now, reviews: pendingReviews(ds.match_updates) };
  const withMatch = groups => groups.map(g => ({ ...g, match: matchesById.get(g.pick.match_id) }));

  // ① 推奨取引
  const recSummary = summarizeSystem(ds.recommendations, matchesById);
  const recRows = recOrder(systemRows(ds.recommendations, matchesById, recSummary, ctx, ds.legacy_analysis_recommendations));
  const dupRows = recRows.filter(r => r.flags.includes("duplicate_review"));
  const recommendations = {
    summary: recSummary.official,
    compound: compound(recSummary.groups.official.map(g => g.settlement), 100),
    compound_audit: compoundAudit(withMatch(recSummary.groups.official)),
    kelly: quarterKelly(recSummary.groups.official.map(g => ({ settlement: g.settlement, prob: g.pick.locked?.prob ?? null })), 100),
    calibration: calibrationLockedOnly(recSummary),
    duplicates: { rows: dupRows.length, groups: new Set(dupRows.map(r => `${r.match?.id}|${r.market}|${r.selection}`)).size },
    rows: recRows,
  };

  // 経験値取引（実投入。分析系統ではない）
  const expSummary = summarizeSystem(ds.experience, matchesById);
  const experience = { summary: expSummary.official, rows: recOrder(systemRows(ds.experience, matchesById, expSummary, ctx)) };

  // ② VALUE① / ③ VALUE②（本成績と参考成績は別集計）
  const valueView = (data, legacyAnalysis) => {
    const s = summarizeSystem(data, matchesById);
    const rows = legacyOrder(systemRows(data, matchesById, s, ctx, legacyAnalysis));
    return {
      official: s.official,
      official_compound: compound(s.groups.official.map(g => g.settlement), 100),
      compound_audit: compoundAudit(withMatch(s.groups.official)),
      reference: s.reference,
      conditional_unmet: s.conditionalUnmet,
      verdict_counts: s.verdictCounts,
      bucket_counts: countBy(rows, r => r.bucket),
      excluded_log: data.excluded_log ?? [],
      rows,
    };
  };
  const value1 = valueView(ds.value1, ds.legacy_analysis_value1);
  const value2 = valueView(ds.value2, ds.legacy_analysis_value2);

  // ④ PRO EDGE
  const pe = summarizeProEdge(ds.pro_edge, matchesById, proEdgeConfig);
  const peRows = [];
  for (const [bucket, list] of Object.entries(pe.groups)) {
    for (const g of list) {
      const match = matchesById.get(g.pick.match_id);
      const row = baseRow(g.pick, match, bucket, g.settlement, ctx);
      row.analysis = g.analysis;
      row.quality = quality(g.pick, match, [
        { key: "conf", level: g.pick.locked?.data_confidence === "high" ? "ok" : "warn", label: `データ信頼度 ${g.pick.locked?.data_confidence ?? "—"}` },
        ...(g.analysis.clv.status !== "ok" && bucket === "official" ? [{ key: "clv", level: "info", label: "CLV 未計算" }] : []),
      ], ctx);
      row.features = Object.fromEntries((g.pick.locked?.features ?? []).map(f => [f.name, f]));
      row.bet_odds = g.pick.bet_odds ?? null;
      peRows.push(row);
    }
  }
  peRows.sort((a, b) => String(b.settlement.orderKey).localeCompare(String(a.settlement.orderKey)));
  const pro_edge = {
    decision_counts: pe.decision_counts,
    official: pe.official,
    reference: pe.reference,
    evaluation: pe.evaluation,
    rows: peRows,
  };

  return {
    meta: {
      as_of: ds.matches.meta?.as_of ?? null,
      status: ds.matches.meta?.status ?? null,
      update_runs: effectiveMatches.update_runs ?? [],
      now,
      demo: ds.__demo === true,
    },
    recommendations, experience, value1, value2, pro_edge,
    legacy_unassigned: ds.legacy_unassigned?.excluded_log ?? [],
  };
}
