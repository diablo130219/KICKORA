KICKORA — RAILWAY PORT FIX

Questa versione risolve il problema 502 Railway.

Cosa è cambiato:
- server.js ora ascolta su 0.0.0.0
- PORT viene letto da Railway automaticamente
- fallback locale su 8080

IMPORTANTE SU RAILWAY:
Nelle Variables lascia SOLO:

API_FOOTBALL_KEY=la_tua_chiave
API_FOOTBALL_BASE=https://v3.football.api-sports.io
CACHE_TTL_MINUTES=360

ELIMINA:
PORT
SUPABASE_URL se non configurato
SUPABASE_SERVICE_ROLE_KEY se non configurato

Poi:
1. fai commit su GitHub
2. Railway redeploy automatico
3. testa /api/health
