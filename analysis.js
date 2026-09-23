"use strict";

const USD = String.fromCharCode(36);
const MODEL_VERSION = "5.1";

function clamp(x,min,max){ return Math.max(min,Math.min(max,x)); }
function money(v){ return (v>=0?"+":"") + USD + v.toFixed(2); }
function amount(v){ return USD + v.toFixed(2); }
function byId(id){ return document.getElementById(id); }
function setText(id,value){ const el=byId(id); if(el) el.textContent=value; }

function marketPrior(odds,opposingOdds,strength){
  const q1=1/odds;
  if(opposingOdds){
    const q2=1/opposingOdds;
    return {p:q1/(q1+q2),strength,label:"no-vig市場確率"};
  }
  return {p:clamp(q1,.01,.99),strength,label:"片側オッズ逆算（控除未除去）"};
}

function decayWeight(date,eventDate,halfLifeYears){
  const ms=new Date(eventDate)-new Date(date);
  if(ms<=0) return 0;
  const years=ms/(365.25*24*3600*1000);
  return Math.pow(.5,years/halfLifeYears);
}

const modelFamilies={
  volleyball_set1:{
    name:"バレー｜第1セット専用",
    priorStrength:3.5,
    halfLifeYears:5,
    evidenceScale:1.0,
    focus:"第1セットH2H・直近第1セット成績・セット得点差"
  },
  soccer_firsthalf:{
    name:"サッカー｜前半勝者専用",
    priorStrength:5,
    halfLifeYears:2,
    evidenceScale:.65,
    focus:"前半勝率・前半得失点・先制傾向・開催地"
  },
  soccer_dnb:{
    name:"サッカー｜DNB/非敗戦専用",
    priorStrength:5,
    halfLifeYears:2.5,
    evidenceScale:.85,
    focus:"H2H非敗戦率・HOME/AWAY・得失点差・リーグ差"
  },
  cs2_map1:{
    name:"CS2｜第1マップ専用",
    priorStrength:6,
    halfLifeYears:.75,
    evidenceScale:.55,
    focus:"Map1・Veto・直近マップ勝率・Rating・ロスター"
  },
  cs2_series:{
    name:"CS2｜BO3シリーズ勝者専用",
    priorStrength:8,
    halfLifeYears:.75,
    evidenceScale:.40,
    focus:"両側市場no-vig・VRS/HLTV差・中期勝率・H2H・Veto/マッププール"
  }
};

const probabilityModels={
  italy:{
    family:"volleyball_set1",display:"イタリア",odds:1.23,
    eventDate:"2026-09-23T21:05:00+02:00",
    dated:[
      ["2018-09-21",1],["2015-10-13",1],["2013-09-25",0],["2012-05-08",1],
      ["2011-09-15",1],["2011-09-11",1],["2009-09-10",1],["2007-09-06",1],
      ["1993-07-01",1],["1993-06-01",1],["1982-10-07",1],["1981-09-26",1],
      ["1977-09-26",1],["1971-09-24",1],["1967-10-26",1],["1963-11-02",1],
      ["1962-10-18",0],["1958-09-05",1],["1955-06-24",1]
    ],
    evidence:[
      {s:6,f:0,w:1,label:"今大会イタリア第1セット6勝0敗"},
      {s:3,f:3,w:.75,label:"今大会フィンランド第1セット3勝3敗"}
    ]
  },
  tun:{
    family:"volleyball_set1",display:"チュニジア",odds:1.17,
    eventDate:"2026-09-21T00:00:00+01:00",
    dated:[["2023-09-12",1],["2015-07-25",1]],
    evidence:[]
  },
  cor:{
    family:"soccer_dnb",display:"コリンチャンス",odds:1.11,
    eventDate:"2026-09-21T21:30:00-03:00",
    dated:[
      ["2026-09-15",1],["2026-08-15",1],["2025-08-16",1],["2025-08-09",1],
      ["2025-05-04",1],["2023-06-12",1],["2021-05-30",1]
    ],
    evidence:[]
  },
  cs2:{
    family:"cs2_map1",display:"Bounty Hunters",odds:1.13,
    eventDate:"2026-09-22T00:00:00-03:00",
    dated:[],evidence:[]
  },
  oddik:{
    family:"cs2_series",display:"ODDIK",odds:1.24,opposingOdds:3.80,
    eventDate:"2026-09-24T06:00:00-03:00",
    dated:[],evidence:[]
  },
  lyon:{
    family:"soccer_firsthalf",display:"オリンピック・リヨン",odds:1.12,
    eventDate:"2026-09-23T00:00:00+02:00",
    dated:[],
    evidence:[{s:3,f:0,w:.5,label:"直近公式3試合の前半3勝0敗"}]
  }
};

