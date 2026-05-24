KICKORA — FRONTEND COLLEGATO A API REALE

Questa versione collega la dashboard a:

GET /api/matches/today

Funzionamento:
- Su Railway carica automaticamente le partite reali da API-Football.
- In locale/file:// resta in demo o puoi premere “Carica partite reali” se servito da server.
- Se l’API dà errore, torna automaticamente ai dati demo.

Requisiti Railway:
API_FOOTBALL_KEY
API_FOOTBALL_BASE=https://v3.football.api-sports.io

Supabase può restare non configurato per ora.
