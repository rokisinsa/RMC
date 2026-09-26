// データ一式（matches + 4系統）の検証をまとめて実行する。
// schemas は { "<$id>": schema } の形で呼び出し側が渡す（ブラウザ・Node 共通で使えるように fs に依存しない）。

import { createValidator } from "./schema-validate.js";
import {
  SYSTEMS, checkDuplicates, checkIndependence, checkMatchReferences,
  checkTimes, checkOdds, checkConditions, checkLegacyAndLock, checkMatches,
} from "./integrity.js";
import { checkProEdge } from "./pro-edge/integrity.js";
import { checkMatchUpdates, applyMatchUpdates } from "./match-updates.js";

const SCHEMA_OF = {
  matches: "matches.schema.json",
  recommendations: "recommendations.schema.json",
  experience: "experience.schema.json",
  value1: "value1.schema.json",
  value2: "value2.schema.json",
  legacy_unassigned: "legacy-unassigned.schema.json",
  pro_edge: "pro_edge.schema.json",
  match_updates: "match-updates.schema.json",
  legacy_analysis_recommendations: "legacy-analysis.schema.json",
  legacy_analysis_value1: "legacy-analysis.schema.json",
  legacy_analysis_value2: "legacy-analysis.schema.json",
  post_match_recommendations: "post-match-review.schema.json",
  post_match_experience: "post-match-review.schema.json",
  post_match_value1: "post-match-review.schema.json",
  post_match_value2: "post-match-review.schema.json",
  post_match_pro_edge: "post-match-review.schema.json",
};

// options.proEdgeConfig … config/pro-edge.config.json の内容（④の検査に使用）
export function validateDataset(datasets, schemas, options = {}) {
  const validate = createValidator(schemas);
  const issues = [];

  for (const [name, schemaId] of Object.entries(SCHEMA_OF)) {
    if (!datasets[name]) continue;
    for (const message of validate(schemaId, datasets[name])) {
      issues.push({ level: "error", code: "SCHEMA", system: name, id: null, message });
    }
  }
  // スキーマ違反があると後段の検査が誤作動するので、ここで止める
  if (issues.length) return issues;

  const matchesById = new Map((datasets.matches?.matches ?? []).map(m => [m.id, m]));
  const dupMatchIds = (datasets.matches?.matches ?? []).map(m => m.id).filter((id, i, a) => a.indexOf(id) !== i);
  for (const id of new Set(dupMatchIds)) {
    issues.push({ level: "error", code: "MATCH_ID_DUPLICATE", system: "matches", id, message: "match id が重複" });
  }

  if (datasets.matches) issues.push(...checkMatches(datasets.matches));
  issues.push(...checkIndependence(datasets));
  for (const system of SYSTEMS) {
    const data = datasets[system];
    if (!data) continue;
    if (datasets.matches) issues.push(...checkMatchReferences(data, matchesById));
    issues.push(...checkDuplicates(data));
    issues.push(...checkTimes(data, matchesById));
    issues.push(...checkOdds(data));
    issues.push(...checkConditions(data, matchesById));
    issues.push(...checkLegacyAndLock(data));
  }
  // 旧分析本文は、その系統のカードにだけ所属する（他系統のカードを指さない）
  for (const system of ["recommendations", "value1", "value2"]) {
    const la = datasets[`legacy_analysis_${system}`];
    if (!la) continue;
    if (la.system !== system) issues.push({ level: "error", code: "LEGACY_ANALYSIS_SYSTEM", system, id: null, message: `legacy-analysis/${system}.json の system が ${la.system}` });
    const own = new Set((datasets[system]?.picks ?? []).map(p => p.id));
    const seen = new Set();
    for (const e of la.entries) {
      if (!own.has(e.pick_id)) issues.push({ level: "error", code: "LEGACY_ANALYSIS_FOREIGN_PICK", system, id: e.pick_id, message: "同じ系統のカードではない（分析本文を系統間で共有しない）" });
      if (seen.has(e.pick_id)) issues.push({ level: "error", code: "LEGACY_ANALYSIS_DUPLICATE", system, id: e.pick_id, message: "同じカードの分析本文が重複" });
      seen.add(e.pick_id);
    }
  }
  // 試合後レビューは、その系統の確定済みカードにだけ所属する
  const effective = datasets.matches ? applyMatchUpdates(datasets.matches, datasets.match_updates) : null;
  const effById = new Map((effective?.matches ?? []).map(m => [m.id, m]));
  for (const system of ["recommendations", "experience", "value1", "value2", "pro_edge"]) {
    const pm = datasets[`post_match_${system}`];
    if (!pm) continue;
    if (pm.system !== system) issues.push({ level: "error", code: "POST_MATCH_SYSTEM", system, id: null, message: `post-match-reviews/${system}.json の system が ${pm.system}` });
    const picks = new Map((datasets[system]?.picks ?? []).map(p => [p.id, p]));
    for (const r of pm.reviews) {
      const p = picks.get(r.pick_id);
      if (!p) { issues.push({ level: "error", code: "POST_MATCH_FOREIGN_PICK", system, id: r.pick_id, message: "同じ系統のカードではない（レビューを系統間で共有しない）" }); continue; }
      const m = effById.get(p.match_id);
      if (!m || !["final", "cancelled", "postponed", "abandoned"].includes(m.status) && !p.settlement_override) {
        issues.push({ level: "error", code: "POST_MATCH_NOT_SETTLED", system, id: r.pick_id, message: "結果が確定していないカードのレビュー" });
      }
    }
  }
  if (datasets.match_updates && datasets.matches) issues.push(...checkMatchUpdates(datasets.matches, datasets.match_updates));
  if (datasets.pro_edge) issues.push(...checkProEdge(datasets.pro_edge, matchesById, options.proEdgeConfig ?? {}));
  return issues;
}
