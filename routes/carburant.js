// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { redisGet, redisSetex } = require("../lib/redis");
const { memGet, memSet } = require("../lib/store");
const { dlog } = require("../lib/middleware");
const { CARBURANT_STATIONS, pickStationRecord, extractPrices } = require("../lib/carburant");

// v9 : chaque carburant porte SA date (`sp95Maj*`, `gazoleMaj*`), et `majISO`
// vaut désormais le PLUS ANCIEN des relevés affichés. La clé change avec la
// forme du payload, sinon l'app recevrait pendant une heure des relevés à
// l'ancien format — donc un bandeau daté au hasard des deux carburants.
const CARBURANT_REDIS_KEY = 'mat:carburant:v9';
const CARBURANT_TTL_S     = 3600; // 1 heure

async function fetchStationPrices(station) {
  const cp = station.cp;

  // Tentative 1 : API v2.1 — refine=cp:CP (colon non-encodé, évite 400 ODSQL)
  try {
    const r = await axios.get(
      `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?refine=cp:${cp}&limit=20`,
      { timeout: 8000 }
    );
    const records = r.data.results || [];
    if (records.length) {
      const rec = pickStationRecord(records, station);
      dlog(`[carburant] v2.1 ${cp}/${station.key}: ${records.length} recs, retenu=${rec ? (rec.id || 'sans id') : 'AUCUN'}`);
      if (rec) return extractPrices(rec);
    } else { dlog(`[carburant] v2.1 ${cp}/${station.key}: 0 records`); }
  } catch (err) { console.error(`[carburant] v2.1 ${cp}/${station.key}:`, err.message); }

  // Tentative 2 : API v1 (syntaxe refine.cp différente)
  try {
    const r = await axios.get(
      `https://data.economie.gouv.fr/api/records/1.0/search/?dataset=prix-des-carburants-en-france-flux-instantane-v2&rows=20&refine.cp=${cp}`,
      { timeout: 8000 }
    );
    const records = (r.data.records || []).map(rec => rec.fields || rec);
    if (records.length) {
      const rec = pickStationRecord(records, station);
      dlog(`[carburant] v1 ${cp}/${station.key}: ${records.length} recs, retenu=${rec ? (rec.id || 'sans id') : 'AUCUN'}`);
      if (rec) return extractPrices(rec);
    } else { dlog(`[carburant] v1 ${cp}/${station.key}: 0 records`); }
  } catch (err) { console.error(`[carburant] v1 ${cp}/${station.key}:`, err.message); }
  return null;
}

// Miroir mémoire du cache Redis : l'app appelle `/carburant` à CHAQUE
// ouverture (js/mat-boot.js), et le cache navigateur ne vit que le temps de la
// session. Sans ce miroir, c'était une commande Redis par visite pour servir
// une donnée qui ne change qu'une fois par heure. Même motif que les autres
// lectures publiques (info-banner, horaires, mascotte). TTL mémoire court : le
// TTL qui fait autorité reste celui de Redis, partagé entre redémarrages.
const CARBURANT_MEM_KEY = 'mem:' + CARBURANT_REDIS_KEY;
const CARBURANT_MEM_TTL = 60 * 1000;

router.get('/carburant', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const memo = memGet(CARBURANT_MEM_KEY);
    if (memo && memo._ts && Date.now() - memo._ts < CARBURANT_TTL_S * 1000) return res.json(memo);

    const cached = await redisGet(CARBURANT_REDIS_KEY);
    if (cached && cached._ts && Date.now() - cached._ts < CARBURANT_TTL_S * 1000) {
      memSet(CARBURANT_MEM_KEY, cached, CARBURANT_MEM_TTL);
      return res.json(cached);
    }

    const data = { _ts: Date.now() };
    await Promise.all(CARBURANT_STATIONS.map(async s => {
      try { data[s.key] = { label: s.label, ...(await fetchStationPrices(s)) }; }
      catch (_) { data[s.key] = { label: s.label, sp95: null, gazole: null, maj: null }; }
    }));
    await redisSetex(CARBURANT_REDIS_KEY, CARBURANT_TTL_S, data);
    memSet(CARBURANT_MEM_KEY, data, CARBURANT_MEM_TTL);
    res.json(data);
  } catch(e) {
    console.error('❌ /carburant:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
