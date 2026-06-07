// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { GOOGLE_CALENDAR_ICAL } = require("../config");
const { _isRedis429 } = require("../lib/redis");
const { readSubs, readNews, readIdeas, readSignals } = require("../lib/store");

router.get("/", (req, res) => {
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
router.get("/status", async (req, res) => {
  const [subs, news, ideas, signals] = await Promise.all([
    readSubs(), readNews(), readIdeas(), readSignals()
  ]);

  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.5 — Mistral principal + Claude secours + MEL améliorée",
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
router.get("/calendar-proxy", async (req, res) => {
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

module.exports = router;
