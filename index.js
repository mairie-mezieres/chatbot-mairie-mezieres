/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 */
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
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 unhandledRejection:', msg);
  logServerError('unhandledRejection', msg);
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

// ── Boîte à idées partagées ──────────────────────────────────
// ── Idées citoyennes + actualités — voir routes/idees.js ─────
app.use(require("./routes/idees"));

// ── Routes météo — voir routes/meteo.js ────────────────────
app.use(require("./routes/meteo"));

// ── Abonnements push — voir routes/push.js ─────────────────
app.use(require("./routes/push"));

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


// ── Route setup webhook// ── Route setup webhook (à appeler une seule fois) ───────────
app.get("/setup-webhook", adminAuth, async (req, res) => {
  if (!PAGE_ACCESS_TOKEN) return res.status(500).json({ error: "PAGE_ACCESS_TOKEN manquant" });

  try {
    const pageInfo = await axios.get(
      `https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`
    );
    const pageId   = pageInfo.data.id;
    const pageName = pageInfo.data.name;

    const subResult = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { subscribed_fields: "feed" },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );

    const checkResult = await axios.get(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );

    res.json({
      success: true,
      page: { id: pageId, name: pageName },
      result: subResult.data,
      abonnements: checkResult.data
    });
  } catch(e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

app.get("/ping", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/health", (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const degraded = _isRedis429();
  res.json({ ok: true, redis: !degraded, mode: degraded ? 'degraded' : 'normal' });
});

// ── Diagnostic Mistral (à supprimer après test) ───────────────
app.get("/debug-mistral", adminAuth, async (req, res) => {
  if (!MISTRAL_API_KEY) return res.json({ error: "MISTRAL_API_KEY absente" });
  try {
    const payload = {
      model: MISTRAL_MODEL,
      temperature: 0.2,
      max_tokens: 50,
      messages: [
        { role: "system", content: "Tu es MEL, assistante de la mairie." },
        { role: "user",   content: "Bonjour" }
      ]
    };
    const r = await axios.post(MISTRAL_URL, payload, {
      timeout: 20000,
      headers: {
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    res.json({ ok: true, model: MISTRAL_MODEL, url: MISTRAL_URL, response: r.data });
  } catch(e) {
    res.json({
      ok: false,
      model: MISTRAL_MODEL,
      url: MISTRAL_URL,
      status: e.response?.status,
      errorData: e.response?.data,
      message: e.message
    });
  }
});

// ── Diagnostic Google Calendar ─────────────────────────────
app.get("/debug-calendar", adminAuth, async (req, res) => {
  const result = {
    config: {
      has_calendar_id: !!process.env.GOOGLE_CALENDAR_ID,
      calendar_id: process.env.GOOGLE_CALENDAR_ID || "(vide)",
      has_service_account_b64: !!process.env.GOOGLE_SERVICE_ACCOUNT_B64,
      has_service_account_raw: !!process.env.GOOGLE_SERVICE_ACCOUNT,
      b64_length: process.env.GOOGLE_SERVICE_ACCOUNT_B64 ? process.env.GOOGLE_SERVICE_ACCOUNT_B64.length : 0,
    }
  };

  // Test 1 : googleapis installée ?
  try {
    require("googleapis");
    result.googleapis_installed = true;
  } catch (e) {
    result.googleapis_installed = false;
    result.googleapis_error = e.message;
    return res.json({ ok: false, step: "googleapis_require", result });
  }

  // Test 2 : string-similarity installée ?
  try {
    require("string-similarity");
    result.string_similarity_installed = true;
  } catch (e) {
    result.string_similarity_installed = false;
    result.string_similarity_error = e.message;
    return res.json({ ok: false, step: "string_similarity_require", result });
  }

  // Test 3 : Parse du JSON service account
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    : process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) {
    return res.json({ ok: false, step: "env_missing", result, error: "GOOGLE_SERVICE_ACCOUNT_B64 et GOOGLE_SERVICE_ACCOUNT absents" });
  }
  try {
    const creds = JSON.parse(raw);
    result.service_account_email = creds.client_email || "(manquant)";
    result.service_account_project = creds.project_id || "(manquant)";
    result.has_private_key = !!creds.private_key;
  } catch (e) {
    return res.json({ ok: false, step: "json_parse", result, error: "JSON invalide: " + e.message });
  }

  // Test 4 : Init client Google Calendar
  const cal = getGoogleCalendarClient();
  if (!cal) {
    return res.json({ ok: false, step: "calendar_client_init", result, error: "getGoogleCalendarClient() a renvoyé null — voir logs Render au démarrage" });
  }
  result.calendar_client_ok = true;

  // Test 5 : Lister les events du jour (teste l'authentification + les droits)
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    return res.json({ ok: false, step: "calendar_id_missing", result });
  }
  try {
    const today = new Date();
    const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(today); dayEnd.setHours(23, 59, 59, 999);
    const list = await cal.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      maxResults: 5,
    });
    result.list_test_ok = true;
    result.events_today_count = (list.data.items || []).length;
  } catch (e) {
    result.list_test_ok = false;
    result.list_test_error = e.message;
    result.list_test_status = e.code || e.response?.status || null;
    result.list_test_details = e.response?.data?.error || null;
    return res.json({ ok: false, step: "calendar_list", result });
  }

  // Test 6 : Créer un événement de test (puis le supprimer)
  try {
    const testEvent = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: "[TEST MAT] Diagnostic — à supprimer",
        description: "Événement de diagnostic créé par /debug-calendar. Sera supprimé automatiquement.",
        start: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), timeZone: "Europe/Paris" },
        end: { dateTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), timeZone: "Europe/Paris" },
      }
    });
    result.insert_test_ok = true;
    result.test_event_id = testEvent.data.id;
    result.test_event_link = testEvent.data.htmlLink;

    // Supprimer immédiatement l'événement de test
    try {
      await cal.events.delete({ calendarId, eventId: testEvent.data.id });
      result.delete_test_ok = true;
    } catch (delErr) {
      result.delete_test_ok = false;
      result.delete_test_error = delErr.message;
    }
  } catch (e) {
    result.insert_test_ok = false;
    result.insert_test_error = e.message;
    result.insert_test_status = e.code || e.response?.status || null;
    result.insert_test_details = e.response?.data?.error || null;
    return res.json({ ok: false, step: "calendar_insert", result });
  }

  res.json({ ok: true, step: "all_passed", result });
});

