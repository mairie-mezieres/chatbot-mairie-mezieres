// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readIdeas, writeIdeas, readNews } = require("../lib/store");

router.get("/idees", async (req, res) => {
  const idees = await readIdeas();
  res.json({ idees, count: idees.length });
});

router.post("/idee", async (req, res) => {
  const { id, text, cat, date } = req.body || {};
  if (!text) return res.status(400).json({ error: "text requis" });

  const ideas = await readIdeas();
  if (ideas.find(i => i.id === id)) return res.json({ success:true, duplicate:true });

  ideas.unshift({
    id: id || Date.now(),
    text: text.substring(0,500),
    cat: cat || "💡 Autre",
    votes: 0,
    date: date || new Date().toLocaleDateString("fr-FR")
  });

  if (ideas.length > 200) ideas.splice(200);
  await writeIdeas(ideas);
  console.log(`💡 Idée stockée: "${text.substring(0,50)}"`);
  res.json({ success:true });
});

router.post("/idee/:id/vote", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ideas = await readIdeas();
  const idx = ideas.findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: "Idée non trouvée" });

  ideas[idx].votes = (ideas[idx].votes || 0) + 1;
  await writeIdeas(ideas);
  res.json({ success:true, votes: ideas[idx].votes });
});

// ── Actualités (publications stockées) ───────────────────────
router.get("/actus", async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

module.exports = router;
