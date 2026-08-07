// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readTempDocs, writeTempDocs, readFeaturedDoc, writeFeaturedDoc,
        readPluiDocs, writePluiDocs } = require("../lib/store");
const { adminAuth } = require("../lib/middleware");
const { capStr, safeId } = require("../lib/validate");
const { CLOUDINARY_ENABLED, uploadPluiDocToCloudinary, deletePluiDocFromCloudinary } = require("../lib/cloudinary");
const { logAudit } = require("../lib/logger");

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

// ── Documents du PLUi-H-D ───────────────────────────────
// Même mécanique que /docs/temp, avec deux différences : une `date` (le tri et le
// badge « Nouveau » de l'app en dépendent) et la possibilité d'envoyer le PDF
// lui-même plutôt qu'une URL. Les gros documents d'urbanisme (diagnostic, PADD
// avec cartes) dépassent la limite de corps de requête : pour ceux-là la mairie
// dépose le fichier ailleurs et colle le lien.

const PLUI_MAX_DOCS = 100;
const PDF_PREFIX = "data:application/pdf;base64,";

router.get("/docs/plui", async (req, res) => {
  const docs = await readPluiDocs();
  res.json({ docs });
});

router.post("/admin/docs/plui", adminAuth, async (req, res) => {
  const { titre, date, url, fileB64 } = req.body || {};

  const t = capStr(titre, 200).trim();
  if (!t) return res.status(400).json({ error: "titre requis" });

  // L'app formate la date elle-même (_frDate) et trie dessus : format strict.
  const d = capStr(date, 10).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return res.status(400).json({ error: "date requise au format AAAA-MM-JJ" });
  }

  let finalUrl = "";
  let publicId = null;

  if (fileB64) {
    if (!String(fileB64).startsWith(PDF_PREFIX)) {
      return res.status(400).json({ error: "Seuls les fichiers PDF sont acceptés" });
    }
    if (!CLOUDINARY_ENABLED) {
      return res.status(503).json({ error: "Stockage des documents non configuré — utilisez un lien" });
    }
    try {
      const up = await uploadPluiDocToCloudinary(fileB64);
      finalUrl = up.secure_url;
      publicId = up.public_id;
    } catch (e) {
      return res.status(502).json({ error: "Envoi du document impossible : " + e.message });
    }
  } else {
    finalUrl = capStr(url, 500).trim();
    if (!/^https:\/\//i.test(finalUrl)) {
      return res.status(400).json({ error: "url (https://…) ou fileB64 requis" });
    }
  }

  const docs = await readPluiDocs();
  docs.push({ id: Date.now(), titre: t, date: d, url: finalUrl, publicId, addedAt: new Date().toISOString() });
  if (docs.length > PLUI_MAX_DOCS) docs.splice(0, docs.length - PLUI_MAX_DOCS);
  await writePluiDocs(docs);
  res.json({ ok: true, docs });
});

router.delete("/admin/docs/plui/:id", adminAuth, async (req, res) => {
  const id = safeId(req.params.id);
  if (id === null) return res.status(400).json({ error: "id invalide" });

  const docs = await readPluiDocs();
  const doc = docs.find(x => x.id === id);
  if (!doc) return res.status(404).json({ error: "Document introuvable" });

  // Le fichier Cloudinary part avec l'entrée : sans ça on accumule des PDF
  // orphanés que plus rien ne référence.
  if (doc.publicId && CLOUDINARY_ENABLED) {
    try { await deletePluiDocFromCloudinary(doc.publicId); }
    catch (e) { return res.status(502).json({ error: "Suppression du fichier impossible : " + e.message }); }
  }

  const rest = docs.filter(x => x.id !== id);
  await writePluiDocs(rest);
  logAudit("Suppression document PLUi", `id=${id} — "${doc.titre.slice(0, 60)}"`).catch(() => {});
  res.json({ ok: true, docs: rest });
});

module.exports = router;