function bayesEstimate(cfg){
  const fam=modelFamilies[cfg.family];
  const prior=marketPrior(cfg.odds,cfg.opposingOdds,fam.priorStrength);
  let a=prior.p*prior.strength;
  let b=(1-prior.p)*prior.strength;
  let eff=0;

  (cfg.dated||[]).forEach(([date,success])=>{
    const w=decayWeight(date,cfg.eventDate,fam.halfLifeYears);
    if(success) a+=w; else b+=w;
    eff+=w;
  });

  (cfg.evidence||[]).forEach(e=>{
    const ew=e.w*fam.evidenceScale;
    a+=e.s*ew;
    b+=e.f*ew;
    eff+=(e.s+e.f)*ew;
  });

  const mean=a/(a+b);
  const variance=(a*b)/((a+b)*(a+b)*(a+b+1));
  const sd=Math.sqrt(variance);
  return {
    p:mean,
    lo:clamp(mean-1.645*sd,0,1),
    hi:clamp(mean+1.645*sd,0,1),
    eff,
    prior,
    fam
  };
}

const modelEstimates={};

function initProbabilityBoxes(){
  document.querySelectorAll(".probability-box[data-model]").forEach(box=>{
    const key=box.dataset.model;
    const cfg=probabilityModels[key];
    if(!cfg) return;

    const est=bayesEstimate(cfg);
    modelEstimates[key]=est;

    const strong=box.querySelector(".probability-head strong");
    if(strong) strong.textContent=cfg.display+" "+(est.p*100).toFixed(1)+"%";

    let meta=box.querySelector(".model-meta");
    if(!meta){
      meta=document.createElement("div");
      meta.className="model-meta";
      box.appendChild(meta);
    }

    const quality=est.eff>=8?"比較的高い":est.eff>=3?"中程度":"限定的";
    meta.textContent=
      "v"+MODEL_VERSION+"｜"+est.fam.name+
      "｜今回 "+(est.p*100).toFixed(1)+"%"+
      "｜90%不確実性 "+(est.lo*100).toFixed(1)+"〜"+(est.hi*100).toFixed(1)+"%"+
      "｜証拠量 "+est.eff.toFixed(1)+"試合相当｜"+quality;
  });
}

function updateCalibration(){
  const rows=[...document.querySelectorAll(".trade-row[data-locked-prob]")]
    .filter(r=>r.dataset.status==="win"||r.dataset.status==="loss");
  const el=byId("calibrationStatus");
  if(!el) return;

  if(!rows.length){
    el.textContent="精度検証：試合前ロック済み予測の確定分は0件。競技・市場別にBrier / Log Lossを蓄積します。";
    return;
  }

  let brier=0,logloss=0;
  rows.forEach(r=>{
    const p=Number(r.dataset.lockedProb);
    const y=r.dataset.status==="win"?1:0;
    brier+=(p-y)*(p-y);
    logloss+=-(y*Math.log(clamp(p,1e-6,1-1e-6))+(1-y)*Math.log(clamp(1-p,1e-6,1-1e-6)));
  });

  brier/=rows.length;
  logloss/=rows.length;
  el.textContent="精度検証：事前ロック "+rows.length+"件｜Brier "+brier.toFixed(4)+"｜Log Loss "+logloss.toFixed(4)+"｜今後は競技・市場別にも採点";
}

