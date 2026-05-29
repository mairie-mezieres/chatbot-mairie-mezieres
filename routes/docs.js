// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readTempDocs, writeTempDocs, readFeaturedDoc, writeFeaturedDoc } = require("../lib/store");
const { adminAuth } = require("../lib/middleware");

router.get("/docs/temp", async (req, res) => {
  const docs = await readTempDocs();
  res.json({ docs });
});

router.post("/admin/docs/temp", adminAuth, async (req, res) => {
  const { title, description, url } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: "title et url requis" });
  const docs = await readTempDocs();
  docs.push({
    id: Date.now(),
    title: String(title).substring(0, 200),
    description: description ? String(description).substring(0, 300) : "",
    url: String(url).substring(0, 500),
    addedAt: new Date().toISOString()
  });
  await writeTempDocs(docs);
  res.json({ ok: true, docs });
});

router.delete("/admin/docs/temp/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const docs = (await readTempDocs()).filter(d => d.id !== id);
  await writeTempDocs(docs);
  res.json({ ok: true, docs });
});

// ── Documents : dernier document publié ─────────────────
router.get("/docs/featured", async (req, res) => {
  res.json({ doc: await readFeaturedDoc() || null });
});
router.post("/admin/docs/featured", adminAuth, async (req, res) => {
  const { title, url, icon, description } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: "title et url requis" });
  const doc = { title: String(title).substring(0,200), url: String(url).substring(0,500), icon: icon ? String(icon).substring(0,10) : "📄", description: description ? String(description).substring(0,300) : "", publishedAt: new Date().toISOString() };
  await writeFeaturedDoc(doc);
  res.json({ ok: true, doc });
});
router.delete("/admin/docs/featured", adminAuth, async (req, res) => {
  await writeFeaturedDoc(null);
  res.json({ ok: true });
});

module.exports = router;
