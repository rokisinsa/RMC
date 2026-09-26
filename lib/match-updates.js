// 移行基準点より後の試合事実の更新ログ（data/match-updates.json）を matches.json に重ねる。
// matches.json（基準点＋人間確認）は変更しない。更新回ごとに before/after を provenance へ記録した「実効の試合事実」を返す。

import { toMs } from "./time.js";
import { deepEqual } from "./schema-validate.js";
import { checkMatches } from "./integrity.js";

const issue = (level, code, id, message) => ({ level, code, system: "match_updates", id, message });

// 結果ソースの品質ルールの適用開始（最初の更新回 mr-2026-09-26-1937 はルール制定前のため対象外）
export const SOURCE_RULES_EFFECTIVE_FROM = "2026-09-26T19:40:00+09:00";
// 予想・プレビュー・オッズ・検索スニペットは最終結果の根拠にしない
export const NOT_A_RESULT_SOURCE = /predict|preview|tips|betting-odds|\/odds|correct[-_ ]?score|h2h-prediction|snippet|予想|プレビュー|検索結果/i;

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
      m.provenance.push({
        update_run_id: run.run_id, changes, note: c.evidence.note ?? null,
        evidence: { sources: c.evidence.sources, verified_at: c.evidence.verified_at, source_confidence: c.evidence.source_confidence ?? null },
        ...(c.correction ? { correction: { reason: c.correction.reason } } : {}),
      });
    }
  }
  return out;
}

// 現在も有効な要確認の一覧：match_id → [{ run_id, status, note }]
// 後の更新回でその試合の事実が更新された、または新しい要確認に置き換わった場合は、古い要確認を外す。
export function pendingReviews(updatesData) {
  const map = new Map();
  for (const run of updatesData?.runs ?? []) {
    for (const c of run.changes) map.delete(c.match_id);
    for (const r of run.reviews) map.set(r.match_id, [{ run_id: run.run_id, status: r.status, note: r.note }]);
  }
  return map;
}

const SOURCE_TYPE_OF_CONFIDENCE = { official: "official", specialist_db: "specialist_db", user_confirmed: "user_confirmed" };
function sourceIssues(run, c) {
  const out = [];
  const ev = c.evidence;
  for (const s of ev.sources) {
    if (NOT_A_RESULT_SOURCE.test(`${s.name} ${s.url ?? ""}`)) {
      out.push(issue("error", "UPDATE_SOURCE_NOT_RESULT", run.run_id, `${c.match_id}：予想・プレビュー・オッズ・検索スニペットは結果の根拠にできない（${s.name}）`));
    }
  }
  if (toMs(run.at) < toMs(SOURCE_RULES_EFFECTIVE_FROM)) return out;     // ルール制定前の更新回
  const conf = ev.source_confidence;
  if (!conf) { out.push(issue("error", "UPDATE_SOURCE_CONFIDENCE_MISSING", run.run_id, `${c.match_id}：source_confidence が必要`)); return out; }
  for (const s of ev.sources) {
    if (!s.type) out.push(issue("error", "UPDATE_SOURCE_TYPE_MISSING", run.run_id, `${c.match_id}：情報源の種別（type）が必要（${s.name}）`));
    if (!s.url && s.type !== "user_confirmed") out.push(issue("error", "UPDATE_SOURCE_URL_MISSING", run.run_id, `${c.match_id}：情報源の URL が必要（${s.name}）`));
  }
  const need = SOURCE_TYPE_OF_CONFIDENCE[conf];
  if (need && !ev.sources.some(s => s.type === need)) {
    out.push(issue("error", "UPDATE_SOURCE_CONFIDENCE_MISMATCH", run.run_id, `${c.match_id}：source_confidence=${conf} なのに種別 ${need} の情報源がない`));
  }
  if (conf === "multi_source" && new Set(ev.sources.map(s => s.name)).size < 2) {
    out.push(issue("error", "UPDATE_SOURCE_CONFIDENCE_MISMATCH", run.run_id, `${c.match_id}：multi_source には独立した情報源が2件以上必要`));
  }
  if (conf === "single_source" && ev.sources.length !== 1) {
    out.push(issue("error", "UPDATE_SOURCE_CONFIDENCE_MISMATCH", run.run_id, `${c.match_id}：single_source は情報源1件`));
  }
  return out;
}

export function checkMatchUpdates(matchesData, updatesData) {
  const out = [];
  if (!updatesData) return out;
  const ids = new Set(matchesData.matches.map(m => m.id));
  const runIds = new Set(matchesData.update_runs.map(r => r.run_id));
  // 結果更新ログは移行基準点（baseline_migration）より後で、ログの中では時刻順であること。
  // matches.json 側の更新回（新しい試合の登録など）は別の記録なので、順序の基準にしない。
  const baselineRun = matchesData.update_runs.find(r => r.kind === "baseline_migration") ?? matchesData.update_runs[0];
  const baseAt = toMs(baselineRun.at);
  let prevAt = baseAt;
  updatesData.runs.forEach((run, k) => {
    // この更新回を適用する直前の実効の試合事実（結果訂正の判定用）
    const before = new Map(applyMatchUpdates(matchesData, { runs: updatesData.runs.slice(0, k) }).matches.map(m => [m.id, m]));
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
      if (s.result_confirmed_at && toMs(s.result_confirmed_at) > toMs(c.evidence.verified_at)) {
        out.push(issue("error", "UPDATE_CONFIRMED_AFTER_VERIFIED", run.run_id, `${c.match_id}：result_confirmed_at が確認時刻より後`));
      }
      out.push(...sourceIssues(run, c));
      // 結果訂正：すでに final の試合の結果・状態を変えるときは理由が必要（無条件の上書きをしない）
      const prev = before.get(c.match_id);
      const correcting = prev?.status === "final" && (("result" in s && JSON.stringify(s.result) !== JSON.stringify(prev.result)) || ("status" in s && s.status !== "final"));
      if (correcting && !c.correction?.reason) {
        out.push(issue("error", "UPDATE_CORRECTION_REASON_MISSING", run.run_id, `${c.match_id}：確定済みの結果を訂正するには correction.reason が必要`));
      }
      if (c.correction && !correcting) {
        out.push(issue("warning", "UPDATE_CORRECTION_UNNEEDED", run.run_id, `${c.match_id}：確定済みの結果の訂正ではないのに correction がある`));
      }
    }
  });
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
