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


// ─── Nettoyage HTML → texte brut (extraction de contenu web) ──
function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<nav[\s\S]*?<\/nav>/gi,"")
    .replace(/<footer[\s\S]*?<\/footer>/gi,"")
    .replace(/<header[\s\S]*?<\/header>/gi,"")
    .replace(/<[^>]+>/g," ")
    .replace(/\s{3,}/g,"\
\
")
    .replace(/&[a-z]+;/g," ")
    .trim()
    .substring(0,2500);
}

// ─── Normalisation de question (cache MEL) ───────────────────
function normalizeQuestion(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Hash FNV-1a pour clés de cache ──────────────────────────
function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return String(h >>> 0);
}

module.exports = { cleanMarkdown, cleanHtml, normalizeQuestion, hashKey };
