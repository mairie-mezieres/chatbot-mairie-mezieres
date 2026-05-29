// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { memGet, memSet, MEM_TTL_SHORT } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { adminAuth } = require("../lib/middleware");

router.get("/info-banner", async (req, res) => {
  let d = memGet("mat:info_banner");
  if (d === undefined) {
    d = (await redisGet("mat:info_banner")) || { active: false };
    memSet("mat:info_banner", d, MEM_TTL_SHORT);
  }
  res.json(d);
});

// ── Encart info/alerte (admin) ────────────────────────────────
router.post("/admin/info-banner", adminAuth, async (req, res) => {
  const { active, title, text, icon } = req.body || {};
  const id = Date.now().toString();
  const data = {
    active: !!active,
    title: (title || "").substring(0, 100),
    text: (text || "").substring(0, 300),
    icon: icon || "ℹ️",
    id
  };
  memSet("mat:info_banner", data, MEM_TTL_SHORT);
  await redisSet("mat:info_banner", data);
  res.json({ ok: true, id });
});

// ── Migration overlay (public lecture) ─────────────────────────
router.get("/migration-status", async (req, res) => {
  let v = memGet("mat:migration_overlay");
  if (v === undefined) {
    v = (await redisGet("migration:overlay:active")) === true;
    memSet("mat:migration_overlay", v, MEM_TTL_SHORT);
  }
  res.json({ active: !!v });
});

// ── Migration overlay (admin set explicite) ───────────────────
// Cible explicite (pas un toggle aveugle) pour éviter d'inverser un état
// inconnu côté UI si /migration-status a échoué silencieusement.
router.post("/admin/migration", adminAuth, async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "Le champ 'active' (boolean) est requis" });
  }
  await redisSet("migration:overlay:active", active);
  memSet("mat:migration_overlay", active, MEM_TTL_SHORT);
  res.json({ ok: true, active });
});

module.exports = router;
