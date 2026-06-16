// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
// Horaires exceptionnels (mairie & déchetterie) : fermetures (congés, pont…)
// ou horaires de remplacement (canicule…) administrables sans modification du code.
const router = require("express").Router();
const { memGet, memSet, MEM_TTL_SHORT } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { adminAuth } = require("../lib/middleware");

const KEY = "mat:horaires:exceptions";
const SERVICES = ["mairie", "dechetterie"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ENTRIES = 50;

function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}

// Valide et normalise la liste reçue ; purge les exceptions déjà terminées.
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const today = todayISO();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    if (!SERVICES.includes(raw.service)) continue;
    if (!DATE_RE.test(raw.start)) continue;
    const start = raw.start;
    let end = DATE_RE.test(raw.end) ? raw.end : start;
    if (end < start) end = start;
    if (end < today) continue; // exception terminée → écartée
    const type = raw.type === "closed" ? "closed" : "hours";
    const ranges = [];
    if (type === "hours") {
      const src = Array.isArray(raw.ranges) ? raw.ranges.slice(0, 2) : [];
      for (const r of src) {
        if (Array.isArray(r) && TIME_RE.test(r[0]) && TIME_RE.test(r[1]) && r[0] < r[1]) {
          ranges.push([r[0], r[1]]);
        }
      }
      if (!ranges.length) continue; // « horaires » sans plage valide → écartée
    }
    out.push({
      id: Number(raw.id) || (Date.now() + out.length),
      service: raw.service,
      start,
      end,
      type,
      ranges,
      message: String(raw.message || "").substring(0, 200)
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// Lecture publique (consommée par les widgets de la PWA).
router.get("/horaires/exceptions", async (req, res) => {
  let d = memGet(KEY);
  if (d === undefined) {
    d = (await redisGet(KEY)) || [];
    if (!Array.isArray(d)) d = [];
    memSet(KEY, d, MEM_TTL_SHORT);
  }
  res.json({ exceptions: d });
});

// Écriture admin : remplace l'ensemble de la liste (validée + purgée).
router.post("/admin/horaires/exceptions", adminAuth, async (req, res) => {
  const list = sanitize((req.body && req.body.exceptions) || []);
  memSet(KEY, list, MEM_TTL_SHORT);
  await redisSet(KEY, list);
  res.json({ ok: true, exceptions: list });
});

module.exports = router;
