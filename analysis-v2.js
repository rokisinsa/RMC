// RMC 分析情報 V2（新データ構造版）。本番 analysis.html / analysis.js とは独立。
// data/*.json だけを読み込み、lib/view の表示モデル・描画を呼ぶ（数値はすべてデータから自動計算）。
// 旧 analysis.html は参照しない（旧分析メモは data/legacy-analysis に移行済み）。

let buildViewModel, renderPage, resolveMode, assertNoDemoInProduction;

export const DATA_PATHS = {
  matches: "data/matches.json",
  match_updates: "data/match-updates.json",
  recommendations: "data/recommendations.json",
  experience: "data/experience.json",
  value1: "data/value1.json",
  value2: "data/value2.json",
  pro_edge: "data/pro_edge.json",
  system_analysis: "data/system-analysis.json",
  today_gap_analysis: "data/today-gap-analysis.json",
  complete_summary: "data/bet-channel-complete-summary.json",
  automation_runs: "data/automation-runs.json",
  scheduled_checklist: "data/scheduled-update-checklist.json",
  legacy_unassigned: "data/legacy-unassigned.json",
  legacy_analysis_recommendations: "data/legacy-analysis/recommendations.json",
  legacy_analysis_value1: "data/legacy-analysis/value1.json",
  legacy_analysis_value2: "data/legacy-analysis/value2.json",
  post_match_recommendations: "data/post-match-reviews/recommendations.json",
  post_match_experience: "data/post-match-reviews/experience.json",
  post_match_value1: "data/post-match-reviews/value1.json",
  post_match_value2: "data/post-match-reviews/value2.json",
  post_match_pro_edge: "data/post-match-reviews/pro_edge.json",
};

const OPTIONAL = new Set(["system_analysis", "today_gap_analysis", "complete_summary", "automation_runs", "scheduled_checklist", "post_match_recommendations", "post_match_experience", "post_match_value1", "post_match_value2", "post_match_pro_edge"]);

async function getJson(path, optional = false) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}cb=${Date.now()}`, { cache: "no-store" });
  if (optional && res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} を読み込めません（${res.status}）`);
  return res.json();
}

// ④のデモ（架空データ）。development でしか呼ばれない。本データには混ぜず、__demo 印を付ける
async function applyDemo(ds) {
  const { makeProEdgeSample } = await import("./tests/fixtures/pro-edge-sample.js");
  const sample = makeProEdgeSample();
  return {
    ...ds,
    __demo: true,
    matches: { ...ds.matches, update_runs: [...ds.matches.update_runs, ...sample.matches.update_runs], matches: [...ds.matches.matches, ...sample.matches.matches] },
    pro_edge: sample.pro_edge,
  };
}

const DISPLAY_RESET_CUTOFF = Date.parse("2026-09-29T00:00:00+09:00");
function displayPickAfterReset(pick, matchesById) {
  const m=matchesById.get(pick.match_id);
  const idDate=String(pick.match_id??"").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const raw=m?.start_at ?? (idDate ? idDate+"T00:00:00+09:00" : pick.locked_at ?? pick.discovered_at ?? null);
  const t=raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) && t>=DISPLAY_RESET_CUTOFF;
}
function applyProductionDisplayReset(ds) {
  const matchesById=new Map((ds.matches?.matches??[]).map(m=>[m.id,m]));
  const trim=data=>data ? {...data,picks:(data.picks??[]).filter(p=>displayPickAfterReset(p,matchesById))} : data;
  return {
    ...ds,
    recommendations:trim(ds.recommendations),
    experience:trim(ds.experience),
    value1:trim(ds.value1),
    value2:trim(ds.value2),
    pro_edge:trim(ds.pro_edge),
    legacy_unassigned:ds.legacy_unassigned ? {...ds.legacy_unassigned,excluded_log:[]} : ds.legacy_unassigned,
    matches:ds.matches ? {...ds.matches,meta:{...ds.matches.meta,as_of:ds.today_gap_analysis?.generated_at ?? ds.matches.meta?.as_of,note:"公開画面は2026-09-29以降を新基準として表示・収支集計"}} : ds.matches
  };
}

