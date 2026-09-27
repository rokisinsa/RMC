// trigger: manual-complete-check-20260927-2046
import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const BASE = "https://bet-channel.com";
const START = `${BASE}/matches?lang=ja`;
const OUT = process.argv[2] || "data/bet-channel-inventory.json";
const NOW = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
let previousInventory = null;
try { previousInventory = JSON.parse(await fs.readFile(OUT,"utf8")); } catch {}

const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
const abs = u => { try { return new URL(u, BASE).toString(); } catch { return null; } };
const hash = s => crypto.createHash("sha256").update(s).digest("hex").slice(0,20);

function walk(x, fn, seen=new Set()){
  if(x===null||typeof x!=="object"||seen.has(x)) return;
  seen.add(x); fn(x);
  if(Array.isArray(x)) for(const v of x) walk(v,fn,seen);
  else for(const v of Object.values(x)) walk(v,fn,seen);
}
function eventFrom(o, sourceUrl, category, categoryCt){
  const hasMeta = ["game_start_date","game_start_time","band_name","graph_choice1","graph_choice2","Choices","match_name","match_title","match_detail"].some(k => Object.prototype.hasOwnProperty.call(o,k));
  if(!hasMeta) return null;
  const id = o.match_id ?? o.matchId ?? o.event_id ?? o.eventId ?? o.id;
  if(id == null) return null;
  const choicesObj = o.Choices ?? o.choices ?? o.choice_list ?? null;
  const choiceNames=[];
  if(choicesObj && typeof choicesObj==="object"){
    walk(choicesObj,x=>{ if(x && typeof x==="object" && x.choice_name) choiceNames.push(clean(x.choice_name)); });
  }
  const choice1 = clean(o.graph_choice1 ?? o.choice1_name ?? o.team1_name ?? o.home_name ?? o.home_team ?? choiceNames[0] ?? "") || null;
  const choice2 = clean(o.graph_choice2 ?? o.choice2_name ?? o.team2_name ?? o.away_name ?? o.away_team ?? choiceNames[1] ?? "") || null;
  return {
    event_id:String(id),
    category:category||null,
    category_ct:categoryCt??null,
    category_key:categoryCt!=null ? String(categoryCt)+":"+String(category||"") : null,
    source_url:sourceUrl,
    game_start_date:o.game_start_date ?? o.start_date ?? o.date ?? null,
    game_start_time:o.game_start_time ?? o.start_time ?? o.time ?? null,
    bet_end_time:o.bet_end_time ?? null,
    band_name:clean(o.band_name ?? o.league_name ?? o.competition_name ?? o.match_name ?? o.match_title ?? "") || null,
    status:o.statusString ?? o.status ?? null,
    choice1, choice2,
    choice_names:[...new Set(choiceNames)].filter(Boolean),
    raw_keys:Object.keys(o).slice(0,60),
    has_choices:!!choicesObj
  };
}

const NON_SPORT_LABELS = /選挙|M-1|格付けロト|バラエティ|スペシャルオッズ/;
const SCORE_CHOICE = /\b\d+\s*-\s*\d+\b/;
const PROP_CHOICE = /^(はい|いいえ|ホームラン|全ての出塁|アウト)$/;

function parseBetChannelJst(dateText,timeText,checkedIso=NOW){
  const dm=String(dateText??"").match(/(\d{1,2})月(\d{1,2})日/);
  const tm=String(timeText??"").match(/^(\d{1,2}):(\d{2})$/);
  if(!dm||!tm) return null;
  const checked=new Date(checkedIso);
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(checked);
  const get=t=>Number(parts.find(x=>x.type===t)?.value);
  let year=get("year"), month=Number(dm[1]), day=Number(dm[2]), hour=Number(tm[1]), minute=Number(tm[2]);
  const checkedMonth=get("month");
  if(checkedMonth===12 && month===1) year++;
  if(checkedMonth===1 && month===12) year--;
  day += Math.floor(hour/24); hour%=24;
  return new Date(Date.UTC(year,month-1,day,hour-9,minute,0)).toISOString();
}
function jstIso(iso){
  if(!iso) return null;
  const d=new Date(iso);
  const p=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(d).replace(" ","T");
  return p+"+09:00";
}
function normalizeSide(v){
  return clean(v).replace(/\s+\d+\s*-\s*\d+.*$/,"").replace(/[　\s]+/g," ").toLowerCase();
}
function isPrimaryMarket(e){
  const choices=(e.market_choices??[]).map(x=>clean(x.choice_name)).filter(Boolean);
  if(NON_SPORT_LABELS.test(e.category??"")) return false;
  if(e.band_name && e.band_name!=="最終結果") return false;
  if(choices.length<2 || choices.length>3) return false;
  if(choices.slice(0,2).some(x=>SCORE_CHOICE.test(x)||PROP_CHOICE.test(x))) return false;
  if(choices.length===3 && !/引き分け|draw/i.test(choices[2])) return false;
  return true;
}
function canonicalKey(e){
  const a=normalizeSide(e.choice1), b=normalizeSide(e.choice2);
  if(!a||!b||!e.start_at_jst) return null;
  const pair=[a,b].sort().join("||");
  return hash(e.start_at_jst+"|"+pair);
}