app.get("/admin/services/test", adminAuth, async (req, res) => {
  const checkedAt = new Date().toISOString();

  async function runCheck(key, label, icon, fn) {
    const started = Date.now();
    try {
      const out = await fn();
      return {
        key,
        label,
        icon,
        status: out?.status || "ok",
        message: out?.message || "OK",
        details: out?.details ?? null,
        checkedAt,
        durationMs: Date.now() - started,
      };
    } catch (e) {
  const apiError = e.response?.data?.error;
  return {
    key,
    label,
    icon,
    status: "danger",
    message:
      (typeof apiError === "string" ? apiError : apiError?.message) ||
      e.message ||
      "Erreur",
    details: apiError || e.response?.data || null,
    checkedAt,
    durationMs: Date.now() - started,
  };
}
  }

  const services = [];

  services.push(await runCheck("server", "Serveur API", "🌲", async () => ({
    status: "ok",
    message: "Serveur Express opérationnel",
    details: { version: "6.6.0", uptimeSeconds: Math.round(process.uptime()) }
  })));

  services.push(await runCheck("redis", "Redis / Upstash", "🗄️", async () => {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return { status: "warn", message: "Redis non configuré", details: { has_url: !!REDIS_URL, has_token: !!REDIS_TOKEN } };
    }
    const probeKey = "mat:diag:probe";
    const probeVal = { ts: checkedAt };
    await redisSet(probeKey, probeVal);
    const readBack = await redisGet(probeKey);
    if (!readBack || readBack.ts !== checkedAt) {
      throw new Error("Lecture/écriture Redis incohérente");
    }
    return { status: "ok", message: "Lecture / écriture Redis OK", details: { probe_key: probeKey } };
  }));

  services.push(await runCheck("meteo", "Open-Meteo commune", "🌤️", async () => {
  const result = await getCachedMeteoForecast({ allowStale: true });
  const forecast = result.data;
  const cur = forecast?.current || {};
    return {
      status: "ok",
      message: `Température reçue : ${Math.round(Number(cur.temperature_2m || 0))}°C`,
      details: {
        temperature_2m: cur.temperature_2m,
        weather_code: cur.weather_code,
        wind_speed_10m: cur.wind_speed_10m,
        timezone: forecast?.timezone || OPEN_METEO_TZ
      }
    };
  }));

  services.push(await runCheck("vigilance", "Vigilance Météo-France", "⚠️", async () => {
    if (!METEOFRANCE_VIGILANCE_URL) {
      return { status: "warn", message: "Flux vigilance non configuré", details: { has_url: false } };
    }
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vig = extractDepartmentVigilance(raw, "45");
    if (!vig) {
      return { status: "warn", message: "Flux reçu mais aucune vigilance détaillée pour le 45", details: { periods: raw?.product?.periods?.length || 0 } };
    }
    return {
      status: "ok",
      message: `Vigilance ${vig.color_label} — ${vig.phenomenon_label}`,
      details: vig
    };
  }));

  services.push(await runCheck("bus", "Bus Rémi (cache)", "🚌", async () => {
    const ageMs = remiCache.lastUpdate ? Date.now() - remiCache.lastUpdate.getTime() : null;
    if (!remiCache.content) {
      return { status: "warn", message: "Cache bus vide", details: { lastUpdate: remiCache.lastUpdate || null } };
    }
    if (String(remiCache.content).startsWith("[")) {
      return { status: "warn", message: "Cache bus présent mais en erreur", details: { content: remiCache.content, lastUpdate: remiCache.lastUpdate || null } };
    }
    return {
      status: ageMs != null && ageMs > CACHE_MS ? "warn" : "ok",
      message: ageMs != null && ageMs > CACHE_MS ? "Cache bus ancien" : "Cache bus disponible",
      details: { lastUpdate: remiCache.lastUpdate || null, age_hours: ageMs != null ? Number((ageMs / 3600000).toFixed(1)) : null }
    };
  }));

  services.push(await runCheck("agenda_public", "Agenda public (ICS)", "📅", async () => {
    if (!GOOGLE_CALENDAR_ICAL) {
      return { status: "warn", message: "ICAL Google Calendar non configuré", details: { has_ical: false } };
    }
    await refreshCalendarCache();
    if (!calendarCache.content || String(calendarCache.content).includes("non accessible")) {
      throw new Error("Agenda public indisponible");
    }
    return {
      status: "ok",
      message: "Agenda public rechargé",
      details: { lastUpdate: calendarCache.lastUpdate || null }
    };
  }));

  services.push(await runCheck("calendar_admin", "Google Calendar (écriture)", "🗓️", async () => {
    const cal = getGoogleCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!cal || !calendarId) {
      return {
        status: "warn",
        message: "Google Calendar non configuré",
        details: { has_client: !!cal, has_calendar_id: !!calendarId }
      };
    }

    const list = await cal.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      maxResults: 3,
      singleEvents: true,
      orderBy: "startTime"
    });

    const start = new Date(Date.now() + 2 * 3600000);
    const end = new Date(Date.now() + 3 * 3600000);
    const created = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: "[TEST MAT] Diagnostic auto",
        description: "Événement créé puis supprimé automatiquement par le test admin.",
        start: { dateTime: start.toISOString(), timeZone: "Europe/Paris" },
        end: { dateTime: end.toISOString(), timeZone: "Europe/Paris" }
      }
    });

    let deleted = false;
    if (created?.data?.id) {
      await cal.events.delete({ calendarId, eventId: created.data.id });
      deleted = true;
    }

    return {
      status: "ok",
      message: "Lecture + écriture Google Calendar OK",
      details: {
        upcoming_events_count: (list.data.items || []).length,
        created_event_id: created?.data?.id || null,
        deleted_test_event: deleted
      }
    };
  }));

