// V2 画面の HTML 生成（表示用モデル → HTML 文字列）。計算はしない。データ由来の文字列はすべてエスケープする。
// 旧RMCの分析メモ（本文）は data に移していないため、ブラウザ側で analysis.html から該当箇所を差し込む
// （ここでは差し込み先 <div data-legacy-key> だけを出す）。

import { esc, money, amount, pct, pctRaw, pt, signedPct, odds, range, jst, RESULT_SYMBOL } from "./format.js";

const card = (label, value, { note = "", tone = "" } = {}) =>
  `<div class="card"><div class="label">${esc(label)}</div><div class="value ${tone}">${value}</div>${note ? `<div class="note-s">${note}</div>` : ""}</div>`;
const summaryTable = rows => `<div class="table-wrap compact-summary-wrap"><table class="compact-summary"><tbody>${rows.map(([label,value,note=""])=>`<tr><th>${esc(label)}</th><td>${value}</td><td class="sub">${note}</td></tr>`).join("")}</tbody></table></div>`;
const toneOf = v => (v == null ? "" : v > 0 ? "plus" : v < 0 ? "minus" : "");
const badges = q => `<div class="badges">${q.map(b => `<span class="badge ${b.level}"${b.note ? ` title="${esc(b.note)}"` : ""}>${esc(b.label)}</span>`).join("")}</div>`;

// 複利：取引順序を証明できない場合は参考値として表示し、2通りの順序の値を併記する
function compoundCard(comp, audit) {
  if (!comp) return "";
  if (audit?.status === "confirmed") {
    const o = audit.official_order;
    return card("複利", money(o.profit), { tone: toneOf(o.profit), note: `投入時刻順（正式）：現在資金 ${amount(o.balance)}／ストック ${amount(o.stock)}（確保 ${o.cycles}回・失敗 ${o.failures}回）` });
  }
  if (audit?.status === "no_settled") return card("複利", money(comp.profit), { note: "確定0件" });
  const alt = audit?.alternative_by_registration;
  const note = `参考：試合開始時刻順 現在資金 ${amount(comp.balance)}／ストック ${amount(comp.stock)}（確保 ${comp.cycles}回・失敗 ${comp.failures}回）`
    + (alt ? `<br>参考：旧画面と同じ登録時刻順 現在資金 ${amount(alt.balance)}／ストック ${amount(alt.stock)}` : "")
    + `<br>正式値にしない理由：${esc((audit?.reasons ?? []).join("／"))}`;
  return card("複利（参考値・取引順序未確定）", "参考値", { tone: "muted", note });
}
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

// 旧RMCの分析メモ（data/legacy-analysis に移行済みの原文を構造化して表示。旧 analysis.html は参照しない）
function renderBlock(b) {
  switch (b.type) {
    case "title": return `<div class="la-title">${esc(b.text)}</div>`;
    case "subtitle": return `<div class="sub">${esc(b.text)}</div>`;
    case "section": case "heading": return `<div class="la-section">${esc(b.text)}</div>`;
    case "reason": return `<div class="la-reason">${esc(b.text)}</div>`;
    case "note": return `<div class="sub">${esc(b.text)}</div>`;
    case "text": return `<p>${esc(b.text)}</p>`;
    case "lines": return `<div class="la-lines">${b.lines.map(l => `<div>${esc(l)}</div>`).join("")}</div>`;
    case "items": return `<div class="la-items">${b.title ? `<div class="la-section">${esc(b.title)}</div>` : ""}<div class="la-grid">${b.items.map(i => `<div class="la-item"><span>${esc(i.label)}</span><strong>${esc(i.value)}</strong></div>`).join("")}</div>${(b.notes ?? []).map(n => `<div class="la-reason">${esc(n)}</div>`).join("")}</div>`;
    case "boxes": return `<div class="la-grid">${b.boxes.map(x => `<div class="box"><h3>${esc(x.title)}</h3>${x.paragraphs.map(p => `<p>${esc(p)}</p>`).join("")}${x.list.length ? `<ul>${x.list.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</div>`).join("")}</div>`;
    case "table": return `<div class="table-wrap la-table"><table><thead><tr>${b.headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    default: return "";
  }
}
const CATEGORY = { variance: "想定内の外れ", model_error: "推定の誤り", information_missing: "事前に取得できなかった情報", late_news: "直前情報", market_moved: "市場の変化", data_error: "データの誤り", execution: "価格・投入の問題", other: "その他" };
function postMatchSlot(r) {
  if (!r.post_match_reviews?.length) return "";
  return `<div class="box"><h3>試合後レビュー（この系統の記録）</h3>${r.post_match_reviews.map(x => `<div><strong>${esc(CATEGORY[x.category] ?? x.category)}</strong>（${esc(x.update_run)}）：${esc(x.findings)}${x.missing_data.length ? `<div class="sub">不足データ：${esc(x.missing_data.join("、"))}</div>` : ""}${x.proposal ? `<div class="sub">改善提案（未適用）：${esc(x.proposal)}</div>` : ""}</div>`).join("")}</div>`;
}
function legacySlot(r) {
  const la = r.legacy_analysis;
  if (!la) return r.legacy ? '<div class="legacy-detail"><div class="sub">旧RMCの分析メモはありません</div></div>' : "";
  const js = la.js_summary
    ? `<div class="box"><h3>旧RMCの要約</h3><table class="kv"><tr><th>対象</th><td>${esc(la.js_summary.market)}</td></tr><tr><th>一番強い根拠</th><td>${esc(la.js_summary.reason)}</td></tr><tr><th>注意点</th><td>${esc(la.js_summary.caution)}</td></tr></table></div>`
    : "";
  return `<div class="legacy-detail"><div class="legacy-title">旧RMCの分析メモ（移行済みの原文。事前固定を確認できない確率表示は除外）</div>${js}<div class="legacy-body">${la.blocks.map(renderBlock).join("")}</div><div class="sub">出典：${esc(la.source.file)}@${esc(la.source.commit)} ${esc(la.source.location)}</div></div>`;
}

