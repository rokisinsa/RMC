// 実運用リハーサル：GPT 定時更新（□1〜□12）を、架空の入力で data/ の「コピー」に適用して検証する。
// data/ は読むだけで変更しない。生成物は .tmp-tests/rehearsal/<更新ID>/ に置く（git 管理外）。
//   before/    … 前回の定時更新（REHEARSAL-00）まで適用した状態
//   after/     … 今回の定時更新（REHEARSAL-01）を適用した状態
//   corrected/ … after に「確定結果の訂正」を適用した別シナリオ
//   site/      … after のデータで V2 画面を開くための確認用コピー（node scripts/serve.js で配信）
// 検証結果は rehearsals/<更新ID>/result.md に書く（入力が同じなら同じ内容になる）。
// 使い方: node scripts/rehearsal.js [rehearsals/<更新ID>]   失敗が1件でもあれば終了コード1

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT, DATA_FILES, loadDatasets, loadSchemas, loadProEdgeConfig } from "./load-node.js";
import { validateDataset } from "../lib/validate.js";
import { checkLockedImmutable, checkMatchHistory, SYSTEMS } from "../lib/integrity.js";
import { applyMatchUpdates, checkMatchUpdatesAppendOnly } from "../lib/match-updates.js";
import { buildViewModel } from "../lib/view/model.js";
import { renderPage } from "../lib/view/render.js";
import { RESULT_SYMBOL } from "../lib/view/format.js";
import { analyzePick } from "../lib/pro-edge/analyze.js";
import { noVig } from "../lib/pro-edge/market.js";

const REH_DIR = resolve(ROOT, process.argv[2] ?? "rehearsals/RMC-20260926-REHEARSAL-01");
const input = JSON.parse(readFileSync(join(REH_DIR, "gpt-input.json"), "utf8"));
const ID = input.update_id;
const OUT = join(ROOT, ".tmp-tests", "rehearsal", ID);
const LIVE_DATA = join(ROOT, "data");
const cfg = loadProEdgeConfig();
const schemas = loadSchemas();
const clone = x => structuredClone(x);
const r2 = x => (x == null ? null : Math.round(x * 1e6) / 1e6);

