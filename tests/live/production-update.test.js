// 本番更新（scripts/rmc-production-update.mjs）のテスト。
// 架空の payload（tests/fixtures/production-update/）を、不変の移行スナップショットの「一時コピー」にだけ適用する
// （今後の定時更新で data/ が増えても、fixture の時刻と衝突しない）。本番 data/ には dry-run だけを行い、変更しないことを確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, rmSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT, DATA_DIR, loadDatasets, loadSchemas, loadProEdgeConfig } from "../../scripts/load-node.js";
import { runUpdate, serialize, WRITABLE_FILES, AUDIT_FILE } from "../../scripts/rmc-production-update.mjs";
import { validateDataset } from "../../lib/validate.js";
import { checkLockedImmutable, SYSTEMS } from "../../lib/integrity.js";
import { createValidator } from "../../lib/schema-validate.js";
import { buildViewModel } from "../../lib/view/model.js";

const FIX = join(ROOT, "tests", "fixtures", "production-update");
const SNAPSHOT_DATA = join(ROOT, "snapshots", "2026-09-26-migration", "data");
const A = readFileSync(join(FIX, "stage-a.json"), "utf8");
const B = readFileSync(join(FIX, "stage-b.json"), "utf8");
const NOW_A = "2026-09-27T07:00:00+09:00", NOW_B = "2026-09-27T18:30:00+09:00";
const cfg = loadProEdgeConfig();

const fingerprint = dir => {
  const h = createHash("sha256");
  const walk = d => { for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(d, f.name); if (f.isDirectory()) walk(p); else h.update(relative(dir, p)).update(readFileSync(p));
  } };
  walk(dir); return h.digest("hex");
};
const liveBefore = fingerprint(DATA_DIR);
let n = 0;
function tempData() {
  const dir = join(ROOT, ".tmp-tests", "production-update", `t${process.pid}-${n++}`, "data");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(SNAPSHOT_DATA, dir, { recursive: true });
  return dir;
}
const mutate = (text, f) => { const p = JSON.parse(text); f(p); return JSON.stringify(p); };
const run = (payloadText, dataDir, now, apply = true) => runUpdate({ payloadText, dataDir, now, apply, startSha: "0000000", startedAt: now });
const cats = r => r.ledger.errors.map(e => e.category);
function withA() { const dir = tempData(); const r = run(A, dir, NOW_A); assert.ok(r.ok, JSON.stringify(r.ledger.errors)); return dir; }

test("dry-run：本番 data/ を1バイトも変更しない（CLI）", () => {
  const r = spawnSync(process.execPath, ["scripts/rmc-production-update.mjs", "--payload", "tests/fixtures/production-update/stage-a.json", "--dry-run", "--now", NOW_A], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const s of ["追加 19件", "更新 0件", "変更なし 0件", "拒否 0件", "locked違反 0件", "schema違反 0件", "重複 0件", "損益差分", "系統別"]) assert.ok(r.stdout.includes(s), s);
  assert.equal(fingerprint(DATA_DIR), liveBefore);
});

test("dry-run：既存カードの損益は1件も変わらない（新規カードの追加だけ）", () => {
  const r = runUpdate({ payloadText: A, dataDir: DATA_DIR, now: NOW_A, apply: false });
  assert.ok(r.ok);
  assert.deepEqual(r.plChanges, []);
  assert.deepEqual(r.written, []);
});

