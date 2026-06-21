// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { getCachedMeteoForecast, fetchMeteoFranceVigilanceRaw, extractDepartmentVigilance, sendWeatherPush, publishWeatherAlertToFacebook, weatherAlertSignature, claimWeatherPush, releaseWeatherPushClaim, claimWeatherFacebookPost, releaseWeatherFacebookPost } = require("../lib/meteo");
const { readLastWeatherAlert, writeLastWeatherAlert } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { AUTO_POST_WEATHER_ALERTS, AUTO_POST_MIN_LEVEL, AUTO_PUSH_WEATHER_MIN_LEVEL } = require("../config");

router.get('/meteo/forecast', async (req, res) => {
  try {
    const result = await getCachedMeteoForecast({ allowStale: true });
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      ...result.data,
      stale: result.stale,
      cacheTime: result.cacheTime,
      source: result.source
    });
  } catch (e) {
    console.error('[meteo/forecast] error:', e.message);
    res.set('Access-Control-Allow-Origin', '*');
    res.status(503).json({ error: 'Météo indisponible', detail: e.message });
  }
});

router.get("/meteo/commune", async (req, res) => {
  try {
    const [forecastResult, rawVigilance] = await Promise.all([
      getCachedMeteoForecast({ allowStale: true }),
      fetchMeteoFranceVigilanceRaw().catch(() => null),
    ]);

    const vigilance = extractDepartmentVigilance(rawVigilance, "45");
    res.json({
      forecast: forecastResult.data,
      vigilance,
      stale: forecastResult.stale,
      cacheTime: forecastResult.cacheTime,
      source: forecastResult.source
    });
  } catch (e) {
    console.error("❌ /meteo/commune:", e.message);
    res.status(500).json({ error: "Météo indisponible", detail: e.message });
  }
});

router.get("/meteo/alertes/check", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");

    if (!vigilance) {
      return res.json({ status: "no-alert" });
    }

    // Notification push pour niveau >= AUTO_PUSH_WEATHER_MIN_LEVEL (2 = jaune par défaut)
    let pushResult = null;
    if (Number(vigilance.level) >= AUTO_PUSH_WEATHER_MIN_LEVEL) {
      // Une seule notification par alerte distincte : on ne re-pousse que si la
      // signature (niveau+phénomène+fin) diffère de la dernière poussée. Les
      // habitants ne sont pas re-notifiés d'une alerte inchangée qu'ils connaissent.
      const lastPush = await redisGet("mat:weather:last:push");
      const alreadyPushed = !force && lastPush && weatherAlertSignature(lastPush) === weatherAlertSignature(vigilance);
      // claimWeatherPush = garde anti-course (deux crons concurrents).
      if (!alreadyPushed && await claimWeatherPush(vigilance, force)) {
        try {
          pushResult = await sendWeatherPush(vigilance);
          await redisSet("mat:weather:last:push", { ...vigilance, pushedAt: new Date().toISOString() });
        } catch (pe) {
          console.warn("Weather push error:", pe.message);
          await releaseWeatherPushClaim(vigilance); // libère pour réessayer au prochain tick
        }
      }
    }

    // Post Facebook pour niveau >= AUTO_POST_MIN_LEVEL (3 = orange par défaut)
    if (Number(vigilance.level) < AUTO_POST_MIN_LEVEL) {
      return res.json({ status: "below-threshold", vigilance, push: pushResult });
    }

    // Déduplication durable du post Facebook : on ne reposte QUE si l'alerte a
    // réellement changé (signature niveau+phénomène+fin différente de la dernière
    // postée). Pas de fenêtre temporelle → une alerte inchangée qui dure plusieurs
    // jours n'est postée qu'une fois (contrairement au push, rappelé toutes les 12h).
    const last = await readLastWeatherAlert();
    if (!force && last && weatherAlertSignature(last) === weatherAlertSignature(vigilance)) {
      return res.json({ status: "duplicate", vigilance, push: pushResult });
    }

    let published = false;
    let message = null;

    if (AUTO_POST_WEATHER_ALERTS || force) {
      // Réservation atomique du post Facebook : empêche deux vérifications
      // concurrentes de poster deux fois la même alerte (la comparaison de
      // signature ci-dessus n'est PAS atomique — deux appels peuvent la franchir
      // ensemble avant que mat:weather:last soit écrit). Verrou distinct du push.
      if (!await claimWeatherFacebookPost(vigilance, force)) {
        return res.json({ status: "duplicate", vigilance, push: pushResult });
      }
      try {
        message = await publishWeatherAlertToFacebook(vigilance);
        published = true;
        await writeLastWeatherAlert(vigilance);
      } catch (pubErr) {
        // Échec du post : libère la réservation pour réessayer au prochain tick.
        await releaseWeatherFacebookPost(vigilance);
        throw pubErr;
      }
    } else {
      await writeLastWeatherAlert(vigilance);
    }

    res.json({
      status: published ? "published" : "stored",
      vigilance,
      message,
      push: pushResult,
    });
  } catch (e) {
    console.error("ALERTE METEO ERROR =", {
      status: e.response?.status,
      data: e.response?.data,
      message: e.message
    });

    if (e.response?.status === 401) {
      return res.json({
        status: "auth-error",
        source: "meteo-france",
        details: "Token vigilance invalide"
      });
    }

    res.status(e.response?.status || 500).json({
      error: "Contrôle alerte impossible",
      details: e.response?.data || e.message
    });
  }
});

module.exports = router;