const easySummaries={
  "detail-oddik-procyon":{
    market:"BO3勝者：ODDIK",
    reason:"VRS 109順位差・186pt差、3か月勝率72.2% vs 42.1%、唯一のH2Hを2-0・26-16で勝利。",
    caution:"Procyonは直近5戦4勝1敗。H2Hは1シリーズのみで、Veto未確定・ロスター変更もある。",
    model:"oddik"
  },
  "detail-lyon":{
    market:"前半1X2：リヨン",
    reason:"リヨンの直近3試合は前半3勝0敗・前半12得点1失点。前半の強さが最も直接的な根拠。",
    caution:"公式H2Hがなく、直接対戦サンプルが弱い。市場と直近前半データ中心。",
    model:"lyon"
  },
  "detail-italy":{
    market:"第1セット：イタリア",
    reason:"詳細確認H2Hで第1セット17勝2敗。今大会も準々決勝前までイタリア第1セット6勝0敗。",
    caution:"古いH2Hが多いので、そのまま89.5%とはせず時系列減衰して計算。",
    model:"italy"
  },
  "detail-cs2":{
    market:"第1マップ：Bounty Hunters",
    reason:"ランキング・直近フォーム・RatingがBounty側優位。Map1専用H2Hは事前0件。",
    caution:"CS2はVetoとロスター変動が大きいので、市場確率を強めに残す。",
    model:"cs2"
  },
  "detail-cor":{
    market:"DNB：コリンチャンス",
    reason:"事前H2H7試合で無敗。HOME/AWAYどちらでも優勢で、得失点差も大きい。",
    caution:"DNBは勝率ではなく『負けない確率』。引分は返金として扱う。",
    model:"cor"
  },
  "detail-tun":{
    market:"第1セット：チュニジア",
    reason:"事前H2H2試合とも3-0。第1セットも2戦2勝で、開催国条件もプラス。",
    caution:"H2Hが2試合と少ないため、100%をそのまま今回確率にはしない。",
    model:"tun"
  }
};

function initEasySummaries(){
  document.querySelectorAll(".detail-row").forEach(detail=>{
    const cfg=easySummaries[detail.id];
    if(!cfg || detail.querySelector(".easy-summary")) return;

    const cell=detail.querySelector(".detail-cell");
    const sub=detail.querySelector(".detail-sub");
    const est=modelEstimates[cfg.model];
    const fam=est?est.fam:null;
    if(!cell) return;

    const summary=document.createElement("div");
    summary.className="easy-summary";
    summary.innerHTML=
      '<div class="easy-title">まずここだけ見ればOK</div>'+
      '<div class="easy-grid">'+
      '<div class="easy-item"><span>今回の対象</span><strong>'+cfg.market+'</strong></div>'+
      '<div class="easy-item"><span>今回の事前推定</span><strong class="green">'+(est?(est.p*100).toFixed(1)+"%":"計算中")+'</strong></div>'+
      '<div class="easy-item"><span>一番強い根拠</span><strong>'+cfg.reason+'</strong></div>'+
      '<div class="easy-item"><span>注意点</span><strong class="yellow">'+cfg.caution+'</strong></div>'+
      '<div class="easy-item"><span>使用モデル</span><strong>'+(fam?fam.name:"")+'</strong></div>'+
      '<div class="easy-item"><span>モデルが重視するもの</span><strong>'+(fam?fam.focus:"")+'</strong></div>'+
      '</div>';

    if(sub && sub.nextSibling) cell.insertBefore(summary,sub.nextSibling);
    else cell.insertBefore(summary,cell.firstChild);

    const grid=detail.querySelector(".detail-grid");
    if(grid && !grid.previousElementSibling?.classList?.contains("detail-section-label")){
      const lab=document.createElement("div");
      lab.className="detail-section-label";
      lab.textContent="① 重要データ";
      grid.parentNode.insertBefore(lab,grid);
    }

    const prob=detail.querySelector(".probability-box");
    if(prob && !prob.previousElementSibling?.classList?.contains("detail-section-label")){
      const lab=document.createElement("div");
      lab.className="detail-section-label";
      lab.textContent="② 今回の確率";
      prob.parentNode.insertBefore(lab,prob);
    }

    const h2h=detail.querySelector(".h2h");
    if(h2h && !h2h.previousElementSibling?.classList?.contains("detail-section-label")){
      const lab=document.createElement("div");
      lab.className="detail-section-label";
      lab.textContent="③ H2H集計と全対戦";
      h2h.parentNode.insertBefore(lab,h2h);
    }
  });
}

function addMobileLabels(){
  document.querySelectorAll(".h2h-table").forEach(table=>{
    const rows=[...table.querySelectorAll("tr")];
    if(!rows.length) return;
    const headers=[...rows[0].querySelectorAll("th")].map(th=>th.textContent.trim());
    rows.slice(1).forEach(row=>{
      [...row.children].forEach((cell,i)=>{
        cell.dataset.label=headers[i]||"";
      });
    });
  });
}

