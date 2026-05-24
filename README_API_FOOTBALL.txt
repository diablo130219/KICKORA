KICKORA — API-FOOTBALL FINAL READY

Provider scelto: API-Football.

Da usare su Railway:

Variables:
API_FOOTBALL_KEY=la_tua_chiave
API_FOOTBALL_BASE=https://v3.football.api-sports.io
SUPABASE_URL=la_tua_url_supabase
SUPABASE_SERVICE_ROLE_KEY=la_tua_service_role_key
PORT=3000

Endpoint:
GET /api/health
GET /api/matches/today?date=YYYY-MM-DD
POST /api/picks
GET /api/performance

Setup:
1. Carica questi file su GitHub.
2. Railway > New Project > Deploy from GitHub.
3. Inserisci le Variables.
4. Apri il dominio Railway.
5. Testa /api/health.

Nota:
La connessione API-Football è già pronta.
Il modello percentuali è ancora ponte: nel prossimo step arricchiamo con standings, statistics, odds e risultati finali.
