// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readSondages, writeSondages, readSondageResults, writeSondageResults, readAdminSettings } = require("../lib/store");
const { redisDel, redisSismember, redisSadd, _isRedis429 } = require("../lib/redis");
const { adminAuth } = require("../lib/middleware");
const { logAudit } = require("../lib/logger");

function getDeviceId(req) {
  const raw = (req.headers["x-device-id"] || "").toString().trim();
  return /^[\w-]{4,100}$/.test(raw) ? raw : null;
}

router.get("/sondages", async (req, res) => {
  const all = await readSondages();
  const now = Date.now();
  const active = all.filter(s => s.active !== false && (!s.endsAt || new Date(s.endsAt).getTime() > now));
  const result = await Promise.all(active.map(async s => {
    const r = await readSondageResults(s.id);
    return { ...s, totalVotes: r.total || 0 };
  }));
  res.json({ sondages: result });
});
router.get("/sondages/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = (await readSondages()).find(x => x.id === id);
  if (!s) return res.status(404).json({ error: "Sondage non trouvé" });
  res.json({ sondage: s });
});
router.get("/sondages/:id/results", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = (await readSondages()).find(x => x.id === id);
  if (!s) return res.status(404).json({ error: "Sondage non trouvé" });
  const results = await readSondageResults(id);
  res.json({
    total: results.total || 0,
    reponses: results.reponses || [],
    counts: results.counts || {},
    distribution: results.distribution || {},
    average: results.average || null
  });
});
router.post("/sondages/:id/vote", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const all = await readSondages();
  const s = all.find(x => x.id === id);
  // Reject if inactive or past endsAt
  if (!s || s.active === false || (s.endsAt && new Date(s.endsAt).getTime() <= Date.now())) {
    return res.status(400).json({ error: "Sondage non disponible" });
  }

  // Quota Redis dépassé (429) : la déduplication par device ne fonctionne plus
  // (sismember renvoie false) → on refuse le vote pour éviter les doublons et
  // l'inflation de results.total. Comportement cohérent avec les autres réactions.
  if (_isRedis429()) return res.status(503).json({ error: "Réactions désactivées" });

  // Déduplication par device — retourne 409 si déjà participé
  const deviceId = getDeviceId(req);
  if (deviceId) {
    try {
      const votedKey = "mat:voted:sondage:" + id;
      const alreadyVoted = await redisSismember(votedKey, deviceId);
      if (alreadyVoted) return res.status(409).json({ error: "Déjà participé", alreadyVoted: true });
    } catch (e) {
      console.warn("sondage dedup check:", e.message);
    }
  }

  const { reponse } = req.body || {};
  // Validate input before writing
  if (s.type === 'choix_unique') {
    if (!s.options || !s.options.includes(String(reponse))) return res.status(400).json({ error: "Option invalide" });
  } else if (s.type === 'choix_multiple') {
    const opts = Array.isArray(reponse) ? reponse : [reponse];
    if (!opts.length || opts.some(k => !s.options || !s.options.includes(String(k)))) return res.status(400).json({ error: "Option invalide" });
  } else if (s.type === 'notation_etoiles') {
    const n = parseInt(reponse, 10);
    if (!(n >= 1 && n <= 5)) return res.status(400).json({ error: "Note invalide (1-5)" });
  }
  const results = await readSondageResults(id);
  results.total = (results.total || 0) + 1;
  if (s.type === 'texte_libre') {
    if (!results.reponses) results.reponses = [];
    if (reponse && results.reponses.length < 200) results.reponses.push(String(reponse).substring(0, 500));
  } else if (s.type === 'choix_unique') {
    if (!results.counts) results.counts = {};
    const k = String(reponse); results.counts[k] = (results.counts[k] || 0) + 1;
  } else if (s.type === 'choix_multiple') {
    if (!results.counts) results.counts = {};
    (Array.isArray(reponse) ? reponse : [reponse]).forEach(k => { k = String(k); results.counts[k] = (results.counts[k] || 0) + 1; });
  } else if (s.type === 'notation_etoiles') {
    if (!results.distribution) results.distribution = {};
    const n = parseInt(reponse, 10);
    if (n >= 1 && n <= 5) {
      results.distribution[String(n)] = (results.distribution[String(n)] || 0) + 1;
      let sum = 0, cnt = 0;
      for (let i = 1; i <= 5; i++) { const c = results.distribution[String(i)] || 0; sum += i * c; cnt += c; }
      results.average = cnt ? (sum / cnt).toFixed(2) : null;
    }
  }
  await writeSondageResults(id, results);

  // Enregistre le device comme ayant participé
  if (deviceId) {
    try {
      await redisSadd("mat:voted:sondage:" + id, deviceId);
    } catch (e) {
      console.warn("sondage dedup sadd:", e.message);
    }
  }

  res.json({ ok: true, total: results.total, reponses: results.reponses, counts: results.counts, distribution: results.distribution, average: results.average });
});
router.get("/admin/sondages", adminAuth, async (req, res) => {
  res.json({ sondages: await readSondages() });
});
router.post("/admin/sondages", adminAuth, async (req, res) => {
  const { titre, description, type, options, endsAt } = req.body || {};
  if (!titre || !type) return res.status(400).json({ error: "titre et type requis" });
  const VALID = ['texte_libre','choix_unique','choix_multiple','notation_etoiles'];
  if (!VALID.includes(type)) return res.status(400).json({ error: "type invalide" });
  const sondages = await readSondages();
  const s = { id: Date.now(), titre: String(titre).substring(0,200), description: description ? String(description).substring(0,500) : "", type, options: (['choix_unique','choix_multiple'].includes(type) && Array.isArray(options)) ? options.slice(0,10).map(o => String(o).substring(0,200)) : [], active: true, createdAt: new Date().toISOString(), endsAt: endsAt || null };
  sondages.push(s);
  await writeSondages(sondages);
  res.json({ ok: true, sondages });
});
router.patch("/admin/sondages/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sondages = await readSondages();
  const idx = sondages.findIndex(s => s.id === id);
  if (idx < 0) return res.status(404).json({ error: "Sondage non trouvé" });
  const { active, titre, description, endsAt } = req.body || {};
  if (active !== undefined) sondages[idx].active = !!active;
  if (titre !== undefined) sondages[idx].titre = String(titre).substring(0,200);
  if (description !== undefined) sondages[idx].description = String(description).substring(0,500);
  if (endsAt !== undefined) sondages[idx].endsAt = endsAt || null;
  await writeSondages(sondages);
  res.json({ ok: true, sondages });
});
router.delete("/admin/sondages/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sondages = (await readSondages()).filter(s => s.id !== id);
  await writeSondages(sondages);
  await redisDel("mat:sondage:results:" + id);
  logAudit("Suppression sondage", `id=${id}`).catch(() => {});
  res.json({ ok: true, sondages });
});
router.get("/admin/sondages/:id/results", adminAuth, async (req, res) => {
  res.json({ results: await readSondageResults(parseInt(req.params.id,10)) });
});

module.exports = router;
