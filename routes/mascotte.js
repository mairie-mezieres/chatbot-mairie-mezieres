// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Photo MAT & MEL personnalisable depuis l'admin.
 *   GET  /config/mascotte          → public : { active, url }
 *   POST /admin/mascotte           → admin  : { active, imageBase64? }
 *
 * Permet de changer l'illustration MAT & MEL (saison, occasion…) sans
 * redéploiement. Repli côté app sur l'image par défaut si désactivé.
 */

const router = require("express").Router();
const { memGet, memSet, MEM_TTL_SHORT } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { adminAuth } = require("../lib/middleware");
const { uploadMascotToCloudinary } = require("../lib/cloudinary");

const KEY = "mat:mascotte";

router.get("/config/mascotte", async (req, res) => {
  let d = memGet(KEY);
  if (d === undefined) {
    d = (await redisGet(KEY)) || { active: false, url: "" };
    memSet(KEY, d, MEM_TTL_SHORT);
  }
  // On n'expose que ce dont l'app a besoin (pas le publicId Cloudinary).
  res.json({ active: !!d.active, url: d.active ? (d.url || "") : "" });
});

router.post("/admin/mascotte", adminAuth, async (req, res) => {
  try {
    const { active, imageBase64 } = req.body || {};
    const current = (await redisGet(KEY)) || { active: false, url: "" };

    let url = current.url || "";
    let publicId = current.publicId || null;

    // Nouvelle image fournie → upload Cloudinary.
    if (imageBase64) {
      const up = await uploadMascotToCloudinary(imageBase64);
      url = (up && (up.secure_url || up.url)) || url;
      publicId = (up && up.public_id) || publicId;
    }

    if (active && !url) {
      return res.status(400).json({ error: "Aucune image : téléversez une photo avant d'activer." });
    }

    const data = { active: !!active, url, publicId, id: Date.now().toString() };
    memSet(KEY, data, MEM_TTL_SHORT);
    await redisSet(KEY, data);
    res.json({ ok: true, active: data.active, url: data.url, id: data.id });
  } catch (e) {
    console.error("POST /admin/mascotte:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