function safeText(v) {
  return String(v ?? "").replace(/[<>&]/g, "");
}

function normalizeGapTeamName(v) {
  return String(v ?? "").toLowerCase()
    .replace(/\b(fc|cf|women|woman|femenino|femenina|wfc|ladies)\b/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

function findRichGapCandidate(c, recommendationCandidates = []) {
  const parts=String(c.matchup ?? "").split(/\s+vs\s+/i);
  if(parts.length!==2) return null;
  const ca=normalizeGapTeamName(parts[0]), cb=normalizeGapTeamName(parts[1]);
  return recommendationCandidates.find(x=>{
    const xa=normalizeGapTeamName(x.side_a), xb=normalizeGapTeamName(x.side_b);
    return (xa===ca&&xb===cb)||(xa===cb&&xb===ca);
  }) ?? null;
}

function gapResultSummary(items = []) {
  let w=0,d=0,l=0,forScore=0,againstScore=0,scored=0;
  for(const x of items.slice(0,10)){
    const r=String(x.result ?? "");
    if(/\bW\b/.test(r)) w++;
    else if(/\bL\b/.test(r)) l++;
    else if(/\bD\b/.test(r)) d++;
    const m=r.match(/(\d+)\s*[-–]\s*(\d+)/);
    if(m){forScore+=Number(m[1]);againstScore+=Number(m[2]);scored++;}
  }
  const scoreText=scored ? `／スコア合計 ${forScore}-${againstScore}` : "";
  return `${items.slice(0,10).length}試合：${w}勝${d}分${l}敗${scoreText}`;
}

function gapRecentTable(recent) {
  if(!recent?.side_a&&!recent?.side_b) return "";
  const side = x => {
    if(!x) return '<div class="sub">未確認</div>';
    const items=(x.items??[]).slice(0,10);
    const rows=items.map(r=>`<tr><td>${safeText(r.date ?? "—")}</td><td>${safeText(r.label ?? r.opponent ?? "—")}</td><td><strong>${safeText(r.result ?? "—")}</strong></td></tr>`).join("");
    return `<div class="analysis-side"><strong>${safeText(x.label ?? "—")}</strong><div class="sub">${safeText(x.summary ?? "")}</div><div style="margin:5px 0;font-weight:800;color:#dff8ff">${safeText(gapResultSummary(items))}</div>${rows?`<div class="table-wrap"><table class="result-table" style="min-width:520px"><thead><tr><th>日付</th><th>対戦相手</th><th>スコア / 勝敗</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="sub">試合明細なし</div>'}</div>`;
  };
  return side(recent.side_a)+side(recent.side_b);
}

function gapH2HBlock(h2h, fallback) {
  if(!h2h?.items?.length) return `<div>${safeText(h2h?.summary ?? fallback ?? "未確認")}</div>`;
  const rows=h2h.items.map(x=>`<tr><td>${safeText(x.date ?? "—")}</td><td>${safeText(x.label ?? "—")}</td><td><strong>${safeText(x.result ?? "—")}</strong>${x.note?`<div class="sub">${safeText(x.note)}</div>`:""}</td></tr>`).join("");
  return `<div style="margin-bottom:7px">${safeText(h2h.summary ?? fallback ?? "")}</div><div class="table-wrap"><table class="result-table" style="min-width:520px"><thead><tr><th>日付</th><th>対戦</th><th>スコア</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function gapCommonOpponentBlock(common, fallback) {
  if(!common?.items?.length) return `<div>${safeText(common?.summary ?? fallback ?? "直近範囲で比較可能な共通相手なし")}</div>`;
  const rows=common.items.map(x=>`<tr>
    <td><strong>${safeText(x.opponent ?? "—")}</strong></td>
    <td>${safeText(x.side_a?.date ?? "—")}｜<strong>${safeText(x.side_a?.result ?? "—")}</strong>${x.side_a?.performance?`<div class="sub">得失点/SET/MAP: ${safeText(x.side_a.performance)}</div>`:""}</td>
    <td>${safeText(x.side_b?.date ?? "—")}｜<strong>${safeText(x.side_b?.result ?? "—")}</strong>${x.side_b?.performance?`<div class="sub">得失点/SET/MAP: ${safeText(x.side_b.performance)}</div>`:""}</td>
    <td>${safeText(x.comparison ?? "—")}</td>
  </tr>`).join("");
  return `<div style="margin-bottom:7px">${safeText(common.summary ?? fallback ?? "")}</div><div class="table-wrap"><table class="result-table" style="min-width:760px"><thead><tr><th>共通相手</th><th>A側のスコア・勝敗</th><th>B側のスコア・勝敗</th><th>比較</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderTodayGapAnalysis(a, recommendationCandidates = []) {
  if (!a?.candidates?.length) return "";
  const statusLabel = {
    candidate: "価格込み候補",
    watch: "監視",
    price_reject: "格差大・価格NG"
  };
  const statusTone = {
    candidate: "#69f0a5",
    watch: "#ffd45d",
    price_reject: "#ff8f9a"
  };
  const candidates = [...a.candidates].sort((x,y)=>(x.rank??999)-(y.rank??999));
  const topRows = candidates.map(c => {
    const o=c.odds ?? {};
    const detailId=`gap-detail-${safeText(c.rank)}`;
    const rich=findRichGapCandidate(c,recommendationCandidates);
    const d=c.analysis_detail ?? rich?.analysis_detail ?? {};
    const links=[...(rich?.source_urls??[]),...(c.sources??[])].filter((u,i,arr)=>u&&arr.indexOf(u)===i)
      .map((u,n)=>`<a href="${safeText(u)}" target="_blank" rel="noopener" style="color:#7edcff">出典${n+1}</a>`).join(" / ");
    const isSoccer=/サッカー|soccer|football/i.test(String(c.sport??"")+" "+String(c.competition??""));
    const analysisLabel=isSoccer?'<span class="badge ok">①推奨・サッカー詳細</span>':'<span class="badge info">完全分析</span>';
    const main=`<tr class="row gap-main-row" data-toggle="${detailId}" title="クリックで完全分析を開く">
      <td style="white-space:nowrap;font-weight:900">#${safeText(c.rank)}</td>
      <td><strong>${safeText(c.matchup)}</strong> <span class="chev">▼</span><div class="sub">${safeText(c.sport)}｜${safeText(c.competition)}</div></td>
      <td style="white-space:nowrap">${safeText(c.start_jst ? c.start_jst.replace("T"," ").slice(5,16) : "—")}</td>
      <td style="white-space:nowrap"><strong>${safeText(c.gap_grade ?? "—")}</strong></td>
      <td style="white-space:nowrap"><strong>${safeText(c.price_grade ?? "—")}</strong></td>
      <td style="white-space:nowrap">${safeText(o.min ?? "—")}〜${safeText(o.max ?? "—")}</td>
      <td style="white-space:nowrap">${safeText(c.estimated_win_probability_pct ?? "—")}${c.estimated_win_probability_pct == null ? "" : "%"}</td>
      <td style="color:${statusTone[c.status] ?? "#dff8ff"};font-weight:800">${safeText(statusLabel[c.status] ?? c.status ?? "—")}</td>
    </tr>`;
    const detail=`<tr class="detail-row gap-detail-row" id="${detailId}" hidden><td colspan="8" class="detail-cell">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px">${analysisLabel}<span class="badge info">H2H</span><span class="badge info">直近10</span><span class="badge info">共通相手比較</span></div>
      <div class="analysis-summary"><strong>${safeText(statusLabel[c.status] ?? c.status ?? "—")}</strong>｜${safeText(d.summary ?? c.conclusion ?? "")}</div>
      <div class="detail-grid">
        <div class="box"><h3>大会・条件</h3><div>${safeText(c.sport)}｜${safeText(c.competition)}</div><div class="sub">${safeText(c.venue ?? "会場未確認")}｜${safeText(c.format ?? "形式未確認")}</div></div>
        <div class="box"><h3>市場・価格</h3><div>オッズ ${safeText(o.min ?? "—")}〜${safeText(o.max ?? "—")}</div><div>必要勝率 ${safeText(o.required_win_rate_pct ?? "—")}${typeof o.required_win_rate_pct === "string" && /\d/.test(o.required_win_rate_pct) ? "%" : ""}</div><div>推定勝率 ${safeText(c.estimated_win_probability_pct ?? "—")}${c.estimated_win_probability_pct == null ? "" : "%"}</div><div>推定EV ${safeText(c.estimated_ev_pct ?? "—")}</div><div class="sub">${safeText(o.book_examples ?? "")}</div></div>
        <div class="box"><h3>ランキング / Rating</h3><div>${safeText(d.ranking_or_rating?.text ?? c.ranking_rating ?? "未確認")}</div></div>
        <div class="box"><h3>H/A・会場</h3><div>${safeText(d.home_away?.text ?? c.venue ?? "未確認")}</div></div>
      </div>
      <div class="box" style="margin-top:10px"><h3>H2H（確認できる限り）</h3>${gapH2HBlock(d.h2h,c.h2h)}</div>
      <div class="box" style="margin-top:10px"><h3>直近10試合｜勝敗・スコア・得失点/SET/MAP</h3>${d.recent_form?gapRecentTable(d.recent_form):`<div>${safeText(c.recent_form ?? "未確認")}</div>`}</div>
      <div class="box" style="margin-top:10px"><h3>直近の共通対戦相手比較｜スコア・勝敗・SET/MAP差</h3>${gapCommonOpponentBlock(d.common_opponent_comparison,c.common_opponents)}</div>
      <div class="detail-grid" style="margin-top:10px">
        <div class="box"><h3>メンバー / 欠場 / roster</h3><div>${safeText(d.availability?.text ?? c.roster ?? "未確認")}</div></div>
        <div class="box"><h3>序盤傾向 / Veto / 競技固有</h3><div>${safeText(d.sport_specific?.text ?? c.early_tendency ?? "未確認")}</div></div>
      </div>
      <div style="margin-top:10px;padding:9px 10px;border-left:3px solid #ffb36b;background:rgba(255,179,107,.07);font-size:11px;line-height:1.65"><strong>リスク：</strong>${safeText(c.risk ?? (d.rationale?.risks??[]).join("／") ?? "特記事項なし")}</div>
      <div class="analysis-sources" style="margin-top:9px">${links}</div>
    </td></tr>`;
    return main+detail;
  }).join("");

  const pure=(a.summary?.pure_gap_top ?? []).map(x=>safeText(x)).join(" ／ ");
  const value=(a.summary?.price_adjusted_top ?? []).map(x=>safeText(x)).join(" ／ ");
  return `<section class="analysis-panel" style="border:2px solid rgba(105,240,165,.42);margin-top:10px">
    <div class="analysis-panel-head" style="background:linear-gradient(90deg,rgba(63,203,255,.12),rgba(105,240,165,.09))">
      <div><strong style="font-size:17px">🔥 ${safeText(a.title ?? "本日の分析")}</strong>
      <div class="sub">更新 ${safeText(a.generated_at ?? "—")}｜対象 ${safeText(a.window?.from ?? "—")} ～ ${safeText(a.window?.to ?? "—")}</div></div>
      <div class="analysis-counts"><span>候補 ${safeText(candidates.length)}件</span><span>リアル＋eSports</span></div>
    </div>
    <div style="padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.07)">
      <div style="font-size:11px;line-height:1.7"><strong>純粋な実力格差：</strong>${pure || "—"}</div>
      <div style="font-size:11px;line-height:1.7"><strong>価格込み注目：</strong>${value || "—"}</div>
      <div class="sub">${safeText(a.summary?.caution ?? "")}</div>
    </div>
    <div class="sub" style="padding:10px 12px 0"><strong>組み合わせをクリック</strong>すると、その行の直下にH2H・直近10試合・共通対戦相手比較を展開します。下に同じ1〜11をもう一度表示しません。</div>
    <div class="table-wrap" style="margin:10px 12px"><table class="result-table">
      <thead><tr><th>#</th><th>カード / 大会</th><th>開始</th><th>格差</th><th>価格</th><th>オッズ</th><th>推定勝率</th><th>判定</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table></div>
  </section>`;
}


function renderArchivedGapDetail(c) {
  if (!c.analysis_reviewed_at || !c.analysis_detail) return "";
  const d=c.analysis_detail;
  const links=[...new Set([...(c.sources??[]),...(c.result_sources??[])])]
    .filter(url=>/^https?:\/\//i.test(url))
    .map((url,i)=>`<a href="${safeText(url)}" target="_blank" rel="noopener noreferrer">出典${i+1}</a>`).join(" ／ ");
  return `<details style="margin-top:8px"><summary>詳細分析・確定結果を開く</summary>
    <div class="sub">履歴追記：${safeText(c.analysis_reviewed_at)}</div>
    <p>${safeText(d.summary)}</p>
    <h4>試合前の大会成績</h4><p>${safeText(d.season_flow?.text??c.ranking_rating)}</p>
    <h4>試合前H2H</h4>${gapH2HBlock(d.h2h,c.h2h)}
    <h4>試合前の直近成績（確認できた範囲）</h4>${gapRecentTable(d.recent_form)}
    <h4>共通対戦相手</h4>${gapCommonOpponentBlock(d.common_opponent_comparison,c.common_opponents)}
    <h4>メンバー・競技固有の条件</h4><p>${safeText(d.availability?.text??c.roster)}</p><p>${safeText(d.sport_specific?.text??c.early_tendency)}</p>
    <h4>不確実性・価格</h4><p>${safeText(c.risk)}</p><p>${safeText(c.estimated_ev_pct)}。購入オッズ未登録のため利益額未計算。</p>
    <h4>事後の確定結果</h4><p>${safeText(d.post_match?.text??c.result)}</p>
    <div class="analysis-sources">${links}</div>
  </details>`;
}

function renderPreviousGapAnalysis(prev) {
  if (!prev?.candidates?.length) return "";
  const rows = [...prev.candidates]
    .sort((a,b)=>(a.rank??999)-(b.rank??999))
    .map(c=>{
      const mark=c.favored_result==="win"?"○":c.favored_result==="loss"?"×":"△";
      const tone=c.favored_result==="win"?"#69f0a5":c.favored_result==="loss"?"#ff7b87":"#ffd45d";
      return `<tr>
        <td style="white-space:nowrap;font-weight:900">#${safeText(c.rank ?? "—")}</td>
        <td><strong>${safeText(c.matchup ?? "—")}</strong><div class="sub">${safeText(c.sport ?? "—")}｜${safeText(c.competition ?? "—")}</div></td>
        <td style="white-space:nowrap">${safeText(c.start_jst ? c.start_jst.replace("T"," ").slice(5,16) : "—")}</td>
        <td style="white-space:nowrap">${safeText(c.gap_grade ?? "—")}</td>
        <td style="white-space:nowrap;color:${tone};font-weight:900;font-size:18px">${mark}</td>
        <td><strong>${safeText(c.result ?? "未確定")}</strong><div class="sub">事前優勢: ${safeText(c.favored ?? "—")}</div></td>
        <td>${safeText(c.conclusion ?? c.risk ?? "—")}${renderArchivedGapDetail(c)}</td>
      </tr>`;
    }).join("");
  const rs=prev.result_summary;
  return `<details style="margin:14px 0 18px;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:8px 10px">
    <summary style="cursor:pointer;font-size:12px;font-weight:800;color:#9fc9da">分析履歴・結果（${prev.candidates.length}件）</summary>
    <div class="sub" style="margin:8px 2px">前回分析を結果付きで保存。事前優勢側：${safeText(rs?.favored_wins ?? "—")}勝 ${safeText(rs?.favored_losses ?? "—")}敗 ／ 未確定 ${safeText(rs?.pending ?? "—")}件。実投入記録のない分析候補は収支には算入しません。</div>
    <div class="table-wrap"><table class="result-table">
      <thead><tr><th>#</th><th>カード / 大会</th><th>開始</th><th>格差</th><th>判定</th><th>結果</th><th>当時の判断</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

function currentAnalysisBanner(ds) {
  const m = ds.system_analysis?.meta;
  if (!m) return "";
  const ws = m.window_start ? safeText(m.window_start.replace("T"," ").replace("+09:00"," JST")) : "—";
  const we = m.window_end ? safeText(m.window_end.replace("T"," ").replace("+09:00"," JST")) : "—";
  const systems = ds.system_analysis?.systems ?? {};
  const rec = systems.recommendations ?? {};
  const valid = (rec.candidates ?? []).filter(c => !/rehearsal|dry[- ]?run|gate validation|mechanism test/i.test(String(c.note ?? "") + " " + String(c.analysis_detail?.summary ?? "")));
  return `<div class="data-status" style="border:2px solid #69f0a5;padding:12px;margin:10px 0;background:rgba(105,240,165,.06)">
    <div style="font-weight:900;color:#9ff7c0">🔎 最新24時間・格差候補分析：${safeText(m.run_id ?? "—")}</div>
    <div class="sub">対象：${ws} → ${we} ／ 更新：${safeText(m.generated_at ?? "—")} ／ 新規deep候補 ${safeText(valid.length)}件</div>
    <div class="sub">H2H・直近成績・共通相手・ランキング/Rating・H/A・欠場・序盤傾向・市場価格を候補ごとに表示。実力格差と価格評価は別判定。</div>
  </div>`;
}

function completeUpdateBanner(ds) {
  const checklist = ds.scheduled_checklist;
  const latestId = checklist?.latest_run_id ?? null;
  const latestRun = checklist?.runs?.find(r => r.run_id === latestId) ?? checklist?.runs?.at?.(-1) ?? null;
  const c = ds.complete_summary;
  const latestAnalysis = ds.system_analysis?.meta?.generated_at ?? null;
  const publishedRuns = (ds.automation_runs?.runs ?? []).filter(r => r.pages_result === "published");
  const publishedIds = new Set(publishedRuns.map(r => r.run_id));
  const isCompletePass = r => r?.status === "passed" && r?.summary?.pass === 41 && r?.summary?.fail === 0 && r?.summary?.blocked === 0 && r?.summary?.pending === 0;
  const passedRuns = (checklist?.runs ?? []).filter(r => isCompletePass(r) && (publishedIds.size === 0 || publishedIds.has(r.run_id)));
  const run = passedRuns.at(-1) ?? latestRun;
  const latestAttempt = latestRun && run && latestRun.run_id !== run.run_id ? latestRun : null;
  const lastPublished = publishedRuns.at(-1) ?? null;

  if (run) {
    const icon = x => x === "pass" ? "✅" : x === "fail" ? "❌" : x === "blocked" ? "⏸" : "…";
    const rows = (run.checks ?? []).map(x => `<tr>
      <td style="white-space:nowrap">${safeText(x.id)}</td>
      <td style="white-space:nowrap">${icon(x.status)} ${safeText(x.status)}</td>
      <td>${safeText(x.title)}</td>
      <td>${safeText(x.detail ?? "—")}</td>
    </tr>`).join("");
    const s = run.summary ?? { pass:0, fail:0, blocked:0, pending:0, total:41 };
    const ok = run.status === "passed" && s.pass === 41 && s.fail === 0 && s.blocked === 0 && s.pending === 0;
    const cls = ok ? "data-status" : "load-error";
    const border = ok ? "#2a8" : "#d33";
    const headline = ok
      ? `✅ RMC完全定時更新：41/41 PASS（${safeText(run.run_id)}）`
      : `❌ RMC完全定時更新：未完了（${safeText(run.run_id)}）`;
    const warning = ok ? "" : '<div style="font-weight:700">新規判断に使用禁止。未実行をPASS扱いしません。</div>';
    const inventoryLine = c
      ? `<div class="sub">完全母集団：${safeText(c.complete === true ? "complete" : "incomplete")} ／ 全event ${safeText(c.event_count ?? 0)} ／ screening ${safeText(c.screening_event_count ?? 0)} ／ blockers ${safeText((c.self_audit?.blockers ?? []).join(", ") || "なし")}</div>`
      : '<div class="sub">完全母集団JSON：未取得</div>';
    return `<div class="${cls}" style="border:2px solid ${border};padding:12px;margin:10px 0">
      <div style="font-weight:800">${headline}</div>
      ${warning}
      <div class="sub">予定：${safeText(run.scheduled_for ?? "—")} ／ slot ${safeText(run.slot ?? "—")} ／ 状態 ${safeText(run.status ?? "—")}</div>
      ${latestAttempt ? `<div class="sub">最新試行 ${safeText(latestAttempt.run_id)} は未完了のため、最後に公開成功した完全更新を表示中。</div>` : ""}
      <div class="sub">✅ ${safeText(s.pass)} ／ ❌ ${safeText(s.fail)} ／ ⏸ ${safeText(s.blocked)} ／ … ${safeText(s.pending)} ／ 合計 ${safeText(s.total ?? 41)}</div>
      ${inventoryLine}
      <div class="sub">最終分析：${safeText(latestAnalysis ?? "未記録")} ／ 最終公開成功run：${safeText(lastPublished?.run_id ?? "未記録")}</div>
      <details style="margin-top:8px" ${ok ? "" : "open"}>
        <summary><strong>定時更新41項目の監査結果を表示</strong></summary>
        <div class="table-wrap"><table class="result-table"><thead><tr><th>#</th><th>判定</th><th>チェック項目</th><th>根拠</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>
    </div>`;
  }

  if (!c) return '<div class="load-error">⚠ 完全版取得状態・41項目監査状態を確認できません。</div>';
  const blockers = c.self_audit?.blockers ?? [];
  const fixed = c.component_status?.fixed_odds ?? {};
  if (c.complete !== true || c.analysis_ready !== true || c.menu_end_verified !== true || (c.self_audit?.unresolved_blockers ?? 1) !== 0) {
    return `<div class="load-error" style="border:2px solid #d33;padding:12px;margin:10px 0;font-weight:700">
      ⚠ RMC完全定時更新：41項目監査記録なし／完全母集団未完了
      <div class="sub" style="font-weight:400">blockers：${safeText(blockers.join(", ") || "不明")} ／ 通常：${safeText(c.component_status?.legacy?.screening_event_count ?? 0)}件 ／ eSports：${safeText(fixed.screening_event_count ?? 0)}件</div>
    </div>`;
  }
  return '<div class="load-error">⚠ 完全母集団はありますが、41項目の定時監査記録がありません。完全更新扱いにしません。</div>';
}

function wire(root) {
  root.addEventListener("click", e => {
    const tab = e.target.closest(".win-tab");
    if (tab) {
      const g = tab.dataset.windowGroup;
      root.querySelectorAll(`.win-tab[data-window-group="${g}"]`).forEach(b => b.classList.toggle("active", b === tab));
      root.querySelectorAll(`.win-panel[data-window-group="${g}"]`).forEach(p => { p.hidden = p.dataset.windowPanel !== tab.dataset.window; });
      return;
    }
    const row = e.target.closest("tr.row");
    if (!row) return;
    const detail = document.getElementById(row.dataset.toggle);
    if (!detail) return;
    detail.hidden = !detail.hidden;
    row.classList.toggle("opened", !detail.hidden);
  });
}


function attachFormalRecommendationAnalysis(vm, today) {
  const all=[...(today?.previous_analysis?.candidates??[]),...(today?.candidates??[])];
  const norm=v=>String(v??"").toLowerCase().replace(/[‐‑–—]/g,"-").replace(/\s+/g," ").trim();
  const byCard=new Map();
  for(const c of all){
    const d=c.analysis_detail??{};
    byCard.set(norm(c.matchup),{
      h2h:d.h2h??{summary:c.h2h??"未確認／データ不足",items:[]},
      recent_form:d.recent_form??{summary:c.recent_form??"未確認／データ不足"},
      common_opponent_comparison:d.common_opponent_comparison??{summary:c.common_opponents??"確認範囲で共通相手0件／未確認",items:[]},
      captured_at:(today?.previous_analysis?.candidates??[]).includes(c)?today?.previous_analysis?.generated_at:today?.generated_at
    });
  }
  const seen=new Set();
  for(const group of [vm?.recommendations?.rows??[],vm?.recommendations?.current_rows??[],vm?.recommendations?.legacy_rows??[]]){
    for(const r of group){
      if(seen.has(r)) continue; seen.add(r);
      const key=norm(r.match?.card);
      r.analysis_snapshot=byCard.get(key)??{
        h2h:{summary:"未確認／データ不足",items:[]},
        recent_form:{summary:"未確認／データ不足"},
        common_opponent_comparison:{summary:"確認範囲で共通相手0件／未確認",items:[]}
      };
    }
  }
  return vm;
}

async function main() {
  const cb = Date.now();
  const [modelMod, renderMod, modeMod] = await Promise.all([
    import(`./lib/view/model.js?cb=${cb}`),
    import(`./lib/view/render.js?cb=${cb}`),
    import(`./lib/view/mode.js?cb=${cb}`)
  ]);
  buildViewModel = modelMod.buildViewModel;
  renderPage = renderMod.renderPage;
  resolveMode = modeMod.resolveMode;
  assertNoDemoInProduction = modeMod.assertNoDemoInProduction;
  const root = document.getElementById("app");
  const mode = resolveMode(location.href);
  document.documentElement.dataset.mode = mode.mode;
  try {
    const entries = await Promise.all(Object.entries(DATA_PATHS).map(async ([k, p]) => [k, await getJson(p, OPTIONAL.has(k))]));
    let ds = Object.fromEntries(entries.filter(([, v]) => v != null));
    const cfg = await getJson("config/pro-edge.config.json");
    if (mode.demo) ds = await applyDemo(ds);                 // development のときだけ
    if (!mode.demo) ds = applyProductionDisplayReset(ds);     // 公開画面は9/29以降だけを表示・収支集計
    assertNoDemoInProduction(mode, ds);
    const vm = attachFormalRecommendationAnalysis(buildViewModel(ds, { proEdgeConfig: cfg }), ds.today_gap_analysis);
    root.innerHTML = (mode.mode === "development" ? '<div class="dev-banner">development モード（ローカル確認環境）</div>' : "")
      + renderTodayGapAnalysis(ds.today_gap_analysis, ds.system_analysis?.systems?.recommendations?.candidates ?? [])
      + renderPreviousGapAnalysis(ds.today_gap_analysis?.previous_analysis)
      + (mode.mode === "development"
          ? '<details style="margin:10px 0 18px;border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:8px 10px"><summary style="cursor:pointer;font-size:12px;font-weight:800;color:#9fc9da">自動更新・41項目監査の状態（オーナー確認用）</summary>'
            + completeUpdateBanner(ds)
            + '</details>'
          : '')
      + '<div style="margin:18px 2px 8px;font-size:12px;color:#8fa8b5">以下は既存の①推奨・②VALUE①・③VALUE②・④PRO EDGEの取引履歴／収支。上の「本日の分析」が今回の最新分析です。</div>'
      + renderPage(vm, { demo: mode.demo });
    wire(root);
    window.__rmcV2 = vm;   // 確認用
  } catch (err) {
    root.innerHTML = `<div class="load-error">データを読み込めませんでした：${String(err.message).replace(/[<>&]/g, "")}</div>`;
    console.error(err);
  }
}

main();
