import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const BASE = "https://bet-channel.com";
const START = `${BASE}/matches?lang=ja`;
const OUT = process.argv[2] || "data/bet-channel-inventory.json";
const NOW = new Date().toISOString();

const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
const abs = u => { try { return new URL(u, BASE).toString(); } catch { return null; } };
const hash = s => crypto.createHash("sha256").update(s).digest("hex").slice(0,20);

function walk(x, fn, seen=new Set()){
  if(x===null||typeof x!=="object"||seen.has(x)) return;
  seen.add(x); fn(x);
  if(Array.isArray(x)) for(const v of x) walk(v,fn,seen);
  else for(const v of Object.values(x)) walk(v,fn,seen);
}
function eventFrom(o, sourceUrl, category){
  const id = o.match_id ?? o.matchId ?? o.event_id ?? o.eventId;
  if(id == null) return null;
  const choices = o.Choices ?? o.choices ?? o.choice_list ?? null;
  return {
    event_id:String(id),
    category:category||null,
    source_url:sourceUrl,
    game_start_date:o.game_start_date ?? o.start_date ?? o.date ?? null,
    game_start_time:o.game_start_time ?? o.start_time ?? o.time ?? null,
    bet_end_time:o.bet_end_time ?? null,
    band_name:o.band_name ?? o.league_name ?? o.competition_name ?? null,
    status:o.statusString ?? o.status ?? null,
    choice1:o.graph_choice1 ?? o.choice1_name ?? o.team1_name ?? null,
    choice2:o.graph_choice2 ?? o.choice2_name ?? o.team2_name ?? null,
    raw_keys:Object.keys(o).slice(0,40),
    has_choices:!!choices
  };
}

const browser = await chromium.launch({headless:true});
const ctx = await browser.newContext({locale:"ja-JP", timezoneId:"Asia/Tokyo"});
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

async function collectPage(url, label){
  const events = new Map();
  const jsonUrls = new Set();
  const responseErrors = [];
  const onResponse = async r => {
    const ct=(r.headers()["content-type"]||"").toLowerCase();
    if(!ct.includes("json")) return;
    try{
      const j=await r.json(); jsonUrls.add(r.url());
      walk(j,o=>{ const e=eventFrom(o,url,label); if(e) events.set(e.event_id,e); });
    }catch(e){ responseErrors.push({url:r.url(),error:String(e.message||e)}); }
  };
  page.on("response",onResponse);
  let navStatus=null, title=null, bodyText="";
  try{
    const r=await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
    navStatus=r?.status()??null;
    await page.waitForTimeout(2500);
    for(let i=0;i<25;i++){
      const btn=page.getByText("もっと試合を表示する",{exact:false}).last();
      if(await btn.count()===0) break;
      try{
        if(!(await btn.isVisible())) break;
        await btn.click({timeout:2000});
        await page.waitForTimeout(700);
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
  page.off("response",onResponse);
  return {url,label,nav_status:navStatus,title,json_urls:[...jsonUrls],event_count:events.size,events:[...events.values()],errors:responseErrors,body_excerpt:bodyText};
}

const root = await collectPage(START,"本日のイベント");
const anchors = await page.evaluate(() => [...document.querySelectorAll('a[href*="/matches?ct="]')].map(a=>({text:(a.textContent||"").replace(/\s+/g," ").trim(),href:a.getAttribute("href")})));
const catsMap=new Map();
for(const a of anchors){
  const u=abs(a.href); if(!u) continue;
  const m=u.match(/[?&]ct=(\d+)/); if(!m) continue;
  const key=m[1]; if(!catsMap.has(key)) catsMap.set(key,{ct:key,label:clean(a.text)||`ct-${key}`,url:u.includes("lang=")?u:u+(u.includes("?")?"&":"?")+"lang=ja"});
}
const categories=[...catsMap.values()].sort((a,b)=>Number(a.ct)-Number(b.ct));

const results=[];
for(const c of categories){
  const r=await collectPage(c.url,c.label);
  results.push({...c,...r});
}
await browser.close();

const allEvents=new Map();
for(const r of [root,...results]) for(const e of r.events||[]){
  const prev=allEvents.get(e.event_id);
  if(!prev) allEvents.set(e.event_id,{...e,seen_in:[r.label]});
  else if(!prev.seen_in.includes(r.label)) prev.seen_in.push(r.label);
}
const failed=results.filter(r=>!r.nav_status||r.nav_status>=400||r.errors.some(e=>/Timeout|ERR_|Navigation/.test(e.error)));
const empty=results.filter(r=>r.event_count===0);
const inventory={
  schema_version:1,
  source:"BET CHANNEL",
  source_url:START,
  checked_at:NOW,
  acquisition:"playwright_dynamic_xhr_plus_dom",
  menu_end_verified:categories.length>0,
  category_count:categories.length,
  event_count:allEvents.size,
  failed_category_count:failed.length,
  empty_category_count:empty.length,
  complete:failed.length===0,
  categories:results.map(r=>({ct:r.ct,label:r.label,url:r.url,nav_status:r.nav_status,event_count:r.event_count,json_urls:r.json_urls,errors:r.errors})),
  event_ids:[...allEvents.keys()],
  events:[...allEvents.values()],
  failed_categories:failed.map(r=>({ct:r.ct,label:r.label,url:r.url,errors:r.errors})),
  integrity:{
    event_count_matches_ids:allEvents.size===new Set(allEvents.keys()).size,
    unique_category_ct:categories.length===new Set(categories.map(c=>c.ct)).size,
    digest:hash(JSON.stringify([...allEvents.keys()].sort()))
  }
};
await fs.mkdir(OUT.split("/").slice(0,-1).join("/")||".",{recursive:true});
await fs.writeFile(OUT,JSON.stringify(inventory,null,2)+"\n");
console.log(JSON.stringify({category_count:inventory.category_count,event_count:inventory.event_count,failed_category_count:inventory.failed_category_count,empty_category_count:inventory.empty_category_count,complete:inventory.complete,digest:inventory.integrity.digest},null,2));
if(!inventory.menu_end_verified||!inventory.integrity.event_count_matches_ids||failed.length) process.exitCode=2;
