import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BSD_API_KEY       = process.env.BSD_API_KEY || null;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID || "623848005";
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 360);
const BSD_BASE          = "https://sports.bzzoiro.com/api/v2";
const USE_MOCK          = !BSD_API_KEY;

// ─── CACHE ────────────────────────────────────────────────────────────────────
const cache = new Map();

function getCacheKey(date){ return `bsd:${date}`; }
function isCacheValid(entry){
  return entry && (Date.now() - entry.createdAt) < CACHE_TTL_MINUTES * 60 * 1000;
}

function localDateRome(days = 0){
  const now  = new Date();
  const rome = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  rome.setDate(rome.getDate() + days);
  const y = rome.getFullYear();
  const m = String(rome.getMonth() + 1).padStart(2, "0");
  const d = String(rome.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── BSD API FETCH ─────────────────────────────────────────────────────────────
async function bsdFetch(path){
  const res = await fetch(`${BSD_BASE}${path}`, {
    headers: { "Authorization": `Token ${BSD_API_KEY}` }
  });
  if(!res.ok) throw new Error(`BSD API error ${res.status}: ${path}`);
  return res.json();
}

// ─── NORMALIZZA EVENTO BSD ────────────────────────────────────────────────────
function implied(odd){
  const o = Number(odd || 0);
  if(!o || o <= 1) return 0;
  return Math.round((1/o)*100);
}

function normalizeProbs(h, x, a){
  const sum = h + x + a;
  if(!sum) return { h:40, x:28, a:32 };
  return {
    h: Math.round((h/sum)*100),
    x: Math.round((x/sum)*100),
    a: Math.max(0, 100 - Math.round((h/sum)*100) - Math.round((x/sum)*100))
  };
}

function scoreFromData({ homeProb, drawProb, awayProb, over15, over25, gg }){
  const base      = Math.max(over15, gg, homeProb, awayProb);
  const stability = Math.max(0, 18 - Math.abs(homeProb - awayProb));
  return Math.max(40, Math.min(92, Math.round(base * 0.72 + stability + over25 * 0.12)));
}

function chooseSign({ homeProb, drawProb, awayProb, over25, gg }){
  const open = over25 >= 62 || gg >= 62;
  if(homeProb >= 54 && homeProb >= awayProb + 14) return "1";
  if(awayProb >= 42 && awayProb >= homeProb + 10)  return "2";
  if(drawProb >= 34 && Math.abs(homeProb - awayProb) <= 8 && !open) return "X";
  if(homeProb >= awayProb + 6 && drawProb >= 22)  return "1X";
  if(awayProb >= homeProb + 4 && drawProb >= 22)  return "X2";
  if(open && drawProb <= 28)                        return "12";
  return homeProb >= awayProb ? "1X" : "X2";
}

function normalizeBSDEvent(ev, pred){
  // BSD usa competition invece di league_name
  const compName = ev.competition?.name || ev.league_name || ev.competition_name || ev.tournament_name || "Competizione";

  // Quote da BSD — può usare diversi nomi di campo
  const oddsH = Number(ev.odds_home || ev.home_odds || ev.odd_home || 0);
  const oddsD = Number(ev.odds_draw || ev.draw_odds || ev.odd_draw || 0);
  const oddsA = Number(ev.odds_away || ev.away_odds || ev.odd_away || 0);

  let homeProb, drawProb, awayProb, over15, over25, gg, xgH, xgA;

  if(pred){
    homeProb = Math.round((pred.home_win_prob || pred.home_prob || pred.prob_home || 0) * 100);
    drawProb = Math.round((pred.draw_prob     || pred.prob_draw || 0) * 100);
    awayProb = Math.round((pred.away_win_prob || pred.away_prob || pred.prob_away || 0) * 100);
    over25   = Math.round((pred.over_2_5_prob || pred.over25_prob || 0) * 100);
    over15   = Math.round((pred.over_1_5_prob || pred.over15_prob || (over25 * 1.25) || 0) * 100);
    gg       = Math.round((pred.btts_prob     || pred.gg_prob || 0) * 100);
    xgH      = Number(pred.home_xg || pred.xg_home || 0);
    xgA      = Number(pred.away_xg || pred.xg_away || 0);

    // Normalizza se le prob non sommano a 100
    if(homeProb + drawProb + awayProb > 0){
      const norm = normalizeProbs(homeProb, drawProb, awayProb);
      homeProb = norm.h; drawProb = norm.x; awayProb = norm.a;
    }
  }

  // Fallback alle quote se le prob sono ancora 0
  if(!homeProb && oddsH > 0){
    const hRaw = implied(oddsH);
    const xRaw = implied(oddsD);
    const aRaw = implied(oddsA);
    const norm = normalizeProbs(hRaw, xRaw, aRaw);
    homeProb = norm.h; drawProb = norm.x; awayProb = norm.a;
    if(!over25) over25 = 52;
    if(!over15) over15 = 72;
    if(!gg)     gg     = 54;
  }

  // Ultimo fallback valori di default
  if(!homeProb){ homeProb = 40; drawProb = 28; awayProb = 32; }
  if(!over15)   over15 = 72;
  if(!over25)   over25 = 52;
  if(!gg)       gg     = 54;

  const formH = ev.home_form || ev.home_recent_form || "-";
  const formA = ev.away_form || ev.away_recent_form || "-";

  const injuredHome = (ev.unavailable_players?.home || ev.injuries?.home || []).map(p => p.name || p.player_name || p.player).filter(Boolean);
  const injuredAway = (ev.unavailable_players?.away || ev.injuries?.away || []).map(p => p.name || p.player_name || p.player).filter(Boolean);

  const kscore = scoreFromData({ homeProb, drawProb, awayProb, over15, over25, gg });
  const risk   = kscore >= 74 ? "Basso" : kscore >= 63 ? "Medio" : "Alto";
  const sign   = chooseSign({ homeProb, drawProb, awayProb, over25, gg });
  const safe   = over15 >= 75 ? "Over 1.5" : sign;
  const over   = over25 >= 58 ? "Over 2.5" : over15 >= 66 ? "Over 1.5" : "Over 0.5/1.5";
  const ggLbl  = gg >= 62 ? "GG" : gg >= 52 ? "GG leggero" : "No Gol leggero";

  const time = ev.event_date || ev.date || ev.kickoff
    ? new Date(ev.event_date || ev.date || ev.kickoff).toLocaleTimeString("it-IT", { timeZone:"Europe/Rome", hour:"2-digit", minute:"2-digit" })
    : "-";

  return {
    id:    String(ev.id),
    comp:  compName,
    date:  ev.event_date || ev.date || null,
    time,
    home:  ev.home_team  || ev.home || "Casa",
    away:  ev.away_team  || ev.away || "Trasferta",
    homeId: ev.home_team_id || ev.home_id || 0,
    awayId: ev.away_team_id || ev.away_id || 0,
    rank: "-",
    formH, formA,
    xgH: xgH || 0, xgA: xgA || 0,
    xgSource: pred ? "BSD Predictions" : oddsH > 0 ? "Quote implicite" : "Stima Kickora",
    odds: { h: oddsH, d: oddsD, a: oddsA },
    p: {
      h: homeProb, x: drawProb, a: awayProb,
      dc1x: Math.min(96, homeProb + drawProb),
      dcx2: Math.min(96, awayProb + drawProb),
      over05: Math.min(96, over15 + 8),
      over15, over25,
      over35: Math.max(18, over25 - 22),
      u25:    Math.max(20, 100 - over25),
      u35:    72,
      gg,     ng: Math.max(15, 100 - gg),
      pt05: null, pt15: null, st05: null, st15: null,
      btts1: null, btts2: null,
      corners75: null, corners85: null,
      u105: null, u115: null, u125: null,
      cards25: null, cards35: null, u55: null, u65: null, u75: null
    },
    safe, segno: sign, over, gg: ggLbl,
    value: oddsH > 0 ? `1: ${oddsH} / X: ${oddsD} / 2: ${oddsA}` : "Quote non disponibili",
    risk, score: kscore,
    isLiveApi: true, isMock: false,
    injuredHome, injuredAway,
    status: ev.status || "NS",
    goals_home: ev.home_score ?? ev.score_home ?? null,
    goals_away: ev.away_score ?? ev.score_away ?? null
  };
}

// ─── FETCH PARTITE BSD ────────────────────────────────────────────────────────
async function fetchBSDMatches(date){
  if(!BSD_API_KEY) throw new Error("BSD_API_KEY non configurata");

  let allEvents = [];
  let offset    = 0;
  const limit   = 200;

  // Pagina tutte le partite del giorno
  while(true){
    const data = await bsdFetch(
      `/events/?date_from=${date}&date_to=${date}&status=notstarted&limit=${limit}&offset=${offset}`
    );
    const results = data.results || [];
    allEvents.push(...results);
    if(!data.next || results.length < limit) break;
    offset += limit;
    await sleep(300);
  }

  console.log(`[BSD] ${allEvents.length} partite trovate per ${date}`);

  // Fetch predictions in batch (BSD non ha rate limit)
  const withPreds = await Promise.allSettled(
    allEvents.map(async ev => {
      try {
        const predData = await bsdFetch(`/predictions/?event=${ev.id}`);
        const pred = predData.results?.[0] || null;
        return normalizeBSDEvent(ev, pred);
      } catch {
        return normalizeBSDEvent(ev, null);
      }
    })
  );

  return withPreds
    .filter(r => r.status === "fulfilled")
    .map(r => r.value)
    .filter(m => m.home && m.away);
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function generateMockMatches(date){
  const fixtures = [
    { id:"m001", comp:"Serie A",          home:"Napoli",            away:"Juventus",          time:"20:45", h:2.10, d:3.20, a:3.50, over25:58, over15:78, gg:62, xgH:1.6, xgA:1.2 },
    { id:"m002", comp:"Serie A",          home:"Inter",             away:"Milan",             time:"18:00", h:1.85, d:3.40, a:4.20, over25:65, over15:82, gg:68, xgH:1.8, xgA:1.1 },
    { id:"m003", comp:"Premier League",   home:"Arsenal",           away:"Chelsea",           time:"17:30", h:2.20, d:3.30, a:3.30, over25:60, over15:80, gg:64, xgH:1.5, xgA:1.3 },
    { id:"m004", comp:"Premier League",   home:"Manchester City",   away:"Liverpool",         time:"17:30", h:1.75, d:3.60, a:4.50, over25:70, over15:88, gg:72, xgH:2.1, xgA:1.4 },
    { id:"m005", comp:"La Liga",          home:"Real Madrid",       away:"Barcelona",         time:"21:00", h:2.00, d:3.50, a:3.60, over25:62, over15:80, gg:66, xgH:1.7, xgA:1.5 },
    { id:"m006", comp:"La Liga",          home:"Atletico Madrid",   away:"Sevilla",           time:"19:00", h:1.90, d:3.30, a:4.10, over25:52, over15:74, gg:55, xgH:1.4, xgA:0.9 },
    { id:"m007", comp:"Bundesliga",       home:"Bayern Munich",     away:"Borussia Dortmund", time:"18:30", h:1.60, d:4.00, a:5.50, over25:72, over15:88, gg:70, xgH:2.4, xgA:1.2 },
    { id:"m008", comp:"Bundesliga",       home:"RB Leipzig",        away:"Leverkusen",        time:"15:30", h:2.30, d:3.20, a:3.10, over25:66, over15:84, gg:68, xgH:1.6, xgA:1.5 },
    { id:"m009", comp:"Ligue 1",          home:"PSG",               away:"Marseille",         time:"21:00", h:1.55, d:4.20, a:6.00, over25:68, over15:85, gg:65, xgH:2.2, xgA:1.0 },
    { id:"m010", comp:"Ligue 1",          home:"Monaco",            away:"Lyon",              time:"19:00", h:2.10, d:3.30, a:3.40, over25:58, over15:76, gg:60, xgH:1.5, xgA:1.3 },
    { id:"m011", comp:"Champions League", home:"Porto",             away:"Benfica",           time:"21:00", h:2.40, d:3.20, a:2.90, over25:60, over15:80, gg:65, xgH:1.4, xgA:1.4 },
    { id:"m012", comp:"Champions League", home:"Ajax",              away:"Feyenoord",         time:"18:45", h:1.95, d:3.40, a:3.90, over25:64, over15:82, gg:67, xgH:1.7, xgA:1.3 },
    { id:"m013", comp:"Turkey Super League", home:"Galatasaray",   away:"Fenerbahce",        time:"20:00", h:2.00, d:3.30, a:3.70, over25:68, over15:86, gg:70, xgH:1.8, xgA:1.4 },
    { id:"m014", comp:"Saudi Pro League", home:"Al-Hilal",          away:"Al-Nassr",          time:"19:00", h:1.80, d:3.50, a:4.30, over25:70, over15:87, gg:72, xgH:2.0, xgA:1.3 },
    { id:"m015", comp:"Serie B",          home:"Palermo",           away:"Bari",              time:"20:30", h:2.20, d:3.10, a:3.30, over25:52, over15:72, gg:56, xgH:1.2, xgA:1.1 },
    { id:"m016", comp:"Serie A",          home:"Fiorentina",        away:"Roma",              time:"15:00", h:2.50, d:3.20, a:2.80, over25:55, over15:76, gg:60, xgH:1.3, xgA:1.3 },
    { id:"m017", comp:"Premier League",   home:"Tottenham",         away:"Aston Villa",       time:"15:00", h:2.00, d:3.40, a:3.70, over25:62, over15:80, gg:64, xgH:1.5, xgA:1.2 },
    { id:"m018", comp:"Eredivisie",       home:"PSV",               away:"Feyenoord",         time:"16:30", h:1.85, d:3.60, a:4.20, over25:66, over15:84, gg:68, xgH:1.9, xgA:1.2 },
    { id:"m019", comp:"La Liga",          home:"Villarreal",        away:"Valencia",          time:"17:00", h:2.10, d:3.30, a:3.50, over25:56, over15:75, gg:60, xgH:1.4, xgA:1.2 },
    { id:"m020", comp:"Bundesliga",       home:"Wolfsburg",         away:"Freiburg",          time:"15:30", h:2.20, d:3.20, a:3.30, over25:54, over15:74, gg:58, xgH:1.3, xgA:1.2 },
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

  return fixtures.map((f, idx) => {
    const hProb  = Math.round((1/f.h)*100);
    const dProb  = Math.round((1/f.d)*100);
    const aProb  = Math.max(0, 100 - hProb - dProb);
    const kscore = Math.round(Math.max(40, Math.min(92,
      f.over15 * 0.45 + f.over25 * 0.30 + f.gg * 0.15 + Math.max(hProb, aProb) * 0.10
    )));
    const risk   = kscore >= 74 ? "Basso" : kscore >= 63 ? "Medio" : "Alto";
    const sign   = chooseSign({ homeProb:hProb, drawProb:dProb, awayProb:aProb, over25:f.over25, gg:f.gg });
    const safe   = f.over15 >= 75 ? "Over 1.5" : sign;
    const over   = f.over25 >= 58 ? "Over 2.5" : f.over15 >= 66 ? "Over 1.5" : "Over 0.5/1.5";
    const ggLabel= f.gg >= 62 ? "GG" : f.gg >= 52 ? "GG leggero" : "No Gol leggero";

    return {
      id: f.id, comp: f.comp,
      date: `${date}T${f.time}:00+02:00`, time: f.time,
      home: f.home, away: f.away, homeId: 0, awayId: 0,
      rank: "-", formH: forms[idx]?.[0]||"-", formA: forms[idx]?.[1]||"-",
      xgH: f.xgH, xgA: f.xgA, xgSource: "Mock Kickora",
      odds: { h: f.h, d: f.d, a: f.a },
      p: {
        h:hProb, x:dProb, a:aProb,
        dc1x:Math.min(96,hProb+dProb), dcx2:Math.min(96,aProb+dProb),
        over05:Math.min(96,f.over15+8), over15:f.over15, over25:f.over25,
        over35:Math.max(18,f.over25-22), u25:Math.max(20,100-f.over25), u35:72,
        gg:f.gg, ng:100-f.gg,
        pt05:null,pt15:null,st05:null,st15:null,btts1:null,btts2:null,
        corners75:null,corners85:null,u105:null,u115:null,u125:null,
        cards25:null,cards35:null,u55:null,u65:null,u75:null
      },
      safe, segno:sign, over, gg:ggLabel,
      value:`Demo: 1=${f.h} / X=${f.d} / 2=${f.a}`,
      risk, score:kscore,
      isLiveApi:false, isMock:true,
      injuredHome:[], injuredAway:[],
      status:"NS", goals_home:null, goals_away:null
    };
  });
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg){
  if(!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text:msg, parse_mode:"HTML" })
    });
  } catch(e){ console.warn("[Telegram] Errore:", e.message); }
}

