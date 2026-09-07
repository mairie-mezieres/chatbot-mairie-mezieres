// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const {
  MISTRAL_PRICE_IN, MISTRAL_PRICE_OUT,
  CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, EUR_PER_USD
} = require("../config");
const { readIaStats, writeIaStats } = require("./store");

// ── Helpers stats service / device ───────────────────────────
function shouldTrackService(service, settings) {
  if (service === "installation") return true;
  if (service === "mel") return settings.melUsageStatsEnabled !== false;
  if (service === "app_open") return settings.appOpenStatsEnabled !== false;
  return settings.detailedStatsEnabled !== false;
}

function shouldTrackDeviceBreakdown(service, settings) {
  if (service === "app_open") return settings.appOpenStatsEnabled !== false;
  if (service === "mel") return settings.melUsageStatsEnabled !== false;
  return settings.detailedStatsEnabled !== false;
}

function pctTrend(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function incStat(obj, key, inc = 1) { obj[key] = (obj[key] || 0) + inc; }

function sanitizeDeviceInfo(device = {}) {
  const clean = (v, max = 80, fallback = 'Inconnu') => String(v || fallback).trim().substring(0, max) || fallback;
  return {
    type: clean(device.type, 60),
    model: clean(device.model, 80),
    os: clean(device.os, 80),
    browser: clean(device.browser, 80),
    screen: clean(device.screen, 30),
    pwa: clean(device.pwa, 30),
    matVersion: clean(device.matVersion || device.appVersion, 30, 'Inconnue')
  };
}

function bumpDeviceBreakdown(target, device) {
  if (!target.types) target.types = {};
  if (!target.models) target.models = {};
  if (!target.os) target.os = {};
  if (!target.browsers) target.browsers = {};
  if (!target.pwa) target.pwa = {};
  if (!target.screens) target.screens = {};
  if (!target.appVersions) target.appVersions = {};
  incStat(target.types, device.type);
  incStat(target.models, device.model);
  incStat(target.os, device.os);
  incStat(target.browsers, device.browser);
  incStat(target.pwa, device.pwa);
  incStat(target.screens, device.screen);
  incStat(target.appVersions, device.matVersion);
}

function compactSeenMap(mapObj = {}, keepKeys = []) {
  const keep = new Set(keepKeys);
  for (const k of Object.keys(mapObj)) if (!keep.has(k)) delete mapObj[k];
}

// ── Décomposition d'une journée de `stats.parJour` ───────────
// ⛔ Trois compteurs de `parJour` ne sont PAS des services, et les mélanger
// rend le mail quotidien incompréhensible :
//   • `app_open`   — le lancement de l'app, émis une fois par appareil et par
//     jour, donc le plus nombreux de la journée (≈ le nombre de visiteurs
//     uniques). Il était exclu du tableau des services ET fondu dans un total
//     appelé « Accès app » : le mail du 6 septembre 2026 affichait 182 visiteurs
//     uniques pour un top des services plafonnant à 36, sans rien pour
//     l'expliquer. ⚠️ Son comptage est optionnel (réglage « Ouvertures de
//     l'application ») alors que le visiteur unique, lui, est TOUJOURS
//     enregistré (`routes/stats-public.js`) — coupé, il vaut 0 et le trou
//     s'agrandit encore, toujours en silence.
//   • `app_resume` — un retour en avant-plan, signal de navigation : il prenait
//     la 1re place du classement (79 le 6 septembre, devant Actualités à 36) et
//     écrasait le vrai n° 1.
//   • `installation` — déjà porté par sa propre carte, et ce n'est pas un écran.
const NON_SERVICE_KEYS = ["app_open", "app_resume", "mel", "installation"];

function splitDayStats(dayMap) {
  const map = dayMap || {};
  const num = (k) => Number(map[k] || 0);
  return {
    opens: num("app_open"),
    resumes: num("app_resume"),
    mel: num("mel"),
    installations: num("installation"),
    // Écrans ouverts : MEL et les services. Ni un lancement, ni un retour en
    // avant-plan, ni une installation — aucun des trois n'ouvre un écran.
    screens: Object.entries(map)
      .filter(([k]) => k !== "app_open" && k !== "app_resume" && k !== "installation")
      .reduce((a, [, v]) => a + Number(v || 0), 0),
    // Classement affiché : uniquement de vraies fonctionnalités.
    services: Object.entries(map)
      .filter(([k, v]) => Number(v) > 0 && !NON_SERVICE_KEYS.includes(k))
      .sort(([, a], [, b]) => Number(b) - Number(a))
  };
}

// ── Tracking tokens IA ────────────────────────────────────────
async function trackIaTokens(provider, inputTokens, outputTokens) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const stats = await readIaStats();

  if (!stats.daily)   stats.daily   = {};
  if (!stats.monthly) stats.monthly = {};

  if (!stats.daily[today])             stats.daily[today] = {};
  if (!stats.daily[today][provider])   stats.daily[today][provider] = { in: 0, out: 0, calls: 0 };
  stats.daily[today][provider].in    += inputTokens;
  stats.daily[today][provider].out   += outputTokens;
  stats.daily[today][provider].calls += 1;

  if (!stats.monthly[month])            stats.monthly[month] = {};
  if (!stats.monthly[month][provider])  stats.monthly[month][provider] = { in: 0, out: 0, calls: 0 };
  stats.monthly[month][provider].in    += inputTokens;
  stats.monthly[month][provider].out   += outputTokens;
  stats.monthly[month][provider].calls += 1;

  const days = Object.keys(stats.daily).sort().slice(-366);
  const months = Object.keys(stats.monthly).sort().slice(-13);
  stats.daily   = Object.fromEntries(days.map(k => [k, stats.daily[k]]));
  stats.monthly = Object.fromEntries(months.map(k => [k, stats.monthly[k]]));

  await writeIaStats(stats);
}

