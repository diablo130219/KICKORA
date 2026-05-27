import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const API_KEY = process.env.API_FOOTBALL_KEY || null;
const API_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "623848005";
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 360);
const USE_MOCK = !API_KEY;

const cache = new Map();
let apiCallsToday = 0;
let apiCallsDay = new Date().toISOString().slice(0, 10);
let lastApiCall = 0;
const MIN_INTERVAL_MS = 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function resetDailyCounter() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== apiCallsDay) { apiCallsDay = today; apiCallsToday = 0; }
}

function getCacheKey(date) { return "apif:" + date; }
function isCacheValid(entry) { return entry && (Date.now() - entry.createdAt) < CACHE_TTL_MINUTES * 60 * 1000; }

function localDateRome(days) {
  days = days || 0;
  const now = new Date();
  const rome = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  rome.setDate(rome.getDate() + days);
  const y = rome.getFullYear();
  const m = String(rome.getMonth() + 1).padStart(2, "0");
  const d = String(rome.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

async function apiFetch(path) {
  resetDailyCounter();
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed);
  lastApiCall = Date.now();
  apiCallsToday++;
  console.log("[API-Football] #" + apiCallsToday + " " + path);
  const res = await fetch(API_BASE + path, { headers: { "x-apisports-key": API_KEY } });
  if (res.status === 429) throw new Error("Rate limit 429 — aspetta e riprova");
  if (!res.ok) throw new Error("API error " + res.status);
  return res.json();
}

function implied(odd) {
  const o = Number(odd || 0);
  if (!o || o <= 1) return 0;
  return Math.round((1 / o) * 100);
}

function normalizeProbs(h, x, a) {
  const sum = h + x + a;
  if (!sum) return { h: 40, x: 28, a: 32 };
  const hn = Math.round((h / sum) * 100);
  const xn = Math.round((x / sum) * 100);
  return { h: hn, x: xn, a: Math.max(0, 100 - hn - xn) };
}

function scoreFromData(o) {
  const base = Math.max(o.over15, o.gg, o.homeProb, o.awayProb);
  const stab = Math.max(0, 18 - Math.abs(o.homeProb - o.awayProb));
  return Math.max(40, Math.min(92, Math.round(base * 0.72 + stab + o.over25 * 0.12)));
}

function chooseSign(o) {
  const open = o.over25 >= 62 || o.gg >= 62;
  if (o.homeProb >= 54 && o.homeProb >= o.awayProb + 14) return "1";
  if (o.awayProb >= 42 && o.awayProb >= o.homeProb + 10) return "2";
  if (o.drawProb >= 34 && Math.abs(o.homeProb - o.awayProb) <= 8 && !open) return "X";
  if (o.homeProb >= o.awayProb + 6 && o.drawProb >= 22) return "1X";
  if (o.awayProb >= o.homeProb + 4 && o.drawProb >= 22) return "X2";
  if (open && o.drawProb <= 28) return "12";
  return o.homeProb >= o.awayProb ? "1X" : "X2";
}

function normalizeFixture(row) {
  const fixture = row.fixture || {};
  const league = row.league || {};
  const teams = row.teams || {};
  const goals = row.goals || {};
  const odds = row.odds || [];

  // Estrai quote da odds se disponibili
  var oddsH = 0, oddsD = 0, oddsA = 0, over25 = 52, under25 = 48, gg = 54;
  odds.forEach(function(bookmaker) {
    (bookmaker.bets || []).forEach(function(bet) {
      const name = (bet.name || "").toLowerCase();
      if (name === "match winner") {
        (bet.values || []).forEach(function(v) {
          if (v.value === "Home" && !oddsH) oddsH = Number(v.odd || 0);
          if (v.value === "Draw" && !oddsD) oddsD = Number(v.odd || 0);
          if (v.value === "Away" && !oddsA) oddsA = Number(v.odd || 0);
        });
      }
      if (name === "goals over/under") {
        (bet.values || []).forEach(function(v) {
          if (v.value === "Over 2.5") over25 = implied(v.odd);
          if (v.value === "Under 2.5") under25 = implied(v.odd);
        });
      }
      if (name === "both teams score") {
        (bet.values || []).forEach(function(v) {
          if (v.value === "Yes") gg = implied(v.odd);
        });
      }
    });
  });

  var homeProb, drawProb, awayProb;
  if (oddsH > 0) {
    const n = normalizeProbs(implied(oddsH), implied(oddsD), implied(oddsA));
    homeProb = n.h; drawProb = n.x; awayProb = n.a;
  } else {
    homeProb = 40; drawProb = 28; awayProb = 32;
  }

  const over15 = Math.min(97, Math.max(35, over25 + 20));
  const kscore = scoreFromData({ homeProb, drawProb, awayProb, over15, over25, gg });
  const risk = kscore >= 74 ? "Basso" : kscore >= 63 ? "Medio" : "Alto";
  const sign = chooseSign({ homeProb, drawProb, awayProb, over25, gg });
  const safe = over15 >= 75 ? "Over 1.5" : sign;
  const over = over25 >= 58 ? "Over 2.5" : over15 >= 66 ? "Over 1.5" : "Over 0.5/1.5";
  const ggLbl = gg >= 62 ? "GG" : gg >= 52 ? "GG leggero" : "No Gol leggero";

  const dateStr = fixture.date || null;
  const time = dateStr ? new Date(dateStr).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }) : "-";

  return {
    id: String(fixture.id),
    comp: league.name || "Competizione",
    date: dateStr, time: time,
    home: teams.home && teams.home.name || "Casa",
    away: teams.away && teams.away.name || "Trasferta",
    homeId: teams.home && teams.home.id || 0,
    awayId: teams.away && teams.away.id || 0,
    rank: "-", formH: "-", formA: "-",
    xgH: 0, xgA: 0, xgSource: "Quote implicite",
    odds: { h: oddsH, d: oddsD, a: oddsA },
    p: {
      h: homeProb, x: drawProb, a: awayProb,
      dc1x: Math.min(96, homeProb + drawProb),
      dcx2: Math.min(96, awayProb + drawProb),
      over05: Math.min(96, over15 + 8),
      over15: over15, over25: over25,
      over35: Math.max(18, over25 - 22),
      u25: under25, u35: 72,
      gg: gg, ng: Math.max(15, 100 - gg),
      pt05: null, pt15: null, st05: null, st15: null,
      btts1: null, btts2: null,
      corners75: null, corners85: null,
      u105: null, u115: null, u125: null,
      cards25: null, cards35: null, u55: null, u65: null, u75: null
    },
    safe: safe, segno: sign, over: over, gg: ggLbl,
    value: oddsH > 0 ? "1: " + oddsH + " / X: " + oddsD + " / 2: " + oddsA : "Quote non disponibili",
    risk: risk, score: kscore,
    isLiveApi: true, isMock: false,
    injuredHome: [], injuredAway: [],
    status: (fixture.status && fixture.status.short) || "NS",
    goals_home: goals.home || null, goals_away: goals.away || null
  };
}

