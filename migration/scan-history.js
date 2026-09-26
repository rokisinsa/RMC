// 手順2：旧 analysis.html の Git 履歴を走査し、各行の値がいつ・どう変わったかを記録する。
// 事前確率・判定などを「試合開始前に保存されていた値」として採用できるかの根拠に使う。
// 出力: migration/history-report.json
// 使い方: node migration/scan-history.js [終点の参照（既定: baseline-2026-09-26）]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/load-node.js";

const END = process.argv[2] ?? "baseline-2026-09-26";
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tdTexts = inner => [...inner.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map(m => strip(m[1]));

function rowsOf(html) {
  const tables = [...html.matchAll(/<table id="([^"]+)"/g)].map(m => ({ id: m[1], at: m.index }));
  const details = new Map([...html.matchAll(/<tr class="(?:detail-row|test-detail-row)" id="([^"]+)">([^]*?)(?=<tr class="|<\/tbody>)/g)].map(m => [m[1], m[2]]));
  const out = [];
  for (const m of html.matchAll(/<tr([^>]*)>((?:(?!<tr[ >])[^])*?class="match"[^]*?)<\/tr>/g)) {
    const attr = m[1], inner = m[2];
    const table = tables.filter(t => t.at < m.index).at(-1)?.id ?? null;
    const a = k => (new RegExp(`data-${k}="([^"]*)"`).exec(attr) ?? [])[1] ?? null;
    const cls = (/class="([^"]*)"/.exec(attr) ?? [])[1] ?? null;
    const tds = tdTexts(inner);
    const match = strip((/class="match">([^]*?)<\/div>/.exec(inner) ?? [])[1] ?? "").replace(/ ▼$/, "").replace(/▼/g, "").trim();
    const target = a("target");
    const detail = target ? details.get(target) ?? "" : "";
    const gap = (/格差(?:スコア)?(?:<\/?[a-z]+>|[：:\s])*(\d{2,3})/.exec(detail + inner) ?? [])[1] ?? null;
    const probHead = strip((/class="probability-head">\s*<span>[^<]*<\/span>\s*<strong>([^<]*)<\/strong>/.exec(detail) ?? [])[1] ?? "") || null;
    const badge = (/value-badge (\w+)">([^<]*)</.exec(inner) ?? []);
    out.push({
      key: target ? `target:${target}` : `match:${table}:${match}`,
      table, cls, match, target,
      ts: a("ts"), status: a("status"), stake: a("stake"), payout: a("payout"),
      locked_prob: a("locked-prob"), prob_attr: a("prob"),
      symbol: tds[0] ?? null,
      start_text: strip((/class="start-jst">([^]*?)<\/div>/.exec(inner) ?? [])[1] ?? "") || null,
      verdict: badge[1] ?? null, verdict_label: badge[2] ?? null,
      gap, prob_head: probHead,
      tds,
    });
  }
  return out;
}

const commits = git("log", "--reverse", "--format=%H %cI", END, "--", "analysis.html")
  .trim().split("\n").map(l => { const [sha, time] = l.split(" "); return { sha, time }; });

const history = new Map(); // key -> [{sha, time, row}]
for (const c of commits) {
  const html = git("show", `${c.sha}:analysis.html`);
  const seen = new Set();
  for (const row of rowsOf(html)) {
    const k = seen.has(row.key) ? `${row.key}#2` : row.key;
    seen.add(row.key);
    if (!history.has(k)) history.set(k, []);
    const list = history.get(k);
    const { tds, ...fields } = row;
    const sig = JSON.stringify({ ...fields, tds });
    if (list.at(-1)?.sig !== sig) list.push({ sha: c.sha.slice(0, 7), time: c.time, sig, row: { ...fields, tds } });
    else list.at(-1).last_seen = c.time;
  }
}

// analysis.js の確率モデル設定（eventDate・odds）の変遷
const jsCommits = git("log", "--reverse", "--format=%H %cI", END, "--", "analysis.js")
  .trim().split("\n").map(l => { const [sha, time] = l.split(" "); return { sha, time }; });
const models = {};
for (const c of jsCommits) {
  const js = git("show", `${c.sha}:analysis.js`);
  for (const m of js.matchAll(/(\w+):\{\s*family:"(\w+)",display:"([^"]+)",odds:([\d.]+)(?:,opposingOdds:([\d.]+))?,\s*eventDate:"([^"]+)"/g)) {
    const [, key, family, display, odds, opp, eventDate] = m;
    const v = { family, display, odds: Number(odds), opposingOdds: opp ? Number(opp) : null, eventDate };
    models[key] ??= [];
    if (JSON.stringify(models[key].at(-1)?.v) !== JSON.stringify(v)) models[key].push({ sha: c.sha.slice(0, 7), time: c.time, v });
  }
}

const report = {
  end: END,
  commits: commits.length,
  first_commit_time: commits[0].time,
  rows: Object.fromEntries([...history].map(([k, list]) => [k, list.map(({ sig, ...e }) => e)])),
  js_models: models,
};
writeFileSync(join(ROOT, "migration", "history-report.json"), JSON.stringify(report, null, 1) + "\n");
console.log(`commits ${commits.length}, row keys ${history.size}`);
for (const [k, list] of history) console.log(`${list.length.toString().padStart(3)} ${list[0].time.slice(5, 16)} → ${(list.at(-1).last_seen ?? list.at(-1).time).slice(5, 16)}  ${k}`);
