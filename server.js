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

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const API_FOOTBALL_KEY  = process.env.API_FOOTBALL_KEY  || null;
const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 360); // 6 ore

const USE_MOCK = !API_FOOTBALL_KEY; // mock automatico se chiave assente

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "623848005";

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML"
      })
    });
    console.log("[Telegram] Messaggio inviato");
  } catch (e) {
    console.warn("[Telegram] Errore invio:", e.message);
  }
}

function buildAlerts(matches) {
  const alerts = [];
  matches.forEach(m => {
    const score = Math.round(Math.max(40, Math.min(92,
      m.p.over15 * 0.45 + m.p.over25 * 0.30 + m.p.gg * 0.15 + Math.max(m.p.h, m.p.a) * 0.10
    )));

    if (m.p.over15 >= 82 && m.p.gg >= 60) {
      alerts.push({ m, tag: "✅ OVER 1.5 SOLIDO", score,
        text: `Over 1.5 all'${m.p.over15}% con GG al ${m.p.gg}%` });
    } else if (m.p.over25 >= 65) {
      alerts.push({ m, tag: "🔥 OVER 2.5 FORTE", score,
        text: `Over 2.5 al ${m.p.over25}% — profilo offensivo elevato` });
    } else if (m.p.gg >= 68 && m.p.over15 >= 78) {
      alerts.push({ m, tag: "⚽ GG CONFERMATO", score,
        text: `GG al ${m.p.gg}% — entrambe a segno molto probabile` });
    } else if (m.p.dc1x >= 80 && m.p.h >= 50) {
      alerts.push({ m, tag: "🛡 DC 1X SICURA", score,
        text: `Doppia Chance 1X all'${m.p.dc1x}%` });
    }
  });
  return alerts.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function sendDailyAlerts() {
  if (!TELEGRAM_TOKEN) return;
  const date    = new Date().toISOString().slice(0, 10);
  const cached  = cache.get(getCacheKey(date));
  const matches = cached?.matches || [];

  if (!matches.length) {
    await sendTelegram("⚠️ <b>Kickora</b> — Nessuna partita caricata per oggi.");
    return;
  }

  const alerts = buildAlerts(matches);

  if (!alerts.length) {
    await sendTelegram(`📊 <b>Kickora Daily</b> — ${date}\nNessun alert forte rilevato oggi.`);
    return;
  }

  let msg = `🎯 <b>Kickora Alert — ${date}</b>\n${matches.length} partite analizzate · ${alerts.length} segnali forti\n\n`;
  alerts.forEach((a, i) => {
    msg += `${i + 1}. <b>${a.m.home} vs ${a.m.away}</b>\n`;
    msg += `   📌 ${a.m.comp} · ${a.m.time}\n`;
    msg += `   ${a.tag}\n`;
    msg += `   ${a.text}\n`;
    msg += `   K-Score: <b>${a.score}</b>\n\n`;
  });
  msg += `🔗 Apri Kickora per l'analisi completa.`;

  await sendTelegram(msg);
}

// Job giornaliero — manda alert ogni mattina alle 09:00
function scheduleDailyJob() {
  const now   = new Date();
  const next  = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[Telegram] Prossimo alert alle 09:00 (tra ${Math.round(msUntil/60000)} minuti)`);
  setTimeout(() => {
    sendDailyAlerts();
    setInterval(sendDailyAlerts, 24 * 60 * 60 * 1000);
  }, msUntil);
}

scheduleDailyJob();
const MIN_INTERVAL_MS     = 10_000;  // minimo 10 sec tra una chiamata e l'altra
const MAX_PER_MINUTE      = 6;       // mai oltre 6 req/min (limite reale: 10)
let lastApiCall           = 0;
let callsThisMinute       = 0;
let minuteWindowStart     = Date.now();

// ─── COUNTER GIORNALIERO ──────────────────────────────────────────────────────
const cache = new Map();
let apiCallsToday = 0;
let apiCallsDay   = new Date().toISOString().slice(0, 10);

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== apiCallsDay) { apiCallsDay = today; apiCallsToday = 0; }
}

function getCacheKey(date) { return `fixtures:${date}`; }
function isCacheValid(entry) {
  return entry && (Date.now() - entry.createdAt) < CACHE_TTL_MINUTES * 60 * 1000;
}

function localDateRome(days = 0) {
  const now  = new Date();
  const rome = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  rome.setDate(rome.getDate() + days);
  const y = rome.getFullYear();
  const m = String(rome.getMonth() + 1).padStart(2, "0");
  const d = String(rome.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function generateMockMatches(date) {
  const fixtures = [
    { id:"m001", comp:"Serie A",       home:"Napoli",           away:"Juventus",         time:"20:45", h:2.10, d:3.20, a:3.50, over25:58, over15:78, gg:62 },
    { id:"m002", comp:"Serie A",       home:"Inter",            away:"Milan",            time:"18:00", h:1.85, d:3.40, a:4.20, over25:65, over15:82, gg:68 },
    { id:"m003", comp:"Premier League",home:"Arsenal",          away:"Chelsea",          time:"17:30", h:2.20, d:3.30, a:3.30, over25:60, over15:80, gg:64 },
    { id:"m004", comp:"Premier League",home:"Manchester City",  away:"Liverpool",        time:"17:30", h:1.75, d:3.60, a:4.50, over25:70, over15:88, gg:72 },
    { id:"m005", comp:"La Liga",       home:"Real Madrid",      away:"Barcelona",        time:"21:00", h:2.00, d:3.50, a:3.60, over25:62, over15:80, gg:66 },
    { id:"m006", comp:"La Liga",       home:"Atletico Madrid",  away:"Sevilla",          time:"19:00", h:1.90, d:3.30, a:4.10, over25:52, over15:74, gg:55 },
    { id:"m007", comp:"Bundesliga",    home:"Bayern Munich",    away:"Borussia Dortmund",time:"18:30", h:1.60, d:4.00, a:5.50, over25:72, over15:88, gg:70 },
    { id:"m008", comp:"Bundesliga",    home:"RB Leipzig",       away:"Leverkusen",       time:"15:30", h:2.30, d:3.20, a:3.10, over25:66, over15:84, gg:68 },
    { id:"m009", comp:"Ligue 1",       home:"PSG",              away:"Marseille",        time:"21:00", h:1.55, d:4.20, a:6.00, over25:68, over15:85, gg:65 },
    { id:"m010", comp:"Ligue 1",       home:"Monaco",           away:"Lyon",             time:"19:00", h:2.10, d:3.30, a:3.40, over25:58, over15:76, gg:60 },
    { id:"m011", comp:"Champions League",home:"Porto",          away:"Benfica",          time:"21:00", h:2.40, d:3.20, a:2.90, over25:60, over15:80, gg:65 },
    { id:"m012", comp:"Champions League",home:"Ajax",           away:"Feyenoord",        time:"18:45", h:1.95, d:3.40, a:3.90, over25:64, over15:82, gg:67 },
    { id:"m013", comp:"Turkey Super League",home:"Galatasaray", away:"Fenerbahce",       time:"20:00", h:2.00, d:3.30, a:3.70, over25:68, over15:86, gg:70 },
    { id:"m014", comp:"Saudi Pro League",home:"Al-Hilal",       away:"Al-Nassr",         time:"19:00", h:1.80, d:3.50, a:4.30, over25:70, over15:87, gg:72 },
    { id:"m015", comp:"Serie B",       home:"Palermo",          away:"Bari",             time:"20:30", h:2.20, d:3.10, a:3.30, over25:52, over15:72, gg:56 },
    { id:"m016", comp:"Serie A",       home:"Fiorentina",       away:"Roma",             time:"15:00", h:2.50, d:3.20, a:2.80, over25:55, over15:76, gg:60 },
    { id:"m017", comp:"Premier League",home:"Tottenham",        away:"Aston Villa",      time:"15:00", h:2.00, d:3.40, a:3.70, over25:62, over15:80, gg:64 },
    { id:"m018", comp:"Eredivisie",    home:"PSV",              away:"Feyenoord",        time:"16:30", h:1.85, d:3.60, a:4.20, over25:66, over15:84, gg:68 },
    { id:"m019", comp:"La Liga",       home:"Villarreal",       away:"Valencia",         time:"17:00", h:2.10, d:3.30, a:3.50, over25:56, over15:75, gg:60 },
    { id:"m020", comp:"Bundesliga",    home:"Wolfsburg",        away:"Freiburg",         time:"15:30", h:2.20, d:3.20, a:3.30, over25:54, over15:74, gg:58 },
  ];

  const forms = [
    ['V,V,N,V,P','V,N,V,P,V'], ['V,V,V,N,V','P,V,N,V,P'], ['N,V,P,V,N','P,N,V,N,P'],
    ['V,P,V,V,N','V,V,V,N,V'], ['V,N,V,V,P','P,P,N,V,P'], ['N,V,N,P,V','N,P,P,V,N'],
    ['V,V,P,N,V','V,N,P,V,N'], ['V,N,V,P,N','P,V,V,N,V'], ['V,V,N,V,V','P,N,V,P,V'],
    ['N,V,V,P,V','V,V,P,N,V'], ['V,P,N,V,V','N,V,V,P,N'], ['V,V,V,P,N','V,N,P,V,V'],
    ['P,V,V,N,V','V,P,N,V,V'], ['V,V,N,P,V','N,V,V,P,N'], ['N,P,V,N,V','V,N,P,V,N'],
    ['V,V,N,V,P','P,V,N,V,P'], ['V,N,P,V,V','N,V,P,V,N'], ['V,V,P,V,N','P,N,V,V,P'],
    ['N,V,V,N,P','V,P,N,V,N'], ['P,V,N,V,N','N,P,V,N,V']
  ];

  return fixtures.map((f, idx) => {
    const hProb  = Math.round((1/f.h)*100);
    const dProb  = Math.round((1/f.d)*100);
    const aProb  = Math.max(0, 100 - hProb - dProb);
    const kscore = Math.round(Math.max(40, Math.min(92,
      f.over15 * 0.45 + f.over25 * 0.30 + f.gg * 0.15 + Math.max(hProb, aProb) * 0.10
    )));
    const risk   = kscore >= 74 ? "Basso" : kscore >= 63 ? "Medio" : "Alto";
    const sign   = hProb >= 54 ? "1" : aProb >= 42 ? "2" : hProb >= aProb + 6 ? "1X" : aProb >= hProb + 4 ? "X2" : "1X";
    const safe   = f.over15 >= 75 ? "Over 1.5" : sign;
    const over   = f.over25 >= 58 ? "Over 2.5" : f.over15 >= 66 ? "Over 1.5" : "Over 0.5/1.5";
    const ggLabel= f.gg >= 62 ? "GG" : f.gg >= 52 ? "GG leggero" : "No Gol leggero";

    return {
      id: f.id,
      comp: f.comp,
      date: `${date}T${f.time}:00+02:00`,
      time: f.time,
      home: f.home,
      away: f.away,
      rank: "-", formH: forms[idx]?.[0] || "V,N,V,P,N", formA: forms[idx]?.[1] || "N,V,P,N,V",
      xgH: 0, xgA: 0, xgSource: "Mock Kickora",
      odds: { h: f.h, d: f.d, a: f.a },
      p: {
        h: hProb, x: dProb, a: aProb,
        dc1x: Math.min(96, hProb + dProb),
        dcx2: Math.min(96, aProb + dProb),
        over05: Math.min(96, f.over15 + 8),
        over15: f.over15, over25: f.over25,
        over35: Math.max(18, f.over25 - 22),
        u25: Math.max(20, 100 - f.over25),
        u35: 72,
        gg: f.gg, ng: 100 - f.gg,
        pt05: null, pt15: null, st05: null, st15: null,
        btts1: null, btts2: null,
        corners75: null, corners85: null,
        u105: null, u115: null, u125: null,
        cards25: null, cards35: null, u55: null, u65: null, u75: null
      },
      safe, segno: sign, over, gg: ggLabel,
      value: "Mock — quota non reale",
      risk, score: kscore,
      isLiveApi: false,
      isMock: true
    };
  });
}

// ─── API-FOOTBALL (attiva solo con chiave) ────────────────────────────────────
async function safeApiFootballCall(path) {
  resetDailyCounterIfNeeded();

  // rispetta intervallo minimo tra chiamate
  const now     = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed);

  // controlla rate al minuto
  if (now - minuteWindowStart > 60_000) {
    minuteWindowStart = Date.now();
    callsThisMinute   = 0;
  }
  if (callsThisMinute >= MAX_PER_MINUTE) {
    const wait = 60_000 - (Date.now() - minuteWindowStart) + 1000;
    console.warn(`[API-Football] Rate limit interno: aspetto ${Math.round(wait/1000)}s`);
    await sleep(wait);
    minuteWindowStart = Date.now();
    callsThisMinute   = 0;
  }

  lastApiCall = Date.now();
  callsThisMinute++;
  apiCallsToday++;

  const res = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY }
  });

  if (res.status === 429) {
    console.warn("[API-Football] 429 ricevuto — aspetto 60s e riprovo 1 volta");
    await sleep(60_000);
    const retry = await fetch(`${API_FOOTBALL_BASE}${path}`, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY }
    });
    apiCallsToday++;
    if (!retry.ok) throw new Error(`API-Football retry fallito: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API-Football error ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

function normalizeApiFootballFixture(row) {
  const fixture = row.fixture || {};
  const league  = row.league  || {};
  const teams   = row.teams   || {};
  const goals   = row.goals   || {};

  const home = teams.home?.name || "Casa";
  const away = teams.away?.name || "Trasferta";

  return {
    id:       String(fixture.id),
    comp:     league.name    || "Competizione",
    date:     fixture.date   || null,
    time:     fixture.date
      ? new Date(fixture.date).toLocaleTimeString("it-IT", { timeZone:"Europe/Rome", hour:"2-digit", minute:"2-digit" })
      : "-",
    home, away,
    rank:  "-", formH: "-", formA: "-",
    xgH:   0,  xgA:   0,  xgSource: "API-Football",
    odds:  { h: 0, d: 0, a: 0 },
    p: {
      h: 40, x: 28, a: 32,
      dc1x: 68, dcx2: 60,
      over05: 88, over15: 72, over25: 52, over35: 30,
      u25: 48, u35: 70,
      gg: 54, ng: 46,
      pt05: null, pt15: null, st05: null, st15: null,
      btts1: null, btts2: null,
      corners75: null, corners85: null,
      u105: null, u115: null, u125: null,
      cards25: null, cards35: null, u55: null, u65: null, u75: null
    },
    safe:  "1X prudente", segno: "1X",
    over:  "Over 1.5", gg: "GG leggero",
    value: "Da valutare con quota reale",
    risk:  "Medio", score: 62,
    isLiveApi: true, isMock: false,
    status:      fixture.status?.short || "NS",
    goals_home:  goals.home,
    goals_away:  goals.away
  };
}

// ─── ENDPOINT: TEST TELEGRAM ──────────────────────────────────────────────────
app.get("/api/telegram/test", async (req, res) => {
  if (!TELEGRAM_TOKEN) return res.json({ ok: false, error: "TELEGRAM_TOKEN non configurato" });
  await sendTelegram("✅ <b>Kickora</b> — Bot Telegram connesso e funzionante!");
  res.json({ ok: true, message: "Messaggio di test inviato su Telegram" });
});

app.get("/api/telegram/send-now", async (req, res) => {
  if (!TELEGRAM_TOKEN) return res.json({ ok: false, error: "TELEGRAM_TOKEN non configurato" });
  await sendDailyAlerts();
  res.json({ ok: true, message: "Alert giornalieri inviati su Telegram" });
});

// ─── ENDPOINT: HEALTH ─────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  resetDailyCounterIfNeeded();
  res.json({
    ok:                   true,
    provider:             USE_MOCK ? "MOCK" : "API-Football",
    useMock:              USE_MOCK,
    telegramConfigured: Boolean(TELEGRAM_TOKEN),
    oddsApiConfigured:    false,
    cacheTtlMinutes:      CACHE_TTL_MINUTES,
    apiCallsToday,
    apiCallsDayLimit:     100
  });
});

