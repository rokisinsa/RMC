// スキーマだけでは表せない整合性ルール。
// 結果は { level: "error" | "warning", code, system, id, message } の配列で返す。

import { deepEqual } from "./schema-validate.js";
import { toMs } from "./time.js";

export const SYSTEMS = ["recommendations", "experience", "value1", "value2", "pro_edge"];
// 候補探索は ①推奨・②VALUE①・③VALUE②・④PRO EDGE の4系統がそれぞれ独立して行う（共通候補プールからの振り分けは禁止）
export const DISCOVERY_SYSTEMS = ["recommendations", "value1", "value2", "pro_edge"];
export const ID_PREFIX = { recommendations: "rec-", experience: "exp-", value1: "v1-", value2: "v2-", pro_edge: "pe-" };
export const ANALYSIS_ID_PREFIX = { recommendations: "rec-an-", value1: "v1-an-", value2: "v2-an-", pro_edge: "pe-an-" };

// matches.json に入れてはいけない分析判断系のキー（どの深さでも禁止）
export const FORBIDDEN_MATCH_KEYS = [
  "verdict", "prob", "probability", "prob_lo", "prob_hi", "prob_point", "required_prob",
  "ev", "ev_lo", "ev_hi", "confidence", "gap_score", "recommended", "recommendation",
  "value", "selection", "odds", "odds_taken", "market_odds", "stake", "pick", "picks",
  "candidate", "candidates", "system", "run_id", "locked", "judgement", "upset_risk",
];

// locked_at 以降に変更してはいけない項目
export const LOCKED_FIELDS = [
  "system", "match_id", "market", "selection", "market_odds", "odds_taken", "stake",
  "discovered_at", "run_id", "analysis_id", "locked_at", "locked", "live",
];

const issue = (level, code, system, id, message) => ({ level, code, system, id, message });
export const isLegacy = pick => pick.flags?.includes("legacy_import") ?? false;

// locked 内で「推定値」にあたる項目。locked_at（試合前に固定した時刻）が無いのに値を持ってはいけない。
const ESTIMATE_KEYS = ["prob", "prob_lo", "prob_hi", "prob_point", "ev_lo", "ev_hi", "market_gap_lo", "market_gap_hi", "base_probability"];
const RANGE_TEXT_RE = /\d+(?:\.\d+)?\s*[〜~～\-–—]\s*\d+(?:\.\d+)?/;

