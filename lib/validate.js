// データ一式（matches + 4系統）の検証をまとめて実行する。
// schemas は { "<$id>": schema } の形で呼び出し側が渡す（ブラウザ・Node 共通で使えるように fs に依存しない）。

import { createValidator } from "./schema-validate.js";
import {
  SYSTEMS, checkDuplicates, checkIndependence, checkMatchReferences,
  checkTimes, checkOdds, checkConditions, checkLegacyAndLock, checkMatches,
} from "./integrity.js";

const SCHEMA_OF = {
  matches: "matches.schema.json",
  recommendations: "recommendations.schema.json",
  experience: "experience.schema.json",
  value1: "value1.schema.json",
  value2: "value2.schema.json",
  legacy_unassigned: "legacy-unassigned.schema.json",
};

export function validateDataset(datasets, schemas) {
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
  return issues;
}
