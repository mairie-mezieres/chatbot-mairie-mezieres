# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**chatbot-mairie-mezieres** is the Node.js/Express backend for the MAT PWA. It is deployed on Render.com (free tier — spins down after inactivity). The entire server lives in a single file: `index.js` (~4 100 lines).

## Commands

```bash
npm install          # install dependencies
npm start            # production (node index.js)
npm run dev          # development with auto-reload (nodemon)
```

Node 22.x required (declared in `package.json` → `engines`).

## Architecture

### Single-file server

All logic is in `index.js`. No subdirectories, no route files — everything from Redis helpers to Trello integration to the AI pipeline is defined inline in one file.

### AI pipeline — MEL assistant (`POST /mel`)

Answers are resolved in priority order:

1. **Direct answers** — hardcoded Q&A pairs (`findDirectAnswer`)
2. **Redis cache** — normalized question → cached reply (`mat:mel:cache`)
3. **Mistral AI** — primary LLM (`mistral-small-latest` by default)
4. **Claude Haiku** (`claude-haiku-4-5-20251001`) — fallback if Mistral fails
5. **Static fallback** — directs user to the town hall phone number

The system prompt is built dynamically in `generateMelReply` by combining a base `SYSTEM_PROMPT`, a category-specific block (`buildCategoryPrompt`), and a RAG context block (`buildContext`).

### Persistent storage — Upstash Redis (HTTP REST)

All state is stored in Upstash Redis via HTTP (`redisGet`/`redisSet`/`redisSetex`/`redisDel`). Key namespaces:

| Key | Content |
|-----|---------|
| `mat:subs` | Push notification subscriptions |
| `mat:actus` | News articles |
| `mat:idees` | Citizen ideas + votes |
| `mat:stats` | Usage statistics |
| `mat:signals` | Citizen signals |
| `mat:mel:cache` | MEL answer cache |
| `mat:mel:tree:data` | Custom MEL decision tree (overrides app default) |
| `mat:ia:stats` | AI token usage and cost tracking |
| `mat:sondages` / `mat:sondage:results:{id}` | Polls |
| `mat:docs:temp` / `mat:docs:featured` | Documents |

### External integrations

| Service | Purpose |
|---------|---------|
| Mistral AI | Primary LLM for MEL chat |
| Anthropic Claude Haiku | Fallback LLM |
| Cloudinary | Image upload for citizen signals |
| Trello | Receives signals/bugs/requests as cards |
| Google Calendar (iCal) | Events proxy (`/calendar-proxy`) |
| Open-Meteo | Weather data (`/meteo/commune`) |
| Météo-France | Weather alerts (vigilance) |
| Facebook Messenger | Webhook for page updates |
| Web Push (VAPID) | Push notifications to PWA |
| Upstash | Redis database |

### Admin authentication

`adminAuth` middleware checks the `Authorization: Bearer <password>` header against `ADMIN_PASSWORD` env var. All `/admin/*` routes require it. `POST /admin/login` returns 200/401 for the admin panel login form.

### Rate limiting

Sensitive endpoints use `express-rate-limit` instances: `melLimiter`, `signalLimiter`, `subscribeLimiter`, `adminLoginLimiter`. Adjust these if hitting 429 errors in development.

## Required environment variables

```
PAGE_ACCESS_TOKEN          # Facebook page token
VERIFY_TOKEN               # Facebook webhook verify token
ANTHROPIC_API_KEY          # Claude fallback
MISTRAL_API_KEY            # Primary LLM
GOOGLE_CALENDAR_ICAL       # iCal URL for events
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   # Web Push
UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  # Redis
CLOUDINARY_NAME / CLOUDINARY_KEY / CLOUDINARY_SECRET
TRELLO_KEY / TRELLO_TOKEN
TRELLO_LIST_ID_BUG / TRELLO_LIST_ID_SIG / TRELLO_LIST_ID_DEMANDE
ADMIN_PASSWORD             # Admin panel auth
METEOFRANCE_API_TOKEN      # Weather alerts
```

Optional: `MISTRAL_MODEL`, `MISTRAL_URL`, `OPEN_METEO_LAT`, `OPEN_METEO_LON`, `FACEBOOK_PAGE_ID`, `AUTO_POST_WEATHER_ALERTS`.
