// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * lib/stats-store.js — persistance des statistiques d'usage (`mat:stats`).
 *
 * Voir `docs/adr/0017-statistiques-socle-et-tranche-du-jour.md`.
 *
 * L'objet en mémoire garde EXACTEMENT la forme que tout le code connaît
 * (`services`, `parJour`, `uniqueUsers`, `deviceStats`, `iaCategories`) : seule
 * sa persistance change. Il est écrit dans deux clés, séparées par leur
 * **rythme de changement** :
 *
 *   • `mat:stats:courant` — la tranche du jour et du mois en cours, plus les
 *     compteurs cumulés. Quelques dizaines de Ko, réécrite à chaque flush.
 *   • `mat:stats:socle`   — tout l'historique clos. Réécrite seulement quand
 *     elle change vraiment (bascule de jour, purge admin) ou une fois par jour.
 *
 * ⛔ Pourquoi : `mat:stats` était UN SEUL JSON réécrit **intégralement toutes
 * les 5 minutes**, soit 288 fois par jour. À 1 Mo de blob, cela fait ~300 Mo
 * par jour et ~10 Go par mois — l'enveloppe de bande passante gratuite
 * d'Upstash entière, pour une commune de 1 500 habitants. Le quota qui alarme
 * (les commandes) n'y était pour rien : les stats ne coûtent quasiment aucune
 * commande, elles coûtent des octets. Couper les stats détaillées n'y changeait
 * rien non plus — le visiteur unique est enregistré dans tous les cas, donc le
 * blob restait « dirty » à chaque fenêtre de 5 minutes.
 */

const { redisGetResult, redisSet, redisDel } = require("./redis");
const { getParisDateParts } = require("./dates");

const LEGACY_KEY  = "mat:stats";          // ancienne clé monolithique (migration)
const SOCLE_KEY   = "mat:stats:socle";
const COURANT_KEY = "mat:stats:courant";
const IA_KEY      = "mat:ia:stats";

// ── Rétentions, appliquées au chargement ET à chaque flush ───────────────────
// Avant, seuls `deviceStats.daySeen/byDay` étaient élagués (90 jours) :
// `uniqueUsers.byDay` et `parJour` grossissaient indéfiniment, et ne se
// purgeaient qu'à la main depuis l'admin.
const KEEP_DAYS         = 400;   // parJour, uniqueUsers.byDay (comptes)
const KEEP_DAYS_DEVICES = 90;    // deviceStats.byDay, appOpensByDay
const KEEP_MONTHS       = 24;    // tout ce qui est mensuel
const MAX_DEVICES       = 20000; // plafond de la liste de déduplication
const SOCLE_MAX_AGE_MS  = 24 * 60 * 60 * 1000; // réécriture de sûreté

function derniersCles(obj, n) {
  return new Set(Object.keys(obj || {}).sort().slice(-n));
}
function elaguer(obj, n) {
  if (!obj) return;
  const garder = derniersCles(obj, n);
  for (const k of Object.keys(obj)) if (!garder.has(k)) delete obj[k];
}
function sansCle(obj, cle) {
  if (!obj) return {};
  const out = {};
  for (const k of Object.keys(obj)) if (k !== cle) out[k] = obj[k];
  return out;
}

/**
 * Nombre de visiteurs uniques d'une entrée `byDay`/`byMonth`.
 *
 * ⚠️ Une entrée est une **liste d'identifiants** tant que la période est en
 * cours (il faut pouvoir dédupliquer), puis un **nombre** une fois close : la
 * liste des appareils d'un jour passé n'était plus lue que pour son `.length`,
 * et conservait à vie un identifiant par visiteur et par jour.
 */
function nbUniques(v) {
  return Array.isArray(v) ? v.length : (Number(v) || 0);
}

function statsVides() {
  return {
    services: {},
    totalAcces: 0,
    parJour: {},
    uniqueUsers: { total: 0, byDay: {}, byMonth: {}, allDevices: [] },
    deviceStats: { byDay: {}, byMonth: {}, daySeen: {}, appOpensByDay: {}, appOpensByMonth: {} }
  };
}