function* walk(value, path = "") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walk(value[i], `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield { key: k, value: v, path: `${path}.${k}` };
      yield* walk(v, `${path}.${k}`);
    }
  }
}

// ── 重複 ────────────────────────────────────────────────
export function duplicateKey(pick) {
  return `${pick.match_id}|${pick.market}|${pick.selection}`;
}

export function findDuplicates(systemData) {
  const groups = new Map();
  for (const pick of systemData.picks) {
    const key = duplicateKey(pick);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pick.id);
  }
  return [...groups].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
}

// 重複は削除しない。全員に duplicate_review フラグがあれば warning、無いものがあれば error。
export function checkDuplicates(systemData) {
  const out = [];
  const byId = new Map(systemData.picks.map(p => [p.id, p]));
  for (const { key, ids } of findDuplicates(systemData)) {
    const unflagged = ids.filter(id => !byId.get(id).flags?.includes("duplicate_review"));
    if (unflagged.length) {
      out.push(issue("error", "DUPLICATE_UNFLAGGED", systemData.system, unflagged.join(","),
        `同一系統内で同一試合＋同一市場＋同一選択が重複（${key}）: ${ids.join(", ")}。duplicate_review フラグが必要`));
    } else {
      out.push(issue("warning", "DUPLICATE_UNDER_REVIEW", systemData.system, ids.join(","),
        `重複候補（要確認フラグ付きで保存中）: ${key}`));
    }
  }
  return out;
}

// ── 分析系統の独立性（①推奨・②VALUE①・③VALUE②・④PRO EDGE） ────────────
// datasets: { matches?, recommendations?, experience?, value1?, value2?, pro_edge? }
export function checkIndependence(datasets) {
  const out = [];
  const present = SYSTEMS.filter(s => datasets[s]);

  // 1) ファイルの system と中身の system・ID接頭辞・run_id の一致
  for (const system of present) {
    const data = datasets[system];
    if (data.system !== system) out.push(issue("error", "SYSTEM_MISMATCH", system, null, `ファイルの system が ${data.system}`));
    const runIds = new Set((data.discovery_runs ?? []).map(r => r.run_id));
    for (const run of data.discovery_runs ?? []) {
      if (!run.run_id.startsWith(ID_PREFIX[system])) {
        out.push(issue("error", "RUN_ID_PREFIX", system, run.run_id, `探索回の run_id は ${ID_PREFIX[system]} で始める`));
      }
    }
    for (const pick of data.picks) {
      if (pick.system !== system) out.push(issue("error", "SYSTEM_MISMATCH", system, pick.id, `カードの system が ${pick.system}`));
      if (!pick.id.startsWith(ID_PREFIX[system])) out.push(issue("error", "ID_PREFIX", system, pick.id, `ID は ${ID_PREFIX[system]} で始める`));
      if (DISCOVERY_SYSTEMS.includes(system)) {
        if (pick.run_id == null) {
          out.push(issue("error", "RUN_ID_MISSING", system, pick.id, "候補探索系統のカードは、その系統自身の探索回 run_id が必要"));
        } else if (!runIds.has(pick.run_id)) {
          out.push(issue("error", "RUN_ID_UNKNOWN", system, pick.id, `run_id ${pick.run_id} が同じファイルの discovery_runs にない（他系統の探索回は参照不可）`));
        }
        // 新規カードは系統ごとの独立した分析ID（旧データは記録がないため任意）
        if (!isLegacy(pick)) {
          if (pick.analysis_id == null) {
            out.push(issue("error", "ANALYSIS_ID_MISSING", system, pick.id, `新規カードには、その系統自身の分析ID（${ANALYSIS_ID_PREFIX[system]}…）が必要`));
          } else if (!pick.analysis_id.startsWith(ANALYSIS_ID_PREFIX[system])) {
            out.push(issue("error", "ANALYSIS_ID_PREFIX", system, pick.id, `分析IDは ${ANALYSIS_ID_PREFIX[system]} で始める`));
          }
        }
      } else if (pick.run_id != null) {
        out.push(issue("error", "RUN_ID_NOT_ALLOWED", system, pick.id, "経験値取引は候補探索系統ではないため run_id を持たない"));
      }
    }
  }

  // 2) カードID・探索回IDは全系統で一意、かつ他系統のIDを値として参照しない
  const owner = new Map();
  for (const system of present) {
    const data = datasets[system];
    for (const id of [...data.picks.map(p => p.id), ...data.picks.map(p => p.analysis_id).filter(Boolean), ...(data.discovery_runs ?? []).map(r => r.run_id)]) {
      if (owner.has(id) && owner.get(id) !== system) {
        out.push(issue("error", "ID_COLLISION", system, id, `ID が ${owner.get(id)} と衝突`));
      }
      owner.set(id, system);
    }
  }
  for (const system of present) {
    for (const pick of datasets[system].picks) {
      for (const { value, path } of walk(pick)) {
        if (typeof value === "string" && owner.has(value) && owner.get(value) !== system) {
          out.push(issue("error", "CROSS_SYSTEM_REFERENCE", system, pick.id,
            `${path} が他系統（${owner.get(value)}）の ${value} を参照している。候補は系統ごとに独立して取得すること`));
        }
      }
    }
  }

  // 3) matches.json に分析判断を入れない
  if (datasets.matches) {
    for (const [i, match] of datasets.matches.matches.entries()) {
      for (const { key, path } of walk(match)) {
        if (FORBIDDEN_MATCH_KEYS.includes(key)) {
          out.push(issue("error", "MATCH_HAS_ANALYSIS", "matches", match.id ?? `#${i}`,
            `matches.json に分析判断の項目 ${path} がある。試合事実だけを入れること`));
        }
      }
    }
  }

  // 4) 別系統で同じ試合・同じ選択の事前分析が完全一致 → 共通分析の流用が疑われる（warning）
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = datasets[present[i]], b = datasets[present[j]];
      if (!DISCOVERY_SYSTEMS.includes(a.system) || !DISCOVERY_SYSTEMS.includes(b.system)) continue;
      for (const pa of a.picks) {
        for (const pb of b.picks) {
          if (pa.match_id !== pb.match_id || pa.selection !== pb.selection) continue;
          const la = pa.locked ?? {}, lb = pb.locked ?? {};
          const sameSummary = la.summary && la.summary === lb.summary;
          const sameRange = la.prob_lo != null && la.prob_lo === lb.prob_lo && la.prob_hi === lb.prob_hi;
          // ④の基本推定が他系統の推定値と完全一致（流用の疑い）
          const pointOf = l => l.base_probability ?? l.prob ?? l.prob_point ?? (l.prob_lo != null && l.prob_lo === l.prob_hi ? l.prob_lo : null);
          const samePoint = (a.system === "pro_edge" || b.system === "pro_edge") && pointOf(la) != null && pointOf(la) === pointOf(lb);
          if (sameSummary || sameRange || samePoint) {
            out.push(issue("warning", "POSSIBLY_SHARED_ANALYSIS", `${a.system}/${b.system}`, `${pa.id},${pb.id}`,
              `同じ試合・選択で事前分析が一致（${sameSummary ? "分析文" : sameRange ? "推定勝率レンジ" : "推定勝率"}）。系統ごとに独立して分析したか確認`));
          }
        }
      }
    }
  }
  return out;
}

