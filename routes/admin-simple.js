// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { adminAuth } = require("../lib/middleware");
const { readAdminSettings, writeAdminSettings, readMelTreeConfig, writeMelTreeConfig, readIdeas, writeIdeas, readNews, writeNews } = require("../lib/store");
const { redisLRange } = require("../lib/redis");
const { deleteActuImageFromCloudinary } = require("../lib/cloudinary");

// ── Helpers MEL tree (validation/normalisation) ───────────────
function normalizeMelLink(link = {}) {
  const label = String(link.label || "").trim();
  const tel = String(link.tel || "").trim();
  const url = String(link.url || "").trim();
  if (!label || (!tel && !url)) return null;
  return tel ? { label, tel } : { label, url };
}

function normalizeMelQuestion(question = {}, idx = 0) {
  const id = String(question.id || `q${idx + 1}`).trim();
  const label = String(question.label || "").trim();
  const ico = String(question.ico || "💬").trim() || "💬";
  if (!id || !label) return null;

  const out = { id, ico, label };

  const prompt = String(question.prompt || "").trim();
  const topic = String(question.topic || "").trim();
  if (prompt) out.prompt = prompt;
  if (topic) out.topic = topic;

  const rawAnswer = question.directAnswer;
  if (typeof rawAnswer === "string") {
    const txt = rawAnswer.trim();
    if (txt) out.directAnswer = { text: txt };
  } else if (rawAnswer && typeof rawAnswer === "object") {
    const text = String(rawAnswer.text || "").trim();
    const links = Array.isArray(rawAnswer.links)
      ? rawAnswer.links.map(normalizeMelLink).filter(Boolean)
      : [];
    if (text || links.length) {
      out.directAnswer = {};
      if (text) out.directAnswer.text = text;
      if (links.length) out.directAnswer.links = links;
    }
  }

  return out;
}

function normalizeMelCategory(key, category = {}) {
  const cleanKey = String(key || "").trim();
  const label = String(category.label || "").trim();
  const ico = String(category.ico || "💬").trim() || "💬";
  if (!cleanKey || !label) return null;

  const out = {
    label,
    ico,
    needZone: !!category.needZone,
    questions: Array.isArray(category.questions)
      ? category.questions.map(normalizeMelQuestion).filter(Boolean)
      : []
  };

  if (category.openChatDirectly) out.openChatDirectly = true;
  return [cleanKey, out];
}

function normalizeMelTree(tree = {}) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("Structure MEL invalide");
  }

  const out = {};
  for (const [key, value] of Object.entries(tree)) {
    const normalized = normalizeMelCategory(key, value);
    if (normalized) out[normalized[0]] = normalized[1];
  }

  if (!Object.keys(out).length) {
    throw new Error("Aucune catégorie MEL valide");
  }

  return out;
}

// ── Réglages admin ────────────────────────────────────────────
router.get("/admin/settings", adminAuth, async (req, res) => {
  try {
    const settings = await readAdminSettings();
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/admin/settings", adminAuth, async (req, res) => {
  try {
    const current = await readAdminSettings();
    const next = {
      ...current,
      detailedStatsEnabled:  req.body?.detailedStatsEnabled === true,
      melUsageStatsEnabled:  req.body?.melUsageStatsEnabled === true,
      appOpenStatsEnabled:   req.body?.appOpenStatsEnabled === true,
      melQuestionLogEnabled: req.body?.melQuestionLogEnabled === true,
      melEnabled:            req.body?.melEnabled !== false,
      melDisabledMessage:    String(req.body?.melDisabledMessage || '').substring(0, 300)
    };
    await writeAdminSettings(next);
    res.json({ ok: true, settings: next });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Questions MEL (admin lecture) ─────────────────────────────
router.get("/admin/mel-questions", adminAuth, async (req, res) => {
  try {
    const date = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const questions = await redisLRange(`mat:mel:questions:${date}`, 0, -1);
    res.json({ ok: true, date, questions, count: questions.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Arbre MEL ─────────────────────────────────────────────────
router.get("/mel/tree", async (req, res) => {
  try {
    const tree = await readMelTreeConfig();
    res.json({ ok: true, tree: tree || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/admin/mel-tree", adminAuth, async (req, res) => {
  try {
    const tree = await readMelTreeConfig();
    res.json({ ok: true, tree: tree || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/admin/mel-tree", adminAuth, async (req, res) => {
  try {
    const tree = normalizeMelTree((req.body || {}).tree);
    await writeMelTreeConfig(tree);
    res.json({ ok: true, tree, categories: Object.keys(tree).length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Structure MEL invalide" });
  }
});

// ── Idées (admin) ─────────────────────────────────────────────
router.get("/admin/ideas", adminAuth, async (req, res) => {
  const ideas = await readIdeas();
  res.json({ ideas, count: ideas.length });
});

router.delete("/admin/ideas/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ideas = await readIdeas();
  const filtered = ideas.filter(i => i.id !== id);
  if (filtered.length === ideas.length) return res.status(404).json({ error: "Idée non trouvée" });
  await writeIdeas(filtered);
  res.json({ ok: true, deleted: id });
});

router.patch("/admin/ideas/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, adminComment } = req.body || {};
  const validStatuses = [null, "", "studying", "accepted", "rejected"];
  if (status !== undefined && !validStatuses.includes(status)) {
    return res.status(400).json({ error: "Statut invalide" });
  }
  const ideas = await readIdeas();
  const idx = ideas.findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: "Idée non trouvée" });
  if (status !== undefined) ideas[idx].status = status || null;
  if (adminComment !== undefined) ideas[idx].adminComment = (adminComment == null) ? '' : String(adminComment).substring(0, 500);
  await writeIdeas(ideas);
  res.json({ ok: true, idea: ideas[idx] });
});

// ── Actus (admin — liste + suppression) ──────────────────────
router.get("/admin/actus", adminAuth, async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

router.delete("/admin/actus/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const actus = await readNews();
  const actu = actus.find(a => a.id === id);
  if (!actu) return res.status(404).json({ error: "Actu non trouvée" });

  let cloudinaryResult = null;
  if (actu.photoPublicId) {
    try {
      cloudinaryResult = await deleteActuImageFromCloudinary(actu.photoPublicId);
    } catch (e) {
      return res.status(502).json({ error: "Suppression Cloudinary impossible : " + e.message });
    }
  }

  const filtered = actus.filter(a => a.id !== id);
  await writeNews(filtered);
  res.json({ ok: true, deleted: id, cloudinary: cloudinaryResult });
});

module.exports = router;
