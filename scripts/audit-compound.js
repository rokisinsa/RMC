// 推奨取引の複利（旧 $114.80 / V2 $140.58）の監査。取引ごとの時刻・順序・資金の推移を出す。
// 旧画面と条件を揃えるため、基準点（06:45）の状態で計算する（基準点後の更新ログは適用しない）。
// 使い方: node scripts/audit-compound.js

import { loadDatasets } from "./load-node.js";
import { summarizeSystem } from "../lib/buckets.js";
import { jst } from "../lib/view/format.js";

const { datasets } = loadDatasets();
const M = new Map(datasets.matches.matches.map(m => [m.id, m]));
const s = summarizeSystem(datasets.recommendations, M);
const settled = s.groups.official.filter(g => ["win", "loss"].includes(g.settlement.state)).map(g => {
  const m = M.get(g.pick.match_id);
  return {
    id: g.pick.id.replace("rec-legacy-", ""), state: g.settlement.state, odds: g.settlement.odds,
    dup: g.pick.flags.includes("duplicate_review"),
    data_ts: g.pick.legacy.sort_at, bet_at: g.pick.bet_at, locked_at: g.pick.locked_at,
    start_at: m.start_at, start_status: m.start_time_status, candidates: m.start_candidates ?? [],
    orderKey: g.settlement.orderKey,
  };
});

function run(order, label) {
  let bal = 100, stock = 0;
  console.log(`\n■ ${label}`);
  order.forEach((t, i) => {
    const before = bal;
    let note = "";
    if (t.state === "loss") { bal = 100; note = "負け → 失敗・元金に戻す"; }
    else {
      bal *= t.odds;
      if (bal >= 200) { stock += bal - 100; note = `倍額到達 → ストック +${(bal - 100).toFixed(2)}・元金に戻す`; bal = 100; }
    }
    console.log(`${String(i + 1).padStart(2)}. ${t.id.padEnd(16)} ${t.state === "win" ? "○" : "×"} ${String(t.odds).padEnd(5)} 資金 ${before.toFixed(2).padStart(7)} → ${bal.toFixed(2).padStart(7)} ${note}`);
  });
  console.log(`   結果：現在資金 $${bal.toFixed(2)} / ストック $${stock.toFixed(2)}`);
}

console.log("■ 確定済みの推奨取引（基準点時点）");
for (const t of settled) {
  console.log(`${t.id.padEnd(16)} ${t.state.padEnd(4)} odds ${String(t.odds).padEnd(5)} 重複:${t.dup ? "あり" : "なし"}  旧data-ts ${jst(t.data_ts) ?? "—"}  bet_at ${t.bet_at ?? "記録なし"}  locked ${jst(t.locked_at) ?? "—"}  開始 ${t.start_at ? jst(t.start_at) : `${t.start_status}${t.candidates.length ? `（候補 ${t.candidates.map(jst).join(" / ")}）` : ""}`}`);
}
console.log(`重複カードの算入：確定済み ${settled.length}件のうち duplicate_review は ${settled.filter(t => t.dup).length}件（重複6組はすべて未確定）`);

const byTs = [...settled].sort((a, b) => Date.parse(a.data_ts) - Date.parse(b.data_ts));
const byKey = [...settled].sort((a, b) => Date.parse(a.orderKey) - Date.parse(b.orderKey));
run(byTs, "旧画面の順序（旧 data-ts＝登録時刻の昇順）");
run(byKey, "V2 の順序（試合開始時刻 → 無ければ locked_at → 旧 data-ts）");

// 次の取引の登録時刻が、前の取引の試合開始より前（＝前の結果が出る前に次を登録している）箇所
console.log("\n■ 結果確定前に次の取引が登録されている箇所（旧 data-ts 順）");
for (let i = 1; i < byTs.length; i++) {
  const prev = byTs[i - 1], next = byTs[i];
  const prevStart = prev.start_at ?? (prev.candidates[0] ?? null);
  if (!prevStart) console.log(`- ${prev.id} → ${next.id}：前の試合の開始時刻が不明のため判定不能`);
  else if (Date.parse(next.data_ts) < Date.parse(prevStart)) console.log(`- ${prev.id}（開始 ${jst(prevStart)}）→ ${next.id}（登録 ${jst(next.data_ts)}）：前の試合の開始前に次を登録`);
}
