// RMC 本番更新：外部（ChatGPT など）が作った更新 payload を受け取り、検査して data/ へ反映する。
// GitHub 側は「分析する脳」ではなく「安全に受け取って検査して公開する装置」。予測・分析値はここで作らない。
//
// 使い方
//   node scripts/rmc-production-update.mjs --payload tmp/rmc-update.json --dry-run      検査だけ（data/ は変更しない。既定）
//   node scripts/rmc-production-update.mjs --payload tmp/rmc-update.json --apply        検査をすべて通ったときだけ data/ へ反映
//   オプション: --data-dir <dir>（既定 data/）  --now <ISO>（未来情報の判定基準。既定は現在時刻）
//               --start-sha <sha>  --report <file.json>（検査結果を JSON で保存）
//   workflow 用:
//     --receive --out <file>          環境変数 RMC_PAYLOAD_JSON または RMC_PAYLOAD_PATH から payload を受け取り、
//                                     RMC_RUN_ID / RMC_SOURCE と照合して <file> に保存
//     --check-diff                    変更されたファイルが、更新してよいファイルだけか（git status）
//     --finalize --run-id <id> --actions-result pass   コミット前の全テスト結果を実行記録へ書く
// 終了コード: 0=成功 / 1=検査で拒否 / 2=使い方・入力の誤り

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, relative, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT, DATA_DIR, DATA_FILES, loadDatasets, loadSchemas, loadProEdgeConfig } from "./load-node.js";
import { createValidator, deepEqual } from "../lib/schema-validate.js";
import { validateDataset } from "../lib/validate.js";
import { checkLockedImmutable, checkMatchHistory, duplicateKey, effectiveStart, SYSTEMS } from "../lib/integrity.js";
import { applyMatchUpdates, checkMatchUpdatesAppendOnly } from "../lib/match-updates.js";
import { buildViewModel } from "../lib/view/model.js";
import { analyzePick } from "../lib/pro-edge/analyze.js";
import { noVig } from "../lib/pro-edge/market.js";
import { toMs } from "../lib/time.js";
import { verifyManifest } from "./snapshot-manifest.js";

export const AUDIT_FILE = "automation-runs.json";
// payload で更新してよいファイル（これ以外は workflow の差分検査で拒否）
export const WRITABLE_FILES = [
  "data/matches.json", "data/match-updates.json", "data/recommendations.json", "data/experience.json",
  "data/value1.json", "data/value2.json", "data/pro_edge.json", `data/${AUDIT_FILE}`,
  "data/post-match-reviews/recommendations.json", "data/post-match-reviews/experience.json",
  "data/post-match-reviews/value1.json", "data/post-match-reviews/value2.json", "data/post-match-reviews/pro_edge.json",
];
const BASELINE_SHA256 = "86af8bc15919c671f435a94fa35329116afe5f894a995fa627e4d08e6642aab7";
const PICK_SYSTEMS = ["recommendations", "experience", "value1", "value2", "pro_edge"];
const DISCOVERY = ["recommendations", "value1", "value2", "pro_edge"];
// ④ だけが持つ項目（①②③・経験値のデータに入っていたら混入）
const PRO_EDGE_ONLY_KEYS = ["market_probability", "base_probability", "expert_adjustment", "expert_adjustments", "final_probability",
  "edge", "fair_odds", "minimum_entry_odds", "required_ev", "price_snapshots", "bet_odds", "bet_bookmaker", "analysis_id",
  "market_reference", "offered_price", "decision", "data_confidence", "clv_price", "clv_probability"];
// payload の中で「その時点までに分かっていた」はずの時刻（generated_at より後なら未来情報）
const PAST_TIME_KEYS = new Set(["at", "discovered_at", "locked_at", "bet_at", "observed_at", "verified_at", "created_at",
  "checked_at", "started_at", "set_at", "result_confirmed_at", "trained_through"]);