function buildAlerts(matches){
  const alerts = [];
  matches.forEach(m => {
    const score = m.score || 50;
    if(m.p.over15 >= 82 && m.p.gg >= 60)
      alerts.push({ m, tag:"✅ OVER 1.5 SOLIDO", score, text:`Over 1.5 all'${m.p.over15}% con GG al ${m.p.gg}%` });
    else if(m.p.over25 >= 65)
      alerts.push({ m, tag:"🔥 OVER 2.5 FORTE", score, text:`Over 2.5 al ${m.p.over25}%` });
    else if(m.p.gg >= 68 && m.p.over15 >= 78)
      alerts.push({ m, tag:"⚽ GG CONFERMATO", score, text:`GG al ${m.p.gg}%` });
    else if(m.p.dc1x >= 80 && m.p.h >= 50)
      alerts.push({ m, tag:"🛡 DC 1X SICURA", score, text:`DC 1X all'${m.p.dc1x}%` });
  });
  return alerts.sort((a,b)=>b.score-a.score).slice(0,5);
}

async function sendDailyAlerts(){
  if(!TELEGRAM_TOKEN) return;
  const date    = localDateRome(0);
  const cached  = cache.get(getCacheKey(date));
  const matches = cached?.matches || [];
  if(!matches.length){ await sendTelegram("⚠️ <b>Kickora</b> — Nessuna partita caricata per oggi."); return; }
  const alerts = buildAlerts(matches);
  if(!alerts.length){ await sendTelegram(`📊 <b>Kickora Daily</b> — ${date}\nNessun alert forte rilevato oggi.`); return; }
  let msg = `🎯 <b>Kickora Alert — ${date}</b>\n${matches.length} partite analizzate · ${alerts.length} segnali forti\n\n`;
  alerts.forEach((a,i) => {
    msg += `${i+1}. <b>${a.m.home} vs ${a.m.away}</b>\n`;
    msg += `   📌 ${a.m.comp} · ${a.m.time}\n`;
    msg += `   ${a.tag}\n`;
    msg += `   ${a.text}\n`;
    msg += `   K-Score: <b>${a.score}</b>\n\n`;
  });
  msg += `🔗 Apri Kickora per l'analisi completa.`;
  await sendTelegram(msg);
}

