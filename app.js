/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 *
 * app.js — Construction de l'application Express (middleware + routes).
 *
 * Séparé de index.js (démarrage serveur + tâches planifiées) afin de permettre
 * les tests d'intégration des routes : un test peut `require('./app')` puis
 * `app.listen(0)` sans déclencher le polling météo/sécheresse ni les crons.
 * Aucun effet de bord réseau ici (pas de listen, pas de setInterval).
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
const webpush   = require("./lib/webpush");

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
  if (p === "/photos") return true;
  if (p === "/admin/actus/add") return true;
  if (p === "/admin/entreprises" || p.startsWith("/admin/entreprises/")) return true;
  if (p === "/admin/mascotte") return true;
  if (p === "/admin/docs/plui") return true; // PDF du PLUi envoyé en base64
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
const { ADMIN_PASSWORD, CRON_SECRET } = require("./config");

if (!ADMIN_PASSWORD) {
  console.warn("⚠️  ADMIN_PASSWORD non défini : tous les endpoints /admin seront refusés (401).");
}

// ─── Dépendances des helpers déchets + route cron ─────────────
const { redisGet, redisSet } = require("./lib/redis");
const { readDechetsSubs, writeDechetsSubs, purgeEndpointsEverywhere, recordPushHistory } = require("./lib/store");
const { _isFerieDate } = require("./lib/dates");

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
  // Préflight CORS géré ici plutôt que via app.options("*") : le chemin "*"
  // nu est rejeté par path-to-regexp v8 (Express 5).
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Admin dashboard — voir routes/admin-dashboard.js ────────
app.use(require("./routes/admin-dashboard"));

// ── Banderole info + overlay migration — voir routes/info-banner.js ──
app.use(require("./routes/info-banner"));

// ── Horaires exceptionnels (mairie & déchetterie) — voir routes/horaires.js ──
app.use(require("./routes/horaires"));

// ── Chat MEL IA — voir routes/mel.js ────────────────────────
app.use(require("./routes/mel"));

// ── Signalements citoyens + Trello — voir routes/signalements.js ──
app.use(require("./routes/signalements"));

// ── Idées citoyennes + actualités — voir routes/idees.js ─────
app.use(require("./routes/idees"));

// ── Galerie photos communautaires — voir routes/photos.js ────
app.use(require("./routes/photos"));

// ── Routes météo — voir routes/meteo.js ────────────────────
app.use(require("./routes/meteo"));

// ── Restrictions sécheresse VigiEau — voir routes/eau.js ───
app.use(require("./routes/eau"));

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

// ── Webhook Trello (statut signalements → push) ──────────────
app.use(require("./routes/trello-webhook"));

// ── Geo (zone-plu, chemins, parcours) — voir routes/geo.js ──
app.use(require("./routes/geo"));

// ── Stats publiques — voir routes/stats-public.js ────────────
app.use(require("./routes/stats-public"));

// ── Diagnostic + utilitaires — voir routes/admin-diag.js ──
app.use(require("./routes/admin-diag"));

// ── Routes publiques (/, /status, /ping, /health, calendar-proxy) — voir routes/core.js ──
app.use(require("./routes/core"));

// ── Documents temp + featured — voir routes/docs.js ──────────
app.use(require("./routes/docs"));

// ── Sondages citoyens — voir routes/sondages.js ───────────────
app.use(require("./routes/sondages"));

// ── Réactions (likes actus, RSVP événements, config features) — voir routes/reactions.js ──
app.use(require("./routes/reactions"));

// ── Annuaire entreprises — voir routes/entreprises.js ────────
app.use(require("./routes/entreprises"));

// ── Email stats + cron — voir routes/admin-email.js ────────
app.use(require("./routes/admin-email"));

// ── Sauvegarde Upstash → base cible — voir routes/cron-backup.js ────────
app.use(require("./routes/cron-backup"));

// ── Photo MAT & MEL personnalisable — voir routes/mascotte.js ────────
app.use(require("./routes/mascotte"));

// ── Prix carburants — voir routes/carburant.js ────────────────
app.use(require("./routes/carburant"));

// ── Qualité air + Vigicrues Loire — voir routes/env-local.js ─
app.use(require("./routes/env-local"));

// ── Événements locaux OpenAgenda — voir routes/events-locaux.js ──
app.use(require("./routes/events-locaux"));

// ═══════════════════════════════════════════════════════════════
// RAPPELS DÉCHETS (helpers + route cron ; le planificateur vit dans index.js)
// ═══════════════════════════════════════════════════════════════
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

