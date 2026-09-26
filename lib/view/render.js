// V2 画面の HTML 生成（表示用モデル → HTML 文字列）。計算はしない。データ由来の文字列はすべてエスケープする。
// 旧RMCの分析メモ（本文）は data に移していないため、ブラウザ側で analysis.html から該当箇所を差し込む
// （ここでは差し込み先 <div data-legacy-key> だけを出す）。

import { esc, money, amount, pct, pctRaw, pt, signedPct, odds, range, jst, RESULT_SYMBOL } from "./format.js";

const card = (label, value, { note = "", tone = "" } = {}) =>
  `<div class="card"><div class="label">${esc(label)}</div><div class="value ${tone}">${value}</div>${note ? `<div class="note-s">${note}</div>` : ""}</div>`;
const toneOf = v => (v == null ? "" : v > 0 ? "plus" : v < 0 ? "minus" : "");
const badges = q => `<div class="badges">${q.map(b => `<span class="badge ${b.level}">${esc(b.label)}</span>`).join("")}</div>`;
const record = s => `${s.settledGames}戦 ${s.wins}勝 ${s.losses}敗${s.pushes ? ` / 返金${s.pushes}` : ""}${s.voids ? ` / 無効${s.voids}` : ""}`;
const winRate = s => (s.winRate == null ? "—（確定0件）" : pctRaw(s.winRate));
const roi = s => (s.roi == null ? "—（確定0件）" : `${s.roi >= 0 ? "+" : ""}${s.roi.toFixed(2)}%`);

function startCell(r) {
  const m = r.match;
  if (!m) return "—";
  if (m.start_at) return `<div>${esc(jst(m.start_at))}</div>`;
  const cand = m.start_candidates?.length ? `<div class="sub">候補：${m.start_candidates.map(c => esc(jst(c))).join(" / ")}</div>` : "";
  const raw = r.legacy?.raw?.date_and_start_text ? `<div class="sub">旧表記：${esc(r.legacy.raw.date_and_start_text)}</div>` : "";
  return `<div class="warn-t">${m.start_time_status === "review_required" ? "開始時刻 要確認" : "開始時刻 未確認"}</div>${cand}${raw}`;
}

function resultCell(r) {
  const s = r.settlement.state;
  return `<td class="result ${s}">${RESULT_SYMBOL[s] ?? "△"}</td>`;
}

// 投入額・払戻し・損益（未確定は「予定」、オッズ不明は未計算。−$100 扱いにしない）
function moneyCells(r, { reference = false } = {}) {
  const s = r.settlement;
  const tag = reference ? '<span class="sub">（参考・$100仮定）</span>' : "";
  if (s.state === "pending") {
    if (s.projectedProfit == null) return `<td class="money">${amount(s.stake)}</td><td class="money pending">未確定</td><td class="money pending">未確定<div class="sub">オッズ未確定のため予想損益は未計算</div></td>`;
    return `<td class="money">${amount(s.stake)}</td><td class="money pending">${amount(s.stake + s.projectedProfit)} 予定</td><td class="money pending">${money(s.projectedProfit)} 予定${tag}</td>`;
  }
  if (s.profit == null) return `<td class="money">${amount(s.stake)}</td><td class="money pending">金額未計算</td><td class="money pending">金額未計算<div class="sub">オッズがレンジのみ（一点に固定しない）</div></td>`;
  return `<td class="money">${amount(s.stake)}</td><td class="money">${amount(s.payout)}</td><td class="money ${toneOf(s.profit) === "plus" ? "positive" : toneOf(s.profit) === "minus" ? "negative" : ""}">${money(s.profit)}${tag}</td>`;
}

function oddsCell(r) {
  if (r.odds_taken != null) return odds(r.odds_taken);
  if (r.market_odds) return `<span class="warn-t">${esc(r.market_odds.text)}</span>`;
  return '<span class="warn-t">未確認</span>';
}

function matchCell(r) {
  const m = r.match;
  return `<div class="match">${esc(m?.card ?? "—")} <span class="chev">▼</span></div>`
    + `<div class="market">${esc([m?.competition, r.market_label].filter(Boolean).join(" / "))}</div>`
    + `<div class="market">選択：${esc(r.selection_label ?? r.selection)}</div>`;
}

