// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const { ADMIN_PASSWORD } = require("../config");

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Admin désactivé (ADMIN_PASSWORD manquant)" });
  }
  const token = req.headers["x-admin-token"];
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// Debug logger — activer avec MAT_DEBUG=1 dans les variables d'environnement.
// Les console.warn/error restent intacts ; seuls les logs de trace sont cachés.
const MAT_DEBUG = process.env.MAT_DEBUG === '1';
function dlog(...args) { if (MAT_DEBUG) console.log(...args); }

module.exports = { adminAuth, dlog };
