// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

// ═══════════════════════════════════════════════════════════════
// VEILLE PRESSE — « Ils parlent de MAT » dans le mail de stats quotidien
//
// La RECHERCHE n'a pas lieu ici : un workflow quotidien du dépôt
// `app-mezieres` (`.github/workflows/veille-presse.yml`) la confie à un agent,
// filtre ses résultats contre la MÉMOIRE versionnée (`veille/presse-vues.json`,
// écrite par du code — ADR-0054 de l'app) et POSTe ici les seules nouveautés.
//
// Ce module ne garde donc qu'une FILE D'ATTENTE : ce qui est arrivé et n'a pas
// encore été envoyé. Le mail la lit, et la vide APRÈS un envoi réussi — un mail
// raté ne perd rien. Ce n'est pas la mémoire anti-répétition : celle-ci vit
// dans le dépôt, versionnée et relisible, pas dans Redis.
//
// ⛔ Toute lecture suivie d'une réécriture passe par `redisGetResult` (ADR-0017) :
// un Redis injoignable lu comme une file vide puis réécrit effacerait des items.
// ═══════════════════════════════════════════════════════════════

const { redisGetResult, redisSet, redisDel } = require("./redis");
const { capStr } = require("./validate");

const CLE = "mat:veille:presse";
const MAX_ITEMS = 30;
const TYPES = new Set(["presse", "site", "reseau", "institution", "autre"]);

/**
 * Forme canonique d'une URL, pour comparer deux adresses du même article :
 * sans fragment, sans paramètres de suivi (utm_*, fbclid…), sans « www. »,
 * sans barre finale. Renvoie "" si ce n'est pas une URL http(s).
 * ⚠️ Même règle que `scripts/veille-presse.js` de l'app : les garder en phase.
 */
function normaliserUrl(url) {
  let u;
  try { u = new URL(String(url || "").trim()); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|igshid$|ref$|ref_src$)/i.test(k)) u.searchParams.delete(k);
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const chemin = u.pathname.replace(/\/+$/, "");
  const qs = u.searchParams.toString();
  return `https://${host}${chemin}${qs ? "?" + qs : ""}`;
}

/** Valide et plafonne les items reçus. Un item sans URL exploitable ou sans titre est écarté. */
function nettoyerItems(brut) {
  if (!Array.isArray(brut)) return [];
  const out = [];
  const vus = new Set();
  for (const it of brut) {
    if (!it || typeof it !== "object") continue;
    const cle = normaliserUrl(capStr(it.url, 500));
    // On garde l'adresse D'ORIGINE (celle qui s'ouvre), mais sous sa forme
    // sérialisée : `URL#href` encode `"` et les espaces, qui casseraient l'attribut href.
    const url = cle ? new URL(capStr(it.url, 500).trim()).href : "";
    const titre = capStr(it.titre, 200).replace(/\s+/g, " ").trim();
    if (!cle || !titre || vus.has(cle)) continue;
    vus.add(cle);
    const type = String(it.type || "").toLowerCase();
    out.push({
      titre,
      url,
      source: capStr(it.source, 80).replace(/\s+/g, " ").trim(),
      // Date de PUBLICATION de la mention, telle qu'annoncée par la source.
      // Format AAAA-MM-JJ ou rien : une date qu'on ne sait pas lire ne s'affiche pas.
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(it.date || "")) ? String(it.date) : "",
      type: TYPES.has(type) ? type : "autre",
      resume: capStr(it.resume, 300).replace(/\s+/g, " ").trim()
    });
  }
  return out;
}

/** Ajoute `nouveaux` à la file sans doublon d'URL, plafonnée aux MAX_ITEMS plus récents. */
function fusionner(enAttente, nouveaux) {
  const base = Array.isArray(enAttente) ? enAttente : [];
  const cles = new Set(base.map(i => normaliserUrl(i.url)));
  const ajout = nouveaux.filter(i => !cles.has(normaliserUrl(i.url)));
  return [...base, ...ajout].slice(-MAX_ITEMS);
}

/** Retire de la file les items envoyés (comparés par URL normalisée). */
function retirer(enAttente, envoyes) {
  const cles = new Set((envoyes || []).map(i => normaliserUrl(i.url)));
  return (Array.isArray(enAttente) ? enAttente : []).filter(i => !cles.has(normaliserUrl(i.url)));
}

/** Lit la file. `ok: false` = Redis injoignable : ne rien réécrire sur cette base. */
async function lireEnAttente() {
  const { ok, value } = await redisGetResult(CLE);
  return { ok, items: ok && value && Array.isArray(value.items) ? value.items : [] };
}

/** Ajoute des items à la file. Renvoie { ok, ajoutes, total } ; ok:false si rien n'a été écrit. */
async function ajouterEnAttente(nouveaux) {
  const lu = await lireEnAttente();
  if (!lu.ok) return { ok: false, ajoutes: 0, total: 0 };
  const items = fusionner(lu.items, nouveaux);
  const avant = new Set(lu.items.map(i => normaliserUrl(i.url)));
  const ajoutes = nouveaux.filter(i => !avant.has(normaliserUrl(i.url))).length;
  if (ajoutes <= 0) return { ok: true, ajoutes: 0, total: items.length };
  const ecrit = await redisSet(CLE, { items, majLe: new Date().toISOString() });
  return { ok: !!ecrit, ajoutes: ecrit ? ajoutes : 0, total: items.length };
}

/** Retire de la file ce que le mail vient d'envoyer. Best-effort : un échec renverra les items demain. */
async function marquerEnvoyes(envoyes) {
  if (!envoyes || !envoyes.length) return;
  const lu = await lireEnAttente();
  if (!lu.ok) return;
  const reste = retirer(lu.items, envoyes);
  if (reste.length === lu.items.length) return;
  if (reste.length === 0) await redisDel(CLE);
  else await redisSet(CLE, { items: reste, majLe: new Date().toISOString() });
}

module.exports = {
  CLE, MAX_ITEMS,
  normaliserUrl, nettoyerItems, fusionner, retirer,
  lireEnAttente, ajouterEnAttente, marquerEnvoyes
};