async function fetchMatches(date) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY non configurata");
  const fixtureData = await apiFetch("/fixtures?date=" + date);
  const fixtures = fixtureData.response || [];
  console.log("[API-Football] " + fixtures.length + " fixture per " + date);
  return fixtures.map(normalizeFixture).filter(function(m) { return m.home && m.away; });
}

// MOCK
function generateMockMatches(date) {
  const fixtures = [
    { id:"m001",comp:"Serie A",home:"Napoli",away:"Juventus",time:"20:45",h:2.10,d:3.20,a:3.50,over25:58,over15:78,gg:62 },
    { id:"m002",comp:"Serie A",home:"Inter",away:"Milan",time:"18:00",h:1.85,d:3.40,a:4.20,over25:65,over15:82,gg:68 },
    { id:"m003",comp:"Premier League",home:"Arsenal",away:"Chelsea",time:"17:30",h:2.20,d:3.30,a:3.30,over25:60,over15:80,gg:64 },
    { id:"m004",comp:"Premier League",home:"Manchester City",away:"Liverpool",time:"17:30",h:1.75,d:3.60,a:4.50,over25:70,over15:88,gg:72 },
    { id:"m005",comp:"La Liga",home:"Real Madrid",away:"Barcelona",time:"21:00",h:2.00,d:3.50,a:3.60,over25:62,over15:80,gg:66 },
    { id:"m006",comp:"La Liga",home:"Atletico Madrid",away:"Sevilla",time:"19:00",h:1.90,d:3.30,a:4.10,over25:52,over15:74,gg:55 },
    { id:"m007",comp:"Bundesliga",home:"Bayern Munich",away:"Borussia Dortmund",time:"18:30",h:1.60,d:4.00,a:5.50,over25:72,over15:88,gg:70 },
    { id:"m008",comp:"Bundesliga",home:"RB Leipzig",away:"Leverkusen",time:"15:30",h:2.30,d:3.20,a:3.10,over25:66,over15:84,gg:68 },
    { id:"m009",comp:"Ligue 1",home:"PSG",away:"Marseille",time:"21:00",h:1.55,d:4.20,a:6.00,over25:68,over15:85,gg:65 },
    { id:"m010",comp:"Ligue 1",home:"Monaco",away:"Lyon",time:"19:00",h:2.10,d:3.30,a:3.40,over25:58,over15:76,gg:60 },
    { id:"m011",comp:"Champions League",home:"Porto",away:"Benfica",time:"21:00",h:2.40,d:3.20,a:2.90,over25:60,over15:80,gg:65 },
    { id:"m012",comp:"Champions League",home:"Ajax",away:"Feyenoord",time:"18:45",h:1.95,d:3.40,a:3.90,over25:64,over15:82,gg:67 },
    { id:"m013",comp:"Turkey Super League",home:"Galatasaray",away:"Fenerbahce",time:"20:00",h:2.00,d:3.30,a:3.70,over25:68,over15:86,gg:70 },
    { id:"m014",comp:"Saudi Pro League",home:"Al-Hilal",away:"Al-Nassr",time:"19:00",h:1.80,d:3.50,a:4.30,over25:70,over15:87,gg:72 },
    { id:"m015",comp:"Serie B",home:"Palermo",away:"Bari",time:"20:30",h:2.20,d:3.10,a:3.30,over25:52,over15:72,gg:56 },
    { id:"m016",comp:"Serie A",home:"Fiorentina",away:"Roma",time:"15:00",h:2.50,d:3.20,a:2.80,over25:55,over15:76,gg:60 },
    { id:"m017",comp:"Premier League",home:"Tottenham",away:"Aston Villa",time:"15:00",h:2.00,d:3.40,a:3.70,over25:62,over15:80,gg:64 },
    { id:"m018",comp:"Eredivisie",home:"PSV",away:"Feyenoord",time:"16:30",h:1.85,d:3.60,a:4.20,over25:66,over15:84,gg:68 },
    { id:"m019",comp:"La Liga",home:"Villarreal",away:"Valencia",time:"17:00",h:2.10,d:3.30,a:3.50,over25:56,over15:75,gg:60 },
    { id:"m020",comp:"Bundesliga",home:"Wolfsburg",away:"Freiburg",time:"15:30",h:2.20,d:3.20,a:3.30,over25:54,over15:74,gg:58 }
  ];
  const forms = [
    ["V,V,N,V,P","V,N,V,P,V"],["V,V,V,N,V","P,V,N,V,P"],["N,V,P,V,N","P,N,V,N,P"],
    ["V,P,V,V,N","V,V,V,N,V"],["V,N,V,V,P","P,P,N,V,P"],["N,V,N,P,V","N,P,P,V,N"],
    ["V,V,P,N,V","V,N,P,V,N"],["V,N,V,P,N","P,V,V,N,V"],["V,V,N,V,V","P,N,V,P,V"],
    ["N,V,V,P,V","V,V,P,N,V"],["V,P,N,V,V","N,V,V,P,N"],["V,V,V,P,N","V,N,P,V,V"],
    ["P,V,V,N,V","V,P,N,V,V"],["V,V,N,P,V","N,V,V,P,N"],["N,P,V,N,V","V,N,P,V,N"],
    ["V,V,N,V,P","P,V,N,V,P"],["V,N,P,V,V","N,V,P,V,N"],["V,V,P,V,N","P,N,V,V,P"],
    ["N,V,V,N,P","V,P,N,V,N"],["P,V,N,V,N","N,P,V,N,V"]
  ];
  return fixtures.map(function(f, idx) {
    const hProb = Math.round((1/f.h)*100);
    const dProb = Math.round((1/f.d)*100);
    const aProb = Math.max(0, 100-hProb-dProb);
    const kscore = Math.round(Math.max(40, Math.min(92, f.over15*0.45+f.over25*0.30+f.gg*0.15+Math.max(hProb,aProb)*0.10)));
    const risk = kscore>=74?"Basso":kscore>=63?"Medio":"Alto";
    const sign = chooseSign({ homeProb:hProb, drawProb:dProb, awayProb:aProb, over25:f.over25, gg:f.gg });
    const safe = f.over15>=75?"Over 1.5":sign;
    const over = f.over25>=58?"Over 2.5":f.over15>=66?"Over 1.5":"Over 0.5/1.5";
    const ggLabel = f.gg>=62?"GG":f.gg>=52?"GG leggero":"No Gol leggero";
    return {
      id:f.id, comp:f.comp, date:date+"T"+f.time+":00+02:00", time:f.time,
      home:f.home, away:f.away, homeId:0, awayId:0,
      rank:"-", formH:(forms[idx]&&forms[idx][0])||"-", formA:(forms[idx]&&forms[idx][1])||"-",
      xgH:0, xgA:0, xgSource:"Mock",
      odds:{h:f.h,d:f.d,a:f.a},
      p:{h:hProb,x:dProb,a:aProb,dc1x:Math.min(96,hProb+dProb),dcx2:Math.min(96,aProb+dProb),
        over05:Math.min(96,f.over15+8),over15:f.over15,over25:f.over25,over35:Math.max(18,f.over25-22),
        u25:Math.max(20,100-f.over25),u35:72,gg:f.gg,ng:100-f.gg,
        pt05:null,pt15:null,st05:null,st15:null,btts1:null,btts2:null,
        corners75:null,corners85:null,u105:null,u115:null,u125:null,
        cards25:null,cards35:null,u55:null,u65:null,u75:null},
      safe:safe,segno:sign,over:over,gg:ggLabel,
      value:"Demo: 1="+f.h+" / X="+f.d+" / 2="+f.a,
      risk:risk,score:kscore,isLiveApi:false,isMock:true,
      injuredHome:[],injuredAway:[],status:"NS",goals_home:null,goals_away:null
    };
  });
}

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch("https://api.telegram.org/bot"+TELEGRAM_TOKEN+"/sendMessage", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:msg,parse_mode:"HTML"})
    });
  } catch(e) { console.warn("[Telegram]", e.message); }
}

