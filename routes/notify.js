// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { updateNotifyTokenSub } = require("../lib/push-notify");

const registerTokenLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de requêtes, patientez avant de réessayer." }
});

// Association différée : l'utilisateur accepte les notifs push après avoir
// soumis une idée ou un signalement. Le client envoie son token + sa sub.
router.post("/notify/register-token", registerTokenLimiter, async (req, res) => {
  const { token, sub } = req.body || {};
  if (!token || !sub) return res.status(400).json({ error: "token et sub requis" });
  const updated = await updateNotifyTokenSub(token, sub);
  res.json({ ok: true, updated });
});

module.exports = router;
