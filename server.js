import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";

// Cache: default 6 ore. Su Railway puoi cambiarla con CACHE_TTL_MINUTES.
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES || 360);
const cache = new Map();
let apiCallsToday = 0;
let apiCallsDay = new Date().toISOString().slice(0, 10);

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== apiCallsDay) {
    apiCallsDay = today;
    apiCallsToday = 0;
  }
}

function getCacheKey(date) {
  return `fixtures:${date}`;
}

function isCacheValid(entry) {
  if (!entry) return false;
  const ageMs = Date.now() - entry.createdAt;
  return ageMs < CACHE_TTL_MINUTES * 60 * 1000;
}

async function apiFootball(path) {
  if (!API_FOOTBALL_KEY) {
    throw new Error("API_FOOTBALL_KEY non configurata su Railway Variables");
  }

  resetDailyCounterIfNeeded();

  const response = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY
    }
  });

  apiCallsToday += 1;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API-Football error ${response.status}: ${text}`);
  }

  return response.json();
}

function normalizeFixture(row) {
  const fixture = row.fixture || {};
  const league = row.league || {};
  const teams = row.teams || {};
  const goals = row.goals || {};

  return {
    external_id: String(fixture.id),
    comp: league.name || "Competizione",
    country: league.country || "",
    league_id: league.id || null,
    season: league.season || null,
    time: fixture.date ? new Date(fixture.date).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "-",
    date: fixture.date || null,
    home: teams.home?.name || "Casa",
    away: teams.away?.name || "Trasferta",
    home_id: teams.home?.id || null,
    away_id: teams.away?.id || null,
    status: fixture.status?.short || "NS",
    goals_home: goals.home,
    goals_away: goals.away,
    raw: row
  };
}

function bridgeKickoraModel(match) {
  const seed = (match.home.length * 7 + match.away.length * 5 + Number(match.external_id || 0)) % 28;
  const over15 = Math.min(92, 64 + seed);
  const over25 = Math.max(38, over15 - 22);
  const gg = Math.min(76, Math.max(42, over25 + 8));
  const homeProb = 40 + (match.home.length % 18);
  const awayProb = 24 + (match.away.length % 15);
  const drawProb = Math.max(18, 100 - homeProb - awayProb);

  return {
    id: match.external_id,
    comp: match.comp,
    time: match.time,
    home: match.home,
    away: match.away,
    rank: "-",
    formH: "-",
    formA: "-",
    xgH: 1.35,
    xgA: 1.12,
    odds: { h: 0, d: 0, a: 0 },
    p: {
      h: homeProb,
      x: drawProb,
      a: awayProb,
      dc1x: Math.min(92, homeProb + drawProb),
      dcx2: Math.min(88, awayProb + drawProb),
      over05: 92,
      over15,
      over25,
      over35: Math.max(18, over25 - 21),
      u25: Math.max(25, 100 - over25),
      u35: 72,
      gg,
      ng: 100 - gg,
      pt05: 65,
      pt15: 25,
      st05: 74,
      st15: 39,
      btts1: 14,
      btts2: 22,
      corners75: 68,
      corners85: 56,
      u105: 61,
      u115: 73,
      u125: 84,
      cards25: 71,
      cards35: 54,
      u55: 66,
      u65: 78,
      u75: 88
    },
    safe: over15 >= 78 ? "Over 1.5" : "1X prudente",
    segno: "1X",
    over: over15 >= 78 ? "Over 1.5" : "Over 0.5/1.5",
    gg: gg >= 60 ? "GG" : "No Gol leggero",
    value: "Da calcolare con quota reale",
    risk: over15 >= 80 ? "Basso" : over15 >= 68 ? "Medio" : "Alto",
    score: "-"
  };
}

async function saveMatchesToSupabase(normalized) {
  if (!supabase || !normalized.length) return;

  const rows = normalized.map((m) => ({
    external_id: m.external_id,
    comp: m.comp,
    country: m.country,
    match_date: m.date,
    home_team: m.home,
    away_team: m.away,
    status: m.status,
    goals_home: m.goals_home,
    goals_away: m.goals_away,
    raw: m.raw
  }));

  await supabase.from("matches").upsert(rows, { onConflict: "external_id" });
}

app.get("/api/health", (req, res) => {
  resetDailyCounterIfNeeded();
  res.json({
    ok: true,
    provider: "API-Football",
    apiFootballConfigured: Boolean(API_FOOTBALL_KEY),
    supabaseConfigured: Boolean(supabase),
    cacheTtlMinutes: CACHE_TTL_MINUTES,
    apiCallsToday
  });
});

app.get("/api/cache/status", (req, res) => {
  resetDailyCounterIfNeeded();
  const items = Array.from(cache.entries()).map(([key, entry]) => ({
    key,
    count: entry?.matches?.length || 0,
    createdAt: new Date(entry.createdAt).toISOString(),
    valid: isCacheValid(entry),
    expiresAt: new Date(entry.createdAt + CACHE_TTL_MINUTES * 60 * 1000).toISOString()
  }));

  res.json({
    ok: true,
    cacheTtlMinutes: CACHE_TTL_MINUTES,
    apiCallsToday,
    items
  });
});

app.get("/api/cache/clear", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache svuotata" });
});

app.get("/api/matches/today", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const force = req.query.force === "1" || req.query.refresh === "1";
    const key = getCacheKey(date);
    const cached = cache.get(key);

    if (!force && isCacheValid(cached)) {
      return res.json({
        date,
        count: cached.matches.length,
        matches: cached.matches,
        source: "cache",
        apiCallsToday,
        cache: {
          hit: true,
          createdAt: new Date(cached.createdAt).toISOString(),
          expiresAt: new Date(cached.createdAt + CACHE_TTL_MINUTES * 60 * 1000).toISOString()
        }
      });
    }

    const data = await apiFootball(`/fixtures?date=${date}`);
    const normalized = (data.response || []).map(normalizeFixture);
    const matches = normalized.map(bridgeKickoraModel);

    cache.set(key, {
      createdAt: Date.now(),
      matches,
      normalized
    });

    // Non bloccare la risposta se Supabase ha problemi.
    saveMatchesToSupabase(normalized).catch((err) => {
      console.warn("Supabase save skipped:", err.message);
    });

    res.json({
      date,
      count: matches.length,
      matches,
      source: "api-football",
      apiCallsToday,
      cache: {
        hit: false,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CACHE_TTL_MINUTES * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const cached = cache.get(getCacheKey(date));

    if (cached) {
      return res.json({
        date,
        count: cached.matches.length,
        matches: cached.matches,
        source: "stale-cache",
        warning: error.message,
        apiCallsToday
      });
    }

    res.status(500).json({ error: error.message, apiCallsToday });
  }
});

app.post("/api/picks", async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase non configurato");

    const payload = req.body || {};
    const row = {
      match_external_id: String(payload.match_external_id || payload.id || ""),
      match_label: payload.match_label,
      market: payload.market,
      selection: payload.selection,
      probability: payload.probability,
      odds: payload.odds,
      stake: payload.stake || 1,
      status: "pending",
      raw: payload
    };

    const { data, error } = await supabase.from("picks").insert(row).select().single();
    if (error) throw error;

    res.json({ ok: true, pick: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/performance", async (req, res) => {
  try {
    if (!supabase) throw new Error("Supabase non configurato");

    const { data, error } = await supabase.from("picks").select("*");
    if (error) throw error;

    const settled = data.filter((p) => p.status === "won" || p.status === "lost");
    const won = settled.filter((p) => p.status === "won").length;
    const accuracy = settled.length ? Math.round((won / settled.length) * 100) : 0;

    const profit = settled.reduce((sum, p) => {
      const stake = Number(p.stake || 1);
      const odds = Number(p.odds || 0);
      return sum + (p.status === "won" ? stake * Math.max(0, odds - 1) : -stake);
    }, 0);

    const totalStake = settled.reduce((sum, p) => sum + Number(p.stake || 1), 0);
    const roi = totalStake ? Number(((profit / totalStake) * 100).toFixed(1)) : 0;

    res.json({
      total: data.length,
      settled: settled.length,
      won,
      lost: settled.length - won,
      accuracy,
      roi,
      profit: Number(profit.toFixed(2))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Kickora API-Football con cache attivo su http://${HOST}:${PORT}`);
  console.log(`Cache TTL: ${CACHE_TTL_MINUTES} minuti`);
});
