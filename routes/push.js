// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const webpush = require("../lib/webpush");
const { readSubs, writeSubs, readDechetsSubs, writeDechetsSubs, readMeteoSubs, writeMeteoSubs, purgeEndpointsEverywhere } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de tentatives d'abonnement." }
});

// ── Abonnement push ───────────────────────────────────────────
router.post("/push/subscribe", subscribeLimiter, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error:"Subscription invalide" });

  const subs = await readSubs();
  const exists = subs.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    await writeSubs(subs);
    console.log(`📱 Nouvel abonné push (total: ${subs.length})`);
  }

  res.json({ success:true, total:subs.length });
});

router.post("/push/status", subscribeLimiter, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Endpoint requis" });
  const subs = await readSubs();
  const found = subs.some(s => s.endpoint === endpoint);
  res.json({ found });
});

router.post("/push/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error:"Endpoint requis" });

  const subs = (await readSubs()).filter(s => s.endpoint !== endpoint);
  await writeSubs(subs);
  res.json({ success: true });
});

router.post("/push/test", subscribeLimiter, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: "Endpoint requis" });

  const subs = await readSubs();
  const sub  = subs.find(s => s.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: "Abonnement non trouvé sur le serveur — réactivez les notifications" });

  const payload = JSON.stringify({
    title: '🔔 Test notification MAT',
    body:  'Votre appareil reçoit bien les notifications !',
    icon:  './icon-192.png',
    badge: './icon-badge.png',
    tag:   'mat-test',
    renotify: true,
    data:  { url: './#notifs', open: 'notifs' }
  });
  try {
    await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 3600 });
    console.log(`🧪 Push test → ${endpoint.slice(-20)}`);
    res.json({ ok: true });
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await writeSubs(subs.filter(s => s.endpoint !== endpoint));
      purgeEndpointsEverywhere([endpoint]).catch(() => {});
      return res.status(410).json({ error: "Abonnement expiré — réactivez les notifications" });
    }
    res.status(500).json({ error: "Échec d'envoi: " + (e.message || 'inconnue') });
  }
});

// ── Rappels déchets ───────────────────────────────────────────
router.post('/push/subscribe/dechets', subscribeLimiter, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Subscription invalide' });
  const subs = await readDechetsSubs();
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    await writeDechetsSubs(subs);
    console.log(`♻️ Nouvel abonné rappels déchets (total: ${subs.length})`);
  }
  res.json({ success: true, total: subs.length });
});

router.post('/push/unsubscribe/dechets', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Endpoint requis' });
  const subs = (await readDechetsSubs()).filter(s => s.endpoint !== endpoint);
  await writeDechetsSubs(subs);
  res.json({ success: true });
});

// ── Alertes météo push ────────────────────────────────────────
router.post('/push/subscribe/meteo', subscribeLimiter, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Subscription invalide' });
  const minLevel = Number(sub.minLevel) || 2;
  const subs = await readMeteoSubs();
  const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
  if (idx >= 0) subs[idx] = { ...subs[idx], ...sub, minLevel };
  else subs.push({ ...sub, minLevel });
  await writeMeteoSubs(subs);
  // Logger uniquement les nouvelles souscriptions, pas les re-sync. Avant,
  // chaque redéploiement Render générait un essaim de logs identiques quand
  // toutes les PWA installées se re-synchronisaient au boot.
  if (idx < 0) console.log(`🌦️ Nouvel abonné météo push (level≥${minLevel}, total: ${subs.length})`);
  res.json({ success: true, total: subs.length });
});

router.post('/push/unsubscribe/meteo', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Endpoint requis' });
  await writeMeteoSubs((await readMeteoSubs()).filter(s => s.endpoint !== endpoint));
  res.json({ success: true });
});

// Migration one-shot : peuple mat:subs:meteo depuis mat:subs si clé absente
(async () => {
  try {
    const existing = await redisGet('mat:subs:meteo');
    if (!existing) {
      const global = (await redisGet('mat:subs')) || [];
      await redisSet('mat:subs:meteo', global.map(s => ({ ...s, minLevel: 2 })));
      console.log(`📦 Migration mat:subs:meteo → ${global.length} abonnés`);
    }
  } catch(e) { console.warn('Migration meteo subs:', e.message); }
})();

module.exports = router;