// 事前値：locked（試合前に固定）と、現在モデルの参考再計算は完全に別表示
function lockedBlock(r, fields) {
  const lockLine = r.locked_at
    ? `<div class="ok-t">試合前に固定：${esc(jst(r.locked_at))}</div>`
    : '<div class="warn-t">試合前の固定を確認できない（事前値は表示しない）</div>';
  const rows = fields.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`).join("");
  const recalc = r.recalculated_reference.length
    ? `<div class="recalc"><div class="recalc-title">現在モデルによる参考再計算（事前確率ではありません）</div>${r.recalculated_reference.map(x => `<div>${pct(x.prob)}（モデル v${esc(x.model_version)}・${esc(jst(x.at))}計算）</div>`).join("")}</div>`
    : "";
  return `<div class="box"><h3>事前値（locked）</h3>${lockLine}<table class="kv">${rows}</table>${r.lock_evidence ? `<div class="sub">根拠：${esc(r.lock_evidence)}</div>` : ""}${recalc}</div>`;
}

function factsBlock(r) {
  const m = r.match;
  if (!m) return "";
  const notes = [m.start_time_note].filter(Boolean).map(n => `<div class="sub">${esc(n)}</div>`).join("");
  return `<div class="box"><h3>試合事実（matches.json）</h3><table class="kv">
    <tr><th>競技</th><td>${esc(m.sport)}</td></tr><tr><th>大会</th><td>${esc(m.competition ?? "—")}</td></tr>
    <tr><th>開始</th><td>${m.start_at ? esc(jst(m.start_at)) : '<span class="warn-t">未確認</span>'}</td></tr>
    <tr><th>状態 / 結果</th><td>${esc(m.status)} / ${esc(r.result_text)}</td></tr></table>${notes}</div>`;
}

const legacySlot = r => (r.legacy
  ? `<div class="legacy-detail" data-legacy-key="${esc(r.detail_ref ? `id:${r.detail_ref}` : `${r.legacy.table}#${r.legacy.row_index}`)}"><div class="sub">旧RMCの分析メモを読み込み中…</div></div>`
  : "");

const detailRow = (r, cols, inner) => `<tr class="detail-row" id="d-${esc(r.id)}" hidden><td colspan="${cols}" class="detail-cell">${inner}</td></tr>`;

// ── ① 推奨取引 ──────────────────────────────────────────
function renderRecommendations(v) {
  const s = v.summary, c = v.compound, k = v.kelly, cal = v.calibration;
  const cards = [
    card("戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card("確定純損益（単利）", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}` }),
    card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
    card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}（オッズ既知 ${s.openProjectedCount}件）／オッズ未確定 ${s.openUncomputed}件は未計算` }),
    card("複利", money(c.profit), { tone: toneOf(c.profit), note: `現在資金 ${amount(c.balance)}／複利ストック ${amount(c.stock)}（確保 ${c.cycles}回・失敗 ${c.failures}回）` }),
    card("1/4ケリー", money(k.profit), { tone: toneOf(k.profit), note: `試合前に固定された事前確率だけで計算（賭け ${k.bets}件・見送り ${k.skipped}件）` }),
  ].join("");
  const rows = v.rows.map(r => {
    const L = r.locked ?? {};
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td>${startCell(r)}</td><td class="sport-col">${esc(r.match?.sport ?? "—")}</td>`
      + `<td>${matchCell(r)}${badges(r.quality)}</td><td class="market-result">${esc(r.result_text)}</td><td>${oddsCell(r)}</td>${moneyCells(r)}`
      + `<td class="conf">${esc(L.confidence ?? "—")}${L.gap_score != null ? `<div class="sub">格差${esc(L.gap_score)}</div>` : ""}</td></tr>`;
    const detail = `<div class="detail-grid">${factsBlock(r)}${lockedBlock(r, [
      ["事前確率", L.prob != null ? pct(L.prob) : '<span class="muted">記録なし</span>'],
      ["信頼度", esc(L.confidence ?? "—")], ["格差スコア", L.gap_score != null ? `${esc(L.gap_score)}/100（勝率ではない）` : "—"],
    ])}</div>${legacySlot(r)}`;
    return main + detailRow(r, 10, detail);
  }).join("");
  return `<section class="system" id="sec-rec"><h2 class="section-title">① 推奨取引</h2>
    <p class="note">1件 $100。数値はすべて data/recommendations.json と matches.json から自動計算しています。重複確認中 ${v.duplicates.groups}組（${v.duplicates.rows}件）は統合・削除せず両方を表示し、集計にも両方を含めています。</p>
    <div class="summary">${cards}</div>
    <div class="calib">精度検証（試合前に固定された事前確率のみ）：${cal.count ? `${cal.count}件｜Brier ${cal.brier.toFixed(4)}｜Log Loss ${cal.log_loss.toFixed(4)}` : "対象0件"}</div>
    <div class="table-wrap"><table><thead><tr><th>結果</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 状態</th><th>結果内容</th><th>オッズ</th><th class="money">投入額</th><th class="money">払戻し / 予定</th><th class="money">損益</th><th>信頼度</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

// ── 経験値取引 ─────────────────────────────────────────
function renderExperience(v) {
  const s = v.summary;
  const cards = [
    card("確定収支", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}` }),
    card("戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card("確定済み投入額", amount(s.settledStake), { note: `投入額合計（予定含む） ${amount(s.plannedStake)}` }),
    card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}／オッズ未確定 ${s.openUncomputed}件` }),
  ].join("");
  const rows = v.rows.map(r => `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td>${startCell(r)}</td><td class="sport-col">${esc(r.match?.sport ?? "—")}</td>`
    + `<td>${matchCell(r)}${badges(r.quality)}</td><td>${esc(r.market_label ?? "")}</td><td>${oddsCell(r)}</td>${moneyCells(r)}</tr>`
    + detailRow(r, 9, `<div class="detail-grid">${factsBlock(r)}</div>`)).join("");
  return `<section class="system actual" id="sec-exp"><h2 class="section-title">経験値取引（実投入）</h2>
    <p class="note">推奨取引とは別管理。実際に投入した金額だけを集計します（分析系統ではありません）。</p>
    <div class="summary four">${cards}</div>
    <div class="table-wrap"><table><thead><tr><th>結果</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 状態</th><th>ベット内容</th><th>オッズ</th><th class="money">投入額</th><th class="money">払戻し / 予定</th><th class="money">損益</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ── ② VALUE① / ③ VALUE② ────────────────────────────────
