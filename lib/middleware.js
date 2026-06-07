// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { ADMIN_PASSWORD, ADMIN_PASSWORD2 } = require("../config");

// Comparaison à temps constant. On hache d'abord en SHA-256 (longueur fixe de
// 32 octets) : timingSafeEqual exige des buffers de même longueur, et hacher
// évite à la fois l'exception et la divulgation de la longueur du secret.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a == null ? "" : a)).digest();
  const hb = crypto.createHash("sha256").update(String(b == null ? "" : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Anti-brute-force sur l'authentification admin : ne compte QUE les requêtes en
// échec (skipSuccessfulRequests) → un admin authentifié n'est jamais bloqué par
// son usage normal ; seul un attaquant qui enchaîne les 401 est throttlé. Comme
// ce limiteur vit dans adminAuth, il couvre TOUTES les routes protégées (pas
// seulement /admin/login) — y compris /setup-webhook, /debug-*, etc.
const _adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes." }
});

function adminAuth(req, res, next) {
  _adminAuthLimiter(req, res, () => {
    if (!ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Admin désactivé (ADMIN_PASSWORD manquant)" });
    }
    const token = req.headers["x-admin-token"];
    const ok = token && (safeEqual(token, ADMIN_PASSWORD) || (ADMIN_PASSWORD2 && safeEqual(token, ADMIN_PASSWORD2)));
    if (!ok) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    next();
  });
}

// Debug logger — activer avec MAT_DEBUG=1 dans les variables d'environnement.
// Les console.warn/error restent intacts ; seuls les logs de trace sont cachés.
const MAT_DEBUG = process.env.MAT_DEBUG === '1';
function dlog(...args) { if (MAT_DEBUG) console.log(...args); }

const melLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de requêtes, réessayez dans une minute." }
});

module.exports = { adminAuth, dlog, melLimiter, safeEqual };