/**
 * Normalise + élague l'objet en mémoire. Mutant : c'est la forme conservée.
 * `jour`/`mois` = période en cours, seule à garder ses listes d'identifiants.
 */
function normaliser(stats, jour, mois) {
  if (!stats.services)    stats.services = {};
  if (!stats.parJour)     stats.parJour = {};
  if (!stats.uniqueUsers) stats.uniqueUsers = { total: 0, byDay: {}, byMonth: {}, allDevices: [] };

  const u = stats.uniqueUsers;
  if (!u.byDay)   u.byDay = {};
  if (!u.byMonth) u.byMonth = {};
  if (!Array.isArray(u.allDevices)) u.allDevices = [];

  // Périodes closes : la liste d'identifiants devient son compte.
  for (const d of Object.keys(u.byDay))   if (d !== jour && Array.isArray(u.byDay[d]))   u.byDay[d]   = u.byDay[d].length;
  for (const m of Object.keys(u.byMonth)) if (m !== mois && Array.isArray(u.byMonth[m])) u.byMonth[m] = u.byMonth[m].length;

  // `total` ne doit jamais régresser : il était recalculé par
  // `allDevices.length`, or cette liste est désormais plafonnée.
  u.total = Math.max(Number(u.total) || 0, u.allDevices.length);
  if (u.allDevices.length > MAX_DEVICES) u.allDevices.splice(0, u.allDevices.length - MAX_DEVICES);

  elaguer(stats.parJour, KEEP_DAYS);
  elaguer(u.byDay, KEEP_DAYS);
  elaguer(u.byMonth, KEEP_MONTHS);

  if (stats.deviceStats) {
    const ds = stats.deviceStats;
    if (!ds.byDay)            ds.byDay = {};
    if (!ds.byMonth)          ds.byMonth = {};
    if (!ds.daySeen)          ds.daySeen = {};
    if (!ds.appOpensByDay)    ds.appOpensByDay = {};
    if (!ds.appOpensByMonth)  ds.appOpensByMonth = {};

    // `monthSeen` est supprimé : c'était l'union des `daySeen` du mois, donc
    // une fiche d'appareil complète par visiteur et par mois sur 24 mois — la
    // structure la plus lourde du lot, pour une déduplication que
    // `uniqueUsers.byMonth` fait déjà.
    delete ds.monthSeen;

    // `daySeen` ne sert qu'au jour en cours (fiche de repli quand l'appel ne
    // porte pas de `device`). Les 89 autres jours étaient du poids mort.
    for (const d of Object.keys(ds.daySeen)) if (d !== jour) delete ds.daySeen[d];

    elaguer(ds.byDay, KEEP_DAYS_DEVICES);
    elaguer(ds.appOpensByDay, KEEP_DAYS_DEVICES);
    elaguer(ds.byMonth, KEEP_MONTHS);
    elaguer(ds.appOpensByMonth, KEEP_MONTHS);
  }

  if (stats.iaCategories?.parJour) elaguer(stats.iaCategories.parJour, KEEP_DAYS);
  return stats;
}

// ── Découpage socle / courant ────────────────────────────────────────────────

function construireCourant(stats, jour, mois) {
  const u  = stats.uniqueUsers || {};
  const ds = stats.deviceStats || {};
  return {
    jour, mois,
    // Compteurs cumulés : petits, et ils changent à chaque flush.
    services:   stats.services   || {},
    totalAcces: stats.totalAcces || 0,
    total:      Number(u.total)  || 0,
    parJour:    (stats.parJour || {})[jour] || {},
    byDay:      Array.isArray(u.byDay?.[jour])   ? u.byDay[jour]   : [],
    byMonth:    Array.isArray(u.byMonth?.[mois]) ? u.byMonth[mois] : [],
    daySeen:    ds.daySeen?.[jour] || {},
    dsByDay:    ds.byDay?.[jour]   || {},
    dsByMonth:  ds.byMonth?.[mois] || {},
    opensDay:   ds.appOpensByDay?.[jour]   || 0,
    opensMonth: ds.appOpensByMonth?.[mois] || 0,
    iaJour:     stats.iaCategories?.parJour?.[jour] || null
  };
}