test("valid payload の apply：検査を通り、更新してよいファイルだけを書く・実行記録を残す", () => {
  const dir = tempData();
  const before = loadDatasets(dir).datasets;
  const r = run(A, dir, NOW_A);
  assert.ok(r.ok, JSON.stringify(r.ledger.errors));
  for (const f of r.written) assert.ok(WRITABLE_FILES.includes(`data/${f.split("/data/")[1]}`), f);
  const after = loadDatasets(dir).datasets;
  assert.deepEqual(validateDataset(after, loadSchemas(), { proEdgeConfig: cfg }).filter(i => i.level === "error"), []);
  for (const s of SYSTEMS) assert.deepEqual(checkLockedImmutable(before[s], after[s]).filter(i => i.level === "error"), [], s);
  // 実行記録（監査）
  const audit = JSON.parse(readFileSync(join(dir, AUDIT_FILE), "utf8"));
  assert.deepEqual(createValidator(loadSchemas())("automation-runs.schema.json", audit), []);
  const rec = audit.runs.at(-1);
  assert.equal(rec.run_id, "fixture-2026-09-27-0600");
  assert.deepEqual(rec.new_candidates, { recommendations: 2, experience: 0, value1: 2, value2: 1, pro_edge: 3 });
  assert.equal(rec.accepted, 6); assert.equal(rec.watch, 1); assert.equal(rec.rejected, 1);
  assert.equal(rec.validation_result, "pass"); assert.equal(rec.actions_result, "pending"); assert.equal(rec.end_sha, null);
  // 手書き書式の match-updates.json は変更なし（結果更新が無いので書かない）
  assert.ok(!r.written.some(f => f.endsWith("match-updates.json")));
  assert.equal(fingerprint(DATA_DIR), liveBefore);
});

test("2回目の定時更新（結果・締切・レビュー）：精算・CLV が自動で反映され、更新ログは追記だけ", () => {
  const dir = withA();
  const muBefore = readFileSync(join(dir, "match-updates.json"), "utf8").replace(/\r/g, "");
  const r = run(B, dir, NOW_B);
  assert.ok(r.ok, JSON.stringify(r.ledger.errors));
  assert.equal(r.record.results_updated, 1);
  assert.equal(r.record.metadata_updated, 2);
  assert.equal(r.record.postmortems_created, 2);
  const muAfter = readFileSync(join(dir, "match-updates.json"), "utf8");
  assert.ok(muAfter.startsWith(muBefore.replace(/\n( *)\]\s*\n\}\s*$/, "")), "既存の書式・内容をそのまま残して追記");
  const vm = buildViewModel(loadDatasets(dir).datasets, { proEdgeConfig: cfg, now: NOW_B });
  const rec = vm.recommendations.rows.find(x => x.id === "rec-fx-00-a").settlement;
  assert.equal(rec.state, "win"); assert.equal(rec.payout, 180); assert.equal(rec.profit, 80);
  const pe = vm.pro_edge.rows.find(x => x.id === "pe-fx-00-a");
  assert.equal(pe.analysis.clv.status, "ok");
  assert.ok(Math.abs(pe.analysis.clv.clv_price - (1.85 / 1.75 - 1)) < 1e-6);
  assert.equal(vm.pro_edge.rows.find(x => x.id === "pe-fx-01").analysis.clv.status, "no_closing_odds");
  assert.equal(r.plChanges.length, 3);           // 同じ試合の ① ② ④（各系統が独立して扱ったカード）
  assert.equal(fingerprint(DATA_DIR), liveBefore);
});

test("同じ run_id の二重適用は拒否。変更0件の回も「完全チェック」の実行記録だけ残す", () => {
  const dir = withA();
  const again = run(A, dir, NOW_A);
  assert.ok(!again.ok);
  assert.ok(cats(again).includes("duplicate"));
  const same = run(mutate(A, p => { p.run_id = "fixture-2026-09-27-0600-rerun"; }), dir, NOW_A);
  assert.ok(same.ok, JSON.stringify(same.ledger.errors));
  assert.equal(same.ledger.count("added") + same.ledger.count("updated"), 0);
  assert.ok(same.ledger.count("unchanged") > 0);
  assert.deepEqual(same.written.map(f => f.split("/").at(-1)), [AUDIT_FILE]);
  const empty = run(JSON.stringify({ payload_version: 1, run_id: "fixture-empty", source: "テスト", generated_at: "2026-09-27T07:10:00+09:00" }), dir, NOW_A);
  assert.ok(empty.ok);
  assert.deepEqual(empty.written.map(f => f.split("/").at(-1)), [AUDIT_FILE]);
  assert.equal(JSON.parse(readFileSync(join(dir, AUDIT_FILE), "utf8")).runs.length, 3);
});