const browser = await chromium.launch({headless:true});
const ctx = await browser.newContext({locale:"ja-JP", timezoneId:"Asia/Tokyo"});
async function collectPage(url, label, categoryCt=null){
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const events = new Map();
  const oddsByMatch = new Map();
  const jsonUrls = new Set();
  const responseErrors = [];
  const onResponse = async r => {
    const ct=(r.headers()["content-type"]||"").toLowerCase();
    if(!ct.includes("json")) return;
    try{
      const j=await r.json(); jsonUrls.add(r.url());
      walk(j,o=>{
        const e=eventFrom(o,url,label,categoryCt);
        if(e){
          const prev=events.get(e.event_id);
          if(!prev) events.set(e.event_id,e);
          else events.set(e.event_id,{...prev,...Object.fromEntries(Object.entries(e).filter(([,v])=>v!=null && v!=="" && !(Array.isArray(v)&&v.length===0)))});
        }
        const mid=o?.match_id ?? o?.matchId;
        if(mid!=null && (o?.odds!=null || o?.choice_name!=null)){
          const arr=oddsByMatch.get(String(mid)) ?? [];
          arr.push({choice_name:clean(o.choice_name)||null,odds:o.odds??null,choice_id:o.choice_id??null,is_valid_bet:o.is_valid_bet??null});
          oddsByMatch.set(String(mid),arr);
        }
      });
    }catch(e){ responseErrors.push({url:r.url(),error:String(e.message||e)}); }
  };
  page.on("response",onResponse);
  let navStatus=null, title=null, bodyText="";
  try{
    const r=await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    navStatus=r?.status()??null;
    await page.waitForTimeout(900);
    for(let i=0;i<10;i++){
      const btn=page.getByText("もっと試合を表示する",{exact:false}).last();
      if(await btn.count()===0) break;
      try{
        if(!(await btn.isVisible())) break;
        await btn.click({timeout:2000});
        await page.waitForTimeout(250);
      }catch{break;}
    }
    title=await page.title();
    bodyText=clean(await page.locator("body").innerText()).slice(0,5000);
    const dom = await page.evaluate(() => {
      const out=[];
      const nodes=[...document.querySelectorAll("[data-match-id],[match-id],[id*=match], [ng-repeat*=match]")];
      for(const el of nodes){
        const id=el.getAttribute("data-match-id")||el.getAttribute("match-id")||el.id||null;
        const text=(el.innerText||"").replace(/\s+/g," ").trim();
        if(id||text) out.push({id,text:text.slice(0,500)});
      }
      return out;
    });
    for(const d of dom){
      const id=(String(d.id||"").match(/\d{4,}/)||[])[0];
      if(id&&!events.has(id)) events.set(id,{event_id:id,category:label||null,source_url:url,game_start_date:null,game_start_time:null,bet_end_time:null,band_name:null,status:null,choice1:null,choice2:null,raw_keys:["dom_fallback"],has_choices:false,dom_text:d.text});
    }
  }catch(e){ responseErrors.push({url,error:String(e.message||e)}); }
  for(const [mid, odds] of oddsByMatch){
    const e=events.get(mid);
    if(e){
      e.market_choices=odds;
      if(!e.choice1 && odds[0]?.choice_name) e.choice1=odds[0].choice_name;
      if(!e.choice2 && odds[1]?.choice_name) e.choice2=odds[1].choice_name;
    }
  }
  page.off("response",onResponse);
  await page.close();
  return {url,label,nav_status:navStatus,title,json_urls:[...jsonUrls],event_count:events.size,events:[...events.values()],errors:responseErrors,body_excerpt:bodyText};
}