const NULLISH_TEXT = new Set(["", "null", "NULL", "Null", "N/A", "n/a", "NA", "NaN", "undefined", "-", "—", "?", "不明"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const clone = x => structuredClone(x);
const sha256 = text => createHash("sha256").update(text).digest("hex");
const jstNow = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().replace(/\.\d{3}Z$/, "+09:00");

function* walk(value, path = "$") {
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* walk(value[i], `${path}[${i}]`);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { yield { key: k, value: v, path: `${path}.${k}` }; yield* walk(v, `${path}.${k}`); }
  }
}

// ── 検査結果の記録 ───────────────────────────────────────
class Ledger {
  constructor() { this.items = []; this.errors = []; this.warnings = []; }
  add(action, system, id, detail = "") { this.items.push({ action, system, id, detail }); }
  reject(category, system, id, message) { this.errors.push({ category, system, id, message }); this.add("rejected", system, id, message); }
  error(category, system, id, message) { this.errors.push({ category, system, id, message }); }
  warn(category, system, id, message) { this.warnings.push({ category, system, id, message }); }
  count(action, system) { return this.items.filter(i => i.action === action && (system == null || i.system === system)).length; }
}

// ── payload の適用（メモリ上。data/ はまだ書かない） ───────────────────
export function applyPayload(current, payload, ledger) {
  const next = clone(current);
  const stats = { results_updated: 0, metadata_updated: 0, postmortems_created: 0, new_candidates: {}, accepted: 0, watch: 0, rejected: 0 };
  const genAt = payload.generated_at;

  // 試合事実：新しい試合の登録（既存の試合は result_updates でしか変えられない）
  if (payload.matches) {
    const run = payload.matches.update_run;
    const existingRun = next.matches.update_runs.find(r => r.run_id === run.run_id);
    if (existingRun) {
      if (deepEqual(existingRun, run)) ledger.add("unchanged", "matches", run.run_id, "更新回");
      else ledger.reject("locked", "matches", run.run_id, "既存の更新回（update_runs）と内容が違う（書き換え不可）");
    } else { next.matches.update_runs.push(clone(run)); ledger.add("added", "matches", run.run_id, "更新回"); }
    for (const m of payload.matches.new) {
      const old = next.matches.matches.find(x => x.id === m.id);
      if (old) {
        if (deepEqual(old, m)) ledger.add("unchanged", "matches", m.id, "試合");
        else ledger.reject("locked", "matches", m.id, "既存の試合事実を上書きしようとしている（変更は result_updates で更新回として追記する）");
        continue;
      }
      const date = m.id.match(/^(\d{4}-\d{2}-\d{2})-/)?.[1];
      if (!date) { ledger.reject("identity", "matches", m.id, "試合 ID は YYYY-MM-DD-略称-略称"); continue; }
      if (m.start_at && jstDate(m.start_at) !== date) ledger.reject("identity", "matches", m.id, `試合 ID の日付 ${date} と開始日（JST ${jstDate(m.start_at)}）が違う`);
      const norm = s => s.trim().toLowerCase().replace(/\s+/g, " ");
      const twin = next.matches.matches.find(x => norm(x.side_a) === norm(m.side_a) && norm(x.side_b) === norm(m.side_b)
        && (x.start_at && m.start_at ? jstDate(x.start_at) === jstDate(m.start_at) : x.id.slice(0, 10) === date));
      if (twin) { ledger.reject("duplicate", "matches", m.id, `同じ試合が別の ID（${twin.id}）で登録済み`); continue; }
      if (m.status !== "scheduled" || m.result != null) { ledger.reject("result", "matches", m.id, "新しい試合は scheduled・result null で登録する（結果は result_updates で入れる）"); continue; }
      if (m.provenance[0]?.update_run_id !== run.run_id) { ledger.reject("identity", "matches", m.id, `provenance の最初は今回の更新回 ${run.run_id}`); continue; }
      next.matches.matches.push(clone(m));
      ledger.add("added", "matches", m.id, "試合");
    }
  }

  // □1 結果更新（match-updates.json へ更新回を追記）
  for (const run of payload.result_updates ?? []) {
    const existing = next.match_updates.runs.find(r => r.run_id === run.run_id);
    if (existing) {
      if (deepEqual(existing, run)) ledger.add("unchanged", "match_updates", run.run_id, "結果更新回");
      else ledger.reject("locked", "match_updates", run.run_id, "既存の結果更新回と内容が違う（更新ログは追記のみ）");
      continue;
    }
    const effective = new Map(applyMatchUpdates(next.matches, next.match_updates).matches.map(m => [m.id, m]));
    let ok = true;
    for (const c of run.changes) {
      const m = effective.get(c.match_id);
      const start = effectiveStart(m);
      if (("result" in c.set || c.set.status === "final") && start && toMs(start) > toMs(c.evidence.verified_at)) {
        ledger.reject("future", "match_updates", `${run.run_id}/${c.match_id}`, `試合開始（${start}）より前に確認した結果は入れられない（未来情報）`); ok = false;
      }
    }
    if (!ok) continue;
    next.match_updates.runs.push(clone(run));
    ledger.add("added", "match_updates", run.run_id, `結果更新 ${run.changes.length}件・要確認 ${run.reviews.length}件`);
    stats.results_updated += run.changes.filter(c => "result" in c.set || "status" in c.set).length;
  }

  // □2〜□6 系統ごと（ブロックは系統ごとに独立。共通の候補プールは無い）
  for (const system of PICK_SYSTEMS) {
    const block = payload.systems?.[system];
    stats.new_candidates[system] = 0;
    if (!block) continue;
    const data = next[system];
    for (const run of block.discovery_runs ?? []) {
      const old = data.discovery_runs.find(r => r.run_id === run.run_id);
      if (old) { deepEqual(old, run) ? ledger.add("unchanged", system, run.run_id, "探索回") : ledger.reject("locked", system, run.run_id, "既存の探索回と内容が違う"); continue; }
      data.discovery_runs.push(clone(run));
      ledger.add("added", system, run.run_id, "探索回");
    }
    const keys = new Map(data.picks.map(p => [duplicateKey(p), p.id]));
    for (const p of block.new_picks ?? []) {
      const old = data.picks.find(x => x.id === p.id);
      if (old) { deepEqual(old, p) ? ledger.add("unchanged", system, p.id, "カード") : ledger.reject("locked", system, p.id, "既存カードの上書き（locked の事前値・オッズ・投入額は変更できない）"); continue; }
      const key = duplicateKey(p);
      if (keys.has(key)) { ledger.reject("duplicate", system, p.id, `同じ系統に同じ試合・市場・選択のカード ${keys.get(key)} がある（重複登録しない）`); continue; }
      const ownRuns = new Set([...data.discovery_runs.map(r => r.run_id)]);
      if (DISCOVERY.includes(system) && !ownRuns.has(p.run_id)) { ledger.reject("independence", system, p.id, `run_id ${p.run_id} はこの系統の探索回ではない（他系統の候補の流用・振り分けは不可）`); continue; }
      keys.set(key, p.id);
      data.picks.push(clone(p));
      ledger.add("added", system, p.id, "新規カード");
      stats.new_candidates[system]++;
      const b = bucketOf(p);
      if (b in stats) stats[b]++;
    }
    for (const u of block.pick_updates ?? []) {
      const p = data.picks.find(x => x.id === u.pick_id);
      if (!p) { ledger.reject("identity", system, u.pick_id, "この系統にないカードへの更新（他系統のカードは更新できない）"); continue; }
      if ("closing_odds" in u) {
        if (p.closing_odds == null) { p.closing_odds = u.closing_odds; ledger.add("updated", system, p.id, `closing_odds ${u.closing_odds}`); stats.metadata_updated++; }
        else if (p.closing_odds === u.closing_odds) ledger.add("unchanged", system, p.id, "closing_odds");
        else ledger.reject("locked", system, p.id, `closing_odds は記録済み（${p.closing_odds}）で変更できない`);
      }
      if ("condition" in u) {
        if (p.locked?.verdict !== "conditional" || !p.condition) ledger.reject("locked", system, p.id, "条件付きVALUE ではないカードに condition は入れられない");
        else if (deepEqual(p.condition, u.condition)) ledger.add("unchanged", system, p.id, "condition");
        else if (p.condition.met !== null) ledger.reject("locked", system, p.id, "確定済みの condition は変更できない");
        else if (u.condition.text !== p.condition.text || (u.condition.min_odds ?? null) !== (p.condition.min_odds ?? null)) ledger.reject("locked", system, p.id, "condition の条件文・min_odds は変更できない（met と checked_at だけ）");
        else { p.condition = clone(u.condition); ledger.add("updated", system, p.id, `condition.met=${u.condition.met}`); stats.metadata_updated++; }
      }
    }
    if (system === "pro_edge") {
      for (const { pick_id, snapshot } of block.append_snapshots ?? []) {
        const p = data.picks.find(x => x.id === pick_id);
        if (!p) { ledger.reject("identity", system, pick_id, "④にないカード"); continue; }
        const old = p.price_snapshots.find(s => s.snapshot_id === snapshot.snapshot_id);
        if (old) { deepEqual(old, snapshot) ? ledger.add("unchanged", system, pick_id, snapshot.snapshot_id) : ledger.reject("locked", system, pick_id, `価格スナップショット ${snapshot.snapshot_id} は記録済み（変更不可）`); continue; }
        p.price_snapshots.push(clone(snapshot));
        ledger.add("updated", system, pick_id, `価格 ${snapshot.kind} ${snapshot.snapshot_id}`);
        stats.metadata_updated++;
      }
      for (const b of block.bets ?? []) {
        const p = data.picks.find(x => x.id === b.pick_id);
        if (!p) { ledger.reject("identity", system, b.pick_id, "④にないカード"); continue; }
        if (p.bet_odds != null) {
          if (p.bet_odds === b.bet_odds && p.bet_bookmaker === b.bet_bookmaker && p.bet_at === b.bet_at) ledger.add("unchanged", system, p.id, "購入記録");
          else ledger.reject("locked", system, p.id, "購入価格は記録済み（変更不可）");
          continue;
        }
        Object.assign(p, { bet_odds: b.bet_odds, bet_bookmaker: b.bet_bookmaker, bet_at: b.bet_at });
        ledger.add("updated", system, p.id, `購入 ${b.bet_odds}`);
        stats.metadata_updated++;
      }
    }
  }

  // □8 試合後レビュー（系統ごとのファイルに追記）
  for (const system of PICK_SYSTEMS) {
    const reviews = payload.post_match_reviews?.[system];
    if (!reviews?.length) continue;
    const key = `post_match_${system}`;
    next[key] ??= { schema_version: 1, meta: { generated_by: "scripts/rmc-production-update.mjs", legacy_source: null, legacy_commit: null, as_of: genAt, status: "active", note: "この系統の試合後レビュー。記録のみで、判定ロジックは変更しない" }, system, reviews: [] };
    for (const r of reviews) {
      const old = next[key].reviews.find(x => x.pick_id === r.pick_id && x.created_at === r.created_at);
      if (old) { deepEqual(old, r) ? ledger.add("unchanged", system, r.pick_id, "レビュー") : ledger.reject("locked", system, r.pick_id, "既存のレビューを書き換えようとしている"); continue; }
      if (!next[system].picks.some(p => p.id === r.pick_id)) { ledger.reject("independence", system, r.pick_id, "この系統のカードではない（レビューを系統間で共有しない）"); continue; }
      next[key].reviews.push(clone(r));
      ledger.add("added", system, r.pick_id, "試合後レビュー");
      stats.postmortems_created++;
    }
  }
  return { next, stats };
}

function bucketOf(p) {
  const v = p.locked?.verdict ?? p.locked?.decision ?? null;
  if (p.system === "recommendations" || p.system === "experience") return "accepted";
  if (["formal", "conditional", "adopted", "accepted"].includes(v)) return "accepted";
  if (v === "watch") return "watch";
  if (["excluded", "rejected"].includes(v)) return "rejected";
  return "other";
}
const jstDate = iso => new Date(toMs(iso) + 9 * 3600e3).toISOString().slice(0, 10);

// ── payload そのものの検査（JST・null・未来情報・④の申告値） ─────────────
export function checkPayloadShape(payload, ledger, { now }) {
  const genAt = toMs(payload.generated_at);
  if (!payload.generated_at.endsWith("+09:00")) ledger.error("jst", "payload", "generated_at", "generated_at は JST（+09:00）で書く");
  if (genAt > toMs(now) + 10 * 60e3) ledger.error("future", "payload", "generated_at", `generated_at（${payload.generated_at}）が現在時刻より未来`);
  for (const { key, value, path } of walk(payload)) {
    if (typeof value === "string") {
      if (NULLISH_TEXT.has(value.trim()) && !["note", "text"].includes(key)) ledger.error("null", "payload", path, `値が文字列「${value}」になっている。無い値は null にする（推測で埋めない）`);
      if (ISO_RE.test(value)) {
        if (!value.endsWith("+09:00")) ledger.error("jst", "payload", path, `日時は JST（+09:00）で書く: ${value}`);
        if (PAST_TIME_KEYS.has(key) && toMs(value) > genAt) ledger.error("future", "payload", path, `${key}（${value}）が generated_at より後（未来情報）`);
      }
    }
    if (typeof value === "number" && !Number.isFinite(value)) ledger.error("null", "payload", path, "数値が有限でない");
  }
}

// ── 反映後の全体検査 ──────────────────────────────────────
export function checkNext(current, next, payload, ledger, { schemas, cfg, now }) {
  // スキーマ・整合性（既存の validate と同じ検査）。既存データに無かった warning のうち、独立性・重複は error 扱い
  const curIssues = validateDataset(clone(current), schemas, { proEdgeConfig: cfg });
  if (curIssues.some(i => i.level === "error")) ledger.error("schema", "data", null, "現在の data/ に検査 error がある（先に解消が必要）");
  const nextIssues = validateDataset(clone(next), schemas, { proEdgeConfig: cfg });
  const known = new Set(curIssues.map(i => `${i.code}|${i.system}|${i.id}`));
  for (const i of nextIssues) {
    if (known.has(`${i.code}|${i.system}|${i.id}`)) continue;
    const cat = i.code === "SCHEMA" ? "schema" : /DUPLICATE/.test(i.code) ? "duplicate" : /SHARED|CROSS_SYSTEM|RUN_ID|ANALYSIS_ID|MODEL_COPIES/.test(i.code) ? "independence"
      : /FUTURE|AFTER_START|CLOSING_USED/.test(i.code) ? "future" : /UPDATE_SOURCE/.test(i.code) ? "source" : "integrity";
    if (i.level === "error" || ["duplicate", "independence"].includes(cat)) ledger.error(cat, i.system, i.id, `${i.code}: ${i.message}`);
    else ledger.warn(cat, i.system, i.id, `${i.code}: ${i.message}`);
  }

  // locked 保護・追記のみ（基準が draft でも省略しない）
  for (const s of SYSTEMS) for (const i of checkLockedImmutable(current[s], next[s])) if (i.level === "error") ledger.error("locked", s, i.id, `${i.code}: ${i.message}`);
  for (const i of checkMatchHistory(current.matches, next.matches)) ledger.error("locked", "matches", i.id, `${i.code}: ${i.message}`);
  for (const i of checkMatchUpdatesAppendOnly(current.match_updates, next.match_updates)) ledger.error("locked", "match_updates", null, `${i.code}: ${i.message}`);
  for (const k of ["legacy_unassigned", "legacy_analysis_recommendations", "legacy_analysis_value1", "legacy_analysis_value2"]) {
    if (!deepEqual(current[k], next[k])) ledger.error("locked", k, null, "旧データ（legacy）は変更できない");
  }
  for (const s of PICK_SYSTEMS) {
    const a = current[`post_match_${s}`]?.reviews ?? [], b = next[`post_match_${s}`]?.reviews ?? [];
    if (b.length < a.length || a.some((r, i) => !deepEqual(r, b[i]))) ledger.error("locked", `post_match_${s}`, null, "試合後レビューは追記のみ");
  }
  // baseline / snapshot は不変
  if (sha256(readFileSync(join(ROOT, "baseline/2026-09-26/baseline.json"), "utf8").replace(/\r/g, "")) !== BASELINE_SHA256) ledger.error("locked", "baseline", null, "baseline が変更されている");
  for (const m of verifyManifest()) ledger.error("locked", "snapshots", null, `snapshot: ${m}`);

  // 4系統の独立性：①②③・経験値に④固有の項目が無い／④の推定が同じ試合の①②③の推定の写しではない
  for (const s of ["recommendations", "experience", "value1", "value2"]) {
    for (const { key, path } of walk(next[s])) if (PRO_EDGE_ONLY_KEYS.includes(key)) ledger.error("independence", s, path, `④固有の項目 ${key} が入っている`);
  }
  const newIds = new Set(PICK_SYSTEMS.flatMap(s => (payload.systems?.[s]?.new_picks ?? []).map(p => p.id)));
  for (const p of next.pro_edge.picks.filter(p => newIds.has(p.id))) {
    const others = new Set();
    for (const s of ["recommendations", "value1", "value2"]) for (const q of next[s].picks.filter(q => q.match_id === p.match_id)) {
      for (const k of ["prob", "prob_lo", "prob_hi", "prob_point"]) if (q.locked?.[k] != null) others.add(q.locked[k]);
    }
    if (p.locked && others.has(p.locked.base_probability)) ledger.error("independence", "pro_edge", p.id, "base_probability が同じ試合の①②③の推定値と一致（流用の疑い）");
  }

  // ④の計算値：外部の申告値を、入力から再計算した値と照合（market → base のコピー禁止を含む）
  for (const r of payload.systems?.pro_edge?.reported ?? []) {
    const p = next.pro_edge.picks.find(x => x.id === r.pick_id);
    if (!p) { ledger.error("identity", "pro_edge", r.pick_id, "申告値のカードが④にない"); continue; }
    const a = analyzePick(p, cfg);
    const calc = { ...a, clv_price: a.clv.clv_price, clv_probability: a.clv.clv_probability };
    for (const [k, v] of Object.entries(r)) {
      if (k === "pick_id" || v === undefined) continue;
      const c = calc[k];
      const tol = /odds/.test(k) ? 0.01 : 0.001;
      if ((v == null) !== (c == null) || (v != null && Math.abs(v - c) > tol)) ledger.error("pro_edge", "pro_edge", p.id, `${k} の申告値 ${v} が再計算値 ${c} と合わない`);
    }
    if (r.market_probability != null && r.base_probability != null && Math.abs(r.market_probability - r.base_probability) < 1e-9) {
      ledger.error("independence", "pro_edge", p.id, "base_probability に market_probability をコピーしている");
    }
  }

  // 損益の整合：試合事実が変わっていないカードの精算は変わらない／集計は各カードの精算と一致／CLV は式どおり
  const vmBefore = buildViewModel(clone(current), { proEdgeConfig: cfg, now });
  const vmAfter = buildViewModel(clone(next), { proEdgeConfig: cfg, now });
  const effBefore = new Map(applyMatchUpdates(current.matches, current.match_updates).matches.map(m => [m.id, JSON.stringify(m)]));
  const effAfter = new Map(applyMatchUpdates(next.matches, next.match_updates).matches.map(m => [m.id, JSON.stringify(m)]));
  const plChanges = [];
  for (const s of PICK_SYSTEMS) {
    const after = new Map(vmAfter[s].rows.map(r => [r.id, r]));
    for (const r of vmBefore[s].rows) {
      const a = after.get(r.id);
      if (!a) { ledger.error("locked", s, r.id, "カードが消えた"); continue; }
      const same = ["state", "stake", "odds", "payout", "profit"].every(k => r.settlement[k] === a.settlement[k]);
      if (same) continue;
      const mid = r.match?.id;
      if (mid && effBefore.get(mid) === effAfter.get(mid)) ledger.error("pl", s, r.id, "試合事実が変わっていないのに損益が変わった");
      else plChanges.push({ system: s, id: r.id, before: pickPl(r.settlement), after: pickPl(a.settlement) });
    }
  }
  for (const [name, sum, rows] of summaryTargets(vmAfter)) {
    const own = rows.map(r => r.settlement);
    const net = own.filter(x => ["win", "loss"].includes(x.state) && x.profit != null).reduce((t, x) => t + x.profit, 0);
    const stake = own.filter(x => ["win", "loss"].includes(x.state) && x.profit != null).reduce((t, x) => t + x.stake, 0);
    const bad = [];
    if (sum.count !== own.length) bad.push("件数");
    if (sum.settledGames !== sum.wins + sum.losses) bad.push("戦績");
    if (Math.abs(sum.netProfit - Math.round(net * 100) / 100) > 0.005) bad.push("純損益");
    if (Math.abs(sum.settledStake - stake) > 0.005) bad.push("確定投入額");
    if (sum.settledStake > 0 ? Math.abs(sum.roi - (sum.netProfit / sum.settledStake) * 100) > 1e-9 : sum.roi !== null) bad.push("ROI");
    if (sum.pending !== own.filter(x => x.state === "pending").length) bad.push("未確定件数");
    if (bad.length) ledger.error("pl", name, null, `集計が各カードの精算と合わない（${bad.join("・")}）`);
  }
  for (const r of vmAfter.pro_edge.rows) {
    const c = r.analysis.clv;
    if (c.status !== "ok") continue;
    const closing = r.analysis.closing_odds, bet = r.analysis.bet_odds;
    const p = next.pro_edge.picks.find(x => x.id === r.id);
    const snap = p.price_snapshots.filter(s => s.kind === "closing").find(s => s.bookmaker === p.bet_bookmaker) ?? p.price_snapshots.find(s => s.kind === "closing");
    const pc = noVig(snap, cfg).probabilities[p.selection];
    if (Math.abs(c.clv_price - (bet / closing - 1)) > 1e-6 || Math.abs(c.clv_probability - (pc - 1 / bet)) > 1e-6) ledger.error("clv", "pro_edge", r.id, "CLV が式（bet/closing−1・締切no-vig確率−1/bet）と合わない");
  }
  return { vmBefore, vmAfter, plChanges };
}
const pickPl = s => ({ state: s.state, payout: s.payout, profit: s.profit });
function summaryTargets(vm) {
  const off = (v, b) => v.rows.filter(r => r.bucket === b);
  return [
    ["recommendations", vm.recommendations.summary, vm.recommendations.rows],
    ["experience", vm.experience.summary, vm.experience.rows],
    ["value1 本成績", vm.value1.official, off(vm.value1, "official")], ["value1 参考", vm.value1.reference, off(vm.value1, "reference")],
    ["value2 本成績", vm.value2.official, off(vm.value2, "official")], ["value2 参考", vm.value2.reference, off(vm.value2, "reference")],
    ["pro_edge 本成績", vm.pro_edge.official, off(vm.pro_edge, "official")], ["pro_edge 参考", vm.pro_edge.reference, off(vm.pro_edge, "reference")],
  ];
}

// ── ファイルへの書き込み（既存の書式を崩さない。意味の無い差分を作らない） ─────────────
export function serialize(originalText, originalObj, nextObj) {
  if (deepEqual(originalObj, nextObj)) return null;
  const pretty = x => JSON.stringify(x, null, 2) + "\n";
  if (originalText == null || originalText.replace(/\r/g, "") === pretty(originalObj)) return pretty(nextObj);
  // 手書き書式のファイル（例 match-updates.json）：最後の配列に要素を追記しただけなら、その部分だけ書き足す
  const keys = Object.keys(originalObj), last = keys.at(-1);
  const onlyAppend = deepEqual(Object.keys(nextObj), keys) && keys.slice(0, -1).every(k => deepEqual(originalObj[k], nextObj[k]))
    && Array.isArray(originalObj[last]) && originalObj[last].every((x, i) => deepEqual(x, nextObj[last][i]));
  if (!onlyAppend) throw new Error("既存の書式を保ったまま書き込めない（最後の配列への追記以外の変更）");
  const added = nextObj[last].slice(originalObj[last].length);
  const text = originalText.replace(/\r/g, "");
  const m = text.match(/\n( *)\]\s*\n\}\s*$/);
  if (!m || originalObj[last].length === 0) throw new Error("追記位置を特定できない");
  const indent = m[1] + "  ";
  const body = added.map(x => JSON.stringify(x, null, 2).split("\n").map(l => indent + l).join("\n")).join(",\n");
  const out = text.slice(0, m.index) + ",\n" + body + text.slice(m.index);
  if (!deepEqual(JSON.parse(out), nextObj)) throw new Error("追記後の内容が一致しない");
  return out;
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

