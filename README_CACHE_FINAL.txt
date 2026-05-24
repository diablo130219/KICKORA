KICKORA — VERSIONE FINALE CON CACHE API-FOOTBALL

Questa versione è pronta per GitHub/Railway.

Cosa fa:
- carica partite reali da API-Football
- salva i risultati in cache per 6 ore
- evita di consumare chiamate API a ogni refresh
- mostra source: cache / api-football
- mostra apiCallsToday
- mantiene fallback demo lato frontend

Railway Variables minime:
API_FOOTBALL_KEY=la_tua_chiave
API_FOOTBALL_BASE=https://v3.football.api-sports.io
CACHE_TTL_MINUTES=360
PORT=3000

Supabase può restare non configurato per ora.

Endpoint utili:
GET /api/health
GET /api/matches/today
GET /api/matches/today?force=1   -> forza refresh API
GET /api/cache/status
GET /api/cache/clear

Consumo:
- /api/matches/today usa cache se valida
- ?force=1 consuma una chiamata API
- TTL default: 360 minuti = 6 ore
