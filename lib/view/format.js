// V2 表示用の書式（計算はしない。表示の形だけ）。

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// 金額：+$19.00 / -$100.00 / $0.00（旧画面の「$-87.00」表記は採用しない）
export function money(v, { sign = true } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const abs = `$${Math.abs(v).toFixed(2)}`;
  if (!sign) return v < 0 ? `-${abs}` : abs;
  return v > 0 ? `+${abs}` : v < 0 ? `-${abs}` : abs;
}
export const amount = v => money(v, { sign: false });
export const pct = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${(v * 100).toFixed(d)}%`);
export const pctRaw = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(d)}%`);   // すでに ×100 済みの値
export const pt = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}pt`);
export const signedPct = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
export const odds = v => (v == null ? "—" : Number(v).toFixed(2));
export const range = (lo, hi, f = pct) => (lo == null && hi == null ? "—" : lo === hi ? f(lo) : `${f(lo)}〜${f(hi)}`);

// 日本時間の表示（例 2026/9/26 23:30 JST）
export function jst(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute} JST`;
}

export const RESULT_SYMBOL = { win: "○", loss: "×", pending: "△", push: "返", void: "無" };