// ── 完全版の探索網羅性ゲート ──────────────────────────────────────
function checkCoverageAudit(payload, ledger) {
  const scheduled = new Set(["06:00", "12:00", "18:00", "23:00"]);
  if (!scheduled.has(payload.slot)) return;
  const c = payload.coverage_audit;
  if (!c) { ledger.error("coverage", "payload", null, "定時更新は coverage_audit 必須。全競技探索を数値で証明できないため拒否"); return; }
  const master = c.sportsbook_master?.union_sports ?? [];
  const sa = c.sportsbook_master?.source_audit;
  const coverageMode = c.sportsbook_master?.mode ?? "three_site";
  const activeSites = coverageMode === "bet_channel_only" ? ["bet_channel"] : ["bet_channel","casitabi","yuugado"];
  for (const site of activeSites) {
    const a = sa?.[site];
    if (!a) { ledger.error("coverage", site, null, "サイト別source_auditが無い"); continue; }
    if (!a.menu_end_verified) ledger.error("coverage", site, null, "競技メニュー最下部までの確認証跡が無い");
    if (a.access_status !== "direct") ledger.error("coverage", site, null, `完全版はdirect取得のみ。access_status=${a.access_status}`);
    if (!a.source_urls?.length) ledger.error("coverage", site, null, "競技一覧のsource URLが無い");
    const listed = c.sportsbook_master?.[site] ?? [];
    if (a.category_count !== listed.length) ledger.error("coverage", site, null, `category_count ${a.category_count} != 実一覧 ${listed.length}`);
    if (!Array.isArray(a.event_ids) || a.event_count !== a.event_ids.length) ledger.error("coverage", site, null, `event_count ${a.event_count} != event_ids実数 ${a.event_ids?.length ?? 0}`);
  }
  if (coverageMode === "bet_channel_only") {
    const listed = c.sportsbook_master?.bet_channel ?? [];
    const a = new Set(listed.map(x => String(x).trim().toLowerCase()));
    const b = new Set(master.map(x => String(x).trim().toLowerCase()));
    if (a.size !== b.size || [...a].some(x => !b.has(x))) ledger.error("coverage", "bet_channel", null, "bet_channel_onlyではunion_sportsはBET CHANNEL実査一覧と完全一致が必要");

    // payload の自己申告ではなく、GitHub Actions が実ブラウザで取得した最新 snapshot と照合する。
    const scanPath = join(ROOT, "data", "betchannel-scan.json");
    if (!existsSync(scanPath)) {
      ledger.error("coverage", "bet_channel", null, "data/betchannel-scan.json が無い");
    } else {
      try {
        const scan = JSON.parse(readFileSync(scanPath, "utf8"));
        if (scan.complete !== true || scan.access_status !== "direct" || scan.menu_end_verified !== true || scan.failed_category_count !== 0) {
          ledger.error("coverage", "bet_channel", null, "最新BET CHANNEL scanがcomplete/direct/全カテゴリ成功ではない");
        }
        if (scan.category_count !== scan.categories?.length) ledger.error("coverage", "bet_channel", null, "scan category_countとcategories実数が不一致");
        if (scan.event_count !== scan.event_ids?.length || new Set(scan.event_ids ?? []).size !== (scan.event_ids ?? []).length) {
          ledger.error("coverage", "bet_channel", null, "scan event_count/event_ids実数または一意性が不正");
        }
        const expectedMaster = (scan.categories ?? []).map(x => `ct=${x.ct}:${String(x.label ?? "").trim()}`);
        const em = new Set(expectedMaster.map(x => x.toLowerCase()));
        if (a.size !== em.size || [...a].some(x => !em.has(x))) ledger.error("coverage", "bet_channel", null, "payloadのBET CHANNELカテゴリ母表が実scanと一致しない");
        const audit = sa?.bet_channel;
        const si = new Set(scan.event_ids ?? []), pi = new Set(audit?.event_ids ?? []);
        if (si.size !== pi.size || [...si].some(x => !pi.has(x))) ledger.error("coverage", "bet_channel", null, "payload event_idsが実scan event_idsと一致しない");
        if (audit?.category_count !== scan.category_count || audit?.event_count !== scan.event_count) {
          ledger.error("coverage", "bet_channel", null, "payloadのカテゴリ/イベント件数が実scanと一致しない");
        }
        if (audit?.checked_at !== scan.finished_at) ledger.error("coverage", "bet_channel", null, "payload checked_atが実scan finished_atと一致しない");
        const age = toMs(payload.generated_at) - toMs(scan.finished_at);
        if (!Number.isFinite(age) || age < 0 || age > 60 * 60 * 1000) ledger.error("coverage", "bet_channel", null, "BET CHANNEL scanが更新時刻より未来、または60分超で古い");
      } catch (e) {
        ledger.error("coverage", "bet_channel", null, `BET CHANNEL scan読込失敗: ${e.message}`);
      }
    }
  }
  if (!master.length) ledger.error("coverage", "payload", null, "3サイト和集合の対象競技マスターが空");
  const uniq = new Set(master.map(x => String(x).trim().toLowerCase()));
  if (uniq.size !== master.length) ledger.error("coverage", "payload", null, "対象競技マスターに重複がある");
  for (const system of DISCOVERY) {
    const x = c.systems?.[system];
    if (!x) { ledger.error("coverage", system, null, "系統別coverageが無い"); continue; }
    if (x.target_sports !== master.length) ledger.error("coverage", system, null, `target_sports ${x.target_sports} != master ${master.length}`);
    if (x.scanned_sports + x.unscanned_sports !== x.target_sports) ledger.error("coverage", system, null, "scanned + unscanned が target と一致しない");
    if (x.unscanned_sports !== 0) ledger.error("coverage", system, null, `未走査競技 ${x.unscanned_sports} 件。完全版として本番反映しない`);
    if (x.unscanned_sport_names?.length) ledger.error("coverage", system, null, `未走査競技名が残っている: ${x.unscanned_sport_names.join(", ")}`);
    if (x.scanned_sport_names && x.scanned_sport_names.length !== x.scanned_sports) ledger.error("coverage", system, null, "scanned_sport_names 件数が scanned_sports と一致しない");
    if (!Array.isArray(x.card_ids) || x.cards_checked !== x.card_ids.length) ledger.error("coverage", system, null, `cards_checked ${x.cards_checked} != card_ids実数 ${x.card_ids?.length ?? 0}`);
    const countKeys = Object.keys(x.sport_card_counts ?? {});
    if (countKeys.length !== master.length) ledger.error("coverage", system, null, "sport_card_countsが対象競技マスター全件を持っていない");
    const normKeys = new Set(countKeys.map(v => v.trim().toLowerCase()));
    for (const sport of master) if (!normKeys.has(sport.trim().toLowerCase())) ledger.error("coverage", system, null, `sport_card_counts欠落: ${sport}`);
    const counted = Object.values(x.sport_card_counts ?? {}).reduce((a,b)=>a+b,0);
    if (counted !== x.cards_checked) ledger.error("coverage", system, null, `競技別カード合計 ${counted} != cards_checked ${x.cards_checked}`);
    if (x.cards_checked < 20 && x.unavailable_sports < x.target_sports) ledger.error("coverage", system, null, `一次確認 ${x.cards_checked} カード。20未満で、全競技取得不能でもないため探索不足`);
    const runs = payload.systems?.[system]?.discovery_runs ?? [];
    if (!runs.length) ledger.error("coverage", system, null, "独立discovery_runが無い");
  }
}