// ── 結果の記録 ──────────────────────────────────────────
const results = [];
const lines = [];
let section = "";
const log = (...a) => { const s = a.join(" "); lines.push(s); console.log(s); };
const head = title => { section = title; log(`\n## ${title}\n`); };
function check(label, pass, detail = "") {
  results.push({ section, label, pass: !!pass, detail });
  log(`- ${pass ? "PASS" : "**FAIL**"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// data/ の指紋（リハーサルで本番データを変更していないことの確認用）
const fingerprint = dir => {
  const h = createHash("sha256");
  const walk = d => { for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p); else h.update(relative(dir, p)).update(readFileSync(p));
  } };
  walk(dir);
  return h.digest("hex");
};
const liveFingerprint = fingerprint(LIVE_DATA);

// ── GPT 入力を data のコピーへ適用する（docs/gpt-update-spec.md の手順どおり） ────────
function registerMatches(ds, block) {
  ds.matches.update_runs.push(clone(block.matches_update_run));
  for (const m of block.matches) {
    ds.matches.matches.push({
      id: m.id, sport: m.sport, competition: m.competition, side_a: m.side_a, side_b: m.side_b,
      home_side: "unknown", region: null, start_at: m.start_at, start_time_status: "recorded",
      status: "scheduled", result: null,
      provenance: [{ update_run_id: block.matches_update_run.run_id, changes: [], note: "新規登録（リハーサル・架空）" }],
      flags: [],
    });
  }
}
function addDiscovery(ds, system, block) {
  const data = ds[system];
  data.discovery_runs.push(clone(block.discovery_run));
  for (const p of block.picks) {
    const base = system === "pro_edge"
      ? { system, run_id: block.discovery_run.run_id, settlement_override: null, flags: [] }
      : { system, run_id: block.discovery_run.run_id, market_odds: null, odds_taken: null, stake: null, bet_at: null, settlement_override: null, flags: [] };
    data.picks.push({ ...base, ...clone(p) });
  }
}
function addReviews(ds, system, reviews) {
  const key = `post_match_${system}`;
  ds[key] ??= { schema_version: 1, system, reviews: [] };
  ds[key].reviews.push(...clone(reviews));
}
function writeDataDir(dir, ds) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(LIVE_DATA, dir, { recursive: true });
  for (const [name, file] of Object.entries(DATA_FILES)) {
    if (!ds[name]) continue;
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(ds[name], null, 2) + "\n");
  }
}

const live = loadDatasets(LIVE_DATA).datasets;

// before：前回の定時更新（REHEARSAL-00）までの状態
const before = clone(live);
registerMatches(before, input.setup);
for (const [system, block] of Object.entries(input.setup.systems)) addDiscovery(before, system, block);

// after：今回の定時更新（REHEARSAL-01）
const after = clone(before);
const S = input.steps;
after.match_updates.runs.push(clone(S.s1_result_update.run));                           // □1
for (const { pick_id, snapshot } of S.s2_pending_cards.pro_edge_snapshots) {            // □2
  after.pro_edge.picks.find(p => p.id === pick_id).price_snapshots.push(clone(snapshot));
}
for (const { system, pick_id, closing_odds } of S.s2_pending_cards.closing_odds) {
  after[system].picks.find(p => p.id === pick_id).closing_odds = closing_odds;
}
registerMatches(after, S.new_matches);
addDiscovery(after, "recommendations", S.s3_recommendations);                            // □3
addDiscovery(after, "value1", S.s4_value1);                                              // □4
addDiscovery(after, "value2", S.s5_value2);                                              // □5
addDiscovery(after, "pro_edge", S.s6_pro_edge);                                          // □6
for (const [system, reviews] of Object.entries(S.s8_post_match_reviews)) addReviews(after, system, reviews); // □8

// corrected：確定結果の訂正（別シナリオ）
const corrected = clone(after);
corrected.match_updates.runs.push(clone(input.correction_fixture.run));

rmSync(OUT, { recursive: true, force: true });
writeDataDir(join(OUT, "before"), before);
writeDataDir(join(OUT, "after"), after);
writeDataDir(join(OUT, "corrected"), corrected);

log(`# 実運用リハーサル ${ID}`);
log("");
log(`入力：\`${relative(ROOT, join(REH_DIR, "gpt-input.json")).replace(/\\/g, "/")}\`（架空の試合・オッズ。data/ には入れない）`);
log(`定時更新の想定時刻：${input.run_at}（slot ${input.slot}）`);

// ── □1〜□12 の適用状況 ─────────────────────────────────
head("□1〜□12 の実施内容");
const newPickIds = sys => [...(sys === "recommendations" ? S.s3_recommendations : sys === "value1" ? S.s4_value1 : sys === "value2" ? S.s5_value2 : S.s6_pro_edge).picks.map(p => p.id)];
log(`- □1 結果更新：${S.s1_result_update.run.run_id}（${S.s1_result_update.run.changes.map(c => c.match_id).join(", ")} を final へ）`);
log(`- □2 未確定カード更新：④締切スナップショット ${S.s2_pending_cards.pro_edge_snapshots.length}件・①closing_odds ${S.s2_pending_cards.closing_odds.length}件`);
log(`- □3 ①新規：${newPickIds("recommendations").join(", ")}（探索回 ${S.s3_recommendations.discovery_run.run_id}）`);
log(`- □4 ②新規：${newPickIds("value1").join(", ")}（探索回 ${S.s4_value1.discovery_run.run_id}）`);
log(`- □5 ③新規：${newPickIds("value2").join(", ")}（探索回 ${S.s5_value2.discovery_run.run_id}）`);
log(`- □6 ④新規：${newPickIds("pro_edge").join(", ")}（探索回 ${S.s6_pro_edge.discovery_run.run_id}）`);
log("- □7 競技偏り監査・□9 損益/ROI/CLV・□10 データ品質：下の「監査レポート」");
log(`- □8 敗因分析：${Object.entries(S.s8_post_match_reviews).map(([s, r]) => `${s} ${r.length}件`).join("・")}`);
log("- □11 JSON 更新：before → after の差分を locked 保護・追記のみ検査で確認（本番 data/ へは書かない）");
log("- □12 commit SHA・公開ページ確認：dev ブランチの push と GitHub Actions・V2 表示確認で行う（このスクリプトの外）");

// ── 検証：スキーマ・整合性 ───────────────────────────────
head("スキーマ・整合性（validate-data と同じ検査）");
const errorsOf = ds => validateDataset(clone(ds), schemas, { proEdgeConfig: cfg }).filter(i => i.level === "error");
const warningsOf = ds => validateDataset(clone(ds), schemas, { proEdgeConfig: cfg }).filter(i => i.level === "warning");
const liveWarn = new Set(warningsOf(live).map(i => `${i.code}|${i.id}`));
for (const [name, ds] of [["before", before], ["after", after], ["corrected", corrected]]) {
  const errs = errorsOf(ds);
  check(`${name}: error 0件`, errs.length === 0, errs.map(e => `${e.code} ${e.id}: ${e.message}`).join(" / "));
  const newWarn = warningsOf(ds).filter(i => !liveWarn.has(`${i.code}|${i.id}`));
  log(`  - ${name}: リハーサルで増えた warning ${newWarn.length}件${newWarn.length ? `（${newWarn.map(w => `${w.code} ${w.id}`).join(", ")}）` : ""}`);
}

// ── 検証：locked 保護・追記のみ ──────────────────────────
head("locked 保護・追記のみ（check-locked と同じ検査。基準が draft でも省略しない）");
function lockIssues(prev, next) {
  const out = [];
  for (const s of SYSTEMS) out.push(...checkLockedImmutable(prev[s], next[s]).filter(i => i.level === "error"));
  out.push(...checkMatchHistory(prev.matches, next.matches));
  out.push(...checkMatchUpdatesAppendOnly(prev.match_updates, next.match_updates));
  for (const s of ["recommendations", "value1", "value2"]) {
    if (JSON.stringify(prev[`legacy_analysis_${s}`]) !== JSON.stringify(next[`legacy_analysis_${s}`])) out.push({ code: "LEGACY_ANALYSIS_CHANGED", id: s });
  }
  if (JSON.stringify(prev.legacy_unassigned) !== JSON.stringify(next.legacy_unassigned)) out.push({ code: "LEGACY_UNASSIGNED_CHANGED", id: null });
  return out;
}
for (const [label, a, b] of [["data/ → before", live, before], ["before → after", before, after], ["after → corrected", after, corrected], ["data/ → corrected", live, corrected]]) {
  const iss = lockIssues(a, b);
  check(`${label}: 違反0件`, iss.length === 0, iss.map(i => `${i.code} ${i.id}`).join(", "));
}
{ // 検査が機能していること（書き換えを検出する）
  const tampered = clone(after);
  tampered.recommendations.picks.find(p => p.id === "rec-rh-00-a").odds_taken = 1.95;
  tampered.pro_edge.picks.find(p => p.id === "pe-rh-00-a").price_snapshots[0].outcomes.side_a = 2.5;
  tampered.match_updates.runs[0].changes[0].evidence.verified_at = input.run_at;   // 既存（本番）の更新回
  const codes = lockIssues(before, tampered).map(i => i.code);
  check("（逆検査）locked 後の odds_taken 書き換え・④価格の書き換え・更新ログの書き換えを検出する",
    codes.includes("LOCKED_FIELD_CHANGED") && codes.includes("PRICE_SNAPSHOTS_REWRITTEN") && codes.includes("UPDATE_LOG_REWRITTEN"), codes.join(", "));
}

// ── 検証：4系統の独立性 ───────────────────────────────
head("4系統の独立性（①推奨・②VALUE①・③VALUE②・④PRO EDGE）");
const DISC = ["recommendations", "value1", "value2", "pro_edge"];
const LABEL = { recommendations: "①", value1: "②", value2: "③", pro_edge: "④" };
const rehearsalPicks = s => after[s].picks.filter(p => p.id.includes("-rh-"));
const matchSystems = new Map();
for (const s of DISC) for (const p of rehearsalPicks(s)) matchSystems.set(p.match_id, new Set([...(matchSystems.get(p.match_id) ?? []), s]));
for (const s of DISC) {
  const only = [...matchSystems].filter(([, set]) => set.size === 1 && set.has(s)).map(([m]) => m);
  check(`${LABEL[s]} だけが扱う候補がある`, only.length >= 1, only.join(", "));
}
const shared = [...matchSystems].filter(([, set]) => set.size >= 2);
check("複数系統で同じ match_id を扱う試合がある（共有は試合事実だけ）", shared.length >= 1,
  shared.map(([m, set]) => `${m}：${[...set].map(s => LABEL[s]).join("")}`).join(" / "));
for (const s of DISC) {
  const own = new Set(after[s].discovery_runs.map(r => r.run_id));
  const bad = rehearsalPicks(s).filter(p => !own.has(p.run_id) || !p.run_id.startsWith({ recommendations: "rec-", value1: "v1-", value2: "v2-", pro_edge: "pe-" }[s]));
  check(`${LABEL[s]} の候補はすべて自系統の探索回 run_id を持つ（共通候補プール・振り分けなし）`, bad.length === 0, bad.map(p => p.id).join(", "));
}
const runStarts = DISC.map(s => after[s].discovery_runs.filter(r => r.run_id.includes("-rh")).map(r => r.run_id)).flat();
check("探索回は系統ごとに別の run_id（4回の独立探索）", new Set(runStarts).size === runStarts.length, runStarts.join(", "));

const PE_ONLY_KEYS = ["market_probability", "base_probability", "expert_adjustment", "expert_adjustments", "final_probability",
  "edge", "fair_odds", "minimum_entry_odds", "price_snapshots", "bet_odds", "bet_bookmaker", "analysis_id", "market_reference",
  "offered_price", "decision", "data_confidence", "clv", "clv_price", "clv_probability"];
const keysIn = v => { const k = []; const w = x => { if (Array.isArray(x)) x.forEach(w); else if (x && typeof x === "object") for (const [a, b] of Object.entries(x)) { k.push(a); w(b); } }; w(v); return k; };
for (const s of ["recommendations", "value1", "value2"]) {
  const leaked = keysIn(after[s]).filter(k => PE_ONLY_KEYS.includes(k));
  check(`${LABEL[s]} のデータに④固有の項目が無い`, leaked.length === 0, [...new Set(leaked)].join(", "));
}
const vmAfter = buildViewModel(clone(after), { proEdgeConfig: cfg, now: input.run_at });
for (const s of ["recommendations", "value1", "value2"]) {
  const withPe = vmAfter[s].rows.filter(r => "analysis" in r || "bet_odds" in r || "features" in r);
  check(`${LABEL[s]} の表示行に④の計算値（market/base/final probability・EV・CLV）が無い`, withPe.length === 0, withPe.map(r => r.id).join(", "));
}
{ // ④が同じ試合の①②③の推定値を写していない
  const copied = rehearsalPicks("pro_edge").filter(p => {
    const others = new Set();
    for (const s of ["recommendations", "value1", "value2"]) for (const q of after[s].picks.filter(q => q.match_id === p.match_id)) {
      for (const k of ["prob", "prob_lo", "prob_hi", "prob_point", "required_prob"]) if (q.locked?.[k] != null) others.add(q.locked[k]);
    }
    return [p.locked.base_probability, analyzePick(p, cfg).final_probability].some(v => others.has(v));
  });
  check("④の base / final probability が同じ試合の①②③の推定値の写しではない", copied.length === 0, copied.map(p => p.id).join(", "));
  const texts = new Set(["recommendations", "value1", "value2"].flatMap(s => after[s].picks.map(p => p.locked?.summary).filter(Boolean)));
  const sameText = rehearsalPicks("pro_edge").filter(p => texts.has(p.locked.summary) || (p.locked.disagreement_reasons ?? []).some(t => texts.has(t)));
  check("④の分析文が①②③の分析文の写しではない", sameText.length === 0, sameText.map(p => p.id).join(", "));
  const shareWarn = warningsOf(after).filter(i => i.code === "POSSIBLY_SHARED_ANALYSIS" && String(i.id).includes("-rh-"));
  check("共有試合で「共通分析の流用の疑い」警告が出ていない", shareWarn.length === 0, shareWarn.map(i => i.id).join(", "));
}
{ // 逆検査：混入・流用を検出できること
  const leak1 = clone(after);
  leak1.recommendations.picks.find(p => p.id === "rec-rh-00-a").locked.market_probability = 0.52;
  const leak2 = clone(after);
  leak2.value1.picks.find(p => p.id === "v1-rh-00-a").base_probability = 0.56;
  const leak3 = clone(after);
  leak3.value2.picks.find(p => p.id === "v2-rh-01").locked.final_probability = 0.6;
  const e = ds => errorsOf(ds).filter(i => i.code === "SCHEMA").length > 0;
  check("（逆検査）①②③へ④の項目（market_probability / base_probability / final_probability）を入れると error", e(leak1) && e(leak2) && e(leak3));
  const copy = clone(after);
  copy.value1.picks.find(p => p.id === "v1-rh-00-a").locked.prob_point = copy.pro_edge.picks.find(p => p.id === "pe-rh-00-a").locked.base_probability;
  check("（逆検査）④の基本推定と②の推定値が一致すると「流用の疑い」警告", warningsOf(copy).some(i => i.code === "POSSIBLY_SHARED_ANALYSIS" && i.id === "v1-rh-00-a,pe-rh-00-a"));
  const cross = clone(after);
  cross.pro_edge.picks.find(p => p.id === "pe-rh-01").run_id = S.s3_recommendations.discovery_run.run_id;
  check("（逆検査）④のカードが①の探索回を使うと error", errorsOf(cross).some(i => ["CROSS_SYSTEM_REFERENCE", "RUN_ID_UNKNOWN", "SCHEMA"].includes(i.code)));
}

// ── 検証：scheduled → final の反映 ─────────────────────────
head("scheduled → final の反映（記号・払戻し・損益・戦績・勝率・ROI・未確定件数）");
const SHARED = S.s1_result_update.run.changes[0].match_id;
const vmBefore = buildViewModel(clone(before), { proEdgeConfig: cfg, now: "2026-09-27T11:00:00+09:00" });
const summaryOf = (vm, s) => (s === "recommendations" ? vm.recommendations.summary : s === "value1" ? vm.value1 : s === "value2" ? vm.value2 : vm.pro_edge);
const tracked = [
  ["recommendations", "rec-rh-00-a", v => v.recommendations.summary, "本成績"],
  ["value1", "v1-rh-00-a", v => v.value1.reference, "参考成績（監視・$100仮定）"],
  ["pro_edge", "pe-rh-00-a", v => v.pro_edge.official, "本成績（accepted）"],
];
const fmt = x => (x == null ? "—" : typeof x === "number" ? String(Math.round(x * 100) / 100) : String(x));
log("| 系統 | カード | 状態 | 記号 | 払戻し | 損益 | 未確定の予想損益 |");
log("|---|---|---|---|---|---|---|");
for (const [s, id, , ] of tracked) for (const [label, vm] of [["before", vmBefore], ["after", vmAfter]]) {
  const r = vm[s].rows.find(x => x.id === id);
  log(`| ${LABEL[s]} ${label} | ${id} | ${r.settlement.state} | ${RESULT_SYMBOL[r.settlement.state]} | ${fmt(r.settlement.payout)} | ${fmt(r.settlement.profit)} | ${fmt(r.settlement.projectedProfit)} |`);
}
log("");
log("| 系統 | 集計 | 時点 | 件数 | 戦績 | 勝率 | 確定投入 | 純損益 | ROI | 未確定 |");
log("|---|---|---|---|---|---|---|---|---|---|");
for (const [s, id, pickSum, name] of tracked) {
  const b = pickSum(vmBefore), a = pickSum(vmAfter);
  for (const [label, x] of [["before", b], ["after", a]]) {
    log(`| ${LABEL[s]} | ${name} | ${label} | ${x.count} | ${x.wins}勝${x.losses}敗 | ${fmt(x.winRate)}% | ${fmt(x.settledStake)} | ${fmt(x.netProfit)} | ${fmt(x.roi)}% | ${x.pending} |`);
  }
  const rb = vmBefore[s].rows.find(x => x.id === id), ra = vmAfter[s].rows.find(x => x.id === id);
  const stake = ra.settlement.stake, odds = ra.settlement.odds;
  const newPending = vmAfter[s].rows.filter(r => r.id.includes("-rh-") && r.id !== id && r.settlement.state === "pending"
    && (pickSum === tracked[0][2] || r.bucket === (s === "value1" ? "reference" : "official"))).length;
  check(`${LABEL[s]} ${id}：試合前（△）→ 的中（○）`, rb.settlement.state === "pending" && ra.settlement.state === "win");
  check(`${LABEL[s]} ${id}：払戻し ${stake}×${odds}＝${r2(stake * odds)}・損益 +${r2(stake * odds - stake)}`, ra.settlement.payout === r2(stake * odds) && ra.settlement.profit === r2(stake * odds - stake));
  check(`${LABEL[s]} ${name}：勝ち +1・純損益 +${r2(stake * odds - stake)}・確定投入 +${stake}・未確定 ${b.pending}→${a.pending}`,
    a.wins === b.wins + 1 && a.losses === b.losses && Math.abs(a.netProfit - b.netProfit - (stake * odds - stake)) < 1e-9
    && Math.abs(a.settledStake - b.settledStake - stake) < 1e-9 && a.pending === b.pending - 1 + newPending,
    `新規の未確定 ${newPending}件を含む`);
  check(`${LABEL[s]} ${name}：勝率＝勝ち÷(勝ち＋負け)・ROI＝純損益÷確定投入`,
    Math.abs(a.winRate - a.wins / (a.wins + a.losses) * 100) < 1e-9 && Math.abs(a.roi - a.netProfit / a.settledStake * 100) < 1e-9);
}
{
  const html = renderPage(vmAfter);
  const m = applyMatchUpdates(after.matches, after.match_updates).matches.find(x => x.id === SHARED);
  check("実効の試合事実：status final・スコア・result_confirmed_at・根拠（出典・確認時刻・確度）が provenance に残る",
    m.status === "final" && m.result.final.a === 2 && m.result_confirmed_at === S.s1_result_update.run.changes[0].set.result_confirmed_at
    && m.provenance.at(-1).evidence.source_confidence === "official" && m.provenance.at(-1).evidence.verified_at != null);
  check("V2 描画：共有試合の結果と今回の更新回が画面に出る", html.includes("Rehearsal Player A 2-0（架空）") && html.includes(S.s1_result_update.run.run_id));
  const rec01 = vmAfter.recommendations.rows.find(r => r.id === "rec-rh-01");
  check("①レンジだけのオッズは一点に固定せず、未確定の予想損益は「未計算」扱い", rec01.odds_taken === null && rec01.settlement.projectedProfit === null && rec01.market_odds.min === 1.15 && rec01.market_odds.max === 1.2);
}

// ── 検証：確定結果の訂正（final → corrected final） ────────────────
head("確定結果の訂正（final → corrected final）");
{
  const cm = applyMatchUpdates(corrected.matches, corrected.match_updates).matches.find(x => x.id === SHARED);
  const last = cm.provenance.at(-1);
  const res = last.changes.find(c => c.field === "result");
  log(`- 訂正前（previous_value）：${JSON.stringify(res.before.final)} ${res.before.text}`);
  log(`- 訂正後（new_value）：${JSON.stringify(res.after.final)} ${res.after.text}`);
  log(`- 理由（reason）：${last.correction?.reason}`);
  log(`- 出典（source）：${last.evidence.sources.map(s => `${s.name} ${s.url}（${s.type}）`).join(", ")}`);
  log(`- 確認時刻（verified_at）：${last.evidence.verified_at}／確度：${last.evidence.source_confidence}`);
  check("provenance に previous_value / new_value / reason / source / verified_at が残る",
    res.before.final.a === 2 && res.after.final.b === 2 && !!last.correction?.reason && last.evidence.sources.length > 0 && !!last.evidence.verified_at);
  const prevProv = applyMatchUpdates(after.matches, after.match_updates).matches.find(x => x.id === SHARED).provenance;
  check("訂正前の履歴（□1 の確定記録）は消えずに残る（追記のみ）", JSON.stringify(cm.provenance.slice(0, prevProv.length)) === JSON.stringify(prevProv));
  const vmC = buildViewModel(clone(corrected), { proEdgeConfig: cfg, now: input.correction_fixture.run.at });
  log("");
  log("| 系統 | カード | 訂正前 | 訂正後 | 損益 訂正前→後 | 集計の純損益 訂正前→後 | 戦績 訂正前→後 |");
  log("|---|---|---|---|---|---|---|");
  for (const [s, id, pickSum] of tracked) {
    const ra = vmAfter[s].rows.find(x => x.id === id).settlement, rc = vmC[s].rows.find(x => x.id === id).settlement;
    const a = pickSum(vmAfter), c = pickSum(vmC);
    log(`| ${LABEL[s]} | ${id} | ${RESULT_SYMBOL[ra.state]} | ${RESULT_SYMBOL[rc.state]} | ${fmt(ra.profit)}→${fmt(rc.profit)} | ${fmt(a.netProfit)}→${fmt(c.netProfit)} | ${a.wins}勝${a.losses}敗→${c.wins}勝${c.losses}敗 |`);
    check(`${LABEL[s]} ${id}：精算が自動で ○→× に変わり、集計の純損益が ${fmt(-(ra.profit + ra.stake))} 変わる`,
      ra.state === "win" && rc.state === "loss" && rc.profit === -rc.stake
      && Math.abs(c.netProfit - (a.netProfit - ra.profit - ra.stake)) < 1e-9 && c.wins === a.wins - 1 && c.losses === a.losses + 1);
  }
  const noReason = clone(after);
  const run = clone(input.correction_fixture.run);
  delete run.changes[0].correction;
  noReason.match_updates.runs.push(run);
  check("（逆検査）理由（correction.reason）の無い訂正は error", errorsOf(noReason).some(i => i.code === "UPDATE_CORRECTION_REASON_MISSING"));
  const badSource = clone(after);
  const run2 = clone(input.correction_fixture.run);
  run2.changes[0].evidence.sources = [{ name: "試合予想プレビュー", url: "https://rehearsal.example/preview/rh", type: "media" }];
  run2.changes[0].evidence.source_confidence = "single_source";
  badSource.match_updates.runs.push(run2);
  check("（逆検査）予想・プレビューを根拠にした結果更新は error", errorsOf(badSource).some(i => i.code === "UPDATE_SOURCE_NOT_RESULT"));
}

// ── 検証：PRO EDGE の一連の流れ ────────────────────────────
head("④ PRO EDGE：市場価格 → no-vig → 市場確率 → base → 補正 → final → edge → fair odds → EV → 判定 → 購入 → 締切 → CLV");
{
  log("| カード | 判定 | 市場確率 | 方法 | base | 補正 | final | edge | fair odds | 提示 | EV | 必要EV | 最低オッズ | 購入 | 締切 | CLV(価格) | CLV(確率) | CLV状態 |");
  log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const row = (label, p) => {
    const a = analyzePick(p, cfg);
    log(`| ${label} | ${a.decision} | ${fmt(r2(a.market_probability))} | ${a.market_method} | ${fmt(a.base_probability)} | ${fmt(a.expert_adjustment)} | ${fmt(a.final_probability)} | ${fmt(r2(a.edge))} | ${fmt(a.fair_odds)} | ${fmt(a.offered_odds)} | ${fmt(r2(a.ev))} | ${fmt(a.required_ev)} | ${fmt(a.minimum_entry_odds)} | ${fmt(a.bet_odds)} | ${fmt(a.closing_odds)} | ${fmt(a.clv.clv_price)} | ${fmt(a.clv.clv_probability)} | ${a.clv.status} |`);
    return a;
  };
  const b0 = row("pe-rh-00-a（before：締切前）", before.pro_edge.picks.find(p => p.id === "pe-rh-00-a"));
  const p0 = after.pro_edge.picks.find(p => p.id === "pe-rh-00-a");
  const a0 = row("pe-rh-00-a（after：締切追記）", p0);
  const a1 = row("pe-rh-01（締切なし）", after.pro_edge.picks.find(p => p.id === "pe-rh-01"));
  const a2 = row("pe-rh-02（rejected）", after.pro_edge.picks.find(p => p.id === "pe-rh-02"));

  // 同じ式で独立に再計算して照合（lib の結果を写さない）
  const snaps = Object.fromEntries(p0.price_snapshots.map(s => [s.snapshot_id, s]));
  const nv = s => { const inv = Object.fromEntries(Object.entries(s.outcomes).map(([k, o]) => [k, 1 / o])); const t = Object.values(inv).reduce((x, y) => x + y, 0); return Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / t])); };
  const market = p0.locked.market_reference.snapshot_ids.map(id => nv(snaps[id]).side_a).reduce((x, y) => x + y, 0) / p0.locked.market_reference.snapshot_ids.length;
  const fin = p0.locked.base_probability + p0.locked.expert_adjustments.reduce((x, j) => x + j.adjustment_value, 0);
  const offered = snaps[p0.locked.offered_price.snapshot_id].outcomes.side_a;
  const closing = p0.price_snapshots.find(s => s.kind === "closing");
  const expect = {
    market_probability: market, final_probability: fin, edge: fin - market, fair_odds: 1 / fin, ev: fin * offered - 1,
    minimum_entry_odds: (1 + p0.locked.required_ev) / fin, clv_price: p0.bet_odds / closing.outcomes.side_a - 1,
    clv_probability: nv(closing).side_a - 1 / p0.bet_odds,
  };
  const got = { ...a0, clv_price: a0.clv.clv_price, clv_probability: a0.clv.clv_probability };
  const diff = Object.entries(expect).filter(([k, v]) => !(Math.abs(got[k] - v) < 1e-4)).map(([k, v]) => `${k}: ${got[k]} ≠ ${v}`);
  check("pe-rh-00-a：市場確率（2社 consensus・no-vig）〜CLV まで、式どおりの独立再計算と一致", diff.length === 0, diff.join(" / "));
  check("pe-rh-00-a：no-vig 後の確率の合計が 1（控除を除去）", Math.abs(Object.values(noVig(snaps["ps-rh-00-a-an-a"], cfg).probabilities).reduce((x, y) => x + y, 0) - 1) < 1e-9);
  check("pe-rh-00-a：EV ≥ 必要EV なので accepted（本成績）", a0.decision === "accepted" && a0.ev >= a0.required_ev);
  check("締切オッズが無い時点では CLV 未計算（before）→ 締切追記で CLV 計算（after）", b0.clv.status === "no_closing_odds" && b0.clv.clv_price === null && a0.clv.status === "ok");
  check("pe-rh-01：締切オッズが無いので CLV は未計算（null・推測しない）", a1.clv.status === "no_closing_odds" && a1.clv.clv_price === null && a1.clv.clv_probability === null);
  check("pe-rh-02：EV マイナスで rejected・集計外（投入額なし）", a2.decision === "rejected" && a2.ev < 0 && a2.bet_odds === null
    && vmAfter.pro_edge.rows.find(r => r.id === "pe-rh-02").bucket === "excluded");
  const r1 = vmAfter.pro_edge.rows.find(r => r.id === "pe-rh-01");
  check("V2 表示：④の締切なしカードに「CLV 未計算」バッジ", r1.quality.some(q => q.key === "clv" && q.label === "CLV 未計算"));
  const late = clone(after);
  late.pro_edge.picks.find(p => p.id === "pe-rh-01").price_snapshots.push({ snapshot_id: "ps-rh-01-close-late", kind: "closing", bookmaker: "BookA", market: "match_winner", outcomes: { side_a: 2.0, side_b: 1.85 }, observed_at: "2026-09-28T05:10:00+09:00", source: "BookA 公開オッズ（架空）" });
  check("（逆検査）試合開始後に取得した締切オッズは error（CLV に使わない）", errorsOf(late).some(i => i.code === "CLOSING_AFTER_START"));
  const copyMarket = clone(after);
  const cp = copyMarket.pro_edge.picks.find(p => p.id === "pe-rh-01");
  cp.locked.base_probability = analyzePick(cp, cfg).market_probability;
  check("（逆検査）base_probability に市場確率をそのまま入れると error（市場のコピー禁止）", errorsOf(copyMarket).some(i => i.code === "MODEL_COPIES_MARKET"));
}

