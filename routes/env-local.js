// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { redisGet, redisSetex } = require("../lib/redis");

// ─── Environnement local — Open-Meteo Air Quality + Vigicrues Loire ────────
const ENV_LOCAL_REDIS_KEY = 'mat:env-local:v4';
const ENV_LOCAL_TTL_S     = 900; // 15 min
const LAT_MEZIERES        = 47.79;
const LON_MEZIERES        = 1.80;
const LOIRE_STATIONS      = ['K441409001', 'K435001010']; // Meung-sur-Loire → Orléans

function _aqiLabel(v) {
  if (v == null) return null;
  if (v < 20)  return 'Bon';
  if (v < 40)  return 'Moyen';
  if (v < 60)  return 'Dégradé';
  if (v < 80)  return 'Mauvais';
  if (v < 100) return 'Très mauvais';
  return 'Extrêmement mauvais';
}

function _pollenLabel(v) {
  if (v == null) return null;
  if (v < 1)   return 'Nul';
  if (v < 10)  return 'Faible';
  if (v < 50)  return 'Modéré';
  if (v < 100) return 'Élevé';
  return 'Très élevé';
}

router.get('/env-local', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const cached = await redisGet(ENV_LOCAL_REDIS_KEY);
    if (cached && cached._ts && Date.now() - cached._ts < ENV_LOCAL_TTL_S * 1000) return res.json(cached);

    const data = { _ts: Date.now(), loire: null, aqi: null, pollen: null };

    // Open-Meteo Air Quality — AQI européen + pollens
    try {
      const omRes = await axios.get(
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT_MEZIERES}&longitude=${LON_MEZIERES}&current=european_aqi,alder_pollen,birch_pollen,grass_pollen,olive_pollen,ragweed_pollen,mugwort_pollen&timezone=Europe%2FParis`,
        { timeout: 8000 }
      );
      const c = (omRes.data || {}).current || {};
      if (c.european_aqi != null) {
        data.aqi = { label: _aqiLabel(c.european_aqi), valeur: Math.round(c.european_aqi) };
      }
      const pollens = ['alder_pollen','birch_pollen','grass_pollen','olive_pollen','ragweed_pollen','mugwort_pollen']
        .map(k => c[k]).filter(v => v != null && !isNaN(v));
      if (pollens.length) {
        const max = Math.max.apply(null, pollens);
        data.pollen = { label: _pollenLabel(max), niveau: Math.round(max * 10) / 10 };
      }
    } catch(e) { console.error('❌ Open-Meteo Air:', e.message); }

    // Vigicrues — Meung-sur-Loire (K441409001) avec repli Orléans (K435001010)
    for (const stCode of LOIRE_STATIONS) {
      try {
        const vR = await axios.get(
          `https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro=${stCode}&GrdSerie=H&NbObsHydro=1&FormatDate=iso`,
          { timeout: 8000 }
        );
        const serie = (vR.data || {}).Serie || {};
        const obs = serie.ObssHydro || [];
        const last = obs[obs.length - 1] || obs[0];
        let value = null;
        if (Array.isArray(last)) value = last[1];
        else if (last && typeof last === 'object') value = last.ResObsHydro != null ? last.ResObsHydro : last.value;
        if (value != null && !isNaN(value)) {
          const seuils = {};
          ['NivSeuil1','NivSeuil2','NivSeuil3','NivSeuil4'].forEach((k, i) => {
            const v = serie[k]; if (v != null && !isNaN(v)) seuils['seuil' + (i + 1)] = Math.round(parseFloat(v) * 100) / 100;
          });
          data.loire = { hauteur: Math.round(value * 100) / 100, station: stCode, seuils: Object.keys(seuils).length ? seuils : null };
          break;
        }
      } catch(e) { console.error(`❌ Vigicrues Loire ${stCode}:`, e.message); }
    }

    await redisSetex(ENV_LOCAL_REDIS_KEY, ENV_LOCAL_TTL_S, data);
    res.json(data);
  } catch(e) {
    console.error('❌ /env-local:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