// ── 実行 ──────────────────────────────────────────────
export function runUpdate({ payloadText, dataDir = DATA_DIR, now = new Date().toISOString(), apply = false, startSha = gitHead(), startedAt = jstNow() }) {
  const ledger = new Ledger();
  const schemas = loadSchemas();
  const cfg = loadProEdgeConfig();
  const validate = createValidator(schemas);
  let payload;
  try { payload = JSON.parse(payloadText); } catch (e) { ledger.error("schema", "payload", null, `JSON として読めない: ${e.message}`); return { ok: false, ledger }; }
  for (const m of validate("rmc-update-payload.schema.json", payload)) ledger.error("schema", "payload", null, m);
  if (ledger.errors.length) return { ok: false, ledger, payload };

  const { datasets: current, missing } = loadDatasets(dataDir);
  if (missing.length) { ledger.error("schema", "data", null, `データファイルが無い: ${missing.join(", ")}`); return { ok: false, ledger, payload }; }
  const auditPath = join(dataDir, AUDIT_FILE);
  const auditText = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : null;
  const audit = auditText ? JSON.parse(auditText) : { schema_version: 1, meta: { generated_by: "scripts/rmc-production-update.mjs", legacy_source: null, legacy_commit: null, as_of: null, status: "active", note: "本番更新 workflow の実行記録（追記のみ）" }, runs: [] };
  for (const m of validate("automation-runs.schema.json", audit)) ledger.error("schema", "automation_runs", null, m);
  if (audit.runs.some(r => r.run_id === payload.run_id)) ledger.error("duplicate", "automation_runs", payload.run_id, "この run_id は適用済み（同じ更新を二重に適用しない）");

  checkPayloadShape(payload, ledger, { now });
  checkCoverageAudit(payload, ledger);
  const { next, stats } = applyPayload(current, payload, ledger);
  const { vmBefore, vmAfter, plChanges } = checkNext(current, next, payload, ledger, { schemas, cfg, now });

  const cardsChecked = payload.coverage_audit ? DISCOVERY.reduce((t, s) => t + payload.coverage_audit.systems[s].cards_checked, 0) : PICK_SYSTEMS.reduce((t, s) => t + next[s].picks.length, 0);
  const record = {
    run_id: payload.run_id, started_at: startedAt, finished_at: jstNow(), source: payload.source,
    payload_generated_at: payload.generated_at, payload_sha256: sha256(payloadText),
    start_sha: startSha, end_sha: null, systems_checked: [...PICK_SYSTEMS], cards_checked: cardsChecked,
    results_updated: stats.results_updated, metadata_updated: stats.metadata_updated, new_candidates: stats.new_candidates,
    accepted: stats.accepted, watch: stats.watch, rejected: stats.rejected, postmortems_created: stats.postmortems_created,
    validation_result: "pass", actions_result: "pending", pages_result: "pending", coverage_audit: payload.coverage_audit ?? null, note: payload.note ?? null,
  };
  const ok = ledger.errors.length === 0;
  const result = { ok, ledger, payload, stats, record, vmBefore, vmAfter, plChanges, written: [] };
  if (!ok || !apply) return result;

  // 書き込み（すべての検査を通ったときだけ）
  const writes = [];
  for (const [name, file] of Object.entries(DATA_FILES)) {
    if (!next[name] || !WRITABLE_FILES.includes(`data/${file}`)) continue;
    const path = join(dataDir, file);
    const text = existsSync(path) ? readFileSync(path, "utf8") : null;
    const out = serialize(text, current[name] ?? null, next[name]);
    if (out != null) writes.push([path, out]);
  }
  const nextAudit = clone(audit);
  nextAudit.runs.push(record);
  if (nextAudit.meta) nextAudit.meta.as_of = payload.generated_at;
  writes.push([auditPath, auditText ? serialize(auditText, audit, nextAudit) : JSON.stringify(nextAudit, null, 2) + "\n"]);
  for (const [path, out] of writes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, out); }
  result.written = writes.map(([p]) => relative(ROOT, p).replace(/\\/g, "/"));

  // 書いた後のファイルをもう一度検査
  const reread = loadDatasets(dataDir).datasets;
  const errs = validateDataset(reread, schemas, { proEdgeConfig: cfg }).filter(i => i.level === "error");
  const auditErrs = validate("automation-runs.schema.json", JSON.parse(readFileSync(auditPath, "utf8")));
  if (errs.length || auditErrs.length || !PICK_SYSTEMS.every(s => deepEqual(reread[s], next[s]))) {
    throw new Error(`書き込み後の再検査で不一致（${errs.length + auditErrs.length}件）`);
  }
  return result;
}