function construireSocle(stats, jour, mois) {
  const u  = stats.uniqueUsers || {};
  const ds = stats.deviceStats || {};
  const socle = { ...stats };
  socle.parJour = sansCle(stats.parJour, jour);
  socle.uniqueUsers = {
    total: Number(u.total) || 0,
    byDay: sansCle(u.byDay, jour),
    byMonth: sansCle(u.byMonth, mois),
    allDevices: u.allDevices || []
  };
  socle.deviceStats = {
    byDay: sansCle(ds.byDay, jour),
    byMonth: sansCle(ds.byMonth, mois),
    appOpensByDay: sansCle(ds.appOpensByDay, jour),
    appOpensByMonth: sansCle(ds.appOpensByMonth, mois),
    daySeen: {}   // jamais dans le socle : la fiche du jour vit dans `courant`
  };
  if (stats.iaCategories) {
    socle.iaCategories = { ...stats.iaCategories, parJour: sansCle(stats.iaCategories.parJour, jour) };
  }
  return socle;
}

function fusionner(socle, courant) {
  const stats = socle && typeof socle === "object" ? { ...socle } : statsVides();
  if (!stats.uniqueUsers) stats.uniqueUsers = { total: 0, byDay: {}, byMonth: {}, allDevices: [] };
  if (!stats.deviceStats) stats.deviceStats = { byDay: {}, byMonth: {}, daySeen: {}, appOpensByDay: {}, appOpensByMonth: {} };
  if (!stats.parJour)     stats.parJour = {};
  if (!courant) return stats;

  const { jour, mois } = courant;
  const u = stats.uniqueUsers, ds = stats.deviceStats;

  // Les compteurs de `courant` sont les plus frais : ils gagnent.
  if (courant.services)   stats.services   = courant.services;
  if (typeof courant.totalAcces === "number") stats.totalAcces = courant.totalAcces;
  u.total = Math.max(Number(u.total) || 0, Number(courant.total) || 0);

  if (jour) {
    stats.parJour[jour] = courant.parJour || {};
    u.byDay[jour] = Array.isArray(courant.byDay) ? courant.byDay : [];
    ds.daySeen[jour] = courant.daySeen || {};
    ds.byDay[jour] = courant.dsByDay || {};
    if (courant.opensDay) ds.appOpensByDay[jour] = courant.opensDay;
    if (courant.iaJour) {
      if (!stats.iaCategories) stats.iaCategories = {};
      if (!stats.iaCategories.parJour) stats.iaCategories.parJour = {};
      stats.iaCategories.parJour[jour] = courant.iaJour;
    }
  }
  if (mois) {
    u.byMonth[mois] = Array.isArray(courant.byMonth) ? courant.byMonth : [];
    ds.byMonth[mois] = courant.dsByMonth || {};
    if (courant.opensMonth) ds.appOpensByMonth[mois] = courant.opensMonth;
  }
  return stats;
}

// ── État en mémoire ─────────────────────────────────────────────────────────

let _cache       = null;   // objet stats en mémoire (forme historique)
let _charge      = false;  // le chargement a-t-il RÉUSSI ? (≠ « la clé est vide »)
let _dirty       = false;
let _iaCache     = null;
let _iaCharge    = false;
let _iaDirty     = false;
let _sigCourant  = null;   // dernière charge utile écrite (évite les écritures identiques)
let _sigSocle    = null;
let _socleEcritA = 0;
let _migre       = false;
let _chargeEnCours = null; // évite N chargements parallèles au démarrage
let _prochainEssai = 0;    // Redis KO : on ne retente pas à chaque requête
let _degrade       = false; // le dernier chargement a ÉCHOUÉ (≠ clé absente)

const RETRY_MS = 60 * 1000;

// Signature du socle SANS les compteurs cumulés : ceux-ci bougent à chaque
// flush et feraient réécrire l'historique entier toutes les 5 minutes.
function signatureSocle(socle) {
  const { services, totalAcces, uniqueUsers, ...reste } = socle;
  const u = uniqueUsers || {};
  return JSON.stringify([reste, u.byDay, u.byMonth, u.allDevices]);
}

