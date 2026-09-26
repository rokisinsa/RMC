// ④ PRO EDGE：評価指標（勝敗だけで評価しない）。
//
// 母集団：本成績 = decision:"accepted" / 参考成績 = "watch"（$100仮定） / rejected は集計しない
// 期間：直近20・直近50・直近100・全期間（試合開始順。確定した win/loss のみ）
// サンプル不足のとき値は出さず（null）、sample_size と status:"insufficient_sample" を返す。
//
//   ROI         = 確定純損益 ÷ 確定投入額 × 100（push/void は除外）
//   Hit Rate    = 勝ち ÷ (勝ち＋負け)
//   Average EV  = 判断時EV（提示価格）の平均 / 購入時EV（bet_odds）の平均
//   Average/Median CLV = 価格ベース・確率ベースそれぞれ（締切オッズがあるカードだけ。clv_sample_size を別に返す）
//   Brier       = mean((final_probability − y)²)
//   Log Loss    = −mean(y·ln p + (1−y)·ln(1−p))
//   Calibration = final_probability の帯ごとの予測平均と実際の的中率（件数が少ない帯は値を出さない）

import { summarize } from "../summary.js";

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const clamp = p => Math.min(Math.max(p, 1e-6), 1 - 1e-6);
const byTime = (a, b) => Date.parse(a.settlement.orderKey) - Date.parse(b.settlement.orderKey);

// items: [{ settlement, analysis }]（settlement は settlePick の結果、analysis は analyzePick の結果）
export function metrics(items) {
  const settled = items.filter(i => i.settlement.state === "win" || i.settlement.state === "loss");
  const s = summarize(items.map(i => i.settlement));
  const withP = settled.filter(i => i.analysis.final_probability != null);
  const y = i => (i.settlement.state === "win" ? 1 : 0);
  const clvPrice = settled.map(i => i.analysis.clv.clv_price).filter(v => v != null);
  const clvProb = settled.map(i => i.analysis.clv.clv_probability).filter(v => v != null);
  return {
    sample_size: settled.length,
    wins: s.wins, losses: s.losses,
    roi: s.roi,
    hit_rate: s.winRate,
    net_profit: s.netProfit,
    settled_stake: s.settledStake,
    average_ev_decision: mean(settled.map(i => i.analysis.ev).filter(v => v != null)),
    average_ev_bet: mean(settled.map(i => i.analysis.ev_at_bet).filter(v => v != null)),
    clv_sample_size: clvPrice.length,
    average_clv_price: mean(clvPrice), median_clv_price: median(clvPrice),
    clv_probability_sample_size: clvProb.length,
    average_clv_probability: mean(clvProb), median_clv_probability: median(clvProb),
    brier: withP.length ? mean(withP.map(i => (i.analysis.final_probability - y(i)) ** 2)) : null,
    log_loss: withP.length ? mean(withP.map(i => {
      const p = clamp(i.analysis.final_probability);
      return -(y(i) * Math.log(p) + (1 - y(i)) * Math.log(1 - p));
    })) : null,
  };
}

export function calibration(items, { bins = 10, min_total = 100, min_per_bin = 10 } = {}) {
  const settled = items.filter(i => (i.settlement.state === "win" || i.settlement.state === "loss") && i.analysis.final_probability != null);
  const buckets = Array.from({ length: bins }, (_, k) => ({ from: k / bins, to: (k + 1) / bins, count: 0, sumP: 0, wins: 0 }));
  for (const i of settled) {
    const k = Math.min(Math.floor(i.analysis.final_probability * bins), bins - 1);
    buckets[k].count++;
    buckets[k].sumP += i.analysis.final_probability;
    if (i.settlement.state === "win") buckets[k].wins++;
  }
  const enough = settled.length >= min_total;
  return {
    sample_size: settled.length,
    status: enough ? "ok" : "insufficient_sample",
    min_total,
    bins: buckets.map(b => {
      const ok = enough && b.count >= min_per_bin;
      return {
        from: b.from, to: b.to, count: b.count,
        status: ok ? "ok" : "insufficient_sample",
        mean_predicted: ok ? b.sumP / b.count : null,
        observed_rate: ok ? b.wins / b.count : null,
      };
    }),
  };
}

// 直近N件・全期間。N件に満たない期間は値を出さない。
export function windowedMetrics(items, cfg = {}) {
  const windows = cfg.evaluation?.windows ?? [20, 50, 100, "all"];
  const minAll = cfg.evaluation?.min_sample_all ?? 20;
  const settled = items.filter(i => i.settlement.state === "win" || i.settlement.state === "loss").sort(byTime);
  const out = {};
  for (const w of windows) {
    const key = w === "all" ? "all" : `last_${w}`;
    const need = w === "all" ? minAll : w;
    const subset = w === "all" ? settled : settled.slice(-w);
    out[key] = settled.length < need
      ? { status: "insufficient_sample", sample_size: settled.length, required_sample: need }
      : { status: "ok", ...metrics(subset) };
  }
  out.calibration = calibration(settled, cfg.evaluation?.calibration);
  return out;
}
