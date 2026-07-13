// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { REDIS_URL, REDIS_TOKEN } = require("../config");
const { readAdminSettings, readStats, writeStats } = require("../lib/store");
const { redisGet, redisPipeline, redisLRange } = require("../lib/redis");
const { getParisDateParts } = require("../lib/dates");
const { capStr, finiteNum, inEnum } = require("../lib/validate");
const { adminAuth } = require("../lib/middleware");
const {
  shouldTrackService, shouldTrackDeviceBreakdown,
  pctTrend, sanitizeDeviceInfo, bumpDeviceBreakdown, compactSeenMap
} = require("../lib/stats");

// ── Stats usage ──────────────────────────────────────────────
router.post("/stats/track", async (req, res) => {
  let { service, device } = req.body || {};
  if (!service) return res.status(400).json({ error: "service requis" });
  service = String(service).substring(0, 60);

  const settings = await readAdminSettings();
  const trackService = shouldTrackService(service, settings);
  const trackBreakdown = shouldTrackDeviceBreakdown(service, settings);

  const stats = await readStats();
  const { day: today, month } = getParisDateParts();
  let changed = false;

  // ── 1) Compteurs de service / accès (optionnels selon réglages)
  if (trackService) {
    if (!stats.services) stats.services = {};
    if (!stats.parJour) stats.parJour = {};
    if (!stats.parJour[today]) stats.parJour[today] = {};

    stats.services[service] = (stats.services[service] || 0) + 1;
    stats.parJour[today][service] = (stats.parJour[today][service] || 0) + 1;
    stats.totalAcces = (stats.totalAcces || 0) + 1;
    changed = true;
  }

  // ── 2) Visiteurs uniques : TOUJOURS gardés
  const _rawDev = req.headers["x-device-id"] || req.body?.deviceId || null;
  const deviceId = _rawDev ? String(_rawDev).substring(0, 100) : null;
  if (deviceId) {
    try {
      if (!stats.uniqueUsers) {
        stats.uniqueUsers = { total: 0, byDay: {}, byMonth: {}, allDevices: [] };
      }
      const u = stats.uniqueUsers;
      if (!u.byDay[today]) u.byDay[today] = [];
      if (!u.byMonth[month]) u.byMonth[month] = [];
      if (!Array.isArray(u.allDevices)) u.allDevices = [];

      if (!u.byDay[today].includes(deviceId)) {
        u.byDay[today].push(deviceId);
        changed = true;
      }
      if (!u.byMonth[month].includes(deviceId)) {
        u.byMonth[month].push(deviceId);
        changed = true;
      }
      if (!u.allDevices.includes(deviceId)) {
        u.allDevices.push(deviceId);
        changed = true;
      }
      u.total = u.allDevices.length;

      // ── 3) Breakdown appareils / ouvertures app : optionnels
      if (trackBreakdown) {
        if (!stats.deviceStats) {
          stats.deviceStats = {
            byDay: {},
            byMonth: {},
            daySeen: {},
            monthSeen: {},
            appOpensByDay: {},
            appOpensByMonth: {}
          };
        }

        const ds = stats.deviceStats;
        if (!ds.daySeen[today]) ds.daySeen[today] = {};
        if (!ds.monthSeen[month]) ds.monthSeen[month] = {};
        if (!ds.byDay[today]) ds.byDay[today] = {};
        if (!ds.byMonth[month]) ds.byMonth[month] = {};
        if (!ds.appOpensByDay) ds.appOpensByDay = {};
        if (!ds.appOpensByMonth) ds.appOpensByMonth = {};

        let cleanDevice;
        if (device) {
          cleanDevice = sanitizeDeviceInfo(device);
        } else if (ds.daySeen[today][deviceId]) {
          cleanDevice = ds.daySeen[today][deviceId];
        } else if (ds.monthSeen[month][deviceId]) {
          cleanDevice = ds.monthSeen[month][deviceId];
        } else {
          cleanDevice = sanitizeDeviceInfo({});
        }

        if (!ds.daySeen[today][deviceId]) {
          ds.daySeen[today][deviceId] = cleanDevice;
          bumpDeviceBreakdown(ds.byDay[today], cleanDevice);
          changed = true;
        }

        if (!ds.monthSeen[month][deviceId]) {
          ds.monthSeen[month][deviceId] = cleanDevice;
          bumpDeviceBreakdown(ds.byMonth[month], cleanDevice);
          changed = true;
        }

        // Nombre d'ouvertures d'app : option dédiée
        if (service === "app_open" && settings.appOpenStatsEnabled !== false) {
          ds.appOpensByDay[today] = (ds.appOpensByDay[today] || 0) + 1;
          ds.appOpensByMonth[month] = (ds.appOpensByMonth[month] || 0) + 1;
          changed = true;
        }

        const keepDays = Object.keys(ds.daySeen).sort().slice(-90);
        compactSeenMap(ds.daySeen, keepDays);
        compactSeenMap(ds.byDay, keepDays);
        compactSeenMap(ds.appOpensByDay, keepDays);

        const keepMonths = Object.keys(ds.monthSeen).sort().slice(-24);
        compactSeenMap(ds.monthSeen, keepMonths);
        compactSeenMap(ds.byMonth, keepMonths);
        compactSeenMap(ds.appOpensByMonth, keepMonths);
      }
    } catch (e) {
      console.warn("stats/track unique device:", e.message);
    }
  }

  if (changed) {
    await writeStats(stats);
  }

  res.json({
    success: true,
    trackedService: trackService,
    settings
  });
});

