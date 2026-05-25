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

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com/v4";
const ODDS_REGIONS = process.env.ODDS_REGIONS || "eu";
const ODDS_MARKETS = process.env.ODDS_MARKETS || "h2h,totals";
const ODDS_FORMAT = process.env.ODDS_FORMAT || "decimal";
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 1440);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 1);
const ODDS_REQUEST_DELAY_MS = Number(process.env.ODDS_REQUEST_DELAY_MS || 1200);

const ALL_SOCCER_SPORTS = [
  "soccer_africa_cup_of_nations",
  "soccer_argentina_primera_division",
  "soccer_australia_aleague",
  "soccer_austria_bundesliga",
  "soccer_belgium_first_div",
  "soccer_brazil_campeonato",
  "soccer_brazil_serie_b",
  "soccer_chile_campeonato",
  "soccer_china_superleague",
  "soccer_denmark_superliga",
  "soccer_efl_champ",
  "soccer_england_efl_cup",
  "soccer_england_league1",
  "soccer_england_league2",
  "soccer_epl",
  "soccer_fa_cup",
  "soccer_fifa_world_cup",
  "soccer_fifa_world_cup_qualifiers_europe",
  "soccer_fifa_world_cup_qualifiers_south_america",
  "soccer_fifa_world_cup_womens",
  "soccer_fifa_world_cup_winner",
  "soccer_fifa_club_world_cup",
  "soccer_finland_veikkausliiga",
  "soccer_france_coupe_de_france",
  "soccer_france_ligue_one",
  "soccer_france_ligue_two",
  "soccer_germany_bundesliga",
  "soccer_germany_bundesliga2",
  "soccer_germany_bundesliga_women",
  "soccer_germany_dfb_pokal",
  "soccer_germany_liga3",
  "soccer_greece_super_league",
  "soccer_italy_coppa_italia",
  "soccer_italy_serie_a",
  "soccer_italy_serie_b",
  "soccer_japan_j_league",
  "soccer_korea_kleague1",
  "soccer_league_of_ireland",
  "soccer_mexico_ligamx",
  "soccer_netherlands_eredivisie",
  "soccer_norway_eliteserien",
  "soccer_poland_ekstraklasa",
  "soccer_portugal_primeira_liga",
  "soccer_russia_premier_league",
  "soccer_spain_copa_del_rey",
  "soccer_spain_la_liga",
  "soccer_spain_segunda_division",
  "soccer_saudi_arabia_pro_league",
  "soccer_spl",
  "soccer_sweden_allsvenskan",
  "soccer_sweden_superettan",
  "soccer_switzerland_superleague",
  "soccer_turkey_super_league",
  "soccer_uefa_europa_conference_league",
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_qualification",
  "soccer_uefa_champs_league_women",
  "soccer_uefa_europa_league",
  "soccer_uefa_european_championship",
  "soccer_uefa_euro_qualification",
  "soccer_uefa_nations_league",
  "soccer_concacaf_gold_cup",
  "soccer_concacaf_leagues_cup",
  "soccer_conmebol_copa_america",
  "soccer_conmebol_copa_libertadores",
  "soccer_conmebol_copa_sudamericana",
  "soccer_usa_mls"
];

const cache = new Map();
let apiCallsToday = 0;
let apiCallsDay = new Date().toISOString().slice(0,10);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function resetDailyCounterIfNeeded(){
  const today = new Date().toISOString().slice(0,10);
  if(today !== apiCallsDay){
    apiCallsDay = today;
    apiCallsToday = 0;
  }
}