// ── 参照 ────────────────────────────────────────────────
export function checkMatchReferences(systemData, matchesById) {
  const out = [];
  for (const pick of systemData.picks) {
    if (!matchesById.has(pick.match_id)) {
      out.push(issue("error", "MATCH_UNKNOWN", systemData.system, pick.id, `match_id ${pick.match_id} が matches.json にない`));
    }
  }
  return out;
}

// ── 時刻 ────────────────────────────────────────────────
// 事前固定の判定に使う開始時刻。確定していれば start_at、候補しか無ければ最も早い候補（保守的に判定する）。
export function effectiveStart(match) {
  if (!match) return null;
  if (match.start_at) return match.start_at;
  const c = match.start_candidates ?? [];
  return c.length ? c.reduce((a, b) => (toMs(a) <= toMs(b) ? a : b)) : null;
}

export function checkTimes(systemData, matchesById) {
  const out = [];
  const runs = new Map((systemData.discovery_runs ?? []).map(r => [r.run_id, r]));
  for (const pick of systemData.picks) {
    const sys = systemData.system, id = pick.id;
    const start = effectiveStart(matchesById.get(pick.match_id));
    const t = k => (pick[k] == null ? null : toMs(pick[k]));
    if (!isLegacy(pick) && pick.run_id?.endsWith("legacy-import")) {
      out.push(issue("error", "NEW_PICK_ON_LEGACY_RUN", sys, id, "新規カードは、その系統自身が行った独立の探索回 run_id が必要（移行用の探索回は使えない）"));
    }

    if (t("discovered_at") != null && t("locked_at") != null && t("discovered_at") > t("locked_at")) {
      out.push(issue("error", "TIME_DISCOVERED_AFTER_LOCK", sys, id, "discovered_at が locked_at より後"));
    }
    const run = runs.get(pick.run_id);
    if (run && t("discovered_at") != null && t("discovered_at") < toMs(run.started_at)) {
      out.push(issue("warning", "TIME_DISCOVERED_BEFORE_RUN", sys, id, "discovered_at が探索回の開始より前"));
    }
    if (start != null) {
      const s = toMs(start);
      if (!pick.live) {
        if (t("locked_at") != null && t("locked_at") > s) {
          out.push(issue("error", "TIME_LOCKED_AFTER_START", sys, id, "試合開始後に locked されている（ライブ取引なら live:true が必要）"));
        }
        if (t("bet_at") != null && t("bet_at") > s) {
          out.push(issue("error", "TIME_BET_AFTER_START", sys, id, "試合開始後の bet_at（ライブ取引なら live:true が必要）"));
        }
      } else if (pick.bet_at == null) {
        // 旧データは投入時刻の記録がないことがあるため、推測で埋めず warning に留める
        out.push(issue(isLegacy(pick) ? "warning" : "error", "TIME_LIVE_WITHOUT_BET_AT", sys, id, "ライブ取引は bet_at が必須"));
      }
    }
    if (pick.locked_at != null && pick.locked == null) {
      out.push(issue("warning", "LOCKED_AT_WITHOUT_LOCKED", sys, id, "locked_at があるのに locked（事前分析）が空"));
    }
  }
  return out;
}