const menuPage = await ctx.newPage();
menuPage.setDefaultTimeout(10000);
await menuPage.goto(START,{waitUntil:"domcontentloaded",timeout:30000});
await menuPage.waitForTimeout(1200);
const anchors = await menuPage.evaluate(() => [...document.querySelectorAll('a[href*="/matches?ct="]')].map(a=>({text:(a.textContent||"").replace(/\s+/g," ").trim(),href:a.getAttribute("href")})));
await menuPage.close();
const root = await collectPage(START,"本日のイベント","1");
const catsMap=new Map();
for(const a of anchors){
  const u=abs(a.href); if(!u) continue;
  const m=u.match(/[?&]ct=(\d+)/); if(!m) continue;
  const key=m[1]; if(!catsMap.has(key)) catsMap.set(key,{ct:key,label:clean(a.text)||`ct-${key}`,url:u.includes("lang=")?u:u+(u.includes("?")?"&":"?")+"lang=ja"});
}
const categories=[...catsMap.values()].sort((a,b)=>Number(a.ct)-Number(b.ct));

const results=[];
const CONCURRENCY=8;
for(let i=0;i<categories.length;i+=CONCURRENCY){
  const batch=categories.slice(i,i+CONCURRENCY);
  const got=await Promise.all(batch.map(async c=>({...c,...await collectPage(c.url,c.label,c.ct)})));
  results.push(...got);
  console.log(`progress ${Math.min(i+CONCURRENCY,categories.length)}/${categories.length}`);
}

/* BET CHANNEL fixed-odds / Betby eSports completeness probe.
   The legacy /matches tree and fixed-odds sportsbook are separate surfaces.
   We persist the status so production can refuse a false "complete" update. */