function localDateRome(days=0){
  const now = new Date();
  const rome = new Date(now.toLocaleString("en-US", { timeZone:"Europe/Rome" }));
  rome.setDate(rome.getDate()+days);
  const y = rome.getFullYear();
  const m = String(rome.getMonth()+1).padStart(2,"0");
  const d = String(rome.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function eventRomeDate(iso){
  if(!iso) return "";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Europe/Rome",
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  }).formatToParts(d);
  const get = t => parts.find(p=>p.type===t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventRomeTime(iso){
  if(!iso) return "-";
  return new Date(iso).toLocaleTimeString("it-IT", {
    timeZone:"Europe/Rome",
    hour:"2-digit",
    minute:"2-digit"
  });
}

function cacheValid(entry){
  return entry && (Date.now() - entry.createdAt) < CACHE_TTL_MINUTES * 60 * 1000;
}

function bestPrice(bookmakers = [], marketKey, outcomeName){
  let best = null;
  for(const bookmaker of bookmakers || []){
    for(const market of bookmaker.markets || []){
      if(market.key !== marketKey) continue;
      for(const outcome of market.outcomes || []){
        const match = String(outcome.name || "").toLowerCase() === String(outcomeName || "").toLowerCase();
        if(match){
          if(!best || Number(outcome.price) > Number(best.price)){
            best = { price:Number(outcome.price), bookmaker:bookmaker.title, point:outcome.point ?? null };
          }
        }
      }
    }
  }
  return best;
}

function bestTotal(bookmakers = [], side="Over", point=2.5){
  let best = null;
  for(const bookmaker of bookmakers || []){
    for(const market of bookmaker.markets || []){
      if(market.key !== "totals") continue;
      for(const outcome of market.outcomes || []){
        if(outcome.name === side && Number(outcome.point) === Number(point)){
          if(!best || Number(outcome.price) > Number(best.price)){
            best = { price:Number(outcome.price), bookmaker:bookmaker.title, point:outcome.point };
          }
        }
      }
    }
  }
  return best;
}

function implied(odd){
  const o = Number(odd || 0);
  if(!o || o <= 1) return 0;
  return Math.round((1/o)*100);
}

function scoreFromOdds({ homeProb, drawProb, awayProb, over15, over25, gg }){
  const base = Math.max(over15, gg, homeProb, awayProb);
  const stability = Math.max(0, 18 - Math.abs(homeProb-awayProb));
  return Math.max(40, Math.min(92, Math.round(base*0.72 + stability + over25*0.12)));
}

function chooseSign({ homeProb, drawProb, awayProb, over25, gg }){
  const spread = Math.abs(homeProb-awayProb);
  const open = over25 >= 62 || gg >= 62;
  if(homeProb >= 54 && homeProb >= awayProb + 14 && homeProb >= drawProb + 10) return "1";
  if(awayProb >= 42 && awayProb >= homeProb + 10 && awayProb >= drawProb + 8) return "2";
  if(drawProb >= 34 && spread <= 8 && !open) return "X";
  if(homeProb >= awayProb + 6 && drawProb >= 22) return "1X";
  if(awayProb >= homeProb + 4 && drawProb >= 22) return "X2";
  if(open && drawProb <= 28) return "12";
  return homeProb >= awayProb ? "1X" : "X2";
}

function normalizeOddsEvent(ev){
  const h2hHome = bestPrice(ev.bookmakers, "h2h", ev.home_team);
  const h2hAway = bestPrice(ev.bookmakers, "h2h", ev.away_team);
  const h2hDraw = bestPrice(ev.bookmakers, "h2h", "Draw");

  const over25Odd = bestTotal(ev.bookmakers, "Over", 2.5);
  const under25Odd = bestTotal(ev.bookmakers, "Under", 2.5);
  const over15Odd = bestTotal(ev.bookmakers, "Over", 1.5);
  const under35Odd = bestTotal(ev.bookmakers, "Under", 3.5);
  const yesBtts = bestPrice(ev.bookmakers, "btts", "Yes");
  const noBtts = bestPrice(ev.bookmakers, "btts", "No");

  const hRaw = implied(h2hHome?.price);
  const xRaw = implied(h2hDraw?.price);
  const aRaw = implied(h2hAway?.price);
  const sum = hRaw + xRaw + aRaw;
  const homeProb = sum ? Math.round((hRaw/sum)*100) : 40;
  const drawProb = sum ? Math.round((xRaw/sum)*100) : 28;
  const awayProb = sum ? Math.max(0, 100-homeProb-drawProb) : 32;

  const over25Imp = implied(over25Odd?.price);
  const over15Imp = over15Odd ? implied(over15Odd.price) : Math.min(92, Math.max(54, over25Imp + 18));
  const under25Imp = implied(under25Odd?.price);
  const under35Imp = implied(under35Odd?.price) || 72;
  const ggImp = yesBtts ? implied(yesBtts.price) : Math.min(78, Math.max(40, over25Imp + 8));
  const ngImp = noBtts ? implied(noBtts.price) : Math.max(22, 100-ggImp);

  const kscore = scoreFromOdds({ homeProb, drawProb, awayProb, over15:over15Imp, over25:over25Imp, gg:ggImp });
  const risk = kscore >= 74 ? "Basso" : kscore >= 63 ? "Medio" : "Alto";
  const sign = chooseSign({ homeProb, drawProb, awayProb, over25:over25Imp, gg:ggImp });

  const safe = over15Imp >= 75 ? "Over 1.5" : sign;
  const over = over25Imp >= 58 ? "Over 2.5" : over15Imp >= 66 ? "Over 1.5" : "Over 0.5/1.5";
  const ggLabel = ggImp >= 62 ? "GG" : ggImp >= 52 ? "GG leggero" : "No Gol leggero";

  return {
    id: ev.id,
    comp: ev.sport_title || ev.sport_key || "Soccer",
    sportKey: ev.sport_key,
    date: ev.commence_time,
    time: eventRomeTime(ev.commence_time),
    home: ev.home_team || "Casa",
    away: ev.away_team || "Trasferta",
    rank: "-",
    formH: "-",
    formA: "-",
    xgH: 0,
    xgA: 0,
    xgSource: "Manuale Kickora",
    odds: {
      h: h2hHome?.price || 0,
      d: h2hDraw?.price || 0,
      a: h2hAway?.price || 0
    },
    p: {
      h: homeProb, x: drawProb, a: awayProb,
      dc1x: Math.min(96, homeProb+drawProb),
      dcx2: Math.min(96, awayProb+drawProb),
      over05: Math.min(96, over15Imp + 8),
      over15: over15Imp || 0,
      over25: over25Imp || 0,
      over35: Math.max(18, (over25Imp || 50)-22),
      u25: under25Imp || Math.max(20, 100-(over25Imp || 50)),
      u35: under35Imp,
      gg: ggImp,
      ng: ngImp,
      pt05: null, pt15:null, st05:null, st15:null, btts1:null, btts2:null,
      corners75:null, corners85:null, u105:null, u115:null, u125:null,
      cards25:null, cards35:null, u55:null, u65:null, u75:null
    },
    safe,
    segno: sign,
    over,
    gg: ggLabel,
    value: "Da valutare con quota reale",
    risk,
    score: kscore,
    isLiveApi: true
  };
}

async function oddsRequestSport(sport){
  resetDailyCounterIfNeeded();

  async function doRequest(){
    const params = new URLSearchParams({
      apiKey: ODDS_API_KEY,
      regions: ODDS_REGIONS,
      markets: ODDS_MARKETS,
      oddsFormat: ODDS_FORMAT,
      dateFormat: "iso"
    });
    const url = `${ODDS_API_BASE}/sports/${sport}/odds?${params.toString()}`;
    const res = await fetch(url);
    apiCallsToday += 1;

    if(res.status === 404) return [];
    if(res.status === 422){
      const text = await res.text();
      console.warn("The Odds API market non supportato", sport, text.slice(0,160));
      return [];
    }
    if(res.status === 429){
      console.warn("The Odds API frequency limit, retry lento", sport);
      await sleep(3500);
      const retry = await fetch(url);
      apiCallsToday += 1;
      if(!retry.ok){
        const text = await retry.text();
        console.warn("The Odds API retry fallito", sport, retry.status, text.slice(0,160));
        return [];
      }
      return retry.json();
    }
    if(!res.ok){
      const text = await res.text();
      console.warn("The Odds API error", sport, res.status, text.slice(0,160));
      return [];
    }
    return res.json();
  }

  const out = await doRequest();
  await sleep(ODDS_REQUEST_DELAY_MS);
  return out;
}

async function fetchAllSoccer(){
  if(!ODDS_API_KEY) throw new Error("ODDS_API_KEY non configurata su Railway Variables");

  const results = [];
  for(let i=0; i<ALL_SOCCER_SPORTS.length; i += MAX_PARALLEL){
    const chunk = ALL_SOCCER_SPORTS.slice(i, i+MAX_PARALLEL);

    const settled = await Promise.allSettled(chunk.map(s => oddsRequestSport(s)));
    settled.forEach((r, idx) => {
      if(r.status === "fulfilled" && Array.isArray(r.value)){
        results.push(...r.value.map(ev => ({...ev, sport_key: chunk[idx]})));
      } else if(r.status === "rejected"){
        console.warn("Sport skipped", chunk[idx], r.reason?.message || r.reason);
      }
    });
  }
  return results;
}

app.get("/api/health", (req,res)=>{
  resetDailyCounterIfNeeded();
  res.json({
    ok:true,
    provider:"The Odds API",
    oddsApiConfigured:Boolean(ODDS_API_KEY),
    apiFootballConfigured:false,
    supabaseConfigured:false,
    cacheTtlMinutes:CACHE_TTL_MINUTES,
    apiCallsToday,
    sportsConfigured:ALL_SOCCER_SPORTS.length,
    markets:ODDS_MARKETS,
    requestDelayMs:ODDS_REQUEST_DELAY_MS,
    maxParallel:MAX_PARALLEL
  });
});

app.get("/api/cache/status", (req,res)=>{
  resetDailyCounterIfNeeded();
  res.json({
    ok:true,
    cacheTtlMinutes:CACHE_TTL_MINUTES,
    apiCallsToday,
    items:Array.from(cache.entries()).map(([key, entry])=>({
      key,
      count:entry.matches?.length || 0,
      valid:cacheValid(entry),
      createdAt:new Date(entry.createdAt).toISOString(),
      expiresAt:new Date(entry.createdAt + CACHE_TTL_MINUTES*60*1000).toISOString()
    }))
  });
});

app.get("/api/cache/clear", (req,res)=>{
  cache.clear();
  res.json({ok:true, message:"Cache svuotata"});
});

app.get("/api/matches/today", async (req,res)=>{
  try{
    const date = req.query.date || localDateRome(0);
    const force = req.query.force === "1" || req.query.refresh === "1";
    const key = `odds:${date}`;
    const cached = cache.get(key);

    if(!force && cacheValid(cached)){
      return res.json({
        date,
        count:cached.matches.length,
        matches:cached.matches,
        source:"cache",
        apiCallsToday,
        cache:{hit:true, createdAt:new Date(cached.createdAt).toISOString()}
      });
    }

    const all = await fetchAllSoccer();
    const filteredEvents = all.filter(ev => eventRomeDate(ev.commence_time) === date);
    const matches = filteredEvents.map(normalizeOddsEvent).filter(m => m.home && m.away);

    cache.set(key, {createdAt:Date.now(), matches});

    res.json({
      date,
      count:matches.length,
      matches,
      source:"the-odds-api",
      apiCallsToday,
      rawEvents:all.length,
      cache:{hit:false, createdAt:new Date().toISOString()}
    });
  }catch(error){
    res.status(500).json({error:error.message, apiCallsToday});
  }
});

app.listen(PORT, HOST, ()=>{
  console.log(`Kickora The Odds API all soccer attivo su http://${HOST}:${PORT}`);
  console.log(`Sports configured: ${ALL_SOCCER_SPORTS.length}`);
  console.log(`Cache TTL: ${CACHE_TTL_MINUTES} min`);
});
