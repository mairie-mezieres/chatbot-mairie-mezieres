// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Réception de la veille presse (« Ils parlent de MAT »).
 *
 *   POST /cron/veille-presse        en-tête X-Cron-Key: CRON_SECRET
 *   corps : { items: [{ titre, url, source, date, type, resume }] }
 *   Réponse : { ok, recus, ajoutes, enAttente }
 *
 * Appelée chaque jour par `.github/workflows/veille-presse.yml` (dépôt
 * app-mezieres), qui n'envoie QUE des nouveautés (sa mémoire filtre déjà). Les
 * items attendent ici le prochain mail de stats, qui les vide après envoi.
 *
 * ⚠️ 503 si la file n'a pas pu être écrite : le workflow ne committe alors pas
 * sa mémoire, et les mêmes items repartiront le lendemain — rien n'est perdu.
 * La clé passe en EN-TÊTE, pas en `?key=` : une URL finit dans les journaux.
 */

const router = require("express").Router();
const { CRON_SECRET } = require("../config");
const { safeEqual } = require("../lib/middleware");
const { nettoyerItems, ajouterEnAttente } = require("../lib/veille-presse");

router.post("/cron/veille-presse", async (req, res) => {
  const cle = req.headers["x-cron-key"];
  if (!CRON_SECRET || !cle || !safeEqual(cle, CRON_SECRET))
    return res.status(401).json({ error: "Clé cron invalide" });

  const brut = req.body && req.body.items;
  if (!Array.isArray(brut)) return res.status(400).json({ error: "items (tableau) attendu" });

  const items = nettoyerItems(brut);
  try {
    const r = await ajouterEnAttente(items);
    if (!r.ok) return res.status(503).json({ error: "File de veille non enregistrée (Redis indisponible)" });
    console.log(`[veille-presse] reçus=${brut.length} valides=${items.length} ajoutés=${r.ajoutes} en attente=${r.total}`);
    res.json({ ok: true, recus: brut.length, valides: items.length, ajoutes: r.ajoutes, enAttente: r.total });
  } catch (e) {
    console.error("❌ /cron/veille-presse :", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