function initExpandableRows(rowSelector,detailClass){
  document.querySelectorAll(rowSelector).forEach(row=>{
    row.addEventListener("click",()=>{
      const detail=byId(row.dataset.target);
      if(!detail) return;
      const isOpen=detail.classList.contains("show");
      document.querySelectorAll(detailClass+".show").forEach(d=>d.classList.remove("show"));
      document.querySelectorAll(rowSelector+".opened").forEach(r=>r.classList.remove("opened"));
      if(!isOpen){
        detail.classList.add("show");
        row.classList.add("opened");
      }
    });
  });
}

function sortRows(tbody,rowClass){
  if(!tbody) return [];
  const rows=[...tbody.querySelectorAll(rowClass)];
  rows.sort((a,b)=>b.dataset.ts.localeCompare(a.dataset.ts)).forEach(row=>{
    const detail=byId(row.dataset.target);
    tbody.appendChild(row);
    if(detail) tbody.appendChild(detail);
  });
  return rows;
}

function calculateBasic(rows,fixedStake=null){
  let settledStake=0,settledPayout=0,wins=0,losses=0,openStake=0,openPayout=0,totalStake=0;
  rows.forEach(row=>{
    const status=row.dataset.status;
    const originalStake=Number(row.dataset.stake||0);
    const originalPayout=Number(row.dataset.payout||0);
    const stake=fixedStake!==null ? fixedStake : originalStake;
    const payout=fixedStake!==null
      ? (originalStake>0 ? originalPayout*(fixedStake/originalStake) : 0)
      : originalPayout;

    totalStake+=stake;

    if(status==="win"||status==="loss"){
      settledStake+=stake;
      settledPayout+=payout;
      if(status==="win") wins++;
      else losses++;
    }else if(status==="open"){
      openStake+=stake;
      openPayout+=payout;
    }
  });

  const settledGames=wins+losses;
  return {
    settledStake,
    settledPayout,
    wins,
    losses,
    openStake,
    openPayout,
    simpleProfit:settledPayout-settledStake,
    openProfit:openPayout-openStake,
    settledGames,
    totalStake,
    winRate:settledGames>0?wins/settledGames*100:0
  };
}

function calculateCompound(rows,base=300){
  const target=base*2;
  let balance=base;
  let stock=0;
  let cycles=0;

  [...rows]
    .filter(r=>r.dataset.status==="win"||r.dataset.status==="loss")
    .sort((a,b)=>a.dataset.ts.localeCompare(b.dataset.ts))
    .forEach(r=>{
      if(balance<=0) return;

      if(r.dataset.status==="loss"){
        balance=0;
        return;
      }

      const stake=Number(r.dataset.stake||0);
      const payout=Number(r.dataset.payout||0);
      const multiplier=stake>0?payout/stake:1;
      balance*=multiplier;

      if(balance>=target){
        stock+=(balance-base);
        balance=base;
        cycles++;
      }
    });

  return {balance,stock,cycles,profit:balance-base};
}

const detailToModel={
  "detail-oddik-procyon":"oddik",
  "detail-lyon":"lyon",
  "detail-italy":"italy",
  "detail-cs2":"cs2",
  "detail-cor":"cor",
  "detail-tun":"tun"
};

function calculateQuarterKelly(rows,isTest,base=300){
  let balance=base;
  let bets=0;

  [...rows]
    .filter(r=>r.dataset.status==="win"||r.dataset.status==="loss")
    .sort((a,b)=>a.dataset.ts.localeCompare(b.dataset.ts))
    .forEach(r=>{
      let p=0;
      let odds=0;

      if(isTest){
        p=Number(r.dataset.prob||0);
        odds=Number(r.dataset.odds||0);
      }else{
        const modelKey=detailToModel[r.dataset.target];
        const est=modelEstimates[modelKey];
        p=est?est.p:0;
        const cells=r.querySelectorAll("td");
        odds=Number((cells[5]?.textContent||"").trim()) || Number(probabilityModels[modelKey]?.odds||0);
      }

      if(!(p>0&&p<1&&odds>1)) return;

      const fullKelly=(odds*p-1)/(odds-1);
      const fraction=clamp(fullKelly/4,0,.25);
      if(fraction<=0) return;

      const bet=balance*fraction;
      bets++;
      if(r.dataset.status==="win") balance+=bet*(odds-1);
      else balance-=bet;
    });

  return {balance,bets,profit:balance-base};
}