// Mode dégradé : Redis injoignable. On continue de compter en mémoire (les
// réponses HTTP ne dépendent jamais de Redis) mais SANS persister — et surtout
// sans faire croire que l'historique est vide.
function degrade(message) {
  console.warn(`⚠️ stats : ${message} — flush suspendu jusqu'à une lecture réussie`);
  _prochainEssai = Date.now() + RETRY_MS;
  _degrade = true;
  if (_cache === null) {
    _cache = statsVides();
    // Marque non énumérable (elle ne part donc jamais dans le JSON) : elle
    // permet de reconnaître, plus tard, un objet né d'un Redis injoignable.
    Object.defineProperty(_cache, "__degrade", { value: true, enumerable: false });
  }
  return _cache;
}

async function chargerStats() {
  if (_charge) return _cache;
  if (Date.now() < _prochainEssai) return _cache || statsVides();
  if (_chargeEnCours) return await _chargeEnCours;

  _chargeEnCours = (async () => {
    const [rSocle, rCourant] = await Promise.all([
      redisGetResult(SOCLE_KEY),
      redisGetResult(COURANT_KEY)
    ]);

    // ⛔ On NE démarre PAS sur un objet vide quand la lecture a échoué : sans
    // ce garde, le flush suivant écrase l'historique cinq minutes plus tard.
    if (!rSocle.ok || !rCourant.ok) return degrade("lecture Redis impossible");

    let stats;
    if (rSocle.value === null && rCourant.value === null) {
      // Migration depuis la clé monolithique (une seule fois).
      // Timeout élargi : c'est LA lecture qui peut encore peser plusieurs Mo,
      // et l'expiration au démarrage est exactement ce qui détruisait
      // l'historique (voir ADR-0017). Elle n'a lieu qu'une fois.
      const legacy = await redisGetResult(LEGACY_KEY, { timeout: 20000 });
      if (!legacy.ok) return degrade("ancienne clé mat:stats illisible");
      stats = legacy.value || statsVides();
      _migre = legacy.value !== null;
      if (_migre) console.log("📦 stats : migration de mat:stats vers socle + courant");
    } else {
      stats = fusionner(rSocle.value, rCourant.value);
    }

    const { day: jour, month: mois } = getParisDateParts();
    // ⚠️ Ce qui a été compté pendant un éventuel mode dégradé est abandonné :
    // mieux vaut perdre quelques visites que republier un historique tronqué.
    _cache  = normaliser(stats, jour, mois);
    _charge = true;
    _degrade = false;
    _prochainEssai = 0;
    return _cache;
  })().finally(() => { _chargeEnCours = null; });

  return await _chargeEnCours;
}

async function readStats() {
  if (_charge) return _cache;
  return await chargerStats();
}

function writeStats(d) {
  // Écriture sans lecture préalable (tests, appelant qui construit l'objet) :
  // l'objet fourni FAIT autorité, sinon le premier chargement l'écraserait.
  // ⚠️ Sauf en mode dégradé : là, `_cache` est un objet vide né d'un Redis
  // injoignable, et le marquer « chargé » ferait publier cet objet vide comme
  // s'il était l'historique — précisément ce que l'ADR-0017 interdit.
  // ⚠️ Course à refermer : une requête peut avoir lu l'objet du mode dégradé,
  // puis n'écrire qu'APRÈS le retour de Redis. Sans ce test, cet objet vide
  // remplacerait l'historique tout juste relu — la panne d'origine, en plus
  // étroit. On préfère perdre les quelques visites comptées à l'aveugle.
  if (_charge && d && d.__degrade === true) return;
  if (!_charge && !_degrade) _charge = true;
  _cache = d;
  _dirty = true;
}

async function readIaStats() {
  if (_iaCharge) return _iaCache;
  const r = await redisGetResult(IA_KEY);
  if (!r.ok) return _iaCache || {};
  _iaCache = r.value || {};
  _iaCharge = true;
  return _iaCache;
}

