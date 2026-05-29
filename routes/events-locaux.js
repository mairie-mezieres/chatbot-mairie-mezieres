// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();

// ─── Événements locaux — OpenAgenda (3 agendas locaux) ───────────────────────
const OPENAGENDA_KEY  = process.env.OPENAGENDA_API_KEY || '';
const OA_AGENDA_UIDS  = [35710944, 6085217, 13827807]; // Orléans Métr., Val-de-Loire, Sportifs Loiret

router.get('/events-locaux', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!OPENAGENDA_KEY) return res.json({ events: [], nokey: true });
  // La clé publique OpenAgenda requiert un Origin navigateur — on guide le client
  return res.json({ clientSide: true, key: OPENAGENDA_KEY, agendas: OA_AGENDA_UIDS });
});

module.exports = router;