// ── 表示 ──────────────────────────────────────────────
export function formatReport(r, { apply }) {
  const L = r.ledger, out = [];
  const money = x => (x == null ? "—" : `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`);
  out.push(`■ RMC 本番更新 ${apply ? "apply" : "dry-run（data/ は変更しない）"}：${r.payload?.run_id ?? "(不明)"}`);
  out.push(`  source: ${r.payload?.source ?? "—"} / generated_at: ${r.payload?.generated_at ?? "—"}`);
  const cats = cat => L.errors.filter(e => e.category === cat).length;
  out.push(`  追加 ${L.count("added")}件 / 更新 ${L.count("updated")}件 / 変更なし ${L.count("unchanged")}件 / 拒否 ${L.count("rejected")}件`);
  out.push(`  locked違反 ${cats("locked")}件 / schema違反 ${cats("schema")}件 / 重複 ${cats("duplicate")}件 / 独立性 ${cats("independence")}件 / 未来情報 ${cats("future")}件 / JST ${cats("jst")}件 / null ${cats("null")}件 / 損益・CLV ${cats("pl") + cats("clv") + cats("pro_edge")}件`);
  out.push("  系統別：");
  for (const s of ["matches", "match_updates", ...PICK_SYSTEMS]) {
    const a = L.count("added", s), u = L.count("updated", s), n = L.count("unchanged", s), x = L.count("rejected", s);
    if (a + u + n + x) out.push(`    ${s}: 追加 ${a} / 更新 ${u} / 変更なし ${n} / 拒否 ${x}`);
  }
  if (r.vmBefore && r.vmAfter) {
    out.push("  損益差分（本成績・参考成績。確定分）：");
    for (const [[name, b], [, a]] of summaryTargets(r.vmBefore).map((x, i) => [x, summaryTargets(r.vmAfter)[i]])) {
      if (b.count === a.count && b.netProfit === a.netProfit && b.pending === a.pending && b.wins === a.wins && b.losses === a.losses) continue;
      out.push(`    ${name}: ${b.wins}勝${b.losses}敗 ${money(b.netProfit)} ROI ${b.roi == null ? "—" : b.roi.toFixed(2) + "%"} 未確定${b.pending} → ${a.wins}勝${a.losses}敗 ${money(a.netProfit)} ROI ${a.roi == null ? "—" : a.roi.toFixed(2) + "%"} 未確定${a.pending}（件数 ${b.count}→${a.count}）`);
    }
    for (const c of r.plChanges ?? []) out.push(`    精算の変化 ${c.system} ${c.id}: ${c.before.state} ${money(c.before.profit)} → ${c.after.state} ${money(c.after.profit)}（試合事実の更新による）`);
  }
  if (L.errors.length) { out.push(`  ✖ 重大エラー ${L.errors.length}件（コミットしない）：`); for (const e of L.errors.slice(0, 50)) out.push(`    [${e.category}] ${e.system}${e.id ? ` ${e.id}` : ""}: ${e.message}`); }
  if (L.warnings.length) { out.push(`  warning ${L.warnings.length}件：`); for (const w of L.warnings.slice(0, 20)) out.push(`    [${w.category}] ${w.system}${w.id ? ` ${w.id}` : ""}: ${w.message}`); }
  out.push(r.ok ? (apply ? `  ✔ 検査すべて PASS。反映したファイル: ${r.written.join(", ")}` : "  ✔ 検査すべて PASS（dry-run のため data/ は変更していない）") : "  ✖ 検査で拒否。data/ は変更していない");
  return out.join("\n");
}