// ── 既存のテスト・監査をリハーサルデータで実行 ───────────────────────
head("既存の live テスト・監査レポートをリハーサルデータで実行");
const run = (args, dataDir) => {
  const env = { ...process.env, RMC_DATA_DIR: dataDir };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
};
const liveTests = readdirSync(join(ROOT, "tests", "live")).filter(f => f.endsWith(".test.js")).map(f => `tests/live/${f}`);
for (const name of ["after", "corrected"]) {
  const r = run(["--test", ...liveTests], join(OUT, name));
  const pass = r.stdout.match(/^(?:#|ℹ) pass (\d+)/m)?.[1], fail = r.stdout.match(/^(?:#|ℹ) fail (\d+)/m)?.[1];
  check(`live テスト（RMC_DATA_DIR=${name}）`, r.status === 0, `pass ${pass} / fail ${fail}`);
  if (r.status !== 0) log("```\n" + r.stdout.slice(-3000) + "\n```");
}
for (const name of ["after", "corrected"]) {
  const r = run(["scripts/validate-data.js", join(OUT, name)], join(OUT, name));
  check(`validate-data.js（${name}）`, r.status === 0, r.stdout.trim().split("\n").at(-1));
}
{
  const r = run(["scripts/audit-report.js", `--now=${input.run_at}`], join(OUT, "after"));
  check("audit-report.js（after）：集計の不整合なし", r.status === 0);
  log("\n```\n" + r.stdout.trim() + "\n```");
}

// ── V2 確認用サイト（after のデータ） ─────────────────────────
head("V2 表示確認用のコピー");
{
  const site = join(OUT, "site");
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  for (const f of ["analysis-v2.html", "analysis-v2.js"]) cpSync(join(ROOT, f), join(site, f));
  for (const d of ["lib", "config"]) cpSync(join(ROOT, d), join(site, d), { recursive: true });
  cpSync(join(OUT, "after"), join(site, "data"), { recursive: true });
  const url = `http://localhost:8123/${relative(ROOT, site).replace(/\\/g, "/")}/analysis-v2.html`;
  log(`- \`node scripts/serve.js\` を起動して ${url} を開く（リハーサルデータ・本番 data/ とは別）`);
  check("確認用コピーにデモ用の架空データ（Sample League・pe-s*）が含まれない",
    !readFileSync(join(site, "data", "pro_edge.json"), "utf8").match(/Sample League|"pe-s\d/));
}

// ── 本番データ不変 ─────────────────────────────────────
head("本番データ");
check("data/ はリハーサルの前後で1バイトも変わっていない", fingerprint(LIVE_DATA) === liveFingerprint, liveFingerprint.slice(0, 16));
check("data/ に架空のリハーサルデータが無い", !readdirSync(LIVE_DATA, { recursive: true }).filter(f => String(f).endsWith(".json"))
  .some(f => /Rehearsal|rehearsal|-rh-|REHEARSAL/.test(readFileSync(join(LIVE_DATA, String(f)), "utf8"))));

// ── まとめ ─────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
head("まとめ");
log(`- 検証 ${results.length}件：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
for (const f of failed) log(`  - FAIL [${f.section}] ${f.label} ${f.detail}`);
writeFileSync(join(REH_DIR, "result.md"), lines.join("\n").replace(/\r/g, "") + "\n");
console.log(`\n結果を ${relative(ROOT, join(REH_DIR, "result.md"))} に書きました`);
process.exit(failed.length ? 1 : 0);
