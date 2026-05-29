// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { REDIS_URL, REDIS_TOKEN, ANTHROPIC_API_KEY, MISTRAL_API_KEY, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, MISTRAL_PRICE_IN, MISTRAL_PRICE_OUT } = require("../config");
const { adminAuth } = require("../lib/middleware");
const { pctTrend, calcIaCost, computeIaCategoryTrends } = require("../lib/stats");
const { getParisDateParts } = require("../lib/dates");
const { readStats, readIaStats, readSubs, readNews, readIdeas, readSignals, readAdminSettings } = require("../lib/store");
const { getUpstashRedisStats } = require("../lib/redis");

router.get("/admin/dashboard", adminAuth, async (req, res) => {
  try {
  const [appStats, iaStats, subs, news, ideas, signals, upstashStats, adminSettings] = await Promise.all([
    readStats(),
    readIaStats(),
    readSubs(),
    readNews(),
    readIdeas(),
    readSignals(),
    getUpstashRedisStats(),
    readAdminSettings()
  ]);

    // Taille Redis estimée
    let redisSize = null;
    if (REDIS_URL) {
      try {
        const r = await axios.get(`${REDIS_URL}/info`, {
          headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const info = r.data?.result || "";
        const match = info.match(/used_memory:(\d+)/);
        redisSize = match ? parseInt(match[1]) : null;
      } catch(e) { /* silencieux */ }
    }

    // Stats IA avec coûts
    const iaDaily   = iaStats.daily   || {};
    const iaMonthly = iaStats.monthly || {};

    const enriched = (obj) => {
      const result = {};
      for (const [period, providers] of Object.entries(obj)) {
        result[period] = {};
        for (const [prov, data] of Object.entries(providers)) {
          result[period][prov] = {
            ...data,
            costEur: parseFloat(calcIaCost(prov, data.in, data.out).toFixed(4))
          };
        }
        // Total période
        let totalEur = 0;
        for (const prov of Object.values(result[period])) totalEur += prov.costEur;
        result[period]._total = { costEur: parseFloat(totalEur.toFixed(4)) };
      }
      return result;
    };

    // Crédits Anthropic via API
    let claudeCredits = null;
    if (ANTHROPIC_API_KEY) {
      try {
        const r = await axios.get("https://api.anthropic.com/v1/organizations/usage", {
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          timeout: 8000
        });
        claudeCredits = r.data;
      } catch(e) { claudeCredits = { error: e.message }; }
    }

    // Crédits Mistral via API
    let mistralUsage = null;
    if (MISTRAL_API_KEY) {
      try {
        const r = await axios.get("https://api.mistral.ai/v1/usage", {
          headers: { "Authorization": `Bearer ${MISTRAL_API_KEY}` },
          timeout: 8000
        });
        mistralUsage = r.data;
      } catch(e) { mistralUsage = { error: e.message }; }
    }

    res.json({
      ok: true,
    redis: {
      usedBytes: redisSize,
      usedMB: redisSize ? parseFloat((redisSize / 1024 / 1024).toFixed(2)) : null,
      limitMB: 256,
      pct: redisSize ? parseFloat((redisSize / 1024 / 1024 / 256 * 100).toFixed(1)) : null,

      commands: {
        day: typeof upstashStats?.daily_net_commands === "number" ? upstashStats.daily_net_commands : null,
        month: typeof upstashStats?.total_monthly_requests === "number" ? upstashStats.total_monthly_requests : null,

        readDay: typeof upstashStats?.daily_read_requests === "number" ? upstashStats.daily_read_requests : null,
        writeDay: typeof upstashStats?.daily_write_requests === "number" ? upstashStats.daily_write_requests : null,

        readMonth: typeof upstashStats?.total_monthly_read_requests === "number" ? upstashStats.total_monthly_read_requests : null,
        writeMonth: typeof upstashStats?.total_monthly_write_requests === "number" ? upstashStats.total_monthly_write_requests : null,

        limitDay: 10000,
        limitMonth: 500000,

        pctDay:
          typeof upstashStats?.daily_net_commands === "number"
            ? parseFloat((upstashStats.daily_net_commands / 10000 * 100).toFixed(1))
            : null,

        pctMonth:
          typeof upstashStats?.total_monthly_requests === "number"
            ? parseFloat((upstashStats.total_monthly_requests / 500000 * 100).toFixed(1))
            : null,

        error: upstashStats?.error || null
      },

      keys: {
        subs: subs.length,
        actus: news.length,
        ideas: ideas.length,
        signals: signals.length
      }
    },
      ia: {
        daily:   enriched(iaDaily),
        monthly: enriched(iaMonthly),
        claude:  { credits: claudeCredits, priceIn: CLAUDE_PRICE_IN, priceOut: CLAUDE_PRICE_OUT },
        mistral: { usage: mistralUsage,    priceIn: MISTRAL_PRICE_IN, priceOut: MISTRAL_PRICE_OUT }
      },
      app: (() => {
        const nowParts = getParisDateParts();
        const today = nowParts.day;
        const month = nowParts.month;
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(yesterdayDate);
        const yGet = t => yFmt.find(p => p.type === t)?.value || '';
        const yesterday = `${yGet('year')}-${yGet('month')}-${yGet('day')}`;
        const prevMonthDate = new Date();
        prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
        const pFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(prevMonthDate);
        const pGet = t => pFmt.find(p => p.type === t)?.value || '';
        const prevMonth = `${pGet('year')}-${pGet('month')}`;
        const uniqueToday = (appStats.uniqueUsers?.byDay?.[today] || []).length;
        const uniqueMonth = (appStats.uniqueUsers?.byMonth?.[month] || []).length;
        const uniqueYesterday = (appStats.uniqueUsers?.byDay?.[yesterday] || []).length;
        const uniquePrevMonth = (appStats.uniqueUsers?.byMonth?.[prevMonth] || []).length;
        const dayAccess = Object.values(appStats.parJour?.[today] || {}).reduce((a,b) => a + Number(b || 0), 0);
        const prevDayAccess = Object.values(appStats.parJour?.[yesterday] || {}).reduce((a,b) => a + Number(b || 0), 0);
        const monthAccess = Object.entries(appStats.parJour || {}).filter(([d]) => d.startsWith(month)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
        const prevMonthAccess = Object.entries(appStats.parJour || {}).filter(([d]) => d.startsWith(prevMonth)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
        return {
          totalAcces: appStats.totalAcces || 0,
          totalInstalls: appStats.services?.installation || 0,
          parService: appStats.services || {},
          parJour: appStats.parJour || {},
          overview: {
            today, month,
            uniqueToday, uniqueMonth, uniqueYesterday, uniquePrevMonth,
            uniqueTrendDay: pctTrend(uniqueToday, uniqueYesterday),
            uniqueTrendMonth: pctTrend(uniqueMonth, uniquePrevMonth),
            accessToday: dayAccess,
            accessYesterday: prevDayAccess,
            accessMonth: monthAccess,
            accessPrevMonth: prevMonthAccess,
            accessTrendDay: pctTrend(dayAccess, prevDayAccess),
            accessTrendMonth: pctTrend(monthAccess, prevMonthAccess)
          },
          uniqueUsers: { total: appStats.uniqueUsers?.total || 0, today: uniqueToday, month: uniqueMonth, byDay: Object.fromEntries(Object.entries(appStats.uniqueUsers?.byDay || {}).map(([d, ids]) => [d, Array.isArray(ids) ? ids.length : 0])) },
          devices: {
            today: appStats.deviceStats?.byDay?.[today] || {},
            month: appStats.deviceStats?.byMonth?.[month] || {},
            appOpensByDay: appStats.deviceStats?.appOpensByDay || {},
            appOpensByMonth: appStats.deviceStats?.appOpensByMonth || {}
          }
        };
      })(),
      iaCategories: {
        total:   appStats.iaCategories?.total   || {},
        parJour: appStats.iaCategories?.parJour || {},
        parMois: appStats.iaCategories?.parMois || {},
        sources: appStats.iaCategories?.sources || {},
        trends:  computeIaCategoryTrends(appStats.iaCategories?.parJour || {})
      },
      settings: adminSettings
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
