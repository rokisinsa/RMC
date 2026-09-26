// 移行基準点より後の試合事実の更新ログ（data/match-updates.json）を matches.json に重ねる。
// matches.json（基準点＋人間確認）は変更しない。更新回ごとに before/after を provenance へ記録した「実効の試合事実」を返す。

import { toMs } from "./time.js";
import { deepEqual } from "./schema-validate.js";
import { checkMatches } from "./integrity.js";

const issue = (level, code, id, message) => ({ level, code, system: "match_updates", id, message });

// 実効の試合事実（元データは変更しない）
export function applyMatchUpdates(matchesData, updatesData) {
  const out = structuredClone(matchesData);
  if (!updatesData?.runs?.length) return out;
  const byId = new Map(out.matches.map(m => [m.id, m]));
  for (const run of updatesData.runs) {
    out.update_runs.push({ run_id: run.run_id, kind: run.kind, at: run.at, source: run.source, note: run.note ?? null });
    for (const c of run.changes) {
      const m = byId.get(c.match_id);
      if (!m) continue;                                   // 検査で error になる
      const changes = Object.entries(c.set).map(([field, after]) => ({ field, before: m[field] ?? null, after }));
      for (const [field, value] of Object.entries(c.set)) m[field] = structuredClone(value);
      if ("start_at" in c.set && c.set.start_at && !("start_candidates" in c.set)) delete m.start_candidates;
      m.flags = (m.flags ?? []).filter(f => !(f === "time_unverified" && m.start_at) && !(f === "result_unverified" && "result" in c.set));
      m.verified_at = c.evidence.verified_at;
      m.sources = [...(m.sources ?? []), ...c.evidence.sources.map(s => `${s.name} ${s.url}`)];
      m.provenance.push({ update_run_id: run.run_id, changes, note: c.evidence.note ?? null });
    }
  }
  return out;
}

// 要確認（結果を入れなかった試合）の一覧：match_id → [{ run_id, status, note }]
export function pendingReviews(updatesData) {
  const map = new Map();
  for (const run of updatesData?.runs ?? []) {
    for (const r of run.reviews) {
      if (!map.has(r.match_id)) map.set(r.match_id, []);
      map.get(r.match_id).push({ run_id: run.run_id, status: r.status, note: r.note });
    }
  }
  return map;
}

export function checkMatchUpdates(matchesData, updatesData) {
  const out = [];
  if (!updatesData) return out;
  const ids = new Set(matchesData.matches.map(m => m.id));
  const runIds = new Set(matchesData.update_runs.map(r => r.run_id));
  const baseAt = Math.max(...matchesData.update_runs.map(r => toMs(r.at)));
  let prevAt = baseAt;
  for (const run of updatesData.runs) {
    if (runIds.has(run.run_id)) out.push(issue("error", "UPDATE_RUN_ID_DUPLICATE", run.run_id, "更新回の run_id が重複"));
    runIds.add(run.run_id);
    if (toMs(run.at) < prevAt) out.push(issue("error", "UPDATE_RUN_ORDER", run.run_id, "更新回は時刻順に追記する（基準点・前回より前の更新回は不可）"));
    prevAt = Math.max(prevAt, toMs(run.at));
    for (const c of [...run.changes, ...run.reviews]) {
      if (!ids.has(c.match_id)) out.push(issue("error", "UPDATE_MATCH_UNKNOWN", run.run_id, `match_id ${c.match_id} が matches.json にない`));
    }
    for (const c of run.changes) {
      const s = c.set;
      if (!Object.keys(s).length) out.push(issue("error", "UPDATE_EMPTY", run.run_id, `${c.match_id}：変更内容がない`));
      if (s.status === "final" && !s.result) {
        const base = matchesData.matches.find(m => m.id === c.match_id);
        if (!base?.result) out.push(issue("error", "UPDATE_FINAL_WITHOUT_RESULT", run.run_id, `${c.match_id}：final にするなら結果が必要`));
      }
      if (toMs(c.evidence.verified_at) > toMs(run.at)) out.push(issue("error", "UPDATE_VERIFIED_AFTER_RUN", run.run_id, `${c.match_id}：確認時刻が更新回より後`));
    }
  }
  // 適用後の試合事実も通常の検査を通ること
  for (const i of checkMatches(applyMatchUpdates(matchesData, updatesData))) out.push({ ...i, message: `（更新適用後）${i.message}` });
  return out;
}

// 更新ログは追記のみ（前バージョンの runs が先頭にそのまま残っていること）
export function checkMatchUpdatesAppendOnly(prev, next) {
  if (!prev) return [];
  const p = prev.runs ?? [], n = next?.runs ?? [];
  if (n.length < p.length || p.some((r, i) => !deepEqual(r, n[i]))) {
    return [issue("error", "UPDATE_LOG_REWRITTEN", null, "match-updates.json は追記のみ（既存の更新回を変更・削除しない）")];
  }
  return [];
}