const VERDICT = {
  formal: ["正式VALUE", "formal"], conditional: ["条件付きVALUE", "conditional"], watch: ["監視", "watch"], excluded: ["除外", "exclude"],
  adopted: ["VALUE②採用", "formal"],
};
const BUCKET_NOTE = { official: "本成績", reference: "参考成績", conditional_unmet: "集計外（条件成立未確認）", excluded: "集計外", unlocked: "集計外（未固定）" };

function officialCards(s, comp, extra = []) {
  return [
    card("戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card("純損益（$100固定）", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}` }),
    card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
    card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}／オッズ未確定 ${s.openUncomputed}件は未計算` }),
    ...(comp ? [card("複利", money(comp.profit), { tone: toneOf(comp.profit), note: `現在資金 ${amount(comp.balance)}／ストック ${amount(comp.stock)}` })] : []),
    card("最大連敗", `${s.maxLosingStreak}`, { note: "確定カード・試合開始順" }),
    ...extra,
  ].join("");
}
function referenceCards(s) {
  return [
    card("参考戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card("参考損益（$100仮定）", money(s.netProfit), { tone: toneOf(s.netProfit), note: s.amountMissing ? `金額未計算 ${s.amountMissing}件（オッズがレンジのみ）` : "" }),
    card("参考 未確定", `${s.pending}件`, { tone: "gold", note: `オッズ未確定 ${s.openUncomputed}件` }),
  ].join("");
}

function renderValue(v, { id, title, note, second }) {
  const cols = second ? 14 : 13;
  const closingCount = v.rows.filter(r => r.bucket === "official" && r.closing_odds != null).length;
  const counts = Object.entries(v.verdict_counts).map(([k, n]) => `<div class="value-mini">${esc(VERDICT[k]?.[0] ?? k)}<strong>${n}件</strong></div>`).join("")
    + (v.bucket_counts.conditional_unmet ? `<div class="value-mini">条件付き：本成績に算入<strong>${v.rows.filter(r => r.locked?.verdict === "conditional" && r.bucket === "official").length}件</strong></div><div class="value-mini">条件付き：成立未確認で集計外<strong>${v.bucket_counts.conditional_unmet}件</strong></div>` : "");
  const rows = v.rows.map(r => {
    const L = r.locked ?? {};
    const [vlabel, vcls] = VERDICT[L.verdict] ?? [L.verdict ?? "—", ""];
    const mid = second
      ? `<td>${range(L.market_gap_lo, L.market_gap_hi, x => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}pt`))}</td><td>${esc({ low: "低", mid: "中", mid_high: "中〜高", high: "高" }[L.upset_risk] ?? "—")}</td>`
      : `<td>${range(L.ev_lo, L.ev_hi, signedPct)}</td>`;
    const moneyPart = r.bucket === "official" ? moneyCells(r)
      : r.bucket === "reference" ? moneyCells({ ...r, settlement: { ...r.settlement } }, { reference: true })
      : `<td class="money muted">—</td><td class="money muted">—</td><td class="money muted">${esc(BUCKET_NOTE[r.bucket])}</td>`;
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td><span class="value-badge ${vcls}">${esc(vlabel)}</span><div class="sub">${esc(BUCKET_NOTE[r.bucket])}</div></td>`
      + `<td>${startCell(r)}</td><td>${esc(r.match?.sport ?? "—")}</td><td>${matchCell(r)}${badges(r.quality)}</td><td>${oddsCell(r)}</td>`
      + `<td>${L.required_prob != null ? pct(L.required_prob) : esc(r.legacy?.raw?.required_prob_text ?? "—")}</td><td>${range(L.prob_lo, L.prob_hi)}</td>${mid}${moneyPart}<td>${r.closing_odds != null ? odds(r.closing_odds) : "—"}</td></tr>`;
    const cond = r.condition ? [["条件", esc(r.condition.text)], ["条件成立", r.condition.met === true ? "成立（試合前に確認）" : '<span class="warn-t">未確認（本成績に算入しない）</span>']] : [];
    const detail = `<div class="detail-grid">${factsBlock(r)}${lockedBlock(r, [
      ["判定", esc(vlabel)], ["必要勝率", L.required_prob != null ? pct(L.required_prob) : "—"], ["推定勝率", range(L.prob_lo, L.prob_hi)],
      ...(second ? [["市場差", range(L.market_gap_lo, L.market_gap_hi, x => (x == null ? "—" : `${x}pt`))]] : [["推定EV", range(L.ev_lo, L.ev_hi, signedPct)]]),
      ...cond,
    ])}</div>${legacySlot(r)}`;
    return main + detailRow(r, cols, detail);
  }).join("");
  const head = second
    ? "<th>市場差</th><th>Upset Risk</th>"
    : "<th>推定EV</th>";
  return `<section class="system value" id="${id}"><h2 class="section-title">${esc(title)}</h2><p class="note">${esc(note)}</p>
    <h3 class="panel-title">本成績</h3><div class="summary">${officialCards(v.official, v.official_compound, second
      ? [card("CLV", closingCount ? `${closingCount}件取得` : "集計待ち", { note: "Closing オッズ取得後に更新" })]
      : [card("1/4ケリー", "集計保留", { note: "推定勝率がレンジ（点推定なし）のため算出しない" })])}</div>
    <h3 class="panel-title ref">参考成績（監視・$100仮定。本成績とは別枠）</h3><div class="summary three">${referenceCards(v.reference)}</div>
    <div class="value-overview">${counts}</div>
    <div class="table-wrap"><table data-cols="${cols}"><thead><tr><th>結果</th><th>判定</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 選択 / 状態</th><th>取得オッズ</th><th>必要勝率</th><th>推定勝率</th>${head}<th class="money">投入</th><th class="money">払戻し</th><th class="money">損益</th><th>Closing</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderUnassigned(list) {
  if (!list.length) return "";
  return `<section class="system unassigned" id="sec-unassigned"><h2 class="section-title">系統未確定の除外ログ</h2>
    <p class="note">旧RMCでは VALUE② 欄に記載されていましたが、VALUE①・VALUE② のどちらの除外か確定できないため、どの系統にも帰属させずに表示しています（成績には含めません）。</p>
    <div class="excluded-log">${list.map(e => `<div>・${esc(e.label)} <span class="badge warn">系統未確定</span></div>`).join("")}</div></section>`;
}

// ── ④ PRO EDGE ─────────────────────────────────────────
const WINDOW_LABEL = { last_20: "直近20", last_50: "直近50", last_100: "直近100", all: "全期間" };

function metricsTable(m) {
  if (!m || m.status !== "ok") return `<div class="insufficient">サンプル不足（n=${m?.sample_size ?? 0}${m?.required_sample ? ` / 必要 ${m.required_sample}件` : ""}）</div>`;
  const f4 = x => (x == null ? "—" : x.toFixed(4));
  return `<table class="kv metrics">
    <tr><th>戦績</th><td>${m.sample_size}戦 ${m.wins}勝 ${m.losses}敗</td></tr><tr><th>Hit Rate</th><td>${pctRaw(m.hit_rate)}</td></tr>
    <tr><th>純損益</th><td>${money(m.net_profit)}</td></tr><tr><th>ROI</th><td>${m.roi == null ? "—" : `${m.roi.toFixed(2)}%`}</td></tr>
    <tr><th>Average EV（判断時 / 購入時）</th><td>${signedPct(m.average_ev_decision)} / ${signedPct(m.average_ev_bet)}</td></tr>
    <tr><th>Average CLV（価格）</th><td>${signedPct(m.average_clv_price)}（n=${m.clv_sample_size}）</td></tr>
    <tr><th>Median CLV（価格）</th><td>${signedPct(m.median_clv_price)}</td></tr>
    <tr><th>Average / Median CLV（確率）</th><td>${pt(m.average_clv_probability, 2)} / ${pt(m.median_clv_probability, 2)}（n=${m.clv_probability_sample_size}）</td></tr>
    <tr><th>Brier Score</th><td>${f4(m.brier)}</td></tr><tr><th>Log Loss</th><td>${f4(m.log_loss)}</td></tr></table>`;
}

function evaluationPanel(ev, key) {
  const tabs = Object.keys(WINDOW_LABEL).map(w => `<button type="button" class="win-tab${w === "all" ? " active" : ""}" data-window-group="${key}" data-window="${w}">${WINDOW_LABEL[w]}</button>`).join("");
  const panels = Object.keys(WINDOW_LABEL).map(w => `<div class="win-panel" data-window-group="${key}" data-window-panel="${w}"${w === "all" ? "" : " hidden"}>${metricsTable(ev[w])}</div>`).join("");
  const cal = ev.calibration;
  const calHtml = cal.status !== "ok"
    ? `<div class="insufficient">Calibration：サンプル不足（n=${cal.sample_size} / 必要 ${cal.min_total}件）</div>`
    : `<table class="kv"><tr><th>予測帯</th><th>件数</th><th>予測平均</th><th>実際の的中率</th></tr>${cal.bins.filter(b => b.count).map(b => `<tr><td>${pct(b.from, 0)}〜${pct(b.to, 0)}</td><td>${b.count}</td><td>${b.status === "ok" ? pct(b.mean_predicted) : "サンプル不足"}</td><td>${b.status === "ok" ? pct(b.observed_rate) : "サンプル不足"}</td></tr>`).join("")}</table>`;
  return `<div class="win-tabs">${tabs}</div>${panels}<div class="calib">${calHtml}</div>`;
}

function feat(r, ...names) {
  const f = names.map(n => r.features[n]).find(Boolean);
  if (!f) return '<span class="muted">—</span>';
  return f.status === "missing" ? '<span class="warn-t">情報不足</span>' : esc(typeof f.value === "object" ? JSON.stringify(f.value) : f.value);
}

function renderProEdge(v, { demo }) {
  const s = v.official;
  const counts = ["accepted", "watch", "rejected"].map(k => `<div class="value-mini">${{ accepted: "accepted（本成績）", watch: "watch（参考成績）", rejected: "rejected（成績対象外）" }[k]}<strong>${v.decision_counts[k] ?? 0}件</strong></div>`).join("");
  const rows = v.rows.map(r => {
    const a = r.analysis, L = r.locked ?? {};
    const current = a.offered_odds != null ? odds(a.offered_odds) : "—";
    const dec = { official: "accepted", reference: "watch", excluded: "rejected", unlocked: "未固定" }[r.bucket];
    const moneyPart = r.bucket === "official" ? moneyCells(r) : r.bucket === "reference" ? moneyCells(r, { reference: true })
      : '<td class="money muted">—</td><td class="money muted">—</td><td class="money muted">成績対象外</td>';
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td><span class="value-badge ${r.bucket === "official" ? "formal" : r.bucket === "reference" ? "watch" : "exclude"}">${esc(dec)}</span></td>`
      + `<td>${startCell(r)}</td><td>${esc(r.match?.sport ?? "—")}<div class="sub">${esc(r.match?.region ?? "地域 —")}</div></td><td>${matchCell(r)}${badges(r.quality)}</td>`
      + `<td>${current}</td><td>${pct(a.market_probability)}</td><td>${pct(a.final_probability)}</td><td>${pt(a.edge)}</td><td>${signedPct(a.ev)}</td><td>${odds(a.minimum_entry_odds)}</td>${moneyPart}</tr>`;
    const adj = (L.expert_adjustments ?? []).map(x => `<li>${pt(x.adjustment_value)}：${esc(x.reason)}（${esc(x.source)}・${esc(jst(x.created_at))}）</li>`).join("") || "<li>なし</li>";
    const list = arr => (arr?.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : '<span class="muted">—</span>');
    const src = (a.market_sources ?? []).map(x => `${esc(x.bookmaker)}（${esc(jst(x.observed_at))}）`).join(" / ");
    const detail = `<div class="detail-grid">
      <div class="box"><h3>価格と推定</h3><table class="kv">
        <tr><th>現在オッズ（提示）</th><td>${current}${a.offered_source ? `<div class="sub">${esc(a.offered_source.bookmaker)}・${esc(jst(a.offered_source.observed_at))}</div>` : ""}</td></tr>
        <tr><th>市場適正勝率（no-vig）</th><td>${pct(a.market_probability)}（${esc(a.market_method === "consensus" ? "複数社 consensus" : "1社")}）<div class="sub">${src}</div></td></tr>
        <tr><th>RMC基本推定勝率</th><td>${pct(a.base_probability)}</td></tr>
        <tr><th>Expert補正</th><td>${pt(a.expert_adjustment)}<ul>${adj}</ul></td></tr>
        <tr><th>RMC最終推定勝率</th><td>${pct(a.final_probability)}</td></tr>
        <tr><th>Fair Odds</th><td>${odds(a.fair_odds)}</td></tr><tr><th>EDGE</th><td>${pt(a.edge)}</td></tr>
        <tr><th>EV</th><td>${signedPct(a.ev)}（required_EV ${pct(a.required_ev)}）</td></tr><tr><th>最低購入オッズ</th><td>${odds(a.minimum_entry_odds)}</td></tr></table></div>
      <div class="box"><h3>試合データ（事前）</h3><table class="kv">
        <tr><th>H2H</th><td>${feat(r, "h2h_all")}</td></tr><tr><th>直近6試合</th><td>${feat(r, "recent6", "recent6_record")}</td></tr>
        <tr><th>Ranking / Rating</th><td>${feat(r, "ranking")} / ${feat(r, "rating")}</td></tr>
        <tr><th>平均得失点 / SET / MAP差</th><td>${feat(r, "avg_points_for")} ・ ${feat(r, "set_diff")} ・ ${feat(r, "map_diff")}</td></tr>
        <tr><th>データ信頼度</th><td>${esc(L.data_confidence ?? "—")}</td></tr></table></div>
      <div class="box"><h3>分析</h3><div class="sub">主な価格差要因</div>${list(L.price_gap_factors)}<div class="sub">RMCと市場が食い違う理由</div>${list(L.disagreement_reasons)}<div class="sub">情報不足項目</div>${list(L.missing_information)}</div>
      <div class="box"><h3>価格推移と CLV</h3><table class="kv">
        <tr><th>opening odds</th><td>${odds(a.opening_odds)}</td></tr><tr><th>bet odds</th><td>${odds(a.bet_odds)}</td></tr><tr><th>closing odds</th><td>${odds(a.closing_odds)}</td></tr>
        <tr><th>価格ベースCLV</th><td>${a.clv.clv_price == null ? "未計算" : signedPct(a.clv.clv_price, 2)}</td></tr>
        <tr><th>確率ベースCLV</th><td>${a.clv.clv_probability == null ? "未計算" : pt(a.clv.clv_probability, 2)}</td></tr>
        <tr><th>結果 / $100投入時の損益</th><td>${esc(r.result_text)} / ${r.settlement.profit == null ? "—" : money(r.settlement.profit)}</td></tr></table></div>
      ${factsBlock(r)}</div>`;
    return main + detailRow(r, 14, detail);
  }).join("");
  const table = v.rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>結果</th><th>判定</th><th>開始（JST）</th><th>競技 / 地域</th><th>組み合わせ / 市場 / 選択</th><th>現在オッズ</th><th>市場適正</th><th>RMC最終</th><th>EDGE</th><th>EV</th><th>最低購入</th><th class="money">投入</th><th class="money">払戻し</th><th class="money">損益</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="empty">まだ④のカードはありません（④の候補は④自身の探索回で独立に追加されます）。</div>';
  return `<section class="system pro-edge" id="sec-pe"><h2 class="section-title">④ PRO EDGE｜プロ型価格分析</h2>
    ${demo ? '<div class="demo-banner">デモ表示：架空のサンプルデータです（実在の試合・実際のオッズではありません）</div>' : ""}
    <p class="lead">強い側を探すのではなく、市場適正確率（控除除去）とRMC独自推定勝率の差から価格の歪みを検出する独立分析です。①②③とは別に探索・分析・判定しています。</p>
    <div class="value-overview">${counts}</div>
    <h3 class="panel-title">本成績（accepted）</h3>
    <div class="summary four">${[
      card("戦績", record(s), { note: `Hit Rate ${winRate(s)}` }),
      card("純損益", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}` }),
      card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
      card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}` }),
    ].join("")}</div>
    <div class="eval">${evaluationPanel(v.evaluation.official, "pe-official")}</div>
    <h3 class="panel-title ref">参考成績（watch・提示価格で$100仮定。本成績とは別枠）</h3>
    <div class="summary three">${referenceCards(v.reference)}</div>
    <div class="eval">${evaluationPanel(v.evaluation.reference, "pe-reference")}</div>
    ${table}</section>`;
}

// ── ページ全体 ─────────────────────────────────────────
export function renderPage(vm, { demo = false } = {}) {
  const runs = vm.meta.update_runs.map(r => `${esc(r.run_id)}（${esc(r.kind)}・${esc(jst(r.at))}）`).join(" → ");
  return `<div class="data-status">データ時点：${esc(jst(vm.meta.as_of) ?? "—")}／状態：${esc(vm.meta.status ?? "—")}（移行用下書き）<div class="sub">試合事実の更新回：${runs}</div></div>
    <nav class="sys-nav"><a href="#sec-rec">① 推奨取引</a><a href="#sec-v1">② VALUE①</a><a href="#sec-v2">③ VALUE②</a><a href="#sec-pe">④ PRO EDGE</a><a href="#sec-exp">経験値取引</a></nav>
    ${renderRecommendations(vm.recommendations)}
    ${renderValue(vm.value1, { id: "sec-v1", title: "② VALUE①", note: "正式VALUE＝本成績、監視＝参考成績、条件付きVALUE＝試合開始前に条件成立（condition.met=true）が確認されたものだけ本成績。本成績と参考成績は別枠で集計します。" })}
    ${renderValue(vm.value2, { id: "sec-v2", title: "③ VALUE②", note: "VALUE②採用＝本成績、監視＝参考成績。VALUE①とは別に集計します。", second: true })}
    ${renderUnassigned(vm.legacy_unassigned)}
    ${renderProEdge(vm.pro_edge, { demo })}
    ${renderExperience(vm.experience)}`;
}