function calcIaCost(provider, inTokens, outTokens) {
  if (provider === "mistral") {
    return (inTokens / 1_000_000 * MISTRAL_PRICE_IN) + (outTokens / 1_000_000 * MISTRAL_PRICE_OUT);
  }
  if (provider === "claude") {
    const usd = (inTokens / 1_000_000 * CLAUDE_PRICE_IN) + (outTokens / 1_000_000 * CLAUDE_PRICE_OUT);
    return usd * EUR_PER_USD;
  }
  return 0;
}

function computeIaCategoryTrends(parJour = {}) {
  const days = Object.keys(parJour).sort();
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);

  function sumDays(selectedDays) {
    const out = {};
    for (const day of selectedDays) {
      const cats = parJour[day] || {};
      for (const [cat, n] of Object.entries(cats)) {
        out[cat] = (out[cat] || 0) + Number(n || 0);
      }
    }
    return out;
  }

  const current = sumDays(last7);
  const previous = sumDays(prev7);

  return [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map(cat => {
      const nowVal = current[cat] || 0;
      const prevVal = previous[cat] || 0;
      const diff = nowVal - prevVal;
      const pct = prevVal > 0 ? ((diff / prevVal) * 100) : (nowVal > 0 ? 100 : 0);
      return {
        category: cat,
        current: nowVal,
        previous: prevVal,
        diff,
        pct: Number(pct.toFixed(1))
      };
    })
    .sort((a, b) => (b.diff - a.diff) || (b.current - a.current) || a.category.localeCompare(b.category));
}

module.exports = {
  shouldTrackService, shouldTrackDeviceBreakdown,
  pctTrend, incStat, sanitizeDeviceInfo, bumpDeviceBreakdown, compactSeenMap,
  NON_SERVICE_KEYS, splitDayStats,
  trackIaTokens, calcIaCost, computeIaCategoryTrends
};