// ─── ENDPOINT: CACHE STATUS ───────────────────────────────────────────────────
app.get("/api/cache/status", (req, res) => {
  resetDailyCounterIfNeeded();
  res.json({
    ok: true,
    cacheTtlMinutes: CACHE_TTL_MINUTES,
    apiCallsToday,
    items: Array.from(cache.entries()).map(([key, entry]) => ({
      key,
      count:     entry.matches?.length || 0,
      valid:     isCacheValid(entry),
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + CACHE_TTL_MINUTES * 60 * 1000).toISOString()
    }))
  });
});

app.get("/api/cache/clear", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache svuotata" });
});

// ─── ENDPOINT: MATCHES ────────────────────────────────────────────────────────
app.get("/api/matches/today", async (req, res) => {
  try {
    const date  = req.query.date || localDateRome(0);
    const key   = getCacheKey(date);
    const cached = cache.get(key);

    // sempre usa cache se valida — no force refresh in produzione
    if (isCacheValid(cached)) {
      return res.json({
        date, count: cached.matches.length, matches: cached.matches,
        source: cached.source || "cache", apiCallsToday,
        cache: { hit: true, createdAt: new Date(cached.createdAt).toISOString(),
                 expiresAt: new Date(cached.createdAt + CACHE_TTL_MINUTES * 60 * 1000).toISOString() }
      });
    }

    let matches;
    let source;

    if (USE_MOCK) {
      // ── MODALITÀ MOCK: zero chiamate API ──
      matches = generateMockMatches(date);
      source  = "mock";
      console.log(`[MOCK] Generati ${matches.length} match simulati per ${date}`);
    } else {
      // ── MODALITÀ REALE: API-Football ──
      console.log(`[API-Football] Fetch fixtures per ${date}`);
      const data     = await safeApiFootballCall(`/fixtures?date=${date}`);
      const fixtures = (data.response || []);
      matches        = fixtures.map(normalizeApiFootballFixture);
      source         = "api-football";
      console.log(`[API-Football] ${matches.length} partite ricevute — chiamate oggi: ${apiCallsToday}`);
    }

    cache.set(key, { createdAt: Date.now(), matches, source });

    res.json({
      date, count: matches.length, matches, source, apiCallsToday,
      cache: { hit: false, createdAt: new Date().toISOString(),
               expiresAt: new Date(Date.now() + CACHE_TTL_MINUTES * 60 * 1000).toISOString() }
    });

  } catch (error) {
    // fallback su cache vecchia in caso di errore
    const date   = req.query.date || localDateRome(0);
    const cached = cache.get(getCacheKey(date));
    if (cached) {
      return res.json({
        date, count: cached.matches.length, matches: cached.matches,
        source: "stale-cache", warning: error.message, apiCallsToday
      });
    }
    console.error("[ERRORE]", error.message);
    res.status(500).json({ error: error.message, apiCallsToday });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\nKICKORA in ascolto su http://${HOST}:${PORT}`);
  console.log(`Modalità: ${USE_MOCK ? "⚠️  MOCK (dati simulati)" : "✅  API-Football REALE"}`);
  console.log(`Cache TTL: ${CACHE_TTL_MINUTES} minuti`);
  if (!USE_MOCK) console.log(`Rate limit interno: max ${MAX_PER_MINUTE} req/min, intervallo min ${MIN_INTERVAL_MS/1000}s`);
});