test("locked 改変 payload は拒否（事前値・価格・結果の書き換え）し、data を変更しない", () => {
  const dir = withA();
  const fp = fingerprint(dir);
  const cases = [
    p => { p.systems.recommendations.new_picks[0].odds_taken = 1.95; },
    p => { p.systems.value1.new_picks[0].locked.prob_lo = 0.50; },
    p => { p.systems.pro_edge.new_picks[0].price_snapshots[1].outcomes.side_a = 2.5; },
    p => { p.systems.pro_edge.new_picks[0].locked.base_probability = 0.6; },
    p => { p.matches.new[0].start_at = "2026-09-27T13:00:00+09:00"; },
  ];
  for (const [i, f] of cases.entries()) {
    const r = run(mutate(A, p => { p.run_id = `fixture-locked-${i}`; f(p); }), dir, NOW_A);
    assert.ok(!r.ok, `case ${i}`);
    assert.ok(cats(r).includes("locked"), `case ${i}: ${cats(r)}`);
  }
  const resultOnly = run(mutate(B, p => { p.systems = {}; p.post_match_reviews = {}; }), dir, NOW_B);   // 正しい結果更新だけ
  assert.ok(resultOnly.ok, JSON.stringify(resultOnly.ledger.errors));
  const correction = run(mutate(B, p => { p.run_id = "fixture-correction"; p.systems = {}; p.post_match_reviews = {};
    p.result_updates[0].run_id = "mr-2026-09-27-1805-fixture-correction"; p.result_updates[0].at = "2026-09-27T18:05:00+09:00";
    p.result_updates[0].changes[0].set.result.final = { a: 1, b: 2 }; }), dir, NOW_B);
  assert.ok(!correction.ok, "理由の無い結果の書き換え");
  assert.ok(correction.ledger.errors.some(e => /CORRECTION_REASON/.test(e.message)));
  // 既存の更新ログ・試合事実の書き換え
  const rewrite = run(mutate(B, p => { p.run_id = "fixture-rewrite"; p.result_updates[0].note = "書き換え"; }), dir, NOW_B);
  assert.ok(!rewrite.ok && cats(rewrite).includes("locked"));
  assert.notEqual(fingerprint(dir), fp);          // 正しい結果更新（resultOnly）だけは適用されている
});

test("重複は拒否（同じ系統の同じ試合・市場・選択／別 ID の同じ試合）", () => {
  const dir = withA();
  const dupPick = run(mutate(A, p => { p.run_id = "fixture-dup-1"; const x = p.systems.value2.new_picks[0]; x.id = "v2-fx-01-copy"; p.systems.value2.new_picks.push(x); }), dir, NOW_A);
  assert.ok(!dupPick.ok && cats(dupPick).includes("duplicate"));
  const dupMatch = run(mutate(A, p => { p.run_id = "fixture-dup-2"; p.matches.new = [{ ...p.matches.new[0], id: "2026-09-27-fxpa2-fxpb2" }]; delete p.systems; }), dir, NOW_A);
  assert.ok(!dupMatch.ok && cats(dupMatch).includes("duplicate"));
  const inPayload = run(mutate(A, p => { p.run_id = "fixture-dup-3"; const x = structuredClone(p.systems.recommendations.new_picks[1]); x.id = "rec-fx-01-b"; p.systems.recommendations.new_picks.push(x); }), tempData(), NOW_A);
  assert.ok(!inPayload.ok && cats(inPayload).includes("duplicate"));
});