services.push(await runCheck("trello", "Trello notifications", "📌", async () => {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return {
      status: "warn",
      message: "Trello non configuré",
      details: {
        has_key: !!TRELLO_KEY,
        has_token: !!TRELLO_TOKEN
      }
    };
  }

  const targets = [
    { type: "bug",         listId: TRELLO_LIST_ID_BUG },
    { type: "signalement", listId: TRELLO_LIST_ID_SIG },
    { type: "demande",     listId: TRELLO_LIST_ID_DEMANDE }
  ];

  const missing = targets.filter(t => !t.listId).map(t => t.type);
  if (missing.length) {
    return {
      status: "warn",
      message: `Listes Trello manquantes : ${missing.join(", ")}`,
      details: {
        has_bug_list: !!TRELLO_LIST_ID_BUG,
        has_sig_list: !!TRELLO_LIST_ID_SIG,
        has_demande_list: !!TRELLO_LIST_ID_DEMANDE
      }
    };
  }

  const results = [];

  for (const target of targets) {
    const listRes = await axios.get(`https://api.trello.com/1/lists/${target.listId}`, {
      params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
      timeout: 10000
    });

    const cardRes = await axios.post(`https://api.trello.com/1/cards`, null, {
      params: {
        key: TRELLO_KEY,
        token: TRELLO_TOKEN,
        idList: target.listId,
        name: `[TEST MAT] Diagnostic auto ${target.type}`,
        desc: `Carte de test créée puis supprimée automatiquement par le diagnostic admin (${target.type}).`
      },
      timeout: 10000
    });

    let deleted = false;
    if (cardRes?.data?.id) {
      await axios.delete(`https://api.trello.com/1/cards/${cardRes.data.id}`, {
        params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
        timeout: 10000
      });
      deleted = true;
    }

    results.push({
      type: target.type,
      list_id: target.listId,
      list_name: listRes.data?.name || null,
      deleted_test_card: deleted
    });
  }

  return {
    status: "ok",
    message: "Listes Trello OK : bug, signalement, demande",
    details: results
  };
}));

  services.push(await runCheck("mistral", "Mistral", "🤖", async () => {
    if (!MISTRAL_API_KEY) {
      return { status: "warn", message: "Mistral non configuré", details: { has_api_key: false, model: MISTRAL_MODEL } };
    }
    const payload = {
      model: MISTRAL_MODEL,
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: "system", content: "Réponds par OK." },
        { role: "user", content: "Test MAT" }
      ]
    };
    const r = await axios.post(MISTRAL_URL, payload, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    return {
      status: "ok",
      message: `Réponse Mistral reçue (${MISTRAL_MODEL})`,
      details: { model: MISTRAL_MODEL, id: r.data?.id || null }
    };
  }));