function scheduleDailyJob(){
  const now  = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if(next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[Telegram] Prossimo alert alle 09:00 (tra ${Math.round(msUntil/60000)} min)`);
  setTimeout(()=>{ sendDailyAlerts(); setInterval(sendDailyAlerts, 24*60*60*1000); }, msUntil);
}

// ─── AUTO-FETCH ALL'AVVIO ─────────────────────────────────────────────────────
async function autoFetchOnStartup(){
  const date = localDateRome(0);
  const key  = getCacheKey(date);
  console.log(`[Startup] Caricamento partite per ${date}...`);
  try {
    let matches, source;
    if(USE_MOCK){
      matches = generateMockMatches(date);
      source  = "mock";
    } else {
      matches = await fetchBSDMatches(date);
      source  = "bsd";
    }
    cache.set(key, { createdAt:Date.now(), matches, source });
    console.log(`[Startup] ${matches.length} partite in cache ✅ (fonte: ${source})`);
  } catch(e){
    console.warn(`[Startup] Errore: ${e.message}`);
  }
}

app.get("/api/debug/bsd", async (req,res) => {
  if(USE_MOCK) return res.json({ok:false, error:"Modalità mock attiva"});
  try {
    const date = localDateRome(0);
    const data = await bsdFetch(`/events/?date_from=${date}&date_to=${date}&limit=1`);
    const ev   = data.results?.[0] || {};
    // Mostra tutti i campi del primo evento
    res.json({ ok:true, totalCount:data.count, firstEventKeys:Object.keys(ev), firstEvent:ev });
  } catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/api/debug/pred", async (req,res) => {
  if(USE_MOCK) return res.json({ok:false, error:"Modalità mock attiva"});
  try {
    const date = localDateRome(0);
    const data = await bsdFetch(`/events/?date_from=${date}&date_to=${date}&limit=1`);
    const ev   = data.results?.[0];
    if(!ev) return res.json({ok:false, error:"Nessuna partita trovata"});
    const pred = await bsdFetch(`/predictions/?event=${ev.id}`);
    res.json({ ok:true, eventId:ev.id, predictionKeys:Object.keys(pred.results?.[0]||{}), prediction:pred.results?.[0] });
  } catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ─── ENDPOINT: HEALTH ─────────────────────────────────────────────────────────
  res.json({
    ok: true,
    provider:            USE_MOCK ? "MOCK" : "BSD",
    useMock:             USE_MOCK,
    bsdConfigured:       Boolean(BSD_API_KEY),
    telegramConfigured:  Boolean(TELEGRAM_TOKEN),
    cacheTtlMinutes:     CACHE_TTL_MINUTES,
    cacheEntries:        cache.size
  });
});

app.get("/api/cache/status", (req,res) => {
  res.json({
    ok: true, cacheTtlMinutes: CACHE_TTL_MINUTES,
    items: Array.from(cache.entries()).map(([key, entry]) => ({
      key, count:entry.matches?.length||0, valid:isCacheValid(entry),
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + CACHE_TTL_MINUTES*60*1000).toISOString()
    }))
  });
});

app.get("/api/cache/clear", (req,res) => { cache.clear(); res.json({ok:true}); });

app.get("/api/telegram/test", async (req,res) => {
  if(!TELEGRAM_TOKEN) return res.json({ok:false, error:"TELEGRAM_TOKEN non configurato"});
  await sendTelegram("✅ <b>Kickora</b> — Bot Telegram connesso e funzionante!");
  res.json({ok:true, message:"Messaggio di test inviato su Telegram"});
});

app.get("/api/telegram/send-now", async (req,res) => {
  if(!TELEGRAM_TOKEN) return res.json({ok:false, error:"TELEGRAM_TOKEN non configurato"});
  await sendDailyAlerts();
  res.json({ok:true, message:"Alert inviati su Telegram"});
});

app.get("/api/matches/today", async (req,res) => {
  try {
    const date   = req.query.date || localDateRome(0);
    const key    = getCacheKey(date);
    const cached = cache.get(key);

    if(isCacheValid(cached)){
      return res.json({
        date, count:cached.matches.length, matches:cached.matches,
        source:cached.source||"cache",
        cache:{ hit:true, createdAt:new Date(cached.createdAt).toISOString(),
                expiresAt:new Date(cached.createdAt+CACHE_TTL_MINUTES*60*1000).toISOString() }
      });
    }

    let matches, source;
    if(USE_MOCK){
      matches = generateMockMatches(date); source = "mock";
      console.log(`[MOCK] ${matches.length} partite simulate`);
    } else {
      matches = await fetchBSDMatches(date); source = "bsd";
    }

    cache.set(key, { createdAt:Date.now(), matches, source });
    res.json({ date, count:matches.length, matches, source,
               cache:{hit:false, createdAt:new Date().toISOString()} });

  } catch(error){
    const date   = req.query.date || localDateRome(0);
    const cached = cache.get(getCacheKey(date));
    if(cached) return res.json({ date, count:cached.matches.length, matches:cached.matches,
                                 source:"stale-cache", warning:error.message });
    console.error("[ERRORE]", error.message);
    res.status(500).json({ error:error.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\nKICKORA su http://${HOST}:${PORT}`);
  console.log(`Modalità: ${USE_MOCK ? "⚠️  MOCK" : "✅  BSD Free API"}`);
  console.log(`Cache TTL: ${CACHE_TTL_MINUTES} min`);
  setTimeout(autoFetchOnStartup, 3000);
  scheduleDailyJob();
});
