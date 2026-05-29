/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 */

// ─── Sentry (init avant tout autre require pour instrumenter Express) ─
if (process.env.SENTRY_DSN) {
  require('@sentry/node').init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0,
  });
}

const express   = require("express");
const axios     = require("axios");
const https     = require("https");
const webpush   = require("./lib/webpush");
const rateLimit = require("express-rate-limit");

// Timeout global sur tous les appels axios sortants (8 s)
axios.defaults.timeout = 8000;

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Body parsing : limite stricte par défaut (256 KB) pour les routes JSON
// usuelles (/mel, /push/*, /stats/*, /webhook, etc.). Override 6 MB sur les
// routes qui transportent des photos en base64 (signalement citoyen, ajout
// d'actu admin, création/édition d'entreprise admin).
// Express ne désactive pas strict-routing par défaut : /signal et /signal/
// résolvent au même handler. On normalise donc le slash final pour que
// l'override large ne soit pas contourné par un client mettant un trailing
// slash et reçoive un 413 inattendu.
function _isLargeBodyRoute(p) {
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/signal") return true;
  if (p === "/admin/actus/add") return true;
  if (p === "/admin/entreprises" || p.startsWith("/admin/entreprises/")) return true;
  return false;
}
const _jsonSmall = express.json({ limit: "256kb", verify: (req, res, buf) => { req.rawBody = buf; } });
const _jsonLarge = express.json({ limit: "6mb",   verify: (req, res, buf) => { req.rawBody = buf; } });
app.use((req, res, next) => {
  if (_isLargeBodyRoute(req.path)) return _jsonLarge(req, res, next);
  return _jsonSmall(req, res, next);
});
app.set('trust proxy', 1); // Render est derrière un reverse proxy

// ─── Variables d'environnement (centralisées dans config.js) ──
// Lecture pure de process.env ; testé golden-master — voir test/config.test.js
const {
  PAGE_ACCESS_TOKEN, VERIFY_TOKEN, ANTHROPIC_API_KEY, GOOGLE_CALENDAR_ICAL,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, REDIS_URL, REDIS_TOKEN,
  MISTRAL_API_KEY, MISTRAL_MODEL, MISTRAL_URL,
  TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_BUG, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_DEMANDE, TRELLO_NOTIFY,
  UPSTASH_EMAIL, UPSTASH_API_KEY, UPSTASH_REDIS_DB_ID, ADMIN_PASSWORD,
  MISTRAL_BILLING_URL, MISTRAL_PRICE_IN, MISTRAL_PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, EUR_PER_USD,
  METEOFRANCE_VIGILANCE_URL, METEOFRANCE_API_TOKEN, AUTO_POST_WEATHER_ALERTS, AUTO_POST_MIN_LEVEL, AUTO_PUSH_WEATHER_MIN_LEVEL,
  RESEND_API_KEY, DAILY_STATS_EMAIL, CRON_SECRET, FACEBOOK_PAGE_ID,
  OPEN_METEO_LAT, OPEN_METEO_LON, OPEN_METEO_TZ, WEATHER_CHECK_INTERVAL_MS,
} = require("./config");

if (!ADMIN_PASSWORD) {
  console.warn("⚠️  ADMIN_PASSWORD non défini : tous les endpoints /admin seront refusés (401).");
}


// ─── Cloudinary (upload images) — voir lib/cloudinary.js ─────
const { uploadActuImageToCloudinary, deleteActuImageFromCloudinary } = require("./lib/cloudinary");

// ─── Logs diagnostiques + adminAuth — voir lib/middleware.js ──
const { dlog, adminAuth } = require("./lib/middleware");
const { resolveFacebookPageId } = require("./lib/facebook");
const { logServerError } = require("./lib/logger");
const { pctTrend, calcIaCost, trackIaTokens, computeIaCategoryTrends } = require("./lib/stats");
const { publishActuToFacebook, sendActuPush } = require("./lib/actu");
const { getGoogleCalendarClient, upsertGoogleCalendarEvent } = require("./lib/calendar");
const { getCachedMeteoForecast, fetchMeteoFranceVigilanceRaw, extractDepartmentVigilance, sendWeatherPush, publishWeatherAlertToFacebook, isSameWeatherAlert, VIGILANCE_COLORS, VIGILANCE_PHENOMENA } = require("./lib/meteo");

// ─── Web Push VAPID — voir lib/webpush.js ─────────────────────

