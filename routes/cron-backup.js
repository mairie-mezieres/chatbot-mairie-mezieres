// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Route cron de sauvegarde : réplique la base Upstash vers la base cible.
 * À appeler via cron-job.org ou une GitHub Action :
 *   GET /cron/backup?key=CRON_SECRET
 * Réponse : { ok, copied, byType, durationMs }
 */

const express = require("express");
const router = express.Router();
const { CRON_SECRET } = require("../config");
const { replicate } = require("../scripts/replicate-upstash");

router.get("/cron/backup", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: "Clé cron invalide" });
  try {
    const result = await replicate({ dryRun: req.query.dry === "1" });
    console.log(`[backup] réplication : ${JSON.stringify(result.byType)} | copiées=${result.copied} | ${result.durationMs}ms`);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("❌ /cron/backup :", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
