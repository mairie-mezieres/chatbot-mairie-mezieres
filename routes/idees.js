// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readIdeas, writeIdeas, readNews, readAdminSettings } = require("../lib/store");
const { registerNotifyToken } = require("../lib/push-notify");
const { redisSismember, redisSadd, redisSrem, _isRedis429 } = require("../lib/redis");

function getDeviceId(req) {
  const raw = (req.headers["x-device-id"] || "").toString().trim();
  return /^[\w-]{4,100}$/.test(raw) ? raw : null;
}
async function reactionsAllowed() {
  // Quota Redis dépassé (429) : on coupe les votes pour éviter l'inflation du
  // compteur sans déduplication (cf. reactions.js).
  if (_isRedis429()) return false;
  try { const s = await readAdminSettings(); return s.reactionsEnabled !== false; }
  catch (e) { return true; }
}

router.get("/idees", async (req, res) => {
  const idees = await readIdeas();
  res.json({ idees, count: idees.length });
});

router.post("/idee", async (req, res) => {
  const { id, text, cat, date, notifyToken, sub } = req.body || {};
  if (!text) return res.status(400).json({ error: "text requis" });

  const ideas = await readIdeas();
  if (ideas.find(i => i.id === id)) return res.json({ success:true, duplicate:true });

  const idea = {
    id: id || Date.now(),
    text: text.substring(0,500),
    cat: (cat ? String(cat).substring(0, 100) : null) || "💡 Autre",
    votes: 0,
    date: date || new Date().toLocaleDateString("fr-FR"),
    ...(notifyToken ? { notifyToken } : {})
  };
  ideas.unshift(idea);

  if (ideas.length > 200) ideas.splice(200);
  await writeIdeas(ideas);

  if (notifyToken) {
    registerNotifyToken(notifyToken, "idea", idea.id, sub || null).catch(() => {});
  }

  console.log(`💡 Idée stockée: "${text.substring(0,50)}"`);
  res.json({ success:true });
});

router.post("/idee/:id/vote", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const key = "mat:votes:idee:" + id;

  try {
    const alreadyVoted = await redisSismember(key, deviceId);
    if (alreadyVoted) return res.status(409).json({ error: "Déjà voté", voted: true });

    const ideas = await readIdeas();
    const idx = ideas.findIndex(i => i.id === id);
    if (idx < 0) return res.status(404).json({ error: "Idée non trouvée" });

    await redisSadd(key, deviceId);
    ideas[idx].votes = (ideas[idx].votes || 0) + 1;
    await writeIdeas(ideas);
    res.json({ success: true, votes: ideas[idx].votes, voted: true });
  } catch (e) {
    console.error("POST /idee/:id/vote:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/idee/:id/vote", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const key = "mat:votes:idee:" + id;

  try {
    const wasVoted = await redisSismember(key, deviceId);
    if (!wasVoted) return res.status(409).json({ error: "Pas encore voté", voted: false });

    const ideas = await readIdeas();
    const idx = ideas.findIndex(i => i.id === id);
    if (idx < 0) return res.status(404).json({ error: "Idée non trouvée" });

    await redisSrem(key, deviceId);
    ideas[idx].votes = Math.max(0, (ideas[idx].votes || 1) - 1);
    await writeIdeas(ideas);
    res.json({ success: true, votes: ideas[idx].votes, voted: false });
  } catch (e) {
    console.error("DELETE /idee/:id/vote:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Actualités (publications stockées) ───────────────────────
router.get("/actus", async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

module.exports = router;
