// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
//
// Helpers de validation/normalisation des entrées — sans dépendance.
//
// Factorise les motifs déjà répétés dans les routes (plafonnage de chaîne,
// nombre fini, id entier sûr, appartenance à une liste). Objectif : cohérence et
// testabilité, PAS une couche de schéma lourde — la validation métier reste dans
// les routes. Toutes les fonctions sont pures et tolérantes aux entrées absentes.

// Chaîne nettoyée et plafonnée. `val` non-chaîne → String(val). null/undefined → "".
function capStr(val, max) {
  if (val === null || val === undefined) return "";
  let s = String(val);
  if (typeof max === "number" && max >= 0 && s.length > max) s = s.substring(0, max);
  return s;
}

// Nombre fini ou null (jamais NaN). Accepte "12.3" comme 12.3.
function finiteNum(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// Entier strictement positif et sûr, sinon `fallback` (défaut null).
// Sert aux id fournis par le client (anti-injection dans le front).
function safeId(val, fallback = null) {
  const n = Number(val);
  return (Number.isSafeInteger(n) && n > 0) ? n : fallback;
}

// Renvoie `val` (comparé en chaîne) s'il appartient à `allowed`, sinon null.
function inEnum(val, allowed) {
  const s = String(val);
  return (Array.isArray(allowed) && allowed.includes(s)) ? s : null;
}

// Coordonnées GPS valides → { lat, lon }, sinon { lat: null, lon: null }.
function geoPoint(lat, lon) {
  const a = finiteNum(lat), o = finiteNum(lon);
  const ok = a !== null && o !== null && a >= -90 && a <= 90 && o >= -180 && o <= 180;
  return ok ? { lat: a, lon: o } : { lat: null, lon: null };
}

module.exports = { capStr, finiteNum, safeId, inEnum, geoPoint };
