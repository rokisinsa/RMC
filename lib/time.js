// タイムゾーン付き ISO 8601 の検証と比較。
// RMC では日時はすべてオフセット必須（Z または ±hh:mm）。オフセットなしは端末の地域設定で意味が変わるため不可。

const ISO_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isIsoWithOffset(value) {
  if (typeof value !== "string") return false;
  const m = ISO_OFFSET_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s = "00", , , oh, om] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (oh !== undefined && (Number(oh) > 14 || Number(om) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

export function toMs(value) {
  if (!isIsoWithOffset(value)) throw new Error(`タイムゾーン付きISO 8601ではありません: ${value}`);
  return Date.parse(value);
}

// a <= b（どちらかが null なら判定しない＝true）
export function notAfter(a, b) {
  if (a == null || b == null) return true;
  return toMs(a) <= toMs(b);
}
