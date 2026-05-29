// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { redisGet, redisSetex } = require("../lib/redis");
const { dlog } = require("../lib/middleware");

const CARBURANT_REDIS_KEY = 'mat:carburant:v7';
const CARBURANT_TTL_S     = 3600; // 1 heure
const CARBURANT_STATIONS  = [
  { key: 'clery',      label: 'Intermarché Cléry-St-André',  cp: '45370', brand: 'intermarch' },
  { key: 'meung',      label: 'Super U Meung-sur-Loire',     cp: '45130', brand: 'super u' },
  { key: 'olivet',     label: 'E.Leclerc Olivet',            cp: '45160', brand: 'leclerc' },
  { key: 'beaugency',  label: 'E.Leclerc Beaugency',         cp: '45190', brand: 'leclerc' },
  { key: 'saintpryve', label: 'Super U Les Quinze Pierres',  cp: '45750', brand: 'super u' },
];

async function fetchStationPrices(cp, brandKey) {
  const stationName = (x) => [x.ensigne, x.nom, x.Nom, x.adresse].filter(Boolean).join(' ').toLowerCase();
  const extract = (rec) => {
    const sp95   = rec.sp95_prix   ?? rec.e10_prix  ?? null;
    const gazole = rec.gazole_prix ?? null;
    const rawMaj = rec.sp95_maj || rec.e10_maj || rec.gazole_maj || rec.prix_maj || null;
    const maj    = rawMaj ? new Date(rawMaj).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : null;
    return { sp95, gazole, maj };
  };

  // Tentative 1 : API v2.1 — refine=cp:CP (colon non-encodé, évite 400 ODSQL)
  try {
    const r = await axios.get(
      `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?refine=cp:${cp}&limit=20`,
      { timeout: 8000 }
    );
    const records = r.data.results || [];
    if (records.length) {
      const rec = records.find(x => stationName(x).includes(brandKey)) || records[0];
      dlog(`[carburant] v2.1 ${cp}/${brandKey}: ${records.length} recs, sp95=${rec&&rec.sp95_prix}, go=${rec&&rec.gazole_prix}`);
      if (rec) return extract(rec);
    } else { dlog(`[carburant] v2.1 ${cp}/${brandKey}: 0 records`); }
  } catch (err) { console.error(`[carburant] v2.1 ${cp}/${brandKey}:`, err.message); }

  // Tentative 2 : API v1 (syntaxe refine.cp différente)
  try {
    const r = await axios.get(
      `https://data.economie.gouv.fr/api/records/1.0/search/?dataset=prix-des-carburants-en-france-flux-instantane-v2&rows=20&refine.cp=${cp}`,
      { timeout: 8000 }
    );
    const records = (r.data.records || []).map(rec => rec.fields || rec);
    if (records.length) {
      const rec = records.find(x => stationName(x).includes(brandKey)) || records[0];
      dlog(`[carburant] v1 ${cp}/${brandKey}: ${records.length} recs, sp95=${rec&&rec.sp95_prix}, go=${rec&&rec.gazole_prix}`);
      if (rec) return extract(rec);
    } else { dlog(`[carburant] v1 ${cp}/${brandKey}: 0 records`); }
  } catch (err) { console.error(`[carburant] v1 ${cp}/${brandKey}:`, err.message); }
  return null;
}

router.get('/carburant', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const cached = await redisGet(CARBURANT_REDIS_KEY);
    if (cached && cached._ts && Date.now() - cached._ts < CARBURANT_TTL_S * 1000) return res.json(cached);

    const data = { _ts: Date.now() };
    await Promise.all(CARBURANT_STATIONS.map(async s => {
      try { data[s.key] = { label: s.label, ...(await fetchStationPrices(s.cp, s.brand)) }; }
      catch (_) { data[s.key] = { label: s.label, sp95: null, gazole: null, maj: null }; }
    }));
    await redisSetex(CARBURANT_REDIS_KEY, CARBURANT_TTL_S, data);
    res.json(data);
  } catch(e) {
    console.error('❌ /carburant:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