const detailRow = (r, cols, inner) => `<tr class="detail-row" id="d-${esc(r.id)}" hidden><td colspan="${cols}" class="detail-cell">${inner}</td></tr>`;

const ANALYSIS_OUTCOME = {
  candidate: ["採用候補", "formal"], watch: ["監視", "watch"], reject: ["除外", "exclude"], insufficient_data: ["調査不能", "conditional"]
};
const DIAGNOSTIC_ANALYSIS_RE = /(?:\bCI\b|live coverage)\s*(?:rehearsal|dry[- ]?run)|rehearsal|gate validation only|mechanism test/i;
function isDiagnosticAnalysis(c) {
  const d=c?.analysis_detail ?? {};
  const parts=[
    c?.note, d?.summary, d?.rationale?.conclusion,
    ...(d?.rationale?.why ?? []), ...(d?.rationale?.risks ?? [])
  ].filter(Boolean).map(String);
  return parts.some(x=>DIAGNOSTIC_ANALYSIS_RE.test(x));
}
function analysisItems(items) {
  if (!items?.length) return '<div class="sub">該当データなし</div>';
  return `<div class="analysis-lines">${items.map(x => `<div><strong>${esc(x.date ?? "日付不明")}</strong>｜${esc(x.label ?? x.opponent ?? "—")}｜${esc(x.result ?? "—")}${x.note ? `<div class="sub">${esc(x.note)}</div>` : ""}</div>`).join("")}</div>`;
}
function formBlock(side) {
  if (!side) return '<div class="sub">未取得</div>';
  return `<div class="analysis-side"><strong>${esc(side.label)}</strong><div>${esc(side.summary)}</div>${analysisItems(side.items)}</div>`;
}
function commonOpponentBlock(x) {
  if (!x) return '<div class="sub">未記録</div>';
  const summary=`<div>${esc(x.summary ?? "未記録")}</div>`;
  if (!x.items?.length) return summary + '<div class="sub">共通相手の比較明細なし</div>';
  const rows=x.items.map(r => `<tr>
    <td>${esc(r.opponent ?? "—")}</td>
    <td>${esc(r.side_a?.date ?? "日付不明")}｜${esc(r.side_a?.result ?? "—")}｜${esc(r.side_a?.performance ?? "—")}${r.side_a?.venue_context ? `<div class="sub">${esc(r.side_a.venue_context)}</div>` : ""}</td>
    <td>${esc(r.side_b?.date ?? "日付不明")}｜${esc(r.side_b?.result ?? "—")}｜${esc(r.side_b?.performance ?? "—")}${r.side_b?.venue_context ? `<div class="sub">${esc(r.side_b.venue_context)}</div>` : ""}</td>
    <td>${esc(r.comparison ?? "—")}</td>
  </tr>`).join("");
  return summary + `<div class="table-wrap"><table class="result-table"><thead><tr><th>共通相手</th><th>A側</th><th>B側</th><th>比較</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function statusText(x) {
  return x?.status === "checked" ? "確認済み" : x?.status === "not_applicable" ? "該当なし" : "取得できず";
}
function renderSystemAnalysis(a, title) {
  if (!a) return '<div class="analysis-panel"><div class="empty">この更新回の候補分析データはまだありません。</div></div>';

  const rawCandidates = a.candidates ?? [];
  const diagnosticCandidates = rawCandidates.filter(isDiagnosticAnalysis);
  const visibleCandidates = rawCandidates.filter(c => !isDiagnosticAnalysis(c));
  const genuineInsufficient = visibleCandidates.filter(c => c.outcome === "insufficient_data");
  const primaryCandidates = visibleCandidates.filter(c => c.outcome !== "insufficient_data");
  const coverage = a.sport_coverage ?? [];
  const coverageRows = coverage.map(x => `<tr>
    <td>${esc(x.category ?? x.category_key ?? "—")}</td>
    <td>${esc(x.event_count ?? 0)}</td>
    <td>${esc(x.priced_upcoming_count ?? 0)}</td>
    <td>${esc(x.screened ?? 0)}</td>
    <td>${esc(x.deep_dived ?? 0)}</td>
    <td>${esc(x.deep_candidate ?? 0)}/${esc(x.deep_watch ?? 0)}/${esc(x.deep_reject ?? 0)}/${esc(x.deep_insufficient ?? 0)}</td>
    <td>${esc(x.accepted ?? 0)}</td>
    <td>${esc(x.watch ?? 0)}</td>
    <td>${esc(x.rejected ?? 0)}</td>
  </tr>`).join("");
  const coverageHtml = coverage.length ? `<details class="analysis-coverage" open>
    <summary><strong>競技・タイトル別カバレッジ</strong>（全${esc(coverage.length)}カテゴリ）</summary>
    <div class="table-wrap"><table class="result-table analysis-coverage-table">
      <thead><tr><th>競技 / タイトル</th><th>全event</th><th>priced 24h</th><th>一次走査</th><th>deep</th><th>deep C/W/R/I</th><th>正式採用</th><th>正式監視</th><th>正式除外</th></tr></thead>
      <tbody>${coverageRows}</tbody>
    </table></div>
    <div class="sub">C=candidate / W=watch / R=reject / I=insufficient_data。正式列は今回のnew_picksをsource_event_idで元eventへ追跡して集計。</div>
  </details>` : '<div class="empty">競技別カバレッジ記録なし</div>';

  const rankById = new Map(primaryCandidates.map((c,i)=>[String(c.event_id), i+1]));
  const cardHtml = c => {
    const d=c.analysis_detail ?? {};
    const [olabel,ocls]=ANALYSIS_OUTCOME[c.outcome] ?? [c.outcome ?? "—",""];
    const matchup=[c.side_a,c.side_b].filter(Boolean).join(" vs ") || `event ${c.event_id}`;
    const odds=(c.odds??[]).filter(x=>x.name).map(x=>`${esc(x.name)} ${x.odds==null?"—":esc(x.odds)}`).join(" / ");
    const sources=(c.source_urls??[]).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener">出典${i+1}</a>`).join(" / ");
    return `<details class="analysis-card">
      <summary><span class="analysis-rank">#${esc(rankById.get(String(c.event_id)) ?? "—")}</span><span class="value-badge ${ocls}">${esc(olabel)}</span><span class="analysis-match">${esc(matchup)}</span><span class="analysis-time">${esc(jst(c.start_at_jst) ?? "時刻未確認")}</span></summary>
      <div class="analysis-card-body">
        <div class="sub">競技/タイトル：${esc(c.category ?? c.category_key ?? "—")}／event_id：${esc(c.event_id ?? "—")}</div>
        <div class="analysis-summary">${esc(d.summary ?? c.note ?? "分析要約なし")}</div>
        <div class="detail-grid">
          <div class="box"><h3>H2H｜${esc(statusText(d.h2h))}</h3><div>${esc(d.h2h?.summary ?? "未記録")}</div>${analysisItems(d.h2h?.items)}</div>
          <div class="box"><h3>直近成績｜${esc(statusText(d.recent_form))}</h3>${formBlock(d.recent_form?.side_a)}${formBlock(d.recent_form?.side_b)}</div>
          <div class="box"><h3>直近の共通対戦相手比較｜${esc(statusText(d.common_opponent_comparison))}</h3>${commonOpponentBlock(d.common_opponent_comparison)}</div>
          <div class="box"><h3>ランキング / レーティング</h3><div>${esc(d.ranking_or_rating?.text ?? "未記録")}</div><h3 class="analysis-subhead">H/A・会場</h3><div>${esc(d.home_away?.text ?? "未記録")}</div></div>
          <div class="box"><h3>当日メンバー・欠場</h3><div>${esc(d.availability?.text ?? "未記録")}</div><h3 class="analysis-subhead">競技固有データ</h3><div>${esc(d.sport_specific?.text ?? "未記録")}</div></div>
          <div class="box"><h3>市場・オッズ</h3><div>${esc((d.market?.text ?? odds) || "未記録")}</div>${odds ? `<div class="sub">BET CHANNEL: ${odds}</div>` : ""}</div>
          <div class="box"><h3>なぜこの判定か</h3><div class="sub">強い根拠</div><ul>${(d.rationale?.why??[]).map(x=>`<li>${esc(x)}</li>`).join("") || "<li>未記録</li>"}</ul><div class="sub">リスク</div><ul>${(d.rationale?.risks??[]).map(x=>`<li>${esc(x)}</li>`).join("") || "<li>特記事項なし</li>"}</ul><div><strong>結論：</strong>${esc(d.rationale?.conclusion ?? c.note ?? "—")}</div></div>
        </div>
        ${d.missing_information?.length ? `<div class="analysis-missing"><strong>不足情報：</strong>${esc(d.missing_information.join("、"))}</div>` : ""}
        <div class="analysis-sources">${sources}</div>
      </div>
    </details>`;
  };

  const grouped = new Map();
  for (const c of primaryCandidates) {
    const key=c.category ?? c.category_key ?? "未分類";
    if(!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(c);
  }
  const cards = [...grouped.entries()].sort(([a],[b])=>String(a).localeCompare(String(b),"ja")).map(([category,rows]) =>
    `<section class="analysis-sport-group"><h4 class="analysis-sport-title">${esc(category)} <span class="sub">有効deep_dive ${rows.length}件</span></h4>${rows.map(cardHtml).join("")}</section>`
  ).join("");
  const genuineInsufficientHtml = genuineInsufficient.length
    ? `<details class="analysis-coverage"><summary><strong>追加調査が必要</strong>（${esc(genuineInsufficient.length)}件）</summary><div class="sub">外部検索まで実施しても主要根拠を確認できなかったものだけをここに分離しています。正式候補には数えません。</div>${genuineInsufficient.map(cardHtml).join("")}</details>`
    : "";
  const diagnosticNotice = diagnosticCandidates.length
    ? `<div class="sub" style="margin:8px 0">診断・rehearsal由来の ${esc(diagnosticCandidates.length)}件は本番候補分析から除外しました。</div>`
    : "";

  return `<div class="analysis-panel"><div class="analysis-panel-head"><div><strong>${esc(title)}｜今から24時間以内の格差候補 完全分析</strong><div class="sub">更新 ${esc(jst(a.generated_at) ?? "—")}／全件走査 ${esc(a.cards_checked ?? 0)}件 → 有効深掘り ${esc(primaryCandidates.length)}件</div></div><div class="analysis-counts"><span>採用 ${esc(a.accepted ?? 0)}</span><span>監視 ${esc(a.watch ?? 0)}</span><span>除外 ${esc(a.rejected ?? 0)}</span></div></div>${diagnosticNotice}${coverageHtml}${cards || '<div class="empty">現在表示できる本番deep_diveはありません</div>'}${genuineInsufficientHtml}</div>`;
}