function buildAlerts(matches) {
  const alerts = [];
  matches.forEach(function(m) {
    const score = m.score || 50;
    if (m.p.over15>=82&&m.p.gg>=60) alerts.push({m,tag:"✅ OVER 1.5 SOLIDO",score,text:"Over 1.5 all'"+m.p.over15+"% con GG al "+m.p.gg+"%"});
    else if (m.p.over25>=65) alerts.push({m,tag:"🔥 OVER 2.5 FORTE",score,text:"Over 2.5 al "+m.p.over25+"%"});
    else if (m.p.gg>=68&&m.p.over15>=78) alerts.push({m,tag:"⚽ GG CONFERMATO",score,text:"GG al "+m.p.gg+"%"});
    else if (m.p.dc1x>=80&&m.p.h>=50) alerts.push({m,tag:"🛡 DC 1X SICURA",score,text:"DC 1X all'"+m.p.dc1x+"%"});
  });
  return alerts.sort(function(a,b){return b.score-a.score;}).slice(0,5);
}

async function sendDailyAlerts() {
  if (!TELEGRAM_TOKEN) return;
  const date = localDateRome(0);
  const cached = cache.get(getCacheKey(date));
  const matches = (cached&&cached.matches)||[];
  if (!matches.length) { await sendTelegram("⚠️ <b>Kickora</b> — Nessuna partita per oggi."); return; }
  const alerts = buildAlerts(matches);
  if (!alerts.length) { await sendTelegram("<b>Kickora Daily</b> — "+date+"\nNessun alert forte oggi."); return; }
  let msg = "🎯 <b>Kickora Alert — "+date+"</b>\n"+matches.length+" partite · "+alerts.length+" segnali\n\n";
  alerts.forEach(function(a,i) {
    msg+=(i+1)+". <b>"+a.m.home+" vs "+a.m.away+"</b>\n";
    msg+="   📌 "+a.m.comp+" · "+a.m.time+"\n";
    msg+="   "+a.tag+"\n   "+a.text+"\n   K-Score: <b>"+a.score+"</b>\n\n";
  });
  msg+="🔗 Apri Kickora per l'analisi completa.";
  await sendTelegram(msg);
}