// ─── Stockage persistant Upstash Redis ───────────────────────
// Client HTTP Upstash — voir lib/redis.js
const { redisGet, redisSet, redisSetex, redisDel, redisPipeline, redisLRange, getUpstashRedisStats, _isRedis429, _setRedis429 } = require("./lib/redis");

// ─── Cache mémoire & store Redis ──────────────────────────────
// Accesseurs read/write pour toutes les clés mat:* — voir lib/store.js
const { MEM_TTL_SHORT, MEM_TTL_LONG, memGet, memSet, memDel, readSubs, writeSubs, readDechetsSubs, writeDechetsSubs, readMeteoSubs, writeMeteoSubs, purgeEndpointsEverywhere, recordPushHistory, readNews, writeNews, readIdeas, writeIdeas, readStats, writeStats, readSignals, writeSignals, readLastWeatherAlert, writeLastWeatherAlert, readMeteoCache, writeMeteoCache, readSeenPosts, writeSeenPosts, readMelCache, writeMelCache, readIaStats, writeIaStats, readTempDocs, writeTempDocs, readSondages, writeSondages, readSondageResults, writeSondageResults, readFeaturedDoc, writeFeaturedDoc, readEntreprises, writeEntreprises, initEntreprisesIfEmpty, readMelTreeConfig, writeMelTreeConfig, getDefaultAdminSettings, readAdminSettings, writeAdminSettings, flushStatsNow } = require("./lib/store");


