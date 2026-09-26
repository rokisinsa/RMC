// ④ PRO EDGE：時系列分割と未来データリーク検査。ランダムシャッフルは使わない。
//
//   学習期間（start < train_end）→ 検証期間（train_end ≤ start < validation_end）→ テスト期間（validation_end ≤ start）
//   入力の並び順に関係なく、必ず試合開始時刻で並べてから分ける。

import { toMs } from "../time.js";

export function timeSeriesSplit(records, { train_end, validation_end, timeKey = "start_at" }) {
  const t1 = toMs(train_end), t2 = toMs(validation_end);
  if (!(t1 < t2)) throw new Error("train_end < validation_end である必要があります");
  const sorted = [...records].sort((a, b) => toMs(a[timeKey]) - toMs(b[timeKey]));
  const split = { train: [], validation: [], test: [] };
  for (const r of sorted) {
    const t = toMs(r[timeKey]);
    (t < t1 ? split.train : t < t2 ? split.validation : split.test).push(r);
  }
  return split;
}

// 分割の時間順が崩れていないか（各期間の最後 < 次の期間の最初）
export function assertChronological(split, timeKey = "start_at") {
  const last = arr => (arr.length ? Math.max(...arr.map(r => toMs(r[timeKey]))) : -Infinity);
  const first = arr => (arr.length ? Math.min(...arr.map(r => toMs(r[timeKey]))) : Infinity);
  const ok = last(split.train) < first(split.validation) && last(split.validation) < first(split.test)
    && last(split.train) < first(split.test);
  if (!ok) throw new Error("時系列分割の順序が崩れている（未来のデータが学習側に入っている）");
  return true;
}

// 予測1件に使った情報が、予測時点（locked_at）かつ試合開始より前に得られていたか
// pick: { locked_at, locked: { features, expert_adjustments, model } }, startAt: 試合開始（null なら開始側の検査は省略）
export function leakageIssues(pick, startAt) {
  const out = [];
  const lock = pick.locked_at ? toMs(pick.locked_at) : null;
  const start = startAt ? toMs(startAt) : null;
  const check = (label, at) => {
    if (at == null) return;
    const t = toMs(at);
    if (lock != null && t > lock) out.push(`${label} の取得時刻 ${at} が locked_at より後`);
    if (start != null && t >= start) out.push(`${label} の取得時刻 ${at} が試合開始以降`);
  };
  for (const f of pick.locked?.features ?? []) check(`特徴量 ${f.name}`, f.observed_at);
  for (const a of pick.locked?.expert_adjustments ?? []) check(`Expert補正「${a.reason}」`, a.created_at);
  check("モデルの学習データ終端", pick.locked?.model?.trained_through);
  return out;
}