function scheduleDailyJob() {
  const now=new Date(), next=new Date();
  next.setHours(9,0,0,0);
  if(next<=now) next.setDate(next.getDate()+1);
  const ms=next-now;
  console.log("[Telegram] Prossimo alert alle 09:00 (tra "+Math.round(ms/60000)+" min)");
  setTimeout(function(){sendDailyAlerts();setInterval(sendDailyAlerts,24*60*60*1000);},ms);
}

async function autoFetchOnStartup() {
  const date=localDateRome(0), key=getCacheKey(date);
  cache.clear();
  console.log("[Startup] Caricamento partite per "+date+"...");
  try {
    let matches, source;
    if(USE_MOCK){matches=generateMockMatches(date);source="mock";}
    else{matches=await fetchMatches(date);source="api-football";}
    cache.set(key,{createdAt:Date.now(),matches,source});
    console.log("[Startup] "+matches.length+" partite in cache ("+source+")");
  } catch(e){console.warn("[Startup] Errore:",e.message);}
}

app.get("/api/health",function(req,res){
  resetDailyCounter();
  res.json({ok:true,provider:USE_MOCK?"MOCK":"API-Football",useMock:USE_MOCK,
    apiFootballConfigured:Boolean(API_KEY),telegramConfigured:Boolean(TELEGRAM_TOKEN),
    cacheTtlMinutes:CACHE_TTL_MINUTES,apiCallsToday,apiCallsDayLimit:100,cacheEntries:cache.size});
});