function renderInlineLatestAnalysis(c) {
  if (!c) return "";
  const d=c.analysis_detail ?? {};
  const [olabel,ocls]=ANALYSIS_OUTCOME[c.outcome] ?? [c.outcome ?? "—",""];
  const odds=(c.odds??[]).filter(x=>x.name).map(x=>`${esc(x.name)} ${x.odds==null?"—":esc(x.odds)}`).join(" / ");
  const sources=(c.source_urls??[]).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener">出典${i+1}</a>`).join(" / ");
  return `<div class="inline-latest-analysis">
    <div class="analysis-inline-title"><span class="value-badge ${ocls}">${esc(olabel)}</span> この定時更新で使った完全分析</div>
    <div class="analysis-summary">${esc(d.summary ?? c.note ?? "分析要約なし")}</div>
    <div class="detail-grid">
      <div class="box"><h3>H2H｜${esc(statusText(d.h2h))}</h3><div>${esc(d.h2h?.summary ?? "未記録")}</div>${analysisItems(d.h2h?.items)}</div>
      <div class="box"><h3>直近成績｜${esc(statusText(d.recent_form))}</h3>${formBlock(d.recent_form?.side_a)}${formBlock(d.recent_form?.side_b)}</div>
          <div class="box"><h3>直近の共通対戦相手比較｜${esc(statusText(d.common_opponent_comparison))}</h3>${commonOpponentBlock(d.common_opponent_comparison)}</div>
      <div class="box"><h3>ランキング / レーティング</h3><div>${esc(d.ranking_or_rating?.text ?? "未記録")}</div><h3 class="analysis-subhead">H/A・会場</h3><div>${esc(d.home_away?.text ?? "未記録")}</div></div>
      <div class="box"><h3>当日メンバー・欠場</h3><div>${esc(d.availability?.text ?? "未記録")}</div><h3 class="analysis-subhead">競技固有データ</h3><div>${esc(d.sport_specific?.text ?? "未記録")}</div></div>
      <div class="box"><h3>市場・オッズ</h3><div>${esc((d.market?.text ?? odds) || "未記録")}</div>${odds ? `<div class="sub">BET CHANNEL: ${odds}</div>` : ""}</div>
      <div class="box"><h3>分析根拠と結論</h3><div class="sub">根拠</div><ul>${(d.rationale?.why??[]).map(x=>`<li>${esc(x)}</li>`).join("") || "<li>未記録</li>"}</ul><div class="sub">リスク</div><ul>${(d.rationale?.risks??[]).map(x=>`<li>${esc(x)}</li>`).join("") || "<li>特記事項なし</li>"}</ul><div><strong>結論：</strong>${esc(d.rationale?.conclusion ?? c.note ?? "—")}</div></div>
    </div>
    ${d.missing_information?.length ? `<div class="analysis-missing"><strong>不足情報：</strong>${esc(d.missing_information.join("、"))}</div>` : ""}
    <div class="analysis-sources">${sources}</div>
  </div>`;
}

