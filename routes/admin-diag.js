// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const {
  PAGE_ACCESS_TOKEN, MISTRAL_API_KEY, MISTRAL_MODEL, MISTRAL_URL,
  REDIS_URL, REDIS_TOKEN, METEOFRANCE_VIGILANCE_URL, OPEN_METEO_TZ,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, TRELLO_KEY, TRELLO_TOKEN,
  TRELLO_LIST_ID_BUG, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_DEMANDE,
  GOOGLE_CALENDAR_ICAL
} = require("../config");
const { adminAuth } = require("../lib/middleware");
const { getGoogleCalendarClient } = require("../lib/calendar");
const { getCachedMeteoForecast, fetchMeteoFranceVigilanceRaw, extractDepartmentVigilance } = require("../lib/meteo");
const { resolveFacebookPageId } = require("../lib/facebook");
const { redisGet, redisSet, _isRedis429 } = require("../lib/redis");
const { readSubs } = require("../lib/store");
const { remiCache, calendarCache, CACHE_MS, refreshCalendarCache } = require("../lib/mel");

// ── Route setup webhook// ── Route setup webhook (à appeler une seule fois) ───────────
router.get("/setup-webhook", adminAuth, async (req, res) => {
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

router.get("/ping", (req, res) => {
  res.type("text/plain").send("ok");
});

router.get("/health", (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const degraded = _isRedis429();
  res.json({ ok: true, redis: !degraded, mode: degraded ? 'degraded' : 'normal' });
});

// ── Diagnostic Mistral (à supprimer après test) ───────────────
router.get("/debug-mistral", adminAuth, async (req, res) => {
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
router.get("/debug-calendar", adminAuth, async (req, res) => {
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

router.get("/admin/services/test", adminAuth, async (req, res) => {
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

  // Webhook ENTRANT : c'est ce qui fait remonter les posts Facebook #MAT
  // vers les actualités du PWA. Deux causes de panne silencieuse (aucun log) :
  //  1) la Page n'est plus abonnée au champ "feed" (typique après
  //     régénération du token) → Facebook n'appelle plus le webhook ;
  //  2) FACEBOOK_APP_SECRET manquant → le handler rejette chaque appel en
  //     503 avant tout log (cf. routes/webhook.js).
  services.push(await runCheck("webhook", "Webhook Facebook (entrant)", "📡", async () => {
    const hasAppSecret = !!process.env.FACEBOOK_APP_SECRET;
    if (!PAGE_ACCESS_TOKEN) {
      return {
        status: "warn",
        message: "Facebook non configuré (pas de token de page)",
        details: { has_page_token: false, has_app_secret: hasAppSecret }
      };
    }

    const pageId = await resolveFacebookPageId();
    if (!pageId) throw new Error("Impossible de résoudre l'identifiant de page");

    const subRes = await axios.get(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 }
    );
    const apps = subRes.data?.data || [];
    const feedSubscribed = apps.some(a =>
      (a.subscribed_fields || []).some(f => (typeof f === "string" ? f : f?.name) === "feed")
    );

    const details = {
      subscribed_apps: apps.length,
      app_names: apps.map(a => a.name).filter(Boolean),
      feed_subscribed: feedSubscribed,
      has_app_secret: hasAppSecret
    };

    if (!feedSubscribed) {
      return {
        status: "danger",
        message: "Page NON abonnée au champ « feed » — les posts #MAT ne remontent pas. Ré-abonnement nécessaire (route /setup-webhook).",
        details
      };
    }
    if (!hasAppSecret) {
      return {
        status: "danger",
        message: "Abonné au feed, mais FACEBOOK_APP_SECRET manquant → les appels Facebook sont rejetés en silence (503). Définir la variable sur Render.",
        details
      };
    }
    return {
      status: "ok",
      message: "Webhook abonné au « feed » — les posts #MAT peuvent remonter",
      details
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

module.exports = router;