// ─── CORS ─────────────────────────────────────────────────────
const ADMIN_ALLOWED_ORIGINS = new Set([
  "https://mairie-mezieres.github.io",
  "https://mezieres-lez-clery.fr",
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (req.path.startsWith("/admin")) {
    if (ADMIN_ALLOWED_ORIGINS.has(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token, x-device-id");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

const {
  remiCache, calendarCache, CACHE_MS,
  refreshCalendarCache, refreshRemiCache,
  flushMelQuotas
} = require("./lib/mel");
const { _isFerieDate } = require("./lib/dates");



// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// ROUTES ADMIN (authentifiées)
// ═══════════════════════════════════════════════════════════════

// Capture des erreurs Node.js non gérées → logs admin
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err.message);
  logServerError('uncaughtException', err.message, err.stack?.slice(0, 100));
  if (process.env.SENTRY_DSN) require('@sentry/node').captureException(err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 unhandledRejection:', msg);
  logServerError('unhandledRejection', msg);
  if (process.env.SENTRY_DSN) require('@sentry/node').captureException(reason instanceof Error ? reason : new Error(msg));
});

// ── Stats globales ────────────────────────────────────────────
// ── Admin dashboard — voir routes/admin-dashboard.js ────────
app.use(require("./routes/admin-dashboard"));

// ── Signalements + Trello — voir routes/signalements.js ──────
// (admin/signals GET + DELETE inclus dans le router)

// ── Encart info/alerte (public) ─────────────────────────────
// ── Banderole info + overlay migration — voir routes/info-banner.js ──
app.use(require("./routes/info-banner"));



// ── Route : visiteurs uniques// ── Route : visiteurs uniques ─────────────────────────────────────────────────
// Exposé via /admin/dashboard dans le champ app.uniqueUsers



// ── Chat MEL IA — voir routes/mel.js ────────────────────────
app.use(require("./routes/mel"));

// ── Signalements citoyens + Trello — voir routes/signalements.js ──
app.use(require("./routes/signalements"));

// ── Suivi public des signalements via Trello ──────────────────
function _anonymize(text) {
  if (!text) return '';
  let t = text
    .replace(/\n+📱[^\n]*/g, '')
    .replace(/\n+🏷️[^\n]*/g, '')
    .replace(/\n+Appareil\s*:[^\n]*/g, '')
    .replace(/\n+Modèle\s*:[^\n]*/g, '')
    .replace(/\n+OS\s*:[^\n]*/g, '')
    .replace(/\n+Navigateur\s*:[^\n]*/g, '')
    .replace(/\n+Écran\s*:[^\n]*/g, '')
    .replace(/\n+PWA\s*:[^\n]*/g, '')
    .replace(/\n+MAT\s*:[^\n]*/g, '')
    .replace(/\n+Description\s*:\n*/g, '\n')
    .trim();
  return t
    .replace(/\b0[1-9](?:[\s.\-]?\d{2}){4}\b/g, '[tél. masqué]')
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email masqué]');
}

async function _trelloGet(path) {
  if (!TRELLO_KEY || !TRELLO_TOKEN) throw new Error('Trello non configuré');
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.trello.com/1${path}${sep}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const r = await axios.get(url, { timeout: 8000 });
  return r.data;
}

const _trelloBoardIdCache = {};
async function _trelloBoardIdFor(listId) {
  if (_trelloBoardIdCache[listId]) return _trelloBoardIdCache[listId];
  const list = await _trelloGet(`/lists/${listId}?fields=idBoard`);
  _trelloBoardIdCache[listId] = list.idBoard;
  return list.idBoard;
}

function _trelloStatusFromListName(name) {
  const n = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/resolu|termine|done|ferme|clos/.test(n)) return 'resolved';
  if (/cours|progress|traitement/.test(n)) return 'in_progress';
  return 'pending';
}

const _attachmentUrlMap = new Map();
let _sigTrackCache = null, _sigTrackCacheAt = 0;

async function _fetchTrelloSignalements() {
  if (_sigTrackCache && Date.now() - _sigTrackCacheAt < 5 * 60 * 1000) return _sigTrackCache;
  if (!TRELLO_KEY || !TRELLO_TOKEN) return { signalements: [], bugs: [] };
  // Support SIG et BUG sur des boards Trello séparés
  const boardIds = new Set();
  if (TRELLO_LIST_ID_SIG) boardIds.add(await _trelloBoardIdFor(TRELLO_LIST_ID_SIG));
  if (TRELLO_LIST_ID_BUG) boardIds.add(await _trelloBoardIdFor(TRELLO_LIST_ID_BUG));
  if (!boardIds.size) return { signalements: [], bugs: [] };
  const listStatusMap = {}, listNameMap = {};
  const allCards = [];
  await Promise.all([...boardIds].map(async bid => {
    const [lists, cards] = await Promise.all([
      _trelloGet(`/boards/${bid}/lists?fields=id,name&filter=open`),
      _trelloGet(`/boards/${bid}/cards?filter=open&fields=id,name,desc,idList,dateLastActivity&attachments=true&actions=commentCard`),
    ]);
    for (const l of lists) { listStatusMap[l.id] = _trelloStatusFromListName(l.name); listNameMap[l.id] = l.name; }
    allCards.push(...cards);
  }));
  // Compatibility: replace local cards variable reference
  const cards = allCards;
  const result = { signalements: [], bugs: [] };
  for (const card of cards) {
    const isSig = card.name.startsWith('[Signalement]');
    const isBug = card.name.startsWith('[BUG]');
    if (!isSig && !isBug) continue;
    const cat = card.name.replace(/^\[(Signalement|BUG)\]\s*/, '');
    const status = listStatusMap[card.idList] || 'pending';
    const statusLabel = listNameMap[card.idList] || 'À traiter';
    const comments = ((card.actions || [])
      .filter(a => a.type === 'commentCard')
      .map(a => ({ text: _anonymize(a.data.text), date: a.date }))
    ).reverse();
    const photos = (card.attachments || [])
      .filter(a => a.id && a.url && (!a.mimeType || a.mimeType.startsWith('image/')))
      .map(a => {
        _attachmentUrlMap.set(`${card.id}/${a.id}`, { trelloUrl: a.url, mimeType: a.mimeType || 'image/jpeg' });
        return { url: `https://chatbot-mairie-mezieres.onrender.com/api/signalements/photo/${card.id}/${a.id}` };
      });
    const item = { id: card.id, cat, desc: _anonymize(card.desc), status, statusLabel, date: card.dateLastActivity, comments, photos };
    if (isSig) result.signalements.push(item);
    else result.bugs.push(item);
  }
  result.signalements.sort((a, b) => b.date.localeCompare(a.date));
  result.bugs.sort((a, b) => b.date.localeCompare(a.date));
  _sigTrackCache = result; _sigTrackCacheAt = Date.now();
  return result;
}

app.get('/api/signalements', async (req, res) => {
  try { res.json(await _fetchTrelloSignalements()); }
  catch(e) {
    console.error('api/signalements:', e.message);
    res.status(502).json({ signalements: [], bugs: [], error: 'Service temporairement indisponible' });
  }
});

app.get('/api/signalements/photo/:cardId/:attachId', async (req, res) => {
  try {
    const { cardId, attachId } = req.params;
    if (!/^[a-zA-Z0-9]+$/.test(cardId) || !/^[a-zA-Z0-9]+$/.test(attachId)) return res.status(400).end();
    if (!TRELLO_KEY || !TRELLO_TOKEN) return res.status(503).end();
    let entry = _attachmentUrlMap.get(`${cardId}/${attachId}`);
    if (!entry) { await _fetchTrelloSignalements(); entry = _attachmentUrlMap.get(`${cardId}/${attachId}`); }
    if (!entry) return res.status(404).end();
    const sep = entry.trelloUrl.includes('?') ? '&' : '?';
    const authedUrl = `${entry.trelloUrl}${sep}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
    const r = await axios.get(authedUrl, { responseType: 'stream', maxRedirects: 10, timeout: 20000 });
    res.setHeader('Content-Type', r.headers['content-type'] || entry.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    r.data.pipe(res);
  } catch(e) { console.error('photo proxy:', e.message); res.status(502).end(); }
});

// ── Boîte à idées partagées ──────────────────────────────────
// ── Idées citoyennes + actualités — voir routes/idees.js ─────
app.use(require("./routes/idees"));

// ── Routes météo — voir routes/meteo.js ────────────────────
app.use(require("./routes/meteo"));

// ── Abonnements push — voir routes/push.js ─────────────────
app.use(require("./routes/push"));

// ── Notifications owner idées/signalements — voir routes/notify.js ──
app.use(require("./routes/notify"));

// ── Logs PWA + login admin — voir routes/logs.js ────────────
app.use(require("./routes/logs"));

// ── Admin simple (settings, MEL, idées, actus) — voir routes/admin-simple.js ──
app.use(require("./routes/admin-simple"));

// ── Admin actus (add, patch, push schedule, calendar) — voir routes/admin-actus.js ──
app.use(require("./routes/admin-actus"));

// ── Purge données — voir routes/admin-purge.js ──────────────
app.use(require("./routes/admin-purge"));

// ── Webhook Facebook — voir routes/webhook.js ────────────────
app.use(require("./routes/webhook"));

// ── Geo (zone-plu, chemins, parcours) — voir routes/geo.js ──
app.use(require("./routes/geo"));

// ── Stats publiques — voir routes/stats-public.js ────────────
app.use(require("./routes/stats-public"));


// ── Diagnostic + utilitaires — voir routes/admin-diag.js ──
app.use(require("./routes/admin-diag"));


// ── Routes publiques (/, /status, /ping, /health, calendar-proxy) — voir routes/core.js ──
app.use(require("./routes/core"));

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Documents temporaires ────────────────────────────────
// ── Documents temp + featured — voir routes/docs.js ──────────
app.use(require("./routes/docs"));

// ── Sondages citoyens — voir routes/sondages.js ───────────────
app.use(require("./routes/sondages"));


// ── Annuaire entreprises — voir routes/entreprises.js ────────
app.use(require("./routes/entreprises"));


// ── Email stats + cron — voir routes/admin-email.js ────────
app.use(require("./routes/admin-email"));

// ─── Prix carburant — 3 stations locales ─────────────────────────────────────
// ── Prix carburants — voir routes/carburant.js ────────────────
app.use(require("./routes/carburant"));

// ── Qualité air + Vigicrues Loire — voir routes/env-local.js ─
app.use(require("./routes/env-local"));

// ── Événements locaux OpenAgenda — voir routes/events-locaux.js ──
app.use(require("./routes/events-locaux"));

// ─── Sentry error handler Express (doit être après toutes les routes) ─
if (process.env.SENTRY_DSN) require('@sentry/node').setupExpressErrorHandler(app);

const _server = app.listen(PORT, async () => {
  console.log(`🚀 MAT Serveur v6.5 démarré sur le port ${PORT}`);
  console.log(`📱 PWA MEL    : /mel`);
  console.log(`📰 Facebook   : feed only`);
  console.log(`🚨 Signalement: /signal`);
  console.log(`🔔 Push       : /push/subscribe`);
  console.log(`🌦️ Météo      : /meteo/commune`);
  console.log(`⚠️ Vigilance  : /meteo/vigilance`);

  // Initialisation des données par défaut
  initEntreprisesIfEmpty().catch(e => console.warn("Entreprises init:", e.message));

  // Délai de 20s avant les init réseau pour laisser le DNS Render se stabiliser
  setTimeout(() => {
    refreshCalendarCache().catch(e => console.warn("Calendar cache init:", e.message));
    refreshRemiCache().catch(e => console.warn("Remi cache init:", e.message));
  }, 20000);

  // Weather check initial après 30s (DNS + réseau garantis stables)
  setTimeout(() => {
    axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`)
      .catch(e => console.warn("Weather check initial:", e.message));

    // Puis polling toutes les WEATHER_CHECK_INTERVAL_MS
    setInterval(async () => {
      try {
        await axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`);
      } catch (e) {
        console.warn("Weather check auto:", e.message);
      }
    }, WEATHER_CHECK_INTERVAL_MS);
  }, 30000);
});

// ── Rappels déchets quotidiens à 18h (heure de Paris) ────────
function _dechetsWeekNumber(d) {
  const j = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - j) / 86400000) + j.getDay() + 1) / 7);
}

function _dechetsTomorrowType() {
  const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const today = new Date(pNow.getFullYear(), pNow.getMonth(), pNow.getDate());
  const tom = new Date(today); tom.setDate(today.getDate()+1);
  const tomDow = tom.getDay();
  let isNoir = false, isJaune = false;
  if (tomDow === 1 && !_isFerieDate(tom)) isNoir = true;
  if (tomDow === 2 && _isFerieDate(today) && today.getDay() === 1) isNoir = true;
  if (tomDow === 2 && _dechetsWeekNumber(tom) % 2 === 0 && !_isFerieDate(tom) && !isNoir) isJaune = true;
  if (tomDow === 3 && _isFerieDate(today) && today.getDay() === 2 && _dechetsWeekNumber(today) % 2 === 0) isJaune = true;
  if (tomDow === 3 && today.getDay() === 2 && _dechetsWeekNumber(today) % 2 === 0) {
    const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
    if (yesterday.getDay() === 1 && _isFerieDate(yesterday)) isJaune = true;
  }
  if (isNoir && isJaune) return 'both';
  if (isNoir) return 'noir';
  if (isJaune) return 'jaune';
  return null;
}

async function _sendDechetsReminder() {
  const type = _dechetsTomorrowType();
  if (!type) return;
  const subs = await readDechetsSubs();
  if (!subs.length) return;
  let title, body;
  if (type === 'both') {
    title = 'MAT — Collecte ordures + recyclables demain';
    body = '🗑️♻️ Pensez à sortir vos bacs noir et jaune ce soir !';
  } else if (type === 'noir') {
    title = 'MAT — Collecte ordures ménagères demain';
    body = '🗑️ Pensez à sortir votre bac noir ce soir !';
  } else {
    title = 'MAT — Collecte recyclables demain';
    body = '♻️ Pensez à sortir votre bac jaune ce soir !';
  }
  const payload = JSON.stringify({
    title,
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './#dechets', open: 'dechets' }
  });
  const dead = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    await writeDechetsSubs(subs.filter(s => !dead.includes(s.endpoint)));
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  console.log(`🗑️ Rappel déchets (${type}) → ${subs.length} abonnés`);
}

let _dechetsLastSent = null; // évite les Redis GETs répétés pendant l'heure 18h

setInterval(async () => {
  try {
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (pNow.getHours() !== 18) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dechetsLastSent === today) return; // court-circuit en mémoire
    const lastSent = await redisGet('mat:dechets:lastSent');
    if (lastSent === today) { _dechetsLastSent = today; return; }
    _dechetsLastSent = today;
    await redisSet('mat:dechets:lastSent', today);
    await _sendDechetsReminder();
  } catch(e) { console.warn('Dechets reminder:', e.message); }
}, 5 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────
// Render envoie SIGTERM ~30 s avant kill -9. On en profite pour :
//  - arrêter d'accepter de nouvelles connexions (server.close)
//  - flusher les caches stats dirty restés en mémoire
//  - laisser les requêtes en cours se terminer (timeout 25 s safety)
let _shuttingDown = false;
async function _gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`🔻 ${sig} reçu — fermeture gracieuse…`);
  try {
    await flushStatsNow();
    console.log("   ✓ mat:stats / mat:ia:stats flushés");
    await flushMelQuotas();
    console.log("   ✓ mat:mel:quotas flushé");
  } catch (e) {
    console.warn("   ⚠️ flush shutdown:", e.message);
  }
  if (_server && typeof _server.close === "function") {
    _server.close(() => process.exit(0));
    setTimeout(() => { console.warn("   ⏰ timeout 25 s — exit forcé"); process.exit(1); }, 25000).unref();
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", () => _gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => _gracefulShutdown("SIGINT"));