// ── ① 推奨取引 ──────────────────────────────────────────
function renderRecommendations(v, analysis) {
  const s = v.current_summary ?? v.summary, c = v.current_compound ?? v.compound, k = v.current_kelly ?? v.kelly, cal = v.calibration;
  const cards = [
    card("戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card(s.amountMissing ? "計算可能分の確定純損益" : "確定純損益（単利）", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}／金額未計算 ${s.amountMissing}件` }),
    card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
    card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}（オッズ既知 ${s.openProjectedCount}件）／オッズ未確定 ${s.openUncomputed}件は未計算` }),
    compoundCard(c, v.compound_audit),
    card("1/4ケリー", money(k.profit), { tone: toneOf(k.profit), note: `試合前に固定された事前確率だけで計算（賭け ${k.bets}件・見送り ${k.skipped}件）` }),
  ].join("");
  const renderRecRows = sourceRows => sourceRows.map(r => {
    const L = r.locked ?? {};
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td>${startCell(r)}</td><td class="sport-col">${esc(r.match?.sport ?? "—")}</td>`
      + `<td>${matchCell(r)}${badges(r.quality)}</td><td class="market-result">${esc(r.result_text)}</td><td>${oddsCell(r)}</td>${moneyCells(r)}`
      + `<td class="conf">${esc(L.confidence ?? "—")}${L.gap_score != null ? `<div class="sub">格差${esc(L.gap_score)}</div>` : ""}</td></tr>`;
    const detail = `<div class="detail-grid">${factsBlock(r)}${lockedBlock(r, [
      ["事前確率", L.prob != null ? pct(L.prob) : '<span class="muted">記録なし</span>'],
      ["信頼度", esc(L.confidence ?? "—")], ["格差スコア", L.gap_score != null ? `${esc(L.gap_score)}/100（勝率ではない）` : "—"],
    ])}</div>${renderInlineLatestAnalysis(r.latest_analysis)}${postMatchSlot(r)}${legacySlot(r)}`;
    return main + detailRow(r, 10, detail);
  }).join("");
  const rows = renderRecRows(v.current_rows ?? v.rows);
  const legacyRows = renderRecRows(v.legacy_rows ?? []);
  return `<section class="system system-separated system-rec" id="sec-rec"><div class="system-heading"><h2 class="section-title">① 推奨取引｜格差・高勝率ロジック</h2><span class="system-chip">①だけの独立分析</span></div>
    <p class="note">1件 $100。数値はすべて data/recommendations.json と matches.json から自動計算しています。重複確認中 ${v.duplicates.groups}組（${v.duplicates.rows}件）は統合・削除せず両方を表示し、集計にも両方を含めています。</p>
    <h3 class="panel-title">A. ①正式採用の戦績・収支</h3>
    ${summaryTable([
      ["戦績", record(s), `勝率 ${winRate(s)}`],
      [s.amountMissing ? "計算可能分の確定純損益" : "確定純損益（単利）", money(s.netProfit), `ROI ${roi(s)}／金額未計算 ${s.amountMissing}件`],
      ["確定済み投入額", amount(s.settledStake), `総投入予定額 ${amount(s.plannedStake)}`],
      ["未確定", `${s.pending}件`, `予想損益 ${money(s.openProjectedProfit)}／オッズ未確定 ${s.openUncomputed}件`],
      ["複利", c ? money(c.profit) : "—", c ? `現在資金 ${amount(c.balance)}／ストック ${amount(c.stock)}` : "確定データなし"],
      ["1/4ケリー", money(k.profit), `賭け ${k.bets}件・見送り ${k.skipped}件`],
    ])}
    <div class="calib">精度検証（試合前に固定された事前確率のみ）：${cal.count ? `${cal.count}件｜Brier ${cal.brier.toFixed(4)}｜Log Loss ${cal.log_loss.toFixed(4)}` : "対象0件"}</div>
    ${renderSystemAnalysis(analysis, "24時間以内の格差候補")}
    <h3 class="panel-title">B. ①正式採用・結果一覧</h3>
    <div class="table-wrap"><table><thead><tr><th>結果</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 状態</th><th>結果内容</th><th>オッズ</th><th class="money">投入額</th><th class="money">払戻し / 予定</th><th class="money">損益</th><th>信頼度</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${legacyRows ? `<details class="legacy-history"><summary><strong>過去の移行データ</strong>（${esc(v.legacy_rows?.length ?? 0)}件・現在の戦績/収支には含めない表示）</summary><div class="table-wrap"><table><thead><tr><th>結果</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 状態</th><th>結果内容</th><th>オッズ</th><th class="money">投入額</th><th class="money">払戻し / 予定</th><th class="money">損益</th><th>信頼度</th></tr></thead><tbody>${legacyRows}</tbody></table></div></details>` : ""}</section>`;
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
  return `<section class="system actual system-separated system-exp" id="sec-exp"><h2 class="section-title">経験値取引（実投入）</h2>
    <p class="note">推奨取引とは別管理。実際に投入した金額だけを集計します（分析系統ではありません）。</p>
    <div class="summary four">${cards}</div>
    <div class="table-wrap"><table><thead><tr><th>結果</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 状態</th><th>ベット内容</th><th>オッズ</th><th class="money">投入額</th><th class="money">払戻し / 予定</th><th class="money">損益</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ── ② VALUE① / ③ VALUE② ────────────────────────────────
const VERDICT = {
  formal: ["正式VALUE", "formal"], conditional: ["条件付きVALUE", "conditional"], watch: ["監視", "watch"], excluded: ["除外", "exclude"],
  adopted: ["VALUE②採用", "formal"],
};
const BUCKET_NOTE = { official: "正式採用・成績", reference: "監視候補（正式成績には含めない）", conditional_unmet: "集計外（条件成立未確認）", excluded: "集計外", unlocked: "集計外（未固定）" };

function officialCards(s, comp, extra = [], audit = null) {
  return [
    card("戦績", record(s), { note: `勝率 ${winRate(s)}` }),
    card(s.amountMissing ? "計算可能分の純損益（$100固定）" : "純損益（$100固定）", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}／金額未計算 ${s.amountMissing}件` }),
    card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
    card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}／オッズ未確定 ${s.openUncomputed}件は未計算` }),
    ...(comp ? [compoundCard(comp, audit)] : []),
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

function valueRowsTable(rows, second, emptyText) {
  const cols = second ? 14 : 13;
  if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
  const body = rows.map(r => {
    const L = r.locked ?? {};
    const [vlabel, vcls] = VERDICT[L.verdict] ?? [L.verdict ?? "—", ""];
    const mid = second
      ? `<td>${range(L.market_gap_lo, L.market_gap_hi, x => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}pt`))}</td><td>${esc({ low: "低", mid: "中", mid_high: "中〜高", high: "高" }[L.upset_risk] ?? "—")}</td>`
      : `<td>${range(L.ev_lo, L.ev_hi, signedPct)}</td>`;
    const moneyPart = r.bucket === "official" ? moneyCells(r)
      : `<td class="money muted">—</td><td class="money muted">—</td><td class="money muted">成績集計外</td>`;
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td><span class="value-badge ${vcls}">${esc(vlabel)}</span><div class="sub">${esc(BUCKET_NOTE[r.bucket])}</div></td>
      <td>${startCell(r)}</td><td>${esc(r.match?.sport ?? "—")}</td><td>${matchCell(r)}${badges(r.quality)}</td><td>${oddsCell(r)}</td>
      <td>${L.required_prob != null ? pct(L.required_prob) : esc(r.legacy?.raw?.required_prob_text ?? "—")}</td><td>${range(L.prob_lo, L.prob_hi)}</td>${mid}${moneyPart}<td>${r.closing_odds != null ? odds(r.closing_odds) : "—"}</td></tr>`;
    const cond = r.condition ? [["条件", esc(r.condition.text)], ["条件成立", r.condition.met === true ? "成立（試合前に確認）" : '<span class="warn-t">未確認（本成績に算入しない）</span>']] : [];
    const detail = `<div class="detail-grid">${factsBlock(r)}${lockedBlock(r, [
      ["判定", esc(vlabel)], ["必要勝率", L.required_prob != null ? pct(L.required_prob) : "—"], ["推定勝率", range(L.prob_lo, L.prob_hi)],
      ...(second ? [["市場差", range(L.market_gap_lo, L.market_gap_hi, x => (x == null ? "—" : `${x}pt`))]] : [["推定EV", range(L.ev_lo, L.ev_hi, signedPct)]]),
      ...cond,
    ])}</div>${renderInlineLatestAnalysis(r.latest_analysis)}${postMatchSlot(r)}${legacySlot(r)}`;
    return main + detailRow(r, cols, detail);
  }).join("");
  const head = second ? "<th>市場差</th><th>Upset Risk</th>" : "<th>推定EV</th>";
  return `<div class="table-wrap"><table data-cols="${cols}"><thead><tr><th>結果</th><th>判定</th><th>開始（JST）</th><th>種目</th><th>組み合わせ / 選択 / 状態</th><th>取得オッズ</th><th>必要勝率</th><th>推定勝率</th>${head}<th class="money">投入</th><th class="money">払戻し</th><th class="money">損益</th><th>Closing</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderValue(v, { id, title, note, second, analysis }) {
  const activeRows = v.current_rows ?? v.rows;
  const currentOfficial = v.current_official ?? v.official;
  const currentCompound = v.current_official_compound ?? v.official_compound;
  const closingCount = activeRows.filter(r => r.bucket === "official" && r.closing_odds != null).length;
  const officialRows=activeRows.filter(r=>r.bucket==="official");
  const watchRows=activeRows.filter(r=>r.bucket==="reference");
  const otherRows=activeRows.filter(r=>!["official","reference"].includes(r.bucket));
  const legacyRows=v.legacy_rows ?? [];
  return `<section class="system value system-separated ${id === "sec-v1" ? "system-v1" : "system-v2"}" id="${id}">
    <div class="system-heading"><h2 class="section-title">${esc(title)}</h2><span class="system-chip">独立ロジック</span></div>
    <p class="note">${esc(note)}</p>
    <h3 class="panel-title">A. このロジックだけの正式採用・成績</h3>
    ${summaryTable([
      ["戦績", record(currentOfficial), `勝率 ${winRate(currentOfficial)}`],
      ["純損益", money(currentOfficial.netProfit), `ROI ${roi(currentOfficial)}／金額未計算 ${currentOfficial.amountMissing}件`],
      ["確定済み投入額", amount(currentOfficial.settledStake), `総投入予定額 ${amount(currentOfficial.plannedStake)}`],
      ["未確定", `${currentOfficial.pending}件`, `予想損益 ${money(currentOfficial.openProjectedProfit)}／オッズ未確定 ${currentOfficial.openUncomputed}件`],
      ["複利", currentCompound ? money(currentCompound.profit) : "—", currentCompound ? `現在資金 ${amount(currentCompound.balance)}` : "確定データなし"],
      [second ? "CLV" : "1/4ケリー", second ? (closingCount ? `${closingCount}件取得` : "集計待ち") : "集計保留", second ? "Closing取得後に更新" : "推定勝率レンジは無理に点推定しない"],
    ])}
    <div class="analysis-link-note">完全deep-diveはページ上部「① 推奨取引」の24時間候補に一本化。ここではこのロジックの正式採用・監視・結果だけを表示します。</div>
    <h3 class="panel-title">B. このロジックの正式採用・結果一覧</h3>
    ${valueRowsTable(officialRows, second, "正式採用0件")}
    <h3 class="panel-title ref">C. このロジックの監視候補（正式成績には含めない）</h3>
    <div class="value-overview"><div class="value-mini">監視中<strong>${watchRows.length}件</strong><span class="sub">本成績・損益には混ぜません</span></div></div>
    ${valueRowsTable(watchRows, second, "監視候補0件")}
    ${otherRows.length ? `<h3 class="panel-title">D. このロジックの除外・条件未成立・データ不足</h3>${valueRowsTable(otherRows, second, "対象0件")}` : ""}
    ${legacyRows.length ? `<details class="legacy-history"><summary><strong>過去の移行データ</strong>（${esc(legacyRows.length)}件・現在の正式戦績/収支から分離表示）</summary>${valueRowsTable(legacyRows, second, "過去データなし")}</details>` : ""}
  </section>`;
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

function proEdgeRowsTable(rows, emptyText) {
  if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
  const body=rows.map(r => {
    const a = r.analysis, L = r.locked ?? {};
    const current = a.offered_odds != null ? odds(a.offered_odds) : "—";
    const dec = { official: "accepted", reference: "watch", excluded: "rejected", unlocked: "未固定" }[r.bucket];
    const moneyPart = r.bucket === "official" ? moneyCells(r) : '<td class="money muted">—</td><td class="money muted">—</td><td class="money muted">成績集計外</td>';
    const main = `<tr class="row" data-toggle="d-${esc(r.id)}">${resultCell(r)}<td><span class="value-badge ${r.bucket === "official" ? "formal" : r.bucket === "reference" ? "watch" : "exclude"}">${esc(dec)}</span></td>
      <td>${startCell(r)}</td><td>${esc(r.match?.sport ?? "—")}<div class="sub">${esc(r.match?.region ?? "地域 —")}</div></td><td>${matchCell(r)}${badges(r.quality)}</td>
      <td>${current}</td><td>${pct(a.market_probability)}</td><td>${pct(a.final_probability)}</td><td>${pt(a.edge)}</td><td>${signedPct(a.ev)}</td><td>${odds(a.minimum_entry_odds)}</td>${moneyPart}</tr>`;
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
      ${factsBlock(r)}</div>${renderInlineLatestAnalysis(r.latest_analysis)}`;
    return main + detailRow(r, 14, detail);
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>結果</th><th>判定</th><th>開始（JST）</th><th>競技 / 地域</th><th>組み合わせ / 市場 / 選択</th><th>現在オッズ</th><th>市場適正</th><th>RMC最終</th><th>EDGE</th><th>EV</th><th>最低購入</th><th class="money">投入</th><th class="money">払戻し</th><th class="money">損益</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderProEdge(v, { demo, analysis }) {
  const s = v.official;
  const accepted=v.rows.filter(r=>r.bucket==="official");
  const watch=v.rows.filter(r=>r.bucket==="reference");
  const rejected=v.rows.filter(r=>!["official","reference"].includes(r.bucket));
  return `<section class="system pro-edge system-separated system-pe" id="sec-pe">
    <div class="system-heading"><h2 class="section-title">④ PRO EDGE｜プロ型価格分析</h2><span class="system-chip">独立ロジック</span></div>
    ${demo ? '<div class="demo-banner">デモ表示：架空のサンプルデータです（実在の試合・実際のオッズではありません）</div>' : ""}
    <p class="lead">④専用ロジック。市場適正確率（no-vig）とRMC独自推定を比較し、①②③とは完全に別の候補探索・分析・判定を行います。</p>
    <h3 class="panel-title">A. ④だけの正式採用・成績</h3>
    <div class="summary four">${[
      card("戦績", record(s), { note: `Hit Rate ${winRate(s)}` }),
      card(s.amountMissing ? "計算可能分の純損益" : "純損益", money(s.netProfit), { tone: toneOf(s.netProfit), note: `ROI ${roi(s)}／金額未計算 ${s.amountMissing}件` }),
      card("確定済み投入額", amount(s.settledStake), { note: `総投入予定額 ${amount(s.plannedStake)}` }),
      card("未確定", `${s.pending}件`, { tone: "gold", note: `予想損益 ${money(s.openProjectedProfit)}` }),
    ].join("")}</div>
    <div class="eval">${evaluationPanel(v.evaluation.official, "pe-official")}</div>
    <div class="analysis-link-note">完全deep-diveはページ上部「① 推奨取引」の24時間候補に一本化。④では価格分析と正式採用・監視だけを表示します。</div>
    <h3 class="panel-title">B. ④正式採用・結果一覧</h3>
    ${proEdgeRowsTable(accepted, "accepted 0件")}
    <h3 class="panel-title ref">C. ④監視候補（正式成績には含めない）</h3>
    <div class="value-overview"><div class="value-mini">watch<strong>${watch.length}件</strong><span class="sub">正式成績・損益には混ぜません</span></div></div>
    ${proEdgeRowsTable(watch, "watch 0件")}
    ${rejected.length ? `<h3 class="panel-title">D. ④除外・データ不足・未固定</h3>${proEdgeRowsTable(rejected, "rejected 0件")}` : ""}
  </section>`;
}

// ── ページ全体 ─────────────────────────────────────────
export function renderPage(vm, { demo = false } = {}) {
  demo = demo && vm.meta.demo === true;
  const runs = vm.meta.update_runs.map(r => `${esc(r.run_id)}（${esc(r.kind)}・${esc(jst(r.at))}）`).join(" → ");
  return `<div class="data-status">データ時点：${esc(jst(vm.meta.as_of) ?? "—")}／状態：${esc(vm.meta.status ?? "—")}（${vm.meta.status === "active" ? "正式データ" : "移行用下書き"}）<div class="sub">試合事実の更新回：${runs}</div></div>
    <nav class="sys-nav"><a href="#sec-rec">① 推奨取引</a><a href="#sec-v1">② VALUE①</a><a href="#sec-v2">③ VALUE②</a><a href="#sec-pe">④ PRO EDGE</a><a href="#sec-exp">経験値取引</a></nav>
    ${renderRecommendations(vm.recommendations, vm.system_analysis?.systems?.recommendations ? { ...vm.system_analysis.systems.recommendations, generated_at: vm.system_analysis.meta?.generated_at } : null)}
    ${renderValue(vm.value1, { id: "sec-v1", title: "② VALUE①", note: "②VALUE①だけの独立分析。正式採用・監視・除外を別々に表示し、監視は本成績に混ぜません。", analysis: vm.system_analysis?.systems?.value1 ? { ...vm.system_analysis.systems.value1, generated_at: vm.system_analysis.meta?.generated_at } : null })}
    ${renderValue(vm.value2, { id: "sec-v2", title: "③ VALUE②", note: "③VALUE②だけの独立分析。②VALUE①とは候補探索・判定・成績を完全分離します。", second: true, analysis: vm.system_analysis?.systems?.value2 ? { ...vm.system_analysis.systems.value2, generated_at: vm.system_analysis.meta?.generated_at } : null })}
    ${renderUnassigned(vm.legacy_unassigned)}
    ${renderProEdge(vm.pro_edge, { demo, analysis: vm.system_analysis?.systems?.pro_edge ? { ...vm.system_analysis.systems.pro_edge, generated_at: vm.system_analysis.meta?.generated_at } : null })}
    ${renderExperience(vm.experience)}`;
}