app.get("/api/cache/status",function(req,res){
  res.json({ok:true,cacheTtlMinutes:CACHE_TTL_MINUTES,apiCallsToday,
    items:Array.from(cache.entries()).map(function(e){return{key:e[0],count:(e[1].matches&&e[1].matches.length)||0,valid:isCacheValid(e[1])};})});
});

app.get("/api/cache/clear",function(req,res){cache.clear();res.json({ok:true});});

app.get("/api/telegram/test",async function(req,res){
  if(!TELEGRAM_TOKEN)return res.json({ok:false,error:"TELEGRAM_TOKEN non configurato"});
  await sendTelegram("✅ <b>Kickora</b> — Bot Telegram connesso!");
  res.json({ok:true});
});

app.get("/api/telegram/send-now",async function(req,res){
  if(!TELEGRAM_TOKEN)return res.json({ok:false,error:"TELEGRAM_TOKEN non configurato"});
  await sendDailyAlerts();
  res.json({ok:true});
});

app.get("/api/matches/today",async function(req,res){
  try{
    const date=req.query.date||localDateRome(0);
    const key=getCacheKey(date);
    const cached=cache.get(key);
    if(isCacheValid(cached)){
      return res.json({date,count:cached.matches.length,matches:cached.matches,source:cached.source||"cache",apiCallsToday,cache:{hit:true}});
    }
    let matches,source;
    if(USE_MOCK){matches=generateMockMatches(date);source="mock";}
    else{matches=await fetchMatches(date);source="api-football";}
    cache.set(key,{createdAt:Date.now(),matches,source});
    res.json({date,count:matches.length,matches,source,apiCallsToday,cache:{hit:false}});
  }catch(error){
    const date=req.query.date||localDateRome(0);
    const cached=cache.get(getCacheKey(date));
    if(cached)return res.json({date,count:cached.matches.length,matches:cached.matches,source:"stale-cache",warning:error.message,apiCallsToday});
    res.status(500).json({error:error.message,apiCallsToday});
  }
});

app.listen(PORT,HOST,function(){
  console.log("\nKICKORA su http://"+HOST+":"+PORT);
  console.log("Modalità: "+(USE_MOCK?"⚠️  MOCK":"✅  API-Football"));
  console.log("Cache TTL: "+CACHE_TTL_MINUTES+" min");
  scheduleDailyJob();
});