// ── オッズ ──────────────────────────────────────────────
export function checkOdds(systemData) {
  const out = [];
  for (const pick of systemData.picks) {
    const sys = systemData.system, id = pick.id, mo = pick.market_odds;
    if (mo) {
      if (mo.min != null && mo.max != null && mo.min > mo.max) {
        out.push(issue("error", "ODDS_RANGE_INVERTED", sys, id, `market_odds の min(${mo.min}) > max(${mo.max})`));
      }
      if (RANGE_TEXT_RE.test(mo.text) && (mo.min == null || mo.max == null)) {
        out.push(issue("warning", "ODDS_RANGE_UNPARSED", sys, id, `レンジ表記「${mo.text}」の min/max が未入力`));
      }
      // レンジしか確認できていないのに、端の値を odds_taken に入れて一点固定していないか
      if (pick.odds_taken != null && mo.min != null && mo.max != null && mo.min < mo.max &&
          (pick.odds_taken === mo.min || pick.odds_taken === mo.max) && pick.bet_at == null) {
        out.push(issue("warning", "ODDS_TAKEN_FROM_RANGE", sys, id,
          `odds_taken ${pick.odds_taken} が市場レンジの端と一致し bet_at もない。実際の取得オッズか確認（レンジを一点へ固定しない）`));
      }
    }
    if (pick.odds_taken != null && pick.bet_at == null && pick.locked_at == null) {
      // 旧データは取得時刻が不明なことがある（推測で埋めない）ため warning
      out.push(issue(isLegacy(pick) ? "warning" : "error", "ODDS_TAKEN_WITHOUT_TIME", sys, id, "odds_taken には取得時点（bet_at か locked_at）が必要"));
    }
  }
  return out;
}

// ── VALUE①の条件付き ─────────────────────────────────────
export function checkConditions(systemData, matchesById) {
  const out = [];
  for (const pick of systemData.picks) {
    const sys = systemData.system, id = pick.id;
    const conditional = sys === "value1" && pick.locked?.verdict === "conditional";
    if (pick.condition != null && !conditional) {
      out.push(issue("error", "CONDITION_NOT_ALLOWED", sys, id, "condition は VALUE① の条件付きVALUE だけが持てる"));
    }
    if (conditional && pick.condition == null) {
      out.push(issue("error", "CONDITION_MISSING", sys, id, "条件付きVALUE には condition が必要"));
    }
    const c = pick.condition;
    if (c && c.met !== null && c.checked_at == null) {
      out.push(issue("error", "CONDITION_UNCHECKED", sys, id, "condition.met を決めたなら checked_at が必要"));
    }
    const start = effectiveStart(matchesById.get(pick.match_id));
    if (c?.checked_at != null && start != null && toMs(c.checked_at) > toMs(start)) {
      out.push(issue("warning", "CONDITION_CHECKED_AFTER_START", sys, id, "条件確認が試合開始後のため本成績へ算入しない"));
    }
  }
  return out;
}