services.push(await runCheck("facebook", "Facebook Page", "📘", async () => {
  if (!PAGE_ACCESS_TOKEN) {
    return { status: "warn", message: "Facebook non configuré", details: { has_page_token: false } };
  }
  const pageId = await resolveFacebookPageId();
  if (!pageId) throw new Error("Impossible de résoudre l'identifiant de page");

  const pageInfo = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
    params: { access_token: PAGE_ACCESS_TOKEN, fields: "id,name" },
    timeout: 10000
  });

  return {
    status: "ok",
    message: `Page connectée : ${pageInfo.data?.name || pageId}`,
    details: { page_id: pageInfo.data?.id || pageId, page_name: pageInfo.data?.name || null }
  };
}));

  services.push(await runCheck("push", "Notifications push", "🔔", async () => {
    const subs = await readSubs();
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return {
        status: "warn",
        message: "Web Push non configuré",
        details: { has_public_key: !!VAPID_PUBLIC_KEY, has_private_key: !!VAPID_PRIVATE_KEY, subscribers: subs.length }
      };
    }
    return {
      status: subs.length ? "ok" : "warn",
      message: subs.length ? `${subs.length} abonné(s) push enregistrés` : "Configuration OK mais aucun abonné push",
      details: { subscribers: subs.length }
    };
  }));

  const summary = services.reduce((acc, s) => {
    acc.total += 1;
    if (s.status === "ok") acc.ok += 1;
    else if (s.status === "warn") acc.warn += 1;
    else acc.danger += 1;
    return acc;
  }, { total: 0, ok: 0, warn: 0, danger: 0 });

  res.json({ ok: true, checkedAt, summary, services });
});

// Compteurs en mémoire (pas d'appel Redis pour le health check Render)
const _memStats = { bootTime: new Date().toISOString() };

app.get("/", (req, res) => {
  // Réponse instantanée sans Redis - health check Render
  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.5 — Mistral principal + Claude secours + MEL améliorée",
    uptime:  Math.floor(process.uptime()) + "s",
    routes: [
      "/webhook","/mel","/signal","/signalements","/actus","/push/subscribe",
      "/push/unsubscribe",
      "/meteo/commune","/meteo/vigilance","/meteo/alertes/check"
    ],
  });
});