// ── Profils du kit de réplication « Partager » ───────────────
// Envoyé par app-mezieres/js/mat-partager.js à la génération du prompt :
// nom de commune, population, budget et niveau informatique déclarés.
// Données non nominatives (profil de collectivité). Liste Redis plafonnée,
// restituée dans le mail quotidien (routes/admin-email.js) et via
// GET /admin/partager-profils.
const PARTAGER_PROFILS_KEY = "mat:partager:profils";
const PARTAGER_PROFILS_MAX = 500;

const _partagerLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de requêtes, réessayez dans une minute." }
});

router.post("/stats/partager", _partagerLimiter, async (req, res) => {
  const b = req.body || {};
  const commune = capStr(b.commune, 120).trim();
  if (!commune) return res.status(400).json({ error: "commune requise" });

  const population = finiteNum(b.population);
  const budget = finiteNum(b.budget);
  const entry = {
    commune,
    population: population !== null && population >= 0 ? Math.round(population) : null,
    budget: budget !== null && budget >= 0 ? Math.round(budget) : null,
    niveau: inEnum(b.niveau, ["debutant", "intermediaire"]) || "debutant",
    sovereign: b.sovereign === true,
    host: capStr(b.host, 40),
    date: new Date().toISOString()
  };

  // Écriture best-effort : la réponse ne dépend jamais de Redis (cf. CLAUDE.md).
  redisPipeline([
    ["LPUSH", PARTAGER_PROFILS_KEY, JSON.stringify(entry)],
    ["LTRIM", PARTAGER_PROFILS_KEY, "0", String(PARTAGER_PROFILS_MAX - 1)]
  ]).catch(() => {});

  res.json({ success: true });
});

// Lecture admin : liste complète des profils collectés (plus récent en premier)
router.get("/admin/partager-profils", adminAuth, async (req, res) => {
  try {
    const profils = await redisLRange(PARTAGER_PROFILS_KEY, 0, PARTAGER_PROFILS_MAX - 1);
    res.json({ ok: true, count: profils.length, profils });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/stats", async (req, res) => {
  const stats = await readStats();
  const parJour = stats.parJour || {};
  const { day: today, month } = getParisDateParts();
  const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(yesterdayDate);
  const yGet = t => yFmt.find(p => p.type === t)?.value || '';
  const yesterday = `${yGet('year')}-${yGet('month')}-${yGet('day')}`;
  const prevMonthDate = new Date(); prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
  const pFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(prevMonthDate);
  const pGet = t => pFmt.find(p => p.type === t)?.value || '';
  const prevMonth = `${pGet('year')}-${pGet('month')}`;
  const installations = Object.entries(parJour).sort(([a],[b]) => b.localeCompare(a)).slice(0, 30).map(([date, svcs]) => ({ date, installations: svcs.installation || 0, acces: Object.values(svcs).reduce((s,v)=>s+v,0) }));
  const accessToday = Object.values(parJour[today] || {}).reduce((a,b) => a + Number(b || 0), 0);
  const accessYesterday = Object.values(parJour[yesterday] || {}).reduce((a,b) => a + Number(b || 0), 0);
  const accessMonth = Object.entries(parJour).filter(([d]) => d.startsWith(month)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
  const accessPrevMonth = Object.entries(parJour).filter(([d]) => d.startsWith(prevMonth)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
  res.json({
    totalAcces: stats.totalAcces || 0,
    totalInstalls: stats.services?.installation || 0,
    parService: stats.services || {},
    derniers30jours: installations,
    uniqueUsers: {
      total: stats.uniqueUsers?.total || 0,
      byDay: stats.uniqueUsers?.byDay || {},
      byMonth: stats.uniqueUsers?.byMonth || {}
      // allDevices supprimé pour RGPD
    },
    deviceStats: stats.deviceStats || {},
    overview: {
      today, month,
      uniqueToday: (stats.uniqueUsers?.byDay?.[today] || []).length,
      uniqueMonth: (stats.uniqueUsers?.byMonth?.[month] || []).length,
      uniqueYesterday: (stats.uniqueUsers?.byDay?.[yesterday] || []).length,
      uniquePrevMonth: (stats.uniqueUsers?.byMonth?.[prevMonth] || []).length,
      accessToday, accessYesterday, accessMonth, accessPrevMonth,
      uniqueTrendDay: pctTrend((stats.uniqueUsers?.byDay?.[today] || []).length, (stats.uniqueUsers?.byDay?.[yesterday] || []).length),
      uniqueTrendMonth: pctTrend((stats.uniqueUsers?.byMonth?.[month] || []).length, (stats.uniqueUsers?.byMonth?.[prevMonth] || []).length),
      accessTrendDay: pctTrend(accessToday, accessYesterday),
      accessTrendMonth: pctTrend(accessMonth, accessPrevMonth)
    }
  });
});

// ── Route : compteur public installations ────────────────────
router.get("/api/install-count", async (req, res) => {
  try {
    const cached = await redisGet("mat:install_count_cache");
    if (cached !== null && cached !== undefined) {
      return res.json({ count: parseInt(cached) || 0 });
    }
    const stats = await readStats();
    const count = stats.services?.installation || 0;
    if (REDIS_URL) {
      try {
        const key = encodeURIComponent("mat:install_count_cache");
        await axios.post(
          `${REDIS_URL}/setex/${key}/86400`,
          JSON.stringify(count),
          { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, timeout: 8000 }
        );
      } catch (e) { console.warn("install-count cache set:", e.message); }
    }
    res.json({ count });
  } catch (e) {
    console.error("install-count error:", e.message);
    res.json({ count: 0 });
  }
});

module.exports = router;
