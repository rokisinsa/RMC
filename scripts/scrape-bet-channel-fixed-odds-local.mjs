import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";

const OUT = process.argv[2] || "data/bet-channel-fixed-odds-inventory.json";
const SOURCE_MACHINE = process.env.RMC_SOURCE_MACHINE || (process.platform === "win32" ? "japan_local_windows" : "japan_vps_linux");
const SOURCE_REGION = process.env.RMC_SOURCE_REGION || "JP";
const SOURCE_REGION_EVIDENCE = process.env.RMC_SOURCE_REGION_EVIDENCE || null;
const BASE = "https://bet-channel.com";
const BRAND_ID = "2564963746585911298";
const SEED_ROUTES = ["/esports", "/esports-1", "/"];
const MAX_DISCOVERED_ROUTES = 500;
const routeUrl = r => `${BASE}/fixed-odds?bt-path=${encodeURIComponent(r)}`;

const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const uniq = xs => [...new Set((xs || []).filter(Boolean).map(String))];
const hash = v => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0,20);
const jstIso = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().replace("Z", "+09:00");
const nowMs = Date.now();

function walk(v, fn, path="$", seen=new Set()) {
  if (v == null || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  fn(v,path);
  if (Array.isArray(v)) v.forEach((x,i)=>walk(x,fn,`${path}[${i}]`,seen));
  else Object.entries(v).forEach(([k,x])=>walk(x,fn,`${path}.${k}`,seen));
}
function first(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}
function nestedName(v) {
  if (typeof v === "string") return clean(v);
  if (!v || typeof v !== "object") return "";
  return clean(first(v,["name","title","label","caption","display_name","displayName","short_name","shortName","team_name","teamName","competitor_name","competitorName","participant_name","participantName","value"]) || "");
}
function parseTime(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v > 1e9 ? v*1000 : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const s=String(v).trim();
  if (/^\d{10,13}$/.test(s)) {
    const n=Number(s), ms=s.length===13?n:n*1000;
    return new Date(ms).toISOString();
  }
  const ms=Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function toJst(iso) {
  if(!iso) return null;
  const d=new Date(iso);
  if(!Number.isFinite(d.getTime())) return null;
  return new Date(d.getTime()+9*3600e3).toISOString().replace("Z","+09:00");
}
function getParticipants(o) {
  const directA = first(o,["home_name","homeName","team1_name","team1Name","competitor1_name","competitor1Name","participant1_name","participant1Name","player1_name","player1Name"]);
  const directB = first(o,["away_name","awayName","team2_name","team2Name","competitor2_name","competitor2Name","participant2_name","participant2Name","player2_name","player2Name"]);
  if (directA && directB) return [clean(directA),clean(directB)];
  const home = first(o,["home","team1","competitor1","participant1","player1"]);
  const away = first(o,["away","team2","competitor2","participant2","player2"]);
  if (home && away) {
    const a=nestedName(home), b=nestedName(away);
    if(a&&b) return [a,b];
  }
  for (const key of ["competitors","participants","teams","contestants","players","opponents"]) {
    const arr=o?.[key];
    if(Array.isArray(arr) && arr.length>=2) {
      const a=nestedName(arr[0]), b=nestedName(arr[1]);
      if(a&&b) return [a,b];
    }
  }
  return [null,null];
}
function extractOdds(o) {
  const rows=[];
  const add=(name,odds,bettable=true,id=null,market=null,marketId=null)=>{
    const n=clean(name), x=typeof odds==="number"?odds:Number(odds);
    if(!n || !Number.isFinite(x) || x<=1 || x>10000) return;
    rows.push({
      market:clean(market)||null,
      market_id:marketId==null?null:String(marketId),
      name:n,odds:x,bettable:bettable!==false,id:id==null?null:String(id)
    });
  };
  const childKeys=["selections","outcomes","runners","choices","market_outcomes","marketOutcomes","markets"];
  const seen=new Set();
  const inspect=(v,ctx={market:null,marketId:null})=>{
    if(!v || typeof v!=="object" || seen.has(v)) return;
    seen.add(v);
    if(Array.isArray(v)){ for(const x of v) inspect(x,ctx); return; }
    const hasChildren=childKeys.some(k=>v[k]!=null);
    const explicitMarket=first(v,["market_name","marketName","market_title","marketTitle"]);
    const containerName=hasChildren ? first(v,["name","title","label"]) : null;
    const nextCtx={
      market:clean(explicitMarket??containerName??ctx.market)||null,
      marketId:first(v,["market_id","marketId"])??ctx.marketId
    };
    const name=first(v,["outcome_name","outcomeName","selection_name","selectionName","runner_name","runnerName","name","title","label"]);
    const price=first(v,["odds","decimal_odds","decimalOdds","price","value","coefficient","coef"]);
    const state=first(v,["active","enabled","available","bettable","is_valid_bet","isValidBet"]);
    if(name!=null && price!=null) add(name,price,state!==false,first(v,["id","selection_id","selectionId","outcome_id","outcomeId"]),ctx.market,ctx.marketId);
    for(const k of childKeys) if(v[k]!=null) inspect(v[k],nextCtx);
  };
  inspect(o);
  const uniqRows=[];
  const keys=new Set();
  for(const r of rows){
    const k=`${r.market_id??""}|${r.market??""}|${r.id??""}|${r.name}|${r.odds}`;
    if(keys.has(k)) continue;
    keys.add(k);
    uniqRows.push(r);
  }
  return uniqRows;
}
function sportName(o) {
  const values=[
    first(o,["sport_name","sportName","discipline_name","disciplineName","game_name","gameName","category_name","categoryName"]),
    nestedName(o?.sport), nestedName(o?.discipline), nestedName(o?.game), nestedName(o?.category)
  ].map(clean).filter(Boolean);
  return values[0] || "";
}
function competitionName(o) {
  const values=[
    first(o,["competition_name","competitionName","tournament_name","tournamentName","league_name","leagueName","championship_name","championshipName"]),
    nestedName(o?.competition),nestedName(o?.tournament),nestedName(o?.league),nestedName(o?.championship)
  ].map(clean).filter(Boolean);
  return values[0] || "";
}
const ESPORT_RE = /esport|e-sport|eスポーツ|counter.?strike|\bcs2\b|\bcsgo\b|valorant|dota|league.?of.?legends|\blol\b|rainbow.?six|honor.?of.?kings|king.?of.?glory|world.?of.?tanks|rocket.?league|overwatch|call.?of.?duty|\bpubg\b|mobile.?legends|starcraft|ea.?sports.?fc|esoccer|efootball|ebasketball|nba.?2k|etennis|ebaseball|ecricket|efighting/i;

function eventCandidate(o,sourceUrl,path,routeHint=null) {
  if(!o || typeof o!=="object" || Array.isArray(o)) return null;
  const rawId=first(o,["event_id","eventId","sport_event_id","sportEventId","fixture_id","fixtureId","match_id","matchId","game_id","gameId","event","eventId","_id","id"]);
  if(rawId==null) return null;
  const [a,b]=getParticipants(o);
  if(!a||!b||a===b) return null;
  const sport=sportName(o), competition=competitionName(o);
  const corpus=[sport,competition,clean(first(o,["name","title","event_name","eventName","match_name","matchName"])),a,b,path,sourceUrl,routeHint].join(" ");
  const routeIsEsports=/^\/esports(?:\/|-|$)/i.test(String(routeHint||""));
  if(!routeIsEsports && !ESPORT_RE.test(corpus)) return null;
  const startRaw=first(o,["start_at","startAt","starts_at","startsAt","start_time","startTime","start_ts","startTs","start_date","startDate","scheduled_at","scheduledAt","scheduled","kickoff","kickoff_at","kickoffAt","date","event_date","eventDate","start"]);
  const startUtc=parseTime(startRaw), startAtJst=toJst(startUtc);
  const odds=extractOdds(o);
  const rawStatus=clean(first(o,["status","state","event_status","eventStatus","phase"]));
  const startMs=startUtc?Date.parse(startUtc):NaN;
  const ended=/ended|finished|final|closed|settled|cancel/i.test(rawStatus);
  const startState=ended?"ended":Number.isFinite(startMs)&&startMs<nowMs?"start_time_passed":"future_or_upcoming";
  const title=clean(sport||"eSports");
  return {
    event_id:`fx:${String(rawId)}`,
    raw_event_id:String(rawId),
    category:`eSports:${title}`,
    category_key:`BETBY_ESPORTS:${title}`,
    title,
    competition:competition||null,
    band_name:competition||null,
    start_at_jst:startAtJst,
    status:rawStatus||null,
    side_a:a,
    side_b:b,
    primary_market:true,
    market_class:"primary_h2h",
    price_state:odds.length>=2?"priced":"unpriced",
    start_state:startState,
    market_count:new Set(odds.map(x=>x.market_id??x.market).filter(Boolean)).size,
    market_names:uniq(odds.map(x=>x.market).filter(Boolean)),
    market_choices:odds.map(x=>({market:x.market,market_id:x.market_id,name:x.name,odds:x.odds,bettable:x.bettable,id:x.id})),
    source_url:sourceUrl,
    source_path:path
  };
}
function mergeEvent(prev,next) {
  if(!prev) return next;
  const odds=(next.market_choices?.length||0)>(prev.market_choices?.length||0)?next.market_choices:prev.market_choices;
  return {...prev,...Object.fromEntries(Object.entries(next).filter(([,v])=>v!==null&&v!==""&&!(Array.isArray(v)&&v.length===0))),market_choices:odds};
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:"ja-JP",timezoneId:"Asia/Tokyo"});
const events=new Map(), categoryNames=new Set(), sourceUrls=new Set(), jsonUrls=new Set(), wsUrls=new Set(), errors=[];
let geoBlocked=false, rendererLoaded=false, menuRouteSeen=false, bodyEsportsSeen=false, routeLimitExceeded=false;

function ingestPayload(payload,sourceUrl,kind,routeHint=null) {
  const parsedStrings=new Set();
  const ingestOne=(value,prefix)=>{
    walk(value,(o,path)=>{
      const ev=eventCandidate(o,sourceUrl,`${prefix}:${path}`,routeHint);
      if(ev){ events.set(ev.event_id,mergeEvent(events.get(ev.event_id),ev)); categoryNames.add(ev.category_key); }

      // Some sportsbook feeds wrap business JSON inside string fields.
      for (const v of Object.values(o||{})) {
        if (typeof v!=="string") continue;
        const s=v.trim();
        if (s.length<2 || s.length>5_000_000 || !((s.startsWith("{")&&s.endsWith("}"))||(s.startsWith("[")&&s.endsWith("]")))) continue;
        if(parsedStrings.has(s)) continue;
        parsedStrings.add(s);
        try{ ingestOne(JSON.parse(s),prefix+":embedded"); }catch{}
      }
    });
  };
  try{ ingestOne(payload,kind); }
  catch(e){ errors.push({stage:"ingest",sourceUrl,error:String(e?.message||e)}); }
}
function normalizeBtRoute(href){
  try{
    const u=new URL(href,BASE);
    const raw=u.searchParams.get("bt-path");
    if(!raw) return null;
    const r=decodeURIComponent(raw);
    return r.startsWith("/")?r:`/${r}`;
  }catch{return null;}
}

const discoveredRoutes=new Set(SEED_ROUTES);
const visitedRoutes=new Set();
const queue=[...SEED_ROUTES];

while(queue.length){
  if(discoveredRoutes.size>MAX_DISCOVERED_ROUTES){
    routeLimitExceeded=true;
    errors.push({stage:"menu",error:`discovered route count exceeded safety ceiling ${MAX_DISCOVERED_ROUTES}; refusing to claim completeness`});
    break;
  }
  const route=queue.shift();
  if(visitedRoutes.has(route)) continue;
  visitedRoutes.add(route);
  const url=routeUrl(route);
  sourceUrls.add(url);
  const p=await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.on("response",async resp=>{
    const u=resp.url(), ct=(resp.headers()["content-type"]||"").toLowerCase();
    if(ct.includes("json")){
      try{ const j=await resp.json(); jsonUrls.add(u); ingestPayload(j,u,"json",route); }catch{}
    }
  });
  p.on("websocket",ws=>{
    wsUrls.add(ws.url());
    ws.on("framereceived",ev=>{
      let data=ev.payload;
      if(Buffer.isBuffer(data)) data=data.toString("utf8");
      if(typeof data!=="string" || data.length>5_000_000) return;
      try{ ingestPayload(JSON.parse(data),ws.url(),"ws",route); }catch{
        // Ignore non-JSON protocol frames, but preserve the connection itself as evidence.
      }
    });
  });
  try{
    await p.goto(url,{waitUntil:"domcontentloaded",timeout:45000});
    await p.waitForTimeout(7000);
    let scrollStable=0, scrollExhausted=false;
    const MAX_SCROLL_ROUNDS=240;
    let prevHeight=-1;
    for(let i=0;i<MAX_SCROLL_ROUNDS;i++){
      const before=await p.evaluate(()=>({h:document.documentElement.scrollHeight,y:window.scrollY,vh:window.innerHeight}));
      await p.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
      await p.waitForTimeout(320);
      const after=await p.evaluate(()=>({h:document.documentElement.scrollHeight,y:window.scrollY,vh:window.innerHeight}));
      const atBottom=after.y+after.vh>=after.h-4;
      if(atBottom && after.h===before.h && after.h===prevHeight) scrollStable++;
      else scrollStable=0;
      prevHeight=after.h;
      if(scrollStable>=3){ scrollExhausted=true; break; }
    }
    if(!scrollExhausted){
      errors.push({stage:"scroll",url,route,error:`scroll_end_not_verified_after_${MAX_SCROLL_ROUNDS}_rounds`});
    }
    const body=clean(await p.locator("body").innerText());
    if(/Access is forbidden from your location|forbidden from your location/i.test(body)) geoBlocked=true;

    // DOM fallback: BETBY may normalize network payloads internally. Inspect rendered nodes for
    // event ids / participant labels / timestamps even when raw feed schema is opaque.
    try {
      const domRows=await p.evaluate(()=>{
        const nodes=[...document.querySelectorAll("[data-event-id],[data-eventid],[data-fixture-id],[data-match-id],[data-id]")];
        return nodes.slice(0,5000).map(el=>({
          event_id:el.getAttribute("data-event-id")||el.getAttribute("data-eventid")||el.getAttribute("data-fixture-id")||el.getAttribute("data-match-id")||el.getAttribute("data-id"),
          text:(el.innerText||el.textContent||"").replace(/\s+/g," ").trim(),
          start_at:el.getAttribute("data-start-at")||el.getAttribute("data-start-time")||el.getAttribute("data-timestamp")||null
        })).filter(x=>x.event_id&&x.text);
      });
      for(const row of domRows){
        const parts=row.text.split(/\s+(?:vs\.?|v\.?|—|–|-|対)\s+/i).map(clean).filter(Boolean);
        if(parts.length<2) continue;
        const pseudo={event_id:row.event_id,participants:[{name:parts[0]},{name:parts[1]}],start_at:row.start_at,sport_name:"eSports"};
        const ev=eventCandidate(pseudo,url,"dom:$",route);
        if(ev){ events.set(ev.event_id,mergeEvent(events.get(ev.event_id),ev)); categoryNames.add(ev.category_key); }
      }
    } catch(e) {
      errors.push({stage:"dom_fallback",url,route,error:String(e?.message||e)});
    }
    if(ESPORT_RE.test(body)) bodyEsportsSeen=true;
    const perf=await p.evaluate(()=>performance.getEntriesByType("resource").map(x=>x.name));
    if(perf.some(u=>/bt-renderer\.min\.js/i.test(u))) rendererLoaded=true;
    const rows=await p.evaluate(()=>[...document.querySelectorAll("a[href]")].map(a=>({href:a.href||"",text:(a.textContent||"").replace(/\s+/g," ").trim()})).filter(x=>/bt-path=/i.test(x.href)));
    const insideEsportsTree=/^\/esports(?:\/|-|$)/i.test(route);
    for(const r of rows){
      const child=normalizeBtRoute(r.href);
      if(!child) continue;
      const looksEsports=insideEsportsTree || /^\/esports(?:\/|-|$)/i.test(child) || ESPORT_RE.test(`${r.text} ${child}`);
      if(!looksEsports) continue;
      sourceUrls.add(routeUrl(child));
      menuRouteSeen=true;
      if(r.text) categoryNames.add(`BETBY_ESPORTS:${clean(r.text)}`);
      if(!discoveredRoutes.has(child)){
        discoveredRoutes.add(child);
        queue.push(child);
      }
    }
  }catch(e){ errors.push({stage:"page",url,route,error:String(e?.message||e)}); }
  finally{ await p.close(); }
}
await browser.close();

const allEvents=[...events.values()].sort((a,b)=>(a.start_at_jst||"9999").localeCompare(b.start_at_jst||"9999")||a.event_id.localeCompare(b.event_id));
const activeEvents=allEvents.filter(e=>!["ended","cancelled","postponed"].includes(e.start_state));
const eventIds=uniq(allEvents.map(e=>e.event_id)), screeningIds=uniq(activeEvents.map(e=>e.event_id));
const categoryKeys=uniq([...categoryNames,...allEvents.map(e=>e.category_key)]);
const missingTime=allEvents.filter(e=>!e.start_at_jst), missingParticipants=allEvents.filter(e=>!e.side_a||!e.side_b);
const priceMissing=activeEvents.filter(e=>e.price_state!=="priced");
const priorityIds=activeEvents.filter(e=>{ const t=Date.parse(e.start_at_jst||""); return Number.isFinite(t)&&t>=nowMs&&t<=nowMs+12*3600e3; }).map(e=>e.event_id);

const blockers=[];
if(geoBlocked) blockers.push("geo_blocked");
if(!rendererLoaded) blockers.push("renderer_not_loaded");
if(!bodyEsportsSeen && categoryKeys.length===0) blockers.push("esports_menu_not_observed");
if(!menuRouteSeen && categoryKeys.length===0) blockers.push("menu_end_not_verified");
if(eventIds.length===0) blockers.push("event_feed_empty");
if(screeningIds.length===0) blockers.push("screening_event_empty");
if(missingParticipants.length) blockers.push("participant_metadata_missing");
if(missingTime.length) blockers.push("time_parse_missing");
if(errors.length) blockers.push("route_or_ingest_errors");
if(routeLimitExceeded) blockers.push("route_limit_exceeded");
if(discoveredRoutes.size!==visitedRoutes.size) blockers.push("unvisited_esports_routes");
const menuEndVerified=!geoBlocked && !routeLimitExceeded && discoveredRoutes.size===visitedRoutes.size && (menuRouteSeen||categoryKeys.length>0) && eventIds.length>0;
const complete=blockers.length===0 && menuEndVerified;
const digest=hash([...eventIds].sort().join("|")), screeningDigest=hash([...screeningIds].sort().join("|"));
const analysisIds=uniq(allEvents.filter(e=>e.primary_market).map(e=>"bc-"+hash(`${e.start_at_jst||""}|${[e.side_a,e.side_b].sort().join("||")}`)));

const out={
  schema_version:1,
  checked_at:jstIso(),
  source:"BET CHANNEL fixed-odds / Betby eSports (Japan node)",
  source_machine:SOURCE_MACHINE,
  source_region:SOURCE_REGION,
  source_region_evidence:SOURCE_REGION_EVIDENCE,
  source_urls:[...sourceUrls],
  brand_id:BRAND_ID,
  access_status:geoBlocked?"unavailable":"direct",
  menu_end_verified:menuEndVerified,
  event_feed_detected:eventIds.length>0,
  category_count:categoryKeys.length,
  category_keys:categoryKeys,
  menu_route_count:discoveredRoutes.size,
  menu_routes:[...discoveredRoutes].sort(),
  visited_route_count:visitedRoutes.size,
  visited_routes:[...visitedRoutes].sort(),
  event_count:eventIds.length,
  event_ids:eventIds,
  screening_event_count:screeningIds.length,
  screening_event_ids:screeningIds,
  priority_12h_event_count:priorityIds.length,
  priority_12h_event_ids:priorityIds,
  analysis_card_count:analysisIds.length,
  analysis_card_ids:analysisIds,
  bettable_analysis_card_count:activeEvents.filter(e=>e.price_state==="priced").length,
  unavailable_price_card_count:priceMissing.length,
  failed_category_count:errors.length,
  metadata_missing_count:missingParticipants.length,
  time_parse_missing_count:missingTime.length,
  complete,
  analysis_ready:complete,
  inventory_digest:digest,
  screening_digest:screeningDigest,
  json_hit_urls:[...jsonUrls],
  websocket_urls:[...wsUrls],
  self_audit:{
    status:complete?"pass":"blocked",
    digest:hash(JSON.stringify({digest,screeningDigest,categoryKeys,blockers})),
    anomaly_count:blockers.length,
    blocker_count:blockers.length,
    warning_count:priceMissing.length,
    remediation_status:complete?"not_needed":"required",
    fixes_applied:[],
    checks_run:["japan_access","renderer_loaded","esports_menu_observed","recursive_menu_route_discovery","all_discovered_routes_visited","event_feed_nonzero","event_id_uniqueness","participant_completeness","time_parse","screening_nonzero","menu_end_verified"],
    unresolved_blockers:blockers.length,
    blockers
  },
  integrity:{
    digest,
    screening_digest:screeningDigest,
    event_count_matches_ids:eventIds.length===allEvents.length,
    screening_event_count_matches_ids:screeningIds.length===activeEvents.length,
    category_keys_complete:categoryKeys.length===new Set(categoryKeys).size,
    priority_12h_is_subset:priorityIds.every(id=>screeningIds.includes(id))
  },
  stats:{
    priced_event_count:activeEvents.filter(e=>e.price_state==="priced").length,
    unpriced_event_count:priceMissing.length,
    future_or_upcoming_count:activeEvents.filter(e=>e.start_state==="future_or_upcoming").length,
    start_time_passed_count:activeEvents.filter(e=>e.start_state==="start_time_passed").length,
    primary_h2h_count:allEvents.filter(e=>e.primary_market).length,
    raw_event_count:allEvents.length
  },
  host:{hostname:os.hostname(),platform:process.platform,node:process.version},
  errors,
  events:allEvents
};
await fs.mkdir(OUT.split(/[\\/]/).slice(0,-1).join("/")||".",{recursive:true});
await fs.writeFile(OUT,JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify({ok:complete,out:OUT,checked_at:out.checked_at,access_status:out.access_status,category_count:out.category_count,event_count:out.event_count,screening_event_count:out.screening_event_count,json_hits:out.json_hit_urls.length,websockets:out.websocket_urls.length,blockers},null,2));
if(!complete) process.exit(2);
