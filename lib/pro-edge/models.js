// ④ PRO EDGE：解釈しやすい初期モデル（Elo / Rating と ロジスティック回帰）。外部ライブラリなし・決定的。
// どちらも「予測時点より前に終わった試合」だけを使う（未来データを使わない）。

import { toMs } from "../time.js";

// ── Elo ────────────────────────────────────────────────
// history: [{ start_at, side_a, side_b, winner: "side_a"|"side_b" }]（side_a/side_b はチーム名）
// asOf より前に開始した試合だけを時刻順に使う。
export function eloRatings(history, asOf, { k = 20, initial = 1500 } = {}) {
  const cutoff = toMs(asOf);
  const ratings = new Map();
  const get = t => ratings.get(t) ?? initial;
  const used = history
    .filter(m => m.winner && toMs(m.start_at) < cutoff)
    .sort((a, b) => toMs(a.start_at) - toMs(b.start_at));
  for (const m of used) {
    const ra = get(m.side_a), rb = get(m.side_b);
    const ea = eloProbability(ra, rb);
    const sa = m.winner === "side_a" ? 1 : 0;
    ratings.set(m.side_a, ra + k * (sa - ea));
    ratings.set(m.side_b, rb + k * ((1 - sa) - (1 - ea)));
  }
  return { ratings, used: used.length, get };
}

export const eloProbability = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));

// ── ロジスティック回帰（バッチ勾配降下・L2） ───────────────────────
const sigmoid = z => 1 / (1 + Math.exp(-z));

// rows: [{ x: number[], y: 0|1 }]
export function fitLogistic(rows, { iterations = 2000, rate = 0.1, l2 = 0.01 } = {}) {
  if (!rows.length) throw new Error("学習データがない");
  const n = rows[0].x.length;
  let w = new Array(n).fill(0), b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array(n).fill(0);
    let gb = 0;
    for (const { x, y } of rows) {
      const err = sigmoid(b + x.reduce((s, v, i) => s + v * w[i], 0)) - y;
      for (let i = 0; i < n; i++) gw[i] += err * x[i];
      gb += err;
    }
    w = w.map((wi, i) => wi - rate * (gw[i] / rows.length + l2 * wi));
    b -= rate * (gb / rows.length);
  }
  return { weights: w, bias: b };
}

export const predictLogistic = (model, x) => sigmoid(model.bias + x.reduce((s, v, i) => s + v * model.weights[i], 0));