// ── 旧データ・事前固定の表示ルール ──────────────────────────
export function checkLegacyAndLock(systemData) {
  const out = [];
  for (const pick of systemData.picks) {
    const sys = systemData.system, id = pick.id;
    if (isLegacy(pick) !== (pick.legacy != null)) {
      out.push(issue("error", "LEGACY_FLAG_MISMATCH", sys, id, "legacy 記録と legacy_import フラグは必ず対で持つ"));
    }
    // 事前確率・EV は「試合前に固定された」と確認できた場合だけ持てる（確認できなければ null）
    if (pick.locked_at == null) {
      const filled = ESTIMATE_KEYS.filter(k => pick.locked?.[k] != null);
      if (filled.length) {
        out.push(issue("error", "ESTIMATE_WITHOUT_LOCK", sys, id,
          `locked_at が無いのに推定値（${filled.join(", ")}）がある。試合前の固定を確認できない値は null にし、参考値は recalculated_reference へ`));
      }
      if (isLegacy(pick) && pick.locked != null && !pick.flags.includes("lock_unverified")) {
        out.push(issue("error", "LOCK_UNVERIFIED_UNFLAGGED", sys, id, "試合前の固定を確認できない旧データには lock_unverified フラグが必要"));
      }
    }
  }
  return out;
}

// ── 試合事実 ──────────────────────────────────────────────
export function checkMatches(matchesData) {
  const out = [];
  const runs = new Map((matchesData.update_runs ?? []).map(r => [r.run_id, r]));
  for (const m of matchesData.matches) {
    const recorded = m.start_time_status === "recorded";
    if (recorded !== (m.start_at != null)) {
      out.push(issue("error", "START_STATUS_MISMATCH", "matches", m.id,
        "start_at は start_time_status=recorded のときだけ持つ（未確認・要確認・不明なら null）"));
    }
    const candidates = m.start_candidates ?? [];
    if (m.start_time_status === "review_required" && candidates.length < 2) {
      out.push(issue("error", "START_CANDIDATES_MISSING", "matches", m.id, "review_required には確認待ちの開始時刻候補が2つ以上必要"));
    }
    if (candidates.length && !["review_required", "unverified"].includes(m.start_time_status)) {
      out.push(issue("error", "START_CANDIDATES_NOT_ALLOWED", "matches", m.id, "start_candidates は review_required / unverified のときだけ持てる"));
    }
    for (const [i, p] of (m.provenance ?? []).entries()) {
      const run = runs.get(p.update_run_id);
      if (!run) {
        out.push(issue("error", "PROVENANCE_RUN_UNKNOWN", "matches", m.id, `provenance の update_run_id ${p.update_run_id} が update_runs にない`));
      } else if (i === 0 && m.flags?.includes("legacy_import") && run.kind !== "baseline_migration") {
        out.push(issue("error", "PROVENANCE_BASELINE_MISSING", "matches", m.id, "旧データ由来の試合は最初の履歴が baseline_migration であること"));
      } else if (i > 0 && run.kind === "baseline_migration") {
        out.push(issue("error", "PROVENANCE_ORDER", "matches", m.id, "baseline_migration は最初の履歴だけ"));
      }
    }
    if (m.status === "final" && m.result == null) {
      out.push(issue("error", "FINAL_WITHOUT_RESULT", "matches", m.id, "status=final なのに result が空"));
    }
    const r = m.result;
    for (const [period, side] of Object.entries(r?.winners ?? {})) {
      const score = period === "final" ? r.final : r.periods?.[period];
      if (score) {
        const actual = score.a > score.b ? "side_a" : score.b > score.a ? "side_b" : "draw";
        if (actual !== side) {
          out.push(issue("error", "WINNER_SCORE_CONFLICT", "matches", m.id, `${period} の勝者 ${side} がスコア ${score.a}-${score.b} と矛盾`));
        }
      }
    }
  }
  return out;
}