test("未来情報の混入は拒否（generated_at 以降の時刻・開始後の締切・開始前の結果・未来の payload）", () => {
  const cases = [
    [A, NOW_A, p => { p.systems.recommendations.new_picks[0].locked_at = "2026-09-27T07:30:00+09:00"; }],
    [A, NOW_A, p => { p.systems.pro_edge.new_picks[0].locked.features[0].observed_at = "2026-09-27T08:00:00+09:00"; }],
    [A, "2026-09-27T05:00:00+09:00", p => {}],
  ];
  for (const [i, [text, now, f]] of cases.entries()) {
    const r = run(mutate(text, f), tempData(), now);
    assert.ok(!r.ok && cats(r).includes("future"), `case ${i}: ${cats(r)}`);
  }
  const dir = withA();
  const lateClosing = run(mutate(B, p => { p.systems.pro_edge.append_snapshots[0].snapshot.observed_at = "2026-09-27T12:30:00+09:00"; }), dir, NOW_B);
  assert.ok(!lateClosing.ok && cats(lateClosing).includes("future"), cats(lateClosing));
  const early = run(mutate(B, p => { p.result_updates[0].changes[0].evidence.verified_at = "2026-09-27T11:00:00+09:00"; p.result_updates[0].changes[0].set.result_confirmed_at = "2026-09-27T10:59:00+09:00"; }), dir, NOW_B);
  assert.ok(!early.ok && cats(early).includes("future"), cats(early));
});

test("4系統の独立性：混入・流用・他系統の探索回・市場確率のコピーを拒否", () => {
  const cases = [
    ["schema", p => { p.systems.recommendations.new_picks[0].locked.base_probability = 0.56; }],
    ["schema", p => { p.systems.value1.new_picks[0].market_probability = 0.52; }],
    ["independence", p => { p.systems.pro_edge.new_picks[1].run_id = "pe-2026-09-27-0600-other"; }],
    ["independence", p => { p.systems.pro_edge.new_picks[0].locked.base_probability = 0.55; p.systems.pro_edge.reported = []; }],
    ["independence", p => { p.systems.pro_edge.reported[1].market_probability = 0.5; }],
    ["pro_edge", p => { p.systems.pro_edge.reported[0].ev = 0.2; }],
    ["schema", p => { p.systems.value2.new_picks.push(structuredClone(p.systems.value1.new_picks[1])); }],
  ];
  for (const [i, [cat, f]] of cases.entries()) {
    const r = run(mutate(A, f), tempData(), NOW_A);
    assert.ok(!r.ok && cats(r).includes(cat), `case ${i}: 期待 ${cat} / 実際 ${cats(r)}`);
  }
});

test("JST・null の書き方の誤りを拒否", () => {
  const z = run(mutate(A, p => { p.systems.value2.new_picks[0].locked_at = "2026-09-26T21:28:00Z"; }), tempData(), NOW_A);
  assert.ok(!z.ok && cats(z).includes("jst"));
  const nul = run(mutate(A, p => { p.systems.value2.new_picks[0].locked.summary = "N/A"; }), tempData(), NOW_A);
  assert.ok(!nul.ok && cats(nul).includes("null"));
});

test("書き込みは既存の書式を崩さない（意味の無い差分を作らない）", () => {
  const orig = { a: 1, runs: [{ x: 1 }] };
  const text = '{\n  "a": 1,\n  "runs": [\n    { "x": 1 }\n  ]\n}\n';
  const out = serialize(text, orig, { a: 1, runs: [{ x: 1 }, { x: 2 }] });
  assert.ok(out.startsWith('{\n  "a": 1,\n  "runs": [\n    { "x": 1 }'));
  assert.deepEqual(JSON.parse(out), { a: 1, runs: [{ x: 1 }, { x: 2 }] });
  assert.throws(() => serialize(text, orig, { a: 2, runs: [{ x: 1 }] }));
  assert.equal(serialize(text, orig, structuredClone(orig)), null);
});

test("すべてのテストの後も本番 data/ は不変", () => {
  assert.equal(fingerprint(DATA_DIR), liveBefore);
});
