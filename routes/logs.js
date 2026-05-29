// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { adminAuth } = require("../lib/middleware");
const { LOG_KEY, LOG_MAX, _logRateMap } = require("../lib/logger");
const { REDIS_URL, REDIS_TOKEN, ADMIN_PASSWORD } = require("../config");

const logsLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  skip: () => false
});
const adminLoginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de tentatives de connexion. Patientez 5 minutes." }
});

// ── Logs d'erreurs PWA ────────────────────────────────────────
router.post("/logs/error", logsLimiter, async (req, res) => {
  res.sendStatus(204);
  try {
    const batch = Array.isArray(req.body) ? req.body : [req.body];
    const now = Date.now();
    for (const entry of batch.slice(0, 10)) {
      if (!entry || !entry.msg) continue;
      const key = (entry.module || '') + ':' + String(entry.msg).slice(0, 60);
      const last = _logRateMap.get(key) || 0;
      if (now - last < 60000) continue;
      _logRateMap.set(key, now);
      const record = {
        ts:     entry.ts || new Date().toISOString(),
        module: String(entry.module || 'MAT').slice(0, 30),
        msg:    String(entry.msg || '').slice(0, 200),
        extra:  entry.extra ? String(entry.extra).slice(0, 100) : undefined
      };
      if (REDIS_URL) {
        await axios.post(`${REDIS_URL}/lpush/${LOG_KEY}`, JSON.stringify(record),
          { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } });
        await axios.post(`${REDIS_URL}/ltrim/${LOG_KEY}/0/${LOG_MAX - 1}`,
          { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      }
    }
  } catch(_) {}
});

router.get("/admin/logs", adminAuth, async (req, res) => {
  try {
    if (!REDIS_URL) return res.json({ logs: [] });
    const r = await axios.get(`${REDIS_URL}/lrange/${LOG_KEY}/0/199`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const raw = r.data?.result || [];
    const logs = raw.map(s => { try { return JSON.parse(s); } catch(_) { return { msg: s }; } });
    res.json({ logs });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/admin/logs", adminAuth, async (req, res) => {
  try {
    if (REDIS_URL) await axios.post(`${REDIS_URL}/del/${LOG_KEY}`, null,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 4000 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Login admin ───────────────────────────────────────────────
router.post("/admin/login", adminLoginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ ok: false, error: "Mot de passe incorrect" });
  }
});

module.exports = router;