// Route stats complètes avec Redis (à la demande uniquement)
app.get("/status", async (req, res) => {
  const [subs, news, ideas, signals] = await Promise.all([
    readSubs(), readNews(), readIdeas(), readSignals()
  ]);

  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.4 — Mistral principal + Claude secours + MEL améliorée",
    abonnes: subs.length,
    actus: news.length,
    idees: ideas.length,
    signalements: signals.length,
    routes: [
      "/webhook","/mel","/signal","/signalements","/actus","/push/subscribe",
      "/push/unsubscribe",
      "/meteo/commune","/meteo/vigilance","/meteo/alertes/check"
    ],
  });
});

// ── Proxy iCal pour la PWA (résout le CORS Google Calendar) ──
app.get("/calendar-proxy", async (req, res) => {
  if (!GOOGLE_CALENDAR_ICAL) return res.status(500).send("GOOGLE_CALENDAR_ICAL non configuré");
  try {
    const r = await axios.get(GOOGLE_CALENDAR_ICAL, { timeout: 10000, responseType: "text" });
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch(e) {
    console.error("❌ calendar-proxy:", e.message);
    res.status(500).send("Calendrier indisponible");
  }
});

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Documents temporaires ────────────────────────────────
// ── Documents temp + featured — voir routes/docs.js ──────────
app.use(require("./routes/docs"));

// ── Sondages citoyens — voir routes/sondages.js ───────────────
app.use(require("./routes/sondages"));


// ── Annuaire entreprises — voir routes/entreprises.js ────────
app.use(require("./routes/entreprises"));


// ═══════════════════════════════════════════════════════════════
// EMAIL STATISTIQUES QUOTIDIENNES (Resend API)
// Variables : RESEND_API_KEY, DAILY_STATS_EMAIL
// ═══════════════════════════════════════════════════════════════

async function sendDailyStatsEmail() {
  if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;

  const [stats, iaStats, subs, decSubs, signals, ideas, settings] = await Promise.all([
    readStats(), readIaStats(), readSubs(), readDechetsSubs(),
    readSignals(), readIdeas(), readAdminSettings()
  ]);

  const todayParis = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  const today      = todayParis;
  const yesterday  = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - 86400000));
  const month      = today.slice(0, 7);
  const prevMonth  = (() => { const d = new Date(today + 'T12:00:00Z'); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();

  const parJour  = stats.parJour  || {};
  const uniqueU  = stats.uniqueUsers || {};
  const services = stats.services || {};

  // Fréquentation
  const uToday   = (uniqueU.byDay   || {})[today]?.length   || 0;
  const uYest    = (uniqueU.byDay   || {})[yesterday]?.length || 0;
  const uMonth   = (uniqueU.byMonth || {})[month]?.length    || 0;
  const uPrevM   = (uniqueU.byMonth || {})[prevMonth]?.length || 0;
  const accessToday  = Object.values(parJour[today]     || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessYest   = Object.values(parJour[yesterday] || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessMonth  = Object.entries(parJour).filter(([d]) => d.startsWith(month)).reduce((s,[,v]) => s + Object.values(v||{}).reduce((a,b)=>a+Number(b||0),0), 0);
  const trend = (a, b) => b > 0 ? (a >= b ? `+${Math.round((a-b)/b*100)}%` : `-${Math.round((b-a)/b*100)}%`) : '';

  // MEL questions
  const melToday   = parJour[today]?.mel   || 0;
  const melYest    = parJour[yesterday]?.mel || 0;
  const melTotal   = services.mel || 0;
  const melLogs    = settings.melQuestionLogEnabled
    ? await redisLRange(`mat:mel:questions:${today}`, 0, 49).catch(() => [])
    : [];

  // IA catégories aujourd'hui
  const iaCatsToday = (stats.iaCategories?.parJour || {})[today] || {};
  const IA_LABELS   = { urbanisme:'🏗️ Urbanisme', dechets:'🗑️ Déchets', meteo:'🌦️ Météo', transport:'🚌 Transport', contact:'📞 Contact', autre:'❓ Autre' };

  // Coût IA du mois
  const monthIa = (iaStats.monthly || {})[month] || {};
  let iaEurMonth = 0;
  for (const [p, d] of Object.entries(monthIa)) { if (p !== '_total') iaEurMonth += d.costEur || 0; }

  // Redis
  let redisInfo = null;
  try { redisInfo = await getUpstashRedisStats(); } catch (_) {}
  if (redisInfo) console.log('[email] Upstash stats keys:', Object.keys(redisInfo).join(', '), '| values sample:', JSON.stringify(Object.fromEntries(Object.entries(redisInfo).filter(([,v])=>typeof v==='number').slice(0,8))));
  // dailyrequests est un tableau timeseries — utiliser les champs scalaires comme dans l'admin
  const redisCmdDay   = typeof redisInfo?.daily_net_commands === 'number'     ? redisInfo.daily_net_commands     : null;
  const redisCmdMonth = typeof redisInfo?.total_monthly_requests === 'number' ? redisInfo.total_monthly_requests : null;
  const redisPctDay   = redisCmdDay !== null ? Math.round(redisCmdDay / 10000 * 100) : null;

  // Questions MEL du jour
  const melQRaw = await redisLRange(`mat:mel:questions:${today}`, 0, -1).catch(() => []);
  const melQuestions = melQRaw.map(s => typeof s === 'object' ? s : (() => { try { return JSON.parse(s); } catch { return { q: String(s), cat: '' }; } })());

  // Signalements / idées en attente
  const pendingSignals = signals.filter(s => !s.status || s.status === 'pending' || s.status === 'new');
  const pendingIdeas   = ideas.filter(i => !i.status || i.status === 'pending' || i.status === 'new');

  // Installations PWA
  const installTotal = services.installation || 0;
  const installToday = parJour[today]?.installation || 0;

  // Services actifs aujourd'hui (hors mel, installation, app_open traités séparément)
  const SVC_LABELS = {
    meteo:'🌦️ Météo', actualites:'📰 Actualités', agenda:'📅 Agenda',
    carburant:'⛽ Carburant', events_locaux:'🎭 Événements locaux',
    dechets:'🗑️ Déchets', sondages:'📊 Sondages', docs:'📄 Documents',
    nums:'📞 Numéros utiles', remi:'🚌 Bus Rémi', conseil:'🏛️ Conseil municipal',
    signalement:'🚨 Signalement', contact:'💬 Contact mairie', idees:'💡 Idées citoyennes',
    app_resume:'↩️ Retours avant-plan',
    transport:'🚌 Transport', urbanisme:'🏗️ Urbanisme', service_public:'🏛️ Service public',
    meteoalert:'⚠️ Alerte météo'
  };
  const svcRows = Object.entries(parJour[today] || {})
    .filter(([k, v]) => v > 0 && k !== 'mel' && k !== 'installation' && k !== 'app_open')
    .sort(([,a],[,b]) => b - a)
    .map(([k, v]) => `<tr><td style="padding:4px 8px">${SVC_LABELS[k] || k}</td><td style="padding:4px 8px;font-weight:700;text-align:right">${v}</td></tr>`)
    .join('');

  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const stat = (val, lbl, cls='') =>
    `<div class="stat${cls ? ' '+cls : ''}"><div class="stat-val">${val}</div><div class="stat-lbl">${lbl}</div></div>`;
  const redisCls = redisPctDay !== null && redisPctDay >= 80 ? 'danger' : redisPctDay !== null && redisPctDay >= 60 ? 'warn' : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#f4f0ea;margin:0;padding:20px}
  .card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #e2ddd8}
  h1{color:#1a3d2b;font-size:1.4rem;margin:0 0 4px}
  .sub{color:#5a7065;font-size:0.85rem;margin-bottom:20px}
  h2{color:#2d6a4f;font-size:1rem;margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .stat{background:#d8f3dc;border-radius:8px;padding:12px;text-align:center}
  .stat-val{font-size:1.5rem;font-weight:900;color:#1a3d2b}
  .stat-lbl{font-size:0.70rem;color:#2d6a4f;margin-top:2px}
  .trend{font-size:0.65rem;color:#5a7065}
  .warn{background:#fef3c7}.danger{background:#fee2e2}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  tr:nth-child(even){background:#f4f0ea}
  .foot{color:#5a7065;font-size:0.75rem;text-align:center;margin-top:16px}
  .q{background:#f4f0ea;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:0.82rem;color:#2d2d2d}
</style></head>
<body>
<h1>📊 MAT — Statistiques</h1>
<div class="sub">${dateLabel}</div>

<div class="card">
  <h2>👤 Fréquentation</h2>
  <div class="grid">
    ${stat(uToday, `Visiteurs uniques aujourd'hui${uYest > 0 ? '<br><span class="trend">'+trend(uToday,uYest)+' vs hier</span>' : ''}`)}
    ${stat(uMonth, `Visiteurs uniques ce mois${uPrevM > 0 ? '<br><span class="trend">'+trend(uMonth,uPrevM)+' vs mois préc.</span>' : ''}`)}
    ${stat(accessToday, `Accès app aujourd'hui${accessYest > 0 ? '<br><span class="trend">'+trend(accessToday,accessYest)+' vs hier</span>' : ''}`)}
    ${stat(accessMonth, 'Accès app ce mois')}
  </div>
</div>

${settings.melUsageStatsEnabled !== false ? `<div class="card">
  <h2>💬 MEL — Chat IA</h2>
  <div class="grid3">
    ${stat(melToday, `Questions aujourd'hui${melYest > 0 ? '<br><span class="trend">'+trend(melToday,melYest)+' vs hier</span>' : ''}`)}
    ${stat(melTotal, 'Total depuis le début')}
    ${stat(iaEurMonth > 0 ? '€'+iaEurMonth.toFixed(2) : '—', 'Coût IA ce mois')}
  </div>
  ${Object.keys(iaCatsToday).length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Catégories aujourd'hui :</strong><br><table style="margin-top:6px">${
    Object.entries(iaCatsToday).sort(([,a],[,b])=>b-a).map(([k,v])=>`<tr><td style="padding:3px 8px">${IA_LABELS[k]||k}</td><td style="padding:3px 8px;font-weight:700;text-align:right">${v}</td></tr>`).join('')
  }</table></div>` : ''}
  ${melLogs.length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Questions du jour (${melLogs.length}) :</strong><div style="margin-top:6px;max-height:200px;overflow:auto">${
    melLogs.map(q => { const txt = typeof q === 'object' ? (q.q || '') : String(q); return `<div class="q">${txt.replace(/</g,'&lt;')}</div>`; }).join('')
  }</div></div>` : ''}
</div>` : ''}

${svcRows ? `<div class="card">
  <h2>🛠️ Services utilisés aujourd'hui</h2>
  <table>${svcRows}</table>
</div>` : ''}

<div class="card">
  <h2>🔔 Abonnements push</h2>
  <div class="grid">
    ${stat(subs.length, 'Abonnés notifications')}
    ${decSubs.length > 0 ? stat(decSubs.length, 'Abonnés rappels déchets') : ''}
    ${stat(installToday > 0 ? `${installToday} / ${installTotal}` : installTotal, installToday > 0 ? "Installations aujourd'hui / total" : 'Installations PWA (total)')}
  </div>
</div>

<div class="card">
  <h2>⚡ Redis Upstash</h2>
  <div class="grid">
    ${stat(redisCmdDay !== null ? redisCmdDay : '—', `Commandes aujourd'hui${redisPctDay !== null ? ' ('+redisPctDay+'% du quota)' : ''}`, redisCls)}
    ${stat(redisCmdMonth !== null ? redisCmdMonth : '—', 'Commandes ce mois')}
  </div>
</div>

<div class="card">
  <h2>🤖 Questions posées à MEL</h2>
  ${melQuestions.length === 0
    ? '<p style="color:#6b7280;font-style:italic;margin:0">Pas de question posée aujourd\'hui.</p>'
    : `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead><tr style="background:#f3f4f6">
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Question</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Réponse MEL</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">Catégorie</th>
        </tr></thead>
        <tbody>${melQuestions.map((q,i) => `
          <tr style="background:${i%2===0?'#fff':'#f9fafb'}">
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${String(q.q||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#374151">${q.a ? String(q.a).replace(/</g,'&lt;').replace(/>/g,'&gt;') : '<span style="color:#9ca3af;font-style:italic">—</span>'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;color:#6b7280">${String(q.cat||'').replace(/</g,'&lt;')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
  }
</div>

${pendingSignals.length > 0 || pendingIdeas.length > 0 ? `<div class="card">
  <h2>📋 En attente de traitement</h2>
  <div class="grid">
    ${pendingSignals.length > 0 ? stat(pendingSignals.length, '🚨 Signalements en attente', 'warn') : ''}
    ${pendingIdeas.length   > 0 ? stat(pendingIdeas.length,   '💡 Idées en attente', 'warn')        : ''}
  </div>
</div>` : ''}

<div class="foot">MAT · Mézières-lez-Cléry · ${new Date().toLocaleDateString('fr-FR', { timeZone:'Europe/Paris' })}</div>
</body></html>`;

  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM || 'MAT Stats <onboarding@resend.dev>',
      to:   [DAILY_STATS_EMAIL],
      subject: `📊 MAT — Stats du ${today}`,
      html
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch(e) {
    const resendMsg = e.response?.data?.message || e.response?.data?.name || JSON.stringify(e.response?.data);
    const status = e.response?.status;
    throw new Error(`Resend ${status}: ${resendMsg || e.message}`);
  }

  console.log(`📧 Email stats quotidien envoyé à ${DAILY_STATS_EMAIL}`);
}

// Envoi quotidien à partir de 22h heure de Paris (vérification toutes les 5 min)
// Fenêtre large : toute heure >= 22h, dédup Redis évite le double-envoi même si le serveur se réveille tard
let _dailyStatsSentToday = null;
setInterval(async () => {
  try {
    if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (pNow.getHours() < 22) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dailyStatsSentToday === today) return;
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) { _dailyStatsSentToday = today; return; }
    await sendDailyStatsEmail();
    _dailyStatsSentToday = today;
    await redisSet('mat:daily:stats:sent', today);
  } catch(e) { console.warn('Daily stats email:', e.message); }
}, 5 * 60 * 1000);

// Helper partagé : envoyer les stats (avec dédup sauf si force=true)
async function _triggerDailyStats(force) {
  if (!RESEND_API_KEY)  throw new Error('RESEND_API_KEY non configuré sur Render');
  if (!DAILY_STATS_EMAIL) throw new Error('DAILY_STATS_EMAIL non configuré');
  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  if (!force) {
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) return { skipped: true, reason: 'Déjà envoyé aujourd\'hui' };
  }
  await sendDailyStatsEmail();
  _dailyStatsSentToday = today;
  await redisSet('mat:daily:stats:sent', today);
  return { sent: true, to: DAILY_STATS_EMAIL };
}

// Endpoint admin (panel admin)
app.get("/admin/stats-email", adminAuth, async (req, res) => {
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/email-config", adminAuth, async (req, res) => {
  try {
    const lastSent = await redisGet('mat:daily:stats:sent');
    res.json({
      resendConfigured: !!RESEND_API_KEY,
      emailConfigured: !!DAILY_STATS_EMAIL,
      email: DAILY_STATS_EMAIL || null,
      lastSent: lastSent || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/upstash-raw", adminAuth, async (req, res) => {
  try {
    const raw = await getUpstashRedisStats();
    res.json({ ok: true, raw });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint cron — accessible avec ?key=CRON_SECRET (pour cron-job.org)
// Configurer CRON_SECRET dans les variables d'env Render
app.get("/cron/stats", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cron vigilance météo — à appeler toutes les 30 min via cron-job.org
// URL : /cron/meteo?key=CRON_SECRET
app.get("/cron/meteo", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const force = req.query.force === "1";
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");

    if (!vigilance || Number(vigilance.level) < AUTO_PUSH_WEATHER_MIN_LEVEL) {
      return res.json({ ok: true, status: "no-alert", level: vigilance?.level ?? null });
    }

    const lastPush = await redisGet("mat:weather:last:push");
    if (!force && isSameWeatherAlert(lastPush, vigilance)) {
      return res.json({ ok: true, status: "duplicate", level: vigilance.level, upcoming: vigilance.upcoming ?? false });
    }

    const pushResult = await sendWeatherPush(vigilance);
    await redisSet("mat:weather:last:push", { ...vigilance, pushedAt: new Date().toISOString() });

    res.json({
      ok: true,
      status: "pushed",
      level: vigilance.level,
      upcoming: vigilance.upcoming ?? false,
      phenomenon: vigilance.phenomenon_label,
      push: pushResult
    });
  } catch(e) {
    console.error("❌ /cron/meteo:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Prix carburant — 3 stations locales ─────────────────────────────────────
// ── Prix carburants — voir routes/carburant.js ────────────────
app.use(require("./routes/carburant"));

// ── Qualité air + Vigicrues Loire — voir routes/env-local.js ─
app.use(require("./routes/env-local"));

// ── Événements locaux OpenAgenda — voir routes/events-locaux.js ──
app.use(require("./routes/events-locaux"));

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