function renderTradeSummary(rows){
  const b=calculateBasic(rows);
  const c=calculateCompound(rows);
  const k=calculateQuarterKelly(rows,false);

  setText("simpleProfit",money(b.simpleProfit));
  setText("compoundProfit",money(c.profit));
  setText("compoundNote","現在資金 "+amount(c.balance));
  setText("compoundStock",amount(c.stock));
  setText("compoundStockNote","確保済み "+c.cycles+"回");
  setText("quarterKellyProfit",money(k.profit));
  setText("quarterKellyNote","初期"+amount(300)+"・確定"+b.settledGames+"件で自動計算");
  setText("settledStake",amount(b.totalStake));
  setText("record",b.settledGames+"戦 "+b.wins+"勝 "+b.losses+"敗");
  setText("winRate","勝率 "+b.winRate.toFixed(1)+"%");
  setText("allCount","全"+rows.length+"件 / 未確定"+rows.filter(r=>r.dataset.status==="open").length+"件");
  setText("openProfit",money(b.openProfit));
}

function normalizeTestRows(rows){
  const TEST_STAKE=100;
  rows.forEach(row=>{
    const cells=row.querySelectorAll("td");
    const originalStake=Number(row.dataset.stake||0);
    const originalPayout=Number(row.dataset.payout||0);
    const ratio=originalStake>0 ? TEST_STAKE/originalStake : 1;
    const normalizedPayout=originalPayout*ratio;

    row.dataset.stake=String(TEST_STAKE);
    row.dataset.payout=String(normalizedPayout);

    if(cells[6]) cells[6].textContent=amount(TEST_STAKE);

    const status=row.dataset.status;
    if(cells[7]){
      cells[7].textContent=status==="open"
        ? amount(normalizedPayout)+" 予定"
        : amount(normalizedPayout);
    }
    if(cells[8]){
      const profit=normalizedPayout-TEST_STAKE;
      cells[8].textContent=status==="open"
        ? money(profit)+" 予定"
        : money(profit);
      cells[8].className="money "+(status==="open"?"pending":profit>=0?"positive":"negative");
    }
  });
}

function renderTestSummary(rows){
  const TEST_STAKE=100;
  const b=calculateBasic(rows,TEST_STAKE);
  const c=calculateCompound(rows,TEST_STAKE);
  const k=calculateQuarterKelly(rows,true,TEST_STAKE);

  setText("testSimpleProfit",money(b.simpleProfit));
  setText("testCompoundProfit",money(c.profit));
  setText("testCompoundNote","現在資金 "+amount(c.balance));
  setText("testCompoundStock",amount(c.stock));
  setText("testCompoundStockNote","確保済み "+c.cycles+"回");
  setText("testQuarterKellyProfit",money(k.profit));
  setText("testQuarterKellyNote","初期"+amount(TEST_STAKE)+"・確定"+b.settledGames+"件で自動計算");
  setText("testRecord",b.settledGames+"戦 "+b.wins+"勝 "+b.losses+"敗");
  setText("testWinRate","勝率 "+b.winRate.toFixed(1)+"%");
  setText("testAllCount","全"+rows.length+"件 / 未確定"+rows.filter(r=>r.dataset.status==="open").length+"件");
  setText("testSettledStake",amount(b.settledStake));
  setText("testOpenProfit",money(b.openProfit));

  const empty=byId("testEmptyState");
  if(empty) empty.style.display=rows.length?"none":"block";
}

document.addEventListener("DOMContentLoaded",()=>{
  initProbabilityBoxes();
  updateCalibration();
  initEasySummaries();
  addMobileLabels();

  const tradeTbody=document.querySelector("#resultTable tbody");
  const tradeRows=sortRows(tradeTbody,".trade-row");
  initExpandableRows(".trade-row",".detail-row");
  renderTradeSummary(tradeRows);

  const testTbody=document.querySelector("#testResultTable tbody");
  const testRows=sortRows(testTbody,".test-row");
  normalizeTestRows(testRows);
  initExpandableRows(".test-row",".test-detail-row");
  renderTestSummary(testRows);
});
