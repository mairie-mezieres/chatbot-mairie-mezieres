// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
//
// lib/partager.js — Profils de communes du kit de réplication « Partager ».
//
// Les essais du porteur de projet (« ville test », « Cancale »…) passent par le
// même formulaire que les vraies communes intéressées : sans filtre, ils
// gonflent la liste `mat:partager:profils`, occupent des places sur les 500
// gardées, et surtout arrivent chaque matin dans le mail de stats comme de
// véritables prospects. On les écarte donc À L'ÉCRITURE **et** À LA LECTURE :
// à l'écriture pour ne plus en accumuler, à la lecture pour que ceux déjà
// stockés disparaissent des restitutions sans avoir à toucher Redis.
//
// ⚠️ Ce filtre ne concerne QUE les profils nominatifs. Les compteurs
// `partager_visite` / `partager_prompt` (route /stats/track) ne portent aucun
// nom de commune : ils ne peuvent pas être filtrés ici, et se purgent par date
// depuis l'onglet 🗑️ Purge.

// Communes de test connues, écartées par défaut. Comparaison sur la forme
// normalisée (minuscules, sans accents, ponctuation → espace).
const DEFAULT_IGNORE = ["ville test", "cancale"];

// Un profil dont le nom contient l'un de ces MOTS (mot entier, pas sous-chaîne :
// « Testelin » ou « Demouville » resteraient de vraies communes) est un essai.
const IGNORE_WORDS = ["test", "tests", "essai", "essais", "demo"];

// Minuscules, sans accents, ponctuation réduite à une espace. Même esprit que
// `normalizeQuestion` de lib/mel.js : on compare des formes, pas des saisies.
function normalizeCommune(val) {
  return String(val === null || val === undefined ? "" : val)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Liste effective : les communes de test par défaut + celles déclarées dans
// PARTAGER_IGNORE_COMMUNES (séparées par des virgules). Lue à chaque appel pour
// rester testable sans redémarrer le process.
function ignoredCommunes() {
  const extra = String(process.env.PARTAGER_IGNORE_COMMUNES || "")
    .split(",")
    .map(normalizeCommune)
    .filter(Boolean);
  return DEFAULT_IGNORE.concat(extra);
}

// Vrai si ce nom de commune est un essai et ne doit pas être comptabilisé.
function isTestCommune(commune) {
  const n = normalizeCommune(commune);
  if (!n) return false;                       // le vide est rejeté par la route (400)
  if (ignoredCommunes().includes(n)) return true;
  return n.split(" ").some(word => IGNORE_WORDS.includes(word));
}

// Écarte les profils d'essai d'une liste déjà stockée (lecture admin, mail).
function filterRealProfils(profils) {
  if (!Array.isArray(profils)) return [];
  return profils.filter(p => p && !isTestCommune(p.commune));
}

module.exports = { normalizeCommune, isTestCommune, filterRealProfils, DEFAULT_IGNORE, IGNORE_WORDS };