// opts.test : envoi d'une notif de diagnostic à la liste déchets, quel que
// soit le jour (ignore _dechetsTomorrowType). Sert à vérifier que la liste
// d'abonnés mat:subs:dechets est vivante sans attendre une veille de collecte.
async function _sendDechetsReminder(opts = {}) {
  const type = opts.test ? 'test' : _dechetsTomorrowType();
  if (!type) return { type: null, total: 0, sent: 0, dead: 0, transientFails: 0 };
  const subs = await readDechetsSubs();
  if (!subs.length) return { type, total: 0, sent: 0, dead: 0, transientFails: 0 };
  let title, body;
  if (type === 'test') {
    title = 'MAT — Test rappel collecte';
    body = '🧪 Test : si vous voyez ceci, vos rappels poubelles fonctionnent !';
  } else if (type === 'both') {
    title = 'MAT — Collecte ordures + recyclables demain';
    body = '🗑️♻️ Pensez à sortir vos bacs noir et jaune ce soir !';
  } else if (type === 'noir') {
    title = 'MAT — Collecte ordures ménagères demain';
    body = '🗑️ Pensez à sortir votre bac noir ce soir !';
  } else {
    title = 'MAT — Collecte recyclables demain';
    body = '♻️ Pensez à sortir votre bac jaune ce soir !';
  }
  const payload = JSON.stringify({
    title,
    body,
    icon: './icon-192.png',
    badge: './icon-badge.png',
    data: { url: './#dechets', open: 'dechets' }
  });
  const dead = [];
  let sent = 0;
  let transientFails = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); sent++; }
    catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
      else transientFails++;
    }
  }
  if (dead.length) {
    await writeDechetsSubs(subs.filter(s => !dead.includes(s.endpoint))).catch(() => {});
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  console.log(`🗑️ Rappel déchets (${type}) → ${sent}/${subs.length} abonnés (${dead.length} expiré(s), ${transientFails} échec(s) transitoire(s))`);
  // Traçabilité : sans cet historique, une nuit ratée est une boîte noire.
  recordPushHistory({ kind: 'dechets', type, total: subs.length, sent, dead: dead.length, transientFails }).catch(() => {});
  // Erreur transitoire (réseau, FCM…) sur TOUS les envois : on lève pour
  // bloquer l'écriture de la dédup Redis — l'appelant réessaiera au prochain
  // tick (toutes les 5 min jusqu'à 21h) ou via le cron externe /cron/dechets.
  if (sent === 0 && transientFails > 0) {
    throw new Error(`Push déchets: ${transientFails} erreur(s) transitoire(s)`);
  }
  return { type, total: subs.length, sent, dead: dead.length, transientFails };
}

// Endpoint cron déchets — appelable par cron-job.org à 18h heure de Paris
// URL : /cron/dechets?key=CRON_SECRET
//   &force=1 → ignore la dédup journalière (renvoie quand même selon le jour)
//   &test=1  → envoi de diagnostic à la liste déchets quel que soit le jour
//              (n'écrit pas la dédup : c'est une sonde, pas un vrai rappel)
app.get("/cron/dechets", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    // Mode sonde : sait dire si mat:subs:dechets est vivante ou vide.
    if (req.query.test === '1') {
      const r = await _sendDechetsReminder({ test: true });
      return res.json({ ok: true, test: true, ...r });
    }
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (req.query.force !== '1') {
      const lastSent = await redisGet('mat:dechets:lastSent');
      if (lastSent === today) return res.json({ ok: true, skipped: true, reason: 'Déjà envoyé aujourd\'hui' });
    }
    // Envoi AVANT le dedup : si _sendDechetsReminder lance, on ne marque pas
    // la journée comme faite → cron-job.org pourra réessayer (et le 500 rendu
    // ci-dessous alertera le monitoring du cron).
    const r = await _sendDechetsReminder();
    await redisSet('mat:dechets:lastSent', today);
    // Réponse honnête : type=null + sent=0 un jour sans collecte, ou si la
    // liste d'abonnés est vide — le monitoring ne croit plus à un faux succès.
    res.json({ ok: true, ...r });
  } catch(e) {
    console.error('❌ /cron/dechets:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Sentry error handler Express (doit être après toutes les routes) ─
if (process.env.SENTRY_DSN) require('@sentry/node').setupExpressErrorHandler(app);

module.exports = app;
// Helpers réutilisés par le planificateur de index.js et par les tests.
module.exports._sendDechetsReminder = _sendDechetsReminder;
module.exports._dechetsTomorrowType = _dechetsTomorrowType;