function writeIaStats(d) {
  if (!_iaCharge) _iaCharge = true;   // même règle que writeStats
  _iaCache = d;
  _iaDirty = true;
}

/**
 * Écrit ce qui a changé. Appelée toutes les 5 min et à l'arrêt gracieux.
 * `options.force` : réécrit le socle même inchangé (arrêt gracieux, purge).
 */
async function flushStatsNow(options = {}) {
  const force = options.force === true;

  if (_iaDirty && _iaCache !== null && _iaCharge) {
    if (await redisSet(IA_KEY, _iaCache)) _iaDirty = false;
  }

  // ⛔ Jamais de flush sur un cache qui n'a pas été chargé pour de bon :
  // écrire ici, c'est publier un objet partiel comme s'il était l'historique.
  if (!_charge) {
    if (_dirty) await chargerStats();   // nouvelle tentative de lecture
    if (!_charge) return { skipped: true, reason: "stats-not-loaded" };
  }
  if (!_dirty && !force) return { skipped: true, reason: "clean" };
  if (_cache === null) return { skipped: true, reason: "empty" };

  const { day: jour, month: mois } = getParisDateParts();
  normaliser(_cache, jour, mois);

  const courant = construireCourant(_cache, jour, mois);
  const socle   = construireSocle(_cache, jour, mois);
  const sigCourant = JSON.stringify(courant);
  const sigSocle   = signatureSocle(socle);

  const ecrit = { courant: false, socle: false };
  let complet = true;   // tout ce qui devait être écrit l'a été

  // Le socle d'abord : il porte le jour qui vient de se clore. Si son écriture
  // échoue, `courant` n'est pas écrit non plus et la bascule sera rejouée au
  // prochain flush — on ne perd pas la journée écoulée entre les deux clés.
  const socleAEcrire = force || sigSocle !== _sigSocle || Date.now() - _socleEcritA > SOCLE_MAX_AGE_MS;
  if (socleAEcrire) {
    if (await redisSet(SOCLE_KEY, socle)) {
      _sigSocle = sigSocle;
      _socleEcritA = Date.now();
      ecrit.socle = true;
    } else {
      complet = false;
    }
  }

  if (sigCourant !== _sigCourant) {
    if (complet && await redisSet(COURANT_KEY, courant)) {
      _sigCourant = sigCourant;
      ecrit.courant = true;
    } else {
      complet = false;
    }
  }

  if (complet) _dirty = false;

  // L'ancienne clé n'est supprimée qu'une fois les deux nouvelles écrites.
  if (_migre && ecrit.socle && ecrit.courant) {
    _migre = false;
    redisDel(LEGACY_KEY).catch(() => {});
    console.log("📦 stats : migration terminée, mat:stats supprimée");
  }
  return ecrit;
}

// Introspection pour le diagnostic admin et les tests.
function statsDebug() {
  return {
    charge: _charge,
    dirty: _dirty,
    tailleCourant: _sigCourant ? Buffer.byteLength(_sigCourant) : null,
    tailleSocle: _sigSocle ? Buffer.byteLength(_sigSocle) : null,
    socleEcritA: _socleEcritA ? new Date(_socleEcritA).toISOString() : null
  };
}

// Tests uniquement : remet l'état interne à zéro.
function _resetStatsState() {
  _cache = null; _charge = false; _dirty = false; _degrade = false; _prochainEssai = 0;
  _iaCache = null; _iaCharge = false; _iaDirty = false;
  _sigCourant = null; _sigSocle = null; _socleEcritA = 0; _migre = false;
}

module.exports = {
  readStats, writeStats, readIaStats, writeIaStats, flushStatsNow,
  nbUniques, statsDebug,
  SOCLE_KEY, COURANT_KEY, LEGACY_KEY, MAX_DEVICES,
  KEEP_DAYS, KEEP_DAYS_DEVICES, KEEP_MONTHS,
  _normaliser: normaliser, _fusionner: fusionner,
  _construireSocle: construireSocle, _construireCourant: construireCourant,
  _signatureSocle: signatureSocle, _resetStatsState
};
