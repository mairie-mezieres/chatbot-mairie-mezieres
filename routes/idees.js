// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readIdeas, writeIdeas, readNews, readAdminSettings, readIdeaFilters, writeIdeaFilters } = require("../lib/store");
const { registerNotifyToken } = require("../lib/push-notify");
const { redisSismember, redisSadd, redisSrem, _isRedis429 } = require("../lib/redis");
const { adminAuth } = require("../lib/middleware");

function getDeviceId(req) {
  const raw = (req.headers["x-device-id"] || "").toString().trim();
  return /^[\w-]{4,100}$/.test(raw) ? raw : null;
}

// ── Filtres anti-doublon (« sujets déjà proposés ») ──────────
// Normalise un texte pour la comparaison : minuscules, sans accents, espaces
// compactés. Permet à « École » de correspondre à « ecole ».
function _normalizeIdea(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Un filtre bloque l'idée si le texte contient TOUS ses mots-clés (logique ET).
// La mairie crée un filtre par sujet ; pour des synonymes, plusieurs filtres.
function _matchIdeaFilter(text, filters) {
  const norm = _normalizeIdea(text);
  if (!norm) return null;
  for (const f of filters || []) {
    const kws = (Array.isArray(f.keywords) ? f.keywords : [])
      .map(_normalizeIdea).filter(Boolean);
    if (kws.length && kws.every((k) => norm.includes(k))) return f;
  }
  return null;
}

// Valide/normalise la liste de filtres reçue de l'admin.
function _sanitizeIdeaFilters(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const kwSource = Array.isArray(raw.keywords)
      ? raw.keywords
      : String(raw.keywords || "").split(",");
    const keywords = kwSource
      .map((k) => String(k || "").trim().substring(0, 50))
      .filter(Boolean)
      .slice(0, 10);
    if (!keywords.length) continue;
    out.push({
      id: Number(raw.id) || (Date.now() + out.length),
      label: String(raw.label || "").substring(0, 100),
      keywords,
      message: String(raw.message || "").substring(0, 300) ||
        "Une idée sur ce sujet a déjà été proposée. Consultez les idées existantes et votez pour celle qui vous correspond.",
      createdAt: raw.createdAt || new Date().toISOString(),
    });
    if (out.length >= 30) break;
  }
  return out;
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

  // Filtre anti-doublon : la mairie peut déclarer des sujets déjà proposés
  // (ex. climatisation de l'école). Une nouvelle idée correspondante est
  // refusée avec un message explicatif, sans être stockée.
  try {
    const filters = await readIdeaFilters();
    if (filters.length) {
      const hit = _matchIdeaFilter(text, filters);
      if (hit) {
        console.log(`🚫 Idée bloquée (filtre "${hit.label || hit.keywords.join("+")}")`);
        return res.status(409).json({ blocked: true, message: hit.message, label: hit.label || "" });
      }
    }
  } catch (e) {
    // En cas d'erreur de lecture des filtres, on ne bloque jamais la soumission.
    console.warn("⚠️ Lecture filtres idées:", e.message);
  }

  // L'id vient du client : on le contraint à un entier positif sûr. Tout id
  // non numérique (tentative d'injection dans l'onclick du front) retombe sur
  // un timestamp serveur — jamais stocké tel quel.
  const _id = Number(id);
  const ideaId = (Number.isSafeInteger(_id) && _id > 0) ? _id : Date.now();

  const ideas = await readIdeas();
  if (ideas.find(i => i.id === ideaId)) return res.json({ success:true, duplicate:true });

  const idea = {
    id: ideaId,
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

// ── Filtres anti-doublon : administration ────────────────────
// Lecture admin uniquement : la liste des mots-clés bloquants n'est pas
// exposée publiquement (le citoyen ne reçoit qu'un message lors de la soumission).
router.get("/admin/idees/filtres", adminAuth, async (req, res) => {
  const filtres = await readIdeaFilters();
  res.json({ filtres });
});

// Remplace l'ensemble de la liste (validée/normalisée).
router.post("/admin/idees/filtres", adminAuth, async (req, res) => {
  const filtres = _sanitizeIdeaFilters((req.body && req.body.filtres) || []);
  await writeIdeaFilters(filtres);
  res.json({ ok: true, filtres });
});

// ── Actualités (publications stockées) ───────────────────────
router.get("/actus", async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

module.exports = router;