// ── workflow 用の補助 ─────────────────────────────────────
function receive(outPath) {
  const runId = process.env.RMC_RUN_ID?.trim(), source = process.env.RMC_SOURCE?.trim();
  const inline = process.env.RMC_PAYLOAD_JSON?.trim(), path = process.env.RMC_PAYLOAD_PATH?.trim();
  if (!runId || !source) fail("run_id と source が必要");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(runId)) fail("run_id の形式が不正");
  if (!!inline === !!path) fail("payload は payload_json か payload_path のどちらか一方で渡す");
  let text;
  if (path) {
    if (isAbsolute(path) || path.includes("..") || !/^(incoming|tmp)\/[A-Za-z0-9._\/-]+\.json$/.test(path)) fail("payload_path は incoming/ または tmp/ の下の .json（リポジトリ内の相対パス）");
    text = readFileSync(join(ROOT, path), "utf8");
  } else text = inline;
  let payload;
  try { payload = JSON.parse(text); } catch { fail("payload が JSON ではない"); }
  if (payload.run_id !== runId) fail(`payload の run_id（${payload.run_id}）と入力の run_id（${runId}）が違う`);
  if (payload.source !== source) fail(`payload の source と入力の source が違う`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`payload を受け取りました: ${relative(ROOT, outPath)}（${Buffer.byteLength(text)} bytes, sha256 ${sha256(text).slice(0, 12)}）`);
}
function checkDiff() {
  const lines = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const paths = lines.map(l => l.slice(3).replace(/^"|"$/g, ""));
  const bad = paths.filter(p => !WRITABLE_FILES.includes(p) && !p.startsWith(".tmp-tests/"));
  console.log(`変更されたファイル: ${paths.filter(p => !p.startsWith(".tmp-tests/")).join(", ") || "なし"}`);
  if (bad.length) fail(`更新してよいファイル以外が変更されている: ${bad.join(", ")}`, 1);
}
function finalize(dataDir, runId, actionsResult) {
  const path = join(dataDir, AUDIT_FILE);
  const text = readFileSync(path, "utf8"), obj = JSON.parse(text);
  const rec = obj.runs.at(-1);
  if (rec?.run_id !== runId || rec.actions_result !== "pending") fail("最後の実行記録がこの run_id の未確定の記録ではない", 1);
  if (actionsResult !== "pass") fail("actions_result は pass だけ記録する（失敗した回はコミットしない）");
  rec.actions_result = "pass";
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log(`実行記録 ${runId}: actions_result = pass`);
}
function finalizePages(dataDir, runId) {
  const path = join(dataDir, AUDIT_FILE);
  const obj = JSON.parse(readFileSync(path, "utf8"));
  const rec = [...obj.runs].reverse().find(r => r.run_id === runId);
  if (!rec) fail("pages確定対象の run_id が実行記録にない", 1);
  if (rec.actions_result !== "pass") fail("Actions PASS 前に Pages published は記録できない", 1);
  rec.pages_result = "published";
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log(`実行記録 ${runId}: pages_result = published`);
}
function fail(message, code = 2) { console.error(`✖ ${message}`); process.exit(code); }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const has = name => argv.includes(name);
  const dataDir = opt("--data-dir") ? resolve(ROOT, opt("--data-dir")) : DATA_DIR;
  if (has("--receive")) receive(resolve(ROOT, opt("--out") ?? ".tmp-tests/production-update/payload.json"));
  else if (has("--check-diff")) checkDiff();
  else if (has("--finalize")) finalize(dataDir, opt("--run-id"), opt("--actions-result"));
  else if (has("--finalize-pages")) finalizePages(dataDir, opt("--run-id"));
  else {
    const payloadPath = opt("--payload");
    if (!payloadPath) fail("--payload <file> を指定してください");
    const apply = has("--apply");
    if (apply && has("--dry-run")) fail("--apply と --dry-run は同時に指定できない");
    const r = runUpdate({ payloadText: readFileSync(resolve(ROOT, payloadPath), "utf8"), dataDir, now: opt("--now") ?? new Date().toISOString(), apply, startSha: opt("--start-sha") ?? gitHead() });
    console.log(formatReport(r, { apply }));
    const reportPath = opt("--report");
    if (reportPath) {
      mkdirSync(dirname(resolve(ROOT, reportPath)), { recursive: true });
      writeFileSync(resolve(ROOT, reportPath), JSON.stringify({ ok: r.ok, run_id: r.payload?.run_id ?? null, errors: r.ledger.errors, warnings: r.ledger.warnings, items: r.ledger.items, record: r.record ?? null, written: r.written ?? [] }, null, 2) + "\n");
    }
    process.exit(r.ok ? 0 : 1);
  }
}
