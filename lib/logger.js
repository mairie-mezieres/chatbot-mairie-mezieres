// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const { REDIS_URL, REDIS_TOKEN } = require("../config");

const LOG_KEY = "mat:error_logs";
const LOG_MAX = 200;
const _logRateMap = new Map();

// Purge automatique des entrées rate-map > 5 min, toutes les heures
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, ts] of _logRateMap) if (ts < cutoff) _logRateMap.delete(k);
}, 60 * 60 * 1000).unref?.();

// Écriture directe côté serveur (sans passer par HTTP)
async function logServerError(module, msg, extra) {
  if (!REDIS_URL) return;
  try {
    const key = module + ':' + String(msg).slice(0, 60);
    const last = _logRateMap.get(key) || 0;
    if (Date.now() - last < 60000) return;
    _logRateMap.set(key, Date.now());
    const record = {
      ts: new Date().toISOString(),
      module: String(module || 'server').slice(0, 30),
      msg: String(msg || '').slice(0, 200),
      extra: extra ? String(extra).slice(0, 100) : undefined
    };
    await axios.post(`${REDIS_URL}/lpush/${LOG_KEY}`, JSON.stringify(record),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } });
    await axios.post(`${REDIS_URL}/ltrim/${LOG_KEY}/0/${LOG_MAX - 1}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  } catch (_) {}
}

// Journal d'audit des actions admin destructrices (suppressions, purges…).
// Même flux que les logs serveur (visible onglet 🪲 Logs) mais SANS la
// limitation de débit : chaque action doit être tracée individuellement.
async function logAudit(action, detail) {
  if (!REDIS_URL) return;
  try {
    const record = {
      ts: new Date().toISOString(),
      module: 'audit',
      msg: String(action || '').slice(0, 200),
      extra: detail ? String(detail).slice(0, 100) : undefined
    };
    await axios.post(`${REDIS_URL}/lpush/${LOG_KEY}`, JSON.stringify(record),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } });
    await axios.post(`${REDIS_URL}/ltrim/${LOG_KEY}/0/${LOG_MAX - 1}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  } catch (_) {}
}

module.exports = { LOG_KEY, LOG_MAX, _logRateMap, logServerError, logAudit };