let fixedOddsStatus={
  schema_version:1,
  checked_at:NOW,
  source:"BET CHANNEL fixed-odds / Betby",
  source_urls:[],
  access_status:"unavailable",
  menu_end_verified:false,
  event_feed_detected:false,
  event_count:0,
  event_ids:[],
  rules_esports_detected:false,
  supported_title_hints:[],
  complete:false,
  blocker_reason:"not_checked"
};
{
  const probeUrls=[
    `${BASE}/fixed-odds?bt-path=/`,
    `${BASE}/fixed-odds?bt-path=/esports`,
    `${BASE}/fixed-odds?bt-path=/esports-1`
  ];
  const allBodies=[];
  const hitUrls=new Set();
  let geoBlocked=false;
  const diagnosticResources=new Set();
  const diagnosticScripts=new Set();
  const diagnosticHosts=new Set();
  const diagnosticBrandIds=new Set();
  const diagnosticSnippets=[];
  const diagnosticWebSockets=new Set();
  const diagnosticFailedRequests=[];
  const diagnosticConsole=[];
  for(const probeUrl of probeUrls){
    const p=await ctx.newPage();
    p.setDefaultTimeout(12000);
    const hits=[];
    p.on("websocket",ws=>diagnosticWebSockets.add(ws.url()));
    p.on("requestfailed",req=>diagnosticFailedRequests.push({url:req.url(),failure:req.failure()?.errorText??null}));
    p.on("console",msg=>{
      const s=msg.text();
      if(/betby|sptpub|brand|sport|geo|forbidden|location|api|socket/i.test(s)) diagnosticConsole.push(s.slice(0,2000));
    });
    p.on("response",async resp=>{
      const u=resp.url();
      diagnosticResources.add(u);
      try{ diagnosticHosts.add(new URL(u).host); }catch{}
      const ct=(resp.headers()["content-type"]||"").toLowerCase();
      if(!ct.includes("json")) return;
      try{
        const j=await resp.json();
        const raw=JSON.stringify(j);
        if(/esport|counter.?strike|valorant|dota|league.?of.?legends|rainbow|honor.?of.?kings|king.?of.?glory|world.?of.?tanks|fortnite|starcraft|nba.?2k|ea.?sports.?fc|rocket.?league|overwatch|call.?of.?duty|pubg|mobile.?legends/i.test(raw)){
          hits.push({url:u,sample:raw.slice(0,12000)});
          hitUrls.add(u);
        }
      }catch{}
    });
    let body="", html="";
    try{
      await p.goto(probeUrl,{waitUntil:"domcontentloaded",timeout:30000});
      await p.waitForTimeout(4500);
      body=clean(await p.locator("body").innerText()).slice(0,20000);
      html=await p.content();
      const scripts=await p.locator("script").evaluateAll(nodes=>nodes.map(s=>({src:s.src||"",text:(s.textContent||"").slice(0,50000)})));
      for(const s of scripts){
        if(s.src){ diagnosticScripts.add(s.src); diagnosticResources.add(s.src); try{diagnosticHosts.add(new URL(s.src).host);}catch{} }
        const corpus=(s.text||"")+"\n"+html.slice(0,200000);
        for(const m of corpus.matchAll(/(?:brand_id|brandId)\s*[:=]\s*["']?(\d{6,})/gi)) diagnosticBrandIds.add(m[1]);
        if(/BTRenderer|invisiblesport|sptpub|betby/i.test(corpus)){
          const ix=corpus.search(/BTRenderer|brand_id|brandId|invisiblesport|sptpub|betby/i);
          diagnosticSnippets.push(ix>=0?corpus.slice(Math.max(0,ix-1000),Math.min(corpus.length,ix+12000)):"");
        }
      }

      // BET CHANNELのinline初期化がCSP nonce不一致で止まるrunner環境では、
      // DevTools経由で同じ公開BTRendererを明示初期化して通信先を観測する。
      // 認証トークンは使わず guest(null) のみ。brand_idはページHTMLから抽出した正式値を使う。
      const brandId=[...diagnosticBrandIds][0]||"2564963746585911298";
      try{
        const initState=await p.evaluate(async ({brandId,probeUrl})=>{
          const route=new URL(probeUrl).searchParams.get("bt-path")||"/";
          let target=document.getElementById("betby");
          if(!target){ target=document.createElement("div"); target.id="betby"; document.body.appendChild(target); }
          const hasRenderer=typeof window.BTRenderer==="function";
          if(!hasRenderer) return {ok:false,reason:"BTRenderer_missing",route};
          try{
            const instance=new window.BTRenderer().initialize({
              brand_id:String(brandId),
              token:null,
              lang:"ja",
              url:route,
              target,
              stickyTop:0,
              betSlipOffsetTop:0,
              betSlipOffsetBottom:0,
              betslipZIndex:100
            });
            window.__rmcBetbyInstance=instance;
            return {ok:true,route};
          }catch(e){ return {ok:false,reason:String(e?.message||e),route}; }
        },{brandId,probeUrl});
        diagnosticConsole.push("RMC_MANUAL_BT_INIT "+JSON.stringify(initState));
        await p.waitForTimeout(7000);
      }catch(e){
        diagnosticConsole.push("RMC_MANUAL_BT_INIT_ERROR "+String(e?.message||e));
      }

      const perf=await p.evaluate(()=>performance.getEntriesByType("resource").map(x=>x.name));
      for(const u of perf){ diagnosticResources.add(u); try{diagnosticHosts.add(new URL(u).host);}catch{} }
    }catch(e){ body="ERROR "+String(e.message||e); }
    if(/Access is forbidden from your location|forbidden from your location/i.test(body)) geoBlocked=true;
    allBodies.push(body+"\n"+html.slice(0,200000));
    console.log("FIXED_ODDS_ESPORTS_PROBE "+JSON.stringify({
      probeUrl,geoBlocked,body:body.slice(0,5000),hit_urls:hits.map(x=>x.url),
      brand_ids:[...diagnosticBrandIds],
      hosts:[...diagnosticHosts].filter(h=>/betby|invisible|sptpub|bet-channel/i.test(h)),
      resources:[...diagnosticResources].filter(u=>/betby|invisible|sptpub|api|sport/i.test(u)).slice(0,80)
    }));
    await p.close();
  }
  const combined=allBodies.join("\n");
  const titleHints=[
    ["Counter-Strike / CS2",/counter.?strike|cs2/i],
    ["VALORANT",/valorant/i],
    ["Dota 2",/dota\s*2/i],
    ["League of Legends",/league.?of.?legends/i],
    ["Rainbow Six",/rainbow.?six/i],
    ["Honor of Kings / King of Glory",/honor.?of.?kings|king.?of.?glory/i],
    ["World of Tanks",/world.?of.?tanks/i],
    ["EA SPORTS FC / eSoccer",/ea.?sports.?fc|esoccer|eサッカー/i],
    ["NBA 2K / eBasketball",/nba.?2k|ebasketball|eBasketball/i],
    ["Fortnite",/fortnite/i],
    ["StarCraft",/starcraft/i],
    ["Overwatch",/overwatch/i],
    ["Call of Duty",/call.?of.?duty/i],
    ["PUBG",/pubg/i],
    ["Mobile Legends",/mobile.?legends/i]
  ].filter(([,re])=>re.test(combined)).map(([name])=>name);
  const eventFeedDetected=hitUrls.size>0;
  fixedOddsStatus={
    schema_version:1,
    checked_at:NOW,
    source:"BET CHANNEL fixed-odds / Betby",
    source_urls:probeUrls,
    access_status:geoBlocked?"unavailable":eventFeedDetected?"partial":"partial",
    menu_end_verified:false,
    event_feed_detected:eventFeedDetected,
    event_count:0,
    event_ids:[],
    json_hit_urls:[...hitUrls],
    diagnostic_brand_ids:[...diagnosticBrandIds],
    diagnostic_hosts:[...diagnosticHosts].filter(h=>/betby|invisible|sptpub|bet-channel/i.test(h)),
    diagnostic_script_urls:[...diagnosticScripts].slice(0,80),
    diagnostic_resource_urls:[...diagnosticResources].filter(u=>/betby|invisible|sptpub|api|sport/i.test(u)).slice(0,160),
    diagnostic_all_hosts:[...diagnosticHosts].slice(0,120),
    diagnostic_nonstatic_urls:[...diagnosticResources].filter(u=>!/[.](?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|css)(?:[?#]|$)/i.test(u)).slice(0,240),
    diagnostic_websocket_urls:[...diagnosticWebSockets].slice(0,80),
    diagnostic_failed_requests:diagnosticFailedRequests.slice(0,80),
    diagnostic_console:[...new Set(diagnosticConsole)].slice(0,80),
    diagnostic_snippets:[...new Set(diagnosticSnippets.filter(Boolean))].slice(0,20),
    rules_esports_detected:/eスポーツ特別ルール|esports related rules|eスポーツ/i.test(combined),
    supported_title_hints:titleHints,
    complete:false,
    blocker_reason:geoBlocked
      ?"github_actions_region_blocked_fixed_odds"
      :eventFeedDetected
        ?"fixed_odds_event_feed_detected_but_complete_event_parser_not_implemented"
        :"fixed_odds_event_feed_not_observed"
  };
  await fs.mkdir("data",{recursive:true});
  await fs.writeFile("data/bet-channel-fixed-odds-status.json",JSON.stringify(fixedOddsStatus,null,2)+"\n");
  console.log("FIXED_ODDS_ESPORTS_STATUS "+JSON.stringify(fixedOddsStatus));
}
await browser.close();

const allEvents=new Map();
for(const r of [root,...results]) for(const e of r.events||[]){
  const prev=allEvents.get(e.event_id);
  if(!prev) allEvents.set(e.event_id,{...e,seen_in:[r.label],seen_in_keys:[(r.ct??"1")+":"+r.label]});
  else {
    if(!prev.seen_in.includes(r.label)) prev.seen_in.push(r.label);
    const k=(r.ct??"1")+":"+r.label;
    prev.seen_in_keys ??= [];
    if(!prev.seen_in_keys.includes(k)) prev.seen_in_keys.push(k);
  }
}
const failed=results.filter(r=>!r.nav_status||r.nav_status>=400||r.errors.some(e=>/Timeout|ERR_|Navigation/.test(e.error)));
const empty=results.filter(r=>r.event_count===0);
for(const e of allEvents.values()){
  e.start_at_jst=jstIso(parseBetChannelJst(e.game_start_date,e.game_start_time));
  e.primary_market=isPrimaryMarket(e);
  e.canonical_match_key=e.primary_market ? canonicalKey(e) : null;
}
const metadataMissing=[...allEvents.values()].filter(e=>!(e.game_start_date&&e.game_start_time) || !(e.choice1||e.choice2||e.band_name));
const timeParseMissing=[...allEvents.values()].filter(e=>e.game_start_date&&e.game_start_time&&!e.start_at_jst);
const checkedMs=new Date(NOW).getTime();
// 一次走査の母集団は「今BET CHANNELに掲載中のスポーツ/eスポーツ全イベント」。
// 48hや最終結果市場で先に削らない。12hは深掘り優先順位にだけ使う。
const screeningEvents=[...allEvents.values()].filter(e=>e.status===0 && !NON_SPORT_LABELS.test(e.category??""));
const priority12hEndMs=checkedMs+12*3600e3;
const priority12hEvents=screeningEvents.filter(e=>{
  if(!e.start_at_jst) return false;
  const t=new Date(e.start_at_jst).getTime();
  return t>=checkedMs && t<=priority12hEndMs;
});

// 従来の48h canonical primary cardsは表示・比較用として残すが、全件走査の母集団には使わない。
const windowStartMs=checkedMs;
const windowEndMs=checkedMs+48*3600e3;
const primaryCurrent=screeningEvents.filter(e=>{
  if(!e.primary_market||!e.start_at_jst) return false;
  const t=new Date(e.start_at_jst).getTime();
  return t>=windowStartMs && t<=windowEndMs;
});
const canonical=new Map();
for(const e of primaryCurrent){
  if(!e.canonical_match_key) continue;
  const old=canonical.get(e.canonical_match_key);
  if(!old) canonical.set(e.canonical_match_key,{
    card_id:"bc-"+e.canonical_match_key,
    start_at_jst:e.start_at_jst,
    category:e.category,
    category_ct:e.category_ct,
    category_key:e.category_key,
    side_a:e.choice1,
    side_b:e.choice2,
    source_event_ids:[e.event_id],
    market_choices:e.market_choices??[],
    bettable:(e.market_choices??[]).slice(0,2).every(x=>x.is_valid_bet===true && typeof x.odds==="number" && x.odds>1),
    source_url:e.source_url,
    seen_in:e.seen_in??[],
    seen_in_keys:e.seen_in_keys??[]
  });
  else{
    if(!old.source_event_ids.includes(e.event_id)) old.source_event_ids.push(e.event_id);
    for(const x of e.seen_in??[]) if(!old.seen_in.includes(x)) old.seen_in.push(x);
    for(const x of e.seen_in_keys??[]) if(!old.seen_in_keys.includes(x)) old.seen_in_keys.push(x);
  }
}
const analysisCards=[...canonical.values()].sort((a,b)=>a.start_at_jst.localeCompare(b.start_at_jst)||a.card_id.localeCompare(b.card_id));
const categoryKeys=categories.map(c=>String(c.ct)+":"+c.label);
const analysisCardCountsByCategory=Object.fromEntries(categoryKeys.map(k=>[k,0]));
for(const card of analysisCards){
  if(card.category_key in analysisCardCountsByCategory) analysisCardCountsByCategory[card.category_key]++;
}
const screeningEventCountsByCategory=Object.fromEntries(categoryKeys.map(k=>[k,0]));
for(const e of screeningEvents){
  const k=e.category_key;
  if(k in screeningEventCountsByCategory) screeningEventCountsByCategory[k]++;
}
const integrity={
  event_count_matches_ids:allEvents.size===new Set(allEvents.keys()).size,
  unique_category_ct:categories.length===new Set(categories.map(c=>c.ct)).size,
  category_keys_complete:categoryKeys.length===categories.length && new Set(categoryKeys).size===categoryKeys.length,
  category_card_counts_sum:Object.values(analysisCardCountsByCategory).reduce((a,b)=>a+b,0)===analysisCards.length,
  screening_event_count_matches_ids:screeningEvents.length===new Set(screeningEvents.map(x=>x.event_id)).size,
  screening_category_counts_sum:Object.values(screeningEventCountsByCategory).reduce((a,b)=>a+b,0)===screeningEvents.length,
  priority_12h_is_subset:priority12hEvents.every(x=>screeningEvents.some(y=>y.event_id===x.event_id)),
  digest:hash(JSON.stringify([...allEvents.keys()].sort())),
  screening_digest:hash(JSON.stringify(screeningEvents.map(x=>x.event_id).sort())),
  analysis_card_count_matches_ids:analysisCards.length===new Set(analysisCards.map(x=>x.card_id)).size
};
const anomalies=[];
const anomaly=(code,severity,message,details={})=>anomalies.push({code,severity,message,details});
if(categories.length===0) anomaly("CATEGORY_ZERO","blocker","カテゴリを1件も取得できていない");
if(screeningEvents.length===0) anomaly("SCREENING_ZERO","blocker","掲載中スポーツ/eスポーツの一次走査対象が0件");
if(failed.length>0) anomaly("CATEGORY_FETCH_FAILURE","blocker",`取得失敗カテゴリが${failed.length}件ある`,{failed_category_count:failed.length});
if(metadataMissing.length>0) anomaly("METADATA_MISSING","blocker",`必須メタデータ欠損が${metadataMissing.length}件ある`,{metadata_missing_count:metadataMissing.length});
if(timeParseMissing.length>0) anomaly("TIME_PARSE_FAILURE","blocker",`開始時刻を解釈できないイベントが${timeParseMissing.length}件ある`,{time_parse_missing_count:timeParseMissing.length});
for(const [key,ok] of Object.entries(integrity)) if(typeof ok==="boolean"&&!ok) anomaly("INTEGRITY_"+key.toUpperCase(),"blocker",`整合性チェック失敗: ${key}`);
const prevScreen=Number(previousInventory?.screening_event_count??0);
const prevCats=Number(previousInventory?.category_count??0);
if(prevScreen>=30 && screeningEvents.length < prevScreen*0.55) anomaly("SCREENING_EVENT_DROP","warning",`一次走査対象が前回比45%以上急減: ${prevScreen}→${screeningEvents.length}`,{previous:prevScreen,current:screeningEvents.length,ratio:screeningEvents.length/prevScreen});
if(prevCats>=20 && categories.length < prevCats*0.75) anomaly("CATEGORY_COUNT_DROP","warning",`カテゴリ数が前回比25%以上急減: ${prevCats}→${categories.length}`,{previous:prevCats,current:categories.length,ratio:categories.length/prevCats});
const blockerCount=anomalies.filter(x=>x.severity==="blocker").length;
const requiresRescan=blockerCount>0 || anomalies.some(x=>["SCREENING_EVENT_DROP","CATEGORY_COUNT_DROP"].includes(x.code));
const selfAudit={
  checked_at:NOW,
  previous_checked_at:previousInventory?.checked_at??null,
  previous_counts:previousInventory?{category_count:prevCats,event_count:Number(previousInventory.event_count??0),screening_event_count:prevScreen}:null,
  checks_run:[
    "category_nonzero","screening_nonzero","category_fetch_failures","metadata_completeness","time_parse",
    "event_id_uniqueness","category_uniqueness","category_count_integrity","screening_id_integrity",
    "screening_category_sum","priority_subset","previous_screening_drop","previous_category_drop"
  ],
  anomaly_count:anomalies.length,
  blocker_count:blockerCount,
  warning_count:anomalies.filter(x=>x.severity==="warning").length,
  anomalies,
  requires_rescan:requiresRescan,
  remediation_status:requiresRescan?"retry_required":"not_needed",
  fixes_applied:[],
  unresolved_blockers:blockerCount,
  status:blockerCount?"blocker":requiresRescan?"suspicious":"pass"
};
selfAudit.digest=hash(JSON.stringify({checked_at:selfAudit.checked_at,previous_checked_at:selfAudit.previous_checked_at,anomalies:selfAudit.anomalies,screening_digest:integrity.screening_digest}));

const inventory={
  schema_version:1,
  source:"BET CHANNEL",
  source_url:START,
  checked_at:NOW,
  acquisition:"playwright_dynamic_xhr_plus_dom",
  menu_end_verified:categories.length>0,
  category_count:categories.length,
  category_keys:categoryKeys,
  event_count:allEvents.size,
  failed_category_count:failed.length,
  empty_category_count:empty.length,
  metadata_missing_count:metadataMissing.length,
  time_parse_missing_count:timeParseMissing.length,
  market_event_count:allEvents.size,
  screening_rule:"all currently listed active sports/esports market events; no horizon or primary-market prefilter",
  screening_event_count:screeningEvents.length,
  screening_event_ids:screeningEvents.map(e=>e.event_id).sort(),
  screening_events:screeningEvents.sort((a,b)=>(a.start_at_jst??"").localeCompare(b.start_at_jst??"")||String(a.event_id).localeCompare(String(b.event_id))),
  screening_event_counts_by_category:screeningEventCountsByCategory,
  priority_window:{start_jst:jstIso(new Date(checkedMs).toISOString()),end_jst:jstIso(new Date(priority12hEndMs).toISOString()),hours:12},
  priority_12h_event_count:priority12hEvents.length,
  priority_12h_event_ids:priority12hEvents.map(e=>e.event_id).sort(),
  analysis_window:{start_jst:jstIso(new Date(windowStartMs).toISOString()),end_jst:jstIso(new Date(windowEndMs).toISOString()),hours:48},
  analysis_card_count:analysisCards.length,
  bettable_analysis_card_count:analysisCards.filter(x=>x.bettable).length,
  unavailable_price_card_count:analysisCards.filter(x=>!x.bettable).length,
  analysis_card_ids:analysisCards.map(x=>x.card_id),
  analysis_cards:analysisCards,
  analysis_card_counts_by_category:analysisCardCountsByCategory,
  analysis_ready:failed.length===0 && metadataMissing.length===0 && timeParseMissing.length===0 && analysisCards.length>0,
  complete:failed.length===0 && metadataMissing.length===0 && timeParseMissing.length===0 && allEvents.size>0,
  categories:results.map(r=>({ct:r.ct,label:r.label,url:r.url,nav_status:r.nav_status,event_count:r.event_count,json_urls:r.json_urls,errors:r.errors})),
  event_ids:[...allEvents.keys()],
  events:[...allEvents.values()],
  failed_categories:failed.map(r=>({ct:r.ct,label:r.label,url:r.url,errors:r.errors})),
  metadata_missing_events:metadataMissing.slice(0,200).map(e=>({event_id:e.event_id,category:e.category,game_start_date:e.game_start_date,game_start_time:e.game_start_time,band_name:e.band_name,choice1:e.choice1,choice2:e.choice2,raw_keys:e.raw_keys})),
  integrity,
  self_audit:selfAudit
};
await fs.mkdir(OUT.split("/").slice(0,-1).join("/")||".",{recursive:true});
await fs.writeFile(OUT,JSON.stringify(inventory,null,2)+"\n");
console.log(JSON.stringify({category_count:inventory.category_count,event_count:inventory.event_count,market_event_count:inventory.market_event_count,screening_event_count:inventory.screening_event_count,priority_12h_event_count:inventory.priority_12h_event_count,analysis_card_count:inventory.analysis_card_count,failed_category_count:inventory.failed_category_count,empty_category_count:inventory.empty_category_count,metadata_missing_count:inventory.metadata_missing_count,time_parse_missing_count:inventory.time_parse_missing_count,analysis_ready:inventory.analysis_ready,complete:inventory.complete,self_audit_status:inventory.self_audit.status,self_audit_anomalies:inventory.self_audit.anomaly_count,requires_rescan:inventory.self_audit.requires_rescan,digest:inventory.integrity.digest,screening_digest:inventory.integrity.screening_digest},null,2));
if(!inventory.menu_end_verified||!inventory.integrity.event_count_matches_ids||!inventory.integrity.screening_event_count_matches_ids||!inventory.integrity.screening_category_counts_sum||!inventory.integrity.priority_12h_is_subset||!inventory.integrity.analysis_card_count_matches_ids||!inventory.integrity.category_keys_complete||!inventory.integrity.category_card_counts_sum||!inventory.analysis_ready||failed.length||inventory.self_audit.requires_rescan) process.exitCode=2;
