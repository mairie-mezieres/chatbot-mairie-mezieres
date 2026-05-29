/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 *
 * lib/text.js — Helpers de traitement de texte (purs, sans état).
 */

// ─── Nettoyage markdown pour affichage mobile ─────────────────
function cleanMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")   // gras
    .replace(/\*(.*?)\*/g, "$1")       // italique
    .replace(/#{1,6}\s/g, "")          // titres
    .replace(/`{1,3}(.*?)`{1,3}/g, "$1") // code
    .replace(/^\s*[-•]\s/gm, "• ")    // listes
    .replace(/\n{3,}/g, "\n\n") // sauts multiples
    .trim();
}

module.exports = { cleanMarkdown };
