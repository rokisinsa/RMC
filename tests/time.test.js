import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsoWithOffset, toMs, notAfter } from "../lib/time.js";

test("タイムゾーン付きISO 8601だけを受け付ける", () => {
  for (const ok of [
    "2026-09-26T21:00:00+09:00",
    "2026-09-26T12:00:00Z",
    "2026-09-26T21:00+09:00",
    "2026-09-26T21:00:00.123-03:00",
    "2028-02-29T00:00:00+09:00",
  ]) assert.equal(isIsoWithOffset(ok), true, ok);

  for (const ng of [
    "2026-09-24T03:47:00",          // 現行HTMLにあるオフセットなし表記
    "2026-09-26",                   // 日付のみ
    "2026/09/26 21:00",             // 表示用の書式
    "2026-09-26 21:00:00+09:00",    // T区切りなし
    "2026-02-30T00:00:00+09:00",    // 存在しない日
    "2027-02-29T00:00:00+09:00",    // 平年の2/29
    "2026-09-26T24:00:00+09:00",
    "2026-09-26T21:00:00+15:00",
    "",
    null,
    1727352000000,
  ]) assert.equal(isIsoWithOffset(ng), false, String(ng));
});

test("異なるオフセットでも同じ瞬間として比較する", () => {
  assert.equal(toMs("2026-09-26T21:00:00+09:00"), toMs("2026-09-26T12:00:00Z"));
  assert.equal(notAfter("2026-09-26T20:59:00+09:00", "2026-09-26T12:00:00Z"), true);
  assert.equal(notAfter("2026-09-26T21:01:00+09:00", "2026-09-26T12:00:00Z"), false);
  assert.equal(notAfter(null, "2026-09-26T12:00:00Z"), true);
});

test("オフセットなしの時刻は比較に使えない（例外）", () => {
  assert.throws(() => toMs("2026-09-24T03:47:00"), /タイムゾーン付き/);
});