// ── 試合事実の変更履歴（前バージョンとの比較） ─────────────────
// 試合事実を変えるときは、既存の provenance を残したまま新しい更新回を追記し、変えた項目の before/after を記録する。
const MATCH_FACT_FIELDS = ["side_a", "side_b", "home_side", "start_at", "start_time_status", "start_candidates", "status", "result"];
export function checkMatchHistory(prevData, nextData) {
  const out = [];
  if (!prevData) return out;
  const next = new Map((nextData?.matches ?? []).map(m => [m.id, m]));
  for (const before of prevData.matches) {
    const after = next.get(before.id);
    if (!after) {
      out.push(issue("error", "MATCH_DELETED", "matches", before.id, "試合事実が削除された"));
      continue;
    }
    const prevProv = before.provenance ?? [], nextProv = after.provenance ?? [];
    if (nextProv.length < prevProv.length || prevProv.some((p, i) => !deepEqual(p, nextProv[i]))) {
      out.push(issue("error", "PROVENANCE_REWRITTEN", "matches", before.id, "provenance は追記のみ"));
      continue;
    }
    const changed = MATCH_FACT_FIELDS.filter(f => !deepEqual(before[f] ?? null, after[f] ?? null));
    const recorded = new Set(nextProv.slice(prevProv.length).flatMap(p => p.changes.map(c => c.field)));
    const missing = changed.filter(f => !recorded.has(f));
    if (missing.length) {
      out.push(issue("error", "MATCH_CHANGE_UNRECORDED", "matches", before.id,
        `${missing.join(", ")} を変更したのに、新しい更新回の provenance に記録がない（基準点の値を後から書き換えない）`));
    }
  }
  return out;
}

// ── 事前値 locked の保護（前バージョンとの比較） ─────────────
// 旧データ由来のカードは、locked_at が無くても移行時の値を保護する（削除・書き換え不可）。
export function checkLockedImmutable(prevData, nextData) {
  const out = [];
  if (!prevData) return out;
  const sys = nextData?.system ?? prevData.system;
  const next = new Map((nextData?.picks ?? []).map(p => [p.id, p]));
  for (const before of prevData.picks) {
    const legacy = isLegacy(before);
    if (before.locked_at == null && !legacy) continue;
    const after = next.get(before.id);
    if (!after) {
      out.push(issue("error", "LOCKED_PICK_DELETED", sys, before.id,
        legacy ? "旧データから移行したカードが削除された" : "locked 済みのカードが削除された"));
      continue;
    }
    if (legacy && !deepEqual(before.legacy, after.legacy)) {
      out.push(issue("error", "LEGACY_RECORD_CHANGED", sys, before.id, "旧データの出典記録（legacy）は変更できない"));
    }
    for (const field of LOCKED_FIELDS) {
      if (!deepEqual(before[field] ?? null, after[field] ?? null)) {
        out.push(issue("error", "LOCKED_FIELD_CHANGED", sys, before.id,
          `locked 後に ${field} が変更された（${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}）。再評価は recalculated_reference へ追記する`));
      }
    }
    // ④：購入価格は一度入れたら変更不可、価格スナップショットは追記のみ
    if (before.bet_odds != null && !deepEqual(before.bet_odds, after.bet_odds)) {
      out.push(issue("error", "LOCKED_FIELD_CHANGED", sys, before.id, "bet_odds が変更された"));
    }
    if (Array.isArray(before.price_snapshots)) {
      const nextSnaps = after.price_snapshots ?? [];
      if (nextSnaps.length < before.price_snapshots.length || before.price_snapshots.some((p, i) => !deepEqual(p, nextSnaps[i]))) {
        out.push(issue("error", "PRICE_SNAPSHOTS_REWRITTEN", sys, before.id, "price_snapshots は追記のみ（既存の価格を変更・削除しない）"));
      }
    }
    if (before.bet_at != null && !deepEqual(before.bet_at, after.bet_at)) {
      out.push(issue("error", "LOCKED_FIELD_CHANGED", sys, before.id, "bet_at が変更された"));
    }
    const prevRe = before.recalculated_reference ?? [], nextRe = after.recalculated_reference ?? [];
    if (nextRe.length < prevRe.length || prevRe.some((r, i) => !deepEqual(r, nextRe[i]))) {
      out.push(issue("error", "RECALCULATED_REFERENCE_REWRITTEN", sys, before.id, "recalculated_reference は追記のみ（既存の再評価を変更・削除しない）"));
    }
    if (before.condition?.met != null && !deepEqual(before.condition, after.condition)) {
      out.push(issue("error", "CONDITION_CHANGED", sys, before.id, "確定済みの condition が変更された"));
    }
  }
  return out;
}
