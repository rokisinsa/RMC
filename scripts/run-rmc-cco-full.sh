#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "$RMC_RUN_ID"
: "$RMC_SLOT"
RMC_SOURCE="${RMC_SOURCE:-CCO full production runner}"

CCO_BIN="$(command -v cco || true)"
if [ -z "$CCO_BIN" ]; then CCO_BIN="$(command -v claude || true)"; fi
if [ -z "$CCO_BIN" ]; then echo "CCO/Claude Code CLI not found on PATH" >&2; exit 20; fi
"$CCO_BIN" --version || true

mkdir -p tmp incoming
START_SHA="$(git rev-parse HEAD)"
echo "$START_SHA" > tmp/cco-start-sha.txt

rm -f /tmp/rmc-bc-attempt1.json /tmp/rmc-bc-attempt2.json
set +e
node scripts/scrape-bet-channel.mjs /tmp/rmc-bc-attempt1.json
code1=$?
set -e
need_retry=yes
if [ "$code1" -eq 0 ] && [ -s /tmp/rmc-bc-attempt1.json ]; then
  need_retry="$(node - <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("/tmp/rmc-bc-attempt1.json","utf8"));
process.stdout.write((x.self_audit?.requires_rescan || !x.complete || !x.analysis_ready) ? "yes" : "no");
NODE
)"
fi
if [ "$need_retry" = yes ]; then
  node scripts/scrape-bet-channel.mjs /tmp/rmc-bc-attempt2.json
fi
args=(--attempt1 /tmp/rmc-bc-attempt1.json --out data/bet-channel-inventory.json --summary data/bet-channel-screening-summary.json)
[ -s /tmp/rmc-bc-attempt2.json ] && args+=(--attempt2 /tmp/rmc-bc-attempt2.json)
node scripts/select-bet-channel-inventory.mjs "${args[@]}"

COUNTRY="$(curl -fsS https://www.cloudflare.com/cdn-cgi/trace | awk -F= '$1=="loc"{print $2}' | tr -d '\r\n' || true)"
if [ "$COUNTRY" != JP ]; then echo "Japan egress required; detected=$COUNTRY" >&2; exit 21; fi
export RMC_SOURCE_REGION=JP
export RMC_SOURCE_REGION_EVIDENCE=cloudflare_trace:JP
if [ "${RUNNER_OS:-}" = Windows ]; then export RMC_SOURCE_MACHINE=japan_local_windows; else export RMC_SOURCE_MACHINE=japan_vps_linux; fi
node scripts/scrape-bet-channel-fixed-odds-local.mjs data/bet-channel-fixed-odds-inventory.json
node scripts/build-bet-channel-complete-inventory.mjs data/bet-channel-screening-summary.json data/bet-channel-fixed-odds-inventory.json data/bet-channel-complete-summary.json

node - <<'NODE'
const fs=require("fs");
const x=JSON.parse(fs.readFileSync("data/bet-channel-complete-summary.json","utf8"));
const now=Date.now(), l=Date.parse(x.component_status?.legacy?.checked_at||""), f=Date.parse(x.component_status?.fixed_odds?.checked_at||"");
const errs=[];
if(x.complete!==true||x.analysis_ready!==true||x.menu_end_verified!==true||(x.self_audit?.unresolved_blockers??1)!==0) errs.push("complete_union_not_ready");
if(!Number.isFinite(l)||now-l>45*60*1000) errs.push("legacy_stale");
if(!Number.isFinite(f)||now-f>55*60*1000) errs.push("fixed_odds_stale");
if((x.screening_event_count??0)<1) errs.push("screening_empty");
console.log(JSON.stringify({checked_at:x.checked_at,category_count:x.category_count,event_count:x.event_count,screening_event_count:x.screening_event_count,legacy:x.component_status?.legacy,fixed:x.component_status?.fixed_odds,errs},null,2));
if(errs.length) process.exit(1);
NODE

PAYLOAD="incoming/$RMC_RUN_ID.json"
rm -f "$PAYLOAD"
cat > tmp/cco-full-run-prompt.txt <<EOF
RMCの本物の完全本番runを実行する。run_id=$RMC_RUN_ID、slot=$RMC_SLOT、source="$RMC_SOURCE"。
CI/rehearsal/dry-run用の架空分析ではない。

最初に docs/RMC_ANALYSIS_LOGIC.md、schema/rmc-update-payload.schema.json、scripts/rmc-production-update.mjs、scripts/rmc-scheduled-checklist.mjs を読む。
freshな data/bet-channel-complete-summary.json の screening_event_ids 全件を、①recommendations ②value1 ③value2 ④pro_edge で完全独立一次走査する。リアルスポーツ全競技＋eSports全タイトルを対象にし、共通候補プールへまとめない。

deep_diveに上げたイベントはWebSearch/WebFetchを実際に使い、H2H、直近6〜10戦、直近の共通相手比較、ranking/rating、平均得失点/SET/MAP/round差、H/AまたはLAN/online、roster/欠場、休養/移動、前半/1Q/1st set/Map1など序盤傾向、競技固有指標、最新市場価格を複数情報源で確認する。1回検索して無いだけでinsufficient_dataにしない。公式→大会/リーグ公式→専門DB→信頼できる統計サイトへ検索を広げる。
eSportsはBO、patch/version、roster変更、map pool、veto（該当時）、map勝率、共通相手、Tier差まで確認する。
カジ旅、遊雅堂、bet365は公開取得可能範囲をWebでクロスチェックし、取れない場合もsource_auditへURL、checked_at、access_status、具体的理由を残す。推測値は禁止。
H2Hが本当に0件、共通相手が本当に0件なら、その事実を確認した根拠を明記すればよい。
deep_diveが5件以上ある系統でinsufficient_dataが60%超なら追加調査を続ける。解消不能なら tmp/cco-blocker.txt に理由を書いて非0終了し、未完成payloadを公開しない。

既存①〜④＋experienceの開始済みpending/unknown/review_requiredも再照合する。公式→大会/リーグ公式→専門DB→信頼できるscore DBの順で確認し、確定できた結果のみresult_updates/post_match_reviewsへ入れる。
新規正式採用はsource_event_id、exact odds、observed_at/source、stake、bet_at、locked_atを固定する。市場確率を独立推定確率へコピーしない。

現行schemaとvalidatorに完全準拠したJSONを $PAYLOAD にだけ作る。data/*.jsonを直接編集しない。古いincomingは構造例だけに使い、古い事実・価格・判定を流用しない。scripts/build-live-coverage-rehearsal.mjs の unavailable ダミーは禁止。

payload作成後に必ず次を実行し、失敗したらpayloadを修正してPASSするまで繰り返す:
node scripts/rmc-production-update.mjs --payload "$PAYLOAD" --dry-run --start-sha "$START_SHA" --report tmp/cco-dry-run.json

最後に $PAYLOAD が存在し、tmp/cco-dry-run.json の ok=true を確認して終了する。
EOF

"$CCO_BIN" -p "$(cat tmp/cco-full-run-prompt.txt)" --dangerously-skip-permissions --output-format text | tee tmp/cco-full-run.log

test -s "$PAYLOAD"
node scripts/rmc-production-update.mjs --payload "$PAYLOAD" --dry-run --start-sha "$START_SHA" --report tmp/cco-dry-run-final.json
node - <<'NODE'
const fs=require("fs");
const r=JSON.parse(fs.readFileSync("tmp/cco-dry-run-final.json","utf8"));
if(r.ok!==true){console.error(JSON.stringify(r,null,2));process.exit(1)}
console.log("CCO payload dry-run PASS");
NODE
