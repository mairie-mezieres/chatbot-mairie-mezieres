// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { readEntreprises, writeEntreprises } = require("../lib/store");
const { uploadEntrepriseLogoToCloudinary, CLOUDINARY_ENABLED } = require("../lib/cloudinary");
const { adminAuth } = require("../lib/middleware");

// ── Annuaire entreprises ─────────────────────────────────────
router.get("/entreprises", async (req, res) => {
  const list = await readEntreprises();
  res.json({ entreprises: list });
});

router.get("/admin/entreprises", adminAuth, async (req, res) => {
  res.json({ entreprises: await readEntreprises() });
});

router.post("/admin/entreprises", adminAuth, async (req, res) => {
  const { nom, activite, description, siteWeb, telephone, email, gerant, logo, logoBase64 } = req.body || {};
  if (!nom) return res.status(400).json({ error: "nom requis" });
  let logoUrl = logo ? String(logo).substring(0, 500) : "";
  if (logoBase64) {
    try {
      const r = await uploadEntrepriseLogoToCloudinary(logoBase64);
      logoUrl = r.secure_url;
    } catch (e) { return res.status(502).json({ error: "Logo Cloudinary: " + e.message }); }
  }
  const list = await readEntreprises();
  list.push({
    id: Date.now(),
    nom:         String(nom).substring(0, 200),
    activite:    activite    ? String(activite).substring(0, 200)    : "",
    description: description ? String(description).substring(0, 1000) : "",
    siteWeb:     siteWeb     ? String(siteWeb).substring(0, 500)     : "",
    telephone:   telephone   ? String(telephone).substring(0, 50)    : "",
    email:       email       ? String(email).substring(0, 200)       : "",
    gerant:      gerant      ? String(gerant).substring(0, 200)      : "",
    logo:        logoUrl,
    addedAt:     new Date().toISOString()
  });
  await writeEntreprises(list);
  res.json({ ok: true, entreprises: list });
});

router.put("/admin/entreprises/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = await readEntreprises();
  const idx = list.findIndex(e => e.id === id);
  if (idx < 0) return res.status(404).json({ error: "Entreprise non trouvée" });
  const { nom, activite, description, siteWeb, telephone, email, gerant, logo, logoBase64 } = req.body || {};
  function _norm(v, max) { return v == null ? '' : String(v).substring(0, max); }
  if (nom         !== undefined) list[idx].nom         = _norm(nom, 200);
  if (activite    !== undefined) list[idx].activite    = _norm(activite, 200);
  if (description !== undefined) list[idx].description = _norm(description, 1000);
  if (siteWeb     !== undefined) list[idx].siteWeb     = _norm(siteWeb, 500);
  if (telephone   !== undefined) list[idx].telephone   = _norm(telephone, 50);
  if (email       !== undefined) list[idx].email       = _norm(email, 200);
  if (gerant      !== undefined) list[idx].gerant      = _norm(gerant, 200);
  if (logoBase64) {
    try {
      const r = await uploadEntrepriseLogoToCloudinary(logoBase64);
      list[idx].logo = r.secure_url;
    } catch (e) { return res.status(502).json({ error: "Logo Cloudinary: " + e.message }); }
  } else if (logo !== undefined) {
    list[idx].logo = _norm(logo, 500);
  }
  await writeEntreprises(list);
  res.json({ ok: true, entreprises: list });
});

router.delete("/admin/entreprises/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = (await readEntreprises()).filter(e => e.id !== id);
  await writeEntreprises(list);
  res.json({ ok: true, entreprises: list });
});

// Migre les logos fbcdn.net vers Cloudinary (appelé manuellement depuis l'admin)
router.post("/admin/entreprises/fix-logos", adminAuth, async (req, res) => {
  const list = await readEntreprises();
  let fixed = 0, skipped = 0;

  for (const e of list) {
    if (!e.logo || !e.logo.includes('fbcdn.net')) continue;

    // Photo de profil (t39.30808-1) : extraire le pageId → URL Graph API permanente
    // Format : /{random}_{pageId}_{photoId}_n.jpg
    const profileMatch = e.logo.match(/\/t39\.30808-1\/\d+_(\d+)_\d+_n\.jpg/);
    if (profileMatch) {
      e.logo = `https://graph.facebook.com/${profileMatch[1]}/picture?type=large`;
      fixed++;
      continue;
    }

    // Photo de post (t39.30808-6) : tenter un fetch côté serveur → Cloudinary
    if (!CLOUDINARY_ENABLED) { skipped++; continue; }
    try {
      const resp = await axios.get(e.logo, {
        responseType: 'arraybuffer', timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.facebook.com/'
        }
      });
      const ct = resp.headers['content-type'] || 'image/jpeg';
      const base64 = `data:${ct};base64,${Buffer.from(resp.data).toString('base64')}`;
      const result = await uploadEntrepriseLogoToCloudinary(base64);
      e.logo = result.secure_url;
      fixed++;
    } catch (err) {
      console.warn(`[fix-logos] skip ${e.nom}:`, err.message);
      skipped++;
    }
  }

  if (fixed > 0) await writeEntreprises(list);
  res.json({
    ok: true, fixed, skipped,
    errors: skipped > 0 ? `${skipped} logo(s) non réparable(s) automatiquement — modifiez-les manuellement via le formulaire (bouton ✏️ Modifier).` : undefined
  });
});

module.exports = router;
